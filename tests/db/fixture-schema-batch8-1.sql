-- Minimal fixture schema for the Batch 8.1 inventory tests.
--
-- THIS IS NOT THE PRODUCTION SCHEMA. The repository has no base schema at
-- all (docs/batch7-1-findings.md, finding 4b), so this file recreates only
-- the objects the Batch 8.1 migrations reference by name, with column types
-- taken from read-only introspection of the live project.
--
-- It is DESTRUCTIVE. It may only ever run against the dedicated disposable
-- database created by setup-test-db.mjs, which tests/db/disposable.mjs
-- enforces in two stages before this file is read.
--
-- What passing buys, and what it does not:
--   * it DOES prove the migrations are valid SQL against real PostgreSQL,
--     that the constraints reject what they claim to reject, that the
--     on-hand view and the estimate RPC compute what they claim, and that
--     the new tables are closed to anon through all three privilege routes.
--   * it does NOT prove anything about the live database. Neither Batch 8.1
--     migration has been applied to production.

create schema if not exists public;
create schema if not exists auth;

-- Supabase's roles. NOLOGIN is enough: the tests use privilege functions
-- and SET ROLE, not connections.
do $$ begin
  if to_regrole('anon')          is null then create role anon          nologin; end if;
  if to_regrole('authenticated') is null then create role authenticated nologin; end if;
  if to_regrole('service_role')  is null then create role service_role  nologin; end if;
end $$;

-- service_role carries BYPASSRLS on the live project (verified), so give it
-- the same attribute here rather than letting the fixture be quietly more
-- restrictive than production.
alter role service_role bypassrls;

-- A role anon is a MEMBER of, so the inherited-privilege route the Batch 7.1
-- findings identified can be exercised against the NEW tables too.
do $$ begin
  if to_regrole('ns_legacy_writer') is null then create role ns_legacy_writer nologin; end if;
end $$;

grant usage on schema public to anon, authenticated, service_role, ns_legacy_writer;

-- ------------------------------------------------------------ auth.users --
-- Three new tables carry created_by uuid references auth.users(id).
drop table if exists auth.users cascade;
create table auth.users (id uuid primary key default gen_random_uuid());

-- The operations-contract RPCs attribute every operation to auth.uid().
-- Supabase supplies it from the request JWT; a plain cluster has no such
-- thing, so this reads the same session GUC the is_admin() stand-in uses.
-- Shape is what matters: a uuid or null.
drop function if exists auth.uid() cascade;
create function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('nova.actor_id', true), '')::uuid $$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- -------------------------------------------------------------- is_admin --
-- The live definition reads admin_users against auth.uid(). Neither exists
-- in a plain Postgres cluster, so this stand-in reads a session GUC, which
-- lets a single test flip between admin and non-admin without faking a JWT.
-- The SHAPE that matters to these migrations is identical: a boolean,
-- stable, callable by authenticated.
drop function if exists public.is_admin() cascade;
create function public.is_admin() returns boolean
language sql stable
as $$ select coalesce(current_setting('nova.is_admin', true), 'off') = 'on' $$;

grant execute on function public.is_admin() to anon, authenticated, service_role;

-- -------------------------------------------------------- base app tables --
drop table if exists public.job_measurements cascade;
drop table if exists public.job_sections cascade;
drop table if exists public.ns_jobs cascade;
drop table if exists public.properties cascade;
drop table if exists public.customers cascade;
drop table if exists public.services cascade;

create table public.customers (
  id   uuid primary key default gen_random_uuid(),
  name text not null default 'Fixture Customer'
);

create table public.properties (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete set null,
  address     text
);

create table public.ns_jobs (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  property_id uuid references public.properties(id) on delete restrict,
  status      text not null default 'draft'
);

create table public.services (
  id         uuid primary key default gen_random_uuid(),
  key        text not null unique,
  name       text not null,
  category   text not null default 'lighting',
  unit       text not null default 'linear_ft',
  parent_key text,
  active     boolean not null default true,
  quotable   boolean not null default true,
  sort_order integer not null default 0
);

create table public.job_measurements (
  id              uuid primary key default gen_random_uuid(),
  job_id          uuid not null references public.ns_jobs(id) on delete cascade,
  service_id      uuid not null references public.services(id) on delete restrict,
  section_id      uuid,
  label           text,
  quantity        numeric not null default 0,
  unit            text not null default 'linear_ft',
  sort_order      integer not null default 0,
  review_required boolean not null default false,
  review_reason   text
);

-- The two real lighting services, with the real keys, units and
-- parent/child relationship read from the live project. Rates are not
-- reproduced: nothing in Batch 8.1 reads pricing.
insert into public.services (key, name, unit, parent_key, sort_order) values
  ('permanent_lighting',      'Permanent Outdoor Lighting', 'linear_ft', null,                 10),
  ('permanent_lighting_jump', 'Jump Wire',                  'linear_ft', 'permanent_lighting', 11),
  ('christmas_lighting',      'Christmas Lighting',          'linear_ft', null,                 20);

grant select, insert, update, delete
  on public.customers, public.properties, public.ns_jobs,
     public.services, public.job_measurements
  to authenticated, service_role;
