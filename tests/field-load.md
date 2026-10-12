# Batch 10.2 — crew preparation and closing

Implemented on `codex/batch-10-2`, based on
`04b8b946b38bcd55641f88a543e8ed720bed5be4`. The requested `b948db3` was an
ancestor; two newer Claude prompt documents were preserved. The separate
`codex/field-evidence-capture` branch remains intact and is not merged here.
This batch stops at 10.2.

Backend/contract source: Claude's
`b7f0a228fce7c952dadeabf965f5593aae214d55`. Assignment: `11a45c2`'s
`docs/prompts/codex-batch-10-2-resume.md`. No merge, rebase, cherry-pick,
live migration, grant/data/settings change, deployment or APK publication.

## What was built against the six findings

| Finding | Field implementation |
| --- | --- |
| 1 — frozen read | One `get_load_plan` envelope supplies state, plan, counts, operating-day window and readable vehicles. `none` and `closed` have distinct screens. No DTO is assembled from stock views. The unconfigured UTC warning and exclusive bounds stay visible; visits are never re-bucketed. |
| 2 — reversible Keep | Set/clear share one item panel. The server's whole-day action and reason are re-read after acceptance; clearing does not locally assume Return. A historical replay receipt never overwrites today's recommendation. |
| 3 — replay | A request is durably committed before I/O, with a stable operation key and immutable payload. Explicit retry recovers the original receipt. A Web Lock prevents concurrent use of the local vehicle/day request slot. Unresolved requests block new actions for that slot. |
| 4 — receipts | No response, refusal, conflict and acceptance have separate persistent states and visible explanations. Missing/malformed acceptance is unknown, not success. The actual receipt is retained. Revision, basis fingerprint and lines fingerprint are captured from the rendered plan; no read precedes confirmation. |
| 5 — closing pools | Observations are of usable stock; physical quantities start blank. Accuracy is explicit. Every numeric observation requires a variance reason because only the server knows the live basis. Damaged positive-variance refusal remains visible. A level has only Empty/Low/Enough and no numeric request field. A day without a plan can close. Receipt comparisons use `live_usable_on_hand`. |
| 6 — exceptions | Skip is a fourth group with the owner's reason, no transfer claim and no crew override. The owner-authorisation request is visible to crew and a `42501` refusal is honest. Extra catalogue items absent from the plan can be requested with an explicit operating quantity. |

The new entry is `admin/field.html#/load`, with optional
`?vehicle=<code>&day=YYYY-MM-DD`; closing uses `#/load/closing`.
Opening a screen creates no revision and moves no stock. An owner can build
explicitly; a crew cannot. Base/Car A/Car B are never created by the phone.
Vehicle bootstrap reads existing metadata and calls stock-contract
`can_see_location` before choosing a default; subsequent picker options come
from the envelope. Wrong-vehicle/day read responses fail closed.

Stop addresses and `properties.access_note` use the existing authorized
`getJob` read, keyed by the server's job/property IDs. Missing or refused
details are reported. Shared equipment remains grouped once for the whole
day, with the server's reason/job references. Named company-owned seasonal
sets are identified by ID, with an explicit warning that assignment is not
proof of being aboard; confirmation does not move those assets. Replenishment
suggestions reserve, purchase and move nothing.

## Outbox decision and device persistence

**No fifth queued type.** Build, Keep, exception, confirmation and closing
require a connection. Recommendations are cached for review for at most
24 hours, marked offline/read-only. Draft counts, Keep reasons and exception
requests remain local and account/vehicle/day scoped. Reconnect requires a
fresh read before a new mutation, never an automatic send.

The existing `ns-field-work` drafts store also holds the last load request
for each vehicle/day under a versioned `operation` record. This is an
explicit request-recovery journal, not a second outbox or background sender.
Its states are `sending`, `no-response`, `accepted`, `refused`, `conflict`.
On interruption, `sending` reads as outcome unknown. Recovery sends the
identical stored request under the original key. There is no uncertain-request
discard control. Unknown future formats are retained and refused. The sync
badge covers existing outbox actions, not load recovery.

The shared draft limits remain 100 KB per record and 200 draft records;
storage failures are visible and prevent sending. Unsent work is never
evicted. Submitted closing values remain available as draft copies; a second
closing requires an explicit new-physical-observation check. Local storage
can still be evicted by the browser/OS; physical-device durability is UNRUN.

## Fixture provenance and test boundaries

`tests/data/field-daily-load-v2.json` is a byte-identical copy of Claude's
24-scenario fixture at `b7f0a22`, deliberately outside protected
`tests/fixtures/**`. SHA-256:
`a024c0a10346273f22511fa51d35ff03b2659270129ff2da32924b04afb824f0`.

`field-load-fixture.mjs` mocks the SDK transport and existing job read.
For the older plan-only scenarios, tests compose the generated plan with
the generated envelope and synthetic UTC bounds consistent with its work
date. Those compositions and the replay mock do not establish new backend
behaviour, authorization or stock correctness. Browser process restart uses
a persistent Chromium profile and preserves real IndexedDB request bytes.
All 24 generated scenarios are referenced by the browser checks.

## Verification

| Category | Final result |
| --- | --- |
| Registered regression | 391 PASS checks, plus geofence; zero failures |
| field-load | 41/41 PASS |
| load-prep | 16/16 PASS — legacy outbox bytes, draining, upgrade/downgrade, enabled routing and measurement exit guard |
| offline-work | 47/47 PASS |
| field-resilience | 27/27 PASS |
| mobile-reliability | 22/22 PASS |
| native-readiness | 24/24 PASS |
| native-startup | 18/18 PASS |
| native-packaging | 19/19 PASS |
| native-bundle | 10/10 PASS |
| Expected failure | Removing the rendered lines fingerprint causes the confirmation check to FAIL: 0 PASS / 1 expected FAIL |
| Skip | No selected checks skipped |
| Database, live integration, production | UNRUN — no backend implementation was imported; migrations remain unapplied and live changes are prohibited |
| Physical Android / emulator / release signing | UNRUN — no device/emulator qualification or APK publication in this batch |

615 unique counted checks plus geofence; this does not include Claude's
reported database/browser suites. Earlier runs caught select-label ambiguity,
the new header's changed Tab order, and fixture dates inconsistent with a
composed envelope. Those were corrected; no failing checks were disabled.
Historical unsuccessful runs are not final passing evidence.

390/430/1200px views cover preparation, closing, active Manual Keep and Skip.
Screenshots were inspected, keyboard controls exercised and visible touch
targets checked. The controls use scoped `field-load.css`; shared/global
CSS is untouched. The former disabled-route tests were intentionally updated
to test enabled routes. The native-readiness Tab assertion now checks the
new load entry before the sync badge, preserving focus-ring verification.

Packaging: `cap:sync`, the production asset guard, real Gradle
`:app:assembleDebug`, APK source/staging comparison, manifest inspection and
debug-signature verification pass. The build log shows `verifyNovaAssets`
executing before `preBuild`. Cap sync proves copying/plugins; Gradle proves
compilation/assembly; neither proves hardware Back, TalkBack, permissions,
camera, storage eviction or cellular behaviour. The debug APK remains an
ignored local artifact. The inspected APK contains 149 staged files plus two
generated empty Cordova stubs, target SDK 36/min SDK 24 and unchanged permissions.

## Reproduce and integrate

Start a static server at repository root on port 8743. In this environment:

```sh
export PLAYWRIGHT_MODULE=/workspace/.nova-shield/test-tools/node_modules/playwright/index.mjs
export PLAYWRIGHT_CHROMIUM=/usr/bin/chromium
export NODE_OPTIONS='--loader /workspace/nova-shield/codex-files/tooling/test-loader.mjs'
node tests/field-load.test.mjs
node tests/load-prep.test.mjs
npm test
npm run cap:sync
npm run verify:mobile
python3 scripts/android-build.py build
python3 tests/android-apk-inspection.py
```

The regression runner replaces/stops the static server; restart it for
subsequent browser suites. Run sync/build/asset-mutating checks sequentially.
Expected-failure probe:

```sh
FIELD_LOAD_BREAK=fingerprint FIELD_LOAD_ONLY='confirm quotes' node tests/field-load.test.mjs
```

Integrator list: add **field-load**, **load-prep**, **offline-work**,
**field-resilience**, **mobile-reliability**, **native-readiness**,
**native-startup**, **native-packaging**, **native-bundle** to the explicit
mocked/local list. `measurement-entry` is already registered. Keep Claude's
phase21–26/database suites independently selectable; do not use a blanket glob.
`tests/run-regression.sh` remains unchanged. The separate field-evidence
branch's suite is not part of this branch's totals or integration.

Code, copied test data, this handoff and raw evidence are committed together;
evidence lives in `codex-files/artifacts/batch-10-2/`. No Claude-owned API,
inventory/load view, migration, contract, backend test, fixture, shared helper
or global stylesheet changed relative to the base.

## Residual contract observation

No new blocking behaviour was found. A non-blocking documentation drift
remains in Claude's `docs/daily-load-contract-v1.md:888` at `b7f0a22`: §13
says **twenty** scenarios and its older verification table describes v2,
whereas the v2.1 introduction and actual fixture correctly contain 24.
Implementation follows the v2.1 introduction and actual fixture. The frozen
document is untouched here; no backend re-review was performed.
