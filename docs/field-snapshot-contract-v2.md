# Field work snapshot v2 — complete Batch 9.2 read coverage

This is the local-cache follow-up to
[v1](field-snapshot-contract-v1.md), started from Codex's `1695ce6`.
The existing API shapes and four outbox handlers are unchanged. It introduces
no RPC, server schema, stock operation or client pricing calculation.

## Read boundary, size and age

The supplied brief names **16 snapshot reads**: two schedule reads, seven
visit reads and seven reference reads. `signedPhotoUrl` and `calculatePricing`
are separate media and server-pricing operations.

Preparation uses `listTodaysVisits`/`listUpcomingVisits` results, deduplicates
job IDs, enforces local-calendar today through the next seven days, and saves
at most 20 visits. The endpoint is exclusive midnight after the seventh day;
invalid, past and later dates are excluded and reported. This is a read
window, not an assignment policy. Visit reads remain `getJob`, `listSections`,
`listMeasurements`, `listNotes`, `listAttachments`, `listJobFlags`, `listQuotes`.
Job flags and their observation notes are available offline as read-only data.

Reference reads are `listServices`, `listModifiers`, `listSiteFactors`,
`listInspectionFlags`, `listServiceFlagMap`, `listPricingRules`, `getSettings`.
They have a separate capture time and seven-day expiry. Fresh references are
reused between preparations. Explicit Refresh offline reference data replaces
them without refreshing a visit or extending its 24-hour lifetime. Expired
references disable new measurement entry but leave fresh visit facts readable.
Cached pricing-rule metadata is never used to calculate an offline price.

All accounts' visit snapshots and reference records together are bounded to
10 MiB of JSON payload, including both parts of the current account. Older
other-account read caches may be evicted. The existing draft bounds (200
records, 100 KB each) and outbox bounds (200 actions, 50 MiB payload) remain
separate. Nothing deletes pending writes/drafts to make room for read caches.
IndexedDB overhead and browser/native backup storage are not JSON payload.

## Local database upgrade

`ns-field-work`, version 1 → 2:

| Store | Key | Value |
| --- | --- | --- |
| accounts | id | `{ id, version: 2, savedAt, window, jobs, today, upcoming }` |
| references | id | `{ id, savedAt, data: { services, modifiers, siteFactors, flags, flagMap, pricingRules, settings } }` |
| drafts | key | Existing account/job/kind draft, unchanged |

Only the reference store is added. Existing account snapshots and drafts are
not rewritten or deleted. A recent v1 snapshot can still open; its inline
references use the old capture timestamp until an online preparation completes
the reference set. `usableSnapshot()` joins the current account's fresh
references into the presentation value and exposes `refsSavedAt` and
`refsAvailable`. New persisted job entries include `flags` alongside the
existing fields. Snapshot and reference replacement commit in one transaction;
an incomplete read or aborted transaction cannot announce a successful save.

Logout/denied online reads purge both read stores for that account. Drafts and
the original `ns-field-outbox` survive for their original owner. Outbox version
2 and its v1 upgrade remain as described in v1; no fifth write type is added.
Denied replay also signals the field router to hide any already-open cached
screen for that owner. Its private DOM disappears immediately while owned
unsent actions and drafts remain available for later review.
An account retirement marker is stored locally before deletion. If IDB cleanup
fails, a reload still blocks that snapshot. Only a new complete authorized
preparation clears retirement; reference-only refresh cannot restore access.
If persistence in both local storage and IDB fails, the current realm still
blocks access; cross-restart persistence under that combined failure is not
qualified. This is not a secure device vault or instantaneous offline revocation.

## Storage failures

An IndexedDB upgrade blocked by another tab rejects its waiting callers too.
Further opens do not hang behind the blocked request. IndexedDB cannot cancel
that request, so late success closes its connection and releases the guard;
retry then opens normally. Other open failures release the guard immediately.
The startup screen tells the user to close other tabs when that is the cause.
Offline mode does not relabel quota or blocked-upgrade failures as network loss.

Missing work storage shows Work unavailable offline. Separately retained
outbox bytes are still available. This does not recover data if the operating
system/browser deletes the outbox itself. Storage errors, persistence-request
denial and empty stores are visible; permanent retention is not promised.

## Media and backend authority

Expiring signed media URLs are never prefetched or persisted. Existing server
photos retain metadata only, show Preview needs a connection offline, and
get newly signed URLs whenever their online view opens. Pending captured
photos retain actual Blob bytes in the original account-owned outbox and
render local previews after restart. Media inspection tests verify fresh
signing calls, not a live storage provider.

The pinned SDK namespace/session binding, 24-hour cached-access limit,
server-read replay checks, passport conflict handling, uncertain-send review
and signature-path reconciliation from v1 remain. The backend on this branch
is still admin-only; no browser fixture establishes assigned-crew RLS. Offline
revocation cannot be discovered immediately. Read snapshots are not a new
login or an authoritative current offer.

The brief's description of `callOrQueue` is the **8.2 behavior**. In the
already-pushed 9.2 baseline, supported online writes also commit their payload
before network I/O. This preserves interrupted sends. Immediate validation/RLS
errors still rethrow and are visibly reported; their payload stays retained
for review. It is not silently reported as a successful deferred save.
Existing append/upload APIs still lack a general exactly-once guarantee.

## Storage decision and qualification

| Requirement | IndexedDB used here | Native SQLite alternative |
| --- | --- | --- |
| Process restart | Real Chromium process-close/reopen test passes; Android unrun | Requires bridge/plugin/device qualification, unrun |
| Storage pressure | Enforced read/draft/outbox limits; quota and blocked/aborted transactions tested; eviction remains possible | Still needs capacity/full-disk handling; a native file does not remove that requirement |
| Photos | Existing durable Blob queue, with no second sender or payload migration | Requires a Blob/file representation and atomic file/DB lifecycle preserving existing captures |
| Packaging | No new native dependency; existing Capacitor packaging retained | Adds a version-matched native plugin, platform wiring and build/upgrade checks |
| Existing installs | In-place additive upgrades preserve snapshots, drafts and v1 queued bytes | Needs an independently verified migration and recovery path before replacing the existing engine |

Keep IndexedDB for this browser-testable batch. This is a measured continuity
decision, not a claim that Android eviction/restart requirements are qualified.
SQLite/Room are not adopted without that evidence. Android SDK/device and iOS
compile checks remain unrun. The browser uses local HTTP assets to represent
the packaged shell; no ordinary website offline shell or basemap is added.

See [findings and reproduction](../tests/offline-work.md) for the passing
checks, deliberate failure probes and separately selectable integration suites.
