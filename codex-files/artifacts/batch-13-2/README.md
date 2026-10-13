# Batch 13.2 preparation evidence

Read `tests/android-core-qualification.md` and
`docs/plans/android-core-qualification.md` for outcomes and execution steps.

- `summary.json`: categories, final passing checks and unrun work.
- `run-final.json`: canonical isolated-candidate inventory and 16 UNRUN cases.
  Other `run*.json` files retain inventory history, not device runs.
- `core-journey.txt`, `results.json`, `car_*-closing.png`: five composed
  browser-double journeys; no integrated/backend/device claim.
- `field-dispatch.txt`, `field-load.txt`, `field-completion.txt`: 121 affected
  browser regression checks.
- `record-validator.txt`: 14 Python consistency checks, not device testing.
- `work-date-fault*`, `journey-before-fix.txt`: deliberate regression and
  earlier discovery, separate from final normal results.
- `android-build-tests.txt`, `android/`: six actual SDK/Gradle checks,
  including guard rejection of deliberately stale generated assets.
- `apk-inspection*`, `debug-signature.txt`, `cap-sync.txt`: local debug APK
  packaging/signature evidence. No APK binary is published.
- `device-gate.txt`: expected rejection of a device claim without prerequisites.
- `scope.txt`: unchanged backend/API/contracts/shared/integrator boundaries.

All physical cases, emulator execution, integrated backend and production
remain UNRUN. Screenshots contain synthetic test data. No actual provider
message, migration, merge, data/grant/settings change or deployment occurred.
