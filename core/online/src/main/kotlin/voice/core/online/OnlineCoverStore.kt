package voice.core.online

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import voice.core.logging.api.Logger
import java.io.File

/**
 * Persists the cover of every online book as a local file, so the shelf, the
 * player and the media notification load it from disk instead of re-fetching
 * the remote url whenever Coil's shared image cache has evicted it - which
 * showed up as covers that intermittently stayed blank for seconds after the
 * app start. Files under filesDir also survive what clears the cache dir.
 *
 * The file name is a hash of the book key; the bytes are stored as delivered
 * (jpg/png/webp/gif) and decoders sniff the content, so no extension bookkeeping.
 */
public class OnlineCoverStore(private val baseDir: File) {

  private val mutex = Mutex()

  /** The stored cover of [key], or null when there is none (yet). */
  public suspend fun file(key: String): File? {
    return withContext(Dispatchers.IO) {
      path(key).takeIf(File::isFile)
    }
  }

  /**
   * Stores [bytes] as the cover of [key], replacing any previous file.
   * Returns the stored file, or null for empty bytes.
   */
  public suspend fun write(
    key: String,
    bytes: ByteArray,
  ): File? {
    if (bytes.isEmpty()) return null
    return mutex.withLock {
      withContext(Dispatchers.IO) {
        val target = path(key)
        target.parentFile?.mkdirs()
        val tmp = File(target.parentFile, target.name + ".tmp")
        try {
          tmp.writeBytes(bytes)
          // the leftover target makes renameTo fail on some file systems
          if (!tmp.renameTo(target)) {
            target.delete()
            check(tmp.renameTo(target)) { "Could not replace $target with $tmp" }
          }
        } catch (e: Exception) {
          tmp.delete()
          throw e
        }
        target
      }.also {
        Logger.i("Stored the online cover of $key")
      }
    }
  }

  /** Removes the stored cover of [key]; a no-op when there is none. */
  public suspend fun remove(key: String) {
    mutex.withLock {
      withContext(Dispatchers.IO) {
        path(key).delete()
      }
    }
  }

  private fun path(key: String): File = File(baseDir, hashedFileName(key) + ".img")

  public companion object {

    /** Distinct from the other online stores sharing filesDir. */
    public const val COVERS_DIR: String = "online_covers"
  }
}
