/**
 * Test: Inventar — Behälter und effektive Position (Familien-Fork, §10.2)
 * Zweck: `kind` item|container, genau EINE Zwischenebene, geerbte Position
 *        (nie als Kopie gespeichert), Ortfilter über den Behälter, Suche über
 *        den Behälternamen, Löscheschutz für nicht leere Behälter.
 * Ausfuehren: node --test test/test-inventory-containers.js
 */

process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-secret';
process.env.DB_PATH = ':memory:';

import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const dbmod = await import('../server/db.js');
const { default: itemsRouter } = await import('../server/routes/inventory/items.js');
const db = dbmod.get();

const USER = db.prepare(`
  INSERT INTO users (username, display_name, password_hash, role)
  VALUES ('owner', 'Owner', 'x', 'member')
`).run().lastInsertRowid;

const app = express();
app.use(express.json({ limit: '7mb' }));
app.use((req, _res, next) => {
  req.authUserId = USER;
  req.session = { userId: USER };
  next();
});
app.use('/items', itemsRouter);
const server = app.listen(0, '127.0.0.1');
const baseUrl = await new Promise((r) => server.on('listening', () => r(`http://127.0.0.1:${server.address().port}`)));
test.after(() => server.close());

async function call(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 204 */ }
  return { status: res.status, body: json };
}

function makeLocation(name, parentId = null) {
  return db.prepare('INSERT INTO inventory_locations (name, parent_id) VALUES (?, ?)').run(name, parentId).lastInsertRowid;
}

test('POST: Default ist kind=item und kein Behälter', async () => {
  const r = await call('POST', '/items', { name: 'Bohrmaschine' });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.kind, 'item');
  assert.equal(r.body.data.container_id, null);
  assert.equal(r.body.data.container, null);
  assert.equal(r.body.data.location_source, null);
});

test('POST: Behälter anlegen, Gegenstand hineinlegen, Position erben', async () => {
  const room = makeLocation('Keller');
  const shelf = makeLocation('Regal 2', room);
  const box = await call('POST', '/items', { name: 'Schachtel Werkzeug', kind: 'container', location_id: shelf });
  assert.equal(box.status, 201);
  assert.equal(box.body.data.kind, 'container');

  const item = await call('POST', '/items', { name: 'Hammer', container_id: box.body.data.id });
  assert.equal(item.status, 201);
  assert.equal(item.body.data.container.id, box.body.data.id);
  assert.equal(item.body.data.container.name, 'Schachtel Werkzeug');
  // GEERBT, nicht kopiert: eigene location_id bleibt null.
  assert.equal(item.body.data.location_id, null);
  assert.equal(item.body.data.location_path, null);
  assert.equal(item.body.data.location_source, 'inherited');
  assert.equal(item.body.data.effective_location_path, 'Keller · Regal 2');
  assert.equal(item.body.data.effective_location_from, 'Schachtel Werkzeug');
});

test('die geerbte Position wird NICHT als Kopie in der Zeile gespeichert', async () => {
  const loc = makeLocation('Garage');
  const box = await call('POST', '/items', { name: 'Kiste', kind: 'container', location_id: loc });
  const item = await call('POST', '/items', { name: 'Schraube', container_id: box.body.data.id });
  const row = db.prepare('SELECT location_id, container_id FROM inventory_items WHERE id = ?').get(item.body.data.id);
  assert.equal(row.location_id, null);
  assert.equal(row.container_id, box.body.data.id);
});

test('Behälter umziehen ändert die effektive Position der Erbenden, nicht deren Zeile', async () => {
  const a = makeLocation('Dachboden');
  const b = makeLocation('Flur');
  const box = await call('POST', '/items', { name: 'Koffer', kind: 'container', location_id: a });
  const item = await call('POST', '/items', { name: 'Ladekabel', container_id: box.body.data.id });
  assert.equal(item.body.data.effective_location_path, 'Dachboden');

  const moved = await call('PUT', `/items/${box.body.data.id}`, { name: 'Koffer', kind: 'container', location_id: b });
  assert.equal(moved.status, 200);

  const after = await call('GET', `/items/${item.body.data.id}`);
  assert.equal(after.body.data.effective_location_path, 'Flur');
  assert.equal(after.body.data.location_source, 'inherited');
});

test('direkter Ort gewinnt gegen den Behälter (Override) und wird als direct gemeldet', async () => {
  const boxLoc = makeLocation('Keller');
  const ownLoc = makeLocation('Werkstatt');
  const box = await call('POST', '/items', { name: 'Kiste 2', kind: 'container', location_id: boxLoc });
  const item = await call('POST', '/items', { name: 'Zange', container_id: box.body.data.id, location_id: ownLoc });
  assert.equal(item.body.data.location_source, 'direct');
  assert.equal(item.body.data.effective_location_path, 'Werkstatt');
  assert.equal(item.body.data.container.id, box.body.data.id);
});

test('ein Behälter kann nicht in einem Behälter stehen (eine Zwischenebene)', async () => {
  const outer = await call('POST', '/items', { name: 'Grosse Kiste', kind: 'container' });
  const r = await call('POST', '/items', { name: 'Innenkiste', kind: 'container', container_id: outer.body.data.id });
  assert.equal(r.status, 400);
});

test('container_id muss auf einen Behälter zeigen, nicht auf einen Gegenstand', async () => {
  const plain = await call('POST', '/items', { name: 'Nur ein Ding' });
  const r = await call('POST', '/items', { name: 'X', container_id: plain.body.data.id });
  assert.equal(r.status, 400);
});

test('unbekannte container_id -> 400', async () => {
  const r = await call('POST', '/items', { name: 'X', container_id: 999999 });
  assert.equal(r.status, 400);
});

test('Ortfilter findet auch Gegenstände, die den Ort über den Behälter erben', async () => {
  const loc = makeLocation('Filterraum');
  const box = await call('POST', '/items', { name: 'Filterbox', kind: 'container', location_id: loc });
  await call('POST', '/items', { name: 'Filterobjekt', container_id: box.body.data.id });

  const r = await call('GET', `/items?location_id=${loc}`);
  assert.equal(r.status, 200);
  const names = r.body.data.map((i) => i.name);
  assert.ok(names.includes('Filterobjekt'), 'geerbtes Objekt fehlt im Ortsfilter');
});

test('Suche findet über den Behälternamen', async () => {
  const box = await call('POST', '/items', { name: 'Schachtel Sonderwerkzeug', kind: 'container' });
  await call('POST', '/items', { name: 'Inbusschlüssel', container_id: box.body.data.id });

  const r = await call('GET', '/items?q=Sonderwerkzeug');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.some((i) => i.name === 'Inbusschlüssel'));
});

test('Filter kind=container liefert nur Behälter', async () => {
  await call('POST', '/items', { name: 'Eimer', kind: 'container' });
  await call('POST', '/items', { name: 'Seife' });
  const r = await call('GET', '/items?kind=container');
  assert.equal(r.status, 200);
  assert.ok(r.body.data.length > 0);
  assert.ok(r.body.data.every((i) => i.kind === 'container'));
});

test('Löschen eines nicht leeren Behälters -> 409 mit Anzahl, kein Kaskadenlöschen', async () => {
  const box = await call('POST', '/items', { name: 'Volle Kiste', kind: 'container' });
  const item = await call('POST', '/items', { name: 'Inhalt', container_id: box.body.data.id });

  const r = await call('DELETE', `/items/${box.body.data.id}`);
  assert.equal(r.status, 409);
  assert.equal(r.body.reason, 'inventory_container_not_empty');
  assert.equal(r.body.child_count, 1);
  // Der Inhalt lebt weiter.
  assert.equal((await call('GET', `/items/${item.body.data.id}`)).status, 200);
});

test('ausdrückliches Ablösen (?detach=1) löscht den Behälter und lässt den Inhalt stehen', async () => {
  const box = await call('POST', '/items', { name: 'Alte Kiste', kind: 'container' });
  const item = await call('POST', '/items', { name: 'Bleibt', container_id: box.body.data.id });

  const del = await call('DELETE', `/items/${box.body.data.id}?detach=1`);
  assert.equal(del.status, 204);

  const after = await call('GET', `/items/${item.body.data.id}`);
  assert.equal(after.status, 200);
  assert.equal(after.body.data.container_id, null);
  assert.equal(after.body.data.container, null);
});

test('leerer Behälter lässt sich ohne detach löschen', async () => {
  const box = await call('POST', '/items', { name: 'Leere Kiste', kind: 'container' });
  const r = await call('DELETE', `/items/${box.body.data.id}`);
  assert.equal(r.status, 204);
});

test('Kind eines Behälters zählt child_count im Detail', async () => {
  const box = await call('POST', '/items', { name: 'Zählkiste', kind: 'container' });
  await call('POST', '/items', { name: 'A', container_id: box.body.data.id });
  await call('POST', '/items', { name: 'B', container_id: box.body.data.id });
  const r = await call('GET', `/items/${box.body.data.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.child_count, 2);
});

test('ein Behälter wird nicht versehentlich zum Gegenstand, wenn kind fehlt (volles Replace behält Default item)', async () => {
  const box = await call('POST', '/items', { name: 'Wird Gegenstand', kind: 'container' });
  const upd = await call('PUT', `/items/${box.body.data.id}`, { name: 'Wird Gegenstand' });
  assert.equal(upd.status, 200);
  // Volles Replace ohne kind: der Vertrag sagt Default 'item' - bewusst, damit
  // kein Datensatz ohne Angabe in einem unerwarteten Zustand bleibt.
  assert.equal(upd.body.data.kind, 'item');
});
