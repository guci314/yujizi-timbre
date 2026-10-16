# TASK

Fix issue {{TASK_ID}}: {{ISSUE_TITLE}}

Pull in the issue using `gh issue view {{TASK_ID}}`. If it references a parent PRD or doc, pull that in too.

Only work on the issue specified.

Work on branch {{BRANCH}}. Make commits and run checks.

# CONTEXT

You are an autonomous Android engineer in a Docker sandbox (Linux, JDK 25, Android SDK at `$ANDROID_HOME`, Gradle 9.7.1). Host-side tooling is unavailable.

The repository contract `AGENTS.md` is authoritative — read it and honor it (module boundaries, commands, testing rules, "Do not touch signing/release/Fastlane/CI").

Here are the last 10 commits:

<recent-commits>

!`git log -n 10 --format="%H%n%ad%n%B---" --date=short`

</recent-commits>

# EXPLORATION

Explore the repo and fill your context window with relevant information that will allow you to complete the task.

Pay extra attention to test files that touch the relevant parts of the code.

# EXECUTION

If applicable, use RGR to complete the task.

1. RED: write one test
2. GREEN: write the implementation to pass that test
3. REPEAT until done
4. REFACTOR the code

# FEEDBACK LOOPS (Gradle, per AGENTS.md)

Before committing, run the narrowest meaningful checks (everything happens in this sandbox):

- Change in one module → `./gradlew :<moduleName>:testDebugUnitTest`
- App-level change → `./gradlew :app:testFreeDebugUnitTest`
- Shared / cross-module behavior → `./gradlew voiceUnitTest`
- Always finish with `./gradlew lintKotlin`; add `./gradlew :app:lintFreeDebug` when touching resources/UI lint covers
- First assemble may compile for several minutes — that is normal; wait, do not abort
- Emulator / managed devices are unavailable in this sandbox — unit-test level only

Docs-only changes: skip Gradle; verify md paths/links by reading them back.

# COMMIT

Make a git commit. The commit message must:

1. Start with `RALPH:` prefix
2. Include task completed + doc/PRD reference
3. Key decisions made
4. Files changed
5. Blockers or notes for next iteration

Keep it concise.

# THE ISSUE

If the task is not complete, leave a comment on the issue with what was done.

Do not close the issue - this will be done later.

Once complete, output <promise>COMPLETE</promise>.

# FINAL RULES

ONLY WORK ON A SINGLE TASK.
