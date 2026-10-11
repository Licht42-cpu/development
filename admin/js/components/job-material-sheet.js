import * as api from '../lib/api.js';
import { el, select, numberInput } from '../../../shared/dom.js';
import { fill } from '../lib/admin-dom.js';
import { trySave, describeWriteError } from '../lib/save.js';

/* The material sheet for one job: what the owner actually chose.
 *
 * WHY THIS IS SEPARATE FROM THE ESTIMATE. The estimate (job-materials.js)
 * says what the service templates imply. This says what a person decided,
 * and it is the only thing that ever reserves stock. The acceptance
 * criterion is "accepted work reserves only selected materials, not every
 * draft quote option", so a line that is not ticked cannot reach the shelf
 * — not by convention, but because the reserving RPC reads `where selected`.
 *
 * HEATING KITS. The screen lists what we stock and what the job measured,
 * side by side, and refuses to rank them. The manufacturer's layout decides
 * which cable or kit fits a roof; quoted roofline length is not cable
 * length, and a product whose specification nobody has checked is shown as
 * unselectable rather than hidden, so the gap is visible instead of quietly
 * narrowing the list. */

const STATUS_LABEL = {
  draft: 'Draft',
  reviewed: 'Reviewed',
  reserved: 'Stock committed',
  cancelled: 'Cancelled'
};

const STATUS_BADGE = {
  draft: 'badge--warn',
  reviewed: 'badge--ok',
  reserved: 'badge--ok',
  cancelled: 'badge--muted'
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

export function createJobMaterialSheetPanel({ jobId }) {
  const root = el('div', { class: 'card' });
  let sheet = null;
  let materials = [];
  let heating = null;
  let loading = true;
  let loadError = null;
  let busy = false;
  let showAdd = false;

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
      const [s, mats, heat] = await Promise.all([
        api.getJobMaterialSheet(jobId),
        api.listMaterials(),
        api.heatingKitCandidates(jobId)
      ]);
      sheet = s;
      materials = mats;
      heating = heat;
    } catch (err) {
      loadError = describeWriteError(err);
    } finally {
      loading = false; paint();
    }
  }

  function paint() {
    fill(root, [
      el('div', { class: 'card__head', style: 'flex-wrap:wrap;gap:8px' }, [
        el('div', {}, [
          el('h2', { text: 'Material sheet' }),
          el('p', { text:
            'What was chosen for this job. Only the ticked lines ever reserve '
            + 'stock, so an option nobody picked never reaches the shelf.' })
        ]),
        sheet
          ? el('span', { class: `badge ${STATUS_BADGE[sheet.status] || ''}`,
              text: STATUS_LABEL[sheet.status] || sheet.status })
          : null
      ].filter(Boolean)),

      loadError
        ? el('p', { class: 'error-text', text: `Could not load the sheet: ${loadError}` })
        : loading
          ? el('p', { class: 'hint', text: 'Loading…' })
          : sheet ? sheetBody() : emptyBody()
    ]);
  }

  function emptyBody() {
    return el('div', {}, [
      el('p', { class: 'hint', text:
        'No material sheet yet. Start one to record what this job actually '
        + 'needs, then review it to commit stock.' }),
      el('div', { class: 'btn-row', style: 'flex-wrap:wrap' }, [
        el('button', {
          class: 'btn btn--sm btn--primary', type: 'button', text: 'Start a sheet',
          disabled: busy ? true : undefined,
          onClick: (e) => act(e.currentTarget,
            () => api.createJobMaterialSheet(jobId), 'Sheet started.')
        })
      ])
    ]);
  }

  function sheetBody() {
    const lines = sheet.ns_job_material_sheet_lines || [];
    const selected = lines.filter((l) => l.selected);
    const editable = sheet.status === 'draft';

    return el('div', {}, [
      lines.length === 0
        ? el('p', { class: 'hint', text: 'Nothing on the sheet yet.' })
        : el('div', {}, lines.map((l) => lineRow(l, editable))),

      selected.length === 0 && lines.length > 0
        ? el('p', { class: 'hint', text:
            'Nothing is ticked, so reviewing this sheet would commit to nothing.' })
        : null,

      editable && showAdd ? addBox() : null,

      el('div', { class: 'btn-row', style: 'margin-top:10px;flex-wrap:wrap' }, [
        editable
          ? el('button', {
              class: `btn btn--sm${showAdd ? ' btn--primary' : ''}`, type: 'button',
              text: showAdd ? 'Close' : 'Add a material',
              'aria-expanded': showAdd ? 'true' : 'false',
              onClick: () => { showAdd = !showAdd; paint(); }
            })
          : null,
        editable
          ? el('button', {
              class: 'btn btn--sm btn--primary', type: 'button', text: 'Mark reviewed',
              disabled: (busy || selected.length === 0) ? true : undefined,
              title: selected.length === 0 ? 'Tick at least one line first.' : undefined,
              onClick: (e) => act(e.currentTarget,
                () => api.reviewJobMaterialSheet({ sheetId: sheet.id }),
                'Sheet reviewed.')
            })
          : null,
        sheet.status === 'reviewed'
          ? el('button', {
              class: 'btn btn--sm btn--primary', type: 'button', text: 'Commit stock',
              disabled: busy ? true : undefined,
              onClick: (e) => act(e.currentTarget,
                () => api.reserveJobMaterialSheet({ sheetId: sheet.id }),
                'Stock committed to this job.')
            })
          : null
      ].filter(Boolean)),

      sheet.status === 'reserved'
        ? el('p', { class: 'hint', style: 'margin-top:8px', text:
            'Stock is held for the ticked lines. Holding reduces what is '
            + 'available to other jobs; it does not move anything off a shelf.' })
        : null,

      heatingBox()
    ].filter(Boolean));
  }

  function lineRow(line, editable) {
    const m = line.ns_materials || {};
    const unchecked = ['kit', 'heating_cable'].includes(m.category)
      && m.spec_state !== 'reviewed';

    return el('div', { class: 'row-item', style: 'gap:8px;flex-wrap:wrap' }, [
      el('label', { class: 'check', style: 'display:flex;gap:8px;align-items:center;margin:0' }, [
        el('input', {
          type: 'checkbox',
          checked: line.selected ? true : undefined,
          disabled: (!editable || busy) ? true : undefined,
          style: 'width:auto;min-height:0',
          onChange: (e) => {
            const want = e.currentTarget.checked;
            return trySave(() => api.selectJobMaterial({
              sheetId: sheet.id,
              materialId: line.material_id,
              quantity: Number(line.quantity),
              selected: want,
              source: line.source
            }), {
              revert: () => { e.currentTarget.checked = !want; },
              after: async () => { await load(); }
            });
          }
        }),
        el('span', { text: m.name || 'material' })
      ]),
      el('span', { class: 'hint', style: 'margin:0',
        text: `${line.quantity} ${m.unit || ''}`.trim() }),
      line.reservation_id
        ? el('span', { class: 'badge badge--ok', text: 'Held' })
        : null,
      unchecked
        ? el('span', { class: 'badge badge--warn', text: 'Spec unchecked' })
        : null,
      unchecked
        ? el('p', { class: 'hint', style: 'margin:0;flex-basis:100%', text:
            'This product\'s specification has not been checked against the '
            + 'listing, so it cannot be ticked or reviewed.' })
        : null
    ].filter(Boolean));
  }

  function addBox() {
    const used = new Set((sheet.ns_job_material_sheet_lines || []).map((l) => l.material_id));
    const options = materials.filter((m) => !used.has(m.id))
      .map((m) => ({ value: m.id, label: `${m.name} (${m.unit})` }));
    const pick = select(options.length ? options
      : [{ value: '', label: 'Every material is already on the sheet' }], '', null);
    const amount = numberInput('', null, { step: 'any', min: '0' });
    const note = el('input', { class: 'input', type: 'text', placeholder: 'Note (optional)' });

    return el('div', { class: 'section-box', style: 'margin:10px 0 0' }, [
      el('h3', { text: 'Add a material', style: 'margin:0 0 8px' }),
      el('div', { class: 'grid grid--3' }, [
        labelled('Material', pick),
        labelled('Quantity', amount),
        labelled('Note', note)
      ]),
      el('div', { class: 'btn-row', style: 'margin-top:8px;flex-wrap:wrap' }, [
        el('button', {
          class: 'btn btn--sm btn--primary', type: 'button', text: 'Add',
          onClick: async (e) => {
            const n = Number(amount.value);
            if (!pick.value || !(n > 0)) return;
            const ok = await act(e.currentTarget, () => api.selectJobMaterial({
              sheetId: sheet.id,
              materialId: pick.value,
              quantity: n,
              selected: true,
              source: 'manual',
              note: note.value.trim() || null
            }), 'Added to the sheet.');
            if (ok) { showAdd = false; }
          }
        })
      ])
    ]);
  }

  /** Candidates and measurements, with no ranking. */
  function heatingBox() {
    if (!heating || !(heating.candidates || []).length) return null;
    const node = el('details', { style: 'margin-top:10px' }, [
      el('summary', { class: 'hint', style: 'cursor:pointer',
        text: 'Heating cable and kits we stock' }),
      el('p', { class: 'hint', style: 'margin:6px 0',
        text: heating.selection_rule }),
      (heating.measurements || []).length
        ? el('ul', { style: 'margin:6px 0;padding-left:18px' },
            heating.measurements.map((m) => el('li', { class: 'hint', text:
              `${m.service_name}${m.label ? ` — ${m.label}` : ''}: `
              + `${m.quantity} ${m.unit}`
              + (m.review_required ? ' (needs review)' : '') })))
        : el('p', { class: 'hint', style: 'margin:6px 0',
            text: 'This job has no measurements recorded yet.' }),
      el('ul', { style: 'margin:6px 0;padding-left:18px' },
        heating.candidates.map((c) => el('li', { class: 'hint', text:
          `${c.name}`
          + (c.stock_length ? ` — ${c.stock_length} per piece` : '')
          + (c.cuttable ? ' — cut to length' : ' — fixed length')
          + (c.selectable ? '' : ` — not selectable: ${c.why_not}`) })))
    ]);
    return node;
  }

  load();
  return { root, reload: load };
}
