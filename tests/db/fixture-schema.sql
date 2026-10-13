-- Minimal fixture schema for the Batch 7.1 database tests.
--
-- THIS IS NOT THE PRODUCTION SCHEMA. The repository has no base schema at
-- all -- supabase/migrations/ begins at the Phase C repair and contains only
-- incremental changes, so production cannot be rebuilt from this repo (see
-- docs/batch7-1-findings.md, finding 4b). This file recreates only the parts
-- the Batch 7.1 migrations actually touch, with column types and function
-- signatures taken from read-only introspection of the live project.
--
-- It is DESTRUCTIVE: it drops tables whose names exist in the real
-- application. It may only ever be executed against the dedicated disposable
-- database created by setup-test-db.mjs, which tests/db/disposable.mjs
-- enforces in two stages before this file is read.
--
-- What passing here buys, and what it does not:
--   * it DOES prove the migrations' SQL is valid, that their signatures match
--     the live ones, and that the trigger and privilege logic behave as
--     claimed in real Postgres.
--   * it does NOT prove the live database is protected. Nothing here is
--     applied to production.

create schema if not exists public;

-- Supabase's browser-facing roles, plus service_role. NOLOGIN is enough: the
-- tests use privilege functions and SET ROLE, not connections.
do $$ begin
  if to_regrole('anon')          is null then create role anon          nologin; end if;
  if to_regrole('authenticated') is null then create role authenticated nologin; end if;
  if to_regrole('service_role')  is null then create role service_role  nologin; end if;
end $$;

-- A role anon is a MEMBER of. This is the third way to hold a privilege, and
-- the one neither Batch 7.1 migration originally accounted for: a revoke
-- naming anon removes only anon's own grant, and a revoke naming PUBLIC
-- removes only PUBLIC's, while an inherited grant survives both.
do $$ begin
  if to_regrole('ns_legacy_writer') is null then create role ns_legacy_writer nologin; end if;
end $$;
grant ns_legacy_writer to anon;

grant usage on schema public to anon, authenticated, service_role, ns_legacy_writer;

-- ---------------------------------------------------------------- quotes --
-- Only the columns the content-freeze trigger reads.
drop table if exists public.ns_quotes cascade;
create table public.ns_quotes (
  id             uuid primary key default gen_random_uuid(),
  status         text not null default 'draft',
  customer_notes text,
  terms          text,
  internal_notes text,
  total          numeric not null default 0
);

-- ------------------------------------------------- admin-only RPC stubs --
-- Bodies are irrelevant: these exist so the grant migration has real
-- functions with the EXACT live signatures to revoke from. If a signature in
-- the migration is wrong, the REVOKE raises and the test fails.
--
-- DROP before CREATE, not CREATE OR REPLACE: replacing a function PRESERVES
-- its existing grants, so on a second run the stubs would still carry the
-- revoke the previous run applied and the "before" assertions would fail
-- against a state the fixture is supposed to have reset.
drop function if exists public.calculate_job_pricing(uuid, uuid[]);
create function public.calculate_job_pricing(p_job_id uuid, p_measurement_ids uuid[])
returns void language sql as $$ select $$;

drop function if exists public.save_quote_signature(uuid, text, text);
create function public.save_quote_signature(p_quote_id uuid, p_signature_path text, p_signed_by_name text)
returns void language sql as $$ select $$;

-- Reproduce ALL THREE ways the privilege can be held, so a revoke that
-- handles only one of them is caught:
--   calculate_job_pricing : PUBLIC (what the live inventory shows)
--   save_quote_signature  : PUBLIC + a direct anon grant
-- Postgres grants EXECUTE to PUBLIC by default on CREATE FUNCTION, so the
-- PUBLIC half is already in place.
grant execute on function public.save_quote_signature(uuid, text, text) to anon;

-- ...and route 3, inheritance, on one of them, so the migration's diagnostic
-- path is exercised rather than merely written.
grant execute on function public.calculate_job_pricing(uuid, uuid[]) to ns_legacy_writer;

-- authenticated must keep access through all of this.
grant execute on function public.calculate_job_pricing(uuid, uuid[]) to authenticated;
grant execute on function public.save_quote_signature(uuid, text, text) to authenticated;

-- --------------------------------------------- inert-grant demonstration --
-- Used to assert the migration's claim that a PUBLIC grant on a trigger or
-- event-trigger function cannot be exercised, so revoking it would be
-- cosmetic. Asserted, not assumed.
create or replace function public.fixture_trigger_fn()
returns trigger language plpgsql as $$ begin return new; end $$;

create or replace function public.fixture_event_trigger_fn()
returns event_trigger language plpgsql as $$ begin end $$;

grant execute on function public.fixture_trigger_fn() to public;
grant execute on function public.fixture_event_trigger_fn() to public;

-- ------------------------------------------------------- legacy tables --
drop table if exists public.job_requests cascade;
drop table if exists public.jobs cascade;
drop table if exists public.quotes cascade;
create table public.job_requests (id uuid primary key default gen_random_uuid(), note text);
create table public.jobs         (id uuid primary key default gen_random_uuid(), note text);
create table public.quotes       (id uuid primary key default gen_random_uuid(), note text);

-- One table per route by which anon can hold write access, so a revoke that
-- only covers one route leaves the others provable:
--   job_requests : granted DIRECTLY to anon
--   jobs         : granted to PUBLIC
--   quotes       : granted to ns_legacy_writer, which anon INHERITS
grant select, insert, update, delete on public.job_requests to anon;
grant select, insert, update, delete on public.jobs         to public;
grant select, insert, update, delete on public.quotes       to ns_legacy_writer;
grant select                          on public.quotes       to anon;

-- Roles that must keep what they have.
grant select, insert, update, delete on public.job_requests to authenticated, service_role;
grant select, insert, update, delete on public.jobs         to authenticated, service_role;
grant select, insert, update, delete on public.quotes       to authenticated, service_role;
