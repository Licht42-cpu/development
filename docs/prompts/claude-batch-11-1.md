# Claude — Batch 11.1: evidence, completion and material-history protection

Execute this on your own branch, independently of Codex. You own X.1;
Codex owns X.2. Complete this assignment, test, commit and push, then stop.

## Starting point

Read repository instructions and the maintained roadmap first. Expected base:
`claude/batch-8-1@1ffafc2`, following permanent-lighting corrective `2b628b3`.
Report your actual SHA and preserve any newer authorized work. Do not merge,
rebase or cherry-pick Codex. Codex's 10.2 interface remains a separate task;
your 11.1 must not depend on its implementation or next push.

Read your stock v1.2, seasonal, permanent-lighting and daily-load contracts.
Read Codex's seven source findings at `a5abe0d`:
`docs/reviews/seasonal-contract-abedf0f.md`. Fetch/show that document read-only
if absent locally; do not import Codex implementation files. It is available
in NovaShield-Services/nova-shield, not a container-only handoff path.

## A. Corrective before new completion enforcement

Reproduce each seasonal finding against a disposable database and give it a
disposition: fixed, disproved with evidence, or a clearly identified contract
decision. The four newer migrations did not change the reviewed seasonal SQL.

Address replay authorization before returns; build/strip accounting and losses;
suffixed-key collisions/provenance; retirement before release; assignment
versus physically aboard; nullable/overlapping availability; and state no-op
keys or same-key changed intent. Do not merely edit prose around an actual
authorization or accounting defect. Do not invent a new salvage policy without
recording the decision needed. Complete unaffected work if a business answer
is necessary, and state exactly what remains blocked.

Use follow-up migrations, preserve historical migration files, and version
any changed contract behaviour explicitly. Regenerate affected authoritative
fixtures. Keep the daily-load wire contract stable for Codex; if a correction
requires a change, document compatibility and its precise impact. This is a
bounded correction, not permission to rebuild inventory or the load system.

## B. Implement the backend completion/evidence contract

1. Make evidence requirements service-specific and owner-configurable:
   appropriate before/after cleaning evidence; installation/component evidence
   for lighting; configurable quick winter proof. Reuse existing service/job
   and attachment models. Publish proposed initial policies as assumptions
   for owner review, not previously confirmed business rules. Unsupported or
   missing configuration must be explicit; unknown must never render as zero
   or sufficient evidence. Avoid requiring duplicate photos for every line
   when one image legitimately covers several service scopes.

2. Preserve original capture metadata separately from server receipt time,
   attributed actor, job and evidence purpose. Missing GPS/time must have
   explicit states. Watermarks and client timestamps are presentation/claims,
   not trusted proof. Validate evidence ownership, upload availability and
   job linkage server-side; a guessed path must not count as valid evidence.
   Do not automatically block all GPS-unavailable jobs unless policy requires
   it. Use explicit, attributed exception rules where appropriate.

3. Accept completion through a transactional, authorized server operation
   with version/conflict checks and a caller-generated retry key. Repeated
   requests create one accepted event; changed intent under an existing key
   is rejected. Check permission on replay too. Close the direct-update path
   so authenticated callers cannot bypass evidence by changing job status.
   Preserve legitimate existing job transitions and quote safeguards.

4. Offline work finished is provisional until evidence arrives and the server
   accepts it. Specify stale/missing-evidence/permission/conflict responses
   and safe lost-response recovery. Rejection must leave client evidence and
   drafts recoverable. Do not implement mobile persistence or an outbox handler
   on Codex's behalf; define the operation contract for later 11.2.

5. Freeze accepted completion evidence references and attributed consumption
   history. Prevent edits/deletions and unapproved late consumption, including
   direct API/table paths. Corrections must append an authorized, reasoned,
   linked record rather than rewrite the original. Define reopening/correction
   permissions explicitly. Preserve intended internal-note editability.
   Do not debit materials twice when reservations have already been consumed.
   Vehicle-day reconciliation is not job completion and must not freeze
   unrelated jobs or masquerade as job consumption.

6. Use existing backend pricing and change-order/upsell paths for additional
   work. A crew cannot approve its own paid change or rewrite sent/accepted
   quote money, labels, terms or customer notes. Completion does not silently
   approve additional work or bypass an accepted-quote guard.

## C. Frozen handoff for Codex

Push `docs/completion-evidence-contract-v1.md` with exact SQL/PostgREST
signatures, defaults/types/nullability, result shapes, permissions, policy
version, stale/retry semantics, errors and correction rules. Specify whether
accepted receipts are immutable or return current state. Include compatibility
with existing completion calls and migration order.

Generate deterministic fixtures from the disposable backend for cleaning,
lighting, quick winter proof, missing metadata/evidence, denied access,
stale policy/job, same-key retry, changed intent, lost response, locked history
and reasoned correction. These must exercise server enforcement, not only UI
models. Provide one accurate contract and fixture snapshot for independent
11.2 development.

Only add a minimal owner/admin policy or exception surface if needed to make
the backend usable. Use owned management files and scoped CSS. No field
completion screen, gesture flow, dictation, camera redesign or watermark UI.

## Constraints and verification

- One crew now, maximum two; separate vehicles, Base/Car A/optional Car B.
  Do not seed Car B or build a fleet/roster/tracking system.
- Nova Shield owns seasonal lights; installation, recovery, inspection,
  release and commercial assignment remain distinct. Preserve kit/component,
  offcut, usable/damaged, exact/estimated and quantity/level distinctions.
- Do not invent supplier specifications, chemical dosages, pack conversions,
  renewal cutoffs or the missing Permanent Lighting Phase D document.
- No live migrations, grants, data/settings changes, external messages, merge,
  deployment or APK publication. Local migrations/tests target only an
  explicitly disposable database with a fail-closed production guard.
- Do not edit Codex field/mobile/offline/native/navigation/build files,
  `admin.css`, shared DOM/format/harness or `tests/run-regression.sh`.
  Register new owned suites only in your existing separate admin/DB mechanisms
  and provide the integrator list. Keep browser, database and live integration
  outcomes distinct.
- Test direct-write bypass, owner/crew/anonymous access, cross-car replay,
  concurrent/duplicate completion, changed retry payload, missing evidence,
  stale state, immutable history, corrections and quote protection. Rerun
  affected seasonal/stock/load and existing relevant regression suites.
  Rehearse the entire pending migration sequence in filename order; report
  the actual pending count. Disposable PostgreSQL is not live Supabase proof.
- Inspect 390/430px and desktop if any admin controls change; cover keyboard
  access. Keep passed, failed, skipped, expected-failure and UNRUN distinct.

Finish with base/final SHA, branch, corrective dispositions, implementation
scope, contract/fixture repo links, test evidence, migration count/status and
remaining business questions. Push every Markdown report/handoff to the shared
repo. Stop after this assignment; do not start 12.1, 10.2 or 11.2.
