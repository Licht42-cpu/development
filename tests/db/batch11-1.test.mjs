// Batch 11.1 -- completion, evidence and material history, against a
// DEDICATED DISPOSABLE DATABASE.
//
//   node tests/db/setup-test-db.mjs
//   node tests/db/batch11-1.test.mjs
//
// What passing proves: the whole pending migration sequence applies; a job
// cannot be marked complete by writing to the table; evidence requirements
// are per service and unknown is never zero; a proposed policy cannot block
// a crew and a confirmed one can; capture claims stay apart from server
// facts; completion is one accepted event under a retry key and a changed
// payload under that key is refused; permission is checked on the replay
// too; stale job and stale policy are distinguishable; accepted evidence
// and consumption cannot be edited or deleted and late consumption needs an
// authorised reason; a reservation already consumed is not debited twice; a
// crew cannot approve its own paid change; and day-end reconciliation is
// not job consumption.
//
// What it does NOT prove: anything about the live database. NO MIGRATION IN
// THIS REPOSITORY HAS BEEN APPLIED TO PRODUCTION. The shapes of ns_jobs,
// job_attachments, ns_quotes and ns_change_orders come from
// tests/db/fixture-schema-batch11-1.sql, which is DERIVED FROM THE ADMIN
// CODE and not probed against Supabase -- see
// docs/completion-evidence-contract-v1.md §12.

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
  '20261009160000_batch5_freeze_customer_facing_content_once_sent.sql',
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
  '20261014090000_batch10_1_corrective_load_contract.sql'
];
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
const opId = (tag) => `cp-${tag}-${++seq}`;

(async () => {
  assertDisposableTarget(PGURL);
  const client = new pg.Client({ connectionString: PGURL });
  await client.connect();
  await assertDisposableDatabase(client);

  const one = async (sql, params) => (await client.query(sql, params)).rows[0];
  const all = async (sql, params) => (await client.query(sql, params)).rows;
  const rpc = async (fn, params) => (await one(`select ${fn} as r`, params)).r;

  await client.query(`
    drop table if exists public.ns_job_completion_corrections cascade;
    drop table if exists public.ns_job_consumptions cascade;
    drop table if exists public.ns_job_evidence cascade;
    drop table if exists public.ns_evidence_exceptions cascade;
    drop table if exists public.ns_job_completions cascade;
    drop table if exists public.ns_evidence_policies cascade;
    drop view  if exists public.ns_job_evidence_readiness cascade;
    drop view  if exists public.ns_job_evidence_requirements cascade;
    drop table if exists public.ns_day_reconciliation_lines cascade;
    drop table if exists public.ns_day_reconciliations cascade;
    drop table if exists public.ns_load_exceptions cascade;
    drop table if exists public.ns_load_plan_lines cascade;
    drop table if exists public.ns_load_plans cascade;
    drop table if exists public.ns_load_manual_keeps cascade;
    drop table if exists public.ns_vehicle_baselines cascade;
    drop table if exists public.ns_job_vehicle_assignments cascade;
    drop table if exists public.ns_job_load_overrides cascade;
    drop table if exists public.ns_service_load_rules cascade;
    drop view  if exists public.ns_load_plan_view cascade;
    drop view  if exists public.ns_material_piece_availability cascade;
    drop table if exists public.ns_job_material_sheet_lines cascade;
    drop table if exists public.ns_job_material_sheets cascade;
    drop table if exists public.ns_material_offcuts cascade;
    drop table if exists public.ns_kit_sheet_lines cascade;
    drop table if exists public.ns_kit_sheets cascade;
    drop view  if exists public.ns_seasonal_sets_aboard cascade;
    drop view  if exists public.ns_seasonal_set_availability cascade;
    drop table if exists public.ns_seasonal_assignments cascade;
    drop view  if exists public.ns_material_stock cascade;
    drop view  if exists public.ns_material_stock_by_location cascade;
    drop table if exists public.ns_stock_reservations cascade;
    drop table if exists public.ns_material_stock_moves cascade;
    drop table if exists public.ns_service_material_usage cascade;
    drop table if exists public.ns_purchase_order_lines cascade;
    drop table if exists public.ns_purchase_orders cascade;
    drop table if exists public.ns_rental_set_events cascade;
    drop table if exists public.ns_rental_sets cascade;
    drop table if exists public.ns_material_levels cascade;
    drop table if exists public.ns_materials cascade;
    drop table if exists public.ns_suppliers cascade;
    drop table if exists public.ns_stock_operations cascade;
    drop table if exists public.ns_crew_members cascade;
    drop table if exists public.ns_stock_locations cascade;
    drop schema if exists ns_drop_helpers cascade;
  `);
  await client.query(`
    do $$
    declare r record;
    begin
      for r in
        select p.oid::regprocedure::text as sig
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and (p.proname like 'ns\\_%' or p.proname in (
             'post_stock_movement','post_stock_transfer','reserve_stock',
             'release_stock_reservation','consume_stock_reservation',
             'estimate_job_materials','is_owner','current_crew_vehicle',
             'can_see_location','can_handle_set','can_work_job',
             'open_sealed_kit','record_offcut','consume_offcut','scrap_offcut',
             'select_job_material','review_job_material_sheet',
             'reserve_job_material_sheet','register_seasonal_set',
             'assign_seasonal_set','cancel_seasonal_assignment',
             'install_seasonal_set','recover_seasonal_set',
             'inspect_seasonal_set','release_seasonal_set',
             'record_set_renewal','retire_seasonal_set','move_seasonal_set',
             'build_load_plan','set_manual_keep','authorise_load_exception',
             'confirm_load_plan','reconcile_day_end','set_evidence_policy',
             'retire_evidence_policy','register_job_evidence',
             'authorise_evidence_exception','complete_job_with_evidence',
             'reopen_job_completion','correct_job_consumption',
             'propose_additional_work','decide_change_order'))
      loop
        execute 'drop function if exists ' || r.sig || ' cascade';
      end loop;
    end $$;
  `);

  await client.query(readFileSync(join(HERE, 'fixture-schema.sql'), 'utf8'));
  await client.query(readFileSync(join(HERE, 'fixture-schema-batch8-1.sql'), 'utf8'));
  await client.query(readFileSync(join(HERE, 'fixture-schema-batch9-1.sql'), 'utf8'));
  await client.query(readFileSync(join(HERE, 'fixture-schema-batch10-1.sql'), 'utf8'));
  await client.query(readFileSync(join(HERE, 'fixture-schema-batch11-1.sql'), 'utf8'));
  // The 7.1 fixture grants a hostile role to anon on purpose; nothing in
  // this suite tests that path, and leaving it makes every grant assertion
  // below read as a failure.
  await client.query(`revoke ns_legacy_writer from anon`);

  // ================================================= A. migrations ========
  for (const [i, file] of SEQUENCE.entries()) {
    await record(`A${i + 1} ${file} applies in sequence`, async () => {
      await client.query(migration(file));
    });
  }
  await record('A20 the 11.1 migrations are re-runnable', async () => {
    for (const f of SEQUENCE.slice(14)) await client.query(migration(f));
    for (const f of SEQUENCE.slice(14)) await client.query(migration(f));
  });

  // ---------------------------------------------------------- fixtures ----
  const ownerId = (await one('insert into auth.users default values returning id')).id;
  const crewId  = (await one('insert into auth.users default values returning id')).id;
  await client.query(`select set_config('nova.is_admin','on',false)`);
  await client.query(`select set_config('nova.actor_id',$1,false)`, [ownerId]);
  const beOwner = () => client.query(`select set_config('nova.actor_id',$1,false)`, [ownerId]);
  const beCrew  = () => client.query(`select set_config('nova.actor_id',$1,false)`, [crewId]);
  const notAdmin = () => client.query(`select set_config('nova.is_admin','off',false)`);
  const isAdmin  = () => client.query(`select set_config('nova.is_admin','on',false)`);

  const supplierId = (await one('select id from public.ns_suppliers limit 1')).id;
  const custA = (await one(
    `insert into public.customers (name) values ('FIXTURE Completion Customer') returning id`)).id;

  const carB = (await one(
    `insert into public.ns_stock_locations (code,name,kind,sort_order)
     values ('car_b','Car B','vehicle',2) returning id`)).id;

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
    `insert into public.ns_jobs (customer_id, status, scheduled_for)
     values ($1,$2,$3) returning id`,
    [custA, over.status || 'in_progress', over.when || '2026-11-20T14:00:00Z'])).id;

  const measure = (jobId, serviceId, q = 100) => client.query(
    `insert into public.job_measurements (job_id, service_id, quantity, unit)
     values ($1,$2,$3,'sq_ft')`, [jobId, serviceId, q]);

  const jobRow = (id) => one('select * from public.ns_jobs where id=$1', [id]);
  const ready  = (id) => one(
    'select * from public.ns_job_evidence_readiness where job_id=$1', [id]);
  const reqs   = (id) => all(
    `select * from public.ns_job_evidence_requirements where job_id=$1
      order by service_key, requirement`, [id]);

  /** An uploaded photo: a job_attachments row with real bytes behind it. */
  const upload = async (jobId, name) => (await one(
    `insert into public.job_attachments (job_id, storage_path, kind, size_bytes, mime_type)
     values ($1,$2,'site_photo',40960,'image/jpeg') returning id`,
    [jobId, `${jobId}/${name}.jpg`])).id;

  const evidence = (jobId, attId, requirement, over = {}) => rpc(
    `public.register_job_evidence($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9,null,$10,$11,'field_console')`,
    [opId('ev'), jobId, attId, requirement, over.serviceKey ?? null,
     'capturedAt' in over ? over.capturedAt : '2026-11-20T15:04:00Z',
     over.timeState ?? null,
     'lat' in over ? over.lat : 49.1, 'lon' in over ? over.lon : -122.8,
     over.gpsState ?? null,
     over.watermark ?? null]);

  const complete = (jobId, over = {}) => rpc(
    `public.complete_job_with_evidence($1,$2,$3,$4,$5::timestamptz,$6::jsonb,$7::jsonb,$8)`,
    [over.key ?? opId('done'), jobId,
     over.lock ?? null, over.policy ?? null,
     over.finished ?? '2026-11-20T16:30:00Z',
     JSON.stringify(over.consumption ?? []),
     JSON.stringify(over.additionalWork ?? []),
     over.note ?? null]);

  /** complete(), filling in the versions the caller would have read. */
  const completeNow = async (jobId, over = {}) => {
    const j = await jobRow(jobId);
    const pv = (await one('select public.ns_evidence_policy_version() as v')).v;
    return complete(jobId, { ...over, lock: j.lock_version, policy: pv });
  };

  const receive = (matId, qty, loc = 'base') => rpc(
    `public.post_stock_movement($1,$2,$3,$4,'received',null,null,null,null,'usable','exact')`,
    [opId('mv'), matId, loc, qty]);

  const onHand = async (matId, code = 'base') => Number((await one(
    `select coalesce(on_hand,0) as n from public.ns_material_stock_by_location
      where material_id=$1 and location_code=$2`, [matId, code])).n);

  // The two services this suite uses, with the real keys from
  // admin/js/views/measurements.js's calculator map, so the seeded proposed
  // policies attach to them exactly as they would live.
  const siding = await svc('siding', 'Siding Soft Washing');
  const lighting = await svc('permanent_lighting', 'Permanent Outdoor Lighting');
  const winter = await svc('winter_property_care', 'Winter Property Care');

  // ============================== B. policy, proposed vs confirmed ========

  await record('B1 the seeded policies are proposals, and a proposal blocks nothing',
    async () => {
      const rows = await all(
        `select spec_state, enforcement, count(*)::int as n
           from public.ns_evidence_policies where active
          group by 1,2`);
      assert.ok(rows.length > 0, 'the seed landed');
      for (const r of rows) {
        assert.equal(r.spec_state, 'proposed',
          'nothing shipped as a confirmed business rule');
        assert.equal(r.enforcement, 'advisory',
          'and nothing we guessed can refuse a completion');
      }
    });

  await record('B2 a proposed policy cannot be made blocking by a direct write',
    async () => {
      const err = await errorOf(() => client.query(
        `update public.ns_evidence_policies set enforcement='blocking'
          where active and spec_state='proposed'`));
      assert.ok(err, 'the constraint is the guarantee, not the seed values');
      assert.equal(err.code, '23514');
    });

  await record('B3 requirements are per service, and cleaning differs from lighting',
    async () => {
      const job = await newJob();
      await measure(job, siding);
      const r = await reqs(job);
      const keys = r.map((x) => `${x.service_key}:${x.requirement}`);
      assert.deepEqual(keys.sort(), ['siding:after', 'siding:before'],
        'a cleaning job is proved by a pair');

      const job2 = await newJob();
      await measure(job2, lighting);
      const r2 = (await reqs(job2)).map((x) => x.requirement).sort();
      assert.deepEqual(r2, ['component', 'installation'],
        'a lighting job proves what went up and what it was made of');

      const job3 = await newJob();
      await measure(job3, winter);
      const r3 = await reqs(job3);
      assert.equal(r3.length, 1, 'the winter check is one quick shot');
      assert.equal(r3[0].requirement, 'winter_proof');
      assert.equal(r3[0].coverage, 'per_job');
      assert.equal(r3[0].requires_geotag, false,
        'proposed OFF: a basement is not a reason to stop the work');
    });

  await record('B4 a service with no policy reads as unconfigured, never as zero',
    async () => {
      const other = await svc('graffiti_fixture_only', 'FIXTURE Unpoliced Service');
      const job = await newJob();
      await measure(job, other);

      const r = await reqs(job);
      assert.equal(r.length, 1, 'the service is still listed');
      assert.equal(r[0].state, 'unconfigured');
      assert.equal(r[0].required_count, null,
        'unknown is NULL. A zero would read as "nothing needed".');
      assert.equal(r[0].spec_state, 'unconfigured');

      const rd = await ready(job);
      assert.equal(rd.evidence_state, 'unconfigured');
      assert.deepEqual(rd.unconfigured_services, ['graffiti_fixture_only'],
        'and the caller is told which service it cannot judge');
    });

  await record('B5 only the owner writes policy, and writing it confirms it',
    async () => {
      await client.query(
        `insert into public.ns_crew_members (user_id,role,vehicle_location_id,display_name)
         values ($1,'crew',(select id from public.ns_stock_locations where code='car_a'),'FIXTURE crew')
         on conflict (user_id) do update set role='crew', active=true, vehicle_location_id=
           (select id from public.ns_stock_locations where code='car_a')`, [crewId]);
      await beCrew();
      const err = await errorOf(() => rpc(
        `public.set_evidence_policy($1,'siding','before',1,'per_service_scope',false,'blocking',null)`,
        [opId('pol')]));
      await beOwner();
      assert.ok(err, 'a crew setting its own evidence bar is no bar');
      assert.equal(err.code, '42501');

      const before = (await one('select public.ns_evidence_policy_version() as v')).v;
      const res = await rpc(
        `public.set_evidence_policy($1,'siding','before',1,'per_service_scope',false,'blocking','FIXTURE confirmed')`,
        [opId('pol')]);
      assert.equal(res.spec_state, 'owner_confirmed');
      assert.equal(res.enforcement, 'blocking');
      assert.ok(res.policy_version > before, 'the version moved');

      const row = await one(
        `select * from public.ns_evidence_policies where id=$1`, [res.policy_id]);
      assert.ok(row.confirmed_at, 'a confirmed rule carries a date');
      assert.equal(row.confirmed_by, ownerId, 'and a name');
    });

  // ============================= C. evidence registration =================

  await record('C1 evidence is registered by id, and a guessed one is refused',
    async () => {
      const job = await newJob();
      await measure(job, siding);
      const err = await errorOf(() => evidence(
        job, '00000000-0000-0000-0000-0000000000ff', 'before'));
      assert.ok(err, 'a path or id a caller invented is not evidence');
      assert.equal(err.code, 'P0002');
      assert.match(err.message, /after the upload landed/i);
    });

  await record('C2 a photo of another job is not proof of this one', async () => {
    const jobA = await newJob();
    const jobB = await newJob();
    await measure(jobA, siding);
    const att = await upload(jobB, 'somebody-elses-roof');
    const err = await errorOf(() => evidence(jobA, att, 'before'));
    assert.ok(err);
    assert.equal(err.code, '22023');
    assert.match(err.message, /another job/i);
  });

  await record('C3 an attachment row with no bytes behind it is not evidence',
    async () => {
      const job = await newJob();
      await measure(job, siding);
      const att = (await one(
        `insert into public.job_attachments (job_id, storage_path, size_bytes)
         values ($1,$2,0) returning id`, [job, `${job}/pending.jpg`])).id;
      const err = await errorOf(() => evidence(job, att, 'before'));
      assert.ok(err, 'a row created before the upload finished proves nothing');
      assert.equal(err.code, '23514');
      assert.match(err.message, /Finish the upload/i);
    });

  await record('C4 the claim and the server record are kept apart', async () => {
    const job = await newJob();
    await measure(job, siding);
    const att = await upload(job, 'before-west');
    const res = await evidence(job, att, 'before', {
      serviceKey: 'siding', watermark: 'NOVA SHIELD 2026-11-20 15:04'
    });
    const row = await one('select * from public.ns_job_evidence where id=$1',
      [res.evidence_id]);

    assert.equal(row.capture_time_state, 'device_reported');
    assert.ok(row.captured_at, 'the device said when');
    assert.ok(row.received_at, 'and the server knows when it arrived');
    assert.notEqual(row.received_at.getTime(), row.captured_at.getTime(),
      'they are different facts and are stored separately');
    assert.equal(row.registered_by, ownerId, 'attributed to a person');
    assert.equal(row.client_watermark, 'NOVA SHIELD 2026-11-20 15:04');
    assert.equal(row.upload_verified, true);
  });

  await record('C5 missing time and missing GPS have explicit states', async () => {
    const job = await newJob();
    await measure(job, siding);
    const att = await upload(job, 'no-metadata');
    const res = await evidence(job, att, 'before',
      { capturedAt: null, lat: null, lon: null, gpsState: 'denied' });
    const row = await one('select * from public.ns_job_evidence where id=$1',
      [res.evidence_id]);
    assert.equal(row.capture_time_state, 'unknown',
      'not null-as-now, and not now()');
    assert.equal(row.captured_at, null);
    assert.equal(row.gps_state, 'denied',
      'the phone was asked and said no: a different fact from unavailable');
    assert.equal(row.captured_lat, null);

    // And the pairing is a constraint, not a convention.
    const err = await errorOf(() => client.query(
      `update public.ns_job_evidence set capture_time_state='device_reported'
        where id=$1`, [res.evidence_id]));
    assert.ok(err, 'claiming a device time without one is not possible');
    assert.equal(err.code, '23514');
  });

  await record('C6 one image can cover several scopes, and is not uploaded twice',
    async () => {
      const job = await newJob();
      await measure(job, siding);
      const deck = await svc('deck', 'Deck Cleaning');
      await measure(job, deck);

      // ONE photograph, registered against both service scopes.
      const att = await upload(job, 'deck-and-siding');
      const a = await evidence(job, att, 'before', { serviceKey: 'siding' });
      const b = await evidence(job, att, 'before', { serviceKey: 'deck' });
      assert.notEqual(a.evidence_id, b.evidence_id, 'two scopes');
      assert.equal(
        (await one(`select count(distinct attachment_id)::int as n
                      from public.ns_job_evidence where job_id=$1`, [job])).n,
        1, 'one file');

      const r = await reqs(job);
      const before = r.filter((x) => x.requirement === 'before');
      assert.equal(before.length, 2);
      for (const x of before) {
        assert.equal(x.satisfied_count, 1,
          `${x.service_key} before is satisfied by the shared image`);
      }

      // The same image against the SAME scope twice is one fact.
      const again = await evidence(job, att, 'before', { serviceKey: 'siding' });
      assert.equal(again.replayed, true);
      assert.equal(again.evidence_id, a.evidence_id);
    });

  // ================================= D. completion ========================

  await record('D1 the direct table path is closed, and other transitions are not',
    async () => {
      const job = await newJob();
      // THE BYPASS api.js completeJob() used.
      let err = await errorOf(() => client.query(
        `update public.ns_jobs set status='completed', completed_at=now()
          where id=$1`, [job]));
      assert.ok(err, 'this is the hole 11.1 exists to close');
      assert.equal(err.code, '42501');
      assert.match(err.message, /complete_job_with_evidence/);

      // The status dropdown's own path, too.
      err = await errorOf(() => client.query(
        `update public.ns_jobs set status='completed' where id=$1`, [job]));
      assert.ok(err, 'and the 15-item dropdown is not a side door');
      assert.equal(err.code, '42501');

      // Everything else still works, which is the other half of the rule.
      for (const s of ['scheduled', 'in_progress', 'invoiced', 'paid', 'closed']) {
        await client.query('update public.ns_jobs set status=$1 where id=$2', [s, job]);
      }
      assert.equal((await jobRow(job)).status, 'closed',
        'legitimate transitions are untouched');
    });

  await record('D2 a completion with no configured policy is accepted and says so',
    async () => {
      const other = await svc('fixture_unpoliced_two', 'FIXTURE Unpoliced Two');
      const job = await newJob();
      await measure(job, other);
      const r = await completeNow(job);
      assert.equal(r.replayed, false);
      assert.equal(r.completion.evidence_state, 'unconfigured',
        'accepted, but the receipt records that nobody told us the rule');
      assert.equal((await jobRow(job)).status, 'completed');
      assert.ok(r.completion.advisory_shortfalls.length >= 1,
        'and names what it could not judge');
    });

  await record('D3 a confirmed blocking requirement refuses, and the evidence clears it',
    async () => {
      const job = await newJob();
      await measure(job, siding);

      // 'before' is blocking from B5; 'after' is still advisory.
      let err = await errorOf(() => completeNow(job));
      assert.ok(err, 'a confirmed rule is a gate');
      assert.equal(err.code, '23514');
      assert.match(err.message, /missing evidence the owner requires/i);
      assert.match(err.message, /siding before \(0 of 1\)/);
      assert.equal((await jobRow(job)).completed_at, null, 'and nothing was written');

      const att = await upload(job, 'before-shot');
      await evidence(job, att, 'before', { serviceKey: 'siding' });
      const r = await completeNow(job);
      assert.equal(r.completion.evidence_state, 'advisory_short',
        '`after` was still missing, which is recorded rather than refused');
      assert.equal(r.completion.evidence_count, 1);
      assert.equal(r.completion.evidence_snapshot.length, 1);
      assert.equal(r.job.status, 'completed');
      assert.deepEqual(
        r.completion.advisory_shortfalls.map((x) => x.requirement), ['after']);
    });

  await record('D4 an owner exception with a reason clears a blocking requirement',
    async () => {
      const job = await newJob();
      await measure(job, siding);

      let err = await errorOf(() => rpc(
        `public.authorise_evidence_exception($1,$2,'',null,null)`, [opId('exc'), job]));
      assert.ok(err, 'an exception without a reason is not an exception');
      assert.equal(err.code, '22023');

      await beCrew();
      err = await errorOf(() => rpc(
        `public.authorise_evidence_exception($1,$2,'camera broke','before','siding')`,
        [opId('exc'), job]));
      await beOwner();
      assert.ok(err, 'and a crew cannot excuse its own photographs');
      assert.equal(err.code, '42501');

      const ex = await rpc(
        `public.authorise_evidence_exception($1,$2,'Camera died; owner saw the work','before','siding')`,
        [opId('exc'), job]);
      assert.equal(ex.replayed, false);
      const row = await one(
        'select * from public.ns_evidence_exceptions where id=$1', [ex.exception_id]);
      assert.equal(row.authorised_by, ownerId, 'attributed');
      assert.match(row.reason, /Camera died/);

      const r = await reqs(job);
      assert.equal(r.find((x) => x.requirement === 'before').state, 'excepted');
      const done = await completeNow(job);
      assert.equal(done.job.status, 'completed');
    });

  await record('D5 the receipt is frozen and the rest of the response is current',
    async () => {
      const job = await newJob();
      await measure(job, winter);
      const att = await upload(job, 'winter-proof');
      await evidence(job, att, 'winter_proof');
      const r = await completeNow(job);

      assert.equal(r.completion.evidence_state, 'satisfied');
      assert.ok(r.completion.accepted_at, 'the receipt is dated');
      assert.equal(r.readiness.evidence_state, 'satisfied');
      assert.deepEqual(r.corrections, [], 'nothing appended yet');
      assert.deepEqual(r.additional_work, []);

      // The job moves on; the receipt does not.
      await client.query(`update public.ns_jobs set status='invoiced' where id=$1`, [job]);
      const again = await rpc('public.ns_completion_receipt($1,false)',
        [r.completion.completion_id]);
      assert.equal(again.completion.accepted_at.toISOString?.() ?? again.completion.accepted_at,
        r.completion.accepted_at.toISOString?.() ?? r.completion.accepted_at,
        'the frozen half is byte-for-byte');
      assert.equal(again.job.status, 'invoiced',
        'and the live half followed the job');
    });

  // ================================ E. retry and conflict =================

  await record('E1 the same key twice is one accepted event', async () => {
    const job = await newJob();
    await measure(job, winter);
    const att = await upload(job, 'winter');
    await evidence(job, att, 'winter_proof');

    const key = opId('done');
    const j = await jobRow(job);
    const pv = (await one('select public.ns_evidence_policy_version() as v')).v;
    const first = await complete(job, { key, lock: j.lock_version, policy: pv });
    assert.equal(first.replayed, false);

    // THE LOST RESPONSE. The client never saw the first answer and sends
    // the identical request again.
    const second = await complete(job, { key, lock: j.lock_version, policy: pv });
    assert.equal(second.replayed, true);
    assert.equal(second.completion.completion_id, first.completion.completion_id);
    assert.equal(
      (await one(`select count(*)::int as n from public.ns_job_completions
                   where job_id=$1`, [job])).n,
      1, 'one event, not two');
  });

  await record('E2 a changed payload under the same key is refused', async () => {
    const job = await newJob();
    await measure(job, winter);
    const att = await upload(job, 'winter');
    await evidence(job, att, 'winter_proof');

    const key = opId('done');
    const j = await jobRow(job);
    const pv = (await one('select public.ns_evidence_policy_version() as v')).v;
    await complete(job, { key, lock: j.lock_version, policy: pv, note: 'as reported' });

    const err = await errorOf(() => complete(job,
      { key, lock: j.lock_version, policy: pv, note: 'actually something else' }));
    assert.ok(err, 'same name, different request');
    assert.equal(err.code, '23505');
    assert.match(err.message, /used for a different completion/i);
  });

  await record('E3 a reordered consumption list is the same request', async () => {
    const a = await newMaterial('FIXTURE E3 bleach');
    const b = await newMaterial('FIXTURE E3 degreaser');
    await receive(a, 100); await receive(b, 100);
    const job = await newJob();
    await measure(job, winter);
    const att = await upload(job, 'winter');
    await evidence(job, att, 'winter_proof');

    const lines = [
      { material_id: a, location_code: 'base', quantity: 2 },
      { material_id: b, location_code: 'base', quantity: 3 }
    ];
    const key = opId('done');
    const j = await jobRow(job);
    const pv = (await one('select public.ns_evidence_policy_version() as v')).v;
    const first = await complete(job,
      { key, lock: j.lock_version, policy: pv, consumption: lines });
    const again = await complete(job,
      { key, lock: j.lock_version, policy: pv, consumption: [lines[1], lines[0]] });
    assert.equal(again.replayed, true,
      'two clients building the same lines in a different order mean the same thing');
    assert.equal(await onHand(a), 98, 'and the stock moved once');
    assert.equal(await onHand(b), 97);
  });

  await record('E4 a stale job version and stale policy are told apart', async () => {
    const job = await newJob();
    await measure(job, winter);
    const att = await upload(job, 'winter');
    await evidence(job, att, 'winter_proof');
    const j = await jobRow(job);
    const pv = (await one('select public.ns_evidence_policy_version() as v')).v;

    let err = await errorOf(() => complete(job,
      { key: opId('done'), lock: j.lock_version - 1, policy: pv }));
    assert.ok(err);
    assert.equal(err.code, '55000');
    assert.match(err.message, /has moved on since you read it/i);

    err = await errorOf(() => complete(job,
      { key: opId('done'), lock: j.lock_version, policy: pv - 1 }));
    assert.ok(err);
    assert.equal(err.code, '55000');
    assert.match(err.message, /evidence rules changed/i);

    assert.equal((await jobRow(job)).completed_at, null, 'and neither wrote');
    // Still completable once the caller re-reads.
    const ok = await completeNow(job);
    assert.equal(ok.job.status, 'completed');
  });

  await record('E5 a second completion under a different key is a duplicate, not a retry',
    async () => {
      const job = await newJob();
      await measure(job, winter);
      const att = await upload(job, 'winter');
      await evidence(job, att, 'winter_proof');
      await completeNow(job);

      const err = await errorOf(() => completeNow(job));
      assert.ok(err, 'two crews finishing the same job is not idempotence');
      assert.equal(err.code, '23505');
      assert.match(err.message, /already accepted as complete/i);
    });

  await record('E6 the job version moves when anything else touches the job',
    async () => {
      const job = await newJob();
      const v1 = (await jobRow(job)).lock_version;
      await client.query(`update public.ns_jobs set status='scheduled' where id=$1`, [job]);
      const v2 = (await jobRow(job)).lock_version;
      assert.equal(v2, v1 + 1, 'which is what makes the stale check meaningful');
    });

  // ============================== F. permissions ==========================

  await record('F1 a non-admin gets nowhere', async () => {
    const job = await newJob();
    await notAdmin();
    try {
      for (const call of [
        [`public.complete_job_with_evidence($1,$2,1,0,null,'[]'::jsonb,'[]'::jsonb,null)`, [opId('x'), job]],
        [`public.register_job_evidence($1,$2,$2,'before')`, [opId('x'), job]],
        [`public.propose_additional_work($1,$2,'extra')`, [opId('x'), job]],
        [`public.set_evidence_policy($1,'siding','before')`, [opId('x')]]
      ]) {
        const err = await errorOf(() => rpc(call[0], call[1]));
        assert.ok(err, `${call[0]} must refuse a non-admin`);
        assert.equal(err.code, '42501');
      }
    } finally { await isAdmin(); }
  });

  await record('F2 anon holds no execute on any of the nine, through all three routes',
    async () => {
      for (const f of [
        'public.complete_job_with_evidence(text,uuid,integer,integer,timestamptz,jsonb,jsonb,text)',
        'public.register_job_evidence(text,uuid,uuid,text,text,timestamptz,text,numeric,numeric,numeric,text,text,text)',
        'public.authorise_evidence_exception(text,uuid,text,text,text)',
        'public.set_evidence_policy(text,text,text,integer,text,boolean,text,text)',
        'public.retire_evidence_policy(text,text,text)',
        'public.reopen_job_completion(text,uuid,text)',
        'public.correct_job_consumption(text,uuid,uuid,text,numeric,text,text,text,uuid)',
        'public.propose_additional_work(text,uuid,text,text)',
        'public.decide_change_order(text,uuid,text,numeric,text)'
      ]) {
        assert.equal(
          (await one(`select has_function_privilege('anon',$1,'execute') as p`, [f])).p,
          false, `anon must not execute ${f}`);
      }
      // And no write grant anywhere in the history tables.
      for (const t of ['ns_job_completions', 'ns_job_evidence',
                       'ns_job_consumptions', 'ns_job_completion_corrections',
                       'ns_evidence_policies', 'ns_evidence_exceptions']) {
        for (const p of ['insert', 'update', 'delete']) {
          assert.equal(
            (await one(`select has_table_privilege('authenticated','public.'||$1,$2) as p`,
              [t, p])).p,
            false, `authenticated must not ${p} ${t}`);
        }
      }
    });

  await record('F3 a crew cannot complete the other car\'s job, on a fresh call or a replay',
    async () => {
      const job = await newJob();
      await measure(job, winter);
      const att = await upload(job, 'winter');
      await evidence(job, att, 'winter_proof');
      await client.query(
        `insert into public.ns_job_vehicle_assignments (job_id, location_id)
         values ($1,$2)`, [job, carB]);

      await beCrew();
      let err = await errorOf(() => completeNow(job));
      await beOwner();
      assert.ok(err, 'Car A does not finish Car B\'s work');
      assert.equal(err.code, '42501');

      // CROSS-CAR REPLAY. The owner completes it; the crew then presents
      // the same key. The permission question is asked on the replay too --
      // the exact shape of the seasonal review's finding 1.
      const key = opId('done');
      const j = await jobRow(job);
      const pv = (await one('select public.ns_evidence_policy_version() as v')).v;
      await complete(job, { key, lock: j.lock_version, policy: pv });

      await beCrew();
      err = await errorOf(() => complete(job,
        { key, lock: j.lock_version, policy: pv }));
      await beOwner();
      assert.ok(err, 'a replay is not a way past the scope check');
      assert.equal(err.code, '42501');
    });

  await record('F4 a key belongs to the job it was first used on', async () => {
    const jobA = await newJob();
    const jobB = await newJob();
    await measure(jobA, winter); await measure(jobB, winter);
    for (const j of [jobA, jobB]) {
      const att = await upload(j, 'winter');
      await evidence(j, att, 'winter_proof');
    }
    const key = opId('done');
    const pv = (await one('select public.ns_evidence_policy_version() as v')).v;
    await complete(jobA, { key, lock: (await jobRow(jobA)).lock_version, policy: pv });
    const lockB = (await jobRow(jobB)).lock_version;
    const err = await errorOf(() => complete(jobB, { key, lock: lockB, policy: pv }));
    assert.ok(err);
    assert.equal(err.code, '23505');
    assert.match(err.message, /already completed job/i);
  });

  // =========================== G. consumption =============================

  await record('G1 a reservation is consumed once, not debited twice', async () => {
    const mat = await newMaterial('FIXTURE G1 bleach');
    await receive(mat, 100, 'car_a');
    const job = await newJob();
    await measure(job, winter);
    const att = await upload(job, 'winter');
    await evidence(job, att, 'winter_proof');

    const res = await rpc(
      `public.reserve_stock($1,$2,'car_a',10,$3,null,null)`,
      [opId('res'), mat, job]);
    const resId = res.reservation_id;
    assert.equal(await onHand(mat, 'car_a'), 100, 'a reservation moves nothing');

    const r = await completeNow(job, {
      consumption: [{ material_id: mat, location_code: 'car_a', quantity: 10 }]
    });
    assert.equal(await onHand(mat, 'car_a'), 90, 'ONE debit');
    assert.equal(
      (await one(`select status from public.ns_stock_reservations where id=$1`,
        [resId])).status,
      'consumed', 'and the claim is closed by it');
    assert.equal(r.completion.consumption_snapshot.length, 1);
    assert.equal(
      (await one(`select count(*)::int as n from public.ns_material_stock_moves
                   where material_id=$1 and reason='consumed'`, [mat])).n,
      1, 'exactly one consumed movement exists');
  });

  await record('G2 a reservation already consumed is linked, never debited again',
    async () => {
      const mat = await newMaterial('FIXTURE G2 bleach');
      await receive(mat, 100, 'car_a');
      const job = await newJob();
      await measure(job, winter);
      const att = await upload(job, 'winter');
      await evidence(job, att, 'winter_proof');

      const res = await rpc(
        `public.reserve_stock($1,$2,'car_a',12,$3,null,null)`,
        [opId('res'), mat, job]);
      // Something already consumed it -- an earlier call, or the load.
      await rpc(`public.consume_stock_reservation($1,$2,12,'exact',null)`,
        [opId('use'), res.reservation_id]);
      assert.equal(await onHand(mat, 'car_a'), 88);

      const r = await completeNow(job, {
        consumption: [{ material_id: mat, location_code: 'car_a', quantity: 12 }]
      });
      assert.equal(await onHand(mat, 'car_a'), 88,
        'THE DOUBLE DEBIT. 88 and not 76.');
      const line = r.completion.consumption_snapshot[0];
      assert.ok(line.operation_id, 'the line still points at the debit that happened');
      assert.equal(line.reservation_id, res.reservation_id);
    });

  await record('G3 using more than was reserved debits the excess once', async () => {
    const mat = await newMaterial('FIXTURE G3 bleach');
    await receive(mat, 100, 'car_a');
    const job = await newJob();
    await measure(job, winter);
    const att = await upload(job, 'winter');
    await evidence(job, att, 'winter_proof');
    await rpc(`public.reserve_stock($1,$2,'car_a',5,$3,null,null)`,
      [opId('res'), mat, job]);

    await completeNow(job, {
      consumption: [{ material_id: mat, location_code: 'car_a', quantity: 8 }]
    });
    assert.equal(await onHand(mat, 'car_a'), 92,
      'the reservation covered 5 and the other 3 is still a real debit');
  });

  await record('G4 a level-tracked supply never acquires a number', async () => {
    const mat = await newMaterial('FIXTURE G4 rinse aid',
      { unit: 'level', tracking_mode: 'level', category: 'consumable' });
    const job = await newJob();
    await measure(job, winter);
    const att = await upload(job, 'winter');
    await evidence(job, att, 'winter_proof');

    let err = await errorOf(() => completeNow(job, {
      consumption: [{ material_id: mat, location_code: 'car_a', quantity: 1 }]
    }));
    assert.ok(err, 'a "1" for a part-used jug is the blur this prevents');
    assert.equal(err.code, '22023');
    assert.match(err.message, /tracked as a level/i);

    err = await errorOf(() => completeNow(job, {
      consumption: [{ material_id: mat, location_code: 'car_a' }]
    }));
    assert.ok(err, 'and it still has to say something');
    assert.equal(err.code, '22023');

    const r = await completeNow(job, {
      consumption: [{ material_id: mat, location_code: 'car_a', level: 'low' }]
    });
    const line = r.completion.consumption_snapshot[0];
    assert.equal(line.level, 'low');
    assert.equal(line.quantity, null);
    assert.equal(line.operation_id, null,
      'an observation posts no movement: the ledger is quantitative');
  });

  await record('G5 consumption is attributed, and the exact/estimated distinction survives',
    async () => {
      const mat = await newMaterial('FIXTURE G5 bleach');
      await receive(mat, 50, 'car_a');
      const job = await newJob();
      await measure(job, winter);
      const att = await upload(job, 'winter');
      await evidence(job, att, 'winter_proof');
      await completeNow(job, {
        consumption: [{ material_id: mat, location_code: 'car_a',
                        quantity: 4, count_precision: 'estimated' }]
      });
      const row = await one(
        `select * from public.ns_job_consumptions where job_id=$1`, [job]);
      assert.equal(row.recorded_by, ownerId);
      assert.equal(row.count_precision, 'estimated',
        'a guess stays a guess all the way through');
      assert.equal(
        (await one(`select count_precision from public.ns_material_stock_moves
                     where material_id=$1`, [mat])).count_precision,
        'estimated', 'and the ledger agrees');
    });

  // ============================== H. immutability =========================

  await record('H1 an accepted completion cannot be edited or deleted', async () => {
    const job = await newJob();
    await measure(job, winter);
    const att = await upload(job, 'winter');
    await evidence(job, att, 'winter_proof');
    const r = await completeNow(job);
    const id = r.completion.completion_id;

    for (const sql of [
      `update public.ns_job_completions set note='rewritten' where id=$1`,
      `update public.ns_job_completions set accepted_at=now() where id=$1`,
      `delete from public.ns_job_completions where id=$1`
    ]) {
      const err = await errorOf(() => client.query(sql, [id]));
      assert.ok(err, `${sql} must be refused`);
      assert.equal(err.code, '42501');
      assert.match(err.message, /not (editable|deletable)/);
    }
  });

  await record('H2 frozen evidence cannot be removed or re-purposed', async () => {
    const job = await newJob();
    await measure(job, winter);
    const att = await upload(job, 'winter');
    const ev = await evidence(job, att, 'winter_proof');
    await completeNow(job);

    const row = await one('select * from public.ns_job_evidence where id=$1',
      [ev.evidence_id]);
    assert.ok(row.frozen_by_completion, 'the reference was frozen at acceptance');

    let err = await errorOf(() => client.query(
      `delete from public.ns_job_evidence where id=$1`, [ev.evidence_id]));
    assert.ok(err); assert.equal(err.code, '42501');

    err = await errorOf(() => client.query(
      `update public.ns_job_evidence set requirement='before' where id=$1`,
      [ev.evidence_id]));
    assert.ok(err, 'nor pointed at a different purpose after the fact');
    assert.equal(err.code, '42501');
  });

  await record('H3 accepted consumption cannot be edited, deleted or quietly added to',
    async () => {
      const mat = await newMaterial('FIXTURE H3 bleach');
      await receive(mat, 60, 'car_a');
      const job = await newJob();
      await measure(job, winter);
      const att = await upload(job, 'winter');
      await evidence(job, att, 'winter_proof');
      await completeNow(job, {
        consumption: [{ material_id: mat, location_code: 'car_a', quantity: 6 }]
      });
      const line = await one(
        `select * from public.ns_job_consumptions where job_id=$1`, [job]);

      let err = await errorOf(() => client.query(
        `update public.ns_job_consumptions set quantity=1 where id=$1`, [line.id]));
      assert.ok(err); assert.equal(err.code, '42501');

      err = await errorOf(() => client.query(
        `delete from public.ns_job_consumptions where id=$1`, [line.id]));
      assert.ok(err); assert.equal(err.code, '42501');

      // LATE CONSUMPTION, the quiet second debit.
      err = await errorOf(() => client.query(
        `insert into public.ns_job_consumptions
           (job_id, material_id, location_id, quantity, unit)
         values ($1,$2,(select id from public.ns_stock_locations where code='car_a'),9,'litre')`,
        [job, mat]));
      assert.ok(err, 'adding a used-material line afterwards is a correction');
      assert.equal(err.code, '42501');
      assert.match(err.message, /already accepted as complete/i);
    });

  await record('H4 a correction appends, is attributed and carries a reason',
    async () => {
      const mat = await newMaterial('FIXTURE H4 bleach');
      await receive(mat, 60, 'car_a');
      const job = await newJob();
      await measure(job, winter);
      const att = await upload(job, 'winter');
      await evidence(job, att, 'winter_proof');
      const r = await completeNow(job, {
        consumption: [{ material_id: mat, location_code: 'car_a', quantity: 10 }]
      });
      const id = r.completion.completion_id;
      const original = await one(
        `select * from public.ns_job_consumptions where job_id=$1`, [job]);
      assert.equal(await onHand(mat, 'car_a'), 50);

      // A crew cannot.
      await beCrew();
      let err = await errorOf(() => rpc(
        `public.correct_job_consumption($1,$2,$3,'miscounted',-3,null,'car_a','exact',$4)`,
        [opId('fix'), id, mat, original.id]));
      await beOwner();
      assert.ok(err); assert.equal(err.code, '42501');

      // Nor can the owner without a reason.
      err = await errorOf(() => rpc(
        `public.correct_job_consumption($1,$2,$3,'',-3,null,'car_a','exact',$4)`,
        [opId('fix'), id, mat, original.id]));
      assert.ok(err); assert.equal(err.code, '22023');

      // -3 means "we reported three litres more than we used", so three
      // litres are still on the shelf: 50 + 3. The ledger moves the
      // OPPOSITE way from the consumption record, which is the one thing
      // here that is easy to get backwards.
      const fixed = await rpc(
        `public.correct_job_consumption($1,$2,$3,'Recounted the jug: three litres went back',-3,null,'car_a','exact',$4)`,
        [opId('fix'), id, mat, original.id]);
      assert.equal(await onHand(mat, 'car_a'), 53,
        'the correction moves stock as an adjustment, not a second consumption');
      assert.equal(
        (await one(`select count(*)::int as n from public.ns_material_stock_moves
                     where material_id=$1 and reason='consumed'`, [mat])).n,
        1, 'the original consumption still stands as history');

      const lines = await all(
        `select * from public.ns_job_consumptions where job_id=$1 order by recorded_at`, [job]);
      assert.equal(lines.length, 2, 'appended, not rewritten');
      assert.equal(Number(lines[0].quantity), 10, 'the original is untouched');
      assert.equal(Number(lines[1].quantity), -3);
      assert.equal(lines[1].corrects, original.id, 'and links back to it');
      assert.match(lines[1].correction_reason, /Recounted the jug/);

      assert.equal(fixed.corrections.length, 1);
      assert.equal(fixed.corrections[0].kind, 'consumption_corrected');
      assert.equal(fixed.corrections[0].authorised_by, ownerId);
    });

  await record('H5 reopening is owner-only, reasoned, appended, and allows one more completion',
    async () => {
      const job = await newJob();
      await measure(job, winter);
      const att = await upload(job, 'winter');
      await evidence(job, att, 'winter_proof');
      const r = await completeNow(job);
      const id = r.completion.completion_id;

      await beCrew();
      let err = await errorOf(() => rpc(
        `public.reopen_job_completion($1,$2,'wrong house')`, [opId('re'), id]));
      await beOwner();
      assert.ok(err, 'a crew that could reopen could complete twice');
      assert.equal(err.code, '42501');

      err = await errorOf(() => rpc(
        `public.reopen_job_completion($1,$2,'   ')`, [opId('re'), id]));
      assert.ok(err); assert.equal(err.code, '22023');

      const re = await rpc(
        `public.reopen_job_completion($1,$2,'Customer says the back elevation was missed')`,
        [opId('re'), id]);
      assert.equal(re.corrections.length, 1);
      assert.equal(re.corrections[0].kind, 'reopen');
      assert.match(re.corrections[0].reason, /back elevation/);

      const j = await jobRow(job);
      assert.equal(j.status, 'in_progress');
      assert.equal(j.completed_at, null, 'and the stamp is cleared');
      assert.equal(
        (await one(`select note from public.ns_job_completions where id=$1`, [id])).note,
        r.completion.note, 'while the original receipt is untouched');

      const again = await completeNow(job);
      assert.notEqual(again.completion.completion_id, id, 'a second cycle');
      assert.equal(again.completion.supersedes_corrections, 1,
        'which the row records, so "one open completion" stays a database rule');
      assert.equal((await jobRow(job)).status, 'completed');
    });

  await record('H6 completed_at cannot be set to a time the caller chose', async () => {
    const job = await newJob();
    await measure(job, winter);
    const att = await upload(job, 'winter');
    await evidence(job, att, 'winter_proof');
    await completeNow(job);

    const err = await errorOf(() => client.query(
      `update public.ns_jobs set completed_at='2020-01-01T00:00:00Z' where id=$1`,
      [job]));
    assert.ok(err, 'the completion time is the receipt\'s');
    assert.equal(err.code, '23514');

    const err2 = await errorOf(() => client.query(
      `update public.ns_jobs set completed_at=null where id=$1`, [job]));
    assert.ok(err2, 'and it cannot be quietly cleared either');
    assert.equal(err2.code, '23514');
    assert.match(err2.message, /Reopen it with a reason/i);
  });

  // ============================ I. quote protection =======================

  await record('I1 a crew proposes extra work unpriced and cannot approve it',
    async () => {
      const job = await newJob();
      await measure(job, winter);
      const quote = (await one(
        `insert into public.ns_quotes (job_id,status,total) values ($1,'sent',900)
         returning id`, [job])).id;

      await beCrew();
      const p = await rpc(
        `public.propose_additional_work($1,$2,'Gutters are packed solid; needs a clean',null)`,
        [opId('aw'), job]);
      assert.equal(p.status, 'proposed');
      assert.equal(p.pricing_state, 'unpriced',
        'a crew does not name a price, and null is not zero');

      const err = await errorOf(() => rpc(
        `public.decide_change_order($1,$2,'approved',400,null)`,
        [opId('dec'), p.change_order_id]));
      await beOwner();
      assert.ok(err, 'approving its own paid change is the hole this closes');
      assert.equal(err.code, '42501');

      // Nor by the direct table path the browser used to use. This suite
      // connects as the table owner, which no grant can stop, so the
      // assertion is on the PRIVILEGE rather than on a statement: it is
      // `authenticated` that the browser runs as.
      for (const priv of ['insert', 'update', 'delete']) {
        assert.equal(
          (await one(`select has_table_privilege('authenticated',
                        'public.ns_change_orders',$1) as p`, [priv])).p,
          false, `authenticated must not ${priv} ns_change_orders`);
      }

      const ok = await rpc(
        `public.decide_change_order($1,$2,'approved',400,'agreed on the phone')`,
        [opId('dec'), p.change_order_id]);
      assert.equal(ok.status, 'approved');
      assert.equal(Number(ok.amount), 400);
      assert.equal(
        (await one(`select approved_by from public.ns_change_orders where id=$1`,
          [p.change_order_id])).approved_by,
        ownerId, 'attributed to the person who agreed it');
      assert.equal(Number((await one(
        `select total from public.ns_quotes where id=$1`, [quote])).total),
        900, 'and the sent quote\'s own money never moved');
    });

  await record('I2 an approved change order cannot be unpriced', async () => {
    const job = await newJob();
    const p = await rpc(`public.propose_additional_work($1,$2,'Extra bit',null)`,
      [opId('aw'), job]);
    const err = await errorOf(() => rpc(
      `public.decide_change_order($1,$2,'approved',null,null)`,
      [opId('dec'), p.change_order_id]));
    assert.ok(err, 'approved money with no figure is not money');
    assert.equal(err.code, '22023');

    // And the CHECK is the guarantee, not the function: approved money
    // with no figure is refused even by the table owner.
    const err2 = await errorOf(() => client.query(
      `insert into public.ns_change_orders (description, amount, status)
       values ('FIXTURE direct', null, 'approved')`));
    assert.ok(err2, 'ns_change_orders_approved_is_priced');
    assert.equal(err2.code, '23514');
  });

  await record('I3 completion records additional work as a proposal, never an approval',
    async () => {
      const job = await newJob();
      await measure(job, winter);
      const att = await upload(job, 'winter');
      await evidence(job, att, 'winter_proof');

      const r = await completeNow(job, {
        additionalWork: [{ description: 'Second storey windows need doing' }]
      });
      assert.equal(r.additional_work.length, 1);
      assert.equal(r.additional_work[0].status, 'proposed');
      assert.equal(r.additional_work[0].amount, null);
      assert.equal(r.additional_work[0].pricing_state, 'unpriced',
        'completion does not silently approve or price extra work');
    });

  await record('I4 the sent-quote content freeze still holds', async () => {
    const job = await newJob();
    const quote = (await one(
      `insert into public.ns_quotes (job_id,status,customer_notes,terms,internal_notes)
       values ($1,'sent','as agreed','net 30','scratch') returning id`, [job])).id;

    let err = await errorOf(() => client.query(
      `update public.ns_quotes set customer_notes='something else' where id=$1`, [quote]));
    assert.ok(err, 'Batch 5/7.1 freeze, unchanged by 11.1');
    assert.equal(err.code, '23514');

    err = await errorOf(() => client.query(
      `update public.ns_quotes set status='draft' where id=$1`, [quote]));
    assert.ok(err, 'including the demote-then-edit route');

    // And internal notes stay editable, which is the point of them.
    await client.query(
      `update public.ns_quotes set internal_notes='crew says gutters too' where id=$1`,
      [quote]);
    assert.equal(
      (await one(`select internal_notes from public.ns_quotes where id=$1`, [quote]))
        .internal_notes,
      'crew says gutters too');
  });

  // ====================== J. day-end is not job completion ================

  await record('J1 vehicle-day reconciliation is not job consumption and freezes nothing',
    async () => {
      const mat = await newMaterial('FIXTURE J1 bleach');
      await receive(mat, 40, 'car_a');
      const job = await newJob({ when: '2026-11-28T14:00:00Z', status: 'scheduled' });
      await measure(job, winter);

      await rpc(`public.reconcile_day_end($1,'car_a',$2::date,$3::jsonb,'counted')`,
        [opId('rec'), '2026-11-28',
         JSON.stringify([{ material_id: mat, counted_qty: 38,
                           variance_reason: 'used_more' }])]);

      // It posted an adjustment attributed to the DAY, not to a job.
      const moves = await all(
        `select reason, job_id from public.ns_material_stock_moves
          where material_id=$1 and reason <> 'received'`, [mat]);
      assert.ok(moves.length >= 1, 'the count did move stock');
      for (const m of moves) {
        assert.equal(m.reason, 'adjustment',
          'a day count is an adjustment, not a consumption');
        assert.equal(m.job_id, null, 'and belongs to no job');
      }

      assert.equal(
        (await one(`select count(*)::int as n from public.ns_job_consumptions
                     where job_id=$1`, [job])).n,
        0, 'it wrote no job consumption history');
      assert.equal((await jobRow(job)).completed_at, null,
        'and it did not complete or freeze the job');
      assert.equal(
        (await one(`select public.ns_job_completion_is_open($1) as o`, [job])).o,
        false);
    });

  // ================================================== report ==============
  await client.end();

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.err}`}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
})().catch((err) => { console.error(err); process.exit(1); });
