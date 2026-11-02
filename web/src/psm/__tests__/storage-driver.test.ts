import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BookDetail } from '../../core/domain'
import { deleteDatabase, loadCatalogEntry, loadDownloads } from '../../core/storage/db'
import { storeTrack } from '../storage-driver'

/** Minimal Cache Storage: the driver only ever opens one bucket and puts/deletes. */
class FakeCache {
  readonly entries = new Map<string, Response>()

  async put(request: string, response: Response): Promise<void> {
    this.entries.set(request, response)
  }

  async delete(request: string): Promise<boolean> {
    return this.entries.delete(request)
  }

  async match(request: string): Promise<Response | undefined> {
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
