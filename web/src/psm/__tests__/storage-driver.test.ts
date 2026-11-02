import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BookDetail } from '../../core/domain'
import { deleteDatabase, loadCatalogEntry, loadDownloads, saveDownload } from '../../core/storage/db'
import { sha256Hex } from '../../core/integrity'
import { auditStoredTracks, storeTrack } from '../storage-driver'

/** Minimal Cache Storage: the driver only ever opens one bucket and puts/deletes. */
class FakeCache {
  readonly entries = new Map<string, Response>()
  /** Counts byte reads, so tests can prove a verified track is never re-read. */
  matchCalls = 0

  async put(request: string, response: Response): Promise<void> {
    this.entries.set(request, response)
  }

  async delete(request: string): Promise<boolean> {
    return this.entries.delete(request)
  }

  async match(request: string): Promise<Response | undefined> {
    this.matchCalls += 1
    return this.entries.get(request)
  }

  async keys(): Promise<Request[]> {
    return [...this.entries.keys()].map((url) => ({ url }) as Request)
  }
}

const book: BookDetail = {
  slug: 'ddj',
  title: '道德经',
  pageUrl: 'https://www.yujizi.org/道德经.html',
  tracks: [
    { name: '第一章', url: 'https://example.test/ddj/1.m4a' },
    { name: '第二章', url: 'https://example.test/ddj/2.m4a' },
  ],
}

const track = book.tracks[0]

function installFakes(): FakeCache {
  const cache = new FakeCache()
  vi.stubGlobal('caches', {
    open: async () => cache,
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('abcd', { status: 200 })),
  )
  return cache
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await deleteDatabase()
})

describe('storeTrack', () => {
  it('writes the bytes and the index record', async () => {
    const cache = installFakes()
    const stored = await storeTrack(book, track, 0)

    expect(stored.sizeBytes).toBe(4)
    expect((await loadDownloads()).map((entry) => entry.url)).toEqual([track.url])
    expect(cache.entries.has(track.url)).toBe(true)
  })

  /**
   * Downloading audio without caching the chapter list is the B3 failure: the
   * book plays only while the network is up. One successful track must therefore
   * be enough to make the whole book readable offline.
   */
  it('caches the chapter list of the book being downloaded', async () => {
    installFakes()
    await storeTrack(book, track, 0)

    const catalog = await loadCatalogEntry(book.slug)
    expect(catalog).toBeDefined()
    expect(catalog?.tracks).toEqual(book.tracks)
    expect(catalog?.title).toBe(book.title)
  })

  it('does not cache the chapter list when the download fails', async () => {
    installFakes()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    )

    await expect(storeTrack(book, track, 0)).rejects.toThrow('下载失败')
    expect(await loadCatalogEntry(book.slug)).toBeUndefined()
    expect(await loadDownloads()).toEqual([])
  })

  it('never stores a truncated body', async () => {
    const cache = installFakes()
    // The server promised 100 bytes and delivered 3: a classic dropped stream.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('abc', { status: 200, headers: { 'content-length': '100' } })),
    )

    await expect(storeTrack(book, track, 0)).rejects.toThrow('音频校验失败（文件不完整或损坏），请重试')
    expect(cache.entries.size).toBe(0)
    expect(await loadDownloads()).toEqual([])
    expect(await loadCatalogEntry(book.slug)).toBeUndefined()
  })
})

describe('auditStoredTracks', () => {
  const legacyUrl = 'https://example.test/legacy/1.m4a'
  const payload = new TextEncoder().encode('abcd')

  const legacyRecord = (overrides: Partial<{ sizeBytes: number; sha256: string }> = {}) => ({
    url: legacyUrl,
    bookSlug: 'ddj',
    bookTitle: '道德经',
    trackIndex: 0,
    trackName: '第一章',
    sizeBytes: 4,
    downloadedAt: 1,
    ...overrides,
  })

  const expectation = async (): Promise<{ size: number; sha256: string }> => ({
    size: payload.length,
    sha256: await sha256Hex(payload),
  })

  it('verifies a legacy track once, then never reads its bytes again', async () => {
    const cache = installFakes()
    await cache.put(legacyUrl, new Response('abcd'))
    await saveDownload(legacyRecord())

    const first = await auditStoredTracks({ resolveExpected: expectation })
    expect(first.checked).toBe(1)
    expect(first.cleaned).toBe(0)
    expect(first.alreadyVerified).toBe(0)

    const stamped = (await loadDownloads())[0]
    expect(stamped.sha256).toBe((await expectation()).sha256)
    expect(stamped.sizeBytes).toBe(4)

    const readsAfterFirst = cache.matchCalls
    const second = await auditStoredTracks({ resolveExpected: expectation })
    expect(second.checked).toBe(0)
    expect(second.alreadyVerified).toBe(1)
    // The whole point of the stamp: an 88 MB episode is not hashed on every visit.
    expect(cache.matchCalls).toBe(readsAfterFirst)
  })

  it('drops a tampered legacy track and keeps the ledger consistent', async () => {
    const cache = installFakes()
    await cache.put(legacyUrl, new Response('abce')) // one byte different
    await saveDownload(legacyRecord())

    const result = await auditStoredTracks({ resolveExpected: expectation })
    expect(result.checked).toBe(1)
    expect(result.cleaned).toBe(1)

    expect(cache.entries.has(legacyUrl)).toBe(false)
    expect(await loadDownloads()).toEqual([])
  })

  it('rejects a truncated track from its recorded size without reading the bytes', async () => {
    const cache = installFakes()
    await cache.put(legacyUrl, new Response('ab'))
    await saveDownload(legacyRecord({ sizeBytes: 999 }))

    const result = await auditStoredTracks({ resolveExpected: expectation })
    expect(result.cleaned).toBe(1)
    expect(cache.matchCalls).toBe(0)
    expect(cache.entries.size).toBe(0)
    expect(await loadDownloads()).toEqual([])
  })

  it('removes a record whose bytes vanished', async () => {
    installFakes()
    await saveDownload(legacyRecord())

    const result = await auditStoredTracks({ resolveExpected: expectation })
    expect(result.danglingRecords).toBe(1)
    expect(await loadDownloads()).toEqual([])
  })

  it('re-verifies a record whose stamp no longer matches the manifest', async () => {
    const cache = installFakes()
    await cache.put(legacyUrl, new Response('abcd'))
    await saveDownload(legacyRecord({ sha256: 'ff'.repeat(32) }))

    const result = await auditStoredTracks({ resolveExpected: expectation })
    expect(result.checked).toBe(1)
    expect(cache.matchCalls).toBe(1)
    expect((await loadDownloads())[0].sha256).toBe((await expectation()).sha256)
  })

  it('stamps a freshly downloaded track so the audit skips it', async () => {
    installFakes()
    const stored = await storeTrack(book, track, 0)
    expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/)

    const record = (await loadDownloads())[0]
    expect(record.sha256).toBe(stored.sha256)

    const result = await auditStoredTracks({ resolveExpected: async () => undefined })
    expect(result.checked).toBe(0)
    expect(result.alreadyVerified).toBe(1)
  })
})
