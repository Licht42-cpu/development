import * as api from '../lib/api.js';
import { el, select, numberInput, confirmAction } from '../../../shared/dom.js';
import { fill } from '../lib/admin-dom.js';
import { trySave, describeWriteError } from '../lib/save.js';
import { humanise, date } from '../../../shared/format.js';

/* Sealed kits and the pieces left over from cutting.
 *
 * TWO IDEAS, AND THE MISTAKE EACH ONE PREVENTS.
 *
 * A KIT SHEET is what is in the box, copied from the supplier's listing.
 * Until somebody has done that and said where the figures came from, the
 * sheet cannot open a kit and the product cannot be chosen for a job. That
 * is deliberate friction: the alternative is a plan built on a half-
 * remembered pack size, which is how you drive to a roof with the wrong
 * channel. The screen therefore shows "Needs data" prominently rather than
 * hiding incomplete sheets.
 *
 * AN OFFCUT IS A PIECE. Two 3 ft offcuts are not a 6 ft run. The shelf
 * total cannot answer "can I cut a 6 ft piece today", so this screen leads
 * with the longest piece available and treats the total as secondary. A
 * screen that showed only the total would let somebody promise a run that
 * cannot be cut.
 *
 * Nothing here seeds or guesses a product. Every figure is typed by the
 * owner from the listing, and the supplier's own site has not been
 * reachable from this environment. */

const REVIEW_STATES = [
  { value: 'draft',      label: 'Draft — being typed up' },
  { value: 'reviewed',   label: 'Reviewed — checked against the listing' },
  { value: 'needs_data', label: 'Needs data — the listing does not say' }
];

const STATE_BADGE = {
  reviewed: 'badge--ok',
  draft: 'badge--warn',
  needs_data: 'badge--warn'
};

const STATE_LABEL = {
  reviewed: 'Reviewed',
  draft: 'Draft',
  needs_data: 'Needs data'
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

const qtyText = (n, unit) => (n === null || n === undefined)
  ? 'quantity not recorded'
  : `${n} ${unit || ''}`.trim();

/* ------------------------------------------------------------- panel ---- */

export function kitsAndPiecesPanel() {
  const host = el('div', {});
  let kits = [];          // materials of category 'kit'
  let cuttables = [];     // materials that may be cut
  let allMaterials = [];
  let sheets = [];
  let piecesRows = [];
  let offcuts = [];
  let locations = [];
  let locationCode = 'base';
  let loading = true;
  let loadError = null;
  let busy = false;
  let showNewSheet = false;

  async function act(btn, fn, success) {
    if (busy) return false;
    const was = btn ? btn.textContent : null;
    busy = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
    const ok = await trySave(fn, { success, after: async () => { await load(); } });
    busy = false;
    if (btn && btn.isConnected) { btn.disabled = false; btn.textContent = was; }
    return ok;
  }

  async function load() {
    loading = true; loadError = null; paint();
    try {
      const [mats, sh, pv, oc, locs] = await Promise.all([
        api.listMaterials(),
        api.listKitSheets(),
        api.listPieceAvailability({ locationCode }),
        api.listOffcuts({ locationCode }),
        api.listStockLocations()
      ]);
      allMaterials = mats;
      kits = mats.filter((m) => m.category === 'kit');
      cuttables = mats.filter((m) => m.cuttable);
      sheets = sh;
      // Only materials that actually have pieces or stock are worth a row;
      // the catalogue cross-joined with locations is mostly zeroes.
      piecesRows = pv.filter((r) => Number(r.on_hand) !== 0 || Number(r.offcut_count) > 0);
      offcuts = oc;
      locations = locs;
    } catch (err) {
      loadError = describeWriteError(err);
    } finally {
      loading = false; paint();
    }
  }

  function paint() {
    fill(host, [
      loadError
        ? el('div', { class: 'card' }, [
            el('p', { class: 'error-text', text: `Could not load: ${loadError}` })])
        : loading
          ? el('div', { class: 'card' }, [el('p', { class: 'hint', text: 'Loading…' })])
          : el('div', {}, [kitCard(), piecesCard()])
    ]);
  }

  /* ----------------------------------------------------------- kits ---- */

  function kitCard() {
    return el('div', { class: 'card' }, [
      el('div', { class: 'card__head', style: 'flex-wrap:wrap;gap:8px' }, [
        el('div', {}, [
          el('h2', { text: 'Kit component sheets' }),
          el('p', { text:
            'What is inside one supplier kit, taken from the product listing. '
            + 'A kit cannot be opened, and cannot be chosen for a job, until '
            + 'its sheet has been reviewed against a named source — a kit and '
            + 'its contents must never both count as stock.' })
        ]),
        el('button', {
          class: `btn btn--sm${showNewSheet ? ' btn--primary' : ''}`,
          type: 'button',
          text: showNewSheet ? 'Close' : 'Start a sheet',
          'aria-expanded': showNewSheet ? 'true' : 'false',
          onClick: () => { showNewSheet = !showNewSheet; paint(); }
        })
      ]),
      showNewSheet ? newSheetBox() : null,
      sheets.length === 0
        ? el('p', { class: 'hint', text:
            kits.length === 0
              ? 'No kits in the catalogue yet. Add a material with category '
                + '"kit" on the Stock tab first.'
              : 'No component sheets yet. Start one for each kit you buy.' })
        : el('div', {}, sheets.map(sheetRow))
    ].filter(Boolean));
  }

  function newSheetBox() {
    const kitPick = select(
      kits.length
        ? kits.map((m) => ({ value: m.id, label: m.name }))
        : [{ value: '', label: 'No kit materials yet' }],
      '', null);
    const model = el('input', { class: 'input', type: 'text', placeholder: 'Model (optional)' });
    const coverage = numberInput('', null, { step: 'any', min: '0' });
    const source = el('input', { class: 'input', type: 'text',
      placeholder: 'Where the figures came from' });

    return el('div', { class: 'section-box', style: 'margin:0 0 12px' }, [
      el('h3', { text: 'Start a component sheet', style: 'margin:0 0 8px' }),
      el('div', { class: 'grid grid--2' }, [
        labelled('Kit', kitPick),
        labelled('Model', model)
      ]),
      el('div', { class: 'grid grid--2', style: 'margin-top:8px' }, [
        labelled('Stated coverage (ft)', coverage,
          'Leave blank if the listing does not say. Blank is unknown, not zero.'),
        labelled('Source', source, 'The listing or document these figures came from.')
      ]),
      el('div', { class: 'btn-row', style: 'margin-top:8px;flex-wrap:wrap' }, [
        el('button', {
          class: 'btn btn--sm btn--primary', type: 'button', text: 'Create sheet',
          disabled: kits.length === 0 ? true : undefined,
          onClick: (e) => {
            if (!kitPick.value) return;
            return act(e.currentTarget, () => api.createKitSheet({
              material_id: kitPick.value,
              model: model.value.trim() || null,
              coverage_ft: coverage.value === '' ? null : Number(coverage.value),
              source: source.value.trim() || null
            }), 'Sheet started.');
          }
        })
      ])
    ]);
  }

  function sheetRow(sheet) {
    const mat = sheet.ns_materials || {};
    const lines = sheet.ns_kit_sheet_lines || [];
    const included = lines.filter((l) => l.inclusion === 'included');
    const blanks = included.filter((l) => l.quantity_per_kit === null);
    const canReview = included.length > 0 && blanks.length === 0
      && (sheet.source || '').trim() !== '';

    return el('div', {
      class: 'row-item',
      dataset: { kitSheet: sheet.id },
      style: 'flex-direction:column;align-items:stretch;gap:8px'
    }, [
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;align-items:baseline' }, [
        el('strong', { text: mat.name || 'Kit' }),
        el('span', { class: `badge ${STATE_BADGE[sheet.review_state] || ''}`,
          text: STATE_LABEL[sheet.review_state] || humanise(sheet.review_state) }),
        el('span', { class: 'hint', style: 'margin:0', text: [
          sheet.model,
          sheet.coverage_ft ? `${sheet.coverage_ft} ft stated coverage` : 'coverage not stated',
          sheet.source ? `source: ${sheet.source}` : 'no source recorded'
        ].filter(Boolean).join(' · ') })
      ]),

      included.length === 0
        ? el('p', { class: 'hint', style: 'margin:0',
            text: 'Nothing recorded as included yet.' })
        : el('ul', { style: 'margin:0;padding-left:18px' }, included.map((l) =>
            el('li', { class: 'hint', text:
              `${l.ns_materials?.name || 'component'} — `
              + qtyText(l.quantity_per_kit, l.ns_materials?.unit)
              + (l.note ? ` — ${l.note}` : '') }))),

      lines.some((l) => l.inclusion === 'separately_required')
        ? el('p', { class: 'hint', style: 'margin:0', text:
            'Separately required: '
            + lines.filter((l) => l.inclusion === 'separately_required')
                .map((l) => l.ns_materials?.name).filter(Boolean).join(', ')
            + ' — needed for the install, not in the box, so opening a kit '
            + 'creates none of it.' })
        : null,

      blanks.length
        ? el('p', { class: 'hint', style: 'margin:0', text:
            `${blanks.length} included component(s) have no quantity, so this `
            + 'sheet cannot be reviewed. An unknown quantity must not reach a plan.' })
        : null,

      el('div', { class: 'btn-row', style: 'flex-wrap:wrap' }, [
        el('button', { class: 'btn btn--sm', type: 'button', text: 'Add component',
          disabled: busy || sheet.review_state === 'reviewed' ? true : undefined,
          onClick: () => openAddLine(sheet) }),
        sheet.review_state !== 'reviewed'
          ? el('button', {
              class: 'btn btn--sm btn--primary', type: 'button', text: 'Mark reviewed',
              disabled: (busy || !canReview) ? true : undefined,
              title: canReview ? undefined
                : 'Record every included quantity and a source first.',
              onClick: (e) => act(e.currentTarget, () => api.updateKitSheet(sheet.id, {
                review_state: 'reviewed', reviewed_at: new Date().toISOString()
              }), 'Sheet reviewed.')
            })
          : el('button', {
              class: 'btn btn--sm', type: 'button', text: 'Reopen',
              disabled: busy ? true : undefined,
              onClick: (e) => act(e.currentTarget, () => api.updateKitSheet(sheet.id, {
                review_state: 'draft', reviewed_at: null
              }), 'Sheet reopened.')
            }),
        sheet.review_state !== 'needs_data'
          ? el('button', {
              class: 'btn btn--sm', type: 'button', text: 'Listing does not say',
              disabled: busy ? true : undefined,
              onClick: (e) => act(e.currentTarget, () => api.updateKitSheet(sheet.id, {
                review_state: 'needs_data', reviewed_at: null
              }), 'Marked as needing data.')
            })
          : null,
        sheet.review_state === 'reviewed'
          ? el('button', {
              class: 'btn btn--sm btn--primary', type: 'button', text: 'Open a kit',
              disabled: busy ? true : undefined,
              onClick: () => openKitBox(sheet, mat)
            })
          : null
      ].filter(Boolean)),

      !canReview && sheet.review_state !== 'reviewed'
        ? el('p', { class: 'hint', style: 'margin:0', text:
            'A reviewed sheet needs every included quantity and a source.' })
        : null
    ].filter(Boolean));
  }

  function mountInline(anchorSelector, builder) {
    const existing = host.querySelector('[data-inline]');
    if (existing) existing.remove();
    const holder = el('div', { class: 'section-box', style: 'margin:0' });
    holder.dataset.inline = '1';
    fill(holder, [builder(() => holder.remove())]);
    const target = host.querySelector(anchorSelector);
    (target || host).appendChild(holder);
  }

  function openAddLine(sheet) {
    mountInline(`[data-kit-sheet="${sheet.id}"]`, (close) => {
      const used = new Set((sheet.ns_kit_sheet_lines || []).map((l) => l.material_id));
      const options = allMaterials
        .filter((m) => m.id !== sheet.material_id && !used.has(m.id))
        .map((m) => ({ value: m.id, label: `${m.name} (${m.unit})` }));
      const pick = select(options.length ? options
        : [{ value: '', label: 'No other materials available' }], '', null);
      const qty = numberInput('', null, { step: 'any', min: '0' });
      const inclusion = select([
        { value: 'included', label: 'In the box' },
        { value: 'separately_required', label: 'Separately required' }
      ], 'included', null);
      const note = el('input', { class: 'input', type: 'text', placeholder: 'Note (optional)' });

      return el('div', {}, [
        el('h3', { text: 'Add a component', style: 'margin:0 0 8px' }),
        el('p', { class: 'hint', style: 'margin:0 0 8px', text:
          'Leave the quantity blank if the listing does not give one. A blank '
          + 'is honest; a guess would be opened into stock later.' }),
        el('div', { class: 'grid grid--2' }, [
          labelled('Component', pick),
          labelled('Quantity per kit', qty, 'Blank means the listing does not say.')
        ]),
        el('div', { class: 'grid grid--2', style: 'margin-top:8px' }, [
          labelled('In the box?', inclusion),
          labelled('Note', note)
        ]),
        el('div', { class: 'btn-row', style: 'margin-top:8px;flex-wrap:wrap' }, [
          el('button', {
            class: 'btn btn--sm btn--primary', type: 'button', text: 'Add',
            onClick: async (e) => {
              if (!pick.value) return;
              const ok = await act(e.currentTarget, () => api.addKitSheetLine({
                sheet_id: sheet.id,
                material_id: pick.value,
                quantity_per_kit: qty.value === '' ? null : Number(qty.value),
                inclusion: inclusion.value,
                note: note.value.trim() || null
              }), 'Component added.');
              if (ok) close();
            }
          }),
          el('button', { class: 'btn btn--sm', type: 'button', text: 'Cancel', onClick: close })
        ])
      ]);
    });
  }

  function openKitBox(sheet, mat) {
    mountInline(`[data-kit-sheet="${sheet.id}"]`, (close) => {
      const count = numberInput(1, null, { step: '1', min: '1' });
      const where = select(
        locations.map((l) => ({ value: l.code, label: l.name })), locationCode, null);
      const note = el('input', { class: 'input', type: 'text', placeholder: 'Note (optional)' });
      const included = (sheet.ns_kit_sheet_lines || [])
        .filter((l) => l.inclusion === 'included');

      return el('div', {}, [
        el('h3', { text: `Open ${mat.name || 'a kit'}`, style: 'margin:0 0 8px' }),
        el('p', { class: 'hint', style: 'margin:0 0 8px', text:
          'The kit leaves stock and its contents arrive in the same moment. '
          + 'A kit and the parts inside it never both count as available.' }),
        included.length
          ? el('ul', { class: 'hint', style: 'margin:0 0 8px;padding-left:18px' },
              included.map((l) => el('li', { text:
                `${l.ns_materials?.name}: ${qtyText(l.quantity_per_kit, l.ns_materials?.unit)} per kit` })))
          : null,
        el('div', { class: 'grid grid--3' }, [
          labelled('How many kits', count),
          labelled('At', where),
          labelled('Note', note)
        ]),
        el('div', { class: 'btn-row', style: 'margin-top:8px;flex-wrap:wrap' }, [
          el('button', {
            class: 'btn btn--sm btn--primary', type: 'button', text: 'Open',
            onClick: async (e) => {
              const n = Number(count.value);
              if (!(n > 0)) return;
              if (!confirmAction(
                `Open ${n} x ${mat.name}? The kit stock drops and the components `
                + 'appear. This is recorded as a conversion and is not undone by '
                + 'a counter-movement.')) return;
              const ok = await act(e.currentTarget, () => api.openSealedKit({
                kitMaterialId: sheet.material_id,
                locationCode: where.value,
                kitCount: n,
                note: note.value.trim() || null
              }), `Opened ${n} kit(s).`);
              if (ok) close();
            }
          }),
          el('button', { class: 'btn btn--sm', type: 'button', text: 'Cancel', onClick: close })
        ].filter(Boolean))
      ].filter(Boolean));
    });
  }

  /* --------------------------------------------------------- pieces ---- */

  function piecesCard() {
    return el('div', { class: 'card' }, [
      el('div', { class: 'card__head', style: 'flex-wrap:wrap;gap:8px' }, [
        el('div', {}, [
          el('h2', { text: 'Sticks and offcuts' }),
          el('p', { text:
            'Two 3 ft offcuts are not a 6 ft run, so the number that matters '
            + 'is the longest piece, not the total. Recording an offcut adds '
            + 'no stock — it says what shape the stock on the shelf is in.' })
        ]),
        labelled('At', select(
          locations.map((l) => ({ value: l.code, label: l.name })),
          locationCode,
          async (e) => { locationCode = e.target.value; await load(); }))
      ]),

      piecesRows.length === 0
        ? el('p', { class: 'hint', text: 'Nothing on hand at this location.' })
        : el('div', {}, piecesRows.map(pieceRow)),

      cuttables.length
        ? recordOffcutBox()
        : el('p', { class: 'hint', text:
            'No material is marked as cut to length yet, so there is nothing '
            + 'that can have an offcut.' })
    ]);
  }

  function pieceRow(row) {
    const mine = offcuts.filter((c) => c.material_id === row.material_id);
    const longest = row.longest_runnable === null || row.longest_runnable === undefined
      ? null : Number(row.longest_runnable);

    return el('div', { class: 'row-item', style: 'flex-direction:column;align-items:stretch;gap:6px' }, [
      el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;align-items:baseline' }, [
        el('strong', { text: row.name }),
        row.cuttable ? el('span', { class: 'badge', text: 'Cut to length' }) : null,
        row.spec_state !== 'reviewed'
          ? el('span', { class: 'badge badge--warn',
              text: row.spec_state === 'unavailable' ? 'Spec unavailable' : 'Spec unchecked' })
          : null
      ].filter(Boolean)),

      el('p', { class: 'hint', style: 'margin:0', text:
        `${row.on_hand} ${row.unit} on hand`
        + (Number(row.offcut_count) > 0
            ? ` · ${row.offcut_count} offcut(s) totalling ${row.offcut_total}`
            : '')
        + (row.full_pieces !== null && row.full_pieces !== undefined
            ? ` · ${row.full_pieces} full piece(s)` : '') }),

      el('p', { class: 'hint', style: 'margin:0', text:
        longest === null
          ? 'Longest run that can be cut: unknown — the length of one piece '
            + 'has not been recorded for this product.'
          : `Longest run that can be cut today: ${longest} ${row.unit}.` }),

      mine.length
        ? el('ul', { style: 'margin:0;padding-left:18px' }, mine.map((c) =>
            el('li', { class: 'hint', style: 'display:flex;flex-wrap:wrap;gap:8px;align-items:center' }, [
              el('span', { text: `${c.length} ${c.ns_materials?.unit || ''}`.trim()
                + (c.note ? ` — ${c.note}` : '')
                + ` — recorded ${date(c.created_at)}` }),
              el('button', { class: 'btn btn--sm', type: 'button', text: 'Use on a job',
                disabled: busy ? true : undefined,
                onClick: (e) => act(e.currentTarget,
                  () => api.consumeOffcut({ offcutId: c.id }),
                  'Piece used.') }),
              el('button', { class: 'btn btn--sm', type: 'button', text: 'Scrap',
                disabled: busy ? true : undefined,
                onClick: async (e) => {
                  if (!confirmAction(
                    'Scrap this piece? It comes off the shelf as damaged and the '
                    + 'record stays, so the write-off is explainable later.')) return;
                  await act(e.currentTarget, () => api.scrapOffcut({ offcutId: c.id }),
                    'Piece scrapped.');
                } })
            ])))
        : null
    ].filter(Boolean));
  }

  function recordOffcutBox() {
    const pick = select(cuttables.map((m) => ({ value: m.id, label: m.name })), '', null);
    const length = numberInput('', null, { step: 'any', min: '0' });
    const note = el('input', { class: 'input', type: 'text', placeholder: 'Note (optional)' });

    return el('div', { class: 'section-box', style: 'margin:12px 0 0' }, [
      el('h3', { text: 'Record a usable offcut', style: 'margin:0 0 8px' }),
      el('p', { class: 'hint', style: 'margin:0 0 8px', text:
        'Only for a piece worth keeping. This adds no stock: the length is '
        + 'already on the shelf, and this records that it is one piece of that '
        + 'length rather than several short ones.' }),
      el('div', { class: 'grid grid--3' }, [
        labelled('Material', pick),
        labelled('Length', length),
        labelled('Note', note)
      ]),
      el('div', { class: 'btn-row', style: 'margin-top:8px;flex-wrap:wrap' }, [
        el('button', {
          class: 'btn btn--sm btn--primary', type: 'button', text: 'Record piece',
          onClick: (e) => {
            const n = Number(length.value);
            if (!pick.value || !(n > 0)) return;
            return act(e.currentTarget, () => api.recordOffcut({
              materialId: pick.value,
              locationCode,
              length: n,
              note: note.value.trim() || null
            }), 'Piece recorded.');
          }
        })
      ])
    ]);
  }

  load();
  return host;
}

export { REVIEW_STATES };
