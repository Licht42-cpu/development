-- ===========================================================================
-- Batch 12.1, part 3: what went wrong at the stop, and the two messages a
-- crew may deliberately send.
--
-- THE DISTINCTION THIS FILE EXISTS TO KEEP. Five things that all mean "we
-- are not working on this right now" and that must never collapse into one
-- another:
--
--   cancelled           the job is off, commercially. ns_jobs.status.
--   skipped             not today. The owner's decision.
--   blocked             we went and could not get in. The crew's report.
--   work_finished       the crew has downed tools at the property.
--   accepted_completed  the SERVER accepted a completion with its evidence.
--
-- The last two are the dangerous pair. 11.1 made completion an operation
-- with evidence, a version and an immutable history, and closed the two
-- bypasses that existed. Nothing in this file may open a third: the
-- dispatch state is its own column, `work_finished` is not completion, and
-- ns_job_dispatch_status reports both side by side so a screen cannot
-- accidentally render one as the other.
--
-- NOTIFICATIONS. Two deliberate crew actions -- "on the way" and "please
-- let us in" -- through the EXISTING `notifications` table that Batch 2/5
-- already write to. Four outcomes are kept apart, because three of them get
-- reported as success by systems that were not thinking:
--
--   accepted        we recorded the request and queued a message.
--   delivered       the provider says it went.
--   provider_failed the provider says it did not.
--   unknown         we asked and do not know. NOT a success.
--   unavailable     there is no SMS provider configured, or no number on
--                   file. NOT a send, NOT a failure, and not retryable
--                   until somebody fixes the configuration.
--
-- Implemented and tested against PROVIDER DOUBLES. No real message is sent
-- by anything here, no provider is configured, and no live setting changes.
--
-- NOT APPLIED ANYWHERE.
-- ===========================================================================

/* ===================================================================== */
/* 1. the dispatch state of a stop                                        */
/* ===================================================================== */

create table if not exists public.ns_job_dispatch_state (
  job_id       uuid primary key references public.ns_jobs(id) on delete cascade,
  state        text not null default 'planned',
  reason       text,
  set_by       uuid references auth.users(id),
  set_at       timestamptz not null default now(),
  lock_version integer not null default 1,

  constraint ns_job_dispatch_state_known check (state in (
    'planned',        -- on the day, nothing reported
    'skipped',        -- the owner took it off today
    'blocked',        -- the crew could not get in
    'work_finished')),-- tools down at the property; NOT a completion

  -- Anything other than "planned" needs a sentence. "Skipped" with no
  -- reason is how a visit disappears.
  constraint ns_job_dispatch_state_reasoned check (
    state = 'planned' or coalesce(btrim(reason), '') <> ''),
  constraint ns_job_dispatch_state_lock_positive check (lock_version >= 1)
);

comment on table public.ns_job_dispatch_state is
  'Where a stop stands today. `work_finished` is the crew saying it has '
  'downed tools; it is NOT a completion and grants nothing. An accepted '
  'completion lives in ns_job_completions (Batch 11.1) and is reached only '
  'through complete_job_with_evidence.';

create table if not exists public.ns_job_issues (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references public.ns_jobs(id) on delete cascade,

  kind          text not null,
  reason        text not null,

  -- For a breakdown: which tool. Null for blocked access, and null is also
  -- legitimate for a breakdown of something not in the catalogue -- which
  -- is reported as unknown rather than guessed at.
  material_id   uuid references public.ns_materials(id) on delete set null,

  reported_by   uuid references auth.users(id),
  reported_at   timestamptz not null default now(),

  resolution_state text not null default 'open',
  resolved_by   uuid references auth.users(id),
  resolved_at   timestamptz,
  resolution_note text,

  constraint ns_job_issues_kind_known check (kind in (
    'blocked_access', 'equipment_breakdown')),
  constraint ns_job_issues_reason_present check (btrim(reason) <> ''),
  constraint ns_job_issues_resolution_known check (resolution_state in (
    'open',
    'resolved',          -- dealt with; the work can proceed
    'work_rescheduled',  -- moved to another day
    'work_cancelled')),  -- the job is off, which is a COMMERCIAL decision
                         -- recorded on the job, not implied by this row
  constraint ns_job_issues_resolution_complete check (
    (resolution_state = 'open')
    = (resolved_at is null and resolved_by is null
       and coalesce(btrim(resolution_note), '') = ''))
);

create index if not exists ns_job_issues_open_idx
  on public.ns_job_issues (job_id)
  where resolution_state = 'open';

comment on table public.ns_job_issues is
  'Deliberate crew reports: we could not get in, or the kit broke. An '
  'issue never changes the job''s commercial status and never completes or '
  'cancels anything. Resolution is the owner''s and is recorded with who, '
  'when and why.';

/** The five states, side by side, so nothing has to infer one from
 *  another. `completion` comes from 11.1's own tables; this file cannot
 *  write it and does not try. */
create or replace view public.ns_job_dispatch_status as
  select j.id as job_id,
         j.status                       as job_status,
         coalesce(d.state, 'planned')   as dispatch_state,
         d.reason                       as dispatch_reason,
         d.lock_version                 as dispatch_lock_version,
         case
           -- 11.1's own helper, not a re-derivation: a reopen there is a
           -- correction row, not a column on the completion, and copying
           -- the rule would be the drift that review found in the load DTO.
           when public.ns_job_completion_is_open(j.id) then 'accepted'
           when exists (select 1 from public.ns_job_completions c
                         where c.job_id = j.id) then 'reopened'
           else 'none'
         end                            as completion_state,
         (select count(*) from public.ns_job_issues i
           where i.job_id = j.id and i.resolution_state = 'open')
                                        as open_issue_count
    from public.ns_jobs j
    left join public.ns_job_dispatch_state d on d.job_id = j.id;

comment on view public.ns_job_dispatch_status is
  'job_status (commercial), dispatch_state (today), completion_state '
  '(11.1, authoritative) and open issues, reported separately. Reading '
  'work_finished as completed is the mistake this view exists to prevent.';

/* ===================================================================== */
/* 2. who may report, and who may resolve                                 */
/* ===================================================================== */

/** Whether the caller may act on this job today: the owner, or the crew of
 *  the vehicle it is dispatched to (including the one-vehicle default). */
create or replace function public.ns_can_work_job(p_job_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when not public.is_admin() then false
    when public.is_owner() then true
    when p_job_id is null then false
    else exists (
      select 1 from public.ns_jobs j
        left join public.ns_job_vehicle_assignments a on a.job_id = j.id
       where j.id = p_job_id
         and (
           a.location_id = public.current_crew_vehicle()
           or (a.job_id is null
               and public.current_crew_vehicle() is not null
               and (select count(*) from public.ns_stock_locations
                     where kind = 'vehicle' and active) = 1)))
  end
$$;

/** Report a problem at a stop.
 *
 *  A blocked-access report also puts the stop in the `blocked` state,
 *  because that is literally what the crew is saying. A breakdown does NOT:
 *  a broken pressure washer does not necessarily stop the visit, and
 *  deciding that is the owner's. Both are visible either way. */
create or replace function public.report_job_issue(
  p_client_operation_id text,
  p_job_id              uuid,
  p_kind                text,
  p_reason              text,
  p_material_id         uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_print   text;
  v_replay  jsonb;
  v_issue   public.ns_job_issues;
  v_receipt jsonb;
begin
  if not public.is_admin() then
    raise exception 'report_job_issue is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  if not public.ns_can_work_job(p_job_id) then
    raise exception
      'That job is not on your vehicle, so it is not yours to report on.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception
      'Say what happened. A report with no reason cannot be acted on.'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_kind not in ('blocked_access', 'equipment_breakdown') then
    raise exception 'kind must be blocked_access or equipment_breakdown'
      using errcode = 'invalid_parameter_value';
  end if;

  v_print := public.ns_load_intent_fingerprint(jsonb_build_object(
    'job_id', p_job_id, 'kind', p_kind, 'reason', btrim(p_reason),
    'material_id', p_material_id));

  v_replay := public.ns_dispatch_replay_guard(
    p_client_operation_id, 'issue', v_print);
  if v_replay is not null then return v_replay; end if;

  insert into public.ns_job_issues
    (job_id, kind, reason, material_id, reported_by)
  values
    (p_job_id, p_kind, btrim(p_reason), p_material_id, auth.uid())
  returning * into v_issue;

  if p_kind = 'blocked_access' then
    insert into public.ns_job_dispatch_state (job_id, state, reason, set_by)
    values (p_job_id, 'blocked', btrim(p_reason), auth.uid())
    on conflict (job_id) do update
       set state = 'blocked',
           reason = excluded.reason,
           set_by = excluded.set_by,
           set_at = now(),
           lock_version = public.ns_job_dispatch_state.lock_version + 1;
  end if;

  v_receipt := jsonb_build_object(
    'issue_id',    v_issue.id,
    'job_id',      p_job_id,
    'kind',        v_issue.kind,
    'reason',      v_issue.reason,
    'material_id', v_issue.material_id,
    'reported_at', v_issue.reported_at,
    'resolution_state', v_issue.resolution_state,
    'replayed',    false,
    -- Spelled out in the receipt, because a screen that assumed otherwise
    -- would be the bug.
    'job_status_changed',      false,
    'completion_recorded',     false,
    'dispatch_state', (select state from public.ns_job_dispatch_state
                        where job_id = p_job_id));

  insert into public.ns_dispatch_operations
    (client_operation_id, kind, location_id, work_date, intent_fingerprint,
     actor_id, receipt)
  values
    (p_client_operation_id, 'issue',
     (select location_id from public.ns_job_vehicle_assignments where job_id = p_job_id),
     null, v_print, auth.uid(), v_receipt);

  return v_receipt;
end
$$;

/** Resolve an issue. Owner-only, reasoned, and it does NOT cancel the job:
 *  `work_cancelled` records that the owner decided so, and the commercial
 *  status is still changed on the job itself, deliberately, where the quote
 *  guards can see it. */
create or replace function public.resolve_job_issue(
  p_client_operation_id text,
  p_issue_id            uuid,
  p_resolution_state    text,
  p_note                text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_print   text;
  v_replay  jsonb;
  v_issue   public.ns_job_issues;
  v_receipt jsonb;
begin
  if not public.is_owner() then
    raise exception
      'Resolving a reported problem is the owner''s call. A crew reports; '
      'the office decides what happens to the job.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_resolution_state not in ('resolved', 'work_rescheduled', 'work_cancelled') then
    raise exception
      'resolution must be resolved, work_rescheduled or work_cancelled'
      using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(btrim(p_note), '') = '' then
    raise exception 'Say how it was resolved'
      using errcode = 'invalid_parameter_value';
  end if;

  v_print := public.ns_load_intent_fingerprint(jsonb_build_object(
    'issue_id', p_issue_id, 'resolution_state', p_resolution_state,
    'note', btrim(p_note)));

  v_replay := public.ns_dispatch_replay_guard(
    p_client_operation_id, 'issue_resolution', v_print);
  if v_replay is not null then return v_replay; end if;

  update public.ns_job_issues
     set resolution_state = p_resolution_state,
         resolved_by = auth.uid(),
         resolved_at = now(),
         resolution_note = btrim(p_note)
   where id = p_issue_id and resolution_state = 'open'
  returning * into v_issue;
  if not found then
    raise exception
      'No open issue %. An issue is resolved once; a second resolution '
      'would rewrite the first.', p_issue_id
      using errcode = 'no_data_found';
  end if;

  -- A resolved blockage puts the stop back on the day. A rescheduled or
  -- cancelled one does not: the owner moves or ends the work explicitly,
  -- and pretending otherwise here would be the silent cancel §4 forbids.
  if v_issue.kind = 'blocked_access' and p_resolution_state = 'resolved' then
    update public.ns_job_dispatch_state
       set state = 'planned', reason = null, set_by = auth.uid(),
           set_at = now(), lock_version = lock_version + 1
     where job_id = v_issue.job_id and state = 'blocked';
  end if;

  v_receipt := jsonb_build_object(
    'issue_id',         v_issue.id,
    'job_id',           v_issue.job_id,
    'resolution_state', v_issue.resolution_state,
    'resolution_note',  v_issue.resolution_note,
    'resolved_at',      v_issue.resolved_at,
    'replayed',         false,
    'job_status_changed', false,
    'dispatch_state', (select coalesce(state, 'planned')
                         from public.ns_job_dispatch_state
                        where job_id = v_issue.job_id));

  insert into public.ns_dispatch_operations
    (client_operation_id, kind, location_id, work_date, intent_fingerprint,
     actor_id, receipt)
  values
    (p_client_operation_id, 'issue_resolution', null, null, v_print,
     auth.uid(), v_receipt);

  return v_receipt;
end
$$;

/** Set a stop's dispatch state deliberately.
 *
 *  `skipped` is the owner's. `work_finished` and `blocked` are the crew's
 *  to report. Returning to `planned` is the owner's, because undoing
 *  somebody's report of what happened at a property is a decision. */
create or replace function public.set_dispatch_stage(
  p_client_operation_id text,
  p_job_id              uuid,
  p_state               text,
  p_reason              text default null,
  p_expected_version    integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_print   text;
  v_replay  jsonb;
  v_row     public.ns_job_dispatch_state;
  v_receipt jsonb;
begin
  if not public.is_admin() then
    raise exception 'set_dispatch_stage is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  if p_state not in ('planned', 'skipped', 'blocked', 'work_finished') then
    raise exception
      'state must be planned, skipped, blocked or work_finished. An '
      'accepted completion is not a dispatch state: it is '
      'complete_job_with_evidence.'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_state in ('skipped', 'planned') and not public.is_owner() then
    raise exception
      'Taking a stop off the day, or putting it back, is the owner''s call.'
      using errcode = 'insufficient_privilege';
  end if;
  if not public.ns_can_work_job(p_job_id) then
    raise exception 'That job is not on your vehicle'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_state <> 'planned' and coalesce(btrim(p_reason), '') = '' then
    raise exception 'Say why: "%" without a reason is not a report', p_state
      using errcode = 'invalid_parameter_value';
  end if;

  v_print := public.ns_load_intent_fingerprint(jsonb_build_object(
    'job_id', p_job_id, 'state', p_state, 'reason', p_reason,
    'expected_version', p_expected_version));

  v_replay := public.ns_dispatch_replay_guard(
    p_client_operation_id, 'stage', v_print);
  if v_replay is not null then return v_replay; end if;

  select * into v_row from public.ns_job_dispatch_state
   where job_id = p_job_id for update;

  if found then
    if p_expected_version is not null and p_expected_version <> v_row.lock_version then
      raise exception
        'That stop was updated by somebody else (you had version %, it is '
        'now %). Reload it.', p_expected_version, v_row.lock_version
        using errcode = 'check_violation';
    end if;
    update public.ns_job_dispatch_state
       set state = p_state,
           reason = case when p_state = 'planned' then null else btrim(p_reason) end,
           set_by = auth.uid(), set_at = now(),
           lock_version = lock_version + 1
     where job_id = p_job_id
    returning * into v_row;
  else
    insert into public.ns_job_dispatch_state (job_id, state, reason, set_by)
    values (p_job_id, p_state,
            case when p_state = 'planned' then null else btrim(p_reason) end,
            auth.uid())
    returning * into v_row;
  end if;

  v_receipt := jsonb_build_object(
    'job_id',       p_job_id,
    'state',        v_row.state,
    'reason',       v_row.reason,
    'lock_version', v_row.lock_version,
    'set_at',       v_row.set_at,
    'replayed',     false,
    -- `work_finished` is the one that gets misread, so the receipt says it.
    'completion_state', (select completion_state
                           from public.ns_job_dispatch_status
                          where job_id = p_job_id),
    'is_completion', false);

  insert into public.ns_dispatch_operations
    (client_operation_id, kind, location_id, work_date, intent_fingerprint,
     actor_id, receipt)
  values
    (p_client_operation_id, 'stage',
     (select location_id from public.ns_job_vehicle_assignments where job_id = p_job_id),
     null, v_print, auth.uid(), v_receipt);

  return v_receipt;
end
$$;

/* ===================================================================== */
/* 3. the two customer-facing messages                                    */
/* ===================================================================== */

/** The configured SMS provider, or null. Read the same way the operating
 *  timezone is: from app_settings, with no invented default, and a missing
 *  one is a state rather than an error. */
create or replace function public.ns_sms_provider()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v text;
begin
  if to_regclass('public.app_settings') is null then return null; end if;
  begin
    execute $q$
      select nullif(btrim(coalesce(value::jsonb ->> 'sms_provider', '')), '')
        from public.app_settings where key = 'notifications' limit 1
    $q$ into v;
  exception when others then
    return null;
  end;
  return v;
end
$$;

create table if not exists public.ns_notification_requests (
  id                  uuid primary key default gen_random_uuid(),
  client_operation_id text not null unique,

  job_id              uuid not null references public.ns_jobs(id) on delete cascade,
  kind                text not null,
  channel             text not null,

  requested_by        uuid references auth.users(id),
  requested_at        timestamptz not null default now(),

  -- What we resolved from the JOB's customer. Never a caller-supplied
  -- address: a crew asking us to text "a number they have" is how a
  -- customer's details leak to the wrong person.
  recipient           text,

  -- The queued row in the EXISTING notifications table, when there is one.
  -- Null for every outcome that is not a send.
  --
  -- NO INLINE FOREIGN KEY. `notifications` is one of the live-only tables
  -- this repository has no base schema for (batch7-1 findings, 4b), so a
  -- migration may only touch it additively or through introspection. The
  -- key is added below if and only if the table is there, which is the
  -- same pattern the earlier batches use for ns_jobs and properties.
  notification_id     uuid,

  delivery_state      text not null,
  provider_message_id text,
  provider_error      text,
  resolved_at         timestamptz,

  constraint ns_notification_requests_kind_known check (kind in (
    'on_the_way', 'access_request')),
  constraint ns_notification_requests_channel_known check (channel in ('sms', 'email')),
  constraint ns_notification_requests_state_known check (delivery_state in (
    'accepted',        -- recorded and queued
    'delivered',       -- the provider says it went
    'provider_failed', -- the provider says it did not
    'unknown',         -- we asked and do not know. NOT a success.
    'unavailable')),   -- no provider configured, or no contact on file
  -- A SEND has a queued row; only `unavailable` -- which never queued
  -- anything -- does not. A provider_failed send still has its row: the
  -- message existed, the provider rejected it, and deleting the evidence
  -- would be the wrong way to record that.
  constraint ns_notification_requests_send_has_a_row check (
    (delivery_state = 'unavailable') = (notification_id is null)),
  constraint ns_notification_requests_failure_explained check (
    delivery_state <> 'provider_failed' or coalesce(btrim(provider_error), '') <> ''),
  constraint ns_notification_requests_unavailable_explained check (
    delivery_state <> 'unavailable' or coalesce(btrim(provider_error), '') <> '')
);

/* ONE LIVE REQUEST PER JOB PER KIND. Two "on the way" texts for the same
   visit is the duplicate this prevents. A finished one (delivered,
   failed, unavailable) does not block a later, deliberate one. */
do $$
begin
  if to_regclass('public.notifications') is not null
     and not exists (
       select 1 from pg_constraint
        where conrelid = 'public.ns_notification_requests'::regclass
          and conname = 'ns_notification_requests_notification_fk') then
    execute 'alter table public.ns_notification_requests
               add constraint ns_notification_requests_notification_fk
               foreign key (notification_id)
               references public.notifications(id) on delete set null';
  end if;
end
$$;

create unique index if not exists ns_notification_requests_one_live
  on public.ns_notification_requests (job_id, kind)
  where delivery_state in ('accepted', 'unknown');

create index if not exists ns_notification_requests_job_idx
  on public.ns_notification_requests (job_id);

comment on table public.ns_notification_requests is
  'A crew''s deliberate request to tell a customer something, and what '
  'became of it. Five outcomes, four of which are not a successful send. '
  'The request is ours; the message row is the existing notifications '
  'table''s. Nothing here sends anything by itself.';

/** "On the way", or "we are outside and cannot get in".
 *
 *  DELIBERATE ONLY. Nothing calls this on opening a screen, on a route
 *  change or on a location reading; there is no trigger and no scheduler in
 *  this file. The crew presses a button.
 *
 *  Returns a receipt whose `delivery_state` is the honest outcome. A
 *  missing provider or a missing number is `unavailable` with a reason --
 *  it is not an exception, because the crew needs to see it on the screen
 *  rather than a red toast, and it is not a success either. */
create or replace function public.request_job_notification(
  p_client_operation_id text,
  p_job_id              uuid,
  p_kind                text,
  p_channel             text default 'sms'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_print    text;
  v_replay   jsonb;
  v_job      public.ns_jobs;
  v_cust     record;
  v_provider text;
  v_to       text;
  v_note     uuid;
  v_req      public.ns_notification_requests;
  v_state    text;
  v_why      text;
  v_subject  text;
  v_receipt  jsonb;
begin
  if not public.is_admin() then
    raise exception 'request_job_notification is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  if not public.ns_can_work_job(p_job_id) then
    raise exception
      'That job is not on your vehicle, so its customer is not yours to '
      'message.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_kind not in ('on_the_way', 'access_request') then
    raise exception 'kind must be on_the_way or access_request'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_channel not in ('sms', 'email') then
    raise exception 'channel must be sms or email'
      using errcode = 'invalid_parameter_value';
  end if;

  v_print := public.ns_load_intent_fingerprint(jsonb_build_object(
    'job_id', p_job_id, 'kind', p_kind, 'channel', p_channel));
  v_replay := public.ns_dispatch_replay_guard(
    p_client_operation_id, 'notification', v_print);
  if v_replay is not null then return v_replay; end if;

  select * into v_job from public.ns_jobs where id = p_job_id;
  if not found then
    raise exception 'No such job %', p_job_id using errcode = 'no_data_found';
  end if;

  select c.id, c.name, c.phone, c.email into v_cust
    from public.customers c where c.id = v_job.customer_id;

  v_provider := public.ns_sms_provider();
  v_to := case when p_channel = 'sms' then nullif(btrim(coalesce(v_cust.phone, '')), '')
               else lower(nullif(btrim(coalesce(v_cust.email, '')), '')) end;

  -- The two unavailable cases, told apart, because they are fixed by
  -- different people in different places.
  if p_channel = 'sms' and v_provider is null then
    v_state := 'unavailable';
    v_why := 'No SMS provider is configured, so nothing was sent. Set one '
             'in Settings (notifications.sms_provider).';
  elsif v_to is null then
    v_state := 'unavailable';
    v_why := 'This customer has no ' || p_channel || ' on file, so nothing '
             'was sent.';
  else
    v_state := 'accepted';
  end if;

  if v_state = 'accepted' then
    v_subject := case p_kind
      when 'on_the_way' then 'Nova Shield is on the way'
      else 'Nova Shield needs access at your property' end;

    /* The payload carries what the customer needs and NOTHING ELSE. No
       access code, no internal note, no other customer's history: a
       message payload is stored, replayed and rendered, and 12.1's whole
       point about private columns would be undone by leaking one here. */
    insert into public.notifications
      (kind, channel, recipient, subject, payload, job_id)
    values
      ('dispatch_' || p_kind, p_channel, v_to, v_subject,
       jsonb_build_object(
         'job_id',   p_job_id,
         'kind',     p_kind,
         'customer', v_cust.name,
         'requested_at', now()),
       p_job_id)
    returning id into v_note;
  end if;

  begin
    insert into public.ns_notification_requests
      (client_operation_id, job_id, kind, channel, requested_by, recipient,
       notification_id, delivery_state, provider_error)
    values
      (p_client_operation_id, p_job_id, p_kind, p_channel, auth.uid(), v_to,
       v_note, v_state, v_why)
    returning * into v_req;
  exception when unique_violation then
    -- The partial index, not the key: a live request for this job and kind
    -- already exists. Honest conflict rather than a second text.
    raise exception
      'There is already a live % request for this job. Wait for its '
      'outcome, or resolve it, before sending another.', p_kind
      using errcode = 'unique_violation';
  end;

  v_receipt := jsonb_build_object(
    'request_id',      v_req.id,
    'job_id',          p_job_id,
    'kind',            p_kind,
    'channel',         p_channel,
    'delivery_state',  v_req.delivery_state,
    'reason',          v_req.provider_error,
    'notification_id', v_req.notification_id,
    -- Masked. The crew asked us to tell the customer; it does not need the
    -- number read back to it.
    'recipient_known', v_to is not null,
    'provider_configured', v_provider is not null,
    'replayed',        false,
    'sent',            false);

  insert into public.ns_dispatch_operations
    (client_operation_id, kind, location_id, work_date, intent_fingerprint,
     actor_id, receipt)
  values
    (p_client_operation_id, 'notification',
     (select location_id from public.ns_job_vehicle_assignments where job_id = p_job_id),
     null, v_print, auth.uid(), v_receipt);

  return v_receipt;
end
$$;

/** What the provider said, recorded by whatever is driving the provider.
 *
 *  THE HONEST RETRY RULE, because the provider may have neither
 *  idempotency nor an outcome lookup:
 *
 *   * `delivered` and `provider_failed` are terminal.
 *   * `unknown` means we do not know whether the customer got it. It stays
 *     live and keeps blocking a second request, because a retry might be
 *     the customer's second identical text. Clearing it is a human
 *     decision: resolve it to `provider_failed` (we believe it did not
 *     arrive) or `delivered` (we believe it did), and say so in the error
 *     or the message id.
 *
 *  Owner-only. The crew does not get to declare its own message delivered. */
create or replace function public.record_notification_outcome(
  p_request_id          uuid,
  p_delivery_state      text,
  p_provider_message_id text default null,
  p_provider_error      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_req public.ns_notification_requests;
begin
  if not public.is_owner() then
    raise exception
      'Recording what the provider did is the owner''s (or the server''s). '
      'A crew cannot mark its own message delivered.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_delivery_state not in ('delivered', 'provider_failed', 'unknown') then
    raise exception
      'A provider outcome is delivered, provider_failed or unknown. '
      '"accepted" and "unavailable" are ours, not the provider''s.'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_delivery_state = 'provider_failed'
     and coalesce(btrim(p_provider_error), '') = '' then
    raise exception 'A failure needs the provider''s reason'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_req from public.ns_notification_requests
   where id = p_request_id for update;
  if not found then
    raise exception 'No such notification request %', p_request_id
      using errcode = 'no_data_found';
  end if;
  if v_req.delivery_state in ('delivered', 'provider_failed') then
    raise exception
      'Request % already finished as %. A provider outcome is recorded '
      'once.', p_request_id, v_req.delivery_state
      using errcode = 'check_violation';
  end if;
  if v_req.delivery_state = 'unavailable' then
    raise exception
      'Request % was never sent (%), so the provider has nothing to say '
      'about it.', p_request_id, coalesce(v_req.provider_error, 'unavailable')
      using errcode = 'check_violation';
  end if;

  update public.ns_notification_requests
     set delivery_state = p_delivery_state,
         provider_message_id = coalesce(p_provider_message_id, provider_message_id),
         provider_error = case when p_delivery_state = 'provider_failed'
                               then btrim(p_provider_error)
                               else provider_error end,
         resolved_at = case when p_delivery_state = 'unknown' then null else now() end
   where id = p_request_id
  returning * into v_req;

  -- The existing notifications row keeps its own truth: sent_at is set only
  -- when somebody says it was delivered.
  if p_delivery_state = 'delivered' and v_req.notification_id is not null then
    update public.notifications
       set sent_at = coalesce(sent_at, now()), status = 'sent'
     where id = v_req.notification_id;
  elsif p_delivery_state = 'provider_failed' and v_req.notification_id is not null then
    update public.notifications set status = 'failed'
     where id = v_req.notification_id;
  end if;

  return jsonb_build_object(
    'request_id',      v_req.id,
    'job_id',          v_req.job_id,
    'kind',            v_req.kind,
    'delivery_state',  v_req.delivery_state,
    'provider_message_id', v_req.provider_message_id,
    'reason',          v_req.provider_error,
    'resolved_at',     v_req.resolved_at,
    'still_live',      v_req.delivery_state in ('accepted', 'unknown'));
end
$$;

/** What a job's messages have come to. Scoped the same way the actions are. */
create or replace function public.job_notification_requests(p_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'job_notification_requests is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  if not public.ns_can_work_job(p_job_id) then
    raise exception 'That job is not on your vehicle'
      using errcode = 'insufficient_privilege';
  end if;

  return jsonb_build_object(
    'job_id', p_job_id,
    'provider_configured', public.ns_sms_provider() is not null,
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
               'request_id',     r.id,
               'kind',           r.kind,
               'channel',        r.channel,
               'delivery_state', r.delivery_state,
               'reason',         r.provider_error,
               'requested_at',   r.requested_at,
               'resolved_at',    r.resolved_at,
               'recipient_known', r.recipient is not null,
               'still_live',     r.delivery_state in ('accepted', 'unknown'))
             order by r.requested_at desc)
        from public.ns_notification_requests r
       where r.job_id = p_job_id), '[]'::jsonb));
end
$$;

/* ===================================================================== */
/* 4. RLS, grants and assertions                                          */
/* ===================================================================== */

alter table public.ns_job_dispatch_state enable row level security;
alter table public.ns_job_issues enable row level security;
alter table public.ns_notification_requests enable row level security;

do $$
declare
  t text;
begin
  execute 'drop policy if exists ns_job_dispatch_state_read on public.ns_job_dispatch_state';
  execute 'create policy ns_job_dispatch_state_read on public.ns_job_dispatch_state
             for select to authenticated using (public.ns_can_work_job(job_id))';
  execute 'drop policy if exists ns_job_issues_read on public.ns_job_issues';
  execute 'create policy ns_job_issues_read on public.ns_job_issues
             for select to authenticated using (public.ns_can_work_job(job_id))';
  execute 'drop policy if exists ns_notification_requests_read on public.ns_notification_requests';
  execute 'create policy ns_notification_requests_read on public.ns_notification_requests
             for select to authenticated using (public.ns_can_work_job(job_id))';

  foreach t in array array[
    'public.ns_job_dispatch_state', 'public.ns_job_issues',
    'public.ns_notification_requests']
  loop
    execute format('revoke all on %s from public', t);
    execute format('revoke all on %s from anon', t);
    execute format('grant select on %s to authenticated', t);
    execute format('grant all on %s to service_role', t);
  end loop;
end
$$;

-- The recipient column is the one thing on the request table that nobody
-- needs to read back: the reads report `recipient_known` instead.
do $$
begin
  execute 'revoke all on public.ns_notification_requests from authenticated';
  execute 'grant select (id, job_id, kind, channel, requested_by, requested_at,
                         notification_id, delivery_state, provider_message_id,
                         provider_error, resolved_at)
             on public.ns_notification_requests to authenticated';
end
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.ns_can_work_job(uuid)',
    'public.ns_sms_provider()',
    'public.report_job_issue(text,uuid,text,text,uuid)',
    'public.resolve_job_issue(text,uuid,text,text)',
    'public.set_dispatch_stage(text,uuid,text,text,integer)',
    'public.request_job_notification(text,uuid,text,text)',
    'public.record_notification_outcome(uuid,text,text,text)',
    'public.job_notification_requests(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('grant execute on function %s to authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;

  execute 'revoke all on public.ns_job_dispatch_status from public';
  execute 'revoke all on public.ns_job_dispatch_status from anon';
  execute 'grant select on public.ns_job_dispatch_status to authenticated';
  execute 'grant all on public.ns_job_dispatch_status to service_role';
end
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.report_job_issue(text,uuid,text,text,uuid)',
    'public.set_dispatch_stage(text,uuid,text,text,integer)',
    'public.request_job_notification(text,uuid,text,text)',
    'public.record_notification_outcome(uuid,text,text,text)'
  ]
  loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception 'anon can execute %, which it must not', f;
    end if;
  end loop;

  if has_column_privilege('authenticated', 'public.ns_notification_requests',
                          'recipient', 'select') then
    raise exception
      'authenticated can read the resolved recipient, which the reads '
      'deliberately report only as recipient_known';
  end if;

  foreach f in array array[
    'public.ns_job_dispatch_state', 'public.ns_job_issues',
    'public.ns_notification_requests']
  loop
    if has_table_privilege('authenticated', f, 'insert')
       or has_table_privilege('authenticated', f, 'update')
       or has_table_privilege('authenticated', f, 'delete') then
      raise exception
        'authenticated can write % directly, so a report could be forged '
        'or a message outcome rewritten', f;
    end if;
  end loop;

  -- 11.1's completion guard must still be the only way in. If this batch
  -- had quietly dropped it, work_finished could become completed.
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.ns_jobs'::regclass
       and tgname = 'ns_jobs_completion_gate'
       and not tgisinternal) then
    raise exception
      'the Batch 11.1 completion guard is not installed on ns_jobs, so '
      'dispatch could mark a job complete without evidence';
  end if;
end
$$;
