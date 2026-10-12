package voice.core.online

import androidx.datastore.core.DataMigration
import voice.core.logging.api.Logger

/**
 * One-time move of the chapter lists out of the shelf store. Books persisted
 * before the split carry their full chapter list inside the shelf JSON; the
 * lists are copied into [OnlineChapterStore] files and stripped from the
 * records, so the shelf JSON stays small from then on.
 *
 * A failing chapter write returns the data unchanged instead of stripping the
 * lists: DataStore re-runs the migration on the next start and nothing is lost.
 */
internal class SplitOnlineChaptersMigration(private val chapterStore: OnlineChapterStore) : DataMigration<List<OnlineBook>> {

  override suspend fun shouldMigrate(currentData: List<OnlineBook>): Boolean {
    return currentData.any { it.chapters.isNotEmpty() }
  }

  override suspend fun migrate(currentData: List<OnlineBook>): List<OnlineBook> {
    for (book in currentData) {
      if (book.chapters.isEmpty()) continue
      val stored = runCatching { chapterStore.put(book.key, book.chapters) }
      if (stored.isFailure) {
        Logger.w(
          "Chapter list migration of ${book.key} failed; the shelf keeps its " +
            "chapters and retries next start: ${stored.exceptionOrNull()}",
        )
        return currentData
      }
    }
    return currentData.map { book ->
      if (book.chapters.isEmpty()) book else book.copy(chapters = emptyList())
    }
  }

  override suspend fun cleanUp() = Unit
}
