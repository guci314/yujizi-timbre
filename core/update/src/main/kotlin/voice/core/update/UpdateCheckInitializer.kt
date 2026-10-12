package voice.core.update

import android.app.Application
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.ContributesIntoSet
import voice.core.initializer.AppInitializer

/**
 * 玉机子：升级检查已整体关闭。
 *
 * 上游实现是调 `UpdateNotifier.onAppStarted()` 去拉 `cq10086123/Timbre` 的
 * `update.json`，对本 App 是错的：它会把「有新版本」推给用户，而那个新版本是
 * 原版 Timbre —— 装上去就会把内置的玉机子接口源和书架一起换掉。
 *
 * 保留这个空实现（而不是删掉文件）是为了让 DI 图里「有这么一个启动器」这件事
 * 仍然显式可见；要恢复升级检查，把 `UpdateNotifier` 注回来即可。
 */
@ContributesIntoSet(AppScope::class)
class UpdateCheckInitializer : AppInitializer {

  override fun onAppStart(application: Application) {
    // 玉机子：故意什么都不做。
  }
}
