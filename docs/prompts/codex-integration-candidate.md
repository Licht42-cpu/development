# Codex — the authorised integration change: build the candidate

Execute this independently on your own branch. Implement, test, commit and
push, then stop. Claude owns X.1; Codex owns X.2 — and the roadmap assigns
**this** work to Codex explicitly.

## Why this and not 15.2, 14.2 or more 13.2

Your three roadmap candidates are each blocked, and all three are blocked on
the same thing or on hardware:

* **13.2** — the 16 handset cases need a physical Android target. There is
  none. Your runbook, evidence recorder and browser journey at `4d7ab12` are
  ready for the day there is one.
* **15.2** — "build/audit the **authorised integrated candidate**". That
  candidate does not exist. This batch is how it comes to exist.
* **14.2** — Batch 14 is marked *retained for the future, not automatically
  authorised next work*, and it needs a device as well.

The roadmap's own ownership table says `admin/js/main.js` and general route
registration are **Codex's, at integration**, and that
`tests/run-regression.sh` and integration orchestration are a **separate
owner-authorised integration change**. This prompt is that authorisation, for
the wiring and the registration only. Every live action stays gated.

## Start from the actual source

Branch from your own latest head: **`codex/batch-13-2@4d7ab12`** (which
followed `codex/batch-12-2@a0b87cd`). Work on a new
`codex/integration-candidate` branch.

**Do not merge or rebase `claude/batch-8-1`.** Read Claude's artefacts from
GitHub at **`claude/batch-8-1@f08edfd`** and bring across only what wiring
needs — a route, a mount point, a suite name. Do not import or rewrite the
components themselves.

Read, in this order:

1. `docs/plans/batch-plan-after-7.md` — the ownership table, and
   **"Integration checkpoints and evidence"**, especially: *"new suites are
   registered in the shared runner at integration, not a blanket glob that
   accidentally selects database tests"*, and *"Feature availability must be
   explicit until real integration exists."*
2. `docs/batch13-1-findings.md`, `docs/batch12-1-findings.md` — each one ends
   by saying the component is standalone-mountable and that route
   registration is **not** that batch's. This is the other half of those
   sentences.
3. The five frozen contracts, for the shapes the wired screens call:
   `operations-contract-v1.md` (v1.2), `seasonal-sets-contract-v1.md` (v1.2),
   `daily-load-contract-v1.md` (v2.1), `completion-evidence-contract-v1.md`
   (v1), `dispatch-contract-v1.md` (v1),
   `customer-handover-contract-v1.md` (v1),
   `permanent-lighting-materials-contract-v1.md` (v1).

## What is actually unreachable today

Verified in the tree at `f08edfd`, not assumed — confirm each one yourself
before changing it:

| Built | Reachable from |
|---|---|
| `admin/js/views/inventory.js` → `renderInventory` (8.1/9.1, and it mounts `load-plan.js`, `seasonal-sets.js`, `kit-sheets.js`) | **nothing.** `main.js` has no `#/inventory` route and no nav entry. |
| `admin/js/components/dispatch-day.js` (12.1) | **nothing.** |
| `admin/js/components/property-access.js` (12.1) | **nothing.** |
| `admin/js/components/customer-handover.js` (13.1) | **nothing.** |
| `tests/phase22` … `phase29` | the separate `tests/run-admin-suites.sh` only. Not the shared runner. |

`main.js` currently routes nine screens: dashboard, requests, jobs, job,
customers, customer, property, winter, settings.

## What to build

### 1. Routes and mount points

Wire each unreachable screen where it belongs, not where it is easiest:

* **`#/inventory`** with a nav entry — the inventory screen and its tabs.
* **The dispatch day** — a day-scoped screen reached from where the day's
  work already lives, carrying the location code and work date in the route
  so a reload and a Back both land on the same day. You fixed a
  dispatch→loading navigation defect in 13.2 that lost the selected work
  date; the route is where that class of bug is prevented rather than
  patched.
* **Property access and work zones** — on the existing property screen
  (`views/property.js`, reached through the customer who owns it, which is
  what makes its Back target unambiguous).
* **Customer handover** — on the existing job screen, beside the evidence
  panel, since it is per-job and starts from an accepted completion.

Every new route must work with the existing Back and Escape handlers, the
query-string rewriting that does not add history entries, and the
better-parent mechanism a screen can use. Keyboard and Android Back are
yours and they are the reason this is your file.

### 2. Feature availability must be explicit — this is the hard part

**None of the twenty-eight migrations has been applied anywhere.** The moment
these screens become reachable, they call RPCs that do not exist on the live
project, and every one of those calls fails.

A stack trace, an empty screen or a spinner that never resolves is not
acceptable. Decide and implement one honest mechanism — a capability probe,
a feature manifest, a typed "not available yet" state, your choice — so that
a reachable screen whose backend is not applied says **which feature is not
available yet and why**, and offers nothing it cannot do. State the rule you
chose and why in your handoff.

Do not fake data, do not stub an RPC's result, and do not hide the screen
entirely: hiding it recreates exactly the invisibility this batch exists to
fix. The owner should be able to see that the screen exists and that its
backend is pending.

### 3. The shared runner

Register the new suites in `tests/run-regression.sh` **by explicit name** —
`phase22 phase23 phase24 phase25 phase26 phase27 phase28 phase29` — and keep
the database suites out of it; they need a disposable PostgreSQL and belong to
`tests/db/run-db-tests.sh`. A glob here would pull them in and fail for the
wrong reason. Say in the file why the two runners stay separate.

If registering them surfaces a cross-suite interaction — a shared port, a
server one suite kills, an order dependency — fix the harness problem and say
what it was. One suite's static server dying mid-run is a real failure mode
in this repository.

### 4. The integration checkpoints

The roadmap's checkpoint list for 11–13 is your acceptance list, on the
candidate: real evidence and completion rules, immutable consumption,
protected quotes, customer report access, and the Android core journey. Run
what the absence of a backend and a handset allows, and report the rest UNRUN
by name.

### 5. Hand the candidate over

Name the candidate SHA plainly. It is what 15.2 builds and audits, and what
13.2's 16 handset cases run against when a device appears. Point your existing
`tests/android-core-qualification.md` runbook at it.

## Boundaries

* **Yours**: `admin/js/main.js`, route registration, navigation, the field,
  offline, outbox and native files, the build, `tests/run-regression.sh` and
  your own suites and docs.
* **Not yours — do not edit**: `admin/js/components/**` and
  `admin/js/views/**` that Claude built (inventory, load-plan, dispatch-day,
  property-access, customer-handover, settings, evidence-policy, the
  calculators), `admin/js/lib/api.js`, `supabase/migrations/**`,
  `tests/db/**`, `tests/phase2*.test.mjs`, the frozen contracts, the fixture
  generators and their JSON, global `admin.css`, and `shared/` auth, DOM,
  format and harness.
  **If wiring a screen requires a change inside one of those files, do not
  make it — report it as a finding with the file, the line and what the
  wiring needs.** That is the integration report's whole value.
* **No live anything**: no migration, grant, data or settings change against
  the live project; no merge or rebase of another agent's branch; no
  deployment; no APK publication; no provider account; no real customer
  message; no payment.
* **Invent nothing**: no supplier specifications, chemical dosages, pack
  conversions, renewal cutoffs, operating timezone, provider choices, routing
  API, or the missing Permanent Lighting Phase D document. Do not answer the
  seven open 11.1 business questions.
* Arrival stays what 12.2 made it: a **local crew report**, not synced and not
  GPS-verified. Denied access still retires saved details. Access codes stay
  out of storage. Wiring must not quietly change any of that.

## Reporting

Commit and push to `codex/integration-candidate`, and write the handoff into
your branch. In it:

* The **candidate SHA**, and the base it came from.
* Every route and mount point added, and where each screen now lives.
* The availability mechanism you chose, and what a reachable screen with an
  unapplied backend actually shows.
* Keep **passed, failed, skipped, expected-failure and UNRUN distinct**, with
  counts. An expected failure is declared in advance as a fault injection,
  never relabelled afterwards.
* Keep **browser, database, native build, emulator, physical device, provider
  sandbox and production** outcomes distinct. A browser double never proves a
  handset, and a local result never proves the live project.
* Screenshots of every newly reachable screen at 390 / 430 / desktop, with
  keyboard operation checked, and say which you inspected.
* **Findings for Claude**: anything the wiring needed inside a Claude-owned
  file, with file and line. Report; do not fix.
* Confirm Claude-owned files are untouched, no migration was applied, and
  nothing was merged, deployed or published.

**Stop after the integration candidate.** Do not start 15.2, 14.2, the handset
cases, or any live application, merge, deployment or publication.
