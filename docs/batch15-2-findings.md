# Batch 15.2 — native candidate, regression and field support

**Local qualification is complete; live and handset qualification are not.**
No merge, rebase, cherry-pick, migration application, production data/grant/
setting change, customer message, deployment or APK publication was performed.

## Candidate and source

- Branch: `codex/batch-15-2`.
- Verified clean base: `52510c3d49cdffa71a0f607c676b82bde1c48416` on
  `codex/integration-candidate`; its prior app candidate was `de9e5d7`.
- Qualified candidate: `f0bdab542e04f26d0a8fcc668121e47ef4247fc2`.
- Assignment: `docs/prompts/codex-batch-15-2.md` at Claude `9b64b23`.
- Refreshed unchanged Claude source: `5169d7bf18e99e10855b47da2d12308d886f0fc9`.

125 copied files match their source Git blobs and SHA-256 checksums. All 41
migration files match the pin; **31 follow the historical `20261009013557`
cutoff**. Live migration history was not queried. The owner reports the 31
unapplied; four anonymous live read probes corroborate missing RPCs, not the
entire history. No database suite was run in this batch.

[`integration-source.json`](../codex-files/handoffs/integration-source.json)
is the provenance record. Claude's job view was not copied over Codex's
ordered measurement/action guards. API, components, migrations, contracts,
backend tests and phase suites were copied unchanged, without independent
edits. The qualified source includes 15.1's shared crew rule and release
correctives; it does not imply those fixes are present live.

## Owned corrections during qualification

1. An empty general outbox said **Synced** using only its local count and
   browser online signal. The badge and empty-queue toast now say **No queued actions**; startup says
   **Checking device queue…**. Neither claims a server receipt or successful
   delivery. Accepted load/closing/completion receipts stay separate.
2. Back/contact links measured only 18–22px tall. Owned CSS gives them the
   same 44px minimum as buttons, while preserving names and keyboard focus.
3. The unchanged new dispatch component offered a crew claim button, but the
   owned wrapper refused every crew before mounting it. Dispatch alone now
   checks fresh `is_admin` after a false `is_owner`, then requires its scoped
   backend day/conflicts reads. Refused membership/vehicle reads mount the
   named unavailable state, not private details. Inventory/property/handover
   management retain their owner gate. No backend rule or write grant changed.
4. The empty field schedule also appended a conditional null directly. It now
   filters the optional node; the existing empty/failure regression asserts no
   visible null text. Claude's separate property-view finding remains untouched.

The routed crew control, missing membership, other-vehicle refusal and exact
claim key/revision parameters have browser tests. These are SDK/API doubles,
not backend authorisation proof. The field dispatch screen itself has no
claim action: the entry is Management → Menu → Dispatch, once the owner
applies and verifies the backend per the release runbook.

## Build and artifact

Actual Capacitor sync, asset guard, `preBuild` and restored debug assembly
succeeded. Deliberately stale staging was refused by
**`:app:verifyNovaAssets FAILED` before preBuild/compile/package**. The SDK
suite restored the file and rebuilt successfully.

| Inventory | Observed |
| --- | --- |
| APK | local debug artifact, unpublished; 9,554,179 bytes |
| SHA-256 | `4e41f92870d167f88ee997c25148711dd33624055f8a08919b4cb7ad376526a0` |
| Application ID | `com.novashield.admin` |
| Compiled version | `1.0`, version code `1`; npm package version separately `1.0.0` |
| SDK | minimum 24, target/compile 36; Build Tools 35.0.0 |
| Toolchain | cached full JDK 21.0.12.1, Gradle 8.14.3, AGP 8.13.0 |
| Staged files | 178, including the bundle manifest; 177 source assets |
| APK web files | 180: staged files plus the two known Cordova compatibility files |
| Binding | every staged file matches APK bytes; staged source/input hashes match the qualified commit |

The compiled manifest declares INTERNET, ACCESS_COARSE_LOCATION,
ACCESS_FINE_LOCATION, VIBRATE, ACCESS_NETWORK_STATE and the app-scoped
`DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`. The last two come from pinned
`iongeolocation-android:2.2.2` and `androidx.core:core:1.17.0`; the receiver
permission is **signature-protected in the compiled manifest**. No background
location or background tracking permission was introduced. These are declared
permissions, not permission-dialog or bridge behavior results.

All 14 direct runtime/development dependency versions are exact, agree with
the lock root/resolutions and match installed packages. Seven Capacitor plugin
graphs remain registered. No dependency was upgraded.

**Proof levels:** sync validates staging/native copy and reference coverage;
assembly validates native compilation, resources/manifest merge and local
packaging; APK audit binds bytes and declarations. None demonstrates install,
first screen, camera, hardware Back, TalkBack, storage eviction or cellular
behavior. Emulator/install/device outcomes are UNRUN.

## Results and boundaries

| Category | Final result |
| --- | --- |
| Explicit shared/local regression | **47 suites, 1,031 distinct checks PASS**, geofence separately PASS |
| Staged-byte browser qualification | **20/20 PASS**, including scoped crew controls at all three widths |
| Header visual/functional observations | **3/3 PASS**, 390/430/1280; separate observations, not added to suite totals |
| SDK/actual Gradle qualification | **6/6 PASS**, including stale rejection and restored assembly |
| Native artifact audit | **25/25 PASS**, with final post-regression byte binding rechecked |
| Qualification-record validator | **18/18 PASS**; no handset behavior asserted |
| Declared negative injections | **5 expected failures**, each rejected as declared |
| Device qualification gate | **Expected rejection**; no physical target/results |
| Final ordinary failures / skipped | **0 / 0**; earlier ordinary failures retained separately |
| Physical Android | **0 PASS / 0 FAIL / 0 SKIPPED / 16 UNRUN** |
| Database / authenticated live integration | **UNRUN** |
| Anonymous live read probes | Four observed `404 / PGRST202` responses; not authenticated integration |
| Emulator / provider sandbox / production | **UNRUN** |

Raw evidence and byte/target inventories are under
[`codex-files/artifacts/batch-15-2`](../codex-files/artifacts/batch-15-2/).
The complete 47-suite run passed at `d83c4b6`. The final empty-schedule/toast
corrections and quota-fixture readiness fix followed it: seven affected suites
passed **152/152** at the qualified candidate, overlapping the same 1,031
distinct checks. Staged QA passed 20/20 again. The six SDK cases preceded those
last UI corrections; their guard code is unchanged, and a final positive
assembly executed it against the final assets in 20.86s. Old APK/SDK records
are retained with explicit before-fix names; the primary APK audit and
qualification record bind the final artifact.

Five predeclared fault injections remain rejecting: pre-integration routes,
editable note before draft readiness, the old empty-queue label, the old
owner-only dispatch gate and stale staging at real preBuild. The device gate
also rejects the 16 UNRUN cases; that is a gate result, not handset success.

Initial ordinary failures are preserved, not relabelled: the new QA initially
assumed an empty dispatch day contained a button, then matched both the visible
badge and its hidden live-region text. Selectors were corrected without
weakening the intended keyboard/name assertions. The initial APK audit omitted
two transitive permissions; reviewed merger/source provenance corrected the
audit. One full shared run returned 17/18 on phase2's signature callback after
its fixed 60ms wait; the unchanged suite passed 18/18 alone and the final
uncontended run. Its fixture remains timing-sensitive; no signature product
or Claude phase-suite change was made. A later operational quota fixture
injected failure before startup finished and therefore got the startup
recovery screen. It now awaits the actual exported startup promise before the
operational fault; the same storage assertion passes. Its initial 48/49 log
is retained separately.

Browser preparation, offline capture, original Blob/queue survival across an
actual Chromium process restart, account separation, denial retirement and
reconnect receipts were exercised with controlled transport doubles. These
are not Android background restart or live server sync. No live sync success
is claimed.

Read-only live probes for `is_owner`, `get_dispatch_day`,
`get_property_access` and `job_completion_reports` each returned HTTP 404,
`PGRST202`. They used the public key with no user session and nil job/property
IDs; no business records were returned. After rebuild the staged route checks
still render the named unavailable state for that error, retain routes and
offer no operation controls. Authenticated live screen verification is UNRUN:
no authorised user session was supplied. The gate is not a complete migration
or mutation-signature/grant audit.

57 final full-page captures (plus one retained before-fix field capture) at 390/430/1280 cover ready/pending management routes, all
inventory tabs and the crew claim control; accessibility snapshots retain
names/focus and target measurements. The four main staged surfaces and crew
control and the changed field header were visually inspected at all three widths. Glove/sunlight suitability
is **design review only**, not a measured handset result.

## Open findings and release limits

Claude-owned and unchanged:

1. `admin/js/views/inventory.js:61` / `:684`: creation still exposes only six
   old units; litres, kilograms, sticks and level tracking cannot be selected.
2. `admin/js/views/property.js:461`: conditional null reaches `Element.append`
   and renders literal `null`, visible in the refreshed captures.
3. `admin/js/views/inventory.js:1190`: Daily load mounts without selection
   options; its vehicle/day still reset on reload. A component/view callback
   hook is needed, rather than external DOM hydration.
4. `tests/phase2.test.mjs`: signature callback assertions use a fixed 60ms
   wait. Record completion explicitly in a future owned fixture correction;
   the transient failure does not itself establish a product defect.

The earlier crew-scope disagreement is **answered in 15.1 source**; it is not
carried as an unfixed backend finding. Its live application remains pending.
Four old refusal messages, legacy FK/retirement, unset owner settings and the
two absent workers remain documented by Claude's release review.

All 16 handset cases remain **UNRUN: no Android target supplied**. The current
doctor reports no emulator, no writable real-home adb configuration; the
qualification record also reports no supplied USB/KVM target. 15.2's physical
cold/background restart, offline capture, queue survival and reconnect checks
overlap that checklist and remain UNRUN, not additional passed cases. 14.2
was not authorised and no telemetry/geofence test cases were invented.

No provider sandbox, real sending/signing/payment, production verification or
authenticated live integration was performed. Supplier specifications, chemical
dosages, pack conversions, renewal cutoffs, the operating timezone, seven
completion business decisions and Permanent Lighting Phase D remain unfilled.

## Reproduce / hand off

Use the existing pinned environment and a matching local fixture server:

```sh
export PLAYWRIGHT_MODULE=/workspace/.nova-shield/test-tools/node_modules/playwright/index.mjs
export PLAYWRIGHT_CHROMIUM=/usr/bin/chromium
npm run cap:sync
npm run verify:mobile
npm test
NODE_OPTIONS='--loader=./codex-files/tooling/test-loader.mjs' node tests/final-candidate-qa.mjs
python3 tests/field-qualification.test.py
python3 tests/android-build.test.py
python3 scripts/audit-native-candidate.py --output /tmp/nova-apk-audit.json
```

Run SDK tests alone while they alter generated staging. Never run competing
packaging checks against those temporary bytes. Fetch `5169d7b` read-only if
its Git objects are missing; the snapshot verifier needs them. A fresh
qualification record needs a new output filename, current committed inputs
and the owner's existing authorisation reference.

Field support: [field-support-runbook-v1.md](field-support-runbook-v1.md).
Backend application/recovery and Car B sequence: **Claude's
[release-runbook-v1.md](release-runbook-v1.md)**.
Explicit integrator/negative-run list:
[batch-15-2-integrator.md](../codex-files/handoffs/batch-15-2-integrator.md).
Stop at 15.2. Applying/publishing any release requires separate owner instruction.
