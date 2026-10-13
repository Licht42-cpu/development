// Guard rails for the Batch 7.1 database tests.
//
// WHY THIS IS NOT A BLACKLIST ANY MORE.
//
// The first version of this check refused connection strings containing
// "supabase.co", "supabase.com" or "pooler.supabase" and allowed everything
// else. That is backwards: the fixture runs `drop table ... cascade` against
// names that exist in the real application (ns_quotes, job_requests, jobs,
// quotes), so ANY database that was not specifically created to be destroyed
// is the wrong target -- a self-hosted Postgres, a staging box, a developer's
// local copy of the app, all of which sailed past a Supabase-shaped filter.
//
// The rule is now positive identification, in two stages:
//
//   1. assertDisposableTarget(url) -- PURE. No I/O, no DNS, no connection.
//      The host must be local and the database must be the one dedicated
//      name below. Because it touches nothing, its refusals can be tested
//      against remote-looking URLs without ever contacting a remote host.
//
//   2. assertDisposableDatabase(client) -- run after connecting, BEFORE any
//      fixture SQL. Confirms the server agrees it is that database and that
//      it carries a marker written only by setup-test-db.mjs. A database
//      that merely shares the name, but was not created by the harness, is
//      still refused.
//
// Both must pass before a single destructive statement runs.

export const TEST_DB_NAME = 'nova_shield_batch7_1_test';

/** Written as a COMMENT ON DATABASE by setup-test-db.mjs. Its presence is
 *  what distinguishes a database created to be destroyed from one that
 *  happens to have the same name. */
export const DISPOSABLE_MARKER = 'NOVA-SHIELD-DISPOSABLE-TEST-DB';

export class NotDisposableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotDisposableError';
  }
}

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);

/** Pulls host and database out of either connection-string shape:
 *    postgresql://user@localhost:5432/dbname
 *    postgresql://user@/dbname?host=/tmp&port=5433     (unix socket)
 *  Returns { host, database, isSocket }. Throws on anything unparseable. */
export function parseTarget(urlString) {
  if (typeof urlString !== 'string' || urlString.trim() === '') {
    throw new NotDisposableError('No connection string was supplied.');
  }

  // WHATWG URL rejects `user@` with an EMPTY host for non-special schemes, so
  // `postgresql://postgres@/db?host=/tmp` -- the unix-socket form libpq and pg
  // both accept, and the one this harness uses by default -- would be thrown
  // out as unparseable. The userinfo carries nothing this guard needs, so it
  // is stripped from the authority before parsing. Splitting on the LAST `@`
  // in the authority keeps a password containing `@` from confusing it.
  const stripped = urlString.replace(
    /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/?#]*)/,
    (_, scheme, authority) => {
      const at = authority.lastIndexOf('@');
      return scheme + (at === -1 ? authority : authority.slice(at + 1));
    });

  let url;
  try {
    url = new URL(stripped);
  } catch {
    throw new NotDisposableError(`Connection string is not a URL: ${urlString}`);
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new NotDisposableError(`Not a PostgreSQL connection string: ${url.protocol}`);
  }

  // A `host=` query parameter beats the authority, which is how libpq
  // addresses a unix socket directory.
  const socketHost = url.searchParams.get('host');
  const host = socketHost !== null && socketHost !== '' ? socketHost : url.hostname;
  const isSocket = host.startsWith('/');
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));

  return { host, database, isSocket };
}

/** Stage 1. Pure: throws NotDisposableError, touches nothing. */
export function assertDisposableTarget(urlString) {
  const { host, database, isSocket } = parseTarget(urlString);

  if (!isSocket && !LOCAL_HOSTNAMES.has(host.toLowerCase())) {
    throw new NotDisposableError(
      `Refusing a non-local database host: "${host}". These tests drop tables; ` +
      'they may only run against a local, disposable database.');
  }

  if (database !== TEST_DB_NAME) {
    throw new NotDisposableError(
      `Refusing database "${database || '<none>'}": these tests may only run against ` +
      `the dedicated database "${TEST_DB_NAME}". Create it with:\n` +
      '    node tests/db/setup-test-db.mjs');
  }

  return { host, database, isSocket };
}

/** Stage 2. Confirms the connected server really is the disposable database,
 *  not merely one reached by a string that looked right. Call this before any
 *  fixture SQL. */
export async function assertDisposableDatabase(client) {
  const { rows } = await client.query(
    `select current_database() as db,
            shobj_description(oid, 'pg_database') as marker
       from pg_database
      where datname = current_database()`);

  const { db, marker } = rows[0] || {};

  if (db !== TEST_DB_NAME) {
    throw new NotDisposableError(
      `Connected to "${db}", not "${TEST_DB_NAME}". Refusing to run destructive SQL.`);
  }

  if (marker !== DISPOSABLE_MARKER) {
    throw new NotDisposableError(
      `Database "${db}" does not carry the disposable marker, so it was not created ` +
      'by this harness and may hold real data. Refusing to run destructive SQL.\n' +
      'Create a clean one with:\n' +
      '    node tests/db/setup-test-db.mjs');
  }
}
