// Phase 22 -- Batch 6.1: Settings & Pricing Administration.
//
// Run directly:   node tests/phase22.test.mjs      (static server on :8743)
//
// These are MOCKED BROWSER TESTS. api.js is replaced with a stub, so they
// prove the Settings UI's own logic -- validation, merge-on-save, save
// sequencing, failure recovery -- and nothing about the live database.
//
// What they pin, and why:
//
//   * EVERY pricing category renders. The previous version hardcoded
//     'cleaning' and 'lighting', so the two 'winter' rules (Heating Wire
//     Installation, Walkway/Step/Deck Snow Removal -- both provisional in the
//     real database) could not be edited here at all. Setting winter rates
//     before the snow is the task START_HERE sends the owner to this screen
//     to perform, and the screen could not do it.
//
//   * Keys the editors do not expose survive a save. updateSetting() replaces
//     the whole stored JSON document, so a structured editor that writes only
//     its own fields would silently drop the rest -- tax.note and
//     tax.registration_number are real values in the database today.
//
//   * Changing a rate never implicitly approves it. approval_status is
//     carried forward by api.updatePricingRule; Settings must not pass one.
//
//   * Overlapping saves cannot leave the older value stored. These writes are
//     read-modify-write, so interleaving them can persist the wrong value.
//
//   * A failed save says so, keeps the typed input, and can be retried. It
//     must never read as success.

import assert from 'node:assert/strict';
import pkg from '/opt/node-tools/node_modules/playwright/index.js';
import { createRecorder, BASE, FAKE_CAPACITOR_CORE } from './test-harness.mjs';

const { chromium } = pkg;
const { results, record } = createRecorder();

const FAKE_SUPABASE_ADMIN = `
  export const supabase = { auth: { signOut: async () => {} } };
  export async function getSession() { return { session: { user: { id: 'admin-1' } }, isAdmin: true }; }
`;

/* api.js stand-in. Fixtures come from globalThis so each test can vary them
   without re-importing the module. */
const FAKE_API = `
  const clone = (v) => JSON.parse(JSON.stringify(v));
  export async function listPricingRules() { return clone(globalThis.__RULES); }
  export async function getSettings()      { return clone(globalThis.__SETTINGS); }
  export async function listServices()     { return clone(globalThis.__SERVICES); }

  async function maybeFail() {
    if (globalThis.__saveDelay) await new Promise(r => setTimeout(r, globalThis.__saveDelay));
    if (globalThis.__failNext > 0) { globalThis.__failNext--; throw new Error('Network unreachable'); }
  }
  export async function updateSetting(key, value) {
    globalThis.__calls.push({ name: 'updateSetting', key, value: clone(value) });
    await maybeFail();
    return {};
  }
  export async function updatePricingRule(serviceId, patch) {
    globalThis.__calls.push({ name: 'updatePricingRule', serviceId, patch: clone(patch) });
    await maybeFail();
    return {};
  }
`;

/* Mirrors the real stored shapes, including keys the structured editors do
   NOT expose (tax.note, company.internal_code) so preservation is provable. */
const SETTINGS = {
  admin: { base_url: 'https://novashieldmaintenance.com/admin' },
  company: {
    legal_name: 'Nova Shield Maintenance Services', display_name: 'Nova Shield',
    email: 'info@novashieldmaintenance.com', phone: '437-436-3360',
    website: 'https://novashieldmaintenance.com',
    city: 'Sault Ste. Marie', province: 'ON',
    service_area: 'Sault Ste. Marie & surrounding area',
    internal_code: 'NS-INTERNAL-001'
  },
  tax: {
    enabled: false, rate: 0.13, label: 'HST', registration_number: null,
    note: 'Disabled until GST/HST registration is complete.'
  },
  quote_defaults: {
    validity_days: 30, currency: 'CAD',
    customer_note: 'Pricing is confirmed after an on-site review.',
    terms: 'Payment due on completion by e-transfer.'
  },
  lighting: { permanent_warranty_years: 6, christmas_storage_included: true,
              christmas_install_window: 'October - November' }
};

const RULES = [
  { service_id: 'svc-roof', rate: 0.45, minimum: 299, approval_status: 'approved',
    services: { key: 'roof', name: 'Roof Soft Washing', unit: 'sq_ft', category: 'cleaning' } },
  { service_id: 'svc-perm', rate: 5, minimum: 0, approval_status: 'approved',
    services: { key: 'perm', name: 'Permanent Outdoor Lighting', unit: 'linear_ft', category: 'lighting' } },
  { service_id: 'svc-wire', rate: 14, minimum: 450, approval_status: 'provisional',
    services: { key: 'wire', name: 'Heating Wire Installation', unit: 'linear_ft', category: 'winter' } },
  { service_id: 'svc-snow', rate: 55, minimum: 45, approval_status: 'provisional',
    services: { key: 'snow', name: 'Walkway, Step & Deck Snow Removal', unit: 'each', category: 'winter' } }
];

const SERVICES = [
  { id: 'svc-roof', name: 'Roof Soft Washing', quotable: true },
  { id: 'svc-perm', name: 'Permanent Outdoor Lighting', quotable: true },
  { id: 'svc-wire', name: 'Heating Wire Installation', quotable: true },
  { id: 'svc-snow', name: 'Walkway, Step & Deck Snow Removal', quotable: true }
];

async function launch() {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  const mock = (p, body) => page.route(p, (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body }));
  await mock('**/cdn.jsdelivr.net/npm/@capacitor/core@8.5.2/+esm', FAKE_CAPACITOR_CORE);
  await mock(`${BASE}/shared/supabase.js`, FAKE_SUPABASE_ADMIN);
  await mock(`${BASE}/admin/js/lib/api.js`, FAKE_API);
  await page.goto(`${BASE}/admin/field.html`);
  await page.waitForTimeout(150);

  /** Renders Settings into a detached mount, runs `body({ mount, h })` against
   *  it, unmounts, and returns { out, calls }. `h` is a set of DOM helpers
   *  built inside the page -- passed as an argument rather than eval'd into
   *  the body, because const/let inside a direct eval do not escape it. */
  const withSettings = (overrides, body) => page.evaluate(
    async ({ settings, rules, services, opts, bodySrc }) => {
      globalThis.__SETTINGS = settings;
      globalThis.__RULES = rules;
      globalThis.__SERVICES = services;
      globalThis.__calls = [];
      globalThis.__failNext = opts.failNext || 0;
      globalThis.__saveDelay = opts.saveDelay || 0;

      const mod = await import('/admin/js/views/settings.js');
      const mount = document.createElement('div');
      document.body.appendChild(mount);
      await mod.renderSettings({ mount });

      const h = {
        cardTitled: (root, title) => [...root.querySelectorAll('.card')]
          .find(c => c.querySelector('h2') && c.querySelector('h2').textContent === title),
        boxTitled: (root, title) => [...root.querySelectorAll('.section-box')]
          .find(b => b.querySelector('h3') && b.querySelector('h3').textContent === title),
        labelled: (scope, label) => {
          const span = [...scope.querySelectorAll('label.field > span')]
            .find(s => s.textContent === label);
          return span ? span.parentElement.querySelector('input, select, textarea') : null;
        },
        saveButton: (scope) => [...scope.querySelectorAll('button')]
          .find(b => b.textContent.startsWith('Save')),
        status: (scope) => {
          const n = scope.querySelector('[role="status"]');
          return n ? n.textContent : null;
        },
        visibleError: (scope) => {
          const n = scope.querySelector('.error-text:not([hidden])');
          return n ? n.textContent : null;
        },
        settle: (ms) => new Promise(r => setTimeout(r, ms))
      };

      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (${bodySrc})`)();
      const out = await fn({ mount, h });
      mount.remove();
      return { out, calls: globalThis.__calls };
    },
    {
      settings: overrides.settings || SETTINGS,
      rules: overrides.rules || RULES,
      services: overrides.services || SERVICES,
      opts: overrides.opts || {},
      bodySrc: body.toString()
    }
  );

  return { browser, withSettings };
}

(async () => {
  const { browser, withSettings } = await launch();

  // ============================================ A. every category shows ===
  await record('every pricing category renders, including winter', async () => {
    const { out } = await withSettings({}, async ({ mount }) =>
      [...mount.querySelectorAll('.card h2')].map(h2 => h2.textContent));
    assert.ok(out.includes('Cleaning rates'), `missing cleaning, got ${out.join(' | ')}`);
    assert.ok(out.includes('Lighting rates'), `missing lighting, got ${out.join(' | ')}`);
    assert.ok(out.includes('Winter rates'),
      `winter rates must be editable here -- this is the START_HERE task. Got: ${out.join(' | ')}`);
  });

  await record('both winter services are individually editable', async () => {
    const { out } = await withSettings({}, async ({ mount, h }) => {
      const card = h.cardTitled(mount, 'Winter rates');
      return [...card.querySelectorAll('.section-box h3')].map(x => x.textContent);
    });
    assert.deepEqual(out.sort(), ['Heating Wire Installation', 'Walkway, Step & Deck Snow Removal']);
  });

  // ==================================================== B. approval UI ====
  await record('provisional rates are badged and say that saving does not approve them', async () => {
    const { out } = await withSettings({}, async ({ mount, h }) => {
      const wire = h.boxTitled(mount, 'Heating Wire Installation');
      const roof = h.boxTitled(mount, 'Roof Soft Washing');
      return {
        wireBadges: [...wire.querySelectorAll('.badge')].map(b => b.textContent),
        roofBadges: [...roof.querySelectorAll('.badge')].map(b => b.textContent),
        wireSaysNotApproval: wire.textContent.includes('does not approve it'),
        winterHeaderBadge: h.cardTitled(mount, 'Winter rates')
          .querySelector('.card__head .badge').textContent
      };
    });
    assert.ok(out.wireBadges.includes('Provisional'), `got ${out.wireBadges.join(',')}`);
    assert.ok(out.roofBadges.includes('Approved'), `got ${out.roofBadges.join(',')}`);
    assert.equal(out.wireSaysNotApproval, true);
    assert.equal(out.winterHeaderBadge, '2 provisional');
  });

  await record('saving a rate sends only rate and minimum -- it cannot implicitly approve', async () => {
    const { calls } = await withSettings({}, async ({ mount, h }) => {
      const wire = h.boxTitled(mount, 'Heating Wire Installation');
      h.labelled(wire, 'Rate ($ / linear ft)').value = '16.50';
      h.saveButton(wire).click();
      await h.settle(80);
      return null;
    });
    const saves = calls.filter(c => c.name === 'updatePricingRule');
    assert.equal(saves.length, 1);
    assert.equal(saves[0].serviceId, 'svc-wire');
    assert.deepEqual(Object.keys(saves[0].patch).sort(), ['minimum', 'rate']);
    assert.equal(saves[0].patch.rate, 16.5);
    assert.equal(saves[0].patch.approval_status, undefined,
      'Settings must never send approval_status -- the API carries it forward');
  });

  // ========================================= C. unknown-key preservation ==
  await record('saving Tax preserves the note key the editor does not expose', async () => {
    const { calls } = await withSettings({}, async ({ mount, h }) => {
      const card = h.cardTitled(mount, 'Tax');
      h.labelled(card, 'Tax label').value = 'GST';
      h.saveButton(card).click();
      await h.settle(80);
      return null;
    });
    const save = calls.find(c => c.name === 'updateSetting' && c.key === 'tax');
    assert.ok(save, 'tax should have been saved');
    assert.equal(save.value.label, 'GST');
    assert.equal(save.value.note, 'Disabled until GST/HST registration is complete.',
      'an unexposed key must survive the write');
    assert.equal(save.value.enabled, false, 'saving must not enable tax');
    assert.equal(save.value.rate, 0.13);
  });

  await record('saving Company preserves an unexposed internal key', async () => {
    const { calls } = await withSettings({}, async ({ mount, h }) => {
      const card = h.cardTitled(mount, 'Company details');
      h.labelled(card, 'Display name').value = 'Nova Shield Services';
      h.saveButton(card).click();
      await h.settle(80);
      return null;
    });
    const save = calls.find(c => c.name === 'updateSetting' && c.key === 'company');
    assert.equal(save.value.display_name, 'Nova Shield Services');
    assert.equal(save.value.internal_code, 'NS-INTERNAL-001');
  });

  // ================================================== D. tax stays off ====
  await record('tax.enabled=false keeps its warning and is never enabled automatically', async () => {
    const { out, calls } = await withSettings({}, async ({ mount, h }) => {
      const card = h.cardTitled(mount, 'Tax');
      const warn = card.querySelector('.warn');
      const select = h.labelled(card, 'Charge tax on new quotes');
      h.saveButton(card).click();
      await h.settle(80);
      return { hasWarning: !!warn, warnText: warn ? warn.textContent : '', selectValue: select.value };
    });
    assert.equal(out.hasWarning, true, 'the tax-off warning must be preserved');
    assert.ok(out.warnText.includes('Tax is switched off'));
    assert.equal(out.selectValue, 'false');
    const save = calls.find(c => c.key === 'tax');
    assert.equal(save.value.enabled, false, 'an untouched save must not flip tax on');
  });

  // ==================================================== E. validation ====
  await record('a tax rate typed as a percentage is rejected before any write', async () => {
    const { out, calls } = await withSettings({}, async ({ mount, h }) => {
      const card = h.cardTitled(mount, 'Tax');
      h.labelled(card, 'Rate (fraction)').value = '13';
      h.saveButton(card).click();
      await h.settle(80);
      return { status: h.status(card), error: h.visibleError(card) };
    });
    assert.equal(calls.filter(c => c.name === 'updateSetting').length, 0, 'nothing should be written');
    assert.ok(/0 and 1/.test(out.error || ''), `expected a fraction error, got ${out.error}`);
    assert.ok(/check the fields/.test(out.status || ''), `status should report the stop, got ${out.status}`);
  });

  await record('a malformed admin base URL is rejected', async () => {
    const { out, calls } = await withSettings({}, async ({ mount, h }) => {
      const card = h.cardTitled(mount, 'Staff email links');
      h.labelled(card, 'Admin base URL').value = 'novashield-admin';
      h.saveButton(card).click();
      await h.settle(80);
      return { error: h.visibleError(card) };
    });
    assert.equal(calls.filter(c => c.name === 'updateSetting').length, 0);
    assert.ok(/full URL/.test(out.error || ''), `got ${out.error}`);
  });

  await record('a required company field cannot be blanked', async () => {
    const { out, calls } = await withSettings({}, async ({ mount, h }) => {
      const card = h.cardTitled(mount, 'Company details');
      h.labelled(card, 'Legal name').value = '   ';
      h.saveButton(card).click();
      await h.settle(80);
      return { error: h.visibleError(card) };
    });
    assert.equal(calls.filter(c => c.name === 'updateSetting').length, 0);
    assert.equal(out.error, 'Required.');
  });

  await record('validity days must be a whole number of at least 1', async () => {
    const { out, calls } = await withSettings({}, async ({ mount, h }) => {
      const card = h.cardTitled(mount, 'Quote defaults');
      const input = h.labelled(card, 'Valid for (days)');
      input.value = '1.5';
      h.saveButton(card).click();
      await h.settle(60);
      const fractional = h.visibleError(card);
      input.value = '0';
      h.saveButton(card).click();
      await h.settle(60);
      return { fractional, zero: h.visibleError(card) };
    });
    assert.equal(calls.filter(c => c.name === 'updateSetting').length, 0);
    assert.ok(/whole number/.test(out.fractional || ''), `got ${out.fractional}`);
    assert.ok(/less than 1/.test(out.zero || ''), `got ${out.zero}`);
  });

  await record('a blanked rate is rejected rather than silently stored as zero', async () => {
    const { out, calls } = await withSettings({}, async ({ mount, h }) => {
      const roof = h.boxTitled(mount, 'Roof Soft Washing');
      h.labelled(roof, 'Rate ($ / sq ft)').value = '';
      h.saveButton(roof).click();
      await h.settle(80);
      return { error: h.visibleError(roof) };
    });
    assert.equal(calls.filter(c => c.name === 'updatePricingRule').length, 0,
      'Number("") is 0 -- a cleared rate must not be written as a real zero');
    assert.equal(out.error, 'Required.');
  });

  await record('currency offers only the supported values', async () => {
    const { out } = await withSettings({}, async ({ mount, h }) => {
      const card = h.cardTitled(mount, 'Quote defaults');
      return [...h.labelled(card, 'Currency').options].map(o => o.value);
    });
    assert.deepEqual(out, ['CAD', 'USD']);
  });

  // ============================================== F. save state honesty ===
  await record('a successful save reports Saved only after the write resolves', async () => {
    const { out } = await withSettings({ opts: { saveDelay: 120 } }, async ({ mount, h }) => {
      const card = h.cardTitled(mount, 'Company details');
      h.labelled(card, 'Phone').value = '705-555-0000';
      h.saveButton(card).click();
      await h.settle(30);
      const during = { status: h.status(card), disabled: h.saveButton(card).disabled };
      await h.settle(220);
      return { during, after: h.status(card) };
    });
    assert.equal(out.during.status, 'Saving…', 'it must not claim Saved before the write resolves');
    // The button stays enabled on purpose: a disabled button fires no click,
    // so an edit made mid-save could never be queued and the control would
    // settle on "Saved" with a newer value unsaved on screen. Concurrency is
    // handled by coalescing in createSaveRunner, not by blocking input.
    assert.equal(out.during.disabled, false, 'the button must remain clickable during a save');
    assert.equal(out.after, 'Saved');
  });

  await record('a failed save says so, keeps the typed value, and can be retried', async () => {
    const { out, calls } = await withSettings({ opts: { failNext: 1 } }, async ({ mount, h }) => {
      const card = h.cardTitled(mount, 'Company details');
      h.labelled(card, 'Phone').value = '705-555-1234';
      h.saveButton(card).click();
      await h.settle(100);
      const failed = {
        status: h.status(card),
        kept: h.labelled(card, 'Phone').value,
        enabled: !h.saveButton(card).disabled
      };
      h.saveButton(card).click();          // retry
      await h.settle(120);
      return { failed, retried: h.status(card), keptAfter: h.labelled(card, 'Phone').value };
    });
    assert.ok(/^Not saved — /.test(out.failed.status), `got ${out.failed.status}`);
    assert.ok(/Network unreachable/.test(out.failed.status));
    assert.equal(out.failed.kept, '705-555-1234', "the operator's input must survive a failure");
    assert.equal(out.failed.enabled, true, 'retry must be possible');
    assert.equal(out.retried, 'Saved');
    assert.equal(out.keptAfter, '705-555-1234');
    assert.equal(calls.filter(c => c.key === 'company').length, 2);
  });

  // ============================================== G. overlapping saves ====
  await record('overlapping saves cannot leave the older value stored', async () => {
    const { calls } = await withSettings({ opts: { saveDelay: 150 } }, async ({ mount, h }) => {
      const card = h.cardTitled(mount, 'Company details');
      const phone = h.labelled(card, 'Phone');
      phone.value = 'FIRST';
      h.saveButton(card).click();
      await h.settle(20);                  // first write in flight
      phone.value = 'SECOND';
      h.saveButton(card).click();          // coalesced into a trailing run
      await h.settle(700);
      return null;
    });
    const writes = calls.filter(c => c.key === 'company');
    assert.ok(writes.length >= 1, 'at least one write should happen');
    assert.equal(writes[writes.length - 1].value.phone, 'SECOND',
      'the last stored value must be the last value on screen');
    const secondIdx = writes.findIndex(w => w.value.phone === 'SECOND');
    const laterFirsts = writes.slice(secondIdx + 1).filter(w => w.value.phone === 'FIRST');
    assert.equal(laterFirsts.length, 0, 'an older value must never land after a newer one');
  });

  await record('a rate save in flight does not let an older value win', async () => {
    const { calls } = await withSettings({ opts: { saveDelay: 150 } }, async ({ mount, h }) => {
      const roof = h.boxTitled(mount, 'Roof Soft Washing');
      const rate = h.labelled(roof, 'Rate ($ / sq ft)');
      rate.value = '0.60';
      h.saveButton(roof).click();
      await h.settle(20);
      rate.value = '0.75';
      h.saveButton(roof).click();
      await h.settle(700);
      return null;
    });
    const writes = calls.filter(c => c.name === 'updatePricingRule');
    assert.equal(writes[writes.length - 1].patch.rate, 0.75);
  });

  // ================================================= H. unpriced notice ===
  await record('a quotable service with no rate is surfaced, not hidden', async () => {
    const { out } = await withSettings({
      services: [...SERVICES, { id: 'svc-new', name: 'Gutter Guard Install', quotable: true }]
    }, async ({ mount }) => {
      const warn = [...mount.querySelectorAll('.warn')]
        .find(w => w.textContent.includes('no rate'));
      return warn ? warn.textContent : null;
    });
    assert.ok(out && out.includes('Gutter Guard Install'), `got ${out}`);
  });

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
})();
