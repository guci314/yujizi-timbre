package voice.core.playback.pim

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.float
import kotlinx.serialization.json.floatOrNull
import kotlinx.serialization.json.int
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * 黄金对拍：直接读仓库根目录的 shared/golden-traces.json。
 *
 * 这份文件由 web/src/pim 生成，Web 端 Vitest 与这里各自回放一遍。任何一端
 * 私自改了业务规矩，另一端的格子就会对不上。
 */
class GoldenTracesTest {

  private val golden: JsonObject = loadGolden()
  private val books: Map<String, BookSpec> = parseBooks(golden)

  @Test
  fun gridsAreComplete() {
    assertEquals(32, LISTENING_CELL_COUNT)
    assertEquals(20, RETENTION_CELL_COUNT)
    assertEquals(8, LISTENING_EVENT_TYPES.size)
    assertEquals(5, RETENTION_EVENT_TYPES.size)

    assertTrue(LISTENING_GRID.missingCells().isEmpty(), "listening grid has holes: ${LISTENING_GRID.missingCells()}")
    assertTrue(RETENTION_GRID.missingCells().isEmpty(), "retention grid has holes: ${RETENTION_GRID.missingCells()}")
    LISTENING_GRID.assertComplete()
    RETENTION_GRID.assertComplete()
  }

  @Test
  fun goldenCoversEveryCell() {
    val listeningCovered = HashSet<String>()
    for (trace in listeningTraces()) {
      var ctx = initialListeningContext()
      for (step in trace.steps) {
        listeningCovered.add("${ctx.state}|${step.event.type}")
        ctx = LISTENING_GRID.step(ctx, step.event)
      }
    }
    assertEquals(32, listeningCovered.size, "listening coverage: $listeningCovered")

    val retentionCovered = HashSet<String>()
    for (trace in retentionTraces()) {
      var ctx = initialRetentionContext("ddj", 0)
      for (step in trace.steps) {
        retentionCovered.add("${ctx.state}|${step.event.type}")
        ctx = RETENTION_GRID.step(ctx, step.event)
      }
    }
    assertEquals(20, retentionCovered.size, "retention coverage: $retentionCovered")
  }

  @Test
  fun listeningTracesMatchGoldenSnapshots() {
    var steps = 0
    for (trace in listeningTraces()) {
      var ctx = initialListeningContext()
      for (step in trace.steps) {
        ctx = LISTENING_GRID.step(ctx, step.event)
        assertListeningSnapshot(step.expect, listeningSnapshot(ctx), "${trace.id} after ${step.event.type}")
        steps += 1
      }
    }
    assertTrue(steps >= 100, "expected a substantial trace corpus, got $steps steps")
  }

  @Test
  fun retentionTracesMatchGoldenSnapshots() {
    var steps = 0
    for (trace in retentionTraces()) {
      var ctx = initialRetentionContext("ddj", 0)
      for (step in trace.steps) {
        ctx = RETENTION_GRID.step(ctx, step.event)
        assertRetentionSnapshot(step.expect, retentionSnapshot(ctx), "${trace.id} after ${step.event.type}")
        steps += 1
      }
    }
    assertTrue(steps >= 40, "expected a substantial trace corpus, got $steps steps")
  }

  @Test
  fun listeningModelCheckHasNoViolations() {
    val report = LISTENING_GRID.modelCheck(
      initial = initialListeningContext(),
      events = listeningAlphabet(),
      keyOf = { ctx ->
        listOf(
          ctx.state,
          ctx.book?.id ?: "-",
          ctx.chapterIndex,
          ctx.positionSec,
          ctx.speed,
          ctx.sleepMode,
          ctx.sleepRemainingSec,
          ctx.book?.chapters?.getOrNull(ctx.chapterIndex)?.durationSec ?: 0,
        ).joinToString("|")
      },
      invariants = listeningInvariants(),
    )
    assertTrue(report.violations.isEmpty(), "violations: ${report.violations}")
    assertEquals(
      listOf("S0_IDLE", "S1_PAUSED", "S2_PLAYING", "S3_SLEEP_STOPPED"),
      report.reachableStates.map { it.name },
    )
  }

  @Test
  fun retentionModelCheckHasNoViolations() {
    val report = RETENTION_GRID.modelCheck(
      initial = initialRetentionContext("ddj", 0),
      events = retentionAlphabet(),
      keyOf = { ctx ->
        listOf(ctx.state, ctx.progressPct, ctx.occupiedSpace, ctx.failReason ?: "-").joinToString("|")
      },
      invariants = retentionInvariants(),
    )
    assertTrue(report.violations.isEmpty(), "violations: ${report.violations}")
    assertEquals(
      listOf("D0_NOT_KEPT", "D1_KEEPING", "D2_KEPT", "D3_FAILED"),
      report.reachableStates.map { it.name },
    )
  }

  // ---- 读黄金考卷 ----------------------------------------------------------

  private fun loadGolden(): JsonObject {
    val file = goldenFile()
    val text = file.readText()
    return Json.parseToJsonElement(text).jsonObject
  }

  private fun goldenFile(): File {
    var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
    while (dir != null) {
      val candidate = File(dir, "shared/golden-traces.json")
      if (candidate.isFile) return candidate
      dir = dir.parentFile
    }
    error("找不到 shared/golden-traces.json（从 ${System.getProperty("user.dir") ?: "."} 向上找）")
  }

  private fun parseBooks(root: JsonObject): Map<String, BookSpec> =
    root.getValue("books").jsonArray.associate { element ->
      val obj = element.jsonObject
      val id = obj.str("id")
      id to BookSpec(
        id = id,
        title = obj.str("title"),
        chapters = obj.getValue("chapters").jsonArray.map { chapter ->
          val c = chapter.jsonObject
          ChapterSpec(
            index = c.int("index"),
            title = c.str("title"),
            durationSec = c.int("durationSec"),
          )
        },
      )
    }

  private data class ListeningStep(val event: ListeningEvent, val expect: JsonObject)
  private data class ListeningTrace(val id: String, val steps: List<ListeningStep>)
  private data class RetentionStep(val event: RetentionEvent, val expect: JsonObject)
  private data class RetentionTrace(val id: String, val steps: List<RetentionStep>)

  private fun listeningTraces(): List<ListeningTrace> =
    golden.getValue("listening").jsonObject.getValue("traces").jsonArray.map { element ->
      val obj = element.jsonObject
      ListeningTrace(
        id = obj.str("id"),
        steps = obj.getValue("steps").jsonArray.map { step ->
          val stepObj = step.jsonObject
          ListeningStep(
            event = decodeListeningEvent(stepObj.getValue("event").jsonObject),
            expect = stepObj.getValue("expect").jsonObject,
          )
        },
      )
    }

  private fun retentionTraces(): List<RetentionTrace> =
    golden.getValue("retention").jsonObject.getValue("traces").jsonArray.map { element ->
      val obj = element.jsonObject
      RetentionTrace(
        id = obj.str("id"),
        steps = obj.getValue("steps").jsonArray.map { step ->
          val stepObj = step.jsonObject
          RetentionStep(
            event = decodeRetentionEvent(stepObj.getValue("event").jsonObject),
            expect = stepObj.getValue("expect").jsonObject,
          )
        },
      )
    }

  private fun decodeListeningEvent(obj: JsonObject): ListeningEvent =
    when (val type = obj.str("type")) {
      "E_OPEN_BOOK" -> ListeningEvent.OpenBook(
        book = books.getValue(obj.str("bookId")),
        savedChapter = obj.int("savedChapter"),
        savedSec = obj.int("savedSec"),
      )

      "E_JUMP_AND_PLAY" -> ListeningEvent.JumpAndPlay(
        book = books.getValue(obj.str("bookId")),
        chapterIndex = obj.int("chapterIndex"),
        startSec = obj.int("startSec"),
      )

      "E_TOGGLE_PLAY" -> ListeningEvent.TogglePlay
      "E_SEEK" -> ListeningEvent.Seek(
        targetSec = obj.int("targetSec"),
        chapterDurationSec = obj["chapterDurationSec"]?.jsonPrimitive?.intOrNull,
      )

      "E_NEXT_CHAPTER" -> ListeningEvent.NextChapter
      "E_PREV_CHAPTER" -> ListeningEvent.PrevChapter
      "E_SET_PREF" -> ListeningEvent.SetPref(
        speed = obj["speed"]?.jsonPrimitive?.floatOrNull,
        sleepChange = when {
          !obj.containsKey("sleepOption") -> null
          obj["sleepOption"] is JsonNull -> SleepChange.Off
          else -> {
            val option = obj.getValue("sleepOption").jsonObject
            val change = when (option.str("kind")) {
              "minutes" -> SleepOption.Minutes(option.int("minutes"))
              else -> SleepOption.EndOfChapter
            }
            SleepChange.Set(change)
          }
        },
      )

      "E_SECOND_ELAPSED" -> ListeningEvent.SecondElapsed(
        currentPositionSec = obj["currentPositionSec"]?.jsonPrimitive?.intOrNull,
        chapterDurationSec = obj["chapterDurationSec"]?.jsonPrimitive?.intOrNull,
      )

      else -> error("未知的听书事件：$type")
    }

  private fun decodeRetentionEvent(obj: JsonObject): RetentionEvent =
    when (val type = obj.str("type")) {
      "E_REQUEST_KEEP" -> RetentionEvent.RequestKeep
      "E_KEEP_PROGRESS" -> RetentionEvent.KeepProgress(obj.int("pct"))
      "E_VERIFIED_COMPLETE" -> RetentionEvent.VerifiedComplete(obj.getValue("space").jsonPrimitive.long)
      "E_KEEP_FAILED" -> RetentionEvent.KeepFailed(
        when (obj.str("reason")) {
          "SPACE_FULL" -> KeepFailReason.SPACE_FULL
          "CONTENT_CORRUPTED" -> KeepFailReason.CONTENT_CORRUPTED
          else -> KeepFailReason.SOURCE_UNREACHABLE
        },
      )

      "E_RELEASE" -> RetentionEvent.Release
      else -> error("未知的留存事件：$type")
    }

  // ---- 快照比对 ------------------------------------------------------------

  private fun assertListeningSnapshot(expect: JsonObject, actual: ListeningSnapshot, where: String) {
    assertEquals(expect.str("state"), actual.state, "$where: state")
    assertEquals(expect.strOrNull("bookId"), actual.bookId, "$where: bookId")
    assertEquals(expect.int("chapterIndex"), actual.chapterIndex, "$where: chapterIndex")
    assertEquals(expect.int("positionSec"), actual.positionSec, "$where: positionSec")
    assertEquals(expect.float("speed"), actual.speed, 0.0001f, "$where: speed")
    assertEquals(expect.str("sleepMode"), actual.sleepMode, "$where: sleepMode")
    assertEquals(expect.int("sleepRemainingSec"), actual.sleepRemainingSec, "$where: sleepRemainingSec")
    assertEquals(expect.int("chapterDurationSec"), actual.chapterDurationSec, "$where: chapterDurationSec")
  }

  private fun assertRetentionSnapshot(expect: JsonObject, actual: RetentionSnapshot, where: String) {
    assertEquals(expect.str("state"), actual.state, "$where: state")
    assertEquals(expect.str("bookId"), actual.bookId, "$where: bookId")
    assertEquals(expect.int("chapterIndex"), actual.chapterIndex, "$where: chapterIndex")
    assertEquals(expect.int("progressPct"), actual.progressPct, "$where: progressPct")
    assertEquals(expect.getValue("occupiedSpace").jsonPrimitive.long, actual.occupiedSpace, "$where: occupiedSpace")
    assertEquals(expect.strOrNull("failReason"), actual.failReason, "$where: failReason")
  }

  // ---- BFS 字母表与不变量 ----------------------------------------------------

  private fun listeningAlphabet(): List<ListeningEvent> {
    val ddj = books.getValue("ddj")
    val zz = books.getValue("zz")
    return listOf(
      ListeningEvent.OpenBook(zz, 1, 7),
      ListeningEvent.JumpAndPlay(ddj, 2, 50),
      ListeningEvent.TogglePlay,
      ListeningEvent.Seek(10),
      ListeningEvent.Seek(999),
      ListeningEvent.NextChapter,
      ListeningEvent.PrevChapter,
      ListeningEvent.SetPref(speed = 1.5f),
      ListeningEvent.SetPref(sleepChange = SleepChange.Set(SleepOption.Minutes(3))),
      ListeningEvent.SetPref(sleepChange = SleepChange.Set(SleepOption.EndOfChapter)),
      ListeningEvent.SetPref(sleepChange = SleepChange.Off),
      ListeningEvent.SecondElapsed(50, 100),
      ListeningEvent.SecondElapsed(99, 100),
      ListeningEvent.SecondElapsed(100, 100),
      ListeningEvent.SecondElapsed(null, 100),
    )
  }

  private fun listeningInvariants(): List<Invariant<ListeningState, ListeningContext, ListeningEvent>> = listOf(
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
  )

  private fun retentionAlphabet(): List<RetentionEvent> = listOf(
    RetentionEvent.RequestKeep,
    RetentionEvent.KeepProgress(55),
    RetentionEvent.KeepProgress(500),
    RetentionEvent.VerifiedComplete(4096),
    RetentionEvent.VerifiedComplete(0),
    RetentionEvent.KeepFailed(KeepFailReason.SPACE_FULL),
    RetentionEvent.KeepFailed(KeepFailReason.CONTENT_CORRUPTED),
    RetentionEvent.Release,
  )

  private fun retentionInvariants(): List<Invariant<RetentionState, RetentionContext, RetentionEvent>> = listOf(
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
  )
}

private fun JsonObject.str(key: String): String = getValue(key).jsonPrimitive.content

private fun JsonObject.strOrNull(key: String): String? {
  val element = this[key] ?: return null
  return if (element is JsonNull) null else element.jsonPrimitive.content
}

private fun JsonObject.int(key: String): Int = getValue(key).jsonPrimitive.int

private fun JsonObject.float(key: String): Float = getValue(key).jsonPrimitive.float
