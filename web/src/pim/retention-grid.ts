/**
 * RetentionGrid：4 状态 × 5 事件 = 20 格。
 *
 * 一条铁律贯穿全表：只有「验明完好」才能入箧；未入箧、留存中、未果，
 * 占用的书箧空间必须恒为零。释出是一步归零，迟到的进度与完好都不敢再言。
 */

import type { Grid } from './kernel'
import {
  RETENTION_EVENTS,
  RETENTION_STATES,
  type RetentionContext,
  type RetentionEvent,
  type RetentionStateId,
} from './retention-model'

type Cell = (ctx: RetentionContext, event: RetentionEvent) => RetentionContext

function cell<T extends RetentionEvent['type']>(
  type: T,
  body: (ctx: RetentionContext, event: Extract<RetentionEvent, { type: T }>) => RetentionContext,
): Cell {
  return (ctx, event) => {
    if (event.type !== type) throw new Error(`格子绑定在 ${type}，却收到 ${event.type}`)
    return body(ctx, event as Extract<RetentionEvent, { type: T }>)
  }
}

const ignore: Cell = (ctx) => ctx

/** 未入箧、已释放、留存未果的共同形态：不占空间、没有进度、没有理由。 */
const empty = (ctx: RetentionContext): RetentionContext => ({
  ...ctx,
  state: 'D0_NOT_KEPT',
  progressPct: 0,
  occupiedSpace: 0,
  failReason: null,
})

export const RETENTION_GRID: Grid<RetentionStateId, RetentionContext, RetentionEvent> = {
  states: RETENTION_STATES,
  events: RETENTION_EVENTS,
  cells: {
    D0_NOT_KEPT: {
      E_REQUEST_KEEP: cell('E_REQUEST_KEEP', (ctx) => ({
        ...ctx,
        state: 'D1_KEEPING',
        progressPct: 0,
        occupiedSpace: 0,
        failReason: null,
      })),
      E_KEEP_PROGRESS: ignore,
      /* 没有请求过的留存，迟到的「完好」不进箧。 */
      E_VERIFIED_COMPLETE: ignore,
      E_KEEP_FAILED: ignore,
      E_RELEASE: ignore,
    },

    D1_KEEPING: {
      /* 防重复连点。 */
      E_REQUEST_KEEP: ignore,
      E_KEEP_PROGRESS: cell('E_KEEP_PROGRESS', (ctx, event) => ({
        ...ctx,
        progressPct: Math.min(100, Math.max(0, Math.round(event.pct))),
      })),
      E_VERIFIED_COMPLETE: cell('E_VERIFIED_COMPLETE', (ctx, event) => {
        const space = Number.isFinite(event.space) ? Math.round(event.space) : 0
        // 空的篇章不算留存；宁可留在留存中，也不能记成已入箧。
        if (space <= 0) return ctx
        return { ...ctx, state: 'D2_KEPT', progressPct: 100, occupiedSpace: space, failReason: null }
      }),
      E_KEEP_FAILED: cell('E_KEEP_FAILED', (ctx, event) => ({
        ...ctx,
        state: 'D3_FAILED',
        progressPct: 0,
        occupiedSpace: 0,
        failReason: event.reason,
      })),
      E_RELEASE: cell('E_RELEASE', (ctx) => empty(ctx)),
    },

    D2_KEPT: {
      E_REQUEST_KEEP: ignore,
      E_KEEP_PROGRESS: ignore,
      E_VERIFIED_COMPLETE: ignore,
      E_KEEP_FAILED: ignore,
      E_RELEASE: cell('E_RELEASE', (ctx) => empty(ctx)),
    },

    D3_FAILED: {
      E_REQUEST_KEEP: cell('E_REQUEST_KEEP', (ctx) => ({
        ...ctx,
        state: 'D1_KEEPING',
        progressPct: 0,
        occupiedSpace: 0,
        failReason: null,
      })),
      E_KEEP_PROGRESS: ignore,
      /* 已判未果，迟到的「完好」绝不静默入箧。 */
      E_VERIFIED_COMPLETE: ignore,
      E_KEEP_FAILED: cell('E_KEEP_FAILED', (ctx, event) => ({ ...ctx, failReason: event.reason })),
      E_RELEASE: cell('E_RELEASE', (ctx) => empty(ctx)),
    },
  },
}

export const RETENTION_CELL_COUNT = RETENTION_STATES.length * RETENTION_EVENTS.length
