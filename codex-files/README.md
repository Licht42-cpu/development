# Codex files — complete Nova Shield handoff

Batch 11.2 is on `codex/batch-11-2`: [completion/evidence handoff](../tests/field-completion.md),
[current evidence](artifacts/batch-11-2/). It carries forward the earlier
original-photo/dictation increment and preserves completed 10.2. Claude's
backend stays independent; all current handoffs are committed here.

Current Batch 10.2 is on `codex/batch-10-2`: [crew load and closing handoff](../tests/field-load.md),
[browser/build evidence](artifacts/batch-10-2/). Code stays in the canonical
field paths. Claude's frozen v2.1 contract was read without merging its branch.
The branch includes committed plans and evidence for shared access.

Shared handoff on branch `codex/all-files-handoff`. This branch contains the
Codex application code in its normal repository paths, the revised plans under
`docs/plans/`, and the previously local material collected here. No Claude
branch was merged and no database/deployment action was performed.

## Batch 8.2 startup continuation

Branch `codex/batch-8-2-startup` continues the archived d33d17e work from the
handoff base. Current implementation is in the canonical app paths; see
[findings](../tests/native-startup.md) and [new evidence](artifacts/batch-8-2-startup/).
The original source/patch/handoff snapshots below remain historical. The
continuation's evidence has its own manifest, separate from the original
import manifest. Final verification: 511/511 counted checks plus geofence;
Android SDK/device/production/database verification remains unrun.

## Batch 9.2 offline continuation

Branch `codex/batch-9-2-offline-work` continues `1e320a6` independently of
Claude. Canonical field modules now retain bounded offline work, account-owned
drafts and recoverable writes using the original outbox. See
[findings and reproduction](../tests/offline-work.md),
[the current snapshot contract](../docs/field-snapshot-contract-v2.md), and
[follow-up evidence](artifacts/batch-9-2-read-contract/).
The supplied full brief was reconciled from `1695ce6`: separate reference
freshness, flags/pricing-rule metadata, seven-day horizon and blocked storage
recovery and immediate hiding after denied replay are now covered. Current
verification: 558/558 counted checks plus geofence, with 20 expected-failure
probes and nine inspected screenshots.
Initial [544-check evidence](artifacts/batch-9-2-offline-work/) is preserved.
Android compile/device, live database and production checks remain unrun.
The [next load-contract inputs](../docs/plans/batch-10-2-contract-readiness.md)
are documented without importing Claude's implementation or adding stock writes.

## Android build qualification

Independent branch `codex/android-build-qualification` starts at `27e5ab9`.
The real debug assemble and preBuild guard now run: three SDK-backed checks
prove fresh preBuild, stale-staging rejection before compilation/packaging,
and restored assembly with every staged file present in the APK. Packaging
19/19 and bundle 10/10 also pass. See [findings](../tests/android-build.md),
[setup helper](../scripts/android-build.py) and
[evidence](artifacts/android-build-qualification/). Emulator installation and
physical-device checks remain unrun. The APK is local and unpublished.

The integrator should select `tests/android-build.test.py` as a separate
SDK/Gradle job after setup/sync; it is not added to the mocked regression list.

The [follow-up evidence](artifacts/android-build-followup/) adds a clean
offline assemble (222 tasks executed), readiness diagnostics and JDK selection
checks, with 6/6 qualification tests passing. adb remains blocked by the
read-only home mount; this is distinct
from the passing native build and is explained in the findings.

## Contents

| Folder/file | Purpose |
| --- | --- |
| [plans](plans/) | Copies of the revised roadmap, operating blueprint and Claude prompt; maintained originals are in [docs/plans](../docs/plans/README.md) |
| [handoffs](handoffs/) | Mobile reliability, field recovery and native-readiness reports |
| [source](source/) | All 50 files changed by the four Codex implementation commits, captured at d33d17e; application code remains in its normal paths outside this folder |
| [patches](patches/) | Four committed patches, including code and tests, with their commit/parent metadata |
| [artifacts](artifacts/) | Recorded test logs, result JSON and screenshots for 6.2, 7.2 and the earlier 8.2 readiness work |
| [tooling](tooling/README.md) | Portable paths for reproducing the existing browser tests |
| [historical](historical/README.md) | Superseded roadmap, pre-commit handoff/patch and original environment-specific helpers |
| [manifest.json](manifest.json) | SHA-256, byte size, provenance and classification of every imported file |

Archived source snapshots are for inspection, not a second maintained app.
Do not import them into the running application or edit them to implement a new
feature. The root `admin/`, `shared/`, `tests/`, `scripts/` and Android paths
remain the actual source. Future changes should update those canonical paths.

## Implementation commits already pushed

The latest independent field increment is **codex/field-evidence-capture**:
[photo originals and reviewed dictation](../tests/field-evidence.md), with
[evidence](artifacts/field-evidence-capture/). It retains original image bytes,
uses explicit unknown capture metadata, and requires review before speech
enters a note. No fifth outbox handler is added. This is partial 11.2 work;
the load corrective and full completion integration remain separate.

The latest preparation branch is **codex/batch-10-2-prep**, based on
`e4259466087850a503cd5f6884fe54a22f72ebd1`. Its handoff is
[tests/load-prep.md](../tests/load-prep.md), with a
[read-only seasonal review](../docs/reviews/seasonal-contract-abedf0f.md) and
[new evidence](artifacts/batch-10-2-prep/). It upgrades existing local storage,
keeps `/load` disabled and provides throwing scenario placeholders. No load
interface or fifth action ships. The Android status is consolidated in
[tests/android-build.md](../tests/android-build.md); its setup draft stays
unpublished. The explicit integrator list now includes **load-prep**.

| Work | Commit | Remote branch |
| --- | --- | --- |
| Ordered/recoverable measurement entry | f4cdbe552ebd4289920fe533af10371a1d4c7f0d | codex/measurement-reliability |
| Mobile actions/exit and touch reliability | d71f467ca72160092ef3b3ace2e50ae63bd512ee | codex/batch-6-2 |
| Field load recovery and actionable outbox | a8b573f9b9f61b900ede70ff7affd3b04eb67ba9 | codex/batch-7-2 |
| Native packaging audit/accessibility | d33d17ec0b98654e42db1e8adda70580e9931b42 | codex/batch-8-2 |

These form one linear Codex implementation history based on
2cdecc3eed28969a80b2e47d400c35cf18b5125d. The separately pushed roadmap commit
803a37d is also inherited by this handoff branch. Reading a patch is not an
instruction to apply it over Claude's branch. Integration remains separate.

## Evidence and its limits

- Batch 6.2 has 12 individual screenshot views and recorded suite logs. Its
  own new suite is mobile-reliability 22/22; measurement-entry is 29/29.
- Batch 7.2 has 18 individual screenshot views, validation JSON and recorded
  logs. Its new suite is field-resilience 27/27; the handoff records 440 counted
  checks plus geofence.
- Earlier Batch 8.2 readiness work has 18 final individual PNG views and
  `validation.json` recording 474 counted checks plus geofence, including
  native-readiness 24/24 and native-bundle 10/10. Its baseline probes intentionally
  fail the new assertions; they are not passing release runs.
- `artifacts/batch8-2/historical/results.json` is an intermediate run, with
  failures and only 21 readiness checks before the final suite expanded. It
  is superseded by the final validation JSON and final logs.
- The Batch 8.2 contact JPG sheets are in its historical folder: they predate
  the last busy-button CSS correction. Inspect the final individual PNGs.
- Logs are preserved as `.txt` rather than `.log`, because the repository
  ignores scratch log files. Content hashes refer to the original bytes.
- Other baseline/debug/intermediate logs retain their original names; read
  the associated handoff before interpreting a failure as a current defect.
- These are recorded results from those tasks, not a claim that all suites
  were freshly rerun when creating this folder. Browser/API doubles do not
  establish physical Android, live database or production behavior.

The roadmap follows the owner's overall Batch 7 checkpoint, retaining existing
readiness work rather than repeating it. No new inventory feature is implemented
by these documents or archived artifacts.

## Retrieve without changing another agent's working branch

```sh
git fetch origin codex/all-files-handoff
git show FETCH_HEAD:codex-files/README.md
git show FETCH_HEAD:docs/plans/batch-plan-after-7.md
git show FETCH_HEAD:docs/plans/claude-roadmap-handoff.md
git ls-tree -r --name-only FETCH_HEAD codex-files
```

To extract the handoff folder outside the current checkout, choose an empty
destination and use `git archive FETCH_HEAD codex-files`; no branch checkout,
rebase or merge is needed. Do not overwrite the current working tree.

Installed dependencies, caches, credential/auth files, generated native/web
asset copies, unrelated uploads and live data are excluded. Original setup
helpers are retained as historical text, not an instruction to publish local
configuration or reproduce services blindly.
