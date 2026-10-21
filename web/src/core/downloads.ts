import type { BookDetail, DownloadedTrack, Track } from './domain'
import { StorageFullError } from './domain'
import { AUDIO_CACHE } from './audio-cache'
import {
  deleteAllDownloadRecords,
  deleteDownloadRecord,
  deleteDownloadRecordsForBook,
  loadDownloads,
  loadDownloadsForBook,
  saveDownload,
} from './storage/db'

/** Progress of one download, in bytes. `total` is 0 when the server sent no length. */
export interface DownloadProgress {
  /** The track this progress belongs to; a book download runs several at once. */
  url: string
  received: number
  total: number
}

export interface DownloadOptions {
  onProgress?: (progress: DownloadProgress) => void
  signal?: AbortSignal
}

/** Open the audio cache bucket. */
function openCache(): Promise<Cache> {
  return caches.open(AUDIO_CACHE)
}

/**
 * Whether a failed cache write was the browser refusing for lack of space.
 * Safari reports a bare `QuotaExceededError`; Chrome may name it explicitly.
 */
export function isQuotaError(cause: unknown): boolean {
  if (cause instanceof DOMException) {
    return cause.name === 'QuotaExceededError' || cause.name === 'NS_ERROR_DOM_QUOTA_REACHED'
  }
  return false
}

/**
 * Store one track on the device.
 *
 * Media cannot be cached while it streams, because playback only ever asks for
 * byte ranges and the response is a 206. So a download reads the whole body
 * here, which is also what makes progress reporting possible.
 */
export async function downloadTrack(
  book: Pick<BookDetail, 'slug' | 'title'>,
  track: Track,
  trackIndex: number,
  options: DownloadOptions = {},
): Promise<DownloadedTrack> {
  const response = await fetch(track.url, { signal: options.signal })
  if (!response.ok) {
    throw new Error(`下载失败（${response.status}）：${track.name}`)
  }
  const declaredLength = Number(response.headers.get('content-length') ?? 0)

  const chunks: Uint8Array[] = []
  let received = 0
  const body = response.body
  if (body !== null) {
    const reader = body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      received += value.length
      options.onProgress?.({ url: track.url, received, total: declaredLength })
    }
  } else {
    const buffer = new Uint8Array(await response.arrayBuffer())
    chunks.push(buffer)
    received = buffer.length
    options.onProgress?.({ url: track.url, received, total: declaredLength })
  }

  const record: DownloadedTrack = {
    url: track.url,
    bookSlug: book.slug,
    bookTitle: book.title,
    trackIndex,
    trackName: track.name,
    sizeBytes: received,
    downloadedAt: Date.now(),
  }

  try {
    const cache = await openCache()
    // A fresh Response is built rather than reusing the consumed one.
    await cache.put(track.url, new Response(new Blob(chunks), { headers: response.headers }))
  } catch (cause) {
    if (isQuotaError(cause)) {
      throw new StorageFullError('设备存储空间不足，无法保存这一集。请先清理已下载的内容。')
    }
    throw cause
  }

  await saveDownload(record)
  return record
}

/** How many tracks of one book are fetched at the same time. */
const BOOK_DOWNLOAD_CONCURRENCY = 3

/**
 * Download every track of a book that is not stored yet.
 *
 * Tracks run a few at a time rather than one after another: a single 20 MB
 * episode over a slow link takes minutes, and waiting for it before starting
 * the next one made a whole book feel serial. The concurrency is bounded so a
 * full book does not open dozens of sockets at once.
 *
 * One failed track does not abandon the rest: the failure is reported and the
 * remaining tracks still get their chance, so a single bad url cannot leave a
 * book half-downloaded with no way forward.
 */
export async function downloadBook(
  book: BookDetail,
  options: DownloadOptions & { onTrack?: (index: number, record: DownloadedTrack) => void } = {},
): Promise<{ downloaded: number; failed: number; error?: Error }> {
  const already = new Set((await loadDownloadsForBook(book.slug)).map((entry) => entry.url))
  const pending = book.tracks
    .map((track, index) => ({ track, index }))
    .filter(({ track }) => !already.has(track.url))

  let downloaded = 0
  let failed = 0
  let error: Error | undefined

  // A shared cursor over `pending`, so each worker takes the next track.
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      if (options.signal?.aborted === true) return
      const position = cursor
      cursor += 1
      if (position >= pending.length) return
      const { track, index } = pending[position]
      try {
        const record = await downloadTrack(book, track, index, options)
        downloaded += 1
        options.onTrack?.(index, record)
      } catch (cause) {
        failed += 1
        if (error === undefined) {
          error = cause instanceof Error ? cause : new Error(String(cause))
        }
      }
    }
  }

  const workers = Math.min(BOOK_DOWNLOAD_CONCURRENCY, Math.max(pending.length, 1))
  await Promise.all(Array.from({ length: workers }, () => worker()))

  return { downloaded, failed, ...(error === undefined ? {} : { error }) }
}

/** Whether one track is already stored. */
export async function isDownloaded(url: string): Promise<boolean> {
  const cache = await openCache()
  return (await cache.match(url)) !== undefined
}

/** Every stored track, newest first. */
export function listDownloads(): Promise<DownloadedTrack[]> {
  return loadDownloads()
}

/** Stored tracks of one book, in track order. */
export function listDownloadsForBook(bookSlug: string): Promise<DownloadedTrack[]> {
  return loadDownloadsForBook(bookSlug)
}

/**
 * Ask the browser to keep this origin's storage.
 * Exempts the origin from Safari's seven-day cleanup. The answer is advisory:
 * a refusal is normal and changes nothing about how the app behaves.
 */
export async function requestPersistence(): Promise<boolean> {
  if (typeof navigator === 'undefined' || navigator.storage?.persist === undefined) return false
  try {
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

export interface StorageUsage {
  /** Bytes this origin occupies, across all storage kinds. */
  usage: number
  /** The browser's current ceiling, which moves with free disk space. */
  quota: number
}

/** Best-effort storage figures; the browser deliberately rounds them. */
export async function storageUsage(): Promise<StorageUsage | undefined> {
  if (typeof navigator === 'undefined' || navigator.storage?.estimate === undefined) return undefined
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate()
    return { usage, quota }
  } catch {
    return undefined
  }
}

/** Drop one stored track. */
export async function removeTrack(url: string): Promise<void> {
  const cache = await openCache()
  await cache.delete(url)
  await deleteDownloadRecord(url)
}

/** Drop every stored track of one book. */
export async function removeBookDownloads(bookSlug: string): Promise<void> {
  const entries = await loadDownloadsForBook(bookSlug)
  const cache = await openCache()
  await Promise.all(entries.map((entry) => cache.delete(entry.url)))
  await deleteDownloadRecordsForBook(bookSlug)
}

/** Drop every stored track. */
export async function removeAllDownloads(): Promise<void> {
  const cache = await openCache()
  const entries = await loadDownloads()
  await Promise.all(entries.map((entry) => cache.delete(entry.url)))
  await deleteAllDownloadRecords()
}

/** Sum of stored track sizes in bytes. */
export function totalDownloadBytes(entries: DownloadedTrack[]): number {
  return entries.reduce((sum, entry) => sum + entry.sizeBytes, 0)
}
