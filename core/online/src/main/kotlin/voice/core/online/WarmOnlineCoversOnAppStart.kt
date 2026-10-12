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
 * Downloads covers for shelf books that still point at a remote url, so after
 * the first successful fetch every cover loads from a local file instead of
 * racing Coil's shared (and evictable) image cache across app starts.
 */
@ContributesIntoSet(AppScope::class)
@Inject
public class WarmOnlineCoversOnAppStart(
  private val service: OnlineSourceService,
  dispatcherProvider: DispatcherProvider,
) : AppInitializer {

  private val scope = CoroutineScope(SupervisorJob() + dispatcherProvider.io)

  override fun onAppStart(application: Application) {
    scope.launch {
      runCatching { service.backfillCovers() }
        .onFailure { Logger.w("Warming the online covers failed: $it") }
    }
  }
}
