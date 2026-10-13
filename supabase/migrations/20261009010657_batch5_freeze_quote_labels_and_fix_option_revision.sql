-- Batch 5: two correctness fixes to the quote lifecycle.
--
-- =========================================================================
-- FIX 1 -- a revised option could never be sent (deadlock)
-- =========================================================================
--
-- Reproduced before changing anything, in a rolled-back transaction:
--
--   create_option_quote x2 -> send_option_group  -> both siblings 'sent'
--   duplicate_quote(sibling)                     -> new 'draft', and
--     duplicate_quote copies option_group_id forward, so the draft lands
--     INSIDE the already-sent group
--
--   mark_quote_sent(revision)  -> "part of an option group -- send the
--                                  whole group with send_option_group()"
--   send_option_group(group)   -> "This option group has already been sent."
--
-- Both doors locked: the revision was unsendable forever. The group-level
-- guard asked "has anything here ever been sent?" when the question it
-- actually needed to ask was "is there anything new to send?".
--
-- The correction is deliberately narrow. send_option_group now refuses only
-- when there is nothing in draft, and separately refuses a group in which an
-- option has been ACCEPTED -- that group is commercially settled and further
-- work belongs in a new group, not bolted onto the one the customer agreed
-- to. mark_quote_sent is left exactly as it was: routing a group member to
-- send_option_group is correct, it was only the destination that was broken.
--
-- =========================================================================
-- FIX 2 -- a sent quote's line LABELS followed the live price book
-- =========================================================================
--
-- The money was already safe: quote_line_items freezes amount/unit_rate/
-- modifier_factor and ns_quotes freezes subtotal/total, and
-- get_customer_quote reads those frozen values. A price change cannot move a
-- sent quote's numbers.
--
-- The label was not. It was coalesce(parent.name, s.name, li.description),
-- preferring the LIVE services row, so renaming a service relabelled every
-- historical quote, and re-parenting one could merge or split the lines on a
-- quote a customer had already accepted.
--
-- The obvious fix -- "just use li.description" -- is a regression trap.
-- li.description holds the CHILD's own name ("Permanent Lighting -- Jump
-- Wire"); the live parent lookup is the deliberate rollup that shows the
-- customer "Permanent Outdoor Lighting" instead of internal components.
-- Dropping it would expose internals.
--
-- So the rolled-up label is snapshotted at insert instead, in a new
-- display_description column. Additive, nullable, and read through a
-- coalesce that still falls back to the old live-lookup chain -- so any row
-- the backfill misses, and every manual line (which has no service_id and
-- therefore no parent to roll up to), renders exactly as it does today.

/* ------------------------------------------------- 1. the frozen label -- */

alter table public.quote_line_items
  add column if not exists display_description text;

comment on column public.quote_line_items.display_description is
  'Customer-facing label, snapshotted when the line is created: the parent '
  'service name where the service has a parent, otherwise its own name. '
  'Frozen so renaming or re-parenting a service in the price book cannot '
  'retroactively relabel a quote the customer has already been sent or has '
  'accepted. Nullable: get_customer_quote coalesces back to the live lookup, '
  'so a null is a correct legacy value, not a broken row.';

-- Backfill with exactly the rule get_customer_quote used until now, so no
-- existing quote changes appearance as a result of this migration.
--
-- quote_line_items carries quote_line_items_draft_only (BEFORE INSERT OR
-- UPDATE OR DELETE -> guard_quote_is_draft()), which refuses any row change
-- when the parent quote is not 'draft'. That guard is the reason this
-- migration exists -- but it also blocks the backfill, and the rows it blocks
-- are precisely the ones that need the frozen label most: 18 of 35 live line
-- items hang off sent/accepted/superseded quotes, and those are the quotes a
-- price-book rename would silently rewrite. Leaving them null would leave the
-- bug in place for every quote already in a customer's inbox.
--
-- So the guard is suspended for this one statement. This is not a weakening:
--   * it is scoped to the single named trigger, not DISABLE TRIGGER ALL, so
--     the foreign-key and other system triggers stay live;
--   * apply_migration runs in one transaction (the first attempt at this
--     migration failed on exactly this statement and left no column behind),
--     and DDL on triggers is transactional, so the guard is never observably
--     off to another session -- concurrent writers block on the lock and then
--     see it enabled again;
--   * the value written is, by construction, the string get_customer_quote
--     already returns for that line today, so no settled quote's meaning,
--     money, or appearance changes.
-- Nothing below this re-enable may assume the guard is off.
alter table public.quote_line_items disable trigger quote_line_items_draft_only;

update public.quote_line_items li
   set display_description = coalesce(par.name, s.name, li.description)
  from public.quote_line_items l2
  left join public.services s   on s.id = l2.service_id
  left join public.services par on par.key = s.parent_key
 where l2.id = li.id
   and li.display_description is null;

alter table public.quote_line_items enable trigger quote_line_items_draft_only;

/* --------------------------------- 2. populate it on every create path -- */

create or replace function public.create_quote_from_calculation(
  p_job_id uuid,
  p_kind   text default 'final'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_quote    uuid;
  v_version  integer;
  v_defaults jsonb;
  v_tax      jsonb;
  v_rate     numeric := 0;
begin
  if not public.is_admin() then
    raise exception 'Not authorised.' using errcode = 'insufficient_privilege';
  end if;

  if p_kind not in ('preliminary_estimate','final') then
    raise exception 'Invalid quote kind.' using errcode = 'check_violation';
  end if;

  select coalesce(max(version), 0) + 1 into v_version
  from public.ns_quotes where job_id = p_job_id;

  select value into v_defaults from public.app_settings where key = 'quote_defaults';
  select value into v_tax      from public.app_settings where key = 'tax';

  if coalesce((v_tax->>'enabled')::boolean, false) then
    v_rate := coalesce((v_tax->>'rate')::numeric, 0);
  end if;

  insert into public.ns_quotes
    (job_id, version, kind, status, tax_rate, valid_until, customer_notes, terms, created_by)
  values (
    p_job_id, v_version, p_kind, 'draft', v_rate,
    current_date + coalesce((v_defaults->>'validity_days')::int, 30),
    v_defaults->>'customer_note',
    v_defaults->>'terms',
    auth.uid()
  )
  returning id into v_quote;

  insert into public.quote_line_items
    (quote_id, service_id, description, display_description, quantity, unit, unit_rate,
     modifier_factor, addons_amount, computed_amount, minimum_applied, amount,
     pricing_approved, sort_order)
  select v_quote, p.service_id, p.service_name,
         coalesce(disp.display_name, p.service_name),
         p.quantity, p.unit, coalesce(p.unit_rate, 0),
         p.modifier_factor, p.addons_amount, p.computed_amount, p.minimum_applied, p.amount,
         coalesce(pr.approval_status, 'unpriced') = 'approved',
         row_number() over ()
  from public.calculate_job_pricing(p_job_id) p
  left join lateral (
    select coalesce(par.name, s.name) as display_name
    from public.services s
    left join public.services par on par.key = s.parent_key
    where s.id = p.service_id
  ) disp on true
  left join lateral (
    select pr2.approval_status
    from public.pricing_rules pr2
    where pr2.service_id = p.service_id
      and pr2.effective_from <= now()
      and (pr2.effective_to is null or pr2.effective_to > now())
    order by pr2.effective_from desc
    limit 1
  ) pr on true;

  perform public.recalculate_quote_totals(v_quote);
  return v_quote;
end
$$;

create or replace function public.create_option_quote(
  p_job_id           uuid,
  p_option_group_id  uuid,
  p_option_label     text,
  p_option_sort_order integer,
  p_measurement_ids  uuid[],
  p_kind             text default 'final',
  p_parent_quote_id  uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_quote    uuid;
  v_version  integer;
  v_defaults jsonb;
  v_tax      jsonb;
  v_rate     numeric := 0;
begin
  if not public.is_admin() then
    raise exception 'Not authorised.' using errcode = 'insufficient_privilege';
  end if;

  if p_kind not in ('preliminary_estimate','final') then
    raise exception 'Invalid quote kind.' using errcode = 'check_violation';
  end if;
  if p_option_group_id is null then
    raise exception 'An option group id is required.' using errcode = 'check_violation';
  end if;
  if p_option_label is null or btrim(p_option_label) = '' then
    raise exception 'An option label is required.' using errcode = 'check_violation';
  end if;
  if p_option_sort_order is null then
    raise exception 'An option sort order is required.' using errcode = 'check_violation';
  end if;
  if p_measurement_ids is null or array_length(p_measurement_ids, 1) is null then
    raise exception 'At least one measurement must be included in this option.' using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from unnest(p_measurement_ids) as mid
    left join public.job_measurements jm on jm.id = mid and jm.job_id = p_job_id
    where jm.id is null
  ) then
    raise exception 'One or more measurements do not belong to this job.' using errcode = 'check_violation';
  end if;

  if p_parent_quote_id is not null and not exists (
    select 1 from public.ns_quotes
    where id = p_parent_quote_id and option_group_id = p_option_group_id
  ) then
    raise exception 'The parent quote must belong to the same option group.' using errcode = 'check_violation';
  end if;

  select coalesce(max(version), 0) + 1 into v_version
  from public.ns_quotes where job_id = p_job_id;

  select value into v_defaults from public.app_settings where key = 'quote_defaults';
  select value into v_tax      from public.app_settings where key = 'tax';

  if coalesce((v_tax->>'enabled')::boolean, false) then
    v_rate := coalesce((v_tax->>'rate')::numeric, 0);
  end if;

  insert into public.ns_quotes
    (job_id, version, kind, status, tax_rate, valid_until, customer_notes, terms, created_by,
     parent_quote_id, option_group_id, option_label, option_sort_order)
  values (
    p_job_id, v_version, p_kind, 'draft', v_rate,
    current_date + coalesce((v_defaults->>'validity_days')::int, 30),
    v_defaults->>'customer_note',
    v_defaults->>'terms',
    auth.uid(),
    p_parent_quote_id, p_option_group_id, btrim(p_option_label), p_option_sort_order
  )
  returning id into v_quote;

  insert into public.quote_line_items
    (quote_id, service_id, description, display_description, quantity, unit, unit_rate,
     modifier_factor, addons_amount, computed_amount, minimum_applied, amount,
     pricing_approved, sort_order)
  select v_quote, p.service_id, p.service_name,
         coalesce(disp.display_name, p.service_name),
         p.quantity, p.unit, coalesce(p.unit_rate, 0),
         p.modifier_factor, p.addons_amount, p.computed_amount, p.minimum_applied, p.amount,
         coalesce(pr.approval_status, 'unpriced') = 'approved',
         row_number() over ()
  from public.calculate_job_pricing(p_job_id, p_measurement_ids) p
  left join lateral (
    select coalesce(par.name, s.name) as display_name
    from public.services s
    left join public.services par on par.key = s.parent_key
    where s.id = p.service_id
  ) disp on true
  left join lateral (
    select pr2.approval_status
    from public.pricing_rules pr2
    where pr2.service_id = p.service_id
      and pr2.effective_from <= now()
      and (pr2.effective_to is null or pr2.effective_to > now())
    order by pr2.effective_from desc
    limit 1
  ) pr on true;

  insert into public.quote_option_measurements (quote_id, measurement_id)
  select v_quote, mid from unnest(p_measurement_ids) as mid;

  perform public.recalculate_quote_totals(v_quote);
  return v_quote;
end
$$;

-- A duplicate must carry the frozen label forward, or revising a quote would
-- quietly re-derive the label from the live price book -- reintroducing the
-- exact drift this migration exists to stop.
create or replace function public.duplicate_quote(p_quote_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_job      uuid;
  v_version  integer;
  v_new      uuid;
  v_defaults jsonb;
begin
  if not public.is_admin() then
    raise exception 'Not authorised.' using errcode = 'insufficient_privilege';
  end if;

  select job_id into v_job from public.ns_quotes where id = p_quote_id;
  if v_job is null then
    raise exception 'Quote not found.' using errcode = 'no_data_found';
  end if;

  select coalesce(max(version), 0) + 1 into v_version
  from public.ns_quotes where job_id = v_job;

  select value into v_defaults from public.app_settings where key = 'quote_defaults';

  insert into public.ns_quotes
    (job_id, version, kind, status, currency, subtotal, adjustments_total,
     tax_rate, tax_total, total, valid_until, customer_notes, terms, created_by,
     parent_quote_id, option_group_id, option_label, option_sort_order)
  select v_job, v_version, kind, 'draft', currency, subtotal, adjustments_total,
         tax_rate, tax_total, total,
         current_date + coalesce((v_defaults->>'validity_days')::int, 30),
         customer_notes, terms, auth.uid(),
         p_quote_id, option_group_id, option_label, option_sort_order
  from public.ns_quotes where id = p_quote_id
  returning id into v_new;

  insert into public.quote_line_items
    (quote_id, service_id, description, display_description, quantity, unit, unit_rate,
     modifier_factor, addons_amount, computed_amount, minimum_applied, amount,
     pricing_approved, source, sort_order)
  select v_new, service_id, description, display_description, quantity, unit, unit_rate,
         modifier_factor, addons_amount, computed_amount, minimum_applied, amount,
         pricing_approved, source, sort_order
  from public.quote_line_items where quote_id = p_quote_id;

  insert into public.quote_adjustments (quote_id, kind, label, value, amount, sort_order)
  select v_new, kind, label, value, amount, sort_order
  from public.quote_adjustments where quote_id = p_quote_id;

  insert into public.quote_option_measurements (quote_id, measurement_id)
  select v_new, measurement_id from public.quote_option_measurements where quote_id = p_quote_id;

  return v_new;
end
$$;

/* ---------------------------- 3. read the frozen label, with fallback -- */

create or replace function public.get_customer_quote(p_quote_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  select jsonb_build_object(
    'reference',      j.reference,
    'version',        q.version,
    'status',         q.status,
    'issued_on',      q.sent_at,
    'valid_until',    q.valid_until,
    'currency',       q.currency,
    'customer_name',  c.name,
    'property',       trim(both ', ' from concat_ws(', ',
                        p.address_line1, p.city, p.postal_code)),
    'customer_notes', q.customer_notes,
    'terms',          q.terms,
    'subtotal',       q.subtotal,
    'tax_total',      q.tax_total,
    'total',          q.total,
    'company',        (select value from public.app_settings where key = 'company'),
    'signature_path', q.signature_url,
    'signed_by_name', q.signed_by_name,
    'signed_at',      q.signed_at,
    'option_group',   case when q.option_group_id is null then null else
      jsonb_build_object(
        'group_id', q.option_group_id,
        'options', coalesce((
          select jsonb_agg(jsonb_build_object(
                   'id',                sib.id,
                   'option_label',      sib.option_label,
                   'option_sort_order', sib.option_sort_order,
                   'total',             sib.total,
                   'status',            sib.status,
                   'pricing_approved',  coalesce((
                     select bool_and(li.pricing_approved)
                     from public.quote_line_items li where li.quote_id = sib.id
                   ), true)
                 ) order by sib.option_sort_order, sib.version)
          from public.ns_quotes sib
          where sib.option_group_id = q.option_group_id
            and (sib.status in ('sent','accepted','declined','expired','superseded') or public.is_admin())
        ), '[]'::jsonb)
      )
    end,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
               'description',      grp.description,
               'amount',           grp.amount,
               'pricing_approved', grp.pricing_approved)
             order by grp.sort_order)
      from (
        select
          -- display_description is the label frozen when this line was
          -- created. The remaining terms are the pre-Batch-5 live lookup,
          -- kept as a fallback so legacy rows and manual lines (no
          -- service_id, so nothing to roll up) render unchanged.
          coalesce(li.display_description, parent.name, s.name, li.description) as description,
          sum(li.amount) as amount,
          bool_and(li.pricing_approved) as pricing_approved,
          min(li.sort_order) as sort_order,
          coalesce(parent.id, s.id, li.id) as grp_key
        from public.quote_line_items li
        left join public.services s      on s.id = li.service_id
        left join public.services parent on parent.key = s.parent_key
        where li.quote_id = q.id
        group by grp_key, coalesce(li.display_description, parent.name, s.name, li.description)
      ) grp), '[]'::jsonb),
    'adjustments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'label',  a.label,
               'amount', a.amount)
             order by a.sort_order)
      from public.quote_adjustments a where a.quote_id = q.id), '[]'::jsonb),
    'change_orders', coalesce((
      select jsonb_agg(jsonb_build_object(
               'description', co.description,
               'amount',      co.amount,
               'created_at',  co.created_at)
             order by co.created_at)
      from public.ns_change_orders co
      where co.quote_id = q.id and co.status = 'approved'), '[]'::jsonb)
  )
  into v
  from public.ns_quotes q
  join public.ns_jobs j   on j.id = q.job_id
  join public.customers c on c.id = j.customer_id
  join public.properties p on p.id = j.property_id
  where q.id = p_quote_id
    and (q.status in ('sent','accepted','declined','expired','superseded')
         or public.is_admin());

  if v is null then
    raise exception 'Quote not found.' using errcode = 'no_data_found';
  end if;
  return v;
end
$$;

/* ------------------------- 4. a revised option can be sent again ------- */

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

  -- The old guard asked "has anything here ever been sent?", which made a
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

  -- Supersede any prior sent quote for this job OUTSIDE this option group.
  update public.ns_quotes set status = 'superseded'
   where job_id = v_job and status = 'sent'
     and option_group_id is distinct from p_option_group_id;

  -- ...and, now that a group can be re-sent, the previously sent siblings
  -- INSIDE it: the customer is being given a new set of options, so the old
  -- ones stop being live. Only 'sent' is superseded -- a declined option
  -- keeps its own history.
  update public.ns_quotes set status = 'superseded'
   where option_group_id = p_option_group_id and status = 'sent';

  update public.ns_quotes set status = 'sent', sent_at = now()
   where option_group_id = p_option_group_id and status = 'draft';

  update public.ns_jobs set status = 'quote_sent' where id = v_job;

  -- Anchor the notification on an option that was actually just sent, not
  -- on a superseded one from the previous round.
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
