/**
 * A sleep-timer choice offered to the listener.
 *
 * `end-of-chapter` stops when the current chapter finishes instead of at a
 * fixed moment; it is the gentlest way to fall asleep mid-recitation.
 */
export interface SleepTimerOption {
  kind: 'minutes' | 'end-of-chapter'
  /** Minutes until the timer stops; 0 for `end-of-chapter`. */
  minutes: number
  label: string
}

/** The choices the player offers, in the order they are shown. */
export const SLEEP_TIMER_OPTIONS: SleepTimerOption[] = [
  { kind: 'minutes', minutes: 5, label: '5 分钟' },
  { kind: 'minutes', minutes: 10, label: '10 分钟' },
  { kind: 'minutes', minutes: 15, label: '15 分钟' },
  { kind: 'minutes', minutes: 30, label: '30 分钟' },
  { kind: 'minutes', minutes: 45, label: '45 分钟' },
  { kind: 'minutes', minutes: 60, label: '60 分钟' },
  { kind: 'end-of-chapter', minutes: 0, label: '本章结束' },
]

/**
 * Seconds left until a sleep-timer deadline.
 *
 * Returns 0 once the deadline has passed, so a caller can treat "not due" and
 * "due now" the same way.
 */
export function sleepRemainingSeconds(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000))
}
