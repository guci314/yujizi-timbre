package voice.core.playback.servo

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import voice.core.playback.pim.BookSpec
import voice.core.playback.pim.KeepFailReason
import voice.core.playback.pim.RetentionContext
import voice.core.playback.pim.RetentionEvent
import voice.core.playback.pim.RETENTION_GRID
import voice.core.playback.pim.bookcaseBooks
import voice.core.playback.pim.initialRetentionContext
import voice.core.playback.pim.isChapterAvailable
import voice.core.playback.pim.retentionSnapshot
import voice.core.playback.pim.step
import voice.core.playback.pim.verifyRetentionPropositions

/**
 * 书箧伺服驱动器：Android 端的离线留存状态机。
 *
 * 每章的留存状态只有一份，所有变迁都经由 `step(RETENTION_GRID, …)`；
 * 每次变迁后都可以用 [violations] 自检 P3/P4。
 */
class RetentionSession(initial: Map<String, RetentionContext> = emptyMap()) {

  private val contexts = MutableStateFlow(initial)
  val state: StateFlow<Map<String, RetentionContext>> = contexts.asStateFlow()

  fun context(bookId: String, chapterIndex: Int): RetentionContext =
    contexts.value[key(bookId, chapterIndex)]
      ?: initialRetentionContext(bookId, chapterIndex)

  fun all(): List<RetentionContext> = contexts.value.values.toList()

  @IgnorableReturnValue
  fun requestKeep(bookId: String, chapterIndex: Int): RetentionContext =
    transition(bookId, chapterIndex, RetentionEvent.RequestKeep)

  @IgnorableReturnValue
  fun progress(bookId: String, chapterIndex: Int, pct: Int): RetentionContext =
    transition(bookId, chapterIndex, RetentionEvent.KeepProgress(pct))

  @IgnorableReturnValue
  fun verifiedComplete(bookId: String, chapterIndex: Int, space: Long): RetentionContext =
    transition(bookId, chapterIndex, RetentionEvent.VerifiedComplete(space))

  @IgnorableReturnValue
  fun failed(bookId: String, chapterIndex: Int, reason: KeepFailReason): RetentionContext =
    transition(bookId, chapterIndex, RetentionEvent.KeepFailed(reason))

  @IgnorableReturnValue
  fun release(bookId: String, chapterIndex: Int): RetentionContext =
    transition(bookId, chapterIndex, RetentionEvent.Release)

  /** 一卷入箧，整卷可见（P1）。 */
  fun bookcase(books: List<BookSpec>): List<BookSpec> = bookcaseBooks(books, all())

  fun isAvailable(bookId: String, chapterIndex: Int): Boolean =
    isChapterAvailable(bookId, chapterIndex, all())

  /** 当前全部留存快照的命题违例（P3 / P4）。恒应为空。 */
  fun violations(): List<String> = all().flatMap { verifyRetentionPropositions(it) }

  private fun transition(bookId: String, chapterIndex: Int, event: RetentionEvent): RetentionContext {
    val current = context(bookId, chapterIndex)
    val next = RETENTION_GRID.step(current, event)
    if (next != current) {
      contexts.value = contexts.value + (key(bookId, chapterIndex) to next)
    }
    return next
  }

  private fun key(bookId: String, chapterIndex: Int): String = "$bookId#$chapterIndex"

  companion object {
    fun snapshot(contexts: Iterable<RetentionContext>) = contexts.map { retentionSnapshot(it) }
  }
}
