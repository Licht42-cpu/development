-- Batch 8.1 corrective, items 4-6: reservations, the remaining units, and
-- owner/crew access.
--
-- These three land together because they interlock. "Available" is not a
-- column anywhere -- it is on-hand minus what is already committed, counted
-- per location, counted only in USABLE condition, and visible only to
-- somebody allowed to see that location. Shipping any one of them alone
-- would mean shipping a figure that reads as available and is not.
--
-- This is also what the field track is blocked on. Codex's
-- docs/plans/batch-10-2-contract-readiness.md asks the load contract to
-- distinguish "required, aboard, reserved, available and shortage
-- quantities", in "operating units, exact/estimated and usable/damaged
-- counts", without "present[ing] stock belonging to another vehicle".
-- Those three sentences are items 4, 6 and 5 respectively.
--
-- NOT APPLIED. Like every other Batch 8.1 migration, this is written and
-- tested against a disposable PostgreSQL only.

/* ===================================================================== */
/* 6. units                                                              */
/* ===================================================================== */

-- The owner's unit list, completed. The blueprint names chemicals in litres
-- and solid de-icer in kilograms; channel is bought in sticks whose usable
-- offcuts matter; cheap supplies are not worth counting at all.
--
-- Codes are spelled out here rather than abbreviated because SQL is where
-- they have to be unambiguous. The admin screens map them to short labels
-- ("L", "kg", "sticks") in admin/js/lib/inventory-units.js -- shared/
-- format.js is read-only to this track, and its unitLabel() falls through
-- to the raw code, so an unmapped unit degrades to something readable
-- rather than blank.
alter table public.ns_materials
  drop constraint if exists ns_materials_unit_known;

alter table public.ns_materials
  add constraint ns_materials_unit_known check (unit in (
    'each', 'linear_ft', 'box', 'roll', 'kit', 'set',
    'litre',      -- bleach, degreaser, rust remover, Gutter Bomb, Dawn
    'kilogram',   -- solid de-icer
    'stick',      -- lighting channel, bought and cut in sticks
    'level'       -- cheap supplies: Empty / Low / Enough, never a count
  ));

-- A level-tracked material has no meaningful quantity, so it must not carry
-- a reorder point that implies one, and nothing may post a movement for it.
-- Keeping the two tracking modes apart is what stops "Low" being averaged
-- into a shortfall calculation as though it were a number.
alter table public.ns_materials
  add column if not exists tracking_mode text not null default 'quantity';

alter table public.ns_materials
  drop constraint if exists ns_materials_tracking_mode_known;
alter table public.ns_materials
  add constraint ns_materials_tracking_mode_known
    check (tracking_mode in ('quantity', 'level'));

alter table public.ns_materials
  drop constraint if exists ns_materials_level_unit_agrees;
alter table public.ns_materials
  add constraint ns_materials_level_unit_agrees check (
    (tracking_mode = 'level') = (unit = 'level'));

/* Current state of a level-tracked supply, per location. Deliberately NOT
   in the movement ledger: the ledger is quantitative and summing it is what
   makes a balance explainable. "Low" is an observation somebody made, with
   a time and a name on it, and it replaces the previous observation rather
   than adding to it. */
create table if not exists public.ns_material_levels (
  material_id uuid not null references public.ns_materials(id) on delete cascade,
  location_id uuid not null references public.ns_stock_locations(id) on delete cascade,
  state       text not null,
  checked_at  timestamptz not null default now(),
  checked_by  uuid references auth.users(id),
  note        text,
  primary key (material_id, location_id),
  constraint ns_material_levels_state_known check (state in ('empty', 'low', 'enough'))
);

/* ---------------------------------------- condition and count precision -- */

-- USABLE vs DAMAGED. Damaged stock is still owned and still on a shelf, so
-- deleting it loses the record and leaving it in the usable balance means
-- planning a job around a broken part. It is a separate balance.
alter table public.ns_material_stock_moves
  add column if not exists condition text not null default 'usable';

alter table public.ns_material_stock_moves
  drop constraint if exists ns_stock_moves_condition_known;
alter table public.ns_material_stock_moves
  add constraint ns_stock_moves_condition_known
    check (condition in ('usable', 'damaged'));

-- EXACT vs ESTIMATED. The plan is explicit that approximate quantities must
-- never be presented as exact balances. A movement says which it was, and
-- any balance a single estimate contributed to is flagged all the way up --
-- it does not become exact by being added to exact numbers.
alter table public.ns_material_stock_moves
  add column if not exists count_precision text not null default 'exact';

alter table public.ns_material_stock_moves
  drop constraint if exists ns_stock_moves_precision_known;
alter table public.ns_material_stock_moves
  add constraint ns_stock_moves_precision_known
    check (count_precision in ('exact', 'estimated'));

/* ===================================================================== */
/* 5. owner and crew access                                              */
/* ===================================================================== */

-- The simplest thing that satisfies "simple owner/assigned-crew
-- permissions" and "crew cannot read/alter unassigned records". Not a role
-- designer, not a permission matrix: a person is the owner, or they are the
-- crew of one vehicle.
create table if not exists public.ns_crew_members (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  role                text not null,
  vehicle_location_id uuid references public.ns_stock_locations(id) on delete restrict,
  display_name        text,
  active              boolean not null default true,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint ns_crew_members_role_known check (role in ('owner', 'crew')),

  -- A crew member without a vehicle has no stock they could be scoped to,
  -- which would silently read as "sees nothing" and be diagnosed as a bug.
  constraint ns_crew_members_crew_has_vehicle check (
    role <> 'crew' or vehicle_location_id is not null)
);

/* Owners keep the access admin_users already grants. This is additive:
   is_admin() still gates everything, and these only narrow it further for
   somebody explicitly recorded as crew. A user who is an admin and has no
   ns_crew_members row is an owner by default -- which is the state the
   business is in today, so nothing changes until a crew row exists. */
create or replace function public.is_owner()
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select public.is_admin()
     and not exists (
       select 1 from public.ns_crew_members m
        where m.user_id = auth.uid() and m.active and m.role = 'crew')
$$;

/** The vehicle the caller crews, or null for an owner. */
create or replace function public.current_crew_vehicle()
returns uuid
language sql
stable
set search_path = public, pg_temp
as $$
  select m.vehicle_location_id
    from public.ns_crew_members m
   where m.user_id = auth.uid() and m.active and m.role = 'crew'
$$;

/** Whether the caller may see stock at this location. An owner sees
 *  everything. A crew sees Base -- they load from it every morning -- and
 *  their own vehicle, and nothing in the other car. */
create or replace function public.can_see_location(p_location_id uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when not public.is_admin() then false
    when public.is_owner() then true
    else exists (
      select 1 from public.ns_stock_locations l
       where l.id = p_location_id
         and (l.kind = 'base' or l.id = public.current_crew_vehicle()))
  end
$$;

/* ===================================================================== */
/* 4. reservations                                                       */
/* ===================================================================== */

-- A reservation commits stock that is still physically present. It is the
-- difference between "we own 200 ft" and "we can promise 200 ft to this
-- job", and without it the plan's acceptance criterion -- both crews cannot
-- reserve the same scarce stock -- has nothing to enforce.
--
-- WHY A RESERVATION IS NOT A MOVEMENT. Nothing has moved. Posting one as a
-- movement would make the shelf count disagree with the shelf, which is the
-- one thing the ledger exists to prevent. It is a separate claim against a
-- balance, and it ends in exactly one of three ways: released (the claim is
-- dropped), consumed (it becomes a real movement), or expired.
--
-- NO DOUBLE COUNTING, which the plan names twice. A reservation reduces
-- AVAILABLE and leaves ON HAND alone. Consuming it posts the movement and
-- closes the reservation in the same transaction, so the stock is never
-- counted as both reserved and issued.

create table if not exists public.ns_stock_reservations (
  id                  uuid primary key default gen_random_uuid(),
  material_id         uuid not null references public.ns_materials(id) on delete restrict,
  location_id         uuid not null references public.ns_stock_locations(id) on delete restrict,
  quantity            numeric not null,
  status              text not null default 'held',

  job_id              uuid references public.ns_jobs(id) on delete set null,
  vehicle_location_id uuid references public.ns_stock_locations(id) on delete restrict,

  client_operation_id text not null,
  actor_id            uuid references auth.users(id),
  note                text,

  held_at             timestamptz not null default now(),
  expires_at          timestamptz,
  closed_at           timestamptz,
  closed_by_operation uuid references public.ns_stock_operations(id) on delete set null,

  constraint ns_reservations_quantity_positive check (quantity > 0),
  constraint ns_reservations_status_known check (status in (
    'held', 'released', 'consumed', 'expired')),
  constraint ns_reservations_client_id_not_blank check (btrim(client_operation_id) <> ''),

  -- A closed reservation says when and an open one does not, so "is this
  -- still committed" is answerable from the row rather than inferred.
  constraint ns_reservations_closed_has_date check (
    (status = 'held') = (closed_at is null))
);

create unique index if not exists ns_reservations_client_id_key
  on public.ns_stock_reservations (client_operation_id);

create index if not exists ns_reservations_open_idx
  on public.ns_stock_reservations (material_id, location_id)
  where status = 'held';

create index if not exists ns_reservations_job_idx
  on public.ns_stock_reservations (job_id)
  where job_id is not null;

/* ------------------------------------------------ the over-commit guard -- */

-- "Both crews cannot reserve the same scarce stock" as a database rule.
-- Held reservations at a location may never exceed the USABLE on-hand
-- there. Damaged stock is deliberately excluded: committing a broken part
-- to a job is the same mistake as committing one that is not there.
--
-- Deferred, like the transfer guard, so a transaction that reserves and
-- then releases, or re-reserves after releasing, is judged on what it
-- actually leaves behind rather than on the order its statements ran in.

create or replace function public.ns_guard_reservation_available()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_material uuid := coalesce(new.material_id, old.material_id);
  v_location uuid := coalesce(new.location_id, old.location_id);
  v_on_hand  numeric;
  v_held     numeric;
begin
  select coalesce(sum(mv.delta), 0) into v_on_hand
    from public.ns_material_stock_moves mv
   where mv.material_id = v_material
     and mv.location_id = v_location
     and mv.condition = 'usable';

  select coalesce(sum(r.quantity), 0) into v_held
    from public.ns_stock_reservations r
   where r.material_id = v_material
     and r.location_id = v_location
     and r.status = 'held';

  -- v_held > 0 matters. With no reservations at all the comparison would
  -- be 0 > a negative on-hand, which is true and means nothing: a negative
  -- balance is a real, reportable state (somebody used stock the app did
  -- not know about) and only becomes a problem when a reservation is left
  -- standing against it.
  if v_held > 0 and v_held > v_on_hand then
    raise exception
      'Cannot commit % of material % at that location: % usable on hand, % already reserved. '
      'Release a reservation or count the shelf first.',
      v_held - v_on_hand, v_material, v_on_hand, v_held
      using errcode = 'check_violation';
  end if;

  return null;
end
$$;

drop trigger if exists guard_reservation_available on public.ns_stock_reservations;
create constraint trigger guard_reservation_available
  after insert or update on public.ns_stock_reservations
  deferrable initially deferred
  for each row execute function public.ns_guard_reservation_available();

-- The same rule from the other side. Taking stock OFF a location must not
-- leave it holding less than it has already promised, or the reservation
-- silently becomes a lie. Consumption of a reservation closes it in the
-- same transaction, so that legitimate path never trips this.
create or replace function public.ns_guard_moves_respect_reservations()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_material uuid := coalesce(new.material_id, old.material_id);
  v_location uuid := coalesce(new.location_id, old.location_id);
  v_on_hand  numeric;
  v_held     numeric;
begin
  select coalesce(sum(mv.delta), 0) into v_on_hand
    from public.ns_material_stock_moves mv
   where mv.material_id = v_material
     and mv.location_id = v_location
     and mv.condition = 'usable';

  select coalesce(sum(r.quantity), 0) into v_held
    from public.ns_stock_reservations r
   where r.material_id = v_material
     and r.location_id = v_location
     and r.status = 'held';

  -- Same reason as the reservation guard: with nothing reserved there is
  -- no promise to break, and a consumption is allowed to drive a balance
  -- negative so the miscount is visible rather than silently floored.
  if v_held > 0 and v_held > v_on_hand then
    raise exception
      'That would leave % usable at the location against % already reserved. '
      'Release the reservation first, or consume it as part of this operation.',
      v_on_hand, v_held
      using errcode = 'check_violation';
  end if;

  return null;
end
$$;

drop trigger if exists guard_moves_respect_reservations on public.ns_material_stock_moves;
create constraint trigger guard_moves_respect_reservations
  after insert or update or delete on public.ns_material_stock_moves
  deferrable initially deferred
  for each row execute function public.ns_guard_moves_respect_reservations();

/* ===================================================================== */
/* derived stock, rebuilt                                                */
/* ===================================================================== */

-- Dropped and rebuilt rather than replaced: the column list changes, and
-- CREATE OR REPLACE VIEW cannot remove or reorder columns.
drop view if exists public.ns_material_stock cascade;
drop view if exists public.ns_material_stock_by_location cascade;

/* Per material, per location, split by condition, with what is committed
   and what is therefore actually available.
   AVAILABLE is the number a plan may promise: usable on hand, minus what is
   already held. It floors at zero -- a negative available is a miscount to
   surface, not a quantity to publish. */
create or replace view public.ns_material_stock_by_location as
with moves as (
  select mv.material_id, mv.location_id,
         sum(mv.delta) filter (where mv.condition = 'usable')  as usable,
         sum(mv.delta) filter (where mv.condition = 'damaged') as damaged,
         bool_or(mv.count_precision = 'estimated')             as estimated,
         max(mv.occurred_at)                                   as last_move_at
    from public.ns_material_stock_moves mv
   group by mv.material_id, mv.location_id
),
held as (
  select r.material_id, r.location_id, sum(r.quantity) as reserved
    from public.ns_stock_reservations r
   where r.status = 'held'
   group by r.material_id, r.location_id
)
select m.id            as material_id,
       m.sku,
       m.name,
       m.category,
       m.unit,
       m.tracking_mode,
       m.active,
       l.id            as location_id,
       l.code          as location_code,
       l.name          as location_name,
       l.kind          as location_kind,
       coalesce(mv.usable, 0)                                   as on_hand,
       coalesce(mv.damaged, 0)                                  as damaged_on_hand,
       coalesce(h.reserved, 0)                                  as reserved,
       greatest(coalesce(mv.usable, 0) - coalesce(h.reserved, 0), 0) as available,
       coalesce(mv.estimated, false)                            as is_estimated,
       lv.state                                                 as level_state,
       lv.checked_at                                            as level_checked_at,
       mv.last_move_at
  from public.ns_materials m
 cross join public.ns_stock_locations l
  left join moves mv on mv.material_id = m.id and mv.location_id = l.id
  left join held  h  on h.material_id  = m.id and h.location_id  = l.id
  left join public.ns_material_levels lv
         on lv.material_id = m.id and lv.location_id = l.id
 where l.active;

/* Totals across every location. Same original column names so the callers
   written before any of this keep working, plus the new facts. */
create or replace view public.ns_material_stock as
select b.material_id,
       b.sku,
       b.name,
       b.category,
       b.unit,
       b.tracking_mode,
       m.supplier_id,
       m.pack_quantity,
       m.unit_cost,
       m.currency,
       m.reorder_point,
       m.reorder_qty,
       b.active,
       sum(b.on_hand)                                     as on_hand,
       sum(b.damaged_on_hand)                             as damaged_on_hand,
       sum(b.reserved)                                    as reserved,
       sum(b.available)                                   as available,
       bool_or(b.is_estimated)                            as is_estimated,
       coalesce((
         select sum(mv.delta) from public.ns_material_stock_moves mv
          where mv.material_id = b.material_id and mv.reason = 'consumed'), 0)
                                                          as consumed_total,
       max(b.last_move_at)                                as last_move_at,
       (sum(b.on_hand) <= m.reorder_point)                as needs_reorder
  from public.ns_material_stock_by_location b
  join public.ns_materials m on m.id = b.material_id
 group by b.material_id, b.sku, b.name, b.category, b.unit, b.tracking_mode,
          b.active, m.supplier_id, m.pack_quantity, m.unit_cost, m.currency,
          m.reorder_point, m.reorder_qty;

/* ===================================================================== */
/* RLS, grants                                                           */
/* ===================================================================== */

do $$
declare
  t text;
begin
  foreach t in array array[
    'ns_crew_members', 'ns_stock_reservations', 'ns_material_levels'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format('revoke all on public.%I from public', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end
$$;

/* Crew roster: everybody who is an admin may READ it -- a crew needs to
   know which vehicle it is on -- and only an owner may change it. A crew
   that could edit its own row could reassign itself to the other car. */
drop policy if exists crew_members_read on public.ns_crew_members;
create policy crew_members_read on public.ns_crew_members
  for select to authenticated using (public.is_admin());
drop policy if exists crew_members_owner_writes on public.ns_crew_members;
create policy crew_members_owner_writes on public.ns_crew_members
  for all to authenticated
  using (public.is_owner()) with check (public.is_owner());
grant insert, update, delete on public.ns_crew_members to authenticated;

/* Reservations and levels are scoped by location: a crew sees Base and its
   own vehicle. Writes go through the RPCs below, which is why no write
   policy is granted here. */
drop policy if exists reservations_scoped_read on public.ns_stock_reservations;
create policy reservations_scoped_read on public.ns_stock_reservations
  for select to authenticated using (public.can_see_location(location_id));

drop policy if exists levels_scoped_read on public.ns_material_levels;
create policy levels_scoped_read on public.ns_material_levels
  for select to authenticated using (public.can_see_location(location_id));
drop policy if exists levels_scoped_write on public.ns_material_levels;
create policy levels_scoped_write on public.ns_material_levels
  for all to authenticated
  using (public.can_see_location(location_id))
  with check (public.can_see_location(location_id));
grant insert, update, delete on public.ns_material_levels to authenticated;

/* The ledger and the operations log were readable by any admin. Narrow
   them to what the caller is allowed to see, which is what "crew cannot
   read unassigned records" means in practice. */
drop policy if exists admin_all on public.ns_material_stock_moves;
drop policy if exists moves_scoped_read on public.ns_material_stock_moves;
create policy moves_scoped_read on public.ns_material_stock_moves
  for select to authenticated using (public.can_see_location(location_id));

drop policy if exists admin_all on public.ns_stock_operations;
drop policy if exists operations_scoped_read on public.ns_stock_operations;
create policy operations_scoped_read on public.ns_stock_operations
  for select to authenticated using (
    public.is_owner()
    or vehicle_location_id is null
    or vehicle_location_id = public.current_crew_vehicle());

do $$
declare
  v text;
begin
  foreach v in array array['ns_material_stock', 'ns_material_stock_by_location'] loop
    execute format('alter view public.%I set (security_invoker = on)', v);
    execute format('revoke all on public.%I from public', v);
    execute format('revoke all on public.%I from anon', v);
    execute format('grant select on public.%I to authenticated', v);
    execute format('grant select on public.%I to service_role', v);
  end loop;
end
$$;

comment on table public.ns_stock_reservations is
  'A claim against a balance, not a movement: nothing has physically moved. '
  'Reduces available and leaves on_hand alone, so stock is never counted as '
  'both reserved and issued. Ends as released, consumed or expired.';

comment on table public.ns_crew_members is
  'Owner or the crew of one vehicle. An admin with no row here is an owner, '
  'so nothing narrows until a crew row exists.';

comment on table public.ns_material_levels is
  'Current Empty/Low/Enough for supplies not worth counting. Deliberately '
  'outside the movement ledger: this is an observation that replaces the '
  'previous one, not a quantity that sums.';
