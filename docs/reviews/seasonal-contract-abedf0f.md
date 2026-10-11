# Seasonal contract review for Batch 10.2-prep

Reviewed **abedf0f6e3eb1fda2fd336c5dd34186f8340b4b0** on
`claude/batch-8-1`, against its predecessor `19b3c86`. Codex implementation
base is **e4259466087850a503cd5f6884fe54a22f72ebd1**. This is static,
read-only inspection, not a database reproduction or production finding.
No Claude implementation, fixture or migration was imported or changed.

Immutable sources (all line references below use this commit):

- [Contract](https://github.com/NovaShield-Services/nova-shield/blob/abedf0f6e3eb1fda2fd336c5dd34186f8340b4b0/docs/seasonal-sets-contract-v1.md), abbreviated **C**.
- [Identity migration](https://github.com/NovaShield-Services/nova-shield/blob/abedf0f6e3eb1fda2fd336c5dd34186f8340b4b0/supabase/migrations/20261011090000_batch9_1_seasonal_set_identity_and_assignments.sql), **I**.
- [Operations migration](https://github.com/NovaShield-Services/nova-shield/blob/abedf0f6e3eb1fda2fd336c5dd34186f8340b4b0/supabase/migrations/20261011091000_batch9_1_seasonal_operations.sql), **O**.
- [Existing stock operations](https://github.com/NovaShield-Services/nova-shield/blob/abedf0f6e3eb1fda2fd336c5dd34186f8340b4b0/supabase/migrations/20261010130000_batch8_1_stock_operations_contract_v1.sql), **S**.

## Numbered findings for Claude

1. **High: crew replay returns before location authorization.** O:558–565
   returns an install replay before `can_handle_set` at O:574; recovery does
   the same at O:661–668 before O:685/708, inspection at O:804–811 before
   O:827. Each is SECURITY DEFINER: the returned set/assignment comes from
   O:120–177 with function-owner access. A crew with another operation's key
   can take this return path even when the set is now at another vehicle.
   This contradicts the scoped calls in C §8. Check scope on the replayed
   target too; do not authorize the caller's supplied target and return a
   different target. This is a read disclosure path, not evidence of a
   repeated physical write. I:380–381 and I:400–401 also let every admin read
   every assignment/event, including operation keys; that broader read scope
   needs an explicit decision. Null-location deployed sets being handleable
   by all crews is **documented** at C §8/O:67–80, not a newly discovered
   mismatch. Actual crew membership and production privileges **cannot be
   determined from the source**.

2. **High: §7's conservation expression is not an invariant for all allowed
   inputs.** O:265–285 consumes a build quantity. O:1117–1145 permits any
   positive strip quantity and an explicit different material/location,
   without comparing them with that build. O:1148–1152 marks the entire set
   stripped. Build 200, strip 150 at the same basis: stock rises 150 while
   the expression removes 200 held in sets, dropping the total by 50. Strip
   250 instead creates 50 in that expression; a different material/location
   also breaks the stated per-material/location basis. A bought-assembled
   set has no build debit yet can post a positive strip receipt. Assign,
   cancel, install, recover, inspect, release and renewal do not post stock;
   ordinary register/retire without build/strip do not either. Retire without
   stripping deliberately keeps its original held quantity. Thus the
   equal-quantity, same-basis example is valid, but not every allowed build/
   strip. Decide how salvage, loss, external assembled receipts and location
   attribution should be accounted for, then enforce/document that rule.

3. **High: suffixed replay keys do not protect build/strip provenance.**
   The event key and `:build`/`:strip` keys match C §4 and O:278–285/1138–1145.
   However S:144–153 returns an existing operation for **any** of receipt,
   consumption, correction or opening, before validating the new payload.
   The seasonal caller trusts its returned operation ID. Preposting an
   ordinary movement under `K:build`, even with different material/quantity
   or another movement kind in that family, allows register `K` to attach
   that operation without its intended debit. The strip path has the same
   problem. Neither namespace reservation nor immutable-payload/provenance
   comparison is present. The stock weakness predates 9.1; reusing it here
   exposes a new accounting dependency. Normal retries do not post twice,
   but a distinct request reusing a key is not rejected as C:189–192 claims.
   This needs a binding/namespace decision before queueing these operations.

4. **Medium: retirement can precede release of an open recovered assignment.**
   I:229–231 correctly treats `removed` as open. O:1109–1115 only rejects
   `assigned`/`installed`, so a recovered set can be retired while its
   removed assignment remains open. The deferred guard I:282–298 only checks
   installed/deployed consistency and does not close this case. This differs
   from the RPC's own “recover and release ... before retiring” message and
   the lifecycle in C §2. It does not permit a second open assignment, but
   leaves a commercial promise open while retiring/stripping its asset.

5. **Blocking input for 10.2: §11 confuses a promise with a physical load.**
   C §11 correctly establishes UUID identity and that a set is not stock.
   Its final bullet calls `assigned` sets “loaded but not yet up.” Assign
   O:428–435 only creates a customer assignment; it does not move the set's
   physical location. The owner-only caller records `current_crew_vehicle()`
   rather than choosing a crew's vehicle. A set can remain at Base while
   assigned. Filtering assignments also does not distinguish Car A from B,
   and `assigned` in “out at this customer” includes a set not installed yet.
   A Keep/Add/Return row still needs authoritative per-car aboard status,
   planned destination/visit, commercial hold, condition/inspection reasons,
   physical movement/confirmation rules, actor scope, and revision/conflict
   behaviour. The nine seasonal operations provide no general Base-to-car
   whole-set load operation. These are missing **load-contract inputs**,
   not fields Codex has invented or permission to implement a UI.

6. **Medium: availability response is nullable and reasons overlap.**
   I:343 evaluates `a.status = 'removed'` on the left join. Without an open
   assignment it is SQL NULL, serialized by O:171 as `awaiting_release:
   null`, whereas C §5 illustrates false. I:342–347 defines six reason flags;
   several can be true together, contrary to C §6's “exactly one of the five.”
   A removed, damaged set at the repair bench is an example. The availability
   predicate itself is conjunctive and sensible. Specify nullable flags and
   simultaneous reasons (or change SQL in Claude's track); a phone caller
   must not assume an exclusive reason enum or all boolean fields.

7. **Medium: replay guarantees omit state no-ops and changed intent.**
   C:181–183 says every call adds one keyed event. State-idempotent early
   returns such as O:579–580, 690–691, 934–935 and 1105–1106 add none. A new
   key used for such a successful no-op is therefore not remembered and can
   later be used for another operation. Event replay also checks event kind,
   not target or payload (e.g. O:236–243 and O:558–565): same-kind reuse with
   a different set/assignment returns the old target rather than refusing.
   Clarify whether this is key-only retry semantics or immutable intent
   enforcement, and distinguish a state no-op from a recorded keyed result.
   C §5 explicitly says replay returns current rows, not a frozen response;
   that accurately describes the SQL and should govern the “original
   outcome” wording in §4. Seasonal writes remain outside the field outbox.

## Request/response audit

All **nine** SQL signatures match C §3's parameter order, PostgreSQL types,
and defaults. All return JSONB. No signature/default discrepancy found.

| Function | SQL signature starts at O line | Defaulted tail |
| --- | --- | --- |
| register_seasonal_set | 202 | seven optional parameters, all null |
| assign_seasonal_set | 320 | property, job, note null; season year required |
| cancel_seasonal_assignment | 461 | note null |
| install_seasonal_set | 533 | timestamp, job, note null |
| recover_seasonal_set | 633 | location, timestamp, note null |
| inspect_seasonal_set | 779 | note null |
| release_seasonal_set | 891 | note null |
| record_set_renewal | 984 | note null |
| retire_seasonal_set | 1061 | strip material, quantity, location, note null |

A required SQL argument means “no default,” not NOT NULL. Blank/null replay
keys are explicitly rejected. On fresh calls, null season year is rejected
at O:361 and recovery/inspection/renewal enums reject null at O:671/816/1008.
Replay branches can precede these validations (finding 7). Optional
nulls behave as documented (including default destination/time and no build/
strip). Null target IDs fail the lookups; the SQL does not declare function
parameters NOT NULL. The JSON keys in O:120–177 match C §5; assignment null
on set-only calls matches too. Finding 6 is the response-nullability defect.
Exact live PostgREST serialization/client numeric precision **cannot be
determined from the source** and was not probed.

## Frozen stock contract comparison

`git diff 19b3c86 abedf0f -- docs/operations-contract-v1.md` contains only a
companion cross-reference at its opening and a Christmas-sets out-of-scope
bullet. The only changed migration paths in that diff are the two new
seasonal migrations. Their stock interaction is calls to existing
`post_stock_movement`; they do not replace stock functions, grant signatures,
request/response shapes or error definitions. Claude's claim that existing
v1 definitions did not move is supported **at this commit**. Finding 3 is an
interaction problem, not a silent replacement of the stock contract.

19b3c86's earlier stock-document corrections are acknowledged: authorization
is no longer contradictory, the migration list includes all five 8.1 files,
and §4b specifies reservations/releases. These corrections do not supply a
daily load response, plan revision or physical confirmation contract.

No PostgreSQL suite, live grant probe, migration rehearsal or production
verification was run for this review. Claude's reported database/browser
results are not recounted as independent Codex passes.
