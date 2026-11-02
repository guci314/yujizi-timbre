package voice.core.playback.pim

/**
 * 书箧（离线书架）的纯业务规则，与 web/src/pim/shelf.ts 同构。
 *
 * 一条规矩：只要一卷里有一篇已入箧，这卷的书名与完整目录就都在书箧里可见，
 * 断网也能展卷；没入箧的那几篇只是暂时取不到声音而已。
 */

/** 远端目录在前，书箧独有的整卷续在后面；同 id 不重复。 */
fun mergeShelf(remote: List<BookSpec>, keptBooks: List<BookSpec>): List<BookSpec> {
  val merged = mutableListOf<BookSpec>()
  val seen = HashSet<String>()
  for (book in remote + keptBooks) {
    if (!seen.add(book.id)) continue
    merged.add(book)
  }
  return merged
}

/** 这一卷里有没有至少一篇已入箧。 */
fun isBookInBookcase(bookId: String, kept: Iterable<RetentionContext>): Boolean =
  kept.any { it.bookId == bookId && it.state == RetentionState.D2_KEPT }

fun keptChapterIndexes(bookId: String, kept: Iterable<RetentionContext>): List<Int> =
  kept.filter { it.bookId == bookId && it.state == RetentionState.D2_KEPT }
    .map { it.chapterIndex }
    .sorted()

fun isChapterAvailable(bookId: String, chapterIndex: Int, kept: Iterable<RetentionContext>): Boolean =
  kept.any {
    it.bookId == bookId && it.chapterIndex == chapterIndex && it.state == RetentionState.D2_KEPT
  }

/** 书箧里可离线展卷的整卷清单。 */
fun bookcaseBooks(books: List<BookSpec>, kept: Iterable<RetentionContext>): List<BookSpec> {
  val keptList = kept.toList()
  return books.filter { isBookInBookcase(it.id, keptList) }
}
