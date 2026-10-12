import { readDraft, writeDraft } from './field-cache.js';
import { localAccount } from './field-identity.js';
import { registerFieldEvidence } from './field-completion-api.js';

export async function evidenceRequest(jobId) {
  const value = (await readDraft(jobId, 'evidence-request'))?.value;
  if (value && value.version !== 1) throw new Error('Saved evidence request uses a newer format. It was preserved.');
  return value || null;
}
export async function sendEvidence(jobId, payload, owner, retry = false) {
  if (!navigator.onLine) throw new Error('Evidence registration needs a confirmed uploaded attachment and a connection. Drafts remain here.');
  if (!navigator.locks) throw new Error('Use a browser that supports safe request locking.');
  return navigator.locks.request(`ns-field-evidence:${owner}:${jobId}`, async () => {
    if (await localAccount() !== owner) throw new Error('Account changed. Evidence not sent.');
    let record = await evidenceRequest(jobId);
    const unknown = ['sending','unknown'].includes(record?.state);
    if (retry && !unknown) throw new Error('No unresolved evidence registration.');
    if (!retry) {
      if (unknown) throw new Error('Resolve the original registration before sending another.');
      record = { version: 1, payload: { ...payload, p_client_operation_id: `field-evidence-${crypto.randomUUID()}` } };
    }
    record = { ...record, state: 'sending' }; await writeDraft(jobId, 'evidence-request', record, owner);
    try { record = { ...record, state: 'accepted', receipt: await registerFieldEvidence(record.payload) }; }
    catch (error) { record = { ...record, state: error.code ? 'refused' : 'unknown', message: error.message }; }
    await writeDraft(jobId, 'evidence-request', record, owner);
    return record;
  });
}
