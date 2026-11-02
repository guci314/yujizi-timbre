/**
 * The single player store: one grid, one audio element, one source of truth.
 *
 * Views never mutate playback fields. They dispatch events and read the
 * projected context, so a stale local flag cannot contradict the grid.
 */

import { computed, shallowRef, type ComputedRef, type ShallowRef } from 'vue'
import type { BookDetail } from '../core/domain'
import { step } from '../pim/kernel'
import { PLAYER_GRID } from '../pim/player-grid'
import {
  initialPlayerContext,
  SKIP_SECONDS,
  trackOf,
  type PlayerContext,
  type PlayerEffect,
  type PlayerEvent,
  type SleepTimerOption,
} from '../pim/player-model'
import { AudioDriver, createAudioElement, type AudioFactory } from './audio-driver'
import { persistProgress } from './storage-driver'

export interface PlayerStore {
  readonly ctx: Readonly<ShallowRef<PlayerContext>>
  readonly book: ComputedRef<BookDetail | null>
  readonly trackIndex: ComputedRef<number>
  readonly trackName: ComputedRef<string>
  readonly currentTime: ComputedRef<number>
  readonly duration: ComputedRef<number>
  readonly rate: ComputedRef<number>
  readonly isPlaying: ComputedRef<boolean>
  readonly isLoading: ComputedRef<boolean>
  readonly error: ComputedRef<string | null>
  readonly sleepRemaining: ComputedRef<number>
  readonly sleepMode: ComputedRef<PlayerContext['sleepMode']>
  readonly canNext: ComputedRef<boolean>
  readonly canPrevious: ComputedRef<boolean>
  dispatch(event: PlayerEvent): void
  /** Load a book's position without producing sound. Ignored unless idle. */
  prepare(book: BookDetail, trackIndex: number, savedTime: number): void
  /** Switch to a specific chapter and second, and start playing. */
  playAt(book: BookDetail, trackIndex: number, startTime: number): void
  toggle(): void
  seek(seconds: number): void
  skip(delta: number): void
  next(): void
  previous(): void
  setRate(rate: number): void
  setSleep(option: SleepTimerOption | null): void
  dispose(): void
}

export interface PlayerStoreOptions {
  createAudio?: AudioFactory
  /** Injected in tests so a fake clock can drive the tick. */
  autoTick?: boolean
}

function updateMediaSession(ctx: PlayerContext): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
  const session = navigator.mediaSession
  try {
    if (typeof MediaMetadata !== 'undefined') {
      session.metadata = new MediaMetadata({
        title: trackOf(ctx)?.name ?? ctx.book?.title ?? '',
        artist: ctx.book?.title ?? '',
        album: 'Timbre 听书',
      })
    }
    session.playbackState = ctx.state === 'S4_PLAYING' ? 'playing' : 'paused'
  } catch {
    // Some browsers expose mediaSession but reject metadata; playback is unaffected.
  }
}

function registerMediaSessionActions(store: PlayerStore): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
  const actions: Array<[MediaSessionAction, () => void]> = [
    ['seekbackward', () => store.skip(-SKIP_SECONDS)],
    ['seekforward', () => store.skip(SKIP_SECONDS)],
  ]
  for (const [action, handler] of actions) {
    try {
      navigator.mediaSession.setActionHandler(action, handler)
    } catch {
      // Not every platform implements every action.
    }
  }
}

export function createPlayerStore(options: PlayerStoreOptions = {}): PlayerStore {
  const ctx = shallowRef<PlayerContext>(initialPlayerContext())
  const audio = (options.createAudio ?? createAudioElement)()
  let disposed = false
  let ticker: ReturnType<typeof setInterval> | undefined

  const driver = new AudioDriver(audio, (event) => store.dispatch(event))

  function applyEffects(effects: readonly PlayerEffect[], next: PlayerContext): void {
    driver.run(effects, next)
    for (const effect of effects) {
      switch (effect.type) {
        case 'PERSIST_PROGRESS':
          void persistProgress({
            bookSlug: effect.bookSlug,
            trackIndex: effect.trackIndex,
            currentTime: effect.currentTime,
            updatedAt: Date.now(),
          }).catch(() => undefined)
          break
        case 'MEDIA_SESSION_UPDATE':
          updateMediaSession(next)
          break
        default:
          break
      }
    }
  }

  function dispatch(event: PlayerEvent): void {
    if (disposed) return
    const result = step(PLAYER_GRID, ctx.value, event)
    ctx.value = result.ctx
    applyEffects(result.effects, result.ctx)
  }

  const store: PlayerStore = {
    ctx,
    book: computed(() => ctx.value.book),
    trackIndex: computed(() => ctx.value.trackIndex),
    trackName: computed(() => trackOf(ctx.value)?.name ?? ''),
    currentTime: computed(() => ctx.value.currentTime),
    duration: computed(() => ctx.value.duration),
    rate: computed(() => ctx.value.rate),
    isPlaying: computed(() => ctx.value.state === 'S4_PLAYING'),
    isLoading: computed(() => ctx.value.state === 'S1_LOADING_PAUSED' || ctx.value.state === 'S2_LOADING_PLAY'),
    error: computed(() => ctx.value.errorMessage),
    sleepRemaining: computed(() => ctx.value.sleepRemainingSec),
    sleepMode: computed(() => ctx.value.sleepMode),
    canNext: computed(() => {
      const book = ctx.value.book
      return book !== null && ctx.value.trackIndex + 1 < book.tracks.length
    }),
    canPrevious: computed(() => ctx.value.trackIndex > 0),
    dispatch,
    prepare(book, trackIndex, savedTime) {
      dispatch({ type: 'E_PREPARE_BOOK', book, trackIndex, savedTime })
    },
    playAt(book, trackIndex, startTime) {
      dispatch({ type: 'E_PLAY_AT', book, trackIndex, startTime })
    },
    toggle() {
      dispatch({ type: 'E_TOGGLE' })
    },
    seek(seconds) {
      dispatch({ type: 'E_SEEK', time: seconds })
    },
    skip(delta) {
      dispatch({ type: 'E_SEEK', time: ctx.value.currentTime + delta })
    },
    next() {
      dispatch({ type: 'E_NEXT' })
    },
    previous() {
      dispatch({ type: 'E_PREV' })
    },
    setRate(rate) {
      dispatch({ type: 'E_SET_RATE', rate })
    },
    setSleep(option) {
      dispatch({ type: 'E_SET_SLEEP', option })
    },
    dispose() {
      if (disposed) return
      disposed = true
      detach()
      if (ticker !== undefined) clearInterval(ticker)
      ticker = undefined
    },
  }

  const detach = driver.attach()
  registerMediaSessionActions(store)

  // The grid ignores ticks outside S4, so an always-on ticker is honest: pausing
  // really does freeze the countdown, rather than the timer being switched off.
  if (options.autoTick !== false && typeof setInterval === 'function') {
    ticker = setInterval(() => dispatch({ type: 'E_TICK_1S' }), 1_000)
  }

  return store
}

let singleton: PlayerStore | undefined

export function usePlayer(): PlayerStore {
  singleton ??= createPlayerStore()
  return singleton
}

/** Test seam: drop the singleton so each test gets a fresh grid and audio element. */
export function resetPlayerStore(): void {
  singleton?.dispose()
  singleton = undefined
}
