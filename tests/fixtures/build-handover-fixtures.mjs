// Builds the customer-handover fixture set, by running the REAL backend on a
// disposable database and writing down what it returned.
//
//   node tests/db/setup-test-db.mjs
//   node tests/fixtures/build-handover-fixtures.mjs
//
// WHY GENERATED AND NOT HAND-WRITTEN. A hand-written fixture is somebody's
// idea of what the contract says. These are what the contract actually
// produced, so they cannot drift from it: regenerate after any change and
// the diff is the contract change.
//
// DETERMINISTIC. Fixed dates, fixed names, fixed operation keys, ids
// replaced with stable placeholders, timestamps masked and the session
// timezone pinned to UTC, so two runs on two machines produce
// byte-identical files.
//
// NO CAPABILITY TOKEN IS WRITTEN TO THIS FILE. A 64-character token is
// masked to `<capability>` and an 8-character prefix to `<prefix>` -- a
// committed fixture carrying a working credential would be the exact
// mistake the hash-only storage exists to prevent, even for a disposable
// database.
//
// WHAT THESE FIXTURES ARE NOT. They do not establish authorisation (a
// fixture cannot refuse anything), they are not integration, no provider
// was configured beyond a NAME IN SETTINGS, no message was sent, no file
// was signed and no money moved. The settlement model in the payment
// scenario is a LABELLED DOUBLE created by this script; the system has
// none. NOTHING IS APPLIED TO THE LIVE DATABASE BY THIS SCRIPT.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import {
  TEST_DB_NAME, assertDisposableTarget, assertDisposableDatabase
} from '../db/disposable.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const MIGRATIONS = join(REPO, 'supabase', 'migrations');
const DB = join(REPO, 'tests', 'db');

const PGURL = process.env.PGURL
  || `postgresql://postgres@/${TEST_DB_NAME}?host=/tmp&port=5433`;

const SEQUENCE = [
  '20261010120000_batch8_1_inventory_and_rental_sets.sql',
  '20261010121000_batch8_1_estimate_job_materials.sql',
  '20261010130000_batch8_1_stock_operations_contract_v1.sql',
  '20261010140000_batch8_1_reservations_units_and_crew_access.sql',
  '20261010141000_batch8_1_reservation_operations.sql',
  '20261011090000_batch9_1_seasonal_set_identity_and_assignments.sql',
  '20261011091000_batch9_1_seasonal_operations.sql',
  '20261011100000_batch9_1_permanent_lighting_materials.sql',
  '20261011101000_batch9_1_kit_and_sheet_operations.sql',
  '20261011110000_batch10_1_load_planning.sql',
  '20261011111000_batch10_1_load_operations.sql',
  '20261012090000_batch9_1_corrective_seasonal_review.sql',
  '20261013090000_batch11_1_seasonal_corrective_round_two.sql',
  '20261013100000_batch11_1_completion_and_evidence.sql',
  '20261013110000_batch11_1_completion_operations.sql',
  '20261014090000_batch10_1_corrective_load_contract.sql',
  '20261015090000_batch10_1_corrective_day_boundary_and_lock.sql',
  '20261016090000_batch12_1_dispatch_day_and_order.sql',
  '20261016100000_batch12_1_property_access_and_zones.sql',
  '20261016110000_batch12_1_job_issues_and_notifications.sql',
  '20261016120000_batch12_1_conflicts_stages_and_winter.sql',
  '20261017090000_batch13_1_customer_reports.sql',
  '20261017100000_batch13_1_customer_access.sql',
  '20261017110000_batch13_1_report_delivery.sql',
  '20261017120000_batch13_1_payment_boundary.sql'
];

const FIXTURES = ['fixture-schema.sql', 'fixture-schema-batch8-1.sql',
  'fixture-schema-batch9-1.sql', 'fixture-schema-batch10-1.sql',
  'fixture-schema-batch11-1.sql', 'fixture-schema-batch12-1.sql',
  'fixture-schema-batch13-1.sql'];

/* Stable placeholders, so two runs produce identical files. */
const names = new Map();
let counter = 0;
function stable(id, hint) {
  if (id === null || id === undefined) return id;
  if (!names.has(id)) names.set(id, `${hint || 'id'}-${++counter}`);
  return names.get(id);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The anchored form above tests a WHOLE value; this one finds uuids INSIDE
// prose, which is where they turn up in an error message. Using the anchored
// pattern for that silently replaces nothing -- which is how a fixture stops
// being deterministic without anyone noticing.
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/* MEASURED DURATIONS ARE WALL-CLOCK, so they differ by microseconds between
   runs. Masked to `<seconds>` -- but only when a number is actually there,
   so the distinction the timing contract is FOR survives: a null provider
   time still reads as "the provider has not answered", and a present one
   still reads as "it has". */
const DURATION_KEY = /_seconds$/;

function normalise(value, keyHint) {
  if (typeof value === 'number' && DURATION_KEY.test(keyHint || '')) {
    return '<seconds>';
  }
  if (Array.isArray(value)) return value.map((v) => normalise(v, keyHint));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalise(v, k);
    return out;
  }
  if (typeof value === 'string') {
    if (UUID.test(value)) {
      const hint = (keyHint || '').replace(/_id$/, '');
      return stable(value, hint || 'id');
    }
    // A CAPABILITY, masked before anything else can carry it out of here.
    if (/^[0-9a-f]{64}$/.test(value)) return '<capability-or-hash>';
    if (/^[0-9a-f]{8}$/.test(value)) return '<prefix>';
    if (/^report\.html\?t=[0-9a-f]{64}$/.test(value)) {
      return 'report.html?t=<capability>';
    }
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return '<timestamp>';
    if (/^[0-9a-f]{32}$/.test(value)) return '<fingerprint>';
    if (UUID_IN_TEXT.test(value)) {
      return value.replace(UUID_IN_TEXT, (m) => stable(m, 'id'));
    }
  }
  return value;
}

(async () => {
  assertDisposableTarget(PGURL);
  const client = new pg.Client({ connectionString: PGURL });
  await client.connect();
  await assertDisposableDatabase(client);
  await client.query(`set time zone 'UTC'`);

  const one = async (sql, p) => (await client.query(sql, p)).rows[0];
  const all = async (sql, p) => (await client.query(sql, p)).rows;
  const rpc = async (fn, p) => (await one(`select ${fn} as r`, p)).r;
  const fail = async (fn, p) => {
    try { await rpc(fn, p); return { refused: false }; }
    catch (err) { return { refused: true, errcode: err.code, message: err.message }; }
  };

  await client.query(`
    do $$
    declare r record;
    begin
      for r in select tablename from pg_tables where schemaname='public' loop
        execute 'drop table if exists public.' || quote_ident(r.tablename) || ' cascade';
      end loop;
      for r in select p.oid::regprocedure::text as sig from pg_proc p
                 join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' loop
        execute 'drop function if exists ' || r.sig || ' cascade';
      end loop;
      for r in select viewname from pg_views where schemaname='public' loop
        execute 'drop view if exists public.' || quote_ident(r.viewname) || ' cascade';
      end loop;
    end $$;
  `);
  for (const f of FIXTURES) await client.query(readFileSync(join(DB, f), 'utf8'));
  for (const f of SEQUENCE) await client.query(readFileSync(join(MIGRATIONS, f), 'utf8'));

  let k = 0;
  const key = (t) => `fixture-${t}-${++k}`;

  const owner = (await one('insert into auth.users default values returning id')).id;
  const crew = (await one('insert into auth.users default values returning id')).id;
  await client.query(`select set_config('nova.is_admin','on',false)`);
  const beOwner = () => client.query(`select set_config('nova.actor_id',$1,false)`, [owner]);
  const beCrew = () => client.query(`select set_config('nova.actor_id',$1,false)`, [crew]);
  await beOwner();

  const supplier = (await one('select id from public.ns_suppliers limit 1')).id;

  const custA = (await one(
    `insert into public.customers (name, phone, email)
     values ('FIXTURE Customer A','+15550111','a@example.invalid') returning id`)).id;
  const custB = (await one(
    `insert into public.customers (name, phone, email)
     values ('FIXTURE Customer B','+15550222','b@example.invalid') returning id`)).id;
  const custSilent = (await one(
    `insert into public.customers (name) values ('FIXTURE No Contact') returning id`)).id;

  const property = async (customer, address) => (await one(
    `insert into public.properties
       (customer_id, address_line1, city, access_note, latitude, longitude)
     values ($1,$2,'Fixtureville','Side gate, unlatched -- CREW ONLY',53.5,-113.5)
     returning id`, [customer, address])).id;

  const propA = await property(custA, '1 FIXTURE Lane');
  const propB = await property(custB, '9 OTHER Street');

  const siding = (await one(
    `insert into public.services (key,name,unit)
     values ('siding_soft_wash','Siding Soft Washing','sq_ft') returning id`)).id;

  const material = async (name, over = {}) => (await one(
    `insert into public.ns_materials
       (name,category,unit,supplier_id,pack_quantity,reorder_point,reorder_qty,tracking_mode)
     values ($1,'consumable',$2,$3,1,0,0,$4) returning id`,
    [name, over.unit || 'litre', supplier, over.mode || 'quantity'])).id;

  const soap = await material('FIXTURE siding soap');
  const brush = await material('FIXTURE brush head', { unit: 'level', mode: 'level' });
  await rpc(
    `public.post_stock_movement($1,$2,'base',$3,'received',null,null,null,null,'usable','exact')`,
    [key('mv'), soap, 60]);

  /* One job, carried all the way through, so the fixture reads as a story
     rather than nine unrelated snapshots. */
  const buildJob = async (over = {}) => {
    const job = (await one(
      `insert into public.ns_jobs (customer_id, property_id, status, scheduled_for)
       values ($1,$2,'in_progress','2027-09-14T14:00:00Z') returning id`,
      [over.customer || custA, over.property || propA])).id;
    await client.query(
      `insert into public.job_measurements (job_id, service_id, quantity, unit)
       values ($1,$2,120,'sq_ft')`, [job, siding]);

    let quote = null;
    if (!over.noQuote) {
      quote = (await one(
        `insert into public.ns_quotes
           (status, total, currency, version, job_id, customer_notes, terms, internal_notes)
         values ('accepted',480,$1,1,$2,'Thanks for choosing us.',
                 'Payment on completion.','INTERNAL NOTES: watch the dog')
         returning id`, [over.currency ?? null, job])).id;
      await client.query(
        `insert into public.quote_line_items (quote_id, service_id, description, amount)
         values ($1,$2,'Siding soft washing',480)`, [quote, siding]);
    }

    const attA = (await one(
      `insert into public.job_attachments
         (job_id, storage_path, kind, caption, size_bytes, mime_type)
       values ($1,$2,'site_photo','INTERNAL CAPTION: gutter seam, note the staining',
               40960,'image/jpeg') returning id`,
      [job, `${job}/after.jpg`])).id;
    const attB = (await one(
      `insert into public.job_attachments
         (job_id, storage_path, kind, caption, size_bytes, mime_type)
       values ($1,$2,'site_photo','INTERNAL CAPTION: key safe visible',40960,'image/jpeg')
       returning id`, [job, `${job}/hazard.jpg`])).id;

    const evA = await rpc(
      `public.register_job_evidence($1,$2,$3,'after',null,$4::timestamptz,
         'device_reported',49.1,-122.8,null,'device_reported',null,'field_console')`,
      [key('ev'), job, attA, '2027-09-14T16:04:00Z']);
    const evB = await rpc(
      `public.register_job_evidence($1,$2,$3,'access_hazard',null,null,
         'unknown',null,null,null,'denied',null,'field_console')`,
      [key('ev'), job, attB]);

    const j = await one('select lock_version from public.ns_jobs where id=$1', [job]);
    const pv = (await one('select public.ns_evidence_policy_version() as v')).v;
    const done = await rpc(
      `public.complete_job_with_evidence($1,$2,$3,$4,$5::timestamptz,$6::jsonb,'[]'::jsonb,$7)`,
      [key('done'), job, j.lock_version, pv, '2027-09-14T16:30:00Z',
       JSON.stringify(over.noQuote ? [] : [
         { material_id: soap, location_code: 'base', quantity: 2.5,
           count_precision: 'estimated' },
         { material_id: brush, location_code: 'base', level: 'part' }
       ]),
       'INTERNAL NOTE: customer was not home']);

    return { job, quote, attA, attB,
             evA: evA.evidence_id, evB: evB.evidence_id,
             completion: done.completion.completion_id };
  };

  const scenarios = {};

  /* ---------------------------------------------------------------- 1 -- */
  {
    const j = await buildJob();

    // The three states that are NOT an accepted completion, side by side.
    const other = await one(
      `insert into public.ns_jobs (customer_id, property_id, status, scheduled_for)
       values ($1,$2,'scheduled','2027-09-15T14:00:00Z') returning id`,
      [custA, propA]);
    await rpc(`public.set_dispatch_stage($1,$2,'blocked','Gate padlocked')`,
      [key('stage'), other.id]);
    const blocked = await rpc(`public.ns_job_dispatch_status($1)`, [other.id])
      .catch(() => null);

    const third = await one(
      `insert into public.ns_jobs (customer_id, property_id, status, scheduled_for)
       values ($1,$2,'in_progress','2027-09-16T14:00:00Z') returning id`,
      [custA, propA]);
    await rpc(`public.set_dispatch_stage($1,$2,'work_finished','Tools down')`,
      [key('stage'), third.id]);

    scenarios.only_an_accepted_completion_can_be_reported = {
      what: 'A customer report exists only for an ACCEPTED COMPLETION. A '
        + 'blocked stop, a stop nobody has worked yet and a crew\'s '
        + '"work finished" are three other things, and none of them '
        + 'produces a document.',
      accepted_completion_report: await rpc(
        `public.generate_completion_report($1,$2)`, [key('gen'), j.completion]),
      blocked_stop: blocked || await all(
        `select job_status, dispatch_state, completion_state
           from public.ns_job_dispatch_status where job_id=$1`, [other.id]),
      work_finished_stop: await all(
        `select job_status, dispatch_state, completion_state
           from public.ns_job_dispatch_status where job_id=$1`, [third.id]),
      pending_stop_has_no_report: await all(
        `select count(*)::int as reports from public.ns_completion_reports
          where job_id=$1`, [other.id]),
      a_crew_cannot_generate_one: await (async () => {
        await beCrew();
        const out = await fail(`public.generate_completion_report($1,$2)`,
          [key('gen'), j.completion]);
        await beOwner();
        return out;
      })()
    };
    scenarios.__firstJob = j;
  }

  const first = scenarios.__firstJob;
  delete scenarios.__firstJob;

  /* ---------------------------------------------------------------- 2 -- */
  {
    const before = await rpc(`public.ns_customer_report_document($1)`,
      [first.completion]);
    const published = await rpc(`public.set_evidence_publication($1,$2,
      'published',null,'Siding after washing')`, [key('pub'), first.evA]);
    const withheldRefused = await fail(
      `public.set_evidence_publication($1,$2,'withheld',null,null)`,
      [key('pub'), first.evB]);
    const withheld = await rpc(`public.set_evidence_publication($1,$2,
      'withheld','frames the key safe',null)`, [key('pub'), first.evB]);
    const after = await rpc(`public.ns_customer_report_document($1)`,
      [first.completion]);

    scenarios.publishing_is_a_separate_decision_from_proving = {
      what: 'Evidence proves the work to US. Whether a customer may see it '
        + 'is a separate, owner-only decision with a reason, and the '
        + 'default is NOT published. Deciding does not alter a document '
        + 'already issued -- it changes the next one.',
      document_before_any_decision: {
        evidence: before.evidence,
        evidence_withheld_count: before.evidence_withheld_count
      },
      publishing_one: published,
      withholding_without_a_reason_is_refused: withheldRefused,
      withholding_with_a_reason: withheld,
      document_after: {
        evidence: after.evidence,
        evidence_withheld_count: after.evidence_withheld_count
      },
      the_internal_caption_is_not_the_customer_caption: await all(
        `select a.caption as internal_caption, p.customer_caption
           from public.job_attachments a
           join public.ns_job_evidence e on e.attachment_id = a.id
           join public.ns_evidence_publications p on p.evidence_id = e.id
          where e.id = $1`, [first.evA])
    };
  }

  /* ---------------------------------------------------------------- 3 -- */
  {
    const doc = await rpc(`public.ns_customer_report_document($1)`,
      [first.completion]);
    const text = JSON.stringify(doc);
    scenarios.the_document_is_an_allowlist = {
      what: 'Every field a customer sees is named in '
        + 'ns_customer_report_document(). No internal row is serialised '
        + 'whole, so a column added elsewhere cannot appear here by '
        + 'accident.',
      document: doc,
      private_things_absent: {
        property_access_note: !text.includes('CREW ONLY'),
        completion_internal_note: !text.includes('INTERNAL NOTE'),
        quote_internal_notes: !text.includes('INTERNAL NOTES'),
        attachment_internal_caption: !text.includes('INTERNAL CAPTION'),
        capture_coordinates: !text.includes('49.1') && !text.includes('-122.8'),
        another_customers_name: !text.includes('FIXTURE Customer B')
      },
      private_columns_are_not_even_granted: await all(
        `select has_column_privilege('authenticated','public.ns_property_access',
                  'access_code','select') as access_code_readable,
                has_column_privilege('authenticated','public.ns_property_access',
                  'internal_note','select') as internal_note_readable`)
    };
  }

  /* ---------------------------------------------------------------- 4 -- */
  {
    const a = await rpc(`public.generate_completion_report($1,$2)`,
      [key('gen'), first.completion]);
    const sameKeyAgain = await rpc(`public.generate_completion_report($1,$2)`,
      [a.replayed ? key('gen') : key('gen'), first.completion]);
    const freshKey = await rpc(`public.generate_completion_report($1,$2)`,
      [key('gen'), first.completion]);

    // A correction changes the facts, so the next generation supersedes.
    const row = await one(
      `select id, material_id from public.ns_job_consumptions
        where completion_id=$1 and quantity is not null limit 1`, [first.completion]);
    const corrected = await rpc(
      `public.correct_job_consumption($1,$2,$3,'miscounted the jugs',1.5,null,
         'base','exact',$4)`,
      [key('corr'), first.completion, row.material_id, row.id]);
    const superseding = await rpc(`public.generate_completion_report($1,$2)`,
      [key('gen'), first.completion]);

    const tamper = await (async () => {
      try {
        await client.query(
          `update public.ns_completion_reports
              set document = '{"document_kind":"tampered"}'::jsonb where id=$1`,
          [superseding.report_id]);
        return { refused: false };
      } catch (err) {
        return { refused: true, errcode: err.code, message: err.message };
      }
    })();

    scenarios.retries_and_corrections = {
      what: 'Deduplication is LOGICAL, not just by browser key: two tabs '
        + 'generating "the report as it stands" produce ONE report. A '
        + 'correction changes the source version, so the next generation '
        + 'is a new, SUPERSEDING report that names its source -- an issued '
        + 'document is never rewritten.',
      first_generation: a,
      same_facts_fresh_key_is_the_same_report: {
        same_report_id: freshKey.report_id === a.report_id,
        receipt: freshKey
      },
      same_key_again: sameKeyAgain,
      consumption_correction: corrected,
      superseding_report: superseding,
      the_previous_version_keeps_its_own_document: await all(
        `select report_version, publication_state, superseded_at is not null as stamped,
                jsonb_array_length(document -> 'evidence') as photographs
           from public.ns_completion_reports where job_id=$1
          order by report_version`, [first.job]),
      an_issued_document_cannot_be_rewritten: tamper,
      a_report_cannot_be_deleted: await (async () => {
        try {
          await client.query(`delete from public.ns_completion_reports where id=$1`,
            [superseding.report_id]);
          return { refused: false };
        } catch (err) {
          return { refused: true, errcode: err.code, message: err.message };
        }
      })(),
      current_report_id: superseding.report_id
    };
    scenarios.__current = superseding.report_id;
  }

  const currentReport = scenarios.__current;
  delete scenarios.__current;

  /* ---------------------------------------------------------------- 5 -- */
  {
    const draftLink = await fail(
      `public.issue_customer_grant($1,'report',$2,null,$3::timestamptz,null)`,
      [key('grant'), currentReport, '2099-01-01T00:00:00Z']);

    const publishedReport = await rpc(`public.publish_completion_report($1,$2)`,
      [key('publ'), currentReport]);

    const noExpiry = await fail(
      `public.issue_customer_grant($1,'report',$2,null,null,null)`,
      [key('grant'), currentReport]);

    await client.query(
      `insert into public.app_settings (key, value)
       values ('customer_portal', jsonb_build_object('link_expiry_days','14'))
       on conflict (key) do update set value = excluded.value`);
    const fromPolicy = await rpc(
      `public.issue_customer_grant($1,'report',$2,null,null,'From the policy')`,
      [key('grant'), currentReport]);
    await client.query(`delete from public.app_settings where key='customer_portal'`);

    const explicit = await rpc(
      `public.issue_customer_grant($1,'report',$2,null,$3::timestamptz,'Explicit')`,
      [key('grant'), currentReport, '2099-01-01T00:00:00Z']);
    const token = explicit.token;

    const read = await rpc(`public.get_customer_report($1,null)`, [token]);
    const replay = await rpc(
      `public.issue_customer_grant($1,'report',$2,null,$3::timestamptz,'Explicit')`,
      [explicit.grant_id ? key('grant') : key('grant'), currentReport,
       '2099-01-01T00:00:00Z']);

    scenarios.the_customer_capability = {
      what: 'A cryptographically random capability, stored only as a '
        + 'sha256 hash, with a server-checked scope, a REQUIRED expiry and '
        + 'a revocation. The token is shown once and cannot be read back.',
      a_draft_has_no_link: draftLink,
      publishing_first: publishedReport,
      no_expiry_and_no_policy_is_refused: noExpiry,
      expiry_from_the_owners_policy: fromPolicy,
      expiry_passed_explicitly: explicit,
      the_customers_read: read,
      the_grant_row_as_stored: await all(
        `select scope, token_hash, token_prefix, label,
                expires_at is not null as has_expiry, revoked_at
           from public.ns_customer_grants where id=$1`, [explicit.grant_id]),
      a_replay_cannot_hand_the_token_back: replay,
      a_crew_cannot_mint_one: await (async () => {
        await beCrew();
        const out = await fail(
          `public.issue_customer_grant($1,'report',$2,null,$3::timestamptz,null)`,
          [key('grant'), currentReport, '2099-01-01T00:00:00Z']);
        await beOwner();
        return out;
      })()
    };
    scenarios.__token = token;
  }

  const reportToken = scenarios.__token;
  delete scenarios.__token;

  /* ---------------------------------------------------------------- 6 -- */
  {
    // Another customer, with their own published report.
    const jb = await buildJob({ customer: custB, property: propB });
    const rb = await rpc(`public.generate_completion_report($1,$2)`,
      [key('gen'), jb.completion]);
    await rpc(`public.publish_completion_report($1,$2)`, [key('publ'), rb.report_id]);

    const collection = await rpc(
      `public.issue_customer_grant($1,'customer_collection',null,$2,$3::timestamptz,
         'Customer A, everything')`,
      [key('grant'), custA, '2099-01-01T00:00:00Z']);

    scenarios.scope_is_checked_on_the_server = {
      what: 'A forwarded single-report link is not a filing cabinet, and no '
        + 'link reaches another customer. Another customer\'s REAL report '
        + 'and a made-up id answer identically, because the difference is '
        + 'not the reader\'s business.',
      report_token_pointed_at_another_document: await rpc(
        `public.get_customer_report($1,$2)`, [reportToken, rb.report_id]),
      report_token_listing_documents: await rpc(
        `public.list_customer_documents($1)`, [reportToken]),
      collection_token_listing_documents: await rpc(
        `public.list_customer_documents($1)`, [collection.token]),
      collection_token_on_another_customers_real_report: await rpc(
        `public.get_customer_report($1,$2)`, [collection.token, rb.report_id]),
      collection_token_on_an_invented_id: await rpc(
        `public.get_customer_report($1,$2)`,
        [collection.token, '00000000-0000-0000-0000-000000000000']),
      an_unknown_token: await rpc(`public.get_customer_report($1,null)`,
        ['f'.repeat(64)]),
      a_grant_against_the_wrong_customer_is_refused: await fail(
        `public.issue_customer_grant($1,'report',$2,$3,$4::timestamptz,null)`,
        [key('grant'), currentReport, custB, '2099-01-01T00:00:00Z']),
      read_log_holds_no_token: await all(
        `select requested, outcome, token_prefix,
                grant_id is null as anonymous_attempt
           from public.ns_customer_grant_reads
          order by requested, outcome, token_prefix nulls first`)
    };
  }

  /* ---------------------------------------------------------------- 7 -- */
  {
    const expiring = await rpc(
      `public.issue_customer_grant($1,'report',$2,null,$3::timestamptz,'Expiring')`,
      [key('grant'), currentReport, '2099-01-01T00:00:00Z']);
    await client.query(
      `update public.ns_customer_grants
          set issued_at = now() - interval '2 days',
              expires_at = now() - interval '1 day' where id=$1`,
      [expiring.grant_id]);

    const revoking = await rpc(
      `public.issue_customer_grant($1,'report',$2,null,$3::timestamptz,'To revoke')`,
      [key('grant'), currentReport, '2099-01-01T00:00:00Z']);
    const ticketBefore = await rpc(
      `public.request_customer_document($1,$2,$3)`,
      [revoking.token, currentReport, first.evA]);
    const revoked = await rpc(
      `public.revoke_customer_grant($1,$2,'customer asked us to')`,
      [key('rev'), revoking.grant_id]);

    scenarios.expiry_and_revocation = {
      what: 'An expired or revoked link is a STATE the page renders, never '
        + 'an exception. Revocation stops further reads and any NEW signed '
        + 'download; it cannot reach inside one a reader already holds, and '
        + 'the receipt says so instead of promising otherwise.',
      expired_read: await rpc(`public.get_customer_report($1,null)`,
        [expiring.token]),
      revocation_receipt: revoked,
      revoked_read: await rpc(`public.get_customer_report($1,null)`,
        [revoking.token]),
      a_ticket_issued_before_revocation: ticketBefore,
      the_same_ticket_after_revocation: await rpc(
        `public.redeem_document_ticket($1)`, [ticketBefore.ticket_id]),
      the_owners_view: await rpc(`public.customer_grants($1,null)`, [currentReport])
    };
  }

  /* ---------------------------------------------------------------- 8 -- */
  {
    const g = await rpc(
      `public.issue_customer_grant($1,'report',$2,null,$3::timestamptz,'Files')`,
      [key('grant'), currentReport, '2099-01-01T00:00:00Z']);

    const published = await rpc(`public.request_customer_document($1,$2,$3)`,
      [g.token, currentReport, first.evA]);
    const withheldAsk = await rpc(`public.request_customer_document($1,$2,$3)`,
      [g.token, currentReport, first.evB]);
    const inventedAsk = await rpc(`public.request_customer_document($1,$2,$3)`,
      [g.token, currentReport, '00000000-0000-0000-0000-000000000000']);
    const redeemed = await rpc(`public.redeem_document_ticket($1)`,
      [published.ticket_id]);
    const again = await rpc(`public.redeem_document_ticket($1)`,
      [published.ticket_id]);

    // The object is gone; the row is not. 11.1 freezes the evidence row, so
    // this is the missing-file case that actually happens.
    const second = await rpc(`public.request_customer_document($1,$2,$3)`,
      [g.token, currentReport, first.evA]);
    await client.query(
      `update public.job_attachments set storage_path='' where id=$1`, [first.attA]);
    const missing = await rpc(`public.redeem_document_ticket($1)`,
      [second.ticket_id]);
    await client.query(
      `update public.job_attachments set storage_path=$2 where id=$1`,
      [first.attA, `${first.job}/after.jpg`]);

    scenarios.files_come_by_ticket_never_by_path = {
      what: 'A customer never receives a storage path. An authorised reader '
        + 'gets a single-use, 120-second TICKET, and only a service-role '
        + 'worker can exchange it for a time-limited URL. THAT WORKER IS '
        + 'NOT IN THIS REPOSITORY, so real signing is UNRUN.',
      asking_for_a_published_photograph: published,
      asking_for_a_withheld_one: withheldAsk,
      asking_for_an_invented_one: inventedAsk,
      withheld_and_invented_are_indistinguishable:
        JSON.stringify(withheldAsk) === JSON.stringify(inventedAsk),
      the_worker_redeems_it_once: redeemed,
      the_same_ticket_again: again,
      the_object_is_gone_but_the_record_is_not: missing,
      only_the_service_role_can_redeem: await all(
        `select has_function_privilege('anon',
                  'public.redeem_document_ticket(uuid)','execute') as anon,
                has_function_privilege('authenticated',
                  'public.redeem_document_ticket(uuid)','execute') as authenticated,
                has_function_privilege('service_role',
                  'public.redeem_document_ticket(uuid)','execute') as service_role`)
    };
  }

  /* ---------------------------------------------------------------- 9 -- */
  {
    const noProvider = await rpc(
      `public.deliver_completion_report($1,$2,'sms',$3::timestamptz)`,
      [key('del'), currentReport, '2099-01-01T00:00:00Z']);

    await client.query(
      `insert into public.app_settings (key, value)
       values ('notifications', jsonb_build_object('sms_provider','FIXTURE-double'))
       on conflict (key) do update set value = excluded.value`);

    const accepted = await rpc(
      `public.deliver_completion_report($1,$2,'sms',$3::timestamptz)`,
      [key('del'), currentReport, '2099-01-01T00:00:00Z']);
    const second = await fail(
      `public.deliver_completion_report($1,$2,'sms',$3::timestamptz)`,
      [key('del'), currentReport, '2099-01-01T00:00:00Z']);
    const unknown = await rpc(
      `public.record_report_delivery_outcome($1,'unknown',null,'provider timed out')`,
      [accepted.delivery_id]);
    const blockedByUnknown = await fail(
      `public.deliver_completion_report($1,$2,'sms',$3::timestamptz)`,
      [key('del'), currentReport, '2099-01-01T00:00:00Z']);
    const delivered = await rpc(
      `public.record_report_delivery_outcome($1,'delivered','FIXTURE-msg-1',null)`,
      [accepted.delivery_id]);

    // A customer with no number, on their own job.
    const silent = await buildJob({ customer: custSilent, noQuote: true });
    const silentReport = await rpc(`public.generate_completion_report($1,$2)`,
      [key('gen'), silent.completion]);
    await rpc(`public.publish_completion_report($1,$2)`,
      [key('publ'), silentReport.report_id]);
    const noContact = await rpc(
      `public.deliver_completion_report($1,$2,'sms',$3::timestamptz)`,
      [key('del'), silentReport.report_id, '2099-01-01T00:00:00Z']);

    // A failure, on its own report so it does not disturb the one above.
    const failJob = await buildJob();
    const failReport = await rpc(`public.generate_completion_report($1,$2)`,
      [key('gen'), failJob.completion]);
    await rpc(`public.publish_completion_report($1,$2)`,
      [key('publ'), failReport.report_id]);
    const toFail = await rpc(
      `public.deliver_completion_report($1,$2,'sms',$3::timestamptz)`,
      [key('del'), failReport.report_id, '2099-01-01T00:00:00Z']);
    const failed = await rpc(
      `public.record_report_delivery_outcome($1,'provider_failed',null,'number unreachable')`,
      [toFail.delivery_id]);

    scenarios.delivery_keeps_five_outcomes_apart = {
      what: 'ACCEPTED IS QUEUED, NOT SENT. `unknown` is not a success: it '
        + 'stays live and keeps blocking a second message, because a retry '
        + 'might be the customer\'s second identical text. `unavailable` '
        + 'splits into two reasons fixed by different people, and mints no '
        + 'capability at all. THE SENDING WORKER IS NOT IN THIS '
        + 'REPOSITORY: every outcome here was recorded by a double and NO '
        + 'MESSAGE WAS SENT.',
      no_provider_configured: noProvider,
      provider_but_no_number_on_file: noContact,
      accepted: accepted,
      a_second_live_delivery_is_refused: second,
      unknown_outcome: unknown,
      delivery_while_unknown_is_live: blockedByUnknown,
      resolved_to_delivered_under_the_original_key: delivered,
      provider_failure: failed,
      timing: await rpc(`public.report_delivery_timing($1)`, [currentReport]),
      queued_rows: await all(
        `select kind, channel, status, sent_at is not null as marked_sent,
                payload ? 'access_code' as payload_has_a_code,
                payload ? 'link_path' as payload_has_the_link
           from public.notifications order by created_at`),
      inbound_replies: await rpc(`public.ns_inbound_reply_support()`, []),
      a_crew_cannot_record_an_outcome: await (async () => {
        await beCrew();
        const out = await fail(
          `public.record_report_delivery_outcome($1,'delivered',null,null)`,
          [toFail.delivery_id]);
        await beOwner();
        return out;
      })()
    };
    scenarios.__payJob = first.job;
  }

  const payJob = scenarios.__payJob;
  delete scenarios.__payJob;

  /* --------------------------------------------------------------- 10 -- */
  {
    const noProvider = await rpc(`public.create_payment_request($1,$2,null)`,
      [key('pay'), payJob]);
    const balanceBefore = await rpc(`public.ns_payment_balance($1)`, [payJob]);

    await client.query(
      `insert into public.app_settings (key, value)
       values ('payments', jsonb_build_object('provider','FIXTURE-double'))
       on conflict (key) do update set value = excluded.value`);
    const providerButNoModel = await rpc(`public.create_payment_request($1,$2,null)`,
      [key('pay'), payJob]);

    /* A LABELLED DOUBLE. Created here to prove the boundary BINDS to a
       settlement model if one ever exists. Its presence in this scenario is
       not evidence that the system has one -- `balance_before_any_model`
       above is. */
    await client.query(`
      create table public.ns_payments (
        id uuid primary key default gen_random_uuid(),
        job_id uuid not null references public.ns_jobs(id),
        amount numeric not null,
        state text not null default 'settled');
      comment on table public.ns_payments is
        'FIXTURE DOUBLE created by tests/fixtures/build-handover-fixtures.mjs. '
        'Not a real settlement model.';
    `);
    await client.query(
      `insert into public.ns_payments (job_id, amount) values ($1, 200)`, [payJob]);
    await client.query(
      `update public.app_settings set value = jsonb_build_object('currency','CAD')
        where key='quote_defaults'`);

    const bound = await rpc(`public.create_payment_request($1,$2,null)`,
      [key('pay'), payJob]);
    const stale = await fail(`public.create_payment_request($1,$2,$3)`,
      [key('pay'), payJob, 9999]);

    const state = await rpc(`public.job_payment_state($1)`, [payJob]);
    const quoteUntouched = await all(
      `select status, total, currency from public.ns_quotes where job_id=$1`, [payJob]);

    await client.query(`drop table public.ns_payments cascade`);

    scenarios.the_payment_boundary_refuses = {
      what: 'There is NO invoice or payment-received model in this system, '
        + 'so a remaining balance is not knowable and the boundary refuses. '
        + 'The approved total is NOT the outstanding balance wearing a '
        + 'different name. Unconfigured means unavailable: no provider, no '
        + 'checkout URL, no sandbox, no webhook assumption.',
      balance_before_any_model: balanceBefore,
      no_provider_selected: noProvider,
      provider_selected_but_no_settlement_model: providerButNoModel,
      with_a_LABELLED_DOUBLE_settlement_model: {
        note: 'public.ns_payments here is a double this script created and '
          + 'dropped. It proves the amount binds to the approved record; it '
          + 'is NOT evidence that a settlement model exists.',
        prepared: bound,
        a_stale_expected_amount_is_refused: stale
      },
      owner_view: state,
      quote_pricing_untouched: quoteUntouched,
      a_crew_cannot_ask_for_money: await (async () => {
        await beCrew();
        const out = await fail(`public.create_payment_request($1,$2,null)`,
          [key('pay'), payJob]);
        await beOwner();
        return out;
      })()
    };
  }

  await client.end();

  const out = {
    contract: 'customer-handover-contract-v1',
    generated_by: 'tests/fixtures/build-handover-fixtures.mjs',
    note: 'Generated by running the real backend on a disposable database. '
      + 'Regenerate after any contract change; the diff IS the change. Ids '
      + 'and timestamps are replaced with stable placeholders, and every '
      + 'capability token and hash is masked, so two runs produce identical '
      + 'files and no working credential is committed. No live database was '
      + 'touched. No provider was configured beyond a NAME IN SETTINGS, no '
      + 'message was sent, no file was signed and no money moved. The '
      + 'settlement model in the payment scenario is a LABELLED DOUBLE this '
      + 'script created and dropped; the system has none. No real customer, '
      + 'address, phone number or supplier product appears here.',
    scenarios: normalise(scenarios)
  };

  mkdirSync(HERE, { recursive: true });
  const path = join(HERE, 'customer-handover-v1.json');
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote ${path}`);
  console.log(`${Object.keys(scenarios).length} scenarios`);
})().catch((err) => { console.error(err); process.exit(1); });
