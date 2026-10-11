# Batch 10.2 — contract readiness after offline recovery

Codex owns the phone preparation/closing interface. The maintained scope is
in [the roadmap](batch-plan-after-7.md#102-codex-crew-keepaddreturn-and-end-day-interaction).
Batch 9.2 supplies bounded offline job reads and the existing four-type outbox;
it does not add stock writes or a second queue.

## Verified starting point

Read-only review of Claude's `claude/batch-8-1` at
`abedf0f6e3eb1fda2fd336c5dd34186f8340b4b0` confirms that
`docs/operations-contract-v1.md` now documents reservations, releases,
consumption, owner/crew location scoping, litres/kilograms/sticks/levels,
and usable/damaged and exact/estimated movements. The API passes both new
movement parameters and exposes reservation operations. Base and Car A are
seeded; Car B remains optional data. Reservations reduce availability without
physically moving stock; level-tracked supplies have no numerical quantity.

These are source observations, not independently reproduced database results.
Claude reports 132 database checks and 63 browser checks. The document says
its migrations remain unapplied to the live database. No Claude code is
imported here, and Codex's completed 9.2 remains independent.

The three earlier stock-document issues were corrected in `19b3c86`: section
8 is reconciled, all five migrations are listed, and section 4b specifies
reservation/release signatures, results, enforced rules and errors. Section
10b is a non-normative changelog. A repeated release succeeds; releasing an
already-consumed reservation errors. Location RPCs use **codes**, not IDs.

There is still no daily load response or schedule-version confirmation
operation. Claude's 9.1 now supplies seasonal-set identity, assignment,
recovery and release. [The independent review](../reviews/seasonal-contract-abedf0f.md)
records source issues for Claude, including scoped replay and accounting,
and why an assignment cannot establish that a set is physically loaded.
10.1 still needs to supply the load contract for 10.2. No seasonal writes
were added to the field outbox.

The following is an integration checklist, **not an invented RPC contract**.
The route must stay unavailable until a real adapter and its frozen contract
exist. UI-only fixtures do not establish authorization or stock correctness.

## Inputs the load contract must define

1. A stable vehicle/location code, work date and authoritative plan/revision ID,
   including whether Car B is available. The interface must not seed Car B,
   infer crew membership or present stock belonging to another vehicle.
2. Display-ready Keep/Add/Return rows and reason/job references, with required,
   aboard, reserved, available and shortage quantities distinguished. Include
   operating units, exact/estimated and usable/damaged counts, named seasonal
   sets and incomplete-data/Needs review states. Codex will not calculate these
   authoritative recommendations from service names or quote quantities.
3. Authorized visit summaries with addresses, access notes and service needs.
   A mixed day must explain why shared tools stay aboard; a no-bleach day may
   suggest returning removable bleach tools while preserving manual Keep.
   Siding includes the washer/soft-wash kit. Each car has its own day.
4. The exact supported confirmation, manual Keep, authorized exception,
   consumption and closing operations, including permissions and unit rules.
   Reservation, issued stock and actual consumption must not be counted twice.
   Confirming a recommendation must not masquerade as a physical transfer.
5. Server enforcement of the plan revision at confirmation. A late schedule
   change returns a typed stale/conflict response and current revision; it
   cannot silently apply an obsolete load list. Specify offline expiry too.
6. Immutable retry payloads, operation IDs and accepted/replayed receipts.
   Define lost-response lookup/retry behavior, validation failures and
   conflicts. Retries must not add stock twice. Existing movement replay IDs
   alone do not define how a load revision or reservation is validated.
7. A versioned fixture set for siding, no-bleach, mixed services, lighting,
   winter replenishment, repeated jobs, Car B and late schedule changes, with
   permission, shortage and lost-response examples.

Once supplied, Codex can implement against injected adapters on its own branch
without waiting for a backend merge or changing `api.js`. 10.2-prep now supplies
the explicit local **v1/v2 → v3** upgrade: unchanged queue records plus schema
and lifecycle stores. The latter has queued/accepted/conflict/needs-review
state vocabulary, unused by current handlers. Future action types fit the
existing queue envelope without another store migration; their handler,
payload validation, authorization and receipt rules still require the contract.
Ownerless v1 rows remain quarantined; v2-owned rows drain after upgrade.
Unknown/downgrade versions preserve unsent work and refuse opening.

The local `/load` entry point is disabled before online and cached routing;
measurement exit saves still run first. Ten scenario wrappers live in
`tests/fixtures/load-contract/`; reading any contract examples throws an
explicit TODO. They define file layout, not a backend wire shape.

Acceptance will include 390/430px touch and keyboard use, interruption/restart,
separate vehicle state and duplicate replay prevention. Android physical
storage/device checks and cross-track integration remain separate from mocked
browser acceptance. No live database change, merge or deployment is implied.

## Migration integration checkpoint

Before a live application window, rehearse the complete pending sequence in
timestamp order against a disposable Supabase-compatible database, including
the Batch 5 content freeze, both Batch 7.1 grant migrations and all five Batch
8.1 migrations and both 9.1 seasonal migrations. Claude reports ten pending
migrations and a clean disposable rehearsal at `abedf0f`; Codex has not
independently rerun that rehearsal or queried live migration state.
Individual fixture tests do not establish that the sequence
works with the existing schema, Supabase auth/storage objects and grants.
Record applied versions, final function signatures, privileges and trigger
state; run owner/crew/anonymous and replay/transfer/reservation checks against
the resulting schema. Keep disposable rehearsal, live application and
production verification separately reported. This checklist does not
authorize applying migrations to the live project.
