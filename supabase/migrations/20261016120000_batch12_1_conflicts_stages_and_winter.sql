-- ===========================================================================
-- Batch 12.1, part 4: what the two cars are fighting over, what stage the
-- seasonal work is at, and the winter visit the owner triggers by hand.
--
-- EVERYTHING HERE IS A READ, with one exception (dispatch_winter_visit,
-- which reuses the existing assignment and reschedule paths). Nothing in
-- this file transfers stock, reserves anything, buys anything, installs
-- anything or sends anything. A conflict is information; acting on it is
-- the owner's, through the operations that already exist.
--
-- NOT APPLIED ANYWHERE.
-- ===========================================================================

/* ===================================================================== */
/* 1. the equipment a vehicle's day needs, without building a plan         */
/* ===================================================================== */

-- WHY THIS MIRRORS build_load_plan RATHER THAN CALLING IT. build_load_plan
-- is owner-only and creates a revision, so a conflict screen cannot call
-- it: opening a page would rewrite the day's plan. This derives the
-- EQUIPMENT half only -- the shared, countable, day-level things two cars
-- can fight over -- and deliberately leaves consumable planning,
-- baselines, seasonal sets and the Keep/Add/Return decision where they
-- belong, in the plan.
--
-- The derivation is the same three rules as the plan's: an `equipment` rule
-- on a service in play today, plus every `always_keep` rule whatever the
-- day holds, plus job `require` overrides, minus job `exclude` overrides
-- (which cannot remove an always_keep item). Drift between the two is a
-- real risk and the suite asserts they agree (batch12-1 C-block).
create or replace function public.ns_vehicle_day_equipment(
  p_location_id uuid, p_work_date date)
returns table (
  material_id uuid,
  always_keep boolean,
  removable   boolean,
  reason      text,
  job_ids     uuid[])
language sql
stable
set search_path = public, pg_temp
as $$
  with day_jobs as (
    select j.job_id from public.ns_vehicle_day_jobs(p_location_id, p_work_date) j
  ),
  day_services as (
    select distinct jm.service_id
      from public.job_measurements jm
      join day_jobs d on d.job_id = jm.job_id
  ),
  ruled as (
    select r.material_id,
           bool_or(r.always_keep) as always_keep,
           bool_and(r.removable)  as removable,
           'Needed for ' || string_agg(distinct s.name, ', ') as reason,
           coalesce(array_agg(distinct d.job_id)
                      filter (where d.job_id is not null), '{}') as job_ids
      from public.ns_service_load_rules r
      join public.services s on s.id = r.service_id
      left join public.job_measurements jm on jm.service_id = r.service_id
      left join day_jobs d on d.job_id = jm.job_id
     where r.rule_kind = 'equipment'
       and (r.always_keep or r.service_id in (select service_id from day_services))
     group by r.material_id
  ),
  required as (
    select material_id, always_keep, removable, reason, job_ids from ruled
    union all
    select o.material_id, false, false,
           'Job override: ' || coalesce(o.reason, 'required for this job'),
           array_agg(o.job_id)
      from public.ns_job_load_overrides o
      join day_jobs d on d.job_id = o.job_id
     where o.action = 'require'
       and not exists (select 1 from ruled r where r.material_id = o.material_id)
     group by o.material_id, o.reason
  )
  select q.material_id, q.always_keep, q.removable, q.reason, q.job_ids
    from required q
   where not (
     exists (
       select 1 from public.ns_job_load_overrides o
        join day_jobs d on d.job_id = o.job_id
       where o.material_id = q.material_id and o.action = 'exclude')
     and not q.always_keep)
$$;

/** What the vehicles are competing for on a given day.
 *
 *  SIX DIFFERENT ANSWERS, because "there is a problem with the washer" is
 *  not actionable and these are:
 *
 *    shared_scarce  both cars need it and there is not enough to go round.
 *                   The day-level one: a washer needed at three stops on
 *                   Car A is ONE requirement, not three.
 *    unavailable    nobody has a usable one anywhere.
 *    damaged_only   the only ones we have are in the damaged pool.
 *    location_unknown  the ledger has it, but not at Base or either car.
 *                   Reported as unknown; a guess here sends a crew out
 *                   without a tool.
 *    missing_data   the day needs it and nothing records how many we have.
 *                   An unknown quantity is NEVER rendered as zero.
 *    none           no conflict; included so a screen can show the row.
 *
 *  Nothing is transferred, reserved, bought or consumed by looking. */
create or replace function public.dispatch_equipment_conflicts(p_work_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_base uuid;
begin
  if not public.is_admin() then
    raise exception 'dispatch_equipment_conflicts is admin-only'
      using errcode = 'insufficient_privilege';
  end if;

  select id into v_base from public.ns_stock_locations
   where kind = 'base' and active;

  return jsonb_build_object(
    'work_date', p_work_date,
    'work_day_timezone', public.ns_work_day_timezone(),
    'vehicles', coalesce((
      select jsonb_agg(jsonb_build_object('location_id', l.id, 'code', l.code,
                                          'name', l.name)
             order by l.sort_order, l.code)
        from public.ns_stock_locations l
       where l.kind = 'vehicle' and l.active
         and public.can_see_location(l.id)), '[]'::jsonb),
    'items', coalesce((
      with vehicles as (
        select l.id, l.code from public.ns_stock_locations l
         where l.kind = 'vehicle' and l.active and public.can_see_location(l.id)
      ),
      -- ONE requirement per (vehicle, material), however many stops want
      -- it. This is the whole-day rule, enforced by the group by.
      need as (
        select v.id as location_id, v.code, e.material_id,
               bool_or(e.always_keep) as always_keep,
               count(*)::integer as rules
          from vehicles v
          cross join lateral public.ns_vehicle_day_equipment(v.id, p_work_date) e
         group by v.id, v.code, e.material_id
      ),
      totals as (
        select n.material_id,
               count(*)::integer as vehicles_needing,
               array_agg(n.code order by n.code) as needed_by,
               sum(1)::numeric as required_total
          from need n group by n.material_id
      )
      select jsonb_agg(jsonb_build_object(
               'material_id',      t.material_id,
               'material_name',    m.name,
               'unit',             m.unit,
               'tracking_mode',    m.tracking_mode,
               'needed_by',        to_jsonb(t.needed_by),
               'vehicles_needing', t.vehicles_needing,
               -- One per car that needs it. Equipment is counted in whole
               -- tools, which is why this is the vehicle count and not a
               -- sum of stops.
               'required_total',   t.required_total,
               -- Unknown is null, never 0. A level-tracked item has no
               -- number at all and says so.
               -- NOT base.on_hand directly: the view cross-joins every
               -- material with every location and coalesces to 0, so a
               -- material nobody has ever counted reads as "0 at Base".
               -- last_move_at is how the view says "no record exists", and
               -- an unknown quantity is reported as null.
               'usable_at_base',   case
                 when m.tracking_mode = 'level' then null
                 when base.last_move_at is null then null
                 else base.on_hand end,
               'usable_aboard',    coalesce((
                 select jsonb_object_agg(v2.code,
                          case when m.tracking_mode = 'level' then null
                               when b2.last_move_at is null then null
                               else b2.on_hand end)
                   from public.ns_stock_locations v2
                   left join public.ns_material_stock_by_location b2
                          on b2.material_id = t.material_id and b2.location_id = v2.id
                  where v2.kind = 'vehicle' and v2.active
                    and public.can_see_location(v2.id)), '{}'::jsonb),
               'damaged_at_base',  case
                 when m.tracking_mode = 'level' then null
                 when base.last_move_at is null then null
                 else base.damaged_on_hand end,
               'level_state',      case when m.tracking_mode = 'level' then
                 (select lv.state from public.ns_material_levels lv
                   where lv.material_id = t.material_id and lv.location_id = v_base)
                 else null end,
               'conflict', case
                 when m.tracking_mode = 'level' then
                   case when (select lv.state from public.ns_material_levels lv
                               where lv.material_id = t.material_id
                                 and lv.location_id = v_base) is null
                        then 'missing_data' else 'none' end
                 -- Nothing has ever been recorded for this material at
                 -- Base or on any car: that is missing information, not a
                 -- shortage, and the two need different action.
                 when base.last_move_at is null and aboard.moves is null then 'missing_data'
                 when coalesce(base.on_hand, 0) + coalesce(aboard.total, 0) <= 0
                      and coalesce(base.damaged_on_hand, 0) > 0 then 'damaged_only'
                 when coalesce(base.on_hand, 0) + coalesce(aboard.total, 0) <= 0
                      and coalesce(anywhere.total, 0) > 0 then 'location_unknown'
                 when coalesce(base.on_hand, 0) + coalesce(aboard.total, 0) <= 0
                   then 'unavailable'
                 when t.vehicles_needing > 1
                      and coalesce(base.on_hand, 0) + coalesce(aboard.total, 0)
                          < t.required_total then 'shared_scarce'
                 else 'none' end)
             order by m.name, t.material_id)
        from totals t
        join public.ns_materials m on m.id = t.material_id
        left join public.ns_material_stock_by_location base
               on base.material_id = t.material_id and base.location_id = v_base
        left join lateral (
          select sum(b.on_hand) as total, max(b.last_move_at) as moves
            from public.ns_material_stock_by_location b
            join public.ns_stock_locations l on l.id = b.location_id
           where b.material_id = t.material_id and l.kind = 'vehicle' and l.active
        ) aboard on true
        left join lateral (
          select sum(b.on_hand) as total
            from public.ns_material_stock_by_location b
           where b.material_id = t.material_id
             and b.last_move_at is not null
        ) anywhere on true), '[]'::jsonb));
end
$$;

/* ===================================================================== */
/* 2. seasonal work, as stages that stay separate                         */
/* ===================================================================== */

-- FIVE ACTS, FIVE RPCs, AND NO BUNDLE. install_seasonal_set,
-- recover_seasonal_set, inspect_seasonal_set, release_seasonal_set and
-- record_set_renewal already exist (9.1, corrected in 11.1's round two).
-- Dispatch does NOT wrap them: a stage shown on a planning screen is a
-- READ of where the work stands, and moving it on is whichever of those
-- five acts the owner means. Nothing here calls them.
--
-- The two facts that get conflated, kept apart in the output:
--   * an ASSIGNMENT is a commercial promise to a customer;
--   * a SET's status and location is where the physical thing is.
-- A set promised for today is not thereby aboard the car.
create or replace view public.ns_dispatch_seasonal_work as
  select a.job_id,
         a.id                       as assignment_id,
         a.set_id,
         s.set_code,
         a.status                   as assignment_status,
         a.season_year,
         s.status                   as set_status,
         s.location_id              as set_location_id,
         l.code                     as set_location_code,
         -- The commercial promise and the physical fact, named so neither
         -- can be read as the other.
         (a.status in ('assigned', 'installed')) as promised_to_a_customer,
         (s.status = 'in_storage' and l.kind = 'vehicle') as aboard_a_vehicle,
         (s.status = 'deployed')    as physically_installed,
         -- What the next act would be, as a LABEL. Not a button, not a
         -- transition, and not an invitation to run all five.
         case
           when a.status = 'assigned'  and s.status = 'in_storage' then 'to_install'
           when a.status = 'installed' and s.status = 'deployed'   then 'to_recover'
           when a.status = 'removed'                               then 'to_inspect'
           when a.status = 'released'                              then 'finished'
           when a.status = 'cancelled'                             then 'cancelled'
           else 'needs_review'
         end                        as stage
    from public.ns_seasonal_assignments a
    join public.ns_rental_sets s on s.id = a.set_id
    left join public.ns_stock_locations l on l.id = s.location_id
   where a.job_id is not null;

comment on view public.ns_dispatch_seasonal_work is
  'Where each job''s seasonal work stands. `stage` is a LABEL for a '
  'screen, not a transition: installation, recovery, inspection, release '
  'and renewal remain five separate owner acts with their own RPCs, and '
  'moving a dispatch stage invokes none of them. A commercial assignment '
  'never implies the set is aboard a car.';

/* ===================================================================== */
/* 3. winter work the owner triggers deliberately                         */
/* ===================================================================== */

/** What the system knows about automating winter visits: nothing, and it
 *  says so.
 *
 *  No snowfall threshold, no forecast source, no visit allowance and no
 *  salt dosage is invented here. They are reported as `unconfigured` so a
 *  screen can tell the owner that triggering a visit is a deliberate act
 *  rather than implying a rule exists. */
create or replace function public.ns_winter_automation_state()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb := '{}'::jsonb;
begin
  if to_regclass('public.app_settings') is not null then
    begin
      execute $q$
        select coalesce(value::jsonb, '{}'::jsonb)
          from public.app_settings where key = 'winter' limit 1
      $q$ into v;
    exception when others then
      v := '{}'::jsonb;
    end;
  end if;
  v := coalesce(v, '{}'::jsonb);

  return jsonb_build_object(
    'mode', 'owner_triggered',
    'snowfall_threshold', jsonb_build_object(
      'value', v -> 'snowfall_threshold_cm',
      'state', case when v ? 'snowfall_threshold_cm' then 'configured'
                    else 'unconfigured' end),
    'forecast_source', jsonb_build_object(
      'value', v -> 'forecast_source',
      'state', case when v ? 'forecast_source' then 'configured'
                    else 'unconfigured' end),
    'visit_allowance', jsonb_build_object(
      'value', v -> 'visits_included',
      'state', case when v ? 'visits_included' then 'configured'
                    else 'unconfigured' end),
    'note', 'Nothing dispatches winter work automatically. The owner '
            'triggers a visit; no snowfall rule, forecast source, visit '
            'allowance or salt dosage is assumed.');
end
$$;

/** Winter visits that could be triggered for a day.
 *
 *  ONE ROW PER PROPERTY, not per service. Walkway and deck variants of
 *  Winter Property Care are one visit to one place: grouping them here is
 *  what stops two dispatches and two minimums for one trip out.
 *
 *  `already_dispatched_on` names the day a winter visit for that property
 *  is already scheduled, so a second one is a visible duplicate rather
 *  than a surprise. */
create or replace function public.ns_winter_dispatch_candidates(p_work_date date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'ns_winter_dispatch_candidates is admin-only'
      using errcode = 'insufficient_privilege';
  end if;

  return jsonb_build_object(
    'work_date',  p_work_date,
    'automation', public.ns_winter_automation_state(),
    'candidates', coalesce((
      with winter_jobs as (
        select j.id as job_id, j.property_id, j.customer_id, j.scheduled_for,
               j.status
          from public.ns_jobs j
         where coalesce(j.status, '') not in
                 ('cancelled', 'completed', 'lost', 'declined')
           and exists (select 1 from public.job_measurements jm
                         join public.services s on s.id = jm.service_id
                        where jm.job_id = j.id and s.key like 'winter%')
      ),
      /* ONE ROW PER PROPERTY. Aggregated in its own step rather than
         inside the jsonb_agg below: PostgreSQL will not nest an aggregate
         inside another aggregate's argument, and the walkway-and-deck
         grouping is the whole point of this read. */
      per_property as (
        select w.property_id,
               w.customer_id,
               array_agg(w.job_id order by w.scheduled_for nulls last, w.job_id)
                                                           as job_ids,
               min(w.scheduled_for)                        as scheduled_for,
               min((w.scheduled_for at time zone
                     coalesce(public.ns_work_day_timezone(), 'UTC'))::date)
                                                           as already_dispatched_on
          from winter_jobs w
         group by w.property_id, w.customer_id
      )
      select jsonb_agg(jsonb_build_object(
               'property_id',   p.property_id,
               'customer_id',   p.customer_id,
               'customer_name', c.name,
               'job_ids',       to_jsonb(p.job_ids),
               -- Every winter service at this property, from the source
               -- rows: one visit, however many variants are on it.
               'services',      to_jsonb((
                 select array_agg(distinct s2.key order by s2.key)
                   from winter_jobs w2
                   join public.job_measurements jm2 on jm2.job_id = w2.job_id
                   join public.services s2 on s2.id = jm2.service_id
                  where w2.property_id = p.property_id and s2.key like 'winter%')),
               'scheduled_for', p.scheduled_for,
               'already_dispatched_on', p.already_dispatched_on,
               -- Which car (if any) already has this property's winter work.
               'assigned_to', (
                 select min(l.code) from public.ns_job_vehicle_assignments a
                   join public.ns_stock_locations l on l.id = a.location_id
                   join winter_jobs w3 on w3.job_id = a.job_id
                  where w3.property_id = p.property_id)
             ) order by c.name, p.property_id)
        from per_property p
        left join public.customers c on c.id = p.customer_id), '[]'::jsonb));
end
$$;

/** Put an EXISTING winter job on a day and a car, deliberately.
 *
 *  Creates no job, no minimum, no allowance and no second visit: it reuses
 *  reschedule_job and assign_job_to_vehicle, so the load-plan invalidation,
 *  the revision checks and the key ledger all behave exactly as they do for
 *  any other dispatch edit.
 *
 *  Refuses when that property already has a winter visit on that day --
 *  the walkway-and-deck duplicate. */
create or replace function public.dispatch_winter_visit(
  p_client_operation_id text,
  p_job_id              uuid,
  p_location_code       text,
  p_scheduled_for       timestamptz,
  p_reason              text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job   public.ns_jobs;
  v_tz    text;
  v_day   date;
  v_dupe  uuid;
  v_sched jsonb;
  v_assign jsonb;
begin
  if not public.is_owner() then
    raise exception
      'Triggering a winter visit is the owner''s decision -- there is no '
      'weather rule that does it.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception
      'Say why this visit is going out. With no configured snowfall rule, '
      'the reason IS the record of the decision.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_job from public.ns_jobs where id = p_job_id;
  if not found then
    raise exception 'No such job %', p_job_id using errcode = 'no_data_found';
  end if;
  if not exists (
    select 1 from public.job_measurements jm
      join public.services s on s.id = jm.service_id
     where jm.job_id = p_job_id and s.key like 'winter%') then
    raise exception
      'Job % has no winter service on it, so this is not a winter visit. '
      'Use the ordinary scheduling path.', p_job_id
      using errcode = 'invalid_parameter_value';
  end if;

  v_tz := coalesce(public.ns_work_day_timezone(), 'UTC');
  v_day := (p_scheduled_for at time zone v_tz)::date;

  -- ONE VISIT PER PROPERTY PER DAY. The walkway and the deck are the same
  -- trip out; two dispatches would be two minimums for one visit.
  select j.id into v_dupe
    from public.ns_jobs j
   where j.id <> p_job_id
     and j.property_id is not null
     and j.property_id = v_job.property_id
     and j.scheduled_for is not null
     and (j.scheduled_for at time zone v_tz)::date = v_day
     and coalesce(j.status, '') not in ('cancelled', 'completed', 'lost', 'declined')
     and exists (select 1 from public.job_measurements jm
                   join public.services s on s.id = jm.service_id
                  where jm.job_id = j.id and s.key like 'winter%')
   limit 1;
  if v_dupe is not null then
    raise exception
      'That property already has a winter visit on % (job %). Walkway and '
      'deck work is one visit, not two: add the service to that job '
      'instead.', v_day, v_dupe
      using errcode = 'unique_violation';
  end if;

  -- Reused, not reimplemented. The suffixed keys keep each leg separately
  -- replayable while the whole call stays one logical operation.
  v_sched := public.reschedule_job(
    p_client_operation_id || ':schedule', p_job_id, p_scheduled_for, null,
    'Winter visit: ' || btrim(p_reason));
  v_assign := case when p_location_code is null then null else
    public.assign_job_to_vehicle(
      p_client_operation_id || ':assign', p_job_id, p_location_code, null,
      'Winter visit: ' || btrim(p_reason)) end;

  return jsonb_build_object(
    'job_id',        p_job_id,
    'work_date',     v_day,
    'reason',        btrim(p_reason),
    'scheduled',     v_sched,
    'assigned',      v_assign,
    'automation',    public.ns_winter_automation_state(),
    'created_job',   false,
    'created_minimum', false);
end
$$;

/* ===================================================================== */
/* 4. grants and assertions                                              */
/* ===================================================================== */

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.ns_vehicle_day_equipment(uuid,date)',
    'public.dispatch_equipment_conflicts(date)',
    'public.ns_winter_automation_state()',
    'public.ns_winter_dispatch_candidates(date)',
    'public.dispatch_winter_visit(text,uuid,text,timestamptz,text)'
  ]
  loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('grant execute on function %s to authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;

  execute 'revoke all on public.ns_dispatch_seasonal_work from public';
  execute 'revoke all on public.ns_dispatch_seasonal_work from anon';
  execute 'grant select on public.ns_dispatch_seasonal_work to authenticated';
  execute 'grant all on public.ns_dispatch_seasonal_work to service_role';
end
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.dispatch_equipment_conflicts(date)',
    'public.ns_winter_dispatch_candidates(date)',
    'public.dispatch_winter_visit(text,uuid,text,timestamptz,text)'
  ]
  loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception 'anon can execute %, which it must not', f;
    end if;
  end loop;

  -- The five seasonal acts must still be five. If a later batch bundles
  -- them, this is where it gets noticed.
  foreach f in array array[
    'install_seasonal_set', 'recover_seasonal_set', 'inspect_seasonal_set',
    'release_seasonal_set', 'record_set_renewal']
  loop
    if not exists (
      select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = f) then
      raise exception
        'public.% is missing, so the seasonal stages are no longer five '
        'separate acts', f;
    end if;
  end loop;
end
$$;
