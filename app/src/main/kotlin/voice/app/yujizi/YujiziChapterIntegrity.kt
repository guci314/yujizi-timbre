package voice.app.yujizi

import android.app.Application
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.ContributesBinding
import dev.zacsweers.metro.Inject
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import voice.core.logging.api.Logger
import voice.core.online.OnlineChapterIntegrity
import voice.core.online.OnlineChapterRef

/** 完整性清单的磁盘格式，由 scripts/make_yujizi_integrity.py 生成。 */
@Serializable
internal data class YujiziIntegrity(
  val version: Int = 1,
  /** key = "专辑id/曲目序号"。 */
  val files: Map<String, Entry> = emptyMap(),
) {
  @Serializable
  internal data class Entry(
    val size: Long = 0L,
    val sha256: String = "",
  )
}

/**
 * 玉机子的章节完整性依据：清单随 App 打包（`assets/yujizi_integrity.json`），
 * 下载完一章后由 [voice.core.online.OnlineBookCacheManager] 校验字节数与 sha256。
 *
 * 清单只覆盖内置源（[YujiziSource.SOURCE_NAME]）；其它源的章节返回 null，
 * 退回「只按 HTTP 的 Content-Length 校验」。
 *
 * 内容更新（加专辑、换音频）后要重跑 `scripts/make_yujizi_integrity.py` 并重新打包，
 * 否则尺寸对不上的文件会被判为不完整、反复重下 —— 这也正是清单该随内容一起版本化的原因。
 */
@ContributesBinding(AppScope::class)
@Inject
public class YujiziChapterIntegrity(private val application: Application) : OnlineChapterIntegrity {

  private val json = Json { ignoreUnknownKeys = true }

  /** 首次用到时才读 assets；读失败就当作「没有依据」，不挡下载。 */
  private val entries: Map<String, YujiziIntegrity.Entry> by lazy { load() }

  override fun expectedSize(ref: OnlineChapterRef): Long? {
    return entry(ref)?.size?.takeIf { it > 0L }
  }

  override fun expectedSha256(ref: OnlineChapterRef): String? {
    return entry(ref)?.sha256?.takeIf { it.isNotBlank() }
  }

  private fun entry(ref: OnlineChapterRef): YujiziIntegrity.Entry? {
    if (ref.source != YujiziSource.SOURCE_NAME) {
      return null
    }
    return entries["${ref.bookId}/${ref.chapterId}"]
  }

  private fun load(): Map<String, YujiziIntegrity.Entry> {
    return runCatching {
      val text = application.assets.open(YujiziSource.INTEGRITY_ASSET)
        .use { it.readBytes().toString(Charsets.UTF_8) }
      val parsed = json.decodeFromString(YujiziIntegrity.serializer(), text)
      Logger.i("玉机子：完整性清单载入 ${parsed.files.size} 条")
      parsed.files
    }.onFailure {
      Logger.w("玉机子：完整性清单读取失败，本次只按长度校验: $it")
    }.getOrDefault(emptyMap())
  }
}
