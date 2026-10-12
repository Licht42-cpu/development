# Claude — Batch 13.1: customer completion reports and secure handover

Execute Batch 13.1 independently on your own branch. Implement, test,
commit and push, then stop. Claude owns X.1; Codex owns X.2. This is the
next roadmap batch after your completed 12.1, not integration or release.

## Start from the actual source

Expected branch: `claude/batch-8-1`, published head `b21d082`. Verify and
report the full base SHA; preserve any newer authorized work. Read the
repository instructions before editing. Do not merge, rebase or cherry-pick
Codex and do not wait for another Codex push.

Read your `docs/batch12-1-findings.md`, `docs/dispatch-contract-v1.md`,
completion/evidence contract and findings, and the stock, seasonal,
permanent-lighting and daily-load contracts. Keep their frozen wire shapes
compatible; a necessary breaking change needs an explicit new version.

Read the maintained roadmap at `codex/batch-11-2@ae1efdd`:
`docs/plans/batch-plan-after-7.md` (13.1),
`docs/plans/claude-roadmap-handoff.md`, and
`docs/plans/service-operations-blueprint.md`. Fetch/show files if absent;
these are repository documents, not container-only paths.

Codex 11.2 is complete at `ae1efdd` on `codex/batch-11-2`; read its
`tests/field-completion.md` without importing implementation. It submits
`complete_job_with_evidence` through the existing durable outbox and keeps
unknown response, refusal, conflict and accepted completion distinct.
Accepted completion, not a worker's tap or `work_finished`, starts this
batch's customer handover. Do not edit Codex's completion UI or queue.

## Goal and bounded scope

Give a customer a clear report of accepted work and a secure, narrow view
of their own approved quotes, completion reports and deliberately published
documents. Reuse existing quote links and notification infrastructure.

Payment and SMS providers are unchosen. Complete the independent report,
authorization, customer view and provider-boundary work now. Display an
honest unavailable state for unconfigured provider features; do not choose
a provider, fabricate a checkout URL, assume fees or configure live accounts.
This is not a full customer account platform, subscription system, general
document manager or automatic tracking product.

## 1. Accepted-completion report

Generate a server-authorized, versioned customer projection from the
accepted completion record, its confirmed evidence and recorded work.
Use an explicit field allowlist. Do not serialize whole internal rows.

- Separate customer-readable service/work descriptions, reported work time,
  server acceptance time, and deliberately customer-published evidence.
  Unknown time/GPS stays unknown; device claims are not server verification.
- Publish no access codes, internal/property hazard notes, crew private
  notes, procurement costs, private exceptions, original GPS metadata or
  unrelated customer identifiers by default. An attachment used to prove
  completion is not automatically customer-publishable: inspect existing
  semantics and require an explicit owner-controlled publication decision
  where that distinction is absent.
- Describe reported materials with their existing units and exact/estimated
  state. Levels remain levels, not invented quantities. Consumption reports
  do not become invoice calculations. Company-owned Christmas sets remain
  rentals; never expose a previous customer's assignment or reused-light
  history, or imply that completing installation transferred ownership.
- Customer-visible additional work must reference owner-approved commercial
  records. Pending crew proposals are not charges. Pricing and any payable
  balance come only from authoritative backend commercial records.
- Keep accepted completion and quote history immutable. A later correction
  or reopened/recompleted job needs a clearly identified superseding report
  or amendment referencing its accepted source; do not rewrite an already
  issued report, re-run consumption, or silently send another copy.
- Deduplicate by the logical report/source version, not just by a browser
  operation key. Same-key retries replay; changed intent conflicts. Concurrent
  generation and a lost response must not create two report events.

Expose an owner preview/publication control when needed to protect evidence
privacy. Make any review hold visible rather than pretending the report was
sent automatically. Reuse existing business settings and templates when
appropriate; do not invent legal terms or evidence-policy answers.

## 2. Narrow customer access, enforced on the server

Inspect `site/quote.html`, existing customer quote/respond RPCs, canonical
URL handling and the deployed route layout before creating customer links.
Preserve sent quote snapshots, acceptance rules and existing deliberate anon
access to the customer quote RPCs.

Implement a scoped customer report/document view with a supported server
read. Define whether a link covers one report/job or a deliberately granted
customer collection; a forwarded single quote token must not silently grant
every document for that customer. A broad portal scope requires an explicit
owner-issued grant, not a guessed customer ID or email match.

Use cryptographically random capabilities or the established customer auth
mechanism with server-checked scope, expiry and revocation. Specify the
chosen mechanism and test it. Do not grant anon general table/storage read,
put privileged keys in the browser, store raw bearer tokens in audit logs,
or return internal rows for client-side filtering. Expiry duration is an
owner-configurable policy: do not silently invent a business default.
Owner publication can require an explicit expiry before issuing a link.

Document/media access must check the same grant. Keep files private and
issue appropriately bounded signed access only after authorization; never
expose a public bucket or a guessable attachment path as the security model.
Revoking the grant stops new reads/signatures; document the residual lifetime
of an already issued signed URL rather than claiming immediate revocation.
Show expired, revoked, unavailable and superseded states without leaking
another customer's data. Render user-authored prose safely.

## 3. Delivery and the two-minute target

Reuse the existing `notifications` pipeline and 12.1 request/outcome
semantics. Accepted/queued is not delivered; provider failure and unknown
delivery are different. Resolve the recipient from authorized business data,
not a caller-supplied destination. Deduplicate the logical report delivery
and preserve the original key across uncertain outcomes.

Locate the actual notification worker/Edge Function and its deployed-source
provenance before changing delivery behavior. The current tree does not
contain an obvious worker implementation. If the authoritative source is
unavailable, report the exact missing source, implement and test the local
report/event contract and an injected adapter, and leave real sending UNRUN.
Do not create a competing sender or claim an inserted row was processed.

Define timestamps for server acceptance, evidence/publication readiness,
report generation, enqueue and provider outcome. Measure local processing
separately from delivery. The target starts at accepted completion with the
required publishable evidence available, not an offline gesture. Report any
owner-review/configuration hold and the actual acceptance-to-readiness delay.
An unavailable provider or uncertain outcome cannot meet a delivery SLA.
Use doubles only; send no real email or SMS.

SMS access replies remain unavailable until a provider and inbound contract
exist. Specify the extension point without inventing a webhook signature,
phone identity proof or reply workflow that the selected provider may not
support. A reply must never disclose internal access codes automatically.

## 4. Provider-ready payment boundary

Read the existing invoice/payment model first. Implement a server-only
boundary that can produce a payment request for the intended approved
commercial record, amount, currency and remaining balance, if those facts
are established. If the authoritative invoice/balance model is missing,
identify that dependency instead of inventing it from material quantities,
a report total or a price-book lookup.

Unconfigured means unavailable. No real payment link, credential, sandbox
account, provider SDK or webhook assumptions until the owner selects a
provider. Use an injected double to test amount binding, authorization,
same-key recovery and changed-intent refusal. Generating/opening a link is
not payment; browser redirects cannot mark an invoice paid. Document the
provider-specific verification/reconciliation work still required before
any implementation could accept a real paid outcome.

Do not alter existing quote pricing, tax/minimum calculations, grants or
payment statuses just to make a demo checkout appear successful.

## Contract and handoff

Push `docs/customer-handover-contract-v1.md` containing supported reads and
mutations, exact signatures/defaults/nullability, typed result envelopes,
scope and publication rules, source/version identity, replay/conflict rules,
errors, expiry/revocation, attachment authorization, correction semantics,
delivery timing and provider-unavailable states. Name unsupported features.

Generate deterministic fixtures from the disposable backend for accepted
completion versus blocked/pending/work-finished; explicit evidence
publication; cross-customer/private-field denial; report retries and
corrections; expiry/revocation; missing files; provider unavailable/failure/
unknown; and authoritative approved payment amounts where the existing
model supports them. Fixture doubles must be labelled; they do not prove
storage/provider authorization or real delivery.

Push findings, all Markdown handoffs, fixture provenance/hash, migration
order, screenshots and the integrator suite list. Standalone management
modules may use injected adapters; global route wiring remains integration.

## Boundaries and verification

- Yours: backend/migrations, owned API/admin customer/report views, scoped
  CSS, customer site pages and your backend/browser suites. Do not change
  Codex field/offline/outbox/navigation/native/build files, package/lockfiles,
  `admin/js/main.js`, global `admin.css`, shared auth/DOM/format/harness, or
  `tests/run-regression.sh`. List new suites for the integrator.
- No live migrations/grants/data/settings changes, external messages,
  provider account setup, merge/rebase/integration, deployment or APK/payment
  publication. Local DB work must fail closed unless explicitly disposable.
  Recount/rehearse the whole pending chain (12.1 reported 24), not just the
  new files. Nothing in that rehearsal proves live Supabase readiness.
- One crew, at most two; Base/Car A and optional unseeded Car B. Preserve
  load invalidation receipts, seasonal identity, stock conservation,
  reservations, usable/damaged, exact/estimated and quantity/level distinctions.
- Preserve backend-only pricing, quote freezes, accepted completion history,
  evidence locks and proposed/advisory versus confirmed/blocking policies.
  Do not answer the seven open 11.1 business questions or invent supplier
  specs, dosages, pack conversions, timezone, cutoffs or Phase D documentation.
- Carry the unresolved scope observation in Codex's `tests/field-completion.md`:
  completion `can_work_job` allows unassigned work, while two-car dispatch/load
  excludes it. 12.1 adds a separate `ns_can_work_job`; inspect the actual call
  paths before claiming they now agree. Cover the customer-facing endpoints'
  scope and report any remaining mismatch with source evidence. Do not turn
  this batch into another wholesale review of completed work.
- Test with real non-owner roles as well as privilege inspection: customer A
  cannot read B, crew cannot mint customer grants/publish owner-only reports,
  invalid/expired/revoked capabilities fail, direct table/storage paths do not
  bypass scope, stale/cross-job requests fail, and concurrent retries create
  one logical event. Test correction history and unchanged stock/commercial
  balances after report generation. Re-run affected quote, completion,
  dispatch and notification suites.
- Inspect customer/admin controls at 390/430/desktop with actual screenshots
  and keyboard operation. Check long contact strings, prose and empty/error
  states; no existing quote URL regression.
- Report passed, failed, skipped, expected-failure and UNRUN separately.
  Keep disposable PostgreSQL, mocked browser, provider doubles, provider
  sandbox, live Supabase, production and physical device outcomes distinct.
  Sandbox/live delivery and payment remain UNRUN without chosen providers.

Finish with base/final SHA, branch, delivered scope, contract/fixture links,
verification categories, actual pending migration status, and concrete
remaining owner/provider decisions. Describe unavailable features plainly.
Stop after 13.1. Do not start 12.2, 13.2, conditional 14.1, or release work.
