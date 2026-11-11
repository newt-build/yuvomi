/**
 * Modul: Timer mattutino (modulo custom Yuvomi, famiglia AgentOS)
 * Zweck: Die Morgenroutine als Sequenz von Schritten mit eigenem Countdown und
 *        einem absoluten Limit. "Fatto" ist eine ausdrueckliche Handlung des
 *        Kindes, kein automatisches Ablaufen.
 *
 * ── WAS DIESER MODUL IST UND WAS NICHT ──────────────────────────────────
 *
 * Er ist ein Modul, keine Aenderung am Kern: der Timer ueberlebt jedes Upgrade
 * des Forks, weil Yuvomi Module aus modules/ laedt, ohne den Kern zu patchen.
 *
 * DER ZUSTAND LIEGT AUF DEM GERAET (localStorage), wie beim Wandtimer des
 * Kerns. Das ist eine bewusste Grenze des ersten Increments: kein Server, keine
 * geraeteuebergreifende Anzeige, und vor allem KEINE Punkte, keine Mission und
 * kein Preiseintrag. Ein abgelaufener Countdown erledigt nichts - nur "Fatto".
 * Wer den Schritt oeffnet, findet ihn nach einem Neuladen wieder vor.
 *
 * ── ZEIT IST NUR EIN ENDPUNKT ───────────────────────────────────────────
 *
 * Gespeichert wird der Endzeitpunkt des laufenden Schritts und der Startzeit-
 * punkt des Laufs. Alles andere (Restzeit, ob das Limit ueberschritten ist)
 * wird bei jedem Aufbau neu gerechnet. Ein Zustand im DOM waere beim naechsten
 * Aufbau weg, einer im Modul beim naechsten Laden der Seite.
 */

import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

const STATE_KEY = 'yuvomi-morning-timer';
const SOUND_KEY = 'yuvomi-morning-timer-sound';

/** Die Schritte der Routine. Reihenfolge = Reihenfolge des Morgens. */
const STEPS = [
  { id: 'wake', labelKey: 'stepWake', seconds: 300, icon: 'sun' },
  { id: 'teeth', labelKey: 'stepTeeth', seconds: 240, icon: 'sparkles' },
  { id: 'dress', labelKey: 'stepDress', seconds: 300, icon: 'shirt' },
  { id: 'bag', labelKey: 'stepBag', seconds: 180, icon: 'backpack' },
  { id: 'shoes', labelKey: 'stepShoes', seconds: 120, icon: 'footprints' },
];

/** Das absolute Limit des ganzen Morgens, in Minuten. */
const ABSOLUTE_LIMIT_MINUTES = 25;

function readState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeState(state) {
  try {
    if (state === null) localStorage.removeItem(STATE_KEY);
    else localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch { /* privater Modus: Timer laeuft trotzdem, nur ohne Wiederaufnahme */ }
}

function readSound() {
  try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; }
}
function writeSound(on) {
  try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch { /* egal */ }
}

function mmss(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Ein kurzer Ton am Schrittende. Kein Audio-File, kein CDN: ein Oszillator,
 * damit das Modul keine zweite Ressource braucht und offline bleibt.
 */
function beep() {
  if (!readSound()) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.value = 0.06;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.18);
    setTimeout(() => ctx.close(), 400);
  } catch { /* Ton ist nicht kritisch */ }
}

export async function render(container, context) {
  const { signal } = context;
  let timer = null;
  let soundOn = readSound();

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="page-toolbar page-toolbar--narrow">
      <h1 class="page-toolbar__title">${esc(t('extensions.morning-timer.title'))}</h1>
      <div class="page-toolbar__actions">
        <button type="button" class="btn btn--secondary btn--sm" data-timer-sound aria-pressed="${soundOn}">
          <i data-lucide="${soundOn ? 'volume-2' : 'volume-x'}" class="icon-sm" aria-hidden="true"></i>
          <span data-sound-label>${esc(t(`extensions.morning-timer.${soundOn ? 'soundOn' : 'soundOff'}`))}</span>
        </button>
      </div>
    </div>
    <div class="app-page__body">
      <section class="page-section page-measure morning-timer" data-timer-root></section>
    </div>`);
  if (window.lucide) window.lucide.createIcons({ el: container });

  const root = container.querySelector('[data-timer-root]');
  const soundButton = container.querySelector('[data-timer-sound]');

  soundButton?.addEventListener('click', () => {
    soundOn = !soundOn;
    writeSound(soundOn);
    soundButton.setAttribute('aria-pressed', String(soundOn));
    soundButton.querySelector('i')?.setAttribute('data-lucide', soundOn ? 'volume-2' : 'volume-x');
    const label = soundButton.querySelector('[data-sound-label]');
    if (label) label.textContent = t(`extensions.morning-timer.${soundOn ? 'soundOn' : 'soundOff'}`);
    if (window.lucide) window.lucide.createIcons({ el: soundButton });
  }, { signal });

  /** Neuzeichnen: rechnet alles aus dem gespeicherten Zustand. */
  function paint() {
    const state = readState();
    if (!root.isConnected) return;

    if (!state) {
      root.replaceChildren();
      root.insertAdjacentHTML('beforeend', `
        <p class="morning-timer__intro">${esc(t('extensions.morning-timer.intro'))}</p>
        <ol class="morning-timer__steps">
          ${STEPS.map((s) => `
            <li class="morning-timer__step">
              <i data-lucide="${esc(s.icon)}" class="icon-md" aria-hidden="true"></i>
              <span>${esc(t(`extensions.morning-timer.${s.labelKey}`))}</span>
              <span class="morning-timer__budget">${esc(mmss(s.seconds))}</span>
            </li>`).join('')}
        </ol>
        <button type="button" class="btn btn--primary morning-timer__start" data-timer-start>
          <i data-lucide="play" class="icon-md" aria-hidden="true"></i>
          ${esc(t('extensions.morning-timer.start'))}
        </button>`);
      if (window.lucide) window.lucide.createIcons({ el: root });
      root.querySelector('[data-timer-start]')?.addEventListener('click', start, { signal });
      return;
    }

    const now = Date.now();
    const done = new Set(state.done ?? []);
    const elapsedOverall = (now - state.startedAt) / 1000;
    const overLimit = elapsedOverall > ABSOLUTE_LIMIT_MINUTES * 60;
    const currentIndex = STEPS.findIndex((s) => !done.has(s.id));

    root.replaceChildren();
    root.insertAdjacentHTML('beforeend', `
      <div class="morning-timer__head ${overLimit ? 'morning-timer__head--over' : ''}">
        <span class="morning-timer__head-label">${esc(t(overLimit ? 'extensions.morning-timer.overLimit' : 'extensions.morning-timer.remaining'))}</span>
        <span class="morning-timer__head-value">${esc(mmss(ABSOLUTE_LIMIT_MINUTES * 60 - elapsedOverall))}</span>
      </div>
      <ol class="morning-timer__steps">
        ${STEPS.map((s, index) => {
          const isDone = done.has(s.id);
          const isCurrent = index === currentIndex && !isDone;
          const remaining = isCurrent && state.stepEndsAt ? (state.stepEndsAt - now) / 1000 : null;
          const stepOver = remaining != null && remaining <= 0;
          return `
            <li class="morning-timer__step ${isDone ? 'is-done' : ''} ${isCurrent ? 'is-current' : ''} ${stepOver ? 'is-over' : ''}">
              <i data-lucide="${isDone ? 'check' : esc(s.icon)}" class="icon-md" aria-hidden="true"></i>
              <span class="morning-timer__step-label">${esc(t(`extensions.morning-timer.${s.labelKey}`))}</span>
              <span class="morning-timer__budget">${isCurrent && remaining != null ? esc(mmss(remaining)) : esc(mmss(s.seconds))}</span>
              ${isCurrent ? `
                <button type="button" class="btn btn--primary btn--sm" data-timer-done="${esc(s.id)}">
                  ${esc(t('extensions.morning-timer.done'))}
                </button>` : ''}
            </li>`;
        }).join('')}
      </ol>
      ${currentIndex === -1 ? `
        <p class="morning-timer__finished">${esc(t('extensions.morning-timer.finished'))}</p>` : ''}
      <button type="button" class="btn btn--secondary btn--sm morning-timer__reset" data-timer-reset>
        ${esc(t('extensions.morning-timer.reset'))}
      </button>`);
    if (window.lucide) window.lucide.createIcons({ el: root });

    root.querySelectorAll('[data-timer-done]').forEach((btn) => {
      btn.addEventListener('click', () => complete(btn.getAttribute('data-timer-done')), { signal });
    });
    root.querySelector('[data-timer-reset]')?.addEventListener('click', () => {
      writeState(null);
      paint();
    }, { signal });
  }

  function start() {
    const now = Date.now();
    const first = STEPS[0];
    writeState({ startedAt: now, stepEndsAt: now + first.seconds * 1000, done: [] });
    paint();
  }

  /** "Fatto": der einzige Weg, einen Schritt zu beenden. Ablaufen erledigt nichts. */
  function complete(stepId) {
    const state = readState();
    if (!state) return;
    const done = new Set(state.done ?? []);
    done.add(stepId);
    const next = STEPS.find((s) => !done.has(s.id));
    const now = Date.now();
    writeState({
      ...state,
      done: [...done],
      stepEndsAt: next ? now + next.seconds * 1000 : null,
    });
    beep();
    paint();
  }

  // Ein Takt genuegt: paint() rechnet aus dem Zustand, ein Zustand im DOM gibt
  // es nicht. Bei jedem Takt wird nur die Anzeige aktualisiert.
  timer = setInterval(() => {
    if (!root.isConnected) { clearInterval(timer); return; }
    paint();
  }, 1000);
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });

  paint();
}
