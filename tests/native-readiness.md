> Updated Batch 8.2 startup and reproducible packaging are documented in
> [native-startup.md](native-startup.md). The report below records the original
> d33d17e readiness work; its lockfile/CDN limitations are addressed in the continuation.

# Batch 8.2 — Native readiness and Field Console accessibility

## Browser execution comes first

A real browser ran during both 6.2 and 7.2, and runs during this batch:
Chromium **151.0.7922.173**, Playwright **1.58.2**. Before editing product
files, these suites reproduced: **measurement-entry 29/29**,
**mobile-reliability 22/22**, **field-resilience 27/27**. The brief's
missing-Chromium premise does not describe this workspace. System Chromium
is `/usr/bin/chromium`; the shared tests' `/opt` paths are absent. An
external loader adapts those paths without changing the harness or runner.

Independent branch **codex/batch-8-2**, based on **a8b573f**. Read the
repository instructions and both owned handoffs before implementation.
No Claude work was integrated, rebased onto, or used as a prerequisite.

## Part A: confirmed hypotheses and limits

| Hypothesis | Evidence and disposition |
| --- | --- |
| Local runtime files are missing from the wrapper | **Not reproduced for native paths.** Both the staging tree and Capacitor's copied Android web assets resolve 204 literal local references: JS imports, HTML/CSS assets, manifest icons/start URL, document links and literal fetches. Completion report and desktop winter navigation are bundled. No local asset was added. |
| The customer quote path fails inside the wrapper | **Already handled on this branch.** `site/` is deliberately absent. The native quote branch uses the absolute customer URL; the browser-only relative fallback is explicitly classified. Breaking that branch makes the audit fail. The existing native-wrapper suite exercises its rendered native link using plugin doubles. |
| Native startup depends on connectivity | **Reproduced for the bundled web application with an empty browser context and blocked HTTPS.** The actual bundled field page requests eager Capacitor core and Supabase CDN imports; both fail, field.js never initialises, and the page remains `Loading…`. This is a browser/module-loading observation, not a handset observation. No plugin-loading redesign was made. |
| Native Back's App plugin is packaged | **Failed before the fix.** `package.json` declares App, but tracked Android Gradle settings/dependencies omitted it. Android-only Capacitor sync now registers all seven plugins, including App; generated Gradle paths remain checkout-relative. |
| Geolocation permissions are declared | **Failed before the fix.** Neither the app manifest nor the pinned plugin manifest declared coarse/fine location. The plugin README and native annotations require both for the existing high-accuracy calls. Both foreground permissions were added. No background location or mandatory GPS feature was added. |
| Camera/filesystem/share need additional broad permissions | **Not reproduced.** The pinned Camera package documents no permission for the current `saveToGallery: false` operation. Filesystem uses sandbox Data/Cache; sharing uses the already-configured cache FileProvider path. Broad camera/gallery/storage permissions were not added. INTERNET is used; the Haptics library contributes VIBRATE and the app calls it. No unused requested permission was confirmed. |

The audit reports nine CDN module URLs (core, Supabase, seven lazy plugins)
and the Maps URL. Dynamic backend/signed-photo URLs, camera `webPath`, Blob
URLs, generated shared-report filenames, tel/sms links and hash routes were
reviewed separately: they are runtime data or external capabilities, not
files to copy from the repository. The scanner checks literal references and
the current quote branch; it is not a general JavaScript interpreter and
cannot prove arbitrary future URL expressions. It rejects unresolved local
template paths rather than treating them as verified files.

`sync-mobile.js` now audits after copying and fails on missing references.
Tests delete a required shared module, inject an absent dynamic import and
HTML/CSS assets, and break native quote selection. A separate isolated probe
executes the **old sync script from a8b573f** against a broken import: it
succeeds. The new sync script refuses the same source. No source checkout is
reset or temporarily changed for these probes.

### An unresolved dependency outside owned files

Historical baseline: startup continuation resolved the package/bootstrap gaps,
and [Android build qualification](android-build.md) now proves compilation,
manifest/resource merge, assembly and real preBuild rejection. Installation
and physical-device behavior remain unverified.

**A clean `npm ci` fails:** the existing lockfile lacks the App dependency
already declared in package.json. Package/lockfile changes are outside the
assigned ownership, so neither was changed. Exact pinned native packages
were installed outside the checkout, then copied into ignored node_modules
to run Android-only sync without persisting environment-specific paths.
`cap sync android` succeeded; the copied asset audit and generated
capacitor.plugins.json confirm App plus the other six plugins.

Proposed later: reconcile the package/lockfile, then ship locally resolved,
version-matched Capacitor core/plugin modules in the web bundle instead of
depending on CDN imports. Supabase also needs a bundled/pinned import, which
requires shared/supabase.js ownership. Fixing module bootstrap alone would
not supply offline authentication or cached visit reads: those still need
their existing server paths. The outbox is a write queue, not full offline
reopening. These proposals were **not implemented**.

No configured Android SDK was available, so Gradle compilation, manifest merge and APK
installation are **unrun**. Successful Capacitor sync does not establish
those results. Real permission prompts and native plugin behavior require a
device.

## Part B: accessibility findings and changes

- Quantity saving/failure already exposed a polite live region. Successful
  saving now announces completion; its status is atomic. Recovery actions
  return focus to the quantity when their button disappears. A delayed retry
  does not reclaim focus after the user has moved to another control.
- Passport preferences now have a programmatic name. A persistent live
  region reports saving, server success, locally queued success and failure.
  Only the save button is aria-busy: its sibling progress announcement is
  not deferred by a busy ancestor. Duplicate writes remain blocked.
- Sync changes now have a separate atomic live region. The badge remains a
  keyboard button, with its existing dialog name and Enter/Space behavior.
  Dialog list refresh/discard preserves focus on the surviving action, or
  Close when no action remains. Tab trapping and Escape focus return already
  worked and remain covered.
- Notes read errors update a persistent live region. Notes/visit Retry
  controls restore focus when removed, or focus the renewed Retry on failure.
- A visible two-pixel focus indicator covers links/buttons, including the
  badge. At 390px, keyboard traversal reaches the visit and note controls;
  rendered default-fixture controls have names and no positive tabindex.
  Window/winter icon steppers already had accessible button labels.
- Light muted text was too faint on the measurement row surface; its token
  is darker. Dark primary white text measured **2.26:1**, and dark error
  toast white text **2.47:1**. Theme-specific foreground tokens fix both.
  Tests cover primary/progress text, error toasts, sync states, warnings,
  quantity hints and failed-outbox text against their rendered backgrounds.
  Contrast probes include the element's opacity and brightness filter.
- Screenshot inspection found recovery rings crowding adjacent text and
  faded progress buttons. Status spacing/recovery rows and an unfaded busy
  primary button fix these within owned CSS/editor files.

Chromium's accessibility tree exposes the tested live-region text and
politeness properties. That establishes browser accessibility semantics,
not spoken TalkBack/VoiceOver delivery. The tests do not certify every
calculator, photo/signature canvas or customer page. No issue needing a
forbidden accessibility file was established in the tested controls.

## Changed files and boundaries

Product changes: `admin/js/field.js`, `admin/js/views/field-workspace.js`,
`admin/js/lib/measurement-entry.js`, `admin/css/admin.css`,
`scripts/sync-mobile.js`, Android manifest and the two generated Android
plugin Gradle files. New owned files: native-readiness fixture/suite,
native-bundle suite, screenshot script and this handoff.

Plugin imports, shared files, API/quote/settings code, pricing calculations,
outbox handlers and schema, database files, dependencies/lockfile and the
shared harness/runner were not changed. No live writes, migrations, merge,
deploy or later-batch work occurred.

## Validation and reproducibility

- **native-readiness: 24/24 browser checks.** Exact prior product files from
  a8b573f: **8/24 preservation/known-limitation checks pass, 16 fail**.
- **native-bundle: 10/10 Node checks.** Prior Android configuration:
  **8/10 pass, 2 fail**. The old/new sync injection probe separately proves
  the new missing-reference guard is meaningful.
- Existing explicit mocked suites: phases 2–20 including 10-5,
  native-wrapper, reload-offline, measurement-entry, mobile-reliability,
  field-resilience and geofence. Database tests are not in this selection.
- Existing counted checks: **440/440**, plus geofence assertions. Combined
  with the new suites: **474/474** counted checks, plus geofence.
- **18 screenshots captured and inspected** at 390, 430 and 1200px:
  quantity recovery, passport progress and failed outbox, each in light and
  dark mode. Focus rings, progress text and recovery spacing were examined;
  all fit the viewport. A fixture startup race in the added keyboard test
  was corrected; that failure is not counted as an application defect.
- Existing guarded-click tests caught a regression in the new recovery-row
  spacing: blur could collapse the row and move Build quote before click.
  Its height is now retained during the save, and measurement-entry 29/29
  plus mobile-reliability 22/22 re-pass after that correction.
- Syntax checks and git diff --check pass. Android-only sync and copied
  asset audit pass. Compilation/device/production/database checks are unrun.

Run a static server from the repository on port 8743 first. Normal tool paths:

```sh
node scripts/sync-mobile.js
node tests/native-bundle.test.mjs
node tests/native-readiness.test.mjs
node tests/screenshot-batch8-2.mjs /tmp/nova-shield-batch8-2-screenshots
```

Actual browser command here, with the existing external adapter required by
the reused fixture's shared harness import:

```sh
PLAYWRIGHT_CHROMIUM=/usr/bin/chromium \
PLAYWRIGHT_MODULE=/workspace/.nova-shield/test-tools/node_modules/playwright/index.mjs \
node --loader /workspace/.nova-shield/test-loader.mjs tests/native-readiness.test.mjs
```

Use the same flags/loader for the screenshot script. Prefix either new suite
with `READINESS_BASELINE=1` to reproduce the recorded expected failures.
Logs, counts and screenshots are in `/workspace/.nova-shield/batch8-2/`.

At integration, add **native-readiness** and **native-bundle** to the
explicit mocked/local suite list. Both names need registering; the existing
mobile-reliability and field-resilience suites also remain unregistered on
this independent track. Keep screenshots and database suites separate; do
not substitute a blanket glob. The shared runner remains unchanged.

Physical-device follow-up still includes hardware Back, keyboard interaction,
TalkBack announcements, permission denial/grant, clipboard/popup/share sheet,
camera/filesystem behavior, cold/warm restart, storage eviction and cellular
offline. Browser doubles and packaging audits do not establish these.
