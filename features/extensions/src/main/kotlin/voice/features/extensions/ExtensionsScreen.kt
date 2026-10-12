package voice.features.extensions

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.retain.retain
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.navigation3.runtime.NavEntry
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.ContributesTo
import dev.zacsweers.metro.IntoSet
import dev.zacsweers.metro.Provides
import voice.core.common.rootGraphAs
import voice.core.ui.icons.VoiceIcons
import voice.navigation.Destination
import voice.navigation.NavEntryProvider
import voice.navigation.Origin
import voice.core.strings.R as StringsR

@ContributesTo(AppScope::class)
interface ExtensionsGraph {
  val extensionsViewModelFactory: ExtensionsViewModel.Factory
}

@ContributesTo(AppScope::class)
interface ExtensionsProvider {

  @Provides
  @IntoSet
  fun extensionsNavEntryProvider(): NavEntryProvider<*> = NavEntryProvider<Destination.ExtensionSources> { key ->
    NavEntry(key) {
      ExtensionsScreen(origin = Origin.Default)
    }
  }
}

@Composable
fun ExtensionsScreen(origin: Origin) {
  val viewModel = retain(origin.name) {
    rootGraphAs<ExtensionsGraph>()
      .extensionsViewModelFactory
      .create(origin)
  }
  val viewState = viewModel.viewState()
  ExtensionsView(
    viewState = viewState,
    listener = viewModel,
  )
  if (viewState.showUrlDialog) {
    ExtensionsUrlDialog(viewState = viewState, listener = viewModel)
  }
  viewState.uninstallManifestId?.let {
    ExtensionsUninstallConfirmView(listener = viewModel)
  }
}

@Composable
private fun ExtensionsView(
  viewState: ExtensionsViewState,
  listener: ExtensionsViewModel,
) {
  val snackbarHostState = remember { SnackbarHostState() }
  val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
    if (uri != null) {
      listener.onFilePicked(uri)
    }
  }
  LaunchedEffect(viewState.message) {
    viewState.message?.let { snackbarHostState.showSnackbar(it) }
  }
  Scaffold(
    topBar = {
      TopAppBar(
        title = { Text(stringResource(StringsR.string.extensions_title)) },
        navigationIcon = {
          IconButton(onClick = listener::back) {
            Icon(imageVector = VoiceIcons.ArrowBack, contentDescription = stringResource(StringsR.string.common_action_close))
          }
        },
      )
    },
    snackbarHost = { SnackbarHost(snackbarHostState) },
  ) { contentPadding ->
    LazyColumn(contentPadding = contentPadding) {
      item {
        ListItem(
          modifier = Modifier.clickable {
            filePicker.launch(arrayOf("*/*"))
          },
          supportingContent = { Text(stringResource(StringsR.string.extensions_import_file_summary)) },
          trailingContent = {
            if (viewState.busy) {
              CircularProgressIndicator(modifier = Modifier.padding(8.dp))
            }
          },
        ) {
          Text(stringResource(StringsR.string.extensions_import_file))
        }
        ListItem(
          modifier = Modifier.clickable(onClick = listener::showUrlDialog),
          supportingContent = { Text(stringResource(StringsR.string.extensions_import_url_summary)) },
        ) {
          Text(stringResource(StringsR.string.extensions_import_url))
        }
      }
      if (viewState.packages.isEmpty()) {
        item {
          Text(
            modifier = Modifier.padding(24.dp),
            text = stringResource(StringsR.string.extensions_empty),
          )
        }
      }
      items(viewState.packages, key = { it.manifestId }) { pkg ->
        ListItem(
          supportingContent = {
            Column {
              Text(stringResource(StringsR.string.extensions_package_version, pkg.version))
              if (pkg.author.isNotBlank()) {
                Text(stringResource(StringsR.string.extensions_package_author, pkg.author))
              }
            }
          },
          trailingContent = {
            IconButton(onClick = { listener.requestUninstall(pkg.manifestId) }) {
              Icon(
                imageVector = VoiceIcons.Delete,
                contentDescription = stringResource(StringsR.string.extensions_uninstall),
              )
            }
          },
        ) {
          Text(pkg.name)
        }
        pkg.sources.forEach { source ->
          ListItem(
            supportingContent = { Text("jdr:${source.sourceId}") },
            trailingContent = {
              Switch(
                checked = source.enabled,
                onCheckedChange = { checked -> listener.setSourceEnabled(source.sourceId, checked) },
              )
            },
          ) {
            Text(source.name)
          }
        }
      }
    }
  }
}

@Composable
private fun ExtensionsUninstallConfirmView(listener: ExtensionsViewModel) {
  AlertDialog(
    onDismissRequest = listener::dismissUninstall,
    title = { Text(stringResource(StringsR.string.extensions_uninstall)) },
    text = { Text(stringResource(StringsR.string.extensions_uninstall_confirm)) },
    confirmButton = {
      TextButton(onClick = listener::confirmUninstall) {
        Text(stringResource(StringsR.string.extensions_uninstall))
      }
    },
    dismissButton = {
      TextButton(onClick = listener::dismissUninstall) {
        Text(stringResource(StringsR.string.common_dialog_cancel))
      }
    },
  )
}

@Composable
private fun ExtensionsUrlDialog(
  viewState: ExtensionsViewState,
  listener: ExtensionsViewModel,
) {
  AlertDialog(
    onDismissRequest = listener::dismissUrlDialog,
    title = { Text(stringResource(StringsR.string.extensions_import_url)) },
    text = {
      Column {
        OutlinedTextField(
          modifier = Modifier.fillMaxWidth(),
          value = viewState.urlInput,
          onValueChange = listener::updateUrlInput,
          label = { Text(stringResource(StringsR.string.extensions_import_url_hint)) },
          singleLine = true,
        )
      }
    },
    confirmButton = {
      Button(onClick = listener::importFromUrl, enabled = viewState.urlInput.isNotBlank()) {
        Text(stringResource(StringsR.string.extensions_import))
      }
    },
    dismissButton = {
      TextButton(onClick = listener::dismissUrlDialog) {
        Text(stringResource(StringsR.string.common_dialog_cancel))
      }
    },
  )
}
