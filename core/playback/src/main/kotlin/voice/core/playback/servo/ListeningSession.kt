package voice.core.playback.servo

import androidx.datastore.core.DataStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import voice.core.data.Book
import voice.core.data.BookId
import voice.core.data.Chapter
import voice.core.data.store.CurrentBookStore
import voice.core.playback.LivePlaybackState
import voice.core.playback.PlayerController
import voice.core.playback.playstate.PlayStateManager
import voice.core.playback.pim.BookSpec
import voice.core.playback.pim.ChapterSpec
import voice.core.playback.pim.ListeningContext
import voice.core.playback.pim.ListeningEvent
import voice.core.playback.pim.ListeningState
import voice.core.playback.pim.SKIP_SECONDS
import voice.core.playback.pim.SleepChange
import voice.core.playback.pim.SleepOption
import voice.core.playback.pim.currentChapterDuration
import voice.core.playback.pim.initialListeningContext
import voice.core.playback.pim.step
import voice.core.playback.pim.LISTENING_GRID
import kotlin.math.max

/**
 * 播放器伺服驱动器：让 Media3 真正服从 [LISTENING_GRID]。
 *
 * 这里是「一 PIM 多 PSM」的 Android 落点：
 * - 业务状态只有一份（本类的 [state]），每一次迁移都由 `step(LISTENING_GRID, …)` 算出；
 * - 向下的平台动作由前后快照的**差分**推出，视图与 ViewModel 里不再手写状态分支；
 * - 向上的外部真相（通知栏、蓝牙、来电、自动续章）静默对齐回快照，不回敬指令。
 */
class ListeningSession(
  private val pageBookId: BookId,
  private val player: PlayerController,
  private val playStateManager: PlayStateManager,
  @CurrentBookStore private val currentBookStoreId: DataStore<BookId?>,
) {

  private val _state = MutableStateFlow(initialListeningContext())
  val state: StateFlow<ListeningContext> = _state.asStateFlow()

  private val books = mutableMapOf<String, Book>()

  fun register(book: Book) {
    books[book.id.value] = book
  }

  /** 展卷：网格若判定「正在诵读别书」，此事件会被忽略，伺服随之什么都不做。 */
  suspend fun open(book: Book, chapterIndex: Int, positionSec: Int) {
    register(book)
    dispatch(ListeningEvent.OpenBook(spec(book), chapterIndex, positionSec), book)
  }

  /** 开讲 / 暂停。本页不是当前书时，视为「点播这一本」。 */
  suspend fun playPause(book: Book, chapterIndex: Int, positionSec: Int) {
    register(book)
    if (_state.value.book?.id == pageBookId.value) {
      dispatch(ListeningEvent.TogglePlay, book)
    } else {
      dispatch(ListeningEvent.JumpAndPlay(spec(book), chapterIndex, positionSec), book)
    }
  }

  /** 点播：选章或点书签，精准落点。 */
  suspend fun jumpAndPlay(book: Book, chapterIndex: Int, startSec: Int) {
    register(book)
    dispatch(ListeningEvent.JumpAndPlay(spec(book), chapterIndex, startSec), book)
  }

  suspend fun next(book: Book) {
    if (!isPageBookPlaying()) return
    register(book)
    dispatch(ListeningEvent.NextChapter, book)
  }

  suspend fun previous(book: Book) {
    if (!isPageBookPlaying()) return
    register(book)
    dispatch(ListeningEvent.PrevChapter, book)
  }

  /** 移步：拖动进度条或点 ±30 秒。 */
  suspend fun seekTo(book: Book, targetSec: Int) {
    if (!isPageBookPlaying()) return
    register(book)
    dispatch(
      ListeningEvent.Seek(targetSec, currentChapterDuration(_state.value).takeIf { it > 0 }),
      book,
    )
  }

  /** 快退：快照照业务步长回退，真正的平台动作交给播放器（自带用户设定的秒数与跨章）。 */
  suspend fun rewind(book: Book) {
    skipViaPlayer(book, -SKIP_SECONDS) { player.rewind() }
  }

  /** 快进：同上。 */
  suspend fun fastForward(book: Book) {
    skipViaPlayer(book, SKIP_SECONDS) { player.fastForward() }
  }

  private suspend fun skipViaPlayer(book: Book, deltaSeconds: Int, platform: suspend () -> Unit) {
    if (!isPageBookPlaying()) return
    register(book)
    val previous = _state.value
    val next = LISTENING_GRID.step(
      previous,
      ListeningEvent.Seek(
        targetSec = previous.positionSec + deltaSeconds,
        chapterDurationSec = currentChapterDuration(previous).takeIf { it > 0 },
      ),
    )
    if (next == previous) return
    _state.value = next
    platform()
  }

  /** 同步睡眠香规则；[SleepChange.Off] 表示取消。 */
  suspend fun setSleep(book: Book, change: SleepChange) {
    register(book)
    dispatch(ListeningEvent.SetPref(sleepChange = change), book)
  }

  /**
   * 平台的睡眠定时器到点：让网格自己走到止息。
   *
   * 做法是先把倒计时压到 0，再走一次 [ListeningEvent.SecondElapsed]——
   * 归零即 S3，睡眠规则同时熄灭，满足公理 P6。
   */
  suspend fun sleepTimerElapsed(book: Book) {
    register(book)
    if (_state.value.state != ListeningState.S2_PLAYING) return
    dispatch(ListeningEvent.SetPref(sleepChange = SleepChange.Set(SleepOption.Minutes(0))), book)
    val duration = currentChapterDuration(_state.value)
    dispatch(
      ListeningEvent.SecondElapsed(
        currentPositionSec = duration.takeIf { it > 0 } ?: _state.value.positionSec,
        chapterDurationSec = duration.takeIf { it > 0 },
      ),
      book,
    )
  }

  suspend fun setSpeed(book: Book, speed: Float) {
    if (!isPageBookPlaying()) return
    register(book)
    dispatch(ListeningEvent.SetPref(speed = speed), book)
  }

  /**
   * 外部真相对齐：通知栏、蓝牙、来电、自动续章都会先改变播放器。
   * 这里只改快照，绝不回敬平台指令。
   */
  fun syncFromLive(live: LivePlaybackState?) {
    if (live == null || live.bookId != pageBookId) return
    val book = books[pageBookId.value] ?: return
    val liveIndex = book.chapters.indexOfFirst { it.id == live.chapterId }
    var ctx = _state.value

    val livePosition = (live.positionMs / 1_000).toInt()
    if (ctx.book?.id != book.id.value) {
      ctx = ctx.copy(book = spec(book), chapterIndex = max(0, liveIndex), positionSec = livePosition)
    } else if (liveIndex >= 0) {
      // 播放头以播放器为准：自动续章、通知栏跳转、拖动都会被这里对齐回来。
      ctx = ctx.copy(chapterIndex = liveIndex, positionSec = livePosition)
    }

    if (live.isPlaying && ctx.state != ListeningState.S2_PLAYING) {
      ctx = ctx.copy(state = ListeningState.S2_PLAYING)
    } else if (!live.isPlaying && ctx.state == ListeningState.S2_PLAYING) {
      ctx = ctx.copy(state = ListeningState.S1_PAUSED)
    }

    if (ctx != _state.value) _state.value = ctx
  }

  /** 粗对齐：只知道「另一本书正在诵读」时用，把网格置为那本书的诵读态。 */
  fun alignToPlaying(book: Book) {
    register(book)
    val index = book.chapters.indexOfFirst { it.id == book.currentChapter }.coerceAtLeast(0)
    alignToPlayingBookId(book.id, index, (book.content.positionInChapter / 1_000).toInt())
  }

  /**
   * 只知道「这本书正在诵读」、而无从加载整本书时的粗对齐。
   *
   * 关键：即便查不到那本书，也必须把网格置为它的 S2 —— 否则网格停在 S0，
   * 紧接着本页的展卷会把正在诵读的书当成「空闲」而抢过去。
   */
  fun alignToPlayingBookId(
    bookId: BookId,
    chapterIndex: Int = 0,
    positionSec: Int = 0,
  ) {
    val ctx = _state.value
    if (ctx.book?.id == bookId.value && ctx.state == ListeningState.S2_PLAYING) return
    _state.value = ctx.copy(
      state = ListeningState.S2_PLAYING,
      // 占位规格也必须带够篇章：P5 不允许「已展卷但无篇 / 章号越界」。
      book = specOrPlaceholder(bookId, chapterIndex),
      chapterIndex = chapterIndex,
      positionSec = positionSec,
    )
  }

  /**
   * 外部播放状态对齐（睡眠香到点、蓝牙、系统焦点）。
   * 只改快照，绝不回敬指令 —— 外部已经按下暂停，我们再 playPause 一次就会把它重新开起来。
   */
  fun syncExternalPlayState(currentBookId: BookId?, isPlaying: Boolean) {
    if (currentBookId == null) return

    if (currentBookId != pageBookId) {
      if (isPlaying) alignToPlayingBookId(currentBookId)
      return
    }

    val ctx = _state.value
    if (isPlaying && ctx.state != ListeningState.S2_PLAYING) {
      _state.value = ctx.copy(
        state = ListeningState.S2_PLAYING,
        book = ctx.book ?: specOrPlaceholder(pageBookId),
      )
    } else if (!isPlaying && ctx.state == ListeningState.S2_PLAYING) {
      _state.value = ctx.copy(state = ListeningState.S1_PAUSED)
    }
  }

  /**
   * 拿不到整本书时，用占位规格顶上：篇章数必须覆盖 [chapterIndex]，
   * 否则 S2 快照会当场违反 P5_展卷完整性公理（章号越界 / 无篇章）。
   */
  private fun specOrPlaceholder(bookId: BookId, chapterIndex: Int = 0): BookSpec =
    books[bookId.value]?.let(::spec) ?: BookSpec(
      id = bookId.value,
      title = "",
      chapters = (0..maxOf(0, chapterIndex)).map { index ->
        ChapterSpec(index = index, title = "", durationSec = 0)
      },
    )

  private fun isPageBookPlaying(): Boolean = _state.value.book?.id == pageBookId.value

  private suspend fun dispatch(event: ListeningEvent, book: Book) {
    val previous = _state.value
    val next = LISTENING_GRID.step(previous, event)
    // 网格明确「不理」：伺服什么都不做。A 书正在诵读时翻看 B 书，靠的就是这一条。
    if (next == previous) return
    _state.value = next
    serve(previous, next, event, book)
  }

  private suspend fun serve(
    previous: ListeningContext,
    next: ListeningContext,
    event: ListeningEvent,
    book: Book,
  ) {
    val switchedBook = next.book?.id != previous.book?.id
    if (switchedBook) {
      // 先让旧书停下，再认领新书；顺序不能反，否则旧书还占着播放器。
      player.pauseIfCurrentBookDifferentFrom(book.id)
      currentBookStoreId.updateData { book.id }
    }

    when (event) {
      is ListeningEvent.OpenBook -> Unit

      is ListeningEvent.JumpAndPlay -> {
        seekToPosition(book, next)
        player.play()
      }

      is ListeningEvent.TogglePlay -> player.playPause()

      is ListeningEvent.NextChapter ->
        if (next.chapterIndex != previous.chapterIndex) player.next()

      is ListeningEvent.PrevChapter ->
        if (next.chapterIndex != previous.chapterIndex) player.previous()

      is ListeningEvent.Seek -> seekToPosition(book, next)

      is ListeningEvent.SetPref ->
        if (next.speed != previous.speed) player.setSpeed(next.speed)

      is ListeningEvent.SecondElapsed -> Unit
    }

    // 离开诵读态（睡眠止息、全书诵毕）就要真的停下：网格说了算。
    if (previous.state == ListeningState.S2_PLAYING &&
      next.state != ListeningState.S2_PLAYING &&
      event !is ListeningEvent.TogglePlay
    ) {
      player.pause()
    }
  }

  private fun seekToPosition(book: Book, ctx: ListeningContext) {
    val chapterId = book.chapters.getOrNull(ctx.chapterIndex)?.id ?: return
    player.setPosition(
      book = book,
      chapterId = chapterId,
      positionInChapterMs = ctx.positionSec * 1_000L,
    )
  }

  private fun spec(book: Book): BookSpec = BookSpec(
    id = book.id.value,
    title = book.content.name,
    chapters = book.chapters.mapIndexed { index, chapter ->
      ChapterSpec(
        index = index,
        title = chapter.name ?: "",
        durationSec = chapterDurationSec(chapter),
      )
    },
  )

  private fun chapterDurationSec(chapter: Chapter): Int = (chapter.duration / 1_000L).toInt()
}
