/**
 * SQLite port of AgentOS FamilyTimerStore. One run per child/occurrence,
 * immutable server snapshot, optimistic revision and durable operation receipts.
 *
 * Internal persistence only: the HTTP composition MUST first resolve the
 * authenticated household/device and authorize the routine and child. A child
 * selection is not authentication. This store does not award points or call
 * external services inside its transaction.
 */
import { createHash, randomUUID } from 'node:crypto';

export class TimerError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new TimerError(status, code, message); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
function uuid(value) {
  if (typeof value !== 'string' || !UUID.test(value)) fail(400, 'timer_invalid_input', 'Identificativo del timer non valido.');
  return value;
}
function instant(value) {
  if (typeof value !== 'string' || !INSTANT.test(value) || !Number.isFinite(Date.parse(value))) {
    fail(400, 'timer_invalid_input', 'Timestamp del timer non valido.');
  }
  const day = value.slice(0, 10);
  if (new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) !== day
    || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) {
    fail(400, 'timer_invalid_input', 'Timestamp del timer non valido.');
  }
  return value;
}
// Date.parse truncates fractional milliseconds. Keep the original contract's
// exact ordering at the deadline, including imported sub-millisecond reports.
function compareInstants(left, right) {
  const fraction = /\.(\d+)(?=Z$|[+-]\d{2}:\d{2}$)/;
  const a = left.match(fraction)?.[1] ?? '', b = right.match(fraction)?.[1] ?? '';
  const seconds = Date.parse(left.replace(fraction, '')) - Date.parse(right.replace(fraction, ''));
  if (seconds) return Math.sign(seconds);
  const width = Math.max(a.length, b.length);
  const aa = a.padEnd(width, '0'), bb = b.padEnd(width, '0');
  return aa < bb ? -1 : aa > bb ? 1 : 0;
}
function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
function fromRow(row) {
  if (!row) return null;
  return {
    id: row.id, revision: row.revision, routine: JSON.parse(row.snapshot), subjectId: row.subject_id,
    startedAt: row.started_at, receivedAt: row.received_at, completions: JSON.parse(row.completions),
    completedAt: row.completed_at, withinDeadline: row.within_deadline === null ? null : Boolean(row.within_deadline),
  };
}
function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') fail(400, 'timer_invalid_snapshot', 'Snapshot del timer non valida.');
  uuid(snapshot.routineId);
  instant(snapshot.deadline);
  if (!Number.isSafeInteger(snapshot.routineVersion) || snapshot.routineVersion < 1
    || typeof snapshot.occurrenceKey !== 'string' || !snapshot.occurrenceKey || snapshot.occurrenceKey.length > 500
    || typeof snapshot.label !== 'string' || !snapshot.label.trim() || snapshot.label.length > 300
    || typeof snapshot.timezone !== 'string' || !snapshot.timezone
    || !Array.isArray(snapshot.steps) || snapshot.steps.length < 1 || snapshot.steps.length > 100) {
    fail(400, 'timer_invalid_snapshot', 'Snapshot del timer non valida.');
  }
  try { new Intl.DateTimeFormat('it-IT', { timeZone: snapshot.timezone }); }
  catch { fail(400, 'timer_invalid_snapshot', 'Fuso orario non valido.'); }
  const ids = new Set();
  let previousOrder = -1;
  const seconds = value => Number.isInteger(value) && value >= 0 && value <= 86400;
  const illustrations = new Set(['face-wash', 'breakfast', 'toothbrush', 'dressed', 'free-play', 'generic-step']);
  for (const step of snapshot.steps) {
    uuid(step.id);
    if (ids.has(step.id) || !Number.isInteger(step.order) || step.order <= previousOrder
      || typeof step.label !== 'string' || !step.label.trim() || step.label.length > 300
      || !illustrations.has(step.illustration)) fail(400, 'timer_invalid_snapshot', 'Passi del timer non validi.');
    ids.add(step.id); previousOrder = step.order;
    const fixed = step.durationClass === 'fixed' && seconds(step.durationSeconds)
      && step.minimumSeconds === null && step.plannedSeconds === null;
    const compressible = step.durationClass === 'compressible' && seconds(step.durationSeconds)
      && seconds(step.minimumSeconds) && seconds(step.plannedSeconds)
      && step.minimumSeconds <= step.durationSeconds && step.durationSeconds <= step.plannedSeconds;
    const flexible = step.durationClass === 'flexible' && step.durationSeconds === null
      && step.minimumSeconds === null && step.plannedSeconds === null;
    // Optional play is intentionally NOT a step in a run snapshot.
    if (!fixed && !compressible && !flexible) fail(400, 'timer_invalid_snapshot', 'Durata del passo non valida.');
  }
}

export class FamilyTimerStore {
  constructor(database, principalKey, { now = () => new Date().toISOString() } = {}) {
    if (typeof principalKey !== 'string' || !principalKey || principalKey.length > 200) throw new TypeError('Timer principal key required');
    this.db = database;
    this.principalKey = principalKey;
    this.now = now;
  }

  get(id) {
    uuid(id);
    return fromRow(this.db.prepare('SELECT * FROM family_timer_runs WHERE id=?').get(id));
  }

  list(routineId, occurrenceKey, subjectIds) {
    uuid(routineId);
    if (!Array.isArray(subjectIds) || subjectIds.some(id => !Number.isSafeInteger(id) || id < 1)) {
      fail(400, 'timer_invalid_input', 'Partecipanti non validi.');
    }
    if (!subjectIds.length) return [];
    return this.db.prepare(`SELECT * FROM family_timer_runs WHERE routine_id=? AND occurrence_key=?
      AND subject_id IN (${subjectIds.map(() => '?').join(',')}) ORDER BY received_at,id`)
      .all(routineId, occurrenceKey, ...subjectIds).map(fromRow);
  }

  start(snapshot, input) {
    uuid(input.operationId); uuid(input.routineId);
    instant(input.startedAt);
    if (!Number.isSafeInteger(input.subjectId) || input.subjectId < 1
      || typeof input.occurrenceKey !== 'string' || !input.occurrenceKey || input.occurrenceKey.length > 500) {
      fail(400, 'timer_invalid_input', 'Partecipante o occorrenza non validi.');
    }
    return this.operation(input.operationId, { action: 'start', input }, () => {
      validateSnapshot(snapshot);
      if (snapshot.routineId !== input.routineId || snapshot.occurrenceKey !== input.occurrenceKey) {
        fail(400, 'timer_snapshot_mismatch', 'La richiesta non corrisponde alla routine canonica.');
      }
      const existing = this.db.prepare(`SELECT * FROM family_timer_runs
        WHERE routine_id=? AND occurrence_key=? AND subject_id=?`)
        .get(input.routineId, input.occurrenceKey, input.subjectId);
      if (existing) return fromRow(existing);
      const id = randomUUID();
      this.db.prepare(`INSERT INTO family_timer_runs
        (id,routine_id,occurrence_key,subject_id,snapshot,started_at,received_at)
        VALUES(?,?,?,?,?,?,?)`).run(id, snapshot.routineId, snapshot.occurrenceKey,
          input.subjectId, JSON.stringify(snapshot), input.startedAt, instant(this.now()));
      return this.get(id);
    });
  }

  complete(id, input) {
    uuid(id); uuid(input.operationId); uuid(input.stepId); instant(input.completedAt);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
      fail(400, 'timer_invalid_input', 'Revisione del timer non valida.');
    }
    return this.operation(input.operationId, { action: 'complete', runId: id, input }, () => {
      const run = this.get(id);
      if (!run) fail(404, 'timer_run_not_found', 'Corsa del timer non trovata.');
      if (run.revision !== input.expectedRevision) fail(409, 'timer_revision_conflict', 'Il timer è avanzato. Rileggi la corsa.');
      const step = run.routine.steps[run.completions.length];
      if (!step) fail(409, 'timer_run_completed', 'Tutti i passi obbligatori sono già confermati.');
      if (step.id !== input.stepId) fail(409, 'timer_step_conflict', 'Puoi confermare soltanto il prossimo passo.');
      const previous = run.completions.at(-1);
      if (compareInstants(input.completedAt, previous?.completedAt ?? run.startedAt) < 0) {
        fail(400, 'timer_timestamp_order', 'La conferma non può precedere l’avvio o la conferma precedente.');
      }
      const receivedAt = new Date(Math.max(Date.parse(instant(this.now())), Date.parse(previous?.receivedAt ?? run.receivedAt))).toISOString();
      const completions = [...run.completions, { stepId: input.stepId, completedAt: input.completedAt, receivedAt }];
      const finished = completions.length === run.routine.steps.length;
      // withinDeadline is a DEVICE REPORT, not trusted evidence for rewards.
      const within = finished ? Number(compareInstants(input.completedAt, run.routine.deadline) <= 0) : null;
      this.db.prepare(`UPDATE family_timer_runs SET revision=revision+1,completions=?,completed_at=?,within_deadline=? WHERE id=?`)
        .run(JSON.stringify(completions), finished ? input.completedAt : null, within, id);
      return this.get(id);
    });
  }

  operation(operationId, input, command) {
    const fingerprint = createHash('sha256').update(canonicalJson(input)).digest('hex');
    const outcome = this.db.transaction(() => {
      const receipt = this.db.prepare('SELECT * FROM family_timer_operations WHERE principal_key=? AND operation_id=?')
        .get(this.principalKey, operationId);
      if (receipt) {
        if (receipt.fingerprint !== fingerprint) fail(409, 'timer_operation_conflict', 'Operazione già associata a una richiesta diversa.');
        return { status: receipt.status, body: JSON.parse(receipt.response) };
      }
      // Savepoint rolls back a failed command but keeps a durable 4xx receipt.
      let status = 200, body;
      try { body = this.db.transaction(command)(); }
      catch (error) {
        if (!(error instanceof TimerError) || error.status < 400 || error.status >= 500) throw error;
        status = error.status; body = { code: error.code, message: error.message };
      }
      this.db.prepare(`INSERT INTO family_timer_operations(principal_key,operation_id,fingerprint,status,response)
        VALUES(?,?,?,?,?)`).run(this.principalKey, operationId, fingerprint, status, JSON.stringify(body));
      return { status, body };
    }).immediate();
    if (outcome.status !== 200) fail(outcome.status, outcome.body.code, outcome.body.message);
    return outcome.body;
  }
}
