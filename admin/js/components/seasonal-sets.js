import * as api from '../lib/api.js';
import { el, select, numberInput, confirmAction } from '../../../shared/dom.js';
import { fill } from '../lib/admin-dom.js';
import { trySave, describeWriteError } from '../lib/save.js';
import { date, dateTime, humanise } from '../../../shared/format.js';

/* Company-owned Christmas lighting sets, and the season each one is spending
 * at a customer.
 *
 * THE DISTINCTION THIS SCREEN EXISTS TO MAKE. A set is ours. A customer gets
 * seasonal use of it. So the set has a status that only ever answers "where
 * is the physical thing" -- in storage, deployed, at the repair bench, lost,
 * retired -- and the assignment answers "who has it, for which season, and
 * how far through". The old screen mixed the two into one status field,
 * which could not express a set that has served three customers.
 *
 * WHY EVERY BUTTON IS AN RPC. The conflict rule (one active assignment per
 * set), the inspection-before-release rule and the crew scoping all live in
 * the database. A screen that wrote the tables directly would be able to
 * promise one set to two customers; the grants make sure it cannot, and the
 * RPCs move the set and its assignment together so the two can never
 * disagree about whether something is on a roof.
 *
 * WHAT IT NEVER DOES. It never deletes a set or an assignment. Ending a
 * contract closes the assignment and leaves the record; a set that is gone
 * is marked lost, not removed. It also never claims a set has come back:
 * only a recorded recovery does that. */

/** Sets whose physical state the filter can narrow to. 'available' is not a
 *  status -- it is five conditions at once -- so it is a separate choice. */
const STATUS_FILTERS = [
  { value: '',            label: 'All sets' },
  { value: 'available',   label: 'Available for reuse' },
  { value: 'in_storage',  label: 'In storage' },
  { value: 'deployed',    label: 'Out at a property' },
  { value: 'in_repair',   label: 'At the repair bench' },
  { value: 'lost',        label: 'Lost' },
  { value: 'retired',     label: 'Retired' }
];

/** What an inspection can conclude. Not 'uninspected': that is the state
 *  BEFORE anybody looked, and the RPC refuses it for the same reason. */
const INSPECTION_RESULTS = [
  { value: 'usable',  label: 'Usable — back on the shelf' },
  { value: 'damaged', label: 'Damaged — to the repair bench' },
  { value: 'missing', label: 'Missing — cannot be found' }
];

/** What the crew saw at the kerb. 'uninspected' is honest and common: the
 *  set went straight into a bag and nobody has looked at it yet. */
const RECOVERY_CONDITIONS = [
  { value: 'uninspected', label: 'Came back, not looked at yet' },
  { value: 'usable',      label: 'Looks fine' },
  { value: 'damaged',      label: 'Damaged' },
  { value: 'missing',     label: 'Did not come back' }
];

/* Only the three badge variants the admin stylesheet actually defines --
   ok, warn and muted. A 'badge--danger' would read better for lost and
   missing, but inventing a class here would either do nothing or require
   editing the shared stylesheet, which the other track is also working in.
   The badge TEXT carries the severity ("Lost", "Missing"), and the reason
   list under each set spells it out in a sentence. */
const STATUS_BADGE = {
  in_storage: 'badge--ok',
  deployed:   '',
  in_repair:  'badge--warn',
  lost:       'badge--warn',
  retired:    'badge--muted'
};

const CONDITION_BADGE = {
  usable:      'badge--ok',
  uninspected: 'badge--warn',
  damaged:     'badge--warn',
  missing:     'badge--warn'
};

const CONDITION_LABEL = {
  usable: 'Usable',
  uninspected: 'Not inspected',
  damaged: 'Damaged',
  missing: 'Missing'
};

function labelled(text, control, hint) {
  return el('div', { style: 'margin:0' }, [
    el('label', { class: 'field', style: 'margin:0' }, [
      el('span', { text }),
      control
    ]),
    hint ? el('p', { class: 'hint', style: 'margin:4px 0 0', text: hint }) : null
  ].filter(Boolean));
}

function badge(text, cls) {
  return el('span', { class: `badge ${cls || ''}`.trim(), text });
}

/** Why this set cannot go to the next customer, in the operator's words.
 *  Every reason the availability view reports gets a sentence; silence would
 *  leave somebody clicking a button that is not there. */
function unavailableBecause(row, customerName) {
  const reasons = [];
  if (row.awaiting_release) {
    reasons.push(
      `Back from ${customerName || 'a customer'}'s ${row.active_season_year} season, `
      + 'not released yet');
  } else if (row.has_active_assignment) {
    reasons.push(
      `With ${customerName || 'a customer'} for ${row.active_season_year}`
      + ` (${humanise(row.active_assignment_status)})`);
  }
  if (row.out_of_service) reasons.push(`Out of service — ${humanise(row.status)}`);
  if (row.at_the_repair_bench) reasons.push('At the repair bench');
  if (row.needs_repair_or_search) {
    reasons.push(row.condition === 'missing' ? 'Last seen missing' : 'Damaged');
  }
  if (row.needs_inspection) reasons.push('Not inspected since it came back');
  return reasons;
}

/* ------------------------------------------------------------- the panel -- */

/** Returns a host element that loads itself. `onChanged` is called after any
 *  write that could affect stock, so a parent screen can refresh balances --
 *  building and stripping a set are real ledger movements. */
export function seasonalSetsPanel({ onChanged } = {}) {
  const host = el('div', {});
  let statusFilter = '';
  let showRegister = false;
  let loadError = null;
  let busy = false;          // one write at a time; buttons disable together

  /** Runs a seasonal RPC with the shared failure handling, then reloads.
   *
   *  The busy state is shown ON THE BUTTON that was pressed, and nothing
   *  else repaints until the write lands. Repainting the whole panel on
   *  entry would tear down the inline form the operator is working in --
   *  including the button mid-click -- and leave them with a toast and no
   *  idea which action it belonged to.
   *
   *  The reload is in `after` rather than inline so a refused write cannot
   *  repaint the screen as though something changed. */
  async function act(btn, fn, success) {
    if (busy) return false;
    const was = btn ? btn.textContent : null;
    busy = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
    const ok = await trySave(fn, { success, after: async () => { await load(); } });
    busy = false;
    if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = was; }
    if (ok && onChanged) {
      try { await onChanged(); } catch { /* the parent's refresh, not ours */ }
    }
    return ok;
  }

  let rows = [];
  let activeByset = new Map();
  let loading = true;

  async function load() {
    loading = true;
    loadError = null;
    paint();
    try {
      const [sets, active] = await Promise.all([
        api.listSeasonalSets(
          statusFilter === 'available' ? { availableOnly: true }
          : statusFilter ? { status: statusFilter } : {}),
        api.listSeasonalAssignments({ openOnly: true })
      ]);
      rows = sets;
      // The availability view cannot embed the customer's name (it is a
      // view, so PostgREST has no foreign key to follow), so the open
      // assignments come alongside and are matched here.
      activeByset = new Map(active.map((a) => [a.set_id, a]));
    } catch (err) {
      loadError = describeWriteError(err);
    } finally {
      loading = false;
      paint();
    }
  }

  function paint() {
    fill(host, [
      el('div', { class: 'card' }, [
        el('div', { class: 'card__head', style: 'flex-wrap:wrap;gap:8px' }, [
          el('div', {}, [
            el('h2', { text: 'Christmas lighting sets' }),
            el('p', { text:
              'Every set belongs to Nova Shield. A customer gets seasonal use of '
              + 'one, which is an assignment: temporary, and kept afterwards as '
              + 'history. Nothing here deletes a set or assumes one has come back.' })
          ]),
          el('div', { class: 'btn-row', style: 'flex-wrap:wrap' }, [
            labelled('Show', select(STATUS_FILTERS, statusFilter, async (e) => {
              statusFilter = e.target.value;
              await load();
            })),
            el('button', {
              class: `btn btn--sm${showRegister ? ' btn--primary' : ''}`,
              type: 'button',
              text: showRegister ? 'Close' : 'Register a set',
              'aria-expanded': showRegister ? 'true' : 'false',
              onClick: () => { showRegister = !showRegister; paint(); }
            })
          ])
        ]),

        showRegister ? registerCard() : null,

        loadError
          ? el('p', { class: 'error-text', text: `Could not load the sets: ${loadError}` })
          : loading
            ? el('p', { class: 'hint', text: 'Loading sets…' })
            : rows.length === 0
              ? el('p', { class: 'hint', text: statusFilter
                  ? 'No sets match that filter.'
                  : 'No sets recorded yet. Register one for each physical set you own.' })
              : el('div', {}, rows.map(setRow))
      ].filter(Boolean))
    ]);
  }

  /* ----------------------------------------------------------- one set -- */

  function setRow(row) {
    const active = activeByset.get(row.set_id) || null;
    const customerName = active?.customers?.name || null;
    const reasons = unavailableBecause(row, customerName);
    const stage = active?.status || null;

    return el('div', {
      class: 'row-item',
      dataset: { setRow: row.set_id },
      style: 'flex-direction:column;align-items:stretch;gap:8px'
    }, [
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;align-items:baseline' }, [
        el('strong', { text: row.set_code }),
        badge(humanise(row.status), STATUS_BADGE[row.status]),
        badge(CONDITION_LABEL[row.condition] || humanise(row.condition),
              CONDITION_BADGE[row.condition]),
        row.available_for_reuse ? badge('Available', 'badge--ok') : null,
        el('span', { class: 'hint', style: 'margin:0', text: [
          row.run_type, row.colour,
          row.linear_ft ? `${row.linear_ft} ft` : null,
          row.location_code ? `at ${row.location_code}` : null
        ].filter(Boolean).join(' · ') })
      ].filter(Boolean)),

      row.available_for_reuse
        ? el('p', { class: 'hint', style: 'margin:0',
            text: `Inspected ${date(row.inspected_at)} — ready for the next customer.` })
        : el('ul', { class: 'hint', style: 'margin:0;padding-left:18px' },
            reasons.map((r) => el('li', { text: r }))),

      active && active.renewal_state !== 'pending'
        ? el('p', { class: 'hint', style: 'margin:0', text:
            active.renewal_state === 'renewed'
              ? 'Customer is renewing for next season.'
              : 'Customer is not renewing. The set still has to be taken down and '
                + 'recovered before it can go to anybody else.'
            + (active.release_cutoff
                ? ` Owner's cutoff for recovery: ${date(active.release_cutoff)}.`
                : ' No recovery cutoff is set in Settings, so there is no date to work to.') })
        : null,

      el('div', { class: 'btn-row', style: 'flex-wrap:wrap' }, actionsFor(row, active, stage)),

      historyDetails(row)
    ].filter(Boolean));
  }

  /** Which buttons exist, decided from explicit FROM-states rather than a
   *  pile of negations -- the Batch 8.1 screen offered "Mark installed" on a
   *  lost set because the condition was written as "not something else". */
  function actionsFor(row, active, stage) {
    const out = [];

    if (row.available_for_reuse) {
      out.push(el('button', {
        class: 'btn btn--sm btn--primary', type: 'button', text: 'Assign to a customer',
        disabled: busy ? true : undefined,
        onClick: () => openAssign(row)
      }));
    }

    // Inspection is possible whenever the set is in our hands and the
    // verdict could change -- including re-inspecting after a repair.
    if (['in_storage', 'in_repair', 'lost'].includes(row.status)) {
      out.push(el('button', {
        class: 'btn btn--sm', type: 'button',
        text: row.condition === 'uninspected' ? 'Record inspection' : 'Re-inspect',
        disabled: busy ? true : undefined,
        onClick: () => openInspect(row)
      }));
    }

    if (stage === 'assigned') {
      out.push(el('button', {
        class: 'btn btn--sm btn--primary', type: 'button', text: 'Mark installed',
        disabled: busy ? true : undefined,
        onClick: (e) => act(e.currentTarget,
          () => api.installSeasonalSet({ assignmentId: active.id }),
          `${row.set_code} is installed.`)
      }));
      out.push(el('button', {
        class: 'btn btn--sm', type: 'button', text: 'Cancel assignment',
        disabled: busy ? true : undefined,
        onClick: async (e) => {
          if (!confirmAction(
            `Cancel ${row.set_code} for ${active.customers?.name || 'this customer'}? `
            + 'The assignment is kept as history, not deleted.')) return;
          await act(e.currentTarget,
            () => api.cancelSeasonalAssignment({ assignmentId: active.id }),
            'Assignment cancelled.');
        }
      }));
    }

    if (stage === 'installed') {
      out.push(el('button', {
        class: 'btn btn--sm btn--primary', type: 'button', text: 'Record recovery',
        disabled: busy ? true : undefined,
        onClick: () => openRecover(row, active)
      }));
      out.push(el('button', {
        class: 'btn btn--sm', type: 'button',
        text: active.renewal_state === 'pending' ? 'Record renewal' : 'Change renewal',
        disabled: busy ? true : undefined,
        onClick: () => openRenewal(row, active)
      }));
    }

    if (stage === 'removed') {
      const blocked = row.condition === 'uninspected';
      out.push(el('button', {
        class: 'btn btn--sm btn--primary', type: 'button', text: 'Release for reuse',
        disabled: (busy || blocked) ? true : undefined,
        title: blocked
          ? 'Inspect it first — releasing a set is what makes it offerable to '
            + 'the next customer.'
          : undefined,
        onClick: (e) => act(e.currentTarget,
          () => api.releaseSeasonalSet({ assignmentId: active.id }),
          `${row.set_code} is released.`)
      }));
      if (blocked) {
        out.push(el('span', { class: 'hint', style: 'margin:0;align-self:center',
          text: 'Inspect it before releasing.' }));
      }
    }

    if (!active && row.status !== 'retired') {
      out.push(el('button', {
        class: 'btn btn--sm', type: 'button', text: 'Retire',
        disabled: busy ? true : undefined,
        onClick: () => openRetire(row)
      }));
    }

    return out;
  }

  /* ---------------------------------------------------------- the forms -- */

  /** Each action opens a small inline form in place rather than a dialog: on
   *  a phone a dialog covers the row you are acting on, and the operator
   *  loses the set code they were checking. */
  function openInline(builder) {
    const holder = el('div', { class: 'section-box', style: 'margin:0' });
    fill(holder, [builder(() => holder.remove())]);
    return holder;
  }

  function mountInline(row, builder) {
    const existing = host.querySelector(`[data-inline="${row.set_id}"]`);
    if (existing) existing.remove();
    const holder = openInline(builder);
    holder.dataset.inline = row.set_id;
    // Anchored by data attribute, not by matching the visible set code: two
    // sets could legitimately share a prefix, and a DOM lookup that depends
    // on display text breaks the first time a label is reworded.
    const target = host.querySelector(`[data-set-row="${row.set_id}"]`);
    if (!target) { host.appendChild(holder); return; }
    // Before the History block, not after it: the form belongs under the
    // button that opened it. Appended to the end of the row it lands below
    // an expanded history, which on a phone can be a screen away.
    target.insertBefore(holder, target.querySelector('details'));
  }

  function openAssign(row) {
    mountInline(row, (close) => {
      const search = el('input', { class: 'input', type: 'search',
        placeholder: 'Search customers' });
      const picker = select([{ value: '', label: 'Search for a customer first' }], '', null);
      const season = numberInput(new Date().getFullYear(), null, { step: '1', min: '2000' });
      const note = el('input', { class: 'input', type: 'text', placeholder: 'Note (optional)' });
      const status = el('p', { class: 'hint', style: 'margin:6px 0 0' });

      let found = [];
      const doSearch = async () => {
        status.textContent = 'Searching…';
        try {
          found = await api.searchCustomers({ query: search.value || null, limit: 25 });
          fill(picker, found.length
            ? [el('option', { value: '', text: 'Choose a customer' }),
               ...found.map((c) => el('option', { value: c.id, text: c.name }))]
            : [el('option', { value: '', text: 'No customers matched' })]);
          status.textContent = found.length ? '' : 'No customers matched that search.';
        } catch (err) {
          status.textContent = `Could not search customers: ${describeWriteError(err)}`;
        }
      };

      return el('div', {}, [
        el('h3', { text: `Assign ${row.set_code}`, style: 'margin:0 0 8px' }),
        el('p', { class: 'hint', style: 'margin:0 0 8px', text:
          'The customer gets the use of this set for one season. The set stays ours.' }),
        el('div', { class: 'grid grid--2' }, [
          // The Search button is a SIBLING of the label, not inside it: a
          // <label> may only contain phrasing content, and a button in one
          // also hijacks the label's click target.
          el('div', {}, [
            labelled('Customer', search),
            el('button', { class: 'btn btn--sm', type: 'button', text: 'Search',
              onClick: doSearch })
          ]),
          labelled('Choose', picker)
        ]),
        el('div', { class: 'grid grid--2', style: 'margin-top:8px' }, [
          labelled('Season', season,
            'The year the season starts in. Stated, not guessed — a season read '
            + 'off today\'s date is wrong for half of December.'),
          labelled('Note', note)
        ]),
        status,
        el('div', { class: 'btn-row', style: 'margin-top:8px;flex-wrap:wrap' }, [
          el('button', {
            class: 'btn btn--sm btn--primary', type: 'button', text: 'Assign',
            onClick: async (e) => {
              if (!picker.value) { status.textContent = 'Choose a customer first.'; return; }
              const chosen = found.find((c) => c.id === picker.value);
              const ok = await act(e.currentTarget, () => api.assignSeasonalSet({
                setId: row.set_id,
                customerId: picker.value,
                seasonYear: Number(season.value),
                note: note.value || null
              }), `${row.set_code} assigned to ${chosen?.name || 'the customer'}.`);
              if (ok) close();
            }
          }),
          el('button', { class: 'btn btn--sm', type: 'button', text: 'Cancel', onClick: close })
        ])
      ]);
    });
  }

  function openInspect(row) {
    mountInline(row, (close) => {
      const result = select(INSPECTION_RESULTS, 'usable', null);
      const note = el('input', { class: 'input', type: 'text',
        placeholder: 'What you found (optional)' });
      return el('div', {}, [
        el('h3', { text: `Inspect ${row.set_code}`, style: 'margin:0 0 8px' }),
        el('p', { class: 'hint', style: 'margin:0 0 8px', text:
          'An inspection is the only thing that makes a set offerable again. '
          + 'The verdict decides where it goes: usable to the shelf, damaged to '
          + 'the bench, missing to lost.' }),
        el('div', { class: 'grid grid--2' }, [
          labelled('Result', result),
          labelled('Note', note)
        ]),
        el('div', { class: 'btn-row', style: 'margin-top:8px;flex-wrap:wrap' }, [
          el('button', {
            class: 'btn btn--sm btn--primary', type: 'button', text: 'Record inspection',
            onClick: async (e) => {
              const ok = await act(e.currentTarget, () => api.inspectSeasonalSet({
                setId: row.set_id, condition: result.value, note: note.value || null
              }), `${row.set_code} inspected.`);
              if (ok) close();
            }
          }),
          el('button', { class: 'btn btn--sm', type: 'button', text: 'Cancel', onClick: close })
        ])
      ]);
    });
  }

  function openRecover(row, active) {
    mountInline(row, (close) => {
      const cond = select(RECOVERY_CONDITIONS, 'uninspected', null);
      const where = el('input', { class: 'input', type: 'text', value: '',
        placeholder: 'base, car_a …' });
      const note = el('input', { class: 'input', type: 'text', placeholder: 'Note (optional)' });
      return el('div', {}, [
        el('h3', { text: `Recover ${row.set_code}`, style: 'margin:0 0 8px' }),
        el('p', { class: 'hint', style: 'margin:0 0 8px', text:
          'Record what came back, not whether it is reusable — that is the '
          + 'inspection\'s job. The set goes back to "not inspected" whatever '
          + 'you choose here, so last season\'s check cannot stand in for this one.' }),
        el('div', { class: 'grid grid--3' }, [
          labelled('What came back', cond),
          labelled('Where it went', where, 'Blank means your own vehicle.'),
          labelled('Note', note)
        ]),
        el('div', { class: 'btn-row', style: 'margin-top:8px;flex-wrap:wrap' }, [
          el('button', {
            class: 'btn btn--sm btn--primary', type: 'button', text: 'Record recovery',
            onClick: async (e) => {
              const ok = await act(e.currentTarget, () => api.recoverSeasonalSet({
                assignmentId: active.id,
                recoveryCondition: cond.value,
                locationCode: where.value.trim() || null,
                note: note.value || null
              }), `${row.set_code} recorded as recovered.`);
              if (ok) close();
            }
          }),
          el('button', { class: 'btn btn--sm', type: 'button', text: 'Cancel', onClick: close })
        ])
      ]);
    });
  }

  function openRenewal(row, active) {
    mountInline(row, (close) => {
      const state = select([
        { value: 'renewed',     label: 'Renewing for next season' },
        { value: 'not_renewed', label: 'Not renewing' }
      ], active.renewal_state === 'renewed' ? 'renewed' : 'not_renewed', null);
      const note = el('input', { class: 'input', type: 'text', placeholder: 'Note (optional)' });
      return el('div', {}, [
        el('h3', { text: `Renewal for ${row.set_code}`, style: 'margin:0 0 8px' }),
        el('p', { class: 'hint', style: 'margin:0 0 8px', text:
          'This records a decision and changes nothing physical. A set that is '
          + 'not being renewed is still on their roof until somebody takes it down.' }),
        el('div', { class: 'grid grid--2' }, [
          labelled('Decision', state),
          labelled('Note', note)
        ]),
        el('div', { class: 'btn-row', style: 'margin-top:8px;flex-wrap:wrap' }, [
          el('button', {
            class: 'btn btn--sm btn--primary', type: 'button', text: 'Save',
            onClick: async (e) => {
              const ok = await act(e.currentTarget, () => api.recordSetRenewal({
                assignmentId: active.id, renewalState: state.value, note: note.value || null
              }), 'Renewal recorded.');
              if (ok) close();
            }
          }),
          el('button', { class: 'btn btn--sm', type: 'button', text: 'Cancel', onClick: close })
        ])
      ]);
    });
  }

  function openRetire(row) {
    mountInline(row, (close) => {
      const qtyInput = numberInput('', null, { step: 'any', min: '0' });
      const where = el('input', { class: 'input', type: 'text', placeholder: 'base' });
      const note = el('input', { class: 'input', type: 'text', placeholder: 'Why (optional)' });
      return el('div', {}, [
        el('h3', { text: `Retire ${row.set_code}`, style: 'margin:0 0 8px' }),
        el('p', { class: 'hint', style: 'margin:0 0 8px', text:
          'The set stays on record with its whole history. If you are stripping '
          + 'it for parts, say how much goes back to stock: that is the moment '
          + 'the lights stop being an asset and become material again, and it is '
          + 'posted to the ledger once.' }),
        el('div', { class: 'grid grid--3' }, [
          labelled('Salvage back to stock', qtyInput, 'Leave blank to retire without stripping.'),
          labelled('Into which location', where, 'Blank means Base.'),
          labelled('Note', note)
        ]),
        el('div', { class: 'btn-row', style: 'margin-top:8px;flex-wrap:wrap' }, [
          el('button', {
            class: 'btn btn--sm btn--primary', type: 'button', text: 'Retire set',
            onClick: async (e) => {
              if (!confirmAction(`Retire ${row.set_code}? It stays on record, but it `
                + 'can never be assigned again.')) return;
              const q = qtyInput.value === '' ? null : Number(qtyInput.value);
              const ok = await act(e.currentTarget, () => api.retireSeasonalSet({
                setId: row.set_id,
                stripQuantity: q,
                locationCode: where.value.trim() || null,
                note: note.value || null
              }), `${row.set_code} retired.`);
              if (ok) close();
            }
          }),
          el('button', { class: 'btn btn--sm', type: 'button', text: 'Cancel', onClick: close })
        ])
      ]);
    });
  }

  /* --------------------------------------------------------- the history -- */

  /** Loaded only when opened. A set that has served three customers has
   *  three assignment rows and a dozen events; fetching that for every row
   *  on the list would be a dozen queries nobody asked for. */
  function historyDetails(row) {
    const body = el('div', {}, [el('p', { class: 'hint', text: 'Loading…' })]);
    let loaded = false;
    const node = el('details', { style: 'margin:0' }, [
      el('summary', { class: 'hint', style: 'cursor:pointer', text: 'History' }),
      body
    ]);
    node.addEventListener('toggle', async () => {
      if (!node.open || loaded) return;
      loaded = true;
      try {
        const [assignments, events] = await Promise.all([
          api.listSeasonalAssignments({ setId: row.set_id }),
          api.listRentalSetEvents(row.set_id)
        ]);
        fill(body, [
          assignments.length
            ? el('ul', { style: 'margin:6px 0;padding-left:18px' },
                assignments.map((a) => el('li', { class: 'hint', text:
                  `${a.season_year} — ${a.customers?.name || 'customer'} — `
                  + `${humanise(a.status)}`
                  + (a.recovery_condition ? `, came back ${a.recovery_condition}` : '')
                  + (a.renewal_state !== 'pending' ? `, ${humanise(a.renewal_state)}` : '') })))
            : el('p', { class: 'hint', text: 'Never assigned to anybody.' }),
          events.length
            ? el('ul', { style: 'margin:6px 0;padding-left:18px' },
                events.map((e) => el('li', { class: 'hint', text:
                  `${dateTime(e.occurred_at)} — ${humanise(e.event)}`
                  + (e.note ? ` — ${e.note}` : '') })))
            : null
        ].filter(Boolean));
      } catch (err) {
        loaded = false;   // let them try again by closing and reopening
        fill(body, [el('p', { class: 'hint',
          text: `Could not load the history: ${describeWriteError(err)}` })]);
      }
    });
    return node;
  }

  /* -------------------------------------------------------- registration -- */

  function registerCard() {
    const code = el('input', { class: 'input', type: 'text', placeholder: 'e.g. CHR-014' });
    const runType = el('input', { class: 'input', type: 'text', placeholder: 'roofline, tree …' });
    const colour = el('input', { class: 'input', type: 'text', placeholder: 'warm white …' });
    const linearFt = numberInput('', null, { step: 'any', min: '0' });
    const where = el('input', { class: 'input', type: 'text', placeholder: 'base' });
    const buildQty = numberInput('', null, { step: 'any', min: '0' });
    const note = el('input', { class: 'input', type: 'text', placeholder: 'Note (optional)' });

    return el('div', { class: 'section-box', style: 'margin:0 0 12px' }, [
      el('h3', { text: 'Register a set', style: 'margin:0 0 8px' }),
      el('p', { class: 'hint', style: 'margin:0 0 8px', text:
        'A new set starts as "not inspected" — check it over and record an '
        + 'inspection before promising it to anybody. If you built it out of '
        + 'stock, enter how much it used and that quantity leaves the shelf.' }),
      el('div', { class: 'grid grid--3' }, [
        labelled('Set code', code, 'The code written on the bag.'),
        labelled('Run type', runType),
        labelled('Colour', colour)
      ]),
      el('div', { class: 'grid grid--3', style: 'margin-top:8px' }, [
        labelled('Linear ft', linearFt),
        labelled('Stored at', where, 'Blank means Base.'),
        labelled('Built from stock', buildQty,
          'Leave blank for a set that was bought assembled.')
      ]),
      el('div', { style: 'margin-top:8px' }, [labelled('Note', note)]),
      el('div', { class: 'btn-row', style: 'margin-top:8px;flex-wrap:wrap' }, [
        el('button', {
          class: 'btn btn--sm btn--primary', type: 'button', text: 'Register',
          disabled: busy ? true : undefined,
          onClick: async (e) => {
            if (!code.value.trim()) return;
            const ok = await act(e.currentTarget, () => api.registerSeasonalSet({
              setCode: code.value.trim(),
              runType: runType.value.trim() || null,
              colour: colour.value.trim() || null,
              linearFt: linearFt.value === '' ? null : Number(linearFt.value),
              locationCode: where.value.trim() || null,
              buildQuantity: buildQty.value === '' ? null : Number(buildQty.value),
              note: note.value.trim() || null
            }), `${code.value.trim()} registered.`);
            if (ok) {
              code.value = ''; runType.value = ''; colour.value = '';
              linearFt.value = ''; buildQty.value = ''; note.value = '';
            }
          }
        })
      ])
    ]);
  }

  load();
  return host;
}
