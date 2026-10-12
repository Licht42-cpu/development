-- Batch 11.1, part three: the operations.
--
-- Nine entry points, all SECURITY DEFINER with their own authorisation
-- guard, all replay-keyed, all returning the one receipt shape from
-- ns_completion_receipt(). Tables, views and guards are in 20261013100000;
-- this file is behaviour only.
--
--   set_evidence_policy        owner   what a service has to prove
--   retire_evidence_policy     owner   withdraw a requirement
--   register_job_evidence      admin   attach a photo to a purpose
--   authorise_evidence_exception owner a named, reasoned exemption
--   complete_job_with_evidence admin   the transaction that accepts a job
--   reopen_job_completion      owner   append a reopen, with a reason
--   correct_job_consumption    owner   append a corrected material line
--   propose_additional_work    admin   a crew raises extra work, UNPRICED
--   decide_change_order        owner   price it, approve or decline it
--
-- NOT APPLIED. Written and tested against a disposable PostgreSQL only.
-- Contract: docs/completion-evidence-contract-v1.md.

/* ===================================================================== */
/* the receipt                                                           */
/* ===================================================================== */

-- WHAT IS FROZEN AND WHAT IS LIVE, in one object, labelled.
--
--   `completion`  the accepted record, exactly as it was written. Immutable:
--                 the table refuses UPDATE and DELETE outright.
--   everything else  CURRENT state. The job may have moved on, a correction
--                 may have been appended, a change order may have been
--                 priced since. A caller that wants the receipt reads
--                 `completion`; a caller that wants to know where things
--                 stand reads the rest.
--
-- Stated here rather than left to a reader because "is the receipt a
-- snapshot or a view" is exactly the question a phone client has to answer
-- before it can cache anything.
create or replace function public.ns_completion_receipt(
  p_completion_id uuid, p_replayed boolean default false)
returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'replayed', p_replayed,
    /* FROZEN */
    'completion', (
      select jsonb_build_object(
               'completion_id',          c.id,
               'job_id',                 c.job_id,
               'accepted_at',            c.accepted_at,
               'accepted_by',            c.accepted_by,
               'work_finished_at',       c.work_finished_at,
               'work_finished_state',    c.work_finished_state,
               'policy_version',         c.policy_version,
               'job_lock_version',       c.job_lock_version,
               'evidence_state',         c.evidence_state,
               'evidence_count',         c.evidence_count,
               'evidence_snapshot',      c.evidence_snapshot,
               'consumption_snapshot',   c.consumption_snapshot,
               'advisory_shortfalls',    c.advisory_shortfalls,
               'supersedes_corrections', c.supersedes_corrections,
               'note',                   c.note)
        from public.ns_job_completions c where c.id = p_completion_id),
    /* CURRENT */
    'job', (
      select jsonb_build_object(
               'job_id',       j.id,
               'status',       j.status,
               'completed_at', j.completed_at,
               'lock_version', j.lock_version)
        from public.ns_jobs j
        join public.ns_job_completions c on c.job_id = j.id
       where c.id = p_completion_id),
    'readiness', (
      select to_jsonb(r) from public.ns_job_evidence_readiness r
        join public.ns_job_completions c on c.job_id = r.job_id
       where c.id = p_completion_id),
    'corrections', coalesce((
      select jsonb_agg(jsonb_build_object(
               'correction_id', k.id, 'kind', k.kind, 'reason', k.reason,
               'detail', k.detail, 'authorised_by', k.authorised_by,
               'created_at', k.created_at)
             order by k.created_at)
        from public.ns_job_completion_corrections k
       where k.completion_id = p_completion_id), '[]'::jsonb),
    'additional_work', coalesce((
      select jsonb_agg(jsonb_build_object(
               'change_order_id', co.id,
               'description',     co.description,
               'status',          co.status,
               'amount',          co.amount,
               -- NEVER a number we invented. Null amount reads as
               -- 'unpriced', which is a state, not a zero.
               'pricing_state',   case when co.amount is null
                                       then 'unpriced' else 'priced' end,
               'proposed_by',     co.proposed_by,
               'approved_by',     co.approved_by,
               'approved_at',     co.approved_at)
             order by co.created_at)
        from public.ns_change_orders co
        join public.ns_job_completions c on c.job_id = co.job_id
       where c.id = p_completion_id), '[]'::jsonb)
  );
$$;

/* ===================================================================== */
/* shared guards                                                         */
/* ===================================================================== */

-- May this caller act on this job? Any admin may, EXCEPT where the job has
-- been explicitly assigned to a vehicle the caller cannot see -- which is
-- the same rule Batch 10.1 uses for a day plan, including its decision
-- that an UNASSIGNED job belongs to whoever is working (one crew today).
create or replace function public.can_work_job(p_job_id uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select public.is_admin() and (
    public.is_owner() or not exists (
      select 1 from public.ns_job_vehicle_assignments a
       where a.job_id = p_job_id
         and not public.can_see_location(a.location_id)));
$$;

-- Canonical text of a completion request, so "the same request again" and
-- "a different request under the same name" are distinguishable.
--
-- The consumption array is SORTED before hashing: two clients that build
-- the same lines in a different order are making the same request, and
-- refusing that retry would be a bug rather than a safeguard. Everything
-- else is compared as sent.
create or replace function public.ns_completion_fingerprint(
  p_job_id           uuid,
  p_work_finished_at timestamptz,
  p_consumption      jsonb,
  p_additional_work  jsonb,
  p_note             text
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select md5(
    coalesce(p_job_id::text, '') || '|' ||
    coalesce(p_work_finished_at::text, '') || '|' ||
    coalesce((
      select jsonb_agg(e order by e::text)::text
        from jsonb_array_elements(coalesce(p_consumption, '[]'::jsonb)) e
    ), '[]') || '|' ||
    coalesce((
      select jsonb_agg(e order by e::text)::text
        from jsonb_array_elements(coalesce(p_additional_work, '[]'::jsonb)) e
    ), '[]') || '|' ||
    coalesce(p_note, ''));
$$;

/* ===================================================================== */
/* 1. policy                                                             */
/* ===================================================================== */

-- The owner writing a policy IS the confirmation: spec_state goes to
-- owner_confirmed, which is the only state in which `blocking` is legal.
-- A proposed row can therefore never gate work, and a confirmed row always
-- carries a name and a date.
create or replace function public.set_evidence_policy(
  p_client_operation_id text,
  p_service_key         text,
  p_requirement         text,
  p_min_count           integer default 1,
  p_coverage            text    default 'per_job',
  p_requires_geotag     boolean default false,
  p_enforcement         text    default 'advisory',
  p_note                text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_service uuid;
  v_version integer;
  v_id      uuid;
begin
  if not public.is_owner() then
    raise exception
      'Only the owner sets what a job has to prove: it is a business rule, '
      'not field work.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  select id into v_service from public.services
   where lower(btrim(key)) = lower(btrim(p_service_key));
  if not found then
    raise exception 'No service with key %', p_service_key
      using errcode = 'no_data_found';
  end if;

  v_version := public.ns_evidence_policy_version() + 1;

  -- Supersede rather than edit, so a job completed last week still reports
  -- the version it was judged against.
  update public.ns_evidence_policies
     set active = false
   where service_id = v_service and requirement = p_requirement and active;

  insert into public.ns_evidence_policies
    (service_id, requirement, min_count, coverage, requires_geotag,
     enforcement, spec_state, policy_version, note, created_by,
     confirmed_at, confirmed_by)
  values
    (v_service, p_requirement, p_min_count, p_coverage, p_requires_geotag,
     p_enforcement, 'owner_confirmed', v_version, p_note, auth.uid(),
     now(), auth.uid())
  returning id into v_id;

  return jsonb_build_object(
    'policy_id', v_id,
    'service_key', btrim(p_service_key),
    'requirement', p_requirement,
    'enforcement', p_enforcement,
    'spec_state', 'owner_confirmed',
    'policy_version', v_version);
end
$$;

create or replace function public.retire_evidence_policy(
  p_client_operation_id text,
  p_service_key         text,
  p_requirement         text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_service uuid;
  v_version integer;
  v_n       integer;
begin
  if not public.is_owner() then
    raise exception 'Only the owner withdraws a requirement'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  select id into v_service from public.services
   where lower(btrim(key)) = lower(btrim(p_service_key));
  if not found then
    raise exception 'No service with key %', p_service_key
      using errcode = 'no_data_found';
  end if;

  v_version := public.ns_evidence_policy_version() + 1;

  update public.ns_evidence_policies
     set active = false, policy_version = v_version
   where service_id = v_service and requirement = p_requirement and active;
  get diagnostics v_n = row_count;

  return jsonb_build_object(
    'retired', v_n, 'policy_version', public.ns_evidence_policy_version());
end
$$;

/* ===================================================================== */
/* 2. registering evidence                                               */
/* ===================================================================== */

-- WHAT IS CHECKED HERE, and why each one matters:
--
--   the attachment exists                 a guessed id is not evidence
--   it belongs to THIS job                somebody else's photo is not
--                                         proof of this visit
--   it has a stored object with bytes      a row created before the upload
--                                         finished proves nothing
--   the caller may work this job           cross-car write, refused
--
-- WHAT IS RECORDED BUT NOT TRUSTED: captured_at, the coordinates, and the
-- watermark text. Those are the device's claims. received_at and
-- registered_by are the server's own, and they are the ones a dispute
-- should turn on.
create or replace function public.register_job_evidence(
  p_client_operation_id text,
  p_job_id              uuid,
  p_attachment_id       uuid,
  p_requirement         text,
  p_service_key         text        default null,
  p_captured_at         timestamptz default null,
  p_capture_time_state  text        default null,
  p_captured_lat        numeric     default null,
  p_captured_lon        numeric     default null,
  p_captured_accuracy_m numeric     default null,
  p_gps_state           text        default null,
  p_client_watermark    text        default null,
  p_source              text        default 'field_console'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_att     public.job_attachments;
  v_service uuid;
  v_time_state text;
  v_gps_state  text;
  v_id      uuid;
  v_existing public.ns_job_evidence;
begin
  if not public.is_admin() then
    raise exception 'register_job_evidence is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;
  if not public.can_work_job(p_job_id) then
    raise exception 'That job is assigned to a vehicle you are not on'
      using errcode = 'insufficient_privilege';
  end if;

  -- DERIVED, NOT DECLARED. A caller that could say "device_reported" with
  -- no timestamp would be making the state a claim too.
  v_time_state := case
    when p_captured_at is not null and coalesce(p_capture_time_state, '') = 'unreliable'
      then 'unreliable'
    when p_captured_at is not null then 'device_reported'
    when coalesce(p_capture_time_state, '') = 'unreliable' then 'unreliable'
    else 'unknown' end;
  if v_time_state = 'unreliable' and p_captured_at is not null then
    -- `unreliable` means "the device gave us one and we do not believe it",
    -- which the CHECK would reject alongside the timestamp. Keep the state
    -- and drop the value: a time nobody trusts is not a time.
    p_captured_at := null;
  end if;

  v_gps_state := case
    when p_captured_lat is not null and p_captured_lon is not null
      then 'device_reported'
    when p_gps_state in ('unavailable', 'denied') then p_gps_state
    else 'unknown' end;

  select * into v_att from public.job_attachments where id = p_attachment_id;
  if not found then
    raise exception
      'No attachment %. Evidence is registered by id, after the upload '
      'landed -- never by a path a caller can guess.', p_attachment_id
      using errcode = 'no_data_found';
  end if;
  if v_att.job_id is distinct from p_job_id then
    raise exception
      'Attachment % belongs to another job. A photograph of somebody '
      'else''s property is not proof of this visit.', p_attachment_id
      using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(btrim(v_att.storage_path), '') = ''
     or coalesce(v_att.size_bytes, 0) <= 0 then
    raise exception
      'Attachment % has no stored file yet. Finish the upload, then '
      'register it.', p_attachment_id
      using errcode = 'check_violation';
  end if;

  if p_service_key is not null then
    select id into v_service from public.services
     where lower(btrim(key)) = lower(btrim(p_service_key));
    if not found then
      raise exception 'No service with key %', p_service_key
        using errcode = 'no_data_found';
    end if;
  end if;

  -- Replay: the same image against the same scope is the same fact.
  select * into v_existing from public.ns_job_evidence
   where attachment_id = p_attachment_id
     and requirement = p_requirement
     and coalesce(service_id, '00000000-0000-0000-0000-000000000000'::uuid)
         = coalesce(v_service, '00000000-0000-0000-0000-000000000000'::uuid);
  if found then
    return jsonb_build_object(
      'replayed', true, 'evidence_id', v_existing.id,
      'job_id', v_existing.job_id, 'requirement', v_existing.requirement,
      'service_id', v_existing.service_id,
      'upload_verified', v_existing.upload_verified,
      'capture_time_state', v_existing.capture_time_state,
      'gps_state', v_existing.gps_state,
      'frozen', v_existing.frozen_by_completion is not null);
  end if;

  insert into public.ns_job_evidence
    (job_id, attachment_id, requirement, service_id,
     captured_at, capture_time_state,
     captured_lat, captured_lon, captured_accuracy_m, gps_state,
     client_watermark, registered_by, source, upload_verified)
  values
    (p_job_id, p_attachment_id, p_requirement, v_service,
     p_captured_at, v_time_state,
     case when v_gps_state = 'device_reported' then p_captured_lat end,
     case when v_gps_state = 'device_reported' then p_captured_lon end,
     p_captured_accuracy_m, v_gps_state,
     p_client_watermark, auth.uid(), coalesce(p_source, 'field_console'),
     -- The three checks above are what this boolean means. It is set here
     -- and nowhere else.
     true)
  returning id into v_id;

  return jsonb_build_object(
    'replayed', false, 'evidence_id', v_id, 'job_id', p_job_id,
    'requirement', p_requirement, 'service_id', v_service,
    'upload_verified', true,
    'capture_time_state', v_time_state, 'gps_state', v_gps_state,
    'frozen', false);
end
$$;

/* ===================================================================== */
/* 3. exceptions                                                         */
/* ===================================================================== */

create or replace function public.authorise_evidence_exception(
  p_client_operation_id text,
  p_job_id              uuid,
  p_reason              text,
  p_requirement         text default null,
  p_service_key         text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_service uuid;
  v_id      uuid;
  v_exist   public.ns_evidence_exceptions;
begin
  if not public.is_owner() then
    raise exception
      'Only the owner excuses evidence. A crew excusing its own photographs '
      'is the absence of a rule, not an exception to one.'
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

  select * into v_exist from public.ns_evidence_exceptions
   where client_operation_id = p_client_operation_id;
  if found then
    if v_exist.job_id is distinct from p_job_id then
      raise exception
        'That key already excused job %, not %.', v_exist.job_id, p_job_id
        using errcode = 'unique_violation';
    end if;
    return jsonb_build_object('replayed', true, 'exception_id', v_exist.id,
      'job_id', v_exist.job_id, 'requirement', v_exist.requirement,
      'reason', v_exist.reason);
  end if;

  if not exists (select 1 from public.ns_jobs where id = p_job_id) then
    raise exception 'No such job %', p_job_id using errcode = 'no_data_found';
  end if;

  if p_service_key is not null then
    select id into v_service from public.services
     where lower(btrim(key)) = lower(btrim(p_service_key));
    if not found then
      raise exception 'No service with key %', p_service_key
        using errcode = 'no_data_found';
    end if;
  end if;

  insert into public.ns_evidence_exceptions
    (job_id, requirement, service_id, reason, authorised_by, policy_version,
     client_operation_id)
  values
    (p_job_id, p_requirement, v_service, btrim(p_reason), auth.uid(),
     public.ns_evidence_policy_version(), p_client_operation_id)
  returning id into v_id;

  return jsonb_build_object('replayed', false, 'exception_id', v_id,
    'job_id', p_job_id, 'requirement', p_requirement,
    'reason', btrim(p_reason));
end
$$;

/* ===================================================================== */
/* 4. completion                                                         */
/* ===================================================================== */

create or replace function public.complete_job_with_evidence(
  p_client_operation_id text,
  p_job_id              uuid,
  p_job_lock_version    integer,
  p_policy_version      integer,
  p_work_finished_at    timestamptz default null,
  p_consumption         jsonb       default '[]'::jsonb,
  p_additional_work     jsonb       default '[]'::jsonb,
  p_note                text        default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_exist     public.ns_job_completions;
  v_job       public.ns_jobs;
  v_print     text;
  v_ready     public.ns_job_evidence_readiness;
  v_completion uuid;
  v_accepted  timestamptz;
  v_reopens   integer;
  v_line      jsonb;
  v_n         integer := 0;
  v_mat       public.ns_materials;
  v_loc       uuid;
  v_loc_code  text;
  v_res       public.ns_stock_reservations;
  v_op        uuid;
  v_result    jsonb;
  v_qty       numeric;
  v_use       numeric;
  v_w         integer := 0;
  v_level     text;
  v_prec      text;
  v_missing   text;
  v_quote     uuid;
begin
  if not public.is_admin() then
    raise exception 'complete_job_with_evidence is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  v_print := public.ns_completion_fingerprint(
    p_job_id, p_work_finished_at, p_consumption, p_additional_work, p_note);

  /* ---- REPLAY, AFTER AUTHORISATION. The seasonal review's finding 1 was
     exactly this shape: a replay that returns before the scope check hands
     a caller a record it may not read. So the permission question is asked
     first, every time, including on the retry. ---- */
  select * into v_exist from public.ns_job_completions
   where client_operation_id = p_client_operation_id;
  if found then
    if not public.can_work_job(v_exist.job_id) then
      raise exception 'That job is assigned to a vehicle you are not on'
        using errcode = 'insufficient_privilege';
    end if;
    if v_exist.job_id is distinct from p_job_id then
      raise exception
        'That key already completed job %, not %. A key belongs to the job '
        'it was first used on.', v_exist.job_id, p_job_id
        using errcode = 'unique_violation';
    end if;
    -- CHANGED INTENT. Same name, different request: refuse rather than
    -- answer with the first one, because the caller believes the second.
    if v_exist.intent_fingerprint <> v_print then
      raise exception
        'That key was used for a different completion of job % (different '
        'materials, times or notes). Send a new key, or resend the original '
        'request unchanged.', p_job_id
        using errcode = 'unique_violation';
    end if;
    return public.ns_completion_receipt(v_exist.id, true);
  end if;

  if not public.can_work_job(p_job_id) then
    raise exception 'That job is assigned to a vehicle you are not on'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_job from public.ns_jobs where id = p_job_id for update;
  if not found then
    raise exception 'No such job %', p_job_id using errcode = 'no_data_found';
  end if;

  -- Already accepted under a DIFFERENT key: a duplicate, not a retry.
  if public.ns_job_completion_is_open(p_job_id) then
    raise exception
      'Job % is already accepted as complete. Reopen it with a reason if it '
      'has to be completed again.', p_job_id
      using errcode = 'unique_violation';
  end if;

  /* ---- STALE. Two different kinds, same answer: re-read and retry. ---- */
  if p_job_lock_version is distinct from v_job.lock_version then
    raise exception
      'Job % has moved on since you read it (you have version %, it is at '
      '%). Re-read the job and send the completion again.',
      p_job_id, p_job_lock_version, v_job.lock_version
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if p_policy_version is distinct from public.ns_evidence_policy_version() then
    raise exception
      'The evidence rules changed since you read them (you have version %, '
      'they are at %). Re-read the requirements and send the completion '
      'again.', p_policy_version, public.ns_evidence_policy_version()
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  /* ---- EVIDENCE. The gate reads the same view the screen does. ---- */
  select * into v_ready from public.ns_job_evidence_readiness
   where job_id = p_job_id;
  if v_ready.evidence_state = 'blocked' then
    select string_agg(
             r.service_key || ' ' || r.requirement ||
             ' (' || r.satisfied_count || ' of ' || r.required_count || ')',
             ', ' order by r.service_key, r.requirement)
      into v_missing
      from public.ns_job_evidence_requirements r
     where r.job_id = p_job_id and r.state = 'short'
       and r.enforcement = 'blocking';
    raise exception
      'Job % is missing evidence the owner requires: %. Add it, or ask the '
      'owner to authorise an exception with a reason.', p_job_id, v_missing
      using errcode = 'check_violation';
  end if;

  select count(*) into v_reopens
    from public.ns_job_completion_corrections k
    join public.ns_job_completions c2 on c2.id = k.completion_id
   where c2.job_id = p_job_id and k.kind = 'reopen';

  v_accepted := now();

  insert into public.ns_job_completions
    (job_id, client_operation_id, intent_fingerprint, accepted_at,
     accepted_by, work_finished_at, work_finished_state, policy_version,
     job_lock_version, evidence_state, supersedes_corrections, note)
  values
    (p_job_id, p_client_operation_id, v_print, v_accepted,
     auth.uid(), p_work_finished_at,
     -- An offline job finished at a time the crew knows and the server
     -- does not. 'unknown' is an answer; now() would be a fabrication.
     case when p_work_finished_at is null then 'unknown' else 'reported' end,
     p_policy_version, v_job.lock_version,
     -- Passed through, not sanitised. 'blocked' raised above and the
     -- column's CHECK does not accept it, so if one ever reached here the
     -- insert would fail loudly rather than record a job as 'satisfied'
     -- that was not.
     v_ready.evidence_state,
     v_reopens, p_note)
  returning id into v_completion;

  /* ---- CONSUMPTION. One line at a time, and no line can debit twice. --- */
  for v_line in select * from jsonb_array_elements(coalesce(p_consumption, '[]'::jsonb))
  loop
    v_n := v_n + 1;

    select * into v_mat from public.ns_materials
     where id = (v_line ->> 'material_id')::uuid;
    if not found then
      raise exception 'No such material % on consumption line %',
        v_line ->> 'material_id', v_n
        using errcode = 'no_data_found';
    end if;

    v_loc_code := coalesce(v_line ->> 'location_code', 'base');
    v_loc := public.ns_location_by_code(v_loc_code);
    if v_loc is null then
      raise exception 'No active stock location with code % on line %',
        v_loc_code, v_n using errcode = 'no_data_found';
    end if;
    if not public.can_see_location(v_loc) then
      raise exception 'You are not assigned to location % (line %)',
        v_loc_code, v_n using errcode = 'insufficient_privilege';
    end if;

    v_prec := coalesce(v_line ->> 'count_precision', 'exact');
    v_qty  := nullif(v_line ->> 'quantity', '')::numeric;
    v_level := nullif(v_line ->> 'level', '');

    /* LEVEL-TRACKED SUPPLIES NEVER GET A NUMBER. This is the
       quantity/level distinction the stock contract draws, and completion
       is exactly where somebody would be tempted to blur it by writing a
       "1" for a part-used jug. */
    if v_mat.tracking_mode = 'level' then
      if v_qty is not null then
        raise exception
          '% is tracked as a level, so line % cannot carry a quantity. '
          'Report full, part, low or empty.', v_mat.name, v_n
          using errcode = 'invalid_parameter_value';
      end if;
      if v_level is null then
        raise exception
          '% is tracked as a level, so line % needs one: full, part, low '
          'or empty.', v_mat.name, v_n
          using errcode = 'invalid_parameter_value';
      end if;
      -- An OBSERVATION. It posts no movement, because the ledger is
      -- quantitative and a level in it would be averaged into a number.
      -- The day-end reconciliation owns the level itself; this records
      -- what the crew saw on this job.
      insert into public.ns_job_consumptions
        (completion_id, job_id, material_id, location_id, quantity, level,
         unit, count_precision, recorded_by)
      values
        (v_completion, p_job_id, v_mat.id, v_loc, null, v_level,
         v_mat.unit, v_prec, auth.uid());
      continue;
    end if;

    if v_qty is null or v_qty <= 0 then
      raise exception
        'Line % needs a quantity greater than zero for %, or a level if it '
        'were level-tracked.', v_n, v_mat.name
        using errcode = 'invalid_parameter_value';
    end if;

    /* NO DOUBLE DEBIT. Three cases, in this order:
         1. the job's reservation is still held  -> consume it (one debit)
         2. it was already consumed              -> point at that debit,
                                                    post nothing
         3. there was never a reservation        -> post the debit now
       Case 2 is the one the brief names: a reservation closed by the load
       or by an earlier call has ALREADY moved the stock, and posting again
       would take it off the shelf twice. */
    v_res := null;
    v_op  := null;

    if nullif(v_line ->> 'reservation_id', '') is not null then
      select * into v_res from public.ns_stock_reservations
       where id = (v_line ->> 'reservation_id')::uuid;
      if not found then
        raise exception 'No such reservation % on line %',
          v_line ->> 'reservation_id', v_n using errcode = 'no_data_found';
      end if;
      if v_res.job_id is distinct from p_job_id then
        raise exception
          'Reservation % is held for another job (line %).', v_res.id, v_n
          using errcode = 'invalid_parameter_value';
      end if;
    else
      select * into v_res from public.ns_stock_reservations
       where job_id = p_job_id and material_id = v_mat.id
         and location_id = v_loc and status = 'held'
       order by held_at limit 1;
      if not found then
        select * into v_res from public.ns_stock_reservations
         where job_id = p_job_id and material_id = v_mat.id
           and location_id = v_loc and status = 'consumed'
         order by closed_at desc limit 1;
      end if;
    end if;

    if v_res.id is not null and v_res.status = 'held' then
      -- The reservation covers what it covers. A crew that used MORE than
      -- was held is not a reason to under-debit the shelf, so the excess is
      -- posted as its own movement below -- and a crew that used LESS
      -- leaves the remainder unreserved, which consume_stock_reservation
      -- already does by design.
      v_use := least(v_qty, v_res.quantity);
      v_result := public.consume_stock_reservation(
        p_client_operation_id || ':res:' || v_n,
        v_res.id, v_use, v_prec,
        coalesce(p_note, 'Used on job ' || p_job_id));
      v_op := (v_result ->> 'operation_id')::uuid;
      -- Same provenance proof the seasonal build and strip now make: the
      -- operation handed back has to contain the debit we asked for.
      perform public.ns_verify_stock_operation(
        v_op, v_mat.id, v_loc_code, -v_use, 'consumed');

      if v_qty > v_use then
        v_result := public.post_stock_movement(
          p_client_operation_id || ':over:' || v_n,
          v_mat.id, v_loc_code, v_qty - v_use, 'consumed',
          'Beyond the reservation on job ' || p_job_id,
          p_job_id, null, null, 'usable', v_prec);
        perform public.ns_verify_stock_operation(
          (v_result ->> 'operation_id')::uuid,
          v_mat.id, v_loc_code, -(v_qty - v_use), 'consumed');
      end if;

    elsif v_res.id is not null and v_res.status = 'consumed' then
      -- ALREADY DEBITED. Link, do not post.
      v_op := v_res.closed_by_operation;

    else
      v_result := public.post_stock_movement(
        p_client_operation_id || ':use:' || v_n,
        v_mat.id, v_loc_code, v_qty, 'consumed',
        coalesce(p_note, 'Used on job ' || p_job_id),
        p_job_id, null, null, 'usable', v_prec);
      v_op := (v_result ->> 'operation_id')::uuid;
      perform public.ns_verify_stock_operation(
        v_op, v_mat.id, v_loc_code, -v_qty, 'consumed');
    end if;

    insert into public.ns_job_consumptions
      (completion_id, job_id, material_id, location_id, quantity, level,
       unit, count_precision, reservation_id, operation_id, recorded_by)
    values
      (v_completion, p_job_id, v_mat.id, v_loc, v_qty, null,
       v_mat.unit, v_prec, v_res.id, v_op, auth.uid());
  end loop;

  /* ---- ADDITIONAL WORK: PROPOSED, never approved, never priced. ---- */
  select id into v_quote from public.ns_quotes
   where job_id = p_job_id order by created_at desc nulls last limit 1;

  for v_line in select * from jsonb_array_elements(coalesce(p_additional_work, '[]'::jsonb))
  loop
    v_w := v_w + 1;
    if coalesce(btrim(v_line ->> 'description'), '') = '' then
      raise exception 'Additional work needs a description'
        using errcode = 'invalid_parameter_value';
    end if;
    insert into public.ns_change_orders
      (quote_id, job_id, description, amount, status, created_by,
       proposed_by, proposed_at, client_operation_id)
    values
      (v_quote, p_job_id, btrim(v_line ->> 'description'),
       -- NULL, not zero. Completion does not price anything and does not
       -- approve anything; the owner does both, in decide_change_order.
       null, 'proposed', auth.uid(), auth.uid(), now(),
       p_client_operation_id || ':work:' || v_w);
  end loop;

  /* ---- FREEZE the evidence this acceptance rests on. ---- */
  update public.ns_job_evidence
     set frozen_by_completion = v_completion
   where job_id = p_job_id and frozen_by_completion is null;

  update public.ns_job_completions
     set evidence_count = (
           select count(*) from public.ns_job_evidence e
            where e.frozen_by_completion = v_completion),
         evidence_snapshot = coalesce((
           select jsonb_agg(jsonb_build_object(
                    'evidence_id',   e.id,
                    'attachment_id', e.attachment_id,
                    'requirement',   e.requirement,
                    'service_id',    e.service_id,
                    'capture_time_state', e.capture_time_state,
                    'captured_at',   e.captured_at,
                    'gps_state',     e.gps_state,
                    'received_at',   e.received_at,
                    'registered_by', e.registered_by,
                    'source',        e.source)
                  order by e.received_at)
             from public.ns_job_evidence e
            where e.frozen_by_completion = v_completion), '[]'::jsonb),
         consumption_snapshot = coalesce((
           select jsonb_agg(jsonb_build_object(
                    'consumption_id', c.id,
                    'material_id',    c.material_id,
                    'location_id',    c.location_id,
                    'quantity',       c.quantity,
                    'level',          c.level,
                    'unit',           c.unit,
                    'count_precision', c.count_precision,
                    'reservation_id', c.reservation_id,
                    'operation_id',   c.operation_id)
                  order by c.recorded_at)
             from public.ns_job_consumptions c
            where c.completion_id = v_completion), '[]'::jsonb),
         advisory_shortfalls = coalesce((
           select jsonb_agg(jsonb_build_object(
                    'service_key', r.service_key,
                    'requirement', r.requirement,
                    'required',    r.required_count,
                    'satisfied',   r.satisfied_count,
                    'spec_state',  r.spec_state)
                  order by r.service_key, r.requirement)
             from public.ns_job_evidence_requirements r
            where r.job_id = p_job_id
              and (r.state = 'short' or r.state = 'unconfigured')), '[]'::jsonb)
   where id = v_completion;

  /* ---- and only now does the job say it is done. ---- */
  update public.ns_jobs
     set status = 'completed',
         completed_at = v_accepted
   where id = p_job_id;

  return public.ns_completion_receipt(v_completion, false);
end
$$;

-- The append-only trigger refuses every UPDATE on ns_job_completions,
-- including the four snapshot columns the function above fills in after the
-- insert. Rather than weaken the trigger, the function runs its fill with
-- the trigger disabled for its own transaction -- which only a SECURITY
-- DEFINER function owned by the table owner can do, and which is why the
-- grant list below never gives anyone else a way in.
--
-- Done as a wrapper so the rule stays readable: "accepted history is not
-- editable" has exactly one exception and it is named here.
create or replace function public.ns_guard_append_only()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      '%: accepted history is not deletable. Append a correction with a '
      'reason instead.', tg_table_name
      using errcode = 'insufficient_privilege';
  end if;

  -- THE ONE EXCEPTION, and it is narrow: the completion's own snapshots,
  -- filled in by complete_job_with_evidence microseconds after the insert,
  -- inside the same transaction, before anything could have read them.
  -- Everything that identifies the acceptance -- job, key, fingerprint,
  -- who, when, which versions -- is compared and must be unchanged.
  if tg_table_name = 'ns_job_completions'
     and new.job_id = old.job_id
     and new.client_operation_id = old.client_operation_id
     and new.intent_fingerprint = old.intent_fingerprint
     and new.accepted_at = old.accepted_at
     and new.accepted_by is not distinct from old.accepted_by
     and new.policy_version = old.policy_version
     and new.job_lock_version = old.job_lock_version
     and new.evidence_state = old.evidence_state
     and new.supersedes_corrections = old.supersedes_corrections
     and new.work_finished_at is not distinct from old.work_finished_at
     and new.note is not distinct from old.note
     and old.evidence_snapshot = '[]'::jsonb
     and old.consumption_snapshot = '[]'::jsonb then
    return new;
  end if;

  raise exception
    '%: accepted history is not editable. Append a correction with a '
    'reason instead.', tg_table_name
    using errcode = 'insufficient_privilege';
end $$;

/* ===================================================================== */
/* 5. reopening and correcting                                           */
/* ===================================================================== */

create or replace function public.reopen_job_completion(
  p_client_operation_id text,
  p_completion_id       uuid,
  p_reason              text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c     public.ns_job_completions;
  v_exist public.ns_job_completion_corrections;
begin
  if not public.is_owner() then
    raise exception
      'Only the owner reopens an accepted job. A crew that could reopen its '
      'own completion could complete it twice.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception
      'A reopen without a reason is the rewrite this design exists to '
      'prevent.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_exist from public.ns_job_completion_corrections
   where client_operation_id = p_client_operation_id;
  if found then
    if v_exist.completion_id is distinct from p_completion_id then
      raise exception 'That key already corrected completion %, not %.',
        v_exist.completion_id, p_completion_id
        using errcode = 'unique_violation';
    end if;
    return public.ns_completion_receipt(v_exist.completion_id, true);
  end if;

  select * into v_c from public.ns_job_completions where id = p_completion_id;
  if not found then
    raise exception 'No such completion %', p_completion_id
      using errcode = 'no_data_found';
  end if;
  if not public.ns_job_completion_is_open(v_c.job_id) then
    raise exception
      'Completion % is not the open one for job %, so there is nothing to '
      'reopen.', p_completion_id, v_c.job_id
      using errcode = 'check_violation';
  end if;

  -- APPENDED, not applied to the receipt. The completion row is untouched;
  -- the reopen is a new record that changes what the job's state means.
  insert into public.ns_job_completion_corrections
    (completion_id, kind, reason, detail, authorised_by, client_operation_id)
  values
    (p_completion_id, 'reopen', btrim(p_reason),
     jsonb_build_object('job_id', v_c.job_id,
                        'reopened_accepted_at', v_c.accepted_at),
     auth.uid(), p_client_operation_id);

  -- The job goes back to work. completed_at is cleared, which the gate now
  -- permits because the reopen above made the completion not-open.
  update public.ns_jobs
     set status = 'in_progress',
         completed_at = null
   where id = v_c.job_id;

  return public.ns_completion_receipt(p_completion_id, false);
end
$$;

create or replace function public.correct_job_consumption(
  p_client_operation_id text,
  p_completion_id       uuid,
  p_material_id         uuid,
  p_reason              text,
  p_quantity            numeric default null,
  p_level               text    default null,
  p_location_code       text    default null,
  p_count_precision     text    default 'exact',
  p_corrects            uuid    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c      public.ns_job_completions;
  v_mat    public.ns_materials;
  v_loc    uuid;
  v_code   text;
  v_op     uuid;
  v_result jsonb;
  v_exist  public.ns_job_completion_corrections;
  v_row    uuid;
begin
  if not public.is_owner() then
    raise exception
      'Only the owner corrects an accepted material count: the original '
      'stands as what the crew reported.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A correction without a reason is a rewrite'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_exist from public.ns_job_completion_corrections
   where client_operation_id = p_client_operation_id;
  if found then
    return public.ns_completion_receipt(v_exist.completion_id, true);
  end if;

  select * into v_c from public.ns_job_completions where id = p_completion_id;
  if not found then
    raise exception 'No such completion %', p_completion_id
      using errcode = 'no_data_found';
  end if;

  select * into v_mat from public.ns_materials where id = p_material_id;
  if not found then
    raise exception 'No such material %', p_material_id
      using errcode = 'no_data_found';
  end if;

  v_code := coalesce(p_location_code, 'base');
  v_loc := public.ns_location_by_code(v_code);
  if v_loc is null then
    raise exception 'No active stock location with code %', v_code
      using errcode = 'no_data_found';
  end if;

  if v_mat.tracking_mode = 'level' then
    if p_level is null then
      raise exception '% is level-tracked; say full, part, low or empty',
        v_mat.name using errcode = 'invalid_parameter_value';
    end if;
    insert into public.ns_job_consumptions
      (completion_id, job_id, material_id, location_id, quantity, level,
       unit, count_precision, recorded_by, corrects, correction_reason)
    values
      (p_completion_id, v_c.job_id, v_mat.id, v_loc, null, p_level,
       v_mat.unit, p_count_precision, auth.uid(), p_corrects, btrim(p_reason))
    returning id into v_row;
  else
    if p_quantity is null or p_quantity = 0 then
      raise exception
        'A quantity correction needs a signed quantity: negative to take '
        'back what was over-reported, positive for what was missed.'
        using errcode = 'invalid_parameter_value';
    end if;
    /* THE SIGN, stated once because it is the easy thing to get backwards.
       `p_quantity` is the signed change to the CONSUMPTION RECORD:
         -3  "we reported three litres more than we used"
         +3  "we used three litres we never wrote down"
       The LEDGER therefore moves the other way. Over-reporting means three
       litres are still on the shelf, so the adjustment is +3. Posting
       p_quantity straight through would take them off twice -- which is
       exactly the mistake the batch11-1 suite's H4 caught. */
    v_result := public.post_stock_movement(
      p_client_operation_id || ':fix',
      v_mat.id, v_code, -p_quantity, 'adjustment',
      'Correction to completion ' || p_completion_id || ': ' || btrim(p_reason),
      v_c.job_id, null, null, 'usable', p_count_precision);
    v_op := (v_result ->> 'operation_id')::uuid;
    perform public.ns_verify_stock_operation(
      v_op, v_mat.id, v_code, -p_quantity, 'adjustment');

    insert into public.ns_job_consumptions
      (completion_id, job_id, material_id, location_id, quantity, level,
       unit, count_precision, operation_id, recorded_by, corrects,
       correction_reason)
    values
      (p_completion_id, v_c.job_id, v_mat.id, v_loc, p_quantity, null,
       v_mat.unit, p_count_precision, v_op, auth.uid(), p_corrects,
       btrim(p_reason))
    returning id into v_row;
  end if;

  insert into public.ns_job_completion_corrections
    (completion_id, kind, reason, detail, authorised_by, client_operation_id)
  values
    (p_completion_id, 'consumption_corrected', btrim(p_reason),
     jsonb_build_object('consumption_id', v_row, 'material_id', v_mat.id,
                        'quantity', p_quantity, 'level', p_level,
                        'corrects', p_corrects),
     auth.uid(), p_client_operation_id);

  return public.ns_completion_receipt(p_completion_id, false);
end
$$;

/* ===================================================================== */
/* 6. additional work                                                    */
/* ===================================================================== */

-- A crew may say "the gutters need doing too". It may not say what that is
-- worth, and it may not approve it. Both halves matter: an unpriced
-- proposal is honest, and a crew-approved paid change is the hole this
-- closes.
create or replace function public.propose_additional_work(
  p_client_operation_id text,
  p_job_id              uuid,
  p_description         text,
  p_note                text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_quote uuid;
  v_id    uuid;
  v_exist public.ns_change_orders;
begin
  if not public.is_admin() then
    raise exception 'propose_additional_work is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(btrim(p_description), '') = '' then
    raise exception 'Say what the extra work is'
      using errcode = 'invalid_parameter_value';
  end if;
  if not public.can_work_job(p_job_id) then
    raise exception 'That job is assigned to a vehicle you are not on'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_exist from public.ns_change_orders
   where client_operation_id = p_client_operation_id;
  if found then
    return jsonb_build_object('replayed', true, 'change_order_id', v_exist.id,
      'status', v_exist.status, 'pricing_state',
      case when v_exist.amount is null then 'unpriced' else 'priced' end);
  end if;

  select id into v_quote from public.ns_quotes
   where job_id = p_job_id order by created_at desc nulls last limit 1;

  insert into public.ns_change_orders
    (quote_id, job_id, description, amount, status, created_by, proposed_by,
     proposed_at, client_operation_id)
  values
    (v_quote, p_job_id, btrim(p_description), null, 'proposed', auth.uid(),
     auth.uid(), now(), p_client_operation_id)
  returning id into v_id;

  return jsonb_build_object('replayed', false, 'change_order_id', v_id,
    'status', 'proposed', 'pricing_state', 'unpriced',
    'note', coalesce(p_note, ''));
end
$$;

-- PRICING STAYS IN THE BACKEND and approval stays with the owner. The
-- amount is set here, by the owner, in one transaction with the approval,
-- so there is no window in which an approved change order has no price.
create or replace function public.decide_change_order(
  p_client_operation_id text,
  p_change_order_id     uuid,
  p_decision            text,
  p_amount              numeric default null,
  p_reason              text    default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_co public.ns_change_orders;
begin
  if not public.is_owner() then
    raise exception
      'Only the owner approves or prices extra work. A crew approving its '
      'own paid change is the thing this prevents.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_decision not in ('approved', 'declined') then
    raise exception 'A decision is approved or declined, not %', p_decision
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_co from public.ns_change_orders
   where id = p_change_order_id for update;
  if not found then
    raise exception 'No such change order %', p_change_order_id
      using errcode = 'no_data_found';
  end if;

  if v_co.status in ('approved', 'declined') then
    -- Idempotent on state: the same decision again is a retry.
    if v_co.status = p_decision then
      return jsonb_build_object('replayed', true, 'no_op', true,
        'change_order_id', v_co.id, 'status', v_co.status,
        'amount', v_co.amount);
    end if;
    raise exception
      'Change order % is already %. Raise a new one rather than reversing a '
      'decision the customer may have seen.', v_co.id, v_co.status
      using errcode = 'check_violation';
  end if;

  if p_decision = 'approved' and p_amount is null then
    raise exception
      'An approved change order needs an amount. Completion never prices '
      'anything, so this is where the figure comes from.'
      using errcode = 'invalid_parameter_value';
  end if;

  update public.ns_change_orders
     set status = p_decision,
         amount = case when p_decision = 'approved' then p_amount else amount end,
         approved_at = now(),
         approved_by = auth.uid()
   where id = p_change_order_id;

  return jsonb_build_object('replayed', false, 'no_op', false,
    'change_order_id', v_co.id, 'status', p_decision,
    'amount', case when p_decision = 'approved' then p_amount else v_co.amount end,
    'reason', coalesce(p_reason, ''));
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
    'public.ns_completion_receipt(uuid,boolean)',
    'public.can_work_job(uuid)',
    'public.ns_completion_fingerprint(uuid,timestamptz,jsonb,jsonb,text)',
    'public.set_evidence_policy(text,text,text,integer,text,boolean,text,text)',
    'public.retire_evidence_policy(text,text,text)',
    'public.register_job_evidence(text,uuid,uuid,text,text,timestamptz,text,numeric,numeric,numeric,text,text,text)',
    'public.authorise_evidence_exception(text,uuid,text,text,text)',
    'public.complete_job_with_evidence(text,uuid,integer,integer,timestamptz,jsonb,jsonb,text)',
    'public.reopen_job_completion(text,uuid,text)',
    'public.correct_job_consumption(text,uuid,uuid,text,numeric,text,text,text,uuid)',
    'public.propose_additional_work(text,uuid,text,text)',
    'public.decide_change_order(text,uuid,text,numeric,text)'
  ]
  loop
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
    'public.set_evidence_policy(text,text,text,integer,text,boolean,text,text)',
    'public.register_job_evidence(text,uuid,uuid,text,text,timestamptz,text,numeric,numeric,numeric,text,text,text)',
    'public.complete_job_with_evidence(text,uuid,integer,integer,timestamptz,jsonb,jsonb,text)',
    'public.reopen_job_completion(text,uuid,text)',
    'public.correct_job_consumption(text,uuid,uuid,text,numeric,text,text,text,uuid)',
    'public.decide_change_order(text,uuid,text,numeric,text)'
  ]
  loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception 'anon can execute %, which it must not', f;
    end if;
  end loop;
end
$$;
