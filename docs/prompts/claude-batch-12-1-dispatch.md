# Claude — Batch 12.1: practical dispatch, property instructions and customer actions

Execute Batch 12.1 on your own branch. Implement, test, commit and push,
then stop. You own X.1; Codex owns X.2. This is implementation work, not
another roadmap rewrite or a request to repeat the completed corrective.

## Starting point and completed work

Expected branch: `claude/batch-8-1`, latest published head `11a45c2`.
Verify/report your actual SHA and preserve newer authorized work. Read
repository instructions and the maintained roadmap before editing. Do not
merge, rebase or cherry-pick Codex, and do not wait for a new Codex push.

Your 10.1 corrective is complete in `a96b512` and `b7f0a22`; 11.1 is already
implemented in `32963a3`. Do not repeat those batches. Read your current
stock, seasonal, permanent-lighting, daily-load and completion contracts,
plus the corrective and 11.1 findings, to preserve their guarantees.

Codex has completed 10.2 at `19550a6` on `codex/batch-10-2`. Its shared
handoff is `tests/field-load.md` at that commit. Read it with fetch/show if
needed; do not import the implementation. It uses daily-load v2.1, confirms
the plan it rendered, distinguishes refusal/conflict/no response/acceptance,
and keeps load writes online-only with explicit same-key recovery. Your new
dispatch must preserve that contract and must not depend on those UI files.

The roadmap is available at `19550a6`:
`docs/plans/batch-plan-after-7.md`, especially 12.1/12.2 and ownership.
Fetch/show it if absent; no container-only plan path is required.

## Goal

Help the owner plan today's work and understand delays, and give the crew
clear instructions and deliberate actions. One crew now, at most two,
with separate vehicles. Build a practical ordered day, not fleet management,
route optimization, payroll or background tracking.

## Implement

### 1. Authoritative ordered dispatch

Reuse existing jobs, vehicle assignments and the configured operating-day
window. Provide an owner/admin planning view for one or two vehicles, manual
reordering, reassignment and scheduling. The same job must not accidentally
be dispatched to both vehicles. Preserve explicit assignment versus the
single-vehicle default; with two vehicles, unassigned work belongs to neither.
Show it as needing assignment rather than guessing a car.

Make reads and mutations server-authorized, versioned and replay-safe.
Concurrent reorder/reassignment must refuse stale intent rather than lose
another edit. A lost response must be recoverable under the original key;
same-key changed intent must not silently succeed.

Schedule/order/vehicle changes must revise or explicitly invalidate affected
load plans, including both vehicles on reassignment. Preserve the earlier
confirmed plan and transfer receipts as history. Old confirmations must be
refused; rebuilding recommendations must post no stock movement. Do not
silently re-confirm loading or assume a reassignment physically moved tools.
Keep the v2.1 load request/response shapes compatible. If a breaking change
is truly necessary, identify/version it explicitly before dependent work;
complete unrelated implementation rather than inventing a replacement DTO.

### 2. Equipment conflicts and service stages

Show conflicts using authoritative usable stock, reservations, location and
whole-day needs. Shared equipment is a day-level resource, not multiplied
once per stop. Two cars cannot both be promised the same scarce washer.
Distinguish unavailable, damaged, missing data and unresolved physical
location; unknown quantity is never zero. Surface conflicts without
automatically transferring, purchasing or consuming stock.

Represent seasonal installation/removal work using existing assignments and
physical set states. Installation, removal, recovery, inspection and release
remain different acts; changing a dispatch stage must not invoke all of them.
Company-owned lights do not become the customer's property, and a commercial
assignment does not establish that a set is aboard a car.

Support owner-triggered weather-related winter dispatch through existing
service/job structures. Keep the current Winter Property Care scope; walkway
and deck variants must not create duplicate dispatches or minimums. Do not
invent snowfall thresholds, forecast automation, visit allowances or salt
dosages. Leave automation assumptions proposed/unconfigured; the owner can
deliberately activate work without a fabricated weather rule.

### 3. Property instructions and a bounded work-zone tool

Store entrance/access instructions, work areas and hazards against existing
properties, reusing current fields where appropriate. Separate internal
instructions/access codes from content intended for a customer. Define and
enforce the owner/assigned-crew scope through both the new surface and any
direct-table/view path it relies on; a UI filter is not authorization.
Preserve legitimate existing admin reads and document any compatibility
effect of narrowing existing policies.

Provide a simple owner/admin annotation tool for explicitly defined work
zones. Use known coordinates or a clearly identified image coordinate space;
unanchored drawings cannot masquerade as geographic polygons. Distinguish
instructions from surveyed/property boundaries. Missing coordinates remain
missing; no guessed entrance, fabricated measurements or automatic geofence.
Include a keyboard-accessible alternative to pointer-only drawing.

This is the management editor/data contract only. Codex owns the field map,
navigation handoff, offline rendering and Maps SDK decision in 12.2. Do not
promise offline basemap or Google satellite caching or add a map dependency
to Codex-owned package files.

### 4. Assigned-job events and customer actions

Support deliberate crew reporting of blocked access and equipment breakdown,
with attribution, reason, timestamp and explicit resolution state. A report
must not mark the job completed or silently cancel its commercial obligation.
Keep cancelled, skipped, blocked, work-finished and accepted-completed states
distinct. Completion still goes through the 11.1 evidence/version/history
guards; dispatch must not introduce a new completion bypass.

Implement crew-triggered "On the way" and access-request operations through
the existing notification pipeline. Do not send automatically on opening a
screen, changing a route or observing location. Restrict recipient/contact
access to the appropriate job and actor. Preserve private access codes.

Distinguish an accepted notification request, provider delivery, provider
failure and an unknown delivery outcome. Prevent duplicate logical requests;
describe honest retry behaviour if the provider lacks idempotency or outcome
lookup. Missing SMS configuration is an explicit unavailable state, not a
successful send. Implement and test with provider doubles; send no real
customer/staff messages and change no live provider/settings configuration.

## Independent handoff for Codex 12.2

Push `docs/dispatch-contract-v1.md` with exact supported reads, mutation
signatures, types/defaults/nullability, result envelopes, scope, ordering and
operating-day bounds, revision/lock rules, replay and changed-intent behaviour,
error codes, load-plan effects, issue states and notification receipt/delivery
semantics. Explain where it reads existing property data instead of copying
private columns into a second privileged endpoint.

Generate deterministic fixtures from the real disposable backend for:

- One-car default and explicit assignment; optional Car B and unassigned work.
- Reorder/reassignment, stale revisions and concurrent edits.
- Shared-equipment conflicts and stale load confirmation after dispatch edits.
- Seasonal install/removal stages without fabricated physical moves.
- Owner-triggered winter work without invented weather thresholds.
- Missing coordinates/instructions and private-code scope refusals.
- Blocked access/breakdown and resolution, distinct from completion.
- On-the-way/access requests, duplicate and changed-intent retry, provider
  failure, missing configuration and unknown outcome.

Push fixtures, migration list/order, findings and the integrator suite list
to the shared repository. Provide a complete frozen snapshot so Codex can
implement against an injected adapter without adopting your branch. New
admin modules must work standalone with supplied adapters; do not edit the
desktop router just to register a new screen.

## Boundaries and verification

- Yours: backend/migrations, `admin/js/lib/api.js`, owned admin planning and
  property/customer views, scoped management CSS and your admin/backend tests.
- Read-only: Codex field/mobile/offline/native/navigation/build files,
  `admin/js/field.js`, `admin/js/main.js`, `admin.css`, package/lockfiles,
  shared auth/DOM/format/harness and `tests/run-regression.sh`. No field map,
  camera/dictation/completion UI or outbox handler on Codex's behalf.
- No live migrations, grant/data/settings changes, external messages, merge,
  deployment or APK publication. The last corrective reports 20 pending
  migrations; recount and rehearse the actual complete sequence, not a pinned
  historical total. Local DB work must fail closed unless explicitly disposable.
- Preserve backend-only pricing, sent/accepted quote freezes, completion
  evidence/history, reservation conservation, kit/offcut accounting,
  usable/damaged, exact/estimated, quantity/level and seasonal ownership.
- Do not seed Car B or invent supplier specifications, product strengths,
  pack conversions, chemical dosages, renewal cutoffs, the operating timezone,
  evidence-policy answers or the missing Permanent Lighting Phase D document.
- Reuse existing operating-day timezone configuration; UTC while unconfigured
  remains visible. Proposed/advisory evidence policies do not become blocking.
- Test direct-write bypass, owner/crew/anonymous and cross-car/private-note
  access; races/replay/changed intent; notification failure/recovery; stale
  load confirmation; unchanged stock on planning edits; and completion/quote
  protection. Re-run affected existing backend/admin suites.
- Inspect changed controls at 390/430/desktop, including actual screenshots
  and keyboard operation. An overflow measurement alone is not visual QA.
- Report passed, failed, skipped, expected-failure and UNRUN separately.
  Keep disposable DB, mocked browser, provider-double, live Supabase and
  production outcomes distinct. No tested-on-local claim implies live readiness.

Finish with base/final SHA, branch, delivered scope, contract/fixture repo
links, verification, actual migration count/status and concrete remaining
decisions. Push all Markdown handoffs. Stop after 12.1; do not start 12.2,
11.2, 13.1 or an integration/deployment batch.
