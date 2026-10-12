-- Batch 9.1 corrective: the seven findings from Codex's read-only review of
-- abedf0f (docs/reviews/seasonal-contract-abedf0f.md on
-- codex/batch-10-2-prep).
--
-- All seven were verified against the source before anything was changed.
-- Four were real defects, one was a documentation error, and two needed a
-- decision rather than a patch. What each one turned into:
--
--   1 crew replay returned before the location check, and returned the
--     REPLAYED target rather than the caller's -> one guarded replay helper
--     that checks kind, target and scope before returning anything.
--   2 §7's conservation expression was not an invariant for every allowed
--     build/strip -> a strip now reverses a build it can prove happened,
--     for the same material, up to the quantity actually built, and the
--     remainder is recorded as scrap instead of silently vanishing.
--   3 a suffixed key could pick up an unrelated pre-posted movement ->
--     the build and strip operations are verified to contain the movement
--     that was asked for.
--   4 retirement could precede release of a recovered assignment -> the
--     check now agrees with its own error message, and with the
--     open-assignment rule Batch 10.1 made load-bearing.
--   5 §11 called an assigned set "loaded" -> a documentation fix, now
--     superseded by docs/daily-load-contract-v1.md, which is the authority
--     on what is physically on a van.
--   6 availability flags could be NULL and could overlap -> every flag is
--     non-null, and the overlapping reasons are returned as a list.
--   7 state no-ops recorded nothing and replay checked kind but not target
--     -> a no-op is now distinguishable in the response, and a key that
--     belongs to a different set or assignment is refused.
--
-- APPEND-ONLY. The 9.1 migrations have been rehearsed and are read by the
-- field track; this corrects them forward rather than editing history.
--
-- NOT APPLIED. Written and tested against a disposable PostgreSQL only.

/* ===================================================================== */
/* 1. what a set holds, written down                                     */
/* ===================================================================== */

-- Finding 2. The invariant was stated over "the build movement of every
-- set that has not been stripped", which cannot express a partial strip.
-- Recording both numbers makes the expression exact and checkable by a
-- reader instead of reconstructed from the ledger.
alter table public.ns_rental_sets
  add column if not exists built_quantity numeric;
alter table public.ns_rental_sets
  add column if not exists stripped_quantity numeric;

alter table public.ns_rental_sets
  drop constraint if exists ns_rental_sets_built_quantity_positive;
alter table public.ns_rental_sets
  add constraint ns_rental_sets_built_quantity_positive
    check (built_quantity is null or built_quantity > 0);

alter table public.ns_rental_sets
  drop constraint if exists ns_rental_sets_strip_within_build;
alter table public.ns_rental_sets
  add constraint ns_rental_sets_strip_within_build check (
    stripped_quantity is null
    or (built_quantity is not null
        and stripped_quantity > 0
        and stripped_quantity <= built_quantity));

-- A build quantity without the movement that produced it would be a number
-- nobody can trace.
alter table public.ns_rental_sets
  drop constraint if exists ns_rental_sets_build_quantity_sourced;
alter table public.ns_rental_sets
  add constraint ns_rental_sets_build_quantity_sourced check (
    (built_quantity is null) = (built_from_operation is null));

comment on column public.ns_rental_sets.stripped_quantity is
  'How much of the build actually came back. built_quantity minus this is '
  'scrap: the part not worth saving. Recording it is what makes the '
  'accounting invariant true for a partial strip instead of approximately '
  'true for a whole one.';

/* ===================================================================== */
/* 2. proving a stock operation is the one we asked for                  */
/* ===================================================================== */

-- Finding 3. post_stock_movement replays ANY existing operation under a
-- matching client_operation_id without comparing the payload (Batch 8.1
-- contract §5, and the behaviour is deliberate there). The seasonal build
-- and strip derive their keys by suffixing, which is a convention and not a
-- reserved namespace, so a movement pre-posted under '<key>:build' would be
-- handed straight back and the set would attach to a debit that never
-- happened.
--
-- Rather than restrict the frozen function's accepted input -- which would
-- break any caller that uses a colon -- the dependency is verified at the
-- boundary: the operation we got back must contain exactly the movement we
-- asked for, and nothing else.
create or replace function public.ns_verify_stock_operation(
  p_operation_id  uuid,
  p_material_id   uuid,
  p_location_code text,
  p_delta         numeric,
  p_reason        text
)
returns void
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_n integer;
begin
  select count(*) into v_n
    from public.ns_material_stock_moves mv
    join public.ns_stock_locations l on l.id = mv.location_id
   where mv.operation_id = p_operation_id
     and mv.material_id = p_material_id
     and lower(btrim(l.code)) = lower(btrim(p_location_code))
     and mv.delta = p_delta
     and mv.reason = p_reason;
  if v_n <> 1 then
    raise exception
      'Operation % does not record the % of % this depended on. The key was '
      'already used for something else, so the set would attach to a '
      'movement that is not its own.',
      p_operation_id, p_reason, abs(p_delta)
      using errcode = 'unique_violation';
  end if;
end
$$;

/* ===================================================================== */
/* 3. one guarded replay                                                 */
/* ===================================================================== */

-- Findings 1 and 7. The old shape returned a replay before checking the
-- caller's scope, and returned the REPLAYED event's set rather than the one
-- the caller named -- so a crew holding another operation's key could read
-- a set at the other vehicle. It also compared the event KIND but not the
-- target, so the same kind of key reused against a different assignment
-- returned the old one instead of refusing.
--
-- `p_expected` is a comma-separated list because record_set_renewal accepts
-- two event kinds.
create or replace function public.ns_seasonal_replay_guard(
  p_client_operation_id text,
  p_expected            text,
  p_set_id              uuid default null,
  p_assignment_id       uuid default null
)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_evt public.ns_rental_set_events;
begin
  select * into v_evt from public.ns_rental_set_events
   where client_operation_id = p_client_operation_id;
  if not found then return null; end if;

  if not (v_evt.event = any (string_to_array(p_expected, ','))) then
    raise exception 'client_operation_id % was already used to record a %',
      p_client_operation_id, v_evt.event
      using errcode = 'unique_violation';
  end if;

  -- A key belongs to the thing it was first used on. Returning somebody
  -- else's set because the kind happened to match is worse than refusing.
  if p_set_id is not null and v_evt.rental_set_id is distinct from p_set_id then
    raise exception
      'client_operation_id % belongs to a different set. A retry repeats the '
      'same request; this is a different one.', p_client_operation_id
      using errcode = 'unique_violation';
  end if;
  if p_assignment_id is not null
     and v_evt.assignment_id is distinct from p_assignment_id then
    raise exception
      'client_operation_id % belongs to a different assignment.',
      p_client_operation_id
      using errcode = 'unique_violation';
  end if;

  -- SCOPE ON THE REPLAYED TARGET, not only on what the caller passed. These
  -- functions are SECURITY DEFINER, so without this the reply is composed
  -- with the function owner's access.
  if not public.can_handle_set(v_evt.rental_set_id) then
    raise exception 'That set is not at a location you work from'
      using errcode = 'insufficient_privilege';
  end if;

  return public.ns_seasonal_result(v_evt.rental_set_id, v_evt.assignment_id,
                                   true, false);
end
$$;

/* ===================================================================== */
/* 4. availability: no nulls, and overlapping reasons made explicit      */
/* ===================================================================== */

-- Finding 6. `a.status = 'removed'` is NULL when the left join misses, and
-- the contract illustrated false. Worse, the contract claimed "exactly one
-- of the five reason flags explains why", which a removed, damaged set at
-- the repair bench disproves: three are true at once.
--
-- Every flag is now non-null, and the reasons a caller should SHOW are
-- returned as an ordered list so nothing has to guess which one wins.
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
       (a.id is not null)                                as has_active_assignment,
       coalesce(a.status = 'removed', false)             as awaiting_release,
       coalesce(s.condition = 'uninspected', false)      as needs_inspection,
       coalesce(s.condition in ('damaged','missing'), false) as needs_repair_or_search,
       coalesce(s.status in ('retired','lost'), false)   as out_of_service,
       coalesce(s.status = 'in_repair', false)           as at_the_repair_bench,
       (    a.id is null
        and s.status = 'in_storage'
        and s.condition = 'usable'
        and s.inspected_at is not null)                  as available_for_reuse,
       /* EVERY reason that applies, most decisive first. Several can be
          true at once -- a damaged set recovered but not released, sitting
          at the bench, is three of them -- so a caller that assumed an
          exclusive enum would show the wrong sentence.

          The list is COMPLETE, not illustrative: it is empty if and only if
          available_for_reuse is true, which is what makes it safe to render
          as the whole explanation rather than as a hint. The six cases
          cover every way the four availability legs can fail. 'deployed'
          needs no case of its own: the deferred constraint trigger
          ns_guard_set_matches_assignment makes 'deployed' and an
          'installed' assignment imply each other, so with_a_customer
          always covers it. If that trigger is ever relaxed, a seventh case
          belongs here -- batch9-1.test.mjs M9 asserts the correspondence
          over every row of the view, so the suite will say so rather than
          an operator meeting a blank explanation. */
       array_remove(array[
         case when s.status in ('retired','lost') then 'out_of_service' end,
         case when a.status in ('assigned','installed') then 'with_a_customer' end,
         case when a.status = 'removed' then 'awaiting_release' end,
         case when s.status = 'in_repair' then 'at_the_repair_bench' end,
         case when s.condition in ('damaged','missing') then 'needs_repair_or_search' end,
         case when s.condition = 'uninspected' then 'needs_inspection' end
       ], null)                                          as blocking_reasons
  from public.ns_rental_sets s
  left join public.ns_seasonal_assignments a
         on a.set_id = s.id
        and a.status in ('assigned', 'installed', 'removed');

do $$
begin
  execute 'alter view public.ns_seasonal_set_availability set (security_invoker = on)';
  execute 'revoke all on public.ns_seasonal_set_availability from public';
  execute 'revoke all on public.ns_seasonal_set_availability from anon';
  execute 'grant select on public.ns_seasonal_set_availability to authenticated';
  execute 'grant select on public.ns_seasonal_set_availability to service_role';
end
$$;

/* ===================================================================== */
/* 5. the result shape gains no_op                                       */
/* ===================================================================== */

-- Finding 7. "replayed" meant two different things: your key was already
-- used, and the work was already done. A client cannot tell them apart, and
-- the contract's claim that every call appends one keyed event was false for
-- the second. Both are now reported.
create or replace function public.ns_seasonal_result(
  p_set_id uuid, p_assignment_id uuid, p_replayed boolean,
  p_no_op boolean default false)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'replayed', p_replayed,
    -- true  = nothing needed doing; no key was recorded
    -- false = this is the original, or a true replay of a recorded key
    'no_op',    p_no_op,
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
               'built_quantity',        s.built_quantity,
               'stripped_to_operation', s.stripped_to_operation,
               'stripped_quantity',     s.stripped_quantity)
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
               'available_for_reuse',    v.available_for_reuse,
               'has_active_assignment',  v.has_active_assignment,
               'awaiting_release',       v.awaiting_release,
               'needs_inspection',       v.needs_inspection,
               'needs_repair_or_search', v.needs_repair_or_search,
               'out_of_service',         v.out_of_service,
               'at_the_repair_bench',    v.at_the_repair_bench,
               'blocking_reasons',       to_jsonb(v.blocking_reasons))
        from public.ns_seasonal_set_availability v
       where v.set_id = p_set_id)
  )
$$;

/* ===================================================================== */
/* 6. the nine operations, corrected                                     */
/* ===================================================================== */

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

    /* PROVE THE DEBIT HAPPENED. post_stock_movement replays ANY existing
       operation under a matching key without comparing the payload, so a
       movement pre-posted under '<key>:build' would be handed back here and
       the set would attach to it having consumed nothing. The suffix is a
       convention, not a namespace, so the only safe thing is to check that
       the operation we got back actually contains the debit we asked for. */
    perform public.ns_verify_stock_operation(
      v_op, p_material_id,
      (select code from public.ns_stock_locations where id = v_location),
      -p_build_quantity, 'consumed');
  end if;

  begin
    insert into public.ns_rental_sets
      (set_code, material_id, status, condition, linear_ft, run_type, colour,
       location_id, built_from_operation, built_quantity, condition_note)
    values
      (btrim(p_set_code), p_material_id, 'in_storage', 'uninspected',
       p_linear_ft, p_run_type, p_colour, v_location, v_op,
       -- Written down rather than re-derived: the accounting invariant has
       -- to be checkable by a reader, not reconstructed from the ledger.
       case when v_op is null then null else p_build_quantity end,
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
            'Consumed ' || p_build_quantity || ' from stock', auth.uid());
  end if;

  return public.ns_seasonal_result(v_set, null, false);
end
$$;

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
  v_replay jsonb;
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

  v_replay := public.ns_seasonal_replay_guard(
    p_client_operation_id, 'assigned', p_set_id, null);
  if v_replay is not null then return v_replay; end if;

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
  v_replay jsonb;
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

  v_replay := public.ns_seasonal_replay_guard(
    p_client_operation_id, 'unassigned', null, p_assignment_id);
  if v_replay is not null then return v_replay; end if;

  select * into v_a from public.ns_seasonal_assignments
   where id = p_assignment_id for update;
  if not found then
    raise exception 'No such assignment %', p_assignment_id
      using errcode = 'no_data_found';
  end if;

  -- Already cancelled is the same outcome, so a lost response that is
  -- retried under a new key still succeeds instead of confusing the admin.
  if v_a.status = 'cancelled' then
    return public.ns_seasonal_result(v_a.set_id, v_a.id, true, true);
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
  v_replay jsonb;
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

  v_replay := public.ns_seasonal_replay_guard(
    p_client_operation_id, 'installed', null, p_assignment_id);
  if v_replay is not null then return v_replay; end if;

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
    return public.ns_seasonal_result(v_a.set_id, v_a.id, true, true);
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
  v_replay jsonb;
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

  v_replay := public.ns_seasonal_replay_guard(
    p_client_operation_id, 'recovered', null, p_assignment_id);
  if v_replay is not null then return v_replay; end if;

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
    return public.ns_seasonal_result(v_a.set_id, v_a.id, true, true);
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
  v_replay jsonb;
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

  v_replay := public.ns_seasonal_replay_guard(
    p_client_operation_id, 'inspected', p_set_id, null);
  if v_replay is not null then return v_replay; end if;

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
  v_replay jsonb;
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

  v_replay := public.ns_seasonal_replay_guard(
    p_client_operation_id, 'released', null, p_assignment_id);
  if v_replay is not null then return v_replay; end if;

  select * into v_a from public.ns_seasonal_assignments
   where id = p_assignment_id for update;
  if not found then
    raise exception 'No such assignment %', p_assignment_id
      using errcode = 'no_data_found';
  end if;

  if v_a.status = 'released' then
    return public.ns_seasonal_result(v_a.set_id, v_a.id, true, true);
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
  v_replay jsonb;
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

  v_replay := public.ns_seasonal_replay_guard(
    p_client_operation_id, 'renewed,not_renewed', null, p_assignment_id);
  if v_replay is not null then return v_replay; end if;

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

  /* 'removed' belongs here. An assignment is OPEN until it is released --
     that is what Batch 10.1 made load-bearing -- so retiring a recovered
     set whose season has not been closed leaves a commercial promise open
     against an asset that no longer exists. The message below already said
     "recover and release"; this is the check finally agreeing with it. */
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

    /* A STRIP REVERSES A BUILD. It cannot invent one.
       Without these three rules the §7 conservation expression is not an
       invariant: build 200 and strip 150 loses 50 from the total, strip 250
       creates 50, and a set bought assembled could post a receipt against a
       debit that never happened. */
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
      v_set.material_id,
      v_code,
      p_strip_quantity,
      'returned',
      coalesce(p_note, 'Stripped from set ' || v_set.set_code));
    v_op := (v_strip ->> 'operation_id')::uuid;

    -- Same provenance check as the build, for the same reason.
    perform public.ns_verify_stock_operation(
      v_op, v_set.material_id, v_code, p_strip_quantity, 'returned');
  end if;

  update public.ns_rental_sets
     set status = 'retired',
         retired_at = now(),
         stripped_to_operation = coalesce(v_op, stripped_to_operation),
         -- What actually came back. The remainder is scrap, and the
         -- invariant in the contract names it as such rather than pretending
         -- a partial strip conserved everything.
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
            'Returned ' || p_strip_quantity || ' to stock', auth.uid());
  end if;

  return public.ns_seasonal_result(p_set_id, null, false);
end
$$;

/* ===================================================================== */
/* 7. grants                                                             */
/* ===================================================================== */

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.ns_verify_stock_operation(uuid,uuid,text,numeric,text)',
    'public.ns_seasonal_replay_guard(text,text,uuid,uuid)',
    'public.ns_seasonal_result(uuid,uuid,boolean,boolean)'
  ] loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('grant execute on function %s to authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

-- The three-argument result function is replaced by the four-argument one.
-- Dropped rather than left as an overload, for the same reason Batch 8.1
-- dropped the nine-argument post_stock_movement: an old form that still
-- works is an old form somebody keeps calling.
drop function if exists public.ns_seasonal_result(uuid,uuid,boolean);

-- ns_seasonal_replay is superseded by the guard, which checks what it did
-- not. Left in place rather than dropped because it is a harmless read, but
-- nothing in the contract calls it any more.
comment on function public.ns_seasonal_replay(text) is
  'Superseded by ns_seasonal_replay_guard, which also checks the target and '
  'the caller scope. Kept as a plain read; no contract operation uses it.';

do $$
begin
  if has_function_privilege('anon',
       'public.ns_seasonal_replay_guard(text,text,uuid,uuid)', 'execute') then
    raise exception 'anon can execute the replay guard'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;
