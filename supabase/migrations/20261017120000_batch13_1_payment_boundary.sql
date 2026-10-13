-- ===========================================================================
-- Batch 13.1 (4 of 4): a payment boundary with no provider and no invoice
-- model -- which is to say, a boundary that refuses.
--
-- WHAT THE EXISTING MODEL ACTUALLY HAS, read before anything was written:
--
--   ns_quotes            status, version, total, currency. An ACCEPTED
--                        quote is an authoritative agreed figure.
--   ns_change_orders     approved ones carry an owner-set amount (11.1
--                        prices them in the same transaction as the
--                        approval, so an approved one always has a figure).
--
-- WHAT IT DOES NOT HAVE -- searched for by name, not assumed: there is no
-- invoice table, no payment table, no ledger of money received, and no
-- `paid` state anywhere. `grep -ril invoice|payment supabase/migrations`
-- returns nothing. So a REMAINING BALANCE IS NOT ESTABLISHED IN THIS
-- SYSTEM, and this file says so instead of computing one.
--
-- THE THREE THINGS IT WOULD HAVE BEEN WRONG TO DO:
--   1. derive an amount from material quantities. Consumption is not a
--      price and 11.1's whole point is that completion prices nothing.
--   2. derive it from a report total. A report is a document; the money is
--      the accepted quote's.
--   3. call the approved total a "balance". Approved is what was agreed.
--      Outstanding is what is agreed MINUS what was received, and the
--      second half does not exist here.
--
-- SO: `ns_payment_balance` reports `approved_total` with
-- `balance_state = 'no_settlement_model'` and a NULL remaining balance, and
-- `create_payment_request` refuses. It binds to a settlement model if one is
-- ever introduced -- it INTROSPECTS for one rather than requiring it -- and
-- the suite proves the binding with a LABELLED DOUBLE, which is not
-- evidence that any such model exists.
--
-- NOT APPLIED ANYWHERE. Twenty-eighth pending migration.
-- ===========================================================================

/* ===================================================================== */
/* 1. is there a provider at all                                          */
/* ===================================================================== */

/** The chosen payment provider, from settings, or null.
 *
 *  UNCONFIGURED MEANS UNAVAILABLE. No sandbox account, no test key, no
 *  provider SDK, no webhook assumption, no fee table: every one of those is
 *  provider-specific and picking one here would be choosing on the owner's
 *  behalf. */
create or replace function public.ns_payment_provider()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare v text;
begin
  if to_regclass('public.app_settings') is null then return null; end if;
  begin
    execute $q$
      select nullif(btrim(coalesce(value::jsonb ->> 'provider', '')), '')
        from public.app_settings where key = 'payments' limit 1
    $q$ into v;
  exception when others then
    return null;
  end;
  return v;
end
$$;

/* ===================================================================== */
/* 2. what is owed, and what is not knowable                              */
/* ===================================================================== */

/** The money facts for a job, with the missing half named.
 *
 *  `approved_total`    the accepted quote plus approved change orders.
 *                      Authoritative, frozen, already the customer's own
 *                      agreement.
 *  `amount_settled`    what has been received. NULL unless a settlement
 *                      model exists, and it does not.
 *  `remaining_balance` approved minus settled. NULL for the same reason.
 *                      NOT equal to approved_total: calling the agreed
 *                      figure "outstanding" is how a customer gets asked
 *                      twice for money they already paid.
 *  `balance_state`     'no_accepted_quote'   nothing authoritative agreed
 *                      'no_settlement_model' agreed, but what has been
 *                                            received is not recorded
 *                                            anywhere in this system
 *                      'established'         both halves are known
 *
 *  THE INTROSPECTION. If a future batch introduces `ns_payments(job_id,
 *  amount, state)`, this reads it and the state becomes `established`
 *  without another migration. That is a hook for a model that does not
 *  exist yet -- NOT a claim that it does, and not a schema this file
 *  creates. */
create or replace function public.ns_payment_balance(p_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_com      jsonb;
  v_approved numeric;
  v_settled  numeric;
  v_state    text;
begin
  v_com := public.ns_job_approved_commercials(p_job_id);
  v_approved := nullif(v_com ->> 'approved_total', '')::numeric;

  if to_regclass('public.ns_payments') is not null then
    begin
      execute 'select coalesce(sum(amount), 0) from public.ns_payments '
              'where job_id = $1 and state = ''settled'''
        into v_settled using p_job_id;
    exception when others then
      -- A table of that name whose shape is not what this expects is NOT a
      -- settlement model. Reporting "unknown" is right; guessing its
      -- columns would be worse than having none.
      v_settled := null;
    end;
  end if;

  v_state := case
    when (v_com ->> 'commercial_state') = 'no_accepted_quote'
      then 'no_accepted_quote'
    when v_settled is null then 'no_settlement_model'
    else 'established' end;

  return jsonb_build_object(
    'job_id',            p_job_id,
    'approved_total',    v_approved,
    'currency',          v_com ->> 'currency',
    'currency_state',    v_com ->> 'currency_state',
    'amount_settled',    v_settled,
    'remaining_balance', case when v_state = 'established'
                              then v_approved - v_settled else null end,
    'balance_state',     v_state,
    'commercials',       v_com,
    'missing_dependency', case when v_state = 'no_settlement_model' then
      'There is no invoice or payment-received model in this system, so '
      'what remains outstanding is not knowable. A payment request cannot '
      'bind an amount until one exists.' else null end);
end
$$;

comment on function public.ns_payment_balance(uuid) is
  'The approved total for a job and, separately, what has been received -- '
  'which this system does not record. remaining_balance is null unless a '
  'settlement model exists; it is never the approved total wearing a '
  'different name.';

/* ===================================================================== */
/* 3. the request                                                         */
/* ===================================================================== */

create table if not exists public.ns_payment_requests (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid not null references public.ns_jobs(id) on delete restrict,

  -- WHICH APPROVED RECORD this is for. A payment request that does not name
  -- its commercial record is a number somebody typed.
  quote_id    uuid references public.ns_quotes(id) on delete restrict,

  -- Bound at creation from the authoritative figures, never from a caller.
  amount      numeric,
  currency    text,
  balance_state text not null,

  -- 'unavailable'  no provider, or no bindable amount. Nothing was created
  --                anywhere and there is no link.
  -- 'prepared'     a provider is configured and the amount is bound. Still
  --                not a payment: see the comment on `create_payment_request`.
  state       text not null,
  reason      text,

  provider    text,
  -- Deliberately nullable and deliberately never populated by this
  -- migration: a checkout URL comes from a provider's own API and a
  -- fabricated one is a link that takes money nowhere.
  provider_reference text,
  checkout_url text,

  requested_by uuid references auth.users(id),
  requested_at timestamptz not null default now(),
  client_operation_id text not null,

  constraint ns_payment_requests_state_known check (
    state in ('unavailable', 'prepared')),
  constraint ns_payment_requests_unavailable_explained check (
    state <> 'unavailable' or coalesce(btrim(reason), '') <> ''),
  -- An unavailable request binds no money. A prepared one binds all three.
  constraint ns_payment_requests_unavailable_binds_nothing check (
    state <> 'unavailable'
      or (amount is null and currency is null and checkout_url is null)),
  constraint ns_payment_requests_prepared_binds_amount check (
    state <> 'prepared'
      or (amount is not null and currency is not null and provider is not null)),
  constraint ns_payment_requests_amount_positive check (
    amount is null or amount > 0),
  constraint ns_payment_requests_client_id_not_blank
    check (btrim(client_operation_id) <> '')
);

create unique index if not exists ns_payment_requests_client_id_key
  on public.ns_payment_requests (client_operation_id);

create index if not exists ns_payment_requests_job_idx
  on public.ns_payment_requests (job_id, requested_at desc);

comment on table public.ns_payment_requests is
  'An intent to ask for money, bound to an approved commercial record. '
  'Never a payment and never a receipt: opening a link is not paying, and '
  'nothing in this system can mark anything paid.';

/** Prepare a payment request for a job's approved work.
 *
 *  OWNER-ONLY, and it refuses in three cases before it binds anything:
 *   * no payment provider is selected          -> unavailable
 *   * no accepted quote                        -> unavailable
 *   * no settlement model, so no balance        -> unavailable
 *  All three are RECEIPTS rather than exceptions, because the owner needs
 *  to read them on the screen and because "unavailable" is the honest
 *  state of this feature today.
 *
 *  WHAT A `prepared` REQUEST IS NOT, in the words that matter:
 *   * it is not a payment. Nothing here can mark an invoice paid, and a
 *     browser redirect certainly cannot -- only a provider-verified,
 *     server-side confirmation could, and that work is listed in the
 *     contract as outstanding.
 *   * it is not a checkout. `checkout_url` stays null: a URL comes from the
 *     provider's API, and a fabricated one is worse than none.
 *   * it changes no quote, no total, no tax, no minimum, no grant and no
 *     status. This file touches none of those tables.
 *
 *  SAME-KEY RECOVERY and CHANGED-INTENT REFUSAL come from the shared
 *  handover guard, so a retry replays and a different amount under the same
 *  key is refused rather than silently re-bound. */
create or replace function public.create_payment_request(
  p_client_operation_id text,
  p_job_id              uuid,
  p_expected_amount     numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_print    text;
  v_replay   jsonb;
  v_bal      jsonb;
  v_provider text;
  v_amount   numeric;
  v_currency text;
  v_quote    uuid;
  v_state    text;
  v_reason   text;
  v_id       uuid;
  v_receipt  jsonb;
begin
  if not public.is_owner() then
    raise exception 'Only the owner asks a customer for money'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;
  if not exists (select 1 from public.ns_jobs where id = p_job_id) then
    raise exception 'No such job %', p_job_id using errcode = 'no_data_found';
  end if;

  v_bal := public.ns_payment_balance(p_job_id);
  v_provider := public.ns_payment_provider();
  v_currency := nullif(v_bal ->> 'currency', '');
  v_quote := nullif(v_bal -> 'commercials' -> 'accepted_quote' ->> 'quote_id', '')::uuid;

  /* THE AMOUNT IS THE REMAINING BALANCE, not the approved total. When the
     balance is not established there is no amount to bind at all, which is
     the whole reason this feature is unavailable today. */
  v_amount := nullif(v_bal ->> 'remaining_balance', '')::numeric;

  if v_provider is null then
    v_state := 'unavailable';
    v_reason := 'No payment provider is selected, so there is nothing to '
                'create a payment with. Choose one in Settings '
                '(payments.provider).';
  elsif (v_bal ->> 'balance_state') = 'no_accepted_quote' then
    v_state := 'unavailable';
    v_reason := 'This job has no accepted quote, so there is no agreed '
                'amount to ask for.';
  elsif (v_bal ->> 'balance_state') = 'no_settlement_model' then
    v_state := 'unavailable';
    v_reason := v_bal ->> 'missing_dependency';
  elsif v_amount is null or v_amount <= 0 then
    v_state := 'unavailable';
    v_reason := 'There is nothing outstanding on this job.';
  elsif v_currency is null then
    v_state := 'unavailable';
    v_reason := 'The currency is not configured, and a figure without one '
                'is not an amount. Set it on the quote or in Quote '
                'defaults.';
  else
    v_state := 'prepared';
  end if;

  /* THE CALLER'S EXPECTATION, checked against ours -- the same shape as
     10.1's confirmation lock. An owner who was shown $420 and whose screen
     is now stale must not quietly ask for $980. */
  if v_state = 'prepared' and p_expected_amount is not null
     and p_expected_amount <> v_amount then
    raise exception
      'The amount changed after you looked at it: you were shown %, the '
      'authoritative figure is now %. Re-read the job and try again.',
      p_expected_amount, v_amount
      using errcode = 'check_violation';
  end if;

  v_print := public.ns_load_intent_fingerprint(jsonb_build_object(
    'job_id', p_job_id,
    -- The BOUND AMOUNT is part of the intent, so the same key with a
    -- different figure is a different request wearing the same name.
    'amount', v_amount, 'currency', v_currency));
  v_replay := public.ns_handover_replay_guard(
    p_client_operation_id, 'payment_request', p_job_id, v_print);
  if v_replay is not null then return v_replay; end if;

  insert into public.ns_payment_requests
    (job_id, quote_id, amount, currency, balance_state, state, reason,
     provider, requested_by, client_operation_id)
  values
    (p_job_id, v_quote,
     case when v_state = 'prepared' then v_amount else null end,
     case when v_state = 'prepared' then v_currency else null end,
     v_bal ->> 'balance_state', v_state, v_reason,
     case when v_state = 'prepared' then v_provider else null end,
     auth.uid(), p_client_operation_id)
  returning id into v_id;

  v_receipt := jsonb_build_object(
    'payment_request_id', v_id,
    'job_id',             p_job_id,
    'quote_id',           v_quote,
    'state',              v_state,
    'reason',             v_reason,
    'amount',             case when v_state = 'prepared' then v_amount else null end,
    'currency',           case when v_state = 'prepared' then v_currency else null end,
    'balance_state',      v_bal ->> 'balance_state',
    'provider',           case when v_state = 'prepared' then v_provider else null end,
    'provider_configured', v_provider is not null,
    'checkout_url',       null,
    -- The three sentences a screen must not be allowed to soften.
    'paid',               false,
    'is_payment',         false,
    'note',               'Preparing or opening a payment request is not '
                          'payment. Nothing in this system can mark work '
                          'paid.',
    'replayed',           false);

  insert into public.ns_handover_operations
    (client_operation_id, kind, scope_id, intent_fingerprint, actor_id, receipt)
  values
    (p_client_operation_id, 'payment_request', p_job_id, v_print,
     auth.uid(), v_receipt);

  return v_receipt;
end
$$;

/** Everything the owner's screen needs to render the payment boundary,
 *  including the reasons it is unavailable. Read-only. */
create or replace function public.job_payment_state(p_job_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'job_payment_state is admin-only'
      using errcode = 'insufficient_privilege';
  end if;
  if not public.ns_can_work_job(p_job_id) then
    raise exception 'That job is not on your vehicle'
      using errcode = 'insufficient_privilege';
  end if;

  return public.ns_payment_balance(p_job_id) || jsonb_build_object(
    'provider',           public.ns_payment_provider(),
    'provider_configured', public.ns_payment_provider() is not null,
    'feature_state', case
      when public.ns_payment_provider() is null then 'unavailable'
      when (public.ns_payment_balance(p_job_id) ->> 'balance_state')
             <> 'established' then 'unavailable'
      else 'available' end,
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
               'payment_request_id', r.id,
               'state',    r.state,
               'reason',   r.reason,
               'amount',   r.amount,
               'currency', r.currency,
               'provider', r.provider,
               'requested_at', r.requested_at,
               'paid',     false)
             order by r.requested_at desc)
        from public.ns_payment_requests r where r.job_id = p_job_id),
      '[]'::jsonb),
    -- What a real implementation still owes, carried in the data rather
    -- than only in a document, so nobody wires a provider and calls it
    -- done.
    'remaining_provider_work', jsonb_build_array(
      'a settlement model: what was invoiced, what was received, and when',
      'server-side verification of the provider''s own confirmation '
      '(signed webhook or an authoritative API read) -- never a browser '
      'redirect',
      'idempotent reconciliation from the provider''s reference back to '
      'the approved commercial record',
      'refund, chargeback and partial-payment semantics',
      'the fee and tax treatment of a provider''s charges, which this '
      'system does not model'));
end
$$;

/* ===================================================================== */
/* 4. grants                                                              */
/* ===================================================================== */

do $$
begin
  execute 'revoke all on public.ns_payment_requests from anon';
  execute 'revoke all on public.ns_payment_requests from authenticated';
  execute 'grant select on public.ns_payment_requests to authenticated';
  execute 'grant all on public.ns_payment_requests to service_role';
end
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'public.ns_payment_provider()',
    'public.ns_payment_balance(uuid)',
    'public.create_payment_request(text,uuid,numeric)',
    'public.job_payment_state(uuid)']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('grant execute on function %s to authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end
$$;

/* ===================================================================== */
/* 5. assertions                                                          */
/* ===================================================================== */

do $$
begin
  if has_function_privilege('anon',
       'public.create_payment_request(text,uuid,numeric)', 'execute') then
    raise exception 'anon can create a payment request';
  end if;
  if has_table_privilege('anon', 'public.ns_payment_requests', 'select') then
    raise exception 'anon can select ns_payment_requests';
  end if;

  -- THE DEPENDENCY, asserted rather than only described: if a settlement
  -- model ever appears, it must be a deliberate batch that also revisits
  -- this file's refusals. A table called ns_payments showing up without
  -- that work should be noticed here.
  if to_regclass('public.ns_payments') is not null then
    raise warning
      'public.ns_payments now exists. ns_payment_balance will bind to it; '
      'check create_payment_request''s refusals and the contract''s '
      'provider-work list before relying on a remaining balance.';
  end if;

  -- Nothing in this batch may have moved quote pricing or statuses. The
  -- cheap structural proof: the three columns a demo checkout would have
  -- been tempted to add are not there.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ns_quotes'
       and column_name in ('paid', 'paid_at', 'payment_status')) then
    raise exception
      'ns_quotes grew a payment status. Batch 13.1 does not alter quote '
      'pricing or statuses to make a checkout look successful.';
  end if;
end
$$;
