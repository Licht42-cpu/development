-- Batch 5: minimal grants on the admin-only quote RPCs this batch replaced.
--
-- Checked after replacing them (create or replace preserves grants, so this is
-- inherited state, not something Batch 5 introduced):
--
--   create_quote_from_calculation  authenticated, postgres          <- correct
--   create_option_quote            PUBLIC, postgres
--   duplicate_quote                PUBLIC, authenticated, postgres
--   send_option_group              PUBLIC, postgres
--   get_customer_quote             anon, authenticated, postgres    <- correct,
--                                    the customer quote page is unauthenticated
--
-- PUBLIC includes anon, so an unauthenticated caller could invoke three
-- admin-only RPCs. Verified against the live database as the anon role that
-- this is NOT an open door -- the is_admin() guard holds:
--
--   duplicate_quote    -> permission denied for table ns_quotes
--   send_option_group  -> Not authorised.
--   create_option_quote-> Not authorised.
--
-- So this is a missing layer rather than a vulnerability, and it is fixed here
-- only because Batch 5 replaced these three functions and their grants are
-- therefore part of this change. get_customer_quote keeps anon deliberately:
-- it is the customer-facing read and enforces its own status/is_admin filter.
--
-- Uses the pattern established in 20261007133403: revoking from anon alone is
-- a no-op while the default PUBLIC grant stands, so revoke from PUBLIC first
-- and then grant back to authenticated (every admin is authenticated, so the
-- admin panel is unaffected).

revoke execute on function public.create_option_quote(uuid, uuid, text, integer, uuid[], text, uuid) from public;
grant  execute on function public.create_option_quote(uuid, uuid, text, integer, uuid[], text, uuid) to authenticated;

revoke execute on function public.duplicate_quote(uuid) from public;
grant  execute on function public.duplicate_quote(uuid) to authenticated;

revoke execute on function public.send_option_group(uuid) from public;
grant  execute on function public.send_option_group(uuid) to authenticated;
