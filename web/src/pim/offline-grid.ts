/**
 * OfflineGrid: one track's download lifecycle, plus the book catalogue that
 * makes the shelf readable with no network (B3).
 *
 * The invariant that matters is accounting: every byte in Cache Storage has
 * exactly one IndexedDB record, and vice versa. That is enforced by the effect
 * order below (bytes first, record second, undo the bytes if the record write
 * fails) and audited by `reconcile`.
 */

import type { Book, BookDetail } from '../core/domain'
import { type Grid, type StepResult } from './kernel'

export type DownloadStateId = 'D0_NOT_DOWNLOADED' | 'D1_DOWNLOADING' | 'D2_STORED' | 'D3_FAILED'

export const DOWNLOAD_STATES: readonly DownloadStateId[] = [
  'D0_NOT_DOWNLOADED',
  'D1_DOWNLOADING',
  'D2_STORED',
  'D3_FAILED',
]

export interface DownloadContext {
  readonly state: DownloadStateId
  readonly url: string
  readonly received: number
  readonly total: number
  readonly sizeBytes: number
  readonly reason: string | null
}

export type DownloadEvent =
  | { readonly type: 'E_START_DL' }
  | { readonly type: 'E_DL_PROGRESS'; readonly received: number; readonly total: number }
  | { readonly type: 'E_DL_SUCCESS'; readonly sizeBytes: number }
  | { readonly type: 'E_DL_FAIL'; readonly reason: string }
  | { readonly type: 'E_REMOVE' }

export const DOWNLOAD_EVENTS: readonly DownloadEvent['type'][] = [
  'E_START_DL',
  'E_DL_PROGRESS',
  'E_DL_SUCCESS',
  'E_DL_FAIL',
  'E_REMOVE',
]

export type DownloadEffect =
  | { readonly type: 'STORE_BYTES' }
  | { readonly type: 'INDEX_RECORD' }
  | { readonly type: 'DROP_BYTES' }
  | { readonly type: 'DROP_RECORD' }
  | { readonly type: 'DROP_PARTIAL' }

type Cell = (ctx: DownloadContext, event: DownloadEvent) => StepResult<DownloadContext, DownloadEffect>

const ignore: Cell = (ctx) => ({ ctx, effects: [] })

function cell<T extends DownloadEvent['type']>(
  type: T,
  body: (ctx: DownloadContext, event: Extract<DownloadEvent, { type: T }>) => StepResult<DownloadContext, DownloadEffect>,
): Cell {
  return (ctx, event) => {
    if (event.type !== type) throw new Error(`格子绑定在 ${type}，却收到 ${event.type}`)
    return body(ctx, event as Extract<DownloadEvent, { type: T }>)
  }
}

export function initialDownloadContext(url: string): DownloadContext {
  return { state: 'D0_NOT_DOWNLOADED', url, received: 0, total: 0, sizeBytes: 0, reason: null }
}

export const DOWNLOAD_GRID: Grid<DownloadStateId, DownloadContext, DownloadEvent, DownloadEffect> = {
  states: DOWNLOAD_STATES,
  events: DOWNLOAD_EVENTS,
  cells: {
    D0_NOT_DOWNLOADED: {
      E_START_DL: cell('E_START_DL', (ctx) => ({
        ctx: { ...ctx, state: 'D1_DOWNLOADING', received: 0, total: 0, sizeBytes: 0, reason: null },
        effects: [],
      })),
      E_DL_PROGRESS: ignore,
      E_DL_SUCCESS: ignore,
      E_DL_FAIL: ignore,
      E_REMOVE: ignore,
    },
    D1_DOWNLOADING: {
      E_START_DL: ignore,
      E_DL_PROGRESS: cell('E_DL_PROGRESS', (ctx, event) => ({
        ctx: { ...ctx, received: event.received, total: event.total },
        effects: [],
      })),
      /* Bytes land first; the record is written second; failure undoes the bytes. */
      E_DL_SUCCESS: cell('E_DL_SUCCESS', (ctx, event) => ({
        ctx: { ...ctx, state: 'D2_STORED', sizeBytes: event.sizeBytes, received: event.sizeBytes, reason: null },
        effects: [{ type: 'STORE_BYTES' }, { type: 'INDEX_RECORD' }],
      })),
      E_DL_FAIL: cell('E_DL_FAIL', (ctx, event) => ({
        ctx: { ...ctx, state: 'D3_FAILED', reason: event.reason, received: 0, total: 0 },
        effects: [{ type: 'DROP_PARTIAL' }],
      })),
      /* Aborted mid-flight: drop whatever half-arrived, and any stale record. */
      E_REMOVE: cell('E_REMOVE', (ctx) => ({
        ctx: { ...ctx, state: 'D0_NOT_DOWNLOADED', received: 0, total: 0, sizeBytes: 0, reason: null },
        effects: [{ type: 'DROP_PARTIAL' }, { type: 'DROP_RECORD' }],
      })),
    },
    D2_STORED: {
      E_START_DL: ignore,
      E_DL_PROGRESS: ignore,
      E_DL_SUCCESS: ignore,
      E_DL_FAIL: ignore,
      E_REMOVE: cell('E_REMOVE', (ctx) => ({
        ctx: { ...ctx, state: 'D0_NOT_DOWNLOADED', received: 0, total: 0, sizeBytes: 0, reason: null },
        effects: [{ type: 'DROP_BYTES' }, { type: 'DROP_RECORD' }],
      })),
    },
    D3_FAILED: {
      E_START_DL: cell('E_START_DL', (ctx) => ({
        ctx: { ...ctx, state: 'D1_DOWNLOADING', received: 0, total: 0, reason: null },
        effects: [],
      })),
      E_DL_PROGRESS: ignore,
      /* A late success after a reported failure still has to be stored atomically. */
      E_DL_SUCCESS: cell('E_DL_SUCCESS', (ctx, event) => ({
        ctx: { ...ctx, state: 'D2_STORED', sizeBytes: event.sizeBytes, received: event.sizeBytes, reason: null },
        effects: [{ type: 'STORE_BYTES' }, { type: 'INDEX_RECORD' }],
      })),
      E_DL_FAIL: ignore,
      E_REMOVE: cell('E_REMOVE', (ctx) => ({
        ctx: { ...ctx, state: 'D0_NOT_DOWNLOADED', received: 0, total: 0, sizeBytes: 0, reason: null },
        effects: [{ type: 'DROP_PARTIAL' }, { type: 'DROP_RECORD' }],
      })),
    },
  },
}

export interface DownloadRecord {
  readonly url: string
  readonly sizeBytes: number
}

/** The only side effects the download grid is allowed to cause. */
export interface DownloadPort {
  putBytes(url: string): Promise<void>
  deleteBytes(url: string): Promise<void>
  putRecord(record: DownloadRecord): Promise<void>
  deleteRecord(url: string): Promise<void>
}

/**
 * Execute download effects in order.
 *
 * `INDEX_RECORD` is compensated: if the database refuses (quota, quota during
 * commit, a closed connection), the bytes just written are deleted before the
 * error propagates. Without that, I6 fails silently and a later re-download
 * says "already stored" while playback finds nothing.
 */
export async function runDownloadEffects(
  port: DownloadPort,
  ctx: DownloadContext,
  effects: readonly DownloadEffect[],
): Promise<void> {
  for (const effect of effects) {
    switch (effect.type) {
      case 'STORE_BYTES':
        await port.putBytes(ctx.url)
        break
      case 'INDEX_RECORD':
        try {
          await port.putRecord({ url: ctx.url, sizeBytes: ctx.sizeBytes })
        } catch (cause) {
          await port.deleteBytes(ctx.url).catch(() => undefined)
          throw cause
        }
        break
      case 'DROP_BYTES':
        await port.deleteBytes(ctx.url)
        break
      case 'DROP_RECORD':
        await port.deleteRecord(ctx.url)
        break
      case 'DROP_PARTIAL':
        await port.deleteBytes(ctx.url).catch(() => undefined)
        break
    }
  }
}

export interface ReconcilePlan {
  /** IndexedDB records with no bytes behind them. */
  readonly danglingRecords: readonly string[]
  /** Cached bytes with no record in front of them. */
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

/** Repair both directions; after this the two stores agree. */
export async function repairDownloads(port: DownloadPort, plan: ReconcilePlan): Promise<void> {
  for (const url of plan.danglingRecords) await port.deleteRecord(url)
  for (const url of plan.orphanBytes) await port.deleteBytes(url)
}

/* --- Offline catalogue (B3) -------------------------------------------------
 * Without this table the shelf needs the network to render, so a downloaded
 * book becomes unopenable exactly when it is needed most.
 */

export interface CatalogEntry {
  readonly slug: string
  readonly title: string
  readonly pageUrl: string
  readonly tracks: BookDetail['tracks']
  readonly updatedAt: number
}

export function catalogEntryFrom(book: BookDetail, now: number): CatalogEntry {
  return {
    slug: book.slug,
    title: book.title,
    pageUrl: book.pageUrl,
    tracks: book.tracks,
    updatedAt: now,
  }
}

/**
 * Merge the remote list with the cached one.
 * Remote wins for order and titles; cached-only books are appended so a book
 * the site dropped (or that we cannot reach) stays reachable offline.
 */
export function mergeBookList(remote: readonly Book[], cached: readonly CatalogEntry[]): Book[] {
  const merged: Book[] = []
  const seen = new Set<string>()
  for (const book of remote) {
    if (seen.has(book.slug)) continue
    seen.add(book.slug)
    merged.push(book)
  }
  for (const entry of [...cached].sort((left, right) => right.updatedAt - left.updatedAt)) {
    if (seen.has(entry.slug)) continue
    seen.add(entry.slug)
    merged.push({ slug: entry.slug, title: entry.title, pageUrl: entry.pageUrl })
  }
  return merged
}

/** Rebuild a `BookDetail` from the catalogue when the network is gone. */
export function detailFromCatalog(entry: CatalogEntry): BookDetail {
  return {
    slug: entry.slug,
    title: entry.title,
    pageUrl: entry.pageUrl,
    tracks: entry.tracks,
  }
}
