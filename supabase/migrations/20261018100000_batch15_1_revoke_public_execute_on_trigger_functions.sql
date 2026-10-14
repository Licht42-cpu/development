-- ===========================================================================
-- Batch 15.1: stop granting the trigger functions to the world.
--
-- WHAT THE RELEASE AUDIT FOUND. `docs/release/pending-migration-audit.md`
-- reports twenty-four functions executable by `anon` after the pending chain.
-- Three are 13.1's deliberate customer reads. One is `is_admin()`, which
-- must stay (below). The other twenty are TRIGGER FUNCTIONS and two fixture
-- helpers, and none of them is a decision anybody made: PostgreSQL grants
-- EXECUTE on a new function to PUBLIC unless told otherwise, and every
-- batch's `revoke ... from public` loop listed the RPCs it was adding and
-- not the triggers it was installing beside them.
--
-- WHY IT IS WORTH A MIGRATION. The risk is low -- a trigger function called
-- directly refuses with 42501 once this is applied, and refused with
-- "trigger functions can only be called as triggers" before it. But a
-- release review that leaves twenty unexplained anon-executable functions in
-- the inventory has trained its own reader to skim the list, and the next
-- genuinely wrong grant arrives in the same column.
--
-- PROVEN SAFE BEFORE BEING PROPOSED. On the disposable database: with
-- EXECUTE revoked from PUBLIC and from `authenticated`, an INSERT performed
-- as `authenticated` still fired its BEFORE trigger and still got its
-- computed column, while a direct call of the same function was refused with
-- 42501. PostgreSQL checks EXECUTE on a trigger function when the TRIGGER is
-- created, not when it fires.
--
-- WHAT THIS DELIBERATELY DOES NOT TOUCH.
--
--   `is_admin()` stays executable by anon. It is referenced by RLS policies,
--   and a policy is evaluated as the SESSION role: revoking it would turn
--   every anon-facing policy that mentions it into an error instead of a
--   `false`. It returns false for anon and leaks nothing.
--
--   The three legacy tables (`job_requests`, `jobs`, `quotes`) keep their
--   anon SELECT. Batch 7.1 §3 scoped itself to anonymous WRITE on purpose
--   and recorded why -- "removing a read is the more likely of the two to
--   surprise something undiscovered" -- and left SELECT to be revisited with
--   the retirement decision, which is still open and still blocked on the
--   unidentified inbound foreign key. Reversing a documented decision inside
--   a release-preparation batch is not this file's business.
--
-- INTROSPECTIVE, so it covers every trigger function the chain installs
-- rather than a list that goes stale on the next batch, and re-runnable.
--
-- NOT APPLIED ANYWHERE. Thirtieth pending migration.
-- ===========================================================================

do $$
declare
  f record;
  n integer := 0;
begin
  for f in
    select p.oid::regprocedure::text as sig
      from pg_proc p
      join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       -- A trigger function, by its return type. Not by a naming
       -- convention: `guard_quote_customer_content_frozen` and
       -- `ns_touch_updated_at` share no prefix.
       and p.prorettype = 'pg_catalog.trigger'::regtype
     order by 1
  loop
    execute format('revoke all on function %s from public', f.sig);
    execute format('revoke all on function %s from anon', f.sig);
    execute format('revoke all on function %s from authenticated', f.sig);
    n := n + 1;
  end loop;
  raise notice 'batch15.1: revoked public/anon/authenticated execute on % '
    'trigger function(s)', n;
end
$$;

/* ===================================================================== */
/* assertions                                                            */
/* ===================================================================== */

do $$
declare
  f record;
  v_left text[] := '{}';
  v_triggers integer;
begin
  -- No trigger function may remain anon-executable.
  for f in
    select p.oid::regprocedure::text as sig, p.oid
      from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.prorettype = 'pg_catalog.trigger'::regtype
  loop
    if has_function_privilege('anon', f.oid, 'execute')
       or has_function_privilege('authenticated', f.oid, 'execute') then
      v_left := v_left || f.sig;
    end if;
  end loop;
  if array_length(v_left, 1) is not null then
    raise exception
      'these trigger functions are still callable by a session role: %. '
      'Check for a grant to a role anon or authenticated inherits.',
      array_to_string(v_left, ', ');
  end if;

  -- And the triggers themselves are still installed: this file revokes a
  -- privilege and must not have disturbed a single trigger.
  select count(*) into v_triggers from pg_trigger where not tgisinternal;
  if v_triggers = 0 then
    raise exception 'no triggers remain installed after the revoke';
  end if;

  -- The named ones that matter most, by name, because a release is when a
  -- quiet regression surfaces.
  if not exists (
    select 1 from pg_trigger
     where tgname = 'ns_jobs_completion_gate' and not tgisinternal) then
    raise exception 'ns_jobs_completion_gate is missing';
  end if;
  if to_regclass('public.ns_completion_reports') is not null
     and not exists (
       select 1 from pg_trigger
        where tgname = 'ns_completion_reports_immutable' and not tgisinternal) then
    raise exception 'ns_completion_reports_immutable is missing';
  end if;

  -- is_admin() must still be reachable by anon, or every anon-facing policy
  -- that calls it starts erroring instead of returning false.
  if to_regprocedure('public.is_admin()') is not null
     and not has_function_privilege('anon', 'public.is_admin()', 'execute') then
    raise exception
      'is_admin() is no longer anon-executable. RLS policies are evaluated '
      'as the session role, so this turns an anon `false` into an error.';
  end if;
end
$$;
