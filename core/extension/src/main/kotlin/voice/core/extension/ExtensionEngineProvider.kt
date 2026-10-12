package voice.core.extension

import android.annotation.SuppressLint
import dev.zacsweers.metro.AppScope
import dev.zacsweers.metro.Inject
import dev.zacsweers.metro.SingleIn
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import voice.core.extension.engine.ExtensionSourceMeta
import voice.core.extension.engine.JsSourceEngine
import voice.core.extension.engine.OkHttpSandboxHttp
import voice.core.logging.api.Logger
import java.io.File
import java.security.SecureRandom
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * Creates and caches one [JsSourceEngine] per enabled extension source.
 * Cache entries are validated against the package's installed timestamp, so
 * re-importing, disabling or uninstalling a package invalidates its engines
 * automatically.
 */
@Inject
@SingleIn(AppScope::class)
public class ExtensionEngineProvider(private val manager: ExtensionManager) {

  private val mutex = Mutex()
  private val engines = HashMap<String, CachedEngine>()

  public suspend fun <T> useEngine(
    sourceId: String,
    block: suspend (JsSourceEngine) -> T,
  ): T {
    val pkg = manager.packageFor(sourceId)
      ?: throw ExtensionInstallException("扩展源 $sourceId 不存在或已停用")
    val cached = mutex.withLock { engines[sourceId] }
    val engine = if (cached != null && cached.installedAtMillis == pkg.installedAtMillis) {
      cached.engine
    } else {
      mutex.withLock {
        val current = engines[sourceId]
        if (current != null && current.installedAtMillis == pkg.installedAtMillis) {
          current.engine
        } else {
          current?.engine?.close()
          val created = create(sourceId, pkg)
          engines[sourceId] = CachedEngine(created, pkg.installedAtMillis)
          created
        }
      }
    }
    return block(engine)
  }

  private suspend fun create(
    sourceId: String,
    pkg: InstalledExtensionPackage,
  ): JsSourceEngine {
    val meta: ExtensionSourceMeta = pkg.manifest.sources.first { it.id == sourceId }
    val scriptFile = File(manager.packageDir(pkg.manifest.id), meta.script)
    val script = withContext(Dispatchers.IO) { scriptFile.readText(Charsets.UTF_8) }
    return JsSourceEngine.create(
      sourceId = sourceId,
      script = script,
      scriptName = meta.script,
      http = OkHttpSandboxHttp(if (pkg.manifest.allowInsecure) insecureClient else secureClient),
      log = { line -> Logger.i("[$SOURCE_PREFIX$sourceId] $line") },
    )
  }

  private val secureClient by lazy { buildHttpClient(allowInsecure = false) }
  private val insecureClient by lazy { buildHttpClient(allowInsecure = true) }

  private fun buildHttpClient(allowInsecure: Boolean): OkHttpClient {
    val builder = OkHttpClient.Builder()
      .connectTimeout(15, TimeUnit.SECONDS)
      .readTimeout(30, TimeUnit.SECONDS)
      .writeTimeout(30, TimeUnit.SECONDS)
    if (allowInsecure) {
      val context = SSLContext.getInstance("TLS")
      context.init(null, arrayOf<TrustManager>(TrustAllX509TrustManager), SecureRandom())
      builder.sslSocketFactory(context.socketFactory, TrustAllX509TrustManager)
        .hostnameVerifier { _, _ -> true }
    }
    return builder.build()
  }

  /**
   * Opt-in per package for broken TLS chains: the manifest's `allowInsecure`
   * flag explicitly enables trusting arbitrary certificates, mirroring the
   * WebDAV trust-all option. Lint-suppressed at the declaration level.
   */
  @SuppressLint("CustomX509TrustManager", "TrustAllX509TrustManager")
  private object TrustAllX509TrustManager : X509TrustManager {
    override fun checkClientTrusted(
      chain: Array<X509Certificate>,
      authType: String,
    ) = Unit

    override fun checkServerTrusted(
      chain: Array<X509Certificate>,
      authType: String,
    ) = Unit

    override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
  }

  private data class CachedEngine(
    val engine: JsSourceEngine,
    val installedAtMillis: Long,
  )

  public companion object {
    public const val SOURCE_PREFIX: String = "jdr:"
  }
}
