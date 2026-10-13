# Batch 13.2 — Android core qualification runbook

This is an execution checklist, not a release approval. It covers one crew
and at most two separate cars. Claude owns backend/admin work; Codex owns
field/mobile qualification. No merge, production migration, live data/grant
change, deployment, customer message or APK publication is authorized here.

The owner confirmed no integrated candidate or Android target is currently
available. Run supported preparation checks now; keep all Android runtime
cases UNRUN. Browser doubles, compilation and record-validation tests must
never be substituted for a handset result.

## Candidate and target before a device run

1. Identify the exact owner-authorized integrated Git SHA and the backend
   project/build it is intended to use. Required minimum source tracks are
   Codex 12.2 `a0b87cd` and Claude 12.1 `b21d082`, plus the 13.2 field fix.
   Git ancestry is necessary evidence of inclusion, not proof of correct
   conflict resolution, complete migrations or deployment. This runbook
   grants no permission to merge branches or apply migrations.
2. Resolve the acknowledged unassigned-job authorization difference before
   enabling a second real crew. `can_work_job` and dispatch's
   `ns_can_work_job` are not presently the same policy. Record which reviewed
   backend revision is used and its migration status. Do not enable Car B
   or invent an operating timezone just to make a test pass.
3. Use an explicitly authorized test account/project and synthetic jobs,
   quotes, photos and inventory. Use an explicitly disposable database with
   its existing fail-closed production guard if backend fixtures are needed.
   No customer messages: provider double or a separately authorized sandbox.
4. Produce the debug APK from that candidate, record its SHA-256, inspect the
   packaged assets and manifest, and verify its signature. Record actual app
   version/build, device model, Android OS/API, operator and timezone-bearing
   test timestamp. Do not use API 36 from the compile target as the handset's
   OS version. Emulator results get their own record and cannot pass the
   physical-device gate.
5. Confirm access to a real device or an already available emulator. The
   current cloud machine has no emulator/system images, no `/dev/kvm` or USB
   bus, and adb's real-home configuration directory is not writable. Do not
   change `HOME`, disable TLS/proxy checks or claim a connected-device list
   without actually running a permitted probe. SDK/build readiness does not
   supply a device.

## Required journeys and expected outcomes

Use the ids in `scripts/field-qualification.py` when recording observations.
Keep notes about the action attempted, the actual result and its evidence.

| Case | Steps and required observations |
|---|---|
| `single_crew_day` | Owner prepares one reviewed Car A day; crew checks Keep/Add/Return physically and confirms the rendered revision/fingerprints. Open ordered dispatch, the right work date, entrance/hazard/parking, then a visit. Record evidence/usage, deliberately review and submit completion, inspect its accepted receipt, then reconcile end-of-day live usable stock. Do not count viewing a plan as loading or a finish tap as acceptance. |
| `two_car_scope` | Two separate accounts/cars and explicitly assigned synthetic jobs; one scarce washer cannot be promised twice. Unassigned work belongs to neither plan. Wrong-car access refuses, revealed/cached details retire, and changing dispatch invalidates both affected loads without moving stock or erasing confirmed history. Assignment and physical presence of seasonal sets remain distinct. This requires Claude's policy reconciliation first. |
| `startup_recovery` | Cold launch and process restart. Exercise missing/stale assets and recovery only on a disposable local build. Recovery retains queued operations and original bytes; it cannot display a false loaded schedule. Record the app/OS behavior rather than the browser bootstrap alone. |
| `back_keyboard` | Open quantity editing, photo markup and completion review; show keyboard, use gesture/hardware Back, Cancel and repeat. Dismiss keyboard/overlay before navigating or exiting. No cancellation submits a completion, and focus returns to a useful control. |
| `cached_restart` | Explicitly save visits plus dispatch notes/pins/zones. Airplane mode, kill process, relaunch and open the correct saved day/job. Age/assignment caveats stay visible. Codes/private internal notes are excluded from dispatch storage. Expired or denied reads do not reopen old working details. |
| `camera_originals` | Exercise camera/photo picker, cancellation and the actual platform prompts. Original bytes and a separate prepared copy survive interruption/restart. Unknown capture time/GPS remains unknown; a later location read does not become a capture geotag. Report cancelled/unavailable camera honestly. |
| `storage_pressure` | On a disposable device/profile, induce quota pressure or supported storage eviction and interrupt a store upgrade. Pending payloads/Blobs must not silently vanish or be reported synced. A newer format fails closed. Record what the OS actually evicted; browser simulations are separate. |
| `share_uri` | Open the real Android share sheet with an authorized synthetic artifact. Confirm destination-app access to the granted private URI; cancel as well as complete handoff. Showing a sheet is not proof of customer delivery. No public storage permission or provider success is invented. |
| `location_states` | Deny permission, choose approximate location where supported, disable services and test a stale/poor fix. No proximity event confirms arrival automatically. Local crew arrival is explicitly not synced/GPS-verified. Evidence watermark stays a device claim, with unknown/unavailable states preserved. |
| `talkback` | Use actual TalkBack on loading, property disclosures/vertices, issue reasons, photo review, completion confirmation and pending/refused controls. Record spoken names, traversal/focus, traps and a representative screen recording. Keyboard-only Chromium checks do not prove TalkBack. |
| `bad_cellular` | Record the actual connection and impairment method. Exercise delay/drop, online-but-unreachable, a request accepted before its response is lost, and foreground/background transition. Recover the identical operation id/payload. Refusal and conflict stay distinct from no response. No invented automatic retry or second sender. |
| `offline_sync` | Confirm morning loading online, prepare visits, capture original photo, measurement and reviewed provisional completion offline. Restart. Reconnect deliberately and inspect one accepted receipt for each original operation. Verify actual backend effects, including no second completion, stock debit or duplicate message. |
| `upgrade_replay` | Use specifically identified old/new local app builds with a seeded synthetic outbox. Record original keys and payload/Blob hashes. Upgrade retains the old four operations; completion marker activation is atomic. Downgrade refuses newer records without deleting them. Do not uninstall/clear data as a recovery shortcut. |
| `account_separation` | Leave owned unsent work, sign out online or switch accounts, and revoke test access server-side. Another actor cannot read cached private work or replay the first actor's queue. Offline/rejected sign-out is not reported successful. Recovery returns only to the original authorized account. |
| `closing_accounting` | Complete recorded consumption, then count live usable inventory at the car. Exact stays exact and estimate stays estimated. Damaged moves usable to damaged, not disappearance; positive damaged variance refuses. Quantity units/levels stay distinct, and reservations or prior consumption cannot debit twice. These effects require backend evidence, not a visual total. |
| `frozen_history` | Accepted completion/evidence and sent/accepted quote money/labels/customer content remain frozen. Internal notes retain intended editability. Corrections/reopen are attributed additions, not silent history rewrites. Proposed/advisory evidence policy does not become blocking; the seven unresolved policy questions remain unresolved. |

All required physical cases must pass for a physical qualification claim.
UNRUN, SKIPPED and declared expected failures are separate statuses; reasons
are required and none replaces a pass. A failure stays a failure until fixed
and rerun with new evidence. Do not infer supplier specs, dosages, cutoffs,
pricing formulas, missing Phase D content or owner business-policy answers.

## Execute available preparation now

From repository root, using the existing toolchain:

```sh
export PLAYWRIGHT_MODULE=/workspace/.nova-shield/test-tools/node_modules/playwright/index.mjs
export PLAYWRIGHT_CHROMIUM=/usr/bin/chromium
export NODE_OPTIONS='--loader /workspace/nova-shield/codex-files/tooling/test-loader.mjs'
export PYTHONDONTWRITEBYTECODE=1
node tests/core-journey.test.mjs
python3 tests/field-qualification.test.py
npm run cap:sync
ANDROID_BUILD_EVIDENCE=/tmp/nova-android-13-2 python3 tests/android-build.test.py
python3 tests/android-apk-inspection.py --evidence /tmp/nova-apk-13-2.json
```

Start a repository-root static server on port 8743 for browser tests. Keep
the actual process/server readiness separate from persisted files; restart
it after `npm test`, whose runner owns and stops that port. Use the existing
test loader and keep `tests/run-regression.sh` unchanged.

The core browser journey composes the existing load/completion/dispatch
doubles into one session. Generated snapshots are normalized for compatible
job/car/date identities; they are not a new authoritative backend fixture.
It exercises screen handoffs and durable replay, not real ledger/grant
correctness, device networking or customer delivery. Its regression on the
dispatch→load date must fail if `day=` is reverted to `date=`.

The SDK suite runs real Gradle `preBuild`, deliberately makes staging stale,
asserts rejection by `verifyNovaAssets` before compilation/packaging, restores
the bytes in `finally`, and assembles again. Run it alone relative to any
asset-mutating packaging tests. Signature verification remains the existing
`apksigner verify` check. Compile/sync/inspect results are not Android runtime.

## Create and validate a run record

```sh
python3 scripts/field-qualification.py prepare --output /tmp/nova-13-2/run.json
python3 scripts/field-qualification.py validate /tmp/nova-13-2/run.json
python3 scripts/field-qualification.py validate /tmp/nova-13-2/run.json --require-device-pass
```

Preparation inventories Git provenance, build readiness and APK/staging/
committed-source binding without starting adb, installing anything or
changing data. It refuses to overwrite an existing record. The final command
is **expected to reject** the current isolated/no-target preparation record;
that is a qualification gate, not a failed application test.

For an actual authorized device run, copy the template into its own evidence
directory, fill real target/authorization metadata and actual steps/results,
and reference evidence by a relative file path plus SHA-256. The validator
refuses missing/duplicate cases, missing/corrupted/outside-directory evidence,
unbound APKs, omitted target data and emulator/browser substitutions.
It checks record consistency, not whether manual observations are truthful
or whether the cited owner authorization exists. It performs no action based
on an untrusted record, grants no release approval and is not a test device.

Inspect recordings/logs for customer contact details, access codes, tokens
and private photos before committing evidence. Prefer synthetic data and
redacted case notes; preserve provenance/hash information. Keep real serials,
account credentials and service keys out of repository evidence.

## Integrator handoff

New separately selectable checks: `core-journey.test.mjs` (browser doubles)
and `field-qualification.test.py` (record consistency). Existing
`android-build.test.py` stays an SDK/Gradle suite. Run these independently of
database integration suites and keep provider/device/production outcomes in
their own categories. No global runner change, integration branch or release
is created by this batch.
