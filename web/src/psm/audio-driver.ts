/**
 * 播放伺服驱动：把 PIM 的一句「第 2 篇 321 秒，诵读中」兑现成真正的声音。
 *
 * 浏览器把脏活都塞在这里：
 * - `loadedmetadata` 之前不能定位，且会乱报 0 秒；
 * - 无手势自动开播会被拒（NotAllowedError）；
 * - 网络抖动会出错、会迟到。
 *
 * 驱动器自己用 `pendingSeek` 消化前三件事：目标位置没落定之前，绝不给上层
 * 报任何位置，片头的假 0 秒因此永远传不出去。
 */

import type { PlayerTarget } from './player-target'

/** The slice of HTMLAudioElement this driver depends on. */
export interface AudioLike {
  src: string
  currentTime: number
  duration: number
  playbackRate: number
  paused: boolean
  crossOrigin: string | null
  play(): Promise<void> | void
  pause(): void
  load?(): void
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

export type AudioFactory = () => AudioLike

export interface AudioHooks {
  /** 播放被系统打断或拒绝：交给上层收敛回静置。 */
  onInterrupted(reason: string): void
  /** 真的放不出来：上层展示错误并停下。 */
  onFailed(message: string): void
  /** 篇章诵毕。 */
  onChapterEnded(): void
}

export interface AudioDriver {
  attach(): () => void
  sync(target: PlayerTarget): void
  /** 未落定目标位置前返回 null，避免上层读到片头的假 0 秒。 */
  readonly position: number | null
  readonly duration: number
  dispose(): void
}

export function createAudioElement(): AudioLike {
  const audio = new Audio()
  // 下载过的音频由服务工作线程从缓存取用，跨域模式是分片读取的前提。
  audio.crossOrigin = 'anonymous'
  return audio as unknown as AudioLike
}

/** 定位容差：小于这个差值是自然走动，不是移步。 */
const SEEK_TOLERANCE_SEC = 1.2
const SETTLE_TOLERANCE_SEC = 1.5
const MAX_AUTO_RETRIES = 2

function isRefusal(cause: unknown): boolean {
  if (cause instanceof DOMException && cause.name === 'NotAllowedError') return true
  return cause instanceof Error && cause.name === 'NotAllowedError'
}

export function createAudioDriver(audio: AudioLike, hooks: AudioHooks): AudioDriver {
  let loadedKey: string | null = null
  let pendingSeek: number | null = null
  let retries = 0
  let expectedPauses = 0
  let disposed = false

  const applyPendingSeek = (): void => {
    if (pendingSeek === null) return
    try {
      audio.currentTime = pendingSeek
    } catch {
      // 元素尚无长度时赋值会被拒；下一次 metadata 再试。
    }
  }

  const requestPlay = (): void => {
    const outcome = audio.play()
    if (outcome instanceof Promise) {
      void outcome.catch((cause: unknown) => {
        if (disposed) return
        if (isRefusal(cause)) {
          hooks.onInterrupted('需要点按才能开讲')
          return
        }
        hooks.onFailed('播放失败，请检查网络后重试')
      })
    }
  }

  const onLoadedMetadata = (): void => {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      // 目标位置靠后时，metadata 一到就对齐，接着等 seeked。
      applyPendingSeek()
    }
  }

  const onTimeUpdate = (): void => {
    if (pendingSeek !== null && Math.abs(audio.currentTime - pendingSeek) <= SETTLE_TOLERANCE_SEC) {
      pendingSeek = null
    }
  }

  const onSeeked = (): void => {
    pendingSeek = null
  }

  const onPause = (): void => {
    if (expectedPauses > 0) {
      expectedPauses -= 1
      return
    }
    // 来电、拔耳机、系统打断：按「听众按下暂停」处理。
    hooks.onInterrupted('播放被系统打断')
  }

  const onEnded = (): void => {
    hooks.onChapterEnded()
  }

  const onError = (): void => {
    if (disposed) return
    if (loadedKey !== null && retries < MAX_AUTO_RETRIES) {
      retries += 1
      // 就地重来一次：换源会重置元素状态，这是最便宜的重试。
      audio.src = audio.src
      audio.load?.()
      applyPendingSeek()
      requestPlay()
      return
    }
    hooks.onFailed('无法加载音频，可能是网络或格式问题')
  }

  const on = (type: string, listener: () => void): void => audio.addEventListener(type, listener)
  const off = (type: string, listener: () => void): void => audio.removeEventListener(type, listener)

  on('loadedmetadata', onLoadedMetadata)
  on('seeked', onSeeked)
  on('timeupdate', onTimeUpdate)
  on('pause', onPause)
  on('ended', onEnded)
  on('error', onError)

  const driver: AudioDriver = {
    attach: () => () => driver.dispose(),
    get position() {
      return pendingSeek !== null ? null : audio.currentTime
    },
    get duration() {
      return Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0
    },
    sync(target) {
      if (disposed) return

      if (target.key === null || target.source === null) {
        if (!audio.paused) {
          expectedPauses += 1
          audio.pause()
        }
        loadedKey = null
        pendingSeek = null
        return
      }

      if (target.key !== loadedKey) {
        loadedKey = target.key
        retries = 0
        pendingSeek = target.positionSec > 0 ? target.positionSec : null
        audio.src = target.source
        audio.playbackRate = target.speed
        if (target.playing) requestPlay()
        return
      }

      if (target.speed !== audio.playbackRate) audio.playbackRate = target.speed

      if (pendingSeek === null && Math.abs(audio.currentTime - target.positionSec) > SEEK_TOLERANCE_SEC) {
        pendingSeek = target.positionSec
        applyPendingSeek()
      }

      if (target.playing && audio.paused) {
        requestPlay()
        return
      }
      if (!target.playing && !audio.paused) {
        expectedPauses += 1
        audio.pause()
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      off('loadedmetadata', onLoadedMetadata)
      off('seeked', onSeeked)
      off('timeupdate', onTimeUpdate)
      off('pause', onPause)
      off('ended', onEnded)
      off('error', onError)
      audio.pause()
    },
  }

  return driver
}
