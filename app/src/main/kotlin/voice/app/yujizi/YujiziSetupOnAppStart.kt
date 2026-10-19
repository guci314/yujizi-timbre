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
import voice.core.online.OnlineChapterStore
import voice.core.online.OnlineSourceService

/**
 * 玉机子：把内置的接口源与各部经目在启动时准备好。
 *
 * <p>改造目的：网站上来的道友不懂「导入 .jdr / 搜索 / 加入书架」这一套，
 * 所以这里把三件事都做掉，装完打开就是书架：
 *
 * 1. 把打包在 assets 里的 `yujizi.jdr` 装进扩展源 —— **每次启动都装**。
 *    同 manifest id 重复安装等于原地更新（见 ExtensionManager.install），
 *    所以换新版本时只要替换 assets 里的文件即可；反过来，早先这里对已安装的
 *    源直接 return，App 升级后跑的还是旧版接口源，新加的经目永远不出现。
 * 2. 用这个源把各部经目直接铺到书架，每本书连章节一起写进去；
 *    已经在架上的书，只有源里的章节列表变了才重写（重写保留播放进度与跳过设置）
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
  private val chapterStore: OnlineChapterStore,
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
    val bytes = application.assets.open(YujiziSource.JDR_ASSET).use { it.readBytes() }
    val manifest = extensionManager.install(bytes)
    Logger.i("玉机子：内置接口源已装入 ${manifest.name} v${manifest.version}")
  }

  private suspend fun seedShelf() {
    val onShelf = onlineSourceService.shelf().first().associateBy { it.key }
    val books = onlineSourceService.search(YujiziSource.SOURCE_NAME, "")
    var added = 0
    var refreshed = 0
    for (book in books) {
      val key = "${book.source}::${book.bookId}"
      val existing = onShelf[key]
      val chapters = onlineSourceService.chapters(book.source, book.bookId)
      if (existing != null) {
        val stored = chapterStore.chapters(key)
        if (stored.map { it.id } == chapters.map { it.id }) {
          continue
        }
      }
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
      if (existing == null) added++ else refreshed++
    }
    if (added > 0 || refreshed > 0) {
      Logger.i("玉机子：书架新增 $added 部经目,更新 $refreshed 部")
    }
  }
}
