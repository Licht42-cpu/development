# Claude — Batch 15.1: backend release candidate and migration/runbook review

Execute Batch 15.1 independently on your own branch. Implement, test, commit
and push, then stop. Claude owns X.1; Codex owns X.2.

**Why this batch and not Batch 14.** The roadmap marks Batch 14 (route
optimisation, ETA notifications, scoped tracking, background telemetry) as
**retained for the future, not automatically authorised next work** — it
proceeds only once owner value, provider costs, Android capability and data
contracts are settled, and none of those is. No routing API is chosen, the SMS
and payment providers are unset, and 13.1 §9.3 lists five pieces of provider
work still outstanding. Do not start 14.1.

**Why not the other two candidates.** Codex's 13.2 has 16 handset cases that
stay UNRUN until a physical Android target exists. Codex's 15.2 needs an
**authorised integrated candidate**, and no integration has been authorised:
`admin/js/main.js` route wiring is Codex's at integration, and
`tests/run-regression.sh` is a separate owner-authorised integration change.
15.1 is the one remaining roadmap batch that is fully executable now, needs no
handset and no provider, and is what stands between this work and a release.

## Start from the actual source

Expected branch: `claude/batch-8-1`, published head `c6e1e17` (Batch 13.1).
Verify and report the full base SHA; preserve any newer authorised work. Do
not merge, rebase or cherry-pick Codex, and do not wait for another Codex
push.

Read, without importing implementation:

* Codex 12.2 at `a0b87cd` on `codex/batch-12-2` — `tests/field-dispatch.md`.
  Arrival there is explicitly a **local crew report**, not synced and not
  GPS-verified; denied access retires saved details; access codes stay out of
  storage. Your audit must not contradict any of that.
* Codex 13.2 at `4d7ab12` on `codex/batch-13-2` —
  `tests/android-core-qualification.md`. It fixed a dispatch→loading
  navigation defect that lost the selected work date; 126 browser, 14 record
  and 6 Android build checks pass; **all 16 handset cases are UNRUN**.

Read your own `docs/batch13-1-findings.md`, `docs/customer-handover-contract-v1.md`,
`docs/dispatch-contract-v1.md`, `docs/completion-evidence-contract-v1.md`,
`docs/daily-load-contract-v1.md`, `docs/operations-contract-v1.md`,
`docs/seasonal-sets-contract-v1.md`,
`docs/permanent-lighting-materials-contract-v1.md`, `docs/batch7-1-findings.md`
(finding 4b, the missing base schema) and the roadmap's 15.1 section and
integration checkpoints at `4d7ab12`.

Keep every frozen wire shape compatible. A necessary breaking change needs an
explicit new contract version and a stated reason.

## Goal and bounded scope

A **reviewable** backend and customer release: accurate migration evidence,
accurate authorisation evidence, an exact ordered application plan and a
rollback/recovery plan somebody can follow under pressure.

**Preparing these artifacts is this batch. Applying them is not.** Production
migration, grant, data or settings changes, merging tracks, external customer
messages, publishing an APK and deploying all require the owner's separate
explicit instruction. Nothing in this batch touches the live project.

### 1. Audit the pending migration chain

Twenty-eight migrations are pending in filename order and none has been
applied anywhere. For **each** one, record: what it creates or changes,
whether it is additive or destructive, whether it is re-runnable, what it
depends on, what it asserts about its own outcome, and whether it would
survive being applied to the live schema rather than a fixture.

Pay particular attention to:

* **The Batch 5 sent-customer-content freeze** (`20261009160000`) — it is the
  oldest pending behaviour change and the one most likely to interact with
  live data that already exists.
* **Version history and filename order.** The repository has no base schema,
  so the fixture schemas reproduce only what the migrations name. Say
  explicitly which objects exist only live, which are therefore unverified
  locally, and which migrations touch them (`to_regclass` guards, additive
  `add column if not exists`, introspecting DO blocks).
* **The 42P13 drops.** Where a migration drops a function signature before
  recreating it, state the window that opens if application is interrupted
  there.
* **Legacy-table decisions kept separate** from the additive inventory
  migrations, as the roadmap requires. Do not bundle them.

### 2. Audit grants, RLS and the authorisation surface

Produce the inventory as **evidence**, not assertion: for every RPC and table
the pending chain adds or changes, the grant each role actually holds, read
with `has_function_privilege` / `has_table_privilege` /
`has_column_privilege` on a disposable database with the whole chain applied.
Name every deliberately anon-callable function and why
(`get_customer_quote`, `respond_to_quote`, and 13.1's three customer reads),
and prove nothing else is.

Re-verify the things earlier batches established, because a release is when a
quiet regression surfaces: the ungranted `ns_property_access.access_code` and
`.internal_note`; `ns_customer_grants` having no `authenticated` select at
all; `redeem_document_ticket` being service-role only; 11.1's completion gate
trigger; the append-only and freeze triggers on evidence, consumption and
reports.

### 3. Integrity and recovery

* **Inventory and completion integrity**: stock conservation, reservations,
  usable/damaged, exact/estimated and quantity/level distinctions; immutable
  consumption with reasoned corrections; protected quotes and change orders.
* **Report access**: the capability's scope, expiry and revocation, and the
  documented residual lifetime of an already-issued signed URL.
* **Notification recovery**: what happens to a queued row, an `unknown`
  outcome and an `unavailable` one if the chain is applied while rows already
  exist. There is still no worker in this repository; say so and say what a
  recovery step would have to do.
* **Provider configuration**: the five settings keys and what each unset one
  makes unavailable. No provider is to be configured.

### 4. The runbook

Push a runbook that an owner can follow:

* the **exact ordered application** of the pending chain, with the command,
  the expected outcome and the stop condition for each step;
* a **rollback/recovery** plan per step — and where a step is not reversible,
  say that plainly rather than inventing a reversal;
* what to verify after each group, and which failures mean stop versus
  continue;
* the **data-cleanup candidates** carried over from `docs/batch7-1-findings.md`
  §5 and anything new, each with identifying columns and the reason. **Never a
  speculative delete and never a postcode or address change.** Candidates are
  proposals with identifiers, not statements.

### 5. Reconcile the unassigned-job gate — this is yours and it is overdue

`docs/batch13-1-findings.md` records it with the call paths inspected:

* `public.can_work_job(uuid)` (11.1) — any admin, **except** where the job is
  explicitly assigned to a vehicle the caller cannot see. An unassigned job is
  workable by any crew however many vehicles are active.
* `public.ns_can_work_job(uuid)` (12.1) — assigned to the caller's own
  vehicle, **or** unassigned **and exactly one vehicle is active**.

So with a second car active, an unassigned job can still be completed but
cannot be dispatched, messaged about or reported on. **Decide it and implement
the decision** in an additive migration: does an unassigned job belong to
every crew, to none, or must dispatch assign it before any crew may act?
Whichever you choose, both functions must agree afterwards, the choice must be
tested with real non-owner roles in both the one-vehicle and two-vehicle case,
and the contract that names the rule must be versioned if its wire behaviour
moves. A release gate is exactly when this gets settled; it is "before a
second crew is enabled" and that is now.

## Boundaries

* **Yours**: backend and migrations, owned admin/customer views, scoped CSS,
  customer site pages, your backend and browser suites, your docs.
* **Not yours**: Codex's field, offline, outbox, navigation, native and build
  files; `admin/js/main.js` and route registration (Codex's, at integration);
  `tests/run-regression.sh` (a separate owner-authorised integration change);
  global `admin.css`; `shared/` auth, DOM, format and the test harness;
  package and lockfiles. List new suites for the integrator instead of
  registering them in the shared runner.
* **No live application of anything.** No migration, grant, data or settings
  change against the live project; no merge, rebase or integration; no
  deployment; no APK; no provider account; no real customer message; no
  payment. Local database work must fail closed unless the target is
  explicitly disposable.
* **Recount and rehearse the whole pending chain**, not just what you add.
  Nothing in that rehearsal proves live Supabase readiness and the report must
  not imply it does.
* One crew, at most two; Base/Car A and optional unseeded Car B.
* **Invent nothing**: no supplier specifications, chemical dosages, pack
  conversions, renewal cutoffs, operating timezone, provider choices, or the
  missing Permanent Lighting Phase D document. Do not answer the seven open
  11.1 business questions.

## Verification

* Run the pending chain on an explicitly disposable database and prove the
  **ordered application** and, where claimed, the **rollback** actually work —
  a runbook step nobody has executed is a guess written down.
* Test with **real non-owner roles**, not only privilege inspection: the table
  owner bypasses grants, so `set role` or it proves nothing.
* Re-run every affected suite: the eight database suites, phase22–29, and the
  browser regression.
* Inspect any changed screen at 390 / 430 / desktop with actual screenshots
  and keyboard operation.
* Report **passed, failed, skipped, expected-failure and UNRUN separately**,
  with counts. An expected failure is declared in advance as a fault
  injection, never relabelled afterwards.
* Keep **disposable PostgreSQL, mocked browser, provider doubles, provider
  sandbox, live Supabase, production and physical device** outcomes distinct.
  Sandbox and live delivery, payment and handset results stay UNRUN.

## Finish with

Base and final SHA, branch, delivered scope, the runbook and findings links,
verification categories with counts, the **actual** pending migration status,
the gate decision you made and why, and the concrete remaining
owner/provider/device decisions. Describe unavailable features plainly.

**Stop after 15.1.** Do not start 14.1, 15.2, Codex's batches, the integration
change, or any live application, merge, deployment or publication.
