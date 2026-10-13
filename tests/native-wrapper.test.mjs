import pkg from '/opt/node-tools/node_modules/playwright/index.js';
const { chromium } = pkg;
import assert from 'node:assert/strict';

const BASE = 'http://localhost:8743';
const results = [];
function record(name, fn) {
  return Promise.resolve().then(fn).then(
    () => results.push({ name, ok: true }),
    (err) => results.push({ name, ok: false, err: err.message || String(err) })
  );
}

const FAKE_CAPACITOR_CORE = `
  export const _state = { native: false };
  export const Capacitor = {
    isNativePlatform: () => _state.native,
    getPlatform: () => (_state.native ? 'android' : 'web')
  };
`;
const FAKE_CAMERA = `
  export const Camera = {
    async takePhoto() {
      // native.js's real takeNativePhoto() does fetch(result.webPath).blob()
      // -- a made-up string would reject that fetch and silently resolve
      // null (indistinguishable from a cancelled capture), so this hands
      // back a real, fetchable blob: URL the same way the actual web
      // implementation of Camera.takePhoto() would.
      const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' });
      return { webPath: URL.createObjectURL(blob) };
    }
  };
`;
const FAKE_SHARE = `
  export const Share = {
    async share(opts) {
      globalThis.__shareCalls = globalThis.__shareCalls || [];
      globalThis.__shareCalls.push(opts);
      if (globalThis.__shareShouldFail) throw new Error('no share target');
    }
  };
`;
const FAKE_FILESYSTEM = `
  export const Directory = { Data: 'DATA', Cache: 'CACHE' };
  export const Filesystem = {
    async writeFile(opts) { globalThis.__fsWrites = globalThis.__fsWrites || []; globalThis.__fsWrites.push(opts); },
    async getUri(opts) { return { uri: 'file:///fake/' + opts.path }; }
  };
`;
const FAKE_HAPTICS = `
  export const ImpactStyle = { Light: 'LIGHT' };
  export const Haptics = { async impact() { globalThis.__hapticCalls = (globalThis.__hapticCalls || 0) + 1; } };
`;
const FAKE_STATUSBAR = `
  globalThis.__statusBarFetched = true;
  export const Style = { Dark: 'DARK' };
  export const StatusBar = { async setBackgroundColor() {}, async setStyle() {} };
`;
const FAKE_GEOLOCATION = `
  export const Geolocation = {
    async getCurrentPosition() {
      if (globalThis.__geoShouldFail) throw new Error('permission denied');
      return { coords: { latitude: globalThis.__geoLat ?? 49.0, longitude: globalThis.__geoLng ?? -123.0 } };
    }
  };
`;
const FAKE_SUPABASE = `
  export const supabase = { auth: { signOut: async () => {} } };
  export async function getSession() { return { session: null, isAdmin: false }; }
`;
const FAKE_API = `
  export async function getSettings() { return { company: { website: 'https://novashieldmaintenance.com' } }; }
  export async function uploadJobPhoto(jobId, file, opts) {
    globalThis.__uploadCalls = globalThis.__uploadCalls || [];
    globalThis.__uploadCalls.push({ jobId, fileName: file.name, fileType: file.type, opts });
    return { id: 'fake-attachment' };
  }
  export async function signedPhotoUrl() { return 'https://example.invalid/signed.jpg'; }
  export async function listAttachments() { return []; }
  export async function deleteAttachment() {}
  // ES module imports are cached per-page by URL -- this one module instance
  // is shared across every test below once imported, so every function any
  // tested view needs lives here from the start; globalThis.__todaysVisits
  // lets individual tests vary listTodaysVisits' response without needing a
  // second (ineffective, post-cache) page.route() call.
  export async function listTodaysVisits() { return globalThis.__todaysVisits || []; }
  // Batch 2 added a "Coming up" list to the schedule screen, which fetches
  // this alongside today's visits. Same globalThis escape hatch as above so a
  // test can vary it; defaults to empty, which is what these arrival-banner
  // tests want -- they assert on today's cards only.
  export async function listUpcomingVisits() { return globalThis.__upcomingVisits || []; }
`;

async function main() {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();

  const mock = (urlPattern, body, contentType = 'application/javascript') =>
    page.route(urlPattern, (route) => route.fulfill({ status: 200, contentType, body }));

  await mock('**/shared/vendor/@capacitor/core/dist/index.js', FAKE_CAPACITOR_CORE);
  await mock('**/shared/vendor/@capacitor/camera/dist/esm/index.js', FAKE_CAMERA);
  await mock('**/shared/vendor/@capacitor/share/dist/esm/index.js', FAKE_SHARE);
  await mock('**/shared/vendor/@capacitor/filesystem/dist/esm/index.js', FAKE_FILESYSTEM);
  await mock('**/shared/vendor/@capacitor/haptics/dist/esm/index.js', FAKE_HAPTICS);
  await mock('**/shared/vendor/@capacitor/status-bar/dist/esm/index.js', FAKE_STATUSBAR);
  await mock('**/shared/vendor/@capacitor/geolocation/dist/esm/index.js', FAKE_GEOLOCATION);
  await mock(`${BASE}/shared/supabase.js`, FAKE_SUPABASE);
  await mock(`${BASE}/admin/js/lib/api.js`, FAKE_API);

  page.on('pageerror', (err) => console.error('PAGE ERROR:', err.message));

  await page.goto(`${BASE}/admin/field.html`);
  // field.js's own bootstrap resolves getSession() -> no session -> login
  // screen. We don't care about that; we only use this page as a same-
  // origin host to dynamically import real modules from.
  await page.waitForTimeout(200);

  // ---------------------------------------------------------------- A ----
  await record('native.js: isNative() is false by default (plain browser)', async () => {
    const isNative = await page.evaluate(async () => {
      const mod = await import('/admin/js/lib/native.js');
      return mod.isNative();
    });
    assert.equal(isNative, false);
  });

  await record('native.js: setStatusBarTheme() never touches StatusBar plugin off-native', async () => {
    await page.evaluate(() => { globalThis.__statusBarFetched = false; });
    await page.evaluate(async () => {
      const mod = await import('/admin/js/lib/native.js');
      await mod.setStatusBarTheme();
    });
    const fetched = await page.evaluate(() => globalThis.__statusBarFetched);
    assert.equal(fetched, false, 'StatusBar module should never be imported when isNative() is false');
  });

  await record('native.js: hapticLight() never throws off-native', async () => {
    await page.evaluate(async () => {
      const mod = await import('/admin/js/lib/native.js');
      await mod.hapticLight();
    });
  });

  await record('native.js: getDevicePosition() resolves real coords when the plugin succeeds', async () => {
    await page.evaluate(() => { globalThis.__geoShouldFail = false; globalThis.__geoLat = 49.1234; globalThis.__geoLng = -123.5678; });
    const pos = await page.evaluate(async () => {
      const mod = await import('/admin/js/lib/native.js');
      return mod.getDevicePosition();
    });
    assert.deepEqual(pos, { latitude: 49.1234, longitude: -123.5678 });
  });

  await record('native.js: getDevicePosition() resolves null (never throws) on permission denial', async () => {
    await page.evaluate(() => { globalThis.__geoShouldFail = true; });
    const pos = await page.evaluate(async () => {
      const mod = await import('/admin/js/lib/native.js');
      return mod.getDevicePosition();
    });
    assert.equal(pos, null);
  });

  await record('native.js: shareOrFallback() runs fallbackFn when Share fails', async () => {
    await page.evaluate(() => { globalThis.__shareShouldFail = true; globalThis.__fallbackRan = false; });
    const shared = await page.evaluate(async () => {
      const mod = await import('/admin/js/lib/native.js');
      return mod.shareOrFallback({ title: 't', url: 'https://x' }, async () => { globalThis.__fallbackRan = true; });
    });
    const fallbackRan = await page.evaluate(() => globalThis.__fallbackRan);
    assert.equal(shared, false);
    assert.equal(fallbackRan, true);
  });

  await record('native.js: shareOrFallback() does not call fallbackFn when Share succeeds', async () => {
    await page.evaluate(() => { globalThis.__shareShouldFail = false; globalThis.__fallbackRan = false; });
    const shared = await page.evaluate(async () => {
      const mod = await import('/admin/js/lib/native.js');
      return mod.shareOrFallback({ title: 't', url: 'https://x' }, async () => { globalThis.__fallbackRan = true; });
    });
    const fallbackRan = await page.evaluate(() => globalThis.__fallbackRan);
    assert.equal(shared, true);
    assert.equal(fallbackRan, false);
  });

  await record('native.js: persistPhotoLocally() is a no-op (null) off-native', async () => {
    const result = await page.evaluate(async () => {
      const mod = await import('/admin/js/lib/native.js');
      const file = new File([new Uint8Array([1, 2, 3])], 'x.jpg', { type: 'image/jpeg' });
      return mod.persistPhotoLocally(file);
    });
    assert.equal(result, null);
  });

  // ---------------------------------------------------------------- B ----
  await record('photo-markup.js: Skip resolves the original File unchanged', async () => {
    const ok = await page.evaluate(async () => {
      const mod = await import('/admin/js/components/photo-markup.js');
      const original = new File([new Uint8Array([9, 9, 9])], 'before.jpg', { type: 'image/jpeg' });
      // openPhotoMarkup loads the file into an <img> via createObjectURL;
      // give it a trivial real image so the load event actually fires.
      const realImgBlob = await fetch(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
      ).then((r) => r.blob());
      const realImgFile = new File([realImgBlob], 'before.jpg', { type: 'image/png' });
      const promise = mod.openPhotoMarkup(realImgFile);
      await new Promise((r) => setTimeout(r, 100));
      document.querySelector('button')?.click(); // first button rendered is Arrow (tool), not what we want
      const buttons = [...document.querySelectorAll('button')];
      const skipBtn = buttons.find((b) => b.textContent === 'Skip');
      skipBtn.click();
      const result = await promise;
      return result === realImgFile;
    });
    assert.equal(ok, true, 'Skip should resolve the exact same File reference');
  });

  await record('photo-markup.js: drawing a mark then "Use this photo" resolves a new PNG File', async () => {
    const info = await page.evaluate(async () => {
      const mod = await import('/admin/js/components/photo-markup.js');
      const realImgBlob = await fetch(
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
      ).then((r) => r.blob());
      const original = new File([realImgBlob], 'original-name.jpg', { type: 'image/png' });
      const promise = mod.openPhotoMarkup(original);
      await new Promise((r) => setTimeout(r, 100));
      const canvas = document.querySelector('canvas');
      const rect = canvas.getBoundingClientRect();
      const down = new PointerEvent('pointerdown', { clientX: rect.left + 5, clientY: rect.top + 5 });
      const move = new PointerEvent('pointermove', { clientX: rect.left + 40, clientY: rect.top + 40 });
      const up = new PointerEvent('pointerup', { clientX: rect.left + 40, clientY: rect.top + 40 });
      canvas.dispatchEvent(down);
      canvas.dispatchEvent(move);
      window.dispatchEvent(up);
      const buttons = [...document.querySelectorAll('button')];
      buttons.find((b) => b.textContent === 'Use this photo').click();
      const result = await promise;
      return { sameRef: result === original, name: result.name, type: result.type, size: result.size };
    });
    assert.equal(info.sameRef, false, 'a drawn mark should produce a new File, not the original');
    assert.equal(info.name, 'original-name.jpg', 'markup preserves the original filename');
    assert.equal(info.type, 'image/png');
    assert.ok(info.size > 0);
  });

  // ---------------------------------------------------------------- C ----
  await record('field-photos.js: "+ Add photo" opens the file input on web, never the native camera', async () => {
    const calls = await page.evaluate(async () => {
      const mod = await import('/admin/js/views/field-photos.js');
      const panel = mod.createPhotosPanel({ jobId: 'job-1' });
      document.body.appendChild(panel.root);
      await panel.render();
      let clicked = false;
      const input = panel.root.querySelector('input[type=file]');
      input.addEventListener('click', (e) => { clicked = true; e.preventDefault(); });
      const addBtn = [...panel.root.querySelectorAll('button')].find((b) => b.textContent === '+ Add photo');
      addBtn.click();
      await new Promise((r) => setTimeout(r, 50));
      panel.root.remove();
      return { clicked };
    });
    assert.equal(calls.clicked, true, 'web path must still click the hidden file input');
  });

  // ---------------------------------------------------------------- D ----
  await record('quote.js: Download PDF / Preview Quote / Copy SMS keep their web behaviour off-native', async () => {
    const info = await page.evaluate(async () => {
      const mod = await import('/admin/js/views/quote.js');
      const job = { id: 'job-1', customers: { name: 'Jane Doe', phone: '+16045550123' }, properties: { address_line1: '123 Main St' } };
      const quote = {
        id: 'quote-1', version: 1, kind: 'final', status: 'draft', total: 500, subtotal: 500, tax_total: 0,
        valid_until: new Date().toISOString(), quote_line_items: [], quote_adjustments: []
      };
      const panel = mod.createQuotePanel({ job, onChange: () => {} });
      document.body.appendChild(panel.root);
      panel.render({ quotes: [quote] });
      await new Promise((r) => setTimeout(r, 50)); // let getSettings().then(...) resolve
      panel.render({ quotes: [quote] }); // re-render now that company.website is populated
      const links = [...panel.root.querySelectorAll('a')];
      const previewLink = links.find((a) => a.textContent === 'Preview Quote');
      const pdfLink = links.find((a) => a.textContent === 'Download PDF');
      const buttons = [...panel.root.querySelectorAll('button')];
      const smsBtn = buttons.find((b) => b.textContent === 'Copy SMS Text');
      const result = {
        previewHref: previewLink.getAttribute('href'),
        previewTarget: previewLink.getAttribute('target'),
        pdfHref: pdfLink.getAttribute('href'),
        pdfTarget: pdfLink.getAttribute('target'),
        pdfText: pdfLink.textContent,
        smsText: smsBtn ? smsBtn.textContent : null
      };
      panel.root.remove();
      return result;
    });
    // Batch 5 canonical URL: the configured website matches customer delivery.
    assert.equal(info.previewHref, 'https://novashieldmaintenance.com/quote.html?id=quote-1');
    assert.equal(info.previewTarget, '_blank');
    assert.equal(info.pdfHref, 'https://novashieldmaintenance.com/quote.html?id=quote-1&print=1');
    assert.equal(info.pdfTarget, '_blank');
    assert.equal(info.pdfText, 'Download PDF');
    assert.equal(info.smsText, 'Copy SMS Text');
  });

  // ---------------------------------------------------------------- E ----
  const sampleVisit = {
    id: 'job-1', status: 'scheduled', scheduled_for: new Date().toISOString(),
    customers: { name: 'Jane Doe', phone: '+16045550123' },
    properties: { address_line1: '123 Main St', city: 'Vancouver', latitude: 49.0, longitude: -123.0 },
    ns_quotes: []
  };

  await record('field-schedule.js: no arrival banner when the device position is unavailable', async () => {
    await page.evaluate((visit) => { globalThis.__todaysVisits = [visit]; globalThis.__geoShouldFail = true; }, sampleVisit);
    const bannerCount = await page.evaluate(async () => {
      const mod = await import('/admin/js/views/field-schedule.js');
      const mount = document.createElement('div');
      document.body.appendChild(mount);
      await mod.renderSchedule({ mount, navigate: () => {} });
      await new Promise((r) => setTimeout(r, 100));
      const count = mount.querySelectorAll('.arrival-banner').length;
      mount.remove();
      return count;
    });
    assert.equal(bannerCount, 0);
  });

  await record('field-schedule.js: arrival banner appears when the device is within 100m of the property', async () => {
    await page.evaluate(() => { globalThis.__geoShouldFail = false; globalThis.__geoLat = 49.0; globalThis.__geoLng = -123.0; });
    const info = await page.evaluate(async () => {
      const mod = await import('/admin/js/views/field-schedule.js');
      const mount = document.createElement('div');
      document.body.appendChild(mount);
      await mod.renderSchedule({ mount, navigate: () => {} });
      await new Promise((r) => setTimeout(r, 100));
      const banner = mount.querySelector('.arrival-banner');
      const text = banner ? banner.textContent : null;
      mount.remove();
      return { found: !!banner, text };
    });
    assert.equal(info.found, true);
    assert.match(info.text, /Near scheduled site/);
  });

  // ------------------------------------------------- native-path branches --
  // Everything above exercises the off-native (plain browser) fallback
  // contract. These flip the mocked Capacitor.isNativePlatform() to true
  // and confirm the native branches are actually reachable and wired to
  // the right plugin calls -- the thing that can't be exercised against a
  // real device from this sandbox, so it's exercised here against the
  // mocked plugin surface instead.
  await record('native.js: isNative() reflects the mocked native platform', async () => {
    const isNative = await page.evaluate(async () => {
      const core = await import('/admin/js/lib/native.js');
      const capMod = await import('/shared/vendor/@capacitor/core/dist/index.js');
      capMod._state.native = true;
      return core.isNative();
    });
    assert.equal(isNative, true);
  });

  await record('field-photos.js: "+ Add photo" calls the native camera (not the file input) when native', async () => {
    const info = await page.evaluate(async () => {
      const mod = await import('/admin/js/views/field-photos.js');
      globalThis.__uploadCalls = [];
      const panel = mod.createPhotosPanel({ jobId: 'job-native' });
      document.body.appendChild(panel.root);
      await panel.render();
      let inputClicked = false;
      const input = panel.root.querySelector('input[type=file]');
      input.addEventListener('click', () => { inputClicked = true; });
      const addBtn = [...panel.root.querySelectorAll('button')].find((b) => b.textContent === '+ Add photo');
      addBtn.click();
      await new Promise((r) => setTimeout(r, 150));
      // The native camera photo lands in openPhotoMarkup() next, which
      // waits on its <img onload> -- give the markup modal's own "Skip"
      // a click so commitPhoto() can finish and reach upload().
      const skipBtn = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Skip');
      if (skipBtn) skipBtn.click();
      await new Promise((r) => setTimeout(r, 150));
      panel.root.remove();
      return { inputClicked, uploadCalls: globalThis.__uploadCalls };
    });
    assert.equal(info.inputClicked, false, 'native must bypass the file input entirely');
    assert.equal(info.uploadCalls.length, 1, 'the native-captured photo should still reach uploadJobPhoto()');
    assert.match(info.uploadCalls[0].fileName, /^photo-\d+\.jpg$/); // native.js normalizes jpeg -> jpg
  });

  await record('quote.js: Download PDF shares the absolute public URL when native', async () => {
    const info = await page.evaluate(async () => {
      globalThis.__shareCalls = [];
      globalThis.__shareShouldFail = false;
      const mod = await import('/admin/js/views/quote.js');
      const job = { id: 'job-1', customers: { name: 'Jane Doe', phone: '+16045550123' }, properties: { address_line1: '123 Main St' } };
      const quote = {
        id: 'quote-native', version: 1, kind: 'final', status: 'draft', total: 777, subtotal: 777, tax_total: 0,
        valid_until: new Date().toISOString(), quote_line_items: [], quote_adjustments: []
      };
      const panel = mod.createQuotePanel({ job, onChange: () => {} });
      document.body.appendChild(panel.root);
      panel.render({ quotes: [quote] });
      await new Promise((r) => setTimeout(r, 50));
      panel.render({ quotes: [quote] });
      const links = [...panel.root.querySelectorAll('a')];
      const pdfLink = links.find((a) => a.textContent === 'Share / Print');
      const pdfText = pdfLink ? pdfLink.textContent : null;
      const pdfHref = pdfLink ? pdfLink.getAttribute('href') : null;
      pdfLink?.dispatchEvent(new MouseEvent('click', { cancelable: true, bubbles: true }));
      await new Promise((r) => setTimeout(r, 50));
      const smsBtn = [...panel.root.querySelectorAll('button')].find((b) => b.textContent === 'Text Quote');
      panel.root.remove();
      return { pdfText, pdfHref, shareCalls: globalThis.__shareCalls, smsBtnFound: !!smsBtn };
    });
    assert.equal(info.pdfText, 'Share / Print');
    assert.equal(info.pdfHref, 'https://novashieldmaintenance.com/quote.html?id=quote-native&print=1');
    assert.equal(info.shareCalls.length, 1);
    assert.equal(info.shareCalls[0].url, 'https://novashieldmaintenance.com/quote.html?id=quote-native&print=1');
    assert.equal(info.smsBtnFound, true, 'Copy SMS Text should relabel to "Text Quote" when native');
  });

  await record('native.js: shareCurrentPage() writes the rendered page to Filesystem then shares it', async () => {
    const info = await page.evaluate(async () => {
      globalThis.__fsWrites = [];
      globalThis.__shareCalls = [];
      globalThis.__shareShouldFail = false;
      const mod = await import('/admin/js/lib/native.js');
      const ok = await mod.shareCurrentPage({ fileName: 'report-test.html', title: 'Test Report' });
      return { ok, fsWrites: globalThis.__fsWrites, shareCalls: globalThis.__shareCalls };
    });
    assert.equal(info.ok, true);
    assert.equal(info.fsWrites.length, 1);
    assert.equal(info.fsWrites[0].path, 'report-test.html');
    assert.equal(info.fsWrites[0].directory, 'CACHE');
    assert.equal(info.shareCalls.length, 1);
    assert.equal(info.shareCalls[0].url, 'file:///fake/report-test.html');
    assert.equal(info.shareCalls[0].title, 'Test Report');
  });

  await record('native.js: shareCurrentPage() falls back to false when Share fails', async () => {
    const ok = await page.evaluate(async () => {
      globalThis.__shareShouldFail = true;
      const mod = await import('/admin/js/lib/native.js');
      return mod.shareCurrentPage({ fileName: 'report-fail.html', title: 'Test Report' });
    });
    assert.equal(ok, false);
  });

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}

main().catch((err) => { console.error(err); process.exit(1); });
