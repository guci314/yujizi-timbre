package voice.features.folderPicker.addcontent

import android.net.Uri
import dev.zacsweers.metro.Assisted
import dev.zacsweers.metro.AssistedFactory
import dev.zacsweers.metro.AssistedInject
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import voice.core.common.DispatcherProvider
import voice.core.common.MainScope
import voice.core.data.folders.AudiobookFolders
import voice.core.data.folders.FolderType
import voice.core.extension.ExtensionInstallException
import voice.core.extension.ExtensionManager
import voice.core.logging.api.Logger
import voice.core.scanner.MediaScanTrigger
import voice.navigation.Destination
import voice.navigation.Destination.OnboardingCompletion
import voice.navigation.Navigator
import voice.navigation.Origin

@AssistedInject
class AddContentViewModel(
  private val audiobookFolders: AudiobookFolders,
  private val extensionManager: ExtensionManager,
  private val mediaScanTrigger: MediaScanTrigger,
  dispatcherProvider: DispatcherProvider,
  private val navigator: Navigator,
  @Assisted
  private val origin: Origin,
) {

  private val scope = MainScope(dispatcherProvider)

  private val importError = MutableStateFlow<String?>(null)
  val sourceImportError: StateFlow<String?> = importError.asStateFlow()

  internal fun addFolder(uri: Uri) {
    scope.launch {
      // bookshelf model: the picked folder itself is one book
      audiobookFolders.add(uri, FolderType.SingleFolder)
      mediaScanTrigger.scan(restartIfScanning = true)
      navigateAfterAdd()
    }
  }

  internal fun importSource(source: SourceImport) {
    scope.launch {
      try {
        val manifest = when (source) {
          is SourceImport.Local -> extensionManager.installFromUri(source.uri)
          is SourceImport.Url -> extensionManager.installFromUrl(source.url)
        }
        Logger.i("导入书源成功: " + manifest.name + " v" + manifest.version)
        navigateAfterAdd()
      } catch (e: Exception) {
        importError.value = (e as? ExtensionInstallException)?.message
          ?: "书源导入失败：" + (e.message ?: "未知错误")
      }
    }
  }

  internal fun consumeImportError() {
    importError.value = null
  }

  private fun navigateAfterAdd() {
    when (origin) {
      Origin.Default -> {
        navigator.setRoot(Destination.BookOverview)
      }
      Origin.Onboarding -> {
        navigator.goTo(OnboardingCompletion)
      }
    }
  }

  internal fun openWebDav() {
    navigator.goTo(Destination.WebDavServers(origin))
  }

  internal fun back() {
    navigator.goBack()
  }

  @AssistedFactory
  interface Factory {
    fun create(origin: Origin): AddContentViewModel
  }
}
