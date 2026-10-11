// Resolve only after COMMIT: a request's success is not durable success.
export function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const opening = new Map();
function open(name, version, upgrade) {
  const key = `${name}:${version}`;
  if (opening.has(key)) return opening.get(key).then(() => open(name, version, upgrade));
  let blocked = false;
  const promise = new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => upgrade(req.result, req.transaction);
    req.onsuccess = () => { opening.delete(key); if (blocked) req.result.close(); else resolve(req.result); };
    req.onerror = () => reject(req.error);
    req.onblocked = () => { blocked = true; reject(new Error('Close other app tabs, then retry device storage.')); };
  }).catch(error => { if (!blocked) opening.delete(key); throw error; });
  opening.set(key, promise);
  return promise;
}

export async function transaction(name, version, upgrade, stores, mode, work) {
  const db = await open(name, version, upgrade);
  db.onversionchange = () => db.close();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result;
      let workError;
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(workError || tx.error || new Error('Device storage transaction failed.'));
      try {
        result = work(tx);
        if (result?.then) result.catch(error => { workError = error; try { tx.abort(); } catch {} });
      } catch (error) { tx.abort(); reject(error); }
    });
  } finally { db.close(); }
}
