package voice.core.playback.servo

import androidx.datastore.core.DataStore
import io.mockk.mockk
import io.mockk.verify
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import voice.core.data.Book
import voice.core.data.BookContent
import voice.core.data.BookId
import voice.core.data.Chapter
import voice.core.data.ChapterId
import voice.core.playback.LivePlaybackState
import voice.core.playback.PlayerController
import voice.core.playback.playstate.PlayStateManager
import voice.core.playback.pim.ListeningState
import voice.core.playback.pim.SleepChange
import voice.core.playback.pim.SleepMode
import voice.core.playback.pim.SleepOption
import voice.core.playback.pim.verifyListeningPropositions
import java.time.Instant
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.uuid.Uuid

class ListeningSessionTest {

  private val player = mockk<PlayerController>(relaxed = true)
  private val playStateManager = PlayStateManager()
  private val store = MemoryStore<BookId?>(null)

  private var lastSession: ListeningSession? = null

  private fun sessionFor(book: Book): ListeningSession =
    ListeningSession(book.id, player, playStateManager, store).also { lastSession = it }

  /** 每一个用例做完之后，快照都必须仍然满足全部命题公理（P4/P5/P6）。 */
  @AfterTest
  fun snapshotStillSatisfiesThePropositions() {
    lastSession?.let { session ->
      assertTrue(
        verifyListeningPropositions(session.state.value).isEmpty(),
        "违例：${verifyListeningPropositions(session.state.value)} / ${session.state.value}",
      )
    }
  }

  @Test
  fun openWhileAnotherBookPlaysLeavesEverythingAlone() = runTest {
    val pageBook = sessionBook()
    val playingBook = sessionBook()
    val session = sessionFor(pageBook)
    playStateManager.playState = PlayStateManager.PlayState.Playing
    session.alignToPlaying(playingBook)
    val before = session.state.value

    session.open(pageBook, 0, 10)

    // 网格在 S2(另一本书) 下忽略 E_OPEN_BOOK：快照不变，伺服一个字都不发。
    assertEquals(before, session.state.value)
    verify(exactly = 0) { player.pauseIfCurrentBookDifferentFrom(any()) }
    verify(exactly = 0) { player.play() }
    assertEquals(null, store.data.first())
  }

  @Test
  fun openWhenIdleClaimsTheBook() = runTest {
    val pageBook = sessionBook()
    val session = sessionFor(pageBook)

    session.open(pageBook, 1, 0)

    assertEquals(ListeningState.S1_PAUSED, session.state.value.state)
    assertEquals(pageBook.id, store.data.first())
    verify(exactly = 1) { player.pauseIfCurrentBookDifferentFrom(pageBook.id) }
    verify(exactly = 0) { player.play() }
  }

  @Test
  fun jumpAndPlaySwitchesBookThenSeeksAndPlays() = runTest {
    val pageBook = sessionBook()
    val playingBook = sessionBook()
    val session = sessionFor(pageBook)
    playStateManager.playState = PlayStateManager.PlayState.Playing
    session.alignToPlaying(playingBook)

    session.jumpAndPlay(pageBook, 2, 42)

    assertEquals(ListeningState.S2_PLAYING, session.state.value.state)
    assertEquals(pageBook.id, store.data.first())
    verify(exactly = 1) { player.pauseIfCurrentBookDifferentFrom(pageBook.id) }
    verify(exactly = 1) { player.setPosition(pageBook, pageBook.chapters[2].id, 42_000L) }
    verify(exactly = 1) { player.play() }
    verify(exactly = 0) { player.playPause() }
  }

  @Test
  fun toggleOnTheCurrentBookUsesPlayPause() = runTest {
    val pageBook = sessionBook()
    val session = sessionFor(pageBook)
    playStateManager.playState = PlayStateManager.PlayState.Playing
    session.alignToPlaying(pageBook)

    session.playPause(pageBook, 0, 0)

    assertEquals(ListeningState.S1_PAUSED, session.state.value.state)
    verify(exactly = 1) { player.playPause() }
    verify(exactly = 0) { player.play() }
  }

  @Test
  fun playPauseOnABrowsedBookJumpsInsteadOfToggling() = runTest {
    val pageBook = sessionBook()
    val playingBook = sessionBook()
    val session = sessionFor(pageBook)
    playStateManager.playState = PlayStateManager.PlayState.Playing
    session.alignToPlaying(playingBook)

    session.playPause(pageBook, 0, 30)

    assertEquals(pageBook.id, store.data.first())
    verify(exactly = 1) { player.play() }
    verify(exactly = 0) { player.playPause() }
    verify(exactly = 1) { player.setPosition(pageBook, pageBook.chapters[0].id, 30_000L) }
  }

  @Test
  fun nextChapterDrivesThePlayerOnlyForTheCurrentBook() = runTest {
    val pageBook = sessionBook()
    val session = sessionFor(pageBook)

    session.next(pageBook)
    verify(exactly = 0) { player.next() }

    session.alignToPlaying(pageBook)
    session.next(pageBook)
    verify(exactly = 1) { player.next() }
    assertEquals(1, session.state.value.chapterIndex)
  }

  @Test
  fun speedChangeDrivesThePlayer() = runTest {
    val pageBook = sessionBook()
    val session = sessionFor(pageBook)
    session.alignToPlaying(pageBook)

    session.setSpeed(pageBook, 1.5f)

    verify(exactly = 1) { player.setSpeed(1.5f) }
    assertEquals(1.5f, session.state.value.speed)
  }

  @Test
  fun externalPauseAlignsTheSnapshotWithoutFightingBack() = runTest {
    val pageBook = sessionBook()
    val session = sessionFor(pageBook)
    session.alignToPlaying(pageBook)

    session.syncFromLive(
      LivePlaybackState(
        bookId = pageBook.id,
        chapterId = pageBook.chapters[0].id,
        positionMs = 5_000,
        isPlaying = false,
        playbackSpeed = 1f,
      ),
    )

    assertEquals(ListeningState.S1_PAUSED, session.state.value.state)
    assertEquals(5, session.state.value.positionSec)
    // 外部已经停了：绝不回敬一次 playPause 把它重新开起来。
    verify(exactly = 0) { player.playPause() }
    verify(exactly = 0) { player.play() }
  }

  @Test
  fun unknownPlayingBookStillBlocksTheTakeover() = runTest {
    val pageBook = sessionBook()
    val playingBookId = BookId(Uuid.random().toString())
    val session = sessionFor(pageBook)

    // 只知道「那本书在播」，加载不到整本书。
    session.alignToPlayingBookId(playingBookId)
    session.open(pageBook, 0, 0)

    assertEquals(ListeningState.S2_PLAYING, session.state.value.state)
    assertEquals(playingBookId.value, session.state.value.book?.id)
    verify(exactly = 0) { player.pauseIfCurrentBookDifferentFrom(any()) }
    assertEquals(null, store.data.first())
  }

  @Test
  fun externalPlayStateAlignsPauseAndResume() = runTest {
    val pageBook = sessionBook()
    val session = sessionFor(pageBook)
    session.alignToPlaying(pageBook)

    session.syncExternalPlayState(pageBook.id, isPlaying = false)
    assertEquals(ListeningState.S1_PAUSED, session.state.value.state)

    session.syncExternalPlayState(pageBook.id, isPlaying = true)
    assertEquals(ListeningState.S2_PLAYING, session.state.value.state)

    verify(exactly = 0) { player.playPause() }
    verify(exactly = 0) { player.play() }
  }

  @Test
  fun rewindAndFastForwardUseThePlayersOwnStep() = runTest {
    val pageBook = sessionBook()
    val session = sessionFor(pageBook)
    session.alignToPlayingBookId(pageBook.id, chapterIndex = 0, positionSec = 100)

    session.rewind(pageBook)
    verify(exactly = 1) { player.rewind() }
    assertEquals(70, session.state.value.positionSec)

    session.fastForward(pageBook)
    verify(exactly = 1) { player.fastForward() }
    assertEquals(100, session.state.value.positionSec)

    // 显式拖动才走 setPosition；快进快退必须保留播放器自己的步长与跨章逻辑。
    verify(exactly = 0) { player.setPosition(any(), any(), any()) }
  }

  @Test
  fun sleepTimerElapsedStopsInS3WithTheRuleCleared() = runTest {
    val pageBook = sessionBook()
    val session = sessionFor(pageBook)
    session.alignToPlaying(pageBook)
    session.setSleep(pageBook, SleepChange.Set(SleepOption.Minutes(15)))
    assertEquals(SleepMode.MINUTES, session.state.value.sleepMode)

    session.sleepTimerElapsed(pageBook)

    val ctx = session.state.value
    assertEquals(ListeningState.S3_SLEEP_STOPPED, ctx.state)
    assertEquals(SleepMode.OFF, ctx.sleepMode)
    assertEquals(0, ctx.sleepRemainingSec)
    assertTrue(verifyListeningPropositions(ctx).isEmpty(), ctx.toString())
    verify { player.pause() }
  }

  @Test
  fun cancellingTheSleepRuleClearsTheCountdown() = runTest {
    val pageBook = sessionBook()
    val session = sessionFor(pageBook)
    session.alignToPlaying(pageBook)
    session.setSleep(pageBook, SleepChange.Set(SleepOption.Minutes(15)))

    session.setSleep(pageBook, SleepChange.Off)

    assertEquals(SleepMode.OFF, session.state.value.sleepMode)
    assertEquals(0, session.state.value.sleepRemainingSec)
  }

  @Test
  fun releaseOfACrossBookEventDoesNothingWhenGridIgnoresIt() = runTest {
    val pageBook = sessionBook()
    val playingBook = sessionBook()
    val session = sessionFor(pageBook)
    playStateManager.playState = PlayStateManager.PlayState.Playing
    session.alignToPlaying(playingBook)

    session.seekTo(pageBook, 12)
    session.next(pageBook)
    session.setSpeed(pageBook, 2f)

    // 本页只是被翻看：移步、翻章、调语速都不许作用到正在诵读的那本书。
    verify(exactly = 0) { player.setPosition(any(), any(), any()) }
    verify(exactly = 0) { player.next() }
    verify(exactly = 0) { player.setSpeed(any()) }
  }
}

private class MemoryStore<T>(initial: T) : DataStore<T> {
  private val state = MutableStateFlow(initial)
  override val data: Flow<T> = state

  override suspend fun updateData(transform: suspend (T) -> T): T {
    val next = transform(state.value)
    state.value = next
    return next
  }
}

private fun sessionBook(chapters: Int = 3): Book {
  val chapterList = List(chapters) {
    Chapter(
      id = ChapterId(Uuid.random().toString()),
      name = "第${it + 1}章",
      duration = 100_000,
      fileLastModified = Instant.EPOCH,
      fileSize = 0,
      markData = emptyList(),
    )
  }
  val id = BookId(Uuid.random().toString())
  return Book(
    content = BookContent(
      author = "玉机子",
      name = "测试书",
      positionInChapter = 0,
      playbackSpeed = 1f,
      addedAt = Instant.EPOCH,
      chapters = chapterList.map { it.id },
      cover = null,
      currentChapter = chapterList.first().id,
      isActive = true,
      lastPlayedAt = Instant.EPOCH,
      skipSilence = false,
      id = id,
      gain = 0f,
      genre = null,
      narrator = null,
      series = null,
      part = null,
    ),
    chapters = chapterList,
  )
}
