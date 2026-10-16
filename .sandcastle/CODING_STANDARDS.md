# Coding Standards (distilled from AGENTS.md — reviewer loads this file)

## Architecture

- User-facing screens and flows live in `:features:*`
- Reusable services, data contracts, playback, scanning, logging, strings, shared UI live in `:core:*`
- `:app` and `:navigation` handle only app wiring and navigation integration
- **No feature→feature dependencies; core must not depend on features**
- Project dependencies must come from version catalog entries (`gradle/libs.versions.toml`) — no hardcoded versions
- Architecture source of truth: `docs/architecture.md`; module inventory: `settings.gradle.kts`

## Style

- Make the smallest change that satisfies the request and fits the existing module boundary
- Prefer existing project patterns, fakes, stores, dispatchers, DI modules, and UI components over new abstractions
- Keep functions small and names clear; avoid comments unless they explain a non-obvious reason, workaround, or side effect
- Formatting is handled by ktlint (`./gradlew lintKotlin`) — don't hand-style

## Testing (AGENTS.md)

- Add or update focused tests for changed behaviour — especially domain logic, state reducers/view models, persistence, navigation, and bug fixes
- Prefer lightweight in-memory fakes such as `MemoryFeatureFlag` and `MemoryDataStore` when available
- Compose view state tests use Molecule plus Turbine:
  ```kotlin
  backgroundScope.launchMolecule(RecompositionMode.Immediate) { viewModel.viewState() }.test { awaitItem() }
  ```
- Run the narrowest meaningful test first; broaden to `./gradlew voiceUnitTest` when touching shared behaviour, cross-module contracts, or risky refactors
- If tests cannot be run, state the concrete reason and the command that should be run

## Done Criteria (AGENTS.md)

- Relevant tests or build checks have passed, or the reason they were not run is explicit
- The diff is scoped to the requested behaviour and does not rewrite unrelated code
- New public behaviour is covered by tests or clearly justified if not
- Instructions in AGENTS.md stay accurate
