/**
 * Native timer application service. `readScope` is bound by the HTTP layer to
 * the authenticated device/household, never constructed from request payloads.
 * Its canonical routine views follow the original Family timer contract.
 */
import { planRoutine } from './family-timer-plan.js';
import { TimerError } from './family-timer-store.js';

const forbidden = () => { throw new TimerError(403, 'timer_routine_forbidden', 'Questa routine non è condivisa con la persona selezionata.'); };
const ILLUSTRATIONS = new Set(['face-wash', 'breakfast', 'toothbrush', 'dressed', 'free-play', 'generic-step']);

export class FamilyTimerService {
  constructor(store, readScope) { this.store = store; this.readScope = readScope; }

  async scope(window) {
    const source = await this.readScope(window);
    const members = source.members.filter(member => member.reportable === true);
    const allowed = new Set(members.map(member => member.id));
    const routines = source.routines.map(routine => ({ ...routine,
      subjectIds: routine.subjectIds.filter(id => allowed.has(id)),
    })).filter(routine => routine.subjectIds.length > 0 && routine.actions.includes('report_done'));
    return { routines, members };
  }

  routine(scope, routineId, occurrenceKey, subjectId) {
    const routine = scope.routines.find(value => value.routineId === routineId
      && value.occurrenceKey === occurrenceKey && value.subjectIds.includes(subjectId));
    if (!routine) forbidden();
    return routine;
  }

  sharedRun(scope, run) {
    const current = this.routine(scope, run.routine.routineId, run.routine.occurrenceKey, run.subjectId);
    const required = current.steps.filter(step => step.durationClass !== 'optional');
    if (current.routineVersion !== run.routine.routineVersion || required.length !== run.routine.steps.length
      || required.some((step, index) => step.id !== run.routine.steps[index].id || step.label !== run.routine.steps[index].label)) {
      throw new TimerError(409, 'timer_definition_changed', 'La routine condivisa è cambiata. La corsa è conservata: serve una verifica adulta.');
    }
    return current;
  }

  async overview() {
    const scope = await this.scope();
    const runs = new Map();
    for (const routine of scope.routines) {
      for (const run of this.store.list(routine.routineId, routine.occurrenceKey, routine.subjectIds)) {
        this.sharedRun(scope, run); runs.set(run.id, run);
      }
    }
    return { ...scope, runs: [...runs.values()], serverNow: this.store.now() };
  }

  async start(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['operationId', 'routineId', 'occurrenceKey', 'subjectId', 'startedAt', 'illustrations'].includes(key))) {
      throw new TimerError(400, 'timer_invalid_input', 'Riferimenti del timer non validi.');
    }
    const scope = await this.scope();
    const routine = this.routine(scope, input.routineId, input.occurrenceKey, input.subjectId);
    if (!routine.deadline || !Number.isFinite(Date.parse(routine.deadline))) {
      throw new TimerError(409, 'timer_deadline_missing', 'La routine non ha un’ora limite. Configurarla prima di avviare.');
    }
    const illustrations = input.illustrations ?? {};
    if (!illustrations || typeof illustrations !== 'object' || Array.isArray(illustrations)
      || Object.entries(illustrations).some(([id, key]) => !ILLUSTRATIONS.has(key)
        || !routine.steps.some(step => step.id === id && step.durationClass !== 'optional'))) {
      throw new TimerError(400, 'timer_illustration_mismatch', 'La scelta grafica non corrisponde ai passi della routine.');
    }
    const planned = routine.steps.filter(step => step.durationClass !== 'optional').map(step => {
      const kind = step.durationSeconds === null ? 'flexible' : step.durationClass;
      const compressible = kind === 'compressible';
      const minimum = compressible && Number.isInteger(step.minimumSeconds) && step.minimumSeconds >= 0
        && step.minimumSeconds <= step.durationSeconds ? step.minimumSeconds : step.durationSeconds;
      return {
        id: step.id, label: step.label, order: step.order, durationClass: kind,
        durationSeconds: kind === 'flexible' ? null : step.durationSeconds,
        plannedSeconds: compressible ? step.durationSeconds : null,
        minimumSeconds: compressible ? minimum : null,
        illustration: illustrations[step.id] ?? 'generic-step',
      };
    });
    if (!Number.isFinite(Date.parse(input.startedAt))) throw new TimerError(400, 'timer_invalid_input', 'Avvio del timer non valido.');
    const plan = planRoutine(planned, { deadline: routine.deadline, start: input.startedAt });
    const assigned = new Map(plan.steps.map(summary => [summary.step.id, summary.durationSeconds]));
    const snapshot = {
      routineId: routine.routineId, routineVersion: routine.routineVersion,
      occurrenceKey: routine.occurrenceKey, timezone: routine.timezone, deadline: routine.deadline, label: routine.label,
      steps: planned.map(step => step.durationClass === 'flexible' ? step
        : { ...step, durationSeconds: assigned.get(step.id) ?? step.durationSeconds }),
    };
    const run = this.store.start(snapshot, input);
    this.sharedRun(scope, run);
    return { run, serverNow: this.store.now() };
  }

  async get(id) {
    const run = this.store.get(id);
    if (!run) throw new TimerError(404, 'timer_run_not_found', 'Corsa del timer non trovata.');
    this.sharedRun(await this.scope({ deadline: run.routine.deadline }), run);
    return { run, serverNow: this.store.now() };
  }

  async complete(id, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['operationId', 'expectedRevision', 'stepId', 'completedAt'].includes(key))) {
      throw new TimerError(400, 'timer_invalid_input', 'Conferma del timer non valida.');
    }
    const run = this.store.get(id);
    if (!run) throw new TimerError(404, 'timer_run_not_found', 'Corsa del timer non trovata.');
    this.sharedRun(await this.scope({ deadline: run.routine.deadline }), run);
    return { run: this.store.complete(id, input), serverNow: this.store.now() };
  }
}
