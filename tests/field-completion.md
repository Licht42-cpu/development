# Batch 11.2 — reviewed completion, evidence and recovery

Branch: `codex/batch-11-2`. Starting SHA:
`abf1743a7d823366dc88f8b56a437a7c04c8b3b6`. The first commit on this branch,
`10d3f1b`, carries forward Codex's already tested original-photo/dictation
work from `6d86fde`; it cherry-picks only Codex's own work. The completed
10.2 interface and Claude's 12.1 prompt remain present.

Backend source/contract read at Claude's `11a45c2` (completion implementation
`32963a3`). `docs/completion-evidence-contract-v1.md` is frozen v1. No Claude
implementation, migration, contract or backend test was merged or edited.

## Field behaviour

- Completion is an accessible two-step review with an explicit declaration,
  Submit and Cancel. Escape/Android overlay Back, leaving the route, account
  changes and connection changes close the review without submitting. Once
  Submit has saved a request, dismissing the review cannot cancel a server act.
- The direct field `completeJob()` call is removed. The field status picker
  cannot set `completed`; acceptance is derived from the server receipt.
  Existing measurement exit/save guards still run before review.
- Job/policy versions are quoted from the rendered readiness, not refreshed
  immediately before sending. Separate requirement reads are fenced by the
  existing `ns_evidence_policy_version` helper; a policy changing mid-read
  cannot produce a mixed reviewable snapshot. The backend remains the final
  authority for evidence, permissions, consumption and pricing.
- Service requirements show satisfied/short/excepted/unconfigured, coverage,
  proposed/advisory versus owner-confirmed/blocking and geotag requirements.
  Unknown required counts remain unknown. Winter proof uses the owner's
  policy; no new minimum/GPS rule is invented.
- Photo registration uses a confirmed attachment ID and a supported purpose/
  service scope. One uploaded photo can deliberately be registered for two
  scopes. On-file evidence that counts towards no per-service requirement is
  visible with its explanation. Frozen uploaded evidence is refused before
  calling the legacy delete API, including keyboard activation.
- A displayed watermark is a **device claim**, not a server fact or a claim
  burnt into the original image. Missing capture time/GPS remain unknown or
  explicitly denied/unavailable. Location collected at review is never
  promoted to a capture geotag. Server receipt time stays separate.
- Optional work-finish time is an explicit device-local report; blank stays
  null/unknown. It is never filled with the time the screen opened.
- Material usage requires explicit physical location, operating unit and
  exact/estimated accuracy. Completion's level vocabulary is full/part/low/
  empty; it is not converted into the stock/day-end Enough vocabulary or a
  number. Reservation matching and already-consumed no-double-debit rules
  stay in the backend. An unused item has no positive consumption line.
- Additional work is a description for owner review, with no price or crew
  approval. Accepted evidence/consumption history is read-only; corrections
  and owner exceptions are displayed as server facts. Owner reopening is
  distinct from editing the old receipt. Separate staff/customer-visible
  Notes and reviewed dictation remain available.

Original bytes, prepared copies, resumable capture and reviewed dictation
come from the preserved earlier increment: [field-evidence.md](field-evidence.md).
Successful photo uploads now retain a known attachment ID on the local
original when the upload actually returns it; uncertain uploads are not
matched to an ID by filename, time, path or guesswork.

## Exactly one new outbox type

`completeJobWithEvidence` joins the existing Passport, measurement, photo and
signature types in `ns-field-outbox`. There is no second sender or queue.
The full request/key commits before I/O. Offline completion is **provisional**,
never an optimistic accepted job status.

New records use states queued/sending/conflict/needs-review. Needs-review
distinguishes an explicit refusal from an unknown outcome. Stale policy/job,
evidence and changed-intent conflicts stop automatic replay. Unknown outcomes
and interrupted sends recover only through an explicit identical-key retry;
they cannot be discarded or replaced by another request. A refused request
can be explicitly removed while its draft/evidence remains, followed by a
fresh read/review. Earlier queue rows remain ordered dependencies.

Acceptance atomically stores the receipt in the existing lifecycle store and
removes its queue row. The frozen `completion` is displayed as history; cached
current `job/readiness` is not represented as fresh server state. Permission
loss hides cached private history while preserving owned request/draft bytes.
Accepted local history is bounded to 200 records; pending rows are never evicted.
Original-photo limits remain 40 records/50 MB, and ordinary draft limits remain
100 KB per record/200 records. Storage failures prevent sending or leave an
unknown request recoverable; nothing announces durability before commit.

The physical IDB version stays 3. **Marker recordVersion 2 is activated
atomically only when a completion is actually queued.** Unchanged old rows
and File/Blob bytes are retained. Apps from before 11.2 reject marker 2 safely;
new code accepts marker 1/2 and rejects unknown future markers/record formats.
This activation requires no database/store migration or rewriting legacy data.

Evidence registration is online-only, after upload yields an attachment ID.
Its single immutable request-recovery journal lives with ordinary job drafts;
there is no automatic sender. A lost registration response preserves the
original attachment/purpose/scope/key, rather than initiating another upload.

## Evidence and limits of verification

| Selected suite | Final passed |
| --- | ---: |
| Registered regression | 391, plus geofence |
| field-completion | 35 |
| field-evidence | 31 |
| field-load | 41 |
| load-prep | 16 |
| offline-work | 47 |
| field-resilience | 27 |
| mobile-reliability | 22 |
| native-readiness | 24 |
| native-startup | 18 |
| native-packaging | 19 |
| native-bundle | 10 |

681 unique counted local checks plus geofence. Final failures: 0. Skipped: 0.
Two deliberate current fault injections each produce one **expected failure**:
quote the wrong job version; omit the marker-2 activation. These are separate
from passing runs and are not counted as skipped or successful product checks.

The new suite uses real Chromium IndexedDB, including a full browser-process
restart, same-key lost-response recovery, mixed legacy File/Blob draining,
old-app refusal, quota-before-send, inaccessible history, frozen photo removal,
stale/permission/evidence conflicts and policy changing during reads.
Earlier unsuccessful runs exposed hidden registration feedback and a modal
obscuring unknown-outcome recovery; both were corrected. A pre-existing offline
draft assertion now waits for its async-rendered Note before checking the
same persisted content; its assertion was not weakened.

The 14-scenario backend-generated snapshot is copied byte-identically into
`tests/data/field-completion-v1.json`, outside Claude's fixtures directory.
SHA-256: `85e9b74e087f76514e0d8363efd2e92806ec7c96a1cf11cb820529dc2f30e0ca`.
SDK/readiness/receipt test compositions are browser doubles, not fresh database
or authorization proof. The legacy validator snapshot is Codex's own file at
`19550a6`, making downgrade tests independent of fetching Claude.

Touch and keyboard controls are exercised at 390/430/1200px, with inspected
review, evidence and accepted-state PNGs. Scoped component screenshots hide
the unrelated sticky topbar during capture to avoid stitching artifacts;
functional overflow/header/keyboard checks still use the actual page.

Cap sync and asset verification, actual Gradle assembleDebug/preBuild guard,
APK byte/manifest inspection and debug-signature verification pass. The APK
contains 155 staged files plus two generated Cordova stubs. Existing min SDK
24, target SDK 36 and permissions are unchanged. No APK is published.

**UNRUN:** database suites/rehearsal and live Supabase/production integration;
physical Android hardware Back/TalkBack, microphone/native capture/location
permissions, storage eviction and cellular behaviour; emulator and release
signing. No adb/emulator attempt is repeated. Clipboard/maps/dispatch work is
not added here. Fixture replay proves the client reuses the key; it does not
independently prove backend stock conservation or access enforcement.

## Reproduction and integration

Run a static server at repository root on port 8743. Environment paths:

```sh
export PLAYWRIGHT_MODULE=/workspace/.nova-shield/test-tools/node_modules/playwright/index.mjs
export PLAYWRIGHT_CHROMIUM=/usr/bin/chromium
export NODE_OPTIONS='--loader /workspace/nova-shield/codex-files/tooling/test-loader.mjs'
node tests/field-completion.test.mjs
node tests/field-evidence.test.mjs
node tests/load-prep.test.mjs
npm test
npm run cap:sync
npm run verify:mobile
python3 scripts/android-build.py build
python3 tests/android-apk-inspection.py
```

Restart the static server after npm test, which stops/replaces it. Run
sync/build/asset-mutating suites sequentially. Expected failure commands:

```sh
COMPLETION_BREAK=versions COMPLETION_ONLY='confirmation quotes' node tests/field-completion.test.mjs
COMPLETION_BREAK=marker COMPLETION_ONLY='active marker' node tests/field-completion.test.mjs
```

Integrator: add **field-completion** and **field-evidence** alongside the
unregistered field-load, load-prep, offline-work, field-resilience,
mobile-reliability, native-readiness, native-startup, native-packaging and
native-bundle suites. Measurement-entry is already registered. Keep Claude's
admin/backend suites and SDK/device/integration work separately selectable.
`tests/run-regression.sh` remains unchanged. Current raw evidence is committed
under `codex-files/artifacts/batch-11-2/`; earlier capture evidence remains
historical under its original folder.

## Cross-contract item for integration

Completion contract at `11a45c2`, lines 442–445, describes unassigned jobs as
belonging to whoever is working (the one-crew rule), while daily-load v2.1 §10
excludes unassigned work from both plans with two vehicles. Reconcile that
authorization/dispatch rule in Claude's 12.1 before enabling a second crew;
this branch invents no replacement backend rule. This is a source/contract
observation, not a new disposable-database reproduction. The migrations remain
unapplied; their application and cross-track integration are separate work.

No live migration, grant/data/settings change, external message, merge of
Claude, deployment or later batch implementation occurred. Stop after 11.2.
