// Phase 30 -- integration corrective: inventory creation, the visible
// "null" on the property screen, and the daily-load selection hooks.
//
// Run directly:   node tests/phase30.test.mjs      (static server on :8743)
//
// These are MOCKED BROWSER TESTS. api.js is replaced with a stub, so they
// prove the admin console's own logic and nothing about the live database.
// NONE OF THE 31 PENDING MIGRATIONS HAS BEEN APPLIED TO PRODUCTION, so
// nothing here says anything about what the live project enforces -- in
// particular, A4/A5 pin the request this form SENDS, not that the database
// accepted it.
//
// The three findings came from reading the integrated candidate at
// codex/integration-candidate@52510c3 (docs/integration-candidate.md), and
// each reproduced on this branch at 9b64b23 before the fix:
//
//   * ADDING A PART could not express the units the rest of the system
//     already uses. The form had its own six-unit list while the database
//     constraint, the label module and every reading screen knew nine, plus
//     level tracking -- so bulk chemicals (litre), de-icer (kilogram) and
//     lighting channel (stick) were uncreatable, and a level-tracked supply
//     was uncreatable at all. Worse than a missing feature: the one
//     combination the constraint
//         ns_materials_level_unit_agrees ((tracking_mode='level') = (unit='level'))
//     exists to refuse was the only one a form offering 'level' as a tenth
//     unit could produce.
//
//   * THE PROPERTY SCREEN printed the word "null" under the customer link.
//     el() skips a null child; Element.append() -- the DOM's own method,
//     which the page head uses -- stringifies it. Every property that HAS a
//     customer showed it, which is nearly all of them.
//
//   * THE DAILY LOAD TAB lost the chosen vehicle and day on reload. The
//     panel owned both privately and told nobody, so coming back to the
//     screen -- the ordinary thing to do on a phone -- silently returned to
//     Car A and today while the operator was reading tomorrow's plan.
//
// B6 is here to keep a specific promise: Car B is OPTIONAL data. Nothing in
// the admin console may seed it, activate it, or quietly substitute Car A
// when a URL names it and the backend has never heard of it.

import assert from 'node:assert/strict';
import pkg from '/opt/node-tools/node_modules/playwright/index.js';
import { createRecorder, BASE, FAKE_CAPACITOR_CORE } from './test-harness.mjs';

const { chromium } = pkg;
const { results, record } = createRecorder();

const FAKE_SUPABASE_ADMIN = `
  export const supabase = { auth: { signOut: async () => {} } };
  export async function getSession() { return { session: { user: { id: 'admin-1' } }, isAdmin: true }; }
`;

const FAKE_API = `
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const push = (name, payload) => { globalThis.__calls.push({ name, ...payload }); };

  export async function listSuppliers()  { return clone(globalThis.__SUPPLIERS); }
  export async function listMaterials()  { return clone(globalThis.__MATERIALS); }
  export async function listServices()   { return []; }
  export async function listPurchaseOrders() { return []; }
  export async function listServiceMaterialUsage() { return []; }
  export async function listSeasonalSets() { return []; }
  export async function listSeasonalAssignments() { return []; }
  export async function listStockMoves() { return []; }
  export async function listRentalSetEvents() { return []; }
  export async function listStockLocations() { return clone(globalThis.__LOCATIONS); }
  export async function listStockByLocation() { return clone(globalThis.__BALANCES); }
  export async function listReservations() { return []; }
  export async function currentUserId() { return 'admin-1'; }
  export function newOperationId(prefix) { return (prefix || 'op') + '-fixed-for-tests'; }

  export async function createMaterial(p) { push('createMaterial', { patch: clone(p) }); return {}; }
  export async function updateMaterial(id, p) { push('updateMaterial', { id, patch: clone(p) }); return {}; }
  export async function createSupplier(p) { push('createSupplier', { patch: clone(p) }); return {}; }
  export async function updateSupplier(id, p) { push('updateSupplier', { id, patch: clone(p) }); return {}; }
  export async function setMaterialLevel(a) { push('setMaterialLevel', a); return {}; }
  export async function postStockMovement(a) { push('postStockMovement', a); return {}; }
  export async function postStockTransfer(a) { push('postStockTransfer', a); return {}; }
  export async function reserveStock(a) { push('reserveStock', a); return {}; }
  export async function releaseStockReservation(a) { push('releaseStockReservation', a); return {}; }
  export async function consumeStockReservation(a) { push('consumeStockReservation', a); return {}; }

  /* The daily load panel. getLoadPlan returns the contract ENVELOPE with a
     null plan, which is the "no plan built yet" state -- enough to render
     the selectors, which is all these tests are about. The call is recorded
     so B1/B2/B3 can assert WHICH day and vehicle were actually asked for,
     rather than only what the controls display. */
  export async function getLoadPlan(a) {
    push('getLoadPlan', a);
    return { plan: null, can_build: true, work_day_timezone_state: 'configured',
             work_date: a.workDate, location_code: a.locationCode };
  }
  export async function nextDaySuggestions(a) { push('nextDaySuggestions', a); return null; }
  export async function buildLoadPlan(a) { push('buildLoadPlan', a); return {}; }

  /* The property screen. */
  export async function propertyHistory(id) {
    push('propertyHistory', { id });
    return clone(globalThis.__PROPERTY_HISTORY);
  }
  export async function updateProperty(id, p) { push('updateProperty', { id, patch: clone(p) }); return {}; }
  export function attachmentBucket() { return 'attachments'; }
  export async function signedPhotoUrl() { return null; }
`;

/* Fixtures. Obviously fixtures: no test should read like it documents a
   real part number or a real address. */
const SUPPLIERS = [{ id: 'sup-1', name: 'FIXTURE supplier', active: true }];

const MATERIALS = [
  { id: 'mat-track', name: 'FIXTURE channel', sku: 'FX-1', category: 'track',
    unit: 'stick', tracking_mode: 'quantity', supplier_id: 'sup-1',
    ns_suppliers: { id: 'sup-1', name: 'FIXTURE supplier' },
    pack_quantity: 10, unit_cost: 2, currency: 'CAD', reorder_point: 4,
    reorder_qty: 1, active: true, on_hand: 20, needs_reorder: false, last_move_at: null }
];

const LOCATIONS = [
  { id: 'loc-base',  code: 'base',  name: 'Base',  kind: 'base',    active: true, sort_order: 0 },
  { id: 'loc-car-a', code: 'car_a', name: 'Car A', kind: 'vehicle', active: true, sort_order: 1 }
];

const BALANCES = [
  { material_id: 'mat-track', location_id: 'loc-base', location_code: 'base',
    location_name: 'Base', on_hand: 20, reserved: 0, available: 20,
    damaged_on_hand: 0, is_estimated: false, unit: 'stick' }
];

const PROPERTY_WITH_CUSTOMER = {
  property: {
    id: 'prop-1', address_line1: '1 Fixture Lane', city: 'Sault Ste. Marie',
    province: 'ON', postal_code: 'P6A 0A0', property_type: 'residential',
    latitude: null, longitude: null, passport: {},
    customer: { id: 'cus-1', name: 'FIXTURE customer' }
  },
  jobs: [], quotes: [], measurements: [], inspections: [], photos: []
};

const PROPERTY_WITHOUT_CUSTOMER = {
  property: { ...PROPERTY_WITH_CUSTOMER.property, customer: null },
  jobs: [], quotes: [], measurements: [], inspections: [], photos: []
};

const HELPERS = () => ({
  cardTitled: (root, title) => [...root.querySelectorAll('.card')]
    .find((c) => c.querySelector('h2') && c.querySelector('h2').textContent === title),
  labelled: (scope, label) => {
    const span = [...scope.querySelectorAll('label.field > span')]
      .find((s) => s.textContent === label);
    return span ? span.parentElement.querySelector('input, select, textarea') : null;
  },
  optionsOf: (node) => (node ? [...node.querySelectorAll('option')].map((o) => o.value) : null),
  button: (scope, text) => [...scope.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === text),
  /** Sets a control's value and fires the `change` the component listens
   *  for. Assigning .value alone fires nothing, which is how a test can
   *  pass against a handler that was never wired. */
  change: (node, value) => {
    node.value = value;
    node.dispatchEvent(new Event('change', { bubbles: true }));
  },
  settle: (ms) => new Promise((r) => setTimeout(r, ms || 80))
});

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

  const withInventory = (opts, body) => page.evaluate(
    async ({ fixtures, options, bodySrc, helpersSrc }) => {
      Object.assign(globalThis, fixtures);
      globalThis.__calls = [];

      const mod = await import('/admin/js/views/inventory.js');
      const mount = document.createElement('div');
      document.body.appendChild(mount);

      const queries = [];
      await mod.renderInventory({
        mount,
        params: new URLSearchParams(options.query || ''),
        replaceQuery: (q) => queries.push(q),
        navigate: () => {}
      });

      // eslint-disable-next-line no-new-func
      const h = new Function(`return (${helpersSrc})`)()();
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (${bodySrc})`)();
      const out = await fn({ mount, h });
      mount.remove();
      return { out, calls: globalThis.__calls, queries };
    },
    {
      fixtures: {
        __SUPPLIERS: opts.suppliers || SUPPLIERS,
        __MATERIALS: opts.materials || MATERIALS,
        __LOCATIONS: opts.locations || LOCATIONS,
        __BALANCES: opts.balances || BALANCES
      },
      options: opts,
      bodySrc: body.toString(),
      helpersSrc: HELPERS.toString()
    });

  /** The load panel on its own, so the DEFAULTS can be tested without the
   *  Inventory view supplying any. */
  const withLoadPanel = (opts, body) => page.evaluate(
    async ({ fixtures, options, bodySrc, helpersSrc }) => {
      Object.assign(globalThis, fixtures);
      globalThis.__calls = [];

      const mod = await import('/admin/js/components/load-plan.js');
      const mount = document.createElement('div');
      document.body.appendChild(mount);

      const reported = [];
      const args = { ...(options.panelArgs || {}) };
      if (options.withHook) {
        args.onSelectionChange = (sel) => {
          reported.push(sel);
          if (options.hookThrows) throw new Error('router exploded');
        };
      }
      mount.appendChild(mod.loadPlanPanel(args));

      // eslint-disable-next-line no-new-func
      const h = new Function(`return (${helpersSrc})`)()();
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (${bodySrc})`)();
      const out = await fn({ mount, h });
      mount.remove();
      return { out, calls: globalThis.__calls, reported };
    },
    {
      fixtures: { __LOCATIONS: opts.locations || LOCATIONS },
      options: opts,
      bodySrc: body.toString(),
      helpersSrc: HELPERS.toString()
    });

  const withProperty = (opts, body) => page.evaluate(
    async ({ fixtures, options, bodySrc, helpersSrc }) => {
      Object.assign(globalThis, fixtures);
      globalThis.__calls = [];

      const mod = await import('/admin/js/views/property.js');
      const mount = document.createElement('div');
      document.body.appendChild(mount);

      await mod.renderProperty({ mount, setContextParent: () => {} }, options.propertyId || 'prop-1');

      // eslint-disable-next-line no-new-func
      const h = new Function(`return (${helpersSrc})`)()();
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (${bodySrc})`)();
      const out = await fn({ mount, h });
      mount.remove();
      return { out, calls: globalThis.__calls };
    },
    {
      fixtures: { __PROPERTY_HISTORY: opts.history || PROPERTY_WITH_CUSTOMER },
      options: opts,
      bodySrc: body.toString(),
      helpersSrc: HELPERS.toString()
    });

  return { browser, page, withInventory, withLoadPanel, withProperty };
}

(async () => {
  const { browser, page, withInventory, withLoadPanel, withProperty } = await launch();

  let lastDialog = null;
  page.on('dialog', (d) => { lastDialog = d.message(); d.accept(); });

  /* ================================ A. adding a part ==================== */

  await record('A1 every unit the database accepts can be chosen, and "level" is not one of them', async () => {
    const { out } = await withInventory({}, async ({ mount, h }) => {
      await h.settle(150);
      const card = h.cardTitled(mount, 'Add a part');
      return h.optionsOf(h.labelled(card, 'Counted in'));
    });
    assert.deepEqual(out, [
      'each', 'linear_ft', 'box', 'roll', 'kit', 'set', 'litre', 'kilogram', 'stick'
    ]);
    // 'level' is implied by the tracking mode, never typed as a unit --
    // offering it here is what produces the one refused combination.
    assert.equal(out.includes('level'), false);
  });

  await record('A2 quantity vs level is an explicit choice, not a side effect of the unit', async () => {
    const { out } = await withInventory({}, async ({ mount, h }) => {
      await h.settle(150);
      const card = h.cardTitled(mount, 'Add a part');
      const sel = h.labelled(card, 'Tracked by');
      return {
        values: h.optionsOf(sel),
        labels: [...sel.querySelectorAll('option')].map((o) => o.textContent),
        defaulted: sel.value
      };
    });
    assert.deepEqual(out.values, ['quantity', 'level']);
    assert.deepEqual(out.labels, ['Counted', 'Checked as a level']);
    assert.equal(out.defaulted, 'quantity');
  });

  await record('A3 level tracking removes the count, pack and reorder controls and says why', async () => {
    const { out } = await withInventory({}, async ({ mount, h }) => {
      await h.settle(150);
      const card = h.cardTitled(mount, 'Add a part');
      h.change(h.labelled(card, 'Tracked by'), 'level');
      await h.settle();
      return {
        unit:    !!h.labelled(card, 'Counted in'),
        pack:    !!h.labelled(card, 'Pack size'),
        reorder: !!h.labelled(card, 'Reorder at'),
        cost:    !!h.labelled(card, 'Unit cost'),
        says:    card.textContent.includes('no pack size')
                   && card.textContent.includes('Not checked'),
        states:  card.textContent.includes('Empty / Low / Enough')
      };
    });
    assert.deepEqual(out, {
      unit: false, pack: false, reorder: false, cost: true, says: true, states: true
    });
  });

  await record('A4 a counted part in litres is sent as litres, with its pack and reorder point', async () => {
    const { out, calls } = await withInventory({}, async ({ mount, h }) => {
      await h.settle(150);
      const card = h.cardTitled(mount, 'Add a part');
      h.labelled(card, 'Part name').value = 'FIXTURE bleach';
      h.change(h.labelled(card, 'Counted in'), 'litre');
      h.labelled(card, 'Pack size').value = '20';
      h.labelled(card, 'Reorder at').value = '40';
      h.labelled(card, 'Unit cost').value = '3.50';
      h.button(card, 'Add part').click();
      await h.settle(120);
      return true;
    });
    assert.equal(out, true);
    const created = calls.filter((c) => c.name === 'createMaterial');
    assert.equal(created.length, 1);
    assert.deepEqual(created[0].patch, {
      name: 'FIXTURE bleach', sku: null, category: 'track',
      unit: 'litre', tracking_mode: 'quantity', supplier_id: 'sup-1',
      pack_quantity: 20, unit_cost: 3.5, reorder_point: 40
    });
  });

  await record('A5 a level-tracked supply is sent as unit=level, tracking=level, pack 1, reorder 0', async () => {
    const { calls } = await withInventory({}, async ({ mount, h }) => {
      await h.settle(150);
      const card = h.cardTitled(mount, 'Add a part');
      h.labelled(card, 'Part name').value = 'FIXTURE rags';
      h.change(h.labelled(card, 'Tracked by'), 'level');
      await h.settle();
      h.button(card, 'Add part').click();
      await h.settle(120);
      return true;
    });
    const created = calls.filter((c) => c.name === 'createMaterial');
    assert.equal(created.length, 1);
    // unit and tracking_mode must AGREE -- that is the constraint.
    assert.equal(created[0].patch.unit, 'level');
    assert.equal(created[0].patch.tracking_mode, 'level');
    // 1 is the identity for a conversion that never runs; the column is NOT
    // NULL with a > 0 check, so it cannot be left out or sent as zero.
    assert.equal(created[0].patch.pack_quantity, 1);
    assert.equal(created[0].patch.reorder_point, 0);
    // Unknown cost stays unknown, in this mode too.
    assert.equal(created[0].patch.unit_cost, null);
    // No level observation is invented at creation time.
    assert.equal(calls.some((c) => c.name === 'setMaterialLevel'), false);
  });

  await record('A6 switching tracking mode does not carry incompatible values across', async () => {
    const { calls } = await withInventory({}, async ({ mount, h }) => {
      await h.settle(150);
      const card = h.cardTitled(mount, 'Add a part');
      h.labelled(card, 'Part name').value = 'FIXTURE de-icer';

      // Type a counted part's numbers, go to level, come back.
      h.change(h.labelled(card, 'Counted in'), 'kilogram');
      h.labelled(card, 'Pack size').value = '25';
      h.labelled(card, 'Reorder at').value = '75';
      h.change(h.labelled(card, 'Tracked by'), 'level');
      await h.settle();
      h.change(h.labelled(card, 'Tracked by'), 'quantity');
      await h.settle();

      const back = {
        pack: h.labelled(card, 'Pack size').value,
        reorder: h.labelled(card, 'Reorder at').value,
        unit: h.labelled(card, 'Counted in').value
      };
      h.button(card, 'Add part').click();
      await h.settle(120);
      return back;
    });
    const created = calls.filter((c) => c.name === 'createMaterial');
    assert.equal(created.length, 1);
    // Back on the defaults, not on the figures typed before the detour.
    assert.equal(created[0].patch.pack_quantity, 1);
    assert.equal(created[0].patch.reorder_point, 0);
    assert.equal(created[0].patch.unit, 'linear_ft');
    assert.equal(created[0].patch.tracking_mode, 'quantity');
  });

  await record('A7 an unknown cost is sent as null, never as zero', async () => {
    const { calls } = await withInventory({}, async ({ mount, h }) => {
      await h.settle(150);
      const card = h.cardTitled(mount, 'Add a part');
      h.labelled(card, 'Part name').value = 'FIXTURE stick';
      h.change(h.labelled(card, 'Counted in'), 'stick');
      h.button(card, 'Add part').click();
      await h.settle(120);
      return true;
    });
    const created = calls.filter((c) => c.name === 'createMaterial');
    assert.equal(created[0].patch.unit_cost, null);
    assert.equal(created[0].patch.unit, 'stick');
  });

  await record('A8 a part still needs a name, and nothing is sent without one', async () => {
    const { calls } = await withInventory({}, async ({ mount, h }) => {
      await h.settle(150);
      const card = h.cardTitled(mount, 'Add a part');
      h.change(h.labelled(card, 'Tracked by'), 'level');
      await h.settle();
      h.button(card, 'Add part').click();
      await h.settle(100);
      return true;
    });
    assert.equal(calls.some((c) => c.name === 'createMaterial'), false);
  });

  /* ================================ B. daily load selection ============= */

  await record('B1 ?car= and ?day= open the panel on that vehicle and day', async () => {
    const { out, calls } = await withInventory(
      { query: 'tab=load&car=car_a&day=2026-11-03' },
      async ({ mount, h }) => {
        await h.settle(200);
        const card = h.cardTitled(mount, 'Daily load');
        return {
          vehicle: h.labelled(card, 'Vehicle').value,
          day: h.labelled(card, 'Day').value
        };
      });
    assert.deepEqual(out, { vehicle: 'car_a', day: '2026-11-03' });
    // And the backend was actually asked about that day, not about today.
    const reads = calls.filter((c) => c.name === 'getLoadPlan');
    assert.equal(reads[0].workDate, '2026-11-03');
    assert.equal(reads[0].locationCode, 'car_a');
  });

  await record('B2 an invalid ?day= falls back to today rather than asking for a day that is not one', async () => {
    const { calls } = await withInventory(
      { query: 'tab=load&day=2026-02-31' },
      async ({ h }) => { await h.settle(200); return true; });
    const reads = calls.filter((c) => c.name === 'getLoadPlan');
    assert.equal(reads.length >= 1, true);
    assert.match(reads[0].workDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.notEqual(reads[0].workDate, '2026-02-31');
  });

  await record('B3 changing the day records it in the query string, so a reload keeps it', async () => {
    const { queries, calls } = await withInventory(
      { query: 'tab=load&car=car_a&day=2026-11-03' },
      async ({ mount, h }) => {
        await h.settle(200);
        const card = h.cardTitled(mount, 'Daily load');
        h.change(h.labelled(card, 'Day'), '2026-11-04');
        await h.settle(200);
        return true;
      });
    assert.deepEqual(queries, ['tab=load&car=car_a&day=2026-11-04']);
    const reads = calls.filter((c) => c.name === 'getLoadPlan');
    assert.equal(reads.at(-1).workDate, '2026-11-04');
  });

  await record('B4 changing the vehicle records it too, and keeps the day alongside it', async () => {
    const { queries, calls } = await withInventory(
      { query: 'tab=load&day=2026-11-03',
        locations: [...LOCATIONS, { id: 'loc-car-b', code: 'car_b', name: 'Car B', kind: 'vehicle', active: true, sort_order: 2 }] },
      async ({ mount, h }) => {
        await h.settle(200);
        const card = h.cardTitled(mount, 'Daily load');
        h.change(h.labelled(card, 'Vehicle'), 'car_b');
        await h.settle(200);
        return true;
      });
    assert.deepEqual(queries, ['tab=load&car=car_b&day=2026-11-03']);
    assert.equal(calls.filter((c) => c.name === 'getLoadPlan').at(-1).locationCode, 'car_b');
  });

  await record('B5 switching tabs away and back does not spend a history entry or lose the selection', async () => {
    const { queries } = await withInventory(
      { query: 'tab=load&car=car_a&day=2026-11-03' },
      async ({ mount, h }) => {
        await h.settle(200);
        const card = h.cardTitled(mount, 'Daily load');
        h.change(h.labelled(card, 'Day'), '2026-11-05');
        await h.settle(200);
        // Leave for Stock and come back: the load tab's query must carry
        // the selection, not the defaults.
        [...mount.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Stock').click();
        await h.settle(150);
        [...mount.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Daily load').click();
        await h.settle(250);
        const back = h.cardTitled(mount, 'Daily load');
        return { day: h.labelled(back, 'Day').value };
      });
    assert.deepEqual(queries, [
      'tab=load&car=car_a&day=2026-11-05',
      'tab=stock',
      'tab=load&car=car_a&day=2026-11-05'
    ]);
  });

  await record('B6 a vehicle code the backend does not know is shown as itself, never swapped or seeded', async () => {
    // Car B is optional data. LOCATIONS here deliberately does NOT contain
    // it, which is the live state: nothing may invent it.
    const { out, calls } = await withLoadPanel(
      { panelArgs: { locationCode: 'car_b', workDate: '2026-11-03' } },
      async ({ mount, h }) => {
        await h.settle(250);
        const sel = h.labelled(mount, 'Vehicle');
        return {
          value: sel.value,
          options: h.optionsOf(sel),
          label: [...sel.querySelectorAll('option')].find((o) => o.value === 'car_b').textContent
        };
      });
    assert.equal(out.value, 'car_b');
    // Listed as itself and still selected: a <select> handed a value none of
    // its options carries silently falls back to the first one, which showed
    // Car A's name above Car B's plan.
    assert.deepEqual(out.options, ['car_b', 'car_a']);
    assert.equal(out.label, 'car_b (not a known vehicle)');
    assert.equal(calls.filter((c) => c.name === 'getLoadPlan')[0].locationCode, 'car_b');
    // Nothing was created, activated or transferred to bring it into being.
    assert.equal(calls.some((c) => ['postStockTransfer', 'createMaterial',
      'postStockMovement', 'buildLoadPlan'].includes(c.name)), false);
  });

  await record('B7 existing callers that pass nothing keep Car A and today', async () => {
    const { out, calls, reported } = await withLoadPanel({}, async ({ mount, h }) => {
      await h.settle(250);
      return {
        vehicle: h.labelled(mount, 'Vehicle').value,
        day: h.labelled(mount, 'Day').value
      };
    });
    assert.equal(out.vehicle, 'car_a');
    assert.equal(out.day, new Date().toISOString().slice(0, 10));
    assert.equal(calls.filter((c) => c.name === 'getLoadPlan')[0].locationCode, 'car_a');
    assert.deepEqual(reported, []);
  });

  await record('B8 the hook is not called on mount -- a default is not a choice somebody made', async () => {
    const { reported } = await withLoadPanel(
      { withHook: true, panelArgs: { locationCode: 'car_a', workDate: '2026-11-03' } },
      async ({ h }) => { await h.settle(250); return true; });
    assert.deepEqual(reported, []);
  });

  await record('B9 the hook reports valid changes only, and an unchanged pick reports nothing', async () => {
    const { reported } = await withLoadPanel(
      { withHook: true, panelArgs: { locationCode: 'car_a', workDate: '2026-11-03' } },
      async ({ mount, h }) => {
        await h.settle(250);
        const day = h.labelled(mount, 'Day');
        h.change(day, '2026-11-03');          // the same day: not a change
        await h.settle(120);
        h.change(day, '');                    // cleared: not a selection
        await h.settle(120);
        const afterClear = day.value;
        h.change(day, 'not-a-date');          // unparseable
        await h.settle(120);
        h.change(day, '2026-11-06');          // the one real change
        await h.settle(250);
        return { afterClear };
      });
    assert.deepEqual(reported, [{ locationCode: 'car_a', workDate: '2026-11-06' }]);
  });

  await record('B10 a clearing of the day puts the input back, so no screen shows a plan with no day', async () => {
    const { out } = await withLoadPanel(
      { panelArgs: { locationCode: 'car_a', workDate: '2026-11-03' } },
      async ({ mount, h }) => {
        await h.settle(250);
        const day = h.labelled(mount, 'Day');
        h.change(day, '');
        await h.settle(120);
        return day.value;
      });
    assert.equal(out, '2026-11-03');
  });

  await record('B11 a caller whose hook throws does not take the panel down with it', async () => {
    const { out, calls } = await withLoadPanel(
      { withHook: true, hookThrows: true,
        panelArgs: { locationCode: 'car_a', workDate: '2026-11-03' } },
      async ({ mount, h }) => {
        await h.settle(250);
        h.change(h.labelled(mount, 'Day'), '2026-11-07');
        await h.settle(250);
        return {
          day: h.labelled(mount, 'Day').value,
          stillThere: !!h.cardTitled(mount, 'Daily load')
        };
      });
    assert.deepEqual(out, { day: '2026-11-07', stillThere: true });
    // The reload still happened: the panel adopted the selection before
    // telling anyone, so a throwing listener cannot strand it.
    assert.equal(calls.filter((c) => c.name === 'getLoadPlan').at(-1).workDate, '2026-11-07');
  });

  /* ================================ C. the property screen ============== */

  await record('C1 a property with a customer does not print the word "null"', async () => {
    const { out } = await withProperty({}, async ({ mount, h }) => {
      await h.settle(150);
      return {
        text: mount.textContent,
        stray: [...mount.childNodes]
          .filter((n) => n.nodeType === 3 && n.textContent.trim() !== '')
          .map((n) => n.textContent.trim())
      };
    });
    assert.equal(/\bnull\b/.test(out.text), false, `screen text contained "null": ${out.text}`);
    assert.deepEqual(out.stray, []);
  });

  await record('C2 a property whose customer was deleted still says so plainly', async () => {
    const { out } = await withProperty(
      { history: PROPERTY_WITHOUT_CUSTOMER },
      async ({ mount, h }) => {
        await h.settle(150);
        return {
          says: mount.textContent.includes('This property has no customer on file'),
          stray: [...mount.childNodes]
            .filter((n) => n.nodeType === 3 && n.textContent.trim() !== '')
            .map((n) => n.textContent.trim()),
          backLink: [...mount.querySelectorAll('a')].map((a) => a.textContent.trim())
            .includes('← All customers')
        };
      });
    assert.equal(out.says, true);
    assert.deepEqual(out.stray, []);
    assert.equal(out.backLink, true);
  });

  await record('C3 the customer link is still there when there is a customer', async () => {
    const { out } = await withProperty({}, async ({ mount, h }) => {
      await h.settle(150);
      const link = [...mount.querySelectorAll('a')]
        .find((a) => a.getAttribute('href') === '#/customers/cus-1');
      return {
        href: link ? link.getAttribute('href') : null,
        text: link ? link.textContent.trim() : null,
        noWarning: !mount.textContent.includes('This property has no customer on file')
      };
    });
    assert.deepEqual(out, {
      href: '#/customers/cus-1',
      text: '← FIXTURE customer',
      noWarning: true
    });
  });

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
})();
