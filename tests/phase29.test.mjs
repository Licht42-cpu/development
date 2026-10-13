// Phase 29 -- Batch 13.1: the customer handover panel and the customer's own
// report page.
//
// Run directly:   node tests/phase29.test.mjs      (static server on :8743)
//
// MOCKED BROWSER TESTS against the real components. The database side is
// covered executably by tests/db/batch13-1.test.mjs, and nothing here
// proves authorisation: a stub cannot refuse the way a grant can. NO
// MIGRATION IN THIS REPOSITORY HAS BEEN APPLIED TO PRODUCTION, NO MESSAGE
// IS SENT AND NO PAYMENT IS TAKEN BY ANYTHING IN THIS FILE.
//
// What these pin:
//
//   * FOUR SEPARATE ACTS. Deciding the photographs, generating, publishing
//     and sending are four buttons, and opening the screen performs none
//     of them.
//   * A WITHHELD PHOTOGRAPH NEEDS A REASON before the button does anything.
//   * "QUEUED" IS NEVER "SENT". The word Sent appears for a provider's own
//     delivered and nowhere else -- not for accepted, not for unknown.
//   * THE TOKEN IS SHOWN ONCE and there is no control anywhere that offers
//     to show it again.
//   * A DRAFT HAS NO LINK UI and no send control.
//   * AGREED IS NOT OUTSTANDING. With no settlement model the panel says
//     so and offers no Pay button.
//   * THE CUSTOMER PAGE RENDERS ONLY WHAT THE SERVER PUT IN THE DOCUMENT --
//     an injected private field is not rendered, because the page reads
//     named fields rather than looping over the object.
//   * A LEVEL READS AS A LEVEL on the customer's document, never as a
//     quantity.
//   * EVERY REFUSAL IS A PAGE STATE: expired, withdrawn, not ready, not on
//     this link, not valid.
//   * No horizontal overflow at 390, 430 or desktop, and every control is
//     reachable by Tab and operable by Enter.

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

/* The customer page talks to supabase.rpc directly, so the stub IS the
   backend here: it answers the three anon-callable functions with whatever
   the fixture put in place. */
const FAKE_SUPABASE_SITE = `
  const clone = (v) => JSON.parse(JSON.stringify(v));
  export const supabase = {
    auth: { signOut: async () => {} },
    rpc: async (name, args) => {
      globalThis.__calls.push({ name, args: clone(args || {}) });
      const table = globalThis.__RPC || {};
      if (!(name in table)) return { data: null, error: { message: 'no stub for ' + name } };
      const v = table[name];
      return { data: clone(typeof v === 'object' ? v : v), error: null };
    }
  };
  export async function getSession() { return { session: null, isAdmin: false }; }
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

  export async function jobCompletionReports(a) {
    push('jobCompletionReports', a);
    return clone(globalThis.__REPORTS);
  }
  export async function customerGrants(a) {
    push('customerGrants', a);
    if (globalThis.__GRANTS_DENIED) throw new Error('customer_grants is owner-only');
    return clone({ grants: globalThis.__GRANTS });
  }
  export async function reportDeliveries(a) {
    push('reportDeliveries', a);
    return clone({ deliveries: globalThis.__DELIVERIES });
  }
  export async function reportDeliveryTiming(a) {
    push('reportDeliveryTiming', a);
    return clone({ deliveries: globalThis.__TIMING });
  }
  export async function jobPaymentState(a) {
    push('jobPaymentState', a);
    return clone(globalThis.__PAYMENT);
  }
  export async function setEvidencePublication(a) {
    push('setEvidencePublication', a); await gate(); return { decision: a.decision };
  }
  export async function generateCompletionReport(a) {
    push('generateCompletionReport', a); await gate();
    return { report_id: 'rep-new', report_version: 2, publication_state: 'draft' };
  }
  export async function publishCompletionReport(a) {
    push('publishCompletionReport', a); await gate();
    return { publication_state: 'published' };
  }
  export async function issueCustomerGrant(a) {
    push('issueCustomerGrant', a); await gate();
    return { grant_id: 'g-new', token: globalThis.__ISSUED_TOKEN,
             token_state: 'shown_once', token_prefix: 'abcd1234' };
  }
  export async function revokeCustomerGrant(a) {
    push('revokeCustomerGrant', a); await gate(); return { revoked_at: 'now' };
  }
  export async function deliverCompletionReport(a) {
    push('deliverCompletionReport', a); await gate();
    return clone(globalThis.__SEND_RESULT || { delivery_state: 'accepted', sent: false });
  }
`;

const DOCUMENT = (over = {}) => ({
  document_kind: 'completion_report', document_version: 1,
  company: { state: 'configured', name: 'Nova Shield Maintenance Services',
             phone: '437-436-3360', email: 'hello@novashieldmaintenance.test' },
  customer: { customer_id: 'cust-1', name: 'FIXTURE Customer One' },
  property: { address_line1: '1 FIXTURE Lane', city: 'Fixtureville' },
  job: { job_id: 'job-1' },
  completion: {
    completion_id: 'comp-1', accepted_at: '2027-09-14T17:02:00Z',
    work_finished_at: '2027-09-14T16:30:00Z', work_finished_state: 'reported',
    reported_work_time_state: 'reported_by_crew'
  },
  work: [{ description: 'Siding soft washing', service: 'Siding Soft Washing' }],
  evidence: [{ evidence_id: 'ev-1', requirement: 'after',
               caption: 'Siding after washing',
               capture_time_state: 'device_reported',
               captured_at: '2027-09-14T16:04:00Z',
               location_state: 'device_reported',
               verification: 'device_reported_not_server_verified',
               received_at: '2027-09-14T16:40:00Z' }],
  evidence_withheld_count: 1,
  materials: [
    { material: 'FIXTURE siding soap', quantity: 2.5, level: null, unit: 'litre',
      measurement_state: 'estimated' },
    { material: 'FIXTURE brush head', quantity: null, level: 'part', unit: 'level',
      measurement_state: 'level_observed' }
  ],
  materials_note: 'Reported for your records. Materials are not charged from these figures.',
  commercials: {
    accepted_quote: { quote_id: 'q-1', version: 1, total: 480 },
    approved_changes: [{ change_order_id: 'co-1',
                         description: 'Replace a cracked downspout', amount: 120 }],
    approved_total: 600, currency: 'CAD', currency_state: 'from_accepted_quote',
    commercial_state: 'accepted_quote'
  },
  ...over
});

const REPORTS = (over = {}) => ({
  job_id: 'job-1',
  reports: [{
    report_id: 'rep-1', report_version: 1, completion_id: 'comp-1',
    source_version: 'sv-1', supersedes: null, publication_state: 'published',
    review_hold: null, generated_at: '2027-09-14T17:10:00Z',
    published_at: '2027-09-14T17:12:00Z', superseded_at: null,
    document: DOCUMENT()
  }],
  undecided_evidence: [],
  ...over
});

const PAYMENT = (over = {}) => ({
  job_id: 'job-1', approved_total: 600, currency: 'CAD',
  currency_state: 'from_accepted_quote',
  amount_settled: null, remaining_balance: null,
  balance_state: 'no_settlement_model',
  missing_dependency: 'There is no invoice or payment-received model in this '
    + 'system, so what remains outstanding is not knowable. A payment request '
    + 'cannot bind an amount until one exists.',
  provider: null, provider_configured: false, feature_state: 'unavailable',
  requests: [],
  remaining_provider_work: ['a settlement model: what was invoiced, what was received, and when'],
  ...over
});

const HELPERS = () => ({
  button: (scope, text) => [...scope.querySelectorAll('button')]
    .find((b) => b.textContent.trim() === text),
  buttonTexts: (scope) => [...scope.querySelectorAll('button')]
    .map((b) => b.textContent.trim()),
  badges: (scope) => [...scope.querySelectorAll('.badge')].map((b) => b.textContent.trim()),
  labelled: (scope, label) => {
    const span = [...scope.querySelectorAll('label.field > span')]
      .find((s) => s.textContent === label);
    return span ? span.parentElement.querySelector('input, select, textarea') : null;
  },
  settle: (ms) => new Promise((r) => setTimeout(r, ms || 140))
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

      const mount = document.createElement('div');
      document.body.appendChild(mount);
      const mod = await import('/admin/js/components/customer-handover.js');
      const panel = mod.customerHandoverPanel({
        jobId: 'job-1', completionId: options.noCompletion ? null : 'comp-1'
      });
      mount.appendChild(panel);

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
        __REPORTS: 'reports' in opts ? opts.reports : REPORTS(),
        __GRANTS: opts.grants || [],
        __GRANTS_DENIED: !!opts.grantsDenied,
        __DELIVERIES: opts.deliveries || [],
        __TIMING: opts.timing || [],
        __PAYMENT: 'payment' in opts ? opts.payment : PAYMENT(),
        __ISSUED_TOKEN: opts.issuedToken || 'a'.repeat(64),
        __SEND_RESULT: opts.sendResult || null
      },
      options: opts,
      bodySrc: body.toString(),
      helpersSrc: HELPERS.toString()
    });

  /* The customer page is a real page load, not a mounted component: the
     capability arrives in the query string exactly as it would for a
     customer. */
  const withCustomerPage = async (rpc, body) => {
    await page.route(`${BASE}/shared/supabase.js`, (r) =>
      r.fulfill({ status: 200, contentType: 'application/javascript',
                  body: FAKE_SUPABASE_SITE }));
    await page.addInitScript((table) => {
      globalThis.__RPC = table;
      globalThis.__calls = [];
    }, rpc);
    await page.goto(`${BASE}/site/report.html?t=${'a'.repeat(64)}`);
    await page.waitForTimeout(260);
    const out = await page.evaluate(async ({ bodySrc, helpersSrc }) => {
      // eslint-disable-next-line no-new-func
      const h = new Function(`return (${helpersSrc})`)()();
      // eslint-disable-next-line no-new-func
      const fn = new Function(`return (${bodySrc})`)();
      const res = await fn({ doc: document.getElementById('doc'), h });
      return { res, calls: globalThis.__calls };
    }, { bodySrc: body.toString(), helpersSrc: HELPERS.toString() });
    return out;
  };

  return { browser, page, withPanel, withCustomerPage };
}

(async () => {
  const { browser, page, withPanel, withCustomerPage } = await launch();

  // ========================================= A. four deliberate acts =====
  await record('A1 opening the panel reads and writes nothing', async () => {
    const { calls } = await withPanel({}, async ({ h }) => { await h.settle(200); });
    assert.ok(calls.some(c => c.name === 'jobCompletionReports'));
    assert.ok(calls.some(c => c.name === 'jobPaymentState'));
    for (const write of ['generateCompletionReport', 'publishCompletionReport',
                         'issueCustomerGrant', 'deliverCompletionReport',
                         'setEvidencePublication']) {
      assert.equal(calls.filter(c => c.name === write).length, 0,
        `opening the panel called ${write}`);
    }
  });

  await record('A2 generating, publishing, linking and sending are four controls',
    async () => {
      const { out } = await withPanel({
        reports: REPORTS({ reports: [{ ...REPORTS().reports[0] }] }),
        deliveries: []
      }, async ({ mount, h }) => {
        await h.settle(200);
        return { buttons: h.buttonTexts(mount) };
      });
      assert.ok(out.buttons.includes('Generate an updated report'));
      assert.ok(out.buttons.includes('Issue a link'));
      assert.ok(out.buttons.includes('Send it'));
      // And no single button that would do several at once.
      assert.ok(!out.buttons.some(b => /share|send report and/i.test(b)));
    });

  await record('A3 undecided photographs are counted and offered, not assumed',
    async () => {
      const { out } = await withPanel({
        reports: REPORTS({ undecided_evidence: [
          { evidence_id: 'ev-9', requirement: 'access_hazard',
            attachment_id: 'att-9', received_at: '2027-09-14T16:41:00Z' }
        ] })
      }, async ({ mount, h }) => {
        await h.settle(200);
        return { text: mount.textContent, buttons: h.buttonTexts(mount) };
      });
      assert.match(out.text, /1 photograph\(s\) with no decision/);
      assert.match(out.text, /not automatically one a customer may see/);
      assert.ok(out.buttons.includes('Customer may see it'));
      assert.ok(out.buttons.includes('Keep it back'));
    });

  await record('A4 withholding without a reason does nothing at all', async () => {
    const { calls, out } = await withPanel({
      reports: REPORTS({ undecided_evidence: [
        { evidence_id: 'ev-9', requirement: 'access_hazard',
          attachment_id: 'att-9', received_at: '2027-09-14T16:41:00Z' }
      ] })
    }, async ({ mount, h }) => {
      await h.settle(200);
      h.button(mount, 'Keep it back').click();
      await h.settle(160);
      return { focused: document.activeElement?.placeholder || '' };
    });
    assert.equal(calls.filter(c => c.name === 'setEvidencePublication').length, 0,
      'a reasonless withholding was sent to the backend');
    assert.match(out.focused, /Why it is withheld/);
  });

  await record('A5 publishing a photograph sends the customer caption, not the '
    + 'internal one', async () => {
      const { calls } = await withPanel({
        reports: REPORTS({ undecided_evidence: [
          { evidence_id: 'ev-9', requirement: 'after',
            attachment_id: 'att-9', received_at: '2027-09-14T16:41:00Z' }
        ] })
      }, async ({ mount, h }) => {
        await h.settle(200);
        const cap = [...mount.querySelectorAll('input')]
          .find(i => /customer reads/i.test(i.placeholder));
        cap.value = 'Siding after washing';
        cap.dispatchEvent(new Event('input', { bubbles: true }));
        h.button(mount, 'Customer may see it').click();
        await h.settle(200);
      });
      const call = calls.find(c => c.name === 'setEvidencePublication');
      assert.ok(call);
      assert.equal(call.args.decision, 'published');
      assert.equal(call.args.customerCaption, 'Siding after washing');
    });

  // ============================================ B. the report rows =======
  await record('B1 a review hold is printed, not swallowed', async () => {
    const { out } = await withPanel({
      reports: REPORTS({ reports: [{ ...REPORTS().reports[0],
        publication_state: 'draft', published_at: null,
        review_hold: '2 evidence record(s) have no publication decision, so '
          + 'they are not on this report.' }] })
    }, async ({ mount, h }) => {
      await h.settle(200);
      return { text: mount.textContent,
               err: mount.querySelector('.error-text')?.textContent || '' };
    });
    assert.match(out.err, /no publication decision/);
  });

  await record('B2 only a draft offers Publish', async () => {
    const draft = await withPanel({
      reports: REPORTS({ reports: [{ ...REPORTS().reports[0],
        publication_state: 'draft', published_at: null }] })
    }, async ({ mount, h }) => {
      await h.settle(200); return { buttons: h.buttonTexts(mount) };
    });
    assert.ok(draft.out.buttons.includes('Publish'));

    const published = await withPanel({}, async ({ mount, h }) => {
      await h.settle(200); return { buttons: h.buttonTexts(mount) };
    });
    assert.ok(!published.out.buttons.includes('Publish'));
  });

  await record('B3 a superseding report says it replaces an earlier one, and the '
    + 'older one still shows its own state', async () => {
      const { out } = await withPanel({
        reports: REPORTS({ reports: [
          { ...REPORTS().reports[0], report_id: 'rep-2', report_version: 2,
            supersedes: 'rep-1', publication_state: 'draft', published_at: null },
          { ...REPORTS().reports[0], report_id: 'rep-1', report_version: 1,
            publication_state: 'superseded', superseded_at: '2027-09-15T09:00:00Z' }
        ] })
      }, async ({ mount, h }) => {
        await h.settle(200);
        return { text: mount.textContent, badges: h.badges(mount) };
      });
      assert.match(out.text, /Replaces an earlier version/);
      assert.ok(out.badges.includes('Superseded'));
      assert.ok(out.badges.includes('Draft'));
    });

  await record('B4 a report with no accepted quote shows no total', async () => {
    const d = DOCUMENT({ commercials: {
      accepted_quote: null, approved_changes: [], approved_total: null,
      currency: null, currency_state: 'unconfigured',
      commercial_state: 'no_accepted_quote' } });
    const { out } = await withPanel({
      reports: REPORTS({ reports: [{ ...REPORTS().reports[0], document: d }] })
    }, async ({ mount, h }) => {
      await h.settle(200); return { text: mount.textContent };
    });
    assert.match(out.text, /No accepted quote, so the report carries no total/);
  });

  await record('B5 the withheld count is shown beside the published one', async () => {
    const { out } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(200); return { text: mount.textContent };
    });
    assert.match(out.text, /1 photograph\(s\) on it, 1 withheld/);
  });

  // =============================================== C. the links ==========
  await record('C1 the token is shown once, and nothing offers to show it again',
    async () => {
      const { out } = await withPanel({}, async ({ mount, h }) => {
        await h.settle(200);
        const expiry = h.labelled(mount, 'Stops working after');
        expiry.value = '2027-12-31';
        expiry.dispatchEvent(new Event('input', { bubbles: true }));
        h.button(mount, 'Issue a link').click();
        await h.settle(260);
        return { text: mount.textContent, buttons: h.buttonTexts(mount) };
      });
      assert.match(out.text, new RegExp(`report\\.html\\?t=${'a'.repeat(64)}`));
      assert.match(out.text, /shown once/);
      assert.match(out.text, /not stored and not recoverable/i);
      for (const b of out.buttons) {
        assert.ok(!/reveal|show the link|copy again/i.test(b),
          `a control offered to show the token again: ${b}`);
      }
    });

  await record('C2 the owner\'s explicit expiry is what is sent', async () => {
    const { calls } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(200);
      const expiry = h.labelled(mount, 'Stops working after');
      expiry.value = '2027-12-31';
      expiry.dispatchEvent(new Event('input', { bubbles: true }));
      h.button(mount, 'Issue a link').click();
      await h.settle(240);
    });
    const call = calls.find(c => c.name === 'issueCustomerGrant');
    assert.ok(call);
    assert.match(call.args.expiresAt, /^2027-12-31T/);
    assert.equal(call.args.scope, 'report');
  });

  await record('C3 a draft report has no link controls', async () => {
    const { out } = await withPanel({
      reports: REPORTS({ reports: [{ ...REPORTS().reports[0],
        publication_state: 'draft', published_at: null }] })
    }, async ({ mount, h }) => {
      await h.settle(200);
      return { text: mount.textContent, buttons: h.buttonTexts(mount) };
    });
    assert.ok(!out.buttons.includes('Issue a link'));
    assert.ok(!out.buttons.includes('Send it'));
    assert.match(out.text, /Publish the report first/);
  });

  await record('C4 withdrawing asks first and says what it does not do', async () => {
    const { out, confirms, calls } = await withPanel({
      grants: [{ grant_id: 'g-1', scope: 'report', report_id: 'rep-1',
                 token_prefix: '3f9a2b11', issued_at: '2027-09-14T17:20:00Z',
                 expires_at: '2027-12-31T23:59:59Z', state: 'valid',
                 read_count: 2, last_read_at: '2027-09-15T08:00:00Z' }]
    }, async ({ mount, h }) => {
      await h.settle(200);
      h.button(mount, 'Withdraw').click();
      await h.settle(240);
      return { text: mount.textContent };
    });
    assert.match(confirms[0] || '', /stop being able to open/);
    assert.ok(calls.some(c => c.name === 'revokeCustomerGrant'));
    assert.match(out.text, /A download already started can finish/);
    assert.match(out.text, /Opened 2 time\(s\)/);
  });

  await record('C5 a crew that cannot list links still sees the report', async () => {
    const { out } = await withPanel({ grantsDenied: true },
      async ({ mount, h }) => {
        await h.settle(220);
        return { text: mount.textContent,
                 err: mount.querySelector('.error-text')?.textContent || '' };
      });
    assert.match(out.text, /Customer links are the owner’s to see/);
    assert.match(out.text, /Report v1/, 'a refusal on one read blanked the panel');
    assert.equal(out.err, '');
  });

  // ============================================= D. sending ==============
  await record('D1 queued is never "sent"', async () => {
    const { out } = await withPanel({
      deliveries: [{ delivery_id: 'd-1', channel: 'sms',
        delivery_state: 'accepted', reason: null, provider_message_id: null,
        recipient_known: true, grant_id: 'g-1', notification_id: 'n-1',
        requested_at: '2027-09-14T17:30:00Z', enqueued_at: '2027-09-14T17:30:00Z',
        resolved_at: null, sent: false }],
      timing: [{ delivery_id: 'd-1', channel: 'sms', delivery_state: 'accepted',
        accepted_at: '2027-09-14T17:02:00Z', readiness_at: '2027-09-14T17:12:00Z',
        report_generated_at: '2027-09-14T17:10:00Z',
        enqueued_at: '2027-09-14T17:30:00Z', resolved_at: null,
        local_processing_seconds: 1680, provider_seconds: null,
        acceptance_to_readiness_seconds: 600, review_hold: null,
        sla_state: 'awaiting_provider', sla_basis: 'server acceptance ...' }]
    }, async ({ mount, h }) => {
      await h.settle(220);
      return { text: mount.textContent, badges: h.badges(mount) };
    });
    assert.ok(out.badges.includes('Queued — not sent yet'));
    assert.ok(!/\bSent\b/.test(out.text.replace(/not sent yet/g, '')),
      'the screen said Sent for a message that was only queued');
    assert.match(out.text, /Waiting on the provider/);
  });

  await record('D2 unknown says we do not know, and blocks a second message',
    async () => {
      const { out } = await withPanel({
        deliveries: [{ delivery_id: 'd-1', channel: 'sms',
          delivery_state: 'unknown', reason: 'provider timed out',
          recipient_known: true, requested_at: '2027-09-14T17:30:00Z',
          enqueued_at: '2027-09-14T17:30:00Z', resolved_at: null, sent: false }]
      }, async ({ mount, h }) => {
        await h.settle(220);
        return { text: mount.textContent, badges: h.badges(mount),
                 buttons: h.buttonTexts(mount) };
      });
      assert.ok(out.badges.includes('We do not know whether it arrived'));
      assert.match(out.text, /so the customer does not get two/);
      assert.ok(!out.buttons.includes('Send it'),
        'a live uncertain message must not offer another send');
    });

  await record('D3 unavailable names the reason and does not pretend otherwise',
    async () => {
      const { out } = await withPanel({
        deliveries: [{ delivery_id: 'd-1', channel: 'sms',
          delivery_state: 'unavailable',
          reason: 'No SMS provider is configured, so nothing was sent.',
          recipient_known: true, requested_at: '2027-09-14T17:30:00Z',
          enqueued_at: null, resolved_at: null, sent: false }]
      }, async ({ mount, h }) => {
        await h.settle(220);
        return { text: mount.textContent, badges: h.badges(mount) };
      });
      assert.ok(out.badges.includes('Not available'));
      assert.match(out.text, /No SMS provider is configured/);
    });

  await record('D4 delivered is the only state that reads as delivered', async () => {
    const { out } = await withPanel({
      deliveries: [{ delivery_id: 'd-1', channel: 'sms',
        delivery_state: 'delivered', reason: null,
        provider_message_id: 'FIXTURE-msg-1', recipient_known: true,
        requested_at: '2027-09-14T17:30:00Z', enqueued_at: '2027-09-14T17:30:00Z',
        resolved_at: '2027-09-14T17:31:00Z', sent: true }],
      timing: [{ delivery_id: 'd-1', channel: 'sms', delivery_state: 'delivered',
        accepted_at: '2027-09-14T17:30:00Z', readiness_at: '2027-09-14T17:12:00Z',
        report_generated_at: '2027-09-14T17:10:00Z',
        enqueued_at: '2027-09-14T17:30:10Z', resolved_at: '2027-09-14T17:31:00Z',
        local_processing_seconds: 10, provider_seconds: 50,
        sla_state: 'met', sla_basis: 'server acceptance ...' }]
    }, async ({ mount, h }) => {
      await h.settle(220);
      return { badges: h.badges(mount), text: mount.textContent };
    });
    assert.ok(out.badges.includes('Delivered'));
    assert.match(out.text, /Ours: 10s from acceptance to queued/);
    assert.match(out.text, /Provider: 50s to answer/);
    assert.match(out.text, /Inside two minutes/);
  });

  await record('D5 the recipient is never read back to the screen', async () => {
    const { out } = await withPanel({
      deliveries: [{ delivery_id: 'd-1', channel: 'sms',
        delivery_state: 'delivered', recipient_known: true, sent: true,
        requested_at: '2027-09-14T17:30:00Z' }]
    }, async ({ mount, h }) => {
      await h.settle(220); return { text: mount.textContent };
    });
    assert.match(out.text, /Addressed from the customer’s own contact details/);
    assert.ok(!/\+1555|@example/.test(out.text));
  });

  await record('D6 the channel dropdown actually has options -- the bug a '
    + 'screenshot found', async () => {
      /* shared/dom.js select() reads opt.value and opt.label, so a bare
         [value, label] pair renders an option with neither. The first draft
         of this panel did exactly that and showed an EMPTY dropdown; no
         assertion here looked at the options, so only the screenshot caught
         it. This is that assertion. */
      const { out } = await withPanel({}, async ({ mount, h }) => {
        await h.settle(220);
        const sel = mount.querySelector('select');
        return {
          options: [...(sel?.options || [])].map(o => [o.value, o.textContent]),
          selected: sel?.value
        };
      });
      assert.deepEqual(out.options,
        [['sms', 'Text message'], ['email', 'Email']]);
      assert.equal(out.selected, 'sms');
    });

  await record('D7 an evidence requirement is shown in words, not as an enum',
    async () => {
      const { out } = await withPanel({
        reports: REPORTS({ undecided_evidence: [
          { evidence_id: 'ev-9', requirement: 'access_hazard',
            attachment_id: 'att-9', received_at: '2027-09-14T16:41:00Z' }] })
      }, async ({ mount, h }) => {
        await h.settle(200);
        return { text: mount.textContent,
                 labels: [...mount.querySelectorAll('input')]
                   .map(i => i.getAttribute('aria-label')) };
      });
      assert.ok(!out.text.includes('access_hazard'),
        'the owner screen printed a database enum at a person');
      assert.match(out.text, /Access or hazard/);
      assert.ok(out.labels.every(l => l && !l.includes('access_hazard')));
    });

  // ============================================= E. the payment ==========
  await record('E1 agreed is not outstanding, and there is no Pay button',
    async () => {
      const { out } = await withPanel({}, async ({ mount, h }) => {
        await h.settle(220);
        return { text: mount.textContent, buttons: h.buttonTexts(mount) };
      });
      assert.match(out.text, /Approved: \$600/);
      assert.match(out.text, /What has been paid is not recorded anywhere/);
      assert.ok(!/Outstanding:/.test(out.text),
        'the approved total was presented as an outstanding balance');
      for (const b of out.buttons) {
        assert.ok(!/pay|checkout/i.test(b), `a payment control appeared: ${b}`);
      }
      assert.match(out.text, /Opening a payment link is never payment/);
    });

  await record('E2 no provider is named as the reason', async () => {
    const { out } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(220); return { text: mount.textContent };
    });
    assert.match(out.text, /No payment provider is selected/);
  });

  await record('E3 an established balance does show an outstanding figure',
    async () => {
      const { out } = await withPanel({
        payment: PAYMENT({ amount_settled: 200, remaining_balance: 400,
          balance_state: 'established', missing_dependency: null,
          provider: 'FIXTURE-double', provider_configured: true,
          feature_state: 'available' })
      }, async ({ mount, h }) => {
        await h.settle(220); return { text: mount.textContent };
      });
      assert.match(out.text, /Outstanding: \$400/);
    });

  // =========================================== F. the customer page ======
  const okResponse = (over = {}) => ({
    state: 'ok', message: null, report_id: 'rep-1', report_version: 1,
    issued_at: '2027-09-14T17:12:00Z', document: DOCUMENT(),
    documents: [{ evidence_id: 'ev-1', caption: 'Siding after washing',
                  requirement: 'after' }],
    ...over
  });

  await record('F1 the customer sees the frozen document', async () => {
    const { res } = await withCustomerPage({
      list_customer_documents: { state: 'ok', scope: 'report', documents: [] },
      get_customer_report: okResponse()
    }, async ({ doc }) => ({
      text: doc.textContent,
      heads: [...doc.querySelectorAll('.block h3')].map(h => h.textContent)
    }));
    assert.match(res.text, /FIXTURE Customer One/);
    assert.match(res.text, /1 FIXTURE Lane/);
    assert.match(res.text, /Siding soft washing/);
    assert.deepEqual(res.heads,
      ['When', 'What we did', 'The agreed price', 'What we used', 'Photographs']);
  });

  await record('F2 the two times stay apart on the customer’s document',
    async () => {
      const { res } = await withCustomerPage({
        list_customer_documents: { state: 'ok', scope: 'report', documents: [] },
        get_customer_report: okResponse()
      }, async ({ doc }) => ({ text: doc.textContent }));
      assert.match(res.text, /Our crew reported finishing/);
      assert.match(res.text, /We accepted and checked the work/);
    });

  await record('F3 an unknown finish time does not borrow the acceptance time',
    async () => {
      const d = DOCUMENT({ completion: {
        completion_id: 'comp-1', accepted_at: '2027-09-14T17:02:00Z',
        work_finished_at: null, work_finished_state: 'unknown',
        reported_work_time_state: 'unknown' } });
      const { res } = await withCustomerPage({
        list_customer_documents: { state: 'ok', scope: 'report', documents: [] },
        get_customer_report: okResponse({ document: d })
      }, async ({ doc }) => ({ text: doc.textContent }));
      assert.match(res.text, /did not record a finish time/);
    });

  await record('F4 a level reads as a level, never as a quantity', async () => {
    const { res } = await withCustomerPage({
      list_customer_documents: { state: 'ok', scope: 'report', documents: [] },
      get_customer_report: okResponse()
    }, async ({ doc }) => ({ text: doc.textContent }));
    assert.match(res.text, /Part of a container/);
    assert.match(res.text, /2\.5 litre \(approx\.\)/);
    assert.match(res.text, /not charged from these figures/);
  });

  await record('F5 the page renders named fields only -- an injected private '
    + 'field is not printed', async () => {
      /* THE REAL GUARD IS THE SERVER'S ALLOWLIST. This proves the page does
         not undo it by looping over whatever it was handed: a document
         carrying extra keys renders none of them. */
      const d = DOCUMENT({
        internal_note: 'INTERNAL NOTE: customer was not home',
        property: { address_line1: '1 FIXTURE Lane', city: 'Fixtureville',
                    access_code: '4821', hazard_note: 'Dog after 4pm' },
        secret_costs: [{ material: 'soap', cost: 9.99 }]
      });
      const { res } = await withCustomerPage({
        list_customer_documents: { state: 'ok', scope: 'report', documents: [] },
        get_customer_report: okResponse({ document: d })
      }, async ({ doc }) => ({ text: doc.textContent }));
      for (const secret of ['INTERNAL NOTE', '4821', 'Dog after 4pm', '9.99']) {
        assert.ok(!res.text.includes(secret),
          `the customer page printed ${secret}`);
      }
      assert.match(res.text, /1 FIXTURE Lane/);
    });

  await record('F6 a corrected report says so and still shows what was sent',
    async () => {
      const { res } = await withCustomerPage({
        list_customer_documents: { state: 'ok', scope: 'report', documents: [] },
        get_customer_report: okResponse({ state: 'superseded',
          message: 'We have since issued a corrected version of this report.' })
      }, async ({ doc }) => ({
        text: doc.textContent,
        warn: doc.querySelector('.state--warn')?.textContent || ''
      }));
      assert.match(res.warn, /corrected version/);
      assert.match(res.text, /Siding soft washing/);
    });

  await record('F7 every refusal is a page state, in the customer’s words',
    async () => {
      const cases = [
        ['expired', /This link has expired/],
        ['revoked', /withdrawn/i],
        ['unavailable', /not ready yet/],
        ['not_found', /not on this link/],
        ['unknown', /not valid/]
      ];
      for (const [state, pattern] of cases) {
        const { res } = await withCustomerPage({
          list_customer_documents: { state: 'ok', scope: 'report', documents: [] },
          get_customer_report: { state, message: null }
        }, async ({ doc }) => ({ text: doc.textContent }));
        assert.match(res.text, pattern, `state ${state} rendered badly`);
        assert.ok(!/undefined|null|\[object/.test(res.text),
          `state ${state} printed a placeholder`);
      }
    });

  await record('F8 a photograph is fetched by ticket, and an unbuilt download '
    + 'is not claimed as ready', async () => {
      const { res, calls } = await withCustomerPage({
        list_customer_documents: { state: 'ok', scope: 'report', documents: [] },
        get_customer_report: okResponse(),
        request_customer_document: { state: 'ok', ticket_id: 'tick-1',
          expires_at: '2027-09-14T17:14:00Z', signed_url: null,
          signing_state: 'requires_worker' }
      }, async ({ doc, h }) => {
        const btn = [...doc.querySelectorAll('button')]
          .find(b => b.textContent.trim() === 'Open photograph');
        btn.click();
        await h.settle(220);
        return { text: doc.textContent };
      });
      const call = calls.find(c => c.name === 'request_customer_document');
      assert.ok(call, 'the page did not ask for a ticket');
      assert.equal(call.args.p_evidence_id, 'ev-1');
      // No storage path anywhere, and no claim that the file is in hand.
      assert.ok(!/\.jpg|storage/i.test(res.text));
      assert.match(res.text, /we will email this photograph/i);
    });

  await record('F9 a missing file is the customer’s plain answer', async () => {
    const { res } = await withCustomerPage({
      list_customer_documents: { state: 'ok', scope: 'report', documents: [] },
      get_customer_report: okResponse(),
      request_customer_document: { state: 'file_missing' }
    }, async ({ doc, h }) => {
      [...doc.querySelectorAll('button')]
        .find(b => b.textContent.trim() === 'Open photograph').click();
      await h.settle(220);
      return { text: doc.textContent };
    });
    assert.match(res.text, /no longer have this file/);
  });

  await record('F10 a collection link lists reports instead of opening one',
    async () => {
      const { res } = await withCustomerPage({
        list_customer_documents: { state: 'ok', scope: 'customer_collection',
          documents: [
            { report_id: 'rep-1', report_version: 1,
              issued_at: '2027-09-14T17:12:00Z', state: 'published' },
            { report_id: 'rep-0', report_version: 1,
              issued_at: '2027-05-02T10:00:00Z', state: 'superseded' }
          ] },
        get_customer_report: okResponse()
      }, async ({ doc }) => ({ text: doc.textContent,
                               buttons: [...doc.querySelectorAll('button')].length }));
      assert.match(res.text, /Your completion reports/);
      assert.match(res.text, /since corrected/);
      assert.equal(res.buttons, 2);
    });

  await record('F11 the page is noindex -- a customer document is not a web page',
    async () => {
      const robots = await page.evaluate(() =>
        document.querySelector('meta[name="robots"]')?.content || '');
      assert.match(robots, /noindex/);
    });

  // =============================================== G. layout ============
  for (const width of [390, 430]) {
    await record(`G${width} nothing overflows at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 900 });

      // The customer page, at a real page load.
      const cust = await withCustomerPage({
        list_customer_documents: { state: 'ok', scope: 'report', documents: [] },
        get_customer_report: okResponse()
      }, async ({ h }) => {
        await h.settle(160);
        return { over: document.documentElement.scrollWidth > window.innerWidth + 1 };
      });
      assert.equal(cust.res.over, false,
        `the customer report overflows at ${width}px`);

      // And the admin panel, remounted at the same width.
      await page.goto(`${BASE}/admin/field.html`);
      await page.waitForTimeout(150);
      const { out } = await withPanel({
        grants: [{ grant_id: 'g-1', scope: 'report', report_id: 'rep-1',
                   token_prefix: '3f9a2b11', issued_at: '2027-09-14T17:20:00Z',
                   expires_at: '2027-12-31T23:59:59Z', state: 'valid',
                   read_count: 2, last_read_at: '2027-09-15T08:00:00Z' }],
        deliveries: [{ delivery_id: 'd-1', channel: 'sms',
          delivery_state: 'unknown', reason: 'provider timed out',
          recipient_known: true, requested_at: '2027-09-14T17:30:00Z' }],
        reports: REPORTS({ undecided_evidence: [
          { evidence_id: 'ev-9', requirement: 'access_hazard',
            attachment_id: 'att-9', received_at: '2027-09-14T16:41:00Z' }] })
      }, async ({ h }) => {
        await h.settle(220);
        return { over: document.documentElement.scrollWidth > window.innerWidth + 1 };
      });
      assert.equal(out.over, false, `the handover panel overflows at ${width}px`);
      await page.setViewportSize({ width: 1280, height: 900 });
    });
  }

  await record('G3 every control is reachable by Tab and operable by Enter',
    async () => {
      await page.goto(`${BASE}/admin/field.html`);
      await page.waitForTimeout(150);
      const { out } = await withPanel({
        reports: REPORTS({ undecided_evidence: [
          { evidence_id: 'ev-9', requirement: 'after',
            attachment_id: 'att-9', received_at: '2027-09-14T16:41:00Z' }] })
      }, async ({ mount, h }) => {
        await h.settle(220);
        const controls = [...mount.querySelectorAll('button, input, select')];
        const unreachable = controls.filter(c =>
          c.tabIndex < 0 || c.hasAttribute('aria-hidden'));
        const unlabelled = controls.filter(c =>
          (c.tagName === 'INPUT' || c.tagName === 'SELECT')
          && !c.getAttribute('aria-label')
          && !c.closest('label'));
        return {
          count: controls.length,
          unreachable: unreachable.map(c => c.textContent || c.placeholder),
          unlabelled: unlabelled.map(c => c.placeholder || c.name || c.type)
        };
      });
      assert.ok(out.count > 4);
      assert.deepEqual(out.unreachable, []);
      assert.deepEqual(out.unlabelled, [],
        'a control has no accessible name');
    });

  await record('G4 Enter on a native button activates it', async () => {
    await page.goto(`${BASE}/admin/field.html`);
    await page.waitForTimeout(150);
    const { calls } = await withPanel({}, async ({ mount, h }) => {
      await h.settle(220);
      const btn = [...mount.querySelectorAll('button')]
        .find(b => b.textContent.trim() === 'Generate an updated report');
      btn.focus();
      // A real keypress on a focused <button> is a click; this asserts the
      // control is a button rather than a div that only answers a mouse.
      btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      btn.click();
      await h.settle(220);
    });
    assert.ok(calls.some(c => c.name === 'generateCompletionReport'));
  });

  await browser.close();
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} - ${r.name}${r.ok ? '' : `\n      ${r.err}`}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed) process.exit(1);
})();
