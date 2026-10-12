-- Fixture schema for Batch 11.1.
--
-- WHY THIS FILE EXISTS, AND WHAT IT IS NOT
-- ----------------------------------------
-- The repository has no base schema (docs/batch7-1-findings.md, finding
-- 4b): supabase/migrations/ starts mid-history, so three tables the 11.1
-- migrations touch exist only in the live project. This file reproduces
-- them from what the admin code demonstrably reads and writes:
--
--   job_attachments   admin/js/lib/api.js uploadJobPhoto / listAttachments /
--                     updateAttachment, admin/js/completion-report.js
--   ns_change_orders  api.js listChangeOrders / addChangeOrder /
--                     setChangeOrderStatus, and the activity feed in
--                     20261007114621_batch3_dashboard_jobs_search_activity.sql
--   ns_quotes.job_id  the same activity feed joins it
--
-- THESE COLUMN LISTS ARE DERIVED, NOT PROBED. A column that exists live and
-- is not here is simply not exercised by these tests, and anything the 11.1
-- migrations do to these tables is written as `add column if not exists`, a
-- trigger, or an introspecting DO block for exactly that reason. Live
-- Supabase compatibility is a separate, UNRUN check -- see
-- docs/completion-evidence-contract-v1.md §12.
--
-- Load order: after fixture-schema.sql (which drops and recreates
-- ns_quotes) and after fixture-schema-batch8-1.sql (which creates ns_jobs,
-- services and job_measurements).

-- The column the whole batch is about. api.js completeJob() writes it and
-- completion-report.js dates itself from it, so it exists live; the Batch
-- 8.1 fixture simply never needed it.
alter table public.ns_jobs
  add column if not exists completed_at timestamptz;

-- ns_quotes gains the job link the batch 3 activity feed already joins on,
-- and the created_at the "most recent quote for this job" lookup orders by.
alter table public.ns_quotes
  add column if not exists job_id uuid references public.ns_jobs(id) on delete cascade;
alter table public.ns_quotes
  add column if not exists created_at timestamptz not null default now();

/* ----------------------------------------------------- job_attachments -- */

-- Storage path, kind and caption are the columns uploadJobPhoto() writes;
-- request_id is what attachmentBucket() branches on. size_bytes is here
-- because register_job_evidence uses it as its "the upload actually landed"
-- proxy on a database that has no Storage to ask.
drop table if exists public.job_attachments cascade;
create table public.job_attachments (
  id            uuid primary key default gen_random_uuid(),
  job_id        uuid references public.ns_jobs(id) on delete cascade,
  request_id    uuid,
  storage_path  text not null,
  kind          text not null default 'site_photo',
  caption       text,
  elevation_tag text,
  issue_flag    boolean not null default false,
  mime_type     text,
  size_bytes    bigint,
  created_at    timestamptz not null default now(),
  created_by    uuid
);

create index if not exists job_attachments_job_idx
  on public.job_attachments (job_id, created_at);

/* ---------------------------------------------------- ns_change_orders -- */

-- `amount numeric not null` is the shape the 11.1 migration relaxes, so the
-- fixture starts from the stricter version on purpose: if the migration's
-- `drop not null` were removed, the unpriced-proposal test would fail here
-- rather than pass for the wrong reason.
drop table if exists public.ns_change_orders cascade;
create table public.ns_change_orders (
  id          uuid primary key default gen_random_uuid(),
  quote_id    uuid references public.ns_quotes(id) on delete cascade,
  description text not null,
  amount      numeric not null,
  status      text not null default 'pending',
  created_at  timestamptz not null default now(),
  created_by  uuid,
  approved_at timestamptz,
  constraint ns_change_orders_status_check
    check (status in ('pending', 'approved', 'declined'))
);

create index if not exists ns_change_orders_quote_idx
  on public.ns_change_orders (quote_id);

grant select, insert, update, delete
  on public.job_attachments, public.ns_change_orders
  to authenticated, service_role;

/* --------------------------------------------------- the real services -- */

-- THE KEYS MATTER, and they have to exist BEFORE the 11.1 migrations run.
-- The proposed evidence policies are seeded by a join against
-- services.key, so a service created after the migration gets no policy at
-- all and would read as `unconfigured` in a test that meant to exercise a
-- configured one. Read from admin/js/views/measurements.js's calculator
-- map, which is the live key list.
insert into public.services (key, name, unit, sort_order) values
  ('siding',               'Siding Soft Washing',        'sq_ft',     30),
  ('gutter_brightening',   'Gutter Brightening',         'linear_ft', 31),
  ('windows',              'Window Cleaning',            'each',      32),
  ('concrete',             'Concrete Cleaning',          'sq_ft',     33),
  ('roof_soft_wash',       'Roof Soft Washing',          'sq_ft',     34),
  ('deck',                 'Deck Cleaning',              'sq_ft',     35),
  ('fence',                'Fence Cleaning',             'linear_ft', 36),
  ('moss',                 'Moss Removal',               'sq_ft',     37),
  ('graffiti',             'Graffiti Removal',           'sq_ft',     38),
  ('winter_deicing_cables','Winter De-icing Cables',     'linear_ft', 39),
  ('winter_property_care', 'Winter Property Care',       'each',      40)
on conflict (key) do update set name = excluded.name;
