-- ===========================================================================
-- Batch 13.1 (3 of 4): getting the report to the customer, honestly.
--
-- WHAT IS REUSED. The EXISTING `notifications` table (Batch 2/5) is the
-- outbound queue, and 12.1's five-outcome request/outcome semantics are the
-- delivery states. No second sender, no second pipeline, no trigger and no
-- scheduler: a row in `notifications` is a message somebody still has to
-- send, and nothing in this file claims otherwise.
--
-- THE WORKER IS MISSING, AND THAT IS REPORTED RATHER THAN PAPERED OVER.
-- This repository contains no notification worker and no Edge Function
-- source for one: `supabase/functions` holds `submit-request` only (the
-- Turnstile-gated quote intake the public site posts to), and nothing in
-- the tree reads `notifications` and sends it. The deployed sender's source
-- is therefore NOT in this repository. So:
--   * the local contract -- what is queued, in what shape, with what
--     states and what timestamps -- is implemented and tested here;
--   * `record_report_delivery_outcome` is the adapter's way back in, and
--     the suite drives it with a DOUBLE;
--   * REAL SENDING IS UNRUN, and no inserted row is ever described as
--     processed.
--
-- ACCEPTED IS NOT DELIVERED. Five states, four of which are not a success,
-- and `unknown` is not optimism: it stays live and keeps blocking a second
-- message, because the provider may have neither idempotency nor an outcome
-- lookup and a retry may be the customer's second identical text.
--
-- NOT APPLIED ANYWHERE. Twenty-seventh pending migration.
-- ===========================================================================

/* ===================================================================== */
/* 1. the delivery record                                                 */
/* ===================================================================== */

create table if not exists public.ns_report_deliveries (
  id            uuid primary key default gen_random_uuid(),
  report_id     uuid not null
                  references public.ns_completion_reports(id) on delete restrict,
  -- The capability the message carries. The TOKEN is not here: the grant's
  -- identity is enough to revoke it, and a delivery record is read by more
  -- screens than the grant table is.
  grant_id      uuid references public.ns_customer_grants(id) on delete set null,

  channel       text not null,
  -- Resolved from the JOB's customer, never from a caller-supplied
  -- destination. Stored because "where did it go" is the first question
  -- when a customer says they got nothing.
  recipient     text,

  -- The queued row in the EXISTING table. No inline foreign key:
  -- `notifications` is live-only (docs/batch7-1-findings.md 4b), so the key
  -- is added below if and only if the table is there -- the same pattern
  -- 12.1 uses.
  notification_id uuid,

  delivery_state  text not null,
  provider_message_id text,
  provider_error  text,

  /* ------------------------- THE FIVE TIMESTAMPS, kept apart -------- */
  -- When the SERVER accepted the completion. Where the clock starts: not
  -- an offline gesture, not a worker's tap.
  accepted_at     timestamptz,
  -- When the report had everything it needed to be a customer document --
  -- i.e. when it was published. Null while an owner review holds it.
  readiness_at    timestamptz,
  -- When this document was generated.
  report_generated_at timestamptz,
  -- When the message was queued. Local processing ends here.
  enqueued_at     timestamptz,
  -- When the provider's answer arrived. Delivery ends here, and only an
  -- adapter can set it.
  resolved_at     timestamptz,

  requested_by    uuid references auth.users(id),
  requested_at    timestamptz not null default now(),
  client_operation_id text not null,

  constraint ns_report_deliveries_channel_known check (channel in ('sms', 'email')),
  -- The same five as 12.1 §8, with the same meanings, so a reader who
  -- learnt them on the dispatch screen does not have to learn them again.
  constraint ns_report_deliveries_state_known check (delivery_state in (
    'accepted',        -- recorded and queued. NOT sent.
    'delivered',       -- the provider says it went
    'provider_failed', -- the provider says it did not
    'unknown',         -- we asked and do not know. NOT a success.
    'unavailable')),   -- no provider configured, or no contact on file
  constraint ns_report_deliveries_send_has_a_row check (
    (delivery_state = 'unavailable') = (notification_id is null)),
  constraint ns_report_deliveries_failure_explained check (
    delivery_state <> 'provider_failed' or coalesce(btrim(provider_error), '') <> ''),
  constraint ns_report_deliveries_unavailable_explained check (
    delivery_state <> 'unavailable' or coalesce(btrim(provider_error), '') <> ''),
  -- An unavailable delivery minted no capability either: a link nobody can
  -- be sent is a live credential with no reader.
  constraint ns_report_deliveries_unavailable_has_no_grant check (
    delivery_state <> 'unavailable' or grant_id is null),
  constraint ns_report_deliveries_client_id_not_blank
    check (btrim(client_operation_id) <> '')
);

do $$
begin
  if to_regclass('public.notifications') is not null
     and not exists (
       select 1 from pg_constraint
        where conrelid = 'public.ns_report_deliveries'::regclass
          and conname = 'ns_report_deliveries_notification_fk') then
    execute 'alter table public.ns_report_deliveries
               add constraint ns_report_deliveries_notification_fk
               foreign key (notification_id)
               references public.notifications(id) on delete set null';
  end if;
end
$$;

/* ONE LIVE DELIVERY PER REPORT. The logical deduplication: not "per browser
   key" -- two tabs, or a retry with a fresh key, must not both text the
   customer. A finished one (delivered, failed, unavailable) does not block
   a later, deliberate re-send. */
create unique index if not exists ns_report_deliveries_one_live
  on public.ns_report_deliveries (report_id)
  where delivery_state in ('accepted', 'unknown');

create unique index if not exists ns_report_deliveries_client_id_key
  on public.ns_report_deliveries (client_operation_id);

create index if not exists ns_report_deliveries_report_idx
  on public.ns_report_deliveries (report_id, requested_at desc);

comment on table public.ns_report_deliveries is
  'One row per attempt to put a report in front of a customer, with the '
  'five timestamps that make "did we hit two minutes" answerable and the '
  'five outcomes that keep queued, delivered, failed, unknown and '
  'unavailable apart.';

/* ===================================================================== */
/* 2. sending                                                             */
/* ===================================================================== */

/** Deliver a published report: mint the customer's capability and queue
 *  the message, in ONE transaction.
 *
 *  WHY THE TOKEN IS NOT A PARAMETER. `issue_customer_grant` shows a token
 *  exactly once and keeps no copy, so an owner who wanted to send it would
 *  have to paste a live credential back into another call -- through a
 *  browser, a log and a request body. Here the token is created, written
 *  into the outbound payload, and goes out of scope. It is in exactly one
 *  place at rest: the `notifications` row that is about to send it, which
 *  is what an outbox is. It is NOT in the receipt, NOT in
 *  ns_report_deliveries, NOT in ns_handover_operations and NOT in
 *  ns_customer_grant_reads.
 *
 *  OWNER-ONLY. A crew does not send a customer our account of the work.
 *
 *  THE RECIPIENT IS RESOLVED, never supplied: from the report's job's
 *  customer. A caller-passed destination is how a customer's paperwork
 *  reaches the wrong phone.
 *
 *  UNAVAILABLE IS A RECEIPT, NOT AN EXCEPTION -- the owner needs it on the
 *  screen -- and it mints no capability. */
create or replace function public.deliver_completion_report(
  p_client_operation_id text,
  p_report_id           uuid,
  p_channel             text default 'sms',
  p_expires_at          timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_print   text;
  v_replay  jsonb;
  v_r       public.ns_completion_reports;
  v_c       public.ns_job_completions;
  v_job     public.ns_jobs;
  v_cust    record;
  v_provider text;
  v_to      text;
  v_state   text;
  v_why     text;
  v_grant   jsonb;
  v_grant_id uuid;
  v_token   text;
  v_note    uuid;
  v_del     public.ns_report_deliveries;
  v_receipt jsonb;
begin
  if not public.is_owner() then
    raise exception
      'Only the owner sends a customer their completion report.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_channel not in ('sms', 'email') then
    raise exception 'channel must be sms or email'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_r from public.ns_completion_reports where id = p_report_id;
  if not found then
    raise exception 'No such report %', p_report_id using errcode = 'no_data_found';
  end if;

  -- A DRAFT IS NOT SENT. The review hold is the owner's to clear, and a
  -- send that quietly published first would make the hold decorative.
  if v_r.publication_state = 'draft' then
    raise exception
      'Report v% is still a draft. Publish it first -- the hold says: %',
      v_r.report_version, coalesce(v_r.review_hold, 'awaiting review')
      using errcode = 'check_violation';
  end if;
  if v_r.publication_state = 'superseded' then
    raise exception
      'Report v% was superseded. Send the current report rather than one we '
      'have already corrected.', v_r.report_version
      using errcode = 'check_violation';
  end if;

  v_print := public.ns_load_intent_fingerprint(jsonb_build_object(
    'report_id', p_report_id, 'channel', p_channel));
  v_replay := public.ns_handover_replay_guard(
    p_client_operation_id, 'report_delivery', p_report_id, v_print);
  if v_replay is not null then return v_replay; end if;

  select * into v_job from public.ns_jobs where id = v_r.job_id;
  select * into v_c from public.ns_job_completions where id = v_r.completion_id;
  select c.id, c.name, c.phone, c.email into v_cust
    from public.customers c where c.id = v_job.customer_id;

  v_provider := public.ns_sms_provider();
  v_to := case when p_channel = 'sms'
               then nullif(btrim(coalesce(v_cust.phone, '')), '')
               else lower(nullif(btrim(coalesce(v_cust.email, '')), '')) end;

  -- The two unavailable reasons, told apart, because different people fix
  -- them in different places. Email has no provider gate here: Batch 2/5
  -- already queue email into this table and whatever drains it, so
  -- inventing a second gate for email would refuse work that the existing
  -- pipeline accepts.
  if p_channel = 'sms' and v_provider is null then
    v_state := 'unavailable';
    v_why := 'No SMS provider is configured, so nothing was sent. Set one '
             'in Settings (notifications.sms_provider).';
  elsif v_to is null then
    v_state := 'unavailable';
    v_why := 'This customer has no ' || p_channel || ' on file, so nothing '
             'was sent.';
  else
    v_state := 'accepted';
  end if;

  if v_state = 'accepted' then
    /* The capability, minted here and sent straight out. The derived key
       keeps the grant replay-safe under the delivery's own key. */
    v_grant := public.issue_customer_grant(
      p_client_operation_id || ':grant', 'report', p_report_id,
      null, p_expires_at, 'Completion report v' || v_r.report_version);
    v_grant_id := (v_grant ->> 'grant_id')::uuid;
    v_token := v_grant ->> 'token';

    insert into public.notifications
      (kind, channel, recipient, subject, payload, job_id)
    values
      ('completion_report', p_channel, v_to,
       'Your Nova Shield completion report',
       /* WHAT THE PAYLOAD CARRIES: the customer's own name, the link, and
          nothing else. No access code, no internal note, no materials, no
          totals -- the document itself is behind the capability, and a
          message payload is stored, replayed and rendered in places a
          document is not. */
       jsonb_build_object(
         'report_id',      p_report_id,
         'report_version', v_r.report_version,
         'customer',       v_cust.name,
         'link_path',      'report.html?t=' || v_token,
         'requested_at',   now()),
       v_r.job_id)
    returning id into v_note;
  end if;

  insert into public.ns_report_deliveries
    (report_id, grant_id, channel, recipient, notification_id, delivery_state,
     provider_error, accepted_at, readiness_at, report_generated_at,
     enqueued_at, requested_by, client_operation_id)
  values
    (p_report_id, v_grant_id, p_channel, v_to, v_note, v_state, v_why,
     v_c.accepted_at, v_r.published_at, v_r.generated_at,
     case when v_state = 'accepted' then now() else null end,
     auth.uid(), p_client_operation_id)
  returning * into v_del;

  v_receipt := jsonb_build_object(
    'delivery_id',     v_del.id,
    'report_id',       p_report_id,
    'grant_id',        v_grant_id,
    'channel',         p_channel,
    'delivery_state',  v_del.delivery_state,
    'reason',          v_del.provider_error,
    'notification_id', v_del.notification_id,
    -- Masked: the owner asked us to tell the customer, and reading the
    -- number back adds nothing.
    'recipient_known', v_to is not null,
    'provider_configured', v_provider is not null,
    -- THE SENTENCE THIS WHOLE FILE EXISTS FOR.
    'sent',            false,
    'delivered',       false,
    'queued',          v_state = 'accepted',
    'replayed',        false);

  insert into public.ns_handover_operations
    (client_operation_id, kind, scope_id, intent_fingerprint, actor_id, receipt)
  values
    (p_client_operation_id, 'report_delivery', p_report_id, v_print,
     auth.uid(), v_receipt);

  return v_receipt;
end
$$;

/** What the provider said. OWNER OR SERVICE ROLE -- the adapter runs as the
 *  service role, and the owner can record an outcome by hand when a
 *  provider has no callback.
 *
 *  THE SAME HONEST RETRY RULE as 12.1 §8, and the SAME KEY: the original
 *  delivery row is updated rather than replaced, so an uncertain outcome
 *  resolved later is still one logical delivery.
 *
 *   * `delivered` and `provider_failed` are terminal.
 *   * `unknown` stays live and keeps blocking a second message. Clearing it
 *     is a human decision. */
create or replace function public.record_report_delivery_outcome(
  p_delivery_id         uuid,
  p_delivery_state      text,
  p_provider_message_id text default null,
  p_provider_error      text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_d public.ns_report_deliveries;
begin
  -- A crew cannot mark its own employer's message delivered, and neither
  -- can an ordinary admin: this is the provider's answer being recorded,
  -- and the only callers are the adapter and the owner.
  -- `current_user` as well as the GUC: a Supabase service-role connection
  -- arrives as that role, while a `set role` inside a session shows up in
  -- the setting. Checking one and not the other locks out the adapter.
  if not (public.is_owner()
          or current_user = 'service_role'
          or current_setting('role', true) = 'service_role') then
    raise exception
      'Recording a provider outcome is the owner''s or the sending '
      'adapter''s, not a screen''s.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_delivery_state not in
       ('delivered', 'provider_failed', 'unknown') then
    raise exception
      'A provider outcome is delivered, provider_failed or unknown. '
      '"accepted" is what queuing already recorded and "unavailable" is '
      'ours, not the provider''s.'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_delivery_state = 'provider_failed'
     and coalesce(btrim(coalesce(p_provider_error, '')), '') = '' then
    raise exception 'A failure needs the provider''s reason'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_d from public.ns_report_deliveries
   where id = p_delivery_id for update;
  if not found then
    raise exception 'No such delivery %', p_delivery_id
      using errcode = 'no_data_found';
  end if;

  if v_d.delivery_state in ('delivered', 'provider_failed') then
    if v_d.delivery_state = p_delivery_state then
      return jsonb_build_object('delivery_id', v_d.id, 'no_op', true,
        'delivery_state', v_d.delivery_state, 'replayed', true);
    end if;
    raise exception
      'Delivery % is already %. A provider does not un-deliver a message.',
      v_d.id, v_d.delivery_state using errcode = 'check_violation';
  end if;
  if v_d.delivery_state = 'unavailable' then
    raise exception
      'Nothing was queued for delivery %, so the provider has no outcome '
      'to report.', v_d.id using errcode = 'check_violation';
  end if;

  update public.ns_report_deliveries
     set delivery_state = p_delivery_state,
         provider_message_id = coalesce(p_provider_message_id, provider_message_id),
         provider_error = nullif(btrim(coalesce(p_provider_error, '')), ''),
         resolved_at = case when p_delivery_state = 'unknown'
                            then resolved_at else now() end
   where id = p_delivery_id;

  return jsonb_build_object(
    'delivery_id',    v_d.id,
    'report_id',      v_d.report_id,
    'delivery_state', p_delivery_state,
    'no_op',          false,
    'replayed',       false,
    -- `unknown` is not a success and the receipt refuses to imply it.
    'delivered',      p_delivery_state = 'delivered',
    'still_live',     p_delivery_state = 'unknown');
end
$$;

/* ===================================================================== */
/* 3. the two-minute question, answered with five clocks                  */
/* ===================================================================== */

/** The timing of one report's delivery, with LOCAL PROCESSING AND DELIVERY
 *  MEASURED SEPARATELY, because they fail for different reasons and only
 *  one of them is ours.
 *
 *  THE CLOCK STARTS at the server's acceptance of the completion WITH the
 *  publishable evidence available -- i.e. `accepted_at`, and readiness is
 *  reported next to it so an owner review hold is visible as the delay it
 *  is rather than hidden in a single number.
 *
 *  `sla_state` is `indeterminate` whenever the provider is unavailable or
 *  its outcome is unknown. An unavailable provider cannot meet a delivery
 *  target and a suite that scored it as `met` would be measuring our own
 *  INSERT. */
create or replace function public.report_delivery_timing(p_report_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_r public.ns_completion_reports;
begin
  if not public.is_admin() then
    raise exception 'report_delivery_timing is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  select * into v_r from public.ns_completion_reports where id = p_report_id;
  if not found then
    raise exception 'No such report %', p_report_id using errcode = 'no_data_found';
  end if;

  return jsonb_build_object(
    'report_id', p_report_id,
    'deliveries', coalesce((
      select jsonb_agg(jsonb_build_object(
               'delivery_id',     d.id,
               'channel',         d.channel,
               'delivery_state',  d.delivery_state,

               'accepted_at',           d.accepted_at,
               'readiness_at',          d.readiness_at,
               'report_generated_at',   d.report_generated_at,
               'enqueued_at',           d.enqueued_at,
               'resolved_at',           d.resolved_at,

               -- OURS: acceptance -> readiness -> generated -> queued.
               'acceptance_to_readiness_seconds',
                 case when d.readiness_at is null or d.accepted_at is null then null
                      else extract(epoch from (d.readiness_at - d.accepted_at)) end,
               'local_processing_seconds',
                 case when d.enqueued_at is null or d.accepted_at is null then null
                      else extract(epoch from (d.enqueued_at - d.accepted_at)) end,
               -- THEIRS: queued -> the provider's answer.
               'provider_seconds',
                 case when d.resolved_at is null or d.enqueued_at is null then null
                      else extract(epoch from (d.resolved_at - d.enqueued_at)) end,

               'review_hold', v_r.review_hold,
               'sla_state', case
                 when d.delivery_state in ('unavailable', 'unknown') then 'indeterminate'
                 when d.delivery_state = 'provider_failed' then 'failed'
                 when d.resolved_at is null then 'awaiting_provider'
                 when d.accepted_at is null then 'indeterminate'
                 when extract(epoch from (d.resolved_at - d.accepted_at)) <= 120
                   then 'met' else 'missed' end,
               'sla_basis',
                 'server acceptance of the completion to the provider''s '
                 'own outcome; an unavailable provider or an unknown '
                 'outcome is never scored as met')
             order by d.requested_at desc)
        from public.ns_report_deliveries d where d.report_id = p_report_id),
      '[]'::jsonb));
end
$$;

/** Every delivery for a report, for the owner's screen. Admin-scoped by the
 *  same job rule as everything else, and carrying no token. */
create or replace function public.report_deliveries(p_report_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'report_deliveries is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  return jsonb_build_object(
    'report_id', p_report_id,
    'deliveries', coalesce((
      select jsonb_agg(jsonb_build_object(
               'delivery_id',     d.id,
               'channel',         d.channel,
               'delivery_state',  d.delivery_state,
               'reason',          d.provider_error,
               'provider_message_id', d.provider_message_id,
               'recipient_known', d.recipient is not null,
               'grant_id',        d.grant_id,
               'notification_id', d.notification_id,
               'requested_at',    d.requested_at,
               'enqueued_at',     d.enqueued_at,
               'resolved_at',     d.resolved_at,
               -- Said on every row, because a queued row is the thing
               -- people mistake for a sent message.
               'sent',            d.delivery_state = 'delivered')
             order by d.requested_at desc)
        from public.ns_report_deliveries d where d.report_id = p_report_id),
      '[]'::jsonb));
end
$$;

/* ===================================================================== */
/* 4. inbound replies: the extension point, and nothing more              */
/* ===================================================================== */

/** Can a customer reply to one of our messages, and what happens if they
 *  do? Today: nothing, and this says so.
 *
 *  WHAT IS DELIBERATELY NOT INVENTED HERE. No webhook route, no signature
 *  scheme, no phone-identity proof, no reply state machine, no auto-answer.
 *  All four are provider-specific -- a provider may sign with HMAC over a
 *  raw body, or with a JWT, or not at all; it may or may not prove that the
 *  sender owns the number -- and a reply pipeline built against a guess is
 *  a pipeline that gets rewritten the day a provider is chosen.
 *
 *  THE ONE RULE THAT IS NOT NEGOTIABLE, recorded now so a later
 *  implementation inherits it: AN AUTOMATIC REPLY NEVER DISCLOSES AN
 *  ACCESS CODE. 12.1 keeps `access_code` and `internal_note` ungranted at
 *  column level for exactly this reason, and an SMS auto-responder that
 *  "helpfully" sent the gate code to whoever texted the business number
 *  would undo that in one line. */
create or replace function public.ns_inbound_reply_support()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  return jsonb_build_object(
    'state', 'unconfigured',
    'sms_provider', public.ns_sms_provider(),
    'inbound_contract', 'none',
    'reasons', jsonb_build_array(
      'No SMS provider is selected, so there is no inbound message format, '
      'no signature scheme and no delivery-receipt format to implement '
      'against.',
      'Whether a provider can prove the sender owns the number is '
      'provider-specific and decides whether a reply may be trusted at all.'),
    'extension_point', jsonb_build_object(
      'where', 'a service-role Edge Function that verifies the provider''s '
               'own signature and then records an inbound row',
      'must_not', jsonb_build_array(
        'disclose an access code, an internal note or a hazard note in any '
        'automatic reply',
        'treat an inbound number as proof of identity without the '
        'provider''s own verification',
        'resolve a recipient or a property from caller-supplied text')));
end
$$;

/* ===================================================================== */
/* 5. grants                                                              */
/* ===================================================================== */

do $$
begin
  execute 'revoke all on public.ns_report_deliveries from anon';
  execute 'revoke all on public.ns_report_deliveries from authenticated';
  execute 'grant select on public.ns_report_deliveries to authenticated';
  execute 'grant all on public.ns_report_deliveries to service_role';
end
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.deliver_completion_report(text,uuid,text,timestamptz)',
    'public.report_delivery_timing(uuid)',
    'public.report_deliveries(uuid)',
    'public.ns_inbound_reply_support()']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('grant execute on function %s to authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;

  -- The adapter's way back in. `authenticated` keeps it because the owner
  -- records outcomes by hand while no provider has a callback; the function
  -- itself refuses any caller that is neither the owner nor the adapter.
  execute 'revoke all on function public.record_report_delivery_outcome(uuid,text,text,text) from public';
  execute 'revoke all on function public.record_report_delivery_outcome(uuid,text,text,text) from anon';
  execute 'grant execute on function public.record_report_delivery_outcome(uuid,text,text,text) to authenticated';
  execute 'grant execute on function public.record_report_delivery_outcome(uuid,text,text,text) to service_role';
end
$$;

/* ===================================================================== */
/* 6. assertions                                                          */
/* ===================================================================== */

do $$
begin
  if has_function_privilege('anon',
       'public.deliver_completion_report(text,uuid,text,timestamptz)',
       'execute') then
    raise exception 'anon can send a completion report';
  end if;
  if has_function_privilege('anon',
       'public.record_report_delivery_outcome(uuid,text,text,text)',
       'execute') then
    raise exception 'anon can record a delivery outcome';
  end if;
  if has_table_privilege('anon', 'public.ns_report_deliveries', 'select') then
    raise exception 'anon can select ns_report_deliveries';
  end if;

  -- 12.1's own notification request table must still be there and still
  -- carry its five states: this file reuses the semantics and a divergence
  -- would mean two different meanings of "unknown" on two screens.
  if to_regclass('public.ns_notification_requests') is null then
    raise exception
      'ns_notification_requests is missing: 13.1 reuses 12.1''s five '
      'delivery outcomes and cannot be the only place they are defined.';
  end if;
end
$$;
