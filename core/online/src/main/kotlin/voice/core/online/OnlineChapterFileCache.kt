package voice.core.online

import java.io.File
import java.net.URLEncoder
import java.security.MessageDigest

/**
 * Local files of manually cached online chapters, so cached episodes keep
 * playing offline. Layout:
 * `online_chapters/<source>/<bookId>/<chapterId>.audio`, downloads land in a
 * `.tmp` sibling first and are renamed only when complete.
 *
 * ⚠️ 「落盘即完整」这个假设**不能只靠 .tmp 改名来保证**：连接中途被掐断时
 * `copyTo` 会静默返回半截内容，改名照样发生。所以下载路径要按
 * `Content-Length` / sha256 校验（见 [OnlineChapterIntegrity]），
 * 读取侧（[isCached]、[OnlineStreamingDataSource]）也要按同一依据判定完整性。
 *
 * This is deliberately separate from every automatic cache: resolved stream
 * urls live in memory with a short ttl, and the webdav prefetch only knows
 * http(s) urls - none of them ever reads or writes here, so manual caching
 * cannot fight automatic playback.
 *
 * Provided by [OnlineSourceGraph] with the app files dir; tests construct it
 * with a temp dir directly.
 */
public class OnlineChapterFileCache internal constructor(
  private val root: File,
  /** 完整性依据；null = 只看文件非空（上游默认行为）。 */
  private val integrity: OnlineChapterIntegrity? = null,
) {

  /** The final (complete only) file of [ref]; absent when not cached. */
  public fun fileFor(ref: OnlineChapterRef): File {
    return File(File(File(root, safe(ref.source)), safe(ref.bookId)), safe(ref.chapterId) + EXTENSION)
  }

  /**
   * True when a complete file of [ref] is stored.
   *
   * 完整性依据可用时会连尺寸一起比对：连接中断留下的**截断文件**尺寸对不上，
   * 于是这里返回 false，缓存任务会把它重下（上游只判非空，截断文件会被永久
   * 当成已缓存）。
   */
  public fun isCached(ref: OnlineChapterRef): Boolean {
    val file = fileFor(ref)
    if (!file.exists() || file.length() <= 0L) {
      return false
    }
    val expected = integrity?.expectedSize(ref) ?: return true
    return file.length() == expected
  }

  /** How many complete chapters of a book are stored. */
  public fun cachedFileCount(
    source: String,
    bookId: String,
  ): Int {
    val dir = File(File(root, safe(source)), safe(bookId))
    return dir.listFiles()
      ?.count { it.isFile && it.name.endsWith(EXTENSION) && isCompleteFile(source, bookId, it) }
      ?: 0
  }

  /** How many bytes of complete chapters of a book are stored. */
  public fun cachedBytes(
    source: String,
    bookId: String,
  ): Long {
    val dir = File(File(root, safe(source)), safe(bookId))
    return dir.listFiles()
      ?.filter { it.isFile && it.name.endsWith(EXTENSION) && isCompleteFile(source, bookId, it) }
      ?.sumOf { it.length() } ?: 0L
  }

  /**
   * 一个已落盘文件是否算「完整章节」：非空 + （有依据时）尺寸对得上。
   * 文件名里的章节 id 是 URL 编码过的，解码后回问完整性依据；解不回来
   * （超长 id 被哈希过）就按「无依据」处理，不误删。
   */
  private fun isCompleteFile(
    source: String,
    bookId: String,
    file: File,
  ): Boolean {
    if (file.length() <= 0L) {
      return false
    }
    if (integrity == null) {
      return true
    }
    val chapterId = runCatching {
      java.net.URLDecoder.decode(file.name.removeSuffix(EXTENSION), Charsets.UTF_8.name())
    }.getOrNull() ?: return true
    val expected = integrity.expectedSize(OnlineChapterRef(source, bookId, chapterId)) ?: return true
    return file.length() == expected
  }

  /**
   * Drops every cached chapter of a book (including partial downloads).
   * Returns true when anything was removed.
   */
  public fun clearBook(
    source: String,
    bookId: String,
  ): Boolean {
    val dir = File(File(root, safe(source)), safe(bookId))
    if (!dir.exists()) return false
    return dir.deleteRecursively()
  }

  /** The scratch file a download of [ref] is written to. */
  internal fun tmpFileFor(ref: OnlineChapterRef): File {
    val final = fileFor(ref)
    return File(final.parent, final.name + TMP_SUFFIX)
  }

  /** Publishes a finished download of [ref]; false when there is nothing complete to publish. */
  internal fun completeDownload(ref: OnlineChapterRef): Boolean {
    val tmp = tmpFileFor(ref)
    if (!tmp.exists() || tmp.length() <= 0L) {
      tmp.delete()
      return false
    }
    val dest = fileFor(ref)
    if (dest.exists()) dest.delete()
    return tmp.renameTo(dest)
  }

  /** Drops a partial download of [ref], e.g. after a cancellation. */
  internal fun discardTmp(ref: OnlineChapterRef) {
    tmpFileFor(ref).delete()
  }

  private fun safe(segment: String): String {
    val encoded = URLEncoder.encode(segment, Charsets.UTF_8.name()).replace("+", "%20")
    if (encoded.length <= MAX_SEGMENT_LENGTH) return encoded
    // very long ids would overflow the file name limit: hash them instead
    return MessageDigest.getInstance("SHA-256")
      .digest(segment.toByteArray(Charsets.UTF_8))
      .joinToString("") { "%02x".format(it) }
  }

  internal companion object {
    const val CACHE_DIR = "online_chapters"
    const val EXTENSION = ".audio"
    const val TMP_SUFFIX = ".tmp"
    const val MAX_SEGMENT_LENGTH = 100
  }
}
