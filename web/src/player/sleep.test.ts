import { describe, expect, it } from 'vitest'
import { sleepRemainingSeconds, SLEEP_TIMER_OPTIONS } from './sleep'

describe('sleepRemainingSeconds', () => {
  it('reports the seconds left until the deadline', () => {
    const deadline = 1_000_000
    expect(sleepRemainingSeconds(deadline, deadline - 15 * 60_000)).toBe(15 * 60)
  })

  it('reports zero once the deadline has passed', () => {
    expect(sleepRemainingSeconds(1_000, 2_000)).toBe(0)
  })
})

describe('SLEEP_TIMER_OPTIONS', () => {
  it('offers the usual listening durations in minutes', () => {
    const minutes = SLEEP_TIMER_OPTIONS.filter((option) => option.kind === 'minutes').map(
      (option) => option.minutes,
    )
    expect(minutes).toEqual([5, 10, 15, 30, 45, 60])
  })

  it('ends the current chapter instead of a fixed moment', () => {
    expect(SLEEP_TIMER_OPTIONS.some((option) => option.kind === 'end-of-chapter')).toBe(true)
  })
})
