/** Extensible multi-app drawer. Family stays mounted; secondary frames are lazy and retained. */
import { api } from '/api.js';

export function mountFamilyApps({ familyRoot, host = document.body }) {
  const controller = new AbortController(), { signal } = controller;
  const root = document.createElement('div'); root.className = 'family-apps';
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'family-apps__toggle';
  toggle.textContent = '▦ Apps'; toggle.setAttribute('aria-haspopup', 'dialog');
  const home = document.createElement('button'); home.type = 'button'; home.className = 'family-apps__home';
  home.textContent = '⌂ Family'; home.hidden = true;
  const dialog = document.createElement('dialog'); dialog.className = 'family-apps__drawer';
  dialog.setAttribute('aria-label', 'Apps');
  const heading = document.createElement('h2'); heading.textContent = 'Apps';
  const close = document.createElement('button'); close.type = 'button'; close.className = 'btn btn--secondary'; close.textContent = 'Chiudi';
  const search = document.createElement('input'); search.type = 'search'; search.placeholder = 'Cerca un’app'; search.setAttribute('aria-label', 'Cerca un’app');
  const list = document.createElement('div'); list.className = 'family-apps__list';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  dialog.append(heading, close, search, list, status); root.append(toggle, home, dialog); host.append(root);
  const frames = new Map();
  let apps = [], active = 'family', loaded = false;
  const family = { id: 'family', label: 'Family' };

  function focusApp(id) {
    if (id !== 'family' && !apps.some(app => app.id === id)) return;
    active = id;
    if (id !== 'family' && !frames.has(id)) {
      const app = apps.find(value => value.id === id);
      const frame = document.createElement('iframe'); frame.className = 'family-apps__frame'; frame.title = app.label;
      frame.referrerPolicy = 'no-referrer';
      frame.setAttribute('sandbox', app.isolation === 'household' ? 'allow-scripts allow-same-origin allow-forms' : 'allow-scripts');
      frame.src = app.url; root.prepend(frame); frames.set(id, frame);
    }
    for (const [key, frame] of frames) frame.hidden = key !== id;
    familyRoot.inert = id !== 'family';
    if (id === 'family') familyRoot.removeAttribute('aria-hidden'); else familyRoot.setAttribute('aria-hidden', 'true');
    home.hidden = id === 'family';
    dialog.close();
    if (id === 'family') toggle.focus(); else home.focus();
    // Switching never deletes a frame or resets an application session.
  }
  function paint() {
    list.replaceChildren();
    const filter = search.value.trim().toLocaleLowerCase();
    const visible = [family, ...apps].filter(app => app.label.toLocaleLowerCase().includes(filter));
    for (const app of visible) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'family-apps__app';
      button.textContent = app.label; button.setAttribute('aria-pressed', String(active === app.id));
      button.addEventListener('click', () => focusApp(app.id), { signal }); list.append(button);
    }
    status.textContent = visible.length ? '' : 'Nessuna app corrispondente.';
  }
  async function open() {
    if (!dialog.open) dialog.showModal();
    if (!loaded) {
      status.textContent = 'Carico le app…';
      try {
        const data = await api.get('/family-apps', { signal });
        if (signal.aborted) return;
        apps = data.apps; loaded = true;
      } catch (error) {
        if (!signal.aborted) { status.textContent = error.message || 'Catalogo app non disponibile. Riapri per riprovare.'; paintFamilyOnly(); }
        return;
      }
    }
    paint(); search.focus();
  }
  function paintFamilyOnly() {
    list.replaceChildren();
    const button = document.createElement('button'); button.type = 'button'; button.textContent = '⌂ Family'; button.className = 'family-apps__app';
    button.addEventListener('click', () => focusApp('family'), { signal }); list.append(button);
  }
  toggle.addEventListener('click', () => void open(), { signal });
  home.addEventListener('click', () => focusApp('family'), { signal });
  close.addEventListener('click', () => dialog.close(), { signal });
  search.addEventListener('input', paint, { signal });
  window.addEventListener('message', event => {
    if (active === 'family' || !event.data || event.data.type !== 'family:request-home' || event.data.appId !== active) return;
    const app = apps.find(value => value.id === active), frame = frames.get(active);
    // No messages from arbitrary windows/origins and no opaque isolated games.
    if (app?.isolation !== 'household' || event.source !== frame?.contentWindow
      || event.origin !== new URL(app.url, window.location.href).origin) return;
    focusApp('family');
  }, { signal });
  return {
    destroy() {
      controller.abort(); if (dialog.open) dialog.close();
      for (const frame of frames.values()) frame.remove(); frames.clear();
      familyRoot.inert = false; familyRoot.removeAttribute('aria-hidden'); root.remove();
    },
  };
}
