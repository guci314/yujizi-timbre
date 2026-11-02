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

  suspend fun skip(book: Book, deltaSeconds: Int) {
    val current = _state.value.positionSec
    seekTo(book, current + deltaSeconds)
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
    val ctx = _state.value
    if (ctx.book?.id == book.id.value && ctx.state == ListeningState.S2_PLAYING) return
    val index = book.chapters.indexOfFirst { it.id == book.currentChapter }.coerceAtLeast(0)
    _state.value = ctx.copy(
      state = ListeningState.S2_PLAYING,
      book = spec(book),
      chapterIndex = index,
      positionSec = (book.content.positionInChapter / 1_000).toInt(),
    )
  }

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
