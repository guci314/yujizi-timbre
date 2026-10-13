package voice.features.bookOverview.onlineActions

import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateOf
import dev.zacsweers.metro.ContributesIntoSet
import dev.zacsweers.metro.SingleIn
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch
import voice.core.common.DispatcherProvider
import voice.core.common.MainScope
import voice.core.data.BookId
import voice.core.online.OnlineBookCacheManager
import voice.core.online.OnlineCacheState
import voice.core.online.OnlineCachedInfo
import voice.core.online.OnlineChapterRefreshResult
import voice.core.online.OnlineDiagnostics
import voice.core.online.OnlinePlaybackCatalog
import voice.features.bookOverview.bottomSheet.BottomSheetItem
import voice.features.bookOverview.bottomSheet.BottomSheetItemViewModel
import voice.features.bookOverview.di.BookOverviewScope

internal sealed interface OnlineRefreshUiState {
  val bookId: BookId

  data class Refreshing(override val bookId: BookId) : OnlineRefreshUiState
  data class Result(
    override val bookId: BookId,
    val result: OnlineChapterRefreshResult,
  ) : OnlineRefreshUiState
}

internal data class OnlineCacheDialogState(
  val bookId: BookId,
  val info: OnlineCachedInfo?,
  val selectedCount: Int = DEFAULT_CACHE_COUNT,
  val customCount: String = "",
  val delaySeconds: Int = DEFAULT_CACHE_DELAY_SECONDS,
  val customDelay: String = "",
  val clearArmed: Boolean = false,
  val loading: Boolean = true,
)

/**
 * 「清除缓存」菜单项的确认状态。
 *
 * 清除是不可逆的（删掉已下载的音频文件），所以从菜单直接点进来时先问一句，
 * 并告诉用户会删掉多少 —— 而不是像缓存对话框里那样「再点一次」就算确认。
 */
internal data class OnlineClearCacheDialogState(
  val bookId: BookId,
  val cachedCount: Int = 0,
  val cachedBytes: Long = 0L,
  val loading: Boolean = true,
)

/**
 * 「播放诊断」的状态：把源解析 / 取流 / 缓存校验每一步的耗时与异常摆出来。
 * 真机上的静默失败（不报错但不动）只能靠这个定位。
 */
internal data class OnlineDiagnosticsUiState(
  val bookId: BookId,
  val loading: Boolean = true,
  val report: String = "",
)

@SingleIn(BookOverviewScope::class)
@ContributesIntoSet(BookOverviewScope::class)
class OnlineBookActionsViewModel(
  private val catalog: OnlinePlaybackCatalog,
  private val cacheManager: OnlineBookCacheManager,
  private val diagnostics: OnlineDiagnostics,
  dispatcherProvider: DispatcherProvider,
) : BottomSheetItemViewModel {

  private val scope = MainScope(dispatcherProvider)

  private val _refreshState = mutableStateOf<OnlineRefreshUiState?>(null)
  internal val refreshState: State<OnlineRefreshUiState?> get() = _refreshState

  private val _cacheDialog = mutableStateOf<OnlineCacheDialogState?>(null)
  internal val cacheDialog: State<OnlineCacheDialogState?> get() = _cacheDialog

  private val _clearCacheDialog = mutableStateOf<OnlineClearCacheDialogState?>(null)
  internal val clearCacheDialog: State<OnlineClearCacheDialogState?> get() = _clearCacheDialog

  private val _diagnosticsState = mutableStateOf<OnlineDiagnosticsUiState?>(null)
  internal val diagnosticsState: State<OnlineDiagnosticsUiState?> get() = _diagnosticsState

  override suspend fun items(bookId: BookId): List<BottomSheetItem> {
    if (!catalog.isOnlineBookId(bookId)) return emptyList()
    return listOf(
      BottomSheetItem.OnlineRefreshChapters,
      BottomSheetItem.OnlineCacheBook,
      BottomSheetItem.OnlineClearCache,
      BottomSheetItem.OnlineDiagnose,
    )
  }

  override suspend fun onItemClick(
    bookId: BookId,
    item: BottomSheetItem,
  ) {
    when (item) {
      BottomSheetItem.OnlineRefreshChapters -> refreshChapters(bookId)
      BottomSheetItem.OnlineCacheBook -> openCacheDialog(bookId)
      BottomSheetItem.OnlineClearCache -> openClearCacheDialog(bookId)
      BottomSheetItem.OnlineDiagnose -> runDiagnostics(bookId)
      else -> return
    }
  }

  internal fun cacheProgress(bookUri: String): Flow<OnlineCacheState?> {
    return cacheManager.stateFor(bookUri)
  }

  private fun refreshChapters(bookId: BookId) {
    _refreshState.value = OnlineRefreshUiState.Refreshing(bookId)
    scope.launch {
      val result = catalog.refreshChapters(bookId)
      // the dialog may have been dismissed while the source answered: only
      // report when it is still waiting for this book
      val current = _refreshState.value
      if (current is OnlineRefreshUiState.Refreshing && current.bookId == bookId) {
        _refreshState.value = OnlineRefreshUiState.Result(bookId, result)
      }
    }
  }

  internal fun onDismissRefresh() {
    _refreshState.value = null
  }

  private fun openCacheDialog(bookId: BookId) {
    _cacheDialog.value = OnlineCacheDialogState(bookId = bookId, info = null, loading = true)
    reloadCacheInfo(bookId)
  }

  internal fun reloadCacheInfo(bookId: BookId) {
    scope.launch {
      val info = runCatching { cacheManager.cachedInfo(bookId) }.getOrNull()
      val current = _cacheDialog.value
      if (current != null && current.bookId == bookId) {
        _cacheDialog.value = current.copy(info = info, loading = false, clearArmed = false)
      }
    }
  }

  internal fun onDismissCache() {
    _cacheDialog.value = null
  }

  internal fun onSelectCount(count: Int) {
    val current = _cacheDialog.value ?: return
    _cacheDialog.value = current.copy(selectedCount = count, customCount = "")
  }

  internal fun onCustomCountChange(text: String) {
    val current = _cacheDialog.value ?: return
    _cacheDialog.value = current.copy(customCount = text.filter { it.isDigit() }.take(5))
  }

  internal fun onSelectDelay(seconds: Int) {
    val current = _cacheDialog.value ?: return
    _cacheDialog.value = current.copy(delaySeconds = seconds, customDelay = "")
  }

  internal fun onCustomDelayChange(text: String) {
    val current = _cacheDialog.value ?: return
    _cacheDialog.value = current.copy(customDelay = text.filter { it.isDigit() }.take(3))
  }

  internal fun onStartCache() {
    val current = _cacheDialog.value ?: return
    val info = current.info
    val remaining = if (info == null || info.totalChapters <= 0) {
      Int.MAX_VALUE
    } else {
      (info.totalChapters - info.currentIndex).coerceAtLeast(1)
    }
    val count = current.customCount.toIntOrNull()
      ?.takeIf { it > 0 }
      ?: current.selectedCount
    val delaySeconds = current.customDelay.toIntOrNull() ?: current.delaySeconds
    // a new job must not inherit an armed clear of the previous one
    _cacheDialog.value = current.copy(clearArmed = false)
    // the manager publishes the running job before its first network call, so
    // the sheet shows its progress bar right away
    cacheManager.cacheUpcoming(current.bookId, count.coerceAtMost(remaining), delaySeconds)
  }

  internal fun onCancelCache() {
    val current = _cacheDialog.value ?: return
    cacheManager.cancel(current.bookId)
    reloadCacheInfo(current.bookId)
  }

  /**
   * Two taps: the first arms the button, the second clears. Clearing only
   * drops the downloaded files; the book and its progress stay on the shelf.
   */
  internal fun onClearCache() {
    val current = _cacheDialog.value ?: return
    if (!current.clearArmed) {
      _cacheDialog.value = current.copy(clearArmed = true)
      return
    }
    scope.launch {
      val _ = runCatching { cacheManager.clearBook(current.bookId) }
      reloadCacheInfo(current.bookId)
    }
  }

  /**
   * 「清除缓存」菜单项：先读这本书缓存了多少，再弹一次正经确认。
   * （缓存对话框里那个是「再点一次」就地确认；从菜单直接点进来没有上下文，
   * 所以这里把要删的集数与体积摆出来。）
   */
  private fun openClearCacheDialog(bookId: BookId) {
    _clearCacheDialog.value = OnlineClearCacheDialogState(bookId = bookId, loading = true)
    scope.launch {
      val info = runCatching { cacheManager.cachedInfo(bookId) }.getOrNull()
      val current = _clearCacheDialog.value
      if (current != null && current.bookId == bookId) {
        _clearCacheDialog.value = current.copy(
          cachedCount = info?.cachedCount ?: 0,
          cachedBytes = info?.cachedBytes ?: 0L,
          loading = false,
        )
      }
    }
  }

  /** [cacheManager.clearBook] 会先停掉这本书正在跑的缓存任务。 */
  internal fun onConfirmClearCache() {
    val current = _clearCacheDialog.value ?: return
    _clearCacheDialog.value = null
    scope.launch {
      val _ = runCatching { cacheManager.clearBook(current.bookId) }
    }
  }

  internal fun onDismissClearCache() {
    _clearCacheDialog.value = null
  }

  private fun runDiagnostics(bookId: BookId) {
    _diagnosticsState.value = OnlineDiagnosticsUiState(bookId = bookId, loading = true)
    scope.launch {
      val report = runCatching { diagnostics.report(bookId) }
        .getOrElse { "诊断本身出错：${it::class.java.simpleName}: ${it.message}" }
      val current = _diagnosticsState.value
      if (current != null && current.bookId == bookId) {
        _diagnosticsState.value = current.copy(loading = false, report = report)
      }
    }
  }

  internal fun onDismissDiagnostics() {
    _diagnosticsState.value = null
  }
}

internal const val DEFAULT_CACHE_COUNT = 100

internal val CACHE_COUNT_PRESETS = listOf(50, 100, 200, 500)

/** 0 = no delay (chapters back to back, the original behavior). */
internal const val DEFAULT_CACHE_DELAY_SECONDS = 0

internal val CACHE_DELAY_PRESETS = listOf(0, 2, 5, 10)
