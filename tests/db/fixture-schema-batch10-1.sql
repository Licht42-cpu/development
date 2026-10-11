-- Additional fixture objects the Batch 10.1 migrations reference by name,
-- loaded AFTER fixture-schema-batch8-1.sql and fixture-schema-batch9-1.sql.
--
-- One column: ns_jobs.scheduled_for. It exists on the live project -- the
-- admin console reads and writes it in several places (api.js search_jobs,
-- the day and week queries, the job screen's schedule control) -- but the
-- Batch 8.1 fixture was written before anything needed it, and the
-- repository has no base schema to take it from.
--
-- A load plan is "the work for this car on this date", so this column is
-- the one input the whole batch turns on. Without it there is no day.
--
-- Same honesty note as the other fixtures: this proves things about
-- PostgreSQL, not about the live project.

alter table public.ns_jobs
  add column if not exists scheduled_for timestamptz;

create index if not exists ns_jobs_scheduled_idx
  on public.ns_jobs (scheduled_for)
  where scheduled_for is not null;
