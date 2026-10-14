# Batch 15.2 integration and qualification entries

Use `codex/batch-15-2`. Claude's unchanged source is pinned to
`5169d7bf18e99e10855b47da2d12308d886f0fc9`; provenance is
[`integration-source.json`](integration-source.json). Do not replace the
Codex job view wholesale: its ordered-save/action guards are preserved.

## Explicit suites

`npm test` uses `tests/run-regression.sh`, with these 47 named suites:

```
phase2 phase3 phase4 phase5 phase6 phase7 phase8 phase9 phase10 phase10-5
phase11 phase12 phase13 phase14 phase15 phase16 phase17 phase18 phase19 phase20
phase21 phase22 phase23 phase24 phase25 phase26 phase27 phase28 phase29
geofence native-wrapper reload-offline measurement-entry mobile-reliability
field-resilience native-readiness native-bundle native-packaging native-startup
offline-work load-prep field-evidence field-load field-completion field-dispatch
core-journey operations-integration
```

`operations-integration` now has 34 cases, including fresh crew membership,
scoped denial and the unchanged claim API's key/revision parameters.
The final affected native suites are `native-bundle`, `native-packaging` and
`native-startup`; their prior runs preceded the latest dispatch wiring and
were rerun after staging was refreshed. Overlapping reruns are not additional
distinct checks.

Separately selectable qualification commands:

```
npm run cap:sync
npm run verify:mobile
node tests/final-candidate-qa.mjs
python3 tests/field-qualification.test.py
python3 tests/android-build.test.py
python3 scripts/audit-native-candidate.py --output /tmp/nova-apk-audit.json
```

Set the existing Playwright module/Chromium paths and historical Node loader
as described in the findings. Serve the repository on port 8743 for the
standalone browser QA. It executes staged application bytes with API/auth
transport doubles: it is **not** an authenticated live check. It has 20 cases
and records geometry, keyboard names/focus and full-page captures. Keep it
outside the shared runner because it requires a freshly synced staging copy.

The six SDK cases temporarily corrupt **generated** staging and restore it.
Run them separately from packaging/browser staging checks. The native audit
checks the APK's identity/version, six reviewed permissions (including pinned
transitives), exact dependency versions, source provenance and byte binding.
No APK is installed or published by these commands.

`codex-files/artifacts/batch-15-2/field-header-qa.mjs` reproduces three
browser-only header observations at 390/430/1280 with API/auth doubles. Keep
those observations separate from shared-suite distinct counts. The artifact
directory contains 57 full-page captures and the final summary/results.

Database suites, including the copied `tests/db/batch15-1.test.mjs`, remain in
the separate guarded disposable-PostgreSQL runner. They were not run in this
qualification. Do not add a blanket file glob to the browser runner.

## Declared fault probes

These are declared negative runs, not a way to relabel an ordinary failure:

| Fault | Command selector | Required rejection |
| --- | --- | --- |
| Restore pre-integration routes | `OPERATIONS_BREAK=routes OPERATIONS_ONLY='Inventory is reached by keyboard' node tests/operations-integration.test.mjs` | exit 1; Inventory unreachable |
| Restore editable note before persistence listener | `OFFLINE_BREAK=note_ready OFFLINE_ONLY='A note cannot be edited before its draft listener is ready' node tests/offline-work.test.mjs` | exit 1; note incorrectly enabled |
| Restore empty-queue “Synced” | `FINAL_BADGE_BASELINE=1 FINAL_QA_ONLY='empty device queue' node tests/final-candidate-qa.mjs` | exit 1; accurate queue label absent |
| Restore owner-only dispatch gate | `OPERATIONS_BREAK=crew_gate OPERATIONS_ONLY='freshly checked crew' node tests/operations-integration.test.mjs` | exit 1; crew claim unreachable |
| Deliberately stale staging | SDK suite `test_02_stale_staging_stops_assemble_at_guard` | real `:app:verifyNovaAssets FAILED` before compile/package |

Negative source responses are fixture overrides; production sources are not
temporarily reverted. Keep their evidence apart from normal pass counts.
The qualification record's `--require-device-pass` rejection is a separate
gate result, not a passed handset case.

## Preserved boundaries

31 source migrations follow the historical `20261009013557` cutoff; all remain
unapplied according to the owner's brief. The anonymous live read probes
corroborate missing RPCs, not the complete migration history. Use Claude's
release runbook for actual backend application/recovery and second-crew order.

The three Claude-owned inventory/property/load-selection findings remain open.
No migration, contract, API, component or phase suite was independently edited.
The dispatch wrapper admits crews through fresh `is_admin` and vehicle-scoped
reads; inventory/property/handover management retain their owner gate.

All 16 handset cases remain UNRUN. Batch 14.2 is conditional and was not
authorised. No merge, live change, customer message, deployment or APK release.
