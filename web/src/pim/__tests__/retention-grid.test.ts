import { describe, expect, it } from 'vitest'
import { assertComplete, missingCells, modelCheck, step, type Invariant } from '../kernel'
import { RETENTION_CELL_COUNT, RETENTION_GRID } from '../retention-grid'
import {
  initialRetentionContext,
  retentionSnapshot,
  type RetentionContext,
  type RetentionEvent,
  type RetentionStateId,
} from '../retention-model'
import { bookcaseBooks, isBookInBookcase, isChapterAvailable, keptChapterIndexes, mergeShelf } from '../shelf'
import type { BookSpec } from '../listening-model'

const ctxAt = (state: RetentionStateId, extra: Partial<RetentionContext> = {}): RetentionContext => ({
  ...initialRetentionContext('ddj', 1),
  state,
  ...extra,
})

const at = (state: RetentionStateId): RetentionContext => {
  const base = initialRetentionContext('ddj', 1)
  switch (state) {
    case 'D1_KEEPING':
      return { ...base, state, progressPct: 40 }
    case 'D2_KEPT':
      return { ...base, state, progressPct: 100, occupiedSpace: 1024 }
    case 'D3_FAILED':
      return { ...base, state, failReason: 'SOURCE_UNREACHABLE' }
    default:
      return { ...base, state }
  }
}

describe('I1 完备性', () => {
  it('defines all 4 x 5 = 20 cells', () => {
    expect(RETENTION_CELL_COUNT).toBe(20)
    expect(missingCells(RETENTION_GRID)).toEqual([])
    expect(() => assertComplete(RETENTION_GRID)).not.toThrow()
  })
})

const sampleEvents: RetentionEvent[] = [
  { type: 'E_REQUEST_KEEP' },
  { type: 'E_KEEP_PROGRESS', pct: 55 },
  { type: 'E_KEEP_PROGRESS', pct: 500 },
  { type: 'E_VERIFIED_COMPLETE', space: 4096 },
  { type: 'E_VERIFIED_COMPLETE', space: 0 },
  { type: 'E_KEEP_FAILED', reason: 'SPACE_FULL' },
  { type: 'E_KEEP_FAILED', reason: 'CONTENT_CORRUPTED' },
  { type: 'E_RELEASE' },
]

const keyOf = (ctx: RetentionContext): string =>
  [ctx.state, ctx.progressPct, ctx.occupiedSpace, ctx.failReason ?? '-'].join('|')

const invariants: Array<Invariant<RetentionStateId, RetentionContext, RetentionEvent>> = [
  {
    id: 'I_DL_1_非已入箧零占用',
    check: ({ after }) =>
      after.state !== 'D2_KEPT' && after.occupiedSpace !== 0
        ? `${after.state} 仍占着 ${after.occupiedSpace}`
        : undefined,
  },
  {
    id: 'I_DL_2_未验明不入箧',
    check: ({ before, after, event }) => {
      if (after.state !== 'D2_KEPT') return undefined
      if (before.state === 'D2_KEPT') return undefined
      return event.type === 'E_VERIFIED_COMPLETE' ? undefined : `经 ${event.type} 进了已留存`
    },
  },
  {
    id: 'I_DL_3_失败必零占用',
    check: ({ before, after, event }) =>
      event.type === 'E_KEEP_FAILED' &&
      before.state === 'D1_KEEPING' &&
      (after.state !== 'D3_FAILED' || after.occupiedSpace !== 0)
        ? `留存受阻后状态 ${after.state} 占地 ${after.occupiedSpace}`
        : undefined,
  },
  {
    id: 'I_DL_4_释出即净且不诈尸',
    check: ({ after, event }) =>
      event.type === 'E_RELEASE' &&
      (after.state !== 'D0_NOT_KEPT' ||
        after.progressPct !== 0 ||
        after.occupiedSpace !== 0 ||
        after.failReason !== null)
        ? '释出后没有一步归零'
        : undefined,
  },
  {
    id: 'I_DL_5_进度有界',
    check: ({ after }) =>
      after.progressPct < 0 || after.progressPct > 100 ? `进度越界：${after.progressPct}` : undefined,
  },
]

const report = modelCheck(RETENTION_GRID, {
  initial: initialRetentionContext('ddj', 1),
  events: sampleEvents,
  keyOf,
  invariants,
  maxStates: 5000,
  maxTrace: 10,
})

describe('模型检查', () => {
  it('四个状态全部可达，且没有违例', () => {
    expect(report.violations).toEqual([])
    expect(report.reachableStates).toEqual(['D0_NOT_KEPT', 'D1_KEEPING', 'D2_KEPT', 'D3_FAILED'])
  })
})

describe('留存流程', () => {
  it('请求留存从零开始', () => {
    const after = step(RETENTION_GRID, ctxAt('D0_NOT_KEPT'), { type: 'E_REQUEST_KEEP' })
    expect(after.state).toBe('D1_KEEPING')
    expect(after.progressPct).toBe(0)
    expect(after.occupiedSpace).toBe(0)
  })

  it('留存中重复请求被忽略', () => {
    const before = at('D1_KEEPING')
    expect(step(RETENTION_GRID, before, { type: 'E_REQUEST_KEEP' })).toBe(before)
  })

  it('进度被夹在 0..100', () => {
    expect(
      step(RETENTION_GRID, at('D1_KEEPING'), { type: 'E_KEEP_PROGRESS', pct: 500 }).progressPct,
    ).toBe(100)
    expect(
      step(RETENTION_GRID, at('D1_KEEPING'), { type: 'E_KEEP_PROGRESS', pct: -20 }).progressPct,
    ).toBe(0)
  })

  it('验明完好才入箧', () => {
    const after = step(RETENTION_GRID, at('D1_KEEPING'), { type: 'E_VERIFIED_COMPLETE', space: 2048 })
    expect(after.state).toBe('D2_KEPT')
    expect(after.progressPct).toBe(100)
    expect(after.occupiedSpace).toBe(2048)
  })

  it('零空间的「完好」不算入箧', () => {
    const before = at('D1_KEEPING')
    expect(step(RETENTION_GRID, before, { type: 'E_VERIFIED_COMPLETE', space: 0 })).toBe(before)
  })

  it('留存受阻记下缘由且不占空间', () => {
    const after = step(RETENTION_GRID, at('D1_KEEPING'), {
      type: 'E_KEEP_FAILED',
      reason: 'SPACE_FULL',
    })
    expect(after.state).toBe('D3_FAILED')
    expect(after.failReason).toBe('SPACE_FULL')
    expect(after.occupiedSpace).toBe(0)
    expect(after.progressPct).toBe(0)
  })

  it('未果可重试', () => {
    const after = step(RETENTION_GRID, at('D3_FAILED'), { type: 'E_REQUEST_KEEP' })
    expect(after.state).toBe('D1_KEEPING')
    expect(after.failReason).toBeNull()
  })

  it('未果时迟到的「完好」绝不诈尸', () => {
    const before = at('D3_FAILED')
    expect(step(RETENTION_GRID, before, { type: 'E_VERIFIED_COMPLETE', space: 999 })).toBe(before)
  })

  it('未留存时迟到的进度与完好都被忽略', () => {
    const before = ctxAt('D0_NOT_KEPT')
    expect(step(RETENTION_GRID, before, { type: 'E_KEEP_PROGRESS', pct: 80 })).toBe(before)
    expect(step(RETENTION_GRID, before, { type: 'E_VERIFIED_COMPLETE', space: 999 })).toBe(before)
  })

  it('留存中释出会中断并归零', () => {
    const after = step(RETENTION_GRID, at('D1_KEEPING'), { type: 'E_RELEASE' })
    expect(after.state).toBe('D0_NOT_KEPT')
    expect(after.progressPct).toBe(0)
    expect(after.occupiedSpace).toBe(0)
  })

  it('释出已入箧的篇章', () => {
    const after = step(RETENTION_GRID, at('D2_KEPT'), { type: 'E_RELEASE' })
    expect(after.state).toBe('D0_NOT_KEPT')
    expect(after.occupiedSpace).toBe(0)
  })

  it('已入箧后重复请求不会重下', () => {
    const before = at('D2_KEPT')
    expect(step(RETENTION_GRID, before, { type: 'E_REQUEST_KEEP' })).toBe(before)
  })

  it('快照只暴露纯业务字段', () => {
    expect(retentionSnapshot(at('D2_KEPT'))).toEqual({
      state: 'D2_KEPT',
      bookId: 'ddj',
      chapterIndex: 1,
      progressPct: 100,
      occupiedSpace: 1024,
      failReason: null,
    })
  })
})

describe('书箧规则', () => {
  const book = (id: string, title: string): BookSpec => ({
    id,
    title,
    chapters: [
      { index: 0, title: '首篇', durationSec: 100 },
      { index: 1, title: '次篇', durationSec: 100 },
    ],
  })

  it('一篇入箧整卷可见', () => {
    const kept = [at('D2_KEPT')] // ddj 第 1 篇
    expect(isBookInBookcase('ddj', kept)).toBe(true)
    expect(isChapterAvailable('ddj', 1, kept)).toBe(true)
    expect(isChapterAvailable('ddj', 0, kept)).toBe(false)
    expect(keptChapterIndexes('ddj', kept)).toEqual([1])
  })

  it('远端目录在前，书箧独有的整卷续后', () => {
    const remote = [book('zz', '庄子')]
    const kept = [book('ddj', '道德经')]
    expect(mergeShelf(remote, kept).map((entry) => entry.id)).toEqual(['zz', 'ddj'])
  })

  it('同 id 不重复', () => {
    const remote = [book('ddj', '道德经'), book('zz', '庄子')]
    expect(mergeShelf(remote, [book('ddj', '道德经')]).map((entry) => entry.id)).toEqual(['ddj', 'zz'])
  })

  it('只列出书箧里有内容的整卷', () => {
    const books = [book('ddj', '道德经'), book('zz', '庄子')]
    expect(bookcaseBooks(books, [at('D2_KEPT')]).map((entry) => entry.id)).toEqual(['ddj'])
    expect(bookcaseBooks(books, [at('D1_KEEPING')])).toEqual([])
  })
})
