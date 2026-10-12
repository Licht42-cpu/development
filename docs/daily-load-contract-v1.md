# Nova Shield daily load contract v2.1

**Status: frozen at v2.1.** A change to this document is a new version,
agreed before either side implements against it.

The filename stays `daily-load-contract-v1.md`, as `operations-contract-v1.md`
does at its own v1.2: the document declares its version and every
cross-reference — including Codex's handoff — keeps resolving.

---

## What changed in v2.1

A second pass over the same six findings, after v2 was pushed, found two
things v2 had documented without implementing. Both are behavioural, so
they are a version and not an erratum.

| # | what was still wrong | v2.1 |
|---|---|---|
| 1 | **the work date had no stated timezone**, and the code's unchosen answer (the UTC calendar date) disagreed with the field console's own day boundary | the operating day is the owner's configured timezone, reported in every read, UTC while unset. §2a |
| 2, 4, 6 | **a confirmation could accept a recommendation the crew had not seen**: a Manual Keep or an authorised exception changes what the plan asks for without moving its revision or its basis fingerprint | `lines_fingerprint`, returned everywhere the plan is, and **required** by `confirm_load_plan`. §6a |

**The one breaking change in v2.1, named explicitly.**
`confirm_load_plan` gains a sixth parameter,
`p_expected_lines_fingerprint text default null`, and the five-argument
function is **dropped** (42P13 again: PostgreSQL will not add a defaulted
parameter beside existing defaulted ones, and a surviving overload would be
a confirmation path with no lock on it — the migration asserts it is gone).
A five-argument *call* still resolves, **but it now fails with `22023`**:
both the revision and the lines fingerprint are required, because a
confirmation that cannot say what it saw cannot be checked. `p_note` keeps
its position, so no existing positional call changes meaning.

Everything else keeps its shape. `ns_load_plan_result` gains
`lines_fingerprint`; `get_load_plan` gains `work_day_timezone` and
`work_day_timezone_state`; `ns_load_day_summary` gains those two plus
`window_starts_at`, `window_ends_at` and `property_id` on each visit; the
`set_manual_keep` receipt gains `plan_id`, `plan_revision` and
`lines_fingerprint`. All additive. `ns_vehicle_day_jobs`,
`ns_unassigned_day_jobs` and `ns_load_basis_fingerprint` keep their
signatures and now bucket the day by §2a's bounds.

**For existing callers.** `admin/js/lib/api.js` `confirmLoadPlan()` takes
`expectedLinesFingerprint` and `admin/js/components/load-plan.js` quotes it
from the plan it rendered. Any other caller of `confirm_load_plan` must do
the same; there is no compatibility path that skips the check, deliberately.

Defined by
`supabase/migrations/20261015090000_batch10_1_corrective_day_boundary_and_lock.sql`,
which applies **after** the v2 migration. Proved by
`tests/db/batch10-1.test.mjs` L1–L11 and `tests/phase26.test.mjs` M1–M5.

---

## What changed in v2, and why 10.2 was right to stop

Codex's review of `1ffafc2`
(`docs/reviews/daily-load-contract-1ffafc2.md` at `b948db3` on
`codex/batch-10-2`) raised six findings and declined to implement against
them, which was the correct call: **four were backend defects in 10.1**, not
gaps in this prose, and a screen built on them would have shown the operator
things that were not true. Each was reproduced against a disposable
PostgreSQL before anything was changed. Dispositions, with the proof for
each, are in `docs/batch10-1-corrective-findings.md`.

| # | finding | verdict | v2 |
|---|---|---|---|
| 1 | the crew read path was never frozen, and the only implementation had drifted from this document | **gap + drift** | `get_load_plan()` and `ns_load_day_summary()`: one frozen envelope, closed plans included, `state` and `can_build` explicit. §3a |
| 2 | clearing a Manual Keep left the live line reading Keep | **defect** | the line remembers `pre_keep_action` and goes back to it. §7 |
| 3 | three mutations did not enforce the replay guarantees §12 promised, and one returned before its scope check | **defect** | one key ledger, one guard, kind → scope → intent. §12 |
| 4 | the Keep, exception and reconciliation receipts were underspecified | **gap** | every receipt is specified below AND stored, so a replay returns it byte-for-byte. §7, §7a, §8 |
| 5 | a damaged closing variance moved the wrong stock pool | **defect** | the count is of usable stock; a damaged shortfall is two movements. §8 |
| 6 | authorised exceptions had no effect on confirmation | **defect** | a skip is not transferred; a carry_extra absent from the plan adds a line. §7a |

**The one breaking change, named explicitly.**
`authorise_load_exception` gains a ninth parameter, `p_quantity numeric
default null`, and the eight-argument function is **dropped**. Every
existing eight-argument *call* keeps working because the new parameter is
defaulted; PostgreSQL will not let both overloads coexist (42P13), which is
also why there is never a moment when one of them silently has no effect on
the load. Nothing else in this document changed shape: `build_load_plan`,
`confirm_load_plan`, `reconcile_day_end`, `set_manual_keep`,
`ns_next_day_suggestions` and `ns_vehicle_day_jobs` keep their signatures
and defaults, and `ns_load_plan_result` gains two fields and loses none.

Added in v1.1 and still here: `move_seasonal_set` and
`ns_seasonal_sets_aboard`, which answer per-car aboard status from the set's
own location rather than from a commercial promise — see
`docs/seasonal-sets-contract-v1.md` v1.2 and
`docs/reviews/seasonal-abedf0f-dispositions.md` finding 5b.

### Fixtures

`tests/fixtures/daily-load-v2.json`, regenerated by
`npm run fixtures:daily-load` from the real backend on a disposable
database. **Twenty-four** scenarios. The six added in v2 and the four
added in v2.1 are the ones to read first:

| scenario | what it pins |
|---|---|
| `frozen_read_envelope` | §3a, including `state: "none"` and a crew's `can_build: false` |
| `closed_day_is_readable` | last night's closing count is readable |
| `manual_keep_clear_restores_recommendation` | Return → Keep → clear |
| `per_operation_retries` | all four mutations: same key, changed intent, a late retry, and both replay-scope paths |
| `damaged_variance_pools` | the two movements, and the refusal of a surplus called damaged |
| `exception_affects_confirmation` | a skip is not transferred; an extra is |
| `operating_day_timezone` | **v2.1** — the same evening visit on two different days, unconfigured vs configured, with the window bounds it used |
| `recommendation_lock` | **v2.1** — a Keep set after the read, the refusal, and the reload that recovers |
| `keep_clear_whole_day` | **v2.1** — clearing a Keep restores Keep for what the day still needs and Return for what it does not |
| `closing_without_confirmation` | **v2.1** — a count with no plan at all, and an estimate recorded as an estimate |

`duplicate_retry` is kept and still exercises plan **building** only — the
point Codex made. The four mutations are now covered by
`per_operation_retries` instead.

---

This is the contract Batch 10.2 implements the crew's preparation and
closing interface against. It is a **companion to**, not a revision of,
`docs/operations-contract-v1.md` (stock, frozen at v1.1) and
`docs/seasonal-sets-contract-v1.md`. One thing in the stock contract
changed: §11 of that document listed the owner/crew split within a shared
location as unspecified. It is now specified, as **amendment v1.2 (§14)**
there and §9 here. No request shape, parameter, error code or grant in
either earlier contract moved.

**Nothing here has been applied to the live database.**

Defined by:

* `supabase/migrations/20261011110000_batch10_1_load_planning.sql`
* `supabase/migrations/20261011111000_batch10_1_load_operations.sql`
* `supabase/migrations/20261013090000_batch11_1_seasonal_corrective_round_two.sql`
  — v1.1's two additions only; it changes nothing above.
* `supabase/migrations/20261014090000_batch10_1_corrective_load_contract.sql`
  — v2. It adds the key ledger, the read path and two line columns, and
  replaces `set_manual_keep`, `authorise_load_exception`,
  `confirm_load_plan`, `reconcile_day_end` and `ns_load_plan_result`.
* `supabase/migrations/20261015090000_batch10_1_corrective_day_boundary_and_lock.sql`
  — v2.1. Applies last; it adds the operating-day bounds and the
  recommendation lock, and replaces `ns_vehicle_day_jobs`,
  `ns_unassigned_day_jobs`, `ns_load_plan_result`, `get_load_plan`,
  `ns_load_day_summary`, `set_manual_keep` and `confirm_load_plan`.

Proved by `tests/db/batch10-1.test.mjs` (79 checks) against a real
PostgreSQL. **Deterministic fixtures: `tests/fixtures/daily-load-v2.json`**,
generated by running this backend (`node tests/fixtures/build-daily-load-fixtures.mjs`)
so they cannot drift from the contract.

---

## 1. The four things that must never be conflated

| | what it is | moves stock? |
|---|---|---|
| **Recommendation** | a plan line | no |
| **Commitment** | a reservation (stock contract §4b) | no — reduces *available* |
| **Confirmed move** | a transfer (stock contract §4) | **yes** |
| **Consumption** | a `consumed` movement | **yes** |

Collapsing any two is how the same tin gets counted twice — once as planned,
once as loaded. **Every quantity on a plan line is a READING of the ledger
taken when the plan was generated.** Nothing downstream derives a balance
from them; they exist for display and for noticing that the world moved on.

`batch10-1.test.mjs` E1 asserts that building a plan posts zero movements.

## 2. The day is the unit

Reusable **equipment** is decided once for the whole day: a washer needed at
stop 3 stays aboard through stops 1 and 2 and is not added three times.
**Consumables** are the opposite — summed across the day's jobs.

> "Shared tools must not be added or returned once per job when one
> whole-day decision is appropriate."

E.g. `mixed_services` in the fixtures: three stops, one washer line, with
every stop that needs it listed in `job_ids`.

## 2a. Which day — the work date's timezone (NEW in v2.1)

`p_work_date` is a **calendar date with no timezone of its own**. Every
function that takes one turns it into a half-open range of instants and
asks which visits fall inside it. That conversion needs a timezone, and
until v2.1 nobody had chosen one: the code used the **UTC calendar date**,
because that is what gets written when the question is not asked.

**Why that is not a detail.** The field console bounds its own visit list at
the **device's local midnight** (`api.js listTodaysVisits`). West of
Greenwich the two disagree for every late-afternoon job: a visit at 18:30
local in a UTC−6 zone is 00:30 the *next* day in UTC, so the crew's schedule
shows it today and today's load plan does not contain it. The van is loaded
for a day that does not include the job, and nothing says why. The fixture
`operating_day_timezone` is that exact case.

```
ns_work_day_timezone()                 -> text        -- IANA name, or null
ns_work_day_bounds(p_work_date date)   -> table (starts_at timestamptz,
                                                 ends_at   timestamptz,
                                                 zone       text,
                                                 zone_state text)
```

**The timezone is the owner's to choose and is not invented here.** It is
read from `app_settings` where `key = 'operations'`, as
`value ->> 'work_day_timezone'`, and must be a name PostgreSQL knows
(`pg_timezone_names`).

| state | bounds used | reported as |
|---|---|---|
| a known zone is set | that zone's midnight to the next midnight | `work_day_timezone: "<name>"`, `work_day_timezone_state: "configured"` |
| nothing set | **UTC** midnight to midnight — exactly the previous behaviour, so nothing changes silently | `work_day_timezone: null`, `work_day_timezone_state: "unconfigured"` |
| a name PostgreSQL does not know | UTC, as above | `unconfigured` — one malformed settings row must not stop the crew seeing the day |

`ends_at` is **exclusive**: a visit at exactly midnight belongs to the day
that starts then, which is the only reading under which two consecutive days
neither overlap nor drop an instant between them.

**A screen must say which of the two it got.** While the state is
`unconfigured`, `load-plan.js` prints that the day is being counted midnight
to midnight UTC and that late-afternoon work can fall on the next day's
plan. Unknown is reported, never defaulted — the same rule as a missing
consumable allowance in §4.

`ns_load_day_summary` returns the window it actually used
(`window_starts_at`, `window_ends_at`) so a client that bounds its own day
can compare the two rather than assume they agree.

### Addresses and access notes are NOT in this contract

A crew needs to know where it is going, and that read already exists and is
not ours to duplicate: `customers` and `properties` carry the single
`admin_all` RLS policy, and the field console reads them through
`api.js listTodaysVisits` (`ns_jobs` embedding
`properties(address_line1,city,postal_code,latitude,longitude)`) and
`getJob` (`properties(*)`, which carries `access_note`). Copying those
columns into a `security definer` load function would create a second
surface for the same data, governed by different rules, for no gain.

`ns_load_day_summary` therefore reports `property_id` on each visit and
stops there: it is the join key for the read above, so nothing has to be
guessed and nothing is widened.

## 3. `build_load_plan`

```
build_load_plan(
  p_client_operation_id text,
  p_location_code       text,   -- must be a VEHICLE, not base
  p_work_date           date,
  p_note                text default null) returns jsonb
```

**Owner only.** Building a plan reads the whole day's schedule and decides
what every job needs; that is not field work.

Each call makes a **new revision** and supersedes the live one. The old plan
is kept — a confirmed plan that was later superseded is the record of what
the crew agreed to. Replay-safe: the same key returns the same plan with
`replayed: true` and creates no second revision.

### Response

```json
{
  "plan_id": "…", "location_id": "…", "location_code": "car_a",
  "work_date": "2027-04-05", "revision": 1, "status": "current",
  "basis_fingerprint": "…", "lines_fingerprint": "…", "generated_at": "…",
  "confirmed_at": null, "closed_at": null, "note": null,
  "replayed": false,
  "unassigned_jobs": 0,
  "needs_review_count": 1,
  "lines": [ { …see §4… } ]
}
```

`status` is one of `current`, `superseded`, `confirmed`, `closed`.

## 3a. `get_load_plan` — the crew's read path (NEW in v2)

**This is the only supported read.** `build_load_plan` is owner-only and
creates a revision, so opening a crew screen cannot call it; and the one
implementation that existed read `ns_load_plan_view` and built its own DTO
which had drifted from this document. One function now returns one shape.

```
get_load_plan(p_location_code text, p_work_date date) returns jsonb
```

**Any admin**, scoped: a location the caller cannot see raises `42501`, and
an unknown code raises `P0002`. `ns_load_plan_view` is unchanged and still
exists; anything already reading it keeps working, but it is not the frozen
surface.

```json
{
  "location_id":   "…",
  "location_code": "car_a",
  "location_name": "Car A",
  "work_date":     "2027-06-01",

  "state":     "current" | "confirmed" | "closed" | "none",
  "can_build": false,

  "work_day_timezone":       "America/Edmonton" | null,
  "work_day_timezone_state": "configured" | "unconfigured",

  "plan": { …exactly §3's response, or null… },

  "needs_review_count":   1,
  "unassigned_job_count": 0,

  "day": { …§3b… }
}
```

| field | type | null? | meaning |
|---|---|---|---|
| `state` | text | no | `none` means **nobody has built one**. It is not an error and not an empty plan, and a screen has to be able to say the difference. |
| `can_build` | boolean | no | `is_owner()`. A crew facing `none` is told to ring the office rather than shown a button that will refuse it. |
| `work_day_timezone` | text | **yes** | **v2.1.** The operating timezone the day was bucketed by. Null means nobody has set one. §2a |
| `work_day_timezone_state` | text | no | **v2.1.** `configured` or `unconfigured`. A screen must say which, because `unconfigured` means UTC and UTC can put an evening visit on the next day's plan. |
| `plan` | object | **yes** | null exactly when `state` is `none`. Otherwise §3's response with `replayed: false`. |
| `needs_review_count` | integer | no | lines whose `data_state` is `needs_review`. Dropped by the old DTO. |
| `unassigned_job_count` | integer | no | the day's jobs with no explicit vehicle assignment. Dropped by the old DTO. |

**Which plan comes back.** The `current` or `confirmed` plan for that
vehicle and date if one exists; otherwise the highest-revision `closed` one.
**Closed days are readable** — the old DTO filtered them out, so last
night's closing count could not be looked at. Superseded revisions are not
returned by this call; they remain in `ns_load_plans` as the record of what
was agreed.

**Recovery after a `23514`.** A refused confirmation means the plan you were
looking at is not the one that can be confirmed. Call `get_load_plan` again:
`plan.revision` and `plan.basis_fingerprint` are the current values, and the
sentence in the error says which of the three things moved (a newer
revision, a schedule change, or a fingerprint mismatch). If the basis
changed, the plan must be **rebuilt**, which is owner-only — so a crew's
recovery path is to show the sentence and `can_build: false`, not to retry.

## 3b. `ns_load_day_summary` — the day's visits and readable vehicles

```
ns_load_day_summary(p_location_code text, p_work_date date) returns jsonb
```

Also returned inside `get_load_plan` as `day`, so a cold open is one round
trip. Same authorisation.

```json
{
  "work_date": "2027-06-01",
  "work_day_timezone":       "America/Edmonton" | null,
  "work_day_timezone_state": "configured" | "unconfigured",
  "window_starts_at": "2027-06-01T06:00:00+00:00",
  "window_ends_at":   "2027-06-02T06:00:00+00:00",
  "jobs": [
    { "job_id": "…", "assigned": true, "scheduled_for": "…",
      "property_id": "…", "customer_name": "…", "status": "scheduled" }
  ],
  "readable_vehicles": [
    { "location_id": "…", "code": "car_a", "name": "Car A", "kind": "vehicle" }
  ]
}
```

`assigned` **true** means an explicit `ns_job_vehicle_assignments` row;
**false** means unassigned and therefore this vehicle's by the one-crew rule
of §10. They are different facts and the field reports which.
`readable_vehicles` is what the caller may read at all — an owner sees every
active location, a crew sees Base and its own vehicle — so a screen's
vehicle picker comes from the backend rather than from a guess.

## 4. A plan line

```json
{
  "line_id": "…",
  "line_kind": "equipment" | "consumable" | "seasonal_set",
  "action": "keep" | "add" | "return",
  "material_id": "…" | null,
  "material_name": "…" | null,
  "rental_set_id": "…" | null,
  "set_code": "…" | null,
  "required_qty": 12, "aboard_qty": 0, "reserved_qty": 0,
  "available_qty": 500, "damaged_qty": 0, "shortage_qty": 0,
  "unit": "litre",
  "precision": "exact" | "estimated",
  "level_state": null | "empty" | "low" | "enough",
  "data_state": "complete" | "needs_review",
  "reason": "For Siding Soft Washing",
  "job_ids": ["…"],
  "manual_keep": false,
  "confirmed_operation": null
}
```

**Exactly one of `material_id` / `rental_set_id` is set** (CHECK constraint).

### The six quantities are six different questions

`required` what the day calls for · `aboard` what the ledger says is in this
vehicle · `reserved` what is already committed to specific jobs · `available`
what Base could supply · `damaged` present but unusable · `shortage`
`required` minus everything obtainable.

A single "needed" number hides every interesting case, which is why these
are not collapsed.

### Level-tracked supplies have NO number, ever

When `level_state` is set, **every quantity field is null** — enforced by a
CHECK constraint, not by convention. A level supply is reported as Empty /
Low / Enough and nothing else. Do not render `0` for a null quantity; render
the level.

### `data_state` is not the same as a shortage

* `shortage_qty > 0` with `data_state: "complete"` — we know we are short.
  A known gap.
* `data_state: "needs_review"` — the plan could not establish something:
  an unreviewed consumable allowance, a required consumable with no
  allowance recorded at all, or a set whose physical status disagrees with
  its assignment.

These are different problems and must be shown differently. The
`shortage_and_incomplete` fixture has one of each, side by side.

## 5. How the recommendations are derived

* **Equipment** — any material an `equipment` rule attaches to a service in
  play today, plus every `always_keep` rule regardless of the day, plus job
  `require` overrides, minus job `exclude` overrides (an `always_keep` item
  cannot be excluded). Aboard already → `keep`; otherwise → `add`.
* **Return** — `removable` equipment that is aboard and that nothing today
  needs. Narrow on purpose: never the standard tool kit (`always_keep`),
  never something a manual Keep holds. This is the no-bleach-day rule.
* **Consumables** — summed over the day's jobs as
  `quantity_fixed + quantity_per_unit × measured quantity`.
* **Baseline top-up** — `ns_vehicle_baselines` target minus what is aboard,
  as its own line with its own reason.
* **Seasonal sets** — assignments on today's jobs. `assigned` → `add` (load
  it); `installed` → `keep` with the reason that it is already up.

### Manual Keep survives regeneration

`ns_load_manual_keeps` is keyed by **(vehicle, date, material)**, not by
plan line. A rebuild re-reads it, so the thing the crew deliberately held
back does not reappear on the Return list. The kept item still gets a line —
as a `keep` with the operator's reason — rather than vanishing.

```
set_manual_keep(p_client_operation_id, p_location_code, p_work_date,
                p_material_id, p_keep default true, p_reason default null)
```

**Crew-level.** Holding a spare back is decided at the van with the kit in
hand. Scoped by `can_see_location`.

## 6. Plan revisions and stale confirmations

```
confirm_load_plan(p_client_operation_id   text,
                  p_plan_id               uuid,
                  p_expected_revision     integer,          -- REQUIRED
                  p_expected_fingerprint  text default null,
                  p_note                  text default null,
                  p_expected_lines_fingerprint text default null)  -- REQUIRED
```

**Crew-level**, scoped to vehicles the caller works from.

**Two of the three are required.** `p_expected_revision` and
`p_expected_lines_fingerprint` must be present: absent, the call is refused
with `22023` and a sentence saying so. They are defaulted in the signature
only because PostgreSQL will not otherwise let the parameter be added
(§ "What changed in v2.1"); a call that omits them does not succeed.

**Three checks, because they catch three different failures:**

1. **`revision`** catches "somebody rebuilt the plan". Refused with the
   current revision in the message.
2. **`basis_fingerprint`** catches "the schedule moved and nobody rebuilt
   it" — more dangerous, because the revision still matches and the plan
   still looks current. Recomputed live at confirmation and compared.
3. **`lines_fingerprint`** catches "what the plan asks for changed while you
   were looking at it" — see §6a. The revision and the basis both still
   match in that case, so neither of the first two can see it.

All three refuse with `23514` and a sentence. The `late_schedule_change`
fixture is check 2; `recommendation_lock` is check 3.

## 6a. The recommendation lock (NEW in v2.1)

A plan's **basis** is the day's schedule. Its **recommendation** is what the
lines say to do. Two operations change the second without touching the
first:

* a Manual Keep set or cleared (§7), and
* an owner-authorised `skip_required` or `carry_extra` (§7a).

So: the crew reads the plan ("return the bleach kit"), somebody else holds
it back or the owner authorises a departure, and the crew confirms the
screen it is still looking at. The revision matches. The basis matches. The
transfers posted are not the ones anybody agreed to.

```
ns_load_lines_fingerprint(p_plan_id uuid) -> text
```

Maintained by a trigger on `ns_load_plan_lines` — by trigger and not by each
writer, because the writers are the problem and a third one added later
would forget. Stored on `ns_load_plans.lines_fingerprint` and returned as
`lines_fingerprint` by `ns_load_plan_result`, so it appears in the
`build_load_plan` response, inside `get_load_plan`'s `plan`, and on the
`set_manual_keep` receipt.

**What it covers**, per line: the item (material or set), the `action`, the
`required_qty`, the `level_state`, the `data_state`, and whether a manual
keep holds it.

**What it deliberately ignores**: the `reason` wording and the six reporting
quantities. Re-wording a reason, or `available_qty` moving because Base took
a delivery, does not change what the crew must do — and a lock that fired on
those would train everyone to click through the refusal.

**Recovery** is the same shape as §3a's: call `get_load_plan` again, show
what it says now, and confirm that. The error sentence says which of the
three things moved.

### What confirming does

It posts **ordinary Batch 8.1 transfers** — Base → vehicle for an `add`,
vehicle → Base for a `return` — one per line, each under a suffixed
operation key (`<key>:<line_id>`) so a retry replays each leg rather than
moving stock twice. It does not invent a movement type and cannot be
mistaken for one.

**It does not transfer a seasonal set** (an asset the crew carries, not a
balance) **or a level-tracked supply** (no quantity to move). Those lines
come back with `confirmed_operation: null`.

Response: the plan, plus `transfers_posted`,
`lines_skipped_by_exception` (§7a) and `confirmed_lines_fingerprint`
(**v2.1** — what the confirmation was checked against, so the receipt is
self-describing).

## 7. Manual Keep — the crew's reversible override

```
set_manual_keep(
  p_client_operation_id text,
  p_location_code       text,
  p_work_date           date,
  p_material_id         uuid,
  p_keep                boolean default true,
  p_reason              text    default null) returns jsonb
```

**Any admin**, scoped. `p_keep: true` holds an item back that the plan would
have returned; `false` clears that.

**A manual keep never overwrites an owner-authorised set-aside (v2.1).** A
keep is "do not take it off the van"; a `skip` (§7a) is the owner saying "go
without it". Different decisions by different people, so a keep against a
line whose `action` is `skip` records the durable keep — it will apply to
the next build — and leaves the live line, its action and the
authorisation's wording exactly as the owner set them. `load-plan.js`
offers no keep control on such a line at all.

**Clearing is a real reversal, corrected in v2.** Setting a keep records
what the line recommended in `pre_keep_action`; clearing restores it. Before
v2, clearing deleted the durable keep but left the line reading `keep` with
the "Kept back on purpose" reason and `manual_keep: false` — a Keep nothing
had recommended, which confirmation then skipped. Rebuilding would have
corrected it, but building is owner-only, so a crew could not undo its own
keep at all.

### Receipt

```json
{
  "location_id":   "…",
  "location_code": "car_a",
  "work_date":     "2027-06-03",
  "material_id":   "…",
  "manual_keep":   true,
  "reason":        "rain tomorrow",
  "replayed":      false,
  "plan_id":           "…",
  "plan_revision":     1,
  "lines_fingerprint": "…",
  "line": {
    "line_id":         "…",
    "plan_id":         "…",
    "action":          "keep",
    "reason":          "Kept back on purpose: rain tomorrow",
    "manual_keep":     true,
    "pre_keep_action": "return"
  }
}
```

| field | type | null? |
|---|---|---|
| `reason` | text | **yes** — null when the caller sent none |
| `line` | object | **yes** — null when the day has no live plan. The durable keep is still recorded and will apply to the next build, which is a state the screen has to be able to show. |
| `line.pre_keep_action` | text | **yes** — null when the keep overrode nothing |
| `plan_id`, `plan_revision`, `lines_fingerprint` | **v2.1** | **yes** — all three null when the day has no live plan. The fingerprint is the plan's NEW value after this change, so the screen can confirm without a second read. §6a |

**Clearing restores a WHOLE-DAY recommendation**, not Return.
`pre_keep_action` is what `build_load_plan` derived from everything the day
needs, so an item another stop still needs comes back as `keep`/`add` and
only one that nothing needs comes back as `return`. Clearing a keep never
turns a line into `return` by itself. The remembered value is spent once
restored (`pre_keep_action` goes back to null). `keep_clear_whole_day` in
the fixtures is both cases side by side.

If the day's needs have *changed* since the plan was built, the basis
fingerprint has moved too, so §6's check 2 refuses the confirmation and the
plan must be rebuilt — the restore is never asked to invent a derivation it
does not have.

## 7a. Owner-authorised exceptions

```
authorise_load_exception(
  p_client_operation_id text,
  p_location_code       text,
  p_work_date           date,
  p_kind                text,                     -- skip_required | carry_extra
  p_reason              text,                     -- REQUIRED, not blank
  p_material_id         uuid    default null,
  p_rental_set_id       uuid    default null,
  p_quantity            numeric default null)     -- NEW in v2
  returns jsonb
```

**Owner only** — that is what "owner-authorised" means. Name either a
material or a set, not both and not neither. A blank reason is refused: an
exception without a reason is not an exception.

**What an exception now DOES, which is the whole of finding 6.** Before v2
the row was stored, linked to the plan line, and never read: confirmation
transferred the item anyway, so an authorised "go without it" loaded it
regardless, and an authorised extra could not be carried at all because
confirmation only walks plan lines.

| kind | effect on the plan | effect on confirmation |
|---|---|---|
| `skip_required` | the line's `action` becomes `skip`, `data_state` becomes `exception`, the reason names the authorisation, and `pre_keep_action` remembers what it was | the line is **not transferred** |
| `carry_extra`, item already on the plan | `required_qty` increases by `p_quantity` (unchanged if null), `data_state` becomes `exception` | the larger quantity is transferred |
| `carry_extra`, item **absent** from the plan | an `add` line is **created**, with `required_qty = p_quantity` and `data_state: 'exception'` | the extra is transferred |

`p_quantity` is **required** for a `carry_extra` of a quantity-tracked
material (`22023` otherwise): an authorisation with no amount is not
something a confirmation can act on. A set has no quantity and a
level-tracked supply has no number, so both are exempt. A `skip_required`
must **not** carry one (`22023`) — it sets the whole line aside, and a
partial departure is a separate authorisation.

A day with no live plan records the authorisation and reports
`lines_affected: 0` with a null `plan_id`; it applies to the next build.

### Receipt

```json
{
  "exception_id":   "…",
  "replayed":       false,
  "kind":           "skip_required",
  "reason":         "already a part jug on the van",
  "location_id":    "…",
  "location_code":  "car_a",
  "work_date":      "2027-06-10",
  "material_id":    "…",
  "rental_set_id":  null,
  "quantity":       null,
  "plan_id":        "…",
  "lines_affected": 1,
  "line_added":     false
}
```

`plan_id` is null when the day has no live plan. `material_id` and
`rental_set_id` are exactly one non-null. `line_added` is true only for the
`carry_extra`-absent case above.

**The linked exception is visible.** `ns_load_plan_result`'s line objects
now carry `exception_id` and `pre_keep_action`; before v2 the view had
`exception_id` and the serializer every mutation actually returns dropped
it, so a screen could not tell an authorised skip from an ordinary line.

## 8. End of day

```
reconcile_day_end(
  p_client_operation_id text,
  p_location_code       text,
  p_work_date           date,
  p_lines               jsonb,
  p_note                text default null) returns jsonb
```

**Any admin**, scoped. `p_lines` is an array of:

```json
{ "material_id": "…",
  "counted_qty": 18,            // OR "level_state": "low"
  "precision": "exact" | "estimated",
  "variance_reason": "damaged" | "lost" | "miscounted"
                   | "used_more" | "used_less" | "other",
  "note": "…" }
```

### What the count is counted against — stated, because getting it wrong was finding 5

**The count is of USABLE stock, compared against the LIVE ledger balance.**

* `ns_material_stock_by_location.on_hand` is the **usable** pool;
  `damaged_on_hand` is a separate one. A crew counts what is on the van and
  fit to use, so that is the figure the variance is taken against.
* It is read **live, at closing time** — never from the plan. §4's plan
  quantities are generation-time snapshots that exist to justify a
  recommendation; by the evening the van has been loaded from and worked
  out of, and validating a physical count against a morning snapshot would
  manufacture variances. The receipt names the basis as
  `variance_basis: "live_usable_on_hand"` so no client has to infer it.
* **Damaged items are RETAINED, not written off.** Reason `damaged`
  therefore means units moved from usable to damaged.

### What a variance posts

| reason | movements | effect |
|---|---|---|
| `damaged` | **two** `adjustment` movements: the variance on `condition: 'usable'`, and its negation on `condition: 'damaged'` | usable falls, damaged rises, **total on the van unchanged** |
| everything else | one `adjustment` movement on `condition: 'usable'` | usable moves to the counted figure |

**The bug this replaces.** The variance was computed against usable and then
posted with `condition = 'damaged'` whenever the reason was damaged. Ten
usable counted as eight left **usable at ten and damaged at minus two** —
both figures wrong and a pool driven negative. It is the same "condition
names a POOL, reason says WHY" mistake the 9.1 corrective fixed in
`scrap_offcut`.

A **positive** variance with reason `damaged` is refused (`23514`): damaged
stock reduces what is usable, so a surplus cannot be explained that way, and
guessing between "somebody found stock" and "the reason is wrong" is how a
pool goes negative in the first place.

### The rest of the rules, unchanged

* A **variance with no reason is refused** (`23514`) with a sentence before
  anything is written.
* A **level supply is counted as a level**: it updates `ns_material_levels`
  and posts **no movement at all**. Recording a number for it would be the
  invented quantity the roadmap forbids.
* Closing reconciles the day and closes the live plan. **A day can be
  closed without ever having been confirmed** — the crew went out, the work
  happened, and the counts are still worth having.

### Receipt

```json
{
  "reconciliation_id": "…",
  "location_id":   "…", "location_code": "car_a",
  "work_date":     "2027-06-08",
  "plan_id":       "…",
  "closed_at":     "…",
  "replayed":      false,
  "lines_counted": 3,
  "variance_basis": "live_usable_on_hand",
  "lines": [
    { "material_id": "…", "material_name": "…",
      "expected_qty": 10, "counted_qty": 8, "variance_qty": -2,
      "precision": "exact", "level_state": null,
      "variance_reason": "damaged" }
  ]
}
```

| field | type | null? |
|---|---|---|
| `plan_id` | uuid | **yes** — a day can be counted with no plan |
| `lines[].expected_qty` / `counted_qty` / `variance_qty` | numeric | **yes** on a level line |
| `lines[].level_state` | text | **yes** on a quantity line |
| `lines[].variance_reason` | text | **yes** when the variance was zero |

## 9. Owner and crew — the split the stock contract left open

Stock contract v1 §11 named this as unspecified. **Resolved, and enforced in
the backend:**

> **A crew records what physically happened and confirms what was asked.
> An owner decides what the business will do, and what the records mean.**

Within a location both can see (Base, the crew's own vehicle):

| a crew MAY | a crew MAY NOT |
|---|---|
| post movements (received, consumed, returned, damaged, adjustment) | change the catalogue — materials, suppliers, pack sizes |
| transfer between Base and its own vehicle | set vehicle baselines, service load rules, job overrides, vehicle assignments |
| reserve, release and consume reservations | open a sealed kit |
| record, use and scrap offcuts | review a kit sheet or a job material sheet |
| set and clear a manual Keep | commit stock to a job sheet |
| confirm a load plan for its own vehicle | **build** a load plan |
| reconcile the day | authorise a load exception |
| | assign, release or retire a seasonal set; register a new one |

A crew is still refused everything outside the locations it can see, exactly
as v1 specified. Nothing in v1's existing functions changed: what was
unspecified is now written down, and every function added since enforces it.

## 10. Vehicles

A vehicle is a row in `ns_stock_locations` with `kind = 'vehicle'`.
**Car B is optional data and is never seeded.** `batch10-1.test.mjs` G1
asserts that no migration creates a second vehicle.

Job → vehicle comes from `ns_job_vehicle_assignments`. When there is **one**
active vehicle, an unassigned job belongs to it — that is the business
today, and treating every job as unknown would make every plan empty. When
there are **two**, an unassigned job belongs to **neither** plan, is counted
in `unassigned_jobs`, and is named in the plan `note`. Guessing which car a
job is on is how a crew arrives without a washer.

## 11. Errors

| code | when |
|---|---|
| `42501` | not an admin; a crew attempting an owner-only call; a plan or location outside the caller's scope |
| `22023` | **v2.1:** a confirmation with no `p_expected_revision` or no `p_expected_lines_fingerprint`; blank operation key; no work date; a plan requested for Base; an exception with no reason or naming both a material and a set; a bad precision or level value; a count line with neither a quantity nor a level; **v2:** a `carry_extra` of a counted material with no quantity; a `skip_required` carrying one |
| `P0002` | no such location, plan, material or active base |
| `23514` | **v2.1:** a changed recommendation (`lines_fingerprint` mismatch); a stale revision; a changed schedule; a superseded plan; an unexplained variance; **v2:** confirming a closed day; a positive variance explained as `damaged` |
| `23505` | an operation key already used for a different payload (changed intent); **v2:** a key used for a different KIND of operation; a second confirmation of an already-confirmed plan under a different key |

`P0002` is PL/pgSQL's `no_data_found`, **not** the SQL-standard `02000`.

## 12. Replay and lost responses — per operation, as ENFORCED

v1 promised this generally and three of the four mutations did not do it.
Finding 3. What follows is what the SQL now does, operation by operation.

**The key ledger.** `ns_load_operations` holds one row per mutation:
`client_operation_id` (primary key), `kind`, `location_id`, `work_date`,
`intent_fingerprint`, `actor_id`, `created_at` and the **`receipt` it
returned**. It is a table of its own and not a column on each subject,
because `set_manual_keep` **deletes** its subject row when a keep is
cleared — a key recorded there would not survive the operation it was meant
to make replayable, which is exactly how a late retry used to re-apply a
cleared keep. `authenticated` has SELECT only, scoped to locations it can
see; every write goes through an RPC.

**The guard checks three things, in this order:**

1. **kind** — a key used for a `manual_keep` presented as a `reconciliation`
   raises `23505` naming both. A key belongs to the operation it was first
   used for.
2. **scope** — `can_see_location` on the location the key was *first used
   on*. Before intent, deliberately: a caller who cannot see that location
   is refused with `42501` and learns nothing about what the key was for.
   This is the disclosure path `reconcile_day_end` left open by returning
   its receipt before the check.
3. **intent** — `md5` over the canonical request. A retry whose payload
   differs raises `23505` rather than being answered with the first result,
   because the caller believes the second.

Only then is the **stored receipt** returned, with `replayed: true`. Not a
fresh derivation — the bytes the first call produced.

| operation | keyed | replay returns | changed payload | notes |
|---|---|---|---|---|
| `build_load_plan` | yes, since v1 | the same plan, no second revision | — | unchanged |
| `set_manual_keep` | **v2** | the stored receipt | `23505` | a late retry after the keep was cleared is a **replay**, and does not re-apply it |
| `authorise_load_exception` | **v2** (intent now compared) | the stored receipt | `23505` | — |
| `confirm_load_plan` | **v2** (was keyed on plan *status*) | the stored receipt, same `transfers_posted` | `23505` | a **different** key against an already-confirmed plan is a duplicate, not a retry: `23505`, "already confirmed". A stale revision on that path used to be answered with a cheerful replay. **v2.1:** a call with no revision or no lines fingerprint is `22023` before any of this; two callers racing the SAME key get one acceptance and one `23505`, with the stock moved once (`batch10-1.test.mjs` L8) |
| `reconcile_day_end` | **v2** (scope now checked first) | the stored receipt | `23505` | the count array is **sorted before hashing**, so two clients counting the same van in a different order are making the same request and the retry succeeds |

**What a lost response looks like from the client.** Resend the identical
request under the same key. You get the same receipt with `replayed: true`
and nothing happens twice. That is the only safe recovery, and it is now
true of all five operations rather than one.

## 13. Fixtures

`tests/fixtures/daily-load-v2.json`, **twenty** scenarios, generated by
`npm run fixtures:daily-load` from the real backend on a disposable
database. Every refusal in it is a real SQLSTATE from the real function.

The fourteen from v1:

`siding` · `no_bleach_day` · `no_bleach_day_with_manual_keep` ·
`mixed_services` · `permanent_lighting_with_offcut` · `named_christmas_set` ·
`winter_replenishment` · `repeated_jobs` · `car_b_assigned` ·
`car_a_with_unassigned_job` · `shortage_and_incomplete` ·
`late_schedule_change` · `crew_permission_failures` · `duplicate_retry`

And the six added in v2, one per finding:

`frozen_read_envelope` · `closed_day_is_readable` ·
`manual_keep_clear_restores_recommendation` · `per_operation_retries` ·
`damaged_variance_pools` · `exception_affects_confirmation`

`duplicate_retry` is kept and still exercises plan **building** only, which
was Codex's point about it; the four mutations are covered by
`per_operation_retries`.

Ids, timestamps and fingerprints are stable placeholders, so two runs on two
machines produce byte-identical files — verified by generating twice and
diffing. Regenerate after any contract change: the diff IS the change.

### What the fixtures do and do not prove

| | status |
|---|---|
| fixture rehearsal (disposable PostgreSQL) | **PASSED** — 19 pending migrations apply in filename order from a clean database |
| database suites | **PASSED** — `batch10-1` 67/67, including K1–K12, one per finding |
| browser suites | **PASSED** — `phase26` 24/24 against the v2 envelope |
| live Supabase compatibility | **UNRUN** |
| production verification | **UNRUN** |

## 14. Deliberately out of scope

* **The phone interface.** Batch 10.2 owns it. Nothing here renders
  anything, and no field, offline, navigation, native or outbox file was
  touched by 10.1.
* **Seasonal writes in the field outbox.** Still four write types; adding a
  fifth needs its own agreed scope, as the seasonal contract already says.
* **Routing, ETA or travel time.** A plan is a day's load, not a route.
* **Automatic purchasing.** `ns_next_day_suggestions` suggests and reserves,
  orders and moves nothing — it says so in its own payload.
* **Crew identity beyond `ns_crew_members`.** There is no shift, roster or
  working-hours model here.
* **Chemical dosages, supplier specifications and conversion factors.**
  Every allowance is owner-entered and starts `provisional`; nothing is
  derived from a product recipe, because none exists.
