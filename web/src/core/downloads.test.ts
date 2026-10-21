import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BookDetail, Track } from './domain'
import { StorageFullError } from './domain'
import { AUDIO_CACHE } from './audio-cache'
import {
  downloadBook,
  downloadTrack,
  isDownloaded,
  isQuotaError,
  listDownloads,
  listDownloadsForBook,
  removeAllDownloads,
  removeBookDownloads,
  removeTrack,
  totalDownloadBytes,
} from './downloads'
import { deleteDatabase } from './storage/db'

/** Minimal in-memory stand-in for the Cache API. */
class FakeCache {
  entries = new Map<string, Response>()
  /** When set, `put` rejects with this, mimicking a full device. */
  failPutWith: unknown

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    if (this.failPutWith !== undefined) throw this.failPutWith
    this.entries.set(String(request), response)
  }

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    return this.entries.get(String(request))
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    return this.entries.delete(String(request))
  }
}

let cache: FakeCache

function track(name: string, id: number): Track {
  return { name, url: `https://www.yujizi.org/book/${id}.m4a` }
}

const book: BookDetail = {
  slug: 'ddj',
  title: '道德经',
  pageUrl: 'https://www.yujizi.org/道德经.html',
  tracks: [track('第01课', 1), track('第02课', 2), track('第03课', 3)],
}

/** Reply with a body of `bytes` so size accounting can be asserted. */
function serveBytes(bytes: number): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      const body = new Uint8Array(bytes)
      return new Response(body, {
        status: 200,
        headers: { 'content-length': String(bytes) },
      })
    }),
  )
}

beforeEach(() => {
  cache = new FakeCache()
  vi.stubGlobal('caches', { open: async () => cache })
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await deleteDatabase()
})

describe('isQuotaError', () => {
  it('recognises the browser refusing for lack of space', () => {
    expect(isQuotaError(new DOMException('full', 'QuotaExceededError'))).toBe(true)
  })

  it('ignores unrelated failures', () => {
    expect(isQuotaError(new Error('network'))).toBe(false)
    expect(isQuotaError('nope')).toBe(false)
  })
})

describe('downloadTrack', () => {
  it('stores the bytes and records the size', async () => {
    serveBytes(2048)
    const record = await downloadTrack(book, book.tracks[0], 0)
    expect(record.sizeBytes).toBe(2048)
    expect(record.trackName).toBe('第01课')
    expect(record.bookSlug).toBe('ddj')
    expect(await isDownloaded(book.tracks[0].url)).toBe(true)
  })

  it('reports progress while the body arrives', async () => {
    serveBytes(4096)
    const seen: number[] = []
    await downloadTrack(book, book.tracks[0], 0, {
      onProgress: ({ received, total, url }) => {
        seen.push(received)
        expect(total).toBe(4096)
        expect(url).toBe(book.tracks[0].url)
      },
    })
    expect(seen.at(-1)).toBe(4096)
  })

  it('turns a full device into a readable error', async () => {
    serveBytes(1024)
    cache.failPutWith = new DOMException('full', 'QuotaExceededError')
    await expect(downloadTrack(book, book.tracks[0], 0)).rejects.toBeInstanceOf(StorageFullError)
  })

  it('surfaces an http failure instead of storing an error page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    await expect(downloadTrack(book, book.tracks[0], 0)).rejects.toThrow(/下载失败（404）/)
  })

  it('does not record a track whose bytes failed to store', async () => {
    serveBytes(1024)
    cache.failPutWith = new DOMException('full', 'QuotaExceededError')
    await expect(downloadTrack(book, book.tracks[0], 0)).rejects.toThrow()
    expect(await listDownloads()).toHaveLength(0)
  })
})

describe('downloadBook', () => {
  it('stores every track and skips what is already there', async () => {
    serveBytes(512)
    const first = await downloadBook(book)
    expect(first.downloaded).toBe(3)
    expect(first.failed).toBe(0)

    const second = await downloadBook(book)
    expect(second.downloaded).toBe(0)
  })

  it('reports a failure without hiding what did land', async () => {
    serveBytes(512)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/2.m4a')) return new Response('boom', { status: 500 })
        return new Response(new Uint8Array(512), { status: 200, headers: { 'content-length': '512' } })
      }),
    )
    const result = await downloadBook(book)
    expect(result.failed).toBe(1)
    expect(result.downloaded).toBe(2)
    expect(result.error).toBeInstanceOf(Error)
    expect(await listDownloadsForBook('ddj')).toHaveLength(2)
  })

  it('keeps going after a failure instead of abandoning the rest', async () => {
    serveBytes(512)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).includes('/1.m4a')) return new Response('boom', { status: 500 })
        return new Response(new Uint8Array(512), { status: 200, headers: { 'content-length': '512' } })
      }),
    )
    const result = await downloadBook(book)
    expect(result.failed).toBe(1)
    expect(result.downloaded).toBe(2)
    expect(await listDownloadsForBook('ddj')).toHaveLength(2)
  })

  it('fetches several tracks at the same time', async () => {
    let inFlight = 0
    let peak = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
        return new Response(new Uint8Array(512), { status: 200, headers: { 'content-length': '512' } })
      }),
    )
    const result = await downloadBook(book)
    expect(result.downloaded).toBe(3)
    expect(peak).toBeGreaterThan(1)
  })

  it('halts when the caller aborts', async () => {
    serveBytes(512)
    const controller = new AbortController()
    controller.abort()
    const result = await downloadBook(book, { signal: controller.signal })
    expect(result.downloaded).toBe(0)
  })
})

describe('listing and totals', () => {
  it('lists one book in track order', async () => {
    serveBytes(100)
    await downloadBook(book)
    expect((await listDownloadsForBook('ddj')).map((entry) => entry.trackIndex)).toEqual([0, 1, 2])
  })

  it('sums stored bytes', async () => {
    serveBytes(1000)
    await downloadBook(book)
    expect(totalDownloadBytes(await listDownloads())).toBe(3000)
  })

  it('is empty before anything is downloaded', async () => {
    expect(await listDownloads()).toEqual([])
  })
})

describe('removal', () => {
  it('drops one track from cache and index', async () => {
    serveBytes(256)
    await downloadBook(book)
    await removeTrack(book.tracks[0].url)
    expect(await isDownloaded(book.tracks[0].url)).toBe(false)
    expect(await listDownloadsForBook('ddj')).toHaveLength(2)
  })

  it('drops a whole book', async () => {
    serveBytes(256)
    await downloadBook(book)
    await removeBookDownloads('ddj')
    expect(await listDownloadsForBook('ddj')).toHaveLength(0)
    expect(cache.entries.size).toBe(0)
  })

  it('drops everything', async () => {
    serveBytes(256)
    await downloadBook(book)
    await removeAllDownloads()
    expect(await listDownloads()).toHaveLength(0)
    expect(cache.entries.size).toBe(0)
  })
})

describe('cache bucket', () => {
  it('writes into the bucket the service worker reads', async () => {
    serveBytes(64)
    await downloadTrack(book, book.tracks[0], 0)
    expect(AUDIO_CACHE).toBe('timbre-audio')
    expect(cache.entries.has(book.tracks[0].url)).toBe(true)
  })
})
