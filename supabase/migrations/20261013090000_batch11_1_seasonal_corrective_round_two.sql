-- Batch 11.1, part one: the three tails of the abedf0f review that the
-- first corrective (20261012090000) did not close.
--
-- That corrective answered the seven headline findings. Re-reading the
-- review against the corrected SQL, three sub-points inside findings 1, 2
-- and 5 were still open -- each one a DECISION the review asked for rather
-- than a line to patch, which is why they were not swept in with the rest:
--
--   1b  "every admin can read every assignment/event, including operation
--       keys; that broader read scope needs an explicit decision."
--       -> Decided here. The KEY comes off the crew-readable surface; the
--          assignment history deliberately stays readable, with the reason
--          written down.
--
--   2b  "a different material/location also breaks the stated per-material/
--       location basis."
--       -> The first corrective fixed the material half and left the
--          location half. A build now records WHERE it was taken from, and
--          salvage goes back to the same place.
--
--   5b  "A Keep/Add/Return row still needs authoritative per-car aboard
--       status ... The nine seasonal operations provide no general
--       Base-to-car whole-set load operation."
--       -> Added: one keyed, crew-scoped operation that records a set
--          physically moving, and one view that answers "what is aboard
--          which car" without inferring it from a commercial promise.
--
-- APPEND-ONLY. 20261011090000, 20261011091000 and 20261012090000 are not
-- edited; this corrects them forward.
--
-- NOT APPLIED. Written and tested against a disposable PostgreSQL only.
-- Contract: docs/seasonal-sets-contract-v1.md, now v1.2.

/* ===================================================================== */
/* 1b. operation keys are not crew-readable                              */
/* ===================================================================== */

-- THE DECISION, in two parts, because the review bundled two different
-- things under one heading.
--
-- (a) The replay KEY is withdrawn from the table read surface. After the
--     first corrective a crew can no longer USE another operation's key --
--     ns_seasonal_replay_guard checks the target and can_handle_set before
--     it returns anything -- but it could still read the key off
--     ns_rental_set_events and learn what the office did on a set at the
--     other vehicle. A key is a credential-shaped string; nothing on a
--     screen needs it. Column-level revoke rather than a new table, so
--     the log stays one object.
--
-- (b) The assignment HISTORY stays readable to every admin, deliberately.
--     Scoping it per vehicle would break the screens the crew actually
--     uses: "which sets are out at this customer" and the recovery list
--     both read assignments for sets that are at a property and therefore
--     have no location at all. With one crew, and a second possible, the
--     cost of hiding history is a crew that cannot find a set; the benefit
--     is nil, because the rows carry no customer contact details, no money
--     and no credentials. Revisit if there is ever a third vehicle or a
--     subcontractor, which is the condition that changes the answer.
--     A column-level REVOKE against a TABLE-level grant does nothing in
--     PostgreSQL -- it warns that no privileges could be revoked and the
--     table grant still covers every column. So the table grant goes and a
--     column list comes back, which means this list has to be complete:
--     a column added later and not added here is unreadable, which is a
--     loud failure rather than a silent leak. That is the right way round.
revoke select on public.ns_rental_set_events from authenticated;
grant select (
  id, rental_set_id, event, job_id, customer_id, assignment_id,
  occurred_at, note, created_at, created_by
) on public.ns_rental_set_events to authenticated;

comment on column public.ns_rental_set_events.client_operation_id is
  'The replay key. Revoked from authenticated at column level in Batch '
  '11.1: a crew can neither use another operation key (the replay guard '
  'checks target and scope) nor now read one. The owner reads it through '
  'ns_rental_set_operation_key() when auditing a replay.';

-- The owner's audit route, since the column is now unreadable to everyone.
-- SECURITY DEFINER with an is_owner() gate, one row at a time: an audit
-- asks about an event it is already looking at, and a bulk export of keys
-- is exactly what part (a) removed.
create or replace function public.ns_rental_set_operation_key(p_event_id uuid)
returns text
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
declare
  v_key text;
begin
  if not public.is_owner() then
    raise exception
      'Operation keys are owner-only. A crew does not need one: a retry '
      'resends the key the device already holds.'
      using errcode = 'insufficient_privilege';
  end if;
  select client_operation_id into v_key
    from public.ns_rental_set_events where id = p_event_id;
  if not found then
    raise exception 'No such set event %', p_event_id
      using errcode = 'no_data_found';
  end if;
  return v_key;
end
$$;

/* ===================================================================== */
/* 2b. a build remembers where it came from                              */
/* ===================================================================== */

-- Finding 2 asked for material AND location. The first corrective required
-- the strip to name the set's own material and left the location free, so
-- 200 consumed from Car A could come back as 200 received at Base: the
-- total conserves, both locations are wrong, and the per-location
-- expression the contract states is not an invariant.
alter table public.ns_rental_sets
  add column if not exists built_at_location uuid
    references public.ns_stock_locations(id) on delete restrict;

alter table public.ns_rental_sets
  drop constraint if exists ns_rental_sets_build_location_sourced;
alter table public.ns_rental_sets
  add constraint ns_rental_sets_build_location_sourced check (
    (built_quantity is null) = (built_at_location is null));

comment on column public.ns_rental_sets.built_at_location is
  'WHERE the build quantity was taken off. Salvage returns to this same '
  'location, which is what makes the conservation expression hold per '
  '(material, location) rather than only in total.';

/* ===================================================================== */
/* 5b. a set physically moving, as an operation                          */
/* ===================================================================== */

-- The review is right that nothing in 9.1 records a whole set being put in
-- a car. Install sets location_id to null (the set is at a property) and
-- recover brings it back, but between storage and the kerb there was no
-- step -- so "what is aboard Car A tonight" could only be guessed from an
-- assignment, which is a commercial promise and not a location.
--
-- This is ONE operation and ONE view. It is not a load system: it posts no
-- stock, reserves nothing, plans nothing, and the daily-load contract's
-- wire shapes are untouched (see docs/daily-load-contract-v1.md v1.1,
-- additive).
alter table public.ns_rental_set_events
  drop constraint if exists ns_rental_set_events_known;
alter table public.ns_rental_set_events
  add constraint ns_rental_set_events_known check (event in (
    'received', 'assigned', 'unassigned', 'installed', 'removed',
    'stored', 'repaired', 'retired', 'lost', 'inspected',
    'recovered', 'released', 'renewed', 'not_renewed', 'built', 'stripped',
    -- new in 11.1
    'moved'));

create or replace function public.move_seasonal_set(
  p_client_operation_id text,
  p_set_id              uuid,
  p_location_code       text,
  p_note                text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_replay jsonb;
  v_set    public.ns_rental_sets;
  v_dest   uuid;
begin
  if not public.is_admin() then
    raise exception 'move_seasonal_set is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  v_replay := public.ns_seasonal_replay_guard(
    p_client_operation_id, 'moved', p_set_id, null);
  if v_replay is not null then return v_replay; end if;

  select * into v_set from public.ns_rental_sets where id = p_set_id for update;
  if not found then
    raise exception 'No such set %', p_set_id using errcode = 'no_data_found';
  end if;
  if not public.can_handle_set(p_set_id) then
    raise exception 'That set is not at your vehicle or at Base'
      using errcode = 'insufficient_privilege';
  end if;

  v_dest := public.ns_location_by_code(p_location_code);
  if v_dest is null then
    raise exception 'No active stock location with code %', p_location_code
      using errcode = 'no_data_found';
  end if;
  -- The same rule the stock contract uses for a transfer destination: you
  -- cannot put something somewhere you cannot see.
  if not public.can_see_location(v_dest) then
    raise exception 'You are not assigned to that location'
      using errcode = 'insufficient_privilege';
  end if;

  if v_set.status in ('retired', 'lost') then
    raise exception
      'Set % is %, so it is not a thing to load.', v_set.set_code, v_set.status
      using errcode = 'check_violation';
  end if;
  -- A deployed set is up at a property. Moving it is recovery, which has
  -- its own operation and its own condition question; letting this call
  -- quietly relocate it would lose that.
  if v_set.status = 'deployed' then
    raise exception
      'Set % is up at a property. Recover it rather than relocating it, so '
      'what came back is recorded.', v_set.set_code
      using errcode = 'check_violation';
  end if;

  -- Already there: a no-op, reported as one, with no key recorded. Same
  -- semantics the first corrective gave the five state-idempotent calls.
  if v_set.location_id = v_dest then
    return public.ns_seasonal_result(p_set_id, null, true, true);
  end if;

  update public.ns_rental_sets
     set location_id = v_dest,
         updated_at = now()
   where id = p_set_id;

  insert into public.ns_rental_set_events
    (rental_set_id, event, note, created_by, client_operation_id)
  values (p_set_id, 'moved',
          coalesce(p_note, 'Moved to ' || btrim(p_location_code)),
          auth.uid(), p_client_operation_id);

  return public.ns_seasonal_result(p_set_id, null, false);
end
$$;

/* --------------------------------------------- what is aboard, per car -- */

-- "Per-car aboard status", from the set's own location rather than from a
-- promise. aboard_state is a closed vocabulary so a caller never has to
-- infer one, and `unknown` is a real answer: a set with no location that
-- is not deployed is one nobody has placed, which is a thing to go and
-- look for, not a thing to plan around.
drop view if exists public.ns_seasonal_sets_aboard cascade;
create or replace view public.ns_seasonal_sets_aboard as
select s.id                 as set_id,
       s.set_code,
       s.status,
       s.condition,
       s.run_type,
       s.colour,
       s.linear_ft,
       s.location_id,
       l.code               as location_code,
       l.kind               as location_kind,
       case
         when s.status in ('retired', 'lost')      then 'out_of_service'
         when s.status = 'deployed'                then 'at_a_property'
         when s.status = 'in_repair'               then 'at_the_repair_bench'
         when l.kind = 'vehicle'                   then 'aboard_vehicle'
         when l.kind = 'base'                      then 'at_base'
         when s.location_id is not null            then 'at_a_location'
         else 'unknown'
       end                  as aboard_state,
       a.id                 as open_assignment_id,
       a.customer_id        as open_customer_id,
       a.season_year        as open_season_year,
       a.status             as open_assignment_status,
       /* The distinction the review asked for, spelled out in one column:
          a set can be promised and not aboard, aboard and not promised,
          or both. Nothing downstream should read one as the other. */
       (a.id is not null)   as promised_to_a_customer
  from public.ns_rental_sets s
  left join public.ns_stock_locations l on l.id = s.location_id
  left join public.ns_seasonal_assignments a
         on a.set_id = s.id
        and a.status in ('assigned', 'installed', 'removed');

do $$
begin
  execute 'alter view public.ns_seasonal_sets_aboard set (security_invoker = on)';
  execute 'revoke all on public.ns_seasonal_sets_aboard from public';
  execute 'revoke all on public.ns_seasonal_sets_aboard from anon';
  execute 'grant select on public.ns_seasonal_sets_aboard to authenticated';
  execute 'grant select on public.ns_seasonal_sets_aboard to service_role';
end
$$;

/* ===================================================================== */
/* the two functions that change                                         */
/* ===================================================================== */

-- register_seasonal_set: records built_at_location. Otherwise identical to
-- the 20261012090000 version.
create or replace function public.register_seasonal_set(
  p_client_operation_id text,
  p_set_code            text,
  p_run_type            text    default null,
  p_colour              text    default null,
  p_linear_ft           numeric default null,
  p_location_code       text    default null,
  p_material_id         uuid    default null,
  p_build_quantity      numeric default null,
  p_note                text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_replay jsonb;
  v_location uuid;
  v_set      uuid;
  v_build    jsonb;
  v_op       uuid;
  v_code     text;
begin
  if not public.is_owner() then
    raise exception
      'Only the owner registers new sets: a set is company property and its '
      'arrival is an asset record, not field work.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  v_replay := public.ns_seasonal_replay_guard(
    p_client_operation_id, 'received', null, null);
  if v_replay is not null then return v_replay; end if;

  if coalesce(btrim(p_set_code), '') = '' then
    raise exception 'A set needs a code you can read off the bag'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_location_code is null then
    select id into v_location from public.ns_stock_locations
     where kind = 'base' and active;
  else
    v_location := public.ns_location_by_code(p_location_code);
  end if;
  if v_location is null then
    raise exception 'No active stock location with code %',
      coalesce(p_location_code, '(base)')
      using errcode = 'no_data_found';
  end if;
  select code into v_code from public.ns_stock_locations where id = v_location;

  if p_build_quantity is not null then
    if p_material_id is null then
      raise exception
        'Say which material the set was built from, or leave the build '
        'quantity empty for a set that was bought assembled.'
        using errcode = 'invalid_parameter_value';
    end if;
    if p_build_quantity <= 0 then
      raise exception 'A build quantity must be greater than zero'
        using errcode = 'invalid_parameter_value';
    end if;
    v_build := public.post_stock_movement(
      p_client_operation_id || ':build',
      p_material_id,
      v_code,
      p_build_quantity,
      'consumed',
      coalesce(p_note, 'Built into set ' || btrim(p_set_code)));
    v_op := (v_build ->> 'operation_id')::uuid;

    perform public.ns_verify_stock_operation(
      v_op, p_material_id, v_code, -p_build_quantity, 'consumed');
  end if;

  begin
    insert into public.ns_rental_sets
      (set_code, material_id, status, condition, linear_ft, run_type, colour,
       location_id, built_from_operation, built_quantity, built_at_location,
       condition_note)
    values
      (btrim(p_set_code), p_material_id, 'in_storage', 'uninspected',
       p_linear_ft, p_run_type, p_colour, v_location, v_op,
       case when v_op is null then null else p_build_quantity end,
       -- WHERE it came off. Null in lockstep with the quantity, so the
       -- constraint above can state the pairing rather than trust it.
       case when v_op is null then null else v_location end,
       p_note)
    returning id into v_set;
  exception when unique_violation then
    raise exception 'Set code % is already in use', btrim(p_set_code)
      using errcode = 'unique_violation';
  end;

  insert into public.ns_rental_set_events
    (rental_set_id, event, note, created_by, client_operation_id)
  values (v_set, 'received', p_note, auth.uid(), p_client_operation_id);

  if v_op is not null then
    insert into public.ns_rental_set_events
      (rental_set_id, event, note, created_by)
    values (v_set, 'built',
            'Consumed ' || p_build_quantity || ' from stock at ' || v_code,
            auth.uid());
  end if;

  return public.ns_seasonal_result(v_set, null, false);
end
$$;

-- retire_seasonal_set: salvage returns to the location the build came off.
-- Otherwise identical to the 20261012090000 version.
create or replace function public.retire_seasonal_set(
  p_client_operation_id text,
  p_set_id              uuid,
  p_strip_material_id   uuid    default null,
  p_strip_quantity      numeric default null,
  p_location_code       text    default null,
  p_note                text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_replay jsonb;
  v_set   public.ns_rental_sets;
  v_code  text;
  v_strip jsonb;
  v_op    uuid;
begin
  if not public.is_owner() then
    raise exception 'Only the owner retires a set'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  v_replay := public.ns_seasonal_replay_guard(
    p_client_operation_id, 'retired', p_set_id, null);
  if v_replay is not null then return v_replay; end if;

  select * into v_set from public.ns_rental_sets where id = p_set_id for update;
  if not found then
    raise exception 'No such set %', p_set_id using errcode = 'no_data_found';
  end if;

  if v_set.status = 'retired' then
    return public.ns_seasonal_result(p_set_id, null, true, true);
  end if;

  if exists (select 1 from public.ns_seasonal_assignments
              where set_id = p_set_id
                and status in ('assigned', 'installed', 'removed')) then
    raise exception
      'Set % is still promised to a customer. Recover and release it before '
      'retiring it.', v_set.set_code
      using errcode = 'check_violation';
  end if;

  if p_strip_quantity is not null then
    if p_strip_quantity <= 0 then
      raise exception 'A strip quantity must be greater than zero'
        using errcode = 'invalid_parameter_value';
    end if;

    if v_set.built_from_operation is null or v_set.built_quantity is null then
      raise exception
        'Set % was not built from catalogue stock, so there is no debit to '
        'reverse. Salvage from a bought-assembled set is an ordinary receipt '
        'the owner posts deliberately, not a strip.', v_set.set_code
        using errcode = 'check_violation';
    end if;
    if p_strip_material_id is not null
       and p_strip_material_id <> v_set.material_id then
      raise exception
        'Set % was built from a different material. Salvage returns what was '
        'taken out, or it is not a strip.', v_set.set_code
        using errcode = 'invalid_parameter_value';
    end if;
    if p_strip_quantity > v_set.built_quantity then
      raise exception
        'Set % holds %, so % cannot come back out of it.',
        v_set.set_code, v_set.built_quantity, p_strip_quantity
        using errcode = 'check_violation';
    end if;

    /* AND BACK TO WHERE IT CAME FROM. Without this the total conserves
       while both locations are wrong: 200 consumed at Car A returning as
       200 received at Base reads as correct in every total and is wrong on
       both shelves. The default is the build's own location, so the common
       call needs no argument; naming a different one is refused rather
       than silently honoured. */
    if p_location_code is not null then
      if public.ns_location_by_code(p_location_code)
         is distinct from v_set.built_at_location then
        raise exception
          'Set % was built from stock at %. Salvage goes back to the same '
          'place, or the per-location figures stop adding up.',
          v_set.set_code,
          (select code from public.ns_stock_locations
            where id = v_set.built_at_location)
          using errcode = 'invalid_parameter_value';
      end if;
      v_code := p_location_code;
    else
      select code into v_code from public.ns_stock_locations
       where id = v_set.built_at_location;
    end if;
    if v_code is null then
      raise exception
        'Set % records a build with no location, which this version does '
        'not know how to reverse. Post the salvage as an ordinary receipt.',
        v_set.set_code
        using errcode = 'check_violation';
    end if;

    v_strip := public.post_stock_movement(
      p_client_operation_id || ':strip',
      v_set.material_id,
      v_code,
      p_strip_quantity,
      'returned',
      coalesce(p_note, 'Stripped from set ' || v_set.set_code));
    v_op := (v_strip ->> 'operation_id')::uuid;

    perform public.ns_verify_stock_operation(
      v_op, v_set.material_id, v_code, p_strip_quantity, 'returned');
  end if;

  update public.ns_rental_sets
     set status = 'retired',
         retired_at = now(),
         stripped_to_operation = coalesce(v_op, stripped_to_operation),
         stripped_quantity = coalesce(p_strip_quantity, stripped_quantity),
         condition_note = coalesce(p_note, condition_note),
         updated_at = now()
   where id = p_set_id;

  insert into public.ns_rental_set_events
    (rental_set_id, event, note, created_by, client_operation_id)
  values (p_set_id, 'retired', p_note, auth.uid(), p_client_operation_id);

  if v_op is not null then
    insert into public.ns_rental_set_events
      (rental_set_id, event, note, created_by)
    values (p_set_id, 'stripped',
            'Returned ' || p_strip_quantity || ' to stock at ' || v_code,
            auth.uid());
  end if;

  return public.ns_seasonal_result(p_set_id, null, false);
end
$$;

/* ===================================================================== */
/* grants                                                                */
/* ===================================================================== */

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.move_seasonal_set(text,uuid,text,text)',
    'public.ns_rental_set_operation_key(uuid)',
    'public.register_seasonal_set(text,text,text,text,numeric,text,uuid,numeric,text)',
    'public.retire_seasonal_set(text,uuid,uuid,numeric,text,text)'
  ]
  loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('grant execute on function %s to authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

-- The usual assertion: reading the grant list is not the same as asking
-- whether anon can execute.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.move_seasonal_set(text,uuid,text,text)',
    'public.ns_rental_set_operation_key(uuid)'
  ]
  loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception 'anon can execute %, which it must not', f;
    end if;
  end loop;
end
$$;

-- And that the key really is off the crew surface.
do $$
begin
  if has_column_privilege('authenticated', 'public.ns_rental_set_events',
                          'client_operation_id', 'select') then
    raise exception
      'authenticated can still read ns_rental_set_events.client_operation_id';
  end if;
  if not has_column_privilege('authenticated', 'public.ns_rental_set_events',
                              'event', 'select') then
    raise exception
      'the revoke took the whole log with it; the history must stay readable';
  end if;
end
$$;
