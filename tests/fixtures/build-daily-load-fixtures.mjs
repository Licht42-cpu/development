// Builds the versioned daily-load fixture set that Batch 10.2 implements
// against, by running the REAL backend on a disposable database and writing
// down what it returned.
//
//   node tests/db/setup-test-db.mjs
//   node tests/fixtures/build-daily-load-fixtures.mjs
//
// WHY GENERATED AND NOT HAND-WRITTEN. A hand-written fixture is somebody's
// idea of what the contract says. These are what the contract actually
// produced, so they cannot drift from it: regenerate after any change and
// the diff is the contract change. If the backend stops producing a shape,
// the fixture stops containing it, and the other track finds out at review
// time rather than at integration time.
//
// DETERMINISTIC. Fixed dates, fixed names, fixed operation keys, and ids
// replaced with stable placeholders (set-1, mat-washer, …) so two runs on
// two machines produce byte-identical files. Nothing here contains a real
// customer, a real address or a real supplier product.
//
// NOTHING IS APPLIED TO THE LIVE DATABASE BY THIS SCRIPT.

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
  '20261011111000_batch10_1_load_operations.sql'
];

const DAYS = {
  siding:        '2027-04-05',
  noBleach:      '2027-04-06',
  mixed:         '2027-04-07',
  lighting:      '2027-04-08',
  christmas:     '2027-11-15',
  winter:        '2027-12-01',
  repeated:      '2027-04-09',
  carB:          '2027-04-10',
  shortage:      '2027-04-12',
  lateChange:    '2027-04-13'
};

/* Stable placeholders, so two runs produce identical files. */
const names = new Map();
let counter = 0;
function stable(id, hint) {
  if (id === null || id === undefined) return id;
  if (!names.has(id)) names.set(id, `${hint || 'id'}-${++counter}`);
  return names.get(id);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Replaces every uuid and every timestamp with something stable, so the
 *  fixture is about SHAPE and VALUES, never about when it was generated. */
function normalise(value, keyHint) {
  if (Array.isArray(value)) return value.map((v) => normalise(v, keyHint));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalise(v, k);
    return out;
  }
  if (typeof value === 'string') {
    if (UUID.test(value)) {
      const hint = (keyHint || '').replace(/_id$/, '').replace(/^active_/, '');
      return stable(value, hint || 'id');
    }
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return '<timestamp>';
    if (/^[0-9a-f]{32}$/.test(value)) return '<fingerprint>';
  }
  return value;
}

(async () => {
  assertDisposableTarget(PGURL);
  const client = new pg.Client({ connectionString: PGURL });
  await client.connect();
  await assertDisposableDatabase(client);

  const one = async (sql, p) => (await client.query(sql, p)).rows[0];
  const rpc = async (fn, p) => (await one(`select ${fn} as r`, p)).r;

  // ---- a clean database with the whole pending sequence applied
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
  for (const f of ['fixture-schema-batch8-1.sql', 'fixture-schema-batch9-1.sql',
                   'fixture-schema-batch10-1.sql']) {
    await client.query(readFileSync(join(DB, f), 'utf8'));
  }
  for (const f of SEQUENCE) {
    await client.query(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }

  const owner = (await one('insert into auth.users default values returning id')).id;
  const crew  = (await one('insert into auth.users default values returning id')).id;
  await client.query(`select set_config('nova.is_admin','on',false)`);
  await client.query(`select set_config('nova.actor_id',$1,false)`, [owner]);

  const supplier = (await one('select id from public.ns_suppliers limit 1')).id;
  const customer = (await one(
    `insert into public.customers (name) values ('FIXTURE Customer') returning id`)).id;

  let k = 0;
  const key = (t) => `fixture-${t}-${++k}`;

  const material = async (name, over = {}) => (await one(
    `insert into public.ns_materials
       (name,category,unit,supplier_id,pack_quantity,reorder_point,reorder_qty,
        tracking_mode,cuttable,stock_length,spec_state,spec_source,spec_reviewed_at)
     values ($1,$2,$3,$4,1,0,0,$5,$6,$7,$8,$9,$10) returning id`,
    [name, over.category || 'tool', over.unit || 'each', supplier,
     over.tracking || 'quantity', over.cuttable || false, over.stockLength || null,
     over.spec || 'unverified',
     over.spec === 'reviewed' ? 'FIXTURE listing' : null,
     over.spec === 'reviewed' ? '2027-01-01T00:00:00Z' : null])).id;

  const service = async (sk, name) => (await one(
    `insert into public.services (key,name,unit) values ($1,$2,'sq_ft')
     on conflict (key) do update set name=excluded.name returning id`, [sk, name])).id;

  const job = async (day, over = {}) => (await one(
    `insert into public.ns_jobs (customer_id, scheduled_for, status)
     values ($1,$2,'scheduled') returning id`,
    [over.customer || customer, `${day}T15:00:00Z`])).id;

  const measure = (j, s, q) => client.query(
    `insert into public.job_measurements (job_id, service_id, quantity, unit)
     values ($1,$2,$3,'sq_ft')`, [j, s, q]);

  const rule = (s, m, o = {}) => client.query(
    `insert into public.ns_service_load_rules
       (service_id, material_id, rule_kind, quantity_fixed, quantity_per_unit,
        allowance_state, removable, always_keep)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (service_id, material_id) do update
        set rule_kind=excluded.rule_kind, quantity_fixed=excluded.quantity_fixed,
            quantity_per_unit=excluded.quantity_per_unit,
            allowance_state=excluded.allowance_state,
            removable=excluded.removable, always_keep=excluded.always_keep`,
    [s, m, o.kind || 'equipment', o.fixed ?? null, o.perUnit ?? null,
     o.allowance || 'reviewed', o.removable ?? false, o.alwaysKeep ?? false]);

  const receive = (m, q, loc = 'base') => rpc(
    `public.post_stock_movement($1,$2,$3,$4,'received',null,null,null,null,'usable','exact')`,
    [key('rcv'), m, loc, q]);

  const plan = (code, day) => rpc(
    `public.build_load_plan($1,$2,$3::date,null)`, [key('plan'), code, day]);

  /* ---- the catalogue these scenarios use. All FIXTURE, all owner-entered. */
  const siding   = await service('siding_soft_wash', 'Siding Soft Washing');
  const windows  = await service('window_cleaning', 'Window Cleaning');
  const lighting = await service('permanent_lighting_install', 'Permanent Lighting Install');
  const snow     = await service('snow_clearing', 'Snow Clearing');

  const washer   = await material('FIXTURE pressure washer');
  const softWash = await material('FIXTURE soft-wash kit', { removable: true });
  const toolKit  = await material('FIXTURE standard tool kit');
  const ladder   = await material('FIXTURE extension ladder');
  const product  = await material('FIXTURE soft-wash product',
    { category: 'consumable', unit: 'litre' });
  const rinse    = await material('FIXTURE rinse aid',
    { category: 'consumable', unit: 'level', tracking: 'level' });
  const salt     = await material('FIXTURE de-icer',
    { category: 'consumable', unit: 'kilogram' });
  const channel  = await material('FIXTURE lighting channel',
    { category: 'track', unit: 'linear_ft', cuttable: true, stockLength: 100,
      spec: 'reviewed' });
  const scarce   = await material('FIXTURE scarce product',
    { category: 'consumable', unit: 'litre' });

  await rule(siding, washer);
  await rule(siding, softWash, { removable: true });
  await rule(siding, product, { kind: 'consumable', perUnit: 0.01 });
  await rule(siding, rinse, { kind: 'consumable', fixed: 1 });
  await rule(windows, toolKit, { alwaysKeep: true });
  await rule(lighting, ladder);
  await rule(lighting, channel, { kind: 'consumable', perUnit: 1.1,
    allowance: 'provisional' });
  await rule(snow, salt, { kind: 'consumable', fixed: 25 });

  await receive(washer, 1);
  await receive(softWash, 1);
  await receive(toolKit, 1);
  await receive(ladder, 1);
  await receive(product, 500);
  await receive(salt, 400);
  await receive(channel, 600);

  const scenarios = {};

  /* ---- 1. siding: the washer and soft-wash kit go on ---- */
  {
    const j = await job(DAYS.siding);
    await measure(j, siding, 1200);
    scenarios.siding = {
      description: 'One siding stop. The washer and the removable soft-wash '
        + 'kit are required; product is quantity-planned from the measured area.',
      request: { location_code: 'car_a', work_date: DAYS.siding },
      response: await plan('car_a', DAYS.siding)
    };
  }

  /* ---- 2. a day with no bleach work: the removable kit comes off ---- */
  {
    await rpc(`public.post_stock_transfer($1,$2,1,'base','car_a',true,null,null)`,
      [key('tx'), softWash]);
    const j = await job(DAYS.noBleach);
    await measure(j, windows, 24);
    scenarios.no_bleach_day = {
      description: 'Windows only. The soft-wash kit is aboard and nothing '
        + 'today needs it, so it is a Return. The standard tool kit is '
        + 'always_keep and stays.',
      request: { location_code: 'car_a', work_date: DAYS.noBleach },
      response: await plan('car_a', DAYS.noBleach)
    };

    scenarios.no_bleach_day_with_manual_keep = (async () => {
      await rpc(`public.set_manual_keep($1,'car_a',$2::date,$3,true,'rain forecast')`,
        [key('keep'), DAYS.noBleach, softWash]);
      return {
        description: 'The same day after the crew held the kit back on '
          + 'purpose. The Return became a Keep and survives regeneration.',
        request: { location_code: 'car_a', work_date: DAYS.noBleach },
        response: await plan('car_a', DAYS.noBleach)
      };
    });
    scenarios.no_bleach_day_with_manual_keep =
      await scenarios.no_bleach_day_with_manual_keep();
  }

  /* ---- 3. mixed services, one shared tool decision ---- */
  {
    const a = await job(DAYS.mixed);
    const b = await job(DAYS.mixed);
    const c = await job(DAYS.mixed);
    await measure(a, siding, 800);
    await measure(b, siding, 400);
    await measure(c, windows, 30);
    scenarios.mixed_services = {
      description: 'Three stops, two services. The washer appears ONCE for '
        + 'the whole day with every stop that needs it named; product is '
        + 'summed across both siding stops.',
      request: { location_code: 'car_a', work_date: DAYS.mixed },
      response: await plan('car_a', DAYS.mixed)
    };
  }

  /* ---- 4. permanent lighting, with a reusable offcut on the shelf ---- */
  {
    await rpc(`public.post_stock_movement($1,$2,'base',560,'consumed',null,null,null,null,'usable','exact')`,
      [key('mv'), channel]);
    await rpc(`public.record_offcut($1,$2,'base',40,null,'left from a previous roofline')`,
      [key('cut'), channel]);
    const j = await job(DAYS.lighting);
    await measure(j, lighting, 300);
    scenarios.permanent_lighting_with_offcut = {
      description: 'A lighting install. The channel allowance is provisional, '
        + 'so the line is needs_review and estimated. A 40 ft offcut exists on '
        + 'the shelf; pieces are read from ns_material_piece_availability, not '
        + 'from the plan.',
      request: { location_code: 'car_a', work_date: DAYS.lighting },
      response: await plan('car_a', DAYS.lighting),
      pieces: (await client.query(
        `select material_id, on_hand, offcut_total, offcut_count, longest_offcut,
                full_length_total, full_pieces, longest_runnable
           from public.ns_material_piece_availability
          where material_id=$1 and location_code='base'`, [channel])).rows[0]
    };
  }

  /* ---- 5. named Christmas sets ---- */
  {
    const setId = (await rpc(
      `public.register_seasonal_set($1,'FIXTURE-SET-01','roofline','warm white',40,'base',null,null,null)`,
      [key('set')])).set.set_id;
    await rpc(`public.inspect_seasonal_set($1,$2,'usable',null)`, [key('insp'), setId]);
    const j = await job(DAYS.christmas);
    await measure(j, lighting, 40);
    await rpc(`public.assign_seasonal_set($1,$2,$3,2027,null,$4,null)`,
      [key('asg'), setId, customer, j]);
    scenarios.named_christmas_set = {
      description: 'A set promised to today\'s customer. Referenced by '
        + 'rental_set_id, line_kind seasonal_set, and carrying NO quantity: '
        + 'a set is an asset, not stock, and cannot be reserved.',
      request: { location_code: 'car_a', work_date: DAYS.christmas },
      response: await plan('car_a', DAYS.christmas)
    };
  }

  /* ---- 6. winter replenishment against a vehicle baseline ---- */
  {
    await client.query(
      `insert into public.ns_vehicle_baselines (location_id, material_id, target_qty)
       values ((select id from public.ns_stock_locations where code='car_a'),$1,200)
       on conflict (location_id, material_id) do update set target_qty=200`, [salt]);
    const j = await job(DAYS.winter);
    await measure(j, snow, 1);
    scenarios.winter_replenishment = {
      description: 'A snow day plus a standing vehicle baseline for de-icer. '
        + 'The baseline top-up is its own line with its own reason.',
      request: { location_code: 'car_a', work_date: DAYS.winter },
      response: await plan('car_a', DAYS.winter),
      suggestions: await rpc(`public.ns_next_day_suggestions('car_a',$1::date)`,
        [DAYS.winter])
    };
  }

  /* ---- 7. the same job repeated through the day ---- */
  {
    for (const q of [200, 200, 200]) {
      const j = await job(DAYS.repeated);
      await measure(j, siding, q);
    }
    scenarios.repeated_jobs = {
      description: 'Three identical siding stops. The tool is one decision; '
        + 'the product is three times the per-stop amount.',
      request: { location_code: 'car_a', work_date: DAYS.repeated },
      response: await plan('car_a', DAYS.repeated)
    };
  }

  /* ---- 8. optional Car B ---- */
  {
    await client.query(
      `insert into public.ns_stock_locations (code,name,kind,sort_order)
       values ('car_b','Car B','vehicle',2) on conflict do nothing`);
    const assigned = await job(DAYS.carB);
    await measure(assigned, siding, 600);
    await client.query(
      `insert into public.ns_job_vehicle_assignments (job_id, location_id)
       values ($1,(select id from public.ns_stock_locations where code='car_b'))`,
      [assigned]);
    const stray = await job(DAYS.carB);
    await measure(stray, windows, 12);

    scenarios.car_b_assigned = {
      description: 'Car B exists ONLY because this scenario created it; no '
        + 'migration seeds it. Its plan carries the job assigned to it.',
      request: { location_code: 'car_b', work_date: DAYS.carB },
      response: await plan('car_b', DAYS.carB)
    };
    scenarios.car_a_with_unassigned_job = {
      description: 'With two vehicles, a job assigned to NEITHER appears on '
        + 'neither plan and is counted in unassigned_jobs with a note. The '
        + 'ambiguity is reported, never guessed at.',
      request: { location_code: 'car_a', work_date: DAYS.carB },
      response: await plan('car_a', DAYS.carB)
    };
    await client.query(`delete from public.ns_job_vehicle_assignments
      where location_id in (select id from public.ns_stock_locations where code='car_b')`);
    await client.query(`delete from public.ns_load_plan_lines where plan_id in
      (select id from public.ns_load_plans where location_id in
        (select id from public.ns_stock_locations where code='car_b'))`);
    await client.query(`delete from public.ns_load_plans where location_id in
      (select id from public.ns_stock_locations where code='car_b')`);
    await client.query(`delete from public.ns_stock_locations where code='car_b'`);
  }

  /* ---- 9. shortage and incomplete specification ---- */
  {
    await rule(siding, scarce, { kind: 'consumable', fixed: 90 });
    const unknown = await material('FIXTURE unknown allowance',
      { category: 'consumable', unit: 'litre' });
    await rule(siding, unknown, { kind: 'consumable' });
    const j = await job(DAYS.shortage);
    await measure(j, siding, 100);
    scenarios.shortage_and_incomplete = {
      description: 'A product nobody has (shortage_qty > 0, data_state '
        + 'complete: the gap is known) beside one with no recorded allowance '
        + '(data_state needs_review: the amount is unknown). The two are '
        + 'different problems and must not be shown as the same one.',
      request: { location_code: 'car_a', work_date: DAYS.shortage },
      response: await plan('car_a', DAYS.shortage),
      suggestions: await rpc(`public.ns_next_day_suggestions('car_a',$1::date)`,
        [DAYS.shortage])
    };
    await client.query(`delete from public.ns_service_load_rules
                         where material_id in ($1,$2)`, [scarce, unknown]);
  }

  /* ---- 10. a late schedule change makes confirmation stale ---- */
  {
    const j = await job(DAYS.lateChange);
    await measure(j, siding, 500);
    const built = await plan('car_a', DAYS.lateChange);
    const late = await job(DAYS.lateChange);
    await measure(late, siding, 300);

    let conflict = null;
    try {
      await rpc(`public.confirm_load_plan($1,$2,$3,null,null)`,
        [key('conf'), built.plan_id, built.revision]);
    } catch (err) {
      conflict = { code: err.code, message: err.message };
    }
    scenarios.late_schedule_change = {
      description: 'The plan was built, then another stop was added. The '
        + 'revision still matches, so only the basis fingerprint catches it. '
        + 'Confirmation is refused with 23514 and the reason.',
      request: { plan_id: '<plan_id>', expected_revision: built.revision },
      plan_before_change: built,
      conflict
    };
  }

  /* ---- 11. permission failures ---- */
  {
    await client.query(
      `insert into public.ns_crew_members (user_id,role,vehicle_location_id,display_name)
       values ($1,'crew',(select id from public.ns_stock_locations where code='car_a'),'FIXTURE crew')
       on conflict (user_id) do update set role='crew', active=true`, [crew]);
    await client.query(`select set_config('nova.actor_id',$1,false)`, [crew]);
    const failures = {};
    for (const [name, sql, params] of [
      ['build_load_plan', `public.build_load_plan($1,'car_a',$2::date,null)`,
        [key('p'), DAYS.siding]],
      ['authorise_load_exception',
        `public.authorise_load_exception($1,'car_a',$2::date,'skip_required','no room',$3,null)`,
        [key('e'), DAYS.siding, washer]]
    ]) {
      try { await rpc(sql, params); failures[name] = null; }
      catch (err) { failures[name] = { code: err.code, message: err.message }; }
    }
    await client.query(`select set_config('nova.actor_id',$1,false)`, [owner]);
    scenarios.crew_permission_failures = {
      description: 'What a crew gets when it tries an owner-only call. Both '
        + 'are 42501 and both carry a sentence explaining the split.',
      failures
    };
  }

  /* ---- 12. a duplicate retry ---- */
  {
    const dup = key('dup');
    const first = await rpc(`public.build_load_plan($1,'car_a',$2::date,null)`,
      [dup, DAYS.siding]);
    const second = await rpc(`public.build_load_plan($1,'car_a',$2::date,null)`,
      [dup, DAYS.siding]);
    scenarios.duplicate_retry = {
      description: 'The same operation key twice. The second call returns the '
        + 'first result with replayed true and creates no second revision — '
        + 'which is what a lost response looks like from the client side.',
      first_replayed: first.replayed,
      second_replayed: second.replayed,
      same_plan: first.plan_id === second.plan_id,
      same_revision: first.revision === second.revision,
      response: second
    };
  }

  await client.end();

  const out = {
    contract: 'daily-load-contract-v1',
    generated_by: 'tests/fixtures/build-daily-load-fixtures.mjs',
    note: 'Generated by running the real backend on a disposable database. '
      + 'Regenerate after any contract change; the diff IS the change. '
      + 'Ids and timestamps are replaced with stable placeholders so two '
      + 'runs produce identical files. No live database was touched and no '
      + 'real customer, address or supplier product appears here.',
    scenarios: normalise(scenarios)
  };

  mkdirSync(HERE, { recursive: true });
  const path = join(HERE, 'daily-load-v1.json');
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote ${path}`);
  console.log(`${Object.keys(scenarios).length} scenarios`);
})().catch((err) => { console.error(err); process.exit(1); });
