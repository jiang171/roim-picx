export const resourceDefaults = {
    maxFileBytes: 20 * 1024 * 1024,
    maxBatchFiles: 5,
    maxBatchBytes: 40 * 1024 * 1024,
    dailyUploadFiles: 500,
    dailyUploadBytes: 500 * 1024 * 1024,
    maxR2Bytes: 8_000_000_000,
    deletionLinksEnabled: true,
    deletionTokenTtlDays: 0,
    dailyKvDeletes: 500,
    statisticsEnabled: true,
    statisticsSampleRate: 0.1,
    dailyStatisticsRecords: 5000,
    statisticsRetentionDays: 30,
    auditRetentionDays: 90,
    cleanupBatchRows: 100,
    dailyCleanupRows: 6000,
    apiKeyTouchSeconds: 3600,
    apiRequestsPerMinute: 120,
    imageRequestsPerMinute: 600,
    authRequestsPerMinute: 10,
    deletionRequestsPerMinute: 30
}

export type ResourceLimits = typeof resourceDefaults

// Keep each upload below D1 Free's 50-query invocation limit, including album linking.
const ranges: Record<string, [number, number]> = {
    maxFileBytes: [1, 90 * 1024 * 1024], maxBatchFiles: [1, 5],
    maxBatchBytes: [1, 90 * 1024 * 1024], dailyUploadFiles: [1, 1_000_000],
    dailyUploadBytes: [1, Number.MAX_SAFE_INTEGER], maxR2Bytes: [1, Number.MAX_SAFE_INTEGER],
    deletionTokenTtlDays: [0, 3650], dailyKvDeletes: [0, 100_000], dailyStatisticsRecords: [0, 100_000],
    statisticsRetentionDays: [1, 3650], auditRetentionDays: [1, 3650],
    cleanupBatchRows: [1, 100], dailyCleanupRows: [1, 10_000],
    apiKeyTouchSeconds: [60, 86400], apiRequestsPerMinute: [1, 100_000],
    imageRequestsPerMinute: [1, 100_000], authRequestsPerMinute: [1, 100_000],
    deletionRequestsPerMinute: [1, 100_000]
}

export function validateResourceLimits(value: unknown): ResourceLimits {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('额度配置必须是对象')
    const data = value as Record<string, unknown>
    for (const key of Object.keys(data)) {
        if (!Object.prototype.hasOwnProperty.call(resourceDefaults, key)) throw new Error(`未知配置：${key}`)
    }
    const result = { ...resourceDefaults, ...data } as ResourceLimits
    for (const [key, [min, max]] of Object.entries(ranges)) {
        const number = result[key as keyof ResourceLimits]
        if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < min || number > max) {
            throw new Error(`${key} 必须是 ${min} 至 ${max} 之间的整数`)
        }
    }
    if (typeof result.deletionLinksEnabled !== 'boolean' || typeof result.statisticsEnabled !== 'boolean') {
        throw new Error('功能开关必须为布尔值')
    }
    if (!Number.isFinite(result.statisticsSampleRate) || result.statisticsSampleRate < 0 || result.statisticsSampleRate > 1) {
        throw new Error('统计采样率必须在 0 至 1 之间')
    }
    if (result.maxFileBytes > result.maxBatchBytes) throw new Error('单张大小不能超过单批总大小')
    return result
}
