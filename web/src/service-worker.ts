/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'
import { CacheableResponsePlugin } from 'workbox-cacheable-response'
import { RangeRequestsPlugin } from 'workbox-range-requests'
import { AUDIO_CACHE } from './core/audio-cache'

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> }

const AUDIO_EXTENSIONS = /\.(m4a|mp3|aac|flac|ogg|opus)$/i

// The UI shell is precached so the app opens offline.
precacheAndRoute(self.__WB_MANIFEST)

/**
 * Serve downloaded audio from the cache, falling back to the network.
 *
 * Two details make media different from ordinary assets:
 *
 * - Playback asks for byte ranges. Without `RangeRequestsPlugin` a cached
 *   response cannot answer a `Range` request and seeking breaks.
 * - Playback never fills the cache by itself, because a streaming request
 *   yields 206 responses. Only the explicit download in `core/downloads.ts`
 *   fetches a full 200 body, which is the one thing cached here.
 */
registerRoute(
  ({ request, url }) => request.destination === 'audio' || AUDIO_EXTENSIONS.test(url.pathname),
  new CacheFirst({
    cacheName: AUDIO_CACHE,
    plugins: [
      new CacheableResponsePlugin({ statuses: [200] }),
      new RangeRequestsPlugin(),
    ],
  }),
)

/**
 * Let the page drop a download and know it happened.
 * Only the audio cache is exposed; the shell cache stays the SW's business.
 */
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data as { type?: string; url?: string; urls?: string[] } | undefined
  if (data?.type !== 'delete-audio') return
  const targets = data.urls ?? (data.url === undefined ? [] : [data.url])
  event.waitUntil(
    caches.open(AUDIO_CACHE).then(async (cache) => {
      await Promise.all(targets.map((target) => cache.delete(target)))
      event.source instanceof Client && event.source.postMessage({ type: 'audio-deleted', urls: targets })
    }),
  )
})
