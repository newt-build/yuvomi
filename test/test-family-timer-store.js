import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '../server/utils/sqlite-driver.js';
import { FAMILY_TIMER_SCHEMA } from '../server/services/family-timer-schema.js';
import { FamilyTimerStore, TimerError } from '../server/services/family-timer-store.js';

const startedAt = '2026-11-11T07:00:00+01:00';
const deadline = '2026-11-11T07:45:00+01:00';
function fixture(t, path = ':memory:') {
  const db = new Database(path);
  db.pragma('foreign_keys=ON');
  db.exec('CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1),(2);');
  db.exec(FAMILY_TIMER_SCHEMA);
  t.after(() => { if (db.open) db.close(); });
  const snapshot = {
    routineId: randomUUID(), routineVersion: 1, occurrenceKey: 'routine:2026-11-11',
    label: 'Routine sintetica', timezone: 'Europe/Rome', deadline,
    steps: [
      { id: randomUUID(), label: 'Denti', order: 0, durationClass: 'fixed', durationSeconds: 180,
        minimumSeconds: null, plannedSeconds: null, illustration: 'toothbrush' },
      { id: randomUUID(), label: 'Vestiti', order: 1, durationClass: 'flexible', durationSeconds: null,
        minimumSeconds: null, plannedSeconds: null, illustration: 'dressed' },
    ],
  };
  const input = { operationId: randomUUID(), routineId: snapshot.routineId,
    occurrenceKey: snapshot.occurrenceKey, subjectId: 1, startedAt };
  const store = new FamilyTimerStore(db, 'display:fixture', { now: () => '2026-11-11T06:00:01.000Z' });
  const complete = (run, overrides = {}) => store.complete(run.id, {
    operationId: randomUUID(), expectedRevision: run.revision,
    stepId: run.routine.steps[run.completions.length].id, completedAt: '2026-11-11T07:10:00+01:00', ...overrides,
  });
  return { db, snapshot, input, store, complete };
}
const code = expected => error => error instanceof TimerError && error.code === expected;

test('start persists canonical snapshot and replay returns the same run', t => {
  const { store, snapshot, input } = fixture(t);
  const run = store.start(snapshot, input);
  assert.equal(run.revision, 1);
  assert.equal(run.subjectId, 1);
  assert.deepEqual(store.get(run.id), run);
  assert.deepEqual(store.start(snapshot, { ...input }), run);
  snapshot.steps[0].label = 'Changed after start';
  assert.equal(store.get(run.id).routine.steps[0].label, 'Denti');
});
test('repeated starts never reset start/deadline/progress, including another device', t => {
  const { db, store, snapshot, input, complete } = fixture(t);
  const run = complete(store.start(snapshot, input));
  const other = new FamilyTimerStore(db, 'display:second');
  const changed = { ...snapshot, deadline: '2026-11-11T08:00:00+01:00' };
  const resumed = other.start(changed, { ...input, operationId: randomUUID(), startedAt: '2026-11-11T07:20:00+01:00' });
  assert.deepEqual(resumed, run);
});
test('two children have separate runs and confirmations for the same occurrence', t => {
  const { store, snapshot, input, complete } = fixture(t);
  const one = store.start(snapshot, input);
  const two = store.start(snapshot, { ...input, operationId: randomUUID(), subjectId: 2 });
  assert.notEqual(one.id, two.id);
  complete(one);
  assert.equal(store.get(two.id).completions.length, 0);
  assert.deepEqual(store.list(snapshot.routineId, snapshot.occurrenceKey, [2]), [two]);
  assert.deepEqual(store.list(snapshot.routineId, snapshot.occurrenceKey, []), []);
});
test('operation id cannot be reused for a different child/request', t => {
  const { store, snapshot, input } = fixture(t);
  store.start(snapshot, input);
  assert.throws(() => store.start(snapshot, { ...input, subjectId: 2 }), code('timer_operation_conflict'));
});
test('completion replay is durable and does not advance a second step', t => {
  const { store, snapshot, input } = fixture(t);
  const run = store.start(snapshot, input);
  const request = { operationId: randomUUID(), expectedRevision: 1,
    stepId: run.routine.steps[0].id, completedAt: '2026-11-11T07:10:00+01:00' };
  const next = store.complete(run.id, request);
  assert.equal(next.revision, 2);
  assert.deepEqual(store.complete(run.id, { completedAt: request.completedAt, stepId: request.stepId,
    expectedRevision: 1, operationId: request.operationId }), next);
  assert.equal(store.get(run.id).completions.length, 1);
});
test('stale revisions and skipping a mandatory step are denied without mutation', t => {
  const { store, snapshot, input, complete } = fixture(t);
  const run = store.start(snapshot, input);
  assert.throws(() => complete(run, { stepId: run.routine.steps[1].id }), code('timer_step_conflict'));
  complete(run);
  assert.throws(() => complete(run), code('timer_revision_conflict'));
  assert.equal(store.get(run.id).completions.length, 1);
});
test('4xx receipts remain stable after another command changes the run', t => {
  const { store, snapshot, input, complete } = fixture(t);
  const run = store.start(snapshot, input);
  const request = { operationId: randomUUID(), expectedRevision: 1,
    stepId: run.routine.steps[1].id, completedAt: '2026-11-11T07:10:00+01:00' };
  assert.throws(() => store.complete(run.id, request), code('timer_step_conflict'));
  complete(run);
  assert.throws(() => store.complete(run.id, request), code('timer_step_conflict'));
});
test('zero elapsed countdown never auto-completes; only explicit confirmations finish', t => {
  const { store, snapshot, input, complete } = fixture(t);
  const run = store.start(snapshot, input);
  assert.equal(store.get(run.id).completedAt, null);
  const first = complete(run);
  assert.equal(first.completedAt, null);
  const finished = complete(first, { completedAt: deadline });
  assert.equal(finished.withinDeadline, true);
  assert.equal(finished.completedAt, deadline);
  assert.equal(finished.completions.length, 2);
  assert.equal(finished.completions[0].receivedAt, '2026-11-11T06:00:01.000Z');
});
test('late explicit completion is retained as late, never discarded', t => {
  const { store, snapshot, input, complete } = fixture(t);
  const finished = complete(complete(store.start(snapshot, input)), { completedAt: '2026-11-11T07:46:00+01:00' });
  assert.equal(finished.withinDeadline, false);
});
test('device times must be ordered and cannot omit timezone', t => {
  const { store, snapshot, input, complete } = fixture(t);
  const run = store.start(snapshot, input);
  assert.throws(() => complete(run, { completedAt: '2026-11-11T06:59:00+01:00' }), code('timer_timestamp_order'));
  assert.throws(() => complete(run, { completedAt: '2026-11-11T07:10:00' }), code('timer_invalid_input'));
  assert.throws(() => complete(run, { completedAt: '2026-02-30T07:10:00+01:00' }), code('timer_invalid_input'));
  assert.throws(() => complete(run, { completedAt: '2026-11-11T24:00:00+01:00' }), code('timer_invalid_input'));
  assert.equal(store.get(run.id).revision, 1);
});
test('sub-millisecond deadline ordering does not round a late report into on-time', t => {
  const { store, snapshot, input, complete } = fixture(t);
  const first = complete(store.start(snapshot, input));
  const finished = complete(first, { completedAt: '2026-11-11T07:45:00.0000001+01:00' });
  assert.equal(finished.withinDeadline, false);
});
test('optional play and invented flexible durations are not run steps', t => {
  const { store, snapshot, input } = fixture(t);
  const invalid = structuredClone(snapshot);
  invalid.steps[1].durationClass = 'optional';
  assert.throws(() => store.start(invalid, input), code('timer_invalid_snapshot'));
  const invalidFlexible = structuredClone(snapshot);
  invalidFlexible.steps[1].durationSeconds = 300;
  assert.throws(() => store.start(invalidFlexible, { ...input, operationId: randomUUID() }), code('timer_invalid_snapshot'));
});
test('snapshot validation catches minima and duplicate mandatory steps', t => {
  const { store, snapshot, input } = fixture(t);
  const invalid = structuredClone(snapshot);
  Object.assign(invalid.steps[0], { durationClass: 'compressible', durationSeconds: 180, minimumSeconds: 200, plannedSeconds: 300 });
  assert.throws(() => store.start(invalid, input), code('timer_invalid_snapshot'));
  const duplicate = structuredClone(snapshot);
  duplicate.steps[1].id = duplicate.steps[0].id;
  assert.throws(() => store.start(duplicate, { ...input, operationId: randomUUID() }), code('timer_invalid_snapshot'));
});
test('foreign-key failure rolls back the command AND operation receipt', t => {
  const { db, store, snapshot, input } = fixture(t);
  assert.throws(() => store.start(snapshot, { ...input, subjectId: 999 }));
  assert.equal(db.prepare('SELECT count(*) n FROM family_timer_runs').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) n FROM family_timer_operations').get().n, 0);
});
test('database reopen restores run, deadline, progress and operation receipts', t => {
  const directory = mkdtempSync(join(tmpdir(), 'family-timer-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'fixture.db');
  const { db, store, snapshot, input, complete } = fixture(t, path);
  const next = complete(store.start(snapshot, input));
  db.close();
  const reopened = new Database(path);
  t.after(() => reopened.close());
  const restored = new FamilyTimerStore(reopened, 'display:fixture');
  assert.deepEqual(restored.get(next.id), next);
  // Replaying start returns its original receipt, without changing current state.
  assert.equal(restored.start(snapshot, input).revision, 1);
  assert.equal(restored.get(next.id).revision, 2);
});
