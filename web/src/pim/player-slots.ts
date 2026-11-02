/**
 * Slots: the procedural bodies of the grid.
 *
 * Every slot is a pure function of `ctx` and its payload. It never calls
 * `audio.play()`, `indexedDB`, or `fetch`; it returns the instructions the PSM
 * must carry out. That is what makes the grid exhaustively testable.
 */

import type { BookDetail } from '../core/domain'
import {
  clampTime,
  MAX_AUTO_RETRIES,
  PROGRESS_SAVE_STEP_SEC,
  type PlayerContext,
  type PlayerEffect,
  type PlayerStateId,
  type SleepTimerOption,
} from './player-model'
import type { StepResult } from './kernel'

type Effects = readonly PlayerEffect[]
type Step = StepResult<PlayerContext, PlayerEffect>

const INERT: Effects = []

/** Persist where the listener was, before the outgoing track is replaced. */
function persistOutgoing(ctx: PlayerContext): Effects {
  const book = ctx.book
  if (book === null) return INERT
  return [
    {
      type: 'PERSIST_PROGRESS',
      bookSlug: book.slug,
      trackIndex: ctx.trackIndex,
      currentTime: ctx.currentTime,
      duration: ctx.duration,
    },
  ]
}

function trackUrl(book: BookDetail, index: number): string | undefined {
  return book.tracks[index]?.url
}

function clampIndex(book: BookDetail, index: number): number {
  if (book.tracks.length === 0) return 0
  return Math.min(Math.max(0, Math.trunc(index)), book.tracks.length - 1)
}

/** Enter a track with a clean per-track budget: retries, error, persistence clock. */
function enterTrack(
  ctx: PlayerContext,
  book: BookDetail,
  trackIndex: number,
  time: number,
  state: PlayerStateId,
): PlayerContext {
  return {
    ...ctx,
    state,
    book,
    trackIndex,
    currentTime: time,
    duration: 0,
    retryCount: 0,
    errorMessage: null,
    seekPending: time > 0,
    lastPersistedTime: -1,
  }
}

function loadEffects(book: BookDetail, trackIndex: number): Effects {
  const url = trackUrl(book, trackIndex)
  if (url === undefined) return INERT
  return [
    { type: 'AUDIO_LOAD', url },
    { type: 'MEDIA_SESSION_UPDATE' },
  ]
}

export function actPrepareBook(
  ctx: PlayerContext,
  book: BookDetail,
  requestedIndex: number,
  savedTime: number,
): Step {
  if (book.tracks.length === 0) return { ctx, effects: INERT }
  const index = clampIndex(book, requestedIndex)
  const next = enterTrack(ctx, book, index, clampTime(savedTime, 0), 'S1_LOADING_PAUSED')
  return { ctx: next, effects: [...persistOutgoing(ctx), ...loadEffects(book, index)] }
}

export function actLoadAndPlay(ctx: PlayerContext, book: BookDetail, requestedIndex: number, startTime: number): Step {
  if (book.tracks.length === 0) return { ctx, effects: INERT }
  const index = clampIndex(book, requestedIndex)
  const next = enterTrack(ctx, book, index, clampTime(startTime, 0), 'S2_LOADING_PLAY')
  return {
    ctx: next,
    effects: [...persistOutgoing(ctx), ...loadEffects(book, index), { type: 'AUDIO_PLAY' }],
  }
}

/** S1 + toggle: the track is already loading, only the intent changes. */
export function actRequestPlay(ctx: PlayerContext): Step {
  return {
    ctx: { ...ctx, state: 'S2_LOADING_PLAY' },
    effects: [{ type: 'AUDIO_PLAY' }, { type: 'MEDIA_SESSION_UPDATE' }],
  }
}

/** S2 + toggle: cancel the pending play without discarding the track. */
export function actCancelPlay(ctx: PlayerContext): Step {
  return {
    ctx: { ...ctx, state: 'S1_LOADING_PAUSED' },
    effects: [{ type: 'AUDIO_PAUSE' }, { type: 'MEDIA_SESSION_UPDATE' }],
  }
}

/** Stage a seek in memory only. The element is not ready yet. */
export function actStageSeek(ctx: PlayerContext, time: number): Step {
  return {
    ctx: { ...ctx, currentTime: clampTime(time, ctx.duration), seekPending: true },
    effects: INERT,
  }
}

function commitMeta(ctx: PlayerContext, duration: number, state: PlayerStateId): Step {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0
  const currentTime = clampTime(ctx.currentTime, safeDuration)
  const pending = ctx.seekPending
  const effects: PlayerEffect[] = [{ type: 'MEDIA_SESSION_UPDATE' }]
  if (pending) effects.push({ type: 'AUDIO_SEEK', time: currentTime })
  return {
    ctx: { ...ctx, state, duration: safeDuration, currentTime, seekPending: false },
    effects,
  }
}

/** S1 + metadata: the paused intent is fulfilled. */
export function actCommitMetaPaused(ctx: PlayerContext, duration: number): Step {
  return commitMeta(ctx, duration, 'S3_READY_PAUSED')
}

/** S2 + metadata: keep waiting for the browser to confirm playback. */
export function actCommitMetaLoading(ctx: PlayerContext, duration: number): Step {
  return commitMeta(ctx, duration, 'S2_LOADING_PLAY')
}

/** S4 + metadata: a late duration must not disturb playback. */
export function actCommitMetaPlaying(ctx: PlayerContext, duration: number): Step {
  return commitMeta(ctx, duration, 'S4_PLAYING')
}

export function actUpdateDuration(ctx: PlayerContext, duration: number): Step {
  return commitMeta(ctx, duration, ctx.state)
}

/** The browser confirmed playback. State follows evidence, not optimism. */
export function actPlayStarted(ctx: PlayerContext): Step {
  return { ctx: { ...ctx, state: 'S4_PLAYING' }, effects: [{ type: 'MEDIA_SESSION_UPDATE' }] }
}

/**
 * Only called from S4. Advances the playhead and writes progress at most once
 * per PROGRESS_SAVE_STEP_SEC, keyed by the time it last wrote — so switching
 * books cannot swallow the previous book's tail (B6).
 */
export function actTimeUpdate(ctx: PlayerContext, time: number): Step {
  const currentTime = clampTime(time, ctx.duration)
  const shouldPersist =
    ctx.book !== null &&
    (ctx.lastPersistedTime < 0 || Math.abs(currentTime - ctx.lastPersistedTime) >= PROGRESS_SAVE_STEP_SEC)
  const effects: PlayerEffect[] = []
  if (shouldPersist && ctx.book !== null) {
    effects.push({
      type: 'PERSIST_PROGRESS',
      bookSlug: ctx.book.slug,
      trackIndex: ctx.trackIndex,
      currentTime,
      duration: ctx.duration,
    })
  }
  return {
    ctx: { ...ctx, currentTime, lastPersistedTime: shouldPersist ? currentTime : ctx.lastPersistedTime },
    effects,
  }
}

export function actPauseAndSave(ctx: PlayerContext): Step {
  return {
    ctx: { ...ctx, state: 'S3_READY_PAUSED', lastPersistedTime: ctx.currentTime },
    effects: [
      { type: 'AUDIO_PAUSE' },
      ...persistOutgoing(ctx),
      { type: 'MEDIA_SESSION_UPDATE' },
    ],
  }
}

/**
 * The browser paused us (phone call, earbuds, system interruption). The audio
 * is already silent, so no AUDIO_PAUSE is emitted; the grid simply stops
 * claiming S4, which freezes the sleep countdown again (a B5 regression if
 * this event did not exist).
 */
export function actPauseExternal(ctx: PlayerContext): Step {
  return {
    ctx: { ...ctx, state: 'S3_READY_PAUSED', lastPersistedTime: ctx.currentTime },
    effects: [...persistOutgoing(ctx), { type: 'MEDIA_SESSION_UPDATE' }],
  }
}

export function actResumePlay(ctx: PlayerContext): Step {
  return {
    ctx: { ...ctx, state: 'S4_PLAYING' },
    effects: [{ type: 'AUDIO_PLAY' }, { type: 'MEDIA_SESSION_UPDATE' }],
  }
}

/** Playback began without our asking (system resumed, media keys). */
export function actExternalPlay(ctx: PlayerContext): Step {
  return { ctx: { ...ctx, state: 'S4_PLAYING' }, effects: [{ type: 'MEDIA_SESSION_UPDATE' }] }
}

/**
 * The browser refused `play()` for lack of user activation (`NotAllowedError`),
 * which is normal on iOS after an async navigation. The track is still loaded
 * at the requested position, so settle into a ready-but-paused state instead of
 * hanging in S2 forever.
 */
export function actPlayBlocked(ctx: PlayerContext): Step {
  const state: PlayerStateId = ctx.duration > 0 ? 'S3_READY_PAUSED' : 'S1_LOADING_PAUSED'
  return { ctx: { ...ctx, state }, effects: [{ type: 'MEDIA_SESSION_UPDATE' }] }
}

export function actImmediateSeek(ctx: PlayerContext, time: number): Step {
  return {
    ctx: { ...ctx, currentTime: clampTime(time, ctx.duration), seekPending: false },
    effects: [{ type: 'AUDIO_SEEK', time: clampTime(time, ctx.duration) }],
  }
}

/** S5 + seek: the listener took the wheel again, so the grid leaves sleep-stop. */
export function actImmediateSeekPaused(ctx: PlayerContext, time: number): Step {
  const currentTime = clampTime(time, ctx.duration)
  return {
    ctx: { ...ctx, state: 'S3_READY_PAUSED', currentTime, seekPending: false, lastPersistedTime: currentTime },
    effects: [
      { type: 'AUDIO_SEEK', time: currentTime },
      {
        type: 'PERSIST_PROGRESS',
        bookSlug: ctx.book?.slug ?? '',
        trackIndex: ctx.trackIndex,
        currentTime,
        duration: ctx.duration,
      },
    ],
  }
}

/** Sleep deadline reached, or end-of-chapter with a sleep timer armed. */
export function actSleepStop(ctx: PlayerContext): Step {
  return {
    ctx: { ...ctx, state: 'S5_SLEEP_STOPPED', sleepMode: 'off', sleepRemainingSec: 0, lastPersistedTime: ctx.currentTime },
    effects: [{ type: 'AUDIO_PAUSE' }, ...persistOutgoing(ctx), { type: 'MEDIA_SESSION_UPDATE' }],
  }
}

/** Only S4 ticks, so a paused listener never loses minutes to a phone call. */
export function actTickSleep(ctx: PlayerContext): Step {
  return {
    ctx: { ...ctx, sleepRemainingSec: Math.max(0, ctx.sleepRemainingSec - 1) },
    effects: INERT,
  }
}

/** Sleep stopped, then the listener pressed play: that is an explicit gesture. */
export function actWakeAndPlay(ctx: PlayerContext): Step {
  return {
    ctx: { ...ctx, state: 'S4_PLAYING', errorMessage: null, retryCount: 0 },
    effects: [{ type: 'AUDIO_PLAY' }, { type: 'MEDIA_SESSION_UPDATE' }],
  }
}

export function actNextTrack(ctx: PlayerContext): Step {
  const book = ctx.book
  if (book === null) return { ctx, effects: INERT }
  const next = ctx.trackIndex + 1
  if (next >= book.tracks.length) return { ctx, effects: INERT }
  return actLoadAndPlay(ctx, book, next, 0)
}

export function actPreviousTrack(ctx: PlayerContext): Step {
  const book = ctx.book
  if (book === null) return { ctx, effects: INERT }
  const previous = ctx.trackIndex - 1
  if (previous < 0) return { ctx, effects: INERT }
  return actLoadAndPlay(ctx, book, previous, 0)
}

/** The last chapter finished normally: stop, do not loop. */
export function actBookFinished(ctx: PlayerContext): Step {
  const currentTime = ctx.duration > 0 ? ctx.duration : ctx.currentTime
  return {
    ctx: { ...ctx, state: 'S3_READY_PAUSED', currentTime, lastPersistedTime: currentTime },
    effects: [...persistOutgoing({ ...ctx, currentTime }), { type: 'MEDIA_SESSION_UPDATE' }],
  }
}

export function actSetRate(ctx: PlayerContext, rate: number): Step {
  return {
    ctx: { ...ctx, rate },
    effects: [{ type: 'AUDIO_RATE', rate }, { type: 'MEDIA_SESSION_UPDATE' }],
  }
}

export function actSetSleep(ctx: PlayerContext, option: SleepTimerOption | null): Step {
  if (option === null) {
    return { ctx: { ...ctx, sleepMode: 'off', sleepRemainingSec: 0 }, effects: INERT }
  }
  if (option.kind === 'end-of-chapter') {
    return { ctx: { ...ctx, sleepMode: 'end-of-chapter', sleepRemainingSec: 0 }, effects: INERT }
  }
  return {
    ctx: { ...ctx, sleepMode: 'minutes', sleepRemainingSec: Math.max(0, Math.round(option.minutes * 60)) },
    effects: INERT,
  }
}

export function actMarkError(ctx: PlayerContext, reason: string): Step {
  return {
    ctx: { ...ctx, state: 'S6_ERROR', errorMessage: reason },
    effects: [{ type: 'AUDIO_PAUSE' }, ...persistOutgoing(ctx), { type: 'MEDIA_SESSION_UPDATE' }],
  }
}

/** Automatic retry; the budget lives in the context so it survives a reload. */
export function actRetry(ctx: PlayerContext, reason: string): Step {
  const book = ctx.book
  if (book === null) return actMarkError(ctx, reason)
  const url = trackUrl(book, ctx.trackIndex)
  if (url === undefined) return actMarkError(ctx, reason)
  return {
    ctx: {
      ...ctx,
      state: 'S2_LOADING_PLAY',
      retryCount: ctx.retryCount + 1,
      errorMessage: null,
      seekPending: ctx.currentTime > 0,
      duration: 0,
    },
    effects: [{ type: 'AUDIO_LOAD', url }, { type: 'AUDIO_PLAY' }, { type: 'MEDIA_SESSION_UPDATE' }],
  }
}

/** Explicit retry after the budget is spent: a fresh count. */
export function actRetryFromError(ctx: PlayerContext): Step {
  const book = ctx.book
  if (book === null) return { ctx: { ...ctx, errorMessage: null, retryCount: 0 }, effects: INERT }
  const url = trackUrl(book, ctx.trackIndex)
  if (url === undefined) return { ctx, effects: INERT }
  return {
    ctx: {
      ...ctx,
      state: 'S2_LOADING_PLAY',
      retryCount: 0,
      errorMessage: null,
      seekPending: ctx.currentTime > 0,
      duration: 0,
    },
    effects: [{ type: 'AUDIO_LOAD', url }, { type: 'AUDIO_PLAY' }, { type: 'MEDIA_SESSION_UPDATE' }],
  }
}

/** S6 + seek: dragging in the error state reloads the track, still paused. */
export function actReloadAt(ctx: PlayerContext, time: number): Step {
  const book = ctx.book
  if (book === null) return { ctx, effects: INERT }
  const url = trackUrl(book, ctx.trackIndex)
  if (url === undefined) return { ctx, effects: INERT }
  const currentTime = clampTime(time, 0)
  return {
    ctx: {
      ...ctx,
      state: 'S1_LOADING_PAUSED',
      currentTime,
      duration: 0,
      retryCount: 0,
      errorMessage: null,
      seekPending: true,
    },
    effects: [{ type: 'AUDIO_LOAD', url }, { type: 'MEDIA_SESSION_UPDATE' }],
  }
}

export function canRetry(ctx: PlayerContext): boolean {
  return ctx.retryCount < MAX_AUTO_RETRIES
}

export function hasNextTrack(ctx: PlayerContext): boolean {
  return ctx.book !== null && ctx.trackIndex + 1 < ctx.book.tracks.length
}

export function sleepIsDue(ctx: PlayerContext): boolean {
  return ctx.sleepMode === 'minutes' && ctx.sleepRemainingSec <= 1
}
