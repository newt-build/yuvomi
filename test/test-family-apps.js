process.env.DB_PATH = ':memory:';
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { validateFamilyApps, readFamilyApps, familyAppFrameSources } from '../server/services/family-apps.js';
const { get } = await import('../server/db.js');
const { createFamilyAppsRouter } = await import('../server/routes/family-apps.js');
const db = get();
const userId = Number(db.prepare("INSERT INTO users(username,display_name,password_hash) VALUES('apps-fixture','Fixture','x')").run().lastInsertRowid);
const app = express();app.use(express.json());
app.use((req, _res, next) => {
  req.authUserId = req.get('x-fixture-mode') === 'anonymous' ? null : userId;
  req.authMethod = req.get('x-fixture-mode') === 'display' ? 'display' : 'session';
  req.authRole = req.get('x-fixture-mode') === 'admin' ? 'admin' : 'member';next();
});
app.use('/apps', createFamilyAppsRouter({ database: db }));
const server = app.listen(0, '127.0.0.1');await new Promise(resolve => server.once('listening', resolve));
test.after(() => server.close());test.beforeEach(() => db.prepare("DELETE FROM sync_config WHERE key='family_apps'").run());
const sample = [
  { id: 'logopedia', label: 'Logopedia', url: 'https://family.gabry.online/apps/logopedia/logopedia.html', isolation: 'household' },
  { id: 'game', label: 'Gioco educativo', url: 'https://games.example.test/play', isolation: 'isolated' },
  { id: 'home-assistant', label: 'Casa', url: 'https://home.example.test/dashboard', isolation: 'household' },
];
async function call(method, mode, body) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/apps`, { method,
    headers: { 'Content-Type': 'application/json', 'x-fixture-mode': mode }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
test('catalogue supports multiple apps, not a hardcoded two-app switch', () => {
  assert.deepEqual(validateFamilyApps(sample), sample);
  assert.equal(validateFamilyApps([{ ...sample[0], url: '/apps/logopedia/logopedia.html' }])[0].url, '/apps/logopedia/logopedia.html');
});
test('rejects unsafe URLs, duplicate/default IDs and undeclared privileges', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,foo', '//other.test/', '/\\other.test/', 'http://remote.test/', 'https://user:pass@example.test/', 'https://example.test/\r\nheader']) {
    assert.throws(() => validateFamilyApps([{ ...sample[0], url }]), undefined, url);
  }
  assert.throws(() => validateFamilyApps([{ ...sample[0], id: 'family' }]));
  assert.throws(() => validateFamilyApps([sample[0], sample[0]]));
  assert.throws(() => validateFamilyApps([{ ...sample[0], allowMicrophone: true }]));
  assert.throws(() => validateFamilyApps([{ ...sample[0], isolation: 'unrestricted' }]));
});
test('administrator saves canonical registry and paired kiosk reads but cannot edit it', async () => {
  assert.equal((await call('PUT', 'admin', { apps: sample })).status, 200);
  assert.deepEqual((await call('GET', 'display')).body.apps, sample);
  assert.equal((await call('PUT', 'display', { apps: [] })).status, 403);
  assert.deepEqual(readFamilyApps(db), sample);
});
test('ordinary members cannot modify catalogue and anonymous requests cannot read it', async () => {
  assert.equal((await call('PUT', 'member', { apps: sample })).status, 403);
  assert.equal((await call('GET', 'anonymous')).status, 401);
  assert.deepEqual(readFamilyApps(db), []);
});
test('CSP sources follow approved catalogue origins only and corrupt config fails closed', async () => {
  assert.equal(familyAppFrameSources(db), "'self'");
  await call('PUT', 'admin', { apps: sample });
  assert.equal(familyAppFrameSources(db), "'self' https://family.gabry.online https://games.example.test https://home.example.test");
  db.prepare("UPDATE sync_config SET value='invalid-json' WHERE key='family_apps'").run();
  assert.equal(familyAppFrameSources(db), "'self'");
  assert.equal((await call('GET', 'display')).status, 500);
});
