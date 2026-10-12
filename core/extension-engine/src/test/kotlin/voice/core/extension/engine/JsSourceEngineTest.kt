package voice.core.extension.engine

import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

class JsSourceEngineTest {

  private lateinit var server: MockWebServer

  @BeforeTest
  fun setUp() {
    server = MockWebServer()
    server.start()
  }

  @AfterTest
  fun tearDown() {
    server.close()
  }

  private fun http(): SandboxHttp = OkHttpSandboxHttp(okhttp3.OkHttpClient())

  @Test
  fun fullSearchChaptersAudioFlow() = runTest {
    val host = server.url("/").toString().removeSuffix("/")
    val script = """
      ;(() => {
        registerSource({
          id: 'demo',
          async search(params) {
            const resp = await http.get('$host/search', {
              params: { key: params.keyword, page: params.page },
              headers: { 'x-demo': 'yes' },
            });
            const data = JSON.parse(resp.body);
            return data.list.map((item) => ({
              id: String(item.id),
              bookTitle: item.name,
              bookAnchor: item.author,
              count: item.tracks,
              customField: 'keep-me',
            }));
          },
          async chapters(params) {
            const resp = await http.get('$host/chapters?id=' + params.bookId);
            const data = JSON.parse(resp.body);
            return data.map((item, idx) => ({
              chapter_id: String(item.id),
              title: item.name,
              order: idx + 1,
              albumId: params.bookId,
            }));
          },
          async audio(params) {
            const resp = await http.post('$host/audio', {
              json: { bookID: params.bookId, chapterID: params.chapterId, tag: params.albumId },
            });
            const data = JSON.parse(resp.body);
            return data.url;
          },
        });
      })()
    """.trimIndent()
    val engine = JsSourceEngine.create("demo", script, "demo.js", http())

    server.enqueue(MockResponse.Builder().body("""{"list":[{"id":7,"name":"斗罗大陆","author":"唐三","tracks":323}]}""").build())
    val search = SourceContract.parseSearchResults(engine.invoke("search", """{"keyword":"斗罗","page":1}""", 15_000))
    assertEquals(1, search.size)
    assertEquals("7", search[0].id)
    assertEquals("斗罗大陆", search[0].title)
    assertEquals("唐三", search[0].author)
    assertEquals(323, search[0].trackCount)
    assertEquals("keep-me", search[0].extra["customField"]?.toString()?.removeSurrounding("\""))
    val searchRequest = server.takeRequest()
    assertEquals(
      "/search?key=%E6%96%97%E7%BD%97&page=1",
      searchRequest.url.encodedQuery.let { "/search?$it" }.substringBefore("?") + "?" + searchRequest.url.encodedQuery,
    )
    assertEquals("yes", searchRequest.headers["x-demo"])

    server.enqueue(MockResponse.Builder().body("""[{"id":1,"name":"第一集"},{"id":2,"name":"第二集"}]""").build())
    val chapters = SourceContract.parseChapters(engine.invoke("chapters", """{"bookId":"7"}""", 15_000))
    assertEquals(2, chapters.size)
    assertEquals("第一集", chapters[0].title)
    assertEquals(1, chapters[0].order)
    assertEquals("7", chapters[0].extra["albumId"]?.toString()?.removeSurrounding("\""))

    server.enqueue(MockResponse.Builder().body("""{"url":"https://audio.example.com/1.mp3"}""").build())
    val audioJson = engine.invoke("audio", """{"bookId":"7","chapterId":"1","albumId":"7"}""", 15_000)
    assertEquals("https://audio.example.com/1.mp3", SourceContract.parseAudio(audioJson).url)
    assertEquals("GET", server.takeRequest().method) // the chapters request
    val audioRequest = server.takeRequest()
    assertEquals("POST", audioRequest.method)
    assertTrue(audioRequest.body!!.utf8().contains(""""tag":"7""""))

    engine.close()
  }

  @Test
  fun cryptoHelpersWorkFromJs() = runTest {
    val script = """
      ;(() => {
        registerSource({
          id: 'crypto',
          async search() {
            const cipher = aesEcbEncryptB64('hello world', '0123456789abcdef');
            const round = bytesToUtf8(hexToBytes(bytesToHex(aesEcbDecrypt(base64Decode(cipher), '0123456789abcdef'))));
            return [{ id: '1', bookTitle: round, heat: md5Hex('abc'), key: sha256Hex('abc').slice(0, 8) }];
          },
        });
      })()
    """.trimIndent()
    val engine = JsSourceEngine.create("crypto", script, "crypto.js", http())
    val items = SourceContract.parseSearchResults(engine.invoke("search", "{}", 15_000))
    assertEquals("hello world", items[0].title)
    assertEquals("900150983cd24fb0d6963f7d28e17f72", items[0].extra["heat"]?.toString()?.removeSurrounding("\""))
    engine.close()
  }

  @Test
  fun rejectsMissingRegistration() = runTest {
    assertFailsWith<SourceContractException> {
      JsSourceEngine.create("demo", "var x = 1;", "nope.js", http())
    }
  }

  @Test
  fun rejectsIdMismatch() = runTest {
    val script = "registerSource({ id: 'other', async search() { return [] } });"
    val e = assertFailsWith<SourceContractException> {
      JsSourceEngine.create("demo", script, "mismatch.js", http())
    }
    assertTrue(e.message!!.contains("id"), e.message)
  }

  @Test
  fun scriptErrorsCarryTheMessage() = runTest {
    val script = """
      registerSource({
        id: 'failing',
        async search() { throw new Error('源站限流了'); },
      });
    """.trimIndent()
    val engine = JsSourceEngine.create("failing", script, "failing.js", http())
    val e = assertFailsWith<Exception> {
      engine.invoke("search", "{}", 15_000)
    }
    assertTrue((e.message ?: "").contains("源站限流了"), e.message)
    engine.close()
  }

  @Test
  fun missingStageIsReported() = runTest {
    val script = "registerSource({ id: 'half', async search() { return [] } });"
    val engine = JsSourceEngine.create("half", script, "half.js", http())
    val e = assertFailsWith<Exception> {
      engine.invoke("audio", "{}", 15_000)
    }
    assertTrue((e.message ?: "").contains("audio"), e.message)
    engine.close()
  }

  @Test
  fun contractViolationsAreClear() = runTest {
    val script = "registerSource({ id: 'bad', async search() { return [{ nope: 1 }] } });"
    val engine = JsSourceEngine.create("bad", script, "bad.js", http())
    val results = engine.invoke("search", "{}", 15_000)
    val e = assertFailsWith<SourceContractException> {
      SourceContract.parseSearchResults(results)
    }
    assertTrue(e.message!!.contains("id"), e.message)
    engine.close()
  }
}
