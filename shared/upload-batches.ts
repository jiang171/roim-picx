export function partitionFiles<T extends { size: number }>(files: T[], maxFiles: number, maxBytes: number): T[][] {
    if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
        throw new Error('无效的分批限制')
    }
    const batches: T[][] = []
    let batch: T[] = []
    let bytes = 0
    for (const file of files) {
        if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > maxBytes) throw new Error('图片超过单批大小限制')
        if (batch.length && (batch.length >= maxFiles || bytes + file.size > maxBytes)) {
            batches.push(batch); batch = []; bytes = 0
        }
        batch.push(file); bytes += file.size
    }
    if (batch.length) batches.push(batch)
    return batches
}
