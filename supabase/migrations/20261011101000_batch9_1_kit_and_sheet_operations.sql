-- Batch 9.1 corrective: operations for kits, offcuts and job material sheets.
--
--   open_sealed_kit            a kit becomes its components, once
--   record_offcut              a usable piece exists, and how long it is
--   consume_offcut             that piece goes into a job
--   scrap_offcut               that piece is written off
--   select_job_material        the owner chooses a product for this job
--   review_job_material_sheet  the owner signs the sheet off
--   reserve_job_material_sheet the SELECTED lines, and only those, hold stock
--
-- Sheet editing itself needs no RPC: ns_kit_sheets and ns_job_material_sheets
-- are owner-writable under RLS, and the reviewability guard is a database
-- trigger, so a direct write cannot produce a reviewed sheet with unknown
-- quantities. The calls above exist where a guarantee needs two tables moved
-- together, which is exactly where a browser write would break it.
--
-- NOT APPLIED. Written and tested against a disposable PostgreSQL only.

/* ===================================================================== */
/* open_sealed_kit                                                       */
/* ===================================================================== */

-- THE RULE THIS ENFORCES, from the roadmap handoff: "An unopened permanent
-- kit and its component stock may never both count as available."
--
-- The kit leaves and the components arrive in ONE transaction, as one
-- conversion operation, whose pairing the deferred trigger checks at COMMIT.
-- There is no window in which both exist, and no way to post half of it.
--
-- Separately-required components are NOT converted in. They are on the
-- sheet because the install needs them, not because they are in the box;
-- creating stock for them here would be inventing inventory.

create or replace function public.open_sealed_kit(
  p_client_operation_id text,
  p_kit_material_id     uuid,
  p_location_code       text,
  p_kit_count           numeric default 1,
  p_note                text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_exist    public.ns_stock_operations%rowtype;
  v_kit      public.ns_materials%rowtype;
  v_sheet    public.ns_kit_sheets%rowtype;
  v_location uuid;
  v_on_hand  numeric;
  v_op       uuid;
  v_lines    integer;
begin
  if not public.is_owner() then
    raise exception
      'Only the owner opens a sealed kit: it converts one asset into several '
      'and cannot be undone by a counter-movement.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_exist from public.ns_stock_operations
   where client_operation_id = p_client_operation_id;
  if found then
    if v_exist.kind <> 'conversion' then
      raise exception 'client_operation_id % was already used for a % operation',
        p_client_operation_id, v_exist.kind
        using errcode = 'unique_violation';
    end if;
    return public.ns_operation_result(v_exist.id, true);
  end if;

  if p_kit_count is null or p_kit_count <= 0 then
    raise exception 'Open at least one kit'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_kit from public.ns_materials where id = p_kit_material_id;
  if not found then
    raise exception 'No such material %', p_kit_material_id
      using errcode = 'no_data_found';
  end if;
  if v_kit.category <> 'kit' then
    raise exception
      '% is a %, not a sealed kit. Only a kit has contents to convert.',
      v_kit.name, v_kit.category
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_sheet from public.ns_kit_sheets where material_id = p_kit_material_id;
  if not found then
    raise exception
      'No component sheet for %. Record what is in the box, from the product '
      'listing, before opening one.', v_kit.name
      using errcode = 'no_data_found';
  end if;
  if v_sheet.review_state <> 'reviewed' then
    raise exception
      'The component sheet for % is %, so its contents are not established. '
      'Opening it now would create stock from an unchecked list.',
      v_kit.name, v_sheet.review_state
      using errcode = 'check_violation';
  end if;

  select count(*) into v_lines from public.ns_kit_sheet_lines
   where sheet_id = v_sheet.id and inclusion = 'included';
  if v_lines = 0 then
    raise exception
      'The sheet for % lists nothing as included, so opening it would '
      'destroy the kit and produce nothing.', v_kit.name
      using errcode = 'check_violation';
  end if;

  v_location := public.ns_location_by_code(p_location_code);
  if v_location is null then
    raise exception 'No active stock location with code %', p_location_code
      using errcode = 'no_data_found';
  end if;
  if not public.can_see_location(v_location) then
    raise exception 'You are not assigned to that location'
      using errcode = 'insufficient_privilege';
  end if;

  select coalesce(on_hand, 0) into v_on_hand
    from public.ns_material_stock_by_location
   where material_id = p_kit_material_id and location_id = v_location;
  if coalesce(v_on_hand, 0) < p_kit_count then
    raise exception
      'There are % of % at %, so % cannot be opened.',
      coalesce(v_on_hand, 0), v_kit.name, p_location_code, p_kit_count
      using errcode = 'check_violation';
  end if;

  insert into public.ns_stock_operations
    (client_operation_id, kind, actor_id, confirmed_physical, note)
  values
    (p_client_operation_id, 'conversion', auth.uid(), true,
     coalesce(p_note, 'Opened ' || p_kit_count || ' x ' || v_kit.name))
  returning id into v_op;

  insert into public.ns_material_stock_moves
    (material_id, location_id, operation_id, delta, reason, note, created_by,
     condition, count_precision)
  values
    (p_kit_material_id, v_location, v_op, -p_kit_count, 'converted_out',
     p_note, auth.uid(), 'usable', 'exact');

  insert into public.ns_material_stock_moves
    (material_id, location_id, operation_id, delta, reason, note, created_by,
     condition, count_precision)
  select l.material_id, v_location, v_op, l.quantity_per_kit * p_kit_count,
         'converted_in',
         'From ' || v_kit.name, auth.uid(), 'usable', 'exact'
    from public.ns_kit_sheet_lines l
   where l.sheet_id = v_sheet.id and l.inclusion = 'included';

  return public.ns_operation_result(v_op, false);
end
$$;

comment on function public.open_sealed_kit(text,uuid,text,numeric,text) is
  'Converts sealed kits into their recorded components in one transaction, '
  'so the kit and its contents are never both available. Refuses unless the '
  'component sheet has been reviewed against a named source.';

/* ===================================================================== */
/* offcuts                                                               */
/* ===================================================================== */

-- WHY record_offcut POSTS NO MOVEMENT. The remainder is already on hand:
-- cutting 7 ft off a 10 ft stick consumed 7, not 10, so the ledger already
-- says 3 ft is there. The offcut record says that 3 ft is ONE 3 ft piece.
-- Posting a movement here would add the same 3 ft twice.

create or replace function public.record_offcut(
  p_client_operation_id text,
  p_material_id         uuid,
  p_location_code       text,
  p_length              numeric,
  p_from_job_id         uuid default null,
  p_note                text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_exist    public.ns_material_offcuts%rowtype;
  v_mat      public.ns_materials%rowtype;
  v_location uuid;
  v_id       uuid;
begin
  if not public.is_admin() then
    raise exception 'record_offcut is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_exist from public.ns_material_offcuts
   where client_operation_id = p_client_operation_id;
  if found then
    return public.ns_offcut_result(v_exist.id, true);
  end if;

  if p_length is null or p_length <= 0 then
    raise exception 'An offcut has a length greater than zero'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_mat from public.ns_materials where id = p_material_id;
  if not found then
    raise exception 'No such material %', p_material_id
      using errcode = 'no_data_found';
  end if;
  if not v_mat.cuttable then
    raise exception
      '% is not cut to length, so it has no offcuts. A fixed-length kit is '
      'whole or it is scrap.', v_mat.name
      using errcode = 'invalid_parameter_value';
  end if;

  v_location := public.ns_location_by_code(p_location_code);
  if v_location is null then
    raise exception 'No active stock location with code %', p_location_code
      using errcode = 'no_data_found';
  end if;
  if not public.can_see_location(v_location) then
    raise exception 'You are not assigned to that location'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.ns_material_offcuts
    (material_id, location_id, length, condition, status, from_job_id,
     client_operation_id, note, created_by)
  values
    (p_material_id, v_location, p_length, 'usable', 'available', p_from_job_id,
     p_client_operation_id, p_note, auth.uid())
  returning id into v_id;

  -- The within-stock invariant is deferred, so a piece longer than the
  -- shelf holds is refused at COMMIT rather than silently recorded.
  return public.ns_offcut_result(v_id, false);
end
$$;

/** Cutting a recorded piece into a job. The length leaves the ledger HERE,
 *  because this is the moment it is used -- the piece record only ever
 *  described stock that was still on the shelf. */
create or replace function public.consume_offcut(
  p_client_operation_id text,
  p_offcut_id           uuid,
  p_job_id              uuid default null,
  p_note                text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cut public.ns_material_offcuts%rowtype;
  v_op  uuid;
  v_loc text;
begin
  if not public.is_admin() then
    raise exception 'consume_offcut is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  if exists (select 1 from public.ns_stock_operations
              where client_operation_id = p_client_operation_id) then
    select * into v_cut from public.ns_material_offcuts
     where closed_operation = (select id from public.ns_stock_operations
                                where client_operation_id = p_client_operation_id);
    if found then return public.ns_offcut_result(v_cut.id, true); end if;
    raise exception 'client_operation_id % was already used for another operation',
      p_client_operation_id
      using errcode = 'unique_violation';
  end if;

  select * into v_cut from public.ns_material_offcuts
   where id = p_offcut_id for update;
  if not found then
    raise exception 'No such offcut %', p_offcut_id using errcode = 'no_data_found';
  end if;
  if not public.can_see_location(v_cut.location_id) then
    raise exception 'You are not assigned to that location'
      using errcode = 'insufficient_privilege';
  end if;
  if v_cut.status <> 'available' then
    raise exception 'That piece is already %', v_cut.status
      using errcode = 'check_violation';
  end if;

  select code into v_loc from public.ns_stock_locations where id = v_cut.location_id;

  insert into public.ns_stock_operations
    (client_operation_id, kind, actor_id, confirmed_physical, job_id, note)
  values
    (p_client_operation_id, 'consumption', auth.uid(), true, p_job_id, p_note)
  returning id into v_op;

  insert into public.ns_material_stock_moves
    (material_id, location_id, operation_id, delta, reason, job_id, note,
     created_by, condition, count_precision)
  values
    (v_cut.material_id, v_cut.location_id, v_op, -v_cut.length, 'consumed',
     p_job_id, coalesce(p_note, 'Offcut used'), auth.uid(), 'usable', 'exact');

  update public.ns_material_offcuts
     set status = 'used', closed_at = now(), closed_operation = v_op,
         from_job_id = coalesce(p_job_id, from_job_id),
         note = coalesce(p_note, note)
   where id = p_offcut_id;

  return public.ns_offcut_result(p_offcut_id, false);
end
$$;

/** A piece that is no longer worth keeping. It leaves the ledger as damaged
 *  -- not as a silent deletion of the record, which would leave the shelf
 *  count claiming material that is in the bin. */
create or replace function public.scrap_offcut(
  p_client_operation_id text,
  p_offcut_id           uuid,
  p_note                text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cut public.ns_material_offcuts%rowtype;
  v_op  uuid;
begin
  if not public.is_admin() then
    raise exception 'scrap_offcut is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_cut from public.ns_material_offcuts
   where id = p_offcut_id for update;
  if not found then
    raise exception 'No such offcut %', p_offcut_id using errcode = 'no_data_found';
  end if;
  if not public.can_see_location(v_cut.location_id) then
    raise exception 'You are not assigned to that location'
      using errcode = 'insufficient_privilege';
  end if;
  if v_cut.status = 'scrapped' then
    return public.ns_offcut_result(v_cut.id, true);
  end if;
  if v_cut.status <> 'available' then
    raise exception 'That piece is already %, so it cannot be scrapped', v_cut.status
      using errcode = 'check_violation';
  end if;

  if exists (select 1 from public.ns_stock_operations
              where client_operation_id = p_client_operation_id) then
    raise exception 'client_operation_id % was already used',
      p_client_operation_id using errcode = 'unique_violation';
  end if;

  insert into public.ns_stock_operations
    (client_operation_id, kind, actor_id, confirmed_physical, note)
  values
    (p_client_operation_id, 'consumption', auth.uid(), true,
     coalesce(p_note, 'Offcut scrapped'))
  returning id into v_op;

  -- condition='usable' with reason='damaged' is not a contradiction: in this
  -- ledger `condition` names WHICH POOL the quantity moves in and `reason`
  -- says why. The piece is leaving the usable pool, and the reason it left
  -- is that it is damaged. Posting it as condition='damaged' would drive the
  -- damaged pool negative and leave the usable count still claiming a piece
  -- that is in the bin -- which a test caught before this shipped.
  insert into public.ns_material_stock_moves
    (material_id, location_id, operation_id, delta, reason, note, created_by,
     condition, count_precision)
  values
    (v_cut.material_id, v_cut.location_id, v_op, -v_cut.length, 'damaged',
     coalesce(p_note, 'Offcut scrapped'), auth.uid(), 'usable', 'exact');

  update public.ns_material_offcuts
     set status = 'scrapped', condition = 'damaged', closed_at = now(),
         closed_operation = v_op, note = coalesce(p_note, note)
   where id = p_offcut_id;

  return public.ns_offcut_result(p_offcut_id, false);
end
$$;

create or replace function public.ns_offcut_result(
  p_offcut_id uuid, p_replayed boolean)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'offcut_id',           c.id,
    'client_operation_id', c.client_operation_id,
    'material_id',         c.material_id,
    'location_id',         c.location_id,
    'location_code',       l.code,
    'length',              c.length,
    'condition',           c.condition,
    'status',              c.status,
    'from_job_id',         c.from_job_id,
    'closed_operation',    c.closed_operation,
    'replayed',            p_replayed,
    'pieces', (
      select jsonb_build_object(
               'on_hand',          v.on_hand,
               'offcut_total',     v.offcut_total,
               'offcut_count',     v.offcut_count,
               'longest_offcut',   v.longest_offcut,
               'full_length_total', v.full_length_total,
               'longest_runnable', v.longest_runnable)
        from public.ns_material_piece_availability v
       where v.material_id = c.material_id and v.location_id = c.location_id)
  )
  from public.ns_material_offcuts c
  join public.ns_stock_locations l on l.id = c.location_id
  where c.id = p_offcut_id
$$;

/* ===================================================================== */
/* job material sheets                                                   */
/* ===================================================================== */

/** Candidate heating kits for a job, WITH the measurements, and no ranking.
 *
 *  "Roofline/downspout measurements, valleys/corners and the manufacturer's
 *  layout determine the selected cable/kit" -- a person reads the layout,
 *  not this function. It lists what we could supply and what the job
 *  measured, side by side, and says nothing about which to choose. A
 *  material whose specification has not been reviewed is listed as
 *  unselectable rather than hidden, so the gap is visible. */
create or replace function public.ns_heating_kit_candidates(p_job_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'job_id', p_job_id,
    'measurements', coalesce((
      select jsonb_agg(jsonb_build_object(
               'service_key', s.key,
               'service_name', s.name,
               'label',       jm.label,
               'quantity',    jm.quantity,
               'unit',        jm.unit,
               'review_required', jm.review_required)
             order by s.sort_order, jm.sort_order)
        from public.job_measurements jm
        join public.services s on s.id = jm.service_id
       where jm.job_id = p_job_id), '[]'::jsonb),
    -- Stated plainly in the payload so no caller mistakes a list for advice.
    'selection_rule',
      'The manufacturer''s layout decides the cable or kit. This list is '
      'what we stock, not a recommendation, and quoted roofline length is '
      'not cable length.',
    'candidates', coalesce((
      select jsonb_agg(jsonb_build_object(
               'material_id',  m.id,
               'name',         m.name,
               'sku',          m.sku,
               'category',     m.category,
               'cuttable',     m.cuttable,
               'stock_length', m.stock_length,
               'spec_state',   m.spec_state,
               'spec_source',  m.spec_source,
               'selectable',   m.spec_state = 'reviewed',
               'why_not', case when m.spec_state = 'reviewed' then null
                               else 'The product specification has not been '
                                    || 'checked against the listing.' end)
             order by m.name)
        from public.ns_materials m
       where m.active and m.category = 'heating_cable'), '[]'::jsonb))
$$;

/** Put a product on the job's sheet. `selected` is what later reserves
 *  stock, and an unreviewed specification cannot be selected -- which is
 *  how "unknown specifications prevent unsupported recommendations" stops
 *  being a sentence in a document. */
create or replace function public.select_job_material(
  p_client_operation_id text,
  p_sheet_id            uuid,
  p_material_id         uuid,
  p_quantity            numeric,
  p_selected            boolean default true,
  p_source              text    default 'selected',
  p_service_id          uuid    default null,
  p_note                text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sheet public.ns_job_material_sheets%rowtype;
  v_mat   public.ns_materials%rowtype;
  v_line  uuid;
begin
  if not public.is_owner() then
    raise exception 'Only the owner selects materials for a job'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_source not in ('manual', 'selected', 'kit_sheet') then
    raise exception 'source must be manual, selected or kit_sheet'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'A sheet line needs a quantity greater than zero'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_sheet from public.ns_job_material_sheets
   where id = p_sheet_id for update;
  if not found then
    raise exception 'No such material sheet %', p_sheet_id
      using errcode = 'no_data_found';
  end if;
  if v_sheet.status <> 'draft' then
    raise exception
      'Sheet % is %, so its lines are settled. Reserved and reviewed sheets '
      'are the record of what was agreed.', p_sheet_id, v_sheet.status
      using errcode = 'check_violation';
  end if;

  select * into v_mat from public.ns_materials where id = p_material_id;
  if not found then
    raise exception 'No such material %', p_material_id
      using errcode = 'no_data_found';
  end if;

  -- The gate. A product nobody has checked cannot be SELECTED, though it
  -- may sit on the sheet unselected as a note to self.
  if p_selected and v_mat.spec_state <> 'reviewed'
     and v_mat.category in ('kit', 'heating_cable') then
    raise exception
      'The specification for % is %, so it cannot be selected for a job. '
      'Check it against the product listing first.', v_mat.name, v_mat.spec_state
      using errcode = 'check_violation';
  end if;
  if p_selected and v_mat.category = 'kit'
     and not exists (select 1 from public.ns_kit_sheets
                      where material_id = p_material_id and review_state = 'reviewed') then
    raise exception
      '% has no reviewed component sheet, so what it supplies is unknown.',
      v_mat.name
      using errcode = 'check_violation';
  end if;

  insert into public.ns_job_material_sheet_lines
    (sheet_id, material_id, quantity, selected, source, service_id, note)
  values
    (p_sheet_id, p_material_id, p_quantity, p_selected, p_source, p_service_id, p_note)
  on conflict (sheet_id, material_id) do update
     set quantity = excluded.quantity,
         selected = excluded.selected,
         source   = excluded.source,
         note     = coalesce(excluded.note, public.ns_job_material_sheet_lines.note)
  returning id into v_line;

  update public.ns_job_material_sheets set updated_at = now() where id = p_sheet_id;
  return public.ns_job_sheet_result(p_sheet_id, false);
end
$$;

create or replace function public.review_job_material_sheet(
  p_client_operation_id text,
  p_sheet_id            uuid,
  p_note                text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sheet public.ns_job_material_sheets%rowtype;
  v_bad   integer;
begin
  if not public.is_owner() then
    raise exception 'Only the owner reviews a job material sheet'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_sheet from public.ns_job_material_sheets
   where id = p_sheet_id for update;
  if not found then
    raise exception 'No such material sheet %', p_sheet_id
      using errcode = 'no_data_found';
  end if;
  if v_sheet.status in ('reviewed', 'reserved') then
    return public.ns_job_sheet_result(p_sheet_id, true);
  end if;
  if v_sheet.status <> 'draft' then
    raise exception 'Sheet % is %', p_sheet_id, v_sheet.status
      using errcode = 'check_violation';
  end if;

  if not exists (select 1 from public.ns_job_material_sheet_lines
                  where sheet_id = p_sheet_id and selected) then
    raise exception
      'Nothing on sheet % is selected, so reviewing it would commit to '
      'nothing.', p_sheet_id
      using errcode = 'check_violation';
  end if;

  select count(*) into v_bad
    from public.ns_job_material_sheet_lines l
    join public.ns_materials m on m.id = l.material_id
   where l.sheet_id = p_sheet_id and l.selected
     and m.category in ('kit', 'heating_cable')
     and m.spec_state <> 'reviewed';
  if v_bad > 0 then
    raise exception
      '% selected line(s) name a product whose specification has not been '
      'checked. Reviewing the sheet would put a guess into a plan.', v_bad
      using errcode = 'check_violation';
  end if;

  update public.ns_job_material_sheets
     set status = 'reviewed', reviewed_at = now(), reviewed_by = auth.uid(),
         note = coalesce(p_note, note), updated_at = now()
   where id = p_sheet_id;

  return public.ns_job_sheet_result(p_sheet_id, false);
end
$$;

/** Reserve the SELECTED lines, and only those.
 *
 *  This is the acceptance criterion "accepted work reserves only selected
 *  materials, not every draft quote option", made mechanical: the loop
 *  reads `where selected`, so an unchosen option cannot reach the shelf
 *  even if it is sitting on the same sheet. */
create or replace function public.reserve_job_material_sheet(
  p_client_operation_id text,
  p_sheet_id            uuid,
  p_location_code       text default 'base',
  p_note                text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sheet public.ns_job_material_sheets%rowtype;
  v_line  record;
  v_res   jsonb;
  v_n     integer := 0;
begin
  if not public.is_owner() then
    raise exception 'Only the owner commits stock to a job'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_sheet from public.ns_job_material_sheets
   where id = p_sheet_id for update;
  if not found then
    raise exception 'No such material sheet %', p_sheet_id
      using errcode = 'no_data_found';
  end if;
  if v_sheet.status = 'reserved' then
    return public.ns_job_sheet_result(p_sheet_id, true);
  end if;
  if v_sheet.status <> 'reviewed' then
    raise exception
      'Sheet % is %, not reviewed. Stock is committed to work somebody has '
      'checked, not to a draft.', p_sheet_id, v_sheet.status
      using errcode = 'check_violation';
  end if;

  for v_line in
    select l.* from public.ns_job_material_sheet_lines l
      join public.ns_materials m on m.id = l.material_id
     where l.sheet_id = p_sheet_id
       and l.selected
       and l.reservation_id is null
       and m.tracking_mode <> 'level'   -- a level supply has no quantity
  loop
    -- One suffixed key per line, so a retry of this call replays each
    -- reservation rather than creating a second set.
    v_res := public.reserve_stock(
      p_client_operation_id || ':' || v_line.id::text,
      v_line.material_id,
      p_location_code,
      v_line.quantity,
      v_sheet.job_id,
      coalesce(p_note, 'Job material sheet'));
    update public.ns_job_material_sheet_lines
       set reservation_id = (v_res ->> 'reservation_id')::uuid
     where id = v_line.id;
    v_n := v_n + 1;
  end loop;

  if v_n = 0 and not exists (
       select 1 from public.ns_job_material_sheet_lines
        where sheet_id = p_sheet_id and selected and reservation_id is not null) then
    raise exception
      'Sheet % has no selected line that can hold a reservation.', p_sheet_id
      using errcode = 'check_violation';
  end if;

  update public.ns_job_material_sheets
     set status = 'reserved', reserved_at = now(), updated_at = now()
   where id = p_sheet_id;

  return public.ns_job_sheet_result(p_sheet_id, false);
end
$$;

create or replace function public.ns_job_sheet_result(
  p_sheet_id uuid, p_replayed boolean)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'sheet_id',    s.id,
    'job_id',      s.job_id,
    'status',      s.status,
    'reviewed_at', s.reviewed_at,
    'reserved_at', s.reserved_at,
    'replayed',    p_replayed,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'line_id',        l.id,
               'material_id',    l.material_id,
               'material_name',  m.name,
               'category',       m.category,
               'unit',           m.unit,
               'quantity',       l.quantity,
               'selected',       l.selected,
               'source',         l.source,
               'spec_state',     m.spec_state,
               'offcut_id',      l.offcut_id,
               'reservation_id', l.reservation_id)
             order by m.name)
        from public.ns_job_material_sheet_lines l
        join public.ns_materials m on m.id = l.material_id
       where l.sheet_id = s.id), '[]'::jsonb))
  from public.ns_job_material_sheets s
  where s.id = p_sheet_id
$$;

/* ===================================================================== */
/* grants                                                                */
/* ===================================================================== */

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.open_sealed_kit(text,uuid,text,numeric,text)',
    'public.record_offcut(text,uuid,text,numeric,uuid,text)',
    'public.consume_offcut(text,uuid,uuid,text)',
    'public.scrap_offcut(text,uuid,text)',
    'public.ns_offcut_result(uuid,boolean)',
    'public.ns_heating_kit_candidates(uuid)',
    'public.select_job_material(text,uuid,uuid,numeric,boolean,text,uuid,text)',
    'public.review_job_material_sheet(text,uuid,text)',
    'public.reserve_job_material_sheet(text,uuid,text,text)',
    'public.ns_job_sheet_result(uuid,boolean)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('grant execute on function %s to authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.open_sealed_kit(text,uuid,text,numeric,text)',
    'public.record_offcut(text,uuid,text,numeric,uuid,text)',
    'public.consume_offcut(text,uuid,uuid,text)',
    'public.scrap_offcut(text,uuid,text)',
    'public.select_job_material(text,uuid,uuid,numeric,boolean,text,uuid,text)',
    'public.reserve_job_material_sheet(text,uuid,text,text)'
  ] loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception
        'anon still holds EXECUTE on % after an explicit revoke from both anon '
        'and PUBLIC, so it is INHERITED from a role anon is a member of. '
        'Inspect pg_auth_members for anon and revoke there.', f
        using errcode = 'insufficient_privilege';
    end if;
  end loop;

  if has_table_privilege('authenticated', 'public.ns_material_offcuts', 'INSERT') then
    raise exception
      'authenticated can still INSERT offcuts directly, which bypasses the '
      'within-stock invariant and the replay key.'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;
