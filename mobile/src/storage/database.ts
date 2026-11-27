import * as SQLite from 'expo-sqlite';

export const DB_NAME = 'atten_offline.db';

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS local_auth_session (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token TEXT NOT NULL,
    user_json TEXT NOT NULL,
    membership_id TEXT NOT NULL DEFAULT 'default-membership',
    authorization_snapshot_json TEXT NOT NULL DEFAULT '{}',
    authorization_version TEXT NOT NULL DEFAULT 'v1.0',
    last_server_validation_at TEXT NOT NULL DEFAULT '',
    token_expires_at TEXT,
    snapshot_expires_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cached_rosters (
    teaching_assignment_id TEXT NOT NULL,
    student_user_id TEXT NOT NULL,
    institutional_id TEXT NOT NULL,
    student_name TEXT NOT NULL,
    effective_start_date TEXT NOT NULL,
    effective_end_date TEXT,
    face_registration_state TEXT NOT NULL CHECK(face_registration_state IN ('UNREGISTERED', 'PENDING', 'REGISTERED')),
    cached_at TEXT NOT NULL,
    PRIMARY KEY (teaching_assignment_id, student_user_id)
);

CREATE TABLE IF NOT EXISTS cached_embeddings (
    teaching_assignment_id TEXT NOT NULL DEFAULT '',
    student_user_id TEXT NOT NULL,
    model_version TEXT NOT NULL,
    embedding_dimension INTEGER NOT NULL CHECK (embedding_dimension > 0),
    embedding_blob BLOB NOT NULL,
    sample_index INTEGER NOT NULL DEFAULT 0 CHECK (sample_index >= 0),
    gallery_version INTEGER NOT NULL CHECK (gallery_version >= 0),
    cached_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (teaching_assignment_id, student_user_id, model_version, sample_index)
);

CREATE TABLE IF NOT EXISTS local_attendance_sessions (
    client_session_uuid TEXT PRIMARY KEY,
    teaching_assignment_id TEXT NOT NULL,
    session_date TEXT NOT NULL,
    period_slot_or_sequence INTEGER NOT NULL CHECK (period_slot_or_sequence > 0),
    applicability_status TEXT NOT NULL CHECK(applicability_status IN ('COUNTED', 'CANCELLED', 'EXEMPT')),
    status_reason TEXT,
    regular_faculty_user_id TEXT NOT NULL,
    conducting_faculty_user_id TEXT NOT NULL,
    authorizing_role_assignment_id TEXT DEFAULT 'default-role-assignment',
    delegation_id TEXT,
    authorization_version TEXT NOT NULL DEFAULT 'v1.0',
    substitute_delegation_id TEXT,
    session_status TEXT NOT NULL CHECK(session_status IN ('DRAFT', 'FINALIZED', 'SYNCED')),
    finalized_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(teaching_assignment_id, session_date, period_slot_or_sequence),
    CHECK (authorizing_role_assignment_id IS NOT NULL OR delegation_id IS NOT NULL OR substitute_delegation_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS local_attendance_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_session_uuid TEXT NOT NULL,
    student_user_id TEXT NOT NULL,
    attendance_status TEXT NOT NULL CHECK(attendance_status IN ('PRESENT', 'ABSENT', 'EXCUSED')),
    mark_source TEXT NOT NULL CHECK(mark_source IN ('AI_VERIFIED', 'MANUAL_MARK', 'MANUAL_OVERRIDE')),
    candidate_confidence REAL,
    recorded_at TEXT NOT NULL,
    FOREIGN KEY(client_session_uuid) REFERENCES local_attendance_sessions(client_session_uuid) ON DELETE CASCADE,
    UNIQUE(client_session_uuid, student_user_id),
    CHECK (candidate_confidence IS NULL OR (candidate_confidence >= 0.0 AND candidate_confidence <= 1.0))
);

CREATE TABLE IF NOT EXISTS sync_queue (
    queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_session_uuid TEXT NOT NULL,
    operation_type TEXT NOT NULL DEFAULT 'SESSION_SYNC' CHECK(operation_type IN ('SESSION_SYNC', 'AMENDMENT_SYNC')),
    client_amendment_id TEXT,
    endpoint_path TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    actor_membership_id TEXT NOT NULL DEFAULT 'default-membership',
    authorizing_role_assignment_id TEXT,
    delegation_id TEXT,
    authorization_version TEXT NOT NULL DEFAULT 'v1.0',
    sync_status TEXT NOT NULL CHECK(sync_status IN ('PENDING', 'IN_FLIGHT', 'ACKNOWLEDGED', 'FAILED')),
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    last_error TEXT,
    next_retry_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
        (operation_type = 'SESSION_SYNC' AND client_amendment_id IS NULL)
        OR (operation_type = 'AMENDMENT_SYNC' AND client_amendment_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_queue_session ON sync_queue(client_session_uuid) WHERE operation_type = 'SESSION_SYNC';
CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_queue_amendment ON sync_queue(client_amendment_id) WHERE operation_type = 'AMENDMENT_SYNC';

CREATE TABLE IF NOT EXISTS local_amendment_audits (
    audit_id TEXT PRIMARY KEY,
    client_amendment_id TEXT UNIQUE,
    client_session_uuid TEXT NOT NULL,
    student_user_id TEXT NOT NULL,
    previous_status TEXT NOT NULL CHECK(previous_status IN ('PRESENT', 'ABSENT', 'EXCUSED')),
    new_status TEXT NOT NULL CHECK(new_status IN ('PRESENT', 'ABSENT', 'EXCUSED')),
    amending_user_id TEXT NOT NULL,
    actor_membership_id TEXT NOT NULL DEFAULT 'default-membership',
    authorizing_role_assignment_id TEXT DEFAULT 'default-role-assignment',
    delegation_id TEXT,
    permission_code TEXT NOT NULL DEFAULT 'attendance.amend',
    scope_type TEXT NOT NULL DEFAULT 'TEACHING_ASSIGNMENT',
    scope_resource_id TEXT NOT NULL DEFAULT 'default-resource',
    amendment_role TEXT DEFAULT 'REGULAR_FACULTY',
    amendment_reason TEXT NOT NULL,
    amended_at TEXT NOT NULL,
    CHECK (authorizing_role_assignment_id IS NOT NULL OR delegation_id IS NOT NULL),
    CHECK (new_status <> previous_status),
    CHECK (length(trim(amendment_reason)) >= 10)
);

CREATE TABLE IF NOT EXISTS cached_student_attendance (
    student_user_id TEXT PRIMARY KEY,
    overall_attendance_percentage REAL CHECK(overall_attendance_percentage IS NULL OR (overall_attendance_percentage >= 0.0 AND overall_attendance_percentage <= 100.0)),
    payload_json TEXT NOT NULL,
    cached_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cached_student_subject_history (
    teaching_assignment_id TEXT PRIMARY KEY,
    student_user_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    cached_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cached_student_requests (
    id TEXT PRIMARY KEY,
    student_user_id TEXT NOT NULL,
    teaching_assignment_id TEXT NOT NULL,
    subject_name TEXT NOT NULL,
    session_date TEXT NOT NULL,
    student_note TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('Sent', 'Being reviewed', 'Accepted', 'Not accepted')),
    resolution_note TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cached_notifications (
    id TEXT PRIMARY KEY,
    recipient_user_id TEXT NOT NULL,
    category TEXT NOT NULL,
    priority TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    payload_json TEXT,
    action_route TEXT,
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cached_notifications_recipient ON cached_notifications(recipient_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS local_key_value (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
`;

let dbInstance: SQLite.SQLiteDatabase | null = null;
let initPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export async function getDatabase(dbName: string = DB_NAME): Promise<SQLite.SQLiteDatabase> {
  if (dbInstance) {
    return dbInstance;
  }
  if (!initPromise) {
    initPromise = (async () => {
      const db = await SQLite.openDatabaseAsync(dbName);
      try {
        await db.runAsync('PRAGMA busy_timeout = 5000;');
      } catch {}
      try {
        await db.runAsync('PRAGMA journal_mode = WAL;');
      } catch {}
      try {
        await db.runAsync('PRAGMA foreign_keys = ON;');
      } catch {}
      const statements = SCHEMA_SQL.split(';')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && !s.toUpperCase().startsWith('PRAGMA'));
      for (const stmt of statements) {
        try {
          await db.runAsync(`${stmt};`);
        } catch (err) {
          console.warn('[DB_INIT] statement warning:', err);
        }
      }
      const migrations = [
        "ALTER TABLE sync_queue ADD COLUMN operation_type TEXT NOT NULL DEFAULT 'SESSION_SYNC';",
        "ALTER TABLE sync_queue ADD COLUMN client_amendment_id TEXT;",
        "ALTER TABLE sync_queue ADD COLUMN actor_membership_id TEXT NOT NULL DEFAULT 'default-membership';",
        "ALTER TABLE sync_queue ADD COLUMN authorizing_role_assignment_id TEXT;",
        "ALTER TABLE sync_queue ADD COLUMN delegation_id TEXT;",
        "ALTER TABLE sync_queue ADD COLUMN authorization_version TEXT NOT NULL DEFAULT 'v1.0';",
        "ALTER TABLE local_attendance_sessions ADD COLUMN authorizing_role_assignment_id TEXT DEFAULT 'default-role-assignment';",
        "ALTER TABLE local_attendance_sessions ADD COLUMN delegation_id TEXT;",
        "ALTER TABLE local_attendance_sessions ADD COLUMN authorization_version TEXT NOT NULL DEFAULT 'v1.0';",
        "ALTER TABLE local_attendance_sessions ADD COLUMN substitute_delegation_id TEXT;",
        "ALTER TABLE local_auth_session ADD COLUMN membership_id TEXT NOT NULL DEFAULT 'default-membership';",
        "ALTER TABLE local_auth_session ADD COLUMN authorization_snapshot_json TEXT NOT NULL DEFAULT '{}';",
        "ALTER TABLE local_auth_session ADD COLUMN authorization_version TEXT NOT NULL DEFAULT 'v1.0';",
        "ALTER TABLE local_auth_session ADD COLUMN last_server_validation_at TEXT NOT NULL DEFAULT '';",
        "ALTER TABLE local_auth_session ADD COLUMN token_expires_at TEXT;",
        "ALTER TABLE local_auth_session ADD COLUMN snapshot_expires_at TEXT NOT NULL DEFAULT '';",
        "ALTER TABLE local_amendment_audits ADD COLUMN actor_membership_id TEXT NOT NULL DEFAULT 'default-membership';",
        "ALTER TABLE local_amendment_audits ADD COLUMN authorizing_role_assignment_id TEXT DEFAULT 'default-role-assignment';",
        "ALTER TABLE local_amendment_audits ADD COLUMN delegation_id TEXT;",
        "ALTER TABLE local_amendment_audits ADD COLUMN permission_code TEXT NOT NULL DEFAULT 'attendance.amend';",
        "ALTER TABLE local_amendment_audits ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'TEACHING_ASSIGNMENT';",
        "ALTER TABLE local_amendment_audits ADD COLUMN scope_resource_id TEXT NOT NULL DEFAULT 'default-resource';",
        "ALTER TABLE local_amendment_audits ADD COLUMN amendment_role TEXT DEFAULT 'REGULAR_FACULTY';",
        "ALTER TABLE cached_embeddings ADD COLUMN teaching_assignment_id TEXT NOT NULL DEFAULT '';",
        "ALTER TABLE cached_embeddings ADD COLUMN cached_at TEXT NOT NULL DEFAULT '';",
      ];
      for (const mig of migrations) {
        try {
          await db.runAsync(mig);
        } catch {}
      }
      dbInstance = db;
      return db;
    })();
  }
  return initPromise;
}

export async function initDatabase(dbName: string = DB_NAME): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(dbName);
  try {
    await db.runAsync('PRAGMA busy_timeout = 5000;');
  } catch {}
  try {
    await db.runAsync('PRAGMA journal_mode = WAL;');
  } catch {}
  try {
    await db.runAsync('PRAGMA foreign_keys = ON;');
  } catch {}
  const statements = SCHEMA_SQL.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.toUpperCase().startsWith('PRAGMA'));
  for (const stmt of statements) {
    try {
      await db.runAsync(`${stmt};`);
    } catch (err) {
      console.warn('[DB_INIT] statement warning:', err);
    }
  }
  // Migration helpers for existing legacy tables on physical devices
  const migrations = [
    "ALTER TABLE sync_queue ADD COLUMN operation_type TEXT NOT NULL DEFAULT 'SESSION_SYNC';",
    "ALTER TABLE sync_queue ADD COLUMN client_amendment_id TEXT;",
    "ALTER TABLE sync_queue ADD COLUMN actor_membership_id TEXT NOT NULL DEFAULT 'default-membership';",
    "ALTER TABLE sync_queue ADD COLUMN authorizing_role_assignment_id TEXT;",
    "ALTER TABLE sync_queue ADD COLUMN delegation_id TEXT;",
    "ALTER TABLE sync_queue ADD COLUMN authorization_version TEXT NOT NULL DEFAULT 'v1.0';",
    "ALTER TABLE local_attendance_sessions ADD COLUMN authorizing_role_assignment_id TEXT DEFAULT 'default-role-assignment';",
    "ALTER TABLE local_attendance_sessions ADD COLUMN delegation_id TEXT;",
    "ALTER TABLE local_attendance_sessions ADD COLUMN authorization_version TEXT NOT NULL DEFAULT 'v1.0';",
    "ALTER TABLE local_attendance_sessions ADD COLUMN substitute_delegation_id TEXT;",
    "ALTER TABLE local_auth_session ADD COLUMN membership_id TEXT NOT NULL DEFAULT 'default-membership';",
    "ALTER TABLE local_auth_session ADD COLUMN authorization_snapshot_json TEXT NOT NULL DEFAULT '{}';",
    "ALTER TABLE local_auth_session ADD COLUMN authorization_version TEXT NOT NULL DEFAULT 'v1.0';",
    "ALTER TABLE local_auth_session ADD COLUMN last_server_validation_at TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE local_auth_session ADD COLUMN token_expires_at TEXT;",
    "ALTER TABLE local_auth_session ADD COLUMN snapshot_expires_at TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE local_amendment_audits ADD COLUMN actor_membership_id TEXT NOT NULL DEFAULT 'default-membership';",
    "ALTER TABLE local_amendment_audits ADD COLUMN authorizing_role_assignment_id TEXT DEFAULT 'default-role-assignment';",
    "ALTER TABLE local_amendment_audits ADD COLUMN delegation_id TEXT;",
    "ALTER TABLE local_amendment_audits ADD COLUMN permission_code TEXT NOT NULL DEFAULT 'attendance.amend';",
    "ALTER TABLE local_amendment_audits ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'TEACHING_ASSIGNMENT';",
    "ALTER TABLE local_amendment_audits ADD COLUMN scope_resource_id TEXT NOT NULL DEFAULT 'default-resource';",
    "ALTER TABLE local_amendment_audits ADD COLUMN amendment_role TEXT DEFAULT 'REGULAR_FACULTY';",
    "ALTER TABLE cached_embeddings ADD COLUMN teaching_assignment_id TEXT NOT NULL DEFAULT '';",
    "ALTER TABLE cached_embeddings ADD COLUMN cached_at TEXT NOT NULL DEFAULT '';",
  ];
  for (const mig of migrations) {
    try {
      await db.runAsync(mig);
    } catch {}
  }
  return db;
}

export async function getLocalKeyValue(key: string): Promise<string | null> {
  try {
    const db = await getDatabase();
    const row = await db.getFirstAsync<{ value: string }>(
      'SELECT value FROM local_key_value WHERE key = ?;',
      [key]
    );
    return row?.value ?? null;
  } catch {
    return null;
  }
}

export async function setLocalKeyValue(key: string, value: string): Promise<void> {
  try {
    const db = await getDatabase();
    const now = new Date().toISOString();
    await db.runAsync(
      `INSERT INTO local_key_value (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
      [key, value, now]
    );
  } catch (err) {
    console.warn('[DB] Failed to setLocalKeyValue:', err);
  }
}

