# Batch 12.2 — field dispatch and property instructions

Branch: `codex/batch-12-2`. Base: `c8666dd465defc1d8a7250d7253794d4c35f0e01`.
The requested `ae1efdd` base is its parent; the intervening commit adds only
the shared Claude 13.1 prompt. No Claude merge, rebase or cherry-pick.

Assignment read from `claude/batch-8-1@7a27bb3`,
`docs/prompts/codex-batch-12-2.md`. Dispatch v1 and findings read at
`b21d082`. The assignment's broad `admin/**` exclusion overlaps the user's
earlier explicit permission to edit Codex-owned field/mobile files; that
permission governs the narrow field changes here. Claude's admin/API,
migrations, contracts, fixtures/generator and backend suites stay untouched.

## What the field screen does

`Ordered day` in the field header opens `#/dispatch`. The legacy schedule
stays available and is explicitly described as device-calendar work. The
ordered screen selects a vehicle through the existing authorization helper
and uses `get_dispatch_day` for the operating-day window and stop order.
It neither sorts stale positions nor derives an order, ETA or travel distance.
The initial date is the device calendar date, labelled as such; selecting
the intended operating work date remains deliberate. UTC while unconfigured
is visible. Reassigned/invalidated confirmed loading history is displayed
with the owner rebuild requirement, not erased or reconfirmed.

Each stop has a collapsed, keyboard-accessible property/action disclosure,
read only when opened so the ordered list remains scannable. A lazy launcher adds the
same panel to the online/saved workspace without changing completion.
Entrance, hazard, parking, existing access note and customer note are distinct.
Only `get_property_access` reads the private code/internal note; they appear
behind an online-only disclosure and never enter the dispatch read cache.
Known numeric coordinates get an external navigation link. Missing/invalid
coordinates get no guessed destination. Owner-drawn geographic zones share
a schematic with the property pin; image zones use separate normalized
drawings named by their source. Neither represents surveyed boundaries,
geofences or licensed imagery. Keyboard-operable disclosures list every
vertex as text. The named reference image is unavailable, not fetched from
an invented storage path.

Issues use `report_job_issue` with the reason and explicit unknown catalogue
material (`null`); blocked access and breakdown remain distinct. The panel
reads commercial status, dispatch status, accepted completion and attributed
issue/resolution history separately. Clearing blocked work/resolving issues
is the owner's; the crew receives no override. Two deliberate SMS request
buttons use `request_job_notification`. Queued, delivered, provider-failed,
unknown and unavailable are labelled separately; a live same-kind request
blocks another tap. A fresh outcome read supersedes an older journal outcome.
No message is requested by opening a page, reading GPS or changing a route.

## Offline and uncertain work contract — field-owned v1

No dispatch outbox type was added. Dispatch mutations stay online-only.
`ns-field-work` remains version 2; its existing account-bound drafts store
one `dispatch-read/snapshot` and per-job `dispatch-operation`/`dispatch-arrival`
records. Existing completion outbox, account separation and upgrade guards
remain unchanged.

- Explicit Save re-reads the day and each scoped property before committing.
  One saved day, at most 20 stops, expires after 24 hours and is subject to
  the existing 100 KB draft limit. A different explicitly requested vehicle
  or date is refused instead of substituted. Pins, zones and operational
  notes survive restart without a basemap. Codes/internal notes are excluded
  through an allowlist. Offline status does not claim current authorization.
  Network failure while `navigator.onLine` remains true can open only the
  matching bounded saved day; it never substitutes details after a denial.
- A property/job/day `42501` retires the complete dispatch snapshot and the
  existing visit read cache, clears displayed details, and persists retirement
  before attempting deletion. Epoch/account checks prevent late reads/saves
  from reviving them. Drafts and queued actions stay with their original
  account. New successful full preparation can restore read access.
- Switching account or signing out clears private controls; a saved day
  cannot be opened by another account. Going offline strips revealed private
  fields immediately, including while an online read is finishing.
- An online issue/message request commits its original key and payload before
  I/O under a per-account/job Web Lock. `sending`/`no-response` block replacement
  requests; only deliberate recovery reuses the exact original request.
  Refusal, conflict, no response and acceptance are distinct. A failed receipt
  commit leaves the original request recoverable. There is no automatic replay
  or new parallel sender. Storage failure prevents an uncommitted send.

### Arrival deliberately remains local

There is no backend arrival RPC/state in dispatch v1. The crew can check
"I am at this property" and record a local report after scoped access, or
provisionally from a still-valid offline snapshot. This stores device-reported
time, `local-crew-report`, `locationVerification: not_verified` and
`serverReceipt: null`. It is labelled **not synced; location not verified**.
It does not set job status, dispatch stage or completion, make a geofence,
invoke GPS, trigger a message or enter the outbox. No server arrival history
is claimed. A future backend arrival operation needs a versioned contract;
this local report must not be mistaken for an accepted server fact.

The legacy foreground proximity helper remains; its banner now reads
"Near scheduled site — Review Visit", replacing "Arrived at Site".
Its existing unavailable-position behavior is preserved and its test is
updated to pin the honest wording. No new geofence or background tracking.
The native-readiness Tab-order check now asserts the new Ordered day link
before the existing loading entry and badge; it preserves the previous
focus and badge-ring assertions rather than omitting those checks.

## Maps/navigation decision and evidence

No Maps SDK, dependency or map-provider account is needed for this batch.
Local SVG/text drawings implement offline pins/zones; no tiles, basemap,
satellite imagery, routing or navigation-app offline maps are cached.
Geographic diagrams fit latitude/longitude independently, explicitly **not
to scale**, north up; they are instructions rather than measurements.

External handoff uses an HTTPS Google Maps destination link. The browser
link has `noopener noreferrer`; native uses same-window navigation because
a WebView has no browser tab strip. The installed Capacitor Android 8.5.2
source, `BridgeWebViewClient.shouldOverrideUrlLoading` → `Bridge.launchIntent`,
routes non-allowlisted external hosts to `Intent.ACTION_VIEW`. It catches
`ActivityNotFoundException` without a result callback, so successful app
launch/navigation availability is **not** claimed. Actual Android handoff
is UNRUN. Cached destination data is labelled separately from availability
of an external app and its offline routing capability.

Attempted provider documentation:
`curl -I -L --max-time 20 https://developers.google.com/maps/documentation/urls/guide`
was rejected by the egress proxy: **HTTP 403 Forbidden, curl (56), CONNECT
tunnel failed** for `developers.google.com`. No TLS/proxy bypass was used.
No provider SDK licensing, provider sandbox or offline imagery support was
verified. The verified capabilities here are browser rendering/link contents
and local pinned native source inspection, not provider/device execution.

## Authorization difference remains Claude's

The single active vehicle default allows the scoped property read. With a
second active vehicle an unassigned job can be denied by `ns_can_work_job`
and `ns_can_see_property`. The field renders that refusal, retires previous
details and requires the owner to check assignment. Browser doubles cover
the allowed one-vehicle read followed by a two-vehicle denial; they do not
prove the database's rule. No backend policy was changed.

Completion v1's older `can_work_job` still has different unassigned-job
semantics from dispatch's new `ns_can_work_job`. This is the already
acknowledged backend reconciliation for Claude before a second crew is enabled;
the field does not route around a refusal. No new contract shape is invented.

The dispatch document's §6 describes property scope as work on any date,
but the unassigned-job qualification also lives in
`20261016100000_batch12_1_property_access_and_zones.sql:52` at `b21d082`.
The job counterpart is
`20261016110000_batch12_1_job_issues_and_notifications.sql:152`.
The later assignment explicitly supplies that qualification; backend policy
reconciliation remains Claude's. Image zones supply a named source but no
authorized image-fetch contract; the field consequently shows the normalized
drawing/reference, not a fabricated photograph or georeferenced overlay.

## Corrections found during this implementation

Browser checks caught the issue selector's ambiguous accessible name; it
now has an explicit label. A network-error classifier was masking an offline
vehicle/date mismatch; cache validation errors now remain visible. The
online-but-unreachable case was initially not using saved dispatch data;
it now opens only a matching bounded snapshot without write controls.

Visual review folded the stop panels to keep the day scannable. Screenshot
review also caught a test-fixture width argument applied to the wrong helper;
the final suite asserts the actual viewport width, and screenshots were
regenerated at 390, 430 and 1280. Sticky header capture interference was
removed by taking document-coordinate clips from the top of the page, not
by hiding product controls.

A scoped property denial initially left the older workspace controls visible;
it now closes them. That change first interfered with the legacy router's
error mount, then the offline regression exposed a lost-draft check during
overlapping cleanup. Cleanup now distinguishes the scoped property refusal
from the existing outbox event, avoids duplicate retirement of the legacy
store, and preserves its established refusal UI and drafts. The affected
offline suite was rerun; final results below distinguish it from those
earlier failures. The missing-draft check passed when run independently;
no prior deletion path was conclusively identified. The full 47-check run
passed after the cleanup was simplified. The initial registered runner launch also required the
documented `PLAYWRIGHT_CHROMIUM=/usr/bin/chromium` override; no checks from
that failed launch are counted as passed.

## Reproducible verification and integrator list

Use a static server at repository root, port 8743, Chromium and Playwright:

```sh
export PLAYWRIGHT_MODULE=/workspace/.nova-shield/test-tools/node_modules/playwright/index.mjs
export PLAYWRIGHT_CHROMIUM=/usr/bin/chromium
export NODE_OPTIONS='--loader /workspace/nova-shield/codex-files/tooling/test-loader.mjs'
node tests/field-dispatch.test.mjs
```

Add **field-dispatch** to the integrator's selectable mocked browser list;
`tests/run-regression.sh` is unchanged. Existing extra suites remain:
field-completion, field-evidence, field-load, load-prep, offline-work,
field-resilience, mobile-reliability, native-readiness, native-startup,
native-packaging and native-bundle. Backend suites stay separately selectable.

`tests/data/field-dispatch-v1.json` is a byte-identical, read-only fixture
snapshot of `b21d082:tests/fixtures/dispatch-v1.json`, all nine scenarios;
SHA-256 `a476a4791a28f28377e6b8de9a9126ae88922f012aa3961e5514518ad7a5aabf`.
Fixtures carry synthetic codes, not production credentials. Test adapters
normalize pseudonymous ids for the existing UUID router but preserve wire
states/shapes; mocked receipts do not establish database authorization.

Declared fault injection, separate from the normal run: `DISPATCH_BREAK=secrets
DISPATCH_ONLY='saved cache excludes'` deliberately adds private fields to the
cache allowlist. The single privacy test must fail (0 pass / 1 expected fail).
Its output is recorded separately; it is never counted as a passing suite.

## Final verification

| Check | Final result |
|---|---|
| New field-dispatch suite | **45 passed / 0 failed / 0 skipped** |
| Registered regression | 391 passed, plus geofence; 0 failed |
| Completion / evidence / load / load-prep | 35 / 31 / 41 / 16 passed |
| Offline / resilience / mobile | 47 / 27 / 22 passed |
| Readiness / startup / packaging / bundle | 24 / 18 / 19 / 10 passed |
| **Counted local checks** | **726 passed / 0 final failures / 0 skipped**, plus geofence |
| Declared privacy fault injection | 0 passed / **1 expected failure**, separate from the normal counts |
| Visual and keyboard QA | 390 / 430 / 1280, actual viewport asserted; 12 regenerated screenshots, no horizontal overflow |
| Capacitor sync + production guard | Passed, 160 fresh assets, Android copy/resources verified |
| Gradle debug assemble | Passed offline; 211 tasks, 22 executed / 189 up-to-date |
| APK contents + debug signature | All 161 staged files match the ZIP bytes; v2 debug signature verified |
| Disposable backend / migration rehearsal | **UNRUN** |
| Live Supabase / production | **UNRUN** |
| Real provider delivery / emulator / physical Android | **UNRUN** |

The repeated targeted/visual checks are not added twice to the 726 total.
Evidence: `codex-files/artifacts/batch-12-2/verification.json`, individual
logs, `results.json`, the separate fault-injection results, screenshots,
`apk-assets.json` and debug signature/assembly logs. The APK stays local;
its hash is recorded, and no APK binary is published.

Twenty-four migrations were reported pending by Claude; no live query or
migration was performed here. The backend permission reconciliation,
reference-image access contract, actual external-navigation availability,
provider configuration and a future server arrival operation remain outside
the verified field result. Pricing/backend/admin-owned files, frozen
contracts, backend tests and the global regression runner remain unchanged;
`protected-files.txt` records the empty diff against the base. No merge,
deployment, external message or APK publication. Stopped after 12.2.
