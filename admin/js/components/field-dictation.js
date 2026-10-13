import { el } from '../../../shared/dom.js';
import { localAccount } from '../lib/field-identity.js';
import { readDraft, writeDraft, deleteDraft, LOCAL_DRAFT_FLUSH } from '../lib/field-cache.js';

// Speech changes only a local review buffer. It cannot call addNote/save/queue.
export function createDictationReview({ jobId, ownerId, target, visibility, flushDraft }) {
  const root = el('div', { class: 'section-box' });
  const status = el('p', { class: 'hint', role: 'status', 'aria-live': 'polite' });
  const preview = el('textarea', { 'aria-label': 'Dictation review', placeholder: 'Review or type the words here…' });
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  let recognition = null;
  let generation = 0;
  let listening = false;
  let stopping = false;
  let writing = Promise.resolve();
  let writeError = null;
  let revision = 0;
  let disposed = false;
  let applying = false;
  let speechError = null;
  let speechSequence = 0;
  root.dataset.localDraft = 'dictation';
  root[LOCAL_DRAFT_FLUSH] = async () => {
    await writing;
    if (writeError) throw writeError;
  };
  const start = el('button', { class: 'btn', type: 'button', text: 'Start dictation', disabled: !Recognition });
  const stop = el('button', { class: 'btn', type: 'button', text: 'Stop dictation', disabled: true });
  const apply = el('button', { class: 'btn', type: 'button', text: 'Add reviewed text to note', disabled: true });
  const discard = el('button', { class: 'btn', type: 'button', text: 'Clear dictation review' });
  const audience = el('p', { class: 'hint' });
  function paint() {
    start.disabled = !Recognition || listening || disposed;
    stop.disabled = !listening || stopping; preview.disabled = listening;
    apply.disabled = applying || listening || !preview.value.trim() || !!writeError;
    audience.textContent = visibility.value === 'customer'
      ? 'The note audience is Customer-visible. Check the words before adding them.'
      : 'The note audience is Internal — staff only.';
  }
  async function current() {
    return !disposed && root.isConnected && target.isConnected && await localAccount() === ownerId;
  }
  function persist() {
    const value = preview.value;
    revision++;
    writing = writing.catch(() => {}).then(async () => {
      await writeDraft(jobId, 'dictation-review', { text: value }, ownerId);
      writeError = null;
    }).catch(error => {
      writeError = error; status.textContent = `Review not saved on this device: ${error.message}`;
    }).then(paint);
    return writing;
  }
  function finish() {
    listening = false; stopping = false; paint();
    status.textContent = speechError || (writeError ? `Review not saved: ${writeError.message}` : 'Review the words. They have not been added or sent.');
  }
  function cancelRecognition() {
    generation++; const previous = recognition; recognition = null;
    try { previous?.abort(); } catch { /* Some engines have already ended. */ }
    listening = false; stopping = false; paint();
  }
  start.addEventListener('click', () => {
    if (listening || disposed) return;
    const token = ++generation;
    speechError = null;
    const baseline = preview.value.trim();
    let instance;
    try { instance = recognition = new Recognition(); }
    catch (error) { status.textContent = `Dictation unavailable: ${error.message}. You can type into the review instead.`; return; }
    instance.lang = document.documentElement.lang || 'en-CA';
    instance.continuous = true; instance.interimResults = true;
    instance.onresult = async event => {
      const sequence = ++speechSequence;
      const atRevision = revision;
      try {
        if (token !== generation || !await current()) return;
        const text = Array.from(event.results).map(result => result[0]?.transcript || '').join(' ').trim();
        if (token !== generation || disposed || sequence !== speechSequence || applying || !listening && revision !== atRevision) return;
        preview.value = [baseline, text].filter(Boolean).join('\n'); await persist();
      } catch (error) {
        if (token !== generation || disposed) return;
        cancelRecognition(); status.textContent = `Could not retain new speech: ${error.message}. Earlier review words remain.`;
      }
    };
    instance.onerror = event => {
      if (token !== generation) return;
      speechError = `Dictation stopped (${event.error || 'unavailable'}). Existing words remain for review.`; finish();
    };
    instance.onend = () => { if (token === generation) { recognition = null; finish(); } };
    listening = true; paint(); status.textContent = 'Listening. Nothing will be saved as a note until you review and choose it.';
    try { instance.start(); }
    catch (error) { cancelRecognition(); status.textContent = `Dictation unavailable: ${error.message}. You can type into the review instead.`; }
  });
  stop.addEventListener('click', () => {
    if (!recognition || stopping) return;
    stopping = true; paint();
    try { recognition.stop(); }
    catch (error) { cancelRecognition(); status.textContent = `Dictation could not finish: ${error.message}. Existing words remain.`; }
  });
  preview.addEventListener('input', () => { void persist(); paint(); });
  visibility.addEventListener('change', paint);
  apply.addEventListener('click', async () => {
    if (applying || listening) return;
    const text = preview.value.trim(); const atRevision = revision;
    applying = true; paint();
    try {
      await writing;
      if (writeError || !text || !await current()) return;
      // The user can type during an awaited storage check. Keep the new text;
      // never discard a more recent review or append the same buffer twice.
      if (revision !== atRevision) { paint(); return; }
      target.value = [target.value.trimEnd(), text].filter(Boolean).join('\n');
      target.dispatchEvent(new Event('input', { bubbles: true }));
      await flushDraft();
      if (!await current()) return;
      if (revision !== atRevision) return; // Preserve words edited during commit.
      preview.value = ''; await persist();
      status.textContent = 'Added to the note draft. Review its audience and use Save note when online.';
      target.focus(); paint();
    } catch (error) {
      writeError = error; status.textContent = `Note draft not saved: ${error.message}. Dictation words remain for recovery.`;
    } finally { applying = false; paint(); }
  });
  discard.addEventListener('click', async () => {
    cancelRecognition(); preview.value = ''; revision++;
    writing = writing.catch(() => {}).then(async () => { await deleteDraft(jobId, 'dictation-review', ownerId); writeError = null; }).catch(error => {
      writeError = error; status.textContent = `Review could not be cleared: ${error.message}`;
    }); await writing; paint();
  });
  root.append(el('h3', { text: 'Dictation — review first' }),
    el('p', { class: 'hint', text: Recognition ? 'Start only when ready. Speech recognition may need a connection.'
      : 'Speech recognition is unavailable here. You can type and review text below.' }),
    el('div', { class: 'btn-row' }, [start, stop]),
    el('label', { class: 'field' }, [el('span', { text: 'Words to review' }), preview]),
    audience, el('div', { class: 'btn-row' }, [apply, discard]), status);
  const ready = (async () => {
    const draft = await readDraft(jobId, 'dictation-review');
    if (revision === 0 && !disposed && await localAccount() === ownerId && draft?.value.text) {
      preview.value = draft.value.text; status.textContent = 'Restored unsubmitted dictation. Review before adding it to a note.';
    }
    paint();
  })().catch(error => { writeError = error; status.textContent = `Device review storage unavailable: ${error.message}`; paint(); });
  const cleanup = new MutationObserver(() => {
    if (root.isConnected) return;
    disposed = true; cancelRecognition(); visibility.removeEventListener('change', paint);
    document.removeEventListener('visibilitychange', hidden); cleanup.disconnect();
  });
  const hidden = () => { if (document.hidden && listening) { cancelRecognition(); status.textContent = 'Dictation paused. Review words already captured before continuing.'; } };
  document.addEventListener('visibilitychange', hidden);
  // Mount happens synchronously after construction; later removal stops mic.
  queueMicrotask(() => { if (root.isConnected) cleanup.observe(document.body, { childList: true, subtree: true }); });
  return { root, ready };
}
