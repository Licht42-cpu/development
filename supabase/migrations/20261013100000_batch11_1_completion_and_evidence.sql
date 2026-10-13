-- Batch 11.1, part two: what a finished job has to prove, and what the
-- record of it is allowed to become afterwards.
--
-- The hole this closes
-- --------------------
-- Completion today is a direct table UPDATE from the browser:
--
--   admin/js/lib/api.js completeJob()
--     update ns_jobs set status='completed', completed_at=now()
--      where id=$1 and completed_at is null
--
-- `authenticated` holds UPDATE on ns_jobs, so any admin -- which is every
-- crew member -- can mark any job complete with no photo, no material
-- count, no attribution beyond the row's own timestamp, and no way to tell
-- a retry from a second completion. The dropdown next to the button can set
-- `status='completed'` directly and skip even that.
--
-- What this migration adds is the record. The operations that write it are
-- in 20261013110000; this file is tables, views, guards and grants only, so
-- the two can be read separately.
--
-- Shapes derived from the repository, NOT probed against live
-- ----------------------------------------------------------
-- The repository still has no base schema (docs/batch7-1-findings.md 4b),
-- so ns_jobs, job_attachments, ns_quotes and ns_change_orders exist here
-- only as the columns the admin code reads and writes. Everything this
-- migration touches on those four tables is therefore either an `add column
-- if not exists`, a trigger, or an introspecting DO block -- never an
-- assumption about a column list it cannot see. The one place that matters
-- most is spelled out where it happens: the completion gate is a TRIGGER
-- rather than a column-level grant, because a column-level grant needs the
-- full column list and a trigger does not.
--
-- NOT APPLIED. Written and tested against a disposable PostgreSQL only.
-- Contract: docs/completion-evidence-contract-v1.md.

/* ===================================================================== */
/* 1. a version on the job, so a stale client can be told so             */
/* ===================================================================== */

alter table public.ns_jobs
  add column if not exists lock_version integer not null default 1;

comment on column public.ns_jobs.lock_version is
  'Bumped by trigger on every UPDATE. A completion names the version it '
  'read; a different one means somebody else moved the job and the caller '
  'is told to re-read rather than overwriting work it never saw.';

create or replace function public.ns_bump_job_lock_version()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  -- Only when something else actually changed, so the bump cannot be used
  -- as a no-op version pump.
  if new.lock_version = old.lock_version then
    new.lock_version := old.lock_version + 1;
  end if;
  return new;
end $$;

drop trigger if exists ns_jobs_bump_lock_version on public.ns_jobs;
create trigger ns_jobs_bump_lock_version
  before update on public.ns_jobs
  for each row execute function public.ns_bump_job_lock_version();

/* ===================================================================== */
/* 2. what counts as evidence, per service, set by the owner             */
/* ===================================================================== */

-- SERVICE-SPECIFIC because the question is. A before-and-after pair is the
-- whole proof for a cleaning service and says nothing about whether a
-- lighting run was installed correctly; a winter check wants one quick shot
-- that somebody was there.
--
-- OWNER-CONFIGURABLE because nobody has told us the real rules. Every row
-- this migration seeds is `spec_state='proposed'` and
-- `enforcement='advisory'`: it is written down so the owner can argue with
-- it, and until the owner confirms it, it reports a shortfall and refuses
-- nothing. See §6 for why that is the only honest default.
create table if not exists public.ns_evidence_policies (
  id             uuid primary key default gen_random_uuid(),
  service_id     uuid not null references public.services(id) on delete cascade,

  -- WHAT has to exist. Open vocabulary with a CHECK, because a requirement
  -- nobody can name is a requirement nobody can satisfy.
  requirement    text not null,

  -- HOW MANY, and OVER WHAT. `per_job` means one image settles it for the
  -- whole visit; `per_service_scope` means each service on the job needs
  -- its own. Both read the SAME evidence rows, so one photo that genuinely
  -- covers two scopes is registered against both and counts twice without
  -- being uploaded twice. That is the point of the link table in §3.
  min_count      integer not null default 1,
  coverage       text    not null default 'per_job',

  -- Whether the capture has to carry a device location. Proposed FALSE
  -- everywhere except the winter check: a crew in a basement or a steel
  -- garage has no GPS through no fault of its own, and refusing every such
  -- job would stop the work rather than improve the record.
  requires_geotag boolean not null default false,

  -- `advisory` reports a shortfall and accepts the completion.
  -- `blocking`  refuses it.
  enforcement    text not null default 'advisory',

  -- `proposed` is OUR assumption. `owner_confirmed` is a business rule.
  -- Only the owner can move a row to the second, and only a confirmed row
  -- may be `blocking` (constraint below) -- so nothing we guessed can ever
  -- stop a crew from finishing a job.
  spec_state     text not null default 'proposed',

  policy_version integer not null default 1,
  active         boolean not null default true,
  note           text,

  created_at     timestamptz not null default now(),
  created_by     uuid references auth.users(id),
  confirmed_at   timestamptz,
  confirmed_by   uuid references auth.users(id),

  constraint ns_evidence_policies_requirement_known check (requirement in (
    -- cleaning
    'before', 'after',
    -- lighting and heating cable
    'installation', 'component',
    -- winter checks
    'winter_proof',
    -- anything, any service
    'site_condition', 'access_hazard')),
  constraint ns_evidence_policies_coverage_known check (
    coverage in ('per_job', 'per_service_scope')),
  constraint ns_evidence_policies_enforcement_known check (
    enforcement in ('advisory', 'blocking')),
  constraint ns_evidence_policies_spec_state_known check (
    spec_state in ('proposed', 'owner_confirmed')),
  constraint ns_evidence_policies_min_count_positive check (min_count >= 1),
  constraint ns_evidence_policies_version_positive check (policy_version >= 1),

  -- THE RULE THAT MAKES THE PROPOSED SEED SAFE. A guess cannot block work.
  constraint ns_evidence_policies_only_confirmed_blocks check (
    enforcement = 'advisory' or spec_state = 'owner_confirmed'),
  constraint ns_evidence_policies_confirmed_is_dated check (
    (spec_state = 'owner_confirmed') = (confirmed_at is not null))
);

create unique index if not exists ns_evidence_policies_active_key
  on public.ns_evidence_policies (service_id, requirement)
  where active;

-- One number the client can send back, so "was this evaluated against the
-- current rules" is one comparison rather than a diff of rows.
create or replace function public.ns_evidence_policy_version()
returns integer
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(max(policy_version), 0)::integer
    from public.ns_evidence_policies where active;
$$;

/* ===================================================================== */
/* 3. the evidence itself                                                */
/* ===================================================================== */

-- The completion receipt. Declared before ns_job_evidence because the
-- freeze column points at it.
create table if not exists public.ns_job_completions (
  id                  uuid primary key default gen_random_uuid(),
  job_id              uuid not null references public.ns_jobs(id) on delete restrict,

  -- Caller-generated, survives the response nobody received.
  client_operation_id text not null,

  -- md5 of the canonical payload. A retry under the same key with a
  -- DIFFERENT payload is a different request wearing the same name, and is
  -- refused rather than silently answered with the first one.
  intent_fingerprint  text not null,

  accepted_at         timestamptz not null default now(),
  accepted_by         uuid references auth.users(id),

  -- The crew's claim about when the work finished, kept apart from
  -- accepted_at, which is when the server believed it. Offline work is
  -- finished hours before the server hears about it.
  work_finished_at    timestamptz,
  work_finished_state text not null default 'reported',

  -- What the acceptance was judged against, so the receipt stays readable
  -- after the rules change.
  policy_version      integer not null,
  job_lock_version    integer not null,

  -- 'satisfied'       every requirement met
  -- 'advisory_short'  something was missing and no confirmed rule required it
  -- 'unconfigured'    at least one service has no policy at all
  -- Never 'blocked': a blocked completion raises and writes nothing.
  evidence_state      text not null,
  evidence_count      integer not null default 0,

  -- FROZEN REFERENCES, not copies of the images. The attachment ids and
  -- their purposes as they stood at acceptance, so a later change to
  -- ns_job_evidence cannot rewrite what was accepted.
  evidence_snapshot   jsonb not null default '[]'::jsonb,
  consumption_snapshot jsonb not null default '[]'::jsonb,
  advisory_shortfalls jsonb not null default '[]'::jsonb,
  note                text,

  constraint ns_job_completions_client_id_not_blank
    check (btrim(client_operation_id) <> ''),
  constraint ns_job_completions_fingerprint_not_blank
    check (btrim(intent_fingerprint) <> ''),
  constraint ns_job_completions_evidence_state_known check (
    evidence_state in ('satisfied', 'advisory_short', 'unconfigured')),
  constraint ns_job_completions_work_finished_state_known check (
    work_finished_state in ('reported', 'unknown')),
  constraint ns_job_completions_work_finished_pairs check (
    (work_finished_state = 'reported') = (work_finished_at is not null))
);

create unique index if not exists ns_job_completions_client_id_key
  on public.ns_job_completions (client_operation_id);

-- ONE accepted completion per job, enforced rather than hoped for. A
-- reopen appends a correction; it does not delete this row, so a second
-- completion after a reopen is a second ROW and this index has to allow it
-- -- which is why it is keyed on the job plus the reopen count it follows.
alter table public.ns_job_completions
  add column if not exists supersedes_corrections integer not null default 0;

create unique index if not exists ns_job_completions_one_per_cycle
  on public.ns_job_completions (job_id, supersedes_corrections);

comment on column public.ns_job_completions.supersedes_corrections is
  'How many reopens this job had been through when this completion was '
  'accepted. With the unique index above it is what makes "one accepted '
  'completion at a time" a database rule instead of a convention, while '
  'still allowing a job that was reopened to be completed again.';

/* ---------------------------------------------------- evidence records -- */

-- A LINK, not a copy. One job_attachments row can be registered against
-- several (requirement, service) scopes, which is how one photograph of a
-- deck and the siding behind it satisfies the `before` requirement for both
-- without the crew taking the same picture twice.
create table if not exists public.ns_job_evidence (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references public.ns_jobs(id) on delete cascade,

  -- An ID, never a path. A caller that could name a storage path could
  -- name one it had not uploaded, and a guessed path is not evidence. The
  -- attachment row exists only because an upload succeeded first.
  attachment_id  uuid not null references public.job_attachments(id) on delete restrict,

  requirement    text not null,
  -- null = this covers the whole job rather than one service's scope.
  service_id     uuid references public.services(id) on delete cascade,

  /* ---- THE CLAIM, as the device reported it. Not proof of anything. ---- */
  captured_at         timestamptz,
  capture_time_state  text not null default 'unknown',
  captured_lat        numeric,
  captured_lon        numeric,
  captured_accuracy_m numeric,
  gps_state           text not null default 'unknown',

  -- A watermark is pixels the client drew. It is recorded because it is
  -- what the customer will see, and it is named `client_watermark` so no
  -- reader mistakes it for a server fact.
  client_watermark    text,

  /* ---- THE SERVER'S OWN RECORD. This is the part that is trusted. ---- */
  received_at    timestamptz not null default now(),
  registered_by  uuid references auth.users(id),
  source         text not null default 'field_console',

  -- Set by register_job_evidence after it has checked that the attachment
  -- exists, belongs to THIS job, and carries a non-empty stored object.
  upload_verified boolean not null default false,

  -- Non-null once a completion has been accepted against it: the reference
  -- is frozen and the row can no longer be removed or re-purposed.
  frozen_by_completion uuid references public.ns_job_completions(id) on delete restrict,

  constraint ns_job_evidence_requirement_known check (requirement in (
    'before', 'after', 'installation', 'component', 'winter_proof',
    'site_condition', 'access_hazard')),
  constraint ns_job_evidence_capture_time_state_known check (
    capture_time_state in ('device_reported', 'unknown', 'unreliable')),
  -- EXPLICIT STATES, so a missing timestamp is a stated fact rather than a
  -- null somebody reads as "now".
  constraint ns_job_evidence_capture_time_pairs check (
    (capture_time_state = 'device_reported') = (captured_at is not null)),
  constraint ns_job_evidence_gps_state_known check (
    gps_state in ('device_reported', 'unavailable', 'denied', 'unknown')),
  constraint ns_job_evidence_gps_pairs check (
    (gps_state = 'device_reported')
      = (captured_lat is not null and captured_lon is not null)),
  constraint ns_job_evidence_source_known check (
    source in ('field_console', 'desk', 'customer_upload'))
);

-- One image, many scopes -- but not the same scope twice. COALESCE because
-- a NULL service_id would make the unique index let duplicates through.
create unique index if not exists ns_job_evidence_scope_key
  on public.ns_job_evidence (
    attachment_id, requirement,
    coalesce(service_id, '00000000-0000-0000-0000-000000000000'::uuid));

create index if not exists ns_job_evidence_job_idx
  on public.ns_job_evidence (job_id, requirement);

/* --------------------------------------------- attributed exceptions --- */

-- "Use explicit, attributed exception rules where appropriate." An
-- exception is a row with a name and a reason on it, not a flag somebody
-- flipped. Owner-only, and it never widens beyond the job it names.
create table if not exists public.ns_evidence_exceptions (
  id             uuid primary key default gen_random_uuid(),
  job_id         uuid not null references public.ns_jobs(id) on delete cascade,
  -- null = every requirement on this job; otherwise just this one.
  requirement    text,
  -- null = every service on this job.
  service_id     uuid references public.services(id) on delete cascade,
  reason         text not null,
  authorised_by  uuid references auth.users(id),
  authorised_at  timestamptz not null default now(),
  policy_version integer not null default 0,
  client_operation_id text not null,

  constraint ns_evidence_exceptions_reason_not_blank
    check (btrim(reason) <> ''),
  constraint ns_evidence_exceptions_client_id_not_blank
    check (btrim(client_operation_id) <> ''),
  constraint ns_evidence_exceptions_requirement_known check (
    requirement is null or requirement in (
      'before', 'after', 'installation', 'component', 'winter_proof',
      'site_condition', 'access_hazard'))
);

create unique index if not exists ns_evidence_exceptions_client_id_key
  on public.ns_evidence_exceptions (client_operation_id);

create index if not exists ns_evidence_exceptions_job_idx
  on public.ns_evidence_exceptions (job_id);

/* ===================================================================== */
/* 4. attributed consumption history                                     */
/* ===================================================================== */

-- WHAT WAS USED on the job, who said so, and which ledger operation
-- actually moved it. The ledger already has the movement; this table is the
-- job-side record that names the person and survives as history.
--
-- It does not move stock itself. Every row points at an ns_stock_operations
-- row that did, which is what makes double-debiting impossible to express:
-- a consumption that closed a reservation carries that reservation, and the
-- operation behind it is the reservation's own closing operation.
create table if not exists public.ns_job_consumptions (
  id              uuid primary key default gen_random_uuid(),
  completion_id   uuid references public.ns_job_completions(id) on delete restrict,
  job_id          uuid not null references public.ns_jobs(id) on delete restrict,
  material_id     uuid not null references public.ns_materials(id) on delete restrict,
  location_id     uuid not null references public.ns_stock_locations(id) on delete restrict,

  -- QUANTITY OR LEVEL, never both and never neither. A level-tracked
  -- supply has no number and inventing one would be worse than the level.
  quantity        numeric,
  level           text,
  unit            text not null,
  count_precision text not null default 'exact',

  reservation_id  uuid references public.ns_stock_reservations(id) on delete set null,
  operation_id    uuid references public.ns_stock_operations(id) on delete restrict,

  recorded_by     uuid references auth.users(id),
  recorded_at     timestamptz not null default now(),

  -- An appended correction points at the row it corrects. The original is
  -- never touched.
  corrects        uuid references public.ns_job_consumptions(id) on delete restrict,
  correction_reason text,

  constraint ns_job_consumptions_quantity_xor_level check (
    (quantity is null) <> (level is null)),
  constraint ns_job_consumptions_quantity_nonzero check (
    quantity is null or quantity <> 0),
  constraint ns_job_consumptions_level_known check (
    level is null or level in ('full', 'part', 'low', 'empty')),
  constraint ns_job_consumptions_precision_known check (
    count_precision in ('exact', 'estimated')),
  -- A level is an observation, not a movement, so it has no operation. A
  -- quantity does, or it is a number with nothing behind it.
  constraint ns_job_consumptions_quantity_has_operation check (
    (quantity is null) = (operation_id is null)),
  constraint ns_job_consumptions_correction_has_reason check (
    (corrects is null) = (correction_reason is null))
);

create index if not exists ns_job_consumptions_job_idx
  on public.ns_job_consumptions (job_id, recorded_at desc);
create index if not exists ns_job_consumptions_completion_idx
  on public.ns_job_consumptions (completion_id);

/* ===================================================================== */
/* 5. corrections, appended                                              */
/* ===================================================================== */

-- "Corrections must append an authorized, reasoned, linked record rather
-- than rewrite the original." This is that record. A reopen is one kind of
-- it, which is why reopening does not touch the completion row either.
create table if not exists public.ns_job_completion_corrections (
  id            uuid primary key default gen_random_uuid(),
  completion_id uuid not null references public.ns_job_completions(id) on delete restrict,
  kind          text not null,
  reason        text not null,
  detail        jsonb not null default '{}'::jsonb,
  authorised_by uuid references auth.users(id),
  created_at    timestamptz not null default now(),
  client_operation_id text not null,

  constraint ns_job_corrections_kind_known check (kind in (
    'reopen', 'evidence_added', 'consumption_corrected', 'annotation')),
  constraint ns_job_corrections_reason_not_blank check (btrim(reason) <> ''),
  constraint ns_job_corrections_client_id_not_blank
    check (btrim(client_operation_id) <> '')
);

create unique index if not exists ns_job_corrections_client_id_key
  on public.ns_job_completion_corrections (client_operation_id);

create index if not exists ns_job_corrections_completion_idx
  on public.ns_job_completion_corrections (completion_id, created_at);

/* ===================================================================== */
/* 6. reading the requirements, with unknown as a first-class answer      */
/* ===================================================================== */

-- Is there an accepted completion for this job that has not been reopened?
-- Everything downstream reads this one function so "complete" means the
-- same thing to the trigger, the view and the RPCs.
create or replace function public.ns_job_completion_is_open(p_job_id uuid)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.ns_job_completions c
     where c.job_id = p_job_id
       and c.supersedes_corrections = (
         select count(*)
           from public.ns_job_completion_corrections k
           join public.ns_job_completions c2 on c2.id = k.completion_id
          where c2.job_id = p_job_id and k.kind = 'reopen')
  );
$$;

-- Per job, per service actually on the job, per requirement.
--
-- `required_count` is NULL when no policy exists. That is deliberate and it
-- is the whole reason this view exists rather than a COUNT(*) somewhere: a
-- zero would read as "nothing needed" and an unconfigured service would
-- silently pass. Unknown is not zero.
create or replace view public.ns_job_evidence_requirements as
with job_services as (
  -- The services the job actually has measurements for. A job carrying no
  -- measurements has no service scopes, and says so by having no rows.
  select distinct jm.job_id, jm.service_id
    from public.job_measurements jm
),
scoped as (
  select js.job_id,
         js.service_id,
         s.key                as service_key,
         s.name               as service_name,
         p.id                 as policy_id,
         p.requirement,
         p.min_count,
         p.coverage,
         p.requires_geotag,
         p.enforcement,
         p.spec_state,
         p.policy_version
    from job_services js
    join public.services s on s.id = js.service_id
    left join public.ns_evidence_policies p
           on p.service_id = js.service_id and p.active
)
select sc.job_id,
       sc.service_id,
       sc.service_key,
       sc.service_name,
       sc.requirement,
       sc.policy_id,
       sc.min_count            as required_count,
       sc.coverage,
       sc.requires_geotag,
       coalesce(sc.enforcement, 'advisory')   as enforcement,
       coalesce(sc.spec_state, 'unconfigured') as spec_state,
       sc.policy_version,
       /* Evidence that counts for this requirement. A `per_job` policy
          accepts a row registered against the job as a whole OR against
          any service; `per_service_scope` wants this service named. Both
          read the same rows, so one image legitimately covering two scopes
          is registered twice and counted twice without being re-uploaded. */
       coalesce((
         select count(*)
           from public.ns_job_evidence e
          where e.job_id = sc.job_id
            and e.requirement = sc.requirement
            and e.upload_verified
            and (sc.coverage = 'per_job' or e.service_id = sc.service_id)
            and (not sc.requires_geotag or e.gps_state = 'device_reported')
       ), 0)::integer           as satisfied_count,
       exists (
         select 1 from public.ns_evidence_exceptions x
          where x.job_id = sc.job_id
            and (x.requirement is null or x.requirement = sc.requirement)
            and (x.service_id is null or x.service_id = sc.service_id)
       )                        as excepted,
       case
         when sc.requirement is null then 'unconfigured'
         when exists (
           select 1 from public.ns_evidence_exceptions x
            where x.job_id = sc.job_id
              and (x.requirement is null or x.requirement = sc.requirement)
              and (x.service_id is null or x.service_id = sc.service_id)
         ) then 'excepted'
         when coalesce((
           select count(*)
             from public.ns_job_evidence e
            where e.job_id = sc.job_id
              and e.requirement = sc.requirement
              and e.upload_verified
              and (sc.coverage = 'per_job' or e.service_id = sc.service_id)
              and (not sc.requires_geotag or e.gps_state = 'device_reported')
         ), 0) >= sc.min_count then 'satisfied'
         else 'short'
       end                      as state
  from scoped sc;

-- The job-level rollup the completion gate and the phone both read, so the
-- screen that offered the button and the function that refuses it cannot
-- disagree.
create or replace view public.ns_job_evidence_readiness as
select j.id as job_id,
       public.ns_evidence_policy_version() as policy_version,
       j.lock_version,
       coalesce((select count(*) from public.ns_job_evidence_requirements r
                  where r.job_id = j.id), 0)::integer as requirement_count,
       coalesce((select count(*) from public.ns_job_evidence_requirements r
                  where r.job_id = j.id and r.state = 'short'
                    and r.enforcement = 'blocking'), 0)::integer
         as blocking_shortfalls,
       coalesce((select count(*) from public.ns_job_evidence_requirements r
                  where r.job_id = j.id and r.state = 'short'
                    and r.enforcement = 'advisory'), 0)::integer
         as advisory_shortfalls,
       coalesce((select array_agg(distinct r.service_key)
                   from public.ns_job_evidence_requirements r
                  where r.job_id = j.id and r.state = 'unconfigured'),
                '{}'::text[]) as unconfigured_services,
       /* The one word a caller needs, and `unconfigured` is one of them:
          "we do not know what this job needs" is an answer, not a pass. */
       case
         when exists (select 1 from public.ns_job_evidence_requirements r
                       where r.job_id = j.id and r.state = 'short'
                         and r.enforcement = 'blocking') then 'blocked'
         when exists (select 1 from public.ns_job_evidence_requirements r
                       where r.job_id = j.id and r.state = 'unconfigured')
           then 'unconfigured'
         when exists (select 1 from public.ns_job_evidence_requirements r
                       where r.job_id = j.id and r.state = 'short')
           then 'advisory_short'
         else 'satisfied'
       end as evidence_state,
       (select c.id from public.ns_job_completions c
         where c.job_id = j.id order by c.accepted_at desc limit 1)
         as latest_completion_id,
       public.ns_job_completion_is_open(j.id) as completion_open
  from public.ns_jobs j;

/* ===================================================================== */
/* 7. the gate                                                           */
/* ===================================================================== */

-- THE BYPASS CLOSED.
--
-- A trigger rather than a column grant, deliberately: revoking UPDATE on
-- ns_jobs.completed_at means re-granting every other column by name, and
-- this repository cannot see ns_jobs' column list (no base schema). A
-- trigger needs no list, fires for every role including the table owner,
-- and cannot be walked around by a second statement.
--
-- What it allows, so that legitimate transitions keep working: every status
-- move except into 'completed', every edit to every other column, and the
-- stamp itself when an accepted completion exists to justify it.
create or replace function public.ns_guard_job_completion()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare
  v_open boolean;
begin
  v_open := public.ns_job_completion_is_open(new.id);

  -- 1. You cannot declare a job complete. You complete it, and that writes
  --    a record; the status then follows.
  if new.status = 'completed' and old.status is distinct from 'completed'
     and not v_open then
    raise exception
      'Job % cannot be marked complete directly. Call '
      'complete_job_with_evidence, which records who finished it, what it '
      'proved and what it used.', new.id
      using errcode = 'insufficient_privilege';
  end if;

  -- 2. The completion time is the receipt's, not the caller's.
  if new.completed_at is distinct from old.completed_at then
    if new.completed_at is null then
      if v_open then
        raise exception
          'Job % has an accepted completion. Reopen it with a reason '
          'before clearing its completion time.', new.id
          using errcode = 'check_violation';
      end if;
    elsif not exists (
      select 1 from public.ns_job_completions c
       where c.job_id = new.id and c.accepted_at = new.completed_at) then
      raise exception
        'Job %: completed_at must be the accepted_at of one of its '
        'completion records, not a time the caller chose.', new.id
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists ns_jobs_completion_gate on public.ns_jobs;
create trigger ns_jobs_completion_gate
  before update on public.ns_jobs
  for each row execute function public.ns_guard_job_completion();

/* ------------------------------------------------- append-only history -- */

-- Completions, consumption and corrections are history. The ONE mutation
-- allowed anywhere in here is stamping frozen_by_completion onto an
-- evidence row, from null to a value, once.
create or replace function public.ns_guard_append_only()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception
      '%: accepted history is not deletable. Append a correction with a '
      'reason instead.', tg_table_name
      using errcode = 'insufficient_privilege';
  end if;
  raise exception
    '%: accepted history is not editable. Append a correction with a '
    'reason instead.', tg_table_name
    using errcode = 'insufficient_privilege';
end $$;

drop trigger if exists ns_job_completions_append_only on public.ns_job_completions;
create trigger ns_job_completions_append_only
  before update or delete on public.ns_job_completions
  for each row execute function public.ns_guard_append_only();

drop trigger if exists ns_job_corrections_append_only
  on public.ns_job_completion_corrections;
create trigger ns_job_corrections_append_only
  before update or delete on public.ns_job_completion_corrections
  for each row execute function public.ns_guard_append_only();

-- Consumption: a row that is not yet part of an accepted completion is
-- still being written and may be withdrawn. Once frozen it is history.
create or replace function public.ns_guard_consumption_history()
returns trigger language plpgsql set search_path = public, pg_temp as $$
declare
  v_locked boolean;
begin
  v_locked := coalesce(
    (select c.completion_id is not null
       from public.ns_job_consumptions c
      where c.id = coalesce(old.id, new.id)), false);

  if tg_op = 'DELETE' then
    if v_locked then
      raise exception
        'That consumption line is part of an accepted completion. Append a '
        'correction with a reason instead of deleting it.'
        using errcode = 'insufficient_privilege';
    end if;
    return old;
  end if;

  if v_locked then
    raise exception
      'That consumption line is part of an accepted completion and cannot '
      'be edited. Append a correction with a reason instead.'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

drop trigger if exists ns_job_consumptions_history on public.ns_job_consumptions;
create trigger ns_job_consumptions_history
  before update or delete on public.ns_job_consumptions
  for each row execute function public.ns_guard_consumption_history();

-- LATE CONSUMPTION. Adding a used-material line after the job was accepted
-- is how a quiet second debit would arrive, so it needs the same authorized
-- reasoned correction as changing one.
create or replace function public.ns_guard_consumption_not_late()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if public.ns_job_completion_is_open(new.job_id)
     and new.completion_id is null
     and new.corrects is null then
    raise exception
      'Job % is already accepted as complete. Late consumption has to be a '
      'correction with a reason, authorised by the owner.', new.job_id
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end $$;

drop trigger if exists ns_job_consumptions_not_late on public.ns_job_consumptions;
create trigger ns_job_consumptions_not_late
  before insert on public.ns_job_consumptions
  for each row execute function public.ns_guard_consumption_not_late();

-- Evidence: frozen references really are frozen, and the one legitimate
-- mutation is the freeze itself.
create or replace function public.ns_guard_evidence_frozen()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if old.frozen_by_completion is not null then
      raise exception
        'That evidence is referenced by an accepted completion and cannot '
        'be removed. Append a correction instead.'
        using errcode = 'insufficient_privilege';
    end if;
    return old;
  end if;

  if old.frozen_by_completion is null then
    -- The freeze, and nothing else with it.
    if new.frozen_by_completion is not null then
      if (to_jsonb(new) - 'frozen_by_completion')
         <> (to_jsonb(old) - 'frozen_by_completion') then
        raise exception
          'Freezing evidence is the only change that statement may make.'
          using errcode = 'insufficient_privilege';
      end if;
      return new;
    end if;
    return new;
  end if;

  raise exception
    'That evidence is referenced by an accepted completion and is frozen.'
    using errcode = 'insufficient_privilege';
end $$;

drop trigger if exists ns_job_evidence_frozen on public.ns_job_evidence;
create trigger ns_job_evidence_frozen
  before update or delete on public.ns_job_evidence
  for each row execute function public.ns_guard_evidence_frozen();

/* ===================================================================== */
/* 8. additional work: proposed by a crew, priced and approved by nobody  */
/*    else                                                               */
/* ===================================================================== */

-- Reuses the existing ns_change_orders path rather than inventing a second
-- one. Three changes, all additive:
--
--   * `amount` becomes nullable, because a crew proposing extra work has no
--     business naming a price and this is the only way to say "unpriced"
--     without inventing a number.
--   * who proposed it, and when.
--   * a CHECK that an APPROVED change order has an amount, so the nullable
--     column cannot leak into approved money.
--
-- Introspecting DO blocks throughout: this repository cannot see the live
-- definition of this table.
do $$
begin
  if to_regclass('public.ns_change_orders') is null then
    raise notice 'ns_change_orders is absent; skipping (fixtures create it)';
    return;
  end if;

  execute 'alter table public.ns_change_orders alter column amount drop not null';

  execute 'alter table public.ns_change_orders
             add column if not exists proposed_by uuid references auth.users(id)';
  execute 'alter table public.ns_change_orders
             add column if not exists proposed_at timestamptz';
  execute 'alter table public.ns_change_orders
             add column if not exists job_id uuid references public.ns_jobs(id)
               on delete set null';
  execute 'alter table public.ns_change_orders
             add column if not exists approved_by uuid references auth.users(id)';
  execute 'alter table public.ns_change_orders
             add column if not exists client_operation_id text';

  execute 'create unique index if not exists ns_change_orders_client_id_key
             on public.ns_change_orders (client_operation_id)
             where client_operation_id is not null';
end
$$;

-- The status vocabulary gains 'proposed'. Any existing status CHECK is
-- dropped by introspection rather than by a guessed name, and the
-- replacement keeps the values the admin code already reads.
do $$
declare
  c text;
begin
  if to_regclass('public.ns_change_orders') is null then return; end if;
  for c in
    select conname from pg_constraint
     where conrelid = 'public.ns_change_orders'::regclass
       and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%status%'
  loop
    execute format('alter table public.ns_change_orders drop constraint %I', c);
  end loop;

  execute $q$alter table public.ns_change_orders
    add constraint ns_change_orders_status_known check (
      status in ('pending', 'proposed', 'approved', 'declined'))$q$;

  execute $q$alter table public.ns_change_orders
    add constraint ns_change_orders_approved_is_priced check (
      status <> 'approved' or amount is not null)$q$;
end
$$;

-- SELF-APPROVAL CLOSED. The browser currently updates and deletes these
-- rows directly (api.js setChangeOrderStatus / deleteChangeOrder), so a
-- crew could raise a paid change and approve it in two clicks. Writes now
-- go through the owner-gated RPCs in 20261013110000.
do $$
begin
  if to_regclass('public.ns_change_orders') is null then return; end if;
  execute 'revoke insert, update, delete on public.ns_change_orders
             from authenticated';
end
$$;

/* ===================================================================== */
/* 9. the proposed policies, as assumptions                              */
/* ===================================================================== */

-- EVERY ROW HERE IS A GUESS, and the schema knows it: spec_state
-- 'proposed', enforcement 'advisory'. They exist so the owner has something
-- concrete to correct, and so a crew finishing a job today sees what we
-- THINK was wanted without being stopped by it.
--
-- The service keys are the real ones, read from
-- admin/js/views/measurements.js's calculator map. A key that does not
-- exist in this database inserts nothing rather than failing: the key list
-- in a fixture is smaller than the live one.
insert into public.ns_evidence_policies
  (service_id, requirement, min_count, coverage, requires_geotag,
   enforcement, spec_state, note)
select s.id, v.requirement, v.min_count, v.coverage, v.requires_geotag,
       'advisory', 'proposed', v.note
  from (values
    -- Cleaning: the pair is the proof, and it is per scope because a
    -- before-and-after of the deck says nothing about the siding.
    ('siding',            'before', 1, 'per_service_scope', false, 'PROPOSED: a cleaning service is proved by a before and an after of the same elevation.'),
    ('siding',            'after',  1, 'per_service_scope', false, 'PROPOSED: pairs with before.'),
    ('gutter_brightening','before', 1, 'per_service_scope', false, 'PROPOSED: cleaning pair.'),
    ('gutter_brightening','after',  1, 'per_service_scope', false, 'PROPOSED: cleaning pair.'),
    ('windows',           'before', 1, 'per_service_scope', false, 'PROPOSED: cleaning pair.'),
    ('windows',           'after',  1, 'per_service_scope', false, 'PROPOSED: cleaning pair.'),
    ('concrete',          'before', 1, 'per_service_scope', false, 'PROPOSED: cleaning pair.'),
    ('concrete',          'after',  1, 'per_service_scope', false, 'PROPOSED: cleaning pair.'),
    ('roof_soft_wash',    'before', 1, 'per_service_scope', false, 'PROPOSED: cleaning pair.'),
    ('roof_soft_wash',    'after',  1, 'per_service_scope', false, 'PROPOSED: cleaning pair.'),
    ('deck',              'before', 1, 'per_service_scope', false, 'PROPOSED: cleaning pair.'),
    ('deck',              'after',  1, 'per_service_scope', false, 'PROPOSED: cleaning pair.'),
    ('fence',             'before', 1, 'per_service_scope', false, 'PROPOSED: cleaning pair.'),
    ('fence',             'after',  1, 'per_service_scope', false, 'PROPOSED: cleaning pair.'),
    ('moss',              'before', 1, 'per_service_scope', false, 'PROPOSED: cleaning pair.'),
    ('moss',              'after',  1, 'per_service_scope', false, 'PROPOSED: cleaning pair.'),
    ('graffiti',          'before', 1, 'per_service_scope', false, 'PROPOSED: cleaning pair.'),
    ('graffiti',          'after',  1, 'per_service_scope', false, 'PROPOSED: cleaning pair.'),

    -- Lighting: what went up, and what it was made of. The component shot
    -- is per_job because one picture of the boxes covers the visit.
    ('permanent_lighting',    'installation', 1, 'per_service_scope', false, 'PROPOSED: the finished run, so a warranty call can see what was installed.'),
    ('permanent_lighting',    'component',    1, 'per_job',           false, 'PROPOSED: what came out of the box. Supplier specifications are NOT known (see the permanent-lighting contract); this proves what was used, it does not certify it.'),
    ('christmas_lighting',    'installation', 1, 'per_service_scope', false, 'PROPOSED: the run as it was left.'),
    ('winter_deicing_cables', 'installation', 1, 'per_service_scope', false, 'PROPOSED: the cable as laid.'),
    ('winter_deicing_cables', 'component',    1, 'per_job',           false, 'PROPOSED: the kit used. Heating requirements are NOT known.'),

    -- The quick winter check. One shot, and the geotag question is the one
    -- the owner most needs to answer, so it is proposed OFF and named.
    ('winter_property_care',  'winter_proof', 1, 'per_job',           false, 'PROPOSED: one quick shot that somebody was there. Whether a device location should be REQUIRED is the open question: proposed false so a basement or a steel garage does not stop the work. min_count and requires_geotag are the two dials the owner has here.')
  ) as v(service_key, requirement, min_count, coverage, requires_geotag, note)
  join public.services s on s.key = v.service_key
 where not exists (
   select 1 from public.ns_evidence_policies p
    where p.service_id = s.id and p.requirement = v.requirement and p.active);

/* ===================================================================== */
/* 10. RLS and grants                                                    */
/* ===================================================================== */

alter table public.ns_evidence_policies           enable row level security;
alter table public.ns_job_evidence                enable row level security;
alter table public.ns_evidence_exceptions         enable row level security;
alter table public.ns_job_completions             enable row level security;
alter table public.ns_job_consumptions            enable row level security;
alter table public.ns_job_completion_corrections  enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'ns_evidence_policies', 'ns_job_evidence', 'ns_evidence_exceptions',
    'ns_job_completions', 'ns_job_consumptions',
    'ns_job_completion_corrections'
  ]
  loop
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    -- Read for any admin. These are the records the office and the crew
    -- both work from; there is nothing per-vehicle about a photograph of a
    -- roof. Writes are not granted at all: every one goes through an RPC.
    execute format(
      'create policy %I on public.%I for select to authenticated
         using (public.is_admin())', t || '_read', t);
    execute format('revoke all on public.%I from public', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end
$$;

do $$
declare
  v text;
begin
  foreach v in array array[
    'ns_job_evidence_requirements', 'ns_job_evidence_readiness'
  ]
  loop
    execute format('alter view public.%I set (security_invoker = on)', v);
    execute format('revoke all on public.%I from public', v);
    execute format('revoke all on public.%I from anon', v);
    execute format('grant select on public.%I to authenticated', v);
    execute format('grant select on public.%I to service_role', v);
  end loop;
end
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.ns_evidence_policy_version()',
    'public.ns_job_completion_is_open(uuid)'
  ]
  loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('grant execute on function %s to authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

/* ===================================================================== */
/* 11. assertions, because an advisory contract is not a contract        */
/* ===================================================================== */

do $$
declare
  t text;
begin
  -- No write grant on any history table. This is the whole point: there is
  -- no path to these rows except the RPCs.
  foreach t in array array[
    'ns_evidence_policies', 'ns_job_evidence', 'ns_evidence_exceptions',
    'ns_job_completions', 'ns_job_consumptions',
    'ns_job_completion_corrections'
  ]
  loop
    if has_table_privilege('authenticated', 'public.' || t, 'insert')
       or has_table_privilege('authenticated', 'public.' || t, 'update')
       or has_table_privilege('authenticated', 'public.' || t, 'delete') then
      raise exception 'authenticated can write public.% directly', t;
    end if;
    if has_table_privilege('anon', 'public.' || t, 'select') then
      raise exception 'anon can read public.%', t;
    end if;
  end loop;

  if to_regclass('public.ns_change_orders') is not null then
    if has_table_privilege('authenticated', 'public.ns_change_orders', 'update')
       or has_table_privilege('authenticated', 'public.ns_change_orders', 'delete')
       or has_table_privilege('authenticated', 'public.ns_change_orders', 'insert') then
      raise exception
        'authenticated can still write ns_change_orders directly, so a crew '
        'can approve its own paid change';
    end if;
  end if;

  -- And nothing we merely proposed can block a crew.
  if exists (select 1 from public.ns_evidence_policies
              where enforcement = 'blocking' and spec_state <> 'owner_confirmed') then
    raise exception 'a proposed policy is blocking work, which it must never do';
  end if;
end
$$;
