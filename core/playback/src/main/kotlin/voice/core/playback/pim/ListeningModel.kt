package voice.core.playback.pim

/**
 * 「玉机子听书」纯业务模型（PIM），与 web/src/pim/listening-model.ts 同构。
 *
 * 只认识：经书、篇章、位置（秒）、语速、睡眠香。不认识播放器、网络、文件、数据库。
 */

enum class ListeningState {
  /** 未展卷：尚未选定任何经书。 */
  S0_IDLE,

  /** 展卷静置：已翻到某书某章某秒，当前静默。 */
  S1_PAUSED,

  /** 诵读中：声音流淌，播放头随时间推进，睡眠倒计时仅在此状态消减。 */
  S2_PLAYING,

  /** 睡眠止息：定时到点或本章诵毕而自动止息，除非听众主动点播，绝不自鸣。 */
  S3_SLEEP_STOPPED,
}

/** 一篇。时长未知时为 0，待诵读中获知后由 [ListeningEvent.SecondElapsed] 补上。 */
data class ChapterSpec(
  val index: Int,
  val title: String,
  val durationSec: Int,
)

/** 一卷。纯业务标识只有 id 与篇目。 */
data class BookSpec(
  val id: String,
  val title: String,
  val chapters: List<ChapterSpec>,
)

enum class SleepMode(val wire: String) {
  OFF("off"),
  MINUTES("minutes"),
  END_OF_CHAPTER("end-of-chapter"),
}

sealed interface SleepOption {
  data class Minutes(val minutes: Int) : SleepOption

  data object EndOfChapter : SleepOption
}

/** 一次睡眠香调整：设成某个规则，或取消。 */
sealed interface SleepChange {
  data class Set(val option: SleepOption) : SleepChange

  data object Off : SleepChange
}

data class ListeningContext(
  override val state: ListeningState = ListeningState.S0_IDLE,
  val book: BookSpec? = null,
  val chapterIndex: Int = 0,
  /** 当前权威播放头（秒）。 */
  val positionSec: Int = 0,
  /** 语速：0.75x ~ 2x。 */
  val speed: Float = 1f,
  val sleepMode: SleepMode = SleepMode.OFF,
  val sleepRemainingSec: Int = 0,
) : Stateful<ListeningState>

sealed interface ListeningEvent : TypedEvent {
  /** 展卷预置：翻到上次位置并回退三秒。仅在未展卷时生效。 */
  data class OpenBook(val book: BookSpec, val savedChapter: Int, val savedSec: Int) : ListeningEvent {
    override val type: String get() = "E_OPEN_BOOK"
  }

  /** 点播指定位置：选章或点书签，精准跳秒，不回退。 */
  data class JumpAndPlay(val book: BookSpec, val chapterIndex: Int, val startSec: Int) : ListeningEvent {
    override val type: String get() = "E_JUMP_AND_PLAY"
  }

  /** 开讲 / 暂停。系统打断也以本事件收敛回静置。 */
  data object TogglePlay : ListeningEvent {
    override val type: String get() = "E_TOGGLE_PLAY"
  }

  /** 移步：拖动或快进快退。 */
  data class Seek(val targetSec: Int, val chapterDurationSec: Int? = null) : ListeningEvent {
    override val type: String get() = "E_SEEK"
  }

  data object NextChapter : ListeningEvent {
    override val type: String get() = "E_NEXT_CHAPTER"
  }

  data object PrevChapter : ListeningEvent {
    override val type: String get() = "E_PREV_CHAPTER"
  }

  /** 调语速 / 设睡眠香。不传的字段表示「不改」。 */
  data class SetPref(val speed: Float? = null, val sleepChange: SleepChange? = null) : ListeningEvent {
    override val type: String get() = "E_SET_PREF"
  }

  /** 诵读时间流逝一秒：推进播放头，判断章尾续章与睡眠止息。 */
  data class SecondElapsed(
    val currentPositionSec: Int? = null,
    val chapterDurationSec: Int? = null,
  ) : ListeningEvent {
    override val type: String get() = "E_SECOND_ELAPSED"
  }
}

/** 展卷接续时回退三秒，让听众重新回到当时的语境。 */
const val RESUME_REWIND_SECONDS: Int = 3

val PLAYBACK_SPEEDS: List<Float> = listOf(0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f)

const val SKIP_SECONDS: Int = 30

fun initialListeningContext(): ListeningContext = ListeningContext()

fun clampTime(seconds: Int, durationSec: Int): Int {
  val positive = maxOf(0, seconds)
  return if (durationSec > 0) minOf(positive, durationSec) else positive
}

/** 自然接续回退三秒；书签与选章走 [ListeningEvent.JumpAndPlay]，不回退。 */
fun resumePosition(savedSec: Int, chapterDurationSec: Int = 0): Int {
  if (savedSec <= 0) return 0
  val rewound = maxOf(0, savedSec - RESUME_REWIND_SECONDS)
  if (chapterDurationSec <= 0) return rewound
  return minOf(rewound, maxOf(0, chapterDurationSec - 1))
}

fun clampChapter(book: BookSpec, chapterIndex: Int): Int {
  if (book.chapters.isEmpty()) return 0
  return chapterIndex.coerceIn(0, book.chapters.size - 1)
}

fun currentChapter(ctx: ListeningContext): ChapterSpec? =
  ctx.book?.chapters?.getOrNull(ctx.chapterIndex)

fun currentChapterDuration(ctx: ListeningContext): Int = currentChapter(ctx)?.durationSec ?: 0

fun hasNextChapter(ctx: ListeningContext): Boolean {
  val book = ctx.book ?: return false
  return ctx.chapterIndex + 1 < book.chapters.size
}

fun hasPreviousChapter(ctx: ListeningContext): Boolean = ctx.book != null && ctx.chapterIndex > 0

/** 把「这一章有多长」记进书里；时长未知(0)时不覆盖已知值。 */
fun withChapterDuration(ctx: ListeningContext, durationSec: Int): ListeningContext {
  val book = ctx.book ?: return ctx
  if (durationSec <= 0) return ctx
  val chapter = book.chapters.getOrNull(ctx.chapterIndex) ?: return ctx
  if (chapter.durationSec == durationSec) return ctx
  val chapters = book.chapters.mapIndexed { index, entry ->
    if (index == ctx.chapterIndex) entry.copy(durationSec = durationSec) else entry
  }
  return ctx.copy(book = book.copy(chapters = chapters))
}

/** 黄金考卷用的纯业务快照：跨语言逐字段比对。 */
data class ListeningSnapshot(
  val state: String,
  val bookId: String?,
  val chapterIndex: Int,
  val positionSec: Int,
  val speed: Float,
  val sleepMode: String,
  val sleepRemainingSec: Int,
  val chapterDurationSec: Int,
)

fun listeningSnapshot(ctx: ListeningContext): ListeningSnapshot = ListeningSnapshot(
  state = ctx.state.name,
  bookId = ctx.book?.id,
  chapterIndex = ctx.chapterIndex,
  positionSec = ctx.positionSec,
  speed = ctx.speed,
  sleepMode = ctx.sleepMode.wire,
  sleepRemainingSec = ctx.sleepRemainingSec,
  chapterDurationSec = currentChapterDuration(ctx),
)
