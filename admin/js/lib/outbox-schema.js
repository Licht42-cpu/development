// v3 keeps legacy records intact. Completion uses the pre-existing lifecycle
// store and activates marker 2 atomically, without another DB/store migration.
export const OUTBOX_VERSION = 3;
export const OUTBOX_RECORD_VERSION = 1;
// Marker 2 is written atomically ONLY when the first completion is queued.
// Prior apps understand marker 1 and refuse marker 2 without losing rows.
export const COMPLETION_RECORD_VERSION = 2;
export const OUTBOX_STATES = Object.freeze(['queued', 'accepted', 'conflict', 'needs-review']);
export const OUTBOX_SCHEMA = Object.freeze({ key: 'schema', version: OUTBOX_VERSION, recordVersion: OUTBOX_RECORD_VERSION });

export function upgradeOutbox(db, tx, oldVersion) {
  if (![0, 1, 2].includes(oldVersion)) throw new Error('Unsupported device outbox upgrade. Saved actions were kept.');
  if (oldVersion && !db.objectStoreNames.contains('queue'))
    throw new Error('Device outbox is missing its original queue. Saved storage was kept.');
  const queue = oldVersion ? tx.objectStore('queue')
    : db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
  if (queue.keyPath !== 'id' || !queue.autoIncrement)
    throw new Error('Unrecognised device outbox queue shape. Saved actions were kept.');
  if (!queue.indexNames.contains('ownerId')) queue.createIndex('ownerId', 'ownerId');
  // v1 records remain byte-for-byte intact, including unknown ownership.
  // v2 payloads/states/keys are not rewritten either. The new lifecycle store
  // is unused by the four existing handlers; it cannot claim old actions.
  const lifecycle = db.createObjectStore('lifecycle', { keyPath: 'id' });
  lifecycle.createIndex('ownerId', 'ownerId');
  lifecycle.createIndex('state', 'state');
  db.createObjectStore('schema', { keyPath: 'key' }).put(OUTBOX_SCHEMA);
}

export function validateOutbox(db) {
  return new Promise((resolve, reject) => {
    if (!['queue', 'schema', 'lifecycle'].every(name => db.objectStoreNames.contains(name))) {
      reject(new Error('Device outbox schema is incomplete. Saved actions were kept.'));
      return;
    }
    const tx = db.transaction('schema', 'readonly');
    let marker;
    tx.objectStore('schema').get('schema').onsuccess = event => { marker = event.target.result; };
    tx.oncomplete = () => {
      if (marker?.version !== OUTBOX_VERSION || ![OUTBOX_RECORD_VERSION, COMPLETION_RECORD_VERSION].includes(marker?.recordVersion))
        reject(new Error('Device outbox uses an unknown schema version. Update the app; saved actions were kept.'));
      else resolve();
    };
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Device outbox schema could not be read.'));
  });
}
