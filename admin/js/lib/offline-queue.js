import * as api from './api.js';
import { localAccount, accessDenied } from './field-identity.js';
import { forget } from './field-cache.js';

/** A bounded, honest offline outbox for the Field Console -- not a general
 *  sync engine. It covers exactly the four action types the field console
 *  needs to survive a dead driveway connection: Property Passport/checklist
 *  writes, adding a measurement, uploading a photo, and capturing a
 *  signature. Everything else (sending an email, building a quote from
 *  calculation, revisions) still needs a live connection, same as before --
 *  those aren't things a tech does standing at the truck with no signal.
 *
 *  Payloads commit before sending. Account-owned actions replay in order,
 *  one at a time across tabs, and are removed only after confirmed success.
 *  The existing server APIs are not exactly-once: an interrupted or lost
 *  response is held for explicit review before an append/upload is retried.
 *  Confirming that retry can create a duplicate. Signature upload progress
 *  is retained so a known successful upload does not need uploading again.
 *
 *  Replay stops at the first failure and leaves the rest of the queue
 *  intact and in order, rather than skipping ahead -- a later item might
 *  depend on an earlier one having actually landed (e.g. two measurements
 *  added in sequence), so reordering on partial failure would be worse
 *  than just trying again later. */

const DB_NAME = 'ns-field-outbox';
const STORE = 'queue';
const DB_VERSION = 2;
let storageError = null;
let opening = null;

function openDb() {
  // Do not queue more IDB opens behind a blocked upgrade. IDB cannot cancel
  // that request; waiters must receive its failure instead of hanging forever.
  if (opening) return opening.then(() => openDb());
  let blocked = false;
  opening = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const store = req.result.objectStoreNames.contains(STORE)
        ? req.transaction.objectStore(STORE)
        : req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      if (!store.indexNames.contains('ownerId')) store.createIndex('ownerId', 'ownerId');
      // v1 records remain byte-for-byte intact and unowned. Never claim
      // somebody else's saved payload merely because they signed in next.
    };
    req.onsuccess = () => { opening = null; if (blocked) { req.result.close(); return; } req.result.onversionchange = () => req.result.close(); resolve(req.result); };
    req.onblocked = () => { blocked = true; reject(new Error('Close other app tabs and retry device storage.')); };
    req.onerror = () => reject(req.error);
  }).catch(error => { if (!blocked) opening = null; throw error; });
  return opening;
}

async function withStore(mode, fn) {
  let db;
  try {
    db = await openDb();
    const result = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const result = fn(store);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    if (storageError) { storageError = null; notify(); }
    return result;
  } catch (err) {
    const message = err?.message || 'Device storage is unavailable.';
    if (storageError !== message) { storageError = message; notify(); }
    throw err;
  } finally {
    db?.close();
  }
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* Handlers are the REAL api.js calls -- the outbox never re-implements the
   write, it just defers calling the real thing. args must be structured-
   cloneable (plain objects, strings, numbers, Blobs/Files -- all fine for
   IndexedDB; functions and class instances are not). */
const HANDLERS = {
  updateProperty: (args) => api.updateProperty(args.id, args.patch),
  createMeasurement: (args) => api.createMeasurement(args.jobId, args.measurement),
  uploadJobPhoto: (args) => api.uploadJobPhoto(args.jobId, args.file, args.opts),
  saveSignature: async (args) => {
    const path = await api.uploadSignature(args.jobId, args.pngBlob);
    return api.saveQuoteSignature(args.quoteId, path, args.signerName);
  }
};

const listeners = new Set();

/* Observable sync state, not just a count. The field console has to be able
   to tell four situations apart -- saved locally, pending sync, synced, sync
   failed -- and a bare number collapses three of them into one. `lastError`
   is kept here rather than discarded because auto-flush (the 'online'
   listener below) has no caller to return it to, so a failed background
   replay used to leave no trace anywhere in the UI. */
let flushInFlight = null;
let discardInFlight = null;
let lastError = null;
let queued = 0;

export function syncState() {
  return {
    count: queued,
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
    syncing: flushInFlight !== null,
    discarding: discardInFlight !== null,
    lastError,
    storageError
  };
}

function notify(nextCount) {
  if (typeof nextCount === 'number') queued = nextCount;
  const snapshot = syncState();
  for (const cb of listeners) cb(snapshot);
}

export function subscribe(cb) {
  listeners.add(cb);
  count().then((n) => { queued = n; cb(syncState()); }).catch(() => cb(syncState()));
  return () => listeners.delete(cb);
}

export async function count() {
  const owner = await localAccount();
  const items = await withStore('readonly', store => reqToPromise(store.getAll()));
  const n = items.filter(item => !item.ownerId || item.ownerId === owner).length;
  queued = n;
  return n;
}

async function enqueue(type, args, label, scope) {
  const ownerId = await localAccount();
  if (!ownerId) throw new Error('Sign in before saving an action on this device.');
  if (scope?.ownerId && scope.ownerId !== ownerId) throw new Error('Account changed before this action was saved. Reopen the visit.');
  const size = payload => new Blob([JSON.stringify(payload || {})]).size + (payload?.file?.size || 0) + (payload?.pngBlob?.size || 0);
  const payloadBytes = size(args);
  const id = await withStore('readwrite', async store => {
    const items = await reqToPromise(store.getAll());
    if (items.length >= 200 || items.reduce((n, item) => n + (item.payloadBytes ?? size(item.args)), 0) + payloadBytes > 50 * 1024 * 1024)
      throw new Error('Device outbox is full. Sync or review saved actions before adding more.');
    return reqToPromise(store.add({ type, args, label, ownerId, jobId: scope?.jobId || args.jobId || null,
      basePassport: scope?.basePassport, payloadBytes, state: 'pending', createdAt: Date.now() }));
  });
  notify(await count());
  return id;
}

/** What is currently waiting to sync, oldest first. The queue already stores
 *  a human label per item ("Photo upload", "Customer signature"); nothing
 *  rendered it, so a tech with a stuck queue could see a count and had no way
 *  to find out what it was. */
export async function pending() {
  const owner = await localAccount();
  const items = await withStore('readonly', (store) => reqToPromise(store.getAll()));
  return (items || []).filter(i => !i.ownerId || i.ownerId === owner).map(i => ({ id: i.id,
    label: i.ownerId ? i.label : 'Legacy action — ownership unknown', type: i.ownerId ? i.type : 'legacy',
    createdAt: i.createdAt, state: !i.ownerId ? 'blocked' : i.state === 'sending' ? 'uncertain' : i.state,
    lastError: !i.ownerId ? 'Retained from the previous version. Automatic replay is blocked.'
      : i.state === 'sending' ? 'The app closed during a send. The server may already have received it.' : i.lastError || null,
    attemptedAt: i.attemptedAt || null }));
}

export async function pendingPhotos(jobId) {
  const owner = await localAccount();
  if (!owner) return [];
  const items = await withStore('readonly', store => reqToPromise(store.getAll()));
  return items.filter(item => item.ownerId === owner && item.type === 'uploadJobPhoto' && item.args.jobId === jobId)
    .map(item => ({ id: item.id, file: item.args.file, opts: item.args.opts, state: item.state }));
}

export async function propertyPatches(jobId) {
  const owner = await localAccount();
  if (!owner) return [];
  const items = await withStore('readonly', store => reqToPromise(store.getAll()));
  return items.filter(item => item.ownerId === owner && item.jobId === jobId && item.type === 'updateProperty')
    .map(item => item.args.patch);
}

export async function pendingMeasurements(jobId) {
  const owner = await localAccount();
  if (!owner) return [];
  const items = await withStore('readonly', store => reqToPromise(store.getAll()));
  return items.filter(item => item.ownerId === owner && item.jobId === jobId && item.type === 'createMeasurement')
    .map(item => ({ ...item.args.measurement, pending: true }));
}

export async function confirmRetry(id) {
  const owner = await localAccount();
  await mutateWhenIdle(() => withStore('readwrite', async store => {
    const item = await reqToPromise(store.get(id));
    if (!item?.ownerId || item.ownerId !== owner) throw new Error('This action does not belong to the signed-in account.');
    if (flushInFlight) throw new Error('Wait for sync to finish.');
    return reqToPromise(store.put({ ...item, state: 'pending', lastError: null }));
  }));
  notify();
}

/** A deliberate local discard, never a rollback of a server write. The UI
 * confirms first. A replay owns its head item until it has finished, so
 * discarding during replay is refused. Replay waits for an earlier discard. */
export function discard(id) {
  if (flushInFlight) return Promise.reject(new Error('Wait for sync to finish before discarding an action.'));
  if (discardInFlight) return Promise.reject(new Error('Another discard is still in progress.'));
  discardInFlight = (async () => {
    const owner = await localAccount();
    await mutateWhenIdle(() => withStore('readwrite', async store => {
      const item = await reqToPromise(store.get(id));
      if (item?.ownerId && item.ownerId !== owner) throw new Error('This action belongs to another account.');
      return reqToPromise(store.delete(id));
    }));
    const items = await pending();
    lastError = items[0]?.lastError || null;
    notify(items.length);
  })().finally(() => { discardInFlight = null; notify(); });
  notify();
  return discardInFlight;
}

function mutateWhenIdle(work) {
  if (!navigator.locks?.request) return Promise.reject(new Error('Sync is unavailable in this browser. Reopen the app or use an updated browser.'));
  return navigator.locks.request('ns-field-outbox-replay', { ifAvailable: true }, lock => {
    if (!lock) throw new Error('Wait for sync in another app tab to finish.');
    return work();
  });
}

/** True if this looks like "the network isn't there" rather than a real
 *  application error (validation failure, 4xx, RLS denial) -- only the
 *  former is worth queuing. A real error should still surface immediately,
 *  offline or not. Exported so field-workspace.js's reload() can apply the
 *  exact same test to its own read-refresh after a queued write, rather
 *  than inventing a second classifier that could disagree with this one. */
export function looksOffline(err) {
  if (accessDenied(err)) return false;
  // Airplane mode does not turn a local storage failure into a network
  // failure. Preserve actionable quota/blocked-upgrade errors in the router.
  if (['QuotaExceededError', 'InvalidStateError', 'VersionError'].includes(err?.name) ||
    /indexeddb|device storage|local storage|outbox storage|quota|close other app tabs/i.test(err?.message || '')) return false;
  if (!navigator.onLine) return true;
  const msg = String(err?.message || err || '').toLowerCase();
  return msg.includes('failed to fetch') || msg.includes('networkerror') ||
         msg.includes('network request failed') || msg.includes('load failed');
}

/** The integration point field-workspace.js / field-photos.js call instead
 *  of the api.js function directly, for the four queueable action types.
 *  Returns { queued: false, result } when it actually ran, or
 *  { queued: true } when it remains in the outbox. Every supported action
 *  is persisted before sending. An immediate validation or permission
 *  failure is re-thrown as well as retained, so the caller shows the error
 *  rather than announcing a successful save. */
export async function callOrQueue(type, args, label, scope) {
  if (!HANDLERS[type]) throw new Error(`Unknown offline action type: ${type}`);
  // Commit the complete payload, including Blob bytes, BEFORE network I/O.
  // Immediate online sends use the same ordered durable queue.
  const id = await enqueue(type, args, label, scope);
  if (!navigator.onLine) return { queued: true };
  const result = await flush();
  if (Object.hasOwn(result.results || {}, id)) return { queued: false, result: result.results[id] };
  if (result.failedId === id && result.cause && !looksOffline(result.cause)) throw result.cause;
  return { queued: true, uncertain: result.failedId === id };
}

/** Replays the queue in order, stopping at the first failure. Safe to call
 *  whenever (on 'online', on a manual Sync Now tap, on page load) -- an
 *  empty queue is a cheap no-op. */
export function flush() {
  // Re-entrancy guard. Four separate triggers can call this -- the 'online'
  // listener, the load-time attempt, a manual Sync Now tap, and a caller
  // after a queued write -- and each loop iteration reads the head record in
  // its own short read-only transaction. Two overlapping flushes therefore
  // read the SAME head record and both run its handler, which is a
  // deterministic double-execution of every queued write, not the narrow
  // lost-response window this module's guarantee accepts. Concurrent callers
  // now join the flush already in progress instead of starting a second one.
  if (flushInFlight) return flushInFlight;
  flushInFlight = (async () => {
    if (discardInFlight) await discardInFlight;
    // A per-module promise cannot protect two tabs/WebViews sharing this DB.
    // Web Locks releases automatically when a page dies. Fail closed on an
    // unsupported origin rather than replaying the same head twice.
    if (!navigator.locks?.request) throw new Error('Sync is unavailable in this browser. Reopen the app or use an updated browser.');
    return navigator.locks.request('ns-field-outbox-replay', runFlush);
  })().finally(() => { flushInFlight = null; notify(); });
  notify();                      // repaint as "syncing" while it runs
  return flushInFlight;
}

async function runFlush() {
  const flushedLabels = [];
  const results = {};
  let failedId, cause;
  let remaining = 0;
  lastError = null;

  // One record at a time: open+read, call its handler, then open+delete --
  // never a long-lived transaction spanning an await, which IndexedDB
  // transactions auto-close on.
  for (;;) {
    if (!navigator.onLine) break;
    const owner = await localAccount();
    if (!owner) break;
    const next = await withStore('readonly', store => reqToPromise(store.index('ownerId').getAll(owner)))
      .then(items => items.length ? { id: items[0].id, value: items[0] } : null);
    if (!next) break;
    if (['sending', 'uncertain'].includes(next.value.state)) {
      lastError = 'A previous send may already have succeeded. Review the action before retrying.';
      break;
    }

    try {
      const sendArgs = structuredClone(next.value.args);
      // Revalidate the target through the existing RLS-protected read before
      // sending a queued job action. Cached permission is never send permission.
      if (next.value.jobId) {
        const job = await api.getJob(next.value.jobId);
        if (!job || job.id !== next.value.jobId) throw new Error('This visit is no longer accessible.');
        if (next.value.type === 'updateProperty' && job.properties?.id !== next.value.args.id)
          throw new Error('This property is no longer part of the saved visit.');
        if (next.value.basePassport && next.value.args.patch?.passport) {
          sendArgs.patch.passport = mergePassport(next.value.basePassport,
            next.value.args.patch.passport, job.properties?.passport || {});
        }
      }
      if (await localAccount() !== owner) break;
      await withStore('readwrite', store => store.put({ ...next.value, state: 'sending', attemptedAt: Date.now() }));
      let value;
      if (next.value.type === 'saveSignature') {
        const args = next.value.args;
        const quotes = await api.listQuotes(args.jobId);
        const quote = quotes.find(row => row.id === args.quoteId);
        if (!quote) throw new Error('The saved quote is no longer accessible for this visit.');
        const alreadySaved = next.value.uploadPath && quote.signature_url === next.value.uploadPath && quote.signed_by_name === args.signerName;
        if (!alreadySaved && !['draft', 'sent'].includes(quote.status)) throw new Error('This quote is no longer awaiting a signature. Review the current quote.');
        const path = next.value.uploadPath || await api.uploadSignature(args.jobId, args.pngBlob);
        next.value.uploadPath = path;
        await withStore('readwrite', store => store.put({ ...next.value, state: 'sending' }));
        if (await localAccount() !== owner) break;
        value = alreadySaved ? quote : await api.saveQuoteSignature(args.quoteId, path, args.signerName);
      } else value = await HANDLERS[next.value.type](sendArgs);
      await withStore('readwrite', (store) => store.delete(next.id));
      results[next.id] = value;
      flushedLabels.push(next.value.label);
    } catch (err) {
      // Stored as a message string, not the Error: syncState() is a snapshot
      // the badge renders as text, and an Error object there both reads as
      // "[object Error]" and serialises to {}.
      lastError = err?.message || String(err);
      if (accessDenied(err)) {
        await forget(owner).catch(() => {});
        window.dispatchEvent(new CustomEvent('ns-field-access-denied', { detail: { ownerId: owner } }));
      }
      failedId = next.id; cause = err;
      const sending = await withStore('readonly', store => reqToPromise(store.get(next.id)));
      await withStore('readwrite', store => store.put({ ...next.value,
        state: sending?.state === 'sending' && looksOffline(err) && next.value.type !== 'updateProperty' ? 'uncertain' : 'pending',
        lastError, attemptedAt: Date.now() }));
      break;
    }
  }

  remaining = await count();
  notify(remaining);
  return { flushed: flushedLabels, remaining, error: lastError, results, failedId, cause };
}

// Three-way merge only edited fields. Preserve unrelated server changes;
// stop rather than overwrite a field changed differently by another actor.
function mergePassport(base, desired, remote) {
  const merged = { ...remote };
  for (const key of Object.keys(desired)) {
    const before = base?.[key], after = desired[key], current = remote?.[key];
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    if (after && typeof after === 'object' && !Array.isArray(after)) {
      merged[key] = mergePassport(before || {}, after, current || {});
    } else {
      if (JSON.stringify(current) !== JSON.stringify(before) && JSON.stringify(current) !== JSON.stringify(after))
        throw new Error(`Passport conflict at ${key}. Review the current visit before retrying.`);
      merged[key] = after;
    }
  }
  return merged;
}

if (typeof window !== 'undefined') {
  // Repaint on connectivity changes so the badge reflects online/offline even
  // when the queue count has not moved. The flush itself reports its own
  // outcome through notify(); errors are held in `lastError` rather than
  // swallowed, so a failed background replay is visible in the badge.
  window.addEventListener('online', () => { notify(); flush().catch(() => {}); });
  window.addEventListener('offline', () => { notify(); });
  // Covers the case where items were queued and the page was closed before
  // ever coming back online -- next load, while already online, tries once.
  if (navigator.onLine) flush().catch(() => {});
}
