-- Batch 5 follow-up 2: re-sending an option group must not crash on the
-- duplicate-notification guard.
--
-- Found by running the multi-round option-group scenario against the real
-- database. With slot-scoped superseding in place, round 3 aborted outright:
--
--   ERROR 23505: duplicate key value violates unique constraint
--                "notifications_one_per_quote_response"
--   DETAIL: Key (job_id, kind, (payload->>'quote_id')) = (..., quote_ready,
--           86592fea-...) already exists.
--
-- Why: the notification anchored on the lowest-slot quote that was currently
-- live, not on anything new. Round 1 sends Essential (slot 1) and notifies it.
-- Round 2 adds a Premium option, or revises Complete -- slot 1 is untouched, so
-- it is still the lowest live option, so it is chosen as the anchor again, and
-- the insert collides with round 1's notification. The whole send then rolls
-- back: the customer never receives the new option, and the admin sees a raw
-- constraint error.
--
-- notifications_one_per_quote_response is doing its job here -- it exists to
-- stop a customer being emailed twice about the same quote -- so it is left
-- exactly as it is. The anchor is what was wrong.
--
-- The email announces what has just been issued, so it now anchors on a quote
-- that was actually sent in THIS round: the drafts are flipped with a
-- returning clause and the anchor is chosen from among them. A draft has
-- never been sent before and so has never been notified before, which makes a
-- collision impossible by construction rather than by retry or by ignoring
-- the conflict. On a first send this picks the same quote it always did, so
-- single-round behaviour is unchanged.
--
-- Only the flip-and-anchor step changes; the rest of the function is as it was
-- after the previous migration.

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
  v_just_sent uuid[];
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

  -- Flip the drafts and remember exactly which quotes this round issued.
  with flipped as (
    update public.ns_quotes set status = 'sent', sent_at = now()
     where option_group_id = p_option_group_id and status = 'draft'
     returning id
  )
  select coalesce(array_agg(id), '{}'::uuid[]) into v_just_sent from flipped;

  update public.ns_jobs set status = 'quote_sent' where id = v_job;

  -- Anchor on a quote issued in THIS round. Never previously sent, therefore
  -- never previously notified, so notifications_one_per_quote_response cannot
  -- be violated however many rounds the group goes through.
  select id, total, currency, valid_until into v_anchor, v_total, v_currency, v_valid
  from public.ns_quotes
  where id = any(v_just_sent)
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
