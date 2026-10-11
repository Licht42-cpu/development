# Nova Shield operations contract v1 — stock movements

**Status: frozen at v1.2.** This is the snapshot handed to both tracks.
Neither side invents a counterpart; a change to this document is a new
version, agreed before either side implements against it.

**v1.1 and v1.2 are ADDITIVE.** Every v1 request shape, parameter, default,
response field, error code and grant is unchanged. v1.1 added one operation
kind and two movement reasons for opening a sealed kit (§13). v1.2 specifies
the owner/crew boundary that §11 listed as an open question, changing no code
(§14). Anything already written against v1 keeps working and needs no change.

**Nothing here has been applied to the live database.** The migrations that
define it are written and tested against a disposable PostgreSQL only.

Defined by:

* `supabase/migrations/20261010120000_batch8_1_inventory_and_rental_sets.sql`
* `supabase/migrations/20261010130000_batch8_1_stock_operations_contract_v1.sql`
* `supabase/migrations/20261010140000_batch8_1_reservations_units_and_crew_access.sql`
* `supabase/migrations/20261010141000_batch8_1_reservation_operations.sql`

Proved by `tests/db/batch8-1.test.mjs` (sections L, M, N) against a real
PostgreSQL, and exercised from the UI side by `tests/phase23.test.mjs`
(sections C, D, J).

**Companion document, added by Batch 9.1:**
`docs/seasonal-sets-contract-v1.md` specifies the company-owned Christmas
sets and their seasonal assignments. It is a separate family of operations,
not a revision of this one — Batch 9.1 changed no shape, parameter, error
code or grant defined here. The one place the two meet is building and
stripping a set, which post ordinary `consumed` and `returned` movements
through this contract; see §7 of that document for the accounting rule.

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
database and the live project; codes do not. Every RPC in this contract that
takes a location takes a `_code`; ids appear only in responses.

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

## 4b. Reservations — `reserve_stock`, `release_…`, `consume_…`

A reservation is a **claim against a balance, not a movement**. Nothing has
physically moved. It reduces `available` and leaves `on_hand` alone, and it
ends in exactly one of three ways: released, consumed, or expired.

```
reserve_stock(
  p_client_operation_id text,        -- required, unique, caller-generated
  p_material_id         uuid,
  p_location_code       text,        -- CODE, never a database id
  p_quantity            numeric,     -- > 0
  p_job_id              uuid        default null,
  p_note                text        default null,
  p_expires_at          timestamptz default null
) returns jsonb

release_stock_reservation(
  p_client_operation_id text,
  p_reservation_id      uuid,
  p_note                text default null
) returns jsonb

consume_stock_reservation(
  p_client_operation_id text,
  p_reservation_id      uuid,
  p_quantity            numeric default null,   -- null = all of it
  p_count_precision     text    default 'exact',
  p_note                text    default null
) returns jsonb        -- an OPERATION result (§6), not a reservation result
```

### Response: the reservation result

`reserve_stock` and `release_stock_reservation` both return this shape.
`consume_stock_reservation` returns the **operation** shape from §6 instead,
because consuming produces a real movement.

```json
{
  "reservation_id": "…uuid…",
  "client_operation_id": "res-9e1c…",
  "status": "held",
  "material_id": "…uuid…",
  "location_id": "…uuid…",
  "location_code": "car_a",
  "quantity": 40,
  "job_id": "…uuid… | null",
  "vehicle_location_id": "…uuid… | null",
  "actor_id": "…uuid… | null",
  "held_at": "2026-10-11T08:14:02.551Z",
  "expires_at": null,
  "closed_at": null,
  "replayed": false,
  "balance": { "on_hand": 200, "reserved": 60, "available": 140 }
}
```

`status` is one of `held`, `released`, `consumed`, `expired`. A closed
reservation always carries `closed_at`; an open one never does, so "is this
still committed" is answerable from the row.

### Rules the server enforces

1. **Over-commitment is refused.** Held reservations at a location may never
   exceed **usable** on-hand there. Damaged stock is excluded: committing a
   broken part is the same mistake as committing an absent one.
2. **Per location**, never against the company total. Car A holding 20 does
   not let you promise 50 because Base has another 40.
3. **A movement cannot carry away held stock.** A transfer or consumption
   that would leave a location holding less than it has promised is refused.
4. **No double count.** `consume_stock_reservation` closes the claim and
   posts the movement in **one transaction**; there is no window in which
   the stock is both reserved and issued. A partial consumption **releases
   the remainder** rather than leaving it committed.
5. **Level-tracked supplies cannot be reserved** — Empty/Low/Enough is not a
   quantity to promise.

### Reservation errors

| code | condition |
|---|---|
| `42501` | not an admin, **or** a location the caller is not scoped to |
| `22023` | blank replay key, quantity ≤ 0, consume > reserved, bad precision, level-tracked material |
| `P0002` | unknown location code, unknown material, unknown reservation |
| `23514` | over-commitment, or a movement that would strand a reservation |

**Repeating a release is success, not an error** — a retried release must
not fail because the first attempt landed. Releasing or consuming an already
**consumed** reservation *is* an error (`23514`): the stock is gone, and
reporting a release would be a lie.

### Idempotency

Same rule as §5. `reserve_stock` returns the original with `replayed: true`;
`consume_stock_reservation` keys on `ns_stock_operations`, so a replay comes
back as an operation result with `replayed: true`.

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

### Owner and crew scoping

`is_admin()` is the outer gate and still applies to everything. Inside it:

* `ns_crew_members` records a person as `owner` or as the `crew` of one
  vehicle. **An admin with no row here is an owner**, so nothing narrows
  until a crew row exists — which is the state the business is in today.
* `is_owner()`, `current_crew_vehicle()` and `can_see_location(uuid)` are the
  three helpers; all are `authenticated`-executable.
* A crew sees **Base and its own vehicle**, and nothing in the other car.
  `ns_material_stock_moves`, `ns_stock_operations` and
  `ns_stock_reservations` are all scoped that way by RLS, and the
  reservation RPCs refuse a location the caller is not scoped to with
  `42501`.
* A crew may read the roster but cannot write it — otherwise it could
  reassign itself to the other car. Only an owner writes `ns_crew_members`.

What is still admin-only, i.e. not yet split by role: posting movements and
transfers. A crew can be *prevented* from touching the other car's stock,
but owner-versus-crew limits on what either may do to their own are not in
this version. See §11.

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

## 10b. Changelog: what was added after v1 was first frozen

Everything here is **already specified above** — this section exists so a
reader who saw the first freeze can see what moved, not as the place to
learn the wire behaviour. Do not implement from this list; implement from
§3, §4, §4b, §6, §7 and §8.

The request and response shapes above are unchanged except where noted;
nothing already written against the first freeze breaks.

* **Reservations.** Specified in full in §4b below rather than summarised
  here, so nothing has to be inferred from prose.
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

* ~~**Owner-versus-crew limits on their OWN vehicle.**~~ **Resolved in v1.2;
  see §14.** A crew is kept out of the other car's stock (§8); what an owner
  may do that a crew may not, within locations they can both see, is now
  specified.
* ~~**A daily load response, or any schedule/plan revision operation.**~~
  **Delivered by Batch 10.1**, specified in `docs/daily-load-contract-v1.md`.
  A load plan recommends; confirming it posts ordinary transfers through
  this contract. Nothing in this document changed to accommodate it.
* **Offline queueing of stock operations.** The contract is designed to make
  it safe — that is what the replay key is for — but the field outbox has
  four write types today and adding a fifth needs its own agreed scope.
* **Loading plans, reservations against a day's work, end-of-day
  reconciliation.** Batch 10.
* **Christmas sets.** Not a gap any more: specified in
  `docs/seasonal-sets-contract-v1.md`. A set is not stock — it has no
  quantity and cannot be reserved through `reserve_stock` — so nothing in
  this document applies to one except the build and strip movements.

---

## 13. Amendment v1.1 — conversions (additive)

Added by the Batch 9.1 corrective, in
`supabase/migrations/20261011100000_batch9_1_permanent_lighting_materials.sql`
and `…101000_batch9_1_kit_and_sheet_operations.sql`. Proved by
`tests/db/batch9-1-lighting.test.mjs`.

### What changed

One operation kind and two movement reasons:

| added | where | meaning |
|---|---|---|
| `conversion` | `ns_stock_operations.kind` | one thing became several |
| `converted_out` | `ns_material_stock_moves.reason` | the thing that left (always negative) |
| `converted_in` | `ns_material_stock_moves.reason` | each thing that arrived (always positive) |

**Nothing else moved.** `post_stock_movement`, `post_stock_transfer`,
`reserve_stock`, `release_stock_reservation` and
`consume_stock_reservation` keep their v1 signatures, defaults, response
shapes and error codes exactly.

### Why a new kind rather than reusing one

Opening a kit is not a consumption (nothing was used on a job), not a
receipt (nothing arrived), and not a correction (nothing was miscounted).
Posting it as any of those makes every report that groups by kind wrong and
hides the one event that explains why the kit count fell and the component
count rose.

### The rule it carries

A conversion **conserves identity, not quantity**. One kit legitimately
becomes 300 ft of channel and twenty connectors. What a deferred constraint
trigger enforces at COMMIT is the pairing:

* exactly **one** `converted_out` movement;
* **at least one** `converted_in`;
* all movements at **one** location;
* no material converted into itself.

A lone `converted_in` is stock from nowhere and is refused. A
`converted_out`/`converted_in` attached to any other operation kind is also
refused.

### How a conversion is posted

**Only through `open_sealed_kit`.** `post_stock_movement` does not accept
these reasons — its reason→kind map has no entry for them, so it raises
`22023` — and that is deliberate: a conversion is only correct as a pair,
and a function that posts one movement cannot make a pair.

```
open_sealed_kit(
  p_client_operation_id text,
  p_kit_material_id     uuid,     -- must be category 'kit'
  p_location_code       text,
  p_kit_count           numeric default 1,
  p_note                text    default null) returns jsonb
```

Returns the standard v1 `ns_operation_result` shape (§6), with
`"kind": "conversion"` and the movements listed. Owner-only. Replay-safe on
`client_operation_id` like every other operation in this contract: a replay
returns the original with `"replayed": true` and opens nothing.

Refusals: `42501` not the owner or location out of scope; `22023` blank key,
non-positive count, or a material that is not a kit; `P0002` no such
material, no component sheet, or unknown location; `23514` the sheet is not
reviewed, lists nothing included, or there are fewer kits on hand than
asked for; `23505` the key was already used for a different operation kind.

### What this does NOT add

* No conversion of anything other than a sealed kit with a reviewed sheet.
* No reverse: a kit cannot be un-opened. Components go back to stock through
  the ordinary v1 reasons, and the conversion stays in the log.
* Nothing in the field outbox. These are owner operations on a desk.

### Companion document

Kit sheets, offcuts and job material sheets are specified in
`docs/permanent-lighting-materials-contract-v1.md`. The only part of that
work that touches **this** contract is the conversion above.


---

## 14. Amendment v1.2 — the owner/crew split within a shared location

§11 listed this as unspecified: a crew is kept out of the other car's stock,
but what an owner may do that a crew may not, **within locations they can
both see**, was not written down. Specifying it was a named requirement of
Batch 10.1.

**No code in v1 or v1.1 changed.** `post_stock_movement`,
`post_stock_transfer`, `reserve_stock`, `release_stock_reservation`,
`consume_stock_reservation` and `open_sealed_kit` keep exactly the
authorisation they already had. What follows writes down the principle those
grants already embodied, and every function added since enforces it.

### The principle

> **A crew records what physically happened and confirms what was asked.
> An owner decides what the business will do, and what the records mean.**

### The split

| a crew MAY | a crew MAY NOT |
|---|---|
| post movements: received, consumed, returned, damaged, adjustment | change the catalogue — materials, suppliers, pack sizes, units |
| transfer between Base and its own vehicle | set vehicle baselines, service load rules, job overrides or vehicle assignments |
| reserve, release and consume reservations | open a sealed kit (v1.1 §13) |
| record, use and scrap offcuts | review a kit sheet or a job material sheet |
| set and clear a manual Keep | commit stock to a job material sheet |
| confirm a load plan for its own vehicle | build a load plan |
| reconcile the day's counts | authorise a load exception |
| record a seasonal install, recovery or inspection | assign, release, retire or register a seasonal set |

Unchanged from v1: a crew is refused everything outside the locations it can
see, and `is_owner()` still means "an admin with no active crew row", so a
business with no crew rows has only owners and nothing narrows.

### Where each half is enforced

| rule | enforced by |
|---|---|
| location scope | `can_see_location()` in every RPC, and the RLS read policies |
| owner-only operations | an `is_owner()` guard at the top of each one |
| no direct table writes | no write grant and no write policy; the migrations assert this |

Full detail, and the daily-load operations themselves, in
`docs/daily-load-contract-v1.md` §9.
