process.env.DB_PATH = ':memory:';
process.env.SESSION_SECRET = 'family-avatar-synthetic-fixture-secret';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
const { get } = await import('../server/db.js');
const { createFamilyAvatarRouter } = await import('../server/routes/family-avatars.js');
const db = get();
const insert = db.prepare("INSERT INTO users(username,display_name,password_hash,family_role) VALUES(?,?,'fixture','child')");
const child = Number(insert.run('avatar-child', 'Persona sintetica').lastInsertRowid);
const guest = Number(insert.run('avatar-guest', 'Ospite').lastInsertRowid);
db.prepare('INSERT INTO split_expense_guest_users(user_id) VALUES(?)').run(guest);
const character = randomUUID();
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ9sAAAAASUVORK5CYII=';
db.prepare('INSERT INTO family_avatar_characters(id,title,image_data) VALUES(?,?,?)').run(character, 'Personaggio sintetico', image);
const app = express();app.use(express.json());
app.use((req, _res, next) => { req.authUserId = req.get('x-fixture-auth') === 'none' ? null : child; req.authMethod = 'display'; next(); });
app.use('/avatars', createFamilyAvatarRouter({ database: db }));
const server = app.listen(0, '127.0.0.1');await new Promise(resolve => server.once('listening', resolve));
test.after(() => server.close());
test.beforeEach(() => { db.prepare('DELETE FROM family_avatar_preferences').run(); db.prepare('UPDATE users SET avatar_data=NULL WHERE id=?').run(child); });
async function call(method, path = '', body, headers = {}) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}/avatars${path}`, { method,
    headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
const command = () => ({ characterId: character, expectedVersion: 0, expectedAvatarKey: null });

test('catalogue redacts account data and excludes guests', async () => {
  const result = await call('GET'); assert.equal(result.status, 200);
  assert.equal(result.body.users.length, 1); assert.equal(result.body.users[0].id, child);
  assert.equal(result.body.characters.length, 1);
  assert.deepEqual(Object.keys(result.body.users[0]).sort(), ['avatar', 'avatarCharacterId', 'avatarKey', 'id', 'label', 'version']);
});
test('selecting a character updates canonical users.avatar_data and association atomically', async () => {
  const saved = await call('PUT', `/users/${child}`, command()); assert.equal(saved.status, 200);
  assert.equal(saved.body.user.avatarCharacterId, character); assert.equal(saved.body.user.version, 1);
  assert.ok(saved.body.user.avatar.includes(`/people/${child}/avatar?v=`));
  assert.equal(db.prepare('SELECT avatar_data FROM users WHERE id=?').get(child).avatar_data, image);
  assert.equal(db.prepare('SELECT character_id FROM family_avatar_preferences WHERE user_id=?').get(child).character_id, character);
  assert.equal(db.prepare('SELECT count(*) n FROM contacts WHERE family_user_id=?').get(child).n, 1);
});
test('stale versions and concurrent ordinary photo changes cannot be overwritten', async () => {
  assert.equal((await call('PUT', `/users/${child}`, command())).status, 200);
  assert.equal((await call('PUT', `/users/${child}`, command())).status, 409);
  const state = (await call('GET')).body.users[0];
  db.prepare('UPDATE users SET avatar_data=NULL WHERE id=?').run(child);
  assert.equal((await call('GET')).body.users[0].avatarCharacterId, null);
  assert.equal((await call('PUT', `/users/${child}`, { characterId: character, expectedVersion: state.version, expectedAvatarKey: state.avatarKey })).status, 409);
});
test('kiosk cannot target guests or inject arbitrary images/URLs/roles', async () => {
  assert.equal((await call('PUT', `/users/${guest}`, command())).status, 404);
  assert.equal((await call('PUT', `/users/${child}`, { ...command(), avatar_data: image })).status, 400);
  assert.equal((await call('PUT', `/users/${child}`, { ...command(), role: 'admin' })).status, 400);
  assert.equal((await call('PUT', `/users/${child}`, { ...command(), characterId: randomUUID() })).status, 400);
  assert.equal(db.prepare('SELECT count(*) n FROM family_avatar_preferences').get().n, 0);
});
test('character images are authenticated and support private conditional reads', async () => {
  assert.equal((await call('GET', '', undefined, { 'x-fixture-auth': 'none' })).status, 401);
  const url = `http://127.0.0.1:${server.address().port}/avatars/${character}/image`;
  const response = await fetch(url); assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cache-control'), 'private, no-cache');
  assert.equal((await fetch(url, { headers: { 'If-None-Match': response.headers.get('etag') } })).status, 304);
  assert.equal((await fetch(url, { headers: { 'x-fixture-auth': 'none' } })).status, 401);
});
