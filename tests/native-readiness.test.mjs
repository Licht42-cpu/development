import assert from 'node:assert/strict';
import { readinessFixture, contrast, queueAction } from './native-readiness-fixture.mjs';
const { default: pkg } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node-tools/node_modules/playwright/index.js');
const browser = await pkg.chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || '/opt/pw-browsers/chromium' });
console.log('Browser:', browser.version());
const results = [];
async function record(name, fn) {
  try { await fn(); results.push({ name, ok: true }); }
  catch (err) { results.push({ name, ok: false, error: err.message }); }
}
async function visit(fn, options) {
  const fixture = await readinessFixture(browser, options);
  try { await fn(fixture); } finally { await fixture.context.close(); }
}
async function axLive(page, text) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const leaves = nodes.filter(node => node.role?.value === 'StaticText' && node.name?.value === text);
    assert.ok(leaves.length, `Text absent from Chromium accessibility tree: ${text}`);
    for (const leaf of leaves) {
      let node = leaf;
      while (node) {
        if (node.properties?.some(prop => prop.name === 'live' && ['polite', 'assertive'].includes(prop.value.value))) return;
        node = nodes.find(parent => parent.nodeId === node.parentId);
      }
    }
    assert.fail('No live ancestor in Chromium accessibility tree');
  } finally { await cdp.detach(); }
}

await record('Quantity saving and failure already reach a polite live region', () => visit(async ({ page }) => {
  await page.evaluate(() => { __defer.updateMeasurement = true; });
  const input = page.getByRole('spinbutton', { name: 'Quantity', exact: true });
  await input.fill('9');
  await page.getByText('Saving quantity…', { exact: true }).waitFor();
  await axLive(page, 'Saving quantity…');
  await page.evaluate(() => { __fail.updateMeasurement = 'permission denied'; __writes.find(w => w.finish)?.finish(); });
  await page.getByRole('button', { name: 'Retry quantity save', exact: true }).waitFor();
  const id = await input.getAttribute('aria-describedby');
  await axLive(page, await page.locator('#' + id).innerText());
}));
await record('A successful quantity save announces completion', () => visit(async ({ page }) => {
  await page.getByRole('spinbutton', { name: 'Quantity', exact: true }).fill('9');
  await page.getByText('Quantity saved.', { exact: true }).waitFor();
  await axLive(page, 'Quantity saved.');
}));
await record('Quantity recovery restores focus to its input when the button disappears', () => visit(async ({ page }) => {
  const input = page.getByRole('spinbutton', { name: 'Quantity', exact: true });
  await input.fill('');
  const button = page.getByRole('button', { name: 'Use saved quantity', exact: true });
  await button.focus(); await page.keyboard.press('Enter');
  assert.equal(await input.evaluate(node => node === document.activeElement), true);
  assert.equal(await input.inputValue(), '7');
}));
await record('Successful keyboard retry restores quantity focus', () => visit(async ({ page }) => {
  await page.evaluate(() => { __fail.updateMeasurement = 'permission denied'; });
  const input = page.getByRole('spinbutton', { name: 'Quantity', exact: true });
  await input.fill('9');
  const retry = page.getByRole('button', { name: 'Retry quantity save', exact: true });
  await retry.waitFor();
  await page.evaluate(() => { __fail.updateMeasurement = null; });
  await retry.focus(); await page.keyboard.press('Enter');
  await retry.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => __writes.length >= 2 && !document.body.textContent.includes('Saving quantity…'));
  assert.equal(await input.evaluate(node => node === document.activeElement), true);
}));
await record('A failed keyboard quantity retry keeps the renewed recovery button focused', () => visit(async ({ page }) => {
  await page.evaluate(() => { __fail.updateMeasurement = 'permission denied'; });
  await page.getByRole('spinbutton', { name: 'Quantity', exact: true }).fill('9');
  const retry = page.getByRole('button', { name: 'Retry quantity save', exact: true }); await retry.waitFor();
  await retry.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => __writes.length >= 2 && !document.body.textContent.includes('Saving quantity…'));
  assert.equal(await retry.evaluate(node => node === document.activeElement), true);
}));
await record('A delayed quantity retry does not reclaim focus from the next field', () => visit(async ({ page }) => {
  await page.evaluate(() => { __fail.updateMeasurement = 'permission denied'; });
  await page.getByRole('spinbutton', { name: 'Quantity', exact: true }).fill('9');
  const retry = page.getByRole('button', { name: 'Retry quantity save', exact: true }); await retry.waitFor();
  await page.evaluate(() => { __fail.updateMeasurement = null; __defer.updateMeasurement = true; });
  await retry.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => __writes.some(write => write.finish));
  const note = page.getByRole('textbox', { name: 'Note', exact: true }); await note.focus();
  await page.evaluate(() => __writes.find(write => write.finish).finish());
  await page.waitForFunction(() => !document.body.textContent.includes('Saving quantity…'));
  assert.equal(await note.evaluate(node => node === document.activeElement), true);
}));
await record('Passport save progress has its own live region and busy state', () => visit(async ({ page }) => {
  await page.evaluate(() => { __defer.updateProperty = true; });
  await page.getByRole('button', { name: 'Save passport', exact: true }).click();
  const status = page.locator('[data-passport-status]');
  await status.waitFor(); assert.equal(await status.innerText(), 'Saving passport…');
  await axLive(page, 'Saving passport…');
  assert.equal(await page.getByRole('button', { name: 'Saving passport…', exact: true }).getAttribute('aria-busy'), 'true');
  assert.ok(await contrast(page.getByRole('button', { name: 'Saving passport…', exact: true })) >= 4.5);
}));
await record('Passport preferences have a programmatic label', () => visit(async ({ page }) => {
  assert.equal(await page.getByRole('textbox', { name: 'Customer preferences', exact: true }).count(), 1);
}));
await record('Outbox badge stays a keyboard button and changes have a separate live region', () => visit(async ({ page }) => {
  await queueAction(page);
  assert.equal(await page.locator('#syncBadge').getAttribute('role'), 'button');
  const status = page.locator('[data-sync-status]');
  await status.waitFor();
  assert.match(await status.innerText(), /sync|saved here/i);
  await axLive(page, await status.innerText());
  await page.locator('#syncBadge').focus(); await page.keyboard.press('Space');
  await page.getByRole('dialog', { name: 'Saved on this device' }).waitFor();
}));
await record('Outbox refresh preserves keyboard focus on the next remaining action', () => visit(async ({ page }) => {
  await queueAction(page, 'First'); await queueAction(page, 'Second');
  await page.locator('#syncBadge').click();
  const button = page.getByRole('button', { name: 'Discard First', exact: true });
  await button.focus();
  page.once('dialog', dialog => dialog.accept());
  await page.keyboard.press('Enter');
  await button.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Discard Second', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Discard Second', exact: true }).evaluate(node => node === document.activeElement), true);
}));
await record('Notes errors update a persistent live region', () => visit(async ({ page }) => {
  await page.getByRole('button', { name: 'Retry notes', exact: true }).waitFor();
  const text = page.getByText(/Could not load notes:/);
  const region = await text.evaluate(node => node.closest('[role="alert"], [role="status"]')?.getAttribute('data-notes-status'));
  assert.equal(region, '');
  await axLive(page, await text.innerText());
}, { config: { __fail: { listNotes: 'permission denied' } } }));
await record('Keyboard notes retry restores a usable focus target on failure and success', () => visit(async ({ page }) => {
  const retry = page.getByRole('button', { name: 'Retry notes', exact: true });
  await retry.focus(); await page.keyboard.press('Enter');
  await page.waitForFunction(() => __reads.filter(read => read.name === 'listNotes').length >= 2 &&
    document.body.textContent.includes('Could not load notes:'));
  assert.equal(await retry.evaluate(node => node === document.activeElement), true);
  await page.evaluate(() => { __fail.listNotes = null; });
  await retry.focus(); await page.keyboard.press('Enter');
  await page.getByText('No notes on this job yet.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Note', exact: true }).evaluate(node => node === document.activeElement), true);
}, { config: { __fail: { listNotes: 'permission denied' } } }));
await record('Stale visit warning already has a live region and working keyboard Retry', () => visit(async ({ page }) => {
  await page.evaluate(() => { __fail.listMeasurements = 'Failed to fetch'; });
  await page.getByRole('button', { name: 'Save passport', exact: true }).click();
  const retry = page.getByRole('button', { name: 'Retry visit data', exact: true }); await retry.waitFor();
  await axLive(page, 'Could not refresh visit data');
  await page.evaluate(() => { __fail.listMeasurements = null; });
  await retry.focus(); await page.keyboard.press('Enter'); await retry.waitFor({ state: 'detached' });
  assert.notEqual(await page.evaluate(() => document.activeElement.tagName), 'BODY');
}));
await record('At 390px Tab follows header controls and gives the badge a visible focus ring', () => visit(async ({ page }) => {
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('.field-topbar__brand').evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Tab');
  // Batch 10.2 adds a real preparation entry between the brand and badge.
  assert.equal(await page.locator('.field-topbar a[href="#/load"]').evaluate(node => node === document.activeElement), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#syncBadge').evaluate(node => node === document.activeElement), true);
  const ring = await page.locator('#syncBadge').evaluate(node => {
    const s = getComputedStyle(node); return { width: s.outlineWidth, style: s.outlineStyle };
  });
  assert.ok(parseFloat(ring.width) >= 2 && ring.style !== 'none', JSON.stringify(ring));
}));
await record('Outbox modal traps Tab, dismisses with Escape and restores badge focus', () => visit(async ({ page }) => {
  await queueAction(page); await page.locator('#syncBadge').click();
  await page.getByRole('button', { name: 'Discard Save Property Passport', exact: true }).waitFor();
  for (let i = 0; i < 5; i++) await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => !!document.activeElement.closest('dialog')), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#syncBadge').evaluate(node => node === document.activeElement), true);
}));
await record('At 390px keyboard traversal reaches the visit controls with visible focus and no unnamed controls', () => visit(async ({ page, context }) => {
  assert.equal(await page.locator('[tabindex]').evaluateAll(nodes => nodes.some(node => node.tabIndex > 0)), false);
  const cdp = await context.newCDPSession(page);
  const { nodes } = await cdp.send('Accessibility.getFullAXTree'); await cdp.detach();
  const controls = nodes.filter(node => ['button', 'link', 'textbox', 'spinbutton', 'combobox', 'checkbox'].includes(node.role?.value));
  assert.ok(controls.length > 20);
  assert.deepEqual(controls.filter(node => !node.name?.value).map(node => node.role.value), []);
  const visited = new Set();
  for (let i = 0; i < controls.length * 2; i++) {
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const node = document.activeElement, style = getComputedStyle(node);
      return { tag: node.tagName, text: node.getAttribute('aria-label') || node.textContent || '',
        width: style.outlineWidth, outline: style.outlineStyle };
    });
    if (focus.tag === 'BODY') continue;
    assert.ok(parseFloat(focus.width) >= 2 && focus.outline !== 'none', JSON.stringify(focus));
    visited.add(focus.text.trim());
    if (visited.has('Save note')) break;
  }
  assert.ok(visited.has('Quantity')); assert.ok(visited.has('Customer preferences')); assert.ok(visited.has('Save note'));
}));
await record('Window and winter icon steppers already expose named buttons', () => visit(async ({ page }) => {
  const labels = await page.evaluate(async () => {
    const { createMeasurementsPanel } = await import('/admin/js/views/measurements.js');
    const roots = [];
    for (const key of ['windows', 'winter_property_care']) {
      const service = { id: key, key, name: key, unit: 'each' };
      const panel = createMeasurementsPanel({ job: { id: 'fixture', properties: {} },
        refs: { services: [service], modifiers: [], siteFactors: [], flags: [], flagMap: [], sections: [],
          pricingRules: [{ service_id: key, approval_status: 'approved' }] }, onChange: async () => {} });
      document.body.append(panel.root); roots.push(panel.root);
      panel.render({ measurements: [{ id: key, service_id: key, label: 'Area', quantity: 2,
        measurement_modifiers: [], job_measurement_addons: [] }], pricing: [] });
    }
    const labels = roots.flatMap(root => [...root.querySelectorAll('button')]
      .filter(button => ['−', '+'].includes(button.textContent)).map(button => button.getAttribute('aria-label')));
    roots.forEach(root => root.remove()); return labels;
  });
  assert.deepEqual(labels, ['Fewer', 'More', 'Fewer visits', 'More visits']);
}));
for (const theme of ['light', 'dark']) {
  await record(`${theme}: primary save text meets 4.5:1 contrast`, () => visit(async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    const ratio = await contrast(page.getByRole('button', { name: 'Save passport', exact: true }));
    assert.ok(ratio >= 4.5, `Contrast ${ratio}`);
  }));
  await record(`${theme}: error toast text meets 4.5:1 contrast`, () => visit(async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.evaluate(async () => { (await import('/shared/dom.js')).toast('Failure message', 'error'); });
    const ratio = await contrast(page.locator('#toast'));
    assert.ok(ratio >= 4.5, `Contrast ${ratio}`);
  }));
  await record(`${theme}: sync states, warning, quantity hint and error text meet 4.5:1`, () => visit(async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await queueAction(page);
    for (const state of ['ok', 'queued', 'error']) {
      await page.locator('#syncBadge').evaluate((node, state) => node.className = 'sync-badge sync-badge--' + state, state);
      assert.ok(await contrast(page.locator('#syncBadge')) >= 4.5, state);
    }
    await page.getByRole('spinbutton', { name: 'Quantity', exact: true }).fill('');
    assert.ok(await contrast(page.getByText('Not saved — enter a non-negative quantity.', { exact: true })) >= 4.5);
    await page.evaluate(() => { __fail.listNotes = 'permission denied'; });
    // The existing tokens also drive warning and failed outbox text.
    assert.ok(await contrast(page.locator('.badge--warn').first()) >= 4.5);
    await page.evaluate(async () => {
      __fail.updateProperty = 'permission denied';
      await (await import('/admin/js/lib/offline-queue.js')).flush();
    });
    await page.locator('#syncBadge').click();
    const error = page.getByText('Last sync failed: permission denied', { exact: true });
    await error.waitFor(); assert.ok(await contrast(error) >= 4.5);
  }));
}

await record('Cold bundled start with external network blocked shows an honest unavailable screen', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    await context.addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false }));
    const page = await context.newPage(); const failures = [];
    await context.route('https://**', route => route.abort('internetdisconnected'));
    page.on('requestfailed', request => failures.push(request.url()));
    await page.goto('http://localhost:8743/mobile/www/admin/field.html');
    await page.getByRole('heading', { name: 'Work unavailable offline' }).waitFor();
    assert.match(await page.locator('#view').innerText(), /No recent work is saved for this account/);
    assert.ok(!failures.some(url => url.includes('cdn.jsdelivr.net')));
    assert.equal(await page.locator('#syncBadge').getAttribute('role'), 'button');
  } finally { await context.close(); }
});
await browser.close();
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.error ? '\n  ' + r.error : ''}`);
console.log(`\n${results.filter(r => r.ok).length}/${results.length} passed`);
if (results.some(r => !r.ok)) process.exitCode = 1;
