// Visual QA for Batch 13.1: the customer handover panel and the customer's
// own report page, at 390 / 430 / desktop.
//
//   node tests/screenshot-batch13-1.mjs      (static server must be on :8743)
//
// Writes PNGs into /tmp/ns-batch13-1/ and reports what a screenshot alone
// hides: an element overhanging the viewport (it sits off-canvas to the
// right), a control under the project's own tap target, and a page error.
//
// Fixture content is awkward on purpose: a very long customer name, an
// unbreakable email, a withheld photograph, an uncertain delivery, a link
// that has been withdrawn, and a job with no accepted quote.

import { mkdirSync } from 'node:fs';
import pkg from '/opt/node-tools/node_modules/playwright/index.js';
import { BASE, FAKE_CAPACITOR_CORE } from './test-harness.mjs';

const { chromium } = pkg;
const OUT = '/tmp/ns-batch13-1';
mkdirSync(OUT, { recursive: true });

const FAKE_SUPABASE_ADMIN = `
  export const supabase = { auth: { signOut: async () => {} } };
  export async function getSession() { return { session: { user: { id: 'admin-1' } }, isAdmin: true }; }
`;

const FAKE_SUPABASE_SITE = `
  const clone = (v) => JSON.parse(JSON.stringify(v));
  export const supabase = {
    auth: { signOut: async () => {} },
    rpc: async (name) => {
      const t = globalThis.__RPC || {};
      return name in t ? { data: clone(t[name]), error: null }
                       : { data: null, error: { message: 'no stub' } };
    }
  };
  export async function getSession() { return { session: null, isAdmin: false }; }
`;

const LONG_NAME = 'FIXTURE Bartholomew Featherstonehaugh-Montmorency III';
const LONG_EMAIL = 'accounts.receivable.department@averyverylongcompanydomainname.test';

const DOCUMENT = {
  document_kind: 'completion_report', document_version: 1,
  company: { state: 'configured', name: 'Nova Shield Maintenance Services',
             phone: '437-436-3360', email: LONG_EMAIL },
  customer: { customer_id: 'cust-1', name: LONG_NAME },
  property: { address_line1: '1 Exceptionally Long Fixture Avenue South-West',
              city: 'Fixtureville' },
  job: { job_id: 'job-1' },
  completion: { completion_id: 'comp-1', accepted_at: '2027-09-14T17:02:00Z',
    work_finished_at: null, work_finished_state: 'unknown',
    reported_work_time_state: 'unknown' },
  work: [
    { description: 'Siding soft washing, all four elevations including the '
      + 'dormers and the rear addition', service: 'Siding Soft Washing' },
    { description: 'Gutter brightening', service: 'Gutter Brightening' }
  ],
  evidence: [{ evidence_id: 'ev-1', requirement: 'after',
    caption: 'The rear elevation after washing, taken from the lane',
    capture_time_state: 'unknown', captured_at: null,
    location_state: 'denied',
    verification: 'device_reported_not_server_verified',
    received_at: '2027-09-14T16:40:00Z' }],
  evidence_withheld_count: 2,
  materials: [
    { material: 'FIXTURE siding soap concentrate (industrial)', quantity: 2.5,
      level: null, unit: 'litre', measurement_state: 'estimated' },
    { material: 'FIXTURE brush head', quantity: null, level: 'part',
      unit: 'level', measurement_state: 'level_observed' }
  ],
  materials_note: 'Reported for your records. Materials are not charged from '
    + 'these figures.',
  commercials: {
    accepted_quote: { quote_id: 'q-1', version: 1, total: 4820.5 },
    approved_changes: [{ change_order_id: 'co-1',
      description: 'Replace a cracked downspout at the north-east corner',
      amount: 120 }],
    approved_total: 4940.5, currency: 'CAD',
    currency_state: 'from_accepted_quote', commercial_state: 'accepted_quote'
  }
};

const FAKE_API = `
  const clone = (v) => JSON.parse(JSON.stringify(v));
  export function newOperationId(p) { return (p || 'op') + '-fixed'; }
  export async function jobCompletionReports() { return clone(globalThis.__REPORTS); }
  export async function customerGrants() { return clone({ grants: globalThis.__GRANTS }); }
  export async function reportDeliveries() { return clone({ deliveries: globalThis.__DELIVERIES }); }
  export async function reportDeliveryTiming() { return clone({ deliveries: globalThis.__TIMING }); }
  export async function jobPaymentState() { return clone(globalThis.__PAYMENT); }
  export async function setEvidencePublication() { return {}; }
  export async function generateCompletionReport() { return {}; }
  export async function publishCompletionReport() { return {}; }
  export async function issueCustomerGrant() { return { token: 'a'.repeat(64), token_state: 'shown_once' }; }
  export async function revokeCustomerGrant() { return {}; }
  export async function deliverCompletionReport() { return {}; }
`;

const REPORTS = {
  job_id: 'job-1',
  reports: [
    { report_id: 'rep-2', report_version: 2, completion_id: 'comp-1',
      source_version: 'sv-2', supersedes: 'rep-1',
      publication_state: 'published', review_hold: null,
      generated_at: '2027-09-15T09:00:00Z', published_at: '2027-09-15T09:05:00Z',
      superseded_at: null, document: DOCUMENT },
    { report_id: 'rep-1', report_version: 1, completion_id: 'comp-1',
      source_version: 'sv-1', supersedes: null,
      publication_state: 'superseded',
      review_hold: null, generated_at: '2027-09-14T17:10:00Z',
      published_at: '2027-09-14T17:12:00Z',
      superseded_at: '2027-09-15T09:00:00Z', document: DOCUMENT }
  ],
  undecided_evidence: [
    { evidence_id: 'ev-9', requirement: 'access_hazard', attachment_id: 'att-9',
      received_at: '2027-09-14T16:41:00Z' },
    { evidence_id: 'ev-10', requirement: 'site_condition', attachment_id: 'att-10',
      received_at: '2027-09-14T16:42:00Z' }
  ]
};

const GRANTS = [
  { grant_id: 'g-1', scope: 'report', report_id: 'rep-2',
    label: 'Completion report v2', token_prefix: '3f9a2b11',
    issued_at: '2027-09-15T09:06:00Z', expires_at: '2027-12-31T23:59:59Z',
    revoked_at: null, revoked_reason: null, state: 'valid',
    read_count: 3, last_read_at: '2027-09-16T08:10:00Z' },
  { grant_id: 'g-0', scope: 'report', report_id: 'rep-2',
    label: 'The first one, sent to the wrong address', token_prefix: '91c4de02',
    issued_at: '2027-09-15T09:00:00Z', expires_at: '2027-12-31T23:59:59Z',
    revoked_at: '2027-09-15T09:04:00Z',
    revoked_reason: 'Sent to the wrong address and withdrawn immediately',
    state: 'revoked', read_count: 0, last_read_at: null }
];

const DELIVERIES = [
  { delivery_id: 'd-2', channel: 'sms', delivery_state: 'unknown',
    reason: 'The provider accepted the message and then timed out before '
      + 'confirming anything', provider_message_id: null,
    recipient_known: true, grant_id: 'g-1', notification_id: 'n-2',
    requested_at: '2027-09-15T09:07:00Z', enqueued_at: '2027-09-15T09:07:00Z',
    resolved_at: null, sent: false },
  { delivery_id: 'd-1', channel: 'email', delivery_state: 'unavailable',
    reason: 'This customer has no email on file, so nothing was sent.',
    recipient_known: false, grant_id: null, notification_id: null,
    requested_at: '2027-09-15T09:06:30Z', enqueued_at: null,
    resolved_at: null, sent: false }
];

const TIMING = [
  { delivery_id: 'd-2', channel: 'sms', delivery_state: 'unknown',
    accepted_at: '2027-09-14T17:02:00Z', readiness_at: '2027-09-15T09:05:00Z',
    report_generated_at: '2027-09-15T09:00:00Z',
    enqueued_at: '2027-09-15T09:07:00Z', resolved_at: null,
    acceptance_to_readiness_seconds: 57480, local_processing_seconds: 57600,
    provider_seconds: null, review_hold: null,
    sla_state: 'indeterminate', sla_basis: 'server acceptance of the completion '
      + 'to the provider\'s own outcome' },
  { delivery_id: 'd-1', channel: 'email', delivery_state: 'unavailable',
    accepted_at: '2027-09-14T17:02:00Z', readiness_at: '2027-09-15T09:05:00Z',
    report_generated_at: '2027-09-15T09:00:00Z', enqueued_at: null,
    resolved_at: null, acceptance_to_readiness_seconds: 57480,
    local_processing_seconds: null, provider_seconds: null, review_hold: null,
    sla_state: 'indeterminate', sla_basis: 'server acceptance …' }
];

const PAYMENT = {
  job_id: 'job-1', approved_total: 4940.5, currency: 'CAD',
  currency_state: 'from_accepted_quote', amount_settled: null,
  remaining_balance: null, balance_state: 'no_settlement_model',
  missing_dependency: 'There is no invoice or payment-received model in this '
    + 'system, so what remains outstanding is not knowable. A payment request '
    + 'cannot bind an amount until one exists.',
  provider: null, provider_configured: false, feature_state: 'unavailable',
  requests: [],
  remaining_provider_work: [
    'a settlement model: what was invoiced, what was received, and when',
    'server-side verification of the provider\'s own confirmation'
  ]
};

const VIEWS = [
  ['390', 390, 900], ['430', 430, 900], ['desktop', 1280, 1000]
];

(async () => {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', (e) => {
    if (/listTodaysVisits is not a function/.test(e.message)) return;
    problems.push(`page error: ${e.message}`);
  });
  /* TWO EXPECTED NOISES, named so they cannot hide a third. field.html's own
     router runs against this script's partial api.js stub and cannot find
     listTodaysVisits; and the Google Fonts stylesheet fails TLS through the
     sandbox proxy. Neither is this batch's code. */
  const EXPECTED_NOISE = [/listTodaysVisits is not a function/,
                          /ERR_CERT_AUTHORITY_INVALID/];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (EXPECTED_NOISE.some((r) => r.test(m.text()))) return;
    problems.push(`console error: ${m.text()}`);
  });

  const mock = (p, body) => page.route(p, (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body }));
  await mock('**/cdn.jsdelivr.net/npm/@capacitor/core@8.5.2/+esm', FAKE_CAPACITOR_CORE);
  await mock(`${BASE}/admin/js/lib/api.js`, FAKE_API);

  /* --------------------------------------------- the admin panel ------- */
  await page.route(`${BASE}/shared/supabase.js`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript',
                body: FAKE_SUPABASE_ADMIN }));

  for (const [label, width, height] of VIEWS) {
    await page.setViewportSize({ width, height });
    await page.goto(`${BASE}/admin/field.html`);
    await page.waitForTimeout(150);
    const report = await page.evaluate(async (fixtures) => {
      Object.assign(globalThis, fixtures);
      document.querySelectorAll('[data-shot]').forEach((n) => n.remove());
      const mount = document.createElement('div');
      mount.dataset.shot = '1';
      mount.style.padding = '12px';
      document.body.appendChild(mount);
      const mod = await import('/admin/js/components/customer-handover.js');
      mount.appendChild(mod.customerHandoverPanel({
        jobId: 'job-1', completionId: 'comp-1' }));
      await new Promise((r) => setTimeout(r, 320));

      const over = [...mount.querySelectorAll('*')]
        .filter((n) => n.getBoundingClientRect().right > window.innerWidth + 1)
        .map((n) => `${n.tagName.toLowerCase()}.${n.className}`);
      const small = [...mount.querySelectorAll('button, input, select')]
        .filter((n) => {
          const r = n.getBoundingClientRect();
          // 34px is admin.css's own `.btn--sm` height; anything under it is
          // smaller than the project's smallest deliberate control.
          return r.height > 0 && r.height < 34;
        })
        .map((n) => `${n.tagName.toLowerCase()}:${(n.textContent || n.type).trim()}`);
      return {
        overflow: [...new Set(over)],
        small: [...new Set(small)],
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1
      };
    }, { __REPORTS: REPORTS, __GRANTS: GRANTS, __DELIVERIES: DELIVERIES,
         __TIMING: TIMING, __PAYMENT: PAYMENT });

    await page.screenshot({ path: `${OUT}/handover-${label}.png`, fullPage: true });
    if (report.pageOverflow) problems.push(`handover @${label}: the page scrolls sideways`);
    for (const o of report.overflow) problems.push(`handover @${label}: ${o} overhangs`);
    for (const s of report.small) problems.push(`handover @${label}: ${s} under 38px tall`);
  }

  /* ------------------------------------------- the customer page ------- */
  await page.route(`${BASE}/shared/supabase.js`, (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript',
                body: FAKE_SUPABASE_SITE }));

  const PAGES = [
    ['report', {
      list_customer_documents: { state: 'ok', scope: 'report', documents: [] },
      get_customer_report: { state: 'ok', message: null, report_id: 'rep-2',
        report_version: 2, issued_at: '2027-09-15T09:05:00Z',
        document: DOCUMENT, documents: [{ evidence_id: 'ev-1',
          caption: 'The rear elevation after washing, taken from the lane',
          requirement: 'after' }] }
    }],
    ['report-superseded', {
      list_customer_documents: { state: 'ok', scope: 'report', documents: [] },
      get_customer_report: { state: 'superseded',
        message: 'We have since issued a corrected version of this report. '
          + 'Please get in touch for the latest one.',
        report_id: 'rep-1', report_version: 1,
        issued_at: '2027-09-14T17:12:00Z', document: DOCUMENT, documents: [] }
    }],
    ['report-no-quote', {
      list_customer_documents: { state: 'ok', scope: 'report', documents: [] },
      get_customer_report: { state: 'ok', report_id: 'rep-3',
        report_version: 1, issued_at: '2027-09-15T09:05:00Z',
        document: { ...DOCUMENT, commercials: { accepted_quote: null,
          approved_changes: [], approved_total: null, currency: null,
          currency_state: 'unconfigured',
          commercial_state: 'no_accepted_quote' } }, documents: [] }
    }],
    ['report-expired', {
      list_customer_documents: { state: 'expired', documents: [] },
      get_customer_report: { state: 'expired',
        message: 'This link has expired. Get in touch and we will send a fresh one.' }
    }],
    ['report-collection', {
      list_customer_documents: { state: 'ok', scope: 'customer_collection',
        documents: [
          { report_id: 'rep-2', report_version: 2,
            issued_at: '2027-09-15T09:05:00Z', state: 'published' },
          { report_id: 'rep-1', report_version: 1,
            issued_at: '2027-05-02T10:00:00Z', state: 'superseded' }
        ] },
      get_customer_report: { state: 'ok', document: DOCUMENT }
    }]
  ];

  for (const [name, rpc] of PAGES) {
    await page.addInitScript((table) => { globalThis.__RPC = table; }, rpc);
    for (const [label, width, height] of VIEWS) {
      await page.setViewportSize({ width, height });
      await page.goto(`${BASE}/site/report.html?t=${'a'.repeat(64)}`);
      await page.waitForTimeout(320);
      await page.screenshot({ path: `${OUT}/${name}-${label}.png`, fullPage: true });
      const over = await page.evaluate(() => ({
        pageOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
        wide: [...document.querySelectorAll('#doc *')]
          .filter((n) => n.getBoundingClientRect().right > window.innerWidth + 1)
          .map((n) => `${n.tagName.toLowerCase()}.${n.className}`)
      }));
      if (over.pageOverflow) problems.push(`${name} @${label}: the page scrolls sideways`);
      for (const w of [...new Set(over.wide)]) {
        problems.push(`${name} @${label}: ${w} overhangs`);
      }
    }
  }

  await browser.close();
  console.log(`screenshots in ${OUT}`);
  if (problems.length) {
    console.log('\nPROBLEMS');
    for (const p of [...new Set(problems)]) console.log(`  - ${p}`);
    process.exit(1);
  }
  console.log('no overflow, no undersized control, no page error');
})();
