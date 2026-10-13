import * as api from '../lib/api.js';
import { el, select, numberInput, confirmAction, toast } from '../../../shared/dom.js';
import { fill } from '../lib/admin-dom.js';
import { money, qty, num, date, dateTime, unitLabel, humanise } from '../../../shared/format.js';
import { trySave } from '../lib/save.js';
import { signedDelta, packsToUnits } from '../lib/inventory-math.js';
import { seasonalSetsPanel } from '../components/seasonal-sets.js';
import { kitsAndPiecesPanel } from '../components/kit-sheets.js';
import { loadPlanPanel } from '../components/load-plan.js';
import {
  materialUnitLabel, quantityWithUnit, LEVEL_STATES, levelLabel,
  levelBadgeClass, precisionNote, MOVEMENT_CONDITIONS, COUNT_PRECISIONS
} from '../lib/inventory-units.js';

/* Batch 8.1 -- Inventory.
 *
 * Four surfaces behind one route, selected by ?tab=:
 *
 *   stock      the parts catalogue with its derived on-hand figure, and the
 *              movement ledger behind any one part
 *   purchasing purchase orders, counted in PACKS because that is what the
 *              supplier sells, with receiving that converts to units once
 *   mapping    what each service consumes per measured unit, which is what
 *              makes a job's requirement derivable from measurements that
 *              already exist instead of a second round of data entry
 *   sets       Christmas rental sets as tracked physical assets
 *
 * Tabs rather than four nav entries: these are one job ("what do we have,
 * what do we owe, what is out") and a top-level entry each would push the
 * other five nav links off a phone. The tab rides in the query string via
 * replaceQuery, so it survives a reload and can be linked, without putting
 * a history entry between the operator and Android Back -- same choice the
 * jobs filters make.
 *
 * WHAT THIS SCREEN DOES NOT DO
 *
 * It does not price anything. ns_materials.unit_cost is a purchasing cost
 * basis; no figure here reaches a quote, and the materials estimate is
 * quantities plus that cost basis, never a customer total.
 *
 * It does not decrement stock when a quote is accepted. Consumption is an
 * explicit act from this screen, because a quote that is never accepted
 * must not draw down the shelf, and a job's parts are rarely exactly what
 * was estimated.
 *
 * It never edits or deletes a stock movement. A mistake is corrected by
 * posting its reverse, which is the only way a disputed shelf count stays
 * explainable. */

const TABS = [
  ['stock',      'Stock'],
  ['purchasing', 'Purchasing'],
  ['mapping',    'Service parts'],
  ['sets',       'Christmas sets'],
  ['kits',       'Kits & pieces'],
  ['load',       'Daily load']
];

const CATEGORIES = ['track', 'light', 'controller', 'power_supply', 'connector',
                    'clip', 'wire', 'rental_set', 'consumable', 'tool', 'other'];
const UNITS = ['each', 'linear_ft', 'box', 'roll', 'kit', 'set'];
const PO_STATUSES = ['draft', 'ordered', 'partial', 'received', 'cancelled'];

/* Which movement reasons an operator may post by hand, and the sign each
   one carries. The database enforces this pairing too (a negative receipt
   or a positive consumption is refused); this table is here so the form
   cannot offer a combination the database would reject. 'received' is
   absent on purpose: a receipt belongs to a purchase order, which posts it
   with the pack conversion applied. */
const MANUAL_REASONS = [
  ['opening',    'Opening count',    +1],
  ['consumed',   'Used on a job',    -1],
  ['damaged',    'Damaged / wasted', -1],
  ['returned',   'Returned to shelf', +1],
  ['adjustment', 'Correction',         0]
];

/* The caption span has to be a DIRECT child of `.field`, because the only
   rule that styles it is `.field > span`. And the hint has to sit OUTSIDE
   the <label>: `.field > span` is more specific than `.hint`, so a nested
   hint span would be painted as a second field caption, and <p> is not
   phrasing content so it cannot live inside a <label> at all. Same shape as
   settings-form.js's settingField, for the same two reasons. */
function labelled(text, control, hint) {
  return el('div', { style: 'margin:0' }, [
    el('label', { class: 'field', style: 'margin:0' }, [
      el('span', { text }),
      control
    ]),
    hint ? el('p', { class: 'hint', style: 'margin:4px 0 0', text: hint }) : null
  ].filter(Boolean));
}

/** A number input that saves on change (blur / commit), not on every
 *  keystroke. numberInput()'s second argument binds `input`, which would
 *  fire a write per digit typed -- three writes to store "180". */
function savingNumber(value, onCommit, attrs = {}) {
  return numberInput(value, null, { ...attrs, onChange: onCommit });
}

/* ------------------------------------------------------------------ stock -- */

function stockTab() {
  const host = el('div', {});

  async function load() {
    reloadHook.current = load;
    const [materials, suppliers, locations, byLocation, reservations] = await Promise.all([
      api.listMaterials({ includeInactive: true }),
      api.listSuppliers({ includeInactive: true }),
      api.listStockLocations(),
      api.listStockByLocation(),
      api.listReservations({ status: 'held' })
    ]);
    // Level-tracked supplies are excluded: "at or below the reorder point"
    // is a quantity statement, and they have no quantity. An Empty one shows
    // on its own row instead.
    const low = materials.filter(
      (m) => m.active && m.needs_reorder && m.tracking_mode !== 'level');

    // material id -> [{ location_code, location_name, on_hand, reserved, ... }]
    const balances = new Map();
    for (const row of byLocation) {
      if (!balances.has(row.material_id)) balances.set(row.material_id, []);
      balances.get(row.material_id).push(row);
    }
    const heldBy = new Map();
    for (const r of reservations) {
      if (!heldBy.has(r.material_id)) heldBy.set(r.material_id, []);
      heldBy.get(r.material_id).push(r);
    }

    fill(host, [
      materials.length === 0 ? emptyCatalogue(suppliers, load) : null,

      low.length
        ? el('div', { class: 'card' }, [
            el('div', { class: 'card__head' }, [
              el('div', {}, [
                el('h2', { text: `${low.length} part${low.length === 1 ? '' : 's'} at or below the reorder point` }),
                el('p', { text: 'Counted from the stock ledger, not a stored total.' })
              ])
            ]),
            el('div', {}, low.map((m) => el('div', { class: 'row-item' }, [
              el('div', { class: 'row-item__main' }, [
                el('strong', { text: m.name }),
                el('span', { class: 'row-item__meta',
                  text: `${quantityWithUnit(qty(m.on_hand), m.unit)} on hand · reorder at ` +
                        `${qty(m.reorder_point)} · ${m.ns_suppliers?.name || 'no supplier'}` })
              ])
            ])))
          ])
        : null,

      materials.length ? catalogueCard(materials, suppliers, locations, balances, heldBy, load) : null,
      materials.length ? newMaterialCard(suppliers, load) : null
    ]);
  }

  load();
  return host;
}

function emptyCatalogue(suppliers, reload) {
  return el('div', { class: 'card' }, [
    el('div', { class: 'card__head' }, [
      el('div', {}, [
        el('h2', { text: 'No parts in the catalogue yet' }),
        el('p', { text: 'Nothing is pre-loaded: the supplier catalogue has never been read by this app, ' +
                        'so every part, pack size and cost here is one somebody has checked.' })
      ])
    ]),
    el('p', { class: 'hint' }, [
      el('span', { text: 'Add parts from the supplier you order from — ' }),
      suppliers[0]?.website
        ? el('a', { href: suppliers[0].website, target: '_blank', rel: 'noopener noreferrer',
                    text: suppliers[0].website })
        : el('span', { text: 'set a supplier website first' }),
      el('span', { text: '. Enter the pack size the supplier sells (a 150 ft roll is 150 linear ft, pack size 150).' })
    ]),
    newMaterialCard(suppliers, reload, { bare: true })
  ]);
}

function catalogueCard(materials, suppliers, locations, balances, heldBy, reload) {
  const host = el('div', { class: 'card' });
  const byCategory = new Map();
  for (const m of materials) {
    if (!byCategory.has(m.category)) byCategory.set(m.category, []);
    byCategory.get(m.category).push(m);
  }

  fill(host, [
    el('div', { class: 'card__head' }, [
      el('div', {}, [
        el('h2', { text: 'Parts catalogue' }),
        el('p', { text: `${materials.length} part${materials.length === 1 ? '' : 's'}. ` +
                        'On hand is the sum of the movement ledger.' })
      ])
    ]),
    ...[...byCategory.entries()].map(([category, rows]) => el('div', { class: 'section-box' }, [
      el('div', { class: 'section-box__head', style: 'flex-wrap:wrap' }, [el('strong', { text: humanise(category) })]),
      ...rows.map((m) => materialRow(
        m, suppliers, locations, balances.get(m.id) || [], heldBy.get(m.id) || [], reload))
    ]))
  ]);
  return host;
}

function materialRow(m, suppliers, locations, balances, held, reload) {
  const host = el('div', { class: 'section-box', style: 'margin:8px 0' });
  let movesOpen = false;
  /* Collapsed by default. Posting a count is the everyday act; moving stock
     between Base and a car is the morning-and-evening one, and leaving both
     forms open put every card past 6000px at 390px wide. */
  let transferOpen = false;
  const isLevel = m.tracking_mode === 'level';

  function paint() {
    fill(host, [
      el('div', { class: 'section-box__head', style: 'flex-wrap:wrap' }, [
        el('div', { style: 'flex:1;min-width:140px' }, [
          el('strong', { text: m.name }),
          el('span', { class: 'row-item__meta',
            text: [m.sku, m.ns_suppliers?.name,
                   isLevel ? 'tracked as Empty / Low / Enough'
                           : `pack of ${qty(m.pack_quantity)}`]
              .filter(Boolean).join(' · ') })
        ]),
        // A level-tracked supply gets no quantity badge. Printing "0 level"
        // is both meaningless and an invitation to plan against it.
        isLevel ? null : el('span', {
          class: `badge ${m.needs_reorder ? 'badge--warn' : 'badge--ok'}`,
          text: quantityWithUnit(qty(m.on_hand), m.unit)
        }),
        m.active ? null : el('span', { class: 'badge badge--muted', text: 'Inactive' }),
        locations.length > 1 && !isLevel
          ? el('button', {
              class: 'btn btn--sm', type: 'button',
              text: transferOpen ? 'Hide move' : 'Move',
              onClick: () => { transferOpen = !transferOpen; paint(); }
            })
          : null,
        isLevel ? null : el('button', {
          class: 'btn btn--sm', type: 'button',
          text: movesOpen ? 'Hide movements' : 'Movements',
          onClick: () => { movesOpen = !movesOpen; paint(); }
        })
      ].filter(Boolean)),

      el('div', { class: 'grid grid--3', style: 'margin-top:8px' }, [
        labelled('Unit cost', savingNumber(m.unit_cost ?? '', async (e) => {
          const raw = e.target.value.trim();
          const next = raw === '' ? null : num(raw, 0);
          await trySave(() => api.updateMaterial(m.id, { unit_cost: next }), {
            revert: () => { e.target.value = m.unit_cost ?? ''; },
            after: () => { m.unit_cost = next; }
          });
        }, { step: '0.01', min: '0', 'aria-label': `${m.name} unit cost` }),
          m.unit_cost == null ? 'Blank means unknown, not free.'
            : `${money(m.unit_cost)} per ${materialUnitLabel(m.unit) || 'unit'}`),

        isLevel ? null : labelled('Reorder at', savingNumber(m.reorder_point, async (e) => {
          const next = num(e.target.value, 0);
          await trySave(() => api.updateMaterial(m.id, { reorder_point: next }), {
            revert: () => { e.target.value = m.reorder_point; },
            after: reload
          });
        }, { step: '1', min: '0', 'aria-label': `${m.name} reorder point` })),

        isLevel ? null : labelled('Pack size', savingNumber(m.pack_quantity, async (e) => {
          const next = num(e.target.value, 1);
          if (!(next > 0)) { e.target.value = m.pack_quantity; toast('A pack size must be more than zero.', 'error'); return; }
          await trySave(() => api.updateMaterial(m.id, { pack_quantity: next }), {
            revert: () => { e.target.value = m.pack_quantity; },
            after: reload
          });
        }, { step: '1', min: '1', 'aria-label': `${m.name} pack size` }),
          `How many ${materialUnitLabel(m.unit)} the supplier sells in one pack.`)
      ].filter(Boolean)),

      locationBalances(m, balances),
      m.tracking_mode === 'level' ? null : commitmentsPanel(m, locations, balances, held, reload),
      m.tracking_mode === 'level' ? null : movementForm(m, locations, reload),
      m.tracking_mode === 'level' ? null
        : transferOpen ? transferForm(m, locations, balances, reload) : null,

      el('div', { class: 'btn-row', style: 'margin-top:8px' }, [
        el('button', {
          class: 'btn btn--sm', type: 'button',
          text: m.active ? 'Mark inactive' : 'Mark active',
          onClick: async () => {
            await trySave(() => api.updateMaterial(m.id, { active: !m.active }), {
              success: m.active ? 'Part marked inactive' : 'Part marked active',
              after: reload
            });
          }
        })
      ]),

      movesOpen && !isLevel ? movementList(m) : null
    ]);
  }

  paint();
  return host;
}

/* Where the stock actually is. A single total answers "do we own any" and
   never answers "is it in the car", which is the question asked every
   morning. */
/* Where the stock is, and how much of it may actually be promised.
   ON HAND answers "what is physically there"; AVAILABLE answers "what can
   we commit to a job", which is the one a plan needs and the one a single
   figure silently gets wrong. Reserved and damaged are shown only when
   non-zero, so an ordinary part stays a single short line. */
function locationBalances(material, balances) {
  if (!balances.length) return null;
  if (material.tracking_mode === 'level') return levelLine(material, balances);

  const anyEstimated = balances.some((b) => b.is_estimated);
  const parts = balances.map((b) => {
    const bits = [`${b.location_name}: ${quantityWithUnit(qty(b.available), material.unit)} free`];
    if (Number(b.reserved) > 0) bits.push(`${qty(b.reserved)} reserved`);
    if (Number(b.on_hand) !== Number(b.available)) bits.push(`${qty(b.on_hand)} on hand`);
    if (Number(b.damaged_on_hand) > 0) bits.push(`${qty(b.damaged_on_hand)} damaged`);
    return bits.join(', ');
  });

  return el('div', { style: 'margin:8px 0 0' }, [
    el('p', { class: 'hint', style: 'margin:0', text: parts.join('  ·  ') }),
    anyEstimated
      ? el('p', { class: 'hint', style: 'margin:2px 0 0', text: precisionNote(true) })
      : null
  ].filter(Boolean));
}

/* Empty / Low / Enough. No number anywhere: the whole point of tracking a
   supply this way is that counting it is not worth the time, and showing a
   quantity next to it would invite somebody to plan against one. */
function levelLine(material, balances) {
  return el('div', { style: 'margin:8px 0 0' },
    balances.map((b) => el('div', { class: 'btn-row', style: 'margin:4px 0' }, [
      el('span', { class: 'row-item__meta', style: 'min-width:70px', text: b.location_name }),
      el('span', { class: levelBadgeClass(b.level_state), text: levelLabel(b.level_state) }),
      ...LEVEL_STATES.map((state) => el('button', {
        class: 'btn btn--sm', type: 'button', text: levelLabel(state),
        disabled: b.level_state === state,
        onClick: async () => {
          await trySave(() => api.setMaterialLevel({
            materialId: material.id, locationId: b.location_id, state
          }), { success: `${material.name}: ${levelLabel(state)}`, after: reloadHook.current });
        }
      }))
    ])));
}

/* The level buttons are built deep inside a render and need the tab's
   reload. Threading it through four call sites for one control is worse
   than one holder set once per paint. */
const reloadHook = { current: () => {} };

function locationSelect(locations, value, onChange, label) {
  return select(
    locations.map((l) => ({ value: l.code, label: l.name })),
    value, onChange, { 'aria-label': label });
}

/* Commitments: what is promised and to whom, plus the one control that
   makes a promise. A reservation is the difference between owning stock and
   being able to offer it, so this sits directly under the balances it
   explains rather than on a screen of its own. */
function commitmentsPanel(material, locations, balances, held, reload) {
  const amount = numberInput('', null, {
    step: '1', min: '0', 'aria-label': `Quantity to commit of ${material.name}`
  });
  let where = locations[0]?.code || 'base';

  const freeAt = (code) => Number(
    balances.find((b) => b.location_code === code)?.available ?? 0);

  const freeHint = el('p', { class: 'hint', style: 'margin:4px 0 0' });
  function describeFree() {
    freeHint.textContent =
      `${quantityWithUnit(qty(freeAt(where)), material.unit)} free at ${
        locations.find((l) => l.code === where)?.name || where}.`;
  }
  describeFree();

  return el('div', { style: 'margin-top:10px' }, [
    el('h4', { style: 'margin:0 0 6px;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)',
      text: 'Committed to work' }),

    held.length === 0
      ? el('p', { class: 'hint', style: 'margin:0',
          text: 'Nothing committed, so everything on hand can be promised.' })
      : el('div', {}, held.map((r) => el('div', { class: 'row-item' }, [
          el('div', { class: 'row-item__main' }, [
            el('strong', { text: quantityWithUnit(qty(r.quantity), material.unit) }),
            el('span', { class: 'row-item__meta',
              text: [r.ns_stock_locations?.name, r.job_id ? 'for a job' : 'no job named',
                     dateTime(r.held_at)].filter(Boolean).join(' · ') })
          ]),
          el('button', {
            class: 'btn btn--sm', type: 'button', text: 'Release',
            onClick: async () => {
              if (!confirmAction(
                `Release ${quantityWithUnit(qty(r.quantity), material.unit)}? ` +
                'It goes back to available immediately.')) return;
              await trySave(() => api.releaseStockReservation({
                clientOperationId: api.newOperationId('rel'),
                reservationId: r.id
              }), { success: 'Released', after: reload });
            }
          })
        ]))),

    el('div', { class: 'grid grid--2', style: 'margin-top:8px' }, [
      labelled('Commit at', locationSelect(locations, where, (e) => {
        where = e.target.value; describeFree();
      }, `Commit location for ${material.name}`)),
      labelled(`Quantity to commit (${materialUnitLabel(material.unit)})`, amount)
    ]),
    freeHint,
    el('p', { class: 'hint', style: 'margin:2px 0 0',
      text: 'Committing does not move anything. It reserves stock so the other ' +
            'car cannot promise the same thing.' }),
    el('div', { class: 'btn-row', style: 'margin-top:8px' }, [
      el('button', {
        class: 'btn btn--sm', type: 'button', text: 'Commit',
        onClick: async () => {
          const n = num(amount.value, 0);
          if (!(n > 0)) { toast('Enter how much to commit.', 'error'); return; }
          if (n > freeAt(where)) {
            toast(`Only ${quantityWithUnit(qty(freeAt(where)), material.unit)} free there.`, 'error');
            return;
          }
          const ok = await trySave(() => api.reserveStock({
            clientOperationId: api.newOperationId('res'),
            materialId: material.id,
            locationCode: where,
            quantity: n
          }), { success: 'Committed' });
          if (ok) { amount.value = ''; await reload(); }
        }
      })
    ])
  ]);
}

function movementForm(material, locations, reload) {
  let reason = MANUAL_REASONS[0][0];
  let location = locations[0]?.code || 'base';
  let condition = 'usable';
  let precision = 'exact';
  // No placeholder: a unit word sitting in an empty NUMBER box reads as if
  // it were the value. The caption already carries the unit.
  const amount = numberInput('', null, {
    step: '1', min: '0', 'aria-label': `Quantity for ${material.name}`
  });
  const noteInput = el('input', { placeholder: 'Note (optional)', 'aria-label': 'Movement note' });
  const signHint = el('p', { class: 'hint', style: 'margin:4px 0 0' });

  function describeSign() {
    const sign = MANUAL_REASONS.find(([k]) => k === reason)?.[2] ?? 0;
    signHint.textContent = sign > 0
      ? 'Adds to the shelf.'
      : sign < 0
        ? 'Takes off the shelf.'
        : 'A correction may go either way — enter a negative number to take stock off.';
  }
  describeSign();

  return el('div', { style: 'margin-top:10px' }, [
    el('div', { class: 'grid grid--2' }, [
      labelled('Movement', select(
        MANUAL_REASONS.map(([value, label]) => ({ value, label })), reason,
        (e) => { reason = e.target.value; describeSign(); })),
      labelled('Where', locationSelect(locations, location,
        (e) => { location = e.target.value; }, `Location for ${material.name}`))
    ]),
    el('div', { class: 'grid grid--2', style: 'margin-top:8px' }, [
      labelled(`Quantity (${materialUnitLabel(material.unit)})`, amount),
      labelled('Note', noteInput)
    ]),
    el('div', { class: 'grid grid--2', style: 'margin-top:8px' }, [
      labelled('Condition', select(
        MOVEMENT_CONDITIONS.map(([value, label]) => ({ value, label })), condition,
        (e) => { condition = e.target.value; }, { 'aria-label': `Condition for ${material.name}` }),
        'Damaged stock stays recorded but is never offered to a job.'),
      labelled('Count', select(
        COUNT_PRECISIONS.map(([value, label]) => ({ value, label })), precision,
        (e) => { precision = e.target.value; }, { 'aria-label': `Count precision for ${material.name}` }),
        'An estimate flags every balance it touches.')
    ]),
    signHint,
    el('div', { class: 'btn-row', style: 'margin-top:8px' }, [
      el('button', {
        class: 'btn btn--sm btn--primary', type: 'button', text: 'Post movement',
        onClick: async () => {
          const entered = num(amount.value, NaN);
          if (!Number.isFinite(entered) || entered === 0) {
            toast('Enter a quantity other than zero.', 'error');
            return;
          }
          // The SERVER derives the sign from the reason; signedDelta is
          // kept here only to show the operator, before they commit, which
          // way the number is about to go. A correction keeps the typed
          // sign at both ends, because a negative correction has to be
          // enterable at all.
          const sign = MANUAL_REASONS.find(([k]) => k === reason)?.[2] ?? 0;
          const preview = signedDelta(sign, entered);
          if (preview === 0) { toast('Enter a quantity other than zero.', 'error'); return; }

          // One replay key per attempt, generated BEFORE the request and
          // reused if this handler retries: the server never saw a failed
          // first attempt, so only the caller can say "this is that same
          // act". A fresh key per click is correct -- two deliberate clicks
          // are two movements.
          const clientOperationId = api.newOperationId('mv');

          const ok = await trySave(() => api.postStockMovement({
            clientOperationId,
            materialId: material.id,
            locationCode: location,
            quantity: reason === 'adjustment' ? preview : Math.abs(entered),
            reason,
            condition,
            countPrecision: precision,
            note: noteInput.value.trim() || null
          }), { success: 'Movement posted' });
          if (ok) { amount.value = ''; noteInput.value = ''; await reload(); }
        }
      })
    ])
  ]);
}

/* Load the car in the morning, bring it back at night. Two locations, one
   quantity, and a confirmation the goods actually moved -- the database
   refuses the transfer without it, so this is not a courtesy checkbox.

   The quantity is capped at what the SOURCE holds rather than at the total:
   you cannot carry out of a car what is not in it, and the server refuses
   it anyway. Showing the source balance next to the field is what stops the
   operator discovering that at the end instead of the start. */
function transferForm(material, locations, balances, reload) {
  if (locations.length < 2) return null;

  const held = (code) => Number(
    balances.find((b) => b.location_code === code)?.on_hand ?? 0);

  let from = locations[0].code;
  let to = locations.find((l) => l.code !== from)?.code;
  let confirmed = false;

  const amount = numberInput('', null, {
    step: '1', min: '0', 'aria-label': `Quantity to transfer of ${material.name}`
  });
  const available = el('p', { class: 'hint', style: 'margin:4px 0 0' });
  const confirmBox = el('input', {
    type: 'checkbox', style: 'width:auto;min-height:0;margin-right:8px',
    'aria-label': 'Confirm the goods physically moved',
    onChange: (e) => { confirmed = e.target.checked; }
  });

  function describeAvailable() {
    available.textContent =
      `${qty(held(from))} ${unitLabel(material.unit)} at ${
        locations.find((l) => l.code === from)?.name || from}.`;
  }
  describeAvailable();

  return el('div', { style: 'margin-top:12px' }, [
    el('h4', { style: 'margin:0 0 6px;font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)',
      text: 'Move between locations' }),
    el('div', { class: 'grid grid--3' }, [
      labelled('From', locationSelect(locations, from, (e) => {
        from = e.target.value;
        if (to === from) to = locations.find((l) => l.code !== from)?.code;
        describeAvailable();
      }, `Transfer source for ${material.name}`)),
      labelled('To', locationSelect(locations, to, (e) => { to = e.target.value; },
        `Transfer destination for ${material.name}`)),
      // NOT "Quantity": the movement form above already has one, and two
      // identically-labelled fields in one card are ambiguous to a screen
      // reader and to anyone scanning it.
      labelled(`Quantity to move (${unitLabel(material.unit)})`, amount)
    ]),
    available,
    el('label', { class: 'check', style: 'display:flex;align-items:center;margin-top:8px' }, [
      confirmBox,
      el('span', { text: 'The goods physically moved' })
    ]),
    el('p', { class: 'hint', style: 'margin:4px 0 0',
      text: 'Stock does not move until this is ticked — the balance has to match the car.' }),
    el('div', { class: 'btn-row', style: 'margin-top:8px' }, [
      el('button', {
        class: 'btn btn--sm btn--primary', type: 'button', text: 'Transfer',
        onClick: async () => {
          const n = num(amount.value, 0);
          if (!(n > 0)) { toast('Enter how much is moving.', 'error'); return; }
          if (from === to) { toast('Pick two different locations.', 'error'); return; }
          if (!confirmed) {
            toast('Tick the confirmation once the goods have actually moved.', 'error');
            return;
          }
          if (n > held(from)) {
            toast(`Only ${qty(held(from))} ${unitLabel(material.unit)} there. ` +
                  'Count it and post a correction if the shelf disagrees.', 'error');
            return;
          }

          const ok = await trySave(() => api.postStockTransfer({
            clientOperationId: api.newOperationId('xf'),
            materialId: material.id,
            quantity: n,
            fromLocationCode: from,
            toLocationCode: to,
            confirmedPhysical: true
          }), { success: 'Stock moved' });

          if (ok) {
            amount.value = '';
            confirmBox.checked = false;
            confirmed = false;
            await reload();
          }
        }
      })
    ])
  ]);
}

function movementList(material) {
  const host = el('div', { style: 'margin-top:10px' },
    [el('p', { class: 'hint', text: 'Loading movements…' })]);

  api.listStockMoves(material.id).then((moves) => {
    fill(host, [
      el('h3', { style: 'margin:0 0 6px;font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)',
        text: 'Movement ledger' }),
      moves.length === 0
        ? el('p', { class: 'hint', text: 'No movements yet, so this part reads as zero on hand.' })
        : el('div', {}, moves.map((mv) => el('div', { class: 'row-item' }, [
            el('div', { class: 'row-item__main' }, [
              el('strong', {
                text: `${Number(mv.delta) > 0 ? '+' : ''}${qty(mv.delta)} ${unitLabel(material.unit)}`
              }),
              el('span', { class: 'row-item__meta',
                text: [humanise(mv.reason), dateTime(mv.occurred_at), mv.note].filter(Boolean).join(' · ') })
            ])
          ]))),
      el('p', { class: 'hint', style: 'margin-top:8px',
        text: 'Movements are never edited or deleted. Correct a mistake by posting a correction for the opposite amount.' })
    ]);
  }).catch((err) => {
    fill(host, [el('p', { class: 'error-text', text: err.message })]);
  });

  return host;
}

function newMaterialCard(suppliers, reload, { bare = false } = {}) {
  const name = el('input', { placeholder: 'e.g. 150 ft channel', 'aria-label': 'Part name' });
  const sku = el('input', { placeholder: 'Supplier code (optional)', 'aria-label': 'SKU' });
  const packQty = numberInput(1, null, { step: '1', min: '1', 'aria-label': 'Pack size' });
  const cost = numberInput('', null, { step: '0.01', min: '0', 'aria-label': 'Unit cost' });
  const reorder = numberInput(0, null, { step: '1', min: '0', 'aria-label': 'Reorder point' });
  let category = 'track';
  let unit = 'linear_ft';
  let supplierId = suppliers[0]?.id || '';

  const form = el('div', {}, [
    el('div', { class: 'grid grid--2' }, [
      labelled('Part name', name),
      labelled('Supplier code', sku, 'Unique per supplier. Leave blank if the supplier has none.')
    ]),
    el('div', { class: 'grid grid--3', style: 'margin-top:8px' }, [
      labelled('Category', select(
        CATEGORIES.map((c) => ({ value: c, label: humanise(c) })), category,
        (e) => { category = e.target.value; })),
      labelled('Counted in', select(
        UNITS.map((u) => ({ value: u, label: unitLabel(u) })), unit,
        (e) => { unit = e.target.value; })),
      labelled('Supplier', select(
        [{ value: '', label: 'No supplier' },
         ...suppliers.map((s) => ({ value: s.id, label: s.name }))],
        supplierId, (e) => { supplierId = e.target.value; }))
    ]),
    el('div', { class: 'grid grid--3', style: 'margin-top:8px' }, [
      labelled('Pack size', packQty, 'How many of the unit above come in one pack.'),
      labelled('Unit cost', cost, 'Leave blank if unknown — blank is not zero.'),
      labelled('Reorder at', reorder)
    ]),
    el('div', { class: 'btn-row', style: 'margin-top:10px' }, [
      el('button', {
        class: 'btn btn--primary', type: 'button', text: 'Add part',
        onClick: async () => {
          if (!name.value.trim()) { toast('A part needs a name.', 'error'); return; }
          const pack = num(packQty.value, 1);
          if (!(pack > 0)) { toast('A pack size must be more than zero.', 'error'); return; }

          const ok = await trySave(() => api.createMaterial({
            name: name.value.trim(),
            sku: sku.value.trim() || null,
            category, unit,
            supplier_id: supplierId || null,
            pack_quantity: pack,
            unit_cost: cost.value.trim() === '' ? null : num(cost.value, 0),
            reorder_point: num(reorder.value, 0)
          }), { success: 'Part added' });

          if (ok) {
            name.value = ''; sku.value = ''; cost.value = '';
            packQty.value = 1; reorder.value = 0;
            await reload();
          }
        }
      })
    ])
  ]);

  if (bare) return form;

  return el('div', { class: 'card' }, [
    el('div', { class: 'card__head' }, [
      el('div', {}, [
        el('h2', { text: 'Add a part' }),
        el('p', { text: 'Entered by hand from the supplier’s own listing.' })
      ])
    ]),
    form
  ]);
}

/* ------------------------------------------------------------- purchasing -- */

function purchasingTab() {
  const host = el('div', {});

  async function load() {
    const [orders, suppliers, materials] = await Promise.all([
      api.listPurchaseOrders(), api.listSuppliers(), api.listMaterials()
    ]);

    fill(host, [
      newOrderCard(suppliers, load),
      orders.length === 0
        ? el('div', { class: 'card' }, [
            el('h2', { text: 'No purchase orders yet' }),
            el('p', { class: 'hint',
              text: 'Orders are counted in packs, because that is what the supplier sells. ' +
                    'Receiving converts packs to shelf units once, using the part’s pack size.' })
          ])
        : el('div', {}, orders.map((po) => orderCard(po, materials, load)))
    ]);
  }

  load();
  return host;
}

function newOrderCard(suppliers, reload) {
  const reference = el('input', { placeholder: 'Supplier order number (optional)', 'aria-label': 'Reference' });
  let supplierId = suppliers[0]?.id || '';

  return el('div', { class: 'card' }, [
    el('div', { class: 'card__head' }, [
      el('div', {}, [
        el('h2', { text: 'Start a purchase order' }),
        el('p', { text: 'A draft needs no dates. It becomes an order when you mark it ordered.' })
      ])
    ]),
    suppliers.length === 0
      ? el('p', { class: 'warn', text: 'Add a supplier before raising an order.' })
      : el('div', {}, [
          el('div', { class: 'grid grid--2' }, [
            labelled('Supplier', select(
              suppliers.map((s) => ({ value: s.id, label: s.name })), supplierId,
              (e) => { supplierId = e.target.value; })),
            labelled('Reference', reference)
          ]),
          el('div', { class: 'btn-row', style: 'margin-top:10px' }, [
            el('button', {
              class: 'btn btn--primary', type: 'button', text: 'Create draft order',
              onClick: async () => {
                const ok = await trySave(() => api.createPurchaseOrder({
                  supplier_id: supplierId || suppliers[0].id,
                  reference: reference.value.trim() || null
                }), { success: 'Draft order created' });
                if (ok) { reference.value = ''; await reload(); }
              }
            })
          ])
        ])
  ]);
}

function orderCard(po, materials, reload) {
  const lines = (po.ns_purchase_order_lines || [])
    .slice().sort((a, b) => (a.sort_order - b.sort_order) || 0);

  const outstanding = lines.filter(
    (l) => Number(l.packs_received || 0) < Number(l.packs_ordered));

  const estimated = lines.reduce((sum, l) => {
    const unitCost = l.unit_cost ?? l.ns_materials?.unit_cost;
    if (unitCost == null) return sum;
    return sum + Number(l.packs_ordered) *
      Number(l.ns_materials?.pack_quantity || 1) * Number(unitCost);
  }, 0);

  const anyUnknownCost = lines.some(
    (l) => (l.unit_cost ?? l.ns_materials?.unit_cost) == null);

  return el('div', { class: 'card' }, [
    el('div', { class: 'card__head' }, [
      el('div', {}, [
        el('h2', { text: `${po.ns_suppliers?.name || 'Supplier'}${po.reference ? ` · ${po.reference}` : ''}` }),
        el('p', { text: [humanise(po.status),
                         po.ordered_at ? `ordered ${date(po.ordered_at)}` : 'not ordered yet',
                         `${lines.length} line${lines.length === 1 ? '' : 's'}`]
          .filter(Boolean).join(' · ') })
      ]),
      el('span', {
        class: `badge ${po.status === 'received' ? 'badge--ok'
          : po.status === 'cancelled' ? 'badge--muted' : 'badge--warn'}`,
        text: humanise(po.status)
      })
    ]),

    lines.length === 0
      ? el('p', { class: 'hint', text: 'No lines on this order yet.' })
      : el('div', {}, lines.map((line) => orderLineRow(line, po, reload))),

    estimated > 0
      ? el('p', { class: 'hint', style: 'margin-top:8px' }, [
          el('span', { text: `Estimated order value ${money(estimated)}` }),
          anyUnknownCost
            ? el('span', { text: ' — excludes lines with no cost recorded, so the real total is higher.' })
            : null
        ].filter(Boolean))
      : null,

    addOrderLineForm(po, materials, reload),

    el('div', { class: 'btn-row', style: 'margin-top:10px' }, [
      ...PO_STATUSES
        .filter((s) => s !== po.status && s !== 'partial')
        .map((s) => el('button', {
          class: 'btn btn--sm', type: 'button', text: `Mark ${humanise(s).toLowerCase()}`,
          onClick: async () => {
            if (s === 'cancelled' && !confirmAction(
              'Cancel this order? Stock already received against it stays on the shelf.')) return;
            const patch = { status: s };
            // The CHECK constraint requires ordered_at once the status
            // leaves draft/cancelled, so supply it here rather than letting
            // the database reject the click.
            if (s !== 'draft' && s !== 'cancelled' && !po.ordered_at) {
              patch.ordered_at = new Date().toISOString();
            }
            if (s === 'received' && !po.received_at) patch.received_at = new Date().toISOString();
            await trySave(() => api.updatePurchaseOrder(po.id, patch), {
              success: `Order marked ${humanise(s).toLowerCase()}`, after: reload
            });
          }
        })),
      outstanding.length === 0 && lines.length > 0 && po.status !== 'received'
        ? el('span', { class: 'hint', style: 'margin:0 0 0 8px',
            text: 'Everything on this order has been received.' })
        : null
    ].filter(Boolean))
  ].filter(Boolean));
}

function orderLineRow(line, po, reload) {
  const material = line.ns_materials || {};
  const packQty = Number(material.pack_quantity || 1);
  const ordered = Number(line.packs_ordered);
  const received = Number(line.packs_received || 0);
  const remaining = Math.max(ordered - received, 0);

  const receiveInput = numberInput(remaining || '', null, {
    step: '1', min: '0', 'aria-label': `Packs to receive for ${material.name || 'part'}`
  });

  return el('div', { class: 'section-box', style: 'margin:8px 0' }, [
    el('div', { class: 'section-box__head', style: 'flex-wrap:wrap' }, [
      el('div', { style: 'flex:1;min-width:140px' }, [
        el('strong', { text: material.name || 'Unknown part' }),
        el('span', { class: 'row-item__meta',
          text: `${qty(ordered)} pack(s) of ${qty(packQty)} ${unitLabel(material.unit)} · ` +
                `${qty(received)} received` })
      ]),
      remaining === 0
        ? el('span', { class: 'badge badge--ok', text: 'Received' })
        : el('span', { class: 'badge badge--warn', text: `${qty(remaining)} outstanding` })
    ]),

    remaining > 0
      ? el('div', { class: 'grid grid--2', style: 'margin-top:8px' }, [
          labelled('Packs arriving', receiveInput,
            `${qty(packQty)} ${unitLabel(material.unit)} per pack.`),
          el('div', { class: 'btn-row', style: 'align-items:flex-end' }, [
            el('button', {
              class: 'btn btn--sm btn--primary', type: 'button', text: 'Receive',
              onClick: async () => {
                const packs = num(receiveInput.value, 0);
                if (!(packs > 0)) { toast('Enter how many packs arrived.', 'error'); return; }
                if (packs > remaining && !confirmAction(
                  `That is more than the ${qty(remaining)} pack(s) still outstanding. Receive anyway?`)) return;
                await trySave(() => api.receivePurchaseOrderLine(line, packs), {
                  success: `Received ${qty(packsToUnits(material, packs))} ${unitLabel(material.unit)}`,
                  after: reload
                });
              }
            })
          ])
        ])
      : null,

    po.status === 'draft'
      ? el('div', { class: 'btn-row', style: 'margin-top:8px' }, [
          el('button', {
            class: 'btn btn--sm btn--danger', type: 'button', text: 'Remove line',
            onClick: async () => {
              if (!confirmAction('Remove this line from the draft order?')) return;
              await trySave(() => api.deletePurchaseOrderLine(line.id), { after: reload });
            }
          })
        ])
      : null
  ].filter(Boolean));
}

function addOrderLineForm(po, materials, reload) {
  const alreadyOn = new Set((po.ns_purchase_order_lines || []).map((l) => l.material_id));
  const available = materials.filter((m) => !alreadyOn.has(m.id));
  const packs = numberInput(1, null, { step: '1', min: '1', 'aria-label': 'Packs to order' });
  let materialId = available[0]?.id || '';

  if (available.length === 0) {
    return el('p', { class: 'hint', style: 'margin-top:8px',
      text: materials.length === 0
        ? 'Add parts to the catalogue before putting lines on an order.'
        : 'Every active part is already on this order.' });
  }

  return el('div', { style: 'margin-top:10px' }, [
    el('div', { class: 'grid grid--2' }, [
      labelled('Part', select(
        available.map((m) => ({
          value: m.id,
          label: `${m.name} (pack of ${qty(m.pack_quantity)} ${unitLabel(m.unit)})`
        })), materialId, (e) => { materialId = e.target.value; })),
      labelled('Packs', packs)
    ]),
    el('div', { class: 'btn-row', style: 'margin-top:8px' }, [
      el('button', {
        class: 'btn btn--sm', type: 'button', text: '+ Add line',
        onClick: async () => {
          const n = num(packs.value, 0);
          if (!(n > 0)) { toast('Order at least one pack.', 'error'); return; }
          await trySave(() => api.addPurchaseOrderLine(po.id, {
            material_id: materialId || available[0].id,
            packs_ordered: n,
            sort_order: (po.ns_purchase_order_lines || []).length + 1
          }), { success: 'Line added', after: reload });
        }
      })
    ])
  ]);
}

/* ---------------------------------------------------------------- mapping -- */

function mappingTab() {
  const host = el('div', {});

  async function load() {
    const [usage, services, materials] = await Promise.all([
      api.listServiceMaterialUsage(),
      api.listServices(),
      api.listMaterials()
    ]);

    const byService = new Map();
    for (const u of usage) {
      const key = u.service_id;
      if (!byService.has(key)) byService.set(key, []);
      byService.get(key).push(u);
    }

    const unmapped = services.filter((s) => s.quotable && !byService.has(s.id));

    fill(host, [
      el('div', { class: 'card' }, [
        el('div', { class: 'card__head' }, [
          el('div', {}, [
            el('h2', { text: 'What each service consumes' }),
            el('p', { text: 'One row per service and part: how much of that part one measured unit uses, ' +
                            'plus a waste allowance. A job’s requirement is worked out from this and the ' +
                            'measurements the field already captured.' })
          ])
        ]),
        materials.length === 0
          ? el('p', { class: 'warn', text: 'Add parts to the catalogue first — there is nothing to map to yet.' })
          : null,
        ...services
          .filter((s) => byService.has(s.id))
          .map((s) => el('div', { class: 'section-box' }, [
            el('div', { class: 'section-box__head', style: 'flex-wrap:wrap' }, [
              el('strong', { text: s.name }),
              el('span', { class: 'row-item__meta', text: `measured in ${unitLabel(s.unit)}` })
            ]),
            ...byService.get(s.id).map((u) => usageRow(u, s, load))
          ]))
      ].filter(Boolean)),

      materials.length ? addUsageCard(services, materials, load) : null,

      unmapped.length
        ? el('div', { class: 'card' }, [
            el('div', { class: 'card__head' }, [
              el('div', {}, [
                el('h2', { text: `${unmapped.length} quotable service${unmapped.length === 1 ? '' : 's'} consume nothing yet` }),
                el('p', { text: 'A job measuring one of these reports it as unmapped rather than as needing no parts.' })
              ])
            ]),
            el('p', { class: 'hint', text: unmapped.map((s) => s.name).join(', ') })
          ])
        : null
    ]);
  }

  load();
  return host;
}

function usageRow(u, service, reload) {
  const material = u.ns_materials || {};
  const perUnit = savingNumber(u.quantity_per_unit, async (e) => {
    const next = num(e.target.value, 0);
    if (!(next > 0)) { e.target.value = u.quantity_per_unit; toast('Use more than zero per unit.', 'error'); return; }
    await trySave(() => api.updateServiceMaterialUsage(u.id, { quantity_per_unit: next }), {
      revert: () => { e.target.value = u.quantity_per_unit; }, after: reload
    });
  }, { step: '0.01', min: '0', 'aria-label': `${material.name} per ${unitLabel(service.unit)}` });

  const wastePct = savingNumber(Math.round(Number(u.waste_factor) * 100), async (e) => {
    const pct = num(e.target.value, 0);
    if (pct < 0 || pct > 100) {
      e.target.value = Math.round(Number(u.waste_factor) * 100);
      toast('A waste allowance is between 0 and 100 per cent.', 'error');
      return;
    }
    await trySave(() => api.updateServiceMaterialUsage(u.id, { waste_factor: pct / 100 }), {
      revert: () => { e.target.value = Math.round(Number(u.waste_factor) * 100); }, after: reload
    });
  }, { step: '1', min: '0', max: '100', 'aria-label': `${material.name} waste allowance` });

  return el('div', { style: 'margin:8px 0' }, [
    el('div', { class: 'grid grid--3' }, [
      labelled('Part', el('p', { style: 'margin:0;padding-top:6px;font-weight:600',
        text: `${material.name || 'Unknown'} (${unitLabel(material.unit)})` })),
      labelled(`${unitLabel(material.unit)} per ${unitLabel(service.unit)}`, perUnit),
      labelled('Waste %', wastePct, 'Capped at 100%.')
    ]),
    el('div', { class: 'btn-row', style: 'margin-top:6px' }, [
      el('button', {
        class: 'btn btn--sm btn--danger', type: 'button', text: 'Remove mapping',
        onClick: async () => {
          if (!confirmAction(`Stop counting ${material.name} against ${service.name}?`)) return;
          await trySave(() => api.deleteServiceMaterialUsage(u.id), {
            success: 'Mapping removed', after: reload
          });
        }
      })
    ])
  ]);
}

function addUsageCard(services, materials, reload) {
  const perUnit = numberInput(1, null, { step: '0.01', min: '0', 'aria-label': 'Quantity per unit' });
  const wastePct = numberInput(0, null, { step: '1', min: '0', max: '100', 'aria-label': 'Waste percentage' });
  let serviceId = services[0]?.id || '';
  let materialId = materials[0]?.id || '';

  return el('div', { class: 'card' }, [
    el('div', { class: 'card__head' }, [
      el('div', {}, [el('h2', { text: 'Map a part to a service' })])
    ]),
    el('div', { class: 'grid grid--2' }, [
      labelled('Service', select(
        services.map((s) => ({ value: s.id, label: `${s.name} (${unitLabel(s.unit)})` })),
        serviceId, (e) => { serviceId = e.target.value; })),
      labelled('Part', select(
        materials.map((m) => ({ value: m.id, label: `${m.name} (${unitLabel(m.unit)})` })),
        materialId, (e) => { materialId = e.target.value; }))
    ]),
    el('div', { class: 'grid grid--2', style: 'margin-top:8px' }, [
      labelled('Quantity per measured unit', perUnit),
      labelled('Waste %', wastePct)
    ]),
    el('div', { class: 'btn-row', style: 'margin-top:10px' }, [
      el('button', {
        class: 'btn btn--primary', type: 'button', text: 'Add mapping',
        onClick: async () => {
          const q = num(perUnit.value, 0);
          if (!(q > 0)) { toast('Use more than zero per unit.', 'error'); return; }
          const pct = num(wastePct.value, 0);
          if (pct < 0 || pct > 100) { toast('A waste allowance is between 0 and 100 per cent.', 'error'); return; }
          await trySave(() => api.setServiceMaterialUsage({
            service_id: serviceId || services[0].id,
            material_id: materialId || materials[0].id,
            quantity_per_unit: q,
            waste_factor: pct / 100
          }), { success: 'Mapping added', after: reload });
        }
      })
    ])
  ]);
}

/* ------------------------------------------- company-owned Christmas sets -- */

/* The 8.1 version of this tab is gone, not adapted. It read a status field
   that mixed "where is the set" with "who has it" and wrote the set and its
   event log as two statements from the browser; Batch 9.1 split those into
   a set plus an assignment and moved every write behind an RPC, so there was
   nothing left of the old screen that was still true. The panel lives in its
   own module because this file is already long and the seasonal lifecycle is
   a screen in its own right, not a variation on a stock list. */

function setsTab() {
  // No onChanged hook: building or stripping a set does post a real stock
  // movement, and the Stock tab is rebuilt from scratch every time it is
  // selected, so it cannot show a balance from before the build.
  return seasonalSetsPanel();
}


/* ------------------------------------------------------------------ view -- */

export async function renderInventory(ctx) {
  const { mount, params, replaceQuery } = ctx;
  const requested = params?.get('tab');
  let tab = TABS.some(([key]) => key === requested) ? requested : 'stock';

  const body = el('div', {});

  function paintTabs() {
    return el('div', { class: 'btn-row', style: 'margin:0 0 14px;flex-wrap:wrap' },
      TABS.map(([key, label]) => el('button', {
        class: `btn btn--sm${key === tab ? ' btn--primary' : ''}`,
        type: 'button',
        text: label,
        'aria-pressed': key === tab ? 'true' : 'false',
        onClick: () => {
          if (key === tab) return;
          tab = key;
          // replaceQuery, not a hash assignment: switching tab must not put
          // an entry between the operator and Android Back.
          replaceQuery?.(`tab=${key}`);
          render();
        }
      })));
  }

  function render() {
    fill(mount, [
      el('div', { class: 'page-head' }, [
        el('div', {}, [
          el('h1', { text: 'Inventory' }),
          el('p', { class: 'hint',
            text: 'Parts, purchasing, permanent-lighting kits and the '
              + 'company-owned Christmas sets. Nothing here affects quote pricing.' })
        ])
      ]),
      paintTabs(),
      body
    ]);

    fill(body, [
      tab === 'stock'      ? stockTab()
      : tab === 'purchasing' ? purchasingTab()
      : tab === 'mapping'    ? mappingTab()
      : tab === 'kits'       ? kitsAndPiecesPanel()
      : tab === 'load'       ? loadPlanPanel()
      : setsTab()
    ]);
  }

  render();
}
