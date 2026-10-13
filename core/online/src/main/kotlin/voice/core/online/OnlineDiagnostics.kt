package voice.core.online

import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.Inject
import dev.zacsweers.metro.SingleIn
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import voice.core.data.BookId
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * 把「这一本到底为什么播不了 / 缓存不动」的每一步摊成一段可复制的文字。
 *
 * 起因：真机上出现「缓存进度一直是 0」「未缓存的音频播不了」而且**不报错**。
 * 这类静默失败在客户端代码里查不到 —— 只有把每一步的耗时与异常摆出来才知道
 * 卡在哪一环（源解析？取流？校验？）。所以这里刻意**逐步计时 + 每步单独捕获异常**，
 * 并且给解析套一个超时：引擎调用默认没有超时，挂死时只有超时能把它变成一句话。
 */
@Inject
@SingleIn(AppScope::class)
public class OnlineDiagnostics(
  private val service: OnlineSourceService,
  private val fileCache: OnlineChapterFileCache,
  private val integrity: OnlineChapterIntegrity,
  @OnlineSourceStreamingClient private val httpClient: OkHttpClient,
) {

  /** 报告里取流测试只读这么多字节，够看出「能不能拿到音频」又不浪费流量。 */
  private val probeBytes = 64 * 1024

  public suspend fun report(bookId: BookId): String = withContext(Dispatchers.IO) {
    val out = StringBuilder()
    out.appendLine("【玉机子 · 播放诊断】")
    out.appendLine("书: ${bookId.value}")

    val ref = OnlineUri.parseBookUri(bookId.value)
    if (ref == null) {
      out.appendLine("这不是在线书（没有在线 uri），无法诊断。")
      return@withContext out.toString()
    }
    out.appendLine("源: ${ref.source} · 书 id: ${ref.bookId}")

    val book = runCatching { service.shelfBook(OnlineBookRef(ref.source, ref.bookId).key) }
      .getOrElse {
        out.appendLine("读书架失败: ${it.describe()}")
        return@withContext out.toString()
      }
    if (book == null) {
      out.appendLine("书架里没有这本（可能没加入书架）。")
      return@withContext out.toString()
    }
    out.appendLine("章节数: ${book.chapters.size}")

    val chapter = book.chapters.firstOrNull()
    if (chapter == null) {
      out.appendLine("这本书没有章节。")
      return@withContext out.toString()
    }
    out.appendLine("测试章节: ${chapter.id} ${chapter.title}")

    val chapterRef = OnlineChapterRef(ref.source, ref.bookId, chapter.id)
    out.appendLine("① 缓存状态: ${cacheLine(chapterRef)}")

    // ② 源解析：这一步是「播不了」和「缓存不动」的共同前置
    val startedAt = System.currentTimeMillis()
    val resolved = try {
      withTimeout(RESOLVE_TIMEOUT_MS) { service.resolveDirectUrl(ref.source, ref.bookId, chapter.id) }
    } catch (e: TimeoutCancellationException) {
      out.appendLine("② 解析直链: 超时（${RESOLVE_TIMEOUT_MS / 1000}s 没有返回）← 卡在这里")
      return@withContext out.toString()
    } catch (e: Throwable) {
      out.appendLine("② 解析直链: 失败 ${System.currentTimeMillis() - startedAt}ms · ${e.describe()}")
      return@withContext out.toString()
    }
    val resolveMs = System.currentTimeMillis() - startedAt
    if (resolved == null) {
      out.appendLine("② 解析直链: 源没有返回地址（${resolveMs}ms）")
      return@withContext out.toString()
    }
    out.appendLine("② 解析直链: 成功 ${resolveMs}ms")
    out.appendLine("   ${resolved.url.take(200)}")
    if (resolved.headers.isNotEmpty()) {
      out.appendLine("   附加请求头: ${resolved.headers.keys.joinToString(",")}")
    }

    // ③ 取流：用播放器同一条 OkHttp 栈，只读前 64KB
    out.appendLine("③ 取流测试: ${probe(resolved)}")
    out.toString()
  }

  private fun cacheLine(ref: OnlineChapterRef): String {
    val file = fileCache.fileFor(ref)
    val expected = integrity.expectedSize(ref)
    val actual = if (file.exists()) file.length() else null
    return buildString {
      append(if (actual == null) "未缓存" else "已缓存 $actual 字节")
      append("（期望 ${expected ?: "未知"}）")
      if (actual != null && expected != null && actual != expected) {
        append(" ← 尺寸不符，会被判为不完整并重下")
      }
      append(" · isCached=")
      append(runCatching { fileCache.isCached(ref) }.getOrElse { "异常:${it.describe()}" })
    }
  }

  private fun probe(resolved: ResolvedStream): String {
    val builder = Request.Builder()
      .url(resolved.url)
      .header("Range", "bytes=0-${probeBytes - 1}")
    resolved.headers.forEach { (name, value) -> builder.header(name, value) }
    val startedAt = System.currentTimeMillis()
    return try {
      httpClient.newBuilder()
        .readTimeout(30, TimeUnit.SECONDS)
        .build()
        .newCall(builder.build())
        .execute()
        .use { response ->
          val body = response.body
          var read = 0
          body.byteStream().use { input ->
            val buffer = ByteArray(16 * 1024)
            while (read < probeBytes) {
              val n = input.read(buffer, 0, minOf(buffer.size, probeBytes - read))
              if (n <= 0) break
              read += n
            }
          }
          val ms = System.currentTimeMillis() - startedAt
          buildString {
            append("HTTP ${response.code}")
            append(" · ${response.header("Content-Type") ?: "无类型"}")
            append(" · 声明长度 ${body.contentLength()}")
            append(" · 实收 $read 字节")
            append(" · ${ms}ms")
            response.header("cf-cache-status")?.let { append(" · cf:$it") }
            if (response.code !in 200..299) append(" ← 状态码不是 2xx")
            if (read < probeBytes && response.code == 206) append(" ← 少读了（可能被截断）")
          }
        }
    } catch (e: Throwable) {
      "异常 ${System.currentTimeMillis() - startedAt}ms · ${e.describe()}"
    }
  }

  private fun Throwable.describe(): String {
    val cause = generateSequence(this) { it.cause }.take(4).joinToString(" < ") {
      "${it::class.java.simpleName}(${it.message?.take(120) ?: ""})"
    }
    return cause
  }

  private companion object {
    /** 引擎调用本身没有超时，挂死时靠这里把它变成一句可读的话。 */
    const val RESOLVE_TIMEOUT_MS = 20_000L
  }
}
