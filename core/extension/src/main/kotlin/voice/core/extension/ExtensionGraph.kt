package voice.core.extension

import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.ContributesTo
import dev.zacsweers.metro.IntoSet
import dev.zacsweers.metro.Provides
import dev.zacsweers.metro.SingleIn
import voice.core.online.ExtensionOnlineSource

@ContributesTo(AppScope::class)
public interface ExtensionGraph {

  @Provides
  @SingleIn(AppScope::class)
  @IntoSet
  public fun extensionSourceBackend(backend: ExtensionSourceBackend): ExtensionOnlineSource = backend
}
