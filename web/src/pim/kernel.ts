/**
 * Grid-Slot microkernel, business-only edition.
 *
 * A grid is a total function `(business state, business event) -> business
 * state`. Cells return the next snapshot and nothing else: no effects, no
 * platform instructions. Everything a machine must physically do is derived by
 * the platform shell from the difference between two snapshots.
 *
 * That constraint is what lets a 52-cell model be replayed identically in
 * TypeScript, Kotlin, or on paper.
 */

/** Contexts always carry their own state, so a cell cannot report a mismatch. */
export interface Stateful<S extends string> {
  readonly state: S
}

export type Cell<C, E extends { type: string }> = (ctx: C, event: E) => C

/** A cell may be absent in the literal; the completeness audit finds it. */
export type GridCells<S extends string, C, E extends { type: string }> = {
  readonly [K in S]: { readonly [T in E['type']]?: Cell<C, E> }
}

export interface Grid<S extends string, C extends Stateful<S>, E extends { type: string }> {
  readonly states: readonly S[]
  readonly events: readonly E['type'][]
  readonly cells: GridCells<S, C, E>
}

export class MissingCellError extends Error {
  constructor(state: string, event: string) {
    super(`网格缺少格子：state=${state} event=${event}`)
    this.name = 'MissingCellError'
  }
}

/**
 * Apply one event. An undefined cell is a programming error, never a silent
 * no-op: silent no-ops are exactly how implicit state machines rot.
 */
export function step<S extends string, C extends Stateful<S>, E extends { type: string }>(
  grid: Grid<S, C, E>,
  ctx: C,
  event: E,
): C {
  const cells = grid.cells[ctx.state] as Record<string, Cell<C, E> | undefined>
  const cell = cells[event.type]
  if (cell === undefined) throw new MissingCellError(ctx.state, event.type)
  return cell(ctx, event)
}

/** Every (state, event) pair the grid fails to define. */
export function missingCells<S extends string, C extends Stateful<S>, E extends { type: string }>(
  grid: Grid<S, C, E>,
): Array<{ state: S; event: E['type'] }> {
  const missing: Array<{ state: S; event: E['type'] }> = []
  for (const state of grid.states) {
    for (const event of grid.events) {
      if (grid.cells[state][event] === undefined) missing.push({ state, event })
    }
  }
  return missing
}

export function assertComplete<S extends string, C extends Stateful<S>, E extends { type: string }>(
  grid: Grid<S, C, E>,
): void {
  const missing = missingCells(grid)
  if (missing.length > 0) {
    const first = missing[0]
    throw new Error(`网格不完备：${missing.length} 个空格子，例如 (${first.state}, ${first.event})`)
  }
}

/** A property every transition must satisfy. Return a message to fail. */
export interface Invariant<S extends string, C extends Stateful<S>, E extends { type: string }> {
  readonly id: string
  check(input: { readonly from: S; readonly event: E; readonly before: C; readonly after: C }): string | undefined
}

export interface Violation {
  readonly invariant: string
  readonly trace: readonly string[]
  readonly detail: string
}

export interface ModelCheckOptions<S extends string, C extends Stateful<S>, E extends { type: string }> {
  readonly initial: C
  /** The finite event alphabet. Numeric payloads are sampled, not continuous. */
  readonly events: readonly E[]
  /** Buckets contexts so the walk terminates. Must distinguish every field an invariant reads. */
  readonly keyOf: (ctx: C) => string
  readonly invariants: readonly Invariant<S, C, E>[]
  readonly maxStates?: number
  readonly maxTrace?: number
  readonly maxViolations?: number
}

export interface ModelCheckReport<S extends string> {
  readonly explored: number
  readonly transitions: number
  readonly reachableStates: readonly S[]
  readonly violations: readonly Violation[]
}

/**
 * Breadth-first walk over the reachable business-state graph.
 *
 * A listener's year of odd interleavings (pause, sleep timer, chapter end,
 * bookmark hop) becomes a few thousand in-memory transitions that run in
 * milliseconds.
 */
export function modelCheck<S extends string, C extends Stateful<S>, E extends { type: string }>(
  grid: Grid<S, C, E>,
  options: ModelCheckOptions<S, C, E>,
): ModelCheckReport<S> {
  const maxStates = options.maxStates ?? 20000
  const maxTrace = options.maxTrace ?? 12
  const maxViolations = options.maxViolations ?? 5

  const seen = new Set<string>([options.keyOf(options.initial)])
  const queue: Array<{ ctx: C; trace: string[] }> = [{ ctx: options.initial, trace: [] }]
  const reachable = new Set<S>([options.initial.state])
  const violations: Violation[] = []
  let transitions = 0

  while (queue.length > 0) {
    const node = queue.shift() as { ctx: C; trace: string[] }
    for (const event of options.events) {
      const after = step(grid, node.ctx, event)
      transitions += 1
      reachable.add(after.state)
      const trace = [...node.trace, event.type]

      for (const invariant of options.invariants) {
        if (violations.filter((entry) => entry.invariant === invariant.id).length >= maxViolations) continue
        const detail = invariant.check({ from: node.ctx.state, event, before: node.ctx, after })
        if (detail !== undefined) violations.push({ invariant: invariant.id, trace, detail })
      }

      if (node.trace.length >= maxTrace) continue
      const key = options.keyOf(after)
      if (seen.has(key)) continue
      seen.add(key)
      if (seen.size > maxStates) continue
      queue.push({ ctx: after, trace })
    }
  }

  return {
    explored: seen.size,
    transitions,
    reachableStates: [...reachable].sort(),
    violations,
  }
}
