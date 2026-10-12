import * as api from './api.js';
import { localAccount, accessDenied } from './field-identity.js';
import { request, transaction } from './field-storage.js';

export const MAX_JOBS = 20;
export const OFFLINE_AGE_MS = 24 * 60 * 60 * 1000;
export const REFERENCE_AGE_MS = 7 * OFFLINE_AGE_MS;
export const UPCOMING_DAYS = 7;
const MAX_BYTES = 10 * 1024 * 1024;
const DB = 'ns-field-work';
const deniedAccounts = new Set();
const deniedKey = id => `ns-field-cache-retired:${id}`;
function retired(id) {
  return deniedAccounts.has(id) || localStorage.getItem(deniedKey(id)) === 'yes';
}
function store(mode, work) {
  return transaction(DB, 2, db => {
    if (!db.objectStoreNames.contains('accounts')) db.createObjectStore('accounts', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'key' });
    if (!db.objectStoreNames.contains('references')) db.createObjectStore('references', { keyPath: 'id' });
    // Existing snapshots/drafts are retained; the outbox is a separate,
    // unchanged database. Old inline references are read lazily below.
  }, ['accounts', 'drafts', 'references'], mode, work);
}

async function accountId(expected) {
  const id = await localAccount();
  if (!id) throw new Error('Sign in online before saving work on this device.');
  if (expected && id !== expected) throw new Error('Account changed. This draft belongs to the previous account.');
  return id;
}

export async function snapshot() {
  const id = await localAccount();
  return id ? store('readonly', tx => request(tx.objectStore('accounts').get(id))) : null;
}

export async function forget(id = null) {
  id ||= await localAccount();
  if (id) {
    deniedAccounts.add(id);
    // Retire reads even when IDB cleanup itself fails. Pending writes and
    // drafts stay untouched; only a new complete preparation re-enables reads.
    try { localStorage.setItem(deniedKey(id), 'yes'); } catch { /* Current realm still fails closed. */ }
    await store('readwrite', tx => {
    tx.objectStore('references').delete(id);
    return request(tx.objectStore('accounts').delete(id));
    });
  }
  // Drafts and queued writes are retained for their original account.
}

export async function usableSnapshot() {
  const owner = await localAccount();
  if (!owner || retired(owner)) return null;
  const data = await snapshot();
  const age = Date.now() - data?.savedAt;
  if (!data || retired(data.id) || ![1, 2].includes(data.version) || !Number.isFinite(age) || age < 0 || age > OFFLINE_AGE_MS) return null;
  const refs = await referenceRecord(data.id);
  const available = fresh(refs, REFERENCE_AGE_MS);
  return { ...data, refs: available ? refs.data : { services: [], flags: [] },
    refsSavedAt: refs?.savedAt, refsAvailable: available };
}

function fresh(data, maxAge) {
  const age = Date.now() - data?.savedAt;
  return !!data && Number.isFinite(age) && age >= 0 && age <= maxAge;
}

async function referenceRecord(id) {
  return store('readonly', async tx => {
    const refs = await request(tx.objectStore('references').get(id));
    if (refs) return refs;
    const legacy = await request(tx.objectStore('accounts').get(id));
    return legacy?.version === 1 && legacy.refs
      ? { id, savedAt: legacy.savedAt, data: legacy.refs } : null;
  });
}

async function fetchReferences(id) {
  try {
    const data = Object.fromEntries(await Promise.all([
      ['services', 'listServices'], ['modifiers', 'listModifiers'], ['siteFactors', 'listSiteFactors'],
      ['flags', 'listInspectionFlags'], ['flagMap', 'listServiceFlagMap'],
      ['pricingRules', 'listPricingRules'], ['settings', 'getSettings']
    ].map(async ([key, method]) => [key, await api[method]()])));
    return { id, savedAt: Date.now(), data };
  } catch (error) {
    if (accessDenied(error)) await forget(id);
    throw error;
  }
}

async function saveReadCache(id, work, refs) {
  if (await localAccount() !== id) throw new Error('Account changed while saving work. Retry after signing in.');
  await store('readwrite', async tx => {
    const accounts = tx.objectStore('accounts');
    const references = tx.objectStore('references');
    const allWork = await request(accounts.getAll());
    const allRefs = await request(references.getAll());
    const ownWork = work || allWork.find(row => row.id === id);
    const size = row => row ? new Blob([JSON.stringify(row)]).size : 0;
    let bytes = size(ownWork) + size(refs);
    if (bytes > MAX_BYTES) throw new Error('Work exceeds the 10 MB offline limit. Reduce the selected schedule.');
    const others = [...new Set([...allWork, ...allRefs].map(row => row.id))].filter(owner => owner !== id)
      .map(owner => ({ id: owner, work: allWork.find(row => row.id === owner), refs: allRefs.find(row => row.id === owner) }))
      .sort((a,b) => Math.max(b.work?.savedAt || 0, b.refs?.savedAt || 0) - Math.max(a.work?.savedAt || 0, a.refs?.savedAt || 0));
    for (const other of others) {
      const cost = size(other.work) + size(other.refs);
      if (bytes + cost > MAX_BYTES) { accounts.delete(other.id); references.delete(other.id); }
      else bytes += cost;
    }
    references.put(refs);
    if (work) accounts.put(work);
  });
}

// Independent refresh changes neither the visit timestamp nor its facts.
export async function refreshReferences() {
  if (!navigator.onLine) throw new Error('Reconnect before refreshing reference data.');
  const id = await accountId();
  const refs = await fetchReferences(id);
  await saveReadCache(id, null, refs);
  return refs.savedAt;
}

export async function prepareWork(today, upcoming) {
  if (!navigator.onLine) throw new Error('Reconnect before saving fresh work.');
  const id = await accountId();
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + UPCOMING_DAYS + 1);
  const distinct = [...new Map([...today, ...upcoming].map(job => [job.id, job])).values()];
  const eligible = distinct.filter(job => { const time = new Date(job.scheduled_for).getTime(); return time >= start.getTime() && time < end.getTime(); });
  const selected = eligible.slice(0, MAX_JOBS);
  let refs = retired(id) ? null : await referenceRecord(id);
  // Legacy reference snapshots lack pricingRules: complete them online.
  if (!fresh(refs, REFERENCE_AGE_MS) || !Object.hasOwn(refs.data, 'pricingRules')) refs = await fetchReferences(id);
  const jobs = {};
  // At most one job's reads in flight; never unbounded fan-out over the office.
  for (const job of selected) {
    try {
      const [detail, sections, measurements, notes, attachments, quotes, flags] = await Promise.all([
        api.getJob(job.id), api.listSections(job.id), api.listMeasurements(job.id),
        api.listNotes(job.id), api.listAttachments(job.id), api.listQuotes(job.id), api.listJobFlags(job.id)
      ]);
      if (!detail || detail.id !== job.id) throw new Error('The visit is no longer accessible.');
      jobs[job.id] = { job: detail, sections, measurements, notes, attachments, quotes, flags };
    } catch (error) {
      if (accessDenied(error)) await forget(id);
      throw error; // An incomplete preparation never replaces a good snapshot.
    }
  }
  const result = { id, version: 2, savedAt: Date.now(), jobs,
    window: { from: start.toISOString(), until: end.toISOString(), upcomingDays: UPCOMING_DAYS },
    today: today.filter(job => jobs[job.id]), upcoming: upcoming.filter(job => jobs[job.id]) };
  await saveReadCache(id, result, refs);
  localStorage.removeItem(deniedKey(id));
  deniedAccounts.delete(id);
  const persistent = await navigator.storage?.persist?.().catch(() => false);
  return { count: selected.length, truncated: eligible.length > MAX_JOBS,
    excluded: distinct.length - eligible.length, persistent: !!persistent };
}

export async function readDraft(jobId, name) {
  const id = await accountId();
  return store('readonly', tx => request(tx.objectStore('drafts').get([id, jobId, name])));
}

export async function writeDraft(jobId, name, value, expectedOwner) {
  const id = await accountId(expectedOwner);
  if (new Blob([JSON.stringify(value)]).size > 100000) throw new Error('Draft exceeds the 100 KB limit.');
  await store('readwrite', async tx => {
    const drafts = tx.objectStore('drafts');
    const key = [id, jobId, name];
    if (await request(drafts.count()) >= 200 && !await request(drafts.get(key)))
      throw new Error('Device draft storage is full. Review existing drafts before adding more.');
    return request(drafts.put({ key, value, savedAt: Date.now() }));
  });
}

export async function deleteDraft(jobId, name, expectedOwner) {
  const id = await accountId(expectedOwner);
  await store('readwrite', tx => request(tx.objectStore('drafts').delete([id, jobId, name])));
}

// Preserve unsubmitted notes without adding a fifth outbox write type.
export async function retainNoteDraft(jobId, input, visibility, status) {
  const owner = await accountId();
  const existing = await readDraft(jobId, 'note');
  if (existing && !input.value) {
    input.value = existing.value.body;
    visibility.value = existing.value.visibility;
    status.textContent = 'Draft restored from this device. It has not been sent.';
  }
  let chain = Promise.resolve();
  const save = () => {
    const value = { body: input.value, visibility: visibility.value };
    chain = chain.catch(() => {}).then(() => writeDraft(jobId, 'note', value, owner));
    chain.then(() => { if (input.isConnected) status.textContent = 'Draft saved on this device — not sent.'; },
      error => { if (input.isConnected) status.textContent = `Draft not saved: ${error.message}`; });
  };
  input.addEventListener('input', save);
  visibility.addEventListener('change', save);
  const clear = async () => { await chain; await deleteDraft(jobId, 'note', owner); };
  // Review tools can wait for the existing note draft to commit before
  // clearing their own buffer. No second note writer or delivery path.
  clear.flush = () => chain;
  return clear;
}
