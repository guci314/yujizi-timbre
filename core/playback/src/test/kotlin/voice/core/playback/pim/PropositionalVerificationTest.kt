package voice.core.playback.pim

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * 命题性知识「三招验证法」：
 * ① 拿真货装框 —— 用真实站点的 172 首曲目与 2 本纯文字书喂给公理；
 * ② 塞假币验钞 —— 每条公理、每条迁移不变量都必须能被假快照证伪；
 * ③ 摆正常画面 —— 五个典型业务画面下所有公理同时成立。
 */
class PropositionalVerificationTest {

  private val root: File = repoRoot()
  private val integrity: Map<String, Long> = loadIntegrity()

  // ---- 第 1 招：拿真货装框 ------------------------------------------------

  @Test
  fun realCatalogueSatisfiesEveryProposition() {
    val albums = realAlbums()
    assertEquals(172, albums.sumOf { it.kept.size })

    val books = albums.map { it.spec }
    val kept = albums.flatMap { it.kept }

    // P1：172 首全部入箧后，每一卷都必须在书箧里可见，且没有多余卷。
    assertNull(P1_书箧可见充要条件(books, kept))
    assertEquals(
      books.map { it.id }.toSet(),
      bookcaseBooks(books, kept).map { it.id }.toSet(),
    )

    for (album in albums) {
      // P3 / P4：真实字节数必须落在「已入箧 > 0」与 0..100 的两条界内。
      album.kept.forEach { retention ->
        assertTrue(verifyRetentionPropositions(retention).isEmpty(), retention.toString())
      }

      // P2：在线恒可诵读；离线时只有已入箧的那几篇可诵读。
      for (chapter in album.spec.chapters) {
        assertNull(
          P2_篇章可诵读充要条件(
            online = true,
            bookId = album.spec.id,
            chapterIndex = chapter.index,
            kept = kept,
            playable = true,
          ),
        )
        val offline = isChapterAvailable(album.spec.id, chapter.index, kept)
        assertNull(
          P2_篇章可诵读充要条件(
            online = false,
            bookId = album.spec.id,
            chapterIndex = chapter.index,
            kept = kept,
            playable = offline,
          ),
        )
      }

      // P4 / P5 / P6：拿真实卷与真实时长构造一个诵读中的快照。
      val playing = ListeningContext(
        state = ListeningState.S2_PLAYING,
        book = album.spec,
        chapterIndex = 0,
        positionSec = 0,
        speed = 1f,
        sleepMode = SleepMode.OFF,
        sleepRemainingSec = 0,
      )
      assertTrue(verifyListeningPropositions(playing).isEmpty(), playing.toString())
    }
  }

  @Test
  fun zeroChapterTranscriptsNeverReachTheStage() {
    val transcripts = listOf("玉师聊阴符经", "玉师聊修行").map { title ->
      BookSpec(id = title, title = title, chapters = emptyList())
    }
    val initial = initialListeningContext()

    for (transcript in transcripts) {
      // 展卷与点播都必须被网格拒绝，停在未展卷。
      assertEquals(
        initial,
        LISTENING_GRID.step(initial, ListeningEvent.OpenBook(transcript, 0, 0)),
      )
      assertEquals(
        initial,
        LISTENING_GRID.step(initial, ListeningEvent.JumpAndPlay(transcript, 0, 10)),
      )
      assertNull(initial.book)
      assertTrue(verifyListeningPropositions(initial).isEmpty())
    }
  }

  // ---- 第 2 招：塞假币验钞 ------------------------------------------------

  @Test
  fun everyAxiomRejectsACounterfeit() {
    val book = spec("a", 2)
    val kept = listOf(kept("a", 0, space = 1_000))

    // P1：已入箧却不在可见列表 / 未入箧却出现在可见列表。
    assertNotNull(P1_书箧可见充要条件(listOf(book), kept, visible = emptyList()))
    assertNotNull(P1_书箧可见充要条件(listOf(book), emptyList(), visible = listOf(book)))

    // P2：离线未入箧却声称可诵读；在线却声称不可诵读。
    assertNotNull(P2_篇章可诵读充要条件(false, "a", 0, emptyList(), playable = true))
    assertNotNull(P2_篇章可诵读充要条件(true, "a", 0, emptyList(), playable = false))

    // P3：已入箧却零空间；未入箧却占着空间。
    assertNotNull(P3_非入箧零空间公理(kept("a", 0, space = 0)))
    assertNotNull(P3_非入箧零空间公理(initialRetentionContext("a", 0).copy(occupiedSpace = 5)))

    // P4：播放头为负 / 超出章长；留存进度越界。
    assertNotNull(P4_播放头与留存进度有界公理(listening(positionSec = -1)))
    assertNotNull(P4_播放头与留存进度有界公理(listening(positionSec = 101)))
    assertNotNull(P4_播放头与留存进度有界公理(kept("a", 0, pct = 101)))

    // P5：已展卷无书 / 未展卷带书 / 章号越界 / 有书无篇。
    assertNotNull(P5_展卷完整性公理(listening(ListeningState.S2_PLAYING, book = null)))
    assertNotNull(P5_展卷完整性公理(listening(ListeningState.S0_IDLE, book = book)))
    assertNotNull(
      P5_展卷完整性公理(listening(ListeningState.S2_PLAYING, book = book, chapterIndex = 5)),
    )
    assertNotNull(
      P5_展卷完整性公理(listening(ListeningState.S2_PLAYING, book = spec("empty", 0))),
    )

    // P6：熄火却仍有倒计时；止息却点着分钟香。
    assertNotNull(
      P6_睡眠香一致性公理(listening(sleepMode = SleepMode.OFF, sleepRemainingSec = 60)),
    )
    assertNotNull(
      P6_睡眠香一致性公理(
        listening(ListeningState.S3_SLEEP_STOPPED, sleepMode = SleepMode.MINUTES, sleepRemainingSec = 60),
      ),
    )
  }

  @Test
  fun everyTransitionInvariantRejectsACounterfeit() {
    val listeningById = listeningInvariants().associateBy { it.id }
    val a = spec("a", 2)
    val b = spec("b", 2)
    val playingA = listening(ListeningState.S2_PLAYING, book = a, positionSec = 10)
    val pausedA = listening(ListeningState.S1_PAUSED, book = a, positionSec = 10)

    assertNotNull(
      listeningById.getValue("I2_展卷不打扰").check(
        ListeningState.S2_PLAYING,
        ListeningEvent.OpenBook(b, 0, 0),
        playingA,
        listening(ListeningState.S1_PAUSED, book = b),
      ),
    )
    assertNotNull(
      listeningById.getValue("I3_静置与止息不流逝").check(
        ListeningState.S1_PAUSED,
        ListeningEvent.SecondElapsed(11, 100),
        pausedA,
        pausedA.copy(positionSec = 11),
      ),
    )
    assertNotNull(
      listeningById.getValue("I4_倒计时只在诵读中消减").check(
        ListeningState.S1_PAUSED,
        ListeningEvent.SecondElapsed(10, 100),
        pausedA.copy(sleepMode = SleepMode.MINUTES, sleepRemainingSec = 60),
        pausedA.copy(sleepMode = SleepMode.MINUTES, sleepRemainingSec = 59),
      ),
    )
    assertNotNull(
      listeningById.getValue("I5_止息不诈尸").check(
        ListeningState.S3_SLEEP_STOPPED,
        ListeningEvent.SecondElapsed(10, 100),
        listening(ListeningState.S3_SLEEP_STOPPED, book = a),
        listening(ListeningState.S2_PLAYING, book = a),
      ),
    )
    assertNotNull(
      listeningById.getValue("I6_位置不为负").check(
        ListeningState.S2_PLAYING,
        ListeningEvent.Seek(0),
        playingA,
        playingA.copy(positionSec = -1),
      ),
    )

    val retentionById = retentionInvariants().associateBy { it.id }
    val keeping = initialRetentionContext("a", 0).copy(state = RetentionState.D1_KEEPING, progressPct = 40)

    assertNotNull(
      retentionById.getValue("I_DL_1_非已入箧零占用").check(
        RetentionState.D1_KEEPING,
        RetentionEvent.KeepProgress(40),
        keeping,
        keeping.copy(occupiedSpace = 100),
      ),
    )
    assertNotNull(
      retentionById.getValue("I_DL_2_未验明不入箧").check(
        RetentionState.D1_KEEPING,
        RetentionEvent.KeepProgress(100),
        keeping,
        keeping.copy(state = RetentionState.D2_KEPT, occupiedSpace = 100),
      ),
    )
    assertNotNull(
      retentionById.getValue("I_DL_3_失败必零占用").check(
        RetentionState.D1_KEEPING,
        RetentionEvent.KeepFailed(KeepFailReason.SPACE_FULL),
        keeping,
        keeping.copy(state = RetentionState.D3_FAILED, occupiedSpace = 9),
      ),
    )
    assertNotNull(
      retentionById.getValue("I_DL_4_释出即净").check(
        RetentionState.D1_KEEPING,
        RetentionEvent.Release,
        keeping,
        keeping.copy(progressPct = 50),
      ),
    )
    assertNotNull(
      retentionById.getValue("I_DL_5_进度有界").check(
        RetentionState.D1_KEEPING,
        RetentionEvent.KeepProgress(50),
        keeping,
        keeping.copy(progressPct = 101),
      ),
    )
  }

  // ---- 第 3 招：摆正常画面防打架 ------------------------------------------

  @Test
  fun fiveTypicalScenesSatisfyEveryPropositionTogether() {
    val tenChapters = spec("ddj", 10, durationSec = 600)
    val keptFirstChapter = listOf(kept("ddj", 0, space = 2_166_849))

    // ① 初装未展卷：没有任何书，也没有任何留存。
    val fresh = initialListeningContext()
    assertTrue(verifyListeningPropositions(fresh).isEmpty())
    assertNull(P1_书箧可见充要条件(emptyList(), emptyList()))
    assertNull(P2_篇章可诵读充要条件(false, "ddj", 0, emptyList(), playable = false))

    // ② 在线诵读中，开了 15 分钟睡眠香。
    val onlinePlaying = ListeningContext(
      state = ListeningState.S2_PLAYING,
      book = tenChapters,
      chapterIndex = 3,
      positionSec = 45,
      speed = 1f,
      sleepMode = SleepMode.MINUTES,
      sleepRemainingSec = 15 * 60,
    )
    assertTrue(verifyListeningPropositions(onlinePlaying).isEmpty(), onlinePlaying.toString())
    assertNull(P2_篇章可诵读充要条件(true, "ddj", 7, emptyList(), playable = true))

    // ③ 整本书 10 章只留存了第 1 章，断网展卷。
    val offlinePaused = ListeningContext(
      state = ListeningState.S1_PAUSED,
      book = tenChapters,
      chapterIndex = 0,
      positionSec = 0,
      speed = 1f,
      sleepMode = SleepMode.OFF,
      sleepRemainingSec = 0,
    )
    assertTrue(verifyListeningPropositions(offlinePaused).isEmpty())
    assertNull(P1_书箧可见充要条件(listOf(tenChapters), keptFirstChapter))
    assertNull(P2_篇章可诵读充要条件(false, "ddj", 0, keptFirstChapter, playable = true))
    assertNull(P2_篇章可诵读充要条件(false, "ddj", 1, keptFirstChapter, playable = false))

    // ④ 睡眠香到点止息。
    val slept = ListeningContext(
      state = ListeningState.S3_SLEEP_STOPPED,
      book = tenChapters,
      chapterIndex = 3,
      positionSec = 120,
      speed = 1f,
      sleepMode = SleepMode.OFF,
      sleepRemainingSec = 0,
    )
    assertTrue(verifyListeningPropositions(slept).isEmpty(), slept.toString())

    // ⑤ 书箧空间已满，留存未果。
    val spaceFull = initialRetentionContext("ddj", 5).copy(
      state = RetentionState.D3_FAILED,
      progressPct = 0,
      occupiedSpace = 0,
      failReason = KeepFailReason.SPACE_FULL,
    )
    assertTrue(verifyRetentionPropositions(spaceFull).isEmpty(), spaceFull.toString())
    assertNull(P1_书箧可见充要条件(listOf(tenChapters), listOf(spaceFull)))
  }

  // ---- 真实数据 -----------------------------------------------------------

  private data class RealAlbum(val spec: BookSpec, val kept: List<RetentionContext>)

  private fun realAlbums(): List<RealAlbum> {
    val byAlbum = integrity.entries.groupBy { it.key.substringBefore('/') }
    return byAlbum.map { (albumId, entries) ->
      val indexed = entries.associate { entry ->
        entry.key.substringAfter('/').toInt() to entry.value
      }
      val chapters = (0..indexed.keys.max()).map { index ->
        ChapterSpec(index = index, title = "", durationSec = 0)
      }
      RealAlbum(
        spec = BookSpec(id = albumId, title = albumId, chapters = chapters),
        kept = indexed.map { (index, size) -> kept(albumId, index, space = size) },
      )
    }
  }

  private fun loadIntegrity(): Map<String, Long> {
    val file = File(root, "app/src/main/assets/yujizi_integrity.json")
    assertTrue(file.isFile, "找不到 ${file.path}")
    val files = Json.parseToJsonElement(file.readText()).jsonObject.getValue("files").jsonObject
    return files.mapValues { (_, value) -> value.jsonObject.getValue("size").jsonPrimitive.long }
  }

  private fun repoRoot(): File {
    var dir: File? = File(System.getProperty("user.dir") ?: ".").absoluteFile
    while (dir != null) {
      if (File(dir, "shared/golden-traces.json").isFile) return dir
      dir = dir.parentFile
    }
    error("找不到仓库根目录（从 ${System.getProperty("user.dir")} 向上找）")
  }

  private fun spec(id: String, chapters: Int, durationSec: Int = 100): BookSpec = BookSpec(
    id = id,
    title = id,
    chapters = (0 until chapters).map { index ->
      ChapterSpec(index = index, title = "第${index + 1}篇", durationSec = durationSec)
    },
  )

  private fun kept(
    bookId: String,
    chapterIndex: Int,
    space: Long = 1_000,
    pct: Int = 100,
  ): RetentionContext = RetentionContext(
    bookId = bookId,
    chapterIndex = chapterIndex,
    state = RetentionState.D2_KEPT,
    progressPct = pct,
    occupiedSpace = space,
    failReason = null,
  )

  private fun listening(
    state: ListeningState = ListeningState.S2_PLAYING,
    book: BookSpec? = spec("a", 2),
    chapterIndex: Int = 0,
    positionSec: Int = 0,
    sleepMode: SleepMode = SleepMode.OFF,
    sleepRemainingSec: Int = 0,
  ): ListeningContext = ListeningContext(
    state = state,
    book = book,
    chapterIndex = chapterIndex,
    positionSec = positionSec,
    speed = 1f,
    sleepMode = sleepMode,
    sleepRemainingSec = sleepRemainingSec,
  )
}
