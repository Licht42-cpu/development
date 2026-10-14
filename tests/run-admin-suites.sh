#!/usr/bin/env bash
# The admin-console suites that are NOT in tests/run-regression.sh.
#
#   bash tests/run-admin-suites.sh
#
# WHY THEY ARE SEPARATE. phase22 onward test admin screens that the field
# track has not yet been integrated with; registering them in the main
# runner is part of the agreed integration change, not of any one batch.
# Until then they are run from here, so "not in the main runner" never
# means "not run".
#
# Requires python3 (serves the repo statically on :8743) and the Playwright
# install the main runner uses.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PORT=8743
pkill -f "http.server $PORT" 2>/dev/null || true
sleep 1
nohup python3 -m http.server "$PORT" >/tmp/nova-shield-admin-suites.log 2>&1 &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

for i in 1 2 3 4 5; do
  if curl -sS -o /dev/null -w '' "http://localhost:$PORT/admin/field.html" 2>/dev/null; then break; fi
  sleep 1
done

FAILED=0
for f in phase22 phase23 phase24 phase25 phase26 phase27 phase28 phase29 phase30; do
  echo "===== $f ====="
  if ! node "tests/$f.test.mjs"; then FAILED=1; fi
  echo
done

exit "$FAILED"
