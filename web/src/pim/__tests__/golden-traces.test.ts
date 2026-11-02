import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { step } from '../kernel'
import { LISTENING_CELL_COUNT, LISTENING_GRID } from '../listening-grid'
import {
  initialListeningContext,
  listeningSnapshot,
  type BookSpec,
  type ListeningEvent,
  type ListeningSnapshot,
  type SleepOption,
} from '../listening-model'
import { RETENTION_CELL_COUNT, RETENTION_GRID } from '../retention-grid'
import {
  initialRetentionContext,
  retentionSnapshot,
  type RetentionEvent,
  type RetentionSnapshot,
} from '../retention-model'

/**
 * 三端通用黄金考卷。
 *
 * 这里既生成它、又回放它：Android 端用同一个 JSON 跑 JUnit 对拍，任何一端
 * 私自改了业务规矩，都会在另一端炸出来。
 */

const here = process.cwd()
const outFile = path.resolve(here, '../shared/golden-traces.json')

function book(id: string, title: string, chapters: number, durationSec: number): BookSpec {
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

const ddj = book('ddj', '道德经', 3, 100)
const zz = book('zz', '庄子', 2, 100)
const books: BookSpec[] = [ddj, zz]

const open = (b: BookSpec, savedChapter: number, savedSec: number): ListeningEvent => ({
  type: 'E_OPEN_BOOK',
  book: b,
  savedChapter,
  savedSec,
})
const jump = (b: BookSpec, chapterIndex: number, startSec: number): ListeningEvent => ({
  type: 'E_JUMP_AND_PLAY',
  book: b,
  chapterIndex,
  startSec,
})
const pref = (speed?: number, sleepOption?: SleepOption | null): ListeningEvent => ({
  type: 'E_SET_PREF',
  ...(speed === undefined ? {} : { speed }),
  ...(sleepOption === undefined ? {} : { sleepOption }),
})
const tick = (currentPositionSec?: number, chapterDurationSec?: number): ListeningEvent => ({
  type: 'E_SECOND_ELAPSED',
  ...(currentPositionSec === undefined ? {} : { currentPositionSec }),
  ...(chapterDurationSec === undefined ? {} : { chapterDurationSec }),
})
const ticks = (count: number, stepSec = 1, durationSec = 100): ListeningEvent[] =>
  Array.from({ length: count }, (_, index) => tick((index + 1) * stepSec, durationSec))

/** 走到某个状态所需的前置事件。 */
const listeningSetup: Record<string, ListeningEvent[]> = {
  S0_IDLE: [],
  S1_PAUSED: [open(ddj, 1, 42)],
  S2_PLAYING: [jump(ddj, 1, 10)],
  S3_SLEEP_STOPPED: [
    jump(ddj, 2, 99),
    pref(undefined, { kind: 'end-of-chapter' }),
    tick(100, 100),
  ],
}

const listeningEvents: ListeningEvent[] = [
  open(zz, 1, 7),
  jump(ddj, 2, 42),
  { type: 'E_TOGGLE_PLAY' },
  { type: 'E_SEEK', targetSec: 37 },
  { type: 'E_NEXT_CHAPTER' },
  { type: 'E_PREV_CHAPTER' },
  pref(1.25, { kind: 'minutes', minutes: 12 }),
  tick(99, 100),
]

const listeningScenarios: Array<{ id: string; events: ListeningEvent[] }> = [
  { id: 'L-展卷回退三秒', events: [open(ddj, 1, 42)] },
  { id: 'L-点书签精准跳秒', events: [jump(ddj, 2, 42)] },
  { id: 'L-翻看别书不打断诵读', events: [jump(ddj, 0, 30), open(zz, 0, 0)] },
  { id: 'L-章尾自动续章', events: [jump(ddj, 0, 99), tick(100, 100)] },
  { id: 'L-全书诵毕回静置', events: [jump(ddj, 2, 99), tick(100, 100)] },
  { id: 'L-本章诵毕即止息', events: [jump(ddj, 1, 99), pref(undefined, { kind: 'end-of-chapter' }), tick(100, 100)] },
  {
    id: 'L-暂停时睡眠倒计时冻结',
    events: [jump(ddj, 0, 5), pref(undefined, { kind: 'minutes', minutes: 1 }), { type: 'E_TOGGLE_PLAY' }, ...ticks(3, 6)],
  },
  {
    id: 'L-睡眠到点止息',
    events: [jump(ddj, 0, 5), pref(undefined, { kind: 'minutes', minutes: 1 }), ...ticks(60)],
  },
  { id: 'L-止息后主动开讲唤醒', events: [jump(ddj, 2, 99), pref(undefined, { kind: 'end-of-chapter' }), tick(100, 100), { type: 'E_TOGGLE_PLAY' }] },
  { id: 'L-止息后移步回到静置', events: [jump(ddj, 2, 99), pref(undefined, { kind: 'end-of-chapter' }), tick(100, 100), { type: 'E_SEEK', targetSec: 20 }] },
]

const retentionSetup: Record<string, RetentionEvent[]> = {
  D0_NOT_KEPT: [],
  D1_KEEPING: [{ type: 'E_REQUEST_KEEP' }, { type: 'E_KEEP_PROGRESS', pct: 40 }],
  D2_KEPT: [{ type: 'E_REQUEST_KEEP' }, { type: 'E_VERIFIED_COMPLETE', space: 4096 }],
  D3_FAILED: [{ type: 'E_REQUEST_KEEP' }, { type: 'E_KEEP_FAILED', reason: 'SOURCE_UNREACHABLE' }],
}

const retentionEvents: RetentionEvent[] = [
  { type: 'E_REQUEST_KEEP' },
  { type: 'E_KEEP_PROGRESS', pct: 65 },
  { type: 'E_VERIFIED_COMPLETE', space: 8192 },
  { type: 'E_KEEP_FAILED', reason: 'SPACE_FULL' },
  { type: 'E_RELEASE' },
]

const retentionScenarios: Array<{ id: string; events: RetentionEvent[] }> = [
  { id: 'R-整篇留存', events: [{ type: 'E_REQUEST_KEEP' }, { type: 'E_KEEP_PROGRESS', pct: 30 }, { type: 'E_KEEP_PROGRESS', pct: 100 }, { type: 'E_VERIFIED_COMPLETE', space: 4096 }] },
  { id: 'R-留存未果再重试', events: [{ type: 'E_REQUEST_KEEP' }, { type: 'E_KEEP_FAILED', reason: 'CONTENT_CORRUPTED' }, { type: 'E_REQUEST_KEEP' }, { type: 'E_VERIFIED_COMPLETE', space: 2048 }] },
  { id: 'R-未留存的迟到完好不入箧', events: [{ type: 'E_VERIFIED_COMPLETE', space: 4096 }] },
  { id: 'R-未果的迟到完好不入箧', events: [{ type: 'E_REQUEST_KEEP' }, { type: 'E_KEEP_FAILED', reason: 'SPACE_FULL' }, { type: 'E_VERIFIED_COMPLETE', space: 4096 }] },
  { id: 'R-留存中释出', events: [{ type: 'E_REQUEST_KEEP' }, { type: 'E_KEEP_PROGRESS', pct: 80 }, { type: 'E_RELEASE' }] },
  { id: 'R-释出即净', events: [{ type: 'E_REQUEST_KEEP' }, { type: 'E_VERIFIED_COMPLETE', space: 4096 }, { type: 'E_RELEASE' }] },
]

type JsonListeningEvent =
  | { type: 'E_OPEN_BOOK'; bookId: string; savedChapter: number; savedSec: number }
  | { type: 'E_JUMP_AND_PLAY'; bookId: string; chapterIndex: number; startSec: number }
  | { type: 'E_TOGGLE_PLAY' }
  | { type: 'E_SEEK'; targetSec: number; chapterDurationSec?: number }
  | { type: 'E_NEXT_CHAPTER' }
  | { type: 'E_PREV_CHAPTER' }
  | { type: 'E_SET_PREF'; speed?: number; sleepOption?: SleepOption | null }
  | { type: 'E_SECOND_ELAPSED'; currentPositionSec?: number; chapterDurationSec?: number }

function encodeListening(event: ListeningEvent): JsonListeningEvent {
  switch (event.type) {
    case 'E_OPEN_BOOK':
      return { type: event.type, bookId: event.book.id, savedChapter: event.savedChapter, savedSec: event.savedSec }
    case 'E_JUMP_AND_PLAY':
      return { type: event.type, bookId: event.book.id, chapterIndex: event.chapterIndex, startSec: event.startSec }
    case 'E_SEEK':
      return { type: event.type, targetSec: event.targetSec, ...(event.chapterDurationSec === undefined ? {} : { chapterDurationSec: event.chapterDurationSec }) }
    case 'E_SET_PREF':
      return { type: event.type, ...(event.speed === undefined ? {} : { speed: event.speed }), ...(event.sleepOption === undefined ? {} : { sleepOption: event.sleepOption }) }
    case 'E_SECOND_ELAPSED':
      return { type: event.type, ...(event.currentPositionSec === undefined ? {} : { currentPositionSec: event.currentPositionSec }), ...(event.chapterDurationSec === undefined ? {} : { chapterDurationSec: event.chapterDurationSec }) }
    default:
      return { type: event.type }
  }
}

function decodeListening(event: JsonListeningEvent, byId: Map<string, BookSpec>): ListeningEvent {
  switch (event.type) {
    case 'E_OPEN_BOOK': {
      const book = byId.get(event.bookId)
      if (book === undefined) throw new Error(`未知经书 ${event.bookId}`)
      return { type: event.type, book, savedChapter: event.savedChapter, savedSec: event.savedSec }
    }
    case 'E_JUMP_AND_PLAY': {
      const book = byId.get(event.bookId)
      if (book === undefined) throw new Error(`未知经书 ${event.bookId}`)
      return { type: event.type, book, chapterIndex: event.chapterIndex, startSec: event.startSec }
    }
    default:
      return event as ListeningEvent
  }
}

interface ListeningTraceJson {
  id: string
  steps: Array<{ event: JsonListeningEvent; expect: ListeningSnapshot }>
}
interface RetentionTraceJson {
  id: string
  steps: Array<{ event: RetentionEvent; expect: RetentionSnapshot }>
}

function recordListening(id: string, events: ListeningEvent[]): ListeningTraceJson {
  let ctx = initialListeningContext()
  const steps: ListeningTraceJson['steps'] = []
  for (const event of events) {
    ctx = step(LISTENING_GRID, ctx, event)
    steps.push({ event: encodeListening(event), expect: listeningSnapshot(ctx) })
  }
  return { id, steps }
}

function recordRetention(id: string, events: RetentionEvent[]): RetentionTraceJson {
  let ctx = initialRetentionContext('ddj', 0)
  const steps: RetentionTraceJson['steps'] = []
  for (const event of events) {
    ctx = step(RETENTION_GRID, ctx, event)
    steps.push({ event, expect: retentionSnapshot(ctx) })
  }
  return { id, steps }
}

function buildGolden() {
  const listeningTraces: ListeningTraceJson[] = []
  for (const [state, setup] of Object.entries(listeningSetup)) {
    for (const event of listeningEvents) {
      listeningTraces.push(recordListening(`L-格-${state}-${event.type}`, [...setup, event]))
    }
  }
  for (const scenario of listeningScenarios) {
    listeningTraces.push(recordListening(scenario.id, scenario.events))
  }

  const retentionTraces: RetentionTraceJson[] = []
  for (const [state, setup] of Object.entries(retentionSetup)) {
    for (const event of retentionEvents) {
      retentionTraces.push(recordRetention(`R-格-${state}-${event.type}`, [...setup, event]))
    }
  }
  for (const scenario of retentionScenarios) {
    retentionTraces.push(recordRetention(scenario.id, scenario.events))
  }

  return {
    version: 1,
    comment:
      '玉机子听书纯业务 PIM 黄金考卷：由 web/src/pim 生成，Android JUnit 与 Web Vitest 共用。事件里的 bookId 对应 books。',
    books,
    listening: {
      states: LISTENING_GRID.states,
      events: LISTENING_GRID.events,
      cells: LISTENING_CELL_COUNT,
      initial: listeningSnapshot(initialListeningContext()),
      traces: listeningTraces,
    },
    retention: {
      states: RETENTION_GRID.states,
      events: RETENTION_GRID.events,
      cells: RETENTION_CELL_COUNT,
      initial: { bookId: 'ddj', chapterIndex: 0 },
      traces: retentionTraces,
    },
  }
}

const golden = buildGolden()
const serialized = `${JSON.stringify(golden, null, 2)}\n`

describe('黄金考卷导出', () => {
  it('覆盖全部 32 + 20 个格子', () => {
    const listeningCovered = new Set<string>()
    for (const trace of golden.listening.traces) {
      let ctx = initialListeningContext()
      for (const entry of trace.steps) {
        const key = `${ctx.state}|${entry.event.type}`
        listeningCovered.add(key)
        ctx = step(LISTENING_GRID, ctx, decodeListening(entry.event, new Map(books.map((b) => [b.id, b]))))
      }
    }
    expect(listeningCovered.size).toBe(LISTENING_CELL_COUNT)

    const retentionCovered = new Set<string>()
    for (const trace of golden.retention.traces) {
      let ctx = initialRetentionContext('ddj', 0)
      for (const entry of trace.steps) {
        retentionCovered.add(`${ctx.state}|${entry.event.type}`)
        ctx = step(RETENTION_GRID, ctx, entry.event)
      }
    }
    expect(retentionCovered.size).toBe(RETENTION_CELL_COUNT)
  })

  it('与仓库里的 golden-traces.json 完全一致', () => {
    if (process.env.UPDATE_GOLDEN === '1') {
      mkdirSync(path.dirname(outFile), { recursive: true })
      writeFileSync(outFile, serialized, 'utf8')
      return
    }
    const onDisk = readFileSync(outFile, 'utf8')
    expect(onDisk).toBe(serialized)
  })
})

describe('黄金考卷回放', () => {
  const byId = new Map(books.map((b) => [b.id, b]))

  it('听书考卷逐格对得上', () => {
    for (const trace of golden.listening.traces) {
      let ctx = initialListeningContext()
      for (const entry of trace.steps) {
        ctx = step(LISTENING_GRID, ctx, decodeListening(entry.event, byId))
        expect(listeningSnapshot(ctx), `${trace.id} 在 ${entry.event.type} 之后`).toEqual(entry.expect)
      }
    }
  })

  it('书箧考卷逐格对得上', () => {
    for (const trace of golden.retention.traces) {
      let ctx = initialRetentionContext('ddj', 0)
      for (const entry of trace.steps) {
        ctx = step(RETENTION_GRID, ctx, entry.event)
        expect(retentionSnapshot(ctx), `${trace.id} 在 ${entry.event.type} 之后`).toEqual(entry.expect)
      }
    }
  })
})
