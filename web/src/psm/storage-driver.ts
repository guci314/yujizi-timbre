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
  expectedIntegrityFor,
  verifyBytes,
  type AudioIntegrity,
} from '../core/integrity'
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

/** The two deletions a repair may need; nothing else is ever written. */
function createRepairPort(): DownloadPort {
  return {
    putBytes: async () => undefined,
    deleteBytes: async (url) => {
      const cache = await caches.open(AUDIO_CACHE)
      await cache.delete(url)
    },
    putRecord: async () => undefined,
    deleteRecord: deleteDownloadRecord,
  }
}

/** Drop drifted entries. Safe to run on every visit to the offline page. */
export async function repairDownloadDrift(): Promise<ReconcilePlan> {
  const [records, bytes] = await Promise.all([listDownloadRecordKeys(), listAudioCacheKeys()])
  const plan = reconcile(records, bytes)
  if (isConsistent(plan)) return plan
  await repairDownloads(createRepairPort(), plan)
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
  const started = step(DOWNLOAD_GRID, initialDownloadContext(track.url), { type: 'E_START_DL' })

  try {
    // `fetchTrackBytes` verifies length and SHA-256 before returning, so nothing
    // below this line can ever see a truncated or tampered body.
    const { body, sizeBytes, headers, sha256 } = await fetchTrackBytes(track, {
      onProgress: (progress) => onProgress?.(progress.received, progress.total),
    })

    const succeeded = step(DOWNLOAD_GRID, started.ctx, { type: 'E_DL_SUCCESS', sizeBytes })
    const port = createDownloadPort(
      {
        bookSlug: book.slug,
        bookTitle: book.title,
        trackIndex,
        trackName: track.name,
        downloadedAt: Date.now(),
        sha256,
      },
      body,
      headers,
    )

    await runDownloadEffects(port, succeeded.ctx, succeeded.effects)

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
      sha256,
    }
  } catch (cause) {
    const reason = classifyDownloadFailure(cause)
    // The grid's failure cell asks for a partial cleanup; a verification failure
    // happens before the write, but a stale byte entry from an older attempt must
    // not survive a failed one.
    const failed = step(DOWNLOAD_GRID, started.ctx, { type: 'E_DL_FAIL', reason })
    if (failed.effects.some((effect) => effect.type === 'DROP_PARTIAL')) {
      await deleteAudioBytes(track.url).catch(() => undefined)
    }
    throw new Error(reason)
  }
}

async function deleteAudioBytes(url: string): Promise<void> {
  if (typeof caches === 'undefined') return
  const cache = await caches.open(AUDIO_CACHE)
  await cache.delete(url)
}

/* Re-exported so callers do not have to know which module owns the model. */

/**
 * How many legacy tracks one visit may hash.
 *
 * A listener upgrading with 100+ episodes should not watch the offline page
 * hashing 4 GB on first open. The batch continues on the next visit (or on a
 * manual tap), and every verified track is stamped so the work never repeats.
 */
export const AUDIT_BATCH_SIZE = 15

export interface StoredAuditResult {
  /** Records with no bytes behind them, before repair. */
  readonly danglingRecords: number
  /** Cached bytes with no record in front of them, before repair. */
  readonly orphanBytes: number
  /** Records already carrying a trustworthy marker; nothing was read. */
  readonly alreadyVerified: number
  /** Legacy records actually read and hashed this run. */
  readonly checked: number
  /** Records deleted because their bytes were missing, truncated or tampered. */
  readonly cleaned: number
  /** Legacy records left for the next visit because this batch hit its cap. */
  readonly remaining: number
}

export interface StoredAuditOptions {
  /** Injectable for tests; production uses the shipped manifest. */
  resolveExpected?: (url: string) => Promise<AudioIntegrity | undefined>
  /** Fires before each track in this batch so the page can show "3/15". */
  onProgress?: (done: number, total: number) => void
  /** Cap for this call; defaults to {@link AUDIT_BATCH_SIZE}. */
  maxChecks?: number
  /**
   * Urls with a download in flight.
   *
   * `storeTrack` writes the bytes before the record, so a download caught
   * mid-flight looks exactly like drift from the outside. Deleting it would
   * break a track that was about to succeed, so these are left alone.
   */
  skipUrls?: Iterable<string>
}

/**
 * Lazy verification of tracks downloaded by older versions.
 *
 * Downloads now stamp `sha256` on the record, so the common path reads nothing.
 * Records without a trustworthy marker (written before that stamp existed, or
 * against an older manifest) are checked once, **strictly one at a time**: a
 * listener may have ten 80 MB episodes, and hashing them concurrently would
 * exhaust an iPad's memory long before it finished.
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
    await repairDownloads(createRepairPort(), plan)
    records = (await loadDownloads()).filter((record) => !skip.has(record.url))
  }

  const targets: Array<{ record: DownloadedTrack; expected: AudioIntegrity | undefined }> = []
  let alreadyVerified = 0
  for (const record of records) {
    const expected = await resolveExpected(record.url)
    // A stamp is trustworthy while it matches the manifest; a missing or stale
    // stamp (the manifest may have been regenerated) means "check this one".
    if (record.sha256 !== undefined && (expected === undefined || record.sha256 === expected.sha256)) {
      alreadyVerified += 1
      continue
    }
    targets.push({ record, expected })
  }

  // Smallest first: a batch of 15 short tracks finishes fast, instead of
  // starting with a single 88 MB episode and leaving everything else pending.
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

    // Fast screen: the recorded size already contradicts the manifest, so the
    // bytes need not even be read.
    if (expected !== undefined && record.sizeBytes > 0 && record.sizeBytes !== expected.size) {
      await drop(record.url)
      cleaned += 1
      continue
    }

    const response = await cache.match(record.url).catch(() => undefined)
    if (response === undefined) {
      // Bytes vanished (Safari evicted them): the record is a lie, drop it.
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

    // Stamp the record so the next visit skips it. A failed write is not fatal:
    // the bytes are good, and the next audit will simply check this one again.
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
