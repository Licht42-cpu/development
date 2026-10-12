import { localAccount } from './field-identity.js';
import { transaction, request } from './field-storage.js';

// Local originals/drafts only. This store never sends or replays an action.
const DB = 'ns-field-captures';
const MAX_RECORDS = 40;
const MAX_BYTES = 50 * 1024 * 1024;
const stages = ['original', 'prepared', 'submitting', 'queued', 'uploaded', 'needs-review'];
function store(mode, work) {
  return transaction(DB, 1, db => {
    const captures = db.createObjectStore('captures', { keyPath: 'id' });
    captures.createIndex('ownerJob', ['ownerId', 'jobId']);
  }, ['captures'], mode, tx => work(tx.objectStore('captures')));
}
async function owner(expected) {
  const id = await localAccount();
  if (!id || expected && id !== expected) throw new Error('Account changed. Reopen the visit before saving this photo.');
  return id;
}
const bytes = row => {
  const { original, prepared, ...data } = row;
  return (original?.size || 0) + (prepared?.size || 0) + new Blob([JSON.stringify(data)]).size;
};
function capacity(rows, next) {
  const others = rows.filter(row => row.id !== next.id);
  if (others.length >= MAX_RECORDS || others.reduce((sum, row) => sum + bytes(row), bytes(next)) > MAX_BYTES)
    throw new Error('Saved originals are full (40 photos / 50 MB). Review and remove saved originals before adding more.');
}
export async function saveOriginal(jobId, file, opts, expectedOwner, source = 'selected_file') {
  const ownerId = await owner(expectedOwner);
  if (!(file instanceof Blob) || !file.size) throw new Error('Choose a non-empty photo.');
  const row = { id: crypto.randomUUID(), ownerId, jobId, original: file, prepared: null,
    opts: structuredClone(opts), stage: 'original', metadata: {
      source, selectedAt: new Date().toISOString(), captureTimeState: 'unknown', capturedAt: null,
      captureGpsState: 'unknown', reviewLocation: { state: 'not_collected' },
      originalName: file.name || 'photo', originalType: file.type || null,
      originalLastModified: file.lastModified ?? null
    } };
  await store('readwrite', async captures => {
    capacity(await request(captures.getAll()), row);
    await request(captures.add(row));
  });
  return row;
}
export async function savedCaptures(jobId, expectedOwner) {
  const id = await owner(expectedOwner);
  const rows = await store('readonly', captures => request(captures.index('ownerJob').getAll([id, jobId])));
  return rows.sort((a, b) => b.metadata.selectedAt.localeCompare(a.metadata.selectedAt));
}
export async function updateCapture(id, patch, expectedOwner) {
  const ownerId = await owner(expectedOwner);
  const allowed = ['prepared', 'stage', 'metadata'];
  if (Object.keys(patch).some(key => !allowed.includes(key)) || patch.stage && !stages.includes(patch.stage))
    throw new Error('Invalid saved-photo update.');
  if (patch.prepared != null && !(patch.prepared instanceof Blob)) throw new Error('Prepared photo must contain image bytes.');
  return store('readwrite', async captures => {
    const row = await request(captures.get(id));
    if (!row || row.ownerId !== ownerId) throw new Error('This original belongs to a different account.');
    if (['prepared', 'submitting'].includes(patch.stage) && !['original', 'prepared'].includes(row.stage))
      throw new Error('This photo was already submitted or needs review. Check the saved outbox.');
    const next = { ...row, ...patch };
    capacity(await request(captures.getAll()), next);
    await request(captures.put(next));
    return next;
  });
}
export async function removeCapture(id, expectedOwner) {
  const ownerId = await owner(expectedOwner);
  await store('readwrite', async captures => {
    const row = await request(captures.get(id));
    if (row && row.ownerId !== ownerId) throw new Error('This original belongs to a different account.');
    await request(captures.delete(id));
  });
}

// An observation at review time, never an inferred photo geotag.
export async function observeReviewLocation() {
  try {
    const { Geolocation } = await import('../../../shared/vendor/@capacitor/geolocation/dist/esm/index.js');
    const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 });
    const { latitude, longitude, accuracy } = pos.coords || {};
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180)
      throw new Error('No usable location returned');
    return { state: 'device_reported', latitude, longitude,
      accuracyM: Number.isFinite(accuracy) && accuracy >= 0 ? accuracy : null,
      observedAt: new Date().toISOString() };
  } catch (error) {
    return { state: error?.code === 1 || /denied|permission/i.test(error?.message || '') ? 'denied' : 'unavailable' };
  }
}
