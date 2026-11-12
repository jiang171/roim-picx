<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElCard, ElInputNumber, ElSwitch, ElMessage } from 'element-plus'
import BaseButton from '../common/BaseButton.vue'
import formatBytes from '../../utils/format-bytes'
import { resourceDefaults, type ResourceLimits } from '../../../shared/resource-limits'
import { requestResourceSettings, saveResourceSettings, cleanupResourceHistory, reconcileResourceUsage, type ResourceUsage } from '../../utils/request'

const { locale } = useI18n()
const text = (zh: string, en: string) => locale.value.startsWith('zh') ? zh : en
const limits = ref<ResourceLimits>({ ...resourceDefaults })
const usage = ref<ResourceUsage>()
const busy = ref(false)
type NumberKey = Exclude<keyof ResourceLimits, 'deletionLinksEnabled' | 'statisticsEnabled'>
const groups: Array<{ zh: string; en: string; fields: Array<{ key: NumberKey; zh: string; en: string; unit?: number; suffix?: string; max?: number }> }> = [
    { zh: '上传与容量', en: 'Uploads and storage', fields: [
        { key: 'maxFileBytes', zh: '单张大小', en: 'Per file', unit: 1048576, suffix: 'MiB' },
        { key: 'maxBatchFiles', zh: '单批张数（最多 5）', en: 'Files per batch (up to 5)', max: 5 },
        { key: 'maxBatchBytes', zh: '单批总大小', en: 'Per batch', unit: 1048576, suffix: 'MiB' },
        { key: 'dailyUploadFiles', zh: '每日上传张数预算', en: 'Daily upload attempts' },
        { key: 'dailyUploadBytes', zh: '每日上传容量预算', en: 'Daily upload bytes', unit: 1048576, suffix: 'MiB' },
        { key: 'maxR2Bytes', zh: 'R2 总存储上限', en: 'Total R2 storage', unit: 1e9, suffix: 'GB' }
    ] },
    { zh: '统计与保留', en: 'Statistics and retention', fields: [
        { key: 'statisticsSampleRate', zh: '访问统计采样率', en: 'Access sampling', unit: 0.01, suffix: '%', max: 100 },
        { key: 'dailyStatisticsRecords', zh: '每日最多记录访问', en: 'Daily access records' },
        { key: 'statisticsRetentionDays', zh: '访问明细保留', en: 'Access retention', suffix: 'days' },
        { key: 'auditRetentionDays', zh: '操作日志保留', en: 'Audit retention', suffix: 'days' },
        { key: 'cleanupBatchRows', zh: '每批最多清理', en: 'Cleanup batch', max: 100 },
        { key: 'dailyCleanupRows', zh: '每日清理预算', en: 'Daily cleanup budget' },
        { key: 'apiKeyTouchSeconds', zh: 'API Key 使用时间更新间隔', en: 'API Key timestamp interval', suffix: 'seconds' },
        { key: 'deletionTokenTtlDays', zh: '新删除链接有效期（0 为永久）', en: 'New deletion link lifetime (0 = permanent)', suffix: 'days' },
        { key: 'dailyKvDeletes', zh: '每日 KV Token 清理预算', en: 'Daily KV token cleanup budget' }
    ] },
    { zh: '每分钟入口限流', en: 'Requests per minute', fields: [
        { key: 'apiRequestsPerMinute', zh: '每 IP 普通接口 / 每 API Key', en: 'API per IP / API Key' },
        { key: 'imageRequestsPerMinute', zh: '每 IP 图片请求', en: 'Images per IP' },
        { key: 'authRequestsPerMinute', zh: '每 IP 登录尝试', en: 'Login attempts per IP' },
        { key: 'deletionRequestsPerMinute', zh: '每 IP 删除相关请求', en: 'Deletion requests per IP' }
    ] }
]
function edit(key: NumberKey, value: number | undefined, unit = 1) {
    limits.value[key] = unit >= 1 ? Math.round(Number(value) * unit) : Number(value) * unit
}
const cards = computed(() => usage.value ? [
    [text('R2 已占用（含预留）', 'R2 including reservations'), `${formatBytes(usage.value.r2.bytes)} / ${formatBytes(limits.value.maxR2Bytes)}`],
    [text('今日上传预算', 'Daily upload budget'), `${usage.value.uploads.count} / ${limits.value.dailyUploadFiles} · ${formatBytes(usage.value.uploads.bytes)}`],
    [text('今日访问记录', 'Access records today'), `${usage.value.statistics.count} / ${limits.value.dailyStatisticsRecords}`],
    [text('待登记 / 核对', 'Pending registration / reconciliation'), `${usage.value.pending.count} · ${formatBytes(usage.value.pending.bytes)}`],
    [text('今日 KV 清理', 'KV cleanup today'), `${usage.value.kvDeletes.count} / ${limits.value.dailyKvDeletes}`]
] : [])
async function load() { const data = await requestResourceSettings(); limits.value = data.limits; usage.value = data.usage }
async function action(task: () => Promise<unknown>) {
    busy.value = true
    try { await task(); await load() } catch (e) { console.error(e) } finally { busy.value = false }
}
onMounted(() => action(async () => {}))
</script>

<template>
    <el-card shadow="never" class="mt-4" v-loading="busy">
        <template #header>
            <div class="flex flex-wrap items-center justify-between gap-3">
                <span>{{ text('资源额度', 'Resource budgets') }}</span>
                <div class="flex gap-2">
                    <BaseButton size="sm" @click="action(async () => {})">{{ text('刷新用量', 'Refresh') }}</BaseButton>
                    <BaseButton size="sm" type="indigo" @click="action(async () => { await saveResourceSettings(limits); ElMessage.success(text('额度配置已保存', 'Budgets saved')) })">{{ text('保存', 'Save') }}</BaseButton>
                </div>
            </div>
        </template>
        <div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 mb-5">
            <div v-for="[label, value] in cards" :key="label" class="rounded-lg bg-gray-50 dark:bg-gray-800 p-3">
                <div class="text-xs text-gray-500">{{ label }}</div><div class="mt-1 font-medium">{{ value }}</div>
            </div>
        </div>
        <p class="text-sm text-gray-500 mb-5">{{ text('这里显示本项目的预算计数，包含未完成上传的预留，不是 Cloudflare 账单用量。每日北京时间 08:00 重置；上传失败或删除图片不会返还当天上传预算。', 'These are application budgets, including pending uploads, not Cloudflare billing metrics. Daily budgets reset at 00:00 UTC. Failed attempts and deletions do not refund daily upload budgets.') }}</p>
        <div class="flex flex-wrap gap-6 mb-6">
            <label class="flex items-center gap-3"><el-switch v-model="limits.deletionLinksEnabled" />{{ text('删除链接', 'Deletion links') }}</label>
            <label class="flex items-center gap-3"><el-switch v-model="limits.statisticsEnabled" />{{ text('访问统计', 'Access statistics') }}</label>
        </div>
        <section v-for="group in groups" :key="group.en" class="mb-6">
            <h3 class="font-medium mb-3">{{ text(group.zh, group.en) }}</h3>
            <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                <label v-for="field in group.fields" :key="field.key" class="text-sm">
                    <span class="block mb-2">{{ text(field.zh, field.en) }} <span class="text-gray-400">{{ field.suffix }}</span></span>
                    <el-input-number :model-value="limits[field.key] / (field.unit || 1)" :min="0" :max="field.max" controls-position="right"
                        @update:model-value="value => edit(field.key, value, field.unit)" />
                </label>
            </div>
        </section>
        <p class="text-sm text-gray-500 mb-3">{{ text('访问统计是采样记录，达到每日预算后停止记录，图片继续访问。入口限流按运行实例计数；全站存储和上传预算由数据库统一执行。配置缓存最多 30 秒。', 'Access statistics are sampled and stop at their daily budget while images remain accessible. Entry rate limits are per instance; storage and upload budgets are enforced by the database. Configuration caches last up to 30 seconds.') }}</p>
        <div class="flex flex-wrap gap-2">
            <BaseButton size="sm" @click="action(async () => { const result = await cleanupResourceHistory(); ElMessage.info(`${text('已清理记录', 'Records deleted')}: ${result.deleted}${result.exhausted ? text('，今日清理预算已用完', ', daily cleanup budget exhausted') : ''}`) })">{{ text('分批清理过期记录', 'Clean old records') }}</BaseButton>
            <BaseButton size="sm" @click="action(async () => { const result = await reconcileResourceUsage(); ElMessage.info(`${text('已核对 / 释放 / 保留', 'Checked / released / retained')}: ${result.checked} / ${result.released} / ${result.retained}`) })">{{ text('核对一小时前的预留', 'Check reservations older than 1h') }}</BaseButton>
        </div>
    </el-card>
</template>
