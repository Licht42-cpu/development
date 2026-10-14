# Nova Shield field support and recovery v1

This supports the local Batch 15.2 candidate on `codex/batch-15-2`, with
unchanged Claude source pinned to `5169d7bf18e99e10855b47da2d12308d886f0fc9`.
It is not a release, migration instruction or proof of handset operation.
Build/results and the exact candidate/APK binding are in
[Batch 15.2 findings](batch15-2-findings.md).

## Current availability

**The 31 pending backend migrations have not been applied to the live project.**
Inventory, dispatch, property access/work zones, materials, completion evidence
and customer handover are reachable, but their new backend features are
expected to say **unavailable** until the owner applies and verifies the chain.
Do not use browser fixture screenshots as evidence those features work live.
Four anonymous read-only live probes returned `404 / PGRST202`; authenticated
screen verification and migration-history verification were not performed.

[Backend release runbook v1](release-runbook-v1.md) is the authority for
application order, stopping/recovery, owner settings and the second-crew
sequence. Its local PostgreSQL results are not live Supabase results. The
missing notification sender and document-signing worker, unset payment/SMS
providers, operating timezone and other owner settings remain limitations
even after the migrations. Applying a chain does not send a queued message,
sign a document or settle a payment.

## Before leaving Base

Sign in with your own authorised account while connected. Open the day's
assigned work, use the field console's preparation controls, and verify the
saved-work result before relying on it offline. Confirm the displayed vehicle,
date, freshness and operating-day notice. Until the owner configures the
operating timezone, the backend's day is UTC; do not reinterpret a neighbouring
day's work as today's assignment.

Keep/Add/Return is a recommendation until the backend accepts its confirmed
operation. A saved count draft is not a posted count. Physical arrival remains
a local crew report: **not synced and not location-verified**. A coordinates
reading never proves arrival. Navigation hands off to another app; offline
basemap/imagery support is not promised.

## Read the status literally

| Display | Meaning and next step |
| --- | --- |
| Checking device queue… | Local queue initialisation has not completed. |
| No queued actions | This device account's general outbox is empty. It does not establish server freshness, successful delivery or another workflow's receipt. |
| Offline / saved here | Work is retained locally where the save succeeded; it has not been accepted by the server. |
| Pending sync / Syncing | Actions are waiting or being attempted. Keep the app/account available; acceptance is not yet established. |
| Sync failed / Device storage unavailable | Open the saved-action list and read the cause; follow the relevant recovery below. |
| No response — outcome unknown | The request might have been accepted. Preserve its original operation key and payload; avoid a new duplicate operation. |
| Refused / Conflict | The server answered. A refusal needs authorisation resolution; a conflict needs fresh state and review. |
| Accepted / Server receipt | Inspect the returned receipt for that specific load/closing/completion operation. A queue count alone is not this evidence. |

The general sync badge is not an aggregate delivery indicator for load,
closing, dispatch, local notes and every other workflow. Consult each screen's
status and receipt. Browser fixture acknowledgements used in qualification
are doubles; no live sync success is claimed.

## Queue will not drain

1. Tap the sync badge to inspect **Saved on this device**. Note the action,
   status, job and visible reason without copying private access codes or
   customer tokens into support messages.
2. Restore connectivity and remain signed in as the account that created the
   work. Use **Sync Now** when offered. Another account must not replay your
   pending actions.
3. For storage/blocked-upgrade errors, close other copies/tabs of the app and
   retry. Use startup Retry for an interrupted module/storage startup. Updating
   to a compatible build is required for a newer unsupported store format.
4. A refused job needs current owner assignment/permission resolution. A
   conflict needs review of current server state. Neither is a network retry.
5. For an uncertain send, check the actual operation/job result with the owner
   before using **Review and retry**. Preserve the original key. Do not discard
   retained work merely to make the badge empty.

Do not clear app data, browser storage or reinstall as a queue repair. These
can erase unsent payloads, draft notes and original photo bytes. Support should
record the candidate version, visible status and the affected workflow; never
request passwords, bearer tokens or access codes.

## A screen says unavailable

Read the named feature and reason. Missing backend means owner verification
of the pending chain/schema cache; **Check again** is a read, not an apply.
Offline means the management feature cannot make its required online check.
Denied means the server refused access; cached working details do not bypass
it. Owner-only management means use the field console. Timeout/unconfirmed
means availability has not been established.

Routes remain visible. No stock totals, load plans, report results or server
receipts are synthesised to fill the unavailable screen.

## A photograph will not attach

Check whether the original is **saved locally**, **pending/uncertain**, or
confirmed as an attachment. Inspect its local preview and saved-action status.
If local storage refused the save, the app must not promise durability; retain
the original separately and seek support before leaving the screen or
reinstalling. A lost upload response may leave an upload already accepted:
check the job's current attachments before a reviewed retry.

Customer publication is a separate owner decision. A saved/attached photo does
not mean a customer can download it: the signing worker is absent. Actual
camera permissions, cancellation, share-sheet URI access and interrupted
cellular uploads remain handset cases, not established browser behavior.

## Restart, reinstall or account change

Retry/reopen preserves work only when local storage already committed it and
that storage remains available. Browser process restart retained a prepared
snapshot and original photo Blob in the qualification fixture; Android
process death, eviction and reinstall recovery remain UNRUN.

Reinstalling/clearing data has **no guaranteed recovery of unsent local work**.
Already server-accepted records can be read again only with current
authorisation and a working backend. Never infer that an empty queue after
reinstallation means the old work was sent.

Sign-out/account switching separates cached work and pending actions. Return
to the original authorised account to review its work. A permission denial
retires cached private working details while preserving unsent work for
review; do not use stale data to continue on a refused job.

## The crew is told a job is not theirs

Use [release runbook §5](release-runbook-v1.md#5-before-a-second-crew-is-enabled).
The reviewed source uses one crew-scope rule for completion and dispatch.
With two active vehicles, unassigned work belongs to neither car; an owner
assigns it, or the backend's scoped claim operation resolves it onto the
caller's own car. A crew cannot take it off another car or claim for another
car. Do not activate Car B to test this on the live project.

After the owner applies and verifies the chain, open **Management**, then
**Menu → Dispatch**, choose your vehicle/day and use **This one is on my car**
for unassigned work. Dispatch now makes a fresh admin check and a scoped day
read; owner assignment/reordering controls stay absent for crews. Inventory
and the other management panels retain their owner gate. The field dispatch
screen itself has no claim button; the management dispatch screen is the
entry. Until its backend is available, ask the owner to resolve assignment.
Some
existing backend refusal messages still incorrectly say "assigned to another
vehicle" for unassigned work; the authoritative scope reason distinguishes it.

## Phone use and known limits

Keyboard focus/names, layout and visible control targets were checked at
390/430/1280. Back/contact links now meet the project's 44px target alongside
buttons. Full-page captures and accessibility snapshots are retained.
**Glove usability and outdoor legibility are design review only:** larger
targets and visible focus help, but sunlight, wet/gloved hands and real
TalkBack have not been tested.

Claude-owned material creation still omits litres, kilograms, sticks and level
tracking; the property view still prints `null`; admin Daily load still resets
vehicle/day on reload. Report these rather than improvising units or data.
Supplier pack sizes/specifications, chemical dosages, renewal cutoffs and the
Permanent Lighting Phase D document remain unknown.

All 16 cases in [the handset checklist](plans/android-core-qualification.md)
remain **UNRUN: no Android target supplied**. They include cold/background
restart, hardware/gesture Back, camera, TalkBack, storage eviction, account
changes and cellular replay. The built APK has not been installed on an
emulator or device. Batch 14.2 was not authorised and has no added test cases.
No live migration, settings/grants/data change, message, merge, deployment or
APK publication is part of this runbook.
