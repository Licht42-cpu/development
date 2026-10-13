# Batch 11.1 findings

What this batch turned up that the brief did not anticipate, and what each
one became. Dispositions for the seven seasonal review findings are in
`docs/reviews/seasonal-abedf0f-dispositions.md`; this file is the rest.

**Nothing in this repository has been applied to the live database.**

## 1. The completion bypass was wider than one function

The brief names the direct-update path. There are two of them, and the
second is the one a crew would actually use.

```js
// admin/js/lib/api.js completeJob()
update ns_jobs set status='completed', completed_at=now() where id=$1
```

```js
// admin/js/views/job.js and views/field-workspace.js, the status dropdown
await api.updateJob(job.id, { status: control.value });   // 'completed' is in the list
```

Closing only the first would have left a fifteen-item `<select>` as the way
round it. The gate is therefore a **trigger on `ns_jobs`**, not a narrower
change to one function, and `batch11-1.test.mjs` D1 asserts both paths are
refused while every other transition still works.

## 2. A column-level grant needs a column list this repository does not have

The natural way to protect `ns_jobs.completed_at` is
`revoke update (completed_at) ... from authenticated`. Two problems, and the
second is fatal here:

* **A column-level REVOKE against a TABLE-level grant does nothing.**
  PostgreSQL warns that no privileges could be revoked and the table grant
  still covers every column. The only way is to revoke the table grant and
  re-grant column by column.
* **Which needs the column list**, and the repository has no base schema
  (`docs/batch7-1-findings.md`, finding 4b), so `ns_jobs`' real columns are
  not knowable from here. Re-granting a guessed list would silently make a
  real column unreadable in production.

So the completion gate is a trigger, which needs no list, fires for every
role including the table owner, and cannot be walked around by splitting an
update into two statements. The same reasoning is why every change this
batch makes to `ns_jobs`, `job_attachments`, `ns_quotes` and
`ns_change_orders` is an `add column if not exists`, a trigger, or an
introspecting DO block.

The one place the column-list approach *is* used — `ns_rental_set_events` in
the seasonal round-two corrective — is a table this repository created and
can therefore enumerate, and the migration asserts the result rather than
trusting it.

## 3. "Unknown is not zero" needs a third enforcement state, not two

The brief asks that unconfigured evidence never render as zero or
sufficient, and that proposed policies be published as assumptions rather
than confirmed rules. Those two pull in opposite directions if a policy can
only be on or off:

* if a proposed policy **gates**, then shipping proposals stops every job
  until the owner has configured the system, which the brief also forbids
  ("preserve legitimate existing job transitions");
* if a proposed policy is **ignored**, the assumption is invisible and the
  owner has nothing concrete to correct.

The resolution is `enforcement` as its own column with two values, paired by
a CHECK with `spec_state`:

```sql
constraint ns_evidence_policies_only_confirmed_blocks check (
  enforcement = 'advisory' or spec_state = 'owner_confirmed')
```

An advisory rule reports a shortfall and accepts the completion, recording
the gap in the receipt. Only a rule the owner confirmed can refuse one. So
nothing this system guessed can ever stop a crew, and nothing it guessed is
hidden either. The job-level `evidence_state` carries `unconfigured` as a
first-class answer alongside `satisfied`, `advisory_short` and `blocked`.

## 4. A correction's sign is the opposite of the ledger's, and the test caught it

`correct_job_consumption` first posted `p_quantity` straight to the ledger.
That is backwards. `p_quantity` is the signed change to the **consumption
record** — `-3` means "we reported three litres more than we used" — so the
three litres are still on the shelf and the adjustment is `+3`. Posting
`-3` would have taken them off twice.

Found by `batch11-1.test.mjs` H4 asserting an on-hand figure rather than
just "a movement was posted": 60 received, 10 consumed, correct by −3, and
the expected balance is 53. The first implementation produced 47.

This is the second time in two batches that an arithmetic invariant written
as an explicit expected number caught a sign error that a shape assertion
would have passed (the first was the seasonal strip in 9.1's corrective).

## 5. Evidence can be registered, attributed, stored — and invisible

A photograph registered against the whole job does not satisfy a
`per_service_scope` requirement. That is correct and matches the view. But
the first version of the job panel listed evidence only underneath the
requirement it counted for, so such a photograph appeared nowhere: filed,
kept, and invisible to the person who filed it. An operator who cannot see
a photo they just registered will register it again.

The panel now has an explicit **"On file, counting towards nothing"**
section that says why. `phase27.test.mjs` B3 pins it.

## 6. An overflow probe passed a screen that was unreadable at 390px

`phase27` E1 measures `document.scrollWidth` against the viewport at 390,
430 and 1280, and the policy panel passed at every width. The screenshot did
not: the badge sitting beside the heading in a `space-between` flex row left
the title about 40% of the width, so "Winter Property Care — Winter proof"
wrapped to one or two words per line and the hint beneath it was a narrow
ribbon. Nothing overflowed; it was simply unreadable.

Fixed with `flex-wrap: wrap` and a `flex: 1 1 220px; min-width: 0` basis on
the text block, which puts the badge on its own line on a phone and leaves
it inline on a desktop — with no change to `admin.css`, which belongs to the
shared surface.

Same finding as Batch 9.1's: a probe that measures overflow is **necessary
and not sufficient**. The PNGs are looked at.

## 7. `anon` is not the only role a `revoke` has to be checked against

Unchanged from 7.1, repeated here because this batch relies on it: the
migrations assert privileges with `has_table_privilege` and
`has_function_privilege` rather than by reading the grant list, because the
three routes (direct, `PUBLIC`, inherited via `pg_auth_members`) do not all
appear in a grant listing. The 7.1 fixture deliberately grants a hostile
role to `anon`; the 11.1 suite revokes it before asserting, and says so,
rather than quietly passing because the hostile case was never set up.

## 8. Smaller things

* **`mobile/www/admin/` is a synced copy and is now stale.** It holds its
  own `lib/api.js` and `components/change-orders.js`, both of which this
  batch changed on the admin side. Running `npm run cap:sync` is a build
  step on the native track and is not this batch's to run, so the copies are
  left as they are and flagged here. Until they are synced, the packaged
  app's completion call still targets the old direct-update path and will
  receive `42501` from the database.
* **`ns_quotes` needed `created_at` and `ns_jobs` needed `completed_at` in
  the fixtures.** Both exist live — the admin code reads them — and neither
  was in any fixture schema, because no earlier batch touched them. Added in
  `fixture-schema-batch11-1.sql`.
* **`reserve_stock` takes seven parameters, not eight.** There is no
  `p_vehicle_code`: the vehicle is derived from the location. Worth writing
  down because the eight-argument call compiles into a perfectly plausible
  "function does not exist" error that reads like a missing migration.
* **The fixture generator's uuid scrubber was anchored.** `UUID.source`
  carries its `^`/`$`, so using it to replace uuids *inside* an error
  message silently matched nothing and the fixtures were non-deterministic
  across runs. Now a separate unanchored pattern, with a comment saying why,
  and determinism is verified by generating twice and diffing.
* **`admin.css` has no `badge--danger`.** Still true, still not added. The
  evidence panels use `badge--ok`, `badge--warn` and `badge--muted`, and the
  badge text carries the severity.
