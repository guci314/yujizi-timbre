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
const busy = ref(false)
const error = ref<string>()
/** Progress of the track currently downloading, if any. */
const progress = ref<{ url: string; received: number; total: number }>()
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
    return progress.value?.url === url ? progress.value : undefined
  }

  async function saveTrack(book: BookDetail, track: Track, index: number): Promise<void> {
    busy.value = true
    error.value = undefined
    progress.value = { url: track.url, received: 0, total: 0 }
    try {
      await downloadTrack(book, track, index, {
        onProgress: (value) => {
          progress.value = { url: track.url, received: value.received, total: value.total }
        },
      })
      await refresh()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '下载失败'
    } finally {
      progress.value = undefined
      busy.value = false
    }
  }

  async function saveBook(book: BookDetail): Promise<void> {
    busy.value = true
    error.value = undefined
    try {
      const result = await downloadBook(book, {
        onProgress: (value) => {
          progress.value = { url: '', received: value.received, total: value.total }
        },
      })
      await refresh()
      if (result.error !== undefined) {
        error.value = `${result.error.message}（已下载 ${result.downloaded} 集）`
      }
    } finally {
      progress.value = undefined
      busy.value = false
    }
  }

  async function dropTrack(url: string): Promise<void> {
    busy.value = true
    try {
      await removeTrack(url)
      await refresh()
    } finally {
      busy.value = false
    }
  }

  async function dropBook(bookSlug: string): Promise<void> {
    busy.value = true
    try {
      await removeBookDownloads(bookSlug)
      await refresh()
    } finally {
      busy.value = false
    }
  }

  async function dropAll(): Promise<void> {
    busy.value = true
    try {
      await removeAllDownloads()
      await refresh()
    } finally {
      busy.value = false
    }
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
    error,
    persisted,
    isDownloaded,
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
  progress.value = undefined
  persisted.value = undefined
  error.value = undefined
  loaded = false
}
