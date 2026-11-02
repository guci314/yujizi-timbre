/**
 * Grid-Slot microkernel.
 *
 * A grid is a total function `(state, event) -> (state, effects)`: every state
 * has an explicit cell for every event, and a cell has no ambient access to the
 * browser. That total-ness is what lets the model checker below walk the graph
 * in memory and prove properties no amount of manual iPad testing could.
 */

/** A declarative instruction the platform shell must carry out. */
export interface Effect {
  readonly type: string
}

/** Contexts always carry their own state, so a cell cannot report a mismatch. */
export interface Stateful<S extends string> {
  readonly state: S
}

export interface StepResult<C, F extends Effect> {
  readonly ctx: C
  readonly effects: readonly F[]
}

export type Cell<C, E extends { type: string }, F extends Effect> = (ctx: C, event: E) => StepResult<C, F>

/** A cell may be absent in the literal; the completeness audit finds it. */
export type GridCells<S extends string, C, E extends { type: string }, F extends Effect> = {
  readonly [K in S]: { readonly [T in E['type']]?: Cell<C, E, F> }
}

export interface Grid<S extends string, C, E extends { type: string }, F extends Effect> {
  readonly states: readonly S[]
  readonly events: readonly E['type'][]
  readonly cells: GridCells<S, C, E, F>
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
export function step<S extends string, C extends Stateful<S>, E extends { type: string }, F extends Effect>(
  grid: Grid<S, C, E, F>,
  ctx: C,
  event: E,
): StepResult<C, F> {
  const cells = grid.cells[ctx.state] as Record<string, Cell<C, E, F> | undefined>
  const cell = cells[event.type]
  if (cell === undefined) throw new MissingCellError(ctx.state, event.type)
  return cell(ctx, event)
}

/** Every (state, event) pair the grid fails to define. I1 in one function. */
export function missingCells<S extends string, C, E extends { type: string }, F extends Effect>(
  grid: Grid<S, C, E, F>,
): Array<{ state: S; event: E['type'] }> {
  const missing: Array<{ state: S; event: E['type'] }> = []
  for (const state of grid.states) {
    for (const event of grid.events) {
      if (grid.cells[state][event] === undefined) missing.push({ state, event })
    }
  }
  return missing
}

export function assertComplete<S extends string, C, E extends { type: string }, F extends Effect>(
  grid: Grid<S, C, E, F>,
): void {
  const missing = missingCells(grid)
  if (missing.length > 0) {
    const first = missing[0]
    throw new Error(`网格不完备：${missing.length} 个空格子，例如 (${first.state}, ${first.event})`)
  }
}

/** A property every transition must satisfy. Return a message to fail. */
export interface Invariant<S extends string, C extends Stateful<S>, E extends { type: string }, F extends Effect> {
  readonly id: string
  check(input: {
    readonly from: S
    readonly event: E
    readonly before: C
    readonly after: C
    readonly effects: readonly F[]
  }): string | undefined
}

export interface Violation {
  readonly invariant: string
  readonly trace: readonly string[]
  readonly detail: string
}

export interface ModelCheckOptions<S extends string, C extends Stateful<S>, E extends { type: string }, F extends Effect> {
  readonly initial: C
  /** The finite event alphabet. Numeric payloads should be sampled, not continuous. */
  readonly events: readonly E[]
  /** Buckets contexts so the walk terminates. Must distinguish every field an invariant reads. */
  readonly keyOf: (ctx: C) => string
  readonly invariants: readonly Invariant<S, C, E, F>[]
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
 * Breadth-first walk over the reachable context graph.
 *
 * This is the whole point of the architecture: a listener's year of odd
 * interleavings (pause, sleep timer, late `ended`, network death, bookmark hop)
 * becomes a few thousand in-memory transitions that run in milliseconds.
 */
export function modelCheck<S extends string, C extends Stateful<S>, E extends { type: string }, F extends Effect>(
  grid: Grid<S, C, E, F>,
  options: ModelCheckOptions<S, C, E, F>,
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
      const result = step(grid, node.ctx, event)
      transitions += 1
      reachable.add(result.ctx.state)
      const trace = [...node.trace, event.type]

      for (const invariant of options.invariants) {
        if (violations.filter((entry) => entry.invariant === invariant.id).length >= maxViolations) continue
        const detail = invariant.check({
          from: node.ctx.state,
          event,
          before: node.ctx,
          after: result.ctx,
          effects: result.effects,
        })
        if (detail !== undefined) violations.push({ invariant: invariant.id, trace, detail })
      }

      if (node.trace.length >= maxTrace) continue
      const key = options.keyOf(result.ctx)
      if (seen.has(key)) continue
      seen.add(key)
      if (seen.size > maxStates) continue
      queue.push({ ctx: result.ctx, trace })
    }
  }

  return {
    explored: seen.size,
    transitions,
    reachableStates: [...reachable].sort(),
    violations,
  }
}
