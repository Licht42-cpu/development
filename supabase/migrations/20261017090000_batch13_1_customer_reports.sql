-- ===========================================================================
-- Batch 13.1 (1 of 4): the customer's report of accepted work.
--
-- WHAT THIS IS. A customer-facing projection of ONE accepted completion
-- (Batch 11.1), built from an explicit field allowlist, versioned, and
-- immutable once issued. Nothing here sends anything, publishes anything by
-- itself, or prices anything.
--
-- THE THREE RULES THIS FILE EXISTS TO ENFORCE.
--
--  1. ACCEPTED COMPLETION IS THE ONLY SOURCE. Not a worker's tap, not
--     `work_finished` (12.1 §7), not a reopened job's old row. A report
--     cannot exist without an `ns_job_completions` row, and it names the
--     exact row it came from.
--
--  2. AN ALLOWLIST, NOT A SERIALISED ROW. Every field the customer sees is
--     named in ns_customer_report_document(). No `to_jsonb(j)`, no
--     `select *`, nowhere. That is why an access code added to some table
--     next year cannot appear on a customer's document by accident: a new
--     column is invisible here until somebody writes its name.
--
--  3. PROVING COMPLETION IS NOT PUBLISHING. 11.1's evidence is registered
--     to satisfy a requirement; nothing in it says "the customer may see
--     this photograph". That distinction did not exist, so this file adds
--     it: ns_evidence_publications, owner-decided, one row per evidence
--     record, and the document carries ONLY what was explicitly published.
--     Default is unpublished -- silence is not consent.
--
-- DEDUPLICATION IS LOGICAL, NOT JUST BY BROWSER KEY. `client_operation_id`
-- catches the retry nobody got a response to. `source_version` catches the
-- other half: two tabs, or a retry with a fresh key, generating "the report
-- for this completion as it currently stands" must produce ONE report, not
-- two. The unique index is on (completion_id, source_version), so the
-- second caller is handed the first caller's report.
--
-- NOT APPLIED ANYWHERE. This is the twenty-fifth pending migration.
-- ===========================================================================

/* ===================================================================== */
/* 1. the operation ledger for this batch                                 */
/* ===================================================================== */

-- WHY NOT ns_dispatch_operations. That table's `kind` CHECK enumerates the
-- nine dispatch operations, and widening another batch's constraint to
-- carry handover keys would make a 12.1 assertion fail for a 13.1 reason.
-- Separate ledger, identical discipline -- and the SAME hash function
-- (ns_load_intent_fingerprint), because two intent hashes that disagree is
-- a bug waiting to happen.
create table if not exists public.ns_handover_operations (
  client_operation_id text primary key,
  kind                text not null,
  -- The thing the key was spent on, so the guard can refuse a key reused
  -- against a different report or customer before it compares intent.
  scope_id            uuid,
  intent_fingerprint  text not null,
  actor_id            uuid references auth.users(id),
  receipt             jsonb not null,
  created_at          timestamptz not null default now(),

  constraint ns_handover_operations_kind_known check (kind in (
    'evidence_publication', 'report_generation', 'report_publication',
    'grant_issue', 'grant_revoke', 'report_delivery', 'payment_request')),
  constraint ns_handover_operations_fingerprint_not_blank
    check (btrim(intent_fingerprint) <> '')
);

create index if not exists ns_handover_operations_scope_idx
  on public.ns_handover_operations (kind, scope_id);

comment on table public.ns_handover_operations is
  'Replay ledger for Batch 13.1. One row per accepted customer-handover '
  'operation, keyed by the caller''s own operation id, carrying the receipt '
  'that was returned so a retry can be answered with the same one.';

/** The replay guard: KIND, then SCOPE, then INTENT -- in that order.
 *
 *  Scope before intent is deliberate and is the same ordering 12.1 uses: a
 *  caller who may not see the report the key was spent on must learn that
 *  it may not see it, NOT that its payload differs from one it cannot read.
 *  Comparing intent first would leak the existence and shape of another
 *  customer's document through an error message.
 *
 *  Returns the stored receipt with `replayed: true`, or null for a key that
 *  has never been used. */
create or replace function public.ns_handover_replay_guard(
  p_client_operation_id text,
  p_kind                text,
  p_scope_id            uuid,
  p_fingerprint         text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v public.ns_handover_operations;
begin
  select * into v from public.ns_handover_operations
   where client_operation_id = p_client_operation_id;
  if not found then return null; end if;

  if v.kind <> p_kind then
    raise exception
      'That key was already used for a %, not a %. A key belongs to the '
      'operation it was first used for.', v.kind, p_kind
      using errcode = 'unique_violation';
  end if;

  if v.scope_id is distinct from p_scope_id then
    raise exception
      'That key was already used for a different %. Send a new key.', p_kind
      using errcode = 'unique_violation';
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
/* 2. publishing a piece of evidence is its own decision                  */
/* ===================================================================== */

-- THE DISTINCTION 11.1 DOES NOT MAKE. `ns_job_evidence` answers "does this
-- job have an `after` photograph for the siding". It does not answer "may
-- the customer see it", and the two are not the same question: a
-- `site_condition` photograph of a neighbour's fence, or an
-- `access_hazard` shot that frames a key safe, satisfies a requirement and
-- must not be published.
--
-- So publication is an OWNER decision, recorded per evidence record, with a
-- reason, and the absence of a row means NOT PUBLISHED. The report reads
-- this table; it never reads ns_job_evidence for publishable content.
create table if not exists public.ns_evidence_publications (
  evidence_id   uuid primary key
                  references public.ns_job_evidence(id) on delete cascade,
  job_id        uuid not null references public.ns_jobs(id) on delete cascade,

  -- 'published' the customer may see this image.
  -- 'withheld'  an explicit no, recorded so a later reviewer can see the
  --             decision was made rather than forgotten.
  decision      text not null,
  reason        text,

  -- What the customer is told about the picture. Deliberately NOT
  -- job_attachments.caption: that caption is an internal note the office
  -- writes for itself ("gutter seam, before, note the staining"), and
  -- republishing it is exactly the leak this table exists to prevent.
  customer_caption text,

  decided_by    uuid references auth.users(id),
  decided_at    timestamptz not null default now(),
  client_operation_id text not null,

  constraint ns_evidence_publications_decision_known
    check (decision in ('published', 'withheld')),
  constraint ns_evidence_publications_client_id_not_blank
    check (btrim(client_operation_id) <> ''),
  -- A withheld decision says why. A publication does not have to.
  constraint ns_evidence_publications_withheld_explained check (
    decision <> 'withheld' or coalesce(btrim(reason), '') <> '')
);

create index if not exists ns_evidence_publications_job_idx
  on public.ns_evidence_publications (job_id, decision);

comment on table public.ns_evidence_publications is
  'The owner''s explicit decision about whether one registered evidence '
  'record may be shown to the customer. No row means NOT published: an '
  'attachment that proves completion is not thereby customer-publishable.';

/* ===================================================================== */
/* 3. the report                                                          */
/* ===================================================================== */

create table if not exists public.ns_completion_reports (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid not null references public.ns_jobs(id) on delete restrict,

  -- THE SOURCE, named. Not "the job's latest completion" resolved at read
  -- time -- the row this document was built from, so a reopen cannot
  -- silently change what an issued report claims.
  completion_id uuid not null
                  references public.ns_job_completions(id) on delete restrict,

  -- Per-job, 1, 2, 3... What the customer sees as "Report v2".
  report_version integer not null,

  -- THE LOGICAL IDENTITY of what was generated: a hash over the completion,
  -- its correction count, the published evidence, the recorded consumption
  -- and the approved commercial records. Two generations of the same facts
  -- collapse to one report; a generation after a correction does not.
  source_version text not null,

  -- An amendment names the report it replaces, and a superseded report
  -- keeps its own row and its own document for ever.
  supersedes    uuid references public.ns_completion_reports(id) on delete restrict,

  -- 'draft'      generated, owner can look at it; no customer can.
  -- 'published'  an owner decided a customer may read it.
  -- 'superseded' a later report for the same job replaced it. Still
  --              readable through its own link, still says so.
  publication_state text not null default 'draft',

  -- WHY IT IS STILL A DRAFT, when it is. Visible, rather than the screen
  -- implying it went out on its own.
  review_hold   text,

  -- The allowlisted projection. Frozen at generation.
  document      jsonb not null,

  generated_at  timestamptz not null default now(),
  generated_by  uuid references auth.users(id),
  published_at  timestamptz,
  published_by  uuid references auth.users(id),
  superseded_at timestamptz,
  client_operation_id text not null,

  constraint ns_completion_reports_state_known check (
    publication_state in ('draft', 'published', 'superseded')),
  constraint ns_completion_reports_version_positive check (report_version >= 1),
  constraint ns_completion_reports_source_version_not_blank
    check (btrim(source_version) <> ''),
  constraint ns_completion_reports_client_id_not_blank
    check (btrim(client_operation_id) <> ''),
  -- A published report has a publication time; a draft does not.
  constraint ns_completion_reports_published_pairs check (
    (publication_state = 'published') = (published_at is not null)
      or publication_state = 'superseded'),
  constraint ns_completion_reports_superseded_pairs check (
    (publication_state = 'superseded') = (superseded_at is not null))
);

-- THE LOGICAL DEDUPLICATION. Not the browser key: the facts.
create unique index if not exists ns_completion_reports_source_key
  on public.ns_completion_reports (completion_id, source_version);

create unique index if not exists ns_completion_reports_version_key
  on public.ns_completion_reports (job_id, report_version);

create unique index if not exists ns_completion_reports_client_id_key
  on public.ns_completion_reports (client_operation_id);

create index if not exists ns_completion_reports_job_idx
  on public.ns_completion_reports (job_id, report_version desc);

comment on table public.ns_completion_reports is
  'One customer-facing document per (accepted completion, state of the '
  'facts). Immutable once issued: a correction produces a new, superseding '
  'report that names its source, never an edit to a document the customer '
  'may already have read.';

/* -------------------------------------------- an issued report is fixed */

-- WHAT MAY STILL CHANGE on a report row, and nothing else: draft ->
-- published (with its stamps), and published/draft -> superseded. The
-- document itself, the source, the version and the job are frozen from
-- the moment the row exists, because a document a customer may have opened
-- cannot be quietly rewritten.
create or replace function public.ns_guard_report_immutable()
returns trigger
language plpgsql
as $$
begin
  if new.id is distinct from old.id
     or new.job_id is distinct from old.job_id
     or new.completion_id is distinct from old.completion_id
     or new.report_version is distinct from old.report_version
     or new.source_version is distinct from old.source_version
     or new.document is distinct from old.document
     or new.generated_at is distinct from old.generated_at
     or new.client_operation_id is distinct from old.client_operation_id then
    raise exception
      'A completion report cannot be rewritten. Generate a superseding '
      'report instead -- the customer may already have read this one.'
      using errcode = 'check_violation';
  end if;

  if old.publication_state = 'superseded'
     and new.publication_state <> 'superseded' then
    raise exception 'A superseded report cannot be un-superseded.'
      using errcode = 'check_violation';
  end if;

  return new;
end
$$;

drop trigger if exists ns_completion_reports_immutable
  on public.ns_completion_reports;
create trigger ns_completion_reports_immutable
  before update on public.ns_completion_reports
  for each row execute function public.ns_guard_report_immutable();

-- A report is never deleted. Revoking the customer's access is Migration 2's
-- job and does not destroy the record of what was issued.
create or replace function public.ns_guard_report_no_delete()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'A completion report is a record of what was issued and is not '
    'deletable. Revoke the customer''s grant instead.'
    using errcode = 'check_violation';
end
$$;

drop trigger if exists ns_completion_reports_no_delete
  on public.ns_completion_reports;
create trigger ns_completion_reports_no_delete
  before delete on public.ns_completion_reports
  for each row execute function public.ns_guard_report_no_delete();

/* ===================================================================== */
/* 4. what the customer is allowed to know                                */
/* ===================================================================== */

/** The DEFAULT currency, from the settings row that already holds one.
 *
 *  `quote_defaults.currency` is a real, owner-edited setting (admin
 *  settings view, "Quote defaults"), so there is nothing to invent here.
 *  What this does NOT do is Batch 5's `coalesce(v_currency, 'CAD')`: on a
 *  customer-facing report a guessed currency beside a real figure is worse
 *  than no currency at all, so an unset one stays null and the document
 *  says `unconfigured`. */
create or replace function public.ns_default_currency()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v text;
begin
  if to_regclass('public.app_settings') is null then return null; end if;
  begin
    execute $q$
      select nullif(btrim(coalesce(value::jsonb ->> 'currency', '')), '')
        from public.app_settings where key = 'quote_defaults' limit 1
    $q$ into v;
  exception when others then
    return null;
  end;
  return v;
end
$$;

/** The company block a customer document carries.
 *
 *  THE EXISTING `company` SETTINGS ROW -- the same one get_customer_quote
 *  has always put on the quote page, so the two documents cannot disagree
 *  about who sent them. Returned whole rather than field by field for the
 *  same reason the quote RPC does: it is the owner's own text about their
 *  own business, already customer-facing, and re-listing its keys here
 *  would silently drop one the owner added in Settings. */
create or replace function public.ns_business_identity()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v jsonb;
begin
  if to_regclass('public.app_settings') is null then
    return jsonb_build_object('state', 'unconfigured');
  end if;
  begin
    execute $q$
      select value::jsonb from public.app_settings where key = 'company' limit 1
    $q$ into v;
  exception when others then
    return jsonb_build_object('state', 'unconfigured');
  end;
  if v is null then
    return jsonb_build_object('state', 'unconfigured');
  end if;
  return v || jsonb_build_object('state', 'configured');
end
$$;

/** The approved commercial facts for a job, and NOTHING derived from
 *  material quantities, a report total or a price-book lookup.
 *
 *  Two sources, both of them already authoritative and already frozen:
 *   * the ACCEPTED quote (Batch 5 froze its customer-facing content and
 *     its total at send; acceptance is the customer's own act), and
 *   * APPROVED change orders (11.1: priced by the owner in the same
 *     transaction as the approval, so an approved one always has a figure).
 *
 *  A proposed change order is NOT here. It is a crew's suggestion, it has
 *  no price by construction, and putting it on a customer's document would
 *  turn a proposal into a charge. */
create or replace function public.ns_job_approved_commercials(p_job_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with q as (
    select id, version, total, status, currency
      from public.ns_quotes
     where job_id = p_job_id and status = 'accepted'
     order by version desc nulls last, created_at desc nulls last
     limit 1
  ), co as (
    select id, description, amount
      from public.ns_change_orders
     where job_id = p_job_id and status = 'approved' and amount is not null
  )
  select jsonb_build_object(
    'accepted_quote', (
      select case when q.id is null then null else jsonb_build_object(
               'quote_id', q.id, 'version', q.version, 'total', q.total)
             end from q),
    'approved_changes', coalesce((
      select jsonb_agg(jsonb_build_object(
               'change_order_id', co.id,
               'description',     co.description,
               'amount',          co.amount)
             order by co.description, co.id)
        from co), '[]'::jsonb),
    -- The one arithmetic this file does, over two already-approved
    -- figures. Null when there is no accepted quote: "we do not have an
    -- authoritative total" is a state, not a zero.
    'approved_total', (
      select case when q.total is null then null
                  else q.total + coalesce((select sum(co.amount) from co), 0)
             end from q),
    -- The ACCEPTED QUOTE'S OWN currency first: it is frozen on the row the
    -- customer accepted, so it is the only answer that cannot drift when
    -- the owner changes the default later. The setting is the fallback for
    -- a quote stored before that column was populated, and `unconfigured`
    -- is the honest third answer.
    --
    -- THE SUBQUERY TRAP, and why these are written this way. A scalar
    -- `(select ... from q)` over an EMPTY `q` returns null, not the CASE's
    -- else branch -- the CASE never runs, because there is no row to run it
    -- on. The first draft wrote `commercial_state` that way, so a job with
    -- no accepted quote reported `null` instead of `no_accepted_quote`,
    -- and the payment boundary then mis-attributed the refusal to the
    -- missing settlement model. Found by batch13-1 B12 and J4.
    --
    -- So: the state is decided OUTSIDE the subquery, with `exists`, and
    -- the fallbacks coalesce the whole subquery rather than a column.
    'currency', coalesce(
      (select nullif(btrim(coalesce(q.currency, '')), '') from q),
      public.ns_default_currency()),
    'currency_state', case
      when (select nullif(btrim(coalesce(q.currency, '')), '') from q) is not null
        then 'from_accepted_quote'
      when public.ns_default_currency() is not null then 'from_settings'
      else 'unconfigured' end,
    'commercial_state', case
      when exists (select 1 from q) then 'accepted_quote'
      else 'no_accepted_quote' end
  );
$$;

comment on function public.ns_job_approved_commercials(uuid) is
  'The authoritative approved money for a job: the accepted quote total '
  'plus approved, priced change orders. Never derived from consumption, a '
  'price book or a report. commercial_state is no_accepted_quote when '
  'there is nothing authoritative to show.';

/** THE ALLOWLIST. The whole customer-facing projection, field by field.
 *
 *  Everything a customer sees comes from here. What is deliberately absent,
 *  and why, in the order somebody will ask:
 *
 *   * ns_property_access.access_code / .internal_note  -- a key and an
 *     office note. 12.1 does not even grant them at column level.
 *   * properties.access_note, ns_property_access.hazard_note / .parking_note
 *     -- crew working detail. The customer's own house does not need
 *     telling, and a hazard note is often about the customer.
 *   * ns_job_completions.note, ns_job_completion_corrections.reason,
 *     ns_evidence_exceptions.reason -- internal narrative. An exception in
 *     particular records that we accepted a completion WITHOUT something,
 *     which is ours to know.
 *   * ns_job_evidence.captured_lat / _lon / _accuracy_m -- the original GPS
 *     metadata. The report says whether location was reported at all; it
 *     does not hand over coordinates.
 *   * ns_materials cost columns, ns_stock_operations, reservations -- what
 *     a thing cost us is never on a customer's document.
 *   * job_attachments.caption -- the internal caption. Only
 *     ns_evidence_publications.customer_caption reaches the customer.
 *   * every other customer's anything. The projection is built from ONE
 *     job and reaches a customer identifier exactly once, by name.
 *   * ns_seasonal_set_assignments and the rental history behind it. A
 *     company-owned Christmas set stays a rental: the document says the
 *     set is ours and installed, never that installing it transferred it,
 *     and it never names a set's previous property or season.
 */
create or replace function public.ns_customer_report_document(
  p_completion_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_c   public.ns_job_completions;
  v_job record;
  v_doc jsonb;
begin
  select * into v_c from public.ns_job_completions where id = p_completion_id;
  if not found then
    raise exception 'No such completion %', p_completion_id
      using errcode = 'no_data_found';
  end if;

  select j.id            as job_id,
         j.customer_id   as customer_id,
         cu.name         as customer_name,
         -- The address the customer already knows, because it is theirs.
         -- Never the access note that sits beside it.
         p.address_line1 as address_line1,
         p.city          as city
    into v_job
    from public.ns_jobs j
    left join public.customers cu on cu.id = j.customer_id
    left join public.properties p on p.id = j.property_id
   where j.id = v_c.job_id;

  v_doc := jsonb_build_object(
    'document_kind', 'completion_report',
    'document_version', 1,

    'company',  public.ns_business_identity(),

    'customer', jsonb_build_object(
      'customer_id', v_job.customer_id,
      'name',        v_job.customer_name),

    'property', jsonb_build_object(
      'address_line1', v_job.address_line1,
      'city',          v_job.city),

    'job', jsonb_build_object('job_id', v_c.job_id),

    /* ---------------------------------------------- the two timestamps */
    -- Kept apart on the customer's document exactly as 11.1 keeps them
    -- apart in the record: what the crew reported, and when the server
    -- accepted it. A device claim is not a server fact and the document
    -- says which is which.
    'completion', jsonb_build_object(
      'completion_id',       v_c.id,
      'accepted_at',         v_c.accepted_at,
      'work_finished_at',    v_c.work_finished_at,
      'work_finished_state', v_c.work_finished_state,
      'reported_work_time_state',
        case when v_c.work_finished_state = 'reported'
             then 'reported_by_crew' else 'unknown' end),

    /* ------------------------------------------------- what was done */
    -- Customer-readable descriptions only: the accepted quote's own line
    -- descriptions (already customer-facing and frozen at send) and the
    -- service names. No internal scope notes, no modifier factors, no
    -- unit rates -- the same curation get_customer_quote has always done.
    -- DISTINCT in a subquery and the ordering outside it, because
    -- `jsonb_agg(distinct ...)` with no ORDER BY would hand two runs of the
    -- fixture generator two different orders.
    'work', coalesce((
      select jsonb_agg(jsonb_build_object(
               'description', w.description, 'service', w.service)
             order by w.description, w.service)
        from (
          select distinct coalesce(li.description, s.name) as description,
                          s.name as service
            from public.ns_quotes q
            join public.quote_line_items li on li.quote_id = q.id
            left join public.services s on s.id = li.service_id
           where q.job_id = v_c.job_id and q.status = 'accepted'
        ) w),
      '[]'::jsonb),

    /* ----------------------------------------------- published evidence */
    -- ONLY what an owner explicitly published, and only what was frozen
    -- into THIS completion. The attachment path is not here: a path is a
    -- credential-shaped guess and Migration 2 hands out tickets instead.
    'evidence', coalesce((
      select jsonb_agg(jsonb_build_object(
               'evidence_id',     e.id,
               'requirement',     e.requirement,
               'caption',         pub.customer_caption,
               -- WHAT WE KNOW ABOUT THE PICTURE, honestly. A device said
               -- when and where; the server says when it arrived. No
               -- coordinates, and no implication that a device claim was
               -- verified.
               'capture_time_state', e.capture_time_state,
               'captured_at',     case when e.capture_time_state = 'device_reported'
                                       then e.captured_at else null end,
               'location_state',  case when e.gps_state = 'device_reported'
                                       then 'device_reported' else e.gps_state end,
               'verification',    'device_reported_not_server_verified',
               'received_at',     e.received_at)
             order by e.received_at, e.id)
        from public.ns_job_evidence e
        join public.ns_evidence_publications pub on pub.evidence_id = e.id
       where e.frozen_by_completion = v_c.id
         and pub.decision = 'published'),
      '[]'::jsonb),

    'evidence_withheld_count', (
      select count(*) from public.ns_job_evidence e
        left join public.ns_evidence_publications pub on pub.evidence_id = e.id
       where e.frozen_by_completion = v_c.id
         and coalesce(pub.decision, 'withheld') <> 'published'),

    /* ------------------------------------------------ materials reported */
    -- UNITS AND STATES AS RECORDED. A level stays a level: there is no
    -- quantity to invent for a part-used jug, and "part" is more honest
    -- than a made-up litre count. `count_precision` travels with the
    -- number so an estimate never reads as a count. THIS IS NOT AN
    -- INVOICE LINE: no rate, no extension, no total.
    'materials', coalesce((
      select jsonb_agg(jsonb_build_object(
               'material',  m.name,
               'quantity',  c.quantity,
               'level',     c.level,
               'unit',      c.unit,
               'measurement_state',
                 case when c.level is not null then 'level_observed'
                      when c.count_precision = 'estimated' then 'estimated'
                      else 'exact' end)
             order by m.name, c.recorded_at)
        from public.ns_job_consumptions c
        join public.ns_materials m on m.id = c.material_id
       where c.completion_id = v_c.id and c.corrects is null),
      '[]'::jsonb),

    'materials_note',
      'Reported for your records. Materials are not charged from these '
      'figures.',

    /* --------------------------------------------- the commercial record */
    -- Straight from ns_job_approved_commercials. Pricing stays in the
    -- backend, additional work appears only once an owner approved and
    -- priced it, and a job with no accepted quote shows no total at all.
    'commercials', public.ns_job_approved_commercials(v_c.job_id)
  );

  return v_doc;
end
$$;

comment on function public.ns_customer_report_document(uuid) is
  'The customer-facing projection of one accepted completion, built from an '
  'explicit field allowlist. No internal row is serialised whole, so a '
  'column added elsewhere cannot appear on a customer document by accident.';

/** The logical identity of "the report for this completion, as the facts
 *  now stand". Two generations that would say the same thing share it; a
 *  generation after a correction, a new publication decision or a new
 *  approved change order does not. */
create or replace function public.ns_report_source_version(p_completion_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.ns_load_intent_fingerprint(jsonb_build_object(
    'completion_id', p_completion_id,
    'corrections', (
      select count(*) from public.ns_job_completion_corrections k
       where k.completion_id = p_completion_id),
    -- A reopen is a correction row, so the open/closed state is part of
    -- the identity too: reopening and re-completing produces a different
    -- completion AND a different source version.
    'completion_open', (
      select public.ns_job_completion_is_open(c.job_id)
        from public.ns_job_completions c where c.id = p_completion_id),
    'published_evidence', coalesce((
      select string_agg(pub.evidence_id::text || ':' ||
                        coalesce(pub.customer_caption, ''), ',' order by pub.evidence_id)
        from public.ns_evidence_publications pub
        join public.ns_job_evidence e on e.id = pub.evidence_id
       where e.frozen_by_completion = p_completion_id
         and pub.decision = 'published'), ''),
    'consumptions', coalesce((
      select string_agg(c.id::text, ',' order by c.id)
        from public.ns_job_consumptions c
       where c.completion_id = p_completion_id), ''),
    'commercials', (
      select public.ns_job_approved_commercials(c.job_id)
        from public.ns_job_completions c where c.id = p_completion_id)
  ));
$$;

/* ===================================================================== */
/* 5. generating and publishing                                           */
/* ===================================================================== */

/** The receipt shape every report operation returns. One shape, so a caller
 *  never has to branch on which call produced it. */
create or replace function public.ns_report_receipt(
  p_report_id uuid, p_replayed boolean default false)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'replayed',          p_replayed,
    'report_id',         r.id,
    'job_id',            r.job_id,
    'completion_id',     r.completion_id,
    'report_version',    r.report_version,
    'source_version',    r.source_version,
    'supersedes',        r.supersedes,
    'publication_state', r.publication_state,
    'review_hold',       r.review_hold,
    'generated_at',      r.generated_at,
    'published_at',      r.published_at,
    'superseded_at',     r.superseded_at,
    -- Generation NEVER sends. Said out loud on every receipt because the
    -- alternative is a screen that implies it did.
    'delivered',         false)
  from public.ns_completion_reports r where r.id = p_report_id;
$$;

/** Generate the customer's report for an accepted completion.
 *
 *  OWNER-ONLY. A crew that could generate and publish its own report would
 *  be able to put a document in front of a customer with no review, which
 *  is the whole reason 11.1 made the owner price and approve extra work.
 *
 *  Five refusals, in this order: privilege, key, completion exists,
 *  completion not reopened, and -- the one people forget -- a job whose
 *  completion was reopened has no current accepted work to report.
 *
 *  THE REVIEW HOLD IS VISIBLE. A report generated while some frozen
 *  evidence has no publication decision is still a report, but it carries
 *  `review_hold` saying so, and `publish_completion_report` is a separate
 *  deliberate act. Nothing here pretends it went out. */
create or replace function public.generate_completion_report(
  p_client_operation_id text,
  p_completion_id       uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_print  text;
  v_replay jsonb;
  v_c      public.ns_job_completions;
  v_source text;
  v_exist  public.ns_completion_reports;
  v_prev   public.ns_completion_reports;
  v_doc    jsonb;
  v_hold   text;
  v_undecided integer;
  v_id     uuid;
  v_receipt jsonb;
begin
  if not public.is_owner() then
    raise exception
      'Only the owner generates a customer report. A crew publishing its '
      'own account of the work is what this prevents.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_c from public.ns_job_completions where id = p_completion_id;
  if not found then
    raise exception 'No such accepted completion %', p_completion_id
      using errcode = 'no_data_found';
  end if;

  /* TWO DIFFERENT "NOT CURRENT"s, and only one of them is what
     ns_job_completion_is_open answers.

     It is a JOB-level question -- "does this job have an accepted
     completion that has not been reopened" -- so it is true again the
     moment a reopened job is completed a second time. That catches the
     first case (reopened, not yet re-completed) and misses the second
     (this row was superseded by a later completion), which is exactly the
     case somebody hits by generating from a stale screen.

     11.1's own helper for the first, and the row's own
     supersedes_corrections for the second. Not a re-derived completion
     rule: the reopen count is read the same way 11.1's unique index
     keys it. */
  if not public.ns_job_completion_is_open(v_c.job_id) then
    raise exception
      'That completion was reopened, so there is no accepted work to '
      'report yet. Complete the job again, then report the new completion.'
      using errcode = 'check_violation';
  end if;

  if v_c.supersedes_corrections <> (
       select count(*)
         from public.ns_job_completion_corrections k
         join public.ns_job_completions c2 on c2.id = k.completion_id
        where c2.job_id = v_c.job_id and k.kind = 'reopen') then
    raise exception
      'That completion is not this job''s current one -- the job was '
      'reopened and completed again since. Report the current completion.'
      using errcode = 'check_violation';
  end if;

  v_print := public.ns_load_intent_fingerprint(
    jsonb_build_object('completion_id', p_completion_id));
  v_replay := public.ns_handover_replay_guard(
    p_client_operation_id, 'report_generation', p_completion_id, v_print);
  if v_replay is not null then return v_replay; end if;

  v_source := public.ns_report_source_version(p_completion_id);

  /* THE LOGICAL DEDUPLICATION, before anything is written. A second tab,
     or a retry under a fresh key, asking for "the report as it stands"
     gets the report that already says exactly that -- one report event,
     not two, and the receipt says it was a replay. */
  select * into v_exist from public.ns_completion_reports
   where completion_id = p_completion_id and source_version = v_source;
  if found then
    return public.ns_report_receipt(v_exist.id, true);
  end if;

  v_doc := public.ns_customer_report_document(p_completion_id);

  -- Evidence frozen into this completion with no publication decision at
  -- all. Not an error: a report of the work is useful without photographs.
  -- But the owner is told, because the alternative is a customer document
  -- silently missing the pictures somebody meant to send.
  select count(*) into v_undecided
    from public.ns_job_evidence e
    left join public.ns_evidence_publications pub on pub.evidence_id = e.id
   where e.frozen_by_completion = p_completion_id and pub.evidence_id is null;

  if v_undecided > 0 then
    v_hold := v_undecided || ' evidence record(s) have no publication '
              'decision, so they are not on this report. Decide them and '
              'generate again if the customer should see them.';
  end if;

  if (v_doc -> 'commercials' ->> 'commercial_state') = 'no_accepted_quote' then
    v_hold := coalesce(v_hold || ' ', '')
      || 'This job has no accepted quote, so the report carries no total.';
  end if;

  /* THE SUPERSEDING REPORT. A previous report for the same job is not
     rewritten and not deleted -- it is marked superseded and the new one
     names it. That is what "a later correction needs a clearly identified
     superseding report referencing its accepted source" means in rows. */
  select * into v_prev from public.ns_completion_reports
   where job_id = v_c.job_id
     and publication_state <> 'superseded'
   order by report_version desc limit 1;

  insert into public.ns_completion_reports
    (job_id, completion_id, report_version, source_version, supersedes,
     publication_state, review_hold, document, generated_by,
     client_operation_id)
  values
    (v_c.job_id, p_completion_id,
     coalesce((select max(report_version) + 1 from public.ns_completion_reports
                where job_id = v_c.job_id), 1),
     v_source, v_prev.id, 'draft', v_hold, v_doc, auth.uid(),
     p_client_operation_id)
  returning id into v_id;

  if v_prev.id is not null then
    update public.ns_completion_reports
       set publication_state = 'superseded', superseded_at = now()
     where id = v_prev.id;
  end if;

  v_receipt := public.ns_report_receipt(v_id, false);

  insert into public.ns_handover_operations
    (client_operation_id, kind, scope_id, intent_fingerprint, actor_id, receipt)
  values
    (p_client_operation_id, 'report_generation', p_completion_id, v_print,
     auth.uid(), v_receipt);

  return v_receipt;
end
$$;

/** Decide whether one piece of registered evidence may be shown to the
 *  customer. Owner-only, reasoned when withheld, replay-safe.
 *
 *  Deciding does NOT change a report that was already generated: the
 *  document is frozen, so the decision shows up in the next generation,
 *  which is a new source_version and therefore a new, superseding report.
 *  That is the point -- a published document cannot grow a photograph
 *  after the customer read it. */
create or replace function public.set_evidence_publication(
  p_client_operation_id text,
  p_evidence_id         uuid,
  p_decision            text,
  p_reason              text default null,
  p_customer_caption    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_print  text;
  v_replay jsonb;
  v_e      public.ns_job_evidence;
  v_receipt jsonb;
begin
  if not public.is_owner() then
    raise exception
      'Only the owner decides what a customer may see. Evidence proves the '
      'work to us; publishing it is a separate decision.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_decision not in ('published', 'withheld') then
    raise exception 'A publication decision is published or withheld, not %',
      p_decision using errcode = 'invalid_parameter_value';
  end if;
  if p_decision = 'withheld' and coalesce(btrim(p_reason), '') = '' then
    raise exception
      'Say why it is withheld. A recorded reason is how a later reviewer '
      'knows the decision was made rather than forgotten.'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_e from public.ns_job_evidence where id = p_evidence_id;
  if not found then
    raise exception 'No such evidence record %', p_evidence_id
      using errcode = 'no_data_found';
  end if;

  v_print := public.ns_load_intent_fingerprint(jsonb_build_object(
    'evidence_id', p_evidence_id, 'decision', p_decision,
    'customer_caption', coalesce(p_customer_caption, '')));
  v_replay := public.ns_handover_replay_guard(
    p_client_operation_id, 'evidence_publication', p_evidence_id, v_print);
  if v_replay is not null then return v_replay; end if;

  insert into public.ns_evidence_publications
    (evidence_id, job_id, decision, reason, customer_caption, decided_by,
     client_operation_id)
  values
    (p_evidence_id, v_e.job_id, p_decision, nullif(btrim(coalesce(p_reason, '')), ''),
     nullif(btrim(coalesce(p_customer_caption, '')), ''), auth.uid(),
     p_client_operation_id)
  on conflict (evidence_id) do update
     set decision = excluded.decision,
         reason = excluded.reason,
         customer_caption = excluded.customer_caption,
         decided_by = excluded.decided_by,
         decided_at = now(),
         client_operation_id = excluded.client_operation_id;

  v_receipt := jsonb_build_object(
    'evidence_id', p_evidence_id,
    'job_id',      v_e.job_id,
    'decision',    p_decision,
    'replayed',    false,
    -- Said explicitly: deciding now does not alter a document already
    -- issued. The next generation carries it.
    'affects_issued_reports', false);

  insert into public.ns_handover_operations
    (client_operation_id, kind, scope_id, intent_fingerprint, actor_id, receipt)
  values
    (p_client_operation_id, 'evidence_publication', p_evidence_id, v_print,
     auth.uid(), v_receipt);

  return v_receipt;
end
$$;

/** Publish a generated report: the owner's decision that a customer may
 *  read it. Does not issue a link and does not send anything -- Migration 2
 *  issues the grant, Migration 3 queues the message. Three separate acts,
 *  because each one is a different mistake if it happens on its own. */
create or replace function public.publish_completion_report(
  p_client_operation_id text,
  p_report_id           uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_print  text;
  v_replay jsonb;
  v_r      public.ns_completion_reports;
  v_receipt jsonb;
begin
  if not public.is_owner() then
    raise exception 'Only the owner publishes a customer report'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_r from public.ns_completion_reports
   where id = p_report_id for update;
  if not found then
    raise exception 'No such report %', p_report_id
      using errcode = 'no_data_found';
  end if;

  v_print := public.ns_load_intent_fingerprint(
    jsonb_build_object('report_id', p_report_id));
  v_replay := public.ns_handover_replay_guard(
    p_client_operation_id, 'report_publication', p_report_id, v_print);
  if v_replay is not null then return v_replay; end if;

  if v_r.publication_state = 'superseded' then
    raise exception
      'Report v% was superseded by a later one. Publish the current report '
      'instead of re-issuing a document we have already corrected.',
      v_r.report_version using errcode = 'check_violation';
  end if;

  if v_r.publication_state = 'published' then
    -- Idempotent on state: publishing twice is a retry, not a second
    -- document, and it is NOT a second message either.
    v_receipt := public.ns_report_receipt(v_r.id, true)
                 || jsonb_build_object('no_op', true);
  else
    update public.ns_completion_reports
       set publication_state = 'published',
           published_at = now(),
           published_by = auth.uid(),
           review_hold = null
     where id = p_report_id;
    v_receipt := public.ns_report_receipt(v_r.id, false)
                 || jsonb_build_object('no_op', false);
  end if;

  insert into public.ns_handover_operations
    (client_operation_id, kind, scope_id, intent_fingerprint, actor_id, receipt)
  values
    (p_client_operation_id, 'report_publication', p_report_id, v_print,
     auth.uid(), v_receipt);

  return v_receipt;
end
$$;

/* ===================================================================== */
/* 6. the owner's read                                                    */
/* ===================================================================== */

/** Every report for a job, newest first, with its state and its source.
 *  Admin-scoped by the same rule 12.1 uses for a job. The DOCUMENT is
 *  included because this is the owner's preview -- the customer's read is
 *  a different function, in Migration 2, with a capability instead of a
 *  session. */
create or replace function public.job_completion_reports(p_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'job_completion_reports is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  if not public.ns_can_work_job(p_job_id) then
    raise exception 'That job is not on your vehicle'
      using errcode = 'insufficient_privilege';
  end if;

  return jsonb_build_object(
    'job_id', p_job_id,
    'reports', coalesce((
      select jsonb_agg(jsonb_build_object(
               'report_id',         r.id,
               'report_version',    r.report_version,
               'completion_id',     r.completion_id,
               'source_version',    r.source_version,
               'supersedes',        r.supersedes,
               'publication_state', r.publication_state,
               'review_hold',       r.review_hold,
               'generated_at',      r.generated_at,
               'published_at',      r.published_at,
               'superseded_at',     r.superseded_at,
               'document',          r.document)
             order by r.report_version desc)
        from public.ns_completion_reports r where r.job_id = p_job_id),
      '[]'::jsonb),
    -- What is still undecided, so the preview can show it rather than the
    -- owner discovering it from a customer.
    'undecided_evidence', coalesce((
      select jsonb_agg(jsonb_build_object(
               'evidence_id', e.id,
               'requirement', e.requirement,
               'attachment_id', e.attachment_id,
               'received_at', e.received_at)
             order by e.received_at, e.id)
        from public.ns_job_evidence e
        left join public.ns_evidence_publications pub on pub.evidence_id = e.id
       where e.job_id = p_job_id and e.frozen_by_completion is not null
         and pub.evidence_id is null),
      '[]'::jsonb));
end
$$;

/* ===================================================================== */
/* 7. grants                                                              */
/* ===================================================================== */

do $$
declare t text;
begin
  -- The tables are read through security-definer functions only. No anon
  -- anything: the customer's route is Migration 2's capability, not a
  -- table read.
  foreach t in array array[
    'public.ns_handover_operations', 'public.ns_evidence_publications',
    'public.ns_completion_reports']
  loop
    execute format('revoke all on %s from anon', t);
    execute format('revoke all on %s from authenticated', t);
    execute format('grant select on %s to authenticated', t);
    execute format('grant all on %s to service_role', t);
  end loop;
end
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.ns_handover_replay_guard(text,text,uuid,text)',
    'public.ns_default_currency()',
    'public.ns_business_identity()',
    'public.ns_job_approved_commercials(uuid)',
    'public.ns_customer_report_document(uuid)',
    'public.ns_report_source_version(uuid)',
    'public.ns_report_receipt(uuid,boolean)',
    'public.generate_completion_report(text,uuid)',
    'public.set_evidence_publication(text,uuid,text,text,text)',
    'public.publish_completion_report(text,uuid)',
    'public.job_completion_reports(uuid)']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('grant execute on function %s to authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

/* ===================================================================== */
/* 8. assertions                                                          */
/* ===================================================================== */

do $$
begin
  -- 11.1's completion gate must still be the only road to 'completed'. A
  -- customer report built on a completion the gate no longer protects
  -- would be a document about an unverified claim.
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.ns_jobs'::regclass
       and tgname = 'ns_jobs_completion_gate'
       and not tgisinternal) then
    raise exception
      'ns_jobs_completion_gate is missing: Batch 11.1''s completion gate is '
      'what makes an accepted completion worth reporting.';
  end if;

  -- No anon execute anywhere in this file. The customer's path is a
  -- capability (Migration 2), and an anon-callable report generator would
  -- be a document factory for anybody.
  if has_function_privilege('anon',
       'public.generate_completion_report(text,uuid)', 'execute') then
    raise exception 'anon can execute generate_completion_report';
  end if;
  if has_function_privilege('anon',
       'public.ns_customer_report_document(uuid)', 'execute') then
    raise exception 'anon can execute ns_customer_report_document';
  end if;

  -- The document allowlist must not be reachable as a table read either.
  if has_table_privilege('anon', 'public.ns_completion_reports', 'select') then
    raise exception 'anon can select ns_completion_reports';
  end if;
end
$$;
