# Batch 8.2 continuation — native startup and reproducible packaging

## Starting state and scope

Started on `codex/all-files-handoff` at **6f4076860fbd3e00ad2ccceb482a208846283288**, then created `codex/batch-8-2-startup`. This base contains the original d33d17e readiness implementation, roadmap and archived handoffs. No Claude branch was integrated. The roadmap and Claude handoff were read from `origin/codex/roadmap-after-batch-7` before implementation.

Reproduced the lockfile defect in a separate empty install directory: `npm ci` exited 1 with `Missing: @capacitor/app@8.1.2 from lock file`. The existing packaging suite passed 10/10; readiness passed 24/24, including its then-expected failure to initialize a cold bundle without CDN access. That final assertion encoded the known limitation and is now deliberately replaced by a successful offline shell assertion.

The brief says six lazy plugins; the code has **seven**, including App. All seven are included. Work remains confined to startup/native packaging, owned field/main/CSS files, their tests and documentation. No changes to API wrappers, pricing, migrations, admin operations views, shared DOM/format, shared test harness or regression runner.

## Implementation

- Exact Capacitor pins match the existing native versions: core/Android/iOS/CLI 8.5.2; App 8.1.2; Camera 8.2.5; Filesystem 8.1.4; Geolocation 8.2.3; Haptics 8.0.2; Share 8.0.3; Status Bar 8.0.4. Supabase is pinned at **2.117.3**, replacing floating `@2`. All direct dependency versions and installed package versions are checked against the lockfile.
- `scripts/vendor-mobile.js` copies the official npm ESM dependency graph into `shared/vendor/`. It uses an ESM import lexer, not a bundler or transpiler, and rewrites module paths only. Registry SRI, package versions, original/runtime entry paths, installed paths, licenses and output SHA-256 hashes are recorded in the manifest. Computed dependency imports and multiple installed copies are rejected rather than guessed. A targeted gitignore exception keeps vendor dist files tracked; the packaging suite checks every manifest-listed file against git ignore rules. Regeneration after a clean install was byte-identical.
- Official `.mjs` files receive `.js` names: the production Caddy configuration already revalidates `.js` but not `.mjs`. This uses the existing routing/cache policy without changing deployment files. Capacitor's installed Android local server also explicitly supports both extensions; this was checked in its source, not on a device.
- Core and Supabase are eager local imports; plugins remain lazy but are local too. `shared/` stays a sibling of `admin/` in native staging and remains served at `/shared/` in production. A per-realm, per-project client registry preserves a single Supabase client, auth lock and refresh timer even when source, staged and query alias URLs coexist. Separate tabs/WebViews remain separate realms, as before.
- `sync-mobile.js` retains its local asset audit, adds actual `.js`/`.mjs` import parsing, validates the lazy plugin map and every vendor hash, and writes a bundle manifest. The verified bundle has **138 files and 325 local references**. Runtime API, signed-image and map destinations remain network resources; this is no job cache.
- `scripts/verify-mobile.js --android` compares source/staging/copied inventories, packaging inputs, native config, installed/locked/vendor versions and all seven native registrations. It checks launcher densities, portrait/landscape splash assets, PNG signatures/dimensions, and local manifest/XML references, including Capacitor's library theme colors. Missing, changed or obsolete copied files fail. Capacitor-generated Cordova compatibility files are the documented exceptions.
- Android `preBuild` depends on this guard through an Exec task, covering assemble/bundle/Android Studio builds. Sync/copy stays explicit: stale input fails rather than being silently refreshed at build time. `npm run cap:sync` performs the normal staging and native sync; `npm run verify:mobile` performs the guard.
- A dependency-free startup controller loads before the normal parser-discovered module entry. It catches failed module loads/evaluation and watches initial router/storage readiness. It reports file/device/storage failure, provides technical details and a real Retry, disables unwired startup controls, and labels the status as unavailable. Retry reloads the document because a rejected module graph can remain cached in a document. It never clears either storage mechanism or creates a sender/outbox.
- Field startup checks the existing outbox store and displays an honest unavailable screen when offline: scheduled jobs are not cached for reads in this build. The existing badge still opens saved actions. A failed access RPC with a saved session gets a retryable connection error instead of an unauthorized-account verdict. The public API and backend pricing remain unchanged.
- The long-header fixture reproduced 426px document width in a 390px viewport. `flex-wrap` on `.section-box__head` fixes it. Existing views, field keyboard behavior, focus/live regions and contrast are rechecked.

## Verification and failure evidence

See the committed continuation evidence in `codex-files/artifacts/batch-8-2-startup/`. **511/511 counted checks pass, plus geofence**: registered runner 391, mobile 22, field recovery 27, readiness 24, bundle 10, packaging 19 and startup 18. Final counts and individual suite results are recorded there. The 18 readiness screenshots and 7 startup states were captured and reviewed; the readiness overflow metrics are all false. Tests use browser fixtures/intercepted HTTP responses; no requests reach a live database.

| Check | What it establishes |
| --- | --- |
| Clean `npm ci` in an empty directory | Package/lock install consistency; original lock failed, repaired lock succeeds |
| Vendor regeneration after clean install | Same committed manifest/files, without a bundler or CDN transformation |
| `native-bundle` | Local HTML/CSS/module/manifest and lazy plugin references; original broken-import copying probe retained |
| `native-packaging` | Production guard accepts fresh inputs and rejects deliberate stale/missing/corrupt/version/registration/resource/config cases |
| `native-startup` | Actual local SDK imports, source/staged offline shell, singleton identity, anonymous site query, authenticated session/RPC behavior, failed-access recovery, seven plugin graphs, forced startup failures, reload Retry and full queued payload/photo-byte preservation |
| `native-readiness` | Existing 24 browser keyboard/accessibility/contrast/recovery checks, retaining the original improvements |
| Existing regression, mobile-reliability, field-resilience | Earlier calculator/navigation/ordered-save/recovery/outbox behavior |

Failure-without-fix probes restore d33d17e CDN imports, restore its HTML without startup recovery, bypass the client registry, restore the old header rule, and bypass the failed-access guard. Each selected test exits 1; the fixed suite is restored and passes. Packaging tests call the actual guard and reject stale source, staging and Android assets, missing lazy modules/native registrations, version drift, invalid icons, absent splash/manifest and stale native config. They do not reimplement that guard in mocks.

The first complete regression found a timing defect introduced by a dynamically imported root: direct-view fixtures were overwritten by late field initialization. The final implementation keeps normal parser-discovered module entries, starts routing immediately, and checks durable storage alongside routing. The unchanged job suites and complete regression verify the correction. Two existing field tests were updated to expect offline-unavailable and startup-storage recovery instead of a loaded schedule; their saved-record/reason/no-replay/unhandled-error assertions remain. Initial fixture assumptions about an empty outbox opening a dialog and simulated native platform detection were also corrected; they were test errors, not product defects.

Offline cold-start testing uses a fresh browser context with no service worker, blocks every non-local origin, and reports `navigator.onLine = false`. Local HTTP serves the role of the packaged WebView asset origin. This proves locally available shell dependencies and truthful UI, not WebView/device integration or offline job reads. A separate saved-session test blocks the backend while the browser still reports online.

## Reproduction and integration handoff

```sh
npm ci
npm run vendor:mobile       # only needed when regenerating committed vendor files
npm run cap:sync
npm run verify:mobile
python3 -m http.server 8743
# In another shell, with Playwright and Chromium installed:
node tests/native-bundle.test.mjs
node tests/native-packaging.test.mjs
node tests/native-startup.test.mjs
node tests/native-readiness.test.mjs
```

The existing environment-independent adapter is `codex-files/tooling/test-loader.mjs`; set `PLAYWRIGHT_MODULE` and `PLAYWRIGHT_CHROMIUM`, and use it as the Node loader for historical suites containing hard-coded paths. In this container those are `/workspace/.nova-shield/test-tools/node_modules/playwright/index.mjs` and `/usr/bin/chromium`. Screenshot output for startup uses `STARTUP_EVIDENCE` or a temporary directory.

For expected browser failures, select one case with `STARTUP_ONLY` and set `STARTUP_BREAK` to `cdn`, `handler`, `singleton`, `wrap` or `access`. The evidence logs record the selected cases and exit status. These fixture overrides are confined to the isolated browser context.

The integrator should add **native-packaging** and **native-startup**, plus the already unregistered **native-bundle**, **native-readiness**, **mobile-reliability** and **field-resilience**, to the explicit local/mocked suite list. `measurement-entry` is already registered on this Codex track. Claude's phase21/22/23 suites are not present here and their registration belongs to integration. The runner and shared harness are unchanged; database tests stay separately selectable.

## Unverified and still open

**Build status updated 2026-10-11:** [Android qualification](android-build.md)
now proves debug assembly and real preBuild stale-asset rejection. The SDK/JDK
gap below records this earlier batch's state; install and physical-device
checks remain unrun.

There is Java 21 but no Android SDK at the checked locations, and neither `ANDROID_HOME` nor `ANDROID_SDK_ROOT` is configured. Gradle compilation, actual preBuild execution, manifest/resource merge, APK assembly/install and physical-device behavior are **unrun**. Sync/copy and direct execution of the production guard succeeded; those do not establish a native build.

To compile: configure an Android SDK (`local.properties` sdk.dir or the SDK environment variable), install platform android-36 and the Build Tools required by AGP 8.13.0, accept SDK licenses, and make Gradle 8.14.3 plus Google/Maven dependencies available. The Java/toolchain must satisfy Capacitor 8/AGP requirements; Java 21 is available here. Then run `npm ci`, `npm run cap:sync` and `cd android && ./gradlew :app:assembleDebug`. Deliberately stale assets should be rejected by preBuild before packaging.

Real bridge calls, Android permission dialogs, hardware/gesture Back, camera/filesystem/share behavior, TalkBack, storage eviction, warm/cold restarts and cellular behavior remain physical-device work for 13.2. Durable offline job reads remain 9.2. Browser fixtures do not establish production Caddy behavior, live Supabase integration, database grants or server state. No production verification, migration, settings/data change, merge, deployment, customer message or APK publication was performed. The previously recorded unapplied customer-content freeze remains outside this batch.
