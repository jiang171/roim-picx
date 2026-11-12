
import { Hono } from 'hono'
import { Ok, Fail } from '../type'
import { auth, adminAuth, type AppEnv } from '../middleware/auth'
import { ConfigService, type UploadConfigItem } from '../services/ConfigService'
import { getResourceLimits, saveResourceLimits, getResourceUsage, cleanupResourceHistory, releaseUpload, drainDeletionTokens } from '../services/ResourceService'
import { getProviderByType } from '../storage'

const settingsRoutes = new Hono<AppEnv>()

// Upload clients need these public bounds to split requests without changing the upload API.
settingsRoutes.get('/resource-config', async (c) => {
    const limits = c.get('resourceLimits') || await getResourceLimits(c.env.DB)
    return c.json(Ok({ maxFileBytes: limits.maxFileBytes, maxBatchFiles: limits.maxBatchFiles,
        maxBatchBytes: limits.maxBatchBytes, deletionLinksEnabled: limits.deletionLinksEnabled }))
})

settingsRoutes.get('/resources', auth, adminAuth, async (c) => {
    return c.json(Ok({ limits: await getResourceLimits(c.env.DB), usage: await getResourceUsage(c.env.DB, c.get('user')?.login) }))
})

settingsRoutes.post('/resources', auth, adminAuth, async (c) => {
    try { return c.json(Ok(await saveResourceLimits(c.env.DB, await c.req.json()))) }
    catch (e) { return c.json(Fail((e as Error).message), 400) }
})

settingsRoutes.post('/resources/cleanup', auth, adminAuth, async (c) => {
    await drainDeletionTokens(c.env.DB, c.env.XK)
    return c.json(Ok(await cleanupResourceHistory(c.env.DB, await getResourceLimits(c.env.DB))))
})

settingsRoutes.post('/resources/reconcile', auth, adminAuth, async (c) => {
    // Never automatically expire capacity: a timeout can leave a real, billable object behind.
    const pending = await c.env.DB.prepare(`SELECT key, storage_type FROM resource_reservations
        WHERE created_at < datetime('now', '-1 hour') ORDER BY created_at LIMIT 5`)
        .all<{ key: string, storage_type: 'R2' | 'HF' }>()
    let released = 0
    for (const row of pending.results) {
        if (!await getProviderByType(c, row.storage_type).head(row.key)) {
            await releaseUpload(c.env.DB, row.key)
            released++
        }
    }
    return c.json(Ok({ checked: pending.results.length, released, retained: pending.results.length - released }))
})

/**
 * 获取上传配置
 */
settingsRoutes.get('/upload', auth, adminAuth, async (c) => {
    try {
        const service = new ConfigService(c.env.DB)
        const config = await service.getUploadConfig()
        return c.json(Ok(config))
    } catch (e) {
        console.error('Failed to get upload config:', e)
        return c.json(Fail(`获取上传配置失败: ${(e as Error).message}`))
    }
})

/**
 * 更新上传配置
 */
settingsRoutes.post('/upload', auth, adminAuth, async (c) => {
    try {
        const config = await c.req.json<UploadConfigItem[]>()

        // Simple validation
        if (!Array.isArray(config)) {
            return c.json(Fail('Invalid config format'))
        }

        const service = new ConfigService(c.env.DB)
        const success = await service.updateUploadConfig(config)

        if (success) {
            return c.json(Ok(config))
        } else {
            return c.json(Fail('Failed to update config'))
        }
    } catch (e) {
        console.error('Failed to update upload config:', e)
        return c.json(Fail(`更新上传配置失败: ${(e as Error).message}`))
    }
})

/**
 * 获取 Token 过期时间设置
 */
settingsRoutes.get('/token-expire', auth, adminAuth, async (c) => {
    try {
        const service = new ConfigService(c.env.DB)
        const days = await service.getTokenExpireDays()
        return c.json(Ok({ days }))
    } catch (e) {
        return c.json(Fail(`获取 Token 过期配置失败: ${(e as Error).message}`))
    }
})

/**
 * 更新 Token 过期时间设置
 */
settingsRoutes.post('/token-expire', auth, adminAuth, async (c) => {
    try {
        const { days } = await c.req.json<{ days: number }>()

        if (!days || days <= 0) {
            return c.json(Fail('Invalid days value'))
        }

        const service = new ConfigService(c.env.DB)
        const success = await service.updateTokenExpireDays(days)

        if (success) {
            return c.json(Ok({ days }))
        } else {
            return c.json(Fail('Failed to update config'))
        }
    } catch (e) {
        return c.json(Fail(`更新 Token 过期配置失败: ${(e as Error).message}`))
    }
})

export default settingsRoutes
