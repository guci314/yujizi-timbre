package voice.core.online

import kotlinx.coroutines.test.runTest
import kotlin.io.path.createTempDirectory
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SplitOnlineChaptersMigrationTest {

  private val chapterStore = OnlineChapterStore(createTempDirectory("online-chapters").toFile())
  private val migration = SplitOnlineChaptersMigration(chapterStore)

  private val chapters = listOf(
    OnlineChapter(id = "c1", title = "第1集", durationSeconds = 1800),
    OnlineChapter(id = "c2", title = "第2集", durationSeconds = 1750),
  )

  private fun book(withChapters: Boolean) = OnlineBook(
    source = "A",
    bookId = "b1",
    title = "T",
    chapters = if (withChapters) chapters else emptyList(),
  )

  @Test
  fun `migrates only when a record carries chapters`() = runTest {
    assertTrue(migration.shouldMigrate(listOf(book(withChapters = true))))
    assertFalse(migration.shouldMigrate(listOf(book(withChapters = false), book(withChapters = false))))
    assertFalse(migration.shouldMigrate(emptyList()))
  }

  @Test
  fun `migrate copies the chapter lists into the store and strips the records`() = runTest {
    val data = listOf(book(withChapters = true), book(withChapters = true).copy(bookId = "b2", chapters = emptyList()))

    val migrated = migration.migrate(data)

    assertEquals(emptyList(), migrated.single { it.bookId == "b1" }.chapters)
    assertEquals(emptyList(), migrated.single { it.bookId == "b2" }.chapters)
    assertEquals(chapters, chapterStore.chapters("A::b1"))
  }

  @Test
  fun `a failing chapter write keeps the records so the migration retries`() = runTest {
    // a base dir that is a regular file makes every write fail
    val blockingFile = createTempDirectory("blocked").toFile().resolve("file.json")
    blockingFile.writeText("x")
    val failing = SplitOnlineChaptersMigration(OnlineChapterStore(blockingFile))

    val data = listOf(book(withChapters = true))
    val migrated = failing.migrate(data)

    // nothing was stripped: the next start re-runs the migration
    assertEquals(chapters, migrated.single().chapters)
  }
}
