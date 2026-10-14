# Nova Shield source integration candidate

**Historical snapshot:** this records the earlier `f08edfd` integration.
[Batch 15.2](batch15-2-findings.md) supersedes its current-state figures:
Claude source `5169d7b`, 31 pending source migrations and the reconciled
crew-scope rule. The source fixes remain unapplied live. The backend authority
is [release runbook v1](release-runbook-v1.md).

Candidate code: **`de9e5d76e576ec1d6334ffe14fabd465fbf53fab`**, on
`codex/integration-candidate`. Base:
`codex/batch-13-2@ae6fb6b8175d822388f9c3f5ef54bbaaf0166450`.
The assignment named `4d7ab12`; the newer base adds only the already pushed
Claude 15.1 prompt, which was preserved.

Assignment: `docs/prompts/codex-integration-candidate.md` at `ea263a9` on
Claude's branch. The owner explicitly allowed copying unchanged Claude files
after inspection showed they were absent from the Codex branch.

**This combines source and route wiring. It does not qualify a live backend,
provider or handset, and is not a release.** No Git merge, rebase or cherry-pick
was performed. Nothing was deployed, migrated live or published as an APK.

## Source and ownership

116 files were copied unchanged from
**`f08edfd2a52064a090e3bede50253e9027eb75fe`**, including the operations
components, API, contracts, migration files, customer pages and suites.
`codex-files/handoffs/integration-source.json` records each SHA-256 and source
Git blob. All 116 match the pinned source; all 38 migration files match its
tree. These are source comparisons, not database results.

Codex's job view was preserved: importing Claude's version wholesale would
remove `guardActions`, `refreshToken` and `isCurrent`, regressing ordered
measurement saves and quote actions. The new panels mount from an owned
router wrapper. The native test mocks, pinned package versions, vendor assets
and build guards also survive; only Claude's additional package scripts were
adopted. The historical Batch 4 filename rename was copied unchanged from
Claude's source; no remote migration history was altered.

Claude components, API, contracts, schemas and phase suites received no
independent edits. Corrections found inside those files are reported below.

## Reachable screens

| Entry | Mount and behavior |
| --- | --- |
| Admin navigation → `#/inventory` | Existing inventory view, all six tabs; tab query uses `replaceState` and survives reload. |
| Jobs → Plan the dispatch day; nav → `#/dispatch?location=…&day=…` | Existing dispatch panel. Vehicle/day selectors update the route without new history entries; reload preserves both. An explicit loading link carries the same vehicle/day into the field load route. |
| Existing `#/properties/:id` | Access/work-zone editor appended to the passport; the owning customer's Back parent remains. |
| Existing `#/jobs/:id` | Materials, selected material sheet, evidence and customer handover beside pricing/quotes. Handover receives only the readiness view's current accepted completion ID, never a guessed ID from job status. Refresh is explicit. |
| Field header → Management | Opens the management inventory document after pending measurement and visible note/dictation draft persistence; active replay blocks departure. |

Unknown calendar dates are refused rather than silently replaced. Vehicle
codes remain backend data; no slug format or Car B row was invented. Inventory
has a Dashboard parent; dispatch has Today's jobs. The existing Escape overlay
handling and mocked Android Back binding are exercised. Physical Back remains
UNRUN.

Each route gets its own mount, so late responses cannot replace a newer screen.
Late context-parent/query updates are also ignored. The old desk completion
button is held while the new completion read prerequisites are unavailable.

## Availability

An online, uncached `is_owner` read and the feature's read prerequisites gate
the management panel. Inventory checks its bundle's required relations with
`limit(0)`, without downloading business records. Dispatch, property access and
handover use scoped read RPCs. Probes submit no operations or stock movements.

Missing schema/function errors produce a **named, reachable unavailable card**
explaining pending migrations or schema-cache availability, with Check again.
Denied access, owner-only management, offline, timeout and an unconfirmed read
have separate explanations. The timeout is 12 seconds. Raw error messages,
tokens, access notes and codes are not logged or displayed by these probes.
Nothing synthesizes data or hides the route. Crew accounts get a field-console
entry instead of owner mutation controls.

**Limits:** these checks establish read prerequisites, not every mutation's
signature/grant, the entire applied migration history or business correctness.
The server authorizes each submitted operation. Inventory's six-tab bundle
stays unavailable if one required relation is absent; partial deployments are
not independently certified. Applying the complete reviewed backend is still
a separate owner decision.

## Owned fixes found during verification

Note controls previously became editable before their local draft listener
attached. A controlled delayed restore reproduced the gap. Online/offline
notes now wait for draft initialization, and document departure waits for the
visible editors' persistence chains. An unavailable local store is stated;
offline controls cannot imply an unsaved note is durable. No outbox schema or
action type changed.

Six existing test predicates used asynchronous `waitForFunction` callbacks.
The installed Playwright polling code treats their Promise as truthy before
the eventual boolean, so they did not actually wait. Owned tests now await
storage/lock predicates through `poll-browser.mjs`. The load fixture also waits
for complete draft-backed line rendering. Keyboard expectations include the
new Management link and budget traversal against actual DOM tab stops, retaining
the required focus, accessible-name and Save note assertions.

## Findings for Claude

1. **Material creation cannot select the new units or level tracking.**
   `admin/js/views/inventory.js:61` still lists only `each`, `linear_ft`,
   `box`, `roll`, `kit`, `set`; `:684` uses that list. The actual newly routed
   form exposes those six options and no level creation choice. Litres,
   kilograms, sticks and level presentation exist in `inventory-units.js`, but
   cannot be chosen here. Please expose the backend-supported units and
   quantity/level creation mode, preserving a level supply's absence of numeric
   count/pack/reorder inputs. This matters for bulk chemicals, salt and cheap
   supplies. Observation: `claude-observations.json` in the evidence directory.
2. **Property view prints `null`.** `admin/js/views/property.js:461` passes a
   conditional null directly to `Element.append` when a customer exists. It
   becomes visible text below the customer link in the actual router screenshot.
   Filter the top-level append list; no shared DOM change is needed.
3. **Admin Daily load does not carry its own selection through the route.**
   `admin/js/views/inventory.js:1190` calls `loadPlanPanel()` without options;
   `admin/js/components/load-plan.js:79` defaults to Car A and today's date.
   Its selectors do not notify the router. Supporting persisted admin-load
   vehicle/day needs an owned component/view hook. Codex's dispatch route and
   its field-loading handoff preserve both already; no DOM hydration workaround
   was added to the Claude panel.
4. **Preserved job-view difference.** Claude's job view would drop Codex save
   guards at candidate `job.js:318`, `:909` and `:925`. The wrapper mounts the
   new panels while preserving those guards; do not replace this file wholesale
   at the next source update.
5. **Car B authorization mismatch remains the recorded backend blocker.**
   Completion's `can_work_job` and dispatch's `ns_can_work_job` disagree about
   unassigned jobs with two active vehicles. Claude's 15.1 assignment owns that
   correction before a second crew is enabled. No backend rule was altered here.

The first two are observed UI defects; the third and fourth are concrete
integration hooks/differences in source. These do not justify editing Claude's
files under this assignment. Candidate preparation is complete; inventory
business acceptance and release still require the listed follow-ups.

## Verification

Evidence: `codex-files/artifacts/integration-candidate/summary.json` and raw
logs beside it. Results count distinct cases, not repeated executions.

| Category | Result |
| --- | --- |
| Explicit shared/local suite set | 47 suites; **1,025 distinct checks passed**, plus geofence's separate pass |
| New router integration suite | **30/30**; includes a real imported API/SDK-double parameter check |
| Final affected field/local suites | 8 suites, **251 checks passed**, plus native-bundle 10/10; overlaps the shared totals |
| Qualification-record validator | **18/18**, separate from browser totals; no device behavior asserted |
| Declared fault injections | **2 expected failures**: old route registration; editable note before restore/listener readiness |
| Final normal failures / skipped | **0 / 0** |
| Capacitor sync and asset audit | **PASS**, 177 source assets; 178 staging files including manifest; all staged bytes match the APK |
| Native debug assembly | **PASS**; `verifyNovaAssets` executed; 211 tasks, 22 executed / 189 up-to-date, 13s |
| Physical-device cases | **0 PASS / 0 FAIL / 0 SKIPPED / 16 UNRUN** |
| Database / live Supabase / production | **UNRUN**, independently of Claude's earlier disposable PostgreSQL evidence |
| Emulator / provider sandbox / real delivery or signing / payment | **UNRUN** |

The complete shared invocation passed 1,023 cases before the last draft-handoff
addition. Final affected suites were rerun after that change, then the operations
and bundle/packaging checks after accepting backend vehicle-code text. The merged
suite inventory totals 1,025 current cases; the raw logs retain these boundaries.
No failed probe was relabeled as an expected failure after the fact.

39 full-page captures cover the four newly wired surfaces, ready/pending states,
and five additional inventory tabs at 390/430/1280. Layout checks pass. Inventory,
dispatch, property and handover were visually inspected at all three widths;
the extra inventory tabs were inspected at 390. Property/handover inspection
also used closer element captures. Those cropped captures can include sticky
chrome; the committed full-page captures start at the document origin. Keyboard
operation includes route links, tabs, selectors, retries and report generation;
the underlying unchanged admin suites exercise their action controls.

The debug APK is local, ignored by Git and **unpublished**. Its exact checksum
and commit/asset binding are in `qualification-record.json`. Compile/sync do
not prove installation, permission dialogs, camera, TalkBack, hardware Back,
storage eviction or cellular recovery.

## Reproduce and continue

Use the repository's pinned Node dependencies and native tool scripts. In this
container:

```sh
npm run cap:sync
PLAYWRIGHT_MODULE=/workspace/.nova-shield/test-tools/node_modules/playwright/index.mjs PLAYWRIGHT_CHROMIUM=/usr/bin/chromium npm test
python3 tests/field-qualification.test.py
python3 scripts/android-build.py --offline gradle :app:assembleDebug
```

The shared runner explicitly registers phase21–29 and the Codex suites. Database
tests stay in their separately guarded runner. It reuses a matching static
server, locks regression orchestration and kills only a server it started.
The unchanged standalone admin runner is not nested inside the shared runner.

There are **28 source migrations after the historical reported cutoff
`20261009013557`**. Current live history was not queried or inferred. No
migration, grant, data or setting was applied/changed in this task.

The evidence recorder supports unchanged source snapshots because a Git merge
was forbidden. It checks committed source blobs/checksums and all migration
files against the locally available pinned Claude commit; ancestry booleans
remain honest. If that commit is missing in another clone, fetch it read-only:

```sh
git fetch origin f08edfd2a52064a090e3bede50253e9027eb75fe
```

The recorder's explicit authorization reference records the existing owner
instruction; it creates no permission or device result. Its device gate still
refuses the 16 unrun cases. Refresh/rebuild against any later candidate before
device qualification; the stored artifact belongs to the exact code SHA above.

Claude may continue 15.1 independently. Applying its runbook, integrating later
source corrections, production verification, customer messages and APK release
remain separate actions. Conditional Batch 14 was not started. Neither 13.2's
handset cases nor a 15.2 release audit was claimed complete.
