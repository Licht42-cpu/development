// Batch 13.1 -- customer completion reports, scoped customer access,
// delivery and the payment boundary, against a DEDICATED DISPOSABLE
// DATABASE.
//
//   node tests/db/setup-test-db.mjs
//   node tests/db/batch13-1.test.mjs
//
// What passing proves: the whole pending migration sequence applies; a
// customer report is built from an accepted completion through an explicit
// allowlist and carries no access code, internal note, GPS coordinate,
// hazard note, cost or other customer's data; proving completion is not
// publishing, and publication is an owner decision with a reason; a report
// is immutable once issued and a correction supersedes rather than
// rewrites; two generations of the same facts are ONE report; a customer
// capability is random, hashed, scoped, expiring and revocable, and a
// forwarded single-report token cannot read a customer's collection or
// another customer's document; files are reached by ticket and never by
// path; delivery reuses the existing notifications table and keeps queued,
// delivered, failed, unknown and unavailable apart with the five
// timestamps; and the payment boundary refuses because there is no
// settlement model, binding an amount only against a LABELLED DOUBLE.
//
// What it does NOT prove: anything about the live database; anything about
// a real SMS, email or payment provider; and anything about Storage
// signing, which needs a worker this repository does not contain. NO
// MIGRATION IN THIS REPOSITORY HAS BEEN APPLIED TO PRODUCTION, NO REAL
// MESSAGE IS SENT AND NO MONEY IS MOVED.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import {
  TEST_DB_NAME, assertDisposableTarget, assertDisposableDatabase
} from './disposable.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const MIGRATIONS = join(REPO, 'supabase', 'migrations');

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
const NEW_FILES = 4;              // the 13.1 migrations, for the re-run check
const migration = (f) => readFileSync(join(MIGRATIONS, f), 'utf8');

const results = [];
async function record(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, err: err && err.message }); }
}
async function errorOf(fn) {
  try { await fn(); return null; } catch (err) { return err; }
}

let seq = 0;
const opId = (tag) => `hdo-${tag}-${++seq}`;

(async () => {
  assertDisposableTarget(PGURL);
  const client = new pg.Client({ connectionString: PGURL });
  await client.connect();
  await assertDisposableDatabase(client);
  await client.query(`set time zone 'UTC'`);

  const one = async (sql, p) => (await client.query(sql, p)).rows[0];
  const all = async (sql, p) => (await client.query(sql, p)).rows;
  const rpc = async (fn, p) => (await one(`select ${fn} as r`, p)).r;

  /** Run something as a REAL non-owner role, not as the table owner. The
   *  owner bypasses every grant, so a privilege test that does not change
   *  role proves nothing at all. */
  const asRole = async (role, fn) => {
    await client.query(`set role ${role}`);
    try { return await fn(); } finally { await client.query('reset role'); }
  };

  // A clean slate: this suite applies the entire pending sequence, and
  // anything left behind from another suite would be tested instead of it.
  await client.query(`
    do $$
    declare r record;
    begin
      for r in select tablename from pg_tables where schemaname='public' loop
        execute 'drop table if exists public.' || quote_ident(r.tablename) || ' cascade';
      end loop;
      for r in select table_name from information_schema.views
                where table_schema='public' loop
        execute 'drop view if exists public.' || quote_ident(r.table_name) || ' cascade';
      end loop;
      for r in select p.oid::regprocedure::text as sig
                 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                where n.nspname = 'public' loop
        execute 'drop function if exists ' || r.sig || ' cascade';
      end loop;
    end $$;
  `);

  for (const f of ['fixture-schema.sql', 'fixture-schema-batch8-1.sql',
                   'fixture-schema-batch9-1.sql', 'fixture-schema-batch10-1.sql',
                   'fixture-schema-batch11-1.sql', 'fixture-schema-batch12-1.sql',
                   'fixture-schema-batch13-1.sql']) {
    await client.query(readFileSync(join(HERE, f), 'utf8'));
  }

  // ================================================= A. migrations ========
  for (const [i, file] of SEQUENCE.entries()) {
    await record(`A${i + 1} ${file} applies in sequence`, async () => {
      await client.query(migration(file));
    });
  }
  await record('A90 the 13.1 migrations are re-runnable', async () => {
    for (const f of SEQUENCE.slice(-NEW_FILES)) await client.query(migration(f));
    for (const f of SEQUENCE.slice(-NEW_FILES)) await client.query(migration(f));
    const { n } = await one(
      `select count(*)::int as n from pg_trigger
        where tgrelid='public.ns_completion_reports'::regclass
          and tgname='ns_completion_reports_immutable' and not tgisinternal`);
    assert.equal(n, 1, 're-running must not stack duplicate triggers');
  });

  // ------------------------------------------------------------ fixtures --
  const ownerId = (await one('insert into auth.users default values returning id')).id;
  const crewId  = (await one('insert into auth.users default values returning id')).id;
  await client.query(`select set_config('nova.is_admin','on',false)`);
  const beOwner = () => client.query(`select set_config('nova.actor_id',$1,false)`, [ownerId]);
  const beCrew  = () => client.query(`select set_config('nova.actor_id',$1,false)`, [crewId]);
  await beOwner();

  const supplierId = (await one('select id from public.ns_suppliers limit 1')).id;

  const custA = (await one(
    `insert into public.customers (name, phone, email)
     values ('FIXTURE Customer A','+15550111','a@example.invalid') returning id`)).id;
  const custB = (await one(
    `insert into public.customers (name, phone, email)
     values ('FIXTURE Customer B','+15550222','b@example.invalid') returning id`)).id;
  const custSilent = (await one(
    `insert into public.customers (name) values ('FIXTURE No Contact') returning id`)).id;

  const newProperty = async (customer, over = {}) => (await one(
    `insert into public.properties
       (customer_id, address_line1, city, access_note, latitude, longitude)
     values ($1,$2,'Fixtureville',$3,$4,$5) returning id`,
    [customer, over.address || '1 FIXTURE Lane',
     over.accessNote ?? 'Side gate, unlatched -- CREW ONLY',
     over.lat ?? 53.5, over.lng ?? -113.5])).id;

  const propA = await newProperty(custA);
  const propB = await newProperty(custB, { address: '9 OTHER Street' });

  const svc = async (key, name) => (await one(
    `insert into public.services (key,name,unit) values ($1,$2,'sq_ft')
     on conflict (key) do update set name=excluded.name returning id`, [key, name])).id;

  const newMaterial = async (name, over = {}) => (await one(
    `insert into public.ns_materials
       (name,category,unit,supplier_id,pack_quantity,reorder_point,reorder_qty,tracking_mode)
     values ($1,$2,$3,$4,1,0,0,$5) returning id`,
    [name, over.category || 'consumable', over.unit || 'litre', supplierId,
     over.tracking_mode || 'quantity'])).id;

  const newJob = async (over = {}) => (await one(
    `insert into public.ns_jobs (customer_id, property_id, status, scheduled_for)
     values ($1,$2,$3,$4) returning id`,
    [over.customer || custA, over.property ?? propA,
     over.status || 'in_progress', over.when || '2027-09-14T14:00:00Z'])).id;

  const measure = (jobId, serviceId, q = 100) => client.query(
    `insert into public.job_measurements (job_id, service_id, quantity, unit)
     values ($1,$2,$3,'sq_ft')`, [jobId, serviceId, q]);

  const upload = async (jobId, name) => (await one(
    `insert into public.job_attachments
       (job_id, storage_path, kind, caption, size_bytes, mime_type)
     values ($1,$2,'site_photo',$3,40960,'image/jpeg') returning id`,
    [jobId, `${jobId}/${name}.jpg`,
     'INTERNAL CAPTION: gutter seam, note the staining'])).id;

  const evidence = (jobId, attId, requirement, over = {}) => rpc(
    `public.register_job_evidence($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9,null,$10,$11,'field_console')`,
    [opId('ev'), jobId, attId, requirement, over.serviceKey ?? null,
     'capturedAt' in over ? over.capturedAt : '2027-09-14T15:04:00Z',
     over.timeState ?? null,
     'lat' in over ? over.lat : 49.1, 'lon' in over ? over.lon : -122.8,
     over.gpsState ?? null, over.watermark ?? null]);

  const jobRow = (id) => one('select * from public.ns_jobs where id=$1', [id]);

  const completeNow = async (jobId, over = {}) => {
    const j = await jobRow(jobId);
    const pv = (await one('select public.ns_evidence_policy_version() as v')).v;
    return rpc(
      `public.complete_job_with_evidence($1,$2,$3,$4,$5::timestamptz,$6::jsonb,$7::jsonb,$8)`,
      [over.key ?? opId('done'), jobId, j.lock_version, pv,
       over.finished ?? '2027-09-14T16:30:00Z',
       JSON.stringify(over.consumption ?? []),
       JSON.stringify(over.additionalWork ?? []),
       over.note ?? 'INTERNAL NOTE: customer was not home']);
  };

  const receive = (matId, qty, loc = 'base') => rpc(
    `public.post_stock_movement($1,$2,$3,$4,'received',null,null,null,null,'usable','exact')`,
    [opId('mv'), matId, loc, qty]);

  /** An accepted quote with customer-facing line descriptions. */
  const acceptedQuote = async (jobId, over = {}) => {
    const q = (await one(
      `insert into public.ns_quotes
         (status, total, currency, version, job_id, customer_notes, terms, internal_notes)
       values ('accepted',$1,$2,1,$3,$4,$5,$6) returning id`,
      [over.total ?? 480, over.currency ?? null, jobId,
       'Thanks for choosing us.', 'Payment on completion.',
       'INTERNAL NOTES: watch the dog'])).id;
    for (const line of over.lines ?? [{ desc: 'Siding soft washing', svc: null }]) {
      await client.query(
        `insert into public.quote_line_items (quote_id, service_id, description, amount)
         values ($1,$2,$3,$4)`, [q, line.svc, line.desc, line.amount ?? 480]);
    }
    return q;
  };

  const publication = (evId, decision, over = {}) => rpc(
    `public.set_evidence_publication($1,$2,$3,$4,$5)`,
    [over.key ?? opId('pub'), evId, decision, over.reason ?? null,
     over.caption ?? null]);

  const generate = (completionId, key) => rpc(
    `public.generate_completion_report($1,$2)`, [key ?? opId('gen'), completionId]);

  const publish = (reportId, key) => rpc(
    `public.publish_completion_report($1,$2)`, [key ?? opId('publ'), reportId]);

  const issue = (over = {}) => rpc(
    `public.issue_customer_grant($1,$2,$3,$4,$5::timestamptz,$6)`,
    [over.key ?? opId('grant'), over.scope ?? 'report', over.reportId ?? null,
     over.customerId ?? null, over.expires ?? '2099-01-01T00:00:00Z',
     over.label ?? null]);

  const readReport = (token, reportId = null) =>
    rpc(`public.get_customer_report($1,$2)`, [token, reportId]);

  const siding = await svc('siding_soft_wash', 'Siding Soft Washing');
  const soap = await newMaterial('FIXTURE siding soap');
  // A level-tracked supply's unit IS 'level' -- ns_materials_level_unit_agrees
  // makes the two agree, so a "litre" that reports a level is unrepresentable.
  const brush = await newMaterial('FIXTURE brush head',
    { tracking_mode: 'level', unit: 'level' });
  await receive(soap, 40);

  /** The whole happy path, as one helper: a measured job, an accepted
   *  quote, one published and one withheld photograph, consumption with a
   *  quantity AND a level, and an accepted completion. */
  const wholeJob = async (over = {}) => {
    const job = await newJob(over.job ?? {});
    await measure(job, siding, 120);
    const quote = over.noQuote ? null : await acceptedQuote(job, over.quote ?? {});
    const attShown = await upload(job, 'after');
    const attHidden = await upload(job, 'hazard');
    const evShown = await evidence(job, attShown, 'after');
    const evHidden = await evidence(job, attHidden, 'access_hazard',
      { gpsState: 'denied', lat: null, lon: null });
    const done = await completeNow(job, {
      consumption: over.consumption ?? [
        { material_id: soap, location_code: 'base', quantity: 2.5,
          count_precision: 'estimated' },
        { material_id: brush, location_code: 'base', level: 'part' }
      ]
    });
    return {
      job, quote, attShown, attHidden,
      evShown: evShown.evidence_id ?? evShown.id ?? evShown,
      evHidden: evHidden.evidence_id ?? evHidden.id ?? evHidden,
      completion: done.completion.completion_id
    };
  };

  // =================================== B. the allowlisted projection =====
  const base = await wholeJob();

  await record('B1 the document is built from the accepted completion, by id',
    async () => {
      const doc = await rpc('public.ns_customer_report_document($1)', [base.completion]);
      assert.equal(doc.document_kind, 'completion_report');
      assert.equal(doc.completion.completion_id, base.completion);
      assert.equal(doc.job.job_id, base.job);
    });

  await record('B2 crew report time and server acceptance stay apart', async () => {
    const doc = await rpc('public.ns_customer_report_document($1)', [base.completion]);
    assert.equal(doc.completion.work_finished_state, 'reported');
    assert.equal(doc.completion.reported_work_time_state, 'reported_by_crew');
    assert.ok(doc.completion.accepted_at, 'the server time must be present');
    assert.notEqual(doc.completion.accepted_at, doc.completion.work_finished_at,
      'a device claim and a server fact must not be the same field');
  });

  await record('B3 nothing private reaches the document', async () => {
    const doc = await rpc('public.ns_customer_report_document($1)', [base.completion]);
    const text = JSON.stringify(doc);
    for (const secret of ['CREW ONLY', 'INTERNAL NOTE', 'INTERNAL NOTES',
                          'INTERNAL CAPTION']) {
      assert.ok(!text.includes(secret),
        `the document leaked ${secret}`);
    }
    // No GPS coordinates, in any shape.
    assert.ok(!text.includes('49.1') && !text.includes('-122.8'),
      'the document leaked capture coordinates');
    assert.ok(!text.includes('FIXTURE Customer B'),
      'the document named another customer');
  });

  await record('B4 the property is the address, never the access note', async () => {
    const doc = await rpc('public.ns_customer_report_document($1)', [base.completion]);
    assert.equal(doc.property.address_line1, '1 FIXTURE Lane');
    assert.ok(!('access_note' in doc.property));
    assert.ok(!('hazard_note' in doc.property));
  });

  await record('B5 only explicitly published evidence appears; default is none',
    async () => {
      const doc = await rpc('public.ns_customer_report_document($1)', [base.completion]);
      assert.deepEqual(doc.evidence, [],
        'evidence with no publication decision must not be on the document');
      assert.equal(Number(doc.evidence_withheld_count), 2);
    });

  await record('B6 a published photograph appears with its customer caption',
    async () => {
      await publication(base.evShown, 'published',
        { caption: 'Siding after washing' });
      const doc = await rpc('public.ns_customer_report_document($1)', [base.completion]);
      assert.equal(doc.evidence.length, 1);
      assert.equal(doc.evidence[0].evidence_id, base.evShown);
      assert.equal(doc.evidence[0].caption, 'Siding after washing');
      assert.equal(Number(doc.evidence_withheld_count), 1);
    });

  await record('B7 a published photograph carries no coordinates and says so',
    async () => {
      const doc = await rpc('public.ns_customer_report_document($1)', [base.completion]);
      const e = doc.evidence[0];
      assert.equal(e.verification, 'device_reported_not_server_verified');
      assert.equal(e.location_state, 'device_reported');
      assert.ok(!('captured_lat' in e) && !('captured_lon' in e));
    });

  await record('B8 a level stays a level and an estimate stays an estimate',
    async () => {
      const doc = await rpc('public.ns_customer_report_document($1)', [base.completion]);
      const byName = Object.fromEntries(doc.materials.map(m => [m.material, m]));
      const level = byName['FIXTURE brush head'];
      const qty = byName['FIXTURE siding soap'];
      assert.equal(level.level, 'part');
      assert.equal(level.quantity, null, 'a level must never grow a quantity');
      assert.equal(level.measurement_state, 'level_observed');
      assert.equal(qty.measurement_state, 'estimated');
      assert.equal(qty.unit, 'litre');
    });

  await record('B9 consumption is reported, never costed', async () => {
    const doc = await rpc('public.ns_customer_report_document($1)', [base.completion]);
    for (const m of doc.materials) {
      for (const forbidden of ['rate', 'amount', 'cost', 'price', 'total']) {
        assert.ok(!(forbidden in m), `a material line carried a ${forbidden}`);
      }
    }
    assert.match(doc.materials_note, /not charged/);
  });

  await record('B10 the work descriptions come from the accepted quote', async () => {
    const doc = await rpc('public.ns_customer_report_document($1)', [base.completion]);
    assert.equal(doc.work.length, 1);
    assert.equal(doc.work[0].description, 'Siding soft washing');
  });

  await record('B11 the total is the accepted quote, and the currency is honest',
    async () => {
      const doc = await rpc('public.ns_customer_report_document($1)', [base.completion]);
      assert.equal(Number(doc.commercials.approved_total), 480);
      assert.equal(doc.commercials.commercial_state, 'accepted_quote');
      assert.equal(doc.commercials.currency, null);
      assert.equal(doc.commercials.currency_state, 'unconfigured',
        'an unset currency must say so rather than defaulting to CAD');
    });

  await record('B12 a job with no accepted quote shows no total at all', async () => {
    const bare = await wholeJob({ noQuote: true, job: { } });
    const doc = await rpc('public.ns_customer_report_document($1)', [bare.completion]);
    assert.equal(doc.commercials.approved_total, null);
    assert.equal(doc.commercials.commercial_state, 'no_accepted_quote');
  });

  await record('B13 a proposed change order is not a charge; an approved one is',
    async () => {
      const co = await rpc(
        `public.propose_additional_work($1,$2,'Replace a cracked downspout',null)`,
        [opId('co'), base.job]);
      let doc = await rpc('public.ns_customer_report_document($1)', [base.completion]);
      assert.deepEqual(doc.commercials.approved_changes, [],
        'a crew proposal must never appear as a customer-facing charge');
      assert.equal(Number(doc.commercials.approved_total), 480);

      await rpc(`public.decide_change_order($1,$2,'approved',120,'agreed on site')`,
        [opId('co'), co.change_order_id]);
      doc = await rpc('public.ns_customer_report_document($1)', [base.completion]);
      assert.equal(doc.commercials.approved_changes.length, 1);
      assert.equal(Number(doc.commercials.approved_total), 600);
    });

  await record('B14 the accepted quote currency wins over the settings default',
    async () => {
      const j = await wholeJob({ quote: { currency: 'CAD', total: 100 } });
      let doc = await rpc('public.ns_customer_report_document($1)', [j.completion]);
      assert.equal(doc.commercials.currency, 'CAD');
      assert.equal(doc.commercials.currency_state, 'from_accepted_quote');

      await client.query(
        `update public.app_settings set value = jsonb_build_object('currency','USD')
          where key = 'quote_defaults'`);
      doc = await rpc('public.ns_customer_report_document($1)', [j.completion]);
      assert.equal(doc.commercials.currency, 'CAD',
        'a frozen quote currency must not drift when the default changes');

      const bare = await wholeJob({ quote: { currency: null, total: 50 } });
      doc = await rpc('public.ns_customer_report_document($1)', [bare.completion]);
      assert.equal(doc.commercials.currency_state, 'from_settings');
      await client.query(
        `update public.app_settings set value = '{}'::jsonb where key='quote_defaults'`);
    });

  await record('B15 the company block is the existing company settings row',
    async () => {
      const doc = await rpc('public.ns_customer_report_document($1)', [base.completion]);
      assert.equal(doc.company.state, 'configured');
      assert.equal(doc.company.name, 'Nova Shield Maintenance Services');
    });

  // =========================== C. publishing is its own decision =========
  await record('C1 a withheld decision must say why', async () => {
    const err = await errorOf(() => publication(base.evHidden, 'withheld'));
    assert.ok(err, 'a reasonless withholding was accepted');
    assert.equal(err.code, '22023');
  });

  await record('C2 a crew cannot decide what a customer sees', async () => {
    await client.query(
      `insert into public.ns_crew_members (user_id,role,vehicle_location_id,display_name)
       values ($1,'crew',(select id from public.ns_stock_locations where code='car_a'),'FIXTURE crew')
       on conflict (user_id) do update set role='crew', active=true`, [crewId]);
    await beCrew();
    const err = await errorOf(() => publication(base.evHidden, 'published'));
    await beOwner();
    assert.ok(err);
    assert.equal(err.code, '42501');
  });

  await record('C3 withholding records the decision rather than forgetting it',
    async () => {
      await publication(base.evHidden, 'withheld',
        { reason: 'frames the key safe' });
      const row = await one(
        `select * from public.ns_evidence_publications where evidence_id=$1`,
        [base.evHidden]);
      assert.equal(row.decision, 'withheld');
      assert.match(row.reason, /key safe/);
    });

  await record('C4 the internal attachment caption is never the customer caption',
    async () => {
      const row = await one(
        `select customer_caption from public.ns_evidence_publications where evidence_id=$1`,
        [base.evShown]);
      assert.equal(row.customer_caption, 'Siding after washing');
      const att = await one(
        `select caption from public.job_attachments where id=$1`, [base.attShown]);
      assert.match(att.caption, /INTERNAL CAPTION/);
      assert.notEqual(row.customer_caption, att.caption);
    });

  await record('C5 the same key replays a publication rather than deciding twice',
    async () => {
      const k = opId('pubk');
      const first = await publication(base.evShown, 'published',
        { key: k, caption: 'Siding after washing' });
      const again = await publication(base.evShown, 'published',
        { key: k, caption: 'Siding after washing' });
      assert.equal(first.replayed, false);
      assert.equal(again.replayed, true);
    });

  await record('C6 the same key with a different decision is refused', async () => {
    const k = opId('pubk');
    await publication(base.evShown, 'published', { key: k, caption: 'A' });
    const err = await errorOf(() =>
      publication(base.evShown, 'withheld', { key: k, reason: 'changed my mind' }));
    assert.ok(err);
    assert.equal(err.code, '23505');
  });

  // =============================== D. generating the report ==============
  let reportV1;
  await record('D1 a crew cannot generate a customer report', async () => {
    await beCrew();
    const err = await errorOf(() => generate(base.completion));
    await beOwner();
    assert.ok(err);
    assert.equal(err.code, '42501');
  });

  await record('D2 generation produces v1, a draft, with a source version',
    async () => {
      const r = await generate(base.completion);
      reportV1 = r.report_id;
      assert.equal(r.report_version, 1);
      assert.equal(r.publication_state, 'draft');
      assert.ok(r.source_version);
      assert.equal(r.delivered, false);
      assert.equal(r.supersedes, null);
    });

  await record('D3 the review hold is visible, not silent', async () => {
    // A job whose evidence nobody has decided yet. `base` is not that job --
    // both its photographs have decisions by now -- and asserting against it
    // would have tested the wrong thing.
    const undecided = await wholeJob();
    const r = await generate(undecided.completion, opId('gen'));
    assert.match(r.review_hold ?? '', /no publication decision/,
      'undecided evidence must be reported as a hold');
    assert.equal(r.publication_state, 'draft');
  });

  await record('D4 the same key replays; a different key with the same facts '
    + 'returns the SAME report', async () => {
      const k = opId('gen');
      const a = await generate(base.completion, k);
      const b = await generate(base.completion, k);
      assert.equal(b.replayed, true);
      assert.equal(a.report_id, b.report_id);

      // The half a browser key cannot catch: two tabs, two keys, one report.
      const c = await generate(base.completion, opId('gen'));
      assert.equal(c.report_id, a.report_id,
        'the same facts under a fresh key must not create a second report');
      assert.equal(c.replayed, true);
      const { n } = await one(
        `select count(*)::int as n from public.ns_completion_reports where job_id=$1`,
        [base.job]);
      assert.equal(n, 1, 'exactly one report event for one set of facts');
    });

  await record('D5 an issued report cannot be rewritten', async () => {
    const err = await errorOf(() => client.query(
      `update public.ns_completion_reports
          set document = '{"document_kind":"tampered"}'::jsonb where id=$1`,
      [reportV1]));
    assert.ok(err, 'the document was rewritten');
    assert.equal(err.code, '23514');
  });

  await record('D6 a report cannot be deleted', async () => {
    const err = await errorOf(() => client.query(
      `delete from public.ns_completion_reports where id=$1`, [reportV1]));
    assert.ok(err);
    assert.equal(err.code, '23514');
  });

  await record('D7 a new publication decision supersedes rather than edits',
    async () => {
      await publication(base.evHidden, 'published',
        { caption: 'Access route', key: opId('pub') });
      const v2 = await generate(base.completion, opId('gen'));
      assert.equal(v2.report_version, 2);
      assert.equal(v2.supersedes, reportV1);
      assert.notEqual(v2.report_id, reportV1);

      const old = await one(
        `select publication_state, superseded_at, document
           from public.ns_completion_reports where id=$1`, [reportV1]);
      assert.equal(old.publication_state, 'superseded');
      assert.ok(old.superseded_at);
      assert.equal(old.document.evidence.length, 1,
        'the old document must still say what it said');

      const fresh = await one(
        `select document from public.ns_completion_reports where id=$1`,
        [v2.report_id]);
      assert.equal(fresh.document.evidence.length, 2);
      reportV1 = v2.report_id;          // the current one from here on
    });

  await record('D8 a reopened completion has nothing to report', async () => {
    const j = await wholeJob();
    await rpc(`public.reopen_job_completion($1,$2,'customer called back')`,
      [opId('reopen'), j.completion]);
    const err = await errorOf(() => generate(j.completion, opId('gen')));
    assert.ok(err, 'a reopened completion was reported as accepted work');
    assert.equal(err.code, '23514');
    assert.match(err.message, /reopened/);
  });

  await record('D9 a completion superseded by a later one is refused by name',
    async () => {
      const j = await wholeJob();
      await rpc(`public.reopen_job_completion($1,$2,'had to go back')`,
        [opId('reopen'), j.completion]);
      // Re-complete: ns_job_completion_is_open() is true again, but the
      // FIRST completion is no longer the current one.
      const second = await completeNow(j.job, { key: opId('done') });
      const err = await errorOf(() => generate(j.completion, opId('gen')));
      assert.ok(err, 'a stale completion was still reportable');
      assert.match(err.message, /current one/);
      const ok = await generate(second.completion.completion_id, opId('gen'));
      assert.equal(ok.report_version, 1);
    });

  await record('D10 a consumption correction changes the facts, so a new report',
    async () => {
      const before = await one(
        `select source_version from public.ns_completion_reports where id=$1`,
        [reportV1]);
      const row = await one(
        `select id, material_id, location_id from public.ns_job_consumptions
          where completion_id=$1 and quantity is not null limit 1`, [base.completion]);
      await rpc(
        `public.correct_job_consumption($1,$2,$3,'miscounted the jugs',$4,null,'base','exact',$5)`,
        [opId('corr'), base.completion, row.material_id, 1.5, row.id]);
      const after = await generate(base.completion, opId('gen'));
      assert.equal(after.report_version, 3);
      assert.equal(after.supersedes, reportV1);
      const sv = await one(
        `select source_version from public.ns_completion_reports where id=$1`,
        [after.report_id]);
      assert.notEqual(sv.source_version, before.source_version);
      reportV1 = after.report_id;
    });

  await record('D11 the owner read shows every version and what is undecided',
    async () => {
      const read = await rpc('public.job_completion_reports($1)', [base.job]);
      assert.equal(read.reports.length, 3);
      assert.equal(read.reports[0].report_version, 3);
      assert.equal(read.reports[0].publication_state, 'draft');
      assert.deepEqual(read.undecided_evidence, []);
    });

  // ============================= E. publishing the report ================
  await record('E1 publishing clears the hold and stamps the time', async () => {
    const r = await publish(reportV1);
    assert.equal(r.publication_state, 'published');
    assert.ok(r.published_at);
    assert.equal(r.review_hold, null);
    assert.equal(r.no_op, false);
  });

  await record('E2 publishing twice is a retry, not a second document', async () => {
    const r = await publish(reportV1, opId('publ'));
    assert.equal(r.no_op, true);
  });

  await record('E3 a superseded report cannot be re-issued', async () => {
    const old = await one(
      `select id from public.ns_completion_reports
        where job_id=$1 and report_version=1`, [base.job]);
    const err = await errorOf(() => publish(old.id, opId('publ')));
    assert.ok(err);
    assert.equal(err.code, '23514');
  });

  await record('E4 a crew cannot publish', async () => {
    await beCrew();
    const err = await errorOf(() => publish(reportV1, opId('publ')));
    await beOwner();
    assert.ok(err);
    assert.equal(err.code, '42501');
  });

  // ================================= F. the capability ===================
  let tokenA;
  await record('F1 a link needs an expiry, and there is no invented default',
    async () => {
      const err = await errorOf(() => rpc(
        `public.issue_customer_grant($1,'report',$2,null,null,null)`,
        [opId('grant'), reportV1]));
      assert.ok(err, 'a grant was issued with no expiry and no policy');
      assert.equal(err.code, '22023');
      assert.match(err.message, /no default/);
    });

  await record('F2 the owner-configured policy supplies one', async () => {
    await client.query(
      `insert into public.app_settings (key, value)
       values ('customer_portal', jsonb_build_object('link_expiry_days','14'))
       on conflict (key) do update set value = excluded.value`);
    const g = await rpc(
      `public.issue_customer_grant($1,'report',$2,null,null,null)`,
      [opId('grant'), reportV1]);
    assert.equal(g.expiry_source, 'settings_policy');
    const row = await one(
      `select expires_at > now() + interval '13 days' as ok
         from public.ns_customer_grants where id=$1`, [g.grant_id]);
    assert.equal(row.ok, true);
    await client.query(`delete from public.app_settings where key='customer_portal'`);
  });

  await record('F3 a past expiry is refused', async () => {
    const err = await errorOf(() => issue(
      { reportId: reportV1, expires: '2020-01-01T00:00:00Z' }));
    assert.ok(err);
    assert.equal(err.code, '22023');
  });

  await record('F4 the token is 64 hex characters and is shown once', async () => {
    const g = await issue({ reportId: reportV1 });
    tokenA = g.token;
    assert.match(tokenA, /^[0-9a-f]{64}$/);
    assert.equal(g.token_state, 'shown_once');
    assert.equal(g.token_prefix, tokenA.slice(0, 8));
  });

  await record('F5 the token is stored nowhere -- only its hash', async () => {
    const row = await one(
      `select token_hash, token_prefix from public.ns_customer_grants
        where token_hash = public.ns_capability_hash($1)`, [tokenA]);
    assert.ok(row, 'the hash must resolve');
    assert.notEqual(row.token_hash, tokenA);
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);

    /* THE WHOLE-DATABASE SWEEP. Every text and jsonb column in public is
       searched for the raw token: a receipt, an audit row or a payload
       that kept a copy would fail here rather than in somebody's log
       aggregator. The notifications payload is excluded by name, because
       an outbox message legitimately carries the link it is about to
       send -- and that exclusion is stated in the contract. */
    const hits = await all(`
      select c.table_name, c.column_name
        from information_schema.columns c
       where c.table_schema = 'public'
         and c.data_type in ('text','character varying','jsonb')
         and not (c.table_name = 'notifications' and c.column_name = 'payload')
       order by c.table_name, c.column_name`);
    const leaks = [];
    for (const h of hits) {
      const { n } = await one(
        `select count(*)::int as n from public.${h.table_name}
          where ${h.column_name}::text like '%' || $1 || '%'`, [tokenA]);
      if (n > 0) leaks.push(`${h.table_name}.${h.column_name}`);
    }
    assert.deepEqual(leaks, [], `the raw token was stored in ${leaks.join(', ')}`);
  });

  await record('F6 a replay cannot hand the token back, and says so', async () => {
    const k = opId('grant');
    const first = await issue({ reportId: reportV1, key: k });
    const again = await issue({ reportId: reportV1, key: k });
    assert.ok(first.token);
    assert.equal(again.replayed, true);
    assert.equal(again.token, null);
    assert.equal(again.token_state, 'not_recoverable');
  });

  await record('F7 a crew cannot mint a customer link', async () => {
    await beCrew();
    const err = await errorOf(() => issue({ reportId: reportV1 }));
    await beOwner();
    assert.ok(err);
    assert.equal(err.code, '42501');
  });

  await record('F8 a draft report has no link', async () => {
    const j = await wholeJob();
    const r = await generate(j.completion, opId('gen'));
    const err = await errorOf(() => issue({ reportId: r.report_id }));
    assert.ok(err, 'a draft was given a customer link');
    assert.equal(err.code, '23514');
  });

  await record('F9 a collection grant needs its customer and refuses a report',
    async () => {
      let err = await errorOf(() => issue({ scope: 'customer_collection' }));
      assert.ok(err);
      assert.match(err.message, /needs the customer/);
      err = await errorOf(() => issue(
        { scope: 'customer_collection', customerId: custA, reportId: reportV1 }));
      assert.ok(err);
      assert.match(err.message, /does not name a report/);
    });

  await record('F10 a grant is never issued against the wrong customer', async () => {
    const err = await errorOf(() => issue(
      { reportId: reportV1, customerId: custB }));
    assert.ok(err);
    assert.equal(err.code, '22023');
  });

  // ================================= G. the customer read ================
  await record('G1 the capability reads the frozen document, as anon', async () => {
    const res = await asRole('anon', () => readReport(tokenA));
    assert.equal(res.state, 'ok');
    assert.equal(res.report_id, reportV1);
    assert.equal(res.document.document_kind, 'completion_report');
    assert.ok(res.issued_at);
  });

  await record('G2 the customer read leaks nothing private either', async () => {
    const res = await asRole('anon', () => readReport(tokenA));
    const text = JSON.stringify(res);
    for (const secret of ['CREW ONLY', 'INTERNAL NOTE', 'INTERNAL CAPTION',
                          'FIXTURE Customer B', '49.1']) {
      assert.ok(!text.includes(secret), `the customer read leaked ${secret}`);
    }
    assert.ok(!text.includes('storage_path') && !text.includes('.jpg'),
      'the customer read handed over a storage path');
  });

  await record('G3 an unknown token is a state, not an exception', async () => {
    const res = await asRole('anon', () => readReport('f'.repeat(64)));
    assert.equal(res.state, 'unknown');
    assert.ok(res.message);
  });

  await record('G4 an expired token says expired', async () => {
    const g = await issue({ reportId: reportV1, expires: '2099-01-01T00:00:00Z' });
    // ns_customer_grants_expiry_after_issue keeps the window coherent, so an
    // expired grant is one whose WHOLE window is in the past.
    await client.query(
      `update public.ns_customer_grants
          set issued_at = now() - interval '2 days',
              expires_at = now() - interval '1 day'
        where id=$1`, [g.grant_id]);
    const res = await asRole('anon', () => readReport(g.token));
    assert.equal(res.state, 'expired');
  });

  await record('G5 a revoked token says withdrawn and stops reading', async () => {
    const g = await issue({ reportId: reportV1 });
    await rpc(`public.revoke_customer_grant($1,$2,'customer asked us to')`,
      [opId('rev'), g.grant_id]);
    const res = await asRole('anon', () => readReport(g.token));
    assert.equal(res.state, 'revoked');
    assert.equal(res.document, undefined);
  });

  await record('G6 a forwarded report token cannot be aimed at another document',
    async () => {
      const other = await wholeJob();
      const r = await generate(other.completion, opId('gen'));
      await publish(r.report_id, opId('publ'));
      const res = await asRole('anon', () => readReport(tokenA, r.report_id));
      assert.equal(res.state, 'out_of_scope');
      assert.equal(res.document, undefined);
    });

  await record('G7 a report token is not a collection', async () => {
    const list = await asRole('anon',
      () => rpc('public.list_customer_documents($1)', [tokenA]));
    assert.equal(list.scope, 'report');
    assert.equal(list.documents.length, 1);
    assert.equal(list.documents[0].report_id, reportV1);
  });

  let tokenCollection;
  await record('G8 a collection grant lists that customer\'s published reports only',
    async () => {
      const g = await issue({ scope: 'customer_collection', customerId: custA });
      tokenCollection = g.token;
      const list = await asRole('anon',
        () => rpc('public.list_customer_documents($1)', [tokenCollection]));
      assert.equal(list.scope, 'customer_collection');
      assert.ok(list.documents.length >= 1);
      const ids = list.documents.map(d => d.report_id);
      // Every listed report must belong to customer A.
      const rows = await all(
        `select j.customer_id from public.ns_completion_reports r
           join public.ns_jobs j on j.id = r.job_id
          where r.id = any($1::uuid[])`, [ids]);
      assert.ok(rows.every(r => r.customer_id === custA));
      // And no draft is in it.
      const states = await all(
        `select publication_state from public.ns_completion_reports
          where id = any($1::uuid[])`, [ids]);
      assert.ok(states.every(s => s.publication_state !== 'draft'));
    });

  await record('G9 customer A cannot read customer B, and cannot tell it exists',
    async () => {
      const jb = await wholeJob({ job: { customer: custB, property: propB } });
      const rb = await generate(jb.completion, opId('gen'));
      await publish(rb.report_id, opId('publ'));

      const real = await asRole('anon',
        () => readReport(tokenCollection, rb.report_id));
      const invented = await asRole('anon',
        () => readReport(tokenCollection, '00000000-0000-0000-0000-000000000000'));
      assert.equal(real.state, 'not_found');
      assert.deepEqual(real, invented,
        'another customer\'s real report must be indistinguishable from a '
        + 'made-up id');
    });

  await record('G10 a superseded report still opens, and says it was corrected',
    async () => {
      const old = await one(
        `select id from public.ns_completion_reports
          where job_id=$1 and report_version=2`, [base.job]);
      await client.query(
        `update public.ns_completion_reports
            set publication_state='published', published_at=now()
          where id=$1 and publication_state='draft'`, [old.id]);
      // v2 is already superseded by v3; issue a link against it the way an
      // earlier delivery would have.
      const g = await one(
        `insert into public.ns_customer_grants
           (customer_id, scope, report_id, token_hash, token_prefix,
            expires_at, client_operation_id)
         values ($1,'report',$2,public.ns_capability_hash($3),left($3,8),
                 now() + interval '1 day', $4)
         returning id`, [custA, old.id, 'a'.repeat(64), opId('seed')]);
      assert.ok(g.id);
      const res = await asRole('anon', () => readReport('a'.repeat(64)));
      assert.equal(res.state, 'superseded');
      assert.ok(res.document, 'the customer must still see what they were sent');
      assert.match(res.message, /corrected/);
    });

  await record('G11 a valid grant on a draft report reads unavailable, not draft',
    async () => {
      const j = await wholeJob();
      const r = await generate(j.completion, opId('gen'));
      const g = await one(
        `insert into public.ns_customer_grants
           (customer_id, scope, report_id, token_hash, token_prefix,
            expires_at, client_operation_id)
         values ($1,'report',$2,public.ns_capability_hash($3),left($3,8),
                 now() + interval '1 day', $4)
         returning id`, [custA, r.report_id, 'b'.repeat(64), opId('seed')]);
      assert.ok(g.id);
      const res = await asRole('anon', () => readReport('b'.repeat(64)));
      assert.equal(res.state, 'unavailable');
      assert.equal(res.document, undefined);
    });

  await record('G12 every read attempt is logged, and the log holds no token',
    async () => {
      const rows = await all(
        `select * from public.ns_customer_grant_reads order by id desc limit 20`);
      assert.ok(rows.length > 0);
      const cols = await all(
        `select column_name from information_schema.columns
          where table_schema='public' and table_name='ns_customer_grant_reads'`);
      const names = cols.map(c => c.column_name);
      assert.ok(!names.includes('token'));
      assert.ok(!names.includes('token_hash'));
      assert.ok(names.includes('token_prefix'));
      assert.ok(rows.some(r => r.outcome === 'unknown' && r.grant_id === null),
        'a presented token we never issued must be recorded');
    });

  // ================================ H. files by ticket ===================
  await record('H1 a published picture yields a short-lived ticket, not a URL',
    async () => {
      const doc = await asRole('anon', () => readReport(tokenA));
      const evId = doc.documents[0].evidence_id;
      const t = await asRole('anon', () => rpc(
        `public.request_customer_document($1,$2,$3)`, [tokenA, reportV1, evId]));
      assert.equal(t.state, 'ok');
      assert.ok(t.ticket_id);
      assert.equal(t.signed_url, null);
      assert.equal(t.signing_state, 'requires_worker');
      const row = await one(
        `select extract(epoch from (expires_at - issued_at)) as secs
           from public.ns_document_access_tickets where id=$1`, [t.ticket_id]);
      assert.ok(Number(row.secs) <= 120 && Number(row.secs) > 0,
        'a document ticket must be short-lived');
    });

  await record('H2 an unpublished picture yields nothing, and is indistinguishable '
    + 'from an unknown one', async () => {
      const withheld = await one(
        `select e.id from public.ns_job_evidence e
           join public.ns_evidence_publications p on p.evidence_id = e.id
          where e.job_id=$1 and p.decision='withheld' limit 1`, [base.job]);
      // base's two photos are both published by now, so make a fresh one.
      const j = await wholeJob();
      const r = await generate(j.completion, opId('gen'));
      await publish(r.report_id, opId('publ'));
      const g = await issue({ reportId: r.report_id });
      const missing = await asRole('anon', () => rpc(
        `public.request_customer_document($1,$2,$3)`,
        [g.token, r.report_id, j.evHidden]));
      const invented = await asRole('anon', () => rpc(
        `public.request_customer_document($1,$2,$3)`,
        [g.token, r.report_id, '00000000-0000-0000-0000-000000000000']));
      assert.equal(missing.state, 'not_found');
      assert.deepEqual(missing, invented);
      assert.ok(withheld === undefined || withheld.id);
    });

  await record('H3 a ticket is redeemable once, by the worker role only',
    async () => {
      const doc = await asRole('anon', () => readReport(tokenA));
      const evId = doc.documents[0].evidence_id;
      const t = await asRole('anon', () => rpc(
        `public.request_customer_document($1,$2,$3)`, [tokenA, reportV1, evId]));

      const denied = await asRole('authenticated', () => errorOf(() =>
        rpc('public.redeem_document_ticket($1)', [t.ticket_id])));
      assert.ok(denied, 'a logged-in user could redeem a customer ticket');
      assert.equal(denied.code, '42501');

      const first = await asRole('service_role', () =>
        rpc('public.redeem_document_ticket($1)', [t.ticket_id]));
      assert.equal(first.state, 'ok');
      assert.match(first.storage_path, /\.jpg$/);
      assert.equal(first.max_signed_seconds, 120);

      const again = await asRole('service_role', () =>
        rpc('public.redeem_document_ticket($1)', [t.ticket_id]));
      assert.equal(again.state, 'already_redeemed');
    });

  await record('H4 revoking the grant stops a ticket being exchanged', async () => {
    const j = await wholeJob();
    await publication(j.evShown, 'published', { caption: 'after', key: opId('pub') });
    const r = await generate(j.completion, opId('gen'));
    await publish(r.report_id, opId('publ'));
    const g = await issue({ reportId: r.report_id });
    const t = await asRole('anon', () => rpc(
      `public.request_customer_document($1,$2,$3)`,
      [g.token, r.report_id, j.evShown]));
    assert.equal(t.state, 'ok');
    await rpc(`public.revoke_customer_grant($1,$2,'test')`,
      [opId('rev'), g.grant_id]);
    const out = await asRole('service_role', () =>
      rpc('public.redeem_document_ticket($1)', [t.ticket_id]));
    assert.equal(out.state, 'revoked',
      'revocation must stop a ticket that had not been exchanged yet');
  });

  await record('H5 an expired ticket is refused', async () => {
    const doc = await asRole('anon', () => readReport(tokenA));
    const t = await asRole('anon', () => rpc(
      `public.request_customer_document($1,$2,$3)`,
      [tokenA, reportV1, doc.documents[0].evidence_id]));
    await client.query(
      `update public.ns_document_access_tickets
          set issued_at = now() - interval '10 minutes',
              expires_at = now() - interval '1 second' where id=$1`, [t.ticket_id]);
    const out = await asRole('service_role', () =>
      rpc('public.redeem_document_ticket($1)', [t.ticket_id]));
    assert.equal(out.state, 'expired');
  });

  await record('H6 a missing file is a state, and frozen evidence cannot vanish',
    async () => {
      const j = await wholeJob();
      await publication(j.evShown, 'published', { caption: 'x', key: opId('pub') });
      const r = await generate(j.completion, opId('gen'));
      await publish(r.report_id, opId('publ'));
      const g = await issue({ reportId: r.report_id });

      /* THE FIRST DRAFT OF THIS TEST deleted the evidence row to simulate a
         missing file -- and 11.1's freeze refused, correctly. An accepted
         completion's evidence cannot be deleted while it exists, so the
         dangling-evidence branch is defence, not the reachable case. */
      const refused = await errorOf(() => client.query(
        `delete from public.ns_job_evidence where id=$1`, [j.evShown]));
      assert.ok(refused, 'frozen evidence must not be deletable');

      // The case that does happen: the row is there, the object is gone.
      await client.query(
        `update public.job_attachments set storage_path = '' where id=$1`,
        [j.attShown]);
      const t = await asRole('anon', () => rpc(
        `public.request_customer_document($1,$2,$3)`,
        [g.token, r.report_id, j.evShown]));
      assert.equal(t.state, 'ok', 'authorisation is unaffected by a lost file');
      const out = await asRole('service_role', () =>
        rpc('public.redeem_document_ticket($1)', [t.ticket_id]));
      assert.equal(out.state, 'file_missing');
      assert.equal(out.storage_path, undefined,
        'a missing file must not hand back a path to guess with');
    });

  // ================================== I. delivery ========================
  let deliveryId;
  await record('I1 no SMS provider means unavailable, with the reason', async () => {
    const d = await rpc(`public.deliver_completion_report($1,$2,'sms',null)`,
      [opId('del'), reportV1]);
    assert.equal(d.delivery_state, 'unavailable');
    assert.match(d.reason, /No SMS provider/);
    assert.equal(d.sent, false);
    assert.equal(d.queued, false);
    assert.equal(d.notification_id, null);
    assert.equal(d.grant_id, null,
      'an unavailable delivery must not mint a capability nobody can be sent');
  });

  await record('I2 a configured provider queues into the existing table', async () => {
    await client.query(
      `insert into public.app_settings (key, value)
       values ('notifications', jsonb_build_object('sms_provider','FIXTURE-double'))
       on conflict (key) do update set value = excluded.value`);
    const d = await rpc(`public.deliver_completion_report($1,$2,'sms',$3::timestamptz)`,
      [opId('del'), reportV1, '2099-01-01T00:00:00Z']);
    deliveryId = d.delivery_id;
    assert.equal(d.delivery_state, 'accepted');
    assert.equal(d.sent, false, 'accepted is not sent');
    assert.equal(d.queued, true);
    assert.ok(d.notification_id);
    assert.ok(d.grant_id);
    const note = await one(`select * from public.notifications where id=$1`,
      [d.notification_id]);
    assert.equal(note.kind, 'completion_report');
    assert.equal(note.recipient, '+15550111');
    assert.match(note.payload.link_path, /^report\.html\?t=[0-9a-f]{64}$/);
  });

  await record('I3 the recipient is resolved from the job, never supplied', async () => {
    const d = await one(`select recipient from public.ns_report_deliveries where id=$1`,
      [deliveryId]);
    assert.equal(d.recipient, '+15550111');
    const args = await all(
      `select p.proname, pg_get_function_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname='deliver_completion_report'`);
    assert.ok(!/recipient|phone|email|to_number/.test(args[0].args),
      'delivery must not accept a caller-supplied destination');
  });

  await record('I4 a customer with no number is unavailable for a different reason',
    async () => {
      const j = await wholeJob({ job: { customer: custSilent, property: propA } });
      const r = await generate(j.completion, opId('gen'));
      await publish(r.report_id, opId('publ'));
      const d = await rpc(`public.deliver_completion_report($1,$2,'sms',$3::timestamptz)`,
        [opId('del'), r.report_id, '2099-01-01T00:00:00Z']);
      assert.equal(d.delivery_state, 'unavailable');
      assert.match(d.reason, /no sms on file/i);
      assert.equal(d.grant_id, null);
    });

  await record('I5 one live delivery per report', async () => {
    const err = await errorOf(() => rpc(
      `public.deliver_completion_report($1,$2,'sms',$3::timestamptz)`,
      [opId('del'), reportV1, '2099-01-01T00:00:00Z']));
    assert.ok(err, 'a second live delivery was accepted');
    assert.equal(err.code, '23505');
  });

  await record('I6 the same key replays the delivery', async () => {
    const k = opId('del');
    const j = await wholeJob();
    const r = await generate(j.completion, opId('gen'));
    await publish(r.report_id, opId('publ'));
    const a = await rpc(`public.deliver_completion_report($1,$2,'sms',$3::timestamptz)`,
      [k, r.report_id, '2099-01-01T00:00:00Z']);
    const b = await rpc(`public.deliver_completion_report($1,$2,'sms',$3::timestamptz)`,
      [k, r.report_id, '2099-01-01T00:00:00Z']);
    assert.equal(b.replayed, true);
    assert.equal(a.delivery_id, b.delivery_id);
  });

  await record('I7 a draft is not sent, and the hold is in the refusal', async () => {
    const j = await wholeJob();
    const r = await generate(j.completion, opId('gen'));
    const err = await errorOf(() => rpc(
      `public.deliver_completion_report($1,$2,'sms',$3::timestamptz)`,
      [opId('del'), r.report_id, '2099-01-01T00:00:00Z']));
    assert.ok(err);
    assert.equal(err.code, '23514');
    assert.match(err.message, /draft/);
  });

  await record('I8 a crew cannot send a customer report', async () => {
    await beCrew();
    const err = await errorOf(() => rpc(
      `public.deliver_completion_report($1,$2,'sms',$3::timestamptz)`,
      [opId('del'), reportV1, '2099-01-01T00:00:00Z']));
    await beOwner();
    assert.ok(err);
    assert.equal(err.code, '42501');
  });

  await record('I9 unknown is not success: it stays live and keeps blocking',
    async () => {
      const out = await rpc(
        `public.record_report_delivery_outcome($1,'unknown',null,'provider timed out')`,
        [deliveryId]);
      assert.equal(out.delivered, false);
      assert.equal(out.still_live, true);
      const row = await one(
        `select delivery_state, resolved_at from public.ns_report_deliveries where id=$1`,
        [deliveryId]);
      assert.equal(row.delivery_state, 'unknown');
      assert.equal(row.resolved_at, null, 'unknown has no outcome time');
      const err = await errorOf(() => rpc(
        `public.deliver_completion_report($1,$2,'sms',$3::timestamptz)`,
        [opId('del'), reportV1, '2099-01-01T00:00:00Z']));
      assert.ok(err, 'an unknown outcome must keep blocking a second message');
    });

  await record('I10 an unknown outcome is resolved under the ORIGINAL key',
    async () => {
      const out = await rpc(
        `public.record_report_delivery_outcome($1,'delivered','FIXTURE-msg-1',null)`,
        [deliveryId]);
      assert.equal(out.delivered, true);
      // reportV1 also carries I1's `unavailable` row, which queued nothing.
      // What must not fork is the message that WAS queued.
      const { n } = await one(
        `select count(*)::int as n from public.ns_report_deliveries
          where report_id=$1 and notification_id is not null`, [reportV1]);
      assert.equal(n, 1, 'resolving an uncertain outcome must not fork the delivery');
      const row = await one(
        `select id from public.ns_report_deliveries
          where report_id=$1 and notification_id is not null`, [reportV1]);
      assert.equal(row.id, deliveryId, 'the ORIGINAL row is the one resolved');
    });

  await record('I11 a provider does not un-deliver a message', async () => {
    const err = await errorOf(() => rpc(
      `public.record_report_delivery_outcome($1,'provider_failed',null,'late bounce')`,
      [deliveryId]));
    assert.ok(err);
    assert.equal(err.code, '23514');
  });

  await record('I12 a failure needs the provider\'s reason', async () => {
    const j = await wholeJob();
    const r = await generate(j.completion, opId('gen'));
    await publish(r.report_id, opId('publ'));
    const d = await rpc(`public.deliver_completion_report($1,$2,'sms',$3::timestamptz)`,
      [opId('del'), r.report_id, '2099-01-01T00:00:00Z']);
    const err = await errorOf(() => rpc(
      `public.record_report_delivery_outcome($1,'provider_failed',null,null)`,
      [d.delivery_id]));
    assert.ok(err);
    assert.equal(err.code, '22023');
    const ok = await rpc(
      `public.record_report_delivery_outcome($1,'provider_failed',null,'number unreachable')`,
      [d.delivery_id]);
    assert.equal(ok.delivery_state, 'provider_failed');
    assert.equal(ok.delivered, false);
  });

  await record('I13 an unavailable delivery has no provider outcome to record',
    async () => {
      const row = await one(
        `select id from public.ns_report_deliveries
          where delivery_state='unavailable' limit 1`);
      const err = await errorOf(() => rpc(
        `public.record_report_delivery_outcome($1,'delivered',null,null)`, [row.id]));
      assert.ok(err);
      assert.equal(err.code, '23514');
    });

  await record('I14 a crew cannot record an outcome for its own employer\'s message',
    async () => {
      await beCrew();
      const err = await errorOf(() => rpc(
        `public.record_report_delivery_outcome($1,'delivered',null,null)`, [deliveryId]));
      await beOwner();
      assert.ok(err);
      assert.equal(err.code, '42501');
    });

  await record('I15 local processing and provider time are measured separately',
    async () => {
      const t = await rpc('public.report_delivery_timing($1)', [reportV1]);
      const d = t.deliveries[0];
      assert.ok(d.accepted_at && d.readiness_at && d.report_generated_at
                && d.enqueued_at && d.resolved_at,
        'all five clocks must be present on a resolved delivery');
      assert.ok(d.local_processing_seconds !== null);
      assert.ok(d.provider_seconds !== null);
      assert.notEqual(d.local_processing_seconds, d.provider_seconds);
      assert.match(d.sla_basis, /server acceptance/);
    });

  await record('I16 an unavailable or unknown outcome is never scored as met',
    async () => {
      const row = await one(
        `select report_id from public.ns_report_deliveries
          where delivery_state='unavailable' limit 1`);
      const t = await rpc('public.report_delivery_timing($1)', [row.report_id]);
      assert.ok(t.deliveries.some(d => d.sla_state === 'indeterminate'));
      assert.ok(!t.deliveries.some(d => d.delivery_state === 'unavailable'
                                        && d.sla_state === 'met'));
    });

  await record('I17 inbound replies are unconfigured, with the rule that survives',
    async () => {
      const s = await rpc('public.ns_inbound_reply_support()', []);
      assert.equal(s.state, 'unconfigured');
      assert.equal(s.inbound_contract, 'none');
      assert.ok(s.extension_point.must_not.some(r => /access code/i.test(r)),
        'the never-disclose-an-access-code rule must be recorded');
    });

  // ============================== J. the payment boundary ================
  await record('J1 there is no settlement model, and the balance says so',
    async () => {
      const b = await rpc('public.ns_payment_balance($1)', [base.job]);
      assert.equal(Number(b.approved_total), 600);
      assert.equal(b.amount_settled, null);
      assert.equal(b.remaining_balance, null,
        'the approved total must never be presented as an outstanding balance');
      assert.equal(b.balance_state, 'no_settlement_model');
      assert.match(b.missing_dependency, /no invoice or payment-received model/);
    });

  await record('J2 no provider means the feature is unavailable', async () => {
    const r = await rpc(`public.create_payment_request($1,$2,null)`,
      [opId('pay'), base.job]);
    assert.equal(r.state, 'unavailable');
    assert.match(r.reason, /No payment provider/);
    assert.equal(r.amount, null);
    assert.equal(r.checkout_url, null);
    assert.equal(r.paid, false);
    assert.equal(r.is_payment, false);
  });

  await record('J3 with a provider but no settlement model, still unavailable',
    async () => {
      await client.query(
        `insert into public.app_settings (key, value)
         values ('payments', jsonb_build_object('provider','FIXTURE-double'))
         on conflict (key) do update set value = excluded.value`);
      const r = await rpc(`public.create_payment_request($1,$2,null)`,
        [opId('pay'), base.job]);
      assert.equal(r.state, 'unavailable');
      assert.match(r.reason, /no invoice or payment-received model/);
      assert.equal(r.amount, null);
    });

  await record('J4 a job with no accepted quote has no agreed amount to ask for',
    async () => {
      const bare = await wholeJob({ noQuote: true });
      const r = await rpc(`public.create_payment_request($1,$2,null)`,
        [opId('pay'), bare.job]);
      assert.equal(r.state, 'unavailable');
      assert.match(r.reason, /no accepted quote/);
    });

  await record('J5 WITH A LABELLED DOUBLE settlement model, the amount binds '
    + 'to the approved record', async () => {
      /* THIS IS A DOUBLE, NOT A MODEL. It is created here, inside the
         suite, to prove that ns_payment_balance binds to a settlement
         model if one ever exists. Its existence here is NOT evidence that
         the system has one -- J1 proves it does not. */
      await client.query(`
        create table public.ns_payments (
          id uuid primary key default gen_random_uuid(),
          job_id uuid not null references public.ns_jobs(id),
          amount numeric not null,
          state text not null default 'settled'
        );
        comment on table public.ns_payments is
          'FIXTURE DOUBLE created by tests/db/batch13-1.test.mjs. Not a real '
          'settlement model.';
      `);
      await client.query(
        `insert into public.ns_payments (job_id, amount) values ($1, 200)`,
        [base.job]);

      const b = await rpc('public.ns_payment_balance($1)', [base.job]);
      assert.equal(b.balance_state, 'established');
      assert.equal(Number(b.amount_settled), 200);
      assert.equal(Number(b.remaining_balance), 400);

      await client.query(
        `update public.app_settings set value = jsonb_build_object('currency','CAD')
          where key='quote_defaults'`);
      const r = await rpc(`public.create_payment_request($1,$2,null)`,
        [opId('pay'), base.job]);
      assert.equal(r.state, 'prepared');
      assert.equal(Number(r.amount), 400,
        'the bound amount is the remaining balance, not the approved total');
      assert.equal(r.currency, 'CAD');
      assert.equal(r.provider, 'FIXTURE-double');
      // STILL NOT A PAYMENT.
      assert.equal(r.checkout_url, null);
      assert.equal(r.paid, false);
      assert.equal(r.is_payment, false);
    });

  await record('J6 a stale expected amount is refused rather than re-bound',
    async () => {
      const err = await errorOf(() => rpc(
        `public.create_payment_request($1,$2,$3)`, [opId('pay'), base.job, 999]));
      assert.ok(err, 'an amount the owner never saw was requested');
      assert.equal(err.code, '23514');
      assert.match(err.message, /changed after you looked/);
    });

  await record('J7 the same key replays; the same key with a different amount '
    + 'is refused', async () => {
      const k = opId('pay');
      const a = await rpc(`public.create_payment_request($1,$2,null)`, [k, base.job]);
      const b = await rpc(`public.create_payment_request($1,$2,null)`, [k, base.job]);
      assert.equal(b.replayed, true);
      assert.equal(a.payment_request_id, b.payment_request_id);

      await client.query(
        `insert into public.ns_payments (job_id, amount) values ($1, 100)`, [base.job]);
      const err = await errorOf(() => rpc(
        `public.create_payment_request($1,$2,null)`, [k, base.job]));
      assert.ok(err, 'the same key bound a different amount');
      assert.equal(err.code, '23505');
    });

  await record('J8 a crew cannot ask a customer for money', async () => {
    await beCrew();
    const err = await errorOf(() => rpc(
      `public.create_payment_request($1,$2,null)`, [opId('pay'), base.job]));
    await beOwner();
    assert.ok(err);
    assert.equal(err.code, '42501');
  });

  await record('J9 the owner screen states what a provider still owes', async () => {
    const s = await rpc('public.job_payment_state($1)', [base.job]);
    assert.ok(s.remaining_provider_work.some(w => /webhook|authoritative API/.test(w)));
    assert.ok(s.remaining_provider_work.some(w => /settlement model/.test(w)));
    assert.ok(s.requests.every(r => r.paid === false));
  });

  await record('J10 quote pricing, totals and statuses are untouched', async () => {
    const q = await one(
      `select status, total, currency from public.ns_quotes where id=$1`, [base.quote]);
    assert.equal(q.status, 'accepted');
    assert.equal(Number(q.total), 480,
      'generating reports and preparing payments must not move a quote total');
    const cols = await all(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name='ns_quotes'`);
    const names = cols.map(c => c.column_name);
    for (const forbidden of ['paid', 'paid_at', 'payment_status']) {
      assert.ok(!names.includes(forbidden), `ns_quotes grew ${forbidden}`);
    }
    await client.query(`drop table public.ns_payments cascade`);
  });

  // ============================= K. grants, for real =====================
  await record('K1 anon cannot read any 13.1 table', async () => {
    for (const t of ['ns_completion_reports', 'ns_evidence_publications',
                     'ns_customer_grants', 'ns_customer_grant_reads',
                     'ns_document_access_tickets', 'ns_report_deliveries',
                     'ns_payment_requests', 'ns_handover_operations']) {
      const { ok } = await one(
        `select has_table_privilege('anon', 'public.' || $1, 'select') as ok`, [t]);
      assert.equal(ok, false, `anon can select ${t}`);
    }
  });

  await record('K2 even a logged-in user cannot read the token hashes', async () => {
    const { ok } = await one(
      `select has_table_privilege('authenticated','public.ns_customer_grants','select') as ok`);
    assert.equal(ok, false);
    const err = await asRole('authenticated', () => errorOf(() =>
      client.query(`select token_hash from public.ns_customer_grants limit 1`)));
    assert.ok(err, 'a logged-in user read the token hashes');
    assert.equal(err.code, '42501');
  });

  await record('K3 a direct table read does not bypass the customer scope',
    async () => {
      const err = await asRole('anon', () => errorOf(() =>
        client.query(`select document from public.ns_completion_reports limit 1`)));
      assert.ok(err);
      assert.equal(err.code, '42501');
      const err2 = await asRole('anon', () => errorOf(() =>
        client.query(`select storage_path from public.job_attachments limit 1`)));
      assert.ok(err2, 'anon could read storage paths directly');
    });

  await record('K4 the three customer functions are anon-callable, deliberately',
    async () => {
      for (const f of ['public.get_customer_report(text,uuid)',
                       'public.list_customer_documents(text)',
                       'public.request_customer_document(text,uuid,uuid)']) {
        const { ok } = await one(
          `select has_function_privilege('anon', $1, 'execute') as ok`, [f]);
        assert.equal(ok, true, `anon cannot call ${f}`);
      }
    });

  await record('K5 nothing else in 13.1 is anon-callable', async () => {
    for (const f of ['public.generate_completion_report(text,uuid)',
                     'public.publish_completion_report(text,uuid)',
                     'public.set_evidence_publication(text,uuid,text,text,text)',
                     'public.issue_customer_grant(text,text,uuid,uuid,timestamptz,text)',
                     'public.revoke_customer_grant(text,uuid,text)',
                     'public.deliver_completion_report(text,uuid,text,timestamptz)',
                     'public.record_report_delivery_outcome(uuid,text,text,text)',
                     'public.create_payment_request(text,uuid,numeric)',
                     'public.redeem_document_ticket(uuid)',
                     'public.ns_customer_report_document(uuid)',
                     'public.customer_grants(uuid,uuid)']) {
      const { ok } = await one(
        `select has_function_privilege('anon', $1, 'execute') as ok`, [f]);
      assert.equal(ok, false, `anon can call ${f}`);
    }
  });

  await record('K6 the existing customer quote access is not regressed', async () => {
    const { present } = await one(
      `select to_regprocedure('public.get_customer_quote(uuid)') is not null as present`);
    if (!present) return;             // not installed by this sequence
    const { ok } = await one(
      `select has_function_privilege('anon','public.get_customer_quote(uuid)','execute') as ok`);
    assert.equal(ok, true);
  });

  await record('K7 a crew cannot list who can read what', async () => {
    await beCrew();
    const err = await errorOf(() => rpc('public.customer_grants($1,null)', [reportV1]));
    await beOwner();
    assert.ok(err);
    assert.equal(err.code, '42501');
  });

  await record('K8 the owner\'s grant list carries prefixes, never tokens',
    async () => {
      const g = await rpc('public.customer_grants($1,null)', [reportV1]);
      assert.ok(g.grants.length > 0);
      for (const row of g.grants) {
        assert.match(row.token_prefix, /^[0-9a-f]{8}$/);
        assert.ok(!('token' in row) && !('token_hash' in row));
        assert.ok(['valid', 'expired', 'revoked'].includes(row.state));
      }
      assert.ok(g.grants.some(r => Number(r.read_count) > 0));
    });

  await record('K9 11.1\'s completion gate and evidence locks still hold',
    async () => {
      const { n } = await one(
        `select count(*)::int as n from pg_trigger
          where tgrelid='public.ns_jobs'::regclass
            and tgname='ns_jobs_completion_gate' and not tgisinternal`);
      assert.equal(n, 1);
      const err = await errorOf(() => client.query(
        `delete from public.ns_job_evidence where frozen_by_completion is not null`));
      assert.ok(err, 'frozen evidence became deletable');
    });

  await record('K10 generating and sending a report moves no stock', async () => {
    const before = await all(
      `select material_id, location_id, on_hand from public.ns_material_stock_by_location
        order by material_id, location_id`);
    const j = await wholeJob();
    const r = await generate(j.completion, opId('gen'));
    await publish(r.report_id, opId('publ'));
    await rpc(`public.deliver_completion_report($1,$2,'sms',$3::timestamptz)`,
      [opId('del'), r.report_id, '2099-01-01T00:00:00Z']);
    const after = await all(
      `select material_id, location_id, on_hand from public.ns_material_stock_by_location
        order by material_id, location_id`);
    // wholeJob() consumes stock through 11.1's own completion, which is not
    // this batch's doing; the report and the send must add nothing to that.
    const deltas = after.filter((row, i) =>
      !before[i] || Number(row.on_hand) !== Number(before[i].on_hand));
    assert.ok(deltas.length <= 1,
      'only the completion itself may have moved stock');
  });

  // ------------------------------------------------------------ report ---
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n        ${r.err}`}`);
  }
  console.log(`\n${passed}/${results.length} checks passed`);
  if (failed.length) {
    console.log('\nNO MIGRATION HAS BEEN APPLIED TO THE LIVE PROJECT.');
  }
  await client.end();
  process.exit(failed.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
