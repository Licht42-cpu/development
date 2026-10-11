import assert from 'node:assert/strict';
import { createRecorder, finishAndReport } from './test-harness.mjs';
import { fieldFixture, queueAction, JOB_A, JOB_B } from './field-resilience-fixture.mjs';

const { default: pkg } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node-tools/node_modules/playwright/index.js');
const browser = await pkg.chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM || '/opt/pw-browsers/chromium' });
console.log('Browser:', browser.version());
const { record, results } = createRecorder();

await record('An access-check failure offers Retry rather than leaving a loading screen', async () => {
  const { context, page } = await fieldFixture(browser, { config: { __fail: { session: 'Failed to fetch' } } });
  try {
    await page.waitForTimeout(150);
    assert.equal(await page.getByRole('button', { name: 'Retry', exact: true }).count(), 1);
    await page.evaluate(() => { __fail.session = null; });
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await page.getByRole('heading', { name: "Today's schedule" }).waitFor();
  } finally { await context.close(); }
});

await record('A late visit load cannot replace the newer route', async () => {
  const { context, page } = await fieldFixture(browser, {
    hash: '#/visit/' + JOB_A, config: { __defer: { getJob: true } }
  });
  try {
    await page.waitForFunction(() => __waiting.some(request => request.name === 'getJob'));
    await page.evaluate(id => { __defer.getJob = false; location.hash = '/visit/' + id; }, JOB_B);
    await page.getByRole('heading', { name: 'Second Visit', exact: true }).waitFor();
    await page.evaluate(() => __waiting.forEach(request => request.resolve()));
    await page.waitForTimeout(150);
    assert.equal(await page.getByRole('heading', { name: 'Second Visit', exact: true }).count(), 1);
    assert.equal(await page.getByRole('heading', { name: 'First Visit', exact: true }).count(), 0);
  } finally { await context.close(); }
});

await record('An initial failed visit-data read reports the connection error, not fabricated empty data', async () => {
  const { context, page } = await fieldFixture(browser, {
    hash: '#/visit/' + JOB_A, config: { __fail: { listMeasurements: 'Failed to fetch' } }
  });
  try {
    await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    const text = await page.locator('#view').innerText();
    assert.match(text, /connection|Failed to fetch/i);
    assert.doesNotMatch(text, /not iterable|No services on this job yet/);
  } finally { await context.close(); }
});

await record('An offline refresh labels the retained visit data and offers retry', async () => {
  const { context, page } = await fieldFixture(browser, { hash: '#/visit/' + JOB_A });
  try {
    await page.getByRole('spinbutton', { name: 'Quantity', exact: true }).waitFor();
    await page.evaluate(() => { __fail.listMeasurements = 'Failed to fetch'; });
    await page.getByRole('button', { name: 'Save passport', exact: true }).click();
    await page.waitForTimeout(150);
    assert.equal(await page.getByRole('button', { name: 'Retry visit data', exact: true }).count(), 1);
    assert.match(await page.locator('#view').innerText(), /last loaded|out of date/i);
    assert.equal(await page.getByRole('spinbutton', { name: 'Quantity', exact: true }).inputValue(), '7');
    await page.evaluate(() => { __fail.listMeasurements = null; });
    await page.getByRole('button', { name: 'Retry visit data', exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(await page.getByRole('button', { name: 'Retry visit data', exact: true }).count(), 0);
  } finally { await context.close(); }
});

await record('Passport save announces progress and prevents double submission', async () => {
  const { context, page } = await fieldFixture(browser, { hash: '#/visit/' + JOB_A });
  try {
    await page.getByRole('spinbutton', { name: 'Quantity', exact: true }).waitFor();
    await page.evaluate(() => { __defer.updateProperty = true; });
    await page.getByRole('button', { name: 'Save passport', exact: true }).click();
    await page.waitForFunction(() => __writes.length === 1);
    const button = page.getByRole('button', { name: 'Saving passport…', exact: true });
    assert.equal(await button.count(), 1);
    assert.equal(await button.isDisabled(), true);
    await page.evaluate(() => __writes[0].finish());
    await page.getByRole('button', { name: 'Save passport', exact: true }).waitFor();
  } finally { await context.close(); }
});

await record('A slow passport save preserves the next unsaved edit', async () => {
  const { context, page } = await fieldFixture(browser, { hash: '#/visit/' + JOB_A });
  try {
    await page.getByRole('spinbutton', { name: 'Quantity', exact: true }).waitFor();
    await page.evaluate(() => { __defer.updateProperty = true; });
    await page.getByLabel('Material', { exact: true }).fill('Saved material');
    await page.getByRole('button', { name: 'Save passport', exact: true }).click();
    await page.waitForFunction(() => __writes.length === 1);
    await page.getByLabel('Material', { exact: true }).fill('Next unsaved material');
    await page.evaluate(() => __writes[0].finish());
    await page.waitForTimeout(150);
    assert.equal(await page.getByLabel('Material', { exact: true }).inputValue(), 'Next unsaved material');
  } finally { await context.close(); }
});

await record('An untouched passport still receives fresh backend values after an unrelated refresh', async () => {
  const { context, page } = await fieldFixture(browser, { hash: '#/visit/' + JOB_A });
  try {
    await page.getByRole('spinbutton', { name: 'Quantity', exact: true }).waitFor();
    await page.evaluate(() => { __passportOverride = { siding: { material: 'Updated backend material' } }; });
    await page.getByRole('spinbutton', { name: 'Quantity', exact: true }).fill('8');
    await page.waitForFunction(() => document.querySelector('input[placeholder="Vinyl, wood, brick…"]').value === 'Updated backend material');
  } finally { await context.close(); }
});

await record('A passport draft survives an unrelated refresh and preserves newer unknown backend fields', async () => {
  const { context, page } = await fieldFixture(browser, { hash: '#/visit/' + JOB_A });
  try {
    await page.getByRole('spinbutton', { name: 'Quantity', exact: true }).waitFor();
    await page.getByLabel('Material', { exact: true }).fill('My draft material');
    await page.evaluate(() => { __passportOverride = { siding: { material: 'Backend material', other_fact: 'Keep this backend fact' } }; });
    await page.getByRole('spinbutton', { name: 'Quantity', exact: true }).fill('8');
    await page.waitForFunction(() => __reads.filter(read => read.name === 'getJob').length >= 3);
    await page.waitForTimeout(100);
    assert.equal(await page.getByLabel('Material', { exact: true }).inputValue(), 'My draft material');
    await page.getByRole('button', { name: 'Save passport', exact: true }).click();
    await page.waitForFunction(() => __writes.some(write => write.name === 'updateProperty'));
    const passport = await page.evaluate(() => __writes.find(write => write.name === 'updateProperty').args[1].passport);
    assert.equal(passport.siding.material, 'My draft material');
    assert.equal(passport.siding.other_fact, 'Keep this backend fact');
  } finally { await context.close(); }
});

await record('A permission-denied refresh does not misreport a successful passport write or throw unhandled', async () => {
  const { context, page, errors } = await fieldFixture(browser, { hash: '#/visit/' + JOB_A });
  try {
    await page.getByRole('spinbutton', { name: 'Quantity', exact: true }).waitFor();
    await page.evaluate(() => { __fail.listQuotes = 'Permission denied'; });
    await page.getByRole('button', { name: 'Save passport', exact: true }).click();
    await page.waitForTimeout(150);
    assert.equal(await page.getByRole('button', { name: 'Retry visit data', exact: true }).count(), 1);
    assert.match(await page.locator('#view').innerText(), /Permission denied/);
    assert.match(await page.locator('#toast').innerText(), /Could not refresh visit data/);
    assert.doesNotMatch(await page.locator('#toast').innerText(), /change was not saved/);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

await record('Retrying notes does not rebuild the visit or lose an unsaved note', async () => {
  const { context, page } = await fieldFixture(browser, {
    hash: '#/visit/' + JOB_A, config: { __fail: { listNotes: 'Failed to fetch' } }
  });
  try {
    await page.getByRole('spinbutton', { name: 'Quantity', exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Note', exact: true }).fill('Keep this unsaved note');
    const retry = page.getByRole('button', { name: 'Retry notes', exact: true });
    assert.equal(await retry.count(), 1);
    await page.evaluate(() => { __fail.listNotes = null; __notes = [{ body: 'Existing note', visibility: 'internal' }]; });
    await retry.click();
    await page.getByText('Existing note', { exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Note', exact: true }).inputValue(), 'Keep this unsaved note');
  } finally { await context.close(); }
});

await record('A slow note save keeps text typed after the submitted note', async () => {
  const { context, page } = await fieldFixture(browser, { hash: '#/visit/' + JOB_A });
  try {
    await page.getByRole('spinbutton', { name: 'Quantity', exact: true }).waitFor();
    await page.evaluate(() => { __defer.addNote = true; });
    await page.getByRole('textbox', { name: 'Note', exact: true }).fill('Submitted note');
    await page.getByRole('button', { name: 'Save note', exact: true }).click();
    await page.waitForFunction(() => __writes.length === 1);
    await page.getByRole('textbox', { name: 'Note', exact: true }).fill('Next unsaved note');
    await page.evaluate(() => __writes[0].finish());
    await page.waitForTimeout(150);
    assert.equal(await page.getByRole('textbox', { name: 'Note', exact: true }).inputValue(), 'Next unsaved note');
  } finally { await context.close(); }
});

await record('Outbox failures retain the failed item and reason across a page reload', async () => {
  const { context, page } = await fieldFixture(browser);
  try {
    const id = await queueAction(page);
    await page.evaluate(async () => {
      __fail.updateProperty = 'Permission denied';
      await (await import('/admin/js/lib/offline-queue.js')).flush();
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    });
    await page.reload();
    await page.getByRole('heading', { name: 'Work unavailable offline' }).waitFor();
    assert.match(await page.locator('#view').innerText(), /No recent work is saved for this account/);
    const item = await page.evaluate(async id => (await (await import('/admin/js/lib/offline-queue.js')).pending()).find(item => item.id === id), id);
    assert.match(item?.lastError || '', /Permission denied/);
    assert.equal(await page.evaluate(() => __writes.length), 0, 'offline reload must not replay');
  } finally { await context.close(); }
});

await record('The outbox shows individual items and requires confirmation to discard one', async () => {
  const { context, page } = await fieldFixture(browser);
  try {
    await queueAction(page, 'First queued update');
    await queueAction(page, 'Second queued update');
    await page.locator('#syncBadge').click();
    const dialog = page.getByRole('dialog', { name: 'Saved on this device' });
    assert.equal(await dialog.count(), 1);
    await dialog.getByText('First queued update', { exact: true }).waitFor();
    assert.match(await dialog.innerText(), /First queued update/);
    assert.match(await dialog.innerText(), /Second queued update/);
    page.once('dialog', prompt => prompt.dismiss());
    await dialog.getByRole('button', { name: 'Discard First queued update', exact: true }).click();
    assert.equal(await page.evaluate(async () => (await import('/admin/js/lib/offline-queue.js')).count()), 2);
    page.once('dialog', prompt => prompt.accept());
    await dialog.getByRole('button', { name: 'Discard First queued update', exact: true }).click();
    await page.waitForFunction(async () => (await (await import('/admin/js/lib/offline-queue.js')).count()) === 1);
    assert.equal(await page.evaluate(() => __writes.length), 0);
  } finally { await context.close(); }
});

await record('A discard cannot race with a replay that already owns the item', async () => {
  const { context, page } = await fieldFixture(browser);
  try {
    const id = await queueAction(page);
    await page.evaluate(async () => { __fail.updateProperty = null; __defer.updateProperty = true; __writes = [];
      __flush = (await import('/admin/js/lib/offline-queue.js')).flush(); });
    await page.waitForFunction(() => __writes.length === 1);
    const message = await page.evaluate(async id => {
      try { await (await import('/admin/js/lib/offline-queue.js')).discard(id); return null; }
      catch (error) { return error.message; }
    }, id);
    assert.match(message || '', /sync|replay/i);
    assert.doesNotMatch(message || '', /not a function/);
    assert.equal(await page.evaluate(async () => (await import('/admin/js/lib/offline-queue.js')).count()), 1);
    await page.evaluate(async () => { __writes[0].finish(); await __flush; });
  } finally { await context.close(); }
});

await record('Retry sync replays in order and removes actions only after success', async () => {
  const { context, page } = await fieldFixture(browser);
  try {
    await queueAction(page, 'First update');
    await queueAction(page, 'Second update');
    await page.evaluate(async () => {
      __fail.updateProperty = 'Permission denied';
      await (await import('/admin/js/lib/offline-queue.js')).flush();
      __fail.updateProperty = null; __writes = [];
    });
    assert.deepEqual(await page.evaluate(async () => (await (await import('/admin/js/lib/offline-queue.js')).pending()).map(item => item.label)), ['First update', 'Second update']);
    await page.locator('#syncBadge').click();
    const dialog = page.getByRole('dialog', { name: 'Saved on this device' });
    assert.equal(await dialog.count(), 1);
    await dialog.getByText('First update', { exact: true }).waitFor();
    assert.match(await dialog.innerText(), /Permission denied/);
    await dialog.getByRole('button', { name: 'Retry sync', exact: true }).click();
    await page.waitForFunction(() => __fixtureQueue.syncState().count === 0 && !__fixtureQueue.syncState().syncing);
    assert.equal(await page.evaluate(async () => (await import('/admin/js/lib/offline-queue.js')).count()), 0);
    const writes = await page.evaluate(() => __writes.map(call => call.args[1].passport.preferences));
    assert.deepEqual(writes, ['First update', 'Second update']);
    await dialog.getByText('Nothing waiting to sync.', { exact: true }).waitFor();
  } finally { await context.close(); }
});

await record('Replay waits for a discard that started first', async () => {
  const { context, page } = await fieldFixture(browser);
  try {
    const id = await queueAction(page, 'Discarded update');
    await queueAction(page, 'Retained update');
    await page.evaluate(async id => {
      __fail.updateProperty = null; __writes = [];
      const queue = await import('/admin/js/lib/offline-queue.js');
      const discarding = queue.discard(id);
      const syncing = queue.flush();
      await Promise.all([discarding, syncing]);
    }, id);
    assert.deepEqual(await page.evaluate(() => __writes.map(call => call.args[1].passport.preferences)), ['Retained update']);
    assert.equal(await page.evaluate(async () => (await import('/admin/js/lib/offline-queue.js')).count()), 0);
  } finally { await context.close(); }
});

await record('Offline Sync Now leaves all queued items intact without issuing writes', async () => {
  const { context, page } = await fieldFixture(browser);
  try {
    await queueAction(page);
    const result = await page.evaluate(async () => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
      return (await import('/admin/js/lib/offline-queue.js')).flush();
    });
    assert.equal(await page.evaluate(() => __writes.length), 0);
    assert.equal(result.remaining, 1);
    assert.deepEqual(result.flushed, []);
  } finally { await context.close(); }
});

await record('Quantity updates remain outside the four-type outbox', async () => {
  const { context, page } = await fieldFixture(browser);
  try {
    const result = await page.evaluate(async () => {
      const queue = await import('/admin/js/lib/offline-queue.js');
      try { await queue.callOrQueue('updateMeasurement', {}, 'Quantity'); }
      catch (error) { return { error: error.message, count: await queue.count() }; }
    });
    assert.match(result.error, /Unknown offline action type/);
    assert.equal(result.count, 0);
  } finally { await context.close(); }
});

await record('The schedule retains distinct successful-empty and failed-load states', async () => {
  const { context, page } = await fieldFixture(browser);
  try {
    await page.getByText('Nothing booked for today', { exact: true }).waitFor();
    await page.evaluate(() => { __fail.listTodaysVisits = 'Failed to fetch'; });
    await page.locator('.field-topbar__brand').click();
    // Clicking the same hash does not refresh; navigate away/back through the router.
    await page.evaluate(id => { location.hash = '/visit/' + id; }, JOB_A);
    await page.getByRole('heading', { name: 'First Visit', exact: true }).waitFor();
    await page.locator('.field-topbar__brand').click();
    await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
    assert.equal(await page.getByText('Nothing booked for today', { exact: true }).count(), 0);
  } finally { await context.close(); }
});

await record('An outbox dialog can close with Escape without navigating away', async () => {
  const { context, page } = await fieldFixture(browser);
  try {
    await queueAction(page);
    await page.locator('#syncBadge').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.getByRole('dialog', { name: 'Saved on this device' }).count(), 1);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog', { name: 'Saved on this device' }).count(), 0);
    assert.equal(await page.evaluate(() => location.hash), '#/');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'syncBadge');
  } finally { await context.close(); }
});

await record('IndexedDB failure restores Sync Now and does not claim Synced', async () => {
  const { context, page } = await fieldFixture(browser);
  try {
    await queueAction(page);
    await page.evaluate(() => { indexedDB.open = () => { throw new Error('Device storage unavailable'); }; });
    await page.locator('#syncNow').click();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('#syncNow').isDisabled(), false);
    assert.match(await page.locator('#syncBadge').innerText(), /failed|unavailable/i);
    assert.doesNotMatch(await page.locator('#syncBadge').innerText(), /^Synced$/);
  } finally { await context.close(); }
});

await record('Unavailable storage on startup is visible without an unhandled rejection', async () => {
  const { context, page, errors } = await fieldFixture(browser, { config: { __storageBlocked: true } });
  try {
    await page.getByRole('heading', { name: 'Could not start Nova Shield' }).waitFor();
    assert.match(await page.locator('#view').innerText(), /Local storage could not be opened/);
    await page.getByRole('button', { name: 'Retry startup' }).waitFor();
    assert.match(await page.locator('#syncBadge').innerText(), /unavailable/i);
    assert.equal(await page.locator('#syncNow').isDisabled(), true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

for (const width of [390, 430]) {
  await record(`${width}px: long field customer/service labels fit with 150 measurements`, async () => {
    const long = 'UnbrokenName'.repeat(20);
    const { context, page } = await fieldFixture(browser, { width, hash: '#/visit/' + JOB_A,
      config: { __serviceName: long, __customerName: long, __measurementCount: 150 } });
    try {
      await page.waitForFunction(() => document.querySelectorAll('input[aria-label="Quantity"]').length === 150);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    } finally { await context.close(); }
  });
}

await record('A 500-visit schedule retains the last visit action without overflow', async () => {
  const { context, page } = await fieldFixture(browser, { config: { __visitCount: 500 } });
  try {
    await page.waitForFunction(() => document.querySelectorAll('button').length >= 500);
    assert.equal(await page.getByRole('button', { name: 'Start Site Visit', exact: true }).count(), 500);
    console.log('500-visit mock render (ms):', Math.round(await page.evaluate(() => performance.now() - __started)));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole('button', { name: 'Start Site Visit', exact: true }).last().click();
    await page.getByRole('heading', { name: 'First Visit', exact: true }).waitFor();
    assert.match(await page.evaluate(() => location.hash), /000000000499$/);
  } finally { await context.close(); }
});

await record('Editing the last of 150 measurements keeps the draft and all controls mounted', async () => {
  const { context, page } = await fieldFixture(browser, { hash: '#/visit/' + JOB_A,
    config: { __measurementCount: 150, __defer: { updateMeasurement: true } } });
  try {
    await page.waitForFunction(() => document.querySelectorAll('input[aria-label="Quantity"]').length === 150);
    console.log('150-measurement mock render (ms):', Math.round(await page.evaluate(() => performance.now() - __started)));
    const input = page.getByRole('spinbutton', { name: 'Quantity', exact: true }).last();
    await input.fill('42');
    await page.waitForFunction(() => __writes.length === 1);
    assert.equal(await input.inputValue(), '42');
    assert.equal(await input.evaluate(node => document.activeElement === node), true);
    assert.equal(await page.getByRole('spinbutton', { name: 'Quantity', exact: true }).count(), 150);
    assert.equal(await page.getByRole('spinbutton', { name: 'Quantity', exact: true }).first().inputValue(), '7');
    assert.equal(await page.evaluate(() => __writes[0].args[0]), 'measurement-149');
  } finally { await context.close(); }
});

await record('Primary-button progress text remains readable while hovered after a tap', async () => {
  const { context, page } = await fieldFixture(browser, { hash: '#/visit/' + JOB_A });
  try {
    await page.getByRole('spinbutton', { name: 'Quantity', exact: true }).waitFor();
    const button = page.getByRole('button', { name: 'Save passport', exact: true });
    await button.hover();
    const ratio = await button.evaluate(node => {
      const style = getComputedStyle(node);
      const luminance = color => {
        const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
          const channel = value / 255;
          return channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4;
        });
        return .2126 * r + .7152 * g + .0722 * b;
      };
      const text = luminance(style.color), background = luminance(style.backgroundColor);
      return (Math.max(text, background) + .05) / (Math.min(text, background) + .05);
    });
    assert.ok(ratio >= 4.5, `primary text contrast is ${ratio.toFixed(2)}:1`);
  } finally { await context.close(); }
});

await finishAndReport(browser, results);
