process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'synthetic-timer-route-fixture';

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
const { get } = await import('../server/db.js');
const { createFamilyTimerRouter } = await import('../server/routes/family-timers.js');
const db = get();
const insertUser = db.prepare("INSERT INTO users(username,display_name,password_hash,family_role) VALUES(?,?,'fixture','child')");
const childA = Number(insertUser.run('timer-a', 'Bambino A').lastInsertRowid);
const childB = Number(insertUser.run('timer-b', 'Bambino B').lastInsertRowid);
const sourceA = randomUUID(), sourceB = randomUUID();
const routineId = randomUUID(), fixedId = randomUUID(), compressedId = randomUUID();
const recurrence = { rule: 'FREQ=DAILY', quota: null, rdates: [], fromDate: '2026-10-15', dstPolicy: 'reject',
  localTime: '06:45', untilDate: null, exceptions: [], durationMinutes: 65, excludedOccurrences: [] };
const steps = [
  { id: fixedId, label: 'Denti', durationClass: 'fixed', durationSeconds: 300, minimumSeconds: null, order: 0 },
  { id: compressedId, label: 'Vestiti', durationClass: 'compressible', durationSeconds: 600, minimumSeconds: 180, order: 1 },
  { id: randomUUID(), label: 'Gioco', durationClass: 'optional', durationSeconds: null, minimumSeconds: null, order: 2 },
];
let clock = new Date('2026-11-11T06:00:00Z');
const app = express();
app.use(express.json());
// Trusted auth/scopes/CSRF are tested by the host application. This harness
// supplies a synthetic authenticated principal, never household credentials.
app.use((req, _res, next) => {
  req.authUserId = req.get('x-fixture-auth') === 'none' ? null : childA;
  req.authMethod = req.get('x-fixture-auth') === 'token' ? 'api_token' : 'display';
  next();
});
app.use('/timers', createFamilyTimerRouter({ database: db, now: () => clock }));
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const root = `http://127.0.0.1:${server.address().port}/timers`;
test.after(() => server.close());
test.beforeEach(() => {
  clock = new Date('2026-11-11T06:00:00Z');
  db.exec('DELETE FROM family_timer_operations; DELETE FROM family_timer_runs; DELETE FROM family_timer_subjects; DELETE FROM family_timer_routines;');
  db.prepare('INSERT INTO family_timer_routines(id,version,label,timezone,recurrence,steps) VALUES(?,2,?,\'Europe/Rome\',?,?)')
    .run(routineId, 'Mattina sintetica', JSON.stringify(recurrence), JSON.stringify(steps));
  const insert = db.prepare('INSERT INTO family_timer_subjects VALUES(?,?,?)');
  insert.run(routineId, childA, sourceA); insert.run(routineId, childB, sourceB);
});
async function call(method, path = '', body, headers = {}) {
  const response = await fetch(root + path, { method, headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function start(subjectId = childA, source = sourceA, overrides = {}) {
  return call('POST', '/runs', { operationId: randomUUID(), routineId,
    occurrenceKey: `2026-11-11T06:45:reject:${source}`, subjectId,
    startedAt: '2026-11-11T07:40:00+01:00', illustrations: { [fixedId]: 'toothbrush' }, ...overrides });
}

test('native overview reads database definitions and redacts member details', async () => {
  const result = await call('GET');
  assert.equal(result.status, 200);
  assert.equal(result.body.routines.length, 6);
  assert.equal(result.body.members.length, 2);
  assert.equal(result.body.routines[0].deadline, '2026-11-11T06:50:00.000Z');
  assert.equal(result.body.routines[0].steps.length, 3);
  assert.deepEqual(Object.keys(result.body.members[0]).sort(), ['avatar', 'id', 'label', 'reportable']);
});
test('two participants start distinct runs, compressed once by the native server', async () => {
  const a = await start();
  const b = await start(childB, sourceB);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.notEqual(a.body.run.id, b.body.run.id);
  assert.equal(a.body.run.routine.steps.length, 2);
  assert.deepEqual(a.body.run.routine.steps.map(step => step.durationSeconds), [300, 300]);
  assert.equal(a.body.run.routine.steps[1].plannedSeconds, 600);
  assert.equal(b.body.run.subjectId, childB);
});
test('API rejects unauthorized child/occurrence pairs and invented snapshots', async () => {
  assert.equal((await start(childB, sourceA)).status, 403);
  assert.equal((await start(999)).status, 403);
  assert.equal((await start(childA, sourceA, { deadline: '2099-01-01T00:00:00Z' })).status, 400);
  assert.equal(db.prepare('SELECT count(*) n FROM family_timer_runs').get().n, 0);
});
test('advance persists and repeated operation does not advance twice', async () => {
  const { body: { run } } = await start();
  const request = { operationId: randomUUID(), expectedRevision: 1, stepId: fixedId, completedAt: '2026-11-11T07:45:00+01:00' };
  const first = await call('POST', `/runs/${run.id}/steps`, request);
  assert.equal(first.status, 200);
  assert.equal(first.body.run.revision, 2);
  assert.deepEqual((await call('POST', `/runs/${run.id}/steps`, request)).body.run, first.body.run);
  assert.deepEqual((await call('GET', `/runs/${run.id}`)).body.run, first.body.run);
});
test('yesterday run is restorable using its frozen deadline, not today query window', async () => {
  const { body: { run } } = await start();
  clock = new Date('2026-11-12T06:00:00Z');
  const restored = await call('GET', `/runs/${run.id}`);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.run.routine.deadline, '2026-11-11T06:50:00.000Z');
});
test('withdrawn routine and changed definitions cannot be advanced', async () => {
  const { body: { run } } = await start();
  db.prepare('UPDATE family_timer_routines SET version=3 WHERE id=?').run(routineId);
  const changed = await call('GET', `/runs/${run.id}`);
  assert.equal(changed.status, 409);
  db.prepare('UPDATE family_timer_routines SET enabled=0 WHERE id=?').run(routineId);
  assert.equal((await call('GET', `/runs/${run.id}`)).status, 403);
  assert.equal(db.prepare('SELECT revision FROM family_timer_runs WHERE id=?').get(run.id).revision, 1);
});
test('anonymous and API-token requests cannot inherit the kiosk principal', async () => {
  assert.equal((await call('GET', '', undefined, { 'x-fixture-auth': 'none' })).status, 401);
  assert.equal((await call('GET', '', undefined, { 'x-fixture-auth': 'token' })).status, 403);
});
test('invalid date ranges and unsupported recurrence fail explicitly', async () => {
  assert.equal((await call('GET', '?from=2026-02-30&to=2026-03-02')).status, 400);
  assert.equal((await call('GET', '?from=2026-01-01&to=2026-12-01')).status, 400);
  db.prepare('UPDATE family_timer_routines SET recurrence=? WHERE id=?').run(JSON.stringify({ ...recurrence, rule: 'FREQ=WEEKLY' }), routineId);
  assert.equal((await call('GET')).status, 422);
});
test('daily clock follows DST, and ambiguous/missing local instants are rejected', async () => {
  const result = await call('GET', '?from=2026-10-24&to=2026-10-26');
  assert.equal(result.status, 200);
  assert.equal(result.body.routines[0].start, '2026-10-24T04:45:00.000Z');
  assert.equal(result.body.routines[2].start, '2026-10-25T05:45:00.000Z');
  db.prepare('UPDATE family_timer_routines SET recurrence=? WHERE id=?').run(JSON.stringify({ ...recurrence, localTime: '02:30', fromDate: '2026-01-01' }), routineId);
  assert.equal((await call('GET', '?from=2026-10-25&to=2026-10-26')).status, 422);
  assert.equal((await call('GET', '?from=2026-03-29&to=2026-03-30')).status, 422);
});
