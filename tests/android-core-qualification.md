# Batch 13.2 — preparation results and remaining Android qualification

**Status: preparation complete; Android runtime qualification remains UNRUN.**
The owner confirmed there is no integrated candidate or device/emulator
connection. This is not a completed physical-device batch or a release claim.

Branch: `codex/batch-13-2`. Base:
`a0b87cdbc949611dfa1597abbdecaa23f1b3a9b1`.
Reviewed preparation candidate:
`03ead8a` (full SHA in `run-final.json`).
The final handoff commit adds findings and evidence only; application assets
are identical. No merge, rebase, cherry-pick, backend migration or deployment.

## One product defect found and fixed

Dispatch's Review vehicle load link passed `date=`, but `renderFieldLoad`
reads `day=`. On a clean device, opening an explicitly selected dispatch
day could fall back to the device date or an unrelated saved selection.
The link now passes `day=` using the server-rendered dispatch work date.
It preserves the vehicle and adds no client-side bucketing/pricing logic.

`tests/core-journey.test.mjs` follows the actual link using keyboard Enter
and asserts the resulting RPC's `p_work_date`, then the visible date. Restoring
the old URL fails that assertion: 0 pass / 1 declared expected failure.
The before-fix run and the deliberate reversion are recorded separately.

## Reusable qualification work

- `docs/plans/android-core-qualification.md`: full 16-case runbook covering
  Base→car→field→sync→closing, two-car scope, startup/Back/keyboard, offline
  process restart, camera/originals/storage/share, location, TalkBack, cellular
  failure, upgrade/replay, account separation and frozen history.
- `scripts/field-qualification.py`: read-only Git/build/target inventory,
  per-case UNRUN template, and evidence-record validation. It starts no adb
  server/emulator, installs nothing and contacts no backend.
- `tests/field-qualification.test.py`: 14 record-consistency checks against
  false promotion of missing cases, browser/emulator outcomes, wrong candidate,
  unbound APKs, corrupt/path-escaping evidence and incomplete target metadata.
  The validator checks consistency, not the truth of an operator's report.
- `tests/core-journey-fixture.mjs`: optional reuse of the existing browser
  fixtures in one context; their default standalone behavior is retained.
  It composes independently generated load/completion/dispatch snapshots,
  normalizing job, vehicle and date identities for screen interaction.
  Pre-submit completion locks/open state are explicitly normalized from the
  generated unconfigured scenario. This is not a generated backend journey.
- Five browser checks: selected-date handoff; Car A and Car B checked loading,
  visit, accepted completion and estimated closing count; offline reviewed
  finish/restart/replay; and lost completion response with original-key recovery.
  Doubled counters prove mock effects, never real stock/grant correctness.

The affected completion suite exposed a selector ambiguity when the refusal
sentence was visible in both the review dialog and the persistent panel.
The assertion is now scoped to the persistent panel; stored `refused`,
`needs-review` and absent acceptance assertions are retained. No failure
assertion or application permission check was removed.

## What ran in this batch

| Category | Outcome |
|---|---|
| New core browser journey | **5 passed / 0 failed / 0 skipped** |
| Affected dispatch / load / completion suites | **45 / 41 / 35 passed**, 0 final failures/skips |
| Record-validation Python checks | **14 passed / 0 failed** |
| Real Android SDK/Gradle qualification | **6 passed / 0 failed** |
| Deliberate URL regression | **1 expected failed browser check**, separate from passing counts |
| Deliberate stale-asset assemble | **Rejected at `:app:verifyNovaAssets`**, before compile/package; restored assemble passes |
| Physical qualification record gate | **Expected rejection**, not an application failure |
| Capacitor sync | Passed; existing 160-asset guard remains intact |
| APK inspection | Passed: 161 staged files and 163 APK public files, including the two expected empty Cordova stubs |
| APK debug signature | Verified, v2 signature; no release signing/publication |
| Required physical cases | **0 passed / 0 failed / 0 skipped / 16 UNRUN** |
| Integrated backend / emulator / live Supabase / production | **UNRUN** |

SDK timing: fresh preBuild 14.12 s; stale assemble rejected in 15.89 s;
restored assemble 16.93 s. The APK SHA-256 is
`25401ae742d404258b01a74a42c6338c494b79f44249ecf0c7a6c4aa03afc0ef`.
Its manifest remains min SDK 24 / target SDK 36 with unchanged permissions;
FileProvider is private and grants URI access. Those are compiled manifest
facts, not verified Android dialogs or inter-app sharing behavior.

The broader 726-check 12.2 run is historical, not rerun or counted here.
This batch's tests remain separate from backend/database integration suites.
The mock Car B case supplies fixture metadata only; no vehicle row is seeded
or activated and no second real crew is enabled.

## Exact current blockers

`run-final.json` records the actual preparation SHA, a clean tracked tree,
Codex 12.2 inclusion and **no Claude 12.1 ancestry**. The owner provided no
authorized integrated candidate. `master` inspected at `fbf2568` is a branding
commit; no integration branch was listed. No source was merged to manufacture
an integrated qualification claim.

Android doctor reports Java/Javac 21, a complete API 36 build SDK and fresh
assets. However, `/home/agent/.android` is not writable, and the existing
adb wrapper refuses to run without that real-home configuration directory.
`HOME` is preserved. No emulator binary or installed system images exists;
`/dev/kvm` and `/dev/bus/usb` are absent. `ANDROID_SERIAL`, `ADB_SERVER_SOCKET`
and `ANDROID_AVD_HOME` are absent. No adb connection, install, emulator start
or device enumeration is claimed.

Consequently model/OS/real app version/operator/device timestamp remain null
in the template. Hardware/gesture Back, camera permission behavior, TalkBack,
storage eviction, real cellular impairment and all 16 handset cases remain
UNRUN. Earlier browser doubles cannot fill them in.

The known backend unassigned-job policy difference remains Claude's to
reconcile before a second crew is enabled. Twenty-four pending migrations
were last reported by Claude; this batch did not query or change the live
project or rehearse that sequence. An integrated/test backend and explicit
permission for any future application window are separate prerequisites.

## Evidence and continuation

`codex-files/artifacts/batch-13-2/summary.json` is the current category summary.
`run-final.json` is the canonical preparation record; earlier `run*.json`
files are retained as inventory history, not additional device runs. The record gate
refuses both because neither has an authorized integrated candidate or target.
APK/staging assets are bound to the recorded preparation Git commit;
`assets_match_commit` and `apk_matches_staging` are both true.

Individual browser/unit logs, generated-fixture screenshots, SDK preBuild/
expected-failure/restored-build output, manifest inspection and signing output
are in the same directory. No APK binary, credentials, live customer data or
hardware serial is published. Logs may have trailing whitespace normalized;
their results and task order are retained.

Integrator additions: `core-journey.test.mjs` in the selectable mocked-browser
list, `field-qualification.test.py` as record checks, and the existing
`android-build.test.py` as SDK/Gradle checks. `tests/run-regression.sh` remains
unchanged. The actual Android run can resume using the committed runbook once
an owner-authorized integrated SHA/test backend and a target are available.
Do not start conditional 14.x or treat this preparation as release approval.
