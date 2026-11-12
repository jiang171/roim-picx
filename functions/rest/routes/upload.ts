import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { Build, FailCode, type ImgItem, type User } from '../type'
import { getFileName } from '../utils'
import { auth, type AppEnv } from '../middleware/auth'
import { uploadRateLimit } from '../middleware/rateLimit'
import { getProviderByType } from '../storage'
import { ConfigService } from '../services/ConfigService'
import { getResourceLimits, reserveUploads, releaseUpload, resourceError, scheduleHistoryCleanup, cleanupDeletionToken, drainDeletionTokens } from '../services/ResourceService'

const uploadRoutes = new Hono<AppEnv>()

uploadRoutes.post('/upload', uploadRateLimit, auth, async (c, next) => {
    const limits = c.get('resourceLimits') || await getResourceLimits(c.env.DB)
    // Hono trusts Content-Length when present; always measure the actual stream instead.
    const headers = new Headers(c.req.raw.headers)
    headers.delete('content-length')
    c.req.raw = new Request(c.req.raw, { headers })
    return bodyLimit({
        maxSize: limits.maxBatchBytes + 1024 * 1024,
        onError: ctx => ctx.json(FailCode('上传请求过大，请减少文件数量或大小', 413), 413)
    })(c, next)
}, async (c) => {
    const limits = c.get('resourceLimits') || await getResourceLimits(c.env.DB)
    const files = await c.req.formData()
    const images = files.getAll('files')
    if (!images.length || images.some(file => !(file instanceof File))) return c.json(FailCode('请选择有效的图片文件', 400), 400)
    const input = images as File[]
    if (input.length > limits.maxBatchFiles) return c.json(FailCode(`每批最多 ${limits.maxBatchFiles} 张，请分批上传`, 413), 413)
    if (input.some(file => file.size > limits.maxFileBytes)) return c.json(FailCode(`单张图片最大 ${limits.maxFileBytes} 字节`, 413), 413)
    if (input.reduce((sum, file) => sum + file.size, 0) > limits.maxBatchBytes) return c.json(FailCode(`每批图片合计最大 ${limits.maxBatchBytes} 字节`, 413), 413)
    const user = c.get('user') as User | undefined
    if (!user) return c.json(FailCode('无法确认用户配额，请重新登录', 401), 401)
    const customPath = (files.get('path')?.toString() || '').replace(/^\/+/, '').replace(/\/*$/, '')
    const folder = customPath ? `${customPath}/` : ''
    const keepName = files.get('keepName') === 'true'
    const expireAt = files.get('expireAt')?.toString()
    const expires = expireAt ? new Date(Number(expireAt)) : null
    if (expires && !Number.isFinite(expires.getTime())) return c.json(FailCode('无效的图片过期时间', 400), 400)
    const tags = (files.get('tags')?.toString() || '').split(',').map(t => t.trim()).filter(Boolean)
    const requested = files.get('storageType')?.toString()
    const storageType = requested === 'R2' || requested === 'HF' ? requested : (c.env.STORAGE_TYPE || 'R2')
    const storage = getProviderByType(c, storageType)
    const albumId = Number(files.get('albumId')) || null
    const album = albumId ? await c.env.DB.prepare('SELECT id FROM albums WHERE id = ? AND user_id = ?')
        .bind(albumId, user.id).first<{ id: number }>() : null
    const config = await new ConfigService(c.env.DB).getUploadConfig()
    const errors: string[] = []
    const plans: Array<{ key: string, file: File, token: string | null, nsfw: number, nsfwScore: number }> = []
    const nsfw = files.getAll('nsfw')
    const scores = files.getAll('nsfwScore')
    for (let index = 0; index < input.length; index++) {
        const file = input[index]
        if (!config.some(type => type.type === file.type)) { errors.push(`${file.name}: ${file.type} not support.`); continue }
        const safeName = keepName ? file.name.replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]/g, '_') : ''
        const key = folder + (safeName || await getFileName(file.type, Date.now(), c.env.DB))
        if (new TextEncoder().encode(key).length > 512) { errors.push(`${file.name}: 图片路径不能超过 512 UTF-8 字节`); continue }
        if (plans.some(plan => plan.key === key) || (keepName && await storage.head(key))) {
            errors.push(`${file.name}: File already exists`); continue
        }
        const score = Number(scores[index] || scores[0] || 0)
        plans.push({ key, file, token: limits.deletionLinksEnabled ? crypto.randomUUID() : null,
            nsfw: (nsfw[index] || nsfw[0]) === 'true' ? 1 : 0, nsfwScore: Number.isFinite(score) ? score : 0 })
    }
    try {
        await reserveUploads(c.env.DB, plans.map(plan => ({ key: plan.key, login: user.login, size: plan.file.size, storageType })))
    } catch (e) { return c.json(FailCode(resourceError(e), 429), 429) }
    const urls: ImgItem[] = []
    for (const plan of plans) {
        const { file, key, token } = plan
        let tokenWriteAttempted = false
        try {
            const metadata: Record<string, string> = { uploaderId: String(user.id), uploadedBy: user.login }
            if (token) metadata.delToken = token
            if (!keepName && file.name) metadata.originalName = file.name
            if (user.name) metadata.uploaderName = encodeURIComponent(user.name)
            if (expireAt) metadata.expires = expireAt
            const object = await storage.put(key, file.stream(), { contentType: file.type, metadata })
            if (!object || object.size !== file.size) throw new Error('存储返回的图片大小与预留额度不一致')
            if (token) {
                const options = limits.deletionTokenTtlDays > 0 ? { expirationTtl: limits.deletionTokenTtlDays * 86400 } : undefined
                tokenWriteAttempted = true
                await c.env.XK.put(`del:${token}`, key, options)
            }
            // Unregistered uploads retain their reservation, even if asynchronous metadata writes fail.
            c.executionCtx.waitUntil((async () => {
                await c.env.DB.prepare(`INSERT INTO images
                    (key, user_id, user_login, original_name, size, mime_type, folder, expires_at, storage_type, tags, nsfw, nsfw_score, delete_token)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                    .bind(key, null, user.login, file.name || null, file.size, file.type, folder,
                        expires?.toISOString() || null, storageType, tags.length ? JSON.stringify(tags) : null, plan.nsfw, plan.nsfwScore, token).run()
                await c.env.DB.prepare('UPDATE users SET storage_used = storage_used + ?, upload_count = upload_count + 1 WHERE login = ?')
                    .bind(file.size, user.login).run()
                await c.env.DB.prepare(`INSERT INTO audit_logs (user_id, user_login, action, target_key, details) VALUES (?, ?, 'upload', ?, ?)`)
                    .bind(user.id, user.login, key, JSON.stringify({ size: file.size, originalName: file.name, storageType })).run()
                if (album) await c.env.DB.prepare(`INSERT OR IGNORE INTO album_images(album_id, image_key, image_url, added_at) VALUES (?, ?, ?, ?)`)
                    .bind(album.id, key, storage.getPublicUrl(key), Date.now()).run()
            })().catch(e => console.error('Upload metadata failed; unregistered capacity is retained:', key, e)))
            urls.push({ key, size: file.size, url: storage.getPublicUrl(key), filename: file.name,
                delToken: token || undefined, storageType, nsfw: plan.nsfw === 1, nsfwScore: plan.nsfwScore })
        } catch (e) {
            errors.push(`${file.name}: ${resourceError(e)}`)
            try {
                // A failed put can be ambiguous; remove the object before releasing capacity.
                await storage.delete(key)
                await releaseUpload(c.env.DB, key)
            } catch (cleanupError) { console.error('Cleanup uncertain; capacity reservation retained:', key, cleanupError) }
            if (tokenWriteAttempted && token) {
                try { await cleanupDeletionToken(c.env.DB, c.env.XK, token) } catch (e) { console.error('Deletion token cleanup failed:', e) }
            }
        }
    }
    if (album && urls.length) c.executionCtx.waitUntil(c.env.DB.prepare('UPDATE albums SET updated_at = ? WHERE id = ?').bind(Date.now(), album.id).run())
    scheduleHistoryCleanup(c.env.DB, limits, promise => c.executionCtx.waitUntil(promise))
    c.executionCtx.waitUntil(drainDeletionTokens(c.env.DB, c.env.XK).catch(e => console.error('Token cleanup failed:', e)))
    if (!urls.length && errors.length) return c.json(FailCode(errors.join('; '), 400), 400)
    return c.json(Build(urls, errors.join('; ')))
})

export default uploadRoutes
