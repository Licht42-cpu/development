# Integration corrective — inventory creation and admin selection persistence

Owner: Claude · Branch `claude/batch-8-1`

- **Base SHA:** `9b64b23` (`Add the Batch 15.2 assignment prompt for Codex`),
  verified with `git rev-parse HEAD` before any edit. The tree was clean.
- **Final SHA:** see the commit this document arrives in.
- **Source of the observations:** Codex's integrated candidate,
  `codex/integration-candidate@52510c3`, `docs/integration-candidate.md`.
  That snapshot was READ ONLY. Nothing was merged, rebased or cherry-picked
  from it, and no file of Codex's was edited.

This is a focused corrective, not a batch and not a release. No migration was
written, applied or changed; **all 31 migrations remain written-to-disk and
unapplied to the live project**. No production data, grant or setting was
touched, no customer message was sent, nothing was merged, deployed or
published.

---

## 1. Dispositions

Codex's findings concern Claude-owned files that its candidate imported
unchanged from `f08edfd`. Each was re-checked against this branch's head
first, because a finding against an imported copy is only still a finding if
the original still has it.

| # | Codex's observation | Still present at `9b64b23`? | Disposition |
|---|---|---|---|
| 1 | Inventory creation offers only six units and no level tracking (`inventory.js:61`, `:684`) | **Yes**, reproduced | **Fixed** — §2 |
| 2 | A literal `null` under the customer link (`property.js:461`) | **Yes**, reproduced | **Fixed** — §3 |
| 3 | The admin Daily load panel is mounted with no selection context; its selectors tell nobody, so a reload loses the vehicle and day (`inventory.js:1190`, `load-plan.js:79`) | **Yes**, reproduced | **Fixed** — §4 |
| 4 | Job-view difference preserved on purpose; do not replace wholesale | n/a | **Not touched.** No file under `admin/js/views/job.js` was edited by this corrective. |
| 5 | Car B authorization mismatch | Already answered | **Closed by Batch 15.1 at `5169d7b`** (`ns_job_crew_scope`, `claim_job_for_vehicle`, owner-only `assign_job_to_vehicle`). Nothing further here. |

One **new** finding came out of the work and is fixed with it — §5.

---

## 2. Finding 1 — the supported inventory types are now creatable

### What was wrong

`admin/js/views/inventory.js` carried its own unit list:

```js
const UNITS = ['each', 'linear_ft', 'box', 'roll', 'kit', 'set'];
```

while three other places already knew nine units plus level tracking:

- the constraint `ns_materials_unit_known`, which accepts `each, linear_ft,
  box, roll, kit, set, litre, kilogram, stick, level`
  (`supabase/migrations/20261010140000_batch8_1_reservations_units_and_crew_access.sql:38`);
- `admin/js/lib/inventory-units.js`, which has the labels for all of them;
- every screen that READS a material — stock rows, the load plan, the job
  materials sheet — each of which renders litres, kilograms, sticks and
  levels correctly.

So bulk chemicals, de-icer and channel sticks were visible everywhere and
creatable nowhere, and a level-tracked supply could not be created at all.
The form also never sent `tracking_mode`, so every part it made was
`quantity` by the column default.

### What it now does

The form asks **one** question — counted or level — and derives the unit from
it. That is deliberate, not cosmetic: the database states the relationship as

```sql
constraint ns_materials_level_unit_agrees check ((tracking_mode = 'level') = (unit = 'level'))
```

so the two halves cannot be chosen independently. A form that offered
`level` as a tenth unit beside the nine real ones would have made the one
combination that constraint exists to refuse the easiest one to produce.
`level` is therefore **not** in the unit list; it is what choosing level
tracking means.

- **Counted** — unit from all nine (`Each`, `Linear feet (ft)`, `Boxes`,
  `Rolls`, `Kits`, `Sets`, `Litres (L)`, `Kilograms (kg)`,
  `Channel sticks`), plus pack size, unit cost and reorder point.
- **Checked as a level** — Empty / Low / Enough per location, with no unit
  control, no pack size, no reorder point and nothing to reserve. The screen
  says so in words rather than just hiding the fields.

Switching between the modes **resets** the controls it removes rather than
hiding them with their values intact. Nothing in the database stops
`reorder_point = 100` on a level material; the Stock tab correctly declines
to display it; the figure would simply sit in the row forever meaning
nothing. Resetting is the honest half of the switch. A level material is sent
with `pack_quantity: 1` — the column is `not null` with a `> 0` check, so 1
is the identity for a conversion that never runs, which is the nearest thing
to "not applicable" the schema can hold — and `reorder_point: 0`.

**Unknown cost stays unknown.** A blank cost is sent as `null`, never `0`, in
both modes.

**No level observation is invented at creation time.** A level is somebody's
observation, with a time and a name on it; creating the catalogue row is not
that observation. A new level-tracked supply reads **"Not checked"** until
someone actually looks at a shelf, exactly as a new counted part has no
opening count until an `opening` movement is posted. The form says this.

**Nothing was invented.** No supplier pack size, chemical strength, dosage or
conversion appears anywhere in this change; the units come from the existing
constraint and the existing label module.

Files: `admin/js/lib/inventory-units.js` (new `MATERIAL_UNIT_CHOICES`,
`TRACKING_MODES`, `LEVEL_UNIT`), `admin/js/views/inventory.js`
(`newMaterialCard`). The local list is gone — the comment left in its place
records why having it was the bug.

---

## 3. Finding 2 — the visible `null` is gone

`admin/js/views/property.js` built the page with `clear(mount).append(...)`.
`append()` is the DOM's own method, not `el()`'s children handling:

- `el()` **skips** a `null` child (`shared/dom.js:22`);
- `Element.append()` **stringifies** it.

So `customer ? null : el('div', …)` — the card that explains a property whose
customer record was deleted — printed the word `null` under the customer link
on every property that HAS a customer, which is nearly all of them.

Fixed locally by passing the children as an array and filtering it before the
spread. **`shared/dom.js` is unchanged**; the helper was never at fault.

Covered both ways: a property with a customer (no stray text node anywhere in
the mount, and the `← FIXTURE customer` link still present) and a property
without one (the explanation card still shown, the back link falling back to
`← All customers`).

---

## 4. Finding 3 — selection hooks for the admin load panel

### The interface

```js
loadPlanPanel({ locationCode, workDate, onSelectionChange })
```

| Argument | Meaning |
|---|---|
| `locationCode` | Which vehicle to open on. Default `'car_a'`, unchanged. Passed through **unvalidated** — which vehicles exist is the backend's answer, not a view's. |
| `workDate` | The calendar date to open on, `'YYYY-MM-DD'`. Anything that is not a real date is ignored in favour of today, which is the pre-existing default. |
| `onSelectionChange` | Optional. Called as `({ locationCode, workDate })` on each **valid** change, after the panel has adopted it. |

Guarantees, each one tested:

- **Not called on mount.** A default is not a choice somebody made, and a
  caller that recorded one would write a URL nobody asked for.
- **Not called for an invalid or unchanged selection.** Re-picking the same
  day, clearing the date, or typing something unparseable report nothing —
  and a cleared date puts the input back to the day the panel is showing,
  rather than leaving a plan screen with no day to ask the backend about.
- **A throwing caller cannot take the panel down.** The panel adopts the
  selection and reloads first, then announces; a listener that throws is
  logged and swallowed.
- **Existing callers are unaffected.** `loadPlanPanel()` with no arguments is
  still Car A, today, and silent.
- **The backend's work-day timezone stays authoritative.** `work_date` is
  passed through as a bare calendar date and nothing here converts it; the
  operating day it stands for is resolved server-side from the owner's
  timezone setting, and the panel's existing notice still reports when that
  setting is missing (`docs/daily-load-contract-v1.md` v2.1 §2a).

### The wiring Codex needs

`admin/js/views/inventory.js` already does this for the `#/inventory?tab=load`
route, as the reference implementation:

```js
loadPlanPanel({
  locationCode: params.get('car') || undefined,   // undefined => the panel's default
  workDate:     params.get('day') || undefined,
  onSelectionChange: ({ locationCode, workDate }) => {
    // record it, then let the panel repaint itself -- do not re-render
    replaceQuery(`tab=load&car=${encodeURIComponent(locationCode)}&day=${encodeURIComponent(workDate)}`);
  }
});
```

Three points for any other caller:

1. **`replaceQuery`, not a hash assignment.** A selection must not put a
   history entry between the operator and Android Back — the same rule the
   inventory tabs and the jobs filters already follow.
2. **Do not re-render on the callback.** The panel repaints itself;
   re-mounting it would discard the load it has just started.
3. **Pass `undefined`, not `''`,** for an absent parameter, so the panel's own
   defaults apply.

**Car B is treated as optional data throughout.** Nothing in this change
seeds it, activates it, or creates a location, movement or transfer. A URL
naming `car_b` on a project that has never had one asks the backend about
`car_b` and says on screen that it is not a known vehicle (§5).

Files: `admin/js/components/load-plan.js`, `admin/js/views/inventory.js`.
Codex-owned route registration and `admin/js/main.js` are untouched.

---

## 5. New finding (found and fixed here) — an unknown vehicle code displayed as a different vehicle

Writing the test for §4 turned up a defect neither track had reported. A
`<select>` handed a value that none of its options carries falls back to the
**first option**. The panel built its options from the vehicle list and its
`{ value: code, label: code }` fallback only when that list was *empty*. So a
URL naming a vehicle the backend does not know — exactly the Car B case —
requested the right van (`code` kept its value, and the plan read was
correct) while the control displayed **Car A's name above Car B's plan**.

Fixed in `vehicleOptions()`: an unknown code is listed as itself, marked
`(not a known vehicle)`, and stays selected. It is still not seeded or
created anywhere.

---

## 6. Verification

Every number below is a count of **distinct cases**, not of executions.

### Browser (mocked `api.js`, Playwright + Chromium) — PASSED

| Suite | Result |
|---|---|
| `tests/phase30.test.mjs` (new, this corrective) | **22/22 passed** |
| `tests/phase23.test.mjs` (Batch 8.1 inventory) | 55/55 passed |
| `tests/phase26.test.mjs` (Batch 10.1 daily load) | 29/29 passed |
| `tests/phase20.test.mjs` (Batch 4 property passport) | 24/24 passed |
| `tests/phase22, 24, 25, 27, 28, 29` | 18, 37, 25, 16, 30, 40 passed |
| `tests/run-regression.sh` set, run suite by suite (`phase2`–`phase21`, `geofence`, `native-wrapper`, `reload-offline`) | all passed |

**0 failed · 0 skipped · 0 expected failures declared.**

`tests/phase30.test.mjs` is registered in `tests/run-admin-suites.sh`, which
is where the admin suites run until the agreed integration change moves them.
**`tests/run-regression.sh` was not edited** — it is Codex's at integration.

### Fail-without-fix

With the four source files stashed and the suite unchanged, **16 of 22 cases
fail**, including `C1 a property with a customer does not print the word
"null"`. The 6 that pass without the fix are the preserved-behaviour cases
(the default caller, no-call-on-mount, the throwing listener, the
customer-deleted card, the customer link, and the invalid-date fallback),
which is what they are for.

### Visual and keyboard QA — PASSED, with one pre-existing observation

`node tests/screenshot-integration-corrective.mjs` renders six screens
(creation form counted, creation form level, load tab with a known vehicle,
load tab with an unknown one, property with and without a customer) at
**390 / 430 / 1280** and checks what a screenshot hides.

- **No horizontal overflow at any width**, on any of the six.
- **No focusable control without an accessible name.**
- **No positive `tabindex`**, so the tab order is the reading order.
- Keyboard traversal of the creation form, counted:
  `Part name → SKU → Category → Tracked by → Supplier → Counted in → Pack
  size → Unit cost → Reorder point → Add part`; level:
  `Part name → SKU → Category → Tracked by → Supplier → Unit cost → Add
  part`. The controls level tracking removes are removed from the tab order
  too, not merely hidden.
- **Pre-existing, not introduced:** the small-button family (`btn btn--sm`:
  the tab buttons, the Empty/Low/Enough buttons, `Movements`, `Commit`,
  `Post movement`, `Build the plan`) and the `← customer` back links sit
  under the 44px tap target at every width. None of these is a control this
  corrective added or changed, and every control it DID add clears 44px.
  Raising the shared button size is a design-system change across every
  admin screen, so it is reported here rather than made inside a corrective.

### Not run

Distinct from everything above, and not implied by it:

- **Disposable database: UNRUN.** No SQL changed, so there was nothing to
  rehearse. The constraint quoted in §2 was read from the migration file,
  not executed.
- **Live Supabase: UNRUN.** By instruction.
- **Physical device: UNRUN.** No handset. The 16 handset cases from 13.2
  remain unverified.
- **Native build / emulator / provider sandbox / payment: UNRUN.** Out of
  scope for an admin-console corrective.

A green browser suite is not a verified backend, and none of the 31 pending
migrations has been applied, so nothing here says what the live project would
accept from these forms.

---

## 7. Still open

Carried forward, not addressed here:

- The 31 pending migrations are unapplied. `docs/release-runbook-v1.md` is
  the authority for applying them.
- Batch 7.1's unidentified inbound foreign key (a live-only query).
- Five unset `app_settings` rows, including the operating-day timezone the
  load panel's notice reports.
- Two missing workers: the notification sender and the document signer.
- The four Batch 11.1 guard messages (wording, deferred).
- Codex's 16 physical-device cases.
- Batch 14 remains conditional and unauthorised.
- The shared 44px tap-target question in §6.
