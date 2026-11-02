package voice.core.playback.pim

import kotlin.reflect.KClass

/**
 * 网格插槽微内核（纯业务版，与 web/src/pim/kernel.ts 同构）。
 *
 * 一张网格就是 `(业务状态, 业务事件) -> 业务状态` 的全函数。格子只返回新快照，
 * 不返回任何指令：要播放、要落库、要发通知，都是平台外壳看完快照差分后自己的事。
 */

/** 上下文自带状态，格子无法报出与状态不符的结果。 */
interface Stateful<S> {
  val state: S
}

/** 每个业务事件都自报家门，用于轨迹记录与完整性检查。 */
interface TypedEvent {
  val type: String
}

class MissingCellException(state: Any?, event: KClass<*>) :
  IllegalStateException("网格缺少格子：state=$state event=${event.simpleName}")

/** 一张完整的表：状态 × 事件类型 → 格子。 */
class GridTable<S : Any, C : Stateful<S>, E : TypedEvent>(
  val states: List<S>,
  val eventTypes: List<KClass<out E>>,
  val cells: Map<Pair<S, KClass<out E>>, (C, E) -> C>,
)

/** 走一格。缺格子是编程错误，绝不静默放行。 */
fun <S : Any, C : Stateful<S>, E : TypedEvent> GridTable<S, C, E>.step(ctx: C, event: E): C {
  val cell = cells[ctx.state to event::class]
    ?: throw MissingCellException(ctx.state, event::class)
  return cell(ctx, event)
}

fun <S : Any, C : Stateful<S>, E : TypedEvent> GridTable<S, C, E>.missingCells(): List<Pair<S, KClass<out E>>> =
  states.flatMap { state ->
    eventTypes.filter { type -> cells[state to type] == null }.map { type -> state to type }
  }

fun <S : Any, C : Stateful<S>, E : TypedEvent> GridTable<S, C, E>.assertComplete() {
  val missing = missingCells()
  check(missing.isEmpty()) {
    val first = missing.first()
    "网格不完备：${missing.size} 个空格子，例如 (${first.first}, ${first.second.simpleName})"
  }
}

/** 每一步都必须成立的性质；返回非空字符串即为违例。 */
class Invariant<S : Any, C : Stateful<S>, E : TypedEvent>(
  val id: String,
  val check: (from: S, event: E, before: C, after: C) -> String?,
)

data class Violation(val invariant: String, val trace: List<String>, val detail: String)

data class ModelCheckReport<S>(
  val explored: Int,
  val transitions: Int,
  val reachableStates: List<S>,
  val violations: List<Violation>,
)

/**
 * 广度优先穷举可达的业务状态图。听众一年的古怪交错（暂停、睡眠香、章尾、
 * 点书签）在这里变成几千次内存跳转，毫秒级跑完。
 */
fun <S : Any, C : Stateful<S>, E : TypedEvent> GridTable<S, C, E>.modelCheck(
  initial: C,
  events: List<E>,
  keyOf: (C) -> String,
  invariants: List<Invariant<S, C, E>>,
  maxStates: Int = 20000,
  maxTrace: Int = 12,
  maxViolations: Int = 5,
): ModelCheckReport<S> {
  val seen = HashSet<String>().apply { add(keyOf(initial)) }
  val queue = ArrayDeque<Pair<C, List<String>>>()
  queue.add(initial to emptyList())
  val reachable = HashSet<S>().apply { add(initial.state) }
  val violations = mutableListOf<Violation>()
  var transitions = 0

  while (queue.isNotEmpty()) {
    val (ctx, trace) = queue.removeFirst()
    for (event in events) {
      val after = step(ctx, event)
      transitions += 1
      reachable.add(after.state)
      val nextTrace = trace + event.type

      for (invariant in invariants) {
        if (violations.count { it.invariant == invariant.id } >= maxViolations) continue
        val detail = invariant.check(ctx.state, event, ctx, after)
        if (detail != null) violations.add(Violation(invariant.id, nextTrace, detail))
      }

      if (trace.size >= maxTrace) continue
      val key = keyOf(after)
      if (!seen.add(key)) continue
      if (seen.size > maxStates) continue
      queue.add(after to nextTrace)
    }
  }

  return ModelCheckReport(
    explored = seen.size,
    transitions = transitions,
    reachableStates = reachable.sortedBy { it.toString() },
    violations = violations,
  )
}
