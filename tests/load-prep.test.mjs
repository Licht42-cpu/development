import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { offlineFixture, BASE, JOB, OWNER } from './offline-work-fixture.mjs';
import { loadFixture } from './field-load-fixture.mjs';

const { default: pw } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node-tools/node_modules/playwright/index.js');
const browser = await pw.chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || '/opt/pw-browsers/chromium' });
const evidence = process.env.LOAD_PREP_EVIDENCE || join(tmpdir(), 'nova-load-prep');
mkdirSync(evidence, { recursive: true });
const results = [];
async function check(name, fn) {
  if (process.env.LOAD_PREP_ONLY && !name.includes(process.env.LOAD_PREP_ONLY)) return;
  try { await fn(); results.push({ name, ok: true }); console.log('PASS - ' + name); }
  catch (error) { results.push({ name, ok: false, error: error.stack }); console.log('FAIL - ' + name + '\n' + error.stack); }
}
async function fixture(fn, options = {}) {
  const f = await loadFixture(browser, { open: false, ...options });
  if (process.env.LOAD_PREP_BREAK === 'gate') {
    const source = readFileSync(new URL('../admin/js/lib/field-load-gate.js', import.meta.url), 'utf8');
    assert.ok(source.includes('LOAD_INTERFACE_ENABLED = true'));
    await f.context.route('**/admin/js/lib/field-load-gate.js', route => route.fulfill({ contentType: 'application/javascript',
      body: source.replace('LOAD_INTERFACE_ENABLED = true', 'LOAD_INTERFACE_ENABLED = false') }));
  }
  try { await f.page.goto(BASE + '/tests/README.md'); await fn(f); assert.deepEqual(f.errors, []); }
  finally { f.state.release?.(); await f.context.close(); }
}
async function seed(f, version = 2, owned = true) {
  await f.offline();
  return f.page.evaluate(async ({ version, owned, owner, job }) => {
    const rows = [
      { id: 7, type: 'updateProperty', args: { id: 'property-' + job, patch: { passport: { preferences: 'Old draft — café' } } } },
      { id: 8, type: 'createMeasurement', args: { jobId: job, measurement: { quantity: 17.25, label: 'Legacy quantity', service_id: 'service-1' } } },
      { id: 9, type: 'uploadJobPhoto', args: { jobId: job, file: new File([new Uint8Array([0, 255, 42, 10])], 'old-photo.png', { type: 'image/png', lastModified: 123456 }), opts: { caption: 'Old photo' } } },
      { id: 10, type: 'saveSignature', args: { jobId: job, quoteId: 'quote-1', pngBlob: new Blob([new Uint8Array([9, 0, 255, 11])], { type: 'image/png' }), signerName: 'Legacy signer' } }
    ].map(row => ({ ...row, ...(owned ? { ownerId: owner } : {}), jobId: job, label: row.type,
      state: 'pending', createdAt: 1660000000000 + row.id, opaqueLegacyField: { nested: ['preserve', row.id] } }));
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('ns-field-outbox', version);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
        if (version >= 2) store.createIndex('ownerId', 'ownerId');
      };
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction('queue', 'readwrite'); rows.forEach(row => tx.objectStore('queue').add(row));
      tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error);
    }); db.close();
  }, { version, owned, owner: OWNER, job: JOB });
}
async function snapshot(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('ns-field-outbox'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    try {
      const stores = Array.from(db.objectStoreNames);
      const read = name => new Promise((resolve, reject) => {
        const tx = db.transaction(name); let rows; tx.objectStore(name).getAll().onsuccess = event => { rows = event.target.result; };
        tx.oncomplete = () => resolve(rows); tx.onabort = tx.onerror = () => reject(tx.error);
      });
      const encode = async value => {
        if (value instanceof Blob) return { blob: Array.from(new Uint8Array(await value.arrayBuffer())), type: value.type,
          ...(value instanceof File ? { name: value.name, lastModified: value.lastModified } : {}) };
        if (Array.isArray(value)) return Promise.all(value.map(encode));
        if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, val]) => [key, await encode(val)])));
        return value;
      };
      return { version: db.version, stores, rows: await encode(await read('queue')),
        lifecycle: stores.includes('lifecycle') ? await read('lifecycle') : null,
        schema: stores.includes('schema') ? await read('schema') : null };
    } finally { db.close(); }
  });
}
const count = page => page.evaluate(async () => (await import('/admin/js/lib/offline-queue.js')).count());
const flush = page => page.evaluate(async () => (await import('/admin/js/lib/offline-queue.js')).flush());

await check('v2 upgrade preserves all four payloads, Blob/File bytes, row keys and unknown fields', () => fixture(async f => {
  await seed(f); const before = await snapshot(f.page); assert.equal(await count(f.page), 4);
  const after = await snapshot(f.page); assert.equal(after.version, 3); assert.deepEqual(after.rows, before.rows);
  assert.deepEqual(after.stores, ['lifecycle', 'queue', 'schema']); assert.deepEqual(after.lifecycle, []);
  assert.deepEqual(after.schema, [{ key: 'schema', version: 3, recordVersion: 1 }]);
}));
await check('upgraded queue drains every existing handler once; second flush produces no duplicate', () => fixture(async f => {
  await seed(f); await count(f.page); await f.offline(false); await flush(f.page);
  assert.equal(await count(f.page), 0); assert.deepEqual(f.state.writes.map(x => x.name),
    ['updateProperty', 'createMeasurement', 'uploadJobPhoto', 'uploadSignature', 'saveQuoteSignature']);
  assert.equal(f.state.writes[1].args[1].quantity, 17.25); assert.equal(f.state.writes[2].args[1].size, 4);
  assert.equal(f.state.writes[3].args[1].size, 4); assert.equal(f.state.writes[4].args[2], 'Legacy signer');
  await flush(f.page); assert.equal(f.state.writes.length, 5); assert.deepEqual((await snapshot(f.page)).lifecycle, []);
}));
await check('v1 ownerless payloads survive unchanged and stay quarantined, never claimed or replayed', () => fixture(async f => {
  await seed(f, 1, false); const before = await snapshot(f.page); await count(f.page);
  assert.deepEqual((await snapshot(f.page)).rows, before.rows);
  const pending = await f.page.evaluate(async () => (await import('/admin/js/lib/offline-queue.js')).pending());
  assert.equal(pending.length, 4); assert.ok(pending.every(row => row.type === 'legacy' && row.state === 'blocked'));
  await f.offline(false); await flush(f.page); assert.equal(f.state.writes.length, 0);
  assert.deepEqual((await snapshot(f.page)).rows, before.rows);
}));
await check('interrupted upgrade rolls back stores and bytes; retry upgrades the original queue', () => fixture(async f => {
  await seed(f); const before = await snapshot(f.page);
  await f.page.evaluate(() => {
    window.nativeIDBOpen = indexedDB.open.bind(indexedDB);
    indexedDB.open = (...args) => {
      const req = nativeIDBOpen(...args);
      if (args[0] === 'ns-field-outbox' && args[1] === 3) Object.defineProperty(req, 'onupgradeneeded', {
        set(handler) { req.addEventListener('upgradeneeded', event => { handler(event); req.transaction.abort(); }); }
      });
      return req;
    };
  });
  await assert.rejects(count(f.page), /abort/i);
  await f.page.evaluate(() => { indexedDB.open = nativeIDBOpen; });
  assert.deepEqual(await snapshot(f.page), before);
  assert.equal(await count(f.page), 4); assert.deepEqual((await snapshot(f.page)).rows, before.rows);
}));
await check('unknown future database version fails closed and leaves unsent writes untouched', () => fixture(async f => {
  await seed(f, 4); const before = await snapshot(f.page); await f.offline(false);
  await assert.rejects(count(f.page), /newer storage version/); await assert.rejects(flush(f.page), /newer storage version/);
  assert.deepEqual(await snapshot(f.page), before); assert.equal(f.state.writes.length, 0);
}));
await check('downgrade cannot open v3 as v2 or discard an unsent row', () => fixture(async f => {
  await seed(f); await count(f.page); const before = await snapshot(f.page);
  const error = await f.page.evaluate(() => new Promise(resolve => {
    const req = indexedDB.open('ns-field-outbox', 2);
    req.onerror = () => resolve(req.error.name); req.onsuccess = () => { req.result.close(); resolve('unexpected success'); };
  })); assert.equal(error, 'VersionError'); assert.deepEqual(await snapshot(f.page), before);
}));
for (const marker of [{ key: 'schema', version: 99, recordVersion: 1 }, { key: 'schema', version: 3, recordVersion: 99 }]) {
  await check(`unknown schema marker ${marker.version}/${marker.recordVersion} prevents replay without modifying rows`, () => fixture(async f => {
    await seed(f); await count(f.page);
    await f.page.evaluate(async marker => {
      const db = await new Promise(resolve => { const req = indexedDB.open('ns-field-outbox'); req.onsuccess = () => resolve(req.result); });
      await new Promise((resolve, reject) => { const tx = db.transaction('schema', 'readwrite'); tx.objectStore('schema').put(marker);
        tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); db.close();
    }, marker);
    const before = await snapshot(f.page); await f.offline(false);
    await assert.rejects(flush(f.page), /unknown schema version/); assert.deepEqual(await snapshot(f.page), before); assert.equal(f.state.writes.length, 0);
  }));
}
await check('lifecycle states persist separately from legacy handlers; unsupported load actions still refuse', () => fixture(async f => {
  await seed(f); await count(f.page); const before = await snapshot(f.page);
  const states = await f.page.evaluate(async owner => {
    const { OUTBOX_STATES } = await import('/admin/js/lib/outbox-schema.js');
    const db = await new Promise(resolve => { const req = indexedDB.open('ns-field-outbox'); req.onsuccess = () => resolve(req.result); });
    await new Promise(resolve => { const tx = db.transaction('lifecycle', 'readwrite');
      OUTBOX_STATES.forEach((state, index) => tx.objectStore('lifecycle').put({ id: 'test-' + index, ownerId: owner, state })); tx.oncomplete = resolve; });
    db.close(); return OUTBOX_STATES;
  }, OWNER);
  assert.deepEqual(states, ['queued', 'accepted', 'conflict', 'needs-review']);
  assert.deepEqual((await snapshot(f.page)).lifecycle.map(x => x.state), states);
  await f.page.reload(); assert.deepEqual((await snapshot(f.page)).rows, before.rows);
  await assert.rejects(f.page.evaluate(async () => (await import('/admin/js/lib/offline-queue.js')).callOrQueue('futureLoadAction', {}, 'unsupported')), /Unknown offline action type/);
  assert.deepEqual((await snapshot(f.page)).rows, before.rows);
}));
await check('schema/upgrade failures stay storage errors in airplane mode', () => fixture(async f => {
  await f.offline();
  const classified = await f.page.evaluate(async () => {
    const { looksOffline } = await import('/admin/js/lib/offline-queue.js');
    return ['Device outbox uses an unknown schema version.', 'Device outbox schema is incomplete.',
      'Unrecognised device outbox queue shape.'].map(message => looksOffline(new Error(message)));
  });
  assert.deepEqual(classified, [false, false, false]);
}));
await check('upgrade retains auto-increment sequence and concurrent flushes share one replay', () => fixture(async f => {
  await seed(f); await count(f.page);
  await f.page.evaluate(async job => (await import('/admin/js/lib/offline-queue.js')).callOrQueue('createMeasurement', { jobId: job, measurement: { quantity: 9 } }, 'Later action'), JOB);
  assert.equal((await snapshot(f.page)).rows.at(-1).id, 11); await f.offline(false);
  await Promise.all([flush(f.page), flush(f.page)]); assert.equal(f.state.writes.length, 6); assert.equal(await count(f.page), 0);
}));

for (const width of [390, 430]) {
  await check(`enabled load entry still waits for measurement persistence at ${width}px`, () => fixture(async f => {
    await f.offline(false); await f.page.goto(BASE + '/admin/field.html');
    await f.page.getByRole('heading', { name: "Today's schedule" }).waitFor();
    await f.page.evaluate(async () => {
      const { createMeasurementEditor } = await import('/admin/js/lib/measurement-entry.js');
      const root = document.createElement('div'); document.getElementById('view').append(root);
      window.prepEditor = createMeasurementEditor({ root, delay: 60000,
        save: async () => new Promise(resolve => { window.finishPrepSave = resolve; }), onChange: () => {} });
      root.append(prepEditor.quantityInput({ id: 'guard-fixture', quantity: 7 }, { 'aria-label': 'Guard quantity' }));
    });
    await f.page.getByLabel('Guard quantity').fill('9');
    await f.page.evaluate(async () => (await import('/admin/js/field.js')).navigate('/load?vehicle=car_a&day=2027-06-01'));
    await f.page.waitForFunction(() => typeof finishPrepSave === 'function');
    assert.equal(new URL(f.page.url()).hash, '#/load?vehicle=car_a&day=2027-06-01'); assert.equal(await f.page.getByLabel('Guard quantity').inputValue(), '9');
    await f.page.evaluate(() => finishPrepSave());
    await f.page.getByRole('heading', { name: 'Vehicle load', exact: true }).waitFor();
    await f.page.getByText('Window:', { exact: false }).waitFor();
    assert.equal(await f.page.getByLabel('Guard quantity').count(), 0);
  }, { width }));
  await check(`enabled load deep links open load work rather than falling into the cached schedule at ${width}px`, () => fixture(async f => {
    await f.offline(false); await f.page.goto(BASE + '/admin/field.html#/load?vehicle=car_a&day=2027-06-01');
    await f.page.getByText('Window:', { exact: false }).waitFor(); assert.equal(new URL(f.page.url()).hash, '#/load?vehicle=car_a&day=2027-06-01');
    await f.page.goto(BASE + '/admin/field.html');
    await f.page.getByRole('heading', { name: "Today's schedule" }).waitFor();
    await f.prepare(); await f.offline(); await f.page.evaluate(() => window.dispatchEvent(new Event('offline')));
    await f.page.goto(BASE + '/admin/field.html#/load/closing?vehicle=car_a&day=2027-06-01');
    await f.page.getByRole('heading', { name: 'End-of-day count', exact: true }).waitFor();
    assert.equal(await f.page.getByRole('heading', { name: 'Saved schedule', exact: true }).count(), 0);
    await f.page.getByRole('link', { name: '← Schedule', exact: true }).click();
    await f.page.getByRole('heading', { name: 'Saved schedule', exact: true }).waitFor();
    assert.match(await f.page.locator('#syncBadge').innerText(), /Offline/);
    await f.page.getByRole('button', { name: 'Open saved visit' }).first().tap();
    await f.page.getByRole('heading', { name: 'Saved Customer A', level: 1, exact: true }).waitFor();
    await f.page.getByRole('link', { name: '← Saved schedule', exact: true }).focus();
    await f.page.keyboard.press('Enter'); await f.page.getByRole('heading', { name: 'Saved schedule', exact: true }).waitFor();
    const open = f.page.getByRole('button', { name: 'Open saved visit' }).first(); await open.focus(); await f.page.keyboard.press('Enter');
    await f.page.getByRole('heading', { name: 'Saved Customer A', level: 1, exact: true }).waitFor();
    assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await f.page.screenshot({ path: join(evidence, `gated-route-visit-${width}.png`), fullPage: true });
  }, { width, hasTouch: true }));
}

const scenarios = ['siding', 'no-bleach-day', 'mixed-services', 'lighting', 'winter-replenishment', 'repeated-jobs', 'late-schedule-change', 'permission', 'shortage', 'lost-response'];
await check('all ten scenario wrappers throw rather than invent a backend fixture', async () => {
  for (const label of scenarios) {
    const { default: scenario } = await import(`./fixtures/load-contract/${label}.mjs`);
    assert.equal(scenario.scenarioLabel, label); assert.deepEqual(Object.keys(scenario), ['scenarioLabel', 'readContractExamples']);
    assert.throws(() => scenario.readContractExamples(), /TODO: frozen 10\.1 load contract examples required/);
  }
});
await browser.close();
writeFileSync(join(evidence, 'results.json'), JSON.stringify({ results, passed: results.filter(x => x.ok).length, failed: results.filter(x => !x.ok).length }, null, 2) + '\n');
console.log(`${results.filter(x => x.ok).length} PASS / ${results.filter(x => !x.ok).length} FAIL`);
if (results.some(x => !x.ok)) process.exitCode = 1;
