# Nova Shield completion and evidence contract v1.1

**Status: frozen at v1.1.** A change to this document is a new version,
agreed before either side implements against it.

> **v1.1 (Batch 15.1) — the one change, and it is a narrowing.**
> `can_work_job(uuid)` no longer treats an **unassigned** job as every
> crew's once a **second vehicle is active**. It now reads the single
> crew-scope rule `ns_job_is_mine(uuid)`, which is 12.1's rule, so the two
> predicates can no longer disagree. **Nothing changes while one vehicle is
> active** — today's state — and the four guards that call it
> (`register_job_evidence`, `complete_job_with_evidence` twice,
> `propose_additional_work`) keep their signatures and their wording.
> With two vehicles, a crew resolves the ambiguity itself with
> `claim_job_for_vehicle` rather than being stranded: see
> `docs/dispatch-contract-v1.md` v1.1 §2a and `docs/batch15-1-findings.md`.
> **Known wording limitation:** those four guards still say "That job is
> assigned to a vehicle you are not on", which is the wrong sentence for a
> job assigned to nobody. `ns_assert_job_is_mine()` carries the right one
> for new code; the four were left alone deliberately — re-emitting a
> 400-line function body to change a sentence is a bigger risk to a release
> candidate than the sentence is.

This is the snapshot handed to both tracks. Neither side invents a
counterpart.

**Companion to, not a revision of,** `docs/operations-contract-v1.md` (stock,
v1.2), `docs/seasonal-sets-contract-v1.md` (v1.2) and
`docs/daily-load-contract-v1.md` (v1.1). Nothing in those moved. The three
places this one touches them are named in §9.

**Nothing here has been applied to the live database.** The migrations that
define it are written and tested against a disposable PostgreSQL only.

Defined by, in this order:

| # | migration | what it adds |
|---|---|---|
| 1 | `20261013090000_batch11_1_seasonal_corrective_round_two.sql` | the three open tails of the abedf0f review (seasonal; see that contract) |
| 2 | `20261013100000_batch11_1_completion_and_evidence.sql` | tables, views, guards, grants, the proposed policies |
| 3 | `20261013110000_batch11_1_completion_operations.sql` | the nine entry points |

Migrations 2 and 3 depend on 1 only for the seasonal fixes; they are
independent of each other in content but must be applied in filename order
because 3 replaces a trigger function 2 creates.

Proved by `tests/db/batch11-1.test.mjs` (59 checks) against a real
PostgreSQL, exercised from the UI side by `tests/phase27.test.mjs` (16
checks), and demonstrated by the fourteen scenarios in
`tests/fixtures/completion-evidence-v1.json`.

---

## 1. The hole this closes

Completion was a direct table write from the browser:

```js
// admin/js/lib/api.js, before Batch 11.1
update ns_jobs set status='completed', completed_at=now()
 where id=$1 and completed_at is null
```

`authenticated` holds UPDATE on `ns_jobs`, and every crew member is an
admin, so any of them could mark any job complete with no photograph, no
material count, no attribution beyond a timestamp, and no way to tell a
retry from a second completion. The status dropdown on the same screen could
set `status='completed'` directly and skip even that.

What replaces it is a **record**: who finished it, what it proved, what it
used, and what the rules were at the time. The job's own `status` and
`completed_at` become consequences of that record rather than the thing
anybody writes.

## 2. The four ideas, and the mistake each one prevents

**1. Unknown is not zero.** A service with no evidence policy reports
`required_count = NULL` and `state = 'unconfigured'`. A zero would read as
"nothing needed" and an unconfigured service would silently pass. Every
layer carries the distinction: the view, the RPC's response, and the screen,
which prints *Nobody has said*.

**2. A guess cannot block work.** Every policy this batch ships is
`spec_state = 'proposed'` and `enforcement = 'advisory'`, and a CHECK
constraint makes `blocking` legal only for an `owner_confirmed` row. The
proposals exist so the owner has something concrete to correct. Until the
owner confirms one, it reports a shortfall and refuses nothing — which is
also why turning this on does not stop the business on day one.

**3. The device's claim is not the server's fact.** `captured_at`, the
coordinates and the watermark text are what a phone said. `received_at`,
`registered_by` and `upload_verified` are what the server established. They
are different columns, and a dispute turns on the second group.

**4. History is appended to, never rewritten.** An accepted completion, the
evidence it rested on and the consumption attributed to it are append-only
at the trigger level, so a direct API or table path hits the same refusal
the RPC would give. A correction is a new row with a reason and a name on
it, linked to what it corrects.

## 3. Request shapes

Every entry point takes `p_client_operation_id` first, is `SECURITY
DEFINER`, and has its own authorisation guard. These signatures are what the
grants name; a change to any of them is a new signature and a new version of
this document.

```
set_evidence_policy(
  p_client_operation_id text,
  p_service_key         text,                     -- services.key, case-insensitive
  p_requirement         text,
  p_min_count           integer default 1,
  p_coverage            text    default 'per_job',
  p_requires_geotag     boolean default false,
  p_enforcement         text    default 'advisory',
  p_note                text    default null)

retire_evidence_policy(p_client_operation_id text, p_service_key text,
                       p_requirement text)

register_job_evidence(
  p_client_operation_id text,
  p_job_id              uuid,
  p_attachment_id       uuid,                     -- NOT a storage path
  p_requirement         text,
  p_service_key         text        default null, -- null = covers the job
  p_captured_at         timestamptz default null,
  p_capture_time_state  text        default null, -- only 'unreliable' is read
  p_captured_lat        numeric     default null,
  p_captured_lon        numeric     default null,
  p_captured_accuracy_m numeric     default null,
  p_gps_state           text        default null, -- 'unavailable' | 'denied'
  p_client_watermark    text        default null,
  p_source              text        default 'field_console')

authorise_evidence_exception(
  p_client_operation_id text,
  p_job_id              uuid,
  p_reason              text,                     -- REQUIRED, not blank
  p_requirement         text default null,        -- null = all requirements
  p_service_key         text default null)        -- null = all services

complete_job_with_evidence(
  p_client_operation_id text,
  p_job_id              uuid,
  p_job_lock_version    integer,                  -- REQUIRED, no default
  p_policy_version      integer,                  -- REQUIRED, no default
  p_work_finished_at    timestamptz default null, -- null = 'unknown', not now()
  p_consumption         jsonb       default '[]'::jsonb,
  p_additional_work     jsonb       default '[]'::jsonb,
  p_note                text        default null)

reopen_job_completion(p_client_operation_id text, p_completion_id uuid,
                      p_reason text)

correct_job_consumption(
  p_client_operation_id text,
  p_completion_id       uuid,
  p_material_id         uuid,
  p_reason              text,                     -- REQUIRED, not blank
  p_quantity            numeric default null,     -- SIGNED, see §8
  p_level               text    default null,
  p_location_code       text    default 'base',
  p_count_precision     text    default 'exact',
  p_corrects            uuid    default null)

propose_additional_work(p_client_operation_id text, p_job_id uuid,
                        p_description text, p_note text default null)

decide_change_order(
  p_client_operation_id text,
  p_change_order_id     uuid,
  p_decision            text,                     -- 'approved' | 'declined'
  p_amount              numeric default null,     -- REQUIRED to approve
  p_reason              text    default null)
```

A required SQL argument means **no default**, not NOT NULL. Null target ids
fail their lookups with `P0002`; a null or blank `p_client_operation_id` is
rejected with `22023`.

### `p_consumption` elements

```json
{
  "material_id":     "uuid",            // required
  "location_code":   "car_a",           // optional, default 'base'
  "quantity":        12.5,              // quantity-tracked materials only
  "level":           "low",             // level-tracked materials only
  "count_precision": "estimated",       // optional, default 'exact'
  "reservation_id":  "uuid"             // optional; otherwise matched by job
}
```

`quantity` and `level` are **mutually exclusive and jointly required**, and
which one applies is decided by `ns_materials.tracking_mode`, not by the
caller. A quantity for a level-tracked supply raises `22023`, and so does a
level with no value. `level` is one of `full | part | low | empty`.

### `p_additional_work` elements

```json
{ "description": "Second storey windows need doing" }
```

No amount, on purpose. Completion never prices anything.

## 4. Idempotency, staleness and conflict

### The retry key

The caller supplies `p_client_operation_id`, generated **before** the
request and reused on retry: the server never saw the first attempt, so only
the caller can say "this is that same act". The key lives on
`ns_job_completions.client_operation_id` (unique), on
`ns_evidence_exceptions`, on `ns_job_completion_corrections` and on
`ns_change_orders`.

### What a replay checks before it returns anything

Same discipline as the corrected seasonal guard, and for the same reason:

1. **Authorisation first.** `can_work_job` is evaluated on the *stored*
   completion's job before anything is returned. A replay is not a way past
   a scope check.
2. **The key belongs to its job.** Presenting a key against a different job
   raises `23505`, naming both.
3. **The intent must match.** `intent_fingerprint` is `md5` over the job,
   the finish time, the consumption list, the additional-work list and the
   note. A retry whose payload differs raises `23505` rather than being
   answered with the first result — because the caller believes the second.

The consumption and additional-work arrays are **sorted before hashing**, so
two clients that build the same lines in a different order are making the
same request and the retry succeeds.

### Stale state

| check | error | meaning |
|---|---|---|
| `p_job_lock_version <> ns_jobs.lock_version` | `55000` | somebody else moved the job; re-read it and send again |
| `p_policy_version <> ns_evidence_policy_version()` | `55000` | the rules changed under you; re-read the requirements and send again |

Both are `object_not_in_prerequisite_state`, with different sentences so a
client can tell a human which happened. **A refused call writes nothing.**

`ns_jobs.lock_version` is an integer, default 1, bumped by trigger on every
UPDATE that changes anything else. `ns_evidence_policy_version()` is
`max(policy_version)` over active policies, and every policy write bumps it.

### Lost responses

A lost response is the retry case: resend the identical request under the
same key. The second call returns `"replayed": true` with the same
completion and creates no second event. This is scenario
`same_key_retry_lost_response` in the fixtures.

### A second completion under a *different* key

Not a retry — a duplicate. Raises `23505` naming the existing acceptance.
`ns_job_completions` has a unique index on `(job_id,
supersedes_corrections)`, so "one accepted completion at a time" is a
database rule rather than a convention, while a job that was reopened can
still be completed again.

## 5. Response shape

Every call that acts on a completion returns `ns_completion_receipt(...)`:

```json
{
  "replayed": false,

  "completion": {
    "completion_id": "…", "job_id": "…",
    "accepted_at": "2027-05-04T17:22:11Z", "accepted_by": "…",
    "work_finished_at": "2027-05-04T16:30:00Z",
    "work_finished_state": "reported",
    "policy_version": 3, "job_lock_version": 4,
    "evidence_state": "advisory_short", "evidence_count": 2,
    "evidence_snapshot": [ … ], "consumption_snapshot": [ … ],
    "advisory_shortfalls": [ … ],
    "supersedes_corrections": 0, "note": null
  },

  "job":             { "job_id": "…", "status": "completed",
                       "completed_at": "…", "lock_version": 5 },
  "readiness":       { … ns_job_evidence_readiness row … },
  "corrections":     [ … ],
  "additional_work": [ … ]
}
```

### Is an accepted receipt immutable, or current state?

**Both, and the response says which is which.**

* `completion` is the **frozen record**, exactly as written. The table
  refuses UPDATE and DELETE outright, and a replay returns the same bytes.
  The one exception is named in the trigger: the four snapshot columns are
  filled in by `complete_job_with_evidence` microseconds after the insert,
  inside the same transaction, before anything could have read them — and
  every field that identifies the acceptance is compared and must be
  unchanged for that write to pass.
* `job`, `readiness`, `corrections` and `additional_work` are **current
  state** and will have moved on.

A client that wants the receipt reads `completion`. A client that wants to
know where things stand reads the rest. Caching `completion` is safe;
caching the rest is not.

`evidence_state` is one of `satisfied | advisory_short | unconfigured`.
Never `blocked`: a blocked completion raises and writes nothing.

## 6. Evidence requirements, and reading them

`public.ns_job_evidence_requirements` is one row per (job, service on the
job, requirement). `public.ns_job_evidence_readiness` is the job-level
rollup. Both are `security_invoker = on`.

| column | type | null? | meaning |
|---|---|---|---|
| `required_count` | integer | **yes** | NULL means no policy. Never 0. |
| `satisfied_count` | integer | no | verified evidence that counts for this requirement |
| `coverage` | text | yes | `per_job` or `per_service_scope` |
| `requires_geotag` | boolean | yes | if true, only `gps_state='device_reported'` evidence counts |
| `enforcement` | text | no | `advisory` (coalesced) or `blocking` |
| `spec_state` | text | no | `proposed`, `owner_confirmed`, or `unconfigured` |
| `state` | text | no | `satisfied` \| `short` \| `excepted` \| `unconfigured` |

Readiness adds `blocking_shortfalls`, `advisory_shortfalls`,
`unconfigured_services text[]`, `policy_version`, `lock_version`,
`latest_completion_id`, `completion_open`, and one word:

```
evidence_state  blocked | unconfigured | advisory_short | satisfied
```

**One image, several scopes.** A `per_job` requirement accepts evidence
registered against the job *or* against any service; a `per_service_scope`
requirement wants that service named. Both read the same rows, so a
photograph that genuinely covers two scopes is registered twice and counts
twice without being uploaded twice. The unique index is on `(attachment_id,
requirement, coalesce(service_id, …))`, so the same scope cannot be claimed
twice by one file.

**Evidence that counts towards nothing** is still kept and shown. A
job-scoped photograph does not satisfy a per-service-scope requirement, and
without saying so the file would be registered, attributed, stored and
invisible — and filed again.

## 7. What `register_job_evidence` checks

| check | failure | why |
|---|---|---|
| the attachment exists | `P0002` | a guessed id is not evidence |
| it belongs to **this** job | `22023` | somebody else's photo is not proof of this visit |
| it has a non-blank `storage_path` and `size_bytes > 0` | `23514` | a row created before the upload finished proves nothing |
| `can_work_job(p_job_id)` | `42501` | cross-car write |

It takes an **attachment id, never a path**: a caller that could name a path
could name one it had not uploaded.

The capture states are **derived, not declared**: a caller that could send
`capture_time_state='device_reported'` with no timestamp would be making the
state a claim too. `unreliable` keeps the state and drops the value — a time
nobody trusts is not a time. Coordinates are stored only when both are
present, and `gps_state` is then `device_reported`; otherwise the caller's
`unavailable` or `denied` is kept, or it reads `unknown`.

**GPS does not block anything by default.** `requires_geotag` is proposed
false on every seeded policy, including the winter check: a crew in a
basement or a steel garage has no GPS through no fault of its own. Whether
the winter visit should require one is the open business question in §13.
When a policy does require it, the route past it is an exception.

## 8. Consumption, corrections and the no-double-debit rule

`complete_job_with_evidence` resolves each consumption line in this order:

1. **The job's reservation is still held** → `consume_stock_reservation`
   closes it and posts one `consumed` movement. A quantity larger than the
   reservation posts the excess as its own movement; a smaller one leaves
   the remainder unreserved, which the stock contract already does.
2. **The reservation was already consumed** → the line points at *that*
   operation and **posts nothing**. This is the double debit the brief
   names: the stock already moved, and posting again would take it off the
   shelf twice.
3. **There was never a reservation** → one `consumed` movement is posted.

Every posted operation is then verified with `ns_verify_stock_operation` —
the same provenance proof the corrected seasonal build and strip make.

**Levels are observations.** A level-tracked supply records `full | part |
low | empty` and posts **no movement**, because the ledger is quantitative
and a level in it would be averaged into a number. The day-end
reconciliation owns the level itself.

### Corrections

Owner only. A correction **appends**; the original line stands as what the
crew reported.

```
p_quantity is the SIGNED CHANGE TO THE CONSUMPTION RECORD
  -3   "we reported three litres more than we used"
  +3   "we used three litres we never wrote down"
```

The **ledger moves the other way**: over-reporting means three litres are
still on the shelf, so the adjustment is `+3`. It is posted with reason
`adjustment` — the ledger's own escape hatch, the only reason that may go
either way — and never as a second `consumed`, because the first one is
history.

### Reopening

Owner only, reason required. The reopen is a row in
`ns_job_completion_corrections`; the completion record is untouched. The
job returns to `in_progress` with `completed_at` cleared, and exactly one
more completion becomes possible, recorded as `supersedes_corrections = 1`.

### Late consumption

Inserting a consumption line for a job that is accepted-and-not-reopened
raises `42501` unless it is a correction. That is the trigger
`ns_job_consumptions_not_late`, so the direct table path hits it too.

## 9. Where this meets the other three contracts

* **Stock (`operations-contract-v1.md`, v1.2)** — unchanged. This contract
  calls `post_stock_movement`, `consume_stock_reservation` and
  `ns_verify_stock_operation` and replaces none of them. The `consumed` and
  `adjustment` reasons, the sign rules and the `exact/estimated` distinction
  are theirs.
* **Seasonal (`seasonal-sets-contract-v1.md`, v1.2)** — untouched by this
  batch's completion work. The round-two corrective in migration 1 belongs
  to that contract and is documented there.
* **Daily load (`daily-load-contract-v1.md`, v1.1)** — wire-compatible and
  unchanged. 11.1 adds `move_seasonal_set` and `ns_seasonal_sets_aboard`
  beside it; no existing plan, line, exception or reconciliation shape
  moved. **Day-end reconciliation is not job completion**: it posts
  `adjustment` movements with `job_id = null`, writes no
  `ns_job_consumptions`, completes nothing and freezes nothing. Asserted by
  `batch11-1.test.mjs` J1.

## 10. Authorisation

| call | who |
|---|---|
| `register_job_evidence` | any admin, scoped by `can_work_job` |
| `complete_job_with_evidence` | any admin, scoped by `can_work_job` |
| `propose_additional_work` | any admin, scoped by `can_work_job` |
| `set_evidence_policy` | **owner only** |
| `retire_evidence_policy` | **owner only** |
| `authorise_evidence_exception` | **owner only** |
| `reopen_job_completion` | **owner only** |
| `correct_job_consumption` | **owner only** |
| `decide_change_order` | **owner only** |

`can_work_job(job_id)` is `is_admin()` AND (owner OR the job has no explicit
vehicle assignment the caller cannot see). That is the same rule Batch 10.1
uses for a day plan, **including its decision that an unassigned job belongs
to whoever is working** — one crew today.

**The lockdown that makes this real.** `authenticated` holds SELECT and
nothing else on `ns_evidence_policies`, `ns_job_evidence`,
`ns_evidence_exceptions`, `ns_job_completions`, `ns_job_consumptions` and
`ns_job_completion_corrections`, and INSERT/UPDATE/DELETE are revoked on
`ns_change_orders`. `anon` holds no EXECUTE on any of the nine functions.
The migration asserts all of this before it finishes.

**`ns_jobs` is guarded by a TRIGGER, not by column grants.** The repository
has no base schema, so nobody here can enumerate `ns_jobs`' columns to
re-grant them after a revoke — and a trigger needs no list, fires for every
role including the table owner, and cannot be walked around with a second
statement. It refuses `status='completed'` without an open accepted
completion, refuses a `completed_at` the caller chose, and refuses clearing
one without a reopen. **Every other status transition is untouched**:
scheduled, in_progress, invoiced, paid and closed all still work.

## 11. Errors

| code | condition | when |
|---|---|---|
| `42501` | insufficient_privilege | not an admin; a crew on an owner-only call; a job assigned to another vehicle — **including on a replay**; any direct write to frozen history; a direct `status='completed'` |
| `22023` | invalid_parameter_value | blank `client_operation_id`; blank reason; a quantity for a level-tracked material or a level for a quantity-tracked one; an attachment belonging to another job; an approval with no amount; an unknown decision |
| `P0002` | no_data_found | no such job, attachment, service, material, completion, change order or active location |
| `23505` | unique_violation | a key presented against a different job or completion; a changed payload under an existing key; a second completion of an already-accepted job; a `:res:`/`:use:` operation that does not contain the movement it was depended on for |
| `23514` | check_violation | a blocking requirement not met; an attachment with no stored file; a decision on an already-decided change order; `completed_at` set to a time with no receipt behind it |
| `55000` | object_not_in_prerequisite_state | stale job version; stale policy version |

`P0002` is PL/pgSQL's `no_data_found`, **not** the SQL-standard `02000`.
Same note as the other three contracts, for the same reason: a client
matching on `02000` will never match.

## 12. Fixtures, and what they do and do not prove

`tests/fixtures/completion-evidence-v1.json`, generated by
`npm run fixtures:completion` from the real backend on a disposable
database. Fourteen scenarios, covering the eleven the brief names:

| scenario | covers |
|---|---|
| `cleaning_before_and_after` | cleaning |
| `one_image_two_scopes` | one file, several scopes |
| `lighting_installation_and_component` | lighting |
| `quick_winter_proof` | the configurable winter proof |
| `missing_metadata_and_evidence` | missing metadata, missing evidence, and the three registration refusals |
| `denied_access` | denied access, cross-car replay |
| `stale_policy_and_job` | stale policy, stale job |
| `same_key_retry_lost_response` | same-key retry, lost response |
| `changed_intent_same_key` | changed intent |
| `locked_history` | locked history |
| `reasoned_correction` | reasoned correction, reopen |
| `additional_work_and_quote_protection` | quote protection |
| `unconfigured_is_not_satisfied` | unknown is not zero |
| `authorised_exception` | the attributed exception |

Every refusal in the file is a real SQLSTATE from the real function, not a
mock. The file is deterministic: ids, timestamps and fingerprints are
replaced with stable placeholders, and two runs produce byte-identical
output.

**What is NOT proved, stated separately as the brief requires:**

| | status |
|---|---|
| fixture rehearsal (disposable PostgreSQL) | **PASSED** — 18 pending migrations apply in filename order from a clean disposable database |
| database suites | **PASSED** — `batch11-1` 59/59, five others unchanged |
| browser suites | **PASSED** — `phase27` 16/16, mocked api.js |
| live Supabase compatibility | **UNRUN** |
| production verification | **UNRUN** |

The shapes of `ns_jobs`, `job_attachments`, `ns_quotes` and
`ns_change_orders` used by these tests come from
`tests/db/fixture-schema-batch11-1.sql`, which is **derived from the admin
code, not probed against Supabase** (the repository still has no base
schema — `docs/batch7-1-findings.md`, finding 4b). Everything the migrations
do to those four tables is an `add column if not exists`, a trigger, or an
introspecting DO block for exactly that reason. The live project's column
lists, its `ns_change_orders` status vocabulary and its Storage objects are
the three places a live apply could still surprise us, and §13 names them.

## 13. Open business questions — assumptions, not confirmed rules

Every policy in migration 2 is `spec_state = 'proposed'`. They need the
owner's answer, and none of them is a rule until they get it:

1. **Does the quick winter check need a device location?** Proposed `false`.
   This is the one the owner most needs to answer.
2. **Is one photograph enough?** `min_count` is 1 everywhere. Nobody has
   said whether a long elevation needs two.
3. **Is the cleaning before/after pair per service or per job?** Proposed
   per service scope.
4. **Which requirements should BLOCK rather than advise?** None does today.
5. **Is a lighting component shot once per job or once per run?** Proposed
   once per job.

Two more, outside policy:

6. **`ns_change_orders` status vocabulary.** This contract writes
   `'proposed'` and keeps `pending | approved | declined`. The live table's
   existing CHECK is dropped by introspection and replaced; if live uses a
   value not in that list, the migration will fail on apply, loudly, which
   is the right failure. It cannot be verified from here.
7. **Storage verification.** `upload_verified` is established from the
   attachment row (non-blank path, `size_bytes > 0`), which is as far as a
   database can see. A live deployment should additionally confirm the
   object exists in the `job-photos` bucket. Named, not guessed at.

## 14. Deliberately out of scope in this version

* **No mobile persistence and no outbox handler.** Offline work finished is
  provisional until the evidence arrives and the server accepts it; this
  document defines the operation that acceptance goes through, and Batch
  11.2 owns the client. Rejection leaves the client's evidence and drafts
  untouched — nothing here deletes an attachment, and a refused completion
  writes nothing at all, so a retry under the same key after the problem is
  fixed is safe.
* **No field completion screen, gesture flow, dictation, camera redesign or
  watermark UI.** The admin surface added here is the minimum that makes the
  backend usable: the owner's policy table in Settings and the job screen's
  evidence panel.
* **No pricing in the browser.** `propose_additional_work` takes no amount;
  `decide_change_order` is owner-only and sets the figure server-side in the
  same transaction as the approval.
* **No fleet behaviour.** One crew, a second possible. Car B is not seeded.
* **No supplier specifications, chemical dosages or pack conversions.** The
  component requirement proves what was used; it does not certify that it
  was correct, because the permanent-lighting contract's `spec_state` says
  those specifications are still unknown.
