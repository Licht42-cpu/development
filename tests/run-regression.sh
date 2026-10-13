#!/usr/bin/env bash
# Explicit browser/local integration suites from both tracks. Database
# suites remain in tests/db/run-db-tests.sh: they require a separately
# guarded disposable database. Never use a blanket test-file glob here.
#
# Requires: python3 (serves the repo statically on :8743) and the
# Playwright browser pinned at PLAYWRIGHT_CHROMIUM (see test-harness.mjs
# and each screenshot-*.mjs for the same path) -- both already present in
# the project's cloud dev container. On another machine, install
# playwright and adjust that path, or set PLAYWRIGHT_BROWSERS_PATH per
# Playwright's own docs.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Historical suites resolve their old absolute module paths via the owned
# loader. PLAYWRIGHT_MODULE/PLAYWRIGHT_CHROMIUM select the installed tools.
export NODE_OPTIONS="${NODE_OPTIONS:-} --loader=$PWD/codex-files/tooling/test-loader.mjs"
PORT=8743
exec 9>/tmp/nova-shield-regression.lock
flock -n 9 || { echo 'Another regression run owns the static server.' >&2; exit 1; }
SERVER_PID=''
PROBE=$(mktemp /tmp/nova-shield-server-check.XXXXXX)
trap 'rm -f "$PROBE"; if [[ -n "$SERVER_PID" ]]; then kill "$SERVER_PID" 2>/dev/null || true; fi' EXIT

# Reuse a matching server; never kill another task's process by name.
if curl -fsS "http://localhost:$PORT/scripts/verify-mobile.js" -o "$PROBE" 2>/dev/null; then
  cmp -s "$PROBE" scripts/verify-mobile.js || { echo 'Port 8743 serves a different checkout.' >&2; exit 1; }
else
  python3 -m http.server "$PORT" >/tmp/nova-shield-test-server.log 2>&1 &
  SERVER_PID=$!
  READY=0
  for i in 1 2 3 4 5; do
    if curl -fsS "http://localhost:$PORT/scripts/verify-mobile.js" -o "$PROBE" 2>/dev/null && cmp -s "$PROBE" scripts/verify-mobile.js; then READY=1; break; fi
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 1
  done
  [[ "$READY" == 1 ]] || { echo 'Static server failed to become ready.' >&2; exit 1; }
fi

FAILED=0
for f in phase2 phase3 phase4 phase5 phase6 phase7 phase8 phase9 phase10 phase10-5 \
         phase11 phase12 phase13 phase14 phase15 phase16 phase17 phase18 phase19 phase20 \
         phase21 phase22 phase23 phase24 phase25 phase26 phase27 phase28 phase29 \
         geofence native-wrapper reload-offline measurement-entry mobile-reliability \
         field-resilience native-readiness native-bundle native-packaging native-startup \
         offline-work load-prep field-evidence field-load field-completion field-dispatch \
         core-journey operations-integration; do
  echo "===== $f ====="
  if ! curl -fsS "http://localhost:$PORT/scripts/verify-mobile.js" -o "$PROBE" || ! cmp -s "$PROBE" scripts/verify-mobile.js; then
    echo 'Static server stopped or changed during the run.' >&2
    exit 1
  fi
  if ! node "tests/$f.test.mjs"; then FAILED=1; fi
  echo
done

exit $FAILED
