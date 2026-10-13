package voice.core.online

import java.io.File
import java.security.MessageDigest

/**
 * 章节完整性依据：内容方可以按章节声明期望的字节数与 sha256。
 *
 * 上游原先只检查「临时文件非空」就发布（`tmp.length() > 0`），而 OkHttp 在连接被
 * 中途掐断时 `copyTo` 会**静默返回半截内容** —— 于是截断的音频被写进最终文件、
 * 被当成完整缓存，播放时长自然不对，而且永远不会重下（`isCached` 同样只看非空）。
 * 玉机子的单集十几到几十 MB、由 CDN 分发，正是最容易中招的场景。
 *
 * 实现由 app 模块提供（内置源的完整性清单就在它的 assets 里）；没有实现时，
 * 下载路径仍会按 HTTP 的 `Content-Length` 校验，只是少了哈希这一道。
 */
public interface OnlineChapterIntegrity {

  /** 期望的字节数；null = 未知，跳过长度校验。 */
  public fun expectedSize(ref: OnlineChapterRef): Long?

  /** 期望的 sha256（小写十六进制）；null = 未知，跳过哈希校验。 */
  public fun expectedSha256(ref: OnlineChapterRef): String?
}

/** 流式计算文件的 sha256，返回小写十六进制。 */
public fun File.sha256Hex(): String {
  val digest = MessageDigest.getInstance("SHA-256")
  inputStream().use { input ->
    val buffer = ByteArray(1 shl 16)
    while (true) {
      val read = input.read(buffer)
      if (read < 0) break
      digest.update(buffer, 0, read)
    }
  }
  return digest.digest().joinToString("") { "%02x".format(it) }
}
