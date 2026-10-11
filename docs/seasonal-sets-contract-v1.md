# Nova Shield seasonal sets contract v1 — company-owned Christmas lighting

**Status: frozen.** This is the snapshot handed to both tracks. Neither side
invents a counterpart; a change to this document is a new version, agreed
before either side implements against it.

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

Proved by `tests/db/batch9-1.test.mjs` (67 checks) against a real
PostgreSQL, and exercised from the UI side by `tests/phase24.test.mjs`
(37 checks).

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

Reusing a key for a **different** operation raises `23505` and writes
nothing — the same refusal `post_stock_movement` makes, for the same reason:
a retry that differs from what landed is a caller bug, and quietly applying
the second version would be worse than refusing it.

Two calls post a stock movement as well, and they derive a **suffixed**
operation id for it so a replay cannot post it twice:

| call | ledger key | reason |
|---|---|---|
| `register_seasonal_set` with `p_build_quantity` | `<key>:build` | `consumed` |
| `retire_seasonal_set` with `p_strip_quantity` | `<key>:strip` | `returned` |

Replaying either returns the original and the ledger is untouched; this is
checked by `batch9-1.test.mjs` I2 and I3.

**Three calls are also idempotent on state**, because a retry under a *new*
key must not fail on work that already landed: `install_seasonal_set` on an
already-installed assignment, `recover_seasonal_set` on one already
`removed`/`released`, `release_seasonal_set` on one already `released`,
`cancel_seasonal_assignment` on one already `cancelled`, and
`retire_seasonal_set` on an already-retired set all return
`"replayed": true` rather than raising. `inspect_seasonal_set` does **not**:
re-inspecting a repaired set is a real second inspection, and the log keeps
both.

## 5. Response shape

```json
{
  "replayed": false,
  "set": {
    "set_id": "…", "set_code": "CHR-014",
    "status": "in_storage", "condition": "usable",
    "run_type": "roofline", "colour": "warm white", "linear_ft": 40,
    "material_id": null, "location_id": "…", "location_code": "base",
    "inspected_at": "2026-01-20T10:00:00Z", "retired_at": null,
    "built_from_operation": null, "stripped_to_operation": null
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
    "at_the_repair_bench": false
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
When it is false, exactly one of the five reason flags explains why, and the
admin screen prints each as a sentence — an operator who cannot see why will
ring the office.

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
operation did it:

* **Building** a set consumes material — a negative `consumed` movement,
  remembered in `ns_rental_sets.built_from_operation`.
* **Stripping** a retired set returns it — a positive `returned` movement,
  remembered in `ns_rental_sets.stripped_to_operation`.

Assigning, installing, recovering, inspecting and releasing a set move
**no stock at all**, because nothing crosses the line: the asset is still
ours, it is just somewhere else. This is why a set out at a customer's
house does not reduce the ledger — it was never in it.

The invariant, stated so it can be checked rather than believed:

```
on_hand(material, location)  +  sum of build quantities of sets
                                that have not been stripped
  = constant across every seasonal operation
```

`batch9-1.test.mjs` I1 asserts exactly that expression at five points:
after a 1000-unit receipt, after building a 200-unit set (800 + 200), after
a whole season of assign → install → recover → inspect → release (still
800 + 200, and the movement count is unchanged), and after retiring with a
200-unit strip (1000 + 0). I2 and I3 prove a replayed build or strip does
not post twice.

A retired set that was **not** stripped still holds its quantity — it is
scrap, not stock, and counting it as available would overstate the shelf.

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
| `42501` | insufficient_privilege | not an admin; a crew attempting an owner-only call; a set or location outside a crew's scope |
| `22023` | invalid_parameter_value | blank `client_operation_id`; null `p_season_year`; unknown recovery condition; `'uninspected'` as an inspection result; a build or strip quantity ≤ 0; a build quantity with no material |
| `P0002` | no_data_found | no such set, assignment, customer or active location |
| `23505` | unique_violation | a set already held by an open assignment; a set awaiting release; a duplicate set code; a key reused for a different operation |
| `23514` | check_violation | a transition the lifecycle forbids — installing something not `assigned`, recovering something not `installed`, releasing something still `installed` or not yet inspected, inspecting a deployed set, assigning a set that is uninspected/damaged/lost/retired/at the bench, retiring a set still promised |
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
  set listed as being in Car A is a set somebody will look for there. If
  10.1 needs "what is on the van today", that is the stock ledger plus the
  assignments whose status is `assigned` — the sets loaded but not yet up.

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
* **The permanent-lighting half of the 9.1 roadmap section** — reviewed
  material sheets, sealed-kit opening, component availability, compatible
  product references, worthwhile offcuts, heating-kit selection. The
  delivered brief for this batch covered only the Christmas side. Flagged
  here rather than guessed at; see the batch report.
