/** Real host auth, pairing, both scope gates and CSRF, against synthetic household data. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTestServer, cookieHeader } from './server-ready.js';
const { baseUrl } = await startTestServer({ name: 'family-timer-display', env: {
  SESSION_SECRET: 'family-timer-display-fixture-secret-32chars',
  RATE_LIMIT_MAX_ATTEMPTS: '40',
} });
const { get } = await import('../server/db.js');
const { DISPLAY_COOKIE } = await import('../server/services/display-accounts.js');
const db = get();
async function request(method, path, body, headers = {}) {
  const response = await fetch(baseUrl + '/api/v1' + path, { method,
    headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { response, body: await response.json().catch(() => null) };
}
await request('POST', '/auth/setup', { username: 'admin', display_name: 'Admin', password: 'fixturepass123' });
const signed = await request('POST', '/auth/login', { username: 'admin', password: 'fixturepass123' });
const cookie = cookieHeader(signed.response.headers.get('set-cookie'));
const me = await request('GET', '/auth/me', undefined, { Cookie: cookie });
const adminHeaders = { Cookie: cookie, 'X-CSRF-Token': me.body.csrfToken };
const account = await request('POST', '/displays', { display_name: 'Fixture kiosk' }, adminHeaders);
assert.equal(account.response.status, 201);
const issued = await request('POST', `/displays/${account.body.data.id}/pairing-code`, {}, adminHeaders);
const paired = await request('POST', '/displays/pair', { code: issued.body.data.code });
assert.equal(paired.response.status, 201);
const token = decodeURIComponent(paired.response.headers.get('set-cookie').match(new RegExp(`${DISPLAY_COOKIE}=([^;]+)`))[1]);
const jar = new Map([[DISPLAY_COOKIE, token]]);
let csrf;
async function display(method, path, body) {
  const result = await request(method, path, body, {
    Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '), ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
  });
  for (const line of result.response.headers.getSetCookie()) {
    const pair = line.split(';')[0], at = pair.indexOf('=');
    jar.set(pair.slice(0, at), pair.slice(at + 1));
  }
  csrf = result.response.headers.get('x-csrf-token') || csrf;
  return result;
}
const child = Number(db.prepare("INSERT INTO users(username,display_name,password_hash,family_role) VALUES('timer-child','Fixture bambino','fixture','child')").run().lastInsertRowid);
const routineId = randomUUID(), stepId = randomUUID(), sourceId = randomUUID();
const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const recurrence = { rule: 'FREQ=DAILY', quota: null, rdates: [], fromDate: '2026-01-01', dstPolicy: 'reject', localTime: '06:45', untilDate: null, exceptions: [], durationMinutes: 65, excludedOccurrences: [] };
db.prepare('INSERT INTO family_timer_routines(id,version,label,timezone,recurrence,steps) VALUES(?,1,?,\'Europe/Rome\',?,?)')
  .run(routineId, 'Routine fixture', JSON.stringify(recurrence), JSON.stringify([{ id: stepId, label: 'Denti', order: 0, durationClass: 'fixed', durationSeconds: 180, minimumSeconds: null }]));
db.prepare('INSERT INTO family_timer_subjects VALUES(?,?,?)').run(routineId, child, sourceId);

test('paired kiosk can list/start/restore/advance native timer through real auth and both gates', async () => {
  await display('GET', '/preferences');
  const overview = await display('GET', '/tasks/timers');
  assert.equal(overview.response.status, 200);
  assert.equal(overview.body.members[0].id, child);
  const started = await display('POST', '/tasks/timers/runs', { operationId: randomUUID(), routineId,
    occurrenceKey: `${date}T06:45:reject:${sourceId}`, subjectId: child, startedAt: new Date().toISOString(), illustrations: {} });
  assert.equal(started.response.status, 200, JSON.stringify(started.body));
  const run = started.body.run;
  assert.equal((await display('GET', `/tasks/timers/runs/${run.id}`)).response.status, 200);
  const done = await display('POST', `/tasks/timers/runs/${run.id}/steps`, { operationId: randomUUID(), expectedRevision: 1,
    stepId, completedAt: new Date().toISOString() });
  assert.equal(done.response.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.run.revision, 2);
  assert.ok(done.body.run.completedAt);
});
test('kiosk timer access does not allow editing routines, users or arbitrary task routes', async () => {
  for (const [method, path] of [['POST', '/tasks/timers'], ['PATCH', `/tasks/timers/runs/${randomUUID()}`],
    ['DELETE', `/tasks/timers/runs/${randomUUID()}`], ['POST', '/tasks'], ['PATCH', `/auth/users/${child}`]]) {
    assert.equal((await display(method, path, {})).response.status, 403, method + ' ' + path);
  }
});
test('kiosk reads approved multi-app catalogue but cannot edit it; CSP follows only configured origins', async () => {
  const apps = [
    { id: 'logopedia', label: 'Logopedia', url: 'https://speech.example.test/app', isolation: 'household' },
    { id: 'game', label: 'Gioco', url: 'https://games.example.test/play', isolation: 'isolated' },
  ];
  assert.equal((await request('PUT', '/family-apps', { apps }, adminHeaders)).response.status, 200);
  assert.deepEqual((await display('GET', '/family-apps')).body.apps, apps);
  assert.equal((await display('PUT', '/family-apps', { apps: [] })).response.status, 403);
  const root = await fetch(baseUrl + '/');
  const policy = root.headers.get('content-security-policy');
  assert.ok(policy.includes("frame-src 'self' https://speech.example.test https://games.example.test"));
  assert.ok(policy.includes("frame-ancestors 'self'"));
});
test('paired kiosk can associate a character and read the real updated profile image', async () => {
  const character = randomUUID();
  const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ9sAAAAASUVORK5CYII=';
  db.prepare('INSERT INTO family_avatar_characters(id,title,image_data) VALUES(?,?,?)').run(character, 'Fixture personaggio', image);
  const catalogue = await display('GET', '/family-avatars');
  assert.equal(catalogue.response.status, 200);
  const user = catalogue.body.users.find(value => value.id === child);
  const saved = await display('PUT', `/family-avatars/users/${child}`, { characterId: character, expectedVersion: user.version, expectedAvatarKey: user.avatarKey });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
  assert.equal(db.prepare('SELECT avatar_data FROM users WHERE id=?').get(child).avatar_data, image);
  assert.equal((await display('GET', saved.body.user.avatar.replace('/api/v1', ''))).response.status, 200);
  assert.equal((await display('GET', `/family-avatars/${character}/image`)).response.status, 200);
  assert.equal((await display('POST', '/family-avatars', {})).response.status, 403);
});
test('timer writes require CSRF and anonymous callers cannot read them', async () => {
  const naked = await request('POST', '/tasks/timers/runs', {}, { Cookie: `${DISPLAY_COOKIE}=${token}` });
  assert.equal(naked.response.status, 403);
  assert.equal(naked.body.error, 'Invalid CSRF token.');
  assert.equal((await request('GET', '/tasks/timers')).response.status, 401);
});
