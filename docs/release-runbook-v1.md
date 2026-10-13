# Nova Shield backend release runbook v1

**This is a plan, not a release.** Every step below is written to be read
before it is run. Applying it to the live project, changing live grants or
data, merging the tracks, deploying and publishing an APK all require the
owner's separate explicit instruction, and none of them has been done.

**State at the time of writing:** **31 migrations pending**, none applied
anywhere. Evidence:
[`docs/release/pending-migration-audit.md`](release/pending-migration-audit.md)
(generated), `docs/batch15-1-findings.md` (the review),
`tests/db/batch15-1.test.mjs` (64 checks, including the rollbacks this
runbook promises).

---

## 0. Before you touch anything

### 0.1 Confirm what the project thinks is applied

```sql
-- Read-only. The runbook assumes everything after this version is pending.
select version, name
  from supabase_migrations.schema_migrations
 order by version desc
 limit 5;
```

The last applied version must be **`20261009013557`**. If it is anything
else, **stop**: the ordered list in §2 was computed from that assumption and
has to be recomputed.

### 0.2 Resolve Batch 7.1's open blocker

`docs/batch7-1-findings.md` §3 recorded **one unidentified foreign key still
pointing at a legacy table** — the query naming it was refused by the tooling
gate three times and it has never been run. It does not block this
application (a privilege or additive change cannot violate a foreign key) but
it blocks any retirement decision, and it should be answered while somebody
is looking at the database anyway:

```sql
-- Read-only.
select conrelid::regclass as from_table,
       confrelid::regclass as to_table,
       conname,
       pg_get_constraintdef(oid) as def
  from pg_constraint
 where confrelid in ('public.job_requests'::regclass,
                     'public.jobs'::regclass,
                     'public.quotes'::regclass);
```

### 0.3 Take a backup you have actually restored from

Not a snapshot you assume exists. The first four steps below are **not
reversible by a counter-migration** (§3), so the backup is the rollback.

### 0.4 Know what these migrations cannot know

The repository has **no base schema**
(`docs/batch7-1-findings.md` 4b). Sixteen tables exist only in the live
project, and the local rehearsal reproduces only the columns the migrations
name. The audit's "Live-only tables each file touches" section lists, per
file, exactly which ones — and whether that file introspects with
`to_regclass` first. **Every unexplained failure during application will be
in that column.**

---

## 1. What is in the chain

| group | files | what it does |
|---|---|---|
| Batch 5 freeze | 1 | freezes customer-facing quote content once sent |
| Batch 7.1 | 2 | tightens admin RPC grants; revokes anon **writes** on three legacy tables |
| Batch 8.1 | 5 | inventory, rental sets, stock operations, reservations |
| Batch 9.1 | 5 | seasonal set identity and operations, permanent lighting, kits |
| Batch 10.1 | 4 | load planning and operations, plus two correctives |
| Batch 11.1 | 3 | seasonal corrective, completion and evidence, completion operations |
| Batch 12.1 | 4 | dispatch day and order, property access and zones, issues and notifications, conflicts and winter |
| Batch 13.1 | 4 | customer reports, customer access, report delivery, payment boundary |
| **Batch 15.1** | **3** | **crew-scope reconciliation, trigger-grant hygiene, RLS on the handover tables** |

Per-file objects, destructive statements and re-runnability: the audit's
first table. **All 31 are re-runnable** — verified by applying each one twice
in sequence on a clean disposable database and checking that no policy or
trigger stacked.

---

## 2. The ordered application

Apply **in filename order**, which is what Supabase does. The groups below
are stop points, not transactions: each file is its own transaction, so a
failure leaves the chain half-applied at a file boundary and §3 tells you
what that means.

### Group A — the freeze and the grants (3 files)

```
20261009160000_batch5_freeze_customer_facing_content_once_sent.sql
20261010090000_batch7_1_tighten_remaining_admin_rpc_grants.sql
20261010091000_batch7_1_revoke_anon_writes_on_legacy_tables.sql
```

**This is the riskiest group**, and it is first because filename order puts
it there. It is the only group that changes behaviour on data that already
exists:

* the freeze adds triggers that **refuse** edits to customer-facing content
  on a quote that has already been sent. Anything in the office that edits a
  sent quote's notes or terms stops working, by design.
* the 7.1 grant files **revoke** privileges. 7.1 revokes from `anon` **and**
  from `PUBLIC`, and then verifies the outcome, because a grant to PUBLIC
  survives an `anon`-only revoke. If `anon` still holds a write afterwards it
  arrives through **role membership**, and the migration raises rather than
  pretending it succeeded.

**Verify before continuing:**

```sql
select has_table_privilege('anon','public.job_requests','insert') as a,
       has_table_privilege('anon','public.jobs','insert')         as b,
       has_table_privilege('anon','public.quotes','insert')       as c;
-- all three must be false
select tgname from pg_trigger
 where tgrelid='public.ns_quotes'::regclass and not tgisinternal;
-- the freeze trigger must be listed
```

**Stop condition:** if 7.1 raises its role-membership error, do not continue.
Find the role (`select roleid::regrole from pg_auth_members where member =
'anon'::regrole`) and decide what to do about it; the rest of the chain does
not depend on this file, but leaving a half-understood grant is how a release
goes wrong quietly.

### Group B — inventory and seasonal (10 files)

```
20261010120000 … 20261010141000   (Batch 8.1, 5 files)
20261011090000 … 20261011101000   (Batch 9.1, 4 files)
20261012090000_batch9_1_corrective_seasonal_review.sql
```

Additive: new tables, views, functions, policies. Nothing here revokes
anything a person uses, and no existing row changes meaning.

**Verify:** `tests/db/batch8-1` (132) and `tests/db/batch9-1` (83) +
`batch9-1-lighting` (55) pass against a disposable database built the same
way. On the live project, check the stock view answers:

```sql
select count(*) from public.ns_material_stock_by_location;
-- a row per material × active location; 0 means the cross join found no
-- locations, which means the seed below has not run
select code, name, kind, active from public.ns_stock_locations order by sort_order;
```

**Expect Base and Car A only.** Car B must stay **inactive** until the owner
decides to run a second crew — see §5.

### Group C — load planning (2 files + 2 correctives)

```
20261011110000_batch10_1_load_planning.sql
20261011111000_batch10_1_load_operations.sql
20261014090000_batch10_1_corrective_load_contract.sql
20261015090000_batch10_1_corrective_day_boundary_and_lock.sql
```

The second corrective **drops the 5-argument `confirm_load_plan` and creates
a 6-argument one** (PostgreSQL cannot add a defaulted parameter beside
existing defaulted ones with `create or replace` — 42P13). Between the drop
and the create, that function does not exist.

**This is the narrowest window in the chain.** It is inside one file and
therefore one transaction, so an interrupted apply rolls back rather than
leaving the function missing — but a client calling the 5-argument form after
this file lands gets "function does not exist" until it is updated.
`admin/js/lib/api.js` already sends the 6-argument form.

**Verify:**

```sql
select p.oid::regprocedure::text
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname='confirm_load_plan';
-- exactly ONE row, with six arguments
```

### Group D — completion and evidence (3 files)

```
20261013090000_batch11_1_seasonal_corrective_round_two.sql
20261013100000_batch11_1_completion_and_evidence.sql
20261013110000_batch11_1_completion_operations.sql
```

Installs **`ns_jobs_completion_gate`** on `ns_jobs`. After this, `status =
'completed'` can only be reached through `complete_job_with_evidence`.
**Anything that sets that column directly stops working** — that is the
point, and it is the single most behaviour-changing trigger in the chain.

**Verify, and check existing data:**

```sql
select tgname from pg_trigger
 where tgrelid='public.ns_jobs'::regclass and tgname='ns_jobs_completion_gate';

-- Jobs already marked completed have no completion record. The gate allows
-- them to stay as they are; it governs CHANGES. Count them so nobody is
-- surprised later by a job that is complete with no evidence.
select count(*) from public.ns_jobs j
 where j.status='completed'
   and not exists (select 1 from public.ns_job_completions c where c.job_id=j.id);
```

**Stop condition:** if that count is large and the office still needs to edit
those jobs, decide the backfill policy **before** continuing. The gate does
not rewrite history, but it will refuse the next edit to it.

### Group E — dispatch (4 files)

```
20261016090000 … 20261016120000   (Batch 12.1)
```

Additive, plus `ns_load_plans.invalidated_at` / `invalidated_reason` and a
fourth refusal in `confirm_load_plan`. Creates `ns_property_access` with
`access_code` and `internal_note` **ungranted at column level** — the grant
is issued by revoking the table `SELECT` and then granting the named columns,
because a column `REVOKE` against a table-level grant does nothing in
PostgreSQL.

**Verify:**

```sql
select has_column_privilege('authenticated','public.ns_property_access','access_code','select')   as code,
       has_column_privilege('authenticated','public.ns_property_access','internal_note','select') as note,
       has_column_privilege('authenticated','public.ns_property_access','entrance_note','select') as entrance;
-- code false, note false, entrance TRUE
```

### Group F — customer handover (4 files)

```
20261017090000 … 20261017120000   (Batch 13.1)
```

Additive. Creates the seven handover tables, the capability machinery and the
payment boundary. **Three functions become anon-callable** — that is
deliberate and is the customer's only route:

```sql
select p.oid::regprocedure::text
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and has_function_privilege('anon', p.oid, 'execute')
 order by 1;
```

After the whole chain this must return **exactly four**:
`get_customer_report(text,uuid)`, `is_admin()`,
`list_customer_documents(text)`, `request_customer_document(text,uuid,uuid)`.
Anything else is a defect. (`is_admin()` must stay — see §4.2.)

### Group G — the release correctives (3 files, Batch 15.1)

```
20261018090000_batch15_1_crew_scope_reconciliation.sql
20261018100000_batch15_1_revoke_public_execute_on_trigger_functions.sql
20261018110000_batch15_1_rls_on_handover_tables.sql
```

1. **The crew-scope reconciliation.** `can_work_job` and `ns_can_work_job`
   become one rule, and a crew gains `claim_job_for_vehicle`.
   **No behaviour changes while only one vehicle is active**, which is the
   state Group B leaves the project in. See §5 before activating a second.
2. **Trigger-grant hygiene.** Revokes `EXECUTE` from `PUBLIC`, `anon` and
   `authenticated` on every trigger function. Proven not to stop a trigger
   firing: PostgreSQL checks that privilege when the trigger is **created**.
3. **RLS on the handover tables.** Closes a hole Batch 13.1 shipped — seven
   tables with a `SELECT` grant to `authenticated` and no policy, which in
   Supabase means any signed-in user, not an admin.

**Verify:**

```sql
-- One rule, two names.
select p.proname,
       pg_get_functiondef(p.oid) like '%ns_job_is_mine%' as reads_shared_rule
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('can_work_job','ns_can_work_job');
-- both must be true

-- No trigger function callable by a session role.
select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.prorettype='pg_catalog.trigger'::regtype
   and (has_function_privilege('anon', p.oid, 'execute')
        or has_function_privilege('authenticated', p.oid, 'execute'));
-- must be 0

-- Every handover table contained.
select c.relname, c.relrowsecurity,
       (select count(*) from pg_policy p where p.polrelid=c.oid) as policies
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname in (
   'ns_completion_reports','ns_evidence_publications','ns_handover_operations',
   'ns_customer_grants','ns_customer_grant_reads','ns_document_access_tickets',
   'ns_report_deliveries','ns_payment_requests')
 order by 1;
-- relrowsecurity true and policies = 1, for all eight
```

---

## 3. Recovery, per step, honestly

**Each file is its own transaction.** A failure rolls that file back and
leaves every earlier file applied. So "recovery" means one of three things,
and which one depends on the group.

| group | reversible by a counter-migration? | what to do if it fails or must be undone |
|---|---|---|
| A — freeze and grants | **No.** | The freeze's triggers can be dropped, and the revoked grants can be re-granted — but you would be restoring a state somebody decided was wrong, and the 7.1 files verify their own outcome. **Restore from backup** rather than hand-reversing, and do not continue the chain. |
| B — inventory and seasonal | **Partly.** | The tables are new and empty, so dropping them is clean *if nothing has written to them yet*. Once stock has been received, a drop destroys the ledger. **Before first use: drop is safe. After first use: restore from backup.** |
| C — load planning | **Partly**, with one trap. | Same as B, plus `confirm_load_plan`: reverting corrective 2 means recreating the 5-argument form, and `admin/js/lib/api.js` now sends six. Revert the client first or the screen breaks. |
| D — completion and evidence | **No.** | Dropping `ns_jobs_completion_gate` restores direct status writes, but any completion already accepted leaves rows the rest of the chain reads. **Restore from backup.** |
| E — dispatch | **Partly.** | New tables plus two added columns on `ns_load_plans`. Dropping the columns is reversible only if no plan has been invalidated yet. |
| F — customer handover | **Partly.** | New tables. **But once a customer link has been issued, revoking is not dropping**: dropping `ns_customer_grants` would silently stop every issued link working. Revoke the grants first (`revoke_customer_grant`), tell the customers, then drop. |
| G1 — crew scope | **Deliberately no rollback offered.** | Putting 11.1's laxer rule back would re-open the two-car ambiguity this closed. The forward fix is always available: assign the job, or let the crew claim it. `tests/db/batch15-1.test.mjs` F3 asserts the reconciliation stays in place so nobody adds a rollback without reading this. |
| G2 — trigger grants | **Yes, and rehearsed.** | `grant execute on function <sig> to public` for each trigger function restores the previous state. Proven in `batch15-1` F2, including that re-applying the migration afterwards is clean. |
| G3 — RLS on handover tables | **Yes, and rehearsed.** | `alter table <t> disable row level security` for the eight tables. Proven in `batch15-1` F1, including that re-applying restores exactly one policy per table rather than stacking. |

### If the chain stops half-way

1. **Note the last file that succeeded.** Supabase records it; so does the
   error message.
2. **Do not skip the failed file.** Later files assume it: the audit's
   per-file "creates" column shows what the next file expects to find.
3. **Every file is re-runnable** (verified, all 31), so after fixing the
   cause you re-run from the failed file onward, not from the beginning.
4. If the cause is a live-only column no fixture reproduced — the most likely
   failure — the fix is a one-line additive migration **appended to the
   chain**, never an edit to a file that has already been applied somewhere.

---

## 4. Decisions this release needs from the owner

### 4.1 The three legacy tables keep their anon SELECT

`job_requests`, `jobs` and `quotes` are readable by `anon` today. Batch 7.1
§3 scoped itself to anonymous **writes** on purpose and wrote down why:
"removing a read is the more likely of the two to surprise something
undiscovered." It also recorded that all three hold **0 rows**, have no
dependent views, and are referenced nowhere in `admin/`, `site/`, `shared/`
or `supabase/`.

**This runbook does not revoke that read**, because reversing a documented
decision inside a release-preparation batch is not its business, and because
the retirement decision is still blocked on the foreign key in §0.2.

**The owner's decision:** with the FK identified and the tables still empty,
revoke anon `SELECT` as a separate, clearly-named migration — or retire the
tables entirely. Either is a batch, not a step in this runbook.

### 4.2 `is_admin()` stays anon-executable

It looks like a finding and is not one. RLS policies are evaluated as the
**session** role, so revoking it would turn every anon-facing policy that
mentions `is_admin()` into an error instead of a `false`. It returns false
for `anon` and leaks nothing. Migration G2 asserts it is still reachable.

### 4.3 The five settings rows nothing can work without

| key | field | until it is set |
|---|---|---|
| `operations` | `work_day_timezone` | a day is counted midnight-to-midnight **UTC**, and the load and dispatch screens say so |
| `notifications` | `sms_provider` | every text is `unavailable` with that reason |
| `payments` | `provider` | every payment request is `unavailable` |
| `customer_portal` | `link_expiry_days` | every customer link needs an explicit expiry passed per link |
| `quote_defaults` | `currency` | a report shows a figure with **no currency**, labelled `unconfigured` |

None is invented by any migration. All five are one `app_settings` row each.

### 4.4 The two missing workers

Neither the notification sender nor the document-signing worker exists in
this repository (`supabase/functions` holds `submit-request` only). Until
they do:

* a queued `notifications` row is a message **nobody has sent**, and
  `ns_report_deliveries.delivery_state` stays `accepted`;
* a customer can be authorised for a photograph and still not download it —
  `request_customer_document` returns `signing_state: 'requires_worker'`.

Applying the chain does not change either, and no screen claims otherwise.

---

## 5. Before a second crew is enabled

This is the one sequencing rule in the release that is not about migrations.

Activating Car B changes who may do what:

* an **unassigned** job stops being any crew's. Before Batch 15.1, dispatch,
  the load plan, customer messages and customer reports already excluded it
  while completion still allowed it — which is the mismatch the review
  closed.
* after 15.1 both rules agree, and the crew's route is
  `claim_job_for_vehicle` ("this one is on my car"), reachable from the
  dispatch screen.

**So, in order:**

1. Apply the whole chain, including Group G.
2. Confirm the admin dispatch screen offers a crew the claim control
   (`tests/phase28` A7b) and the owner the car picker (A7c).
3. **Tell the crews what changed**: with two cars running, work that has not
   been put on a car has to be claimed before it can be worked, and that is
   one tap.
4. Then activate Car B:
   ```sql
   update public.ns_stock_locations set active = true where code = 'car_b';
   ```
5. Re-check `job_crew_scope(<an unassigned job>)` as each crew. It should read
   `unassigned_needs_a_claim`, `claimable: true`.

Doing 4 before 3 is how a crew gets a refusal in a driveway with no idea why.

---

## 6. Integration, which is a different thing and not this runbook's

Nothing here wires a screen. The roadmap assigns `admin/js/main.js` and route
registration to Codex at integration, and `tests/run-regression.sh` to a
separate owner-authorised integration change. Four screens are built,
tested standalone and reachable from nothing: the inventory screen
(`renderInventory`), `dispatch-day.js`, `property-access.js` and
`customer-handover.js`.

The prompt for that work is `docs/prompts/codex-integration-candidate.md`.
Its hardest requirement matters to this runbook: **until the chain is
applied, a reachable screen must say which feature is unavailable and why**,
because every one of those screens calls functions that do not exist live
yet. Apply order between the two is either way round, as long as nobody
claims a screen works before its backend is there.

### Suites the integrator should register

| suite | runner today |
|---|---|
| `tests/db/batch7-1 … batch13-1`, **`batch15-1`** | `tests/db/run-db-tests.sh` — **keep out** of the browser runner; they need a disposable PostgreSQL |
| `tests/phase22 … phase29` | `tests/run-admin-suites.sh`, by explicit name |
| `tests/screenshot-batch*.mjs` | run directly |
| `tests/db/audit-pending.mjs`, `rehearse-pending.mjs` | reporting tools, deliberately not pass/fail gates |

---

## 7. What has been verified, and what has not

| | result |
|---|---|
| all 31 migrations apply in filename order on a clean disposable database | yes, 0 blocked, 0 unexplained |
| all 31 re-runnable (applied twice, no stacked policy or trigger) | yes |
| `tests/db/batch15-1` | 64/64 |
| every other database suite | batch7-1 38 · batch8-1 132 · batch9-1 83 · lighting 55 · batch10-1 79 · batch11-1 60 · batch12-1 79 · batch13-1 127 |
| the two rehearsed rollbacks (G2, G3) | performed and re-applied cleanly |
| **live Supabase** | **UNRUN** |
| **production** | **UNRUN** |
| **real SMS / email / payment provider** | **UNRUN** — none selected |
| **Storage signing** | **UNRUN** — no worker |
| **Android / handset** | **UNRUN** — Codex's 13.2, no device available |

A disposable-database result is not live readiness, and nothing in this
runbook claims it is.
