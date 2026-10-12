package voice.core.extension

import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import voice.core.extension.engine.JsSourceEngine
import voice.core.online.OnlineSourceInfo
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ExtensionSourceBackendTest {

  private val manifest = voice.core.extension.engine.ExtensionManifest(
    id = "com.test.demo",
    name = "演示包",
    version = "1.0.0",
    sources = listOf(
      voice.core.extension.engine.ExtensionSourceMeta(id = "demo", name = "演示源", script = "demo.js"),
    ),
  )

  private val pkg = InstalledExtensionPackage(manifest, installedAtMillis = 42L)

  private class RecordedEngine(val responses: Map<String, String>) {
    val paramsByStage = HashMap<String, String>()

    fun engine(): JsSourceEngine {
      val engine = mockk<JsSourceEngine>()
      coEvery { engine.invoke(any(), any(), any()) } coAnswers {
        val stage = firstArg<String>()
        paramsByStage[stage] = secondArg()
        responses.getValue(stage)
      }
      return engine
    }
  }

  private fun backendWith(
    responses: Map<String, String>,
    recorded: RecordedEngine,
  ): ExtensionSourceBackend {
    val engineProvider = mockk<ExtensionEngineProvider>()
    coEvery { engineProvider.useEngine<Any>(any(), any()) } coAnswers {
      secondArg<suspend (JsSourceEngine) -> Any>().invoke(recorded.engine())
    }
    val manager = mockk<ExtensionManager>()
    coEvery { manager.installed() } returns listOf(pkg)
    coEvery { manager.packageFor(any()) } returns pkg
    return ExtensionSourceBackend(engineProvider, manager)
  }

  @Test
  fun handlesOnlyJdrSources() {
    val backend = backendWith(emptyMap(), RecordedEngine(emptyMap()))
    assertTrue(backend.handles("jdr:demo"))
    assertFalse(backend.handles("A"))
    assertFalse(backend.handles("server:B"))
  }

  @Test
  fun sourceChipsArePrefixed() = runTest {
    val backend = backendWith(emptyMap(), RecordedEngine(emptyMap()))
    assertEquals(true, backend.hasEnabledSources())
    val infos = backend.enabledSourceInfos()
    assertEquals(listOf(OnlineSourceInfo(name = "jdr:demo", displayName = "演示源", enabled = true)), infos)
  }

  @Test
  fun searchMapsStandardFields() = runTest {
    val recorded = RecordedEngine(
      mapOf(
        "search" to
          """[{"id":"7","bookTitle":"斗罗大陆","bookAnchor":"唐三","bookImage":"http://c/7.jpg",
              "bookDesc":"简介","count":323,"albumId":"7","custom":"keep"}]""",
      ),
    )
    val backend = backendWith(recorded.responses, recorded)
    val results = backend.search("jdr:demo", "斗罗")
    assertEquals(1, results.size)
    val result = results.single()
    assertEquals("jdr:demo", result.source)
    assertEquals("7", result.bookId)
    assertEquals("斗罗大陆", result.title)
    assertEquals("唐三", result.author)
    assertEquals(323, result.trackCount)
    assertTrue(recorded.paramsByStage.getValue("search").contains(""""keyword":"斗罗""""))
  }

  @Test
  fun chaptersAndAudioCarryForwardedFields() = runTest {
    val recorded = RecordedEngine(
      mapOf(
        "search" to """[{"id":"7","bookTitle":"斗罗大陆","albumId":"AL-7"}]""",
        "chapters" to """[{"chapter_id":"10","title":"第一章","order":1,"albumId":"AL-7"}]""",
        "audio" to """"https://cdn.example.com/10.mp3"""",
      ),
    )
    val backend = backendWith(recorded.responses, recorded)
    val searchResults = backend.search("jdr:demo", "斗罗")
    assertEquals(1, searchResults.size)
    val chapterList = backend.chapters("jdr:demo", "7")
    assertEquals(1, chapterList.size)
    val stream = backend.resolveDirectUrl("jdr:demo", "7", "10")

    assertEquals("https://cdn.example.com/10.mp3", stream?.url)
    val chaptersParams = recorded.paramsByStage.getValue("chapters")
    assertTrue(chaptersParams.contains("AL-7"), chaptersParams)
    assertTrue(chaptersParams.contains(""""bookId":"7""""))
    val audioParams = recorded.paramsByStage.getValue("audio")
    assertTrue(audioParams.contains("AL-7"), audioParams)
    assertTrue(audioParams.contains(""""chapterId":"10""""))
    assertTrue(audioParams.contains(""""order":1"""), audioParams)
  }

  @Test
  fun missingSearchTitleFailsTheContract() = runTest {
    val recorded = RecordedEngine(mapOf("search" to """[{"id":"7"}]"""))
    val backend = backendWith(recorded.responses, recorded)
    val e = runCatching { backend.search("jdr:demo", "kw") }.exceptionOrNull()
    assertTrue(e is voice.core.extension.engine.SourceContractException, e?.toString())
  }
}
