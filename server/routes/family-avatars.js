/** Character picker: changes the canonical profile image, never authenticates a selected person. */
import express from 'express';
import { createHash } from 'node:crypto';
import { householdMemberSql, memberOrderSql, isHouseholdMember } from '../services/household-members.js';
import { personAvatarUrlSql, parseAvatarDataUrl } from '../services/person-avatar.js';
import { normalizeAvatarData, syncFamilyMemberArtifacts } from '../auth.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
class AvatarError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function createFamilyAvatarRouter({ database }) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (!Number.isSafeInteger(req.authUserId) || req.authUserId < 1) return res.status(401).json({ error: 'Accesso non autorizzato.', code: 401 });
    if (req.authMethod === 'api_token' || (req.authMethod !== 'display' && !isHouseholdMember(req.authUserId, { db: database }))) {
      return res.status(403).json({ error: 'Avatar non disponibili per questo accesso.', code: 403 });
    }
    next();
  });
  const member = id => database.prepare(`SELECT u.id,u.display_name AS label,u.avatar_key,
    ${personAvatarUrlSql('u')} AS avatar,p.character_id,p.version,p.avatar_key AS saved_key
    FROM users u LEFT JOIN family_avatar_preferences p ON p.user_id=u.id
    WHERE u.id=? AND ${householdMemberSql('u')}`).get(id);
  const dto = row => ({ id: row.id, label: row.label, avatar: row.avatar, avatarKey: row.avatar_key,
    avatarCharacterId: row.saved_key === row.avatar_key ? row.character_id ?? null : null, version: row.version ?? 0 });
  const handle = action => (req, res) => {
    try { return action(req, res); }
    catch (error) {
      return res.status(error instanceof AvatarError ? error.status : 500)
        .json({ error: error instanceof AvatarError ? error.message : 'Avatar temporaneamente non disponibili.', code: error instanceof AvatarError ? error.status : 500 });
    }
  };
  router.get('/', handle((_req, res) => {
    const users = database.prepare(`SELECT u.id FROM users u WHERE ${householdMemberSql('u')} ORDER BY ${memberOrderSql('u')}`).all().map(row => dto(member(row.id)));
    const characters = database.prepare('SELECT id,title FROM family_avatar_characters WHERE active=1 ORDER BY title,id').all()
      .map(row => ({ id: row.id, title: row.title, image: `/api/v1/family-avatars/${row.id}/image` }));
    return res.json({ users, characters });
  }));
  router.get('/:id/image', handle((req, res) => {
    if (!UUID.test(req.params.id)) throw new AvatarError(400, 'Personaggio non valido.');
    const character = database.prepare('SELECT image_data FROM family_avatar_characters WHERE id=? AND active=1').get(req.params.id);
    const image = character && parseAvatarDataUrl(character.image_data);
    if (!image) throw new AvatarError(404, 'Immagine del personaggio non disponibile.');
    const etag = '"' + createHash('sha256').update(image.bytes).digest('hex') + '"';
    res.set({ 'Cache-Control': 'private, no-cache', ETag: etag });
    if (req.get('If-None-Match') === etag) return res.status(304).end();
    return res.type(image.mime).send(image.bytes);
  }));
  router.put('/users/:id', handle((req, res) => {
    const input = req.body;
    if (!/^\d+$/.test(req.params.id) || !Number.isSafeInteger(Number(req.params.id))
      || !input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['characterId', 'expectedVersion', 'expectedAvatarKey'].includes(key))
      || !UUID.test(input.characterId) || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 0 || input.expectedVersion > 2147483646
      || (input.expectedAvatarKey !== null && (typeof input.expectedAvatarKey !== 'string' || !/^[0-9a-f]{32}$/.test(input.expectedAvatarKey)))) {
      throw new AvatarError(400, 'Associazione avatar non valida.');
    }
    const id = Number(req.params.id);
    const saved = database.transaction(() => {
      const current = member(id);
      if (!current) throw new AvatarError(404, 'Persona non disponibile nel nucleo familiare.');
      if ((current.version ?? 0) !== input.expectedVersion || current.avatar_key !== input.expectedAvatarKey) {
        throw new AvatarError(409, 'Il profilo è cambiato. Rileggi gli avatar prima di salvare.');
      }
      const character = database.prepare('SELECT image_data FROM family_avatar_characters WHERE id=? AND active=1').get(input.characterId);
      if (!character) throw new AvatarError(400, 'Personaggio non presente nel catalogo.');
      const image = normalizeAvatarData(character.image_data);
      if (!image || image.error) throw new AvatarError(422, 'Immagine del personaggio non utilizzabile come profilo.');
      database.prepare('UPDATE users SET avatar_data=? WHERE id=?').run(image, id);
      syncFamilyMemberArtifacts(database, id, { avatarData: image, actorUserId: req.authUserId });
      const key = database.prepare('SELECT avatar_key FROM users WHERE id=?').get(id).avatar_key;
      database.prepare(`INSERT INTO family_avatar_preferences(user_id,character_id,version,avatar_key) VALUES(?,?,1,?)
        ON CONFLICT(user_id) DO UPDATE SET character_id=excluded.character_id,version=version+1,avatar_key=excluded.avatar_key`)
        .run(id, input.characterId, key);
      return dto(member(id));
    }).immediate();
    return res.json({ user: saved });
  }));
  return router;
}
