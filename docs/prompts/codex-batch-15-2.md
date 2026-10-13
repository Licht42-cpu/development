# Codex — Batch 15.2: final native candidate, regression and field runbook

## Standing

Execute Batch 15.2 using this complete assignment. It was blocked only because
no authorised integrated candidate existed. `codex/integration-candidate`
is now that candidate, so 15.2 is authorised and is your next work.

Start from `codex/integration-candidate`, verifying your starting SHA against
`52510c3` (candidate code `de9e5d7`; the two later commits are the handoff
document and its evidence-pointer clarification). Work on a branch of your
own; do not merge, rebase or cherry-pick Claude's branch.

## What changed on Claude's side since your source pin

Your candidate pinned Claude's source at `f08edfd` and recorded **28 source
migrations after the `20261009013557` cutoff**. Claude has since shipped
**Batch 15.1 at `5169d7b`** on `claude/batch-8-1`. Read it before you audit,
because three of your recorded numbers are now stale:

- **31 pending migrations, not 28.** 15.1 added
  `20261018090000_batch15_1_crew_scope_reconciliation.sql`,
  `20261018100000_batch15_1_revoke_public_execute_on_trigger_functions.sql`
  and `20261018110000_batch15_1_rls_on_handover_tables.sql`.
- **Your finding 5 is answered.** The `can_work_job` / `ns_can_work_job`
  disagreement is fixed by one rule, `ns_job_crew_scope(uuid)`, which both
  predicates now delegate to. Nothing changes while one vehicle is active.
  A crew that is refused an unassigned job can now claim it with
  `claim_job_for_vehicle`, and `assign_job_to_vehicle` became owner-only with
  its signature unchanged. `admin/js/components/dispatch-day.js` gained a
  crew-only "This one is on my car" control, and `admin/js/lib/api.js` gained
  `jobCrewScope` and `claimJobForVehicle`.
- **`docs/release-runbook-v1.md` now exists** and is the authority for
  application order, per-group recovery and the second-crew sequence. Your
  field runbook must not contradict it; where it already answers a question,
  cite it rather than restating it differently.

Refresh your source pin to `5169d7b` under the same unchanged-copy rule and
the same evidence recording you used for `f08edfd`, so the candidate you
qualify is the one the runbook describes. If you decline to refresh, say so
and qualify the older pin explicitly — do not leave the pin ambiguous.

**Your finding 1 — material creation cannot select the new units or level
tracking — is Claude's to fix, not yours.** It is recorded as Claude-owned
follow-up. Do not edit `admin/js/views/inventory.js` for it. The same holds
for findings 2 and 3; report them again if they survive, and do not fix them
in Claude's files.

## Scope

Build and audit the authorised integrated candidate, then qualify it as far
as this container honestly allows:

1. **Rebuild and re-audit the packaged candidate.** Capacitor sync and asset
   audit, native debug assembly, staged-bytes-to-APK binding, pinned
   dependency versions, the packaged version string and the declared
   permission set. State what each check proves and what it does not.
2. **Rerun the explicit relevant suites.** The shared/local suite set, the
   router integration suite, the final affected field/local suites, the
   native bundle check and the qualification-record validator. Report the
   distinct-case counts as you did before, with the declared fault
   injections still failing as declared.
3. **Device checks, including any 14.2 additions, stay UNRUN.** There is no
   handset. Report the 16 physical-device cases from 13.2, plus every device
   check 15.2 itself names, as **UNRUN with the reason** — not skipped, not
   passed by proxy, not inferred from a successful build. If 14.2 was never
   authorised, say that instead of inventing its cases.
4. **Accessible and tactile visual QA.** Keyboard traversal, focus order,
   accessible names, hit-target sizes and the full-page captures at
   390/430/1280 across every newly wired surface. Gloved-hand and
   outdoor-legibility judgements are design review, not test results —
   label them as such.
5. **Offline, restart and sync scenarios.** Cold start, backgrounded restart,
   offline capture, queue survival across restart, and replay on
   reconnection. **Do not claim sync succeeded without server confirmation.**
   A queued operation that left the device is not a delivered operation; a
   local success state is a local success state.
6. **Support, recovery and known-limitations runbook** for whoever holds the
   handset in the field: what to do when the queue will not drain, when a
   screen reports unavailable, when a photograph will not attach, when the
   app was reinstalled, and when the crew is told a job is not theirs.
   Reference `docs/release-runbook-v1.md` for anything backend-side.

## The hard constraint on every newly wired screen

**All 31 migrations remain written-to-disk and unapplied to the live
project.** Every screen you wired must therefore keep showing its explicit,
named, reachable unavailable state against the real backend — it must not
imply a working backend, must not synthesize data, and must not hide the
route. Your availability probes already do this; 15.2's job is to prove they
still do after the rebuild, and to say plainly in the runbook that these
screens are expected to read unavailable until the owner applies the chain.

A screen that looks ready because a probe was loosened is worse than one that
says it is not ready.

## Ownership and gates

- Claude's components, API, contracts, schemas, migrations and phase suites
  remain Claude's. Copy unchanged, report findings, do not edit.
- Your field/mobile files, the native build scripts, the router wrapper, the
  Codex suites and `tests/run-regression.sh` remain yours.
- **The owner's separate explicit instruction is required for:** merging any
  track, applying production migrations, changing production data, grants or
  settings, sending any external customer message, publishing an APK, and
  deploying anything. None of that is in this batch.
- Do not invent supplier specifications, chemical dosages, pack conversions,
  renewal cutoffs or the missing Permanent Lighting Phase D document.
- Do not alter any backend rule. If a rule is wrong, report it.

## Reporting rules

- Keep **passed, failed, skipped, expected-failure and UNRUN** distinct. An
  expected failure is one declared before the run, not one relabelled after.
- Keep **browser, database, native build, emulator, physical device, provider
  sandbox and production** outcomes distinct. A green build is not a working
  app; a passing browser suite is not a verified backend.
- Count distinct cases, not repeated executions, and keep the raw logs'
  boundaries visible.
- Name every limitation you leave open, including the ones you inherited.

Commit and push your branch with the runbook, the refreshed evidence and the
findings. No live changes, merging or deployment. Stop after 15.2.
