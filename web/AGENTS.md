# AGENTS.md — web/

Nested contract for the browser client. The root `AGENTS.md` still applies; this file only adds what is
specific to this subtree.

## Scope

- This tree is a standalone Vue 3 + Vite + TypeScript PWA that plays the audio published on `www.yujizi.org`.
- It is not wired into the Gradle build. `./gradlew` never touches `web/`, and `web/` never imports Kotlin code.
- Keep it that way: the two apps share content and intent, not code.

## Commands

- Install: `pnpm install` (from inside `web/`)
- Test: `pnpm test`
- Type-check and build: `pnpm build` (`vue-tsc --noEmit` runs first, so a type error fails the build)
- Dev server: `pnpm dev`
- Preview a build: `pnpm preview`
- All of these run from `web/`, never from the repository root.

## Data source rules

- The site is read-only to us: never add a backend, proxy, or file under the site tree.
- `SOURCE_ORIGIN` must keep the `www.` prefix. The bare domain does not resolve.
- There is no JSON API. Content is parsed from the site's HTML, so parsing is the fragile part of this app.
- Parse with degradation, and never fail silently: `parseMusicList` first, then `parseAudioLinks`, then an error.
- Distinguish a page with no audio from a page we failed to understand:
  - A transcript page (no `musicplayer.js`, no audio links) raises `NoAudioError` and is shown calmly.
  - An audio page that yields no track raises `SourceParseError` and is reported as a probable format change.
  Two such pages exist today (`玉师聊阴符经`, `玉师聊修行`); treat them as content, not breakage.
- Keep the real-HTML fixtures in `src/core/source/__fixtures__/` current. They are the ground truth for parsing.

## Playback rules

- Opening a book prepares a track; it must not start playback. Browsers reject playback no gesture asked for,
  so a rejected `play()` without user activation is not an error (`playbackFailureMessage` returns undefined).
- The audio element sets `crossOrigin` before any `src`. Downloaded audio is served by the service
  worker from the Cache API, and a cached response only satisfies a ranged media request when the
  element asked in CORS mode. It is required even for same-origin sources.
- Background and lock-screen playback is not supported on iOS; do not claim it, and do not add code that
  pretends otherwise.

## Offline download rules

- Downloads are explicit. Playback only ever asks for byte ranges, so a streaming response is a 206 and
  nothing lands in the cache; only `downloadTrack`'s full fetch is stored. Never describe caching as
  automatic, and never add a runtime route that tries to cache partial media.
- The bytes live in Cache Storage under `AUDIO_CACHE`; `downloads` in IndexedDB is the index over them.
  Keep the two in step: a record without bytes, or bytes without a record, is a bug. `removeTrack`,
  `removeBookDownloads` and `removeAllDownloads` are the only paths that should drop either.
- The service worker serves this cache through `CacheFirst` with `RangeRequestsPlugin`. Removing either
  half breaks seeking; do not simplify the route.
- `Content-Range` cannot be read from page JavaScript while the audio is cross-origin, because the site
  sends no `access-control-expose-headers`. Test range behaviour through the media element or through
  byte counts, not by reading that header.
- Treat a full device as normal: `StorageFullError` must reach the user as a readable message, and a
  failed download must leave no record behind.
- `navigator.storage.persist()` is a request, not a setting. Record the answer, never branch behaviour
  on it. Installing to the home screen is what actually exempts the origin from Safari's seven-day
  cleanup.

## Storage rules

- IndexedDB holds progress, bookmarks and the download index. Audio bytes never go in IndexedDB; they
  live in Cache Storage. That split is deliberate.
- Bookmark and download rows denormalise the book and track titles so their lists render without
  refetching books.
- The schema is at version 2. Bump the version and create stores idempotently inside `onupgradeneeded`;
  never assume a fresh database.
- `deleteDatabase` exists purely as a test seam; production keeps one connection for the app's lifetime.

## Testing

- Cover parsing, playback decisions, and storage round-trips. Those are where the real regressions live.
- Prefer the existing fakes (`FakeAudio`, `fake-indexeddb`) over new ones.
- Fixtures come from the live site; if a fixture must change, say why in the commit message.

## Done criteria

- `cd web && pnpm test && pnpm build` passes, or the reason it could not run is stated explicitly.
- New parsing behaviour has a fixture-backed test.
- The diff stays inside `web/` unless the change is to `.sandcastle/` or the root `.gitignore`.
