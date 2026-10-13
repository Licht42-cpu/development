// Phase 21 -- Batch 5: Quote Builder and Quote Delivery.
//
// What these pin, and why each one exists:
//
//   * ONE customer-quote URL. Preview, Download PDF, Copy Link and the SMS
//     body must all resolve to the same address. Before Batch 5 there were
//     two, and the one the admin's own Preview/Download used
//     ("../site/quote.html") 404s in production -- deploy/Caddyfile routes
//     /admin/* and /shared/* to the repo and EVERYTHING else to
//     `root * /srv/site`, so the page is served at /quote.html and
//     /site/quote.html is not a path that exists. The absolute base comes
//     from company.website, the same setting the send-notifications Edge
//     Function uses for the link in the customer's email, so the copied
//     link and the emailed link cannot drift apart.
//
//   * The fallback still works when company.website is unset, because the
//     local dev server (tests/run-regression.sh serves the repo root) has
//     the OPPOSITE layout: there the page really is at /site/quote.html.
//
//   * Customer-facing content (customer_notes, terms) is editable on a draft
//     and read-only once sent, and is kept separate from internal_notes --
//     the one field the customer never sees. Both were already rendered by
//     site/quote.html but had no admin editor at all.
//
//   * Removing a line or an adjustment asks first and surfaces a failure,
//     instead of firing a delete and leaving the old total on screen.

import assert from 'node:assert/strict';
import pkg from '/opt/node-tools/node_modules/playwright/index.js';
import { createRecorder, BASE, FAKE_CAPACITOR_CORE } from './test-harness.mjs';

const { chromium } = pkg;
const { results, record } = createRecorder();

const FAKE_SUPABASE_ADMIN = `
  export const supabase = { auth: { signOut: async () => {} } };
  export async function getSession() { return { session: { user: { id: 'admin-1' } }, isAdmin: true }; }
`;

/** api.js stand-in. `website` is a parameter so the same module exercises
 *  both the configured-origin path and the dev-layout fallback. */
const fakeApi = (website) => `
  globalThis.__calls = [];
  const rec = (name, args) => { globalThis.__calls.push({ name, args }); };
  export async function getSettings() {
    return { company: ${website ? `{ website: '${website}' }` : '{}'} };
  }
  export async function updateQuote(id, patch) { rec('updateQuote', { id, patch }); return {}; }
  export async function deleteAdjustment(id, quoteId) { rec('deleteAdjustment', { id, quoteId }); }
  export async function deleteLine(id, quoteId) { rec('deleteLine', { id, quoteId }); }
  export async function addAdjustment() { return {}; }
  export async function sendQuote(id) { rec('sendQuote', { id }); }
  export async function sendOptionGroup(id) { rec('sendOptionGroup', { id }); }
  export async function duplicateQuote(id) { rec('duplicateQuote', { id }); return 'new-id'; }
  export async function createQuoteFromCalculation() { return 'q'; }
  export async function createOptionQuote() { return 'q'; }
  export async function signedPhotoUrl() { return 'blob:sig'; }
  export async function uploadSignature() { return 'path'; }
  export async function saveQuoteSignature() {}
  export async function listChangeOrders() { return []; }
  export async function addChangeOrder() { return {}; }
  export async function updateChangeOrder() { return {}; }
`;

const JOB = {
  id: 'job-1',
  customers: { name: 'Jane Doe', email: 'jane@example.com', phone: '+16045550123' },
  properties: { address_line1: '123 Main St', city: 'Sault Ste. Marie', postal_code: 'P6A 1A1' }
};

const DRAFT = {
  id: 'quote-draft', version: 2, kind: 'final', status: 'draft',
  total: 500, subtotal: 450, tax_total: 0, valid_until: '2026-12-01',
  customer_notes: 'We can start within a week.', terms: 'Payment due in 14 days.',
  internal_notes: 'Tech prefers the rear ladder.',
  quote_line_items: [
    { id: 'li-1', description: 'Roof Soft Washing', quantity: 10, unit: 'sqft',
      unit_rate: 40, modifier_factor: 1, addons_amount: 0, amount: 400,
      sort_order: 1, source: 'calculated', pricing_approved: true },
    { id: 'li-2', description: 'Extra trip charge', quantity: 1, unit: 'each',
      unit_rate: 50, modifier_factor: 1, addons_amount: 0, amount: 50,
      sort_order: 2, source: 'manual', pricing_approved: true }
  ],
  quote_adjustments: [
    { id: 'adj-1', kind: 'discount_flat', label: 'Repeat customer', value: 25,
      amount: -25, sort_order: 1 }
  ],
  ns_change_orders: []
};

const SENT = {
  ...DRAFT, id: 'quote-sent', version: 1, status: 'sent',
  sent_at: '2026-10-01T10:00:00Z',
  customer_notes: 'Frozen note the customer already read.',
  terms: 'Frozen terms.'
};

/** Opens the field console with api.js/supabase.js mocked. `dismissAll`
 *  declines every dialog, which is how the "user said no" cases are driven. */
async function launch({ website, dismissAll = false } = {}) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  const mock = (p, body) => page.route(p, (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body }));
  await mock('**/cdn.jsdelivr.net/npm/@capacitor/core@8.5.2/+esm', FAKE_CAPACITOR_CORE);
  await mock(`${BASE}/shared/supabase.js`, FAKE_SUPABASE_ADMIN);
  await mock(`${BASE}/admin/js/lib/api.js`, fakeApi(website));
  page.on('dialog', (d) => {
    if (!dismissAll && d.type() === 'confirm') d.accept();
    else d.dismiss();
  });
  await page.goto(`${BASE}/admin/field.html`);
  await page.waitForTimeout(150);

  /** Mounts the panel, waits for getSettings() to land, runs `body` against
   *  the live root, then unmounts. `body` is a plain function serialised by
   *  Playwright -- it receives { root, quotes, calls }. */
  const withPanel = (quotes, body) => page.evaluate(
    async ({ job, quotes, bodySrc }) => {
      globalThis.__calls = [];
      const mod = await import('/admin/js/views/quote.js');
      const panel = mod.createQuotePanel({ job, onChange: () => {} });
      document.body.appendChild(panel.root);
      panel.render({ quotes });
      // The links are built synchronously and re-pointed when getSettings()
      // resolves; this waits for that to have happened.
      await new Promise((r) => setTimeout(r, 80));
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (${bodySrc})`)();
      const out = await fn({ root: panel.root, quotes });
      panel.root.remove();
      return { out, calls: globalThis.__calls };
    },
    { job: JOB, quotes, bodySrc: body.toString() }
  );

  return { browser, page, withPanel };
}

(async () => {
  // ====================================================== A. one URL ====
  {
    const { browser, withPanel } = await launch({ website: 'https://novashieldmaintenance.com' });

    await record('every delivery path resolves to the same canonical customer-quote URL', async () => {
      const { out } = await withPanel([DRAFT], async ({ root }) => {
        const links = [...root.querySelectorAll('a')];
        const preview = links.find((a) => a.textContent === 'Preview Quote');
        const pdf = links.find((a) => a.textContent === 'Download PDF');
        const btn = (t) => [...root.querySelectorAll('button')].find((b) => b.textContent === t);

        let copied = null;
        navigator.clipboard.writeText = async (t) => { copied = t; };
        btn('Copy Link').click();
        await new Promise((r) => setTimeout(r, 60));

        let sms = null;
        navigator.clipboard.writeText = async (t) => { sms = t; };
        btn('Copy SMS Text').click();
        await new Promise((r) => setTimeout(r, 60));

        return { preview: preview.getAttribute('href'), pdf: pdf.getAttribute('href'), copied, sms };
      });

      const url = 'https://novashieldmaintenance.com/quote.html?id=quote-draft';
      assert.equal(out.preview, url, 'Preview must use the canonical URL');
      assert.equal(out.pdf, `${url}&print=1`, 'Download PDF is the same URL plus print=1');
      assert.equal(out.copied, url, 'Copy Link must copy that same URL');
      assert.ok(out.sms && out.sms.includes(url), `SMS body must carry that same URL, got: ${out.sms}`);
    });

    await record('no delivery URL contains the production-404 "site/quote.html" path', async () => {
      const { out } = await withPanel([DRAFT, SENT], async ({ root }) =>
        [...root.querySelectorAll('a')].map((a) => a.getAttribute('href') || ''));
      assert.ok(out.length > 0, 'there should be links to check');
      for (const href of out) {
        assert.ok(!href.includes('site/quote.html'), `found a 404-producing href: ${href}`);
      }
    });

    await record('the quote id is URL-encoded, not interpolated raw', async () => {
      const weird = { ...DRAFT, id: 'a b&c' };
      const { out } = await withPanel([weird], async ({ root }) => {
        const a = [...root.querySelectorAll('a')].find((x) => x.textContent === 'Preview Quote');
        return a.getAttribute('href');
      });
      assert.ok(out.includes('id=a%20b%26c'), `id should be encoded, got ${out}`);
    });

    await browser.close();
  }

  // ========================================= B. the dev-layout fallback ==
  {
    const { browser, withPanel } = await launch({ website: null });

    await record('with no configured website, the URL falls back to the dev repo-root layout', async () => {
      const { out } = await withPanel([DRAFT], async ({ root }) => {
        const a = [...root.querySelectorAll('a')].find((x) => x.textContent === 'Preview Quote');
        return a.getAttribute('href');
      });
      // The dev server roots at the repo, where the page really is under site/.
      assert.ok(out.endsWith('/site/quote.html?id=quote-draft'),
        `expected the dev-layout path, got ${out}`);
      assert.ok(out.startsWith('http://localhost:8743/'),
        `expected an absolute same-origin URL, got ${out}`);
    });

    await browser.close();
  }

  // ================================ C. customer-facing content editing ===
  {
    const { browser, withPanel } = await launch({ website: 'https://novashieldmaintenance.com' });

    await record('a draft exposes an editable customer note + terms, prefilled from the quote', async () => {
      const { out } = await withPanel([DRAFT], async ({ root }) => {
        const box = [...root.querySelectorAll('.section-box')]
          .find((b) => b.querySelector('h3') && b.querySelector('h3').textContent === 'Customer-facing content');
        return {
          areas: [...box.querySelectorAll('textarea')].map((t) => t.value),
          labels: [...box.querySelectorAll('label > span')].map((s) => s.textContent),
          hasSave: !!box.querySelector('button')
        };
      });
      assert.deepEqual(out.areas, ['We can start within a week.', 'Payment due in 14 days.']);
      assert.deepEqual(out.labels, ['Note to the customer', 'Terms']);
      assert.equal(out.hasSave, true);
    });

    await record('saving customer content writes exactly customer_notes + terms, trimmed, empty -> null', async () => {
      const { calls } = await withPanel([DRAFT], async ({ root }) => {
        const box = [...root.querySelectorAll('.section-box')]
          .find((b) => b.querySelector('h3') && b.querySelector('h3').textContent === 'Customer-facing content');
        const areas = [...box.querySelectorAll('textarea')];
        areas[0].value = '  Updated note  ';
        areas[1].value = '';
        box.querySelector('button').click();
        await new Promise((r) => setTimeout(r, 60));
        return null;
      });
      const updates = calls.filter((c) => c.name === 'updateQuote');
      assert.equal(updates.length, 1);
      assert.equal(updates[0].args.id, 'quote-draft');
      assert.deepEqual(Object.keys(updates[0].args.patch).sort(), ['customer_notes', 'terms']);
      assert.equal(updates[0].args.patch.customer_notes, 'Updated note', 'should be trimmed');
      assert.equal(updates[0].args.patch.terms, null, 'an emptied field clears to null, not ""');
    });

    await record('a SENT quote shows customer content read-only -- no textarea, no save button', async () => {
      const { out } = await withPanel([SENT], async ({ root }) => {
        const box = [...root.querySelectorAll('.section-box')]
          .find((b) => b.querySelector('h3') && b.querySelector('h3').textContent === 'Customer-facing content');
        return {
          textareas: box.querySelectorAll('textarea').length,
          buttons: box.querySelectorAll('button').length,
          showsNote: box.textContent.includes('Frozen note the customer already read.'),
          showsTerms: box.textContent.includes('Frozen terms.'),
          saysLocked: box.textContent.includes('locked')
        };
      });
      assert.equal(out.textareas, 0, 'a sent quote must not offer an editor');
      assert.equal(out.buttons, 0, 'a sent quote must not offer a save button');
      assert.equal(out.showsNote, true, 'it should still read back what the customer got');
      assert.equal(out.showsTerms, true);
      assert.equal(out.saysLocked, true, 'and say why it cannot be edited');
    });

    await record('customer-facing content and internal notes are separate boxes with opposite warnings', async () => {
      const { out } = await withPanel([DRAFT], async ({ root }) => {
        const boxes = [...root.querySelectorAll('.section-box')];
        const head = (b) => (b.querySelector('h3') || {}).textContent;
        const pub = boxes.find((b) => head(b) === 'Customer-facing content');
        const priv = boxes.find((b) => head(b) === 'Internal admin notes');
        return {
          bothPresent: !!pub && !!priv,
          same: pub === priv,
          pubSaysShown: pub.textContent.includes('Shown to the customer'),
          privSaysNever: priv.textContent.includes('never shown'),
          privValue: priv.querySelector('textarea').value
        };
      });
      assert.equal(out.bothPresent, true);
      assert.equal(out.same, false, 'they must not be the same element');
      assert.equal(out.pubSaysShown, true);
      assert.equal(out.privSaysNever, true);
      assert.equal(out.privValue, 'Tech prefers the rear ladder.',
        'internal notes keep their own value, not the customer note');
    });

    await record('saving the internal note never writes a customer-facing field', async () => {
      const { calls } = await withPanel([DRAFT], async ({ root }) => {
        const priv = [...root.querySelectorAll('.section-box')]
          .find((b) => b.querySelector('h3') && b.querySelector('h3').textContent === 'Internal admin notes');
        priv.querySelector('textarea').value = 'PRIVATE: difficult access';
        priv.querySelector('button').click();
        await new Promise((r) => setTimeout(r, 60));
        return null;
      });
      const updates = calls.filter((c) => c.name === 'updateQuote');
      assert.equal(updates.length, 1);
      assert.deepEqual(Object.keys(updates[0].args.patch), ['internal_notes']);
      assert.equal(updates[0].args.patch.customer_notes, undefined);
      assert.equal(updates[0].args.patch.terms, undefined);
    });

    // ============================================= D. safe row removal ===
    await record('removing an adjustment confirms first, then deletes exactly once', async () => {
      const { calls } = await withPanel([DRAFT], async ({ root }) => {
        const btn = [...root.querySelectorAll('button')]
          .find((b) => b.getAttribute('aria-label') === 'Remove Repeat customer');
        btn.click();
        await new Promise((r) => setTimeout(r, 60));
        return null;
      });
      const dels = calls.filter((c) => c.name === 'deleteAdjustment');
      assert.equal(dels.length, 1, 'an accepted confirm should delete exactly once');
      assert.equal(dels[0].args.id, 'adj-1');
      assert.equal(dels[0].args.quoteId, 'quote-draft');
    });

    await record('removing a manual line confirms first, then deletes', async () => {
      const { calls } = await withPanel([DRAFT], async ({ root }) => {
        const btn = [...root.querySelectorAll('button')]
          .find((b) => b.getAttribute('aria-label') === 'Remove Extra trip charge');
        btn.click();
        await new Promise((r) => setTimeout(r, 60));
        return null;
      });
      const dels = calls.filter((c) => c.name === 'deleteLine');
      assert.equal(dels.length, 1);
      assert.equal(dels[0].args.id, 'li-2');
    });

    await record('a calculated line has no remove button -- only manual lines do', async () => {
      const { out } = await withPanel([DRAFT], async ({ root }) =>
        [...root.querySelectorAll('button')]
          .map((b) => b.getAttribute('aria-label')).filter(Boolean));
      assert.ok(out.includes('Remove Extra trip charge'), 'a manual line is removable');
      assert.ok(!out.includes('Remove Roof Soft Washing'),
        'a calculated line must not be individually removable -- it comes from the pricing engine');
    });

    await record('a SENT quote offers no remove buttons at all', async () => {
      const { out } = await withPanel([SENT], async ({ root }) =>
        [...root.querySelectorAll('button')]
          .map((b) => b.getAttribute('aria-label'))
          .filter((l) => l && l.startsWith('Remove')));
      assert.deepEqual(out, [], 'nothing on a sent quote may be removed in place');
    });

    await browser.close();
  }

  // ======================================= E. dismissed confirmations ====
  {
    const { browser, withPanel } = await launch({
      website: 'https://novashieldmaintenance.com', dismissAll: true
    });

    await record('declining the confirm removes nothing and sends nothing', async () => {
      const { calls } = await withPanel([DRAFT], async ({ root }) => {
        const byLabel = (l) => [...root.querySelectorAll('button')]
          .find((b) => b.getAttribute('aria-label') === l);
        byLabel('Remove Repeat customer').click();
        byLabel('Remove Extra trip charge').click();
        const send = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Send Email');
        if (send) send.click();
        await new Promise((r) => setTimeout(r, 90));
        return null;
      });
      const names = calls.map((c) => c.name);
      assert.ok(!names.includes('deleteAdjustment'), 'a dismissed confirm must not delete the adjustment');
      assert.ok(!names.includes('deleteLine'), 'a dismissed confirm must not delete the line');
      assert.ok(!names.includes('sendQuote'), 'a dismissed confirm must not send the quote');
    });

    await browser.close();
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
})();
