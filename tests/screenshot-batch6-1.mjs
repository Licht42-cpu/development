// Visual QA for Batch 6.1: the Settings screen at 390 / 430 / desktop.
//
//   node tests/screenshot-batch6-1.mjs      (static server must be on :8743)
//
// Writes PNGs into /tmp/ns-batch6-1/ and reports any element overhanging the
// viewport -- the failure a screenshot alone hides, because the overflow sits
// off-canvas to the right. Also checks that every save control is at least
// the project's own --tap target, and that no field label is clipped.

import { mkdirSync } from 'node:fs';
import pkg from '/opt/node-tools/node_modules/playwright/index.js';
import { BASE, FAKE_CAPACITOR_CORE } from './test-harness.mjs';

const { chromium } = pkg;
const OUT = '/tmp/ns-batch6-1';
mkdirSync(OUT, { recursive: true });

const FAKE_SUPABASE_ADMIN = `
  export const supabase = { auth: { signOut: async () => {} } };
  export async function getSession() { return { session: { user: { id: 'admin-1' } }, isAdmin: true }; }
`;

/* Awkward-on-purpose content: long service names, a long terms block, a long
   service-area string, and an unpriced service so the warning renders. */
const FAKE_API = `
  export async function listPricingRules() { return ${JSON.stringify([
    { service_id: 's1', rate: 0.45, minimum: 299, approval_status: 'approved',
      services: { name: 'Roof Soft Washing', unit: 'sq_ft', category: 'cleaning' } },
    { service_id: 's2', rate: 0.3, minimum: 199, approval_status: 'approved',
      services: { name: 'Siding / Soft Wash', unit: 'sq_ft', category: 'cleaning' } },
    { service_id: 's3', rate: 5, minimum: 0, approval_status: 'approved',
      services: { name: 'Permanent Outdoor Lighting', unit: 'linear_ft', category: 'lighting' } },
    { service_id: 's4', rate: 14, minimum: 450, approval_status: 'provisional',
      services: { name: 'Heating Wire Installation', unit: 'linear_ft', category: 'winter' } },
    { service_id: 's5', rate: 55, minimum: 45, approval_status: 'provisional',
      services: { name: 'Walkway, Step & Deck Snow Removal', unit: 'each', category: 'winter' } }
  ])}; }
  export async function getSettings() { return ${JSON.stringify({
    admin: { base_url: 'https://novashieldmaintenance.com/admin' },
    company: {
      legal_name: 'Nova Shield Maintenance Services', display_name: 'Nova Shield',
      email: 'absolutely.enormous.address@averylongdomain.example.com',
      phone: '437-436-3360', website: 'https://novashieldmaintenance.com',
      city: 'Sault Ste. Marie', province: 'ON',
      service_area: 'Sault Ste. Marie, Echo Bay, Garden River, Goulais River & surrounding area'
    },
    tax: { enabled: false, rate: 0.13, label: 'HST', registration_number: null,
           note: 'Disabled until GST/HST registration is complete.' },
    quote_defaults: {
      validity_days: 30, currency: 'CAD',
      customer_note: 'Pricing is confirmed after an on-site review. This quote covers only the items listed above.',
      terms: 'Payment due on completion by e-transfer unless otherwise agreed. Scope changes are quoted separately before any additional work begins.'
    },
    lighting: { permanent_warranty_years: 6, christmas_storage_included: true,
                christmas_install_window: 'October - November' }
  })}; }
  export async function listServices() { return ${JSON.stringify([
    { id: 's1', name: 'Roof Soft Washing', quotable: true },
    { id: 's2', name: 'Siding / Soft Wash', quotable: true },
    { id: 's3', name: 'Permanent Outdoor Lighting', quotable: true },
    { id: 's4', name: 'Heating Wire Installation', quotable: true },
    { id: 's5', name: 'Walkway, Step & Deck Snow Removal', quotable: true },
    { id: 's6', name: 'Gutter Guard Installation', quotable: true }
  ])}; }
  export async function updateSetting() { return {}; }
  export async function updatePricingRule() { return {}; }
`;

const SIZES = [
  { w: 390, h: 844, tag: '390' },
  { w: 430, h: 932, tag: '430' },
  { w: 1200, h: 900, tag: 'desktop' }
];

const PROBE = () => {
  const vw = document.documentElement.clientWidth;
  const bad = [];
  for (const n of document.querySelectorAll('*')) {
    const r = n.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > vw + 1 || r.left < -1) {
      bad.push({ tag: n.tagName.toLowerCase(),
        cls: (n.className && String(n.className).slice(0, 40)) || '',
        left: Math.round(r.left), right: Math.round(r.right),
        text: (n.textContent || '').trim().slice(0, 36) });
    }
  }
  // Save controls must be comfortably tappable.
  const small = [...document.querySelectorAll('button')]
    .filter(b => b.textContent.startsWith('Save'))
    .map(b => ({ text: b.textContent, h: Math.round(b.getBoundingClientRect().height) }))
    .filter(b => b.h < 34);
  // A field caption that has collapsed to zero height is clipped.
  const clipped = [...document.querySelectorAll('label.field > span')]
    .filter(s => s.getBoundingClientRect().height < 8).length;
  return { vw, scrollW: document.documentElement.scrollWidth,
           bad: bad.slice(0, 6), small, clipped,
           saveButtons: document.querySelectorAll('button').length };
};

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const findings = [];

  for (const s of SIZES) {
    const page = await browser.newPage({ viewport: { width: s.w, height: s.h } });
    const mock = (p, body) => page.route(p, (r) =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body }));
    await mock('**/cdn.jsdelivr.net/npm/@capacitor/core@8.5.2/+esm', FAKE_CAPACITOR_CORE);
    await mock(`${BASE}/shared/supabase.js`, FAKE_SUPABASE_ADMIN);
    await mock(`${BASE}/admin/js/lib/api.js`, FAKE_API);
    await page.goto(`${BASE}/admin/field.html`);
    await page.waitForTimeout(150);

    await page.evaluate(async () => {
      const mod = await import('/admin/js/views/settings.js');
      document.body.innerHTML = '';
      document.body.style.padding = '12px';
      const mount = document.createElement('div');
      document.body.appendChild(mount);
      await mod.renderSettings({ mount });
    });
    await page.waitForTimeout(250);

    await page.screenshot({ path: `${OUT}/settings-${s.tag}.png`, fullPage: true });
    findings.push({ view: `settings @${s.tag}`, ...(await page.evaluate(PROBE)) });

    // A second shot with a validation error and a save status showing, so the
    // error/status styling is inspected rather than assumed.
    await page.evaluate(() => {
      const card = [...document.querySelectorAll('.card')]
        .find(c => c.querySelector('h2') && c.querySelector('h2').textContent === 'Tax');
      const span = [...card.querySelectorAll('label.field > span')]
        .find(s2 => s2.textContent === 'Rate (fraction)');
      span.parentElement.querySelector('input').value = '13';
      [...card.querySelectorAll('button')].find(b => b.textContent.startsWith('Save')).click();
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/settings-error-${s.tag}.png`, fullPage: true });
    findings.push({ view: `settings+error @${s.tag}`, ...(await page.evaluate(PROBE)) });

    // Per-card clips. The full-page shot at phone width is several thousand
    // pixels tall, so it scales down too far to actually read -- these are
    // what makes the error text and the approval badges inspectable.
    for (const title of ['Winter rates', 'Tax']) {
      for (const card of await page.$$('.card')) {
        const heading = await card.$eval('h2', (n) => n.textContent).catch(() => null);
        if (heading !== title) continue;
        await card.screenshot({
          path: `${OUT}/card-${title.toLowerCase().replace(/\s+/g, '-')}-${s.tag}.png`
        });
      }
    }

    await page.close();
  }

  await browser.close();

  console.log(`\nPNGs in ${OUT}\n`);
  let problems = 0;
  for (const f of findings) {
    const overflow = f.scrollW > f.vw + 1 || f.bad.length > 0;
    const issues = [];
    if (overflow) issues.push('overflow');
    if (f.small.length) issues.push(`${f.small.length} save control(s) under 34px`);
    if (f.clipped) issues.push(`${f.clipped} clipped label(s)`);
    if (issues.length) problems++;
    console.log(`${issues.length ? 'BAD ' : 'OK  '} ${f.view}: viewport ${f.vw}, document ${f.scrollW}` +
      (issues.length ? ` — ${issues.join('; ')}` : ''));
    for (const b of f.bad) console.log(`       ${b.tag}.${b.cls} [${b.left}..${b.right}] "${b.text}"`);
    for (const b of f.small) console.log(`       "${b.text}" height ${b.h}px`);
  }
  console.log(problems ? `\n${problems} view(s) need attention` : '\nNo layout problems in any view');
})();
