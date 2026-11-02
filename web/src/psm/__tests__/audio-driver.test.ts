import { describe, expect, it } from 'vitest'
import { createAudioDriver, type AudioLike, type AudioHooks } from '../audio-driver'
import type { PlayerTarget } from '../player-target'

class FakeAudio implements AudioLike {
  src = ''
  currentTime = 0
  duration = 100
  playbackRate = 1
  paused = true
  crossOrigin: string | null = null
  playCalls = 0
  pauseCalls = 0
  /** 让下一次 play() 拒绝。 */
  rejectWith: unknown
  private readonly listeners = new Map<string, Array<() => void>>()

  play(): Promise<void> | void {
    this.playCalls += 1
    if (this.rejectWith !== undefined) return Promise.reject(this.rejectWith)
    this.paused = false
    this.fire('play')
  }

  pause(): void {
    this.pauseCalls += 1
    if (this.paused) return
    this.paused = true
    this.fire('pause')
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

interface Recorded {
  interrupted: string[]
  failed: string[]
  ended: number
}

function setup(): { audio: FakeAudio; hooks: Recorded; driver: ReturnType<typeof createAudioDriver> } {
  const audio = new FakeAudio()
  const recorded: Recorded = { interrupted: [], failed: [], ended: 0 }
  const hooks: AudioHooks = {
    onInterrupted: (reason) => recorded.interrupted.push(reason),
    onFailed: (message) => recorded.failed.push(message),
    onChapterEnded: () => {
      recorded.ended += 1
    },
  }
  return { audio, hooks: recorded, driver: createAudioDriver(audio, hooks) }
}

function target(overrides: Partial<PlayerTarget> = {}): PlayerTarget {
  return {
    key: 'ddj#0',
    source: 'https://example.test/1.m4a',
    positionSec: 0,
    speed: 1,
    playing: false,
    ...overrides,
  }
}

describe('换篇章', () => {
  it('换篇即换源，并按语速播放', () => {
    const { audio, driver } = setup()
    driver.sync(target({ key: 'ddj#1', positionSec: 0, speed: 1.5, playing: true }))

    expect(audio.src).toBe('https://example.test/1.m4a')
    expect(audio.playbackRate).toBe(1.5)
    expect(audio.playCalls).toBe(1)
    expect(audio.paused).toBe(false)
  })

  it('静置时只换源不开播', () => {
    const { audio, driver } = setup()
    driver.sync(target({ playing: false }))
    expect(audio.playCalls).toBe(0)
  })
})

describe('定位防腐', () => {
  it('目标位置未落定前不报任何位置（片头假 0 秒被挡住）', () => {
    const { audio, driver } = setup()
    driver.sync(target({ positionSec: 321, playing: true }))

    // 元素刚换源，先乱报一个 0 秒；此时目标尚未落定，绝不能透传。
    audio.currentTime = 0
    audio.fire('timeupdate')
    expect(driver.position).toBeNull()

    // 元数据到达后驱动器把位置对齐，再等 seeked 落定。
    audio.fire('loadedmetadata')
    audio.fire('seeked')
    expect(driver.position).toBe(321)
  })

  it('从 0 秒开讲无需等待定位', () => {
    const { audio, driver } = setup()
    driver.sync(target({ positionSec: 0, playing: true }))
    audio.currentTime = 0
    audio.fire('timeupdate')
    expect(driver.position).toBe(0)
  })

  it('同一篇里大幅移步才重新定位', () => {
    const { audio, driver } = setup()
    driver.sync(target({ positionSec: 0, playing: true }))
    audio.currentTime = 30
    audio.fire('seeked')

    driver.sync(target({ positionSec: 31, playing: true }))
    expect(audio.currentTime).toBe(30)

    driver.sync(target({ positionSec: 90, playing: true }))
    expect(audio.currentTime).toBe(90)
  })

  it('时间流逝到目标附近即视为落定', () => {
    const { audio, driver } = setup()
    driver.sync(target({ positionSec: 60, playing: true }))
    audio.currentTime = 60.4
    audio.fire('timeupdate')
    expect(driver.position).toBe(60.4)
  })
})

describe('暂停与打断', () => {
  it('自己要求暂停不会被当成系统打断', () => {
    const { audio, driver, hooks } = setup()
    driver.sync(target({ positionSec: 0, playing: true }))
    audio.currentTime = 5
    audio.fire('seeked')

    driver.sync(target({ positionSec: 5, playing: false }))
    expect(audio.pauseCalls).toBe(1)
    expect(hooks.interrupted).toEqual([])
  })

  it('系统暂停会通知上层收敛', () => {
    const { audio, hooks } = setup()
    audio.paused = false
    audio.fire('pause')
    expect(hooks.interrupted).toHaveLength(1)
  })

  it('无手势被拒时按打断处理', async () => {
    const { audio, driver, hooks } = setup()
    audio.rejectWith = Object.assign(new Error('blocked'), { name: 'NotAllowedError' })
    driver.sync(target({ playing: true }))
    await Promise.resolve()
    await Promise.resolve()
    expect(hooks.interrupted).toHaveLength(1)
    expect(hooks.failed).toEqual([])
  })

  it('真的放不出来时报告失败', async () => {
    const { audio, driver, hooks } = setup()
    audio.rejectWith = new Error('decode failed')
    driver.sync(target({ playing: true }))
    await Promise.resolve()
    await Promise.resolve()
    expect(hooks.failed).toEqual(['播放失败，请检查网络后重试'])
  })
})

describe('篇章诵毕与出错', () => {
  it('元素报结束时通知上层', () => {
    const { audio, hooks } = setup()
    audio.fire('ended')
    expect(hooks.ended).toBe(1)
  })

  it('出错先就地重试，重试耗尽才报失败', () => {
    const { audio, hooks, driver } = setup()
    driver.sync(target({ playing: true }))
    audio.currentTime = 0

    audio.fire('error')
    audio.fire('error')
    expect(hooks.failed).toEqual([])

    audio.fire('error')
    expect(hooks.failed).toHaveLength(1)
  })
})
