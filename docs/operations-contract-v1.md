# Nova Shield operations contract v1 — stock movements

**Status: frozen.** This is the snapshot handed to both tracks. Neither side
invents a counterpart; a change to this document is a new version, agreed
before either side implements against it.

**Nothing here has been applied to the live database.** The migrations that
define it are written and tested against a disposable PostgreSQL only.

Defined by:

* `supabase/migrations/20261010120000_batch8_1_inventory_and_rental_sets.sql`
* `supabase/migrations/20261010130000_batch8_1_stock_operations_contract_v1.sql`

Proved by `tests/db/batch8-1.test.mjs` (sections L, M, N) against a real
PostgreSQL, and exercised from the UI side by `tests/phase23.test.mjs`
(sections C, D, J).

---

## 1. The model in one paragraph

Stock lives **at a location**. Every change is an **operation**, and an
operation produces one or more **movements** in an append-only ledger. A
balance is the sum of the movements at that location; nothing stores a
count. A mistake is corrected by posting its reverse, never by editing or
deleting a movement.

```
ns_stock_locations        base | car_a | (car_b, when it exists)
ns_stock_operations       the replay-safe unit of work
ns_material_stock_moves   append-only ledger, one row per leg
ns_material_stock_by_location   derived balances  (material × location)
ns_material_stock               derived totals    (material)
```

---

## 2. Locations

| code | name | kind | seeded |
|---|---|---|---|
| `base` | Base | `base` | yes |
| `car_a` | Car A | `vehicle` | yes |
| `car_b` | Car B | `vehicle` | **no** |

Car B is **capability, not data**. The owner runs one crew today and expects
a second later, so a second vehicle is a row somebody inserts — not a
migration somebody writes. Nothing in the schema hardcodes how many vehicles
exist, and no client may assume two.

**Exactly one base** is enforced by a partial unique index. A second base
would split the shared pool in two and make every "is it in stock" answer
ambiguous.

Codes are matched case- and whitespace-insensitively. **Always address a
location by `code`, never by `id`** — ids differ between the disposable test
database and the live project; codes do not.

### Availability rule

Stock in a vehicle is available to **that vehicle's** work, and returns to
Base to become generally available again. This is the owner's decision, not
an inference. It is why a vehicle stock basis means *that car plus Base*,
and a Base basis means Base alone.

---

## 3. `post_stock_movement` — one material, one location

```
post_stock_movement(
  p_client_operation_id text,     -- required, unique, caller-generated
  p_material_id         uuid,
  p_location_code       text,     -- 'base' | 'car_a' | ...
  p_quantity            numeric,  -- MAGNITUDE (see below)
  p_reason              text,
  p_note                text default null,
  p_job_id              uuid default null,
  p_purchase_order_id   uuid default null,
  p_vehicle_code        text default null,
  p_condition           text default 'usable',    -- 'usable' | 'damaged'
  p_count_precision     text default 'exact'      -- 'exact'  | 'estimated'
) returns jsonb
```

### Reasons, and who decides the sign

`p_quantity` is a **magnitude**. The server derives the direction from the
reason, so a caller cannot post a positive consumption and quietly add
stock.

| reason | operation kind | sign | note |
|---|---|---|---|
| `received` | `receipt` | `+` | normally from a purchase order |
| `returned` | `receipt` | `+` | came back to the shelf |
| `opening` | `opening` | `+` | an explicit opening count |
| `consumed` | `consumption` | `−` | used on a job |
| `damaged` | `consumption` | `−` | written off |
| `adjustment` | `correction` | **caller's** | the one case that keeps its own sign, because a negative correction has to be enterable at all |

Anything else raises `22023`.

A single-location movement is recorded with `confirmed_physical = true`: the
operator is reporting what is already on the shelf in front of them, and
there is no second party to confirm. Transfers are different — see below.

---

## 4. `post_stock_transfer` — between two locations

```
post_stock_transfer(
  p_client_operation_id text,     -- required, unique, caller-generated
  p_material_id         uuid,
  p_quantity            numeric,  -- > 0
  p_from_location_code  text,
  p_to_location_code    text,
  p_confirmed_physical  boolean default false,
  p_note                text default null,
  p_job_id              uuid default null
) returns jsonb
```

Three rules the server enforces, each of which a caller should also check so
the operator finds out at the start rather than the end:

1. **Confirmation.** `p_confirmed_physical` must be true. A half-moved
   balance is the thing a crew cannot reconcile against a car, so this is
   refused rather than recorded as pending.
2. **Sufficient source.** You cannot carry out of a car what is not in it.
   A negative balance is meaningful for consumption — somebody used stock
   the app did not know about — but never for a transfer, so it is a
   miscount to surface now, not a fact to record.
3. **Two different locations.**

Conservation is a **deferred constraint trigger**, not a convention: at
COMMIT, every transfer operation must have exactly two legs, across two
distinct locations, summing to zero per material. A hand-built one-legged or
unbalanced transfer is refused even if it never goes through this function.

The operation is attributed to whichever side is a vehicle; for
vehicle-to-vehicle, to the receiving car.

---

## 5. Idempotency — the part that matters offline

`client_operation_id` is **generated by the caller, before the request, and
reused on retry**. That is the whole point: the server never saw a failed
first attempt, so only the caller can say "this is that same act".

* A repeat returns the **original** operation, writes nothing, and sets
  `replayed: true`.
* Reusing a key for a **different kind** of operation raises `23505` rather
  than returning the original, because silently returning a receipt in
  answer to a transfer would report a movement that never happened.
* A blank or missing key raises `22023`. Without a key there is no replay
  safety at all.

Two deliberate taps are two operations and need two keys. One tap retried
three times is one operation and must reuse one key.

`admin/js/lib/api.js` exports `newOperationId(prefix)` for this; it uses
`crypto.randomUUID()` where available.

---

## 6. Response shape

Both functions return the same object. It carries the balances it touched,
so a caller never has to re-read to find out what it just did.

```json
{
  "operation_id": "…uuid…",
  "client_operation_id": "xf-9e1c…",
  "kind": "transfer",
  "record_version": 1,
  "confirmed_physical": true,
  "actor_id": "…uuid… | null",
  "vehicle_location_id": "…uuid… | null",
  "occurred_at": "2026-10-10T18:22:04.117Z",
  "replayed": false,
  "movements": [
    { "movement_id": "…", "material_id": "…", "location_id": "…",
      "location_code": "car_a", "delta": 40,  "reason": "transfer" },
    { "movement_id": "…", "material_id": "…", "location_id": "…",
      "location_code": "base",  "delta": -40, "reason": "transfer" }
  ],
  "balances": [
    { "material_id": "…", "location_id": "…", "location_code": "base",  "on_hand": 160 },
    { "material_id": "…", "location_id": "…", "location_code": "car_a", "on_hand": 90  }
  ]
}
```

`record_version` starts at 1 and is for optimistic concurrency on the
operation record itself. Movements are never amended, only reversed.

---

## 7. Errors

Branch on `code`, not on message text. Messages are written for a person and
will change.

| code | condition | what the caller should do |
|---|---|---|
| `42501` | not an admin, or direct ledger write attempted | do not retry; this is a permission problem |
| `22023` | blank replay key, zero quantity, same from/to, unknown reason | fix the input; do not retry as-is |
| `P0002` | unknown location code, unknown job | fix the input |
| `23505` | replay key reused for a different operation kind | generate a new key for the new act |
| `23514` | unconfirmed transfer, insufficient source, conservation failure | surface to the operator; a count is probably needed |

A retry after a network failure is **safe and expected** — reuse the same
`client_operation_id`.

---

## 8. Authorisation, and the lockdown that makes this real

Both functions are `SECURITY DEFINER` with an explicit `is_admin()` guard.
`INSERT`, `UPDATE` and `DELETE` on `ns_material_stock_moves` and
`ns_stock_operations` are **revoked from `authenticated`**; `SELECT` stays,
because the ledger is the audit trail.

That revoke is the line that makes every guarantee above real rather than
advisory. With direct `INSERT` available, any caller could write a movement
with no operation, no replay key and no confirmation. The migration verifies
the revoke took effect and raises if it did not.

`anon` holds nothing, through any of the three routes a privilege can
arrive by (direct, `PUBLIC`, inherited) — the Batch 7.1 finding, re-checked
against these objects rather than assumed.

Per-crew permissions (owner vs assigned crew) are **not in v1**. Today
everything is admin-only. `actor_id` and `vehicle_location_id` are recorded
now so that adding crew scoping later is a policy change, not a reshape.

---

## 9. Reading stock

```
ns_material_stock_by_location   material × location, on_hand, last_move_at
ns_material_stock               material totals, needs_reorder
```

Both are `security_invoker`, so they are read under the caller's own
policies rather than the view owner's.

`estimate_job_materials(p_job_id uuid, p_location_code text default null)`
returns quantities for a job against a stated basis:

* `null` → every location. What the business owns, **not** what one crew can
  reach. The default.
* `'base'` → the shared pool only.
* `'car_a'` → that vehicle **plus Base**, which is what a crew can actually
  reach on the day.

The answer repeats the basis it used, at the top level and on every line.
An unknown code raises `P0002` rather than falling back to the total: a
shortfall computed against the wrong basis is worse than no shortfall.

---

## 10. Fixtures

Both tracks test against the same shape. The browser fixtures are in
`tests/phase23.test.mjs`; the database fixtures are in
`tests/db/fixture-schema-batch8-1.sql`.

```js
const LOCATIONS = [
  { id: 'loc-base',  code: 'base',  name: 'Base',  kind: 'base',    active: true, sort_order: 0 },
  { id: 'loc-car-a', code: 'car_a', name: 'Car A', kind: 'vehicle', active: true, sort_order: 1 }
];

// Deliberately split across two locations, so a test that only ever looked
// at a total would pass while the per-location figure was wrong.
const BALANCES = [
  { material_id: 'mat-track', location_code: 'base',  location_name: 'Base',  on_hand: 200 },
  { material_id: 'mat-track', location_code: 'car_a', location_name: 'Car A', on_hand: 50  },
  { material_id: 'mat-wire',  location_code: 'base',  location_name: 'Base',  on_hand: 10  },
  { material_id: 'mat-wire',  location_code: 'car_a', location_name: 'Car A', on_hand: 0   }
];
```

Part names in every fixture begin with `FIXTURE` on purpose. The supplier
catalogue has never been read by this application — both supplier sites are
unreachable from either agent's container (HTTP 403 at the proxy) — so no
fixture should ever be mistaken for a real part number, pack size or price.

---

## 10b. Added after v1 was first frozen

These were listed as "not in v1" and are now implemented. The frozen request
and response shapes above are unchanged except where noted; nothing already
written against v1 breaks.

* **Reservations.** `reserve_stock`, `release_stock_reservation`,
  `consume_stock_reservation`, all idempotent on `client_operation_id`.
  A reservation reduces **available** and leaves **on_hand** alone.
  `ns_material_stock_by_location` now carries `reserved` and `available`
  alongside `on_hand`; `available` floors at zero. Consuming closes the
  claim and posts the movement in one transaction, so stock is never
  counted as both reserved and issued, and a partial consumption releases
  the remainder.
* **Units**: `litre`, `kilogram`, `stick`, `level` joined the list.
  A `level` material has `tracking_mode = 'level'`, no quantity, and its
  Empty/Low/Enough state lives in `ns_material_levels` — outside the ledger,
  because it replaces the previous observation rather than summing.
  It cannot be reserved.
* **Condition and precision.** Movements carry `condition`
  (`usable`/`damaged`) and `count_precision` (`exact`/`estimated`).
  `post_stock_movement` **gained two trailing parameters** for them, both
  defaulted — the old nine-argument form is dropped rather than left as an
  overload, so no caller can silently keep a version that cannot record
  condition. The location view exposes `damaged_on_hand` and `is_estimated`.
  Damaged stock is never counted as available.
* **Owner and crew.** `ns_crew_members`, plus `is_owner()`,
  `current_crew_vehicle()` and `can_see_location()`. An admin with no crew
  row is an owner, so nothing narrows until a crew row exists. A crew sees
  Base and its own vehicle only; the ledger, the operations log and the
  reservations are all scoped that way, and a crew cannot edit its own
  roster row.

## 11. Still not in v1

Named so neither side builds against an assumption:
* **Offline queueing of stock operations.** The contract is designed to make
  it safe — that is what the replay key is for — but the field outbox has
  four write types today and adding a fifth needs its own agreed scope.
* **Loading plans, reservations against a day's work, end-of-day
  reconciliation.** Batch 10.
