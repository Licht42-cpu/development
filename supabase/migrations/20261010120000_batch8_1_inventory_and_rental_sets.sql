-- Batch 8.1: materials inventory for the lighting services, bulk purchasing,
-- and Christmas rental-set tracking.
--
-- WHY THIS EXISTS
--
-- Before this migration the schema knew what a lighting job SELLS
-- (services, pricing_rules.rate, job_measurements.quantity) and nothing at
-- all about what it CONSUMES. Verified live before writing: there is no
-- materials table, no stock level, no supplier, no purchase order, no link
-- from a measurement to a part, and no cost basis anywhere --
-- pricing_rules.rate is a sell price only. So the business could quote
-- 180 linear feet of permanent lighting without the app being able to say
-- whether 180 feet of track was on the shelf.
--
-- WHAT IS DELIBERATELY NOT HERE
--
-- 1. NO CATALOGUE ROWS. The supplier the owner named --
--    https://permanentlightingdirect.ca/diy-kits -- is unreachable from the
--    environment this migration was authored in (DNS failure, then the
--    outbound proxy answered 403 to CONNECT). Part names, SKUs, pack sizes
--    and costs are therefore NOT seeded, because inventing them would put
--    numbers in the database that nobody has ever verified and that would
--    then flow into shortfall maths and purchase orders. The one supplier
--    row below carries only what the owner actually supplied: a name and
--    that URL. Everything else is populated from the admin screen.
--
-- 2. NO MONEY IN THE QUOTE PATH. ns_materials.unit_cost is a COST basis for
--    purchasing and margin review. Nothing in this migration touches
--    calculate_job_pricing, quote_line_items or any customer-facing total.
--    Pricing calculations stay in the existing backend RPCs, unchanged.
--
-- 3. NO MUTABLE on_hand COLUMN. Stock is an append-only ledger
--    (ns_material_stock_moves) summed by a view. A single counter would be
--    cheaper to read and impossible to explain: when the shelf and the app
--    disagree, the question is always "what moved?", which a counter cannot
--    answer and a ledger answers by construction. It also makes a wrong
--    receipt correctable by posting its reverse rather than by overwriting
--    history, which is the same reasoning that keeps pricing_rules
--    effective-dated rather than edited in place.
--
-- SECURITY
--
-- Every table here is admin-only. RLS is enabled with the single `admin_all`
-- policy shape already used across this schema (ALL commands, role
-- authenticated, USING and WITH CHECK both is_admin()), and anon/PUBLIC are
-- revoked explicitly rather than merely left ungranted -- the Batch 7.1
-- finding was that a privilege can arrive three ways (direct, PUBLIC,
-- inherited), so new tables start from an explicit revoke.
--
-- None of this is customer-facing: no policy grants anon any access, and
-- nothing here is read by the public quote page.

/* ===================================================================== */
/* suppliers                                                             */
/* ===================================================================== */

create table if not exists public.ns_suppliers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  website     text,
  account_ref text,
  notes       text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint ns_suppliers_name_not_blank check (btrim(name) <> '')
);

create unique index if not exists ns_suppliers_name_key
  on public.ns_suppliers (lower(btrim(name)));

/* The only seeded row in this migration, and the only one the owner
   supplied real values for. ON CONFLICT DO NOTHING so a re-run, or a row
   the owner has since edited, is left alone. */
insert into public.ns_suppliers (name, website, notes)
values ('Permanent Lighting Direct',
        'https://permanentlightingdirect.ca/diy-kits',
        'Primary parts source for permanent lighting; bulk ordering. '
        'Catalogue not imported -- the site was unreachable when this '
        'migration was written, so parts are entered from the admin screen.')
on conflict do nothing;

/* ===================================================================== */
/* materials catalogue                                                   */
/* ===================================================================== */

create table if not exists public.ns_materials (
  id             uuid primary key default gen_random_uuid(),
  sku            text,
  name           text not null,
  category       text not null,
  unit           text not null,
  supplier_id    uuid references public.ns_suppliers(id) on delete set null,

  -- How many `unit` come in one purchasable pack. A 150 ft roll of track is
  -- unit='linear_ft', pack_quantity=150: the shelf is counted in feet, the
  -- purchase order is placed in rolls, and neither number has to be
  -- re-derived by hand at the point of use.
  pack_quantity  numeric not null default 1,
  pack_label     text,

  unit_cost      numeric,
  currency       text not null default 'CAD',

  reorder_point  numeric not null default 0,
  reorder_qty    numeric not null default 0,

  active         boolean not null default true,
  notes          text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint ns_materials_name_not_blank check (btrim(name) <> ''),
  constraint ns_materials_category_known check (category in (
    'track', 'light', 'controller', 'power_supply', 'connector',
    'clip', 'wire', 'rental_set', 'consumable', 'tool', 'other')),
  constraint ns_materials_unit_known check (unit in (
    'each', 'linear_ft', 'box', 'roll', 'kit', 'set')),
  constraint ns_materials_pack_positive  check (pack_quantity > 0),
  constraint ns_materials_cost_nonneg    check (unit_cost is null or unit_cost >= 0),
  constraint ns_materials_reorder_nonneg check (reorder_point >= 0 and reorder_qty >= 0)
);

/* A SKU is unique within a supplier, and within the "no supplier" bucket.
   coalesce rather than a plain two-column unique constraint because NULL is
   never equal to NULL, so (null, 'ABC-1') twice would otherwise both be
   allowed -- which is exactly the duplicate this index exists to stop. */
create unique index if not exists ns_materials_supplier_sku_key
  on public.ns_materials (
    coalesce(supplier_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(btrim(sku)))
  where sku is not null and btrim(sku) <> '';

create index if not exists ns_materials_active_idx
  on public.ns_materials (active, category, name);

/* ===================================================================== */
/* purchase orders (bulk ordering)                                       */
/* ===================================================================== */

create table if not exists public.ns_purchase_orders (
  id           uuid primary key default gen_random_uuid(),
  supplier_id  uuid not null references public.ns_suppliers(id) on delete restrict,
  reference    text,
  status       text not null default 'draft',
  ordered_at   timestamptz,
  expected_at  timestamptz,
  received_at  timestamptz,
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id),

  constraint ns_purchase_orders_status_known check (status in (
    'draft', 'ordered', 'partial', 'received', 'cancelled')),

  -- A PO that claims to be ordered has to say when. Keeps "ordered" from
  -- meaning two different things depending on which screen filled it in.
  constraint ns_purchase_orders_ordered_has_date check (
    status in ('draft', 'cancelled') or ordered_at is not null)
);

create index if not exists ns_purchase_orders_status_idx
  on public.ns_purchase_orders (status, coalesce(ordered_at, created_at) desc);

create table if not exists public.ns_purchase_order_lines (
  id                uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.ns_purchase_orders(id) on delete cascade,
  material_id       uuid not null references public.ns_materials(id) on delete restrict,

  -- Counted in PACKS, the thing actually ordered. The stock ledger converts
  -- to `unit` on receipt via ns_materials.pack_quantity, so the conversion
  -- happens in exactly one place.
  packs_ordered     numeric not null,
  packs_received    numeric not null default 0,
  unit_cost         numeric,
  note              text,
  sort_order        integer not null default 0,

  constraint ns_po_lines_ordered_positive check (packs_ordered > 0),
  constraint ns_po_lines_received_nonneg  check (packs_received >= 0),
  constraint ns_po_lines_cost_nonneg      check (unit_cost is null or unit_cost >= 0),
  constraint ns_po_lines_one_per_material unique (purchase_order_id, material_id)
);

create index if not exists ns_po_lines_material_idx
  on public.ns_purchase_order_lines (material_id);

/* ===================================================================== */
/* Christmas rental sets                                                 */
/* ===================================================================== */

-- Christmas lighting is a RENTAL model (app_settings.lighting ->>
-- 'christmas_ownership_model' = 'rental', storage included), which makes a
-- set a tracked physical asset with a location and a season, not a
-- consumable quantity. That is why it is its own table rather than a
-- material with a stock count: a count cannot answer "where is the
-- Patterson set and what condition did it come back in?".

create table if not exists public.ns_rental_sets (
  id               uuid primary key default gen_random_uuid(),
  set_code         text not null,
  material_id      uuid references public.ns_materials(id) on delete set null,
  customer_id      uuid references public.customers(id) on delete restrict,
  property_id      uuid references public.properties(id) on delete set null,
  status           text not null default 'in_storage',
  linear_ft        numeric,
  season_year      integer,
  storage_location text,
  condition_note   text,
  installed_at     timestamptz,
  removed_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint ns_rental_sets_code_not_blank check (btrim(set_code) <> ''),
  constraint ns_rental_sets_status_known check (status in (
    'in_storage', 'assigned', 'installed', 'in_repair', 'retired', 'lost')),
  constraint ns_rental_sets_linear_ft_positive check (linear_ft is null or linear_ft > 0),
  constraint ns_rental_sets_season_sane check (
    season_year is null or season_year between 2000 and 2100),

  -- A set cannot be out at a customer's house without a customer. Without
  -- this, "installed" with a null customer_id reads as installed nowhere,
  -- and the set silently stops being findable at removal time.
  constraint ns_rental_sets_placed_has_customer check (
    status not in ('assigned', 'installed') or customer_id is not null),

  constraint ns_rental_sets_installed_has_date check (
    status <> 'installed' or installed_at is not null)
);

create unique index if not exists ns_rental_sets_code_key
  on public.ns_rental_sets (lower(btrim(set_code)));

create index if not exists ns_rental_sets_status_idx
  on public.ns_rental_sets (status, season_year desc);

create index if not exists ns_rental_sets_customer_idx
  on public.ns_rental_sets (customer_id)
  where customer_id is not null;

/* Append-only lifecycle log. Same reasoning as the stock ledger: the
   current status answers "where is it now", and only an event log answers
   "how did it get there", which is what a damage dispute or a missing set
   actually turns on. */
create table if not exists public.ns_rental_set_events (
  id             uuid primary key default gen_random_uuid(),
  rental_set_id  uuid not null references public.ns_rental_sets(id) on delete cascade,
  event          text not null,
  job_id         uuid references public.ns_jobs(id) on delete set null,
  customer_id    uuid references public.customers(id) on delete set null,
  occurred_at    timestamptz not null default now(),
  note           text,
  created_at     timestamptz not null default now(),
  created_by     uuid references auth.users(id),

  constraint ns_rental_set_events_known check (event in (
    'received', 'assigned', 'unassigned', 'installed', 'removed',
    'stored', 'repaired', 'retired', 'lost', 'inspected'))
);

create index if not exists ns_rental_set_events_set_idx
  on public.ns_rental_set_events (rental_set_id, occurred_at desc);

/* ===================================================================== */
/* stock locations                                                       */
/* ===================================================================== */

-- Base, Car A, and later Car B. Stock is counted PER LOCATION, not as one
-- global pile, because the question the business actually asks every
-- morning is "what is in the car" and the question it asks every evening is
-- "what came back".
--
-- CAR B IS CAPABILITY, NOT DATA. The owner runs one crew today and expects
-- a second later. A second vehicle is therefore a ROW somebody inserts, not
-- a migration somebody writes: nothing below hardcodes two vehicles, and
-- only Base and Car A are seeded. Adding Car B is data entry.
--
-- ONE BASE, enforced. The blueprint describes a single stock base with the
-- vehicles drawing from it. A second base row would silently split that
-- pool in two and make every "is it in stock" answer ambiguous, so the
-- partial unique index below makes it impossible rather than discouraged.

create table if not exists public.ns_stock_locations (
  id         uuid primary key default gen_random_uuid(),
  code       text not null,
  name       text not null,
  kind       text not null,
  active     boolean not null default true,
  sort_order integer not null default 0,
  note       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint ns_stock_locations_code_not_blank check (btrim(code) <> ''),
  constraint ns_stock_locations_name_not_blank check (btrim(name) <> ''),
  constraint ns_stock_locations_kind_known check (kind in ('base', 'vehicle'))
);

create unique index if not exists ns_stock_locations_code_key
  on public.ns_stock_locations (lower(btrim(code)));

create unique index if not exists ns_stock_locations_one_base
  on public.ns_stock_locations ((kind))
  where kind = 'base';

insert into public.ns_stock_locations (code, name, kind, sort_order, note) values
  ('base',  'Base',  'base',    0, 'The single shared stock pool everything is drawn from and returned to.'),
  ('car_a', 'Car A', 'vehicle', 1, 'Crew A''s vehicle.')
on conflict do nothing;

/* ===================================================================== */
/* stock operations (the replay-safe unit of work)                       */
/* ===================================================================== */

-- Every movement belongs to an OPERATION. An operation is what the field
-- or the admin screen asked for; movements are what the ledger did about
-- it. The split exists for three reasons, each of which is a requirement
-- rather than a preference:
--
--   1. REPLAY SAFETY. client_operation_id is unique, so the same request
--      sent twice -- a retried write, a flaky connection, a tap the
--      operator was not sure registered -- cannot add stock twice. The
--      second attempt collides and the RPC returns the FIRST operation
--      unchanged, so the caller sees success without a duplicate.
--   2. A TRANSFER IS ONE ACT, TWO MOVEMENTS. Grouping them under one
--      operation is what lets the conservation rule below be stated at all.
--   3. ATTRIBUTION. Who did it, from which vehicle, and whether the
--      physical movement was confirmed. "Confirm physical movement before
--      stock moves" cannot be enforced against a bare ledger row.
--
-- record_version supports optimistic concurrency for callers that re-read
-- and re-submit. It is incremented by any amendment to the operation
-- itself; movements are never amended, only reversed.

create table if not exists public.ns_stock_operations (
  id                  uuid primary key default gen_random_uuid(),

  -- Supplied by the CALLER, not the server: it has to survive the retry
  -- that the server never saw the first time.
  client_operation_id text not null,

  kind                text not null,
  actor_id            uuid references auth.users(id),
  vehicle_location_id uuid references public.ns_stock_locations(id) on delete restrict,

  -- A transfer does not move stock until somebody says the goods physically
  -- moved. Defaulting false means the honest state is the default.
  confirmed_physical  boolean not null default false,

  record_version      integer not null default 1,
  job_id              uuid references public.ns_jobs(id) on delete set null,
  purchase_order_id   uuid references public.ns_purchase_orders(id) on delete set null,
  note                text,
  occurred_at         timestamptz not null default now(),
  created_at          timestamptz not null default now(),

  constraint ns_stock_operations_client_id_not_blank
    check (btrim(client_operation_id) <> ''),
  constraint ns_stock_operations_kind_known check (kind in (
    'receipt', 'transfer', 'consumption', 'correction', 'opening')),
  constraint ns_stock_operations_version_positive check (record_version >= 1)
);

create unique index if not exists ns_stock_operations_client_id_key
  on public.ns_stock_operations (client_operation_id);

create index if not exists ns_stock_operations_kind_idx
  on public.ns_stock_operations (kind, occurred_at desc);

/* The CHECK above cannot read another table, so the vehicle-is-a-vehicle
   rule is a trigger. Stated as a rule rather than left to callers because
   an operation attributed to "Base" as if it were a car is the kind of row
   that reads as correct in every report and is wrong in all of them. */
create or replace function public.ns_guard_operation_vehicle()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare
  v_kind text;
begin
  if new.vehicle_location_id is null then return new; end if;
  select kind into v_kind from public.ns_stock_locations
   where id = new.vehicle_location_id;
  if v_kind is distinct from 'vehicle' then
    raise exception
      'vehicle_location_id must name a vehicle location, not %', coalesce(v_kind, 'a missing location')
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

drop trigger if exists guard_operation_vehicle on public.ns_stock_operations;
create trigger guard_operation_vehicle
  before insert or update on public.ns_stock_operations
  for each row execute function public.ns_guard_operation_vehicle();

/* ===================================================================== */
/* stock ledger                                                          */
/* ===================================================================== */

create table if not exists public.ns_material_stock_moves (
  id                uuid primary key default gen_random_uuid(),
  material_id       uuid not null references public.ns_materials(id) on delete restrict,

  -- WHERE the stock is. Not nullable: a movement that does not say where it
  -- happened cannot be reconciled against a shelf or a car, and a default
  -- would quietly attribute somebody's car count to Base.
  location_id       uuid not null references public.ns_stock_locations(id) on delete restrict,

  -- WHICH act this is part of. Not nullable for the same reason: an
  -- orphaned movement has no replay key, no actor and no confirmation, so
  -- none of the guarantees above would hold for it.
  operation_id      uuid not null references public.ns_stock_operations(id) on delete restrict,

  -- In `unit`, signed. Positive adds to that location, negative takes off it.
  delta             numeric not null,
  reason            text not null,

  job_id            uuid references public.ns_jobs(id) on delete set null,
  purchase_order_id uuid references public.ns_purchase_orders(id) on delete set null,
  rental_set_id     uuid references public.ns_rental_sets(id) on delete set null,
  note              text,
  occurred_at       timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  created_by        uuid references auth.users(id),

  constraint ns_stock_moves_delta_nonzero check (delta <> 0),
  constraint ns_stock_moves_reason_known check (reason in (
    'received', 'consumed', 'returned', 'damaged', 'adjustment', 'opening',
    'transfer')),

  -- The sign has to agree with the reason. A "received" posted negative, or
  -- a "consumed" posted positive, is a data-entry slip that would otherwise
  -- read as a legitimate movement and quietly corrupt the on-hand figure.
  -- 'adjustment' is the deliberate escape hatch and may go either way.
  constraint ns_stock_moves_sign_matches_reason check (
    case reason
      when 'received' then delta > 0
      when 'returned' then delta > 0
      when 'opening'  then delta > 0
      when 'consumed' then delta < 0
      when 'damaged'  then delta < 0
      -- 'transfer' is signed by which leg it is (out of one location,
      -- into another), and 'adjustment' is the deliberate escape hatch.
      -- Both are checked by the conservation rule instead.
      else true
    end)
);

create index if not exists ns_stock_moves_material_idx
  on public.ns_material_stock_moves (material_id, occurred_at desc);

create index if not exists ns_stock_moves_job_idx
  on public.ns_material_stock_moves (job_id)
  where job_id is not null;

create index if not exists ns_stock_moves_operation_idx
  on public.ns_material_stock_moves (operation_id);

create index if not exists ns_stock_moves_location_idx
  on public.ns_material_stock_moves (location_id, material_id);

/* ------------------------------------------------- transfers conserve --- */

-- "Transfers conserve totals" is an acceptance criterion, so it is a
-- database rule, not a convention the RPC is trusted to follow. For every
-- transfer operation, each material's movements must sum to EXACTLY zero:
-- what leaves one location arrives at another, and the two legs must name
-- different locations.
--
-- DEFERRED, and this is the whole point. The two legs are separate INSERTs;
-- an immediate check would fire after the first one and fail every
-- legitimate transfer. A CONSTRAINT TRIGGER deferred to COMMIT sees the
-- finished transaction, which is the only moment at which conservation is
-- a meaningful question.

create or replace function public.ns_guard_transfer_conserves()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare
  v_kind    text;
  v_bad     record;
  v_op      uuid := coalesce(new.operation_id, old.operation_id);
begin
  select kind into v_kind from public.ns_stock_operations where id = v_op;
  if v_kind is distinct from 'transfer' then
    return null;                       -- only transfers are conserving
  end if;

  select mv.material_id,
         sum(mv.delta)                       as net,
         count(distinct mv.location_id)      as locations,
         count(*)                            as legs
    into v_bad
    from public.ns_material_stock_moves mv
   where mv.operation_id = v_op
   group by mv.material_id
  having sum(mv.delta) <> 0
      or count(distinct mv.location_id) <> 2
      or count(*) <> 2
   limit 1;

  if found then
    raise exception
      'Transfer % does not conserve material %: % leg(s) across % location(s), net %. '
      'A transfer must be exactly two legs, two distinct locations, summing to zero.',
      v_op, v_bad.material_id, v_bad.legs, v_bad.locations, v_bad.net
      using errcode = 'check_violation';
  end if;

  return null;
end $$;

drop trigger if exists guard_transfer_conserves on public.ns_material_stock_moves;
create constraint trigger guard_transfer_conserves
  after insert or update or delete on public.ns_material_stock_moves
  deferrable initially deferred
  for each row execute function public.ns_guard_transfer_conserves();

/* ------------------------------------------------------ derived stock --- */

/* Per material PER LOCATION. This is the real balance: the morning question
   is "what is in Car A", and a single global figure cannot answer it.
   A CROSS JOIN against the location list, so a material that has never
   moved into a location still reports 0 there rather than being absent --
   the same reasoning as the LEFT JOIN below, one level down. */
-- Dropped before creating, not replaced: a later migration widens this
-- view, and CREATE OR REPLACE VIEW cannot remove a column. Without the
-- drop, re-running the migration set in order fails on the second pass.
drop view if exists public.ns_material_stock cascade;
drop view if exists public.ns_material_stock_by_location cascade;

create or replace view public.ns_material_stock_by_location as
select m.id           as material_id,
       m.sku,
       m.name,
       m.category,
       m.unit,
       m.active,
       l.id           as location_id,
       l.code         as location_code,
       l.name         as location_name,
       l.kind         as location_kind,
       coalesce(sum(mv.delta), 0)          as on_hand,
       max(mv.occurred_at)                 as last_move_at
  from public.ns_materials m
 cross join public.ns_stock_locations l
  left join public.ns_material_stock_moves mv
         on mv.material_id = m.id and mv.location_id = l.id
 where l.active
 group by m.id, l.id;

/* Totals across every location, kept at its ORIGINAL shape so the callers
   written before locations existed -- estimate_job_materials and the admin
   catalogue -- keep working unchanged. A LEFT JOIN so a catalogue row with
   no movements yet reads as 0 rather than disappearing: a part that has
   never been received is precisely the one a shortfall report must still
   mention.
   Note what this total means now. It is everything the business owns,
   wherever it sits -- NOT what is reachable for a given job. Stock in a
   vehicle is available to that vehicle's work and returns to Base to become
   generally available again (owner's decision, recorded in
   docs/batch8-1-scope-reconciliation.md §5). Callers that need reachable
   stock must ask by location; see estimate_job_materials' basis parameter. */
create or replace view public.ns_material_stock as
select m.id            as material_id,
       m.sku,
       m.name,
       m.category,
       m.unit,
       m.supplier_id,
       m.pack_quantity,
       m.unit_cost,
       m.currency,
       m.reorder_point,
       m.reorder_qty,
       m.active,
       coalesce(sum(mv.delta), 0)                  as on_hand,
       coalesce(sum(mv.delta) filter (
         where mv.reason = 'consumed'), 0)         as consumed_total,
       max(mv.occurred_at)                         as last_move_at,
       (coalesce(sum(mv.delta), 0) <= m.reorder_point) as needs_reorder
  from public.ns_materials m
  left join public.ns_material_stock_moves mv on mv.material_id = m.id
 group by m.id;

/* ===================================================================== */
/* service -> material requirement mapping                               */
/* ===================================================================== */

-- This is what lets a materials requirement be DERIVED from the
-- measurements the field already captures, instead of asking anyone to
-- type the job's parts a second time. One row says "permanent_lighting
-- consumes 1 ft of track per linear ft measured, plus 8% waste".

create table if not exists public.ns_service_material_usage (
  id                uuid primary key default gen_random_uuid(),
  service_id        uuid not null references public.services(id) on delete restrict,
  material_id       uuid not null references public.ns_materials(id) on delete restrict,

  -- In material `unit` per one measured service unit.
  quantity_per_unit numeric not null,

  -- 0.08 = 8% extra for cuts and offcuts. Capped at 1.0 (100% extra): a
  -- larger figure is a typo far more often than a real allowance, and an
  -- unbounded multiplier here would silently inflate every purchase order.
  waste_factor      numeric not null default 0,

  note              text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint ns_usage_quantity_positive check (quantity_per_unit > 0),
  constraint ns_usage_waste_in_range    check (waste_factor >= 0 and waste_factor <= 1),
  constraint ns_usage_one_per_pair      unique (service_id, material_id)
);

create index if not exists ns_usage_service_idx
  on public.ns_service_material_usage (service_id);

/* ===================================================================== */
/* updated_at                                                            */
/* ===================================================================== */

create or replace function public.ns_touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'ns_suppliers', 'ns_materials', 'ns_purchase_orders',
    'ns_rental_sets', 'ns_service_material_usage', 'ns_stock_locations'
  ] loop
    execute format(
      'drop trigger if exists %I on public.%I', 'touch_' || t, t);
    execute format(
      'create trigger %I before update on public.%I
         for each row execute function public.ns_touch_updated_at()',
      'touch_' || t, t);
  end loop;
end
$$;

/* ===================================================================== */
/* RLS + grants                                                          */
/* ===================================================================== */

do $$
declare
  t text;
begin
  foreach t in array array[
    'ns_suppliers', 'ns_materials', 'ns_purchase_orders',
    'ns_purchase_order_lines', 'ns_rental_sets', 'ns_rental_set_events',
    'ns_material_stock_moves', 'ns_service_material_usage',
    'ns_stock_locations', 'ns_stock_operations'
  ] loop
    execute format('alter table public.%I enable row level security', t);

    -- ENABLE, not FORCE. Checked live: all 31 existing RLS tables in this
    -- schema are enable-only, none forced. FORCE would also apply the
    -- policy to the table OWNER, which is the role migrations run as, so a
    -- future maintenance statement would be blocked by is_admin() being
    -- false for postgres. service_role carries BYPASSRLS (verified live),
    -- so the server-side path is unaffected either way.
    execute format('drop policy if exists admin_all on public.%I', t);
    execute format(
      'create policy admin_all on public.%I
         for all to authenticated
         using (public.is_admin()) with check (public.is_admin())', t);

    -- Explicit revoke before any grant: Batch 7.1 established that a
    -- privilege can be held directly, through PUBLIC, or inherited, and
    -- that "we never granted it" is not the same as "nobody has it".
    execute format('revoke all on public.%I from public', t);
    execute format('revoke all on public.%I from anon', t);

    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end
$$;

/* The view is security_invoker so it is read under the caller's own
   policies rather than the view owner's. Without this, a view over
   RLS-protected tables hands out every row to anyone who can select the
   view, regardless of the admin_all policy underneath. Requires
   PostgreSQL 15+; this project reports 17.6 (checked live before writing). */
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

comment on table public.ns_materials is
  'Parts catalogue. Populated from the admin Inventory screen; no rows are '
  'seeded by migration because the supplier catalogue has never been read '
  'by this application.';

comment on table public.ns_material_stock_moves is
  'Append-only stock ledger, per material PER LOCATION. On-hand is the sum '
  'of delta, exposed by ns_material_stock_by_location and rolled up by '
  'ns_material_stock. Correct a mistake by posting its reverse, not by '
  'editing or deleting a row.';

comment on table public.ns_stock_locations is
  'Base and the vehicles. One base is enforced. A second vehicle is a row '
  'somebody inserts, not a migration somebody writes: only Base and Car A '
  'are seeded.';

comment on table public.ns_stock_operations is
  'The replay-safe unit of work every movement belongs to. '
  'client_operation_id is unique, so a retried request cannot post stock '
  'twice. See docs/operations-contract-v1.md.';

comment on table public.ns_rental_sets is
  'Christmas lighting rental sets as tracked physical assets (rental '
  'ownership model, storage included). Lifecycle history lives in '
  'ns_rental_set_events.';
