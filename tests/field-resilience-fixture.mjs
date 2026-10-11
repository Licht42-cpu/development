import { BASE, FAKE_CAPACITOR_CORE } from './test-harness.mjs';
import { execFileSync } from 'node:child_process';

export const JOB_A = '11111111-1111-4111-8111-111111111111';
export const JOB_B = '22222222-2222-4222-8222-222222222222';

const api = `
  function job(id) {
    return { id, status: 'in_progress', customers: { name: __customerName || (id === '${JOB_B}' ? 'Second Visit' : 'First Visit'),
      phone: '5550100', email: 'customer@example.test' }, properties: {
      id: 'property-' + id, address_line1: 'Test address', city: 'Test City', passport: __passportOverride } };
  }
  function value(name, id) {
    if (name === 'getJob') return job(id);
    if (name === 'getSettings') return { company: { website: 'https://example.test' } };
    if (name === 'listServices') return [{ id: 'service', key: 'test_service', name: __serviceName || 'Test Service',
      unit: 'linear_ft', quotable: true }];
    if (name === 'listMeasurements') return Array.from({ length: __measurementCount ?? 1 }, (_, i) => ({
      id: 'measurement-' + i, service_id: 'service', unit: 'linear_ft', quantity: 7,
      label: 'Area ' + (i + 1), measurement_modifiers: [], job_measurement_addons: [] }));
    if (name === 'listNotes') return __notes || [];
    if (name === 'listTodaysVisits') return Array.from({ length: __visitCount ?? 0 }, (_, i) => ({
      ...job('${JOB_A}'), id: '33333333-3333-4333-8333-' + String(i).padStart(12, '0'),
      customers: { name: __customerName || 'Customer ' + (i + 1) } }));
    return [];
  }
  async function read(name, id) {
    __reads.push({ name, id });
    if (__defer[name]) await new Promise(resolve => __waiting.push({ name, id, resolve }));
    if (__fail[name]) throw new Error(__fail[name]);
    return value(name, id);
  }
  async function write(name, args) {
    const call = { name, args }; __writes.push(call);
    if (__defer[name]) await new Promise(resolve => { call.finish = resolve; });
    if (__fail[name]) throw new Error(__fail[name]);
    return {};
  }
  export const getJob = id => read('getJob', id);
  ${['listServices','listModifiers','listSiteFactors','listInspectionFlags','listServiceFlagMap','getSettings',
    'listPricingRules','listSections','listMeasurements','listJobFlags','calculatePricing','listQuotes',
    'listAttachments','listNotes','listTodaysVisits','listUpcomingVisits'].map(name =>
    `export const ${name} = id => read('${name}', id);`).join('\n')}
  ${['updateProperty','createMeasurement','uploadJobPhoto','uploadSignature','saveQuoteSignature','updateJob',
    'completeJob','createSection','updateSection','deleteSection','updateMeasurement','deleteMeasurement',
    'addMeasurementAddon','deleteMeasurementAddon','setMeasurementModifier','addNote'].map(name =>
    `export const ${name} = (...args) => write('${name}', args);`).join('\n')}
  export const signedPhotoUrl = async () => '';
`;

const auth = `
  export const supabase = { auth: { signOut: async () => {} } };
  export async function getSession() {
    __sessions++;
    if (__fail.session) throw new Error(__fail.session);
    return { session: { user: { id: 'fixture-admin' } }, isAdmin: true };
  }
`;

export async function fieldFixture(browser, { width = 390, hash = '#/', config = {} } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  await context.addInitScript(config => {
    Object.assign(globalThis, { __fail: {}, __defer: {}, __reads: [], __writes: [], __waiting: [], __sessions: 0,
      __serviceName: '', __customerName: '', __notes: [], __visitCount: 0, __measurementCount: 1,
      __started: performance.now(), __passportOverride: {} }, config);
    if (config.__storageBlocked) indexedDB.open = () => { throw new Error('Device storage unavailable'); };
  }, config);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const mock = (url, body) => context.route(url, route => route.fulfill({ status: 200,
    contentType: 'application/javascript', body }));
  // Load the exact prior product files into the same browser fixture to
  // demonstrate failing checks without touching the working checkout.
  if (process.env.FIELD_BASELINE === '1') {
    for (const path of ['admin/js/field.js', 'admin/js/views/field-workspace.js',
      'admin/js/lib/offline-queue.js', 'admin/css/admin.css']) {
      const body = execFileSync('git', ['show', `d71f467:${path}`], { encoding: 'utf8' });
      await context.route(`${BASE}/${path}`, route => route.fulfill({ status: 200,
        contentType: path.endsWith('.css') ? 'text/css' : 'application/javascript', body }));
    }
  }
  await mock(`${BASE}/admin/js/lib/api.js`, api);
  await mock(`${BASE}/shared/supabase.js`, auth);
  await mock('**/shared/vendor/@capacitor/core/dist/index.js', FAKE_CAPACITOR_CORE);
  await mock('**/shared/vendor/@capacitor/geolocation/dist/esm/index.js',
    'export const Geolocation = { getCurrentPosition: async () => { throw new Error("No fixture GPS"); } };');
  await page.goto(`${BASE}/admin/field.html${hash}`);
  await page.waitForFunction(() => __sessions > 0);
  // Playwright's polling predicate must be synchronous: a Promise is truthy
  // even when its eventual value is false, so importing inside it did not wait.
  await page.evaluate(async () => { window.__fixtureQueue = await import('/admin/js/lib/offline-queue.js'); });
  await page.waitForFunction(() => !__fixtureQueue.syncState().syncing);
  return { context, page, errors };
}

export async function queueAction(page, label = 'Save Property Passport') {
  return page.evaluate(async label => {
    const queue = await import('/admin/js/lib/offline-queue.js');
    // Seed offline without emitting a reconnect event. Online writes now
    // join the durable ordered queue and would retry earlier seed records.
    __fail.updateProperty = 'Failed to fetch';
    const online = navigator.onLine;
    Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
    await queue.callOrQueue('updateProperty', { id: 'fixture-property', patch: { passport: { preferences: label } } }, label);
    Object.defineProperty(navigator, 'onLine', { value: online, configurable: true });
    // Repaint the current connectivity without invoking the online replay
    // hook. These are seed records for a later explicit reconnect/retry.
    window.dispatchEvent(new Event('offline'));
    // Leave the network unavailable until a test explicitly reconnects.
    // A background online event must not consume seed records between steps.
    __writes = []; // Subsequent assertions audit replay/discard, not seeding.
    return (await queue.pending()).at(-1).id;
  }, label);
}
