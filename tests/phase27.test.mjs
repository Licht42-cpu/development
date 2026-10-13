// Phase 27 -- Batch 11.1: the evidence panels.
//
// Run directly:   node tests/phase27.test.mjs      (static server on :8743)
//
// MOCKED BROWSER TESTS against the real components with api.js stubbed. The
// database side is covered executably by tests/db/batch11-1.test.mjs.
// NO MIGRATION IN THIS REPOSITORY HAS BEEN APPLIED TO PRODUCTION.
//
// What these pin:
//
//   * UNKNOWN IS NOT ZERO, on the screen as well as in the view. A service
//     with no rule reads "Nobody has said", never a tick and never "0 of 0".
//   * A PROPOSED requirement says so. The seeded policies are this system's
//     assumptions, and a screen that presented them as the owner's rules
//     would be the whole failure mode of this batch.
//   * A blocking shortfall is visible BEFORE the completion button, with
//     what is missing, because afterwards it is an error message.
//   * One photograph can be registered against several scopes, and the
//     screen does not ask for it twice.
//   * An exception cannot be submitted without a reason, and the screen
//     says so rather than sending a blank one for the backend to refuse.
//   * The desk never sends a capture time or a location it invented.
//   * No horizontal overflow at 390, 430 or desktop, and every control is
//     reachable and operable from the keyboard.

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
  export async function jobEvidenceRequirements(a) { push('jobEvidenceRequirements', { a }); return clone(globalThis.__REQS); }
  export async function jobEvidenceReadiness(a) { push('jobEvidenceReadiness', { a }); return clone(globalThis.__READY); }
  export async function listJobEvidence(a) { push('listJobEvidence', { a }); return clone(globalThis.__EVIDENCE); }
  export async function listAttachments(a) { push('listAttachments', { a }); return clone(globalThis.__ATTACHMENTS); }
  export async function listEvidenceExceptions(a) { push('listEvidenceExceptions', { a }); return clone(globalThis.__EXCEPTIONS); }
  export async function registerJobEvidence(a) { push('registerJobEvidence', a); await gate(); return { evidence_id: 'ev-new' }; }
  export async function authoriseEvidenceException(a) { push('authoriseEvidenceException', a); await gate(); return { exception_id: 'exc-new' }; }
  export async function listEvidencePolicies() { push('listEvidencePolicies', {}); return clone(globalThis.__POLICIES); }
  export async function evidencePolicyVersion() { return globalThis.__VERSION; }
  export async function listServices() { return clone(globalThis.__SERVICES); }
  export async function setEvidencePolicy(a) { push('setEvidencePolicy', a); await gate(); return {}; }
  export async function retireEvidencePolicy(a) { push('retireEvidencePolicy', a); await gate(); return {}; }
`;

const req = (over = {}) => ({
  job_id: 'job-1', service_id: 'svc-siding', service_key: 'siding',
  service_name: 'Siding Soft Washing', requirement: 'before',
  policy_id: 'pol-1', required_count: 1, satisfied_count: 0,
  coverage: 'per_service_scope', requires_geotag: false,
  enforcement: 'blocking', spec_state: 'owner_confirmed',
  policy_version: 3, excepted: false, state: 'short', ...over
});

const REQS = [
  req(),
  req({ requirement: 'after', policy_id: 'pol-2', satisfied_count: 1,
        state: 'satisfied' }),
  req({ service_id: 'svc-deck', service_key: 'deck',
        service_name: 'Deck Cleaning', requirement: 'before',
        policy_id: 'pol-3', spec_state: 'proposed', enforcement: 'advisory',
        satisfied_count: 0, state: 'short' }),
  // The one that matters most: no rule at all.
  req({ service_id: 'svc-graffiti', service_key: 'graffiti',
        service_name: 'Graffiti Removal', requirement: null,
        policy_id: null, required_count: null, satisfied_count: 0,
        coverage: null, requires_geotag: null, enforcement: 'advisory',
        spec_state: 'unconfigured', state: 'unconfigured' })
];

const READY = {
  job_id: 'job-1', policy_version: 3, lock_version: 4,
  requirement_count: 4, blocking_shortfalls: 1, advisory_shortfalls: 1,
  unconfigured_services: ['graffiti'], evidence_state: 'blocked',
  latest_completion_id: null, completion_open: false
};

const EVIDENCE = [
  { id: 'ev-1', job_id: 'job-1', attachment_id: 'att-2', requirement: 'after',
    service_id: 'svc-siding', captured_at: '2027-05-04T15:04:00Z',
    capture_time_state: 'device_reported', gps_state: 'device_reported',
    received_at: '2027-05-04T17:10:00Z', upload_verified: true,
    frozen_by_completion: null },
  { id: 'ev-2', job_id: 'job-1', attachment_id: 'att-3', requirement: 'after',
    service_id: null, captured_at: null, capture_time_state: 'unknown',
    gps_state: 'unavailable', received_at: '2027-05-04T17:11:00Z',
    upload_verified: true, frozen_by_completion: null }
];

const ATTACHMENTS = [
  { id: 'att-1', job_id: 'job-1', storage_path: 'job-1/west-before.jpg',
    kind: 'before', caption: 'West elevation before' },
  { id: 'att-2', job_id: 'job-1', storage_path: 'job-1/west-after.jpg',
    kind: 'after', caption: 'West elevation after' },
  { id: 'att-3', job_id: 'job-1', storage_path: 'job-1/deck-and-siding.jpg',
    kind: 'site_photo', caption: 'Deck with the siding behind it' }
];

const EXCEPTIONS = [];

const POLICIES = [
  { id: 'pol-1', service_id: 'svc-siding', requirement: 'before',
    min_count: 1, coverage: 'per_service_scope', requires_geotag: false,
    enforcement: 'blocking', spec_state: 'owner_confirmed',
    policy_version: 3, active: true, note: 'Confirmed by the owner',
    confirmed_at: '2027-05-01T10:00:00Z',
    services: { key: 'siding', name: 'Siding Soft Washing' } },
  { id: 'pol-9', service_id: 'svc-winter', requirement: 'winter_proof',
    min_count: 1, coverage: 'per_job', requires_geotag: false,
    enforcement: 'advisory', spec_state: 'proposed', policy_version: 1,
    active: true, note: 'PROPOSED: one quick shot that somebody was there.',
    confirmed_at: null,
    services: { key: 'winter_property_care', name: 'Winter Property Care' } }
];

const SERVICES = [
  { id: 'svc-siding', key: 'siding', name: 'Siding Soft Washing' },
  { id: 'svc-winter', key: 'winter_property_care', name: 'Winter Property Care' }
];

const HELPERS = () => ({
  labelled: (scope, label) => {
    const span = [...scope.querySelectorAll('label.field > span')]
      .find((s) => s.textContent === label);
    return span ? span.parentElement.querySelector('input, select, textarea') : null;
  },
  button: (scope, text) => [...scope.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === text),
  buttonTexts: (scope) => [...scope.querySelectorAll('button')].map((b) => b.textContent.trim()),
  badges: (scope) => [...scope.querySelectorAll('.badge')].map((b) => b.textContent.trim()),
  rowText: (scope, name) => {
    const row = [...scope.querySelectorAll('.row-item')]
      .find((n) => (n.querySelector('strong')?.textContent || '').includes(name));
    return row ? row.textContent : null;
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

  const withPanel = (opts, body) => page.evaluate(
    async ({ fixtures, options, bodySrc, helpersSrc, which }) => {
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

      const mount = document.createElement('div');
      document.body.appendChild(mount);
      let panel;
      if (which === 'policy') {
        const mod = await import('/admin/js/components/evidence-policy.js');
        panel = mod.evidencePolicyPanel({});
      } else {
        const mod = await import('/admin/js/components/job-evidence.js');
        panel = mod.jobEvidencePanel({ jobId: 'job-1' });
      }
      mount.appendChild(panel.root);

      // eslint-disable-next-line no-new-func
      const h = new Function(`return (${helpersSrc})`)()();
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (${bodySrc})`)();
      const out = await fn({ mount, h, panel });
      mount.remove();
      window.confirm = globalThis.__realConfirm;
      return { out, calls: globalThis.__calls, confirms: globalThis.__confirms };
    },
    {
      fixtures: {
        __REQS: 'reqs' in opts ? opts.reqs : REQS,
        __READY: 'ready' in opts ? opts.ready : READY,
        __EVIDENCE: opts.evidence || EVIDENCE,
        __ATTACHMENTS: 'attachments' in opts ? opts.attachments : ATTACHMENTS,
        __EXCEPTIONS: opts.exceptions || EXCEPTIONS,
        __POLICIES: opts.policies || POLICIES,
        __VERSION: opts.version ?? 3,
        __SERVICES: opts.services || SERVICES
      },
      options: opts,
      which: opts.which || 'job',
      bodySrc: body.toString(),
      helpersSrc: HELPERS.toString()
    });

  return { browser, page, withPanel };
}

(async () => {
  const { browser, page, withPanel } = await launch();

  // ======================== A. unknown is not zero =======================

  await record('A1 a service with no rule reads as unsaid, not as satisfied',
    async () => {
      const { out } = await withPanel({}, async ({ mount, h }) => {
        await h.settle(200);
        return {
          graffiti: h.rowText(mount, 'Graffiti Removal'),
          badges: h.badges(mount),
          text: mount.textContent
        };
      });
      assert.match(out.graffiti, /Nobody has said/,
        'an unconfigured service is a stated unknown');
      assert.match(out.graffiti, /no requirement set/,
        'and the count says so rather than printing 0 of 0');
      assert.doesNotMatch(out.graffiti, /\b0 of 0\b/);
      assert.match(out.text, /No rule on file for: graffiti/,
        'and the job-level summary names it');
    });

  await record('A2 a proposed requirement is marked as a proposal, not a rule',
    async () => {
      const { out } = await withPanel({}, async ({ mount, h }) => {
        await h.settle(200);
        return { deck: h.rowText(mount, 'Deck Cleaning') };
      });
      assert.match(out.deck, /proposed, not confirmed by the owner/,
        'this is the line that stops a seeded guess reading as policy');
      assert.doesNotMatch(out.deck, /will refuse completion/,
        'and a proposal refuses nothing');
    });

  await record('A3 a blocking shortfall is visible, and says it will refuse',
    async () => {
      const { out } = await withPanel({}, async ({ mount, h }) => {
        await h.settle(200);
        return {
          siding: h.rowText(mount, 'Siding Soft Washing — Before'),
          text: mount.textContent, badges: h.badges(mount)
        };
      });
      assert.match(out.siding, /0 of 1/);
      assert.match(out.siding, /will refuse completion/);
      assert.match(out.text, /refused until it is met|refused until it is/i,
        'before the button, not as an error after it');
      assert.ok(out.badges.includes('Blocked'));
    });

  await record('A4 the three readiness states read differently', async () => {
    for (const [state, pattern] of [
      ['satisfied', /Everything this job has to prove is proved/],
      ['advisory_short', /will be accepted and will record the gap/],
      ['unconfigured', /nobody can say whether it is proved/]
    ]) {
      const { out } = await withPanel(
        { ready: { ...READY, evidence_state: state, unconfigured_services: [] } },
        async ({ mount, h }) => { await h.settle(200); return { text: mount.textContent }; });
      assert.match(out.text, pattern, `${state} needs its own sentence`);
    }
  });

  // ========================= B. registering evidence =====================

  await record('B1 one photograph can be registered against several scopes',
    async () => {
      const { out, calls } = await withPanel({}, async ({ mount, h }) => {
        await h.settle(200);
        const pick = h.labelled(mount, 'Photograph');
        const proves = h.labelled(mount, 'Proves');
        const scope = h.labelled(mount, 'Scope');
        pick.value = 'att-3';
        proves.value = 'before';
        scope.value = 'siding';
        h.button(mount, 'Register as evidence').click();
        await h.settle(200);
        return { options: [...scope.options].map((o) => o.value) };
      });
      const sent = calls.filter((c) => c.name === 'registerJobEvidence');
      assert.equal(sent.length, 1);
      assert.equal(sent[0].args.attachmentId, 'att-3');
      assert.equal(sent[0].args.serviceKey, 'siding');
      assert.ok(out.options.includes(''), 'the whole job is a scope too');
      assert.ok(out.options.includes('deck'),
        'and the same file can be registered against the other service next');
    });

  await record('B2 the desk never invents a capture time or a location',
    async () => {
      const { calls } = await withPanel({}, async ({ mount, h }) => {
        await h.settle(200);
        h.button(mount, 'Register as evidence').click();
        await h.settle(200);
      });
      const sent = calls.find((c) => c.name === 'registerJobEvidence');
      assert.ok(sent);
      for (const field of ['capturedAt', 'lat', 'lon', 'captureTimeState', 'gpsState']) {
        assert.ok(sent.args[field] === undefined || sent.args[field] === null,
          `${field} must not be fabricated by the desk`);
      }
      assert.equal(sent.args.source, 'desk',
        'and it says where the registration came from');
    });

  await record('B3 the existing evidence is described by its states, not assumed',
    async () => {
      const { out } = await withPanel({}, async ({ mount, h }) => {
        await h.settle(200);
        return { text: mount.textContent };
      });
      assert.match(out.text, /capture time Unknown/i,
        'a photo with no device time says so');
      assert.match(out.text, /location Unavailable/i);
      assert.match(out.text, /location Device reported/i);
    });

  await record('B4 with no photographs the screen says where they come from',
    async () => {
      const { out } = await withPanel({ attachments: [] }, async ({ mount, h }) => {
        await h.settle(200);
        return { text: mount.textContent, buttons: h.buttonTexts(mount) };
      });
      assert.match(out.text, /field console puts them here/i);
      assert.ok(!out.buttons.includes('Register as evidence'));
    });

  // ============================ C. exceptions ============================

  await record('C1 an exception without a reason is refused by the screen too',
    async () => {
      const { out, calls } = await withPanel({}, async ({ mount, h }) => {
        await h.settle(200);
        h.button(mount, 'Authorise the exception').click();
        await h.settle(120);
        return { error: mount.querySelector('.error-text')?.textContent || '' };
      });
      assert.match(out.error, /without a reason is not an exception/i);
      assert.equal(calls.filter((c) => c.name === 'authoriseEvidenceException').length, 0,
        'nothing is sent for the backend to refuse');
    });

  await record('C2 an exception carries its reason, requirement and scope',
    async () => {
      const { calls, confirms } = await withPanel({}, async ({ mount, h }) => {
        await h.settle(200);
        const reason = mount.querySelector('textarea');
        reason.value = 'Camera died at the property; I inspected it myself';
        const [requirementPick, scopePick] = [...mount.querySelectorAll('select')].slice(-2);
        requirementPick.value = 'before';
        scopePick.value = 'siding';
        h.button(mount, 'Authorise the exception').click();
        await h.settle(200);
      });
      const sent = calls.find((c) => c.name === 'authoriseEvidenceException');
      assert.ok(sent, 'it was sent');
      assert.match(sent.args.reason, /Camera died/);
      assert.ok(confirms.length >= 1, 'and it asked first');
    });

  // ========================= D. the policy screen ========================

  await record('D1 a proposed policy is badged as a proposal and counted',
    async () => {
      const { out } = await withPanel({ which: 'policy' }, async ({ mount, h }) => {
        await h.settle(200);
        return { text: mount.textContent, badges: h.badges(mount),
                 buttons: h.buttonTexts(mount) };
      });
      assert.ok(out.badges.includes('Proposed — not confirmed'));
      assert.ok(out.badges.includes('Owner-confirmed'));
      assert.match(out.text, /1 of these are PROPOSALS, not your rules/);
      assert.ok(out.buttons.includes('Confirm this rule'),
        'a proposal is confirmed, not merely saved');
      assert.ok(out.badges.includes('Version 3'), 'the version is on screen');
    });

  await record('D2 confirming a proposal sends the owner\'s values', async () => {
    const { calls } = await withPanel({ which: 'policy' }, async ({ mount, h }) => {
      await h.settle(200);
      const rows = [...mount.querySelectorAll('.row-item')];
      const winter = rows.find((r) => r.textContent.includes('Winter Property Care'));
      winter.querySelector('input[type=number]').value = '2';
      winter.querySelector('input[type=checkbox]').checked = true;
      const selects = winter.querySelectorAll('select');
      selects[selects.length - 1].value = 'blocking';
      [...winter.querySelectorAll('button')]
        .find((b) => b.textContent.trim() === 'Confirm this rule').click();
      await h.settle(220);
    });
    const sent = calls.find((c) => c.name === 'setEvidencePolicy');
    assert.ok(sent, 'it was sent');
    assert.equal(sent.args.serviceKey, 'winter_property_care');
    assert.equal(sent.args.requirement, 'winter_proof');
    assert.equal(sent.args.minCount, 2);
    assert.equal(sent.args.requiresGeotag, true);
    assert.equal(sent.args.enforcement, 'blocking');
  });

  await record('D3 withdrawing a requirement asks, and says what it means',
    async () => {
      const { calls, confirms } = await withPanel({ which: 'policy' },
        async ({ mount, h }) => {
          await h.settle(200);
          const rows = [...mount.querySelectorAll('.row-item')];
          const siding = rows.find((r) => r.textContent.includes('Siding'));
          [...siding.querySelectorAll('button')]
            .find((b) => b.textContent.trim() === 'Withdraw').click();
          await h.settle(220);
        });
      assert.equal(calls.filter((c) => c.name === 'retireEvidencePolicy').length, 1);
      assert.match(confirms[0], /no rule for it/i,
        'the consequence is in the question');
    });

  await record('D4 an empty policy list says what that means for every job',
    async () => {
      const { out } = await withPanel({ which: 'policy', policies: [], version: 0 },
        async ({ mount, h }) => {
          await h.settle(200);
          return { text: mount.textContent };
        });
      assert.match(out.text, /nobody has said/i);
      assert.match(out.text, /accepted with that recorded/i);
    });

  // ====================== E. layout and keyboard =========================

  await record('E1 no horizontal overflow at 390, 430 or desktop', async () => {
    for (const which of ['job', 'policy']) {
      for (const width of [390, 430, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        const over = await page.evaluate(async (w) => {
          const mount = document.createElement('div');
          document.body.appendChild(mount);
          const mod = w === 'policy'
            ? await import('/admin/js/components/evidence-policy.js')
            : await import('/admin/js/components/job-evidence.js');
          const panel = w === 'policy'
            ? mod.evidencePolicyPanel({})
            : mod.jobEvidencePanel({ jobId: 'job-1' });
          mount.appendChild(panel.root);
          await new Promise((r) => setTimeout(r, 300));
          const width2 = document.documentElement.scrollWidth;
          mount.remove();
          return { scrollWidth: width2, viewport: window.innerWidth };
        }, which);
        assert.ok(over.scrollWidth <= over.viewport + 1,
          `${which} is ${over.scrollWidth}px wide at ${over.viewport}px`);
      }
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  });

  await record('E2 every control is reachable and labelled for the keyboard',
    async () => {
      for (const which of ['job', 'policy']) {
        const out = await page.evaluate(async (w) => {
          const mount = document.createElement('div');
          document.body.appendChild(mount);
          const mod = w === 'policy'
            ? await import('/admin/js/components/evidence-policy.js')
            : await import('/admin/js/components/job-evidence.js');
          const panel = w === 'policy'
            ? mod.evidencePolicyPanel({})
            : mod.jobEvidencePanel({ jobId: 'job-1' });
          mount.appendChild(panel.root);
          await new Promise((r) => setTimeout(r, 300));

          const controls = [...mount.querySelectorAll('input, select, textarea, button')];
          const unreachable = controls.filter((c) =>
            c.disabled === false && c.tabIndex < 0);
          const unlabelled = controls.filter((c) => {
            if (c.tagName === 'BUTTON') return !c.textContent.trim();
            if (c.getAttribute('aria-label')) return false;
            // A control inside a <label> is labelled by it.
            return !c.closest('label');
          });
          // A <label> may only contain phrasing content; a div or a button
          // inside one is the Batch 8.1/9.1 finding, and it breaks the
          // click-to-focus a keyboard user relies on.
          const badLabels = [...mount.querySelectorAll('label')]
            .filter((l) => l.querySelector('div, p, button, h1, h2, h3'));

          const r = {
            controls: controls.length,
            unreachable: unreachable.length,
            unlabelled: unlabelled.map((c) => c.tagName + (c.type ? `[${c.type}]` : '')),
            badLabels: badLabels.length
          };
          mount.remove();
          return r;
        }, which);

        assert.ok(out.controls > 4, `${which} renders controls`);
        assert.equal(out.unreachable, 0, `${which} has unreachable controls`);
        assert.deepEqual(out.unlabelled, [], `${which} has unlabelled controls`);
        assert.equal(out.badLabels, 0,
          `${which} puts block content inside a <label>`);
      }
    });

  await browser.close();
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.ok ? '' : `\n      ${r.err}`}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed) process.exit(1);
})();
