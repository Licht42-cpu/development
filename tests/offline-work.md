# Batch 9.2 — durable field work and write recovery

Started from `1e320a6fe25ec182ac89a9846c4b3dbc931eec2d` on the clean Codex
8.2 branch; implementation branch is `codex/batch-9-2-offline-work`.
The fuller brief was reconciled from the already-pushed `1695ce6`.
Repository instructions and the post-Batch-7 roadmap were read first.
Claude's `4c2e9be` operations contract was fetched and inspected read-only.
No Claude implementation was merged, rebased or made a runtime prerequisite.

The field read/cache boundary and recovery guarantees are documented in
[field-snapshot-contract-v2](../docs/field-snapshot-contract-v2.md). The earlier
[v1 contract](../docs/field-snapshot-contract-v1.md) remains historical. Changes
stay in Codex-owned field/mobile modules, their tests and documentation.
`api.js`, backend pricing/migrations, shared DOM/format/harness, admin operations
views and the regression runner are unchanged.

## Behavior

Save work for offline prepares at most 20 authorized schedule visits, with
addresses, passport/access facts, notes and measurement/reference data.
Preparation is explicit, bounded and atomic. Restart opens a saved schedule
and individual visits, with freshness and offline limits shown. Pending
property facts, new measurements and photo bytes remain visible after restart.
Note/passport drafts are retained by account; note delivery is still online.
The horizon is today plus seven days, deduplicated before the 20-visit bound.
Job flags and their observations are saved read-only. All seven reference
reads, including pricing-rule metadata, have a separate seven-day age; they
are reused while fresh and can refresh without changing visit facts/age.
Expired references block new measurements while fresh visit facts remain
readable. Snapshots and references share the enforced 10 MiB read limit.

The original outbox is migrated locally in place, preserving old records.
New actions carry an owner and commit before sending. Cross-tab replay uses
Web Locks. Unowned legacy records cannot automatically replay under the next
login. Account changes close private overlays and reject delayed old-account
actions. Logout removes read snapshots but preserves owned drafts/actions.

Job access is rechecked before replay. Passport conflicts stop replay while
unrelated server edits survive. Lost/interrupted append/upload responses require
explicit review. Known signature uploads resume without a second upload and
can recognize an already-saved matching server signature. The server APIs
still do not provide a general exactly-once or compare-and-swap guarantee.

## Reconciliation with the supplied brief

The first implementation omitted `listJobFlags` and `listPricingRules`, and
gave references the visit timestamp. Those are completed here using existing
APIs. The named contract contains 16 snapshot reads (two schedule, seven visit,
seven reference), plus media and pricing; no purpose-built snapshot RPC is
needed. Existing server photos are re-signed when their online view opens;
expiring signed URLs are not prefetched or stored.

The blocked-upgrade probe found an actual bug: concurrent opens queued behind
a blocked IndexedDB request could wait indefinitely. They now receive the
pending attempt's failure, close its late successful connection, and allow
retry. Local storage errors were also masked as connection loss when offline;
the router now preserves their storage cause. Startup gives a close-other-tabs
instruction for a blocked upgrade. Aborted commits cannot announce saved work.
Denied replay also removes an already-open cached visit from the screen;
deleting the stored snapshot alone previously left its private DOM visible.
The new check proves immediate hiding while retaining the unsent draft/action.
Account retirement is also marked before deletion so failed IDB cleanup cannot
reopen known-denied work on reload. A new complete authorized preparation is
required to restore access; reference-only refresh cannot do that.

`ns-field-work` upgrades additively from 1 to 2, retaining populated snapshots
and drafts and adding a reference store. The outbox database version stays 2;
its v1 upgrade still preserves old payloads/photo bytes. The storage comparison
and reasons for retaining IndexedDB are recorded in contract v2.

The prompt describes 8.2's queue-on-network-failure behavior. The actual 9.2
baseline already persisted supported online writes before network I/O. This
follow-up preserves that recovery behavior and visible immediate validation/RLS
failures. It adds no offline stock action.

## Reproduce

Use Node 24, the locked dependencies, Python 3, Playwright and Chromium.
In this environment the restricted default npm home cache is unwritable:

```sh
npm ci --cache /workspace/.nova-shield/npm-cache
npm run cap:sync
npm run verify:mobile
python3 -m http.server 8743 --bind 127.0.0.1
```

In a second shell:

```sh
export PLAYWRIGHT_MODULE=/workspace/.nova-shield/test-tools/node_modules/playwright/index.mjs
export PLAYWRIGHT_CHROMIUM=/usr/bin/chromium
node tests/offline-work.test.mjs
node --loader ./codex-files/tooling/test-loader.mjs tests/mobile-reliability.test.mjs
node --loader ./codex-files/tooling/test-loader.mjs tests/field-resilience.test.mjs
node --loader ./codex-files/tooling/test-loader.mjs tests/native-readiness.test.mjs
node tests/native-startup.test.mjs
node tests/native-bundle.test.mjs
node tests/native-packaging.test.mjs
```

The regression runner manages/stops its own server. Run it separately from
the above tests to avoid stopping their shared static origin:

```sh
NODE_OPTIONS='--loader /workspace/nova-shield/codex-files/tooling/test-loader.mjs' bash tests/run-regression.sh
```

The new suite is deliberately not registered by editing the shared runner;
the separately authorized integrator should register `offline-work` alongside
the previously unregistered Codex suites. Database tests remain separate.
The full integrator list is **offline-work, native-packaging, native-startup,
native-bundle, native-readiness, mobile-reliability, field-resilience**.
`measurement-entry` is already registered on this branch.

`OFFLINE_EVIDENCE` selects screenshot output. `OFFLINE_ONLY` selects a named
test. Isolated browser fault probes use `OFFLINE_BASELINE=1` to restore 8.2
product sources, or `OFFLINE_BREAK=owner` to remove owner filtering from the
real queue module. The selected preparation/restart and account-separation
tests fail, respectively, without changing the working checkout.

Recorded follow-up logs, results and screenshots are in
`codex-files/artifacts/batch-9-2-read-contract/`. Initial 9.2 evidence remains
in `codex-files/artifacts/batch-9-2-offline-work/` and is not rewritten.
Intentional failure logs are separate from passing final verification.

## Recorded verification

| Suite | Passing checks |
| --- | ---: |
| Registered regression suites | 391 |
| Mobile reliability | 22 |
| Field resilience | 27 |
| Native readiness | 24 |
| Native bundle | 10 |
| Native packaging | 19 |
| Native startup | 18 |
| Offline work | 47 |
| **Total** | **558** |

Geofence also passes outside the counted suites. Fresh Capacitor sync and
the Android asset/resource guard verify 142 assets. Nine offline screenshots
were inspected; viewport checks cover 390, 430 and 1200px. Chromium is
151.0.7922.173 with Playwright 1.58.2. Each selected fault probe fails its
assertion (0/1); none is counted as a passing check.

| Fault (`OFFLINE_BREAK`, unless stated) | Selected check that must fail |
| --- | --- |
| `references`, `flags` | Saved job flags and pricing-rule metadata |
| `reference_age` | Expired references stop new measurements |
| `reference_reuse` | Independent refresh and reuse of fresh references |
| `horizon`, `budget` | Seven-day window and combined ten-megabyte bound |
| `commit` | Aborted transaction cannot announce a saved preparation |
| `atomic` | Failed preparation retains the previous complete snapshot |
| `migration`, `work_migration` | Populated outbox/work upgrades preserve bytes/drafts |
| `uncertain` | Interrupted send is retained without automatic replay |
| `lock` | Held server write plus another tab cannot duplicate the queue head |
| `blocked` | Starting outbox open function hangs behind a blocked upgrade |
| `storage_reason`, `storage_retry` | Storage cause is preserved and temporary failure retries |
| `revoked_view` | Denied replay hides the already-rendered private cached visit |
| `denial_marker` | Reload cannot reopen denied work after failed cache deletion |
| `signed_media` | Saved server photo never requests an expiring URL offline |
| `owner` | Another account cannot see the previous account's queue |
| `OFFLINE_BASELINE=1` | 8.2 has no saved-work preparation/restart |

Choose the corresponding test name with `OFFLINE_ONLY` and run the same suite.
These 20 overrides stay in isolated browser contexts; sources are never
temporarily reverted. The lock test holds an actual intercepted server write
while another tab requests replay, making overlap deterministic. The normal
full suite then runs against fixed sources. Permission/assignment and media
responses remain doubles, not live database or storage-provider validation.

A first heavily parallel native-readiness run missed Save note during keyboard
traversal (23/24); the standalone rerun passes 24/24, and an isolated traversal
reaches it. Its cause is not independently established. No keyboard, naming
or focus-ring assertion was weakened. Treat that timing observation separately
from the final passing verification. Explicit suites finish before the
regression runner replaces/stops their shared server.

## Limits and integration

The existing branch has admin-only authorization, not integrated crew RLS.
Neither mocked job access nor the real SDK test establishes live assignment
policies. Snapshots are authorized-read results, not a new client role system.
Offline permission revocation is not instantaneous; cached reads expire after
24 hours and denied online reads invalidate them.

IndexedDB survives the tested Chromium process restart, but browser/OS
eviction and native Android restart remain unverified. No SDK or physical
device is available for Android build/install/process tests. Ordinary browser
offline asset loading is not added; browser tests use a local asset origin to
represent the packaged shell. Existing server photo previews need network;
pending captured-photo bytes are local. Maps, pricing, status/completion,
note sending and fresh quote acceptance require connection.

Fresh Capacitor sync also registers the already-pinned App plugin in the
iOS Swift package manifest; iOS compilation and device behavior are unrun.
Legacy native photo backups are not deleted or automatically assigned; new
native backups use an account directory when an account is available. The
outbox remains the canonical committed pending-photo payload.

No live migrations, data/grant/settings changes, customer messages, merge,
deployment or APK publication occurred. Claude's unapplied migrations and
the prior customer-content freeze remain separate release items.

The next batch's missing contract inputs are recorded in
[Batch 10.2 contract readiness](../docs/plans/batch-10-2-contract-readiness.md).
Stock-operation v1 does not define daily load revisions/reservations, so no
new inventory queue action or guessed load RPC is added in this batch.
