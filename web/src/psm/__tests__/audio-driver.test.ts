import { describe, expect, it } from 'vitest'
import type { PlayerContext, PlayerEvent } from '../../pim/player-model'
import { initialPlayerContext } from '../../pim/player-model'
import { AudioDriver, playbackFailureMessage, type AudioLike } from '../audio-driver'

class FakeAudio implements AudioLike {
  src = ''
  currentTime = 0
  duration = 100
  playbackRate = 1
  paused = true
  crossOrigin: string | null = null
  playCalls = 0
  pauseCalls = 0
  /** When set, `play()` rejects with this cause. */
  rejectPlayWith: unknown
  private readonly listeners = new Map<string, Array<() => void>>()

  play(): Promise<void> | void {
    this.playCalls += 1
    if (this.rejectPlayWith !== undefined) return Promise.reject(this.rejectPlayWith)
    this.paused = false
    this.fire('play')
  }

  pause(): void {
    this.pauseCalls += 1
    this.paused = true
  }

  addEventListener(type: string, listener: () => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(listener)
    this.listeners.set(type, list)
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener))
  }

  fire(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }
}

const playingCtx: PlayerContext = {
  ...initialPlayerContext(),
  state: 'S4_PLAYING',
  trackIndex: 1,
  rate: 1.5,
}

function setup(): { audio: FakeAudio; driver: AudioDriver; events: PlayerEvent[] } {
  const audio = new FakeAudio()
  const events: PlayerEvent[] = []
  const driver = new AudioDriver(audio, (event) => events.push(event))
  driver.attach()
  return { audio, driver, events }
}

describe('audio driver effects', () => {
  it('loads a source and applies the rate', () => {
    const { audio, driver } = setup()
    driver.run([{ type: 'AUDIO_LOAD', url: 'https://example.test/1.m4a' }], playingCtx)
    expect(audio.src).toBe('https://example.test/1.m4a')
    expect(audio.playbackRate).toBe(1.5)
  })

  it('seeks the element', () => {
    const { audio, driver } = setup()
    driver.run([{ type: 'AUDIO_SEEK', time: 42 }], playingCtx)
    expect(audio.currentTime).toBe(42)
  })

  it('ignores effects that belong to the store', () => {
    const { audio, driver, events } = setup()
    driver.run([{ type: 'PERSIST_PROGRESS', bookSlug: 'a', trackIndex: 0, currentTime: 1, duration: 2 }], playingCtx)
    expect(audio.playCalls).toBe(0)
    expect(events).toEqual([])
  })
})

describe('audio driver events', () => {
  it('translates metadata and time updates', () => {
    const { audio, driver, events } = setup()
    audio.duration = 123.4
    audio.currentTime = 7
    audio.fire('loadedmetadata')
    audio.fire('timeupdate')
    expect(events).toEqual([
      { type: 'E_META_LOADED', duration: 123.4 },
      { type: 'E_TIME_UPDATE', time: 7 },
    ])
    void driver
  })

  it('reports ended and media errors', () => {
    const { audio, events } = setup()
    audio.fire('ended')
    audio.fire('error')
    expect(events.map((event) => event.type)).toEqual(['E_AUDIO_ENDED', 'E_AUDIO_ERROR'])
  })

  it('suppresses the pause it caused itself', () => {
    const { audio, driver, events } = setup()
    driver.run([{ type: 'AUDIO_PAUSE' }], playingCtx)
    audio.fire('pause')
    expect(events).toEqual([])
  })

  it('reports a pause the system caused', () => {
    const { audio, events } = setup()
    audio.fire('pause')
    expect(events).toEqual([{ type: 'E_PAUSE_EXTERNAL' }])
  })

  it('turns a refusal into E_PLAY_BLOCKED, not an error', () => {
    const { audio, driver, events } = setup()
    audio.rejectPlayWith = Object.assign(new Error('blocked'), { name: 'NotAllowedError' })
    driver.run([{ type: 'AUDIO_PLAY' }], playingCtx)
    return Promise.resolve().then(() => {
      expect(events).toEqual([{ type: 'E_PLAY_BLOCKED' }])
    })
  })

  it('turns other play failures into E_AUDIO_ERROR', () => {
    const { audio, driver, events } = setup()
    audio.rejectPlayWith = new Error('decode failed')
    driver.run([{ type: 'AUDIO_PLAY' }], playingCtx)
    return Promise.resolve().then(() => {
      expect(events).toEqual([{ type: 'E_AUDIO_ERROR', reason: '播放失败，请检查网络后重试' }])
    })
  })
})

describe('playbackFailureMessage', () => {
  it('stays quiet for a refused gesture', () => {
    expect(playbackFailureMessage(Object.assign(new Error('x'), { name: 'NotAllowedError' }))).toBeUndefined()
  })

  it('reports a real failure', () => {
    expect(playbackFailureMessage(new Error('network'))).toBe('播放失败，请检查网络后重试')
  })
})
