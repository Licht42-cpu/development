# Batch 10.2-prep — persistence and contract groundwork

Base **e4259466087850a503cd5f6884fe54a22f72ebd1**, branch
`codex/batch-10-2-prep`. Read-only seasonal review is pinned to Claude
**abedf0f6e3eb1fda2fd336c5dd34186f8340b4b0**. No Claude merge, migration,
live probe, deployment or APK publication occurred.

## Implemented scope

`ns-field-outbox` upgrades from IndexedDB v1/v2 to **v3** atomically in its
versionchange transaction. Existing `queue` records, primary keys,
auto-increment sequence, unknown legacy fields, File metadata and Blob bytes
are untouched. The owner index is added only if missing. Missing/malformed
old queue shapes fail rather than being replaced with an empty queue.

The separate `schema` store carries storage/record versions. The separate
`lifecycle` store has owner/state indexes and room for future records.
Queued / accepted / conflict / needs-review are four distinct exported
states, **unused by the existing four handlers**. Pending/sending/uncertain
semantics and uncertain-send review for those handlers remain unchanged.
The lifecycle store remains empty during their replay. Its schema is local
storage metadata; it is not a guessed backend operation or receipt.

New types fit the generic queue envelope, but none was registered. The
future reviewed handler must define payload/receipt validation and advance
the logical schema marker before an incompatible writer uses these stores;
an old reader must fail closed. This can use a transaction without another
IndexedDB store/version upgrade. No future payload field names are defined.

Known v2 account-owned actions drain after upgrade. Ownerless v1 rows remain
intact and blocked: assigning them to the current account would break account
separation. An interrupted upgrade rolls back the new stores; retry upgrades
the old records. Future IDB versions, downgraded opens, unknown storage/record
markers and storage errors preserve unsent work. Schema errors remain
storage errors even in airplane mode.

The local `/load` entry point and its descendants are disabled before both
online and cached routing, **after** flushing measurement edits. A deep link
returns to the working schedule; no load renderer, controls, adapter or
handler ships. Existing Back behaviour remains covered by mobile reliability.

Ten local scenario wrappers under `tests/fixtures/load-contract/` describe
seven roadmap cases plus permission, shortage and lost-response cases.
Reading their contract examples throws an explicit TODO. They contain no
invented RPC, plan/revision, request/response fields or stock fixture values.

[Seven numbered seasonal findings](../docs/reviews/seasonal-contract-abedf0f.md)
cover replay scope, accounting, suffixed-key provenance, retirement before
release, assignment versus physical loading, nullable availability and replay
semantics. All nine signatures/defaults match; the old stock definitions
were not replaced. These are source findings for Claude, not DB reproductions.

## Verification and evidence categories

Current accepted runs:

| Suite | Passed | Failed |
| --- | ---: | ---: |
| load-prep (new) | 16 | 0 |
| offline-work | 47 | 0 |
| measurement-entry | 29 | 0 |
| mobile-reliability | 22 | 0 |
| field-resilience | 27 | 0 |
| native-readiness | 24 | 0 |
| native-startup | 18 | 0 |
| native-packaging | 19 | 0 |
| native-bundle | 10 | 0 |

The unchanged registered runner passes **391 counted checks plus geofence**.
Its measurement-entry checks are already in that 391. Adding the eight
unregistered owned suites (183 checks) gives **574 unique counted checks plus
geofence**, not 603 by counting measurement-entry twice. Android assembly,
asset/manifest inspection and signing are separate qualification results.

The new suite uses Chromium IndexedDB with intercepted existing APIs. It
seeds v2 with all four old action payloads and verifies unchanged binary
bytes before sending; every handler drains exactly once and a second flush
adds no writes. It also checks v1 quarantine, interrupted upgrade rollback,
unknown future/downgrade/schema versions, separate unused states, preserved
auto-increment keys, concurrent replay, and the disabled route online/offline.
At **390/430px** it proves entry waits for measurement persistence and checks
touch opening, keyboard navigation and overflow using existing visit controls.
The two final screenshots were inspected; no new load control exists.

Two intentional test-only fault probes fail: clearing queue rows fails the
preservation assertion (1 check); bypassing the disabled gate fails offline
deep-link assertions (2 checks). No source file was reverted or mutated for
these probes. They are expected failures, separate from accepted passes.

The first field-resilience run was 26/27: an async `waitForFunction` predicate
returned a truthy Promise and did not wait for replay to finish. The owned
fixture and retry test now poll synchronous sync state, then verify actual
IDB count. The corrected 27/27 run preserves the two ordered-write assertion;
no handler was changed to accommodate that test. The migrated legacy-data
fault hook now targets `outbox-schema.js`, so it still detects deletion.

**Skipped:** no selected mocked check skipped. **UNRUN:** Claude database
suites/rehearsal and live integration/production (outside authorized scope);
emulator/device tests (no emulator/device, read-only adb home; no repeated
attempt); release signing/publication (debug artifact only). Native storage
eviction/restart, permission dialogs, Back hardware, camera, TalkBack and
cellular remain physical-device work. See [Android's consolidated status](android-build.md).

Android setup draft remains unpublished. Capacitor sync and the real Gradle
guard/assemble passed again. Device-free inspection checks current packaged
assets, merged/binary manifest and debug signing. The compiled APK remains
ignored locally; it is not a device result. Prior stale-asset guard and clean
offline build evidence remains in its original artifact folders.

Current logs, result JSON, screenshots, APK inspection and source hashes are
under `codex-files/artifacts/batch-10-2-prep/`. The artifact manifest records
raw and normalized log hashes. Initial diagnostic failures are described
above; the archived accepted runs and expected-failure probes are labelled.

## Integrator suite list

Add **load-prep** to the explicit mocked suites alongside **offline-work,
native-packaging, native-startup, native-bundle, native-readiness,
mobile-reliability, field-resilience**. `measurement-entry` is already
registered. `tests/run-regression.sh` is unchanged. Claude's phase21–24 and
database suites belong to separate integration work, not this branch's
reported passes. Select **android-build.test.py** and
**android-apk-inspection.py** as SDK/build jobs separately from mocked and
database tests; build/sync/asset-mutating checks must run sequentially.

## Still needed before 10.2

Claude's frozen 10.1 load contract must define per-car/day identity, authorized
display rows and incomplete-data reasons, physically aboard stock/tools/sets,
named-set movement rules, compatible unit/condition/precision and reservation
bases, revision-checked confirmation and manual Keep/exception/closing
operations, shortage/permission/conflict errors, immutable retry intent and
accepted/replayed/lost-response receipts. It must also supply versioned
examples for these scenario slots. Seasonal assignment is not proof of loading.
Nothing in this preparation authorizes inferring those rules from stock RPCs.
Stop here; Keep/Add/Return implementation remains blocked on that contract.
