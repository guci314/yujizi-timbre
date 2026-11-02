package voice.core.playback.pim

/**
 * 命题性知识（Propositional Knowledge）。
 *
 * 每一条公理都返回 `String?`：`null` 表示满足，非空字符串说明为什么违例。
 * 公理必须可被证伪——一个永远返回 null 的「公理」只是摆设。负向变异测试
 * （塞假币）就是用来证明这一点的。
 */

/**
 * P1：某书进入书箧可见列表 ⟺ 该书在 `kept` 中至少有一篇处于 `D2_KEPT`。
 *
 * `visible` 默认为 [bookcaseBooks] 的产物；显式传入是为了让「可见性算错」
 * 这种缺陷可以被检验出来。
 */
fun P1_书箧可见充要条件(
  books: List<BookSpec>,
  kept: Iterable<RetentionContext>,
  visible: List<BookSpec> = bookcaseBooks(books, kept),
): String? {
  val keptList = kept.toList()
  val shouldBeVisible = books
    .filter { book -> keptList.any { it.bookId == book.id && it.state == RetentionState.D2_KEPT } }
    .map { it.id }
    .toSet()
  val actuallyVisible = visible.map { it.id }.toSet()
  if (shouldBeVisible == actuallyVisible) return null
  val missing = shouldBeVisible - actuallyVisible
  val extra = actuallyVisible - shouldBeVisible
  return "书箧可见性与留存事实不符：缺少 $missing，多出 $extra"
}

/**
 * P2：某篇可诵读 ⟺ 在线，或该篇已入箧。
 *
 * `playable` 是外部观察到的「能否诵读」；把它传进来，公理才有被证伪的可能。
 */
fun P2_篇章可诵读充要条件(
  online: Boolean,
  bookId: String,
  chapterIndex: Int,
  kept: Iterable<RetentionContext>,
  playable: Boolean,
): String? {
  val keptOffline = isChapterAvailable(bookId, chapterIndex, kept)
  val shouldBePlayable = online || keptOffline
  if (playable == shouldBePlayable) return null
  return "第 ${chapterIndex + 1} 篇：在线=$online、已入箧=$keptOffline，但可诵读=$playable"
}

/** P3：只有已入箧才允许占用书箧空间，且已入箧必须真的占着空间。 */
fun P3_非入箧零空间公理(ctx: RetentionContext): String? = when {
  ctx.state == RetentionState.D2_KEPT && ctx.occupiedSpace <= 0L ->
    "已入箧却占用 ${ctx.occupiedSpace}"
  ctx.state != RetentionState.D2_KEPT && ctx.occupiedSpace != 0L ->
    "${ctx.state} 仍占着 ${ctx.occupiedSpace}"
  else -> null
}

/** P4（听书）：播放头不为负，且不超过当前章时长。 */
fun P4_播放头与留存进度有界公理(ctx: ListeningContext): String? {
  if (ctx.positionSec < 0) return "播放头为负：${ctx.positionSec}"
  val duration = currentChapterDuration(ctx)
  if (duration > 0 && ctx.positionSec > duration) {
    return "播放头 ${ctx.positionSec} 超出本章时长 $duration"
  }
  return null
}

/** P4（书箧）：留存进度必须落在 0..100。 */
fun P4_播放头与留存进度有界公理(ctx: RetentionContext): String? =
  if (ctx.progressPct !in 0..100) "留存进度越界：${ctx.progressPct}" else null

/**
 * P5：已展卷必有书、有篇、章号在篇内；未展卷必不带书。
 *
 * 这条公理当场抓出过 `alignToPlayingBookId` 塞空书进 S2 的漏洞。
 */
fun P5_展卷完整性公理(ctx: ListeningContext): String? {
  val book = ctx.book
  if (ctx.state == ListeningState.S0_IDLE) {
    return if (book == null) null else "未展卷却带着书 ${book.id}"
  }
  if (book == null) return "已展卷（${ctx.state}）但书为空"
  if (book.chapters.isEmpty()) return "已展卷（${ctx.state}）但书无篇章：${book.id}"
  if (ctx.chapterIndex !in book.chapters.indices) {
    return "章号越界：${ctx.chapterIndex} 不在 0..${book.chapters.lastIndex}"
  }
  return null
}

/** P6：只有分钟睡眠香才允许有倒计时；止息态必须已熄火。 */
fun P6_睡眠香一致性公理(ctx: ListeningContext): String? {
  if (ctx.sleepMode != SleepMode.MINUTES && ctx.sleepRemainingSec != 0) {
    return "睡眠香为 ${ctx.sleepMode.wire} 却仍有 ${ctx.sleepRemainingSec} 秒倒计时"
  }
  if (ctx.state == ListeningState.S3_SLEEP_STOPPED &&
    (ctx.sleepMode != SleepMode.OFF || ctx.sleepRemainingSec != 0)
  ) {
    return "已止息却仍点着睡眠香（${ctx.sleepMode.wire} / ${ctx.sleepRemainingSec} 秒）"
  }
  return null
}

/** 听书快照的聚合校验：逐条跑，返回所有违例原因。 */
fun verifyListeningPropositions(ctx: ListeningContext): List<String> =
  listOfNotNull(
    P4_播放头与留存进度有界公理(ctx),
    P5_展卷完整性公理(ctx),
    P6_睡眠香一致性公理(ctx),
  )

/** 留存快照的聚合校验。 */
fun verifyRetentionPropositions(ctx: RetentionContext): List<String> =
  listOfNotNull(
    P3_非入箧零空间公理(ctx),
    P4_播放头与留存进度有界公理(ctx),
  )
