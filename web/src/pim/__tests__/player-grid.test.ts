import { describe, expect, it } from 'vitest'
import type { BookDetail } from '../../core/domain'
import { assertComplete, missingCells, modelCheck, step, type Invariant } from '../kernel'
import { PLAYER_GRID, PLAYER_CELL_COUNT } from '../player-grid'
import {
  initialPlayerContext,
  MAX_AUTO_RETRIES,
  resumePosition,
  type PlayerContext,
  type PlayerEffect,
  type PlayerEvent,
  type PlayerStateId,
} from '../player-model'

function book(slug: string, title: string): BookDetail {
  return {
    slug,
    title,
    pageUrl: `https://www.yujizi.org/${slug}.html`,
    tracks: [1, 2, 3].map((index) => ({ name: `${title} 第${index}章`, url: `https://example.test/${slug}/${index}.m4a` })),
  }
}

const daodejing = book('ddj', '道德经')
const zhuangzi = book('zz', '庄子')

const at = (ctx: PlayerContext, state: PlayerStateId): PlayerContext => ({ ...ctx, state })
const playing = (): PlayerContext =>
  at({ ...initialPlayerContext(), book: daodejing, trackIndex: 0, currentTime: 30, duration: 100 }, 'S4_PLAYING')

describe('I1 completeness', () => {
  it('defines all 7 x 16 = 112 cells', () => {
    expect(PLAYER_CELL_COUNT).toBe(112)
    expect(missingCells(PLAYER_GRID)).toEqual([])
    expect(() => assertComplete(PLAYER_GRID)).not.toThrow()
  })
})

/** Small, finite alphabet: numeric payloads are sampled, not continuous. */
const sampleEvents: PlayerEvent[] = [
  { type: 'E_PREPARE_BOOK', book: zhuangzi, trackIndex: 1, savedTime: 7 },
  { type: 'E_PLAY_AT', book: zhuangzi, trackIndex: 2, startTime: 12 },
  { type: 'E_PLAY_AT', book: daodejing, trackIndex: 1, startTime: 0 },
  { type: 'E_TOGGLE' },
  { type: 'E_SEEK', time: 5 },
  { type: 'E_SEEK', time: 999 },
  { type: 'E_NEXT' },
  { type: 'E_PREV' },
  { type: 'E_SET_RATE', rate: 1.5 },
  { type: 'E_SET_SLEEP', option: { kind: 'minutes', minutes: 0.05, label: '3 秒' } },
  { type: 'E_SET_SLEEP', option: { kind: 'end-of-chapter', label: '本章结束' } },
  { type: 'E_SET_SLEEP', option: null },
  { type: 'E_META_LOADED', duration: 100 },
  { type: 'E_META_LOADED', duration: 20 },
  { type: 'E_TIME_UPDATE', time: 5 },
  { type: 'E_TIME_UPDATE', time: 10 },
  { type: 'E_PLAY_STARTED' },
  { type: 'E_PLAY_BLOCKED' },
  { type: 'E_PAUSE_EXTERNAL' },
  { type: 'E_AUDIO_ENDED' },
  { type: 'E_AUDIO_ERROR', reason: '网络中断' },
  { type: 'E_TICK_1S' },
]

const keyOf = (ctx: PlayerContext): string =>
  [
    ctx.state,
    ctx.book?.slug ?? '-',
    ctx.trackIndex,
    ctx.currentTime,
    ctx.duration,
    ctx.rate,
    ctx.sleepMode,
    ctx.sleepRemainingSec,
    ctx.retryCount,
    ctx.errorMessage ?? '-',
    ctx.seekPending,
    ctx.lastPersistedTime,
  ].join('|')

const invariants: Array<Invariant<PlayerStateId, PlayerContext, PlayerEvent, PlayerEffect>> = [
  {
    id: 'I2_睡眠不可诈尸',
    check: ({ before, after, event }) =>
      before.state === 'S5_SLEEP_STOPPED' && after.state === 'S4_PLAYING' && event.type !== 'E_TOGGLE'
        ? `睡眠停止态被 ${event.type} 拉回播放`
        : undefined,
  },
  {
    id: 'I3_暂停期睡眠冻结',
    check: ({ before, after, event }) =>
      event.type === 'E_TICK_1S' &&
      before.state !== 'S4_PLAYING' &&
      after.sleepRemainingSec !== before.sleepRemainingSec
        ? `非播放态 ${before.state} 的倒计时从 ${before.sleepRemainingSec} 变成 ${after.sleepRemainingSec}`
        : undefined,
  },
  {
    id: 'I5_看书不掐断听书',
    check: ({ before, after, event }) => {
      if (event.type !== 'E_PREPARE_BOOK') return undefined
      if (!['S2_LOADING_PLAY', 'S3_READY_PAUSED', 'S4_PLAYING'].includes(before.state)) return undefined
      return after.book?.slug === before.book?.slug && after.state === before.state
        ? undefined
        : `在 ${before.state} 打开另一本书导致播放会话变更`
    },
  },
  {
    id: 'I4_待提交Seek不可被冲掉',
    check: ({ before, after, event }) => {
      if (!before.seekPending) return undefined
      if (!['E_TIME_UPDATE', 'E_PLAY_STARTED', 'E_TICK_1S'].includes(event.type)) return undefined
      return after.currentTime === before.currentTime && after.seekPending === true
        ? undefined
        : `${event.type} 把待提交的位置从 ${before.currentTime} 冲成 ${after.currentTime}（seekPending=${after.seekPending}）`
    },
  },
  {
    id: 'I7_外部暂停必须离开播放态',
    check: ({ before, after, event }) =>
      before.state === 'S4_PLAYING' && event.type === 'E_PAUSE_EXTERNAL' && after.state === 'S4_PLAYING'
        ? '系统暂停后网格仍认为在播放，睡眠倒计时会继续走'
        : undefined,
  },
]

const report = modelCheck(PLAYER_GRID, {
  initial: initialPlayerContext(),
  events: sampleEvents,
  keyOf,
  invariants,
  maxStates: 20000,
  maxTrace: 14,
})

describe('model check', () => {
  it('reaches every state and violates no invariant', () => {
    expect(report.violations).toEqual([])
    expect(report.reachableStates).toEqual([...report.reachableStates].sort())
    expect(report.reachableStates).toHaveLength(7)
    expect(report.transitions).toBeGreaterThan(500)
  })
})

describe('I4 staged seek', () => {
  const targets = [0, 5, 30, 99, 100, 250]

  for (const state of ['S1_LOADING_PAUSED', 'S2_LOADING_PLAY'] as const) {
    it(`commits the exact target after metadata in ${state}`, () => {
      for (const target of targets) {
        const base = at({ ...initialPlayerContext(), book: daodejing, trackIndex: 0, currentTime: 0 }, state)
        const staged = step(PLAYER_GRID, base, { type: 'E_SEEK', time: target })
        expect(staged.effects).toEqual([])
        expect(staged.ctx.currentTime).toBe(target)

        for (const duration of [100, 40]) {
          const committed = step(PLAYER_GRID, staged.ctx, { type: 'E_META_LOADED', duration })
          const expected = Math.min(target, duration)
          expect(committed.ctx.currentTime).toBe(expected)
          expect(committed.effects).toContainEqual({ type: 'AUDIO_SEEK', time: expected })
        }
      }
    })
  }

  it('never writes currentTime to a not-ready element', () => {
    const base = at({ ...initialPlayerContext(), book: daodejing, trackIndex: 0 }, 'S1_LOADING_PAUSED')
    const staged = step(PLAYER_GRID, base, { type: 'E_SEEK', time: 42 })
    expect(staged.effects.some((effect) => effect.type === 'AUDIO_SEEK')).toBe(false)
  })
})

describe('B1 bookmark hop', () => {
  it('opens the requested book, track and second, and seeks after metadata', () => {
    const hop = step(PLAYER_GRID, playing(), {
      type: 'E_PLAY_AT',
      book: zhuangzi,
      trackIndex: 2,
      startTime: 321,
    })

    expect(hop.ctx.state).toBe('S2_LOADING_PLAY')
    expect(hop.ctx.book?.slug).toBe('zz')
    expect(hop.ctx.trackIndex).toBe(2)
    expect(hop.ctx.currentTime).toBe(321)
    expect(hop.effects).toContainEqual({ type: 'AUDIO_LOAD', url: zhuangzi.tracks[2].url })

    const committed = step(PLAYER_GRID, hop.ctx, { type: 'E_META_LOADED', duration: 900 })
    expect(committed.ctx.currentTime).toBe(321)
    expect(committed.effects).toContainEqual({ type: 'AUDIO_SEEK', time: 321 })

    const audible = step(PLAYER_GRID, committed.ctx, { type: 'E_PLAY_STARTED' })
    expect(audible.ctx.state).toBe('S4_PLAYING')
  })
})

describe('B2 viewing another book', () => {
  it('leaves the playing session untouched', () => {
    const before = playing()
    const after = step(PLAYER_GRID, before, {
      type: 'E_PREPARE_BOOK',
      book: zhuangzi,
      trackIndex: 2,
      savedTime: 0,
    })
    expect(after.ctx).toBe(before)
    expect(after.effects).toEqual([])
  })

  it('still loads a book when the player is idle', () => {
    const after = step(PLAYER_GRID, initialPlayerContext(), {
      type: 'E_PREPARE_BOOK',
      book: zhuangzi,
      trackIndex: 1,
      savedTime: 7,
    })
    expect(after.ctx.state).toBe('S1_LOADING_PAUSED')
    expect(after.ctx.book?.slug).toBe('zz')
    // Natural resume rewinds three seconds (7 -> 4).
    expect(after.ctx.currentTime).toBe(4)
  })
})

describe('I4 staged seek survives an early play event', () => {
  it('does not let timeupdate(0) wipe a bookmark second', () => {
    const hop = step(PLAYER_GRID, playing(), {
      type: 'E_PLAY_AT',
      book: zhuangzi,
      trackIndex: 2,
      startTime: 321,
    })
    // HTML5 fires `play` before `loadedmetadata`, so S4 is reachable while the
    // seek is still staged.
    const started = step(PLAYER_GRID, hop.ctx, { type: 'E_PLAY_STARTED' })
    expect(started.ctx.state).toBe('S4_PLAYING')
    expect(started.ctx.seekPending).toBe(true)

    const early = step(PLAYER_GRID, started.ctx, { type: 'E_TIME_UPDATE', time: 0 })
    expect(early.ctx.currentTime).toBe(321)
    expect(early.ctx.seekPending).toBe(true)
    expect(early.effects).toEqual([])

    const committed = step(PLAYER_GRID, early.ctx, { type: 'E_META_LOADED', duration: 900 })
    expect(committed.ctx.currentTime).toBe(321)
    expect(committed.effects).toContainEqual({ type: 'AUDIO_SEEK', time: 321 })
  })

  it('keeps the staged second across repeated early updates and ticks', () => {
    let ctx = step(PLAYER_GRID, playing(), {
      type: 'E_PLAY_AT',
      book: zhuangzi,
      trackIndex: 2,
      startTime: 321,
    }).ctx
    ctx = step(PLAYER_GRID, ctx, { type: 'E_PLAY_STARTED' }).ctx
    ctx = step(PLAYER_GRID, ctx, { type: 'E_SET_SLEEP', option: { kind: 'minutes', minutes: 1, label: '1 分钟' } }).ctx
    for (let i = 0; i < 5; i += 1) {
      ctx = step(PLAYER_GRID, ctx, { type: 'E_TIME_UPDATE', time: 0 }).ctx
      ctx = step(PLAYER_GRID, ctx, { type: 'E_TICK_1S' }).ctx
    }
    expect(ctx.currentTime).toBe(321)
    expect(ctx.seekPending).toBe(true)
  })
})

describe('resume position', () => {
  it('rewinds three seconds', () => {
    expect(resumePosition(321, 0)).toBe(318)
  })

  it('never rewinds below zero', () => {
    expect(resumePosition(2, 0)).toBe(0)
  })

  it('treats an unknown or zero position as the start', () => {
    expect(resumePosition(0, 0)).toBe(0)
    expect(resumePosition(Number.NaN, 0)).toBe(0)
  })

  it('clamps to the last second when the duration is known', () => {
    expect(resumePosition(200, 100)).toBe(99)
  })

  it('is applied by natural resume only, not by a bookmark hop', () => {
    const resumed = step(PLAYER_GRID, initialPlayerContext(), {
      type: 'E_PREPARE_BOOK',
      book: daodejing,
      trackIndex: 0,
      savedTime: 42,
    })
    expect(resumed.ctx.currentTime).toBe(39)

    const hop = step(PLAYER_GRID, playing(), {
      type: 'E_PLAY_AT',
      book: daodejing,
      trackIndex: 1,
      startTime: 42,
    })
    expect(hop.ctx.currentTime).toBe(42)
  })
})

describe('B5 sleep timer', () => {
  const armed = step(PLAYER_GRID, playing(), {
    type: 'E_SET_SLEEP',
    option: { kind: 'minutes', minutes: 1, label: '1 分钟' },
  }).ctx

  it('freezes while paused', () => {
    const paused = step(PLAYER_GRID, armed, { type: 'E_TOGGLE' }).ctx
    expect(paused.state).toBe('S3_READY_PAUSED')
    let ctx = paused
    for (let i = 0; i < 600; i += 1) ctx = step(PLAYER_GRID, ctx, { type: 'E_TICK_1S' }).ctx
    expect(ctx.sleepRemainingSec).toBe(60)
    expect(ctx.state).toBe('S3_READY_PAUSED')
  })

  it('counts down while playing and stops at zero', () => {
    let ctx = armed
    let stopped = false
    for (let i = 0; i < 61; i += 1) {
      const result = step(PLAYER_GRID, ctx, { type: 'E_TICK_1S' })
      ctx = result.ctx
      if (ctx.state === 'S5_SLEEP_STOPPED') {
        stopped = true
        expect(result.effects.some((effect) => effect.type === 'AUDIO_PAUSE')).toBe(true)
        break
      }
    }
    expect(stopped).toBe(true)
    expect(ctx.sleepMode).toBe('off')
    expect(ctx.sleepRemainingSec).toBe(0)
  })

  it('ignores a late ended after stopping', () => {
    const stopped = step(PLAYER_GRID, armed, { type: 'E_SET_SLEEP', option: null }).ctx
    const sleeping = at(stopped, 'S5_SLEEP_STOPPED')
    const after = step(PLAYER_GRID, sleeping, { type: 'E_AUDIO_ENDED' })
    expect(after.ctx.state).toBe('S5_SLEEP_STOPPED')
    expect(after.effects).toEqual([])
  })

  it('stops at the end of the chapter when asked to', () => {
    const eoc = step(PLAYER_GRID, playing(), {
      type: 'E_SET_SLEEP',
      option: { kind: 'end-of-chapter', label: '本章结束' },
    }).ctx
    const after = step(PLAYER_GRID, eoc, { type: 'E_AUDIO_ENDED' })
    expect(after.ctx.state).toBe('S5_SLEEP_STOPPED')
  })
})

describe('B6 progress on track switch', () => {
  it('writes the outgoing book position before loading the next one', () => {
    const before: PlayerContext = { ...playing(), currentTime: 87.5, lastPersistedTime: 85 }
    const after = step(PLAYER_GRID, before, {
      type: 'E_PLAY_AT',
      book: zhuangzi,
      trackIndex: 0,
      startTime: 0,
    })
    expect(after.effects).toContainEqual({
      type: 'PERSIST_PROGRESS',
      bookSlug: 'ddj',
      trackIndex: 0,
      currentTime: 87.5,
      duration: 100,
    })
  })

  it('throttles time updates per position, not per global clock', () => {
    let ctx = playing()
    const first = step(PLAYER_GRID, ctx, { type: 'E_TIME_UPDATE', time: 31 })
    ctx = first.ctx
    expect(first.effects.filter((effect) => effect.type === 'PERSIST_PROGRESS')).toHaveLength(1)
    const second = step(PLAYER_GRID, ctx, { type: 'E_TIME_UPDATE', time: 32 })
    expect(second.effects.filter((effect) => effect.type === 'PERSIST_PROGRESS')).toHaveLength(0)
    const third = step(PLAYER_GRID, second.ctx, { type: 'E_TIME_UPDATE', time: 36.5 })
    expect(third.effects.filter((effect) => effect.type === 'PERSIST_PROGRESS')).toHaveLength(1)
  })
})

describe('B7 recovery ladder', () => {
  it('retries twice, then parks in the error state', () => {
    let ctx = playing()
    for (let attempt = 0; attempt < MAX_AUTO_RETRIES; attempt += 1) {
      const result = step(PLAYER_GRID, ctx, { type: 'E_AUDIO_ERROR', reason: '网络中断' })
      expect(result.ctx.state).toBe('S2_LOADING_PLAY')
      expect(result.ctx.retryCount).toBe(attempt + 1)
      ctx = result.ctx
    }
    const parked = step(PLAYER_GRID, ctx, { type: 'E_AUDIO_ERROR', reason: '网络中断' })
    expect(parked.ctx.state).toBe('S6_ERROR')
    expect(parked.ctx.errorMessage).toBe('网络中断')
  })

  it('recovers from the error state on an explicit tap', () => {
    const broken = at({ ...playing(), retryCount: MAX_AUTO_RETRIES, errorMessage: '网络中断' }, 'S6_ERROR')
    const after = step(PLAYER_GRID, broken, { type: 'E_TOGGLE' })
    expect(after.ctx.state).toBe('S2_LOADING_PLAY')
    expect(after.ctx.retryCount).toBe(0)
    expect(after.ctx.errorMessage).toBeNull()
    expect(after.effects).toContainEqual({ type: 'AUDIO_LOAD', url: daodejing.tracks[0].url })
  })

  it('reloads from the error state when the listener drags the progress bar', () => {
    const broken = at({ ...playing(), errorMessage: '网络中断' }, 'S6_ERROR')
    const after = step(PLAYER_GRID, broken, { type: 'E_SEEK', time: 44 })
    expect(after.ctx.state).toBe('S1_LOADING_PAUSED')
    expect(after.ctx.currentTime).toBe(44)
    expect(after.ctx.seekPending).toBe(true)
  })
})

describe('pause follows evidence', () => {
  it('leaves playing state when the system pauses us', () => {
    const after = step(PLAYER_GRID, playing(), { type: 'E_PAUSE_EXTERNAL' })
    expect(after.ctx.state).toBe('S3_READY_PAUSED')
  })

  it('settles into a paused state when the browser refuses play', () => {
    const loading = at({ ...initialPlayerContext(), book: daodejing, trackIndex: 0, currentTime: 40 }, 'S2_LOADING_PLAY')
    const beforeMeta = step(PLAYER_GRID, loading, { type: 'E_PLAY_BLOCKED' })
    expect(beforeMeta.ctx.state).toBe('S1_LOADING_PAUSED')
    expect(beforeMeta.ctx.currentTime).toBe(40)

    const ready = at({ ...loading, duration: 100 }, 'S2_LOADING_PLAY')
    const blocked = step(PLAYER_GRID, ready, { type: 'E_PLAY_BLOCKED' })
    expect(blocked.ctx.state).toBe('S3_READY_PAUSED')
    expect(blocked.ctx.currentTime).toBe(40)
  })

  it('does not trust timeupdate as proof of playback', () => {
    const loading = at({ ...initialPlayerContext(), book: daodejing, trackIndex: 0 }, 'S2_LOADING_PLAY')
    const after = step(PLAYER_GRID, loading, { type: 'E_TIME_UPDATE', time: 3 })
    expect(after.ctx.state).toBe('S2_LOADING_PLAY')
  })
})

describe('chapter boundaries', () => {
  it('rolls to the next chapter on ended', () => {
    const next = step(PLAYER_GRID, playing(), { type: 'E_NEXT' })
    expect(next.ctx.trackIndex).toBe(1)
    const audible = step(PLAYER_GRID, next.ctx, { type: 'E_META_LOADED', duration: 100 })
    const started = step(PLAYER_GRID, audible.ctx, { type: 'E_PLAY_STARTED' })
    expect(started.ctx.state).toBe('S4_PLAYING')

    const ended = step(PLAYER_GRID, { ...started.ctx, currentTime: 100 }, { type: 'E_AUDIO_ENDED' })
    expect(ended.ctx.trackIndex).toBe(2)
    expect(ended.ctx.state).toBe('S2_LOADING_PLAY')
  })

  it('stops on the last chapter instead of looping', () => {
    const last = at({ ...playing(), trackIndex: 2, currentTime: 100 }, 'S4_PLAYING')
    const after = step(PLAYER_GRID, last, { type: 'E_AUDIO_ENDED' })
    expect(after.ctx.state).toBe('S3_READY_PAUSED')
    expect(after.effects).toContainEqual({
      type: 'PERSIST_PROGRESS',
      bookSlug: 'ddj',
      trackIndex: 2,
      currentTime: 100,
      duration: 100,
    })
  })
})
