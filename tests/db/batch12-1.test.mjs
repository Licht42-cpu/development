// Batch 12.1 -- practical dispatch, property instructions and the two
// customer actions, against a DEDICATED DISPOSABLE DATABASE.
//
//   node tests/db/setup-test-db.mjs
//   node tests/db/batch12-1.test.mjs
//
// What passing proves: the whole pending migration sequence applies; a day
// is ordered, reassigned and rescheduled by the owner alone, versioned
// against concurrent edits and replay-safe per operation; those edits
// invalidate the affected load plans on BOTH vehicles without moving stock
// and without rewriting a confirmed plan's history, and a late confirmation
// of an invalidated plan is refused; equipment conflicts are reported from
// authoritative stock at day level with unknown never rendered as zero;
// property access codes are unreadable except through a scoped function;
// blocked, skipped, work-finished and accepted-completed stay four
// different things and completion still goes through 11.1; and a
// notification request distinguishes accepted, delivered, provider
// failure, unknown and unavailable.
//
// What it does NOT prove: anything about the live database, and nothing
// about a real SMS provider -- every provider outcome here is recorded by a
// double. NO MIGRATION IN THIS REPOSITORY HAS BEEN APPLIED TO PRODUCTION
// AND NO REAL MESSAGE IS SENT.

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
  '20261016120000_batch12_1_conflicts_stages_and_winter.sql'
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
const opId = (tag) => `dsp-${tag}-${++seq}`;
const DAY = '2027-07-06';
const DAY2 = '2027-07-07';

(async () => {
  assertDisposableTarget(PGURL);
  const client = new pg.Client({ connectionString: PGURL });
  await client.connect();
  await assertDisposableDatabase(client);
  await client.query(`set time zone 'UTC'`);

  const one = async (sql, p) => (await client.query(sql, p)).rows[0];
  const all = async (sql, p) => (await client.query(sql, p)).rows;
  const rpc = async (fn, p) => (await one(`select ${fn} as r`, p)).r;

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

  // Same order the 11.1 suite uses: the base fixture creates the legacy
  // quote tables the 11.1 fixture then extends.
  await client.query(readFileSync(join(HERE, 'fixture-schema.sql'), 'utf8'));
  await client.query(readFileSync(join(HERE, 'fixture-schema-batch8-1.sql'), 'utf8'));
  await client.query(readFileSync(join(HERE, 'fixture-schema-batch9-1.sql'), 'utf8'));
  await client.query(readFileSync(join(HERE, 'fixture-schema-batch10-1.sql'), 'utf8'));
  await client.query(readFileSync(join(HERE, 'fixture-schema-batch11-1.sql'), 'utf8'));
  await client.query(readFileSync(join(HERE, 'fixture-schema-batch12-1.sql'), 'utf8'));

  // ================================================= A. migrations ========
  for (const [i, file] of SEQUENCE.entries()) {
    await record(`A${i + 1} ${file} applies in sequence`, async () => {
      await client.query(migration(file));
    });
  }
  await record('A90 the 12.1 migrations are re-runnable', async () => {
    for (const f of SEQUENCE.slice(17)) await client.query(migration(f));
    for (const f of SEQUENCE.slice(17)) await client.query(migration(f));
    const { n } = await one(
      `select count(*)::int as n from pg_policy
        where polrelid='public.ns_dispatch_days'::regclass`);
    assert.equal(n, 1, 'a re-run must not stack duplicate policies');
  });

  // ------------------------------------------------------------ fixtures --
  const ownerId = (await one('insert into auth.users default values returning id')).id;
  const crewAId = (await one('insert into auth.users default values returning id')).id;
  const crewBId = (await one('insert into auth.users default values returning id')).id;
  await client.query(`select set_config('nova.is_admin','on',false)`);
  const beOwner = () => client.query(`select set_config('nova.actor_id',$1,false)`, [ownerId]);
  const beCrewA = () => client.query(`select set_config('nova.actor_id',$1,false)`, [crewAId]);
  const beCrewB = () => client.query(`select set_config('nova.actor_id',$1,false)`, [crewBId]);
  await beOwner();

  const supplierId = (await one('select id from public.ns_suppliers limit 1')).id;
  const cust = (await one(
    `insert into public.customers (name, phone, email)
     values ('FIXTURE Dispatch Customer','+15550100','fixture@example.invalid')
     returning id`)).id;
  const custNoPhone = (await one(
    `insert into public.customers (name) values ('FIXTURE No Contact') returning id`)).id;

  const newProperty = async (over = {}) => (await one(
    `insert into public.properties
       (customer_id, address_line1, city, access_note, latitude, longitude)
     values ($1,$2,'Fixtureville',$3,$4,$5) returning id`,
    [over.customer || cust, over.address || '1 FIXTURE Lane',
     over.accessNote ?? 'Side gate, unlatched',
     over.lat ?? null, over.lng ?? null])).id;

  const propA = await newProperty({ lat: 53.5, lng: -113.5 });
  const propNoCoords = await newProperty({ address: '2 FIXTURE Lane' });

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
    `insert into public.ns_jobs (customer_id, property_id, scheduled_for, status)
     values ($1,$2,$3,$4) returning id`,
    [over.customer || cust, over.property ?? propA,
     when === null ? null : `${when}T${over.at || '14:00:00'}Z`,
     over.status || 'scheduled'])).id;

  const measure = (jobId, serviceId, q) => client.query(
    `insert into public.job_measurements (job_id, service_id, quantity, unit)
     values ($1,$2,$3,'sq_ft')`, [jobId, serviceId, q]);

  const rule = (serviceId, materialId, over = {}) => client.query(
    `insert into public.ns_service_load_rules
       (service_id, material_id, rule_kind, quantity_fixed, quantity_per_unit,
        allowance_state, removable, always_keep)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (service_id, material_id) do update
        set rule_kind=excluded.rule_kind, removable=excluded.removable,
            always_keep=excluded.always_keep`,
    [serviceId, materialId, over.kind || 'equipment', over.fixed ?? null,
     over.perUnit ?? null, over.allowance || 'reviewed',
     over.removable ?? false, over.alwaysKeep ?? false]);

  const receive = (matId, qty, loc = 'base') => rpc(
    `public.post_stock_movement($1,$2,$3,$4,'received',null,null,null,null,'usable','exact')`,
    [opId('mv'), matId, loc, qty]);

  const assignTo = (jobId, code) => rpc(
    `public.assign_job_to_vehicle($1,$2,$3,null,'fixture setup')`,
    [opId('asg'), jobId, code]);

  const dayRead = (code, day) => rpc(
    `public.get_dispatch_day($1,$2::date)`, [code, day]);

  const siding = await svc('siding_soft_wash', 'Siding Soft Washing');
  const windows = await svc('window_cleaning', 'Window Cleaning');
  const winter = await svc('winter_property_care', 'Winter Property Care');
  const winterDeck = await svc('winter_property_care_deck', 'Winter Property Care - Deck');

  const washer = await newMaterial('FIXTURE pressure washer');
  const ladder = await newMaterial('FIXTURE extension ladder');
  await rule(siding, washer);
  await rule(windows, ladder);
  await receive(washer, 1);
  await receive(ladder, 2);

  // The unique index is on lower(btrim(code)), so ON CONFLICT (code) finds
  // no constraint. Insert-if-absent, then make sure it is active.
  const carB = async () => {
    await client.query(
      `insert into public.ns_stock_locations (code,name,kind,sort_order)
       values ('car_b','Car B','vehicle',2) on conflict do nothing`);
    await client.query(
      `update public.ns_stock_locations set active = true where code='car_b'`);
  };
  const dropCarB = async () => {
    // ns_crew_members references the location, so a crew pointed at Car B
    // has to come back to Car A before the row can go.
    await client.query(
      `update public.ns_crew_members
          set vehicle_location_id = (select id from public.ns_stock_locations where code='car_a')
        where vehicle_location_id = (select id from public.ns_stock_locations where code='car_b')`);
    await client.query(`delete from public.ns_job_vehicle_assignments
       where location_id = (select id from public.ns_stock_locations where code='car_b')`);
    await client.query(`delete from public.ns_dispatch_order
       where location_id = (select id from public.ns_stock_locations where code='car_b')`);
    await client.query(`delete from public.ns_dispatch_days
       where location_id = (select id from public.ns_stock_locations where code='car_b')`);
    await client.query(`delete from public.ns_load_plans
       where location_id = (select id from public.ns_stock_locations where code='car_b')`);
    await client.query(`delete from public.ns_stock_locations where code='car_b'`);
  };
  const makeCrew = async (userId, code) => client.query(
    `insert into public.ns_crew_members (user_id,role,vehicle_location_id,display_name)
     values ($1,'crew',(select id from public.ns_stock_locations where code=$2),'FIXTURE crew')
     on conflict (user_id) do update set role='crew', active=true,
       vehicle_location_id=(select id from public.ns_stock_locations where code=$2)`,
    [userId, code]);

  // ============================================ B. the ordered day ========
  await record('B1 an unedited day is ordered by time, and says the order is derived',
    async () => {
      const first = await newJob(DAY, { at: '09:00:00' });
      const second = await newJob(DAY, { at: '13:00:00' });
      await measure(first, siding, 100);
      await measure(second, windows, 20);

      const read = await dayRead('car_a', DAY);
      assert.equal(read.location_code, 'car_a');
      assert.deepEqual(read.stops.map((s) => s.job_id), [first, second],
        'with one vehicle the day is the day, in time order');
      assert.equal(read.stops[0].order_state, 'derived',
        'nobody has reordered it, and the read says so rather than implying a choice');
      assert.equal(read.stops[0].position, null);
      assert.equal(read.stops[0].assigned, false,
        'unassigned and ours by the one-vehicle rule is a different fact from assigned');
      assert.equal(read.revision, 1);
      assert.equal(read.can_plan, true);
      assert.ok(read.window_starts_at && read.window_ends_at,
        'the same operating-day window the load contract publishes');
      assert.equal(read.work_day_timezone_state, 'unconfigured');
    });

  await record('B2 the owner orders the day, and the order is explicit afterwards',
    async () => {
      const read = await dayRead('car_a', DAY);
      const reversed = read.stops.map((s) => s.job_id).reverse();
      const r = await rpc(
        `public.reorder_dispatch_day($1,'car_a',$2::date,$3::uuid[],$4)`,
        [opId('ord'), DAY, reversed, read.revision]);
      assert.equal(r.replayed, false);
      assert.equal(r.revision, read.revision + 1);
      assert.equal(r.load_effect.startsWith('none'), true,
        'the load is a whole-day decision, so an order change does not invalidate it');

      const after = await dayRead('car_a', DAY);
      assert.deepEqual(after.stops.map((s) => s.job_id), reversed);
      assert.deepEqual(after.stops.map((s) => s.position), [1, 2]);
      assert.equal(after.stops[0].order_state, 'explicit');
    });

  await record('B3 an order that drops a stop is refused, with the count', async () => {
    const read = await dayRead('car_a', DAY);
    const err = await errorOf(() => rpc(
      `public.reorder_dispatch_day($1,'car_a',$2::date,$3::uuid[],$4)`,
      [opId('ord'), DAY, [read.stops[0].job_id], read.revision]));
    assert.ok(err); assert.equal(err.code, '23514');
    assert.match(err.message, /leaves out 1 of the day's jobs/i);
  });

  await record('B4 a stale revision is refused with the current one', async () => {
    const read = await dayRead('car_a', DAY);
    const err = await errorOf(() => rpc(
      `public.reorder_dispatch_day($1,'car_a',$2::date,$3::uuid[],$4)`,
      [opId('ord'), DAY, read.stops.map((s) => s.job_id), read.revision - 1]));
    assert.ok(err); assert.equal(err.code, '23514');
    assert.match(err.message, new RegExp(`now at ${read.revision}`));
  });

  await record('B5 a crew cannot order the day', async () => {
    await makeCrew(crewAId, 'car_a');
    await beCrewA();
    const read = await dayRead('car_a', DAY);
    const err = await errorOf(() => rpc(
      `public.reorder_dispatch_day($1,'car_a',$2::date,$3::uuid[],$4)`,
      [opId('ord'), DAY, read.stops.map((s) => s.job_id), read.revision]));
    await beOwner();
    assert.ok(err); assert.equal(err.code, '42501');
    assert.match(err.message, /owner/i);
  });

  await record('B6 the same key twice is one reorder; a changed one is refused',
    async () => {
      const read = await dayRead('car_a', DAY);
      const order = read.stops.map((s) => s.job_id);
      const key = opId('ord');
      const a = await rpc(
        `public.reorder_dispatch_day($1,'car_a',$2::date,$3::uuid[],$4)`,
        [key, DAY, order, read.revision]);
      const b = await rpc(
        `public.reorder_dispatch_day($1,'car_a',$2::date,$3::uuid[],$4)`,
        [key, DAY, order, read.revision]);
      assert.equal(a.replayed, false);
      assert.equal(b.replayed, true);
      assert.equal(b.revision, a.revision, 'a retry is not a second edit');

      const err = await errorOf(() => rpc(
        `public.reorder_dispatch_day($1,'car_a',$2::date,$3::uuid[],$4)`,
        [key, DAY, order.slice().reverse(), a.revision]));
      assert.ok(err); assert.equal(err.code, '23505');
      assert.match(err.message, /different reorder/i);
    });

  await record('B7 a key belongs to the operation it was first used for', async () => {
    const read = await dayRead('car_a', DAY);
    const key = opId('mixed');
    await rpc(`public.reorder_dispatch_day($1,'car_a',$2::date,$3::uuid[],$4)`,
      [key, DAY, read.stops.map((s) => s.job_id), read.revision]);
    const err = await errorOf(() => rpc(
      `public.set_dispatch_stage($1,$2,'skipped','rain',null)`,
      [key, read.stops[0].job_id]));
    assert.ok(err); assert.equal(err.code, '23505');
    assert.match(err.message, /already used for a reorder/i);
  });

  // ====================================== C. two vehicles, one job ========
  await record('C1 with two vehicles an unassigned job belongs to neither, and is reported',
    async () => {
      await carB();
      try {
        const loose = await newJob(DAY2, { at: '10:00:00' });
        await measure(loose, siding, 50);
        const a = await dayRead('car_a', DAY2);
        const b = await dayRead('car_b', DAY2);
        assert.equal(a.stops.length, 0, 'not Car A\'s by default any more');
        assert.equal(b.stops.length, 0, 'and not Car B\'s either');
        assert.ok(a.unassigned_jobs.some((u) => u.job_id === loose),
          'it is reported as needing assignment rather than guessed at');
        assert.deepEqual(a.unassigned_jobs, b.unassigned_jobs,
          'both planning screens see the same unassigned work');
      } finally {
        await dropCarB();
      }
    });

  await record('C2 one job cannot be on both cars, and the schema is what guarantees it',
    async () => {
      await carB();
      try {
        const job = await newJob(DAY2, { at: '11:00:00' });
        await measure(job, siding, 60);
        await assignTo(job, 'car_a');
        await assignTo(job, 'car_b');
        const { n } = await one(
          `select count(*)::int as n from public.ns_job_vehicle_assignments where job_id=$1`,
          [job]);
        assert.equal(n, 1, 'the second assignment MOVED it; it did not add a second');
        const a = await dayRead('car_a', DAY2);
        const b = await dayRead('car_b', DAY2);
        assert.ok(!a.stops.some((s) => s.job_id === job));
        assert.ok(b.stops.some((s) => s.job_id === job));
      } finally {
        await dropCarB();
      }
    });

  await record('C3 the conflict read derives the same equipment the plan does',
    async () => {
      const job = await newJob(DAY2, { at: '12:00:00' });
      await measure(job, siding, 80);
      const derived = await all(
        `select material_id from public.ns_vehicle_day_equipment(
           (select id from public.ns_stock_locations where code='car_a'), $1::date)`,
        [DAY2]);
      const plan = await rpc(`public.build_load_plan($1,'car_a',$2::date,null)`,
        [opId('plan'), DAY2]);
      const planned = plan.lines
        .filter((l) => l.line_kind === 'equipment')
        .map((l) => l.material_id);
      assert.deepEqual(derived.map((d) => d.material_id).sort(), planned.sort(),
        'two derivations of the same rule set must not drift');
    });

  await record('C4 a tool both cars need, and not enough of it, is a shared scarcity',
    async () => {
      await carB();
      try {
        const jobA = await newJob(DAY2, { at: '09:30:00' });
        const jobB = await newJob(DAY2, { at: '10:30:00' });
        await measure(jobA, siding, 100);
        await measure(jobB, siding, 100);
        await assignTo(jobA, 'car_a');
        await assignTo(jobB, 'car_b');

        const r = await rpc(`public.dispatch_equipment_conflicts($1::date)`, [DAY2]);
        const row = r.items.find((i) => i.material_id === washer);
        assert.ok(row, 'the washer is on the list');
        assert.equal(row.vehicles_needing, 2);
        assert.deepEqual(row.needed_by.slice().sort(), ['car_a', 'car_b']);
        assert.equal(Number(row.required_total), 2,
          'two cars need one each: a day-level requirement, not one per stop');
        assert.equal(row.conflict, 'shared_scarce',
          'there is one washer, so both cars cannot be promised it');
      } finally {
        await dropCarB();
      }
    });

  await record('C5 unknown stock is unknown, never zero', async () => {
    const mystery = await newMaterial('FIXTURE never-counted tool');
    const job = await newJob(DAY2, { at: '15:00:00' });
    await measure(job, windows, 10);
    await rule(windows, mystery);
    const r = await rpc(`public.dispatch_equipment_conflicts($1::date)`, [DAY2]);
    const row = r.items.find((i) => i.material_id === mystery);
    assert.ok(row);
    assert.equal(row.usable_at_base, null, 'nothing recorded is null, not 0');
    assert.equal(row.conflict, 'missing_data',
      'and that is missing information, not a shortage');
  });

  await record('C6 damaged-only and unavailable are told apart', async () => {
    const broken = await newMaterial('FIXTURE cracked wand');
    const job = await newJob(DAY2, { at: '16:00:00' });
    await measure(job, windows, 10);
    await rule(windows, broken);
    await rpc(
      `public.post_stock_movement($1,$2,'base',2,'received',null,null,null,null,'damaged','exact')`,
      [opId('mv'), broken]);
    const r = await rpc(`public.dispatch_equipment_conflicts($1::date)`, [DAY2]);
    const row = r.items.find((i) => i.material_id === broken);
    assert.equal(row.conflict, 'damaged_only',
      'two in the damaged pool is not two usable ones');
    assert.equal(Number(row.damaged_at_base), 2);
  });

  // ================================= D. assignment and the load plan ======
  await record('D1 reassignment invalidates both cars\' plans and moves no stock',
    async () => {
      await carB();
      try {
        const day = '2027-07-10';
        const job = await newJob(day, { at: '09:00:00' });
        await measure(job, siding, 100);
        await assignTo(job, 'car_a');
        const planA = await rpc(`public.build_load_plan($1,'car_a',$2::date,null)`,
          [opId('plan'), day]);
        const planB = await rpc(`public.build_load_plan($1,'car_b',$2::date,null)`,
          [opId('plan'), day]);

        const movesBefore = Number((await one(
          `select count(*)::int as n from public.ns_material_stock_moves`)).n);
        const r = await rpc(
          `public.assign_job_to_vehicle($1,$2,'car_b',null,'Car A broke down')`,
          [opId('asg'), job]);
        const movesAfter = Number((await one(
          `select count(*)::int as n from public.ns_material_stock_moves`)).n);

        assert.equal(movesAfter, movesBefore,
          'a reassignment on a screen does not carry a washer across the car park');
        assert.equal(r.stock_moved, false, 'and the receipt says so');
        const ids = r.load_plans_invalidated.map((p) => p.plan_id);
        assert.ok(ids.includes(planA.plan_id), 'the car it left is re-planning');
        assert.ok(ids.includes(planB.plan_id), 'and so is the car it joined');

        const readA = await dayRead('car_a', day);
        assert.equal(readA.load_plan.needs_rebuild, true);
        assert.match(readA.load_plan.invalidated_reason, /assigned to car_b/);
      } finally {
        await dropCarB();
      }
    });

  await record('D2 a late confirmation of an invalidated plan is refused, not loaded',
    async () => {
      const day = '2027-07-11';
      const job = await newJob(day, { at: '09:00:00' });
      await measure(job, siding, 100);
      await assignTo(job, 'car_a');
      const plan = await rpc(`public.build_load_plan($1,'car_a',$2::date,null)`,
        [opId('plan'), day]);

      await rpc(`public.reschedule_job($1,$2,$3::timestamptz,null,'customer moved it')`,
        [opId('resch'), job, `2027-07-12T09:00:00Z`]);

      const err = await errorOf(() => rpc(
        `public.confirm_load_plan($1,$2,$3,$4,null,$5)`,
        [opId('conf'), plan.plan_id, plan.revision, plan.basis_fingerprint,
         plan.lines_fingerprint]));
      assert.ok(err, 'the screen was showing a plan for a day that changed');
      assert.equal(err.code, '23514');
      assert.match(err.message, /re-planned after this load plan was built/i);
    });

  await record('D3 an already-confirmed plan keeps its receipts and its status',
    async () => {
      const day = '2027-07-13';
      const job = await newJob(day, { at: '09:00:00' });
      await measure(job, siding, 100);
      await assignTo(job, 'car_a');
      const plan = await rpc(`public.build_load_plan($1,'car_a',$2::date,null)`,
        [opId('plan'), day]);
      const conf = await rpc(`public.confirm_load_plan($1,$2,$3,$4,null,$5)`,
        [opId('conf'), plan.plan_id, plan.revision, plan.basis_fingerprint,
         plan.lines_fingerprint]);
      assert.ok(conf.transfers_posted >= 1, 'something actually moved');

      await rpc(`public.reschedule_job($1,$2,$3::timestamptz,null,'moved again')`,
        [opId('resch'), job, `2027-07-14T09:00:00Z`]);

      const row = await one(
        `select status, invalidated_at, invalidated_reason from public.ns_load_plans
          where id=$1`, [plan.plan_id]);
      assert.equal(row.status, 'confirmed',
        'the record of what the crew agreed to load is not rewritten');
      assert.ok(row.invalidated_at, 'but it is stamped, so a late confirm is refused');
      const lines = await all(
        `select confirmed_operation from public.ns_load_plan_lines
          where plan_id=$1 and confirmed_operation is not null`, [plan.plan_id]);
      assert.ok(lines.length >= 1, 'and the transfer receipts are still attached');
    });

  await record('D4 unassigning returns the job to needing a car', async () => {
    await carB();
    try {
      const day = '2027-07-15';
      const job = await newJob(day, { at: '09:00:00' });
      await measure(job, siding, 100);
      await assignTo(job, 'car_a');
      const r = await rpc(`public.assign_job_to_vehicle($1,$2,null,null,'not sure yet')`,
        [opId('asg'), job]);
      assert.equal(r.to_location_id, null);
      const read = await dayRead('car_a', day);
      assert.ok(!read.stops.some((s) => s.job_id === job));
      assert.ok(read.unassigned_jobs.some((u) => u.job_id === job));
    } finally {
      await dropCarB();
    }
  });

  await record('D5 a position set for the car it left does not follow the job',
    async () => {
      await carB();
      try {
        const day = '2027-07-16';
        const j1 = await newJob(day, { at: '09:00:00' });
        const j2 = await newJob(day, { at: '10:00:00' });
        await measure(j1, siding, 100); await measure(j2, windows, 10);
        await assignTo(j1, 'car_a'); await assignTo(j2, 'car_a');
        const read = await dayRead('car_a', day);
        await rpc(`public.reorder_dispatch_day($1,'car_a',$2::date,$3::uuid[],$4)`,
          [opId('ord'), day, [j2, j1], read.revision]);

        await rpc(`public.assign_job_to_vehicle($1,$2,'car_b',null,'swap')`,
          [opId('asg'), j1]);
        const { n } = await one(
          `select count(*)::int as n from public.ns_dispatch_order where job_id=$1`, [j1]);
        assert.equal(n, 0,
          'a position for Car A says nothing about Car B, so it is dropped');
        const b = await dayRead('car_b', day);
        assert.equal(b.stops.find((s) => s.job_id === j1).order_state, 'derived');
      } finally {
        await dropCarB();
      }
    });

  await record('D6 a job with no schedule cannot be dispatched', async () => {
    const job = await newJob(null);
    const err = await errorOf(() => rpc(
      `public.assign_job_to_vehicle($1,$2,'car_a',null,null)`, [opId('asg'), job]));
    assert.ok(err); assert.equal(err.code, '23514');
    assert.match(err.message, /no scheduled time/i);
  });

  await record('D7 rescheduling reports both days and the zone it used', async () => {
    const day = '2027-07-17';
    const job = await newJob(day, { at: '09:00:00' });
    await measure(job, siding, 100);
    await assignTo(job, 'car_a');
    const r = await rpc(
      `public.reschedule_job($1,$2,$3::timestamptz,null,'customer asked')`,
      [opId('resch'), job, '2027-07-18T09:00:00Z']);
    assert.equal(r.work_date_before, '2027-07-17');
    assert.equal(r.work_date_after, '2027-07-18');
    assert.equal(r.work_day_timezone, null,
      'unconfigured is reported, not silently UTC');
    assert.equal(r.stock_moved, false);
    assert.equal(r.load_plans_invalidated.length >= 0, true);
  });

  // ====================================== E. property instructions ========
  await record('E1 the entrance note is read from where it already lives', async () => {
    const r = await rpc(`public.get_property_access($1)`, [propA]);
    assert.equal(r.access_note, 'Side gate, unlatched',
      'properties.access_note is not duplicated into the new table');
    assert.equal(r.access, null, 'and nothing has been filled in yet');
    assert.equal(r.coordinates.state, 'known');
  });

  await record('E2 missing coordinates stay missing', async () => {
    const r = await rpc(`public.get_property_access($1)`, [propNoCoords]);
    assert.equal(r.coordinates.state, 'missing');
    assert.equal(r.coordinates.lat, null, 'not 0, and not the middle of town');
  });

  await record('E3 the owner writes the details; the receipt does not echo the code',
    async () => {
      const r = await rpc(
        `public.set_property_access($1,$2,'Round the back','Dog after 4pm',
           'Park on the pad','Invoice by email','4821','We will text on the way',0)`,
        [opId('acc'), propA]);
      assert.equal(r.lock_version, 1);
      assert.equal(r.has_access_code, true);
      assert.equal(JSON.stringify(r).includes('4821'), false,
        'a key does not belong in a receipt that is logged, replayed and rendered');
    });

  await record('E4 a second editor is refused, with both versions', async () => {
    const err = await errorOf(() => rpc(
      `public.set_property_access($1,$2,'Other','x','y','z','0000','w',0)`,
      [opId('acc'), propA]));
    assert.ok(err); assert.equal(err.code, '23514');
    assert.match(err.message, /version 0, it is now 1/i);
  });

  await record('E5 the access code is unreadable except through the scoped function',
    async () => {
      const r = await rpc(`public.get_property_access($1)`, [propA]);
      assert.equal(r.access.access_code, '4821', 'the owner can read it');

      for (const col of ['access_code', 'internal_note']) {
        const { ok } = await one(
          `select has_column_privilege('authenticated','public.ns_property_access',$1,'select') as ok`,
          [col]);
        assert.equal(ok, false, `authenticated can read ${col} directly`);
      }
      const { ok } = await one(
        `select has_column_privilege('authenticated','public.ns_property_access',
           'entrance_note','select') as ok`);
      assert.equal(ok, true, 'but the crew-visible columns are still readable');
    });

  await record('E6 a crew with work there may read it; another car\'s crew may not',
    async () => {
      await carB();
      try {
        const job = await newJob('2027-07-20', { at: '09:00:00', property: propA });
        await measure(job, siding, 100);
        await assignTo(job, 'car_a');
        await makeCrew(crewAId, 'car_a');
        await makeCrew(crewBId, 'car_b');

        await beCrewA();
        const mine = await rpc(`public.get_property_access($1)`, [propA]);
        assert.equal(mine.access.access_code, '4821',
          'the crew going there needs the gate code');

        await beCrewB();
        const err = await errorOf(() => rpc(`public.get_property_access($1)`, [propA]));
        assert.ok(err, 'the other car has no work there');
        assert.equal(err.code, '42501');
        assert.match(err.message, /no work on your vehicle/i);
      } finally {
        await beOwner();
        await dropCarB();
      }
    });

  await record('E7 the customer-facing note is the only customer-facing thing',
    async () => {
      const rows = await all(
        `select * from public.ns_property_customer_notes where property_id=$1`, [propA]);
      assert.equal(rows.length, 1);
      assert.deepEqual(Object.keys(rows[0]).sort(),
        ['customer_note', 'property_id', 'updated_at']);
      assert.equal(rows[0].customer_note, 'We will text on the way');
      const { ok } = await one(
        `select has_table_privilege('anon','public.ns_property_customer_notes','select') as ok`);
      assert.equal(ok, false, 'and no anonymous grant exists: the portal is 13.1\'s');
    });

  // ============================================== F. work zones ===========
  await record('F1 a geographic zone needs real coordinates and three points',
    async () => {
      const good = await rpc(
        `public.save_property_work_zone($1,$2,'Back lawn','work_area','geographic',
           $3::jsonb,null,'mind the sprinklers',null,null)`,
        [opId('zone'), propA, JSON.stringify([
          { lat: 53.5, lng: -113.5 }, { lat: 53.5001, lng: -113.5 },
          { lat: 53.5001, lng: -113.4999 }])]);
      assert.ok(good.zone_id);
      assert.equal(good.space, 'geographic');
      assert.equal(good.is_surveyed_boundary, false);
      assert.equal(good.source, 'owner_drawn');

      const tooFew = await errorOf(() => rpc(
        `public.save_property_work_zone($1,$2,'Line','work_area','geographic',
           $3::jsonb,null,null,null,null)`,
        [opId('zone'), propA, JSON.stringify([
          { lat: 53.5, lng: -113.5 }, { lat: 53.6, lng: -113.5 }])]));
      assert.ok(tooFew); assert.equal(tooFew.code, '22023');
      assert.match(tooFew.message, /at least\s+three points/i);

      const offEarth = await errorOf(() => rpc(
        `public.save_property_work_zone($1,$2,'Nowhere','work_area','geographic',
           $3::jsonb,null,null,null,null)`,
        [opId('zone'), propA, JSON.stringify([
          { lat: 953, lng: -113.5 }, { lat: 53.5, lng: -113.5 },
          { lat: 53.6, lng: -113.4 }])]));
      assert.ok(offEarth); assert.equal(offEarth.code, '22023');
    });

  await record('F2 an image zone must name its image, and is 0..1 of it', async () => {
    const noImage = await errorOf(() => rpc(
      `public.save_property_work_zone($1,$2,'Sketch','work_area','image',
         $3::jsonb,null,null,null,null)`,
      [opId('zone'), propA, JSON.stringify([
        { x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }])]));
    assert.ok(noImage, 'a drawing on a photo is meaningless without the photo');
    assert.equal(noImage.code, '23514');

    const ok = await rpc(
      `public.save_property_work_zone($1,$2,'Sketch','work_area','image',
         $3::jsonb,'fixture/site-sketch.jpg','from the site visit',null,null)`,
      [opId('zone'), propA, JSON.stringify([
        { x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }])]);
    assert.equal(ok.space, 'image');
    assert.equal(ok.image_source, 'fixture/site-sketch.jpg');

    const offImage = await errorOf(() => rpc(
      `public.save_property_work_zone($1,$2,'Off','work_area','image',
         $3::jsonb,'fixture/site-sketch.jpg',null,null,null)`,
      [opId('zone'), propA, JSON.stringify([
        { x: 1.4, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }])]));
    assert.ok(offImage, 'an image fraction above 1 is not on the image');
    assert.equal(offImage.code, '22023');
  });

  await record('F3 a zone is versioned, and retiring it keeps it as history',
    async () => {
      const zones = (await rpc(`public.get_property_access($1)`, [propA])).zones;
      const zone = zones.find((z) => z.label === 'Back lawn');
      const stale = await errorOf(() => rpc(
        `public.save_property_work_zone($1,$2,'Back lawn','work_area','geographic',
           $3::jsonb,null,null,$4,99)`,
        [opId('zone'), propA, JSON.stringify(zone.points), zone.zone_id]));
      assert.ok(stale); assert.equal(stale.code, '23514');

      const gone = await rpc(`public.retire_property_work_zone($1,$2,'fence moved')`,
        [opId('zone'), zone.zone_id]);
      assert.ok(gone.retired_at);
      const after = (await rpc(`public.get_property_access($1)`, [propA])).zones;
      assert.ok(!after.some((z) => z.zone_id === zone.zone_id), 'no longer live');
      const { n } = await one(
        `select count(*)::int as n from public.ns_property_work_zones
          where id=$1 and retired_reason='fence moved'`, [zone.zone_id]);
      assert.equal(n, 1, 'but still on record, with the reason');
    });

  await record('F4 a crew cannot draw zones or write access details', async () => {
    await makeCrew(crewAId, 'car_a');
    await beCrewA();
    const zone = await errorOf(() => rpc(
      `public.save_property_work_zone($1,$2,'Mine','work_area','geographic',
         $3::jsonb,null,null,null,null)`,
      [opId('zone'), propA, JSON.stringify([
        { lat: 53.5, lng: -113.5 }, { lat: 53.6, lng: -113.5 },
        { lat: 53.6, lng: -113.4 }])]));
    const acc = await errorOf(() => rpc(
      `public.set_property_access($1,$2,'x',null,null,null,null,null,1)`,
      [opId('acc'), propA]));
    await beOwner();
    assert.ok(zone); assert.equal(zone.code, '42501');
    assert.ok(acc); assert.equal(acc.code, '42501');
  });

  // =========================== G. issues, states and completion ===========
  await record('G1 a blocked-access report blocks the stop and completes nothing',
    async () => {
      const job = await newJob('2027-07-21', { at: '09:00:00' });
      await measure(job, siding, 100);
      await makeCrew(crewAId, 'car_a');
      await beCrewA();
      const r = await rpc(
        `public.report_job_issue($1,$2,'blocked_access','Gate padlocked, nobody home',null)`,
        [opId('iss'), job]);
      await beOwner();

      assert.ok(r.issue_id);
      assert.equal(r.dispatch_state, 'blocked');
      assert.equal(r.job_status_changed, false);
      assert.equal(r.completion_recorded, false);

      const row = await one(
        `select * from public.ns_job_dispatch_status where job_id=$1`, [job]);
      assert.equal(row.job_status, 'scheduled', 'the commercial status is untouched');
      assert.equal(row.dispatch_state, 'blocked');
      assert.equal(row.completion_state, 'none');
      assert.equal(Number(row.open_issue_count), 1);
    });

  await record('G2 a breakdown is recorded without taking the stop off the day',
    async () => {
      const job = await newJob('2027-07-22', { at: '09:00:00' });
      await measure(job, siding, 100);
      const r = await rpc(
        `public.report_job_issue($1,$2,'equipment_breakdown','Washer pump died',$3)`,
        [opId('iss'), job, washer]);
      assert.equal(r.kind, 'equipment_breakdown');
      assert.equal(r.material_id, washer);
      assert.equal(r.dispatch_state, null,
        'a broken tool does not by itself mean the visit cannot happen');
    });

  await record('G3 an issue needs a reason, and resolution is the owner\'s', async () => {
    const job = await newJob('2027-07-23', { at: '09:00:00' });
    await measure(job, siding, 100);
    const blank = await errorOf(() => rpc(
      `public.report_job_issue($1,$2,'blocked_access','   ',null)`, [opId('iss'), job]));
    assert.ok(blank); assert.equal(blank.code, '22023');

    const r = await rpc(
      `public.report_job_issue($1,$2,'blocked_access','Locked gate',null)`,
      [opId('iss'), job]);
    await makeCrew(crewAId, 'car_a');
    await beCrewA();
    const crewTry = await errorOf(() => rpc(
      `public.resolve_job_issue($1,$2,'resolved','I decided it is fine')`,
      [opId('res'), r.issue_id]));
    await beOwner();
    assert.ok(crewTry); assert.equal(crewTry.code, '42501');

    const done = await rpc(
      `public.resolve_job_issue($1,$2,'resolved','Customer gave us the code')`,
      [opId('res'), r.issue_id]);
    assert.equal(done.resolution_state, 'resolved');
    assert.equal(done.dispatch_state, 'planned', 'and the stop is back on the day');
    assert.equal(done.job_status_changed, false);

    const twice = await errorOf(() => rpc(
      `public.resolve_job_issue($1,$2,'work_cancelled','actually no')`,
      [opId('res'), r.issue_id]));
    assert.ok(twice, 'an issue is resolved once; a second would rewrite the first');
    assert.equal(twice.code, 'P0002');
  });

  await record('G4 work_finished is not completion, and cannot become it here',
    async () => {
      const job = await newJob('2027-07-24', { at: '09:00:00' });
      await measure(job, siding, 100);
      await makeCrew(crewAId, 'car_a');
      await beCrewA();
      const r = await rpc(
        `public.set_dispatch_stage($1,$2,'work_finished','Tools away, site tidy',null)`,
        [opId('stg'), job]);
      await beOwner();
      assert.equal(r.state, 'work_finished');
      assert.equal(r.is_completion, false);
      assert.equal(r.completion_state, 'none');

      const row = await one(
        `select status, completed_at from public.ns_jobs where id=$1`, [job]);
      assert.equal(row.status, 'scheduled');
      assert.equal(row.completed_at, null);

      // And 11.1's gate is still the only way in.
      const direct = await errorOf(() => client.query(
        `update public.ns_jobs set status='completed' where id=$1`, [job]));
      assert.ok(direct, 'dispatch must not have opened a third completion bypass');
      assert.equal(direct.code, '42501');
      assert.match(direct.message, /complete_job_with_evidence/);
    });

  await record('G5 skipping is the owner\'s, and it needs a reason', async () => {
    const job = await newJob('2027-07-25', { at: '09:00:00' });
    await measure(job, siding, 100);
    await makeCrew(crewAId, 'car_a');
    await beCrewA();
    const crewSkip = await errorOf(() => rpc(
      `public.set_dispatch_stage($1,$2,'skipped','cannot be bothered',null)`,
      [opId('stg'), job]));
    await beOwner();
    assert.ok(crewSkip); assert.equal(crewSkip.code, '42501');

    const noReason = await errorOf(() => rpc(
      `public.set_dispatch_stage($1,$2,'skipped',null,null)`, [opId('stg'), job]));
    assert.ok(noReason); assert.equal(noReason.code, '22023');

    const ok = await rpc(
      `public.set_dispatch_stage($1,$2,'skipped','Customer away; moving to next week',null)`,
      [opId('stg'), job]);
    assert.equal(ok.state, 'skipped');
    assert.equal(ok.lock_version, 1);

    const stale = await errorOf(() => rpc(
      `public.set_dispatch_stage($1,$2,'planned',null,99)`, [opId('stg'), job]));
    assert.ok(stale); assert.equal(stale.code, '23514');
  });

  await record('G6 a completed job is not something dispatch can invent', async () => {
    const rows = await all(
      `select completion_state, count(*)::int as n from public.ns_job_dispatch_status
        group by completion_state`);
    assert.ok(rows.every((r) => r.completion_state === 'none'),
      'nothing in this batch has produced an accepted completion');
  });

  // ============================= H. the two customer messages =============
  await record('H1 with no SMS provider configured, nothing is sent and it says so',
    async () => {
      const job = await newJob('2027-07-27', { at: '09:00:00' });
      await measure(job, siding, 100);
      const r = await rpc(`public.request_job_notification($1,$2,'on_the_way','sms')`,
        [opId('nt'), job]);
      assert.equal(r.delivery_state, 'unavailable');
      assert.equal(r.provider_configured, false);
      assert.equal(r.sent, false);
      assert.match(r.reason, /No SMS provider is configured/);
      const { n } = await one(
        `select count(*)::int as n from public.notifications where job_id=$1`, [job]);
      assert.equal(n, 0, 'an unavailable request queues no message');
    });

  await record('H2 with a provider but no number on file, the reason is different',
    async () => {
      await client.query(
        `insert into public.app_settings (key, value)
         values ('notifications', jsonb_build_object('sms_provider','fixture-double'))
         on conflict (key) do update set value = excluded.value`);
      const job = await newJob('2027-07-28', { at: '09:00:00', customer: custNoPhone });
      await measure(job, siding, 100);
      const r = await rpc(`public.request_job_notification($1,$2,'on_the_way','sms')`,
        [opId('nt'), job]);
      assert.equal(r.delivery_state, 'unavailable');
      assert.equal(r.provider_configured, true);
      assert.equal(r.recipient_known, false);
      assert.match(r.reason, /no sms on file/i);
    });

  let liveRequest = null;
  let liveJob = null;
  await record('H3 a crew sends "on the way", and it is accepted and queued', async () => {
    liveJob = await newJob('2027-07-29', { at: '09:00:00' });
    await measure(liveJob, siding, 100);
    await makeCrew(crewAId, 'car_a');
    await beCrewA();
    const r = await rpc(`public.request_job_notification($1,$2,'on_the_way','sms')`,
      [opId('nt'), liveJob]);
    await beOwner();
    liveRequest = r.request_id;
    assert.equal(r.delivery_state, 'accepted');
    assert.equal(r.recipient_known, true);
    assert.equal(r.sent, false, 'accepted is not sent: a provider has to do that');
    assert.ok(r.notification_id, 'and a message is queued in the existing table');

    const note = await one(
      `select kind, channel, recipient, payload, status, sent_at
         from public.notifications where id=$1`, [r.notification_id]);
    assert.equal(note.kind, 'dispatch_on_the_way');
    assert.equal(note.status, 'queued');
    assert.equal(note.sent_at, null);
    assert.equal(JSON.stringify(note.payload).includes('4821'), false,
      'no access code goes out in a customer message');
  });

  await record('H4 a second live request for the same job and kind is a conflict',
    async () => {
      const err = await errorOf(() => rpc(
        `public.request_job_notification($1,$2,'on_the_way','sms')`,
        [opId('nt'), liveJob]));
      assert.ok(err, 'two "on the way" texts for one visit is the duplicate');
      assert.equal(err.code, '23505');
      assert.match(err.message, /already a live on_the_way request/i);

      // A DIFFERENT kind is a different message and is allowed.
      const other = await rpc(
        `public.request_job_notification($1,$2,'access_request','sms')`,
        [opId('nt'), liveJob]);
      assert.equal(other.delivery_state, 'accepted');
    });

  await record('H5 the same key twice is one request; a changed one is refused',
    async () => {
      const job = await newJob('2027-07-30', { at: '09:00:00' });
      await measure(job, siding, 100);
      const key = opId('nt');
      const a = await rpc(`public.request_job_notification($1,$2,'on_the_way','sms')`,
        [key, job]);
      const b = await rpc(`public.request_job_notification($1,$2,'on_the_way','sms')`,
        [key, job]);
      assert.equal(a.replayed, false);
      assert.equal(b.replayed, true);
      assert.equal(b.request_id, a.request_id, 'one request, not two texts');

      const changed = await errorOf(() => rpc(
        `public.request_job_notification($1,$2,'access_request','sms')`, [key, job]));
      assert.ok(changed); assert.equal(changed.code, '23505');
    });

  await record('H6 delivered, failed and unknown are three different outcomes',
    async () => {
      // THE PROVIDER DOUBLE: these calls are what a provider webhook would
      // do. No provider is configured beyond a name in settings and no
      // message leaves this database.
      const crewTry = await (async () => {
        await makeCrew(crewAId, 'car_a');
        await beCrewA();
        const e = await errorOf(() => rpc(
          `public.record_notification_outcome($1,'delivered','fixture-1',null)`,
          [liveRequest]));
        await beOwner();
        return e;
      })();
      assert.ok(crewTry, 'a crew cannot mark its own message delivered');
      assert.equal(crewTry.code, '42501');

      const unknown = await rpc(
        `public.record_notification_outcome($1,'unknown',null,'provider timed out')`,
        [liveRequest]);
      assert.equal(unknown.delivery_state, 'unknown');
      assert.equal(unknown.still_live, true,
        'unknown keeps blocking a second text, because a retry might be a duplicate');

      const blocked = await errorOf(() => rpc(
        `public.request_job_notification($1,$2,'on_the_way','sms')`,
        [opId('nt'), liveJob]));
      assert.ok(blocked); assert.equal(blocked.code, '23505');

      const delivered = await rpc(
        `public.record_notification_outcome($1,'delivered','fixture-msg-1',null)`,
        [liveRequest]);
      assert.equal(delivered.delivery_state, 'delivered');
      assert.equal(delivered.still_live, false);
      const note = await one(
        `select status, sent_at from public.notifications
          where id = (select notification_id from public.ns_notification_requests
                       where id=$1)`, [liveRequest]);
      assert.equal(note.status, 'sent');
      assert.ok(note.sent_at, 'sent_at is set when somebody says it went, not before');

      const again = await errorOf(() => rpc(
        `public.record_notification_outcome($1,'provider_failed',null,'late bounce')`,
        [liveRequest]));
      assert.ok(again, 'a finished outcome is recorded once');
      assert.equal(again.code, '23514');
    });

  await record('H7 a failure needs the provider\'s reason, and is visible', async () => {
    const job = await newJob('2027-07-31', { at: '09:00:00' });
    await measure(job, siding, 100);
    const r = await rpc(`public.request_job_notification($1,$2,'access_request','sms')`,
      [opId('nt'), job]);
    const noReason = await errorOf(() => rpc(
      `public.record_notification_outcome($1,'provider_failed',null,null)`,
      [r.request_id]));
    assert.ok(noReason); assert.equal(noReason.code, '22023');

    const failed = await rpc(
      `public.record_notification_outcome($1,'provider_failed',null,'unroutable number')`,
      [r.request_id]);
    assert.equal(failed.delivery_state, 'provider_failed');
    const view = await rpc(`public.job_notification_requests($1)`, [job]);
    assert.equal(view.requests[0].delivery_state, 'provider_failed');
    assert.equal(view.requests[0].reason, 'unroutable number');
    assert.equal(view.requests[0].still_live, false,
      'a failure is retryable: it no longer blocks a deliberate second attempt');

    const retry = await rpc(`public.request_job_notification($1,$2,'access_request','sms')`,
      [opId('nt'), job]);
    assert.equal(retry.delivery_state, 'accepted');
  });

  await record('H8 the resolved recipient is never read back', async () => {
    const { ok } = await one(
      `select has_column_privilege('authenticated','public.ns_notification_requests',
         'recipient','select') as ok`);
    assert.equal(ok, false);
    const view = await rpc(`public.job_notification_requests($1)`, [liveJob]);
    assert.equal(JSON.stringify(view).includes('+15550100'), false);
    assert.equal(view.requests[0].recipient_known, true,
      'whether we have one is a different fact from what it is');
  });

  await record('H9 a crew cannot message another car\'s customer', async () => {
    await carB();
    try {
      const job = await newJob('2027-08-01', { at: '09:00:00' });
      await measure(job, siding, 100);
      await assignTo(job, 'car_b');
      await makeCrew(crewAId, 'car_a');
      await beCrewA();
      const err = await errorOf(() => rpc(
        `public.request_job_notification($1,$2,'on_the_way','sms')`, [opId('nt'), job]));
      await beOwner();
      assert.ok(err); assert.equal(err.code, '42501');
      assert.match(err.message, /not yours to message/i);
    } finally {
      await dropCarB();
    }
  });

  // ================================= I. winter, triggered by hand =========
  await record('I1 no weather rule is configured, and the read says so', async () => {
    const state = await rpc(`public.ns_winter_automation_state()`);
    assert.equal(state.mode, 'owner_triggered');
    assert.equal(state.snowfall_threshold.state, 'unconfigured');
    assert.equal(state.forecast_source.state, 'unconfigured');
    assert.equal(state.visit_allowance.state, 'unconfigured');
    assert.match(state.note, /Nothing dispatches winter work automatically/);
  });

  await record('I2 walkway and deck at one property are ONE candidate row', async () => {
    const prop = await newProperty({ address: '9 FIXTURE Crescent' });
    const walk = await newJob('2027-12-02', { at: '08:00:00', property: prop });
    const deck = await newJob('2027-12-02', { at: '08:30:00', property: prop });
    await measure(walk, winter, 1);
    await measure(deck, winterDeck, 1);

    const r = await rpc(`public.ns_winter_dispatch_candidates($1::date)`, ['2027-12-02']);
    const rows = r.candidates.filter((c) => c.property_id === prop);
    assert.equal(rows.length, 1,
      'one property, one visit: two rows would be two dispatches and two minimums');
    assert.deepEqual(rows[0].services.slice().sort(),
      ['winter_property_care', 'winter_property_care_deck']);
    assert.equal(rows[0].job_ids.length, 2, 'both jobs are named on the one row');
  });

  await record('I3 the owner triggers a winter visit; a second one that day is refused',
    async () => {
      const prop = await newProperty({ address: '10 FIXTURE Crescent' });
      const first = await newJob(null, { property: prop });
      const second = await newJob(null, { property: prop });
      await measure(first, winter, 1);
      await measure(second, winterDeck, 1);

      const jobsBefore = Number((await one(
        `select count(*)::int as n from public.ns_jobs`)).n);
      const r = await rpc(
        `public.dispatch_winter_visit($1,$2,'car_a',$3::timestamptz,'15cm overnight, owner decision')`,
        [opId('win'), first, '2027-12-05T07:00:00Z']);
      const jobsAfter = Number((await one(
        `select count(*)::int as n from public.ns_jobs`)).n);

      assert.equal(jobsAfter, jobsBefore, 'no job is invented');
      assert.equal(r.created_job, false);
      assert.equal(r.created_minimum, false);
      assert.equal(r.work_date, '2027-12-05');
      assert.equal(r.automation.snowfall_threshold.state, 'unconfigured',
        'the reason is the record of the decision, not a rule');

      const dupe = await errorOf(() => rpc(
        `public.dispatch_winter_visit($1,$2,'car_a',$3::timestamptz,'deck too')`,
        [opId('win'), second, '2027-12-05T09:00:00Z']));
      assert.ok(dupe, 'the deck is the same trip out');
      assert.equal(dupe.code, '23505');
      assert.match(dupe.message, /one visit, not two/i);
    });

  await record('I4 a non-winter job cannot be dispatched as a winter visit', async () => {
    const job = await newJob(null);
    await measure(job, siding, 100);
    const err = await errorOf(() => rpc(
      `public.dispatch_winter_visit($1,$2,'car_a',$3::timestamptz,'snow')`,
      [opId('win'), job, '2027-12-06T07:00:00Z']));
    assert.ok(err); assert.equal(err.code, '22023');
    assert.match(err.message, /no winter service/i);
  });

  await record('I5 a winter visit needs a stated reason, and the crew cannot trigger it',
    async () => {
      const prop = await newProperty({ address: '11 FIXTURE Crescent' });
      const job = await newJob(null, { property: prop });
      await measure(job, winter, 1);
      const blank = await errorOf(() => rpc(
        `public.dispatch_winter_visit($1,$2,'car_a',$3::timestamptz,'  ')`,
        [opId('win'), job, '2027-12-07T07:00:00Z']));
      assert.ok(blank); assert.equal(blank.code, '22023');

      await makeCrew(crewAId, 'car_a');
      await beCrewA();
      const crewTry = await errorOf(() => rpc(
        `public.dispatch_winter_visit($1,$2,'car_a',$3::timestamptz,'it snowed')`,
        [opId('win'), job, '2027-12-07T07:00:00Z']));
      await beOwner();
      assert.ok(crewTry); assert.equal(crewTry.code, '42501');
      assert.match(crewTry.message, /no weather rule/i);
    });

  // ====================================== J. seasonal stages stay apart ===
  await record('J1 a seasonal assignment is a promise, not a set aboard a car',
    async () => {
      const reg = await rpc(
        `public.register_seasonal_set($1,'FIXTURE-12-1','C9','warm_white',30,
           'base',null,null,'fixture')`, [opId('set')]);
      const setId = reg.set.set_id;
      // 9.1 refuses to promise an uninspected set, which is the rule the
      // seasonal corrective exists to keep. Inspect it first.
      await rpc(`public.inspect_seasonal_set($1,$2,'usable','fixture check')`,
        [opId('insp'), setId]);
      const job = await newJob('2027-11-20', { at: '09:00:00' });
      await measure(job, siding, 10);
      await rpc(`public.assign_seasonal_set($1,$2,$3,2027,$4,$5,'fixture')`,
        [opId('seas'), setId, cust, propA, job]);

      const row = await one(
        `select * from public.ns_dispatch_seasonal_work where job_id=$1`, [job]);
      assert.equal(row.promised_to_a_customer, true);
      assert.equal(row.aboard_a_vehicle, false,
        'promised for the 20th is not the same as on the van');
      assert.equal(row.physically_installed, false);
      assert.equal(row.stage, 'to_install', 'a label for a screen, not a transition');
    });

  await record('J2 the five seasonal acts are still five separate functions', async () => {
    const rows = await all(
      `select proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and proname in
          ('install_seasonal_set','recover_seasonal_set','inspect_seasonal_set',
           'release_seasonal_set','record_set_renewal')`);
    assert.equal(new Set(rows.map((r) => r.proname)).size, 5);
    // And nothing in 12.1 wraps them.
    const wrappers = await all(
      `select proname, prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and proname like '%dispatch%'`);
    for (const w of wrappers) {
      for (const act of ['install_seasonal_set', 'recover_seasonal_set',
                         'release_seasonal_set']) {
        assert.ok(!w.prosrc.includes(act),
          `${w.proname} calls ${act}: a dispatch stage must not invoke a seasonal act`);
      }
    }
  });

  // ================================================ K. authorisation ======
  await record('K1 anon holds no execute on any 12.1 function', async () => {
    for (const f of [
      'public.get_dispatch_day(text,date)',
      'public.reorder_dispatch_day(text,text,date,uuid[],integer)',
      'public.assign_job_to_vehicle(text,uuid,text,integer,text)',
      'public.reschedule_job(text,uuid,timestamptz,integer,text)',
      'public.get_property_access(uuid)',
      'public.set_property_access(text,uuid,text,text,text,text,text,text,integer)',
      'public.save_property_work_zone(text,uuid,text,text,text,jsonb,text,text,uuid,integer)',
      'public.report_job_issue(text,uuid,text,text,uuid)',
      'public.set_dispatch_stage(text,uuid,text,text,integer)',
      'public.request_job_notification(text,uuid,text,text)',
      'public.record_notification_outcome(uuid,text,text,text)',
      'public.dispatch_equipment_conflicts(date)',
      'public.dispatch_winter_visit(text,uuid,text,timestamptz,text)'
    ]) {
      const { ok } = await one(
        `select has_function_privilege('anon',$1,'execute') as ok`, [f]);
      assert.equal(ok, false, `anon can execute ${f}`);
    }
  });

  await record('K2 authenticated cannot write any 12.1 table by hand', async () => {
    for (const t of [
      'public.ns_dispatch_days', 'public.ns_dispatch_order',
      'public.ns_dispatch_operations', 'public.ns_property_access',
      'public.ns_property_work_zones', 'public.ns_job_dispatch_state',
      'public.ns_job_issues', 'public.ns_notification_requests'
    ]) {
      for (const priv of ['insert', 'update', 'delete']) {
        const { ok } = await one(
          `select has_table_privilege('authenticated',$1,$2) as ok`, [t, priv]);
        assert.equal(ok, false, `authenticated can ${priv} ${t}`);
      }
    }
  });

  await record('K3 a non-admin gets nowhere', async () => {
    await client.query(`select set_config('nova.is_admin','off',false)`);
    try {
      for (const [sql, extra] of [
        [`public.get_dispatch_day('car_a',$1::date)`, [DAY]],
        [`public.get_property_access($1)`, [propA]],
        [`public.dispatch_equipment_conflicts($1::date)`, [DAY]],
        [`public.ns_winter_dispatch_candidates($1::date)`, [DAY]]
      ]) {
        const err = await errorOf(() => rpc(sql, extra));
        assert.ok(err, sql); assert.equal(err.code, '42501', sql);
      }
    } finally {
      await client.query(`select set_config('nova.is_admin','on',false)`);
    }
  });

  await record('K4 RLS is on and every 12.1 table has exactly one read policy',
    async () => {
      for (const t of [
        'ns_dispatch_days', 'ns_dispatch_order', 'ns_dispatch_operations',
        'ns_property_access', 'ns_property_work_zones',
        'ns_job_dispatch_state', 'ns_job_issues', 'ns_notification_requests'
      ]) {
        const row = await one(
          `select c.relrowsecurity as on,
                  (select count(*)::int from pg_policy where polrelid = c.oid) as policies
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname='public' and c.relname=$1`, [t]);
        assert.equal(row.on, true, `${t} has RLS off`);
        assert.equal(row.policies, 1, `${t} has ${row.policies} policies`);
      }
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
