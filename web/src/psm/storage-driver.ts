/**
 * 书架伺服驱动：把「留存」这件事真正做成本机可离线的样子。
 *
 * 浏览器把脏活塞在这里：拉整段、核长度与指纹、先落字节再落索引、失败回滚、
 * 存量旧文件分批核验。业务层只看见「留存中 → 已留存」这一句话。
 */

import type { BookCatalogEntry, BookDetail, DownloadedTrack, Progress, Track } from '../core/domain'
import { AUDIO_CACHE } from '../core/audio-cache'
import { classifyDownloadFailure, fetchTrackBytes } from '../core/downloads'
import {
  expectedIntegrityFor,
  verifyBytes,
  type AudioIntegrity,
} from '../core/integrity'
import {
  deleteDownloadRecord,
  loadCatalogEntries,
  loadCatalogEntry,
  loadDownloads,
  loadProgress,
  saveCatalogEntry,
  saveDownload,
  saveProgress,
} from '../core/storage/db'

export function persistProgress(progress: Progress): Promise<Progress> {
  return saveProgress(progress)
}

export function readProgress(bookSlug: string): Promise<Progress | undefined> {
  return loadProgress(bookSlug)
}

/* --- 离线书箧 --------------------------------------------------------------- */

/** 把解析好的整卷记进本机，断网时书架与目录照样打得开。 */
export function cacheBook(book: BookDetail): Promise<BookCatalogEntry> {
  return saveCatalogEntry({
    slug: book.slug,
    title: book.title,
    pageUrl: book.pageUrl,
    tracks: book.tracks,
    updatedAt: Date.now(),
  })
}

export function loadCatalog(): Promise<BookCatalogEntry[]> {
  return loadCatalogEntries()
}

export function loadCatalogBook(slug: string): Promise<BookCatalogEntry | undefined> {
  return loadCatalogEntry(slug)
}

/* --- 账实对账 --------------------------------------------------------------- */

export interface ReconcilePlan {
  /** 有索引、无字节。 */
  readonly danglingRecords: readonly string[]
  /** 有字节、无索引。 */
  readonly orphanBytes: readonly string[]
}

export function reconcile(indexKeys: Iterable<string>, cacheKeys: Iterable<string>): ReconcilePlan {
  const index = new Set(indexKeys)
  const cache = new Set(cacheKeys)
  return {
    danglingRecords: [...index].filter((key) => !cache.has(key)).sort(),
    orphanBytes: [...cache].filter((key) => !index.has(key)).sort(),
  }
}

export function isConsistent(plan: ReconcilePlan): boolean {
  return plan.danglingRecords.length === 0 && plan.orphanBytes.length === 0
}

export async function listAudioCacheKeys(): Promise<string[]> {
  if (typeof caches === 'undefined') return []
  const cache = await caches.open(AUDIO_CACHE)
  const requests = await cache.keys()
  return requests.map((request) => request.url)
}

export async function listDownloadRecordKeys(): Promise<string[]> {
  const records = await loadDownloads()
  return records.map((record) => record.url)
}

export async function auditDownloads(): Promise<ReconcilePlan> {
  const [records, bytes] = await Promise.all([listDownloadRecordKeys(), listAudioCacheKeys()])
  return reconcile(records, bytes)
}

async function deleteAudioBytes(url: string): Promise<void> {
  if (typeof caches === 'undefined') return
  const cache = await caches.open(AUDIO_CACHE)
  await cache.delete(url)
}

async function repairPlan(plan: ReconcilePlan): Promise<void> {
  for (const url of plan.danglingRecords) await deleteDownloadRecord(url).catch(() => undefined)
  for (const url of plan.orphanBytes) await deleteAudioBytes(url).catch(() => undefined)
}

/** 清掉账实不符的残留。可每次进书箧页都跑。 */
export async function repairDownloadDrift(): Promise<ReconcilePlan> {
  const plan = await auditDownloads()
  if (!isConsistent(plan)) await repairPlan(plan)
  return plan
}

/* --- 留存一篇 --------------------------------------------------------------- */

export interface DownloadPort {
  putBytes(url: string): Promise<void>
  deleteBytes(url: string): Promise<void>
  putRecord(record: { url: string; sizeBytes: number }): Promise<void>
  deleteRecord(url: string): Promise<void>
}

export function createDownloadPort(
  record: Omit<DownloadedTrack, 'url' | 'sizeBytes'>,
  body: Blob,
  headers: Headers,
): DownloadPort {
  return {
    async putBytes(url) {
      const cache = await caches.open(AUDIO_CACHE)
      await cache.put(url, new Response(body, { headers }))
    },
    async deleteBytes(url) {
      await deleteAudioBytes(url)
    },
    async putRecord(entry) {
      await saveDownload({ ...record, url: entry.url, sizeBytes: entry.sizeBytes })
    },
    async deleteRecord(url) {
      await deleteDownloadRecord(url)
    },
  }
}

/**
 * 真正把一篇收进书箧。
 *
 * 顺序不可换：先落字节、再落索引；索引写不进去就把字节删掉。业务层只看见
 * 「验明完好」或「留存受阻」两个结果。
 */
export async function storeTrack(
  book: BookDetail,
  track: Track,
  trackIndex: number,
  onProgress?: (received: number, total: number) => void,
): Promise<DownloadedTrack> {
  try {
    // `fetchTrackBytes` 已经核过长度与指纹，这里拿到的必定是完好的一段。
    const { body, sizeBytes, headers, sha256 } = await fetchTrackBytes(track, {
      onProgress: (progress) => onProgress?.(progress.received, progress.total),
    })

    const record: Omit<DownloadedTrack, 'url' | 'sizeBytes'> = {
      bookSlug: book.slug,
      bookTitle: book.title,
      trackIndex,
      trackName: track.name,
      downloadedAt: Date.now(),
      sha256,
    }
    const port = createDownloadPort(record, body, headers)

    try {
      await port.putBytes(track.url)
      await port.putRecord({ url: track.url, sizeBytes })
    } catch (cause) {
      await port.deleteBytes(track.url).catch(() => undefined)
      throw cause
    }

    // 收进一篇，整卷目录也要在本机可见，否则断网时打得开音频却打不开目录。
    await cacheBook(book).catch(() => undefined)

    return { ...record, url: track.url, sizeBytes }
  } catch (cause) {
    // 失败时顺手清掉这一篇可能残留的半截字节。
    await deleteAudioBytes(track.url).catch(() => undefined)
    throw new Error(classifyDownloadFailure(cause))
  }
}

/* --- 存量旧文件的懒核验 ------------------------------------------------------ */

export const AUDIT_BATCH_SIZE = 15

export interface StoredAuditResult {
  readonly danglingRecords: number
  readonly orphanBytes: number
  readonly alreadyVerified: number
  readonly checked: number
  readonly cleaned: number
  readonly remaining: number
}

export interface StoredAuditOptions {
  resolveExpected?: (url: string) => Promise<AudioIntegrity | undefined>
  onProgress?: (done: number, total: number) => void
  maxChecks?: number
  skipUrls?: Iterable<string>
}

/**
 * 分批核验旧版本留下的留存文件。
 *
 * 新留存的文件在写入时就带着指纹，这里直接跳过；只有旧文件才需要读字节。
 * 严格一首一首来：十首 80MB 同时读进 iPad 内存会把页面直接拖死。
 */
export async function auditStoredTracks(options: StoredAuditOptions = {}): Promise<StoredAuditResult> {
  const resolveExpected = options.resolveExpected ?? ((url: string) => expectedIntegrityFor(url))
  const skip = new Set(options.skipUrls ?? [])

  let records = (await loadDownloads()).filter((record) => !skip.has(record.url))
  const cacheKeys = (await listAudioCacheKeys()).filter((key) => !skip.has(key))
  const plan = reconcile(
    records.map((record) => record.url),
    cacheKeys,
  )
  if (!isConsistent(plan)) {
    await repairPlan(plan)
    records = (await loadDownloads()).filter((record) => !skip.has(record.url))
  }

  const targets: Array<{ record: DownloadedTrack; expected: AudioIntegrity | undefined }> = []
  let alreadyVerified = 0
  for (const record of records) {
    const expected = await resolveExpected(record.url)
    if (record.sha256 !== undefined && (expected === undefined || record.sha256 === expected.sha256)) {
      alreadyVerified += 1
      continue
    }
    targets.push({ record, expected })
  }

  targets.sort((left, right) => left.record.sizeBytes - right.record.sizeBytes)

  const limit = Math.max(0, options.maxChecks ?? AUDIT_BATCH_SIZE)
  const batch = targets.slice(0, limit)

  let checked = 0
  let cleaned = 0
  const cache = await caches.open(AUDIO_CACHE)

  const drop = async (url: string): Promise<void> => {
    await cache.delete(url).catch(() => undefined)
    await deleteDownloadRecord(url).catch(() => undefined)
  }

  for (let index = 0; index < batch.length; index += 1) {
    options.onProgress?.(index, batch.length)
    const { record, expected } = batch[index]
    checked += 1

    if (expected !== undefined && record.sizeBytes > 0 && record.sizeBytes !== expected.size) {
      await drop(record.url)
      cleaned += 1
      continue
    }

    const response = await cache.match(record.url).catch(() => undefined)
    if (response === undefined) {
      await drop(record.url)
      cleaned += 1
      continue
    }

    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(await response.arrayBuffer())
    } catch {
      await drop(record.url)
      cleaned += 1
      continue
    }

    let verified: { sha256: string }
    try {
      verified = await verifyBytes({ bytes, declaredLength: 0, expected })
    } catch {
      await drop(record.url)
      cleaned += 1
      continue
    }

    await saveDownload({
      ...record,
      sizeBytes: bytes.length,
      sha256: verified.sha256,
    }).catch(() => undefined)
  }

  options.onProgress?.(batch.length, batch.length)

  return {
    danglingRecords: plan.danglingRecords.length,
    orphanBytes: plan.orphanBytes.length,
    alreadyVerified,
    checked,
    cleaned,
    remaining: targets.length - batch.length,
  }
}
