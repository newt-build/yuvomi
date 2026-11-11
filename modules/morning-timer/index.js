/**
 * Modul: Morgen-Timer (Modul des Familien-Forks, KEIN Kern-Patch)
 * Zweck: Die Morgenroutine als Abfolge von Schritten mit eigenem Countdown,
 *        einem echten Ausgangszeitpunkt (Deadline) und einem Abschluss, der
 *        sagt, ob es gereicht hat.
 *
 * ── WAS DIESE FASSUNG KANN (Rückmeldung Gabry, 2026-11-11) ──────────────
 *
 * Die erste Fassung war ein Abriss: fünf fest verdrahtete Schritte und eine
 * erfundene 25-Minuten-Grenze. Diese Fassung hat, was der Familien-Timer des
 * AgentOS auch hat, soweit es ohne Server geht:
 *
 *   - Schritte, die der Haushalt selbst anlegt und ändert (Name, Minuten, Art);
 *   - Dauerarten: fest, komprimierbar (mit Untergrenze), flexibel, optional;
 *   - eine echte Ausgangszeit statt einer erfundenen Gesamtgrenze;
 *   - pro Schritt ein eigener Countdown und die Restzeit bis zum Ausgang;
 *   - „Fatto" als einzige Handlung, die einen Schritt schließt - Ablaufen
 *     schließt nichts und bestraft nichts;
 *   - komprimierbare Schritte schrumpfen, wenn der Start spät war, aber nie
 *     unter ihre Untergrenze;
 *   - ein Abschluss mit Uhrzeit und dem Satz, ob es vor oder nach dem Ausgang war;
 *   - Wiederaufnahme nach Neuladen, stummschaltbarer Ton.
 *
 * ── WAS SIE WEITERHIN NICHT KANN, UND WARUM ─────────────────────────────
 *
 * Der Zustand liegt auf dem Gerät (localStorage), nicht auf dem Server. Damit
 * gibt es keine geräteübergreifende Anzeige, keine Punkte, keine Mission und
 * keinen Preiseintrag: ein Timer, der auf einem Gerät läuft, kann keine
 * Belohnung im Haushalt auslösen, ohne dass ein Server die Wahrheit hält.
 * Das ist die bewusste Grenze dieser Ausbaustufe, nicht ein Versehen.
 */

import { t } from '/i18n.js';
import { esc } from '/utils/html.js';

const CONFIG_KEY = 'yuvomi-morning-timer-config';
const RUN_KEY = 'yuvomi-morning-timer-run';
const SOUND_KEY = 'yuvomi-morning-timer-sound';

const KINDS = ['fixed', 'compressible', 'flexible', 'optional'];

/** Voreinstellung: eine gewöhnliche Schulmorgen-Routine. */
const DEFAULT_CONFIG = {
  participant: '',
  leaveAt: '07:50',
  steps: [
    { id: 's1', label: 'Svegliarsi e alzarsi', minutes: 5, kind: 'fixed', minimum: null },
    { id: 's2', label: 'Lavarsi i denti', minutes: 4, kind: 'compressible', minimum: 2 },
    { id: 's3', label: 'Vestirsi', minutes: 6, kind: 'compressible', minimum: 3 },
    { id: 's4', label: 'Colazione', minutes: 8, kind: 'compressible', minimum: 4 },
    { id: 's5', label: 'Zaino e scarpe', minutes: 4, kind: 'fixed', minimum: null },
    { id: 's6', label: 'Gioco finale', minutes: 5, kind: 'optional', minimum: null },
  ],
};

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch { return fallback; }
}
function writeJson(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch { /* privater Modus: der Timer läuft weiter, nur ohne Wiederaufnahme */ }
}

function mmss(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function clockOf(instant) {
  return new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit' }).format(new Date(instant));
}

/** Der Ausgang als Zeitpunkt von heute (oder morgen, wenn er schon vorbei ist). */
function deadlineFor(leaveAt, from = Date.now()) {
  const [h, m] = String(leaveAt || '07:50').split(':').map((x) => Number(x));
  const d = new Date(from);
  d.setHours(Number.isFinite(h) ? h : 7, Number.isFinite(m) ? m : 50, 0, 0);
  return d.getTime();
}

function readSound() { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; } }
function writeSound(on) { try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch { /* egal */ } }

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

/**
 * Wie viel Zeit der aktuelle Schritt bekommt.
 *
 * Ein `compressible` Schritt schrumpft, wenn der Start spät war - aber nur so
 * weit, wie es noch Platz gibt, und nie unter seine Untergrenze. Was danach
 * noch an Pflichtschritten kommt, bleibt reserviert: sonst würde der letzte
 * Schritt die Verspätung aller vorherigen erben.
 */
function stepBudget(step, remainingToDeadline, pendingAfter) {
  const planned = step.minutes * 60;
  if (step.kind !== 'compressible' && step.kind !== 'flexible') return planned;
  if (step.kind === 'flexible') return planned;
  const free = remainingToDeadline - pendingAfter;
  const floor = (step.minimum ?? 0) * 60;
  if (free >= planned) return planned;
  return Math.max(floor, free);
}

/** Summe der reservierten Zeit aller noch offenen Pflichtschritte nach `index`. */
function pendingAfterSeconds(steps, index) {
  return steps.slice(index + 1)
    .filter((s) => s.kind !== 'optional')
    .reduce((sum, s) => sum + (s.kind === 'compressible' ? (s.minimum ?? 0) * 60 : s.minutes * 60), 0);
}

export async function render(container, context) {
  const { signal } = context;
  let tick = null;
  let soundOn = readSound();

  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <div class="page-toolbar page-toolbar--narrow">
      <h1 class="page-toolbar__title">${esc(t('extensions.morning-timer.title'))}</h1>
      <div class="page-toolbar__actions">
        <button type="button" class="btn btn--secondary btn--sm" data-sound aria-pressed="${soundOn}">
          <i data-lucide="${soundOn ? 'volume-2' : 'volume-x'}" class="icon-sm" aria-hidden="true"></i>
          <span data-sound-label>${esc(t(`extensions.morning-timer.${soundOn ? 'soundOn' : 'soundOff'}`))}</span>
        </button>
      </div>
    </div>
    <div class="app-page__body">
      <section class="page-section page-measure mt" data-root></section>
    </div>`);
  if (window.lucide) window.lucide.createIcons({ el: container });

  const root = container.querySelector('[data-root]');
  const soundBtn = container.querySelector('[data-sound]');

  soundBtn?.addEventListener('click', () => {
    soundOn = !soundOn;
    writeSound(soundOn);
    soundBtn.setAttribute('aria-pressed', String(soundOn));
    soundBtn.querySelector('i')?.setAttribute('data-lucide', soundOn ? 'volume-2' : 'volume-x');
    const label = soundBtn.querySelector('[data-sound-label]');
    if (label) label.textContent = t(`extensions.morning-timer.${soundOn ? 'soundOn' : 'soundOff'}`);
    if (window.lucide) window.lucide.createIcons({ el: soundBtn });
  }, { signal });

  function config() {
    const cfg = readJson(CONFIG_KEY, null) ?? DEFAULT_CONFIG;
    return { ...DEFAULT_CONFIG, ...cfg, steps: Array.isArray(cfg.steps) && cfg.steps.length ? cfg.steps : DEFAULT_CONFIG.steps };
  }

  function paint() {
    if (!root.isConnected) return;
    const run = readJson(RUN_KEY, null);
    if (run?.startedAt) paintRun(run, config());
    else paintSetup(config());
  }

  // ── Einrichtung ────────────────────────────────────────────────────────
  function paintSetup(cfg) {
    root.replaceChildren();
    root.insertAdjacentHTML('beforeend', `
      <p class="mt__intro">${esc(t('extensions.morning-timer.intro'))}</p>
      <div class="mt__setup-row">
        <label class="mt__field">
          <span>${esc(t('extensions.morning-timer.participant'))}</span>
          <input type="text" data-cfg="participant" value="${esc(cfg.participant ?? '')}" placeholder="${esc(t('extensions.morning-timer.participantPlaceholder'))}">
        </label>
        <label class="mt__field">
          <span>${esc(t('extensions.morning-timer.leaveAt'))}</span>
          <input type="time" data-cfg="leaveAt" value="${esc(cfg.leaveAt)}">
        </label>
      </div>
      <ul class="mt__steps mt__steps--setup">
        ${cfg.steps.map((s, i) => `
          <li class="mt__step mt__step--edit" data-step="${esc(s.id)}">
            <input type="text" data-step-field="label" data-index="${i}" value="${esc(s.label)}" aria-label="${esc(t('extensions.morning-timer.stepName'))}">
            <input type="number" min="0" max="120" step="1" data-step-field="minutes" data-index="${i}" value="${esc(String(s.minutes))}" aria-label="${esc(t('extensions.morning-timer.stepMinutes'))}">
            <select data-step-field="kind" data-index="${i}" aria-label="${esc(t('extensions.morning-timer.stepKind'))}">
              ${KINDS.map((k) => `<option value="${k}" ${s.kind === k ? 'selected' : ''}>${esc(t(`extensions.morning-timer.kind.${k}`))}</option>`).join('')}
            </select>
            <input type="number" min="0" max="120" step="1" data-step-field="minimum" data-index="${i}"
                   value="${s.minimum == null ? '' : esc(String(s.minimum))}" placeholder="${esc(t('extensions.morning-timer.stepMinimum'))}"
                   aria-label="${esc(t('extensions.morning-timer.stepMinimum'))}" ${s.kind === 'compressible' ? '' : 'disabled'}>
            <button type="button" class="btn btn--danger-outline btn--sm" data-remove="${i}" aria-label="${esc(t('extensions.morning-timer.removeStep'))}">
              <i data-lucide="trash-2" class="icon-sm" aria-hidden="true"></i>
            </button>
          </li>`).join('')}
      </ul>
      <div class="mt__setup-actions">
        <button type="button" class="btn btn--secondary btn--sm" data-add-step>
          <i data-lucide="plus" class="icon-sm" aria-hidden="true"></i>${esc(t('extensions.morning-timer.addStep'))}
        </button>
        <button type="button" class="btn btn--primary" data-start>
          <i data-lucide="play" class="icon-md" aria-hidden="true"></i>${esc(t('extensions.morning-timer.start'))}
        </button>
      </div>`);
    if (window.lucide) window.lucide.createIcons({ el: root });

    const save = () => {
      const next = {
        participant: root.querySelector('[data-cfg="participant"]').value.trim(),
        leaveAt: root.querySelector('[data-cfg="leaveAt"]').value || '07:50',
        steps: cfg.steps,
      };
      writeJson(CONFIG_KEY, next);
    };

    root.querySelector('[data-cfg="participant"]')?.addEventListener('change', save, { signal });
    root.querySelector('[data-cfg="leaveAt"]')?.addEventListener('change', () => { save(); }, { signal });

    root.querySelectorAll('[data-step-field]').forEach((el) => {
      el.addEventListener('change', () => {
        const i = Number(el.getAttribute('data-index'));
        const field = el.getAttribute('data-step-field');
        const step = cfg.steps[i];
        if (!step) return;
        if (field === 'minutes' || field === 'minimum') {
          const v = el.value === '' ? null : Math.max(0, Math.min(120, Number(el.value)));
          step[field] = v;
        } else if (field === 'kind') {
          step.kind = KINDS.includes(el.value) ? el.value : 'fixed';
          save();
          paintSetup(config());
          return;
        } else {
          step[field] = el.value.trim() || t('extensions.morning-timer.untitledStep');
        }
        save();
      }, { signal });
    });

    root.querySelectorAll('[data-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.getAttribute('data-remove'));
        cfg.steps.splice(i, 1);
        save();
        paintSetup(config());
      }, { signal });
    });

    root.querySelector('[data-add-step]')?.addEventListener('click', () => {
      cfg.steps.push({ id: `s${Date.now()}`, label: t('extensions.morning-timer.newStep'), minutes: 5, kind: 'fixed', minimum: null });
      save();
      paintSetup(config());
    }, { signal });

    root.querySelector('[data-start]')?.addEventListener('click', () => {
      const c = config();
      const startedAt = Date.now();
      const deadline = deadlineFor(c.leaveAt, startedAt);
      const first = c.steps[0];
      const budget = first
        ? (first.kind === 'optional'
          ? first.minutes * 60
          : stepBudget(first, (deadline - startedAt) / 1000, pendingAfterSeconds(c.steps, 0)))
        : 0;
      writeJson(RUN_KEY, {
        startedAt, deadline, done: [], skipped: [],
        stepStartedAt: startedAt, stepEndsAt: startedAt + budget * 1000,
      });
      paint();
    }, { signal });
  }

  // ── Lauf ───────────────────────────────────────────────────────────────
  function paintRun(run, cfg) {
    const now = Date.now();
    const done = new Set(run.done ?? []);
    const skipped = new Set(run.skipped ?? []);
    const steps = cfg.steps;
    const currentIndex = steps.findIndex((s) => !done.has(s.id) && !skipped.has(s.id));
    const remainingToDeadline = (run.deadline - now) / 1000;
    const elapsedOverall = (now - run.startedAt) / 1000;
    const step = currentIndex >= 0 ? steps[currentIndex] : null;

    // BUDGET WIRD EINMAL BEIM SCHRITTSTART GERECHNET, NICHT BEI JEDEM TAKT.
    // Sonst schrumpfte die Restzeit mit der Restzeit: wer 40 Sekunden zusieht,
    // verloere mehr als 40 Sekunden Countdown, weil das Budget aus dem bereits
    // geschmolzenen Rest neu berechnet wuerde. `stepEndsAt` ist der Anker und
    // steht im gespeicherten Lauf.
    let stepEndsAt = run.stepEndsAt ?? null;
    if (step && stepEndsAt == null) {
      const budget = step.kind === 'optional'
        ? step.minutes * 60
        : stepBudget(step, remainingToDeadline, pendingAfterSeconds(steps, currentIndex));
      stepEndsAt = (run.stepStartedAt ?? run.startedAt) + budget * 1000;
    }
    const stepRemaining = step && stepEndsAt ? (stepEndsAt - now) / 1000 : null;
    const finished = currentIndex === -1;

    root.replaceChildren();
    root.insertAdjacentHTML('beforeend', `
      <div class="mt__head ${remainingToDeadline <= 0 ? 'mt__head--over' : ''}">
        <div>
          <span class="mt__head-label">${esc(t('extensions.morning-timer.leaveAt'))}</span>
          <span class="mt__head-value">${esc(clockOf(run.deadline))}</span>
        </div>
        <div>
          <span class="mt__head-label">${esc(t(remainingToDeadline <= 0 ? 'extensions.morning-timer.overLimit' : 'extensions.morning-timer.remaining'))}</span>
          <span class="mt__head-value">${esc(remainingToDeadline <= 0 ? `+${mmss(-remainingToDeadline)}` : mmss(remainingToDeadline))}</span>
        </div>
        <div>
          <span class="mt__head-label">${esc(t('extensions.morning-timer.elapsed'))}</span>
          <span class="mt__head-value">${esc(mmss(elapsedOverall))}</span>
        </div>
        ${cfg.participant ? `<div><span class="mt__head-label">${esc(t('extensions.morning-timer.participant'))}</span><span class="mt__head-value">${esc(cfg.participant)}</span></div>` : ''}
      </div>

      ${finished ? renderSummary(run, cfg) : `
        <ol class="mt__steps">
          ${steps.map((s, i) => {
            const isDone = done.has(s.id);
            const isSkipped = skipped.has(s.id);
            const isCurrent = i === currentIndex;
            const over = isCurrent && stepRemaining != null && stepRemaining <= 0;
            return `
              <li class="mt__step ${isDone ? 'is-done' : ''} ${isSkipped ? 'is-skipped' : ''} ${isCurrent ? 'is-current' : ''} ${over ? 'is-over' : ''}">
                <span class="mt__step-mark" aria-hidden="true">${isDone ? '✓' : isSkipped ? '–' : i + 1}</span>
                <span class="mt__step-label">${esc(s.label)}</span>
                <span class="mt__step-meta">
                  ${isCurrent && stepRemaining != null
                    ? `<strong>${esc(stepRemaining <= 0 ? `+${mmss(-stepRemaining)}` : mmss(stepRemaining))}</strong>`
                    : `<span>${esc(String(s.minutes))}′</span>`}
                  <span class="mt__step-kind">${esc(t(`extensions.morning-timer.kind.${s.kind}`))}</span>
                </span>
                ${isCurrent ? `
                  <span class="mt__step-actions">
                    <button type="button" class="btn btn--primary btn--sm" data-done="${esc(s.id)}">${esc(t('extensions.morning-timer.done'))}</button>
                    ${s.kind === 'optional' ? `<button type="button" class="btn btn--secondary btn--sm" data-skip="${esc(s.id)}">${esc(t('extensions.morning-timer.skip'))}</button>` : ''}
                  </span>` : ''}
              </li>`;
          }).join('')}
        </ol>`}

      <div class="mt__foot">
        <button type="button" class="btn btn--secondary btn--sm" data-restart>${esc(t('extensions.morning-timer.reset'))}</button>
        <button type="button" class="btn btn--secondary btn--sm" data-edit>${esc(t('extensions.morning-timer.editRoutine'))}</button>
      </div>`);
    if (window.lucide) window.lucide.createIcons({ el: root });

    root.querySelectorAll('[data-done]').forEach((btn) => btn.addEventListener('click', () => close(btn.getAttribute('data-done'), 'done'), { signal }));
    root.querySelectorAll('[data-skip]').forEach((btn) => btn.addEventListener('click', () => close(btn.getAttribute('data-skip'), 'skip'), { signal }));
    root.querySelector('[data-restart]')?.addEventListener('click', () => { writeJson(RUN_KEY, null); paint(); }, { signal });
    root.querySelector('[data-edit]')?.addEventListener('click', () => { writeJson(RUN_KEY, null); paint(); }, { signal });
  }

  function renderSummary(run, cfg) {
    const finishedAt = run.finishedAt ?? Date.now();
    const within = finishedAt <= run.deadline;
    const skippedCount = (run.skipped ?? []).length;
    const doneCount = (run.done ?? []).length;
    return `
      <div class="mt__summary ${within ? 'mt__summary--ok' : 'mt__summary--late'}">
        <p class="mt__summary-title">${esc(t(within ? 'extensions.morning-timer.summaryWithin' : 'extensions.morning-timer.summaryLate')
          .replace('{time}', clockOf(finishedAt))
          .replace('{leaveAt}', clockOf(run.deadline)))}</p>
        <p class="mt__summary-line">${esc(t('extensions.morning-timer.summarySteps')
          .replace('{done}', String(doneCount))
          .replace('{total}', String(cfg.steps.length))
          .replace('{skipped}', String(skippedCount)))}</p>
        ${cfg.participant ? `<p class="mt__summary-line">${esc(cfg.participant)}</p>` : ''}
      </div>`;
  }

  /** „Fatto" (und Überspringen eines optionalen Schritts) - der einzige Weg weiter. */
  function close(stepId, mode) {
    const run = readJson(RUN_KEY, null);
    if (!run?.startedAt) return;
    const done = new Set(run.done ?? []);
    const skipped = new Set(run.skipped ?? []);
    if (mode === 'skip') skipped.add(stepId); else done.add(stepId);

    const cfg = config();
    const remaining = cfg.steps.filter((s) => !done.has(s.id) && !skipped.has(s.id));
    const now = Date.now();
    // Der naechste Schritt bekommt sein Budget JETZT, einmalig, mit der dann
    // gueltigen Restzeit bis zum Ausgang - nicht bei jedem Takt neu.
    let nextEndsAt = null;
    if (remaining.length) {
      const next = remaining[0];
      const index = cfg.steps.findIndex((s) => s.id === next.id);
      const budget = next.kind === 'optional'
        ? next.minutes * 60
        : stepBudget(next, (run.deadline - now) / 1000, pendingAfterSeconds(cfg.steps, index));
      nextEndsAt = now + budget * 1000;
    }

    writeJson(RUN_KEY, {
      ...run,
      done: [...done],
      skipped: [...skipped],
      stepStartedAt: now,
      stepEndsAt: nextEndsAt,
      finishedAt: remaining.length ? null : now,
    });
    if (mode === 'done') beep();
    paint();
  }

  tick = setInterval(() => {
    if (!root.isConnected) { clearInterval(tick); return; }
    paint();
  }, 1000);
  signal.addEventListener('abort', () => clearInterval(tick), { once: true });

  paint();
}
