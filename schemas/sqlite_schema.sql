-- =============================================================================
-- Klasio (Attendly) Mobile Offline-First SQLite Schema
-- Database: atten_offline.db
-- Driver: expo-sqlite (Android / iOS / Local Dev)
-- Source: mobile/src/storage/database.ts
-- =============================================================================

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- -----------------------------------------------------------------------------
-- 1. Authentication & Local Auth Session
-- Stores active JWT token and serialized UserPayload for instant offline login.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS local_auth_session (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token TEXT NOT NULL,
    user_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- -----------------------------------------------------------------------------
-- 2. Cached Roster & Face Embeddings
-- Offline cache for fast facial identification on device without host connection.
-- -----------------------------------------------------------------------------
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
    student_user_id TEXT NOT NULL,
    model_version TEXT NOT NULL,
    embedding_dimension INTEGER NOT NULL,
    embedding_blob BLOB NOT NULL,
    sample_index INTEGER NOT NULL DEFAULT 0,
    gallery_version INTEGER NOT NULL,
    PRIMARY KEY (student_user_id, model_version, sample_index)
);

-- -----------------------------------------------------------------------------
-- 3. Local Attendance Sessions & Attendance Records
-- Captures classroom attendance sessions created offline or online by faculty.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS local_attendance_sessions (
    client_session_uuid TEXT PRIMARY KEY,
    teaching_assignment_id TEXT NOT NULL,
    session_date TEXT NOT NULL,
    period_slot_or_sequence INTEGER NOT NULL,
    applicability_status TEXT NOT NULL CHECK(applicability_status IN ('COUNTED', 'CANCELLED', 'EXEMPT')),
    status_reason TEXT,
    regular_faculty_user_id TEXT NOT NULL,
    conducting_faculty_user_id TEXT NOT NULL,
    substitute_delegation_id TEXT,
    session_status TEXT NOT NULL CHECK(session_status IN ('DRAFT', 'FINALIZED', 'SYNCED')),
    finalized_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(teaching_assignment_id, session_date, period_slot_or_sequence)
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
    UNIQUE(client_session_uuid, student_user_id)
);

-- -----------------------------------------------------------------------------
-- 4. Sync Queue & Local Amendment Audits
-- Idempotent, durable offline-sync queue bridging local operations to backend.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_queue (
    queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_session_uuid TEXT NOT NULL,
    operation_type TEXT NOT NULL DEFAULT 'SESSION_SYNC' CHECK(operation_type IN ('SESSION_SYNC', 'AMENDMENT_SYNC')),
    client_amendment_id TEXT,
    endpoint_path TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    sync_status TEXT NOT NULL CHECK(sync_status IN ('PENDING', 'IN_FLIGHT', 'ACKNOWLEDGED', 'FAILED')),
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_retry_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_queue_session 
    ON sync_queue(client_session_uuid) 
    WHERE operation_type = 'SESSION_SYNC';

CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_queue_amendment 
    ON sync_queue(client_amendment_id) 
    WHERE operation_type = 'AMENDMENT_SYNC';

CREATE TABLE IF NOT EXISTS local_amendment_audits (
    audit_id TEXT PRIMARY KEY,
    client_amendment_id TEXT UNIQUE,
    client_session_uuid TEXT NOT NULL,
    student_user_id TEXT NOT NULL,
    previous_status TEXT NOT NULL CHECK(previous_status IN ('PRESENT', 'ABSENT', 'EXCUSED')),
    new_status TEXT NOT NULL CHECK(new_status IN ('PRESENT', 'ABSENT', 'EXCUSED')),
    amending_user_id TEXT NOT NULL,
    amendment_role TEXT NOT NULL CHECK(amendment_role IN ('REGULAR_FACULTY', 'ADMIN')),
    amendment_reason TEXT NOT NULL,
    amended_at TEXT NOT NULL
);

-- -----------------------------------------------------------------------------
-- 5. Student Portal Cache
-- Offline cache for student attendance records, statistics, and subject history.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cached_student_attendance (
    student_user_id TEXT PRIMARY KEY,
    overall_attendance_percentage REAL NOT NULL,
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

-- -----------------------------------------------------------------------------
-- 6. Notification Center Cache
-- -----------------------------------------------------------------------------
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

CREATE INDEX IF NOT EXISTS idx_cached_notifications_recipient 
    ON cached_notifications(recipient_user_id, created_at DESC);
