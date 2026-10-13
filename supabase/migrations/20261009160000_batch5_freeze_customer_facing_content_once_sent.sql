-- Freeze a quote's customer-facing prose once it has been sent.
--
-- Authored in Batch 5, never applied, and CORRECTED in Batch 7.1 before any
-- application. It is still one migration, not two -- the Batch 5 version was
-- never recorded in supabase_migrations.schema_migrations, so editing it in
-- place is safe and avoids a duplicate that would do half the job.
--
-- Why it exists
-- -------------
-- Batch 6.1 gave the admin an editor for ns_quotes.customer_notes and
-- ns_quotes.terms -- the two fields get_customer_quote returns and
-- site/quote.html renders as its notes and terms blocks. Verified against the
-- live database as an admin before that editor existed:
--
--   draft customer_notes/terms update : allowed   (correct)
--   SENT  customer_notes/terms update : ALLOWED   <-- the hole
--   SENT  internal_notes update       : allowed   (intended, staff scratch)
--
-- So the editor could rewrite what a customer had already received, on a
-- quote whose money and line labels Batch 5 went to some trouble to freeze.
-- The admin UI only offers the editor on a draft, but a UI gate is not the
-- guarantee -- this is.
--
-- What Batch 7.1 corrected
-- ------------------------
-- The original guard keyed solely on OLD.status, which blocks the obvious
-- one-statement attempt:
--
--   update ns_quotes set status='draft', customer_notes='...' where id=X;
--       -> OLD.status is 'sent', so it raises. Good.
--
-- but NOT the two-statement version, because each step passes on its own:
--
--   update ns_quotes set status='draft'        where id=X;  -- content
--                                                           -- unchanged, ok
--   update ns_quotes set customer_notes='...'  where id=X;  -- OLD.status is
--                                                           -- now 'draft', ok
--
-- An admin could therefore demote a sent quote and edit it freely. The guard
-- now also refuses to move a row BACK to draft once it has left, which closes
-- that path without constraining any legitimate transition.
--
-- Checked before adding that rule: no code path sets an existing ns_quotes row
-- back to 'draft'. duplicate_quote INSERTs a new draft row rather than
-- updating one; mark_quote_sent, send_option_group, respond_to_quote,
-- save_quote_signature and expiry all move status forward. Every
-- `status = 'draft'` in the migration history is a WHERE filter, never a SET.
--
-- Scope, deliberately narrow
-- --------------------------
--   * only customer_notes and terms are frozen. internal_notes stays editable
--     at any status: it is private staff scratch the customer never sees, and
--     annotating a sent quote is the point of it.
--   * the content rule keys on OLD.status, the state before the update, so
--     mark_quote_sent and send_option_group (draft -> sent, touching neither
--     column) pass, and sending a draft WITH freshly edited content in one
--     statement is still allowed -- that is the content the customer receives.

create or replace function public.guard_quote_customer_content_frozen()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- 1. Customer-facing prose is frozen once the quote has left draft.
  if old.status <> 'draft'
     and (new.customer_notes is distinct from old.customer_notes
          or new.terms is distinct from old.terms) then
    raise exception
      'Quote % is % - the customer-facing note and terms are frozen once sent. Create a new version instead.',
      old.id, old.status
      using errcode = 'check_violation';
  end if;

  -- 2. A quote cannot be returned to draft. Without this, rule 1 is a
  --    speed bump: demote, edit, re-send. Nothing legitimate moves a row
  --    back to draft -- a revision is a NEW row from duplicate_quote.
  if old.status <> 'draft' and new.status = 'draft' then
    raise exception
      'Quote % is % and cannot be returned to draft. Create a new version instead.',
      old.id, old.status
      using errcode = 'check_violation';
  end if;

  return new;
end
$$;

drop trigger if exists ns_quotes_customer_content_draft_only on public.ns_quotes;

create trigger ns_quotes_customer_content_draft_only
before update on public.ns_quotes
for each row execute function public.guard_quote_customer_content_frozen();
