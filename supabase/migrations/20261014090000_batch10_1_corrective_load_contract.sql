-- Batch 10.1 corrective: the six findings from Codex's read-only review of
-- 1ffafc2 (docs/reviews/daily-load-contract-1ffafc2.md at b948db3 on
-- codex/batch-10-2), which blocked 10.2.
--
-- All six were verified against this repository's own source before
-- anything was changed. FOUR WERE BACKEND DEFECTS IN 10.1, not gaps in the
-- prose, and two were contract gaps that needed a decision. What each one
-- turned into:
--
--   1 the crew's read path was never frozen, and admin/js/lib/api.js read
--     ns_load_plan_view with a DTO that omitted four fields and excluded
--     closed plans -> get_load_plan() and ns_load_day_summary(), ONE frozen
--     shape each, closed plans included.
--
--   2 clearing a Manual Keep deleted the durable keep but left the live
--     line reading 'keep' with "Kept back on purpose" and manual_keep
--     false, so Return -> Keep -> clear left a Keep nobody had asked for
--     and confirmation skipped the return -> the line now remembers what it
--     was before the keep and goes back to it.
--
--   3 set_manual_keep validated its key and never stored or looked it up;
--     the exception and reconciliation paths returned on a matching key
--     without comparing intent; reconciliation returned BEFORE its location
--     check; confirmation keyed off plan status rather than the supplied
--     key -> one key ledger and one guard, used by all four.
--
--   4 the Keep, exception and reconciliation receipts were underspecified
--     and differed between the SQL and the contract -> every mutation now
--     stores the exact receipt it returned, and a replay returns it
--     byte-for-byte.
--
--   5 THE ACCOUNTING BUG. A closing count was compared against the view's
--     `on_hand`, which the 8.1 view defines as USABLE only, and the
--     resulting variance was then posted to the DAMAGED pool when the
--     reason was 'damaged'. Ten usable counted as eight left usable at ten
--     and damaged at MINUS two. Now a damaged shortfall is two movements:
--     off usable, onto damaged, which is what "the ledger agrees with the
--     van" has to mean.
--
--   6 skip_required and carry_extra were stored, linked to the line, and
--     never read: confirmation transferred the item anyway -> an authorised
--     skip now marks the line and confirmation skips it, and a carry_extra
--     for something absent from the plan adds a line so confirmation
--     carries it.
--
-- APPEND-ONLY. The 10.1 migrations are not edited; this corrects them
-- forward. ns_load_plan_view is left exactly as it is -- nothing that reads
-- it breaks -- and the frozen read path is a function beside it.
--
-- NOT APPLIED. Written and tested against a disposable PostgreSQL only.
-- Contract: docs/daily-load-contract-v1.md, now v2.

/* ===================================================================== */
/* 1. one key ledger, and one guard (finding 3, and finding 4's receipts) */
/* ===================================================================== */

-- WHY A TABLE AND NOT A FLAG ON EACH SUBJECT. set_manual_keep's subject is
-- a row it DELETES when the keep is cleared, so a key recorded there does
-- not survive the operation it was meant to make replayable. A late retry
-- of the keep would then re-apply it, which is the defect. The key has to
-- outlive its subject, so it lives in its own ledger.
--
-- The receipt is stored with it, which is what makes finding 4 answerable:
-- a replay returns the bytes the first call returned rather than a fresh
-- derivation that may have moved on.
create table if not exists public.ns_load_operations (
  client_operation_id text primary key,
  kind                text not null,
  location_id         uuid not null references public.ns_stock_locations(id)
                        on delete cascade,
  work_date           date not null,

  -- md5 over the canonical request. A retry under the same key with a
  -- DIFFERENT payload is a different request wearing the same name.
  intent_fingerprint  text not null,

  actor_id            uuid references auth.users(id),
  created_at          timestamptz not null default now(),
  receipt             jsonb not null,

  constraint ns_load_operations_key_not_blank
    check (btrim(client_operation_id) <> ''),
  constraint ns_load_operations_kind_known check (kind in (
    'manual_keep', 'exception', 'confirmation', 'reconciliation')),
  constraint ns_load_operations_fingerprint_not_blank
    check (btrim(intent_fingerprint) <> '')
);

create index if not exists ns_load_operations_day_idx
  on public.ns_load_operations (location_id, work_date, kind);

comment on table public.ns_load_operations is
  'Replay keys for the four daily-load mutations, with the receipt each one '
  'returned. Separate from the subject rows because a cleared Manual Keep '
  'deletes its own row and the key has to outlive it (Batch 10.1 '
  'corrective, finding 3).';

-- Canonical text of a request. jsonb compares canonically (object keys are
-- sorted), and any array a caller may legitimately reorder is sorted by the
-- caller before it gets here.
create or replace function public.ns_load_intent_fingerprint(p_parts jsonb)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select md5(coalesce(p_parts, '{}'::jsonb)::text);
$$;

-- THE GUARD. Order matters and is the same order the corrected seasonal
-- guard uses: kind, then SCOPE, then intent. Scope before intent so that a
-- caller who cannot see the location is refused without being told anything
-- about what the key was used for.
create or replace function public.ns_load_replay_guard(
  p_client_operation_id text,
  p_kind                text,
  p_fingerprint         text
)
returns jsonb
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v public.ns_load_operations;
begin
  select * into v from public.ns_load_operations
   where client_operation_id = p_client_operation_id;
  if not found then return null; end if;

  if v.kind <> p_kind then
    raise exception
      'That key was already used for a % , not a %. A key belongs to the '
      'operation it was first used for.', v.kind, p_kind
      using errcode = 'unique_violation';
  end if;

  if not public.can_see_location(v.location_id) then
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

/* ===================================================================== */
/* 2. a line remembers what it was before a Manual Keep (finding 2)       */
/* ===================================================================== */

alter table public.ns_load_plan_lines
  add column if not exists pre_keep_action text;
alter table public.ns_load_plan_lines
  add column if not exists pre_keep_reason text;

comment on column public.ns_load_plan_lines.pre_keep_action is
  'What the plan recommended before a Manual Keep overrode it. Clearing the '
  'keep restores it. Without this, Return -> Keep -> clear left a live Keep '
  'line that nothing had recommended and that confirmation then skipped '
  '(Batch 10.1 corrective, finding 2).';

-- 'skip' is new (finding 6): an owner-authorised departure that
-- confirmation must NOT transfer.
alter table public.ns_load_plan_lines
  drop constraint if exists ns_plan_lines_action_known;
alter table public.ns_load_plan_lines
  add constraint ns_plan_lines_action_known check (action in (
    'keep', 'add', 'return',
    -- new in the 10.1 corrective
    'skip'));

-- 'exception' is new: a line that exists, or has been set aside, because
-- the owner said so rather than because the day's work implied it.
alter table public.ns_load_plan_lines
  drop constraint if exists ns_plan_lines_data_state_known;
alter table public.ns_load_plan_lines
  add constraint ns_plan_lines_data_state_known check (data_state in (
    'complete', 'needs_review',
    -- new in the 10.1 corrective
    'exception'));

/* ---------------------------------- the plan line serializer (finding 6) -- */

-- The review's finding 6 had a tail I nearly missed: "the response
-- serializer also does not expose the linked exception". ns_load_plan_view
-- carries exception_id; ns_load_plan_result -- the thing every mutation and
-- the new read path actually return -- dropped it, so a screen could not
-- tell an owner-authorised skip from an ordinary line. `pre_keep_action`
-- goes in for the same reason: it is what a cleared Manual Keep will go
-- back to, and a screen that cannot see it cannot say so.
--
-- Replaced whole rather than patched: a jsonb_build_object has no seams.
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
               -- new in the 10.1 corrective
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
/* 3. the frozen read path (finding 1)                                    */
/* ===================================================================== */

-- WHY A FUNCTION AND NOT "QUERY THE VIEW". A view is a surface a client
-- shapes for itself, and that is exactly what went wrong: api.js built a
-- DTO from ns_load_plan_view that dropped location_id, the note, and the
-- two counts, and filtered closed plans out altogether, so the contract's
-- §4 and the only implementation disagreed and neither was authoritative.
-- One function returns one shape, and the contract freezes it.
--
-- The view stays exactly as it is: anything already reading it keeps
-- working.
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

  -- The live plan if there is one, otherwise the day's closed plan, which
  -- a crew looking back at yesterday evening legitimately wants.
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

    -- 'none' is a state, not an error and not an empty plan. A caller must
    -- be able to tell "nobody has built one" from "the plan is empty",
    -- because only the first is something to act on.
    'state',         v_state,

    -- Can this caller create one? build_load_plan is owner-only, so a crew
    -- facing 'none' needs to be told to ring the office rather than shown
    -- a button that will refuse it.
    'can_build',     public.is_owner(),

    'plan', case when v_plan.id is null then null else
      public.ns_load_plan_result(v_plan.id, false) end,

    -- The two counts the old DTO dropped, both of which change what the
    -- screen should say.
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

-- The day's authorised visits, and the vehicles this caller may read. Kept
-- separate so a screen can refresh one without the other, and returned
-- INSIDE get_load_plan as well so a cold open is one round trip.
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

  return jsonb_build_object(
    'work_date', p_work_date,
    'jobs', coalesce((
      select jsonb_agg(jsonb_build_object(
               'job_id',        j.job_id,
               -- TRUE means an explicit ns_job_vehicle_assignments row.
               -- FALSE means unassigned and therefore ours by the one-crew
               -- rule, which is a different fact and is reported as one.
               'assigned',      j.assigned,
               'scheduled_for', jb.scheduled_for,
               'customer_name', c.name,
               'status',        jb.status)
             order by jb.scheduled_for nulls last)
        from public.ns_vehicle_day_jobs(v_loc, p_work_date) j
        join public.ns_jobs jb on jb.id = j.job_id
        left join public.customers c on c.id = jb.customer_id), '[]'::jsonb),
    -- Which vehicles this caller may read at all: an owner sees every
    -- active one, a crew sees Base and its own.
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
/* 4. set_manual_keep: reversible, keyed, and with a full receipt          */
/* ===================================================================== */

create or replace function public.set_manual_keep(
  p_client_operation_id text,
  p_location_code       text,
  p_work_date           date,
  p_material_id         uuid,
  -- `default true` is kept from 10.1. Dropping it is a 42P13: PostgreSQL
  -- refuses to remove a parameter default from an existing function,
  -- because a five-argument call that worked yesterday would stop
  -- resolving.
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

  /* THE KEY IS CHECKED FIRST AND IT IS A REAL CHECK. Before this
     corrective the key was validated for non-blankness and then thrown
     away, so a retry that arrived after the keep had been cleared RE-APPLIED
     it -- the exact failure the contract's §12 promised could not happen. */
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

  /* ---- the live line ----
     SETTING a keep remembers what the line was first, so clearing it can
     put it back. CLEARING restores that, which is finding 2: the previous
     version only converted return -> keep on the way in and left both the
     action and the "Kept back on purpose" wording behind on the way out.
     Building a fresh plan would have corrected it, but building is
     owner-only, so a crew could not undo its own keep. */
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
       and pl.material_id = p_material_id;
  else
    update public.ns_load_plan_lines pl
       set manual_keep = false,
           -- Back to the recommendation, not to a guess. If the line was
           -- never overridden, both columns are null and nothing moves.
           action = coalesce(pl.pre_keep_action, pl.action),
           reason = coalesce(pl.pre_keep_reason, pl.reason),
           pre_keep_action = null,
           pre_keep_reason = null
      from public.ns_load_plans p
     where pl.plan_id = p.id
       and p.location_id = v_loc and p.work_date = p_work_date
       and p.status in ('current', 'confirmed')
       and pl.material_id = p_material_id;
  end if;

  select pl.* into v_line
    from public.ns_load_plan_lines pl
    join public.ns_load_plans p on p.id = pl.plan_id
   where p.location_id = v_loc and p.work_date = p_work_date
     and p.status in ('current', 'confirmed')
     and pl.material_id = p_material_id
   limit 1;

  -- THE FULL RECEIPT (finding 4). The previous one returned five fields and
  -- no `replayed`, so a client could neither tell a retry from a first call
  -- nor see what the line now says.
  v_receipt := jsonb_build_object(
    'location_id',   v_loc,
    'location_code', (select code from public.ns_stock_locations where id = v_loc),
    'work_date',     p_work_date,
    'material_id',   p_material_id,
    'manual_keep',   p_keep,
    'reason',        p_reason,
    'replayed',      false,
    -- null when the day has no live plan: the durable keep is still
    -- recorded and will apply to the next build, which is a state the
    -- screen has to be able to show.
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
/* 5. authorise_load_exception: it now affects the load (finding 6)        */
/* ===================================================================== */

-- `p_quantity` is NEW and defaulted, so every existing seven-argument CALL
-- keeps working -- but the seven-argument FUNCTION has to go first.
-- PostgreSQL refuses `create or replace` here with 42P13, "cannot remove
-- parameter defaults from existing function": adding a defaulted parameter
-- to a function that already has defaulted ones would leave two overloads
-- whose calls are ambiguous. Dropping it also means there is never a moment
-- when both exist, one of which silently has no effect on the load.
drop function if exists public.authorise_load_exception(
  text, text, date, text, text, uuid, uuid);

create or replace function public.authorise_load_exception(
  p_client_operation_id text,
  p_location_code       text,
  p_work_date           date,
  p_kind                text,
  p_reason              text,
  p_material_id         uuid    default null,
  p_rental_set_id       uuid    default null,
  p_quantity            numeric default null
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
  v_id      uuid;
  v_plan    public.ns_load_plans;
  v_mat     public.ns_materials;
  v_n       integer := 0;
  v_added   uuid;
  v_receipt jsonb;
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

  v_print := public.ns_load_intent_fingerprint(jsonb_build_object(
    'location_code', lower(btrim(p_location_code)),
    'work_date',     p_work_date,
    'kind',          p_kind,
    'reason',        btrim(p_reason),
    'material_id',   p_material_id,
    'rental_set_id', p_rental_set_id,
    'quantity',      p_quantity));

  v_replay := public.ns_load_replay_guard(
    p_client_operation_id, 'exception', v_print);
  if v_replay is not null then return v_replay; end if;

  v_loc := public.ns_location_by_code(p_location_code);
  if v_loc is null then
    raise exception 'No active stock location with code %', p_location_code
      using errcode = 'no_data_found';
  end if;

  select * into v_plan from public.ns_load_plans
   where location_id = v_loc and work_date = p_work_date
     and status in ('current', 'confirmed');

  if p_material_id is not null then
    select * into v_mat from public.ns_materials where id = p_material_id;
    if not found then
      raise exception 'No such material %', p_material_id
        using errcode = 'no_data_found';
    end if;
  end if;

  /* A CARRY_EXTRA HAS TO SAY HOW MUCH, for anything counted. The previous
     version accepted "take an extra" with no amount, stored it, and
     confirmation ignored it -- so the owner's instruction had no effect at
     all. A set has no quantity and a level-tracked supply has no number, so
     those two are exempt. */
  if p_kind = 'carry_extra' and p_rental_set_id is null
     and v_mat.tracking_mode <> 'level' then
    if p_quantity is null or p_quantity <= 0 then
      raise exception
        'Say how much extra of % to carry. An authorisation with no amount '
        'is not something a confirmation can act on.', v_mat.name
        using errcode = 'invalid_parameter_value';
    end if;
  end if;
  if p_kind = 'skip_required' and p_quantity is not null then
    raise exception
      'A skip has no quantity: it sets the whole line aside. Raise a '
      'separate authorisation if only part of it is being left behind.'
      using errcode = 'invalid_parameter_value';
  end if;

  insert into public.ns_load_exceptions
    (location_id, work_date, material_id, rental_set_id, kind, reason,
     authorised_by, client_operation_id)
  values
    (v_loc, p_work_date, p_material_id, p_rental_set_id, p_kind, btrim(p_reason),
     auth.uid(), p_client_operation_id)
  returning id into v_id;

  if v_plan.id is not null then
    /* ---- the effect on the plan, which is the whole of finding 6 ----
       skip_required: the line is set aside. `action = 'skip'` is what
       confirm_load_plan now reads to leave it alone; before this, an
       authorised skip was recorded, linked, and then transferred anyway. */
    if p_kind = 'skip_required' then
      update public.ns_load_plan_lines pl
         set exception_id = v_id,
             pre_keep_action = coalesce(pl.pre_keep_action, pl.action),
             pre_keep_reason = coalesce(pl.pre_keep_reason, pl.reason),
             action = 'skip',
             data_state = 'exception',
             reason = 'Owner authorised going without it: ' || btrim(p_reason)
       where pl.plan_id = v_plan.id
         and (  (p_material_id is not null and pl.material_id = p_material_id)
             or (p_rental_set_id is not null and pl.rental_set_id = p_rental_set_id));
      get diagnostics v_n = row_count;

    else
      -- carry_extra: mark the line if the plan already has one...
      update public.ns_load_plan_lines pl
         set exception_id = v_id,
             data_state = 'exception',
             required_qty = case
               when p_quantity is null then pl.required_qty
               else coalesce(pl.required_qty, 0) + p_quantity end,
             reason = 'Owner authorised carrying extra: ' || btrim(p_reason)
       where pl.plan_id = v_plan.id
         and (  (p_material_id is not null and pl.material_id = p_material_id)
             or (p_rental_set_id is not null and pl.rental_set_id = p_rental_set_id));
      get diagnostics v_n = row_count;

      -- ...and ADD one if it does not, which is the case Codex asked about:
      -- an extra item absent from the plan could not otherwise be carried,
      -- because confirmation only walks plan lines.
      if v_n = 0 then
        insert into public.ns_load_plan_lines
          (plan_id, line_kind, action, material_id, rental_set_id,
           required_qty, aboard_qty, reserved_qty, available_qty, damaged_qty,
           shortage_qty, unit, precision, level_state, data_state, reason,
           job_ids, manual_keep, exception_id)
        select v_plan.id,
               case when p_rental_set_id is not null then 'seasonal_set'
                    when m.category = 'tool' then 'equipment'
                    else 'consumable' end,
               'add',
               p_material_id, p_rental_set_id,
               p_quantity,
               coalesce(b.on_hand, 0),
               coalesce(b.reserved, 0),
               coalesce(base.on_hand, 0),
               coalesce(b.damaged_on_hand, 0),
               greatest(coalesce(p_quantity, 0) - coalesce(base.on_hand, 0), 0),
               m.unit,
               'exact',
               null,
               'exception',
               'Owner authorised carrying extra: ' || btrim(p_reason),
               '{}'::uuid[],
               false,
               v_id
          from (select 1) one
          left join public.ns_materials m on m.id = p_material_id
          left join public.ns_material_stock_by_location b
                 on b.material_id = p_material_id and b.location_id = v_loc
          left join public.ns_material_stock_by_location base
                 on base.material_id = p_material_id
                and base.location_id = (select id from public.ns_stock_locations
                                         where kind = 'base' and active);
        v_added := v_id;
        v_n := 1;
      end if;
    end if;
  end if;

  v_receipt := jsonb_build_object(
    'exception_id',   v_id,
    'replayed',       false,
    'kind',           p_kind,
    'reason',         btrim(p_reason),
    'location_id',    v_loc,
    'location_code',  (select code from public.ns_stock_locations where id = v_loc),
    'work_date',      p_work_date,
    'material_id',    p_material_id,
    'rental_set_id',  p_rental_set_id,
    'quantity',       p_quantity,
    'plan_id',        v_plan.id,
    -- How many plan lines this changed, and whether one had to be created.
    -- Zero with a null plan_id means the day has no live plan and the
    -- authorisation is on record for the next build.
    'lines_affected', v_n,
    'line_added',     v_added is not null);

  insert into public.ns_load_operations
    (client_operation_id, kind, location_id, work_date, intent_fingerprint,
     actor_id, receipt)
  values
    (p_client_operation_id, 'exception', v_loc, p_work_date, v_print,
     auth.uid(), v_receipt);

  return v_receipt;
end
$$;

/* ===================================================================== */
/* 6. confirm_load_plan: keyed on the key, and it honours a skip           */
/* ===================================================================== */

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
  v_plan    public.ns_load_plans%rowtype;
  v_live    text;
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

  v_print := public.ns_load_intent_fingerprint(jsonb_build_object(
    'plan_id',              p_plan_id,
    'expected_revision',    p_expected_revision,
    'expected_fingerprint', p_expected_fingerprint,
    'note',                 p_note));

  /* KEYED ON THE KEY. Before this corrective the early return was
     `if status in ('confirmed','closed') then return replayed`, which meant
     a SECOND confirmation under a DIFFERENT key, carrying a stale revision
     or fingerprint, was answered with a cheerful replay instead of being
     told the plan had moved. The key says whether this is a retry; the
     status says whether the work is already done, and those are different
     questions. */
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

  if p_expected_revision is not null and p_expected_revision <> v_plan.revision then
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

  select id, code into v_base, v_code from public.ns_stock_locations
   where kind = 'base' and active;
  select code into v_vcode from public.ns_stock_locations where id = v_plan.location_id;

  -- How many lines the owner set aside, so the receipt can say so rather
  -- than leaving a silent difference between the plan and the van.
  select count(*)::integer into v_skipped
    from public.ns_load_plan_lines
   where plan_id = p_plan_id and action = 'skip';

  for v_line in
    select pl.* from public.ns_load_plan_lines pl
      join public.ns_materials m on m.id = pl.material_id
     where pl.plan_id = p_plan_id
       -- 'skip' is deliberately absent (finding 6): an owner-authorised
       -- departure is not transferred. Before, it was stored, linked to the
       -- line, and then loaded anyway.
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
                          'lines_skipped_by_exception', v_skipped);

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
/* 7. reconcile_day_end: the right pool, and scope before replay           */
/* ===================================================================== */

-- FINDING 5, THE DECISION IT NEEDED, written down because it is the thing
-- a reader will want and the code cannot say on its own:
--
--   THE COUNT IS OF USABLE STOCK. That is what a crew counts on a van --
--   what is there and fit to use -- and it is what the 8.1 view's `on_hand`
--   means. `damaged_on_hand` is a separate pool.
--
--   DAMAGED ITEMS ARE RETAINED, NOT WRITTEN OFF. Reason 'damaged' therefore
--   means units MOVED from usable to damaged: two movements, not one. The
--   total on the van is unchanged and the usable figure falls, which is the
--   only reading under which "the ledger agrees with the van" is true.
--
--   EVERY OTHER REASON is a single usable-pool adjustment, which is what
--   the previous version did correctly.
--
-- The bug: the variance was computed against usable and then posted with
-- `condition = 'damaged'` for a damaged reason, so ten usable counted as
-- eight left usable at TEN and damaged at MINUS TWO. Both figures wrong,
-- and the damaged pool driven negative -- the same "condition names a POOL,
-- reason says WHY" mistake the 9.1 corrective fixed in scrap_offcut.
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
  v_loc     uuid;
  v_rec     uuid;
  v_plan    uuid;
  v_item    jsonb;
  v_mat     uuid;
  v_count   numeric;
  v_level   text;
  v_prec    text;
  v_why     text;
  v_have    numeric;
  v_var     numeric;
  v_n       integer := 0;
  v_print   text;
  v_replay  jsonb;
  v_receipt jsonb;
begin
  if not public.is_admin() then
    raise exception 'reconcile_day_end is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Send the counts as an array'
      using errcode = 'invalid_parameter_value';
  end if;

  /* The count array is SORTED before hashing: two clients that count the
     same van in a different order are making the same request, and
     refusing that retry would be a bug rather than a safeguard. */
  v_print := public.ns_load_intent_fingerprint(jsonb_build_object(
    'location_code', lower(btrim(p_location_code)),
    'work_date',     p_work_date,
    'note',          p_note,
    'lines', coalesce((
      select jsonb_agg(e order by e::text)
        from jsonb_array_elements(p_lines) e), '[]'::jsonb)));

  /* SCOPE BEFORE REPLAY was the other half of finding 3: this function
     returned the stored receipt on a matching key BEFORE checking
     can_see_location, so a crew holding another vehicle's key could read
     that vehicle's closing count. The guard checks kind, then scope, then
     intent, in that order. */
  v_replay := public.ns_load_replay_guard(
    p_client_operation_id, 'reconciliation', v_print);
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
    v_prec  := coalesce(v_item ->> 'precision', 'exact');
    v_why   := nullif(v_item ->> 'variance_reason', '');

    if v_mat is null then
      raise exception 'Every count line needs a material_id'
        using errcode = 'invalid_parameter_value';
    end if;

    -- A level is an observation of a level-tracked supply: it posts no
    -- movement, because the ledger is quantitative.
    if v_level is not null then
      insert into public.ns_day_reconciliation_lines
        (reconciliation_id, material_id, level_state, precision,
         variance_reason, note)
      values (v_rec, v_mat, v_level, v_prec, v_why, v_item ->> 'note')
      on conflict (reconciliation_id, material_id) do update
         set level_state = excluded.level_state, note = excluded.note;

      insert into public.ns_material_levels (material_id, location_id, state,
                                             checked_at, checked_by, note)
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

    /* THE BASIS, stated here as well as in the contract because getting it
       wrong is finding 5. `on_hand` in this view is the USABLE pool, read
       LIVE -- not the plan's generation-time snapshot, which is a
       recommendation basis and has no business validating a physical
       count hours later. */
    select coalesce(on_hand, 0) into v_have
      from public.ns_material_stock_by_location
     where material_id = v_mat and location_id = v_loc;
    v_have := coalesce(v_have, 0);
    v_var  := v_count - v_have;

    if v_var <> 0 and v_why is null then
      raise exception
        'The count for that material differs from the ledger by %. Say why '
        '(damaged, lost, miscounted, used_more, used_less, other) -- an '
        'unexplained correction is the row nobody can account for later.',
        v_var
        using errcode = 'check_violation';
    end if;

    -- 'damaged' says units became unusable, which can only make the usable
    -- count FALL. A surplus called damaged is a different event -- somebody
    -- found stock, or the reason is wrong -- and guessing between them is
    -- how a pool goes negative.
    if v_why = 'damaged' and v_var > 0 then
      raise exception
        'The count is % MORE than the ledger, so "damaged" cannot explain '
        'it: damaged stock reduces what is usable. Use miscounted, or '
        'count the damaged items separately.', v_var
        using errcode = 'check_violation';
    end if;

    insert into public.ns_day_reconciliation_lines
      (reconciliation_id, material_id, expected_qty, counted_qty, variance_qty,
       precision, variance_reason, note)
    values (v_rec, v_mat, v_have, v_count, v_var, v_prec, v_why,
            v_item ->> 'note')
    on conflict (reconciliation_id, material_id) do update
       set expected_qty = excluded.expected_qty,
           counted_qty = excluded.counted_qty,
           variance_qty = excluded.variance_qty,
           variance_reason = excluded.variance_reason,
           note = excluded.note;

    if v_var <> 0 then
      if v_why = 'damaged' then
        -- TWO MOVEMENTS. Off the usable pool, onto the damaged pool. The
        -- total on the van does not change, which is the point: the items
        -- are still there, they are just not fit to use.
        perform public.post_stock_movement(
          p_client_operation_id || ':' || v_mat::text || ':usable',
          v_mat, p_location_code, v_var, 'adjustment',
          'End of day ' || p_work_date || ': damaged, off usable',
          null, null, null, 'usable', v_prec);
        perform public.post_stock_movement(
          p_client_operation_id || ':' || v_mat::text || ':damaged',
          v_mat, p_location_code, -v_var, 'adjustment',
          'End of day ' || p_work_date || ': damaged, onto damaged',
          null, null, null, 'damaged', v_prec);
      else
        perform public.post_stock_movement(
          p_client_operation_id || ':' || v_mat::text,
          v_mat, p_location_code, v_var, 'adjustment',
          'End of day ' || p_work_date || ': ' || v_why,
          null, null, null, 'usable', v_prec);
      end if;
    end if;
    v_n := v_n + 1;
  end loop;

  if v_plan is not null then
    update public.ns_load_plans
       set status = 'closed', closed_at = now()
     where id = v_plan;
  end if;

  v_receipt := public.ns_reconciliation_result(v_rec, false)
    || jsonb_build_object(
         'lines_counted', v_n,
         -- Named in the receipt so no client has to infer it (finding 4).
         'variance_basis', 'live_usable_on_hand');

  insert into public.ns_load_operations
    (client_operation_id, kind, location_id, work_date, intent_fingerprint,
     actor_id, receipt)
  values
    (p_client_operation_id, 'reconciliation', v_loc, p_work_date, v_print,
     auth.uid(), v_receipt);

  return v_receipt;
end
$$;

/* ===================================================================== */
/* 8. RLS, grants and assertions                                          */
/* ===================================================================== */

alter table public.ns_load_operations enable row level security;

do $$
begin
  execute 'drop policy if exists ns_load_operations_read on public.ns_load_operations';
  -- Read for any admin, scoped to the locations they can see. The receipts
  -- carry no credentials; the KEY is the primary key, so unlike the
  -- seasonal event log there is no column to withhold -- scoping the rows
  -- is what stops one crew reading the other's.
  execute 'create policy ns_load_operations_read on public.ns_load_operations
             for select to authenticated
             using (public.is_admin() and public.can_see_location(location_id))';
  execute 'revoke all on public.ns_load_operations from public';
  execute 'revoke all on public.ns_load_operations from anon';
  execute 'grant select on public.ns_load_operations to authenticated';
  execute 'grant all on public.ns_load_operations to service_role';
end
$$;

do $$
declare
  f text;
begin
  foreach f in array array[
    'public.get_load_plan(text,date)',
    'public.ns_load_day_summary(text,date)',
    'public.ns_load_intent_fingerprint(jsonb)',
    'public.ns_load_replay_guard(text,text,text)',
    'public.set_manual_keep(text,text,date,uuid,boolean,text)',
    'public.authorise_load_exception(text,text,date,text,text,uuid,uuid,numeric)',
    'public.confirm_load_plan(text,uuid,integer,text,text)',
    'public.reconcile_day_end(text,text,date,jsonb,text)'
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
    'public.get_load_plan(text,date)',
    'public.set_manual_keep(text,text,date,uuid,boolean,text)',
    'public.authorise_load_exception(text,text,date,text,text,uuid,uuid,numeric)',
    'public.confirm_load_plan(text,uuid,integer,text,text)',
    'public.reconcile_day_end(text,text,date,jsonb,text)'
  ]
  loop
    if has_function_privilege('anon', f, 'execute') then
      raise exception 'anon can execute %, which it must not', f;
    end if;
  end loop;

  if has_table_privilege('authenticated', 'public.ns_load_operations', 'insert')
     or has_table_privilege('authenticated', 'public.ns_load_operations', 'update')
     or has_table_privilege('authenticated', 'public.ns_load_operations', 'delete') then
    raise exception
      'authenticated can write ns_load_operations directly, so a key ledger '
      'entry could be forged or removed';
  end if;
end
$$;
