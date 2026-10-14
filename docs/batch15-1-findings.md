# Batch 15.1 findings: backend release preparation and migration review

**Branch** `claude/batch-8-1`. **Base** `ea263a9`, which is `c6e1e17` — the
SHA the assignment named, and verified as an ancestor
(`git merge-base --is-ancestor c6e1e17 HEAD`) — plus two authorised prompt
commits (`f08edfd` the 15.1 assignment, `ea263a9` the Codex
integration-candidate assignment). Both preserved, nothing rebased away.

**Nothing has been applied anywhere.** **Thirty-one migrations** are pending
in filename order — twenty-eight carried in, three added here. No live
migration, grant, data or settings change, no external message, no merge, no
deployment, no APK.

**Deliverables**

| | |
|---|---|
| the runbook | `docs/release-runbook-v1.md` — ordered application, per-step recovery, owner decisions, the second-crew sequence, integration handoff |
| generated evidence | `docs/release/pending-migration-audit.md` — per-file objects, destructive statements, re-runnability, live-only reach, the whole grant surface |
| the audit tool | `tests/db/audit-pending.mjs` — regenerates the above from the catalog |
| the suite | `tests/db/batch15-1.test.mjs` — 64 checks, including both rehearsed rollbacks |
| corrections | three migrations: the crew-scope reconciliation, trigger-grant hygiene, RLS on the handover tables |
| contracts | completion-evidence **v1.1**, dispatch **v1.1** |

---

## 1. The crew-permission mismatch: fixed, and why it needed more than a fix

### What it was

| | rule | with two cars and an unassigned job |
|---|---|---|
| `can_work_job` (11.1) | any admin, except where the job is assigned to a vehicle the caller cannot see | **the crew's** |
| `ns_can_work_job` (12.1) | assigned to my vehicle, **or** unassigned and exactly one vehicle active | **nobody's** |

So activating Car B would have produced a job a crew could **complete** while
dispatch, the load plan, the customer-message path and the customer report
all excluded it.

### The decision: the stricter rule wins, both of them

`ns_job_crew_scope(uuid)` is now the single rule, returning a **reason**
rather than a boolean — `owner`, `assigned_to_my_vehicle`,
`unassigned_single_vehicle`, `unassigned_needs_a_claim`,
`assigned_elsewhere`, `not_admin`, `no_such_job`. `ns_job_is_mine(uuid)`
reduces it to the boolean the eleven existing guards need, and **both**
`can_work_job` and `ns_can_work_job` now read it. The divergence is
structurally impossible rather than merely corrected, and `batch15-1` B1
asserts both definitions still contain `ns_job_is_mine`.

12.1's rule won because the question has one right answer: with two cars and
nothing assigned, **nobody has said which car is going**, and guessing is how
two crews arrive at one property or one crew reads the other's work.
`ns_can_see_property` carried the same one-vehicle clause and now reads the
same rule through the job.

### Why that alone would have been a worse bug

`can_work_job` gates `register_job_evidence`,
`complete_job_with_evidence` (twice) and `propose_additional_work` — and
`assign_job_to_vehicle` is **owner-only**. Tightening the predicate and
stopping there would mean a crew that **has already done the work** cannot
record it, and cannot unblock itself from a driveway. Losing the record of
completed work is worse than the ambiguity it fixes.

### So the rule ships with a resolution

`claim_job_for_vehicle(key, job_id, reason, expected_revision)` — "this one
is on my car". Admin and crew-callable. It answers the exact fact the
two-car case is missing, from the only person who knows it, and it leaves the
business with **better** data than the lax rule did: which car did the work
is something the stock ledger and the load plan both want.

What it cannot do, and these are the point:

* it cannot take a job off another car — `42501`, because moving work between
  cars is a dispatch decision and the owner's;
* it cannot claim **for** another car — the vehicle is resolved from the
  caller's crew record and is **not a parameter**;
* it cannot unassign;
* claiming what is already yours answers `{no_op: true}` and does **not**
  move the day's revision (`batch15-1` C4);
* it moves no stock — every receipt still says `stock_moved: false`.

**One implementation, two authorised doors.** 12.1's assignment body moved
into `ns_apply_job_assignment(...)`, which authorises nothing and is granted
to nobody but `service_role`. `assign_job_to_vehicle` keeps its exact
signature and owner-only gate; `claim_job_for_vehicle` applies the crew gate.
So invalidation, day revisions, stale-position cleanup and the key ledger
cannot drift between the two paths. The receipt gains one additive field,
`how: 'assigned' | 'claimed'`.

`batch15-1` **D1 is the test that matters**: with two cars and an unassigned
job, a crew is refused `42501`, claims, and then registers evidence and
completes the job — and the job reaches `completed`. The narrowing is real
and no work is lost.

### What I did not do, and why

**I did not fix the four guard messages.** They still say "That job is
assigned to a vehicle you are not on", which is the wrong sentence for a job
assigned to nobody. `ns_assert_job_is_mine()` carries the right one — "not on
any car yet, and there is more than one car running today; claim it for your
vehicle, or ask the owner" — and new code should raise that. The four were
left because changing them means re-emitting their bodies, one of which is
400 lines, and **transcription risk in a release candidate is worse than a
wrong sentence**. It is recorded in completion-evidence v1.1 as a known
wording limitation, with the one-line fix for whichever batch next touches
that file for a real reason.

**I did not make the predicates raise.** A predicate that throws breaks every
`CASE` and view that wants to ask the question without being refused, and
12.1 has policies that call these in boolean position.

---

## 2. Two defects the audit found, both mine

### 2.1 Seven tables with no row-level security — Batch 13.1

**Every** table from 8.1 through 12.1 has RLS enabled with a policy. **All
seven** tables Batch 13.1 added had RLS **off** and no policy, and five of
them grant `SELECT` to `authenticated`:

`ns_completion_reports`, `ns_evidence_publications`,
`ns_handover_operations`, `ns_customer_grant_reads`,
`ns_document_access_tickets`, `ns_report_deliveries`,
`ns_payment_requests` (plus `ns_customer_grants`, which had no grant and so
was never exposed).

In Supabase `authenticated` is **any signed-in user**, not an admin. A grant
with no policy means a signed-in non-admin could read every customer's
completion report straight off the table — captions, totals and all — around
the outside of the capability, the scope and the publication decision that
13.1 spends four migrations enforcing. **The table-level grant was the hole
in a story about not having holes.**

**Why 13.1's own suite missed it.** It asserted the grants it meant to set
(`has_table_privilege('anon', …)` false, `authenticated` false on the hash
table) and never asked whether a logged-in non-admin was *contained*. The
grants were right; the containment behind them was absent. A test that checks
only what it built cannot see what every other batch had and this one did
not. The audit found it by comparing the chain's tables **against each
other**.

Fixed in `20261018110000`, in the house shape: RLS on, one
`for select to authenticated using (…)` policy per table, scoped by the same
predicate the matching RPC uses — `ns_can_work_job(job_id)` for the two
job-scoped tables, `is_owner()` for the owner's own ledgers. `batch15-1` E2
proves containment **with a real role**: `set role authenticated` with
`is_admin` off reads **0 rows** from all seven, and E3 proves that is the
policy doing it by asserting the `SELECT` grant is still there.

The customer's own read is unaffected: the three anon functions are
`SECURITY DEFINER` and run as the function owner.

### 2.2 Twenty anon-executable trigger functions — every batch

The audit's first run reported **24 functions executable by `anon`**. Three
were 13.1's deliberate customer reads and one was `is_admin()`. The other
twenty were **trigger functions**: PostgreSQL grants `EXECUTE` on a new
function to `PUBLIC` unless told otherwise, and every batch's
`revoke … from public` loop listed the RPCs it was adding and not the
triggers it installed beside them.

The direct risk is small — a trigger function called directly refuses anyway.
The real cost is that a release inventory with twenty unexplained entries has
trained its reader to skim, and the next genuinely wrong grant arrives in the
same column.

**Proven safe before being proposed.** On the disposable database, with
`EXECUTE` revoked from `PUBLIC` and `authenticated`, an INSERT as
`authenticated` still fired its `BEFORE` trigger and still got its computed
column, while a direct call was refused `42501`. PostgreSQL checks that
privilege when the **trigger** is created, not when it fires.

Fixed introspectively in `20261018100000` (by return type
`pg_catalog.trigger`, not a naming convention — `guard_quote_customer_content_frozen`
and `ns_touch_updated_at` share no prefix). **24 → 5**, and `batch15-1` E8
pins the surface to exactly the four non-fixture entries so each future
addition needs a stated reason.

`is_admin()` **stays** anon-executable: RLS policies are evaluated as the
session role, so revoking it turns every anon-facing policy that mentions it
into an error instead of a `false`. The migration asserts it is still
reachable.

---

## 3. The audit, and what it refuses to claim

`tests/db/audit-pending.mjs` applies the chain to a disposable database and
asks the catalog what happened — per file: objects created and dropped,
destructive statements, **re-runnability observed by applying it twice**,
live-only tables named, and whether the file introspects first. Then the
whole grant surface, the RLS and policy coverage, and the private columns by
name.

It labels **fixture stand-ins** separately from chain-created objects, and
that mattered immediately: the first version reported `ns_jobs`, `ns_quotes`
and `ns_change_orders` among the RLS-off tables, which reads as a finding and
is not one — they are local reproductions of live-only tables whose real RLS
this database cannot know. With the split, the chain-created list reads
**"None. Every table the chain creates has RLS enabled."** `batch15-1` E1b
asserts the three exclusions really are live-only by checking no migration
creates them.

What the audit says it cannot tell you, in its own header: nothing about the
live project (no base schema), nothing about data (the database starts
empty), nothing about timing or locks under load.

**Results:** 31 pending, **0 failed to apply, 0 not re-runnable**, 5
anon-callable functions (4 real + 1 fixture artifact), 3 anon-readable tables
(all legacy stand-ins, §4.1).

---

## 4. Decisions surfaced, not taken

### 4.1 The legacy tables keep their anon SELECT — deliberately

`job_requests`, `jobs`, `quotes` are anon-readable. Batch 7.1 §3 scoped
itself to anonymous **writes** on purpose and wrote down why — "removing a
read is the more likely of the two to surprise something undiscovered" —
having established all three hold **0 rows**, have no dependent views and are
referenced nowhere in `admin/`, `site/`, `shared/` or `supabase/`.

I did not revoke it. Reversing a documented decision inside a
release-preparation batch is not this batch's business, and the retirement
decision is still blocked on §4.2. It is in the runbook as an owner decision
with the migration shape it would take.

### 4.2 Batch 7.1's open blocker is still open

7.1 reported **one unidentified foreign key** still pointing at a legacy
table; the query naming it was refused by the tooling gate three times and
has never been run. It cannot be answered locally — the constraint is live,
and the fixtures do not reproduce it. The runbook carries the exact read-only
query as step 0.2, before anything is applied.

### 4.3 The five unset settings rows

`operations.work_day_timezone` (a day is UTC midnight-to-midnight until
set), `notifications.sms_provider`, `payments.provider`,
`customer_portal.link_expiry_days`, `quote_defaults.currency`. None is
invented by any migration; each is one `app_settings` row, and the runbook
states what stays unavailable until it exists.

### 4.4 The two missing workers

Neither the notification sender nor the document-signing worker is in this
repository (`supabase/functions` holds `submit-request` only). Applying the
chain changes neither: a queued `notifications` row is a message **nobody has
sent**, and an authorised customer still cannot download a photograph.

---

## 5. Recovery, stated honestly rather than optimistically

The runbook's §3 gives a per-group answer, and the honest answer for four of
seven groups is **"restore from backup"**:

* **Group A** (the Batch 5 freeze, the 7.1 revokes) — not reversible by a
  counter-migration. It is first because filename order puts it there, and it
  is the only group that changes behaviour on data that already exists.
* **Group D** (11.1's completion gate) — dropping the trigger restores direct
  status writes, but accepted completions leave rows the rest of the chain
  reads.
* **Group F** — new tables, but **once a customer link has been issued,
  revoking is not dropping**: dropping `ns_customer_grants` would silently
  stop every issued link working. Revoke, tell the customers, then drop.
* **Group G1** (crew scope) — **no rollback is offered**, deliberately.
  Putting 11.1's laxer rule back re-opens the two-car ambiguity, and the
  forward fix is always available. `batch15-1` F3 asserts the reconciliation
  stays in place so nobody adds one without reading why.

The two rollbacks the runbook **does** promise are **rehearsed, not
asserted**: `batch15-1` F1 disables RLS on the eight tables with the exact
statements the runbook prints, confirms it took effect, re-applies the
migration and checks exactly one policy per table came back (not two). F2
does the same for the trigger grants.

One trap worth naming: reverting 10.1's second corrective means recreating
the 5-argument `confirm_load_plan`, and `admin/js/lib/api.js` now sends six.
Revert the client first or the screen breaks.

---

## 6. Verification

| | result |
|---|---|
| `tests/db/batch7-1` | 38/38 |
| `tests/db/batch8-1` | 132/132 |
| `tests/db/batch9-1` | 83/83 |
| `tests/db/batch9-1-lighting` | 55/55 |
| `tests/db/batch10-1` | 79/79 |
| `tests/db/batch11-1` | 60/60 |
| `tests/db/batch12-1` | 79/79 |
| `tests/db/batch13-1` | 127/127 |
| **`tests/db/batch15-1`** | **64/64**, new |
| pending-migration rehearsal | **31 of 31** apply in filename order from a clean disposable database, 0 blocked, 0 unexplained |
| re-runnability | **31 of 31** applied twice with no stacked policy or trigger |
| rehearsed rollbacks | 2 of 2 (trigger grants, handover RLS) performed and re-applied cleanly |
| browser regression | phase2 18 · phase3 11 · phase4 17 · phase5 13 · phase6 14 · phase7 16 · phase8 17 · phase9 15 · phase10 18 · phase10-5 9 · phase11 18 · phase12 17 · phase13 17 · phase14 13 · phase15 15 · phase16 13 · phase17 16 · phase18 35 · phase19 25 · phase20 24 · phase21 14 · geofence ok · native-wrapper 19 · reload-offline 2 — all green |
| `npm run test:admin` | phase22 18 · phase23 55 · phase24 37 · phase25 25 · phase26 29 · phase27 16 · **phase28 30/30** (+2 for the claim control) · phase29 40 |
| visual QA | `screenshot-batch13-1` re-run: no overflow, no undersized control, no unexpected page error |
| skipped | none |
| expected failure | none declared |
| **live Supabase** | **UNRUN** |
| **production** | **UNRUN** |
| **real SMS / email / payment provider** | **UNRUN** — none selected |
| **Storage signing** | **UNRUN** — no worker in this repository |
| **Android / handset** | **UNRUN** — Codex's 13.2, no device available |

A disposable-database result is not live readiness and nothing here claims it
is. In particular: **31 of 31 applying locally does not mean 31 of 31 will
apply live.** The audit's "Live-only tables each file touches" section is
where an unexplained live failure will come from, and it is per-file for
exactly that reason.

### New suites for the integrator

* `tests/db/batch15-1.test.mjs` — registered in `tests/db/run-db-tests.sh`
* `tests/db/audit-pending.mjs` — a reporting tool, deliberately **not** a
  pass/fail gate, like `rehearse-pending.mjs`
* `tests/phase28.test.mjs` gained two checks (A7b, A7c) for the claim control

`tests/run-regression.sh` is untouched, as required.

---

## 7. Still open after this batch

1. **The unidentified legacy foreign key** (§4.2) — a read-only query on the
   live project, in the runbook as step 0.2.
2. **The legacy-table retirement decision** (§4.1) — blocked on 1.
3. **The five settings rows** (§4.3).
4. **The two missing workers** (§4.4).
5. **The four guard messages** (§1) — wording, with the right text already
   available in `ns_assert_job_is_mine()`.
6. **Integration** — four screens built and reachable from nothing. Codex's,
   per the roadmap's ownership table; prompt at
   `docs/prompts/codex-integration-candidate.md`.
7. **Codex's 13.2 handset qualification** — 16 cases, no device.
8. **Batch 14** — conditional and unauthorised: no routing API, no provider
   costs settled.
9. **The seven 11.1 business questions**, supplier specifications, pack
   conversions, chemical dosages, renewal cutoffs and the missing Permanent
   Lighting Phase D document — all untouched, as always.
