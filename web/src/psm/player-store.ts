/**
 * 播放器外壳：把纯业务网格的每一个快照，翻译成播放器动作 + 存档 + 锁屏面板。
 *
 * 视图只读这里的投影、只发业务事件。任何播放器怪癖都不许回流到 PIM。
 */

import { computed, shallowRef, type ComputedRef, type ShallowRef } from 'vue'
import { step } from '../pim/kernel'
import { LISTENING_GRID } from '../pim/listening-grid'
import {
  initialListeningContext,
  SKIP_SECONDS,
  type BookSpec,
  type ListeningContext,
  type ListeningEvent,
  type ListeningStateId,
  type SleepMode,
  type SleepOption,
} from '../pim/listening-model'
import { createAudioDriver, createAudioElement, type AudioDriver, type AudioFactory } from './audio-driver'
import { resolveTrack } from './media-index'
import { hearingKey, type PlayerTarget } from './player-target'
import { persistProgress } from './storage-driver'
import type { Progress } from '../core/domain'

/** 播放中每走过这么多秒，落一次存档。节流是外壳的事，业务上位置每秒都在走。 */
const SAVE_EVERY_SEC = 5

export interface PlayerStore {
  readonly ctx: Readonly<ShallowRef<ListeningContext>>
  readonly state: ComputedRef<ListeningStateId>
  readonly book: ComputedRef<BookSpec | null>
  readonly bookTitle: ComputedRef<string>
  readonly chapterTitle: ComputedRef<string>
  readonly chapterIndex: ComputedRef<number>
  readonly positionSec: ComputedRef<number>
  readonly chapterDuration: ComputedRef<number>
  readonly speed: ComputedRef<number>
  readonly isPlaying: ComputedRef<boolean>
  readonly sleepMode: ComputedRef<SleepMode>
  readonly sleepRemaining: ComputedRef<number>
  readonly error: ComputedRef<string | null>
  readonly canNext: ComputedRef<boolean>
  readonly canPrevious: ComputedRef<boolean>
  dispatch(event: ListeningEvent): void
  open(book: BookSpec, savedChapter: number, savedSec: number): void
  jumpAndPlay(book: BookSpec, chapterIndex: number, startSec: number): void
  toggle(): void
  seek(seconds: number): void
  skip(delta: number): void
  next(): void
  previous(): void
  setSpeed(speed: number): void
  setSleep(option: SleepOption | null): void
  dispose(): void
}

export interface PlayerStoreOptions {
  createAudio?: AudioFactory
  persist?: (progress: Progress) => Promise<unknown>
  autoTick?: boolean
}

const NOOP_PERSIST = async (): Promise<void> => undefined

function updateMediaSession(ctx: ListeningContext): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
  const chapter = ctx.book?.chapters[ctx.chapterIndex]
  try {
    if (typeof MediaMetadata !== 'undefined') {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: chapter?.title ?? ctx.book?.title ?? '',
        artist: ctx.book?.title ?? '',
        album: '玉机子听书',
      })
    }
    navigator.mediaSession.playbackState = ctx.state === 'S2_PLAYING' ? 'playing' : 'paused'
  } catch {
    // 有的环境有锁屏面板却拒绝写元数据，播放不受影响。
  }
}

export function createPlayerStore(options: PlayerStoreOptions = {}): PlayerStore {
  const ctx = shallowRef<ListeningContext>(initialListeningContext())
  const error = shallowRef<string | null>(null)
  const audio = (options.createAudio ?? createAudioElement)()
  const persist = options.persist ?? (persistProgress as (progress: Progress) => Promise<unknown>)
  const timeline = options.persist === undefined ? persist : persist
  let disposed = false
  let ticker: ReturnType<typeof setInterval> | undefined
  let lastSavedKey: string | null = null
  let lastSavedPosition = 0

  const remember = (target: ListeningContext): void => {
    const book = target.book
    if (book === null) return
    lastSavedKey = hearingKey(book.id, target.chapterIndex)
    lastSavedPosition = target.positionSec
    void timeline({
      bookSlug: book.id,
      trackIndex: target.chapterIndex,
      currentTime: Math.max(0, Math.floor(target.positionSec)),
      updatedAt: Date.now(),
    }).catch(() => undefined)
  }

  const driver: AudioDriver = createAudioDriver(audio, {
    onInterrupted: () => {
      // 系统打断（来电、拔耳机、无手势被拒）：按听众按下暂停收敛。
      if (ctx.value.state === 'S2_PLAYING') store.dispatch({ type: 'E_TOGGLE_PLAY' })
    },
    onFailed: (message) => {
      error.value = message
      if (ctx.value.state === 'S2_PLAYING') store.dispatch({ type: 'E_TOGGLE_PLAY' })
    },
    onChapterEnded: () => {
      const duration = driver.duration
      if (ctx.value.state !== 'S2_PLAYING') return
      store.dispatch({
        type: 'E_SECOND_ELAPSED',
        currentPositionSec: duration > 0 ? duration : ctx.value.positionSec + 1,
        ...(duration > 0 ? { chapterDurationSec: duration } : {}),
      })
    },
  })

  function targetFor(next: ListeningContext): PlayerTarget {
    const book = next.book
    if (book === null) return { key: null, source: null, positionSec: 0, speed: next.speed, playing: false }
    const track = resolveTrack(book.id, next.chapterIndex)
    return {
      key: hearingKey(book.id, next.chapterIndex),
      source: track?.url ?? null,
      positionSec: next.positionSec,
      speed: next.speed,
      playing: next.state === 'S2_PLAYING',
    }
  }

  function sync(previous: ListeningContext, next: ListeningContext): void {
    const previousKey = hearingKey(previous.book?.id, previous.chapterIndex)
    const nextKey = hearingKey(next.book?.id, next.chapterIndex)

    if (previousKey !== nextKey && previousKey !== null) remember(previous)
    if (previous.state === 'S2_PLAYING' && next.state !== 'S2_PLAYING') remember(next)

    driver.sync(targetFor(next))

    if (previousKey !== nextKey || previous.state !== next.state || previous.speed !== next.speed) {
      updateMediaSession(next)
    }
  }

  const store: PlayerStore = {
    ctx,
    state: computed(() => ctx.value.state),
    book: computed(() => ctx.value.book),
    bookTitle: computed(() => ctx.value.book?.title ?? ''),
    chapterTitle: computed(() => ctx.value.book?.chapters[ctx.value.chapterIndex]?.title ?? ''),
    chapterIndex: computed(() => ctx.value.chapterIndex),
    positionSec: computed(() => ctx.value.positionSec),
    chapterDuration: computed(() => ctx.value.book?.chapters[ctx.value.chapterIndex]?.durationSec ?? 0),
    speed: computed(() => ctx.value.speed),
    isPlaying: computed(() => ctx.value.state === 'S2_PLAYING'),
    sleepMode: computed(() => ctx.value.sleepMode),
    sleepRemaining: computed(() => ctx.value.sleepRemainingSec),
    error: computed(() => error.value),
    canNext: computed(() => {
      const book = ctx.value.book
      return book !== null && ctx.value.chapterIndex + 1 < book.chapters.length
    }),
    canPrevious: computed(() => ctx.value.chapterIndex > 0),

    dispatch(event) {
      if (disposed) return
      const previous = ctx.value
      const next = step(LISTENING_GRID, previous, event)
      ctx.value = next
      sync(previous, next)

      // 业务上要诵读，可这一篇本机取不到来源：如实告诉听众，并收敛回静置。
      if (next.state === 'S2_PLAYING' && next.book !== null) {
        if (resolveTrack(next.book.id, next.chapterIndex) === undefined) {
          error.value = '这一篇暂时取不到声音，联网后再试'
          store.dispatch({ type: 'E_TOGGLE_PLAY' })
        } else {
          error.value = null
        }
      }
    },

    open(book, savedChapter, savedSec) {
      store.dispatch({ type: 'E_OPEN_BOOK', book, savedChapter, savedSec })
    },
    jumpAndPlay(book, chapterIndex, startSec) {
      store.dispatch({ type: 'E_JUMP_AND_PLAY', book, chapterIndex, startSec })
    },
    toggle() {
      store.dispatch({ type: 'E_TOGGLE_PLAY' })
    },
    seek(seconds) {
      store.dispatch({ type: 'E_SEEK', targetSec: seconds })
    },
    skip(delta) {
      store.dispatch({ type: 'E_SEEK', targetSec: ctx.value.positionSec + delta })
    },
    next() {
      store.dispatch({ type: 'E_NEXT_CHAPTER' })
    },
    previous() {
      store.dispatch({ type: 'E_PREV_CHAPTER' })
    },
    setSpeed(speed) {
      store.dispatch({ type: 'E_SET_PREF', speed })
    },
    setSleep(option) {
      store.dispatch({ type: 'E_SET_PREF', sleepOption: option })
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (ticker !== undefined) clearInterval(ticker)
      ticker = undefined
      driver.dispose()
    },
  }

  // 一秒一跳：只有诵读中这一步才推进播放头与睡眠倒计时，其余状态网格自己忽略。
  if (options.autoTick !== false && typeof setInterval === 'function') {
    ticker = setInterval(() => {
      if (ctx.value.state !== 'S2_PLAYING') return
      const position = driver.position
      const duration = driver.duration
      store.dispatch({
        type: 'E_SECOND_ELAPSED',
        currentPositionSec: position ?? ctx.value.positionSec,
        ...(duration > 0 ? { chapterDurationSec: duration } : {}),
      })

      const key = hearingKey(ctx.value.book?.id, ctx.value.chapterIndex)
      if (
        ctx.value.state === 'S2_PLAYING' &&
        key !== lastSavedKey &&
        key !== null
      ) {
        remember(ctx.value)
      } else if (ctx.value.state === 'S2_PLAYING' && Math.abs(ctx.value.positionSec - lastSavedPosition) >= SAVE_EVERY_SEC) {
        remember(ctx.value)
      }
    }, 1_000)
  }

  return store
}

let singleton: PlayerStore | undefined

export function usePlayer(): PlayerStore {
  if (singleton === undefined) {
    const store = createPlayerStore()
    singleton = store
    return store
  }
  return singleton
}

/** 测试用：丢弃单例，下一次拿到全新网格与播放器。 */
export function resetPlayerStore(): void {
  singleton?.dispose()
  singleton = undefined
}

export { SKIP_SECONDS }
export const NOOP_PERSISTENCE = NOOP_PERSIST
