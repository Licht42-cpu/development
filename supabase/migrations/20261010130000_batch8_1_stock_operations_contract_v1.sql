-- Batch 8.1 corrective: operations-contract v1.
--
-- The two entry points every stock change goes through. Nothing writes
-- ns_material_stock_moves directly any more -- not the admin screen, not the
-- field track, not a script -- because every guarantee the contract makes
-- (replay safety, attribution, physical confirmation, conservation) lives
-- in these functions and in the constraints they rely on, not in the
-- callers.
--
-- The frozen request/response shapes, error codes and fixtures are in
-- docs/operations-contract-v1.md. That document is the copy handed to the
-- field track; neither side invents a counterpart.
--
-- WHY SECURITY DEFINER HERE, UNLIKE THE BATCH 4 AND 8.1 READ RPCS
--
-- Those are reads over tables whose RLS already says exactly who may see
-- what, so INVOKER was strictly better: no row could be exposed that the
-- caller could not already select. These are WRITES whose correctness
-- depends on inserts the caller must NOT be able to make by hand -- a
-- movement without an operation, a transfer with one leg, a confirmed_
-- physical an operator never confirmed. DEFINER plus an explicit is_admin()
-- guard is how the ledger becomes reachable only through these doors.
-- Direct INSERT on the ledger is revoked below to make that real rather
-- than conventional.
--
-- IDEMPOTENCY, precisely
--
-- client_operation_id is supplied by the CALLER and is unique. A repeat
-- returns the ORIGINAL operation with replayed = true and writes nothing.
-- It is matched on the id alone, deliberately: a retry that differs in its
-- payload is a bug in the caller, and silently applying the second version
-- would be worse than refusing it, so a mismatch raises rather than
-- quietly winning.

/* ===================================================================== */
/* helpers                                                               */
/* ===================================================================== */

create or replace function public.ns_location_by_code(p_code text)
returns uuid
language sql
stable
set search_path = public, pg_temp
as $$
  select id from public.ns_stock_locations
   where lower(btrim(code)) = lower(btrim(p_code)) and active
$$;

/** The operation as the contract reports it, plus the balances it touched,
 *  so a caller never has to re-read to find out what it just did. */
create or replace function public.ns_operation_result(p_operation_id uuid, p_replayed boolean)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'operation_id',        o.id,
    'client_operation_id', o.client_operation_id,
    'kind',                o.kind,
    'record_version',      o.record_version,
    'confirmed_physical',  o.confirmed_physical,
    'actor_id',            o.actor_id,
    'vehicle_location_id', o.vehicle_location_id,
    'occurred_at',         o.occurred_at,
    'replayed',            p_replayed,
    'movements', coalesce((
      select jsonb_agg(jsonb_build_object(
               'movement_id',   mv.id,
               'material_id',   mv.material_id,
               'location_id',   mv.location_id,
               'location_code', l.code,
               'delta',         mv.delta,
               'reason',        mv.reason)
             order by mv.delta desc)
        from public.ns_material_stock_moves mv
        join public.ns_stock_locations l on l.id = mv.location_id
       where mv.operation_id = o.id), '[]'::jsonb),
    'balances', coalesce((
      select jsonb_agg(distinct jsonb_build_object(
               'material_id',   b.material_id,
               'location_id',   b.location_id,
               'location_code', b.location_code,
               'on_hand',       b.on_hand))
        from public.ns_material_stock_by_location b
       where (b.material_id, b.location_id) in (
         select mv.material_id, mv.location_id
           from public.ns_material_stock_moves mv
          where mv.operation_id = o.id)), '[]'::jsonb)
  )
  from public.ns_stock_operations o
  where o.id = p_operation_id
$$;

/* ===================================================================== */
/* post_stock_movement -- receipt, consumption, correction, opening      */
/* ===================================================================== */

-- One material, one location, one signed quantity. The sign is derived
-- from the reason exactly as the ledger's own constraint requires, so a
-- caller cannot post a positive consumption by passing a positive number:
-- it passes a magnitude and a reason, and this decides.

create or replace function public.post_stock_movement(
  p_client_operation_id text,
  p_material_id         uuid,
  p_location_code       text,
  p_quantity            numeric,
  p_reason              text,
  p_note                text    default null,
  p_job_id              uuid    default null,
  p_purchase_order_id   uuid    default null,
  p_vehicle_code        text    default null,
  -- Added with items 4-6. Defaulted, so every existing caller keeps working
  -- and the honest values are the defaults: stock is usable and counted
  -- until somebody says otherwise.
  p_condition           text    default 'usable',
  p_count_precision     text    default 'exact'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing   public.ns_stock_operations%rowtype;
  v_location   uuid;
  v_vehicle    uuid;
  v_kind       text;
  v_delta      numeric;
  v_op         uuid;
begin
  if not public.is_admin() then
    raise exception 'post_stock_movement is admin-only'
      using errcode = 'insufficient_privilege';
  end if;

  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Replay: return the original, write nothing.
  select * into v_existing from public.ns_stock_operations
   where client_operation_id = p_client_operation_id;
  if found then
    if v_existing.kind not in ('receipt', 'consumption', 'correction', 'opening') then
      raise exception
        'client_operation_id % was already used for a % operation',
        p_client_operation_id, v_existing.kind
        using errcode = 'unique_violation';
    end if;
    return public.ns_operation_result(v_existing.id, true);
  end if;

  if p_quantity is null or p_quantity = 0 then
    raise exception 'quantity must be a non-zero number'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_condition not in ('usable', 'damaged') then
    raise exception 'condition must be usable or damaged'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_count_precision not in ('exact', 'estimated') then
    raise exception 'count_precision must be exact or estimated'
      using errcode = 'invalid_parameter_value';
  end if;

  v_location := public.ns_location_by_code(p_location_code);
  if v_location is null then
    raise exception 'No active stock location with code %', p_location_code
      using errcode = 'no_data_found';
  end if;

  if p_vehicle_code is not null then
    v_vehicle := public.ns_location_by_code(p_vehicle_code);
    if v_vehicle is null then
      raise exception 'No active stock location with code %', p_vehicle_code
        using errcode = 'no_data_found';
    end if;
  end if;

  -- reason -> operation kind, and reason -> sign. A correction keeps the
  -- caller's sign because a negative correction has to be enterable at all;
  -- everything else is signed by what it means.
  v_kind := case p_reason
              when 'received'   then 'receipt'
              when 'opening'    then 'opening'
              when 'returned'   then 'receipt'
              when 'consumed'   then 'consumption'
              when 'damaged'    then 'consumption'
              when 'adjustment' then 'correction'
              else null end;
  if v_kind is null then
    raise exception 'Unknown movement reason %', p_reason
      using errcode = 'invalid_parameter_value';
  end if;

  v_delta := case p_reason
               when 'consumed'   then -abs(p_quantity)
               when 'damaged'    then -abs(p_quantity)
               when 'adjustment' then p_quantity
               else abs(p_quantity) end;

  insert into public.ns_stock_operations
    (client_operation_id, kind, actor_id, vehicle_location_id,
     confirmed_physical, job_id, purchase_order_id, note)
  values
    (p_client_operation_id, v_kind, auth.uid(), v_vehicle,
     -- A single-location movement is the operator reporting something that
     -- has already happened on the shelf in front of them; there is no
     -- second party to confirm, unlike a transfer.
     true, p_job_id, p_purchase_order_id, p_note)
  returning id into v_op;

  insert into public.ns_material_stock_moves
    (material_id, location_id, operation_id, delta, reason,
     job_id, purchase_order_id, note, created_by, condition, count_precision)
  values
    (p_material_id, v_location, v_op, v_delta, p_reason,
     p_job_id, p_purchase_order_id, p_note, auth.uid(),
     p_condition, p_count_precision);

  return public.ns_operation_result(v_op, false);
end
$$;

/* ===================================================================== */
/* post_stock_transfer -- Base <-> a vehicle, or vehicle <-> vehicle      */
/* ===================================================================== */

create or replace function public.post_stock_transfer(
  p_client_operation_id text,
  p_material_id         uuid,
  p_quantity            numeric,
  p_from_location_code  text,
  p_to_location_code    text,
  p_confirmed_physical  boolean default false,
  p_note                text    default null,
  p_job_id              uuid    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.ns_stock_operations%rowtype;
  v_from     uuid;
  v_to       uuid;
  v_vehicle  uuid;
  v_from_kind text;
  v_to_kind   text;
  v_available numeric;
  v_op       uuid;
begin
  if not public.is_admin() then
    raise exception 'post_stock_transfer is admin-only'
      using errcode = 'insufficient_privilege';
  end if;

  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_existing from public.ns_stock_operations
   where client_operation_id = p_client_operation_id;
  if found then
    if v_existing.kind <> 'transfer' then
      raise exception
        'client_operation_id % was already used for a % operation',
        p_client_operation_id, v_existing.kind
        using errcode = 'unique_violation';
    end if;
    return public.ns_operation_result(v_existing.id, true);
  end if;

  -- "Confirm physical movement before stock moves." Refused rather than
  -- recorded-as-pending: a half-moved balance is the thing a crew cannot
  -- reconcile against a car, and the caller already knows whether the box
  -- went in. A pending/conflict shape exists in the contract for the cases
  -- that genuinely need one; this is not one of them.
  if not coalesce(p_confirmed_physical, false) then
    raise exception
      'A transfer moves stock only once the physical movement is confirmed.'
      using errcode = 'check_violation';
  end if;

  if p_quantity is null or p_quantity <= 0 then
    raise exception 'A transfer quantity must be greater than zero'
      using errcode = 'invalid_parameter_value';
  end if;

  v_from := public.ns_location_by_code(p_from_location_code);
  v_to   := public.ns_location_by_code(p_to_location_code);
  if v_from is null then
    raise exception 'No active stock location with code %', p_from_location_code
      using errcode = 'no_data_found';
  end if;
  if v_to is null then
    raise exception 'No active stock location with code %', p_to_location_code
      using errcode = 'no_data_found';
  end if;
  if v_from = v_to then
    raise exception 'A transfer needs two different locations'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Do not let a location go negative on a transfer. A negative balance is
  -- meaningful for consumption (somebody used stock the app did not know
  -- about, and the ledger should say so) but never for a transfer: you
  -- cannot carry out of a car what is not in it, so this is a miscount to
  -- surface now rather than a fact to record.
  select coalesce(on_hand, 0) into v_available
    from public.ns_material_stock_by_location
   where material_id = p_material_id and location_id = v_from;

  if coalesce(v_available, 0) < p_quantity then
    raise exception
      'Only % available at % -- cannot transfer %. Count it, then post a correction if the shelf disagrees.',
      coalesce(v_available, 0), p_from_location_code, p_quantity
      using errcode = 'check_violation';
  end if;

  select kind into v_from_kind from public.ns_stock_locations where id = v_from;
  select kind into v_to_kind   from public.ns_stock_locations where id = v_to;
  -- Attribute the operation to whichever side is a vehicle; a base-to-base
  -- transfer cannot exist (one base is enforced), and vehicle-to-vehicle
  -- is attributed to the receiving car.
  v_vehicle := case when v_to_kind = 'vehicle' then v_to
                    when v_from_kind = 'vehicle' then v_from
                    else null end;

  insert into public.ns_stock_operations
    (client_operation_id, kind, actor_id, vehicle_location_id,
     confirmed_physical, job_id, note)
  values
    (p_client_operation_id, 'transfer', auth.uid(), v_vehicle,
     true, p_job_id, p_note)
  returning id into v_op;

  -- Two legs, one transaction. The deferred conservation trigger checks
  -- them together at COMMIT; neither insert alone is a valid transfer.
  insert into public.ns_material_stock_moves
    (material_id, location_id, operation_id, delta, reason, job_id, note, created_by)
  values
    (p_material_id, v_from, v_op, -p_quantity, 'transfer', p_job_id, p_note, auth.uid()),
    (p_material_id, v_to,   v_op,  p_quantity, 'transfer', p_job_id, p_note, auth.uid());

  return public.ns_operation_result(v_op, false);
end
$$;

/* ===================================================================== */
/* grants                                                                */
/* ===================================================================== */

-- The ledger is now reachable ONLY through the two functions above. This is
-- the line that makes the contract's guarantees real: with direct INSERT
-- available, any caller could write a movement with no operation, no replay
-- key and no confirmation, and every promise made in
-- docs/operations-contract-v1.md would be advisory.
revoke insert, update, delete on public.ns_material_stock_moves from authenticated;
revoke insert, update, delete on public.ns_stock_operations     from authenticated;

-- Dropped rather than left beside the new one: two overloads would let a
-- caller keep the version that cannot record condition or precision, which
-- is exactly the silent downgrade this batch exists to prevent.
drop function if exists public.post_stock_movement(text,uuid,text,numeric,text,text,uuid,uuid,text);

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.post_stock_movement(text,uuid,text,numeric,text,text,uuid,uuid,text,text,text)',
    'public.post_stock_transfer(text,uuid,numeric,text,text,boolean,text,uuid)',
    'public.ns_location_by_code(text)',
    'public.ns_operation_result(uuid,boolean)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('grant execute on function %s to authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

-- Batch 7.1's finding, applied again: a privilege can be held directly,
-- through PUBLIC, or inherited, and reading the grant list sees only the
-- first two. Stop loudly rather than report a success we have not achieved.
-- Dropped rather than left beside the new one: two overloads would let a
-- caller keep the version that cannot record condition or precision, which
-- is exactly the silent downgrade this batch exists to prevent.
drop function if exists public.post_stock_movement(text,uuid,text,numeric,text,text,uuid,uuid,text);

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.post_stock_movement(text,uuid,text,numeric,text,text,uuid,uuid,text,text,text)',
    'public.post_stock_transfer(text,uuid,numeric,text,text,boolean,text,uuid)'
  ] loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception
        'anon still holds EXECUTE on % after an explicit revoke from both anon '
        'and PUBLIC, so it is INHERITED from a role anon is a member of. '
        'Inspect pg_auth_members for anon and revoke there.', f
        using errcode = 'insufficient_privilege';
    end if;
  end loop;

  if has_table_privilege('authenticated', 'public.ns_material_stock_moves', 'INSERT') then
    raise exception
      'authenticated can still INSERT the stock ledger directly, which '
      'bypasses every guarantee the operations contract makes.'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

comment on function public.post_stock_movement(text,uuid,text,numeric,text,text,uuid,uuid,text,text,text) is
  'Operations contract v1. One material at one location. Idempotent on '
  'client_operation_id. See docs/operations-contract-v1.md.';

comment on function public.post_stock_transfer(text,uuid,numeric,text,text,boolean,text,uuid) is
  'Operations contract v1. Two conserving legs between two locations, '
  'refused until the physical movement is confirmed. Idempotent on '
  'client_operation_id. See docs/operations-contract-v1.md.';
