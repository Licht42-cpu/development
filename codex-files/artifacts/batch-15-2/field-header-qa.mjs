// Reproducible browser-only header inspection. Run from the repository root
// after starting the local fixture server; API/auth are test doubles.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { fieldFixture } from '../../../tests/field-resilience-fixture.mjs';
const { default: pw } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await pw.chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM });
const observations = [];
for (const width of [390, 430, 1280]) {
  const { page, context } = await fieldFixture(browser, { width });
  try {
    const badge = page.getByRole('button', { name: 'No queued actions', exact: true });
    await badge.waitFor();
    await badge.focus();
    assert.ok(await badge.evaluate(node => node === document.activeElement));
    assert.equal(await page.evaluate(() => __writes.length), 0);
    assert.doesNotMatch(await page.locator('#view').innerText(), /^\s*null\s*$/m);
    const box = await badge.boundingBox();
    assert.ok(box.width >= 44 && box.height >= 44);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: new URL(`field-header-${width}.png`, import.meta.url).pathname, fullPage: true });
    observations.push({ width, status: 'PASS', localBadge: await badge.innerText(), target: box, serverWrites: 0 });
  } finally { await context.close(); }
}
await browser.close();
writeFileSync(new URL('field-header-qa.json', import.meta.url), JSON.stringify({ proof: 'Three browser-only visual/functional observations; no server sync or physical-device proof.', observations }, null, 2) + '\n');
console.log('3/3 functional header observations passed');
