/** Native timer persistence; installed by the versioned DB migration, not at request time. */
export const FAMILY_TIMER_SCHEMA = `
  CREATE TABLE family_timer_routines (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK(version > 0),
    label TEXT NOT NULL,
    timezone TEXT NOT NULL,
    recurrence TEXT NOT NULL CHECK(json_valid(recurrence)),
    steps TEXT NOT NULL CHECK(json_valid(steps)),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))
  );
  CREATE TABLE family_timer_subjects (
    routine_id TEXT NOT NULL REFERENCES family_timer_routines(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    source_subject_id TEXT NOT NULL,
    PRIMARY KEY(routine_id,user_id),
    UNIQUE(routine_id,source_subject_id)
  );
  CREATE TABLE family_timer_runs (
    id TEXT PRIMARY KEY,
    routine_id TEXT NOT NULL,
    occurrence_key TEXT NOT NULL,
    subject_id INTEGER NOT NULL REFERENCES users(id),
    snapshot TEXT NOT NULL CHECK(json_valid(snapshot)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
    started_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    completions TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(completions)),
    completed_at TEXT,
    within_deadline INTEGER CHECK(within_deadline IN (0,1)),
    UNIQUE(routine_id, occurrence_key, subject_id)
  );
  CREATE TABLE family_timer_operations (
    principal_key TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    status INTEGER NOT NULL,
    response TEXT NOT NULL CHECK(json_valid(response)),
    PRIMARY KEY(principal_key, operation_id)
  );
`;
