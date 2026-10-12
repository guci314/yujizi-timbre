package voice.features.folderPicker.addcontent

import android.widget.Toast
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.retain.retain
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.tooling.preview.Preview
import androidx.navigation3.runtime.NavEntry
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.ContributesTo
import dev.zacsweers.metro.IntoSet
import dev.zacsweers.metro.Provides
import voice.core.common.rootGraphAs
import voice.core.ui.VoiceTheme
import voice.navigation.Destination
import voice.navigation.NavEntryProvider
import voice.navigation.Origin

@ContributesTo(AppScope::class)
interface AddContentGraph {
  val viewModelFactory: AddContentViewModel.Factory
}

@ContributesTo(AppScope::class)
interface AddContentProvider {

  @Provides
  @IntoSet
  fun addContentNavEntryProvider(): NavEntryProvider<*> = NavEntryProvider<Destination.AddContent> { key ->
    NavEntry(key) {
      AddContent(origin = key.origin)
    }
  }
}

@Composable
fun AddContent(origin: Origin) {
  val viewModel = retain(origin.name) {
    rootGraphAs<AddContentGraph>().viewModelFactory.create(origin)
  }
  val context = LocalContext.current
  val importError by viewModel.sourceImportError.collectAsState()
  LaunchedEffect(importError) {
    importError?.let {
      Toast.makeText(context, it, Toast.LENGTH_LONG).show()
      viewModel.consumeImportError()
    }
  }
  SelectFolder(
    onBack = {
      viewModel.back()
    },
    origin = origin,
    onAddFolder = viewModel::addFolder,
    onImportSource = viewModel::importSource,
    // the onboarding import page offers webdav as well: a fresh install has
    // no settings entry to configure a server yet, so this is the only place
    // to reach it from
    onWebDav = viewModel::openWebDav,
  )
}

@Composable
@Preview
private fun AddContentPreview() {
  VoiceTheme {
    AddContent(Origin.Default)
  }
}
