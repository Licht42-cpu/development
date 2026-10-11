// Phase 25 -- Batch 9.1 corrective: permanent-lighting kits, offcuts and the
// job material sheet.
//
// Run directly:   node tests/phase25.test.mjs      (static server on :8743)
//
// MOCKED BROWSER TESTS against the real components with api.js stubbed. The
// database side is covered executably by tests/db/batch9-1-lighting.test.mjs.
// NO MIGRATION IN THIS REPOSITORY HAS BEEN APPLIED TO PRODUCTION.
//
// What these pin:
//
//   * An unreviewed kit sheet cannot open a kit, and the screen says why
//     rather than hiding the button. Friction is the point: the alternative
//     is a plan built on a half-remembered pack size.
//   * A missing quantity reads as missing. "Blank is unknown, not zero" has
//     to survive contact with a form that would happily default it.
//   * The longest piece, not the total, is what the pieces screen leads
//     with. Two 3 ft offcuts are not a 6 ft run.
//   * Only TICKED sheet lines reach the reserving call.
//   * Heating candidates are listed with the measurements and no ranking.

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
  const push = (name, args) => { globalThis.__calls.push({ name, args: clone(args || {}) }); };
  async function gate() {
    if (globalThis.__failNext > 0) { globalThis.__failNext--; throw new Error('Network unreachable'); }
  }
  export function newOperationId(p) { return (p || 'op') + '-fixed'; }
  export async function currentUserId() { return 'admin-1'; }

  export async function listMaterials()  { return clone(globalThis.__MATERIALS); }
  export async function listKitSheets()  { return clone(globalThis.__SHEETS); }
  export async function listPieceAvailability() { return clone(globalThis.__PIECES); }
  export async function listOffcuts()    { return clone(globalThis.__OFFCUTS); }
  export async function listStockLocations() { return clone(globalThis.__LOCATIONS); }

  export async function createKitSheet(p)   { push('createKitSheet', p); await gate(); return {}; }
  export async function updateKitSheet(id,p){ push('updateKitSheet', { id, patch: p }); await gate(); return {}; }
  export async function addKitSheetLine(p)  { push('addKitSheetLine', p); await gate(); return {}; }
  export async function openSealedKit(a)    { push('openSealedKit', a); await gate(); return {}; }
  export async function recordOffcut(a)     { push('recordOffcut', a); await gate(); return {}; }
  export async function consumeOffcut(a)    { push('consumeOffcut', a); await gate(); return {}; }
  export async function scrapOffcut(a)      { push('scrapOffcut', a); await gate(); return {}; }

  export async function getJobMaterialSheet() { return clone(globalThis.__JOB_SHEET); }
  export async function createJobMaterialSheet(id) { push('createJobMaterialSheet', { id }); return {}; }
  export async function selectJobMaterial(a) { push('selectJobMaterial', a); await gate(); return {}; }
  export async function reviewJobMaterialSheet(a) { push('reviewJobMaterialSheet', a); await gate(); return {}; }
  export async function reserveJobMaterialSheet(a) { push('reserveJobMaterialSheet', a); await gate(); return {}; }
  export async function heatingKitCandidates() { return clone(globalThis.__HEATING); }
`;

/* ------------------------------------------------------------- fixtures -- */

const MATERIALS = [
  { id: 'mat-kit', name: 'FIXTURE kit', sku: null, category: 'kit', unit: 'kit',
    cuttable: false, stock_length: null, spec_state: 'unverified' },
  { id: 'mat-channel', name: 'FIXTURE channel', sku: null, category: 'track',
    unit: 'linear_ft', cuttable: true, stock_length: 100, spec_state: 'reviewed' },
  { id: 'mat-conn', name: 'FIXTURE connector', sku: null, category: 'connector',
    unit: 'each', cuttable: false, stock_length: null, spec_state: 'reviewed' },
  { id: 'mat-cable', name: 'FIXTURE cable kit', sku: null, category: 'heating_cable',
    unit: 'each', cuttable: false, stock_length: null, spec_state: 'unverified' }
];

const LOCATIONS = [
  { id: 'loc-base', code: 'base', name: 'Base', kind: 'base' },
  { id: 'loc-car-a', code: 'car_a', name: 'Car A', kind: 'vehicle' }
];

const sheet = (over = {}) => ({
  id: 'sheet-1', material_id: 'mat-kit', model: 'FIXTURE model',
  coverage_ft: 100, review_state: 'draft', source: 'FIXTURE listing',
  reviewed_at: null, created_at: '2026-10-01T00:00:00Z',
  ns_materials: MATERIALS[0],
  ns_kit_sheet_lines: [
    { id: 'l1', material_id: 'mat-channel', quantity_per_kit: 300,
      inclusion: 'included', note: null, ns_materials: MATERIALS[1] },
    { id: 'l2', material_id: 'mat-conn', quantity_per_kit: 20,
      inclusion: 'included', note: null, ns_materials: MATERIALS[2] }
  ],
  ...over
});

const PIECES = [
  // six feet on hand, as two three-foot pieces
  { material_id: 'mat-channel', name: 'FIXTURE channel', category: 'track',
    unit: 'linear_ft', cuttable: true, stock_length: 100, spec_state: 'reviewed',
    location_id: 'loc-base', location_code: 'base',
    on_hand: 6, available: 6, offcut_total: 6, offcut_count: 2,
    longest_offcut: 3, full_length_total: 0, full_pieces: 0, longest_runnable: 3 },
  // a product whose piece length nobody recorded
  { material_id: 'mat-conn', name: 'FIXTURE connector', category: 'connector',
    unit: 'each', cuttable: false, stock_length: null, spec_state: 'reviewed',
    location_id: 'loc-base', location_code: 'base',
    on_hand: 20, available: 20, offcut_total: 0, offcut_count: 0,
    longest_offcut: null, full_length_total: 20, full_pieces: null,
    longest_runnable: null }
];

const OFFCUTS = [
  { id: 'cut-1', material_id: 'mat-channel', location_id: 'loc-base', length: 3,
    condition: 'usable', status: 'available', note: null,
    created_at: '2026-10-02T00:00:00Z',
    ns_materials: MATERIALS[1], ns_stock_locations: LOCATIONS[0] },
  { id: 'cut-2', material_id: 'mat-channel', location_id: 'loc-base', length: 3,
    condition: 'usable', status: 'available', note: null,
    created_at: '2026-10-03T00:00:00Z',
    ns_materials: MATERIALS[1], ns_stock_locations: LOCATIONS[0] }
];

const JOB_SHEET = (over = {}) => ({
  id: 'js-1', job_id: 'job-1', status: 'draft',
  reviewed_at: null, reserved_at: null,
  ns_job_material_sheet_lines: [
    { id: 'jl-1', material_id: 'mat-channel', quantity: 120, selected: true,
      source: 'manual', note: null, reservation_id: null, ns_materials: MATERIALS[1] },
    { id: 'jl-2', material_id: 'mat-conn', quantity: 8, selected: false,
      source: 'manual', note: null, reservation_id: null, ns_materials: MATERIALS[2] }
  ],
  ...over
});

const HEATING = {
  job_id: 'job-1',
  measurements: [
    { service_key: 'permanent_lighting', service_name: 'Permanent Outdoor Lighting',
      label: 'Front roofline', quantity: 64, unit: 'linear_ft', review_required: false }
  ],
  selection_rule: 'The manufacturer\'s layout decides the cable or kit. This list '
    + 'is what we stock, not a recommendation, and quoted roofline length is not '
    + 'cable length.',
  candidates: [
    { material_id: 'mat-cable', name: 'FIXTURE cable kit', sku: null,
      category: 'heating_cable', cuttable: false, stock_length: null,
      spec_state: 'unverified', spec_source: null, selectable: false,
      why_not: 'The product specification has not been checked against the listing.' }
  ]
};

const HELPERS = () => ({
  labelled: (scope, label) => {
    const span = [...scope.querySelectorAll('label.field > span')]
      .find((s) => s.textContent === label);
    return span ? span.parentElement.querySelector('input, select, textarea') : null;
  },
  button: (scope, text) => [...scope.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === text),
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

  const withPanel = (which, opts, body) => page.evaluate(
    async ({ module, exportName, fixtures, options, bodySrc, helpersSrc }) => {
      Object.assign(globalThis, fixtures);
      globalThis.__calls = [];
      globalThis.__failNext = options.failNext || 0;
      globalThis.__confirms = [];
      if (!globalThis.__realConfirm) globalThis.__realConfirm = window.confirm;
      window.confirm = (m) => {
        globalThis.__confirms.push(m);
        return options.declineConfirm ? false : true;
      };

      const mod = await import(module);
      const mount = document.createElement('div');
      document.body.appendChild(mount);
      const made = mod[exportName](options.arg || { jobId: 'job-1' });
      mount.appendChild(made.root || made);

      // eslint-disable-next-line no-new-func
      const h = new Function(`return (${helpersSrc})`)()();
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (${bodySrc})`)();
      const out = await fn({ mount, h });
      mount.remove();
      window.confirm = globalThis.__realConfirm;
      return { out, calls: globalThis.__calls, confirms: globalThis.__confirms };
    },
    {
      module: which === 'kits'
        ? '/admin/js/components/kit-sheets.js'
        : '/admin/js/components/job-material-sheet.js',
      exportName: which === 'kits' ? 'kitsAndPiecesPanel' : 'createJobMaterialSheetPanel',
      fixtures: {
        __MATERIALS: opts.materials || MATERIALS,
        __SHEETS: opts.sheets || [sheet()],
        __PIECES: opts.pieces || PIECES,
        __OFFCUTS: opts.offcuts || OFFCUTS,
        __LOCATIONS: opts.locations || LOCATIONS,
        __JOB_SHEET: 'jobSheet' in opts ? opts.jobSheet : JOB_SHEET(),
        __HEATING: opts.heating || HEATING
      },
      options: opts,
      bodySrc: body.toString(),
      helpersSrc: HELPERS.toString()
    });

  return { browser, page, withPanel };
}

(async () => {
  const { browser, page, withPanel } = await launch();

  // ============================================== A. kit sheets ==========
  await record('A1 a draft sheet cannot open a kit, and says what is missing', async () => {
    const { out } = await withPanel('kits', { sheets: [sheet({ review_state: 'draft' })] },
      async ({ mount, h }) => {
        await h.settle(150);
        return { buttons: h.buttonTexts(mount), text: mount.textContent };
      });
    assert.ok(!out.buttons.includes('Open a kit'),
      'the database refuses it; offering the button would read as a bug');
    assert.ok(out.buttons.includes('Mark reviewed'));
    assert.match(out.text, /Draft/);
  });

  await record('A2 a reviewed sheet offers opening, and lists what comes out', async () => {
    const { out } = await withPanel('kits',
      { sheets: [sheet({ review_state: 'reviewed', reviewed_at: '2026-10-05T00:00:00Z' })] },
      async ({ mount, h }) => {
        await h.settle(150);
        h.button(mount, 'Open a kit').click();
        await h.settle(80);
        return mount.querySelector('[data-inline]').textContent;
      });
    assert.match(out, /FIXTURE channel: 300/);
    assert.match(out, /FIXTURE connector: 20/);
    assert.match(out, /never both count as available/i);
  });

  await record('A3 a missing quantity blocks review, and the screen explains why',
    async () => {
      const s = sheet();
      s.ns_kit_sheet_lines[0].quantity_per_kit = null;
      const { out } = await withPanel('kits', { sheets: [s] }, async ({ mount, h }) => {
        await h.settle(150);
        const btn = h.button(mount, 'Mark reviewed');
        return { disabled: btn.disabled, text: mount.textContent };
      });
      assert.equal(out.disabled, true);
      assert.match(out.text, /quantity not recorded/,
        'blank reads as unrecorded, never as zero');
      assert.match(out.text, /cannot be reviewed/i);
    });

  await record('A4 a sheet with no source cannot be reviewed', async () => {
    const { out } = await withPanel('kits', { sheets: [sheet({ source: null })] },
      async ({ mount, h }) => {
        await h.settle(150);
        return h.button(mount, 'Mark reviewed').disabled;
      });
    assert.equal(out, true, 'a figure with no source is a memory');
  });

  await record('A5 separately-required parts are named as not in the box', async () => {
    const s = sheet();
    s.ns_kit_sheet_lines.push({
      id: 'l3', material_id: 'mat-conn', quantity_per_kit: null,
      inclusion: 'separately_required', note: null, ns_materials: MATERIALS[2] });
    const { out } = await withPanel('kits', { sheets: [s] }, async ({ mount, h }) => {
      await h.settle(150);
      return mount.textContent;
    });
    assert.match(out, /Separately required/);
    assert.match(out, /opening a kit creates none of it/i);
  });

  await record('A6 opening confirms first and sends the count and location', async () => {
    const { calls, confirms } = await withPanel('kits',
      { sheets: [sheet({ review_state: 'reviewed', reviewed_at: '2026-10-05T00:00:00Z' })] },
      async ({ mount, h }) => {
        await h.settle(150);
        h.button(mount, 'Open a kit').click();
        await h.settle(80);
        const form = mount.querySelector('[data-inline]');
        h.labelled(form, 'How many kits').value = '2';
        h.labelled(form, 'At').value = 'car_a';
        h.button(form, 'Open').click();
        await h.settle(150);
      });
    assert.equal(confirms.length, 1);
    assert.match(confirms[0], /not undone by a counter-movement/i);
    const call = calls.find((c) => c.name === 'openSealedKit');
    assert.ok(call);
    assert.equal(call.args.kitCount, 2);
    assert.equal(call.args.locationCode, 'car_a');
    assert.equal(call.args.kitMaterialId, 'mat-kit');
  });

  await record('A7 declining the confirm opens nothing', async () => {
    const { calls } = await withPanel('kits',
      { declineConfirm: true,
        sheets: [sheet({ review_state: 'reviewed', reviewed_at: '2026-10-05T00:00:00Z' })] },
      async ({ mount, h }) => {
        await h.settle(150);
        h.button(mount, 'Open a kit').click();
        await h.settle(80);
        const form = mount.querySelector('[data-inline]');
        h.button(form, 'Open').click();
        await h.settle(150);
      });
    assert.equal(calls.filter((c) => c.name === 'openSealedKit').length, 0);
  });

  await record('A8 a blank component quantity is sent as null, not zero', async () => {
    const { calls } = await withPanel('kits', {}, async ({ mount, h }) => {
      await h.settle(150);
      h.button(mount, 'Add component').click();
      await h.settle(80);
      const form = mount.querySelector('[data-inline]');
      h.labelled(form, 'Component').value = 'mat-cable';
      h.button(form, 'Add').click();
      await h.settle(150);
    });
    const call = calls.find((c) => c.name === 'addKitSheetLine');
    assert.ok(call);
    assert.equal(call.args.quantity_per_kit, null,
      'zero would claim the box contains none; null says nobody knows');
  });

  // ================================================ B. pieces ============
  await record('B1 the pieces screen leads with the longest run, not the total',
    async () => {
      const { out } = await withPanel('kits', {}, async ({ mount, h }) => {
        await h.settle(150);
        return mount.textContent;
      });
      assert.match(out, /Longest run that can be cut today: 3/);
      assert.match(out, /6 linear_ft on hand/);
      assert.match(out, /2 offcut\(s\) totalling 6/);
    });

  await record('B2 an unknown piece length reads as unknown', async () => {
    const { out } = await withPanel('kits', {}, async ({ mount, h }) => {
      await h.settle(150);
      return mount.textContent;
    });
    assert.match(out, /Longest run that can be cut: unknown/);
    assert.ok(!/Longest run that can be cut today: 0/.test(out),
      'unknown must never be rendered as zero');
  });

  await record('B3 recording a piece sends the length and the chosen location', async () => {
    const { calls } = await withPanel('kits', {}, async ({ mount, h }) => {
      await h.settle(150);
      h.labelled(mount, 'Material').value = 'mat-channel';
      h.labelled(mount, 'Length').value = '4';
      h.button(mount, 'Record piece').click();
      await h.settle(150);
    });
    const call = calls.find((c) => c.name === 'recordOffcut');
    assert.ok(call);
    assert.equal(call.args.length, 4);
    assert.equal(call.args.locationCode, 'base');
    assert.equal(call.args.materialId, 'mat-channel');
  });

  await record('B4 the screen says recording a piece adds no stock', async () => {
    const { out } = await withPanel('kits', {}, async ({ mount, h }) => {
      await h.settle(150);
      return mount.textContent;
    });
    assert.match(out, /adds no stock/i);
  });

  await record('B5 scrapping confirms and keeps the record', async () => {
    const { calls, confirms } = await withPanel('kits', {}, async ({ mount, h }) => {
      await h.settle(150);
      h.button(mount, 'Scrap').click();
      await h.settle(150);
    });
    assert.equal(confirms.length, 1);
    assert.match(confirms[0], /record stays/i);
    assert.equal(calls.filter((c) => c.name === 'scrapOffcut').length, 1);
  });

  await record('B6 a failed write says why instead of claiming success', async () => {
    const { out } = await withPanel('kits', { failNext: 1 }, async ({ mount, h }) => {
      await h.settle(150);
      h.labelled(mount, 'Material').value = 'mat-channel';
      h.labelled(mount, 'Length').value = '4';
      h.button(mount, 'Record piece').click();
      await h.settle(200);
      return document.getElementById('toast')?.textContent || '';
    });
    assert.match(out, /Network unreachable/);
  });

  // ========================================= C. job material sheet =======
  await record('C1 with no sheet, the screen offers to start one', async () => {
    const { out } = await withPanel('sheet', { jobSheet: null }, async ({ mount, h }) => {
      await h.settle(150);
      return { buttons: h.buttonTexts(mount), text: mount.textContent };
    });
    assert.ok(out.buttons.includes('Start a sheet'));
    assert.match(out.text, /No material sheet yet/);
  });

  await record('C2 only ticked lines are described as committing stock', async () => {
    const { out } = await withPanel('sheet', {}, async ({ mount, h }) => {
      await h.settle(150);
      const boxes = [...mount.querySelectorAll('input[type=checkbox]')];
      return { checked: boxes.map((b) => b.checked), text: mount.textContent };
    });
    assert.deepEqual(out.checked, [true, false]);
    assert.match(out.text, /Only the ticked lines ever reserve stock/i);
  });

  await record('C3 unticking a line sends selected=false, not a delete', async () => {
    const { calls } = await withPanel('sheet', {}, async ({ mount, h }) => {
      await h.settle(150);
      const box = mount.querySelector('input[type=checkbox]');
      box.checked = false;
      box.dispatchEvent(new Event('change', { bubbles: true }));
      await h.settle(150);
    });
    const call = calls.find((c) => c.name === 'selectJobMaterial');
    assert.ok(call);
    assert.equal(call.args.selected, false);
    assert.equal(call.args.materialId, 'mat-channel');
    assert.equal(calls.some((c) => /delete/i.test(c.name)), false,
      'a rejected option is unticked, not erased: the sheet is the record');
  });

  await record('C4 a draft sheet cannot commit stock', async () => {
    const { out } = await withPanel('sheet', {}, async ({ mount, h }) => {
      await h.settle(150);
      return h.buttonTexts(mount);
    });
    assert.ok(out.includes('Mark reviewed'));
    assert.ok(!out.includes('Commit stock'));
  });

  await record('C5 a reviewed sheet can commit, and the call names the sheet', async () => {
    const { calls } = await withPanel('sheet',
      { jobSheet: JOB_SHEET({ status: 'reviewed', reviewed_at: '2026-10-05T00:00:00Z' }) },
      async ({ mount, h }) => {
        await h.settle(150);
        h.button(mount, 'Commit stock').click();
        await h.settle(150);
      });
    const call = calls.find((c) => c.name === 'reserveJobMaterialSheet');
    assert.ok(call);
    assert.equal(call.args.sheetId, 'js-1');
  });

  await record('C6 reviewing is refused while nothing is ticked', async () => {
    const s = JOB_SHEET();
    s.ns_job_material_sheet_lines.forEach((l) => { l.selected = false; });
    const { out } = await withPanel('sheet', { jobSheet: s }, async ({ mount, h }) => {
      await h.settle(150);
      return { disabled: h.button(mount, 'Mark reviewed').disabled, text: mount.textContent };
    });
    assert.equal(out.disabled, true);
    assert.match(out.text, /commit to nothing/i);
  });

  await record('C7 an unchecked specification is flagged on the line', async () => {
    const s = JOB_SHEET();
    s.ns_job_material_sheet_lines.push({
      id: 'jl-3', material_id: 'mat-cable', quantity: 1, selected: false,
      source: 'selected', note: null, reservation_id: null, ns_materials: MATERIALS[3] });
    const { out } = await withPanel('sheet', { jobSheet: s }, async ({ mount, h }) => {
      await h.settle(150);
      return mount.textContent;
    });
    assert.match(out, /Spec unchecked/);
    assert.match(out, /has not been checked against the listing/i);
  });

  await record('C8 a committed sheet says what holding stock does and does not do',
    async () => {
      const { out } = await withPanel('sheet',
        { jobSheet: JOB_SHEET({ status: 'reserved', reviewed_at: '2026-10-05T00:00:00Z',
                                reserved_at: '2026-10-06T00:00:00Z' }) },
        async ({ mount, h }) => {
          await h.settle(150);
          return mount.textContent;
        });
      assert.match(out, /Stock committed/);
      assert.match(out, /does not move anything off a shelf/i);
    });

  // ====================================== D. heating-kit selection =======
  await record('D1 heating candidates carry the rule, the measurements and no ranking',
    async () => {
      const { out } = await withPanel('sheet', {}, async ({ mount, h }) => {
        await h.settle(150);
        const d = mount.querySelector('details');
        d.open = true;
        await h.settle(60);
        return d.textContent;
      });
      assert.match(out, /manufacturer/i);
      assert.match(out, /Front roofline: 64 linear_ft/);
      assert.match(out, /not selectable/i);
      assert.ok(!/recommended|best match|suggested kit/i.test(out),
        'nothing here may rank a product');
    });

  // ============================================== E. phone layout ========
  for (const width of [390, 430]) {
    await record(`E${width === 390 ? 1 : 2} no horizontal overflow at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 900 });
      const over = await page.evaluate(async () => {
        globalThis.__calls = [];
        const kits = await import('/admin/js/components/kit-sheets.js');
        const js = await import('/admin/js/components/job-material-sheet.js');
        const mount = document.createElement('div');
        document.body.appendChild(mount);
        mount.appendChild(kits.kitsAndPiecesPanel());
        mount.appendChild(js.createJobMaterialSheetPanel({ jobId: 'job-1' }).root);
        await new Promise((r) => setTimeout(r, 250));
        for (const b of mount.querySelectorAll('button')) {
          if (/^(Start a sheet|Add component|Add a material)$/.test(b.textContent.trim())) {
            b.click();
          }
        }
        for (const d of mount.querySelectorAll('details')) d.open = true;
        await new Promise((r) => setTimeout(r, 200));
        const w = document.documentElement.scrollWidth;
        mount.remove();
        return { scrollWidth: w, viewport: window.innerWidth };
      });
      assert.ok(over.scrollWidth <= over.viewport + 1,
        `document is ${over.scrollWidth}px wide at ${over.viewport}px`);
    });
    await page.setViewportSize({ width: 1280, height: 900 });
  }

  await browser.close();
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.ok ? '' : `\n      ${r.err}`}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed) process.exit(1);
})();
