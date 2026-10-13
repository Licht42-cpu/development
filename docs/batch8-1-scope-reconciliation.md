# Batch 8.1 reconciled against the revised roadmap

Branch `claude/batch-8-1`. Written after reading, read-only, from
`origin/codex/roadmap-after-batch-7`:

* `docs/plans/batch-plan-after-7.md`
* `docs/plans/claude-roadmap-handoff.md`
* `docs/plans/service-operations-blueprint.md`

Nothing was merged and no branch was switched. The roadmap documents are
authoritative; where this reconciliation and the shipped code disagree, the
documents win.

---

## 1. Starting state, measured

| Fact | Value |
|---|---|
| My branch | `claude/batch-8-1` |
| Base | `b21cb41` (Batch 7.1 follow-up) |
| Batch 8.1 commit | `ea91466` |
| Codex's native-readiness work | `d33d17e`, **not an ancestor of my branch** |
| Codex's measurement work | `f4cdbe5`, `d71f467`, also not ancestors |
| Roadmap branch | `origin/codex/roadmap-after-batch-7`, fetched, not merged |

The plan cites Claude's 7.1 work at `7a2f2af`. That is accurate but
incomplete: `7a2f2af` was followed by `b21cb41`, the safety and portability
follow-up (disposable-database guard, all three privilege routes, bare `pg`
specifier). `b21cb41` is the real 7.1 tip and the base for 8.1.

All release items the plan lists as outstanding remain outstanding. Nothing
has been applied, cleaned, merged or deployed:

* `20261009160000_batch5_freeze_customer_facing_content_once_sent.sql`
* `20261010090000_batch7_1_tighten_remaining_admin_rpc_grants.sql`
* `20261010091000_batch7_1_revoke_anon_writes_on_legacy_tables.sql`
* `20261010120000_batch8_1_inventory_and_rental_sets.sql`
* `20261010121000_batch8_1_estimate_job_materials.sql`
* The 7.1 §5 data-quality questions, and the unidentified legacy inbound FK.
* The repository still has **no base schema** (7.1 finding 4b). Recorded as a
  gap, per the handoff's instruction not to build a fake production baseline.

---

## 2. File-boundary violations in `ea91466`, and the reverts

The plan's ownership table assigns four files I edited to the other track or
to integration. All four are reverted to their `b21cb41` state in the commit
that carries this document.

| File | Plan says | What `ea91466` did | Now |
|---|---|---|---|
| `admin/js/main.js` | Codex; route wiring at integration | added the `#/inventory` route + import | reverted |
| `admin/index.html` | nav belongs with route registration | added the Inventory nav link | reverted |
| `package.json` | Codex owns manifests/lockfiles | changed the `test:db` script | reverted |
| `tests/run-regression.sh` | separate owner-authorised integration change | registered phase22 + phase23 | reverted |
| `shared/dom.js` | read-only unless explicitly transferred | added `fill()` | moved out |

`fill()` now lives in `admin/js/lib/admin-dom.js`, inside my own track, and
`inventory.js` / `job-materials.js` import it from there. It is not
inventory-specific; if the field track needs the same helper, the right move
is an owner-authorised transfer into `shared/`, not a second copy.

`admin/css/admin.css` was **not** edited — the overflow fix was done with
inline styles on my own elements. The plan permits a narrowly scoped admin
operations stylesheet for exactly this; that is the proper home and is listed
below as corrective work rather than churned now.

### Consequences of the reverts, stated plainly

* The Inventory screen is **not reachable from the admin console**. It is
  tested standalone, which is what the plan prescribes. Route and nav wiring
  are integration items.
* `npm test` is back to **24 suites** and no longer covers Batch 6.1 Settings
  (`phase22`) or Batch 8.1 Inventory (`phase23`). Both pass; run them directly
  until integration registers them.
* `npm run test:db` still points at the Batch 7.1 suite alone, so it silently
  skips the 8.1 database suite. Use `bash tests/db/run-db-tests.sh`, which
  runs both against a freshly created disposable database.
  `tests/db/setup-test-db.mjs` now prints that path and says why.

### Hand to integration

1. `tests/run-regression.sh`: add `phase22` and `phase23` to the explicit
   list. Keep it explicit — never a glob over `tests/*.test.mjs`, because
   `tests/db/` and `tests/integration/` talk to real databases. Codex's
   `native-bundle` and `native-readiness` suites need registering too.
2. `package.json`: `"test:db": "bash tests/db/run-db-tests.sh"`.
3. `admin/js/main.js` + `admin/index.html`: the `#/inventory` route and nav
   entry. The view's entry point is
   `renderInventory({ mount, params, replaceQuery, navigate })`.

---

## 3. What `ea91466` actually is, against the plan's 8.1

The plan's 8.1 is *stock foundation, units and minimal crew access*. What
shipped is a **partial 8.1 plus part of 9.1**. Honest assessment below.

### Delivered and keeps

* An additive catalogue (`ns_materials`) with suppliers, pack/unit conversion
  (`pack_quantity`), supplier references, and no invented rows.
* An **append-only movement ledger** (`ns_material_stock_moves`) with an
  on-hand view derived from it, rather than a mutable counter. This matches
  the plan's "append-only stock movement rules" and its insistence that
  corrections preserve history: a mistake is corrected by posting its reverse.
* Receipts via purchase orders counted in **packs**, converted to operating
  units exactly once on receipt.
* A sign/reason agreement constraint, so a receipt cannot be posted negative
  and a consumption cannot be posted positive.
* Service → material consumption mapping with a bounded waste factor, and
  `estimate_job_materials` deriving a job's requirement from measurements
  that already exist.
* RLS, explicit revokes from PUBLIC and anon, a `security_invoker` view.
* 70 database checks on a disposable PostgreSQL, 48 mocked browser checks.

### Missing, and required for the plan's 8.1 acceptance

1. **Stock locations.** The single largest gap. `ns_material_stock_moves` has
   one global balance. The plan requires **Base, Car A and optional Car B**
   with distinct balances over one shared base pool. Every acceptance
   criterion about transfers depends on this.
2. **Transfers.** No location-to-location movement, therefore nothing to
   satisfy "transfers conserve totals" or "confirm physical movement before
   stock moves".
3. **Reservations and releases.** Nothing prevents "both crews reserving the
   same scarce stock". Not modelled at all.
4. **Operations-contract v1.** Absent entirely: no replay/idempotency ID, no
   actor or vehicle attribution, no record version, no pending/conflict
   response shape. "A replay cannot add stock twice" currently fails.
5. **Crew permissions.** Only `is_admin()`. The plan requires owner versus
   assigned-crew, and "crew cannot read or alter unassigned records".
6. **Units.** Shipped: each, linear_ft, box, roll, kit, set. Required and
   missing: **litres** (bleach, degreaser, rust remover, Gutter Bomb, Dawn),
   **kilograms** (solid de-icer), channel by **stick/profile** with usable
   offcuts, strings by **specified length and type**, and a Low/Enough/Empty
   replenishment level for cheap supplies.
7. **Exact versus estimated counting**, and **usable versus damaged** stock.
   The plan is explicit that approximate quantities must never be presented
   as exact balances; nothing in the current schema can express the
   difference.
8. **Opening balances as explicit entries.** The `opening` reason exists, but
   nothing states or enforces that balances are never inferred from old
   quotes.
9. **Second supplier.** `https://lightsdepot.ca/` (Christmas) is not
   represented. Only `permanentlightingdirect.ca/diy-kits` was seeded.
10. **Sealed kit versus components.** The invariant "a kit counts as a sealed
    kit OR its unpacked components, never both" is 9.1 work, but the 8.1
    schema has no place to hold the distinction, so 9.1 cannot enforce it
    without a migration that reshapes 8.1's tables.

### Shipped early, belongs to a later batch

* `ns_rental_sets` / `ns_rental_set_events` are **9.1**, not 8.1. They are
  also shaped wrong for what 9.1 requires: the plan wants a set/run identity
  **independent of the customer**, with temporary assignment, run
  length/type/colour, bins and storage locations, condition, and an
  owner-set release cutoff. The shipped table keys identity to a `set_code`
  with a direct `customer_id` and a status vocabulary that conflates
  assignment with location. 9.1 will restructure it. The lifecycle event log
  is the part most likely to survive unchanged.
* The per-job Materials panel (`admin/js/components/job-materials.js`) is
  closer to 10.1 load planning than to 8.1. It is harmless, within my
  ownership and useful, so it stays, but it is not 8.1 evidence.

### Already consistent with the plan

* Pricing stays in backend RPCs; nothing in 8.1 touches
  `calculate_job_pricing`, `quote_line_items`, `get_customer_quote`,
  `mark_quote_sent`, `respond_to_quote` or `pricing_rules`, and a test greps
  both migrations to keep it that way.
* No parallel inventory per service — one catalogue, shared across the nine
  cleaning services.
* No parallel sender or outbox.
* No fabricated supplier data. The plan records that Codex's proxy hit
  HTTP 403 on both supplier sites; mine fails the same way
  (`getaddrinfo ENOTFOUND`, then `CONNECT tunnel failed, response 403`), so
  pack sizes and kit contents stay unset and configurable.
* Existing customers, properties, jobs, quote snapshots, guards, rollups and
  the notification worker are untouched.

---

## 4. Corrective 8.1 work

### Done (items 1-3)

1. **Locations and balances.** `ns_stock_locations` with Base and Car A
   seeded. Car B is capability, not data: the owner runs one crew today, so
   a second vehicle is a row somebody inserts rather than a migration
   somebody writes. Nothing hardcodes two vehicles, and a test adds and
   removes Car B to prove it. Exactly one base is enforced by a partial
   unique index -- a second would split the shared pool and make every
   stock answer ambiguous. `location_id` is NOT NULL on every movement, and
   `ns_material_stock_by_location` gives the per-location balance the
   morning question actually needs. The old per-material view survives as a
   rollup, so callers written before locations existed keep working.
2. **Transfers as a conserving pair.** `post_stock_transfer` writes two legs
   in one transaction, and a DEFERRED constraint trigger checks at COMMIT
   that every transfer operation has exactly two legs, two distinct
   locations, and sums to zero per material. Deferred is the point: an
   immediate check fires after the first leg and would fail every
   legitimate transfer. A hand-built one-legged or unbalanced transfer is
   refused even when it never goes through the function. Physical
   confirmation is required before any stock moves, and a transfer larger
   than the source holds is refused -- a negative balance is meaningful for
   consumption but never for a transfer.
3. **Operations-contract v1.** `ns_stock_operations` with a unique
   caller-supplied `client_operation_id`, plus `actor_id`,
   `vehicle_location_id`, `record_version` and `confirmed_physical`. A
   replay returns the original operation with `replayed: true` and writes
   nothing; reusing a key for a different kind of operation raises rather
   than quietly returning the wrong act. Frozen and documented for both
   tracks in **docs/operations-contract-v1.md**.

Also done, because the contract is only real if the back door is shut:
`INSERT`/`UPDATE`/`DELETE` on both ledger tables is **revoked from
`authenticated`**, so the two RPCs are the only way stock moves. `SELECT`
stays -- the ledger is the audit trail. The migration verifies the revoke
took effect and raises if it did not.

`estimate_job_materials` gained a **stock basis**: `null` for every
location, `'base'` for the shared pool, a vehicle code for that car plus
Base. The answer repeats the basis it used, at the top level and on every
line. An unknown code raises rather than falling back to the total, because
a shortfall against the wrong basis is worse than no shortfall.

### Still to do (items 4-8)

4. **Reservations and releases**, with a constraint that makes a second
   reservation against the same scarce stock impossible rather than
   unlikely. The one remaining 8.1 acceptance criterion.
5. **Crew permissions.** Owner versus assigned crew, enforced in RLS, with a
   test that a crew cannot read or alter unassigned records. `actor_id` and
   `vehicle_location_id` are recorded now so this is a policy change later,
   not a reshape.
6. **Units.** Add L, kg, stick, and a replenishment-level unit; add
   exact-versus-estimated and usable-versus-damaged.
7. **Admin operations view**, using existing CSS primitives plus a narrowly
   scoped `admin/css/admin-operations.css` limited to management-view
   selectors -- which is also where the `.section-box__head` wrap fix
   belongs instead of the current inline styles.
8. **Second supplier row** for `lightsdepot.ca`, name and URL only.
## 5. Correctness questions that affect the work

Only the ones that change what gets built. Everything else I will decide and
record.

1. **Does an unreserved balance exist?** When Car A holds stock that no job
   has reserved, is it available to Car B's planning, or is anything on a
   vehicle committed to that vehicle until returned? This decides whether
   reservations are against a global pool or a per-location one, and it is
   not answerable from the documents.
2. **Who may correct whom?** "Attributed corrections" is clear, but not
   whether a crew may correct its own count or only the owner may. This
   decides an RLS policy, not a UI affordance.
3. **Is Car B's existence configuration or data?** A row in
   `ns_stock_locations` that may be absent, or a fixed two-location model with
   Car B inactive. The plan says "optional Car B"; both readings satisfy it,
   and they differ in how a second crew is enabled later.

**All three were answered by the owner and are now implemented.**

(1) Confirmed: stock on a vehicle is available to that vehicle's work and
returns to Base to become generally available. This is why a vehicle stock
basis means *that car plus Base*, and a Base basis means Base alone.

(2) Confirmed: a crew may post a correction attributed to itself but may not
alter another actor's movement. Not yet enforced -- everything is admin-only
in v1 -- but `actor_id` is recorded on every operation so the policy can be
added without reshaping anything.

(3) Confirmed, with a clarification: Car B is something the business expands
to later, and only Car A matters now. So the space and the capability are
there and Car B is **not seeded**. Adding it is data entry.
