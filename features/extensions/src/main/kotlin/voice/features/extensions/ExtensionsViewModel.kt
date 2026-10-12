package voice.features.extensions

import android.net.Uri
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.Assisted
import dev.zacsweers.metro.AssistedFactory
import dev.zacsweers.metro.AssistedInject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import voice.core.common.DispatcherProvider
import voice.core.common.MainScope
import voice.core.extension.ExtensionInstallException
import voice.core.extension.ExtensionManager
import voice.core.extension.InstalledExtensionPackage
import voice.navigation.Destination
import voice.navigation.Navigator
import voice.navigation.Origin

data class ExtensionSourceUi(
  val sourceId: String,
  val name: String,
  val capabilities: List<String>,
  val enabled: Boolean,
)

data class ExtensionPackageUi(
  val manifestId: String,
  val name: String,
  val version: String,
  val author: String,
  val description: String,
  val sources: List<ExtensionSourceUi>,
)

data class ExtensionsViewState(
  val packages: List<ExtensionPackageUi>,
  val showUrlDialog: Boolean,
  val urlInput: String,
  val busy: Boolean,
  val message: String?,
  val uninstallManifestId: String? = null,
)

@AssistedInject
class ExtensionsViewModel(
  private val extensionManager: ExtensionManager,
  dispatcherProvider: DispatcherProvider,
  private val navigator: Navigator,
  @Assisted
  private val origin: Origin,
) {

  private val scope = MainScope(dispatcherProvider)

  private val showUrlDialog = MutableStateFlow(false)
  private val urlInput = MutableStateFlow("")
  private val busy = MutableStateFlow(false)
  private val message = MutableStateFlow<String?>(null)
  private val uninstallCandidate = MutableStateFlow<String?>(null)

  @Composable
  fun viewState(): ExtensionsViewState {
    val packages by extensionManager.packagesStore().data.collectAsState(initial = emptyList())
    val showUrl by showUrlDialog.collectAsState()
    val url by urlInput.collectAsState()
    val busyState by busy.collectAsState()
    val messageState by message.collectAsState()
    val uninstallState by uninstallCandidate.collectAsState()
    return ExtensionsViewState(
      packages = packages.map { it.toUi() },
      showUrlDialog = showUrl,
      urlInput = url,
      busy = busyState,
      message = messageState,
      uninstallManifestId = uninstallState,
    )
  }

  fun onFilePicked(uri: Uri) {
    runBusy {
      try {
        val manifest = extensionManager.installFromUri(uri)
        message.value = null
        announce(manifest)
      } catch (e: Exception) {
        message.value = e.userMessage()
      }
    }
  }

  fun showUrlDialog() {
    showUrlDialog.value = true
  }

  fun dismissUrlDialog() {
    showUrlDialog.value = false
  }

  fun updateUrlInput(value: String) {
    urlInput.value = value
  }

  fun importFromUrl() {
    val url = urlInput.value.trim()
    if (url.isEmpty()) return
    showUrlDialog.value = false
    runBusy {
      try {
        val manifest = extensionManager.installFromUrl(url)
        urlInput.value = ""
        message.value = null
        announce(manifest)
      } catch (e: Exception) {
        message.value = e.userMessage()
      }
    }
  }

  fun setSourceEnabled(
    sourceId: String,
    enabled: Boolean,
  ) {
    scope.launch {
      extensionManager.setSourceEnabled(sourceId, enabled)
    }
  }

  fun requestUninstall(manifestId: String) {
    uninstallCandidate.value = manifestId
  }

  fun dismissUninstall() {
    uninstallCandidate.value = null
  }

  fun confirmUninstall() {
    val manifestId = uninstallCandidate.value ?: return
    uninstallCandidate.value = null
    runBusy {
      try {
        extensionManager.uninstall(manifestId)
      } catch (e: Exception) {
        message.value = e.userMessage()
      }
    }
  }

  fun dismissMessage() {
    message.value = null
  }

  fun back() {
    navigator.goBack()
  }

  private fun announce(manifest: voice.core.extension.engine.ExtensionManifest) {
    message.value = "已导入 ${manifest.name} v${manifest.version}（${manifest.sources.size} 个源）"
  }

  private fun runBusy(block: suspend () -> Unit) {
    if (busy.value) return
    busy.value = true
    scope.launch {
      try {
        block()
      } finally {
        busy.value = false
      }
    }
  }

  private fun Exception.userMessage(): String = (this as? ExtensionInstallException)?.message ?: "导入失败：${message ?: "未知错误"}"

  private fun InstalledExtensionPackage.toUi(): ExtensionPackageUi = ExtensionPackageUi(
    manifestId = manifest.id,
    name = manifest.name,
    version = manifest.version,
    author = manifest.author,
    description = manifest.description,
    sources = manifest.sources.map { meta ->
      ExtensionSourceUi(
        sourceId = meta.id,
        name = meta.name.ifBlank { meta.id },
        capabilities = meta.capabilities,
        enabled = isSourceEnabled(meta.id),
      )
    },
  )

  @AssistedFactory
  interface Factory {
    fun create(origin: Origin): ExtensionsViewModel
  }
}
