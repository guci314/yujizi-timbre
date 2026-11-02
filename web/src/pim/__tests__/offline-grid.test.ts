import { describe, expect, it } from 'vitest'
import { assertComplete, missingCells, modelCheck, step } from '../kernel'
import {
  catalogEntryFrom,
  detailFromCatalog,
  DOWNLOAD_GRID,
  initialDownloadContext,
  isConsistent,
  mergeBookList,
  reconcile,
  repairDownloads,
  runDownloadEffects,
  type DownloadContext,
  type DownloadEffect,
  type DownloadEvent,
  type DownloadPort,
} from '../offline-grid'
import type { BookDetail } from '../../core/domain'

class MemoryPort implements DownloadPort {
  readonly bytes = new Set<string>()
  readonly records = new Map<string, number>()
  /** Injection point: make the next record write fail, like a full disk. */
  failNextRecordWrite = false

  async putBytes(url: string): Promise<void> {
    this.bytes.add(url)
  }

  async deleteBytes(url: string): Promise<void> {
    this.bytes.delete(url)
  }

  async putRecord(record: { url: string; sizeBytes: number }): Promise<void> {
    if (this.failNextRecordWrite) {
      this.failNextRecordWrite = false
      throw new Error('QuotaExceededError')
    }
    this.records.set(record.url, record.sizeBytes)
  }

  async deleteRecord(url: string): Promise<void> {
    this.records.delete(url)
  }

  get consistent(): boolean {
    return isConsistent(reconcile(this.records.keys(), this.bytes))
  }
}

const URL_A = 'https://example.test/ddj/1.m4a'
const URL_B = 'https://example.test/ddj/2.m4a'

describe('download grid completeness', () => {
  it('defines all 4 x 5 = 20 cells', () => {
    expect(missingCells(DOWNLOAD_GRID)).toEqual([])
    expect(() => assertComplete(DOWNLOAD_GRID)).not.toThrow()
  })
})

describe('I6 accounting stays exact', () => {
  const events: DownloadEvent[] = [
    { type: 'E_START_DL' },
    { type: 'E_DL_PROGRESS', received: 10, total: 40 },
    { type: 'E_DL_PROGRESS', received: 40, total: 40 },
    { type: 'E_DL_SUCCESS', sizeBytes: 40 },
    { type: 'E_DL_FAIL', reason: '网络中断' },
    { type: 'E_REMOVE' },
  ]

  const keyOf = (ctx: DownloadContext): string =>
    [ctx.state, ctx.received, ctx.total, ctx.sizeBytes, ctx.reason ?? '-'].join('|')

  it('finds no accounting violation over every short interleaving', async () => {
    const report = modelCheck(DOWNLOAD_GRID, {
      initial: initialDownloadContext(URL_A),
      events,
      keyOf,
      maxStates: 5000,
      maxTrace: 10,
      invariants: [],
    })
    expect(report.reachableStates).toHaveLength(4)

    // Enumerate every event sequence up to depth 5 and replay it on a fresh
    // store, once with a healthy disk and once with the first record write
    // failing. Every terminal state must satisfy I6.
    const violations: string[] = []
    const depth = 5

    const replay = async (sequence: DownloadEvent[], failRecordWrite: boolean): Promise<void> => {
      const port = new MemoryPort()
      port.failNextRecordWrite = failRecordWrite
      let ctx = initialDownloadContext(URL_A)
      try {
        for (const event of sequence) {
          const result = step(DOWNLOAD_GRID, ctx, event)
          await runDownloadEffects(port, result.ctx, result.effects)
          ctx = result.ctx
        }
      } catch {
        // A failed record write is allowed; leaving bytes behind is not.
      }
      if (!port.consistent) {
        violations.push(
          `${sequence.map((event) => event.type).join('>')} -> ${JSON.stringify(reconcile(port.records.keys(), port.bytes))}`,
        )
      }
    }

    const walk = async (prefix: DownloadEvent[]): Promise<void> => {
      if (prefix.length === depth) {
        await replay(prefix, false)
        await replay(prefix, true)
        return
      }
      for (const event of events) await walk([...prefix, event])
    }

    await walk([])
    expect(violations).toEqual([])
  })

  it('undoes the bytes when the record write fails', async () => {
    const port = new MemoryPort()
    port.failNextRecordWrite = true
    const started = step(DOWNLOAD_GRID, initialDownloadContext(URL_A), { type: 'E_START_DL' })
    const stored = step(DOWNLOAD_GRID, started.ctx, { type: 'E_DL_SUCCESS', sizeBytes: 40 })

    await expect(runDownloadEffects(port, stored.ctx, stored.effects)).rejects.toThrow('QuotaExceededError')
    expect(port.bytes.size).toBe(0)
    expect(port.records.size).toBe(0)
  })

  it('stores bytes before the record, then both survive', async () => {
    const port = new MemoryPort()
    const started = step(DOWNLOAD_GRID, initialDownloadContext(URL_A), { type: 'E_START_DL' })
    const stored = step(DOWNLOAD_GRID, started.ctx, { type: 'E_DL_SUCCESS', sizeBytes: 40 })
    await runDownloadEffects(port, stored.ctx, stored.effects)
    expect([...port.bytes]).toEqual([URL_A])
    expect([...port.records.keys()]).toEqual([URL_A])
    expect(port.consistent).toBe(true)
  })

  it('removes both sides on delete', async () => {
    const port = new MemoryPort()
    await port.putBytes(URL_A)
    await port.putRecord({ url: URL_A, sizeBytes: 40 })
    const stored: DownloadContext = {
      ...initialDownloadContext(URL_A),
      state: 'D2_STORED',
      sizeBytes: 40,
    }
    const removed = step(DOWNLOAD_GRID, stored, { type: 'E_REMOVE' })
    await runDownloadEffects(port, removed.ctx, removed.effects)
    expect(port.bytes.size).toBe(0)
    expect(port.records.size).toBe(0)
  })

  it('repairs a drifted store in both directions', async () => {
    const port = new MemoryPort()
    await port.putBytes(URL_A) // bytes with no record
    await port.putRecord({ url: URL_B, sizeBytes: 12 }) // record with no bytes

    const plan = reconcile(port.records.keys(), port.bytes)
    expect(plan.orphanBytes).toEqual([URL_A])
    expect(plan.danglingRecords).toEqual([URL_B])

    await repairDownloads(port, plan)
    expect(port.consistent).toBe(true)
  })

  it('never loses an unrelated stored track when another fails', async () => {
    const port = new MemoryPort()
    await port.putBytes(URL_A)
    await port.putRecord({ url: URL_A, sizeBytes: 40 })

    port.failNextRecordWrite = true
    const started = step(DOWNLOAD_GRID, initialDownloadContext(URL_B), { type: 'E_START_DL' })
    const stored = step(DOWNLOAD_GRID, started.ctx, { type: 'E_DL_SUCCESS', sizeBytes: 10 })
    await expect(runDownloadEffects(port, stored.ctx, stored.effects)).rejects.toThrow()

    expect([...port.bytes]).toEqual([URL_A])
    expect([...port.records.keys()]).toEqual([URL_A])
    expect(port.consistent).toBe(true)
  })
})

describe('I6 effect ordering', () => {
  it('emits STORE_BYTES before INDEX_RECORD', () => {
    const started = step(DOWNLOAD_GRID, initialDownloadContext(URL_A), { type: 'E_START_DL' })
    const stored = step(DOWNLOAD_GRID, started.ctx, { type: 'E_DL_SUCCESS', sizeBytes: 1 })
    expect(stored.effects.map((effect: DownloadEffect) => effect.type)).toEqual(['STORE_BYTES', 'INDEX_RECORD'])
  })
})

describe('offline catalogue', () => {
  const detail: BookDetail = {
    slug: 'ddj',
    title: '道德经',
    pageUrl: 'https://www.yujizi.org/道德经.html',
    tracks: [{ name: '第一章', url: 'https://example.test/ddj/1.m4a' }],
  }

  it('round-trips a detail through a catalogue entry', () => {
    const entry = catalogEntryFrom(detail, 1000)
    expect(detailFromCatalog(entry)).toEqual(detail)
  })

  it('keeps cached-only books and lets remote order win', () => {
    const cached = [catalogEntryFrom(detail, 5), catalogEntryFrom({ ...detail, slug: 'zz', title: '庄子' }, 9)]
    const merged = mergeBookList([{ slug: 'zz', title: '庄子（新）', pageUrl: '/zz.html' }], cached)
    expect(merged.map((book) => book.slug)).toEqual(['zz', 'ddj'])
    expect(merged[0].title).toBe('庄子（新）')
  })

  it('falls back to the cache when the network returns nothing', () => {
    const merged = mergeBookList([], [catalogEntryFrom(detail, 5)])
    expect(merged.map((book) => book.slug)).toEqual(['ddj'])
  })
})

describe('download state machine', () => {
  const run = (ctx: DownloadContext, events: DownloadEvent[]): DownloadContext =>
    events.reduce((current, event) => step(DOWNLOAD_GRID, current, event).ctx, ctx)

  it('goes idle -> downloading -> stored -> idle', () => {
    const ctx = run(initialDownloadContext(URL_A), [
      { type: 'E_START_DL' },
      { type: 'E_DL_PROGRESS', received: 5, total: 10 },
      { type: 'E_DL_SUCCESS', sizeBytes: 10 },
      { type: 'E_REMOVE' },
    ])
    expect(ctx.state).toBe('D0_NOT_DOWNLOADED')
  })

  it('records a readable failure reason', () => {
    const ctx = run(initialDownloadContext(URL_A), [
      { type: 'E_START_DL' },
      { type: 'E_DL_FAIL', reason: '设备存储空间不足' },
    ])
    expect(ctx.state).toBe('D3_FAILED')
    expect(ctx.reason).toBe('设备存储空间不足')
  })

  it('allows a retry after failure', () => {
    const failed = run(initialDownloadContext(URL_A), [
      { type: 'E_START_DL' },
      { type: 'E_DL_FAIL', reason: '网络中断' },
    ])
    expect(run(failed, [{ type: 'E_START_DL' }]).state).toBe('D1_DOWNLOADING')
  })
})

describe('integrity failure', () => {
  const reason = '音频校验失败（文件不完整或损坏），请重试'

  const progressed = (): DownloadContext =>
    step(
      DOWNLOAD_GRID,
      step(DOWNLOAD_GRID, initialDownloadContext(URL_A), { type: 'E_START_DL' }).ctx,
      { type: 'E_DL_PROGRESS', received: 40, total: 100 },
    ).ctx

  it('parked in D3 with a readable reason, asking only for cleanup', () => {
    const failed = step(DOWNLOAD_GRID, progressed(), { type: 'E_DL_FAIL', reason })
    expect(failed.ctx.state).toBe('D3_FAILED')
    expect(failed.ctx.reason).toBe(reason)
    // No STORE_BYTES / INDEX_RECORD: a failed verification must never be persisted.
    expect(failed.effects).toEqual([{ type: 'DROP_PARTIAL' }])
  })

  it('deletes whatever half-arrived bytes the attempt left behind', async () => {
    const port = new MemoryPort()
    await port.putBytes(URL_A) // a partial write from the interrupted attempt

    const failed = step(DOWNLOAD_GRID, progressed(), { type: 'E_DL_FAIL', reason })
    await runDownloadEffects(port, failed.ctx, failed.effects)

    expect(port.bytes.size).toBe(0)
    expect(port.records.size).toBe(0)
    expect(port.consistent).toBe(true)
  })

  it('can be retried cleanly after a verification failure', () => {
    const failed = step(DOWNLOAD_GRID, progressed(), { type: 'E_DL_FAIL', reason })
    const retried = step(DOWNLOAD_GRID, failed.ctx, { type: 'E_START_DL' })
    expect(retried.ctx.state).toBe('D1_DOWNLOADING')
    expect(retried.ctx.reason).toBeNull()
    expect(retried.ctx.received).toBe(0)
  })
})
