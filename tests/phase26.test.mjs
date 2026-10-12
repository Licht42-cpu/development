// Phase 26 -- Batch 10.1: the daily load screen.
//
// Run directly:   node tests/phase26.test.mjs      (static server on :8743)
//
// MOCKED BROWSER TESTS against the real component with api.js stubbed. The
// database side is covered executably by tests/db/batch10-1.test.mjs.
// NO MIGRATION IN THIS REPOSITORY HAS BEEN APPLIED TO PRODUCTION.
//
// What these pin:
//
//   * Building and confirming are two separate acts. Opening the screen
//     must never create a revision, and confirming must say plainly that it
//     is the step that moves stock.
//   * The six quantities are labelled. An unlabelled row of figures is how
//     "free at Base" gets read as "on the van".
//   * A level supply shows Empty/Low/Enough and NEVER a zero.
//   * "Needs review" and "short" are shown as different problems, because
//     they need different action.
//   * A manual Keep is reversible from the same control that set it.

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
    if (globalThis.__failNext > 0) { globalThis.__failNext--; throw new Error(globalThis.__failWith || 'Network unreachable'); }
  }
  export function newOperationId(p) { return (p || 'op') + '-fixed'; }
  export async function listStockLocations() { return clone(globalThis.__LOCATIONS); }
  // THE ENVELOPE, as daily-load contract v2 §1 freezes it. Before the 10.1
  // corrective this returned the plan itself, which is the DTO drift
  // Codex's review found: the screen was handed a shape the document did
  // not describe.
  export async function getLoadPlan(a) {
    push('getLoadPlan', a);
    const plan = clone(globalThis.__PLAN);
    return {
      location_id: 'loc-car-a', location_code: a.locationCode,
      location_name: 'Car A', work_date: a.workDate,
      state: plan ? plan.status : 'none',
      can_build: globalThis.__CAN_BUILD !== false,
      plan,
      needs_review_count: plan
        ? plan.lines.filter((l) => l.data_state === 'needs_review').length : 0,
      unassigned_job_count: globalThis.__UNASSIGNED ?? 0,
      // v2.1: which day the backend treated this date as, and whether the
      // owner has chosen the zone or it fell back to UTC.
      work_day_timezone: globalThis.__TZ ?? null,
      work_day_timezone_state: globalThis.__TZ ? 'configured' : 'unconfigured',
      day: { work_date: a.workDate, jobs: [],
             work_day_timezone: globalThis.__TZ ?? null,
             work_day_timezone_state: globalThis.__TZ ? 'configured' : 'unconfigured',
             window_starts_at: a.workDate + 'T00:00:00Z',
             window_ends_at: a.workDate + 'T24:00:00Z',
             readable_vehicles: clone(globalThis.__LOCATIONS) }
    };
  }
  export async function loadDaySummary(a) { push('loadDaySummary', a); return { work_date: a.workDate, jobs: [], readable_vehicles: clone(globalThis.__LOCATIONS) }; }
  export async function nextDaySuggestions(a) { push('nextDaySuggestions', a); return clone(globalThis.__SUGGESTIONS); }
  export async function buildLoadPlan(a) { push('buildLoadPlan', a); await gate(); return {}; }
  export async function confirmLoadPlan(a) { push('confirmLoadPlan', a); await gate(); return {}; }
  export async function setManualKeep(a) { push('setManualKeep', a); await gate(); return {}; }
  export async function authoriseLoadException(a) { push('authoriseLoadException', a); await gate(); return {}; }
  export async function reconcileDayEnd(a) { push('reconcileDayEnd', a); await gate(); return {}; }
`;

const LOCATIONS = [
  { id: 'loc-base', code: 'base', name: 'Base', kind: 'base' },
  { id: 'loc-car-a', code: 'car_a', name: 'Car A', kind: 'vehicle' }
];

const line = (over = {}) => ({
  line_id: 'l1', line_kind: 'consumable', action: 'add',
  material_id: 'mat-1', material_name: 'FIXTURE soft-wash product',
  rental_set_id: null, set_code: null,
  required_qty: 12, aboard_qty: 0, reserved_qty: 0, available_qty: 500,
  damaged_qty: 0, shortage_qty: 0, unit: 'litre',
  precision: 'exact', level_state: null, data_state: 'complete',
  reason: 'For Siding Soft Washing', job_ids: ['job-1'],
  manual_keep: false, confirmed_operation: null,
  ...over
});

const PLAN = (over = {}) => ({
  plan_id: 'plan-1', location_code: 'car_a', location_name: 'Car A',
  work_date: '2027-04-05', revision: 2, status: 'current',
  basis_fingerprint: 'abc123', lines_fingerprint: 'lines-def456',
  generated_at: '2027-04-05T07:00:00Z',
  confirmed_at: null, closed_at: null,
  lines: [
    line(),
    line({ line_id: 'l2', line_kind: 'equipment', action: 'keep',
           material_id: 'mat-washer', material_name: 'FIXTURE pressure washer',
           required_qty: 1, aboard_qty: 1, available_qty: 1, unit: 'each',
           reason: 'Needed for Siding Soft Washing' }),
    line({ line_id: 'l3', line_kind: 'equipment', action: 'return',
           material_id: 'mat-bleach', material_name: 'FIXTURE soft-wash kit',
           required_qty: 0, aboard_qty: 1, available_qty: 0, unit: 'each',
           reason: 'No job today needs it' }),
    line({ line_id: 'l4', line_kind: 'consumable', action: 'keep',
           material_id: 'mat-rinse', material_name: 'FIXTURE rinse aid',
           required_qty: null, aboard_qty: null, reserved_qty: null,
           available_qty: null, damaged_qty: null, shortage_qty: null,
           unit: null, level_state: 'low', reason: 'For Siding Soft Washing' }),
    line({ line_id: 'l5', line_kind: 'seasonal_set', action: 'add',
           material_id: null, material_name: null,
           rental_set_id: 'set-1', set_code: 'FIXTURE-SET-01',
           required_qty: null, aboard_qty: null, reserved_qty: null,
           available_qty: null, damaged_qty: null, shortage_qty: null,
           unit: null, reason: 'Promised to this customer for 2027' }),
    line({ line_id: 'l6', material_id: 'mat-scarce',
           material_name: 'FIXTURE scarce product',
           required_qty: 90, aboard_qty: 0, available_qty: 10, shortage_qty: 80,
           reason: 'For Siding Soft Washing' }),
    line({ line_id: 'l7', material_id: 'mat-unknown',
           material_name: 'FIXTURE unknown allowance',
           required_qty: null, aboard_qty: 0, available_qty: 0, shortage_qty: null,
           precision: 'estimated', data_state: 'needs_review',
           reason: 'For Siding — no allowance recorded, so the amount is unknown' })
  ],
  ...over
});

const SUGGESTIONS = {
  location_code: 'car_a', work_date: '2027-04-05',
  note: 'Suggestions only. Nothing here reserves, orders or moves stock.',
  shortages: [{ material_id: 'mat-scarce', material_name: 'FIXTURE scarce product',
                shortage_qty: 80, unit: 'litre' }],
  baseline_gaps: [{ material_id: 'mat-salt', material_name: 'FIXTURE de-icer',
                    target_qty: 200, aboard_qty: 40, gap_qty: 160 }],
  needs_review: []
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
  rowFor: (scope, name) => [...scope.querySelectorAll('[data-plan-line]')]
    .find((n) => (n.querySelector('strong')?.textContent || '') === name),
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

  const withPanel = (opts, body) => page.evaluate(
    async ({ fixtures, options, bodySrc, helpersSrc }) => {
      Object.assign(globalThis, fixtures);
      globalThis.__calls = [];
      globalThis.__failNext = options.failNext || 0;
      globalThis.__failWith = options.failWith || null;
      globalThis.__confirms = [];
      if (!globalThis.__realConfirm) globalThis.__realConfirm = window.confirm;
      window.confirm = (m) => {
        globalThis.__confirms.push(m);
        return options.declineConfirm ? false : true;
      };

      const mod = await import('/admin/js/components/load-plan.js');
      const mount = document.createElement('div');
      document.body.appendChild(mount);
      mount.appendChild(mod.loadPlanPanel({ locationCode: 'car_a', workDate: '2027-04-05' }));

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
      fixtures: {
        __LOCATIONS: opts.locations || LOCATIONS,
        __PLAN: 'plan' in opts ? opts.plan : PLAN(),
        __SUGGESTIONS: opts.suggestions || SUGGESTIONS,
        __CAN_BUILD: 'canBuild' in opts ? opts.canBuild : true,
        __UNASSIGNED: opts.unassigned ?? 0,
        __TZ: 'timezone' in opts ? opts.timezone : null
      },
      options: opts,
      bodySrc: body.toString(),
      helpersSrc: HELPERS.toString()
    });

  return { browser, page, withPanel };
}

(async () => {
  const { browser, page, withPanel } = await launch();

  // ====================================== A. recommend vs move ===========
  await record('A1 opening the screen reads a plan and never builds one', async () => {
    const { calls } = await withPanel({}, async ({ h }) => { await h.settle(150); });
    assert.ok(calls.some((c) => c.name === 'getLoadPlan'));
    assert.equal(calls.filter((c) => c.name === 'buildLoadPlan').length, 0,
      'opening a page must not create a revision');
  });

  await record('A2 with no plan the screen offers to build one, and says it moves nothing',
    async () => {
      const { out } = await withPanel({ plan: null }, async ({ mount, h }) => {
        await h.settle(150);
        return { buttons: h.buttonTexts(mount), text: mount.textContent };
      });
      assert.ok(out.buttons.includes('Build the plan'));
      assert.match(out.text, /moves nothing/i);
    });

  await record('A3 confirming warns that this is the step that moves stock', async () => {
    const { confirms, calls } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(150);
      h.button(mount, 'Confirm the load').click();
      await h.settle(150);
    });
    assert.equal(confirms.length, 1);
    assert.match(confirms[0], /actually moves stock/i);
    const call = calls.find((c) => c.name === 'confirmLoadPlan');
    assert.ok(call);
    assert.equal(call.args.planId, 'plan-1');
    assert.equal(call.args.expectedRevision, 2,
      'the revision you looked at is the one you confirm');
    assert.equal(call.args.expectedFingerprint, 'abc123');
    assert.equal(call.args.expectedLinesFingerprint, 'lines-def456',
      'the recommendation lock is quoted from the plan the screen rendered');
  });

  await record('A4 declining the confirm moves nothing', async () => {
    const { calls } = await withPanel({ declineConfirm: true }, async ({ mount, h }) => {
      await h.settle(150);
      h.button(mount, 'Confirm the load').click();
      await h.settle(150);
    });
    assert.equal(calls.filter((c) => c.name === 'confirmLoadPlan').length, 0);
  });

  await record('A5 a confirmed plan offers no second confirmation', async () => {
    const { out } = await withPanel(
      { plan: PLAN({ status: 'confirmed', confirmed_at: '2027-04-05T08:00:00Z' }) },
      async ({ mount, h }) => {
        await h.settle(150);
        return { buttons: h.buttonTexts(mount), text: mount.textContent };
      });
    assert.ok(!out.buttons.includes('Confirm the load'));
    assert.match(out.text, /balances have changed/i);
  });

  await record('A6 a stale-revision refusal reaches the operator intact', async () => {
    const { out } = await withPanel({
      failNext: 1,
      failWith: 'You confirmed revision 2 but the current one is 3. Reload the plan.'
    }, async ({ mount, h }) => {
      await h.settle(150);
      h.button(mount, 'Confirm the load').click();
      await h.settle(250);
      return document.getElementById('toast')?.textContent || '';
    });
    assert.match(out, /current one is 3/,
      'the backend\'s sentence is what the operator needs, not a generic error');
  });

  // ====================================== B. the six quantities ==========
  await record('B1 each quantity is labelled with what it means', async () => {
    const { out } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(150);
      return h.rowFor(mount, 'FIXTURE soft-wash product').textContent;
    });
    assert.match(out, /needs 12/);
    assert.match(out, /aboard 0/);
    assert.match(out, /500 free at Base/);
    assert.match(out, /\(litre\)/);
  });

  await record('B2 stock promised elsewhere is named as such', async () => {
    const p = PLAN();
    p.lines[0].reserved_qty = 30;
    const { out } = await withPanel({ plan: p }, async ({ mount, h }) => {
      await h.settle(150);
      return h.rowFor(mount, 'FIXTURE soft-wash product').textContent;
    });
    assert.match(out, /30 promised elsewhere/);
  });

  await record('B3 damaged stock is shown separately from usable', async () => {
    const p = PLAN();
    p.lines[0].damaged_qty = 5;
    const { out } = await withPanel({ plan: p }, async ({ mount, h }) => {
      await h.settle(150);
      return h.rowFor(mount, 'FIXTURE soft-wash product').textContent;
    });
    assert.match(out, /5 damaged/);
  });

  // ====================================== C. levels ======================
  await record('C1 a level supply shows the level and never a zero', async () => {
    const { out } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(150);
      return h.rowFor(mount, 'FIXTURE rinse aid').textContent;
    });
    assert.match(out, /Low/);
    assert.match(out, /no quantity to show/i);
    assert.ok(!/aboard 0/.test(out), 'a null quantity must not render as zero');
    assert.ok(!/needs 0/.test(out));
  });

  // ============================= D. needs review vs short ================
  await record('D1 "needs review" and "short" are shown as different problems',
    async () => {
      const { out } = await withPanel({}, async ({ mount, h }) => {
        await h.settle(150);
        return mount.textContent;
      });
      assert.match(out, /Needs review/);
      assert.match(out, /Not a shortage/i);
      assert.match(out, /Short/);
      assert.match(out, /Known gaps/i);
    });

  await record('D2 a known shortage names the amount', async () => {
    const { out } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(150);
      return mount.textContent;
    });
    assert.match(out, /FIXTURE scarce product: short 80/);
  });

  await record('D3 an estimated figure is badged as estimated', async () => {
    const { out } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(150);
      return h.rowFor(mount, 'FIXTURE unknown allowance').textContent;
    });
    assert.match(out, /Estimated/);
    assert.match(out, /amount is unknown/i);
    assert.ok(!/needs 0/.test(out),
      'an unknown requirement must never render as zero -- zero is a claim');
  });

  // ====================================== E. the day's shape =============
  await record('E1 Keep, Add and Return are three labelled groups', async () => {
    const { out } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(150);
      return mount.textContent;
    });
    assert.match(out, /Keep aboard/);
    assert.match(out, /What stays on the van/);
    assert.match(out, /Add \(/);
    assert.match(out, /Return \(/);
    assert.match(out, /take off and leave at Base/i);
  });

  await record('E2 a Christmas set is shown as a set, with no quantity', async () => {
    const { out } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(150);
      return h.rowFor(mount, 'FIXTURE-SET-01').textContent;
    });
    assert.match(out, /Christmas set/);
    assert.match(out, /Promised to this customer/);
    assert.ok(!/aboard/.test(out), 'a set has no balance to report');
  });

  await record('E3 a set offers no manual-keep control, because it is not stock',
    async () => {
      const { out } = await withPanel({}, async ({ mount, h }) => {
        await h.settle(150);
        return h.buttonTexts(h.rowFor(mount, 'FIXTURE-SET-01'));
      });
      assert.deepEqual(out, []);
    });

  // ====================================== F. manual keep =================
  await record('F1 keeping something back sends keep=true with the day and material',
    async () => {
      const { calls } = await withPanel({}, async ({ mount, h }) => {
        await h.settle(150);
        h.button(h.rowFor(mount, 'FIXTURE soft-wash kit'), 'Keep it back').click();
        await h.settle(150);
      });
      const call = calls.find((c) => c.name === 'setManualKeep');
      assert.ok(call);
      assert.equal(call.args.keep, true);
      assert.equal(call.args.materialId, 'mat-bleach');
      assert.equal(call.args.workDate, '2027-04-05');
      assert.equal(call.args.locationCode, 'car_a');
    });

  await record('F2 a kept item is badged, and the control reverses it', async () => {
    const p = PLAN();
    p.lines[2].manual_keep = true;
    p.lines[2].action = 'keep';
    p.lines[2].reason = 'Kept back on purpose: rain forecast';
    const { out, calls } = await withPanel({ plan: p }, async ({ mount, h }) => {
      await h.settle(150);
      const row = h.rowFor(mount, 'FIXTURE soft-wash kit');
      const text = row.textContent;
      h.button(row, 'Stop keeping it back').click();
      await h.settle(150);
      return text;
    });
    assert.match(out, /Kept on purpose/);
    assert.match(out, /rain forecast/);
    const call = calls.find((c) => c.name === 'setManualKeep');
    assert.equal(call.args.keep, false);
  });

  await record('F3 a confirmed plan offers no manual-keep changes', async () => {
    const { out } = await withPanel(
      { plan: PLAN({ status: 'confirmed', confirmed_at: '2027-04-05T08:00:00Z' }) },
      async ({ mount, h }) => {
        await h.settle(150);
        return h.buttonTexts(mount);
      });
    assert.ok(!out.includes('Keep it back'));
  });

  // ====================================== G. suggestions =================
  await record('G1 suggestions say plainly that they commit nothing', async () => {
    const { out } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(150);
      const d = [...mount.querySelectorAll('details')].pop();
      d.open = true;
      await h.settle(60);
      return d.textContent;
    });
    assert.match(out, /reserves, orders or moves/i);
    assert.match(out, /FIXTURE de-icer/);
    assert.match(out, /160 short of the standing load/);
  });

  // ====================================== H. phone layout ================
  for (const width of [390, 430]) {
    await record(`H${width === 390 ? 1 : 2} no horizontal overflow at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 900 });
      const over = await page.evaluate(async () => {
        globalThis.__calls = [];
        const mod = await import('/admin/js/components/load-plan.js');
        const mount = document.createElement('div');
        document.body.appendChild(mount);
        mount.appendChild(mod.loadPlanPanel({ locationCode: 'car_a', workDate: '2027-04-05' }));
        await new Promise((r) => setTimeout(r, 250));
        for (const d of mount.querySelectorAll('details')) d.open = true;
        await new Promise((r) => setTimeout(r, 150));
        const w = document.documentElement.scrollWidth;
        mount.remove();
        return { scrollWidth: w, viewport: window.innerWidth };
      });
      assert.ok(over.scrollWidth <= over.viewport + 1,
        `document is ${over.scrollWidth}px wide at ${over.viewport}px`);
    });
    await page.setViewportSize({ width: 1280, height: 900 });
  }

  // ============ L. the 10.1 corrective's read envelope ==================

  await record('L1 a crew facing an empty day is told who can build one, not shown a button',
    async () => {
      const { out } = await withPanel({ plan: null, canBuild: false },
        async ({ mount, h }) => {
          await h.settle(200);
          return { text: mount.textContent, buttons: h.buttonTexts(mount) };
        });
      assert.match(out.text, /Only the owner builds a plan/i);
      assert.ok(!out.buttons.includes('Build the plan'),
        'a button that will refuse the caller is worse than a sentence');
    });

  await record('L2 the owner still gets the build button, and it says it moves nothing',
    async () => {
      const { out } = await withPanel({ plan: null, canBuild: true },
        async ({ mount, h }) => {
          await h.settle(200);
          return { text: mount.textContent, buttons: h.buttonTexts(mount) };
        });
      assert.ok(out.buttons.includes('Build the plan'));
      assert.match(out.text, /moves nothing/i);
    });

  /* ======================================================================
     M. THE SECOND ROUND OF THE SAME REVIEW, on this screen.
     daily-load contract v2.1: the operating day has to be visible when
     nobody has set one, an owner-authorised departure has to be visible at
     all, and a refused confirmation has to leave the operator looking at
     what the plan says now rather than at the screen that was refused.
     ====================================================================== */
  await record('M1 an unset operating timezone is said out loud, not assumed',
    async () => {
      const { out } = await withPanel({}, async ({ mount, h }) => {
        await h.settle(200);
        return { text: mount.textContent };
      });
      assert.match(out.text, /no timezone set/i);
      assert.match(out.text, /next day/i,
        'and it says what goes wrong, not just that a setting is missing');
    });

  await record('M2 a configured operating day says nothing at all', async () => {
    const { out } = await withPanel({ timezone: 'America/Edmonton' },
      async ({ mount, h }) => {
        await h.settle(200);
        return { text: mount.textContent };
      });
    assert.ok(!/no timezone set/i.test(out.text),
      'a solved problem must not keep nagging');
  });

  await record('M3 the empty state carries the same warning', async () => {
    const { out } = await withPanel({ plan: null }, async ({ mount, h }) => {
      await h.settle(200);
      return { text: mount.textContent };
    });
    assert.match(out.text, /no timezone set/i,
      'which day a plan would cover matters before one exists too');
  });

  await record('M4 an owner-authorised set-aside is on the screen, not just in the response',
    async () => {
      const { out } = await withPanel({
        plan: PLAN({ lines: [
          line({ line_id: 'sk1', action: 'skip', data_state: 'exception',
                 material_name: 'FIXTURE soft-wash product',
                 exception_id: 'exc-1',
                 reason: 'Owner authorised going without it: borrowed one' })
        ] })
      }, async ({ mount, h }) => {
        await h.settle(200);
        return { text: mount.textContent, buttons: h.buttonTexts(mount) };
      });
      assert.match(out.text, /Set aside/i, 'the group exists');
      assert.match(out.text, /Confirming does not move them/i);
      assert.match(out.text, /borrowed one/i, 'and the authorisation reason is shown');
      assert.match(out.text, /Owner authorised/,
        'badged like Needs review and Estimated, so it is scannable');
      // A keep is "do not take it off the van"; a skip is the owner saying
      // go without it. Offering the crew a button that reads as overriding
      // an authorisation is misleading even though the backend refuses to
      // overwrite it (batch10-1 L10).
      assert.ok(!out.buttons.includes('Keep it back'),
        'an owner-authorised set-aside offers the crew no override');
    });

  await record('M5 a refused confirmation re-reads, so the operator sees the new plan',
    async () => {
      const { calls } = await withPanel(
        { failNext: 1,
          failWith: 'What this plan recommends changed after you looked at it' },
        async ({ mount, h }) => {
          await h.settle(150);
          h.button(mount, 'Confirm the load').click();
          await h.settle(250);
        });
      const reads = calls.filter((c) => c.name === 'getLoadPlan').length;
      assert.ok(reads >= 2,
        'a refusal leaves the screen stale unless it reloads; it read ' + reads);
      assert.equal(calls.filter((c) => c.name === 'confirmLoadPlan').length, 1,
        'and it does not silently retry the confirmation');
    });

  await browser.close();
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.ok ? '' : `\n      ${r.err}`}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed) process.exit(1);
})();
