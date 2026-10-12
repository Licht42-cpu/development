# Field evidence capture and reviewed dictation — owned workload increment

Historical increment, now carried into `codex/batch-11-2`. The completed
completion/evidence interface and current integrator list are in
[field-completion.md](field-completion.md). The raw-byte/dictation guarantees
below remain covered by the 31-check suite.

Base: **04b8b946b38bcd55641f88a543e8ed720bed5be4**. Branch:
`codex/field-evidence-capture`. This implements two independent field items
from the 11.2 workload while 10.2 still awaits Claude's load corrective.
It is not a claim that the entire completion/evidence batch is finished.

## Original photo retention

Field photo selection commits the unmodified selected/native-camera-output
File, its metadata and frozen tag/elevation before opening markup. Markup is
a separate prepared copy; it never replaces the original bytes. The original
is retained after successful or queued upload. Desktop's default photo flow
does not enable this field-only storage.

New local IndexedDB `ns-field-captures`, version 1, has one `captures` store
indexed by owner/job. It is capped globally at **40 records / 50 MB**, counting
original and prepared bytes. It refuses additional data rather than evicting
someone's originals. It has **no sender or automatic replay**. Captures belong
to the account and visit that selected them. Unknown/future database versions
fail opening without deletion. Removal of a local original requires
confirmation and leaves its independently committed outbox action intact.

Field Back/Escape or Keep draft dismisses markup without uploading. Unfinished
originals can be resumed after restart. The prepared bytes and submission
claim commit in the same transaction before handing off to the existing photo
outbox handler. A competing claim cannot change those bytes or post another
upload for the same capture. Interrupted/failed submissions offer review of
the saved outbox instead of automatically initiating a fresh upload.

Metadata distinguishes **device selection time** from **unknown capture
time**. File name/type/last-modified are preserved but are not promoted into
trusted capture timestamps. GPS is not fabricated: capture location remains
unknown; an explicit Record location at review records a separate observation
with device-reported coordinates/accuracy or denied/unavailable state. It is
never silently reclassified as the photo's geotag. The display is metadata,
not server verification or a watermark burnt into the original image.

The saved-originals panel provides original preview, metadata, unfinished
resume and confirmed local removal. Focus returns to the summary after
keeping a draft, and to Add photo after submission.

## Dictation review

Online and cached offline notes have a separate **Dictation — review first**
buffer. Speech starts only on an explicit button, with visible availability
and connection guidance. Unsupported engines have a typed review fallback.
Recognition stops on view removal or backgrounding; permission/engine/session
failures preserve earlier review words and do not send a note.

Raw words persist under the existing account/job-owned `dictation-review`
draft key. Recognition does not change or send the note. The user edits and
chooses Add reviewed text to note, sees the current Internal/Customer-visible
audience, and still uses the existing Save note action when online. Offline
transfer creates an unsubmitted note draft only.

Transfer waits for the existing note writer to COMMIT before clearing review
words, using the backward-compatible `retainNoteDraft(...).flush` handle.
Failed note storage leaves the review recoverable. In-flight recognition
callbacks are ordered; older/final callbacks cannot overwrite words edited
after stopping or a transfer already in progress. No note API, alternate
note writer or outbox action is added by the review component.

## Verification

| Suite | Current passed |
| --- | ---: |
| field-evidence (new) | 31 |
| offline-work | 47 |
| field-resilience | 27 |
| mobile-reliability | 22 |
| native-readiness | 24 |
| native-startup | 18 |
| load-prep | 16 |
| native-packaging | 19 |
| native-bundle | 10 |

The unchanged registered runner passes **391 checks plus geofence**, including
measurement-entry. Unique total across the runner and separately selected
owned suites is **605 counted checks plus geofence**; measurement-entry is not
counted twice. All selected current checks pass; none is skipped.

The new suite checks exact original bytes before markup, modified-copy
separation, frozen tag, Back/route interruption, reload, actual Chromium
process restart, future-store refusal, budget errors, deletion without losing
queued bytes, atomic competing claims and interrupted submission. It checks
review-only speech, audience selection, quota recovery, unsupported/denied
engines, SDK identity errors, account/job isolation, late/out-of-order callbacks
and offline note durability. Speech and location APIs are mocked; actual
recognition, native camera and permission dialogs are not qualified.

Three test-only mutations intentionally fail: corrupt original storage,
copy speech directly into the note, and disable late-result guards. Each
selected probe exits 1. These are expected failures, separate from the final
accepted runs. Early test failures exposed an existing label-name ambiguity
and an early rendering assertion; field selects now have explicit labels,
and the offline test waits for the asynchronously rendered note before keeping
its original content assertion.

Touch/keyboard targets, focus rings and overflow pass at **390/430/1200px**.
All six new screenshot views were inspected. Logs, screenshots, inspection
JSON and source hashes live in `codex-files/artifacts/field-evidence-capture/`.

Capacitor sync and the production guard pass with **146 assets**. Real Gradle
debug assembly passed, with 22 executed / 189 up-to-date tasks. APK inspection
compares **147 staged files** and **149 public APK files** including the two
empty native-generated Cordova stubs. Debug v2 signing verifies; no APK is
committed or published.

**UNRUN:** physical Android speech support, native capture/location permissions,
hardware Back/TalkBack, OS eviction and cellular behaviour; no emulator/adb
attempt was repeated. Live backend/storage/production and completion integration
are unrun. Prior offline-native-build qualification is historical, not rerun
here. Local browser restart is not an Android device/storage-eviction result.

## Boundaries and integrator handoff

The outbox stays at v3 with exactly its existing four action types. Its source
and schema were not changed. Claude-owned API, management/inventory components,
migrations, contracts, DB/fixture suites, shared helpers, global CSS and the
regression runner remain unchanged. No pricing, stock calculation, migration,
merge, deployment, customer message or environment-draft publication occurred.

Add **field-evidence** to the explicit mocked integrator suite list alongside
offline-work, load-prep, native-packaging, native-startup, native-bundle,
native-readiness, mobile-reliability and field-resilience. Keep SDK/build and
database jobs separately selectable. The runner was not edited.

This is a field capture/review increment, not server evidence registration or
accepted completion. It does not claim the originals satisfy any evidence
policy. Deliberate completion, evidence linking, consumption/history display
and integration with the frozen completion contract remain later 11.2 work.
10.2 stays gated until the corrected load contract and fixtures actually land.

The debug APK packages this Codex branch's API, **not Claude's newer API**.
Sync cannot import an unmerged branch: integration must reconcile API callers
and sync again before qualifying completion against 11.1's backend guards.
All Markdown handoffs and evidence are pushed to the shared repository.
