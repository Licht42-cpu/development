# Batch 12.1 findings: practical dispatch, property instructions and customer actions

**Branch** `claude/batch-8-1`. **Base** `11a45c2`, which is what the
assignment expected. Assignment:
`docs/prompts/claude-batch-12-1-dispatch.md` at `abf1743` on
`codex/batch-10-2`.

**Nothing has been applied anywhere.** Twenty-four migrations are pending in
filename order. No live migration, grant, data or settings change, no
external message, no merge, no deployment, no APK.

**Codex's 10.2 is complete at `19550a6`** and its handoff (`tests/field-load.md`)
was read, not imported. Its contract survives: the load read, the
recommendation lock, the four-way refusal/conflict/no-response/acceptance
distinction and the online-only load writes all behave exactly as they did,
with one additive field pair and one new refusal case, both named in
`docs/dispatch-contract-v1.md` §10.

---

## What was built

| § | Delivered | Where |
|---|---|---|
| 1 | Ordered day per vehicle; manual reorder, reassignment, reschedule; versioned against concurrent edits; replay-safe per operation; load plans invalidated on both cars without moving stock or rewriting a confirmed plan | `20261016090000` |
| 2 | Whole-day equipment conflicts from authoritative stock, six distinct answers, unknown never zero; seasonal stages as labels with the five acts untouched; owner-triggered winter dispatch with every automation input `unconfigured` | `20261016120000` |
| 3 | Property entrance/hazard/parking, internal note and access code, the one customer-facing sentence, and work zones in a declared coordinate space; private columns served only by a scoped function | `20261016100000` |
| 4 | Blocked access and breakdown reports with attribution, reason and resolution; four dispatch states kept apart from 11.1's accepted completion; two crew-triggered customer messages with five honest outcomes | `20261016110000` |

Admin surface: `admin/js/components/dispatch-day.js`,
`admin/js/components/property-access.js`, and the wrappers in
`admin/js/lib/api.js`. Both components are standalone-mountable and tested
that way; **no route registration and no `admin/js/main.js` edit** — that is
the integration change, not this batch's.

---

## Decisions worth arguing with

### A second source of truth for "which car" would have been the bug

`ns_job_vehicle_assignments` is keyed by `job_id`, so one job on two cars is
**structurally impossible**. The temptation was a `ns_dispatch_stops` table
holding (day, job, position), which would have duplicated membership and
drifted the moment a job was rescheduled. Instead the order is a **sparse
position stamped with the car and date it was set for**: if the job moves,
the position is recognised as `stale` and reported as stale rather than
applied to a day it was never meant for. The suite asserts the primary key
is `job_id` alone, so a later migration that widened it would fail here
rather than in production.

### Invalidating a load plan without rewriting its history

A dispatch edit makes a load plan's recommendations wrong. Marking it
`superseded` is right for a **live** plan and destructive for a **confirmed**
one — the confirmed plan is the record of what the crew agreed to load and
its transfer receipts hang off its lines. So: `invalidated_at` /
`invalidated_reason` are stamped on both, a live plan also becomes
`superseded`, and a confirmed plan keeps its status and receipts while
`confirm_load_plan` gains a fourth refusal for it. Nothing is rebuilt
implicitly: rebuilding is owner-only, creates a revision, and doing it inside
a reassignment would hide a new recommendation behind an unrelated action.

**An order change deliberately does NOT invalidate the load.** The load is a
whole-day decision, so the same tools are wanted whatever order the stops are
visited in. The receipt says so in `load_effect` rather than leaving the
reader to infer it from silence.

### The private columns have no column grant at all

"Define and enforce the scope through both the new surface and any
direct-table path" has exactly one honest implementation: `access_code` and
`internal_note` are **not granted to `authenticated`**, so the only read path
is `get_property_access()`, which checks that the caller owns the business or
crews a vehicle with work at that property. The grant is issued the only way
that works — revoke the table `SELECT`, then grant the columns — because a
column `REVOKE` against a table-level grant does nothing in PostgreSQL. It
warns and carries on; that is the trap the 9.1 corrective hit on
`ns_rental_set_events`, and the migration asserts the outcome with
`has_column_privilege` rather than by attempting a read, because the table
owner bypasses grants and a successful read would prove nothing.

The scope is "has work there **on any date**", not "today": a crew preparing
tomorrow needs tonight's gate code.

### A drawing in a declared space, and a keyboard-first way to draw it

An unanchored drawing must not be able to pass itself off as geography, so
`space` is declared and the points are validated against it: `geographic` is
real lat/lng in range, `image` is 0..1 fractions of a **named** image.
Fractions rather than pixels so a renderer can scale them. `source` is
`owner_drawn` and the CHECK permits nothing else, so the data cannot claim to
be surveyed. Three points minimum, because two points are a line.

The editor is number inputs with Add and Remove buttons. **No drag handle and
no canvas** — a drag handle is unusable with a keyboard and awkward with
gloves, and the pointer canvas belongs to 12.2 anyway. The contract is
complete without one.

### Five states, and the one that gets misread

`cancelled` (commercial), `skipped` (the owner's), `blocked` (the crew went
and could not get in), `work_finished` (tools down) and `accepted_completed`
(the server, with evidence). The dangerous pair is the last two.
`ns_job_dispatch_status` reports all four facts side by side, reading the
completion state from **11.1's own helper** rather than re-deriving it — a
reopen there is a correction row, not a column, and copying that rule would
be exactly the drift the load review found in the DTO. The migration asserts
11.1's `ns_jobs_completion_gate` trigger is still installed, so a batch that
quietly dropped it fails here.

### Unknown is never zero, read from the right column

`ns_material_stock_by_location` cross-joins every material with every active
location and coalesces to `0`. So a material nobody has ever counted reads
as "0 at Base" — which is a lie, and the first draft of the conflict read
told it. "Nothing recorded" is `last_move_at is null`, and the read reports
`null` plus `missing_data`. A level-tracked item has no number at all and
reports its level instead.

### The notification outcome that systems get wrong

`accepted` is queued, not sent. `unknown` is **not** success, and it stays
live and keeps blocking a second request, because the provider may have
neither idempotency nor an outcome lookup and a retry might be the customer's
second identical text — clearing it is a human decision. `unavailable` splits
into two reasons (no provider configured, no number on file) because they are
fixed by different people in different places, and it is returned as a
receipt rather than raised, because the crew needs it on the screen. A crew
cannot record an outcome at all: it does not get to mark its own message
delivered. The recipient is resolved from the job's customer, never supplied
by the caller, and never read back.

### Winter work with no invented rule

No snowfall threshold, no forecast source, no visit allowance, no salt
dosage. Every one is reported as `unconfigured` and the mode is
`owner_triggered`; the owner's stated reason is the record of the decision a
weather rule would otherwise have made. Walkway and deck variants are **one
visit**: the candidate read groups them on one row per property and a second
dispatch to the same property on the same day is refused, so one trip out
cannot become two dispatches and two minimums. No job and no minimum is
created — `dispatch_winter_visit` reuses `reschedule_job` and
`assign_job_to_vehicle`, so the invalidation, the revision checks and the key
ledger behave exactly as they do elsewhere.

---

## Defects this batch found in its own work

| Found by | What |
|---|---|
| `batch12-1` C5 | The conflict read reported `usable_at_base: 0` for a material with no stock record at all, because the stock view coalesces. Changed to read `last_move_at` and report `null`. |
| `batch12-1` D1 | `get_dispatch_day` selected only `current`/`confirmed` plans, so invalidating a live plan (which makes it `superseded`) made the read say "no plan" for exactly the day that needed "rebuild me". |
| `phase28` E3 | Both new components passed a **value** callback to `shared/dom.js` `select()`, which hands its handler the change **event**. The space picker was silently setting `zone.space` to an Event. `load-plan.js` was checked and is correct — it already uses `e.target.value`. |
| `phase28` A6 | A crew saw disabled planning buttons. Disabled is not the same as absent: a control it can never use is noise on a 390px screen. |
| fixture determinism | Three orderings were by `uuid` — the conflict items, the state rows and the winter `job_ids` — so two runs produced different files. Ordered by name, state and time instead, which is also what a screen wants. |
| visual QA | The new `skip` group rendered a "Keep it back" button, which would have let a crew overwrite an owner authorisation. Closed in the 10.1 corrective's round two; mentioned here because the same shape of mistake recurred. |

## A drift Codex found, and this batch fixed

Codex's 10.2 handoff reported a non-blocking documentation drift at
`docs/daily-load-contract-v1.md:888`: §13 said **twenty** scenarios and its
older verification table described v2, while the v2.1 introduction and the
actual fixture correctly had twenty-four. It was right. §13 now says
twenty-four, lists the v2.1 additions and records the correction. No
behaviour changed; the implementation always followed the introduction and
the file.

---

## Verification

Local PostgreSQL 16 on an explicitly disposable database with a fail-closed
production guard, and mocked-browser suites against the real components.
**Provider doubles only** — no provider was configured beyond a name in
settings and nothing sent a message.

| | result |
|---|---|
| `tests/db/batch7-1` | 38/38 |
| `tests/db/batch8-1` | 132/132 |
| `tests/db/batch9-1` | 83/83 |
| `tests/db/batch9-1-lighting` | 55/55 |
| `tests/db/batch10-1` | 79/79 |
| `tests/db/batch11-1` | 60/60 |
| **`tests/db/batch12-1`** | **79/79**, new |
| `npm test` (browser regression) | green |
| `npm run test:admin` | phase22 18/18 · phase23 55/55 · phase24 37/37 · phase25 25/25 · phase26 29/29 · phase27 16/16 · **phase28 28/28**, new |
| pending-migration rehearsal | **24 of 24** apply in filename order from a clean disposable database, 0 blocked, 0 unexplained |
| fixtures | `tests/fixtures/dispatch-v1.json`, 9 scenarios, byte-identical across two clean rebuilds |
| visual QA | dispatch and property screens at 390 / 430 / 1280, screenshots inspected, no overflow, no page errors, every control Tab-reachable and Enter-operable |
| skipped | none |
| expected failure | none declared |
| **live Supabase** | **UNRUN** |
| **production** | **UNRUN** |
| **real SMS/email delivery** | **UNRUN** — provider doubles only |
| **Android / device** | **UNRUN** — not this batch's scope |

A local database result is not live readiness and nothing here claims it is.

---

## Remaining decisions, stated rather than defaulted

1. **The operating timezone** is still unset, so a day is still counted
   midnight-to-midnight UTC and both the load and dispatch screens say so. It
   is one `app_settings` row (`operations.work_day_timezone`) and it is the
   owner's to choose.
2. **The SMS provider** is unset. Every `on_the_way` and `access_request`
   returns `unavailable` with that reason until
   `app_settings.notifications.sms_provider` exists, and the provider's
   idempotency and outcome-lookup behaviour decides whether the honest retry
   rule in §8 can be relaxed.
3. **Whether a crew may clear its own `blocked`** is currently no: returning
   a stop to `planned` is the owner's, because undoing somebody's report of
   what happened at a property is a decision. Cheap to change if the owner
   disagrees.
4. **An "arrived" state** does not exist here. GPS proximity is not arrival
   and this batch refuses to imply it; if 12.2 needs one it is 12.2's to
   define.
5. **The seven 11.1 business questions** are untouched, as are supplier
   specifications, pack conversions, chemical dosages, renewal cutoffs and
   the missing Permanent Lighting Phase D document.
