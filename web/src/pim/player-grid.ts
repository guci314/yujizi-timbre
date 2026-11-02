/**
 * PlayerGrid: the 7 x 15 state/event table.
 *
 * Read this file top to bottom as the specification of the player. Every cell
 * is explicit, including the ones that ignore the event; an ignored event is a
 * decision, not an accident.
 *
 * The historical bugs map onto cells:
 *  - B1 bookmark hop       -> E_PLAY_AT carries trackIndex *and* startTime
 *  - B2 viewing kills play -> E_PREPARE_BOOK is ignored outside S0_IDLE
 *  - B4 lost seek          -> S1/S2 stage the seek, metadata commits it
 *  - B5 sleep keeps ticking-> E_TICK_1S only decrements in S4_PLAYING
 *  - B6 lost tail progress -> every track switch emits PERSIST_PROGRESS first
 *  - B7 no recovery        -> E_AUDIO_ERROR retries, then parks in S6_ERROR
 */

import type { Grid } from './kernel'
import {
  PLAYER_EVENTS,
  PLAYER_STATES,
  type PlayerContext,
  type PlayerEffect,
  type PlayerEvent,
  type PlayerStateId,
} from './player-model'
import {
  actBookFinished,
  actCancelPlay,
  actCommitMetaLoading,
  actCommitMetaPaused,
  actCommitMetaPlaying,
  actExternalPlay,
  actImmediateSeek,
  actImmediateSeekPaused,
  actLoadAndPlay,
  actMarkError,
  actNextTrack,
  actPauseAndSave,
  actPauseExternal,
  actPlayBlocked,
  actPlayStarted,
  actPrepareBook,
  actPreviousTrack,
  actReloadAt,
  actRequestPlay,
  actResumePlay,
  actRetry,
  actRetryFromError,
  actSetRate,
  actSetSleep,
  actSleepStop,
  actStageSeek,
  actTickSleep,
  actTimeUpdate,
  actUpdateDuration,
  actWakeAndPlay,
  canRetry,
  hasNextTrack,
  sleepIsDue,
} from './player-slots'
import type { StepResult } from './kernel'

type Cell = (ctx: PlayerContext, event: PlayerEvent) => StepResult<PlayerContext, PlayerEffect>

/** Bind a cell to one event type so the payload is narrowed, with a runtime guard. */
function cell<T extends PlayerEvent['type']>(
  type: T,
  body: (ctx: PlayerContext, event: Extract<PlayerEvent, { type: T }>) => StepResult<PlayerContext, PlayerEffect>,
): Cell {
  return (ctx, event) => {
    if (event.type !== type) throw new Error(`格子绑定在 ${type}，却收到 ${event.type}`)
    return body(ctx, event as Extract<PlayerEvent, { type: T }>)
  }
}

const ignore: Cell = (ctx) => ({ ctx, effects: [] })

export const PLAYER_GRID: Grid<PlayerStateId, PlayerContext, PlayerEvent, PlayerEffect> = {
  states: PLAYER_STATES,
  events: PLAYER_EVENTS,
  cells: {
    S0_IDLE: {
      E_PREPARE_BOOK: cell('E_PREPARE_BOOK', (ctx, event) =>
        actPrepareBook(ctx, event.book, event.trackIndex, event.savedTime),
      ),
      E_PLAY_AT: cell('E_PLAY_AT', (ctx, event) =>
        actLoadAndPlay(ctx, event.book, event.trackIndex, event.startTime),
      ),
      E_TOGGLE: ignore,
      E_SEEK: ignore,
      E_NEXT: ignore,
      E_PREV: ignore,
      E_SET_RATE: ignore,
      E_SET_SLEEP: ignore,
      E_META_LOADED: ignore,
      E_TIME_UPDATE: ignore,
      E_PLAY_STARTED: ignore,
      E_PLAY_BLOCKED: ignore,
      E_PAUSE_EXTERNAL: ignore,
      E_AUDIO_ENDED: ignore,
      E_AUDIO_ERROR: ignore,
      E_TICK_1S: ignore,
    },

    S1_LOADING_PAUSED: {
      /* Another book's detail page must never disturb the loaded one (B2). */
      E_PREPARE_BOOK: ignore,
      E_PLAY_AT: cell('E_PLAY_AT', (ctx, event) =>
        actLoadAndPlay(ctx, event.book, event.trackIndex, event.startTime),
      ),
      E_TOGGLE: cell('E_TOGGLE', (ctx) => actRequestPlay(ctx)),
      E_SEEK: cell('E_SEEK', (ctx, event) => actStageSeek(ctx, event.time)),
      E_NEXT: cell('E_NEXT', (ctx) => actNextTrack(ctx)),
      E_PREV: cell('E_PREV', (ctx) => actPreviousTrack(ctx)),
      E_SET_RATE: cell('E_SET_RATE', (ctx, event) => actSetRate(ctx, event.rate)),
      E_SET_SLEEP: cell('E_SET_SLEEP', (ctx, event) => actSetSleep(ctx, event.option)),
      E_META_LOADED: cell('E_META_LOADED', (ctx, event) => actCommitMetaPaused(ctx, event.duration)),
      E_TIME_UPDATE: ignore,
      E_PLAY_STARTED: cell('E_PLAY_STARTED', (ctx) => actExternalPlay(ctx)),
      E_PLAY_BLOCKED: ignore,
      E_PAUSE_EXTERNAL: ignore,
      E_AUDIO_ENDED: ignore,
      E_AUDIO_ERROR: cell('E_AUDIO_ERROR', (ctx, event) => actMarkError(ctx, event.reason)),
      E_TICK_1S: ignore,
    },

    S2_LOADING_PLAY: {
      E_PREPARE_BOOK: ignore,
      E_PLAY_AT: cell('E_PLAY_AT', (ctx, event) =>
        actLoadAndPlay(ctx, event.book, event.trackIndex, event.startTime),
      ),
      E_TOGGLE: cell('E_TOGGLE', (ctx) => actCancelPlay(ctx)),
      E_SEEK: cell('E_SEEK', (ctx, event) => actStageSeek(ctx, event.time)),
      E_NEXT: cell('E_NEXT', (ctx) => actNextTrack(ctx)),
      E_PREV: cell('E_PREV', (ctx) => actPreviousTrack(ctx)),
      E_SET_RATE: cell('E_SET_RATE', (ctx, event) => actSetRate(ctx, event.rate)),
      E_SET_SLEEP: cell('E_SET_SLEEP', (ctx, event) => actSetSleep(ctx, event.option)),
      E_META_LOADED: cell('E_META_LOADED', (ctx, event) => actCommitMetaLoading(ctx, event.duration)),
      /* Not evidence of playback: a paused element seeking also fires timeupdate. */
      E_TIME_UPDATE: ignore,
      E_PLAY_STARTED: cell('E_PLAY_STARTED', (ctx) => actPlayStarted(ctx)),
      /* No user activation (iOS refuses autoplay after an async navigation): settle
         into a ready-but-paused state at the requested position, do not hang in S2. */
      E_PLAY_BLOCKED: cell('E_PLAY_BLOCKED', (ctx) => actPlayBlocked(ctx)),
      /* Deliberate: a pause fired while replacing `src` must not cancel the intent. */
      E_PAUSE_EXTERNAL: ignore,
      E_AUDIO_ENDED: ignore,
      E_AUDIO_ERROR: cell('E_AUDIO_ERROR', (ctx, event) =>
        canRetry(ctx) ? actRetry(ctx, event.reason) : actMarkError(ctx, event.reason),
      ),
      E_TICK_1S: ignore,
    },

    S3_READY_PAUSED: {
      E_PREPARE_BOOK: ignore,
      E_PLAY_AT: cell('E_PLAY_AT', (ctx, event) =>
        actLoadAndPlay(ctx, event.book, event.trackIndex, event.startTime),
      ),
      E_TOGGLE: cell('E_TOGGLE', (ctx) => actResumePlay(ctx)),
      E_SEEK: cell('E_SEEK', (ctx, event) => actImmediateSeek(ctx, event.time)),
      E_NEXT: cell('E_NEXT', (ctx) => actNextTrack(ctx)),
      E_PREV: cell('E_PREV', (ctx) => actPreviousTrack(ctx)),
      E_SET_RATE: cell('E_SET_RATE', (ctx, event) => actSetRate(ctx, event.rate)),
      E_SET_SLEEP: cell('E_SET_SLEEP', (ctx, event) => actSetSleep(ctx, event.option)),
      E_META_LOADED: cell('E_META_LOADED', (ctx, event) => actUpdateDuration(ctx, event.duration)),
      E_TIME_UPDATE: ignore,
      E_PLAY_STARTED: cell('E_PLAY_STARTED', (ctx) => actExternalPlay(ctx)),
      E_PLAY_BLOCKED: ignore,
      E_PAUSE_EXTERNAL: ignore,
      E_AUDIO_ENDED: ignore,
      E_AUDIO_ERROR: cell('E_AUDIO_ERROR', (ctx, event) => actMarkError(ctx, event.reason)),
      E_TICK_1S: ignore,
    },

    S4_PLAYING: {
      E_PREPARE_BOOK: ignore,
      E_PLAY_AT: cell('E_PLAY_AT', (ctx, event) =>
        actLoadAndPlay(ctx, event.book, event.trackIndex, event.startTime),
      ),
      E_TOGGLE: cell('E_TOGGLE', (ctx) => actPauseAndSave(ctx)),
      E_SEEK: cell('E_SEEK', (ctx, event) => actImmediateSeek(ctx, event.time)),
      E_NEXT: cell('E_NEXT', (ctx) => actNextTrack(ctx)),
      E_PREV: cell('E_PREV', (ctx) => actPreviousTrack(ctx)),
      E_SET_RATE: cell('E_SET_RATE', (ctx, event) => actSetRate(ctx, event.rate)),
      E_SET_SLEEP: cell('E_SET_SLEEP', (ctx, event) => actSetSleep(ctx, event.option)),
      E_META_LOADED: cell('E_META_LOADED', (ctx, event) => actCommitMetaPlaying(ctx, event.duration)),
      E_TIME_UPDATE: cell('E_TIME_UPDATE', (ctx, event) => actTimeUpdate(ctx, event.time)),
      E_PLAY_STARTED: cell('E_PLAY_STARTED', (ctx) => ({ ctx, effects: [{ type: 'MEDIA_SESSION_UPDATE' }] })),
      E_PLAY_BLOCKED: ignore,
      E_PAUSE_EXTERNAL: cell('E_PAUSE_EXTERNAL', (ctx) => actPauseExternal(ctx)),
      E_AUDIO_ENDED: cell('E_AUDIO_ENDED', (ctx) => {
        if (ctx.sleepMode === 'end-of-chapter') return actSleepStop(ctx)
        if (hasNextTrack(ctx)) return actNextTrack(ctx)
        return actBookFinished(ctx)
      }),
      E_AUDIO_ERROR: cell('E_AUDIO_ERROR', (ctx, event) =>
        canRetry(ctx) ? actRetry(ctx, event.reason) : actMarkError(ctx, event.reason),
      ),
      E_TICK_1S: cell('E_TICK_1S', (ctx) => {
        if (ctx.sleepMode !== 'minutes') return { ctx, effects: [] }
        return sleepIsDue(ctx) ? actSleepStop(ctx) : actTickSleep(ctx)
      }),
    },

    S5_SLEEP_STOPPED: {
      E_PREPARE_BOOK: ignore,
      E_PLAY_AT: cell('E_PLAY_AT', (ctx, event) =>
        actLoadAndPlay(ctx, event.book, event.trackIndex, event.startTime),
      ),
      /* The one and only way out, and it must be a real tap (I2). */
      E_TOGGLE: cell('E_TOGGLE', (ctx) => actWakeAndPlay(ctx)),
      E_SEEK: cell('E_SEEK', (ctx, event) => actImmediateSeekPaused(ctx, event.time)),
      E_NEXT: cell('E_NEXT', (ctx) => actNextTrack(ctx)),
      E_PREV: cell('E_PREV', (ctx) => actPreviousTrack(ctx)),
      E_SET_RATE: cell('E_SET_RATE', (ctx, event) => actSetRate(ctx, event.rate)),
      E_SET_SLEEP: cell('E_SET_SLEEP', (ctx, event) => actSetSleep(ctx, event.option)),
      /* A late `ended` / `timeupdate` must not resurrect the chain. */
      E_META_LOADED: ignore,
      E_TIME_UPDATE: ignore,
      E_PLAY_STARTED: ignore,
      E_PLAY_BLOCKED: ignore,
      E_PAUSE_EXTERNAL: ignore,
      E_AUDIO_ENDED: ignore,
      E_AUDIO_ERROR: ignore,
      E_TICK_1S: ignore,
    },

    S6_ERROR: {
      E_PREPARE_BOOK: ignore,
      E_PLAY_AT: cell('E_PLAY_AT', (ctx, event) =>
        actLoadAndPlay(ctx, event.book, event.trackIndex, event.startTime),
      ),
      E_TOGGLE: cell('E_TOGGLE', (ctx) => actRetryFromError(ctx)),
      E_SEEK: cell('E_SEEK', (ctx, event) => actReloadAt(ctx, event.time)),
      E_NEXT: cell('E_NEXT', (ctx) => actNextTrack(ctx)),
      E_PREV: cell('E_PREV', (ctx) => actPreviousTrack(ctx)),
      E_SET_RATE: cell('E_SET_RATE', (ctx, event) => actSetRate(ctx, event.rate)),
      E_SET_SLEEP: cell('E_SET_SLEEP', (ctx, event) => actSetSleep(ctx, event.option)),
      /* A broken source cannot report metadata; ignore rather than loop. */
      E_META_LOADED: ignore,
      E_TIME_UPDATE: ignore,
      E_PLAY_STARTED: ignore,
      E_PLAY_BLOCKED: ignore,
      E_PAUSE_EXTERNAL: ignore,
      E_AUDIO_ENDED: ignore,
      E_AUDIO_ERROR: ignore,
      E_TICK_1S: ignore,
    },
  },
}

export const PLAYER_CELL_COUNT = PLAYER_STATES.length * PLAYER_EVENTS.length
