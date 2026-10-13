# Batch 12.2 (Codex): field map, property instructions and dispatch actions

## Where to start

Branch from your own 11.2 head. **Base: `codex/batch-11-2@ae1efdd`** (which
was based on `abf1743`). Work on a new `codex/batch-12-2` branch.

**Do not merge or rebase `claude/batch-8-1`.** Read Claude's artefacts from
GitHub at the SHA below; do not import them into your branch.

Claude's 12.1 is complete and pushed: **`claude/batch-8-1@b21d082`**. Read, in
this order:

1. `docs/dispatch-contract-v1.md` — **frozen v1**, 14 sections. This is the
   contract you implement against. §3 is the one supported read, §6 property
   access and zones, §7 the five states, §8 the two customer messages, §10 the
   one additive field pair and the one new refusal against 10.2's load
   contract, **§14 what you own and what you must not assume**.
2. `tests/fixtures/dispatch-v1.json` — **nine authoritative scenarios**,
   generated from the real backend by `npm run fixtures:dispatch` and verified
   byte-identical across two clean rebuilds. Render against these, not against
   hand-written shapes.
3. `docs/batch12-1-findings.md` — the decisions worth arguing with, the
   defects 12.1 found in its own work, and the five remaining decisions that
   are stated rather than defaulted (including: no `arrived` state exists in
   the backend; the operating timezone and the SMS provider are both unset).

Your 10.2 handoff (`tests/field-load.md`) and 11.2 handoff
(`tests/field-completion.md`) were read, not imported. 10.2's load contract
survives 12.1 unchanged except for the one additive field pair and the one new
refusal named in §10 — the load read, the recommendation lock, the four-way
refusal/conflict/no-response/acceptance distinction and the online-only load
writes all behave exactly as they did.

**Nothing has been applied anywhere.** Twenty-four migrations are pending in
filename order and none has been applied to the live project. Your work must
not require one to have been applied.

---

## The unassigned-job permission difference you flagged — Claude's, not yours

You were right to flag it, and it is **Claude's to reconcile before a second
crew is enabled**. Do not design around it and do not work it yourself.

The rule as shipped, in `ns_can_see_property(uuid)` and `ns_can_work_job(uuid)`:
a crew may see a property's working details, and may work a job, when the job
is assigned to the vehicle it crews — **or** when the job is unassigned *and
exactly one vehicle is active*, by the same one-vehicle default
`ns_vehicle_day_jobs` already uses. With **two** active vehicles an unassigned
job counts for neither crew, because nobody has said which car is going.

The consequence, stated plainly: **activating Car B silently narrows what a
Car A crew can see and do** — the same unassigned job that was readable
yesterday raises `42501` today. That is a backend decision (does an unassigned
job belong to every crew, to none, or must dispatch assign it before a crew can
act?), so it is in Claude's lane. Claude will resolve it in a later batch
before a second crew is enabled.

What this means for 12.2: **build for the authorisation the backend actually
reports**, never for what you assume it should be. A `42501` on a property or a
job is a state your UI must render honestly — "not yours to open" — not an
error to swallow, retry, or route around with a cached copy from an earlier
read. Do not cache a property's working details past a denial. Report in your
handoff how the screen behaves in both the one-vehicle and the two-vehicle
case; do not change the rule.

---

## Goal

Find the entrance and the work area, and report an issue quickly, from the job.

Carry today's ordered route into the field console, add a navigation handoff,
property pins and supported work-zone overlays, and surface the critical notes
in an accessible sheet. Add the blocked-access and breakdown actions and
crew-confirmed arrival. Store coordinates and zones for offline use even when
a basemap is unavailable. Decide the supported Maps SDK integration and the
offline-map provider capability **from actual verified requirements**.

### What to build

1. **Today's ordered route in the field console.** From §3's single read. The
   order is the owner's, by hand — there is no routing, no travel time, no
   distance and no sequencing suggestion, so do not display one or imply one.
   A `stale` stop position is reported as stale by the backend and must read
   as stale on the screen, not be quietly re-sorted.
2. **Navigation handoff.** Hand the destination to the device's own navigation.
   **Distinguish navigation availability from cached data** — a pin you can
   draw is not a route you can drive, and a crew needs to know which it has.
3. **Property pins and work-zone overlays.** Zones carry a declared coordinate
   `space` (§6): `geographic` is real lat/lng, `image` is 0..1 fractions of a
   **named** image. Render each in its own space; never render an `image` zone
   as geography. `source` is `owner_drawn` and nothing else — the drawing must
   not present itself as surveyed.
4. **The access sheet, accessible.** Entrance, hazards and parking are separate
   sentences and must stay separate on screen. `internal_note` and
   `access_code` have **no column grant at all** — the only read path is
   `get_property_access()`. `customer_note` is the only customer-facing field.
   Treat the access code as a key: do not log it, do not put it in an error
   message, do not persist it anywhere a later reader can find it.
5. **Blocked access and breakdown actions.** `report_job_issue` /
   `resolve_job_issue` per §7, with attribution, reason and resolution. A crew
   may **not** clear its own `blocked` — returning a stop to `planned` is the
   owner's (findings §3). Render that as not-yours, not as a disabled mystery.
6. **Crew-confirmed arrival.** There is **no `arrived` state in the backend**
   and §14 says defining one is yours, under your own contract. Whatever you
   define: a confirmed arrival is a **deliberate crew action**. An incorrect,
   missing or denied location must not fake one.
7. **Offline coordinates and zones.** Notes, pins and zones work offline.
   **Every dispatch mutation in §14 requires a connection and a server-checked
   version** — whether any of them earns a queued outbox type is your decision
   under your own contract, not something 12.1 assumed. If you queue one, it
   gets the same honest provisional status and same-key recovery your 10.2 and
   11.2 outbox types have.
8. **The Maps SDK and offline-provider decision.** Decide it from verified
   support and write the decision down with its evidence. **No promise of
   cached Google satellite imagery without verified support.** 12.1 added no
   map dependency to any package file and made no basemap, licensing or
   provider promise (§14) — if you add a dependency, the licence and the
   offline capability are part of the decision record.

### Acceptance

* An incorrect, missing or denied location **does not fake arrival**.
* Notes work offline.
* Route and issue updates have **pending and error** states, distinct from each
  other and from success.
* Zone and pin actions are **accessible** — keyboard-reachable and operable, as
  12.1's zone editor is (number inputs with Add/Remove, deliberately no drag
  handle and no canvas; the pointer canvas is yours if you want one, and it may
  not be the only way in).
* The UI **distinguishes navigation availability from cached data**.
* **No background tracking** and **no new sign or mower service** in this pair.
* **No geofence.** A zone is a drawing; nothing triggers on entering one, and
  GPS proximity is not arrival.
* Nothing sends a customer message on opening a screen, on a route change or on
  a location reading. The two messages in §8 are deliberate crew actions, the
  SMS provider is unset so both return `unavailable` with that reason, and a
  crew cannot record an outcome for its own message.

---

## Boundaries

* **File ownership stays split.** Codex-owned field and mobile files are
  yours. **Do not edit Claude-owned files**: `admin/**`,
  `supabase/migrations/**`, `docs/dispatch-contract-v1.md`,
  `docs/daily-load-contract-v1.md`, `docs/batch12-1-findings.md`,
  `tests/db/**`, `tests/phase2*.test.mjs`, `tests/fixtures/dispatch-v1.json`
  and its generator. **Do not edit `tests/run-regression.sh`.**
* **No live migration, no grant, data or settings change, no merge, no rebase
  of another agent's branch, no deployment, no publication.**
* **No real customer messages.** Provider doubles only.
* **Pricing stays in the backend.**
* **Invent nothing.** No supplier specifications, chemical dosages, pack
  conversions, renewal cutoffs, snowfall thresholds, forecast sources, visit
  allowances, salt dosages — nor the missing Permanent Lighting Phase D
  document. An unset input is reported `unconfigured`, not guessed.
* If a contract shape does not fit what the field needs, **report it as a
  finding**; do not fork the shape. A change to a frozen contract is a new
  version, agreed before either side implements against it.

## Reporting

Commit and push to `codex/batch-12-2`, and write the handoff into your branch.
In it:

* Keep **passed, failed, skipped, expected-failure and UNRUN distinct**, with
  counts. An expected failure is declared in advance as a fault injection, not
  relabelled after the fact.
* Keep **browser, database, device and production/live-integration outcomes
  distinct**. A local or mocked result is not live readiness; do not let one
  stand in for another.
* State the **Maps SDK and offline-map decision** with the evidence that
  supports it, and say explicitly what is *not* supported.
* State how the screen behaves on a `42501` in both the one-vehicle and the
  two-vehicle case, per the permission difference above.
* Report any drift you find in `docs/dispatch-contract-v1.md` or
  `tests/fixtures/dispatch-v1.json` against the backend — 10.2 found a real one
  in the load contract's §13 and it was fixed.
* Confirm Claude-owned files are untouched and that no migration was applied.

**Stop after 12.2.** Do not start 13.1, 13.2 or an integration/deployment
batch.
