/**
 * 书箧（离线书架）的纯业务规则。
 *
 * 一条规矩：只要一卷里有一篇已入箧，这卷的书名与完整目录就都在书箧里可见，
 * 断网也能展卷；没入箧的那几篇只是暂时取不到声音而已。
 */

import type { BookSpec } from './listening-model'
import type { RetentionContext } from './retention-model'

/** 远端目录在前，书箧独有的整卷续在后面；同 id 不重复。 */
export function mergeShelf(remote: readonly BookSpec[], keptBooks: readonly BookSpec[]): BookSpec[] {
  const merged: BookSpec[] = []
  const seen = new Set<string>()
  for (const book of [...remote, ...keptBooks]) {
    if (seen.has(book.id)) continue
    seen.add(book.id)
    merged.push(book)
  }
  return merged
}

/** 这一卷里有没有至少一篇已入箧。 */
export function isBookInBookcase(bookId: string, kept: Iterable<RetentionContext>): boolean {
  for (const entry of kept) {
    if (entry.bookId === bookId && entry.state === 'D2_KEPT') return true
  }
  return false
}

export function keptChapterIndexes(bookId: string, kept: Iterable<RetentionContext>): number[] {
  const indexes: number[] = []
  for (const entry of kept) {
    if (entry.bookId === bookId && entry.state === 'D2_KEPT') indexes.push(entry.chapterIndex)
  }
  return indexes.sort((left, right) => left - right)
}

export function isChapterAvailable(bookId: string, chapterIndex: number, kept: Iterable<RetentionContext>): boolean {
  for (const entry of kept) {
    if (entry.bookId === bookId && entry.chapterIndex === chapterIndex && entry.state === 'D2_KEPT') return true
  }
  return false
}

/** 书箧里可离线展卷的整卷清单。 */
export function bookcaseBooks(books: readonly BookSpec[], kept: Iterable<RetentionContext>): BookSpec[] {
  return books.filter((book) => isBookInBookcase(book.id, kept))
}
