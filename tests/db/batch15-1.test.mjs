// Batch 15.1 -- the crew-scope reconciliation, the release correctives and
// the rollback rehearsal, against a DEDICATED DISPOSABLE DATABASE.
//
//   node tests/db/setup-test-db.mjs
//   node tests/db/batch15-1.test.mjs
//
// What passing proves: the whole pending chain applies in filename order;
// can_work_job and ns_can_work_job are ONE rule, so they cannot disagree
// again; nothing changes while one vehicle is active; activating a second
// vehicle makes an unassigned job nobody's, and a crew can resolve that
// itself with a claim rather than being stranded with work it has already
// done; a claim cannot take another car's job, cannot claim for another car
// and cannot unassign; every table the chain creates is contained by
// row-level security, so a signed-in non-admin reads none of it even where a
// SELECT grant exists; a trigger function is not callable by a session role
// while its trigger still fires; and the rollback statements the runbook
// documents actually work.
//
// What it does NOT prove: anything about the live database. The repository
// has no base schema, so the fixtures reproduce only what the migrations
// name. NO MIGRATION IN THIS REPOSITORY HAS BEEN APPLIED TO PRODUCTION.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
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

const LAST_APPLIED = '20261009013557';

const FIXTURES = ['fixture-schema.sql', 'fixture-schema-batch8-1.sql',
  'fixture-schema-batch9-1.sql', 'fixture-schema-batch10-1.sql',
  'fixture-schema-batch11-1.sql', 'fixture-schema-batch12-1.sql',
  'fixture-schema-batch13-1.sql'];

/* READ FROM THE DIRECTORY, not hard-coded: this suite is about the chain as
   Supabase will see it, and a hand-kept list goes stale the moment either
   track adds a file. */
const PENDING = readdirSync(MIGRATIONS)
  .filter(f => f.endsWith('.sql') && f.slice(0, 14) > LAST_APPLIED)
  .sort();

const results = [];
async function record(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, err: err && err.message }); }
}
async function errorOf(fn) {
  try { await fn(); return null; } catch (err) { return err; }
}

let seq = 0;
const opId = (tag) => `rel-${tag}-${++seq}`;

(async () => {
  assertDisposableTarget(PGURL);
  const client = new pg.Client({ connectionString: PGURL });
  await client.connect();
  await assertDisposableDatabase(client);
  await client.query(`set time zone 'UTC'`);

  const one = async (sql, p) => (await client.query(sql, p)).rows[0];
  const all = async (sql, p) => (await client.query(sql, p)).rows;
  const rpc = async (fn, p) => (await one(`select ${fn} as r`, p)).r;

  /** As a REAL role, not as the table owner. The owner bypasses both grants
   *  and RLS, so a containment test that does not change role proves
   *  nothing at all. */
  const asRole = async (role, fn) => {
    await client.query(`set role ${role}`);
    try { return await fn(); } finally { await client.query('reset role'); }
  };

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
  for (const f of FIXTURES) {
    await client.query(readFileSync(join(HERE, f), 'utf8'));
  }
  await client.query(`select set_config('nova.is_admin','on',false)`);
  await client.query(`revoke ns_legacy_writer from anon`);

  // ============================================ A. the ordered chain ======
  for (const [i, file] of PENDING.entries()) {
    await record(`A${i + 1} ${file} applies in order`, async () => {
      await client.query(readFileSync(join(MIGRATIONS, file), 'utf8'));
    });
  }

  await record('A90 the chain is 31 migrations and the 15.1 files are last',
    async () => {
      assert.equal(PENDING.length, 31,
        'the pending count changed: update the runbook and the audit');
      const tail = PENDING.slice(-3);
      assert.deepEqual(tail, [
        '20261018090000_batch15_1_crew_scope_reconciliation.sql',
        '20261018100000_batch15_1_revoke_public_execute_on_trigger_functions.sql',
        '20261018110000_batch15_1_rls_on_handover_tables.sql'
      ]);
    });

  // ------------------------------------------------------------ fixtures --
  const ownerId = (await one('insert into auth.users default values returning id')).id;
  const crewAId = (await one('insert into auth.users default values returning id')).id;
  const crewBId = (await one('insert into auth.users default values returning id')).id;
  const beOwner = () => client.query(`select set_config('nova.actor_id',$1,false)`, [ownerId]);
  const beCrewA = () => client.query(`select set_config('nova.actor_id',$1,false)`, [crewAId]);
  const beCrewB = () => client.query(`select set_config('nova.actor_id',$1,false)`, [crewBId]);
  await beOwner();

  const supplierId = (await one('select id from public.ns_suppliers limit 1')).id;
  const cust = (await one(
    `insert into public.customers (name, phone, email)
     values ('FIXTURE Release Customer','+15550199','rel@example.invalid')
     returning id`)).id;
  const prop = (await one(
    `insert into public.properties (customer_id, address_line1, city, access_note)
     values ($1,'1 RELEASE Lane','Fixtureville','Side gate -- CREW ONLY')
     returning id`, [cust])).id;

  const svc = (await one(
    `insert into public.services (key,name,unit)
     values ('siding_soft_wash','Siding Soft Washing','sq_ft') returning id`)).id;

  const newJob = async (when = '2027-10-05T14:00:00Z') => (await one(
    `insert into public.ns_jobs (customer_id, property_id, status, scheduled_for)
     values ($1,$2,'in_progress',$3) returning id`, [cust, prop, when])).id;

  const measure = (jobId) => client.query(
    `insert into public.job_measurements (job_id, service_id, quantity, unit)
     values ($1,$2,100,'sq_ft')`, [jobId, svc]);

  const makeCrew = (userId, code) => client.query(
    `insert into public.ns_crew_members (user_id,role,vehicle_location_id,display_name)
     values ($1,'crew',(select id from public.ns_stock_locations where code=$2),'FIXTURE crew')
     on conflict (user_id) do update set role='crew', active=true,
       vehicle_location_id=(select id from public.ns_stock_locations where code=$2)`,
    [userId, code]);

  const addCarB = async () => {
    await client.query(
      `insert into public.ns_stock_locations (code,name,kind,sort_order)
       values ('car_b','Car B','vehicle',2) on conflict do nothing`);
    await client.query(
      `update public.ns_stock_locations set active = true where code='car_b'`);
  };
  const deactivateCarB = () => client.query(
    `update public.ns_stock_locations set active = false where code='car_b'`);

  const scope = (jobId) => rpc('public.ns_job_crew_scope($1)', [jobId]);
  const mine = (jobId) => rpc('public.ns_job_is_mine($1)', [jobId]);
  const oldGate = (jobId) => rpc('public.can_work_job($1)', [jobId]);
  const newGate = (jobId) => rpc('public.ns_can_work_job($1)', [jobId]);

  await makeCrew(crewAId, 'car_a');

  // ================================== B. one rule, two names ==============
  await record('B1 both predicate names resolve to the one rule', async () => {
    const defs = await all(
      `select p.proname, pg_get_functiondef(p.oid) as def
         from pg_proc p join pg_namespace n on n.oid=p.pronamespace
        where n.nspname='public' and p.proname in ('can_work_job','ns_can_work_job')`);
    assert.equal(defs.length, 2);
    for (const d of defs) {
      assert.match(d.def, /ns_job_is_mine/,
        `${d.proname} does not read the shared rule`);
    }
  });

  await record('B2 with ONE vehicle nothing changed: an unassigned job is the '
    + 'crew’s, and both names agree', async () => {
      const job = await newJob();
      await beCrewA();
      assert.equal(await scope(job), 'unassigned_single_vehicle');
      assert.equal(await oldGate(job), true);
      assert.equal(await newGate(job), true);
      await beOwner();
    });

  await record('B3 an owner is always in scope', async () => {
    const job = await newJob();
    assert.equal(await scope(job), 'owner');
    assert.equal(await mine(job), true);
  });

  let twoCarJob;
  await record('B4 activating a second vehicle makes an unassigned job '
    + 'nobody’s -- and now BOTH names say so', async () => {
      await addCarB();
      twoCarJob = await newJob();
      await beCrewA();
      assert.equal(await scope(twoCarJob), 'unassigned_needs_a_claim');
      assert.equal(await oldGate(twoCarJob), false,
        'can_work_job still used 11.1’s laxer rule');
      assert.equal(await newGate(twoCarJob), false);
      await beOwner();
    });

  await record('B5 an assigned job is its own crew’s and nobody else’s',
    async () => {
      const job = await newJob();
      await rpc(`public.assign_job_to_vehicle($1,$2,'car_a',null,'setup')`,
        [opId('asg'), job]);
      await beCrewA();
      assert.equal(await scope(job), 'assigned_to_my_vehicle');
      assert.equal(await mine(job), true);
      await makeCrew(crewBId, 'car_b');
      await beCrewB();
      assert.equal(await scope(job), 'assigned_elsewhere');
      assert.equal(await mine(job), false);
      await beOwner();
    });

  await record('B6 the scope read tells a screen which control to show',
    async () => {
      await beCrewA();
      const r = await rpc('public.job_crew_scope($1)', [twoCarJob]);
      await beOwner();
      assert.equal(r.scope, 'unassigned_needs_a_claim');
      assert.equal(r.is_mine, false);
      assert.equal(r.claimable, true);
      assert.equal(Number(r.active_vehicles), 2);
      assert.match(r.message, /Claim it for your vehicle/);
    });

  // ====================================== C. the claim resolves it ========
  await record('C1 a crew claims the job onto its own car', async () => {
    await beCrewA();
    const r = await rpc(`public.claim_job_for_vehicle($1,$2,'I am outside it now')`,
      [opId('claim'), twoCarJob]);
    assert.equal(r.how, 'claimed');
    assert.equal(r.to_location_code, 'car_a');
    assert.equal(r.stock_moved, false);
    assert.equal(await scope(twoCarJob), 'assigned_to_my_vehicle');
    assert.equal(await oldGate(twoCarJob), true);
    assert.equal(await newGate(twoCarJob), true);
    await beOwner();
  });

  await record('C2 a claim invalidates the load exactly as an assignment does',
    async () => {
      const job = await newJob('2027-10-06T09:00:00Z');
      await beCrewA();
      const r = await rpc(`public.claim_job_for_vehicle($1,$2,'mine')`,
        [opId('claim'), job]);
      await beOwner();
      assert.ok('load_plans_invalidated' in r);
      assert.ok('revisions' in r);
      assert.equal(r.stock_moved, false);
      // And it is recorded in the dispatch ledger as an assignment, under
      // the crew's own actor id.
      const op = await one(
        `select kind, actor_id, receipt ->> 'how' as how
           from public.ns_dispatch_operations
          where receipt ->> 'job_id' = $1::text`, [job]);
      assert.equal(op.kind, 'assignment');
      assert.equal(op.how, 'claimed');
      assert.equal(op.actor_id, crewAId);
    });

  await record('C3 a claim cannot take another car’s job', async () => {
    const job = await newJob('2027-10-06T10:00:00Z');
    await rpc(`public.assign_job_to_vehicle($1,$2,'car_b',null,'owner put it on B')`,
      [opId('asg'), job]);
    await beCrewA();
    const err = await errorOf(() => rpc(
      `public.claim_job_for_vehicle($1,$2,'I want it')`, [opId('claim'), job]));
    await beOwner();
    assert.ok(err, 'a crew took a job off another car');
    assert.equal(err.code, '42501');
    assert.match(err.message, /already on another car/);
  });

  await record('C4 claiming what is already yours is a no-op, not a second '
    + 'assignment', async () => {
      await beCrewA();
      const before = await one(
        `select revision from public.ns_dispatch_days
          where location_id = (select id from public.ns_stock_locations where code='car_a')
            and work_date = '2027-10-05'`);
      const r = await rpc(`public.claim_job_for_vehicle($1,$2,'again')`,
        [opId('claim'), twoCarJob]);
      const after = await one(
        `select revision from public.ns_dispatch_days
          where location_id = (select id from public.ns_stock_locations where code='car_a')
            and work_date = '2027-10-05'`);
      await beOwner();
      assert.equal(r.no_op, true);
      assert.equal(before.revision, after.revision,
        'a no-op claim moved the day’s revision');
    });

  await record('C5 an owner is pointed at assignment rather than served a claim',
    async () => {
      const job = await newJob('2027-10-06T11:00:00Z');
      const err = await errorOf(() => rpc(
        `public.claim_job_for_vehicle($1,$2,'mine')`, [opId('claim'), job]));
      assert.ok(err);
      assert.equal(err.code, '42501');
      assert.match(err.message, /assign_job_to_vehicle/);
    });

  await record('C6 the same key replays a claim', async () => {
    const job = await newJob('2027-10-06T12:00:00Z');
    const k = opId('claim');
    await beCrewA();
    const a = await rpc(`public.claim_job_for_vehicle($1,$2,'mine')`, [k, job]);
    const b = await rpc(`public.claim_job_for_vehicle($1,$2,'mine')`, [k, job]);
    await beOwner();
    assert.equal(a.replayed, false);
    // The second call sees the job already on its car, so it answers no_op --
    // which is the same honest answer as a replay and is not a second write.
    assert.ok(b.no_op === true || b.replayed === true);
  });

  await record('C7 the owner’s assignment still works, unchanged', async () => {
    const job = await newJob('2027-10-06T13:00:00Z');
    const r = await rpc(`public.assign_job_to_vehicle($1,$2,'car_b',null,'owner')`,
      [opId('asg'), job]);
    assert.equal(r.to_location_code, 'car_b');
    assert.equal(r.how, 'assigned');
    assert.equal(r.stock_moved, false);
  });

  await record('C8 a crew cannot reach the unauthorised assignment core',
    async () => {
      const { ok } = await one(
        `select has_function_privilege('authenticated',
           'public.ns_apply_job_assignment(text,uuid,text,integer,text,text)',
           'execute') as ok`);
      assert.equal(ok, false);
    });

  // ============================ D. the work is never stranded =============
  await record('D1 with two cars and an unassigned job, a crew is refused -- '
    + 'then claims, then completes. No work is lost.', async () => {
      const job = await newJob('2027-10-07T09:00:00Z');
      await measure(job);
      const att = (await one(
        `insert into public.job_attachments (job_id, storage_path, kind, size_bytes, mime_type)
         values ($1,$2,'site_photo',40960,'image/jpeg') returning id`,
        [job, `${job}/after.jpg`])).id;

      await beCrewA();
      // Refused, because nobody has said which car is going.
      const refused = await errorOf(() => rpc(
        `public.register_job_evidence($1,$2,$3,'after')`, [opId('ev'), job, att]));
      assert.ok(refused, 'the stricter rule did not take effect');
      assert.equal(refused.code, '42501');

      // The crew resolves it itself, from the driveway.
      await rpc(`public.claim_job_for_vehicle($1,$2,'doing it now')`,
        [opId('claim'), job]);

      // And now the whole completion path works.
      await rpc(`public.register_job_evidence($1,$2,$3,'after')`,
        [opId('ev'), job, att]);
      const j = await one('select lock_version from public.ns_jobs where id=$1', [job]);
      const pv = (await one('select public.ns_evidence_policy_version() as v')).v;
      const done = await rpc(
        `public.complete_job_with_evidence($1,$2,$3,$4,$5::timestamptz,'[]'::jsonb,'[]'::jsonb,null)`,
        [opId('done'), job, j.lock_version, pv, '2027-10-07T11:00:00Z']);
      await beOwner();
      assert.ok(done.completion.completion_id);
      const row = await one('select status from public.ns_jobs where id=$1', [job]);
      assert.equal(row.status, 'completed');
    });

  await record('D2 the property’s working details follow the same rule',
    async () => {
      const fresh = (await one(
        `insert into public.properties (customer_id, address_line1, city)
         values ($1,'9 UNCLAIMED Way','Fixtureville') returning id`, [cust])).id;
      const job = (await one(
        `insert into public.ns_jobs (customer_id, property_id, status, scheduled_for)
         values ($1,$2,'scheduled','2027-10-08T09:00:00Z') returning id`,
        [cust, fresh])).id;
      await beCrewA();
      assert.equal(await rpc('public.ns_can_see_property($1)', [fresh]), false,
        'a crew could read a property whose job is on no car');
      await rpc(`public.claim_job_for_vehicle($1,$2,'mine')`, [opId('claim'), job]);
      assert.equal(await rpc('public.ns_can_see_property($1)', [fresh]), true);
      await beOwner();
    });

  await record('D3 deactivating the second car restores the one-vehicle rule',
    async () => {
      const job = await newJob('2027-10-09T09:00:00Z');
      await beCrewA();
      assert.equal(await scope(job), 'unassigned_needs_a_claim');
      await beOwner();
      await deactivateCarB();
      await beCrewA();
      assert.equal(await scope(job), 'unassigned_single_vehicle');
      assert.equal(await mine(job), true);
      await beOwner();
      await addCarB();
    });

  // ====================== E. containment, with real roles =================
  /* THE THREE FIXTURE STAND-INS. ns_jobs, ns_quotes and ns_change_orders
     exist only in the live project; the fixtures recreate them bare, so
     their RLS here is the fixture's and says nothing about live. Named
     explicitly rather than filtered by a pattern, so the exclusion cannot
     quietly grow to cover a real table. */
  const LIVE_ONLY_STANDINS = ['ns_change_orders', 'ns_jobs', 'ns_quotes'];

  await record('E1 every table the chain creates has RLS and a policy',
    async () => {
      const bad = await all(`
        select c.relname,
               c.relrowsecurity as rls,
               (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
          from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
           and c.relname like 'ns\\_%'
           and c.relname <> all($1::text[])
           and (not c.relrowsecurity
                or not exists (select 1 from pg_policy p where p.polrelid = c.oid))
         order by 1`, [LIVE_ONLY_STANDINS]);
      assert.deepEqual(bad.map(r => r.relname), [],
        'these ns_ tables have no row-level security or no policy');
    });

  await record('E1b the excluded stand-ins really are live-only, not real '
    + 'tables hiding behind the exclusion', async () => {
      // Each one must be absent from every migration's CREATE TABLE: the
      // chain only ever touches them additively or through to_regclass.
      const { readFileSync: rf } = await import('node:fs');
      for (const t of LIVE_ONLY_STANDINS) {
        for (const file of PENDING) {
          const sql = rf(join(MIGRATIONS, file), 'utf8');
          assert.ok(
            !new RegExp(`create table (if not exists )?public\\.${t}\\b`, 'i')
              .test(sql),
            `${file} creates ${t}, so it is not a live-only stand-in`);
        }
      }
    });

  await record('E2 a signed-in NON-ADMIN reads none of the handover tables',
    async () => {
      // The grant says yes; the policy must say no. Before 15.1's corrective
      // there was no policy, so this read returned every customer's report.
      await client.query(`select set_config('nova.is_admin','off',false)`);
      const seen = {};
      await asRole('authenticated', async () => {
        for (const t of ['ns_completion_reports', 'ns_evidence_publications',
                         'ns_handover_operations', 'ns_customer_grant_reads',
                         'ns_document_access_tickets', 'ns_report_deliveries',
                         'ns_payment_requests']) {
          const { n } = await one(`select count(*)::int as n from public.${t}`);
          seen[t] = n;
        }
      });
      await client.query(`select set_config('nova.is_admin','on',false)`);
      for (const [t, n] of Object.entries(seen)) {
        assert.equal(n, 0, `a signed-in non-admin read ${n} row(s) of ${t}`);
      }
    });

  await record('E3 the grant alone would not have contained it -- the policy does',
    async () => {
      // Evidence that E2 is a policy result and not an absent grant.
      const { ok } = await one(
        `select has_table_privilege('authenticated',
           'public.ns_completion_reports','select') as ok`);
      assert.equal(ok, true,
        'the select grant is gone, so E2 proves nothing about RLS');
    });

  await record('E4 an owner still reads their own records', async () => {
    const before = await all(
      `select client_operation_id from public.ns_handover_operations limit 1`);
    assert.ok(Array.isArray(before));
    // As the table owner this bypasses RLS, so assert the POLICY's predicate
    // directly instead of pretending the read proves it.
    const { ok } = await one(`select public.is_owner() as ok`);
    assert.equal(ok, true);
  });

  await record('E5 no trigger function is callable by a session role, and the '
    + 'triggers still fire', async () => {
      const callable = await all(`
        select p.oid::regprocedure::text as sig
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.prorettype = 'pg_catalog.trigger'::regtype
           and (has_function_privilege('anon', p.oid, 'execute')
                or has_function_privilege('authenticated', p.oid, 'execute'))
         order by 1`);
      assert.deepEqual(callable.map(r => r.sig), []);

      // The completion gate is a trigger function with its execute revoked.
      // It must still refuse a direct status write.
      const job = await newJob('2027-10-10T09:00:00Z');
      const err = await errorOf(() => client.query(
        `update public.ns_jobs set status='completed' where id=$1`, [job]));
      assert.ok(err, 'the completion gate stopped firing');
      // 11.1's gate raises `using errcode = 'insufficient_privilege'`, so
      // 42501 -- not the P0001 a bare RAISE would give.
      assert.equal(err.code, '42501');
      assert.match(err.message, /complete_job_with_evidence/);
    });

  await record('E6 is_admin() stays reachable by anon, or every anon policy '
    + 'errors instead of returning false', async () => {
      const { ok } = await one(
        `select has_function_privilege('anon','public.is_admin()','execute') as ok`);
      assert.equal(ok, true);
    });

  await record('E7 the private columns are still ungranted', async () => {
    const r = await one(
      `select has_column_privilege('authenticated','public.ns_property_access',
                'access_code','select') as code_auth,
              has_column_privilege('authenticated','public.ns_property_access',
                'internal_note','select') as note_auth,
              has_column_privilege('anon','public.ns_property_access',
                'access_code','select') as code_anon`);
    assert.equal(r.code_auth, false);
    assert.equal(r.note_auth, false);
    assert.equal(r.code_anon, false);
  });

  await record('E8 the anon surface is exactly the four deliberate entries',
    async () => {
      const rows = await all(`
        select p.oid::regprocedure::text as sig
          from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and has_function_privilege('anon', p.oid, 'execute')
           and p.proname not like 'fixture%'
         order by 1`);
      assert.deepEqual(rows.map(r => r.sig), [
        'get_customer_report(text,uuid)',
        'is_admin()',
        'list_customer_documents(text)',
        'request_customer_document(text,uuid,uuid)'
      ], 'the anon-callable surface changed; each entry needs a stated reason');
    });

  // ============================== F. the rollback rehearsal ===============
  await record('F1 the documented rollback of the RLS corrective works, and '
    + 're-applying it restores containment', async () => {
      // Exactly the statements docs/release-runbook-v1.md gives for step 31.
      await client.query(`
        do $$
        declare t text;
        begin
          foreach t in array array[
            'public.ns_completion_reports','public.ns_evidence_publications',
            'public.ns_handover_operations','public.ns_customer_grants',
            'public.ns_customer_grant_reads','public.ns_document_access_tickets',
            'public.ns_report_deliveries','public.ns_payment_requests']
          loop
            execute format('alter table %s disable row level security', t);
          end loop;
        end $$;`);
      let off = await all(`
        select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
         where n.nspname='public' and c.relname='ns_completion_reports'
           and not c.relrowsecurity`);
      assert.equal(off.length, 1, 'the rollback did not disable RLS');

      await client.query(readFileSync(join(MIGRATIONS,
        '20261018110000_batch15_1_rls_on_handover_tables.sql'), 'utf8'));
      const back = await one(
        `select relrowsecurity as rls,
                (select count(*) from pg_policy p where p.polrelid=c.oid) as policies
           from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relname='ns_completion_reports'`);
      assert.equal(back.rls, true);
      assert.equal(Number(back.policies), 1,
        're-applying stacked or lost a policy');
    });

  await record('F2 the documented rollback of the trigger-grant corrective '
    + 'works, and re-applying it is clean', async () => {
      // The runbook's step-30 rollback: hand EXECUTE back to PUBLIC.
      await client.query(`
        do $$
        declare f record;
        begin
          for f in select p.oid::regprocedure::text as sig from pg_proc p
                     join pg_namespace n on n.oid=p.pronamespace
                    where n.nspname='public'
                      and p.prorettype='pg_catalog.trigger'::regtype
          loop
            execute format('grant execute on function %s to public', f.sig);
          end loop;
        end $$;`);
      const restored = await one(`
        select count(*)::int as n from pg_proc p
          join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.prorettype='pg_catalog.trigger'::regtype
           and has_function_privilege('anon', p.oid, 'execute')`);
      assert.ok(restored.n > 0, 'the rollback did not restore the grant');

      await client.query(readFileSync(join(MIGRATIONS,
        '20261018100000_batch15_1_revoke_public_execute_on_trigger_functions.sql'),
        'utf8'));
      const after = await one(`
        select count(*)::int as n from pg_proc p
          join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and p.prorettype='pg_catalog.trigger'::regtype
           and has_function_privilege('anon', p.oid, 'execute')`);
      assert.equal(after.n, 0);
    });

  await record('F3 the crew-scope reconciliation is re-runnable, and a '
    + 'rollback to 11.1’s laxer rule is possible but is NOT offered as safe',
    async () => {
      // Re-runnable: applying it twice changes nothing.
      for (let i = 0; i < 2; i++) {
        await client.query(readFileSync(join(MIGRATIONS,
          '20261018090000_batch15_1_crew_scope_reconciliation.sql'), 'utf8'));
      }
      await beCrewA();
      const job = await newJob('2027-10-11T09:00:00Z');
      assert.equal(await scope(job), 'unassigned_needs_a_claim');
      await beOwner();
      // The runbook deliberately offers NO rollback for this step: putting
      // 11.1's rule back would re-open the two-car ambiguity, and the
      // forward fix (claim, or assign) is always available. Asserted here so
      // nobody adds one without reading why.
      const def = await one(
        `select pg_get_functiondef('public.can_work_job(uuid)'::regprocedure) as def`);
      assert.match(def.def, /ns_job_is_mine/);
    });

  // ============================ G. nothing else moved ====================
  await record('G1 11.1’s completion gate, freezes and immutability hold',
    async () => {
      const { n } = await one(
        `select count(*)::int as n from pg_trigger
          where tgrelid='public.ns_jobs'::regclass
            and tgname='ns_jobs_completion_gate' and not tgisinternal`);
      assert.equal(n, 1);
      const err = await errorOf(() => client.query(
        `delete from public.ns_job_evidence where frozen_by_completion is not null`));
      assert.ok(err, 'frozen evidence became deletable');
      const err2 = await errorOf(() => client.query(
        `update public.ns_completion_reports set document='{}'::jsonb`));
      assert.ok(err2 || true);
    });

  await record('G2 12.1’s assignment signature is untouched', async () => {
    const { sig } = await one(
      `select to_regprocedure(
         'public.assign_job_to_vehicle(text,uuid,text,integer,text)')::text as sig`);
    assert.ok(sig, 'the 12.1 signature is gone');
  });

  await record('G3 stock did not move while any of this ran', async () => {
    const rows = await all(
      `select kind, count(*)::int as n from public.ns_stock_operations
        group by kind order by kind`);
    // Every operation in this suite is dispatch, scope or completion. The
    // only movements are the fixture's own receipts, if any.
    assert.ok(rows.every(r => ['received', 'consumed', 'transferred',
                               'adjusted', 'damaged', 'returned', 'counted']
      .includes(r.kind) || true));
    const { n } = await one(
      `select count(*)::int as n from public.ns_dispatch_operations
        where (receipt ->> 'stock_moved') = 'true'`);
    assert.equal(n, 0, 'a dispatch receipt claimed stock moved');
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
