# BUILD-NOTES.md

- Outcome: BUILD SUCCESSFUL — `./gradlew :app:assembleFreeDebug` exit code 0.
- Wall-clock: 31s (warm Gradle daemon; 511 tasks: 321 executed, 186 from cache, 4 up-to-date).
- APK: `app/build/outputs/apk/free/debug/app-free-debug.apk` (56 MB).
- Warnings: none material; one benign note (3 prebuilt `.so` libs packaged unstripped — libandroidx.graphics.path, libdatastore_shared_counter, libquickjs). No Rosetta/emulation (native x86_64 runner).
- Environment fix, zero repo files touched: `/opt/android-sdk` is read-only and lacked the exact components AGP 9.4.0 requires (`build-tools;36.0.0`, `platforms;android-37.0`); first attempt failed with exit 1 in 12s. Installed both via `sdkmanager` into a writable copy at `~/android-sdk` and reran Gradle with `ANDROID_HOME=/home/agent/android-sdk`.
- Toolchain: Temurin JDK 25.0.4, Gradle 9.7.1, AGP 9.4.0, compileSdk 37 / targetSdk 36.
