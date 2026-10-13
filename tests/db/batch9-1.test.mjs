// Batch 9.1 -- executable database tests for company-owned Christmas
// lighting sets, seasonal assignment and recovery, run against a DEDICATED
// DISPOSABLE DATABASE.
//
//   node tests/db/setup-test-db.mjs        # once, creates + stamps the DB
//   node tests/db/batch9-1.test.mjs
//
// Override the target with PGURL; the guards in disposable.mjs refuse
// anything that is not the dedicated local database, by pure string
// inspection before any connection is attempted.
//
// Scope and honesty:
//   * passing proves the Batch 8.1 + 9.1 migrations apply in order and are
//     re-runnable against real PostgreSQL, that a set's identity survives
//     its customers, that the conflict/inspection/release rules refuse what
//     their comments claim, that replay is safe for every seasonal RPC, that
//     the accounting model conserves quantity across the stock/asset line,
//     and that owner-only operations are refused to a crew.
//   * it does NOT prove anything about the live database. NO BATCH 8.1 OR
//     9.1 MIGRATION HAS BEEN APPLIED TO PRODUCTION.

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

// The pending sequence this suite rehearses, in filename order -- which is
// the order Supabase applies them in.
const SEQUENCE = [
  '20261010120000_batch8_1_inventory_and_rental_sets.sql',
  '20261010121000_batch8_1_estimate_job_materials.sql',
  '20261010130000_batch8_1_stock_operations_contract_v1.sql',
  '20261010140000_batch8_1_reservations_units_and_crew_access.sql',
  '20261010141000_batch8_1_reservation_operations.sql',
  '20261011090000_batch9_1_seasonal_set_identity_and_assignments.sql',
  '20261011091000_batch9_1_seasonal_operations.sql',
  '20261012090000_batch9_1_corrective_seasonal_review.sql',
  '20261013090000_batch11_1_seasonal_corrective_round_two.sql'
];
const migration = (file) => readFileSync(join(MIGRATIONS, file), 'utf8');

const results = [];
async function record(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, err: err && err.message }); }
}
async function errorOf(fn) {
  try { await fn(); return null; } catch (err) { return err; }
}

let opSeq = 0;
const opId = (tag) => `t9-${tag}-${++opSeq}`;

(async () => {
  assertDisposableTarget(PGURL);
  const client = new pg.Client({ connectionString: PGURL });
  await client.connect();
  await assertDisposableDatabase(client);

  const one = async (sql, params) => (await client.query(sql, params)).rows[0];
  const all = async (sql, params) => (await client.query(sql, params)).rows;
  const rpc = async (fn, args) =>
    (await one(`select ${fn} as r`, args)).r;

  /* Drop the objects under test first, so the migrations are what create
     them. Same reasoning as the 8.1 suite: a second run must not be testing
     the previous run's tables plus whatever `if not exists` skipped. */
  await client.query(`
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
    drop function if exists public.estimate_job_materials(uuid, text);
    drop function if exists public.estimate_job_materials(uuid);
    drop function if exists public.post_stock_movement(text,uuid,text,numeric,text,text,uuid,uuid,text);
    drop function if exists public.post_stock_movement(text,uuid,text,numeric,text,text,uuid,uuid,text,text,text);
    drop function if exists public.post_stock_transfer(text,uuid,numeric,text,text,boolean,text,uuid);
    drop function if exists public.reserve_stock(text,uuid,text,numeric,uuid,text,timestamptz);
    drop function if exists public.release_stock_reservation(text,uuid,text);
    drop function if exists public.consume_stock_reservation(text,uuid,numeric,text,text);
    drop function if exists public.register_seasonal_set(text,text,text,text,numeric,text,uuid,numeric,text);
    drop function if exists public.assign_seasonal_set(text,uuid,uuid,integer,uuid,uuid,text);
    drop function if exists public.cancel_seasonal_assignment(text,uuid,text);
    drop function if exists public.install_seasonal_set(text,uuid,timestamptz,uuid,text);
    drop function if exists public.recover_seasonal_set(text,uuid,text,text,timestamptz,text);
    drop function if exists public.inspect_seasonal_set(text,uuid,text,text);
    drop function if exists public.release_seasonal_set(text,uuid,text);
    drop function if exists public.record_set_renewal(text,uuid,text,text);
    drop function if exists public.retire_seasonal_set(text,uuid,uuid,numeric,text,text);
    drop function if exists public.ns_seasonal_result(uuid,uuid,boolean) cascade;
    drop function if exists public.ns_seasonal_replay(text) cascade;
    drop function if exists public.ns_seasonal_release_cutoff(integer) cascade;
    drop function if exists public.can_handle_set(uuid) cascade;
    drop function if exists public.ns_operation_result(uuid,boolean);
    drop function if exists public.ns_reservation_result(uuid,boolean);
    drop function if exists public.ns_location_by_code(text);
    drop function if exists public.is_owner() cascade;
    drop function if exists public.current_crew_vehicle() cascade;
    drop function if exists public.can_see_location(uuid) cascade;
    drop function if exists public.ns_touch_updated_at() cascade;
    drop function if exists public.ns_guard_transfer_conserves() cascade;
    drop function if exists public.ns_guard_operation_vehicle() cascade;
    drop function if exists public.ns_guard_reservation_available() cascade;
    drop function if exists public.ns_guard_moves_respect_reservations() cascade;
    drop function if exists public.ns_guard_set_matches_assignment() cascade;
  `);

  await client.query(readFileSync(join(HERE, 'fixture-schema-batch8-1.sql'), 'utf8'));
  await client.query(readFileSync(join(HERE, 'fixture-schema-batch9-1.sql'), 'utf8'));

  // =============================================== A. the migrations ======
  for (const [i, file] of SEQUENCE.entries()) {
    await record(`A${i + 1} ${file} applies cleanly in sequence`, async () => {
      await client.query(migration(file));
    });
  }

  await record('A20 the 9.1 migrations are re-runnable', async () => {
    for (const file of SEQUENCE.slice(5)) await client.query(migration(file));
    for (const file of SEQUENCE.slice(5)) await client.query(migration(file));
    const { n } = await one(
      `select count(*)::int as n from pg_policy
        where polrelid='public.ns_seasonal_assignments'::regclass`);
    assert.equal(n, 1, 'a re-run must not stack duplicate policies');
  });

  /* A LIMITATION, TESTED RATHER THAN ASSUMED. Once 9.1 has restructured
     ns_rental_sets, re-applying 8.1's table migration ON TOP of it fails:
     its `create index if not exists ns_rental_sets_customer_idx` names a
     column 9.1 deliberately removed. That is inherent to migrating by ALTER
     and it is NOT a production scenario -- Supabase applies each migration
     once, in filename order, and A1-A7 prove that order works from a clean
     database. The check exists so the boundary is a documented fact instead
     of a surprise for whoever next re-runs a migration by hand. */
  await record('A21 re-applying the 8.1 table migration AFTER 9.1 is refused, by design',
    async () => {
      const err = await errorOf(() => client.query(migration(SEQUENCE[0])));
      assert.ok(err, 'if this ever passes, 8.1 has stopped referencing the dropped columns');
      assert.match(err.message, /customer_id|season_year/,
        'and it must fail on a column 9.1 removed, not on something else');
      // Leave the database in the state the rest of the suite expects.
      for (const file of SEQUENCE.slice(5)) await client.query(migration(file));
    });

  // The RPCs are admin-only and the fixture's is_admin() reads a GUC; the
  // cases that are ABOUT authorisation flip it themselves and put it back.
  const ownerId = (await one('insert into auth.users default values returning id')).id;
  const crewId  = (await one('insert into auth.users default values returning id')).id;
  await client.query(`select set_config('nova.is_admin','on',false)`);
  await client.query(`select set_config('nova.actor_id',$1,false)`, [ownerId]);

  const beOwner = () => client.query(`select set_config('nova.actor_id',$1,false)`, [ownerId]);
  const beCrew  = () => client.query(`select set_config('nova.actor_id',$1,false)`, [crewId]);

  // ---- fixtures the TESTS own
  const custA = (await one(
    `insert into public.customers (name) values ('FIXTURE Patterson') returning id`)).id;
  const custB = (await one(
    `insert into public.customers (name) values ('FIXTURE Okonkwo') returning id`)).id;
  const propA = (await one(
    `insert into public.properties (customer_id,address) values ($1,'1 Fixture Way') returning id`,
    [custA])).id;
  const jobA = (await one(
    `insert into public.ns_jobs (customer_id,property_id) values ($1,$2) returning id`,
    [custA, propA])).id;

  const supplierId = (await one('select id from public.ns_suppliers limit 1')).id;
  const newMaterial = async (name) => (await one(
    `insert into public.ns_materials
       (name,category,unit,supplier_id,pack_quantity,reorder_point,reorder_qty)
     values ($1,'light','linear_ft',$2,1,0,0) returning id`, [name, supplierId])).id;

  const carB = (await one(
    `insert into public.ns_stock_locations (code,name,kind,sort_order)
     values ('car_b','Car B','vehicle',2) returning id`)).id;

  /** Register a set and return its id. */
  const newSet = async (code, over = {}) => {
    const r = await rpc(
      `public.register_seasonal_set($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [opId('reg'), code, over.run_type ?? 'roofline', over.colour ?? 'warm white',
       over.linear_ft ?? 40, over.location_code ?? 'base',
       over.material_id ?? null, over.build_quantity ?? null, over.note ?? null]);
    return r.set.set_id;
  };
  /** Register and inspect, i.e. a set that is actually offerable. */
  const usableSet = async (code, over = {}) => {
    const id = await newSet(code, over);
    await rpc(`public.inspect_seasonal_set($1,$2,'usable',$3)`,
      [opId('insp'), id, 'fixture bench check']);
    return id;
  };
  const setRow = (id) => one('select * from public.ns_rental_sets where id=$1', [id]);
  const avail  = (id) => one(
    'select * from public.ns_seasonal_set_availability where set_id=$1', [id]);

  // ================================================ B. set identity =======
  await record('B1 the customer no longer lives on the set', async () => {
    const cols = (await all(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name='ns_rental_sets'`)).map(r => r.column_name);
    for (const gone of ['customer_id', 'property_id', 'installed_at', 'removed_at', 'season_year']) {
      assert.ok(!cols.includes(gone), `${gone} must have moved to the assignment`);
    }
    for (const want of ['condition', 'inspected_at', 'location_id', 'run_type',
                        'colour', 'built_from_operation', 'stripped_to_operation']) {
      assert.ok(cols.includes(want), `${want} is part of a set's identity`);
    }
  });

  await record('B2 the status vocabulary is physical only', async () => {
    const id = await newSet('FIXTURE B2');
    for (const bad of ['assigned', 'installed', 'rented']) {
      const err = await errorOf(() => client.query(
        'update public.ns_rental_sets set status=$1 where id=$2', [bad, id]));
      assert.ok(err, `${bad} describes an assignment, not a place`);
      assert.equal(err.code, '23514');
    }
    for (const ok of ['in_storage', 'in_repair', 'lost']) {
      await client.query('update public.ns_rental_sets set status=$1 where id=$2', [ok, id]);
    }
    await client.query(`update public.ns_rental_sets set status='in_storage' where id=$1`, [id]);
  });

  await record('B3 a new set is uninspected, and that is not the same as fine', async () => {
    const id = await newSet('FIXTURE B3');
    const s = await setRow(id);
    assert.equal(s.condition, 'uninspected');
    assert.equal(s.inspected_at, null);
    const v = await avail(id);
    assert.equal(v.needs_inspection, true);
    assert.equal(v.available_for_reuse, false,
      'a set nobody has looked at must not be offered to a customer');
  });

  await record('B4 "inspected" cannot exist without a date', async () => {
    const id = await newSet('FIXTURE B4');
    const err = await errorOf(() => client.query(
      `update public.ns_rental_sets set condition='usable' where id=$1`, [id]));
    assert.ok(err); assert.equal(err.code, '23514');
  });

  await record('B5 a retired set must say when', async () => {
    const id = await newSet('FIXTURE B5');
    const err = await errorOf(() => client.query(
      `update public.ns_rental_sets set status='retired' where id=$1`, [id]));
    assert.ok(err); assert.equal(err.code, '23514');
  });

  await record('B6 the same set code twice is refused', async () => {
    await newSet('FIXTURE B6');
    const err = await errorOf(() => newSet('fixture b6'));
    assert.ok(err); assert.equal(err.code, '23505');
  });

  // ============================================= C. assignment rules ======
  await record('C1 a usable, inspected, stored set is available and assigns', async () => {
    const id = await usableSet('FIXTURE C1');
    assert.equal((await avail(id)).available_for_reuse, true);
    const r = await rpc(`public.assign_seasonal_set($1,$2,$3,$4,$5,$6,$7)`,
      [opId('asg'), id, custA, 2026, propA, jobA, null]);
    assert.equal(r.assignment.status, 'assigned');
    assert.equal(r.assignment.customer_id, custA);
    assert.equal(r.assignment.season_year, 2026);
    assert.equal(r.availability.available_for_reuse, false,
      'an assigned set is no longer available');
  });

  await record('C2 a second customer cannot be promised the same set', async () => {
    const id = await usableSet('FIXTURE C2');
    await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
      [opId('asg'), id, custA]);
    const err = await errorOf(() => rpc(
      `public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
      [opId('asg'), id, custB]));
    assert.ok(err); assert.equal(err.code, '23505');
    assert.match(err.message, /already assigned/i);
  });

  await record('C2b the conflict rule holds against a direct insert too', async () => {
    const id = await usableSet('FIXTURE C2b');
    await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
      [opId('asg'), id, custA]);
    const err = await errorOf(() => client.query(
      `insert into public.ns_seasonal_assignments
         (set_id,customer_id,season_year,client_operation_id)
       values ($1,$2,2026,$3)`, [id, custB, opId('direct')]));
    assert.ok(err, 'the partial unique index is the backstop, not the RPC');
    assert.equal(err.code, '23505');
  });

  await record('C3 an uninspected set cannot be assigned', async () => {
    const id = await newSet('FIXTURE C3');
    const err = await errorOf(() => rpc(
      `public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`, [opId('asg'), id, custA]));
    assert.ok(err); assert.equal(err.code, '23514');
    assert.match(err.message, /inspect/i);
  });

  await record('C4 a damaged set cannot be assigned', async () => {
    const id = await newSet('FIXTURE C4');
    await rpc(`public.inspect_seasonal_set($1,$2,'damaged',null)`, [opId('insp'), id]);
    const err = await errorOf(() => rpc(
      `public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`, [opId('asg'), id, custA]));
    assert.ok(err); assert.equal(err.code, '23514');
  });

  await record('C5 a retired set cannot be assigned', async () => {
    const id = await usableSet('FIXTURE C5');
    await rpc(`public.retire_seasonal_set($1,$2,null,null,null,null)`, [opId('ret'), id]);
    const err = await errorOf(() => rpc(
      `public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`, [opId('asg'), id, custA]));
    assert.ok(err); assert.equal(err.code, '23514');
  });

  await record('C6 a season has to be stated, not guessed from today', async () => {
    const id = await usableSet('FIXTURE C6');
    const err = await errorOf(() => rpc(
      `public.assign_seasonal_set($1,$2,$3,null,null,null,null)`, [opId('asg'), id, custA]));
    assert.ok(err); assert.equal(err.code, '22023');
  });

  await record('C7 an unknown customer is refused', async () => {
    const id = await usableSet('FIXTURE C7');
    const err = await errorOf(() => rpc(
      `public.assign_seasonal_set($1,$2,'00000000-0000-0000-0000-000000000000',2026,null,null,null)`,
      [opId('asg'), id]));
    assert.ok(err); assert.equal(err.code, 'P0002');
  });

  await record('C8 a cancelled assignment frees the set again', async () => {
    const id = await usableSet('FIXTURE C8');
    const a = await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
      [opId('asg'), id, custA]);
    await rpc(`public.cancel_seasonal_assignment($1,$2,null)`,
      [opId('cxl'), a.assignment.assignment_id]);
    assert.equal((await avail(id)).available_for_reuse, true);
    const r = await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
      [opId('asg'), id, custB]);
    assert.equal(r.assignment.customer_id, custB);
    const { n } = await one(
      `select count(*)::int as n from public.ns_seasonal_assignments where set_id=$1`, [id]);
    assert.equal(n, 2, 'the cancelled promise is history, not a deletion');
  });

  await record('C9 an installed set cannot be cancelled -- it comes back by recovery', async () => {
    const id = await usableSet('FIXTURE C9');
    const a = await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
      [opId('asg'), id, custA]);
    await rpc(`public.install_seasonal_set($1,$2,null,null,null)`,
      [opId('ins'), a.assignment.assignment_id]);
    const err = await errorOf(() => rpc(`public.cancel_seasonal_assignment($1,$2,null)`,
      [opId('cxl'), a.assignment.assignment_id]));
    assert.ok(err); assert.equal(err.code, '23514');
  });

  // ================================================= D. the full cycle ====
  await record('D1 assign -> install -> recover -> inspect -> release', async () => {
    const id = await usableSet('FIXTURE D1');
    const a = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,$4,$5,null)`,
      [opId('asg'), id, custA, propA, jobA])).assignment.assignment_id;

    let r = await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [opId('ins'), a]);
    assert.equal(r.assignment.status, 'installed');
    assert.equal(r.set.status, 'deployed');
    assert.equal(r.set.location_id, null, 'a deployed set is at no stock location');

    r = await rpc(`public.recover_seasonal_set($1,$2,'usable','base',null,null)`,
      [opId('rec'), a]);
    assert.equal(r.assignment.status, 'removed');
    assert.equal(r.assignment.recovery_condition, 'usable');
    assert.equal(r.set.status, 'in_storage');
    assert.equal(r.set.condition, 'uninspected',
      'coming back looking fine is not an inspection');
    assert.equal(r.availability.available_for_reuse, false);

    r = await rpc(`public.inspect_seasonal_set($1,$2,'usable',null)`, [opId('insp'), id]);
    assert.equal(r.set.condition, 'usable');
    assert.ok(r.set.inspected_at);
    // Inspected is not the same as free. The season is not over until it is
    // released, and until then the set still answers to this assignment.
    assert.equal(r.availability.awaiting_release, true);
    assert.equal(r.availability.available_for_reuse, false);

    r = await rpc(`public.release_seasonal_set($1,$2,null)`, [opId('rel'), a]);
    assert.equal(r.assignment.status, 'released');
    assert.ok(r.assignment.released_at);
    assert.equal(r.availability.available_for_reuse, true);
  });

  await record('D1b a recovered, inspected set cannot be promised again until released',
    async () => {
      const id = await usableSet('FIXTURE D1b');
      const a = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
        [opId('asg'), id, custA])).assignment.assignment_id;
      await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [opId('ins'), a]);
      await rpc(`public.recover_seasonal_set($1,$2,'usable','base',null,null)`, [opId('rec'), a]);
      await rpc(`public.inspect_seasonal_set($1,$2,'usable',null)`, [opId('insp'), id]);

      const v = await avail(id);
      assert.equal(v.awaiting_release, true);
      assert.equal(v.available_for_reuse, false);

      const err = await errorOf(() => rpc(
        `public.assign_seasonal_set($1,$2,$3,2027,null,null,null)`, [opId('asg'), id, custB]));
      assert.ok(err, 'two open assignments on one set is the state being prevented');
      assert.equal(err.code, '23505');
      assert.match(err.message, /not been released/i);

      // And the release is what frees it.
      await rpc(`public.release_seasonal_set($1,$2,null)`, [opId('rel'), a]);
      assert.equal((await avail(id)).available_for_reuse, true);
      const r = await rpc(`public.assign_seasonal_set($1,$2,$3,2027,null,null,null)`,
        [opId('asg'), id, custB]);
      assert.equal(r.assignment.season_year, 2027);
    });

  await record('D1c the open-assignment rule holds against a direct insert too', async () => {
    const id = await usableSet('FIXTURE D1c');
    const a = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
      [opId('asg'), id, custA])).assignment.assignment_id;
    await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [opId('ins'), a]);
    await rpc(`public.recover_seasonal_set($1,$2,'usable','base',null,null)`, [opId('rec'), a]);
    const err = await errorOf(() => client.query(
      `insert into public.ns_seasonal_assignments
         (set_id,customer_id,season_year,client_operation_id)
       values ($1,$2,2027,$3)`, [id, custB, opId('direct')]));
    assert.ok(err, 'the partial index must cover removed, not just assigned/installed');
    assert.equal(err.code, '23505');
  });

  await record('D1d a cancelled or released assignment does not hold the set', async () => {
    const { n } = await one(
      `select count(*)::int as n from pg_index i
         join pg_class c on c.oid = i.indexrelid
        where c.relname = 'ns_seasonal_assignments_one_open_per_set'`);
    assert.equal(n, 1, 'the open-assignment index must exist under its current name');
    const { gone } = await one(
      `select count(*)::int as gone from pg_class
        where relname = 'ns_seasonal_assignments_one_active_per_set'`);
    assert.equal(gone, 0, 'and the narrower form it replaced must not survive a re-run');
  });

  await record('D2 a set cannot be installed twice over, or without an assignment', async () => {
    const id = await usableSet('FIXTURE D2');
    const a = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
      [opId('asg'), id, custA])).assignment.assignment_id;
    await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [opId('ins'), a]);
    // A second install under a NEW key is the same outcome, not a second set
    // on the roof, so it reports replayed rather than raising.
    const r = await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [opId('ins'), a]);
    assert.equal(r.replayed, true);
    const err = await errorOf(() => rpc(`public.install_seasonal_set($1,$2,null,null,null)`,
      [opId('ins'), '00000000-0000-0000-0000-000000000000']));
    assert.ok(err); assert.equal(err.code, 'P0002');
  });

  await record('D3 release is refused while the set is still up', async () => {
    const id = await usableSet('FIXTURE D3');
    const a = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
      [opId('asg'), id, custA])).assignment.assignment_id;
    await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [opId('ins'), a]);
    const err = await errorOf(() => rpc(`public.release_seasonal_set($1,$2,null)`,
      [opId('rel'), a]));
    assert.ok(err); assert.equal(err.code, '23514');
    assert.match(err.message, /still up at the property/i);
  });

  await record('D4 release is refused until somebody has inspected it', async () => {
    const id = await usableSet('FIXTURE D4');
    const a = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
      [opId('asg'), id, custA])).assignment.assignment_id;
    await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [opId('ins'), a]);
    await rpc(`public.recover_seasonal_set($1,$2,'usable',null,null,null)`, [opId('rec'), a]);
    const err = await errorOf(() => rpc(`public.release_seasonal_set($1,$2,null)`,
      [opId('rel'), a]));
    assert.ok(err); assert.equal(err.code, '23514');
    assert.match(err.message, /not been inspected/i);
  });

  await record('D5 a deployed set cannot be inspected where it stands', async () => {
    const id = await usableSet('FIXTURE D5');
    const a = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
      [opId('asg'), id, custA])).assignment.assignment_id;
    await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [opId('ins'), a]);
    const err = await errorOf(() => rpc(`public.inspect_seasonal_set($1,$2,'usable',null)`,
      [opId('insp'), id]));
    assert.ok(err); assert.equal(err.code, '23514');
  });

  await record('D6 "uninspected" is not an inspection outcome', async () => {
    const id = await newSet('FIXTURE D6');
    const err = await errorOf(() => rpc(`public.inspect_seasonal_set($1,$2,'uninspected',null)`,
      [opId('insp'), id]));
    assert.ok(err); assert.equal(err.code, '22023');
  });

  await record('D7 the set and its assignment cannot disagree about being deployed', async () => {
    const id = await usableSet('FIXTURE D7');
    const a = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
      [opId('asg'), id, custA])).assignment.assignment_id;
    await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [opId('ins'), a]);
    const err = await errorOf(() => client.query(
      `update public.ns_rental_sets set status='in_storage' where id=$1`, [id]));
    assert.ok(err, 'a set with an installed assignment cannot be on the shelf');
    assert.equal(err.code, '23514');
  });

  // ============================================== E. replay safety ========
  await record('E1 every seasonal RPC is replay-safe under its own key', async () => {
    const id = await usableSet('FIXTURE E1');

    const kAsg = opId('asg');
    const a1 = await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`, [kAsg, id, custA]);
    const a2 = await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`, [kAsg, id, custA]);
    assert.equal(a1.replayed, false);
    assert.equal(a2.replayed, true);
    assert.equal(a2.assignment.assignment_id, a1.assignment.assignment_id);
    const a = a1.assignment.assignment_id;

    const kIns = opId('ins');
    assert.equal((await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [kIns, a])).replayed, false);
    assert.equal((await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [kIns, a])).replayed, true);

    const kRec = opId('rec');
    assert.equal((await rpc(`public.recover_seasonal_set($1,$2,'usable',null,null,null)`, [kRec, a])).replayed, false);
    assert.equal((await rpc(`public.recover_seasonal_set($1,$2,'usable',null,null,null)`, [kRec, a])).replayed, true);

    const kIsp = opId('insp');
    assert.equal((await rpc(`public.inspect_seasonal_set($1,$2,'usable',null)`, [kIsp, id])).replayed, false);
    assert.equal((await rpc(`public.inspect_seasonal_set($1,$2,'usable',null)`, [kIsp, id])).replayed, true);

    const kRen = opId('ren');
    assert.equal((await rpc(`public.record_set_renewal($1,$2,'not_renewed',null)`, [kRen, a])).replayed, false);
    assert.equal((await rpc(`public.record_set_renewal($1,$2,'not_renewed',null)`, [kRen, a])).replayed, true);

    const kRel = opId('rel');
    assert.equal((await rpc(`public.release_seasonal_set($1,$2,null)`, [kRel, a])).replayed, false);
    assert.equal((await rpc(`public.release_seasonal_set($1,$2,null)`, [kRel, a])).replayed, true);

    const { n } = await one(
      `select count(*)::int as n from public.ns_seasonal_assignments where set_id=$1`, [id]);
    assert.equal(n, 1, 'six replays produced no extra assignment');
    const { e } = await one(
      `select count(*)::int as e from public.ns_rental_set_events where rental_set_id=$1`, [id]);
    // One event per call that LANDED, and none for the six replays:
    // received, inspected (the bench check before it was offerable),
    // assigned, installed, recovered, inspected, not_renewed, released.
    assert.equal(e, 8, 'one event per landed call, none for a replay');
  });

  await record('E2 a key reused for a different operation is refused, not applied', async () => {
    const id = await usableSet('FIXTURE E2');
    const k = opId('shared');
    const a = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
      [k, id, custA])).assignment.assignment_id;
    const err = await errorOf(() => rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [k, a]));
    assert.ok(err); assert.equal(err.code, '23505');
    assert.match(err.message, /already used to record an? assigned/i);
    const s = await setRow(id);
    assert.equal(s.status, 'in_storage', 'the refused install changed nothing');
  });

  await record('E3 a blank operation key is refused by every entry point', async () => {
    const id = await usableSet('FIXTURE E3');
    const calls = [
      [`public.register_seasonal_set($1,'FIXTURE E3b',null,null,null,null,null,null,null)`, []],
      [`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`, [id, custA]],
      [`public.install_seasonal_set($1,'00000000-0000-0000-0000-000000000000',null,null,null)`, []],
      [`public.recover_seasonal_set($1,'00000000-0000-0000-0000-000000000000','usable',null,null,null)`, []],
      [`public.inspect_seasonal_set($1,$2,'usable',null)`, [id]],
      [`public.release_seasonal_set($1,'00000000-0000-0000-0000-000000000000',null)`, []],
      [`public.record_set_renewal($1,'00000000-0000-0000-0000-000000000000','renewed',null)`, []],
      [`public.retire_seasonal_set($1,$2,null,null,null,null)`, [id]],
      [`public.cancel_seasonal_assignment($1,'00000000-0000-0000-0000-000000000000',null)`, []]
    ];
    for (const [sql, extra] of calls) {
      const err = await errorOf(() => rpc(sql, ['   ', ...extra]));
      assert.ok(err, `${sql} accepted a blank key`);
      assert.equal(err.code, '22023', sql);
    }
  });

  // ======================================== F. partial recovery ===========
  await record('F1 recovering two of three sets leaves the third unavailable', async () => {
    const ids = [];
    for (const n of ['F1a', 'F1b', 'F1c']) ids.push(await usableSet(`FIXTURE ${n}`));
    const asg = [];
    for (const id of ids) {
      const a = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,$4,$5,null)`,
        [opId('asg'), id, custA, propA, jobA])).assignment.assignment_id;
      await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [opId('ins'), a]);
      asg.push(a);
    }
    for (const a of asg.slice(0, 2)) {
      await rpc(`public.recover_seasonal_set($1,$2,'usable','base',null,null)`, [opId('rec'), a]);
    }
    const third = await avail(ids[2]);
    assert.equal(third.active_assignment_status, 'installed');
    assert.equal(third.available_for_reuse, false,
      'an unrecovered set must not look available to the next job');
    assert.equal((await setRow(ids[2])).status, 'deployed');
    // and the two that came back are still not available either, because
    // nobody has inspected them yet.
    for (const id of ids.slice(0, 2)) {
      const v = await avail(id);
      assert.equal(v.needs_inspection, true);
      assert.equal(v.available_for_reuse, false);
    }
  });

  // ======================================== G. damage and loss ============
  await record('G1 a damaged return goes to the bench, not the shelf', async () => {
    const id = await usableSet('FIXTURE G1');
    const a = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
      [opId('asg'), id, custA])).assignment.assignment_id;
    await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [opId('ins'), a]);
    const r = await rpc(`public.recover_seasonal_set($1,$2,'damaged','base',null,'crushed by ice')`,
      [opId('rec'), a]);
    assert.equal(r.set.status, 'in_repair');
    assert.equal(r.assignment.recovery_condition, 'damaged');
    assert.equal(r.availability.at_the_repair_bench, true);
    assert.equal(r.availability.available_for_reuse, false);

    // Releasing a damaged set's assignment IS allowed -- the customer
    // relationship is over -- but the set still is not offerable.
    await rpc(`public.inspect_seasonal_set($1,$2,'damaged',null)`, [opId('insp'), id]);
    const rel = await rpc(`public.release_seasonal_set($1,$2,null)`, [opId('rel'), a]);
    assert.equal(rel.assignment.status, 'released');
    assert.equal(rel.availability.available_for_reuse, false);

    // Repaired and re-inspected, it comes back into service.
    const fixed = await rpc(`public.inspect_seasonal_set($1,$2,'usable','rebuilt')`,
      [opId('insp'), id]);
    assert.equal(fixed.set.status, 'in_storage');
    assert.equal(fixed.availability.available_for_reuse, true);
  });

  await record('G2 a set that never came back is lost, not returned', async () => {
    const id = await usableSet('FIXTURE G2');
    const a = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
      [opId('asg'), id, custA])).assignment.assignment_id;
    await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [opId('ins'), a]);
    const r = await rpc(`public.recover_seasonal_set($1,$2,'missing',null,null,'not on site')`,
      [opId('rec'), a]);
    assert.equal(r.set.status, 'lost');
    assert.equal(r.set.condition, 'missing');
    assert.equal(r.set.location_id, null, 'a missing set is not on a shelf');
    assert.equal(r.availability.out_of_service, true);
    assert.equal(r.availability.available_for_reuse, false);
    const err = await errorOf(() => rpc(
      `public.assign_seasonal_set($1,$2,$3,2027,null,null,null)`, [opId('asg'), id, custB]));
    assert.ok(err, 'a lost set must never be promised to anybody');
  });

  await record('G3 recovery is refused for an assignment that never went up', async () => {
    const id = await usableSet('FIXTURE G3');
    const a = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
      [opId('asg'), id, custA])).assignment.assignment_id;
    const err = await errorOf(() => rpc(
      `public.recover_seasonal_set($1,$2,'usable',null,null,null)`, [opId('rec'), a]));
    assert.ok(err); assert.equal(err.code, '23514');
  });

  await record('G4 an unknown recovery condition is refused', async () => {
    const id = await usableSet('FIXTURE G4');
    const a = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
      [opId('asg'), id, custA])).assignment.assignment_id;
    await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [opId('ins'), a]);
    const err = await errorOf(() => rpc(
      `public.recover_seasonal_set($1,$2,'probably fine',null,null,null)`, [opId('rec'), a]));
    assert.ok(err); assert.equal(err.code, '22023');
  });

  // ================================= H. non-renewal and reassignment ======
  await record('H1 non-renewal changes nothing physical', async () => {
    const id = await usableSet('FIXTURE H1');
    const a = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
      [opId('asg'), id, custA])).assignment.assignment_id;
    await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [opId('ins'), a]);
    const r = await rpc(`public.record_set_renewal($1,$2,'not_renewed','moving house')`,
      [opId('ren'), a]);
    assert.equal(r.assignment.renewal_state, 'not_renewed');
    assert.equal(r.assignment.status, 'installed', 'the set is still on their roof');
    assert.equal(r.set.status, 'deployed');
    assert.equal(r.assignment.removed_at, null,
      'non-renewal must not claim the set has come back');
    const err = await errorOf(() => rpc(`public.release_seasonal_set($1,$2,null)`,
      [opId('rel'), a]));
    assert.ok(err, 'and it must not become releasable while deployed');
    assert.equal(err.code, '23514');
  });

  await record('H2 a non-renewed set is recovered, inspected and reassigned, history intact',
    async () => {
      const id = await usableSet('FIXTURE H2');
      const a1 = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,$4,$5,null)`,
        [opId('asg'), id, custA, propA, jobA])).assignment.assignment_id;
      await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [opId('ins'), a1]);
      await rpc(`public.record_set_renewal($1,$2,'not_renewed',null)`, [opId('ren'), a1]);
      await rpc(`public.recover_seasonal_set($1,$2,'usable','base',null,null)`, [opId('rec'), a1]);
      await rpc(`public.inspect_seasonal_set($1,$2,'usable',null)`, [opId('insp'), id]);
      await rpc(`public.release_seasonal_set($1,$2,null)`, [opId('rel'), a1]);

      const a2 = (await rpc(`public.assign_seasonal_set($1,$2,$3,2027,null,null,null)`,
        [opId('asg'), id, custB])).assignment.assignment_id;
      assert.notEqual(a2, a1);

      const rows = await all(
        `select customer_id, season_year, status, renewal_state, recovery_condition,
                installed_at is not null as was_installed
           from public.ns_seasonal_assignments
          where set_id=$1 order by season_year`, [id]);
      assert.equal(rows.length, 2, 'the first season is still on the record');
      assert.equal(rows[0].customer_id, custA);
      assert.equal(rows[0].season_year, 2026);
      assert.equal(rows[0].status, 'released');
      assert.equal(rows[0].renewal_state, 'not_renewed');
      assert.equal(rows[0].recovery_condition, 'usable');
      assert.equal(rows[0].was_installed, true);
      assert.equal(rows[1].customer_id, custB);
      assert.equal(rows[1].season_year, 2027);
    });

  await record('H3 ending a contract cannot delete the set or its history', async () => {
    const id = await usableSet('FIXTURE H3');
    const a = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
      [opId('asg'), id, custA])).assignment.assignment_id;
    await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [opId('ins'), a]);
    await rpc(`public.recover_seasonal_set($1,$2,'usable','base',null,null)`, [opId('rec'), a]);
    await rpc(`public.inspect_seasonal_set($1,$2,'usable',null)`, [opId('insp'), id]);
    await rpc(`public.release_seasonal_set($1,$2,null)`, [opId('rel'), a]);

    // The database itself refuses to lose the trail: a customer with an
    // assignment cannot be deleted out from under it.
    const err = await errorOf(() => client.query(
      `delete from public.customers where id=$1`, [custA]));
    assert.ok(err); assert.equal(err.code, '23503');
    const { n } = await one(
      `select count(*)::int as n from public.ns_seasonal_assignments where id=$1`, [a]);
    assert.equal(n, 1);
  });

  await record('H4 a released assignment is still a full record of that season', async () => {
    const id = await usableSet('FIXTURE H4');
    const a = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,$4,$5,null)`,
      [opId('asg'), id, custA, propA, jobA])).assignment.assignment_id;
    await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [opId('ins'), a]);
    await rpc(`public.recover_seasonal_set($1,$2,'usable','base',null,null)`, [opId('rec'), a]);
    const before = await one(
      `select customer_id,property_id,job_id,season_year,installed_at,removed_at,
              recovery_condition from public.ns_seasonal_assignments where id=$1`, [a]);
    await rpc(`public.inspect_seasonal_set($1,$2,'usable',null)`, [opId('insp'), id]);
    await rpc(`public.release_seasonal_set($1,$2,null)`, [opId('rel'), a]);
    const after = await one(
      `select customer_id,property_id,job_id,season_year,installed_at,removed_at,
              recovery_condition from public.ns_seasonal_assignments where id=$1`, [a]);
    assert.deepEqual(after, before, 'release must rewrite nothing but the status');
  });

  // ======================================= I. the accounting model ========
  await record('I1 building a set moves its material out of the ledger, exactly once',
    async () => {
      const mat = await newMaterial('FIXTURE accounting bulb');
      await rpc(`public.post_stock_movement($1,$2,'base',1000,'received',null,null,null,null,'usable','exact')`,
        [opId('mv'), mat]);

      const onHand = async () => Number((await one(
        `select coalesce(on_hand,0) as on_hand from public.ns_material_stock_by_location
          where material_id=$1 and location_code='base'`, [mat])).on_hand);
      /** What the sets are holding: the build movement of every set that has
       *  not been stripped back. This is the other side of the ledger. */
      const heldInSets = async () => Number((await one(
        `select coalesce(sum(abs(mv.delta)),0) as held
           from public.ns_rental_sets s
           join public.ns_material_stock_moves mv on mv.operation_id = s.built_from_operation
          where s.stripped_to_operation is null and mv.material_id = $1`, [mat])).held);

      assert.equal(await onHand(), 1000);
      assert.equal(await heldInSets(), 0);

      const id = await newSet('FIXTURE I1', { material_id: mat, build_quantity: 200 });
      assert.equal(await onHand(), 800, 'the 200 left generic stock');
      assert.equal(await heldInSets(), 200, 'and is now held by the set');
      assert.equal(await onHand() + await heldInSets(), 1000, 'nothing created, nothing lost');
      assert.ok((await setRow(id)).built_from_operation, 'and the crossing is recorded');

      // A season does NOT touch the ledger. This is the claim the batch
      // turns on: a set out at a customer's house was never in the ledger,
      // so assigning, installing and recovering it move no stock at all.
      const moves = async () => Number((await one(
        `select count(*)::int as n from public.ns_material_stock_moves where material_id=$1`,
        [mat])).n);
      const before = await moves();
      await rpc(`public.inspect_seasonal_set($1,$2,'usable',null)`, [opId('insp'), id]);
      const a = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
        [opId('asg'), id, custA])).assignment.assignment_id;
      await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [opId('ins'), a]);
      await rpc(`public.recover_seasonal_set($1,$2,'usable','base',null,null)`, [opId('rec'), a]);
      await rpc(`public.inspect_seasonal_set($1,$2,'usable',null)`, [opId('insp'), id]);
      await rpc(`public.release_seasonal_set($1,$2,null)`, [opId('rel'), a]);
      assert.equal(await moves(), before, 'a whole season posted no stock movement');
      assert.equal(await onHand(), 800);
      assert.equal(await heldInSets(), 200);

      // Stripping it sends the quantity back, once.
      await rpc(`public.retire_seasonal_set($1,$2,$3,200,'base','end of life')`,
        [opId('ret'), id, mat]);
      assert.equal(await onHand(), 1000, 'the salvage is generic stock again');
      assert.equal(await heldInSets(), 0, 'and the set holds nothing');
      assert.equal(await onHand() + await heldInSets(), 1000);
      const s = await setRow(id);
      assert.equal(s.status, 'retired');
      assert.ok(s.retired_at);
      assert.ok(s.stripped_to_operation);
    });

  await record('I2 a replayed registration does not consume the material twice', async () => {
    const mat = await newMaterial('FIXTURE replay bulb');
    await rpc(`public.post_stock_movement($1,$2,'base',500,'received',null,null,null,null,'usable','exact')`,
      [opId('mv'), mat]);
    const k = opId('reg');
    const call = () => rpc(
      `public.register_seasonal_set($1,'FIXTURE I2','roofline','warm',40,'base',$2,100,null)`,
      [k, mat]);
    const first = await call();
    const again = await call();
    assert.equal(first.replayed, false);
    assert.equal(again.replayed, true);
    assert.equal(again.set.set_id, first.set.set_id);
    const { on_hand } = await one(
      `select on_hand from public.ns_material_stock_by_location
        where material_id=$1 and location_code='base'`, [mat]);
    assert.equal(Number(on_hand), 400, 'the build was posted once, not twice');
  });

  await record('I3 a replayed retirement does not return the salvage twice', async () => {
    const mat = await newMaterial('FIXTURE strip bulb');
    await rpc(`public.post_stock_movement($1,$2,'base',500,'received',null,null,null,null,'usable','exact')`,
      [opId('mv'), mat]);
    const id = await newSet('FIXTURE I3', { material_id: mat, build_quantity: 100 });
    const k = opId('ret');
    await rpc(`public.retire_seasonal_set($1,$2,$3,100,'base',null)`, [k, id, mat]);
    const again = await rpc(`public.retire_seasonal_set($1,$2,$3,100,'base',null)`, [k, id, mat]);
    assert.equal(again.replayed, true);
    const { on_hand } = await one(
      `select on_hand from public.ns_material_stock_by_location
        where material_id=$1 and location_code='base'`, [mat]);
    assert.equal(Number(on_hand), 500, '400 after the build, +100 returned once');
  });

  await record('I4 a build without a material, or a nonsense quantity, is refused', async () => {
    let err = await errorOf(() => rpc(
      `public.register_seasonal_set($1,'FIXTURE I4a',null,null,null,'base',null,50,null)`,
      [opId('reg')]));
    assert.ok(err); assert.equal(err.code, '22023');
    const mat = await newMaterial('FIXTURE I4 bulb');
    err = await errorOf(() => rpc(
      `public.register_seasonal_set($1,'FIXTURE I4b',null,null,null,'base',$2,0,null)`,
      [opId('reg'), mat]));
    assert.ok(err); assert.equal(err.code, '22023');
  });

  await record('I5 a set still promised to a customer cannot be retired', async () => {
    const id = await usableSet('FIXTURE I5');
    const a = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
      [opId('asg'), id, custA])).assignment.assignment_id;
    await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [opId('ins'), a]);
    const err = await errorOf(() => rpc(`public.retire_seasonal_set($1,$2,null,null,null,null)`,
      [opId('ret'), id]));
    assert.ok(err); assert.equal(err.code, '23514');
  });

  // ============================================ J. owner and crew =========
  await record('J1 an unauthorised caller gets nowhere', async () => {
    const id = await usableSet('FIXTURE J1');
    await client.query(`select set_config('nova.is_admin','off',false)`);
    try {
      for (const [sql, extra] of [
        [`public.register_seasonal_set($1,'FIXTURE J1x',null,null,null,null,null,null,null)`, []],
        [`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`, [id, custA]],
        [`public.install_seasonal_set($1,'00000000-0000-0000-0000-000000000000',null,null,null)`, []],
        [`public.recover_seasonal_set($1,'00000000-0000-0000-0000-000000000000','usable',null,null,null)`, []],
        [`public.inspect_seasonal_set($1,$2,'usable',null)`, [id]],
        [`public.release_seasonal_set($1,'00000000-0000-0000-0000-000000000000',null)`, []],
        [`public.record_set_renewal($1,'00000000-0000-0000-0000-000000000000','renewed',null)`, []],
        [`public.retire_seasonal_set($1,$2,null,null,null,null)`, [id]],
        [`public.cancel_seasonal_assignment($1,'00000000-0000-0000-0000-000000000000',null)`, []]
      ]) {
        const err = await errorOf(() => rpc(sql, [opId('anon'), ...extra]));
        assert.ok(err, `${sql} let a non-admin in`);
        assert.equal(err.code, '42501', sql);
      }
    } finally {
      await client.query(`select set_config('nova.is_admin','on',false)`);
    }
  });

  await record('J2 a crew does the field work but makes no commercial decisions', async () => {
    const id = await usableSet('FIXTURE J2');
    const a = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
      [opId('asg'), id, custA])).assignment.assignment_id;

    await client.query(
      `insert into public.ns_crew_members (user_id,role,vehicle_location_id,display_name)
       values ($1,'crew',(select id from public.ns_stock_locations where code='car_a'),'FIXTURE crew')
       on conflict (user_id) do update set role='crew', active=true,
         vehicle_location_id=(select id from public.ns_stock_locations where code='car_a')`,
      [crewId]);
    await beCrew();
    try {
      assert.equal((await one('select public.is_owner() as o')).o, false);

      // Field work: allowed.
      await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [opId('ins'), a]);
      await rpc(`public.recover_seasonal_set($1,$2,'usable','car_a',null,null)`, [opId('rec'), a]);
      await rpc(`public.inspect_seasonal_set($1,$2,'usable',null)`, [opId('insp'), id]);

      // Commercial decisions: refused, in the backend, not the screen.
      for (const [sql, extra] of [
        [`public.release_seasonal_set($1,$2,null)`, [a]],
        [`public.record_set_renewal($1,$2,'renewed',null)`, [a]],
        [`public.cancel_seasonal_assignment($1,$2,null)`, [a]],
        [`public.retire_seasonal_set($1,$2,null,null,null,null)`, [id]],
        [`public.register_seasonal_set($1,'FIXTURE J2x',null,null,null,null,null,null,null)`, []]
      ]) {
        const err = await errorOf(() => rpc(sql, [opId('crew'), ...extra]));
        assert.ok(err, `${sql} let a crew make an owner's decision`);
        assert.equal(err.code, '42501', sql);
      }
      const err = await errorOf(() => rpc(
        `public.assign_seasonal_set($1,$2,$3,2027,null,null,null)`, [opId('crew'), id, custB]));
      assert.ok(err); assert.equal(err.code, '42501');
    } finally {
      await beOwner();
    }
  });

  await record('J3 a crew cannot touch a set sitting in the other car', async () => {
    const id = await usableSet('FIXTURE J3');
    await client.query(`update public.ns_rental_sets set location_id=$1 where id=$2`, [carB, id]);
    await beCrew();
    try {
      assert.equal((await one('select public.can_handle_set($1) as c', [id])).c, false);
      const err = await errorOf(() => rpc(`public.inspect_seasonal_set($1,$2,'usable',null)`,
        [opId('crew'), id]));
      assert.ok(err); assert.equal(err.code, '42501');
    } finally {
      await beOwner();
    }
  });

  await record('J4 a crew cannot recover a set into a car that is not theirs', async () => {
    const id = await usableSet('FIXTURE J4');
    const a = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
      [opId('asg'), id, custA])).assignment.assignment_id;
    await beCrew();
    try {
      await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [opId('crew'), a]);
      const err = await errorOf(() => rpc(
        `public.recover_seasonal_set($1,$2,'usable','car_b',null,null)`, [opId('crew'), a]));
      assert.ok(err); assert.equal(err.code, '42501');
      // Their own car is fine, and that is where the set ends up.
      const r = await rpc(`public.recover_seasonal_set($1,$2,'usable','car_a',null,null)`,
        [opId('crew'), a]);
      assert.equal(r.set.location_code, 'car_a');
    } finally {
      await beOwner();
    }
  });

  await record('J5 the owner is whoever has no crew row, which is today\'s business',
    async () => {
      await beOwner();
      assert.equal((await one('select public.is_owner() as o')).o, true);
      assert.equal((await one('select public.current_crew_vehicle() as v')).v, null);
    });

  // ====================================== K. privileges and the log =======
  await record('K1 anon holds no execute on any seasonal RPC, through all three routes',
    async () => {
      for (const f of [
        'public.register_seasonal_set(text,text,text,text,numeric,text,uuid,numeric,text)',
        'public.assign_seasonal_set(text,uuid,uuid,integer,uuid,uuid,text)',
        'public.cancel_seasonal_assignment(text,uuid,text)',
        'public.install_seasonal_set(text,uuid,timestamptz,uuid,text)',
        'public.recover_seasonal_set(text,uuid,text,text,timestamptz,text)',
        'public.inspect_seasonal_set(text,uuid,text,text)',
        'public.release_seasonal_set(text,uuid,text)',
        'public.record_set_renewal(text,uuid,text,text)',
        'public.retire_seasonal_set(text,uuid,uuid,numeric,text,text)'
      ]) {
        const { ok } = await one(
          `select has_function_privilege('anon',$1,'execute') as ok`, [f]);
        assert.equal(ok, false, `anon can execute ${f}`);
        const { yes } = await one(
          `select has_function_privilege('authenticated',$1,'execute') as yes`, [f]);
        assert.equal(yes, true, `authenticated cannot execute ${f}`);
      }
    });

  await record('K2 authenticated cannot write assignments by hand', async () => {
    for (const p of ['INSERT', 'UPDATE', 'DELETE']) {
      const { ok } = await one(
        `select has_table_privilege('authenticated','public.ns_seasonal_assignments',$1) as ok`, [p]);
      assert.equal(ok, false, `authenticated holds ${p} on ns_seasonal_assignments`);
    }
    const { sel } = await one(
      `select has_table_privilege('authenticated','public.ns_seasonal_assignments','SELECT') as sel`);
    assert.equal(sel, true, 'but it must be able to read them');
  });

  await record('K3 the lifecycle log is append-only, because it is also the replay ledger',
    async () => {
      for (const p of ['UPDATE', 'DELETE']) {
        const { ok } = await one(
          `select has_table_privilege('authenticated','public.ns_rental_set_events',$1) as ok`, [p]);
        assert.equal(ok, false, `authenticated holds ${p} on ns_rental_set_events`);
      }
    });

  await record('K4 anon is shut out of the assignment table and the availability view',
    async () => {
      for (const obj of ['public.ns_seasonal_assignments', 'public.ns_rental_sets',
                         'public.ns_seasonal_set_availability']) {
        for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          const { ok } = await one(`select has_table_privilege('anon',$1,$2) as ok`, [obj, p]);
          assert.equal(ok, false, `anon holds ${p} on ${obj}`);
        }
      }
    });

  await record('K5 RLS is enabled on the assignment table, and policies exist', async () => {
    const { enabled } = await one(
      `select relrowsecurity as enabled from pg_class
        where oid = 'public.ns_seasonal_assignments'::regclass`);
    assert.equal(enabled, true);
    const names = (await all(
      `select polname from pg_policy
        where polrelid in ('public.ns_seasonal_assignments'::regclass,
                           'public.ns_rental_sets'::regclass)`)).map(r => r.polname);
    assert.ok(names.includes('seasonal_assignments_read'));
    assert.ok(names.includes('rental_sets_scoped_read'));
    assert.ok(names.includes('rental_sets_owner_writes'));
    assert.ok(!names.includes('admin_all'),
      'the blanket 8.1 policy on sets is replaced by the scoped one');
  });

  await record('K6 the availability view runs as the caller, not as its owner', async () => {
    const { opts } = await one(
      `select reloptions::text as opts from pg_class
        where oid='public.ns_seasonal_set_availability'::regclass`);
    assert.match(opts || '', /security_invoker=(on|true)/);
  });

  // ============================================== L. the cutoff ===========
  await record('L1 with no cutoff set, no date is invented', async () => {
    const { d } = await one(`select public.ns_seasonal_release_cutoff(2026) as d`);
    assert.equal(d, null);
  });

  await record('L2 an owner-set cutoff is reported against the season year', async () => {
    await client.query(
      `update public.app_settings
          set value = value || jsonb_build_object('seasonal_release_cutoff','01-15')
        where key='lighting'`);
    const { d } = await one(`select public.ns_seasonal_release_cutoff(2026)::text as d`);
    assert.equal(d, '2026-01-15');
    const r = await one(
      `select public.ns_seasonal_release_cutoff(null) as d`);
    assert.equal(r.d, null, 'and a null season has no cutoff');
  });

  await record('L3 a malformed cutoff reads as unset rather than taking the screen down',
    async () => {
      await client.query(
        `update public.app_settings
            set value = value || jsonb_build_object('seasonal_release_cutoff','not a date')
          where key='lighting'`);
      const { d } = await one(`select public.ns_seasonal_release_cutoff(2026) as d`);
      assert.equal(d, null);
      await client.query(
        `update public.app_settings set value = value - 'seasonal_release_cutoff'
          where key='lighting'`);
    });

  await record('L4 nothing releases a set on a schedule -- release is always a human act',
    async () => {
      // There is no trigger, no cron and no default that flips an
      // assignment to released. Proven by the absence of any other writer:
      // the only statement in the schema that sets released_at is inside
      // release_seasonal_set.
      const { n } = await one(
        `select count(*)::int as n from pg_proc p
          join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = 'public'
           and p.prosrc like '%released_at%'
           and p.proname <> 'release_seasonal_set'
           and p.prosrc like '%update public.ns_seasonal_assignments%'`);
      assert.equal(n, 0, 'only release_seasonal_set may set released_at');
    });

  /* ================== M. the Batch 9.1 corrective ======================
     One case per finding in docs/reviews/seasonal-contract-abedf0f.md.
     Every one of these fails against the uncorrected 9.1 migrations; that
     is the point of writing them. */

  await record('M1 (finding 4) a set cannot be retired while its season is unreleased',
    async () => {
      const id = await usableSet('FIXTURE M1');
      const a = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
        [opId('asg'), id, custA])).assignment.assignment_id;
      await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [opId('ins'), a]);
      await rpc(`public.recover_seasonal_set($1,$2,'usable','base',null,null)`,
        [opId('rec'), a]);

      // Recovered but not released: the assignment is still OPEN, and the
      // RPC's own message has always said "recover and release".
      const err = await errorOf(() => rpc(
        `public.retire_seasonal_set($1,$2,null,null,null,null)`, [opId('ret'), id]));
      assert.ok(err, 'retiring here leaves a promise open against a gone asset');
      assert.equal(err.code, '23514');
      assert.match(err.message, /release it before/i);

      await rpc(`public.inspect_seasonal_set($1,$2,'usable',null)`, [opId('insp'), id]);
      await rpc(`public.release_seasonal_set($1,$2,null)`, [opId('rel'), a]);
      const ok = await rpc(`public.retire_seasonal_set($1,$2,null,null,null,null)`,
        [opId('ret'), id]);
      assert.equal(ok.set.status, 'retired');
    });

  await record('M2 (finding 2) a set bought assembled has no debit to reverse',
    async () => {
      const id = await usableSet('FIXTURE M2');          // no build quantity
      const mat = await newMaterial('FIXTURE M2 part');
      const err = await errorOf(() => rpc(
        `public.retire_seasonal_set($1,$2,$3,10,'base',null)`, [opId('ret'), id, mat]));
      assert.ok(err, 'otherwise a positive receipt appears from nowhere');
      assert.equal(err.code, '23514');
      assert.match(err.message, /no debit to reverse/i);
    });

  await record('M3 (finding 2) a strip cannot exceed the build or change material',
    async () => {
      const mat = await newMaterial('FIXTURE M3 bulb');
      await rpc(`public.post_stock_movement($1,$2,'base',500,'received',null,null,null,null,'usable','exact')`,
        [opId('mv'), mat]);
      const id = await newSet('FIXTURE M3', { material_id: mat, build_quantity: 200 });

      let err = await errorOf(() => rpc(
        `public.retire_seasonal_set($1,$2,$3,250,'base',null)`, [opId('ret'), id, mat]));
      assert.ok(err, '250 out of a 200 build creates 50 from nothing');
      assert.equal(err.code, '23514');

      const other = await newMaterial('FIXTURE M3 other');
      err = await errorOf(() => rpc(
        `public.retire_seasonal_set($1,$2,$3,100,'base',null)`, [opId('ret'), id, other]));
      assert.ok(err, 'salvage returns what was taken out');
      assert.equal(err.code, '22023');
    });

  await record('M4 (finding 2) a partial strip records the scrap, and the invariant holds',
    async () => {
      const mat = await newMaterial('FIXTURE M4 bulb');
      await rpc(`public.post_stock_movement($1,$2,'base',1000,'received',null,null,null,null,'usable','exact')`,
        [opId('mv'), mat]);
      const onHand = async () => Number((await one(
        `select coalesce(on_hand,0) as n from public.ns_material_stock_by_location
          where material_id=$1 and location_code='base'`, [mat])).n);
      /* The corrected expression from the contract: stock, plus what sets
         still hold, plus the scrap a partial strip left behind. */
      const held = async () => Number((await one(
        `select coalesce(sum(
                  case when s.stripped_quantity is null then s.built_quantity
                       else 0 end), 0) as n
           from public.ns_rental_sets s where s.material_id = $1`, [mat])).n);
      const scrap = async () => Number((await one(
        `select coalesce(sum(s.built_quantity - s.stripped_quantity), 0) as n
           from public.ns_rental_sets s
          where s.material_id = $1 and s.stripped_quantity is not null`, [mat])).n);

      const id = await newSet('FIXTURE M4', { material_id: mat, build_quantity: 200 });
      assert.equal(await onHand(), 800);
      assert.equal(await held(), 200);
      assert.equal(await onHand() + await held() + await scrap(), 1000);

      await rpc(`public.retire_seasonal_set($1,$2,$3,150,'base','half of it was cracked')`,
        [opId('ret'), id, mat]);
      const s = await setRow(id);
      assert.equal(Number(s.built_quantity), 200);
      assert.equal(Number(s.stripped_quantity), 150);
      assert.equal(await onHand(), 950, 'only what was worth saving came back');
      assert.equal(await held(), 0);
      assert.equal(await scrap(), 50, 'and the 50 that did not is named as scrap');
      assert.equal(await onHand() + await held() + await scrap(), 1000);
    });

  await record('M5 (finding 3) a key reused for an unrelated movement is caught',
    async () => {
      const mat = await newMaterial('FIXTURE M5 bulb');
      await rpc(`public.post_stock_movement($1,$2,'base',500,'received',null,null,null,null,'usable','exact')`,
        [opId('mv'), mat]);
      const key = opId('reg');

      // Somebody posts an ordinary movement under the suffix this call will
      // derive. post_stock_movement replays it without comparing the
      // payload, so without the provenance check the set would attach to an
      // operation that consumed nothing.
      await rpc(`public.post_stock_movement($1,$2,'base',1,'received',null,null,null,null,'usable','exact')`,
        [key + ':build', mat]);

      const err = await errorOf(() => rpc(
        `public.register_seasonal_set($1,'FIXTURE M5','roofline','warm',40,'base',$2,200,null)`,
        [key, mat]));
      assert.ok(err, 'the set must not attach to a debit that never happened');
      assert.equal(err.code, '23505');
      assert.match(err.message, /not its own/i);
      const after = Number((await one(
        `select coalesce(on_hand,0) as n from public.ns_material_stock_by_location
          where material_id=$1 and location_code='base'`, [mat])).n);
      assert.equal(after, 501, 'and nothing was consumed');
    });

  await record('M6 (finding 1) a crew cannot replay a key for the other car\'s set',
    async () => {
      const id = await usableSet('FIXTURE M6');
      const a = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
        [opId('asg'), id, custA])).assignment.assignment_id;
      const key = opId('ins');
      await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [key, a]);
      // Recovered into Car B, where this crew does not work.
      await rpc(`public.recover_seasonal_set($1,$2,'usable','car_b',null,null)`,
        [opId('rec'), a]);

      await client.query(
        `insert into public.ns_crew_members (user_id,role,vehicle_location_id,display_name)
         values ($1,'crew',(select id from public.ns_stock_locations where code='car_a'),'FIXTURE crew')
         on conflict (user_id) do update set role='crew', active=true,
           vehicle_location_id=(select id from public.ns_stock_locations where code='car_a')`,
        [crewId]);
      await beCrew();
      try {
        const err = await errorOf(() => rpc(
          `public.install_seasonal_set($1,$2,null,null,null)`, [key, a]));
        assert.ok(err, 'the replay path must be scoped like every other path');
        assert.equal(err.code, '42501');
      } finally {
        await beOwner();
      }
    });

  await record('M7 (finding 7) a key belongs to the thing it was first used on',
    async () => {
      const one1 = await usableSet('FIXTURE M7a');
      const two = await usableSet('FIXTURE M7b');
      const a1 = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
        [opId('asg'), one1, custA])).assignment.assignment_id;
      const a2 = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
        [opId('asg'), two, custB])).assignment.assignment_id;

      const key = opId('ins');
      await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [key, a1]);
      const err = await errorOf(() => rpc(
        `public.install_seasonal_set($1,$2,null,null,null)`, [key, a2]));
      assert.ok(err, 'same kind, different target: that is a new request, not a retry');
      assert.equal(err.code, '23505');
      assert.match(err.message, /different assignment/i);
      const t = await setRow(two);
      assert.notEqual(t.status, 'deployed', 'and the second set was not installed');
    });

  await record('M8 (finding 7) a state no-op is distinguishable from a key replay',
    async () => {
      const id = await usableSet('FIXTURE M8');
      const a = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
        [opId('asg'), id, custA])).assignment.assignment_id;
      const key = opId('ins');
      const first = await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [key, a]);
      assert.equal(first.replayed, false);
      assert.equal(first.no_op, false);

      const sameKey = await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [key, a]);
      assert.equal(sameKey.replayed, true);
      assert.equal(sameKey.no_op, false, 'this is the recorded original coming back');

      const freshKey = await rpc(`public.install_seasonal_set($1,$2,null,null,null)`,
        [opId('ins'), a]);
      assert.equal(freshKey.replayed, true);
      assert.equal(freshKey.no_op, true, 'nothing needed doing, and no key was recorded');
    });

  await record('M9 (finding 6) availability flags are never null, and reasons can overlap',
    async () => {
      const free = await usableSet('FIXTURE M9 free');
      const v = await avail(free);
      for (const f of ['has_active_assignment', 'awaiting_release', 'needs_inspection',
                       'needs_repair_or_search', 'out_of_service',
                       'at_the_repair_bench', 'available_for_reuse']) {
        assert.notEqual(v[f], null, `${f} must never be null`);
      }
      assert.equal(v.awaiting_release, false, 'no assignment is false, not null');
      assert.deepEqual(v.blocking_reasons, [], 'and nothing blocks it');

      // A damaged set, recovered but not released, sitting at the bench:
      // three reasons at once. The contract used to claim exactly one.
      const busy = await usableSet('FIXTURE M9 busy');
      const a = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
        [opId('asg'), busy, custA])).assignment.assignment_id;
      await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [opId('ins'), a]);
      await rpc(`public.recover_seasonal_set($1,$2,'damaged','base',null,null)`,
        [opId('rec'), a]);
      await rpc(`public.inspect_seasonal_set($1,$2,'damaged',null)`, [opId('insp'), busy]);

      const w = await avail(busy);
      assert.equal(w.awaiting_release, true);
      assert.equal(w.at_the_repair_bench, true);
      assert.equal(w.needs_repair_or_search, true);
      assert.ok(w.blocking_reasons.length >= 3,
        'the response lists every reason that applies, not one');
      assert.equal(w.blocking_reasons[0], 'awaiting_release',
        'most decisive first, so a caller can show the top one');

      // The list is what the screen renders as the WHOLE explanation, so it
      // has to be empty exactly when the set is free -- over every row, not
      // over the two above.
      const drift = await one(`
        select count(*)::int as n
          from public.ns_seasonal_set_availability
         where available_for_reuse <> (coalesce(cardinality(blocking_reasons), 0) = 0)`);
      assert.equal(drift.n, 0,
        'blocking_reasons is empty if and only if the set is available');

      // 'deployed' has no reason of its own, and the correspondence above
      // holds only because this trigger rules out 'deployed' with nothing
      // installed. Asserted here so that relaxing the trigger fails this
      // check rather than quietly leaving a set unavailable for no stated
      // reason. A direct write is the point: no RPC can reach the state.
      const orphan = await errorOf(() => client.query(
        `update public.ns_rental_sets set status='deployed' where id=$1`, [free]));
      assert.ok(orphan, 'deployed with nothing installed must be impossible');
      assert.equal(orphan.code, '23514');
      assert.match(orphan.message, /nothing is installed/i);
    });

  // ============== N. the three review tails, closed in Batch 11.1 ========
  //
  // 20261013090000. One test per sub-point the first corrective left open.

  await record('N1 (finding 1b) a crew cannot read an operation key off the log',
    async () => {
      // Column-level, so the history stays readable and only the credential-
      // shaped column goes. A table-level grant would have swallowed a
      // column-level revoke, which is the mistake this asserts against.
      assert.equal(
        (await one(`select has_column_privilege('authenticated',
                      'public.ns_rental_set_events','client_operation_id','select') as p`)).p,
        false, 'the key is not crew-readable');
      assert.equal(
        (await one(`select has_column_privilege('authenticated',
                      'public.ns_rental_set_events','event','select') as p`)).p,
        true, 'the rest of the log still is');

      // The owner's audit route works and refuses a crew.
      const id = await newSet('FIXTURE N1');
      const ev = await one(
        `select id from public.ns_rental_set_events
          where rental_set_id=$1 and event='received'`, [id]);
      const key = await one(
        `select public.ns_rental_set_operation_key($1) as k`, [ev.id]);
      assert.ok(key.k && key.k.length > 0, 'the owner can still audit a replay');

      await beCrew();
      const err = await errorOf(() => client.query(
        `select public.ns_rental_set_operation_key($1)`, [ev.id]));
      await beOwner();
      assert.ok(err, 'a crew has no business reading keys');
      assert.equal(err.code, '42501');
    });

  await record('N2 (finding 2b) a build records where the stock came off',
    async () => {
      const mat = await newMaterial('FIXTURE N2 bulb');
      await rpc(`public.post_stock_movement($1,$2,'base',500,'received',null,null,null,null,'usable','exact')`,
        [opId('mv'), mat]);
      const id = await newSet('FIXTURE N2', { material_id: mat, build_quantity: 100 });
      const s = await setRow(id);
      assert.ok(s.built_at_location, 'a build without a place cannot be reversed');
      const base = await one(`select id from public.ns_stock_locations where kind='base' and active`);
      assert.equal(s.built_at_location, base.id);

      // The pairing is a constraint, not a convention.
      const err = await errorOf(() => client.query(
        `update public.ns_rental_sets set built_at_location=null where id=$1`, [id]));
      assert.ok(err, 'a quantity with no location is not a traceable build');
      assert.equal(err.code, '23514');
    });

  await record('N3 (finding 2b) salvage goes back where it came from',
    async () => {
      const mat = await newMaterial('FIXTURE N3 bulb');
      // Stock at BOTH places, so the wrong destination is available rather
      // than merely absent -- otherwise this would pass for the wrong reason.
      await rpc(`public.post_stock_movement($1,$2,'base',500,'received',null,null,null,null,'usable','exact')`,
        [opId('mv'), mat]);
      await rpc(`public.post_stock_movement($1,$2,'car_a',500,'received',null,null,null,null,'usable','exact')`,
        [opId('mv'), mat]);
      const id = await newSet('FIXTURE N3',
        { material_id: mat, build_quantity: 200, location_code: 'car_a' });

      const err = await errorOf(() => rpc(
        `public.retire_seasonal_set($1,$2,$3,200,'base',null)`, [opId('ret'), id, mat]));
      assert.ok(err, '200 off Car A coming back at Base is wrong on both shelves');
      assert.equal(err.code, '22023');
      assert.match(err.message, /same place/i);

      const onHand = async (code) => Number((await one(
        `select coalesce(on_hand,0) as n from public.ns_material_stock_by_location
          where material_id=$1 and location_code=$2`, [mat, code])).n);
      assert.equal(await onHand('car_a'), 300, 'the build came off Car A');

      // No destination at all defaults to the build's own location, so the
      // ordinary call needs no argument.
      await rpc(`public.retire_seasonal_set($1,$2,null,200,null,null)`, [opId('ret'), id]);
      assert.equal(await onHand('car_a'), 500, 'and the salvage went back there');
      assert.equal(await onHand('base'), 500, 'Base never moved');
    });

  await record('N4 (finding 5b) a set can be put in a car, and that is not a promise',
    async () => {
      const id = await usableSet('FIXTURE N4');
      const aboard = (sid) => one(
        'select * from public.ns_seasonal_sets_aboard where set_id=$1', [sid]);

      let v = await aboard(id);
      assert.equal(v.aboard_state, 'at_base');
      assert.equal(v.promised_to_a_customer, false);

      await rpc(`public.move_seasonal_set($1,$2,'car_a',$3)`,
        [opId('mv'), id, 'loading for tomorrow']);
      v = await aboard(id);
      assert.equal(v.aboard_state, 'aboard_vehicle');
      assert.equal(v.location_code, 'car_a');
      assert.equal(v.promised_to_a_customer, false,
        'aboard is not promised -- that is the whole distinction');

      // Promised and aboard are independent, both directions.
      const a = (await rpc(`public.assign_seasonal_set($1,$2,$3,2026,null,null,null)`,
        [opId('asg'), id, custA])).assignment.assignment_id;
      v = await aboard(id);
      assert.equal(v.aboard_state, 'aboard_vehicle', 'assigning moved nothing');
      assert.equal(v.promised_to_a_customer, true);

      await rpc(`public.install_seasonal_set($1,$2,null,null,null)`, [opId('ins'), a]);
      v = await aboard(id);
      assert.equal(v.aboard_state, 'at_a_property', 'and now it is up');

      // Relocating a deployed set is recovery, which asks what came back.
      const err = await errorOf(() => rpc(
        `public.move_seasonal_set($1,$2,'base',null)`, [opId('mv'), id]));
      assert.ok(err, 'a set at a property is not relocated, it is recovered');
      assert.equal(err.code, '23514');
      assert.match(err.message, /Recover it/i);
    });

  await record('N5 (finding 5b) a move is scoped, replay-safe and no-op aware',
    async () => {
      const id = await usableSet('FIXTURE N5');

      // A no-op says so and records no key.
      const first = await rpc(`public.move_seasonal_set($1,$2,'base',null)`,
        [opId('mv'), id]);
      assert.equal(first.replayed, true);
      assert.equal(first.no_op, true, 'it was already at Base');

      const key = opId('mv');
      const moved = await rpc(`public.move_seasonal_set($1,$2,'car_a',null)`, [key, id]);
      assert.equal(moved.replayed, false);
      const again = await rpc(`public.move_seasonal_set($1,$2,'car_a',null)`, [key, id]);
      assert.equal(again.replayed, true);
      assert.equal(again.no_op, false, 'this is the recorded original coming back');

      // A crew cannot send a set to a location it cannot see. Car B exists
      // in this fixture and no crew member is assigned to it.
      await beCrew();
      const err = await errorOf(() => rpc(
        `public.move_seasonal_set($1,$2,'car_b',null)`, [opId('mv'), id]));
      await beOwner();
      assert.ok(err, 'the destination is scoped like a transfer destination');
      assert.equal(err.code, '42501');

      assert.ok(carB, 'Car B is a fixture of this suite, never seeded data');
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
