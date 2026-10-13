// Phase 23 -- Batch 8.1: Inventory, purchasing and Christmas rental sets.
//
// Run directly:   node tests/phase23.test.mjs      (static server on :8743)
//
// These are MOCKED BROWSER TESTS. api.js is replaced with a stub, so they
// prove the Inventory UI's own logic and nothing about the live database.
// The database side is covered separately and executably by
// tests/db/batch8-1.test.mjs against a disposable PostgreSQL. NEITHER BATCH
// 8.1 MIGRATION HAS BEEN APPLIED TO PRODUCTION, so nothing here says
// anything about what the live project enforces.
//
// What these pin, and why each one is worth a test:
//
//   * The SIGN of a stock movement is decided by its reason, not by what the
//     operator typed. "Used on a job: 40" must post -40. The database refuses
//     a positive 'consumed', so getting this wrong in the UI turns a routine
//     entry into an error the operator cannot explain -- and getting it
//     wrong in the other direction (a magnitude silently negated on a
//     correction) would make a negative correction impossible to enter.
//
//   * Packs convert to shelf units EXACTLY ONCE, on receipt. A purchase
//     order is counted in packs because that is what the supplier sells; the
//     ledger is counted in units. Converting twice, or not at all, is a
//     quiet 150x error in the on-hand figure.
//
//   * A waste allowance is typed as a percentage and stored as a fraction.
//     The column is capped at 1.0, so storing 8 instead of 0.08 is both
//     rejected by the database and an 800% allowance if it ever landed.
//
//   * Only the rental-set transitions the database will accept are offered.
//     "Installed" requires a customer and a date; offering the button on an
//     unassigned set produces a CHECK violation that reads as a bug.
//
//   * The materials estimate is NOT loaded with the job, and consumption is
//     never implicit. A quote that is never accepted must not draw down the
//     shelf.
//
//   * An unknown cost reads as unknown, never as zero.

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
  export async function listMaterials()   { return clone(globalThis.__MATERIALS); }
  export async function listServices()    { return clone(globalThis.__SERVICES); }
  export async function listPurchaseOrders() { return clone(globalThis.__ORDERS); }
  export async function listServiceMaterialUsage() { return clone(globalThis.__USAGE); }
  export async function listSeasonalSets() { return clone(globalThis.__SETS || []); }
  export async function listSeasonalAssignments() { return clone(globalThis.__ASSIGNMENTS || []); }
  export async function listStockMoves()  { return clone(globalThis.__MOVES || []); }
  export async function listRentalSetEvents() { return clone(globalThis.__SET_EVENTS || []); }

  async function maybeFail() {
    if (globalThis.__failNext > 0) { globalThis.__failNext--; throw new Error('Network unreachable'); }
  }

  export function newOperationId(prefix) { return (prefix || 'op') + '-fixed-for-tests'; }
  export async function postStockMovement(args) { push('postStockMovement', args); await maybeFail(); return {}; }
  export async function postStockTransfer(args) { push('postStockTransfer', args); await maybeFail(); return {}; }
  export async function listStockLocations() { return clone(globalThis.__LOCATIONS); }
  export async function listStockByLocation() { return clone(globalThis.__BALANCES); }
  export async function listReservations() { return clone(globalThis.__RESERVATIONS); }
  export async function reserveStock(args) { push('reserveStock', args); await maybeFail(); return {}; }
  export async function releaseStockReservation(args) { push('releaseStockReservation', args); return {}; }
  export async function consumeStockReservation(args) { push('consumeStockReservation', args); return {}; }
  export async function setMaterialLevel(args) { push('setMaterialLevel', args); await maybeFail(); return {}; }
  export async function createMaterial(p)    { push('createMaterial', { patch: clone(p) }); await maybeFail(); return {}; }
  export async function updateMaterial(id, p){ push('updateMaterial', { id, patch: clone(p) }); await maybeFail(); return {}; }
  export async function createSupplier(p)    { push('createSupplier', { patch: clone(p) }); return {}; }
  export async function updateSupplier(id,p) { push('updateSupplier', { id, patch: clone(p) }); return {}; }
  export async function createPurchaseOrder(p){ push('createPurchaseOrder', { patch: clone(p) }); return {}; }
  export async function updatePurchaseOrder(id,p){ push('updatePurchaseOrder', { id, patch: clone(p) }); return {}; }
  export async function addPurchaseOrderLine(id,l){ push('addPurchaseOrderLine', { id, line: clone(l) }); return {}; }
  export async function updatePurchaseOrderLine(id,p){ push('updatePurchaseOrderLine', { id, patch: clone(p) }); return {}; }
  export async function deletePurchaseOrderLine(id){ push('deletePurchaseOrderLine', { id }); }
  export async function setServiceMaterialUsage(p){ push('setServiceMaterialUsage', { patch: clone(p) }); return {}; }
  export async function updateServiceMaterialUsage(id,p){ push('updateServiceMaterialUsage', { id, patch: clone(p) }); return {}; }
  export async function deleteServiceMaterialUsage(id){ push('deleteServiceMaterialUsage', { id }); }
  export async function registerSeasonalSet(a) { push('registerSeasonalSet', a); return {}; }
  export async function currentUserId() { return 'admin-1'; }
  export async function estimateJobMaterials(jobId, locationCode) {
    push('estimateJobMaterials', { jobId, locationCode: locationCode ?? null });
    if (globalThis.__estimateFails) throw new Error('Network unreachable');
    return clone(globalThis.__ESTIMATE);
  }

  // Mirrors the real receivePurchaseOrderLine, but imports the REAL
  // conversion from inventory-math.js, which this file does not mock. That
  // is the whole reason packsToUnits lives in its own module: a conversion
  // reimplemented in the mock would agree with the test while the shipped
  // function was wrong.
  import { packsToUnits } from '/admin/js/lib/inventory-math.js';
  export async function receivePurchaseOrderLine(line, packs) {
    const units = packsToUnits(line.ns_materials, packs);
    if (!(units > 0)) throw new Error('Receive a positive number of packs.');
    await updatePurchaseOrderLine(line.id, {
      packs_received: Number(line.packs_received || 0) + Number(packs)
    });
    await postStockMovement({
      materialId: line.material_id, locationCode: 'base', quantity: units,
      reason: 'received', purchaseOrderId: line.purchase_order_id,
      note: 'Received ' + packs + ' pack(s) on PO'
    });
  }
`;

/* Fixtures. Names are obviously fixtures: the real supplier catalogue has
   never been read by this application, and no test should look like it
   documents a real part number. */
const SUPPLIERS = [
  { id: 'sup-1', name: 'Permanent Lighting Direct',
    website: 'https://permanentlightingdirect.ca/diy-kits', active: true }
];

const MATERIALS = [
  { id: 'mat-track', name: 'FIXTURE channel', sku: 'FX-1', category: 'track',
    unit: 'linear_ft', supplier_id: 'sup-1', ns_suppliers: { id: 'sup-1', name: 'Permanent Lighting Direct' },
    pack_quantity: 150, unit_cost: 2, currency: 'CAD', reorder_point: 100, reorder_qty: 2,
    active: true, on_hand: 250, needs_reorder: false, last_move_at: '2026-10-01T00:00:00Z' },
  { id: 'mat-rags', name: 'FIXTURE rags', sku: null, category: 'consumable',
    unit: 'level', tracking_mode: 'level', supplier_id: 'sup-1',
    ns_suppliers: { id: 'sup-1', name: 'Permanent Lighting Direct' },
    pack_quantity: 1, unit_cost: null, currency: 'CAD', reorder_point: 0,
    reorder_qty: 0, active: true, on_hand: 0, needs_reorder: false, last_move_at: null },
  { id: 'mat-wire', name: 'FIXTURE wire', sku: null, category: 'wire',
    unit: 'linear_ft', supplier_id: 'sup-1', ns_suppliers: { id: 'sup-1', name: 'Permanent Lighting Direct' },
    pack_quantity: 500, unit_cost: null, currency: 'CAD', reorder_point: 50, reorder_qty: 1,
    active: true, on_hand: 10, needs_reorder: true, last_move_at: null }
];

const LOCATIONS = [
  { id: 'loc-base',  code: 'base',  name: 'Base',  kind: 'base',    active: true, sort_order: 0 },
  { id: 'loc-car-a', code: 'car_a', name: 'Car A', kind: 'vehicle', active: true, sort_order: 1 }
];

/* Deliberately split across two locations, so a test that only ever looked
   at a total would pass while the per-location figure was wrong. */
const BALANCES = [
  // Deliberately: track has a live commitment and some damage at Base, so a
  // screen that only ever printed on_hand would look right and be wrong.
  { material_id: 'mat-track', location_id: 'loc-base',  location_code: 'base',
    location_name: 'Base',  on_hand: 200, reserved: 60, available: 140,
    damaged_on_hand: 15, is_estimated: false, unit: 'linear_ft' },
  { material_id: 'mat-track', location_id: 'loc-car-a', location_code: 'car_a',
    location_name: 'Car A', on_hand: 50,  reserved: 0, available: 50,
    damaged_on_hand: 0, is_estimated: true, unit: 'linear_ft' },
  { material_id: 'mat-wire',  location_id: 'loc-base',  location_code: 'base',
    location_name: 'Base',  on_hand: 10,  reserved: 0, available: 10,
    damaged_on_hand: 0, is_estimated: false, unit: 'linear_ft' },
  { material_id: 'mat-wire',  location_id: 'loc-car-a', location_code: 'car_a',
    location_name: 'Car A', on_hand: 0,   reserved: 0, available: 0,
    damaged_on_hand: 0, is_estimated: false, unit: 'linear_ft' },
  { material_id: 'mat-rags',  location_id: 'loc-base',  location_code: 'base',
    location_name: 'Base',  on_hand: 0, reserved: 0, available: 0,
    damaged_on_hand: 0, is_estimated: false, unit: 'level',
    tracking_mode: 'level', level_state: 'low', level_checked_at: '2026-10-08T00:00:00Z' }
];

const RESERVATIONS = [
  { id: 'res-1', material_id: 'mat-track', location_id: 'loc-base',
    quantity: 60, status: 'held', job_id: 'job-1', held_at: '2026-10-09T12:00:00Z',
    ns_stock_locations: { id: 'loc-base', code: 'base', name: 'Base' },
    ns_materials: { id: 'mat-track', name: 'FIXTURE channel', unit: 'linear_ft' } }
];

const SERVICES = [
  { id: 'svc-perm', key: 'permanent_lighting', name: 'Permanent Outdoor Lighting',
    unit: 'linear_ft', quotable: true, sort_order: 10 },
  { id: 'svc-jump', key: 'permanent_lighting_jump', name: 'Jump Wire',
    unit: 'linear_ft', quotable: true, sort_order: 11 },
  { id: 'svc-xmas', key: 'christmas_lighting', name: 'Christmas Lighting',
    unit: 'linear_ft', quotable: true, sort_order: 20 }
];

const USAGE = [
  { id: 'use-1', service_id: 'svc-perm', material_id: 'mat-track',
    quantity_per_unit: 1, waste_factor: 0.08,
    services: SERVICES[0], ns_materials: MATERIALS[0] }
];

const ORDERS = [
  { id: 'po-1', supplier_id: 'sup-1', status: 'ordered', reference: 'FX-PO-1',
    ordered_at: '2026-10-02T00:00:00Z', received_at: null,
    ns_suppliers: { id: 'sup-1', name: 'Permanent Lighting Direct' },
    ns_purchase_order_lines: [
      { id: 'pol-1', purchase_order_id: 'po-1', material_id: 'mat-track',
        packs_ordered: 4, packs_received: 1, unit_cost: null, sort_order: 1,
        ns_materials: { id: 'mat-track', name: 'FIXTURE channel', sku: 'FX-1',
                        unit: 'linear_ft', pack_quantity: 150, unit_cost: 2 } }
    ] }
];

const SETS = [
  { id: 'set-stored', set_code: 'FIXTURE-A', status: 'in_storage', customer_id: null,
    customers: null, properties: null, linear_ft: 180, season_year: null,
    storage_location: 'Bay 3', condition_note: null, installed_at: null, removed_at: null },
  { id: 'set-assigned', set_code: 'FIXTURE-B', status: 'assigned', customer_id: 'cus-1',
    customers: { id: 'cus-1', name: 'FIXTURE customer' },
    properties: { id: 'prop-1', address_line1: '1 Fixture Lane', city: 'Sault Ste. Marie' },
    linear_ft: 200, season_year: 2026, storage_location: null,
    condition_note: null, installed_at: null, removed_at: null }
];

const ESTIMATE = {
  job_id: 'job-1', job_status: 'draft', customer_id: 'cus-1', property_id: 'prop-1',
  generated_at: '2026-10-10T00:00:00Z',
  lines: [
    { material_id: 'mat-track', sku: 'FX-1', name: 'FIXTURE channel', category: 'track',
      unit: 'linear_ft', required: 216, on_hand: 250, shortfall: 0, pack_quantity: 150,
      packs_to_order: 0, unit_cost: 2, currency: 'CAD', estimated_cost: 432,
      needs_reorder: false, active: true, from_flagged_measurement: false,
      from_services: [{ service_key: 'permanent_lighting', service_name: 'Permanent Outdoor Lighting',
                        measured_quantity: 200, service_unit: 'linear_ft',
                        quantity_per_unit: 1, waste_factor: 0.08 }] },
    { material_id: 'mat-wire', sku: null, name: 'FIXTURE wire', category: 'wire',
      unit: 'linear_ft', required: 160, on_hand: 10, shortfall: 150, pack_quantity: 500,
      packs_to_order: 1, unit_cost: null, currency: 'CAD', estimated_cost: null,
      needs_reorder: true, active: true, from_flagged_measurement: true,
      from_services: [{ service_key: 'permanent_lighting_jump', service_name: 'Jump Wire',
                        measured_quantity: 160, service_unit: 'linear_ft',
                        quantity_per_unit: 1, waste_factor: 0 }] }
  ],
  unmapped_services: [
    { service_id: 'svc-xmas', service_key: 'christmas_lighting',
      service_name: 'Christmas Lighting', service_unit: 'linear_ft', measured_quantity: 90 }
  ]
};

/* The DOM helpers every body gets. Passed as an argument rather than eval'd
   into the body, because const/let inside a direct eval do not escape it --
   the trap phase21/22 hit. */
const HELPERS = () => ({
  cardTitled: (root, title) => [...root.querySelectorAll('.card')]
    .find((c) => c.querySelector('h2') && c.querySelector('h2').textContent === title),
  boxTitled: (root, title) => [...root.querySelectorAll('.section-box')]
    .find((b) => (b.textContent || '').includes(title)),
  labelled: (scope, label) => {
    const span = [...scope.querySelectorAll('label.field > span')]
      .find((s) => s.textContent === label);
    return span ? span.parentElement.querySelector('input, select, textarea') : null;
  },
  button: (scope, text) => [...scope.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === text),
  buttonStarting: (scope, text) => [...scope.querySelectorAll('button')]
    .find((b) => b.textContent.trim().startsWith(text)),
  buttonTexts: (scope) => [...scope.querySelectorAll('button')].map((b) => b.textContent.trim()),
  settle: (ms) => new Promise((r) => setTimeout(r, ms || 60))
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

  /** Renders the Inventory view into a detached mount, runs the body against
   *  it, unmounts, and returns { out, calls, queries }. */
  const withInventory = (opts, body) => page.evaluate(
    async ({ fixtures, options, bodySrc, helpersSrc }) => {
      Object.assign(globalThis, fixtures);
      globalThis.__calls = [];
      globalThis.__failNext = options.failNext || 0;
      globalThis.__estimateFails = !!options.estimateFails;

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
        __SERVICES: opts.services || SERVICES,
        __USAGE: opts.usage || USAGE,
        __ORDERS: opts.orders || ORDERS,
        __SETS: opts.sets || SETS,
        __MOVES: opts.moves || [],
        __SET_EVENTS: opts.setEvents || [],
        __LOCATIONS: opts.locations || LOCATIONS,
        __BALANCES: opts.balances || BALANCES,
        __RESERVATIONS: opts.reservations || RESERVATIONS
      },
      options: opts,
      bodySrc: body.toString(),
      helpersSrc: HELPERS.toString()
    });

  /** Same, for the per-job materials panel. */
  const withJobMaterials = (opts, body) => page.evaluate(
    async ({ fixtures, options, bodySrc, helpersSrc }) => {
      Object.assign(globalThis, fixtures);
      globalThis.__calls = [];
      globalThis.__failNext = options.failNext || 0;
      globalThis.__estimateFails = !!options.estimateFails;

      const mod = await import('/admin/js/components/job-materials.js');
      const mount = document.createElement('div');
      document.body.appendChild(mount);
      const panel = mod.createJobMaterialsPanel({ jobId: 'job-1' });
      mount.appendChild(panel.root);

      // eslint-disable-next-line no-new-func
      const h = new Function(`return (${helpersSrc})`)()();
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (${bodySrc})`)();
      const out = await fn({ mount, panel, h });
      mount.remove();
      return { out, calls: globalThis.__calls };
    },
    {
      fixtures: {
        __ESTIMATE: opts.estimate || ESTIMATE,
        __LOCATIONS: opts.locations || LOCATIONS
      },
      options: opts,
      bodySrc: body.toString(),
      helpersSrc: HELPERS.toString()
    });

  return { browser, page, withInventory, withJobMaterials };
}

(async () => {
  const { browser, page, withInventory, withJobMaterials } = await launch();

  /* The dialog handler runs in NODE, not in the page, so the message has to
     be captured here. Reading it back with page.evaluate(() => globalThis
     .__lastDialog) looks right and always yields undefined -- two different
     globals. */
  let lastDialog = null;
  page.on('dialog', (d) => { lastDialog = d.message(); d.accept(); });

  /* ------------------------------------------------------------- tabs ---- */

  await record('A1 the default tab is Stock', async () => {
    const { out } = await withInventory({}, async ({ mount, h }) => {
      await h.settle(120);
      const pressed = [...mount.querySelectorAll('button[aria-pressed="true"]')]
        .map((b) => b.textContent.trim());
      return { pressed, hasCatalogue: mount.textContent.includes('Parts catalogue') };
    });
    assert.deepEqual(out.pressed, ['Stock']);
    assert.equal(out.hasCatalogue, true);
  });

  await record('A2 ?tab= selects the tab, so the screen survives a reload', async () => {
    const { out } = await withInventory({ query: 'tab=sets' }, async ({ mount, h }) => {
      await h.settle();
      return {
        pressed: [...mount.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.textContent.trim()),
        text: mount.textContent.includes('Christmas lighting sets')
      };
    });
    assert.deepEqual(out.pressed, ['Christmas sets']);
    assert.equal(out.text, true);
  });

  await record('A3 an unknown ?tab= falls back to Stock rather than rendering nothing', async () => {
    const { out } = await withInventory({ query: 'tab=nonsense' }, async ({ mount }) => (
      [...mount.querySelectorAll('button[aria-pressed="true"]')].map((b) => b.textContent.trim())
    ));
    assert.deepEqual(out, ['Stock']);
  });

  await record('A4 switching tab uses replaceQuery, so Back is not spent on a tab', async () => {
    const { out, queries } = await withInventory({}, async ({ mount, h }) => {
      const btn = [...mount.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Purchasing');
      btn.click();
      await h.settle(120);
      return mount.textContent.includes('Start a purchase order');
    });
    assert.equal(out, true, 'the purchasing tab must actually render');
    assert.deepEqual(queries, ['tab=purchasing'],
      'a pushed history entry here would make Android Back mean "previous tab"');
  });

  /* -------------------------------------------------------- empty state -- */

  await record('B1 an empty catalogue explains that nothing is pre-loaded, and links the supplier', async () => {
    const { out } = await withInventory({ materials: [] }, async ({ mount, h }) => {
      await h.settle();
      const link = mount.querySelector('a[href^="https://permanentlightingdirect.ca"]');
      return {
        text: mount.textContent,
        href: link ? link.getAttribute('href') : null,
        rel: link ? link.getAttribute('rel') : null
      };
    });
    assert.match(out.text, /No parts in the catalogue yet/);
    assert.match(out.text, /never been read by this app/,
      'the operator has to know the numbers are theirs to enter, not imported');
    assert.equal(out.href, 'https://permanentlightingdirect.ca/diy-kits');
    assert.equal(out.rel, 'noopener noreferrer');
  });

  await record('B2 a part with no cost says blank is not free', async () => {
    const { out } = await withInventory({}, async ({ mount, h }) => {
      await h.settle();
      return mount.textContent;
    });
    assert.match(out, /Blank means unknown, not free/);
  });

  await record('B3 parts at or below the reorder point are called out', async () => {
    const { out } = await withInventory({}, async ({ mount, h }) => {
      await h.settle();
      return mount.textContent;
    });
    assert.match(out, /1 part at or below the reorder point/);
  });

  /* --------------------------------------------------- movement signing -- */

  const postedMove = (calls) => calls.filter((c) => c.name === 'postStockMovement');

  await record('C1 "Used on a job: 40" posts a MAGNITUDE plus the reason, never a signed number', async () => {
    const { calls } = await withInventory({}, async ({ mount, h }) => {
      await h.settle();
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE channel'));
      const reason = h.labelled(box, 'Movement');
      reason.value = 'consumed';
      reason.dispatchEvent(new Event('change', { bubbles: true }));
      const amount = h.labelled(box, 'Quantity (linear ft)');
      amount.value = '40';
      h.button(box, 'Post movement').click();
      await h.settle(120);
    });
    const moves = postedMove(calls);
    assert.equal(moves.length, 1);
    // The SERVER signs it. Sending -40 from here would be refused by the
    // database's sign/reason agreement, and sending +40 with no reason
    // would add stock -- so the contract takes a magnitude and a reason.
    assert.equal(moves[0].quantity, 40);
    assert.equal(moves[0].reason, 'consumed');
    assert.equal(moves[0].delta, undefined, 'no signed delta crosses the boundary');
    assert.ok(moves[0].clientOperationId, 'every post carries a replay key');
  });

  await record('C2 a minus typed on a consumption is normalised to a magnitude', async () => {
    const { calls } = await withInventory({}, async ({ mount, h }) => {
      await h.settle();
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE channel'));
      const reason = h.labelled(box, 'Movement');
      reason.value = 'consumed';
      reason.dispatchEvent(new Event('change', { bubbles: true }));
      h.labelled(box, 'Quantity (linear ft)').value = '-40';
      h.button(box, 'Post movement').click();
      await h.settle(120);
    });
    assert.equal(postedMove(calls)[0].quantity, 40,
      'the reason already says which way it goes; a typed minus must not double-negate');
    assert.equal(postedMove(calls)[0].reason, 'consumed');
  });

  await record('C3 a CORRECTION keeps the sign typed, so stock can be taken off by hand', async () => {
    const { calls } = await withInventory({}, async ({ mount, h }) => {
      await h.settle();
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE channel'));
      const reason = h.labelled(box, 'Movement');
      reason.value = 'adjustment';
      reason.dispatchEvent(new Event('change', { bubbles: true }));
      h.labelled(box, 'Quantity (linear ft)').value = '-7';
      h.button(box, 'Post movement').click();
      await h.settle(120);
    });
    const moves = postedMove(calls);
    assert.equal(moves[0].quantity, -7,
      'a correction is the one case that carries its own sign -- forcing one ' +
      'here would make a negative correction impossible to enter');
    assert.equal(moves[0].reason, 'adjustment');
  });

  await record('C4 a zero quantity is refused without a write', async () => {
    const { calls } = await withInventory({}, async ({ mount, h }) => {
      await h.settle();
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE channel'));
      h.labelled(box, 'Quantity (linear ft)').value = '0';
      h.button(box, 'Post movement').click();
      await h.settle(120);
    });
    assert.equal(postedMove(calls).length, 0);
  });

  await record('C5 "Received" is NOT offered by hand -- a receipt belongs to a purchase order', async () => {
    const { out } = await withInventory({}, async ({ mount, h }) => {
      await h.settle();
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE channel'));
      return [...h.labelled(box, 'Movement').options].map((o) => o.value);
    });
    assert.ok(!out.includes('received'),
      'a hand-entered receipt would skip the pack conversion the PO path applies');
    assert.ok(out.includes('consumed') && out.includes('adjustment') && out.includes('opening'));
  });

  await record('C6 the ledger is presented as append-only', async () => {
    const { out } = await withInventory({ moves: [
      { id: 'mv-1', material_id: 'mat-track', delta: 300, reason: 'received',
        occurred_at: '2026-10-01T00:00:00Z', note: null }
    ] }, async ({ mount, h }) => {
      await h.settle();
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE channel'));
      h.button(box, 'Movements').click();
      await h.settle(150);
      return box.textContent;
    });
    assert.match(out, /never edited or deleted/);
    assert.match(out, /\+300/, 'an addition should read as an addition');
  });

  /* ------------------------------------------------ pack <-> unit maths -- */

  await record('D1 receiving 2 packs of 150 posts 300 UNITS and 2 PACKS, each once', async () => {
    const { calls } = await withInventory({ query: 'tab=purchasing' }, async ({ mount, h }) => {
      await h.settle(120);
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE channel'));
      h.labelled(box, 'Packs arriving').value = '2';
      h.button(box, 'Receive').click();
      await h.settle(150);
    });
    const lineUpdate = calls.find((c) => c.name === 'updatePurchaseOrderLine');
    const move = calls.find((c) => c.name === 'postStockMovement');
    assert.ok(lineUpdate, 'the order line must record the receipt');
    assert.equal(lineUpdate.patch.packs_received, 3, '1 already received + 2 now, in PACKS');
    assert.ok(move, 'and the shelf must be credited');
    assert.equal(move.quantity, 300, '2 packs x 150 linear ft, converted exactly once');
    assert.equal(move.reason, 'received');
    assert.equal(move.locationCode, 'base', 'a delivery arrives at Base, not in a car');
    assert.equal(move.purchaseOrderId, 'po-1');
  });

  await record('D2 the outstanding balance is shown in packs, not units', async () => {
    const { out } = await withInventory({ query: 'tab=purchasing' }, async ({ mount, h }) => {
      await h.settle(120);
      return mount.textContent;
    });
    assert.match(out, /3 outstanding/, '4 ordered - 1 received');
    assert.match(out, /pack\(s\) of 150 linear ft/);
  });

  await record('D3 receiving MORE than outstanding asks before posting', async () => {
    lastDialog = null;
    const { calls } = await withInventory({ query: 'tab=purchasing' }, async ({ mount, h }) => {
      await h.settle(120);
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE channel'));
      h.labelled(box, 'Packs arriving').value = '9';
      h.button(box, 'Receive').click();
      await h.settle(150);
    });
    assert.match(String(lastDialog), /more than the 3 pack\(s\) still outstanding/);
    // The dialog handler accepts, so it still posts -- the point is that it
    // asked rather than silently over-receiving.
    assert.ok(calls.some((c) => c.name === 'postStockMovement'));
  });

  await record('D4 marking an un-ordered draft "ordered" supplies ordered_at, which the CHECK demands', async () => {
    const draft = [{ ...ORDERS[0], id: 'po-draft', status: 'draft', ordered_at: null,
                     ns_purchase_order_lines: [] }];
    const { calls } = await withInventory({ query: 'tab=purchasing', orders: draft },
      async ({ mount, h }) => {
        await h.settle(120);
        const card = [...mount.querySelectorAll('.card')]
          .find((c) => (c.textContent || '').includes('FX-PO-1'));
        h.button(card, 'Mark ordered').click();
        await h.settle(150);
      });
    const call = calls.find((c) => c.name === 'updatePurchaseOrder');
    assert.ok(call);
    assert.equal(call.patch.status, 'ordered');
    assert.ok(call.patch.ordered_at, 'without this the database rejects the click as a CHECK violation');
  });

  await record('D5 an order total excluding unpriced lines says so', async () => {
    const withUnpriced = [{
      ...ORDERS[0],
      ns_purchase_order_lines: [
        ORDERS[0].ns_purchase_order_lines[0],
        { id: 'pol-2', purchase_order_id: 'po-1', material_id: 'mat-wire',
          packs_ordered: 1, packs_received: 0, unit_cost: null, sort_order: 2,
          ns_materials: { id: 'mat-wire', name: 'FIXTURE wire', unit: 'linear_ft',
                          pack_quantity: 500, unit_cost: null } }
      ]
    }];
    const { out } = await withInventory({ query: 'tab=purchasing', orders: withUnpriced },
      async ({ mount, h }) => { await h.settle(120); return mount.textContent; });
    assert.match(out, /Estimated order value/);
    assert.match(out, /the real total is higher/,
      'a total that quietly omits unpriced lines reads as complete');
  });

  /* ------------------------------------------------------ waste factors -- */

  await record('E1 a waste allowance typed as 8 is stored as 0.08', async () => {
    const { calls } = await withInventory({ query: 'tab=mapping' }, async ({ mount, h }) => {
      await h.settle(120);
      const input = h.labelled(mount, 'Waste %');
      input.value = '12';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await h.settle(150);
    });
    const call = calls.find((c) => c.name === 'updateServiceMaterialUsage');
    assert.ok(call, 'the edit must save');
    assert.equal(call.patch.waste_factor, 0.12,
      'the column is capped at 1.0, so storing 12 is both rejected and a 1200% allowance');
  });

  await record('E2 an existing 0.08 is shown as 8, not 0.08', async () => {
    const { out } = await withInventory({ query: 'tab=mapping' }, async ({ mount, h }) => {
      await h.settle(120);
      return h.labelled(mount, 'Waste %').value;
    });
    assert.equal(out, '8');
  });

  await record('E3 a waste allowance above 100 is refused without a write', async () => {
    const { calls } = await withInventory({ query: 'tab=mapping' }, async ({ mount, h }) => {
      await h.settle(120);
      const input = h.labelled(mount, 'Waste %');
      input.value = '150';
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await h.settle(150);
      return input.value;
    });
    assert.equal(calls.filter((c) => c.name === 'updateServiceMaterialUsage').length, 0);
  });

  await record('E4 a service nothing is mapped to is reported as unmapped, not as needing nothing', async () => {
    const { out } = await withInventory({ query: 'tab=mapping' }, async ({ mount, h }) => {
      await h.settle(120);
      return mount.textContent;
    });
    assert.match(out, /consume nothing yet/);
    assert.match(out, /Christmas Lighting/);
    assert.match(out, /Jump Wire/);
  });

  /* The seasonal-set section that used to live here has moved to
     tests/phase24.test.mjs, with its cases rewritten for the Batch 9.1
     model. They were not simply ported: they asserted a status field that
     mixed "where is the set" with "who has it", and browser writes that no
     longer exist. */


  /* ------------------------------------------------- job materials panel -- */

  await record('G1 the estimate is NOT fetched when the job screen renders', async () => {
    const { calls, out } = await withJobMaterials({}, async ({ mount }) => mount.textContent);
    assert.equal(calls.filter((c) => c.name === 'estimateJobMaterials').length, 0,
      'every job-screen visit would otherwise pay for a four-table aggregate');
    assert.match(out, /Not calculated yet/);
  });

  await record('G2 it is fetched once the operator asks, and reports shortfall in packs', async () => {
    const { calls, out } = await withJobMaterials({}, async ({ mount, h }) => {
      h.button(mount, 'Work out materials').click();
      await h.settle(200);
      return mount.textContent;
    });
    assert.equal(calls.filter((c) => c.name === 'estimateJobMaterials').length, 1);
    assert.match(out, /150 short · 1 pack\(s\)/);
    assert.match(out, /1 part short of what this job needs/);
  });

  await record('G3 the derivation is shown, so a quantity can be checked rather than trusted', async () => {
    const { out } = await withJobMaterials({}, async ({ mount, h }) => {
      h.button(mount, 'Work out materials').click();
      await h.settle(200);
      return mount.textContent;
    });
    assert.match(out, /200 linear ft × 1 \+ 8% waste/);
  });

  await record('G4 a requirement from a review-flagged measurement says it is unconfirmed', async () => {
    const { out } = await withJobMaterials({}, async ({ mount, h }) => {
      h.button(mount, 'Work out materials').click();
      await h.settle(200);
      return mount.textContent;
    });
    assert.match(out, /flagged for review/);
  });

  await record('G5 unmapped services are named and explained, not omitted', async () => {
    const { out } = await withJobMaterials({}, async ({ mount, h }) => {
      h.button(mount, 'Work out materials').click();
      await h.settle(200);
      return mount.textContent;
    });
    assert.match(out, /Christmas Lighting \(90 linear ft\)/);
    assert.match(out, /not the same as needing no parts/);
  });

  await record('G6 the cost basis is labelled a purchasing cost and flags the parts it omits', async () => {
    const { out } = await withJobMaterials({}, async ({ mount, h }) => {
      h.button(mount, 'Work out materials').click();
      await h.settle(200);
      return mount.textContent;
    });
    assert.match(out, /Material cost basis/);
    assert.match(out, /not a price/);
    assert.match(out, /excludes 1 part\(s\) with no cost recorded/,
      'an unknown cost must never be totalled as zero');
  });

  await record('G7 "Take off stock" posts a NEGATIVE consumed movement against this job', async () => {
    const { calls } = await withJobMaterials({}, async ({ mount, h }) => {
      h.button(mount, 'Work out materials').click();
      await h.settle(200);
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE channel'));
      h.button(box, 'Take off stock').click();
      await h.settle(200);
    });
    const move = calls.find((c) => c.name === 'postStockMovement');
    assert.ok(move);
    assert.equal(move.quantity, 216, 'the estimate, as the pre-filled default');
    assert.equal(move.reason, 'consumed');
    assert.equal(move.jobId, 'job-1', 'so the movement can be traced back to the job');
    assert.equal(move.locationCode, 'base', 'the default basis is everywhere, so it comes off Base');
  });

  await record('G8 an edited usage is what gets posted, not the estimate', async () => {
    const { calls } = await withJobMaterials({}, async ({ mount, h }) => {
      h.button(mount, 'Work out materials').click();
      await h.settle(200);
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE channel'));
      h.labelled(box, 'Used on this job (linear ft)').value = '190';
      h.button(box, 'Take off stock').click();
      await h.settle(200);
    });
    assert.equal(calls.find((c) => c.name === 'postStockMovement').quantity, 190,
      'real usage is rarely exactly the estimate, which is why the field is editable');
  });

  await record('G9 a positive figure typed into "used" cannot add stock', async () => {
    const { calls } = await withJobMaterials({}, async ({ mount, h }) => {
      h.button(mount, 'Work out materials').click();
      await h.settle(200);
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE channel'));
      h.labelled(box, 'Used on this job (linear ft)').value = '25';
      h.button(box, 'Take off stock').click();
      await h.settle(200);
    });
    const move = calls.find((c) => c.name === 'postStockMovement');
    assert.equal(move.quantity, 25);
    assert.equal(move.reason, 'consumed',
      'the reason is what makes it a subtraction; no sign is sent from here');
  });

  await record('G10 taking stock off asks first, and says a correction is how it is undone', async () => {
    lastDialog = null;
    await withJobMaterials({}, async ({ mount, h }) => {
      h.button(mount, 'Work out materials').click();
      await h.settle(200);
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE channel'));
      h.button(box, 'Take off stock').click();
      await h.settle(200);
    });
    assert.match(String(lastDialog), /off Base for this job/);
    assert.match(String(lastDialog), /posting a correction, not by deleting it/);
  });

  await record('G11 a failed estimate says so and can be retried', async () => {
    const { out } = await withJobMaterials({ estimateFails: true }, async ({ mount, h }) => {
      h.button(mount, 'Work out materials').click();
      await h.settle(200);
      return {
        text: mount.textContent,
        hasRetry: !!h.button(mount, 'Recalculate') || !!h.button(mount, 'Work out materials')
      };
    });
    assert.match(out.text, /Network unreachable/);
    assert.equal(out.hasRetry, true, 'a dead end here leaves the operator with no way forward');
  });

  await record('G12 an empty job reports nothing to work out, not an empty success', async () => {
    const empty = { ...ESTIMATE, lines: [], unmapped_services: [] };
    const { out } = await withJobMaterials({ estimate: empty }, async ({ mount, h }) => {
      h.button(mount, 'Work out materials').click();
      await h.settle(200);
      return mount.textContent;
    });
    assert.match(out, /nothing to work out/);
  });

  /* ----------------------------------------------- failure handling, UI -- */

  await record('H1 a failed movement keeps the typed value and does not clear the form', async () => {
    const { out } = await withInventory({ failNext: 1 }, async ({ mount, h }) => {
      await h.settle();
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE channel'));
      const amount = h.labelled(box, 'Quantity (linear ft)');
      amount.value = '40';
      h.button(box, 'Post movement').click();
      await h.settle(200);
      const toast = document.getElementById('toast');
      return { value: amount.value, toast: toast ? toast.textContent : null };
    });
    assert.equal(out.value, '40',
      'clearing the box on failure loses the number and reads as success');
    assert.match(String(out.toast), /not saved|unreachable/i);
  });

  await record('H2 the screen says plainly that nothing here affects pricing', async () => {
    const { out } = await withInventory({}, async ({ mount, h }) => {
      await h.settle();
      return mount.textContent;
    });
    assert.match(out, /Nothing here affects quote pricing/);
  });

  /* ------------------------------------------- locations and transfers -- */

  await record('J1 per-location balances lead with AVAILABLE, not on hand', async () => {
    const { out } = await withInventory({}, async ({ mount, h }) => {
      await h.settle(150);
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE channel'));
      return box.textContent;
    });
    // 200 on hand, 60 committed, 15 damaged. A screen that printed on_hand
    // would say 200 and be wrong about what can be promised.
    assert.match(out, /Base: 140 linear ft free/,
      '"what can we commit" is the question a plan asks; a single total gets it wrong');
    assert.match(out, /60 reserved/);
    assert.match(out, /200 on hand/, 'the physical figure is still there, just not the headline');
    assert.match(out, /15 damaged/, 'damaged stock is owned and recorded, never offered');
    assert.match(out, /Car A: 50 linear ft free/,
      'a single total never answers "is it in the car"');
  });

  await record('J1b a balance an ESTIMATE touched says so', async () => {
    const { out } = await withInventory({}, async ({ mount, h }) => {
      await h.settle(150);
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE channel'));
      return box.textContent;
    });
    assert.match(out, /estimated count, so treat this as approximate/);
  });

  await record('J1c a level-tracked supply shows Empty/Low/Enough and NO number', async () => {
    const { out } = await withInventory({}, async ({ mount, h }) => {
      await h.settle(150);
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE rags'));
      return { text: box.textContent, buttons: h.buttonTexts(box) };
    });
    assert.match(out.text, /Low/);
    // Tightened after a false positive: the first version matched the word
    // "free" in the unit-cost hint ("Blank means unknown, not free"), not a
    // quantity. What must be absent is a BALANCE, so look for the shapes a
    // balance actually takes.
    for (const forbidden of [/\d+\s+(linear ft|each|L|kg|sticks?)\s+free/,
                             /\d+\s+on hand/, /\d+\s+reserved/, /\d+\s+damaged/,
                             /Reorder at/, /Pack size/]) {
      assert.ok(!forbidden.test(out.text),
        `showing ${forbidden} would invite somebody to plan against a number: ${out.text.slice(0, 120)}`);
    }
    for (const b of ['Empty', 'Low', 'Enough']) assert.ok(out.buttons.includes(b));
    assert.ok(!out.buttons.includes('Post movement'),
      'a level-tracked supply has no quantity to move');
  });

  await record('J1d setting a level records the observation', async () => {
    const { calls } = await withInventory({}, async ({ mount, h }) => {
      await h.settle(150);
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE rags'));
      h.button(box, 'Empty').click();
      await h.settle(200);
    });
    const call = calls.find((c) => c.name === 'setMaterialLevel');
    assert.ok(call);
    assert.equal(call.state, 'empty');
    assert.equal(call.locationId, 'loc-base');
  });

  await record('J1e committing stock reserves it rather than moving it', async () => {
    const { calls } = await withInventory({}, async ({ mount, h }) => {
      await h.settle(150);
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE channel'));
      h.labelled(box, 'Quantity to commit (linear ft)').value = '40';
      h.button(box, 'Commit').click();
      await h.settle(200);
    });
    const call = calls.find((c) => c.name === 'reserveStock');
    assert.ok(call, 'the commitment must be sent');
    assert.equal(call.quantity, 40);
    assert.equal(call.locationCode, 'base');
    assert.ok(call.clientOperationId, 'a commitment is replay-safe like every other operation');
    assert.equal(calls.filter((c) => c.name === 'postStockMovement').length, 0,
      'committing is not a movement -- nothing has physically moved');
  });

  await record('J1f committing more than is FREE is refused before the round trip', async () => {
    const { calls, out } = await withInventory({}, async ({ mount, h }) => {
      await h.settle(150);
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE channel'));
      // 140 free at Base, not 200: 60 is already committed.
      h.labelled(box, 'Quantity to commit (linear ft)').value = '180';
      h.button(box, 'Commit').click();
      await h.settle(200);
      const toast = document.getElementById('toast');
      return toast ? toast.textContent : null;
    });
    assert.equal(calls.filter((c) => c.name === 'reserveStock').length, 0);
    assert.match(String(out), /Only 140 linear ft free/);
  });

  await record('J1g an existing commitment is listed and can be released', async () => {
    const { calls, out } = await withInventory({}, async ({ mount, h }) => {
      await h.settle(150);
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE channel'));
      const text = box.textContent;
      h.button(box, 'Release').click();
      await h.settle(200);
      return text;
    });
    assert.match(out, /60 linear ft/);
    const call = calls.find((c) => c.name === 'releaseStockReservation');
    assert.ok(call);
    assert.equal(call.reservationId, 'res-1');
  });

  await record('J1h a movement can be posted as damaged or estimated', async () => {
    const { calls } = await withInventory({}, async ({ mount, h }) => {
      await h.settle(150);
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE channel'));
      const cond = h.labelled(box, 'Condition');
      cond.value = 'damaged';
      cond.dispatchEvent(new Event('change', { bubbles: true }));
      const prec = h.labelled(box, 'Count');
      prec.value = 'estimated';
      prec.dispatchEvent(new Event('change', { bubbles: true }));
      h.labelled(box, 'Quantity (linear ft)').value = '12';
      h.button(box, 'Post movement').click();
      await h.settle(200);
    });
    const move = postedMove(calls)[0];
    assert.equal(move.condition, 'damaged');
    assert.equal(move.countPrecision, 'estimated');
  });

  await record('J2 a movement names WHERE it happened', async () => {
    const { calls } = await withInventory({}, async ({ mount, h }) => {
      await h.settle(150);
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE channel'));
      const where = h.labelled(box, 'Where');
      where.value = 'car_a';
      where.dispatchEvent(new Event('change', { bubbles: true }));
      h.labelled(box, 'Quantity (linear ft)').value = '5';
      h.button(box, 'Post movement').click();
      await h.settle(150);
    });
    assert.equal(postedMove(calls)[0].locationCode, 'car_a',
      'a movement with no location cannot be reconciled against a shelf or a car');
  });

  await record('J3 a transfer sends two location codes and the confirmation', async () => {
    const { calls } = await withInventory({}, async ({ mount, h }) => {
      await h.settle(150);
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE channel'));
      h.button(box, 'Move').click();
      await h.settle(100);
      h.labelled(box, 'From').value = 'base';
      h.labelled(box, 'To').value = 'car_a';
      const qtyInput = h.labelled(box, 'Quantity to move (linear ft)');
      qtyInput.value = '40';
      const check = box.querySelector('input[type="checkbox"]');
      check.checked = true;
      check.dispatchEvent(new Event('change', { bubbles: true }));
      h.button(box, 'Transfer').click();
      await h.settle(200);
    });
    const xf = calls.find((c) => c.name === 'postStockTransfer');
    assert.ok(xf, 'the transfer must actually be sent');
    assert.equal(xf.quantity, 40);
    assert.equal(xf.fromLocationCode, 'base');
    assert.equal(xf.toLocationCode, 'car_a');
    assert.equal(xf.confirmedPhysical, true);
    assert.ok(xf.clientOperationId);
  });

  await record('J3b the move panel is collapsed until asked for', async () => {
    const { out } = await withInventory({}, async ({ mount, h }) => {
      await h.settle(150);
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE channel'));
      return { before: !!h.button(box, 'Transfer'), texts: h.buttonTexts(box) };
    });
    assert.equal(out.before, false,
      'both forms open put every card past 6000px at 390px wide');
    assert.ok(out.texts.includes('Move'));
  });

  await record('J4 an UNCONFIRMED transfer is not sent at all', async () => {
    const { calls } = await withInventory({}, async ({ mount, h }) => {
      await h.settle(150);
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE channel'));
      h.button(box, 'Move').click();
      await h.settle(100);
      const qtyInput = h.labelled(box, 'Quantity to move (linear ft)');
      qtyInput.value = '10';
      h.button(box, 'Transfer').click();
      await h.settle(200);
    });
    assert.equal(calls.filter((c) => c.name === 'postStockTransfer').length, 0,
      'stock does not move until somebody says the goods moved');
  });

  await record('J5 transferring more than the SOURCE holds is refused before the round trip', async () => {
    const { calls, out } = await withInventory({}, async ({ mount, h }) => {
      await h.settle(150);
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE channel'));
      h.button(box, 'Move').click();
      await h.settle(100);
      h.labelled(box, 'From').value = 'car_a';
      h.labelled(box, 'From').dispatchEvent(new Event('change', { bubbles: true }));
      const qtyInput = h.labelled(box, 'Quantity to move (linear ft)');
      qtyInput.value = '200';
      const check = box.querySelector('input[type="checkbox"]');
      check.checked = true;
      check.dispatchEvent(new Event('change', { bubbles: true }));
      h.button(box, 'Transfer').click();
      await h.settle(200);
      const toast = document.getElementById('toast');
      return { text: box.textContent, toast: toast ? toast.textContent : null };
    });
    assert.equal(calls.filter((c) => c.name === 'postStockTransfer').length, 0,
      'the server refuses it anyway; catching it here is what stops the ' +
      'operator discovering it at the end instead of the start');
    assert.match(String(out.toast), /Only 50 linear ft there/);
    assert.match(out.text, /50 linear ft at Car A/,
      'the source balance has to be visible next to the field');
  });

  await record('J6 the job panel asks for a stock basis and says which one it used', async () => {
    const { calls, out } = await withJobMaterials({}, async ({ mount, h }) => {
      h.button(mount, 'Work out materials').click();
      await h.settle(250);
      const basis = h.labelled(mount, 'Stock counted');
      const before = mount.textContent;
      basis.value = 'car_a';
      basis.dispatchEvent(new Event('change', { bubbles: true }));
      await h.settle(250);
      return { before, after: mount.textContent };
    });
    const estimates = calls.filter((c) => c.name === 'estimateJobMaterials');
    assert.equal(estimates.length, 2);
    assert.equal(estimates[0].locationCode, null, 'the default basis is every location');
    assert.equal(estimates[1].locationCode, 'car_a');
    assert.match(out.before, /count every location/,
      'a figure that counts stock a crew cannot reach must say so');
    assert.match(out.after, /count Car A plus Base/);
  });

  await record('J7 a vehicle basis takes the consumption off that vehicle', async () => {
    const { calls } = await withJobMaterials({}, async ({ mount, h }) => {
      h.button(mount, 'Work out materials').click();
      await h.settle(250);
      const basis = h.labelled(mount, 'Stock counted');
      basis.value = 'car_a';
      basis.dispatchEvent(new Event('change', { bubbles: true }));
      await h.settle(250);
      const box = [...mount.querySelectorAll('.section-box')]
        .find((b) => (b.textContent || '').includes('FIXTURE channel'));
      h.button(box, 'Take off stock').click();
      await h.settle(250);
    });
    const move = calls.find((c) => c.name === 'postStockMovement');
    assert.equal(move.locationCode, 'car_a',
      'consuming from the wrong location only shows up at the end-of-day count');
  });

  /* ------------------------------------------- the pure conversions ----- */
  /* Imported from the real module inside the page, un-mocked, so these
     break if the shipped arithmetic breaks. */

  const math = (bodySrc) => page.evaluate(async (src) => {
    const m = await import('/admin/js/lib/inventory-math.js');
    // eslint-disable-next-line no-new-func
    return new Function(`return (${src})`)()(m);
  }, bodySrc.toString());

  await record('I1 packsToUnits multiplies by the pack size, exactly once', async () => {
    const out = await math((m) => [
      m.packsToUnits({ pack_quantity: 150 }, 2),
      m.packsToUnits({ pack_quantity: 500 }, 1),
      m.packsToUnits({ pack_quantity: 1 }, 7)
    ]);
    assert.deepEqual(out, [300, 500, 7]);
  });

  await record('I2 a missing pack size falls back to 1, never NaN', async () => {
    const out = await math((m) => [
      m.packsToUnits({}, 3),
      m.packsToUnits(undefined, 3),
      m.packsToUnits({ pack_quantity: 0 }, 3),
      m.packsToUnits({ pack_quantity: 'abc' }, 3),
      m.packsToUnits({ pack_quantity: 150 }, 'abc')
    ]);
    assert.deepEqual(out, [3, 3, 3, 3, 0],
      'a NaN here would poison every later sum of the ledger');
  });

  await record('I3 packsForShortfall rounds UP and never returns a negative order', async () => {
    const out = await math((m) => [
      m.packsForShortfall({ pack_quantity: 500 }, 150),
      m.packsForShortfall({ pack_quantity: 150 }, 366),
      m.packsForShortfall({ pack_quantity: 150 }, 150),
      m.packsForShortfall({ pack_quantity: 150 }, 0),
      m.packsForShortfall({ pack_quantity: 150 }, -40)
    ]);
    assert.deepEqual(out, [1, 3, 1, 0, 0]);
  });

  await record('I4 signedDelta overrides a typed sign except for a correction', async () => {
    const out = await math((m) => [
      m.signedDelta(-1, 40), m.signedDelta(-1, -40),
      m.signedDelta(+1, 40), m.signedDelta(+1, -40),
      m.signedDelta(0, -7),  m.signedDelta(0, 7),
      m.signedDelta(-1, 0),  m.signedDelta(-1, 'abc')
    ]);
    assert.deepEqual(out, [-40, -40, 40, 40, -7, 7, 0, 0],
      'a forced sign on a correction would make a negative correction unenterable');
  });

  await browser.close();
  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.ok ? '' : `\n     ${r.err}`}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
})();
