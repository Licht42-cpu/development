import { flushMeasurementEdits } from './lib/measurement-entry.js';
import { supabase, getSession } from '../../shared/supabase.js';
import { el, clear, toast } from '../../shared/dom.js';
import { installUnhandledRejectionToast } from './lib/save.js';
import { isNative, loadAppPlugin } from './lib/native.js';
import { installBackHandler, installEscapeHandler } from './lib/navigation.js';
import { renderLogin } from './views/login.js';
import { renderDashboard } from './views/dashboard.js';
import { renderRequests } from './views/requests.js';
import { renderJobs, renderJob } from './views/job.js';
import { renderCustomers, renderCustomer } from './views/customers.js';
import { renderProperty } from './views/property.js';
import { renderSettings } from './views/settings.js';
import { renderWinter } from './views/winter.js';
import { renderInventoryRoute, renderDispatchRoute, mountPropertyAccess, mountJobOperations } from './views/operations-routes.js';

const viewEl = document.getElementById('view');
const navEl = document.getElementById('nav');
const topbarEl = document.getElementById('topbar');

const routes = [
  { pattern: /^\/dashboard$/,        nav: 'dashboard', render: renderDashboard },
  { pattern: /^\/requests$/,         nav: 'requests',  render: renderRequests },
  { pattern: /^\/jobs$/,             nav: 'jobs',      render: async ctx => {
    await renderJobs(ctx);
    if (ctx.isCurrent()) ctx.mount.querySelector('.page-head')?.append(
      el('a', { class: 'btn', href: '#/dispatch', text: 'Plan the dispatch day' })
    );
  } },
  { pattern: /^\/jobs\/([0-9a-f-]+)$/, nav: 'jobs',    render: async (ctx, id) => {
    let completionAvailable = false;
    const holdCompletion = () => {
      if (completionAvailable) return;
      for (const button of ctx.mount.querySelectorAll('button')) {
        if (button.textContent === 'Mark job complete' && !button.disabled) button.disabled = true;
      }
    };
    const observer = new MutationObserver(holdCompletion);
    observer.observe(ctx.mount, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    ctx.mount.addEventListener('click', event => {
      if (!completionAvailable && event.target.closest('button')?.textContent === 'Mark job complete') {
        event.preventDefault(); event.stopImmediatePropagation();
      }
    }, true);
    await renderJob(ctx, id);
    if (ctx.isCurrent()) await mountJobOperations({ ...ctx, onCompletionAvailable: () => {
      completionAvailable = true; observer.disconnect();
    } }, id);
  } },
  { pattern: /^\/customers$/,        nav: 'customers', render: renderCustomers },
  { pattern: /^\/customers\/([0-9a-f-]+)$/, nav: 'customers',
    render: (ctx, id) => renderCustomer(ctx, id) },
  // Properties have no list of their own: a property is always reached
  // through the customer who owns it, which is also what makes its Back
  // target unambiguous.
  { pattern: /^\/properties\/([0-9a-f-]+)$/, nav: 'customers',
    render: async (ctx, id) => {
      await renderProperty(ctx, id);
      if (ctx.isCurrent()) await mountPropertyAccess(ctx, id);
    } },
  { pattern: /^\/inventory$/, nav: 'inventory', render: renderInventoryRoute },
  { pattern: /^\/dispatch$/, nav: 'dispatch', render: renderDispatchRoute },
  { pattern: /^\/winter$/,           nav: 'winter',    render: renderWinter },
  { pattern: /^\/settings$/,         nav: 'settings',  render: renderSettings }
];

/* Routes carry an optional query string so a dashboard card can link
   straight at the records it counted -- #/jobs?bucket=today,
   #/jobs?needs_review=1, #/requests?status=new. The route table still
   matches on the path alone; the params ride along in the render context. */
function currentLocation() {
  const hash = window.location.hash.replace(/^#/, '') || '/dashboard';
  const cut = hash.indexOf('?');
  return cut === -1
    ? { path: hash, query: '', params: new URLSearchParams() }
    : {
        path: hash.slice(0, cut) || '/dashboard',
        query: hash.slice(cut + 1),
        params: new URLSearchParams(hash.slice(cut + 1))
      };
}

function currentPath() {
  return currentLocation().path;
}

/* ---------------------------------------------- history depth tracking -- */

/* Android's Back has to tell "this app pushed an entry I can pop" apart
   from "the entry behind me belongs to whatever was open before the app
   booted". history.length cannot: it counts both. So each entry gets
   stamped with a depth the first time we see it.

   The stamp goes on with replaceState, which annotates the current entry
   and adds nothing -- so this works for every way a route can change in
   this app: an <a href="#/..."> click (which is most of them), a hash
   assignment from navigate(), or going back/forward, where the entry we
   land on reports the depth we already gave it and we simply adopt it. */
let navDepth = 0;

function syncNavDepth() {
  const state = window.history.state;
  if (state && typeof state.nsDepth === 'number') {
    navDepth = state.nsDepth;                     // an entry we have seen
    return;
  }
  navDepth += 1;                                  // a brand-new entry
  try {
    window.history.replaceState({ ...(state || {}), nsDepth: navDepth }, '');
  } catch {
    // replaceState can throw in a sandboxed frame or over file://. The
    // depth is still right in memory for this session; only back/forward
    // across a reload would lose it.
  }
}

/** Whether the app itself has an entry to pop. */
function canGoBack() {
  return navDepth > 1;
}

/* A screen can name a better parent than the static route map knows -- a
   property opened from a customer should go back to THAT customer. Reset
   before every render so a stale parent cannot leak across screens. */
let contextParentPath = null;

/** Called by a view to say where its Back should go. */
export function setContextParent(path) {
  contextParentPath = path || null;
}

/** Rewrites the current route's query string WITHOUT adding a history
 *  entry, so changing a filter is not something Back has to walk back
 *  through. The URL still reflects the filters, so it survives a reload and
 *  can be shared -- pushState would give that too, but at the cost of
 *  making Back mean "undo my last filter". On Android, Back means
 *  "previous screen", so replaceState is the only correct choice. */
export function replaceQuery(queryString) {
  const { path } = currentLocation();
  const qs = String(queryString || '').replace(/^\?/, '');
  try {
    window.history.replaceState(
      { ...(window.history.state || {}), nsDepth: navDepth },
      '',
      qs ? `#${path}?${qs}` : `#${path}`
    );
  } catch {
    // Non-fatal: the filter has already been applied to the view, only the
    // address bar lags behind.
  }
}

function setChrome(visible, navKey) {
  topbarEl.hidden = !visible;
  navEl.hidden = !visible;
  navEl.classList.remove('is-open');
  document.getElementById('navToggle')?.setAttribute('aria-expanded', 'false');
  for (const link of navEl.querySelectorAll('a')) {
    if (link.dataset.nav === navKey) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function showMessage(title, body, action) {
  clear(viewEl).append(
    el('div', { class: 'card', style: 'max-width:520px;margin:10vh auto' }, [
      el('h1', { text: title }),
      el('p', { class: 'hint', text: body }),
      action ? el('div', { class: 'btn-row', style: 'margin-top:16px' }, [action]) : null
    ])
  );
}

let measurementRouteAttempt = 0;
async function router() {
  const attempt = ++measurementRouteAttempt;
  if (!await flushMeasurementEdits() || attempt !== measurementRouteAttempt) return;
  syncNavDepth();
  contextParentPath = null;
  const { session, isAdmin } = await getSession();
  if (attempt !== measurementRouteAttempt) return;

  if (!session) {
    setChrome(false);
    return renderLogin({ mount: viewEl, onSignedIn: router });
  }

  if (!isAdmin) {
    setChrome(false);
    return showMessage(
      'Account not authorised',
      'You are signed in, but this account has not been granted access to the Nova Shield field tool. ' +
      'An existing admin needs to add your user to the admin_users table.',
      el('button', {
        class: 'btn', text: 'Sign out',
        onClick: async () => { await supabase.auth.signOut(); router(); }
      })
    );
  }

  const { path, params } = currentLocation();
  const match = routes.map(r => ({ r, m: path.match(r.pattern) })).find(x => x.m);

  if (!match) {
    setChrome(true, null);
    return showMessage('Page not found', `Nothing is routed at ${path}.`,
      el('a', { class: 'btn', href: '#/dashboard', text: 'Back to dashboard' }));
  }

  setChrome(true, match.r.nav);
  const routeMount = el('div');
  clear(viewEl).append(routeMount);
  routeMount.append(el('div', { class: 'loading', text: 'Loading…' }));

  try {
    await match.r.render(
      { mount: routeMount, navigate, params,
        replaceQuery: query => { if (attempt === measurementRouteAttempt) replaceQuery(query); },
        setContextParent: path => { if (attempt === measurementRouteAttempt) setContextParent(path); },
        isCurrent: () => attempt === measurementRouteAttempt },
      match.m[1]
    );
  } catch (err) {
    if (attempt !== measurementRouteAttempt) return;
    console.error(err);
    clear(viewEl).append(
      el('div', { class: 'card' }, [
        el('h1', { text: 'Something went wrong' }),
        el('p', { class: 'error-text', text: err.message }),
        el('div', { class: 'btn-row', style: 'margin-top:12px' }, [
          el('button', { class: 'btn', text: 'Retry', onClick: () => router() })
        ])
      ])
    );
  }
}

export function navigate(path) {
  // Compare the whole location, query string included: navigating from
  // #/jobs?bucket=today to #/jobs is a real change even though the path
  // is identical, and must not be swallowed as a no-op re-render.
  const here = currentLocation();
  const full = here.query ? `${here.path}?${here.query}` : here.path;
  if (full === path) router();
  else window.location.hash = path;
}

document.getElementById('navToggle')?.addEventListener('click', () => {
  const open = navEl.classList.toggle('is-open');
  document.getElementById('navToggle').setAttribute('aria-expanded', String(open));
});

navEl.addEventListener('click', e => {
  if (e.target.tagName === 'A') navEl.classList.remove('is-open');
});

document.getElementById('signOut')?.addEventListener('click', async () => {
  if (!await flushMeasurementEdits()) return;
  await supabase.auth.signOut();
  toast('Signed out');
  navigate('/dashboard');
  router();
});

/* The router's try/catch only covers the initial render. Every post-mutation
   refresh is invoked un-awaited (quote.js calls onChange() ten times without
   awaiting it), so a rejected reload used to vanish into the console and leave
   a success toast sitting over a stale card -- which invites a double-send.
   This is the last-resort net for anything that escapes trySave(). */
installUnhandledRejectionToast();

/* Escape closes the topmost overlay on desktop. Same code path the Android
   Back button takes, so the two cannot drift apart. */
installEscapeHandler();

/* Android hardware/gesture Back. A no-op in a browser tab -- there is no
   such button -- so this is safe to call unconditionally; installBackHandler
   checks isNative() itself and resolves to null off-native.
   Un-awaited on purpose: the first route must render immediately rather
   than wait on a CDN plugin fetch, and until the listener attaches Back
   behaves exactly as it did before (plain WebView history). */
installBackHandler({
  beforeExit: flushMeasurementEdits,
  currentPath: () => currentLocation().path,
  navigate,
  canGoBack,
  isDrawerOpen: () => navEl.classList.contains('is-open'),
  closeDrawer: () => {
    navEl.classList.remove('is-open');
    document.getElementById('navToggle')?.setAttribute('aria-expanded', 'false');
  },
  contextParent: () => contextParentPath,
  loadApp: loadAppPlugin,
  native: isNative
});

window.addEventListener('hashchange', router);
export const startupReady = window.nsStartupLoaderFailed ? Promise.resolve() : router();
window.nsStartup?.watch(startupReady);
