/**
 * ListeningGrid：4 状态 × 8 事件 = 32 格。
 *
 * 整张表就是「听书」这件事的全部规矩。没有一格提到播放器、浏览器或数据库。
 */

import type { Grid } from './kernel'
import {
  LISTENING_EVENTS,
  LISTENING_STATES,
  type ListeningContext,
  type ListeningEvent,
  type ListeningStateId,
} from './listening-model'
import {
  actJumpAndPlay,
  actNextChapter,
  actOpenBook,
  actPreviousChapter,
  actSecondElapsed,
  actSeek,
  actSetPreference,
  actTogglePlay,
} from './listening-slots'

type Cell = (ctx: ListeningContext, event: ListeningEvent) => ListeningContext

/** 绑定到一种事件，顺带把载荷类型收窄；运行时再兜一次底。 */
function cell<T extends ListeningEvent['type']>(
  type: T,
  body: (ctx: ListeningContext, event: Extract<ListeningEvent, { type: T }>) => ListeningContext,
): Cell {
  return (ctx, event) => {
    if (event.type !== type) throw new Error(`格子绑定在 ${type}，却收到 ${event.type}`)
    return body(ctx, event as Extract<ListeningEvent, { type: T }>)
  }
}

/** 一格明确写下的「不理」，而不是漏写。 */
const ignore: Cell = (ctx) => ctx

export const LISTENING_GRID: Grid<ListeningStateId, ListeningContext, ListeningEvent> = {
  states: LISTENING_STATES,
  events: LISTENING_EVENTS,
  cells: {
    S0_IDLE: {
      E_OPEN_BOOK: cell('E_OPEN_BOOK', (ctx, event) =>
        actOpenBook(ctx, event.book, event.savedChapter, event.savedSec),
      ),
      E_JUMP_AND_PLAY: cell('E_JUMP_AND_PLAY', (ctx, event) =>
        actJumpAndPlay(ctx, event.book, event.chapterIndex, event.startSec),
      ),
      E_TOGGLE_PLAY: ignore,
      E_SEEK: ignore,
      E_NEXT_CHAPTER: ignore,
      E_PREV_CHAPTER: ignore,
      E_SET_PREF: cell('E_SET_PREF', (ctx, event) => actSetPreference(ctx, event.speed, event.sleepOption)),
      E_SECOND_ELAPSED: ignore,
    },

    S1_PAUSED: {
      /* 翻看别书目录，绝不换掉当前展卷。 */
      E_OPEN_BOOK: ignore,
      E_JUMP_AND_PLAY: cell('E_JUMP_AND_PLAY', (ctx, event) =>
        actJumpAndPlay(ctx, event.book, event.chapterIndex, event.startSec),
      ),
      E_TOGGLE_PLAY: cell('E_TOGGLE_PLAY', (ctx) => actTogglePlay(ctx)),
      E_SEEK: cell('E_SEEK', (ctx, event) => actSeek(ctx, event.targetSec, event.chapterDurationSec)),
      E_NEXT_CHAPTER: cell('E_NEXT_CHAPTER', (ctx) => actNextChapter(ctx)),
      E_PREV_CHAPTER: cell('E_PREV_CHAPTER', (ctx) => actPreviousChapter(ctx)),
      E_SET_PREF: cell('E_SET_PREF', (ctx, event) => actSetPreference(ctx, event.speed, event.sleepOption)),
      /* 静置期进度与睡眠倒计时天然冻结。 */
      E_SECOND_ELAPSED: ignore,
    },

    S2_PLAYING: {
      /* 正在诵读时翻别书目录，绝不掐断。 */
      E_OPEN_BOOK: ignore,
      E_JUMP_AND_PLAY: cell('E_JUMP_AND_PLAY', (ctx, event) =>
        actJumpAndPlay(ctx, event.book, event.chapterIndex, event.startSec),
      ),
      E_TOGGLE_PLAY: cell('E_TOGGLE_PLAY', (ctx) => actTogglePlay(ctx)),
      E_SEEK: cell('E_SEEK', (ctx, event) => actSeek(ctx, event.targetSec, event.chapterDurationSec)),
      E_NEXT_CHAPTER: cell('E_NEXT_CHAPTER', (ctx) => actNextChapter(ctx)),
      E_PREV_CHAPTER: cell('E_PREV_CHAPTER', (ctx) => actPreviousChapter(ctx)),
      E_SET_PREF: cell('E_SET_PREF', (ctx, event) => actSetPreference(ctx, event.speed, event.sleepOption)),
      E_SECOND_ELAPSED: cell('E_SECOND_ELAPSED', (ctx, event) =>
        actSecondElapsed(ctx, event.currentPositionSec, event.chapterDurationSec),
      ),
    },

    S3_SLEEP_STOPPED: {
      E_OPEN_BOOK: ignore,
      E_JUMP_AND_PLAY: cell('E_JUMP_AND_PLAY', (ctx, event) =>
        actJumpAndPlay(ctx, event.book, event.chapterIndex, event.startSec),
      ),
      E_TOGGLE_PLAY: cell('E_TOGGLE_PLAY', (ctx) => actTogglePlay(ctx)),
      E_SEEK: cell('E_SEEK', (ctx, event) => actSeek(ctx, event.targetSec, event.chapterDurationSec)),
      E_NEXT_CHAPTER: cell('E_NEXT_CHAPTER', (ctx) => actNextChapter(ctx)),
      E_PREV_CHAPTER: cell('E_PREV_CHAPTER', (ctx) => actPreviousChapter(ctx)),
      E_SET_PREF: cell('E_SET_PREF', (ctx, event) => actSetPreference(ctx, event.speed, event.sleepOption)),
      /* 半夜的「时间流逝」不得让已止息的书自己诈尸。 */
      E_SECOND_ELAPSED: ignore,
    },
  },
}

export const LISTENING_CELL_COUNT = LISTENING_STATES.length * LISTENING_EVENTS.length
