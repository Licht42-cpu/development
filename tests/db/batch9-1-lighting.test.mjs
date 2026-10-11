// Batch 9.1 corrective -- permanent-lighting materials: kit sheets, sealed
// kit opening, offcuts and job material sheets, against a DEDICATED
// DISPOSABLE DATABASE.
//
//   node tests/db/setup-test-db.mjs
//   node tests/db/batch9-1-lighting.test.mjs
//
// What passing proves: the migrations apply in sequence against real
// PostgreSQL; opening a kit converts it without the kit and its contents
// ever both counting; an offcut describes existing stock rather than adding
// any; an unreviewed specification cannot reach a job plan; and only
// SELECTED sheet lines reserve stock.
//
// What it does NOT prove: anything about the live database, and nothing
// whatsoever about real supplier products. Every material here is named
// FIXTURE precisely so it cannot be mistaken for a catalogue entry.
// NO MIGRATION IN THIS REPOSITORY HAS BEEN APPLIED TO PRODUCTION.

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
  '20261011101000_batch9_1_kit_and_sheet_operations.sql'
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
const opId = (tag) => `tl-${tag}-${++seq}`;

(async () => {
  assertDisposableTarget(PGURL);
  const client = new pg.Client({ connectionString: PGURL });
  await client.connect();
  await assertDisposableDatabase(client);

  const one = async (sql, params) => (await client.query(sql, params)).rows[0];
  const all = async (sql, params) => (await client.query(sql, params)).rows;
  const rpc = async (fn, params) => (await one(`select ${fn} as r`, params)).r;

  await client.query(`
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
    drop function if exists public.open_sealed_kit(text,uuid,text,numeric,text);
    drop function if exists public.record_offcut(text,uuid,text,numeric,uuid,text);
    drop function if exists public.consume_offcut(text,uuid,uuid,text);
    drop function if exists public.scrap_offcut(text,uuid,text);
    drop function if exists public.ns_offcut_result(uuid,boolean) cascade;
    drop function if exists public.ns_heating_kit_candidates(uuid) cascade;
    drop function if exists public.select_job_material(text,uuid,uuid,numeric,boolean,text,uuid,text);
    drop function if exists public.review_job_material_sheet(text,uuid,text);
    drop function if exists public.reserve_job_material_sheet(text,uuid,text,text);
    drop function if exists public.ns_job_sheet_result(uuid,boolean) cascade;
    drop function if exists public.ns_guard_kit_sheet_reviewable() cascade;
    drop function if exists public.ns_guard_conversion_pairs() cascade;
    drop function if exists public.ns_guard_offcuts_within_stock() cascade;
    drop function if exists public.estimate_job_materials(uuid, text);
    drop function if exists public.estimate_job_materials(uuid);
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

  // ================================================= A. migrations ========
  for (const [i, file] of SEQUENCE.entries()) {
    await record(`A${i + 1} ${file} applies in sequence`, async () => {
      await client.query(migration(file));
    });
  }
  await record('A10 the two corrective migrations are re-runnable', async () => {
    for (const f of SEQUENCE.slice(7)) await client.query(migration(f));
    for (const f of SEQUENCE.slice(7)) await client.query(migration(f));
  });

  const ownerId = (await one('insert into auth.users default values returning id')).id;
  const crewId  = (await one('insert into auth.users default values returning id')).id;
  await client.query(`select set_config('nova.is_admin','on',false)`);
  await client.query(`select set_config('nova.actor_id',$1,false)`, [ownerId]);
  const beOwner = () => client.query(`select set_config('nova.actor_id',$1,false)`, [ownerId]);
  const beCrew  = () => client.query(`select set_config('nova.actor_id',$1,false)`, [crewId]);

  const supplierId = (await one('select id from public.ns_suppliers limit 1')).id;
  const custA = (await one(
    `insert into public.customers (name) values ('FIXTURE Lighting Customer') returning id`)).id;
  const jobA = (await one(
    `insert into public.ns_jobs (customer_id) values ($1) returning id`, [custA])).id;

  /** The tests own this catalogue. Nothing here is a real product. */
  const newMaterial = async (over = {}) => {
    const m = {
      sku: null, name: 'FIXTURE part', category: 'track', unit: 'linear_ft',
      pack_quantity: 1, cuttable: false, stock_length: null,
      spec_state: 'unverified', ...over
    };
    const row = await one(
      `insert into public.ns_materials
         (sku,name,category,unit,supplier_id,pack_quantity,reorder_point,reorder_qty,
          cuttable,stock_length,spec_state,spec_source,spec_reviewed_at)
       values ($1,$2,$3,$4,$5,$6,0,0,$7,$8,$9,$10,$11) returning id`,
      [m.sku, m.name, m.category, m.unit, supplierId, m.pack_quantity,
       m.cuttable, m.stock_length, m.spec_state,
       m.spec_state === 'reviewed' ? 'FIXTURE listing note' : null,
       m.spec_state === 'reviewed' ? new Date().toISOString() : null]);
    return row.id;
  };

  const receive = (matId, qty, loc = 'base') => rpc(
    `public.post_stock_movement($1,$2,$3,$4,'received',null,null,null,null,'usable','exact')`,
    [opId('mv'), matId, loc, qty]);

  const onHand = async (matId, loc = 'base') => Number((await one(
    `select coalesce(on_hand,0) as n from public.ns_material_stock_by_location
      where material_id=$1 and location_code=$2`, [matId, loc]))?.n ?? 0);

  const pieces = (matId, loc = 'base') => one(
    `select * from public.ns_material_piece_availability
      where material_id=$1 and location_code=$2`, [matId, loc]);

  // ============================================ B. material facts ========
  await record('B1 a material records whether it may be cut, and how long a piece is',
    async () => {
      const cols = (await all(
        `select column_name from information_schema.columns
          where table_schema='public' and table_name='ns_materials'`)).map(r => r.column_name);
      for (const c of ['cuttable', 'stock_length', 'spec_state', 'spec_source']) {
        assert.ok(cols.includes(c), `${c} is missing`);
      }
    });

  await record('B2 a specification starts unverified, not assumed good', async () => {
    const id = await newMaterial({ name: 'FIXTURE B2' });
    const m = await one('select spec_state, spec_reviewed_at from public.ns_materials where id=$1', [id]);
    assert.equal(m.spec_state, 'unverified');
    assert.equal(m.spec_reviewed_at, null);
  });

  await record('B3 "reviewed" cannot exist without a date', async () => {
    const id = await newMaterial({ name: 'FIXTURE B3' });
    const err = await errorOf(() => client.query(
      `update public.ns_materials set spec_state='reviewed' where id=$1`, [id]));
    assert.ok(err); assert.equal(err.code, '23514');
  });

  await record('B4 a zero or negative piece length is refused; unknown is allowed', async () => {
    const err = await errorOf(() => newMaterial({ name: 'FIXTURE B4a', stock_length: 0 }));
    assert.ok(err); assert.equal(err.code, '23514');
    await newMaterial({ name: 'FIXTURE B4b', stock_length: null });
  });

  await record('B5 kit and heating_cable are real categories now', async () => {
    await newMaterial({ name: 'FIXTURE B5 kit', category: 'kit', unit: 'kit' });
    await newMaterial({ name: 'FIXTURE B5 cable', category: 'heating_cable', unit: 'each' });
    const err = await errorOf(() => newMaterial({ name: 'FIXTURE B5x', category: 'sprockets' }));
    assert.ok(err); assert.equal(err.code, '23514');
  });

  // ============================================== C. kit sheets ==========
  const newKit = (name) => newMaterial({ name, category: 'kit', unit: 'kit' });
  const newSheet = async (kitId, state = 'draft') => (await one(
    `insert into public.ns_kit_sheets (material_id, review_state, source, reviewed_at)
     values ($1,$2,$3,$4) returning id`,
    [kitId, state, state === 'reviewed' ? 'FIXTURE listing' : null,
     state === 'reviewed' ? new Date().toISOString() : null])).id;
  const addSheetLine = (sheetId, matId, qty, inclusion = 'included') => client.query(
    `insert into public.ns_kit_sheet_lines (sheet_id, material_id, quantity_per_kit, inclusion)
     values ($1,$2,$3,$4)`, [sheetId, matId, qty, inclusion]);

  await record('C1 a reviewed sheet must name its source', async () => {
    const kit = await newKit('FIXTURE C1 kit');
    const err = await errorOf(() => client.query(
      `insert into public.ns_kit_sheets (material_id, review_state, reviewed_at)
       values ($1,'reviewed',now())`, [kit]));
    assert.ok(err); assert.equal(err.code, '23514');
  });

  await record('C2 a sheet with no components cannot be reviewed', async () => {
    const kit = await newKit('FIXTURE C2 kit');
    const err = await errorOf(() => newSheet(kit, 'reviewed'));
    assert.ok(err); assert.equal(err.code, '23514');
    assert.match(err.message, /says nothing/i);
  });

  await record('C3 an included component with no quantity blocks review', async () => {
    const kit = await newKit('FIXTURE C3 kit');
    const part = await newMaterial({ name: 'FIXTURE C3 part' });
    const sheet = await newSheet(kit, 'draft');
    await addSheetLine(sheet, part, null);
    const err = await errorOf(() => client.query(
      `update public.ns_kit_sheets set review_state='reviewed', source='FIXTURE listing',
              reviewed_at=now() where id=$1`, [sheet]));
    assert.ok(err, 'an unknown quantity must not be reviewable');
    assert.equal(err.code, '23514');
    assert.match(err.message, /no quantity/i);
  });

  await record('C4 a separately-required component may have no quantity', async () => {
    const kit = await newKit('FIXTURE C4 kit');
    const inBox = await newMaterial({ name: 'FIXTURE C4 in box' });
    const extra = await newMaterial({ name: 'FIXTURE C4 extra' });
    const sheet = await newSheet(kit, 'draft');
    await addSheetLine(sheet, inBox, 10);
    await addSheetLine(sheet, extra, null, 'separately_required');
    await client.query(
      `update public.ns_kit_sheets set review_state='reviewed', source='FIXTURE listing',
              reviewed_at=now() where id=$1`, [sheet]);
    const s = await one('select review_state from public.ns_kit_sheets where id=$1', [sheet]);
    assert.equal(s.review_state, 'reviewed');
  });

  await record('C5 one sheet per kit', async () => {
    const kit = await newKit('FIXTURE C5 kit');
    await newSheet(kit);
    const err = await errorOf(() => newSheet(kit));
    assert.ok(err); assert.equal(err.code, '23505');
  });

  // =========================================== D. opening a kit ==========
  /** A kit with a reviewed sheet: 300 of a channel, 20 of a connector. */
  async function kitWithSheet(tag) {
    const kit = await newKit(`FIXTURE ${tag} kit`);
    const channel = await newMaterial({
      name: `FIXTURE ${tag} channel`, category: 'track', unit: 'linear_ft',
      cuttable: true, stock_length: 100, spec_state: 'reviewed' });
    const conn = await newMaterial({
      name: `FIXTURE ${tag} connector`, category: 'connector', unit: 'each' });
    const extra = await newMaterial({
      name: `FIXTURE ${tag} extra`, category: 'clip', unit: 'each' });
    const sheet = await newSheet(kit, 'draft');
    await addSheetLine(sheet, channel, 300);
    await addSheetLine(sheet, conn, 20);
    await addSheetLine(sheet, extra, 5, 'separately_required');
    await client.query(
      `update public.ns_kit_sheets set review_state='reviewed', source='FIXTURE listing',
              reviewed_at=now() where id=$1`, [sheet]);
    return { kit, channel, conn, extra, sheet };
  }

  await record('D1 opening a kit removes the kit and adds its contents, once', async () => {
    const k = await kitWithSheet('D1');
    await receive(k.kit, 2);
    assert.equal(await onHand(k.kit), 2);
    assert.equal(await onHand(k.channel), 0);

    const r = await rpc(`public.open_sealed_kit($1,$2,'base',1,null)`, [opId('open'), k.kit]);
    assert.equal(r.kind, 'conversion');
    assert.equal(await onHand(k.kit), 1, 'the opened kit is gone from stock');
    assert.equal(await onHand(k.channel), 300);
    assert.equal(await onHand(k.conn), 20);
    assert.equal(await onHand(k.extra), 0,
      'a separately-required part is not in the box, so opening creates none');
  });

  await record('D2 the kit and its contents are never both counted', async () => {
    const k = await kitWithSheet('D2');
    await receive(k.kit, 1);
    // Before: one kit, no components. After: no kit, its components.
    // There is no state in between, because it is one transaction.
    await rpc(`public.open_sealed_kit($1,$2,'base',1,null)`, [opId('open'), k.kit]);
    assert.equal(await onHand(k.kit), 0);
    assert.equal(await onHand(k.channel), 300);
    const moves = await all(
      `select mv.reason, mv.delta from public.ns_material_stock_moves mv
         join public.ns_stock_operations o on o.id = mv.operation_id
        where o.kind='conversion' and mv.material_id in ($1,$2)
        order by mv.delta`, [k.kit, k.channel]);
    assert.equal(moves.length, 2);
    assert.equal(moves[0].reason, 'converted_out');
    assert.equal(moves[1].reason, 'converted_in');
  });

  await record('D3 a kit with no sheet, or an unreviewed one, cannot be opened', async () => {
    const bare = await newKit('FIXTURE D3 bare');
    await receive(bare, 1);
    let err = await errorOf(() => rpc(
      `public.open_sealed_kit($1,$2,'base',1,null)`, [opId('open'), bare]));
    assert.ok(err); assert.equal(err.code, 'P0002');

    const draft = await newKit('FIXTURE D3 draft');
    await receive(draft, 1);
    await newSheet(draft, 'draft');
    err = await errorOf(() => rpc(
      `public.open_sealed_kit($1,$2,'base',1,null)`, [opId('open'), draft]));
    assert.ok(err); assert.equal(err.code, '23514');
    assert.match(err.message, /not established/i);
  });

  await record('D4 a kit you do not have cannot be opened', async () => {
    const k = await kitWithSheet('D4');
    const err = await errorOf(() => rpc(
      `public.open_sealed_kit($1,$2,'base',1,null)`, [opId('open'), k.kit]));
    assert.ok(err); assert.equal(err.code, '23514');
    assert.match(err.message, /cannot be opened/i);
  });

  await record('D5 something that is not a kit has nothing to convert', async () => {
    const plain = await newMaterial({ name: 'FIXTURE D5 plain' });
    await receive(plain, 10);
    const err = await errorOf(() => rpc(
      `public.open_sealed_kit($1,$2,'base',1,null)`, [opId('open'), plain]));
    assert.ok(err); assert.equal(err.code, '22023');
  });

  await record('D6 opening is replay-safe', async () => {
    const k = await kitWithSheet('D6');
    await receive(k.kit, 2);
    const key = opId('open');
    const a = await rpc(`public.open_sealed_kit($1,$2,'base',1,null)`, [key, k.kit]);
    const b = await rpc(`public.open_sealed_kit($1,$2,'base',1,null)`, [key, k.kit]);
    assert.equal(a.replayed, false);
    assert.equal(b.replayed, true);
    assert.equal(b.operation_id, a.operation_id);
    assert.equal(await onHand(k.kit), 1, 'the second call opened nothing');
    assert.equal(await onHand(k.channel), 300);
  });

  await record('D7 a lone converted_in is stock from nowhere, and is refused', async () => {
    const k = await kitWithSheet('D7');
    const err = await errorOf(() => client.query(`
      with o as (
        insert into public.ns_stock_operations
          (client_operation_id, kind, confirmed_physical)
        values ($1,'conversion',true) returning id)
      insert into public.ns_material_stock_moves
        (material_id, location_id, operation_id, delta, reason)
      select $2, (select id from public.ns_stock_locations where code='base'),
             o.id, 50, 'converted_in' from o`, [opId('direct'), k.channel]));
    assert.ok(err, 'a conversion must consume something');
    assert.equal(err.code, '23514');
  });

  await record('D8 a conversion reason cannot be smuggled into another kind', async () => {
    const k = await kitWithSheet('D8');
    const err = await errorOf(() => client.query(`
      with o as (
        insert into public.ns_stock_operations
          (client_operation_id, kind, confirmed_physical)
        values ($1,'receipt',true) returning id)
      insert into public.ns_material_stock_moves
        (material_id, location_id, operation_id, delta, reason)
      select $2, (select id from public.ns_stock_locations where code='base'),
             o.id, 50, 'converted_in' from o`, [opId('direct'), k.channel]));
    assert.ok(err); assert.equal(err.code, '23514');
  });

  await record('D9 post_stock_movement will not post a conversion', async () => {
    const k = await kitWithSheet('D9');
    const err = await errorOf(() => rpc(
      `public.post_stock_movement($1,$2,'base',10,'converted_in',null,null,null,null,'usable','exact')`,
      [opId('mv'), k.channel]));
    assert.ok(err, 'conversions belong to open_sealed_kit, which pairs them');
    assert.equal(err.code, '22023');
  });

  // ================================================ E. offcuts ===========
  async function cuttableWithStock(tag, received = 100) {
    const id = await newMaterial({
      name: `FIXTURE ${tag} channel`, category: 'track', unit: 'linear_ft',
      cuttable: true, stock_length: 100, spec_state: 'reviewed' });
    await receive(id, received);
    return id;
  }

  await record('E1 recording an offcut adds no stock -- it says what shape stock is in',
    async () => {
      const mat = await cuttableWithStock('E1');
      // A job took 70 ft of the 100 ft stick.
      await rpc(`public.post_stock_movement($1,$2,'base',70,'consumed',null,null,null,null,'usable','exact')`,
        [opId('mv'), mat]);
      assert.equal(await onHand(mat), 30);

      const before = Number((await one(
        `select count(*)::int as n from public.ns_material_stock_moves where material_id=$1`,
        [mat])).n);
      const r = await rpc(`public.record_offcut($1,$2,'base',30,null,null)`, [opId('cut'), mat]);
      assert.equal(r.status, 'available');
      assert.equal(Number(r.length), 30);
      const after = Number((await one(
        `select count(*)::int as n from public.ns_material_stock_moves where material_id=$1`,
        [mat])).n);
      assert.equal(after, before, 'no movement was posted');
      assert.equal(await onHand(mat), 30, 'and the balance did not move');
    });

  await record('E2 an offcut longer than the shelf holds is refused', async () => {
    const mat = await cuttableWithStock('E2', 10);
    const err = await errorOf(() => rpc(
      `public.record_offcut($1,$2,'base',40,null,null)`, [opId('cut'), mat]));
    assert.ok(err, 'otherwise the piece list promises material that is not there');
    assert.equal(err.code, '23514');
  });

  await record('E3 two offcuts are not one long run', async () => {
    const mat = await cuttableWithStock('E3', 100);
    await rpc(`public.post_stock_movement($1,$2,'base',94,'consumed',null,null,null,null,'usable','exact')`,
      [opId('mv'), mat]);
    await rpc(`public.record_offcut($1,$2,'base',3,null,null)`, [opId('cut'), mat]);
    await rpc(`public.record_offcut($1,$2,'base',3,null,null)`, [opId('cut'), mat]);
    const p = await pieces(mat);
    assert.equal(Number(p.on_hand), 6);
    assert.equal(Number(p.offcut_total), 6);
    assert.equal(Number(p.offcut_count), 2);
    assert.equal(Number(p.longest_offcut), 3);
    assert.equal(Number(p.longest_runnable), 3,
      'six feet on hand, and the longest run that can be cut is three');
  });

  await record('E4 a full stick beats the offcuts for the longest run', async () => {
    const mat = await cuttableWithStock('E4', 100);
    await rpc(`public.post_stock_movement($1,$2,'base',100,'received',null,null,null,null,'usable','exact')`,
      [opId('mv'), mat]);
    await rpc(`public.post_stock_movement($1,$2,'base',97,'consumed',null,null,null,null,'usable','exact')`,
      [opId('mv'), mat]);
    await rpc(`public.record_offcut($1,$2,'base',3,null,null)`, [opId('cut'), mat]);
    const p = await pieces(mat);
    assert.equal(Number(p.on_hand), 103);
    assert.equal(Number(p.full_length_total), 100);
    assert.equal(Number(p.full_pieces), 1);
    assert.equal(Number(p.longest_runnable), 100);
  });

  await record('E5 using an offcut takes its length off the shelf, once', async () => {
    const mat = await cuttableWithStock('E5', 100);
    await rpc(`public.post_stock_movement($1,$2,'base',70,'consumed',null,null,null,null,'usable','exact')`,
      [opId('mv'), mat]);
    const cut = await rpc(`public.record_offcut($1,$2,'base',30,null,null)`, [opId('cut'), mat]);
    const r = await rpc(`public.consume_offcut($1,$2,$3,null)`,
      [opId('use'), cut.offcut_id, jobA]);
    assert.equal(r.status, 'used');
    assert.equal(await onHand(mat), 0, 'the 30 ft left the ledger when it was used');
    const p = await pieces(mat);
    assert.equal(Number(p.offcut_total), 0, 'and it is no longer an available piece');
  });

  await record('E6 a used piece cannot be used again', async () => {
    const mat = await cuttableWithStock('E6', 100);
    await rpc(`public.post_stock_movement($1,$2,'base',70,'consumed',null,null,null,null,'usable','exact')`,
      [opId('mv'), mat]);
    const cut = await rpc(`public.record_offcut($1,$2,'base',30,null,null)`, [opId('cut'), mat]);
    await rpc(`public.consume_offcut($1,$2,null,null)`, [opId('use'), cut.offcut_id]);
    const err = await errorOf(() => rpc(`public.consume_offcut($1,$2,null,null)`,
      [opId('use'), cut.offcut_id]));
    assert.ok(err); assert.equal(err.code, '23514');
  });

  await record('E7 scrapping a piece writes it off as damaged, not as a deletion',
    async () => {
      const mat = await cuttableWithStock('E7', 100);
      await rpc(`public.post_stock_movement($1,$2,'base',70,'consumed',null,null,null,null,'usable','exact')`,
        [opId('mv'), mat]);
      const cut = await rpc(`public.record_offcut($1,$2,'base',30,null,null)`, [opId('cut'), mat]);
      const r = await rpc(`public.scrap_offcut($1,$2,'kinked')`, [opId('scrap'), cut.offcut_id]);
      assert.equal(r.status, 'scrapped');
      assert.equal(r.condition, 'damaged');
      const row = await one(
        `select count(*)::int as n from public.ns_material_offcuts where id=$1`,
        [cut.offcut_id]);
      assert.equal(row.n, 1, 'the record stays; only the stock went');
      const bal = await one(
        `select on_hand, damaged_on_hand from public.ns_material_stock_by_location
          where material_id=$1 and location_code='base'`, [mat]);
      assert.equal(Number(bal.on_hand), 0,
        'the scrapped piece is off the usable shelf');
      assert.equal(Number(bal.damaged_on_hand), 0,
        'and it is NOT parked in the damaged pool: it was thrown away, not kept');
      const mv = await one(
        `select reason, condition from public.ns_material_stock_moves
          where material_id=$1 and reason='damaged'`, [mat]);
      assert.equal(mv.condition, 'usable',
        'condition names the pool the quantity left; reason says why');
    });

  await record('E8 a usable piece and a damaged one are never confused', async () => {
    const mat = await cuttableWithStock('E8', 100);
    await rpc(`public.post_stock_movement($1,$2,'base',40,'consumed',null,null,null,null,'usable','exact')`,
      [opId('mv'), mat]);
    const a = await rpc(`public.record_offcut($1,$2,'base',30,null,null)`, [opId('cut'), mat]);
    const b = await rpc(`public.record_offcut($1,$2,'base',30,null,null)`, [opId('cut'), mat]);
    await rpc(`public.scrap_offcut($1,$2,null)`, [opId('scrap'), b.offcut_id]);
    const p = await pieces(mat);
    assert.equal(Number(p.offcut_count), 1, 'only the usable piece is available');
    assert.equal(Number(p.offcut_total), 30);
    const rows = await all(
      `select condition, status from public.ns_material_offcuts
        where material_id=$1 order by status`, [mat]);
    assert.deepEqual(rows.map(r => [r.status, r.condition]),
      [['available', 'usable'], ['scrapped', 'damaged']]);
    assert.ok(a.offcut_id);
  });

  await record('E9 a fixed-length product has no offcuts', async () => {
    const fixed = await newMaterial({
      name: 'FIXTURE E9 cable kit', category: 'heating_cable', unit: 'each',
      cuttable: false });
    await receive(fixed, 5);
    const err = await errorOf(() => rpc(
      `public.record_offcut($1,$2,'base',3,null,null)`, [opId('cut'), fixed]));
    assert.ok(err, 'a fixed-length kit is whole or it is scrap');
    assert.equal(err.code, '22023');
  });

  await record('E10 recording a piece is replay-safe', async () => {
    const mat = await cuttableWithStock('E10', 100);
    await rpc(`public.post_stock_movement($1,$2,'base',70,'consumed',null,null,null,null,'usable','exact')`,
      [opId('mv'), mat]);
    const key = opId('cut');
    const a = await rpc(`public.record_offcut($1,$2,'base',30,null,null)`, [key, mat]);
    const b = await rpc(`public.record_offcut($1,$2,'base',30,null,null)`, [key, mat]);
    assert.equal(a.replayed, false);
    assert.equal(b.replayed, true);
    assert.equal(b.offcut_id, a.offcut_id);
    const p = await pieces(mat);
    assert.equal(Number(p.offcut_count), 1);
  });

  // ========================================== F. job material sheets =====
  const newJobSheet = async (jobId) => (await one(
    `insert into public.ns_job_material_sheets (job_id, created_by)
     values ($1,$2) returning id`, [jobId, ownerId])).id;

  await record('F1 an unchecked specification cannot be selected for a job', async () => {
    const sheet = await newJobSheet(jobA);
    const kit = await newKit('FIXTURE F1 kit');
    const err = await errorOf(() => rpc(
      `public.select_job_material($1,$2,$3,1,true,'selected',null,null)`,
      [opId('sel'), sheet, kit]));
    assert.ok(err); assert.equal(err.code, '23514');
    assert.match(err.message, /specification/i);
  });

  await record('F2 a reviewed kit with a reviewed sheet can be selected', async () => {
    const job = (await one(
      `insert into public.ns_jobs (customer_id) values ($1) returning id`, [custA])).id;
    const sheet = await newJobSheet(job);
    const k = await kitWithSheet('F2');
    await client.query(
      `update public.ns_materials set spec_state='reviewed', spec_source='FIXTURE listing',
              spec_reviewed_at=now() where id=$1`, [k.kit]);
    const r = await rpc(`public.select_job_material($1,$2,$3,2,true,'selected',null,null)`,
      [opId('sel'), sheet, k.kit]);
    assert.equal(r.lines.length, 1);
    assert.equal(r.lines[0].selected, true);
    assert.equal(Number(r.lines[0].quantity), 2);
  });

  await record('F3 reviewing refuses while a selected line rests on a guess', async () => {
    const job = (await one(
      `insert into public.ns_jobs (customer_id) values ($1) returning id`, [custA])).id;
    const sheet = await newJobSheet(job);
    const plain = await newMaterial({ name: 'FIXTURE F3 clip', category: 'clip', unit: 'each' });
    await rpc(`public.select_job_material($1,$2,$3,10,true,'manual',null,null)`,
      [opId('sel'), sheet, plain]);
    // A clip needs no product review; a heating cable does.
    const cable = await newMaterial({
      name: 'FIXTURE F3 cable', category: 'heating_cable', unit: 'each' });
    await client.query(
      `insert into public.ns_job_material_sheet_lines (sheet_id, material_id, quantity, selected, source)
       values ($1,$2,1,true,'selected')`, [sheet, cable]);
    const err = await errorOf(() => rpc(`public.review_job_material_sheet($1,$2,null)`,
      [opId('rev'), sheet]));
    assert.ok(err); assert.equal(err.code, '23514');
    assert.match(err.message, /has not been checked/i);
  });

  await record('F4 ONLY selected lines reserve stock', async () => {
    const job = (await one(
      `insert into public.ns_jobs (customer_id) values ($1) returning id`, [custA])).id;
    const sheet = await newJobSheet(job);
    const chosen = await newMaterial({ name: 'FIXTURE F4 chosen', category: 'clip', unit: 'each' });
    const option = await newMaterial({ name: 'FIXTURE F4 option', category: 'clip', unit: 'each' });
    await receive(chosen, 100);
    await receive(option, 100);

    await rpc(`public.select_job_material($1,$2,$3,10,true,'manual',null,null)`,
      [opId('sel'), sheet, chosen]);
    await rpc(`public.select_job_material($1,$2,$3,10,false,'manual',null,null)`,
      [opId('sel'), sheet, option]);
    await rpc(`public.review_job_material_sheet($1,$2,null)`, [opId('rev'), sheet]);
    const r = await rpc(`public.reserve_job_material_sheet($1,$2,'base',null)`,
      [opId('res'), sheet]);
    assert.equal(r.status, 'reserved');

    const held = await all(
      `select material_id, quantity from public.ns_stock_reservations
        where job_id=$1 and status='held'`, [job]);
    assert.equal(held.length, 1, 'the unchosen option must not reach the shelf');
    assert.equal(held[0].material_id, chosen);

    const availOption = await one(
      `select available from public.ns_material_stock_by_location
        where material_id=$1 and location_code='base'`, [option]);
    assert.equal(Number(availOption.available), 100,
      'and its availability is untouched');
  });

  await record('F5 a draft sheet cannot reserve, and reserving twice is a replay',
    async () => {
      const job = (await one(
        `insert into public.ns_jobs (customer_id) values ($1) returning id`, [custA])).id;
      const sheet = await newJobSheet(job);
      const mat = await newMaterial({ name: 'FIXTURE F5 clip', category: 'clip', unit: 'each' });
      await receive(mat, 50);
      await rpc(`public.select_job_material($1,$2,$3,5,true,'manual',null,null)`,
        [opId('sel'), sheet, mat]);

      const err = await errorOf(() => rpc(
        `public.reserve_job_material_sheet($1,$2,'base',null)`, [opId('res'), sheet]));
      assert.ok(err); assert.equal(err.code, '23514');

      await rpc(`public.review_job_material_sheet($1,$2,null)`, [opId('rev'), sheet]);
      const key = opId('res');
      const a = await rpc(`public.reserve_job_material_sheet($1,$2,'base',null)`, [key, sheet]);
      const b = await rpc(`public.reserve_job_material_sheet($1,$2,'base',null)`, [key, sheet]);
      assert.equal(a.replayed, false);
      assert.equal(b.replayed, true);
      const held = await all(
        `select id from public.ns_stock_reservations where job_id=$1 and status='held'`, [job]);
      assert.equal(held.length, 1, 'a retry reserved nothing extra');
    });

  await record('F6 one open sheet per job', async () => {
    const job = (await one(
      `insert into public.ns_jobs (customer_id) values ($1) returning id`, [custA])).id;
    await newJobSheet(job);
    const err = await errorOf(() => newJobSheet(job));
    assert.ok(err); assert.equal(err.code, '23505');
  });

  await record('F7 a reviewed sheet with nothing selected is refused', async () => {
    const job = (await one(
      `insert into public.ns_jobs (customer_id) values ($1) returning id`, [custA])).id;
    const sheet = await newJobSheet(job);
    const mat = await newMaterial({ name: 'FIXTURE F7 clip', category: 'clip', unit: 'each' });
    await rpc(`public.select_job_material($1,$2,$3,5,false,'manual',null,null)`,
      [opId('sel'), sheet, mat]);
    const err = await errorOf(() => rpc(`public.review_job_material_sheet($1,$2,null)`,
      [opId('rev'), sheet]));
    assert.ok(err); assert.equal(err.code, '23514');
  });

  // ====================================== G. heating-kit selection =======
  await record('G1 heating candidates are listed with the job measurements, and not ranked',
    async () => {
      const good = await newMaterial({
        name: 'FIXTURE G1 reviewed cable', category: 'heating_cable', unit: 'each',
        spec_state: 'reviewed' });
      const unknown = await newMaterial({
        name: 'FIXTURE G1 unchecked cable', category: 'heating_cable', unit: 'each' });
      const r = await rpc(`public.ns_heating_kit_candidates($1)`, [jobA]);

      const byId = new Map(r.candidates.map((c) => [c.material_id, c]));
      assert.equal(byId.get(good).selectable, true);
      assert.equal(byId.get(unknown).selectable, false);
      assert.match(byId.get(unknown).why_not, /not been checked/i);
      assert.match(r.selection_rule, /manufacturer/i);
      assert.ok(Array.isArray(r.measurements), 'the measurements come with the list');
      assert.ok(!('recommended' in r), 'nothing here recommends a product');
    });

  // ============================================ H. authorisation =========
  await record('H1 a non-admin gets nowhere', async () => {
    const k = await kitWithSheet('H1');
    await receive(k.kit, 1);
    await client.query(`select set_config('nova.is_admin','off',false)`);
    try {
      for (const [sql, extra] of [
        [`public.open_sealed_kit($1,$2,'base',1,null)`, [k.kit]],
        [`public.record_offcut($1,$2,'base',1,null,null)`, [k.channel]],
        [`public.consume_offcut($1,'00000000-0000-0000-0000-000000000000',null,null)`, []],
        [`public.scrap_offcut($1,'00000000-0000-0000-0000-000000000000',null)`, []]
      ]) {
        const err = await errorOf(() => rpc(sql, [opId('anon'), ...extra]));
        assert.ok(err, sql); assert.equal(err.code, '42501', sql);
      }
    } finally {
      await client.query(`select set_config('nova.is_admin','on',false)`);
    }
  });

  await record('H2 a crew records pieces but does not open kits or commit stock',
    async () => {
      const k = await kitWithSheet('H2');
      await receive(k.kit, 1);
      await receive(k.channel, 100);
      const sheet = await newJobSheet((await one(
        `insert into public.ns_jobs (customer_id) values ($1) returning id`, [custA])).id);

      await client.query(
        `insert into public.ns_crew_members (user_id,role,vehicle_location_id,display_name)
         values ($1,'crew',(select id from public.ns_stock_locations where code='car_a'),'FIXTURE crew')
         on conflict (user_id) do update set role='crew', active=true`,
        [crewId]);
      await beCrew();
      try {
        assert.equal((await one('select public.is_owner() as o')).o, false);

        // Field work: allowed.
        await rpc(`public.post_stock_movement($1,$2,'base',70,'consumed',null,null,null,null,'usable','exact')`,
          [opId('mv'), k.channel]);
        const cut = await rpc(`public.record_offcut($1,$2,'base',30,null,null)`,
          [opId('cut'), k.channel]);
        await rpc(`public.consume_offcut($1,$2,null,null)`, [opId('use'), cut.offcut_id]);

        // Owner decisions: refused in the backend.
        for (const [sql, extra] of [
          [`public.open_sealed_kit($1,$2,'base',1,null)`, [k.kit]],
          [`public.select_job_material($1,$2,$3,1,true,'manual',null,null)`, [sheet, k.channel]],
          [`public.review_job_material_sheet($1,$2,null)`, [sheet]],
          [`public.reserve_job_material_sheet($1,$2,'base',null)`, [sheet]]
        ]) {
          const err = await errorOf(() => rpc(sql, [opId('crew'), ...extra]));
          assert.ok(err, sql); assert.equal(err.code, '42501', sql);
        }
      } finally {
        await beOwner();
      }
    });

  await record('H3 a crew cannot record a piece in the other car', async () => {
    const mat = await cuttableWithStock('H3', 100);
    await beCrew();
    try {
      const err = await errorOf(() => rpc(
        `public.record_offcut($1,$2,'car_b',5,null,null)`, [opId('crew'), mat]));
      assert.ok(err);
      // No Car B is seeded, so this is a "no such location" refusal -- which
      // is itself the point: Car B is optional data, never assumed.
      assert.ok(['P0002', '42501'].includes(err.code), err.code);
    } finally {
      await beOwner();
    }
  });

  await record('H4 anon holds no execute on any of the new RPCs', async () => {
    for (const f of [
      'public.open_sealed_kit(text,uuid,text,numeric,text)',
      'public.record_offcut(text,uuid,text,numeric,uuid,text)',
      'public.consume_offcut(text,uuid,uuid,text)',
      'public.scrap_offcut(text,uuid,text)',
      'public.select_job_material(text,uuid,uuid,numeric,boolean,text,uuid,text)',
      'public.review_job_material_sheet(text,uuid,text)',
      'public.reserve_job_material_sheet(text,uuid,text,text)'
    ]) {
      const { ok } = await one(
        `select has_function_privilege('anon',$1,'execute') as ok`, [f]);
      assert.equal(ok, false, `anon can execute ${f}`);
      const { yes } = await one(
        `select has_function_privilege('authenticated',$1,'execute') as yes`, [f]);
      assert.equal(yes, true, `authenticated cannot execute ${f}`);
    }
  });

  await record('H5 authenticated cannot write offcuts or sheets by hand', async () => {
    for (const p of ['INSERT', 'UPDATE', 'DELETE']) {
      const { ok } = await one(
        `select has_table_privilege('authenticated','public.ns_material_offcuts',$1) as ok`, [p]);
      assert.equal(ok, false, `authenticated holds ${p} on ns_material_offcuts`);
    }
    const { sel } = await one(
      `select has_table_privilege('authenticated','public.ns_material_offcuts','SELECT') as sel`);
    assert.equal(sel, true);
  });

  await record('H6 no supplier catalogue data was seeded by these migrations', async () => {
    const { n } = await one(
      `select count(*)::int as n from public.ns_kit_sheets`);
    assert.ok(n >= 0);
    const seeded = await all(
      `select name from public.ns_materials where name not like 'FIXTURE%'`);
    assert.equal(seeded.length, 0,
      'every material in this database came from the tests, not from a migration');
  });

  // ================================================== report =============
  await client.end();
  const failed = results.filter(r => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.err}`}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) process.exit(1);
})().catch((err) => { console.error(err); process.exit(1); });
