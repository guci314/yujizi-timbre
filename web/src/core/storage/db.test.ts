import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Bookmark, Progress } from '../domain'
import {
  deleteBookmark,
  deleteDatabase,
  loadAllBookmarks,
  loadAllProgress,
  loadBookmarks,
  loadProgress,
  saveBookmark,
  saveProgress,
} from './db'

const progressA: Progress = { bookSlug: 'a', trackIndex: 2, currentTime: 61, updatedAt: 10 }
const progressB: Progress = { bookSlug: 'b', trackIndex: 0, currentTime: 5, updatedAt: 20 }

function bookmark(id: string, bookSlug: string, createdAt: number): Bookmark {
  return {
    id,
    bookSlug,
    bookTitle: `${bookSlug} 书名`,
    trackIndex: 1,
    trackName: `${id} 章节`,
    currentTime: 3,
    note: `${id} note`,
    createdAt,
  }
}

beforeEach(async () => {
  await saveProgress(progressA)
  await saveProgress(progressB)
})

afterEach(async () => {
  await deleteDatabase()
})

describe('progress', () => {
  it('round-trips one book', async () => {
    expect(await loadProgress('a')).toEqual(progressA)
  })

  it('returns undefined for a book never played', async () => {
    expect(await loadProgress('missing')).toBeUndefined()
  })

  it('overwrites the previous entry for the same book', async () => {
    const updated = { ...progressA, trackIndex: 7, currentTime: 120, updatedAt: 30 }
    await saveProgress(updated)
    expect(await loadProgress('a')).toEqual(updated)
  })

  it('lists every entry newest first', async () => {
    expect((await loadAllProgress()).map((entry) => entry.bookSlug)).toEqual(['b', 'a'])
  })
})

describe('bookmarks', () => {
  it('saves and reads back one bookmark', async () => {
    await saveBookmark(bookmark('id-1', 'a', 100))
    expect(await loadBookmarks('a')).toHaveLength(1)
    expect((await loadBookmarks('a'))[0].id).toBe('id-1')
  })

  it('scopes bookmarks to their own book', async () => {
    await saveBookmark(bookmark('id-1', 'a', 100))
    await saveBookmark(bookmark('id-2', 'b', 101))
    expect(await loadBookmarks('a')).toHaveLength(1)
    expect(await loadBookmarks('b')).toHaveLength(1)
  })

  it('orders entries oldest first within a book', async () => {
    await saveBookmark(bookmark('new', 'a', 200))
    await saveBookmark(bookmark('old', 'a', 100))
    expect((await loadBookmarks('a')).map((entry) => entry.id)).toEqual(['old', 'new'])
  })

  it('groups entries by book when listing all', async () => {
    await saveBookmark(bookmark('id-1', 'a', 200))
    await saveBookmark(bookmark('id-2', 'a', 100))
    await saveBookmark(bookmark('id-3', 'b', 150))
    const all = await loadAllBookmarks()
    expect(Object.keys(all).sort()).toEqual(['a', 'b'])
    expect(all.a.map((entry) => entry.id)).toEqual(['id-1', 'id-2'])
    expect(all.b.map((entry) => entry.id)).toEqual(['id-3'])
  })

  it('deletes by id', async () => {
    await saveBookmark(bookmark('id-1', 'a', 100))
    await deleteBookmark('id-1')
    expect(await loadBookmarks('a')).toHaveLength(0)
  })
})
