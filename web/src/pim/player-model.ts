/**
 * The vocabulary of the listening domain: states, events, effects, context.
 *
 * Nothing here touches the DOM, IndexedDB, or Vue. That is deliberate: the
 * same grid runs in Vitest, in the browser, and (one day) in a native shell.
 */

import type { BookDetail } from '../core/domain'

export type PlayerStateId =
  /** Nothing loaded. */
  | 'S0_IDLE'
  /** Track chosen, metadata not ready, listener asked to stay paused. */
  | 'S1_LOADING_PAUSED'
  /** Track chosen, metadata not ready, listener asked to play. */
  | 'S2_LOADING_PLAY'
  /** Metadata ready, paused. */
  | 'S3_READY_PAUSED'
  /** Audible. */
  | 'S4_PLAYING'
  /** Stopped by the sleep timer. Ignores every late browser callback. */
  | 'S5_SLEEP_STOPPED'
  /** Load or decode failure. Keeps the track so a retry is one tap away. */
  | 'S6_ERROR'

export const PLAYER_STATES: readonly PlayerStateId[] = [
  'S0_IDLE',
  'S1_LOADING_PAUSED',
  'S2_LOADING_PLAY',
  'S3_READY_PAUSED',
  'S4_PLAYING',
  'S5_SLEEP_STOPPED',
  'S6_ERROR',
]

export const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const
export const SKIP_SECONDS = 30
/** Automatic retries per track before the grid parks in S6 and asks the listener. */
export const MAX_AUTO_RETRIES = 2
/** How much playback time may elapse between two progress writes. */
export const PROGRESS_SAVE_STEP_SEC = 5

export interface SleepMinutesOption {
  readonly kind: 'minutes'
  readonly minutes: number
  readonly label: string
}

export interface SleepEndOfChapterOption {
  readonly kind: 'end-of-chapter'
  readonly label: string
}

export type SleepTimerOption = SleepMinutesOption | SleepEndOfChapterOption

export const SLEEP_TIMER_OPTIONS: readonly SleepTimerOption[] = [
  { kind: 'minutes', minutes: 10, label: '10 分钟' },
  { kind: 'minutes', minutes: 20, label: '20 分钟' },
  { kind: 'minutes', minutes: 30, label: '30 分钟' },
  { kind: 'minutes', minutes: 45, label: '45 分钟' },
  { kind: 'minutes', minutes: 60, label: '60 分钟' },
  { kind: 'minutes', minutes: 90, label: '90 分钟' },
  { kind: 'end-of-chapter', label: '本章结束' },
]

export type SleepMode = 'off' | 'minutes' | 'end-of-chapter'

export interface PlayerContext {
  readonly state: PlayerStateId
  readonly book: BookDetail | null
  readonly trackIndex: number
  /** Authoritative playhead. In S1/S2 it is the staged target, not the element's value. */
  readonly currentTime: number
  /** 0 until metadata arrives. */
  readonly duration: number
  readonly rate: number
  readonly sleepMode: SleepMode
  /** Only decremented in S4, so pausing freezes the countdown by construction. */
  readonly sleepRemainingSec: number
  /** Consecutive failures of the current track. */
  readonly retryCount: number
  readonly errorMessage: string | null
  /** True while a seek is staged and must be committed when metadata lands. */
  readonly seekPending: boolean
  /** Playhead value of the last progress write; -1 forces one on the next tick. */
  readonly lastPersistedTime: number
}

export function initialPlayerContext(): PlayerContext {
  return {
    state: 'S0_IDLE',
    book: null,
    trackIndex: 0,
    currentTime: 0,
    duration: 0,
    rate: 1,
    sleepMode: 'off',
    sleepRemainingSec: 0,
    retryCount: 0,
    errorMessage: null,
    seekPending: false,
    lastPersistedTime: -1,
  }
}

export type PlayerEvent =
  /* Listener gestures */
  | { readonly type: 'E_PREPARE_BOOK'; readonly book: BookDetail; readonly trackIndex: number; readonly savedTime: number }
  | { readonly type: 'E_PLAY_AT'; readonly book: BookDetail; readonly trackIndex: number; readonly startTime: number }
  | { readonly type: 'E_TOGGLE' }
  | { readonly type: 'E_SEEK'; readonly time: number }
  | { readonly type: 'E_NEXT' }
  | { readonly type: 'E_PREV' }
  | { readonly type: 'E_SET_RATE'; readonly rate: number }
  | { readonly type: 'E_SET_SLEEP'; readonly option: SleepTimerOption | null }
  /* Media element and timer callbacks */
  | { readonly type: 'E_META_LOADED'; readonly duration: number }
  | { readonly type: 'E_TIME_UPDATE'; readonly time: number }
  | { readonly type: 'E_PLAY_STARTED' }
  /** The browser refused playback (no user activation). Not an error. */
  | { readonly type: 'E_PLAY_BLOCKED' }
  | { readonly type: 'E_PAUSE_EXTERNAL' }
  | { readonly type: 'E_AUDIO_ENDED' }
  | { readonly type: 'E_AUDIO_ERROR'; readonly reason: string }
  | { readonly type: 'E_TICK_1S' }

export const PLAYER_EVENTS: readonly PlayerEvent['type'][] = [
  'E_PREPARE_BOOK',
  'E_PLAY_AT',
  'E_TOGGLE',
  'E_SEEK',
  'E_NEXT',
  'E_PREV',
  'E_SET_RATE',
  'E_SET_SLEEP',
  'E_META_LOADED',
  'E_TIME_UPDATE',
  'E_PLAY_STARTED',
  'E_PLAY_BLOCKED',
  'E_PAUSE_EXTERNAL',
  'E_AUDIO_ENDED',
  'E_AUDIO_ERROR',
  'E_TICK_1S',
]

export type PlayerEffect =
  | { readonly type: 'AUDIO_LOAD'; readonly url: string }
  | { readonly type: 'AUDIO_PLAY' }
  | { readonly type: 'AUDIO_PAUSE' }
  | { readonly type: 'AUDIO_SEEK'; readonly time: number }
  | { readonly type: 'AUDIO_RATE'; readonly rate: number }
  | {
      readonly type: 'PERSIST_PROGRESS'
      readonly bookSlug: string
      readonly trackIndex: number
      readonly currentTime: number
      readonly duration: number
    }
  | { readonly type: 'MEDIA_SESSION_UPDATE' }

export function trackOf(ctx: PlayerContext): BookDetail['tracks'][number] | undefined {
  return ctx.book?.tracks[ctx.trackIndex]
}

export function clampTime(time: number, duration: number): number {
  if (!Number.isFinite(time)) return 0
  const positive = Math.max(0, time)
  return duration > 0 ? Math.min(positive, duration) : positive
}

/** `h:mm:ss` / `m:ss`, shared by every view that prints a position. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  return `${minutes}:${String(secs).padStart(2, '0')}`
}
