-- Batch 9.1: Christmas lighting sets as company-owned assets with an
-- identity of their own, and seasonal assignment as a separate, temporary
-- thing that happens to them.
--
-- WHY THIS RESTRUCTURES ns_rental_sets RATHER THAN EDITING IT IN PLACE
--
-- The Batch 8.1 table put customer_id, property_id, installed_at and
-- removed_at directly ON the set, and gave it a status vocabulary that
-- mixed where the set physically is ('in_storage', 'in_repair') with who
-- currently has it ('assigned', 'installed'). That cannot express the
-- requirement: a set's identity must survive the customer, and a set that
-- has served three customers has three assignments, not one overwritten
-- field. Batch 8.1's own scope reconciliation said 9.1 would restructure it.
--
-- Those migrations are unapplied, so editing them in place would produce a
-- tidier file. This is deliberately NOT that, for two reasons. The field
-- track now reads this migration list, and an append-only history is the
-- only one that stays true for a reader who saw it yesterday. And the
-- owner has asked for the whole pending sequence to be rehearsed in order
-- against a disposable database: a sequence that is quietly rewritten
-- between rehearsals is not a sequence, and an ALTER that has never run is
-- exactly the kind of thing a rehearsal is for.
--
-- NOT APPLIED. Written and tested against a disposable PostgreSQL only.
--
-- WHAT A SET IS, AND IS NOT
--
-- A set is an ASSET the business owns. Customers get seasonal use, never
-- ownership. Its lights are therefore NOT generic stock: the quantity is
-- either in the ledger or in a set, never counted in both. The connection
-- between the two is a real movement -- building a set consumes material,
-- stripping one returns it -- and `built_from_operation` records which.
-- See the accounting notes on ns_rental_sets below.

/* ===================================================================== */
/* 1. the set becomes an identity, not a placement                       */
/* ===================================================================== */

-- Assignment facts move to ns_seasonal_assignments. Dropping rather than
-- leaving them: a nullable customer_id beside a real assignment table is an
-- invitation to write the wrong one, and two sources of truth for "who has
-- this" is the defect being removed.
alter table public.ns_rental_sets
  drop constraint if exists ns_rental_sets_placed_has_customer;
alter table public.ns_rental_sets
  drop constraint if exists ns_rental_sets_installed_has_date;
alter table public.ns_rental_sets
  drop constraint if exists ns_rental_sets_status_known;

drop index if exists public.ns_rental_sets_customer_idx;

alter table public.ns_rental_sets drop column if exists customer_id;
alter table public.ns_rental_sets drop column if exists property_id;
alter table public.ns_rental_sets drop column if exists installed_at;
alter table public.ns_rental_sets drop column if exists removed_at;
alter table public.ns_rental_sets drop column if exists season_year;

-- Status now answers ONE question: where is the physical thing.
-- Who has it, and at what stage of the season, is the assignment's job.
alter table public.ns_rental_sets
  add constraint ns_rental_sets_status_known check (status in (
    'in_storage',   -- on our shelf, ours to allocate
    'deployed',     -- physically out at a property
    'in_repair',
    'retired',      -- taken out of service for good
    'lost'));

alter table public.ns_rental_sets
  add column if not exists location_id uuid
    references public.ns_stock_locations(id) on delete restrict;

alter table public.ns_rental_sets
  add column if not exists run_type text;
alter table public.ns_rental_sets
  add column if not exists colour text;

-- CONDITION, with "not yet inspected" as a real state rather than a null
-- that reads as fine. A set that came back in a bag and has not been looked
-- at is not usable, and must not be offered to the next customer.
alter table public.ns_rental_sets
  add column if not exists condition text not null default 'uninspected';
alter table public.ns_rental_sets
  drop constraint if exists ns_rental_sets_condition_known;
alter table public.ns_rental_sets
  add constraint ns_rental_sets_condition_known check (condition in (
    'usable', 'damaged', 'missing', 'uninspected'));

alter table public.ns_rental_sets
  add column if not exists inspected_at timestamptz;
alter table public.ns_rental_sets
  add column if not exists inspected_by uuid references auth.users(id);
alter table public.ns_rental_sets
  add column if not exists retired_at timestamptz;

-- ACCOUNTING LINK. When a set is built out of catalogue material, that
-- material leaves generic stock through an ordinary 'consumed' movement and
-- becomes part of this asset. Recording WHICH operation did it is what
-- makes the no-double-count rule checkable instead of merely asserted: the
-- lights are in the ledger or in a set, and the movement is the moment they
-- stopped being one and started being the other. Null means the set
-- predates the catalogue or was bought assembled.
alter table public.ns_rental_sets
  add column if not exists built_from_operation uuid
    references public.ns_stock_operations(id) on delete set null;

alter table public.ns_rental_sets
  add column if not exists stripped_to_operation uuid
    references public.ns_stock_operations(id) on delete set null;

-- An inspected set must say when, and a retired one likewise. Without this
-- "inspected" is a word nobody can date.
alter table public.ns_rental_sets
  drop constraint if exists ns_rental_sets_inspection_dated;
alter table public.ns_rental_sets
  add constraint ns_rental_sets_inspection_dated check (
    (condition = 'uninspected') = (inspected_at is null));

alter table public.ns_rental_sets
  drop constraint if exists ns_rental_sets_retired_dated;
alter table public.ns_rental_sets
  add constraint ns_rental_sets_retired_dated check (
    (status = 'retired') = (retired_at is not null));

create index if not exists ns_rental_sets_location_idx
  on public.ns_rental_sets (location_id);

-- Dropping season_year took ns_rental_sets_status_idx with it: an index on
-- (status, season_year desc) cannot outlive its column, and PostgreSQL drops
-- it without comment. Rebuilt under the SAME name on what is left, because
-- "where are my stored sets" is the query the seasonal screens open with.
-- Found by rehearsing the pending sequence rather than by reading it.
create index if not exists ns_rental_sets_status_idx
  on public.ns_rental_sets (status);

comment on table public.ns_rental_sets is
  'A company-owned Christmas lighting set or identifiable run. Identity is '
  'independent of any customer: who has it this season lives in '
  'ns_seasonal_assignments, and a set that has served three customers has '
  'three assignment rows. Customers get seasonal use, never ownership.';

/* ===================================================================== */
/* 2. seasonal assignment -- temporary, and historical                   */
/* ===================================================================== */

create table if not exists public.ns_seasonal_assignments (
  id                  uuid primary key default gen_random_uuid(),
  set_id              uuid not null references public.ns_rental_sets(id) on delete restrict,

  customer_id         uuid not null references public.customers(id) on delete restrict,
  property_id         uuid references public.properties(id) on delete set null,
  job_id              uuid references public.ns_jobs(id) on delete set null,
  season_year         integer not null,

  status              text not null default 'assigned',

  assigned_at         timestamptz not null default now(),
  installed_at        timestamptz,
  removed_at          timestamptz,
  released_at         timestamptz,

  -- What came back, recorded at recovery and distinct from the set's
  -- current condition: the set may be repaired afterwards, and the history
  -- of how it came back must not be rewritten by that repair.
  recovery_condition  text,

  -- Whether the customer renewed. 'pending' is the honest default; a set is
  -- never released for reuse on the strength of an assumption.
  renewal_state       text not null default 'pending',

  client_operation_id text not null,
  actor_id            uuid references auth.users(id),
  vehicle_location_id uuid references public.ns_stock_locations(id) on delete restrict,
  note                text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint ns_seasonal_assignments_status_known check (status in (
    'assigned',   -- promised to this customer for this season
    'installed',  -- physically up at their property
    'removed',    -- taken down and back in our hands
    'released',   -- finished with; the set may serve somebody else
    'cancelled')),

  constraint ns_seasonal_assignments_season_sane
    check (season_year between 2000 and 2100),

  constraint ns_seasonal_assignments_recovery_known check (
    recovery_condition is null or recovery_condition in (
      'usable', 'damaged', 'missing', 'uninspected')),

  constraint ns_seasonal_assignments_renewal_known check (
    renewal_state in ('pending', 'renewed', 'not_renewed')),

  constraint ns_seasonal_assignments_client_id_not_blank
    check (btrim(client_operation_id) <> ''),

  -- Each stage dates itself, so the timeline is readable from the row.
  constraint ns_seasonal_assignments_installed_dated check (
    status <> 'installed' or installed_at is not null),
  constraint ns_seasonal_assignments_removed_dated check (
    status not in ('removed', 'released') or removed_at is not null),
  constraint ns_seasonal_assignments_released_dated check (
    (status = 'released') = (released_at is not null)),

  -- Recovery condition is recorded AT recovery, so it exists from 'removed'
  -- onward and not before.
  constraint ns_seasonal_assignments_recovery_timing check (
    (status in ('removed', 'released')) = (recovery_condition is not null))
);

create unique index if not exists ns_seasonal_assignments_client_id_key
  on public.ns_seasonal_assignments (client_operation_id);

/* THE CONFLICT RULE. A set can be held by at most one OPEN assignment, and
   an assignment stays open until it is released or cancelled -- recovering
   the set is not the end of it.

   'removed' is in this list deliberately. Without it, a set that came back
   and passed inspection could be promised to a second customer while the
   first season's row was still open, leaving two assignments that both read
   as current and no way to tell which one the set is answering to. Release
   is what closes a season, so release is what frees the set; that is also
   what makes the release step load-bearing rather than optional
   bookkeeping somebody will stop doing in February.

   Expressed as a partial unique index rather than checked in the RPC, so it
   holds against anything that reaches the table -- a second admin screen, a
   script, a replay that slipped past its key. */
create unique index if not exists ns_seasonal_assignments_one_open_per_set
  on public.ns_seasonal_assignments (set_id)
  where status in ('assigned', 'installed', 'removed');

-- The 'assigned'/'installed' form this replaces, dropped by name so a
-- database that already ran an earlier copy of this migration ends up with
-- exactly one of the two.
drop index if exists public.ns_seasonal_assignments_one_active_per_set;

create index if not exists ns_seasonal_assignments_customer_idx
  on public.ns_seasonal_assignments (customer_id, season_year desc);

create index if not exists ns_seasonal_assignments_set_history_idx
  on public.ns_seasonal_assignments (set_id, season_year desc);

comment on table public.ns_seasonal_assignments is
  'One season of one set at one customer. Temporary and historical: '
  'terminating a contract closes the assignment, it never deletes the set '
  'and never claims the set has physically come back.';

/* ===================================================================== */
/* 3. the set''s physical status must agree with its assignment           */
/* ===================================================================== */

-- Two tables describing one physical object can drift. This is the rule
-- that stops it: a set with an INSTALLED assignment is deployed, and a
-- deployed set has one. Stated as a deferred constraint trigger because the
-- RPCs change both rows in one transaction and neither order should fail.
create or replace function public.ns_guard_set_matches_assignment()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_set    uuid;
  v_status text;
  v_active integer;
begin
  -- One function, two tables, so the row has to be located per table.
  -- Written out rather than coalesced across both shapes because PL/pgSQL
  -- resolves record fields at RUN time: `new.set_id` on ns_rental_sets is
  -- not a null, it is error 42703, and it would fire on every set update.
  if tg_table_name = 'ns_rental_sets' then
    v_set := new.id;                       -- after UPDATE only; NEW exists
  elsif tg_op = 'DELETE' then
    v_set := old.set_id;
  else
    v_set := new.set_id;
  end if;

  select status into v_status from public.ns_rental_sets where id = v_set;
  if v_status is null then return null; end if;          -- set is gone

  select count(*) into v_active
    from public.ns_seasonal_assignments a
   where a.set_id = v_set and a.status = 'installed';

  if v_active > 0 and v_status <> 'deployed' then
    raise exception
      'Set % has an installed assignment but its status is %. A set that is '
      'up at a property is deployed.', v_set, v_status
      using errcode = 'check_violation';
  end if;

  if v_active = 0 and v_status = 'deployed' then
    raise exception
      'Set % is marked deployed but nothing is installed. Recover the '
      'assignment or correct the status.', v_set
      using errcode = 'check_violation';
  end if;

  return null;
end
$$;

drop trigger if exists guard_assignment_matches_set on public.ns_seasonal_assignments;
create constraint trigger guard_assignment_matches_set
  after insert or update or delete on public.ns_seasonal_assignments
  deferrable initially deferred
  for each row execute function public.ns_guard_set_matches_assignment();

drop trigger if exists guard_set_matches_assignment on public.ns_rental_sets;
create constraint trigger guard_set_matches_assignment
  after update on public.ns_rental_sets
  deferrable initially deferred
  for each row execute function public.ns_guard_set_matches_assignment();

/* ===================================================================== */
/* 4. availability, derived                                              */
/* ===================================================================== */

-- "Is this set free for a new customer" has five ways to be no, and a
-- screen that checks only the obvious one will promise a set that is
-- already on somebody's roof. Each reason is reported separately so the
-- admin sees WHY, not just that it is unavailable.
-- Dropped first: CREATE OR REPLACE VIEW cannot add a column in the middle
-- or reorder one, and awaiting_release lands between the existing reasons.
drop view if exists public.ns_seasonal_set_availability cascade;
create or replace view public.ns_seasonal_set_availability as
select s.id                       as set_id,
       s.set_code,
       s.status,
       s.condition,
       s.run_type,
       s.colour,
       s.linear_ft,
       s.storage_location,
       s.location_id,
       s.inspected_at,
       a.id                       as active_assignment_id,
       a.customer_id              as active_customer_id,
       a.season_year              as active_season_year,
       a.status                   as active_assignment_status,
       (a.id is not null)                        as has_active_assignment,
       (a.status = 'removed')                    as awaiting_release,
       (s.condition = 'uninspected')             as needs_inspection,
       (s.condition in ('damaged', 'missing'))   as needs_repair_or_search,
       (s.status in ('retired', 'lost'))         as out_of_service,
       (s.status = 'in_repair')                  as at_the_repair_bench,
       (    a.id is null
        and s.status = 'in_storage'
        and s.condition = 'usable'
        and s.inspected_at is not null)          as available_for_reuse
  from public.ns_rental_sets s
  left join public.ns_seasonal_assignments a
         on a.set_id = s.id
        and a.status in ('assigned', 'installed', 'removed');

/* ===================================================================== */
/* 5. RLS and grants                                                     */
/* ===================================================================== */

do $$
declare
  t text;
begin
  foreach t in array array['ns_seasonal_assignments'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end
$$;

-- Writes go through the RPCs in the next migration, which is why no write
-- policy or write grant exists here. Same reasoning as the stock ledger:
-- the guarantees live in the functions, and a direct INSERT would walk
-- straight past the replay key, the crew scoping and the conflict rule.
drop policy if exists seasonal_assignments_read on public.ns_seasonal_assignments;
create policy seasonal_assignments_read on public.ns_seasonal_assignments
  for select to authenticated using (public.is_admin());

-- Sets are scoped by the location they are stored at, consistent with the
-- stock rules. A set with no location recorded is visible to everyone who
-- can see Base, which is where an unplaced set logically sits.
drop policy if exists admin_all on public.ns_rental_sets;
drop policy if exists rental_sets_scoped_read on public.ns_rental_sets;
create policy rental_sets_scoped_read on public.ns_rental_sets
  for select to authenticated using (
    public.is_admin()
    and (location_id is null or public.can_see_location(location_id)));

drop policy if exists rental_sets_owner_writes on public.ns_rental_sets;
create policy rental_sets_owner_writes on public.ns_rental_sets
  for all to authenticated
  using (public.is_owner()) with check (public.is_owner());

drop policy if exists admin_all on public.ns_rental_set_events;
drop policy if exists rental_set_events_read on public.ns_rental_set_events;
create policy rental_set_events_read on public.ns_rental_set_events
  for select to authenticated using (public.is_admin());

-- The event log is append-only to everyone: history is the point.
revoke update, delete on public.ns_rental_set_events from authenticated;

do $$
begin
  execute 'alter view public.ns_seasonal_set_availability set (security_invoker = on)';
  execute 'revoke all on public.ns_seasonal_set_availability from public';
  execute 'revoke all on public.ns_seasonal_set_availability from anon';
  execute 'grant select on public.ns_seasonal_set_availability to authenticated';
  execute 'grant select on public.ns_seasonal_set_availability to service_role';
end
$$;

/* The lifecycle log gains the vocabulary this batch needs. CHECK replaced
   rather than extended in place, because a constraint cannot be altered. */
alter table public.ns_rental_set_events
  drop constraint if exists ns_rental_set_events_known;
alter table public.ns_rental_set_events
  add constraint ns_rental_set_events_known check (event in (
    'received', 'assigned', 'unassigned', 'installed', 'removed',
    'stored', 'repaired', 'retired', 'lost', 'inspected',
    -- new in 9.1
    'recovered', 'released', 'renewed', 'not_renewed', 'built', 'stripped'));

alter table public.ns_rental_set_events
  add column if not exists assignment_id uuid
    references public.ns_seasonal_assignments(id) on delete set null;

create index if not exists ns_rental_set_events_assignment_idx
  on public.ns_rental_set_events (assignment_id)
  where assignment_id is not null;
