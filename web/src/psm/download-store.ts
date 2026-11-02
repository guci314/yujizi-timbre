/**
 * 书箧外壳：把每一篇的留存快照投影给视图。
 *
 * 视图问「这一篇在不在箧里」，答案只可能是四种之一，不再拼凑布尔值。
 */

import { computed, ref, shallowRef } from 'vue'
import type { BookDetail, DownloadedTrack, Track } from '../core/domain'
import {
  listDownloads,
  removeAllDownloads,
  removeBookDownloads,
  removeTrack,
  requestPersistence,
  storageUsage,
  type StorageUsage,
} from '../core/downloads'
import { step } from '../pim/kernel'
import { RETENTION_GRID } from '../pim/retention-grid'
import {
  initialRetentionContext,
  type KeepFailReason,
  type RetentionContext,
  type RetentionEvent,
} from '../pim/retention-model'
import { auditStoredTracks, storeTrack, type StoredAuditResult } from './storage-driver'
import { formatBytes } from '../core/format'

const BOOK_CONCURRENCY = 3

const records = shallowRef<DownloadedTrack[]>([])
/** 每一篇的留存快照，按本机取用地址索引。 */
const stages = shallowRef<Map<string, RetentionContext>>(new Map())
/** 留存中的字节进度，仅用于展示。 */
const bytes = shallowRef<Map<string, { received: number; total: number }>>(new Map())
const usage = ref<StorageUsage>()
const error = ref<string>()
const bookBusy = ref(false)
const persisted = ref<boolean>()
const auditing = ref(false)
const auditNote = ref<string>()
let loaded = false
let auditRun: Promise<StoredAuditResult | undefined> | undefined

function stagesFromRecords(entries: DownloadedTrack[]): Map<string, RetentionContext> {
  return new Map(
    entries.map((entry) => [
      entry.url,
      {
        ...initialRetentionContext(entry.bookSlug, entry.trackIndex),
        state: 'D2_KEPT' as const,
        progressPct: 100,
        occupiedSpace: entry.sizeBytes,
      },
    ]),
  )
}

async function refresh(): Promise<void> {
  const entries = await listDownloads()
  records.value = entries
  const next = stagesFromRecords(entries)
  for (const [url, stage] of stages.value) {
    if (stage.state === 'D1_KEEPING' || stage.state === 'D3_FAILED') next.set(url, stage)
  }
  stages.value = next
  usage.value = await storageUsage()
  loaded = true
}

export async function ensureDownloadsLoaded(): Promise<void> {
  if (loaded) return
  await refresh()
}

function transition(url: string, event: RetentionEvent): RetentionContext {
  const current = stages.value.get(url) ?? initialRetentionContext('', 0)
  const next = step(RETENTION_GRID, current, event)
  const updated = new Map(stages.value)
  updated.set(url, next)
  stages.value = updated
  return next
}

/** 平台原因 → 纯业务缘由。 */
function keepReason(cause: unknown): KeepFailReason {
  const reason = (cause as { reason?: KeepFailReason } | undefined)?.reason
  if (reason !== undefined) return reason
  const message = cause instanceof Error ? cause.message : ''
  if (message.includes('空间不足')) return 'SPACE_FULL'
  if (message.includes('校验失败')) return 'CONTENT_CORRUPTED'
  return 'SOURCE_UNREACHABLE'
}

function reasonLabel(reason: KeepFailReason): string {
  switch (reason) {
    case 'SPACE_FULL':
      return '书箧空间不足'
    case 'CONTENT_CORRUPTED':
      return '内容残损，未通过核验'
    default:
      return '书源中断'
  }
}

export function useDownloads() {
  const entries = computed(() => [...records.value])
  const totalBytes = computed(() => records.value.reduce((sum, entry) => sum + entry.sizeBytes, 0))
  const busy = computed(
    () => bookBusy.value || [...stages.value.values()].some((stage) => stage.state === 'D1_KEEPING'),
  )
  const usageLabel = computed(() => {
    if (usage.value === undefined) return undefined
    return `已用 ${formatBytes(usage.value.usage)}${usage.value.quota > 0 ? ` / 可用约 ${formatBytes(usage.value.quota)}` : ''}`
  })

  function stageFor(url: string): RetentionContext | undefined {
    return stages.value.get(url)
  }

  function isDownloaded(url: string): boolean {
    return stages.value.get(url)?.state === 'D2_KEPT'
  }

  function isActive(url: string): boolean {
    return stages.value.get(url)?.state === 'D1_KEEPING'
  }

  function recordFor(url: string): DownloadedTrack | undefined {
    return records.value.find((entry) => entry.url === url)
  }

  function downloadedCount(bookId: string): number {
    return records.value.filter((entry) => entry.bookSlug === bookId).length
  }

  function progressFor(url: string): { received: number; total: number } | undefined {
    if (stages.value.get(url)?.state !== 'D1_KEEPING') return undefined
    return bytes.value.get(url) ?? { received: 0, total: 0 }
  }

  function failureFor(url: string): string | undefined {
    const stage = stages.value.get(url)
    return stage?.state === 'D3_FAILED' && stage.failReason !== null ? reasonLabel(stage.failReason) : undefined
  }

  async function saveTrack(book: BookDetail, track: Track, index: number): Promise<boolean> {
    const current = stages.value.get(track.url)
    if (current?.state === 'D2_KEPT' || current?.state === 'D1_KEEPING') return false

    error.value = undefined
    if (current === undefined || current.bookId === '') {
      stages.value = new Map(stages.value).set(track.url, initialRetentionContext(book.slug, index))
    }
    transition(track.url, { type: 'E_REQUEST_KEEP' })
    bytes.value = new Map(bytes.value).set(track.url, { received: 0, total: 0 })

    try {
      const stored = await storeTrack(book, track, index, (received, total) => {
        const item = bytes.value.get(track.url) ?? { received: 0, total }
        bytes.value = new Map(bytes.value).set(track.url, { received, total: total || item.total })
        const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0
        transition(track.url, { type: 'E_KEEP_PROGRESS', pct })
      })
      transition(track.url, { type: 'E_VERIFIED_COMPLETE', space: stored.sizeBytes })
      await refresh()
      return true
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '留存失败'
      transition(track.url, { type: 'E_KEEP_FAILED', reason: keepReason(cause) })
      error.value = message
      return false
    } finally {
      const next = new Map(bytes.value)
      next.delete(track.url)
      bytes.value = next
    }
  }

  async function saveBook(book: BookDetail): Promise<void> {
    if (bookBusy.value) return
    bookBusy.value = true
    error.value = undefined
    try {
      const pending = book.tracks
        .map((track, index) => ({ track, index }))
        .filter(({ track }) => !isDownloaded(track.url))

      let cursor = 0
      let failures = 0
      const worker = async (): Promise<void> => {
        for (;;) {
          const position = cursor
          cursor += 1
          if (position >= pending.length) return
          const { track, index } = pending[position]
          const ok = await saveTrack(book, track, index)
          if (!ok) failures += 1
        }
      }

      const workers = Math.min(BOOK_CONCURRENCY, Math.max(pending.length, 1))
      await Promise.all(Array.from({ length: workers }, () => worker()))
      if (failures > 0 && error.value === undefined) {
        error.value = `有 ${failures} 篇未能留存，可稍后重试。`
      }
    } finally {
      bookBusy.value = false
    }
  }

  async function dropTrack(url: string): Promise<void> {
    transition(url, { type: 'E_RELEASE' })
    await removeTrack(url)
    await refresh()
  }

  async function dropBook(bookId: string): Promise<void> {
    const urls = records.value.filter((entry) => entry.bookSlug === bookId).map((entry) => entry.url)
    for (const url of urls) transition(url, { type: 'E_RELEASE' })
    await removeBookDownloads(bookId)
    await refresh()
  }

  async function dropAll(): Promise<void> {
    for (const url of records.value.map((entry) => entry.url)) transition(url, { type: 'E_RELEASE' })
    await removeAllDownloads()
    await refresh()
  }

  async function persist(): Promise<void> {
    persisted.value = await requestPersistence()
    usage.value = await storageUsage()
  }

  /** 对账 + 分批核验旧文件。可每次进书箧页都跑。 */
  async function audit(): Promise<StoredAuditResult | undefined> {
    if (busy.value) {
      auditNote.value = '有篇章正在留存，完成后再核验本机文件'
      return undefined
    }

    auditRun ??= (async () => {
      auditing.value = true
      auditNote.value = '正在核对本机篇章…'
      try {
        const inFlight = new Set(
          [...stages.value.entries()]
            .filter(([, stage]) => stage.state === 'D1_KEEPING')
            .map(([url]) => url),
        )
        const result = await auditStoredTracks({
          skipUrls: inFlight,
          onProgress: (done, total) => {
            if (done < total) auditNote.value = `正在核验第 ${done + 1}/${total} 篇旧文件…`
          },
        })
        auditNote.value = describeAudit(result)
        await refresh()
        return result
      } finally {
        auditing.value = false
      }
    })().finally(() => {
      auditRun = undefined
    })
    return auditRun
  }

  return {
    entries,
    totalBytes,
    usage,
    usageLabel,
    busy,
    bookBusy,
    error,
    persisted,
    auditing,
    auditNote,
    stageFor,
    isDownloaded,
    isActive,
    recordFor,
    downloadedCount,
    progressFor,
    failureFor,
    saveTrack,
    saveBook,
    dropTrack,
    dropBook,
    dropAll,
    persist,
    audit,
    refresh,
  }
}

function describeAudit(result: StoredAuditResult): string {
  const removed = result.cleaned + result.danglingRecords + result.orphanBytes

  if (result.remaining > 0) {
    const parts = [`本次核验 ${result.checked} 篇旧文件`]
    if (removed > 0) parts.push(`清理 ${removed} 个残损文件`)
    parts.push(`还剩 ${result.remaining} 篇，下次进入或点「核对账实」继续`)
    return parts.join('，')
  }
  if (removed > 0) {
    return `已自动清理 ${removed} 个残损或未留存的旧文件，请重新留存`
  }
  if (result.checked === 0) {
    return result.alreadyVerified > 0
      ? `本机 ${result.alreadyVerified} 篇均已核实，无需重算`
      : '还没有留存任何篇章'
  }
  return `已核验 ${result.checked} 篇旧文件，全部完好`
}

/** 测试用。 */
export function resetDownloads(): void {
  records.value = []
  stages.value = new Map()
  bytes.value = new Map()
  usage.value = undefined
  error.value = undefined
  bookBusy.value = false
  persisted.value = undefined
  auditing.value = false
  auditNote.value = undefined
  loaded = false
  auditRun = undefined
}
