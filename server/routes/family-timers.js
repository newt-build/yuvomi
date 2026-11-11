/** Native Family timer; mounted under /api/v1/tasks/timers, behind auth/scopes/CSRF. */
import express from 'express';
import { isHouseholdMember } from '../services/household-members.js';
import { FamilyTimerStore, TimerError } from '../services/family-timer-store.js';
import { FamilyTimerService } from '../services/family-timer-service.js';
import { readNativeTimerScope } from '../services/family-timer-source.js';
import { createLogger } from '../logger.js';

const log = createLogger('FamilyTimer');

export function createFamilyTimerRouter({ database, now = () => new Date() }) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!Number.isSafeInteger(req.authUserId) || req.authUserId < 1) {
      return res.status(401).json({ error: 'Accesso non autorizzato.', code: 401 });
    }
    // No implicit reuse of adult or API-token privileges as a kitchen device.
    if (req.authMethod === 'api_token'
      || (req.authMethod !== 'display' && !isHouseholdMember(req.authUserId, { db: database }))) {
      return res.status(403).json({ error: 'Accesso al timer non autorizzato.', code: 403 });
    }
    next();
  });
  const handle = action => async (req, res) => {
    try {
      const store = new FamilyTimerStore(database, `${req.authMethod === 'display' ? 'display' : 'user'}:${req.authUserId}`,
        { now: () => now().toISOString() });
      const service = new FamilyTimerService(store, window => readNativeTimerScope(database, {
        ...(window ?? { from: req.query.from, to: req.query.to }), now: now(),
      }));
      return res.json(await action(service, req));
    } catch (error) {
      if (error instanceof TimerError) return res.status(error.status).json({ error: error.message, code: error.status, reason: error.code });
      // Do not log snapshots, child progress or SQL values.
      log.error('Native timer command failed', { type: error?.name });
      return res.status(500).json({ error: 'Timer temporaneamente non disponibile.', code: 500 });
    }
  };
  router.get('/', handle(service => service.overview()));
  router.post('/runs', handle((service, req) => service.start(req.body)));
  router.get('/runs/:id', handle((service, req) => service.get(req.params.id)));
  router.post('/runs/:id/steps', handle((service, req) => service.complete(req.params.id, req.body)));
  return router;
}
