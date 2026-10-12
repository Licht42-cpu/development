// Builds the versioned daily-load fixture set that Batch 10.2 implements
// against, by running the REAL backend on a disposable database and writing
// down what it returned.
//
// v2 (the 10.1 corrective). Codex's review of 1ffafc2 pointed out that
// `duplicate_retry` exercised plan BUILDING and nothing else, so the
// replay guarantees the contract promised for confirmation, Manual Keep,
// exceptions and day closing had no fixture behind them at all. There are
// now operation-specific retry scenarios, plus the frozen read envelope,
// Keep -> clear, the damaged-variance reconciliation and the
// exception-affects-transfer case.
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
  '20261011111000_batch10_1_load_operations.sql',
  '20261012090000_batch9_1_corrective_seasonal_review.sql',
  '20261013090000_batch11_1_seasonal_corrective_round_two.sql',
  '20261014090000_batch10_1_corrective_load_contract.sql'
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
// The anchored form above tests a WHOLE value; this one finds uuids INSIDE
// prose, which is where they turn up in an error message. Using the anchored
// pattern for that silently replaces nothing -- which is how a fixture stops
// being deterministic without anyone noticing.
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

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
  const all = async (sql, p) => (await client.query(sql, p)).rows;
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
        `public.authorise_load_exception($1,'car_a',$2::date,'skip_required','no room',$3,null,null)`,
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


  /* =================================================================== */
  /* v2: the 10.1 corrective's scenarios.                                */
  /*                                                                     */
  /* Codex's review of 1ffafc2 pointed out that `duplicate_retry` above  */
  /* exercises plan BUILDING and nothing else, so the replay guarantees   */
  /* the contract promised for the four mutations had no fixture behind   */
  /* them. These are those, plus the frozen read envelope and the three   */
  /* behavioural fixes.                                                   */
  /* =================================================================== */

  /* Scenario 11 creates Car B and then deletes it again, to prove the
     one-vehicle rule in isolation. The v2 scenarios need a second vehicle
     to exercise scope, so they make their own. Still a FIXTURE: Car B is
     never seeded into the real system. */
  await client.query(
    `insert into public.ns_stock_locations (code,name,kind,sort_order)
     values ('car_b','Car B','vehicle',2) on conflict do nothing`);

  const refusal = (err) => ({
    refused: true, sqlstate: err.code,
    message: err.message.replace(UUID_IN_TEXT, '<uuid>')
  });
  const tryRpc = async (sql, params) => {
    try { return await rpc(sql, params); } catch (e) { return refusal(e); }
  };
  const onCarA = async (j) => {
    await client.query(
      `insert into public.ns_job_vehicle_assignments (job_id, location_id)
       values ($1,(select id from public.ns_stock_locations where code='car_a'))
       on conflict (job_id) do update set location_id = excluded.location_id`, [j]);
    return j;
  };

  /* ---- 13. the frozen read envelope (finding 1) ---- */
  {
    const day = '2027-06-01';
    const j = await onCarA(await job(day));
    await measure(j, siding, 900);
    await plan('car_a', day);

    const current = await rpc(`public.get_load_plan('car_a',$1::date)`, [day]);
    const none = await rpc(`public.get_load_plan('car_a','2027-06-30'::date)`, []);

    await client.query(`select set_config('nova.actor_id',$1,false)`, [crew]);
    const asCrew = await rpc(`public.get_load_plan('car_a',$1::date)`, [day]);
    const otherCar = await tryRpc(`public.get_load_plan('car_b',$1::date)`, [day]);
    await client.query(`select set_config('nova.actor_id',$1,false)`, [owner]);

    scenarios.frozen_read_envelope = {
      description: 'get_load_plan() is the contract\'s read path. It returns '
        + 'an ENVELOPE, not a plan: `state` (current | confirmed | closed | '
        + 'none), `can_build` so a crew is told who may build one rather '
        + 'than shown a button that will refuse it, the two counts the old '
        + 'DTO dropped, and the day\'s authorised visits. `state: "none"` is '
        + 'an answer, not an error and not an empty plan.',
      current,
      no_plan_for_that_day: none,
      as_crew_can_build: asCrew.can_build,
      crew_reading_the_other_vehicle: otherCar
    };
  }

  /* ---- 14. a closed day is still readable (finding 1) ---- */
  {
    const day = '2027-06-02';
    const j = await onCarA(await job(day));
    await measure(j, siding, 600);
    await plan('car_a', day);
    await rpc(`public.reconcile_day_end($1,'car_a',$2::date,'[]'::jsonb,'counted')`,
      [key('rec'), day]);
    scenarios.closed_day_is_readable = {
      description: 'The old DTO filtered closed plans out, so last night\'s '
        + 'closing count was unreadable. get_load_plan() returns it with '
        + 'state "closed".',
      read: await rpc(`public.get_load_plan('car_a',$1::date)`, [day])
    };
  }

  /* ---- 15. Keep -> clear -> confirm (finding 2) ---- */
  {
    const day = '2027-06-03';
    await receive(softWash, 1, 'car_a');
    const built = await plan('car_a', day);
    const before = built.lines.find((l) => l.material_id === softWash);

    const kept = await rpc(
      `public.set_manual_keep($1,'car_a',$2::date,$3,true,'rain tomorrow')`,
      [key('keep'), day, softWash]);
    const whileKept = await rpc(`public.get_load_plan('car_a',$1::date)`, [day]);

    const cleared = await rpc(
      `public.set_manual_keep($1,'car_a',$2::date,$3,false,null)`,
      [key('keep'), day, softWash]);
    const afterClear = await rpc(`public.get_load_plan('car_a',$1::date)`, [day]);

    scenarios.manual_keep_clear_restores_recommendation = {
      description: 'Return -> Keep -> clear. Before the corrective, clearing '
        + 'deleted the durable keep but left the line reading "keep" with '
        + 'the "Kept back on purpose" reason and manual_keep false -- a Keep '
        + 'nobody had recommended, which confirmation then skipped. A '
        + 'rebuild would have fixed it, but building is owner-only, so a '
        + 'crew could not undo its own keep. The line now remembers its '
        + 'pre_keep_action and goes back to it.',
      recommended_action: before ? before.action : null,
      keep_receipt: kept,
      line_while_kept: whileKept.plan.lines.find((l) => l.material_id === softWash),
      clear_receipt: cleared,
      line_after_clear: afterClear.plan.lines.find((l) => l.material_id === softWash)
    };
  }

  /* ---- 16. per-operation retries (finding 3) ---- */
  {
    const day = '2027-06-04';
    const j = await onCarA(await job(day));
    await measure(j, siding, 400);
    await receive(softWash, 1, 'car_a');
    const built = await plan('car_a', day);

    // Manual Keep: the same key twice, then a LATE retry after the keep was
    // cleared, which the original re-applied.
    const keepKey = key('keep');
    const keepFirst = await rpc(
      `public.set_manual_keep($1,'car_a',$2::date,$3,true,'rain')`,
      [keepKey, day, softWash]);
    const keepAgain = await rpc(
      `public.set_manual_keep($1,'car_a',$2::date,$3,true,'rain')`,
      [keepKey, day, softWash]);
    await rpc(`public.set_manual_keep($1,'car_a',$2::date,$3,false,null)`,
      [key('keep'), day, softWash]);
    const keepLateRetry = await rpc(
      `public.set_manual_keep($1,'car_a',$2::date,$3,true,'rain')`,
      [keepKey, day, softWash]);
    const keepStillCleared = Number((await one(
      `select count(*)::int as n from public.ns_load_manual_keeps
        where work_date=$1::date and material_id=$2`, [day, softWash])).n);
    const keepChangedIntent = await tryRpc(
      `public.set_manual_keep($1,'car_a',$2::date,$3,true,'a different reason')`,
      [keepKey, day, softWash]);

    // Exception.
    const excKey = key('exc');
    const excFirst = await rpc(
      `public.authorise_load_exception($1,'car_a',$2::date,'skip_required','van is full',$3,null,null)`,
      [excKey, day, washer]);
    const excAgain = await rpc(
      `public.authorise_load_exception($1,'car_a',$2::date,'skip_required','van is full',$3,null,null)`,
      [excKey, day, washer]);
    const excChangedIntent = await tryRpc(
      `public.authorise_load_exception($1,'car_a',$2::date,'skip_required','a different reason',$3,null,null)`,
      [excKey, day, washer]);

    // Confirmation.
    const fresh = await rpc(`public.get_load_plan('car_a',$1::date)`, [day]);
    const confKey = key('conf');
    const confFirst = await rpc(`public.confirm_load_plan($1,$2,$3,$4,null)`,
      [confKey, fresh.plan.plan_id, fresh.plan.revision, fresh.plan.basis_fingerprint]);
    const confAgain = await rpc(`public.confirm_load_plan($1,$2,$3,$4,null)`,
      [confKey, fresh.plan.plan_id, fresh.plan.revision, fresh.plan.basis_fingerprint]);
    const confDuplicateStale = await tryRpc(
      `public.confirm_load_plan($1,$2,$3,$4,null)`,
      [key('conf'), fresh.plan.plan_id, fresh.plan.revision - 1,
       fresh.plan.basis_fingerprint]);

    // Reconciliation, including the cross-vehicle replay the original let
    // through because it returned BEFORE the location check.
    const recKey = key('rec');
    const recFirst = await rpc(
      `public.reconcile_day_end($1,'car_a',$2::date,'[]'::jsonb,'counted')`,
      [recKey, day]);
    const recAgain = await rpc(
      `public.reconcile_day_end($1,'car_a',$2::date,'[]'::jsonb,'counted')`,
      [recKey, day]);
    // Two DIFFERENT cases, and the guard's order is what separates them.
    // (a) the crew replays ITS OWN car's key against another vehicle: the
    //     scope check passes (it can see car_a, where the key was used), so
    //     the payload mismatch is what refuses it -- changed intent, 23505.
    // (b) the crew replays a key belonging to a vehicle it CANNOT see: the
    //     scope check refuses first, 42501, and the caller learns nothing
    //     about what that key was used for. This is the disclosure path the
    //     original left open by returning the receipt before the check.
    await client.query(`select set_config('nova.actor_id',$1,false)`, [crew]);
    const recOwnKeyOtherVehicle = await tryRpc(
      `public.reconcile_day_end($1,'car_b',$2::date,'[]'::jsonb,'counted')`,
      [recKey, day]);
    await client.query(`select set_config('nova.actor_id',$1,false)`, [owner]);
    const carBKey = key('rec');
    await rpc(`public.reconcile_day_end($1,'car_b','2027-06-05'::date,'[]'::jsonb,'owner count')`,
      [carBKey]);
    await client.query(`select set_config('nova.actor_id',$1,false)`, [crew]);
    const recCrossVehicle = await tryRpc(
      `public.reconcile_day_end($1,'car_b','2027-06-05'::date,'[]'::jsonb,'owner count')`,
      [carBKey]);
    await client.query(`select set_config('nova.actor_id',$1,false)`, [owner]);
    const keyKindMismatch = await tryRpc(
      `public.reconcile_day_end($1,'car_a',$2::date,'[]'::jsonb,null)`,
      [keepKey, day]);

    scenarios.per_operation_retries = {
      description: 'What the contract promised in §12 and the SQL did not do. '
        + 'All four mutations now record their key, their intent fingerprint '
        + 'and the receipt they returned, in ns_load_operations; a replay '
        + 'returns those bytes. The guard checks kind, then SCOPE, then '
        + 'intent -- scope before intent so a caller who cannot see the '
        + 'location learns nothing about what the key was used for.',
      manual_keep: {
        first: keepFirst, same_key_again: keepAgain,
        late_retry_after_clear: keepLateRetry,
        durable_keeps_remaining_after_late_retry: keepStillCleared,
        changed_intent: keepChangedIntent
      },
      exception: { first: excFirst, same_key_again: excAgain,
                   changed_intent: excChangedIntent },
      confirmation: { first: confFirst, same_key_again: confAgain,
                      different_key_with_stale_revision: confDuplicateStale },
      reconciliation: {
        first: recFirst, same_key_again: recAgain,
        // scope passes, payload differs -> changed intent
        own_key_against_another_vehicle: recOwnKeyOtherVehicle,
        // scope fails first -> nothing is disclosed about the key
        crew_replaying_a_key_for_a_vehicle_it_cannot_see: recCrossVehicle },
      key_used_for_a_different_kind: keyKindMismatch
    };
  }

  /* ---- 17. the damaged closing variance (finding 5) ---- */
  {
    const day = '2027-06-08';
    const mat = await material('FIXTURE damaged-count product',
      { category: 'consumable', unit: 'litre' });
    await receive(mat, 10, 'car_a');
    const pools = async () => {
      const r = await one(
        `select coalesce(on_hand,0) as usable, coalesce(damaged_on_hand,0) as damaged
           from public.ns_material_stock_by_location
          where material_id=$1 and location_code='car_a'`, [mat]);
      return { usable: Number(r.usable), damaged: Number(r.damaged) };
    };
    const before = await pools();
    const receipt = await rpc(
      `public.reconcile_day_end($1,'car_a',$2::date,$3::jsonb,null)`,
      [key('rec'), day,
       JSON.stringify([{ material_id: mat, counted_qty: 8,
                         variance_reason: 'damaged' }])]);
    const after = await pools();
    const surplusCalledDamaged = await tryRpc(
      `public.reconcile_day_end($1,'car_a','2027-06-09'::date,$2::jsonb,null)`,
      [key('rec'), JSON.stringify([{ material_id: mat, counted_qty: 20,
                                     variance_reason: 'damaged' }])]);

    scenarios.damaged_variance_pools = {
      description: 'THE ACCOUNTING BUG, and the decision behind the fix. The '
        + 'count is of USABLE stock -- that is what a crew counts and what '
        + 'the 8.1 view\'s on_hand means -- and damaged items are RETAINED, '
        + 'not written off. So reason "damaged" is TWO movements: off usable, '
        + 'onto damaged, total on the van unchanged. The original computed '
        + 'the variance against usable and then posted it with condition '
        + '"damaged", leaving usable at 10 and damaged at MINUS 2. A surplus '
        + 'called damaged is refused rather than guessed at.',
      pools_before: before,
      counted: 8,
      pools_after: after,
      movements: await all(
        `select delta, condition, reason from public.ns_material_stock_moves
          where material_id=$1 and reason='adjustment' order by condition`, [mat]),
      receipt,
      surplus_called_damaged: surplusCalledDamaged
    };
  }

  /* ---- 18. an exception that actually affects the load (finding 6) ---- */
  {
    const day = '2027-06-10';
    const skipMat = await material('FIXTURE skip product',
      { category: 'consumable', unit: 'litre' });
    const extraMat = await material('FIXTURE extra product',
      { category: 'consumable', unit: 'litre' });
    await rule(siding, skipMat, { kind: 'consumable', fixed: 5 });
    await receive(skipMat, 100);
    await receive(extraMat, 40);
    const j = await onCarA(await job(day));
    await measure(j, siding, 100);
    const built = await plan('car_a', day);

    const baseOf = async (m) => Number((await one(
      `select coalesce(on_hand,0) as n from public.ns_material_stock_by_location
        where material_id=$1 and location_code='base'`, [m])).n);
    const carOf = async (m) => Number((await one(
      `select coalesce(on_hand,0) as n from public.ns_material_stock_by_location
        where material_id=$1 and location_code='car_a'`, [m])).n);

    const skipBefore = await baseOf(skipMat);
    const skipExc = await rpc(
      `public.authorise_load_exception($1,'car_a',$2::date,'skip_required','already a part jug on the van',$3,null,null)`,
      [key('exc'), day, skipMat]);

    const extraNoQuantity = await tryRpc(
      `public.authorise_load_exception($1,'car_a',$2::date,'carry_extra','spare jug',$3,null,null)`,
      [key('exc'), day, extraMat]);
    const extraExc = await rpc(
      `public.authorise_load_exception($1,'car_a',$2::date,'carry_extra','spare jug',$3,null,6)`,
      [key('exc'), day, extraMat]);

    const read = await rpc(`public.get_load_plan('car_a',$1::date)`, [day]);
    const conf = await rpc(`public.confirm_load_plan($1,$2,$3,$4,null)`,
      [key('conf'), read.plan.plan_id, read.plan.revision,
       read.plan.basis_fingerprint]);

    scenarios.exception_affects_confirmation = {
      description: 'Before the corrective, skip_required and carry_extra were '
        + 'stored, linked to the line, and never read: confirmation '
        + 'transferred the item anyway, so an authorised "go without it" '
        + 'loaded it regardless and an authorised extra could not be carried '
        + 'at all. A skip now sets action to "skip" and confirmation leaves '
        + 'it; a carry_extra for something absent from the plan ADDS a line, '
        + 'and must say how much, because an authorisation with no amount is '
        + 'not something a confirmation can act on.',
      skip_receipt: skipExc,
      skipped_line: read.plan.lines.find((l) => l.material_id === skipMat),
      base_before_confirm: skipBefore,
      base_after_confirm: await baseOf(skipMat),
      carry_extra_without_a_quantity: extraNoQuantity,
      carry_extra_receipt: extraExc,
      added_line: read.plan.lines.find((l) => l.material_id === extraMat),
      confirmation: conf,
      extra_on_the_van_after_confirm: await carOf(extraMat)
    };
  }

  await client.end();

  const out = {
    contract: 'daily-load-contract-v2',
    generated_by: 'tests/fixtures/build-daily-load-fixtures.mjs',
    note: 'Generated by running the real backend on a disposable database. '
      + 'Regenerate after any contract change; the diff IS the change. '
      + 'Ids and timestamps are replaced with stable placeholders so two '
      + 'runs produce identical files. No live database was touched and no '
      + 'real customer, address or supplier product appears here.',
    scenarios: normalise(scenarios)
  };

  mkdirSync(HERE, { recursive: true });
  const path = join(HERE, 'daily-load-v2.json');
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote ${path}`);
  console.log(`${Object.keys(scenarios).length} scenarios`);
})().catch((err) => { console.error(err); process.exit(1); });
