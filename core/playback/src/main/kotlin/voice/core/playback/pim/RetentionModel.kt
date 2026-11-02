package voice.core.playback.pim

/**
 * 「书箧留存」纯业务模型，与 web/src/pim/retention-*.ts 同构。
 *
 * 离线下载的业务含义：把某篇提前收进本机书箧，出门无网也能照常展卷诵读；
 * 不用了再释出，腾出空间。怎么收（网络、缓存、临时文件）是各端书架的手艺。
 */

enum class RetentionState {
  /** 未留存：本篇不在书箧中，仅可在线取用。 */
  D0_NOT_KEPT,

  /** 留存中：正在把本篇收入书箧。 */
  D1_KEEPING,

  /** 已留存：本篇已完好收入书箧。 */
  D2_KEPT,

  /** 留存未果：书源中断、内容残损或书箧已满。 */
  D3_FAILED,
}

enum class KeepFailReason(val wire: String) {
  SOURCE_UNREACHABLE("SOURCE_UNREACHABLE"),
  CONTENT_CORRUPTED("CONTENT_CORRUPTED"),
  SPACE_FULL("SPACE_FULL"),
}

data class RetentionContext(
  val bookId: String,
  val chapterIndex: Int,
  override val state: RetentionState = RetentionState.D0_NOT_KEPT,
  /** 0..100 */
  val progressPct: Int = 0,
  /** 本篇占用的书箧容量；只有 [RetentionState.D2_KEPT] 允许大于零。单位由各端书架自定。 */
  val occupiedSpace: Long = 0L,
  val failReason: KeepFailReason? = null,
) : Stateful<RetentionState>

sealed interface RetentionEvent : TypedEvent {
  data object RequestKeep : RetentionEvent {
    override val type: String get() = "E_REQUEST_KEEP"
  }

  data class KeepProgress(val pct: Int) : RetentionEvent {
    override val type: String get() = "E_KEEP_PROGRESS"
  }

  data class VerifiedComplete(val space: Long) : RetentionEvent {
    override val type: String get() = "E_VERIFIED_COMPLETE"
  }

  data class KeepFailed(val reason: KeepFailReason) : RetentionEvent {
    override val type: String get() = "E_KEEP_FAILED"
  }

  data object Release : RetentionEvent {
    override val type: String get() = "E_RELEASE"
  }
}

fun initialRetentionContext(bookId: String, chapterIndex: Int): RetentionContext =
  RetentionContext(bookId = bookId, chapterIndex = chapterIndex)

/** 黄金考卷用的纯业务快照。 */
data class RetentionSnapshot(
  val state: String,
  val bookId: String,
  val chapterIndex: Int,
  val progressPct: Int,
  val occupiedSpace: Long,
  val failReason: String?,
)

fun retentionSnapshot(ctx: RetentionContext): RetentionSnapshot = RetentionSnapshot(
  state = ctx.state.name,
  bookId = ctx.bookId,
  chapterIndex = ctx.chapterIndex,
  progressPct = ctx.progressPct,
  occupiedSpace = ctx.occupiedSpace,
  failReason = ctx.failReason?.wire,
)
