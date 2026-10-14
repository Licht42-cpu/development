-- ===========================================================================
-- Batch 15.1: one crew-scope rule, and a way for a crew to resolve the case
-- that rule cannot answer on its own.
--
-- THE MISMATCH, as Batch 13.1 reported it with the call paths inspected:
--
--   public.can_work_job(uuid)      11.1. Any admin, EXCEPT where the job is
--                                  explicitly assigned to a vehicle the
--                                  caller cannot see. An unassigned job is
--                                  workable by any crew, HOWEVER MANY
--                                  vehicles are active.
--   public.ns_can_work_job(uuid)   12.1. Assigned to the caller's own
--                                  vehicle, OR unassigned AND exactly one
--                                  vehicle is active. With two, an
--                                  unassigned job belongs to neither crew.
--
-- So with a second car active, an unassigned job could still be COMPLETED by
-- any crew while being invisible to dispatch, to the load plan, to the
-- customer-message path and to the customer report. Two rules that look
-- alike and answer differently is how a leak or a lost record arrives.
--
-- WHY THE STRICTER RULE WINS, both of them. The question "whose job is
-- this" has one right answer, and 12.1's is it: with two cars and nothing
-- assigned, NOBODY has said which car is going, and guessing is what
-- produces two crews at one property or one crew reading the other's work.
--
-- WHY THAT ALONE WOULD HAVE BEEN A WORSE BUG. `can_work_job` gates
-- register_job_evidence, complete_job_with_evidence (twice) and
-- propose_additional_work. Tightening it with nothing else would mean a crew
-- that HAS DONE THE WORK cannot record it -- and assign_job_to_vehicle is
-- OWNER-ONLY, so the crew cannot unblock itself from a driveway. Losing the
-- record of work already done is worse than the ambiguity it fixes.
--
-- SO THE RULE COMES WITH A RESOLUTION. `claim_job_for_vehicle` lets a crew
-- state, deliberately and attributably, that this job is on ITS car. That is
-- the missing fact, supplied by the only person who knows it, and it leaves
-- the business better off than the lax rule did: "which car did this work"
-- is information the stock ledger and the load plan both want.
--
-- ONE IMPLEMENTATION, NOT TWO. `assign_job_to_vehicle` keeps its exact
-- signature and its owner-only gate, and both it and the claim now call one
-- internal core, so the two paths cannot drift in their invalidation,
-- revision or receipt behaviour. The core is 12.1's own body, moved rather
-- than re-written.
--
-- CONTRACT EFFECT. Nothing changes while ONE vehicle is active, which is the
-- state the business is in today: both predicates already agreed there. The
-- change bites only when a second vehicle is activated, which is exactly the
-- scenario both contracts flagged as pending. Recorded as
-- completion-evidence v1.1 and dispatch v1.1.
--
-- NOT APPLIED ANYWHERE. Twenty-ninth pending migration.
-- ===========================================================================

/* ===================================================================== */
/* 1. the one rule, with its reason                                       */
/* ===================================================================== */

/** Whose job is this, and why -- a REASON rather than a boolean, so a
 *  caller can tell "not yours" from "nobody has said yet", and so an
 *  operator-facing message can name the fix instead of guessing.
 *
 *   'owner'                     the caller owns the business
 *   'assigned_to_my_vehicle'    assigned to the vehicle the caller crews
 *   'unassigned_single_vehicle' unassigned, and there is only one vehicle
 *                               to be on -- today's state
 *   'unassigned_needs_a_claim'  unassigned with two or more active
 *                               vehicles. NOT the caller's until somebody
 *                               says which car is going.
 *   'assigned_elsewhere'        on a vehicle the caller does not crew
 *   'not_admin' / 'no_such_job'
 */
create or replace function public.ns_job_crew_scope(p_job_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when not public.is_admin() then 'not_admin'
    when public.is_owner() then 'owner'
    when p_job_id is null then 'no_such_job'
    when not exists (select 1 from public.ns_jobs where id = p_job_id)
      then 'no_such_job'
    when exists (
      select 1 from public.ns_job_vehicle_assignments a
       where a.job_id = p_job_id
         and a.location_id = public.current_crew_vehicle())
      then 'assigned_to_my_vehicle'
    when exists (
      select 1 from public.ns_job_vehicle_assignments a where a.job_id = p_job_id)
      then 'assigned_elsewhere'
    -- Unassigned from here down.
    when public.current_crew_vehicle() is null then 'assigned_elsewhere'
    when (select count(*) from public.ns_stock_locations
           where kind = 'vehicle' and active) = 1
      then 'unassigned_single_vehicle'
    else 'unassigned_needs_a_claim'
  end
$$;

comment on function public.ns_job_crew_scope(uuid) is
  'Whose job this is, as a reason rather than a boolean. The single source '
  'of the crew-scope rule: can_work_job and ns_can_work_job both read it, '
  'so they cannot answer differently.';

/** The boolean every existing guard already calls. Kept pure -- it does not
 *  raise -- because a predicate that throws breaks every CASE and view that
 *  ever wants to ask the question without being refused. */
create or replace function public.ns_job_is_mine(p_job_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.ns_job_crew_scope(p_job_id) in (
    'owner', 'assigned_to_my_vehicle', 'unassigned_single_vehicle');
$$;

/** The precise refusal, for NEW code. The four 11.1 guards and the 12.1/13.1
 *  guards keep their own wording -- see the known-wording note in
 *  docs/batch15-1-release-review.md -- but anything written from here on
 *  should raise this instead, because "assigned to a vehicle you are not
 *  on" is the wrong sentence for a job that is assigned to nobody. */
create or replace function public.ns_assert_job_is_mine(p_job_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v text;
begin
  v := public.ns_job_crew_scope(p_job_id);
  if v in ('owner', 'assigned_to_my_vehicle', 'unassigned_single_vehicle') then
    return;
  end if;
  if v = 'unassigned_needs_a_claim' then
    raise exception
      'That job is not on any car yet, and there is more than one car '
      'running today. Claim it for your vehicle first, or ask the owner to '
      'assign it.'
      using errcode = 'insufficient_privilege';
  end if;
  if v = 'no_such_job' then
    raise exception 'No such job %', p_job_id using errcode = 'no_data_found';
  end if;
  raise exception 'That job is on a vehicle you are not working'
    using errcode = 'insufficient_privilege';
end
$$;

/* -------------------------------------- the two predicates, reconciled -- */

-- BOTH now read ns_job_is_mine, so the divergence is structurally
-- impossible rather than merely fixed. Signatures and return types are
-- unchanged, so no dependent function, view or grant needs editing: the
-- eleven call sites across 11.1, 12.1 and 13.1 pick this up as they are.
--
-- 11.1's rule moves (an unassigned job is no longer every crew's once a
-- second car is active). 12.1's rule does not move at all.
create or replace function public.can_work_job(p_job_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.ns_job_is_mine(p_job_id);
$$;

comment on function public.can_work_job(uuid) is
  'Batch 11.1''s name for the crew-scope rule, reconciled in 15.1 to read '
  'ns_job_is_mine(). It and ns_can_work_job() are now the same rule; before '
  '15.1 they disagreed whenever a second vehicle was active and a job was '
  'unassigned.';

create or replace function public.ns_can_work_job(p_job_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.ns_job_is_mine(p_job_id);
$$;

comment on function public.ns_can_work_job(uuid) is
  'Batch 12.1''s name for the crew-scope rule, reconciled in 15.1 to read '
  'ns_job_is_mine(). Its behaviour is unchanged; can_work_job was brought '
  'into line with it, not the other way round.';

-- ns_can_see_property carries the same one-vehicle clause and the same
-- trap, so it reads the same rule -- but through the JOB, because its
-- question is "does the caller have work at this property", and a property
-- with two jobs on two cars is one the crew of either may need to enter.
create or replace function public.ns_can_see_property(p_property_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when not public.is_admin() then false
    when public.is_owner() then true
    when p_property_id is null then false
    else exists (
      select 1 from public.ns_jobs j
       where j.property_id = p_property_id
         and public.ns_job_is_mine(j.id))
  end
$$;

comment on function public.ns_can_see_property(uuid) is
  'Whether the caller may see a property''s working details: the entrance, '
  'the hazards, the codes, the zones. Reconciled in 15.1 to read the one '
  'crew-scope rule through the job, on ANY date -- a crew preparing '
  'tomorrow needs tonight''s gate code.';

/* ===================================================================== */
/* 2. one assignment implementation, two authorised doors                 */
/* ===================================================================== */

/** The core of 12.1's assignment, moved here unchanged in behaviour so that
 *  the owner's assignment and a crew's claim cannot drift apart in their
 *  load invalidation, day revisions, stale-position cleanup or receipt.
 *
 *  INTERNAL. Not granted to anon or authenticated: it performs no
 *  authorisation of its own, which is precisely why only the two gated
 *  wrappers below may call it. */
create or replace function public.ns_apply_job_assignment(
  p_client_operation_id text,
  p_job_id              uuid,
  p_location_code       text,
  p_expected_revision   integer,
  p_reason              text,
  p_how                 text        -- 'assigned' | 'claimed', for the receipt
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
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  /* THE FINGERPRINT DOES NOT CARRY `p_how`. An owner's assignment and a
     crew's claim of the same job to the same car are the SAME intent, so a
     key reused across them replays rather than conflicting -- which is what
     an operator reconnecting on a different screen actually wants. */
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

  -- The job's day, in the OPERATING day's terms (load contract v2.1 §2a),
  -- so a 6pm visit lands on the day the crew works it.
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
                           else p_how || ' to ' || p_location_code end);
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
    -- Additive, and the only new field: who put it there. An owner's
    -- decision and a crew's claim are both legitimate and are not the same
    -- event.
    'how',           p_how,
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

/** The owner's door. SIGNATURE AND GATE UNCHANGED from 12.1 -- dispatch
 *  contract §? callers and `admin/js/lib/api.js` see no difference. */
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
begin
  if not public.is_owner() then
    raise exception
      'Assigning work to a vehicle is the owner''s decision.'
      using errcode = 'insufficient_privilege';
  end if;
  return public.ns_apply_job_assignment(
    p_client_operation_id, p_job_id, p_location_code, p_expected_revision,
    p_reason, 'assigned');
end
$$;

/** The crew's door: "this one is on my car."
 *
 *  WHAT IT IS FOR. With two cars running and a job on neither, the rule in
 *  §1 says the job is nobody's. This is how the person who knows says which
 *  car is going -- deliberately, attributably, and without waiting for the
 *  owner. It is the reason the stricter rule does not strand a crew that has
 *  already done the work.
 *
 *  WHAT IT CANNOT DO, and these are the point:
 *   * it cannot take a job off another car. A job assigned elsewhere is
 *     refused, because that is a dispatch decision and the owner's.
 *   * it cannot claim FOR another car. The target is the caller's own
 *     vehicle; a code naming someone else's is refused.
 *   * it cannot unassign. Passing no vehicle is meaningless for a claim.
 *   * it is not a completion, and it moves no stock. Every receipt still
 *     says `stock_moved: false`.
 *
 *  An owner calling this is pointed at assign_job_to_vehicle rather than
 *  silently served: an owner has no vehicle of their own, and guessing one
 *  is how work lands on the wrong car. */
create or replace function public.claim_job_for_vehicle(
  p_client_operation_id text,
  p_job_id              uuid,
  p_reason              text default null,
  p_expected_revision   integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mine  uuid;
  v_code  text;
  v_scope text;
begin
  if not public.is_admin() then
    raise exception 'claim_job_for_vehicle is admin-only'
      using errcode = 'insufficient_privilege';
  end if;

  v_mine := public.current_crew_vehicle();
  if v_mine is null then
    raise exception
      'A claim says "this job is on MY car", and you are not on one. Use '
      'assign_job_to_vehicle to put work on a vehicle.'
      using errcode = 'insufficient_privilege';
  end if;

  v_scope := public.ns_job_crew_scope(p_job_id);
  if v_scope = 'no_such_job' then
    raise exception 'No such job %', p_job_id using errcode = 'no_data_found';
  end if;
  if v_scope = 'assigned_elsewhere' then
    raise exception
      'That job is already on another car. Moving work between cars is the '
      'owner''s decision.'
      using errcode = 'insufficient_privilege';
  end if;
  if v_scope = 'assigned_to_my_vehicle' then
    -- Idempotent on state: claiming what is already yours is a retry, not
    -- a second assignment, and it must not bump the day's revision.
    return jsonb_build_object(
      'job_id', p_job_id, 'no_op', true, 'replayed', false,
      'how', 'claimed', 'stock_moved', false,
      'note', 'That job was already on your car.');
  end if;

  select code into v_code from public.ns_stock_locations where id = v_mine;

  return public.ns_apply_job_assignment(
    p_client_operation_id, p_job_id, v_code, p_expected_revision,
    coalesce(nullif(btrim(coalesce(p_reason, '')), ''),
             'Claimed by the crew working it'),
    'claimed') || jsonb_build_object('no_op', false);
end
$$;

/** What a screen needs to show the right control: the scope, whether the
 *  caller may act, and whether a claim would resolve it. Admin-scoped and
 *  read-only. */
create or replace function public.job_crew_scope(p_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v text;
begin
  if not public.is_admin() then
    raise exception 'job_crew_scope is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  v := public.ns_job_crew_scope(p_job_id);
  return jsonb_build_object(
    'job_id',           p_job_id,
    'scope',            v,
    'is_mine',          v in ('owner', 'assigned_to_my_vehicle',
                              'unassigned_single_vehicle'),
    'claimable',        v = 'unassigned_needs_a_claim',
    'active_vehicles',  (select count(*) from public.ns_stock_locations
                          where kind = 'vehicle' and active),
    'message', case v
      when 'unassigned_needs_a_claim' then
        'This job is not on any car yet, and more than one car is running. '
        || 'Claim it for your vehicle, or ask the owner to assign it.'
      when 'assigned_elsewhere' then 'This job is on another car.'
      else null end);
end
$$;

/* ===================================================================== */
/* 3. grants                                                              */
/* ===================================================================== */

do $$
declare f text;
begin
  -- The predicates and the reason: readable by any logged-in caller, which
  -- is what every existing guard needs.
  foreach f in array array[
    'public.ns_job_crew_scope(uuid)',
    'public.ns_job_is_mine(uuid)',
    'public.ns_assert_job_is_mine(uuid)',
    'public.ns_can_work_job(uuid)',
    'public.can_work_job(uuid)',
    'public.ns_can_see_property(uuid)',
    'public.job_crew_scope(uuid)',
    'public.claim_job_for_vehicle(text,uuid,text,integer)',
    'public.assign_job_to_vehicle(text,uuid,text,integer,text)']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('grant execute on function %s to authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;

  -- The core authorises nothing, so only the two wrappers above -- and the
  -- service role -- may reach it.
  execute 'revoke all on function public.ns_apply_job_assignment(text,uuid,text,integer,text,text) from public';
  execute 'revoke all on function public.ns_apply_job_assignment(text,uuid,text,integer,text,text) from anon';
  execute 'revoke all on function public.ns_apply_job_assignment(text,uuid,text,integer,text,text) from authenticated';
  execute 'grant execute on function public.ns_apply_job_assignment(text,uuid,text,integer,text,text) to service_role';
end
$$;

/* ===================================================================== */
/* 4. assertions                                                          */
/* ===================================================================== */

do $$
begin
  -- The reconciliation is only real if both names resolve to one rule.
  if pg_get_functiondef('public.can_work_job(uuid)'::regprocedure)
       not like '%ns_job_is_mine%'
     or pg_get_functiondef('public.ns_can_work_job(uuid)'::regprocedure)
       not like '%ns_job_is_mine%' then
    raise exception
      'can_work_job and ns_can_work_job must both read ns_job_is_mine, or '
      'the 15.1 reconciliation has been undone.';
  end if;

  -- The unauthorised core must not be callable from a session.
  if has_function_privilege('authenticated',
       'public.ns_apply_job_assignment(text,uuid,text,integer,text,text)',
       'execute') then
    raise exception 'authenticated can call the unauthorised assignment core';
  end if;
  if has_function_privilege('anon',
       'public.claim_job_for_vehicle(text,uuid,text,integer)', 'execute') then
    raise exception 'anon can claim a job';
  end if;

  -- 12.1's assignment signature must be untouched: api.js and the dispatch
  -- contract both call it by this exact shape.
  if to_regprocedure('public.assign_job_to_vehicle(text,uuid,text,integer,text)')
       is null then
    raise exception
      'assign_job_to_vehicle lost its 12.1 signature; the dispatch contract '
      'and admin/js/lib/api.js both depend on it.';
  end if;

  -- And 11.1's gate is still the only road to completed.
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.ns_jobs'::regclass
       and tgname = 'ns_jobs_completion_gate' and not tgisinternal) then
    raise exception 'ns_jobs_completion_gate is missing';
  end if;
end
$$;
