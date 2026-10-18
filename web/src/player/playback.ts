import type { BookDetail } from '../core/domain'

/** Playback speeds offered in the player, matching the Android app's spirit. */
export const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 1.75, 2] as const

/** How often progress is written while playing, in milliseconds. */
export const PROGRESS_SAVE_INTERVAL_MS = 5_000

/** Seconds rewound when resuming, so the listener regains context. */
export const RESUME_REWIND_SECONDS = 3

/** Clamp a resume position into the track, rewinding slightly. */
export function resumePosition(savedSeconds: number, duration: number): number {
  if (!Number.isFinite(savedSeconds) || savedSeconds <= 0) return 0
  const rewound = Math.max(0, savedSeconds - RESUME_REWIND_SECONDS)
  if (!Number.isFinite(duration) || duration <= 0) return rewound
  return Math.min(rewound, Math.max(0, duration - 1))
}

/** `mm:ss`, or `h:mm:ss` past an hour. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

/** The next track index, or undefined at the end of the book. */
export function nextIndex(current: number, total: number): number | undefined {
  const candidate = current + 1
  return candidate < total ? candidate : undefined
}

/** The previous track index, or undefined at the start. */
export function previousIndex(current: number): number | undefined {
  return current > 0 ? current - 1 : undefined
}

/**
 * A track label for the OS media notification.
 * Falls back to the book title when the chapter has no name.
 */
export function nowPlayingTitle(book: BookDetail, trackIndex: number): string {
  return book.tracks[trackIndex]?.name ?? book.title
}
