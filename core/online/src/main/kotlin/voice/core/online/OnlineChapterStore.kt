package voice.core.online

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromStream
import kotlinx.serialization.json.encodeToStream
import voice.core.logging.api.Logger
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/** The persisted form of one chapter list: the key travels inside the file, so
 *  [OnlineChapterStore.loadAll] can restore the in-memory map without having to
 *  reverse the hashed file name. */
@Serializable
private data class StoredOnlineChapters(
  val key: String,
  val chapters: List<OnlineChapter>,
)

/**
 * Persists the chapter list of every online book as its own small file under
 * [baseDir], so the shelf store (`onlineBooks`) only carries book metadata.
 *
 * Before this store existed the chapter lists lived inside the shelf JSON: a
 * thousand-chapter book inflated that single file to megabytes, the shelf had
 * to parse all of it before it could show a single card, and every playback
 * position save (once every few seconds while listening) rewrote the whole
 * thing.
 *
 * The file name is a hash of the book key, so any character a source uses in
 * an id is safe on disk. Reads populate an in-memory cache; the [loadedChapters]
 * flow mirrors it so the shelf can merge the lists in as they arrive.
 *
 * Writers serialize through one mutex: [update] and [updateChapterDuration]
 * are read-modify-write cycles that must not lose a concurrent measurement,
 * and two simultaneous writes to the same key would otherwise trample the
 * shared temp file. The mutex is store-wide (not per key) on purpose - the
 * files are small, so a few milliseconds of serialization beat lock churn.
 */
public class OnlineChapterStore(private val baseDir: File) {

  private val json = Json { ignoreUnknownKeys = true }

  private val mutex = Mutex()

  /** Chapter lists read into memory so far, keyed by [OnlineBook.key]. */
  private val cache = ConcurrentHashMap<String, List<OnlineChapter>>()

  private val _loaded = MutableStateFlow<Map<String, List<OnlineChapter>>>(emptyMap())

  /** Chapter lists currently in memory, keyed by [OnlineBook.key]. */
  public val loadedChapters: StateFlow<Map<String, List<OnlineChapter>>> = _loaded

  /**
   * Chapters of [key]: memory first, then the persisted file. A missing or
   * unreadable file yields an empty list without caching the miss, so callers
   * fall through to the source and a later call can retry.
   */
  public suspend fun chapters(key: String): List<OnlineChapter> {
    cache[key]?.let { return it }
    val stored = withContext(Dispatchers.IO) {
      read(file(key))
    }
    if (stored == null || stored.key != key) return emptyList()
    cache[key] = stored.chapters
    publish()
    return stored.chapters
  }

  /** Stores [chapters] for [key], replacing any previous list. */
  public suspend fun put(
    key: String,
    chapters: List<OnlineChapter>,
  ) {
    mutex.withLock {
      putLocked(key, chapters)
    }
  }

  /**
   * Atomic read-modify-write of the stored list of [key]: [transform] runs
   * against the freshest list under the store lock, so a measured duration
   * landing while a refresh or a re-add merges cannot be lost. Returns the
   * list that is stored after the call.
   */
  public suspend fun update(
    key: String,
    transform: (List<OnlineChapter>) -> List<OnlineChapter>,
  ): List<OnlineChapter> {
    return mutex.withLock {
      val current = chapters(key)
      val next = transform(current)
      if (next != current) {
        putLocked(key, next)
      }
      next
    }
  }

  /** Removes the stored list of [key]; a no-op when there is none. */
  public suspend fun remove(key: String) {
    mutex.withLock {
      cache.remove(key)
      publish()
      withContext(Dispatchers.IO) {
        file(key).delete()
      }
    }
  }

  /**
   * Persists a measured duration for one chapter; false when nothing changed.
   * With [overwriteExisting] false (head-probe estimates) a duration the
   * source already reported is never touched - only the player-reported
   * ground truth may overwrite it.
   */
  public suspend fun updateChapterDuration(
    key: String,
    chapterId: String,
    durationSeconds: Int,
    overwriteExisting: Boolean = false,
  ): Boolean {
    var changed = false
    val _ = update(key) { current ->
      current.map { chapter ->
        val target = chapter.id == chapterId &&
          (overwriteExisting || chapter.durationSeconds <= 0)
        if (target && chapter.durationSeconds != durationSeconds) {
          changed = true
          chapter.copy(durationSeconds = durationSeconds)
        } else {
          chapter
        }
      }
    }
    return changed
  }

  /**
   * Reads every stored chapter list into memory. Called once at app start, so
   * the shelf merges the lists without a per-book file read while a card is
   * already on screen. Keys already in memory keep their (fresher) value: a
   * concurrent write must not be rolled back by the warm-up.
   */
  public suspend fun loadAll() {
    val stored = withContext(Dispatchers.IO) {
      baseDir.listFiles()
        ?.filter { it.isFile && it.extension == "json" }
        ?.mapNotNull { file -> read(file) }
        .orEmpty()
    }
    stored.forEach { entry -> cache.putIfAbsent(entry.key, entry.chapters) }
    publish()
  }

  @OptIn(ExperimentalSerializationApi::class)
  private suspend fun putLocked(
    key: String,
    chapters: List<OnlineChapter>,
  ) {
    withContext(Dispatchers.IO) {
      val target = file(key)
      target.parentFile?.mkdirs()
      val tmp = File(target.parentFile, target.name + ".tmp")
      try {
        tmp.outputStream().use { out ->
          json.encodeToStream(StoredOnlineChapters.serializer(), StoredOnlineChapters(key, chapters), out)
        }
        // the leftover target makes renameTo fail on some file systems
        if (!tmp.renameTo(target)) {
          target.delete()
          check(tmp.renameTo(target)) { "Could not replace $target with $tmp" }
        }
      } catch (e: Exception) {
        tmp.delete()
        throw e
      }
    }
    cache[key] = chapters
    publish()
  }

  @OptIn(ExperimentalSerializationApi::class)
  private fun read(file: File): StoredOnlineChapters? {
    return runCatching {
      file.takeIf(File::isFile)?.let {
        it.inputStream().use { input ->
          json.decodeFromStream(StoredOnlineChapters.serializer(), input)
        }
      }
    }.onFailure { Logger.w("Could not read the stored chapter list ${file.name}: $it") }
      .getOrNull()
  }

  private fun file(key: String): File = File(baseDir, hashedFileName(key) + ".json")

  private fun publish() {
    _loaded.value = cache.toMap()
  }

  public companion object {

    /** Distinct from [OnlineChapterFileCache.CACHE_DIR], which holds audio files. */
    public const val CHAPTER_LISTS_DIR: String = "online_chapter_lists"
  }
}
