package voice.app.yujizi

import android.app.Application
import androidx.datastore.core.DataStore
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.ContributesIntoSet
import dev.zacsweers.metro.Inject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import voice.core.common.DispatcherProvider
import voice.core.data.store.OnboardingCompletedStore
import voice.core.extension.ExtensionManager
import voice.core.initializer.AppInitializer
import voice.core.logging.api.Logger
import voice.core.online.OnlineBook
import voice.core.online.OnlineSourceService

/**
 * 玉机子：把内置的接口源与九部经目在首次启动时准备好。
 *
 * <p>改造目的：网站上来的道友不懂「导入 .jdr / 搜索 / 加入书架」这一套，
 * 所以这里把三件事都做掉，装完打开就是书架：
 *
 * 1. 把打包在 assets 里的 `yujizi.jdr` 装进扩展源（幂等：同 manifest id 重复安装
 *    等于原地更新，所以换新版本时只要替换 assets 里的文件即可）
 * 2. 用这个源把九部经目直接铺到书架，每本书连章节一起写进去
 * 3. 标记「引导已完成」——本 App 只服务玉机子，不需要让用户去添加本地文件夹
 *
 * <p>整段跑在 IO 线程且全程 runCatching：任何一步失败都只是少几本书，
 * 不能挡住 App 启动。
 */
@ContributesIntoSet(AppScope::class)
@Inject
public class YujiziSetupOnAppStart(
  private val extensionManager: ExtensionManager,
  private val onlineSourceService: OnlineSourceService,
  @OnboardingCompletedStore private val onboardingCompletedStore: DataStore<Boolean>,
  dispatcherProvider: DispatcherProvider,
) : AppInitializer {

  private val scope = CoroutineScope(SupervisorJob() + dispatcherProvider.io)

  override fun onAppStart(application: Application) {
    scope.launch {
      runCatching { installBundledSource(application) }
        .onFailure { Logger.w("玉机子：内置接口源安装失败: $it") }
      runCatching { seedShelf() }
        .onFailure { Logger.w("玉机子：经目铺书架失败: $it") }
      runCatching { onboardingCompletedStore.updateData { true } }
        .onFailure { Logger.w("玉机子：跳过引导失败: $it") }
    }
  }

  private suspend fun installBundledSource(application: Application) {
    val installed = extensionManager.installed().any { it.manifest.id == BUNDLED_MANIFEST_ID }
    if (installed) {
      return
    }
    val bytes = application.assets.open(BUNDLED_ASSET).use { it.readBytes() }
    val manifest = extensionManager.install(bytes)
    Logger.i("玉机子：已安装内置接口源 ${manifest.name} v${manifest.version}")
  }

  private suspend fun seedShelf() {
    val onShelf = onlineSourceService.shelf().first().map { it.key }.toHashSet()
    val books = onlineSourceService.search(SOURCE_NAME, "")
    var added = 0
    for (book in books) {
      val key = "${book.source}::${book.bookId}"
      if (key in onShelf) {
        continue
      }
      val chapters = onlineSourceService.chapters(book.source, book.bookId)
      onlineSourceService.addToShelf(
        OnlineBook(
          source = book.source,
          bookId = book.bookId,
          title = book.title,
          author = book.author,
          cover = book.cover,
          chapters = chapters,
        ),
      )
      added++
    }
    if (added > 0) {
      Logger.i("玉机子：书架新增 $added 部经目")
    }
  }

  private companion object {
    /** 打进 assets 的接口源包名，与 scripts/make_yujizi_jdr.py 生成的保持一致。 */
    const val BUNDLED_ASSET = "yujizi.jdr"
    const val BUNDLED_MANIFEST_ID = "org.yujizi.source"

    /** 扩展源的寻址前缀见 ExtensionEngineProvider.SOURCE_PREFIX。 */
    const val SOURCE_NAME = "jdr:yujizi"
  }
}
