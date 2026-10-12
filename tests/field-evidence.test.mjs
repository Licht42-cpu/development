import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { offlineFixture, BASE, JOB, SECOND, OWNER } from './offline-work-fixture.mjs';
const { default: pw } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node-tools/node_modules/playwright/index.js');
const launch = { executablePath: process.env.PLAYWRIGHT_CHROMIUM || '/opt/pw-browsers/chromium' };
const browser = await pw.chromium.launch(launch);
const evidence = process.env.FIELD_EVIDENCE || join(tmpdir(), 'nova-field-evidence');
mkdirSync(evidence, { recursive: true });
const results = [];
async function check(name, work) {
  if (process.env.FIELD_EVIDENCE_ONLY && !name.includes(process.env.FIELD_EVIDENCE_ONLY)) return;
  try { await work(); results.push({ name, ok: true }); console.log('PASS - ' + name); }
  catch (error) { results.push({ name, ok: false, error: error.stack }); console.log('FAIL - ' + name + '\n' + error.stack); }
}
async function setup(options = {}) {
  const f = await offlineFixture(browser, { open: false, ...options });
  const faults = {
    original: ['admin/js/lib/field-captures.js', 'original: file, prepared: null', "original: new Blob(['BROKEN ORIGINAL']), prepared: null"],
    review: ['admin/js/components/field-dictation.js', "preview.value = [baseline, text].filter(Boolean).join('\\n');", "target.value = text; preview.value = [baseline, text].filter(Boolean).join('\\n');"],
    late: ['admin/js/components/field-dictation.js', '|| sequence !== speechSequence || applying || !listening && revision !== atRevision', '']
  };
  if (faults[process.env.FIELD_EVIDENCE_BREAK]) {
    const [file, from, to] = faults[process.env.FIELD_EVIDENCE_BREAK];
    const source = readFileSync(new URL('../' + file, import.meta.url), 'utf8'); assert.ok(source.includes(from));
    await f.context.route('**/' + file, route => route.fulfill({ contentType: 'application/javascript', body: source.replace(from, to) }));
  }
  await f.context.addInitScript(() => {
    window.__speechStarts = 0; window.__speechAborts = 0;
    window.SpeechRecognition = class {
      constructor() { window.__speech = this; }
      start() { __speechStarts++; }
      stop() { this.onend?.(); }
      abort() { __speechAborts++; this.onend?.(); }
    };
    window.__emitSpeech = text => __speech.onresult({ results: [[{ transcript: text }]] });
  });
  if (options.speechSupported === false) await f.context.addInitScript(() => {
    window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined;
  });
  await f.context.route('**/shared/vendor/@capacitor/geolocation/dist/esm/index.js', route => route.fulfill({ contentType: 'application/javascript', body: `
    export const Geolocation = { getCurrentPosition: async () => {
      if (window.__gps === 'denied') throw Object.assign(new Error('Permission denied'), { code: 1 });
      if (window.__gps !== 'reported') throw new Error('No position');
      return { coords: { latitude: 46.52, longitude: -84.33, accuracy: 12.5 } };
    } };` }));
  await f.page.goto(BASE + '/admin/field.html');
  await f.page.getByRole('heading', { name: "Today's schedule" }).waitFor();
  await f.visit(); await f.page.getByLabel('Dictation review').waitFor();
  return f;
}
async function fixture(work, options) {
  const f = await setup(options);
  try { await work(f); assert.deepEqual(f.errors, []); }
  finally { f.state.release?.(); await f.context.close(); }
}
async function originalRows(page) {
  return page.evaluate(async job => {
    const rows = await (await import('/admin/js/lib/field-captures.js')).savedCaptures(job);
    return Promise.all(rows.map(async row => ({ ...row,
      original: Array.from(new Uint8Array(await row.original.arrayBuffer())),
      prepared: row.prepared ? Array.from(new Uint8Array(await row.prepared.arrayBuffer())) : null })));
  }, JOB);
}
async function imageFile(page) {
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 100;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#4a7c50'; ctx.fillRect(0, 0, 100, 100);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  return { name: 'original-front.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') };
}
async function choose(f) {
  const file = await imageFile(f.page);
  await f.page.locator('input[type=file]').setInputFiles(file);
  await f.page.getByText('Mark up the photo (optional)', { exact: true }).waitFor();
  await f.page.waitForFunction(() => Array.from(document.querySelectorAll('canvas')).some(canvas => canvas.width === 100));
  return file;
}
async function dictation(f, text) {
  await f.page.getByRole('button', { name: 'Start dictation', exact: true }).click();
  await f.page.evaluate(text => __emitSpeech(text), text);
  await f.page.getByRole('button', { name: 'Stop dictation', exact: true }).click();
}
const draft = (page, name) => page.evaluate(async ({ job, name }) =>
  (await import('/admin/js/lib/field-cache.js')).readDraft(job, name), { job: JOB, name });

await check('original bytes and metadata commit before markup; Back saves a draft without uploading', () => fixture(async f => {
  const file = await choose(f); const rows = await originalRows(f.page);
  assert.deepEqual(rows[0].original, Array.from(file.buffer)); assert.equal(rows[0].stage, 'original');
  assert.equal(rows[0].metadata.capturedAt, null); assert.equal(rows[0].metadata.captureTimeState, 'unknown');
  assert.equal(rows[0].metadata.captureGpsState, 'unknown'); assert.equal(f.state.writes.length, 0);
  await f.page.keyboard.press('Escape');
  await f.page.getByText('Saved originals on this device (1)', { exact: true }).waitFor();
  assert.equal(f.state.writes.length, 0); assert.equal((await originalRows(f.page))[0].stage, 'original');
}));
await check('original survives reload and resumes; queue submission uses the existing photo handler', () => fixture(async f => {
  const file = await choose(f); await f.page.getByRole('button', { name: 'Keep draft', exact: true }).click();
  await f.page.reload(); await f.page.getByLabel('Dictation review').waitFor();
  assert.deepEqual((await originalRows(f.page))[0].original, Array.from(file.buffer));
  await f.page.getByText('Saved originals on this device (1)', { exact: true }).click();
  await f.page.getByRole('button', { name: 'Resume saved photo' }).click();
  await f.page.getByRole('button', { name: 'Skip', exact: true }).click();
  await f.page.waitForFunction(() => document.querySelector('details')?.textContent.includes('Upload returned successfully'));
  assert.equal(f.state.writes.filter(x => x.name === 'uploadJobPhoto').length, 1);
  assert.equal((await originalRows(f.page))[0].stage, 'uploaded');
  assert.deepEqual((await originalRows(f.page))[0].original, Array.from(file.buffer));
}));
await check('marked upload preserves the unmodified original and selection-time tag', () => fixture(async f => {
  await f.page.getByLabel('Tag', { exact: true }).selectOption('before');
  const file = await choose(f); const selected = (await originalRows(f.page))[0].metadata;
  await f.page.getByLabel('Tag', { exact: true }).evaluate(node => { node.value = 'damage'; node.dispatchEvent(new Event('change', { bubbles: true })); });
  const rect = await f.page.locator('canvas').last().boundingBox();
  await f.page.mouse.move(rect.x + 15, rect.y + 15); await f.page.mouse.down();
  await f.page.mouse.move(rect.x + 80, rect.y + 80); await f.page.mouse.up();
  await f.page.getByRole('button', { name: 'Use this photo', exact: true }).click();
  await f.page.getByText('Saved originals on this device (1)', { exact: true }).waitFor();
  const row = (await originalRows(f.page))[0];
  assert.deepEqual(row.original, Array.from(file.buffer)); assert.notDeepEqual(row.prepared, row.original);
  assert.deepEqual(row.metadata, selected); assert.equal(f.state.writes.find(x => x.name === 'uploadJobPhoto').args[2].kind, 'before');
}));
await check('route interruption closes markup and preserves the unfinished original', () => fixture(async f => {
  const file = await choose(f); await f.page.evaluate(() => { location.hash = '/'; });
  await f.page.getByRole('heading', { name: "Today's schedule" }).waitFor();
  await f.page.getByText('Mark up the photo (optional)', { exact: true }).waitFor({ state: 'hidden' });
  assert.equal(f.state.writes.length, 0); assert.deepEqual((await originalRows(f.page))[0].original, Array.from(file.buffer));
}));
await check('capture storage rejects oversized originals without eviction or queued writes', () => fixture(async f => {
  await assert.rejects(f.page.evaluate(async job => {
    const file = new File([new Uint8Array(50 * 1024 * 1024)], 'too-large.png', { type: 'image/png' });
    await (await import('/admin/js/lib/field-captures.js')).saveOriginal(job, file, {}, 'offline-staff-a');
  }, JOB), /Saved originals are full/);
  assert.deepEqual(await originalRows(f.page), []); assert.equal(f.state.writes.length, 0);
}));
await check('capture budget includes text metadata and frozen upload options', () => fixture(async f => {
  await assert.rejects(f.page.evaluate(async job => {
    const file = new File(['small-image'], 'small.png', { type: 'image/png' });
    await (await import('/admin/js/lib/field-captures.js')).saveOriginal(job, file,
      { elevationTag: 'x'.repeat(50 * 1024 * 1024) }, 'offline-staff-a');
  }, JOB), /Saved originals are full/);
  assert.deepEqual(await originalRows(f.page), []); assert.equal(f.state.writes.length, 0);
}));
await check('removing a local original leaves separately queued photo bytes intact', () => fixture(async f => {
  const file = await choose(f); await f.offline(); await f.page.getByRole('button', { name: 'Skip', exact: true }).click();
  await f.page.waitForFunction(() => document.querySelector('details')?.textContent.includes('Submitted through the outbox'));
  await f.page.getByText('Saved originals on this device (1)', { exact: true }).click();
  f.page.on('dialog', dialog => dialog.accept()); await f.page.getByRole('button', { name: 'Remove local original' }).click();
  await f.page.getByText('Saved originals on this device (1)', { exact: true }).waitFor({ state: 'hidden' });
  assert.deepEqual(await originalRows(f.page), []);
  const queued = await f.page.evaluate(async job => {
    const photos = await (await import('/admin/js/lib/offline-queue.js')).pendingPhotos(job);
    return { length: photos.length, bytes: Array.from(new Uint8Array(await photos[0].file.arrayBuffer())) };
  }, JOB);
  assert.equal(queued.length, 1); assert.deepEqual(queued.bytes, Array.from(file.buffer)); assert.equal(f.state.writes.length, 0);
}));
await check('future capture-store version fails closed and retains the original bytes', () => fixture(async f => {
  const file = await choose(f); await f.page.getByRole('button', { name: 'Keep draft' }).click();
  await f.page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('ns-field-captures', 2); req.onsuccess = () => { req.result.close(); resolve(); }; req.onerror = () => reject(req.error);
  }));
  await assert.rejects(originalRows(f.page), /lower version|version/i);
  const stored = await f.page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('ns-field-captures'); req.onerror = () => reject(req.error);
    req.onsuccess = () => { const db = req.result; const r = db.transaction('captures').objectStore('captures').getAll();
      r.onsuccess = async () => { const bytes = Array.from(new Uint8Array(await r.result[0].original.arrayBuffer())); db.close(); resolve(bytes); }; };
  }));
  assert.deepEqual(stored, Array.from(file.buffer)); assert.equal(f.state.writes.length, 0);
}));
await check('atomic handoff permits only one submission claim for a saved capture', () => fixture(async f => {
  await choose(f); await f.page.getByRole('button', { name: 'Keep draft', exact: true }).click();
  const row = (await originalRows(f.page))[0];
  const outcomes = await f.page.evaluate(async id => {
    const { updateCapture } = await import('/admin/js/lib/field-captures.js');
    return (await Promise.allSettled([1, 2].map(value => updateCapture(id, { stage: 'submitting',
      prepared: new Blob([new Uint8Array([value])], { type: 'image/png' }) })))).map(x => x.status);
  }, row.id);
  assert.deepEqual([...outcomes].sort(), ['fulfilled', 'rejected']);
  assert.deepEqual((await originalRows(f.page))[0].prepared, [outcomes[0] === 'fulfilled' ? 1 : 2]);
}));
await check('failed original commit prevents markup and upload rather than claiming local durability', () => fixture(async f => {
  await f.page.evaluate(() => {
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function(...args) {
      if (this.name === 'captures') throw new DOMException('Injected original quota failure', 'QuotaExceededError');
      return add.apply(this, args);
    };
  });
  await f.page.locator('input[type=file]').setInputFiles(await imageFile(f.page));
  await f.page.getByText('Injected original quota failure', { exact: true }).waitFor();
  assert.equal(await f.page.getByText('Mark up the photo (optional)', { exact: true }).count(), 0);
  assert.deepEqual(await originalRows(f.page), []); assert.equal(f.state.writes.length, 0);
}));
await check('interrupted submission restores originals but offers no automatic fresh upload', () => fixture(async f => {
  const file = await choose(f); f.state.hold = 'uploadJobPhoto';
  await f.page.getByRole('button', { name: 'Skip', exact: true }).click();
  await f.page.waitForFunction(() => document.querySelector('#syncBadge').textContent.includes('Syncing'));
  await f.page.reload(); await f.page.getByLabel('Dictation review').waitFor();
  const row = (await originalRows(f.page))[0]; assert.deepEqual(row.original, Array.from(file.buffer));
  assert.equal(row.stage, 'submitting');
  await f.page.getByText('Saved originals on this device (1)', { exact: true }).click();
  assert.equal(await f.page.getByRole('button', { name: 'Resume saved photo' }).count(), 0);
  assert.match(await f.page.locator('details').innerText(), /Submission needs review/);
  assert.equal(f.state.writes.filter(x => x.name === 'uploadJobPhoto').length, 1);
}));
for (const mode of ['denied', 'unavailable', 'reported']) {
  await check(`review location ${mode} is explicit and never becomes a claimed capture geotag`, () => fixture(async f => {
    await choose(f); await f.page.getByRole('button', { name: 'Keep draft', exact: true }).click();
    await f.page.getByText('Saved originals on this device (1)', { exact: true }).click();
    await f.page.evaluate(mode => { __gps = mode; }, mode);
    await f.page.getByRole('button', { name: 'Record location at review' }).click();
    // Rendering replaces the details after the metadata transaction commits.
    await f.page.getByRole('button', { name: 'Record location at review' }).waitFor({ state: 'hidden' });
    const row = (await originalRows(f.page))[0];
    assert.equal(row.metadata.reviewLocation.state, mode === 'reported' ? 'device_reported' : mode);
    assert.equal(row.metadata.captureGpsState, 'unknown'); assert.equal(row.metadata.capturedAt, null);
    if (mode === 'reported') assert.equal(row.metadata.reviewLocation.accuracyM, 12.5);
  }));
}
await check('photos and speech buffers stay private to their account across switch and return', () => fixture(async f => {
  const file = await choose(f); await f.page.getByRole('button', { name: 'Keep draft', exact: true }).click();
  await dictation(f, 'Private account A words');
  await f.page.evaluate(() => __switchAccount('other-staff')); await f.visit();
  await f.page.getByLabel('Dictation review').waitFor();
  assert.equal(await f.page.getByLabel('Dictation review').inputValue(), ''); assert.deepEqual(await originalRows(f.page), []);
  await f.page.evaluate(owner => __switchAccount(owner), OWNER); await f.visit(); await f.page.getByLabel('Dictation review').waitFor();
  assert.equal(await f.page.getByLabel('Dictation review').inputValue(), 'Private account A words');
  assert.deepEqual((await originalRows(f.page))[0].original, Array.from(file.buffer));
}));
await check('same-account visits do not mix original photos or dictation buffers', () => fixture(async f => {
  await choose(f); await f.page.getByRole('button', { name: 'Keep draft' }).click(); await dictation(f, 'First visit only');
  await f.page.evaluate(id => { location.hash = '/visit/' + id; }, SECOND);
  await f.page.getByRole('heading', { name: 'Saved Customer B', exact: true, level: 1 }).waitFor();
  await f.page.getByLabel('Dictation review').waitFor();
  assert.equal(await f.page.getByLabel('Dictation review').inputValue(), '');
  assert.equal(await f.page.getByText('Saved originals on this device (1)', { exact: true }).count(), 0);
  await f.visit(); await f.page.getByLabel('Dictation review').waitFor();
  assert.equal(await f.page.getByLabel('Dictation review').inputValue(), 'First visit only');
}));

await check('speech is review-only until explicit transfer; note sends only through Save note', () => fixture(async f => {
  await f.page.getByLabel('Note', { exact: true }).fill('Typed context');
  await dictation(f, 'Spoken observation');
  assert.equal(await f.page.getByLabel('Note', { exact: true }).inputValue(), 'Typed context'); assert.equal(f.state.writes.length, 0);
  await f.page.getByLabel('Who can see it', { exact: true }).selectOption('customer');
  assert.match(await f.page.getByText('The note audience is Customer-visible.', { exact: false }).innerText(), /Check the words/);
  await f.page.getByRole('button', { name: 'Add reviewed text to note' }).click();
  await f.page.getByLabel('Dictation review').waitFor();
  await f.page.waitForFunction(() => document.querySelector('textarea[aria-label="Dictation review"]').value === '');
  const saved = await draft(f.page, 'note'); assert.equal(saved.value.body, 'Typed context\nSpoken observation'); assert.equal(saved.value.visibility, 'customer');
  assert.equal(f.state.writes.length, 0);
  await f.page.locator('.card').filter({ has: f.page.getByLabel('Note', { exact: true }) })
    .getByRole('button', { name: 'Save note', exact: true }).click();
  await f.page.waitForFunction(() => document.querySelector('textarea[aria-label="Note"]').value === '');
  assert.equal(f.state.writes.find(x => x.name === 'addNote').args[2], 'customer');
}));
await check('unsubmitted dictation survives reload without appearing as a saved note', () => fixture(async f => {
  await dictation(f, 'Restart review words'); await f.page.reload(); await f.page.getByLabel('Dictation review').waitFor();
  assert.equal(await f.page.getByLabel('Dictation review').inputValue(), 'Restart review words');
  assert.equal(await f.page.getByLabel('Note', { exact: true }).inputValue(), ''); assert.equal(f.state.writes.length, 0);
}));
await check('late final speech cannot overwrite a review edited after stopping', () => fixture(async f => {
  await f.page.getByLabel('Dictation review').fill('Words already reviewed');
  await f.page.getByRole('button', { name: 'Start dictation' }).click();
  await f.page.evaluate(async () => {
    const { supabase } = await import('/shared/supabase.js');
    const original = supabase.auth.getSession;
    const held = new Promise(resolve => { window.releaseSpeechCheck = resolve; });
    supabase.auth.getSession = () => held.then(() => original());
    window.lateSpeech = __emitSpeech('Delayed final words'); __speech.stop();
  });
  await f.page.getByLabel('Dictation review').fill('Edited after stopping');
  await f.page.evaluate(async () => { releaseSpeechCheck(); await lateSpeech; });
  assert.equal(await f.page.getByLabel('Dictation review').inputValue(), 'Edited after stopping');
}));
await check('older speech callbacks cannot overwrite a newer transcript', () => fixture(async f => {
  await f.page.getByRole('button', { name: 'Start dictation' }).click();
  await f.page.evaluate(async () => {
    const { supabase } = await import('/shared/supabase.js');
    const original = supabase.auth.getSession; let first = true;
    const held = new Promise(resolve => { window.releaseFirstSpeech = resolve; });
    supabase.auth.getSession = () => { if (first) { first = false; return held.then(() => original()); } return original(); };
    window.firstSpeech = __emitSpeech('Older words'); await __emitSpeech('Newest words');
    releaseFirstSpeech(); await firstSpeech; __speech.stop();
  });
  assert.equal(await f.page.getByLabel('Dictation review').inputValue(), 'Newest words');
}));
await check('failed note-draft commit retains dictation for recovery instead of clearing it', () => fixture(async f => {
  await dictation(f, 'Keep these words');
  await f.page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function(row, ...args) {
      if (this.name === 'drafts' && row.key?.[2] === 'note') throw new DOMException('Injected note quota failure', 'QuotaExceededError');
      return put.call(this, row, ...args);
    };
  });
  await f.page.getByRole('button', { name: 'Add reviewed text to note' }).click();
  await f.page.getByText(/Note draft not saved:.*Dictation words remain for recovery/).waitFor();
  assert.equal((await draft(f.page, 'dictation-review')).value.text, 'Keep these words');
  assert.equal(f.state.writes.length, 0); await f.page.reload(); await f.page.getByLabel('Dictation review').waitFor();
  assert.equal(await f.page.getByLabel('Dictation review').inputValue(), 'Keep these words');
}));
await check('microphone permission failure retains text and does not send a note', () => fixture(async f => {
  await f.page.getByLabel('Dictation review').fill('Retained text');
  await f.page.getByRole('button', { name: 'Start dictation' }).click();
  await f.page.evaluate(() => { __speech.onerror({ error: 'not-allowed' }); __speech.onend(); });
  await f.page.getByText(/Dictation stopped \(not-allowed\)/).waitFor();
  assert.equal(await f.page.getByLabel('Dictation review').inputValue(), 'Retained text'); assert.equal(f.state.writes.length, 0);
}));
await check('identity read failure stops speech without an unhandled callback or note write', () => fixture(async f => {
  await f.page.getByLabel('Dictation review').fill('Earlier retained words');
  await f.page.getByRole('button', { name: 'Start dictation' }).click();
  await f.page.evaluate(async () => {
    const { supabase } = await import('/shared/supabase.js'); const original = supabase.auth.getSession;
    supabase.auth.getSession = () => { throw new Error('Injected identity read failure'); };
    try { await __emitSpeech('Unverified new words'); } finally { supabase.auth.getSession = original; }
  });
  await f.page.getByText(/Could not retain new speech: Injected identity read failure/).waitFor();
  assert.equal(await f.page.getByLabel('Dictation review').inputValue(), 'Earlier retained words');
  assert.equal(await f.page.getByRole('button', { name: 'Stop dictation' }).isDisabled(), true); assert.equal(f.state.writes.length, 0);
}));
await check('unsupported speech engine has an honest typed review fallback', () => fixture(async f => {
  assert.equal(await f.page.getByRole('button', { name: 'Start dictation' }).isDisabled(), true);
  await f.page.getByText('Speech recognition is unavailable here. You can type and review text below.', { exact: true }).waitFor();
  await f.page.getByLabel('Dictation review').fill('Typed review fallback');
  await f.page.getByRole('button', { name: 'Add reviewed text to note' }).click();
  await f.page.waitForFunction(() => document.querySelector('textarea[aria-label="Dictation review"]').value === '');
  assert.equal((await draft(f.page, 'note')).value.body, 'Typed review fallback'); assert.equal(f.state.writes.length, 0);
}, { speechSupported: false }));
await check('backgrounding stops recognition and drops late results', () => fixture(async f => {
  await f.page.getByRole('button', { name: 'Start dictation' }).click();
  await f.page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { get: () => true }); document.dispatchEvent(new Event('visibilitychange'));
    return __emitSpeech('Late background words');
  });
  assert.equal(await f.page.evaluate(() => __speechAborts), 1);
  assert.equal(await f.page.getByLabel('Dictation review').inputValue(), ''); assert.equal(await draft(f.page, 'dictation-review'), undefined);
}));
await check('leaving a visit aborts recognition and ignores late speech results', () => fixture(async f => {
  await f.page.getByRole('button', { name: 'Start dictation' }).click();
  await f.page.evaluate(() => { window.oldSpeech = __speech; location.hash = '/'; });
  await f.page.getByRole('heading', { name: "Today's schedule" }).waitFor();
  await f.page.evaluate(() => oldSpeech.onresult({ results: [[{ transcript: 'Late private words' }]] }));
  assert.equal(await f.page.evaluate(() => __speechAborts), 1);
  assert.equal(await draft(f.page, 'dictation-review'), undefined); assert.equal(f.state.writes.length, 0);
}));
await check('offline notes accept only reviewed text into a durable unsubmitted draft', () => fixture(async f => {
  await f.page.evaluate(() => { location.hash = '/'; }); await f.page.getByRole('heading', { name: "Today's schedule" }).waitFor();
  await f.prepare(); await f.offline(); await f.page.reload(); await f.page.getByRole('heading', { name: 'Saved schedule' }).waitFor();
  await f.visit(); await f.page.getByLabel('Dictation review').waitFor(); await dictation(f, 'Offline reviewed words');
  await f.page.getByRole('button', { name: 'Add reviewed text to note' }).click();
  await f.page.waitForFunction(() => document.querySelector('textarea[aria-label="Dictation review"]').value === '');
  assert.equal((await draft(f.page, 'note')).value.body, 'Offline reviewed words'); assert.equal(f.state.writes.length, 0);
  await f.page.reload(); await f.page.getByLabel('Note', { exact: true }).waitFor();
  assert.equal(await f.page.getByLabel('Note', { exact: true }).inputValue(), 'Offline reviewed words');
}));
for (const width of [390, 430, 1200]) {
  await check(`${width}px touch/keyboard originals and dictation fit without overflow`, () => fixture(async f => {
    await choose(f); await f.page.getByRole('button', { name: 'Keep draft' }).click();
    const summary = f.page.getByText('Saved originals on this device (1)', { exact: true });
    if (width === 390) await summary.tap(); else { await summary.focus(); await f.page.keyboard.press('Enter'); }
    await f.page.getByRole('button', { name: 'Record location at review' }).waitFor();
    await f.page.getByLabel('Dictation review').fill('Review this observation before sending.');
    await f.page.getByLabel('Dictation review').focus(); await f.page.keyboard.press('Tab');
    const focus = await f.page.getByRole('button', { name: 'Add reviewed text to note' }).evaluate(node => {
      const style = getComputedStyle(node); return { active: document.activeElement === node, width: style.outlineWidth, style: style.outlineStyle };
    });
    assert.equal(focus.active, true); assert.ok(parseFloat(focus.width) >= 2 && focus.style !== 'none');
    assert.ok(await f.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const targets = await f.page.getByRole('button', { name: /Start dictation|Add reviewed text|Resume saved photo|Record location at review/ }).evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
    assert.ok(targets.every(height => height >= 44));
    await f.page.locator('details').screenshot({ path: join(evidence, `originals-${width}.png`) });
    await f.page.getByRole('heading', { name: 'Dictation — review first' }).locator('..').screenshot({ path: join(evidence, `dictation-${width}.png`) });
  }, { width, hasTouch: true }));
}
await check('actual Chromium restart preserves unsubmitted originals and dictation bytes', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'nova-evidence-restart-'));
  let context = await pw.chromium.launchPersistentContext(profile, { ...launch, viewport: { width: 390, height: 900 }, serviceWorkers: 'block' });
  let f = await setup({ persistentContext: context });
  let file;
  try { file = await choose(f); await f.page.getByRole('button', { name: 'Keep draft' }).click(); await dictation(f, 'Across a real browser restart'); }
  finally { await context.close(); }
  context = await pw.chromium.launchPersistentContext(profile, { ...launch, viewport: { width: 390, height: 900 }, serviceWorkers: 'block' });
  f = await setup({ persistentContext: context });
  try {
    assert.deepEqual((await originalRows(f.page))[0].original, Array.from(file.buffer));
    assert.equal(await f.page.getByLabel('Dictation review').inputValue(), 'Across a real browser restart');
    assert.equal(f.state.writes.length, 0);
  } finally { await context.close(); }
});
await browser.close();
writeFileSync(join(evidence, 'results.json'), JSON.stringify({ results, passed: results.filter(x => x.ok).length, failed: results.filter(x => !x.ok).length }, null, 2) + '\n');
console.log(`${results.filter(x => x.ok).length} PASS / ${results.filter(x => !x.ok).length} FAIL`);
if (results.some(x => !x.ok)) process.exitCode = 1;
