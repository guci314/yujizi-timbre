/**
 * Download store: a reactive projection of the download grid.
 *
 * Each track has exactly one of four states (D0..D3). The view asks the stage,
 * never a set of booleans, which is why "downloading" and "stored" can no
 * longer both be true at once.
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
import {
  DOWNLOAD_GRID,
  initialDownloadContext,
  type DownloadContext,
  type DownloadEvent,
} from '../pim/offline-grid'
import { step } from '../pim/kernel'
import { auditStoredTracks, storeTrack, type StoredAuditResult } from './storage-driver'
import { formatBytes } from '../core/format'

/** Tracks fetched at once while downloading a whole book. */
const BOOK_CONCURRENCY = 3

const records = shallowRef<DownloadedTrack[]>([])
const stages = shallowRef<Map<string, DownloadContext>>(new Map())
const usage = ref<StorageUsage>()
const error = ref<string>()
const bookBusy = ref(false)
const persisted = ref<boolean>()
const auditing = ref(false)
const auditNote = ref<string>()
let loaded = false
let auditRun: Promise<StoredAuditResult> | undefined

function recordContexts(entries: DownloadedTrack[]): Map<string, DownloadContext> {
  return new Map(
    entries.map((entry) => [
      entry.url,
      {
        ...initialDownloadContext(entry.url),
        state: 'D2_STORED' as const,
        sizeBytes: entry.sizeBytes,
        received: entry.sizeBytes,
      },
    ]),
  )
}

async function refresh(): Promise<void> {
  const entries = await listDownloads()
  records.value = entries
  const next = recordContexts(entries)
  // Keep any in-flight stage so a refresh cannot pretend a running download stopped.
  for (const [url, stage] of stages.value) {
    if (stage.state === 'D1_DOWNLOADING' || stage.state === 'D3_FAILED') next.set(url, stage)
  }
  stages.value = next
  usage.value = await storageUsage()
  loaded = true
}

export async function ensureDownloadsLoaded(): Promise<void> {
  if (loaded) return
  await refresh()
}

/** Advance one track's grid state and publish the new context. */
function transition(url: string, event: DownloadEvent): DownloadContext {
  const current = stages.value.get(url) ?? initialDownloadContext(url)
  const result = step(DOWNLOAD_GRID, current, event)
  const next = new Map(stages.value)
  next.set(url, result.ctx)
  stages.value = next
  return result.ctx
}

export function useDownloads() {
  const entries = computed(() => [...records.value])
  const totalBytes = computed(() => records.value.reduce((sum, entry) => sum + entry.sizeBytes, 0))
  const busy = computed(
    () => bookBusy.value || [...stages.value.values()].some((stage) => stage.state === 'D1_DOWNLOADING'),
  )
  const usageLabel = computed(() => {
    if (usage.value === undefined) return undefined
    return `已用 ${formatBytes(usage.value.usage)}${usage.value.quota > 0 ? ` / 可用约 ${formatBytes(usage.value.quota)}` : ''}`
  })

  function stageFor(url: string): DownloadContext | undefined {
    return stages.value.get(url)
  }

  function isDownloaded(url: string): boolean {
    return stages.value.get(url)?.state === 'D2_STORED'
  }

  function isActive(url: string): boolean {
    return stages.value.get(url)?.state === 'D1_DOWNLOADING'
  }

  function recordFor(url: string): DownloadedTrack | undefined {
    return records.value.find((entry) => entry.url === url)
  }

  function downloadedCount(bookSlug: string): number {
    return records.value.filter((entry) => entry.bookSlug === bookSlug).length
  }

  function progressFor(url: string): { received: number; total: number } | undefined {
    const stage = stages.value.get(url)
    if (stage === undefined || stage.state !== 'D1_DOWNLOADING') return undefined
    return { received: stage.received, total: stage.total }
  }

  function failureFor(url: string): string | undefined {
    const stage = stages.value.get(url)
    return stage?.state === 'D3_FAILED' ? (stage.reason ?? '下载失败') : undefined
  }

  async function saveTrack(book: BookDetail, track: Track, index: number): Promise<boolean> {
    const stage = stages.value.get(track.url)
    if (stage?.state === 'D2_STORED' || stage?.state === 'D1_DOWNLOADING') return false
    error.value = undefined
    transition(track.url, { type: 'E_START_DL' })

    try {
      const stored = await storeTrack(book, track, index, (received, total) => {
        transition(track.url, { type: 'E_DL_PROGRESS', received, total })
      })
      transition(track.url, { type: 'E_DL_SUCCESS', sizeBytes: stored.sizeBytes })
      await refresh()
      return true
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '下载失败'
      transition(track.url, { type: 'E_DL_FAIL', reason: message })
      error.value = message
      return false
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
        error.value = `有 ${failures} 集下载失败，可稍后重试。`
      }
    } finally {
      bookBusy.value = false
    }
  }

  async function dropTrack(url: string): Promise<void> {
    transition(url, { type: 'E_REMOVE' })
    await removeTrack(url)
    await refresh()
  }

  async function dropBook(bookSlug: string): Promise<void> {
    const urls = records.value.filter((entry) => entry.bookSlug === bookSlug).map((entry) => entry.url)
    for (const url of urls) transition(url, { type: 'E_REMOVE' })
    await removeBookDownloads(bookSlug)
    await refresh()
  }

  async function dropAll(): Promise<void> {
    for (const url of records.value.map((entry) => entry.url)) transition(url, { type: 'E_REMOVE' })
    await removeAllDownloads()
    await refresh()
  }

  async function persist(): Promise<void> {
    persisted.value = await requestPersistence()
    usage.value = await storageUsage()
  }

  /**
   * Reconcile the index with the cache, then lazily verify legacy tracks.
   *
   * Safe to call on every visit: records already carrying a sha256 are skipped
   * without touching their bytes, so only old downloads pay the hashing cost,
   * and only once.
   */
  async function audit(): Promise<StoredAuditResult | undefined> {
    // A download in flight has bytes but no record yet, which looks exactly like
    // drift. Wait for it rather than delete a track that is about to succeed.
    if (busy.value) {
      auditNote.value = '有音频正在下载，完成后再校验本机文件'
      return undefined
    }

    auditRun ??= (async () => {
      auditing.value = true
      auditNote.value = '正在核对本机音频…'
      try {
        const inFlight = new Set(
          [...stages.value.values()]
            .filter((stage) => stage.state === 'D1_DOWNLOADING')
            .map((stage) => stage.url),
        )
        const result = await auditStoredTracks({
          skipUrls: inFlight,
          onProgress: (done, total) => {
            if (done < total) auditNote.value = `正在校验第 ${done + 1}/${total} 首旧音频…`
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
    auditing,
    auditNote,
    refresh,
  }
}

function describeAudit(result: StoredAuditResult): string {
  // Dangling records and orphan bytes are removed by the reconciliation step;
  // they are just as much "a broken leftover" to the listener.
  const removed = result.cleaned + result.danglingRecords + result.orphanBytes

  if (result.remaining > 0) {
    const parts = [`本次检查 ${result.checked} 首旧音频`]
    if (removed > 0) parts.push(`清理 ${removed} 个损坏文件`)
    parts.push(`还剩 ${result.remaining} 首，下次进入或点「核对账实」继续`)
    return parts.join('，')
  }
  if (removed > 0) {
    return `已自动清理 ${removed} 个损坏或未下完的旧音频，请重新下载`
  }
  if (result.checked === 0) {
    return result.alreadyVerified > 0
      ? `本机 ${result.alreadyVerified} 首音频均已校验，无需重算`
      : '还没有下载内容'
  }
  return `已校验 ${result.checked} 首旧音频，全部完好`
}

/** Test seam. */
export function resetDownloads(): void {
  records.value = []
  stages.value = new Map()
  usage.value = undefined
  error.value = undefined
  bookBusy.value = false
  persisted.value = undefined
  auditing.value = false
  auditNote.value = undefined
  loaded = false
  auditRun = undefined
}
