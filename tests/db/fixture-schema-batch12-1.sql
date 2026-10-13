-- Additional fixture objects the Batch 12.1 migrations reference by name,
-- loaded AFTER the 8.1, 9.1, 10.1 and 11.1 fixtures.
--
-- All of these exist in the live project and none of them exists in this
-- repository, which has no base schema (docs/batch7-1-findings.md, 4b). The
-- disposable database has to be told about them or the dispatch functions
-- have nothing to read.
--
--   customers.phone / .email   request_job_notification resolves the
--                              recipient from the JOB's customer, never
--                              from a caller-supplied address. api.js
--                              already selects both columns in half a
--                              dozen reads.
--   properties.address_line1 / .city / .access_note / .latitude /
--   .longitude                 get_property_access reports the existing
--                              entrance note and says explicitly whether
--                              coordinates are known. Codex's 10.2 field
--                              console reads the same columns through
--                              getJob.
--   notifications              the EXISTING outbound table Batch 2 and 5
--                              write to. 12.1 queues its two dispatch
--                              messages here rather than building a second
--                              pipeline.
--
-- Same honesty note as the other fixtures: this proves things about
-- PostgreSQL, not about the live project. NO MIGRATION IN THIS REPOSITORY
-- HAS BEEN APPLIED ANYWHERE.

/* ------------------------------------------------- customer contact -- */

alter table public.customers add column if not exists phone text;
alter table public.customers add column if not exists email text;

/* ------------------------------------------------ property details -- */

alter table public.properties add column if not exists address_line1 text;
alter table public.properties add column if not exists city text;
-- The entrance note that already exists and that 12.1 deliberately does
-- NOT duplicate into ns_property_access.
alter table public.properties add column if not exists access_note text;
alter table public.properties add column if not exists latitude numeric;
alter table public.properties add column if not exists longitude numeric;

/* --------------------------------------------------- notifications -- */

-- Columns taken from what the live migrations actually write and read:
-- Batch 5's send paths insert (kind, channel, recipient, subject, payload,
-- job_id); Batch 3's activity feed reads status, created_at and sent_at.
drop table if exists public.notifications cascade;
create table public.notifications (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null,
  channel    text not null,
  recipient  text,
  subject    text,
  payload    jsonb not null default '{}'::jsonb,
  job_id     uuid references public.ns_jobs(id) on delete set null,
  status     text not null default 'queued',
  created_at timestamptz not null default now(),
  sent_at    timestamptz
);

create index if not exists notifications_job_idx
  on public.notifications (job_id);

-- No grant to anon, matching the live intent: an outbound message log is
-- not public. The dispatch functions are security definer and write it as
-- the owner.
grant select on public.notifications to authenticated;
grant all on public.notifications to service_role;
