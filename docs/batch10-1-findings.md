# Batch 10.1 findings

Written while implementing the 9.1 permanent-lighting corrective and daily
vehicle load planning. Each of these changed what shipped.

**Nothing in this batch has been applied to the live database.**

---

## 1. "Permanent Lighting Phase D" does not exist in this repository

The roadmap's 9.1 section says to "fold confirmed Permanent Lighting Phase D
requirements into this same stock system". There is no such document:

* not in `docs/` on this branch,
* not in `docs/plans/` on `codex/roadmap-after-batch-7`
  (`batch-plan-after-7.md`, `claude-roadmap-handoff.md`,
  `service-operations-blueprint.md`, `README.md`),
* not anywhere in the repository — a case-insensitive search for "phase d"
  finds only an unrelated heading in `QUOTING_ENGINE.md`.

The permanent-lighting half was therefore built from what IS recoverable:
the roadmap's own 9.1 paragraph, the blueprint's kit and offcut sections,
and the handoff's rule that an unopened kit and its components may never
both count as available. **If Phase D contains requirements beyond those,
they are not built**, and no attempt was made to guess them.

## 2. `condition` names a pool; `reason` says why — and I got it backwards

`scrap_offcut` first posted the write-off as `condition = 'damaged'`. That
looks right and is wrong. In this ledger:

* `condition` names **which balance** the quantity moves in or out of;
* `reason` says **why** it moved.

Posting `condition='damaged', delta=-30` drove the *damaged* pool to −30 and
left the *usable* count still claiming a 30 ft piece that was in the bin.
The correct posting is `condition='usable', reason='damaged'` — it leaves
the usable pool, because it is damaged.

Caught by a test that asserted the usable balance afterwards. Worth naming
because the wrong version reads perfectly well, and because `post_stock_movement`
already had it right: its `damaged` reason defaults `p_condition` to
`'usable'`.

## 3. An offcut must not add stock

The first instinct is that recording a 3 ft offcut adds a 3 ft piece. It
does not: cutting 7 ft off a 10 ft stick already consumed 7, so the ledger
says 3 ft is there. The piece record says that the 3 ft is **one** 3 ft
piece rather than three 1 ft ones.

So `record_offcut` posts no movement at all, and a deferred invariant keeps
the sum of available offcut lengths at or below usable on-hand. Without the
invariant the two drift and the piece list starts promising material that is
not on the shelf.

The user-visible consequence is `longest_runnable`: six feet on hand as two
3 ft offcuts cannot cut a 6 ft run, and a screen that showed only the total
would say it could.

## 4. `post_stock_transfer`'s eighth parameter is `p_job_id`, not a vehicle

`confirm_load_plan` passed `v_plan.location_id` into it. A location id in a
job foreign key — caught immediately by the test suite, which is the only
reason it is a footnote rather than an incident.

The fix is also the more correct behaviour: a load transfer belongs to the
**day**, not to one job. The whole point of planning across a day is that a
shared tool is not attributed to whichever stop happened to need it first,
so the job reference is null.

## 5. A manual Keep that removes the line is worse than one that returns it

The first version of `build_load_plan` excluded manual-kept materials from
the Return candidates. The effect: the kit the crew deliberately held back
disappeared from the plan entirely on the next rebuild. They could not see
it, could not un-keep it, and had no way to tell whether the keep had
registered.

A kept item now gets a line — as a `keep`, with the operator's reason —
rather than vanishing. "Manual Keep survives" means survives *visibly*.

## 6. A revision number is not enough to catch a stale confirmation

The obvious design is: the plan has a revision, the crew confirms a
revision, a mismatch is refused. That catches "somebody rebuilt the plan".

It does **not** catch the more dangerous case: the schedule moved and nobody
rebuilt. The revision still matches, the plan still reads as current, and
the job it was built for was cancelled an hour ago.

So a plan also stores a `basis_fingerprint` — a hash of the day's jobs,
their times, their statuses, their measured quantities and their seasonal
assignments — recomputed live at confirmation. `batch10-1.test.mjs` D4 adds
a stop after the build and confirms that only the fingerprint catches it.

## 7. Closing a day must not require having confirmed one

The first constraint said `status not in ('confirmed','closed') or
confirmed_at is not null`. That makes an honest case impossible: the crew
went out without confirming the load, the work happened, and the counts at
the end of the day are still worth recording.

`closed` no longer requires a confirmation. The test that caught this was
reconciling a day whose live plan had never been confirmed — which is simply
what a normal day looks like when nobody tapped the button.

## 8. Mixing a comma join with an explicit JOIN

`ns_next_day_suggestions` had `from ns_vehicle_baselines vb, loc join
ns_materials m on m.id = vb.material_id`. The explicit JOIN binds to `loc`,
not to `vb`, and PostgreSQL reports it as "invalid reference to FROM-clause
entry for table vb". Dropping the comma join and using a scalar subquery
fixes it. Noted because the error message does not point at the comma.

## 9. A PL/pgSQL record field that does not exist is an error, not a null

Carried over from the 9.1 findings and hit again here in spirit: the
seasonal-set line in a plan has `material_id` null and every quantity null.
The UI's quantity formatter defaulted `aboard_qty` to 0 and printed
"aboard 0" against a Christmas set — which reads as "we have none of it".

Same class as rendering a level supply as zero. The rule that fell out:
**a null quantity is not zero, and a line with no quantities at all has
nothing to say about balances.**

## 10. The fixture set is generated, not written

`tests/fixtures/daily-load-v1.json` is produced by running the real backend
on a disposable database (`npm run fixtures:daily-load`). A hand-written
fixture is somebody's idea of what the contract says; a generated one is
what the contract actually produced, so it cannot drift. Regenerate after
any change and the diff **is** the contract change.

Ids and timestamps are replaced with stable placeholders so two runs on two
machines produce identical files.

## 11. Smaller things

* **`ns_jobs.scheduled_for` was missing from the test fixtures.** It exists
  on the live project and the admin console reads and writes it in five
  places, but the Batch 8.1 fixture predated needing it. A load plan is "the
  work for this car on this date", so it is the one input the whole batch
  turns on. Added as `tests/db/fixture-schema-batch10-1.sql`. Another
  consequence of the repository having no base schema
  (`docs/batch7-1-findings.md`, finding 4b) — still outstanding.
* **A level-tracked material must carry `unit = 'level'`.** Batch 8.1 ties
  the two together with a CHECK, so a product cannot be counted in litres
  AND reported as "Low". The test suite tripped over it first.
* **Deleting a vehicle with work assigned to it is refused**, by the
  `on delete restrict` on `ns_job_vehicle_assignments`. That is the rule
  working: a car with a day's work on it cannot simply vanish. The test
  teardown had to release assignments first, which is the right shape.
* **`tests/run-regression.sh` was not edited**, per the brief. The admin
  suites that are not in it (phase22–26) are now separately selectable via
  `npm run test:admin` / `tests/run-admin-suites.sh`, so "not in the main
  runner" never means "not run".
* **Still no `badge--danger`.** Lost, damaged and missing would read better
  in red, but the admin stylesheet defines only ok/warn/muted and the other
  track is working in that file. Badge text carries the severity instead.
  Flagged again rather than patched around.
