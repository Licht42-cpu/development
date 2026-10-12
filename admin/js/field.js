import { flushMeasurementEdits } from './lib/measurement-entry.js';
import { supabase, getSession } from '../../shared/supabase.js';
import { el, clear, toast } from '../../shared/dom.js';
import { renderLogin } from './views/login.js';
import { renderSchedule } from './views/field-schedule.js';
import { renderVisit } from './views/field-workspace.js';
import * as offlineQueue from './lib/offline-queue.js';
import { setStatusBarTheme, isNative, loadAppPlugin } from './lib/native.js';
import { installUnhandledRejectionToast } from './lib/save.js';
import { installBackHandler, installEscapeHandler, fieldParentOf, pushOverlay, dismissTopOverlay } from './lib/navigation.js';
import { usableSnapshot, forget } from './lib/field-cache.js';
import { localAccount, accessDenied } from './lib/field-identity.js';
import { renderOfflineWork } from './views/field-offline.js';
import { unavailableLoadRoute } from './lib/field-load-gate.js';
import { renderFieldLoad } from './views/field-load.js';

setStatusBarTheme();

/* Same net as the desktop console: the field screens do inline saves from
   event handlers, and a rejection with no handler used to leave the control
   showing a value that never reached Supabase. */
installUnhandledRejectionToast();

/* A small, separate router rather than a mode bolted onto main.js's: the
   field console is a dedicated page by design (different layout, different
   job -- see field.html), and the two screens it needs don't warrant
   dragging in the desktop SPA's nav chrome and five-route table. It shares
   everything that matters: the same Supabase session (same origin, same
   localStorage), the same login screen, the same api.js. */

const viewEl = document.getElementById('view');

const routes = [
  { pattern: /^\/load(?:\/closing)?(?:\?.*)?$/, render: renderFieldLoad },
  { pattern: /^\/$/,                        render: renderSchedule },
  { pattern: /^\/visit\/([0-9a-f-]+)$/,     render: (ctx, id) => renderVisit(ctx, id) }
];

function currentPath() {
  return window.location.hash.replace(/^#/, '') || '/';
}

/* Same history-depth stamp as the desktop console (see main.js for why
   history.length cannot answer this). The field console needs it for the
   same reason and more sharply: a tech opens a visit from a notification,
   lands on /visit/<id> with an empty history, and Back must take them to
   the schedule rather than drop them out of the app mid-job. */
let navDepth = 0;

function syncNavDepth() {
  const state = window.history.state;
  if (state && typeof state.nsDepth === 'number') {
    navDepth = state.nsDepth;
    return;
  }
  navDepth += 1;
  try {
    window.history.replaceState({ ...(state || {}), nsDepth: navDepth }, '');
  } catch { /* see main.js */ }
}

function showMessage(title, body, action, mount = viewEl) {
  clear(mount).append(
    el('div', { class: 'card' }, [
      el('h1', { text: title }),
      el('p', { class: 'hint', text: body }),
      action ? el('div', { class: 'btn-row', style: 'margin-top:12px' }, [action]) : null
    ])
  );
}

let measurementRouteAttempt = 0;
let cachedAccount = null;
async function cachedRoute(mount, attempt) {
  if (/^\/load(?:\/|\?|$)/.test(currentPath())) {
    await renderFieldLoad({ mount, navigate });
    return true;
  }
  const data = await usableSnapshot();
  if (attempt !== measurementRouteAttempt) return true;
  if (!data) return false;
  cachedAccount = data.id;
  const path = currentPath();
  const id = path.match(/^\/visit\/([0-9a-f-]+)$/)?.[1];
  await renderOfflineWork({ mount, navigate, retry: router }, data, id);
  return true;
}
async function router() {
  const attempt = ++measurementRouteAttempt;
  if (!await flushMeasurementEdits() || attempt !== measurementRouteAttempt) return;
  // Gate before both live and cached routing, after the measurement exit guard.
  // A disabled deep link returns to a real schedule, never a partial screen.
  if (unavailableLoadRoute(currentPath())) {
    window.location.replace('#/');
    return;
  }
  cachedAccount = null;
  syncNavDepth();
  // Each attempt owns its mount. A late response may finish its detached
  // view, but cannot clear or replace a newer route's visible controls.
  const mount = el('div', {});
  clear(viewEl).append(mount);
  mount.append(el('div', { class: 'loading', text: 'Checking access…' }));
  try {
    if (!navigator.onLine) {
      if (await cachedRoute(mount, attempt)) return;
      return showMessage('Work unavailable offline',
        'No recent work is saved for this account. Reconnect, sign in and use Save work for offline on the schedule. Saved outbox actions remain available from the sync badge.',
        el('button', { class: 'btn', text: 'Retry connection', onClick: () => router() }), mount);
    }
    const { session, isAdmin, error } = await getSession();
    if (error) throw error;
    if (attempt !== measurementRouteAttempt) return;

    if (!session) return renderLogin({ mount, onSignedIn: router });

    if (!isAdmin) {
      await forget(session.user.id);
      return showMessage(
        'Account not authorised',
        'You are signed in, but this account has not been granted field access.',
        el('button', { class: 'btn', text: 'Sign out',
          onClick: signOut }), mount
      );
    }

    const path = currentPath();
    const match = routes.map(r => ({ r, m: path.match(r.pattern) })).find(x => x.m);

    if (!match) {
      window.location.hash = '/';
      return;
    }

    clear(mount).append(el('div', { class: 'loading', text: 'Loading…' }));

    await match.r.render({ mount, navigate }, match.m[1]);
  } catch (err) {
    if (attempt !== measurementRouteAttempt) return;
    if (accessDenied(err)) await forget().catch(() => {});
    else if (offlineQueue.looksOffline(err)) {
      try { if (await cachedRoute(mount, attempt)) return; }
      catch { /* Keep the original connection failure when no cache can open. */ }
    }
    console.error(err);
    showMessage('Could not load this screen', offlineQueue.looksOffline(err)
      ? 'No connection — reconnect and retry.' : err.message || 'The screen could not be read.',
      el('button', { class: 'btn', text: 'Retry', onClick: () => router() }), mount);
  }
}

export function navigate(path) {
  if (currentPath() === path) router();
  else window.location.hash = path;
}

async function signOut() {
  if (!navigator.onLine) return toast('Reconnect to sign out. Your saved work remains in this account.', 'error');
  if (!await flushMeasurementEdits()) return;
  if (offlineQueue.syncState().syncing) return toast('Wait for sync to finish before signing out.', 'error');
  const owner = await localAccount();
  try {
    const result = await supabase.auth.signOut();
    if (result?.error) throw result.error;
  } catch (error) { return toast(`Could not sign out: ${error.message}`, 'error'); }
  localStorage.removeItem('ns-field-active-account');
  await forget(owner);
  clear(viewEl);
  toast('Signed out');
  navigate('/');
  router();
}
document.getElementById('signOut')?.addEventListener('click', signOut);
// A denied replay retires the stored snapshot. Also hide a cached screen
// already on display; deleting IDB alone cannot remove its private DOM.
window.addEventListener('ns-field-access-denied', event => {
  if (!cachedAccount || cachedAccount !== event.detail?.ownerId) return;
  cachedAccount = null;
  measurementRouteAttempt++;
  while (dismissTopOverlay()) { /* Close cached private controls. */ }
  showMessage('Saved access no longer available',
    'The server refused access to saved work. Your unsent actions and drafts remain on this device. Check the schedule for current work.',
    el('button', { class: 'btn', text: 'Check current work', onClick: () => navigate('/') }));
});
// Auth events may arrive from another tab. Clear private controls immediately;
// do not await a Supabase call from inside its auth callback/lock.
let observedAccount;
supabase.auth.onAuthStateChange?.((event, session) => {
  const id = session?.user?.id || null;
  // The SDK emits INITIAL_SESSION(null) when offline token refresh fails.
  // That is not an explicit logout. The last checked, bounded snapshot may
  // still be read; SIGNED_OUT always clears this remembered namespace.
  if (event === 'INITIAL_SESSION' && !id && !navigator.onLine && localStorage.getItem('ns-field-active-account')) {
    observedAccount = localStorage.getItem('ns-field-active-account');
    return;
  }
  if (id) localStorage.setItem('ns-field-active-account', id);
  else localStorage.removeItem('ns-field-active-account');
  if (event === 'SIGNED_OUT' || observedAccount !== undefined && id !== observedAccount) {
    measurementRouteAttempt++;
    while (dismissTopOverlay()) { /* Remove private dialogs and markup. */ }
    clear(viewEl);
    if (!id) void forget(observedAccount).catch(() => {});
    setTimeout(() => { void offlineQueue.count().then(() => paintBadge(offlineQueue.syncState()))
      .catch(() => paintBadge(offlineQueue.syncState())); router(); }, 0);
  }
  observedAccount = id;
});

/* Escape / Android Back. This page has no nav drawer, but it is where the
   photo-markup overlay is actually used, so overlay dismissal matters more
   here than on the desktop console. fieldParentOf is passed explicitly
   because this router's root is '/', not '/dashboard'. */
installEscapeHandler();

installBackHandler({
  beforeExit: flushMeasurementEdits,
  currentPath,
  navigate,
  canGoBack: () => navDepth > 1,
  resolveParent: fieldParentOf,
  loadApp: loadAppPlugin,
  native: isNative
});

/* Online [green] / Offline Queue: N actions [yellow] -- offline-queue.js
   owns the actual outbox; this just reflects its count plus the browser's
   own online/offline signal. Sync Now re-runs the same flush() 'online'
   already triggers automatically -- it exists for "I know I have signal
   now, don't wait for the browser to notice." */
const syncBadge = document.getElementById('syncBadge');
const syncNowBtn = document.getElementById('syncNow');
// The badge is an interactive button. Announce changes separately so its
// role/name remain useful and background replay does not move focus.
const syncStatus = el('span', { class: 'sr-only', role: 'status', 'aria-live': 'polite',
  'aria-atomic': 'true', dataset: { syncStatus: '' } });
syncBadge.after(syncStatus);

/* Four states the tech must be able to tell apart, because they call for
   different actions:
     synced       - nothing outstanding, connection fine
     offline      - no connection; anything saved is saved HERE, not on the server
     pending sync - has connection, replay in flight or waiting
     sync failed  - has connection but replay hit a real error; needs attention
   These used to collapse into two: a green "Online" and one yellow pill that
   meant offline, pending and failed all at once. Worse, the 'online' event
   painted the badge green with a hardcoded count of 0, so a queue that was
   still full -- or permanently stuck -- read as fully synced. */
function paintBadge(state) {
  const { count, online, syncing, discarding, lastError, storageError } = state;
  syncNowBtn.hidden = !((count > 0 || storageError) && online && !syncing && !discarding);

  if (storageError) {
    syncBadge.textContent = 'Device storage unavailable';
    syncBadge.className = 'sync-badge sync-badge--error';
    return;
  }

  if (count === 0) {
    syncBadge.textContent = online ? 'Synced' : 'Offline';
    syncBadge.className = online ? 'sync-badge sync-badge--ok' : 'sync-badge sync-badge--queued';
    return;
  }
  const n = `${count} saved here`;
  if (!online) {
    syncBadge.textContent = `Offline — ${n}`;
    syncBadge.className = 'sync-badge sync-badge--queued';
  } else if (syncing) {
    syncBadge.textContent = `Syncing ${count}…`;
    syncBadge.className = 'sync-badge sync-badge--queued';
  } else if (lastError) {
    syncBadge.textContent = `Sync failed — ${n}`;
    syncBadge.className = 'sync-badge sync-badge--error';
  } else {
    syncBadge.textContent = `Pending sync — ${count}`;
    syncBadge.className = 'sync-badge sync-badge--queued';
  }
}

offlineQueue.subscribe(state => {
  paintBadge(state);
  if (syncStatus.textContent !== syncBadge.textContent) syncStatus.textContent = syncBadge.textContent;
});

/* Tapping the badge lists what is actually waiting. The queue has always
   stored a human label per item; nothing rendered it, so a tech with a stuck
   queue saw a number and had no way to find out what it was. */
syncBadge.style.cursor = 'pointer';
syncBadge.setAttribute('title', 'Tap to see what is waiting to sync');
syncBadge.setAttribute('role', 'button');
syncBadge.setAttribute('tabindex', '0');
syncBadge.setAttribute('aria-haspopup', 'dialog');
let outboxDialog;
function openOutbox() {
  if (outboxDialog) return outboxDialog.focus();
  const state = offlineQueue.syncState();
  if (!state.count && !state.storageError) return toast(state.online ? 'Everything is synced' : 'Offline — nothing waiting to sync');
  const list = el('div', { class: 'outbox-items' }, [el('p', { class: 'hint', text: 'Loading saved actions…' })]);
  const summary = el('p', { class: 'hint', role: 'status' });
  const retry = el('button', { class: 'btn', text: 'Retry sync', onClick: () => syncNowBtn.click() });
  const closeButton = el('button', { class: 'btn btn--sm', text: 'Close', onClick: () => close() });
  const dialog = el('dialog', { class: 'outbox-dialog', 'aria-labelledby': 'outbox-title' }, [
    el('div', { class: 'card__head' }, [el('h2', { id: 'outbox-title', text: 'Saved on this device' }), closeButton]),
    summary, el('p', { class: 'hint', text: 'Actions sync in order. A failed action holds up the ones after it. ' +
      'Discard removes only the local action; a server change already received cannot be undone here.' }),
    list, el('div', { class: 'btn-row' }, [retry])
  ]);
  let sequence = 0;
  let unsubscribe;
  let listFocus;
  const unregister = pushOverlay(close);
  function close() {
    sequence++;
    unsubscribe?.(); unregister();
    dialog.close(); dialog.remove(); outboxDialog = null;
    syncBadge.focus();
  }
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  async function refresh() {
    const attempt = ++sequence;
    const current = offlineQueue.syncState();
    retry.disabled = !current.online || current.syncing || current.discarding;
    summary.textContent = current.syncing ? 'Syncing…' : current.online
      ? 'Waiting to sync with the server.' : 'Offline — these actions are saved here.';
    try {
      const items = await offlineQueue.pending();
      if (attempt !== sequence || !dialog.isConnected) return;
      const focusedItem = document.activeElement.closest('[data-outbox-id]');
      if (focusedItem && list.contains(focusedItem)) {
        listFocus = { id: focusedItem.dataset.outboxId,
          index: [...list.children].indexOf(focusedItem) };
      }
      clear(list).append(...items.map((item, index) => el('div', { class: 'section-box' }, [
        el('strong', { text: item.label || item.type }),
        el('p', { class: 'hint', text: `Saved ${new Date(item.createdAt).toLocaleString()}` }),
        el('p', { class: item.lastError ? 'error-text' : 'hint',
          text: item.lastError ? `Last sync failed: ${item.lastError}` : index ? 'Waiting behind earlier actions.' : 'Waiting to sync.' }),
        item.state === 'uncertain' || item.type === 'completeJobWithEvidence' && item.outcome === 'unknown' ? el('button', { class: 'btn', text: 'Review and retry',
          disabled: !current.online || current.syncing || current.discarding,
          onClick: async () => {
            if (!window.confirm(item.type === 'completeJobWithEvidence'
              ? 'Recover the original completion receipt with the same key and unchanged request?'
              : 'The server may already have received this action. Check the visit for duplicates first. Retry anyway?')) return;
            try { await offlineQueue.confirmRetry(item.id); await offlineQueue.flush(); }
            catch (error) { toast(error.message, 'error'); }
          } }) : null,
        el('button', { class: 'btn btn--sm btn--danger', text: 'Discard',
          'aria-label': `Discard ${item.label || item.type}`, disabled: current.syncing || current.discarding || item.type === 'completeJobWithEvidence' && (item.outcome === 'unknown' || item.state === 'uncertain'),
          onClick: async () => {
            if (!window.confirm(`Discard "${item.label || item.type}" from this device? It will not be retried. ` +
              'This cannot undo a server change already received.')) return;
            try { await offlineQueue.discard(item.id); }
            catch (err) { toast(err.message, 'error'); }
          }
        })
      ])));
      [...list.children].forEach((node, index) => { node.dataset.outboxId = String(items[index].id); });
      if (!items.length) list.append(el('p', { class: 'empty', text: 'Nothing waiting to sync.' }));
      if (listFocus) {
        const matching = [...list.children].find(node => node.dataset.outboxId === listFocus.id);
        const next = matching || list.children[Math.min(listFocus.index, items.length - 1)];
        if (!current.syncing && !current.discarding) {
          (next?.querySelector('button') || closeButton).focus();
          listFocus = null;
        } else closeButton.focus();
      }
    } catch (err) {
      if (attempt !== sequence || !dialog.isConnected) return;
      clear(list).append(el('p', { class: 'error-text', text: `Could not read saved actions: ${err.message}` }));
    }
  }
  document.body.append(dialog);
  outboxDialog = dialog;
  dialog.showModal();
  unsubscribe = offlineQueue.subscribe(() => { void refresh(); });
}
syncBadge.addEventListener('click', openOutbox);
syncBadge.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openOutbox(); }
});

syncNowBtn.addEventListener('click', async () => {
  syncNowBtn.disabled = true;
  syncNowBtn.textContent = 'Syncing…';
  try {
    const { flushed, remaining, error } = await offlineQueue.flush();
    if (flushed.length) toast(`Synced ${flushed.length} queued action${flushed.length === 1 ? '' : 's'}`);
    if (remaining > 0) toast(error ? `Sync stopped: ${error}` : `${remaining} action(s) still queued`, 'error');
    if (!flushed.length && !remaining) toast('Nothing to sync');
  } catch (err) {
    toast(`Could not sync saved actions: ${err.message}`, 'error');
  } finally {
    syncNowBtn.disabled = false;
    syncNowBtn.textContent = 'Sync Now';
  }
});

window.addEventListener('hashchange', router);
// Start the route immediately, preserving the existing module-load timing.
// Check durable storage alongside it; the loader handles either rejection.
export const startupReady = window.nsStartupLoaderFailed ? Promise.resolve() : Promise.all([
  router(),
  offlineQueue.count().catch(error => {
    throw new Error(`Local outbox storage could not open: ${error.message}`, { cause: error });
  })
]);

window.nsStartup?.watch(startupReady);
