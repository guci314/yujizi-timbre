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
- Never cache audio in the service worker; it is large and its availability is the site's concern.
- Resuming rewinds a few seconds so the listener regains context (`RESUME_REWIND_SECONDS`).
- Background and lock-screen playback is not supported on iOS; do not claim it, and do not add code that
  pretends otherwise.

## Storage rules

- IndexedDB holds progress and bookmarks only, never audio.
- Bookmark rows denormalise the book and track titles so the list renders without refetching books.
- `deleteDatabase` exists purely as a test seam; production keeps one connection for the app's lifetime.

## Testing

- Cover parsing, playback decisions, and storage round-trips. Those are where the real regressions live.
- Prefer the existing fakes (`FakeAudio`, `fake-indexeddb`) over new ones.
- Fixtures come from the live site; if a fixture must change, say why in the commit message.

## Done criteria

- `cd web && pnpm test && pnpm build` passes, or the reason it could not run is stated explicitly.
- New parsing behaviour has a fixture-backed test.
- The diff stays inside `web/` unless the change is to `.sandcastle/` or the root `.gitignore`.
