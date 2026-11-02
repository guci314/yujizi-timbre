package voice.core.playback.servo

import voice.core.playback.pim.BookSpec
import voice.core.playback.pim.ChapterSpec
import voice.core.playback.pim.KeepFailReason
import voice.core.playback.pim.P1_书箧可见充要条件
import voice.core.playback.pim.RetentionState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RetentionSessionTest {

  private val book = BookSpec(
    id = "ddj",
    title = "道德经",
    chapters = (0..9).map { ChapterSpec(index = it, title = "第${it + 1}章", durationSec = 600) },
  )

  private fun session() = RetentionSession()

  @Test
  fun keepingOneChapterMakesTheWholeBookVisible() {
    val session = session()

    session.requestKeep("ddj", 2)
    assertEquals(RetentionState.D1_KEEPING, session.context("ddj", 2).state)

    session.progress("ddj", 2, 40)
    assertEquals(40, session.context("ddj", 2).progressPct)

    session.verifiedComplete("ddj", 2, space = 2_166_849)

    val kept = session.context("ddj", 2)
    assertEquals(RetentionState.D2_KEPT, kept.state)
    assertEquals(2_166_849L, kept.occupiedSpace)
    assertTrue(session.violations().isEmpty(), session.violations().toString())

    // P1：一篇入箧，整卷可见。
    val visible = session.bookcase(listOf(book))
    assertEquals(listOf("ddj"), visible.map { it.id })
    assertNull(P1_书箧可见充要条件(listOf(book), session.all()))
    assertTrue(session.isAvailable("ddj", 2))
    assertFalse(session.isAvailable("ddj", 3))
  }

  @Test
  fun runningOutOfSpaceLeavesNoOccupiedSpace() {
    val session = session()

    session.requestKeep("ddj", 0)
    session.progress("ddj", 0, 80)
    session.failed("ddj", 0, KeepFailReason.SPACE_FULL)

    val failed = session.context("ddj", 0)
    assertEquals(RetentionState.D3_FAILED, failed.state)
    assertEquals(0L, failed.occupiedSpace)
    assertEquals(0, failed.progressPct)
    assertEquals(KeepFailReason.SPACE_FULL, failed.failReason)
    assertTrue(session.violations().isEmpty())
    assertTrue(session.bookcase(listOf(book)).isEmpty())
  }

  @Test
  fun releasingMidKeepWipesEverythingAndLateCompletionIsIgnored() {
    val session = session()

    session.requestKeep("ddj", 1)
    session.progress("ddj", 1, 60)
    session.release("ddj", 1)

    val released = session.context("ddj", 1)
    assertEquals(RetentionState.D0_NOT_KEPT, released.state)
    assertEquals(0, released.progressPct)
    assertEquals(0L, released.occupiedSpace)

    // 迟到的「验明完好」绝不能把已释出的篇章偷偷塞回书箧。
    session.verifiedComplete("ddj", 1, space = 999)
    assertEquals(RetentionState.D0_NOT_KEPT, session.context("ddj", 1).state)
    assertTrue(session.violations().isEmpty())
  }

  @Test
  fun aFailedChapterIgnoresALateCompletionAndCanRetry() {
    val session = session()

    session.requestKeep("ddj", 4)
    session.failed("ddj", 4, KeepFailReason.CONTENT_CORRUPTED)
    session.verifiedComplete("ddj", 4, space = 1_000)

    assertEquals(RetentionState.D3_FAILED, session.context("ddj", 4).state)
    assertEquals(0L, session.context("ddj", 4).occupiedSpace)

    session.requestKeep("ddj", 4)
    assertEquals(RetentionState.D1_KEEPING, session.context("ddj", 4).state)
    assertNull(session.context("ddj", 4).failReason)

    session.verifiedComplete("ddj", 4, space = 1_024)
    assertEquals(RetentionState.D2_KEPT, session.context("ddj", 4).state)
    assertTrue(session.violations().isEmpty())
  }

  @Test
  fun zeroSpaceCompletionNeverCounts() {
    val session = session()

    session.requestKeep("ddj", 6)
    session.verifiedComplete("ddj", 6, space = 0)

    assertEquals(RetentionState.D1_KEEPING, session.context("ddj", 6).state)
    assertTrue(session.violations().isEmpty())
  }

  @Test
  fun everyTransitionKeepsThePropositionsSatisfied() {
    val session = session()
    val steps: List<() -> Unit> = listOf(
      { session.requestKeep("ddj", 0) },
      { session.progress("ddj", 0, 30) },
      { session.verifiedComplete("ddj", 0, space = 100) },
      { session.release("ddj", 0) },
      { session.requestKeep("ddj", 1) },
      { session.failed("ddj", 1, KeepFailReason.SOURCE_UNREACHABLE) },
      { session.requestKeep("ddj", 1) },
      { session.verifiedComplete("ddj", 1, space = 200) },
    )

    steps.forEach { step ->
      step()
      assertTrue(session.violations().isEmpty(), session.violations().toString())
      assertNotNull(session.context("ddj", 0))
    }
  }
}
