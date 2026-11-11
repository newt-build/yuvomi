/**
 * Modul: Logopedia (modulo custom Yuvomi, famiglia AgentOS)
 * Zweck: Eine Uebungssitzung mit den freigegebenen Woertern des Logopedia-
 *        Katalogs — sechs Fokusgruppen der /r/-Lautarbeit.
 *
 * ── WO DIE WOERTER HERKOMMEN ────────────────────────────────────────────
 *
 * words.js ist eine wortgetreue Kopie von 149 Woertern aus dem freigegebenen
 * Katalog des bestehenden Logopedia-Domains (packages/logopedia/src/content-src
 * /words.ts, `wordManifest` mit reviewState 'approved'). In diesem Modul wurde
 * KEIN Wort erfunden und keines umgruppiert: die sechs Fokusgruppen sind die
 * des Katalogs.
 *
 * ── WAS DIESE SITZUNG IST UND WAS NICHT ─────────────────────────────────
 *
 * Sie ist eine Uebung auf dem Geraet: Woerter nacheinander zeigen, das Kind
 * spricht, ein Erwachsener oder das Kind tippt "Geschafft" oder "Noch ueben".
 * Der Zustand liegt lokal (localStorage), wie beim Morgen-Timer.
 *
 * BEWUSST NICHT ENTHALTEN: keine Punkte, keine Bestenliste, keine Strafe, kein
 * Urteil ueber das Kind. "Noch ueben" ist keine Niederlage, sondern die Notiz,
 * dass ein Wort spaeter wiederkommt. Es gibt auch keine Erwachsenen-Diagnostik
 * und keinen Tonvergleich: das Modul hoert nicht zu und bewertet keine
 * Aussprache. Die ausfuehrliche Sitzungs- und Auswertungslogik des AgentOS-
 * Domains bleibt dort, wo sie ist.
 */

import { t } from '/i18n.js';
import { esc } from '/utils/html.js';
import { WORDS } from './words.js';

const STATE_KEY = 'yuvomi-logopedia-session';
const WORDS_PER_SESSION = 10;

const FOCUSES = ['tr_dr', 'pr_br', 'cr_gr_fr', 'r_iniziale', 'r_intervocalica', 'rr_doppia'];

function readState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

function writeState(state) {
  try {
    if (state === null) localStorage.removeItem(STATE_KEY);
    else localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch { /* privater Modus */ }
}

/** Mischt deterministisch genug fuer eine Sitzung, aber ohne Server-Zufall. */
function pickWords(focus, count) {
  const pool = [...(WORDS[focus] ?? [])];
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(count, pool.length));
}

export async function render(container, context) {
  const { signal } = context;
  let timer = null;

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="page-toolbar page-toolbar--narrow">
      <h1 class="page-toolbar__title">${esc(t('extensions.logopedia.title'))}</h1>
    </div>
    <div class="app-page__body">
      <section class="page-section page-measure logopedia" data-logo-root></section>
    </div>`);
  if (window.lucide) window.lucide.createIcons({ el: container });

  const root = container.querySelector('[data-logo-root]');

  function paint() {
    if (!root.isConnected) return;
    const state = readState();

    // ── Startbildschirm: Fokus waehlen ──
    if (!state) {
      root.replaceChildren();
      root.insertAdjacentHTML('beforeend', `
        <p class="logopedia__intro">${esc(t('extensions.logopedia.intro'))}</p>
        <div class="logopedia__focuses">
          ${FOCUSES.map((f) => `
            <button type="button" class="logopedia__focus" data-focus="${esc(f)}">
              <span class="logopedia__focus-title">${esc(t(`extensions.logopedia.focus.${f}`))}</span>
              <span class="logopedia__focus-count">${esc(t('extensions.logopedia.wordCount').replace('{count}', String((WORDS[f] ?? []).length)))}</span>
            </button>`).join('')}
        </div>`);
      if (window.lucide) window.lucide.createIcons({ el: root });
      root.querySelectorAll('[data-focus]').forEach((btn) => {
        btn.addEventListener('click', () => begin(btn.getAttribute('data-focus')), { signal });
      });
      return;
    }

    // ── Sitzung: ein Wort, zwei Knoepfe ──
    const words = state.words ?? [];
    const index = state.index ?? 0;
    const current = words[index];

    if (!current) {
      finish(state);
      return;
    }

    root.replaceChildren();
    root.insertAdjacentHTML('beforeend', `
      <div class="logopedia__session-head">
        <span class="logopedia__progress">${esc(t('extensions.logopedia.progress')
          .replace('{current}', String(index + 1)).replace('{total}', String(words.length)))}</span>
        <button type="button" class="btn btn--secondary btn--sm" data-logo-stop>${esc(t('extensions.logopedia.stop'))}</button>
      </div>
      <p class="logopedia__word" lang="it">${esc(current)}</p>
      <p class="logopedia__hint">${esc(t('extensions.logopedia.sayItAloud'))}</p>
      <div class="logopedia__actions">
        <button type="button" class="btn btn--primary" data-logo-done>${esc(t('extensions.logopedia.done'))}</button>
        <button type="button" class="btn btn--secondary" data-logo-again>${esc(t('extensions.logopedia.practiseAgain'))}</button>
      </div>`);
    if (window.lucide) window.lucide.createIcons({ el: root });

    root.querySelector('[data-logo-done]')?.addEventListener('click', () => advance(state, true), { signal });
    root.querySelector('[data-logo-again]')?.addEventListener('click', () => advance(state, false), { signal });
    root.querySelector('[data-logo-stop]')?.addEventListener('click', () => { writeState(null); paint(); }, { signal });
  }

  function begin(focus) {
    writeState({ focus, words: pickWords(focus, WORDS_PER_SESSION), index: 0, done: [], again: [] });
    paint();
  }

  function advance(state, done) {
    const word = state.words[state.index];
    const next = {
      ...state,
      index: state.index + 1,
      done: done ? [...(state.done ?? []), word] : (state.done ?? []),
      again: done ? (state.again ?? []) : [...(state.again ?? []), word],
    };
    writeState(next);
    paint();
  }

  function finish(state) {
    const done = state.done ?? [];
    const again = state.again ?? [];
    root.replaceChildren();
    root.insertAdjacentHTML('beforeend', `
      <p class="logopedia__finished">${esc(t('extensions.logopedia.finished'))}</p>
      <div class="logopedia__summary">
        <p>${esc(t('extensions.logopedia.summaryDone').replace('{count}', String(done.length)))}</p>
        ${again.length ? `<p>${esc(t('extensions.logopedia.summaryAgain'))}</p>
          <ul class="logopedia__again-list">${again.map((w) => `<li lang="it">${esc(w)}</li>`).join('')}</ul>` : ''}
      </div>
      <div class="logopedia__actions">
        <button type="button" class="btn btn--primary" data-logo-new>${esc(t('extensions.logopedia.newSession'))}</button>
      </div>`);
    root.querySelector('[data-logo-new]')?.addEventListener('click', () => { writeState(null); paint(); }, { signal });
  }

  // Kein Takt noetig: diese Seite hat keine laufende Zeit. Der Timer bleibt
  // trotzdem definiert, damit ein Abbruch sauber aufraeumt.
  timer = setInterval(() => { if (!root.isConnected) clearInterval(timer); }, 5000);
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });

  paint();
}
