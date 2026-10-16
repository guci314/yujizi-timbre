# TASK

Review the code changes on branch `{{BRANCH}}` and improve code clarity, consistency, and maintainability while preserving exact functionality — then verify against AGENTS.md's testing rules.

# CONTEXT

You are an autonomous Android engineer in a Docker sandbox (Linux, JDK 25, Android SDK at `$ANDROID_HOME`, Gradle 9.7.1). Emulator / managed devices are unavailable — verify at unit-test level.

## Branch diff

!`git diff {{TARGET_BRANCH}}...{{BRANCH}}`

## Commits on this branch

!`git log {{TARGET_BRANCH}}..{{BRANCH}} --oneline`

# REVIEW PROCESS

1. **Understand the change**: Read the diff and commits above to understand the intent.

2. **Analyze for improvements**: Look for opportunities to:
   - Reduce unnecessary complexity and nesting
   - Eliminate redundant code and abstractions
   - Improve readability through clear variable and function names
   - Consolidate related logic
   - Remove unnecessary comments that describe obvious code
   - Avoid nested ternary operators - prefer switch statements or if/else chains
   - Choose clarity over brevity - explicit code is often better than overly compact code

3. **Check correctness & architecture (AGENTS.md gates)**:
   - Does the implementation match the intent? Are edge cases handled?
   - Module boundaries: user-facing screens in `:features:*`, shared services/data in `:core:*`; **no feature→feature dependencies; core must not depend on features**
   - No dependency versions hardcoded outside `gradle/libs.versions.toml`
   - Smallest change that satisfies the request; no unrelated rewrites
   - Are new/changed behaviours covered by tests?
   - No signing/release/Fastlane/CI changes

4. **Maintain balance**: Avoid over-simplification that could reduce clarity, create overly clever solutions, or merge concerns.

5. **Apply project standards**: Follow the coding standards defined in @.sandcastle/CODING_STANDARDS.md

6. **Preserve functionality**: Never change what the code does - only how it does it.

# VERIFICATION (Gradle, per AGENTS.md)

Run the narrowest meaningful checks for what changed:

- Change in one module → `./gradlew :<moduleName>:testDebugUnitTest`
- App-level change → `./gradlew :app:testFreeDebugUnitTest`
- Shared / cross-module behavior → `./gradlew voiceUnitTest`
- Always `./gradlew lintKotlin`; add `./gradlew :app:lintFreeDebug` when resources/UI changed
- First compile may take minutes — wait, do not abort
- Docs-only branch: skip Gradle, verify md paths/links by reading them back

Test patterns (AGENTS.md): focused tests for changed behaviour; prefer in-memory fakes such as `MemoryFeatureFlag` / `MemoryDataStore`; Compose view-state tests use Molecule + Turbine:

```kotlin
backgroundScope.launchMolecule(RecompositionMode.Immediate) {
  viewModel.viewState()
}.test {
  awaitItem()
}
```

# EXECUTION

If you find improvements or failing checks:

1. Make the changes directly on this branch
2. Re-run the same Gradle checks until they pass
3. Commit describing the refinements (prefix `RALPH:` review refinement)

If the code is already clean and all checks pass, do nothing.

Once complete, output <promise>COMPLETE</promise>.
