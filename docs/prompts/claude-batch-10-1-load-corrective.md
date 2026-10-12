# Claude — Batch 10.1 corrective: unblock the field load interface

Execute this bounded corrective now. Do not start 12.1 yet. You own the
backend/admin work; Codex owns the field interface. Complete, test, commit and
push this assignment, then stop.

## Start from your completed 11.1

Expected base: `claude/batch-8-1@32963a3`. Verify and report your actual SHA;
preserve newer authorized work. Read repository instructions and current
contracts. Do not merge, rebase or cherry-pick Codex's implementation, and do
not wait for its next push.

Your 11.1 seasonal corrections are distinct from the **six daily-load findings**
that still block 10.2. At `32963a3`, the reviewed load-operations migration is
unchanged from `1ffafc2`; daily-load v1.1 explicitly preserves those operations.
Do not redo the completed seven-point seasonal corrective.

Read the six findings, including exact file/line evidence, from:

https://github.com/NovaShield-Services/nova-shield/blob/b948db3e05292a8421303d0cc4cb469b39a7927d/docs/reviews/daily-load-contract-1ffafc2.md

Fetch/show that Markdown read-only if needed. It is already in the shared repo.
The owner has resolved file scope: Codex may edit its field/mobile files;
Claude-owned API, inventory, management and backend files remain protected.

## Resolve all six findings

1. **Freeze supported reads.** Document the existing crew-safe read path for
   a vehicle/date plan, its exact DTO, empty/confirmed/closed cases, visible
   vehicles and authorized visit/address/access-note reads. `getLoadPlan()`
   already exists in your API; document it instead of making Codex copy it
   or guess its shape. Reconcile its missing fields with the build response.
   State the work-date timezone. Define stale-conflict recovery and a crew's
   owner-only rebuild/refusal flow without silently widening permissions.

2. **Make Manual Keep reversible.** Reproduce Return → Keep → clear → confirm.
   Clearing currently removes the hold but leaves action `keep` and its old
   reason. Restore the authoritative recommendation/reason server-side, using
   the whole day's needs. A crew must not need an owner rebuild merely to
   undo its own Keep. Do not blindly change every cleared item to Return:
   something needed by another stop must remain aboard. Define how changes
   affect the plan revision/fingerprint so confirmation does not accept an
   unseen recommendation change.

3. **Enforce the published retry contract for every mutation.** Manual Keep
   currently validates a key without remembering it; exception/reconciliation
   replay does not compare intent, and reconciliation returns before checking
   location scope. Confirmation replays on plan status rather than binding the
   supplied key/intent. Implement per-operation key binding, scope checks on
   replay, changed-intent refusal and concurrent duplicate safety. A late retry
   of an old Keep must not reapply it after a clear; specify an honest conflict
   or receipt outcome. Preserve original accepted effects when current state
   changes. Do not weaken stock conservation or bypass existing ledger APIs.

4. **Freeze full signatures and receipts.** Specify every read/mutation's
   types, defaults, nullability, result/error schemas and permissions. Define
   accepted versus replayed/current-state results for Manual Keep, exceptions,
   confirmation and reconciliation. Provide the current closing-count basis;
   morning plan snapshots are not current vehicle balances. Make the evidence
   distinguish no response, refusal, conflict and accepted work without adding
   imaginary success fields to client fixtures.

5. **Correct damaged reconciliation accounting.** `on_hand` is usable stock;
   posting its variance into the damaged pool leaves usable unchanged. Reproduce
   10 usable / 0 damaged → usable count 8 with reason damaged. Specify usable
   versus total counts and retained damage versus write-off explicitly, then
   post the correct audited movements atomically. Do not fabricate missing
   quantities, create negative damaged stock or silently count damage usable.
   Normal, estimated, level, damage and unconfirmed-day closing must all work.
   Keep this compatible with 11.1's consumption-history guards; a vehicle-day
   correction must not rewrite a completed job's original consumption.

6. **Make exceptions effective and observable.** Define and enforce how
   `skip_required` and `carry_extra` affect recommendations and confirmation.
   Merely linking an exception ID while still transferring all required lines
   is insufficient. Handle an extra item not already in the plan, expose the
   authorization/reason in supported reads, and preserve crew `42501` refusals.
   Required lines, shortages, missing information and physical confirmation
   must remain separate; an exception must not invent stock or move it early.

For each finding, reproduce it or disprove it with concrete evidence. Record
the disposition. If a genuine business choice is needed, identify it plainly
and complete unaffected corrections; do not hide it behind a default. Do not
turn this into a redesign of the stock, completion or seasonal systems.

## Deliver the corrected contract and authoritative fixtures

Version the daily-load contract beyond v1.1, explaining compatibility for
existing API/admin callers. Make documentation, SQL and API agree. Use new
follow-up migrations ordered **after the latest pending migration**; do not
rewrite already-pushed history or back-date a file ahead of its prerequisites.

Regenerate the existing 14 scenarios and add real backend cases for:

- crew plan reads and closed/empty states;
- Keep → clear, whole-day required tools, and a late old-key retry;
- same-key same-intent and changed-intent calls for every mutation;
- cross-car/changed-role replay refusal and concurrent duplicates;
- actual confirmation retries with no second physical transfer;
- reconciliation success/replay, damaged pools, levels and closing without
  prior confirmation;
- effective skip/extra exceptions, shortage and stale-plan recovery.

Fixture generation proves provenance, not completeness. Generate twice and
verify deterministic output. Publish exact source/version references and
fixtures so Codex can implement independently without merging your branch.

## Boundaries and verification

- One crew now, maximum two; one Base, Car A and optional Car B. No seeded
  Car B, fleet, automatic routing or background tracking.
- Keep price calculations in the backend; preserve quote freezes, reviewed
  kit/offcut accounting, seasonal ownership and completed evidence/history.
- Preserve proposed/advisory versus confirmed/blocking evidence policies.
  Do not silently answer the seven 11.1 business questions or invent product
  specifications, chemical dosages or the missing Phase D document.
- You may edit your migrations, `api.js`, owned load/admin components, contract
  documents and backend/admin tests. Do not edit Codex field/mobile/offline/
  native/navigation/build files, `admin.css`, shared DOM/format/harness or
  `tests/run-regression.sh`.
- No live migrations, data/grant/settings changes, external messages, merge,
  deployment or APK publication. Disposable DB tests require a fail-closed
  production guard. Leave native sync/build to Codex/integration; a sync on
  an unmerged Codex checkout cannot package your newer API automatically.
- Run meaningful backend authorization, replay, concurrency, conservation and
  refusal checks; show fail-without-fix evidence for corrected defects. Rerun
  affected stock/seasonal/load/completion suites and relevant admin regression.
  Rehearse the full pending migration sequence in filename order; report the
  actual new count, not the earlier 18 as a permanent constant.
- If admin controls change, inspect 390/430px and desktop screenshots and
  keyboard access. Report passed, failed, skipped, expected-failure and UNRUN
  distinctly. Local PostgreSQL is not live Supabase or production proof.

Finish with base/final SHA, branch, six dispositions, exact compatibility
changes, contract/fixture links, tests and migration status. Commit and push
every Markdown handoff to NovaShield-Services/nova-shield. Stop after this
corrective; do not start 12.1, Codex's 10.2 or 11.2.
