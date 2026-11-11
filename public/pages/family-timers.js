/** Native Family timer: server-owned runs, participant selection and independent split lanes. */
import { api } from '/api.js';
import { esc } from '/utils/html.js';
import { readTimerTiming, formatTimerDuration, illustrationForStep } from '/utils/family-timer-timing.js';

const ROOT = '/tasks/timers';
const RUN_IDS = 'family-native-timer:run-ids';
const art = key => `/assets/family-timer/${key}.svg`;
const clock = (instant, zone) => new Intl.DateTimeFormat('it-IT', { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(instant));
function remember(runs) {
  try { localStorage.setItem(RUN_IDS, JSON.stringify(runs.map(run => run.id))); } catch { /* Server remains authoritative. */ }
}
function remembered() {
  try { const value = JSON.parse(localStorage.getItem(RUN_IDS) || '[]'); return Array.isArray(value) ? value.filter(id => typeof id === 'string') : []; }
  catch { return []; }
}

export async function render(container, { signal }) {
  let overview, selectedRoutine, selected = new Set(), runs = [], busy = false, message = '';
  let pendingStart = null, pendingCompletion = null;
  const alive = () => !signal.aborted && container.isConnected;
  const options = () => ({ signal });
  container.innerHTML = '<div class="page-toolbar"><h1 class="page-toolbar__title">Timer</h1></div><div class="app-page__body"><section class="ft" aria-live="polite">Carico le routine…</section></div>';
  const root = container.querySelector('.ft');

  function groups() {
    const values = new Map();
    for (const routine of overview.routines) {
      // Keep each participant's OWN occurrence, and choose the earliest available day.
      const existing = values.get(routine.routineId);
      if (!existing) values.set(routine.routineId, { view: routine, subjects: routine.subjectIds.map(id => ({ id, key: routine.occurrenceKey })) });
      else if (routine.occurrenceKey.slice(0, 10) === existing.view.occurrenceKey.slice(0, 10)) {
        for (const id of routine.subjectIds) if (!existing.subjects.some(subject => subject.id === id)) existing.subjects.push({ id, key: routine.occurrenceKey });
      }
    }
    return [...values.values()];
  }
  function group() { return groups().find(value => value.view.routineId === selectedRoutine); }
  function identity(subjectId) { return overview.members.find(member => member.id === subjectId) ?? { label: 'Partecipante', avatar: null }; }
  function avatar(member) { return member.avatar ? `<img class="ft__avatar" src="${esc(member.avatar)}" alt="">` : '<span class="ft__avatar" aria-hidden="true">●</span>'; }
  function notify() { const notice = root.querySelector('[data-notice]'); if (notice) notice.textContent = message; }

  function draw() {
    if (!alive()) return;
    const current = group();
    root.innerHTML = `
      <h2>La mattina, un passo alla volta</h2>
      <header class="ft__clock">
        <div><span>Ora</span><strong data-clock></strong></div>
        <div><span>Ora limite</span><strong data-deadline></strong></div>
      </header>
      ${runs.length ? `<div class="ft__lanes">${runs.map(lane).join('')}</div>
        ${pendingStart ? `<button class="btn btn--primary" data-start ${busy ? 'disabled' : ''}>Riprova l’avvio di tutti i partecipanti</button>` : ''}
        <button class="btn btn--secondary" data-prepare ${busy ? 'disabled' : ''}>Torna alla preparazione</button>`
        : current ? setup(current) : '<p>Nessuna routine condivisa disponibile. Un genitore può prepararla prima dell’avvio.</p>'}
      <p data-notice role="status"></p>`;
    notify();
    root.querySelector('[data-routine]')?.addEventListener('change', event => {
      if (busy) return;
      selectedRoutine = event.target.value;
      selected = new Set(group().subjects.map(subject => subject.id)); pendingStart = null; draw();
    }, { signal });
    root.querySelectorAll('[data-subject]').forEach(input => input.addEventListener('change', () => {
      const id = Number(input.dataset.subject);
      if (input.checked) selected.add(id); else selected.delete(id);
      pendingStart = null; draw();
    }, { signal }));
    root.querySelector('[data-start]')?.addEventListener('click', begin, { signal });
    root.querySelectorAll('[data-done]').forEach(button => button.addEventListener('click', () => confirm(button.dataset.done), { signal }));
    root.querySelector('[data-prepare]')?.addEventListener('click', () => {
      if (busy || (runs.some(run => !run.completedAt) && !window.confirm('Tornare alla preparazione? Le conferme restano salvate e il tempo continua a scorrere.'))) return;
      runs = []; remember([]); pendingStart = null; pendingCompletion = null; message = ''; draw();
    }, { signal });
    tick();
  }

  function setup(current) {
    return `<section class="ft__setup">
      <label>Routine <select data-routine ${busy ? 'disabled' : ''}>${groups().map(value => `<option value="${esc(value.view.routineId)}" ${value.view.routineId === selectedRoutine ? 'selected' : ''}>${esc(value.view.label)}</option>`).join('')}</select></label>
      <fieldset><legend>Chi partecipa</legend><div class="ft__participants">${current.subjects.map(subject => {
        const member = identity(subject.id);
        return `<label class="ft__person"><input type="checkbox" data-subject="${subject.id}" ${selected.has(subject.id) ? 'checked' : ''} ${busy ? 'disabled' : ''}>${avatar(member)}<span>${esc(member.label)}</span></label>`;
      }).join('')}</div></fieldset>
      <p>Inizio previsto ${esc(clock(current.view.start, current.view.timezone))} · uscita ${esc(clock(current.view.deadline, current.view.timezone))}.</p>
      <ul class="ft__plan">${current.view.steps.map(step => `<li><img src="${art(illustrationForStep(step.label))}" alt=""><span>${esc(step.label)}</span><small>${step.durationClass === 'optional' ? 'tempo libero facoltativo' : step.durationSeconds === null ? 'senza durata prefissata' : `${Math.round(step.durationSeconds / 60)} min${step.durationClass === 'compressible' ? `, riducibile a ${Math.round(step.minimumSeconds / 60)}` : ', fisso'}`}</small></li>`).join('')}</ul>
      <button class="btn btn--primary ft__done" data-start ${busy || !selected.size ? 'disabled' : ''}>${busy ? 'Avvio…' : 'Inizia la routine'}</button>
    </section>`;
  }
  function lane(run) {
    const member = identity(run.subjectId);
    const step = run.routine.steps[run.completions.length];
    return `<section class="ft__lane" data-run="${esc(run.id)}" aria-label="Percorso: ${esc(member.label)}">
      <h3>${avatar(member)}${esc(member.label)}</h3>
      ${step ? `<img class="ft__art" src="${art(step.illustration)}" alt="${esc(step.label)}">
        <p>${step.durationClass === 'compressible' ? 'Comprimibile · obbligatorio' : step.durationClass === 'flexible' ? 'Flessibile · obbligatorio' : 'Fisso · obbligatorio'}</p>
        <h4>${esc(step.label)}</h4><p>Questa attività · timer del passo</p><strong class="ft__count" data-step-clock></strong>
        <button class="btn btn--primary ft__done" data-done="${esc(run.id)}" ${busy ? 'disabled' : ''}>${busy ? 'Attendi…' : 'Fatto, prossimo passo'}</button>`
        : `<p class="ft__result">${run.withinDeadline ? 'Passi completati entro l’ora limite' : 'Passi completati dopo l’ora limite'}</p>
          <p>Conclusi alle ${esc(clock(run.completedAt, run.routine.timezone))}.</p>
          <img class="ft__art" src="${art('free-play')}" alt=""><h4>Tempo libero facoltativo</h4><strong class="ft__count" data-play-clock></strong>`}
      <p>Tempo libero previsto: <strong data-forecast></strong><span data-upper-bound></span></p>
      <ol class="ft__strip">${run.routine.steps.map((value, index) => `<li ${index < run.completions.length ? 'data-done-step' : ''}><img src="${art(value.illustration)}" alt=""><span>${esc(value.label)}</span></li>`).join('')}</ol>
    </section>`;
  }
  function tick() {
    if (!alive() || !overview) return;
    const reference = runs[0]?.routine ?? group()?.view;
    if (!reference) return;
    const now = Date.now();
    root.querySelector('[data-clock]').textContent = clock(now, reference.timezone);
    root.querySelector('[data-deadline]').textContent = clock(reference.deadline, reference.timezone);
    for (const run of runs) {
      const element = root.querySelector(`[data-run="${run.id}"]`);
      if (!element) continue;
      const timing = readTimerTiming(run, now);
      const stepClock = element.querySelector('[data-step-clock]');
      if (stepClock && timing.currentStep) {
        const current = timing.currentStep;
        stepClock.textContent = current.kind === 'flexible' ? formatTimerDuration(current.elapsedSeconds)
          : current.overrunSeconds > 0 ? '+' + formatTimerDuration(current.overrunSeconds) : formatTimerDuration(current.remainingSeconds);
        stepClock.classList.toggle('ft__count--late', current.overrunSeconds > 0);
      }
      const play = element.querySelector('[data-play-clock]');
      if (play) play.textContent = formatTimerDuration(timing.optionalPlaySeconds);
      element.querySelector('[data-forecast]').textContent = formatTimerDuration(timing.forecast.freeSeconds);
      element.querySelector('[data-upper-bound]').textContent = timing.forecast.kind === 'upper-bound' ? ' · stima massima: passi senza durata' : '';
    }
  }

  async function begin() {
    if (busy || !selected.size) return;
    busy = true; message = '';
    const current = group();
    // Retain exact operation IDs/timestamps on retry after an uncertain response.
    const startedAt = new Date().toISOString();
    pendingStart ??= current.subjects.filter(subject => selected.has(subject.id)).map(subject => ({
      operationId: crypto.randomUUID(), routineId: current.view.routineId, occurrenceKey: subject.key,
      subjectId: subject.id, startedAt,
      illustrations: Object.fromEntries(current.view.steps.filter(step => step.durationClass !== 'optional').map(step => [step.id, illustrationForStep(step.label)])),
    }));
    draw();
    try {
      for (const request of pendingStart) {
        const response = await api.post(ROOT + '/runs', request, options());
        runs = [...runs.filter(run => run.subjectId !== response.run.subjectId), response.run];
        remember(runs);
      }
      pendingStart = null;
    } catch (error) { if (alive()) message = error.message || 'Avvio non confermato. Riprova senza cambiare partecipanti.'; }
    finally { busy = false; if (alive()) draw(); }
  }
  async function confirm(id) {
    if (busy) return;
    const run = runs.find(value => value.id === id), step = run?.routine.steps[run.completions.length];
    if (!step) return;
    busy = true; message = '';
    if (!pendingCompletion || pendingCompletion.runId !== id || pendingCompletion.request.expectedRevision !== run.revision) {
      pendingCompletion = { runId: id, request: { operationId: crypto.randomUUID(), expectedRevision: run.revision, stepId: step.id, completedAt: new Date().toISOString() } };
    }
    draw();
    try {
      const response = await api.post(`${ROOT}/runs/${id}/steps`, pendingCompletion.request, options());
      runs = runs.map(value => value.id === id ? response.run : value); pendingCompletion = null;
    } catch (error) {
      if (alive()) {
        message = error.message || 'Conferma non ricevuta. Riprova.';
        if (error.status === 409) {
          try { const fresh = await api.get(`${ROOT}/runs/${id}`, options()); runs = runs.map(value => value.id === id ? fresh.run : value); pendingCompletion = null; }
          catch { /* Retain visible run and explicit error, do not invent a receipt. */ }
        }
      }
    } finally { busy = false; if (alive()) draw(); }
  }

  async function load() {
    try {
      overview = await api.get(ROOT, options());
      if (!alive()) return;
      selectedRoutine = groups()[0]?.view.routineId;
      selected = new Set(group()?.subjects.map(subject => subject.id) ?? []);
      const saved = remembered();
      const currentKeys = new Set(group()?.subjects.map(subject => subject.key) ?? []);
      const ids = saved.length ? saved : overview.runs.filter(run => !run.completedAt && currentKeys.has(run.routine.occurrenceKey)).map(run => run.id);
      for (const id of ids) {
        const response = await api.get(`${ROOT}/runs/${encodeURIComponent(id)}`, options());
        if (!alive()) return;
        runs.push(response.run);
      }
      draw();
    } catch (error) {
      if (!alive()) return;
      root.replaceChildren();
      const notice = document.createElement('p'); notice.setAttribute('role', 'alert'); notice.textContent = error.message || 'Timer non disponibile.';
      const retry = document.createElement('button'); retry.className = 'btn btn--secondary'; retry.textContent = 'Riprova';
      retry.addEventListener('click', () => { runs = []; void load(); }, { signal });
      const catalogue = document.createElement('button'); catalogue.className = 'btn btn--secondary'; catalogue.textContent = 'Torna all’elenco senza cancellare le corse';
      catalogue.addEventListener('click', () => { remember([]); runs = []; if (overview) draw(); else void load(); }, { signal });
      root.append(notice, retry, catalogue);
    }
  }
  const timer = setInterval(tick, 1000);
  signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  await load();
}
