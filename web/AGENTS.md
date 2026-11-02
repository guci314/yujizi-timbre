# AGENTS.md — web/

Nested contract for the browser client. The root `AGENTS.md` still applies; this file only adds what is
specific to this subtree.

## Scope

- This tree is a standalone Vue 3 + Vite + TypeScript PWA that plays the audio published on `www.yujizi.org`.
- It is not wired into the Gradle build. `./gradlew` never touches `web/`, and `web/` never imports Kotlin code.
- Keep it that way: the two apps share content and intent, not code.

## Architecture

- Three layers, one direction of dependency: `views/` → `psm/` → `pim/`, plus `core/` for data access.
- `pim/` is pure: no DOM, no Vue, no IndexedDB, no `fetch`. A grid is a total `(state, event) -> (ctx, effects)` table;
  slots return `Effect[]` instead of calling the platform. Do not import `vue` or `psm/` from `pim/`.
- `psm/` owns the platform: the `<audio>` element (`audio-driver.ts`), IndexedDB/Cache Storage (`storage-driver.ts`),
  and the singleton stores. Views never hold playback flags of their own.
- `views/` only reads the projected state and dispatches events. If a view needs a new behaviour, add an event and a cell.
- The playback table is `pim/player-grid.ts` (7 states x 16 events). Adding an event means adding a cell to **every**
  state; `pnpm test` fails on a missing one, by design.

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
  so a rejected `play()` without user activation is not an error: the driver emits `E_PLAY_BLOCKED` and the grid
  settles into a ready-but-paused state at the requested position.
- Viewing a book's chapter list must never touch the playing session. Only `E_PLAY_AT` (chapter click, bookmark
  hop, play button on a detail page) switches books; `E_PREPARE_BOOK` is ignored outside `S0_IDLE`.
- A play control on a detail page means "play this book", not "toggle whatever is loaded". `PlayerView` decides
  between `playAt` and `toggle` from `isPlayingBook`; do not collapse that back into one call.
- The audio element sets `crossOrigin` before any `src`. Downloaded audio is served by the service
  worker from the Cache API, and a cached response only satisfies a ranged media request when the
  element asked in CORS mode. It is required even for same-origin sources.
- Background and lock-screen playback is not supported on iOS; do not claim it, and do not add code that
  pretends otherwise.
- The sleep countdown is decremented only in `S4_PLAYING`, by `E_TICK_1S`. Never add a wall-clock deadline;
  pausing must freeze it structurally, not by remembering to clear a timer.
- Progress is written per book position (`lastPersistedTime`), and every track switch emits
  `PERSIST_PROGRESS` for the outgoing track before loading the new one.
- `timeupdate` is ignored while `seekPending` is true. HTML5 fires `play` before `loadedmetadata`, so a
  bookmark hop can be in S4 with the element reporting 0 seconds; taking that value would overwrite the
  requested second before the seek lands. Natural resume rewinds three seconds (`resumePosition`);
  `E_PLAY_AT` never does.

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

- IndexedDB holds progress, bookmarks, the download index, and `books_catalog`. Audio bytes never go in
  IndexedDB; they live in Cache Storage. That split is deliberate.
- `books_catalog` is what makes the app openable offline: every successful index/book parse is cached, and
  the shelf and chapter list fall back to it when the network fails. Caching audio without caching the
  chapter list is the bug that table exists to prevent.
- Bookmark and download rows denormalise the book and track titles so their lists render without
  refetching books.
- The schema is at version 3. Bump the version and create stores idempotently inside `onupgradeneeded`;
  never assume a fresh database.
- A download writes bytes first and the record second; if the record write fails, the bytes are deleted
  before the error escapes. `reconcile`/`repairDownloads` in `pim/offline-grid.ts` audit that contract,
  and the offline page exposes it as 核对账实.
- `deleteDatabase` exists purely as a test seam; production keeps one connection for the app's lifetime.

## Testing

- Cover parsing, playback decisions, and storage round-trips. Those are where the real regressions live.
- `pim/__tests__/player-grid.test.ts` is the regression net for playback: it asserts the table is complete
  (7 x 16 cells) and runs a BFS over the reachable state graph against the domain invariants (sleep cannot
  resurrect, pausing freezes the countdown, another book cannot disturb the session, external pause leaves
  S4). A playback change that is not expressed in the grid cannot be tested this way, which is the point.
- `pim/__tests__/offline-grid.test.ts` replays every short download interleaving against an in-memory store,
  including an injected record-write failure, and asserts the index and the cached bytes still agree.
- Prefer the existing fakes (`FakeAudio`, `fake-indexeddb`) over new ones.
- Fixtures come from the live site; if a fixture must change, say why in the commit message.

## Done criteria

- `cd web && pnpm test && pnpm build` passes, or the reason it could not run is stated explicitly.
- New parsing behaviour has a fixture-backed test.
- The diff stays inside `web/` unless the change is to `.sandcastle/` or the root `.gitignore`.
