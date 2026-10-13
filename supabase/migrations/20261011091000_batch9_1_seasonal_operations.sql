-- Batch 9.1: the seasonal operations contract.
--
-- Nine entry points, one per thing that actually happens to a company-owned
-- Christmas set. All idempotent on a caller-supplied client_operation_id,
-- all SECURITY DEFINER with an explicit access guard, for the same reason
-- the stock RPCs are: these writes are correct only if the caller cannot
-- make the underlying rows by hand.
--
--   register_seasonal_set        a set exists, optionally built from stock
--   assign_seasonal_set          promise it to one customer for one season
--   cancel_seasonal_assignment   undo a promise that was never installed
--   install_seasonal_set         it is physically up at the property
--   recover_seasonal_set         it came down, and here is what came back
--   inspect_seasonal_set         somebody looked at it and decided
--   release_seasonal_set         the season is finished with this set
--   record_set_renewal           renewed / not renewed, and nothing else
--   retire_seasonal_set          out of service, optionally stripped to stock
--
-- WHERE THE REPLAY KEY LIVES
--
-- Reserve/consume could key replay off the row they create. These cannot:
-- install, recover and release UPDATE an assignment that already exists, so
-- there is no new row to carry the key. The key therefore lives on the
-- lifecycle log, which every one of these calls appends to exactly once.
-- That is not a workaround -- it is the same table that answers "how did
-- this set get here", so the audit trail and the replay ledger are one
-- thing and cannot disagree.
--
-- THE ACCOUNTING MODEL, in one paragraph
--
-- A quantity of lights is EITHER generic material in ns_material_stock_moves
-- OR part of a set in ns_rental_sets. Never both, never neither. Only two
-- operations cross that line: building a set consumes material (a negative
-- 'consumed' movement, recorded in built_from_operation) and stripping one
-- returns it (a positive 'returned' movement, recorded in
-- stripped_to_operation). Assigning, installing, recovering, inspecting and
-- releasing a set move NO stock at all, because nothing crosses the line --
-- the asset is still ours, it is just somewhere else. This is why a set out
-- at a customer's house does not reduce the ledger: it was never in it.
--
-- NOT APPLIED. Written and tested against a disposable PostgreSQL only.

/* ===================================================================== */
/* the replay ledger                                                     */
/* ===================================================================== */

alter table public.ns_rental_set_events
  add column if not exists client_operation_id text;

-- Partial, because a call that appends a second event (retiring a set AND
-- stripping it) carries the key on the primary one only; and because every
-- event written before this batch has none.
create unique index if not exists ns_rental_set_events_client_id_key
  on public.ns_rental_set_events (client_operation_id)
  where client_operation_id is not null;

/* ===================================================================== */
/* access                                                                */
/* ===================================================================== */

/** Whether the caller may act on this set. Deliberately the same test as
 *  the rental_sets_scoped_read policy -- an owner acts on anything, a crew
 *  acts on what it can see, and a set with no stock location (out at a
 *  property, or not recorded) is handled by whoever is working. If this
 *  drifted from the policy, a crew could be shown a set it cannot touch, or
 *  worse, touch one it cannot be shown. */
create or replace function public.can_handle_set(p_set_id uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select case
    when not public.is_admin() then false
    when public.is_owner() then true
    else exists (
      select 1 from public.ns_rental_sets s
       where s.id = p_set_id
         and (s.location_id is null or public.can_see_location(s.location_id)))
  end
$$;

/** The owner-set cutoff after which a non-renewed set is expected back,
 *  read from settings and NOT invented here. Null means the owner has not
 *  set one, and the screens say so rather than guessing a date. Nothing in
 *  this contract releases or recovers a set automatically on the strength
 *  of it: it is a date to show a human, who then acts. */
create or replace function public.ns_seasonal_release_cutoff(p_season_year integer)
returns date
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_raw text;
begin
  select value ->> 'seasonal_release_cutoff' into v_raw
    from public.app_settings where key = 'lighting';
  if coalesce(btrim(v_raw), '') = '' or p_season_year is null then
    return null;
  end if;
  -- Stored as MM-DD, because the month and day are the policy and the year
  -- comes from the season. A malformed value is treated as unset rather
  -- than raising: a bad setting must not take the seasonal screens down.
  begin
    return to_date(p_season_year::text || '-' || btrim(v_raw), 'YYYY-MM-DD');
  exception when others then
    return null;
  end;
end
$$;

/* ===================================================================== */
/* result shape                                                          */
/* ===================================================================== */

/** What every seasonal call returns: the set, the assignment if there is
 *  one, and the availability verdict -- so a caller never has to re-read to
 *  find out whether what it just did freed the set. */
create or replace function public.ns_seasonal_result(
  p_set_id uuid, p_assignment_id uuid, p_replayed boolean)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'replayed', p_replayed,
    'set', (
      select jsonb_build_object(
               'set_id',                s.id,
               'set_code',              s.set_code,
               'status',                s.status,
               'condition',             s.condition,
               'run_type',              s.run_type,
               'colour',                s.colour,
               'linear_ft',             s.linear_ft,
               'material_id',           s.material_id,
               'location_id',           s.location_id,
               'location_code',         l.code,
               'inspected_at',          s.inspected_at,
               'retired_at',            s.retired_at,
               'built_from_operation',  s.built_from_operation,
               'stripped_to_operation', s.stripped_to_operation)
        from public.ns_rental_sets s
        left join public.ns_stock_locations l on l.id = s.location_id
       where s.id = p_set_id),
    'assignment', (
      select jsonb_build_object(
               'assignment_id',       a.id,
               'set_id',              a.set_id,
               'customer_id',         a.customer_id,
               'property_id',         a.property_id,
               'job_id',              a.job_id,
               'season_year',         a.season_year,
               'status',              a.status,
               'assigned_at',         a.assigned_at,
               'installed_at',        a.installed_at,
               'removed_at',          a.removed_at,
               'released_at',         a.released_at,
               'recovery_condition',  a.recovery_condition,
               'renewal_state',       a.renewal_state,
               'release_cutoff',      public.ns_seasonal_release_cutoff(a.season_year),
               'client_operation_id', a.client_operation_id)
        from public.ns_seasonal_assignments a
       where a.id = p_assignment_id),
    'availability', (
      select jsonb_build_object(
               'available_for_reuse',   v.available_for_reuse,
               'has_active_assignment', v.has_active_assignment,
               'awaiting_release',      v.awaiting_release,
               'needs_inspection',      v.needs_inspection,
               'needs_repair_or_search', v.needs_repair_or_search,
               'out_of_service',        v.out_of_service,
               'at_the_repair_bench',   v.at_the_repair_bench)
        from public.ns_seasonal_set_availability v
       where v.set_id = p_set_id)
  )
$$;

/** The replay lookup: did this exact call already land, and if so on what.
 *  Returns null when it has not. */
create or replace function public.ns_seasonal_replay(p_client_operation_id text)
returns public.ns_rental_set_events
language sql
stable
set search_path = public, pg_temp
as $$
  select e.* from public.ns_rental_set_events e
   where e.client_operation_id = p_client_operation_id
$$;

/* ===================================================================== */
/* register_seasonal_set                                                 */
/* ===================================================================== */

-- A new set exists. If it was built out of catalogue material, this is also
-- the moment that material stops being generic stock, so the consuming
-- movement is posted here, in the same transaction, and remembered on the
-- set. Building and recording are not two steps a human can do half of.

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
  v_evt      public.ns_rental_set_events;
  v_location uuid;
  v_set      uuid;
  v_build    jsonb;
  v_op       uuid;
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

  v_evt := public.ns_seasonal_replay(p_client_operation_id);
  if v_evt.id is not null then
    if v_evt.event <> 'received' then
      raise exception 'client_operation_id % was already used to record a %',
        p_client_operation_id, v_evt.event
        using errcode = 'unique_violation';
    end if;
    return public.ns_seasonal_result(v_evt.rental_set_id, null, true);
  end if;

  if coalesce(btrim(p_set_code), '') = '' then
    raise exception 'A set needs a code you can read off the bag'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Default home is Base: a set nobody placed is on our shelf, which is
  -- also what makes it visible to a crew under the location rules.
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
    -- THE LINE BEING CROSSED. One suffixed operation id, so the build has
    -- its own ledger entry and a replay of this call cannot post it twice.
    v_build := public.post_stock_movement(
      p_client_operation_id || ':build',
      p_material_id,
      (select code from public.ns_stock_locations where id = v_location),
      p_build_quantity,
      'consumed',
      coalesce(p_note, 'Built into set ' || btrim(p_set_code)));
    v_op := (v_build ->> 'operation_id')::uuid;
  end if;

  begin
    insert into public.ns_rental_sets
      (set_code, material_id, status, condition, linear_ft, run_type, colour,
       location_id, built_from_operation, condition_note)
    values
      (btrim(p_set_code), p_material_id, 'in_storage', 'uninspected',
       p_linear_ft, p_run_type, p_colour, v_location, v_op, p_note)
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
            'Consumed ' || p_build_quantity || ' from stock', auth.uid());
  end if;

  return public.ns_seasonal_result(v_set, null, false);
end
$$;

/* ===================================================================== */
/* assign_seasonal_set                                                   */
/* ===================================================================== */

create or replace function public.assign_seasonal_set(
  p_client_operation_id text,
  p_set_id              uuid,
  p_customer_id         uuid,
  p_season_year         integer,
  p_property_id         uuid default null,
  p_job_id              uuid default null,
  p_note                text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_evt   public.ns_rental_set_events;
  v_set   public.ns_rental_sets;
  v_avail public.ns_seasonal_set_availability;
  v_id    uuid;
begin
  if not public.is_owner() then
    raise exception
      'Only the owner assigns a set to a customer: that is a commercial '
      'promise, not field work.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  v_evt := public.ns_seasonal_replay(p_client_operation_id);
  if v_evt.id is not null then
    if v_evt.event <> 'assigned' then
      raise exception 'client_operation_id % was already used to record a %',
        p_client_operation_id, v_evt.event
        using errcode = 'unique_violation';
    end if;
    return public.ns_seasonal_result(v_evt.rental_set_id, v_evt.assignment_id, true);
  end if;

  if p_season_year is null then
    raise exception
      'Say which season this is for. A season guessed from today''s date is '
      'wrong for half of December.'
      using errcode = 'invalid_parameter_value';
  end if;

  -- FOR UPDATE, so two admins assigning the same set serialise here rather
  -- than racing to the unique index. The index still exists as the backstop;
  -- this exists so the loser gets a sentence instead of a constraint name.
  select * into v_set from public.ns_rental_sets where id = p_set_id for update;
  if not found then
    raise exception 'No such set %', p_set_id using errcode = 'no_data_found';
  end if;

  if not exists (select 1 from public.customers where id = p_customer_id) then
    raise exception 'No such customer %', p_customer_id
      using errcode = 'no_data_found';
  end if;

  -- Availability is read from the view, not re-derived here. One definition,
  -- so the screen that offered the set and the function that refuses it
  -- cannot disagree about what "available" means.
  select * into v_avail from public.ns_seasonal_set_availability
   where set_id = p_set_id;

  if v_avail.awaiting_release then
    raise exception
      'Set % came back from season % but that assignment has not been '
      'released yet. Release it first -- that is what finishes a season and '
      'frees the set.', v_set.set_code, v_avail.active_season_year
      using errcode = 'unique_violation';
  end if;
  if v_avail.has_active_assignment then
    raise exception
      'Set % is already % to another customer for season %. Recover and '
      'release it before promising it to somebody else.',
      v_set.set_code, v_avail.active_assignment_status, v_avail.active_season_year
      using errcode = 'unique_violation';
  end if;
  if v_avail.out_of_service then
    raise exception 'Set % is %, so it cannot be assigned',
      v_set.set_code, v_set.status
      using errcode = 'check_violation';
  end if;
  if v_avail.at_the_repair_bench then
    raise exception 'Set % is at the repair bench', v_set.set_code
      using errcode = 'check_violation';
  end if;
  if v_avail.needs_repair_or_search then
    raise exception 'Set % was last seen %, so it is not ours to promise',
      v_set.set_code, v_set.condition
      using errcode = 'check_violation';
  end if;
  if v_avail.needs_inspection then
    raise exception
      'Set % has not been inspected since it came back. Inspect it before '
      'promising it to anybody.', v_set.set_code
      using errcode = 'check_violation';
  end if;
  if not v_avail.available_for_reuse then
    -- Belt and braces: if the view ever grows a sixth reason, refuse rather
    -- than fall through to an assignment the view would call unavailable.
    raise exception 'Set % is not available for reuse', v_set.set_code
      using errcode = 'check_violation';
  end if;

  begin
    insert into public.ns_seasonal_assignments
      (set_id, customer_id, property_id, job_id, season_year, status,
       client_operation_id, actor_id, vehicle_location_id, note)
    values
      (p_set_id, p_customer_id, p_property_id, p_job_id, p_season_year,
       'assigned', p_client_operation_id, auth.uid(),
       public.current_crew_vehicle(), p_note)
    returning id into v_id;
  exception when unique_violation then
    raise exception
      'Set % was assigned by somebody else a moment ago.', v_set.set_code
      using errcode = 'unique_violation';
  end;

  insert into public.ns_rental_set_events
    (rental_set_id, event, job_id, customer_id, note, created_by,
     client_operation_id, assignment_id)
  values (p_set_id, 'assigned', p_job_id, p_customer_id, p_note, auth.uid(),
          p_client_operation_id, v_id);

  return public.ns_seasonal_result(p_set_id, v_id, false);
end
$$;

/* ===================================================================== */
/* cancel_seasonal_assignment                                            */
/* ===================================================================== */

-- The promise was a mistake, or the customer backed out before the crew
-- went. The assignment is CANCELLED, never deleted: a set that was promised
-- to somebody and then was not is a fact about that season.

create or replace function public.cancel_seasonal_assignment(
  p_client_operation_id text,
  p_assignment_id       uuid,
  p_note                text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_evt public.ns_rental_set_events;
  v_a   public.ns_seasonal_assignments;
begin
  if not public.is_owner() then
    raise exception 'Only the owner cancels an assignment'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  v_evt := public.ns_seasonal_replay(p_client_operation_id);
  if v_evt.id is not null then
    if v_evt.event <> 'unassigned' then
      raise exception 'client_operation_id % was already used to record a %',
        p_client_operation_id, v_evt.event
        using errcode = 'unique_violation';
    end if;
    return public.ns_seasonal_result(v_evt.rental_set_id, v_evt.assignment_id, true);
  end if;

  select * into v_a from public.ns_seasonal_assignments
   where id = p_assignment_id for update;
  if not found then
    raise exception 'No such assignment %', p_assignment_id
      using errcode = 'no_data_found';
  end if;

  -- Already cancelled is the same outcome, so a lost response that is
  -- retried under a new key still succeeds instead of confusing the admin.
  if v_a.status = 'cancelled' then
    return public.ns_seasonal_result(v_a.set_id, v_a.id, true);
  end if;
  if v_a.status <> 'assigned' then
    raise exception
      'Assignment % is %, so it is past cancelling. A set that went up comes '
      'back through recovery, not cancellation.', p_assignment_id, v_a.status
      using errcode = 'check_violation';
  end if;

  update public.ns_seasonal_assignments
     set status = 'cancelled',
         note = coalesce(p_note, note),
         updated_at = now()
   where id = p_assignment_id;

  insert into public.ns_rental_set_events
    (rental_set_id, event, customer_id, note, created_by,
     client_operation_id, assignment_id)
  values (v_a.set_id, 'unassigned', v_a.customer_id, p_note, auth.uid(),
          p_client_operation_id, v_a.id);

  return public.ns_seasonal_result(v_a.set_id, v_a.id, false);
end
$$;

/* ===================================================================== */
/* install_seasonal_set                                                  */
/* ===================================================================== */

create or replace function public.install_seasonal_set(
  p_client_operation_id text,
  p_assignment_id       uuid,
  p_installed_at        timestamptz default null,
  p_job_id              uuid        default null,
  p_note                text        default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_evt public.ns_rental_set_events;
  v_a   public.ns_seasonal_assignments;
begin
  if not public.is_admin() then
    raise exception 'install_seasonal_set is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  v_evt := public.ns_seasonal_replay(p_client_operation_id);
  if v_evt.id is not null then
    if v_evt.event <> 'installed' then
      raise exception 'client_operation_id % was already used to record a %',
        p_client_operation_id, v_evt.event
        using errcode = 'unique_violation';
    end if;
    return public.ns_seasonal_result(v_evt.rental_set_id, v_evt.assignment_id, true);
  end if;

  select * into v_a from public.ns_seasonal_assignments
   where id = p_assignment_id for update;
  if not found then
    raise exception 'No such assignment %', p_assignment_id
      using errcode = 'no_data_found';
  end if;
  if not public.can_handle_set(v_a.set_id) then
    raise exception 'That set is not at a location you work from'
      using errcode = 'insufficient_privilege';
  end if;

  if v_a.status = 'installed' then
    return public.ns_seasonal_result(v_a.set_id, v_a.id, true);
  end if;
  if v_a.status <> 'assigned' then
    raise exception 'Assignment % is %, so it cannot be installed',
      p_assignment_id, v_a.status
      using errcode = 'check_violation';
  end if;

  update public.ns_seasonal_assignments
     set status = 'installed',
         installed_at = coalesce(p_installed_at, now()),
         job_id = coalesce(p_job_id, job_id),
         note = coalesce(p_note, note),
         updated_at = now()
   where id = p_assignment_id;

  -- The set is now at a property, which is not one of our stock locations,
  -- so location_id goes null. It is NOT left pointing at the car it rode in:
  -- a set listed as being in the car is a set somebody will look for there.
  update public.ns_rental_sets
     set status = 'deployed',
         location_id = null,
         updated_at = now()
   where id = v_a.set_id;

  insert into public.ns_rental_set_events
    (rental_set_id, event, job_id, customer_id, occurred_at, note, created_by,
     client_operation_id, assignment_id)
  values (v_a.set_id, 'installed', coalesce(p_job_id, v_a.job_id),
          v_a.customer_id, coalesce(p_installed_at, now()), p_note, auth.uid(),
          p_client_operation_id, v_a.id);

  return public.ns_seasonal_result(v_a.set_id, v_a.id, false);
end
$$;

/* ===================================================================== */
/* recover_seasonal_set                                                  */
/* ===================================================================== */

-- Taking it down. The crew reports WHAT CAME BACK, which is not the same
-- claim as "this set is fine": recovery_condition is the crew's eyes at the
-- kerb, and the set's own condition goes to 'uninspected' -- including for a
-- set that was inspected last year, because last year's inspection says
-- nothing about this year's return. Only inspect_seasonal_set declares a
-- set usable, which is what makes "inspection before release" real rather
-- than a convention.
--
-- PARTIAL RECOVERY is per set, by design. Three sets at one property are
-- three assignments; recovering two leaves the third 'installed', its set
-- 'deployed', and neither of them available to anybody. There is no
-- all-or-nothing recovery to go half-finished.

create or replace function public.recover_seasonal_set(
  p_client_operation_id text,
  p_assignment_id       uuid,
  p_recovery_condition  text,
  p_location_code       text        default null,
  p_removed_at          timestamptz default null,
  p_note                text        default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_evt    public.ns_rental_set_events;
  v_a      public.ns_seasonal_assignments;
  v_dest   uuid;
  v_status text;
begin
  if not public.is_admin() then
    raise exception 'recover_seasonal_set is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  v_evt := public.ns_seasonal_replay(p_client_operation_id);
  if v_evt.id is not null then
    if v_evt.event <> 'recovered' then
      raise exception 'client_operation_id % was already used to record a %',
        p_client_operation_id, v_evt.event
        using errcode = 'unique_violation';
    end if;
    return public.ns_seasonal_result(v_evt.rental_set_id, v_evt.assignment_id, true);
  end if;

  if p_recovery_condition is null or p_recovery_condition not in
       ('usable', 'damaged', 'missing', 'uninspected') then
    raise exception
      'Say what came back: usable, damaged, missing, or uninspected if it '
      'went straight into a bag.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_a from public.ns_seasonal_assignments
   where id = p_assignment_id for update;
  if not found then
    raise exception 'No such assignment %', p_assignment_id
      using errcode = 'no_data_found';
  end if;
  if not public.can_handle_set(v_a.set_id) then
    raise exception 'That set is not one you work with'
      using errcode = 'insufficient_privilege';
  end if;

  if v_a.status in ('removed', 'released') then
    return public.ns_seasonal_result(v_a.set_id, v_a.id, true);
  end if;
  if v_a.status <> 'installed' then
    raise exception
      'Assignment % is %, so there is nothing up at the property to recover',
      p_assignment_id, v_a.status
      using errcode = 'check_violation';
  end if;

  -- Where it physically went. A crew's default is its own car, an owner's
  -- is Base, and an explicit code wins over both.
  if p_location_code is not null then
    v_dest := public.ns_location_by_code(p_location_code);
    if v_dest is null then
      raise exception 'No active stock location with code %', p_location_code
        using errcode = 'no_data_found';
    end if;
    if not public.can_see_location(v_dest) then
      raise exception 'You are not assigned to that location'
        using errcode = 'insufficient_privilege';
    end if;
  else
    v_dest := public.current_crew_vehicle();
    if v_dest is null then
      select id into v_dest from public.ns_stock_locations
       where kind = 'base' and active;
    end if;
  end if;

  -- Status follows what came back. 'missing' is the honest one: nothing came
  -- back, so the set is lost and has no location at all. It is NOT deleted,
  -- and it is NOT quietly marked returned.
  v_status := case p_recovery_condition
                when 'missing' then 'lost'
                when 'damaged' then 'in_repair'
                else 'in_storage' end;

  update public.ns_seasonal_assignments
     set status = 'removed',
         removed_at = coalesce(p_removed_at, now()),
         recovery_condition = p_recovery_condition,
         vehicle_location_id = coalesce(public.current_crew_vehicle(), vehicle_location_id),
         note = coalesce(p_note, note),
         updated_at = now()
   where id = p_assignment_id;

  -- 'missing' is the one recovery that IS a verdict, and the exception is
  -- deliberate: every other condition is a guess about a thing in a bag that
  -- a bench inspection can overturn, whereas "nothing came back" is a fact
  -- the crew established by looking at an empty roof. Forcing a second
  -- inspection call to confirm an absence would be ceremony, and it would
  -- leave the assignment unreleasable in the meantime.
  update public.ns_rental_sets
     set status = v_status,
         location_id = case when p_recovery_condition = 'missing'
                            then null else v_dest end,
         condition = case when p_recovery_condition = 'missing'
                          then 'missing' else 'uninspected' end,
         inspected_at = case when p_recovery_condition = 'missing'
                             then now() else null end,
         inspected_by = case when p_recovery_condition = 'missing'
                             then auth.uid() else null end,
         condition_note = coalesce(p_note, condition_note),
         updated_at = now()
   where id = v_a.set_id;

  insert into public.ns_rental_set_events
    (rental_set_id, event, job_id, customer_id, occurred_at, note, created_by,
     client_operation_id, assignment_id)
  values (v_a.set_id, 'recovered', v_a.job_id, v_a.customer_id,
          coalesce(p_removed_at, now()),
          'Came back ' || p_recovery_condition ||
            coalesce('. ' || p_note, ''),
          auth.uid(), p_client_operation_id, v_a.id);

  return public.ns_seasonal_result(v_a.set_id, v_a.id, false);
end
$$;

/* ===================================================================== */
/* inspect_seasonal_set                                                  */
/* ===================================================================== */

-- The only call that can declare a set usable. Re-inspection is legitimate
-- (a repaired set gets looked at again), so there is no state-based
-- idempotency here beyond the operation key: a second inspection under a
-- new key is a second inspection, and the log keeps both.

create or replace function public.inspect_seasonal_set(
  p_client_operation_id text,
  p_set_id              uuid,
  p_condition           text,
  p_note                text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_evt    public.ns_rental_set_events;
  v_set    public.ns_rental_sets;
  v_status text;
begin
  if not public.is_admin() then
    raise exception 'inspect_seasonal_set is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  v_evt := public.ns_seasonal_replay(p_client_operation_id);
  if v_evt.id is not null then
    if v_evt.event <> 'inspected' then
      raise exception 'client_operation_id % was already used to record a %',
        p_client_operation_id, v_evt.event
        using errcode = 'unique_violation';
    end if;
    return public.ns_seasonal_result(v_evt.rental_set_id, null, true);
  end if;

  -- 'uninspected' is not an inspection outcome. Allowing it would let a
  -- screen "inspect" a set into the state that means nobody has.
  if p_condition is null or p_condition not in ('usable', 'damaged', 'missing') then
    raise exception
      'An inspection ends in usable, damaged or missing. If nobody has '
      'looked yet, do not record an inspection.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_set from public.ns_rental_sets where id = p_set_id for update;
  if not found then
    raise exception 'No such set %', p_set_id using errcode = 'no_data_found';
  end if;
  if not public.can_handle_set(p_set_id) then
    raise exception 'That set is not at a location you work from'
      using errcode = 'insufficient_privilege';
  end if;

  if v_set.status = 'deployed' then
    raise exception
      'Set % is up at a property. Recover it before inspecting it.',
      v_set.set_code
      using errcode = 'check_violation';
  end if;
  if v_set.status = 'retired' then
    raise exception 'Set % is retired', v_set.set_code
      using errcode = 'check_violation';
  end if;

  -- The verdict decides where the set belongs, so the two cannot drift:
  -- usable means back on the shelf, damaged means the bench, missing means
  -- lost until somebody finds it.
  v_status := case p_condition
                when 'usable'  then 'in_storage'
                when 'damaged' then 'in_repair'
                when 'missing' then 'lost' end;

  update public.ns_rental_sets
     set condition = p_condition,
         inspected_at = now(),
         inspected_by = auth.uid(),
         status = v_status,
         condition_note = coalesce(p_note, condition_note),
         updated_at = now()
   where id = p_set_id;

  insert into public.ns_rental_set_events
    (rental_set_id, event, note, created_by, client_operation_id)
  values (p_set_id, 'inspected',
          'Inspected ' || p_condition || coalesce('. ' || p_note, ''),
          auth.uid(), p_client_operation_id);

  return public.ns_seasonal_result(p_set_id, null, false);
end
$$;

/* ===================================================================== */
/* release_seasonal_set                                                  */
/* ===================================================================== */

-- The season is finished with this set. Two things this deliberately is NOT:
--
--   It is not a return. The set came back at recovery; releasing only ends
--   the assignment. A set still 'installed' cannot be released at all, which
--   is the "never while still deployed" rule stated once, in the only place
--   that could break it.
--
--   It is not a deletion. The assignment stays, with its customer, season,
--   dates and recovery condition intact, which is what makes a three-season
--   history readable. Release CANNOT duplicate stock either, because it
--   moves no stock: it flips one status on one row.
--
-- Releasing requires an inspection, not a clean bill of health. A damaged
-- set must still be releasable or the assignment stays open forever while
-- the set sits on the bench -- and availability is computed from the set's
-- own condition, so releasing a damaged set does not offer it to anybody.

create or replace function public.release_seasonal_set(
  p_client_operation_id text,
  p_assignment_id       uuid,
  p_note                text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_evt public.ns_rental_set_events;
  v_a   public.ns_seasonal_assignments;
  v_set public.ns_rental_sets;
begin
  if not public.is_owner() then
    raise exception
      'Only the owner releases a set for reuse: that decides what can be '
      'promised to the next customer.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  v_evt := public.ns_seasonal_replay(p_client_operation_id);
  if v_evt.id is not null then
    if v_evt.event <> 'released' then
      raise exception 'client_operation_id % was already used to record a %',
        p_client_operation_id, v_evt.event
        using errcode = 'unique_violation';
    end if;
    return public.ns_seasonal_result(v_evt.rental_set_id, v_evt.assignment_id, true);
  end if;

  select * into v_a from public.ns_seasonal_assignments
   where id = p_assignment_id for update;
  if not found then
    raise exception 'No such assignment %', p_assignment_id
      using errcode = 'no_data_found';
  end if;

  if v_a.status = 'released' then
    return public.ns_seasonal_result(v_a.set_id, v_a.id, true);
  end if;
  if v_a.status = 'installed' then
    raise exception
      'Set is still up at the property. Recover it before releasing the '
      'assignment -- releasing does not bring anything back.'
      using errcode = 'check_violation';
  end if;
  if v_a.status <> 'removed' then
    raise exception 'Assignment % is %, so there is nothing to release',
      p_assignment_id, v_a.status
      using errcode = 'check_violation';
  end if;

  select * into v_set from public.ns_rental_sets where id = v_a.set_id;
  if v_set.condition = 'uninspected' then
    raise exception
      'Set % has not been inspected since it came back. Inspect it first: '
      'releasing it is what makes it offerable to the next customer.',
      v_set.set_code
      using errcode = 'check_violation';
  end if;

  update public.ns_seasonal_assignments
     set status = 'released',
         released_at = now(),
         note = coalesce(p_note, note),
         updated_at = now()
   where id = p_assignment_id;

  insert into public.ns_rental_set_events
    (rental_set_id, event, customer_id, note, created_by,
     client_operation_id, assignment_id)
  values (v_a.set_id, 'released', v_a.customer_id, p_note, auth.uid(),
          p_client_operation_id, v_a.id);

  return public.ns_seasonal_result(v_a.set_id, v_a.id, false);
end
$$;

/* ===================================================================== */
/* record_set_renewal                                                    */
/* ===================================================================== */

-- Whether the customer is keeping it next season. This changes ONE field and
-- touches nothing physical, which is the whole point: non-renewal is a
-- commercial fact, and treating it as a return would claim a set is on our
-- shelf when it is still on their roof.

create or replace function public.record_set_renewal(
  p_client_operation_id text,
  p_assignment_id       uuid,
  p_renewal_state       text,
  p_note                text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_evt public.ns_rental_set_events;
  v_a   public.ns_seasonal_assignments;
begin
  if not public.is_owner() then
    raise exception 'Only the owner records a renewal'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_renewal_state is null or p_renewal_state not in ('renewed', 'not_renewed') then
    raise exception 'renewal_state must be renewed or not_renewed'
      using errcode = 'invalid_parameter_value';
  end if;

  v_evt := public.ns_seasonal_replay(p_client_operation_id);
  if v_evt.id is not null then
    if v_evt.event not in ('renewed', 'not_renewed') then
      raise exception 'client_operation_id % was already used to record a %',
        p_client_operation_id, v_evt.event
        using errcode = 'unique_violation';
    end if;
    return public.ns_seasonal_result(v_evt.rental_set_id, v_evt.assignment_id, true);
  end if;

  select * into v_a from public.ns_seasonal_assignments
   where id = p_assignment_id for update;
  if not found then
    raise exception 'No such assignment %', p_assignment_id
      using errcode = 'no_data_found';
  end if;
  if v_a.status = 'cancelled' then
    raise exception 'Assignment % was cancelled, so there is nothing to renew',
      p_assignment_id
      using errcode = 'check_violation';
  end if;

  update public.ns_seasonal_assignments
     set renewal_state = p_renewal_state,
         note = coalesce(p_note, note),
         updated_at = now()
   where id = p_assignment_id;

  insert into public.ns_rental_set_events
    (rental_set_id, event, customer_id, note, created_by,
     client_operation_id, assignment_id)
  values (v_a.set_id, p_renewal_state, v_a.customer_id, p_note, auth.uid(),
          p_client_operation_id, v_a.id);

  return public.ns_seasonal_result(v_a.set_id, v_a.id, false);
end
$$;

/* ===================================================================== */
/* retire_seasonal_set                                                   */
/* ===================================================================== */

-- Out of service for good. Optionally strips it back to generic stock, which
-- is the other half of the accounting line: the quantity stops being an
-- asset and becomes material again, once, in this transaction, recorded in
-- stripped_to_operation. A retired set is never deleted -- its assignment
-- history is the record of what it did for three customers.

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
  v_evt   public.ns_rental_set_events;
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

  v_evt := public.ns_seasonal_replay(p_client_operation_id);
  if v_evt.id is not null then
    if v_evt.event <> 'retired' then
      raise exception 'client_operation_id % was already used to record a %',
        p_client_operation_id, v_evt.event
        using errcode = 'unique_violation';
    end if;
    return public.ns_seasonal_result(v_evt.rental_set_id, null, true);
  end if;

  select * into v_set from public.ns_rental_sets where id = p_set_id for update;
  if not found then
    raise exception 'No such set %', p_set_id using errcode = 'no_data_found';
  end if;

  if v_set.status = 'retired' then
    return public.ns_seasonal_result(p_set_id, null, true);
  end if;

  if exists (select 1 from public.ns_seasonal_assignments
              where set_id = p_set_id and status in ('assigned', 'installed')) then
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
    if coalesce(p_strip_material_id, v_set.material_id) is null then
      raise exception
        'Say which material the salvage goes back to stock as. This set does '
        'not record one.'
        using errcode = 'invalid_parameter_value';
    end if;

    if p_location_code is not null then
      v_code := p_location_code;
    else
      select code into v_code from public.ns_stock_locations
       where kind = 'base' and active;
    end if;

    -- Back across the line, as a 'returned' receipt. Suffixed key for the
    -- same reason the build uses one.
    v_strip := public.post_stock_movement(
      p_client_operation_id || ':strip',
      coalesce(p_strip_material_id, v_set.material_id),
      v_code,
      p_strip_quantity,
      'returned',
      coalesce(p_note, 'Stripped from set ' || v_set.set_code));
    v_op := (v_strip ->> 'operation_id')::uuid;
  end if;

  update public.ns_rental_sets
     set status = 'retired',
         retired_at = now(),
         stripped_to_operation = coalesce(v_op, stripped_to_operation),
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
            'Returned ' || p_strip_quantity || ' to stock', auth.uid());
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
    'public.can_handle_set(uuid)',
    'public.ns_seasonal_release_cutoff(integer)',
    'public.ns_seasonal_result(uuid,uuid,boolean)',
    'public.ns_seasonal_replay(text)',
    'public.register_seasonal_set(text,text,text,text,numeric,text,uuid,numeric,text)',
    'public.assign_seasonal_set(text,uuid,uuid,integer,uuid,uuid,text)',
    'public.cancel_seasonal_assignment(text,uuid,text)',
    'public.install_seasonal_set(text,uuid,timestamptz,uuid,text)',
    'public.recover_seasonal_set(text,uuid,text,text,timestamptz,text)',
    'public.inspect_seasonal_set(text,uuid,text,text)',
    'public.release_seasonal_set(text,uuid,text)',
    'public.record_set_renewal(text,uuid,text,text)',
    'public.retire_seasonal_set(text,uuid,uuid,numeric,text,text)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('grant execute on function %s to authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

-- The same three-route privilege check Batch 7.1 found necessary: reading
-- the grant list is not the same as asking whether the role can execute.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.register_seasonal_set(text,text,text,text,numeric,text,uuid,numeric,text)',
    'public.assign_seasonal_set(text,uuid,uuid,integer,uuid,uuid,text)',
    'public.install_seasonal_set(text,uuid,timestamptz,uuid,text)',
    'public.recover_seasonal_set(text,uuid,text,text,timestamptz,text)',
    'public.inspect_seasonal_set(text,uuid,text,text)',
    'public.release_seasonal_set(text,uuid,text)',
    'public.retire_seasonal_set(text,uuid,uuid,numeric,text,text)'
  ] loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception
        'anon still holds EXECUTE on % after an explicit revoke from both anon '
        'and PUBLIC, so it is INHERITED from a role anon is a member of. '
        'Inspect pg_auth_members for anon and revoke there.', f
        using errcode = 'insufficient_privilege';
    end if;
  end loop;

  if has_table_privilege('authenticated', 'public.ns_seasonal_assignments', 'INSERT') then
    raise exception
      'authenticated can still INSERT assignments directly, which bypasses '
      'the conflict rule, the crew scoping and the replay key.'
      using errcode = 'insufficient_privilege';
  end if;

  if has_table_privilege('authenticated', 'public.ns_rental_set_events', 'UPDATE')
     or has_table_privilege('authenticated', 'public.ns_rental_set_events', 'DELETE') then
    raise exception
      'The set lifecycle log must be append-only: it is both the audit trail '
      'and the replay ledger, and an editable replay ledger is not one.'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

comment on function public.recover_seasonal_set(text,uuid,text,text,timestamptz,text) is
  'Records what came back without declaring it usable: the set returns to '
  'uninspected every time, so a set can never be re-promised on the '
  'strength of an inspection from a previous season.';

comment on function public.release_seasonal_set(text,uuid,text) is
  'Ends the assignment. Moves no stock, deletes nothing, and refuses while '
  'the set is still installed, so it can neither duplicate stock nor erase '
  'history nor claim a return that has not happened.';
