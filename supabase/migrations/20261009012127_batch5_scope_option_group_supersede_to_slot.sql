-- Batch 5 follow-up: re-sending an option group must not delete the options
-- the admin did not touch.
--
-- The previous migration unlocked re-sending a group (a revised option used to
-- be permanently unsendable). Verifying it against the real database exposed a
-- defect in that fix:
--
--   group: Essential (slot 1, sent), Complete (slot 2, sent)
--   duplicate_quote(Essential) -> draft in slot 1
--   send_option_group(group)
--     -> superseded/Essential v4, sent/Essential v6, superseded/Complete v5
--                                                    ^^^^^^^^^^^^^^^^^^^^^^
--
-- Revising the price of Essential silently withdrew Complete. The customer had
-- been offered two choices and, after an edit to one of them, could only accept
-- one -- without anybody intending that. "Supersede every sent sibling" was too
-- broad: it treated the whole group as one unit of delivery when the group is a
-- SET of mutually exclusive choices, each with its own slot.
--
-- A draft supersedes the sent quote it replaces, and nothing else. "Replaces"
-- is decided by two deterministic links, either of which is sufficient:
--
--   * option_sort_order -- the option's slot in the group. duplicate_quote
--     copies it forward, so a revision always lands back in its own slot.
--   * parent_quote_id -- the explicit revision link duplicate_quote writes
--     (and create_option_quote accepts). Honoured as well as the slot, so an
--     option whose sort order was changed between rounds still supersedes the
--     quote it was actually derived from.
--
-- Consequences, all intended:
--   * a brand-new option added to a sent group (a slot nothing occupies yet)
--     supersedes nothing -- the customer gains a choice, loses none;
--   * revising every option supersedes every prior one, as before;
--   * a declined option is never superseded (only 'sent' rows are), so its
--     history survives a later round in the same slot.
--
-- Only send_option_group changes. Everything else from the previous migration
-- stands.

create or replace function public.send_option_group(p_option_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job       uuid;
  v_customer  text;
  v_email     text;
  v_reference text;
  v_property  text;
  v_anchor    uuid;
  v_total     numeric;
  v_currency  text;
  v_valid     date;
  v_count     integer;
  v_drafts    integer;
begin
  if not public.is_admin() then
    raise exception 'Not authorised.' using errcode = 'insufficient_privilege';
  end if;

  select count(*) into v_count from public.ns_quotes where option_group_id = p_option_group_id;
  if v_count = 0 then
    raise exception 'Option group not found.' using errcode = 'no_data_found';
  end if;

  select job_id into v_job from public.ns_quotes
  where option_group_id = p_option_group_id limit 1;

  -- An accepted option settles the group. Revising it would change terms the
  -- customer has already agreed to, so further work starts a new group.
  if exists (
    select 1 from public.ns_quotes
    where option_group_id = p_option_group_id and status = 'accepted'
  ) then
    raise exception 'An option in this group has already been accepted. Create a new option group for further work.'
      using errcode = 'check_violation';
  end if;

  -- The original guard asked "has anything here ever been sent?", which made a
  -- revised option permanently unsendable. The question that matters is
  -- whether there is anything new to send.
  select count(*) into v_drafts
  from public.ns_quotes
  where option_group_id = p_option_group_id and status = 'draft';

  if v_drafts = 0 then
    raise exception 'This option group has already been sent.' using errcode = 'check_violation';
  end if;

  select c.name, c.email, j.reference,
         trim(both ', ' from concat_ws(', ', p.address_line1, p.city, p.postal_code))
    into v_customer, v_email, v_reference, v_property
  from public.ns_jobs j
  join public.customers c  on c.id = j.customer_id
  join public.properties p on p.id = j.property_id
  where j.id = v_job;

  if v_email is null or btrim(v_email) = '' then
    raise exception 'This customer has no email address on file. Add one before sending the quote.'
      using errcode = 'check_violation';
  end if;

  -- Supersede any prior sent quote for this job OUTSIDE this option group: a
  -- standalone quote and a set of options are alternative offers for the same
  -- job, so issuing the options withdraws the standalone one.
  update public.ns_quotes set status = 'superseded'
   where job_id = v_job and status = 'sent'
     and option_group_id is distinct from p_option_group_id;

  -- Inside the group, supersede ONLY the sent quotes that the drafts replace --
  -- same slot, or named by the draft's revision link. Options in slots nobody
  -- revised stay live and remain acceptable. Must run before the drafts flip
  -- to 'sent', or every draft would match itself.
  update public.ns_quotes s set status = 'superseded'
   where s.option_group_id = p_option_group_id
     and s.status = 'sent'
     and exists (
       select 1 from public.ns_quotes d
       where d.option_group_id = p_option_group_id
         and d.status = 'draft'
         and (d.option_sort_order = s.option_sort_order or d.parent_quote_id = s.id)
     );

  update public.ns_quotes set status = 'sent', sent_at = now()
   where option_group_id = p_option_group_id and status = 'draft';

  update public.ns_jobs set status = 'quote_sent' where id = v_job;

  -- Anchor the notification on an option that is actually live now, not on a
  -- superseded one from a previous round.
  select id, total, currency, valid_until into v_anchor, v_total, v_currency, v_valid
  from public.ns_quotes
  where option_group_id = p_option_group_id and status = 'sent'
  order by option_sort_order asc, version asc limit 1;

  insert into public.notifications (kind, channel, recipient, subject, payload, job_id)
  values (
    'quote_ready', 'email', lower(btrim(v_email)),
    'Your quote from Nova Shield' || case when v_reference is not null then ' - ' || v_reference else '' end,
    jsonb_build_object(
      'quote_id',    v_anchor,
      'customer',    v_customer,
      'reference',   v_reference,
      'property',    v_property,
      'total',       v_total,
      'currency',    coalesce(v_currency, 'CAD'),
      'valid_until', v_valid,
      'option_group', true
    ),
    v_job
  );
end
$$;
