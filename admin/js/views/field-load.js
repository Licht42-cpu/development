import { el, clear, field as baseField, select } from '../../../shared/dom.js';
import * as api from '../lib/api.js';
import { localAccount } from '../lib/field-identity.js';
import { readDraft, writeDraft } from '../lib/field-cache.js';
import { loadRead, loadVehicles, closingMaterials, loadSuggestions } from '../lib/field-load-api.js';
import { loadKey, loadWork, sendLoadWork, unresolved } from '../lib/field-load-work.js';

const groups = [['keep', 'Keep aboard'], ['add', 'Add before leaving'], ['return', 'Return to Base'], ['skip', 'Owner authorised going without']];
const quantityNames = [['required_qty', 'Required today'], ['aboard_qty', 'Aboard at planning'], ['reserved_qty', 'Reserved'], ['available_qty', 'Base available'], ['damaged_qty', 'Damaged / unusable'], ['shortage_qty', 'Known shortage']];
const reasons = ['damaged', 'lost', 'miscounted', 'used_more', 'used_less', 'other'];
const label = value => value.replaceAll('_', ' ');
const button = (text, onClick, attrs = {}) => el('button', { class: 'btn', type: 'button', text, onClick, ...attrs });
const paragraph = text => el('p', { text });
function field(title, control) {
  // A select nested in a label otherwise adds every option to its accessible
  // name. Keep an exact, stable name for keyboard and TalkBack users.
  control.setAttribute('aria-label', title);
  return baseField(title, control);
}
const notice = (text, kind = '', role = 'status') => el('div', { class: `load-notice load-${kind}`, role, text });
const localDate = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };

export async function renderFieldLoad({ mount, navigate }) {
  const owner = await localAccount();
  if (!owner) { clear(mount).append(notice('Sign in online to open load work.')); return; }
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const preference = (await readDraft('field-load', 'selection'))?.value;
  let code = params.get('vehicle') || preference?.code;
  if (code) code = code.trim().toLowerCase();
  let date = params.get('day') || preference?.date || localDate();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = localDate();
  let closing = location.hash.startsWith('#/load/closing');
  let vehicles = [], envelope = null, operation = null, offline = !navigator.onLine;
  let busy = false, rendering = false, needsRefresh = false, readAttempt = 0, formsChain = Promise.resolve(), formError = null;
  const root = el('section', { class: 'field-load' }); clear(mount).append(root);
  const current = async () => root.isConnected && await localAccount() === owner;
  const message = el('div', { role: 'status', 'aria-live': 'polite' });
  function connectionChanged() {
    if (!root.isConnected) return;
    offline = !navigator.onLine;
    needsRefresh = true;
    settleControls();
    message.textContent = offline
      ? 'Offline — drafts stay here. No load action will be queued or sent.'
      : 'Connection returned. Refresh this day and review before sending; an unanswered request needs its identical retry.';
    // Keep new writes disabled after reconnect until an authoritative read.
    if (!offline) root.querySelectorAll('[data-load-send]').forEach(control => control.disabled = true);
  }
  window.addEventListener('offline', connectionChanged);
  window.addEventListener('online', connectionChanged);
  const removal = new MutationObserver(() => {
    if (root.isConnected) return;
    window.removeEventListener('offline', connectionChanged);
    window.removeEventListener('online', connectionChanged);
    removal.disconnect();
  });
  removal.observe(mount.parentNode || mount, { childList: true });

  function saveForm(name, value) {
    const copy = structuredClone(value);
    message.textContent = 'Saving draft on this device…';
    formsChain = formsChain.catch(() => {}).then(() => writeDraft(loadKey(code, date), name, copy, owner))
      .then(() => { formError = null; if (root.isConnected) message.textContent = 'Draft saved here — not sent.'; })
      .catch(error => { formError = error; if (root.isConnected) message.textContent = `Draft not saved: ${error.message}`; });
  }
  function navigation(path = closing ? '/load/closing' : '/load') {
    return `${path}?vehicle=${encodeURIComponent(code)}&day=${encodeURIComponent(date)}`;
  }
  async function switchDay(nextCode, nextDate, nextClosing = closing) {
    if (busy) return;
    await formsChain;
    if (formError) { message.textContent = `Save failed. Stay here and retry: ${formError.message}`; return; }
    await writeDraft('field-load', 'selection', { code: nextCode, date: nextDate }, owner);
    code = nextCode; date = nextDate; closing = nextClosing;
    navigate(navigation());
  }
  async function refresh() {
    if (rendering) return;
    await formsChain;
    if (formError) { message.textContent = `Draft not saved: ${formError.message}. Retry the edit before refreshing.`; return; }
    const attempt = ++readAttempt;
    if (!await current()) return;
    rendering = true;
    message.textContent = 'Reading this vehicle and day…';
    offline = !navigator.onLine;
    try {
      operation = await loadWork(code, date);
      if (offline) {
        const saved = await readDraft(loadKey(code, date), 'read');
        const age = Date.now() - saved?.savedAt;
        envelope = age >= 0 && age <= 24*60*60*1000 ? saved.value : null;
      } else {
        const response = await loadRead(code, date);
        if (attempt !== readAttempt || !await current()) return;
        envelope = response; // The frozen envelope, unmodified.
        needsRefresh = false;
        vehicles = response.day.readable_vehicles.filter(v => v.kind === 'vehicle');
        await writeDraft(loadKey(code, date), 'read', response, owner);
        await writeDraft('field-load', 'selection', { code, date }, owner);
      }
      if (attempt !== readAttempt || !await current()) return;
      await paint();
    } catch (error) {
      if (attempt !== readAttempt || !await current()) return;
      envelope = null;
      // A refusal must not expose an old readable plan as current permission.
      if (error.code === '42501') await writeDraft(loadKey(code, date), 'read', null, owner).catch(() => {});
      clear(root).append(el('h1', { text: 'Vehicle load' }), notice(`Could not read this day: ${error.message}`, 'refused', 'alert'),
        button('Retry load read', refresh), el('a', { class: 'btn', href: '#/', text: 'Schedule' }));
      const result = outcome(); if (result) root.append(result);
      if (!offline && vehicles.length) root.append(field('Choose a readable vehicle', select(
        vehicles.map(v => ({ value: v.code, label: v.name })), code,
        event => { void switchDay(event.target.value, date).catch(error => { message.textContent = error.message; }); })));
    } finally {
      rendering = false;
      if (await current()) settleControls();
    }
  }
  async function send(name, payload, retry = false) {
    if (busy || rendering || !await current()) return;
    if (needsRefresh && !retry) { message.textContent = 'Refresh this day and review before sending.'; return; }
    busy = true;
    root.querySelectorAll('button, input, select, textarea').forEach(control => control.disabled = true);
    message.textContent = 'Saving request before contacting the server…';
    try {
      await formsChain;
      if (formError) throw formError;
      operation = await sendLoadWork(code, date, name, payload, owner, retry);
      if (!await current()) return;
      // Reload AFTER the mutation only. Replay receipts are historical, not
      // a new recommendation (a late Keep retry cannot restore its old line).
      if (operation.state !== 'no-response') await refresh();
      else await paint();
    } catch (error) {
      if (!await current()) return;
      operation = await loadWork(code, date).catch(() => operation);
      await paint(); message.textContent = error.message;
    } finally {
      busy = false;
      if (await current()) settleControls();
    }
  }
  function settleControls() {
    root.querySelectorAll('button, input, select, textarea').forEach(control => control.disabled = busy || rendering);
    root.querySelectorAll('[data-load-send]').forEach(control => control.disabled = busy || rendering || offline || needsRefresh || unresolved(operation));
    root.querySelectorAll('[data-load-retry]').forEach(control => control.disabled = busy || rendering || offline);
  }
  function outcome() {
    if (!operation) return null;
    const unknown = unresolved(operation);
    const box = notice('', unknown ? 'no-response' : operation.state);
    box.append(el('strong', { text: unknown ? 'No response — outcome unknown' : { accepted: 'Accepted', refused: 'Refused', conflict: 'Conflict' }[operation.state] }),
      paragraph(operation.message), paragraph(`Request: ${operation.name}. Key: ${operation.payload.p_client_operation_id}`));
    if (unknown) {
      box.append(paragraph('This is not a queued action. Reconnect and retry the identical request to recover its original receipt. No other action can be sent for this vehicle and day until it is resolved.'),
        paragraph('The sync badge covers the existing saved actions; it does not resolve this load request.'),
        button('Retry identical request', () => send(null, null, true), { disabled: offline || busy || rendering, 'data-load-retry': true }));
    }
    if (operation.state === 'refused') box.append(paragraph('No acceptance receipt. Check permission or correct the request before making a new attempt.'));
    if (operation.state === 'conflict') box.append(paragraph('The server refused this request. The plan below has been re-read; review it before another confirmation. A schedule change needs an owner rebuild.'));
    if (operation.receipt) {
      const r = operation.receipt;
      if (operation.name === 'confirm_load_plan') box.append(paragraph(`${r.transfers_posted} stock transfers recorded; ${r.lines_skipped_by_exception} lines set aside. Seasonal assets and level supplies are not transferred by this confirmation.`));
      if (operation.name === 'set_manual_keep' && r.line === null) box.append(paragraph('Keep recorded for the next build; there is no live plan line to change.'));
      if (operation.name === 'reconcile_day_end') {
        box.append(paragraph(`Closing receipt: ${r.lines_counted} observations. Basis: ${r.variance_basis}. ${r.plan_id === null ? 'No plan was required.' : 'Plan closed.'}`));
        for (const line of r.lines) box.append(paragraph(line.level_state
          ? `${line.material_name}: ${label(line.level_state)} (level observation).`
          : `${line.material_name}: ${line.counted_qty} usable, ${line.precision}; live expected ${line.expected_qty}, variance ${line.variance_qty}; ${line.variance_reason || 'no variance'}.`));
      }
      box.append(el('details', {}, [el('summary', { text: 'Server receipt' }), el('pre', { text: JSON.stringify(r, null, 2), style: 'white-space:pre-wrap' })]));
    }
    return box;
  }
  function sendButton(text, name, makePayload) {
    return button(text, async () => {
      try { await send(name, makePayload()); }
      catch (error) { message.textContent = error.message; }
    }, { 'data-load-send': true, disabled: offline || busy || rendering || needsRefresh || unresolved(operation) });
  }
  async function paint() {
    clear(root).append(el('h1', { text: closing ? 'End-of-day count' : 'Vehicle load' }),
      el('a', { class: 'btn', href: '#/', text: '← Schedule' }));
    const available = envelope?.day.readable_vehicles.filter(v => v.kind === 'vehicle') || vehicles;
    const vehicleControl = select(available.length ? available.map(v => ({ value: v.code, label: v.name })) : [{ value: code, label: code }], code,
      event => { void switchDay(event.target.value, date).catch(error => { message.textContent = error.message; }); });
    const dayControl = el('input', { type: 'date', value: date, onChange: event => { if (event.target.value) void switchDay(code, event.target.value).catch(error => { message.textContent = error.message; }); } });
    root.append(el('div', { class: 'load-actions' }, [field('Vehicle', vehicleControl), field('Work date', dayControl)]),
      paragraph('The initial date is the device calendar date. Choose the work date; visits are grouped by the server’s operating-day window.'),
      el('div', { class: 'load-actions' }, [button('Refresh this day', refresh), button(closing ? 'Preparation' : 'End-of-day count', () => switchDay(code, date, !closing))]), message);
    message.textContent = '';
    if (offline) root.append(notice('Offline — saved recommendations are for review only, up to 24 hours old. No load, Keep, exception or closing action is queued. Draft counts remain here. Reconnect, refresh and review before sending.'));
    const result = outcome(); if (result) root.append(result);
    if (!envelope) {
      root.append(notice('No recent load read saved for this vehicle and date. Reconnect to check the plan and access.'));
      const countDraft = (await readDraft(loadKey(code, date), 'counts'))?.value;
      if (countDraft) root.append(el('details', { open: true }, [el('summary', { text: 'Saved count draft — not sent' }), el('pre', { text: JSON.stringify(countDraft, null, 2), style: 'white-space:pre-wrap' })]));
      return;
    }
    root.append(el('h2', { text: `${envelope.location_name} · ${envelope.work_date}` }),
      notice(envelope.work_day_timezone_state === 'configured'
        ? `Operating day: ${envelope.work_day_timezone}.`
        : 'Operating timezone unconfigured — midnight-to-midnight UTC is being used. Evening visits can appear on the next day’s load while the device schedule shows them today.'),
      paragraph(`Window: ${envelope.day.window_starts_at} to ${envelope.day.window_ends_at} (end exclusive).`),
      paragraph(`Plan: ${envelope.state}. Needs review: ${envelope.needs_review_count}. Unassigned jobs: ${envelope.unassigned_job_count}.`));
    if (envelope.unassigned_job_count) root.append(notice('With two active vehicles, unassigned jobs belong to neither plan. Ask the owner to assign them; this screen never guesses a car.'));
    renderStops();
    if (closing) await renderClosing();
    else await renderPreparation();
  }
  function renderStops() {
    const section = el('section', { class: 'card' }, [el('h2', { text: 'Stops in this operating day' })]); root.append(section);
    if (!envelope.day.jobs.length) section.append(paragraph('No visits in the server’s day window.'));
    for (const stop of envelope.day.jobs) {
      const card = el('div', { class: 'load-line' }, [el('h3', { text: stop.customer_name || 'Visit' }),
        paragraph(`${stop.scheduled_for} · ${stop.assigned ? 'Assigned to this vehicle' : 'Single-vehicle default — not an explicit assignment'}`),
        el('a', { class: 'btn', href: `#/visit/${stop.job_id}`, text: 'Open visit' })]); section.append(card);
      if (offline) { card.append(paragraph('Reconnect for current address and access notes.')); continue; }
      const address = paragraph('Reading address and access notes…'); card.append(address);
      void api.getJob(stop.job_id).then(job => {
        if (!card.isConnected) return;
        if (stop.property_id && stop.property_id !== job.properties?.id) throw new Error('Visit property changed. Refresh the day.');
        address.textContent = [job.properties?.address_line1, job.properties?.city, job.properties?.postal_code].filter(Boolean).join(', ') || 'Address not recorded.';
        card.append(paragraph(`Access: ${job.properties?.access_note || 'No access note recorded.'}`));
      }).catch(error => { if (card.isConnected) address.textContent = `Visit details unavailable: ${error.message}`; });
    }
  }
  async function renderPreparation() {
    const plan = envelope.plan;
    if (!plan) root.append(notice('No plan has been built for this vehicle and day. Contact the office to prepare one. Closing counts can still be recorded.'));
    if (envelope.can_build && envelope.state !== 'closed') root.append(sendButton(plan ? 'Rebuild whole-day plan' : 'Build whole-day plan', 'build_load_plan', () => ({ p_location_code: code, p_work_date: date, p_note: null })));
    if (plan) {
      root.append(paragraph(`Revision ${plan.revision}. Quantities below were read when the plan was generated; they are not current balances.`));
      if (plan.note) root.append(notice(plan.note));
      for (const [action, name] of groups) {
        const section = el('section', { class: 'card', 'data-load-group': action }, [el('h2', { text: name })]); root.append(section);
        const lines = plan.lines.filter(line => line.action === action);
        if (!lines.length) section.append(paragraph('None recommended.'));
        for (const line of lines) {
          const title = line.material_name || line.set_code || 'Named seasonal set';
          const card = el('article', { class: 'load-line', 'data-line-id': line.line_id }, [el('h3', { text: title }), paragraph(line.reason)]); section.append(card);
          if (line.rental_set_id) card.append(paragraph(`Company-owned seasonal asset: ${line.rental_set_id}. Assignment is not proof it is aboard. Confirming this plan does not move the set.`));
          else if (line.level_state) card.append(paragraph(`Level: ${label(line.level_state)}. Count as a level; no numerical quantity.`));
          else card.append(el('dl', { class: 'load-quantities' }, quantityNames.map(([key, text]) => el('div', {}, [el('dt', { text }), el('dd', { text: line[key] == null ? 'Not recorded' : `${line[key]} ${line.unit || ''}` })]))),
            paragraph(`Planning count: ${line.precision}.`));
          if (line.data_state === 'needs_review') card.append(notice('Needs review — information is missing or not approved. This is not a known shortage.'));
          if (!line.level_state && line.shortage_qty > 0) card.append(notice(`Known shortage: ${line.shortage_qty} ${line.unit || ''}. Ask the office to resolve it.`));
          card.append(paragraph(line.job_ids.length ? `Needed across ${line.job_ids.length} stops: ${line.job_ids.join(', ')}.` : 'Whole-day or baseline decision.'));
          if (action === 'skip') card.append(paragraph('Owner-authorised set-aside. Not transferred; no crew override.'));
          if (line.material_id && action !== 'skip' && envelope.state === 'current') {
            const reasonKey = `keep:${line.material_id}`;
            const reason = el('input', { type: 'text', value: (await readDraft(loadKey(code, date), reasonKey))?.value || '', onInput: event => saveForm(reasonKey, event.target.value) });
            const keepPanel = el('details', { open: action === 'return' || line.manual_keep }, [el('summary', { text: line.manual_keep ? 'Manual Keep is active' : 'Hold this item aboard' })]);
            card.append(keepPanel);
            if (!line.manual_keep) keepPanel.append(field(`Keep reason — ${title}`, reason));
            keepPanel.append(sendButton(line.manual_keep ? `Clear Manual Keep — ${title}` : `Manual Keep — ${title}`, 'set_manual_keep', () => ({ p_location_code: code, p_work_date: date, p_material_id: line.material_id, p_keep: !line.manual_keep, p_reason: line.manual_keep ? null : reason.value.trim() || null })));
            if (line.manual_keep) keepPanel.append(paragraph('Manual Keep survives rebuilding. Clear it to restore the whole-day recommendation.'));
          }
        }
      }
      if (envelope.state === 'current') {
        const check = el('input', { type: 'checkbox' });
        check.setAttribute('aria-label', 'I checked the physical loading and returns. Level supplies and seasonal sets require their own checks.');
        root.append(el('label', { class: 'load-check' }, [check, el('span', { text: 'I checked the physical loading and returns. Level supplies and seasonal sets require their own checks.' })]));
        root.append(sendButton('Confirm checked loading and returns', 'confirm_load_plan', () => {
          if (!check.checked) throw new Error('Check the physical loading and returns before confirming.');
          return { p_plan_id: plan.plan_id, p_expected_revision: plan.revision, p_expected_fingerprint: plan.basis_fingerprint,
            p_note: null, p_expected_lines_fingerprint: plan.lines_fingerprint };
        }));
      }
      if (envelope.state === 'confirmed') root.append(notice('Loading is confirmed. A new owner revision is needed for a different preparation plan.'));
      if (envelope.state === 'closed') root.append(notice('Closed day — plan remains readable. No preparation actions are offered.'));
    }
    if (envelope.state !== 'closed') await renderException(plan);
  }
  async function renderException(plan) {
    const section = el('details', { class: 'card' }, [el('summary', { text: 'Request an owner-authorised exception' }),
      paragraph('Owner permission is required by the server. A crew attempt returns a refusal; it does not authorise going without anything.')]); root.append(section);
    const options = plan?.lines.map(line => ({ value: line.line_id, label: line.material_name || line.set_code })) || [];
    if (!options.length) { section.append(paragraph('Ask the office to build the plan and identify the item first.')); return; }
    // Owner changes a skipped line from the desktop; no field crew override.
    const eligible = plan.lines.filter(line => line.action !== 'skip');
    if (!offline) {
      try {
        const catalogue = await closingMaterials();
        const present = new Set(plan.lines.map(line => line.material_id));
        eligible.push(...catalogue.filter(material => !present.has(material.id)).map(material => ({
          line_id: `material:${material.id}`, material_id: material.id, material_name: material.name,
          rental_set_id: null, tracking_mode: material.tracking_mode, unit: material.unit
        })));
      } catch (error) { section.append(paragraph(`Additional items unavailable: ${error.message}`)); }
    }
    if (!eligible.length) return;
    const draft = (await readDraft(loadKey(code, date), 'exception'))?.value || {};
    const item = select(eligible.map(line => ({ value: line.line_id, label: line.material_name || line.set_code })), eligible.some(line => line.line_id === draft.item) ? draft.item : eligible[0].line_id);
    const kind = select([{ value: 'skip_required', label: 'Go without this item' }, { value: 'carry_extra', label: 'Carry extra' }], draft.kind || 'skip_required');
    const reason = el('textarea', { rows: '2', text: draft.reason || '' });
    const quantity = el('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', value: draft.quantity || '' });
    const quantityField = field('Extra quantity in the item’s operating unit', quantity);
    function quantityVisibility() {
      const line = eligible.find(l => l.line_id === item.value);
      quantityField.hidden = kind.value !== 'carry_extra' || !!line.rental_set_id || !!line.level_state || line.tracking_mode === 'level';
      quantity.setAttribute('aria-label', `Extra quantity (${line.unit || 'operating unit'})`);
    }
    item.addEventListener('change', quantityVisibility); kind.addEventListener('change', quantityVisibility); quantityVisibility();
    for (const control of [item, kind, reason, quantity]) control.addEventListener('input', () => saveForm('exception', { item: item.value, kind: kind.value, reason: reason.value, quantity: quantity.value }));
    section.append(field('Exception item', item), field('Exception decision', kind), field('Exception reason (required)', reason), quantityField,
      sendButton('Ask server to authorise exception', 'authorise_load_exception', () => {
        if (!reason.value.trim()) throw new Error('Give the reason for the exception.');
        const line = eligible.find(l => l.line_id === item.value);
        if (!quantityField.hidden && (quantity.value === '' || !Number.isFinite(quantity.valueAsNumber) || quantity.valueAsNumber <= 0)) throw new Error('Say how much extra to carry in the item’s operating unit.');
        return { p_location_code: code, p_work_date: date, p_kind: kind.value, p_reason: reason.value.trim(), p_material_id: line.material_id,
          p_rental_set_id: line.rental_set_id, p_quantity: quantityField.hidden ? null : quantity.valueAsNumber };
      }));
  }
  async function renderClosing() {
    root.append(paragraph('Count usable items physically aboard now. The server compares against the live usable ledger at closing, not the morning plan. Damaged items stay aboard in the damaged pool; they are not written off.'),
      paragraph('Leave an uncounted item blank. Choose the accuracy and a reason for every numerical observation; the server decides whether there is a variance. No plan or morning confirmation is required.'));
    const saved = (await readDraft(loadKey(code, date), 'counts'))?.value || {};
    const counts = structuredClone(saved);
    let catalogue;
    try {
      if (offline) catalogue = (await readDraft(loadKey(code, date), 'catalogue'))?.value || [];
      else {
        catalogue = await closingMaterials();
        await writeDraft(loadKey(code, date), 'catalogue', catalogue, owner);
      }
    } catch (error) { root.append(notice(`Count catalogue unavailable: ${error.message}`, 'refused')); return; }
    if (!await current()) return;
    const list = el('section', { class: 'card load-counts' }, [el('h2', { text: 'Physical observations' })]); root.append(list);
    for (const material of catalogue) {
      const value = counts[material.id] || {};
      const card = el('div', { class: 'load-count' }, [el('h3', { text: material.name })]); list.append(card);
      const update = (key, input) => { counts[material.id] = { ...counts[material.id], [key]: input }; saveForm('counts', counts); };
      if (material.tracking_mode === 'level') {
        card.append(field(`Observed level — ${material.name}`, select([{ value: '', label: 'Not observed' }, ...['empty','low','enough'].map(v => ({ value: v, label: label(v) }))], value.level_state || '', event => update('level_state', event.target.value))));
      } else {
        card.append(field(`Usable count (${material.unit}) — ${material.name}`, el('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', value: value.counted_qty ?? '', onInput: event => update('counted_qty', event.target.value) })),
          field(`Count accuracy — ${material.name}`, select([{ value: '', label: 'Choose accuracy' }, { value: 'exact', label: 'Exact count' }, { value: 'estimated', label: 'Estimated count' }], value.precision || '', event => update('precision', event.target.value))),
          field(`Variance reason — ${material.name}`, select([{ value: '', label: 'Choose reason if the count differs' }, ...reasons.map(v => ({ value: v, label: label(v) }))], value.variance_reason || '', event => update('variance_reason', event.target.value))));
      }
      card.append(field(`Count note — ${material.name}`, el('textarea', { rows: '2', text: value.note || '', onInput: event => update('note', event.target.value) })));
    }
    const recount = el('input', { type: 'checkbox', 'aria-label': 'I made new physical observations after the accepted closing count.' });
    const alreadyAccepted = operation?.state === 'accepted' && operation.name === 'reconcile_day_end';
    if (alreadyAccepted) root.append(notice('The previous closing count was accepted. Its draft values remain here. Re-count before starting another operation.'),
      el('label', { class: 'load-check' }, [recount, el('span', { text: 'I made new physical observations after the accepted closing count.' })]));
    root.append(sendButton('Record observations and close day', 'reconcile_day_end', () => {
      if (alreadyAccepted && !recount.checked) throw new Error('The previous count was accepted. Make new physical observations before submitting another count.');
      const lines = [];
      for (const material of catalogue) {
        const value = counts[material.id] || {};
        if (material.tracking_mode === 'level') {
          if (value.level_state) lines.push({ material_id: material.id, level_state: value.level_state, precision: 'exact', note: value.note || null });
          continue;
        }
        if (value.counted_qty == null || value.counted_qty === '') continue;
        const qty = Number(value.counted_qty);
        if (!Number.isFinite(qty) || qty < 0) throw new Error(`Enter a non-negative usable count for ${material.name}.`);
        if (!['exact','estimated'].includes(value.precision) || !reasons.includes(value.variance_reason)) throw new Error(`Choose count accuracy and variance reason for ${material.name}. The server checks the live balance.`);
        lines.push({ material_id: material.id, counted_qty: qty, precision: value.precision, variance_reason: value.variance_reason, note: value.note || null });
      }
      if (!lines.length) throw new Error('Record at least one physical observation before closing.');
      return { p_location_code: code, p_work_date: date, p_lines: lines, p_note: null };
    }));
    if (!offline) {
      const suggestions = el('details', { class: 'card' }, [el('summary', { text: 'Replenishment suggestions — no orders or moves' })]); root.append(suggestions);
      void loadSuggestions(code, date).then(data => {
        if (!suggestions.isConnected) return;
        suggestions.append(paragraph(data.note));
        for (const gap of data.baseline_gaps) {
          const unit = catalogue.find(material => material.id === gap.material_id)?.unit;
          suggestions.append(paragraph(`${gap.material_name}: baseline gap ${gap.gap_qty} ${unit || '(operating unit not recorded)'}.`));
        }
        for (const shortage of data.shortages) suggestions.append(paragraph(`${shortage.material_name}: known shortage ${shortage.shortage_qty} ${shortage.unit || '(operating unit not recorded)'}. ${shortage.reason}`));
        for (const item of data.needs_review) suggestions.append(paragraph(`${item.material_name}: needs review. ${item.reason}`));
        if (!data.baseline_gaps.length && !data.shortages.length && !data.needs_review.length) suggestions.append(paragraph('No replenishment suggestions reported.'));
      }).catch(error => { if (suggestions.isConnected) suggestions.append(paragraph(`Suggestions unavailable: ${error.message}`)); });
    }
  }
  try {
    if (!offline) vehicles = await loadVehicles();
    if (!code) code = vehicles[0]?.code;
    if (!code) { clear(root).append(el('h1', { text: 'Vehicle load' }), notice('No readable vehicle is available. Ask the owner to configure your vehicle, or reconnect for access.'), el('a', { href: '#/', class: 'btn', text: 'Schedule' })); return; }
    await refresh();
  } catch (error) { if (root.isConnected) clear(root).append(notice(`Load work unavailable: ${error.message}`, 'refused'), el('a', { href: '#/', class: 'btn', text: 'Schedule' })); }
}
