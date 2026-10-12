# Claude — resume the interrupted Batch 10.1 corrective

Continue the **existing** six-finding daily-load corrective. The previous
session reached its limit. Do not restart completed work or start a new batch.

## Recover actual state first

Read repository instructions. Report the actual branch, HEAD, working-tree
changes and recent commits before editing. Expected branch:
`claude/batch-8-1`. Last remotely verified commit is `32963a3` (completed
11.1); the corrective was not yet pushed when Codex checked.

The previous session reported this sequence:

1. Re-read the exact source and confirmed all six daily-load findings.
2. Wrote a follow-up corrective migration.
3. Rehearsed **nineteen** pending migrations in a disposable database.
4. Started/added six backend regression cases, one per finding, intended to
   fail without the fix and pass with it.
5. Reached: **"add a phase26 check for the crew empty-state, then regenerate
   the fixtures as v2."**

Those are reported progress, not proof that files or results survived the
session. Locate and inspect the actual migration, tests, contract drafts and
generator before repeating work. Preserve uncommitted changes. If a new
container lacks them, check the old workspace and reachable commits first.
If they cannot be recovered, say so and reconstruct only what is missing from
the already authorized corrective, rather than claiming recovery or completion.

The full assignment is already pushed:

https://github.com/NovaShield-Services/nova-shield/blob/c7b3ae81460cb8f07065552323f4e5aafa62db53/docs/prompts/claude-batch-10-1-load-corrective.md

The six source findings are here:

https://github.com/NovaShield-Services/nova-shield/blob/b948db3e05292a8421303d0cc4cb469b39a7927d/docs/reviews/daily-load-contract-1ffafc2.md

Read both; fetch/show Markdown read-only if absent locally. Do not merge or
cherry-pick Codex implementation. The seven seasonal findings were already
corrected in your previous batches; do not redo that separate corrective.

## Finish the work in progress

Resolve and verify all six daily-load findings:

- Freeze crew-safe reads with exact DTO, empty/closed cases, vehicle/date/
  timezone scope and authorized visit/address/access-note reads.
- Make Return → Keep → clear restore the server's correct whole-day
  recommendation and reason, without requiring an owner rebuild for an undo.
- Persist operation keys, bind immutable intent, check replay scope and
  handle concurrent duplicates and late retries for every mutation.
- Specify all signatures, nullable fields, mutation receipts, conflict/lost-
  response recovery and the current closing-count basis.
- Correct damaged reconciliation using the right usable/damaged pools and
  explicit retained-damage versus write-off semantics.
- Make skip/extra exceptions affect the actual recommendations/transfers and
  appear in supported reads, with crew refusal preserved.

Complete the phase26 crew empty-state check. Finish and publish:

- `docs/daily-load-contract-v2.md`
- `tests/fixtures/daily-load-v2.json`
- `docs/batch10-1-corrective-findings.md`

These names are promised deliverables; verify whether they exist rather than
assuming they were written. Keep any older frozen contract as historical and
update references/compatibility documentation accurately.

Regenerate v2 fixtures **from the actual disposable backend**. Preserve the
original fourteen scenarios and add operation-specific reads/retries, Keep
undo, changed intent, lost response, denied replay, damaged reconciliation,
unconfirmed closing and effective exception cases. Generate twice and compare
bytes. Do not replace missing backend results with hand-written success data.

## Verification and boundaries

Run the six corrective tests and demonstrate fail-without-fix evidence where
appropriate. Rerun affected stock, seasonal, lighting, load, completion and
admin suites plus relevant regression. Rehearse the complete pending migration
sequence in filename order; report the actual count, which may differ from
the previous session's nineteen. The follow-up must sort after its prerequisites.

Inspect changed admin controls at 390/430px and desktop, including keyboard
use. Report passed, failed, expected-failure, skipped and UNRUN distinctly.
Old-session results are historical until independently reproduced or backed
by saved source-matched evidence. Disposable PostgreSQL is not live Supabase
compatibility or production verification.

Preserve 11.1 completion/evidence and history guards, quote protection and
backend-only pricing. One crew now, maximum two; Car B remains optional data.
Do not invent policy decisions, product specifications or a Phase D document.

Edit only Claude-owned backend/API/admin/contract/test files. Do not touch
Codex field/mobile/offline/native/navigation/build files, `admin.css`, shared
DOM/format/harness or `tests/run-regression.sh`. No live migrations, grants,
data/settings changes, external messages, merge, rebase, deployment or APK
publication. Do not run native sync/build or start 12.1, 10.2 or 11.2.

Before the next handoff, **commit and push** the corrective code, tests,
contract, generated fixtures and Markdown findings to the shared repo. Report
actual base/final SHA, all six dispositions, compatibility changes, verification
and migration status. Codex must not be told it is unblocked until those files
are actually present in a pushed commit.
