import { el, clear, select, toast } from '../../../shared/dom.js';
import { humanise } from '../../../shared/format.js';
import { passportPanel, checklistPanel } from './field-workspace.js';
import { createPhotosPanel } from './field-photos.js';
import { createDictationReview } from '../components/field-dictation.js';
import { retainNoteDraft } from '../lib/field-cache.js';
import * as queue from '../lib/offline-queue.js';
import { createFieldCompletion } from '../components/field-completion.js';

export async function renderOfflineWork({ mount, navigate, retry }, snapshot, jobId) {
  const banner = el('div', { class: 'warn', role: 'status' }, [
    el('strong', { text: 'Showing saved work — not current server data' }),
    el('p', { text: `Saved ${new Date(snapshot.savedAt).toLocaleString()}. Access must be checked again within 24 hours. ` +
      'Reconnect to check assignment, send notes, change status or calculate prices. Maps need a connection.' }),
    el('p', { text: snapshot.refsAvailable
      ? `Reference data saved ${new Date(snapshot.refsSavedAt).toLocaleString()}; usable for seven days. Prices require the server.`
      : 'Reference data expired or unavailable. Reconnect to refresh before adding measurements.' }),
    el('button', { class: 'btn', text: 'Retry connection', onClick: retry })
  ]);
  clear(mount).append(banner);
  if (!jobId) {
    mount.append(el('h1', { text: 'Saved schedule' }),
      ...Object.values(snapshot.jobs).map(({ job }) => el('div', { class: 'card' }, [
        el('h2', { text: job.customers?.name || 'Visit' }),
        el('p', { text: [job.properties?.address_line1, job.properties?.city].filter(Boolean).join(', ') }),
        el('p', { text: job.scheduled_for ? new Date(job.scheduled_for).toLocaleString() : 'Schedule not recorded' }),
        el('button', { class: 'btn btn--primary', text: 'Open saved visit', onClick: () => navigate(`/visit/${job.id}`) })
      ])));
    return;
  }
  const data = snapshot.jobs[jobId];
  if (!data) {
    mount.append(el('h1', { text: 'Visit not saved on this device' }), el('p', { text: 'Reconnect to load this visit.' }));
    return;
  }
  const job = structuredClone(data.job);
  // Overlay queued property patches so a restart does not hide saved facts.
  const patches = await queue.propertyPatches(jobId);
  for (const patch of patches) Object.assign(job.properties, patch);
  mount.append(el('a', { href: '#/', text: '← Saved schedule' }),
    el('h1', { text: job.customers?.name || 'Visit' }),
    el('p', { text: [job.properties?.address_line1, job.properties?.city, job.properties?.postal_code].filter(Boolean).join(', ') }),
    ...(job.customers?.phone ? [el('div', { class: 'btn-row' }, [
      el('a', { class: 'btn', href: `tel:${job.customers.phone}`, text: 'Call' }),
      el('a', { class: 'btn', href: `sms:${job.customers.phone}`, text: 'Text' })])] : []),
    el('p', { class: 'hint', text: `Saved status: ${humanise(job.status)}. Server-accepted completion needs a connection; reviewed finish declarations can be saved provisionally.` }),
    passportPanel(job.properties, null, jobId, snapshot.id).root, checklistPanel(job.properties, jobId, snapshot.id));

  const measurements = el('div', { class: 'card' }, [el('h2', { text: 'Saved measurements' }),
    ...data.measurements.map(row => el('p', { text: `${row.label || 'Measurement'}: ${row.quantity} ${humanise(row.unit)}` }))]);
  for (const row of await queue.pendingMeasurements(jobId)) {
    measurements.append(el('p', { class: 'hint', text: `${row.quantity} ${humanise(row.unit)} — saved here, awaiting sync` }));
  }
  const services = snapshot.refs.services.filter(service => service.quotable !== false);
  const service = select(services.map(row => ({ value: row.id, label: row.name })), services[0]?.id || '');
  const quantity = el('input', { type: 'number', min: '0', step: 'any', 'aria-label': 'New measurement quantity' });
  const savedStatus = el('p', { class: 'hint', role: 'status' });
  const add = el('button', { class: 'btn', text: 'Save new measurement locally', onClick: async () => {
    const amount = Number(quantity.value);
    if (!quantity.value || !Number.isFinite(amount) || amount <= 0) return toast('Enter a positive quantity.', 'error');
    add.disabled = true;
    try {
      const selected = services.find(row => row.id === service.value);
      if (!selected) throw new Error('Choose a saved service.');
      await queue.callOrQueue('createMeasurement', { jobId, measurement: {
        service_id: selected.id, quantity: amount, unit: selected.unit
      } }, 'Add measurement', { ownerId: snapshot.id });
      quantity.value = '';
      measurements.append(el('p', { class: 'hint', text: `${amount} ${humanise(selected.unit)} — saved here, awaiting sync` }));
      savedStatus.textContent = 'Measurement saved on this device. Pricing requires a connection.';
    } catch (error) { savedStatus.textContent = `Measurement not saved: ${error.message}`; }
    finally { add.disabled = false; }
  } });
  measurements.append(el('label', { class: 'field' }, [el('span', { text: 'Service' }), service]),
    el('label', { class: 'field' }, [el('span', { text: 'New measurement quantity' }), quantity]), add, savedStatus);
  if (!snapshot.refsAvailable) { service.disabled = true; quantity.disabled = true; add.disabled = true; }
  mount.append(measurements);
  if (data.flags?.length) mount.append(el('div', { class: 'card' }, [
    el('h2', { text: 'Saved inspection flags' }),
    ...data.flags.map(flag => el('p', { text: [
      snapshot.refs.flags?.find(row => row.id === flag.flag_id)?.name || 'Saved flag', flag.note
    ].filter(Boolean).join(': ') })),
    el('p', { class: 'hint', text: 'Read-only saved observations. Updating flags requires a connection.' })
  ]));

  const photos = createPhotosPanel({ jobId, listPhotosFn: async () => data.attachments,
    retainOriginals: true, ownerId: snapshot.id,
    offline: true, pendingPhotosFn: queue.pendingPhotos,
    uploadFn: async (id, file, opts) => {
      await queue.callOrQueue('uploadJobPhoto', { jobId: id, file, opts }, 'Photo upload', { ownerId: snapshot.id });
      toast('Photo saved on this device — waiting to sync.'); return true;
    } });
  mount.append(photos.root);
  await photos.render();
  const completion = createFieldCompletion({jobId,ownerId:snapshot.id,offline:true});
  mount.append(completion.root);completion.start();
  const input = el('textarea', { 'aria-label': 'Note', placeholder: 'Draft a note for the office…' });
  const visibility = select([{ value: 'internal', label: 'Internal — staff only' },
    { value: 'customer', label: 'Customer-visible' }], 'internal', null, { 'aria-label': 'Who can see it' });
  const draftStatus = el('p', { class: 'hint', role: 'status' });
  const dictationHost = el('div', {});
  mount.append(el('div', { class: 'card' }, [el('h2', { text: 'Notes' }),
    el('p', { text: 'You can keep a draft here. Sending a note requires a connection.' }),
    ...data.notes.map(note => el('div', { class: 'section-box' }, [
      el('span', { class: 'badge', text: note.visibility === 'customer' ? 'Customer-visible' : 'Internal' }),
      el('p', { text: note.body })])),
    el('label', { class: 'field' }, [el('span', { text: 'Note draft' }), input]),
    el('label', { class: 'field' }, [el('span', { text: 'Who can see it' }), visibility]), draftStatus, dictationHost]));
  const noteDraft = await retainNoteDraft(jobId, input, visibility, draftStatus);
  const dictation = createDictationReview({ jobId, ownerId: snapshot.id, target: input,
    visibility, flushDraft: noteDraft.flush });
  dictationHost.append(dictation.root); await dictation.ready;
  // Cached quotes are references, not a currently valid offer. Existing
  // captured signatures stay in the outbox; fresh offline acceptance is not
  // offered against a potentially revised/revoked quote.
  mount.append(el('div', { class: 'card' }, [el('h2', { text: 'Saved quote references' }),
    ...data.quotes.map(quote => el('p', { text: `Version ${quote.version}: ${humanise(quote.status)}` })),
    el('p', { class: 'hint', text: 'Reconnect to review current prices, accept a quote or capture a new signature. Previously saved signatures remain in the outbox.' })]));
}
