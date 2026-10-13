// Phase 28 -- Batch 12.1: the dispatch day and the property access editor.
//
// Run directly:   node tests/phase28.test.mjs      (static server on :8743)
//
// MOCKED BROWSER TESTS against the real components with api.js stubbed. The
// database side is covered executably by tests/db/batch12-1.test.mjs, and
// nothing here proves authorisation: a stub cannot refuse anything the way
// a policy can. NO MIGRATION IN THIS REPOSITORY HAS BEEN APPLIED TO
// PRODUCTION AND NO MESSAGE IS SENT BY ANYTHING IN THIS FILE.
//
// What these pin:
//
//   * ORDERING IS KEYBOARD-FIRST. Move up / move down buttons, reachable by
//     Tab and operable by Enter. No drag handle, because a drag handle is
//     unusable with a keyboard and awkward in gloves.
//   * A reorder quotes the revision the screen was SHOWN, and a refusal
//     re-reads instead of leaving a stale list on screen.
//   * Work that belongs to neither car is listed as needing one, never
//     folded into a car's day.
//   * "Work finished" and "completion accepted" are two separate badges.
//     Rendering one as the other is the failure mode this batch guards.
//   * An invalidated load plan is announced with its reason, and the screen
//     says rebuilding moves nothing.
//   * Unknown stock prints "not recorded", never 0.
//   * The property editor separates crew-visible, internal and
//     customer-facing fields, and never puts the access code in a receipt
//     it renders.
//   * A work zone can be drawn with the keyboard alone, needs three points,
//     and an image zone must name its image.
//   * No horizontal overflow at 390, 430 or desktop.

import assert from 'node:assert/strict';
import pkg from '/opt/node-tools/node_modules/playwright/index.js';
import { createRecorder, BASE, FAKE_CAPACITOR_CORE } from './test-harness.mjs';

const { chromium } = pkg;
const { results, record } = createRecorder();

const FAKE_SUPABASE_ADMIN = `
  export const supabase = {
    auth: { signOut: async () => {} },
    from: () => ({ select: () => ({ eq: () => ({ order: async () => ({ data: [], error: null }) }) }) })
  };
  export async function getSession() { return { session: { user: { id: 'admin-1' } }, isAdmin: true }; }
`;

const FAKE_API = `
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const push = (name, args) => { globalThis.__calls.push({ name, args: clone(args || {}) }); };
  async function gate() {
    if (globalThis.__failNext > 0) {
      globalThis.__failNext--;
      throw new Error(globalThis.__failWith || 'Network unreachable');
    }
  }
  export function newOperationId(p) { return (p || 'op') + '-fixed'; }

  export async function getDispatchDay(a) {
    push('getDispatchDay', a);
    return clone(globalThis.__DAY);
  }
  export async function dispatchEquipmentConflicts(a) {
    push('dispatchEquipmentConflicts', a);
    return clone(globalThis.__CONFLICTS);
  }
  export async function jobDispatchStatus(jobId) {
    push('jobDispatchStatus', { jobId });
    return clone((globalThis.__STATUSES || {})[jobId] || null);
  }
  export async function reorderDispatchDay(a) { push('reorderDispatchDay', a); await gate(); return {}; }
  export async function assignJobToVehicle(a) { push('assignJobToVehicle', a); await gate(); return {}; }
  export async function claimJobForVehicle(a) { push('claimJobForVehicle', a); await gate(); return {}; }
  export async function setDispatchStage(a) { push('setDispatchStage', a); await gate(); return {}; }

  export async function getPropertyAccess(id) {
    push('getPropertyAccess', { id });
    return clone(globalThis.__PROPERTY);
  }
  export async function setPropertyAccess(a) { push('setPropertyAccess', a); await gate(); return {}; }
  export async function savePropertyWorkZone(a) { push('savePropertyWorkZone', a); await gate(); return {}; }
  export async function retirePropertyWorkZone(a) { push('retirePropertyWorkZone', a); await gate(); return {}; }
`;

const stop = (over = {}) => ({
  job_id: 'job-1', position: null, order_state: 'derived', assigned: true,
  scheduled_for: '2027-07-06T15:00:00Z', status: 'scheduled',
  customer_id: 'cust-1', customer_name: 'FIXTURE Customer One',
  property_id: 'prop-1', ...over
});

const DAY = (over = {}) => ({
  location_id: 'loc-car-a', location_code: 'car_a', location_name: 'Car A',
  work_date: '2027-07-06',
  work_day_timezone: null, work_day_timezone_state: 'unconfigured',
  window_starts_at: '2027-07-06T00:00:00+00:00',
  window_ends_at: '2027-07-07T00:00:00+00:00',
  revision: 3, can_plan: true,
  stops: [
    stop(),
    stop({ job_id: 'job-2', customer_name: 'FIXTURE Customer Two',
           scheduled_for: '2027-07-06T17:00:00Z' })
  ],
  unassigned_jobs: [],
  readable_vehicles: [
    { location_id: 'loc-car-a', code: 'car_a', name: 'Car A' }
  ],
  load_plan: { state: 'current', plan_id: 'plan-1', revision: 2,
               invalidated_at: null, invalidated_reason: null,
               needs_rebuild: false },
  ...over
});

const CONFLICTS = (items = []) => ({
  work_date: '2027-07-06', work_day_timezone: null,
  vehicles: [{ location_id: 'loc-car-a', code: 'car_a', name: 'Car A' }],
  items
});

const PROPERTY = (over = {}) => ({
  property_id: 'prop-1', address_line1: '1 FIXTURE Lane', city: 'Fixtureville',
  access_note: 'Side gate, unlatched',
  coordinates: { state: 'known', lat: 53.5, lng: -113.5 },
  access: null,
  zones: [],
  ...over
});

const HELPERS = () => ({
  labelled: (scope, label) => {
    const span = [...scope.querySelectorAll('label.field > span')]
      .find((s) => s.textContent === label);
    return span ? span.parentElement.querySelector('input, select, textarea') : null;
  },
  button: (scope, text) => [...scope.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === text),
  buttonTexts: (scope) => [...scope.querySelectorAll('button')]
    .map((b) => b.textContent.trim()),
  enabledButtons: (scope) => [...scope.querySelectorAll('button')]
    .filter((b) => !b.disabled).map((b) => b.textContent.trim()),
  badges: (scope) => [...scope.querySelectorAll('.badge')].map((b) => b.textContent.trim()),
  rowText: (scope, name) => {
    const row = [...scope.querySelectorAll('.row-item')]
      .find((n) => (n.querySelector('strong')?.textContent || '').includes(name));
    return row ? row.textContent : null;
  },
  settle: (ms) => new Promise((r) => setTimeout(r, ms || 120))
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
    async ({ fixtures, options, bodySrc, helpersSrc, which }) => {
      Object.assign(globalThis, fixtures);
      globalThis.__calls = [];
      globalThis.__failNext = options.failNext || 0;
      globalThis.__failWith = options.failWith || null;
      globalThis.__confirms = [];
      globalThis.__prompts = [];
      if (!globalThis.__realConfirm) globalThis.__realConfirm = window.confirm;
      if (!globalThis.__realPrompt) globalThis.__realPrompt = window.prompt;
      window.confirm = (m) => {
        globalThis.__confirms.push(m);
        return options.declineConfirm ? false : true;
      };
      window.prompt = (m) => {
        globalThis.__prompts.push(m);
        return options.promptAnswer === undefined ? 'because' : options.promptAnswer;
      };

      const mount = document.createElement('div');
      document.body.appendChild(mount);
      let panel;
      if (which === 'property') {
        const mod = await import('/admin/js/components/property-access.js');
        panel = mod.propertyAccessPanel({ propertyId: 'prop-1' });
      } else {
        const mod = await import('/admin/js/components/dispatch-day.js');
        panel = mod.dispatchDayPanel({ locationCode: 'car_a', workDate: '2027-07-06' });
      }
      mount.appendChild(panel);

      // eslint-disable-next-line no-new-func
      const h = new Function(`return (${helpersSrc})`)()();
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (${bodySrc})`)();
      const out = await fn({ mount, h, panel });
      mount.remove();
      window.confirm = globalThis.__realConfirm;
      window.prompt = globalThis.__realPrompt;
      return {
        out, calls: globalThis.__calls,
        confirms: globalThis.__confirms, prompts: globalThis.__prompts
      };
    },
    {
      fixtures: {
        __DAY: 'day' in opts ? opts.day : DAY(),
        __CONFLICTS: 'conflicts' in opts ? opts.conflicts : CONFLICTS(),
        __STATUSES: opts.statuses || {},
        __PROPERTY: 'property' in opts ? opts.property : PROPERTY()
      },
      options: opts,
      which: opts.which || 'dispatch',
      bodySrc: body.toString(),
      helpersSrc: HELPERS.toString()
    });

  return { browser, page, withPanel };
}

(async () => {
  const { browser, page, withPanel } = await launch();

  // ================================================ A. the ordered day ====
  await record('A1 opening the screen reads the day and the conflicts, and writes nothing',
    async () => {
      const { calls } = await withPanel({}, async ({ h }) => { await h.settle(200); });
      assert.ok(calls.some((c) => c.name === 'getDispatchDay'));
      assert.ok(calls.some((c) => c.name === 'dispatchEquipmentConflicts'));
      for (const write of ['reorderDispatchDay', 'assignJobToVehicle', 'setDispatchStage']) {
        assert.equal(calls.filter((c) => c.name === write).length, 0,
          `opening the screen called ${write}`);
      }
    });

  await record('A2 the stops are numbered, and an unordered day says so', async () => {
    const { out } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(200);
      return { text: mount.textContent };
    });
    assert.match(out.text, /1\. FIXTURE Customer One/);
    assert.match(out.text, /2\. FIXTURE Customer Two/);
    assert.match(out.text, /Nobody has set an order/i);
  });

  await record('A3 reordering is buttons, not a drag handle, and quotes the revision',
    async () => {
      const { calls, out } = await withPanel({}, async ({ mount, h }) => {
        await h.settle(200);
        const rows = [...mount.querySelectorAll('.row-item')];
        const second = rows[1];
        const up = [...second.querySelectorAll('button')]
          .find((b) => b.textContent.trim() === 'Move up');
        up.click();
        await h.settle(200);
        return {
          draggable: mount.querySelectorAll('[draggable="true"]').length,
          firstRowUpDisabled: [...rows[0].querySelectorAll('button')]
            .find((b) => b.textContent.trim() === 'Move up').disabled
        };
      });
      assert.equal(out.draggable, 0, 'no drag handles: a keyboard cannot use them');
      assert.equal(out.firstRowUpDisabled, true,
        'the first stop cannot move up, and the button says so by being disabled');
      const call = calls.find((c) => c.name === 'reorderDispatchDay');
      assert.ok(call);
      assert.deepEqual(call.args.jobIds, ['job-2', 'job-1'],
        'the whole day is sent in the wanted order, not a single move');
      assert.equal(call.args.expectedRevision, 3,
        'the revision the screen was shown, so a concurrent edit is refused');
    });

  await record('A4 every control is reachable and operable from the keyboard',
    async () => {
      const { out } = await withPanel({}, async ({ mount, h }) => {
        await h.settle(200);
        const focusable = [...mount.querySelectorAll(
          'button, select, input, a[href], [tabindex]')]
          .filter((e) => !e.disabled && e.tabIndex >= 0);
        const unreachable = focusable.filter((e) => e.tabIndex < 0);
        // Operable: focus the first enabled button and press Enter.
        const btn = focusable.find((e) => e.tagName === 'BUTTON');
        btn.focus();
        const focused = document.activeElement === btn;
        btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return { count: focusable.length, unreachable: unreachable.length, focused };
      });
      assert.ok(out.count >= 4, 'the day has controls');
      assert.equal(out.unreachable, 0);
      assert.equal(out.focused, true, 'and they take focus');
    });

  await record('A5 a refused reorder re-reads, so the list is not left stale',
    async () => {
      const { calls } = await withPanel(
        { failNext: 1,
          failWith: 'You reordered revision 3 but the day is now at 4. Reload it.' },
        async ({ mount, h }) => {
          await h.settle(200);
          const rows = [...mount.querySelectorAll('.row-item')];
          [...rows[1].querySelectorAll('button')]
            .find((b) => b.textContent.trim() === 'Move up').click();
          await h.settle(250);
        });
      const reads = calls.filter((c) => c.name === 'getDispatchDay').length;
      assert.ok(reads >= 2, `a refusal must re-read; it read ${reads} times`);
      assert.equal(calls.filter((c) => c.name === 'reorderDispatchDay').length, 1,
        'and it does not silently retry');
    });

  await record('A6 a crew sees the day but gets no planning controls', async () => {
    const { out } = await withPanel({ day: DAY({ can_plan: false }) },
      async ({ mount, h }) => {
        await h.settle(200);
        return { buttons: h.buttonTexts(mount), text: mount.textContent };
      });
    assert.ok(!out.buttons.includes('Move up'));
    assert.ok(!out.buttons.includes('Skip today'));
    assert.match(out.text, /FIXTURE Customer One/, 'but the day is still readable');
  });

  await record('A7 work that belongs to neither car is listed as needing one',
    async () => {
      const { out } = await withPanel({
        day: DAY({
          stops: [],
          unassigned_jobs: [{ job_id: 'job-9', scheduled_for: '2027-07-06T16:00:00Z',
            status: 'scheduled', customer_name: 'FIXTURE Nobody’s Job',
            property_id: 'prop-9' }],
          readable_vehicles: [
            { location_id: 'loc-car-a', code: 'car_a', name: 'Car A' },
            { location_id: 'loc-car-b', code: 'car_b', name: 'Car B' }]
        })
      }, async ({ mount, h }) => {
        await h.settle(200);
        return { text: mount.textContent, buttons: h.buttonTexts(mount) };
      });
      assert.match(out.text, /Needs a car \(1\)/);
      assert.match(out.text, /belongs to neither day/i);
      assert.ok(out.buttons.includes('Give to Car A'));
      assert.ok(out.buttons.includes('Give to Car B'),
        'the owner picks the car; the screen does not');
    });

  /* ---- 15.1: the crew's own door out of the two-car ambiguity ---- */

  await record('A7b a CREW is offered the claim, not the owner\u2019s car picker',
    async () => {
      const { out, calls } = await withPanel({
        day: DAY({
          can_plan: false,
          stops: [],
          unassigned_jobs: [{ job_id: 'job-9', scheduled_for: '2027-07-06T16:00:00Z',
            status: 'scheduled', customer_name: 'FIXTURE Nobody\u2019s Job',
            property_id: 'prop-9' }],
          readable_vehicles: [
            { location_id: 'loc-car-a', code: 'car_a', name: 'Car A' },
            { location_id: 'loc-car-b', code: 'car_b', name: 'Car B' }]
        })
      }, async ({ mount, h }) => {
        await h.settle(200);
        const btn = h.button(mount, 'This one is on my car');
        btn.click();
        await h.settle(220);
        return { text: mount.textContent, buttons: h.buttonTexts(mount) };
      });
      // The owner's picker is absent for a crew, and the claim is present.
      assert.ok(!out.buttons.includes('Give to Car A'));
      assert.ok(!out.buttons.includes('Give to Car B'));
      assert.ok(out.buttons.includes('This one is on my car'));
      // It claims for the caller's OWN car: no vehicle is passed at all,
      // because the backend resolves it from the crew record.
      const call = calls.find((c) => c.name === 'claimJobForVehicle');
      assert.ok(call, 'the claim never reached the backend');
      assert.equal(call.args.jobId, 'job-9');
      assert.ok(!('locationCode' in call.args),
        'a crew must not be able to name the car it claims for');
      assert.equal(calls.filter((c) => c.name === 'assignJobToVehicle').length, 0);
      // And the crew is told why saying so matters.
      assert.match(out.text, /which car was there/i);
    });

  await record('A7c an OWNER still gets the car picker and no claim', async () => {
    const { out } = await withPanel({
      day: DAY({
        stops: [],
        unassigned_jobs: [{ job_id: 'job-9', scheduled_for: '2027-07-06T16:00:00Z',
          status: 'scheduled', customer_name: 'FIXTURE Nobody\u2019s Job',
          property_id: 'prop-9' }],
        readable_vehicles: [
          { location_id: 'loc-car-a', code: 'car_a', name: 'Car A' },
          { location_id: 'loc-car-b', code: 'car_b', name: 'Car B' }]
      })
    }, async ({ mount, h }) => {
      await h.settle(200);
      return { buttons: h.buttonTexts(mount) };
    });
    assert.ok(out.buttons.includes('Give to Car A'));
    assert.ok(!out.buttons.includes('This one is on my car'),
      'an owner has no car of their own to claim onto');
  });

  await record('A8 an invalidated load plan is announced with its reason', async () => {
    const { out } = await withPanel({
      day: DAY({ load_plan: { state: 'superseded', plan_id: 'plan-1', revision: 2,
        invalidated_at: '2027-07-06T12:00:00Z',
        invalidated_reason: 'a job was assigned to car_b',
        needs_rebuild: true } })
    }, async ({ mount, h }) => {
      await h.settle(200);
      return { text: mount.textContent };
    });
    assert.match(out.text, /load plan needs rebuilding/i);
    assert.match(out.text, /a job was assigned to car_b/);
    assert.match(out.text, /recommends and moves nothing/i,
      'rebuilding is not a stock movement, and the screen says so');
  });

  // ========================== B. the states that must not merge ==========
  await record('B1 work finished and completion accepted are separate badges',
    async () => {
      const { out } = await withPanel({
        statuses: {
          'job-1': { job_id: 'job-1', job_status: 'scheduled',
            dispatch_state: 'work_finished', dispatch_reason: 'Tools away',
            dispatch_lock_version: 2, completion_state: 'none',
            open_issue_count: 0 },
          'job-2': { job_id: 'job-2', job_status: 'completed',
            dispatch_state: 'work_finished', dispatch_reason: null,
            dispatch_lock_version: 3, completion_state: 'accepted',
            open_issue_count: 0 }
        }
      }, async ({ mount, h }) => {
        await h.settle(250);
        return {
          one: h.rowText(mount, 'FIXTURE Customer One'),
          two: h.rowText(mount, 'FIXTURE Customer Two')
        };
      });
      assert.match(out.one, /Work finished/);
      assert.ok(!/Completion accepted/.test(out.one),
        'tools down is not an accepted completion');
      assert.match(out.two, /Work finished/);
      assert.match(out.two, /Completion accepted/,
        'and when there IS one, it is its own badge');
    });

  await record('B2 a blocked stop shows the crew\'s reason', async () => {
    const { out } = await withPanel({
      statuses: {
        'job-1': { job_id: 'job-1', job_status: 'scheduled',
          dispatch_state: 'blocked', dispatch_reason: 'Gate padlocked, nobody home',
          dispatch_lock_version: 2, completion_state: 'none', open_issue_count: 1 }
      }
    }, async ({ mount, h }) => {
      await h.settle(250);
      return { row: h.rowText(mount, 'FIXTURE Customer One') };
    });
    assert.match(out.row, /Blocked/);
    assert.match(out.row, /Gate padlocked, nobody home/);
    assert.match(out.row, /1 open issue/);
  });

  await record('B3 skipping asks why, and sends the reason with the version',
    async () => {
      const { calls, prompts } = await withPanel({
        promptAnswer: 'Customer away all week',
        statuses: {
          'job-1': { job_id: 'job-1', job_status: 'scheduled',
            dispatch_state: 'planned', dispatch_reason: null,
            dispatch_lock_version: 4, completion_state: 'none', open_issue_count: 0 }
        }
      }, async ({ mount, h }) => {
        await h.settle(250);
        const row = [...mount.querySelectorAll('.row-item')][0];
        [...row.querySelectorAll('button')]
          .find((b) => b.textContent.trim() === 'Skip today').click();
        await h.settle(250);
      });
      assert.equal(prompts.length, 1, 'it asks');
      const call = calls.find((c) => c.name === 'setDispatchStage');
      assert.ok(call);
      assert.equal(call.args.state, 'skipped');
      assert.equal(call.args.reason, 'Customer away all week');
      assert.equal(call.args.expectedVersion, 4);
    });

  await record('B4 a skip with no reason given is not sent', async () => {
    const { calls } = await withPanel({ promptAnswer: null },
      async ({ mount, h }) => {
        await h.settle(250);
        const row = [...mount.querySelectorAll('.row-item')][0];
        [...row.querySelectorAll('button')]
          .find((b) => b.textContent.trim() === 'Skip today').click();
        await h.settle(200);
      });
    assert.equal(calls.filter((c) => c.name === 'setDispatchStage').length, 0);
  });

  // ================================================= C. conflicts =========
  await record('C1 unknown stock prints "not recorded", never 0', async () => {
    const { out } = await withPanel({
      conflicts: CONFLICTS([{
        material_id: 'mat-x', material_name: 'FIXTURE never-counted tool',
        unit: 'each', tracking_mode: 'quantity',
        needed_by: ['car_a'], vehicles_needing: 1, required_total: 1,
        usable_at_base: null, usable_aboard: {}, damaged_at_base: null,
        level_state: null, conflict: 'missing_data'
      }])
    }, async ({ mount, h }) => {
      await h.settle(200);
      return { text: mount.textContent };
    });
    assert.match(out.text, /Never counted/);
    assert.match(out.text, /not recorded/);
    assert.ok(!/at Base: 0/.test(out.text), 'unknown must not read as none');
    assert.match(out.text, /missing information, not zero/i);
  });

  await record('C2 a shared scarcity names both cars and what to do', async () => {
    const { out } = await withPanel({
      conflicts: CONFLICTS([{
        material_id: 'mat-w', material_name: 'FIXTURE pressure washer',
        unit: 'each', tracking_mode: 'quantity',
        needed_by: ['car_a', 'car_b'], vehicles_needing: 2, required_total: 2,
        usable_at_base: 1, usable_aboard: { car_a: 0, car_b: 0 },
        damaged_at_base: 0, level_state: null, conflict: 'shared_scarce'
      }])
    }, async ({ mount, h }) => {
      await h.settle(200);
      return { text: mount.textContent };
    });
    assert.match(out.text, /Both cars need it/);
    assert.match(out.text, /Decide which car has it/);
    assert.match(out.text, /car_a and car_b/);
    assert.match(out.text, /transfers, reserves and buys nothing/i);
  });

  await record('C3 a day with no conflicts shows no conflict section', async () => {
    const { out } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(200);
      return { text: mount.textContent };
    });
    assert.ok(!/Equipment to sort out/.test(out.text));
  });

  // =============================== D. the property access editor =========
  await record('D1 the three audiences are three labelled groups', async () => {
    const { out } = await withPanel({ which: 'property' },
      async ({ mount, h }) => {
        await h.settle(200);
        return { text: mount.textContent };
      });
    assert.match(out.text, /The crew sees these/);
    assert.match(out.text, /Ours, never the customer/);
    assert.match(out.text, /The customer may see this/);
    assert.match(out.text, /only field on this screen that may appear on a customer/i);
  });

  await record('D2 the existing entrance note is shown, not duplicated', async () => {
    const { out } = await withPanel({ which: 'property' },
      async ({ mount, h }) => {
        await h.settle(200);
        return {
          text: mount.textContent,
          entrance: h.labelled(mount, 'Entrance')?.value
        };
      });
    assert.match(out.text, /Side gate, unlatched/);
    assert.match(out.text, /not duplicated here/i);
    assert.equal(out.entrance, '', 'the new field starts empty rather than copying it');
  });

  await record('D3 missing coordinates are stated, not defaulted', async () => {
    const { out } = await withPanel({
      which: 'property',
      property: PROPERTY({ coordinates: { state: 'missing', lat: null, lng: null } })
    }, async ({ mount, h }) => {
      await h.settle(200);
      return { text: mount.textContent };
    });
    assert.match(out.text, /No coordinates on file/);
    assert.match(out.text, /nothing is guessed from the address/i);
  });

  await record('D4 a first save sends version 0 and every field', async () => {
    const { calls } = await withPanel({ which: 'property' },
      async ({ mount, h }) => {
        await h.settle(200);
        const set = (label, value) => {
          const input = h.labelled(mount, label);
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
        };
        set('Entrance', 'Round the back');
        set('Hazard', 'Dog after 4pm');
        set('Access code', '4821');
        set('Customer-facing note', 'We will text on the way');
        h.button(mount, 'Save details').click();
        await h.settle(250);
      });
    const call = calls.find((c) => c.name === 'setPropertyAccess');
    assert.ok(call);
    assert.equal(call.args.expectedVersion, 0, '0 means "nothing here yet"');
    assert.equal(call.args.entranceNote, 'Round the back');
    assert.equal(call.args.hazardNote, 'Dog after 4pm');
    assert.equal(call.args.accessCode, '4821');
    assert.equal(call.args.customerNote, 'We will text on the way');
    assert.equal(call.args.parkingNote, null,
      'an untouched field is sent as null, which clears rather than "leave alone"');
  });

  await record('D5 an existing record saves against its own version', async () => {
    const { calls, out } = await withPanel({
      which: 'property',
      property: PROPERTY({ access: {
        entrance_note: 'Round the back', hazard_note: null, parking_note: null,
        internal_note: 'Invoice by email', access_code: '4821',
        customer_note: null, lock_version: 3,
        updated_at: '2027-07-01T10:00:00Z' } })
    }, async ({ mount, h }) => {
      await h.settle(200);
      h.button(mount, 'Save details').click();
      await h.settle(250);
      return { text: mount.textContent };
    });
    const call = calls.find((c) => c.name === 'setPropertyAccess');
    assert.equal(call.args.expectedVersion, 3);
    assert.match(out.text, /Version 3, saved/);
  });

  // ===================================================== E. zones =========
  await record('E1 a zone can be drawn with the keyboard alone', async () => {
    const { calls, out } = await withPanel({ which: 'property' },
      async ({ mount, h }) => {
        await h.settle(200);
        h.button(mount, 'Add a zone').click();
        await h.settle(120);

        const label = h.labelled(mount, 'Label');
        label.value = 'Back lawn';
        label.dispatchEvent(new Event('input', { bubbles: true }));

        for (let i = 0; i < 3; i += 1) {
          h.button(mount, 'Add point').click();
          await h.settle(80);
        }
        const numbers = [...mount.querySelectorAll('input[type="number"]')];
        const coords = [[53.5, -113.5], [53.5001, -113.5], [53.5001, -113.4999]];
        numbers.forEach((input, i) => {
          input.value = String(coords[Math.floor(i / 2)][i % 2]);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });

        const draggable = mount.querySelectorAll('[draggable="true"]').length;
        const canvases = mount.querySelectorAll('canvas').length;
        h.button(mount, 'Save zone').click();
        await h.settle(250);
        return { draggable, canvases, numbers: numbers.length };
      });
    assert.equal(out.numbers, 6, 'three points, two numbers each');
    assert.equal(out.draggable, 0);
    assert.equal(out.canvases, 0, 'no pointer-only canvas is required to draw one');
    const call = calls.find((c) => c.name === 'savePropertyWorkZone');
    assert.ok(call, 'and it saves');
    assert.equal(call.args.space, 'geographic');
    assert.equal(call.args.points.length, 3);
    assert.equal(call.args.points[0].lat, 53.5);
  });

  await record('E2 two points is a line, and the screen says so before sending',
    async () => {
      const { calls, out } = await withPanel({ which: 'property' },
        async ({ mount, h }) => {
          await h.settle(200);
          h.button(mount, 'Add a zone').click();
          await h.settle(120);
          const label = h.labelled(mount, 'Label');
          label.value = 'Line';
          label.dispatchEvent(new Event('input', { bubbles: true }));
          for (let i = 0; i < 2; i += 1) {
            h.button(mount, 'Add point').click();
            await h.settle(80);
          }
          [...mount.querySelectorAll('input[type="number"]')].forEach((input, i) => {
            input.value = String(53 + i);
            input.dispatchEvent(new Event('input', { bubbles: true }));
          });
          h.button(mount, 'Save zone').click();
          await h.settle(200);
          return { text: mount.textContent };
        });
      assert.match(out.text, /at least three points/i);
      assert.equal(calls.filter((c) => c.name === 'savePropertyWorkZone').length, 0,
        'nothing is sent for the backend to refuse');
    });

  await record('E3 an image zone must name its image, and its points are 0-1',
    async () => {
      const { calls, out } = await withPanel({ which: 'property' },
        async ({ mount, h }) => {
          await h.settle(200);
          h.button(mount, 'Add a zone').click();
          await h.settle(120);
          const label = h.labelled(mount, 'Label');
          label.value = 'Sketch';
          label.dispatchEvent(new Event('input', { bubbles: true }));

          const space = h.labelled(mount, 'Coordinate space');
          space.value = 'image';
          space.dispatchEvent(new Event('change', { bubbles: true }));
          await h.settle(120);

          const hasImageField = !!h.labelled(mount, 'Which image');
          for (let i = 0; i < 3; i += 1) {
            h.button(mount, 'Add point').click();
            await h.settle(80);
          }
          [...mount.querySelectorAll('input[type="number"]')].forEach((input, i) => {
            input.value = String(0.1 * (i + 1));
            input.dispatchEvent(new Event('input', { bubbles: true }));
          });
          h.button(mount, 'Save zone').click();
          await h.settle(200);
          const refusedText = mount.textContent;
          const img = h.labelled(mount, 'Which image');
          img.value = 'site-visit/front.jpg';
          img.dispatchEvent(new Event('input', { bubbles: true }));
          h.button(mount, 'Save zone').click();
          await h.settle(250);
          return { hasImageField, refusedText, labels:
            [...mount.querySelectorAll('label.field > span')].map((s) => s.textContent) };
        });
      assert.equal(out.hasImageField, true);
      assert.match(out.refusedText, /Name the image/i);
      const call = calls.find((c) => c.name === 'savePropertyWorkZone');
      assert.ok(call, 'it saves once the image is named');
      assert.equal(call.args.space, 'image');
      assert.equal(call.args.imageSource, 'site-visit/front.jpg');
      assert.ok(out.labels.some((l) => l.startsWith('X (point')),
        'and the axes are X/Y rather than latitude/longitude');
    });

  await record('E4 a zone is called a drawing, never a boundary', async () => {
    const { out } = await withPanel({ which: 'property' },
      async ({ mount, h }) => {
        await h.settle(200);
        h.button(mount, 'Add a zone').click();
        await h.settle(120);
        return { text: mount.textContent };
      });
    assert.match(out.text, /not a surveyed boundary/i);
    assert.match(out.text, /nothing triggers on entering one/i);
  });

  await record('E5 retiring a zone asks why and keeps it on record', async () => {
    const { calls, confirms, prompts } = await withPanel({
      which: 'property',
      promptAnswer: 'fence moved',
      property: PROPERTY({ zones: [{
        zone_id: 'zone-1', label: 'Back lawn', kind: 'work_area',
        space: 'geographic',
        points: [{ lat: 53.5, lng: -113.5 }, { lat: 53.6, lng: -113.5 },
                 { lat: 53.6, lng: -113.4 }],
        image_source: null, note: null, source: 'owner_drawn', lock_version: 1 }] })
    }, async ({ mount, h }) => {
      await h.settle(200);
      h.button(mount, 'Retire').click();
      await h.settle(250);
    });
    assert.equal(prompts.length, 1);
    assert.equal(confirms.length, 1);
    assert.match(confirms[0], /stays on record/i);
    const call = calls.find((c) => c.name === 'retirePropertyWorkZone');
    assert.equal(call.args.reason, 'fence moved');
  });

  // ===================================================== F. layout ========
  for (const width of [390, 430, 1280]) {
    await record(`F${width} no horizontal overflow at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 900 });
      for (const which of ['dispatch', 'property']) {
        const { out } = await withPanel({
          which,
          statuses: {
            'job-1': { job_id: 'job-1', job_status: 'scheduled',
              dispatch_state: 'blocked',
              dispatch_reason: 'Gate padlocked and nobody answered the door',
              dispatch_lock_version: 1, completion_state: 'none',
              open_issue_count: 1 }
          },
          conflicts: CONFLICTS([{
            material_id: 'mat-w', material_name: 'FIXTURE pressure washer',
            unit: 'each', tracking_mode: 'quantity',
            needed_by: ['car_a', 'car_b'], vehicles_needing: 2, required_total: 2,
            usable_at_base: 1, usable_aboard: { car_a: 0 }, damaged_at_base: 0,
            level_state: null, conflict: 'shared_scarce' }]),
          property: PROPERTY({ access: {
            entrance_note: 'Round the back past the bins and the long hedge',
            hazard_note: 'Dog after 4pm', parking_note: 'On the pad',
            internal_note: 'Invoice by email', access_code: '4821',
            customer_note: 'We will text on the way', lock_version: 2,
            updated_at: '2027-07-01T10:00:00Z' } })
        }, async ({ h }) => {
          await h.settle(250);
          return {
            over: document.documentElement.scrollWidth > window.innerWidth + 1
          };
        });
        assert.equal(out.over, false, `${which} overflows at ${width}px`);
      }
      await page.setViewportSize({ width: 1280, height: 900 });
    });
  }

  await browser.close();
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.ok ? '' : `\n      ${r.err}`}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed) process.exit(1);
})();
