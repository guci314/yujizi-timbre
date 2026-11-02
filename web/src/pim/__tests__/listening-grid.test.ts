import { describe, expect, it } from 'vitest'
import { assertComplete, missingCells, modelCheck, step, type Invariant } from '../kernel'
import { LISTENING_CELL_COUNT, LISTENING_GRID } from '../listening-grid'
import {
  initialListeningContext,
  listeningSnapshot,
  type BookSpec,
  type ListeningContext,
  type ListeningEvent,
  type ListeningStateId,
} from '../listening-model'

function book(id: string, title: string, chapters: number, durationSec = 100): BookSpec {
  return {
    id,
    title,
    chapters: Array.from({ length: chapters }, (_, index) => ({
      index,
      title: `${title}第${index + 1}篇`,
      durationSec,
    })),
  }
}

const ddj = book('ddj', '道德经', 3)
const zz = book('zz', '庄子', 2)

const ctxAt = (state: ListeningStateId, extra: Partial<ListeningContext> = {}): ListeningContext => ({
  ...initialListeningContext(),
  state,
  book: ddj,
  chapterIndex: 0,
  positionSec: 30,
  ...extra,
})

const open = (b: BookSpec = ddj, savedChapter = 0, savedSec = 0): ListeningEvent => ({
  type: 'E_OPEN_BOOK',
  book: b,
  savedChapter,
  savedSec,
})

const jump = (chapterIndex = 1, startSec = 10, b: BookSpec = ddj): ListeningEvent => ({
  type: 'E_JUMP_AND_PLAY',
  book: b,
  chapterIndex,
  startSec,
})

const tick = (currentPositionSec?: number, chapterDurationSec?: number): ListeningEvent => ({
  type: 'E_SECOND_ELAPSED',
  ...(currentPositionSec === undefined ? {} : { currentPositionSec }),
  ...(chapterDurationSec === undefined ? {} : { chapterDurationSec }),
})

describe('I1 完备性', () => {
  it('defines all 4 x 8 = 32 cells', () => {
    expect(LISTENING_CELL_COUNT).toBe(32)
    expect(missingCells(LISTENING_GRID)).toEqual([])
    expect(() => assertComplete(LISTENING_GRID)).not.toThrow()
  })
})

const sampleEvents: ListeningEvent[] = [
  open(zz, 1, 7),
  jump(2, 50),
  { type: 'E_TOGGLE_PLAY' },
  { type: 'E_SEEK', targetSec: 10 },
  { type: 'E_SEEK', targetSec: 999 },
  { type: 'E_NEXT_CHAPTER' },
  { type: 'E_PREV_CHAPTER' },
  { type: 'E_SET_PREF', speed: 1.5 },
  { type: 'E_SET_PREF', sleepOption: { kind: 'minutes', minutes: 3 } },
  { type: 'E_SET_PREF', sleepOption: { kind: 'end-of-chapter' } },
  { type: 'E_SET_PREF', sleepOption: null },
  tick(50, 100),
  tick(99, 100),
  tick(100, 100),
  tick(undefined, 100),
]

const keyOf = (ctx: ListeningContext): string =>
  [
    ctx.state,
    ctx.book?.id ?? '-',
    ctx.chapterIndex,
    ctx.positionSec,
    ctx.speed,
    ctx.sleepMode,
    ctx.sleepRemainingSec,
    ctx.book?.chapters[ctx.chapterIndex]?.durationSec ?? 0,
  ].join('|')

const invariants: Array<Invariant<ListeningStateId, ListeningContext, ListeningEvent>> = [
  {
    id: 'I2_展卷不打扰',
    check: ({ before, after, event }) => {
      if (event.type !== 'E_OPEN_BOOK') return undefined
      if (before.state === 'S0_IDLE') return undefined
      return JSON.stringify(before) === JSON.stringify(after) ? undefined : `${before.state} 下展卷换掉了当前书`
    },
  },
  {
    id: 'I3_静置与止息不流逝',
    check: ({ before, after, event }) => {
      if (event.type !== 'E_SECOND_ELAPSED') return undefined
      if (before.state === 'S2_PLAYING') return undefined
      return JSON.stringify(before) === JSON.stringify(after) ? undefined : `${before.state} 下时间仍在走`
    },
  },
  {
    id: 'I4_倒计时只在诵读中消减',
    check: ({ before, after, event }) => {
      if (event.type !== 'E_SECOND_ELAPSED') return undefined
      if (before.state === 'S2_PLAYING') return undefined
      return after.sleepRemainingSec === before.sleepRemainingSec
        ? undefined
        : `非诵读态倒计时从 ${before.sleepRemainingSec} 变成 ${after.sleepRemainingSec}`
    },
  },
  {
    id: 'I5_止息不诈尸',
    check: ({ before, after, event }) =>
      before.state === 'S3_SLEEP_STOPPED' && event.type === 'E_SECOND_ELAPSED' && after.state === 'S2_PLAYING'
        ? '睡眠止息被一次时间流逝唤醒'
        : undefined,
  },
  {
    id: 'I6_位置不为负',
    check: ({ after }) => (after.positionSec < 0 ? `位置为负：${after.positionSec}` : undefined),
  },
]

const report = modelCheck(LISTENING_GRID, {
  initial: initialListeningContext(),
  events: sampleEvents,
  keyOf,
  invariants,
  maxStates: 20000,
  maxTrace: 12,
})

describe('模型检查', () => {
  it('四个状态全部可达，且没有违例', () => {
    expect(report.violations).toEqual([])
    expect(report.reachableStates).toEqual([
      'S0_IDLE',
      'S1_PAUSED',
      'S2_PLAYING',
      'S3_SLEEP_STOPPED',
    ])
    expect(report.transitions).toBeGreaterThan(200)
  })
})

describe('展卷与点播', () => {
  it('展卷回退三秒接续语境', () => {
    const after = step(LISTENING_GRID, initialListeningContext(), open(ddj, 1, 42))
    expect(after.state).toBe('S1_PAUSED')
    expect(after.chapterIndex).toBe(1)
    expect(after.positionSec).toBe(39)
  })

  it('从头展卷不回退', () => {
    const after = step(LISTENING_GRID, initialListeningContext(), open(ddj, 0, 0))
    expect(after.positionSec).toBe(0)
  })

  it('记错的篇目会被夹回书内', () => {
    const after = step(LISTENING_GRID, initialListeningContext(), open(ddj, 99, 5))
    expect(after.chapterIndex).toBe(2)
  })

  it('空书展卷不改变任何事', () => {
    const before = initialListeningContext()
    expect(step(LISTENING_GRID, before, open(book('empty', '空卷', 0), 0, 9))).toBe(before)
  })

  it('点书签精准跳秒并开讲，不回退', () => {
    const after = step(LISTENING_GRID, ctxAt('S2_PLAYING'), jump(2, 321))
    expect(after.state).toBe('S2_PLAYING')
    expect(after.chapterIndex).toBe(2)
    expect(after.positionSec).toBe(100)
  })

  it('点书签落在章内时原样保留', () => {
    const after = step(LISTENING_GRID, initialListeningContext(), jump(1, 42))
    expect(after.positionSec).toBe(42)
  })

  it('正在诵读时翻看别书目录，纹丝不动', () => {
    const before = ctxAt('S2_PLAYING')
    expect(step(LISTENING_GRID, before, open(zz, 0, 0))).toBe(before)
  })

  it('静置与止息时翻别书目录同样不换书', () => {
    for (const state of ['S1_PAUSED', 'S3_SLEEP_STOPPED'] as const) {
      const before = ctxAt(state)
      expect(step(LISTENING_GRID, before, open(zz, 0, 0))).toBe(before)
    }
  })
})

describe('开讲与暂停', () => {
  it('静置点开讲进诵读', () => {
    expect(step(LISTENING_GRID, ctxAt('S1_PAUSED'), { type: 'E_TOGGLE_PLAY' }).state).toBe('S2_PLAYING')
  })

  it('诵读点暂停回静置', () => {
    expect(step(LISTENING_GRID, ctxAt('S2_PLAYING'), { type: 'E_TOGGLE_PLAY' }).state).toBe('S1_PAUSED')
  })

  it('睡眠止息后主动开讲即唤醒', () => {
    expect(step(LISTENING_GRID, ctxAt('S3_SLEEP_STOPPED'), { type: 'E_TOGGLE_PLAY' }).state).toBe(
      'S2_PLAYING',
    )
  })

  it('未展卷时开讲无效', () => {
    const before = initialListeningContext()
    expect(step(LISTENING_GRID, before, { type: 'E_TOGGLE_PLAY' })).toBe(before)
  })
})

describe('移步', () => {
  it('静置移步仍是静置', () => {
    const after = step(LISTENING_GRID, ctxAt('S1_PAUSED'), { type: 'E_SEEK', targetSec: 61 })
    expect(after.state).toBe('S1_PAUSED')
    expect(after.positionSec).toBe(61)
  })

  it('止息移步回到静置', () => {
    const after = step(LISTENING_GRID, ctxAt('S3_SLEEP_STOPPED', { positionSec: 99 }), {
      type: 'E_SEEK',
      targetSec: 12,
    })
    expect(after.state).toBe('S1_PAUSED')
    expect(after.positionSec).toBe(12)
  })

  it('移步被夹在章内', () => {
    expect(step(LISTENING_GRID, ctxAt('S2_PLAYING'), { type: 'E_SEEK', targetSec: 999 }).positionSec).toBe(100)
    expect(step(LISTENING_GRID, ctxAt('S2_PLAYING'), { type: 'E_SEEK', targetSec: -5 }).positionSec).toBe(0)
  })

  it('未展卷时移步无效', () => {
    const before = initialListeningContext()
    expect(step(LISTENING_GRID, before, { type: 'E_SEEK', targetSec: 10 })).toBe(before)
  })
})

describe('翻章', () => {
  it('下一章从头开讲', () => {
    const after = step(LISTENING_GRID, ctxAt('S2_PLAYING', { positionSec: 88 }), { type: 'E_NEXT_CHAPTER' })
    expect(after.state).toBe('S2_PLAYING')
    expect(after.chapterIndex).toBe(1)
    expect(after.positionSec).toBe(0)
  })

  it('末章再下一章无效', () => {
    const before = ctxAt('S1_PAUSED', { chapterIndex: 2 })
    expect(step(LISTENING_GRID, before, { type: 'E_NEXT_CHAPTER' })).toBe(before)
  })

  it('首章没有上一章', () => {
    const before = ctxAt('S1_PAUSED', { chapterIndex: 0 })
    expect(step(LISTENING_GRID, before, { type: 'E_PREV_CHAPTER' })).toBe(before)
  })

  it('静置按上一章会直接开讲', () => {
    const after = step(LISTENING_GRID, ctxAt('S1_PAUSED', { chapterIndex: 2 }), { type: 'E_PREV_CHAPTER' })
    expect(after.state).toBe('S2_PLAYING')
    expect(after.chapterIndex).toBe(1)
  })
})

describe('语速与睡眠香', () => {
  it('调语速不改变状态', () => {
    const after = step(LISTENING_GRID, ctxAt('S2_PLAYING'), { type: 'E_SET_PREF', speed: 1.5 })
    expect(after.speed).toBe(1.5)
    expect(after.state).toBe('S2_PLAYING')
  })

  it('设一分钟睡眠香', () => {
    const after = step(LISTENING_GRID, ctxAt('S2_PLAYING'), {
      type: 'E_SET_PREF',
      sleepOption: { kind: 'minutes', minutes: 1 },
    })
    expect(after.sleepMode).toBe('minutes')
    expect(after.sleepRemainingSec).toBe(60)
  })

  it('本章诵毕的睡眠香不产生倒计时', () => {
    const after = step(LISTENING_GRID, ctxAt('S2_PLAYING'), {
      type: 'E_SET_PREF',
      sleepOption: { kind: 'end-of-chapter' },
    })
    expect(after.sleepMode).toBe('end-of-chapter')
    expect(after.sleepRemainingSec).toBe(0)
  })

  it('取消睡眠香即归零', () => {
    const before = ctxAt('S2_PLAYING', { sleepMode: 'minutes', sleepRemainingSec: 42 })
    const after = step(LISTENING_GRID, before, { type: 'E_SET_PREF', sleepOption: null })
    expect(after.sleepMode).toBe('off')
    expect(after.sleepRemainingSec).toBe(0)
  })
})

describe('时间流逝', () => {
  it('诵读中推进播放头', () => {
    const after = step(LISTENING_GRID, ctxAt('S2_PLAYING', { positionSec: 10 }), tick(11, 100))
    expect(after.positionSec).toBe(11)
  })

  it('静置中时间不走', () => {
    const before = ctxAt('S1_PAUSED')
    expect(step(LISTENING_GRID, before, tick(99, 100))).toBe(before)
  })

  it('睡眠止息后时间不走', () => {
    const before = ctxAt('S3_SLEEP_STOPPED')
    expect(step(LISTENING_GRID, before, tick(99, 100))).toBe(before)
  })

  it('暂停时睡眠倒计时冻结', () => {
    let ctx = ctxAt('S2_PLAYING', { sleepMode: 'minutes', sleepRemainingSec: 60 })
    ctx = step(LISTENING_GRID, ctx, { type: 'E_TOGGLE_PLAY' })
    for (let i = 0; i < 300; i += 1) ctx = step(LISTENING_GRID, ctx, tick(30, 100))
    expect(ctx.state).toBe('S1_PAUSED')
    expect(ctx.sleepRemainingSec).toBe(60)
  })

  it('诵读时睡眠倒计时归零即止息', () => {
    let ctx = ctxAt('S2_PLAYING', { sleepMode: 'minutes', sleepRemainingSec: 2 })
    ctx = step(LISTENING_GRID, ctx, tick(31, 100))
    expect(ctx.state).toBe('S2_PLAYING')
    expect(ctx.sleepRemainingSec).toBe(1)
    ctx = step(LISTENING_GRID, ctx, tick(32, 100))
    expect(ctx.state).toBe('S3_SLEEP_STOPPED')
    expect(ctx.sleepMode).toBe('off')
    expect(ctx.sleepRemainingSec).toBe(0)
  })

  it('章尾自动续下一章', () => {
    const after = step(LISTENING_GRID, ctxAt('S2_PLAYING', { positionSec: 99 }), tick(100, 100))
    expect(after.state).toBe('S2_PLAYING')
    expect(after.chapterIndex).toBe(1)
    expect(after.positionSec).toBe(0)
  })

  it('设了本章诵毕则章尾止息', () => {
    const before = ctxAt('S2_PLAYING', {
      positionSec: 99,
      sleepMode: 'end-of-chapter',
      sleepRemainingSec: 0,
    })
    const after = step(LISTENING_GRID, before, tick(100, 100))
    expect(after.state).toBe('S3_SLEEP_STOPPED')
    expect(after.sleepMode).toBe('off')
  })

  it('全书诵毕回到静置', () => {
    const before = ctxAt('S2_PLAYING', { chapterIndex: 2, positionSec: 99 })
    const after = step(LISTENING_GRID, before, tick(100, 100))
    expect(after.state).toBe('S1_PAUSED')
    expect(after.positionSec).toBe(100)
  })

  it('诵读中获知篇章时长', () => {
    const unknown = {
      ...ddj,
      chapters: ddj.chapters.map((entry) => ({ ...entry, durationSec: 0 })),
    }
    const before: ListeningContext = { ...ctxAt('S2_PLAYING'), book: unknown }
    const after = step(LISTENING_GRID, before, tick(12, 300))
    expect(after.book?.chapters[0].durationSec).toBe(300)
    expect(after.positionSec).toBe(12)
  })

  it('未知时长时不会误判章尾', () => {
    const unknown = {
      ...ddj,
      chapters: ddj.chapters.map((entry) => ({ ...entry, durationSec: 0 })),
    }
    const before: ListeningContext = { ...ctxAt('S2_PLAYING', { positionSec: 5000 }), book: unknown }
    const after = step(LISTENING_GRID, before, tick(5001))
    expect(after.state).toBe('S2_PLAYING')
    expect(after.chapterIndex).toBe(0)
  })
})

describe('快照', () => {
  it('只暴露纯业务字段', () => {
    const snapshot = listeningSnapshot(ctxAt('S2_PLAYING', { chapterIndex: 1, positionSec: 12 }))
    expect(snapshot).toEqual({
      state: 'S2_PLAYING',
      bookId: 'ddj',
      chapterIndex: 1,
      positionSec: 12,
      speed: 1,
      sleepMode: 'off',
      sleepRemainingSec: 0,
      chapterDurationSec: 100,
    })
  })
})
