import * as api from '../lib/api.js';
import { el, clear, toast, select, confirmAction } from '../../../shared/dom.js';
import { isNative, takeNativePhoto, persistPhotoLocally } from '../lib/native.js';
import { openPhotoMarkup } from '../components/photo-markup.js';
import { localAccount } from '../lib/field-identity.js';
import { saveOriginal, savedCaptures, updateCapture, removeCapture, observeReviewLocation } from '../lib/field-captures.js';
import { photoIsFrozen } from '../lib/field-completion-api.js';

const TAGS = [
  { value: 'before',      label: 'Before' },
  { value: 'after',       label: 'After' },
  { value: 'damage',      label: 'Damage / Issue' },
  { value: 'measurement', label: 'Measurement / Scope' },
  { value: 'site_photo',  label: 'General' }
];

/** Photo documentation for a job. Private by default (customer_visible
 *  defaults false on the row; nothing in the customer-facing quote page
 *  reads job_attachments at all, so there is no path for one of these to
 *  reach a customer until that is deliberately built) -- a photo can be
 *  marked for inclusion in a customer report, but that is a flag on the
 *  record, not a delivery mechanism yet. */
export function createPhotosPanel({ jobId, uploadFn, pendingPhotosFn, listPhotosFn, offline = false, retainOriginals = false, ownerId }) {
  const root = el('div', { class: 'card' });
  // Desktop uploads directly (always online). The field console passes a
  // wrapped version that goes through its offline outbox instead -- it
  // returns true when the upload was queued rather than completed, so the
  // list below is skipped (there is nothing new to show yet) instead of
  // silently re-rendering as if nothing happened.
  const upload = uploadFn || (async (jid, file, opts) => {
    await api.uploadJobPhoto(jid, file, opts); toast('Photo added'); return false;
  });

  let pendingTag = 'site_photo';
  let pendingElevation = '';
  let lastPhotos = [];
  let renderAttempt = 0;
  let previews = [];
  let capturing = false;
  let takingPhoto = false;
  const cleanup = new MutationObserver(() => {
    if (!root.isConnected) { previews.forEach(URL.revokeObjectURL); previews = []; cleanup.disconnect(); }
  });

  const fileInput = el('input', {
    type: 'file', accept: 'image/*', capture: 'environment', style: 'display:none'
  });

  // Shared tail end of both capture paths (native camera and the web file
  // input): offer the markup pass, then feed the result into the same
  // upload/offline-queue call that was already here.
  async function commitPhoto(file, existing = null) {
    if (capturing) return;
    capturing = true;
    try {
      const selectedOwner = retainOriginals ? ownerId : await localAccount();
      if (!root.isConnected || await localAccount() !== selectedOwner) throw new Error('Account changed. Reopen the visit.');
      const opts = existing?.opts || { kind: pendingTag, elevationTag: pendingElevation.trim() || undefined };
      let capture = retainOriginals ? existing || await saveOriginal(jobId, file, opts, selectedOwner,
        isNative() ? 'native_camera_output' : 'selected_file') : null;
      const marked = await openPhotoMarkup(file, { cancelOnDismiss: retainOriginals, current: () => root.isConnected });
      if (!marked) {
        if (root.isConnected) { await render({ localOnly: true }); root.querySelector('summary')?.focus(); }
        return;
      }
      if (!root.isConnected || await localAccount() !== selectedOwner) throw new Error('Account changed. Original stays with its account.');
      if (capture) {
        // Persist uncertainty before any queue/network call. An interrupted
        // send cannot be resumed as a fresh upload. Claim and prepared bytes
        // commit together, so competing tabs cannot replace the sent copy.
        await updateCapture(capture.id, { prepared: marked === file ? null : marked, stage: 'submitting' }, selectedOwner);
      }
      let queued;
      let uploadResult;
      try {
        uploadResult = await upload(jobId, marked, opts);
        queued = typeof uploadResult === 'object' ? uploadResult.queued : uploadResult;
      } catch (error) {
        if (capture) await updateCapture(capture.id, { stage: 'needs-review' }, selectedOwner);
        throw error;
      }
      if (capture) await updateCapture(capture.id, { stage: queued ? 'queued' : 'uploaded',
        metadata: { ...capture.metadata, ...(uploadResult?.result?.id ? { uploadedAttachmentId: uploadResult.result.id } : {}) } }, selectedOwner);
      await render({ localOnly: queued });
      if (root.isConnected) root.querySelector('[data-add-photo]')?.focus();
    } catch (err) {
      toast(err.message, 'error');
      if (root.isConnected) await render({ localOnly: true }).catch(() => {});
    } finally { capturing = false; }
  }

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    await commitPhoto(file);
  });

  // Native: <input capture> opens a bare OS camera view with no way back
  // into this component's own flow, so native bypasses the file input
  // entirely and calls the Camera plugin directly, which hands back a real
  // File the same as the input's change event would have.
  async function addPhoto() {
    if (capturing || takingPhoto) return toast('Finish the current photo first.');
    if (!isNative()) { fileInput.click(); return; }
    takingPhoto = true;
    try {
      const owner = await localAccount();
      const file = await takeNativePhoto();
      if (!file) return; // cancelled from the native camera UI
      if (await localAccount() !== owner) return toast('Account changed during capture. Reopen the visit.', 'error');
      await persistPhotoLocally(file, owner); // best-effort backup; outbox commit is the saved guarantee
      await commitPhoto(file);
    } catch (error) { toast(error.message, 'error'); }
    finally { takingPhoto = false; }
  }

  function tagLabel(kind) {
    return TAGS.find(t => t.value === kind)?.label || kind;
  }

  function photoTile(photo) {
    const tile = el('div', { class: 'photo-grid__tile' });
    tile.append(el('span', { class: 'hint', style: 'display:flex;align-items:center;justify-content:center;height:100%;font-size:.7rem', text: '…' }));

    if (offline) {
      clear(tile).append(el('span', { class: 'hint', text: 'Server photo — preview needs a connection' }));
      return tile;
    }
    tile.setAttribute('role', 'button');
    tile.setAttribute('aria-label', `Review removal of ${photo.caption || tagLabel(photo.kind)} photo`);
    tile.tabIndex = 0;
    tile.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); tile.click(); }
    });
    api.signedPhotoUrl(photo.storage_path, 900, 'job-photos').then(url => {
      clear(tile).append(
        el('img', { src: url, alt: photo.caption || tagLabel(photo.kind) }),
        el('span', { class: 'photo-grid__tag',
          text: photo.elevation_tag ? `${tagLabel(photo.kind)} · ${photo.elevation_tag}` : tagLabel(photo.kind) })
      );
    }).catch(() => {
      clear(tile).append(el('span', { class: 'hint',
        style: 'display:flex;align-items:center;justify-content:center;height:100%;text-align:center;font-size:.72rem;padding:4px',
        text: 'Preview unavailable' }));
    });

    tile.addEventListener('click', async () => {
      if (!confirmAction('Remove this photo?')) return;
      try {
        if (retainOriginals && await photoIsFrozen(photo.id)) throw new Error('This photo is locked by an accepted completion. Ask the owner for a reasoned correction.');
        if (retainOriginals && await localAccount() !== ownerId) throw new Error('Account changed. Reopen the visit.');
        await api.deleteAttachment(photo.id);
        await render();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    return tile;
  }

  async function render({ localOnly = false } = {}) {
    const attempt = ++renderAttempt;
    const photos = localOnly ? lastPhotos : await (listPhotosFn || api.listAttachments)(jobId);
    const localPhotos = pendingPhotosFn ? await pendingPhotosFn(jobId) : [];
    let originals = [], originalError = null;
    if (retainOriginals) {
      try { originals = await savedCaptures(jobId, ownerId); }
      catch (error) { originalError = error.message; }
    }
    if (attempt !== renderAttempt) return;
    lastPhotos = photos;
    previews.forEach(URL.revokeObjectURL); previews = [];
    cleanup.observe(document.body, { childList: true, subtree: true });
    // request-photos (customer uploads) and job-photos (staff-captured) both
    // write to job_attachments -- only the ones this panel itself can
    // manage (job-photos, i.e. not a raw customer_upload) are shown here as
    // deletable staff photos; customer uploads stay in the existing
    // "Photos" card on the desktop job view.
    const staffPhotos = photos.filter(p => p.kind !== 'customer_upload');

    const tagSelect = select(TAGS, pendingTag, (e) => { pendingTag = e.target.value; }, { 'aria-label': 'Tag' });
    const elevationInput = el('input', {
      placeholder: 'Elevation, e.g. "North Rear" (optional)',
      onChange: (e) => { pendingElevation = e.target.value; }
    });
    elevationInput.value = pendingElevation;

    // Element.append() stringifies a bare null/undefined argument into the
    // literal text "null" -- harmless-looking in review, visible as soon as
    // there are zero photos, so the empty-grid branch is filtered out
    // rather than passed straight through.
    clear(root).append(...[
      el('div', { class: 'card__head' }, [
        el('div', {}, [
          el('h2', { text: 'Photos' }),
          el('p', { text: staffPhotos.length ? `${staffPhotos.length} attached` : 'None yet — tap to add one.' })
        ])
      ]),
      el('div', { class: 'grid grid--2' }, [
        el('label', { class: 'field', style: 'margin:0' }, [el('span', { text: 'Tag' }), tagSelect]),
        el('label', { class: 'field', style: 'margin:0' }, [el('span', { text: 'Elevation' }), elevationInput])
      ]),
      el('div', { class: 'btn-row', style: 'margin-top:10px' }, [
        el('button', { class: 'btn btn--primary', text: '+ Add photo', dataset: { addPhoto: '' }, onClick: addPhoto }),
        fileInput
      ]),
      staffPhotos.length
        ? el('div', { class: 'photo-grid', style: 'margin-top:12px' }, staffPhotos.map(photoTile))
        : null,
      localPhotos.length ? el('div', { class: 'photo-grid', style: 'margin-top:12px' }, localPhotos.map(photo => {
        const url = URL.createObjectURL(photo.file); previews.push(url);
        const tile = el('div', { class: 'photo-grid__tile' });
        tile.append(
          el('img', { src: url, alt: `Saved locally: ${tagLabel(photo.opts?.kind)}`, onError: event => {
            event.target.remove();
            tile.prepend(el('span', { class: 'hint', style: 'display:block;padding:8px;font-size:.7rem',
              text: 'Preview unavailable — photo bytes retained' }));
          } }),
          el('span', { class: 'photo-grid__tag', text: 'Saved here — not synced' })
        );
        return tile;
      })) : null,
      originalError ? el('p', { class: 'error-text', role: 'status', text: `Original photo storage unavailable: ${originalError}` }) : null,
      retainOriginals && originals.length ? originalsView(originals) : null,
      el('p', { class: 'hint', style: 'margin-top:10px',
        text: 'Private to staff by default. Tap a photo to remove it.' })
    ].filter(Boolean));
  }

  function originalsView(originals) {
    const details = el('details', { style: 'margin-top:12px' });
    details.append(el('summary', { style: 'min-height:44px;padding:10px 0;cursor:pointer',
      text: `Saved originals on this device (${originals.length})` }),
      el('p', { class: 'hint', text: 'Unmodified selected image bytes are kept here. Capture time and photo location are unknown unless established separately. Removing a local original does not remove its upload or outbox action.' }));
    for (const capture of originals) {
      const url = URL.createObjectURL(capture.original); previews.push(url);
      const location = capture.metadata.reviewLocation;
      const locationText = location.state === 'device_reported'
        ? `${location.latitude.toFixed(5)}, ${location.longitude.toFixed(5)}${location.accuracyM == null ? '' : ` (±${Math.round(location.accuracyM)} m)`}`
        : location.state.replaceAll('_', ' ');
      const unfinished = ['original', 'prepared'].includes(capture.stage);
      const stageText = unfinished ? 'Unsubmitted original — resume when ready.'
        : capture.stage === 'uploaded' ? 'Upload returned successfully. Original retained locally.'
        : capture.stage === 'queued' ? 'Submitted through the outbox. Check the sync badge for current delivery.'
        : 'Submission needs review. Check the saved outbox before retrying; no automatic second upload.';
      const recordLocation = el('button', { type: 'button', class: 'btn', text: 'Record location at review', onClick: async () => {
        recordLocation.disabled = true; recordLocation.setAttribute('aria-busy', 'true');
        try {
          const reviewLocation = await observeReviewLocation();
          if (!root.isConnected || await localAccount() !== ownerId) return;
          await updateCapture(capture.id, { metadata: { ...capture.metadata, reviewLocation } }, ownerId);
          await render({ localOnly: true });
        } catch (error) { toast(error.message, 'error'); }
        finally { recordLocation.disabled = false; recordLocation.removeAttribute('aria-busy'); }
      } });
      details.append(el('div', { class: 'section-box', style: 'overflow-wrap:anywhere;margin-top:12px' }, [
        el('strong', { text: capture.metadata.originalName }),
        el('div', { style: 'position:relative;margin:8px 0' }, [
          el('img', { src: url, alt: `Unmodified original: ${tagLabel(capture.opts.kind)}`,
            style: 'display:block;max-width:100%;max-height:220px;object-fit:contain',
            onError: event => { event.target.remove(); } }),
          el('p', { class: 'hint', style: 'margin:4px 0;overflow-wrap:anywhere', text:
            `Device selection: ${new Date(capture.metadata.selectedAt).toLocaleString()}. Capture time: unknown. Capture location: unknown. Location at review: ${locationText}.` })
        ]),
        el('p', { class: 'hint', text: stageText }),
        el('div', { class: 'btn-row', style: 'flex-wrap:wrap' }, [
          ...(unfinished ? [el('button', { type: 'button', class: 'btn', text: 'Resume saved photo',
            onClick: () => commitPhoto(capture.original, capture) })] : []),
          recordLocation,
          el('button', { type: 'button', class: 'btn', text: 'Remove local original', disabled: capture.stage === 'submitting' && capturing, onClick: async () => {
            if (!confirmAction('Remove the local original and its prepared copy? Uploads and queued actions stay unchanged.')) return;
            try { await removeCapture(capture.id, ownerId); await render({ localOnly: true }); }
            catch (error) { toast(error.message, 'error'); }
          } })
        ])
      ]));
    }
    return details;
  }

  return { root, render };
}
