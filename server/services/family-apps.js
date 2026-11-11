/** Administrator-owned app catalogue. Public metadata only, never credentials. */
export class FamilyAppsError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function validateFamilyApps(value) {
  if (!Array.isArray(value) || value.length > 50) throw new FamilyAppsError(400, 'Il catalogo può contenere fino a 50 app.');
  const ids = new Set(['family']);
  return value.map(app => {
    if (!app || typeof app !== 'object' || Array.isArray(app)
      || Object.keys(app).some(key => !['id', 'label', 'url', 'isolation'].includes(key))
      || typeof app.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(app.id) || ids.has(app.id)
      || typeof app.label !== 'string' || !app.label.trim() || app.label.length > 100
      || typeof app.url !== 'string' || app.url.length > 2000
      || !['household', 'isolated'].includes(app.isolation)) {
      throw new FamilyAppsError(400, 'Descrizione app non valida o identificativo duplicato.');
    }
    ids.add(app.id);
    const relative = app.url.startsWith('/') && !app.url.startsWith('//') && !app.url.includes('\\');
    let url;
    try { url = new URL(app.url, 'https://family.invalid'); }
    catch { throw new FamilyAppsError(400, 'Indirizzo app non valido.'); }
    if (url.username || url.password || url.protocol !== 'https:' || (!relative && url.hostname === 'family.invalid')
      || /[\r\n]/.test(app.url) || (!relative && !app.url.startsWith('https://'))) {
      throw new FamilyAppsError(400, 'Usa un indirizzo HTTPS senza credenziali, oppure un percorso locale.');
    }
    return { id: app.id, label: app.label.trim(), url: relative ? url.pathname + url.search + url.hash : url.href, isolation: app.isolation };
  });
}
export function readFamilyApps(database) {
  const raw = database.prepare("SELECT value FROM sync_config WHERE key='family_apps'").get()?.value;
  if (!raw) return [];
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw new FamilyAppsError(500, 'Il catalogo app configurato non è valido.'); }
  try { return validateFamilyApps(parsed); }
  catch { throw new FamilyAppsError(500, 'Il catalogo app configurato non è valido.'); }
}
export function familyAppFrameSources(database) {
  try {
    return ["'self'", ...new Set(readFamilyApps(database).filter(app => app.url.startsWith('https://')).map(app => new URL(app.url).origin))].join(' ');
  } catch { return "'self'"; } // Corrupt config fails closed; the catalogue API reports the error.
}
