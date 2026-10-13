# Batch 8.1 — Permanent Lighting inventory, bulk purchasing, Christmas rental sets

Branch: `claude/batch-8-1`, based on `b21cb41` (Batch 7.1 follow-up).

**Nothing in this batch has been applied to the live database or deployed.**
Both migrations are written, executed against a disposable PostgreSQL, and
left unapplied pending explicit authorisation.

---

## 1. The supplier catalogue could not be read, so no parts are invented

The owner named `https://permanentlightingdirect.ca/diy-kits` as the source
for parts and bulk ordering. It is **not reachable from this container**:

```
WebFetch  → getaddrinfo ENOTFOUND permanentlightingdirect.ca
curl      → curl: (56) CONNECT tunnel failed, response 403     (HTTP 000)
```

The agent proxy's own status endpoint reports the same class of denial for
every non-allowlisted host. A web search for the supplier returned no result
for that site either.

Consequence, and the decision taken: **no part names, SKUs, pack sizes or
prices are seeded by migration.** Inventing them would put numbers nobody
has verified into a table that then feeds shortfall maths and purchase
orders. The catalogue is populated from the admin screen, and the empty
state on that screen says so in as many words.

What *is* seeded is one `ns_suppliers` row carrying only values the owner
supplied: the name "Permanent Lighting Direct" and that URL.

**Outstanding, needs the owner:** the real parts list. Until it is entered,
`estimate_job_materials` reports every measured service as *unmapped*, which
is the deliberate, visible version of "we don't know yet".

---

## 2. What the schema did not have before this batch

Verified live, read-only, before writing anything:

| Concept | Existed before? |
|---|---|
| Materials / parts table | No |
| Stock level of anything | No |
| Supplier | No |
| Purchase order | No |
| Measurement → material link | No |
| **Cost** basis anywhere | No — `pricing_rules.rate` is a *sell* price only |
| Christmas set as a tracked asset | No |

`app_settings.lighting` already recorded `christmas_ownership_model:
"rental"` and `christmas_storage_included: true`, which is why a Christmas
set is modelled as a tracked physical asset with a location and a season
rather than as a stock count: a count cannot answer "where is the Patterson
set and what condition did it come back in?".

Other live facts checked before writing, rather than assumed:

* PostgreSQL **17.6** — `security_invoker` views are available.
* **31** tables in `public` have RLS enabled; **0** have FORCE RLS. The new
  tables follow that convention (see §4).
* `service_role` carries `BYPASSRLS`.
* `job_measurements.job_id → ns_jobs(id)`, not the legacy `jobs` table.

---

## 3. What was built

### Migrations (written, **not applied**)

`supabase/migrations/20261010120000_batch8_1_inventory_and_rental_sets.sql`

* `ns_suppliers` — one seeded row, owner-supplied values only.
* `ns_materials` — the catalogue. Zero rows seeded.
* `ns_material_stock_moves` — an **append-only ledger**, not a mutable
  `on_hand` column. A counter is cheaper to read and impossible to explain;
  when the shelf and the app disagree the question is always "what moved?".
  A mistake is corrected by posting its reverse, never by editing a row.
* `ns_material_stock` — a `security_invoker` view summing that ledger, with
  `needs_reorder` derived.
* `ns_purchase_orders` + `ns_purchase_order_lines` — counted in **packs**,
  because that is what the supplier sells.
* `ns_rental_sets` + `ns_rental_set_events` — Christmas sets and their
  lifecycle log.
* `ns_service_material_usage` — what one measured unit of a service
  consumes, plus a waste allowance. This is what makes a job's requirement
  *derivable* from measurements the field already captures instead of a
  second round of data entry.

`supabase/migrations/20261010121000_batch8_1_estimate_job_materials.sql`

* `estimate_job_materials(uuid)` — SECURITY INVOKER with an `is_admin()`
  guard, same reasoning as the Batch 4 RPCs. Returns quantities, shortfall,
  packs to order, and a purchasing cost basis. **Reads the ledger, never
  writes it.**

### Constraints that exist to stop a specific mistake

* **Sign must agree with reason.** A `received` posted negative or a
  `consumed` posted positive is a data-entry slip that would otherwise read
  as a legitimate movement and quietly corrupt the on-hand figure.
  `adjustment` is the deliberate escape hatch and may go either way.
* **`waste_factor` capped at 1.0.** An unbounded multiplier would silently
  inflate every purchase order; 8 instead of 0.08 is an 800% allowance.
* **SKU uniqueness uses `coalesce(supplier_id, …)`.** A plain
  `unique (supplier_id, sku)` would allow `(null, 'ABC-1')` twice, because
  NULL is never equal to NULL — exactly the duplicate the index exists for.
* **A set cannot be `assigned`/`installed` without a customer**, and
  `installed` requires a date. Without these, a set is installed nowhere and
  stops being findable at removal time.
* **`on delete restrict`** on a material that has movements, and on a
  customer who has a set out. Losing the ledger makes every past on-hand
  figure unexplainable; deleting the customer orphans an asset at their
  house.

### Admin UI

* `admin/js/views/inventory.js` — one route `#/inventory`, four tabs behind
  `?tab=` via `replaceQuery` (not a history push, so Android Back still
  means "previous screen").
* `admin/js/components/job-materials.js` — a per-job Materials panel on the
  job screen, **loaded on demand**, between pricing and the quote.
* `admin/js/lib/inventory-math.js` — the pack↔unit and sign conversions, as
  pure functions. See §6 for why they are not inline in `api.js`.
* `shared/dom.js` gains `fill()`. See §5.

### Explicitly not done

* **No pricing change.** Nothing here touches `calculate_job_pricing`,
  `quote_line_items`, `create_quote_from_calculation`, `get_customer_quote`,
  `mark_quote_sent`, `respond_to_quote` or `pricing_rules`. There is a test
  (`K1`) that greps both migrations for exactly that.
* **No implicit consumption.** Accepting a quote does not draw down stock. A
  quote that is never accepted must not, and a job's real usage is rarely
  exactly the estimate — so "Take off stock" is an explicit act with an
  editable amount.
* **No offline queue.** The inventory screens write online only; the field
  outbox is not extended.

---

## 4. Security

Every new table: RLS enabled, a single `admin_all` policy (ALL, role
`authenticated`, `USING` and `WITH CHECK` both `is_admin()`), `revoke all
from public` **and** `from anon` before any grant, then
`authenticated`/`service_role` grants. The view is `security_invoker` so it
cannot hand out rows past the policy underneath.

**ENABLE, not FORCE.** All 31 existing RLS tables are enable-only. FORCE
would also apply the policy to the table *owner*, which is the role
migrations run as, so a future maintenance statement would be blocked by
`is_admin()` being false for `postgres`. `service_role` has `BYPASSRLS`, so
the server-side path is unaffected either way.

The explicit revoke before granting is the Batch 7.1 finding applied to new
objects: a privilege can be held **directly, through PUBLIC, or inherited**,
and "we never granted it" is not the same as "nobody has it". Test `I3`
re-proves the inherited route against these tables rather than assuming the
earlier finding still holds.

---

## 5. A bug class found by looking, not by asserting

`el()` skips `null`/`undefined`/`false` children, so `cond ? x : null` reads
as "omit this" everywhere inside an `el()` call. **DOM `append()` does not**
— it stringifies, so the same expression passed to `clear(host).append(…)`
paints the literal word **`null`** on the page.

The first Inventory screenshot had five of them. No DOM assertion would have
caught it: the tests looked for the elements they expected and found them.

Fixed by adding `fill(node, children)` and using it throughout the two new
files. It initially went into `shared/dom.js`; the revised roadmap after
Batch 7 makes `shared/` read-only to both tracks, so it now lives in
`admin/js/lib/admin-dom.js` instead — see
docs/batch8-1-scope-reconciliation.md §2.

**Not fixed, and worth a follow-up:** the same pattern exists in
pre-existing views (`winter.js` passes `selectedEvent ? … : null` straight
to `append`). Those were left alone — they are outside this batch and in
files this batch does not otherwise touch. Someone should sweep
`clear(x).append(` across `admin/js/` and convert the conditional ones.

A second defect came from the same screenshot pass: a rental set recorded as
**lost** was offered "Mark installed", because the condition was
`set.customer_id && status !== 'installed'` — every clause true, the result
nonsense. Replaced with explicit from-status tables (`CAN_INSTALL`,
`CAN_REPAIR`, `CAN_UNASSIGN`) and pinned by tests `F2b`/`F2c`.

A third: `.section-box__head` has no `flex-wrap`, so a long part name plus a
badge plus a button overflowed the viewport at 390px and 430px. Fixed with
an inline `flex-wrap:wrap` on the new headers only — editing the shared rule
would change every other view's header.

---

## 6. Why the pack conversion lives in its own module

The browser tests replace `api.js` wholesale. That is right for testing a
view, but it means arithmetic living in `api.js` is only ever tested against
**a copy of itself in the mock** — the copy can agree with the test while
the shipped function is wrong. Confirmed: breaking
`receivePurchaseOrderLine`'s conversion in `api.js` left the suite green.

So `packsToUnits`, `packsForShortfall` and `signedDelta` moved to
`admin/js/lib/inventory-math.js`, which the tests import **un-mocked**.
Getting the conversion wrong is a silent 150× error in the on-hand figure;
that is not something a duplicated implementation should be guarding.

Teeth confirmed by deliberately breaking each and watching the right test
fail:

| Break | Test that failed |
|---|---|
| `signedDelta` → return the typed value | `C1` |
| `packsForShortfall` → `Math.floor` | `I3` |

---

## 7. Test results

| Suite | Result |
|---|---|
| `tests/db/batch8-1.test.mjs` (disposable PostgreSQL 16, local) | **70/70** |
| `tests/db/batch7-1.test.mjs` (unchanged, re-run) | **38/38** |
| `tests/phase23.test.mjs` (mocked browser, Inventory + job panel) | **48/48** |
| `npm test` — full regression, 26 suites | **all green** |
| `tests/screenshot-batch8-1.mjs` — 390 / 430 / desktop, 4 tabs + 2 expanded + job panel | **no layout problems in any view** |

`bash tests/db/run-db-tests.sh` runs both database suites, each against a
**freshly created** disposable database, because the two fixtures define
overlapping table names with different shapes and sharing one database would
make the result depend on the order they ran in. It is invoked directly, not
through `npm run test:db`: `package.json` belongs to the native/packaging
track under the revised roadmap, and its `test:db` script still points at the
Batch 7.1 suite alone.

`phase22` (Batch 6.1 Settings) and `phase23` were briefly added to the
regression runner's explicit list and have since been **reverted**:
`tests/run-regression.sh` is a separate owner-authorised integration change
under the revised roadmap. Both suites pass and must be run directly until
integration registers them. The list stays explicit, never a glob —
`tests/db/` and `tests/integration/` talk to real databases.

### What the tests do and do not prove

They **do** prove: the migrations are valid SQL against real PostgreSQL;
each constraint rejects what its comment claims; the on-hand view and the
estimate RPC compute what they claim; anon is shut out of the new objects
through all three privilege routes; the UI's own logic behaves as described.

They **do not** prove anything about the live Supabase project, production,
or native-device behaviour. Neither migration has been applied anywhere.
The browser tests mock `api.js`, so they say nothing about the real network
path.

---

## 8. Outstanding

Carried forward, unchanged from earlier batches:

* `20261009160000_batch5_freeze_customer_facing_content_once_sent.sql` —
  written, corrected in 7.1, **still not applied**.
* The two Batch 7.1 grant migrations — **not applied**.
* §5 data cleanup from the 7.1 findings — still blocked on approval.
* One legacy inbound FK still unidentified.
* The repository still has **no base schema** (7.1 finding 4b); production
  cannot be rebuilt from it.

New with this batch:

* Both 8.1 migrations are **not applied**.
* The parts catalogue is empty and needs the owner's real data from the
  supplier.
* `clear(x).append(` with conditional children elsewhere in `admin/js/`
  (see §5) — a sweep worth doing.
* Receiving a purchase-order line is two writes (`packs_received`, then the
  stock movement) issued in that order from the browser, so a failure
  between them leaves a PO that under-reports its receipt — visible and
  correctable — rather than stock nobody accounts for. If that pair starts
  drifting in practice it belongs in one RPC.
