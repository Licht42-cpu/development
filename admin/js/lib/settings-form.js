// Settings-specific form helpers.
//
// Deliberately local to the Settings screen rather than added to shared/dom.js:
// nothing else in the app edits a stored JSON document field-by-field, and the
// validation here encodes Settings' own rules (a rate is money, validity is a
// whole number of days, the staff base URL must be a real http(s) URL). Putting
// it in the shared layer would invite other screens to inherit rules that are
// not theirs.
//
// Three concerns live here:
//   1. typed fields that validate BEFORE a write is attempted
//   2. a save control that shows saving / saved / failed honestly, keeps the
//      operator's input after a failure, and offers retry
//   3. merging edits back over the stored object so keys the editor does not
//      expose survive the write

import { el } from '../../../shared/dom.js';

/* ------------------------------------------------------------- merging -- */

/** app_settings rows are written whole: updateSetting(key, value) REPLACES the
 *  stored JSON. A structured editor only knows the fields it renders, so a
 *  naive save would silently drop everything else -- tax.note and
 *  tax.registration_number are real examples currently in the database.
 *  Edits are therefore merged over a copy of the original. */
export function mergePreserving(original, edits) {
  return { ...(original && typeof original === 'object' ? original : {}), ...edits };
}

/* ---------------------------------------------------------- validation -- */

// Each validator returns { ok: true, value } or { ok: false, error }.
// They are deliberately strict about blank input: Number('') is 0 and
// Number.isFinite(0) is true, so a cleared money field would otherwise be
// stored as a real zero rather than rejected.

const blank = (raw) => String(raw ?? '').trim() === '';

export const validators = {
  text: ({ required = false } = {}) => (raw) => {
    const value = String(raw ?? '').trim();
    if (!value) return required ? { ok: false, error: 'Required.' } : { ok: true, value: null };
    return { ok: true, value };
  },

  /** Money and rates: a non-negative finite number. */
  money: ({ required = true, min = 0 } = {}) => (raw) => {
    if (blank(raw)) return required ? { ok: false, error: 'Required.' } : { ok: true, value: null };
    const value = Number(raw);
    if (!Number.isFinite(value)) return { ok: false, error: 'Must be a number.' };
    if (value < min) return { ok: false, error: `Cannot be less than ${min}.` };
    return { ok: true, value };
  },

  /** Whole numbers, e.g. validity_days and warranty years. */
  integer: ({ required = true, min = 0, max = null } = {}) => (raw) => {
    if (blank(raw)) return required ? { ok: false, error: 'Required.' } : { ok: true, value: null };
    const value = Number(raw);
    if (!Number.isInteger(value)) return { ok: false, error: 'Must be a whole number.' };
    if (value < min) return { ok: false, error: `Cannot be less than ${min}.` };
    if (max !== null && value > max) return { ok: false, error: `Cannot be more than ${max}.` };
    return { ok: true, value };
  },

  /** A tax rate is stored as a fraction (0.13 == 13%), not a percentage. */
  fraction: ({ required = true } = {}) => (raw) => {
    if (blank(raw)) return required ? { ok: false, error: 'Required.' } : { ok: true, value: null };
    const value = Number(raw);
    if (!Number.isFinite(value)) return { ok: false, error: 'Must be a number.' };
    if (value < 0 || value > 1) {
      return { ok: false, error: 'Enter a fraction between 0 and 1 (0.13 = 13%).' };
    }
    return { ok: true, value };
  },

  url: ({ required = false } = {}) => (raw) => {
    if (blank(raw)) return required ? { ok: false, error: 'Required.' } : { ok: true, value: null };
    const value = String(raw).trim();
    let parsed;
    try { parsed = new URL(value); } catch { return { ok: false, error: 'Must be a full URL.' }; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: 'Must start with http:// or https://' };
    }
    return { ok: true, value };
  },

  email: ({ required = false } = {}) => (raw) => {
    if (blank(raw)) return required ? { ok: false, error: 'Required.' } : { ok: true, value: null };
    const value = String(raw).trim();
    // Deliberately permissive -- just enough to catch a typo, not an attempt
    // to out-parse RFC 5322.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return { ok: false, error: 'Not a valid email address.' };
    return { ok: true, value };
  },

  choice: (options, { required = true } = {}) => (raw) => {
    const value = String(raw ?? '').trim();
    if (!value) return required ? { ok: false, error: 'Required.' } : { ok: true, value: null };
    if (!options.includes(value)) return { ok: false, error: `Must be one of: ${options.join(', ')}` };
    return { ok: true, value };
  },

  boolean: () => (raw) => ({ ok: true, value: raw === true || raw === 'true' })
};

/* -------------------------------------------------------------- fields -- */

/** One labelled, validated control bound to a key in the stored object.
 *  Returns { key, node, read, showError, element }. read() validates the
 *  CURRENT control value, so a queued save always writes what is on screen
 *  rather than what was there when the button was pressed.
 *
 *  Named settingField, not field: shared/dom.js already exports a `field`
 *  helper with a different signature, and two same-named imports in one view
 *  is a mistake waiting to happen. */
export function settingField({ key, label, value, validate, type = 'text', options = null,
                               hint = null, attrs = {} }) {
  let control;

  if (type === 'select') {
    control = el('select', { 'aria-label': label, ...attrs },
      options.map(opt => el('option', {
        value: String(opt.value), text: opt.label,
        selected: String(opt.value) === String(value)
      })));
  } else if (type === 'textarea') {
    control = el('textarea', {
      rows: '3', 'aria-label': label,
      style: 'width:100%;resize:vertical;font:inherit;padding:8px;' +
             'border:1px solid var(--line);border-radius:8px;box-sizing:border-box',
      ...attrs
    });
    control.value = value == null ? '' : String(value);
  } else {
    control = el('input', { type: type === 'number' ? 'number' : 'text',
      'aria-label': label, ...attrs });
    control.value = value == null ? '' : String(value);
  }

  const error = el('p', { class: 'error-text', style: 'margin:4px 0 0', hidden: true });

  function showError(message) {
    if (message) {
      error.textContent = message;
      error.hidden = false;
      control.setAttribute('aria-invalid', 'true');
    } else {
      error.textContent = '';
      error.hidden = true;
      control.removeAttribute('aria-invalid');
    }
  }

  control.addEventListener('input', () => showError(null));
  control.addEventListener('change', () => showError(null));

  function read() {
    const result = validate(control.value);
    showError(result.ok ? null : result.error);
    return result;
  }

  // The hint sits OUTSIDE the label: `.field > span` is more specific than
  // `.hint`, so a nested hint span would be painted as another field caption,
  // and <p> is not phrasing content so it cannot live inside a <label>.
  const node = el('div', { style: 'margin:0 0 12px' }, [
    el('label', { class: 'field', style: 'margin:0' }, [
      el('span', { text: label }),
      control
    ]),
    hint ? el('p', { class: 'hint', style: 'margin:4px 0 0', text: hint }) : null,
    error
  ].filter(Boolean));

  return { key, node, read, showError, element: control };
}

/* ---------------------------------------------------------------- save -- */

/** Serialises saves for one target and guarantees the LAST state wins.
 *
 *  Two overlapping saves on the same record are not merely wasteful: these
 *  writes are read-modify-write (updateSetting replaces the whole document,
 *  updatePricingRule closes the open rule then inserts a new one), so letting
 *  them interleave can leave the older value stored, or leave a service with
 *  no open rule at all. A save requested while one is running is coalesced
 *  into a single trailing run that re-reads the live form values, so the
 *  stored value always matches what is on screen when the dust settles. */
export function createSaveRunner() {
  let running = null;
  let queued = false;

  return function run(fn) {
    if (running) { queued = true; return running; }
    running = (async () => {
      try {
        do {
          queued = false;
          await fn();
        } while (queued);
      } finally {
        running = null;
        queued = false;
      }
    })();
    return running;
  };
}

/** The visible save control: a button plus an honest status line.
 *
 *  "Saved" is only ever shown after the write resolves. A failure keeps the
 *  operator's input on screen, says why, and leaves the button available to
 *  retry -- it never reverts the control or implies the write landed. */
export function createSaveControl({ label = 'Save', onSave }) {
  const status = el('span', { class: 'hint', role: 'status', 'aria-live': 'polite',
    style: 'margin-left:10px' });
  const button = el('button', { class: 'btn btn--sm', type: 'button', text: label });
  const run = createSaveRunner();

  function setStatus(text, kind) {
    status.textContent = text;
    status.className = kind === 'error' ? 'error-text' : 'hint';
    status.style.marginLeft = '10px';
  }

  // The button is deliberately NOT disabled while a save is in flight.
  //
  // Disabling it looks like double-submit protection, but here it actively
  // causes the bug it appears to prevent: a click on a disabled button fires
  // no event, so an edit made DURING a save could never be requested, and the
  // control would settle on "Saved" while a newer value sat unsaved on screen
  // -- a false success. createSaveRunner already serialises, and because
  // onSave re-reads the live fields on every run, the coalesced trailing run
  // stores exactly what is on screen when the dust settles.
  button.addEventListener('click', () => {
    setStatus('Saving…');
    run(async () => {
      try {
        const result = await onSave();
        // onSave returns false for a validation stop: nothing was attempted,
        // so saying "Saved" or "Not saved -- <network error>" would both lie.
        if (result === false) { setStatus('Not saved — check the fields above.', 'error'); return; }
        setStatus('Saved');
      } catch (err) {
        setStatus(`Not saved — ${err && err.message ? err.message : 'unknown error'}`, 'error');
      }
    });
  });

  const node = el('div', { class: 'btn-row', style: 'margin-top:12px;align-items:center' },
    [button, status]);

  return { node, button, status, setStatus };
}

/** Reads every field, reports all errors at once rather than stopping at the
 *  first, and returns null if any failed. Returning the whole error set keeps
 *  the operator from fixing one problem only to discover the next. */
export function readAll(fields) {
  let ok = true;
  const edits = {};
  for (const f of fields) {
    const result = f.read();
    if (!result.ok) { ok = false; continue; }
    edits[f.key] = result.value;
  }
  return ok ? edits : null;
}
