/**
 * 「玉机子听书」纯业务模型（PIM）。
 *
 * 这一层只认识：经书、篇章、位置（秒）、语速、睡眠香、留存。
 * 不认识浏览器、播放器、数据库、网络、文件。换到 Android 或纸笔上都成立。
 */

export type ListeningStateId =
  /** 未展卷：尚未选定任何经书。 */
  | 'S0_IDLE'
  /** 展卷静置：已翻到某书某章某秒，当前静默。 */
  | 'S1_PAUSED'
  /** 诵读中：声音流淌，播放头随时间推进，睡眠倒计时仅在此状态消减。 */
  | 'S2_PLAYING'
  /** 睡眠止息：因睡眠定时到点或本章诵毕而自动止息，除非听众主动点播，绝不自鸣。 */
  | 'S3_SLEEP_STOPPED'

export const LISTENING_STATES: readonly ListeningStateId[] = [
  'S0_IDLE',
  'S1_PAUSED',
  'S2_PLAYING',
  'S3_SLEEP_STOPPED',
]

/** 一篇。时长未知时为 0，待诵读中获知后由 `E_SECOND_ELAPSED` 补上。 */
export interface ChapterSpec {
  readonly index: number
  readonly title: string
  readonly durationSec: number
}

/** 一卷。纯业务标识只有 `id` 与篇目。 */
export interface BookSpec {
  readonly id: string
  readonly title: string
  readonly chapters: readonly ChapterSpec[]
}

export type SleepMode = 'off' | 'minutes' | 'end-of-chapter'

export type SleepOption =
  | { readonly kind: 'minutes'; readonly minutes: number }
  | { readonly kind: 'end-of-chapter' }

export interface ListeningContext {
  readonly state: ListeningStateId
  readonly book: BookSpec | null
  readonly chapterIndex: number
  /** 当前权威播放头（秒）。 */
  readonly positionSec: number
  /** 语速：0.75x ~ 2x。 */
  readonly speed: number
  readonly sleepMode: SleepMode
  readonly sleepRemainingSec: number
}

/** 展卷接续时回退三秒，让听众重新回到当时的语境。 */
export const RESUME_REWIND_SECONDS = 3

export const PLAYBACK_SPEEDS: readonly number[] = [0.75, 1, 1.25, 1.5, 1.75, 2]

export const SKIP_SECONDS = 30

export const SLEEP_OPTIONS: readonly SleepOption[] = [
  { kind: 'minutes', minutes: 10 },
  { kind: 'minutes', minutes: 20 },
  { kind: 'minutes', minutes: 30 },
  { kind: 'minutes', minutes: 45 },
  { kind: 'minutes', minutes: 60 },
  { kind: 'minutes', minutes: 90 },
  { kind: 'end-of-chapter' },
]

export function initialListeningContext(): ListeningContext {
  return {
    state: 'S0_IDLE',
    book: null,
    chapterIndex: 0,
    positionSec: 0,
    speed: 1,
    sleepMode: 'off',
    sleepRemainingSec: 0,
  }
}

export type ListeningEvent =
  /** 展卷预置：翻到上次位置并回退三秒。仅在未展卷时生效。 */
  | {
      readonly type: 'E_OPEN_BOOK'
      readonly book: BookSpec
      readonly savedChapter: number
      readonly savedSec: number
    }
  /** 点播指定位置：选章或点书签，精准跳秒，不回退。 */
  | {
      readonly type: 'E_JUMP_AND_PLAY'
      readonly book: BookSpec
      readonly chapterIndex: number
      readonly startSec: number
    }
  /** 开讲 / 暂停。系统打断（来电、拔耳机）也以本事件收敛回静置。 */
  | { readonly type: 'E_TOGGLE_PLAY' }
  /** 移步：拖动或快进快退。 */
  | { readonly type: 'E_SEEK'; readonly targetSec: number; readonly chapterDurationSec?: number }
  | { readonly type: 'E_NEXT_CHAPTER' }
  | { readonly type: 'E_PREV_CHAPTER' }
  /** 调语速 / 设睡眠香。 */
  | {
      readonly type: 'E_SET_PREF'
      readonly speed?: number
      readonly sleepOption?: SleepOption | null
    }
  /** 诵读时间流逝一秒：推进播放头，判断章尾续章与睡眠止息。 */
  | {
      readonly type: 'E_SECOND_ELAPSED'
      readonly currentPositionSec?: number
      readonly chapterDurationSec?: number
    }

export const LISTENING_EVENTS: readonly ListeningEvent['type'][] = [
  'E_OPEN_BOOK',
  'E_JUMP_AND_PLAY',
  'E_TOGGLE_PLAY',
  'E_SEEK',
  'E_NEXT_CHAPTER',
  'E_PREV_CHAPTER',
  'E_SET_PREF',
  'E_SECOND_ELAPSED',
]

export function clampTime(seconds: number, durationSec: number): number {
  if (!Number.isFinite(seconds)) return 0
  const positive = Math.max(0, seconds)
  return durationSec > 0 ? Math.min(positive, durationSec) : positive
}

/** 自然接续回退三秒；书签与选章走 `E_JUMP_AND_PLAY`，不回退。 */
export function resumePosition(savedSec: number, chapterDurationSec = 0): number {
  if (!Number.isFinite(savedSec) || savedSec <= 0) return 0
  const rewound = Math.max(0, savedSec - RESUME_REWIND_SECONDS)
  if (!Number.isFinite(chapterDurationSec) || chapterDurationSec <= 0) return rewound
  return Math.min(rewound, Math.max(0, chapterDurationSec - 1))
}

export function clampChapter(book: BookSpec, chapterIndex: number): number {
  if (book.chapters.length === 0) return 0
  return Math.min(Math.max(0, Math.trunc(chapterIndex)), book.chapters.length - 1)
}

export function currentChapter(ctx: ListeningContext): ChapterSpec | null {
  if (ctx.book === null) return null
  return ctx.book.chapters[ctx.chapterIndex] ?? null
}

export function currentChapterDuration(ctx: ListeningContext): number {
  return currentChapter(ctx)?.durationSec ?? 0
}

export function hasNextChapter(ctx: ListeningContext): boolean {
  return ctx.book !== null && ctx.chapterIndex + 1 < ctx.book.chapters.length
}

export function hasPreviousChapter(ctx: ListeningContext): boolean {
  return ctx.book !== null && ctx.chapterIndex > 0
}

/** 把"这一章有多长"记进书里；时长未知(0)时不覆盖已知值。 */
export function withChapterDuration(ctx: ListeningContext, durationSec: number): ListeningContext {
  if (ctx.book === null) return ctx
  if (!Number.isFinite(durationSec) || durationSec <= 0) return ctx
  const chapter = ctx.book.chapters[ctx.chapterIndex]
  if (chapter === undefined || chapter.durationSec === durationSec) return ctx
  const chapters = ctx.book.chapters.map((entry, index) =>
    index === ctx.chapterIndex ? { ...entry, durationSec } : entry,
  )
  return { ...ctx, book: { ...ctx.book, chapters } }
}

/** 黄金考卷用的纯业务快照：跨语言逐字段比对。 */
export interface ListeningSnapshot {
  readonly state: ListeningStateId
  readonly bookId: string | null
  readonly chapterIndex: number
  readonly positionSec: number
  readonly speed: number
  readonly sleepMode: SleepMode
  readonly sleepRemainingSec: number
  readonly chapterDurationSec: number
}

export function listeningSnapshot(ctx: ListeningContext): ListeningSnapshot {
  return {
    state: ctx.state,
    bookId: ctx.book?.id ?? null,
    chapterIndex: ctx.chapterIndex,
    positionSec: ctx.positionSec,
    speed: ctx.speed,
    sleepMode: ctx.sleepMode,
    sleepRemainingSec: ctx.sleepRemainingSec,
    chapterDurationSec: currentChapterDuration(ctx),
  }
}
