-- Batch 9.1 corrective: the permanent-lighting half.
--
-- The delivered 9.1 brief covered the Christmas sets only. The roadmap's own
-- 9.1 section also asks for "reviewed material sheets, sealed kit opening,
-- component availability, compatible product references and worthwhile
-- offcuts" and "heating-kit selection in the material sheet". This migration
-- is that half.
--
-- FOUR THINGS, AND THE RULE EACH ONE EXISTS TO ENFORCE
--
-- 1. A KIT SHEET says what is inside a supplier kit. Without one, opening a
--    kit would be somebody typing quantities from memory. A sheet that has
--    not been reviewed cannot be used for anything, which is how "unknown
--    specifications must remain explicit" becomes enforceable rather than a
--    note in a document.
--
-- 2. OPENING a kit converts it: the sealed kit leaves stock in the same
--    transaction its components enter. "An unopened permanent kit and its
--    component stock may never both count as available" (roadmap handoff).
--    A new operation kind makes that pairing checkable at COMMIT.
--
-- 3. AN OFFCUT is a piece, not a quantity. Two 3 ft offcuts are not a 6 ft
--    run, and a planner that only knew "6 ft on hand" would promise one.
--    So offcuts are tracked individually, with an invariant tying them to
--    the ledger so the two can never drift apart.
--
-- 4. A JOB MATERIAL SHEET is what the owner reviews before anything is
--    reserved. Reserving from the sheet -- and only from its selected lines
--    -- is what delivers "accepted work reserves only selected materials,
--    not every draft quote option".
--
-- NO PRODUCT DATA IS INVENTED HERE. permanentlightingdirect.ca is
-- unreachable from this environment (the same wall Batch 8.1 and Codex both
-- hit). Not one kit, component, coverage figure, pack size, price or
-- compatibility claim is seeded. Every sheet starts unreviewed and every
-- material starts with its specification marked unverified, which blocks
-- the recommendations that would otherwise rest on a guess.
--
-- NOT APPLIED. Written and tested against a disposable PostgreSQL only.

/* ===================================================================== */
/* 1. what a material IS, more precisely                                 */
/* ===================================================================== */

-- Three facts the existing catalogue cannot express, each of which decides
-- a real question:
--
--   cuttable      -- "Distinguish fixed-length kits from products explicitly
--                    permitted to be cut to length." A fixed cable kit is
--                    not a roll you can take 14 ft off.
--   stock_length  -- how long ONE piece is, so "how many sticks" is a
--                    division the database can do instead of a person.
--                    Null means unknown, which is not the same as 1.
--   spec_state    -- whether anybody has actually checked the product
--                    listing. Everything is 'unverified' until they have.

alter table public.ns_materials
  add column if not exists cuttable boolean not null default false;

alter table public.ns_materials
  add column if not exists stock_length numeric;

alter table public.ns_materials
  drop constraint if exists ns_materials_stock_length_positive;
alter table public.ns_materials
  add constraint ns_materials_stock_length_positive
    check (stock_length is null or stock_length > 0);

alter table public.ns_materials
  add column if not exists spec_state text not null default 'unverified';

alter table public.ns_materials
  drop constraint if exists ns_materials_spec_state_known;
alter table public.ns_materials
  add constraint ns_materials_spec_state_known check (spec_state in (
    'unverified',   -- nobody has read the product listing yet
    'reviewed',     -- an owner has, and recorded the source
    'unavailable'   -- the listing could not be reached or does not say
  ));

-- Where the figures came from. A specification with no source is a memory,
-- and this whole batch exists because memories of pack sizes are wrong.
alter table public.ns_materials
  add column if not exists spec_source text;
alter table public.ns_materials
  add column if not exists spec_reviewed_at timestamptz;
alter table public.ns_materials
  add column if not exists spec_reviewed_by uuid references auth.users(id);

alter table public.ns_materials
  drop constraint if exists ns_materials_spec_review_dated;
alter table public.ns_materials
  add constraint ns_materials_spec_review_dated check (
    (spec_state = 'reviewed') = (spec_reviewed_at is not null));

-- 'kit' joins the categories: a sealed supplier kit is its own kind of
-- thing, counted in kits until it is opened and in components afterwards.
alter table public.ns_materials
  drop constraint if exists ns_materials_category_known;
alter table public.ns_materials
  add constraint ns_materials_category_known check (category in (
    'track', 'light', 'controller', 'power_supply', 'connector',
    'clip', 'wire', 'rental_set', 'consumable', 'tool', 'other',
    -- new in the 9.1 corrective
    'kit',            -- a sealed supplier kit, opened into components
    'heating_cable'   -- fixed-length cable kits and cuttable cable alike;
                      -- `cuttable` is what tells them apart
  ));

comment on column public.ns_materials.cuttable is
  'Whether this product may be cut to length. A fixed-length cable kit is '
  'not a cuttable roll, and treating one as the other produces a plan that '
  'cannot be built.';

/* ===================================================================== */
/* 2. kit sheets -- what is inside a sealed kit                          */
/* ===================================================================== */

create table if not exists public.ns_kit_sheets (
  id            uuid primary key default gen_random_uuid(),
  material_id   uuid not null references public.ns_materials(id) on delete cascade,

  -- The owner's own description of the kit, from the listing. Nullable
  -- throughout, because an unknown coverage must read as unknown.
  model         text,
  coverage_ft   numeric,
  channel_format text,
  power_format  text,

  review_state  text not null default 'draft',
  source        text,                       -- the listing this came from
  reviewed_at   timestamptz,
  reviewed_by   uuid references auth.users(id),
  note          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint ns_kit_sheets_state_known check (review_state in (
    'draft',        -- being typed up
    'reviewed',     -- checked against the listing; usable
    'needs_data'    -- the listing could not be read or does not say
  )),
  constraint ns_kit_sheets_coverage_positive
    check (coverage_ft is null or coverage_ft > 0),

  -- A reviewed sheet must say where the figures came from, and when.
  constraint ns_kit_sheets_reviewed_sourced check (
    review_state <> 'reviewed'
    or (reviewed_at is not null and coalesce(btrim(source), '') <> ''))
);

create unique index if not exists ns_kit_sheets_one_per_material
  on public.ns_kit_sheets (material_id);

create table if not exists public.ns_kit_sheet_lines (
  id                uuid primary key default gen_random_uuid(),
  sheet_id          uuid not null references public.ns_kit_sheets(id) on delete cascade,
  material_id       uuid not null references public.ns_materials(id) on delete restrict,

  -- Null is a REAL value here: "the listing says this is included but not
  -- how many". A sheet carrying one of these cannot be reviewed, which is
  -- what stops an unknown quantity reaching a recommendation.
  quantity_per_kit  numeric,

  inclusion         text not null default 'included',
  note              text,
  created_at        timestamptz not null default now(),

  constraint ns_kit_sheet_lines_quantity_positive
    check (quantity_per_kit is null or quantity_per_kit > 0),
  constraint ns_kit_sheet_lines_inclusion_known check (inclusion in (
    'included',             -- comes in the box
    'separately_required'   -- needed for the install, not in the box
  )),
  constraint ns_kit_sheet_lines_one_per_material unique (sheet_id, material_id)
);

create index if not exists ns_kit_sheet_lines_material_idx
  on public.ns_kit_sheet_lines (material_id);

/* A sheet cannot be REVIEWED while any included line has no quantity, and
   cannot be reviewed with no lines at all. Stated as a deferred constraint
   trigger because the RPC writes the sheet and its lines in one
   transaction, and an immediate check would fail on the first statement of
   every legitimate review. */
create or replace function public.ns_guard_kit_sheet_reviewable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_sheet uuid;
  v_state text;
  v_lines integer;
  v_blank integer;
begin
  if tg_table_name = 'ns_kit_sheets' then
    v_sheet := new.id;
  elsif tg_op = 'DELETE' then
    v_sheet := old.sheet_id;
  else
    v_sheet := new.sheet_id;
  end if;

  select review_state into v_state from public.ns_kit_sheets where id = v_sheet;
  if v_state is null or v_state <> 'reviewed' then return null; end if;

  select count(*), count(*) filter (
           where inclusion = 'included' and quantity_per_kit is null)
    into v_lines, v_blank
    from public.ns_kit_sheet_lines where sheet_id = v_sheet;

  if v_lines = 0 then
    raise exception
      'A reviewed kit sheet with no components says nothing. Record what is '
      'in the box, or mark the sheet needs_data.'
      using errcode = 'check_violation';
  end if;
  if v_blank > 0 then
    raise exception
      'Kit sheet % has % included component(s) with no quantity. An unknown '
      'quantity cannot be reviewed -- leave the sheet as needs_data so it '
      'cannot be used to open a kit or plan a job.', v_sheet, v_blank
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;

drop trigger if exists guard_kit_sheet_reviewable on public.ns_kit_sheets;
create constraint trigger guard_kit_sheet_reviewable
  after insert or update on public.ns_kit_sheets
  deferrable initially deferred
  for each row execute function public.ns_guard_kit_sheet_reviewable();

drop trigger if exists guard_kit_sheet_lines_reviewable on public.ns_kit_sheet_lines;
create constraint trigger guard_kit_sheet_lines_reviewable
  after insert or update or delete on public.ns_kit_sheet_lines
  deferrable initially deferred
  for each row execute function public.ns_guard_kit_sheet_reviewable();

comment on table public.ns_kit_sheets is
  'What is inside one supplier kit, taken from the actual product listing. '
  'Nothing here is seeded: every figure is owner-entered, and a sheet that '
  'has not been reviewed against a named source cannot open a kit or feed a '
  'job plan.';

/* ===================================================================== */
/* 3. conversion -- the operation kind that opens a kit                  */
/* ===================================================================== */

-- WHY A NEW KIND RATHER THAN REUSING ONE. Opening a kit is neither a
-- consumption (nothing was used on a job) nor a receipt (nothing arrived)
-- nor a correction (nothing was miscounted). Posting it as any of those
-- would make every report that groups by kind wrong, and would hide the one
-- event that explains why the kit count fell and the component count rose.
--
-- This is an ADDITIVE amendment to the frozen operations contract, recorded
-- as v1.1 in docs/operations-contract-v1.md. No existing shape, parameter,
-- error code or grant changes.

alter table public.ns_stock_operations
  drop constraint if exists ns_stock_operations_kind_known;
alter table public.ns_stock_operations
  add constraint ns_stock_operations_kind_known check (kind in (
    'receipt', 'transfer', 'consumption', 'correction', 'opening',
    'conversion'));

alter table public.ns_material_stock_moves
  drop constraint if exists ns_stock_moves_reason_known;
alter table public.ns_material_stock_moves
  add constraint ns_stock_moves_reason_known check (reason in (
    'received', 'consumed', 'returned', 'damaged', 'adjustment', 'opening',
    'transfer',
    -- new in the 9.1 corrective, and reachable only through open_sealed_kit
    'converted_out',   -- the sealed kit leaving stock
    'converted_in'));  -- its components arriving

alter table public.ns_material_stock_moves
  drop constraint if exists ns_stock_moves_sign_matches_reason;
alter table public.ns_material_stock_moves
  add constraint ns_stock_moves_sign_matches_reason check (
    case reason
      when 'received'      then delta > 0
      when 'returned'      then delta > 0
      when 'opening'       then delta > 0
      when 'converted_in'  then delta > 0
      when 'consumed'      then delta < 0
      when 'damaged'       then delta < 0
      when 'converted_out' then delta < 0
      else true
    end);

/* CONSERVATION OF IDENTITY. A transfer conserves quantity; a conversion
   cannot (one kit becomes 300 ft of channel and twenty connectors). What it
   must conserve is the pairing: exactly one thing left, at least one thing
   arrived, all at one location, and nothing turned into itself. Without
   this, a lone converted_in would be stock from nowhere. */
create or replace function public.ns_guard_conversion_pairs()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_op    uuid := coalesce(new.operation_id, old.operation_id);
  v_kind  text;
  v_out   integer;
  v_in    integer;
  v_locs  integer;
  v_same  integer;
begin
  select kind into v_kind from public.ns_stock_operations where id = v_op;
  if v_kind is null then return null; end if;

  select count(*) filter (where reason = 'converted_out'),
         count(*) filter (where reason = 'converted_in'),
         count(distinct location_id)
    into v_out, v_in, v_locs
    from public.ns_material_stock_moves where operation_id = v_op;

  if v_kind <> 'conversion' then
    if v_out > 0 or v_in > 0 then
      raise exception
        'A converted_out/converted_in movement belongs to a conversion '
        'operation, not a %.', v_kind
        using errcode = 'check_violation';
    end if;
    return null;
  end if;

  if v_out <> 1 then
    raise exception
      'A conversion turns exactly ONE thing into others; operation % has % '
      'converted_out movements.', v_op, v_out
      using errcode = 'check_violation';
  end if;
  if v_in < 1 then
    raise exception
      'Conversion % consumed something and produced nothing. The components '
      'must arrive in the same transaction the kit leaves, or the stock is '
      'simply gone.', v_op
      using errcode = 'check_violation';
  end if;
  if v_locs <> 1 then
    raise exception
      'A conversion happens at one place: operation % spans % locations.',
      v_op, v_locs
      using errcode = 'check_violation';
  end if;

  select count(*) into v_same
    from public.ns_material_stock_moves a
    join public.ns_material_stock_moves b
      on b.operation_id = a.operation_id and b.material_id = a.material_id
   where a.operation_id = v_op
     and a.reason = 'converted_out' and b.reason = 'converted_in';
  if v_same > 0 then
    raise exception
      'Conversion % turns a material into itself, which is not a conversion.',
      v_op
      using errcode = 'check_violation';
  end if;

  return null;
end
$$;

drop trigger if exists guard_conversion_pairs on public.ns_material_stock_moves;
create constraint trigger guard_conversion_pairs
  after insert or update or delete on public.ns_material_stock_moves
  deferrable initially deferred
  for each row execute function public.ns_guard_conversion_pairs();

/* ===================================================================== */
/* 4. offcuts -- pieces, not a quantity                                  */
/* ===================================================================== */

-- A 10 ft stick cut to 7 ft leaves 3 ft. The ledger already knows the 3 ft
-- is there: consumption took 7 off, not 10. What the ledger CANNOT say is
-- that the remaining 3 ft is one 3 ft piece rather than three 1 ft pieces,
-- and that difference decides whether a 3 ft run can be cut from stock.
--
-- So an offcut record does NOT add stock. It describes the SHAPE of stock
-- that is already on hand. The invariant below is what keeps that true.

create table if not exists public.ns_material_offcuts (
  id            uuid primary key default gen_random_uuid(),
  material_id   uuid not null references public.ns_materials(id) on delete restrict,
  location_id   uuid not null references public.ns_stock_locations(id) on delete restrict,

  length        numeric not null,
  condition     text not null default 'usable',
  status        text not null default 'available',

  -- Where it came from, so a piece can be traced back to the job that cut it.
  from_job_id   uuid references public.ns_jobs(id) on delete set null,
  created_operation uuid references public.ns_stock_operations(id) on delete set null,
  closed_operation  uuid references public.ns_stock_operations(id) on delete set null,

  client_operation_id text not null,
  note          text,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  closed_at     timestamptz,

  constraint ns_offcuts_length_positive check (length > 0),
  constraint ns_offcuts_condition_known check (condition in ('usable', 'damaged')),
  constraint ns_offcuts_status_known check (status in (
    'available',  -- on the shelf, cuttable
    'used',       -- cut into a job
    'scrapped'    -- written off; a damaged movement went with it
  )),
  constraint ns_offcuts_closed_dated check (
    (status = 'available') = (closed_at is null)),

  -- A damaged piece is not available for anything. Keeping the two fields
  -- independent would allow "available and damaged", which is the exact
  -- confusion this table is supposed to remove.
  constraint ns_offcuts_damaged_not_available check (
    condition = 'usable' or status <> 'available'),

  constraint ns_offcuts_client_id_not_blank check (btrim(client_operation_id) <> '')
);

create unique index if not exists ns_offcuts_client_id_key
  on public.ns_material_offcuts (client_operation_id);

create index if not exists ns_offcuts_available_idx
  on public.ns_material_offcuts (material_id, location_id, length desc)
  where status = 'available';

/* THE INVARIANT. Usable offcut lengths at a location can never exceed the
   usable stock the ledger says is there. If they could, the offcut list
   would be promising pieces that are not on the shelf -- which is the one
   thing this table exists to prevent. Deferred, because cutting a piece
   writes the ledger and the offcut in one transaction. */
create or replace function public.ns_guard_offcuts_within_stock()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_mat   uuid := coalesce(new.material_id, old.material_id);
  v_loc   uuid := coalesce(new.location_id, old.location_id);
  v_cut   numeric;
  v_hand  numeric;
begin
  select coalesce(sum(length), 0) into v_cut
    from public.ns_material_offcuts
   where material_id = v_mat and location_id = v_loc and status = 'available';

  if v_cut = 0 then return null; end if;

  select coalesce(sum(delta) filter (where condition = 'usable'), 0)
    into v_hand
    from public.ns_material_stock_moves
   where material_id = v_mat and location_id = v_loc;

  if v_cut > v_hand then
    raise exception
      'Offcuts at this location total % but the ledger holds %. An offcut '
      'describes stock that is already on hand; it never adds any.',
      v_cut, v_hand
      using errcode = 'check_violation';
  end if;
  return null;
end
$$;

drop trigger if exists guard_offcuts_within_stock on public.ns_material_offcuts;
create constraint trigger guard_offcuts_within_stock
  after insert or update or delete on public.ns_material_offcuts
  deferrable initially deferred
  for each row execute function public.ns_guard_offcuts_within_stock();

comment on table public.ns_material_offcuts is
  'Individual reusable pieces. Two 3 ft offcuts are not a 6 ft run, which '
  'is why these are tracked as pieces and not folded into the on-hand '
  'quantity. An offcut never adds stock: it says what shape the existing '
  'stock is in.';

/* ===================================================================== */
/* 5. job material sheets -- what the owner reviewed, and only that       */
/* ===================================================================== */

create table if not exists public.ns_job_material_sheets (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.ns_jobs(id) on delete cascade,

  status      text not null default 'draft',
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id),
  reserved_at timestamptz,
  note        text,
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint ns_job_sheets_status_known check (status in (
    'draft',      -- being put together
    'reviewed',   -- the owner has checked it; it may now reserve stock
    'reserved',   -- its selected lines hold reservations
    'cancelled'
  )),
  constraint ns_job_sheets_reviewed_dated check (
    status not in ('reviewed', 'reserved') or reviewed_at is not null),
  constraint ns_job_sheets_reserved_dated check (
    (status = 'reserved') = (reserved_at is not null))
);

/* One OPEN sheet per job. A job with two live sheets would reserve twice
   for the same work, which is the double-count this batch is about. */
create unique index if not exists ns_job_sheets_one_open_per_job
  on public.ns_job_material_sheets (job_id)
  where status in ('draft', 'reviewed', 'reserved');

create table if not exists public.ns_job_material_sheet_lines (
  id            uuid primary key default gen_random_uuid(),
  sheet_id      uuid not null references public.ns_job_material_sheets(id) on delete cascade,
  material_id   uuid not null references public.ns_materials(id) on delete restrict,

  quantity      numeric not null,

  -- SELECTED is the word that matters. Only selected lines reserve stock,
  -- which is how a draft quote's unchosen options stay out of the shelf.
  selected      boolean not null default false,

  source        text not null default 'manual',
  service_id    uuid references public.services(id) on delete set null,

  -- When a line is satisfied by a piece already on the shelf rather than by
  -- generic stock.
  offcut_id     uuid references public.ns_material_offcuts(id) on delete set null,
  reservation_id uuid references public.ns_stock_reservations(id) on delete set null,

  note          text,
  created_at    timestamptz not null default now(),

  constraint ns_job_sheet_lines_quantity_positive check (quantity > 0),
  constraint ns_job_sheet_lines_source_known check (source in (
    'manual',     -- typed in
    'selected',   -- an owner chose this product (a heating kit, say)
    'kit_sheet'   -- pulled from a reviewed kit sheet
  )),
  constraint ns_job_sheet_lines_one_per_material unique (sheet_id, material_id)
);

create index if not exists ns_job_sheet_lines_material_idx
  on public.ns_job_material_sheet_lines (material_id);

comment on table public.ns_job_material_sheets is
  'What the owner reviewed before anything was reserved. Only its SELECTED '
  'lines ever reserve stock, so a draft quote''s unchosen options never '
  'reach the shelf.';

/* ===================================================================== */
/* 6. reading availability                                               */
/* ===================================================================== */

-- "How much channel do we have" has two answers and a planner needs both:
-- the total, and the longest single piece. A 40 ft run cannot be cut from
-- eight 5 ft offcuts, and a view that reported only the total would say it
-- could.
drop view if exists public.ns_material_piece_availability cascade;
create or replace view public.ns_material_piece_availability as
select m.id                                  as material_id,
       m.sku,
       m.name,
       m.category,
       m.unit,
       m.cuttable,
       m.stock_length,
       m.spec_state,
       l.id                                  as location_id,
       l.code                                as location_code,
       coalesce(b.on_hand, 0)                as on_hand,
       coalesce(b.available, 0)              as available,
       coalesce(o.offcut_total, 0)           as offcut_total,
       coalesce(o.offcut_count, 0)           as offcut_count,
       o.longest_offcut,
       -- What is left once the recorded pieces are set aside: the part of
       -- stock that is still in full lengths.
       coalesce(b.on_hand, 0) - coalesce(o.offcut_total, 0) as full_length_total,
       case when m.stock_length is null then null
            else floor((coalesce(b.on_hand, 0) - coalesce(o.offcut_total, 0))
                       / m.stock_length) end  as full_pieces,
       -- The longest single run that could be cut today: a whole piece if
       -- there is one, otherwise the best offcut. Null when the piece
       -- length is unknown, because then nobody can say.
       case
         when m.stock_length is not null
          and coalesce(b.on_hand, 0) - coalesce(o.offcut_total, 0) >= m.stock_length
           then m.stock_length
         else o.longest_offcut
       end                                   as longest_runnable
  from public.ns_materials m
  cross join public.ns_stock_locations l
  left join public.ns_material_stock_by_location b
         on b.material_id = m.id and b.location_id = l.id
  left join (
    select material_id, location_id,
           sum(length)   as offcut_total,
           count(*)      as offcut_count,
           max(length)   as longest_offcut
      from public.ns_material_offcuts
     where status = 'available'
     group by material_id, location_id) o
         on o.material_id = m.id and o.location_id = l.id
 where l.active;

/* ===================================================================== */
/* 7. RLS and grants                                                     */
/* ===================================================================== */

do $$
declare
  t text;
begin
  foreach t in array array[
    'ns_kit_sheets', 'ns_kit_sheet_lines', 'ns_material_offcuts',
    'ns_job_material_sheets', 'ns_job_material_sheet_lines'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end
$$;

-- Sheets are owner-managed records: reviewing one is the act that lets it
-- spend stock, so it is not field work.
do $$
declare
  t text;
begin
  foreach t in array array[
    'ns_kit_sheets', 'ns_kit_sheet_lines',
    'ns_job_material_sheets', 'ns_job_material_sheet_lines'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_admin())',
      t || '_read', t);
    execute format('drop policy if exists %I on public.%I', t || '_owner_writes', t);
    execute format(
      'create policy %I on public.%I for all to authenticated '
      'using (public.is_owner()) with check (public.is_owner())',
      t || '_owner_writes', t);
  end loop;
end
$$;

-- Offcuts are scoped like the stock they describe: a crew sees the pieces
-- at Base and in its own car, and nothing in the other one.
drop policy if exists offcuts_scoped_read on public.ns_material_offcuts;
create policy offcuts_scoped_read on public.ns_material_offcuts
  for select to authenticated
  using (public.is_admin() and public.can_see_location(location_id));

-- No write policy and no write grant: offcut writes go through the RPCs in
-- the next migration, which keep the piece record and the ledger in step.
-- A direct insert would walk past the invariant's whole point.

do $$
begin
  execute 'alter view public.ns_material_piece_availability set (security_invoker = on)';
  execute 'revoke all on public.ns_material_piece_availability from public';
  execute 'revoke all on public.ns_material_piece_availability from anon';
  execute 'grant select on public.ns_material_piece_availability to authenticated';
  execute 'grant select on public.ns_material_piece_availability to service_role';
end
$$;
