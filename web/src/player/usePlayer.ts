import { onScopeDispose, ref, shallowRef, type Ref } from 'vue'
import type { BookDetail } from '../core/domain'
import { loadProgress, saveProgress } from '../core/storage/db'
import {
  nextIndex,
  nowPlayingTitle,
  previousIndex,
  PROGRESS_SAVE_INTERVAL_MS,
  resumePosition,
  seekTarget,
} from './playback'
import { sleepRemainingSeconds, type SleepTimerOption } from './sleep'

/** Seconds a skip button jumps. The Android player uses the same 30. */
export const SKIP_SECONDS = 30

/** The slice of HTMLAudioElement the player depends on, so tests can fake it. */
export interface AudioLike {
  src: string
  currentTime: number
  duration: number
  playbackRate: number
  paused: boolean
  /** Set before the first `src`, so cached audio answers with byte ranges. */
  crossOrigin: string | null
  play(): Promise<void> | void
  pause(): void
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

export type AudioFactory = () => AudioLike

export interface PlayerState {
  book: Ref<BookDetail | undefined>
  trackIndex: Ref<number>
  isPlaying: Ref<boolean>
  currentTime: Ref<number>
  duration: Ref<number>
  rate: Ref<number>
  error: Ref<string | undefined>
  /** Seconds left on the sleep timer; undefined when no timer runs. */
  sleepRemaining: Ref<number | undefined>
  /** The sleep timer in force, if any. */
  sleepTimer: Ref<SleepTimerOption | undefined>
  open(book: BookDetail, trackIndex?: number): Promise<void>
  toggle(): Promise<void>
  playTrack(index: number): Promise<void>
  seek(seconds: number): void
  /** Jump `seconds` forward inside the current chapter. */
  skipForward(seconds: number): void
  /** Jump `seconds` back inside the current chapter. */
  skipBack(seconds: number): void
  setRate(value: number): void
  next(): Promise<void>
  previous(): Promise<void>
  close(): void
  setSleepTimer(option: SleepTimerOption | number): void
  clearSleepTimer(): void
}

/**
 * Build the audio element.
 *
 * `crossOrigin` must be set before any `src`. Downloaded audio is served by the
 * service worker through the Cache API, and a cached response only satisfies a
 * ranged media request when the element asked in CORS mode — without this,
 * seeking into downloaded audio fails. It is required even for same-origin
 * sources.
 */
const defaultAudioFactory: AudioFactory = () => {
  const audio = new Audio()
  audio.crossOrigin = 'anonymous'
  return audio as unknown as AudioLike
}

/**
 * A rejected `play()` is not always a fault. Browsers refuse playback no user
 * gesture asked for, so that case stays quiet instead of blaming the network.
 */
export function playbackFailureMessage(cause: unknown): string | undefined {
  if (cause instanceof DOMException && cause.name === 'NotAllowedError') return undefined
  if (cause instanceof Error && cause.name === 'NotAllowedError') return undefined
  return '播放失败，请检查网络后重试'
}

export function usePlayer(createAudio: AudioFactory = defaultAudioFactory): PlayerState {
  const book = shallowRef<BookDetail>()
  const trackIndex = ref(0)
  const isPlaying = ref(false)
  const currentTime = ref(0)
  const duration = ref(0)
  const rate = ref(1)
  const error = ref<string>()
  /** Seconds left on the sleep timer; undefined when no timer runs. */
  const sleepRemaining = ref<number | undefined>()
  /** The sleep timer in force, if any. */
  const sleepTimer = ref<SleepTimerOption | undefined>()

  const audio = createAudio()
  let lastSavedAt = 0
  /** A seek requested before the new source reported its metadata. */
  let pendingSeek: number | undefined
  /** The moment a minute-based sleep timer stops playback. */
  let sleepDeadline = 0
  let sleepTicker: ReturnType<typeof setInterval> | undefined
  /** True once a sleep timer stopped playback, so the chain does not roll on. */
  let sleepStopped = false

  async function persist(force = false): Promise<void> {
    const current = book.value
    if (current === undefined) return
    const now = Date.now()
    if (!force && now - lastSavedAt < PROGRESS_SAVE_INTERVAL_MS) return
    lastSavedAt = now
    await saveProgress({
      bookSlug: current.slug,
      trackIndex: trackIndex.value,
      currentTime: audio.currentTime,
      updatedAt: now,
    })
  }

  function attachSource(url: string, startAt = 0): void {
    audio.src = url
    audio.playbackRate = rate.value
    currentTime.value = startAt
    duration.value = 0
    pendingSeek = startAt > 0 ? startAt : undefined
  }

  /**
   * Load a track without starting it.
   * Browsers refuse playback that no user gesture asked for, so opening a book
   * prepares the first track and leaves starting it to a tap.
   */
  function prepareTrack(index: number, startAt = 0): void {
    const current = book.value
    const track = current?.tracks[index]
    if (current === undefined || track === undefined) return
    trackIndex.value = index
    attachSource(track.url, startAt)
    error.value = undefined
    updateMediaSession()
  }

  async function playTrack(index: number, startAt = 0): Promise<void> {
    const current = book.value
    const track = current?.tracks[index]
    if (current === undefined || track === undefined) return
    trackIndex.value = index
    attachSource(track.url, startAt)
    try {
      await audio.play()
      error.value = undefined
    } catch (cause) {
      error.value = playbackFailureMessage(cause)
      isPlaying.value = false
    }
    updateMediaSession()
  }

  /**
   * Open a book and prepare where the listener left off, without playing.
   * @param requested - a specific track to prepare, overriding the saved position.
   */
  async function open(target: BookDetail, requested?: number): Promise<void> {
    book.value = target
    if (requested !== undefined) {
      prepareTrack(requested)
      return
    }
    const saved = await loadProgress(target.slug)
    if (saved === undefined || saved.trackIndex >= target.tracks.length) {
      prepareTrack(0)
      return
    }
    prepareTrack(saved.trackIndex, resumePosition(saved.currentTime, Number.NaN))
  }

  async function toggle(): Promise<void> {
    if (isPlaying.value) {
      audio.pause()
      isPlaying.value = false
      await persist(true)
      return
    }
    // Starting again lifts the stop a sleep timer left behind.
    sleepStopped = false
    try {
      await audio.play()
      error.value = undefined
    } catch (cause) {
      error.value = playbackFailureMessage(cause)
    }
  }

  function seek(seconds: number): void {
    audio.currentTime = seconds
    currentTime.value = seconds
  }

  /**
   * Jump forward or backward by `delta` seconds, staying in the same chapter.
   *
   * The skip is a seek inside the current track, not a track change: the
   * Android app's player has offered ±30s since long before the browser
   * version existed, and the two should behave the same.
   */
  function skip(delta: number): void {
    const end = Number.isFinite(audio.duration) ? audio.duration : undefined
    seek(seekTarget(audio.currentTime, delta, end))
  }

  function skipForward(seconds: number): void {
    skip(seconds)
  }

  function skipBack(seconds: number): void {
    skip(-seconds)
  }

  function setRate(value: number): void {
    rate.value = value
    audio.playbackRate = value
  }

  async function next(): Promise<void> {
    const target = nextIndex(trackIndex.value, book.value?.tracks.length ?? 0)
    if (target !== undefined) await playTrack(target)
  }

  async function previous(): Promise<void> {
    const target = previousIndex(trackIndex.value)
    if (target !== undefined) await playTrack(target)
  }

  function close(): void {
    audio.pause()
    isPlaying.value = false
    book.value = undefined
  }

  /** Stop playback and remember where the listener was. */
  function stopForSleep(): void {
    audio.pause()
    isPlaying.value = false
    // A `ended` event may still arrive after the timer stopped; remember that
    // the chain must not roll on to the next chapter.
    sleepStopped = true
    void persist(true)
  }

  /** Stop the ticker and forget any pending sleep timer. */
  function stopSleepTicker(): void {
    if (sleepTicker !== undefined) {
      clearInterval(sleepTicker)
      sleepTicker = undefined
    }
  }

  /**
   * Start a sleep timer.
   *
   * A minute-based timer stops playback at a fixed moment. `end-of-chapter`
   * waits for the current chapter to finish, which is the gentlest way to stop
   * mid-recitation.
   */
  function setSleepTimer(option: SleepTimerOption | number): void {
    const chosen: SleepTimerOption =
      typeof option === 'number' ? { kind: 'minutes', minutes: option, label: `${option} 分钟` } : option

    clearSleepTimer()
    sleepTimer.value = chosen

    if (chosen.kind === 'end-of-chapter') {
      // No deadline: the `ended` handler stops playback instead.
      sleepRemaining.value = undefined
      return
    }

    sleepDeadline = Date.now() + chosen.minutes * 60_000
    sleepRemaining.value = chosen.minutes * 60
    sleepTicker = setInterval(() => {
      const left = sleepRemainingSeconds(sleepDeadline, Date.now())
      sleepRemaining.value = left
      if (left <= 0) {
        stopForSleep()
        clearSleepTimer()
      }
    }, 1_000)
  }

  /** Cancel the sleep timer, leaving playback untouched. */
  function clearSleepTimer(): void {
    stopSleepTicker()
    sleepTimer.value = undefined
    sleepRemaining.value = undefined
  }

  function updateMediaSession(): void {
    const current = book.value
    if (current === undefined || typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
    const session = navigator.mediaSession
    session.metadata = new MediaMetadata({
      title: nowPlayingTitle(current, trackIndex.value),
      artist: current.title,
      album: 'Timbre 听书',
    })
    session.playbackState = isPlaying.value ? 'playing' : 'paused'
  }

  /**
   * Wire the lock-screen panel's seek buttons to the 30 second jumps.
   *
   * The Android app's player has offered ±30s for a long time, and the
   * browser version should not ask the listener to use the track list to
   * rewind thirty seconds.
   */
  function registerMediaSessionActions(): void {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return
    const session = navigator.mediaSession
    const actions: [MediaSessionAction, () => void][] = [
      ['seekbackward', () => skipBack(SKIP_SECONDS)],
      ['seekforward', () => skipForward(SKIP_SECONDS)],
    ]
    for (const [action, handler] of actions) {
      try {
        session.setActionHandler(action, handler)
      } catch {
        // Not every platform implements every action; ignore the ones it lacks.
      }
    }
  }

  const onTimeUpdate = () => {
    currentTime.value = audio.currentTime
    void persist()
  }
  const onDurationChange = () => {
    duration.value = Number.isFinite(audio.duration) ? audio.duration : 0
  }
  /** Apply a seek that was requested before metadata existed. */
  const onLoadedMetadata = () => {
    onDurationChange()
    if (pendingSeek === undefined) return
    audio.currentTime = pendingSeek
    currentTime.value = pendingSeek
    pendingSeek = undefined
  }
  const onPlay = () => {
    isPlaying.value = true
    updateMediaSession()
  }
  const onPause = () => {
    isPlaying.value = false
    updateMediaSession()
  }
  const onError = () => {
    error.value = '无法加载音频，可能是网络或格式问题'
    isPlaying.value = false
  }
  const onEnded = () => {
    void persist(true)
    // A sleep timer set to "end of chapter" stops here instead of rolling on.
    if (sleepTimer.value?.kind === 'end-of-chapter') {
      stopForSleep()
      clearSleepTimer()
      return
    }
    // A late `ended` after the timer stopped must not restart the chain.
    if (sleepStopped) return
    void next()
  }

  audio.addEventListener('timeupdate', onTimeUpdate)
  audio.addEventListener('durationchange', onDurationChange)
  audio.addEventListener('loadedmetadata', onLoadedMetadata)
  audio.addEventListener('play', onPlay)
  audio.addEventListener('pause', onPause)
  audio.addEventListener('error', onError)
  audio.addEventListener('ended', onEnded)
  registerMediaSessionActions()

  onScopeDispose(() => {
    audio.removeEventListener('timeupdate', onTimeUpdate)
    audio.removeEventListener('durationchange', onDurationChange)
    audio.removeEventListener('loadedmetadata', onLoadedMetadata)
    audio.removeEventListener('play', onPlay)
    audio.removeEventListener('pause', onPause)
    audio.removeEventListener('error', onError)
    audio.removeEventListener('ended', onEnded)
    stopSleepTicker()
    audio.pause()
    void persist(true)
  })

  return {
    book,
    trackIndex,
    isPlaying,
    currentTime,
    duration,
    rate,
    error,
    sleepRemaining,
    sleepTimer,
    open,
    toggle,
    playTrack,
    seek,
    skipForward,
    skipBack,
    setRate,
    next,
    previous,
    close,
    setSleepTimer,
    clearSleepTimer,
  }
}
