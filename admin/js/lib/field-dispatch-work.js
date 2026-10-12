import { readDraft, writeDraft, deleteDraft, forget, OFFLINE_AGE_MS } from './field-cache.js';
import { localAccount } from './field-identity.js';
import { dispatchCall } from './field-dispatch-api.js';

const retiredAccounts = new Set();
const epochs = new Map();
const retiredKey = owner => `ns-field-dispatch-retired:${owner}`;
const cacheJob = 'dispatch-read';
export const pendingDispatch = record => ['sending','no-response'].includes(record?.state);
export async function retireDispatch(owner,closeWorkspace=true) {
  if (!owner) return;
  retiredAccounts.add(owner);
  epochs.set(owner,(epochs.get(owner)||0)+1);
  try { localStorage.setItem(retiredKey(owner),'yes'); } catch { /* In-memory reads remain retired. */ }
  window.dispatchEvent(new CustomEvent('ns-field-dispatch-denied',{detail:{ownerId:owner,closeWorkspace}}));
  // Retire legacy visit snapshots too. Drafts/outbox requests are preserved.
  await deleteDraft(cacheJob,'snapshot',owner).catch(()=>{});
  // The legacy outbox has already retired its read cache before emitting
  // its denial event. Avoid a second overlapping cleanup of that store.
  if (closeWorkspace) await forget(owner).catch(()=>{});
}
export const dispatchEpoch = owner => epochs.get(owner)||0;
export function offlineProperty(value) {
  // Explicit allowlist: codes and internal_note never enter durable storage.
  return {property_id:value.property_id,address_line1:value.address_line1,city:value.city,
    access_note:value.access_note,coordinates:structuredClone(value.coordinates),
    access:value.access ? Object.fromEntries(['entrance_note','hazard_note','parking_note','customer_note']
      .map(key=>[key,value.access[key]||null])) : null,
    zones:value.zones.map(zone=>Object.fromEntries(['zone_id','label','kind','space','points','source','image_source','note','lock_version']
      .map(key=>[key,structuredClone(zone[key] ?? null)])))};
}
export async function saveDispatch(day, properties, owner, epoch) {
  if (await localAccount() !== owner || dispatchEpoch(owner) !== epoch) throw new Error('Access changed while saving. Refresh the day.');
  if (day.stops.length > 20) throw new Error('Only days with at most 20 stops can be saved on this device.');
  const value = {version:1,savedAt:Date.now(),day:structuredClone(day),properties:Object.fromEntries(
    Object.entries(properties).map(([id,row])=>[id,offlineProperty(row)]))};
  await writeDraft(cacheJob,'snapshot',value,owner);
  if (await localAccount() !== owner || dispatchEpoch(owner) !== epoch) {
    await deleteDraft(cacheJob,'snapshot',owner); throw new Error('Access changed. Saved day retired.');
  }
  localStorage.removeItem(retiredKey(owner));retiredAccounts.delete(owner);
  return value;
}
export async function savedDispatch() {
  const owner = await localAccount();
  if (!owner || retiredAccounts.has(owner) || localStorage.getItem(retiredKey(owner)) === 'yes') return null;
  const row = await readDraft(cacheJob,'snapshot');
  if (await localAccount() !== owner || retiredAccounts.has(owner) || localStorage.getItem(retiredKey(owner)) === 'yes') return null;
  const value = row?.value, age = Date.now()-value?.savedAt;
  if (!value || value.version !== 1 || !Number.isFinite(age) || age < 0 || age > OFFLINE_AGE_MS) return null;
  return {owner,...value};
}
export async function dispatchWork(jobId) {
  const value = (await readDraft(jobId,'dispatch-operation'))?.value;
  if (value && (value.version !== 1 || !['sending','no-response','accepted','refused','conflict'].includes(value.state) ||
      !['report_job_issue','request_job_notification'].includes(value.name) || !value.payload?.p_client_operation_id))
    throw new Error('A newer or unsupported dispatch request was preserved. Do not reset device storage.');
  return value || null;
}
export async function sendDispatch(jobId,name,payload,owner,retry=false) {
  if (!navigator.onLine) throw new Error('Reconnect before sending. Dispatch writes are not queued.');
  if (!navigator.locks) throw new Error('This browser cannot safely lock a dispatch request.');
  return navigator.locks.request(`ns-field-dispatch:${owner}:${jobId}`,async()=>{
    if (!navigator.onLine) throw new Error('Reconnect before sending. Nothing was queued.');
    if (await localAccount() !== owner) throw new Error('Account changed. Nothing sent.');
    let record = await dispatchWork(jobId);
    if (retry) {
      if (!pendingDispatch(record)) throw new Error('No unanswered request to recover.');
    } else {
      if (pendingDispatch(record)) throw new Error('Recover the original request before submitting another.');
      record={version:1,name,payload:{...payload,p_job_id:jobId,p_client_operation_id:`field-dispatch-${crypto.randomUUID()}`},createdAt:Date.now()};
    }
    record={...record,state:'sending'};
    await writeDraft(jobId,'dispatch-operation',record,owner); // COMMIT before I/O
    try { record={...record,state:'accepted',receipt:await dispatchCall(record.name,structuredClone(record.payload))}; }
    catch(error) {
      const state = error.code === '42501' ? 'refused' : ['23514','23505'].includes(error.code) ? 'conflict'
        : error.code && !String(error.code).startsWith('PGRST') ? 'refused' : 'no-response';
      record={...record,state,code:error.code||null,message:state === 'refused' ? 'The server refused this action. It was not accepted.'
        : state === 'conflict' ? error.message : 'No valid response. Outcome unknown; recover the original request.'};
      if (error.code === '42501') await retireDispatch(owner);
    }
    await writeDraft(jobId,'dispatch-operation',record,owner);
    return record;
  });
}
export async function reportLocalArrival(jobId, owner) {
  const value={version:1,jobId,reportedAt:new Date().toISOString(),state:'local-crew-report',
    locationVerification:'not_verified',serverReceipt:null};
  await writeDraft(jobId,'dispatch-arrival',value,owner);
  return value;
}
