import * as api from '../lib/api.js';
import { el, toast, confirmAction } from '../../../shared/dom.js';
import { money, humanise, date } from '../../../shared/format.js';

/** Mid-job scope changes against an already-delivered quote. Deliberately
 *  separate from the quote's own line items: a sent/signed quote's total is
 *  the number the customer already saw and never moves (same invariant
 *  quote revisions protect). An approved change order adds to a combined
 *  "quote + approved extras" figure computed here, in the UI -- it never
 *  writes back into ns_quotes.total.
 *
 *  quote.ns_change_orders is expected to arrive already embedded (see
 *  api.listQuotes), the same way quote_line_items/quote_adjustments do --
 *  this stays a synchronous render, consistent with the rest of quote.js. */
export function createChangeOrdersPanel({ quote, onChange }) {
  const orders = quote.ns_change_orders || [];
  const approvedTotal = orders.filter((o) => o.status === 'approved')
    .reduce((sum, o) => sum + Number(o.amount), 0);

  const OPEN = ['pending', 'proposed'];

  function orderRow(order) {
    const badgeClass = order.status === 'approved' ? 'badge--ok'
      : order.status === 'declined' ? 'badge--muted' : 'badge--warn';
    const unpriced = order.amount === null || order.amount === undefined;

    /* A crew's proposal arrives with NO amount, which is the whole point:
       it may not name a price. So the figure is typed here, by the owner,
       at the moment of approval -- and the backend refuses an approval
       without one, so this input is not the only thing standing between a
       proposal and approved money with no number behind it. */
    const priceInput = el('input', {
      type: 'number', inputmode: 'decimal', min: '0', step: '1',
      placeholder: '0', 'aria-label': `Amount for ${order.description}`,
      style: 'width:90px'
    });
    if (!unpriced) priceInput.value = String(order.amount);

    return el('div', { class: 'qline' }, [
      el('span', {}, [
        order.description,
        el('span', { class: 'qline__sub', text: [
          date(order.created_at),
          order.proposed_by ? 'proposed from the field' : null
        ].filter(Boolean).join(' · ') })
      ]),
      el('span', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' }, [
        // UNPRICED IS NOT ZERO. Showing money(null) here would print $0.00
        // and read as free work.
        unpriced
          ? el('span', { class: 'badge badge--warn', text: 'Unpriced' })
          : el('span', { class: 'money', text: money(order.amount) }),
        el('span', { class: `badge ${badgeClass}`, text: humanise(order.status) }),
        OPEN.includes(order.status) ? priceInput : null,
        OPEN.includes(order.status) ? el('button', {
          class: 'btn btn--sm', text: 'Approve',
          onClick: async () => {
            const amount = Number(priceInput.value);
            if (!Number.isFinite(amount) || amount <= 0) {
              return toast('Enter the amount this is worth before approving', 'error');
            }
            try {
              await api.setChangeOrderStatus(order.id, 'approved', { amount });
              toast('Change order approved');
              onChange?.();
            } catch (err) { toast(err.message, 'error'); }
          }
        }) : null,
        OPEN.includes(order.status) ? el('button', {
          class: 'btn btn--sm btn--danger', text: 'Decline',
          onClick: async () => {
            if (!confirmAction(`Decline “${order.description}”? It stays on the record as declined.`)) return;
            try {
              await api.declineChangeOrder(order.id, 'declined at the desk');
              toast('Change order declined');
              onChange?.();
            } catch (err) { toast(err.message, 'error'); }
          }
        }) : null
      ])
    ]);
  }

  const descInput = el('input', { placeholder: 'e.g. Heavy oxidation removal on rear siding', maxlength: '160' });
  const amountInput = el('input', {
    type: 'number', inputmode: 'decimal', min: '0', step: '1',
    placeholder: 'leave empty to raise it unpriced'
  });

  const addForm = el('div', { class: 'grid grid--3', style: 'margin-top:10px' }, [
    el('label', { class: 'field', style: 'margin:0' }, [el('span', { text: 'Description' }), descInput]),
    el('label', { class: 'field', style: 'margin:0' }, [el('span', { text: 'Amount' }), amountInput]),
    el('div', { style: 'display:flex;align-items:flex-end' }, [
      el('button', {
        class: 'btn btn--sm btn--primary', text: '+ Add change order',
        onClick: async () => {
          const description = descInput.value.trim();
          const typed = amountInput.value.trim();
          if (!description) return toast('Describe the extra work', 'error');
          // An empty amount is now a legitimate answer: it raises the change
          // UNPRICED, which is what a crew's observation is. A typed amount
          // still has to be a real figure.
          let amount = null;
          if (typed !== '') {
            amount = Number(typed);
            if (!Number.isFinite(amount) || amount <= 0) {
              return toast('Enter an amount greater than zero, or leave it empty', 'error');
            }
          }
          try {
            await api.addChangeOrder(quote.id, { description, amount, jobId: quote.job_id });
            toast(amount === null
              ? 'Change order raised, unpriced and awaiting approval'
              : 'Change order added and approved');
            onChange?.();
          } catch (err) { toast(err.message, 'error'); }
        }
      })
    ])
  ]);

  const root = el('div', { class: 'card' }, [
    el('div', { class: 'card__head' }, [
      el('div', {}, [
        el('h2', { text: 'Change orders' }),
        el('p', { text: 'Extra scope found mid-job. A crew can raise one from the field but cannot price or approve it — the figure is typed here, by the owner, at the moment of approval. Approving adds to the job total without changing this quote’s own record.' })
      ])
    ]),
    orders.length ? el('div', {}, orders.map(orderRow)) : el('div', { class: 'empty', text: 'No change orders yet.' }),
    approvedTotal > 0 ? el('div', { class: 'qline qline--total' }, [
      el('span', { text: 'Quote + approved change orders' }),
      el('span', { class: 'money', text: money(Number(quote.total) + approvedTotal) })
    ]) : null,
    addForm
  ]);

  return { root };
}
