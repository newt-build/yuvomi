/** Household-safe discovery; catalogue changes remain administrator-only. */
import express from 'express';
import { requireAdmin } from '../middleware/require-admin.js';
import { FamilyAppsError, readFamilyApps, validateFamilyApps } from '../services/family-apps.js';
import { isHouseholdMember } from '../services/household-members.js';

export function createFamilyAppsRouter({ database }) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!Number.isSafeInteger(req.authUserId) || req.authUserId < 1) return res.status(401).json({ error: 'Accesso non autorizzato.', code: 401 });
    if (req.authMethod === 'api_token' || (req.authMethod !== 'display' && !isHouseholdMember(req.authUserId, { db: database }))) {
      return res.status(403).json({ error: 'Catalogo non disponibile per questo accesso.', code: 403 });
    }
    next();
  });
  const handle = action => (req, res) => {
    try { return res.json(action(req)); }
    catch (error) {
      if (error instanceof FamilyAppsError) return res.status(error.status).json({ error: error.message, code: error.status });
      return res.status(500).json({ error: 'Catalogo app non disponibile.', code: 500 });
    }
  };
  router.get('/', handle(() => ({ apps: readFamilyApps(database) })));
  router.put('/', requireAdmin, handle(req => {
    if (!req.body || Object.keys(req.body).length !== 1 || !Object.hasOwn(req.body, 'apps')) {
      throw new FamilyAppsError(400, 'Invia soltanto il catalogo app.');
    }
    const apps = validateFamilyApps(req.body.apps);
    database.prepare(`INSERT INTO sync_config(key,value) VALUES('family_apps',?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')`).run(JSON.stringify(apps));
    return { apps: readFamilyApps(database) };
  }));
  return router;
}
