// Rehearses the COMPLETE PENDING MIGRATION SEQUENCE, in filename order,
// against the dedicated disposable database -- which is what Supabase will
// do to the live project when these are finally applied.
//
//   node tests/db/setup-test-db.mjs && node tests/db/rehearse-pending.mjs
//
// This is a REPORTING TOOL, not a pass/fail suite, and it is deliberately
// not in `npm run test:db`. It exists because ten migrations are now
// pending at once and nobody has ever seen them run back to back. It prints
// one line per migration and exits 1 only if a migration fails for a reason
// OTHER than the known gap below.
//
// THE KNOWN GAP. The repository has no base schema (docs/batch7-1-findings
// .md, finding 4b): supabase/migrations/ starts mid-history, so a clean
// database cannot be built from this repo at all. The two fixture schemas
// recreate only what the Batch 7.1 and 8.1/9.1 migrations reference by
// name, which means the earlier pending migrations -- the Batch 5 freeze in
// particular -- reference quoting objects no fixture reproduces. Those
// failures are a gap in the REPOSITORY, not in the migration, and the tool
// says so rather than reporting a scary red line.
//
// What a clean run proves: that the pending migrations are valid SQL in
// filename order against real PostgreSQL, with no ordering hazard between
// batches. What it does NOT prove: anything about the live project. NOTHING
// HAS BEEN APPLIED TO PRODUCTION.

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

// Everything after the last version the live project reports as applied
// (20261009013557), read from `supabase.list_migrations` on 2026-10-11.
const LAST_APPLIED = '20261009013557';

// Migrations whose dependencies no fixture reproduces, with the reason.
// Registered explicitly so a NEW failure can never hide behind a known one.
// Currently empty: the first rehearsal found that the two fixtures between
// them cover everything the ten pending migrations reference, which is more
// than was expected -- the Batch 5 freeze applies cleanly.
const KNOWN_GAPS = {};

// Read the directory and sort, because that is exactly what Supabase does:
// hard-coding a list here would go stale the moment either track adds a
// migration, and a stale rehearsal is worse than none.
const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();

(async () => {
  assertDisposableTarget(PGURL);
  const client = new pg.Client({ connectionString: PGURL });
  await client.connect();
  await assertDisposableDatabase(client);

  for (const f of ['fixture-schema.sql', 'fixture-schema-batch8-1.sql',
                   'fixture-schema-batch9-1.sql', 'fixture-schema-batch10-1.sql',
                   'fixture-schema-batch11-1.sql']) {
    await client.query(readFileSync(join(HERE, f), 'utf8'));
  }
  // The contract RPCs are admin-only and the fixture's is_admin() reads a GUC.
  await client.query(`select set_config('nova.is_admin','on',false)`);

  /* UNDO ONE HOSTILE CONSTRUCT OF THE 7.1 FIXTURE. That fixture grants
     ns_legacy_writer to anon on purpose, to prove the Batch 7.1 migrations
     detect the inherited-privilege route; with the membership in place they
     refuse to finish, which is them working correctly, not a sequencing
     fault. A rehearsal that left it would report a red line every run and
     teach everyone to ignore it. The 7.1 suite still exercises the hostile
     case directly -- that is its job, not this tool's. */
  await client.query(`revoke ns_legacy_writer from anon`);

  const pending = files.filter(f => f.slice(0, 14) > LAST_APPLIED);
  console.log(`Pending after ${LAST_APPLIED}: ${pending.length} migration(s)\n`);

  let unexpected = 0, applied = 0, gaps = 0;
  for (const file of pending) {
    let err = null;
    try {
      await client.query(readFileSync(join(MIGRATIONS, file), 'utf8'));
    } catch (e) { err = e; }

    if (!err) { applied++; console.log(`  OK    ${file}`); continue; }
    if (KNOWN_GAPS[file]) {
      gaps++;
      console.log(`  GAP   ${file}\n          ${KNOWN_GAPS[file]}`);
      console.log(`          (${err.code}) ${err.message}`);
      continue;
    }
    unexpected++;
    console.log(`  FAIL  ${file}\n          (${err.code}) ${err.message}`);
  }

  console.log(`\n${applied} applied, ${gaps} blocked by the missing base schema, `
    + `${unexpected} unexplained`);
  if (unexpected === 0 && gaps > 0) {
    console.log(
      '\nThe gaps are a repository problem, not a migration problem: until a\n'
      + 'base schema is captured, the earliest pending migrations can only be\n'
      + 'rehearsed against the live project\'s own schema.');
  }
  await client.end();
  process.exit(unexpected ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
