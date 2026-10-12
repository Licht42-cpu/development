// Builds the versioned completion/evidence fixture set that Batch 11.2
// implements against, by running the REAL backend on a disposable database
// and writing down what it returned.
//
//   node tests/db/setup-test-db.mjs
//   node tests/fixtures/build-completion-fixtures.mjs
//
// WHY GENERATED AND NOT HAND-WRITTEN. A hand-written fixture is somebody's
// idea of what the contract says. These are what the contract actually
// produced, so they cannot drift from it: regenerate after any change and
// the diff is the contract change.
//
// WHAT EACH SCENARIO EXERCISES is SERVER ENFORCEMENT, not a UI model. The
// refusals here are real SQLSTATEs raised by the real functions against a
// real PostgreSQL -- a client that handles these eleven cases handles the
// backend, not a mock of it.
//
// DETERMINISTIC. Fixed dates, fixed keys, and every uuid, timestamp and
// fingerprint replaced with a stable placeholder, so two runs on two
// machines produce byte-identical files.
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
  '20261013100000_batch11_1_completion_and_evidence.sql',
  '20261013110000_batch11_1_completion_operations.sql'
];

const FINISHED = '2027-05-04T16:30:00Z';
const CAPTURED = '2027-05-04T15:04:00Z';

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
// pattern for that silently replaces nothing, which is how a fixture stops
// being deterministic without anyone noticing.
const UUID_IN_TEXT = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function normalise(value, keyHint) {
  if (Array.isArray(value)) return value.map((v) => normalise(v, keyHint));
  if (value instanceof Date) return '<timestamp>';
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = normalise(v, k);
    return out;
  }
  if (typeof value === 'string') {
    if (UUID.test(value)) {
      const hint = (keyHint || '')
        .replace(/_id$/, '').replace(/^latest_/, '').replace(/^active_/, '');
      return stable(value, hint || 'id');
    }
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return '<timestamp>';
    if (/^[0-9a-f]{32}$/.test(value)) return '<fingerprint>';
    // The job uuid appears inside generated prose, too.
    return value.replace(UUID_IN_TEXT, (m) => stable(m, 'id'));
  }
  return value;
}

/** A refusal, as a client would see it: the SQLSTATE and the sentence. */
function refusal(err) {
  return {
    refused: true,
    sqlstate: err.code,
    message: err.message.replace(UUID_IN_TEXT, '<uuid>')
  };
}

(async () => {
  assertDisposableTarget(PGURL);
  const client = new pg.Client({ connectionString: PGURL });
  await client.connect();
  await assertDisposableDatabase(client);

  const one = async (sql, p) => (await client.query(sql, p)).rows[0];
  const all = async (sql, p) => (await client.query(sql, p)).rows;
  const rpc = async (fn, p) => (await one(`select ${fn} as r`, p)).r;
  const tryRpc = async (fn, p) => {
    try { return await rpc(fn, p); } catch (err) { return refusal(err); }
  };
  const trySql = async (sql, p) => {
    try { await client.query(sql, p); return { refused: false }; }
    catch (err) { return refusal(err); }
  };

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
  for (const f of ['fixture-schema.sql', 'fixture-schema-batch8-1.sql',
                   'fixture-schema-batch9-1.sql', 'fixture-schema-batch10-1.sql',
                   'fixture-schema-batch11-1.sql']) {
    await client.query(readFileSync(join(DB, f), 'utf8'));
  }
  await client.query(`revoke ns_legacy_writer from anon`);
  for (const f of SEQUENCE) {
    await client.query(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }

  const owner = (await one('insert into auth.users default values returning id')).id;
  const crew  = (await one('insert into auth.users default values returning id')).id;
  await client.query(`select set_config('nova.is_admin','on',false)`);
  await client.query(`select set_config('nova.actor_id',$1,false)`, [owner]);
  const beOwner = () => client.query(`select set_config('nova.actor_id',$1,false)`, [owner]);
  const beCrew  = () => client.query(`select set_config('nova.actor_id',$1,false)`, [crew]);

  const carB = (await one(
    `insert into public.ns_stock_locations (code,name,kind,sort_order)
     values ('car_b','Car B','vehicle',2) returning id`)).id;
  await client.query(
    `insert into public.ns_crew_members (user_id,role,vehicle_location_id,display_name)
     values ($1,'crew',(select id from public.ns_stock_locations where code='car_a'),'FIXTURE crew')`,
    [crew]);

  const supplier = (await one('select id from public.ns_suppliers limit 1')).id;
  const customer = (await one(
    `insert into public.customers (name) values ('FIXTURE Customer') returning id`)).id;

  let k = 0;
  const key = (t) => `fixture-${t}-${++k}`;

  const svcId = async (sKey) => (await one(
    'select id from public.services where key=$1', [sKey])).id;

  const newJob = async (over = {}) => (await one(
    `insert into public.ns_jobs (customer_id, status, scheduled_for)
     values ($1,$2,'2027-05-04T14:00:00Z') returning id`,
    [customer, over.status || 'in_progress'])).id;

  const measure = async (job, sKey, q = 100) => client.query(
    `insert into public.job_measurements (job_id, service_id, quantity, unit)
     values ($1,$2,$3,'sq_ft')`, [job, await svcId(sKey), q]);

  const upload = async (job, name) => (await one(
    `insert into public.job_attachments (job_id, storage_path, kind, size_bytes, mime_type)
     values ($1,$2,'site_photo',40960,'image/jpeg') returning id`,
    [job, `${job}/${name}.jpg`])).id;

  const evidence = (job, att, requirement, over = {}) => rpc(
    `public.register_job_evidence($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9,$10,$11,$12,'field_console')`,
    [key('ev'), job, att, requirement, over.serviceKey ?? null,
     'capturedAt' in over ? over.capturedAt : CAPTURED, over.timeState ?? null,
     'lat' in over ? over.lat : 49.1049, 'lon' in over ? over.lon : -122.8011,
     over.accuracy ?? 8, over.gpsState ?? null, over.watermark ?? null]);

  const versions = async (job) => ({
    lock: (await one('select lock_version from public.ns_jobs where id=$1', [job])).lock_version,
    policy: (await one('select public.ns_evidence_policy_version() as v')).v
  });

  const complete = (job, v, over = {}) => rpc(
    `public.complete_job_with_evidence($1,$2,$3,$4,$5::timestamptz,$6::jsonb,$7::jsonb,$8)`,
    [over.key ?? key('done'), job, v.lock, v.policy,
     'finished' in over ? over.finished : FINISHED,
     JSON.stringify(over.consumption ?? []),
     JSON.stringify(over.additionalWork ?? []), over.note ?? null]);

  const completeTry = async (job, v, over = {}) => {
    try { return await complete(job, v, over); } catch (err) { return refusal(err); }
  };

  const requirementsOf = (job) => all(
    `select service_key, requirement, required_count, satisfied_count, coverage,
            requires_geotag, enforcement, spec_state, state
       from public.ns_job_evidence_requirements
      where job_id=$1 order by service_key, requirement`, [job]);

  const readinessOf = (job) => one(
    `select * from public.ns_job_evidence_readiness where job_id=$1`, [job]);

  const scenarios = {};

  /* ---- 1. a cleaning job: before and after, per service scope ---- */
  {
    // Confirm the cleaning pair as BLOCKING, which is what makes this
    // scenario a gate rather than a note.
    await rpc(`public.set_evidence_policy($1,'siding','before',1,'per_service_scope',false,'blocking','FIXTURE owner-confirmed')`, [key('pol')]);
    await rpc(`public.set_evidence_policy($1,'siding','after',1,'per_service_scope',false,'blocking','FIXTURE owner-confirmed')`, [key('pol')]);

    const job = await newJob();
    await measure(job, 'siding');
    const before = await requirementsOf(job);

    const refused = await completeTry(job, await versions(job));

    const a1 = await evidence(job, await upload(job, 'west-before'), 'before',
      { serviceKey: 'siding' });
    const a2 = await evidence(job, await upload(job, 'west-after'), 'after',
      { serviceKey: 'siding' });
    const accepted = await complete(job, await versions(job), {
      note: 'Soft washed the west and south elevations'
    });

    scenarios.cleaning_before_and_after = {
      description: 'A cleaning job with the owner-confirmed before/after pair '
        + 'as BLOCKING. The first call is refused with the shortfall named; '
        + 'the same call after registering one before and one after is '
        + 'accepted with evidence_state satisfied.',
      requirements_before_any_evidence: before,
      refused_without_evidence: refused,
      registered: [a1, a2],
      accepted,
      requirements_after: await requirementsOf(job)
    };
  }

  /* ---- 2. one image covering several scopes ---- */
  {
    const job = await newJob();
    await measure(job, 'siding');
    await measure(job, 'deck');
    await rpc(`public.set_evidence_policy($1,'deck','before',1,'per_service_scope',false,'blocking','FIXTURE owner-confirmed')`, [key('pol')]);

    const att = await upload(job, 'deck-and-siding');
    const siding = await evidence(job, att, 'before', { serviceKey: 'siding' });
    const deck   = await evidence(job, att, 'before', { serviceKey: 'deck' });
    const dup    = await evidence(job, att, 'before', { serviceKey: 'siding' });

    scenarios.one_image_two_scopes = {
      description: 'ONE uploaded file registered against two service scopes. '
        + 'Both before requirements are satisfied by it, and no second '
        + 'upload is needed. The same image against the SAME scope again is '
        + 'the same fact and comes back replayed.',
      attachment_registrations: [siding, deck],
      same_scope_again_is_replayed: dup,
      distinct_attachments: (await one(
        `select count(distinct attachment_id)::int as n
           from public.ns_job_evidence where job_id=$1`, [job])).n,
      requirements: await requirementsOf(job)
    };
  }

  /* ---- 3. a lighting job: what went up and what it was made of ---- */
  {
    const job = await newJob();
    await measure(job, 'permanent_lighting', 120);
    const unconfirmed = await requirementsOf(job);

    const inst = await evidence(job, await upload(job, 'run-as-left'),
      'installation', { serviceKey: 'permanent_lighting' });
    const comp = await evidence(job, await upload(job, 'boxes'), 'component');

    const accepted = await complete(job, await versions(job), {
      note: 'Permanent run installed; component boxes photographed'
    });

    scenarios.lighting_installation_and_component = {
      description: 'A lighting job. The proposed policies ask for the finished '
        + 'run per service scope and one component shot per job; both are '
        + 'still PROPOSED, so the shortfall would have been advisory rather '
        + 'than blocking. Supplier specifications remain unknown: the '
        + 'component photograph records what was used, it does not certify '
        + 'that it was correct.',
      requirements_proposed_only: unconfirmed,
      registered: [inst, comp],
      accepted
    };
  }

  /* ---- 4. the quick winter proof ---- */
  {
    const job = await newJob();
    await measure(job, 'winter_property_care', 1);
    const r = await requirementsOf(job);
    const ev = await evidence(job, await upload(job, 'winter-check'), 'winter_proof');
    const accepted = await complete(job, await versions(job), {
      note: 'Quick winter check; nothing to report'
    });

    scenarios.quick_winter_proof = {
      description: 'The configurable quick winter proof: one shot per job. '
        + 'requires_geotag is PROPOSED FALSE -- a basement or a steel garage '
        + 'is not a reason to stop the work -- and min_count and '
        + 'requires_geotag are the two dials the owner has. Turning the '
        + 'geotag on is the open business question, not a default.',
      requirements: r,
      registered: ev,
      accepted
    };
  }

  /* ---- 5. missing metadata, and missing evidence ---- */
  {
    const job = await newJob();
    await measure(job, 'winter_property_care', 1);

    const noMeta = await evidence(job, await upload(job, 'no-metadata'),
      'winter_proof', { capturedAt: null, lat: null, lon: null,
                        gpsState: 'denied' });
    const unreliable = await evidence(job, await upload(job, 'clock-wrong'),
      'winter_proof', { capturedAt: CAPTURED, timeState: 'unreliable' });

    // And the evidence-missing refusal, on a job with a blocking rule.
    const gated = await newJob();
    await measure(gated, 'siding');
    const missing = await completeTry(gated, await versions(gated));

    const guessed = await tryRpc(
      `public.register_job_evidence($1,$2,'00000000-0000-0000-0000-0000000000ff','before')`,
      [key('ev'), gated]);
    const otherJob = await newJob();
    const foreign = await tryRpc(
      `public.register_job_evidence($1,$2,$3,'before')`,
      [key('ev'), gated, await upload(otherJob, 'somebody-elses-roof')]);
    const unlanded = await tryRpc(
      `public.register_job_evidence($1,$2,$3,'before')`,
      [key('ev'), gated, (await one(
        `insert into public.job_attachments (job_id,storage_path,size_bytes)
         values ($1,$2,0) returning id`, [gated, `${gated}/pending.jpg`])).id]);

    scenarios.missing_metadata_and_evidence = {
      description: 'Explicit states, never nulls that read as "now". A photo '
        + 'with no device time is capture_time_state unknown; a photo whose '
        + 'clock is not believed is unreliable with NO timestamp kept; a '
        + 'denied location is gps_state denied, which is a different fact '
        + 'from unavailable. Separately: the three ways evidence '
        + 'registration refuses, and what a missing blocking requirement '
        + 'looks like.',
      no_device_metadata: noMeta,
      unreliable_clock: unreliable,
      missing_blocking_evidence: missing,
      guessed_attachment_id: guessed,
      attachment_of_another_job: foreign,
      upload_not_landed: unlanded
    };
  }

  /* ---- 6. denied access ---- */
  {
    const job = await newJob();
    await measure(job, 'winter_property_care', 1);
    await evidence(job, await upload(job, 'winter'), 'winter_proof');
    await client.query(
      `insert into public.ns_job_vehicle_assignments (job_id, location_id)
       values ($1,$2)`, [job, carB]);

    const v = await versions(job);
    await beCrew();
    const crossCar = await completeTry(job, v);
    const policyByCrew = await tryRpc(
      `public.set_evidence_policy($1,'siding','before',1,'per_service_scope',false,'blocking',null)`,
      [key('pol')]);
    const exceptionByCrew = await tryRpc(
      `public.authorise_evidence_exception($1,$2,'camera broke',null,null)`,
      [key('exc'), job]);
    await beOwner();

    const accepted = await complete(job, await versions(job));
    const sameKey = accepted.completion.completion_id;
    await beCrew();
    const replayCrossCar = await completeTry(job, v, { key: 'unused' });
    await beOwner();

    scenarios.denied_access = {
      description: 'Car A does not finish Car B\'s work, set policy, or '
        + 'excuse its own photographs. 42501 in every case. The owner can, '
        + 'and the receipt names who did.',
      crew_completing_other_cars_job: crossCar,
      crew_setting_policy: policyByCrew,
      crew_authorising_exception: exceptionByCrew,
      owner_accepted_completion_id: sameKey,
      crew_retry_after_owner_accepted: replayCrossCar
    };
  }

  /* ---- 7. stale policy and stale job ---- */
  {
    const job = await newJob();
    await measure(job, 'winter_property_care', 1);
    await evidence(job, await upload(job, 'winter'), 'winter_proof');
    const v = await versions(job);

    const staleJob = await completeTry(job, { lock: v.lock - 1, policy: v.policy });
    const stalePolicy = await completeTry(job, { lock: v.lock, policy: v.policy - 1 });

    // And a policy change in flight is a real stale case, not a contrived one.
    await rpc(`public.set_evidence_policy($1,'moss','before',1,'per_service_scope',false,'advisory','FIXTURE mid-flight change')`, [key('pol')]);
    const afterChange = await completeTry(job, v);
    const accepted = await complete(job, await versions(job));

    scenarios.stale_policy_and_job = {
      description: 'Two different staleness cases with the same remedy: '
        + 're-read and send again. 55000 '
        + '(object_not_in_prerequisite_state) in both, with different '
        + 'sentences so a client can say which happened. Nothing is written '
        + 'by a refused call.',
      stale_job_version: staleJob,
      stale_policy_version: stalePolicy,
      policy_changed_while_the_phone_held_an_old_version: afterChange,
      accepted_after_re_reading: accepted
    };
  }

  /* ---- 8. the same key twice: a lost response ---- */
  {
    const job = await newJob();
    await measure(job, 'winter_property_care', 1);
    await evidence(job, await upload(job, 'winter'), 'winter_proof');
    const v = await versions(job);
    const same = key('done');

    const first = await complete(job, v, { key: same, note: 'as reported' });
    const second = await complete(job, v, { key: same, note: 'as reported' });

    scenarios.same_key_retry_lost_response = {
      description: 'The lost response. The client never saw the first answer '
        + 'and sends the identical request again under the same key. The '
        + 'second call returns the SAME completion with replayed true and '
        + 'creates no second event. This is the recovery path for "the '
        + 'server may or may not have got it".',
      first,
      second,
      same_completion: first.completion.completion_id === second.completion.completion_id,
      accepted_events_for_this_job: (await one(
        `select count(*)::int as n from public.ns_job_completions where job_id=$1`,
        [job])).n
    };
  }

  /* ---- 9. changed intent under an existing key ---- */
  {
    const job = await newJob();
    await measure(job, 'winter_property_care', 1);
    await evidence(job, await upload(job, 'winter'), 'winter_proof');
    const v = await versions(job);
    const same = key('done');

    await complete(job, v, { key: same, note: 'as reported' });
    const changed = await completeTry(job, v,
      { key: same, note: 'actually something else' });
    const reordered = await (async () => {
      // A reordered consumption list is the SAME request, not a changed one.
      const mat = (await one(
        `insert into public.ns_materials
           (name,category,unit,supplier_id,pack_quantity,reorder_point,reorder_qty)
         values ('FIXTURE bleach','consumable','litre',$1,1,0,0) returning id`,
        [supplier])).id;
      const mat2 = (await one(
        `insert into public.ns_materials
           (name,category,unit,supplier_id,pack_quantity,reorder_point,reorder_qty)
         values ('FIXTURE degreaser','consumable','litre',$1,1,0,0) returning id`,
        [supplier])).id;
      await rpc(`public.post_stock_movement($1,$2,'base',100,'received',null,null,null,null,'usable','exact')`, [key('mv'), mat]);
      await rpc(`public.post_stock_movement($1,$2,'base',100,'received',null,null,null,null,'usable','exact')`, [key('mv'), mat2]);
      const job2 = await newJob();
      await measure(job2, 'winter_property_care', 1);
      await evidence(job2, await upload(job2, 'winter'), 'winter_proof');
      const v2 = await versions(job2);
      const kk = key('done');
      const lines = [
        { material_id: mat, location_code: 'base', quantity: 2 },
        { material_id: mat2, location_code: 'base', quantity: 3 }
      ];
      const a = await complete(job2, v2, { key: kk, consumption: lines });
      const b = await complete(job2, v2,
        { key: kk, consumption: [lines[1], lines[0]] });
      return { first_replayed: a.replayed, second_replayed: b.replayed,
               same_completion: a.completion.completion_id === b.completion.completion_id };
    })();

    scenarios.changed_intent_same_key = {
      description: 'Same key, different request. Refused with 23505 rather '
        + 'than answered with the first result, because the caller believes '
        + 'the second. A consumption list in a different ORDER is not a '
        + 'changed request: the fingerprint sorts it first.',
      changed_payload: changed,
      reordered_payload_is_the_same_request: reordered
    };
  }

  /* ---- 10. locked history ---- */
  {
    const mat = (await one(
      `insert into public.ns_materials
         (name,category,unit,supplier_id,pack_quantity,reorder_point,reorder_qty)
       values ('FIXTURE locked bleach','consumable','litre',$1,1,0,0) returning id`,
      [supplier])).id;
    await rpc(`public.post_stock_movement($1,$2,'car_a',60,'received',null,null,null,null,'usable','exact')`,
      [key('mv'), mat]);

    const job = await newJob();
    await measure(job, 'winter_property_care', 1);
    const ev = await evidence(job, await upload(job, 'winter'), 'winter_proof');
    const accepted = await complete(job, await versions(job), {
      consumption: [{ material_id: mat, location_code: 'car_a', quantity: 10 }]
    });
    const cid = accepted.completion.completion_id;
    const line = await one(
      `select id from public.ns_job_consumptions where completion_id=$1`, [cid]);

    scenarios.locked_history = {
      description: 'Everything an accepted completion rests on is frozen, and '
        + 'the refusals come from TRIGGERS, so a direct API or table path '
        + 'hits them too. Note the grants: `authenticated` holds no insert, '
        + 'update or delete on any of these tables at all, so in production '
        + 'the browser never reaches the trigger.',
      edit_the_receipt: await trySql(
        `update public.ns_job_completions set note='rewritten' where id=$1`, [cid]),
      delete_the_receipt: await trySql(
        `delete from public.ns_job_completions where id=$1`, [cid]),
      delete_frozen_evidence: await trySql(
        `delete from public.ns_job_evidence where id=$1`, [ev.evidence_id]),
      repurpose_frozen_evidence: await trySql(
        `update public.ns_job_evidence set requirement='before' where id=$1`,
        [ev.evidence_id]),
      edit_accepted_consumption: await trySql(
        `update public.ns_job_consumptions set quantity=1 where id=$1`, [line.id]),
      late_unapproved_consumption: await trySql(
        `insert into public.ns_job_consumptions
           (job_id, material_id, location_id, quantity, unit)
         values ($1,$2,(select id from public.ns_stock_locations where code='car_a'),9,'litre')`,
        [job, mat]),
      set_completed_at_by_hand: await trySql(
        `update public.ns_jobs set completed_at='2020-01-01T00:00:00Z' where id=$1`,
        [job]),
      mark_another_job_complete_directly: await trySql(
        `update public.ns_jobs set status='completed', completed_at=now()
          where id=$1`, [await newJob()]),
      write_grants_for_authenticated: await all(
        `select t as table_name,
                has_table_privilege('authenticated','public.'||t,'insert') as can_insert,
                has_table_privilege('authenticated','public.'||t,'update') as can_update,
                has_table_privilege('authenticated','public.'||t,'delete') as can_delete
           from unnest(array['ns_job_completions','ns_job_evidence',
                             'ns_job_consumptions','ns_job_completion_corrections',
                             'ns_evidence_policies','ns_evidence_exceptions',
                             'ns_change_orders']) as t`)
    };
  }

  /* ---- 11. a reasoned correction, and a reopen ---- */
  {
    const mat = (await one(
      `insert into public.ns_materials
         (name,category,unit,supplier_id,pack_quantity,reorder_point,reorder_qty)
       values ('FIXTURE corrected bleach','consumable','litre',$1,1,0,0) returning id`,
      [supplier])).id;
    await rpc(`public.post_stock_movement($1,$2,'car_a',60,'received',null,null,null,null,'usable','exact')`,
      [key('mv'), mat]);

    const job = await newJob();
    await measure(job, 'winter_property_care', 1);
    await evidence(job, await upload(job, 'winter'), 'winter_proof');
    const accepted = await complete(job, await versions(job), {
      consumption: [{ material_id: mat, location_code: 'car_a', quantity: 10 }]
    });
    const cid = accepted.completion.completion_id;
    const original = await one(
      `select id from public.ns_job_consumptions where completion_id=$1`, [cid]);
    const before = Number((await one(
      `select on_hand from public.ns_material_stock_by_location
        where material_id=$1 and location_code='car_a'`, [mat])).on_hand);

    await beCrew();
    const byCrew = await tryRpc(
      `public.correct_job_consumption($1,$2,$3,'miscounted',-3,null,'car_a','exact',$4)`,
      [key('fix'), cid, mat, original.id]);
    await beOwner();
    const noReason = await tryRpc(
      `public.correct_job_consumption($1,$2,$3,'',-3,null,'car_a','exact',$4)`,
      [key('fix'), cid, mat, original.id]);

    const corrected = await rpc(
      `public.correct_job_consumption($1,$2,$3,$4,-3,null,'car_a','exact',$5)`,
      [key('fix'), cid, mat,
       'Recounted the jug at Base: three litres never left it', original.id]);
    const after = Number((await one(
      `select on_hand from public.ns_material_stock_by_location
        where material_id=$1 and location_code='car_a'`, [mat])).on_hand);

    const reopened = await rpc(
      `public.reopen_job_completion($1,$2,$3)`,
      [key('re'), cid, 'Customer says the back elevation was missed']);
    const recompleted = await complete(job, await versions(job),
      { note: 'Back elevation done' });

    scenarios.reasoned_correction = {
      description: 'A correction APPENDS. The original consumption line '
        + 'stands as what the crew reported; the correction is a second row '
        + 'that links back to it, carries a reason and a name, and moves '
        + 'stock as an ADJUSTMENT rather than a second consumption. '
        + 'p_quantity is the signed change to the RECORD, so -3 puts three '
        + 'litres back on the shelf. Owner-only, and a blank reason is '
        + 'refused. A reopen works the same way and allows exactly one more '
        + 'completion, recorded as supersedes_corrections 1.',
      correction_by_crew: byCrew,
      correction_without_a_reason: noReason,
      corrected,
      on_hand_before_correction: before,
      on_hand_after_correction: after,
      consumed_movements_still_one: (await one(
        `select count(*)::int as n from public.ns_material_stock_moves
          where material_id=$1 and reason='consumed'`, [mat])).n,
      consumption_lines: await all(
        `select quantity, level, corrects is not null as is_correction,
                correction_reason
           from public.ns_job_consumptions where job_id=$1
          order by recorded_at`, [job]),
      reopened,
      recompleted_cycle: recompleted.completion.supersedes_corrections
    };
  }

  /* ---- 12. additional work, proposed and never self-approved ---- */
  {
    const job = await newJob();
    await measure(job, 'winter_property_care', 1);
    await evidence(job, await upload(job, 'winter'), 'winter_proof');
    const quote = (await one(
      `insert into public.ns_quotes (job_id,status,total,customer_notes,terms)
       values ($1,'sent',900,'as agreed','net 30') returning id`, [job])).id;

    const accepted = await complete(job, await versions(job), {
      additionalWork: [{ description: 'Second storey windows need doing' }]
    });
    const co = accepted.additional_work[0].change_order_id;

    await beCrew();
    const selfApprove = await tryRpc(
      `public.decide_change_order($1,$2,'approved',400,null)`, [key('dec'), co]);
    await beOwner();
    const unpriced = await tryRpc(
      `public.decide_change_order($1,$2,'approved',null,null)`, [key('dec'), co]);
    const approved = await rpc(
      `public.decide_change_order($1,$2,'approved',400,'agreed on the phone')`,
      [key('dec'), co]);

    scenarios.additional_work_and_quote_protection = {
      description: 'Completion RECORDS extra work as an unpriced proposal and '
        + 'approves nothing. A crew cannot approve or price it; the owner '
        + 'does both in one transaction, so there is no window in which an '
        + 'approved change order has no figure. The sent quote\'s own money, '
        + 'labels, terms and customer notes stay frozen by the Batch 5/7.1 '
        + 'guard, which 11.1 does not touch.',
      recorded_by_completion: accepted.additional_work,
      crew_approving_its_own_change: selfApprove,
      approving_without_a_figure: unpriced,
      owner_approved: approved,
      sent_quote_total_unchanged: Number((await one(
        `select total from public.ns_quotes where id=$1`, [quote])).total),
      rewrite_sent_customer_notes: await trySql(
        `update public.ns_quotes set customer_notes='something else' where id=$1`,
        [quote]),
      demote_sent_quote_to_draft: await trySql(
        `update public.ns_quotes set status='draft' where id=$1`, [quote]),
      internal_notes_stay_editable: await trySql(
        `update public.ns_quotes set internal_notes='crew says gutters too'
          where id=$1`, [quote])
    };
  }

  /* ---- 13. unconfigured: unknown is not zero ---- */
  {
    const job = await newJob();
    const other = (await one(
      `insert into public.services (key,name,unit,sort_order)
       values ('fixture_unpoliced','FIXTURE Unpoliced Service','sq_ft',99)
       returning id`)).id;
    await client.query(
      `insert into public.job_measurements (job_id,service_id,quantity,unit)
       values ($1,$2,50,'sq_ft')`, [job, other]);

    const accepted = await complete(job, await versions(job));
    scenarios.unconfigured_is_not_satisfied = {
      description: 'A service with no policy at all. required_count is NULL, '
        + 'the requirement state is `unconfigured`, and the job-level '
        + 'evidence_state is `unconfigured` -- never `satisfied` and never a '
        + 'zero that reads as "nothing needed". The completion is accepted, '
        + 'because refusing every job until the owner configures the rules '
        + 'would stop the business, and the receipt records exactly what it '
        + 'could not judge.',
      requirements: await requirementsOf(job),
      readiness: await readinessOf(job),
      accepted
    };
  }

  /* ---- 14. an owner exception with a reason ---- */
  {
    const job = await newJob();
    await measure(job, 'siding');
    const refused = await completeTry(job, await versions(job));
    const exception = await rpc(
      `public.authorise_evidence_exception($1,$2,$3,'before','siding')`,
      [key('exc'), job, 'Phone died at the property; I inspected it myself']);
    const accepted = await completeTry(job, await versions(job));

    scenarios.authorised_exception = {
      description: 'The explicit, attributed exception. It names the job, the '
        + 'requirement and the service it excuses, carries a reason that '
        + 'cannot be blank, and records who authorised it. It does not '
        + 'disable the rule for anything else.',
      refused_first: refused,
      exception,
      accepted_after_exception: accepted,
      requirements_after: await requirementsOf(job)
    };
  }

  await client.end();

  const out = {
    contract: 'completion-evidence-contract-v1',
    generated_by: 'tests/fixtures/build-completion-fixtures.mjs',
    note: 'Generated by running the real backend on a disposable PostgreSQL. '
      + 'Every refusal here is a real SQLSTATE from the real function, not a '
      + 'mock. Regenerate after any contract change; the diff IS the change. '
      + 'Ids, timestamps and fingerprints are replaced with stable '
      + 'placeholders so two runs produce identical files. No live database '
      + 'was touched and no real customer, address or supplier product '
      + 'appears here.',
    scenarios: normalise(scenarios)
  };

  mkdirSync(HERE, { recursive: true });
  const path = join(HERE, 'completion-evidence-v1.json');
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote ${path}`);
  console.log(`${Object.keys(scenarios).length} scenarios`);
})().catch((err) => { console.error(err); process.exit(1); });
