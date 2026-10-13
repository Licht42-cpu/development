# Nova Shield seasonal sets contract v1.2 — company-owned Christmas lighting

**Status: frozen at v1.2.** This is the snapshot handed to both tracks.
Neither side invents a counterpart; a change to this document is a new
version, agreed before either side implements against it.

**What changed in v1.1, and why it is a version rather than an edit.** A
read-only review of `abedf0f` (`docs/reviews/seasonal-contract-abedf0f.md`)
found seven problems in v1.0. Four were defects in the migrations, one was
an error in this document, and two were decisions this document had not
made. All seven are corrected forward in
`20261012090000_batch9_1_corrective_seasonal_review.sql` — the 9.1
migrations are not edited, because they have been rehearsed and are read by
the field track. The caller-visible differences:

| § | v1.0 | v1.1 |
|---|---|---|
| 4 | a replay was returned before the caller's scope was checked, and returned the replayed event's set | a replay is returned only after kind, target and scope all match; a key bound to another set or assignment raises `23505` |
| 4 | "every one of these nine calls appends exactly one keyed event" | false for a state no-op, which appends nothing and now says so |
| 4 | the suffixed `:build`/`:strip` ledger key was trusted | the operation it returns is verified to contain exactly the movement that was asked for |
| 5 | response had `replayed` | response has `replayed` **and** `no_op`, plus `built_quantity`, `stripped_quantity` and `blocking_reasons` |
| 6 | "exactly one of the five reason flags explains why" | flags are non-null and several can be true at once; `blocking_reasons` is the ordered list |
| 7 | the conservation expression was not an invariant for a partial strip | the expression names the scrap term, and a strip must reverse a build that provably happened |
| 11 | an `assigned` set was described as "loaded" on a van | what is physically on a van is `docs/daily-load-contract-v1.md`, not this document |

**What changed in v1.2.** Re-reading the same review against the corrected
SQL found three sub-points still open inside findings 1, 2 and 5 — each one
a DECISION the review had asked for rather than a line to patch. They are
closed in `20261013090000_batch11_1_seasonal_corrective_round_two.sql`, and
each disposition is recorded in
`docs/reviews/seasonal-abedf0f-dispositions.md`:

| § | v1.1 | v1.2 |
|---|---|---|
| 8 | every admin could read every operation key off the event log | `client_operation_id` is revoked from `authenticated` at column level; the owner reads one through `ns_rental_set_operation_key(event_id)`. The assignment history deliberately stays readable, with the reason written down |
| 7 | a strip had to name the set's own material, but any location | a build records `built_at_location`, and salvage returns there or is refused (`22023`), so the expression holds per (material, location) and not only in total |
| 11 | nothing recorded a whole set physically moving Base → Car A | `move_seasonal_set(...)` and the view `ns_seasonal_sets_aboard`, which answers per-car aboard status from the set's own location rather than from a promise |

`move_seasonal_set` is a new signature, not a changed one. No existing
signature, response field, error code or grant moved, and the daily-load
wire contract is unaffected (see `docs/daily-load-contract-v1.md` v1.1,
additive).

No signature in §3 moved and no grant changed. `ns_seasonal_result` gained a
fourth argument with a default, and its three-argument form is dropped, so
nothing outside these RPCs can call the old shape and get a response missing
`no_op`.

**This is a companion to, not a revision of,
`docs/operations-contract-v1.md`.** That document (stock movements,
transfers, reservations) is unchanged by Batch 9.1 — no shape, parameter,
error code or grant in it moved. What is new is a second family of
operations that sits beside it, and the one place the two meet is §7 below.

**Nothing here has been applied to the live database.** The migrations that
define it are written and tested against a disposable PostgreSQL only.

Defined by:

* `supabase/migrations/20261011090000_batch9_1_seasonal_set_identity_and_assignments.sql`
* `supabase/migrations/20261011091000_batch9_1_seasonal_operations.sql`
* `supabase/migrations/20261012090000_batch9_1_corrective_seasonal_review.sql`
  — the v1.1 corrective. Replaces the nine functions and the availability
  view, and adds two columns.
* `supabase/migrations/20261013090000_batch11_1_seasonal_corrective_round_two.sql`
  — the v1.2 corrective. Applies last; it adds `move_seasonal_set`, the
  aboard view and `built_at_location`, replaces `register_seasonal_set` and
  `retire_seasonal_set`, and changes the event log's read grants.

Proved by `tests/db/batch9-1.test.mjs` (83 checks) against a real
PostgreSQL, and exercised from the UI side by `tests/phase24.test.mjs`
(37 checks). Checks M1–M9 are one per v1.1 finding, and each of the nine
fails when that corrective is removed from the suite's migration sequence;
N1–N5 cover the three v1.2 sub-points.

---

## 1. The model in one paragraph

A **set** is a physical asset Nova Shield owns — a named run of Christmas
lights with a code written on its bag. Its identity is permanent and
independent of any customer. An **assignment** is one season of one set at
one customer: temporary, and kept forever afterwards as history. A set that
has served three customers has one row in `ns_rental_sets` and three in
`ns_seasonal_assignments`. Customers get seasonal use; they never get
ownership, and nothing in this contract transfers any.

Two fields carry the whole model, and keeping them apart is the point:

* `ns_rental_sets.status` answers **where is the physical thing** —
  `in_storage`, `deployed`, `in_repair`, `retired`, `lost`. Nothing else.
* `ns_seasonal_assignments.status` answers **who has it and how far
  through** — `assigned`, `installed`, `removed`, `released`, `cancelled`.

The Batch 8.1 table mixed these into one field (`in_storage | assigned |
installed | in_repair | retired | lost`). Batch 9.1 splits them, drops
`customer_id`, `property_id`, `installed_at`, `removed_at` and `season_year`
from the set, and moves those facts onto the assignment.

A third field, `ns_rental_sets.condition`, answers **what somebody who
looked at it concluded** — `usable`, `damaged`, `missing`, or `uninspected`.
`uninspected` is a real state, not a null that reads as fine.

## 2. The lifecycle, and what closes it

```
register ──▶ inspect ──▶ assign ──▶ install ──▶ recover ──▶ inspect ──▶ release
                 ▲          │                                  │           │
                 └──────────┴── cancel (never installed)        │           │
                 └─────────────────────────────────────────── repair ◀──────┘
                                                                            │
  retire (optionally stripping salvage back to stock) ◀─────────────────────┘
```

Three rules this encodes, each enforced in the database rather than by
convention:

1. **One open assignment per set.** An assignment is OPEN while its status
   is `assigned`, `installed` or `removed`. `removed` is in that list
   deliberately: recovering a set is not the end of the season, releasing
   it is. Without this, a set that came back and passed inspection could be
   promised to a second customer while the first season's row was still
   open, leaving two assignments that both read as current. Enforced by the
   partial unique index `ns_seasonal_assignments_one_open_per_set`, so it
   holds against a second admin screen, a script, or a replay that slipped
   past its key — not only against the RPC.

   **Retirement reads the same list** (v1.1). `retire_seasonal_set` refuses
   while any assignment on the set is `assigned`, `installed` **or**
   `removed`. v1.0 checked only the first two, so a set recovered but not
   released could be retired, destroying the asset while the commercial
   promise against it was still open — and leaving `ns_rental_sets` and the
   open-assignment rule that Batch 10.1 depends on disagreeing about
   whether the season was closed. The error message already said "recover
   and release it"; the check now agrees with it.

2. **Inspection before release.** `release_seasonal_set` refuses while the
   set's condition is `uninspected`. Release does **not** require `usable`:
   a damaged set's assignment must still be closeable, or the season stays
   open forever while the set sits on the bench. Availability is computed
   from the set's own condition, so releasing a damaged set does not offer
   it to anybody.

3. **Recovery is not a verdict.** `recover_seasonal_set` records what the
   crew saw at the kerb in `ns_seasonal_assignments.recovery_condition`,
   and sets the set's own `condition` back to `uninspected` and
   `inspected_at` to null — **every time**, including for a set inspected
   last season. Last year's inspection says nothing about this year's
   return. The one exception is `missing`: nothing came back, which is a
   fact the crew established by looking at an empty roof, so the set's
   condition becomes `missing` with `inspected_at` set, and the assignment
   is releasable without a ceremonial second call.

## 3. Request shapes

Every entry point takes `p_client_operation_id` first, returns `jsonb` in
the shape of §5, and is `SECURITY DEFINER` with its own authorisation guard.
Argument order matters: these are positional in PostgREST's `rpc()` only by
name, but the signatures below are what the grants name, so a change to any
of them is a new signature and a new version of this document.

```
register_seasonal_set(
  p_client_operation_id text,
  p_set_code            text,
  p_run_type            text    default null,
  p_colour              text    default null,
  p_linear_ft           numeric default null,
  p_location_code       text    default null,   -- null = base
  p_material_id         uuid    default null,
  p_build_quantity      numeric default null,   -- null = bought assembled
  p_note                text    default null)

assign_seasonal_set(
  p_client_operation_id text,
  p_set_id              uuid,
  p_customer_id         uuid,
  p_season_year         integer,                -- REQUIRED, never defaulted
  p_property_id         uuid default null,
  p_job_id              uuid default null,
  p_note                text default null)

cancel_seasonal_assignment(p_client_operation_id text, p_assignment_id uuid,
                           p_note text default null)

install_seasonal_set(
  p_client_operation_id text,
  p_assignment_id       uuid,
  p_installed_at        timestamptz default null,   -- null = now()
  p_job_id              uuid        default null,
  p_note                text        default null)

recover_seasonal_set(
  p_client_operation_id text,
  p_assignment_id       uuid,
  p_recovery_condition  text,                   -- usable|damaged|missing|uninspected
  p_location_code       text        default null,   -- null = crew's vehicle, else base
  p_removed_at          timestamptz default null,
  p_note                text        default null)

inspect_seasonal_set(
  p_client_operation_id text,
  p_set_id              uuid,
  p_condition           text,                   -- usable|damaged|missing ONLY
  p_note                text default null)

release_seasonal_set(p_client_operation_id text, p_assignment_id uuid,
                     p_note text default null)

record_set_renewal(
  p_client_operation_id text,
  p_assignment_id       uuid,
  p_renewal_state       text,                   -- renewed|not_renewed
  p_note                text default null)

retire_seasonal_set(
  p_client_operation_id text,
  p_set_id              uuid,
  p_strip_material_id   uuid    default null,   -- null = the set's own material
  p_strip_quantity      numeric default null,   -- null = retire without stripping
  p_location_code       text    default null,   -- null = base
  p_note                text    default null)
```

`p_season_year` has **no default on purpose**. A season inferred from
today's date is wrong for half of December, so the caller states it.

`inspect_seasonal_set` rejects `'uninspected'` with `22023`: that is the
state before anybody looked, and an "inspection" into it would be a lie
with a timestamp on it.

## 4. Idempotency — where the replay key lives

Same discipline as the stock contract: the caller supplies
`client_operation_id`, a replay returns the original outcome with
`"replayed": true`, and nothing is written twice.

The **location** of the key is different and worth knowing. Reserve and
consume could key off the row they create; install, recover and release
**update** an assignment that already exists, so there is no new row to
carry it. The key therefore lives on `ns_rental_set_events.client_operation_id`
(unique where not null), and every one of these nine calls appends exactly
one keyed event. That is not a workaround — the lifecycle log is the same
table that answers "how did this set get here", so the audit trail and the
replay ledger are one object and cannot disagree. The log is append-only:
`UPDATE` and `DELETE` are revoked from `authenticated`, which the migration
asserts before it finishes.

### What a replay checks before it returns anything (v1.1)

A key is not a password, and a replay is not a read. v1.0 matched the key,
matched the event *kind*, and returned — which meant two things a caller
could exploit by accident. A crew holding any key for an `install` got back
the set that key was first used on, even a set at the other vehicle, and
before `can_handle_set` ran. And the same kind of key presented against a
different assignment returned the first one's outcome instead of refusing.

All nine calls now go through one guard, `ns_seasonal_replay_guard`, which
returns a replay only when **all four** hold:

1. the key exists on `ns_rental_set_events`;
2. its event is one the call being made would have written (a
   comma-separated list, because `record_set_renewal` writes two kinds);
3. the **target matches** — the set id, or the assignment id, that the
   caller named. A mismatch raises `23505`, naming both: a key belongs to
   the thing it was first used on, and silently answering about something
   else is worse than refusing;
4. `can_handle_set` passes for the set the event is on. A key is not a way
   round scoping; a crew asking about another vehicle's set gets `42501`,
   not a row.

Only then is the **current** state of that set and assignment returned with
`"replayed": true`. Reusing a key for a different operation still raises
`23505` and writes nothing — the same refusal `post_stock_movement` makes,
for the same reason: a retry that differs from what landed is a caller bug.

### The suffixed ledger key is verified, not trusted (v1.1)

Two calls post a stock movement as well, and they derive a **suffixed**
operation id for it so a replay cannot post it twice:

| call | ledger key | reason |
|---|---|---|
| `register_seasonal_set` with `p_build_quantity` | `<key>:build` | `consumed` |
| `retire_seasonal_set` with `p_strip_quantity` | `<key>:strip` | `returned` |

Replaying either returns the original and the ledger is untouched; this is
checked by `batch9-1.test.mjs` I2 and I3.

The suffix is a convention, not a reserved namespace, and
`post_stock_movement` replays **any** operation under a matching
`client_operation_id` without comparing the payload — deliberate behaviour
in the stock contract §5, which is not changed here. So a movement already
posted under `<key>:build` would be handed straight back and the set would
record a debit that never happened for it. v1.1 verifies the dependency at
the boundary instead: `ns_verify_stock_operation` requires the returned
operation to contain **exactly one** movement, of the material, location,
signed quantity and reason that were asked for. Anything else raises
`23505` and the set is not created. The frozen function's accepted input is
untouched, so a caller whose own keys contain a colon is unaffected.

### A no-op is not a replay (v1.1)

**Five calls are idempotent on state**, because a retry under a *new* key
must not fail on work that already landed: `install_seasonal_set` on an
already-installed assignment, `recover_seasonal_set` on one already
`removed`/`released`, `release_seasonal_set` on one already `released`,
`cancel_seasonal_assignment` on one already `cancelled`, and
`retire_seasonal_set` on an already-retired set all return rather than
raising. `inspect_seasonal_set` does **not**: re-inspecting a repaired set
is a real second inspection, and the log keeps both.

v1.0 reported those five as `"replayed": true`, which collapsed two
different facts: *your key was already used* and *the work was already
done*. They are now distinguishable, and v1.0's claim that "every one of
these nine calls appends exactly one keyed event" was false for the second
— a no-op appends nothing, so the key the caller sent is **not** recorded
and sending it again is not a replay.

| `replayed` | `no_op` | means | was the key recorded? |
|---|---|---|---|
| `false` | `false` | the original. Work was done, one keyed event appended | yes |
| `true` | `false` | this exact key was used before; the guard above passed | yes, by the first call |
| `true` | `true` | nothing needed doing — the state was already there | **no** |

A caller that wants "did my key land" must read `no_op`. A caller that only
wants "is the world as I asked" can ignore both.

## 5. Response shape

```json
{
  "replayed": false,
  "no_op": false,
  "set": {
    "set_id": "…", "set_code": "CHR-014",
    "status": "in_storage", "condition": "usable",
    "run_type": "roofline", "colour": "warm white", "linear_ft": 40,
    "material_id": null, "location_id": "…", "location_code": "base",
    "inspected_at": "2026-01-20T10:00:00Z", "retired_at": null,
    "built_from_operation": null, "built_quantity": null,
    "stripped_to_operation": null, "stripped_quantity": null
  },
  "assignment": {
    "assignment_id": "…", "set_id": "…", "customer_id": "…",
    "property_id": null, "job_id": null, "season_year": 2026,
    "status": "released",
    "assigned_at": "…", "installed_at": "…", "removed_at": "…",
    "released_at": "…",
    "recovery_condition": "usable", "renewal_state": "not_renewed",
    "release_cutoff": null,
    "client_operation_id": "…"
  },
  "availability": {
    "available_for_reuse": true,
    "has_active_assignment": false,
    "awaiting_release": false,
    "needs_inspection": false,
    "needs_repair_or_search": false,
    "out_of_service": false,
    "at_the_repair_bench": false,
    "blocking_reasons": []
  }
}
```

`assignment` is `null` for the calls that act on a set rather than a season
(`register_seasonal_set`, `inspect_seasonal_set`, `retire_seasonal_set`).
`availability` is always present, so a caller never has to re-read to find
out whether what it just did freed the set.

A replay returns the **current** state of the same rows with
`"replayed": true`, which is the behaviour `ns_reservation_result` already
has in the stock contract. It is not a frozen snapshot of the first
response.

Four fields are new in v1.1, and each exists because a reader could not
answer a question without re-deriving it from the ledger:

* **`no_op`** — see the table at the end of §4. Always present, never null.
* **`built_quantity`** — how much material went into the set, or null for
  one bought assembled. It is non-null exactly when
  `built_from_operation` is, enforced by
  `ns_rental_sets_build_quantity_sourced`: a quantity nobody can trace to a
  movement would be a number, not a fact.
* **`stripped_quantity`** — how much came back out on retirement. Null
  until retired, or for a retirement with no strip.
  `0 < stripped_quantity <= built_quantity`, enforced by
  `ns_rental_sets_strip_within_build`.
* **`blocking_reasons`** — an ordered JSON array of the reasons the set
  cannot go to the next customer. Empty when it can. See §6.

## 6. Reading availability

`public.ns_seasonal_set_availability` is the single definition of "can this
set go to the next customer", and the RPCs read it rather than re-deriving
the rule — so the screen that offered a set and the function that refuses it
cannot disagree. `security_invoker = on`, so RLS applies to the caller.

```sql
select * from ns_seasonal_set_availability where available_for_reuse;
```

`available_for_reuse` is true only when **all** of: no open assignment, the
set is `in_storage`, its condition is `usable`, and `inspected_at` is set.
The open-assignment leg reads `status in ('assigned','installed','removed')`
— the same list as §2 rule 1, so a recovered set is not offered to anybody
until its season is released.

### The reason flags (corrected in v1.1)

v1.0 said "exactly one of the five reason flags explains why". That was
wrong twice over, and both errors reached the screen.

**They were not non-null.** The flags derived from the assignment were
written `a.status = 'removed'`, which is NULL — not false — whenever the
left join misses, which is every set with no open assignment. A caller
doing `if (!row.awaiting_release)` was fine; one doing
`row.awaiting_release === false` was not, and JSON carried the null
through. Every flag is now wrapped in `coalesce(..., false)`, so each is
strictly `true` or `false` for every row.

**They were not exclusive.** A damaged set, recovered but not released,
sitting at the repair bench, makes `awaiting_release`,
`needs_repair_or_search` and `at_the_repair_bench` all true at once. A
screen built on the v1.0 sentence would pick whichever it tested first and
print one third of the truth.

So the reasons are also returned as an ordered array, **most decisive
first**, and a caller that wants one sentence takes the head of the list
rather than guessing which flag wins:

```
out_of_service          retired or lost — not a set to plan with at all
with_a_customer         assigned or installed
awaiting_release        recovered, season not closed
at_the_repair_bench     status is in_repair
needs_repair_or_search  condition is damaged or missing
needs_inspection        condition is uninspected
```

`blocking_reasons` is a `text[]` on the view and a JSON array in the RPC
response. It is **empty if and only if `available_for_reuse` is true**, so
it is the whole explanation and not a hint. `batch9-1.test.mjs` M9 asserts
that correspondence across **every row** of the view, not over a sample, so
a later change to either side fails the suite rather than quietly shipping
an unavailable set the screen cannot explain.

Six reasons cover every way the four availability legs can fail, and
`deployed` needs none of its own — which is only true because of a
constraint elsewhere, so it is worth writing down. The deferred trigger
`ns_guard_set_matches_assignment` makes `deployed` and an `installed`
assignment imply each other in both directions, so `with_a_customer` always
accounts for a deployed set. M9 asserts that too, by trying the direct
write: relax the trigger and a seventh reason is needed, and the suite says
so. The admin screen prints each reason as a sentence; an operator who
cannot see why will ring the office.

Four other reads:

| object | what it answers |
|---|---|
| `ns_rental_sets` | the asset register. Location-scoped read, owner-only write. |
| `ns_seasonal_assignments` | the history. Read-only to `authenticated`. |
| `ns_rental_set_events` | how a set got here. Append-only. |
| `ns_seasonal_release_cutoff(season_year)` | the owner's recovery cutoff, or null |

## 7. The accounting model — where this meets the stock contract

**The rule: a quantity of lights is either generic material in
`ns_material_stock_moves` or part of a set in `ns_rental_sets`. Never both,
never neither.**

Exactly two operations cross that line, and both record which ledger
operation did it **and how much**:

* **Building** a set consumes material — a negative `consumed` movement,
  remembered in `ns_rental_sets.built_from_operation` with the amount in
  `built_quantity`.
* **Stripping** a retired set returns it — a positive `returned` movement,
  remembered in `ns_rental_sets.stripped_to_operation` with the amount in
  `stripped_quantity`.

Assigning, installing, recovering, inspecting and releasing a set move
**no stock at all**, because nothing crosses the line: the asset is still
ours, it is just somewhere else. This is why a set out at a customer's
house does not reduce the ledger — it was never in it.

### The invariant, and what v1.0 got wrong about it

v1.0 wrote it as:

```
on_hand(material)  +  sum of build quantities of sets
                      that have not been stripped
  = constant
```

That is not an invariant. "Has not been stripped" is a boolean, and a strip
is a quantity, so a partial strip breaks it: build 200 and strip 150 and
the left side falls by 50 with nothing accounting for it. Two allowed
inputs broke it outright — a strip of 250 against a 200 build *created* 50
units of material, and a set bought assembled (no build at all) could be
stripped into a receipt reversing a debit that never existed.

v1.1 fixes both halves. The expression is stated over quantities, and the
part that does not come back is **named** rather than lost:

```
on_hand(material)
  + Σ built_quantity        over sets not yet retired
  + Σ (built_quantity − coalesce(stripped_quantity, 0))
                            over retired sets
  = constant across every seasonal operation
```

The second sum is **scrap**: the part of a retired set not worth saving. It
is not stock and never becomes stock, which is why it stays on the right of
the ledger rather than disappearing from it. A retired set stripped of
nothing contributes its whole build; one stripped in full contributes zero.

And a strip must reverse a build it can prove happened. `retire_seasonal_set`
refuses three ways before it posts anything:

| input | outcome |
|---|---|
| strip on a set with no `built_from_operation` | `23514`. Salvage from a bought-assembled set is an ordinary receipt the owner posts deliberately, not a strip |
| `p_strip_material_id` ≠ the set's own material | `22023`. Salvage returns what was taken out, or it is not a strip |
| `p_strip_quantity` > `built_quantity` | `23514`, naming both numbers |

`ns_rental_sets_strip_within_build` enforces the third at the table as
well, so a direct write cannot do what the RPC refuses, and
`ns_rental_sets_build_quantity_sourced` makes a quantity without a movement
impossible in either direction.

`batch9-1.test.mjs` I1 asserts the expression at five points: after a
1000-unit receipt, after building a 200-unit set (800 + 200), after a whole
season of assign → install → recover → inspect → release (still 800 + 200,
and the movement count is unchanged), and after retiring with a 200-unit
strip (1000 + 0). I2 and I3 prove a replayed build or strip does not post
twice. M2, M3 and M4 cover the three refusals and the partial case: a
200-unit set stripped of 150 leaves `950 + 50`, and the 50 is scrap the
expression names.

## 8. Authorisation

Three tiers, and the split is the same one the stock contract uses:
`is_admin()` gates everything, `is_owner()` is an admin with no active
`ns_crew_members` row with `role = 'crew'`, and a crew is scoped to Base
plus its own vehicle.

| call | who |
|---|---|
| `install_seasonal_set` | any admin, scoped to sets it can handle |
| `recover_seasonal_set` | any admin, scoped — and the destination location must be one it can see |
| `inspect_seasonal_set` | any admin, scoped |
| `register_seasonal_set` | **owner only** |
| `assign_seasonal_set` | **owner only** |
| `cancel_seasonal_assignment` | **owner only** |
| `release_seasonal_set` | **owner only** |
| `record_set_renewal` | **owner only** |
| `retire_seasonal_set` | **owner only** |

The division is field work versus commercial decision. A crew puts sets up,
takes them down and says what came back. Promising a set to a customer,
closing a season, recording a renewal and retiring an asset are the owner's.

`can_handle_set(set_id)` is the scoping test, and it is deliberately the
**same** predicate as the `rental_sets_scoped_read` policy: an owner handles
anything; a crew handles a set whose `location_id` is null (out at a
property, or not recorded) or one it can see. If those two drifted, a crew
could be shown a set it cannot touch — or worse, touch one it cannot be
shown.

**The lockdown that makes this real.** `authenticated` has `SELECT` on
`ns_seasonal_assignments` and nothing else; no write policy and no write
grant exist. `ns_rental_set_events` has `UPDATE` and `DELETE` revoked. A
direct `INSERT` would walk past the open-assignment rule, the crew scoping
and the replay key, so it is not possible — and the migration asserts all
three before it finishes, failing loudly rather than leaving a contract that
is advisory. `anon` holds no `EXECUTE` on any of the nine functions, checked
through all three privilege routes (direct, `PUBLIC`, and inherited via
`pg_auth_members`) because reading the grant list is not the same as asking
whether the role can execute.

## 9. Errors

| code | condition | when |
|---|---|---|
| `42501` | insufficient_privilege | not an admin; a crew attempting an owner-only call; a set or location outside a crew's scope — **including on a replay** (v1.1) |
| `22023` | invalid_parameter_value | blank `client_operation_id`; null `p_season_year`; unknown recovery condition; `'uninspected'` as an inspection result; a build or strip quantity ≤ 0; a build quantity with no material; a strip naming a material the set was not built from (v1.1) |
| `P0002` | no_data_found | no such set, assignment, customer or active location |
| `23505` | unique_violation | a set already held by an open assignment; a set awaiting release; a duplicate set code; a key reused for a different operation; a key presented against a different set or assignment (v1.1); a `:build`/`:strip` operation that does not contain the movement it was depended on for (v1.1) |
| `23514` | check_violation | a transition the lifecycle forbids — installing something not `assigned`, recovering something not `installed`, releasing something still `installed` or not yet inspected, inspecting a deployed set, assigning a set that is uninspected/damaged/lost/retired/at the bench, retiring a set still promised (v1.1: including one recovered but not released), stripping a set that was never built, stripping more than it holds (v1.1) |
| `23503` | foreign_key_violation | deleting a customer that an assignment still references |

`P0002` is PL/pgSQL's `no_data_found`, **not** the SQL-standard `02000`.
Same note as the stock contract, for the same reason: a client matching on
`02000` will never match.

## 10. Fixtures

`tests/db/fixture-schema-batch9-1.sql` adds the one object these migrations
reference that the Batch 8.1 fixture does not: `app_settings`, which
`ns_seasonal_release_cutoff()` reads. Load it after
`fixture-schema-batch8-1.sql`.

The cutoff is stored as `app_settings.lighting ->> 'seasonal_release_cutoff'`
in `MM-DD` form, because the month and day are the policy and the year comes
from the season. Unset or malformed reads as **null**, and a null cutoff
means the screens say no cutoff is set rather than naming a date. Nothing in
this contract releases, recovers or reassigns a set on a schedule: there is
no trigger, no cron and no default that writes `released_at`, which
`batch9-1.test.mjs` L4 asserts by searching `pg_proc` for any other function
that could.

## 11. How 10.1 and 10.2 should reference a set

A named set is referenced by **`ns_rental_sets.id`**, never by `set_code`.
The code is unique (case-insensitively, on `btrim`) and is what a human
reads off a bag, so it belongs in UI copy and in a search box — but it is
editable by the owner, and a plan that stored the string would silently
point at nothing the first time somebody fixed a typo.

For the daily load and plan work in 10.1/10.2:

* **A set is not stock.** It has no quantity, cannot be reserved through
  `reserve_stock` (which takes a `material_id`), and must not be turned into
  a `ns_materials` row with a count of 1. If a day's plan needs to carry
  sets, it carries set ids.
* **"Which sets are out at this customer right now"** is
  `ns_seasonal_assignments` filtered to `status in ('assigned','installed')`
  for that `customer_id` — not a field on the set.
* **"Which sets could this job use"** is
  `ns_seasonal_set_availability where available_for_reuse`.
* **A set's location while deployed is null**, not the vehicle it rode in. A
  set listed as being in Car A is a set somebody will look for there.

**Corrected in v1.1.** v1.0 ended that last point by saying "what is on the
van today" is the stock ledger plus the assignments whose status is
`assigned` — "the sets loaded but not yet up". That was wrong, and worth
being explicit about because 10.2 would have built against it.
`assigned` means **promised to a customer for a season**. It is a
commercial fact, decided by the owner, possibly weeks before anyone drives
anywhere. It says nothing about which vehicle a set is in, or whether it
has been picked up at all; a set assigned in October and installed in
December is `assigned` for two months while it sits on a shelf.

What is physically on a van is now answered by a contract of its own:
**`docs/daily-load-contract-v1.md`** — `ns_load_plans` and
`ns_load_plan_lines` for the day's intent, `ns_day_reconciliations` for what
actually came back. That document is the authority; this one does not
describe van contents and should not be read as doing so.

The two meet, and only here: a day's plan can carry **set ids** (never
quantities, never `set_code`), and whether a set is free to be carried at
all is `ns_seasonal_set_availability`. An `assigned` assignment tells a
planner *that this set is owed to this customer this season*, which is why
it must not be handed to another one — not where it is tonight.

## 12. Deliberately out of scope in this version

Named so neither side builds against an assumption:

* **Seasonal writes are NOT in the field outbox.** The field track has four
  write types today; none of these nine calls is a fifth. The replay key
  exists so queueing them *can* be safe later, but adding a type needs its
  own agreed scope, and Batch 9.1 does not do it.
* **No automatic release, recovery or reassignment.** The cutoff in §10 is a
  date to show a human, who then acts. Nothing fires on it.
* **Pricing.** Not here and not anywhere in the browser. No seasonal call
  reads or writes a rate, a total or a quote line, and nothing in this
  contract is read by the quote path.
* **Partial recovery within one set.** Recovery is per set, by design: three
  sets at one property are three assignments, and recovering two leaves the
  third `installed` and unavailable. There is no sub-set granularity, so
  "half of CHR-014 came back" cannot be recorded — it is a damaged return of
  the whole set.
* **Multi-vehicle crews.** One crew today, with the schema able to carry a
  second (`ns_stock_locations` takes another `vehicle` row). Car B is not
  seeded and no fleet behaviour is implied.
* ~~**The permanent-lighting half of the 9.1 roadmap section**~~ —
  **delivered** since v1.0, in the 9.1 corrective
  (`2b628b3`) and specified by
  `docs/permanent-lighting-materials-contract-v1.md`: reviewed material
  sheets, sealed-kit opening, offcut tracking and reuse, heating-kit
  selection. Supplier specifications remain explicitly unknown there — the
  `spec_state` column — and an unknown specification prevents a
  recommendation rather than producing a guessed one. v1.0 flagged this as
  out of scope because the delivered brief for that batch covered only the
  Christmas side; it is named here so a reader of v1.0 does not conclude it
  is still missing.
