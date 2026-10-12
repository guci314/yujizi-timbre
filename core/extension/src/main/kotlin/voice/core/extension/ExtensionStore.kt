package voice.core.extension

import android.app.Application
import androidx.datastore.core.CorruptionException
import androidx.datastore.core.DataStore
import androidx.datastore.core.DataStoreFactory
import androidx.datastore.core.Serializer
import dev.zacsweers.metro.Inject
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromStream
import kotlinx.serialization.json.encodeToStream
import voice.core.extension.engine.ExtensionManifest
import voice.core.extension.engine.ExtensionSourceMeta
import java.io.File
import java.io.InputStream
import java.io.OutputStream

/** One installed .jdr package with the enabled state of its sources. */
@Serializable
public data class InstalledExtensionPackage(
  public val manifest: ExtensionManifest,
  public val installedAtMillis: Long,
  /** sourceId → enabled; missing entries are enabled. */
  public val sourceEnabled: Map<String, Boolean> = emptyMap(),
) {

  public fun isSourceEnabled(sourceId: String): Boolean = sourceEnabled[sourceId] ?: true

  public fun enabledSources(): List<ExtensionSourceMeta> = manifest.sources.filter { isSourceEnabled(it.id) }
}

@Inject
public class ExtensionStoreFactory internal constructor(private val context: Application) {

  internal val json: Json = Json {
    ignoreUnknownKeys = true
  }

  internal fun packages(): DataStore<List<InstalledExtensionPackage>> {
    return create(
      serializer = ListSerializer(InstalledExtensionPackage.serializer()),
      defaultValue = emptyList(),
      fileName = "extensionPackages",
    )
  }

  internal fun <T> create(
    serializer: KSerializer<T>,
    defaultValue: T,
    fileName: String,
  ): DataStore<T> {
    return DataStoreFactory.create(
      serializer = ExtensionDataStoreSerializer(defaultValue, json, serializer),
    ) {
      File(context.applicationContext.filesDir, "datastore/$fileName")
    }
  }
}

internal class ExtensionDataStoreSerializer<T>(
  override val defaultValue: T,
  private val json: Json,
  private val serializer: KSerializer<T>,
) : Serializer<T> {

  @OptIn(ExperimentalSerializationApi::class)
  override suspend fun readFrom(input: InputStream): T {
    return try {
      json.decodeFromStream(serializer, input)
    } catch (e: CorruptionException) {
      throw e
    } catch (e: Exception) {
      defaultValue
    }
  }

  @OptIn(ExperimentalSerializationApi::class)
  override suspend fun writeTo(
    t: T,
    output: OutputStream,
  ) {
    json.encodeToStream(serializer, t, output)
  }
}
