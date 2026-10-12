# Dispositions: the six daily-load findings that blocked 10.2

**Source.** `docs/reviews/daily-load-contract-1ffafc2.md` at `b948db3` on
`codex/batch-10-2`, a static read-only inspection of `1ffafc2`. Codex
declined to implement against it, which was the correct call: **four of the
six were backend defects in 10.1**, not gaps in the prose, and an interface
built on them would have shown the operator things that were not true.

**Every finding was verified against this repository's own source before
anything was changed**, then reproduced as an executable check that fails
against the original 10.1 SQL and passes against the corrective. The proofs
are K1–K12 (round one) and L1–L11 (round two) in
`tests/db/batch10-1.test.mjs` (79 checks).

**Nothing was applied to the live database.** The fix is **two** new
migrations — `20261014090000_batch10_1_corrective_load_contract.sql` (round
one) and `20261015090000_batch10_1_corrective_day_boundary_and_lock.sql`
(round two, below) — applied in filename order. The 10.1 migrations are not
edited, and `ns_load_plan_view` is left exactly as it was so nothing already
reading it breaks.

| # | verdict | proof |
|---|---|---|
| 1 | contract gap **and** implementation drift — both fixed | K1, K2 |
| 2 | **real defect** — fixed | K3 |
| 3 | **real defect**, four operations — fixed | K4, K5, K6, K12 |
| 4 | contract gap — fixed, and receipts are now stored | K7 |
| 5 | **real defect**, an accounting bug — fixed | K8, K9 |
| 6 | **real defect** — fixed | K10, K11 |

**Round two.** Re-reading the assignment against what round one shipped
found two things it had documented without implementing. Both are in §
"Round two" below, and both are real: a work date with an unchosen timezone,
and a confirmation that could accept a recommendation the crew had not seen.

| # | round-two verdict | proof |
|---|---|---|
| 1 | **real defect** — the work date's timezone was never stated, and the code's unchosen answer disagrees with the field console's own day boundary | L1, L2, L3, M1–M3 |
| 2, 4, 6 | **real defect** — a Manual Keep or an authorised exception changed the recommendation without changing anything a confirmation checked | L5, L6, L7, L11, M4, M5 |
| 6 | **real defect, found during round two's visual QA** — a crew Manual Keep overwrote an owner authorisation's wording, and the admin screen had no group for a `skip` line at all | L10, M4 |
| 3 | **gap in the proof, not the code** — concurrency was asserted nowhere | L8 |
| 5 | **gap in the proof, not the code** — closing with no plan, and an estimate reaching the ledger as an estimate, were asserted nowhere | L9 |

**None was disproved.** Eleven of the twelve new checks fail without the
corrective; K9 passes without it because it asserts behaviour that was
already correct (a non-damaged variance adjusts usable only), which makes it
a regression guard rather than a defect proof. Said plainly because a test
that passes either way proves nothing on its own.

---

## 1. The crew read path was never frozen, and the implementation had drifted

**Reproduced by reading.** `build_load_plan` is owner-only and
revision-generating, so opening a crew screen cannot call it, and v1
described no read at all. Meanwhile `admin/js/lib/api.js`'s `getLoadPlan`
queried `ns_load_plan_view` and built its own DTO which **omitted
`location_id`, the plan note, the needs-review count and the
unassigned-job count, and filtered `closed` plans out entirely** — so last
night's closing count was unreadable, and the document and the only
implementation disagreed with no authority between them.

**Disposition: FIXED, as a function rather than a query.** A view is a
surface a client shapes for itself, which is how the drift happened.
`get_load_plan(location_code, work_date)` returns one envelope: `state`
(`current | confirmed | closed | none`), `can_build`, the plan or null, both
counts, and the day's visits. `ns_load_day_summary` gives the authorised
visits and the vehicles the caller may read, so a screen's vehicle picker
comes from the backend instead of a guess.

Two decisions worth naming:

* **`state: 'none'` is an answer.** Not an error, and not an empty plan. A
  screen has to be able to tell "nobody built one" from "the plan is
  empty", because only the first is something to act on.
* **`can_build` comes from the backend.** A crew facing an empty day is
  told the owner builds plans, rather than shown a button that will refuse
  it. The old read path could not say who was allowed to do anything.

Recovery after a `23514` is written down in contract §3a: re-read, and if
the *basis* changed the plan must be rebuilt, which is owner-only — so a
crew's recovery is to show the sentence, not to retry.

**Proof.** K1 (all four missing fields present; `state: 'none'`; a crew gets
`can_build: false` and `42501` on another vehicle) and K2 (a closed day
comes back).

## 2. Clearing a Manual Keep did not reverse the recommendation

**Reproduced.** `set_manual_keep` deleted the durable keep on
`p_keep = false`, but the line update only converted `return → keep` on
*true*; on false it left `action = 'keep'` and the reason
`'Kept back on purpose: …'` with `manual_keep = false`. So
**Return → Keep → clear left a live Keep that nothing had recommended**, and
confirmation then skipped the return. A rebuild would have corrected it —
but building is owner-only, so **a crew could not undo its own keep at
all.**

**Disposition: FIXED.** Setting a keep records `pre_keep_action` and
`pre_keep_reason`; clearing restores them and nulls them. A line the keep
never overrode has both null and nothing moves.

Chosen over recomputing the single line's recommendation: recomputation
would duplicate `build_load_plan`'s derivation in a second place, and two
copies of that logic is how the screen and the plan come to disagree.

**Proof.** K3 — asserts `return` before, `keep` while held, `return` after
clearing, and that the "Kept back on purpose" wording goes with it.

## 3. Three mutations did not enforce the replay guarantees, and one leaked

**Reproduced, four separate problems.**

* `set_manual_keep` validated its key for non-blankness and **never stored
  or looked it up**, and returned no `replayed`. A retry arriving after the
  keep had been cleared **re-applied it** — the precise failure v1 §12 said
  could not happen.
* `authorise_load_exception` returned on a matching key **without comparing
  intent**, so a changed payload got the old answer.
* `reconcile_day_end` returned the stored receipt on a matching key
  **before** its `can_see_location` check, so a crew holding another
  vehicle's key could read that vehicle's closing count.
* `confirm_load_plan` keyed its early return on **plan status**, not on the
  supplied key, so a second confirmation carrying a stale revision or
  fingerprint was answered with a cheerful replay instead of being told the
  plan had moved.

**Disposition: FIXED with one ledger and one guard.**
`ns_load_operations` holds the key, kind, location, work date, intent
fingerprint, actor and **the receipt returned**; `ns_load_replay_guard`
checks **kind, then scope, then intent** in that order and returns the
stored receipt.

Three things about that design:

* **The ledger is a table of its own** because `set_manual_keep` deletes its
  subject row. A key recorded on the subject does not survive the operation
  it was meant to make replayable, which is exactly how the late retry
  re-applied a cleared keep.
* **Scope before intent**, deliberately: a caller who cannot see the
  location the key was first used on is refused with `42501` and learns
  nothing about what the key was for. Checking intent first would leak
  "that key exists and your payload differs".
* **The count array is sorted before hashing.** Two clients counting the
  same van in a different order are making the same request, and refusing
  that retry would be a bug rather than a safeguard.

A **different** key against an already-confirmed plan is now a duplicate
(`23505`, "already confirmed"), not a retry. Confirming a closed day is
`23514`.

**Proof.** K4 (the late keep retry is a replay and the keep stays cleared;
changed intent is `23505`), K5 (a crew replaying a key for a vehicle it
cannot see gets `42501`), K6 (same key is a retry returning the same
`transfers_posted`; a different key with a stale revision is refused), K12
(a key used for one kind cannot be presented as another).

## 4. The mutation receipts were underspecified

**Reproduced by comparison.** v1 gave the Keep and exception request names
without full types or result schemas, said nothing about reconciliation's
result, and the three SQL functions returned three differently-shaped
objects — none of which matched the document.

**Disposition: FIXED, and the receipts are now stored.** Contract §7, §7a
and §8 give the exact fields with nullability. Each mutation writes the
receipt it returned into `ns_load_operations`, so a replay returns **those
bytes** rather than a fresh derivation that may have moved on.

The Keep receipt gains `replayed` and a `line` object (null when the day has
no live plan — the durable keep still applies to the next build, and the
screen has to be able to show that). The exception receipt gains the
location, work date, subject, quantity, `plan_id`, `lines_affected` and
`line_added`. Reconciliation gains `lines_counted` and `variance_basis`.

**The closing-count basis, which was the other half of this finding.** v1
§4 says plan quantities are generation-time snapshots; Codex was right that
they cannot then be used to validate a physical count hours later. The code
already read the live view — the contract now says so, and the receipt
names it: `variance_basis: "live_usable_on_hand"`.

**Proof.** K7 — asserts every field of all three receipts and that three
rows landed in the key ledger.

## 5. A damaged closing variance adjusted the wrong pool

**Reproduced, and it is the one I would have wanted caught before anything
was built on it.**

`ns_material_stock_by_location.on_hand` is defined as the **usable** pool
(`sum(delta) filter (where condition = 'usable')`), with `damaged_on_hand`
separate — the 8.1 reservations migration, lines 363–389. `reconcile_day_end`
computed the variance against that usable figure and then posted the
movement with `condition = 'damaged'` whenever the reason was damaged. Ten
usable, zero damaged, counted at eight:

```
before   usable 10   damaged  0
posted   −2 on the DAMAGED pool
after    usable 10   damaged −2        <- both wrong, one negative
```

It is the same "**condition names a POOL, reason says WHY**" mistake the 9.1
corrective fixed in `scrap_offcut`, reintroduced here.

**Disposition: FIXED, and the decision it needed is recorded.** Two
questions had to be answered, and the contract now answers them in §8:

1. **Is the count usable or total?** **Usable.** That is what a crew counts
   on a van — what is there and fit to use — and it is what `on_hand`
   means.
2. **Are damaged items retained or written off?** **Retained.** They are
   still on the van; they are just not fit to use.

So reason `damaged` is **two** movements — the variance off `usable`, its
negation onto `damaged` — and the total on the van does not change. Every
other reason stays a single usable-pool adjustment, which is what the
previous version did correctly.

A **positive** variance explained as `damaged` is now refused (`23514`):
damaged stock reduces what is usable, so a surplus cannot be explained that
way, and guessing between "somebody found stock" and "the reason is wrong"
is how a pool goes negative in the first place.

**Proof.** K8 asserts the pools move `{10,0} → {8,2}`, that there are
exactly two movements with the right signs and conditions, and that a
surplus called damaged is refused. K9 is the regression guard for the other
reasons.

## 6. Authorised exceptions had no effect on confirmation

**Reproduced.** `authorise_load_exception` stored the row and stamped
`exception_id` on the matching plan lines. Nothing ever read
`skip_required` or `carry_extra`: `confirm_load_plan`'s transfer loop
selects on `action in ('add','return')` and transferred the line regardless.
And `ns_load_plan_result` — the serializer every mutation and the read path
actually return — **dropped `exception_id`**, which the view carries, so a
screen could not even tell an authorised skip from an ordinary line.

An authorised "go without it" therefore loaded it anyway, and an authorised
extra for something absent from the plan could not be carried at all,
because confirmation only walks plan lines.

**Disposition: FIXED, with one versioned signature change.**

* `skip_required` sets the line's `action` to the new value `'skip'`,
  `data_state` to `'exception'`, and a reason naming the authorisation.
  Confirmation's loop does not include `'skip'`, and the receipt reports
  `lines_skipped_by_exception` so the difference between the plan and the
  van is stated rather than silent.
* `carry_extra` increases `required_qty` on an existing line, or **creates
  an `add` line** when the item is absent from the plan.
* `authorise_load_exception` gains `p_quantity numeric default null`. A
  `carry_extra` of a quantity-tracked material **requires** it (`22023`):
  an authorisation with no amount is not something a confirmation can act
  on. A set has no quantity and a level-tracked supply has no number, so
  both are exempt. A `skip_required` must not carry one.
* `ns_load_plan_result` exposes `exception_id` and `pre_keep_action`.

The eight-argument function is **dropped** rather than left beside the
nine-argument one: PostgreSQL refuses both (42P13 — "cannot remove
parameter defaults from existing function"), and leaving two would mean one
of them silently has no effect on the load. Every existing eight-argument
*call* still works, because the new parameter is defaulted.

**Proof.** K10 (the skipped item never leaves Base, the line reads `skip`,
the response exposes the exception, the receipt counts it) and K11 (no
quantity is `22023`; with one, a line is added and the extra reaches the
van).

---

## Round two: two findings round one documented but did not implement

### Finding 1 again — the work date had no timezone, and that is not cosmetic

**Reproduced by reading, then by test.** `ns_vehicle_day_jobs` and
`ns_unassigned_day_jobs` bucketed the day as
`(scheduled_for at time zone 'UTC')::date`. Nobody chose UTC; it is what
gets written when the question is not asked. Meanwhile the field console's
own visit list — `api.js listTodaysVisits`, which the crew's schedule has
used since Batch 4 — bounds the day at the **device's local midnight**.

West of Greenwich those two disagree for every late-afternoon job. L2 is the
case: a visit at 18:30 on the 9th in Edmonton is 01:30 on the **10th** in
UTC, so it is on the crew's schedule for the 9th and absent from the 9th's
load plan. The van is loaded for a day that does not contain the job, and
nothing anywhere says why.

**The fix does not invent the timezone**, because it is a business fact and
the owner's to set: `ns_work_day_timezone()` reads
`app_settings.operations ->> 'work_day_timezone'`, `ns_work_day_bounds()`
turns a date into a half-open instant range, and both day-membership
functions use it. While nothing is set the bounds stay UTC — byte-identical
to the previous behaviour, so no plan changes under anyone silently — and
every read reports `work_day_timezone_state: 'unconfigured'` so the screen
can say that evening work may fall on the next day's plan. A zone name
PostgreSQL does not know is treated as unset rather than raising: one
malformed settings row must not stop the crew seeing the day (L3).

**The business decision this leaves open, stated rather than defaulted:**
*which* timezone the operating day runs in. Nothing in the repository
records it, so nothing here chooses it. Until it is set the behaviour is
unchanged and visibly flagged.

### Findings 2, 4 and 6 again — a confirmation could accept an unseen recommendation

**Reproduced by test.** A plan's `basis_fingerprint` covers the day's
schedule. A Manual Keep (round one's own fix) and an owner-authorised
exception (round one's other fix) both change what the lines *say to do* —
and neither touches the revision or the basis. So L6: the crew reads the
plan, somebody holds the bleach kit back, the crew confirms the screen it is
still looking at, and both of round one's checks pass. The transfers posted
are not the ones anybody agreed to.

**The fix** is `ns_load_plans.lines_fingerprint`, maintained by a trigger on
`ns_load_plan_lines` — by trigger and not by each writer, because the
writers are the problem and a third one added later would forget. It is
returned everywhere the plan is returned, and `confirm_load_plan` now
**requires** both the revision and the lines fingerprint the caller was
shown (`22023` if either is missing, L5). It covers the item, action,
required quantity, level, data_state and manual-keep flag of every line, and
deliberately ignores the reason wording and the six reporting quantities:
re-wording a reason, or `available_qty` moving because Base took a delivery,
does not change what the crew must do, and a lock that fired on those would
train everyone to click through it (L11).

Two consequences worth naming:

* **It is a breaking change**, the second in this corrective. The
  five-argument `confirm_load_plan` is dropped and asserted gone — a
  surviving overload would be a confirmation path with no lock on it. A
  five-argument call still resolves and now fails with `22023`. There is no
  compatibility path that skips the check, deliberately.
* **The admin console was the other half of finding 6.** `load-plan.js`
  rendered Keep, Add and Return and had no group for `skip`, so an
  owner-authorised set-aside was invisible on the screen while being
  perfectly visible in the backend's response. It now has one, with its
  authorisation reason and an "Owner authorised" badge (M4). Screenshotting
  that new group is what turned up the next item.
* **A crew Manual Keep could overwrite an owner authorisation.** The new
  group rendered a "Keep it back" button on the set-aside line, and
  `set_manual_keep` would have replaced the authorisation's wording with
  "Kept back on purpose" on the way past. A keep against a `skip` line now
  records the durable keep for the next build and leaves the live line as
  the owner set it; the screen offers no such control (L10, M4).

### Two things round two also closed in the proof rather than the code

Finding 3's concurrency clause and finding 5's "normal, estimated, level,
damage and unconfirmed-day closing must all work" had no assertions behind
them. L8 races two connections on one key — one acceptance, one `23505`, the
stock moved once, and a later retry still replaying the original receipt.
L9 closes a day for which no plan was ever built and checks the estimate
reaches the ledger as `count_precision: 'estimated'` rather than as an exact
figure. Neither found a defect, which is reported as such.

---

## Two things this turned up that the review did not

### A second vehicle changes the rules for every test above it

10.1's G2 rule is that with two vehicles an **unassigned** job belongs to
neither plan. The K block creates Car B to exercise scope — and that
silently switched every K job into "belongs to neither", so plans built with
no job lines in them and the failures surfaced somewhere unrelated. Every K
job is now assigned to Car A explicitly, with a comment saying why.

Worth recording because it is a property of the fixture, not of the code:
any future test that adds a vehicle inherits it.

### `p_keep boolean default true` cannot be dropped

The first draft of the replacement `set_manual_keep` declared
`p_keep boolean` with no default, and PostgreSQL refused the whole migration
with 42P13 — removing a parameter default would stop a five-argument call
that worked yesterday from resolving. The default is kept, and the same rule
is what forced the drop-then-create for `authorise_load_exception`.

---

## Verification

| | result |
|---|---|
| `batch10-1` | **79/79**: K1–K12 (round one) and L1–L11 (round two) |
| without round one's migration | 54/66 — **eleven of the twelve K checks fail** |
| without round two's migration | 57/78 — **ten of the eleven L checks fail** |
| `batch7-1` / `batch8-1` / `batch9-1` / `lighting` / `batch11-1` | unchanged |
| `phase26` | **29/29**: L1–L2 (round one) and M1–M5 (round two) |
| pending-migration rehearsal | **20 of 20** apply in filename order from a clean disposable database, 0 unexplained |
| live Supabase compatibility | **UNRUN** |
| production verification | **UNRUN** |

L4 is the one L check that passes without round two's migration: it asserts
that clearing a Keep restores a whole-day recommendation, which round one
already got right. It is a regression guard, not a defect proof, and is
reported as one.

`tests/fixtures/daily-load-v2.json` has **twenty-four** scenarios, ten of
them added across the two rounds, generated from the real backend and
verified byte-identical across two clean rebuilds. The file keeps its name;
its `contract` field reads `daily-load-contract-v2.1`.
