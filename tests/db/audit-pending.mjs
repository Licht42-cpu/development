// Audits the COMPLETE PENDING MIGRATION SEQUENCE and writes the evidence
// down, by applying it to the dedicated disposable database and asking
// PostgreSQL what happened.
//
//   node tests/db/setup-test-db.mjs && node tests/db/audit-pending.mjs
//
// Writes docs/release/pending-migration-audit.md. That file is GENERATED --
// regenerate it rather than editing it, and the diff is the change.
//
// WHY A TOOL AND NOT A HAND-WRITTEN TABLE. A release review that says "these
// migrations are additive" is somebody's recollection. This asks the catalog:
// what objects each file creates or replaces, which statements are
// destructive, whether applying it twice is safe, which live-only tables it
// touches, and what the grant surface looks like once the whole chain has
// run. Every row below came from the database, not from reading the SQL.
//
// WHAT IT CANNOT TELL YOU, stated here so the report is not over-read:
//
//   * Nothing about the LIVE project. The repository has no base schema
//     (docs/batch7-1-findings.md 4b), so the fixtures reproduce only what
//     the migrations name. A migration that applies here can still fail
//     live against a column no fixture knows about.
//   * Nothing about data. The disposable database starts empty, so a
//     migration that would be slow, or would violate a new CHECK against
//     rows that already exist, passes here and is flagged by the
//     `data_risk` column instead -- which is a reading of the SQL, and is
//     labelled as such.
//   * Nothing about timing or locks under load.
//
// NOTHING IS APPLIED TO THE LIVE DATABASE BY THIS SCRIPT.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync } from 'node:fs';
import pg from 'pg';
import {
  TEST_DB_NAME, assertDisposableTarget, assertDisposableDatabase
} from './disposable.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const MIGRATIONS = join(REPO, 'supabase', 'migrations');
const OUT_DIR = join(REPO, 'docs', 'release');
const OUT = join(OUT_DIR, 'pending-migration-audit.md');

const PGURL = process.env.PGURL
  || `postgresql://postgres@/${TEST_DB_NAME}?host=/tmp&port=5433`;

// Everything after the last version the live project reports as applied,
// read from `supabase.list_migrations` on 2026-10-11 and unchanged since.
const LAST_APPLIED = '20261009013557';

const FIXTURES = ['fixture-schema.sql', 'fixture-schema-batch8-1.sql',
  'fixture-schema-batch9-1.sql', 'fixture-schema-batch10-1.sql',
  'fixture-schema-batch11-1.sql', 'fixture-schema-batch12-1.sql',
  'fixture-schema-batch13-1.sql'];

/* Tables that exist ONLY in the live project. A migration touching one of
   these is unverifiable locally beyond what the fixtures reproduce, and the
   report says so per file rather than in a footnote nobody reads. */
const LIVE_ONLY = [
  'ns_jobs', 'customers', 'properties', 'notifications', 'job_attachments',
  'ns_quotes', 'app_settings', 'ns_change_orders', 'quote_line_items',
  'quote_adjustments', 'job_measurements', 'services', 'job_requests',
  'jobs', 'quotes', 'job_inspection_flags'
];

/* Statement shapes that can destroy or block. Read from the SQL text, and
   labelled as a reading rather than an observation. */
const DESTRUCTIVE = [
  [/\bdrop\s+table\b/i, 'drops a table'],
  [/\bdrop\s+column\b/i, 'drops a column'],
  [/\bdrop\s+function\b/i, 'drops a function (signature change)'],
  [/\bdrop\s+trigger\b/i, 'drops a trigger'],
  [/\bdrop\s+view\b/i, 'drops a view'],
  [/\bdrop\s+policy\b/i, 'drops a policy'],
  [/\brevoke\b/i, 'revokes a privilege'],
  [/\bdelete\s+from\b/i, 'deletes rows'],
  [/\btruncate\b/i, 'truncates'],
  [/\balter\s+column\b[\s\S]{0,40}\bset\s+not\s+null\b/i, 'adds NOT NULL'],
  [/\badd\s+constraint\b[\s\S]{0,80}\bcheck\b/i, 'adds a CHECK'],
  [/\bupdate\s+public\./i, 'updates rows (backfill)']
];

const objectSnapshot = async (client) => {
  const q = async (sql) => (await client.query(sql)).rows;
  return {
    tables: new Set((await q(
      `select tablename as n from pg_tables where schemaname='public'`))
      .map(r => r.n)),
    views: new Set((await q(
      `select viewname as n from pg_views where schemaname='public'`))
      .map(r => r.n)),
    functions: new Set((await q(
      `select p.oid::regprocedure::text as n from pg_proc p
         join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='public'`))
      .map(r => r.n)),
    triggers: new Set((await q(
      `select tgname || ' on ' || tgrelid::regclass::text as n from pg_trigger
        where not tgisinternal`)).map(r => r.n)),
    policies: new Set((await q(
      `select polname || ' on ' || polrelid::regclass::text as n from pg_policy`))
      .map(r => r.n)),
    indexes: new Set((await q(
      `select indexname as n from pg_indexes where schemaname='public'`))
      .map(r => r.n))
  };
};

const added = (before, after) =>
  [...after].filter(x => !before.has(x));
const removed = (before, after) =>
  [...before].filter(x => !after.has(x));

(async () => {
  assertDisposableTarget(PGURL);
  const client = new pg.Client({ connectionString: PGURL });
  await client.connect();
  await assertDisposableDatabase(client);
  await client.query(`set time zone 'UTC'`);

  for (const f of FIXTURES) {
    await client.query(readFileSync(join(HERE, f), 'utf8'));
  }
  await client.query(`select set_config('nova.is_admin','on',false)`);
  // The 7.1 fixture grants ns_legacy_writer to anon on purpose, to prove the
  // 7.1 migrations detect the inherited-privilege route. With it in place
  // they refuse to finish -- correct behaviour, not a sequencing fault.
  await client.query(`revoke ns_legacy_writer from anon`);

  /* WHAT THE FIXTURES BROUGHT, so the report can tell a repository object
     from a stand-in. Without this, the RLS and grant sections read as if
     ns_jobs, ns_quotes and the legacy tables were this chain's doing, when
     they are fixture reproductions of live tables whose real RLS and grants
     this database cannot know. */
  const fixtureState = await objectSnapshot(client);

  const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();
  const pending = files.filter(f => f.slice(0, 14) > LAST_APPLIED);

  const rows = [];
  let snapshot = await objectSnapshot(client);

  for (const file of pending) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    const row = { file, ok: true, error: null };

    try {
      await client.query(sql);
    } catch (err) {
      row.ok = false;
      row.error = `(${err.code}) ${err.message}`;
    }

    const after = await objectSnapshot(client);
    row.creates = {
      tables: added(snapshot.tables, after.tables),
      views: added(snapshot.views, after.views),
      functions: added(snapshot.functions, after.functions),
      triggers: added(snapshot.triggers, after.triggers),
      policies: added(snapshot.policies, after.policies),
      indexes: added(snapshot.indexes, after.indexes)
    };
    row.drops = {
      tables: removed(snapshot.tables, after.tables),
      views: removed(snapshot.views, after.views),
      functions: removed(snapshot.functions, after.functions),
      triggers: removed(snapshot.triggers, after.triggers),
      policies: removed(snapshot.policies, after.policies),
      indexes: removed(snapshot.indexes, after.indexes)
    };
    snapshot = after;

    row.data_risk = DESTRUCTIVE.filter(([re]) => re.test(sql)).map(([, l]) => l);
    row.live_only = LIVE_ONLY.filter(t =>
      new RegExp(`\\bpublic\\.${t}\\b`).test(sql));
    row.guarded = /to_regclass\(/.test(sql);
    row.lines = sql.split('\n').length;

    /* RE-RUNNABILITY, observed rather than assumed: apply it a second time
       against the state it just produced. Supabase will not do this, but a
       half-applied chain being restarted will, and that is the recovery
       path the runbook depends on. */
    if (row.ok) {
      try {
        await client.query(sql);
        row.rerunnable = true;
        // A second run must not have stacked duplicates.
        const after2 = await objectSnapshot(client);
        const dupPolicies = added(after.policies, after2.policies);
        const dupTriggers = added(after.triggers, after2.triggers);
        if (dupPolicies.length || dupTriggers.length) {
          row.rerunnable = false;
          row.rerun_error = `a second run added ${
            [...dupPolicies, ...dupTriggers].join(', ')}`;
        }
        snapshot = after2;
      } catch (err) {
        row.rerunnable = false;
        row.rerun_error = `(${err.code}) ${err.message}`;
      }
    } else {
      row.rerunnable = null;
    }

    rows.push(row);
    process.stdout.write(
      `${row.ok ? 'OK  ' : 'FAIL'} ${file}` +
      `${row.ok && !row.rerunnable ? '  [not re-runnable]' : ''}\n`);
  }

  /* ----------------------------------------- the grant surface, after ---- */
  const grantRows = (await client.query(`
    select p.oid::regprocedure::text as sig,
           has_function_privilege('anon', p.oid, 'execute')          as anon,
           has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
           has_function_privilege('service_role', p.oid, 'execute')  as service_role
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
     order by 1`)).rows;

  const tableRows = (await client.query(`
    select c.relname as name,
           has_table_privilege('anon', c.oid, 'select')          as anon_select,
           has_table_privilege('anon', c.oid, 'insert')          as anon_insert,
           has_table_privilege('authenticated', c.oid, 'select') as auth_select,
           has_table_privilege('authenticated', c.oid, 'insert') as auth_insert,
           has_table_privilege('authenticated', c.oid, 'update') as auth_update,
           has_table_privilege('authenticated', c.oid, 'delete') as auth_delete,
           c.relrowsecurity as rls,
           (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
     order by 1`)).rows;

  const anonFns = grantRows.filter(r => r.anon);
  const writableByAuth = tableRows.filter(r =>
    r.auth_insert || r.auth_update || r.auth_delete);
  const anonTables = tableRows.filter(r => r.anon_select || r.anon_insert);
  const rlsOff = tableRows.filter(r => !r.rls);

  /* The private columns 12.1 and 13.1 enforce by GRANT rather than by UI.
     Checked by name, because this is the kind of thing a later migration
     undoes by accident. */
  const columnChecks = [];
  for (const [table, col] of [
    ['ns_property_access', 'access_code'],
    ['ns_property_access', 'internal_note'],
    ['ns_property_access', 'entrance_note'],
    ['ns_property_access', 'customer_note']
  ]) {
    if ((await client.query(
      `select to_regclass($1) is not null as there`, [`public.${table}`]))
      .rows[0].there) {
      const r = (await client.query(
        `select has_column_privilege('authenticated', $1, $2, 'select') as auth,
                has_column_privilege('anon', $1, $2, 'select') as anon`,
        [`public.${table}`, col])).rows[0];
      columnChecks.push({ table, col, ...r });
    }
  }

  await client.end();

  /* ------------------------------------------------------ the report ---- */
  const yes = (b) => (b ? 'yes' : '—');
  const list = (xs, max = 6) => xs.length
    ? (xs.length > max ? `${xs.slice(0, max).join(', ')} …+${xs.length - max}`
                       : xs.join(', '))
    : '—';

  const md = [];
  md.push('# Pending migration audit');
  md.push('');
  md.push('**GENERATED** by `tests/db/audit-pending.mjs`. Regenerate with');
  md.push('`node tests/db/setup-test-db.mjs && node tests/db/audit-pending.mjs`;');
  md.push('the diff is the change. Do not edit by hand.');
  md.push('');
  md.push(`Pending after \`${LAST_APPLIED}\`: **${pending.length} migrations**.`);
  md.push('');
  md.push('Every "creates" and "drops" figure below was read from the');
  md.push('PostgreSQL catalog before and after applying the file to a');
  md.push('disposable database. `data risk` is a reading of the SQL text and');
  md.push('is labelled as such. **Nothing here says anything about the live');
  md.push('project**: the repository has no base schema, so a file that');
  md.push('applies cleanly here can still meet a live column no fixture');
  md.push('reproduces.');
  md.push('');

  md.push('## Order, outcome and reversibility');
  md.push('');
  md.push('| # | migration | applies | re-runnable | creates | drops | data risk (read from SQL) |');
  md.push('|---|---|---|---|---|---|---|');
  rows.forEach((r, i) => {
    const creates = [
      r.creates.tables.length && `${r.creates.tables.length} tables`,
      r.creates.views.length && `${r.creates.views.length} views`,
      r.creates.functions.length && `${r.creates.functions.length} functions`,
      r.creates.triggers.length && `${r.creates.triggers.length} triggers`,
      r.creates.policies.length && `${r.creates.policies.length} policies`,
      r.creates.indexes.length && `${r.creates.indexes.length} indexes`
    ].filter(Boolean).join(', ') || '—';
    const drops = [
      r.drops.tables.length && `tables: ${list(r.drops.tables, 3)}`,
      r.drops.views.length && `views: ${list(r.drops.views, 3)}`,
      r.drops.functions.length && `functions: ${list(r.drops.functions, 2)}`,
      r.drops.triggers.length && `triggers: ${list(r.drops.triggers, 2)}`,
      r.drops.policies.length && `policies: ${list(r.drops.policies, 2)}`
    ].filter(Boolean).join('; ') || '—';
    md.push(`| ${i + 1} | \`${r.file}\` | ${r.ok ? 'yes' : `**NO** ${r.error}`}`
      + ` | ${r.rerunnable === null ? 'n/a'
            : r.rerunnable ? 'yes' : `**no** — ${r.rerun_error}`}`
      + ` | ${creates} | ${drops} | ${list(r.data_risk, 4)} |`);
  });
  md.push('');

  md.push('## Live-only tables each file touches');
  md.push('');
  md.push('These exist only in the live project. A file naming one is');
  md.push('**unverified locally beyond what the fixture reproduces**, and the');
  md.push('`guarded` column says whether the file introspects with');
  md.push('`to_regclass` before touching anything.');
  md.push('');
  md.push('| migration | live-only tables named | guarded |');
  md.push('|---|---|---|');
  for (const r of rows) {
    if (!r.live_only.length) continue;
    md.push(`| \`${r.file}\` | ${list(r.live_only, 8)} | ${yes(r.guarded)} |`);
  }
  md.push('');

  md.push('## The grant surface after the whole chain');
  md.push('');
  md.push(`Functions in \`public\`: **${grantRows.length}**.`);
  md.push(`Executable by \`anon\`: **${anonFns.length}**.`);
  md.push('');
  md.push('### Every function `anon` may execute');
  md.push('');
  md.push('Each one must be a deliberate decision with a reason. Anything');
  md.push('here that is not on the list in the release findings is a defect.');
  md.push('');
  md.push('| function | anon | authenticated | service_role | created by |');
  md.push('|---|---|---|---|---|');
  for (const r of anonFns) {
    const origin = fixtureState.functions.has(r.sig)
      ? 'fixture stand-in' : '**the pending chain**';
    md.push(`| \`${r.sig}\` | yes | ${yes(r.authenticated)}`
      + ` | ${yes(r.service_role)} | ${origin} |`);
  }
  md.push('');

  md.push('### Tables `anon` may read or write');
  md.push('');
  if (anonTables.length === 0) {
    md.push('**None.** No table in `public` is readable or writable by `anon`.');
  } else {
    md.push('| table | select | insert | created by |');
    md.push('|---|---|---|---|');
    for (const r of anonTables) {
      md.push(`| \`${r.name}\` | ${yes(r.anon_select)} | ${yes(r.anon_insert)}`
        + ` | ${fixtureState.tables.has(r.name)
                 ? 'fixture stand-in' : '**the pending chain**'} |`);
    }
  }
  md.push('');

  md.push('### Tables a logged-in caller may write');
  md.push('');
  md.push('A write grant here is only safe where RLS or a definer function');
  md.push('stands in front of it. `rls` is the table\'s own row-level');
  md.push('security flag, read from `pg_class`.');
  md.push('');
  md.push('| table | insert | update | delete | rls |');
  md.push('|---|---|---|---|---|');
  for (const r of writableByAuth) {
    md.push(`| \`${r.name}\` | ${yes(r.auth_insert)} | ${yes(r.auth_update)}`
      + ` | ${yes(r.auth_delete)} | ${yes(r.rls)} |`);
  }
  md.push('');

  md.push('### Tables with row-level security OFF');
  md.push('');
  md.push('Split by who created the table, because the two halves mean');
  md.push('different things. A **fixture** table is a local stand-in for a');
  md.push('live-only table: its RLS and policies here are whatever the');
  md.push('fixture bothered to set and say NOTHING about the live project. A');
  md.push('**repository** table is one the pending chain creates, and its');
  md.push('state here is its state live.');
  md.push('');
  const rlsOffRepo = rlsOff.filter(r => !fixtureState.tables.has(r.name));
  const rlsOffFixture = rlsOff.filter(r => fixtureState.tables.has(r.name));
  md.push('**Created by the pending chain** — this is the real list:');
  md.push('');
  md.push(rlsOffRepo.length
    ? rlsOffRepo.map(r => `\`${r.name}\``).join(', ')
    : 'None. Every table the chain creates has RLS enabled.');
  md.push('');
  md.push('Created by a fixture (says nothing about live):');
  md.push('');
  md.push(rlsOffFixture.length
    ? rlsOffFixture.map(r => `\`${r.name}\``).join(', ')
    : 'None.');
  md.push('');
  md.push('#### Policy coverage, chain-created tables');
  md.push('');
  md.push('| table | rls | policies | authenticated may select |');
  md.push('|---|---|---|---|');
  for (const r of tableRows.filter(r => !fixtureState.tables.has(r.name))) {
    md.push(`| \`${r.name}\` | ${yes(r.rls)} | ${r.policies}`
      + ` | ${yes(r.auth_select)} |`);
  }
  md.push('');

  md.push('### The private columns, checked by name');
  md.push('');
  md.push('| table | column | authenticated may select | anon may select |');
  md.push('|---|---|---|---|');
  for (const c of columnChecks) {
    md.push(`| \`${c.table}\` | \`${c.col}\` | ${yes(c.auth)} | ${yes(c.anon)} |`);
  }
  md.push('');
  md.push('`access_code` and `internal_note` must read **no** for both, or');
  md.push('13.1 §3.6 and 12.1\'s private-column decision have been undone.');
  md.push('');

  md.push('---');
  md.push('');
  md.push('NO MIGRATION IN THIS REPOSITORY HAS BEEN APPLIED TO THE LIVE');
  md.push('PROJECT. This audit was produced on a disposable database and');
  md.push('proves things about PostgreSQL, not about production.');
  md.push('');

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, md.join('\n'));

  const failed = rows.filter(r => !r.ok);
  const notRerunnable = rows.filter(r => r.ok && !r.rerunnable);
  console.log(`\nwrote ${OUT}`);
  console.log(`${rows.length} pending, ${failed.length} failed to apply, `
    + `${notRerunnable.length} not re-runnable, ${anonFns.length} anon-callable `
    + `functions, ${anonTables.length} anon-readable tables`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
