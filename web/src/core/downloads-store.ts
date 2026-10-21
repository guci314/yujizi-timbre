import { computed, ref, shallowRef } from 'vue'
import type { BookDetail, DownloadedTrack, Track } from './domain'
import {
  downloadBook,
  downloadTrack,
  listDownloads,
  removeAllDownloads,
  removeBookDownloads,
  removeTrack,
  requestPersistence,
  storageUsage,
  type StorageUsage,
} from './downloads'
import { formatBytes } from './format'

/** Download records keyed by track url, shared across views. */
const records = shallowRef<Map<string, DownloadedTrack>>(new Map())
const usage = ref<StorageUsage>()
/** Per-track download progress, keyed by track url. Several tracks may be in flight. */
const progress = ref<Map<string, { received: number; total: number }>>(new Map())
/** Tracks currently being downloaded, so the UI can disable just those. */
const active = ref<Set<string>>(new Set())
/** A book download is running; its tracks report progress through `progress`. */
const bookBusy = ref(false)
const error = ref<string>()
/** Persistence is advisory; a refusal is recorded but never blocks. */
const persisted = ref<boolean>()

let loaded = false

async function refresh(): Promise<void> {
  const entries = await listDownloads()
  records.value = new Map(entries.map((entry) => [entry.url, entry]))
  usage.value = await storageUsage()
  loaded = true
}

/** Load download state once, then keep it in memory. */
export async function ensureDownloadsLoaded(): Promise<void> {
  if (loaded) return
  await refresh()
}

export function useDownloads() {
  const entries = computed(() => [...records.value.values()])
  const totalBytes = computed(() => entries.value.reduce((sum, entry) => sum + entry.sizeBytes, 0))
  const usageLabel = computed(() => {
    if (usage.value === undefined) return undefined
    return `已用 ${formatBytes(usage.value.usage)}${usage.value.quota > 0 ? ` / 可用约 ${formatBytes(usage.value.quota)}` : ''}`
  })
  /** True while anything is downloading; used for the destructive actions only. */
  const busy = computed(() => active.value.size > 0 || bookBusy.value)

  function isDownloaded(url: string): boolean {
    return records.value.has(url)
  }

  function recordFor(url: string): DownloadedTrack | undefined {
    return records.value.get(url)
  }

  function downloadedCount(bookSlug: string): number {
    return entries.value.filter((entry) => entry.bookSlug === bookSlug).length
  }

  function progressFor(url: string): { received: number; total: number } | undefined {
    return progress.value.get(url)
  }

  /** True while this one track is downloading. */
  function isActive(url: string): boolean {
    return active.value.has(url)
  }

  async function saveTrack(book: BookDetail, track: Track, index: number): Promise<void> {
    if (active.value.has(track.url)) return
    error.value = undefined
    active.value = new Set(active.value).add(track.url)
    progress.value = new Map(progress.value).set(track.url, { received: 0, total: 0 })
    try {
      await downloadTrack(book, track, index, {
        onProgress: (value) => {
          const next = new Map(progress.value)
          next.set(value.url, { received: value.received, total: value.total })
          progress.value = next
        },
      })
      await refresh()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '下载失败'
    } finally {
      const nextActive = new Set(active.value)
      nextActive.delete(track.url)
      active.value = nextActive
      const nextProgress = new Map(progress.value)
      nextProgress.delete(track.url)
      progress.value = nextProgress
    }
  }

  async function saveBook(book: BookDetail): Promise<void> {
    if (bookBusy.value) return
    bookBusy.value = true
    error.value = undefined
    try {
      const result = await downloadBook(book, {
        onProgress: (value) => {
          const next = new Map(progress.value)
          next.set(value.url, { received: value.received, total: value.total })
          progress.value = next
        },
      })
      await refresh()
      if (result.error !== undefined) {
        error.value = `${result.error.message}（已下载 ${result.downloaded} 集）`
      }
    } finally {
      progress.value = new Map()
      bookBusy.value = false
    }
  }

  async function dropTrack(url: string): Promise<void> {
    await removeTrack(url)
    await refresh()
  }

  async function dropBook(bookSlug: string): Promise<void> {
    await removeBookDownloads(bookSlug)
    await refresh()
  }

  async function dropAll(): Promise<void> {
    await removeAllDownloads()
    await refresh()
  }

  /** Ask once for persistent storage, which exempts the origin from Safari's cleanup. */
  async function persist(): Promise<void> {
    persisted.value = await requestPersistence()
    usage.value = await storageUsage()
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
    isDownloaded,
    isActive,
    recordFor,
    downloadedCount,
    progressFor,
    saveTrack,
    saveBook,
    dropTrack,
    dropBook,
    dropAll,
    persist,
    refresh,
  }
}

/** Test seam: forget cached download state. */
export function resetDownloadsState(): void {
  records.value = new Map()
  usage.value = undefined
  progress.value = new Map()
  active.value = new Set()
  bookBusy.value = false
  persisted.value = undefined
  error.value = undefined
  loaded = false
}
