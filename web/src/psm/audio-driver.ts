/**
 * Audio driver: translates `AUDIO_*` effects into calls on one
 * `<audio crossorigin="anonymous">`, and media callbacks back into grid events.
 *
 * The grid never touches the element, which is why every historical bug can be
 * replayed in Vitest with a fake element instead of a real iPad.
 */

import type { PlayerContext, PlayerEffect, PlayerEvent } from '../pim/player-model'

/** The slice of HTMLAudioElement the player depends on. */
export interface AudioLike {
  src: string
  currentTime: number
  duration: number
  playbackRate: number
  paused: boolean
  /** Must be set before the first `src`, so cached audio answers byte ranges. */
  crossOrigin: string | null
  play(): Promise<void> | void
  pause(): void
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

export type AudioFactory = () => AudioLike
export type EventSink = (event: PlayerEvent) => void

/**
 * A rejected `play()` is not always a fault. Browsers refuse playback no user
 * gesture asked for, and that refusal must stay quiet instead of blaming the
 * network (see AGENTS.md).
 */
export function playbackFailureMessage(cause: unknown): string | undefined {
  if (cause instanceof DOMException && cause.name === 'NotAllowedError') return undefined
  if (cause instanceof Error && cause.name === 'NotAllowedError') return undefined
  return '播放失败，请检查网络后重试'
}

export function createAudioElement(): AudioLike {
  const audio = new Audio()
  // Required even for same-origin sources: downloaded audio is served from the
  // Cache API, and a cached response only satisfies a ranged request in CORS mode.
  audio.crossOrigin = 'anonymous'
  return audio as unknown as AudioLike
}

export class AudioDriver {
  private expectedPauses = 0

  constructor(
    private readonly audio: AudioLike,
    private readonly emit: EventSink,
  ) {}

  /** Wire the element's callbacks. Returns the detach function. */
  attach(): () => void {
    const on = (type: string, listener: () => void) => this.audio.addEventListener(type, listener)
    const off = (type: string, listener: () => void) => this.audio.removeEventListener(type, listener)

    const onLoadedMetadata = () => {
      const duration = Number.isFinite(this.audio.duration) ? this.audio.duration : 0
      this.emit({ type: 'E_META_LOADED', duration })
    }
    const onDurationChange = () => {
      const duration = Number.isFinite(this.audio.duration) ? this.audio.duration : 0
      if (duration > 0) this.emit({ type: 'E_META_LOADED', duration })
    }
    const onTimeUpdate = () => this.emit({ type: 'E_TIME_UPDATE', time: this.audio.currentTime })
    const onPlay = () => this.emit({ type: 'E_PLAY_STARTED' })
    const onPause = () => {
      if (this.expectedPauses > 0) {
        this.expectedPauses -= 1
        return
      }
      this.emit({ type: 'E_PAUSE_EXTERNAL' })
    }
    const onEnded = () => this.emit({ type: 'E_AUDIO_ENDED' })
    const onError = () => this.emit({ type: 'E_AUDIO_ERROR', reason: '无法加载音频，可能是网络或格式问题' })

    on('loadedmetadata', onLoadedMetadata)
    on('durationchange', onDurationChange)
    on('timeupdate', onTimeUpdate)
    on('play', onPlay)
    on('pause', onPause)
    on('ended', onEnded)
    on('error', onError)

    return () => {
      off('loadedmetadata', onLoadedMetadata)
      off('durationchange', onDurationChange)
      off('timeupdate', onTimeUpdate)
      off('play', onPlay)
      off('pause', onPause)
      off('ended', onEnded)
      off('error', onError)
      this.audio.pause()
    }
  }

  /** Carry out the instructions the grid returned. */
  run(effects: readonly PlayerEffect[], ctx: PlayerContext): void {
    for (const effect of effects) {
      switch (effect.type) {
        case 'AUDIO_LOAD':
          this.audio.src = effect.url
          this.audio.playbackRate = ctx.rate
          break
        case 'AUDIO_PLAY': {
          const outcome = this.audio.play()
          if (outcome instanceof Promise) {
            void outcome.catch((cause: unknown) => {
              const message = playbackFailureMessage(cause)
              // `NotAllowedError` means no user activation, not a fault: the track
              // is loaded, so tell the grid to settle into a paused state.
              if (message === undefined) this.emit({ type: 'E_PLAY_BLOCKED' })
              else this.emit({ type: 'E_AUDIO_ERROR', reason: message })
            })
          }
          break
        }
        case 'AUDIO_PAUSE':
          this.expectedPauses += 1
          this.audio.pause()
          break
        case 'AUDIO_SEEK':
          try {
            this.audio.currentTime = effect.time
          } catch {
            // Setting currentTime on an element with no source throws on some
            // browsers; the staged value is still in the grid and will be
            // committed by the next metadata event.
          }
          break
        case 'AUDIO_RATE':
          this.audio.playbackRate = effect.rate
          break
        default:
          break
      }
    }
  }
}
