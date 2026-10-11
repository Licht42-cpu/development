# Nova Shield permanent-lighting materials contract v1

**Status: frozen.** A change to this document is a new version, agreed
before either side implements against it.

**Companion to, not a revision of,** `docs/operations-contract-v1.md`. The
only place this work touches the stock contract is the `conversion`
operation kind, which is specified there as **amendment v1.1 (§13)** and is
additive: no v1 shape, parameter, error code or grant moved.

**Nothing here has been applied to the live database.**

Defined by:

* `supabase/migrations/20261011100000_batch9_1_permanent_lighting_materials.sql`
* `supabase/migrations/20261011101000_batch9_1_kit_and_sheet_operations.sql`

Proved by `tests/db/batch9-1-lighting.test.mjs` (53 checks) against a real
PostgreSQL, and exercised from the UI side by `tests/phase25.test.mjs`
(25 checks).

---

## 0. No product data is in here

`permanentlightingdirect.ca` is unreachable from this environment — the same
wall Batch 8.1 hit and the same one Codex's proxy hit. **Not one kit,
component, coverage figure, pack size, price or compatibility claim is
seeded by these migrations.** Every material in the test suite is named
`FIXTURE …` so it cannot be mistaken for a catalogue entry, and
`batch9-1-lighting.test.mjs` H6 asserts that no migration seeded a material
at all.

This is why `spec_state` and `review_state` exist. An unknown specification
is a recorded state, not a blank that reads as fine, and it **blocks** the
operations that would otherwise rest on a guess.

## 1. Four facts a material now carries

| column | meaning | unknown is |
|---|---|---|
| `cuttable` | may be cut to length | `false` — a fixed kit, not a roll |
| `stock_length` | how long ONE piece is | `null`, which is **not** 1 |
| `spec_state` | `unverified` / `reviewed` / `unavailable` | `unverified` |
| `spec_source` | where the figures came from | `null` |

A `reviewed` spec must carry `spec_reviewed_at` (CHECK constraint). Two new
categories: `kit` (a sealed supplier kit) and `heating_cable` (fixed-length
kits and cuttable cable alike — `cuttable` is what tells them apart).

## 2. Kit sheets — what is inside the box

`ns_kit_sheets` (one per kit material) and `ns_kit_sheet_lines`.

A line's `quantity_per_kit` is **nullable on purpose**: "the listing says
this is included but not how many" is a real answer. A line is either
`included` (in the box) or `separately_required` (needed for the install,
not supplied).

**The gate.** A deferred constraint trigger refuses `review_state =
'reviewed'` when the sheet has no lines, or when any **included** line has
no quantity. A CHECK additionally requires a reviewed sheet to name a
`source` and a `reviewed_at`. Together: a sheet cannot claim to be checked
unless somebody checked it against something, and said what.

Sheets are **owner-writable under RLS** — no RPC — because the trigger is
what enforces correctness, and a direct write cannot get past it.

## 3. Opening a kit

```
open_sealed_kit(p_client_operation_id, p_kit_material_id,
                p_location_code, p_kit_count default 1, p_note default null)
```

Owner-only. Specified in full as **operations contract §13**. In summary:
the kit leaves stock and its **included** components arrive, as one
`conversion` operation, in one transaction. Separately-required components
are **not** created — they are on the sheet because the install needs them,
not because they are in the box, and creating stock for them would be
inventing inventory.

Refused unless the sheet is `reviewed`. Refused if fewer kits are on hand
than asked for. Replay-safe.

> "An unopened permanent kit and its component stock may never both count as
> available" — roadmap handoff. The conversion pairing trigger is what makes
> that checkable rather than asserted.

## 4. Offcuts — pieces, not a quantity

**The problem.** Two 3 ft offcuts are not a 6 ft run. A ledger that knows
only "6 ft on hand" will let somebody promise a 6 ft run that cannot be cut.

**The model.** `ns_material_offcuts` records individual pieces. An offcut
record **adds no stock**: cutting 7 ft off a 10 ft stick consumed 7, not 10,
so the ledger already says 3 ft is there. The piece record says that 3 ft is
*one* 3 ft piece.

**The invariant**, enforced by a deferred constraint trigger:

```
sum(length of available offcuts at a location)  ≤  usable on_hand there
```

If it could exceed, the piece list would be promising material that is not
on the shelf. `batch9-1-lighting.test.mjs` E2 proves the refusal.

### Usable, damaged and unusable are never confused

| state | `condition` | `status` | on the usable shelf? |
|---|---|---|---|
| a piece worth keeping | `usable` | `available` | yes, and counted in the invariant |
| cut into a job | `usable` | `used` | no — its length left the ledger |
| written off | `damaged` | `scrapped` | no — a `damaged` movement took it off |

A CHECK constraint forbids `condition='damaged'` with `status='available'`,
so "available and damaged" cannot exist. Scrapping **keeps the record** and
posts the write-off, rather than deleting the row: a deleted piece would
leave the shelf count claiming material that is in the bin.

### A note on `condition` on a movement

In this ledger `condition` names **which pool** a quantity moves in, and
`reason` says **why**. So scrapping a piece posts
`condition='usable', reason='damaged'` — it leaves the usable pool, because
it is damaged. Posting `condition='damaged'` would drive the damaged pool
negative and leave the usable count unchanged. (A test caught exactly this
before it shipped; see `docs/batch9-1-findings.md`.)

### Operations

```
record_offcut (p_client_operation_id, p_material_id, p_location_code,
               p_length, p_from_job_id default null, p_note default null)
consume_offcut(p_client_operation_id, p_offcut_id,
               p_job_id default null, p_note default null)
scrap_offcut  (p_client_operation_id, p_offcut_id, p_note default null)
```

All admin-level and crew-scoped by location — recording and using a piece is
field work. All replay-safe (`record_offcut` on the offcut's own
`client_operation_id`; the other two on the stock operation's). A non-cuttable
material is refused with `22023`: a fixed-length kit is whole or it is scrap.

Response shape: `ns_offcut_result` — the piece, plus a `pieces` object with
`on_hand`, `offcut_total`, `offcut_count`, `longest_offcut`,
`full_length_total` and `longest_runnable`.

## 5. Reading pieces

`public.ns_material_piece_availability` (security_invoker). Per material and
location:

| field | answers |
|---|---|
| `on_hand`, `available` | the ledger's totals, as in the stock contract |
| `offcut_total`, `offcut_count`, `longest_offcut` | the recorded pieces |
| `full_length_total` | stock not accounted for by a recorded piece |
| `full_pieces` | `floor(full_length_total / stock_length)`, **null** when the piece length is unknown |
| `longest_runnable` | the longest single run cuttable today — **null** when unknowable |

`longest_runnable` is the number a planner needs; a total cannot answer
"can I cut a 6 ft piece". **Null means unknown and must be shown as
unknown**, never rendered as zero.

## 6. Job material sheets

`ns_job_material_sheets` (`draft` → `reviewed` → `reserved`, or `cancelled`)
and `ns_job_material_sheet_lines`. A partial unique index allows **one open
sheet per job**: two live sheets would reserve twice for the same work.

**`selected` is the word that matters.**

```
select_job_material(p_client_operation_id, p_sheet_id, p_material_id,
                    p_quantity, p_selected default true,
                    p_source default 'selected', p_service_id, p_note)
review_job_material_sheet(p_client_operation_id, p_sheet_id, p_note)
reserve_job_material_sheet(p_client_operation_id, p_sheet_id,
                           p_location_code default 'base', p_note)
```

All owner-only.

* `select_job_material` refuses to **select** a `kit` or `heating_cable`
  whose `spec_state` is not `reviewed`, and refuses to select a kit with no
  reviewed component sheet. It may still sit on the sheet unselected, as a
  note to self.
* `review_job_material_sheet` refuses when nothing is selected, and when any
  selected line names an unchecked specification.
* `reserve_job_material_sheet` reserves **only** `where selected`, through
  the v1 `reserve_stock`, with one suffixed key per line so a retry replays
  each reservation instead of creating a second set. Level-tracked supplies
  are skipped: they have no quantity to reserve.

> "Accepted work reserves only selected materials, not every draft quote
> option" — roadmap 9.1 acceptance. The loop reads `where selected`, so an
> unchosen option cannot reach the shelf even when it is sitting on the same
> sheet. `batch9-1-lighting.test.mjs` F4 proves the unchosen option's
> availability is untouched.

## 7. Heating-kit selection

```
ns_heating_kit_candidates(p_job_id uuid) returns jsonb
```

Returns `{ job_id, measurements[], selection_rule, candidates[] }`.

**It does not rank, score, filter by fit, or recommend.** The roadmap is
explicit — "the manufacturer's layout determines the selected cable/kit",
"no automatic electrical/cut optimization", "do not derive electrical
configuration from footage alone" — so this call puts the job's measurements
and the products we stock side by side and stops.

A candidate whose specification is unchecked is returned with
`selectable: false` and a `why_not` sentence, **not hidden**. Hiding it
would quietly narrow the list and make the gap invisible; showing it as
unselectable makes the missing product data the visible problem it is.

`selection_rule` is carried in the payload so no caller can mistake the list
for advice.

## 8. Authorisation

| call | who |
|---|---|
| `record_offcut`, `consume_offcut`, `scrap_offcut` | any admin, scoped to locations they can see |
| `open_sealed_kit` | **owner only** |
| `select_job_material`, `review_job_material_sheet`, `reserve_job_material_sheet` | **owner only** |

Kit sheets and job sheets: `SELECT` to any admin, writes owner-only via RLS.
Offcuts: read scoped by `can_see_location`; **no write policy and no write
grant** — writes go through the RPCs, because a direct insert would walk
past the within-stock invariant and the replay key. The migration asserts
that, and that `anon` holds no `EXECUTE` through any of the three privilege
routes, before it finishes.

## 9. Errors

| code | when |
|---|---|
| `42501` | not an admin; a crew attempting an owner-only call; a location out of scope |
| `22023` | blank operation key; non-positive quantity or length; a material that is not a kit; an offcut on a non-cuttable product; an unknown `source` value |
| `P0002` | no such material, offcut, sheet or active location; a kit with no component sheet |
| `23514` | an unreviewed kit sheet; a sheet with nothing included; fewer kits on hand than asked for; an offcut longer than the shelf holds; a piece already used or scrapped; reserving a sheet that is not reviewed; reviewing with nothing selected or with an unchecked specification; selecting an unchecked kit or cable |
| `23505` | a duplicate operation key; a second open sheet for one job; two component sheets for one kit |

`P0002` is PL/pgSQL's `no_data_found`, not the SQL-standard `02000`.

## 10. Fixtures

`tests/db/fixture-schema-batch8-1.sql` plus
`tests/db/fixture-schema-batch9-1.sql`, unchanged by this batch. The test
suite builds its own `FIXTURE` catalogue; nothing in the migrations seeds a
material, a supplier beyond Batch 8.1's single owner-supplied row, or a kit
sheet.

## 11. Deliberately out of scope

* **Compatible product references** beyond the kit sheet's own component
  lines. The roadmap asks for them; without product data there is nothing to
  express a compatibility rule over, so the sheet's `separately_required`
  lines are as far as this goes. Recorded as a gap, not quietly dropped.
* **"Permanent Lighting Phase D"**, which the roadmap's 9.1 section says to
  fold in. No such document exists in this repository or on the roadmap
  branch; see `docs/batch9-1-findings.md`.
* **Cut optimisation.** Which offcut to use for which run is a human
  decision. `longest_runnable` is reported; nothing chooses.
* **Automatic sheet generation from measurements.** The estimate RPC
  (`estimate_job_materials`) suggests quantities; a person puts them on the
  sheet. Nothing auto-selects.
* **Field access.** None of these calls is in the field outbox, and none is
  reachable from the phone console.
