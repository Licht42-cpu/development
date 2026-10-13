// Builds the dispatch fixture set that Batch 12.2 implements against, by
// running the REAL backend on a disposable database and writing down what
// it returned.
//
//   node tests/db/setup-test-db.mjs
//   node tests/fixtures/build-dispatch-fixtures.mjs
//
// WHY GENERATED AND NOT HAND-WRITTEN. A hand-written fixture is somebody's
// idea of what the contract says. These are what the contract actually
// produced, so they cannot drift from it: regenerate after any change and
// the diff is the contract change.
//
// DETERMINISTIC. Fixed dates, fixed names, fixed operation keys, ids
// replaced with stable placeholders and the session timezone pinned to UTC,
// so two runs on two machines produce byte-identical files.
//
// WHAT THESE FIXTURES ARE NOT. They do not establish authorisation (a
// fixture cannot refuse anything), they are not integration, and nothing in
// here is a real message: every provider outcome is recorded by a double.
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
  '20261013100000_batch11_1_completion_and_evidence.sql',
  '20261013110000_batch11_1_completion_operations.sql',
  '20261014090000_batch10_1_corrective_load_contract.sql',
  '20261015090000_batch10_1_corrective_day_boundary_and_lock.sql',
  '20261016090000_batch12_1_dispatch_day_and_order.sql',
  '20261016100000_batch12_1_property_access_and_zones.sql',
  '20261016110000_batch12_1_job_issues_and_notifications.sql',
  '20261016120000_batch12_1_conflicts_stages_and_winter.sql'
];

const FIXTURES = ['fixture-schema.sql', 'fixture-schema-batch8-1.sql',
  'fixture-schema-batch9-1.sql', 'fixture-schema-batch10-1.sql',
  'fixture-schema-batch11-1.sql', 'fixture-schema-batch12-1.sql'];

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

/* Kept verbatim: derived from a fixed date and a fixed zone, and the point
   of the operating-day fields is to be comparable. */
const KEPT_TIMESTAMP_KEYS = new Set(['window_starts_at', 'window_ends_at']);

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
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
      return KEPT_TIMESTAMP_KEYS.has(keyHint) ? value : '<timestamp>';
    }
    if (/^[0-9a-f]{32}$/.test(value)) return '<fingerprint>';
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
  const crewA = (await one('insert into auth.users default values returning id')).id;
  const crewB = (await one('insert into auth.users default values returning id')).id;
  await client.query(`select set_config('nova.is_admin','on',false)`);
  const be = (u) => client.query(`select set_config('nova.actor_id',$1,false)`, [u]);
  await be(owner);

  const supplier = (await one('select id from public.ns_suppliers limit 1')).id;
  const cust = (await one(
    `insert into public.customers (name, phone, email)
     values ('FIXTURE Dispatch Customer','+15550100','fixture@example.invalid')
     returning id`)).id;

  const property = async (over = {}) => (await one(
    `insert into public.properties
       (customer_id, address_line1, city, access_note, latitude, longitude)
     values ($1,$2,'Fixtureville',$3,$4,$5) returning id`,
    [cust, over.address || '1 FIXTURE Lane', over.accessNote ?? 'Side gate, unlatched',
     over.lat ?? null, over.lng ?? null])).id;

  const material = async (name, over = {}) => (await one(
    `insert into public.ns_materials
       (name,category,unit,supplier_id,pack_quantity,reorder_point,reorder_qty,tracking_mode)
     values ($1,$2,$3,$4,1,0,0,'quantity') returning id`,
    [name, over.category || 'tool', over.unit || 'each', supplier])).id;

  const service = async (sk, name) => (await one(
    `insert into public.services (key,name,unit) values ($1,$2,'sq_ft')
     on conflict (key) do update set name=excluded.name returning id`, [sk, name])).id;

  const job = async (when, over = {}) => (await one(
    `insert into public.ns_jobs (customer_id, property_id, scheduled_for, status)
     values ($1,$2,$3,'scheduled') returning id`,
    [cust, over.property ?? null, when])).id;

  const measure = (j, s, q) => client.query(
    `insert into public.job_measurements (job_id, service_id, quantity, unit)
     values ($1,$2,$3,'sq_ft')`, [j, s, q]);

  const rule = (s, m) => client.query(
    `insert into public.ns_service_load_rules
       (service_id, material_id, rule_kind, allowance_state, removable, always_keep)
     values ($1,$2,'equipment','reviewed',false,false)
     on conflict (service_id, material_id) do nothing`, [s, m]);

  const receive = (m, q, loc = 'base') => rpc(
    `public.post_stock_movement($1,$2,$3,$4,'received',null,null,null,null,'usable','exact')`,
    [key('rcv'), m, loc, q]);

  const refusal = (err) => ({
    refused: true, sqlstate: err.code,
    message: err.message.replace(UUID_IN_TEXT, '<uuid>')
  });
  const tryRpc = async (sql, p) => {
    try { return await rpc(sql, p); } catch (e) { return refusal(e); }
  };
  const tryQuery = async (sql, p) => {
    try { await client.query(sql, p); return { refused: false }; }
    catch (e) { return refusal(e); }
  };

  const carB = async () => {
    await client.query(
      `insert into public.ns_stock_locations (code,name,kind,sort_order)
       values ('car_b','Car B','vehicle',2) on conflict do nothing`);
    await client.query(
      `update public.ns_stock_locations set active=true where code='car_b'`);
  };
  const crewFor = (user, code) => client.query(
    `insert into public.ns_crew_members (user_id,role,vehicle_location_id,display_name)
     values ($1,'crew',(select id from public.ns_stock_locations where code=$2),'FIXTURE crew')
     on conflict (user_id) do update set role='crew', active=true,
       vehicle_location_id=(select id from public.ns_stock_locations where code=$2)`,
    [user, code]);

  const siding = await service('siding_soft_wash', 'Siding Soft Washing');
  const windows = await service('window_cleaning', 'Window Cleaning');
  const winter = await service('winter_property_care', 'Winter Property Care');
  const winterDeck = await service('winter_property_care_deck',
    'Winter Property Care - Deck');

  const washer = await material('FIXTURE pressure washer');
  const ladder = await material('FIXTURE extension ladder');
  await rule(siding, washer);
  await rule(windows, ladder);
  await receive(washer, 1);
  await receive(ladder, 2);

  const scenarios = {};

  /* ---- 1. one car: the day is the day ---- */
  {
    const day = '2027-08-02';
    const p1 = await property({ address: '1 FIXTURE Lane', lat: 53.5, lng: -113.5 });
    const first = await job(`${day}T09:00:00Z`, { property: p1 });
    const second = await job(`${day}T13:00:00Z`, { property: p1 });
    await measure(first, siding, 100);
    await measure(second, windows, 20);

    const derived = await rpc(`public.get_dispatch_day('car_a',$1::date)`, [day]);
    const ordered = await rpc(
      `public.reorder_dispatch_day($1,'car_a',$2::date,$3::uuid[],$4)`,
      [key('ord'), day, [second, first], derived.revision]);
    const after = await rpc(`public.get_dispatch_day('car_a',$1::date)`, [day]);

    scenarios.one_car_default_and_manual_order = {
      description: 'With ONE active vehicle the day is simply the day: an '
        + 'unassigned job is reported with `assigned: false` and belongs to '
        + 'that car by the one-vehicle rule, which is a different fact from '
        + 'an explicit assignment. Before anybody reorders, every stop\'s '
        + '`order_state` is "derived" and its `position` is null -- the read '
        + 'says the order is a consequence of the times rather than '
        + 'implying somebody chose it. The operating-day window is the same '
        + 'one the load contract publishes (v2.1 §2a), from the same '
        + 'function, so the two screens cannot disagree about which visits '
        + 'are today.',
      read_before_any_edit: derived,
      reorder_receipt: ordered,
      read_after: after
    };
  }

  /* ---- 2. two cars: unassigned belongs to neither ---- */
  {
    await carB();
    const day = '2027-08-03';
    const loose = await job(`${day}T10:00:00Z`);
    const mine = await job(`${day}T11:00:00Z`);
    await measure(loose, siding, 50);
    await measure(mine, siding, 60);
    const assigned = await rpc(
      `public.assign_job_to_vehicle($1,$2,'car_a',null,'owner picked Car A')`,
      [key('asg'), mine]);

    scenarios.two_cars_and_unassigned_work = {
      description: 'With TWO active vehicles an unassigned job belongs to '
        + 'NEITHER plan and is reported in `unassigned_jobs` on both '
        + 'screens. Guessing a car is how a crew arrives without the kit, '
        + 'so nothing guesses. An explicit assignment moves the job onto '
        + 'exactly one day: ns_job_vehicle_assignments is keyed by job_id, '
        + 'so one job on two cars is structurally impossible rather than a '
        + 'rule somebody remembered.',
      assignment_receipt: assigned,
      car_a: await rpc(`public.get_dispatch_day('car_a',$1::date)`, [day]),
      car_b: await rpc(`public.get_dispatch_day('car_b',$1::date)`, [day])
    };
  }

  /* ---- 3. stale revisions and concurrent edits ---- */
  {
    const day = '2027-08-04';
    const a = await job(`${day}T09:00:00Z`);
    const b = await job(`${day}T10:00:00Z`);
    await measure(a, siding, 100); await measure(b, windows, 10);
    await rpc(`public.assign_job_to_vehicle($1,$2,'car_a',null,'setup')`, [key('asg'), a]);
    await rpc(`public.assign_job_to_vehicle($1,$2,'car_a',null,'setup')`, [key('asg'), b]);

    const read = await rpc(`public.get_dispatch_day('car_a',$1::date)`, [day]);
    const ok = await rpc(
      `public.reorder_dispatch_day($1,'car_a',$2::date,$3::uuid[],$4)`,
      [key('ord'), day, [b, a], read.revision]);
    // The second editor was looking at the revision the first one replaced.
    const stale = await tryRpc(
      `public.reorder_dispatch_day($1,'car_a',$2::date,$3::uuid[],$4)`,
      [key('ord'), day, [a, b], read.revision]);
    const dropped = await tryRpc(
      `public.reorder_dispatch_day($1,'car_a',$2::date,$3::uuid[],$4)`,
      [key('ord'), day, [a], ok.revision]);

    const retryKey = key('ord');
    const firstTry = await rpc(
      `public.reorder_dispatch_day($1,'car_a',$2::date,$3::uuid[],$4)`,
      [retryKey, day, [a, b], ok.revision]);
    const sameKey = await rpc(
      `public.reorder_dispatch_day($1,'car_a',$2::date,$3::uuid[],$4)`,
      [retryKey, day, [a, b], ok.revision]);
    const changedIntent = await tryRpc(
      `public.reorder_dispatch_day($1,'car_a',$2::date,$3::uuid[],$4)`,
      [retryKey, day, [b, a], firstTry.revision]);

    scenarios.stale_revision_and_concurrent_edits = {
      description: 'Every planning mutation quotes the revision the screen '
        + 'was SHOWN. A second editor working from the revision the first '
        + 'one replaced is refused with the current number (23514) rather '
        + 'than applied on top of somebody else\'s edit. An order that '
        + 'LEAVES OUT one of the day\'s jobs is refused too: a screen built '
        + 'from a stale read would otherwise silently drop the stop it had '
        + 'not seen, and the drop would look like a decision. Retries are '
        + 'per operation: the same key with the same intent returns the '
        + 'stored receipt with `replayed: true` and creates no second '
        + 'revision; the same key with a DIFFERENT order is 23505.',
      accepted: ok,
      stale_revision: stale,
      order_that_drops_a_stop: dropped,
      retry_same_key: { first: firstTry, again: sameKey, changed_intent: changedIntent }
    };
  }

  /* ---- 4. shared equipment, and a stale load confirmation ---- */
  {
    const day = '2027-08-05';
    const jobA = await job(`${day}T09:00:00Z`);
    const jobB = await job(`${day}T10:00:00Z`);
    await measure(jobA, siding, 100);
    await measure(jobB, siding, 100);
    await rpc(`public.assign_job_to_vehicle($1,$2,'car_a',null,'setup')`, [key('asg'), jobA]);
    await rpc(`public.assign_job_to_vehicle($1,$2,'car_b',null,'setup')`, [key('asg'), jobB]);

    const mystery = await material('FIXTURE never-counted tool');
    await rule(windows, mystery);
    const windowsJob = await job(`${day}T15:00:00Z`);
    await measure(windowsJob, windows, 10);
    await rpc(`public.assign_job_to_vehicle($1,$2,'car_a',null,'setup')`,
      [key('asg'), windowsJob]);

    const conflicts = await rpc(`public.dispatch_equipment_conflicts($1::date)`, [day]);

    // A load plan built BEFORE a dispatch edit cannot be confirmed after it.
    const plan = await rpc(`public.build_load_plan($1,'car_a',$2::date,null)`,
      [key('plan'), day]);
    const moved = await rpc(
      `public.assign_job_to_vehicle($1,$2,'car_b',null,'Car A is full')`,
      [key('asg'), windowsJob]);
    const lateConfirm = await tryRpc(
      `public.confirm_load_plan($1,$2,$3,$4,null,$5)`,
      [key('conf'), plan.plan_id, plan.revision, plan.basis_fingerprint,
       plan.lines_fingerprint]);
    const dayAfter = await rpc(`public.get_dispatch_day('car_a',$1::date)`, [day]);

    scenarios.shared_equipment_and_stale_load_confirmation = {
      description: 'A conflict is a WHOLE-DAY fact: a washer wanted at '
        + 'three stops on one car is one requirement, not three, and two '
        + 'cars wanting the only one is `shared_scarce`. Unknown is never '
        + 'zero -- a material nobody has ever counted reports '
        + '`usable_at_base: null` and `missing_data`, because the stock view '
        + 'coalesces to 0 and reading that as "none" would be a lie. '
        + 'Looking transfers, reserves, buys and consumes nothing. '
        + 'Separately: a dispatch edit INVALIDATES the affected load plans, '
        + 'so a confirmation of a plan built before the edit is refused '
        + '(23514) instead of loading for a day that no longer exists. The '
        + 'read reports `needs_rebuild`; rebuilding is owner-only and moves '
        + 'no stock.',
      conflicts,
      plan_built_before_the_edit: {
        plan_id: plan.plan_id, revision: plan.revision, status: plan.status
      },
      reassignment_receipt: moved,
      confirmation_after_the_edit: lateConfirm,
      day_read_after: dayAfter.load_plan
    };
  }

  /* ---- 5. seasonal stages, with no fabricated physical move ---- */
  {
    const day = '2027-11-18';
    const p = await property({ address: '5 FIXTURE Crescent' });
    const j = await job(`${day}T09:00:00Z`, { property: p });
    await measure(j, siding, 10);
    await rpc(`public.assign_job_to_vehicle($1,$2,'car_a',null,'setup')`, [key('asg'), j]);

    const reg = await rpc(
      `public.register_seasonal_set($1,'FIXTURE-SET-12','C9','warm_white',30,
         'base',null,null,'fixture')`, [key('set')]);
    const setId = reg.set.set_id;
    await rpc(`public.inspect_seasonal_set($1,$2,'usable','fixture check')`,
      [key('insp'), setId]);
    const assignment = await rpc(
      `public.assign_seasonal_set($1,$2,$3,2027,$4,$5,'fixture')`,
      [key('seas'), setId, cust, p, j]);

    const promised = await all(
      `select * from public.ns_dispatch_seasonal_work where job_id=$1`, [j]);
    await rpc(`public.install_seasonal_set($1,$2,null,null,'installed on site')`,
      [key('seas'), assignment.assignment.assignment_id]);
    const installed = await all(
      `select * from public.ns_dispatch_seasonal_work where job_id=$1`, [j]);

    scenarios.seasonal_stages_without_a_fabricated_move = {
      description: 'Installation, recovery, inspection, release and renewal '
        + 'are FIVE separate owner acts with their own RPCs (Batch 9.1, '
        + 'corrected in 11.1). Dispatch does not wrap them: `stage` here is '
        + 'a LABEL for a screen, and moving a dispatch stage invokes none of '
        + 'them. The two facts that get conflated are reported separately: '
        + '`promised_to_a_customer` is a commercial assignment and '
        + '`aboard_a_vehicle` / `physically_installed` are where the thing '
        + 'actually is. A set promised for today is NOT thereby aboard the '
        + 'car, and company-owned lights never become the customer\'s.',
      assignment_receipt: assignment,
      while_promised: promised,
      after_the_owner_installed_it: installed
    };
  }

  /* ---- 6. winter work the owner triggers ---- */
  {
    const p = await property({ address: '9 FIXTURE Crescent' });
    const walk = await job('2027-12-01T08:00:00Z', { property: p });
    const deck = await job('2027-12-01T09:00:00Z', { property: p });
    await measure(walk, winter, 1);
    await measure(deck, winterDeck, 1);

    const candidates = await rpc(
      `public.ns_winter_dispatch_candidates($1::date)`, ['2027-12-09']);
    const sent = await rpc(
      `public.dispatch_winter_visit($1,$2,'car_a',$3::timestamptz,
         '18cm overnight; owner decision')`,
      [key('win'), walk, '2027-12-09T07:00:00Z']);
    const duplicate = await tryRpc(
      `public.dispatch_winter_visit($1,$2,'car_a',$3::timestamptz,'deck as well')`,
      [key('win'), deck, '2027-12-09T09:00:00Z']);

    scenarios.owner_triggered_winter_visit = {
      description: 'No snowfall threshold, forecast source, visit allowance '
        + 'or salt dosage exists, and none is invented: the automation state '
        + 'reports every one of them as `unconfigured` and the mode as '
        + '`owner_triggered`. The owner sends an EXISTING winter job out '
        + 'with a stated reason -- the reason is the record of the decision '
        + 'that a weather rule would otherwise have made. Walkway and deck '
        + 'variants are ONE visit: the candidate read groups them on one row '
        + 'per property, and a second dispatch to the same property on the '
        + 'same day is refused (23505) so one trip out cannot become two '
        + 'dispatches and two minimums. No job and no minimum is created.',
      automation_state: await rpc(`public.ns_winter_automation_state()`),
      candidates,
      dispatched: sent,
      second_visit_same_property_same_day: duplicate
    };
  }

  /* ---- 7. property instructions, coordinates and the private code ---- */
  {
    const withCoords = await property({ address: '11 FIXTURE Lane', lat: 53.4, lng: -113.4 });
    const without = await property({ address: '12 FIXTURE Lane', accessNote: null });
    const j = await job('2027-08-10T09:00:00Z', { property: withCoords });
    await measure(j, siding, 100);
    await rpc(`public.assign_job_to_vehicle($1,$2,'car_a',null,'setup')`, [key('asg'), j]);

    const saved = await rpc(
      `public.set_property_access($1,$2,'Round the back','Dog after 4pm',
         'On the pad','Invoice by email','4821','We will text on the way',0)`,
      [key('acc'), withCoords]);
    const zone = await rpc(
      `public.save_property_work_zone($1,$2,'Back lawn','work_area','geographic',
         $3::jsonb,null,'mind the sprinklers',null,null)`,
      [key('zone'), withCoords, JSON.stringify([
        { lat: 53.4, lng: -113.4 }, { lat: 53.4001, lng: -113.4 },
        { lat: 53.4001, lng: -113.3999 }])]);
    const imageZone = await rpc(
      `public.save_property_work_zone($1,$2,'Steep section','hazard','image',
         $3::jsonb,'site-visit/front.jpg','from the site visit',null,null)`,
      [key('zone'), withCoords, JSON.stringify([
        { x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.6 }])]);
    const tooFew = await tryRpc(
      `public.save_property_work_zone($1,$2,'Line','work_area','geographic',
         $3::jsonb,null,null,null,null)`,
      [key('zone'), withCoords, JSON.stringify([
        { lat: 53.4, lng: -113.4 }, { lat: 53.5, lng: -113.4 }])]);
    const imageNoSource = await tryRpc(
      `public.save_property_work_zone($1,$2,'Sketch','work_area','image',
         $3::jsonb,null,null,null,null)`,
      [key('zone'), withCoords, JSON.stringify([
        { x: 0.1, y: 0.1 }, { x: 0.9, y: 0.1 }, { x: 0.9, y: 0.9 }])]);

    const asOwner = await rpc(`public.get_property_access($1)`, [withCoords]);
    const noCoords = await rpc(`public.get_property_access($1)`, [without]);

    await crewFor(crewA, 'car_a');
    await crewFor(crewB, 'car_b');
    await be(crewA);
    const crewWithWork = await rpc(`public.get_property_access($1)`, [withCoords]);
    await be(crewB);
    const crewWithoutWork = await tryRpc(`public.get_property_access($1)`, [withCoords]);
    await be(owner);

    /* NOT an attempted read. This generator connects as the table OWNER,
       who bypasses column grants, so a successful select here would prove
       nothing at all -- it is the trap the 9.1 corrective hit. What is
       asserted is the GRANT, through has_column_privilege, which is what
       actually governs a PostgREST client. */
    const columnGrants = await one(
      `select
         has_column_privilege('authenticated','public.ns_property_access',
                              'access_code','select')  as authenticated_access_code,
         has_column_privilege('authenticated','public.ns_property_access',
                              'internal_note','select') as authenticated_internal_note,
         has_column_privilege('authenticated','public.ns_property_access',
                              'entrance_note','select') as authenticated_entrance_note,
         has_column_privilege('anon','public.ns_property_access',
                              'access_code','select')   as anon_access_code`);

    scenarios.property_instructions_and_private_codes = {
      description: 'properties.access_note is NOT duplicated: it is read '
        + 'from where it already lives and the field console already uses '
        + 'it. What this adds is the hazard and the parking as their own '
        + 'sentences, an internal note and an access CODE that are never '
        + 'the customer\'s, and the one customer-facing sentence. '
        + 'AUTHORISATION IS NOT A UI FILTER: `access_code` and '
        + '`internal_note` have no column-level SELECT for `authenticated` '
        + 'at all, so the only read path is get_property_access(), which '
        + 'refuses a crew with no work at that property (42501). Missing '
        + 'coordinates stay missing -- no default pin, no city centre, no '
        + 'guessed entrance. A zone is a drawing in a DECLARED space: '
        + 'geographic lat/lng or 0..1 fractions of a named image, three '
        + 'points minimum, never a surveyed boundary and never a geofence.',
      access_receipt_does_not_echo_the_code: saved,
      owner_read: asOwner,
      property_with_no_coordinates: noCoords,
      zones: { geographic: zone, on_an_image: imageZone,
               two_points_is_a_line: tooFew,
               image_without_its_image: imageNoSource },
      crew_with_work_at_the_property: crewWithWork,
      crew_without_work_at_the_property: crewWithoutWork,
      column_grants: {
        note: 'has_column_privilege, not an attempted select: this '
              + 'generator runs as the table owner, who bypasses grants.',
        ...columnGrants
      }
    };
  }

  /* ---- 8. blocked, broken, finished -- and none of them completed ---- */
  {
    const blockedJob = await job('2027-08-12T09:00:00Z');
    const brokenJob = await job('2027-08-12T11:00:00Z');
    await measure(blockedJob, siding, 100);
    await measure(brokenJob, siding, 100);
    await rpc(`public.assign_job_to_vehicle($1,$2,'car_a',null,'setup')`,
      [key('asg'), blockedJob]);
    await rpc(`public.assign_job_to_vehicle($1,$2,'car_a',null,'setup')`,
      [key('asg'), brokenJob]);

    await be(crewA);
    const blocked = await rpc(
      `public.report_job_issue($1,$2,'blocked_access','Gate padlocked, nobody home',null)`,
      [key('iss'), blockedJob]);
    const broken = await rpc(
      `public.report_job_issue($1,$2,'equipment_breakdown','Washer pump died',$3)`,
      [key('iss'), brokenJob, washer]);
    const finished = await rpc(
      `public.set_dispatch_stage($1,$2,'work_finished','Tools away, site tidy',null)`,
      [key('stg'), brokenJob]);
    const crewSkip = await tryRpc(
      `public.set_dispatch_stage($1,$2,'skipped','not today',null)`,
      [key('stg'), brokenJob]);
    await be(owner);

    const resolved = await rpc(
      `public.resolve_job_issue($1,$2,'resolved','Customer gave us the code')`,
      [key('res'), blocked.issue_id]);
    const twice = await tryRpc(
      `public.resolve_job_issue($1,$2,'work_cancelled','actually no')`,
      [key('res'), blocked.issue_id]);
    const directComplete = await tryQuery(
      `update public.ns_jobs set status='completed' where id=$1`, [brokenJob]);

    scenarios.blocked_broken_and_finished_are_not_completed = {
      description: 'FIVE states that must never collapse into one another: '
        + 'cancelled (commercial, on the job), skipped (the owner\'s), '
        + 'blocked (the crew went and could not get in), work_finished (the '
        + 'crew downed tools) and accepted_completed (the SERVER accepted a '
        + 'completion with its evidence, Batch 11.1). A report never changes '
        + 'the job\'s status and never completes or cancels anything, and '
        + 'the receipts say so in `job_status_changed` and '
        + '`completion_recorded`. A blocked-access report blocks the stop, '
        + 'because that is what the crew is saying; a breakdown does not, '
        + 'because a broken washer does not necessarily stop the visit. '
        + 'Resolving is the owner\'s, reasoned, and recorded once. 11.1\'s '
        + 'gate is still the only way to complete: a direct '
        + 'status=\'completed\' is refused.',
      blocked_report: blocked,
      breakdown_report: broken,
      work_finished: finished,
      crew_cannot_skip: crewSkip,
      resolution: resolved,
      second_resolution: twice,
      direct_status_completed: directComplete,
      // Ordered by the STATE, not by a random uuid, so two runs agree.
      states_side_by_side: await all(
        `select * from public.ns_job_dispatch_status where job_id = any($1::uuid[])
          order by dispatch_state, job_status`, [[blockedJob, brokenJob]])
    };
  }

  /* ---- 9. the two customer messages, and five outcomes ---- */
  {
    const noProviderJob = await job('2027-08-14T09:00:00Z');
    await measure(noProviderJob, siding, 100);
    await rpc(`public.assign_job_to_vehicle($1,$2,'car_a',null,'setup')`,
      [key('asg'), noProviderJob]);
    // Before any provider is configured.
    const unavailable = await rpc(
      `public.request_job_notification($1,$2,'on_the_way','sms')`,
      [key('nt'), noProviderJob]);

    await client.query(
      `insert into public.app_settings (key, value)
       values ('notifications', jsonb_build_object('sms_provider','fixture-double'))
       on conflict (key) do update set value = excluded.value`);

    const noContactCust = (await one(
      `insert into public.customers (name) values ('FIXTURE No Contact') returning id`)).id;
    const noContactJob = (await one(
      `insert into public.ns_jobs (customer_id, scheduled_for, status)
       values ($1,'2027-08-14T10:00:00Z','scheduled') returning id`, [noContactCust])).id;
    await measure(noContactJob, siding, 100);
    await rpc(`public.assign_job_to_vehicle($1,$2,'car_a',null,'setup')`,
      [key('asg'), noContactJob]);
    const noContact = await rpc(
      `public.request_job_notification($1,$2,'on_the_way','sms')`,
      [key('nt'), noContactJob]);

    const liveJob = await job('2027-08-14T13:00:00Z');
    await measure(liveJob, siding, 100);
    await rpc(`public.assign_job_to_vehicle($1,$2,'car_a',null,'setup')`,
      [key('asg'), liveJob]);

    await be(crewA);
    const retryKey = key('nt');
    const accepted = await rpc(
      `public.request_job_notification($1,$2,'on_the_way','sms')`, [retryKey, liveJob]);
    const sameKey = await rpc(
      `public.request_job_notification($1,$2,'on_the_way','sms')`, [retryKey, liveJob]);
    const changedIntent = await tryRpc(
      `public.request_job_notification($1,$2,'access_request','sms')`,
      [retryKey, liveJob]);
    const duplicate = await tryRpc(
      `public.request_job_notification($1,$2,'on_the_way','sms')`, [key('nt'), liveJob]);
    const crewOutcome = await tryRpc(
      `public.record_notification_outcome($1,'delivered','fixture-1',null)`,
      [accepted.request_id]);
    await be(owner);

    const unknown = await rpc(
      `public.record_notification_outcome($1,'unknown',null,'provider timed out')`,
      [accepted.request_id]);
    const blockedByUnknown = await tryRpc(
      `public.request_job_notification($1,$2,'on_the_way','sms')`, [key('nt'), liveJob]);
    const delivered = await rpc(
      `public.record_notification_outcome($1,'delivered','fixture-msg-1',null)`,
      [accepted.request_id]);

    const failJob = await job('2027-08-14T15:00:00Z');
    await measure(failJob, siding, 100);
    await rpc(`public.assign_job_to_vehicle($1,$2,'car_a',null,'setup')`,
      [key('asg'), failJob]);
    const toFail = await rpc(
      `public.request_job_notification($1,$2,'access_request','sms')`,
      [key('nt'), failJob]);
    const failed = await rpc(
      `public.record_notification_outcome($1,'provider_failed',null,'unroutable number')`,
      [toFail.request_id]);
    const retryAfterFailure = await rpc(
      `public.request_job_notification($1,$2,'access_request','sms')`,
      [key('nt'), failJob]);

    scenarios.notification_outcomes = {
      description: 'Two deliberate crew actions through the EXISTING '
        + 'notifications table. Nothing sends on opening a screen, changing '
        + 'a route or reading a location: there is no trigger and no '
        + 'scheduler. FIVE outcomes, four of which are not a successful '
        + 'send -- `accepted` (recorded and queued), `delivered`, '
        + '`provider_failed`, `unknown` (we asked and do not know, which is '
        + 'NOT success) and `unavailable` (no provider configured, or no '
        + 'number on file: two different reasons fixed by different people). '
        + 'The recipient is resolved from the JOB\'s customer and is never '
        + 'read back -- the reads report `recipient_known` instead. One live '
        + 'request per job per kind, so two "on the way" texts for one visit '
        + 'is a conflict. THE HONEST RETRY RULE: `unknown` stays live and '
        + 'keeps blocking a second request, because the provider may have '
        + 'neither idempotency nor an outcome lookup and a retry might be '
        + 'the customer\'s second identical text; clearing it is a human '
        + 'decision. A `provider_failed` request no longer blocks a '
        + 'deliberate retry. No message payload ever carries an access code.',
      no_provider_configured: unavailable,
      provider_but_no_number_on_file: noContact,
      accepted: accepted,
      same_key_again: sameKey,
      same_key_changed_intent: changedIntent,
      second_live_request: duplicate,
      crew_cannot_record_an_outcome: crewOutcome,
      unknown_outcome: unknown,
      request_while_unknown_is_live: blockedByUnknown,
      delivered_outcome: delivered,
      provider_failure: failed,
      deliberate_retry_after_failure: retryAfterFailure,
      queued_rows: await all(
        `select kind, channel, status, sent_at is not null as marked_sent,
                payload ? 'access_code' as payload_has_a_code
           from public.notifications order by created_at`),
      job_view: await rpc(`public.job_notification_requests($1)`, [liveJob])
    };
  }

  await client.end();

  const out = {
    contract: 'dispatch-contract-v1',
    generated_by: 'tests/fixtures/build-dispatch-fixtures.mjs',
    note: 'Generated by running the real backend on a disposable database. '
      + 'Regenerate after any contract change; the diff IS the change. Ids '
      + 'and timestamps are replaced with stable placeholders so two runs '
      + 'produce identical files. No live database was touched, no provider '
      + 'was configured beyond a name in settings, and no message was sent. '
      + 'No real customer, address or supplier product appears here.',
    scenarios: normalise(scenarios)
  };

  mkdirSync(HERE, { recursive: true });
  const path = join(HERE, 'dispatch-v1.json');
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote ${path}`);
  console.log(`${Object.keys(scenarios).length} scenarios`);
})().catch((err) => { console.error(err); process.exit(1); });
