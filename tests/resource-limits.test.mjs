import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createHash, createHmac } from 'node:crypto'

const bundled = await build({
    stdin: { contents: `export { app } from './functions/rest/[[route]].ts';
        export * from './functions/rest/services/ResourceService.ts';
        export { takeMemoryBudget } from './functions/rest/middleware/resources.ts';
        export * from './shared/upload-batches.ts';`, resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false
})
mkdirSync('.wrangler/tests', { recursive: true })
writeFileSync('.wrangler/tests/resources.mjs', bundled.outputFiles[0].text)
const code = await import(pathToFileURL(resolve('.wrangler/tests/resources.mjs')).href)

class D1 {
    sql = new DatabaseSync(':memory:')
    failInsert = false
    writes = []
    constructor(beforeMigration) {
        this.sql.exec('PRAGMA foreign_keys = ON')
        for (const file of readdirSync('migrations').filter(x => x.endsWith('.sql')).sort()) {
            if (file.startsWith('0012')) beforeMigration?.(this.sql)
            this.sql.exec(readFileSync(`migrations/${file}`, 'utf8'))
        }
    }
    prepare(sql) {
        const db = this
        return {
            values: [], sql,
            bind(...values) { return { ...this, values } },
            execute(mode) {
                if (db.failInsert && sql.includes('INSERT INTO images')) throw new Error('simulated metadata failure')
                const stmt = db.sql.prepare(sql)
                if (mode === 'first') return stmt.get(...this.values) || null
                if (mode === 'all') return { results: stmt.all(...this.values), success: true }
                const result = stmt.run(...this.values)
                db.writes.push({ sql, changes: result.changes })
                return { success: true, meta: { changes: result.changes, last_row_id: result.lastInsertRowid } }
            },
            async first(column) { const row = this.execute('first'); return column ? row?.[column] ?? null : row },
            async all() { return this.execute('all') },
            async run() { return this.execute('run') }
        }
    }
    async batch(statements) {
        this.sql.exec('BEGIN')
        try { const results = statements.map(statement => statement.execute('run')); this.sql.exec('COMMIT'); return results }
        catch (error) { this.sql.exec('ROLLBACK'); throw error }
    }
}

class Bucket {
    objects = new Map()
    failPut = false
    failDelete = false
    async put(key, body, options = {}) {
        const bytes = new Uint8Array(await new Response(body).arrayBuffer())
        const object = { key, size: bytes.length, bytes, httpMetadata: options.httpMetadata, customMetadata: options.customMetadata }
        this.objects.set(key, object)
        if (this.failPut) throw new Error('simulated uncertain put')
        return object
    }
    async head(key) { return this.objects.get(key) || null }
    async get(key) { const object = this.objects.get(key); return object ? { ...object, body: new Blob([object.bytes]).stream() } : null }
    async delete(key) { if (this.failDelete) throw new Error('simulated delete failure'); this.objects.delete(key) }
}

let ip = 0
function fixture(beforeMigration) {
    const db = new D1(beforeMigration)
    db.sql.exec("INSERT OR IGNORE INTO users(github_id, login, role, storage_quota) VALUES(0, 'system', 'admin', 0)")
    const bucket = new Bucket()
    const kv = { items: new Map(), options: new Map(), putCount: 0, deleteCount: 0, failPut: false,
        async put(key, value, options) { if (this.failPut) throw new Error('simulated KV failure'); this.putCount++; this.items.set(key, value); this.options.set(key, options) },
        async get(key) { return this.items.get(key) || null }, async delete(key) { this.deleteCount++; this.items.delete(key) } }
    const env = { DB: db, PICX: bucket, XK: kv, PICX_AUTH_TOKEN: 'test-only-resource-token', ALLOW_TOKEN_LOGIN: 'true', BASE_URL: 'https://images.test' }
    const pending = []
    const ipAddress = `test-${++ip}`
    return {
        db, bucket, kv, env,
        async limits(values) { return code.saveResourceLimits(db, { ...code.resourceDefaults, ...values }) },
        async flush() { while (pending.length) await Promise.allSettled(pending.splice(0)) },
        async request(path, { auth = true, body, method = 'GET', headers = {} } = {}) {
            const request = new Request(`https://images.test/rest${path}`, { method, body,
                headers: { 'cf-connecting-ip': ipAddress, ...(auth ? { Authorization: env.PICX_AUTH_TOKEN } : {}), ...headers } })
            return code.app.fetch(request, env, { waitUntil: p => pending.push(p), passThroughOnException() {} })
        },
        form(sizes = [4], { keepName = false } = {}) {
            const form = new FormData()
            form.append('keepName', String(keepName))
            sizes.forEach((size, index) => form.append('files', new File([new Uint8Array(size)], `image-${index}.png`, { type: 'image/png' })))
            return form
        }
    }
}

async function upload(f, sizes = [4], options = {}) {
    const response = await f.request('/upload', { method: 'POST', body: f.form(sizes, options) })
    const data = await response.json()
    await f.flush()
    return { response, data }
}
const count = (f, table) => f.db.sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
const usage = (f, scope = 'r2') => f.db.sql.prepare('SELECT bytes, count FROM resource_usage WHERE scope = ?').get(scope) || { bytes: 0, count: 0 }

test('migration seeds existing R2 and user usage; excludes HF from R2', async () => {
    const f = fixture(sql => {
        sql.exec("INSERT INTO users(github_id,login,storage_quota) VALUES(1,'alice',100)")
        sql.exec("INSERT INTO images(key,user_login,size,storage_type) VALUES('old.png','alice',7,'R2'),('hf.png','alice',3,'HF')")
    })
    assert.equal(usage(f).bytes, 7)
    assert.equal(usage(f, 'user:alice').bytes, 10)
})

test('concurrent reservations cannot exceed global storage, even for admin', async () => {
    const f = fixture(); await f.limits({ maxR2Bytes: 10 })
    const results = await Promise.allSettled(['a', 'b'].map(key => code.reserveUpload(f.db, key, 'system', 6, 'R2')))
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
    assert.equal(usage(f).bytes, 6)
})

test('whole batch reservation rolls back if a later file exceeds the budget', async () => {
    const f = fixture(); await f.limits({ maxR2Bytes: 10 })
    await assert.rejects(code.reserveUploads(f.db, [6, 6].map((size, index) => ({ key: String(index), login: 'system', size, storageType: 'R2' }))))
    assert.equal(count(f, 'resource_reservations'), 0)
    assert.equal(usage(f).bytes, 0)
    assert.equal(usage(f, `upload:${new Date().toISOString().slice(0, 10)}`).count, 0)
})

test('user quota includes pending uploads and HF; zero quota means no per-user cap', async () => {
    const f = fixture()
    f.db.sql.exec("INSERT INTO users(github_id,login,storage_quota) VALUES(1,'alice',5)")
    await code.reserveUpload(f.db, 'hf', 'alice', 4, 'HF')
    await assert.rejects(code.reserveUpload(f.db, 'r2', 'alice', 2, 'R2'), /RESOURCE_USER_QUOTA/)
    await code.reserveUpload(f.db, 'system', 'system', 10, 'R2')
})

test('registration transfers the reservation, deletion releases storage once, daily budget stays charged', async () => {
    const f = fixture(); const { data } = await upload(f)
    assert.equal(data.code, 200); assert.equal(usage(f).bytes, 4); assert.equal(count(f, 'resource_reservations'), 0)
    const key = data.data[0].key
    f.db.sql.prepare('DELETE FROM images WHERE key = ?').run(key)
    f.db.sql.prepare('DELETE FROM images WHERE key = ?').run(key)
    assert.equal(usage(f).bytes, 0)
    assert.equal(usage(f, `upload:${new Date().toISOString().slice(0, 10)}`).count, 1)
})

test('failed attempts retain daily count and bytes; UTC day keys reset independently', async () => {
    const f = fixture(); await f.limits({ dailyUploadFiles: 1 })
    f.db.sql.exec("INSERT INTO resource_usage(scope, bytes, count) VALUES('upload:2000-01-01',9999,9999)")
    await code.reserveUpload(f.db, 'a', 'system', 4, 'R2'); await code.releaseUpload(f.db, 'a')
    await assert.rejects(code.reserveUpload(f.db, 'b', 'system', 4, 'R2'), /RESOURCE_DAILY_FILES/)
    const g = fixture(); await g.limits({ dailyUploadBytes: 5 })
    await code.reserveUpload(g.db, 'a', 'system', 4, 'R2'); await code.releaseUpload(g.db, 'a')
    await assert.rejects(code.reserveUpload(g.db, 'b', 'system', 2, 'R2'), /RESOURCE_DAILY_BYTES/)
})

test('file, batch count, and aggregate size are rejected before any object write', async () => {
    for (const [limits, sizes] of [[{ maxFileBytes: 3 }, [4]], [{}, [1,1,1,1,1,1]], [{ maxFileBytes: 4, maxBatchBytes: 5 }, [3,3]]]) {
        const f = fixture(); await f.limits(limits)
        assert.equal((await upload(f, sizes)).response.status, 413)
        assert.equal(f.bucket.objects.size, 0); assert.equal(count(f, 'resource_reservations'), 0)
    }
})

test('forged Content-Length cannot bypass the actual body cap', async () => {
    const f = fixture(); await f.limits({ maxFileBytes: 4, maxBatchBytes: 5 })
    const response = await f.request('/upload', { method: 'POST', body: f.form([2 * 1024 * 1024]), headers: { 'content-length': '1' } })
    assert.equal(response.status, 413); assert.equal(f.bucket.objects.size, 0)
})

test('concurrent upload requests share daily budgets', async () => {
    const f = fixture(); await f.limits({ dailyUploadFiles: 1 })
    const results = await Promise.all([upload(f), upload(f)])
    assert.equal(results.filter(r => r.response.status === 200).length, 1)
    assert.equal(count(f, 'images'), 1)
})

test('KV failure removes the object before releasing capacity', async () => {
    const f = fixture(); f.kv.failPut = true
    assert.equal((await upload(f)).response.status, 400)
    assert.equal(usage(f).bytes, 0); assert.equal(f.bucket.objects.size, 0)
})

test('ambiguous failed object write retains capacity when cleanup also fails', async () => {
    const f = fixture(); f.bucket.failPut = true; f.bucket.failDelete = true
    await upload(f)
    assert.equal(usage(f).bytes, 4); assert.equal(count(f, 'resource_reservations'), 1)
})

test('asynchronous metadata failure cannot bypass storage quota', async () => {
    const f = fixture(); f.db.failInsert = true; await f.limits({ maxR2Bytes: 5 })
    const first = await upload(f); assert.equal(first.data.code, 200)
    assert.equal(count(f, 'images'), 0); assert.equal(usage(f).bytes, 4)
    assert.equal((await upload(f)).response.status, 429)
})

test('GET deletion requires credentials, removes its KV token, and retains capacity after storage failure', async () => {
    const f = fixture(); const { data } = await upload(f); const image = data.data[0]
    const anonymous = await f.request(`/del/${image.key}`, { auth: false }); await f.flush()
    assert.equal((await anonymous.json()).code, 401); assert.ok(f.bucket.objects.has(image.key))
    f.bucket.failDelete = true
    await f.request(`/del/${image.key}`); await f.flush()
    assert.equal(usage(f).bytes, 4)
    f.bucket.failDelete = false
    const response = await f.request(`/del/${image.key}`); await f.flush()
    assert.equal(response.status, 200); assert.equal(usage(f).bytes, 0); assert.equal(f.kv.items.size, 0)
})

test('deletion links default on; disabling them skips KV writes and preserves GET deletion', async () => {
    assert.equal(code.resourceDefaults.deletionLinksEnabled, true)
    const f = fixture(); await f.limits({ deletionLinksEnabled: false })
    const { data } = await upload(f)
    assert.equal(f.kv.putCount, 0); assert.equal(data.data[0].delToken, undefined)
    assert.equal((await f.request('/delInfo/anything', { auth: false })).status, 403)
    assert.equal((await f.request(`/del/${data.data[0].key}`)).status, 200)
    await f.flush(); assert.equal(usage(f).bytes, 0)
})

test('access statistics stop atomically at their budget; images still return successfully', async () => {
    const f = fixture(); await f.limits({ statisticsSampleRate: 1, dailyStatisticsRecords: 3 })
    const { data } = await upload(f); const key = data.data[0].key
    const responses = await Promise.all(Array.from({ length: 10 }, () => f.request(`/${key}`, { auth: false })))
    await f.flush()
    assert.ok(responses.every(r => r.status === 200)); assert.equal(count(f, 'image_stats'), 3)
    assert.equal(f.db.sql.prepare('SELECT view_count FROM images WHERE key = ?').get(key).view_count, 3)
    await f.limits({ statisticsEnabled: false, statisticsSampleRate: 1 })
    await f.request(`/${key}`, { auth: false }); await f.flush(); assert.equal(count(f, 'image_stats'), 3)
})

test('rename reserves temporary copy capacity and maintains deletion link mapping', async () => {
    const f = fixture(); const { data } = await upload(f); const image = data.data[0]
    await f.limits({ maxR2Bytes: 7 })
    let response = await f.request('/rename', { method: 'POST', body: JSON.stringify({ oldKey: image.key, newKey: 'new.png' }) })
    assert.equal((await response.json()).code, 500); assert.ok(f.bucket.objects.has(image.key))
    await f.limits({ maxR2Bytes: 8 })
    response = await f.request('/rename', { method: 'POST', body: JSON.stringify({ oldKey: image.key, newKey: 'new.png' }) })
    assert.equal((await response.json()).code, 200); await f.flush()
    assert.equal(usage(f).bytes, 4); assert.equal(count(f, 'resource_reservations'), 0)
    assert.equal(f.kv.items.get(`del:${image.delToken}`), 'new.png')
})

test('history cleanup is bounded by batch and daily budgets, including concurrent calls', async () => {
    const f = fixture(); const limits = await f.limits({ cleanupBatchRows: 3, dailyCleanupRows: 5 })
    for (let i = 0; i < 10; i++) f.db.sql.exec("INSERT INTO audit_logs(action,created_at) VALUES('login','2000-01-01')")
    await Promise.all(Array.from({ length: 4 }, () => code.cleanupResourceHistory(f.db, limits)))
    await code.cleanupResourceHistory(f.db, limits)
    const result = await code.cleanupResourceHistory(f.db, limits)
    assert.equal(count(f, 'audit_logs'), 5); assert.equal(result.exhausted, true)
})

test('API Key timestamps are not rewritten on each request', async () => {
    const f = fixture(); const prefix = `key${ip}`; const secret = 'test-secret'
    const hash = createHash('sha256').update(secret).digest('hex')
    f.db.sql.prepare(`INSERT INTO api_keys(id,user_id,user_login,key_prefix,key_hash,name) SELECT ?,id,login,?,?,'test' FROM users WHERE login='system'`).run(prefix, prefix, hash)
    for (let i = 0; i < 3; i++) {
        await f.request('/list', { auth: false, method: 'POST', body: '{}', headers: { 'X-API-Key': `px_${prefix}.${secret}` } })
        await f.flush()
    }
    assert.equal(f.db.writes.filter(w => w.sql.includes('UPDATE api_keys SET last_used_at') && w.changes > 0).length, 1)
})

test('batch planner preserves order and obeys count and byte bounds', () => {
    const files = [3,3,1,4].map((size, index) => ({ size, index }))
    const batches = code.partitionFiles(files, 2, 5)
    assert.deepEqual(batches.map(batch => batch.map(file => file.index)), [[0],[1,2],[3]])
    assert.throws(() => code.partitionFiles([{ size: 6 }], 2, 5))
})

test('rate limiter uses a fixed window and refuses further requests until reset', () => {
    const key = 'test-fixed-window'
    assert.equal(code.takeMemoryBudget(key, 2, 1000), 0)
    assert.equal(code.takeMemoryBudget(key, 2, 2000), 0)
    assert.ok(code.takeMemoryBudget(key, 2, 3000) > 0)
    assert.equal(code.takeMemoryBudget(key, 2, 61_000), 0)
})

test('config validation rejects invalid and unexpected values', () => {
    for (const change of [{ maxBatchFiles: 6 }, { maxBatchBytes: 0 }, { statisticsSampleRate: -1 },
        { statisticsEnabled: 'true' }, { maxR2Bytes: Infinity }, { surprise: 1 }]) {
        assert.throws(() => code.validateResourceLimits(change))
    }
})

test('KV cleanup has an atomic daily budget and retains its queue for later', async () => {
    const f = fixture(); await f.limits({ dailyKvDeletes: 1 })
    f.kv.items.set('del:a', 'a'); f.kv.items.set('del:b', 'b')
    await Promise.all(['a','b'].map(token => code.cleanupDeletionToken(f.db, f.kv, token)))
    assert.equal(f.kv.deleteCount, 1); assert.equal(count(f, 'resource_token_cleanup'), 1)
    await f.limits({ dailyKvDeletes: 2 })
    await code.drainDeletionTokens(f.db, f.kv)
    assert.equal(f.kv.deleteCount, 2); assert.equal(count(f, 'resource_token_cleanup'), 0)
})

test('queued old deletion tokens cannot delete a new image with the same key', async () => {
    const f = fixture(); await f.limits({ dailyKvDeletes: 0 })
    const first = (await upload(f, [4], { keepName: true })).data.data[0]
    await f.request(`/del/${first.key}`); await f.flush()
    assert.ok(f.kv.items.has(`del:${first.delToken}`))
    const second = (await upload(f, [4], { keepName: true })).data.data[0]
    const response = await f.request(`/delImage/${first.delToken}`, { auth: false, method: 'POST' })
    assert.equal((await response.json()).code, 500); assert.ok(f.bucket.objects.has(second.key))
    assert.equal(usage(f).bytes, 4)
})

test('new deletion token TTL is optional and changing it does not rewrite old tokens', async () => {
    const f = fixture()
    const first = (await upload(f)).data.data[0]
    assert.equal(f.kv.options.get(`del:${first.delToken}`), undefined)
    await f.limits({ deletionTokenTtlDays: 7 })
    const second = (await upload(f)).data.data[0]
    assert.equal(f.kv.options.get(`del:${second.delToken}`).expirationTtl, 7 * 86400)
    assert.equal(f.kv.options.get(`del:${first.delToken}`), undefined)
})

test('public config and authenticated batch DELETE preserve their paths', async () => {
    const f = fixture()
    const config = await f.request('/settings/resource-config', { auth: false })
    assert.equal((await config.json()).data.maxBatchFiles, 5)
    const images = (await upload(f, [1,1])).data.data
    const response = await f.request('', { method: 'DELETE', body: JSON.stringify({ keys: images.map(item => item.key).join(',') }) })
    assert.equal((await response.json()).code, 200); await f.flush(); assert.equal(usage(f).bytes, 0)
    const denied = await f.request('', { method: 'DELETE', body: JSON.stringify({ keys: 'a,b,c,d,e,f' }) })
    assert.equal(denied.status, 413)
    const settings = await f.request('/settings/resources', { auth: false })
    assert.equal((await settings.json()).code, 401)
})

test('statistics truncate long UTF-8 headers before storing them', async () => {
    const f = fixture(); const limits = await f.limits({ statisticsSampleRate: 1 })
    const key = (await upload(f)).data.data[0].key
    await code.recordImageAccess(f.db, limits, { key, referer: '中'.repeat(10000), userAgent: '🙂'.repeat(10000), country: 'US', city: '城'.repeat(10000) })
    const row = f.db.sql.prepare('SELECT * FROM image_stats LIMIT 1').get()
    assert.ok(Buffer.byteLength(row.referer) <= 512); assert.ok(Buffer.byteLength(row.user_agent) <= 256)
    assert.ok(Buffer.byteLength(row.city) <= 64)
})

test('empty history does not consume the cleanup row budget', async () => {
    const f = fixture(); const limits = await f.limits({})
    assert.equal((await code.cleanupResourceHistory(f.db, limits)).deleted, 0)
    assert.equal(usage(f, `cleanup:${new Date().toISOString().slice(0,10)}`).count, 0)
})

test('long image keys are rejected before writing storage', async () => {
    const f = fixture(); const form = f.form([4]); form.set('path', '中'.repeat(200))
    const response = await f.request('/upload', { method: 'POST', body: form })
    assert.equal(response.status, 400); assert.equal(f.bucket.objects.size, 0)
})

function userJwt(f, login) {
    const user = f.db.sql.prepare('SELECT id FROM users WHERE login = ?').get(login)
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ id: user.id, login, name: login, exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url')
    const signature = createHmac('sha256', f.env.PICX_AUTH_TOKEN).update(`${header}.${payload}`).digest('base64url')
    return `${header}.${payload}.${signature}`
}

test('unauthenticated and invalid credentials cannot upload, rename, or delete', async () => {
    const f = fixture(); const image = (await upload(f)).data.data[0]
    for (const headers of [{}, { Authorization: 'invalid-token' }, { 'X-API-Key': 'px_missing.invalid' }]) {
        const cases = [
            ['/upload', 'POST', f.form()],
            ['/rename', 'POST', JSON.stringify({ oldKey: image.key, newKey: 'blocked.png' })],
            [`/del/${image.key}`, 'GET', undefined],
            ['', 'DELETE', JSON.stringify({ keys: image.key })]
        ]
        for (const [path, method, body] of cases) {
            const result = await f.request(path, { method, body, headers, auth: false })
            assert.equal((await result.json()).code, 401)
        }
    }
    await f.flush()
    assert.equal(f.bucket.objects.size, 1); assert.ok(f.bucket.objects.has(image.key))
})

test('JWT owners can use GET deletion but other users cannot modify their resources', async () => {
    const f = fixture()
    f.db.sql.exec("INSERT INTO users(github_id,login,role,storage_quota) VALUES(11,'alice','user',1000),(12,'bob','user',1000)")
    const alice = { Authorization: userJwt(f, 'alice') }, bob = { Authorization: userJwt(f, 'bob') }
    const uploaded = await f.request('/upload', { method: 'POST', body: f.form(), headers: alice })
    const image = (await uploaded.json()).data[0]; await f.flush()
    const shareResponse = await f.request('/share', { method: 'POST', headers: alice, body: JSON.stringify({ imageKey: image.key, imageUrl: image.url }) })
    const share = (await shareResponse.json()).data; await f.flush()
    for (const [path, method, body] of [
        [`/del/${image.key}`, 'GET', undefined],
        ['', 'DELETE', JSON.stringify({ keys: image.key })],
        ['/rename', 'POST', JSON.stringify({ oldKey: image.key, newKey: 'blocked.png' })],
        ['/share', 'POST', JSON.stringify({ imageKey: image.key, imageUrl: image.url })],
        [`/share/${share.id}`, 'DELETE', undefined]
    ]) {
        const response = await f.request(path, { method, body, headers: bob })
        assert.equal(response.status, 403)
    }
    await f.flush(); assert.ok(f.bucket.objects.has(image.key))
    assert.ok(f.db.sql.prepare('SELECT id FROM shares WHERE id = ?').get(share.id))
    const deleted = await f.request(`/del/${image.key}`, { headers: alice }); assert.equal((await deleted.json()).code, 200)
    await f.flush(); assert.equal(f.bucket.objects.size, 0)
})

test('cryptographic API keys support upload, GET deletion, root DELETE, expiry, and revocation', async () => {
    const f = fixture()
    const response = await f.request('/api-keys', { method: 'POST', body: JSON.stringify({ name: 'integration' }) })
    const key = (await response.json()).data
    assert.match(key.key, /^px_[a-f0-9]{16}\.[a-f0-9]{64}$/)
    const headers = { 'X-API-Key': key.key }
    const r = await f.request('/upload', { method: 'POST', auth: false, headers, body: f.form([1, 1]) })
    const images = (await r.json()).data; assert.equal(images.length, 2); await f.flush()
    assert.equal((await (await f.request(`/del/${images[0].key}`, { auth: false, headers })).json()).code, 200)
    assert.equal((await (await f.request('', { method: 'DELETE', auth: false, headers, body: JSON.stringify({ keys: images[1].key }) })).json()).code, 200)
    await f.flush(); assert.equal(f.bucket.objects.size, 0)
    f.db.sql.prepare('UPDATE api_keys SET expires_at = ? WHERE id = ?').run('2000-01-01T00:00:00Z', key.id)
    assert.equal((await (await f.request('/del/anything', { auth: false, headers })).json()).code, 401)
    await f.request(`/api-keys/${key.id}`, { method: 'DELETE' })
    assert.equal((await (await f.request('/del/anything', { auth: false, headers })).json()).code, 401)
})

test('a private deletion token remains a supported credential without a login session', async () => {
    const f = fixture(); const image = (await upload(f)).data.data[0]
    const info = await f.request(`/delInfo/${image.delToken}`, { auth: false })
    assert.equal((await info.json()).code, 200)
    const deleted = await f.request(`/delImage/${image.delToken}`, { method: 'POST', auth: false })
    assert.equal((await deleted.json()).code, 200); assert.equal(f.bucket.objects.size, 0)
    const raw = await f.request(`/${image.key}`, { auth: false }); assert.equal(raw.status, 404)
})
