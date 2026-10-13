// Visual QA for Batch 5: the customer-facing quote document (screen AND
// print) and the admin quote panel's new customer-facing content box, at
// 390 / 430 / 1200.
//
//   node tests/screenshot-batch5.mjs      (static server must be on :8743)
//
// Writes PNGs into /tmp/ns-batch5/ and reports any element overhanging its
// viewport -- the failure a screenshot alone hides, because the overflow sits
// off-canvas to the right.

import { mkdirSync } from 'node:fs';
import pkg from '/opt/node-tools/node_modules/playwright/index.js';
import { BASE, FAKE_CAPACITOR_CORE } from './test-harness.mjs';

const { chromium } = pkg;
const OUT = '/tmp/ns-batch5';
mkdirSync(OUT, { recursive: true });

/* Deliberately awkward content: a long service label that must wrap, a long
   free-text note and terms block, an unapproved line, a credit adjustment,
   an approved change order, and a 56-character email in the company block. */
const QUOTE_DOC = {
  reference: 'NS-1006',
  version: 3,
  status: 'sent',
  issued_on: '2026-10-01T10:00:00Z',
  valid_until: '2026-11-01',
  currency: 'CAD',
  customer_name: 'Konstantinos Papadopoulos-Whitfield',
  property: '1487 Northwest Kelowna Mountainview Crescent, Sault Ste. Marie, P6A 1A1',
  customer_notes:
    'We can usually start within a week of approval. Access to the rear elevation ' +
    'is through the side gate; please leave it unlocked on the morning of the visit, ' +
    'and move any vehicles off the driveway so the ladder can be footed safely.',
  terms:
    'Payment is due within 14 days of completion. This quote is valid for 30 days ' +
    'from the issue date. Prices assume reasonable access to a working outdoor water ' +
    'tap and a standard electrical receptacle.',
  subtotal: 2480,
  tax_total: 0,
  total: 2305,
  company: {
    name: 'Nova Shield Maintenance Services',
    email: 'absolutely.enormous.address@averylongdomain.example.com',
    phone: '705-555-0100',
    website: 'https://novashieldmaintenance.com'
  },
  signature_path: null,
  signed_by_name: null,
  signed_at: null,
  option_group: null,
  lines: [
    { description: 'Permanent Outdoor Lighting', amount: 1800, pricing_approved: true },
    { description: 'Roof Soft Washing — North and West Elevations, Two Storey',
      amount: 520, pricing_approved: true },
    { description: 'Moss Removal (Valleys and Corners)', amount: 160, pricing_approved: false }
  ],
  adjustments: [
    { label: 'Repeat customer discount', amount: -175 }
  ],
  change_orders: [
    { description: 'Additional downspout cleared at the rear', amount: 45,
      created_at: '2026-10-03T10:00:00Z' }
  ]
};

/* The option-group view is the other branch of the same page/template. */
const GROUP_DOC = {
  ...QUOTE_DOC,
  option_group: {
    group_id: 'g-1',
    options: [
      { id: 'o1', option_label: 'Essential', option_sort_order: 1, total: 980,
        status: 'sent', pricing_approved: true },
      { id: 'o2', option_label: 'Complete', option_sort_order: 2, total: 2305,
        status: 'sent', pricing_approved: true },
      { id: 'o3', option_label: 'Full Home Including Permanent Lighting',
        option_sort_order: 3, total: 4120, status: 'sent', pricing_approved: false }
    ]
  }
};

const fakeSiteSupabase = (doc) => `
  export const supabase = {
    rpc: async (fn) => (fn === 'get_customer_quote'
      ? { data: ${JSON.stringify(doc)}, error: null }
      : { data: null, error: null }),
    storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: '' } }) }) }
  };
`;

const FAKE_SUPABASE_ADMIN = `
  export const supabase = { auth: { signOut: async () => {} } };
  export async function getSession() { return { session: { user: { id: 'admin-1' } }, isAdmin: true }; }
`;

const FAKE_ADMIN_API = `
  export async function getSettings() { return { company: { website: 'https://novashieldmaintenance.com' } }; }
  export async function updateQuote() { return {}; }
  export async function deleteAdjustment() {}
  export async function deleteLine() {}
  export async function addAdjustment() { return {}; }
  export async function sendQuote() {}
  export async function sendOptionGroup() {}
  export async function duplicateQuote() { return 'x'; }
  export async function createQuoteFromCalculation() { return 'q'; }
  export async function createOptionQuote() { return 'q'; }
  export async function signedPhotoUrl() { return ''; }
  export async function uploadSignature() { return 'p'; }
  export async function saveQuoteSignature() {}
  export async function listChangeOrders() { return []; }
  export async function addChangeOrder() { return {}; }
  export async function updateChangeOrder() { return {}; }
`;

const ADMIN_JOB = {
  id: 'job-1',
  customers: { name: 'Konstantinos Papadopoulos-Whitfield',
               email: 'absolutely.enormous.address@averylongdomain.example.com',
               phone: '+17055550100' },
  properties: { address_line1: '1487 Northwest Kelowna Mountainview Crescent',
                city: 'Sault Ste. Marie', postal_code: 'P6A 1A1' }
};

const ADMIN_DRAFT = {
  id: 'quote-draft', version: 3, kind: 'final', status: 'draft',
  total: 2305, subtotal: 2480, tax_total: 0, valid_until: '2026-11-01',
  customer_notes: QUOTE_DOC.customer_notes, terms: QUOTE_DOC.terms,
  internal_notes: 'Tech prefers the rear ladder. Dog on site — friendly but loud.',
  quote_line_items: [
    { id: 'li-1', description: 'Permanent Lighting — Jump Wire', quantity: 60, unit: 'ft',
      unit_rate: 30, modifier_factor: 1, addons_amount: 0, amount: 1800,
      sort_order: 1, source: 'calculated', pricing_approved: true },
    { id: 'li-2', description: 'Moss Removal (Valleys and Corners)', quantity: 8, unit: 'each',
      unit_rate: 20, modifier_factor: 1, addons_amount: 0, amount: 160,
      sort_order: 2, source: 'calculated', pricing_approved: false },
    { id: 'li-3', description: 'Extra trip charge', quantity: 1, unit: 'each',
      unit_rate: 50, modifier_factor: 1, addons_amount: 0, amount: 50,
      sort_order: 3, source: 'manual', pricing_approved: true }
  ],
  quote_adjustments: [
    { id: 'adj-1', kind: 'discount_flat', label: 'Repeat customer discount',
      value: 175, amount: -175, sort_order: 1 }
  ],
  ns_change_orders: []
};

const ADMIN_SENT = { ...ADMIN_DRAFT, id: 'quote-sent', status: 'sent',
                     sent_at: '2026-10-01T10:00:00Z', version: 2 };

const SIZES = [
  { w: 390, h: 844, tag: '390' },   // iPhone 14/15 logical width
  { w: 430, h: 932, tag: '430' },   // iPhone Pro Max logical width
  { w: 1200, h: 900, tag: 'desktop' }
];

/** Reports elements wider than the viewport, and the document's own width. */
const OVERFLOW_PROBE = () => {
  const vw = document.documentElement.clientWidth;
  const bad = [];
  for (const n of document.querySelectorAll('*')) {
    const r = n.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > vw + 1 || r.left < -1) {
      bad.push({
        tag: n.tagName.toLowerCase(),
        cls: (n.className && String(n.className).slice(0, 44)) || '',
        left: Math.round(r.left), right: Math.round(r.right),
        text: (n.textContent || '').trim().slice(0, 40)
      });
    }
  }
  return { vw, scrollW: document.documentElement.scrollWidth, bad: bad.slice(0, 8) };
};

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const findings = [];

  // ---------------------------------------- 1. the customer document ----
  for (const [name, doc] of [['customer-quote', QUOTE_DOC], ['customer-options', GROUP_DOC]]) {
    for (const s of SIZES) {
      const page = await browser.newPage({ viewport: { width: s.w, height: s.h } });
      await page.route(`${BASE}/shared/supabase.js`, (r) =>
        r.fulfill({ status: 200, contentType: 'application/javascript', body: fakeSiteSupabase(doc) }));
      await page.goto(`${BASE}/site/quote.html?id=00000000-0000-4000-8000-000000000001`);
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${OUT}/${name}-${s.tag}.png`, fullPage: true });
      const probe = await page.evaluate(OVERFLOW_PROBE);
      findings.push({ view: `${name} @${s.tag}`, ...probe });
      await page.close();
    }

    // Print layout: same document, print media emulated, so the @media print
    // rules in site/quote.html are the ones being inspected.
    const pp = await browser.newPage({ viewport: { width: 794, height: 1123 } }); // ~A4 @96dpi
    await pp.route(`${BASE}/shared/supabase.js`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body: fakeSiteSupabase(doc) }));
    await pp.goto(`${BASE}/site/quote.html?id=00000000-0000-4000-8000-000000000001`);
    await pp.waitForTimeout(400);
    await pp.emulateMedia({ media: 'print' });
    await pp.waitForTimeout(150);
    await pp.screenshot({ path: `${OUT}/${name}-print.png`, fullPage: true });
    const probe = await pp.evaluate(OVERFLOW_PROBE);
    findings.push({ view: `${name} @print`, ...probe });
    // The print rules must actually strip the interactive controls.
    const leftOver = await pp.evaluate(() =>
      [...document.querySelectorAll('.actions, .no-print')]
        .filter((n) => getComputedStyle(n).display !== 'none').length);
    findings.push({ view: `${name} @print: visible .actions/.no-print`, vw: leftOver, scrollW: 0, bad: [] });
    await pp.close();
  }

  // -------------------------------------------- 2. the admin panel ------
  for (const [name, quotes] of [['admin-draft', [ADMIN_DRAFT]], ['admin-sent', [ADMIN_SENT]]]) {
    for (const s of SIZES) {
      const page = await browser.newPage({ viewport: { width: s.w, height: s.h } });
      const mock = (p, body) => page.route(p, (r) =>
        r.fulfill({ status: 200, contentType: 'application/javascript', body }));
      await mock('**/cdn.jsdelivr.net/npm/@capacitor/core@8.5.2/+esm', FAKE_CAPACITOR_CORE);
      await mock(`${BASE}/shared/supabase.js`, FAKE_SUPABASE_ADMIN);
      await mock(`${BASE}/admin/js/lib/api.js`, FAKE_ADMIN_API);
      await page.goto(`${BASE}/admin/field.html`);
      await page.waitForTimeout(150);
      await page.evaluate(async ({ job, quotes }) => {
        const mod = await import('/admin/js/views/quote.js');
        const panel = mod.createQuotePanel({ job, onChange: () => {} });
        document.body.innerHTML = '';
        document.body.style.padding = '12px';
        document.body.appendChild(panel.root);
        panel.render({ quotes });
        await new Promise((r) => setTimeout(r, 120));
      }, { job: ADMIN_JOB, quotes });
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${OUT}/${name}-${s.tag}.png`, fullPage: true });
      const probe = await page.evaluate(OVERFLOW_PROBE);
      findings.push({ view: `${name} @${s.tag}`, ...probe });
      await page.close();
    }
  }

  await browser.close();

  console.log(`\nPNGs in ${OUT}\n`);
  let problems = 0;
  for (const f of findings) {
    if (f.view.includes('visible .actions')) {
      const ok = f.vw === 0;
      if (!ok) problems++;
      console.log(`${ok ? 'OK  ' : 'BAD '} ${f.view}: ${f.vw}`);
      continue;
    }
    const overflows = f.scrollW > f.vw + 1 || f.bad.length > 0;
    if (overflows) problems++;
    console.log(`${overflows ? 'BAD ' : 'OK  '} ${f.view}: viewport ${f.vw}, document ${f.scrollW}`);
    for (const b of f.bad) {
      console.log(`       ${b.tag}.${b.cls} [${b.left}..${b.right}] "${b.text}"`);
    }
  }
  console.log(problems ? `\n${problems} view(s) need attention` : '\nNo overflow in any view');
})();
