#!/usr/bin/env bash
# Runs every disposable-database suite, each against a FRESH database.
#
#   npm run test:db
#
# Why re-create the database between suites rather than run them back to
# back: each suite installs its own fixture schema, and the two fixtures
# define overlapping table names with different shapes (Batch 7.1 needs the
# legacy jobs/quotes tables and a cut-down ns_quotes; Batch 8.1 needs
# ns_jobs, services and job_measurements). Sharing one database would make
# the result depend on the order they ran in, which is the kind of
# cross-contamination these suites exist to rule out.
#
# Every suite refuses to run against anything but the dedicated disposable
# database -- see tests/db/disposable.mjs. Override the target with PGURL
# and the maintenance connection with PGADMIN_URL.

set -euo pipefail
cd "$(dirname "$0")/../.."

SUITES=(
  tests/db/batch7-1.test.mjs
  tests/db/batch8-1.test.mjs
  tests/db/batch9-1.test.mjs
  tests/db/batch9-1-lighting.test.mjs
  tests/db/batch10-1.test.mjs
  tests/db/batch11-1.test.mjs
)

failed=0
for suite in "${SUITES[@]}"; do
  echo "=============================================================="
  echo "  $suite"
  echo "=============================================================="
  node tests/db/setup-test-db.mjs >/dev/null
  if node "$suite"; then
    echo
  else
    failed=1
    echo "FAILED: $suite"
    echo
  fi
done

exit "$failed"
