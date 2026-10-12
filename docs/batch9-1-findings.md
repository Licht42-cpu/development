# Batch 9.1 findings

Written while implementing company-owned Christmas sets and seasonal
recovery. Each of these is a thing that was discovered by doing the work
rather than by reading the brief, and each changed what shipped.

**Nothing in this batch has been applied to the live database.**

---

## 1. Dropping a column silently took an index with it

`ns_rental_sets` carried `ns_rental_sets_status_idx` on
`(status, season_year desc)`. Batch 9.1 drops `season_year`, and PostgreSQL
drops any index that depends on a dropped column **without comment** — no
notice, no warning, nothing in the migration output.

So the seasonal screens' opening query ("where are my stored sets") would
have lost its index the moment this migration ran, and nobody would have
known until the table was large enough to notice. The migration now rebuilds
it under the same name on what is left.

This was found by rehearsing the pending sequence against a disposable
database, not by reading the migration. It is exactly the class of thing a
rehearsal is for, and the reason the owner's instruction to rehearse the
whole pending sequence was worth following.

**Related limitation, now tested rather than assumed.** Once 9.1 has
restructured `ns_rental_sets`, re-applying Batch 8.1's table migration on
top of it fails — its `create index if not exists ns_rental_sets_customer_idx`
names a column 9.1 deliberately removed. That is inherent to migrating by
`ALTER` and is **not** a production scenario: Supabase applies each migration
once, in filename order. `tests/db/batch9-1.test.mjs` A9 asserts the failure
and why, so the boundary is a documented fact instead of a surprise for
whoever next re-runs a migration by hand.

## 2. "Recovered" is not "free" — the hole the UI found

The first implementation treated an assignment as holding the set only while
its status was `assigned` or `installed`. Recovery moved it to `removed`,
which meant:

* the admin screen, which loaded "active" assignments, could not see a
  recovered set's assignment at all — so **the Release button could never
  appear**, and a season could never be closed from the UI; and
* worse, once that set passed inspection it read as `available_for_reuse`,
  so it could be promised to a second customer **while the first season's
  assignment was still open**. Two rows would both read as current, with
  nothing to say which one the set was answering to.

The fix makes release load-bearing: an assignment is OPEN while its status
is `assigned`, `installed` **or** `removed`, and only release (or cancel)
closes it. The partial unique index
`ns_seasonal_assignments_one_open_per_set` enforces it against anything that
reaches the table, not only against the RPC.

This is worth naming because the first version passed every database test I
had written. It took building the screen to notice that a state existed
which no button could reach, and following that thread to the double-booking
underneath. `batch9-1.test.mjs` D1b, D1c and D1d now fail without the fix
(verified by reverting the predicate: 64/67 instead of 67/67).

## 3. Recovery must not be allowed to stand in for inspection

A crew reporting "looks fine" at the kerb and a bench inspection concluding
"usable" are different claims, and conflating them is how a set with a
cracked channel goes back out. So `recover_seasonal_set` records what the
crew saw in `ns_seasonal_assignments.recovery_condition` and resets the
set's own `condition` to `uninspected` with `inspected_at` null — **every
time**, including for a set inspected last season.

One exception, made deliberately: `missing`. Nothing came back, which is a
fact the crew established by looking at an empty roof, not a guess about a
thing in a bag. Forcing a second call to confirm an absence would be
ceremony, and would leave the assignment unreleasable in the meantime.

## 4. A PL/pgSQL trigger shared by two tables resolves fields at run time

The set/assignment agreement guard runs on both `ns_rental_sets` and
`ns_seasonal_assignments`. The obvious first draft —
`coalesce(new.set_id, old.set_id, new.id, old.id)` — looks defensive and is
not: PL/pgSQL resolves record fields at **run** time, so `new.set_id` on
`ns_rental_sets` is not a null, it is error 42703, and it would have fired
on every single set update.

The guard now branches on `tg_table_name` and `tg_op`. Caught before the
first test run, by reading rather than by failing, but it is the kind of
thing that reads as correct in review.

## 5. The whole pending sequence rehearses clean — and it is ten, not eight

`supabase.list_migrations` on the live project reports the last applied
migration as `20261009013557`. Everything after it is pending: **ten**
migrations, not the eight carried in earlier notes (the two 9.1 files are
new).

`node tests/db/rehearse-pending.mjs` applies all ten in filename order
against a disposable database. **All ten apply clean**, which is more than
was expected — the Batch 5 content freeze was assumed to need quoting
objects no fixture reproduces, and it does not.

One honest caveat about the tool: the Batch 7.1 fixture deliberately grants
`ns_legacy_writer` to `anon` so that the 7.1 migrations' inherited-privilege
check has something to catch. With that membership in place those two
migrations correctly refuse to finish. The rehearsal revokes it first and
says so in a comment — otherwise it would print a red line every run and
teach everyone to ignore it. The 7.1 suite still exercises the hostile case
directly; that is its job, not the rehearsal's.

## 6. A missing half of the roadmap's 9.1 section

The roadmap's own 9.1 entry covers two things: the Christmas sets (built
here) **and** a permanent-lighting half — reviewed material sheets, sealed
kit opening, component availability, compatible product references,
worthwhile offcuts, and heating-kit selection in the material sheet.

The brief delivered for this batch covers only the Christmas side. Rather
than invent requirements for the other half or silently drop it, it is
recorded here and in §12 of the seasonal contract as **not built**, so
whoever schedules 10.1 can decide whether it moves there or returns as a
9.1 corrective.

## 7. Supplier catalogue data is still unobtainable, and still not invented

`lightsdepot.ca` remains unreachable from this environment
(`getaddrinfo ENOTFOUND`, then `CONNECT tunnel failed, 403`) — the same wall
Batch 8.1 hit with `permanentlightingdirect.ca`. No catalogue item, pack
size, price or specification has been written into any migration or fixture.
Every material in the tests is named `FIXTURE …` precisely so it cannot be
mistaken for a real part. Batch 8.1's outstanding item 8 (a `lightsdepot.ca`
supplier row) is therefore still outstanding: the row needs a name and a URL
the owner confirms, not a guess.

## 8. Smaller things

* **`.badge--danger` does not exist.** The admin stylesheet defines `badge`,
  `badge--ok`, `badge--warn` and `badge--muted` only. Lost, damaged and
  missing would read better in red, but inventing the class here would
  either do nothing or mean editing a shared stylesheet the other track is
  also working in. The badge **text** carries the severity instead, and the
  reason list under each set spells it out in a sentence. Flagged rather
  than patched around.
* **A `<label>` may only contain phrasing content.** The assignment form's
  customer search started as a label wrapping an input *and* a button; the
  button is now a sibling. Same family as the Batch 8.1 `<p>`-inside-
  `<label>` finding.
* **The screenshot probe cannot see everything.** It reported no layout
  problems at 390px while the recovery form's placeholder was being clipped
  mid-word and inline forms were opening *below* an expanded history, a
  screen away from the button that opened them. Both were found by looking
  at the PNG. A probe that measures overflow is necessary and not
  sufficient.

## 9. What the review of `abedf0f` found, and what each finding became

A read-only review on `codex/batch-10-2-prep`
(`docs/reviews/seasonal-contract-abedf0f.md`, that branch) raised seven
points against the seasonal work. Every one was checked against the source
before anything was changed; four were real defects, one was an error in
the contract document, and two were decisions the contract had not made.
All seven are corrected forward in
`20261012090000_batch9_1_corrective_seasonal_review.sql` — the 9.1
migrations are not edited, because they have been rehearsed and the field
track reads them. The contract is now v1.1, with the caller-visible
differences tabulated at its head.

| # | the finding | verdict | what it became |
|---|---|---|---|
| 1 | a crew's replay returned before the scope check, and returned the replayed event's set | **real** | one guard, `ns_seasonal_replay_guard`, which checks kind, target and `can_handle_set` before returning anything |
| 2 | §7's conservation expression was not an invariant for every allowed build/strip | **real** | `built_quantity`/`stripped_quantity` on the set; a strip must reverse a build that provably happened, for the same material, within its quantity; the remainder is named as scrap |
| 3 | a `:build`/`:strip` key could pick up an unrelated pre-posted movement | **real** | `ns_verify_stock_operation` requires the returned operation to hold exactly the movement asked for |
| 4 | a set recovered but not released could be retired | **real** | the check now reads `assigned/installed/removed`, agreeing with its own error message and with the open-assignment rule 10.1 depends on |
| 5 | §11 called an `assigned` set "loaded" on a van | **document** | §11 now points at `docs/daily-load-contract-v1.md` as the authority on van contents, and says why `assigned` is a commercial fact rather than a location |
| 6 | availability flags could be NULL and could overlap | **real** | every flag `coalesce`d to false; the reasons returned as an ordered `blocking_reasons` list, and the v1.0 claim that exactly one applies retracted |
| 7 | a state no-op recorded nothing while reporting `replayed`, and replay compared kind but not target | **decision** | `no_op` added to the response, with a table in §4 saying which combination means the key was recorded |

Checks M1–M9 in `tests/db/batch9-1.test.mjs` are one per finding. Each of
the nine fails when the corrective is removed from that suite's migration
sequence (67 of 76 passing without it), so the suite proves the corrective
rather than merely coexisting with it.

**Two things the fix turned up that the review did not.**

* **`blocking_reasons` is complete only because of a trigger somewhere
  else.** Making the list the whole explanation means it must be empty
  exactly when the set is available. Six reasons cover every way the four
  availability legs can fail — but only because
  `ns_guard_set_matches_assignment` makes `deployed` and an `installed`
  assignment imply each other, so `with_a_customer` always accounts for a
  deployed set. A seventh reason was written for "deployed with nothing
  open" before that trigger was found refusing the state outright; it was
  removed, and M9 now asserts the correspondence over **every row** of the
  view *and* asserts the trigger refuses the direct write. Relax the
  trigger and the suite says a reason is missing.
* **The admin screen was already right about overlap, and silent about
  nothing.** `unavailableBecause()` in `seasonal-sets.js` accumulated every
  reason rather than branching on one, so finding 6 never reached the
  screen as a wrong sentence. It did have an empty-list path with no
  output; it now names the status instead, which should be unreachable and
  is cheaper than the alternative — an unavailable set with no explanation
  and no button is something an operator can neither act on nor report.
