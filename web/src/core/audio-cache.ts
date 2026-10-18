/**
 * Name of the Cache Storage bucket holding downloaded audio.
 *
 * Shared by the page (which writes downloads into it) and the service worker
 * (which serves them back). Kept in its own module so the service worker can
 * import the name without pulling in page-only code.
 */
export const AUDIO_CACHE = 'timbre-audio'
