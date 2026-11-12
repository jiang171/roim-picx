import { Hono } from 'hono'
import { Ok, Fail, Folder } from '../type'
import { auth, type AppEnv } from '../middleware/auth'
import { reserveUpload, releaseUpload, resourceError } from '../services/ResourceService'

const folderRoutes = new Hono<AppEnv>()

// 创建目录
folderRoutes.post("/folder", auth, async (c) => {
    try {
        const data = await c.req.json<Folder>()
        // Allow letters, numbers, underscores, hyphens and Chinese
        const regx = /^[A-Za-z0-9_-\u4e00-\u9fa5]+$/
        if (!data.name || !regx.test(data.name)) {
            return c.json(Fail("Folder name error: only letters, numbers, underscores, hyphens and Chinese allowed"))
        }
        const login = c.get('user')?.login
        if (!login) return c.json(Fail('无法确认用户配额'))
        // Folder markers use a Class A operation too, so charge the daily attempt budget.
        await reserveUpload(c.env.DB, data.name + '/', login, 0, 'R2')
        try { await c.env.PICX.put(data.name + '/', null) }
        finally { await releaseUpload(c.env.DB, data.name + '/') }
        return c.json(Ok("Success"))
    } catch (e) {
        console.error('Create folder error:', e)
        return c.json(Fail(`Create folder fail: ${resourceError(e)}`))
    }
})

export default folderRoutes
