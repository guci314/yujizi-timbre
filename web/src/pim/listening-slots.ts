/**
 * 听书诵读的八个插槽。
 *
 * 每个插槽都是纯函数：吃进旧快照，吐出新快照。不播放、不写库、不发通知——
 * 那些都是平台外壳看见快照变化后自己的事。
 */

import {
  clampChapter,
  clampTime,
  currentChapterDuration,
  hasNextChapter,
  hasPreviousChapter,
  resumePosition,
  withChapterDuration,
  type BookSpec,
  type ListeningContext,
  type SleepOption,
  type SleepMode,
} from './listening-model'

/** 展卷预置：翻到上次位置，回退三秒延续语境。仅在未展卷时使用。 */
export function actOpenBook(
  ctx: ListeningContext,
  book: BookSpec,
  savedChapter: number,
  savedSec: number,
): ListeningContext {
  if (book.chapters.length === 0) return ctx
  const chapterIndex = clampChapter(book, savedChapter)
  const durationSec = book.chapters[chapterIndex]?.durationSec ?? 0
  return {
    ...ctx,
    state: 'S1_PAUSED',
    book,
    chapterIndex,
    positionSec: resumePosition(savedSec, durationSec),
  }
}

/** 点播：选章或点书签，精准落到指定秒并开讲。 */
export function actJumpAndPlay(
  ctx: ListeningContext,
  book: BookSpec,
  chapterIndex: number,
  startSec: number,
): ListeningContext {
  if (book.chapters.length === 0) return ctx
  const index = clampChapter(book, chapterIndex)
  const durationSec = book.chapters[index]?.durationSec ?? 0
  return {
    ...ctx,
    state: 'S2_PLAYING',
    book,
    chapterIndex: index,
    positionSec: clampTime(startSec, durationSec),
  }
}

/** 开讲 / 暂停。睡眠止息后主动点播视为唤醒。 */
export function actTogglePlay(ctx: ListeningContext): ListeningContext {
  switch (ctx.state) {
    case 'S1_PAUSED':
    case 'S3_SLEEP_STOPPED':
      return { ...ctx, state: 'S2_PLAYING' }
    case 'S2_PLAYING':
      return { ...ctx, state: 'S1_PAUSED' }
    default:
      return ctx
  }
}

/** 移步：拖动或 ±30 秒。睡眠止息下移步即回到静置。 */
export function actSeek(ctx: ListeningContext, targetSec: number, chapterDurationSec?: number): ListeningContext {
  if (ctx.state === 'S0_IDLE') return ctx
  const withDuration = chapterDurationSec === undefined ? ctx : withChapterDuration(ctx, chapterDurationSec)
  const positionSec = clampTime(targetSec, currentChapterDuration(withDuration))
  if (withDuration.state === 'S3_SLEEP_STOPPED') {
    return { ...withDuration, state: 'S1_PAUSED', positionSec }
  }
  return { ...withDuration, positionSec }
}

/** 下一章：换了篇章就从头开讲。 */
export function actNextChapter(ctx: ListeningContext): ListeningContext {
  if (!hasNextChapter(ctx) || ctx.book === null) return ctx
  return { ...ctx, state: 'S2_PLAYING', chapterIndex: ctx.chapterIndex + 1, positionSec: 0 }
}

/** 上一章：换了篇章就从头开讲。 */
export function actPreviousChapter(ctx: ListeningContext): ListeningContext {
  if (!hasPreviousChapter(ctx)) return ctx
  return { ...ctx, state: 'S2_PLAYING', chapterIndex: ctx.chapterIndex - 1, positionSec: 0 }
}

/** 调语速 / 设睡眠香；不改变当前状态。 */
export function actSetPreference(
  ctx: ListeningContext,
  speed?: number,
  sleepOption?: SleepOption | null,
): ListeningContext {
  const nextSpeed = speed !== undefined && Number.isFinite(speed) && speed > 0 ? speed : ctx.speed
  if (sleepOption === undefined) return { ...ctx, speed: nextSpeed }

  const sleep: { sleepMode: SleepMode; sleepRemainingSec: number } =
    sleepOption === null
      ? { sleepMode: 'off', sleepRemainingSec: 0 }
      : sleepOption.kind === 'end-of-chapter'
        ? { sleepMode: 'end-of-chapter', sleepRemainingSec: 0 }
        : { sleepMode: 'minutes', sleepRemainingSec: Math.max(0, Math.round(sleepOption.minutes * 60)) }

  return { ...ctx, speed: nextSpeed, ...sleep }
}

/**
 * 时间流逝一秒。这是唯一推进播放头的插槽，也是唯一消减睡眠倒计时的插槽。
 * 静置与止息下由网格直接忽略，倒计时因此天然冻结。
 */
export function actSecondElapsed(
  ctx: ListeningContext,
  currentPositionSec?: number,
  chapterDurationSec?: number,
): ListeningContext {
  if (ctx.state !== 'S2_PLAYING') return ctx

  const withDuration =
    chapterDurationSec === undefined ? ctx : withChapterDuration(ctx, chapterDurationSec)
  const durationSec = currentChapterDuration(withDuration)

  let sleepRemainingSec = withDuration.sleepRemainingSec
  if (withDuration.sleepMode === 'minutes') {
    sleepRemainingSec = Math.max(0, sleepRemainingSec - 1)
    if (sleepRemainingSec <= 0) {
      return {
        ...withDuration,
        state: 'S3_SLEEP_STOPPED',
        sleepMode: 'off',
        sleepRemainingSec: 0,
        positionSec: clampTime(currentPositionSec ?? withDuration.positionSec + 1, durationSec),
      }
    }
  }

  const positionSec = clampTime(currentPositionSec ?? withDuration.positionSec + 1, durationSec)
  const advanced: ListeningContext = { ...withDuration, sleepRemainingSec, positionSec }

  if (durationSec > 0 && positionSec >= durationSec) {
    if (advanced.sleepMode === 'end-of-chapter') {
      return {
        ...advanced,
        state: 'S3_SLEEP_STOPPED',
        sleepMode: 'off',
        sleepRemainingSec: 0,
        positionSec: durationSec,
      }
    }
    if (advanced.book !== null && advanced.chapterIndex + 1 < advanced.book.chapters.length) {
      return { ...advanced, chapterIndex: advanced.chapterIndex + 1, positionSec: 0 }
    }
    return { ...advanced, state: 'S1_PAUSED', positionSec: durationSec }
  }

  return advanced
}
