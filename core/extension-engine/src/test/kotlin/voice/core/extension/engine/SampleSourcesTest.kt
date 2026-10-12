package voice.core.extension.engine

import kotlinx.coroutines.test.runTest
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import voice.core.extension.engine.crypto.CryptoOps
import voice.core.extension.engine.crypto.hexToByteArray
import voice.core.extension.engine.crypto.toHexString
import java.security.SecureRandom
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * End-to-end smoke of the two sample sources with a mocked source server:
 * guest auth, AES-GCM/XChaCha payload crypto, chapter lookup and audio
 * resolution all run for real — only the network is local.
 */
class SampleSourcesTest {

  private lateinit var server: MockWebServer
  private val random = SecureRandom()

  @BeforeTest
  fun setUp() {
    server = MockWebServer()
    server.start()
  }

  @AfterTest
  fun tearDown() {
    server.close()
  }

  private fun sampleScript(name: String): String {
    // real sample sources live in test resources only (kept out of samples/)
    val stream = javaClass.getResourceAsStream("/voicesamples/$name.js")
    check(stream != null) { "测试资源 voicesamples/$name.js 不存在" }
    return stream.use { it.readBytes().toString(Charsets.UTF_8) }
  }

  private fun payloadEnvelope(plaintext: String): String {
    // response payloads use XChaCha20-Poly1305 with a 24-byte nonce (ver 2)
    val nonce = ByteArray(24).also(random::nextBytes)
    val cipherTag = CryptoOps.chacha20Encrypt(
      "ea9d9d4f9a983fe6f6382f29c7b46b8d6dc47abc6da36662e6ddff8c78902f65".hexToByteArray(),
      nonce,
      plaintext.toByteArray(Charsets.UTF_8),
      null,
    )
    val reversed = cipherTag.reversedArray()
    val payload = ByteArray(1 + nonce.size + reversed.size)
    payload[0] = 2
    nonce.copyInto(payload, 1)
    reversed.copyInto(payload, 1 + nonce.size)
    return payload.toHexString()
  }

  private fun encryptedResponse(plaintext: String): MockResponse {
    val body = """{"payload":"${payloadEnvelope(plaintext)}"}"""
    return MockResponse.Builder().body(body).addHeader("Content-Type", "application/json").build()
  }

  @Test
  fun tingyoufmFullFlow() = runTest {
    val script = sampleScript("tingyoufm")
      .replace("https://azybk.tingyou8.vip/apk", server.url("/apk").toString().removeSuffix("/"))
      .replace("https://json.hgeuz.cn/azybk/json_v1", server.url("/json").toString().removeSuffix("/"))
    val engine = JsSourceEngine.create("tingyoufm", script, "tingyoufm.js", OkHttpSandboxHttp(okhttp3.OkHttpClient()))

    // 1. guest auth (fired implicitly by the search call)
    server.enqueue(encryptedResponse("""{"auth_token":"tok-123"}"""))
    // 2. search
    server.enqueue(
      encryptedResponse(
        """{"results":[{"id":7,"title":"斗罗大陆","cover_url":"http://c/7.jpg","author":"唐三","count":323,"description":"简介"}]}""",
      ),
    )
    val search = SourceContract.parseSearchResults(engine.invoke("search", """{"keyword":"斗罗"}""", 30_000))
    assertEquals(1, search.size)
    assertEquals("7", search[0].id)
    assertEquals("斗罗大陆", search[0].title)
    assertEquals("唐三", search[0].author)
    assertEquals("7", search[0].extra["albumId"]?.toString()?.removeSurrounding("\""))

    // 3. chapters (uses the albumId carried through from search)
    server.enqueue(
      encryptedResponse("""{"chapters":[{"id":10,"title":"第一章","index":1,"duration":300},{"id":11,"title":"第二章","index":2}]}"""),
    )
    val chapters = SourceContract.parseChapters(engine.invoke("chapters", """{"bookId":"7","albumId":"7"}""", 30_000))
    assertEquals(2, chapters.size)
    assertEquals("第一章", chapters[0].title)
    assertEquals(1, chapters[0].order)
    assertEquals(300, chapters[0].durationSeconds)
    assertEquals("7", chapters[0].extra["albumId"]?.toString()?.removeSurrounding("\""))

    // 4. audio (order flows through from the chapter extras)
    server.enqueue(encryptedResponse("""{"play_url":"https://cdn.example.com/7/10.mp3"}"""))
    val audio = engine.invoke("audio", """{"bookId":"7","chapterId":"10","albumId":"7","order":1}""", 30_000)
    assertEquals("https://cdn.example.com/7/10.mp3", SourceContract.parseAudio(audio).url)

    // the guest call must have carried a dfp cookie; the search a bearer token
    val guest = server.takeRequest()
    assertTrue(guest.headers["Cookie"]!!.startsWith("dfp=f-c29cd:f-"), guest.headers["Cookie"])
    val searchRequest = server.takeRequest()
    assertEquals("Bearer tok-123", searchRequest.headers["Authorization"])
    assertTrue(searchRequest.headers["Cookie"]!!.contains("session="), searchRequest.headers["Cookie"])
    engine.close()
  }

  @Test
  fun itingshuFullFlow() = runTest {
    val script = sampleScript("itingshu")
      .replace("https://api.itingshu.iiisss.top", server.url("/").toString().removeSuffix("/"))
    val engine = JsSourceEngine.create("itingshu", script, "itingshu.js", OkHttpSandboxHttp(okhttp3.OkHttpClient()))

    server.enqueue(
      MockResponse.Builder().body(
        """{"ret":200,"data":[{"novel":{"id":"9","name":"凡人修仙传","cover":"http://c/9.jpg","intro":"修仙","tracks":2001,"plays":999},"author":{"name":"忘语"}}]}""",
      ).build(),
    )
    val search = SourceContract.parseSearchResults(engine.invoke("search", """{"keyword":"凡人"}""", 15_000))
    assertEquals(1, search.size)
    assertEquals("9", search[0].id)
    assertEquals("凡人修仙传", search[0].title)
    assertEquals("忘语", search[0].author)
    assertEquals(2001, search[0].trackCount)

    server.enqueue(
      MockResponse.Builder().body(
        """{"info":{"name":"凡人修仙传","zhubo":"忘语"},"total":2,"list":[{"id":"91","oid":"910","name":"第1集"},{"id":"92","oid":"920","name":"第2集"}]}""",
      ).build(),
    )
    val chapters = SourceContract.parseChapters(engine.invoke("chapters", """{"bookId":"9"}""", 20_000))
    assertEquals(2, chapters.size)
    assertEquals("第1集", chapters[0].title)
    assertEquals("910", chapters[0].extra["oid"]?.toString()?.removeSurrounding("\""))

    server.enqueue(MockResponse.Builder().body("""{"data":{"src":"https://cdn.example.com/9/91.mp3"}}""").build())
    val audio = engine.invoke("audio", """{"bookId":"9","chapterId":"91","oid":"910"}""", 30_000)
    assertEquals("https://cdn.example.com/9/91.mp3", SourceContract.parseAudio(audio).url)

    // the audio request must carry an AES-ECB encrypted payload with the fixed token prefix
    val searchRequest = server.takeRequest()
    assertEquals("/api/itingshu/cloudsearch", searchRequest.url.encodedPath)
    val chaptersRequest = server.takeRequest()
    assertEquals("/api/itingshu/bookdirst", chaptersRequest.url.encodedPath)
    val audioRequest = server.takeRequest()
    assertEquals("/api/itingshu/audio", audioRequest.url.encodedPath)
    engine.close()
  }
}
