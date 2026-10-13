// Batch 7.1 -- executable database tests for the integrity and authorization
// migrations, run against a DEDICATED DISPOSABLE DATABASE.
//
//   node tests/db/setup-test-db.mjs        # once, creates + stamps the DB
//   node tests/db/batch7-1.test.mjs
//
// Needs the `pg` devDependency (already in package.json) -- run `npm install`
// if node_modules is absent. Override the target with PGURL; the guards below
// will refuse anything that is not the dedicated local database.
//
// These are NOT the tests/integration/ suite, which targets a real Supabase
// project via SUPABASE_DB_URL.
//
// Scope and honesty:
//   * passing proves the migrations are valid SQL, that their function
//     signatures match the live ones, and that the trigger and privilege
//     logic behave as claimed in real Postgres.
//   * it does NOT prove the live database is protected. None of these
//     migrations has been applied to production.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import pg from 'pg';
import {
  TEST_DB_NAME, assertDisposableTarget, assertDisposableDatabase, NotDisposableError
} from './disposable.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const MIGRATIONS = join(REPO, 'supabase', 'migrations');

const PGURL = process.env.PGURL
  || `postgresql://postgres@/${TEST_DB_NAME}?host=/tmp&port=5433`;

const results = [];
async function record(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, err: err && err.message }); }
}

/** Runs `fn`, returns the error if it raised, else null. */
async function errorOf(fn) {
  try { await fn(); return null; } catch (err) { return err; }
}

const migration = (file) => readFileSync(join(MIGRATIONS, file), 'utf8');
const RPC_MIGRATION    = '20261010090000_batch7_1_tighten_remaining_admin_rpc_grants.sql';
const LEGACY_MIGRATION = '20261010091000_batch7_1_revoke_anon_writes_on_legacy_tables.sql';
const FREEZE_MIGRATION = '20261009160000_batch5_freeze_customer_facing_content_once_sent.sql';

(async () => {
  // =========================================== A. the guard, with no I/O ===
  // Every one of these must be rejected by pure string inspection, BEFORE any
  // connection is attempted -- which is what lets remote-looking targets be
  // tested without contacting a remote host.
  const REJECT = [
    ['a hosted Supabase database',      `postgresql://u:p@db.abcd.supabase.co:5432/${TEST_DB_NAME}`],
    ['any other remote host',           `postgresql://u:p@db.example.com:5432/${TEST_DB_NAME}`],
    ['a remote IP',                     `postgresql://u:p@198.51.100.7:5432/${TEST_DB_NAME}`],
    ['a local but ORDINARY database',   'postgresql://postgres@localhost:5432/postgres'],
    ['a local app-shaped database',     'postgresql://postgres@localhost:5432/nova_shield'],
    ['a socket to the wrong database',  'postgresql://postgres@/postgres?host=/tmp&port=5433'],
    ['a non-postgres URL',              `mysql://localhost/${TEST_DB_NAME}`],
    ['an unparseable string',           'not a url at all'],
    ['an empty string',                 '']
  ];

  for (const [label, url] of REJECT) {
    await record(`guard refuses ${label} (no connection attempted)`, async () => {
      assert.throws(() => assertDisposableTarget(url), NotDisposableError,
        `${url} should have been refused`);
    });
  }

  await record('guard accepts the dedicated local database in every supported URL shape', async () => {
    // The socket forms carry userinfo with an EMPTY host, which WHATWG URL
    // rejects outright for non-special schemes -- so these also pin that the
    // parser normalises rather than refusing a perfectly valid target.
    for (const ok of [
      `postgresql://postgres@/${TEST_DB_NAME}?host=/tmp&port=5433`,
      `postgresql://postgres:secret@/${TEST_DB_NAME}?host=/var/run/postgresql`,
      `postgresql:///${TEST_DB_NAME}?host=/tmp`,
      `postgresql://postgres@localhost:5432/${TEST_DB_NAME}`,
      `postgres://127.0.0.1:5432/${TEST_DB_NAME}`
    ]) {
      assert.doesNotThrow(() => assertDisposableTarget(ok), `${ok} should be accepted`);
    }
  });

  await record('a password containing @ does not smuggle a remote host past the guard', async () => {
    assert.throws(
      () => assertDisposableTarget(`postgresql://u:p@localhost@db.example.com:5432/${TEST_DB_NAME}`),
      NotDisposableError);
  });

  // ================================================= connect and verify ===
  assertDisposableTarget(PGURL);
  const client = new pg.Client({ connectionString: PGURL });
  await client.connect();
  await assertDisposableDatabase(client);   // marker check, before any DDL

  await record('the connected database carries the disposable marker', async () => {
    const { rows } = await client.query(
      `select shobj_description(oid,'pg_database') as m from pg_database where datname = current_database()`);
    assert.equal(rows[0].m, 'NOVA-SHIELD-DISPOSABLE-TEST-DB');
  });

  await record('an unmarked database is refused even if the name matches', async () => {
    const fake = {
      query: async () => ({ rows: [{ db: TEST_DB_NAME, marker: null }] })
    };
    await assert.rejects(() => assertDisposableDatabase(fake), NotDisposableError);
  });

  await client.query(readFileSync(join(HERE, 'fixture-schema.sql'), 'utf8'));

  const anonHasTable = async (tbl, priv) => (await client.query(
    'select has_table_privilege($1, $2, $3) as ok', ['anon', tbl, priv])).rows[0].ok;
  const roleHasFn = async (role, sig) => (await client.query(
    'select has_function_privilege($1, $2, $3) as ok', [role, sig, 'EXECUTE'])).rows[0].ok;

  const CALC = 'public.calculate_job_pricing(uuid,uuid[])';
  const SIG  = 'public.save_quote_signature(uuid,text,text)';

  // ============ B. the gaps the first version of these migrations had =====
  await record('GAP: revoking only FROM anon leaves a PUBLIC grant in place', async () => {
    assert.equal(await anonHasTable('public.jobs', 'INSERT'), true, 'via PUBLIC');
    await client.query('revoke insert, update, delete on table public.jobs from anon');
    assert.equal(await anonHasTable('public.jobs', 'INSERT'), true,
      'this is the defect: the PUBLIC grant survives an anon-only revoke');
  });

  await record('GAP: revoking only FROM public leaves a direct anon grant in place', async () => {
    assert.equal(await roleHasFn('anon', SIG), true);
    await client.query(`revoke execute on function ${SIG} from public`);
    assert.equal(await roleHasFn('anon', SIG), true,
      'this is the defect: the direct anon grant survives a PUBLIC-only revoke');
  });

  await record('GAP: neither revoke touches an inherited grant', async () => {
    assert.equal(await anonHasTable('public.quotes', 'INSERT'), true, 'via ns_legacy_writer');
    await client.query('revoke insert on table public.quotes from anon');
    await client.query('revoke insert on table public.quotes from public');
    assert.equal(await anonHasTable('public.quotes', 'INSERT'), true,
      'inherited privileges survive both revokes -- this is why the migration verifies');
  });

  // Reset to the fixture's starting state for the real runs.
  await client.query(readFileSync(join(HERE, 'fixture-schema.sql'), 'utf8'));

  // ========== C. the migrations stop loudly when access is inherited ======
  await record('legacy migration REFUSES and changes nothing while anon inherits write access', async () => {
    const err = await errorOf(() => client.query(migration(LEGACY_MIGRATION)));
    assert.ok(err, 'it must not report success it has not achieved');
    assert.match(err.message, /inherited through a role membership/);
    assert.match(err.message, /pg_auth_members/, 'the diagnostic should say how to find it');
    // A DO block is one transaction: a raise rolls the whole thing back, so
    // the tables it had already processed are untouched rather than half-done.
    assert.equal(await anonHasTable('public.job_requests', 'INSERT'), true,
      'the migration must be all-or-nothing');
  });

  await record('RPC migration REFUSES while anon inherits EXECUTE', async () => {
    const err = await errorOf(() => client.query(migration(RPC_MIGRATION)));
    assert.ok(err);
    assert.match(err.message, /inherited through a role membership/);
    assert.equal(await roleHasFn('anon', CALC), true, 'unchanged');
  });

  // =================== D. and succeed once the membership is resolved =====
  await client.query('revoke ns_legacy_writer from anon');

  await record('legacy migration closes ALL THREE routes once inheritance is gone', async () => {
    await client.query(migration(LEGACY_MIGRATION));
    for (const [tbl, route] of [['public.job_requests', 'direct'],
                                ['public.jobs', 'PUBLIC'],
                                ['public.quotes', 'formerly inherited']]) {
      for (const p of ['INSERT', 'UPDATE', 'DELETE']) {
        assert.equal(await anonHasTable(tbl, p), false, `${tbl} ${p} (${route}) must be revoked`);
      }
    }
  });

  await record('legacy migration leaves anon SELECT alone', async () => {
    assert.equal(await anonHasTable('public.job_requests', 'SELECT'), true,
      'SELECT is deliberately out of scope, pending the retirement decision');
  });

  await record('legacy migration preserves authenticated and service_role writes', async () => {
    for (const role of ['authenticated', 'service_role']) {
      for (const tbl of ['public.job_requests', 'public.jobs', 'public.quotes']) {
        const { rows } = await client.query(
          'select has_table_privilege($1,$2,$3) as ok', [role, tbl, 'INSERT']);
        assert.equal(rows[0].ok, true,
          `${role} must keep INSERT on ${tbl} -- the PUBLIC revoke must not take it by side effect`);
      }
    }
  });

  await record('RPC migration closes both PUBLIC and direct routes once inheritance is gone', async () => {
    await client.query(migration(RPC_MIGRATION));
    assert.equal(await roleHasFn('anon', CALC), false, 'PUBLIC route');
    assert.equal(await roleHasFn('anon', SIG), false, 'PUBLIC + direct routes');
  });

  await record('RPC migration keeps authenticated and service_role', async () => {
    assert.equal(await roleHasFn('authenticated', CALC), true);
    assert.equal(await roleHasFn('authenticated', SIG), true);
  });

  await record('both migrations are idempotent on a second run', async () => {
    await client.query(migration(LEGACY_MIGRATION));
    await client.query(migration(RPC_MIGRATION));
    assert.equal(await anonHasTable('public.jobs', 'INSERT'), false);
    assert.equal(await roleHasFn('anon', CALC), false);
  });

  await record('a PUBLIC grant on a trigger function cannot be exercised anyway', async () => {
    const err = await errorOf(() => client.query('select public.fixture_trigger_fn()'));
    assert.ok(err);
    assert.match(err.message, /can only be called as triggers/i);
  });

  await record('a PUBLIC grant on an event-trigger function cannot be exercised anyway', async () => {
    const err = await errorOf(() => client.query('select public.fixture_event_trigger_fn()'));
    assert.ok(err);
    assert.match(err.message, /can only be called as triggers/i);
    assert.equal(err.code, '0A000', 'feature_not_supported, not a permission error');
  });

  // ================================= E. the customer-content freeze =======
  const seed = async (status) => (await client.query(
    `insert into public.ns_quotes (status, customer_notes, terms, internal_notes)
     values ($1,'original note','original terms','staff scratch') returning id`,
    [status])).rows[0].id;

  await record('BEFORE: a sent quote\'s customer_notes can be rewritten (the hole)', async () => {
    const id = await seed('sent');
    await client.query(`update public.ns_quotes set customer_notes='rewritten' where id=$1`, [id]);
    const { rows } = await client.query('select customer_notes from public.ns_quotes where id=$1', [id]);
    assert.equal(rows[0].customer_notes, 'rewritten');
  });

  await record('BEFORE: a sent quote can be demoted back to draft', async () => {
    const id = await seed('sent');
    await client.query(`update public.ns_quotes set status='draft' where id=$1`, [id]);
    const { rows } = await client.query('select status from public.ns_quotes where id=$1', [id]);
    assert.equal(rows[0].status, 'draft');
  });

  await client.query(migration(FREEZE_MIGRATION));

  await record('a DRAFT quote still accepts customer_notes and terms edits', async () => {
    const id = await seed('draft');
    await client.query(
      `update public.ns_quotes set customer_notes='updated', terms='updated terms' where id=$1`, [id]);
    const { rows } = await client.query(
      'select customer_notes, terms from public.ns_quotes where id=$1', [id]);
    assert.equal(rows[0].customer_notes, 'updated');
    assert.equal(rows[0].terms, 'updated terms');
  });

  for (const status of ['sent', 'accepted', 'declined', 'expired', 'superseded']) {
    await record(`a ${status.toUpperCase()} quote refuses a customer_notes edit`, async () => {
      const id = await seed(status);
      const err = await errorOf(() =>
        client.query(`update public.ns_quotes set customer_notes='rewritten' where id=$1`, [id]));
      assert.ok(err);
      assert.equal(err.code, '23514');
      assert.match(err.message, /frozen once sent/);
      const { rows } = await client.query('select customer_notes from public.ns_quotes where id=$1', [id]);
      assert.equal(rows[0].customer_notes, 'original note');
    });
  }

  await record('internal_notes remain editable on a SENT quote', async () => {
    const id = await seed('sent');
    await client.query(`update public.ns_quotes set internal_notes='added later' where id=$1`, [id]);
    const { rows } = await client.query('select internal_notes from public.ns_quotes where id=$1', [id]);
    assert.equal(rows[0].internal_notes, 'added later');
  });

  await record('BYPASS 1 (one statement): status->draft plus a content edit is refused', async () => {
    const id = await seed('sent');
    const err = await errorOf(() =>
      client.query(`update public.ns_quotes set status='draft', customer_notes='sneaky' where id=$1`, [id]));
    assert.ok(err);
    assert.equal(err.code, '23514');
  });

  await record('BYPASS 2 (two statements): demoting a sent quote to draft is refused', async () => {
    const id = await seed('sent');
    const err = await errorOf(() =>
      client.query(`update public.ns_quotes set status='draft' where id=$1`, [id]));
    assert.ok(err, 'this is the step the Batch 5 version allowed');
    assert.match(err.message, /cannot be returned to draft/);
  });

  await record('a legitimate draft -> sent transition carrying fresh content is allowed', async () => {
    const id = await seed('draft');
    await client.query(
      `update public.ns_quotes set status='sent', customer_notes='final wording' where id=$1`, [id]);
    const { rows } = await client.query(
      'select status, customer_notes from public.ns_quotes where id=$1', [id]);
    assert.equal(rows[0].status, 'sent');
    assert.equal(rows[0].customer_notes, 'final wording');
  });

  await client.end();

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
})();
