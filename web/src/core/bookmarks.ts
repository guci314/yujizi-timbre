import type { Bookmark } from './domain'
import { deleteBookmark, loadAllBookmarks, saveBookmark } from './storage/db'

/** What a caller supplies; the id and timestamp are generated here. */
export interface NewBookmark {
  bookSlug: string
  bookTitle: string
  trackIndex: number
  trackName: string
  currentTime: number
  note?: string
}

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `bm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export async function addBookmark(input: NewBookmark): Promise<Bookmark> {
  const bookmark: Bookmark = {
    id: newId(),
    bookSlug: input.bookSlug,
    bookTitle: input.bookTitle,
    trackIndex: input.trackIndex,
    trackName: input.trackName,
    currentTime: input.currentTime,
    note: input.note ?? '',
    createdAt: Date.now(),
  }
  await saveBookmark(bookmark)
  return bookmark
}

export function listBookmarks(): Promise<Record<string, Bookmark[]>> {
  return loadAllBookmarks()
}

export function removeBookmark(id: string): Promise<undefined> {
  return deleteBookmark(id)
}
