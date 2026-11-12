import type { Context, Next } from 'hono'
import { FailCode } from '../type'
import type { AppEnv } from './auth'
import { getResourceLimits } from '../services/ResourceService'

const requests = new Map<string, { count: number, resetsAt: number }>()
const maxEntries = 10_000

export function takeMemoryBudget(key: string, limit: number, now = Date.now()): number {
    let record = requests.get(key)
    if (!record || now >= record.resetsAt) {
        if (requests.size >= maxEntries) {
            for (const [entry, value] of requests) if (value.resetsAt <= now) requests.delete(entry)
            // Do not evict active counters: fail closed while the bounded map is full.
            if (!requests.has(key) && requests.size >= maxEntries) return 60
        }
        record = { count: 0, resetsAt: now + 60_000 }
        requests.set(key, record)
    }
    if (record.count >= limit) return Math.max(1, Math.ceil((record.resetsAt - now) / 1000))
    record.count++
    return 0
}

export async function resourceProtection(c: Context<AppEnv>, next: Next) {
    if (c.req.method === 'OPTIONS') return next()
    const limits = await getResourceLimits(c.env.DB)
    c.set('resourceLimits', limits)
    const path = c.req.path
    const login = /\/(checkToken|github\/login|steam\/login|google\/login)$/.test(path)
    const deletion = /\/del(?:Info|Image)?\//.test(path) || c.req.method === 'DELETE'
    const links = /\/del(?:Info|Image)\//.test(path)
    if (links && !limits.deletionLinksEnabled) return c.json(FailCode('删除链接功能已关闭，仍可在后台删除图片', 403), 403)
    const image = c.req.method === 'GET' && !/^\/rest\/(auth|user|admin|settings|albums?|api-keys|github|steam|google|share|del|checkToken)(\/|$)/.test(path)
    const group = login ? 'auth' : deletion ? 'delete' : image ? 'image' : 'api'
    const limit = login ? limits.authRequestsPerMinute : deletion ? limits.deletionRequestsPerMinute
        : image ? limits.imageRequestsPerMinute : limits.apiRequestsPerMinute
    const ip = c.req.header('cf-connecting-ip') || 'unknown'
    // Group paths, rather than using arbitrary image keys, to prevent path-based bypasses.
    const retry = takeMemoryBudget(`${group}:${ip}`, limit)
    if (retry) {
        c.header('Retry-After', String(retry))
        return c.json(FailCode(`请求过于频繁，请 ${retry} 秒后重试`, 429), 429)
    }
    return next()
}
