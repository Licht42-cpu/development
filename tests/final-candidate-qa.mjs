// Explicit browser qualification of staged bytes; no live credentials or writes.
// Run after cap:sync. API/auth transport doubles are the only unstaged modules.
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { integrationFixture, JOB, PROPERTY } from './operations-integration-fixture.mjs';
import { fieldFixture } from './field-resilience-fixture.mjs';
const { default: pw } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await pw.chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM });
const root = resolve('mobile/www');
const evidence = process.env.FINAL_CANDIDATE_EVIDENCE || '/tmp/nova-final-candidate';
mkdirSync(evidence, { recursive: true });
const cases = [], observations = [];
const surfaces = [
  ['inventory', '#/inventory', 'Inventory', ['Stock', 'Purchasing']],
  ['dispatch', '#/dispatch?location=car_a&day=2027-07-06', 'Dispatch', ['Vehicle', 'Day']],
  ['property', `#/properties/${PROPERTY}`, 'Property access and work zones', ['Entrance']],
  ['handover', `#/jobs/${JOB}`, 'Customer handover', ['Refresh accepted completion for handover']]
];
async function check(name, fn) {
  if (process.env.FINAL_QA_ONLY && !name.includes(process.env.FINAL_QA_ONLY)) return;
  try { await fn(); cases.push({ name, status: 'PASS' }); }
  catch (error) { cases.push({ name, status: 'FAIL', error: error.stack }); }
}
async function fixture(options, fn) {
  const f = await integrationFixture(browser, options);
  const served = new Map();
  try {
    await f.context.route('http://localhost:8743/**', async route => {
      const url = new URL(route.request().url());
      if (['/shared/supabase.js', '/admin/js/lib/api.js'].includes(url.pathname)) return route.fallback();
      const file = resolve(root, '.' + decodeURIComponent(url.pathname));
      if (!file.startsWith(root + '/') || !existsSync(file)) return route.fallback();
      const body = readFileSync(file);
      served.set(url.pathname, createHash('sha256').update(body).digest('hex'));
      const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json' };
      return route.fulfill({ body, contentType: types[extname(file)] || 'application/octet-stream' });
    });
    await f.page.reload();
    await fn(f, served);
    assert.deepEqual(f.errors, []);
    assert.ok(served.has('/admin/js/main.js'));
    assert.ok(served.has('/admin/js/views/operations-routes.js'));
  } finally { await f.context.close(); }
}
for (const [slug, hash, title] of surfaces) await check(`Packaged ${slug}: missing backend remains named and write-free`, () => fixture({ hash,
  config: { __probeError: { code: 'PGRST202', message: 'PRIVATE-CODE-MUST-NOT-RENDER' } } }, async ({ page }) => {
  await page.getByRole('heading', { name: title + ' — unavailable', exact: true }).waitFor();
  const text = await page.locator('#view').innerText();
  assert.match(text, /required backend functions or tables are not available/);
  assert.ok(!text.includes('PRIVATE-CODE-MUST-NOT-RENDER'));
  assert.equal(await page.getByRole('button', { name: /Move stock|Save access|Generate the report/ }).count(), 0);
  const retry = page.getByRole('button', { name: `Check ${title.toLowerCase()} again`, exact: true });
  await retry.focus();
  assert.ok(await retry.evaluate(node => node === document.activeElement));
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: title + ' — unavailable', exact: true }).waitFor();
  const calls = await page.evaluate(() => __calls);
  assert.ok(!calls.some(call => /^(create|save|post|confirm|generate|assign|claim|transfer|release|send|complete)/i.test(call.name)));
}));
for (const width of [390, 430, 1280]) for (const [slug, hash, title] of surfaces) await check(`Packaged ${slug} at ${width}: keyboard, names, layout and measured targets`, () => fixture({ hash, width }, async ({ page }, served) => {
  if (slug === 'inventory') await page.getByText('FIXTURE Cable', { exact: true }).waitFor();
  else if (slug === 'property') await page.getByLabel('Entrance', { exact: true }).waitFor();
  else if (slug === 'handover') await page.getByText('No report yet.', { exact: true }).waitFor();
  else await page.getByRole('heading', { name: title, exact: true }).waitFor();
  assert.equal(await page.evaluate(() => innerWidth), width);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  const control = page.locator('#view button:visible:not([disabled]), #view select:visible:not([disabled]), #view input:visible:not([disabled]), #view a:visible').first();
  await control.focus();
  assert.ok(await control.evaluate(node => node === document.activeElement));
  const focusStyle = await control.evaluate(node => { const s = getComputedStyle(node); return { outline: s.outlineStyle, width: s.outlineWidth, shadow: s.boxShadow }; });
  const accessibility = await page.locator('#view').ariaSnapshot();
  assert.match(accessibility, /(?:button|combobox|textbox|link) "/);
  await page.keyboard.press('Tab');
  assert.ok(await page.evaluate(() => document.activeElement !== document.body));
  const targets = await page.locator('#view button, #view a, #view input, #view select, #view textarea, #view summary').evaluateAll(nodes => nodes.flatMap(node => {
    const r = node.getBoundingClientRect();
    if (!r.width || !r.height || getComputedStyle(node).visibility === 'hidden' || node.type === 'hidden') return [];
    return [{ tag: node.tagName, name: node.getAttribute('aria-label') || [...(node.labels || [])].map(n => n.textContent.trim()).join(' ') || node.textContent.trim() || node.title,
      width: r.width, height: r.height, disabled: !!node.disabled, below44: r.width < 44 || r.height < 44 }];
  }));
  assert.deepEqual(targets.filter(t => t.below44 && !t.disabled).map(t => t.name), [], 'Interactive targets must meet the project 44px minimum');
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: join(evidence, `${slug}-${width}.png`), fullPage: true });
  writeFileSync(join(evidence, `${slug}-${width}.aria.txt`), accessibility);
  observations.push({ slug, width, focusStyle, targets, served: Object.fromEntries(served) });
  if (slug === 'inventory') {
    const options = await page.locator('select').evaluateAll(nodes => nodes.map(n => [...n.options].map(o => o.value)));
    observations.at(-1).selectOptions = options;
    observations.at(-1).levelCreationControl = await page.locator('select option[value="level"]').count() > 0;
  }
}));
for (const width of [390, 430, 1280]) await check(`Packaged crew dispatch at ${width}: scoped claim is named, keyboard reachable and 44px`, () => fixture({ width,
  hash: '#/dispatch?location=car_a&day=2027-07-06', config: {
    __owner: false, __rpcValues: { is_admin: true }, __values: { getDispatchDay: {
      location_code: 'car_a', work_date: '2027-07-06', revision: 2, can_plan: false,
      readable_vehicles: [{ code: 'car_a', name: 'Car A' }], stops: [],
      unassigned_jobs: [{ job_id: JOB, customer_name: 'FIXTURE unassigned', status: 'in_progress' }]
    } }
  } }, async ({ page }, served) => {
  const claim = page.getByRole('button', { name: 'This one is on my car', exact: true });
  await claim.waitFor();
  await claim.focus();
  assert.ok(await claim.evaluate(node => node === document.activeElement));
  const box = await claim.boundingBox();
  assert.ok(box.width >= 44 && box.height >= 44);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.equal(await page.getByRole('button', { name: /Give to / }).count(), 0);
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: join(evidence, `dispatch-crew-${width}.png`), fullPage: true });
  observations.push({ slug: 'dispatch-crew', width, claimTarget: box, served: Object.fromEntries(served) });
}));
await check('An empty device queue cannot claim confirmed server sync', async () => {
  const { page, context } = await fieldFixture(browser);
  try {
    if (process.env.FINAL_BADGE_BASELINE === '1') {
      const body = execFileSync('git', ['show', '5e6583f:admin/js/field.js'], { encoding: 'utf8' });
      await context.route('**/admin/js/field.js', route => route.fulfill({ body, contentType: 'application/javascript' }));
      await page.reload();
    }
    await page.getByRole('button', { name: 'No queued actions', exact: true }).waitFor();
    assert.equal(await page.locator('#syncBadge').innerText(), 'No queued actions');
    assert.deepEqual(await page.evaluate(() => __writes), []);
  } finally { await context.close(); }
});
await browser.close();
writeFileSync(join(evidence, 'browser-qualification.json'), JSON.stringify({ proof: 'Staged application bytes with browser-only API/auth doubles; no live backend or tactile/device proof.', cases, observations }, null, 2) + '\n');
for (const c of cases) console.log(`${c.status} - ${c.name}${c.error ? '\n' + c.error : ''}`);
console.log(`${cases.filter(c => c.status === 'PASS').length}/${cases.length} passed`);
if (cases.some(c => c.status === 'FAIL')) process.exitCode = 1;
