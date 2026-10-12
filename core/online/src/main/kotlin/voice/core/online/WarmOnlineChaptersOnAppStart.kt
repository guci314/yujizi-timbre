package voice.core.online

import android.app.Application
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.ContributesIntoSet
import dev.zacsweers.metro.Inject
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import voice.core.common.DispatcherProvider
import voice.core.initializer.AppInitializer
import voice.core.logging.api.Logger

/**
 * Warms the per-book chapter lists into memory at app start, so the shelf
 * merges total and remaining durations without a per-book file read landing
 * while a card is already on screen.
 */
@ContributesIntoSet(AppScope::class)
@Inject
public class WarmOnlineChaptersOnAppStart(
  private val chapterStore: OnlineChapterStore,
  dispatcherProvider: DispatcherProvider,
) : AppInitializer {

  private val scope = CoroutineScope(SupervisorJob() + dispatcherProvider.io)

  override fun onAppStart(application: Application) {
    scope.launch {
      runCatching { chapterStore.loadAll() }
        .onFailure { Logger.w("Warming the online chapter lists failed: $it") }
    }
  }
}
