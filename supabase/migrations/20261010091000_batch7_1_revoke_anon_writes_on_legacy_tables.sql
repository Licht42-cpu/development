-- Batch 7.1: remove anonymous WRITE access to the three legacy tables.
--
-- This migration deliberately does NOT drop anything. ARCHITECTURE.md
-- finding 5 reserves retirement for the owner ("that is destructive and
-- should be your call"), and "legacy" is an assessment, not a fact about
-- usage. What is safe now is closing the write path while leaving the tables,
-- their data and their structure exactly as they are.
--
-- Evidence gathered before writing this, read-only:
--
--   rows            job_requests 0, jobs 0, quotes 0   (all three empty)
--   dependent views none
--   inbound FKs     1 (see BLOCKER below)
--   code references none. grep over admin/, site/, shared/ and supabase/
--                   for the table names and for from('jobs') / from('quotes')
--                   returns nothing, corroborating finding 5 from the
--                   application side.
--
-- BLOCKER, stated plainly: pg_constraint reported one foreign key still
-- pointing AT one of these tables, but the follow-up query naming it was
-- refused by the tooling approval gate three times, so the constraint is NOT
-- identified here. That matters for a DROP, which is why no DROP is
-- proposed. It does not affect this migration: revoking a privilege cannot
-- violate a foreign key. The query is in docs/batch7-1-findings.md.
--
-- WHY THIS REVOKES MORE THAN `FROM anon`
-- --------------------------------------
-- The first version revoked only `from anon`, which removes exactly one of
-- the three ways anon can hold INSERT:
--
--   1. a direct grant to anon        -- removed by `revoke ... from anon`
--   2. a grant to PUBLIC             -- survives an anon-only revoke entirely
--   3. a grant to a role anon is a member of, inherited
--
-- Route 2 is the likely shape here: these tables predate the current schema
-- and the old public submission path wrote to them. The migration now
-- revokes 1 and 2, and verifies the outcome -- because route 3 cannot be
-- fixed without altering a role membership this migration has no business
-- changing, it stops with a clear diagnostic rather than reporting a success
-- it has not achieved.
--
-- Scope: anonymous WRITE only.
--   * INSERT is the privilege finding 5 calls out. UPDATE and DELETE go with
--     it -- an anonymous writer should have none of the three, and leaving
--     two of three closed reads as deliberate later.
--   * SELECT is left alone. It is not a write, no code reads these tables,
--     and removing a read is the likelier of the two to surprise something
--     undiscovered. Revisit it with the retirement decision.
--   * authenticated and service_role keep exactly what they had: their
--     effective privileges are captured before the PUBLIC revoke and
--     restored after it, so a privilege they held only via PUBLIC is not
--     taken away by a side effect.

do $$
declare
  t         text;
  tbl       text;
  privs     text[] := array['INSERT', 'UPDATE', 'DELETE'];
  p         text;
  keep_auth boolean;
  keep_svc  boolean;
  has_svc   boolean := to_regrole('service_role') is not null;
begin
  foreach t in array array['job_requests', 'jobs', 'quotes'] loop
    tbl := format('public.%I', t);

    foreach p in array privs loop
      keep_auth := has_table_privilege('authenticated', tbl, p);
      keep_svc  := has_svc and has_table_privilege('service_role', tbl, p);

      execute format('revoke %s on table %s from anon', p, tbl);
      execute format('revoke %s on table %s from public', p, tbl);

      -- Restore the roles that are not the target of this change.
      if keep_auth then
        execute format('grant %s on table %s to authenticated', p, tbl);
      end if;
      if keep_svc then
        execute format('grant %s on table %s to service_role', p, tbl);
      end if;

      -- Verification: anything still held by anon arrives through a role
      -- membership this migration does not alter.
      if has_table_privilege('anon', tbl, p) then
        raise exception
          'batch7.1: anon still holds %s on % after revoking the direct and PUBLIC grants. '
          'The privilege is inherited through a role membership. Resolve it '
          '(see: select roleid::regrole from pg_auth_members where member = ''anon''::regrole) '
          'and re-run this migration.', p, tbl
          using errcode = 'insufficient_privilege';
      end if;
    end loop;
  end loop;
end $$;
