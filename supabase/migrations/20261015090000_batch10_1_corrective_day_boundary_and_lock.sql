-- ===========================================================================
-- Batch 10.1 corrective, round two: the operating day and the recommendation
-- lock.
--
-- WHY A SECOND FILE. 20261014090000 is pushed. Migrations are applied once,
-- in filename order, so a correction to it goes AFTER it rather than inside
-- it. This file assumes everything that one created.
--
-- It closes the two tails of the review that the first round documented but
-- did not implement:
--
--   FINDING 1, "state the work-date timezone". It was not stated, and the
--   code had an answer nobody had chosen: ns_vehicle_day_jobs bucketed the
--   day as `(scheduled_for at time zone 'UTC')::date`. The field console's
--   existing visit read (api.js listTodaysVisits) bounds the day at the
--   DEVICE's local midnight. West of Greenwich those two disagree for every
--   late-afternoon job: a 6pm visit in a UTC-7 zone is tomorrow in UTC, so
--   it shows on the crew's schedule for today and is absent from today's
--   load plan. The van is loaded without that job's materials and nothing
--   anywhere says why.
--
--   The timezone itself is the OWNER's to choose and is not invented here.
--   It is read from app_settings -> 'operations' ->> 'work_day_timezone'.
--   While it is unset the bounds stay exactly what they are today (UTC
--   midnight to UTC midnight) so nothing changes silently, and the read
--   envelope reports `work_day_timezone_state: 'unconfigured'` so a screen
--   can say that evening work may fall on the next day's plan until it is
--   set. Unknown is reported, not defaulted.
--
--   FINDINGS 2 AND 4, "confirmation must not accept an unseen recommendation
--   change". Round one made Manual Keep reversible and exceptions effective.
--   Both change what the plan RECOMMENDS without touching the plan's
--   revision or its basis fingerprint -- the basis is the day's schedule,
--   and the schedule did not move. So: crew reads the plan ("return the
--   bleach"), the owner authorises a skip or the other crew member clears a
--   keep, crew confirms the screen it is still looking at, and the
--   confirmation transfers a set of lines nobody agreed to.
--
--   ns_load_plans.lines_fingerprint is maintained by a trigger over the
--   lines' derived facts, returned everywhere the plan is returned, and
--   compared by confirm_load_plan, which now REQUIRES both the revision and
--   the lines fingerprint the caller was shown. A confirmation that cannot
--   say what it saw cannot be checked.
--
-- NOT APPLIED ANYWHERE. Written to disk, rehearsed on a disposable local
-- database with a fail-closed production guard.
-- ===========================================================================

/* ===================================================================== */
/* 1. the operating day                                                   */
/* ===================================================================== */

-- The owner's operating timezone, or NULL when nobody has set one.
--
-- SECURITY DEFINER because app_settings may be owner-only and every caller
-- of a load plan needs the day's boundary. It returns one IANA zone name
-- and nothing else, so there is no setting content to leak.
create or replace function public.ns_work_day_timezone()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_tz text;
begin
  -- The repository has no base schema, so app_settings is not guaranteed to
  -- exist in every database this file is rehearsed against.
  if to_regclass('public.app_settings') is null then
    return null;
  end if;

  begin
    execute $q$
      select nullif(btrim(coalesce(value::jsonb ->> 'work_day_timezone', '')), '')
        from public.app_settings where key = 'operations' limit 1
    $q$ into v_tz;
  exception when others then
    -- A malformed setting is an unset one. It must not take down every
    -- plan read, and it must not be guessed at either.
    return null;
  end;

  if v_tz is null then
    return null;
  end if;
  -- A zone name PostgreSQL does not know is not a zone. Treated as unset
  -- rather than raising, so one bad character in a settings row cannot
  -- stop the crew seeing the day.
  if not exists (select 1 from pg_timezone_names where name = v_tz) then
    return null;
  end if;
  return v_tz;
end
$$;

/** The half-open instant range a work date covers, and whether the zone it
 *  used was configured or fallen back to UTC.
 *
 *  `ends_at` is EXCLUSIVE. A job at exactly midnight belongs to the day
 *  that starts then, which is the only reading under which two consecutive
 *  days neither overlap nor drop an instant between them. */
create or replace function public.ns_work_day_bounds(p_work_date date)
returns table (starts_at timestamptz, ends_at timestamptz,
               zone text, zone_state text)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_tz text := public.ns_work_day_timezone();
begin
  if v_tz is null then
    return query select
      (p_work_date::timestamp) at time zone 'UTC',
      ((p_work_date + 1)::timestamp) at time zone 'UTC',
      null::text,
      'unconfigured'::text;
  else
    return query select
      (p_work_date::timestamp) at time zone v_tz,
      ((p_work_date + 1)::timestamp) at time zone v_tz,
      v_tz,
      'configured'::text;
  end if;
end
$$;

-- Both day-membership functions now ask ns_work_day_bounds instead of
-- carrying their own copy of a timezone decision. Bodies otherwise
-- unchanged from 20261011111000, including the one-vehicle rule.
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
      cross join public.ns_work_day_bounds(p_work_date) b
     where j.scheduled_for is not null
       and j.scheduled_for >= b.starts_at
       and j.scheduled_for <  b.ends_at
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

create or replace function public.ns_unassigned_day_jobs(p_work_date date)
returns setof uuid
language sql
stable
set search_path = public, pg_temp
as $$
  select j.id
    from public.ns_jobs j
    left join public.ns_job_vehicle_assignments a on a.job_id = j.id
    cross join public.ns_work_day_bounds(p_work_date) b
   where j.scheduled_for is not null
     and j.scheduled_for >= b.starts_at
     and j.scheduled_for <  b.ends_at
     and coalesce(j.status, '') not in ('cancelled', 'completed')
     and a.job_id is null
     and (select count(*) from public.ns_stock_locations
           where kind = 'vehicle' and active) > 1
$$;

/* ===================================================================== */
/* 2. the recommendation lock                                             */
/* ===================================================================== */

alter table public.ns_load_plans
  add column if not exists lines_fingerprint text;

/** Everything about a plan's lines that changes what a crew is being asked
 *  to do, as one string.
 *
 *  WHAT IS IN IT: the item, the action, the required quantity, the level,
 *  the data_state and whether a manual keep holds it. Those are the facts a
 *  screen renders as an instruction.
 *
 *  WHAT IS DELIBERATELY OUT: `reason` and the six reporting quantities.
 *  Re-wording a reason, or a `available_qty` moving because Base received a
 *  delivery, does not change what the crew must do, and invalidating a
 *  confirmation over it would train everyone to ignore the refusal. */
create or replace function public.ns_load_lines_fingerprint(p_plan_id uuid)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select md5(coalesce(string_agg(part, '|' order by part), 'empty'))
    from (
      select coalesce(pl.material_id::text, pl.rental_set_id::text, '')
             || ':' || pl.action
             || ':' || coalesce(pl.required_qty::text, '')
             || ':' || coalesce(pl.level_state, '')
             || ':' || coalesce(pl.data_state, '')
             || ':' || case when pl.manual_keep then 'k' else '-' end as part
        from public.ns_load_plan_lines pl
       where pl.plan_id = p_plan_id) parts
$$;

-- Maintained by trigger rather than by each writer, because the writers are
-- the problem: set_manual_keep and authorise_load_exception both change
-- lines, and a fourth path added later would forget.
create or replace function public.ns_touch_load_lines_fingerprint()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan uuid;
  v_prev uuid;
begin
  -- NEW is unassigned on DELETE and OLD on INSERT; reading the wrong one
  -- raises rather than returning null.
  if tg_op = 'DELETE' then
    v_plan := old.plan_id;
  else
    v_plan := new.plan_id;
    if tg_op = 'UPDATE' and old.plan_id is distinct from new.plan_id then
      v_prev := old.plan_id;
    end if;
  end if;

  update public.ns_load_plans
     set lines_fingerprint = public.ns_load_lines_fingerprint(v_plan)
   where id = v_plan;
  if v_prev is not null then
    update public.ns_load_plans
       set lines_fingerprint = public.ns_load_lines_fingerprint(v_prev)
     where id = v_prev;
  end if;
  return null;
end
$$;

drop trigger if exists ns_load_lines_fingerprint_trg on public.ns_load_plan_lines;
create trigger ns_load_lines_fingerprint_trg
after insert or update or delete on public.ns_load_plan_lines
for each row execute function public.ns_touch_load_lines_fingerprint();

-- Existing plans get their value now, so nothing reads null.
update public.ns_load_plans p
   set lines_fingerprint = public.ns_load_lines_fingerprint(p.id)
 where p.lines_fingerprint is null;

/* ===================================================================== */
/* 3. the read shapes carry both new facts                                */
/* ===================================================================== */

-- Unchanged from 20261014090000 except for `lines_fingerprint`.
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
    -- NEW: what the lines currently say. The pair (revision,
    -- lines_fingerprint) is what a confirmation has to quote back.
    'lines_fingerprint', coalesce(p.lines_fingerprint,
                                  public.ns_load_lines_fingerprint(p.id)),
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
               'exception_id',    ln.exception_id,
               'pre_keep_action', ln.pre_keep_action,
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

-- Unchanged from 20261014090000 except for the two timezone fields.
create or replace function public.get_load_plan(
  p_location_code text,
  p_work_date     date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_loc   uuid;
  v_plan  public.ns_load_plans;
  v_state text;
  v_tz    text := public.ns_work_day_timezone();
begin
  if not public.is_admin() then
    raise exception 'get_load_plan is admin-only'
      using errcode = 'insufficient_privilege';
  end if;

  v_loc := public.ns_location_by_code(p_location_code);
  if v_loc is null then
    raise exception 'No active stock location with code %', p_location_code
      using errcode = 'no_data_found';
  end if;
  if not public.can_see_location(v_loc) then
    raise exception 'That is not a vehicle you work from'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_plan from public.ns_load_plans
   where location_id = v_loc and work_date = p_work_date
     and status in ('current', 'confirmed');
  if not found then
    select * into v_plan from public.ns_load_plans
     where location_id = v_loc and work_date = p_work_date
       and status = 'closed'
     order by revision desc limit 1;
  end if;

  v_state := case when v_plan.id is null then 'none' else v_plan.status end;

  return jsonb_build_object(
    'location_id',   v_loc,
    'location_code', (select code from public.ns_stock_locations where id = v_loc),
    'location_name', (select name from public.ns_stock_locations where id = v_loc),
    'work_date',     p_work_date,

    -- WHICH DAY THIS IS, AND WHOSE DAY IT IS. `work_date` is a calendar
    -- date with no zone of its own; these two say how the backend turned it
    -- into a range of instants, so a screen is never guessing whether an
    -- evening job counts.
    'work_day_timezone',       v_tz,
    'work_day_timezone_state', case when v_tz is null
                                    then 'unconfigured' else 'configured' end,

    'state',         v_state,
    'can_build',     public.is_owner(),

    'plan', case when v_plan.id is null then null else
      public.ns_load_plan_result(v_plan.id, false) end,

    'needs_review_count', coalesce((
      select count(*)::integer from public.ns_load_plan_lines ln
       where ln.plan_id = v_plan.id and ln.data_state = 'needs_review'), 0),
    'unassigned_job_count', coalesce((
      select count(*)::integer
        from public.ns_vehicle_day_jobs(v_loc, p_work_date) j
       where not j.assigned), 0),

    'day', public.ns_load_day_summary(p_location_code, p_work_date)
  );
end
$$;

-- Unchanged from 20261014090000 except for the timezone fields, the
-- half-open window it now reports, and `property_id` on each visit.
--
-- WHY property_id AND NOT THE ADDRESS. The address and the access note are
-- property facts, and the authorised read for them already exists: the
-- customers/properties tables carry the single `admin_all` RLS policy, and
-- the field console reads them today through api.js listTodaysVisits
-- (`ns_jobs` embedding `properties(address_line1,city,postal_code,latitude,
-- longitude)`) and getJob (`properties(*)`, which carries `access_note`).
-- Copying those columns into a SECURITY DEFINER load function would create
-- a second surface for the same data, governed by different rules, for no
-- gain. The id is here so the field can line a visit up against that read
-- without a second jobs query.
create or replace function public.ns_load_day_summary(
  p_location_code text,
  p_work_date     date
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_loc uuid;
  v_b   record;
begin
  if not public.is_admin() then
    raise exception 'ns_load_day_summary is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  v_loc := public.ns_location_by_code(p_location_code);
  if v_loc is null then
    raise exception 'No active stock location with code %', p_location_code
      using errcode = 'no_data_found';
  end if;
  if not public.can_see_location(v_loc) then
    raise exception 'That is not a vehicle you work from'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_b from public.ns_work_day_bounds(p_work_date);

  return jsonb_build_object(
    'work_date', p_work_date,
    -- The exact window the backend treated as this date, so a client that
    -- bounds its own day (the field console bounds it at the device's local
    -- midnight) can see whether the two agree.
    'work_day_timezone',       v_b.zone,
    'work_day_timezone_state', v_b.zone_state,
    'window_starts_at',        v_b.starts_at,
    'window_ends_at',          v_b.ends_at,
    'jobs', coalesce((
      select jsonb_agg(jsonb_build_object(
               'job_id',        j.job_id,
               -- TRUE means an explicit ns_job_vehicle_assignments row.
               -- FALSE means unassigned and therefore ours by the one-crew
               -- rule, which is a different fact and is reported as one.
               'assigned',      j.assigned,
               'scheduled_for', jb.scheduled_for,
               'property_id',   jb.property_id,
               'customer_name', c.name,
               'status',        jb.status)
             order by jb.scheduled_for nulls last)
        from public.ns_vehicle_day_jobs(v_loc, p_work_date) j
        join public.ns_jobs jb on jb.id = j.job_id
        left join public.customers c on c.id = jb.customer_id), '[]'::jsonb),
    'readable_vehicles', coalesce((
      select jsonb_agg(jsonb_build_object(
               'location_id', l.id, 'code', l.code, 'name', l.name,
               'kind', l.kind)
             order by l.sort_order, l.code)
        from public.ns_stock_locations l
       where l.active and public.can_see_location(l.id)), '[]'::jsonb));
end
$$;

/* ===================================================================== */
/* 4. set_manual_keep: the receipt carries the new lock                   */
/* ===================================================================== */

-- Unchanged from 20261014090000 except that the receipt now reports the
-- plan's new `lines_fingerprint`. Clearing a keep is the move a crew makes
-- immediately before confirming, so making it quote the new value saves the
-- screen a re-read it would otherwise have to remember to do.
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
  v_loc     uuid;
  v_print   text;
  v_replay  jsonb;
  v_line    public.ns_load_plan_lines;
  v_plan    public.ns_load_plans;
  v_receipt jsonb;
begin
  if not public.is_admin() then
    raise exception 'set_manual_keep is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  v_print := public.ns_load_intent_fingerprint(jsonb_build_object(
    'location_code', lower(btrim(p_location_code)),
    'work_date',     p_work_date,
    'material_id',   p_material_id,
    'keep',          p_keep,
    'reason',        p_reason));

  v_replay := public.ns_load_replay_guard(
    p_client_operation_id, 'manual_keep', v_print);
  if v_replay is not null then return v_replay; end if;

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

  /* A MANUAL KEEP NEVER OVERWRITES AN OWNER-AUTHORISED SET-ASIDE.
     `action = 'skip'` is the owner saying "go without it" (§7a). A keep is
     the crew saying "do not take it off the van". Different decisions by
     different people, and the previous version would have replaced the
     authorisation's wording with "Kept back on purpose" on the way past.
     The durable keep is still recorded above, so it applies to the next
     build; the live line is left as the owner set it. */
  if p_keep then
    update public.ns_load_plan_lines pl
       set manual_keep = true,
           pre_keep_action = coalesce(pl.pre_keep_action, pl.action),
           pre_keep_reason = coalesce(pl.pre_keep_reason, pl.reason),
           action = case when pl.action = 'return' then 'keep' else pl.action end,
           reason = 'Kept back on purpose: ' || coalesce(p_reason, 'manual keep')
      from public.ns_load_plans p
     where pl.plan_id = p.id
       and p.location_id = v_loc and p.work_date = p_work_date
       and p.status in ('current', 'confirmed')
       and pl.material_id = p_material_id
       and pl.action <> 'skip';
  else
    /* RESTORED TO THE RECOMMENDATION, WHICH IS A WHOLE-DAY FACT.
       pre_keep_action is what build_load_plan derived from everything the
       day needs -- so an item another stop still needs comes back as
       `keep`/`add`, and only one that nothing needs comes back as `return`.
       Clearing a keep never converts a line to `return` on its own. */
    update public.ns_load_plan_lines pl
       set manual_keep = false,
           action = coalesce(pl.pre_keep_action, pl.action),
           reason = coalesce(pl.pre_keep_reason, pl.reason),
           pre_keep_action = null,
           pre_keep_reason = null
      from public.ns_load_plans p
     where pl.plan_id = p.id
       and p.location_id = v_loc and p.work_date = p_work_date
       and p.status in ('current', 'confirmed')
       and pl.material_id = p_material_id
       and pl.action <> 'skip';
  end if;

  select p.* into v_plan from public.ns_load_plans p
   where p.location_id = v_loc and p.work_date = p_work_date
     and p.status in ('current', 'confirmed')
   limit 1;

  select pl.* into v_line
    from public.ns_load_plan_lines pl
   where pl.plan_id = v_plan.id
     and pl.material_id = p_material_id
   limit 1;

  v_receipt := jsonb_build_object(
    'location_id',   v_loc,
    'location_code', (select code from public.ns_stock_locations where id = v_loc),
    'work_date',     p_work_date,
    'material_id',   p_material_id,
    'manual_keep',   p_keep,
    'reason',        p_reason,
    'replayed',      false,
    'plan_id',       v_plan.id,
    -- NEW. Null when the day has no live plan, same as `line`: the durable
    -- keep is still recorded for the next build.
    'lines_fingerprint', case when v_plan.id is null then null
                              else public.ns_load_lines_fingerprint(v_plan.id) end,
    'plan_revision',     v_plan.revision,
    'line', case when v_line.id is null then null else jsonb_build_object(
      'line_id',         v_line.id,
      'plan_id',         v_line.plan_id,
      'action',          v_line.action,
      'reason',          v_line.reason,
      'manual_keep',     v_line.manual_keep,
      'pre_keep_action', v_line.pre_keep_action) end);

  insert into public.ns_load_operations
    (client_operation_id, kind, location_id, work_date, intent_fingerprint,
     actor_id, receipt)
  values
    (p_client_operation_id, 'manual_keep', v_loc, p_work_date, v_print,
     auth.uid(), v_receipt);

  return v_receipt;
end
$$;

/* ===================================================================== */
/* 5. confirm_load_plan: it checks what the crew was looking at            */
/* ===================================================================== */

-- The new parameter is APPENDED and defaulted, so a five-argument call
-- still resolves -- but `create or replace` refuses to add a defaulted
-- parameter beside existing defaulted ones (42P13), so the old function has
-- to go first. Nothing is left behind that could silently skip the check.
drop function if exists public.confirm_load_plan(text, uuid, integer, text, text);

create or replace function public.confirm_load_plan(
  p_client_operation_id   text,
  p_plan_id               uuid,
  p_expected_revision     integer,
  p_expected_fingerprint  text default null,
  p_note                  text default null,
  p_expected_lines_fingerprint text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan    public.ns_load_plans%rowtype;
  v_live    text;
  v_lines   text;
  v_base    uuid;
  v_code    text;
  v_vcode   text;
  v_line    record;
  v_res     jsonb;
  v_n       integer := 0;
  v_skipped integer := 0;
  v_print   text;
  v_replay  jsonb;
  v_receipt jsonb;
begin
  if not public.is_admin() then
    raise exception 'confirm_load_plan is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  /* WHAT DID YOU SEE. Both of these were optional and are now required.
     A confirmation is the moment stock moves; a caller that will not say
     which revision and which set of lines it was looking at cannot be
     checked against either, and "it looked fine when I opened it" is not a
     confirmation. */
  if p_expected_revision is null then
    raise exception
      'Send the plan revision you were shown. A confirmation that cannot '
      'say what it saw cannot be checked against the current plan.'
      using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(btrim(p_expected_lines_fingerprint), '') = '' then
    raise exception
      'Send the lines_fingerprint you were shown. A Manual Keep or an '
      'owner-authorised exception can change what the plan recommends '
      'without changing its revision, and confirming an unseen change is '
      'how a van gets loaded with something nobody agreed to.'
      using errcode = 'invalid_parameter_value';
  end if;

  v_print := public.ns_load_intent_fingerprint(jsonb_build_object(
    'plan_id',              p_plan_id,
    'expected_revision',    p_expected_revision,
    'expected_fingerprint', p_expected_fingerprint,
    'expected_lines',       p_expected_lines_fingerprint,
    'note',                 p_note));

  v_replay := public.ns_load_replay_guard(
    p_client_operation_id, 'confirmation', v_print);
  if v_replay is not null then return v_replay; end if;

  select * into v_plan from public.ns_load_plans where id = p_plan_id for update;
  if not found then
    raise exception 'No such load plan %', p_plan_id using errcode = 'no_data_found';
  end if;
  if not public.can_see_location(v_plan.location_id) then
    raise exception 'That plan is for a vehicle you do not work from'
      using errcode = 'insufficient_privilege';
  end if;

  if v_plan.status = 'closed' then
    raise exception
      'The day for plan revision % is already closed.', v_plan.revision
      using errcode = 'check_violation';
  end if;
  if v_plan.status = 'confirmed' then
    raise exception
      'Plan revision % was already confirmed. If the load changed, rebuild '
      'and confirm the new revision.', v_plan.revision
      using errcode = 'unique_violation';
  end if;
  if v_plan.status <> 'current' then
    raise exception
      'Plan revision % is %, so a newer one exists. Reload before confirming.',
      v_plan.revision, v_plan.status
      using errcode = 'check_violation';
  end if;

  if p_expected_revision <> v_plan.revision then
    raise exception
      'You confirmed revision % but the current one is %. Reload the plan.',
      p_expected_revision, v_plan.revision
      using errcode = 'check_violation';
  end if;

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

  /* THE RECOMMENDATION LOCK. The revision and the basis both match here:
     the schedule did not move and nobody rebuilt. What changed is what the
     plan ASKS FOR -- a cleared Manual Keep, or an owner-authorised skip or
     extra. */
  v_lines := coalesce(v_plan.lines_fingerprint,
                      public.ns_load_lines_fingerprint(v_plan.id));
  if p_expected_lines_fingerprint <> v_lines then
    raise exception
      'What this plan recommends changed after you looked at it -- a Manual '
      'Keep was set or cleared, or the owner authorised a departure. '
      'Reload the plan and confirm what it says now.'
      using errcode = 'check_violation';
  end if;

  select id, code into v_base, v_code from public.ns_stock_locations
   where kind = 'base' and active;
  select code into v_vcode from public.ns_stock_locations where id = v_plan.location_id;

  select count(*)::integer into v_skipped
    from public.ns_load_plan_lines
   where plan_id = p_plan_id and action = 'skip';

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

  v_receipt := public.ns_load_plan_result(p_plan_id, false)
    || jsonb_build_object('transfers_posted', v_n,
                          'lines_skipped_by_exception', v_skipped,
                          -- What the confirmation was checked against, so
                          -- the receipt is self-describing.
                          'confirmed_lines_fingerprint', v_lines);

  insert into public.ns_load_operations
    (client_operation_id, kind, location_id, work_date, intent_fingerprint,
     actor_id, receipt)
  values
    (p_client_operation_id, 'confirmation', v_plan.location_id, v_plan.work_date,
     v_print, auth.uid(), v_receipt);

  return v_receipt;
end
$$;

/* ===================================================================== */
/* 6. grants and assertions                                              */
/* ===================================================================== */

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.ns_work_day_timezone()',
    'public.ns_work_day_bounds(date)',
    'public.ns_load_lines_fingerprint(uuid)',
    'public.get_load_plan(text,date)',
    'public.ns_load_day_summary(text,date)',
    'public.ns_load_plan_result(uuid,boolean)',
    'public.set_manual_keep(text,text,date,uuid,boolean,text)',
    'public.confirm_load_plan(text,uuid,integer,text,text,text)'
  ]
  loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('grant execute on function %s to authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

-- The trigger function is called BY the trigger, never by a client.
revoke all on function public.ns_touch_load_lines_fingerprint() from public;
revoke all on function public.ns_touch_load_lines_fingerprint() from anon;
revoke all on function public.ns_touch_load_lines_fingerprint() from authenticated;

do $$
declare
  f text;
begin
  -- Asserted with has_function_privilege rather than by calling: the table
  -- owner bypasses grants, so a successful call would prove nothing.
  foreach f in array array[
    'public.get_load_plan(text,date)',
    'public.set_manual_keep(text,text,date,uuid,boolean,text)',
    'public.confirm_load_plan(text,uuid,integer,text,text,text)',
    'public.ns_work_day_timezone()'
  ]
  loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception 'anon can execute %, which it must not', f;
    end if;
  end loop;

  -- The five-argument confirmation must be GONE, not merely superseded: a
  -- surviving overload would be a confirmation path with no lock on it.
  if exists (
    select 1 from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'confirm_load_plan'
       and pg_get_function_identity_arguments(p.oid)
           = 'text, uuid, integer, text, text') then
    raise exception
      'the five-argument confirm_load_plan still exists, so a caller could '
      'confirm without quoting the lines fingerprint';
  end if;

  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.ns_load_plan_lines'::regclass
       and tgname = 'ns_load_lines_fingerprint_trg'
       and not tgisinternal) then
    raise exception 'the lines-fingerprint trigger is not installed';
  end if;

  if exists (select 1 from public.ns_load_plans where lines_fingerprint is null) then
    raise exception 'a plan was left without a lines fingerprint';
  end if;
end
$$;
