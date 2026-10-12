# Batch 10.2 — frozen daily-load contract check

Codex base: `bb899a2b09b1ef3d81e357bb8b76e6c4e97b129f`, after `a5abe0d`.
Review target: Claude `1ffafc21e0a268610735eda2f82a16b9a56da223`.
Branch: `codex/batch-10-2`.

**Implementation has not started.** The assignment explicitly says to stop
if the contract lacks something needed, rather than invent an RPC, field or
error. This handoff records those gaps and concrete source discrepancies.
It does not modify Claude's backend or the earlier seven seasonal findings.

Sources at the immutable review commit:

- [C — daily-load contract](https://github.com/NovaShield-Services/nova-shield/blob/1ffafc21e0a268610735eda2f82a16b9a56da223/docs/daily-load-contract-v1.md)
- [O — load operations](https://github.com/NovaShield-Services/nova-shield/blob/1ffafc21e0a268610735eda2f82a16b9a56da223/supabase/migrations/20261011111000_batch10_1_load_operations.sql)
- [P — load planning schema](https://github.com/NovaShield-Services/nova-shield/blob/1ffafc21e0a268610735eda2f82a16b9a56da223/supabase/migrations/20261011110000_batch10_1_load_planning.sql)
- [A — Claude API](https://github.com/NovaShield-Services/nova-shield/blob/1ffafc21e0a268610735eda2f82a16b9a56da223/admin/js/lib/api.js)
- [F — generated fixtures](https://github.com/NovaShield-Services/nova-shield/blob/1ffafc21e0a268610735eda2f82a16b9a56da223/tests/fixtures/daily-load-v1.json)

This is **read-only source inspection**, not a PostgreSQL reproduction, live
probe or UI result. The supplied JSON parses and contains the fourteen named
scenarios. Generation establishes provenance; it does not establish every
operation, mutation sequence or claim in the document.

## Required contract additions and corrections

1. **Freeze the existing read path, including its actual DTO.** C:67 makes
   `build_load_plan` owner-only and revision-generating; opening a crew page
   cannot call it. C describes its response, but does not specify how a crew
   retrieves the current/confirmed/closed plan, allowed vehicles or the day's
   authorized visit summaries. A:1050 already implements `getLoadPlan` using
   `ns_load_plan_view`; it is not absent from the implementation. Its DTO
   differs from C:79–86: it omits location ID, unassigned-job count,
   needs-review count and note, and excludes closed plans. Define the supported
   read endpoint/query, exact result, empty/closed/unavailable cases, role and
   location scope, work-date/timezone and vehicle/visit reads in the contract.
   Codex must not copy this implementation or invent a replacement shape.
   Document the intended recovery after a 23514, including how to read a newer
   plan and the owner-only rebuild/refusal flow for crews.

2. **Manual Keep removal does not reverse the live recommendation.**
   O:583–592 deletes the durable Keep on `p_keep=false`, but O:597–602 only
   converts `return` to `keep` on true. False leaves both action and the
   "Kept back on purpose" reason in place. Return → Keep → clear therefore
   leaves a live Keep line with `manual_keep=false`. Confirm skips it rather
   than returning the item. A rebuild would restore the recommendation, but
   building is owner-only. Define and implement the crew's reversible flow
   without requiring the phone to fabricate authoritative recommendations.
   Add an authoritative fixture for Keep → clear → confirm/rebuild, not just
   the existing single manual-Keep snapshot.

3. **Replay rules contradict the SQL.** C:310–318 promises every mutation
   remembers its key, rejects changed payloads and safely retries lost
   responses. `set_manual_keep` O:548–617 validates its key but never stores
   or looks it up; its response has no `replayed` field. A late retry of a Keep
   after it was cleared can reapply it. Exception O:664–668 and reconciliation
   O:899–902 return on the old key without comparing immutable intent.
   Reconciliation returns before the location check at O:910, permitting a
   crew replay path to return another location's receipt. Confirmation
   O:747–754 uses plan status for early replay instead of binding the supplied
   key/payload; changed revision/fingerprint can be ignored on that path.
   Define enforced key/intent/scope rules per operation and regenerate
   operation-specific fixtures. `duplicate_retry` currently exercises plan
   **building**, not confirmation, manual Keep, exceptions or day closing.

4. **Document mutation receipts completely.** C:171–176 and C:217–226 give
   Keep/exception request names without full types or result schemas; C
   section 8 does not specify reconciliation's result. O:609–615,
   O:693–694 and O:1025–1057 show different existing responses. Freeze these
   exact supported results, nullable fields and accepted/replayed behaviour,
   with success/lost-response/refusal examples. A fixture inferred from SQL
   would not satisfy the assignment's no-guessed-contract requirement.
   Also define the current closing-count basis: C:39 says plan quantities
   are generation-time snapshots; they cannot be treated as current balances
   to validate variance reasons after loading/consumption.

5. **Damaged closing variance adjusts the wrong pool.** O:975–979 compares
   `counted_qty` to the view's `on_hand`. The stock view defines `on_hand` as
   **usable**, with `damaged_on_hand` separate (the 8.1 reservations migration,
   lines 364–389). O:1000–1009 then posts the difference to the damaged pool
   when the reason is damaged. With 10 usable, 0 damaged, and a usable count
   of 8, delta −2 posts to damaged: usable stays 10 and damaged becomes −2.
   That does not make the ledger agree with the van as C:249 claims. Specify
   whether the count is usable/total and whether damaged items are retained
   or written off; correct the relevant pool movements in Claude's files.
   Codex must not relabel the reason or simulate those ledger changes locally.
   Add a backend-generated reconciliation fixture for that case.

6. **Specify how an exception affects physical confirmation.** O:677–692
   stores/links an exception ID. The build/confirm code never consults
   `skip_required`/`carry_extra`; confirmation O:794–837 still transfers all
   applicable Add/Return lines. The response serializer also does not expose
   the linked exception. C:223–225 describes going without or taking an extra,
   but does not define the resulting rows or transfer effects. An authorized
   skip cannot be portrayed as permission to omit an item while confirming
   still transfers it. Decide and freeze the supported effect/read response,
   including extra items absent from the current plan and shortage handling.

These are 10.1 findings, separate from the seven seasonal findings handed to
Claude earlier. No fixes or live probes have been performed here. The suggested
cases above are acceptance needs, not invented wire fields or operations.

## Ownership clarification resolved

The owner explicitly authorized **Codex-owned field/mobile files** within
`admin/js/**`, including the field router, `field-load-gate.js`, outbox and
field views. Claude-owned API, inventory/management and backend files remain
protected. This resolves the brief's blanket path prohibition; no further
scope confirmation is needed. No JavaScript has changed in this checkpoint.
Keeping `/load` gated off preserves measurement and Back guards while the
contract findings above remain unresolved.

## Outbox decision

**No fifth type added.** Existing v3 schema, payloads and four handlers remain
unchanged. For the prospective first load interface, use online-only mutations
unless a corrected per-operation replay contract justifies queueing. Retain
unsent local drafts honestly and never label an offline draft accepted stock.
This is a design decision for resumption, not a shipped new online-only UI.

## Verification status

- Completed: actual base/source SHAs verified; frozen documents, API read
  wrapper, SQL and fourteen JSON scenarios inspected; JSON parsing/scenario
  presence checks pass; existing branch was clean before this report.
- Failed: no current application tests were run, so no runtime failure count
  is claimed. Source discrepancies above require Claude's disposable DB
  reproductions; previous 574-check results are not new passes for 10.2.
- Skipped: no selected test was disabled or skipped.
- **UNRUN:** 10.2 touch/keyboard, restart, two-vehicle state, mutation retries,
  conflict rendering, level/unknown display and day closing because the
  interface has not been implemented pending the contract corrections.
  APK/build/browser regression was not rerun for a Markdown-only
  report. Emulator/device/live DB/production remain outside this task.

Resume after a versioned contract/fixture corrective; owned-file authorization
is already granted. Do not merge Claude, loosen permissions, invent a read/receipt
shape, infer authoritative load changes locally or start 11.2.
