import * as api from '../lib/api.js';
import { el, clear, toast, select, confirmAction } from '../../../shared/dom.js';
import { humanise } from '../../../shared/format.js';
import { createMeasurementsPanel } from './measurements.js';
import { createQuotePanel } from './quote.js';
import { createPhotosPanel } from './field-photos.js';
import { createDictationReview } from '../components/field-dictation.js';
import * as offlineQueue from '../lib/offline-queue.js';
import { reviewRequestLink } from '../lib/messaging.js';
import { isNative, hapticLight, getDevicePosition } from '../lib/native.js';
import { reviewFlag } from '../components/review-flag.js';
import { trySave, describeWriteError } from '../lib/save.js';
import { readDraft, writeDraft, deleteDraft, retainNoteDraft } from '../lib/field-cache.js';
import { localAccount } from '../lib/field-identity.js';
import { createFieldCompletion } from '../components/field-completion.js';

/* The original four action types this console queues offline:
   Passport/checklist writes, adding a measurement, uploading a photo, and
   capturing a signature. Everything else here still calls api.js directly
   and needs a live connection, same as before. Reviewed completion adds
   one explicitly versioned/idempotent type in field-completion.js. */
function queueToast(queued, okMessage) {
  toast(queued ? 'Offline — saved locally, will sync automatically' : okMessage);
}

function readError(err) {
  return offlineQueue.looksOffline(err) ? 'No connection — reconnect and retry.'
    : err?.message || 'The data could not be read.';
}

const JOB_STATUSES = ['new', 'reviewing', 'estimate_drafted', 'site_visit_scheduled', 'assessed',
  'quote_sent', 'accepted', 'declined', 'scheduled', 'in_progress', 'completed', 'invoiced', 'paid',
  'closed', 'lost'];

const CHECKLIST_ITEMS = [
  { key: 'water_spigot_located',        label: 'Water spigot located' },
  { key: 'electrical_outlet_located',   label: 'Electrical outlet located' },
  { key: 'property_access_confirmed',   label: 'Property access confirmed' },
  { key: 'hazards_identified',          label: 'Hazards / flowerbeds identified' }
];

/** Property Passport: persistent, structured intelligence that outlives any
 *  one visit -- pulled up automatically whenever this property's job or
 *  quote is opened, same as the task asks, because it is read straight off
 *  properties.passport every time this view loads rather than cached or
 *  copied onto the job. */
export function passportPanel(property, onSaved, jobId, ownerId) {
  const p = property.passport && typeof property.passport === 'object' ? property.passport : {};
  const siding = p.siding || {};
  const roof = p.roof || {};
  const access = p.access || {};

  const fields = {};
  function textField(label, group, key, value, placeholder) {
    const input = el('input', { value: value || '', placeholder: placeholder || '', dataset: { draftKey: `${group}.${key}` } });
    fields[`${group}.${key}`] = () => input.value.trim();
    return el('label', { class: 'field', style: 'margin:0' }, [el('span', { text: label }), input]);
  }

  const preferencesInput = el('textarea', {
    rows: '2', 'aria-label': 'Customer preferences', dataset: { draftKey: 'preferences' }, placeholder: 'e.g. "Avoid east flower beds", "Rear gate code: 1234"'
  });
  preferencesInput.value = p.preferences || '';
  const contents = () => JSON.stringify([Object.values(fields).map(read => read()), preferencesInput.value.trim()]);
  let savedContents;
  let saving = false;
  const saveStatus = el('p', { class: 'hint', role: 'status', 'aria-live': 'polite',
    'aria-atomic': 'true', dataset: { passportStatus: '' } });

  const root = el('div', { class: 'card' }, [
    el('div', { class: 'card__head' }, [
      el('div', {}, [
        el('h2', { text: 'Property Passport' }),
        el('p', { text: 'Persists on this property across every future visit and quote.' })
      ])
    ]),
    el('h3', { style: 'margin:0 0 6px;font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)',
      text: 'Siding' }),
    el('div', { class: 'grid grid--2' }, [
      textField('Material', 'siding', 'material', siding.material, 'Vinyl, wood, brick…'),
      textField('Colour', 'siding', 'color', siding.color)
    ]),
    el('div', { class: 'grid grid--2', style: 'margin-top:10px' }, [
      textField('Elevation heights', 'siding', 'elevations_note', siding.elevations_note,
        'e.g. Front/Left 1-storey, Rear 2-storey'),
      textField('Heavy algae sides', 'siding', 'heavy_algae_sides', siding.heavy_algae_sides, 'e.g. North, Rear')
    ]),

    el('h3', { style: 'margin:16px 0 6px;font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)',
      text: 'Roof' }),
    el('div', { class: 'grid grid--3' }, [
      textField('Shingle type', 'roof', 'shingle_type', roof.shingle_type),
      textField('Pitch', 'roof', 'pitch', roof.pitch),
      textField('Moss severity', 'roof', 'moss_severity', roof.moss_severity, 'None / light / heavy')
    ]),

    el('h3', { style: 'margin:16px 0 6px;font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)',
      text: 'Access & utilities' }),
    el('div', { class: 'grid grid--2' }, [
      textField('Water tap location', 'access', 'water_tap_location', access.water_tap_location),
      textField('Electrical receptacle', 'access', 'electrical_receptacle_location', access.electrical_receptacle_location)
    ]),
    el('div', { class: 'grid grid--2', style: 'margin-top:10px' }, [
      textField('Gate width', 'access', 'gate_width', access.gate_width),
      textField('Ladder access restrictions', 'access', 'ladder_access_restrictions', access.ladder_access_restrictions)
    ]),

    el('h3', { style: 'margin:16px 0 6px;font-size:.78rem;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)',
      text: 'Customer preferences' }),
    preferencesInput,

    el('div', { class: 'btn-row', style: 'margin-top:14px' }, [
      el('button', {
        class: 'btn btn--primary', text: 'Save passport',
        onClick: async (event) => {
          const button = event.currentTarget;
          if (button.disabled) return;
          saving = true;
          button.setAttribute('aria-busy', 'true');
          saveStatus.textContent = 'Saving passport…';
          button.disabled = true;
          button.textContent = 'Saving passport…';
          const submittedContents = contents();
          // Re-read property.passport rather than the `p` this card was
          // built from: a checklist toggle (which writes straight through,
          // for an instant-feeling tap) can have changed it in place since
          // this card rendered, and spreading the stale snapshot here would
          // silently revert that toggle.
          const latest = property.passport && typeof property.passport === 'object' ? property.passport : {};
          const passport = {
            ...latest,
            siding:  { ...(latest.siding || {}), material: fields['siding.material'](), color: fields['siding.color'](),
                       elevations_note: fields['siding.elevations_note'](), heavy_algae_sides: fields['siding.heavy_algae_sides']() },
            roof:    { ...(latest.roof || {}), shingle_type: fields['roof.shingle_type'](), pitch: fields['roof.pitch'](),
                       moss_severity: fields['roof.moss_severity']() },
            access:  { ...(latest.access || {}), water_tap_location: fields['access.water_tap_location'](),
                       electrical_receptacle_location: fields['access.electrical_receptacle_location'](),
                       gate_width: fields['access.gate_width'](), ladder_access_restrictions: fields['access.ladder_access_restrictions']() },
            preferences: preferencesInput.value.trim()
          };
          try {
            const { queued } = await offlineQueue.callOrQueue(
              'updateProperty', { id: property.id, patch: { passport } }, 'Save Property Passport',
              { jobId, ownerId, basePassport: structuredClone(latest) });
            property.passport = passport;
            savedContents = submittedContents;
            saveStatus.textContent = queued ? 'Passport saved on this device — waiting to sync.' : 'Property Passport saved.';
            queueToast(queued, 'Property Passport saved');
            if (jobId && contents() === submittedContents) await deleteDraft(jobId, 'passport', ownerId);
            await onSaved?.();
          } catch (err) {
            saveStatus.textContent = `Passport not saved: ${describeWriteError(err)}`;
            toast(err.message, 'error');
          } finally {
            saving = false;
            button.setAttribute('aria-busy', 'false');
            button.disabled = false;
            button.textContent = 'Save passport';
          }
        }
      })
    ]),
    saveStatus
  ]);
  savedContents = contents();
  if (jobId) {
    const controls = [...root.querySelectorAll('input, textarea')];
    let edits = 0;
    let draftChain = Promise.resolve();
    root.addEventListener('input', () => {
      edits++;
      const values = Object.fromEntries(controls.map(control => [control.dataset.draftKey, control.value]));
      draftChain = draftChain.catch(() => {}).then(() => writeDraft(jobId, 'passport', values, ownerId));
      draftChain.catch(error => { saveStatus.textContent = `Draft not saved: ${error.message}`; });
    });
    readDraft(jobId, 'passport').then(draft => {
      if (draft && !edits && !saving) {
        controls.forEach(control => { control.value = draft.value[control.dataset.draftKey] || ''; });
        saveStatus.textContent = 'Passport draft restored from this device — not submitted.';
      }
    }).catch(error => { saveStatus.textContent = `Could not restore draft: ${error.message}`; });
  }
  return { root, hasDraft: () => saving || contents() !== savedContents };
}

/** On-site checklist: quick, instant-save toggles. Stored inside the same
 *  passport jsonb (passport.checklist.*) rather than a parallel structure --
 *  these ARE the access/utility facts the Passport already models, just
 *  confirmed in one tap during a visit instead of typed out. */
export function checklistPanel(property, jobId, ownerId) {
  const p = property.passport && typeof property.passport === 'object' ? property.passport : {};
  const checklist = { ...(p.checklist || {}) };

  const toggles = CHECKLIST_ITEMS.map(item => {
    const on = !!checklist[item.key];
    const box = el('input', { type: 'checkbox', checked: on });
    const label = el('label', { class: `check ${on ? 'is-on' : ''}` }, [box, el('span', { text: item.label })]);
    box.addEventListener('change', async () => {
      hapticLight(); // fire-and-forget -- a missed buzz must never block the save
      checklist[item.key] = box.checked;
      label.className = `check ${box.checked ? 'is-on' : ''}`;
      // Same reasoning as the Passport form's Save handler, in reverse: read
      // property.passport live so an unsaved edit sitting in the Passport
      // form's own fields isn't clobbered by this toggle's write.
      const latest = property.passport && typeof property.passport === 'object' ? property.passport : {};
      try {
        const passport = { ...latest, checklist };
        // No toast here (unlike the Passport form's Save) -- "taps save
        // instantly" means instantly, not an interruption every tap; the
        // topbar's Offline Queue badge is the signal when one goes offline.
        await offlineQueue.callOrQueue('updateProperty', { id: property.id, patch: { passport } }, 'Checklist update',
          { jobId, ownerId, basePassport: structuredClone(latest) });
        property.passport = passport;
      } catch (err) {
        box.checked = !box.checked;
        label.className = `check ${box.checked ? 'is-on' : ''}`;
        toast(err.message, 'error');
      }
    });
    return label;
  });

  return el('div', { class: 'card' }, [
    el('div', { class: 'card__head' }, [
      el('div', {}, [el('h2', { text: 'On-site checklist' }), el('p', { text: 'Taps save instantly.' })])
    ]),
    el('div', { class: 'check-grid' }, toggles)
  ]);
}

/** Mixed-height elevations: a property section carries its own storeys
 *  (and access/ground/ladder/distance) independent of every other section,
 *  which is the whole mechanism "Front 1-storey, Rear 2-storey, Right
 *  1+2-storey mixed" needs -- "mixed" on one elevation is just two sections
 *  both named for that side. Pricing already reads this per-section; this
 *  is a compact mobile editor over the same job_sections table the desktop
 *  tool uses, not a second pricing model. */
function sectionsPanel(job, refs, onChange) {
  const vocab = (groupKey) => {
    const seen = new Map();
    for (const m of refs.modifiers) {
      if (m.group_key !== groupKey) continue;
      if (!seen.has(m.option_key)) seen.set(m.option_key, { value: m.option_key, label: m.label, sort: m.sort_order });
    }
    return [...seen.values()].sort((a, b) => a.sort - b.sort);
  };
  const siteVocab = (groupKey) => refs.siteFactors.filter(f => f.group_key === groupKey)
    .sort((a, b) => a.sort_order - b.sort_order).map(f => ({ value: f.option_key, label: f.label }));

  const heightOpts = vocab('height');
  const accessOpts = vocab('access');

  function row(section) {
    function patch(field) {
      return async (e) => { await api.updateSection(section.id, { [field]: e.target.value }); onChange(); };
    }
    return el('div', { class: 'section-box' }, [
      el('div', { class: 'section-box__head' }, [
        el('input', {
          value: section.name, style: 'max-width:200px', 'aria-label': 'Section name',
          onChange: async (e) => { await api.updateSection(section.id, { name: e.target.value.trim() || 'Section' }); onChange(); }
        }),
        el('button', { class: 'btn btn--sm btn--danger', text: 'Remove',
          onClick: async () => {
            if (!confirmAction(`Remove "${section.name}"?`)) return;
            await api.deleteSection(section.id); onChange();
          } })
      ]),
      el('div', { class: 'grid grid--2' }, [
        el('label', { class: 'field', style: 'margin:0' }, [el('span', { text: 'Storeys' }), select(heightOpts, section.storeys, patch('storeys'))]),
        el('label', { class: 'field', style: 'margin:0' }, [el('span', { text: 'Access' }), select(accessOpts, section.access, patch('access'))])
      ]),
      el('div', { class: 'grid grid--3', style: 'margin-top:10px' }, [
        el('label', { class: 'field', style: 'margin:0' }, [el('span', { text: 'Ground' }), select(siteVocab('ground'), section.ground, patch('ground'))]),
        el('label', { class: 'field', style: 'margin:0' }, [el('span', { text: 'Ladder' }), select(siteVocab('ladder'), section.ladder, patch('ladder'))]),
        el('label', { class: 'field', style: 'margin:0' }, [el('span', { text: 'Distance' }), select(siteVocab('distance'), section.distance, patch('distance'))])
      ]),
      reviewFlag({
        required: section.review_required, reason: section.review_reason,
        label: 'Flag this elevation for review',
        save: (patch) => api.updateSection(section.id, patch)
      })
    ]);
  }

  return el('div', { class: 'card' }, [
    el('div', { class: 'card__head' }, [
      el('div', {}, [
        el('h2', { text: 'Elevations' }),
        el('p', { text: 'Each elevation keeps its own storeys and access — mix them freely.' })
      ]),
      el('button', {
        class: 'btn btn--sm', text: '+ Elevation',
        onClick: async () => {
          const names = ['Front', 'Rear', 'Left', 'Right', 'Garage', 'Addition'];
          await api.createSection(job.id, {
            name: names[refs.sections.length] || 'Other', sort_order: refs.sections.length + 1
          });
          onChange();
        }
      })
    ]),
    refs.sections.length ? el('div', {}, refs.sections.map(row))
                         : el('div', { class: 'empty', text: 'No elevations yet. Add one above.' })
  ]);
}

export async function renderVisit({ mount, navigate }, jobId) {
  const ownerId = await localAccount();
  const [job, services, modifiers, siteFactors, flags, flagMap, settings, pricingRules] = await Promise.all([
    api.getJob(jobId), api.listServices(), api.listModifiers(), api.listSiteFactors(),
    api.listInspectionFlags(), api.listServiceFlagMap(), api.getSettings(), api.listPricingRules()
  ]);
  const reviewUrl = settings.company?.google_review_url || null;

  const refs = { services, modifiers, siteFactors, flags, flagMap, pricingRules, sections: [] };
  const measurementsPanel = createMeasurementsPanel({
    job, refs, onChange: reload,
    createMeasurementFn: async (jobId, measurement) => {
      const { queued, result } = await offlineQueue.callOrQueue(
        'createMeasurement', { jobId, measurement }, 'Add measurement', { ownerId });
      queueToast(queued, 'Measurement added');
      return queued ? null : result;
    }
  });
  const quotePanel = createQuotePanel({
    job, onChange: reload,
    saveSignatureFn: async (jobId, quoteId, pngBlob, signerName) =>
      offlineQueue.callOrQueue('saveSignature', { jobId, quoteId, pngBlob, signerName }, 'Customer signature', { ownerId })
  });
  measurementsPanel.guardActions(quotePanel.root, { allowQuoteDelivery: true });
  const photosPanel = createPhotosPanel({
    jobId: job.id,
    retainOriginals: true, ownerId,
    pendingPhotosFn: offlineQueue.pendingPhotos,
    uploadFn: async (jobId, file, opts) => {
      const { queued, result } = await offlineQueue.callOrQueue('uploadJobPhoto', { jobId, file, opts }, 'Photo upload', { ownerId });
      queueToast(queued, 'Photo added');
      return { queued, result };
    }
  });

  const sectionsHost = el('div', {});
  const passportHost = el('div', {});
  let passportView;
  const checklistHost = el('div', {});

  const statusSelect = select(
    JOB_STATUSES.filter(s => s !== 'completed' || job.status === 'completed').map(s => ({ value: s, label: humanise(s) })), job.status,
    async (e) => {
      const control = e.target;
      const before = job.status;
      if (control.value === 'completed') { control.value = before; return toast('Use reviewed completion and server evidence acceptance.', 'error'); }
      await trySave(
        async () => {
          await api.updateJob(job.id, { status: control.value });
          job.status = control.value;
        },
        { revert: () => { control.value = before; }, success: 'Status updated' }
      );
    }
  );

  // Completion is a reviewed, versioned outbox request; only its server
  // receipt establishes acceptance. No direct status/completeJob bypass.
  const completionPanel = createFieldCompletion({ jobId: job.id, ownerId,
    beforeReview: () => measurementsPanel.flush(),
    onAccepted: receipt => {
      Object.assign(job, { status: receipt.job.status, completed_at: receipt.job.completed_at, lock_version: receipt.job.lock_version });
      if (receipt.job.status === 'completed' && !statusSelect.querySelector('option[value="completed"]'))
        statusSelect.append(el('option', {value:'completed',text:'Completed — accepted by server',disabled:true}));
      statusSelect.value = receipt.job.status;
      paintCompletion();
    } });
  const completeBtn = el('button', { class: 'btn btn--primary', text: 'Review completion' });
  const completeHint = el('p', { class: 'hint', style: 'margin:6px 0 0' });

  function paintCompletion() {
    const done = !!job.completed_at;
    completeBtn.disabled = done;
    completeBtn.textContent = done ? 'Job Complete' : 'Review completion';
    completeHint.textContent = done
      ? `Completed ${new Date(job.completed_at).toLocaleString('en-CA')}`
      : 'Review evidence and usage. Finished work is provisional until the server accepts it.';
  }

  completeBtn.addEventListener('click', async () => {
    if (job.completed_at) return;
    completionPanel.root.scrollIntoView({block:'start'});
    await completionPanel.openReview();
  });

  /* Notes from the field. job_notes has existed since the core schema and
     nothing in either console could write it, so what a tech observed only
     ever reached the office by phone. Deliberately not offline-queueable:
     the outbox covers four write types by design (see offline-queue.js), and
     silently queuing a fifth would overstate what it guarantees. */
  const noteBody = el('textarea', { placeholder: 'What you saw, what you did, what to tell the office…',
                                    'aria-label': 'Note' });
  const noteVisibility = select(
    [{ value: 'internal', label: 'Internal — staff only' },
     { value: 'customer', label: 'Customer-visible' }],
    'internal', null, { 'aria-label': 'Who can see it' }
  );
  const noteBtn = el('button', { class: 'btn', text: 'Save note' });
  const notesList = el('div', {});
  const notesStatus = el('div', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true',
    dataset: { notesStatus: '' } });
  let notesAttempt = 0;
  const draftStatus = el('p', { class: 'hint', role: 'status' });
  const dictationHost = el('div', {});
  let clearNoteDraft;

  noteBtn.addEventListener('click', async () => {
    const text = noteBody.value.trim();
    if (!text) return toast('Write the note first', 'error');
    noteBtn.disabled = true;
    noteBtn.textContent = 'Saving…';
    const ok = await trySave(
      () => api.addNote(job.id, text, noteVisibility.value),
      { success: 'Note saved' }
    );
    if (ok) {
      if (noteBody.value.trim() === text) { noteBody.value = ''; await clearNoteDraft?.(); draftStatus.textContent = ''; }
      await refreshNotes();
    }
    noteBtn.disabled = false;
    noteBtn.textContent = 'Save note';
  });

  async function refreshNotes() {
    const attempt = ++notesAttempt;
    const retryFocused = notesStatus.contains(document.activeElement);
    clear(notesStatus).append(el('p', { class: 'hint', text: 'Loading notes…' }));
    try {
      const notes = await api.listNotes(job.id);
      if (attempt !== notesAttempt || !notesList.isConnected) return;
      clear(notesStatus);
      if (retryFocused && document.activeElement === document.body) noteBody.focus();
      clear(notesList).append(
        notes.length
          ? el('div', {}, notes.map(n => el('div', { class: 'section-box' }, [
              el('span', {
                class: `badge ${n.visibility === 'customer' ? 'badge--warn' : 'badge--muted'}`,
                text: n.visibility === 'customer' ? 'Customer-visible' : 'Internal'
              }),
              el('p', { style: 'margin:8px 0 0;white-space:pre-wrap', text: n.body })
            ])))
          : el('div', { class: 'empty', text: 'No notes on this job yet.' })
      );
    } catch (err) {
      if (attempt !== notesAttempt || !notesList.isConnected) return;
      clear(notesStatus).append(
        el('p', { class: 'error-text', text: `Could not load notes: ${readError(err)}` }),
        el('button', { class: 'btn btn--sm', text: 'Retry notes', onClick: () => refreshNotes() })
      );
      if (retryFocused && document.activeElement === document.body) notesStatus.querySelector('button')?.focus();
    }
  }

  // Refresh the loaded visit after writes. Failed refreshes keep its controls
  // and explicitly label the last successful data. This is not a persistent
  // read cache: opening another visit or restarting still needs a connection.
  let lastMeasurements = [];
  let lastPricing = null;
  let lastQuotes = [];
  let hasVisitData = false;
  const refreshStatus = el('div', { role: 'status' });

  function showRefreshError(err) {
    toast(`Could not refresh visit data — showing last loaded data. ${readError(err)}`, 'error');
    clear(refreshStatus).append(el('div', { class: 'warn' }, [
      el('strong', { text: 'Could not refresh visit data' }),
      el('p', { text: 'Showing the last loaded measurements, pricing and quotes. ' + readError(err) }),
      el('button', { class: 'btn btn--sm', text: 'Retry visit data', onClick: async () => {
        if (await measurementsPanel.flush()) await reload();
      } })
    ]));
  }

  async function reload({ initial = false } = {}) {
    const retryFocused = refreshStatus.contains(document.activeElement);
    const refresh = measurementsPanel.refreshToken();
    clear(refreshStatus).append(el('p', { class: 'hint', text: 'Loading visit data…' }));
    let sections = refs.sections, measurements = lastMeasurements, pricing = lastPricing, quotes = lastQuotes;
    try {
      const [fresh, freshSections, freshMeasurements, jobFlags, freshPricing, freshQuotes] = await Promise.all([
        api.getJob(job.id), api.listSections(job.id), api.listMeasurements(job.id),
        api.listJobFlags(job.id), api.calculatePricing(job.id), api.listQuotes(job.id)
      ]);
      if (!measurementsPanel.isCurrent(refresh)) return;
      job.status = fresh.status;
      job.completed_at = fresh.completed_at;
      job.lock_version = fresh.lock_version;
      paintCompletion();
      Object.assign(job.properties, fresh.properties);
      if (statusSelect.value !== fresh.status) statusSelect.value = fresh.status;
      sections = freshSections; measurements = freshMeasurements; pricing = freshPricing; quotes = freshQuotes;
      refs.sections = sections;
      lastMeasurements = measurements; lastPricing = pricing; lastQuotes = quotes;
      hasVisitData = true;
    } catch (err) {
      if (!measurementsPanel.isCurrent(refresh)) return;
      // Initial reads have no snapshot to fall back to. Later failures keep
      // the existing controls and drafts, and explicitly label stale data.
      // A permission failure is an error too; never call it an offline save.
      if (initial || !hasVisitData) throw err;
      showRefreshError(err);
      if (retryFocused && document.activeElement === document.body) refreshStatus.querySelector('button')?.focus();
      return;
    }

    if (!measurementsPanel.isCurrent(refresh)) return;
    clear(refreshStatus);
    if (retryFocused && document.activeElement === document.body) statusSelect.focus();
    clear(sectionsHost).append(sectionsPanel(job, refs, reload));
    // Do not replace an editable passport after an unrelated refresh or a
    // slow save: the tech may already be typing their next change.
    if (!passportView || (!passportView.hasDraft() && offlineQueue.syncState().count === 0)) {
      passportView = passportPanel(job.properties, reload, job.id, ownerId);
      clear(passportHost).append(passportView.root);
    }
    clear(checklistHost).append(checklistPanel(job.properties, job.id, ownerId));
    measurementsPanel.render({ measurements, pricing });
    quotePanel.render({ quotes });
    try {
      // photosPanel.render() does its own live fetch (listAttachments) --
      // field-photos.js already skips calling it after ITS OWN queued
      // upload, but reload() can also be triggered by a different panel's
      // offline save (e.g. the passport), so the same guard is needed here.
      await photosPanel.render();
    } catch (err) {
      if (!measurementsPanel.isCurrent(refresh)) return;
      if (initial && !offlineQueue.looksOffline(err)) throw err;
      showRefreshError(err);
    }
  }

  const phone = job.customers?.phone;
  const address = [job.properties?.address_line1, job.properties?.city, job.properties?.postal_code]
    .filter(Boolean).join(', ');

  // Today's Schedule geofence banner needs properties.latitude/longitude to
  // compare against -- almost never set today (nothing has ever written
  // it), so without this the feature stays permanently inert. One tap,
  // standing at the property right now, fixes that going forward; no
  // separate "edit coordinates" form, since a GPS fix taken on-site is more
  // trustworthy than anything a form could ask someone to type in.
  const hasPin = job.properties?.latitude != null && job.properties?.longitude != null;
  const pinBtn = el('button', {
    class: 'btn btn--sm', type: 'button', text: hasPin ? '📍 Update Location Pin' : '📍 Save Location Pin',
    onClick: async () => {
      let nextText = pinBtn.textContent;
      pinBtn.disabled = true;
      pinBtn.textContent = 'Locating…';
      try {
        const pos = await getDevicePosition();
        if (!pos) { toast('Could not get the device location', 'error'); return; }
        const { queued } = await offlineQueue.callOrQueue('updateProperty',
          { id: job.properties.id, patch: { latitude: pos.latitude, longitude: pos.longitude } },
          'Save property location', { jobId: job.id, ownerId });
        job.properties.latitude = pos.latitude;
        job.properties.longitude = pos.longitude;
        nextText = '📍 Update Location Pin';
        queueToast(queued, 'Location pin saved — today’s schedule can now detect arrival here');
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        pinBtn.disabled = false;
        pinBtn.textContent = nextText;
      }
    }
  });

  clear(mount).append(
    el('div', { class: 'page-head', style: 'padding:0 0 10px' }, [
      el('a', { href: '#/', text: '← Today’s schedule', class: 'hint' }),
      el('h1', { text: job.customers?.name || 'Visit' }),
      el('p', { text: address || 'No address on file' })
    ]),
    el('div', { class: 'card' }, [
      el('div', { class: 'grid grid--2' }, [
        el('label', { class: 'field', style: 'margin:0' }, [el('span', { text: 'Status' }), statusSelect]),
        el('div', { class: 'field', style: 'margin:0' }, [
          el('span', { text: 'Completion' }),
          el('div', { class: 'btn-row' }, [completeBtn]),
          completeHint
        ])
      ]),
      el('div', { class: 'btn-row', style: 'margin-top:10px' }, [
        address ? el('a', { class: 'btn', target: '_blank', rel: 'noopener',
          href: `https://maps.google.com/?q=${encodeURIComponent(address)}`, text: 'Navigate' }) : null,
        pinBtn,
        phone ? el('a', { class: 'btn', href: `tel:${phone}`, text: 'Call' }) : null,
        phone ? el('a', { class: 'btn', href: `sms:${phone}`, text: 'Text' }) : null,
        phone ? el('a', {
          class: 'btn btn--sm', href: reviewRequestLink(phone, job.customers?.name, reviewUrl),
          text: 'Request Review'
        }) : null,
        el('a', {
          class: 'btn btn--sm',
          // target=_blank's new-tab behaviour has nothing to land in inside
          // a native WebView (no tab strip) -- native navigates the same
          // window instead; the page itself has its own native-aware Share
          // Report button once it loads (completion-report.js).
          ...(isNative() ? {} : { target: '_blank', rel: 'noopener' }),
          href: `completion-report.html?job_id=${job.id}`, text: 'Generate Completion Report'
        })
      ]),
      !reviewUrl ? el('p', { class: 'hint', style: 'margin-top:6px',
        text: 'No Google review link on file yet — add one under app_settings.company.google_review_url ' +
              'to include it automatically.' }) : null
    ]),
    refreshStatus,
    passportHost,
    checklistHost,
    sectionsHost,
    measurementsPanel.root,
    el('div', { class: 'card' }, [quotePanel.root]),
    photosPanel.root,
    completionPanel.root,
    el('div', { class: 'card' }, [
      el('div', { class: 'card__head' }, [
        el('div', {}, [
          el('h2', { text: 'Notes' }),
          el('p', { text: 'Needs a connection — notes are not part of the offline outbox.' })
        ])
      ]),
      el('label', { class: 'field' }, [el('span', { text: 'New note' }), noteBody]),
      el('label', { class: 'field' }, [el('span', { text: 'Who can see it' }), noteVisibility]),
      el('div', { class: 'btn-row', style: 'margin-bottom:12px' }, [noteBtn]),
      draftStatus, dictationHost, notesStatus, notesList
    ])
  );

  paintCompletion();
  completionPanel.start();
  await reload({ initial: true });
  await refreshNotes();
  try {
    clearNoteDraft = await retainNoteDraft(job.id, noteBody, noteVisibility, draftStatus);
    const dictation = createDictationReview({ jobId: job.id, ownerId, target: noteBody,
      visibility: noteVisibility, flushDraft: clearNoteDraft.flush });
    dictationHost.append(dictation.root); await dictation.ready;
  }
  catch (error) { draftStatus.textContent = `Device draft storage unavailable: ${error.message}`; }
}
