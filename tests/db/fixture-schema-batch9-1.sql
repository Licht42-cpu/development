-- Additional fixture objects the Batch 9.1 migrations reference by name,
-- loaded AFTER fixture-schema-batch8-1.sql.
--
-- Only one: app_settings, which ns_seasonal_release_cutoff() reads. It
-- exists in the live project (Batch 5 reads 'quote_defaults', 'tax' and
-- 'company' from it) but the repository has no base schema, so the
-- disposable database has to be told about it.
--
-- Same honesty note as the other fixture: this proves things about
-- PostgreSQL, not about the live project. No Batch 9.1 migration has been
-- applied anywhere.

drop table if exists public.app_settings cascade;
create table public.app_settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- The lighting row with the ownership model Batch 8.1's comment cites, and
-- NO cutoff: the owner has not set one, which is the state the code has to
-- handle without inventing a date.
insert into public.app_settings (key, value) values
  ('lighting', jsonb_build_object('christmas_ownership_model', 'rental'))
on conflict (key) do nothing;

grant select, insert, update, delete on public.app_settings
  to authenticated, service_role;
