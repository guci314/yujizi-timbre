/**
 * Storage driver: the only place where IndexedDB and Cache Storage are touched.
 *
 * It implements the port the offline grid demands, so the ordering that keeps
 * "bytes stored" and "record indexed" in agreement lives in one auditable spot.
 */

import type { BookCatalogEntry, BookDetail, DownloadedTrack } from '../core/domain'
import type { Progress } from '../core/domain'
import { AUDIO_CACHE } from '../core/audio-cache'
import { fetchTrackBytes } from '../core/downloads'
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
import { classifyDownloadFailure } from '../core/downloads'
import {
  isConsistent,
  reconcile,
  repairDownloads,
  runDownloadEffects,
  initialDownloadContext,
  DOWNLOAD_GRID,
  type DownloadPort,
  type ReconcilePlan,
} from '../pim/offline-grid'
import type { Track } from '../core/domain'
import { step } from '../pim/kernel'

export function persistProgress(progress: Progress): Promise<Progress> {
  return saveProgress(progress)
}

export function readProgress(bookSlug: string): Promise<Progress | undefined> {
  return loadProgress(bookSlug)
}

/* --- Offline catalogue ------------------------------------------------------ */

/** Cache a parsed book so the shelf and its chapter list survive a dead network. */
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

/* --- Download accounting ---------------------------------------------------- */

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

/** Compare the index with the bytes; both directions must be empty. */
export async function auditDownloads(): Promise<ReconcilePlan> {
  const [records, bytes] = await Promise.all([listDownloadRecordKeys(), listAudioCacheKeys()])
  return reconcile(records, bytes)
}

/** Drop drifted entries. Safe to run on every visit to the offline page. */
export async function repairDownloadDrift(): Promise<ReconcilePlan> {
  const [records, bytes] = await Promise.all([listDownloadRecordKeys(), listAudioCacheKeys()])
  const plan = reconcile(records, bytes)
  if (isConsistent(plan)) return plan
  const port: DownloadPort = {
    putBytes: async () => undefined,
    deleteBytes: async (url) => {
      const cache = await caches.open(AUDIO_CACHE)
      await cache.delete(url)
    },
    putRecord: async () => undefined,
    deleteRecord: deleteDownloadRecord,
  }
  await repairDownloads(port, plan)
  return plan
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
      const cache = await caches.open(AUDIO_CACHE)
      await cache.delete(url)
    },
    async putRecord(entry) {
      await saveDownload({ ...record, url: entry.url, sizeBytes: entry.sizeBytes })
    },
    async deleteRecord(url) {
      await deleteDownloadRecord(url)
    },
  }
}

export interface StoredTrack {
  readonly record: DownloadedTrack
}

/**
 * Whole download, driven by the grid.
 *
 * The grid decides the state and the effect order; this adapter supplies the
 * bytes and the two stores. A quota failure surfaces as `StorageFullError`,
 * and a record failure undoes the bytes before the error escapes.
 */
export async function storeTrack(
  book: BookDetail,
  track: Track,
  trackIndex: number,
  onProgress?: (received: number, total: number) => void,
): Promise<DownloadedTrack> {
  const started = step(DOWNLOAD_GRID, initialDownloadContext(track.url), { type: 'E_START_DL' }).ctx
  const { body, sizeBytes, headers } = await fetchTrackBytes(track, {
    onProgress: (progress) => onProgress?.(progress.received, progress.total),
  })

  const succeeded = step(DOWNLOAD_GRID, started, { type: 'E_DL_SUCCESS', sizeBytes })
  const port = createDownloadPort(
    {
      bookSlug: book.slug,
      bookTitle: book.title,
      trackIndex,
      trackName: track.name,
      downloadedAt: Date.now(),
    },
    body,
    headers,
  )

  try {
    await runDownloadEffects(port, succeeded.ctx, succeeded.effects)
  } catch (cause) {
    // The grid already compensated the bytes; hand the listener a sentence.
    throw new Error(classifyDownloadFailure(cause))
  }

  // Caching audio without caching the chapter list is the B3 bug: the book would
  // be unopenable exactly when it is needed. Idempotent, so downloading a single
  // track is enough to make the whole book readable offline.
  await cacheBook(book).catch(() => undefined)

  return {
    url: track.url,
    bookSlug: book.slug,
    bookTitle: book.title,
    trackIndex,
    trackName: track.name,
    sizeBytes,
    downloadedAt: Date.now(),
  }
}

/* Re-exported so callers do not have to know which module owns the model. */
