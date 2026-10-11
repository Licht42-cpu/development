# Android build qualification

## Base and outcome

Started from clean `codex/batch-9-2-offline-work` at
`27e5ab9d9a7a09b8eb157d4ab5c420613510353a`; continued on
`codex/android-build-qualification`. This is a standing build prerequisite,
not Batch 10.2, 11.2 or physical-device Batch 13.2. No Claude implementation
was imported.

**A real debug APK assembled successfully.** First successful assembly took
79.58 seconds, with 211 actionable tasks executed. This includes the real
preBuild Exec guard, native Java/Kotlin compilation, manifest/resource merge,
DEX generation and debug APK packaging. The three SDK-backed qualification
tests passed; existing packaging 19/19 and bundle 10/10 checks also passed.
The broader browser suites were not rerun: their source is unchanged.

## What actually stopped earlier attempts

1. The Java wrapper ignored the shell proxy variables. The exact command
   `GRADLE_USER_HOME=/workspace/.nova-shield/gradle-cache ./gradlew --version`
   from `android/` failed fetching
   `https://services.gradle.org/distributions/gradle-8.14.3-all.zip` with
   `java.net.UnknownHostException: services.gradle.org`. Mapping the existing
   proxy to Java's HTTP/HTTPS proxy properties fixed this; no proxy was unset.
2. SDK manager tried writing `/home/agent/.android/cache`, producing
   `java.nio.file.NoSuchFileException`. Its initial "All SDK package licenses
   accepted" line was misleading: manifests had failed to load. Setting
   `ANDROID_USER_HOME` to a writable workspace directory fixed package
   installation; the helper verifies installed files and the license file.
3. The first assemble attempt failed applying the Android plugin because
   `/home/agent/.android` was read-only. The same Android-user override fixed
   that failure. A metrics warning still mentions the old home but is nonfatal.
4. The second attempt failed before task execution:
   `Toolchain installation '/usr/lib/jvm/java-21-openjdk-amd64' does not provide
   the required capabilities: [JAVA_COMPILER]`. The existing Java 21 was a
   **runtime without javac**. A checksum-verified Temurin JDK fixed compilation.

Required hosts `dl.google.com`, `repo.maven.apache.org`,
`services.gradle.org`, `github.com` and `release-assets.githubusercontent.com`
were reachable through the configured proxy. No required-host CONNECT denial
blocked the final build. The current environment's package-manager network
preset already includes Google/Maven/Gradle; no allowlist change was needed.

Optional discovery did hit denials: `curl --fail --location` for
`https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=x64&image_type=jdk&os=linux&vendor=eclipse`
returned HTTP 403, and a HEAD request to `api.adoptium.net` reported
`CONNECT tunnel failed, response 403`. The official Temurin GitHub release
assets were accessible and checksum-verified instead. The AGP release-notes
request to `developer.android.com` also returned HTTP 403; this was not an
artifact-resolution failure. AGP's POM belongs on Google's Maven repository;
an exploratory request for it on Maven Central returned 404.

The working Gradle cache is approximately 1.2 GB, SDK 472 MB and JDK 346 MB.
A retained external dependency cache is realistic; committing/vendoring it
into this repository was unnecessary. These observations do not prove that a
partially populated cache can build without network.

## Reproducible setup

Qualified on Linux x86_64 with Python 3.12, Node 24.19.0 and npm 11.9.0:

| Component | Version |
| --- | --- |
| JDK | Eclipse Temurin 21.0.12.1+1, including javac |
| Gradle wrapper | 8.14.3, all distribution |
| Android Gradle Plugin | 8.13.0 |
| SDK command-line tools | 19.0, archive 13114758 |
| SDK platform | android-36, installed revision 2 |
| Build Tools | 35.0.0 |
| Platform Tools | installed 37.0.1; sdkmanager resolves the current package |
| Capacitor core/Android/CLI | 8.5.2; plugin pins remain in package-lock.json |

From the repository root:

```sh
python3 scripts/android-build.py setup --accept-licenses
npm ci --cache /workspace/.nova-shield/npm-cache
npm run cap:sync
npm run verify:mobile
python3 scripts/android-build.py build
python3 tests/android-build.test.py
```

The helper was exercised both against the existing state and a **fresh**
`--state-dir /workspace/.nova-shield/android-reproduction`. The fresh run
downloaded/verified/extracted the pinned JDK and command-line tools, accepted
licenses, installed the SDK packages and started the checksum-pinned wrapper.
Logged steps: JDK download 4.70s, SDK tools download 3.31s, license acceptance
1.88s, SDK package installation 8.36s, wrapper download/start 8.55s. Extraction
and intervening work are additional; these are not a total setup duration.
First successful assembly used caches populated during the failed attempts.
Warm restored assembly took 13.53s.

The default external state directory is the checkout parent's `.nova-shield`.
The helper sets `ANDROID_HOME` and `ANDROID_SDK_ROOT`, supplies writable
`ANDROID_USER_HOME` and `GRADLE_USER_HOME`, selects the cached JDK, and maps
existing HTTP proxy settings into Java. It accepts `--sdk-root`, `--java-home`
and `--java-truststore` overrides. A supplied Java home must include javac 21
or newer. It does not repurpose HOME. The downloaded JDK uses the existing
trusted Debian Java CA store when available, preserving proxy certificate
verification. No insecure TLS flag, disabled verification or proxy bypass is
used. Credential-bearing proxy URLs are refused rather than logged.

SDK tools are checked against the pinned checksum and Google's HTTPS metadata.
The JDK is checked against its official SHA256. The wrapper now records the
official distribution SHA256; the initially installed distribution was also
compared file-for-file against the verified archive.

Skipping setup leaves an absent SDK/compiler or writable-cache failure.
Skipping license acceptance prevents SDK setup. Skipping npm ci leaves native
plugin dependencies unavailable; skipping sync after source changes makes
preBuild reject stale assets. **Build never syncs automatically.** The existing
guard is preserved. Generated Kotlin cache output is now ignored alongside
the existing native build/Gradle caches.

## The real preBuild failure proof

`tests/android-build.test.py` runs the actual Android project, not a mock Gradle
task or a second implementation of the guard:

1. Real `:app:preBuild` executes `:app:verifyNovaAssets` and succeeds.
2. The suite appends a deliberate stale marker to generated
   `mobile/www/admin/js/field.js` and requests `:app:assembleDebug`. Gradle
   rejects it at `:app:verifyNovaAssets FAILED`, with
   `Staged bundle: missing, changed or stale assets: admin/js/field.js` and
   `Execution failed for task ':app:verifyNovaAssets'`. Exactly one actionable
   task executes. App preBuild, compilation and packaging do not execute.
   The suite restores the generated file in `finally`.
3. The restored assemble succeeds and every staged file matches the ZIP
   contents of the resulting APK: **143 files**, including the bundle manifest.
   The production guard reports **142 assets**, excluding that manifest.

The APK's binary manifest, resources and DEX are present. `apksigner verify
--verbose` verifies its debug v2 signature. `aapt2 dump badging` reports
`com.novashield.admin`, compile/target API 36, and launchable MainActivity.
Debug signing is local; no signing private key or APK is checked in.

Evidence is under
`codex-files/artifacts/android-build-qualification/`, including separate
expected-failure and passing logs. Archived text logs normalize line
endings/trailing whitespace; the manifest
records both their archived hashes and the raw captured-output hashes.

The APK remains an ignored local artifact at
`android/app/build/outputs/apk/debug/app-debug.apk`. Its recorded hash identifies
this run, not a promise of identical APK bytes across machines/debug keys.

## Levels reached and integrator handoff

### Follow-up from cb743f4

The helper now exposes `doctor`, an adb command wrapper and Gradle `--offline`:

```sh
python3 scripts/android-build.py doctor
python3 scripts/android-build.py --offline gradle clean :app:assembleDebug
# Only on a host with a writable real-home .android directory:
# Create ~/.android there first if it does not exist.
python3 scripts/android-build.py adb -- devices -l
```

Doctor reports actual compiler/SDK/asset readiness separately from adb and
emulator availability; it does not install or launch an app. Setup recovers
from an inherited runtime-only JAVA_HOME using the verified pinned JDK.
An explicit `--java-home` lacking java/javac is rejected before Gradle rather
than quietly using a compiler elsewhere on PATH. The adb wrapper refuses an
unwritable configuration directory before starting the crashing binary.

A **clean offline assemble** succeeded in 32.06 seconds with all **222
actionable tasks executed**, including the asset guard. This proves this
populated cache can rebuild the current project with Gradle `--offline`;
it does not make an empty cache or future dependency changes offline-ready.

The expanded qualification suite passes **6/6** checks, adding diagnostics
and inherited/explicit JRE selection checks to the original build/guard tests.
Doctor also rejects a selected Java home without its own compiler, even if
another compiler might be found on PATH. Follow-up logs have their
own manifest under `codex-files/artifacts/android-build-followup/`; initial
qualification evidence remains unchanged.

The adb directory issue was investigated directly. Scoped write permission
for `/home/agent/.android` was granted, but `mkdir -p /home/agent/.android`
still failed with **Read-only file system**. This is a mounted-filesystem
constraint, not a missing permission that another approval would fix. No HOME
override, mount change or platform-tool modification was used. Installation
requires a host with a writable adb configuration directory and an actual
emulator/device; neither requirement is established here.

| Level | Result | What it establishes |
| --- | --- | --- |
| Capacitor sync + direct guard | Passed | Staging, copied assets, config, resources and seven plugin registrations agree |
| Gradle assemble + real guard probe | Passed | Native build graph executes the guard, compiles/merges and produces a debug APK; stale staged JS blocks assembly |
| Emulator install/start | Unrun | No emulator binary/system image was available; /dev/kvm is absent |
| Physical device | Unrun | No permission, Back, camera, TalkBack, eviction, restart or cellular result claimed |

Platform-tools installation is not device readiness: this container's adb
37.0.1 also aborts trying to create `/home/agent/.android`, even with the
Android-user override. No install was attempted. Diagnose that host tooling
issue on a writable host when an emulator/device is actually provided; do not count adb or APK
compilation as an application first-screen result. The cheap emulator bonus
was unavailable, and physical checks remain 13.2.

The existing mocked integrator list remains **offline-work, native-packaging,
native-startup, native-bundle, native-readiness, mobile-reliability,
field-resilience**; measurement-entry is already registered. Add the new
**android-build** qualification suite as a separately selectable SDK/Gradle
job using `python3 tests/android-build.test.py`, after setup and sync, never
alongside a concurrent sync/build. It is not a browser/mock suite and requires
SDK/JDK/dependencies. `tests/run-regression.sh` remains unchanged; database
integration stays separately selectable too.

All 148 tracked files under admin/, shared/, supabase/ and the regression
runner are byte-identical to the base. No field/offline/startup feature change,
live migration, grant/data change, merge, deployment or APK publication occurred.
