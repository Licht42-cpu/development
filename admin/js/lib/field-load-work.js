import { readDraft, writeDraft } from './field-cache.js';
import { localAccount } from './field-identity.js';
import { loadCall } from './field-load-api.js';

export const loadKey = (code, date) => `field-load:${code}:${date}`;
export const unresolved = record => ['sending', 'no-response'].includes(record?.state);
export async function loadWork(code, date) {
  const row = await readDraft(loadKey(code, date), 'operation');
  if (row && row.value.version !== 1) throw new Error('This load request uses a newer device format. Saved work was preserved.');
  if (row && (!['sending','no-response','accepted','refused','conflict'].includes(row.value.state) || !row.value.payload?.p_client_operation_id))
    throw new Error('The saved load request cannot be read safely. It was preserved; do not reset device storage.');
  return row?.value || null;
}
export function classifyLoadError(error) {
  if (error?.code === '42501') return 'refused';
  if (['23514', '23505'].includes(error?.code)) return 'conflict';
  if (error?.code && !String(error.code).startsWith('PGRST')) return 'refused';
  return 'no-response';
}
export async function sendLoadWork(code, date, name, payload, owner, retry = false) {
  if (!navigator.onLine) throw new Error('Reconnect before sending. Drafts stay on this device; load actions are not queued.');
  if (!navigator.locks) throw new Error('This browser cannot lock a load request safely. Use the Android app or a current browser.');
  return navigator.locks.request(`ns-field-load:${owner}:${code}:${date}`, async () => {
    if (await localAccount() !== owner) throw new Error('Account changed. Request not sent.');
    let record = await loadWork(code, date);
    if (retry) {
      if (!unresolved(record)) throw new Error('There is no unresolved request to retry.');
    } else {
      if (unresolved(record)) throw new Error('Resolve the unanswered request before sending another action for this vehicle and day.');
      record = { version: 1, name, payload: { ...payload, p_client_operation_id: `field-load-${crypto.randomUUID()}` }, createdAt: Date.now() };
    }
    // Commit the immutable request BEFORE I/O. No automatic sender, fifth
    // outbox handler, delete-on-restart or new key on a lost-response retry.
    record = { ...record, state: 'sending', message: 'Waiting for the server…' };
    await writeDraft(loadKey(code, date), 'operation', record, owner);
    try {
      const receipt = await loadCall(record.name, structuredClone(record.payload));
      record = { ...record, state: 'accepted', receipt, message: receipt.replayed ? 'Accepted — original receipt recovered.' : 'Accepted by the server.' };
    } catch (error) {
      record = { ...record, state: classifyLoadError(error), code: error.code || null, message: error.message || 'No response received. Outcome unknown.' };
    }
    // A failed receipt commit leaves 'sending' on disk, safely recoverable
    // with the SAME request. Auth changes cannot save under another account.
    await writeDraft(loadKey(code, date), 'operation', record, owner);
    return record;
  });
}
