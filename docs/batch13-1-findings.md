# Batch 13.1 findings: customer completion reports and secure handover

**Branch** `claude/batch-8-1`. **Base** `7a27bb3`, which is `b21d082` (the
head the assignment expected) plus one authorized commit — the Batch 12.2
prompt for Codex, `docs/prompts/codex-batch-12-2.md`. That newer work is
preserved, not rebased away. Assignment:
`docs/prompts/claude-batch-13-1-customer-handover.md` at `c8666dd` on
`codex/batch-11-2`.

**Nothing has been applied anywhere.** Twenty-eight migrations are pending in
filename order. No live migration, grant, data or settings change, no
external message, no provider account, no merge, no deployment, no APK, no
payment.

**Codex's 11.2 is complete** and its handoff (`tests/field-completion.md`)
was read, not imported. Its contract survives: `complete_job_with_evidence`,
its durable outbox and its four-way unknown/refusal/conflict/accepted
distinction all behave exactly as they did. **Accepted completion — not a
worker's tap and not `work_finished` — is the only thing that starts a
customer report**, which is asserted rather than assumed
(`batch13-1` B1, and the three non-accepted states side by side).

---

## What was built

| § | Delivered | Where |
|---|---|---|
| 1 | A versioned, allowlisted customer projection of one accepted completion; publication of evidence as its own owner decision; immutable once issued, superseding on correction, deduplicated by the logical source version | `20261017090000` |
| 2 | A cryptographically random, hash-stored capability with server-checked scope, required expiry and revocation; the customer read as typed states; files by short-lived ticket, never by path | `20261017100000` |
| 3 | Delivery through the existing `notifications` table with 12.1's five outcomes, one live delivery per report, and five timestamps that make the two-minute question answerable | `20261017110000` |
| 4 | A payment boundary that refuses, naming the missing settlement model rather than inventing one | `20261017120000` |

Surfaces: `admin/js/components/customer-handover.js` (owner),
`site/report.html` + `site/js/pages/report.js` (customer), and the wrappers in
`admin/js/lib/api.js`. The admin component is standalone-mountable and tested
that way; **no route registration and no `admin/js/main.js` edit** — that is
the integration change, not this batch's.

Contract: `docs/customer-handover-contract-v1.md`, **frozen at v1**, 14
sections.

---

## Decisions worth arguing with

### Proving the work and publishing it were the same thing, and should not be

11.1's `ns_job_evidence` answers "does this job have an `after` photograph of
the siding". It does not answer "may the customer see it", and **that
distinction did not exist anywhere**. An `access_hazard` photograph framing a
key safe, or a `site_condition` shot of a neighbour's fence, satisfies a
completion requirement and must never be published.

So `ns_evidence_publications` is a per-evidence **owner decision with a
reason**, and the absence of a row means NOT published. The report reads that
table and never reads `ns_job_evidence` for publishable content. A withheld
decision requires a reason, so a later reviewer can see the decision was made
rather than forgotten.

The customer caption is a separate column from `job_attachments.caption`.
The attachment caption is an internal note the office wrote for itself
("gutter seam, note the staining"), and republishing it is exactly the leak
this separation prevents.

### Deduplicating by the browser's key would have been half a job

`client_operation_id` catches the retry nobody got a response to. It does not
catch two tabs, or a retry with a fresh key, both asking for "the report as it
stands" — and two report events for one set of facts means two documents, two
links and possibly two texts.

So the unique index is `(completion_id, source_version)`, where
`source_version` hashes the completion, its correction count, its open state,
the **published** evidence set, the recorded consumption and the approved
commercial records. A fresh key over unchanged facts is answered with the
existing report and `replayed: true`; a key after any of them changed produces
a new, superseding version. `batch13-1` D4 asserts both halves.

### "Is this completion still current" is two questions, and the obvious helper answers one

`ns_job_completion_is_open(job_id)` is a **job**-level predicate — "does this
job have an accepted completion that has not been reopened" — so it is true
again the moment a reopened job is completed a second time. Checking only that
would let a stale screen generate a report from a superseded completion.

The second question is answered by the row's own `supersedes_corrections`
against the job's reopen count, which is how 11.1's unique index keys it.
Both refusals exist, with different messages (`batch13-1` D8, D9).

### The capability, and why no extension

Two `gen_random_uuid()` values concatenated: 244 bits from PostgreSQL's own
`pg_strong_random`, stored as a SHA-256 hash with an 8-character prefix for
support. **pgcrypto is deliberately not assumed** — nothing in this
repository's migrations uses it, so a token built from `gen_random_bytes`
would be a deployment surprise on a project nobody has tested it against.
`sha256()` is built in since PostgreSQL 11.

The token is returned once and kept nowhere. A replay under the same key
returns the grant's identity with `token: null` and
`token_state: 'not_recoverable'`, which is honest rather than convenient: the
server could not produce it if it wanted to. `batch13-1` F5 sweeps **every
text and jsonb column in `public`** for the raw token and permits exactly one
exclusion, `notifications.payload`, by name — because an outbox message
legitimately carries the link it is about to send, and that exclusion is
stated in the contract rather than hidden in a test.

### A forwarded link is not a filing cabinet

A `report` grant resolves exactly one report and ignores a supplied id unless
it matches. A `customer_collection` grant exists only because an owner
deliberately issued one, naming the customer; it is never derived from an
email, a name or a forwarded token. There is no path from the first to the
second.

**Another customer's real report and an invented id answer identically**
(`{state: 'not_found'}`, same message). Telling them apart is nobody's
business but ours, and a different answer is an enumeration oracle.

### Expiry is a business decision, so it is refused rather than guessed

A capability with no expiry is a permanent credential in somebody's inbox, so
`expires_at` is required. But "30 days" has a real cost either way — support
calls if too short, a live link in a forwarded email if too long — and
choosing it inside a migration would bury the decision. With
`customer_portal.link_expiry_days` set, a null uses the policy; without it,
a null is **refused** and the error says there is no default.

### Revocation says what it cannot do

It stops further reads and any new signed download. It cannot reach inside a
signed URL a reader already holds. The receipt carries
`already_issued_signed_urls: "remain valid for the rest of their own
lifetime"`, and the ticket TTL bounds that to 120 seconds. Claiming an
instant cut-off would have been the easy lie.

### The file ticket, and the TTL that is not a policy

SQL cannot sign a Storage URL and the service role must never be in a
browser, so the customer-facing call does the **authorisation** — valid
capability, in-scope report, and the evidence **listed in the frozen
document** — and hands back a single-use, 120-second ticket. Checking the
publication table as it stands today instead of the frozen document would let
a decision made after issue change what an issued document can open.

120 seconds is a **technical bound** on a click-to-fetch round trip, not the
"how long may a customer keep their paperwork" decision, which is the owner's.
Conflating them would have smuggled a business default in through the back
door.

### Accepted is queued; unknown is not optimism

Delivery reuses the existing `notifications` table and 12.1's five outcomes
with their meanings unchanged. `accepted` carries `sent: false` on the receipt.
`unknown` stays live and keeps blocking a second message, because the provider
may have neither idempotency nor an outcome lookup and a retry might be the
customer's second identical text; resolving it is a human decision recorded
**under the original key**, so one logical delivery stays one.

`unavailable` splits into two reasons fixed by different people, and **mints no
capability at all** — a link nobody can be sent is a live credential with no
reader. The CHECK makes that a database rule.

The token is minted and queued in one transaction, so it never travels back
through a browser, and the message payload carries the customer's name, the
report version and the link and nothing else. No access code, no internal
note, no materials, no totals.

### The two-minute target, measured honestly

Five timestamps, kept apart: server acceptance, publication readiness, report
generation, enqueue, provider outcome. Local processing (ours) and provider
time (theirs) are separate numbers. `sla_state` is **`indeterminate`** whenever
the provider is unavailable or the outcome unknown — scoring an unavailable
provider as `met` would be measuring our own INSERT. An owner review hold shows
up as `acceptance_to_readiness_seconds` rather than vanishing into one figure.

### The payment boundary refuses, and names why

Searched for by name rather than assumed: there is **no invoice table, no
payment table, no record of money received and no `paid` state anywhere**. So
a remaining balance is not knowable, and this is reported as the dependency:
`amount_settled: null`, `remaining_balance: null`,
`balance_state: 'no_settlement_model'`, plus the sentence saying so.

Three things it would have been wrong to do: derive an amount from material
quantities (consumption is not a price, and 11.1's whole point is that
completion prices nothing); derive it from a report total (a report is a
document); or **call the approved total "outstanding"** — approved is what was
agreed, outstanding is agreed minus received, and the second half does not
exist. The owner's screen prints "Approved: $600" and then says what has been
paid is not recorded, rather than printing the first figure as the second.

`ns_payment_balance` introspects for an `ns_payments` table and binds to it if
one ever exists. That is a hook for a model that does not exist — not a claim
that it does, and not a schema this batch creates. The binding is proved with a
**labelled double** that the suite and the fixture generator create and drop.

There is **no Pay button** while the feature is unavailable: a control that
can only fail is noise, and a cheerful one over an unreconcilable figure is
worse.

### Inbound replies: one rule, no invented pipeline

No webhook route, no signature scheme, no phone-identity proof, no reply state
machine. All four are provider-specific. `ns_inbound_reply_support()` returns
`unconfigured` with the reasons and the extension point, and records the one
rule a later implementation inherits: **an automatic reply never discloses an
access code.** 12.1 keeps `access_code` and `internal_note` ungranted at
column level for exactly this reason, and an auto-responder texting the gate
code to whoever messaged the business number would undo it in one line.

---

## Defects this batch found in its own work

| Found by | What |
|---|---|
| `batch13-1` B12 / J4 | **A scalar `(select … from q)` over an empty CTE returns null, not the CASE's else branch** — the CASE never runs, because there is no row to run it on. So a job with no accepted quote reported `commercial_state: null` instead of `no_accepted_quote`, **and the payment boundary then mis-attributed its refusal to the missing settlement model instead of the missing quote.** One bug, two wrong answers. The state is now decided outside the subquery with `exists`, and the fallbacks coalesce the whole subquery rather than a column. |
| `batch13-1` H6 (while writing it) | The first version of the missing-file test deleted an evidence row — and **11.1's freeze refused, correctly**. An accepted completion's evidence cannot be deleted while a report names it, so the dangling-evidence branch is defence, not the reachable case. The case that happens is a row whose storage object is gone; `redeem_document_ticket` now treats a blank path as `file_missing`, and the test asserts the refusal too. |
| `screenshot-batch13-1` | **`shared/dom.js select()` reads `opt.value` and `opt.label`**, so the bare `[value, label]` pairs this panel passed rendered options with neither — an **empty dropdown**. No assertion looked at the options, so only the screenshot caught it. 12.1's two components map their pairs correctly; this one did not. Fixed, and `phase29` D6 is that missing assertion. |
| `screenshot-batch13-1` | The customer document scrolled sideways at 390px: `.line span:last-child { white-space: nowrap }` also matched the **single** span of a "what we did" row, holding a long service description on one unbreakable line and pushing the sheet to 705px. The nowrap belongs to the amount column, which only exists when there is a second span — `span + span`. |
| screenshot review | The owner's screen printed `access_hazard` at a person. Now shown in the same words the customer's page uses, including the `aria-label`s. |
| screenshot review | "We accepted and checked the work at Sep 14, 5:02 p.m.." — `shared/format.js` `dateTime()` already ends a 12-hour time with "p.m.", so the appended full stop doubled it. |

---

## The scope observation Codex asked about

Codex's `tests/field-completion.md` flags that completion's `can_work_job`
allows unassigned work while two-car dispatch and load exclude it, and asks
whether 12.1's separate `ns_can_work_job` makes them agree.

**It does not, and I inspected the call paths rather than claiming it.** The
two functions are different objects with different rules:

* `public.can_work_job(uuid)` (11.1, `20261013110000`): any admin may, except
  where the job is **explicitly assigned** to a vehicle the caller cannot see.
  An unassigned job is therefore workable by any crew, **however many vehicles
  are active**.
* `public.ns_can_work_job(uuid)` (12.1, `20261016110000`): assigned to the
  caller's own vehicle, **or** unassigned **and exactly one vehicle is
  active**. With two active vehicles an unassigned job belongs to neither
  crew.

So with Car B active, an unassigned job can still be **completed** by a crew
(11.1's rule) but cannot be **dispatched, messaged about, or reported on**
(12.1's rule and this batch's). That mismatch is real and it is still mine.

**What this batch's customer-facing endpoints use, stated exactly:**

| surface | gate |
|---|---|
| `get_customer_report`, `list_customer_documents`, `request_customer_document` | **the capability only** — no crew or vehicle rule is involved, so the mismatch cannot reach a customer |
| `job_completion_reports`, `job_payment_state` | `is_admin()` **and** `ns_can_work_job()` (12.1's stricter rule) |
| `generate_completion_report`, `publish_completion_report`, `set_evidence_publication`, `issue_customer_grant`, `revoke_customer_grant`, `customer_grants`, `deliver_completion_report`, `create_payment_request` | `is_owner()` — a crew cannot reach any of them, so the mismatch is irrelevant to every write this batch adds |
| `record_report_delivery_outcome` | `is_owner()` or the service role |

The consequence of choosing the stricter gate for the two crew-readable
reads: **activating Car B narrows what a Car A crew can read here**, exactly
as it does on the dispatch screen. That is consistent with 12.1 and with the
load plan, and inconsistent with 11.1's completion gate — which remains the
unresolved decision (does an unassigned job belong to every crew, to none, or
must dispatch assign it first?). It is a backend decision, it is mine, and it
is **still to be resolved before a second crew is enabled**. This batch did
not widen or narrow either existing function, and deliberately did not turn
into a review of completed work.

---

## Verification

Local PostgreSQL 16 on an explicitly disposable database with a fail-closed
production guard, and mocked-browser suites against the real components and
the real customer page. **Provider doubles only** — no provider was configured
beyond a name in settings, nothing sent a message, nothing signed a file and
no money moved.

| | result |
|---|---|
| `tests/db/batch7-1` | 38/38 |
| `tests/db/batch8-1` | 132/132 |
| `tests/db/batch9-1` | 83/83 |
| `tests/db/batch9-1-lighting` | 55/55 |
| `tests/db/batch10-1` | 79/79 |
| `tests/db/batch11-1` | 60/60 |
| `tests/db/batch12-1` | 79/79 |
| **`tests/db/batch13-1`** | **127/127**, new |
| `npm test` (browser regression) | phase2 18 · phase3 11 · phase4 17 · phase5 13 · phase6 14 · phase7 16 · phase8 17 · phase9 15 · phase10 18 · phase10-5 9 · phase11 18 · phase12 17 · phase13 17 · phase14 13 · phase15 15 · phase16 13 · phase17 16 · phase18 35 · phase19 25 · phase20 24 · phase21 14 · geofence ok · native-wrapper 19 · reload-offline 2 — all green |
| `npm run test:admin` | phase22 18/18 · phase23 55/55 · phase24 37/37 · phase25 25/25 · phase26 29/29 · phase27 16/16 · phase28 28/28 · **phase29 40/40**, new |
| pending-migration rehearsal | **28 of 28** apply in filename order from a clean disposable database, 0 blocked, 0 unexplained |
| fixtures | `tests/fixtures/customer-handover-v1.json`, **10 scenarios**, byte-identical across two clean rebuilds. md5 `7416b92233eb1a5d9dd8b42f6b35df75` at the time of writing — regenerate with `npm run fixtures:handover` and the diff is the contract change. |
| visual QA | handover panel and five customer-page states at 390 / 430 / 1280, screenshots inspected, no overflow, no undersized control, no unexpected page error, every control Tab-reachable and Enter-operable |
| skipped | none |
| expected failure | none declared |
| **live Supabase** | **UNRUN** |
| **production** | **UNRUN** |
| **real SMS / email delivery** | **UNRUN** — no worker in this repository, doubles only |
| **Storage signing** | **UNRUN** — no worker in this repository |
| **payment provider (sandbox or live)** | **UNRUN** — no provider selected |
| **Android / device** | **UNRUN** — not this batch's scope |

A local database result is not live readiness and nothing here claims it is.

### New suites for the integrator

* `tests/db/batch13-1.test.mjs` — registered in `tests/db/run-db-tests.sh`
* `tests/phase29.test.mjs` — registered in `tests/run-admin-suites.sh`
* `tests/screenshot-batch13-1.mjs` — run directly, like the other screenshot
  scripts
* `tests/fixtures/build-handover-fixtures.mjs` — `npm run fixtures:handover`

`tests/run-regression.sh` is unchanged, as required. `tests/db/rehearse-pending.mjs`
now loads the 12.1 and 13.1 fixture schemas as well, because a rehearsal
without them silently exercised the weaker half of two migrations (12.1's
`notifications` foreign key is added only if the table is there).

---

## Remaining decisions, stated rather than defaulted

1. **The settlement model.** There is no invoice, no payment-received record
   and no `paid` state. Until there is, every payment request is
   `unavailable`. The five pieces of provider work are listed in
   `job_payment_state.remaining_provider_work` and in contract §9.3.
2. **The payment provider** is unset (`app_settings.payments.provider`).
   Choosing one is the owner's, and its webhook, idempotency and
   reconciliation behaviour decides most of §9.3.
3. **The link expiry policy** is unset
   (`app_settings.customer_portal.link_expiry_days`), so every link needs an
   explicit expiry. One settings row ends that.
4. **The SMS provider** is still unset, so every text is `unavailable` — the
   same open decision 12.1 reported.
5. **The notification worker and the document-signing worker** are both
   absent from this repository. Both are named as UNRUN; neither is stubbed
   into looking present.
6. **The unassigned-job gate mismatch** between 11.1's `can_work_job` and
   12.1's `ns_can_work_job`, above. Mine, unresolved, and due before a second
   crew is enabled.
7. **The operating timezone** is still unset, as 12.1 reported.
8. **The seven 11.1 business questions** are untouched, as are supplier
   specifications, pack conversions, chemical dosages, renewal cutoffs and the
   missing Permanent Lighting Phase D document.
