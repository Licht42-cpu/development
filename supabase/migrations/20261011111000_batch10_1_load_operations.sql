-- Batch 10.1: the daily load operations.
--
--   build_load_plan           derive the authoritative plan for a car and day
--   set_manual_keep           hold something back, across regenerations
--   authorise_load_exception  owner permission to depart from the plan
--   confirm_load_plan         the crew says the van now matches; stock moves
--   reconcile_day_end         counts at the end of the day, with reasons
--   ns_next_day_suggestions   read-only: what to buy or top up
--
-- WHAT CONFIRMING DOES, AND WHAT IT DOES NOT. Confirming is the only call
-- here that moves stock, and it moves it by posting ordinary Batch 8.1
-- transfers -- Base to the vehicle for an Add, vehicle to Base for a
-- Return. It does not invent a movement type, and it cannot be mistaken for
-- one: "confirming a recommendation must not masquerade as a physical
-- transfer" is satisfied by making it an actual transfer, logged as such.
--
-- WHY A FINGERPRINT AS WELL AS A REVISION. The revision catches "somebody
-- regenerated the plan". The fingerprint catches "the schedule moved and
-- nobody has regenerated it yet", which is the more dangerous case: the
-- revision is still 3, the plan still looks current, and the job it was
-- built for was cancelled an hour ago. Confirmation checks both.
--
-- NOT APPLIED. Written and tested against a disposable PostgreSQL only.

/* ===================================================================== */
/* helpers                                                               */
/* ===================================================================== */

/** The jobs a vehicle is working on a given date.
 *
 *  An explicit assignment always wins. With exactly ONE active vehicle, an
 *  unassigned job belongs to it -- that is the business today, and treating
 *  every job as unknown would make every plan empty. With two, an
 *  unassigned job belongs to NEITHER plan and is reported as needing
 *  review: guessing which car a job is on is how a crew arrives without a
 *  washer. */
create or replace function public.ns_vehicle_day_jobs(
  p_location_id uuid, p_work_date date)
returns table (job_id uuid, assigned boolean)
language sql
stable
set search_path = public, pg_temp
as $$
  with vehicles as (
    select count(*) as n from public.ns_stock_locations
     where kind = 'vehicle' and active
  ),
  day_jobs as (
    select j.id, a.location_id as assigned_to
      from public.ns_jobs j
      left join public.ns_job_vehicle_assignments a on a.job_id = j.id
     where j.scheduled_for is not null
       and (j.scheduled_for at time zone 'UTC')::date = p_work_date
       and coalesce(j.status, '') not in ('cancelled', 'completed')
  )
  select d.id,
         d.assigned_to is not null
    from day_jobs d, vehicles v
   where d.assigned_to = p_location_id
      or (d.assigned_to is null and v.n = 1
          and exists (select 1 from public.ns_stock_locations
                       where id = p_location_id and kind = 'vehicle' and active))
$$;

/** Jobs scheduled that day which belong to no vehicle, when more than one
 *  vehicle exists. Reported, never guessed at. */
create or replace function public.ns_unassigned_day_jobs(p_work_date date)
returns setof uuid
language sql
stable
set search_path = public, pg_temp
as $$
  select j.id
    from public.ns_jobs j
    left join public.ns_job_vehicle_assignments a on a.job_id = j.id
   where j.scheduled_for is not null
     and (j.scheduled_for at time zone 'UTC')::date = p_work_date
     and coalesce(j.status, '') not in ('cancelled', 'completed')
     and a.job_id is null
     and (select count(*) from public.ns_stock_locations
           where kind = 'vehicle' and active) > 1
$$;

/** Everything a plan was derived from, as one string. Any change to the
 *  day's jobs, their times, their services or their measured quantities
 *  changes this, which is what makes an obsolete confirmation detectable. */
create or replace function public.ns_load_basis_fingerprint(
  p_location_id uuid, p_work_date date)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select md5(coalesce(string_agg(part, '|' order by part), 'empty'))
    from (
      select j.job_id::text || ':' || coalesce(jb.scheduled_for::text, '')
             || ':' || coalesce(jb.status, '')
             || ':' || coalesce((
                  select string_agg(jm.service_id::text || '=' || jm.quantity::text,
                                    ',' order by jm.service_id::text, jm.quantity::text)
                    from public.job_measurements jm where jm.job_id = j.job_id), '')
             as part
        from public.ns_vehicle_day_jobs(p_location_id, p_work_date) j
        join public.ns_jobs jb on jb.id = j.job_id
      union all
      select 'set:' || a.set_id::text || ':' || a.status
        from public.ns_seasonal_assignments a
        join public.ns_vehicle_day_jobs(p_location_id, p_work_date) j
          on j.job_id = a.job_id
       where a.status in ('assigned', 'installed')
    ) parts
$$;

/* ===================================================================== */
/* build_load_plan                                                       */
/* ===================================================================== */

create or replace function public.build_load_plan(
  p_client_operation_id text,
  p_location_code       text,
  p_work_date           date,
  p_note                text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_exist   public.ns_load_plans%rowtype;
  v_loc     public.ns_stock_locations%rowtype;
  v_base    uuid;
  v_plan    uuid;
  v_rev     integer;
  v_print   text;
  v_unassigned integer;
begin
  if not public.is_owner() then
    raise exception
      'Only the owner builds a load plan: it reads the whole day''s schedule '
      'and decides what every job needs.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_work_date is null then
    raise exception 'Say which day the plan is for'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_exist from public.ns_load_plans
   where client_operation_id = p_client_operation_id;
  if found then
    return public.ns_load_plan_result(v_exist.id, true);
  end if;

  select * into v_loc from public.ns_stock_locations
   where lower(btrim(code)) = lower(btrim(p_location_code)) and active;
  if not found then
    raise exception 'No active stock location with code %', p_location_code
      using errcode = 'no_data_found';
  end if;
  if v_loc.kind <> 'vehicle' then
    raise exception
      'A load plan is for a vehicle. % is the %, which is the pool a vehicle '
      'is loaded FROM.', v_loc.name, v_loc.kind
      using errcode = 'invalid_parameter_value';
  end if;

  select id into v_base from public.ns_stock_locations
   where kind = 'base' and active;
  if v_base is null then
    raise exception 'There is no active base to load from'
      using errcode = 'no_data_found';
  end if;

  v_print := public.ns_load_basis_fingerprint(v_loc.id, p_work_date);

  -- A new revision supersedes the live one. History is kept: a confirmed
  -- plan that was then superseded is the record of what the crew actually
  -- agreed to, and deleting it would erase that.
  update public.ns_load_plans
     set status = 'superseded'
   where location_id = v_loc.id and work_date = p_work_date
     and status in ('current', 'confirmed');

  select coalesce(max(revision), 0) + 1 into v_rev
    from public.ns_load_plans
   where location_id = v_loc.id and work_date = p_work_date;

  insert into public.ns_load_plans
    (location_id, work_date, revision, status, basis_fingerprint,
     generated_by, client_operation_id, note)
  values
    (v_loc.id, p_work_date, v_rev, 'current', v_print,
     auth.uid(), p_client_operation_id, p_note)
  returning id into v_plan;

  /* ---------------------------------------------------------------- */
  /* the day's work                                                     */
  /* ---------------------------------------------------------------- */

  create temporary table if not exists tmp_day_jobs (
    job_id uuid primary key) on commit drop;
  delete from tmp_day_jobs;
  insert into tmp_day_jobs select job_id from public.ns_vehicle_day_jobs(v_loc.id, p_work_date);

  select count(*) into v_unassigned from public.ns_unassigned_day_jobs(p_work_date);

  /* The services in play today. A service appears once however many stops
     need it -- that is what deduplicates a shared tool across the day. */
  create temporary table if not exists tmp_day_services (
    service_id uuid primary key) on commit drop;
  delete from tmp_day_services;
  insert into tmp_day_services
  select distinct jm.service_id
    from public.job_measurements jm
    join tmp_day_jobs d on d.job_id = jm.job_id;

  /* ---------------------------------------------------------------- */
  /* EQUIPMENT -- one decision for the whole day                        */
  /* ---------------------------------------------------------------- */

  -- Required: anything a service in play asks for, plus every always_keep
  -- rule (those stay aboard whatever the day looks like), plus job-level
  -- 'require' overrides, minus job-level 'exclude' overrides.
  create temporary table if not exists tmp_equipment (
    material_id uuid primary key,
    always_keep boolean,
    removable   boolean,
    reason      text,
    job_ids     uuid[]) on commit drop;
  delete from tmp_equipment;

  insert into tmp_equipment (material_id, always_keep, removable, reason, job_ids)
  select r.material_id,
         bool_or(r.always_keep),
         bool_and(r.removable),
         'Needed for ' || string_agg(distinct s.name, ', '),
         coalesce(array_agg(distinct d.job_id) filter (where d.job_id is not null), '{}')
    from public.ns_service_load_rules r
    join public.services s on s.id = r.service_id
    left join public.job_measurements jm on jm.service_id = r.service_id
    left join tmp_day_jobs d on d.job_id = jm.job_id
   where r.rule_kind = 'equipment'
     and (r.always_keep or r.service_id in (select service_id from tmp_day_services))
   group by r.material_id;

  insert into tmp_equipment (material_id, always_keep, removable, reason, job_ids)
  select o.material_id, false, false,
         'Job override: ' || coalesce(o.reason, 'required for this job'),
         array_agg(o.job_id)
    from public.ns_job_load_overrides o
    join tmp_day_jobs d on d.job_id = o.job_id
    join public.ns_materials m on m.id = o.material_id
   where o.action = 'require'
     and not exists (select 1 from tmp_equipment e where e.material_id = o.material_id)
   group by o.material_id, o.reason;

  delete from tmp_equipment e
   where exists (
     select 1 from public.ns_job_load_overrides o
      join tmp_day_jobs d on d.job_id = o.job_id
     where o.material_id = e.material_id and o.action = 'exclude')
     and not e.always_keep;

  -- Keep or Add, depending on whether it is already aboard.
  insert into public.ns_load_plan_lines
    (plan_id, material_id, line_kind, action, required_qty, aboard_qty,
     available_qty, damaged_qty, shortage_qty, unit, precision, data_state,
     reason, job_ids, manual_keep)
  select v_plan, e.material_id, 'equipment',
         case when coalesce(b.on_hand, 0) > 0 then 'keep' else 'add' end,
         1,
         coalesce(b.on_hand, 0),
         coalesce(src.available, 0),
         coalesce(b.damaged_on_hand, 0),
         case when coalesce(b.on_hand, 0) > 0 then 0
              when coalesce(src.available, 0) > 0 then 0
              else 1 end,
         m.unit,
         'exact',
         case when coalesce(b.on_hand, 0) <= 0 and coalesce(src.available, 0) <= 0
              then 'needs_review' else 'complete' end,
         e.reason
           || case when e.always_keep then ' (always keep)' else '' end,
         e.job_ids,
         exists (select 1 from public.ns_load_manual_keeps k
                  where k.location_id = v_loc.id and k.work_date = p_work_date
                    and k.material_id = e.material_id)
    from tmp_equipment e
    join public.ns_materials m on m.id = e.material_id
    left join public.ns_material_stock_by_location b
           on b.material_id = e.material_id and b.location_id = v_loc.id
    left join public.ns_material_stock_by_location src
           on src.material_id = e.material_id and src.location_id = v_base;

  /* RETURN: removable equipment that is aboard and that nothing today
     needs. This is the no-bleach-day rule, and it is deliberately narrow --
     only kit the owner marked removable, never the standard tool kit, and
     never something a manual Keep is holding. */
  insert into public.ns_load_plan_lines
    (plan_id, material_id, line_kind, action, required_qty, aboard_qty,
     unit, precision, data_state, reason, manual_keep)
  select v_plan, m.id, 'equipment',
         -- A manual Keep is honoured HERE rather than by dropping the row.
         -- Excluding kept items from this query made them vanish from the
         -- plan entirely on a rebuild, which is worse than returning them:
         -- the crew could not see the thing they had deliberately held back.
         case when k.material_id is not null then 'keep' else 'return' end,
         0, b.on_hand, m.unit, 'exact', 'complete',
         case when k.material_id is not null
              then 'Kept back on purpose: ' || coalesce(k.reason, 'manual keep')
              else 'No job today needs it' end,
         k.material_id is not null
    from public.ns_materials m
    join public.ns_material_stock_by_location b
      on b.material_id = m.id and b.location_id = v_loc.id
    left join public.ns_load_manual_keeps k
      on k.location_id = v_loc.id and k.work_date = p_work_date
     and k.material_id = m.id
   where b.on_hand > 0
     and exists (select 1 from public.ns_service_load_rules r
                  where r.material_id = m.id and r.rule_kind = 'equipment'
                    and r.removable)
     and not exists (select 1 from tmp_equipment e where e.material_id = m.id)
     and not exists (select 1 from public.ns_load_plan_lines pl
                      where pl.plan_id = v_plan and pl.material_id = m.id);

  /* A manual Keep on something that would otherwise be returned: the line
     stays, but as a Keep with the operator's reason. */
  update public.ns_load_plan_lines pl
     set action = 'keep', manual_keep = true,
         reason = 'Kept back on purpose: ' || coalesce(k.reason, 'manual keep')
    from public.ns_load_manual_keeps k
   where pl.plan_id = v_plan
     and k.location_id = v_loc.id and k.work_date = p_work_date
     and k.material_id = pl.material_id
     and pl.action = 'return';

  /* ---------------------------------------------------------------- */
  /* CONSUMABLES -- summed across the day                               */
  /* ---------------------------------------------------------------- */

  insert into public.ns_load_plan_lines
    (plan_id, material_id, line_kind, action, required_qty, aboard_qty,
     reserved_qty, available_qty, damaged_qty, shortage_qty, unit, precision,
     level_state, data_state, reason, job_ids, manual_keep)
  select v_plan, x.material_id, 'consumable',
         case when x.is_level then 'keep'
              when x.unknown then 'add'   -- needed; how much is unknown
              when x.required <= coalesce(b.on_hand, 0) then 'keep'
              else 'add' end,
         -- NULL, not 0, when no allowance was ever recorded. Summing two
         -- nulls with coalesce gives zero, and zero is a claim: "this job
         -- needs none of it". The honest answer is that nobody knows, and a
         -- screen can only say so if the backend does not decide for it.
         case when x.is_level or x.unknown then null else x.required end,
         case when x.is_level then null else coalesce(b.on_hand, 0) end,
         case when x.is_level then null else coalesce(b.reserved, 0) end,
         case when x.is_level then null else coalesce(src.available, 0) end,
         case when x.is_level then null else coalesce(b.damaged_on_hand, 0) end,
         -- A shortage against an unknown requirement is not calculable, and
         -- reporting 0 would read as "no shortage".
         case when x.is_level or x.unknown then null
              else greatest(x.required - coalesce(b.on_hand, 0)
                            - coalesce(src.available, 0), 0) end,
         case when x.is_level then null else m.unit end,
         case when x.provisional or x.unknown then 'estimated' else 'exact' end,
         case when x.is_level then coalesce(lv.state, 'empty') else null end,
         case when x.unknown or x.provisional or x.is_level and lv.state is null
              then 'needs_review' else 'complete' end,
         x.reason
           || case when x.unknown then ' — no allowance recorded, so the amount is unknown'
                   when x.provisional then ' — allowance not reviewed yet'
                   else '' end,
         x.job_ids,
         false
    from (
      select r.material_id,
             (m2.tracking_mode = 'level')                    as is_level,
             bool_or(r.allowance_state = 'provisional')      as provisional,
             bool_and(r.quantity_fixed is null
                      and r.quantity_per_unit is null)       as unknown,
             coalesce(sum(coalesce(r.quantity_fixed, 0)
                          + coalesce(r.quantity_per_unit, 0)
                            * coalesce(jm.quantity, 0)), 0)  as required,
             'For ' || string_agg(distinct s.name, ', ')     as reason,
             coalesce(array_agg(distinct jm.job_id)
                      filter (where jm.job_id is not null), '{}') as job_ids
        from public.ns_service_load_rules r
        join public.services s on s.id = r.service_id
        join public.ns_materials m2 on m2.id = r.material_id
        join public.job_measurements jm on jm.service_id = r.service_id
        join tmp_day_jobs d on d.job_id = jm.job_id
       where r.rule_kind = 'consumable'
       group by r.material_id, m2.tracking_mode
    ) x
    join public.ns_materials m on m.id = x.material_id
    left join public.ns_material_stock_by_location b
           on b.material_id = x.material_id and b.location_id = v_loc.id
    left join public.ns_material_stock_by_location src
           on src.material_id = x.material_id and src.location_id = v_base
    left join public.ns_material_levels lv
           on lv.material_id = x.material_id and lv.location_id = v_loc.id
   where not exists (select 1 from public.ns_load_plan_lines pl
                      where pl.plan_id = v_plan and pl.material_id = x.material_id);

  /* ---------------------------------------------------------------- */
  /* BASELINE TOP-UP                                                    */
  /* ---------------------------------------------------------------- */

  insert into public.ns_load_plan_lines
    (plan_id, material_id, line_kind, action, required_qty, aboard_qty,
     available_qty, shortage_qty, unit, precision, data_state, reason, manual_keep)
  select v_plan, vb.material_id, 'consumable', 'add',
         vb.target_qty, coalesce(b.on_hand, 0),
         coalesce(src.available, 0),
         greatest(vb.target_qty - coalesce(b.on_hand, 0)
                  - coalesce(src.available, 0), 0),
         m.unit, 'exact', 'complete',
         'Vehicle baseline top-up',
         false
    from public.ns_vehicle_baselines vb
    join public.ns_materials m on m.id = vb.material_id
    left join public.ns_material_stock_by_location b
           on b.material_id = vb.material_id and b.location_id = v_loc.id
    left join public.ns_material_stock_by_location src
           on src.material_id = vb.material_id and src.location_id = v_base
   where vb.location_id = v_loc.id
     and vb.target_qty is not null
     and coalesce(b.on_hand, 0) < vb.target_qty
     and m.tracking_mode <> 'level'
     and not exists (select 1 from public.ns_load_plan_lines pl
                      where pl.plan_id = v_plan and pl.material_id = vb.material_id);

  /* ---------------------------------------------------------------- */
  /* NAMED CHRISTMAS SETS                                               */
  /* ---------------------------------------------------------------- */

  -- A set is referenced by id and carries no quantity: it is an asset, not
  -- stock, and cannot be reserved through reserve_stock. Sets promised to
  -- today's jobs need loading; sets already installed are at the property
  -- and are listed so the crew knows they are not in the van.
  insert into public.ns_load_plan_lines
    (plan_id, rental_set_id, line_kind, action, unit, precision, data_state,
     reason, job_ids, manual_keep)
  select v_plan, a.set_id, 'seasonal_set',
         case when a.status = 'assigned' then 'add' else 'keep' end,
         null, 'exact',
         case when a.status = 'assigned' and s.status <> 'in_storage'
              then 'needs_review' else 'complete' end,
         case when a.status = 'assigned'
              then 'Promised to this customer for ' || a.season_year
              else 'Already up at the property' end,
         array[a.job_id],
         false
    from public.ns_seasonal_assignments a
    join public.ns_rental_sets s on s.id = a.set_id
    join tmp_day_jobs d on d.job_id = a.job_id
   where a.status in ('assigned', 'installed')
     and not exists (select 1 from public.ns_load_plan_lines pl
                      where pl.plan_id = v_plan and pl.rental_set_id = a.set_id);

  if v_unassigned > 0 then
    update public.ns_load_plans
       set note = coalesce(note || ' ', '')
         || v_unassigned || ' job(s) scheduled today are not assigned to a '
         || 'vehicle, so nothing they need is on any plan.'
     where id = v_plan;
  end if;

  return public.ns_load_plan_result(v_plan, false);
end
$$;

/* ===================================================================== */
/* the plan as the contract reports it                                   */
/* ===================================================================== */

create or replace function public.ns_load_plan_result(
  p_plan_id uuid, p_replayed boolean)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'plan_id',           p.id,
    'location_id',       p.location_id,
    'location_code',     l.code,
    'work_date',         p.work_date,
    'revision',          p.revision,
    'status',            p.status,
    'basis_fingerprint', p.basis_fingerprint,
    'generated_at',      p.generated_at,
    'confirmed_at',      p.confirmed_at,
    'closed_at',         p.closed_at,
    'note',              p.note,
    'replayed',          p_replayed,
    'unassigned_jobs',   (select count(*) from public.ns_unassigned_day_jobs(p.work_date)),
    'needs_review_count', (
      select count(*) from public.ns_load_plan_lines
       where plan_id = p.id and data_state = 'needs_review'),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'line_id',       ln.id,
               'line_kind',     ln.line_kind,
               'action',        ln.action,
               'material_id',   ln.material_id,
               'material_name', m.name,
               'rental_set_id', ln.rental_set_id,
               'set_code',      s.set_code,
               'required_qty',  ln.required_qty,
               'aboard_qty',    ln.aboard_qty,
               'reserved_qty',  ln.reserved_qty,
               'available_qty', ln.available_qty,
               'damaged_qty',   ln.damaged_qty,
               'shortage_qty',  ln.shortage_qty,
               'unit',          ln.unit,
               'precision',     ln.precision,
               'level_state',   ln.level_state,
               'data_state',    ln.data_state,
               'reason',        ln.reason,
               'job_ids',       to_jsonb(ln.job_ids),
               'manual_keep',   ln.manual_keep,
               'confirmed_operation', ln.confirmed_operation)
             order by ln.action, coalesce(m.name, s.set_code))
        from public.ns_load_plan_lines ln
        left join public.ns_materials m on m.id = ln.material_id
        left join public.ns_rental_sets s on s.id = ln.rental_set_id
       where ln.plan_id = p.id), '[]'::jsonb))
  from public.ns_load_plans p
  join public.ns_stock_locations l on l.id = p.location_id
  where p.id = p_plan_id
$$;

/* ===================================================================== */
/* set_manual_keep                                                       */
/* ===================================================================== */

-- Crew-level on purpose: holding a spare back is a decision made at the van
-- with the kit in hand. It survives every regeneration because it is keyed
-- by day and material, not by plan line.

create or replace function public.set_manual_keep(
  p_client_operation_id text,
  p_location_code       text,
  p_work_date           date,
  p_material_id         uuid,
  p_keep                boolean default true,
  p_reason              text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_loc uuid;
begin
  if not public.is_admin() then
    raise exception 'set_manual_keep is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  v_loc := public.ns_location_by_code(p_location_code);
  if v_loc is null then
    raise exception 'No active stock location with code %', p_location_code
      using errcode = 'no_data_found';
  end if;
  if not public.can_see_location(v_loc) then
    raise exception 'You are not assigned to that location'
      using errcode = 'insufficient_privilege';
  end if;

  if p_keep then
    insert into public.ns_load_manual_keeps
      (location_id, work_date, material_id, reason, created_by)
    values (v_loc, p_work_date, p_material_id, p_reason, auth.uid())
    on conflict (location_id, work_date, material_id) do update
       set reason = coalesce(excluded.reason, public.ns_load_manual_keeps.reason);
  else
    delete from public.ns_load_manual_keeps
     where location_id = v_loc and work_date = p_work_date
       and material_id = p_material_id;
  end if;

  -- Reflect it on the live plan immediately, so the crew sees the change
  -- without waiting for a regeneration.
  update public.ns_load_plan_lines pl
     set manual_keep = p_keep,
         action = case when p_keep and pl.action = 'return' then 'keep' else pl.action end,
         reason = case when p_keep
                       then 'Kept back on purpose: ' || coalesce(p_reason, 'manual keep')
                       else pl.reason end
    from public.ns_load_plans p
   where pl.plan_id = p.id
     and p.location_id = v_loc and p.work_date = p_work_date
     and p.status in ('current', 'confirmed')
     and pl.material_id = p_material_id;

  return jsonb_build_object(
    'location_code', p_location_code,
    'work_date',     p_work_date,
    'material_id',   p_material_id,
    'manual_keep',   p_keep,
    'reason',        p_reason);
end
$$;

/* ===================================================================== */
/* authorise_load_exception                                              */
/* ===================================================================== */

create or replace function public.authorise_load_exception(
  p_client_operation_id text,
  p_location_code       text,
  p_work_date           date,
  p_kind                text,
  p_reason              text,
  p_material_id         uuid default null,
  p_rental_set_id       uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_loc uuid;
  v_id  uuid;
  v_ex  public.ns_load_exceptions%rowtype;
begin
  if not public.is_owner() then
    raise exception
      'Only the owner authorises a departure from the plan. That is what '
      '"owner-authorised" means.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'An exception without a reason is not an exception'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_kind not in ('skip_required', 'carry_extra') then
    raise exception 'kind must be skip_required or carry_extra'
      using errcode = 'invalid_parameter_value';
  end if;
  if (p_material_id is not null) = (p_rental_set_id is not null) then
    raise exception 'Name either a material or a set, not both and not neither'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_ex from public.ns_load_exceptions
   where client_operation_id = p_client_operation_id;
  if found then
    return jsonb_build_object('exception_id', v_ex.id, 'replayed', true,
                              'kind', v_ex.kind, 'reason', v_ex.reason);
  end if;

  v_loc := public.ns_location_by_code(p_location_code);
  if v_loc is null then
    raise exception 'No active stock location with code %', p_location_code
      using errcode = 'no_data_found';
  end if;

  insert into public.ns_load_exceptions
    (location_id, work_date, material_id, rental_set_id, kind, reason,
     authorised_by, client_operation_id)
  values
    (v_loc, p_work_date, p_material_id, p_rental_set_id, p_kind, p_reason,
     auth.uid(), p_client_operation_id)
  returning id into v_id;

  update public.ns_load_plan_lines pl
     set exception_id = v_id
    from public.ns_load_plans p
   where pl.plan_id = p.id
     and p.location_id = v_loc and p.work_date = p_work_date
     and p.status in ('current', 'confirmed')
     and (pl.material_id = p_material_id or pl.rental_set_id = p_rental_set_id);

  return jsonb_build_object('exception_id', v_id, 'replayed', false,
                            'kind', p_kind, 'reason', p_reason);
end
$$;

/* ===================================================================== */
/* confirm_load_plan                                                     */
/* ===================================================================== */

-- The crew says the van now matches the plan. THIS is where stock moves,
-- and it moves as ordinary transfers so that nothing in the ledger has to
-- know what a load plan is.
--
-- A STALE CONFIRMATION IS REFUSED WITH THE FACTS. The caller sends the
-- revision and fingerprint it was looking at. If either has moved, the
-- refusal carries the current values so the screen can say "the schedule
-- changed, here is the new plan" rather than a bare error.

create or replace function public.confirm_load_plan(
  p_client_operation_id text,
  p_plan_id             uuid,
  p_expected_revision   integer,
  p_expected_fingerprint text default null,
  p_note                text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan  public.ns_load_plans%rowtype;
  v_live  text;
  v_base  uuid;
  v_code  text;
  v_vcode text;
  v_line  record;
  v_res   jsonb;
  v_n     integer := 0;
begin
  if not public.is_admin() then
    raise exception 'confirm_load_plan is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_plan from public.ns_load_plans where id = p_plan_id for update;
  if not found then
    raise exception 'No such load plan %', p_plan_id using errcode = 'no_data_found';
  end if;
  if not public.can_see_location(v_plan.location_id) then
    raise exception 'That plan is for a vehicle you do not work from'
      using errcode = 'insufficient_privilege';
  end if;

  if v_plan.status in ('confirmed', 'closed') then
    return public.ns_load_plan_result(v_plan.id, true);
  end if;
  if v_plan.status <> 'current' then
    raise exception
      'Plan revision % is %, so a newer one exists. Reload before confirming.',
      v_plan.revision, v_plan.status
      using errcode = 'check_violation';
  end if;

  if p_expected_revision is not null and p_expected_revision <> v_plan.revision then
    raise exception
      'You confirmed revision % but the current one is %. Reload the plan.',
      p_expected_revision, v_plan.revision
      using errcode = 'check_violation';
  end if;

  -- The harder check: the schedule may have moved without anybody
  -- regenerating, in which case the revision still matches and the plan is
  -- still wrong.
  v_live := public.ns_load_basis_fingerprint(v_plan.location_id, v_plan.work_date);
  if v_live <> v_plan.basis_fingerprint then
    raise exception
      'The day''s work changed after this plan was built, so confirming it '
      'would load for a schedule that no longer exists. Rebuild the plan.'
      using errcode = 'check_violation';
  end if;
  if p_expected_fingerprint is not null
     and p_expected_fingerprint <> v_plan.basis_fingerprint then
    raise exception
      'The plan you were looking at is not the current one. Reload it.'
      using errcode = 'check_violation';
  end if;

  select id, code into v_base, v_code from public.ns_stock_locations
   where kind = 'base' and active;
  select code into v_vcode from public.ns_stock_locations where id = v_plan.location_id;

  /* Each line's physical move is its own transfer, under a suffixed key, so
     a retried confirmation replays each leg instead of moving stock twice.
     Equipment and consumables only: a seasonal set is an asset the crew
     carries, not stock that moves between balances, and a level-tracked
     supply has no quantity to transfer. */
  for v_line in
    select pl.* from public.ns_load_plan_lines pl
      join public.ns_materials m on m.id = pl.material_id
     where pl.plan_id = p_plan_id
       and pl.action in ('add', 'return')
       and pl.material_id is not null
       and pl.level_state is null
       and pl.confirmed_operation is null
       and m.tracking_mode <> 'level'
     order by pl.id
  loop
    declare
      v_move numeric;
      v_from text;
      v_to   text;
    begin
      if v_line.action = 'add' then
        v_move := greatest(coalesce(v_line.required_qty, 0)
                           - coalesce(v_line.aboard_qty, 0), 0);
        v_from := v_code; v_to := v_vcode;
      else
        v_move := coalesce(v_line.aboard_qty, 0);
        v_from := v_vcode; v_to := v_code;
      end if;
      if v_move <= 0 then continue; end if;

      v_res := public.post_stock_transfer(
        p_client_operation_id || ':' || v_line.id::text,
        v_line.material_id,
        v_move,
        v_from,
        v_to,
        true,
        'Load plan ' || v_plan.work_date || ' rev ' || v_plan.revision,
        -- p_job_id, and a load transfer belongs to the DAY, not to one job:
        -- the whole point of planning across the day is that a shared tool
        -- is not attributed to whichever stop happened to need it first.
        null);

      update public.ns_load_plan_lines
         set confirmed_operation = (v_res ->> 'operation_id')::uuid,
             confirmed_at = now()
       where id = v_line.id;
      v_n := v_n + 1;
    end;
  end loop;

  update public.ns_load_plans
     set status = 'confirmed', confirmed_at = now(), confirmed_by = auth.uid(),
         note = coalesce(p_note, note)
   where id = p_plan_id;

  return public.ns_load_plan_result(p_plan_id, false) ||
         jsonb_build_object('transfers_posted', v_n);
end
$$;

/* ===================================================================== */
/* reconcile_day_end                                                     */
/* ===================================================================== */

-- Counts at the end of the day. A variance posts an ordinary correction so
-- the ledger agrees with the van; the REASON is what makes it explainable
-- later, which is why a non-zero variance without one is refused.
--
-- "A schedule change revises recommendations, not physical balances" has
-- its counterpart here: a reconciliation changes physical balances and
-- never touches a recommendation.

create or replace function public.reconcile_day_end(
  p_client_operation_id text,
  p_location_code       text,
  p_work_date           date,
  p_lines               jsonb,
  p_note                text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_loc   uuid;
  v_rec   uuid;
  v_exist public.ns_day_reconciliations%rowtype;
  v_plan  uuid;
  v_item  jsonb;
  v_mat   uuid;
  v_count numeric;
  v_level text;
  v_prec  text;
  v_why   text;
  v_have  numeric;
  v_var   numeric;
  v_n     integer := 0;
begin
  if not public.is_admin() then
    raise exception 'reconcile_day_end is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_exist from public.ns_day_reconciliations
   where client_operation_id = p_client_operation_id;
  if found then
    return public.ns_reconciliation_result(v_exist.id, true);
  end if;

  v_loc := public.ns_location_by_code(p_location_code);
  if v_loc is null then
    raise exception 'No active stock location with code %', p_location_code
      using errcode = 'no_data_found';
  end if;
  if not public.can_see_location(v_loc) then
    raise exception 'You are not assigned to that location'
      using errcode = 'insufficient_privilege';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Send the counts as an array'
      using errcode = 'invalid_parameter_value';
  end if;

  select id into v_plan from public.ns_load_plans
   where location_id = v_loc and work_date = p_work_date
     and status in ('current', 'confirmed');

  insert into public.ns_day_reconciliations
    (location_id, work_date, plan_id, client_operation_id, closed_by, note)
  values (v_loc, p_work_date, v_plan, p_client_operation_id, auth.uid(), p_note)
  returning id into v_rec;

  for v_item in select * from jsonb_array_elements(p_lines)
  loop
    v_mat   := (v_item ->> 'material_id')::uuid;
    v_count := nullif(v_item ->> 'counted_qty', '')::numeric;
    v_level := nullif(v_item ->> 'level_state', '');
    v_prec  := coalesce(nullif(v_item ->> 'precision', ''), 'exact');
    v_why   := nullif(v_item ->> 'variance_reason', '');

    if v_mat is null then
      raise exception 'Every count line names a material'
        using errcode = 'invalid_parameter_value';
    end if;
    if v_prec not in ('exact', 'estimated') then
      raise exception 'precision must be exact or estimated'
        using errcode = 'invalid_parameter_value';
    end if;

    /* A LEVEL SUPPLY IS COUNTED AS A LEVEL. Recording a number for it
       would be the invented quantity the roadmap forbids, so it updates
       ns_material_levels and posts no movement at all. */
    if v_level is not null then
      if v_level not in ('empty', 'low', 'enough') then
        raise exception 'A level is empty, low or enough'
          using errcode = 'invalid_parameter_value';
      end if;
      insert into public.ns_day_reconciliation_lines
        (reconciliation_id, material_id, level_state, precision, note)
      values (v_rec, v_mat, v_level, 'estimated', v_item ->> 'note');
      -- A level REPLACES the previous observation rather than summing, so
      -- this is an upsert and not a movement. There is no set_material_level
      -- RPC in Batch 8.1 -- the admin screen upserts the row directly -- so
      -- the same write is done here inside the reconciliation's transaction.
      insert into public.ns_material_levels
        (material_id, location_id, state, checked_at, checked_by, note)
      values (v_mat, v_loc, v_level, now(), auth.uid(), v_item ->> 'note')
      on conflict (material_id, location_id) do update
         set state = excluded.state, checked_at = excluded.checked_at,
             checked_by = excluded.checked_by, note = excluded.note;
      v_n := v_n + 1;
      continue;
    end if;

    if v_count is null then
      raise exception 'A count line needs either a counted quantity or a level'
        using errcode = 'invalid_parameter_value';
    end if;

    select coalesce(on_hand, 0) into v_have
      from public.ns_material_stock_by_location
     where material_id = v_mat and location_id = v_loc;
    v_have := coalesce(v_have, 0);
    v_var  := v_count - v_have;

    -- Checked BEFORE the insert: the table's own CHECK would also refuse
    -- this, but it would refuse it with a constraint name. An operator
    -- counting stock in a van deserves the sentence.
    if v_var <> 0 and v_why is null then
      raise exception
        'The count for that material differs from the ledger by %. Say why '
        '(damaged, lost, miscounted, used_more, used_less, other) -- an '
        'unexplained correction is the row nobody can account for later.',
        v_var
        using errcode = 'check_violation';
    end if;

    insert into public.ns_day_reconciliation_lines
      (reconciliation_id, material_id, expected_qty, counted_qty, variance_qty,
       precision, variance_reason, note)
    values (v_rec, v_mat, v_have, v_count, v_var, v_prec, v_why,
            v_item ->> 'note');

    if v_var <> 0 then
      perform public.post_stock_movement(
        p_client_operation_id || ':' || v_mat::text,
        v_mat,
        p_location_code,
        v_var,
        'adjustment',
        'End of day ' || p_work_date || ': ' || v_why,
        null, null, null,
        case when v_why = 'damaged' then 'damaged' else 'usable' end,
        v_prec);
    end if;
    v_n := v_n + 1;
  end loop;

  if v_plan is not null then
    update public.ns_load_plans
       set status = 'closed', closed_at = now(), closed_by = auth.uid()
     where id = v_plan;
  end if;

  return public.ns_reconciliation_result(v_rec, false)
         || jsonb_build_object('lines_recorded', v_n);
end
$$;

create or replace function public.ns_reconciliation_result(
  p_id uuid, p_replayed boolean)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'reconciliation_id', r.id,
    'location_id',       r.location_id,
    'location_code',     l.code,
    'work_date',         r.work_date,
    'plan_id',           r.plan_id,
    'closed_at',         r.closed_at,
    'replayed',          p_replayed,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'material_id',     x.material_id,
               'material_name',   m.name,
               'expected_qty',    x.expected_qty,
               'counted_qty',     x.counted_qty,
               'variance_qty',    x.variance_qty,
               'precision',       x.precision,
               'level_state',     x.level_state,
               'variance_reason', x.variance_reason)
             order by m.name)
        from public.ns_day_reconciliation_lines x
        join public.ns_materials m on m.id = x.material_id
       where x.reconciliation_id = r.id), '[]'::jsonb))
  from public.ns_day_reconciliations r
  join public.ns_stock_locations l on l.id = r.location_id
  where r.id = p_id
$$;

/* ===================================================================== */
/* next-day suggestions -- read-only                                     */
/* ===================================================================== */

/** What to buy or top up. Shortages from the live plan, plus baseline
 *  shortfalls that Base cannot cover. Suggestions only: nothing here
 *  reserves, orders or moves anything. */
create or replace function public.ns_next_day_suggestions(
  p_location_code text, p_work_date date)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with loc as (
    select id, code from public.ns_stock_locations
     where lower(btrim(code)) = lower(btrim(p_location_code)) and active
  ),
  plan as (
    select p.id from public.ns_load_plans p, loc
     where p.location_id = loc.id and p.work_date = p_work_date
       and p.status in ('current', 'confirmed')
  )
  select jsonb_build_object(
    'location_code', (select code from loc),
    'work_date',     p_work_date,
    'note', 'Suggestions only. Nothing here reserves, orders or moves stock.',
    'shortages', coalesce((
      select jsonb_agg(jsonb_build_object(
               'material_id',  ln.material_id,
               'material_name', m.name,
               'required_qty', ln.required_qty,
               'aboard_qty',   ln.aboard_qty,
               'available_qty', ln.available_qty,
               'shortage_qty', ln.shortage_qty,
               'unit',         ln.unit,
               'data_state',   ln.data_state,
               'reason',       ln.reason)
             order by m.name)
        from public.ns_load_plan_lines ln
        join public.ns_materials m on m.id = ln.material_id
       where ln.plan_id = (select id from plan)
         and coalesce(ln.shortage_qty, 0) > 0), '[]'::jsonb),
    'baseline_gaps', coalesce((
      select jsonb_agg(jsonb_build_object(
               'material_id',   vb.material_id,
               'material_name', m.name,
               'target_qty',    vb.target_qty,
               'aboard_qty',    coalesce(b.on_hand, 0),
               'gap_qty',       vb.target_qty - coalesce(b.on_hand, 0))
             order by m.name)
        -- No comma join with `loc` here: mixing a comma with an explicit
        -- JOIN binds the JOIN to the wrong relation, which PostgreSQL
        -- reports as "invalid reference to FROM-clause entry".
        from public.ns_vehicle_baselines vb
        join public.ns_materials m on m.id = vb.material_id
        left join public.ns_material_stock_by_location b
               on b.material_id = vb.material_id
              and b.location_id = vb.location_id
       where vb.location_id = (select id from loc)
         and vb.target_qty is not null
         and coalesce(b.on_hand, 0) < vb.target_qty), '[]'::jsonb),
    'needs_review', coalesce((
      select jsonb_agg(jsonb_build_object(
               'material_id',   ln.material_id,
               'material_name', m.name,
               'reason',        ln.reason)
             order by m.name)
        from public.ns_load_plan_lines ln
        left join public.ns_materials m on m.id = ln.material_id
       where ln.plan_id = (select id from plan)
         and ln.data_state = 'needs_review'), '[]'::jsonb))
$$;

/* ===================================================================== */
/* grants                                                                */
/* ===================================================================== */

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.ns_vehicle_day_jobs(uuid,date)',
    'public.ns_unassigned_day_jobs(date)',
    'public.ns_load_basis_fingerprint(uuid,date)',
    'public.ns_load_plan_result(uuid,boolean)',
    'public.ns_reconciliation_result(uuid,boolean)',
    'public.build_load_plan(text,text,date,text)',
    'public.set_manual_keep(text,text,date,uuid,boolean,text)',
    'public.authorise_load_exception(text,text,date,text,text,uuid,uuid)',
    'public.confirm_load_plan(text,uuid,integer,text,text)',
    'public.reconcile_day_end(text,text,date,jsonb,text)',
    'public.ns_next_day_suggestions(text,date)'
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
    'public.build_load_plan(text,text,date,text)',
    'public.set_manual_keep(text,text,date,uuid,boolean,text)',
    'public.authorise_load_exception(text,text,date,text,text,uuid,uuid)',
    'public.confirm_load_plan(text,uuid,integer,text,text)',
    'public.reconcile_day_end(text,text,date,jsonb,text)'
  ] loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception
        'anon still holds EXECUTE on % after an explicit revoke from both anon '
        'and PUBLIC, so it is INHERITED from a role anon is a member of. '
        'Inspect pg_auth_members for anon and revoke there.', f
        using errcode = 'insufficient_privilege';
    end if;
  end loop;

  if has_table_privilege('authenticated', 'public.ns_load_plans', 'INSERT')
     or has_table_privilege('authenticated', 'public.ns_load_plan_lines', 'UPDATE') then
    raise exception
      'authenticated can still write load plans directly, which bypasses the '
      'revision and fingerprint checks that stop an obsolete confirmation.'
      using errcode = 'insufficient_privilege';
  end if;
end
$$;

comment on function public.confirm_load_plan(text,uuid,integer,text,text) is
  'The only call here that moves stock, and it moves it as ordinary '
  'transfers. Refuses a stale revision OR a changed schedule, so an '
  'obsolete load list can never be silently applied.';
