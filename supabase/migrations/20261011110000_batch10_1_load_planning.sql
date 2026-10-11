-- Batch 10.1: authoritative daily vehicle load planning.
--
-- WHAT THIS ANSWERS: "What should Car A carry on Thursday, what is already
-- aboard, and what should come off?" -- once for the whole day, not once per
-- job.
--
-- THE FOUR THINGS THAT MUST NEVER BE CONFLATED
--
--   RECOMMENDATION  a plan line. Says what ought to happen. Moves nothing.
--   COMMITMENT      a reservation (Batch 8.1). Reduces what is AVAILABLE to
--                   other work; moves nothing physically.
--   CONFIRMED MOVE  a transfer operation (Batch 8.1). Stock is now in the
--                   car instead of at Base. This is the only step that
--                   changes a balance.
--   CONSUMPTION     a consumed movement. The material is gone.
--
-- Collapsing any two of these is how the same tin of product gets counted
-- twice -- once as planned, once as loaded -- and how a van shows 40 L of a
-- product that was used last week. The plan therefore stores NO quantities
-- of its own that a balance is derived from: every number on a plan line is
-- a READING of the ledger at generation time, carried for display and for
-- detecting that the world has moved on.
--
-- THE DAY IS THE UNIT. Reusable equipment is decided once for the whole day:
-- a pressure washer needed at stop 3 stays aboard through stops 1 and 2, and
-- is not "added" three times. Consumables are the opposite -- they are
-- summed across the day's jobs, because each job uses its own.
--
-- CAR B IS OPTIONAL DATA. Nothing here seeds it, assumes it, or behaves
-- differently because it might exist. A vehicle is a row in
-- ns_stock_locations with kind='vehicle'; there is one today.
--
-- NOT APPLIED. Written and tested against a disposable PostgreSQL only.

/* ===================================================================== */
/* 1. service load rules -- the owner's template                         */
/* ===================================================================== */

-- WHY THIS IS NOT ns_service_material_usage. That table (Batch 8.1) answers
-- "how much material does this service CONSUME per unit", and feeds the job
-- estimate. This answers "what must be ON THE VAN to do this service at
-- all", which includes tools that are consumed by nothing. Folding them
-- together would make a pressure washer look like a quantity of stock that
-- gets used up.

create table if not exists public.ns_service_load_rules (
  id             uuid primary key default gen_random_uuid(),
  service_id     uuid not null references public.services(id) on delete cascade,
  material_id    uuid not null references public.ns_materials(id) on delete restrict,

  rule_kind      text not null,

  -- Consumables only. Either a flat amount per job, or an amount per unit of
  -- the job's measured quantity. Both null means "needed, amount unknown",
  -- which surfaces as Needs review rather than as zero.
  quantity_fixed    numeric,
  quantity_per_unit numeric,

  -- "Reviewed consumable allowances" from the roadmap. A provisional
  -- allowance is a guess the owner has not signed off, and the plan says so
  -- on the line rather than presenting it as a figure.
  allowance_state text not null default 'provisional',

  -- Equipment only. `removable` is the bleach-tools case: it comes off when
  -- no job needs it. `always_keep` overrides everything -- the standard tool
  -- kit never leaves the van.
  removable      boolean not null default false,
  always_keep    boolean not null default false,

  note           text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint ns_load_rules_kind_known check (rule_kind in ('equipment', 'consumable')),
  constraint ns_load_rules_allowance_known check (allowance_state in (
    'provisional',  -- a guess; shows as needs review
    'reviewed'      -- the owner has signed this figure off
  )),
  constraint ns_load_rules_quantities_nonneg check (
    (quantity_fixed is null or quantity_fixed >= 0)
    and (quantity_per_unit is null or quantity_per_unit >= 0)),

  -- Equipment is not quantity-planned: one washer is one washer.
  constraint ns_load_rules_equipment_has_no_quantity check (
    rule_kind <> 'equipment'
    or (quantity_fixed is null and quantity_per_unit is null)),

  -- always_keep and removable are opposites. A rule that said both would
  -- have no defined behaviour on a quiet day.
  constraint ns_load_rules_keep_or_removable check (
    not (always_keep and removable)),

  constraint ns_load_rules_one_per_pair unique (service_id, material_id)
);

create index if not exists ns_load_rules_service_idx
  on public.ns_service_load_rules (service_id);

comment on table public.ns_service_load_rules is
  'What must be ON the van to do a service, as distinct from what the '
  'service consumes. A pressure washer is required and used up by nothing; '
  'ns_service_material_usage cannot express that.';

/* Per-job departures from the template. The roadmap asks for job overrides
   explicitly: one roof needs the long ladder, one customer supplies their
   own water. */
create table if not exists public.ns_job_load_overrides (
  id           uuid primary key default gen_random_uuid(),
  job_id       uuid not null references public.ns_jobs(id) on delete cascade,
  material_id  uuid not null references public.ns_materials(id) on delete restrict,
  action       text not null,
  quantity     numeric,
  reason       text,
  created_by   uuid references auth.users(id),
  created_at   timestamptz not null default now(),

  constraint ns_job_overrides_action_known check (action in (
    'require',   -- this job needs it even though the template does not say so
    'exclude'    -- this job does not need it after all
  )),
  constraint ns_job_overrides_quantity_nonneg check (quantity is null or quantity >= 0),
  constraint ns_job_overrides_one_per_pair unique (job_id, material_id)
);

/* ===================================================================== */
/* 2. which car a job is on                                              */
/* ===================================================================== */

-- There is no crew/vehicle column on ns_jobs, and inventing one would reach
-- into the scheduling model this batch does not own. An assignment row is
-- additive and optional.
--
-- THE RULE WHEN THERE IS NO ROW. With exactly one active vehicle, an
-- unassigned job belongs to it -- that is the business today and pretending
-- otherwise would make every plan empty. With two, an unassigned job is
-- NEEDS REVIEW and appears on neither plan's requirements: guessing which
-- car a job is on is exactly the mistake that strands a crew without a
-- washer.

create table if not exists public.ns_job_vehicle_assignments (
  job_id      uuid primary key references public.ns_jobs(id) on delete cascade,
  location_id uuid not null references public.ns_stock_locations(id) on delete restrict,
  assigned_by uuid references auth.users(id),
  assigned_at timestamptz not null default now(),
  note        text
);

create index if not exists ns_job_vehicle_idx
  on public.ns_job_vehicle_assignments (location_id);

/* ===================================================================== */
/* 3. vehicle baselines and manual keeps                                 */
/* ===================================================================== */

/* "Vehicle baseline replenishment": what this car should carry as standing
   stock regardless of the day's work. Per vehicle, because Car A's baseline
   is not Car B's. */
create table if not exists public.ns_vehicle_baselines (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.ns_stock_locations(id) on delete cascade,
  material_id uuid not null references public.ns_materials(id) on delete restrict,
  target_qty  numeric,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint ns_baselines_target_nonneg check (target_qty is null or target_qty >= 0),
  constraint ns_baselines_one_per_pair unique (location_id, material_id)
);

/* MANUAL KEEP, and why it lives here rather than on a plan line.
   "Manual Keep survives" is an acceptance criterion. A plan is regenerated
   every time the schedule moves; if the keep were a flag on a line, every
   regeneration would wipe it and the crew would find the thing they
   deliberately kept back on the Return list. Keyed by day and material, it
   outlives any number of revisions. */
create table if not exists public.ns_load_manual_keeps (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.ns_stock_locations(id) on delete cascade,
  work_date   date not null,
  material_id uuid not null references public.ns_materials(id) on delete restrict,
  reason      text,
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now(),

  constraint ns_manual_keeps_one_per_day unique (location_id, work_date, material_id)
);

/* ===================================================================== */
/* 4. the plan                                                           */
/* ===================================================================== */

create table if not exists public.ns_load_plans (
  id           uuid primary key default gen_random_uuid(),
  location_id  uuid not null references public.ns_stock_locations(id) on delete restrict,
  work_date    date not null,

  -- THE AUTHORITATIVE REVISION. A confirmation names the revision it is
  -- confirming; a stale one is refused with the current number, never
  -- silently applied.
  revision     integer not null default 1,
  status       text not null default 'current',

  /* A fingerprint of everything the plan was derived from: the jobs, their
     schedule times, their services and measurements, the assignments and
     the seasonal sets. If this changes, the recommendations are out of date
     even though the revision number has not moved yet. It is what lets
     confirmation say "the schedule changed under you" instead of accepting
     an obsolete load list. */
  basis_fingerprint text not null,

  generated_at timestamptz not null default now(),
  generated_by uuid references auth.users(id),
  confirmed_at timestamptz,
  confirmed_by uuid references auth.users(id),
  closed_at    timestamptz,
  closed_by    uuid references auth.users(id),
  client_operation_id text not null,
  note         text,

  constraint ns_load_plans_status_known check (status in (
    'current',      -- the live plan for that car and day
    'superseded',   -- a newer revision exists
    'confirmed',    -- the crew confirmed the physical load against it
    'closed'        -- the day has been reconciled
  )),
  constraint ns_load_plans_revision_positive check (revision >= 1),
  -- 'closed' is deliberately NOT in this list. A day can be reconciled
  -- without anybody having confirmed the load -- the crew went out, the work
  -- happened, and the counts are still worth recording. Requiring a
  -- confirmation to close would make the honest case impossible.
  constraint ns_load_plans_confirmed_dated check (
    status <> 'confirmed' or confirmed_at is not null),
  constraint ns_load_plans_closed_dated check (
    (status = 'closed') = (closed_at is not null)),
  constraint ns_load_plans_client_id_not_blank check (btrim(client_operation_id) <> ''),
  constraint ns_load_plans_revision_unique unique (location_id, work_date, revision)
);

create unique index if not exists ns_load_plans_client_id_key
  on public.ns_load_plans (client_operation_id);

/* One LIVE plan per car per day. 'superseded' and 'closed' may pile up as
   history; two live ones would let a crew confirm against the wrong list. */
create unique index if not exists ns_load_plans_one_live
  on public.ns_load_plans (location_id, work_date)
  where status in ('current', 'confirmed');

create index if not exists ns_load_plans_day_idx
  on public.ns_load_plans (work_date desc, location_id);

create table if not exists public.ns_load_plan_lines (
  id             uuid primary key default gen_random_uuid(),
  plan_id        uuid not null references public.ns_load_plans(id) on delete cascade,

  -- Exactly one of these. A named Christmas set is NOT stock: it has no
  -- quantity and cannot be reserved, so it gets its own column rather than
  -- being forced into material_id with a count of 1.
  material_id    uuid references public.ns_materials(id) on delete restrict,
  rental_set_id  uuid references public.ns_rental_sets(id) on delete restrict,

  line_kind      text not null,
  action         text not null,

  /* SIX DISTINCT QUANTITIES, because the roadmap asks for them separately
     and because a single "needed" number hides every interesting case:

       required   what the day's work calls for
       aboard     what the ledger says is in this vehicle now
       reserved   what is already committed to specific jobs
       available  what could be drawn from the source location
       damaged    present but not usable
       shortage   required minus what can be got hold of

     All are readings taken at generation time. Nothing downstream derives a
     balance from them. */
  required_qty   numeric,
  aboard_qty     numeric,
  reserved_qty   numeric,
  available_qty  numeric,
  damaged_qty    numeric,
  shortage_qty   numeric,

  unit           text,
  precision      text not null default 'exact',

  -- Empty / Low / Enough. A level-tracked supply has NO number, ever.
  level_state    text,

  data_state     text not null default 'complete',
  reason         text not null,
  job_ids        uuid[] not null default '{}',

  manual_keep    boolean not null default false,
  exception_id   uuid,

  -- Set when a crew confirms the physical move for this line. The transfer
  -- operation is where the stock actually moved; this is the link back.
  confirmed_operation uuid references public.ns_stock_operations(id) on delete set null,
  confirmed_at   timestamptz,

  created_at     timestamptz not null default now(),

  constraint ns_plan_lines_kind_known check (line_kind in (
    'equipment', 'consumable', 'seasonal_set')),
  constraint ns_plan_lines_action_known check (action in ('keep', 'add', 'return')),
  constraint ns_plan_lines_precision_known check (precision in ('exact', 'estimated')),
  constraint ns_plan_lines_data_state_known check (data_state in (
    'complete',
    'needs_review'   -- something the plan could not establish
  )),
  constraint ns_plan_lines_level_known check (
    level_state is null or level_state in ('empty', 'low', 'enough')),

  -- One subject per line.
  constraint ns_plan_lines_one_subject check (
    (material_id is not null) <> (rental_set_id is not null)),
  constraint ns_plan_lines_set_is_seasonal check (
    rental_set_id is null or line_kind = 'seasonal_set'),

  /* A LEVEL-TRACKED SUPPLY HAS NO QUANTITY. The roadmap is explicit, and
     this is the constraint that stops a screen inventing one: if the line
     carries a level, every quantity column must be null. */
  constraint ns_plan_lines_level_has_no_quantity check (
    level_state is null
    or (required_qty is null and aboard_qty is null and reserved_qty is null
        and available_qty is null and damaged_qty is null and shortage_qty is null)),

  constraint ns_plan_lines_reason_not_blank check (btrim(reason) <> ''),
  constraint ns_plan_lines_confirmed_dated check (
    (confirmed_operation is null) = (confirmed_at is null)),

  constraint ns_plan_lines_one_per_subject unique nulls not distinct
    (plan_id, material_id, rental_set_id)
);

create index if not exists ns_plan_lines_plan_idx
  on public.ns_load_plan_lines (plan_id, action);

comment on table public.ns_load_plan_lines is
  'A recommendation, not a movement. Every quantity here is a reading taken '
  'when the plan was generated; nothing derives a balance from them. '
  'Confirming a line posts a transfer, and THAT is what moves stock.';

/* ===================================================================== */
/* 5. owner-authorised exceptions                                        */
/* ===================================================================== */

-- "Crew can retain an optional spare or record an owner-authorised
-- exception." The exception is the owner's, which is why it carries an
-- authoriser and is refused to a crew.

create table if not exists public.ns_load_exceptions (
  id           uuid primary key default gen_random_uuid(),
  location_id  uuid not null references public.ns_stock_locations(id) on delete cascade,
  work_date    date not null,
  material_id  uuid references public.ns_materials(id) on delete restrict,
  rental_set_id uuid references public.ns_rental_sets(id) on delete restrict,

  kind         text not null,
  reason       text not null,
  authorised_by uuid references auth.users(id),
  authorised_at timestamptz not null default now(),
  client_operation_id text not null,

  constraint ns_load_exceptions_kind_known check (kind in (
    'skip_required',   -- go without something the plan says is required
    'carry_extra'      -- take something the plan does not call for
  )),
  constraint ns_load_exceptions_reason_not_blank check (btrim(reason) <> ''),
  constraint ns_load_exceptions_one_subject check (
    (material_id is not null) <> (rental_set_id is not null)),
  constraint ns_load_exceptions_client_id_not_blank
    check (btrim(client_operation_id) <> '')
);

create unique index if not exists ns_load_exceptions_client_id_key
  on public.ns_load_exceptions (client_operation_id);

create index if not exists ns_load_exceptions_day_idx
  on public.ns_load_exceptions (location_id, work_date);

/* ===================================================================== */
/* 6. end-of-day reconciliation                                          */
/* ===================================================================== */

create table if not exists public.ns_day_reconciliations (
  id          uuid primary key default gen_random_uuid(),
  location_id uuid not null references public.ns_stock_locations(id) on delete restrict,
  work_date   date not null,
  plan_id     uuid references public.ns_load_plans(id) on delete set null,
  operation_id uuid references public.ns_stock_operations(id) on delete set null,
  client_operation_id text not null,
  closed_by   uuid references auth.users(id),
  closed_at   timestamptz not null default now(),
  note        text,

  constraint ns_day_recon_client_id_not_blank check (btrim(client_operation_id) <> ''),
  constraint ns_day_recon_one_per_day unique (location_id, work_date)
);

create unique index if not exists ns_day_recon_client_id_key
  on public.ns_day_reconciliations (client_operation_id);

create table if not exists public.ns_day_reconciliation_lines (
  id              uuid primary key default gen_random_uuid(),
  reconciliation_id uuid not null references public.ns_day_reconciliations(id) on delete cascade,
  material_id     uuid not null references public.ns_materials(id) on delete restrict,

  expected_qty    numeric,
  counted_qty     numeric,
  variance_qty    numeric,
  precision       text not null default 'exact',
  level_state     text,
  variance_reason text,
  note            text,

  constraint ns_recon_lines_precision_known check (precision in ('exact', 'estimated')),
  constraint ns_recon_lines_level_known check (
    level_state is null or level_state in ('empty', 'low', 'enough')),
  constraint ns_recon_lines_level_has_no_quantity check (
    level_state is null
    or (expected_qty is null and counted_qty is null and variance_qty is null)),

  /* A variance must say WHY. "Counted 3 fewer" with no reason is the row
     nobody can explain three weeks later, and the roadmap names the
     reasons: damaged, lost, miscounted. */
  constraint ns_recon_lines_variance_explained check (
    coalesce(variance_qty, 0) = 0 or variance_reason is not null),
  constraint ns_recon_lines_reason_known check (variance_reason is null or variance_reason in (
    'damaged', 'lost', 'miscounted', 'used_more', 'used_less', 'other')),
  constraint ns_recon_lines_one_per_material unique (reconciliation_id, material_id)
);

/* ===================================================================== */
/* 7. reading a plan                                                     */
/* ===================================================================== */

drop view if exists public.ns_load_plan_view cascade;
create or replace view public.ns_load_plan_view as
select p.id              as plan_id,
       p.location_id,
       l.code            as location_code,
       l.name            as location_name,
       p.work_date,
       p.revision,
       p.status,
       p.basis_fingerprint,
       p.generated_at,
       p.confirmed_at,
       p.closed_at,
       ln.id             as line_id,
       ln.line_kind,
       ln.action,
       ln.material_id,
       m.name            as material_name,
       m.sku,
       m.category,
       m.tracking_mode,
       ln.rental_set_id,
       s.set_code,
       ln.required_qty,
       ln.aboard_qty,
       ln.reserved_qty,
       ln.available_qty,
       ln.damaged_qty,
       ln.shortage_qty,
       ln.unit,
       ln.precision,
       ln.level_state,
       ln.data_state,
       ln.reason,
       ln.job_ids,
       ln.manual_keep,
       ln.exception_id,
       ln.confirmed_operation,
       ln.confirmed_at   as line_confirmed_at
  from public.ns_load_plans p
  join public.ns_stock_locations l on l.id = p.location_id
  left join public.ns_load_plan_lines ln on ln.plan_id = p.id
  left join public.ns_materials m on m.id = ln.material_id
  left join public.ns_rental_sets s on s.id = ln.rental_set_id;

/* ===================================================================== */
/* 8. RLS and grants                                                     */
/* ===================================================================== */

do $$
declare
  t text;
begin
  foreach t in array array[
    'ns_service_load_rules', 'ns_job_load_overrides', 'ns_job_vehicle_assignments',
    'ns_vehicle_baselines', 'ns_load_manual_keeps', 'ns_load_plans',
    'ns_load_plan_lines', 'ns_load_exceptions', 'ns_day_reconciliations',
    'ns_day_reconciliation_lines'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);
    execute format('drop policy if exists %I on public.%I', t || '_read', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (public.is_admin())',
      t || '_read', t);
  end loop;
end
$$;

/* THE TEMPLATE IS THE OWNER'S. Service load rules, job overrides, vehicle
   assignments and baselines decide what every plan recommends, so a crew
   reads them and does not write them. */
do $$
declare
  t text;
begin
  foreach t in array array[
    'ns_service_load_rules', 'ns_job_load_overrides',
    'ns_job_vehicle_assignments', 'ns_vehicle_baselines'
  ] loop
    execute format('drop policy if exists %I on public.%I', t || '_owner_writes', t);
    execute format(
      'create policy %I on public.%I for all to authenticated '
      'using (public.is_owner()) with check (public.is_owner())',
      t || '_owner_writes', t);
  end loop;
end
$$;

-- Plans, manual keeps, exceptions and reconciliations are written only by
-- the RPCs in the next migration: each one moves two or more tables
-- together, or depends on a revision check that a direct write would skip.

/* A crew sees the plans for the vehicles it can see, and Base. The same
   scoping as the stock it describes -- a plan for the other car is a list
   of stock the crew cannot touch. */
drop policy if exists ns_load_plans_read on public.ns_load_plans;
create policy ns_load_plans_read on public.ns_load_plans
  for select to authenticated
  using (public.is_admin() and public.can_see_location(location_id));

drop policy if exists ns_load_exceptions_read on public.ns_load_exceptions;
create policy ns_load_exceptions_read on public.ns_load_exceptions
  for select to authenticated
  using (public.is_admin() and public.can_see_location(location_id));

do $$
begin
  execute 'alter view public.ns_load_plan_view set (security_invoker = on)';
  execute 'revoke all on public.ns_load_plan_view from public';
  execute 'revoke all on public.ns_load_plan_view from anon';
  execute 'grant select on public.ns_load_plan_view to authenticated';
  execute 'grant select on public.ns_load_plan_view to service_role';
end
$$;
