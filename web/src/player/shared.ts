import type { PlayerState } from './usePlayer'
import { usePlayer } from './usePlayer'

/**
 * One player for the whole app: the audio element must survive route changes
 * so playback continues while the listener browses the shelf.
 */
let shared: PlayerState | undefined

export function player(): PlayerState {
  shared ??= usePlayer()
  return shared
}
