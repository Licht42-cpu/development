-- ===========================================================================
-- Batch 12.1, part 1: the ordered day.
--
-- WHAT THIS IS. "Plan today's work and understand delays" for one crew, two
-- at most. An ordered list of stops per vehicle, manual reordering,
-- reassignment and rescheduling, and the effect each of those has on the
-- load plan. It is not fleet management: no routing, no optimisation, no
-- travel estimates, no background tracking, no payroll.
--
-- WHAT IT REUSES RATHER THAN REPLACES, because a second source of truth for
-- "which car is this job on" is exactly how a job gets dispatched twice:
--
--   * ns_job_vehicle_assignments (10.1) stays THE assignment. Its primary
--     key is job_id, so one job cannot be assigned to two vehicles -- that
--     guarantee is structural, not a rule somebody remembered to write, and
--     §6 asserts it rather than assuming it.
--   * ns_vehicle_day_jobs(location, date) (10.1, corrected in 12.1's round
--     two for the operating day) stays THE membership rule, including the
--     one-vehicle default and the two-vehicle "belongs to neither".
--   * ns_unassigned_day_jobs(date) stays THE report of work that needs a car.
--   * ns_load_intent_fingerprint(jsonb) (10.1 corrective) is reused for
--     intent hashing. One hash function, one behaviour.
--
-- SO WHAT IS ACTUALLY NEW. Three things and no more:
--
--   1. ns_dispatch_days -- a version number per (vehicle, date), so two
--      people reordering at once refuse each other instead of silently
--      overwriting.
--   2. ns_dispatch_order -- a SPARSE position per job, stamped with the
--      vehicle and date it was set for. If the job later moves, the stored
--      position is stale and is reported as stale rather than applied to a
--      day it was not meant for.
--   3. ns_dispatch_operations -- the per-operation key ledger, the same
--      shape and the same kind -> scope -> intent guard order as the load
--      ledger, because a dispatch edit is as retryable as a stock movement.
--
-- NOT APPLIED ANYWHERE. Written to disk and rehearsed on a disposable local
-- database with a fail-closed production guard.
-- ===========================================================================

/* ===================================================================== */
/* 1. the day's version, the order, and the key ledger                    */
/* ===================================================================== */

create table if not exists public.ns_dispatch_days (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.ns_stock_locations(id) on delete cascade,
  work_date   date not null,

  -- Bumped by every accepted mutation that changes what the day looks like.
  -- A reorder or reassignment quotes the revision it was shown; a stale one
  -- is refused with the current number rather than applied on top of
  -- somebody else's edit.
  revision    integer not null default 1,

  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id),
  updated_at  timestamptz not null default now(),

  constraint ns_dispatch_days_one_per_vehicle_day unique (location_id, work_date),
  constraint ns_dispatch_days_revision_positive check (revision >= 1)
);

comment on table public.ns_dispatch_days is
  'One row per (vehicle, work date) holding the dispatch revision. The row '
  'is created on first mutation, not on read: opening a planning screen '
  'must not write anything.';

create table if not exists public.ns_dispatch_order (
  job_id      uuid primary key references public.ns_jobs(id) on delete cascade,

  -- The vehicle and date the position was set FOR. Not a second assignment:
  -- ns_job_vehicle_assignments still decides which car the job is on. These
  -- two columns exist so a position can be recognised as stale.
  location_id uuid not null references public.ns_stock_locations(id) on delete cascade,
  work_date   date not null,

  stop_position integer not null,
  set_by      uuid references auth.users(id),
  set_at      timestamptz not null default now(),

  constraint ns_dispatch_order_position_positive check (stop_position >= 1)
);

create unique index if not exists ns_dispatch_order_slot
  on public.ns_dispatch_order (location_id, work_date, stop_position);

comment on table public.ns_dispatch_order is
  'A SPARSE manual position. A job with no row is ordered by its scheduled '
  'time, after the jobs that have one. A row whose (location_id, work_date) '
  'no longer matches where the job actually is is STALE and is reported as '
  'stale, never applied: a position set for Car A on Tuesday says nothing '
  'about Car B on Wednesday.';

create table if not exists public.ns_dispatch_operations (
  client_operation_id text primary key,
  kind                text not null,
  location_id         uuid references public.ns_stock_locations(id) on delete set null,
  work_date           date,
  intent_fingerprint  text not null,
  actor_id            uuid references auth.users(id),
  receipt             jsonb not null,
  created_at          timestamptz not null default now(),

  constraint ns_dispatch_operations_kind_known check (kind in (
    'reorder', 'assignment', 'reschedule', 'stage', 'issue', 'issue_resolution',
    'property_access', 'work_zone', 'notification'))
);

create index if not exists ns_dispatch_operations_scope_idx
  on public.ns_dispatch_operations (location_id, work_date);

comment on table public.ns_dispatch_operations is
  'The retry ledger for every 12.1 mutation: the key, what it was used for, '
  'the intent fingerprint and the receipt that was returned. A replay '
  'returns those bytes. Same shape as ns_load_operations for the same '
  'reason -- the key has to outlive the thing it changed.';

/* The guard. Kind, then SCOPE, then intent -- the same order as the load
   and seasonal guards, so a caller who cannot see the location learns
   nothing about what the key was used for. */
create or replace function public.ns_dispatch_replay_guard(
  p_client_operation_id text,
  p_kind                text,
  p_fingerprint         text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v public.ns_dispatch_operations;
begin
  select * into v from public.ns_dispatch_operations
   where client_operation_id = p_client_operation_id;
  if not found then return null; end if;

  if v.kind <> p_kind then
    raise exception
      'That key was already used for a %, not a %. A key belongs to the '
      'operation it was first used for.', v.kind, p_kind
      using errcode = 'unique_violation';
  end if;

  -- A null location is a job-scoped operation (an issue, a notification):
  -- there is no vehicle to check, and the operation's own authorisation
  -- has already run by the time the guard is consulted.
  if v.location_id is not null and not public.can_see_location(v.location_id) then
    raise exception 'You are not assigned to that location'
      using errcode = 'insufficient_privilege';
  end if;

  if v.intent_fingerprint <> p_fingerprint then
    raise exception
      'That key was used for a different % (the request differs). Send a '
      'new key, or resend the original request unchanged.', p_kind
      using errcode = 'unique_violation';
  end if;

  return v.receipt || jsonb_build_object('replayed', true);
end
$$;

/** The day's version row, created on demand by a MUTATION. Reads never
 *  call this: a planning screen that wrote a row every time somebody looked
 *  at Wednesday would make "revision" meaningless. */
create or replace function public.ns_dispatch_day_row(
  p_location_id uuid, p_work_date date)
returns public.ns_dispatch_days
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.ns_dispatch_days;
begin
  insert into public.ns_dispatch_days (location_id, work_date, created_by, updated_by)
  values (p_location_id, p_work_date, auth.uid(), auth.uid())
  on conflict (location_id, work_date) do nothing;

  select * into v from public.ns_dispatch_days
   where location_id = p_location_id and work_date = p_work_date;
  return v;
end
$$;

/** The current revision, or 1 when nobody has edited the day yet. Reported
 *  by the read so a first edit has something true to quote back. */
create or replace function public.ns_dispatch_revision(
  p_location_id uuid, p_work_date date)
returns integer
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce((select revision from public.ns_dispatch_days
                    where location_id = p_location_id and work_date = p_work_date), 1)
$$;

/* ===================================================================== */
/* 2. invalidating a load plan without rewriting its history              */
/* ===================================================================== */

-- WHY TWO COLUMNS AND NOT A STATUS CHANGE. A confirmed plan is the record
-- of what the crew agreed to load, and its transfer receipts hang off its
-- lines. Flipping it to 'superseded' would destroy that. So:
--
--   * a CURRENT plan is marked superseded, because its recommendations are
--     now wrong and a newer revision should be built;
--   * a CONFIRMED plan keeps its status and its receipts, and is STAMPED
--     invalidated, which confirm_load_plan reads (§4) to refuse a late
--     confirmation of a day that has since been re-planned.
--
-- Rebuilding is build_load_plan, which moves no stock (daily-load contract
-- §1, batch10-1 E1). Nothing here transfers anything, and a reassignment
-- never claims a tool physically moved between cars.
alter table public.ns_load_plans
  add column if not exists invalidated_at timestamptz;
alter table public.ns_load_plans
  add column if not exists invalidated_reason text;

comment on column public.ns_load_plans.invalidated_at is
  'When a dispatch edit (reassignment or reschedule) made this plan''s '
  'basis wrong. Set on the live plan AND on an already-confirmed one: the '
  'confirmed plan stays confirmed as history, and confirm_load_plan refuses '
  'a late confirmation against it (Batch 12.1).';

/** Marks both vehicles' plans for a day as no longer planned-for, with the
 *  reason, and returns what it touched so the receipt can say so.
 *
 *  Deliberately does NOT rebuild. Rebuilding is owner-only and creates a
 *  revision; doing it implicitly inside a reassignment would hide a new
 *  recommendation behind an unrelated action. The read reports
 *  `needs_rebuild` and the owner presses the button. */
create or replace function public.ns_dispatch_invalidate_loads(
  p_location_ids uuid[],
  p_work_dates   date[],
  p_reason       text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_rows jsonb;
begin
  with touched as (
    update public.ns_load_plans p
       set invalidated_at = now(),
           invalidated_reason = p_reason,
           status = case when p.status = 'current' then 'superseded' else p.status end
     where p.location_id = any(p_location_ids)
       and p.work_date = any(p_work_dates)
       and p.status in ('current', 'confirmed')
       and p.invalidated_at is null
    returning p.id, p.location_id, p.work_date, p.revision, p.status
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'plan_id', id, 'location_id', location_id, 'work_date', work_date,
           'revision', revision, 'status_now', status)), '[]'::jsonb)
    into v_rows from touched;
  return v_rows;
end
$$;

/* ===================================================================== */
/* 3. the read                                                            */
/* ===================================================================== */

/** What a day looks like, for one vehicle.
 *
 *  Membership and the operating-day window come from 10.1's
 *  ns_vehicle_day_jobs, so a dispatch screen and a load screen cannot
 *  disagree about which visits are "today". */
create or replace function public.ns_dispatch_stops(
  p_location_id uuid, p_work_date date)
returns table (
  job_id        uuid,
  assigned      boolean,
  stop_position integer,
  order_state   text,
  scheduled_for timestamptz,
  status       text,
  customer_id  uuid,
  property_id  uuid)
language sql
stable
set search_path = public, pg_temp
as $$
  with day as (
    select j.job_id, j.assigned from public.ns_vehicle_day_jobs(p_location_id, p_work_date) j
  ),
  placed as (
    select d.job_id, d.assigned, o.stop_position,
           case
             when o.job_id is null then 'derived'
             when o.location_id = p_location_id and o.work_date = p_work_date
               then 'explicit'
             -- The position was set for a different car or a different day.
             -- It is not applied and it is not silently deleted either:
             -- saying "stale" is the honest answer.
             else 'stale'
           end as order_state
      from day d
      left join public.ns_dispatch_order o on o.job_id = d.job_id
  )
  select p.job_id,
         p.assigned,
         case when p.order_state = 'explicit' then p.stop_position else null end,
         p.order_state,
         jb.scheduled_for,
         jb.status,
         jb.customer_id,
         jb.property_id
    from placed p
    join public.ns_jobs jb on jb.id = p.job_id
   order by
     -- Explicit positions first, in their order; everything else by time,
     -- with timeless work last. An unordered day still reads as a day.
     case when p.order_state = 'explicit' then 0 else 1 end,
     p.stop_position nulls last,
     jb.scheduled_for nulls last,
     p.job_id
$$;

create or replace function public.get_dispatch_day(
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
  v_loc  uuid;
  v_b    record;
  v_plan public.ns_load_plans;
begin
  if not public.is_admin() then
    raise exception 'get_dispatch_day is admin-only'
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

  /* The live plan if there is one, otherwise the most recent other
     revision -- because invalidation moves a 'current' plan to
     'superseded', and a screen that selected only live plans would show
     "no plan" for exactly the day it most needs to say "rebuild this". */
  select * into v_plan from public.ns_load_plans
   where location_id = v_loc and work_date = p_work_date
   order by case status when 'current' then 0 when 'confirmed' then 1
                        else 2 end,
            revision desc
   limit 1;

  return jsonb_build_object(
    'location_id',   v_loc,
    'location_code', (select code from public.ns_stock_locations where id = v_loc),
    'location_name', (select name from public.ns_stock_locations where id = v_loc),
    'work_date',     p_work_date,

    -- The same operating-day facts the load contract publishes (v2.1 §2a),
    -- from the same function, so the two screens cannot disagree.
    'work_day_timezone',       v_b.zone,
    'work_day_timezone_state', v_b.zone_state,
    'window_starts_at',        v_b.starts_at,
    'window_ends_at',          v_b.ends_at,

    'revision',  public.ns_dispatch_revision(v_loc, p_work_date),
    -- Planning is the owner's. A crew reads its day and reports on it.
    'can_plan',  public.is_owner(),

    'stops', coalesce((
      select jsonb_agg(jsonb_build_object(
               'job_id',        s.job_id,
               'position',      s.stop_position,
               'order_state',   s.order_state,
               -- TRUE means an explicit ns_job_vehicle_assignments row.
               -- FALSE means unassigned and therefore this car's by the
               -- one-vehicle rule. Two different facts, both reported.
               'assigned',      s.assigned,
               'scheduled_for', s.scheduled_for,
               'status',        s.status,
               'customer_id',   s.customer_id,
               'customer_name', c.name,
               'property_id',   s.property_id)
             order by s.stop_position nulls last, s.scheduled_for nulls last, s.job_id)
        from public.ns_dispatch_stops(v_loc, p_work_date) s
        left join public.customers c on c.id = s.customer_id), '[]'::jsonb),

    -- Work that belongs to NEITHER car because two exist and nobody said
    -- which. Reported as needing assignment; never guessed at.
    'unassigned_jobs', coalesce((
      select jsonb_agg(jsonb_build_object(
               'job_id', u.job_id,
               'scheduled_for', jb.scheduled_for,
               'status', jb.status,
               'customer_name', c.name,
               'property_id', jb.property_id)
             order by jb.scheduled_for nulls last, u.job_id)
        -- setof uuid, so the column is named after the function unless it
        -- is aliased. Aliased, because `u.id` silently is not a thing.
        from public.ns_unassigned_day_jobs(p_work_date) as u(job_id)
        join public.ns_jobs jb on jb.id = u.job_id
        left join public.customers c on c.id = jb.customer_id), '[]'::jsonb),

    'readable_vehicles', coalesce((
      select jsonb_agg(jsonb_build_object(
               'location_id', l.id, 'code', l.code, 'name', l.name)
             order by l.sort_order, l.code)
        from public.ns_stock_locations l
       where l.active and l.kind = 'vehicle' and public.can_see_location(l.id)), '[]'::jsonb),

    -- What the dispatch edits did to the load. `needs_rebuild` is a fact
    -- about the plan, not an instruction this function carried out.
    'load_plan', case when v_plan.id is null then
        jsonb_build_object('state', 'none', 'needs_rebuild', false)
      else jsonb_build_object(
        'plan_id',            v_plan.id,
        'state',              v_plan.status,
        'revision',           v_plan.revision,
        'invalidated_at',     v_plan.invalidated_at,
        'invalidated_reason', v_plan.invalidated_reason,
        'needs_rebuild',      v_plan.invalidated_at is not null) end
  );
end
$$;

/* ===================================================================== */
/* 4. confirm_load_plan refuses an invalidated day                        */
/* ===================================================================== */

-- Daily-load v2.1 §6 gained a third check in the 10.1 corrective. This adds
-- a FOURTH refusal case and changes no signature and no response field:
-- a plan whose day has been re-planned since cannot be confirmed, because
-- the transfers it would post are for a day that no longer exists.
--
-- Recovery is the same shape as the others: re-read, rebuild (owner), and
-- confirm the new revision. Nothing here moves stock.
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

  /* NEW IN 12.1. Checked BEFORE the status-ordering message, because
     "a newer one exists" would be a misleading thing to say about a day
     whose work was moved to the other car: there may be no newer revision
     at all until somebody rebuilds. */
  if v_plan.invalidated_at is not null then
    raise exception
      'The day was re-planned after this load plan was built (%). Rebuild '
      'the plan and confirm the new revision.',
      coalesce(v_plan.invalidated_reason, 'a dispatch change')
      using errcode = 'check_violation';
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

-- The read envelope gains the two invalidation fields for the same reason
-- the lock gained one: a screen that cannot see them cannot explain the
-- refusal it is about to get. Additive; nothing is removed or renamed.
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
    'lines_fingerprint', coalesce(p.lines_fingerprint,
                                  public.ns_load_lines_fingerprint(p.id)),
    'generated_at',      p.generated_at,
    'confirmed_at',      p.confirmed_at,
    'closed_at',         p.closed_at,
    'note',              p.note,
    'replayed',          p_replayed,
    -- new in 12.1
    'invalidated_at',     p.invalidated_at,
    'invalidated_reason', p.invalidated_reason,
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

/* ===================================================================== */
/* 5. the three planning mutations                                        */
/* ===================================================================== */

/** Set the order of a vehicle's day.
 *
 *  p_job_ids must be EXACTLY the day's jobs, in the wanted order. Not a
 *  subset: a screen built from a stale read would otherwise drop the job it
 *  had not seen, and the drop would look like a decision. The refusal names
 *  what is missing or extra.
 *
 *  Reordering does NOT invalidate the load plan, and that is deliberate:
 *  the load is a WHOLE-DAY decision (daily-load contract §2), so the same
 *  tools are wanted whatever order the stops are visited in. Reassignment
 *  and rescheduling do invalidate, because they change what the day
 *  contains. */
create or replace function public.reorder_dispatch_day(
  p_client_operation_id text,
  p_location_code       text,
  p_work_date           date,
  p_job_ids             uuid[],
  p_expected_revision   integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_loc     uuid;
  v_day     public.ns_dispatch_days;
  v_print   text;
  v_replay  jsonb;
  v_have    uuid[];
  v_missing uuid[];
  v_extra   uuid[];
  v_receipt jsonb;
begin
  if not public.is_owner() then
    raise exception
      'Ordering the day is the owner''s. A crew works the day it is given '
      'and reports on it.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_job_ids is null or array_length(p_job_ids, 1) is null then
    raise exception 'Send the day''s jobs in the order you want them'
      using errcode = 'invalid_parameter_value';
  end if;
  if array_length(p_job_ids, 1) <> (
       select count(distinct x) from unnest(p_job_ids) x) then
    raise exception 'The same job appears twice in that order'
      using errcode = 'invalid_parameter_value';
  end if;

  v_print := public.ns_load_intent_fingerprint(jsonb_build_object(
    'location_code', lower(btrim(p_location_code)),
    'work_date',     p_work_date,
    -- NOT sorted. The order IS the intent here, unlike a closing count
    -- where two orders are the same request.
    'job_ids',       to_jsonb(p_job_ids),
    'expected_revision', p_expected_revision));

  v_replay := public.ns_dispatch_replay_guard(
    p_client_operation_id, 'reorder', v_print);
  if v_replay is not null then return v_replay; end if;

  v_loc := public.ns_location_by_code(p_location_code);
  if v_loc is null then
    raise exception 'No active stock location with code %', p_location_code
      using errcode = 'no_data_found';
  end if;

  select coalesce(array_agg(s.job_id), '{}') into v_have
    from public.ns_dispatch_stops(v_loc, p_work_date) s;

  select coalesce(array_agg(x), '{}') into v_missing
    from unnest(v_have) x where not (x = any(p_job_ids));
  select coalesce(array_agg(x), '{}') into v_extra
    from unnest(p_job_ids) x where not (x = any(v_have));

  if array_length(v_missing, 1) is not null then
    raise exception
      'That order leaves out % of the day''s jobs. Reload the day: an order '
      'that drops a stop is how a visit gets forgotten.',
      array_length(v_missing, 1)
      using errcode = 'check_violation';
  end if;
  if array_length(v_extra, 1) is not null then
    raise exception
      'That order includes % job(s) that are not on this vehicle''s day.',
      array_length(v_extra, 1)
      using errcode = 'check_violation';
  end if;

  v_day := public.ns_dispatch_day_row(v_loc, p_work_date);
  if p_expected_revision is not null and p_expected_revision <> v_day.revision then
    raise exception
      'You reordered revision % but the day is now at %. Reload it: '
      'somebody else changed this day while you were looking at it.',
      p_expected_revision, v_day.revision
      using errcode = 'check_violation';
  end if;

  -- Delete then insert, because the slot index is unique: swapping two
  -- positions in place would collide halfway through.
  delete from public.ns_dispatch_order
   where location_id = v_loc and work_date = p_work_date;
  delete from public.ns_dispatch_order where job_id = any(p_job_ids);

  insert into public.ns_dispatch_order (job_id, location_id, work_date, stop_position, set_by)
  select x.job_id, v_loc, p_work_date, x.pos, auth.uid()
    from unnest(p_job_ids) with ordinality as x(job_id, pos);

  update public.ns_dispatch_days
     set revision = revision + 1, updated_at = now(), updated_by = auth.uid()
   where id = v_day.id
  returning * into v_day;

  v_receipt := jsonb_build_object(
    'location_id',   v_loc,
    'location_code', (select code from public.ns_stock_locations where id = v_loc),
    'work_date',     p_work_date,
    'revision',      v_day.revision,
    'ordered',       array_length(p_job_ids, 1),
    'replayed',      false,
    -- Said explicitly so nobody infers the opposite from silence.
    'load_plans_invalidated', '[]'::jsonb,
    'load_effect',   'none: the load is a whole-day decision, so the order '
                     'of the stops does not change what the van needs',
    'stops', coalesce((
      select jsonb_agg(jsonb_build_object(
               'job_id', s.job_id, 'position', s.stop_position,
               'order_state', s.order_state)
             order by s.stop_position)
        from public.ns_dispatch_stops(v_loc, p_work_date) s), '[]'::jsonb));

  insert into public.ns_dispatch_operations
    (client_operation_id, kind, location_id, work_date, intent_fingerprint,
     actor_id, receipt)
  values
    (p_client_operation_id, 'reorder', v_loc, p_work_date, v_print,
     auth.uid(), v_receipt);

  return v_receipt;
end
$$;

/** Put a job on a vehicle, or take it off.
 *
 *  p_location_code null REMOVES the assignment, which with two vehicles
 *  returns the job to "needs assignment" rather than guessing a car.
 *
 *  Invalidates the load plan for BOTH the vehicle it left and the one it
 *  joined, on that job's day: each car's whole-day needs just changed.
 *  Nothing is transferred -- a reassignment on a screen does not carry a
 *  washer across a car park. */
create or replace function public.assign_job_to_vehicle(
  p_client_operation_id text,
  p_job_id              uuid,
  p_location_code       text,
  p_expected_revision   integer default null,
  p_reason              text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job      public.ns_jobs;
  v_to       uuid;
  v_from     uuid;
  v_day      date;
  v_print    text;
  v_replay   jsonb;
  v_dayrow   public.ns_dispatch_days;
  v_locs     uuid[];
  v_invalid  jsonb;
  v_receipt  jsonb;
begin
  if not public.is_owner() then
    raise exception
      'Assigning work to a vehicle is the owner''s decision.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  v_print := public.ns_load_intent_fingerprint(jsonb_build_object(
    'job_id',        p_job_id,
    'location_code', lower(btrim(coalesce(p_location_code, ''))),
    'expected_revision', p_expected_revision,
    'reason',        p_reason));

  v_replay := public.ns_dispatch_replay_guard(
    p_client_operation_id, 'assignment', v_print);
  if v_replay is not null then return v_replay; end if;

  select * into v_job from public.ns_jobs where id = p_job_id for update;
  if not found then
    raise exception 'No such job %', p_job_id using errcode = 'no_data_found';
  end if;
  if v_job.scheduled_for is null then
    raise exception
      'Job % has no scheduled time, so it is not on any day yet. Schedule '
      'it before putting it on a car.', p_job_id
      using errcode = 'check_violation';
  end if;

  -- The job's day, in the OPERATING day's terms (v2.1 §2a), so a 6pm visit
  -- lands on the day the crew works it.
  select d::date into v_day
    from (select (v_job.scheduled_for at time zone
                   coalesce(public.ns_work_day_timezone(), 'UTC')) as d) t;

  select location_id into v_from from public.ns_job_vehicle_assignments
   where job_id = p_job_id;

  if p_location_code is not null then
    v_to := public.ns_location_by_code(p_location_code);
    if v_to is null then
      raise exception 'No active stock location with code %', p_location_code
        using errcode = 'no_data_found';
    end if;
    if not exists (select 1 from public.ns_stock_locations
                    where id = v_to and kind = 'vehicle' and active) then
      raise exception
        'Work is dispatched to a VEHICLE. % is not one.', p_location_code
        using errcode = 'invalid_parameter_value';
    end if;
  end if;

  if v_to is not null then
    v_dayrow := public.ns_dispatch_day_row(v_to, v_day);
    if p_expected_revision is not null and p_expected_revision <> v_dayrow.revision then
      raise exception
        'You assigned against revision % but that vehicle''s day is now at '
        '%. Reload it.', p_expected_revision, v_dayrow.revision
        using errcode = 'check_violation';
    end if;
  end if;

  if v_to is null then
    delete from public.ns_job_vehicle_assignments where job_id = p_job_id;
  else
    insert into public.ns_job_vehicle_assignments (job_id, location_id, assigned_by, note)
    values (p_job_id, v_to, auth.uid(), p_reason)
    on conflict (job_id) do update
       set location_id = excluded.location_id,
           assigned_by = excluded.assigned_by,
           assigned_at = now(),
           note = coalesce(excluded.note, public.ns_job_vehicle_assignments.note);
  end if;

  -- A position set for the car it has left means nothing now. Dropped
  -- rather than carried across, so it cannot reappear as a stale order.
  delete from public.ns_dispatch_order
   where job_id = p_job_id
     and (v_to is null or location_id <> v_to or work_date <> v_day);

  v_locs := array_remove(array[v_from, v_to], null);
  if array_length(v_locs, 1) is null then
    v_invalid := '[]'::jsonb;
  else
    v_invalid := public.ns_dispatch_invalidate_loads(
      v_locs, array[v_day],
      'a job was ' || case when v_to is null then 'unassigned'
                           else 'assigned to ' || p_location_code end);
  end if;

  -- Both days' revisions move, because both screens are now out of date.
  if v_from is not null then
    perform public.ns_dispatch_day_row(v_from, v_day);
    update public.ns_dispatch_days
       set revision = revision + 1, updated_at = now(), updated_by = auth.uid()
     where location_id = v_from and work_date = v_day;
  end if;
  if v_to is not null then
    update public.ns_dispatch_days
       set revision = revision + 1, updated_at = now(), updated_by = auth.uid()
     where location_id = v_to and work_date = v_day;
  end if;

  v_receipt := jsonb_build_object(
    'job_id',        p_job_id,
    'work_date',     v_day,
    'from_location_id', v_from,
    'to_location_id',   v_to,
    'to_location_code', p_location_code,
    'reason',        p_reason,
    'replayed',      false,
    'load_plans_invalidated', v_invalid,
    'stock_moved',   false,
    'revisions', jsonb_build_object(
      'from', case when v_from is null then null else
        public.ns_dispatch_revision(v_from, v_day) end,
      'to',   case when v_to is null then null else
        public.ns_dispatch_revision(v_to, v_day) end));

  insert into public.ns_dispatch_operations
    (client_operation_id, kind, location_id, work_date, intent_fingerprint,
     actor_id, receipt)
  values
    (p_client_operation_id, 'assignment', coalesce(v_to, v_from), v_day,
     v_print, auth.uid(), v_receipt);

  return v_receipt;
end
$$;

/** Move a job to another time, possibly another day.
 *
 *  Invalidates the load plan on the day it left and the day it joined, for
 *  whichever vehicle it is on. The basis fingerprint would also catch this
 *  at confirmation time; the explicit stamp is what lets the screen say
 *  WHY before anybody tries. */
create or replace function public.reschedule_job(
  p_client_operation_id text,
  p_job_id              uuid,
  p_scheduled_for       timestamptz,
  p_expected_revision   integer default null,
  p_reason              text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job     public.ns_jobs;
  v_loc     uuid;
  v_old_day date;
  v_new_day date;
  v_tz      text;
  v_print   text;
  v_replay  jsonb;
  v_dayrow  public.ns_dispatch_days;
  v_invalid jsonb;
  v_receipt jsonb;
begin
  if not public.is_owner() then
    raise exception 'Rescheduling work is the owner''s decision.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_scheduled_for is null then
    raise exception
      'Send the new time. Clearing a schedule is not a reschedule: it takes '
      'the job off every day, so do it deliberately on the job screen.'
      using errcode = 'invalid_parameter_value';
  end if;

  v_print := public.ns_load_intent_fingerprint(jsonb_build_object(
    'job_id',        p_job_id,
    'scheduled_for', p_scheduled_for,
    'expected_revision', p_expected_revision,
    'reason',        p_reason));

  v_replay := public.ns_dispatch_replay_guard(
    p_client_operation_id, 'reschedule', v_print);
  if v_replay is not null then return v_replay; end if;

  select * into v_job from public.ns_jobs where id = p_job_id for update;
  if not found then
    raise exception 'No such job %', p_job_id using errcode = 'no_data_found';
  end if;

  v_tz := coalesce(public.ns_work_day_timezone(), 'UTC');
  v_old_day := case when v_job.scheduled_for is null then null
                    else (v_job.scheduled_for at time zone v_tz)::date end;
  v_new_day := (p_scheduled_for at time zone v_tz)::date;

  select location_id into v_loc from public.ns_job_vehicle_assignments
   where job_id = p_job_id;

  if v_loc is not null and v_old_day is not null then
    v_dayrow := public.ns_dispatch_day_row(v_loc, v_old_day);
    if p_expected_revision is not null and p_expected_revision <> v_dayrow.revision then
      raise exception
        'You rescheduled against revision % but that day is now at %. '
        'Reload it.', p_expected_revision, v_dayrow.revision
        using errcode = 'check_violation';
    end if;
  end if;

  update public.ns_jobs set scheduled_for = p_scheduled_for where id = p_job_id;

  -- A position set for the day it has left is dropped, for the same reason
  -- as on reassignment.
  if v_old_day is distinct from v_new_day then
    delete from public.ns_dispatch_order
     where job_id = p_job_id and work_date is distinct from v_new_day;
  end if;

  if v_loc is null then
    v_invalid := '[]'::jsonb;
  else
    v_invalid := public.ns_dispatch_invalidate_loads(
      array[v_loc],
      array_remove(array[v_old_day, v_new_day], null),
      'a job was rescheduled');
    perform public.ns_dispatch_day_row(v_loc, v_new_day);
    update public.ns_dispatch_days
       set revision = revision + 1, updated_at = now(), updated_by = auth.uid()
     where location_id = v_loc
       and work_date in (coalesce(v_old_day, v_new_day), v_new_day);
  end if;

  v_receipt := jsonb_build_object(
    'job_id',         p_job_id,
    'scheduled_for',  p_scheduled_for,
    'previous_scheduled_for', v_job.scheduled_for,
    'work_date_before', v_old_day,
    'work_date_after',  v_new_day,
    'work_day_timezone', public.ns_work_day_timezone(),
    'location_id',    v_loc,
    'reason',         p_reason,
    'replayed',       false,
    'load_plans_invalidated', v_invalid,
    'stock_moved',    false);

  insert into public.ns_dispatch_operations
    (client_operation_id, kind, location_id, work_date, intent_fingerprint,
     actor_id, receipt)
  values
    (p_client_operation_id, 'reschedule', v_loc, v_new_day, v_print,
     auth.uid(), v_receipt);

  return v_receipt;
end
$$;

/* ===================================================================== */
/* 6. RLS, grants and assertions                                          */
/* ===================================================================== */

alter table public.ns_dispatch_days enable row level security;
alter table public.ns_dispatch_order enable row level security;
alter table public.ns_dispatch_operations enable row level security;

do $$
declare
  t text;
begin
  execute 'drop policy if exists ns_dispatch_days_read on public.ns_dispatch_days';
  execute 'create policy ns_dispatch_days_read on public.ns_dispatch_days
             for select to authenticated
             using (public.is_admin() and public.can_see_location(location_id))';
  execute 'drop policy if exists ns_dispatch_order_read on public.ns_dispatch_order';
  execute 'create policy ns_dispatch_order_read on public.ns_dispatch_order
             for select to authenticated
             using (public.is_admin() and public.can_see_location(location_id))';
  execute 'drop policy if exists ns_dispatch_operations_read on public.ns_dispatch_operations';
  execute 'create policy ns_dispatch_operations_read on public.ns_dispatch_operations
             for select to authenticated
             using (public.is_admin()
                    and (location_id is null or public.can_see_location(location_id)))';

  foreach t in array array[
    'public.ns_dispatch_days', 'public.ns_dispatch_order',
    'public.ns_dispatch_operations']
  loop
    execute format('revoke all on %s from public', t);
    execute format('revoke all on %s from anon', t);
    -- SELECT only. Every write goes through a function that checks who is
    -- asking, bumps the revision and records the key.
    execute format('grant select on %s to authenticated', t);
    execute format('grant all on %s to service_role', t);
  end loop;
end
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.get_dispatch_day(text,date)',
    'public.ns_dispatch_stops(uuid,date)',
    'public.ns_dispatch_revision(uuid,date)',
    'public.reorder_dispatch_day(text,text,date,uuid[],integer)',
    'public.assign_job_to_vehicle(text,uuid,text,integer,text)',
    'public.reschedule_job(text,uuid,timestamptz,integer,text)',
    'public.confirm_load_plan(text,uuid,integer,text,text,text)',
    'public.ns_load_plan_result(uuid,boolean)'
  ]
  loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('grant execute on function %s to authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

-- Internals. A client never calls these directly, and the guard in
-- particular must not be callable as a way to read another vehicle's
-- receipts.
do $$
declare
  f text;
begin
  foreach f in array array[
    'public.ns_dispatch_replay_guard(text,text,text)',
    'public.ns_dispatch_day_row(uuid,date)',
    'public.ns_dispatch_invalidate_loads(uuid[],date[],text)'
  ]
  loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('revoke all on function %s from authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.get_dispatch_day(text,date)',
    'public.reorder_dispatch_day(text,text,date,uuid[],integer)',
    'public.assign_job_to_vehicle(text,uuid,text,integer,text)',
    'public.reschedule_job(text,uuid,timestamptz,integer,text)'
  ]
  loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception 'anon can execute %, which it must not', f;
    end if;
  end loop;

  -- ONE JOB, ONE CAR, structurally. This is the "a job must not be
  -- dispatched to both vehicles" guarantee, and it is asserted rather than
  -- trusted: it holds because job_id is the assignment's primary key.
  if not exists (
    select 1 from pg_constraint c
     where c.conrelid = 'public.ns_job_vehicle_assignments'::regclass
       and c.contype = 'p'
       and (select array_agg(attname::text order by attnum)
              from pg_attribute
             where attrelid = c.conrelid and attnum = any(c.conkey))
           = array['job_id']::text[]) then
    raise exception
      'ns_job_vehicle_assignments is not keyed by job_id alone, so one job '
      'could be assigned to two vehicles';
  end if;

  foreach f in array array[
    'public.ns_dispatch_days', 'public.ns_dispatch_order',
    'public.ns_dispatch_operations']
  loop
    if has_table_privilege('authenticated', f, 'insert')
       or has_table_privilege('authenticated', f, 'update')
       or has_table_privilege('authenticated', f, 'delete') then
      raise exception
        'authenticated can write % directly, so a dispatch edit could '
        'bypass its authorisation, its revision and its key ledger', f;
    end if;
  end loop;
end
$$;
