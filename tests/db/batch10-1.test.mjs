// Batch 10.1 -- daily vehicle load planning, against a DEDICATED DISPOSABLE
// DATABASE.
//
//   node tests/db/setup-test-db.mjs
//   node tests/db/batch10-1.test.mjs
//
// What passing proves: the whole pending migration sequence applies; a plan
// derives Keep/Add/Return across a WHOLE DAY rather than per job; a shared
// tool is decided once; a no-bleach day returns the removable kit unless a
// manual Keep or another job holds it; recommendations, commitments,
// confirmed transfers and consumption stay four distinct things; an
// obsolete confirmation is refused with the reason; level supplies never
// acquire a number; and the owner/crew split is enforced in the backend.
//
// What it does NOT prove: anything about the live database. NO MIGRATION IN
// THIS REPOSITORY HAS BEEN APPLIED TO PRODUCTION.

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
  '20261011111000_batch10_1_load_operations.sql'
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
const opId = (tag) => `ld-${tag}-${++seq}`;
const DAY = '2026-11-12';
const OTHER_DAY = '2026-11-13';

(async () => {
  assertDisposableTarget(PGURL);
  const client = new pg.Client({ connectionString: PGURL });
  await client.connect();
  await assertDisposableDatabase(client);

  const one = async (sql, params) => (await client.query(sql, params)).rows[0];
  const all = async (sql, params) => (await client.query(sql, params)).rows;
  const rpc = async (fn, params) => (await one(`select ${fn} as r`, params)).r;

  await client.query(`
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
  // Functions are dropped wholesale: this suite applies the entire sequence
  // and anything left from a previous run would be tested instead of it.
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
             'can_see_location','can_handle_set','open_sealed_kit',
             'record_offcut','consume_offcut','scrap_offcut',
             'select_job_material','review_job_material_sheet',
             'reserve_job_material_sheet','register_seasonal_set',
             'assign_seasonal_set','cancel_seasonal_assignment',
             'install_seasonal_set','recover_seasonal_set',
             'inspect_seasonal_set','release_seasonal_set',
             'record_set_renewal','retire_seasonal_set','build_load_plan',
             'set_manual_keep','authorise_load_exception','confirm_load_plan',
             'reconcile_day_end'))
      loop
        execute 'drop function if exists ' || r.sig || ' cascade';
      end loop;
    end $$;
  `);

  await client.query(readFileSync(join(HERE, 'fixture-schema-batch8-1.sql'), 'utf8'));
  await client.query(readFileSync(join(HERE, 'fixture-schema-batch9-1.sql'), 'utf8'));
  await client.query(readFileSync(join(HERE, 'fixture-schema-batch10-1.sql'), 'utf8'));

  // ================================================= A. migrations ========
  for (const [i, file] of SEQUENCE.entries()) {
    await record(`A${i + 1} ${file} applies in sequence`, async () => {
      await client.query(migration(file));
    });
  }
  await record('A12 the 10.1 migrations are re-runnable', async () => {
    for (const f of SEQUENCE.slice(9)) await client.query(migration(f));
    for (const f of SEQUENCE.slice(9)) await client.query(migration(f));
  });

  const ownerId = (await one('insert into auth.users default values returning id')).id;
  const crewId  = (await one('insert into auth.users default values returning id')).id;
  await client.query(`select set_config('nova.is_admin','on',false)`);
  await client.query(`select set_config('nova.actor_id',$1,false)`, [ownerId]);
  const beOwner = () => client.query(`select set_config('nova.actor_id',$1,false)`, [ownerId]);
  const beCrew  = () => client.query(`select set_config('nova.actor_id',$1,false)`, [crewId]);

  const supplierId = (await one('select id from public.ns_suppliers limit 1')).id;
  const custA = (await one(
    `insert into public.customers (name) values ('FIXTURE Load Customer') returning id`)).id;

  const newMaterial = async (name, over = {}) => (await one(
    `insert into public.ns_materials
       (name,category,unit,supplier_id,pack_quantity,reorder_point,reorder_qty,tracking_mode)
     values ($1,$2,$3,$4,1,0,0,$5) returning id`,
    [name, over.category || 'tool', over.unit || 'each', supplierId,
     over.tracking_mode || 'quantity'])).id;

  const svc = async (key, name) => (await one(
    `insert into public.services (key,name,unit) values ($1,$2,'sq_ft')
     on conflict (key) do update set name=excluded.name returning id`, [key, name])).id;

  const newJob = async (when, over = {}) => (await one(
    `insert into public.ns_jobs (customer_id, scheduled_for, status)
     values ($1,$2,$3) returning id`,
    [custA, `${when}T14:00:00Z`, over.status || 'scheduled'])).id;

  const measure = (jobId, serviceId, q) => client.query(
    `insert into public.job_measurements (job_id, service_id, quantity, unit)
     values ($1,$2,$3,'sq_ft')`, [jobId, serviceId, q]);

  const rule = (serviceId, materialId, over = {}) => client.query(
    `insert into public.ns_service_load_rules
       (service_id, material_id, rule_kind, quantity_fixed, quantity_per_unit,
        allowance_state, removable, always_keep)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (service_id, material_id) do update
        set rule_kind=excluded.rule_kind, quantity_fixed=excluded.quantity_fixed,
            quantity_per_unit=excluded.quantity_per_unit,
            allowance_state=excluded.allowance_state,
            removable=excluded.removable, always_keep=excluded.always_keep`,
    [serviceId, materialId, over.kind || 'equipment', over.fixed ?? null,
     over.perUnit ?? null, over.allowance || 'reviewed',
     over.removable ?? false, over.alwaysKeep ?? false]);

  const receive = (matId, qty, loc = 'base') => rpc(
    `public.post_stock_movement($1,$2,$3,$4,'received',null,null,null,null,'usable','exact')`,
    [opId('mv'), matId, loc, qty]);

  const buildPlan = (code, day) => rpc(
    `public.build_load_plan($1,$2,$3::date,null)`, [opId('plan'), code, day]);

  const lineFor = (plan, name) =>
    plan.lines.find((l) => l.material_name === name);

  // The two real services this business runs on, named as the roadmap does.
  const siding = await svc('siding_soft_wash', 'Siding Soft Washing');
  const windows = await svc('window_cleaning', 'Window Cleaning');

  const washer = await newMaterial('FIXTURE pressure washer');
  const bleachKit = await newMaterial('FIXTURE removable bleach kit');
  const toolKit = await newMaterial('FIXTURE standard tool kit');
  const soap = await newMaterial('FIXTURE soft-wash product', {
    category: 'consumable', unit: 'litre' });
  // A level-tracked supply must carry unit 'level' -- Batch 8.1 ties the two
  // together so a product cannot be counted in litres AND reported as "Low".
  const rinseAid = await newMaterial('FIXTURE rinse aid', {
    category: 'consumable', unit: 'level', tracking_mode: 'level' });

  await rule(siding, washer);                              // shared tool
  await rule(siding, bleachKit, { removable: true });       // comes off on a dry day
  await rule(windows, toolKit, { alwaysKeep: true });       // never leaves
  await rule(siding, soap, { kind: 'consumable', perUnit: 0.01 });
  await rule(siding, rinseAid, { kind: 'consumable', fixed: 1 });

  await receive(washer, 1);
  await receive(bleachKit, 1);
  await receive(toolKit, 1);
  await receive(soap, 200);

  // ============================================ B. the day's plan =========
  await record('B1 a plan is for a vehicle, never for Base', async () => {
    const err = await errorOf(() => buildPlan('base', DAY));
    assert.ok(err); assert.equal(err.code, '22023');
    assert.match(err.message, /loaded FROM/i);
  });

  await record('B2 a siding day puts the washer and the soft-wash product on the van',
    async () => {
      const j = await newJob(DAY);
      await measure(j, siding, 1000);
      const plan = await buildPlan('car_a', DAY);
      assert.equal(plan.revision, 1);
      const w = lineFor(plan, 'FIXTURE pressure washer');
      assert.ok(w, 'the washer must be on the plan');
      assert.equal(w.action, 'add');
      assert.equal(w.line_kind, 'equipment');
      const s = lineFor(plan, 'FIXTURE soft-wash product');
      assert.equal(s.line_kind, 'consumable');
      assert.equal(Number(s.required_qty), 10, '1000 sq ft at 0.01 L each');
      assert.equal(s.action, 'add');
    });

  await record('B3 a shared tool is decided ONCE for the day, not once per job',
    async () => {
      const j2 = await newJob(DAY);
      const j3 = await newJob(DAY);
      await measure(j2, siding, 500);
      await measure(j3, siding, 500);
      const plan = await buildPlan('car_a', DAY);
      const washerLines = plan.lines.filter(
        (l) => l.material_name === 'FIXTURE pressure washer');
      assert.equal(washerLines.length, 1,
        'three siding stops is still one washer decision');
      assert.ok(washerLines[0].job_ids.length >= 2,
        'and it names the stops that need it');
    });

  await record('B4 consumables are summed across the day, tools are not', async () => {
    const plan = await buildPlan('car_a', DAY);
    const s = lineFor(plan, 'FIXTURE soft-wash product');
    assert.equal(Number(s.required_qty), 20, '2000 sq ft total at 0.01 L each');
  });

  await record('B5 an always-keep item stays aboard with no job needing it', async () => {
    const plan = await buildPlan('car_a', DAY);
    const t = lineFor(plan, 'FIXTURE standard tool kit');
    assert.ok(t, 'the standard kit is on every plan');
    assert.match(t.reason, /always keep/i);
    assert.notEqual(t.action, 'return');
  });

  await record('B6 a level-tracked supply gets a level and NEVER a number', async () => {
    await client.query(
      `insert into public.ns_material_levels (material_id, location_id, state)
       values ($1,(select id from public.ns_stock_locations where code='car_a'),'low')
       on conflict (material_id,location_id) do update set state='low'`, [rinseAid]);
    const plan = await buildPlan('car_a', DAY);
    const r = lineFor(plan, 'FIXTURE rinse aid');
    assert.ok(r);
    assert.equal(r.level_state, 'low');
    for (const f of ['required_qty', 'aboard_qty', 'available_qty', 'shortage_qty']) {
      assert.equal(r[f], null, `${f} must stay null for a level supply`);
    }
  });

  await record('B7 the six quantities are reported separately', async () => {
    const plan = await buildPlan('car_a', DAY);
    const s = lineFor(plan, 'FIXTURE soft-wash product');
    for (const f of ['required_qty', 'aboard_qty', 'reserved_qty', 'available_qty',
                     'damaged_qty', 'shortage_qty']) {
      assert.ok(f in s, `${f} is missing from the line`);
    }
    assert.equal(Number(s.aboard_qty), 0);
    assert.equal(Number(s.available_qty), 200, 'Base can cover it');
    assert.equal(Number(s.shortage_qty), 0);
  });

  await record('B8 a shortage is reported when nobody has it', async () => {
    const scarce = await newMaterial('FIXTURE scarce product', {
      category: 'consumable', unit: 'litre' });
    await rule(siding, scarce, { kind: 'consumable', fixed: 50 });
    const plan = await buildPlan('car_a', DAY);
    const sc = lineFor(plan, 'FIXTURE scarce product');
    assert.ok(Number(sc.shortage_qty) > 0);
    assert.equal(sc.data_state, 'complete', 'a known shortage is not missing data');
    await client.query(`delete from public.ns_service_load_rules
                         where material_id=$1`, [scarce]);
  });

  await record('B9 an unreviewed allowance is flagged, not presented as a figure',
    async () => {
      const guess = await newMaterial('FIXTURE unreviewed product', {
        category: 'consumable', unit: 'litre' });
      await rule(siding, guess, {
        kind: 'consumable', fixed: 5, allowance: 'provisional' });
      const plan = await buildPlan('car_a', DAY);
      const g = lineFor(plan, 'FIXTURE unreviewed product');
      assert.equal(g.data_state, 'needs_review');
      assert.equal(g.precision, 'estimated');
      assert.match(g.reason, /not reviewed/i);
      await client.query(`delete from public.ns_service_load_rules
                           where material_id=$1`, [guess]);
    });

  await record('B10 a required consumable with no allowance reads as unknown', async () => {
    const noAllowance = await newMaterial('FIXTURE no allowance', {
      category: 'consumable', unit: 'litre' });
    await rule(siding, noAllowance, { kind: 'consumable' });
    const plan = await buildPlan('car_a', DAY);
    const n = lineFor(plan, 'FIXTURE no allowance');
    assert.equal(n.data_state, 'needs_review');
    assert.match(n.reason, /amount is unknown/i);
    assert.equal(n.required_qty, null,
      'zero would claim the job needs none of it; null says nobody knows');
    assert.equal(n.shortage_qty, null,
      'and a shortage against an unknown requirement is not calculable');
    assert.equal(n.action, 'add', 'it is still needed');
    await client.query(`delete from public.ns_service_load_rules
                         where material_id=$1`, [noAllowance]);
  });

  // ======================================== C. the no-bleach day ==========
  await record('C1 a day with no bleach work returns the removable kit', async () => {
    // Load the bleach kit into the car, then plan a windows-only day.
    await rpc(`public.post_stock_transfer($1,$2,1,'base','car_a',true,null,null)`,
      [opId('tx'), bleachKit]);
    const j = await newJob(OTHER_DAY);
    await measure(j, windows, 20);
    const plan = await buildPlan('car_a', OTHER_DAY);
    const b = lineFor(plan, 'FIXTURE removable bleach kit');
    assert.ok(b, 'it is in the car, so it must appear');
    assert.equal(b.action, 'return');
    assert.match(b.reason, /no job today needs it/i);
  });

  await record('C2 the standard tool kit is never returned, bleach day or not', async () => {
    await rpc(`public.post_stock_transfer($1,$2,1,'base','car_a',true,null,null)`,
      [opId('tx'), toolKit]);
    const plan = await buildPlan('car_a', OTHER_DAY);
    const t = lineFor(plan, 'FIXTURE standard tool kit');
    assert.notEqual(t.action, 'return', 'always_keep outranks the quiet day');
  });

  await record('C3 a manual Keep turns a Return into a Keep, and survives a rebuild',
    async () => {
      await rpc(`public.set_manual_keep($1,'car_a',$2::date,$3,true,'rain forecast')`,
        [opId('keep'), OTHER_DAY, bleachKit]);
      let plan = await buildPlan('car_a', OTHER_DAY);
      let b = lineFor(plan, 'FIXTURE removable bleach kit');
      assert.equal(b.action, 'keep');
      assert.equal(b.manual_keep, true);
      assert.match(b.reason, /rain forecast/);

      // Rebuild again: the keep is keyed by day, not by plan line.
      plan = await buildPlan('car_a', OTHER_DAY);
      b = lineFor(plan, 'FIXTURE removable bleach kit');
      assert.equal(b.action, 'keep', 'a regeneration must not wipe a manual keep');
      assert.equal(b.manual_keep, true);
    });

  await record('C4 clearing the manual Keep lets it be returned again', async () => {
    await rpc(`public.set_manual_keep($1,'car_a',$2::date,$3,false,null)`,
      [opId('keep'), OTHER_DAY, bleachKit]);
    const plan = await buildPlan('car_a', OTHER_DAY);
    const b = lineFor(plan, 'FIXTURE removable bleach kit');
    assert.equal(b.action, 'return');
  });

  await record('C5 a second job needing the kit keeps it aboard without a manual keep',
    async () => {
      const j = await newJob(OTHER_DAY);
      await measure(j, siding, 100);
      const plan = await buildPlan('car_a', OTHER_DAY);
      const b = lineFor(plan, 'FIXTURE removable bleach kit');
      assert.equal(b.action, 'keep', 'one siding stop is enough to hold the kit');
      assert.equal(b.manual_keep, false, 'and it is not a manual keep');
    });

  // =========================================== D. revisions ===============
  await record('D1 every build makes a new revision and supersedes the last', async () => {
    const a = await buildPlan('car_a', DAY);
    const b = await buildPlan('car_a', DAY);
    assert.equal(b.revision, a.revision + 1);
    const old = await one(`select status from public.ns_load_plans where id=$1`, [a.plan_id]);
    assert.equal(old.status, 'superseded');
    const live = await all(
      `select id from public.ns_load_plans
        where work_date=$1::date and status in ('current','confirmed')
          and location_id=(select id from public.ns_stock_locations where code='car_a')`,
      [DAY]);
    assert.equal(live.length, 1, 'exactly one live plan per car per day');
  });

  await record('D2 building a plan is replay-safe', async () => {
    const key = opId('plan');
    const a = await rpc(`public.build_load_plan($1,'car_a',$2::date,null)`, [key, DAY]);
    const b = await rpc(`public.build_load_plan($1,'car_a',$2::date,null)`, [key, DAY]);
    assert.equal(a.replayed, false);
    assert.equal(b.replayed, true);
    assert.equal(b.plan_id, a.plan_id);
    assert.equal(b.revision, a.revision, 'a retry did not make a second revision');
  });

  await record('D3 confirming the wrong revision is refused, with the right one',
    async () => {
      const plan = await buildPlan('car_a', DAY);
      const err = await errorOf(() => rpc(
        `public.confirm_load_plan($1,$2,$3,null,null)`,
        [opId('conf'), plan.plan_id, plan.revision - 1]));
      assert.ok(err); assert.equal(err.code, '23514');
      assert.match(err.message, new RegExp(`current one is ${plan.revision}`));
    });

  await record('D4 a schedule change after the build blocks confirmation', async () => {
    const plan = await buildPlan('car_a', DAY);
    // A late cancellation: the revision has not moved, but the plan is wrong.
    const j = await newJob(DAY);
    await measure(j, siding, 300);
    const err = await errorOf(() => rpc(
      `public.confirm_load_plan($1,$2,$3,null,null)`,
      [opId('conf'), plan.plan_id, plan.revision]));
    assert.ok(err, 'the revision matched, so only the fingerprint can catch this');
    assert.equal(err.code, '23514');
    assert.match(err.message, /changed after this plan was built/i);
  });

  await record('D5 a superseded plan cannot be confirmed', async () => {
    const a = await buildPlan('car_a', DAY);
    await buildPlan('car_a', DAY);
    const err = await errorOf(() => rpc(
      `public.confirm_load_plan($1,$2,null,null,null)`, [opId('conf'), a.plan_id]));
    assert.ok(err); assert.equal(err.code, '23514');
    assert.match(err.message, /newer one exists/i);
  });

  // ================================ E. recommendation vs movement =========
  await record('E1 building a plan moves no stock at all', async () => {
    const before = Number((await one(
      `select count(*)::int as n from public.ns_material_stock_moves`)).n);
    await buildPlan('car_a', DAY);
    const after = Number((await one(
      `select count(*)::int as n from public.ns_material_stock_moves`)).n);
    assert.equal(after, before, 'a recommendation is not a movement');
  });

  await record('E2 confirming posts transfers, and that is the only thing that moves stock',
    async () => {
      const plan = await buildPlan('car_a', DAY);
      const soapBefore = Number((await one(
        `select coalesce(on_hand,0) as n from public.ns_material_stock_by_location
          where material_id=$1 and location_code='car_a'`, [soap])).n);
      const r = await rpc(`public.confirm_load_plan($1,$2,$3,null,null)`,
        [opId('conf'), plan.plan_id, plan.revision]);
      assert.equal(r.status, 'confirmed');
      assert.ok(r.transfers_posted > 0);
      const soapAfter = Number((await one(
        `select coalesce(on_hand,0) as n from public.ns_material_stock_by_location
          where material_id=$1 and location_code='car_a'`, [soap])).n);
      assert.ok(soapAfter > soapBefore, 'the product is now in the van');

      const kinds = await all(
        `select distinct o.kind from public.ns_stock_operations o
           join public.ns_material_stock_moves mv on mv.operation_id=o.id
          where mv.material_id=$1 and o.kind='transfer'`, [soap]);
      assert.equal(kinds.length, 1,
        'the move is an ordinary transfer, not an invented operation kind');
    });

  await record('E3 a retried confirmation does not move stock twice', async () => {
    const plan = await buildPlan('car_a', OTHER_DAY);
    const key = opId('conf');
    const a = await rpc(`public.confirm_load_plan($1,$2,$3,null,null)`,
      [key, plan.plan_id, plan.revision]);
    const before = Number((await one(
      `select count(*)::int as n from public.ns_material_stock_moves`)).n);
    const b = await rpc(`public.confirm_load_plan($1,$2,$3,null,null)`,
      [key, plan.plan_id, plan.revision]);
    const after = Number((await one(
      `select count(*)::int as n from public.ns_material_stock_moves`)).n);
    assert.equal(b.replayed, true);
    assert.equal(after, before, 'the second confirmation posted nothing');
    assert.ok(a.plan_id);
  });

  await record('E4 a reservation is a commitment, not a load', async () => {
    const mat = await newMaterial('FIXTURE reserved product', {
      category: 'consumable', unit: 'litre' });
    await receive(mat, 100);
    const job = await newJob(DAY);
    await rpc(`public.reserve_stock($1,$2,'base',30,$3,null,null)`,
      [opId('res'), mat, job]);
    const bal = await one(
      `select on_hand, reserved, available from public.ns_material_stock_by_location
        where material_id=$1 and location_code='base'`, [mat]);
    assert.equal(Number(bal.on_hand), 100, 'reserving moved nothing');
    assert.equal(Number(bal.reserved), 30);
    assert.equal(Number(bal.available), 70, 'but it is no longer free');
  });

  // ============================================ F. seasonal sets ==========
  await record('F1 a promised Christmas set is on the plan by id, with no quantity',
    async () => {
      const setId = (await rpc(
        `public.register_seasonal_set($1,'FIXTURE LOAD SET','roofline','warm',40,'base',null,null,null)`,
        [opId('set')])).set.set_id;
      await rpc(`public.inspect_seasonal_set($1,$2,'usable',null)`, [opId('insp'), setId]);
      const job = await newJob(DAY);
      await measure(job, siding, 10);
      await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,$4,null)`,
        [opId('asg'), setId, custA, job]);

      const plan = await buildPlan('car_a', DAY);
      const line = plan.lines.find((l) => l.rental_set_id === setId);
      assert.ok(line, 'the set the crew must take is on the plan');
      assert.equal(line.line_kind, 'seasonal_set');
      assert.equal(line.action, 'add');
      assert.equal(line.material_id, null, 'a set is not a material');
      assert.equal(line.required_qty, null, 'and it has no quantity');
      assert.ok(line.set_code);
    });

  await record('F2 confirming does not try to transfer a set as if it were stock',
    async () => {
      const plan = await buildPlan('car_a', DAY);
      const setLine = plan.lines.find((l) => l.rental_set_id !== null);
      assert.ok(setLine);
      const r = await rpc(`public.confirm_load_plan($1,$2,$3,null,null)`,
        [opId('conf'), plan.plan_id, plan.revision]);
      const after = r.lines.find((l) => l.line_id === setLine.line_id);
      assert.equal(after.confirmed_operation, null,
        'a set is an asset the crew carries, not a balance that moves');
    });

  // ========================================== G. two vehicles =============
  await record('G1 Car B is not seeded, and one vehicle means unassigned jobs are ours',
    async () => {
      const vehicles = await all(
        `select code from public.ns_stock_locations where kind='vehicle' and active`);
      assert.deepEqual(vehicles.map(v => v.code), ['car_a'],
        'no migration may seed a second vehicle');
      const plan = await buildPlan('car_a', DAY);
      assert.ok(plan.lines.length > 0, 'unassigned jobs belong to the only car');
      assert.equal(Number(plan.unassigned_jobs), 0);
    });

  await record('G2 with two vehicles an unassigned job belongs to NEITHER plan',
    async () => {
      await client.query(
        `insert into public.ns_stock_locations (code,name,kind,sort_order)
         values ('car_b','Car B','vehicle',2) on conflict do nothing`);
      try {
        const plan = await buildPlan('car_a', DAY);
        assert.ok(Number(plan.unassigned_jobs) > 0,
          'the ambiguity is reported, never guessed at');
        assert.match(plan.note || '', /not assigned to a vehicle/i);
        assert.equal(plan.lines.filter((l) => l.line_kind === 'consumable').length, 0,
          'nothing a job needs is planned while nobody knows which car it is on');
      } finally {
        await client.query(`delete from public.ns_stock_locations where code='car_b'`);
      }
    });

  /** Car B is torn down between cases, and everything that points at it has
   *  to go first -- which is itself the on-delete-restrict rule doing its
   *  job: a vehicle with work assigned to it cannot simply vanish. */
  const dropCarB = async () => {
    await client.query(`delete from public.ns_job_vehicle_assignments
      where location_id in (select id from public.ns_stock_locations where code='car_b')`);
    await client.query(`delete from public.ns_load_plan_lines where plan_id in
      (select id from public.ns_load_plans where location_id in
        (select id from public.ns_stock_locations where code='car_b'))`);
    await client.query(`delete from public.ns_load_plans where location_id in
      (select id from public.ns_stock_locations where code='car_b')`);
    await client.query(`delete from public.ns_stock_locations where code='car_b'`);
  };

  await record('G3 an explicit assignment puts the job on that car only', async () => {
    await client.query(
      `insert into public.ns_stock_locations (code,name,kind,sort_order)
       values ('car_b','Car B','vehicle',2) on conflict do nothing`);
    try {
      const job = await newJob('2026-11-20');
      await measure(job, siding, 800);
      await client.query(
        `insert into public.ns_job_vehicle_assignments (job_id, location_id)
         values ($1,(select id from public.ns_stock_locations where code='car_b'))`, [job]);

      const a = await buildPlan('car_a', '2026-11-20');
      const b = await buildPlan('car_b', '2026-11-20');
      assert.equal(a.lines.filter((l) => l.line_kind === 'consumable').length, 0,
        'Car A is not loading for Car B\'s job');
      assert.ok(b.lines.some((l) => l.material_name === 'FIXTURE pressure washer'));
      assert.equal(Number(b.unassigned_jobs), 0);
    } finally {
      await dropCarB();
    }
  });

  // ====================================== H. end-of-day reconciliation ====
  await record('H1 an unexplained variance is refused', async () => {
    const err = await errorOf(() => rpc(
      `public.reconcile_day_end($1,'car_a',$2::date,$3::jsonb,null)`,
      [opId('rec'), DAY,
       JSON.stringify([{ material_id: soap, counted_qty: 1 }])]));
    assert.ok(err); assert.equal(err.code, '23514');
    assert.match(err.message, /Say why/i);
  });

  await record('H2 an explained variance posts a correction and closes the day',
    async () => {
      const before = Number((await one(
        `select coalesce(on_hand,0) as n from public.ns_material_stock_by_location
          where material_id=$1 and location_code='car_a'`, [soap])).n);
      const r = await rpc(
        `public.reconcile_day_end($1,'car_a',$2::date,$3::jsonb,'end of day')`,
        [opId('rec'), DAY, JSON.stringify([
          { material_id: soap, counted_qty: before - 2,
            variance_reason: 'used_more', precision: 'estimated' }
        ])]);
      assert.equal(r.lines.length, 1);
      assert.equal(Number(r.lines[0].variance_qty), -2);
      const after = Number((await one(
        `select coalesce(on_hand,0) as n from public.ns_material_stock_by_location
          where material_id=$1 and location_code='car_a'`, [soap])).n);
      assert.equal(after, before - 2, 'the ledger now agrees with the van');
    });

  await record('H3 a level supply is counted as a level, posting no movement', async () => {
    const before = Number((await one(
      `select count(*)::int as n from public.ns_material_stock_moves
        where material_id=$1`, [rinseAid])).n);
    await rpc(`public.reconcile_day_end($1,'car_a',$2::date,$3::jsonb,null)`,
      [opId('rec'), '2026-11-25', JSON.stringify([
        { material_id: rinseAid, level_state: 'empty' }
      ])]);
    const after = Number((await one(
      `select count(*)::int as n from public.ns_material_stock_moves
        where material_id=$1`, [rinseAid])).n);
    assert.equal(after, before, 'a level is an observation, not a quantity');
    const lv = await one(
      `select state from public.ns_material_levels
        where material_id=$1 and location_id=(select id from public.ns_stock_locations where code='car_a')`,
      [rinseAid]);
    assert.equal(lv.state, 'empty');
  });

  await record('H4 reconciliation is replay-safe', async () => {
    const key = opId('rec');
    const a = await rpc(`public.reconcile_day_end($1,'car_a',$2::date,$3::jsonb,null)`,
      [key, '2026-11-26', JSON.stringify([{ material_id: rinseAid, level_state: 'low' }])]);
    const b = await rpc(`public.reconcile_day_end($1,'car_a',$2::date,$3::jsonb,null)`,
      [key, '2026-11-26', JSON.stringify([{ material_id: rinseAid, level_state: 'low' }])]);
    assert.equal(a.replayed, false);
    assert.equal(b.replayed, true);
    assert.equal(b.reconciliation_id, a.reconciliation_id);
  });

  // =========================================== I. suggestions =============
  await record('I1 next-day suggestions report shortages and gaps, and reserve nothing',
    async () => {
      await client.query(
        `insert into public.ns_vehicle_baselines (location_id, material_id, target_qty)
         values ((select id from public.ns_stock_locations where code='car_a'),$1,500)
         on conflict (location_id, material_id) do update set target_qty=500`, [soap]);
      await buildPlan('car_a', DAY);
      const s = await rpc(`public.ns_next_day_suggestions('car_a',$1::date)`, [DAY]);
      assert.ok(Array.isArray(s.baseline_gaps));
      assert.ok(s.baseline_gaps.some((g) => g.material_id === soap));
      assert.match(s.note, /reserves, orders or moves/i);
      const held = await all(
        `select id from public.ns_stock_reservations where status='held' and job_id is null`);
      assert.equal(held.length, 0, 'a suggestion commits nothing');
    });

  // ======================================== J. owner and crew =============
  await record('J1 a crew confirms and counts, but does not plan or authorise',
    async () => {
      await client.query(
        `insert into public.ns_crew_members (user_id,role,vehicle_location_id,display_name)
         values ($1,'crew',(select id from public.ns_stock_locations where code='car_a'),'FIXTURE crew')
         on conflict (user_id) do update set role='crew', active=true`, [crewId]);
      await beCrew();
      try {
        assert.equal((await one('select public.is_owner() as o')).o, false);

        // Allowed: hold something back, count the day.
        await rpc(`public.set_manual_keep($1,'car_a',$2::date,$3,true,'crew call')`,
          [opId('keep'), '2026-11-27', bleachKit]);
        await rpc(`public.reconcile_day_end($1,'car_a',$2::date,$3::jsonb,null)`,
          [opId('rec'), '2026-11-27',
           JSON.stringify([{ material_id: rinseAid, level_state: 'enough' }])]);

        // Refused: deciding what the day needs, or authorising a departure.
        let err = await errorOf(() => buildPlan('car_a', '2026-11-28'));
        assert.ok(err); assert.equal(err.code, '42501');
        assert.match(err.message, /whole day/i);

        err = await errorOf(() => rpc(
          `public.authorise_load_exception($1,'car_a',$2::date,'skip_required','no room',$3,null)`,
          [opId('exc'), '2026-11-27', washer]));
        assert.ok(err); assert.equal(err.code, '42501');
      } finally {
        await beOwner();
      }
    });

  await record('J2 a crew cannot confirm the other car\'s plan', async () => {
    await client.query(
      `insert into public.ns_stock_locations (code,name,kind,sort_order)
       values ('car_b','Car B','vehicle',2) on conflict do nothing`);
    try {
      const plan = await buildPlan('car_b', '2026-12-01');
      await beCrew();
      const err = await errorOf(() => rpc(
        `public.confirm_load_plan($1,$2,$3,null,null)`,
        [opId('conf'), plan.plan_id, plan.revision]));
      assert.ok(err); assert.equal(err.code, '42501');
      assert.match(err.message, /do not work from/i);
    } finally {
      await beOwner();
      await dropCarB();
    }
  });

  await record('J3 an exception needs a reason and an owner', async () => {
    let err = await errorOf(() => rpc(
      `public.authorise_load_exception($1,'car_a',$2::date,'skip_required','',$3,null)`,
      [opId('exc'), DAY, washer]));
    assert.ok(err); assert.equal(err.code, '22023');

    const ok = await rpc(
      `public.authorise_load_exception($1,'car_a',$2::date,'skip_required','borrowed one',$3,null)`,
      [opId('exc'), DAY, washer]);
    assert.ok(ok.exception_id);
    assert.equal(ok.replayed, false);
  });

  await record('J4 a non-admin gets nowhere', async () => {
    await client.query(`select set_config('nova.is_admin','off',false)`);
    try {
      for (const [sql, extra] of [
        [`public.build_load_plan($1,'car_a',$2::date,null)`, [DAY]],
        [`public.set_manual_keep($1,'car_a',$2::date,$3,true,null)`, [DAY, washer]],
        [`public.confirm_load_plan($1,'00000000-0000-0000-0000-000000000000',null,null,null)`, []],
        [`public.reconcile_day_end($1,'car_a',$2::date,'[]'::jsonb,null)`, [DAY]]
      ]) {
        const err = await errorOf(() => rpc(sql, [opId('anon'), ...extra]));
        assert.ok(err, sql); assert.equal(err.code, '42501', sql);
      }
    } finally {
      await client.query(`select set_config('nova.is_admin','on',false)`);
    }
  });

  await record('J5 anon holds no execute, and authenticated cannot write plans by hand',
    async () => {
      for (const f of [
        'public.build_load_plan(text,text,date,text)',
        'public.set_manual_keep(text,text,date,uuid,boolean,text)',
        'public.authorise_load_exception(text,text,date,text,text,uuid,uuid)',
        'public.confirm_load_plan(text,uuid,integer,text,text)',
        'public.reconcile_day_end(text,text,date,jsonb,text)'
      ]) {
        const { ok } = await one(
          `select has_function_privilege('anon',$1,'execute') as ok`, [f]);
        assert.equal(ok, false, `anon can execute ${f}`);
      }
      for (const [t, p] of [
        ['public.ns_load_plans', 'INSERT'], ['public.ns_load_plan_lines', 'UPDATE'],
        ['public.ns_load_manual_keeps', 'INSERT'], ['public.ns_load_exceptions', 'INSERT'],
        ['public.ns_day_reconciliations', 'INSERT']
      ]) {
        const { ok } = await one(
          `select has_table_privilege('authenticated',$1,$2) as ok`, [t, p]);
        assert.equal(ok, false, `authenticated holds ${p} on ${t}`);
      }
    });

  await record('J6 RLS is on and plans are scoped to the vehicles a crew can see',
    async () => {
      const { enabled } = await one(
        `select relrowsecurity as enabled from pg_class
          where oid='public.ns_load_plans'::regclass`);
      assert.equal(enabled, true);
      const names = (await all(
        `select polname from pg_policy where polrelid='public.ns_load_plans'::regclass`))
        .map(r => r.polname);
      assert.ok(names.includes('ns_load_plans_read'));
    });

  // ================================================== report ==============
  await client.end();
  const failed = results.filter(r => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.err}`}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
})().catch((err) => { console.error(err); process.exit(1); });
