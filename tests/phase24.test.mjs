// Phase 24 -- Batch 9.1: company-owned Christmas sets and seasonal recovery.
//
// Run directly:   node tests/phase24.test.mjs      (static server on :8743)
//
// These are MOCKED BROWSER TESTS against the real
// admin/js/components/seasonal-sets.js with api.js stubbed, so they prove
// the panel's own logic and nothing about the live database. The database
// side is covered executably by tests/db/batch9-1.test.mjs against a
// disposable PostgreSQL. NO BATCH 9.1 MIGRATION HAS BEEN APPLIED TO
// PRODUCTION, so nothing here says anything about what the live project
// enforces.
//
// What these pin, and why each is worth a test:
//
//   * Only the transitions the database will accept are OFFERED. The 8.1
//     screen offered "Mark installed" on a lost set because its conditions
//     were written as a pile of negations; here every button comes from an
//     explicit from-state, and these cases are what stops that regressing.
//
//   * A set that is installed, assigned, uninspected, damaged, lost or
//     retired must not read as available. Five separate reasons, each shown
//     as a sentence -- an operator who cannot see WHY will ring the office.
//
//   * Release is refused, visibly and with a reason, until an inspection
//     exists. The database refuses it too; a disabled button with an
//     explanation beats a server error the operator cannot act on.
//
//   * Recovery records what came back, not a verdict. The copy has to say
//     so, because "looks fine" and "inspected and usable" are the two
//     things this whole batch exists to keep apart.
//
//   * Non-renewal changes nothing physical, and the recovery cutoff is the
//     owner's or absent -- never a date the screen invented.
//
//   * Writes show a busy state on the button that was pressed, and a
//     failure says why instead of repainting as though it worked.

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

  async function gate(name) {
    if (globalThis.__hang) { await new Promise(() => {}); }
    if (globalThis.__failNext > 0) { globalThis.__failNext--; throw new Error('Network unreachable'); }
  }

  export function newOperationId(prefix) { return (prefix || 'op') + '-fixed-for-tests'; }

  export async function listSeasonalSets(opts) {
    push('listSeasonalSets', opts);
    if (globalThis.__listFails) throw new Error('Network unreachable');
    return clone(globalThis.__SETS);
  }
  export async function listSeasonalAssignments(opts) {
    push('listSeasonalAssignments', opts);
    const all = clone(globalThis.__ASSIGNMENTS || []);
    if (opts && opts.openOnly) {
      return all.filter((a) => ['assigned', 'installed', 'removed'].includes(a.status));
    }
    if (opts && opts.setId) return all.filter((a) => a.set_id === opts.setId);
    return all;
  }
  export async function listRentalSetEvents(id) {
    push('listRentalSetEvents', { id });
    return clone(globalThis.__SET_EVENTS || []);
  }
  export async function searchCustomers(opts) {
    push('searchCustomers', opts);
    return clone(globalThis.__CUSTOMERS || []);
  }

  export async function registerSeasonalSet(a)      { push('registerSeasonalSet', a); await gate(); return {}; }
  export async function assignSeasonalSet(a)        { push('assignSeasonalSet', a); await gate(); return {}; }
  export async function cancelSeasonalAssignment(a) { push('cancelSeasonalAssignment', a); await gate(); return {}; }
  export async function installSeasonalSet(a)       { push('installSeasonalSet', a); await gate(); return {}; }
  export async function recoverSeasonalSet(a)       { push('recoverSeasonalSet', a); await gate(); return {}; }
  export async function inspectSeasonalSet(a)       { push('inspectSeasonalSet', a); await gate(); return {}; }
  export async function releaseSeasonalSet(a)       { push('releaseSeasonalSet', a); await gate(); return {}; }
  export async function recordSetRenewal(a)         { push('recordSetRenewal', a); await gate(); return {}; }
  export async function retireSeasonalSet(a)        { push('retireSeasonalSet', a); await gate(); return {}; }
`;

/* ------------------------------------------------------------- fixtures -- */

/** Availability-view rows. Shaped exactly like ns_seasonal_set_availability,
 *  because the panel reads that view and nothing else -- a fixture with
 *  convenient extra fields would hide a missing column. */
const availability = (over = {}) => ({
  set_id: 'set-x', set_code: 'FIXTURE-X', status: 'in_storage',
  condition: 'usable', run_type: 'roofline', colour: 'warm white',
  linear_ft: 40, storage_location: null, location_id: 'loc-base',
  location_code: 'base', inspected_at: '2026-01-20T10:00:00Z',
  active_assignment_id: null, active_customer_id: null,
  active_season_year: null, active_assignment_status: null,
  has_active_assignment: false, awaiting_release: false, needs_inspection: false,
  needs_repair_or_search: false, out_of_service: false,
  at_the_repair_bench: false, available_for_reuse: true,
  ...over
});

const SETS = [
  // ready for the next customer
  availability({ set_id: 'set-ready', set_code: 'FIXTURE-READY' }),
  // back from a job, nobody has looked at it
  availability({
    set_id: 'set-uninspected', set_code: 'FIXTURE-UNINSPECTED',
    condition: 'uninspected', inspected_at: null,
    needs_inspection: true, available_for_reuse: false
  }),
  // promised, not yet up
  availability({
    set_id: 'set-assigned', set_code: 'FIXTURE-ASSIGNED',
    active_assignment_id: 'asg-assigned', active_customer_id: 'cust-1',
    active_season_year: 2026, active_assignment_status: 'assigned',
    has_active_assignment: true, available_for_reuse: false
  }),
  // up at a property
  availability({
    set_id: 'set-deployed', set_code: 'FIXTURE-DEPLOYED', status: 'deployed',
    location_id: null, location_code: null,
    active_assignment_id: 'asg-deployed', active_customer_id: 'cust-1',
    active_season_year: 2026, active_assignment_status: 'installed',
    has_active_assignment: true, available_for_reuse: false
  }),
  // recovered, not inspected -- release must be blocked
  availability({
    set_id: 'set-recovered', set_code: 'FIXTURE-RECOVERED',
    condition: 'uninspected', inspected_at: null, needs_inspection: true,
    active_assignment_id: 'asg-recovered', active_customer_id: 'cust-2',
    active_season_year: 2026, active_assignment_status: 'removed',
    has_active_assignment: true, awaiting_release: true,
    available_for_reuse: false
  }),
  // recovered and inspected -- release must be open, and until it happens
  // the set is still held by last season's assignment
  availability({
    set_id: 'set-cleared', set_code: 'FIXTURE-CLEARED',
    active_assignment_id: 'asg-cleared', active_customer_id: 'cust-2',
    active_season_year: 2026, active_assignment_status: 'removed',
    has_active_assignment: true, awaiting_release: true,
    available_for_reuse: false
  }),
  // at the bench
  availability({
    set_id: 'set-repair', set_code: 'FIXTURE-REPAIR', status: 'in_repair',
    condition: 'damaged', needs_repair_or_search: true,
    at_the_repair_bench: true, available_for_reuse: false
  }),
  // never came back
  availability({
    set_id: 'set-lost', set_code: 'FIXTURE-LOST', status: 'lost',
    condition: 'missing', location_id: null, location_code: null,
    needs_repair_or_search: true, out_of_service: true, available_for_reuse: false
  }),
  // finished with
  availability({
    set_id: 'set-retired', set_code: 'FIXTURE-RETIRED', status: 'retired',
    out_of_service: true, available_for_reuse: false
  })
];

const ASSIGNMENTS = [
  { id: 'asg-assigned', set_id: 'set-assigned', customer_id: 'cust-1',
    property_id: null, job_id: null, season_year: 2026, status: 'assigned',
    renewal_state: 'pending', recovery_condition: null, release_cutoff: null,
    installed_at: null, removed_at: null, released_at: null,
    customers: { id: 'cust-1', name: 'FIXTURE Patterson' } },
  { id: 'asg-deployed', set_id: 'set-deployed', customer_id: 'cust-1',
    property_id: null, job_id: null, season_year: 2026, status: 'installed',
    renewal_state: 'pending', recovery_condition: null, release_cutoff: null,
    installed_at: '2025-11-20T15:00:00Z', removed_at: null, released_at: null,
    customers: { id: 'cust-1', name: 'FIXTURE Patterson' } },
  { id: 'asg-recovered', set_id: 'set-recovered', customer_id: 'cust-2',
    property_id: null, job_id: null, season_year: 2026, status: 'removed',
    renewal_state: 'not_renewed', recovery_condition: 'usable',
    release_cutoff: null, installed_at: '2025-11-20T15:00:00Z',
    removed_at: '2026-01-10T15:00:00Z', released_at: null,
    customers: { id: 'cust-2', name: 'FIXTURE Okonkwo' } },
  { id: 'asg-cleared', set_id: 'set-cleared', customer_id: 'cust-2',
    property_id: null, job_id: null, season_year: 2026, status: 'removed',
    renewal_state: 'pending', recovery_condition: 'usable',
    release_cutoff: null, installed_at: '2025-11-20T15:00:00Z',
    removed_at: '2026-01-10T15:00:00Z', released_at: null,
    customers: { id: 'cust-2', name: 'FIXTURE Okonkwo' } }
];

const CUSTOMERS = [
  { id: 'cust-1', name: 'FIXTURE Patterson' },
  { id: 'cust-2', name: 'FIXTURE Okonkwo' }
];

const HELPERS = () => ({
  rowFor: (scope, code) => [...scope.querySelectorAll('[data-set-row]')]
    .find((n) => (n.querySelector('strong')?.textContent || '') === code),
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

/* --------------------------------------------------------------- launch -- */

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
      globalThis.__listFails = !!options.listFails;
      globalThis.__hang = !!options.hang;
      globalThis.__confirms = [];
      if (!globalThis.__realConfirm) globalThis.__realConfirm = window.confirm;
      window.confirm = (msg) => {
        globalThis.__confirms.push(msg);
        return options.declineConfirm ? false : true;
      };

      const mod = await import('/admin/js/components/seasonal-sets.js');
      const mount = document.createElement('div');
      document.body.appendChild(mount);
      mount.appendChild(mod.seasonalSetsPanel());

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
        __SETS: opts.sets || SETS,
        __ASSIGNMENTS: opts.assignments || ASSIGNMENTS,
        __CUSTOMERS: opts.customers || CUSTOMERS,
        __SET_EVENTS: opts.setEvents || []
      },
      options: opts,
      bodySrc: body.toString(),
      helpersSrc: HELPERS.toString()
    });

  return { browser, page, withPanel };
}

(async () => {
  const { browser, page, withPanel } = await launch();

  // ================================================== A. loading state ====
  await record('A1 the panel says it is loading before the first rows arrive', async () => {
    const { out } = await withPanel({}, async ({ mount }) => mount.textContent);
    assert.match(out, /Loading sets/,
      'read synchronously, before any settle -- an empty card reads as "no sets"');
  });

  await record('A2 a failed load gives the reason and never an empty list', async () => {
    const { out } = await withPanel({ listFails: true }, async ({ mount, h }) => {
      await h.settle(120);
      return mount.textContent;
    });
    assert.match(out, /Could not load the sets/);
    assert.ok(!/No sets recorded yet/.test(out),
      'a failure must not read as "you own no sets"');
  });

  await record('A3 the list reads the availability view, not the sets table', async () => {
    const { calls } = await withPanel({}, async ({ h }) => { await h.settle(120); });
    assert.ok(calls.some((c) => c.name === 'listSeasonalSets'));
    assert.ok(calls.some((c) => c.name === 'listSeasonalAssignments'
      && c.args.openOnly === true),
      'OPEN, not active: a recovered set still has an assignment to release');
  });

  // ============================================= B. what is offered =======
  await record('B1 a ready set is offered to a customer and says it is ready', async () => {
    const { out } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(120);
      const row = h.rowFor(mount, 'FIXTURE-READY');
      return { buttons: h.buttonTexts(row), text: row.textContent };
    });
    assert.ok(out.buttons.includes('Assign to a customer'));
    assert.match(out.text, /ready for the next customer/i);
    assert.match(out.text, /Available/);
  });

  await record('B2 an uninspected set is NOT offered to a customer, and says why', async () => {
    const { out } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(120);
      const row = h.rowFor(mount, 'FIXTURE-UNINSPECTED');
      return { buttons: h.buttonTexts(row), text: row.textContent };
    });
    assert.ok(!out.buttons.includes('Assign to a customer'),
      'the database refuses it; offering the button would read as a bug');
    assert.ok(out.buttons.includes('Record inspection'));
    assert.match(out.text, /Not inspected since it came back/);
  });

  await record('B3 an assigned set offers install and cancel, not assign', async () => {
    const { out } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(120);
      const row = h.rowFor(mount, 'FIXTURE-ASSIGNED');
      return { buttons: h.buttonTexts(row), text: row.textContent };
    });
    assert.ok(out.buttons.includes('Mark installed'));
    assert.ok(out.buttons.includes('Cancel assignment'));
    assert.ok(!out.buttons.includes('Assign to a customer'));
    assert.match(out.text, /FIXTURE Patterson/, 'and says who has it');
    assert.match(out.text, /2026/);
  });

  await record('B4 a deployed set offers recovery and renewal, not install or assign', async () => {
    const { out } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(120);
      const row = h.rowFor(mount, 'FIXTURE-DEPLOYED');
      return h.buttonTexts(row);
    });
    assert.ok(out.includes('Record recovery'));
    assert.ok(out.includes('Record renewal'));
    assert.ok(!out.includes('Mark installed'));
    assert.ok(!out.includes('Assign to a customer'));
    assert.ok(!out.includes('Retire'), 'a set on somebody\'s roof is not retirable');
  });

  await record('B5 a lost set is offered nothing that assumes it exists', async () => {
    const { out } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(120);
      const row = h.rowFor(mount, 'FIXTURE-LOST');
      return { buttons: h.buttonTexts(row), text: row.textContent };
    });
    assert.ok(!out.buttons.includes('Assign to a customer'));
    assert.ok(!out.buttons.includes('Mark installed'));
    assert.ok(!out.buttons.includes('Record recovery'));
    assert.ok(out.buttons.includes('Re-inspect'), 'but it can be marked found');
    assert.match(out.text, /Last seen missing|Out of service/);
  });

  await record('B6 a retired set cannot be retired again or assigned', async () => {
    const { out } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(120);
      const row = h.rowFor(mount, 'FIXTURE-RETIRED');
      return h.buttonTexts(row);
    });
    assert.ok(!out.includes('Retire'));
    assert.ok(!out.includes('Assign to a customer'));
    assert.ok(!out.includes('Record inspection'));
  });

  await record('B7 a set at the bench says so and is not offered to anybody', async () => {
    const { out } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(120);
      const row = h.rowFor(mount, 'FIXTURE-REPAIR');
      return { buttons: h.buttonTexts(row), text: row.textContent };
    });
    assert.ok(!out.buttons.includes('Assign to a customer'));
    assert.ok(out.buttons.includes('Re-inspect'));
    assert.match(out.text, /At the repair bench/);
  });

  // ============================================ C. inspection gate ========
  await record('C1 release is refused, with a reason, until an inspection exists', async () => {
    const { out } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(120);
      const row = h.rowFor(mount, 'FIXTURE-RECOVERED');
      const btn = h.button(row, 'Release for reuse');
      return { present: !!btn, disabled: btn ? btn.disabled : null, text: row.textContent };
    });
    assert.equal(out.present, true, 'hiding it would leave no explanation at all');
    assert.equal(out.disabled, true);
    assert.match(out.text, /Inspect it before releasing/);
    assert.match(out.text, /not released yet/,
      'and the row says the set is still held by last season');
  });

  await record('C1b an inspected set is still NOT offerable until it is released',
    async () => {
      const { out } = await withPanel({}, async ({ mount, h }) => {
        await h.settle(120);
        const row = h.rowFor(mount, 'FIXTURE-CLEARED');
        return { buttons: h.buttonTexts(row), text: row.textContent };
      });
      assert.ok(!out.buttons.includes('Assign to a customer'),
        'otherwise one set answers to two open assignments and neither reads as stale');
      assert.match(out.text, /not released yet/);
      assert.ok(!/Available/.test(out.text));
    });

  await record('C2 an inspected set can be released', async () => {
    const { out, calls } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(120);
      const row = h.rowFor(mount, 'FIXTURE-CLEARED');
      const btn = h.button(row, 'Release for reuse');
      const disabled = btn.disabled;
      btn.click();
      await h.settle(150);
      return { disabled };
    });
    assert.equal(out.disabled, false);
    const call = calls.find((c) => c.name === 'releaseSeasonalSet');
    assert.ok(call, 'release must reach the RPC');
    assert.equal(call.args.assignmentId, 'asg-cleared');
  });

  // =========================================== D. recovery semantics ======
  await record('D1 the recovery form says it records what came back, not a verdict', async () => {
    const { out } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(120);
      h.button(h.rowFor(mount, 'FIXTURE-DEPLOYED'), 'Record recovery').click();
      await h.settle(80);
      return mount.querySelector('[data-inline]').textContent;
    });
    assert.match(out, /not whether it is reusable/i);
    assert.match(out, /back to "not inspected"/i);
  });

  await record('D2 recovery sends the condition chosen, and a blank location as null',
    async () => {
      const { calls } = await withPanel({}, async ({ mount, h }) => {
        await h.settle(120);
        h.button(h.rowFor(mount, 'FIXTURE-DEPLOYED'), 'Record recovery').click();
        await h.settle(80);
        const form = mount.querySelector('[data-inline]');
        h.labelled(form, 'What came back').value = 'damaged';
        h.button(form, 'Record recovery').click();
        await h.settle(150);
      });
      const call = calls.find((c) => c.name === 'recoverSeasonalSet');
      assert.ok(call);
      assert.equal(call.args.recoveryCondition, 'damaged');
      assert.equal(call.args.locationCode, null,
        'blank means the crew\'s own vehicle, which the backend decides');
      assert.equal(call.args.assignmentId, 'asg-deployed');
    });

  await record('D3 "came back, not looked at yet" is the default, not "looks fine"', async () => {
    const { out } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(120);
      h.button(h.rowFor(mount, 'FIXTURE-DEPLOYED'), 'Record recovery').click();
      await h.settle(80);
      const form = mount.querySelector('[data-inline]');
      return h.labelled(form, 'What came back').value;
    });
    assert.equal(out, 'uninspected',
      'the honest default: a set in a bag has not been assessed');
  });

  await record('D4 an inspection cannot conclude "uninspected"', async () => {
    const { out } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(120);
      h.button(h.rowFor(mount, 'FIXTURE-UNINSPECTED'), 'Record inspection').click();
      await h.settle(80);
      const form = mount.querySelector('[data-inline]');
      return [...h.labelled(form, 'Result').options].map((o) => o.value);
    });
    assert.deepEqual(out, ['usable', 'damaged', 'missing']);
  });

  await record('D5 the inspection result reaches the RPC as chosen', async () => {
    const { calls } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(120);
      h.button(h.rowFor(mount, 'FIXTURE-UNINSPECTED'), 'Record inspection').click();
      await h.settle(80);
      const form = mount.querySelector('[data-inline]');
      h.labelled(form, 'Result').value = 'damaged';
      h.button(form, 'Record inspection').click();
      await h.settle(150);
    });
    const call = calls.find((c) => c.name === 'inspectSeasonalSet');
    assert.ok(call);
    assert.equal(call.args.condition, 'damaged');
    assert.equal(call.args.setId, 'set-uninspected');
  });

  // ============================================== E. assignment ===========
  await record('E1 assigning without a customer writes nothing and says so', async () => {
    const { calls, out } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(120);
      h.button(h.rowFor(mount, 'FIXTURE-READY'), 'Assign to a customer').click();
      await h.settle(80);
      const form = mount.querySelector('[data-inline]');
      h.button(form, 'Assign').click();
      await h.settle(120);
      return form.textContent;
    });
    assert.equal(calls.filter((c) => c.name === 'assignSeasonalSet').length, 0);
    assert.match(out, /Choose a customer first/);
  });

  await record('E2 the season is a stated year, and it is what gets sent', async () => {
    const { calls } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(120);
      h.button(h.rowFor(mount, 'FIXTURE-READY'), 'Assign to a customer').click();
      await h.settle(80);
      const form = mount.querySelector('[data-inline]');
      h.button(form, 'Search').click();
      await h.settle(120);
      h.labelled(form, 'Choose').value = 'cust-2';
      h.labelled(form, 'Season').value = '2027';
      h.button(form, 'Assign').click();
      await h.settle(150);
    });
    const call = calls.find((c) => c.name === 'assignSeasonalSet');
    assert.ok(call);
    assert.equal(call.args.customerId, 'cust-2');
    assert.equal(call.args.seasonYear, 2027);
    assert.equal(call.args.setId, 'set-ready');
  });

  await record('E3 cancelling an assignment confirms, and says it is kept as history',
    async () => {
      const { calls, confirms } = await withPanel({}, async ({ mount, h }) => {
        await h.settle(120);
        h.button(h.rowFor(mount, 'FIXTURE-ASSIGNED'), 'Cancel assignment').click();
        await h.settle(150);
      });
      assert.equal(confirms.length, 1);
      assert.match(confirms[0], /kept as history, not deleted/);
      assert.equal(calls.filter((c) => c.name === 'cancelSeasonalAssignment').length, 1);
    });

  await record('E4 declining the confirm cancels nothing', async () => {
    const { calls } = await withPanel({ declineConfirm: true }, async ({ mount, h }) => {
      await h.settle(120);
      h.button(h.rowFor(mount, 'FIXTURE-ASSIGNED'), 'Cancel assignment').click();
      await h.settle(150);
    });
    assert.equal(calls.filter((c) => c.name === 'cancelSeasonalAssignment').length, 0);
  });

  // ============================================== F. renewal ==============
  await record('F1 non-renewal is shown as a decision that moved nothing', async () => {
    const { out } = await withPanel({
      sets: [availability({
        set_id: 'set-deployed', set_code: 'FIXTURE-DEPLOYED', status: 'deployed',
        location_id: null, location_code: null,
        active_assignment_id: 'asg-deployed', active_customer_id: 'cust-1',
        active_season_year: 2026, active_assignment_status: 'installed',
        has_active_assignment: true, available_for_reuse: false
      })],
      assignments: [{
        ...ASSIGNMENTS[1], renewal_state: 'not_renewed', release_cutoff: null
      }]
    }, async ({ mount, h }) => {
      await h.settle(120);
      return h.rowFor(mount, 'FIXTURE-DEPLOYED').textContent;
    });
    assert.match(out, /not renewing/i);
    assert.match(out, /taken down and recovered|taken down and recovered before/i);
    assert.match(out, /No recovery cutoff is set/,
      'with no owner cutoff the screen must say so rather than name a date');
  });

  await record('F2 an owner-set cutoff is shown; none is invented when it is unset',
    async () => {
      const { out } = await withPanel({
        sets: [availability({
          set_id: 'set-deployed', set_code: 'FIXTURE-DEPLOYED', status: 'deployed',
          location_id: null, location_code: null,
          active_assignment_id: 'asg-deployed', active_assignment_status: 'installed',
          active_customer_id: 'cust-1', active_season_year: 2026,
          has_active_assignment: true, available_for_reuse: false
        })],
        assignments: [{
          ...ASSIGNMENTS[1], renewal_state: 'not_renewed', release_cutoff: '2026-01-15'
        }]
      }, async ({ mount, h }) => {
        await h.settle(120);
        return h.rowFor(mount, 'FIXTURE-DEPLOYED').textContent;
      });
      assert.match(out, /cutoff for recovery/i);
      assert.ok(!/No recovery cutoff is set/.test(out));
    });

  await record('F3 the renewal form reaches the RPC with the chosen state', async () => {
    const { calls } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(120);
      h.button(h.rowFor(mount, 'FIXTURE-DEPLOYED'), 'Record renewal').click();
      await h.settle(80);
      const form = mount.querySelector('[data-inline]');
      h.labelled(form, 'Decision').value = 'renewed';
      h.button(form, 'Save').click();
      await h.settle(150);
    });
    const call = calls.find((c) => c.name === 'recordSetRenewal');
    assert.ok(call);
    assert.equal(call.args.renewalState, 'renewed');
    assert.equal(call.args.assignmentId, 'asg-deployed');
  });

  // ============================================== G. registration =========
  await record('G1 a set with no code writes nothing', async () => {
    const { calls } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(120);
      h.button(mount, 'Register a set').click();
      await h.settle(60);
      h.button(mount, 'Register').click();
      await h.settle(120);
    });
    assert.equal(calls.filter((c) => c.name === 'registerSeasonalSet').length, 0);
  });

  await record('G2 registration trims, sends a build quantity, and omits blanks', async () => {
    const { calls } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(120);
      h.button(mount, 'Register a set').click();
      await h.settle(60);
      h.labelled(mount, 'Set code').value = '  CHR-014  ';
      h.labelled(mount, 'Run type').value = 'roofline';
      h.labelled(mount, 'Built from stock').value = '120';
      h.button(mount, 'Register').click();
      await h.settle(150);
    });
    const call = calls.find((c) => c.name === 'registerSeasonalSet');
    assert.ok(call);
    assert.equal(call.args.setCode, 'CHR-014');
    assert.equal(call.args.runType, 'roofline');
    assert.equal(call.args.buildQuantity, 120);
    assert.equal(call.args.colour, null);
    assert.equal(call.args.linearFt, null, 'blank is unknown, not zero');
    assert.equal(call.args.locationCode, null, 'blank means Base, decided server-side');
  });

  await record('G3 the register card says a new set needs inspecting first', async () => {
    const { out } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(120);
      h.button(mount, 'Register a set').click();
      await h.settle(60);
      return mount.textContent;
    });
    assert.match(out, /not inspected/i);
    assert.match(out, /leaves the shelf/i, 'and that a build draws stock down');
  });

  // ============================================== H. retiring ============
  await record('H1 retiring confirms, keeps the record, and can strip to stock', async () => {
    const { calls, confirms } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(120);
      h.button(h.rowFor(mount, 'FIXTURE-READY'), 'Retire').click();
      await h.settle(80);
      const form = mount.querySelector('[data-inline]');
      h.labelled(form, 'Salvage back to stock').value = '40';
      h.button(form, 'Retire set').click();
      await h.settle(150);
    });
    assert.equal(confirms.length, 1);
    assert.match(confirms[0], /stays on record/);
    const call = calls.find((c) => c.name === 'retireSeasonalSet');
    assert.ok(call);
    assert.equal(call.args.stripQuantity, 40);
    assert.equal(call.args.setId, 'set-ready');
  });

  await record('H2 retiring without stripping sends no quantity, not zero', async () => {
    const { calls } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(120);
      h.button(h.rowFor(mount, 'FIXTURE-READY'), 'Retire').click();
      await h.settle(80);
      const form = mount.querySelector('[data-inline]');
      h.button(form, 'Retire set').click();
      await h.settle(150);
    });
    const call = calls.find((c) => c.name === 'retireSeasonalSet');
    assert.ok(call);
    assert.equal(call.args.stripQuantity, null,
      'zero would post an empty movement; null means no strip happened');
  });

  // ============================================== I. write feedback =======
  await record('I1 a write in flight shows a busy state on the button pressed', async () => {
    const { out } = await withPanel({ hang: true }, async ({ mount, h }) => {
      await h.settle(120);
      const row = h.rowFor(mount, 'FIXTURE-ASSIGNED');
      const btn = h.button(row, 'Mark installed');
      btn.click();
      await h.settle(80);
      return { text: btn.textContent.trim(), disabled: btn.disabled };
    });
    assert.equal(out.text, 'Working…');
    assert.equal(out.disabled, true);
  });

  await record('I2 a failed write says why and does not claim success', async () => {
    const { out } = await withPanel({ failNext: 1 }, async ({ mount, h }) => {
      await h.settle(120);
      h.button(h.rowFor(mount, 'FIXTURE-ASSIGNED'), 'Mark installed').click();
      await h.settle(200);
      return document.getElementById('toast')?.textContent || '';
    });
    assert.match(out, /Network unreachable/,
      'the database\'s own words, not a generic failure: an operator who can '
      + 'read the reason can decide whether to retry');
  });

  await record('I3 the button is usable again after a failure', async () => {
    const { out } = await withPanel({ failNext: 1 }, async ({ mount, h }) => {
      await h.settle(120);
      const btn = h.button(h.rowFor(mount, 'FIXTURE-ASSIGNED'), 'Mark installed');
      btn.click();
      await h.settle(200);
      return { text: btn.textContent.trim(), disabled: btn.disabled };
    });
    assert.equal(out.text, 'Mark installed');
    assert.equal(out.disabled, false);
  });

  // ============================================== J. history =============
  await record('J1 a set\'s history is fetched only when it is opened', async () => {
    const { out } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(120);
      const before = globalThis.__calls.filter((c) => c.name === 'listRentalSetEvents').length;
      const row = h.rowFor(mount, 'FIXTURE-READY');
      row.querySelector('details').open = true;
      await h.settle(150);
      const after = globalThis.__calls.filter((c) => c.name === 'listRentalSetEvents').length;
      return { before, after };
    });
    assert.equal(out.before, 0, 'nine sets would otherwise be eighteen queries nobody asked for');
    assert.equal(out.after, 1);
  });

  await record('J2 a set never assigned says so rather than showing an empty list', async () => {
    const { out } = await withPanel({ assignments: [] }, async ({ mount, h }) => {
      await h.settle(120);
      const row = h.rowFor(mount, 'FIXTURE-READY');
      row.querySelector('details').open = true;
      await h.settle(150);
      return row.querySelector('details').textContent;
    });
    assert.match(out, /Never assigned to anybody/);
  });

  // ============================================== K. phone layout ========
  for (const width of [390, 430]) {
    await record(`K${width === 390 ? 1 : 2} no horizontal overflow at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 900 });
      const over = await page.evaluate(async () => {
        Object.assign(globalThis, {
          __SETS: globalThis.__SETS, __ASSIGNMENTS: globalThis.__ASSIGNMENTS
        });
        globalThis.__calls = [];
        const mod = await import('/admin/js/components/seasonal-sets.js');
        const mount = document.createElement('div');
        document.body.appendChild(mount);
        mount.appendChild(mod.seasonalSetsPanel());
        await new Promise((r) => setTimeout(r, 200));
        // Open every form at once: the widest state is the one to measure.
        for (const b of mount.querySelectorAll('button')) {
          if (/^(Assign to a customer|Record recovery|Record inspection|Retire|Register a set)$/
              .test(b.textContent.trim())) b.click();
        }
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
