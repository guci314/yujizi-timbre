/**
 * 「书箧留存」纯业务模型（PIM）。
 *
 * 离线下载的业务含义只有一句话：把某篇提前收进本机书箧，出门无网也能照常
 * 展卷诵读；不用了再释出，腾出书箧空间。至于怎么收（网络、缓存、临时文件），
 * 是各端书架自己的手艺。
 */

export type RetentionStateId =
  /** 未留存：本篇不在书箧中，仅可在线取用。 */
  | 'D0_NOT_KEPT'
  /** 留存中：正在把本篇收入书箧。 */
  | 'D1_KEEPING'
  /** 已留存：本篇已完好收入书箧。 */
  | 'D2_KEPT'
  /** 留存未果：书源中断、内容残损或书箧已满。 */
  | 'D3_FAILED'

export const RETENTION_STATES: readonly RetentionStateId[] = [
  'D0_NOT_KEPT',
  'D1_KEEPING',
  'D2_KEPT',
  'D3_FAILED',
]

export type KeepFailReason = 'SOURCE_UNREACHABLE' | 'CONTENT_CORRUPTED' | 'SPACE_FULL'

export interface RetentionContext {
  readonly bookId: string
  readonly chapterIndex: number
  readonly state: RetentionStateId
  /** 0..100 */
  readonly progressPct: number
  /** 本篇占用的书箧容量；只有 `D2_KEPT` 允许大于零。单位由各端书架自定。 */
  readonly occupiedSpace: number
  readonly failReason: KeepFailReason | null
}

export function initialRetentionContext(bookId: string, chapterIndex: number): RetentionContext {
  return {
    bookId,
    chapterIndex,
    state: 'D0_NOT_KEPT',
    progressPct: 0,
    occupiedSpace: 0,
    failReason: null,
  }
}

export type RetentionEvent =
  | { readonly type: 'E_REQUEST_KEEP' }
  | { readonly type: 'E_KEEP_PROGRESS'; readonly pct: number }
  | { readonly type: 'E_VERIFIED_COMPLETE'; readonly space: number }
  | { readonly type: 'E_KEEP_FAILED'; readonly reason: KeepFailReason }
  | { readonly type: 'E_RELEASE' }

export const RETENTION_EVENTS: readonly RetentionEvent['type'][] = [
  'E_REQUEST_KEEP',
  'E_KEEP_PROGRESS',
  'E_VERIFIED_COMPLETE',
  'E_KEEP_FAILED',
  'E_RELEASE',
]

export interface RetentionSnapshot {
  readonly state: RetentionStateId
  readonly bookId: string
  readonly chapterIndex: number
  readonly progressPct: number
  readonly occupiedSpace: number
  readonly failReason: KeepFailReason | null
}

export function retentionSnapshot(ctx: RetentionContext): RetentionSnapshot {
  return {
    state: ctx.state,
    bookId: ctx.bookId,
    chapterIndex: ctx.chapterIndex,
    progressPct: ctx.progressPct,
    occupiedSpace: ctx.occupiedSpace,
    failReason: ctx.failReason,
  }
}
