-- Batch 7.1: minimal grants on the last two admin-only RPCs that an
-- anonymous caller could still execute.
--
-- Full read-only inventory of every function in `public`, taken against the
-- live project, asking has_function_privilege('anon', oid, 'EXECUTE') rather
-- than reading the grant list -- so inherited and PUBLIC grants are counted,
-- not just explicit ones. Eleven functions came back anon-executable. They
-- fall into four groups:
--
--   HARDEN HERE (admin-only, is_admin() guard, no customer caller):
--     calculate_job_pricing(uuid, uuid[])          PUBLIC
--     save_quote_signature(uuid, text, text)       PUBLIC
--
--   KEEP -- genuinely customer-facing, part of a supported contract:
--     get_customer_quote(uuid)        the customer quote page
--     respond_to_quote(uuid, text)    customer accept / decline
--     attach_request_photo(...)       public submission photo contract
--     get_request_status(uuid)        public request status lookup
--
--   KEEP -- required by RLS:
--     is_admin()
--       RLS policies that call is_admin() are evaluated as the CALLING role,
--       so anon and authenticated must retain EXECUTE or every policy
--       referencing it fails. It is a boolean about the caller and leaks
--       nothing.
--
--   LEAVE -- the grant is inert:
--     guard_quote_is_draft(), set_updated_at(), job_from_request() return
--     `trigger`; rls_auto_enable() returns `event_trigger`. Postgres refuses
--     a direct call with 0A000 whatever the grant says, and does not consult
--     EXECUTE when firing a trigger. Asserted in the Batch 7.1 tests.
--
-- WHY THIS REVOKES MORE THAN `FROM public`
-- ----------------------------------------
-- The first version of this migration revoked only from PUBLIC. That removes
-- exactly one of the three ways anon can hold EXECUTE:
--
--   1. a grant to PUBLIC           -- removed by `revoke ... from public`
--   2. a direct grant to anon      -- survives a PUBLIC revoke entirely
--   3. a grant to a role anon is a member of, inherited
--
-- Route 2 is not hypothetical in this project: get_customer_quote and
-- respond_to_quote both carry direct anon grants today, so the shape exists.
-- The migration now revokes 1 and 2, and because route 3 cannot be fixed
-- without altering a role membership this migration has no business
-- changing, it VERIFIES the outcome and stops with a clear diagnostic rather
-- than reporting success it has not achieved.
--
-- This is a missing layer, not a reproduced bypass. Both functions begin with
-- `if not public.is_admin() then raise ... insufficient_privilege`, so an
-- anonymous call already fails. It is not described as an open vulnerability.
--
-- Callers confirmed by grep before touching anything:
--   calculate_job_pricing -> admin/js/lib/api.js, measurements.js, settings.js
--                            and five calculator components. No site/ caller.
--   save_quote_signature  -> admin/js/lib/api.js only. No site/ caller; the
--                            customer page accepts via respond_to_quote.
--   Both are also called INTERNALLY by SECURITY DEFINER functions owned by
--   postgres (create_quote_from_calculation calls calculate_job_pricing),
--   which run as the owner and are unaffected by a revoke from anon/PUBLIC.

do $$
declare
  fn    text;
  sigs  text[] := array[
    'public.calculate_job_pricing(uuid, uuid[])',
    'public.save_quote_signature(uuid, text, text)'
  ];
  auth_had boolean;
  svc_had  boolean;
begin
  foreach fn in array sigs loop
    -- Remember what the roles that must keep access effectively hold, so a
    -- PUBLIC revoke cannot take it from them by side effect.
    auth_had := has_function_privilege('authenticated', fn, 'EXECUTE');
    svc_had  := to_regrole('service_role') is not null
                and has_function_privilege('service_role', fn, 'EXECUTE');

    execute format('revoke execute on function %s from public', fn);
    execute format('revoke execute on function %s from anon', fn);

    -- The admin panel runs as authenticated; this is the intended caller.
    execute format('grant execute on function %s to authenticated', fn);
    if svc_had then
      execute format('grant execute on function %s to service_role', fn);
    end if;
    if not auth_had then
      -- Nothing to restore, but say so rather than silently widening.
      raise notice 'batch7.1: authenticated had no EXECUTE on % before this migration; granting it as the intended admin caller.', fn;
    end if;

    -- Verification. If anon can still execute, the privilege arrives through
    -- a role membership this migration deliberately does not alter. Stop.
    if has_function_privilege('anon', fn, 'EXECUTE') then
      raise exception
        'batch7.1: anon can still EXECUTE % after revoking the PUBLIC and direct grants. '
        'The privilege is inherited through a role membership. Resolve the membership '
        '(see: select roleid::regrole from pg_auth_members where member = ''anon''::regrole) '
        'and re-run this migration.', fn
        using errcode = 'insufficient_privilege';
    end if;
  end loop;
end $$;
