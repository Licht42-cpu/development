-- ===========================================================================
-- Batch 13.1 (2 of 4): how a customer reads their own document, and nothing
-- else.
--
-- THE MECHANISM, CHOSEN AND STATED. A cryptographically random capability,
-- stored only as a SHA-256 hash, with a server-checked scope, a required
-- expiry and a revocation that takes effect on the next read. Not a customer
-- login (there is no customer auth in this project and inventing one is a
-- platform, not a batch), and not an email or customer-id match, which is a
-- guess dressed as authorisation.
--
-- WHERE THE RANDOMNESS COMES FROM, and why no extension is needed:
-- `gen_random_uuid()` is PostgreSQL's own, backed by pg_strong_random, and
-- two of them give 244 bits. pgcrypto is NOT assumed to be installed on the
-- live project -- nothing in this repository's migrations uses it -- so a
-- token built from `gen_random_bytes` would be a deployment surprise.
-- `sha256()` is built in since PostgreSQL 11.
--
-- THE SCOPE RULE THAT MATTERS. A forwarded link must not become a filing
-- cabinet. A `report` grant resolves exactly one report. A
-- `customer_collection` grant resolves that customer's published reports --
-- and it exists only because an owner deliberately issued one, naming the
-- customer. There is no path from a single-report token to the collection.
--
-- WHAT IS NOT HERE. No anon table or storage read, no privileged key in the
-- browser, no raw token in any log or audit row, no internal row returned
-- for the client to filter, and no public bucket. Files stay private: an
-- authorised reader gets a short-lived TICKET, and only a service-role
-- worker can exchange it for a signed URL (§5, and that worker's absence is
-- a stated gap, not a quiet assumption).
--
-- NOT APPLIED ANYWHERE. Twenty-sixth pending migration.
-- ===========================================================================

/* ===================================================================== */
/* 1. the grant                                                           */
/* ===================================================================== */

create table if not exists public.ns_customer_grants (
  id            uuid primary key default gen_random_uuid(),

  -- WHOSE documents. Always set, including for a single-report grant, so
  -- every read can be checked against the document's own customer and a
  -- grant can never drift onto another customer's report.
  customer_id   uuid not null references public.customers(id) on delete cascade,

  -- 'report'              exactly one report.
  -- 'customer_collection' this customer's published reports. Owner-issued,
  --                       deliberately, never inferred.
  scope         text not null,
  report_id     uuid references public.ns_completion_reports(id) on delete restrict,

  /* ---- THE SECRET IS NOT HERE. Only its hash and a short prefix. ---- */
  -- sha256 of the token, hex. The token itself is returned exactly once,
  -- by the issuing call, and is never stored, logged or recoverable.
  token_hash    text not null,
  -- The first 8 characters, so support can say "the link ending 3f9a2b11"
  -- and an audit row can name WHICH link was used without holding one.
  token_prefix  text not null,

  label         text,

  issued_by     uuid references auth.users(id),
  issued_at     timestamptz not null default now(),

  -- REQUIRED. A capability with no expiry is a permanent credential in
  -- somebody's inbox. There is no invented default: see
  -- ns_customer_link_expiry_days().
  expires_at    timestamptz not null,

  revoked_at    timestamptz,
  revoked_by    uuid references auth.users(id),
  revoked_reason text,

  client_operation_id text not null,

  constraint ns_customer_grants_scope_known check (
    scope in ('report', 'customer_collection')),
  -- The shape of the scope is a database rule, not a convention: a
  -- collection grant carrying a report id, or a report grant without one,
  -- would make "what does this link open" ambiguous.
  constraint ns_customer_grants_report_pairs check (
    (scope = 'report') = (report_id is not null)),
  constraint ns_customer_grants_hash_shape check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint ns_customer_grants_prefix_shape check (token_prefix ~ '^[0-9a-f]{8}$'),
  constraint ns_customer_grants_expiry_after_issue check (expires_at > issued_at),
  constraint ns_customer_grants_revoked_pairs check (
    (revoked_at is null) = (revoked_reason is null)),
  constraint ns_customer_grants_client_id_not_blank
    check (btrim(client_operation_id) <> '')
);

create unique index if not exists ns_customer_grants_token_key
  on public.ns_customer_grants (token_hash);

create unique index if not exists ns_customer_grants_client_id_key
  on public.ns_customer_grants (client_operation_id);

create index if not exists ns_customer_grants_customer_idx
  on public.ns_customer_grants (customer_id, scope);

comment on table public.ns_customer_grants is
  'A capability a customer holds. The token is stored as a sha256 hash and '
  'nowhere else; scope, expiry and revocation are checked on the server on '
  'every read. A report grant opens one report, never a customer''s '
  'collection.';

/* ---------------------------------------------- the read audit, hashless */

-- WHY THIS EXISTS. "Who opened the report, and when" is a real question
-- when a customer says they never got it. WHY IT HOLDS NO TOKEN: an audit
-- log is read by more people than the table it audits, and a log of bearer
-- tokens is a log of working credentials. The grant id and its prefix are
-- enough to answer the question.
create table if not exists public.ns_customer_grant_reads (
  id          bigserial primary key,
  grant_id    uuid references public.ns_customer_grants(id) on delete set null,
  token_prefix text,
  read_at     timestamptz not null default now(),
  -- What the caller asked for and what it got. An `unknown` outcome has no
  -- grant_id by definition -- somebody presented a token we have never
  -- issued -- and is recorded so a sweep of guesses is visible.
  requested   text not null,
  outcome     text not null,

  constraint ns_customer_grant_reads_outcome_known check (outcome in (
    'ok', 'expired', 'revoked', 'unknown', 'out_of_scope', 'not_found',
    'superseded', 'unpublished'))
);

create index if not exists ns_customer_grant_reads_grant_idx
  on public.ns_customer_grant_reads (grant_id, read_at desc);

comment on table public.ns_customer_grant_reads is
  'One row per customer read attempt. Deliberately holds no token: the '
  'grant id and an 8-character prefix answer "which link was used" without '
  'storing a working credential.';

/* ===================================================================== */
/* 2. the expiry policy is the owner's                                    */
/* ===================================================================== */

/** How long a customer link lasts, in days, from settings -- or null.
 *
 *  NULL IS NOT "FOREVER" AND NOT "THIRTY DAYS". It means the owner has not
 *  set a policy, and in that case the issuing calls REFUSE to guess: they
 *  demand an explicit expiry per link. How long a customer can reach their
 *  own paperwork is a business decision with a real cost either way
 *  (support calls vs. a live link in a forwarded email), and picking 30
 *  days here would bury that decision in a migration. */
create or replace function public.ns_customer_link_expiry_days()
returns integer
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
      select nullif(btrim(coalesce(value::jsonb ->> 'link_expiry_days', '')), '')
        from public.app_settings where key = 'customer_portal' limit 1
    $q$ into v;
  exception when others then
    return null;
  end;
  if v is null or v !~ '^[0-9]+$' or v::integer <= 0 then return null; end if;
  return v::integer;
end
$$;

/** A new capability: 244 bits, from PostgreSQL's own strong RNG. Returned
 *  to the issuer and never stored. */
create or replace function public.ns_new_capability_token()
returns text
language sql
volatile
as $$
  select replace(gen_random_uuid()::text, '-', '')
      || replace(gen_random_uuid()::text, '-', '');
$$;

/** The hash the grant row holds. One function, so the issuing path and the
 *  reading path cannot drift into hashing differently. */
create or replace function public.ns_capability_hash(p_token text)
returns text
language sql
immutable
as $$
  select encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
$$;

/* ===================================================================== */
/* 3. issuing and revoking                                                */
/* ===================================================================== */

/** Issue a customer capability. OWNER-ONLY.
 *
 *  A crew cannot mint one: a link is the customer's view of what we say we
 *  did, and who gets one is the owner's decision in the same way pricing
 *  and publication are.
 *
 *  Two scopes, one function, because the refusals are the same and the
 *  difference is a single column -- but the CALLER has to say which, by
 *  passing a report or a customer, never both:
 *
 *    scope 'report'              p_report_id, and the report must be
 *                                published. An unpublished draft has no
 *                                customer link, so a draft cannot leak
 *                                through a link issued early.
 *    scope 'customer_collection' p_customer_id. THE DELIBERATE BROAD
 *                                GRANT. It is never derived from a
 *                                customer's email, their name, or a
 *                                forwarded report token.
 *
 *  THE TOKEN IS IN THE RECEIPT, ONCE. It is not stored, cannot be read
 *  back, and is not written to ns_handover_operations -- the replay receipt
 *  deliberately omits it, so a retry under the same key gets the grant's
 *  identity and NOT the secret. A lost token is re-issued as a new grant;
 *  that is the cost of not keeping a copy. */
create or replace function public.issue_customer_grant(
  p_client_operation_id text,
  p_scope               text,
  p_report_id           uuid default null,
  p_customer_id         uuid default null,
  p_expires_at          timestamptz default null,
  p_label               text default null
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
  v_cust    uuid;
  v_days    integer;
  v_expires timestamptz;
  v_token   text;
  v_id      uuid;
  v_receipt jsonb;
begin
  if not public.is_owner() then
    raise exception
      'Only the owner issues a customer link. A crew minting customer '
      'access is what this prevents.'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_scope not in ('report', 'customer_collection') then
    raise exception 'scope is report or customer_collection, not %', p_scope
      using errcode = 'invalid_parameter_value';
  end if;

  if p_scope = 'report' then
    if p_report_id is null then
      raise exception 'A report grant needs a report'
        using errcode = 'invalid_parameter_value';
    end if;
    select * into v_r from public.ns_completion_reports where id = p_report_id;
    if not found then
      raise exception 'No such report %', p_report_id
        using errcode = 'no_data_found';
    end if;
    if v_r.publication_state <> 'published' then
      raise exception
        'Report v% is %, so it has no customer link yet. Publish it first.',
        v_r.report_version, v_r.publication_state
        using errcode = 'check_violation';
    end if;
    select j.customer_id into v_cust
      from public.ns_jobs j where j.id = v_r.job_id;
    if p_customer_id is not null and p_customer_id <> v_cust then
      raise exception
        'That report belongs to another customer. A grant is never issued '
        'against a customer who is not the document''s own.'
        using errcode = 'invalid_parameter_value';
    end if;
  else
    if p_customer_id is null then
      raise exception
        'A collection grant needs the customer it is for. It is never '
        'inferred from a report token or an email address.'
        using errcode = 'invalid_parameter_value';
    end if;
    if p_report_id is not null then
      raise exception
        'A collection grant does not name a report. Issue a report grant '
        'if one document is what the customer should get.'
        using errcode = 'invalid_parameter_value';
    end if;
    if not exists (select 1 from public.customers where id = p_customer_id) then
      raise exception 'No such customer %', p_customer_id
        using errcode = 'no_data_found';
    end if;
    v_cust := p_customer_id;
  end if;

  /* THE EXPIRY, explicit or from the owner's policy, never guessed. */
  v_days := public.ns_customer_link_expiry_days();
  v_expires := p_expires_at;
  if v_expires is null then
    if v_days is null then
      raise exception
        'This link needs an expiry. There is no default: set '
        'customer_portal.link_expiry_days in Settings, or pass one with '
        'this call.'
        using errcode = 'invalid_parameter_value';
    end if;
    v_expires := now() + make_interval(days => v_days);
  end if;
  if v_expires <= now() then
    raise exception 'That expiry is in the past, so the link would open nothing'
      using errcode = 'invalid_parameter_value';
  end if;

  v_print := public.ns_load_intent_fingerprint(jsonb_build_object(
    'scope', p_scope, 'report_id', p_report_id, 'customer_id', v_cust));
  v_replay := public.ns_handover_replay_guard(
    p_client_operation_id, 'grant_issue',
    coalesce(p_report_id, v_cust), v_print);
  if v_replay is not null then
    -- Deliberately WITHOUT a token: we do not keep one, so a replay cannot
    -- hand one back. The caller is told why rather than finding a null.
    return v_replay || jsonb_build_object(
      'token', null,
      'token_state', 'not_recoverable',
      'note', 'The link was already issued under this key. The token is '
              'shown once and is not stored; issue a new grant if it was '
              'lost.');
  end if;

  v_token := public.ns_new_capability_token();

  insert into public.ns_customer_grants
    (customer_id, scope, report_id, token_hash, token_prefix, label,
     issued_by, expires_at, client_operation_id)
  values
    (v_cust, p_scope, p_report_id,
     public.ns_capability_hash(v_token), left(v_token, 8),
     nullif(btrim(coalesce(p_label, '')), ''), auth.uid(), v_expires,
     p_client_operation_id)
  returning id into v_id;

  -- The receipt STORED in the ledger. No token, by construction.
  v_receipt := jsonb_build_object(
    'grant_id',     v_id,
    'scope',        p_scope,
    'report_id',    p_report_id,
    'customer_id',  v_cust,
    'token_prefix', left(v_token, 8),
    'expires_at',   v_expires,
    'expiry_source', case when p_expires_at is not null then 'explicit'
                          else 'settings_policy' end,
    'replayed',     false,
    'delivered',    false);

  insert into public.ns_handover_operations
    (client_operation_id, kind, scope_id, intent_fingerprint, actor_id, receipt)
  values
    (p_client_operation_id, 'grant_issue', coalesce(p_report_id, v_cust),
     v_print, auth.uid(), v_receipt);

  -- The token is added to what is RETURNED, and only to that.
  return v_receipt || jsonb_build_object(
    'token', v_token, 'token_state', 'shown_once');
end
$$;

/** Revoke a grant. Owner-only, reasoned, replay-safe.
 *
 *  WHAT REVOCATION DOES AND DOES NOT DO, stated here because claiming more
 *  than this would be the lie:
 *
 *   * it stops every further read through this capability, immediately, and
 *   * it stops any new document ticket and therefore any new signed URL,
 *   * it does NOT reach inside a signed URL a reader already holds. That
 *     URL stays valid for the remainder of its own short lifetime (§5), and
 *     the contract states that residual rather than promising an instant
 *     cut-off a signed URL cannot give.
 *   * it does not delete the report. What was issued stays on record. */
create or replace function public.revoke_customer_grant(
  p_client_operation_id text,
  p_grant_id            uuid,
  p_reason              text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_print   text;
  v_replay  jsonb;
  v_g       public.ns_customer_grants;
  v_receipt jsonb;
begin
  if not public.is_owner() then
    raise exception 'Only the owner revokes a customer link'
      using errcode = 'insufficient_privilege';
  end if;
  if coalesce(btrim(p_client_operation_id), '') = '' then
    raise exception 'client_operation_id is required for replay safety'
      using errcode = 'invalid_parameter_value';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'Say why it is revoked'
      using errcode = 'invalid_parameter_value';
  end if;

  select * into v_g from public.ns_customer_grants
   where id = p_grant_id for update;
  if not found then
    raise exception 'No such grant %', p_grant_id using errcode = 'no_data_found';
  end if;

  v_print := public.ns_load_intent_fingerprint(
    jsonb_build_object('grant_id', p_grant_id));
  v_replay := public.ns_handover_replay_guard(
    p_client_operation_id, 'grant_revoke', p_grant_id, v_print);
  if v_replay is not null then return v_replay; end if;

  if v_g.revoked_at is null then
    update public.ns_customer_grants
       set revoked_at = now(), revoked_by = auth.uid(),
           revoked_reason = btrim(p_reason)
     where id = p_grant_id;
  end if;

  v_receipt := jsonb_build_object(
    'grant_id',   p_grant_id,
    'revoked_at', coalesce(v_g.revoked_at, now()),
    'no_op',      v_g.revoked_at is not null,
    'replayed',   false,
    -- The honest residual, on the receipt itself.
    'stops_new_reads', true,
    'stops_new_document_tickets', true,
    'already_issued_signed_urls',
      'remain valid for the rest of their own lifetime');

  insert into public.ns_handover_operations
    (client_operation_id, kind, scope_id, intent_fingerprint, actor_id, receipt)
  values
    (p_client_operation_id, 'grant_revoke', p_grant_id, v_print,
     auth.uid(), v_receipt);

  return v_receipt;
end
$$;

/* ===================================================================== */
/* 4. the customer's read                                                 */
/* ===================================================================== */

/** Resolve a presented token to a grant and a state. INTERNAL -- not
 *  granted to anon, because it answers questions about a grant and the
 *  customer-facing functions are the only callers that are allowed to.
 *
 *  Five states, and `unknown` is deliberately indistinguishable from a
 *  token for another customer: a guesser learns only that its guess did
 *  not work. */
create or replace function public.ns_resolve_customer_grant(p_token text)
returns table (
  grant_id     uuid,
  customer_id  uuid,
  scope        text,
  report_id    uuid,
  token_prefix text,
  state        text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select g.id, g.customer_id, g.scope, g.report_id, g.token_prefix,
         case when g.revoked_at is not null then 'revoked'
              when g.expires_at <= now()   then 'expired'
              else 'valid' end
    from public.ns_customer_grants g
   where g.token_hash = public.ns_capability_hash(p_token);
$$;

/** THE CUSTOMER'S READ. Anon-callable, by design -- the capability IS the
 *  authorisation, exactly as the existing get_customer_quote treats a quote
 *  id, and the Batch 7.1 inventory's deliberate-anon list is where this
 *  belongs too.
 *
 *  IT NEVER RAISES FOR A BAD TOKEN. An expired, revoked, unknown or
 *  out-of-scope capability returns a typed envelope with a `state`, because
 *  a page has to show "this link has expired" rather than a stack trace,
 *  and because a raise and a return are distinguishable from the outside in
 *  a way that tells a guesser which tokens exist.
 *
 *  It returns the FROZEN document, not a fresh projection: what the
 *  customer reads is what was issued. A corrected report is a different
 *  row with a different link, and this one says `superseded` so the reader
 *  knows to ask for the current one. */
create or replace function public.get_customer_report(
  p_token     text,
  p_report_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_g       record;
  v_r       public.ns_completion_reports;
  v_outcome text;
begin
  if coalesce(btrim(coalesce(p_token, '')), '') = '' then
    -- Nothing to look up and nothing to log against: no grant, no prefix.
    return jsonb_build_object('state', 'unknown',
      'message', 'This link is missing its reference.');
  end if;

  /* FOUND, not `v_g.grant_id is null`: a `record` variable that a
     zero-row SELECT INTO never assigned raises on field access rather
     than reading as null, so an unknown token would be a crash instead
     of an answer. */
  select * into v_g from public.ns_resolve_customer_grant(p_token);

  if not found then
    insert into public.ns_customer_grant_reads (requested, outcome)
      values ('report', 'unknown');
    return jsonb_build_object('state', 'unknown',
      'message', 'This link is not valid. It may have been replaced -- '
                 'please get in touch and we will send a fresh one.');
  end if;

  if v_g.state <> 'valid' then
    insert into public.ns_customer_grant_reads
      (grant_id, token_prefix, requested, outcome)
      values (v_g.grant_id, v_g.token_prefix, 'report', v_g.state);
    return jsonb_build_object('state', v_g.state,
      'message', case v_g.state
        when 'expired' then 'This link has expired. Get in touch and we '
                            'will send a fresh one.'
        else 'This link has been withdrawn. Please get in touch.' end);
  end if;

  /* WHICH REPORT. A report grant resolves its own and ignores a supplied
     id unless it matches -- so a forwarded single-report token cannot be
     pointed at another document by editing the URL. A collection grant
     needs one, and it must belong to that customer. */
  if v_g.scope = 'report' then
    if p_report_id is not null and p_report_id <> v_g.report_id then
      insert into public.ns_customer_grant_reads
        (grant_id, token_prefix, requested, outcome)
        values (v_g.grant_id, v_g.token_prefix, 'report', 'out_of_scope');
      return jsonb_build_object('state', 'out_of_scope',
        'message', 'This link opens one report, and that is not it.');
    end if;
    select * into v_r from public.ns_completion_reports where id = v_g.report_id;
  else
    if p_report_id is null then
      insert into public.ns_customer_grant_reads
        (grant_id, token_prefix, requested, outcome)
        values (v_g.grant_id, v_g.token_prefix, 'collection', 'ok');
      return public.list_customer_documents(p_token);
    end if;
    select * into v_r from public.ns_completion_reports where id = p_report_id;
    -- THE CROSS-CUSTOMER CHECK, on the document's own job, not on the
    -- caller's claim about it.
    if v_r.id is not null and not exists (
         select 1 from public.ns_jobs j
          where j.id = v_r.job_id and j.customer_id = v_g.customer_id) then
      insert into public.ns_customer_grant_reads
        (grant_id, token_prefix, requested, outcome)
        values (v_g.grant_id, v_g.token_prefix, 'report', 'out_of_scope');
      -- Same words as "not found": a reader must not be able to tell
      -- another customer's real report from a made-up id.
      return jsonb_build_object('state', 'not_found',
        'message', 'That report is not available on this link.');
    end if;
  end if;

  if v_r.id is null then
    insert into public.ns_customer_grant_reads
      (grant_id, token_prefix, requested, outcome)
      values (v_g.grant_id, v_g.token_prefix, 'report', 'not_found');
    return jsonb_build_object('state', 'not_found',
      'message', 'That report is not available on this link.');
  end if;

  -- A draft is not a customer document, even behind a valid grant.
  if v_r.publication_state = 'draft' then
    insert into public.ns_customer_grant_reads
      (grant_id, token_prefix, requested, outcome)
      values (v_g.grant_id, v_g.token_prefix, 'report', 'unpublished');
    return jsonb_build_object('state', 'unavailable',
      'message', 'This report is not ready yet. We will let you know when '
                 'it is.');
  end if;

  v_outcome := case when v_r.publication_state = 'superseded'
                    then 'superseded' else 'ok' end;

  insert into public.ns_customer_grant_reads
    (grant_id, token_prefix, requested, outcome)
    values (v_g.grant_id, v_g.token_prefix, 'report', v_outcome);

  return jsonb_build_object(
    'state',          v_outcome,
    'message',        case when v_outcome = 'superseded'
                           then 'We have since issued a corrected version '
                                'of this report. Please get in touch for '
                                'the latest one.'
                           else null end,
    'report_id',      v_r.id,
    'report_version', v_r.report_version,
    'issued_at',      v_r.published_at,
    -- THE FROZEN DOCUMENT. Not re-projected at read time.
    'document',       v_r.document,
    -- What the reader may fetch, by evidence id. No storage path, ever:
    -- a path is a guessable credential and §5 hands out tickets instead.
    'documents',      coalesce((
        select jsonb_agg(jsonb_build_object(
                 'evidence_id', e ->> 'evidence_id',
                 'caption',     e ->> 'caption',
                 'requirement', e ->> 'requirement')
               order by ordinality)
          from jsonb_array_elements(v_r.document -> 'evidence')
               with ordinality as t(e, ordinality)), '[]'::jsonb));
end
$$;

/** The collection read. Only ever reachable with a collection grant: a
 *  report token calling this gets its own one document and nothing else,
 *  which is the forwarded-link rule in code rather than in a comment. */
create or replace function public.list_customer_documents(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_g record;
begin
  select * into v_g from public.ns_resolve_customer_grant(p_token);
  if not found then
    return jsonb_build_object('state', 'unknown', 'documents', '[]'::jsonb);
  end if;
  if v_g.state <> 'valid' then
    return jsonb_build_object('state', v_g.state, 'documents', '[]'::jsonb);
  end if;

  if v_g.scope = 'report' then
    return jsonb_build_object(
      'state', 'ok',
      'scope', 'report',
      'documents', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'report_id', r.id, 'report_version', r.report_version,
                 'issued_at', r.published_at,
                 'state', r.publication_state)
               order by r.report_version desc)
          from public.ns_completion_reports r
         where r.id = v_g.report_id
           and r.publication_state in ('published', 'superseded')),
        '[]'::jsonb));
  end if;

  return jsonb_build_object(
    'state', 'ok',
    'scope', 'customer_collection',
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object(
               'report_id', r.id, 'report_version', r.report_version,
               'issued_at', r.published_at,
               'state', r.publication_state)
             order by r.published_at desc nulls last, r.report_version desc)
        from public.ns_completion_reports r
        join public.ns_jobs j on j.id = r.job_id
       where j.customer_id = v_g.customer_id
         -- PUBLISHED ONLY. A collection grant is not a window on drafts.
         and r.publication_state in ('published', 'superseded')),
      '[]'::jsonb));
end
$$;

/* ===================================================================== */
/* 5. files: a ticket, not a path                                         */
/* ===================================================================== */

-- WHY A TICKET. Signing a Storage URL needs the service role, which must
-- never be in a browser, and SQL cannot sign one. The customer-facing call
-- therefore does the AUTHORISATION -- is this capability valid, does it
-- cover this report, was this picture explicitly published -- and hands
-- back a single-use, short-lived ticket. A service-role worker exchanges
-- the ticket for a signed URL.
--
-- THE WORKER DOES NOT EXIST IN THIS REPOSITORY. There is no Edge Function
-- source here (the same gap §3 of the delivery migration reports for
-- sending), so real signing is UNRUN and is named as such in the contract.
-- What is implemented and tested is the authorisation boundary and the
-- ticket's lifetime.
--
-- THE TTL IS A TECHNICAL BOUND, NOT A BUSINESS POLICY. 120 seconds is how
-- long a click-to-fetch round trip can reasonably take; it is not the
-- "how long may a customer keep their paperwork" decision, which is the
-- owner's and lives in customer_portal.link_expiry_days.
create table if not exists public.ns_document_access_tickets (
  id          uuid primary key default gen_random_uuid(),
  grant_id    uuid not null references public.ns_customer_grants(id) on delete cascade,
  report_id   uuid not null references public.ns_completion_reports(id) on delete cascade,
  evidence_id uuid not null references public.ns_job_evidence(id) on delete cascade,
  -- Resolved server-side from the evidence record. Never supplied by a
  -- caller: a caller that could name a path could name one it was not
  -- authorised for, which is the whole reason evidence is keyed by id.
  attachment_id uuid not null references public.job_attachments(id) on delete cascade,
  issued_at   timestamptz not null default now(),
  expires_at  timestamptz not null,
  redeemed_at timestamptz,

  constraint ns_document_access_tickets_window
    check (expires_at > issued_at)
);

create index if not exists ns_document_access_tickets_grant_idx
  on public.ns_document_access_tickets (grant_id, issued_at desc);

comment on table public.ns_document_access_tickets is
  'A single-use, short-lived authorisation to fetch one published evidence '
  'file. The customer-facing call issues it after checking the capability; '
  'only a service-role worker can exchange it for a signed URL.';

/** Ask for a published picture. Anon-callable with a capability, typed
 *  envelope, never raises for a bad token -- same contract as the report
 *  read.
 *
 *  Four things are checked, in this order, and the last one is the one a
 *  naive implementation forgets: the capability is valid, it covers this
 *  report, the report is a customer document, and the EVIDENCE WAS
 *  EXPLICITLY PUBLISHED. An attachment that proved the work is not a
 *  customer file. */
create or replace function public.request_customer_document(
  p_token       text,
  p_report_id   uuid,
  p_evidence_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_g    record;
  v_r    public.ns_completion_reports;
  v_att  uuid;
  v_id   uuid;
begin
  select * into v_g from public.ns_resolve_customer_grant(p_token);
  if not found then
    insert into public.ns_customer_grant_reads (requested, outcome)
      values ('document', 'unknown');
    return jsonb_build_object('state', 'unknown');
  end if;
  if v_g.state <> 'valid' then
    insert into public.ns_customer_grant_reads
      (grant_id, token_prefix, requested, outcome)
      values (v_g.grant_id, v_g.token_prefix, 'document', v_g.state);
    return jsonb_build_object('state', v_g.state);
  end if;

  select * into v_r from public.ns_completion_reports where id = p_report_id;
  if v_r.id is null
     or (v_g.scope = 'report' and v_r.id <> v_g.report_id)
     or (v_g.scope = 'customer_collection' and not exists (
           select 1 from public.ns_jobs j
            where j.id = v_r.job_id and j.customer_id = v_g.customer_id))
     or v_r.publication_state not in ('published', 'superseded') then
    insert into public.ns_customer_grant_reads
      (grant_id, token_prefix, requested, outcome)
      values (v_g.grant_id, v_g.token_prefix, 'document', 'out_of_scope');
    return jsonb_build_object('state', 'not_found');
  end if;

  /* THE PUBLICATION CHECK, against the FROZEN document rather than against
     the publication table as it stands today. The customer may fetch what
     their copy of the report lists -- no more, and no less if a decision
     changed after the document was issued. */
  if not exists (
    select 1 from jsonb_array_elements(v_r.document -> 'evidence') e
     where (e ->> 'evidence_id')::uuid = p_evidence_id) then
    insert into public.ns_customer_grant_reads
      (grant_id, token_prefix, requested, outcome)
      values (v_g.grant_id, v_g.token_prefix, 'document', 'unpublished');
    return jsonb_build_object('state', 'not_found');
  end if;

  select e.attachment_id into v_att
    from public.ns_job_evidence e where e.id = p_evidence_id;
  if v_att is null then
    -- The evidence row is gone but the frozen document still names it.
    -- "Missing file" is a state the customer's page shows; it is not an
    -- error and it is certainly not another customer's picture.
    insert into public.ns_customer_grant_reads
      (grant_id, token_prefix, requested, outcome)
      values (v_g.grant_id, v_g.token_prefix, 'document', 'not_found');
    return jsonb_build_object('state', 'file_missing');
  end if;

  insert into public.ns_document_access_tickets
    (grant_id, report_id, evidence_id, attachment_id, expires_at)
  values
    (v_g.grant_id, v_r.id, p_evidence_id, v_att,
     now() + interval '120 seconds')
  returning id into v_id;

  insert into public.ns_customer_grant_reads
    (grant_id, token_prefix, requested, outcome)
    values (v_g.grant_id, v_g.token_prefix, 'document', 'ok');

  return jsonb_build_object(
    'state',      'ok',
    'ticket_id',  v_id,
    'expires_at', now() + interval '120 seconds',
    -- Said out loud: this is not a URL and this is not a file.
    'signed_url', null,
    'signing_state', 'requires_worker',
    'note', 'Exchange this ticket for a time-limited download through the '
            'document worker. No public path is issued.');
end
$$;

/** The worker's side. SERVICE ROLE ONLY -- it returns a storage path, so
 *  `authenticated` must not have it either: an admin reading a file goes
 *  through the admin paths, not through a customer's ticket.
 *
 *  Single use and time-bounded: a redeemed or expired ticket is refused,
 *  and a ticket whose grant has since been revoked is refused too, which
 *  is what makes revocation stop NEW signatures. */
create or replace function public.redeem_document_ticket(p_ticket_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_t public.ns_document_access_tickets;
  v_g public.ns_customer_grants;
  v_path text;
begin
  select * into v_t from public.ns_document_access_tickets
   where id = p_ticket_id for update;
  if not found then
    return jsonb_build_object('state', 'unknown');
  end if;
  if v_t.redeemed_at is not null then
    return jsonb_build_object('state', 'already_redeemed');
  end if;
  if v_t.expires_at <= now() then
    return jsonb_build_object('state', 'expired');
  end if;

  select * into v_g from public.ns_customer_grants where id = v_t.grant_id;
  if v_g.revoked_at is not null then
    return jsonb_build_object('state', 'revoked');
  end if;
  if v_g.expires_at <= now() then
    return jsonb_build_object('state', 'expired');
  end if;

  /* THE FILE MIGHT NOT BE THERE. A blank or absent path is the honest
     "we have the record but not the object" case -- and it is the one that
     actually happens, because 11.1 freezes an accepted completion's
     evidence rows so they cannot be deleted while a report names them.
     The customer's page shows a missing picture; it never shows somebody
     else's. */
  select nullif(btrim(coalesce(a.storage_path, '')), '') into v_path
    from public.job_attachments a where a.id = v_t.attachment_id;
  if v_path is null then
    return jsonb_build_object('state', 'file_missing');
  end if;

  update public.ns_document_access_tickets
     set redeemed_at = now() where id = p_ticket_id;

  return jsonb_build_object(
    'state', 'ok',
    'storage_path', v_path,
    -- The bound the worker must not exceed when it signs. Stated here so
    -- the policy lives with the authorisation rather than in a worker
    -- somebody rewrites.
    'max_signed_seconds', 120);
end
$$;

/* ===================================================================== */
/* 6. the owner's view of who can see what                                */
/* ===================================================================== */

/** Grants for a report or a customer, with their state and their reads.
 *  No token and no hash: there is nothing here that could be replayed. */
create or replace function public.customer_grants(
  p_report_id   uuid default null,
  p_customer_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_owner() then
    raise exception
      'Customer links are the owner''s to see. A crew does not need the '
      'list of who can read what.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_report_id is null and p_customer_id is null then
    raise exception 'Name a report or a customer'
      using errcode = 'invalid_parameter_value';
  end if;

  return jsonb_build_object(
    'grants', coalesce((
      select jsonb_agg(jsonb_build_object(
               'grant_id',     g.id,
               'scope',        g.scope,
               'report_id',    g.report_id,
               'customer_id',  g.customer_id,
               'label',        g.label,
               'token_prefix', g.token_prefix,
               'issued_at',    g.issued_at,
               'expires_at',   g.expires_at,
               'revoked_at',   g.revoked_at,
               'revoked_reason', g.revoked_reason,
               'state',        case when g.revoked_at is not null then 'revoked'
                                    when g.expires_at <= now() then 'expired'
                                    else 'valid' end,
               'read_count',   (select count(*) from public.ns_customer_grant_reads rd
                                 where rd.grant_id = g.id and rd.outcome = 'ok'),
               'last_read_at', (select max(rd.read_at) from public.ns_customer_grant_reads rd
                                 where rd.grant_id = g.id))
             order by g.issued_at desc)
        from public.ns_customer_grants g
       where (p_report_id is null or g.report_id = p_report_id)
         and (p_customer_id is null or g.customer_id = p_customer_id)),
      '[]'::jsonb));
end
$$;

/* ===================================================================== */
/* 7. grants                                                              */
/* ===================================================================== */

do $$
declare t text;
begin
  foreach t in array array[
    'public.ns_customer_grants', 'public.ns_customer_grant_reads',
    'public.ns_document_access_tickets']
  loop
    execute format('revoke all on %s from anon', t);
    execute format('revoke all on %s from authenticated', t);
    execute format('grant all on %s to service_role', t);
  end loop;

  /* NO `authenticated` SELECT ON ns_customer_grants, deliberately -- unlike
     every other table this batch adds. It carries token hashes, and a hash
     plus a known token format is an offline guessing target. The owner's
     view is customer_grants(), which returns prefixes only.

     The other two get a read, because an admin screen shows who opened
     what and when. */
  execute 'grant select on public.ns_customer_grant_reads to authenticated';
  execute 'grant select on public.ns_document_access_tickets to authenticated';
end
$$;

do $$
declare f text;
begin
  -- Admin/owner surface: authenticated, never anon.
  foreach f in array array[
    'public.ns_customer_link_expiry_days()',
    'public.issue_customer_grant(text,text,uuid,uuid,timestamptz,text)',
    'public.revoke_customer_grant(text,uuid,text)',
    'public.customer_grants(uuid,uuid)']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('grant execute on function %s to authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;

  -- Internal: nobody but the definer-functions above and the service role.
  foreach f in array array[
    'public.ns_resolve_customer_grant(text)',
    'public.ns_new_capability_token()',
    'public.ns_capability_hash(text)']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('revoke all on function %s from anon', f);
    execute format('revoke all on function %s from authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;

  /* THE THREE DELIBERATELY ANON-CALLABLE FUNCTIONS. The capability is the
     authorisation; the session is nobody. This is the same deliberate
     decision the Batch 7.1 inventory records for get_customer_quote and
     respond_to_quote, and it is listed in the contract for the same
     reason. */
  foreach f in array array[
    'public.get_customer_report(text,uuid)',
    'public.list_customer_documents(text)',
    'public.request_customer_document(text,uuid,uuid)']
  loop
    execute format('revoke all on function %s from public', f);
    execute format('grant execute on function %s to anon', f);
    execute format('grant execute on function %s to authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;

  -- The worker only.
  execute 'revoke all on function public.redeem_document_ticket(uuid) from public';
  execute 'revoke all on function public.redeem_document_ticket(uuid) from anon';
  execute 'revoke all on function public.redeem_document_ticket(uuid) from authenticated';
  execute 'grant execute on function public.redeem_document_ticket(uuid) to service_role';
end
$$;

/* ===================================================================== */
/* 8. assertions                                                          */
/* ===================================================================== */

do $$
begin
  -- The token hashes must not be readable by a logged-in user.
  if has_table_privilege('authenticated', 'public.ns_customer_grants', 'select') then
    raise exception 'authenticated can select ns_customer_grants (token hashes)';
  end if;
  if has_table_privilege('anon', 'public.ns_customer_grants', 'select') then
    raise exception 'anon can select ns_customer_grants';
  end if;

  -- Issuing must not be reachable without a session.
  if has_function_privilege('anon',
       'public.issue_customer_grant(text,text,uuid,uuid,timestamptz,text)',
       'execute') then
    raise exception 'anon can issue customer grants';
  end if;

  -- The path-returning function must be the worker's alone.
  if has_function_privilege('authenticated',
       'public.redeem_document_ticket(uuid)', 'execute') then
    raise exception 'authenticated can redeem document tickets';
  end if;
  if has_function_privilege('anon',
       'public.redeem_document_ticket(uuid)', 'execute') then
    raise exception 'anon can redeem document tickets';
  end if;

  -- And the three customer reads must be reachable, or the page is dead.
  if not has_function_privilege('anon',
       'public.get_customer_report(text,uuid)', 'execute') then
    raise exception 'anon cannot read a customer report';
  end if;

  -- The existing deliberate anon access to the quote RPCs is NOT touched by
  -- this batch, and a regression there would be this file's fault to catch.
  if to_regprocedure('public.get_customer_quote(uuid)') is not null
     and not has_function_privilege('anon',
           'public.get_customer_quote(uuid)', 'execute') then
    raise exception
      'anon lost execute on get_customer_quote: the existing customer quote '
      'page is part of this batch''s compatibility promise.';
  end if;
end
$$;
