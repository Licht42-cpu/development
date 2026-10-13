-- Additional fixture objects the Batch 13.1 migrations reference by name,
-- loaded AFTER the 8.1, 9.1, 10.1, 11.1 and 12.1 fixtures.
--
-- All of these exist in the live project and none of them exists in this
-- repository, which has no base schema (docs/batch7-1-findings.md, 4b).
--
--   quote_line_items          what the customer-facing report calls the
--                             work. admin/js/lib/api.js selects
--                             `quote_line_items(service_id,description,...)`
--                             in three separate reads, and Batch 5's
--                             get_customer_quote renders its descriptions,
--                             so these are already customer-facing strings
--                             -- which is exactly why the report reuses
--                             them instead of writing new ones.
--   ns_quotes.version /
--   .currency / .sent_at      version and currency are read by Batch 5's
--                             option-group paths and by the settings view's
--                             comment on ns_quotes.currency;
--                             ns_job_approved_commercials reads the
--                             accepted quote's own frozen currency.
--   app_settings 'company' /
--   'quote_defaults'          the two rows the customer document's company
--                             block and default currency come from. Both
--                             are real, owner-edited rows in the admin
--                             Settings view.
--   customers.phone / .email  already added by the 12.1 fixture; the
--                             delivery migration resolves the recipient
--                             from the same columns.
--
-- THESE COLUMN LISTS ARE DERIVED, NOT PROBED. Live Supabase compatibility
-- is a separate, UNRUN check. NO MIGRATION IN THIS REPOSITORY HAS BEEN
-- APPLIED ANYWHERE.

/* ------------------------------------------------------- ns_quotes ---- */

alter table public.ns_quotes add column if not exists version integer not null default 1;
alter table public.ns_quotes add column if not exists currency text;
alter table public.ns_quotes add column if not exists sent_at timestamptz;

/* -------------------------------------------------- quote_line_items -- */

drop table if exists public.quote_line_items cascade;
create table public.quote_line_items (
  id          uuid primary key default gen_random_uuid(),
  quote_id    uuid not null references public.ns_quotes(id) on delete cascade,
  service_id  uuid references public.services(id) on delete set null,
  description text,
  amount      numeric not null default 0,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);

create index if not exists quote_line_items_quote_idx
  on public.quote_line_items (quote_id, sort_order);

grant select on public.quote_line_items to authenticated;
grant all on public.quote_line_items to service_role;

/* ------------------------------------------------------ app_settings -- */

-- The company block the quote page already renders, so the completion
-- report carries the same letterhead rather than a second copy of it.
insert into public.app_settings (key, value) values
  ('company', jsonb_build_object(
     'name',  'Nova Shield Maintenance Services',
     'phone', '437-436-3360',
     'email', 'hello@novashieldmaintenance.test'))
on conflict (key) do nothing;

-- quote_defaults deliberately carries NO currency: the unconfigured case is
-- the one the report has to state honestly, and a suite that wants the
-- configured case sets it itself.
insert into public.app_settings (key, value) values
  ('quote_defaults', '{}'::jsonb)
on conflict (key) do nothing;
