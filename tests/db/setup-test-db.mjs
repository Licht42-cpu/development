// Creates (or recreates) the dedicated disposable database the Batch 7.1
// tests require, and stamps it with the marker they check for.
//
//   node tests/db/setup-test-db.mjs
//
// Connects to a MAINTENANCE database (postgres) purely to issue
// CREATE DATABASE. It never runs fixture SQL, so the destructive-target guard
// does not apply to this connection -- but the maintenance host must still be
// local, for the same reason.
//
// Point it somewhere else with PGADMIN_URL, e.g. for a TCP server:
//   PGADMIN_URL='postgresql://postgres@localhost:5432/postgres' \
//     node tests/db/setup-test-db.mjs

import pg from 'pg';
import { TEST_DB_NAME, DISPOSABLE_MARKER, parseTarget, NotDisposableError }
  from './disposable.mjs';

const ADMIN_URL = process.env.PGADMIN_URL
  || 'postgresql://postgres@/postgres?host=/tmp&port=5433';

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '']);

(async () => {
  const { host, isSocket } = parseTarget(ADMIN_URL);
  if (!isSocket && !LOCAL.has(host.toLowerCase())) {
    throw new NotDisposableError(
      `Refusing to create a test database on a non-local host: "${host}".`);
  }

  const client = new pg.Client({ connectionString: ADMIN_URL });
  await client.connect();

  // DROP then CREATE so each setup starts from a genuinely empty database
  // rather than inheriting whatever a previous run left behind.
  await client.query(`drop database if exists ${TEST_DB_NAME} with (force)`);
  await client.query(`create database ${TEST_DB_NAME}`);
  await client.query(
    `comment on database ${TEST_DB_NAME} is '${DISPOSABLE_MARKER}'`);

  await client.end();

  console.log(`Created disposable test database "${TEST_DB_NAME}" and stamped it.`);
  // Deliberately NOT `npm run test:db`. package.json is owned by the native/
  // packaging track under the revised roadmap, and its test:db script still
  // points at the Batch 7.1 suite alone -- running it would silently skip
  // everything added since. Changing that one line is an integration item;
  // until then this runner is the entry point.
  console.log('Run every suite, each against a fresh database, with:');
  console.log('  bash tests/db/run-db-tests.sh');
  console.log('Or one at a time:');
  console.log('  node tests/db/batch7-1.test.mjs');
  console.log('  node tests/db/batch8-1.test.mjs');
})();
