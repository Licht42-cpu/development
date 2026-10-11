// Visual QA for Batch 8.1: the Inventory screen's four tabs, plus the
// per-job Materials panel, at 390 / 430 / desktop.
//
//   node tests/screenshot-batch8-1.mjs      (static server must be on :8743)
//
// Writes PNGs into /tmp/ns-batch8-1/ and reports any element overhanging the
// viewport -- the failure a screenshot alone hides, because the overflow sits
// off-canvas to the right. Also checks every control against the project's
// own --tap target and looks for a clipped field caption, which is how the
// `.field > span` specificity trap shows up: a caption nested one level too
// deep loses its styling and collapses.
//
// Fixture content is awkward on purpose: long part names, a null cost, a
// negative on-hand figure, a part short on an order, an unmapped service.

import { mkdirSync } from 'node:fs';
import pkg from '/opt/node-tools/node_modules/playwright/index.js';
import { BASE, FAKE_CAPACITOR_CORE } from './test-harness.mjs';

const { chromium } = pkg;
const OUT = '/tmp/ns-batch8-1';
mkdirSync(OUT, { recursive: true });

const FAKE_SUPABASE_ADMIN = `
  export const supabase = { auth: { signOut: async () => {} } };
  export async function getSession() { return { session: { user: { id: 'admin-1' } }, isAdmin: true }; }
`;

const SUPPLIERS = [{
  id: 'sup-1', name: 'Permanent Lighting Direct',
  website: 'https://permanentlightingdirect.ca/diy-kits', active: true
}];

const MATERIALS = [
  { id: 'mat-track', name: 'FIXTURE aluminium mounting channel, 150 ft roll, white',
    sku: 'FIXTURE-CHANNEL-150-WHT', category: 'track', unit: 'linear_ft',
    supplier_id: 'sup-1', ns_suppliers: SUPPLIERS[0],
    tracking_mode: 'quantity',
    // Batch 9.1 corrective: channel is cut to length, so it has offcuts.
    cuttable: true, stock_length: 150, spec_state: 'reviewed',
    pack_quantity: 150, unit_cost: 2.25, currency: 'CAD',
    reorder_point: 300, reorder_qty: 4, active: true,
    on_hand: -150, needs_reorder: true, last_move_at: '2026-10-01T00:00:00Z' },
  { id: 'mat-wire', name: 'FIXTURE jump wire', sku: null, category: 'wire',
    unit: 'linear_ft', supplier_id: 'sup-1', ns_suppliers: SUPPLIERS[0],
    tracking_mode: 'quantity',
    pack_quantity: 500, unit_cost: null, currency: 'CAD',
    reorder_point: 50, reorder_qty: 1, active: true,
    on_hand: 10, needs_reorder: true, last_move_at: null },
  { id: 'mat-salt', name: 'FIXTURE bagged de-icer', sku: 'FIXTURE-SALT-20',
    category: 'consumable', unit: 'kilogram', tracking_mode: 'quantity',
    supplier_id: 'sup-1', ns_suppliers: SUPPLIERS[0],
    pack_quantity: 20, unit_cost: 0.42, currency: 'CAD',
    reorder_point: 200, reorder_qty: 10, active: true,
    on_hand: 180, needs_reorder: true, last_move_at: '2026-10-07T00:00:00Z' },
  { id: 'mat-rags', name: 'FIXTURE shop rags', sku: null,
    category: 'consumable', unit: 'level', tracking_mode: 'level',
    supplier_id: 'sup-1', ns_suppliers: SUPPLIERS[0],
    pack_quantity: 1, unit_cost: null, currency: 'CAD',
    reorder_point: 0, reorder_qty: 0, active: true,
    on_hand: 0, needs_reorder: false, last_move_at: null },
  { id: 'mat-ctrl', name: 'FIXTURE controller', sku: 'FIXTURE-CTRL-1',
    category: 'controller', unit: 'each', supplier_id: 'sup-1', ns_suppliers: SUPPLIERS[0],
    tracking_mode: 'quantity',
    pack_quantity: 1, unit_cost: 189, currency: 'CAD',
    reorder_point: 2, reorder_qty: 2, active: false,
    on_hand: 5, needs_reorder: false, last_move_at: '2026-09-20T00:00:00Z' }
];

const SERVICES = [
  { id: 'svc-perm', key: 'permanent_lighting', name: 'Permanent Outdoor Lighting',
    unit: 'linear_ft', quotable: true, sort_order: 10 },
  { id: 'svc-jump', key: 'permanent_lighting_jump', name: 'Jump Wire',
    unit: 'linear_ft', quotable: true, sort_order: 11 },
  { id: 'svc-xmas', key: 'christmas_lighting', name: 'Christmas Lighting',
    unit: 'linear_ft', quotable: true, sort_order: 20 },
  { id: 'svc-snow', key: 'snow', name: 'Walkway, Step & Deck Snow Removal',
    unit: 'each', quotable: true, sort_order: 30 }
];

const USAGE = [
  { id: 'use-1', service_id: 'svc-perm', material_id: 'mat-track',
    quantity_per_unit: 1, waste_factor: 0.08,
    services: SERVICES[0], ns_materials: MATERIALS[0] },
  { id: 'use-2', service_id: 'svc-jump', material_id: 'mat-wire',
    quantity_per_unit: 1, waste_factor: 0,
    services: SERVICES[1], ns_materials: MATERIALS[1] }
];

const ORDERS = [
  { id: 'po-1', supplier_id: 'sup-1', status: 'ordered',
    reference: 'FIXTURE-PO-00412-OCTOBER-BULK', ordered_at: '2026-10-02T00:00:00Z',
    received_at: null, ns_suppliers: SUPPLIERS[0],
    ns_purchase_order_lines: [
      { id: 'pol-1', purchase_order_id: 'po-1', material_id: 'mat-track',
        packs_ordered: 8, packs_received: 1, unit_cost: null, sort_order: 1,
        ns_materials: MATERIALS[0] },
      { id: 'pol-2', purchase_order_id: 'po-1', material_id: 'mat-wire',
        packs_ordered: 2, packs_received: 2, unit_cost: null, sort_order: 2,
        ns_materials: MATERIALS[1] }
    ] },
  { id: 'po-2', supplier_id: 'sup-1', status: 'draft', reference: null,
    ordered_at: null, received_at: null, ns_suppliers: SUPPLIERS[0],
    ns_purchase_order_lines: [] }
];

/* Availability-view rows, as the Batch 9.1 panel reads them. The long
   customer name and the long run description are deliberate: the widest
   realistic content is the only content worth measuring. */
const SETS = [
  { set_id: 'set-a', set_code: 'FIXTURE-SET-A', status: 'in_storage',
    condition: 'usable', run_type: 'roofline and two gables', colour: 'warm white',
    linear_ft: 180, storage_location: 'Bay 3, shelf 2', location_id: 'loc-base',
    location_code: 'base', inspected_at: '2026-01-20T10:00:00Z',
    active_assignment_id: null, active_customer_id: null, active_season_year: null,
    active_assignment_status: null, has_active_assignment: false,
    awaiting_release: false, needs_inspection: false, needs_repair_or_search: false,
    out_of_service: false, at_the_repair_bench: false, available_for_reuse: true },
  { set_id: 'set-b', set_code: 'FIXTURE-SET-B', status: 'deployed',
    condition: 'usable', run_type: 'roofline', colour: 'warm white',
    linear_ft: 240, storage_location: null, location_id: null, location_code: null,
    inspected_at: '2025-10-30T10:00:00Z',
    active_assignment_id: 'asg-b', active_customer_id: 'cus-1',
    active_season_year: 2026, active_assignment_status: 'installed',
    has_active_assignment: true, awaiting_release: false, needs_inspection: false,
    needs_repair_or_search: false, out_of_service: false,
    at_the_repair_bench: false, available_for_reuse: false },
  { set_id: 'set-c', set_code: 'FIXTURE-SET-C', status: 'in_storage',
    condition: 'uninspected', run_type: 'tree wrap', colour: 'multicolour',
    linear_ft: 60, storage_location: null, location_id: 'loc-car-a',
    location_code: 'car_a', inspected_at: null,
    active_assignment_id: 'asg-c', active_customer_id: 'cus-2',
    active_season_year: 2026, active_assignment_status: 'removed',
    has_active_assignment: true, awaiting_release: true, needs_inspection: true,
    needs_repair_or_search: false, out_of_service: false,
    at_the_repair_bench: false, available_for_reuse: false },
  { set_id: 'set-d', set_code: 'FIXTURE-SET-D', status: 'lost',
    condition: 'missing', run_type: null, colour: null, linear_ft: null,
    storage_location: null, location_id: null, location_code: null,
    inspected_at: '2026-01-11T10:00:00Z',
    active_assignment_id: null, active_customer_id: null, active_season_year: null,
    active_assignment_status: null, has_active_assignment: false,
    awaiting_release: false, needs_inspection: false, needs_repair_or_search: true,
    out_of_service: true, at_the_repair_bench: false, available_for_reuse: false }
];

const ASSIGNMENTS = [
  { id: 'asg-b', set_id: 'set-b', customer_id: 'cus-1', property_id: 'prop-1',
    job_id: null, season_year: 2026, status: 'installed',
    renewal_state: 'not_renewed', recovery_condition: null,
    release_cutoff: '2026-01-15', installed_at: '2025-11-01T00:00:00Z',
    removed_at: null, released_at: null,
    customers: { id: 'cus-1', name: 'A Fixture Customer With A Rather Long Name' },
    properties: { id: 'prop-1', address_line1: '1234 Fixture Concession Road East',
                  city: 'Sault Ste. Marie' } },
  { id: 'asg-c', set_id: 'set-c', customer_id: 'cus-2', property_id: null,
    job_id: null, season_year: 2026, status: 'removed',
    renewal_state: 'pending', recovery_condition: 'uninspected',
    release_cutoff: null, installed_at: '2025-11-02T00:00:00Z',
    removed_at: '2026-01-10T00:00:00Z', released_at: null,
    customers: { id: 'cus-2', name: 'Another Fixture Customer' }, properties: null }
];

/* Permanent-lighting fixtures. A sheet mid-review and one that is reviewed,
   because the two states look different and both must read clearly. */
const KIT_SHEETS = [
  { id: 'ks-1', material_id: 'mat-kit', model: 'FIXTURE 100 ft model',
    coverage_ft: 100, review_state: 'draft', source: 'FIXTURE listing note',
    reviewed_at: null, created_at: '2026-10-01T00:00:00Z',
    ns_materials: { id: 'mat-kit', name: 'FIXTURE permanent kit', sku: null,
                    category: 'kit', unit: 'kit', spec_state: 'unverified' },
    ns_kit_sheet_lines: [
      { id: 'kl-1', material_id: 'mat-track', quantity_per_kit: 300,
        inclusion: 'included', note: null,
        ns_materials: { id: 'mat-track', name: 'FIXTURE channel', unit: 'linear_ft' } },
      { id: 'kl-2', material_id: 'mat-conn', quantity_per_kit: null,
        inclusion: 'included', note: 'listing does not give a count',
        ns_materials: { id: 'mat-conn', name: 'FIXTURE connector', unit: 'each' } },
      { id: 'kl-3', material_id: 'mat-clip', quantity_per_kit: null,
        inclusion: 'separately_required', note: null,
        ns_materials: { id: 'mat-clip', name: 'FIXTURE mounting clip', unit: 'each' } }
    ] },
  { id: 'ks-2', material_id: 'mat-kit2', model: 'FIXTURE 50 ft model',
    coverage_ft: 50, review_state: 'reviewed', source: 'FIXTURE listing note',
    reviewed_at: '2026-10-05T00:00:00Z', created_at: '2026-10-02T00:00:00Z',
    ns_materials: { id: 'mat-kit2', name: 'FIXTURE small kit', sku: null,
                    category: 'kit', unit: 'kit', spec_state: 'reviewed' },
    ns_kit_sheet_lines: [
      { id: 'kl-4', material_id: 'mat-track', quantity_per_kit: 150,
        inclusion: 'included', note: null,
        ns_materials: { id: 'mat-track', name: 'FIXTURE channel', unit: 'linear_ft' } }
    ] }
];

const PIECES = [
  { material_id: 'mat-track', name: 'FIXTURE channel', category: 'track',
    unit: 'linear_ft', cuttable: true, stock_length: 150, spec_state: 'reviewed',
    location_id: 'loc-base', location_code: 'base',
    on_hand: 156, available: 156, offcut_total: 6, offcut_count: 2,
    longest_offcut: 4, full_length_total: 150, full_pieces: 1, longest_runnable: 150 },
  { material_id: 'mat-conn', name: 'FIXTURE connector', category: 'connector',
    unit: 'each', cuttable: false, stock_length: null, spec_state: 'unverified',
    location_id: 'loc-base', location_code: 'base',
    on_hand: 40, available: 40, offcut_total: 0, offcut_count: 0,
    longest_offcut: null, full_length_total: 40, full_pieces: null,
    longest_runnable: null }
];

const OFFCUTS = [
  { id: 'oc-1', material_id: 'mat-track', location_id: 'loc-base', length: 4,
    condition: 'usable', status: 'available', note: 'from the Patterson roofline',
    created_at: '2026-10-04T00:00:00Z',
    ns_materials: { id: 'mat-track', name: 'FIXTURE channel', unit: 'linear_ft' },
    ns_stock_locations: { id: 'loc-base', code: 'base', name: 'Base' } },
  { id: 'oc-2', material_id: 'mat-track', location_id: 'loc-base', length: 2,
    condition: 'usable', status: 'available', note: null,
    created_at: '2026-10-05T00:00:00Z',
    ns_materials: { id: 'mat-track', name: 'FIXTURE channel', unit: 'linear_ft' },
    ns_stock_locations: { id: 'loc-base', code: 'base', name: 'Base' } }
];

const SEASONAL_CUSTOMERS = [
  { id: 'cus-1', name: 'A Fixture Customer With A Rather Long Name' },
  { id: 'cus-2', name: 'Another Fixture Customer' }
];

const ESTIMATE = {
  job_id: 'job-1', job_status: 'draft', customer_id: 'cus-1', property_id: 'prop-1',
  generated_at: '2026-10-10T00:00:00Z',
  lines: [
    { material_id: 'mat-track', sku: 'FIXTURE-CHANNEL-150-WHT',
      name: MATERIALS[0].name, category: 'track', unit: 'linear_ft',
      required: 216, on_hand: -150, shortfall: 366, pack_quantity: 150,
      packs_to_order: 3, unit_cost: 2.25, currency: 'CAD', estimated_cost: 486,
      needs_reorder: true, active: true, from_flagged_measurement: true,
      from_services: [{ service_key: 'permanent_lighting',
                        service_name: 'Permanent Outdoor Lighting',
                        measured_quantity: 200, service_unit: 'linear_ft',
                        quantity_per_unit: 1, waste_factor: 0.08 }] },
    { material_id: 'mat-wire', sku: null, name: 'FIXTURE jump wire', category: 'wire',
      unit: 'linear_ft', required: 160, on_hand: 10, shortfall: 150,
      pack_quantity: 500, packs_to_order: 1, unit_cost: null, currency: 'CAD',
      estimated_cost: null, needs_reorder: true, active: true,
      from_flagged_measurement: false,
      from_services: [{ service_key: 'permanent_lighting_jump', service_name: 'Jump Wire',
                        measured_quantity: 160, service_unit: 'linear_ft',
                        quantity_per_unit: 1, waste_factor: 0 }] }
  ],
  unmapped_services: [
    { service_id: 'svc-xmas', service_key: 'christmas_lighting',
      service_name: 'Christmas Lighting', service_unit: 'linear_ft', measured_quantity: 90 },
    { service_id: 'svc-snow', service_key: 'snow',
      service_name: 'Walkway, Step & Deck Snow Removal', service_unit: 'each',
      measured_quantity: 3 }
  ]
};

const MOVES = [
  { id: 'mv-1', material_id: 'mat-track', delta: 300, reason: 'received',
    occurred_at: '2026-10-01T10:00:00Z', note: 'PO FIXTURE-PO-00412' },
  { id: 'mv-2', material_id: 'mat-track', delta: -400, reason: 'consumed',
    occurred_at: '2026-10-04T14:30:00Z',
    note: 'Used across two installs on the same street, confirmed against the van count' },
  { id: 'mv-3', material_id: 'mat-track', delta: -50, reason: 'damaged',
    occurred_at: '2026-10-05T09:00:00Z', note: null }
];

const SET_EVENTS = [
  { id: 'ev-1', rental_set_id: 'set-b', event: 'received',
    occurred_at: '2025-10-01T00:00:00Z', note: null },
  { id: 'ev-2', rental_set_id: 'set-b', event: 'installed',
    occurred_at: '2026-11-01T00:00:00Z', note: 'North run re-clipped on site' }
];

const FAKE_API = `
  const clone = (v) => JSON.parse(JSON.stringify(v));
  export async function listSuppliers()   { return clone(${JSON.stringify(SUPPLIERS)}); }
  export async function listStockLocations() { return clone(${JSON.stringify([
    { id: 'loc-base',  code: 'base',  name: 'Base',  kind: 'base',    active: true, sort_order: 0 },
    { id: 'loc-car-a', code: 'car_a', name: 'Car A', kind: 'vehicle', active: true, sort_order: 1 }
  ])}); }
  export async function listReservations() { return clone(${JSON.stringify([
    { id: 'res-1', material_id: 'mat-track', location_id: 'loc-base', quantity: 60,
      status: 'held', job_id: 'job-1', held_at: '2026-10-09T12:00:00Z',
      ns_stock_locations: { id: 'loc-base', code: 'base', name: 'Base' },
      ns_materials: { id: 'mat-track', name: 'FIXTURE channel', unit: 'linear_ft' } }
  ])}); }
  export async function reserveStock() { return {}; }
  export async function releaseStockReservation() { return {}; }
  export async function consumeStockReservation() { return {}; }
  export async function setMaterialLevel() { return {}; }
  export async function listStockByLocation() { return clone(${JSON.stringify([
    { material_id: 'mat-track', location_id: 'loc-base',  location_code: 'base',
      location_name: 'Base',  on_hand: -200, reserved: 0, available: 0,
      damaged_on_hand: 35, is_estimated: true },
    { material_id: 'mat-track', location_id: 'loc-car-a', location_code: 'car_a',
      location_name: 'Car A', on_hand: 50, reserved: 60, available: 0,
      damaged_on_hand: 0, is_estimated: false },
    { material_id: 'mat-wire',  location_id: 'loc-base',  location_code: 'base',
      location_name: 'Base',  on_hand: 10, reserved: 0, available: 10,
      damaged_on_hand: 0, is_estimated: false },
    { material_id: 'mat-wire',  location_id: 'loc-car-a', location_code: 'car_a',
      location_name: 'Car A', on_hand: 0, reserved: 0, available: 0,
      damaged_on_hand: 0, is_estimated: false },
    { material_id: 'mat-ctrl',  location_id: 'loc-base',  location_code: 'base',
      location_name: 'Base',  on_hand: 5, reserved: 0, available: 5,
      damaged_on_hand: 0, is_estimated: false },
    { material_id: 'mat-ctrl',  location_id: 'loc-car-a', location_code: 'car_a',
      location_name: 'Car A', on_hand: 0, reserved: 0, available: 0,
      damaged_on_hand: 0, is_estimated: false },
    { material_id: 'mat-salt',  location_id: 'loc-base',  location_code: 'base',
      location_name: 'Base',  on_hand: 180, reserved: 0, available: 180,
      damaged_on_hand: 0, is_estimated: true },
    { material_id: 'mat-salt',  location_id: 'loc-car-a', location_code: 'car_a',
      location_name: 'Car A', on_hand: 0, reserved: 0, available: 0,
      damaged_on_hand: 0, is_estimated: false },
    { material_id: 'mat-rags',  location_id: 'loc-base',  location_code: 'base',
      location_name: 'Base',  on_hand: 0, reserved: 0, available: 0,
      damaged_on_hand: 0, is_estimated: false, tracking_mode: 'level',
      level_state: 'low', level_checked_at: '2026-10-08T00:00:00Z' },
    { material_id: 'mat-rags',  location_id: 'loc-car-a', location_code: 'car_a',
      location_name: 'Car A', on_hand: 0, reserved: 0, available: 0,
      damaged_on_hand: 0, is_estimated: false, tracking_mode: 'level',
      level_state: null, level_checked_at: null }
  ])}); }
  export async function postStockMovement() { return {}; }
  export async function postStockTransfer() { return {}; }
  export async function listMaterials()   { return clone(${JSON.stringify(MATERIALS)}); }
  export async function listServices()    { return clone(${JSON.stringify(SERVICES)}); }
  export async function listServiceMaterialUsage() { return clone(${JSON.stringify(USAGE)}); }
  export async function listPurchaseOrders() { return clone(${JSON.stringify(ORDERS)}); }
  export async function listSeasonalSets() { return clone(${JSON.stringify(SETS)}); }
  export async function listSeasonalAssignments(o) {
    const all = clone(${JSON.stringify(ASSIGNMENTS)});
    if (o && o.openOnly) return all.filter((a) => a.status !== 'released' && a.status !== 'cancelled');
    if (o && o.setId) return all.filter((a) => a.set_id === o.setId);
    return all;
  }
  export async function searchCustomers() { return clone(${JSON.stringify(SEASONAL_CUSTOMERS)}); }
  export function newOperationId(p) { return (p || 'op') + '-shot'; }
  export async function listStockMoves()  { return clone(${JSON.stringify(MOVES)}); }
  export async function listRentalSetEvents() { return clone(${JSON.stringify(SET_EVENTS)}); }
  export async function estimateJobMaterials() { return clone(${JSON.stringify(ESTIMATE)}); }
  export async function currentUserId()   { return 'admin-1'; }
  export async function createMaterial()  { return {}; }
  export async function updateMaterial()  { return {}; }
  export async function createPurchaseOrder() { return {}; }
  export async function updatePurchaseOrder() { return {}; }
  export async function addPurchaseOrderLine() { return {}; }
  export async function updatePurchaseOrderLine() { return {}; }
  export async function deletePurchaseOrderLine() { return {}; }
  export async function receivePurchaseOrderLine() { return {}; }
  export async function setServiceMaterialUsage() { return {}; }
  export async function updateServiceMaterialUsage() { return {}; }
  export async function deleteServiceMaterialUsage() { return {}; }
  export async function registerSeasonalSet() { return {}; }
  export async function listKitSheets() { return clone(${JSON.stringify(KIT_SHEETS)}); }
  export async function listPieceAvailability() { return clone(${JSON.stringify(PIECES)}); }
  export async function listOffcuts() { return clone(${JSON.stringify(OFFCUTS)}); }
  export async function createKitSheet() { return {}; }
  export async function updateKitSheet() { return {}; }
  export async function addKitSheetLine() { return {}; }
  export async function openSealedKit() { return {}; }
  export async function recordOffcut() { return {}; }
  export async function consumeOffcut() { return {}; }
  export async function scrapOffcut() { return {}; }
  export async function assignSeasonalSet() { return {}; }
  export async function cancelSeasonalAssignment() { return {}; }
  export async function installSeasonalSet() { return {}; }
  export async function recoverSeasonalSet() { return {}; }
  export async function inspectSeasonalSet() { return {}; }
  export async function releaseSeasonalSet() { return {}; }
  export async function recordSetRenewal() { return {}; }
  export async function retireSeasonalSet() { return {}; }
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
  // Every button on these screens is an action with a consequence, so all of
  // them are measured, not just the primary ones. 34px is .btn--sm.
  const small = [...document.querySelectorAll('button')]
    .map((b) => ({ text: b.textContent.trim().slice(0, 28),
                   h: Math.round(b.getBoundingClientRect().height) }))
    .filter((b) => b.h > 0 && b.h < 34);
  // A caption that has collapsed is the `.field > span` trap: the rule is a
  // direct-child selector, so a span one level deeper loses its styling.
  const clipped = [...document.querySelectorAll('label.field > span')]
    .filter((s) => s.getBoundingClientRect().height < 8)
    .map((s) => s.textContent.trim().slice(0, 28));
  // A caption that is NOT a direct child would never be caught above, so
  // count those too.
  const misnested = [...document.querySelectorAll('.field span')]
    .filter((s) => s.parentElement && !s.parentElement.classList.contains('field')).length;
  return { vw, scrollW: document.documentElement.scrollWidth,
           bad: bad.slice(0, 6), small, clipped, misnested };
};

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const findings = [];

  for (const s of SIZES) {
    const page = await browser.newPage({ viewport: { width: s.w, height: s.h } });
    page.on('dialog', (d) => d.dismiss());
    const mock = (p, body) => page.route(p, (r) =>
      r.fulfill({ status: 200, contentType: 'application/javascript', body }));
    await mock('**/cdn.jsdelivr.net/npm/@capacitor/core@8.5.2/+esm', FAKE_CAPACITOR_CORE);
    await mock(`${BASE}/shared/supabase.js`, FAKE_SUPABASE_ADMIN);
    await mock(`${BASE}/admin/js/lib/api.js`, FAKE_API);
    await page.goto(`${BASE}/admin/field.html`);
    await page.waitForTimeout(150);

    for (const tab of ['stock', 'purchasing', 'mapping', 'sets', 'kits']) {
      await page.evaluate(async (t) => {
        const mod = await import('/admin/js/views/inventory.js');
        document.body.innerHTML = '';
        document.body.style.padding = '12px';
        const mount = document.createElement('div');
        document.body.appendChild(mount);
        await mod.renderInventory({
          mount, params: new URLSearchParams(`tab=${t}`),
          replaceQuery: () => {}, navigate: () => {}
        });
      }, tab);
      await page.waitForTimeout(300);

      await page.screenshot({ path: `${OUT}/inventory-${tab}-${s.tag}.png`, fullPage: true });
      findings.push({ view: `inventory/${tab} @${s.tag}`, ...(await page.evaluate(PROBE)) });

      // The expanded ledger and the expanded set history are the densest
      // things on these screens, so they get their own pass rather than
      // being assumed to fit.
      // The sets tab's densest state is an inline action form plus an open
      // history, and its history is a <details>/<summary> rather than a
      // button, so it needs its own opener.
      const expander = tab === 'stock' ? 'Move'
        : tab === 'sets' ? 'seasonal'
        : tab === 'kits' ? 'kits' : null;
      if (expander) {
        await page.evaluate((label) => {
          if (label === 'kits') {
            for (const b of document.querySelectorAll('button')) {
              if (/^(Start a sheet|Add component|Open a kit)$/.test(b.textContent.trim())) {
                b.click();
                break;
              }
            }
            return;
          }
          if (label === 'seasonal') {
            for (const b of document.querySelectorAll('button')) {
              if (/^(Assign to a customer|Record recovery|Record inspection)$/
                  .test(b.textContent.trim())) b.click();
            }
            for (const d of document.querySelectorAll('details')) d.open = true;
            return;
          }
          const btn = [...document.querySelectorAll('button')]
            .find((b) => b.textContent.trim() === label);
          if (btn) btn.click();
        }, expander);
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${OUT}/inventory-${tab}-expanded-${s.tag}.png`, fullPage: true });
        findings.push({ view: `inventory/${tab}+expanded @${s.tag}`, ...(await page.evaluate(PROBE)) });

        // The stock tab has two expanders; shoot the ledger as well.
        if (tab === 'stock') {
          await page.evaluate(() => {
            const btn = [...document.querySelectorAll('button')]
              .find((b) => b.textContent.trim() === 'Movements');
            if (btn) btn.click();
          });
          await page.waitForTimeout(300);
          await page.screenshot({ path: `${OUT}/inventory-stock-ledger-${s.tag}.png`, fullPage: true });
          findings.push({ view: `inventory/stock+ledger @${s.tag}`, ...(await page.evaluate(PROBE)) });
        }
      }

      // Per-card clips: a full-page phone shot of these screens is several
      // thousand pixels tall and scales down past readability.
      let i = 0;
      for (const card of await page.$$('.card')) {
        await card.screenshot({ path: `${OUT}/card-${tab}-${i++}-${s.tag}.png` }).catch(() => {});
        if (i >= 3) break;
      }
    }

    // ---- the per-job Materials panel, before and after calculating.
    await page.evaluate(async () => {
      const mod = await import('/admin/js/components/job-materials.js');
      document.body.innerHTML = '';
      document.body.style.padding = '12px';
      const mount = document.createElement('div');
      document.body.appendChild(mount);
      const panel = mod.createJobMaterialsPanel({ jobId: 'job-1' });
      mount.appendChild(panel.root);
    });
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/job-materials-idle-${s.tag}.png`, fullPage: true });
    findings.push({ view: `job materials (idle) @${s.tag}`, ...(await page.evaluate(PROBE)) });

    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')]
        .find((b) => b.textContent.trim() === 'Work out materials');
      if (btn) btn.click();
    });
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/job-materials-${s.tag}.png`, fullPage: true });
    findings.push({ view: `job materials @${s.tag}`, ...(await page.evaluate(PROBE)) });

    await page.close();
  }

  await browser.close();

  console.log(`\nPNGs in ${OUT}\n`);
  let problems = 0;
  for (const f of findings) {
    const overflow = f.scrollW > f.vw + 1 || f.bad.length > 0;
    const issues = [];
    if (overflow) issues.push('overflow');
    if (f.small.length) issues.push(`${f.small.length} control(s) under 34px`);
    if (f.clipped.length) issues.push(`${f.clipped.length} clipped caption(s)`);
    if (f.misnested) issues.push(`${f.misnested} mis-nested caption span(s)`);
    if (issues.length) problems++;
    console.log(`${issues.length ? 'BAD ' : 'OK  '} ${f.view}: viewport ${f.vw}, document ${f.scrollW}` +
      (issues.length ? ` — ${issues.join('; ')}` : ''));
    for (const b of f.bad) console.log(`       ${b.tag}.${b.cls} [${b.left}..${b.right}] "${b.text}"`);
    for (const b of f.small) console.log(`       "${b.text}" height ${b.h}px`);
    for (const c of f.clipped) console.log(`       clipped caption "${c}"`);
  }
  console.log(problems ? `\n${problems} view(s) need attention` : '\nNo layout problems in any view');
})();
