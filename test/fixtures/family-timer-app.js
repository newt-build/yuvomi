/** Disposable browser fixture. No production credentials or household data. */
process.env.DB_PATH = '/tmp/family-timer-browser.sqlite';
process.env.DB_ENCRYPTION_AUTO_KEY = 'false';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const { get } = await import('../../server/db.js');
const { createFamilyTimerRouter } = await import('../../server/routes/family-timers.js');
const { utcToWall } = await import('../../server/utils/timezone.js');
const db = get();
const ids = ['Ari', 'Bea'].map((label, index) => Number(db.prepare("INSERT INTO users(username,display_name,password_hash,family_role) VALUES(?,?,'fixture','child')").run('browser-child-' + index, label).lastInsertRowid));
const routineId = randomUUID();
const recurrence = { rule: 'FREQ=DAILY', quota: null, rdates: [], fromDate: '2026-01-01', dstPolicy: 'reject', localTime: '06:45', untilDate: null, exceptions: [], durationMinutes: 65, excludedOccurrences: [] };
const steps = [
  ['Lava il viso', 'fixed', 300, null], ['Colazione', 'compressible', 1200, 480],
  ['Lava i denti', 'fixed', 300, null], ['Vestiti', 'compressible', 600, 180], ['Gioco', 'optional', null, null],
].map(([label, durationClass, durationSeconds, minimumSeconds], order) => ({ id: randomUUID(), label, durationClass, durationSeconds, minimumSeconds, order }));
db.prepare('INSERT INTO family_timer_routines(id,version,label,timezone,recurrence,steps) VALUES(?,1,?,\'Europe/Rome\',?,?)')
  .run(routineId, 'Timer mattutino sintetico', JSON.stringify(recurrence), JSON.stringify(steps));
for (const id of ids) db.prepare('INSERT INTO family_timer_subjects VALUES(?,?,?)').run(routineId, id, randomUUID());
const app = express();
app.use(express.json());
// Only the synthetic principal is injected; all timer requests use real service + SQLite.
app.use((req, _res, next) => { req.authUserId = ids[0]; req.authMethod = 'display'; next(); });
app.use('/api/v1/tasks/timers', createFamilyTimerRouter({ database: db }));
app.get('/fixture', (_req, res) => res.type('html').send(`<!doctype html><html lang="it"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles/tokens.css"><link rel="stylesheet" href="/styles/reset.css"><link rel="stylesheet" href="/styles/family-timers.css"></head><body><main id="fixture"></main><script type="module">import {render} from '/pages/family-timers.js'; render(document.querySelector('#fixture'), {signal:new AbortController().signal});</script></body></html>`));
app.use(express.static(process.env.FAMILY_FIXTURE_PUBLIC || fileURLToPath(new URL('../../public', import.meta.url))));
const server = app.listen(3100, '0.0.0.0', () => console.log('Synthetic native timer fixture ready'));
for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => server.close(() => { db.close(); process.exit(0); }));
