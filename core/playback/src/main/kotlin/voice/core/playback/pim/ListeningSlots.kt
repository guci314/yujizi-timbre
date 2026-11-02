package voice.core.playback.pim

/**
 * 听书诵读的八个插槽，与 web/src/pim/listening-slots.ts 同构。
 *
 * 每个插槽都是纯函数：吃进旧快照，吐出新快照。不播放、不写库、不发通知。
 */

/** 展卷预置：翻到上次位置，回退三秒延续语境。仅在未展卷时使用。 */
fun actOpenBook(
  ctx: ListeningContext,
  book: BookSpec,
  savedChapter: Int,
  savedSec: Int,
): ListeningContext {
  if (book.chapters.isEmpty()) return ctx
  val chapterIndex = clampChapter(book, savedChapter)
  val durationSec = book.chapters[chapterIndex].durationSec
  return ctx.copy(
    state = ListeningState.S1_PAUSED,
    book = book,
    chapterIndex = chapterIndex,
    positionSec = resumePosition(savedSec, durationSec),
  )
}

/** 点播：选章或点书签，精准落到指定秒并开讲。 */
fun actJumpAndPlay(
  ctx: ListeningContext,
  book: BookSpec,
  chapterIndex: Int,
  startSec: Int,
): ListeningContext {
  if (book.chapters.isEmpty()) return ctx
  val index = clampChapter(book, chapterIndex)
  val durationSec = book.chapters[index].durationSec
  return ctx.copy(
    state = ListeningState.S2_PLAYING,
    book = book,
    chapterIndex = index,
    positionSec = clampTime(startSec, durationSec),
  )
}

/** 开讲 / 暂停。睡眠止息后主动点播视为唤醒。 */
fun actTogglePlay(ctx: ListeningContext): ListeningContext = when (ctx.state) {
  ListeningState.S1_PAUSED, ListeningState.S3_SLEEP_STOPPED -> ctx.copy(state = ListeningState.S2_PLAYING)
  ListeningState.S2_PLAYING -> ctx.copy(state = ListeningState.S1_PAUSED)
  ListeningState.S0_IDLE -> ctx
}

/** 移步：拖动或 ±30 秒。睡眠止息下移步即回到静置。 */
fun actSeek(ctx: ListeningContext, targetSec: Int, chapterDurationSec: Int? = null): ListeningContext {
  if (ctx.state == ListeningState.S0_IDLE) return ctx
  val withDuration = if (chapterDurationSec == null) ctx else withChapterDuration(ctx, chapterDurationSec)
  val positionSec = clampTime(targetSec, currentChapterDuration(withDuration))
  return if (withDuration.state == ListeningState.S3_SLEEP_STOPPED) {
    withDuration.copy(state = ListeningState.S1_PAUSED, positionSec = positionSec)
  } else {
    withDuration.copy(positionSec = positionSec)
  }
}

/** 下一章：换了篇章就从头开讲。 */
fun actNextChapter(ctx: ListeningContext): ListeningContext {
  if (!hasNextChapter(ctx)) return ctx
  return ctx.copy(
    state = ListeningState.S2_PLAYING,
    chapterIndex = ctx.chapterIndex + 1,
    positionSec = 0,
  )
}

/** 上一章：换了篇章就从头开讲。 */
fun actPreviousChapter(ctx: ListeningContext): ListeningContext {
  if (!hasPreviousChapter(ctx)) return ctx
  return ctx.copy(
    state = ListeningState.S2_PLAYING,
    chapterIndex = ctx.chapterIndex - 1,
    positionSec = 0,
  )
}

/** 调语速 / 设睡眠香；不改变当前状态。 */
fun actSetPreference(
  ctx: ListeningContext,
  speed: Float? = null,
  sleepChange: SleepChange? = null,
): ListeningContext {
  val nextSpeed = if (speed != null && speed > 0f) speed else ctx.speed
  if (sleepChange == null) return ctx.copy(speed = nextSpeed)

  val updated = when (sleepChange) {
    is SleepChange.Off -> ctx.copy(
      speed = nextSpeed,
      sleepMode = SleepMode.OFF,
      sleepRemainingSec = 0,
    )

    is SleepChange.Set -> when (val option = sleepChange.option) {
      is SleepOption.EndOfChapter -> ctx.copy(
        speed = nextSpeed,
        sleepMode = SleepMode.END_OF_CHAPTER,
        sleepRemainingSec = 0,
      )

      is SleepOption.Minutes -> ctx.copy(
        speed = nextSpeed,
        sleepMode = SleepMode.MINUTES,
        sleepRemainingSec = maxOf(0, option.minutes * 60),
      )
    }
  }

  // 止息之后重新点香，说明听众醒了：回到静置待播，香已点好。
  // 否则会留下「已止息却仍点着香」的矛盾快照（违反 P6）。
  return if (ctx.state == ListeningState.S3_SLEEP_STOPPED && sleepChange is SleepChange.Set) {
    updated.copy(state = ListeningState.S1_PAUSED)
  } else {
    updated
  }
}

/**
 * 时间流逝一秒。唯一推进播放头的插槽，也是唯一消减睡眠倒计时的插槽。
 * 静置与止息下由网格直接忽略，倒计时因此天然冻结。
 */
fun actSecondElapsed(
  ctx: ListeningContext,
  currentPositionSec: Int? = null,
  chapterDurationSec: Int? = null,
): ListeningContext {
  if (ctx.state != ListeningState.S2_PLAYING) return ctx

  val withDuration = if (chapterDurationSec == null) ctx else withChapterDuration(ctx, chapterDurationSec)
  val durationSec = currentChapterDuration(withDuration)

  var sleepRemainingSec = withDuration.sleepRemainingSec
  if (withDuration.sleepMode == SleepMode.MINUTES) {
    sleepRemainingSec = maxOf(0, sleepRemainingSec - 1)
    if (sleepRemainingSec <= 0) {
      return withDuration.copy(
        state = ListeningState.S3_SLEEP_STOPPED,
        sleepMode = SleepMode.OFF,
        sleepRemainingSec = 0,
        positionSec = clampTime(currentPositionSec ?: (withDuration.positionSec + 1), durationSec),
      )
    }
  }

  val positionSec = clampTime(currentPositionSec ?: (withDuration.positionSec + 1), durationSec)
  val advanced = withDuration.copy(sleepRemainingSec = sleepRemainingSec, positionSec = positionSec)

  if (durationSec > 0 && positionSec >= durationSec) {
    if (advanced.sleepMode == SleepMode.END_OF_CHAPTER) {
      return advanced.copy(
        state = ListeningState.S3_SLEEP_STOPPED,
        sleepMode = SleepMode.OFF,
        sleepRemainingSec = 0,
        positionSec = durationSec,
      )
    }
    val book = advanced.book
    if (book != null && advanced.chapterIndex + 1 < book.chapters.size) {
      return advanced.copy(chapterIndex = advanced.chapterIndex + 1, positionSec = 0)
    }
    return advanced.copy(state = ListeningState.S1_PAUSED, positionSec = durationSec)
  }

  return advanced
}
