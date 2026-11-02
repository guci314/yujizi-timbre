package voice.core.playback.pim

import kotlin.reflect.KClass

/**
 * ListeningGrid：4 状态 × 8 事件 = 32 格，与 web/src/pim/listening-grid.ts 同构。
 *
 * 整张表就是「听书」这件事的全部规矩。没有一格提到播放器、浏览器或数据库。
 */

private typealias ListeningCell = (ListeningContext, ListeningEvent) -> ListeningContext

private fun ignore(): ListeningCell = { ctx, _ -> ctx }

private inline fun <reified T : ListeningEvent> on(
  noinline body: (ListeningContext, T) -> ListeningContext,
): ListeningCell = { ctx, event -> body(ctx, event as T) }

private fun cell(
  state: ListeningState,
  type: KClass<out ListeningEvent>,
  body: ListeningCell,
): Pair<Pair<ListeningState, KClass<out ListeningEvent>>, ListeningCell> = (state to type) to body

val LISTENING_STATES: List<ListeningState> = ListeningState.entries

val LISTENING_EVENT_TYPES: List<KClass<out ListeningEvent>> = listOf(
  ListeningEvent.OpenBook::class,
  ListeningEvent.JumpAndPlay::class,
  ListeningEvent.TogglePlay::class,
  ListeningEvent.Seek::class,
  ListeningEvent.NextChapter::class,
  ListeningEvent.PrevChapter::class,
  ListeningEvent.SetPref::class,
  ListeningEvent.SecondElapsed::class,
)

val LISTENING_GRID: GridTable<ListeningState, ListeningContext, ListeningEvent> = GridTable(
  states = LISTENING_STATES,
  eventTypes = LISTENING_EVENT_TYPES,
  cells = mapOf(
    // ---- S0_未展卷 ----
    cell(ListeningState.S0_IDLE, ListeningEvent.OpenBook::class, on<ListeningEvent.OpenBook> { ctx, e ->
      actOpenBook(ctx, e.book, e.savedChapter, e.savedSec)
    }),
    cell(ListeningState.S0_IDLE, ListeningEvent.JumpAndPlay::class, on<ListeningEvent.JumpAndPlay> { ctx, e ->
      actJumpAndPlay(ctx, e.book, e.chapterIndex, e.startSec)
    }),
    cell(ListeningState.S0_IDLE, ListeningEvent.TogglePlay::class, ignore()),
    cell(ListeningState.S0_IDLE, ListeningEvent.Seek::class, ignore()),
    cell(ListeningState.S0_IDLE, ListeningEvent.NextChapter::class, ignore()),
    cell(ListeningState.S0_IDLE, ListeningEvent.PrevChapter::class, ignore()),
    cell(ListeningState.S0_IDLE, ListeningEvent.SetPref::class, on<ListeningEvent.SetPref> { ctx, e ->
      actSetPreference(ctx, e.speed, e.sleepChange)
    }),
    cell(ListeningState.S0_IDLE, ListeningEvent.SecondElapsed::class, ignore()),

    // ---- S1_展卷静置 ----
    // 翻看别书目录，绝不换掉当前展卷。
    cell(ListeningState.S1_PAUSED, ListeningEvent.OpenBook::class, ignore()),
    cell(ListeningState.S1_PAUSED, ListeningEvent.JumpAndPlay::class, on<ListeningEvent.JumpAndPlay> { ctx, e ->
      actJumpAndPlay(ctx, e.book, e.chapterIndex, e.startSec)
    }),
    cell(ListeningState.S1_PAUSED, ListeningEvent.TogglePlay::class, on<ListeningEvent.TogglePlay> { ctx, _ ->
      actTogglePlay(ctx)
    }),
    cell(ListeningState.S1_PAUSED, ListeningEvent.Seek::class, on<ListeningEvent.Seek> { ctx, e ->
      actSeek(ctx, e.targetSec, e.chapterDurationSec)
    }),
    cell(ListeningState.S1_PAUSED, ListeningEvent.NextChapter::class, on<ListeningEvent.NextChapter> { ctx, _ ->
      actNextChapter(ctx)
    }),
    cell(ListeningState.S1_PAUSED, ListeningEvent.PrevChapter::class, on<ListeningEvent.PrevChapter> { ctx, _ ->
      actPreviousChapter(ctx)
    }),
    cell(ListeningState.S1_PAUSED, ListeningEvent.SetPref::class, on<ListeningEvent.SetPref> { ctx, e ->
      actSetPreference(ctx, e.speed, e.sleepChange)
    }),
    // 静置期进度与睡眠倒计时天然冻结。
    cell(ListeningState.S1_PAUSED, ListeningEvent.SecondElapsed::class, ignore()),

    // ---- S2_诵读中 ----
    // 正在诵读时翻别书目录，绝不掐断。
    cell(ListeningState.S2_PLAYING, ListeningEvent.OpenBook::class, ignore()),
    cell(ListeningState.S2_PLAYING, ListeningEvent.JumpAndPlay::class, on<ListeningEvent.JumpAndPlay> { ctx, e ->
      actJumpAndPlay(ctx, e.book, e.chapterIndex, e.startSec)
    }),
    cell(ListeningState.S2_PLAYING, ListeningEvent.TogglePlay::class, on<ListeningEvent.TogglePlay> { ctx, _ ->
      actTogglePlay(ctx)
    }),
    cell(ListeningState.S2_PLAYING, ListeningEvent.Seek::class, on<ListeningEvent.Seek> { ctx, e ->
      actSeek(ctx, e.targetSec, e.chapterDurationSec)
    }),
    cell(ListeningState.S2_PLAYING, ListeningEvent.NextChapter::class, on<ListeningEvent.NextChapter> { ctx, _ ->
      actNextChapter(ctx)
    }),
    cell(ListeningState.S2_PLAYING, ListeningEvent.PrevChapter::class, on<ListeningEvent.PrevChapter> { ctx, _ ->
      actPreviousChapter(ctx)
    }),
    cell(ListeningState.S2_PLAYING, ListeningEvent.SetPref::class, on<ListeningEvent.SetPref> { ctx, e ->
      actSetPreference(ctx, e.speed, e.sleepChange)
    }),
    cell(ListeningState.S2_PLAYING, ListeningEvent.SecondElapsed::class, on<ListeningEvent.SecondElapsed> { ctx, e ->
      actSecondElapsed(ctx, e.currentPositionSec, e.chapterDurationSec)
    }),

    // ---- S3_睡眠止息 ----
    cell(ListeningState.S3_SLEEP_STOPPED, ListeningEvent.OpenBook::class, ignore()),
    cell(ListeningState.S3_SLEEP_STOPPED, ListeningEvent.JumpAndPlay::class, on<ListeningEvent.JumpAndPlay> { ctx, e ->
      actJumpAndPlay(ctx, e.book, e.chapterIndex, e.startSec)
    }),
    cell(ListeningState.S3_SLEEP_STOPPED, ListeningEvent.TogglePlay::class, on<ListeningEvent.TogglePlay> { ctx, _ ->
      actTogglePlay(ctx)
    }),
    cell(ListeningState.S3_SLEEP_STOPPED, ListeningEvent.Seek::class, on<ListeningEvent.Seek> { ctx, e ->
      actSeek(ctx, e.targetSec, e.chapterDurationSec)
    }),
    cell(ListeningState.S3_SLEEP_STOPPED, ListeningEvent.NextChapter::class, on<ListeningEvent.NextChapter> { ctx, _ ->
      actNextChapter(ctx)
    }),
    cell(ListeningState.S3_SLEEP_STOPPED, ListeningEvent.PrevChapter::class, on<ListeningEvent.PrevChapter> { ctx, _ ->
      actPreviousChapter(ctx)
    }),
    cell(ListeningState.S3_SLEEP_STOPPED, ListeningEvent.SetPref::class, on<ListeningEvent.SetPref> { ctx, e ->
      actSetPreference(ctx, e.speed, e.sleepChange)
    }),
    // 半夜的「时间流逝」不得让已止息的书自己诈尸。
    cell(ListeningState.S3_SLEEP_STOPPED, ListeningEvent.SecondElapsed::class, ignore()),
  ),
)

val LISTENING_CELL_COUNT: Int get() = LISTENING_STATES.size * LISTENING_EVENT_TYPES.size
