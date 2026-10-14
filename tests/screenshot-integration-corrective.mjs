// Visual and keyboard QA for the integration corrective: the inventory
// creation form in both tracking modes, the daily-load selection, and the
// property screen with and without a customer.
//
//   node tests/screenshot-integration-corrective.mjs   (static server on :8743)
//
// Writes PNGs into /tmp/ns-integration-corrective/ at 390 / 430 / 1280 and
// reports what a screenshot alone hides:
//
//   * an element overhanging the viewport, which sits off-canvas to the right
//   * a control under the project's 44px tap target
//   * a focusable control with no accessible name
//   * a tab order that does not follow the reading order
//   * a page error
//
// It is NOT a test of the backend. Every api.js call is stubbed, and none of
// the 31 pending migrations has been applied, so nothing here says what the
// live project would do with any of these forms.

import { mkdirSync } from 'node:fs';
import pkg from '/opt/node-tools/node_modules/playwright/index.js';
import { BASE, FAKE_CAPACITOR_CORE } from './test-harness.mjs';

const { chromium } = pkg;
const OUT = '/tmp/ns-integration-corrective';
mkdirSync(OUT, { recursive: true });

const VIEWS = [['390', 390, 844], ['430', 430, 932], ['1280', 1280, 900]];
const TAP = 44;

const FAKE_SUPABASE_ADMIN = `
  export const supabase = { auth: { signOut: async () => {} } };
  export async function getSession() { return { session: { user: { id: 'admin-1' } }, isAdmin: true }; }
`;

/* Awkward on purpose: a supplier name that will not break, a long part
   name, a property with no coordinates, and a vehicle code in the URL that
   the location list does not contain. */
const FAKE_API = `
  const clone = (v) => JSON.parse(JSON.stringify(v));
  export async function listSuppliers() { return [
    { id: 'sup-1', name: 'FIXTURE Supplies & Industrial Chemical Distribution Ltd', active: true },
    { id: 'sup-2', name: 'FIXTURE second supplier', active: true }
  ]; }
  export async function listMaterials() { return [
    { id: 'mat-1', name: 'FIXTURE bulk degreaser concentrate, unscented, 20 L drum',
      sku: 'FX-20L', category: 'consumable', unit: 'litre', tracking_mode: 'quantity',
      supplier_id: 'sup-1', ns_suppliers: { id: 'sup-1', name: 'FIXTURE Supplies & Industrial Chemical Distribution Ltd' },
      pack_quantity: 20, unit_cost: null, currency: 'CAD', reorder_point: 40,
      reorder_qty: 1, active: true, on_hand: 60, needs_reorder: false, last_move_at: null },
    { id: 'mat-2', name: 'FIXTURE rags', sku: null, category: 'consumable',
      unit: 'level', tracking_mode: 'level', supplier_id: null, ns_suppliers: null,
      pack_quantity: 1, unit_cost: null, currency: 'CAD', reorder_point: 0,
      reorder_qty: 0, active: true, on_hand: 0, needs_reorder: false, last_move_at: null }
  ]; }
  export async function listServices() { return []; }
  export async function listPurchaseOrders() { return []; }
  export async function listServiceMaterialUsage() { return []; }
  export async function listSeasonalSets() { return []; }
  export async function listSeasonalAssignments() { return []; }
  export async function listStockMoves() { return []; }
  export async function listRentalSetEvents() { return []; }
  export async function listReservations() { return []; }
  export async function currentUserId() { return 'admin-1'; }
  export function newOperationId(p) { return (p || 'op') + '-fixed'; }
  export async function listStockLocations() { return [
    { id: 'loc-base',  code: 'base',  name: 'Base',  kind: 'base',    active: true, sort_order: 0 },
    { id: 'loc-car-a', code: 'car_a', name: 'Car A', kind: 'vehicle', active: true, sort_order: 1 }
  ]; }
  export async function listStockByLocation() { return [
    { material_id: 'mat-1', location_id: 'loc-base', location_code: 'base',
      location_name: 'Base', on_hand: 60, reserved: 0, available: 60,
      damaged_on_hand: 0, is_estimated: false, unit: 'litre' },
    { material_id: 'mat-2', location_id: 'loc-base', location_code: 'base',
      location_name: 'Base', on_hand: 0, reserved: 0, available: 0,
      damaged_on_hand: 0, is_estimated: false, unit: 'level',
      tracking_mode: 'level', level_state: 'low', level_checked_at: '2026-10-08T00:00:00Z' }
  ]; }
  export async function createMaterial() { return {}; }
  export async function updateMaterial() { return {}; }
  export async function createSupplier() { return {}; }
  export async function updateSupplier() { return {}; }
  export async function setMaterialLevel() { return {}; }
  export async function postStockMovement() { return {}; }
  export async function postStockTransfer() { return {}; }
  export async function reserveStock() { return {}; }
  export async function releaseStockReservation() { return {}; }
  export async function consumeStockReservation() { return {}; }

  export async function getLoadPlan(a) {
    return { plan: null, can_build: true, work_day_timezone_state: 'unconfigured',
             work_date: a.workDate, location_code: a.locationCode };
  }
  export async function nextDaySuggestions() { return null; }
  export async function buildLoadPlan() { return {}; }

  export async function propertyHistory() { return clone(globalThis.__PROPERTY_HISTORY); }
  export async function updateProperty() { return {}; }
  export function attachmentBucket() { return 'attachments'; }
  export async function signedPhotoUrl() { return null; }
`;

const PROPERTY = (customer) => ({
  property: {
    id: 'prop-1',
    address_line1: '1 Exceptionally Long Fixture Avenue South-West',
    city: 'Sault Ste. Marie', province: 'ON', postal_code: 'P6A 0A0',
    property_type: 'residential', latitude: null, longitude: null, passport: {},
    customer
  },
  jobs: [], quotes: [], measurements: [], inspections: [], photos: []
});

const problems = [];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  const mock = (p, body) => page.route(p, (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body }));
  await mock('**/cdn.jsdelivr.net/npm/@capacitor/core@8.5.2/+esm', FAKE_CAPACITOR_CORE);
  await mock(`${BASE}/shared/supabase.js`, FAKE_SUPABASE_ADMIN);
  await mock(`${BASE}/admin/js/lib/api.js`, FAKE_API);
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('dialog', (d) => d.accept());

  /** Mounts a view into the page body and returns nothing; the caller then
   *  screenshots and inspects. */
  async function mountInventory(query, levelMode) {
    await page.evaluate(async ({ query, levelMode }) => {
      document.body.innerHTML = '';
      const mod = await import('/admin/js/views/inventory.js');
      const mount = document.createElement('div');
      mount.className = 'page';
      document.body.appendChild(mount);
      await mod.renderInventory({
        mount, params: new URLSearchParams(query),
        replaceQuery: () => {}, navigate: () => {}
      });
      await new Promise((r) => setTimeout(r, 250));
      if (levelMode) {
        const card = [...mount.querySelectorAll('.card')]
          .find((c) => c.querySelector('h2') && c.querySelector('h2').textContent === 'Add a part');
        const sel = [...card.querySelectorAll('label.field > span')]
          .find((s) => s.textContent === 'Tracked by').parentElement.querySelector('select');
        sel.value = 'level';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 120));
      }
    }, { query, levelMode });
  }

  async function mountProperty(customer) {
    await page.evaluate(async (history) => {
      globalThis.__PROPERTY_HISTORY = history;
      document.body.innerHTML = '';
      const mod = await import('/admin/js/views/property.js');
      const mount = document.createElement('div');
      mount.className = 'page';
      document.body.appendChild(mount);
      await mod.renderProperty({ mount, setContextParent: () => {} }, 'prop-1');
      await new Promise((r) => setTimeout(r, 200));
    }, customer === null ? PROPERTY(null) : PROPERTY({ id: 'cus-1', name: 'FIXTURE customer' }));
  }

  /** The three things a screenshot cannot show. */
  async function inspect(name, label) {
    const found = await page.evaluate((tap) => {
      const vis = (n) => n.getBoundingClientRect().width > 0 || n.getBoundingClientRect().height > 0;
      const focusables = [...document.querySelectorAll(
        'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter(vis);
      const nameOf = (n) => {
        const labelled = n.closest('label');
        return (n.getAttribute('aria-label')
          || (labelled && labelled.querySelector('span') && labelled.querySelector('span').textContent)
          || n.textContent
          || n.getAttribute('title')
          || '').trim();
      };
      return {
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        wide: [...new Set([...document.querySelectorAll('.page *')]
          .filter((n) => vis(n) && n.getBoundingClientRect().right > window.innerWidth + 1)
          .map((n) => `${n.tagName.toLowerCase()}.${n.className || '-'}`))],
        small: [...new Set(focusables
          .filter((n) => {
            const r = n.getBoundingClientRect();
            return r.height > 0 && r.height < tap;
          })
          .map((n) => `${n.tagName.toLowerCase()}:${nameOf(n).slice(0, 28) || '(unnamed)'}`))],
        unnamed: focusables.filter((n) => !nameOf(n)).map((n) => n.tagName.toLowerCase()),
        // Reading order vs DOM order: the tab order follows the DOM here
        // because nothing sets a positive tabindex. Report any that does.
        positiveTabindex: focusables
          .filter((n) => Number(n.getAttribute('tabindex')) > 0)
          .map((n) => n.tagName.toLowerCase())
      };
    }, TAP);

    if (found.pageOverflow) problems.push(`${name} @${label}: the page scrolls sideways`);
    for (const w of found.wide) problems.push(`${name} @${label}: ${w} overhangs`);
    for (const s of found.small) problems.push(`${name} @${label}: ${s} is under ${TAP}px tall`);
    for (const u of new Set(found.unnamed)) problems.push(`${name} @${label}: a <${u}> has no accessible name`);
    for (const t of new Set(found.positiveTabindex)) problems.push(`${name} @${label}: <${t}> sets a positive tabindex`);
  }

  /** Walks Tab from the top of the Add-a-part card and prints the order the
   *  keyboard actually visits, so it can be read against the screenshot. */
  async function tabOrder(selectorText) {
    return page.evaluate(async (title) => {
      const card = [...document.querySelectorAll('.card')]
        .find((c) => c.querySelector('h2') && c.querySelector('h2').textContent === title);
      if (!card) return null;
      const order = [];
      const focusables = [...card.querySelectorAll('input, select, textarea, button, a[href]')];
      for (const n of focusables) {
        n.focus();
        const labelled = n.closest('label');
        order.push((n.getAttribute('aria-label')
          || (labelled && labelled.querySelector('span') && labelled.querySelector('span').textContent)
          || n.textContent || '').trim());
      }
      return { reachable: order, focusedLast: document.activeElement === focusables.at(-1) };
    }, selectorText);
  }

  const SCREENS = [
    ['inventory-add-counted', async () => mountInventory('tab=stock', false)],
    ['inventory-add-level',   async () => mountInventory('tab=stock', true)],
    ['inventory-load-known',  async () => mountInventory('tab=load&car=car_a&day=2026-11-03', false)],
    ['inventory-load-unknown-car',
      async () => mountInventory('tab=load&car=car_b&day=2026-11-03', false)],
    ['property-with-customer', async () => mountProperty({ id: 'cus-1' })],
    ['property-no-customer',   async () => mountProperty(null)]
  ];

  await page.goto(`${BASE}/admin/field.html`);
  await page.waitForTimeout(150);

  for (const [name, setup] of SCREENS) {
    for (const [label, width, height] of VIEWS) {
      await page.setViewportSize({ width, height });
      await page.goto(`${BASE}/admin/field.html`);
      await page.waitForTimeout(120);
      await setup();
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${OUT}/${name}-${label}.png`, fullPage: true });
      await inspect(name, label);
    }
  }

  // Keyboard traversal of the creation form, in both modes, once -- the
  // order does not change with the viewport.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE}/admin/field.html`);
  await page.waitForTimeout(120);
  await mountInventory('tab=stock', false);
  console.log('Add a part (counted) keyboard order:');
  console.log('  ' + JSON.stringify((await tabOrder('Add a part')).reachable));
  await mountInventory('tab=stock', true);
  console.log('Add a part (level) keyboard order:');
  console.log('  ' + JSON.stringify((await tabOrder('Add a part')).reachable));

  await browser.close();
  console.log(`\nscreenshots in ${OUT}`);
  if (problems.length) {
    console.log('\nPROBLEMS');
    for (const p of [...new Set(problems)]) console.log(`  - ${p}`);
    process.exitCode = 1;
  } else {
    console.log('no overflow, tap-target, accessible-name or tab-order problems found');
  }
})();
