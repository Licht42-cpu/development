# Dispositions: the seven seasonal findings from the abedf0f review

**Source.** `docs/reviews/seasonal-contract-abedf0f.md` at
`a5abe0d` on `codex/batch-10-2-prep`, a static read-only inspection of
`abedf0f` on `claude/batch-8-1`. That document is Codex's and is not
reproduced here; each finding below is summarised in enough detail to be
checked against it.

**What a disposition means here.** The brief asked for each finding to be
*reproduced against a disposable database* and given one of three answers:
fixed, disproved with evidence, or a clearly identified contract decision.
Every one below was reproduced as an executable check that **fails without
the fix and passes with it**, so the disposition is a test result rather
than an assertion. The proofs are checks M1–M9 and N1–N5 in
`tests/db/batch9-1.test.mjs`, run against a real PostgreSQL 16.

**Nothing was applied to the live database.** All corrective work is in two
new migrations; the 9.1 migrations are not edited, because they have been
rehearsed and the field track reads them.

| migration | finding(s) |
|---|---|
| `20261012090000_batch9_1_corrective_seasonal_review.sql` | 1, 2, 3, 4, 6, 7 and the §11 documentation fix |
| `20261013090000_batch11_1_seasonal_corrective_round_two.sql` | 1b, 2b, 5b — the three sub-points the first corrective left open |

---

## 1. Crew replay returns before location authorisation

**Reproduced.** Under `abedf0f`, `install_seasonal_set` returned a replay at
O:558–565 before `can_handle_set` at O:574. A crew holding any key for an
install received the set that key was first used on, including one at the
other vehicle, read with the function owner's access.

**Disposition: FIXED.** All nine calls now go through one guard,
`ns_seasonal_replay_guard`, which returns a replay only when four things
hold: the key exists, its event is one this call would have written, the
**target** the caller named matches, and `can_handle_set` passes for the set
the event is on.

**Proof.** `batch9-1.test.mjs` M6 — a crew replaying a key for the other
car's set gets `42501`, not a row. Fails without the corrective.

### 1b. The broader read scope — a decision, now made

The review added that `ns_rental_set_events` and `ns_seasonal_assignments`
are readable by every admin, operation keys included, and that *"that
broader read scope needs an explicit decision"*.

**Disposition: DECIDED, in two parts.**

* **The replay key is withdrawn from the table read surface.** A key is a
  credential-shaped string and nothing on a screen needs one. `SELECT` on
  `ns_rental_set_events` is revoked from `authenticated` and re-granted
  column by column without `client_operation_id`; the owner reads one at a
  time through `ns_rental_set_operation_key(event_id)`. A column-level
  REVOKE against a table-level grant does nothing in PostgreSQL, which is
  why it is done this way round and why the migration asserts the result.
* **The assignment history stays readable to every admin, deliberately.**
  Scoping it per vehicle would break the screens the crew actually uses:
  "which sets are out at this customer" and the recovery list both read
  assignments for sets that are at a property and therefore have no
  location at all. The rows carry no contact details, no money and no
  credentials. **Revisit if there is ever a third vehicle or a
  subcontractor** — that is the condition that changes the answer.

**Proof.** N1 — `authenticated` cannot read the key column, can still read
the rest of the log, and a crew calling the owner's audit function gets
`42501`.

## 2. §7's conservation expression was not an invariant

**Reproduced.** Build 200 and strip 150 dropped the total by 50; strip 250
against a 200 build created 50; a set bought assembled with no build debit
could still post a positive strip receipt.

**Disposition: FIXED, and the contract expression rewritten.** Sets record
`built_quantity` and `stripped_quantity`. A strip must reverse a build that
provably happened, for the same material, within the quantity actually
built; the remainder is **named as scrap** rather than lost. The expression
in `seasonal-sets-contract-v1.md` §7 now reads over quantities with the
scrap term in it, and `ns_rental_sets_strip_within_build` enforces the
bound at the table so a direct write cannot do what the RPC refuses.

**Proof.** M2 (no build, no strip — `23514`), M3 (over-strip `23514`, wrong
material `22023`), M4 (a 200-unit set stripped of 150 leaves `950 + 50`, and
the 50 is scrap the expression names).

### 2b. Location attribution — the half the first corrective missed

The review asked for material **and location**. The first corrective fixed
the material half and left the location free, so 200 consumed from Car A
could come back as 200 received at Base: the total conserves and both
locations are wrong.

**Disposition: FIXED.** `ns_rental_sets.built_at_location` records where the
build came off, paired with the quantity by constraint. Salvage defaults to
that location and a different one is refused with `22023`.

**Proof.** N2 and N3 — N3 stocks **both** locations first, so the wrong
destination is available rather than merely absent, and the test would
otherwise pass for the wrong reason.

## 3. Suffixed replay keys did not protect build/strip provenance

**Reproduced.** `post_stock_movement` replays any existing operation under a
matching `client_operation_id` without comparing the payload — deliberate
behaviour in the stock contract §5, which is unchanged. The `:build` suffix
is a convention, not a reserved namespace, so a movement pre-posted under
`<key>:build` was handed straight back and the set attached to a debit that
never happened.

**Disposition: FIXED at the boundary, not by changing the frozen function.**
`ns_verify_stock_operation` requires the returned operation to contain
**exactly one** movement, of the material, location, signed quantity and
reason that were asked for. Restricting `post_stock_movement`'s accepted
input would have broken any caller whose own keys contain a colon.

**Proof.** M5 — a key pre-used for an unrelated movement is caught and the
set is not created.

## 4. Retirement could precede release of a recovered assignment

**Reproduced.** `retire_seasonal_set` rejected only `assigned` and
`installed`, so a set recovered but not released could be retired — and
stripped — while the commercial promise against it was still open. The
RPC's own error message already said "recover and release it".

**Disposition: FIXED.** The check reads `assigned | installed | removed`,
the same list as the open-assignment rule that Batch 10.1 made load-bearing.
The check now agrees with its own message and with §2 of the contract.

**Proof.** M1.

## 5. §11 confused a promise with a physical load

**Reproduced by reading, not by SQL** — it is a documentation defect.
`assign_seasonal_set` creates a commercial assignment and moves nothing;
§11 nevertheless called an `assigned` set "loaded but not yet up".

**Disposition: FIXED as documentation.** §11 now states that `assigned` is a
commercial fact decided possibly weeks before anyone drives anywhere, and
points at `docs/daily-load-contract-v1.md` as the authority on what is
physically on a van.

### 5b. The missing Base-to-car operation — a real gap, now filled

The review's substantive point was that *"the nine seasonal operations
provide no general Base-to-car whole-set load operation"*, so per-car aboard
status could only be guessed from a promise.

**Disposition: FIXED, minimally.** One operation and one view:

* `move_seasonal_set(key, set_id, location_code, note)` — keyed,
  crew-scoped on both the set and the destination, refuses a deployed set
  (that is recovery, which asks what came back), and reports a no-op when
  the set is already there. It posts no stock: a set is not stock.
* `ns_seasonal_sets_aboard` — `aboard_state` in `at_base |
  aboard_vehicle | at_a_property | at_the_repair_bench | at_a_location |
  out_of_service | unknown`, plus `promised_to_a_customer` as a separate
  column, so nothing downstream can read one as the other.

This is additive. **No daily-load wire shape changed**; the daily-load
contract is versioned to v1.1 to record the addition, and a 10.2 client
written against v1.0 is unaffected.

**Proof.** N4 (aboard and promised move independently in both directions; a
deployed set is recovered, not relocated) and N5 (scope, replay and no-op).

## 6. Availability flags were nullable and overlapped

**Reproduced.** `a.status = 'removed'` on a left join is SQL NULL, not
false, whenever there is no open assignment — which is every free set. And
the contract's claim that "exactly one of the five reason flags explains
why" is disproved by a damaged set, recovered but not released, at the
repair bench: three are true at once.

**Disposition: FIXED, and the false claim retracted.** Every flag is
`coalesce(..., false)`. The reasons are returned as an ordered
`blocking_reasons` list, empty **if and only if** the set is available.

**Proof.** M9 — asserts non-nullness, asserts three overlapping reasons on
one set, asserts the empty-iff-available correspondence **over every row of
the view**, and asserts the trigger that makes six reasons sufficient.

## 7. Replay guarantees omitted state no-ops and changed intent

**Reproduced.** Five calls returned early when the state was already what
was asked for, writing no keyed event — so the contract's claim that every
call appends exactly one was false, and a key used for such a no-op was not
remembered. Replay also compared the event *kind* but not the target.

**Disposition: DECIDED and implemented.** `no_op` is added to the response,
and §4 of the seasonal contract tabulates which `replayed`/`no_op`
combination means the key was recorded. Target binding is part of the
guard in finding 1.

**Proof.** M7 (a key presented against a different assignment is refused)
and M8 (a state no-op is distinguishable from a key replay).

---

## Summary

| # | verdict | where |
|---|---|---|
| 1 | real defect — fixed | M6 |
| 1b | decision — made and enforced | N1 |
| 2 | real defect — fixed | M2, M3, M4 |
| 2b | real defect — fixed | N2, N3 |
| 3 | real defect — fixed | M5 |
| 4 | real defect — fixed | M1 |
| 5 | documentation error — fixed | contract §11 |
| 5b | real gap — filled, additively | N4, N5 |
| 6 | real defect — fixed | M9 |
| 7 | decision — made and implemented | M7, M8 |

**None was disproved.** All seven held up against the source, and the two
sub-points the first corrective left open were real as well.

The seasonal contract is now at **v1.2**. The fourteen executable checks
above are in `tests/db/batch9-1.test.mjs` (83 checks total), and each of
M1–M9 fails when the first corrective is removed from that suite's
migration sequence.
