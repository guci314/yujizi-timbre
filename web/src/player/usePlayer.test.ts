import 'fake-indexeddb/auto'
import { effectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookDetail } from '../core/domain'
import { deleteDatabase, loadProgress } from '../core/storage/db'
import type { AudioLike } from './usePlayer'
import { playbackFailureMessage, usePlayer } from './usePlayer'

/** Mimics the DOMException a browser raises when no gesture asked for playback. */
function notAllowed(): Error {
  const error = new Error('play() failed because the user didn\'t interact with the document first')
  error.name = 'NotAllowedError'
  return error
}

class FakeAudio implements AudioLike {
  src = ''
  crossOrigin: string | null = null
  currentTime = 0
  duration = Number.NaN
  playbackRate = 1
  paused = true
  playCalls = 0
  pauseCalls = 0
  failNextPlay = false
  failWith: Error | undefined
  private listeners = new Map<string, Set<() => void>>()

  play(): Promise<void> {
    this.playCalls += 1
    if (this.failNextPlay) {
      this.failNextPlay = false
      return Promise.reject(this.failWith ?? new Error('blocked'))
    }
    this.paused = false
    this.emit('play')
    return Promise.resolve()
  }

  pause(): void {
    this.pauseCalls += 1
    this.paused = true
    this.emit('pause')
  }

  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) listener()
  }

  /** Simulate the browser finishing metadata loading for the current source. */
  loadMetadata(duration: number): void {
    this.duration = duration
    this.emit('loadedmetadata')
  }
}

const book: BookDetail = {
  slug: 'ddj',
  title: '道德经',
  pageUrl: 'https://www.yujizi.org/道德经.html',
  tracks: [
    { name: '第01课前解说', url: 'https://www.yujizi.org/1.m4a' },
    { name: '第02章', url: 'https://www.yujizi.org/2.m4a' },
    { name: '第03章', url: 'https://www.yujizi.org/3.m4a' },
  ],
}

let audio: FakeAudio
let scope: ReturnType<typeof effectScope>

beforeEach(() => {
  audio = new FakeAudio()
  scope = effectScope()
})

afterEach(async () => {
  scope.stop()
  await deleteDatabase()
})

function playerInScope() {
  return scope.run(() => usePlayer(() => audio))!
}

describe('open', () => {
  it('prepares the first track without playing it', async () => {
    const player = playerInScope()
    await player.open(book)
    expect(player.trackIndex.value).toBe(0)
    expect(audio.src).toBe('https://www.yujizi.org/1.m4a')
    // Browsers reject playback no gesture asked for, so opening must not start it.
    expect(audio.playCalls).toBe(0)
    expect(player.isPlaying.value).toBe(false)
    expect(player.error.value).toBeUndefined()
  })

  it('resumes the saved track and rewinds a few seconds', async () => {
    await expect(
      import('../core/storage/db').then(({ saveProgress }) =>
        saveProgress({ bookSlug: 'ddj', trackIndex: 1, currentTime: 120, updatedAt: 1 }),
      ),
    ).resolves.toBeDefined()

    const player = playerInScope()
    await player.open(book)
    expect(player.trackIndex.value).toBe(1)
    expect(audio.src).toBe('https://www.yujizi.org/2.m4a')

    audio.loadMetadata(600)
    expect(audio.currentTime).toBe(117)
  })

  it('ignores a saved track that no longer exists', async () => {
    const { saveProgress } = await import('../core/storage/db')
    await saveProgress({ bookSlug: 'ddj', trackIndex: 99, currentTime: 10, updatedAt: 1 })

    const player = playerInScope()
    await player.open(book)
    expect(player.trackIndex.value).toBe(0)
  })

  it('honours an explicitly requested track', async () => {
    const { saveProgress } = await import('../core/storage/db')
    await saveProgress({ bookSlug: 'ddj', trackIndex: 0, currentTime: 5, updatedAt: 1 })

    const player = playerInScope()
    await player.open(book, 2)
    expect(player.trackIndex.value).toBe(2)
    expect(audio.currentTime).toBe(0)
  })
})

describe('transport', () => {
  it('reports a real failure instead of throwing when play is rejected', async () => {
    audio.failNextPlay = true
    const player = playerInScope()
    await player.open(book)
    await player.toggle()
    expect(player.error.value).toBe('播放失败，请检查网络后重试')
    expect(player.isPlaying.value).toBe(false)
  })

  it('stays quiet when the browser blocked playback for lack of a gesture', async () => {
    audio.failNextPlay = true
    audio.failWith = notAllowed()
    const player = playerInScope()
    await player.open(book)
    await player.toggle()
    expect(player.error.value).toBeUndefined()
    expect(player.isPlaying.value).toBe(false)
  })

  it('starts playback on a user toggle and pauses again', async () => {
    const player = playerInScope()
    await player.open(book)
    expect(player.isPlaying.value).toBe(false)

    await player.toggle()
    expect(player.isPlaying.value).toBe(true)
    expect(audio.playCalls).toBe(1)

    await player.toggle()
    expect(player.isPlaying.value).toBe(false)
    expect(audio.pauseCalls).toBe(1)
  })

  it('seeks and applies the new position', () => {
    const player = playerInScope()
    player.seek(42)
    expect(audio.currentTime).toBe(42)
    expect(player.currentTime.value).toBe(42)
  })

  it('applies playback rate to the element', () => {
    const player = playerInScope()
    player.setRate(1.5)
    expect(audio.playbackRate).toBe(1.5)
    expect(player.rate.value).toBe(1.5)
  })

  it('advances to the next track and stops at the end', async () => {
    const player = playerInScope()
    await player.open(book)
    await player.next()
    expect(player.trackIndex.value).toBe(1)
    await player.next()
    expect(player.trackIndex.value).toBe(2)
    await player.next()
    expect(player.trackIndex.value).toBe(2)
  })

  it('goes back to the previous track and stops at the start', async () => {
    const player = playerInScope()
    await player.open(book, 2)
    await player.previous()
    expect(player.trackIndex.value).toBe(1)
    await player.previous()
    expect(player.trackIndex.value).toBe(0)
    await player.previous()
    expect(player.trackIndex.value).toBe(0)
  })
})

describe('persistence', () => {
  it('saves progress on a throttled timeupdate', async () => {
    const player = playerInScope()
    await player.open(book)
    audio.currentTime = 30
    audio.emit('timeupdate')
    await vi.waitFor(async () => {
      expect(await loadProgress('ddj')).toBeDefined()
    })
  })

  it('flushes progress when playback pauses', async () => {
    const player = playerInScope()
    await player.open(book)
    await player.toggle()
    audio.currentTime = 55
    await player.toggle()
    await vi.waitFor(async () => {
      const saved = await loadProgress('ddj')
      expect(saved?.currentTime).toBe(55)
    })
  })

  it('flushes progress when the scope is disposed', async () => {
    const player = playerInScope()
    await player.open(book)
    audio.currentTime = 77
    scope.stop()
    await vi.waitFor(async () => {
      const saved = await loadProgress('ddj')
      expect(saved?.currentTime).toBe(77)
    })
    scope = effectScope()
  })
})

describe('playbackFailureMessage', () => {
  it('is silent for a gesture-blocked play', () => {
    expect(playbackFailureMessage(notAllowed())).toBeUndefined()
  })

  it('names a network or decode failure', () => {
    expect(playbackFailureMessage(new Error('boom'))).toBe('播放失败，请检查网络后重试')
  })

  it('handles a non-error rejection', () => {
    expect(playbackFailureMessage('nope')).toBe('播放失败，请检查网络后重试')
  })
})

describe('auto advance', () => {
  it('moves to the next track when the current one ends', async () => {
    const player = playerInScope()
    await player.open(book)
    await player.toggle()
    audio.emit('ended')
    await vi.waitFor(() => {
      expect(player.trackIndex.value).toBe(1)
    })
  })
})

describe('sleep timer', () => {
  // Fake timers are enabled only here: the other suites rely on real timers
  // for `vi.waitFor`, which does not advance a fake clock. `setImmediate` and
  // `queueMicrotask` stay real, because fake-indexeddb schedules its own work
  // through them and would otherwise never settle.
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('stops playback when the timer runs out', async () => {
    const player = playerInScope()
    await player.open(book)
    await player.toggle()
    expect(player.isPlaying.value).toBe(true)

    player.setSleepTimer(1)
    expect(player.sleepRemaining.value).toBeGreaterThan(0)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(player.isPlaying.value).toBe(false)
  })

  it('keeps playing while the timer has not run out', async () => {
    const player = playerInScope()
    await player.open(book)
    await player.toggle()

    player.setSleepTimer(10)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(player.isPlaying.value).toBe(true)
  })

  it('cancels the timer when asked to', async () => {
    const player = playerInScope()
    await player.open(book)
    await player.toggle()

    player.setSleepTimer(5)
    player.clearSleepTimer()
    expect(player.sleepRemaining.value).toBeUndefined()

    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(player.isPlaying.value).toBe(true)
  })

  it('stops at the end of the current chapter', async () => {
    const player = playerInScope()
    await player.open(book)
    await player.toggle()

    player.setSleepTimer({ kind: 'end-of-chapter', minutes: 0, label: '本章结束' })
    audio.emit('ended')
    await vi.waitFor(() => {
      expect(player.isPlaying.value).toBe(false)
    })
    // The chapter must not advance to the next one.
    expect(player.trackIndex.value).toBe(0)
  })

  it('does not roll on to the next chapter after the timer stopped', async () => {
    const player = playerInScope()
    await player.open(book)
    await player.toggle()

    player.setSleepTimer(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(player.isPlaying.value).toBe(false)

    // A late `ended` event must not restart the chain.
    audio.emit('ended')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(player.trackIndex.value).toBe(0)
    expect(player.isPlaying.value).toBe(false)
  })

  it('keeps the timer when the listener pauses and resumes', async () => {
    const player = playerInScope()
    await player.open(book)
    await player.toggle()

    player.setSleepTimer(10)
    await player.toggle()
    expect(player.isPlaying.value).toBe(false)
    expect(player.sleepRemaining.value).toBe(10 * 60)

    await player.toggle()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(player.isPlaying.value).toBe(false)
  })

  it('lets the listener start again after the timer stopped', async () => {
    const player = playerInScope()
    await player.open(book)
    await player.toggle()

    player.setSleepTimer(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(player.isPlaying.value).toBe(false)

    await player.toggle()
    expect(player.isPlaying.value).toBe(true)

    // The chain must work again: a chapter that ends now rolls on.
    audio.emit('ended')
    await vi.waitFor(() => {
      expect(player.trackIndex.value).toBe(1)
    })
  })
})
