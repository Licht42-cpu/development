/* Independent startup controller, loaded before the normal module entry.
   Keep that parser-discovered entry: changing it to a delayed dynamic import
   changes document-load ordering. Retry reloads rejected module graphs and
   never clears localStorage/IndexedDB or starts a second sender. */
(() => {
  const view = document.getElementById('view');
  let settled = false;
  function fail(error) {
    if (settled) return;
    settled = true;
    console.error('Nova Shield startup failed', error);
    // The field module may not have evaluated at all; its static "Online"
    // label and unwired controls must not suggest that startup succeeded.
    const badge = document.getElementById('syncBadge');
    if (badge) {
      badge.textContent = 'Startup unavailable';
      badge.className = 'sync-badge sync-badge--error';
      badge.setAttribute('role', 'status'); badge.removeAttribute('tabindex');
      badge.removeAttribute('aria-haspopup'); badge.inert = true;
    }
    for (const id of ['signOut', 'syncNow']) {
      const control = document.getElementById(id); if (control) control.disabled = true;
    }
    const brand = document.querySelector('.field-topbar__brand'); if (brand) brand.inert = true;
    const name = error?.name || '';
    const message = String(error?.message || error || 'Unknown error');
    const reason = /close other app tabs/i.test(message)
      ? 'Close other app tabs that may be using local storage, then retry.'
      : /quota|storage|indexeddb/i.test(name + ' ' + message)
      ? 'Local storage could not be opened. Check available device space and storage permissions, then retry.'
      : /plugin|capacitor|synapse/i.test(message)
        ? 'A device component could not start. Retry; if it continues, check for an app update or report the details below.'
        : /module|import|fetch|load|404/i.test(message)
          ? 'An app file could not load. Retry; if it continues, reconnect, check for an app update or report the details below.'
          : 'The app could not finish starting. Retry; if it continues, report the details below.';
    const box = document.createElement('section');
    box.className = 'card'; box.setAttribute('role', 'alert');
    const heading = document.createElement('h1'); heading.textContent = 'Could not start Nova Shield';
    const body = document.createElement('p'); body.textContent = reason;
    const saved = document.createElement('p'); saved.textContent = 'Retry leaves any previously saved outbox actions in place.';
    const details = document.createElement('details');
    const summary = document.createElement('summary'); summary.textContent = 'Technical details';
    const text = document.createElement('p'); text.textContent = message;
    text.style.overflowWrap = 'anywhere'; details.append(summary, text);
    const retry = document.createElement('button'); retry.className = 'btn btn--primary';
    retry.textContent = 'Retry startup'; retry.onclick = () => location.reload();
    box.append(heading, body, saved, details, retry); view.replaceChildren(box); retry.focus();
  }
  window.nsStartup = {
    watch(promise) {
      Promise.resolve(promise).then(() => { settled = true; }, fail);
    }
  };
  window.addEventListener('error', event => {
    if (settled) return;
    if (event.error) fail(event.error);
    else if (event.target?.tagName === 'SCRIPT' && event.target.type === 'module')
      fail(new Error(`An app module file could not load: ${event.target.src}`));
  }, true);
})();
