# Nova Shield — Batch 15.1: backend release preparation and migration review

Execute this assignment independently on your existing `claude/batch-8-1`
branch. This is preparation and correction on your track, not permission to
integrate, migrate production or release the app.

## Starting point and why this is next

Your Batch 13.1 is pushed at
`c6e1e17258ada814bce362f6623762184035ceef`. Verify and report your actual
starting SHA; preserve any newer authorized work. Do not merge, rebase or
cherry-pick a Codex branch.

Batch 14 remains conditional: no routing provider, tracking policy or device
evidence has been supplied to authorize that automation. Proceed with the
roadmap's 15.1 preparation instead. Do not create a filler 14.1 prototype.

Codex's 13.2 preparation is pushed at
`4d7ab126622c24b9ee81769b76628056638d42e4` on `codex/batch-13-2`.
There is no owner-authorized integrated candidate and no Android device or
emulator connection. All 16 physical-device cases remain UNRUN. This work
does not depend on those results and must not describe 13.2 as complete.

Read before editing:

- Repository instructions and `docs/plans/batch-plan-after-7.md`, especially
  Batch 15 and the integration/release gates.
- Your `docs/batch13-1-findings.md` and the frozen
  `docs/customer-handover-contract-v1.md`, plus the completion, dispatch,
  daily-load, stock and seasonal contracts they reference.
- Your pending-migration rehearsal, disposable-database guard, database suite
  runner, fixture schemas and migration files.
- From Codex's exact SHA above, read `tests/android-core-qualification.md`,
  `docs/plans/android-core-qualification.md`, `tests/field-dispatch.md` and
  `tests/field-completion.md` for integration boundaries and remaining gaps.
  Reading them does not authorize importing their code.

First report the baseline, pending-migration inventory and the concrete
corrections you will make. Then continue with authorized local work; do not
wait for Codex or ask again for permission to prepare the review artifacts.

## 1. Reconcile the known crew-authorization defect

Your 13.1 report confirms `can_work_job` and `ns_can_work_job` disagree:
with two active vehicles, completion still permits an unassigned job while
dispatch/load and the new crew-readable report surfaces exclude it.

Apply the already stated operating rule consistently: with two active
vehicles, an unassigned job belongs to neither crew and needs an owner
assignment first. Preserve the established single-active-vehicle fallback
and owner authority. Do not seed or enable Car B or alter any live assignment.

Inspect every relevant read and mutation, not just the two helper names.
Correct the implementation in a new migration rather than silently rewriting
the historical migration. Avoid opening a broader crew access path to make
tests pass. Preserve successful-operation replay and existing error meanings;
explain any unavoidable contract change and version it explicitly.

Prove the rule with real roles on a disposable database: owner, Car A crew,
Car B crew, inactive or missing crew mapping, explicitly assigned jobs,
unassigned jobs, and one versus two active vehicles. Include property access,
completion, dispatch and customer-handover crew reads. Test the transition
where Car B becomes active and previously readable unassigned work is refused.
Assert refused mutations leave no completion, stock movement or notification.
Include a case that fails with the old permissive completion gate restored.

## 2. Produce an exact migration manifest and strengthen the rehearsal

Your last report says 28 migrations pending, with live history last reported
through `20261009013557`. These are recorded observations, not a fresh live
inventory. Recount from source, including any corrective migration you add.

Create a machine-readable ordered manifest containing filenames, versions,
SHA-256 checksums, dependencies, affected objects, destructive changes,
required extensions/roles and backfill or lock considerations. Explicitly
include the Batch 5 sent-customer-content freeze and the older migration
filename/history drift. Do not rename an applied migration or edit remote
history to make filenames match.

If an already available read-only Supabase connection can provide current
migration history, compare it without writing anything. If not, label live
history UNRUN or historical, with its source date; do not request production
credentials merely to continue local preparation.

Audit `tests/db/rehearse-pending.mjs`: its hardcoded last-applied cutoff and
stale comments must not be mistaken for verified live state. Make the selected
baseline and ordered manifest explicit and reproducible. A missing dependency,
failed migration or incomplete required fixture must not result in a green
release-qualification result. A diagnostic mode may report gaps, but cannot
claim the chain passed. Keep the disposable-target guard before every write.

Run the complete pending sequence on a fresh disposable database, inspect the
resulting constraints/triggers/grants and then exercise the relevant suites
against that resulting schema. Individual suites rebuilding their own fixture
database do not by themselves prove the final combined schema works.

The repository lacks an authoritative complete base schema. Record exactly
which objects fixture schemas substitute, which conditional migration branches
they exercise and what remains unproven without a trusted live-schema baseline.
Do not manufacture a production schema from test doubles.

## 3. Review backend and customer boundaries; fix confirmed owned defects

Review these specific release risks with source and executable evidence:

- Quote freezes, including sent notes/terms; internal notes remain editable as
  designed. Pricing, tax, totals and approved change-order prices stay backend
  calculations.
- Grants, RLS, role inheritance and SECURITY DEFINER function safety. Use real
  role changes, not only owner-session introspection. Preserve deliberate anon
  access for existing customer quote and scoped report RPCs.
- Transfer conservation, reservations and release/consume replay, usable versus
  damaged balances, exact versus estimated counts, level supplies, sealed kits,
  offcuts and company-owned seasonal assignment/recovery/release accounting.
- Accepted-completion evidence/consumption history, corrections and reopen,
  immutable issued reports and stale/superseded completion handling.
- Capability scope, expiry, revocation, token secrecy, report enumeration and
  evidence-publication decisions; ensure a report cannot expose another
  customer's rental history, access code, internal note or unapproved photo.
- Notification outcome/recovery states and the existing pipeline boundary:
  queued is not sent, unknown is not safely retryable, and unavailable must not
  mint a sendable credential or meet a delivery SLA.

A specific 13.1 review point: the document builder describes an explicit
allowlist but includes the whole `company` settings row. Inspect its actual
contents and future-column exposure; treat this as a review hypothesis, not a
proven leak. Fix it if it violates the intended customer projection.

Verify the document-ticket authorization/consumption boundary and document the
absent signing worker: SQL success cannot prove object existence, a signed URL
or a real download. Do not silently supply a second notification sender or a
new worker architecture without the authoritative deployed source.

Payment stays unavailable while settlement and provider contracts are absent.
Audit the conditional `ns_payments` binding as an extension point, not proof
that a matching test table is a real financial model. Do not implement invoices,
payments, refunds, provider webhooks or automatic customer replies in this batch.

Use new corrective migrations for confirmed schema/RPC defects. Keep corrections
focused on these existing behaviors. Update affected fixtures and contract
versions deliberately; do not silently change frozen responses consumed by
Codex. Document any client follow-up with exact signatures and errors.

## 4. Prepare application, recovery and integration instructions

Write a concrete runbook for a later separately authorized application window:

- Preconditions, trusted schema/history comparison, backup/restore verification,
  ordered manifest checks and the exact command per step, labeled NOT EXECUTED.
- Transaction boundaries, lock/backfill expectations and post-application probes
  for triggers, grants, balances, histories and customer access.
- What can safely roll back versus what needs forward repair or restore,
  especially destructive seasonal-schema changes and already-issued documents.
  Do not call dropping data a rollback or promise rollback without rehearsal.
- Failure handling and stop conditions; never rerun a partly committed sequence
  blindly or suppress a refused migration.
- The independent owner decisions: operating timezone, link expiry, seven
  completion-policy questions, settlement model/providers and missing worker
  sources. Distinguish optional unavailable features from true release blockers.

Record known data-cleanup candidates separately, with identifiers and evidence
if legitimately available read-only. No deletes, postcode edits, guessed fixes,
or copied customer secrets in committed artifacts. Keep legacy-table grant
decisions separate from additive operational migrations.

Prepare an integration checklist with exact source SHAs, shared-file conflicts,
explicit suite lists, route mounting needed for the standalone handover panel,
and provider/deployment routes still unverified. Do not perform integration or
register routes on Codex's router. Do not edit `tests/run-regression.sh`.

Reconcile factual documentation drift, including the handover contract's 38
browser checks versus the final 40 reported in findings, and its one-new-key
claim versus the `customer_portal` and `payments` keys it lists. Distinguish
editorial corrections from changes to a frozen behavior contract.

## Ownership and standing constraints

Your backend, API, admin operations/customer surfaces, scoped styles, database
tests and contracts are in scope. Codex-owned field/mobile/offline/navigation/
native/build files, shared router wiring, shared harness and global styles are
out of scope. Report a needed Codex change rather than editing those files.

One crew now, maximum two; one Base, Car A, optional unseeded Car B. No fleet,
route optimization, background tracking or Batch 14 work. Preserve all existing
quote, stock, seasonal, completion and customer privacy boundaries. Proposed or
advisory evidence policies are not owner-confirmed blocking policies.

Do not invent supplier specifications, pack conversions, chemical strengths or
dosages, renewal cutoffs, timezone, completion business answers, or the missing
Permanent Lighting Phase D document.

No live migrations, grant/data/settings changes, real customer messages, merge,
rebase, deployment, provider account creation or APK publication. Local writes
target only an explicitly disposable database with a fail-closed production
guard. Redact tokens, access codes, credentials and customer working details
from committed logs and fixtures.

## Deliverables and stopping point

Commit and push all deliverables to your shared repository branch:

- `docs/batch15-1-findings.md`: base/final SHA, reviewed scope, confirmed defects,
  corrections, remaining risks and exact evidence categories.
- `docs/release/backend-migration-manifest.json` and
  `docs/release/backend-application-runbook.md`.
- `docs/release/backend-integration-checklist.md`: explicit tests, conflicts,
  mounting tasks, contract versions and provider/device gates.
- Focused corrective migrations, meaningful tests and improved local rehearsal
  tooling where the review shows they are needed.

Run affected local database and browser suites, then the relevant regression
once corrections pass. Inspect changed controls at 390/430/desktop with keyboard
access only if you change UI. Show at least the permission defect failing with
its correction absent. Rebuild changed generated fixtures twice and compare.

Report passed, failed, skipped, expected-failure and UNRUN with actual counts and
commands. Keep fixture-based combined-schema tests, browser mocks, live Supabase,
provider, production and Android/device evidence separate. A fixture rehearsal
is not a live-project qualification and this branch is not an integrated release.

Finish with exact branch/base/final SHA, pushed artifact links, ordered pending
count, fixes per finding, recoverability limits and the smallest next owner
decisions needed. Stop after 15.1 preparation. Do not apply the runbook or start
14.1, a Codex batch, integration or release.
