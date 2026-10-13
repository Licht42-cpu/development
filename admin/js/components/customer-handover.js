import * as api from '../lib/api.js';
import { el, select, confirmAction } from '../../../shared/dom.js';
import { fill } from '../lib/admin-dom.js';
import { trySave } from '../lib/save.js';
import { dateTime, money } from '../../../shared/format.js';

/* What the customer gets, and who can read it.
 *
 * FOUR DELIBERATE ACTS, in this order, each its own button, because each
 * one is a different mistake if it happens on its own:
 *
 *   1. decide the photographs   publishing is not the same as proving
 *   2. generate                 a frozen document from an accepted completion
 *   3. publish                  the owner says a customer may read it
 *   4. send                     mints the link and queues the message
 *
 * A single "share report" button would have collapsed all four, and the
 * one it would have collapsed most dangerously is the first: an
 * `access_hazard` photograph framing a key safe satisfies a completion
 * requirement and must never reach a customer. The default is withheld,
 * and this screen shows the count rather than letting silence pass for a
 * decision.
 *
 * WHAT THIS SCREEN REFUSES TO SAY. "Sent" appears only for a provider's own
 * `delivered`. A queued message reads "Queued — not sent yet", an uncertain
 * one reads "We do not know", and an unavailable one names which person
 * fixes it. The payment panel says "unavailable" and why, because there is
 * no settlement model in this system and a cheerful Pay button over a
 * figure nobody can reconcile is worse than no button.
 *
 * THE TOKEN IS SHOWN ONCE. The backend keeps only a hash, so this screen
 * displays a freshly issued link and never offers to show it again --
 * re-issue instead. That is deliberate: a link that can be read back is a
 * credential sitting in a list.
 */

const STATE_LABEL = {
  draft: ['Draft', 'badge--warn'],
  published: ['Published', 'badge--ok'],
  superseded: ['Superseded', 'badge--muted']
};

const DELIVERY_LABEL = {
  accepted: ['Queued — not sent yet', 'badge--warn'],
  delivered: ['Delivered', 'badge--ok'],
  provider_failed: ['The provider rejected it', 'badge--warn'],
  unknown: ['We do not know whether it arrived', 'badge--warn'],
  unavailable: ['Not available', 'badge--muted']
};

/* The evidence requirements in words. The same vocabulary the customer's
   page uses, so the owner deciding what to publish reads the same label the
   customer will. */
const REQUIREMENT_LABEL = {
  before: 'Before the work',
  after: 'After the work',
  installation: 'The installation',
  component: 'A component',
  winter_proof: 'The cleared area',
  site_condition: 'The site condition',
  access_hazard: 'Access or hazard'
};

const GRANT_LABEL = {
  valid: ['Live', 'badge--ok'],
  expired: ['Expired', 'badge--muted'],
  revoked: ['Withdrawn', 'badge--muted']
};

function badge(label, cls) {
  return el('span', { class: `badge ${cls || ''}`, text: label });
}

export function customerHandoverPanel({ jobId, completionId } = {}) {
  const host = el('div', {});
  let reports = null;
  let undecided = [];
  let grants = [];
  let deliveries = [];
  let timing = [];
  let payment = null;
  let loading = true;
  let loadError = null;
  let busy = false;
  let freshToken = null;      // shown once, never re-read
  let expiry = '';            // the owner's explicit expiry for a new link
  let channel = 'sms';

  function paint() { fill(host, body()); }

  async function act(btn, fn, success) {
    if (busy) return false;
    const was = btn ? btn.textContent : null;
    busy = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
    const ok = await trySave(fn, { success, after: async () => { await load(); } });
    busy = false;
    if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = was; }
    if (!ok) await load();
    return ok;
  }

  const current = () => (reports || []).find(r => r.publication_state !== 'superseded')
    || (reports || [])[0] || null;

  async function load() {
    loading = true; loadError = null; paint();
    try {
      const read = await api.jobCompletionReports({ jobId });
      reports = read.reports || [];
      undecided = read.undecided_evidence || [];
      const cur = current();
      if (cur) {
        // customer_grants is owner-only, so a crew reading this screen gets
        // the reports and not the link list. That is a refusal, not a
        // failure, and it must not blank the whole panel.
        try {
          const g = await api.customerGrants({ reportId: cur.report_id });
          grants = g.grants || [];
        } catch { grants = null; }
        const d = await api.reportDeliveries({ reportId: cur.report_id });
        deliveries = d.deliveries || [];
        const t = await api.reportDeliveryTiming({ reportId: cur.report_id });
        timing = t.deliveries || [];
      } else {
        grants = []; deliveries = []; timing = [];
      }
      payment = await api.jobPaymentState({ jobId });
      loading = false;
    } catch (err) {
      loading = false;
      loadError = err?.message || 'That did not load.';
    }
    paint();
  }

  /* ----------------------------------------------- the photographs -- */

  function evidenceBody() {
    if (!undecided.length) {
      return el('p', { class: 'hint', text:
        'Every photograph on this job has a publication decision.' });
    }
    return el('div', { class: 'section-box' }, [
      el('h3', { style: 'margin:0 0 4px', text:
        `${undecided.length} photograph(s) with no decision` }),
      el('p', { class: 'hint', style: 'margin:0 0 10px', text:
        'A photograph that proved the work is not automatically one a '
        + 'customer may see. Until you decide, it stays off the report.' }),
      ...undecided.map(ev => {
        const cap = el('input', { type: 'text', class: 'field',
          placeholder: 'What the customer reads (optional)',
          'aria-label': 'Customer caption for the '
            + (REQUIREMENT_LABEL[ev.requirement] || ev.requirement)
            + ' photograph' });
        const why = el('input', { type: 'text', class: 'field',
          placeholder: 'Why it is withheld',
          'aria-label': 'Reason for withholding the '
            + (REQUIREMENT_LABEL[ev.requirement] || ev.requirement)
            + ' photograph' });
        // FULL-SIZE, not `btn--sm`: deciding what a customer may see is the
        // most consequential control in this row, and the smallest target on
        // a 390px screen is the wrong place for it.
        const showBtn = el('button', { class: 'btn btn--primary',
          text: 'Customer may see it' });
        const hideBtn = el('button', { class: 'btn', text: 'Keep it back' });
        showBtn.addEventListener('click', () => act(showBtn, () =>
          api.setEvidencePublication({
            evidenceId: ev.evidence_id, decision: 'published',
            customerCaption: cap.value.trim() || null
          }), 'Published to the next report'));
        hideBtn.addEventListener('click', () => {
          if (!why.value.trim()) {
            why.focus();
            return;
          }
          act(hideBtn, () => api.setEvidencePublication({
            evidenceId: ev.evidence_id, decision: 'withheld',
            reason: why.value.trim()
          }), 'Withheld, with the reason recorded');
        });
        return el('div', { class: 'row-item' }, [
          el('div', {}, [
            el('strong', { text: REQUIREMENT_LABEL[ev.requirement]
                                 || ev.requirement }),
            el('p', { class: 'hint', style: 'margin:2px 0 0',
              text: `Received ${dateTime(ev.received_at)}` })
          ]),
          el('div', { class: 'grid grid--2' }, [cap, why]),
          el('div', { class: 'btn-row' }, [showBtn, hideBtn])
        ]);
      })
    ]);
  }

  /* ---------------------------------------------------- the report -- */

  function reportBody() {
    const cur = current();
    const genBtn = el('button', { class: 'btn btn--primary',
      text: reports && reports.length ? 'Generate an updated report'
                                      : 'Generate the report' });
    genBtn.addEventListener('click', () => act(genBtn, () =>
      api.generateCompletionReport({ completionId }),
      'Generated. Nothing has been sent.'));

    const rows = (reports || []).map(r => {
      const [label, cls] = STATE_LABEL[r.publication_state] || [r.publication_state, ''];
      const pubBtn = r.publication_state === 'draft'
        ? el('button', { class: 'btn btn--sm btn--primary', text: 'Publish' })
        : null;
      if (pubBtn) {
        pubBtn.addEventListener('click', () => act(pubBtn, () =>
          api.publishCompletionReport({ reportId: r.report_id }),
          'Published. The customer still needs a link.'));
      }
      return el('div', { class: 'row-item' }, [
        el('div', {}, [
          el('strong', { text: `Report v${r.report_version}` }),
          badge(label, cls),
          // A superseding report names what it replaced, so a reader can
          // see this is a correction rather than a second opinion.
          r.supersedes
            ? el('p', { class: 'hint', style: 'margin:2px 0 0',
                text: 'Replaces an earlier version' })
            : null,
          el('p', { class: 'hint', style: 'margin:2px 0 0', text:
            `Generated ${dateTime(r.generated_at)}`
            + (r.published_at ? ` · issued ${dateTime(r.published_at)}` : '') }),
          r.review_hold
            ? el('p', { class: 'error-text', style: 'margin:4px 0 0',
                text: r.review_hold })
            : null
        ]),
        el('div', {}, [
          el('p', { class: 'hint', style: 'margin:0', text:
            `${(r.document?.evidence || []).length} photograph(s) on it`
            + (Number(r.document?.evidence_withheld_count) > 0
                ? `, ${r.document.evidence_withheld_count} withheld` : '') }),
          el('p', { class: 'hint', style: 'margin:2px 0 0', text:
            r.document?.commercials?.commercial_state === 'accepted_quote'
              ? `Total ${money(r.document.commercials.approved_total)}`
              : 'No accepted quote, so the report carries no total' })
        ]),
        pubBtn ? el('div', { class: 'btn-row' }, [pubBtn]) : null
      ]);
    });

    return el('div', { class: 'section-box' }, [
      el('h3', { style: 'margin:0 0 4px', text: 'The customer’s report' }),
      el('p', { class: 'hint', style: 'margin:0 0 10px', text:
        'Built from the accepted completion. Generating it sends nothing.' }),
      rows.length ? el('div', {}, rows)
                  : el('p', { class: 'hint', text: 'No report yet.' }),
      completionId ? el('div', { class: 'btn-row' }, [genBtn]) : null,
      cur && cur.publication_state === 'superseded'
        ? el('p', { class: 'hint', text:
            'The newest report is a correction of an earlier one. The older '
            + 'link still opens and tells the customer it was corrected.' })
        : null
    ]);
  }

  /* ----------------------------------------------------- the links -- */

  function linksBody() {
    const cur = current();
    if (!cur) return null;
    if (grants === null) {
      return el('div', { class: 'section-box' }, [
        el('h3', { style: 'margin:0 0 4px', text: 'Customer links' }),
        el('p', { class: 'hint', text:
          'Customer links are the owner’s to see.' })
      ]);
    }

    const expiryInput = el('input', {
      type: 'date', class: 'field', value: expiry,
      'aria-label': 'The day this link stops working',
      onInput: (e) => { expiry = e.target.value; }
    });
    const issueBtn = el('button', { class: 'btn btn--primary', text: 'Issue a link' });
    issueBtn.addEventListener('click', async () => {
      const ok = await act(issueBtn, async () => {
        const res = await api.issueCustomerGrant({
          // SAID OUT LOUD, not left to the wrapper's default: this screen
          // mints single-report links only. A customer's whole collection
          // is a deliberate, separate grant and not something a job screen
          // hands out as a side effect.
          scope: 'report',
          reportId: cur.report_id,
          expiresAt: expiry ? `${expiry}T23:59:59Z` : null
        });
        freshToken = res.token || null;
      }, 'Link issued. Copy it now — it is not shown again.');
      if (!ok) freshToken = null;
    });

    return el('div', { class: 'section-box' }, [
      el('h3', { style: 'margin:0 0 4px', text: 'Customer links' }),
      el('p', { class: 'hint', style: 'margin:0 0 10px', text:
        'A link opens this one report. Set when it should stop working — '
        + 'there is no default until you set one in Settings.' }),

      cur.publication_state === 'draft'
        ? el('p', { class: 'hint', text:
            'Publish the report first. A draft has no customer link.' })
        : el('div', {}, [
            el('div', { class: 'grid grid--2' }, [
              el('label', { class: 'field' }, [
                el('span', { text: 'Stops working after' }), expiryInput
              ]),
              el('div', { class: 'btn-row' }, [issueBtn])
            ]),
            // SHOWN ONCE. There is no "reveal" button anywhere, because the
            // backend keeps only a hash and could not answer one.
            freshToken
              ? el('div', { class: 'section-box' }, [
                  el('strong', { text: 'The link, shown once' }),
                  el('p', { style: 'word-break:break-all;margin:4px 0',
                            text: `report.html?t=${freshToken}` }),
                  el('p', { class: 'hint', style: 'margin:0', text:
                    'Not stored and not recoverable. If it is lost, issue a '
                    + 'new one.' })
                ])
              : null,
            grants.length
              ? el('div', {}, grants.map(g => {
                  const [label, cls] = GRANT_LABEL[g.state] || [g.state, ''];
                  const revBtn = g.state === 'valid'
                    ? el('button', { class: 'btn btn--sm', text: 'Withdraw' })
                    : null;
                  if (revBtn) {
                    revBtn.addEventListener('click', async () => {
                      if (!await confirmAction(
                        'Withdraw this link? The customer will stop being able '
                        + 'to open the report.')) return;
                      act(revBtn, () => api.revokeCustomerGrant({
                        grantId: g.grant_id,
                        reason: 'Withdrawn from the job screen'
                      }), 'Withdrawn');
                    });
                  }
                  return el('div', { class: 'row-item' }, [
                    el('div', {}, [
                      el('strong', { text: `Link ${g.token_prefix}…` }),
                      badge(label, cls),
                      el('p', { class: 'hint', style: 'margin:2px 0 0', text:
                        `Issued ${dateTime(g.issued_at)} · stops `
                        + `${dateTime(g.expires_at)}` }),
                      el('p', { class: 'hint', style: 'margin:2px 0 0', text:
                        Number(g.read_count) > 0
                          ? `Opened ${g.read_count} time(s), last `
                            + dateTime(g.last_read_at)
                          : 'Not opened yet' }),
                      g.revoked_reason
                        ? el('p', { class: 'hint', style: 'margin:2px 0 0',
                            text: g.revoked_reason })
                        : null
                    ]),
                    revBtn ? el('div', { class: 'btn-row' }, [revBtn]) : null
                  ]);
                }))
              : el('p', { class: 'hint', text: 'No links issued.' }),
            el('p', { class: 'hint', text:
              'Withdrawing stops new reads and new downloads. A download '
              + 'already started can finish.' })
          ])
    ]);
  }

  /* -------------------------------------------------- the sending -- */

  function deliveryBody() {
    const cur = current();
    if (!cur) return null;

    const sendBtn = el('button', { class: 'btn btn--primary', text: 'Send it' });
    sendBtn.addEventListener('click', async () => {
      const res = { value: null };
      await act(sendBtn, async () => {
        res.value = await api.deliverCompletionReport({
          reportId: cur.report_id, channel,
          expiresAt: expiry ? `${expiry}T23:59:59Z` : null
        });
      });
      // Deliberately no "Sent!" toast: the backend's own state decides what
      // the screen says, and `accepted` is not sent.
    });

    const live = deliveries.find(d =>
      d.delivery_state === 'accepted' || d.delivery_state === 'unknown');

    return el('div', { class: 'section-box' }, [
      el('h3', { style: 'margin:0 0 4px', text: 'Sending it' }),
      el('p', { class: 'hint', style: 'margin:0 0 10px', text:
        'Queuing a message is not sending one. Nothing here goes out on its '
        + 'own.' }),

      cur.publication_state !== 'published'
        ? el('p', { class: 'hint', text:
            'Only a published report is sent.' })
        : el('div', { class: 'grid grid--2' }, [
            el('label', { class: 'field' }, [
              el('span', { text: 'How' }),
              // {value,label} OBJECTS. shared/dom.js select() reads
              // opt.value and opt.label, so a bare [value, label] pair
              // renders an option with neither -- an empty dropdown, which
              // is what the first draft of this screen showed. And the
              // handler receives the EVENT, as every other admin view
              // already knows.
              select([{ value: 'sms', label: 'Text message' },
                      { value: 'email', label: 'Email' }], channel,
                (e) => { channel = e.target.value; })
            ]),
            el('div', { class: 'btn-row' }, [live ? null : sendBtn].filter(Boolean))
          ]),

      live
        ? el('p', { class: 'hint', text:
            'There is already a message for this report waiting on an '
            + 'outcome. Resolve it before sending another, so the customer '
            + 'does not get two.' })
        : null,

      deliveries.length
        ? el('div', {}, deliveries.map(d => {
            const [label, cls] = DELIVERY_LABEL[d.delivery_state]
              || [d.delivery_state, ''];
            const t = timing.find(x => x.delivery_id === d.delivery_id);
            return el('div', { class: 'row-item' }, [
              el('div', {}, [
                el('strong', { text: d.channel === 'sms' ? 'Text' : 'Email' }),
                badge(label, cls),
                d.reason
                  ? el('p', { class: 'hint', style: 'margin:2px 0 0', text: d.reason })
                  : null,
                el('p', { class: 'hint', style: 'margin:2px 0 0', text:
                  d.recipient_known
                    ? 'Addressed from the customer’s own contact details'
                    : 'No contact details on file' })
              ]),
              t
                ? el('div', {}, [
                    el('p', { class: 'hint', style: 'margin:0', text:
                      t.local_processing_seconds !== null
                        ? `Ours: ${Math.round(t.local_processing_seconds)}s from `
                          + 'acceptance to queued'
                        : 'Ours: not queued' }),
                    el('p', { class: 'hint', style: 'margin:2px 0 0', text:
                      t.provider_seconds !== null
                        ? `Provider: ${Math.round(t.provider_seconds)}s to answer`
                        : 'Provider: no answer yet' }),
                    el('p', { class: 'hint', style: 'margin:2px 0 0', text:
                      t.sla_state === 'met' ? 'Inside two minutes'
                      : t.sla_state === 'missed' ? 'Over two minutes'
                      : t.sla_state === 'failed' ? 'Did not arrive'
                      : t.sla_state === 'awaiting_provider' ? 'Waiting on the provider'
                      : 'Cannot be judged — no provider, or no answer' })
                  ])
                : null
            ]);
          }))
        : el('p', { class: 'hint', text: 'Nothing sent yet.' })
    ]);
  }

  /* --------------------------------------------------- the payment -- */

  function paymentBody() {
    if (!payment) return null;
    const unavailable = payment.feature_state !== 'available';
    return el('div', { class: 'section-box' }, [
      el('h3', { style: 'margin:0 0 4px', text: 'Paying' }),
      el('div', {}, [
        el('p', { style: 'margin:0', text:
          payment.approved_total !== null
            ? `Approved: ${money(payment.approved_total)}`
              + (payment.currency ? ` ${payment.currency}` : ' (currency not set)')
            : 'No accepted quote, so there is no agreed amount.' }),
        // THE DISTINCTION THE WHOLE PANEL TURNS ON: agreed is not
        // outstanding, and this screen refuses to print the first as the
        // second.
        el('p', { class: 'hint', style: 'margin:2px 0 0', text:
          payment.balance_state === 'established'
            ? `Outstanding: ${money(payment.remaining_balance)}`
            : 'What has been paid is not recorded anywhere in this system, '
              + 'so there is no outstanding balance to show.' })
      ]),
      unavailable
        ? el('p', { class: 'hint', style: 'margin:8px 0 0', text:
            payment.provider_configured
              ? payment.missing_dependency
                || 'Payment is unavailable for this job.'
              : 'No payment provider is selected, so online payment is '
                + 'unavailable. Choose one in Settings.' })
        : null,
      // No Pay button while the feature is unavailable: a control that can
      // only fail is noise, and a cheerful one over an unreconcilable
      // figure is worse.
      el('p', { class: 'hint', style: 'margin:8px 0 0', text:
        'Opening a payment link is never payment, and nothing here can mark '
        + 'work paid.' })
    ]);
  }

  function body() {
    return el('div', { class: 'card' }, [
      el('h2', { style: 'margin:0 0 4px', text: 'Customer handover' }),
      el('p', { class: 'hint', style: 'margin:0 0 10px', text:
        'The report of accepted work, who can read it, whether it went, and '
        + 'what is owed.' }),
      loading
        ? el('p', { class: 'hint', text: 'Loading…' })
        : loadError
          ? el('p', { class: 'error-text', text: loadError })
          : el('div', {}, [
              evidenceBody(), reportBody(), linksBody(), deliveryBody(),
              paymentBody()
            ].filter(Boolean))
    ]);
  }

  paint();
  load();
  return host;
}
