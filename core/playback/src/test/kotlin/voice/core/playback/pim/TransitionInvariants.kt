package voice.core.playback.pim

/**
 * 迁移不变量：黄金考卷的 BFS 与命题验证共用同一批定义。
 *
 * 抽成顶层函数，是为了让「塞假币」测试能直接拿这些不变量去检验假快照，
 * 而不是只能相信「BFS 跑过一遍没炸」。
 */

internal fun listeningInvariants(): List<Invariant<ListeningState, ListeningContext, ListeningEvent>> =
  listOf(
    Invariant("I2_展卷不打扰") { _, event, before, after ->
      if (event !is ListeningEvent.OpenBook) {
        null
      } else if (before.state == ListeningState.S0_IDLE) {
        null
      } else {
        if (before == after) null else "${before.state} 下展卷换掉了当前书"
      }
    },
    Invariant("I3_静置与止息不流逝") { _, event, before, after ->
      if (event !is ListeningEvent.SecondElapsed) {
        null
      } else if (before.state == ListeningState.S2_PLAYING) {
        null
      } else {
        if (before == after) null else "${before.state} 下时间仍在走"
      }
    },
    Invariant("I4_倒计时只在诵读中消减") { _, event, before, after ->
      if (event !is ListeningEvent.SecondElapsed || before.state == ListeningState.S2_PLAYING) {
        null
      } else {
        if (after.sleepRemainingSec == before.sleepRemainingSec) {
          null
        } else {
          "非诵读态倒计时从 ${before.sleepRemainingSec} 变成 ${after.sleepRemainingSec}"
        }
      }
    },
    Invariant("I5_止息不诈尸") { _, event, before, after ->
      if (before.state == ListeningState.S3_SLEEP_STOPPED &&
        event is ListeningEvent.SecondElapsed &&
        after.state == ListeningState.S2_PLAYING
      ) {
        "睡眠止息被一次时间流逝唤醒"
      } else {
        null
      }
    },
    Invariant("I6_位置不为负") { _, _, _, after ->
      if (after.positionSec < 0) "位置为负：${after.positionSec}" else null
    },
    Invariant("P4_播放头有界") { _, _, _, after -> P4_播放头与留存进度有界公理(after) },
    Invariant("P5_展卷完整性") { _, _, _, after -> P5_展卷完整性公理(after) },
    Invariant("P6_睡眠香一致性") { _, _, _, after -> P6_睡眠香一致性公理(after) },
  )

internal fun retentionInvariants(): List<Invariant<RetentionState, RetentionContext, RetentionEvent>> =
  listOf(
    Invariant("I_DL_1_非已入箧零占用") { _, _, _, after ->
      if (after.state != RetentionState.D2_KEPT && after.occupiedSpace != 0L) {
        "${after.state} 仍占着 ${after.occupiedSpace}"
      } else {
        null
      }
    },
    Invariant("I_DL_2_未验明不入箧") { _, event, before, after ->
      if (after.state != RetentionState.D2_KEPT || before.state == RetentionState.D2_KEPT) {
        null
      } else {
        if (event is RetentionEvent.VerifiedComplete) null else "经 ${event.type} 进了已留存"
      }
    },
    Invariant("I_DL_3_失败必零占用") { _, event, before, after ->
      if (event is RetentionEvent.KeepFailed &&
        before.state == RetentionState.D1_KEEPING &&
        (after.state != RetentionState.D3_FAILED || after.occupiedSpace != 0L)
      ) {
        "留存受阻后状态 ${after.state} 占地 ${after.occupiedSpace}"
      } else {
        null
      }
    },
    Invariant("I_DL_4_释出即净") { _, event, _, after ->
      if (event is RetentionEvent.Release &&
        (after.state != RetentionState.D0_NOT_KEPT ||
          after.progressPct != 0 ||
          after.occupiedSpace != 0L ||
          after.failReason != null)
      ) {
        "释出后没有一步归零"
      } else {
        null
      }
    },
    Invariant("I_DL_5_进度有界") { _, _, _, after ->
      if (after.progressPct < 0 || after.progressPct > 100) "进度越界：${after.progressPct}" else null
    },
    Invariant("P3_非入箧零空间") { _, _, _, after -> P3_非入箧零空间公理(after) },
    Invariant("P4_留存进度有界") { _, _, _, after -> P4_播放头与留存进度有界公理(after) },
  )
