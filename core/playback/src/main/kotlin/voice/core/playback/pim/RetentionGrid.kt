package voice.core.playback.pim

import kotlin.reflect.KClass

/**
 * RetentionGrid：4 状态 × 5 事件 = 20 格，与 web/src/pim/retention-grid.ts 同构。
 *
 * 一条铁律贯穿全表：只有「验明完好」才能入箧；未入箧、留存中、未果，占用的
 * 书箧空间必须恒为零。释出是一步归零，迟到的进度与完好都不敢再言。
 */

private typealias RetentionCell = (RetentionContext, RetentionEvent) -> RetentionContext

private fun ignore(): RetentionCell = { ctx, _ -> ctx }

private inline fun <reified T : RetentionEvent> on(
  noinline body: (RetentionContext, T) -> RetentionContext,
): RetentionCell = { ctx, event -> body(ctx, event as T) }

private fun cell(
  state: RetentionState,
  type: KClass<out RetentionEvent>,
  body: RetentionCell,
): Pair<Pair<RetentionState, KClass<out RetentionEvent>>, RetentionCell> = (state to type) to body

/** 未入箧、已释放、留存未果的共同形态：不占空间、没有进度、没有理由。 */
private fun empty(ctx: RetentionContext): RetentionContext = ctx.copy(
  state = RetentionState.D0_NOT_KEPT,
  progressPct = 0,
  occupiedSpace = 0L,
  failReason = null,
)

val RETENTION_STATES: List<RetentionState> = RetentionState.entries

val RETENTION_EVENT_TYPES: List<KClass<out RetentionEvent>> = listOf(
  RetentionEvent.RequestKeep::class,
  RetentionEvent.KeepProgress::class,
  RetentionEvent.VerifiedComplete::class,
  RetentionEvent.KeepFailed::class,
  RetentionEvent.Release::class,
)

val RETENTION_GRID: GridTable<RetentionState, RetentionContext, RetentionEvent> = GridTable(
  states = RETENTION_STATES,
  eventTypes = RETENTION_EVENT_TYPES,
  cells = mapOf(
    // ---- D0_未留存 ----
    cell(RetentionState.D0_NOT_KEPT, RetentionEvent.RequestKeep::class, on<RetentionEvent.RequestKeep> { ctx, _ ->
      ctx.copy(state = RetentionState.D1_KEEPING, progressPct = 0, occupiedSpace = 0L, failReason = null)
    }),
    cell(RetentionState.D0_NOT_KEPT, RetentionEvent.KeepProgress::class, ignore()),
    // 没有请求过的留存，迟到的「完好」不进箧。
    cell(RetentionState.D0_NOT_KEPT, RetentionEvent.VerifiedComplete::class, ignore()),
    cell(RetentionState.D0_NOT_KEPT, RetentionEvent.KeepFailed::class, ignore()),
    cell(RetentionState.D0_NOT_KEPT, RetentionEvent.Release::class, ignore()),

    // ---- D1_留存中 ----
    // 防重复连点。
    cell(RetentionState.D1_KEEPING, RetentionEvent.RequestKeep::class, ignore()),
    cell(RetentionState.D1_KEEPING, RetentionEvent.KeepProgress::class, on<RetentionEvent.KeepProgress> { ctx, e ->
      ctx.copy(progressPct = e.pct.coerceIn(0, 100))
    }),
    cell(RetentionState.D1_KEEPING, RetentionEvent.VerifiedComplete::class, on<RetentionEvent.VerifiedComplete> { ctx, e ->
      // 空的篇章不算留存；宁可留在留存中，也不能记成已入箧。
      if (e.space <= 0L) {
        ctx
      } else {
        ctx.copy(
          state = RetentionState.D2_KEPT,
          progressPct = 100,
          occupiedSpace = e.space,
          failReason = null,
        )
      }
    }),
    cell(RetentionState.D1_KEEPING, RetentionEvent.KeepFailed::class, on<RetentionEvent.KeepFailed> { ctx, e ->
      ctx.copy(
        state = RetentionState.D3_FAILED,
        progressPct = 0,
        occupiedSpace = 0L,
        failReason = e.reason,
      )
    }),
    cell(RetentionState.D1_KEEPING, RetentionEvent.Release::class, on<RetentionEvent.Release> { ctx, _ -> empty(ctx) }),

    // ---- D2_已留存 ----
    cell(RetentionState.D2_KEPT, RetentionEvent.RequestKeep::class, ignore()),
    cell(RetentionState.D2_KEPT, RetentionEvent.KeepProgress::class, ignore()),
    cell(RetentionState.D2_KEPT, RetentionEvent.VerifiedComplete::class, ignore()),
    cell(RetentionState.D2_KEPT, RetentionEvent.KeepFailed::class, ignore()),
    cell(RetentionState.D2_KEPT, RetentionEvent.Release::class, on<RetentionEvent.Release> { ctx, _ -> empty(ctx) }),

    // ---- D3_留存未果 ----
    cell(RetentionState.D3_FAILED, RetentionEvent.RequestKeep::class, on<RetentionEvent.RequestKeep> { ctx, _ ->
      ctx.copy(state = RetentionState.D1_KEEPING, progressPct = 0, occupiedSpace = 0L, failReason = null)
    }),
    cell(RetentionState.D3_FAILED, RetentionEvent.KeepProgress::class, ignore()),
    // 已判未果，迟到的「完好」绝不静默入箧。
    cell(RetentionState.D3_FAILED, RetentionEvent.VerifiedComplete::class, ignore()),
    cell(RetentionState.D3_FAILED, RetentionEvent.KeepFailed::class, on<RetentionEvent.KeepFailed> { ctx, e ->
      ctx.copy(failReason = e.reason)
    }),
    cell(RetentionState.D3_FAILED, RetentionEvent.Release::class, on<RetentionEvent.Release> { ctx, _ -> empty(ctx) }),
  ),
)

val RETENTION_CELL_COUNT: Int get() = RETENTION_STATES.size * RETENTION_EVENT_TYPES.size
