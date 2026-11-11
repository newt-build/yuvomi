/** Canonical character catalogue and optimistic user associations. */
export const FAMILY_AVATAR_SCHEMA = `
  CREATE TABLE family_avatar_characters (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    image_data TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
  );
  CREATE TABLE family_avatar_preferences (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    character_id TEXT NOT NULL REFERENCES family_avatar_characters(id),
    version INTEGER NOT NULL CHECK(version > 0),
    avatar_key TEXT
  );
`;
