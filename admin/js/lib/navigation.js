/* Android-correct back navigation for a hash-routed SPA.
 *
 * WHY THIS EXISTS
 *
 * This app ships as a Capacitor Android app. Until now nothing listened for
 * the hardware/gesture Back at all, so Back fell through to the WebView's
 * raw history. That is wrong in three specific ways:
 *
 *   1. A deep link (notification, or the app resuming on an inner screen)
 *      starts with a history length of 1. Back then has nowhere to go and
 *      the app EXITS from an inner screen -- the single most jarring
 *      Android bug an app can have.
 *   2. A full-screen overlay (photo markup) is not a history entry, so Back
 *      navigated the screen out from underneath it and left the overlay
 *      orphaned on top of the new screen.
 *   3. Raw history.back() walks whatever happens to be in the stack,
 *      including entries pushed by things that are not screens.
 *
 * THE SHAPE OF THE FIX
 *
 * decideBack() is a pure function: given what is on screen, it returns the
 * single action to take. Everything that is hard to get right lives there,
 * so it can be unit-tested exhaustively with no device and no WebView.
 * installBackHandler() is the thin, untestable-by-nature binding that reads
 * the live DOM, calls decideBack(), and performs the action.
 *
 * WHAT IS DELIBERATELY NOT HANDLED HERE
 *
 * window.confirm() dialogs. The app confirms destructive actions through
 * shared/dom.js's confirmAction(), which is a native WebView dialog that
 * blocks the JS thread -- our listener cannot run while one is open, and
 * the WebView dismisses it on Back itself. Nothing to do, and attempting to
 * track them would be pretending to a control we do not have.
 */

/* ------------------------------------------------------- overlay stack -- */

/* Full-screen layers that are NOT routes and NOT history entries. A layer
   registers its own dismiss function while it is open, so Back can close
   the topmost one without this module knowing anything about it. Last in,
   first out -- the same discipline the Escape key needs, which is why
   installEscapeHandler() below reuses it. */
const overlays = [];

/** Registers an open overlay. Returns its own remover, so the caller can
 *  `const close = pushOverlay(fn)` and call `close()` in its teardown
 *  without having to hold on to the function identity itself. */
export function pushOverlay(dismiss) {
  if (typeof dismiss !== 'function') throw new TypeError('pushOverlay needs a dismiss function');
  overlays.push(dismiss);
  return () => removeOverlay(dismiss);
}

export function removeOverlay(dismiss) {
  // lastIndexOf, not indexOf: if the same dismiss function were somehow
  // registered twice, the newest registration is the live one.
  const i = overlays.lastIndexOf(dismiss);
  if (i !== -1) overlays.splice(i, 1);
}

export function overlayCount() {
  return overlays.length;
}

/** Dismisses the topmost overlay. Returns whether there was one.
 *  The overlay is popped BEFORE its dismiss runs, so a dismiss that itself
 *  calls removeOverlay (the normal case -- see photo-markup.js) is a no-op
 *  rather than removing the next layer down. */
export function dismissTopOverlay() {
  if (!overlays.length) return false;
  const dismiss = overlays.pop();
  dismiss();
  return true;
}

/* --------------------------------------------------------- route graph -- */

export const ROOT_PATH = '/dashboard';

/* Logical parents, so an inner screen always has somewhere to go even when
   the history stack is empty. This is Android's "Up" rather than "Back",
   and it is what stops a deep-linked inner screen from exiting the app.
   Order matters: the first matching pattern wins, so specific detail
   routes are listed before their list routes. */
const PARENTS = [
  [/^\/jobs\/[^/]+$/,      '/jobs'],
  [/^\/customers\/[^/]+$/, '/customers'],
  [/^\/properties\/[^/]+$/, '/customers'],
  [/^\/requests$/,         ROOT_PATH],
  [/^\/jobs$/,             ROOT_PATH],
  [/^\/dispatch$/,         '/jobs?bucket=today'],
  [/^\/inventory$/,        ROOT_PATH],
  [/^\/customers$/,        ROOT_PATH],
  [/^\/properties$/,       '/customers'],
  [/^\/winter$/,           ROOT_PATH],
  [/^\/settings$/,         ROOT_PATH]
];

/** The screen one level up, or null at the root.
 *
 *  `contextParent` lets a screen name a more useful parent than the static
 *  map can: a property reached from a customer goes back to THAT customer,
 *  not to the customer list. It is only honoured for a path that has a
 *  static parent, so it can never turn the root into a non-root screen or
 *  invent a parent for an unknown route. */
export function parentOf(path, { contextParent = null } = {}) {
  const clean = String(path || '').split('?')[0] || ROOT_PATH;
  if (clean === ROOT_PATH) return null;

  const hit = PARENTS.find(([pattern]) => pattern.test(clean));
  if (!hit) return ROOT_PATH;        // unknown route: the root is always safe
  if (contextParent && contextParent !== clean) return contextParent;
  return hit[1];
}

export function isRoot(path) {
  return parentOf(path) === null;
}

/* The field console (admin/field.html) is a separate page with its own
   two-route router and its own root, so it cannot share the admin SPA's
   parent map. Same rules, different graph -- which is exactly why
   decideBack() takes the resolver as an argument rather than reaching for
   parentOf() directly. */
export const FIELD_ROOT_PATH = '/';

export function fieldParentOf(path, { contextParent = null } = {}) {
  const clean = String(path || '').split('?')[0] || FIELD_ROOT_PATH;
  if (clean === FIELD_ROOT_PATH) return null;
  if (contextParent && contextParent !== clean) return contextParent;
  return FIELD_ROOT_PATH;
}

/* ------------------------------------------------------ the decision -- */

export const BACK_CLOSE_OVERLAY = 'close-overlay';
export const BACK_CLOSE_DRAWER  = 'close-drawer';
export const BACK_DISMISS_KEYBOARD = 'dismiss-keyboard';
export const BACK_HISTORY   = 'history-back';
export const BACK_GO_PARENT = 'go-parent';
export const BACK_EXIT      = 'exit';

/** What a single Back press should do. Pure.
 *
 *  Precedence, highest first -- each step is something the user is more
 *  likely to have meant than the step below it:
 *
 *    1. a full-screen overlay is up        -> close it
 *    2. the nav drawer is open             -> close it
 *    3. the soft keyboard is up            -> dismiss it
 *    4. history has a same-app entry       -> go back one entry
 *    5. an inner screen with no history    -> go to the logical parent
 *    6. the root with no history           -> leave the app
 *
 *  Note that step 4 comes BEFORE the root check, which is Android's real
 *  rule: what ends the app is an EMPTY BACK STACK, not "being on the home
 *  screen". A user who walks dashboard -> jobs -> dashboard is on the root
 *  with two entries behind them and expects Back to return to jobs. Testing
 *  for the root first (as the first draft of this function did) quit the app
 *  there and threw away their place.
 *
 *  On step 3: on Android the system normally consumes Back to hide the
 *  keyboard before the WebView ever sees it, so this branch is defensive
 *  rather than the usual path. It is gated on evidence that the keyboard is
 *  actually up (a shrunken visual viewport), NOT merely on an input having
 *  focus -- a focused input with the keyboard already down must not swallow
 *  a Back press, which would make Back feel broken.
 *
 *  On step 4 vs 5: canGoBack is "is there an entry belonging to this app",
 *  which the caller derives from its own navigation count, not from
 *  history.length -- history.length includes entries from before the app
 *  loaded and going back into those leaves the app's shell behind. */
export function decideBack({
  path = ROOT_PATH,
  hasOverlay = false,
  isDrawerOpen = false,
  isKeyboardOpen = false,
  canGoBack = false,
  contextParent = null,
  resolveParent = parentOf
} = {}) {
  if (hasOverlay)    return { action: BACK_CLOSE_OVERLAY };
  if (isDrawerOpen)  return { action: BACK_CLOSE_DRAWER };
  if (isKeyboardOpen) return { action: BACK_DISMISS_KEYBOARD };

  // An entry this app pushed is always worth popping, root screen or not.
  if (canGoBack) return { action: BACK_HISTORY };

  const parent = resolveParent(path, { contextParent });
  if (parent === null) return { action: BACK_EXIT };
  return { action: BACK_GO_PARENT, target: parent };
}

/* ------------------------------------------- keyboard / focus probing -- */

const TEXTUAL_TYPES = new Set([
  'text', 'search', 'email', 'tel', 'url', 'password', 'number',
  'date', 'datetime-local', 'time', 'month', 'week'
]);

/** Whether focus is somewhere that would raise the soft keyboard. */
export function isTextInputFocused(doc = document) {
  const node = doc.activeElement;
  if (!node) return false;
  const tag = node.tagName;
  if (tag === 'TEXTAREA') return true;
  if (node.isContentEditable) return true;
  if (tag !== 'INPUT') return false;
  return TEXTUAL_TYPES.has((node.getAttribute('type') || 'text').toLowerCase());
}

/** Best available evidence that the soft keyboard is actually showing.
 *
 *  There is no API for this. The usable proxy on Android WebView is that
 *  the visual viewport shrinks well below the layout viewport while the
 *  keyboard is up. The 0.75 threshold is deliberately generous: a false
 *  negative costs one extra Back press, a false positive silently eats a
 *  Back press, which is much worse. Requiring a focused text input as well
 *  means a short viewport for any other reason cannot trigger it. */
export function isKeyboardLikelyOpen(win = window) {
  if (!isTextInputFocused(win.document)) return false;
  const vv = win.visualViewport;
  if (!vv || !win.innerHeight) return false;
  return vv.height < win.innerHeight * 0.75;
}

/* ---------------------------------------------------------- bindings -- */

/** Escape closes the topmost overlay. A desktop convenience that falls out
 *  of the overlay stack for free, and the same code path Back exercises on
 *  Android -- so testing one covers most of the other. */
export function installEscapeHandler(target = window) {
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    if (dismissTopOverlay()) e.preventDefault();
  };
  target.addEventListener('keydown', onKey);
  return () => target.removeEventListener('keydown', onKey);
}

/** Wires the Android Back button to decideBack().
 *
 *  Off-native this is a no-op that resolves immediately: there is no Back
 *  button in a browser tab, the browser's own back arrow is plain history,
 *  and @capacitor/app has no meaningful web implementation to lean on.
 *
 *  The caller supplies everything environment-specific, which is also what
 *  makes this testable: a test can pass its own `app` double and drive the
 *  listener directly without Capacitor present at all.
 *
 *  @param currentPath    () => the active route path
 *  @param navigate       (path) => void, the app's own router entry point
 *  @param canGoBack      () => whether the app pushed a history entry
 *  @param historyBack    () => void
 *  @param closeDrawer    () => void
 *  @param isDrawerOpen   () => boolean
 *  @param contextParent  () => a better parent for the current screen, or null
 *  @param loadApp        () => Promise<{ App }>, injectable for tests
 *  @param native         () => boolean, injectable for tests
 *  @param beforeExit     () => boolean | Promise<boolean>; false keeps the app open
 */
export async function installBackHandler({
  currentPath,
  navigate,
  canGoBack = () => false,
  historyBack = () => window.history.back(),
  closeDrawer = () => {},
  isDrawerOpen = () => false,
  contextParent = () => null,
  keyboardOpen = () => isKeyboardLikelyOpen(),
  blurActive = () => document.activeElement?.blur?.(),
  resolveParent = parentOf,
  beforeExit = () => true,
  loadApp,
  native
} = {}) {
  const isNativeNow = native ? native() : false;
  if (!isNativeNow || !loadApp) return null;

  let App;
  try {
    ({ App } = await loadApp());
  } catch {
    // A missing plugin must never break the app's startup. Back then
    // behaves as it did before this module existed.
    return null;
  }

  let exiting = false;
  function exitSafely() {
    if (exiting) return;
    try {
      const allowed = beforeExit();
      if (allowed && typeof allowed.then === 'function') {
        exiting = true;
        return Promise.resolve(allowed).then(ok => {
          if (ok) return App.exitApp();
        }).catch(error => {
          console.error('Could not check pending edits before exit', error);
        }).finally(() => { exiting = false; });
      }
      if (allowed) return App.exitApp();
    } catch (error) {
      console.error('Could not check pending edits before exit', error);
    }
  }

  const handler = () => {
    const decision = decideBack({
      path: currentPath(),
      hasOverlay: overlayCount() > 0,
      isDrawerOpen: isDrawerOpen(),
      isKeyboardOpen: keyboardOpen(),
      // Deliberately our own count, not the `canGoBack` the plugin passes.
      // The WebView's answer also counts entries from before the app booted,
      // and going back into those leaves the app shell entirely -- which is
      // the exact bug this module exists to stop.
      canGoBack: canGoBack(),
      contextParent: contextParent(),
      resolveParent
    });

    switch (decision.action) {
      case BACK_CLOSE_OVERLAY:    dismissTopOverlay(); return;
      case BACK_CLOSE_DRAWER:     closeDrawer(); return;
      case BACK_DISMISS_KEYBOARD: blurActive(); return;
      case BACK_HISTORY:          historyBack(); return;
      case BACK_GO_PARENT:        navigate(decision.target); return;
      case BACK_EXIT:             return exitSafely();
      default:                    return exitSafely();
    }
  };

  const listener = await App.addListener('backButton', handler);
  return { remove: () => listener?.remove?.(), handler };
}
