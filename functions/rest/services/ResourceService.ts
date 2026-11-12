import type { D1Database, KVNamespace } from '@cloudflare/workers-types'
import { resourceDefaults, validateResourceLimits, type ResourceLimits } from '../../../shared/resource-limits'

export { resourceDefaults, validateResourceLimits, type ResourceLimits }

const configCache = new WeakMap<D1Database, { expires: number, value: ResourceLimits }>()
const cleanupAfter = new WeakMap<D1Database, number>()
const statsFull = new WeakMap<D1Database, { day: string, until: number }>()

export async function getResourceLimits(db: D1Database): Promise<ResourceLimits> {
    const cached = configCache.get(db)
    if (cached && cached.expires > Date.now()) return cached.value
    const raw = await db.prepare("SELECT value FROM system_settings WHERE key = 'resource_limits'").first<string>('value')
    if (!raw) throw new Error('请先执行 0012_resource_limits 数据库迁移')
    const value = validateResourceLimits(JSON.parse(raw))
    configCache.set(db, { value, expires: Date.now() + 30_000 })
    return value
}

export async function saveResourceLimits(db: D1Database, input: unknown): Promise<ResourceLimits> {
    const value = validateResourceLimits(input)
    await db.prepare("UPDATE system_settings SET value = ?, updated_at = datetime('now') WHERE key = 'resource_limits'")
        .bind(JSON.stringify(value)).run()
    configCache.delete(db)
    statsFull.delete(db)
    return value
}

export function resourceError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    const reasons: Record<string, string> = {
        RESOURCE_STORAGE: 'R2 总存储额度不足，请删除图片或调整额度',
        RESOURCE_USER_QUOTA: '用户存储配额不足，请删除图片或联系管理员',
        RESOURCE_DAILY_FILES: '今日上传张数额度已用完，在下一个北京时间 08:00 恢复',
        RESOURCE_DAILY_BYTES: '今日上传容量额度不足，在下一个北京时间 08:00 恢复',
        RESOURCE_FILE_SIZE: '单张图片超过当前大小限制',
        RESOURCE_KEY_EXISTS: '图片已存在，请使用其他文件名',
        RESOURCE_USER_MISSING: '无法确认用户配额，请重新登录后重试',
        RESOURCE_RESERVATION_MISMATCH: '上传额度记录不一致，请联系管理员核对'
    }
    for (const [key, reason] of Object.entries(reasons)) if (message.includes(key)) return reason
    if (message.includes('UNIQUE constraint failed: resource_reservations.key')) return '同名图片正在上传或有待核对记录，请更换文件名'
    return message
}

export async function reserveUpload(db: D1Database, key: string, login: string, size: number, storageType: string) {
    // The trigger checks and charges all budgets atomically. Never replace this with SELECT + UPDATE.
    await db.prepare('INSERT INTO resource_reservations(key, user_login, size, storage_type) VALUES (?, ?, ?, ?)')
        .bind(key, login, size, storageType).run()
}

export async function reserveUploads(db: D1Database, items: Array<{ key: string, login: string, size: number, storageType: string }>) {
    if (!items.length) return
    // One statement makes a whole batch's reservation all-or-nothing, including trigger side effects.
    await db.prepare(`INSERT INTO resource_reservations(key, user_login, size, storage_type)
        SELECT json_extract(value, '$.key'), json_extract(value, '$.login'),
        json_extract(value, '$.size'), json_extract(value, '$.storageType') FROM json_each(?)`)
        .bind(JSON.stringify(items)).run()
}

// Only call after confirming that this upload's object was never written or was successfully removed.
export async function releaseUpload(db: D1Database, key: string) {
    await db.prepare('DELETE FROM resource_reservations WHERE key = ?').bind(key).run()
}

export async function cleanupDeletionToken(db: D1Database, kv: KVNamespace, token?: string) {
    if (!token) return
    await db.prepare('INSERT OR IGNORE INTO resource_token_cleanup(token) VALUES (?)').bind(token).run()
    const scope = `kvdelete:${new Date().toISOString().slice(0, 10)}`
    const maximum = `(SELECT json_extract(value, '$.dailyKvDeletes') FROM system_settings WHERE key = 'resource_limits')`
    const allowance = await db.prepare(`INSERT INTO resource_usage(scope, count) SELECT ?, 1 WHERE ${maximum} > 0
        ON CONFLICT(scope) DO UPDATE SET count = count + 1 WHERE count < ${maximum} RETURNING count`)
        .bind(scope).first()
    if (!allowance) return
    try {
        await kv.delete(`del:${token}`)
        await db.prepare('DELETE FROM resource_token_cleanup WHERE token = ?').bind(token).run()
    } catch (e) { console.error('KV cleanup deferred; token remains queued:', e) }
}

export async function drainDeletionTokens(db: D1Database, kv: KVNamespace) {
    const token = await db.prepare('SELECT token FROM resource_token_cleanup ORDER BY created_at LIMIT 1').first<string>('token')
    if (token) await cleanupDeletionToken(db, kv, token)
}

export async function recordImageAccess(db: D1Database, limits: ResourceLimits, details: {
    key: string, referer: string | null, userAgent: string | null, country: string | null, city: string | null
}) {
    if (!limits.statisticsEnabled || Math.random() >= limits.statisticsSampleRate) return
    const day = new Date().toISOString().slice(0, 10)
    const full = statsFull.get(db)
    if (full?.day === day && full.until > Date.now()) return
    const result = await db.prepare(`INSERT INTO image_stats (image_key, referer, user_agent, country, city)
        VALUES (?, ?, ?, ?, ?)`).bind(details.key, clipUtf8(details.referer, 512), clipUtf8(details.userAgent, 256),
            clipUtf8(details.country, 8), clipUtf8(details.city, 64)).run()
    if (result.meta.changes > 0) {
        await db.prepare('UPDATE images SET view_count = view_count + 1 WHERE key = ?').bind(details.key).run()
    } else {
        statsFull.set(db, { day, until: Date.now() + 30_000 })
    }
}

function clipUtf8(value: string | null, maximum: number): string | null {
    if (value === null) return null
    const bytes = new TextEncoder().encode(value)
    if (bytes.length <= maximum) return value
    return new TextDecoder().decode(bytes.subarray(0, maximum)).replace(/\uFFFD$/, '')
}

export async function getResourceUsage(db: D1Database, login?: string) {
    const day = new Date().toISOString().slice(0, 10)
    const scopes = ['r2', `upload:${day}`, `stats:${day}`, `cleanup:${day}`, `user:${login || ''}`, `kvdelete:${day}`]
    const rows = await db.prepare('SELECT scope, bytes, count FROM resource_usage WHERE scope IN (?, ?, ?, ?, ?, ?)')
        .bind(...scopes).all<{ scope: string, bytes: number, count: number }>()
    const usage = Object.fromEntries(rows.results.map(row => [row.scope, { bytes: row.bytes, count: row.count }]))
    const pending = await db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size), 0) AS bytes FROM resource_reservations')
        .first<{ count: number, bytes: number }>()
    return {
        r2: usage.r2 || { bytes: 0, count: 0 },
        uploads: usage[`upload:${day}`] || { bytes: 0, count: 0 },
        statistics: usage[`stats:${day}`] || { bytes: 0, count: 0 },
        cleanup: usage[`cleanup:${day}`] || { bytes: 0, count: 0 },
        kvDeletes: usage[`kvdelete:${day}`] || { bytes: 0, count: 0 },
        user: usage[`user:${login || ''}`] || { bytes: 0, count: 0 },
        pending: pending || { bytes: 0, count: 0 },
        resetsAt: new Date(`${day}T00:00:00.000Z`).getTime() + 86400_000
    }
}

export async function cleanupResourceHistory(db: D1Database, limits: ResourceLimits) {
    const scope = `cleanup:${new Date().toISOString().slice(0, 10)}`
    const remaining = await db.prepare('SELECT count FROM resource_usage WHERE scope = ?').bind(scope).first<number>('count') || 0
    const size = Math.min(limits.cleanupBatchRows, Math.max(0, limits.dailyCleanupRows - remaining))
    if (!size) return { deleted: 0, exhausted: true }
    // Select bounded candidates first so idle periods do not consume the whole cleanup budget.
    const stats = await db.prepare(`SELECT id FROM image_stats WHERE accessed_at < datetime('now', ?)
        ORDER BY accessed_at LIMIT ?`).bind(`-${limits.statisticsRetentionDays} days`, size).all<{ id: number }>()
    const logs = stats.results.length < size ? await db.prepare(`SELECT id FROM audit_logs WHERE created_at < datetime('now', ?)
        ORDER BY created_at LIMIT ?`).bind(`-${limits.auditRetentionDays} days`, size - stats.results.length).all<{ id: number }>() : { results: [] }
    const left = size - stats.results.length - logs.results.length
    const counters = left > 0 ? await db.prepare(`SELECT scope FROM resource_usage WHERE
        (scope LIKE 'upload:%' OR scope LIKE 'stats:%' OR scope LIKE 'cleanup:%' OR scope LIKE 'kvdelete:%')
        AND substr(scope, instr(scope, ':') + 1) < date('now', '-90 days') LIMIT ?`)
        .bind(Math.min(10, left)).all<{ scope: string }>() : { results: [] }
    const planned = stats.results.length + logs.results.length + counters.results.length
    if (!planned) return { deleted: 0, exhausted: false }
    // Reserve before deleting; concurrent callers may over-reserve but never overspend.
    const reservation = await db.prepare(`INSERT INTO resource_usage(scope, count) VALUES (?, ?)
        ON CONFLICT(scope) DO UPDATE SET count = count + excluded.count
        WHERE count + excluded.count <= ? RETURNING count`)
        .bind(scope, planned, limits.dailyCleanupRows).first()
    if (!reservation) return { deleted: 0, exhausted: true }
    const statements = []
    for (const [table, column, values] of [
        ['image_stats', 'id', stats.results.map(row => row.id)],
        ['audit_logs', 'id', logs.results.map(row => row.id)],
        ['resource_usage', 'scope', counters.results.map(row => row.scope)]
    ] as Array<[string, string, Array<number | string>]>) {
        if (values.length) statements.push(db.prepare(`DELETE FROM ${table} WHERE ${column} IN (${values.map(() => '?').join(',')})`).bind(...values))
    }
    const results = await db.batch(statements)
    return { deleted: results.reduce((sum, result) => sum + result.meta.changes, 0), exhausted: false }
}

export function scheduleHistoryCleanup(db: D1Database, limits: ResourceLimits, waitUntil: (promise: Promise<unknown>) => void) {
    if ((cleanupAfter.get(db) || 0) > Date.now()) return
    cleanupAfter.set(db, Date.now() + 600_000)
    waitUntil(cleanupResourceHistory(db, limits).catch(e => console.error('History cleanup failed:', e)))
}
