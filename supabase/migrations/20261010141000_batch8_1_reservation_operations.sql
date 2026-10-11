-- Batch 8.1 corrective: the reservation half of the operations contract.
--
-- Three entry points, all idempotent on a caller-supplied
-- client_operation_id, all SECURITY DEFINER with an explicit access guard
-- for the same reason the movement RPCs are: these writes are correct only
-- if the caller cannot make the underlying inserts by hand.
--
--   reserve_stock           commit available stock to a job
--   release_stock_reservation  drop the claim, stock becomes available again
--   consume_stock_reservation  turn the claim into a real movement
--
-- The third one is the whole reason the other two are safe. Reserve,
-- issue and consume are the classic place to count the same stock three
-- times; here consuming closes the reservation and posts the movement in
-- ONE transaction, so there is no window in which both exist.
--
-- NOT APPLIED.

/* ===================================================================== */
/* reserve_stock                                                         */
/* ===================================================================== */

create or replace function public.reserve_stock(
  p_client_operation_id text,
  p_material_id         uuid,
  p_location_code       text,
  p_quantity            numeric,
  p_job_id              uuid default null,
  p_note                text default null,
  p_expires_at          timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.ns_stock_reservations%rowtype;
  v_location uuid;
  v_vehicle  uuid;
  v_mode     text;
  v_id       uuid;
begin
  if not public.is_admin() then
    raise exception 'reserve_stock is admin-only'
      using errcode = 'insufficient_privilege';
  end if;

  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_existing from public.ns_stock_reservations
   where client_operation_id = p_client_operation_id;
  if found then
    return public.ns_reservation_result(v_existing.id, true);
  end if;

  v_location := public.ns_location_by_code(p_location_code);
  if v_location is null then
    raise exception 'No active stock location with code %', p_location_code
      using errcode = 'no_data_found';
  end if;

  -- Crew scoping. A crew committing stock in the other car is exactly the
  -- "stock belonging to another vehicle" case the field contract asks to be
  -- impossible, and it is cheaper to refuse here than to explain later.
  if not public.can_see_location(v_location) then
    raise exception 'You are not assigned to that location'
      using errcode = 'insufficient_privilege';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'A reservation quantity must be greater than zero'
      using errcode = 'invalid_parameter_value';
  end if;

  select tracking_mode into v_mode from public.ns_materials where id = p_material_id;
  if v_mode is null then
    raise exception 'No such material %', p_material_id
      using errcode = 'no_data_found';
  end if;
  if v_mode = 'level' then
    raise exception
      'That supply is tracked as Empty/Low/Enough, so there is no quantity to reserve.'
      using errcode = 'invalid_parameter_value';
  end if;

  v_vehicle := public.current_crew_vehicle();

  insert into public.ns_stock_reservations
    (material_id, location_id, quantity, job_id, vehicle_location_id,
     client_operation_id, actor_id, note, expires_at)
  values
    (p_material_id, v_location, p_quantity, p_job_id, v_vehicle,
     p_client_operation_id, auth.uid(), p_note, p_expires_at)
  returning id into v_id;

  -- The over-commit guard is deferred, so it fires at COMMIT. A caller
  -- inside a larger transaction gets the refusal then; a plain RPC call
  -- gets it now, because the statement is its own transaction.
  return public.ns_reservation_result(v_id, false);
end
$$;

/* ===================================================================== */
/* release_stock_reservation                                             */
/* ===================================================================== */

create or replace function public.release_stock_reservation(
  p_client_operation_id text,
  p_reservation_id      uuid,
  p_note                text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_res public.ns_stock_reservations%rowtype;
begin
  if not public.is_admin() then
    raise exception 'release_stock_reservation is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_res from public.ns_stock_reservations where id = p_reservation_id;
  if not found then
    raise exception 'No such reservation %', p_reservation_id
      using errcode = 'no_data_found';
  end if;
  if not public.can_see_location(v_res.location_id) then
    raise exception 'You are not assigned to that location'
      using errcode = 'insufficient_privilege';
  end if;

  -- Releasing an already-released reservation is the SAME outcome, not an
  -- error: a retried release must not fail just because the first attempt
  -- landed. A reservation that was CONSUMED is different -- the stock is
  -- gone, and reporting a release would be a lie.
  if v_res.status = 'released' then
    return public.ns_reservation_result(v_res.id, true);
  end if;
  if v_res.status <> 'held' then
    raise exception 'Reservation % is already %, so it cannot be released',
      v_res.id, v_res.status
      using errcode = 'check_violation';
  end if;

  update public.ns_stock_reservations
     set status = 'released',
         closed_at = now(),
         note = coalesce(p_note, note)
   where id = p_reservation_id;

  return public.ns_reservation_result(p_reservation_id, false);
end
$$;

/* ===================================================================== */
/* consume_stock_reservation                                             */
/* ===================================================================== */

create or replace function public.consume_stock_reservation(
  p_client_operation_id text,
  p_reservation_id      uuid,
  p_quantity            numeric default null,   -- null = all of it
  p_count_precision     text    default 'exact',
  p_note                text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_res   public.ns_stock_reservations%rowtype;
  v_use   numeric;
  v_op    uuid;
  v_exist public.ns_stock_operations%rowtype;
begin
  if not public.is_admin() then
    raise exception 'consume_stock_reservation is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_exist from public.ns_stock_operations
   where client_operation_id = p_client_operation_id;
  if found then
    return public.ns_operation_result(v_exist.id, true);
  end if;

  select * into v_res from public.ns_stock_reservations where id = p_reservation_id;
  if not found then
    raise exception 'No such reservation %', p_reservation_id
      using errcode = 'no_data_found';
  end if;
  if not public.can_see_location(v_res.location_id) then
    raise exception 'You are not assigned to that location'
      using errcode = 'insufficient_privilege';
  end if;
  if v_res.status <> 'held' then
    raise exception 'Reservation % is already %', v_res.id, v_res.status
      using errcode = 'check_violation';
  end if;

  v_use := coalesce(p_quantity, v_res.quantity);
  if v_use <= 0 or v_use > v_res.quantity then
    raise exception 'Consume between 0 and the reserved % , not %',
      v_res.quantity, v_use
      using errcode = 'invalid_parameter_value';
  end if;

  if p_count_precision not in ('exact', 'estimated') then
    raise exception 'count_precision must be exact or estimated'
      using errcode = 'invalid_parameter_value';
  end if;

  insert into public.ns_stock_operations
    (client_operation_id, kind, actor_id, vehicle_location_id,
     confirmed_physical, job_id, note)
  values
    (p_client_operation_id, 'consumption', auth.uid(), v_res.vehicle_location_id,
     true, v_res.job_id, p_note)
  returning id into v_op;

  -- Close the claim and post the movement together. Between these two
  -- statements the stock would be both reserved and issued; there is no
  -- such moment outside this transaction.
  update public.ns_stock_reservations
     set status = 'consumed',
         closed_at = now(),
         closed_by_operation = v_op,
         -- A partial consumption leaves the remainder UNRESERVED rather
         -- than silently still committed: what was not used went back on
         -- the shelf, and a plan that still counts it as promised would
         -- hide real availability.
         quantity = v_use
   where id = p_reservation_id;

  insert into public.ns_material_stock_moves
    (material_id, location_id, operation_id, delta, reason,
     job_id, note, created_by, condition, count_precision)
  values
    (v_res.material_id, v_res.location_id, v_op, -v_use, 'consumed',
     v_res.job_id, p_note, auth.uid(), 'usable', p_count_precision);

  return public.ns_operation_result(v_op, false);
end
$$;

/* ===================================================================== */
/* result shape                                                          */
/* ===================================================================== */

create or replace function public.ns_reservation_result(
  p_reservation_id uuid, p_replayed boolean)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'reservation_id',      r.id,
    'client_operation_id', r.client_operation_id,
    'status',              r.status,
    'material_id',         r.material_id,
    'location_id',         r.location_id,
    'location_code',       l.code,
    'quantity',            r.quantity,
    'job_id',              r.job_id,
    'vehicle_location_id', r.vehicle_location_id,
    'actor_id',            r.actor_id,
    'held_at',             r.held_at,
    'expires_at',          r.expires_at,
    'closed_at',           r.closed_at,
    'replayed',            p_replayed,
    'balance', (
      select jsonb_build_object(
               'on_hand',   b.on_hand,
               'reserved',  b.reserved,
               'available', b.available)
        from public.ns_material_stock_by_location b
       where b.material_id = r.material_id and b.location_id = r.location_id)
  )
  from public.ns_stock_reservations r
  join public.ns_stock_locations l on l.id = r.location_id
  where r.id = p_reservation_id
$$;

/* ===================================================================== */
/* grants                                                                */
/* ===================================================================== */

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.reserve_stock(text,uuid,text,numeric,uuid,text,timestamptz)',
    'public.release_stock_reservation(text,uuid,text)',
    'public.consume_stock_reservation(text,uuid,numeric,text,text)',
    'public.ns_reservation_result(uuid,boolean)',
    'public.is_owner()',
    'public.current_crew_vehicle()',
    'public.can_see_location(uuid)'
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
    'public.reserve_stock(text,uuid,text,numeric,uuid,text,timestamptz)',
    'public.release_stock_reservation(text,uuid,text)',
    'public.consume_stock_reservation(text,uuid,numeric,text,text)'
  ] loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception
        'anon still holds EXECUTE on % after an explicit revoke from both anon '
        'and PUBLIC, so it is INHERITED from a role anon is a member of. '
        'Inspect pg_auth_members for anon and revoke there.', f
        using errcode = 'insufficient_privilege';
    end if;
  end loop;

  if has_table_privilege('authenticated', 'public.ns_stock_reservations', 'INSERT') then
    raise exception
      'authenticated can still INSERT reservations directly, which bypasses '
      'the crew scoping and the replay key.'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

comment on function public.consume_stock_reservation(text,uuid,numeric,text,text) is
  'Closes the reservation and posts the movement in one transaction, so '
  'stock is never counted as both reserved and issued. A partial '
  'consumption releases the remainder rather than leaving it committed.';
