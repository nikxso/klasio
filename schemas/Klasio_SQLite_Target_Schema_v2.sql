-- =============================================================================
-- KLASIO - SQLite local/offline target schema (single-institution installation)
-- =============================================================================
-- Target schema for the mobile app's local SQLite database.
-- This file is a fresh/replacement schema reference, not an in-place migration.
-- Existing production/local databases must be upgraded through versioned SQLite
-- migrations (table rebuilds where necessary), not by re-running this file.
--
-- Server PostgreSQL remains authoritative for users, memberships, role templates,
-- permissions, role assignments, scopes and delegations. SQLite stores a signed/
-- versioned authorization snapshot for offline UX and provenance, then the server
-- re-authorizes queued operations at sync time.
-- =============================================================================

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- -----------------------------------------------------------------------------
-- 1. Authentication and combined authorization snapshot
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS local_auth_session (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    token TEXT NOT NULL,
    user_json TEXT NOT NULL,
    membership_id TEXT NOT NULL,
    authorization_snapshot_json TEXT NOT NULL,
    authorization_version TEXT NOT NULL,
    last_server_validation_at TEXT NOT NULL,
    token_expires_at TEXT,
    snapshot_expires_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- No local active_role column: the app renders the union of allowed capabilities
-- from authorization_snapshot_json. Resource actions still require a matching
-- scope and the backend makes the final authorization decision.

-- -----------------------------------------------------------------------------
-- 2. Assignment-scoped roster and embedding cache
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cached_rosters (
    teaching_assignment_id TEXT NOT NULL,
    student_user_id TEXT NOT NULL,
    institutional_id TEXT NOT NULL,
    student_name TEXT NOT NULL,
    effective_start_date TEXT NOT NULL,
    effective_end_date TEXT,
    face_registration_state TEXT NOT NULL
        CHECK (face_registration_state IN ('UNREGISTERED', 'PENDING', 'REGISTERED')),
    cached_at TEXT NOT NULL,
    PRIMARY KEY (teaching_assignment_id, student_user_id),
    CHECK (effective_end_date IS NULL OR effective_end_date >= effective_start_date)
);

CREATE TABLE IF NOT EXISTS cached_embeddings (
    teaching_assignment_id TEXT NOT NULL,
    student_user_id TEXT NOT NULL,
    model_version TEXT NOT NULL,
    embedding_dimension INTEGER NOT NULL CHECK (embedding_dimension > 0),
    embedding_blob BLOB NOT NULL,
    sample_index INTEGER NOT NULL DEFAULT 0 CHECK (sample_index >= 0),
    gallery_version INTEGER NOT NULL CHECK (gallery_version >= 0),
    cached_at TEXT NOT NULL,
    PRIMARY KEY (teaching_assignment_id, student_user_id, model_version, sample_index),
    FOREIGN KEY (teaching_assignment_id, student_user_id)
        REFERENCES cached_rosters(teaching_assignment_id, student_user_id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS ix_cached_rosters_student
    ON cached_rosters(student_user_id);
CREATE INDEX IF NOT EXISTS ix_cached_embeddings_assignment_model
    ON cached_embeddings(teaching_assignment_id, model_version, gallery_version);

-- A cached embedding is now explicitly tied to the roster/teaching assignment
-- for which it was delivered. This prevents an unscoped, institution-wide local
-- embedding cache from accidentally becoming the matching gallery.

-- -----------------------------------------------------------------------------
-- 3. Local attendance sessions and finalized records
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS local_attendance_sessions (
    client_session_uuid TEXT PRIMARY KEY,
    teaching_assignment_id TEXT NOT NULL,
    session_date TEXT NOT NULL,
    period_slot_or_sequence INTEGER NOT NULL CHECK (period_slot_or_sequence > 0),
    applicability_status TEXT NOT NULL
        CHECK (applicability_status IN ('COUNTED', 'CANCELLED', 'EXEMPT')),
    status_reason TEXT,
    regular_faculty_user_id TEXT NOT NULL,
    conducting_faculty_user_id TEXT NOT NULL,
    authorizing_role_assignment_id TEXT,
    delegation_id TEXT,
    authorization_version TEXT NOT NULL,
    session_status TEXT NOT NULL
        CHECK (session_status IN ('DRAFT', 'FINALIZED', 'SYNCED')),
    finalized_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (teaching_assignment_id, session_date, period_slot_or_sequence),
    CHECK (authorizing_role_assignment_id IS NOT NULL OR delegation_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS local_attendance_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_session_uuid TEXT NOT NULL,
    student_user_id TEXT NOT NULL,
    attendance_status TEXT NOT NULL
        CHECK (attendance_status IN ('PRESENT', 'ABSENT', 'EXCUSED')),
    mark_source TEXT NOT NULL
        CHECK (mark_source IN ('AI_VERIFIED', 'MANUAL_MARK', 'MANUAL_OVERRIDE')),
    candidate_confidence REAL,
    recorded_at TEXT NOT NULL,
    FOREIGN KEY (client_session_uuid)
        REFERENCES local_attendance_sessions(client_session_uuid)
        ON DELETE CASCADE,
    UNIQUE (client_session_uuid, student_user_id),
    CHECK (candidate_confidence IS NULL OR
           (candidate_confidence >= 0.0 AND candidate_confidence <= 1.0))
);

CREATE INDEX IF NOT EXISTS ix_local_sessions_assignment_date
    ON local_attendance_sessions(teaching_assignment_id, session_date);
CREATE INDEX IF NOT EXISTS ix_local_attendance_student
    ON local_attendance_records(student_user_id);

-- -----------------------------------------------------------------------------
-- 4. Durable sync queue with authorization provenance
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_queue (
    queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_session_uuid TEXT NOT NULL,
    operation_type TEXT NOT NULL DEFAULT 'SESSION_SYNC'
        CHECK (operation_type IN ('SESSION_SYNC', 'AMENDMENT_SYNC')),
    client_amendment_id TEXT,
    endpoint_path TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    actor_membership_id TEXT NOT NULL,
    authorizing_role_assignment_id TEXT,
    delegation_id TEXT,
    authorization_version TEXT NOT NULL,
    sync_status TEXT NOT NULL
        CHECK (sync_status IN ('PENDING', 'IN_FLIGHT', 'ACKNOWLEDGED', 'FAILED')),
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    last_error TEXT,
    next_retry_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (client_session_uuid)
        REFERENCES local_attendance_sessions(client_session_uuid)
        ON DELETE RESTRICT,
    CHECK (
        (operation_type = 'SESSION_SYNC' AND client_amendment_id IS NULL)
        OR (operation_type = 'AMENDMENT_SYNC' AND client_amendment_id IS NOT NULL)
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_queue_session
    ON sync_queue(client_session_uuid)
    WHERE operation_type = 'SESSION_SYNC';
CREATE UNIQUE INDEX IF NOT EXISTS uq_sync_queue_amendment
    ON sync_queue(client_amendment_id)
    WHERE operation_type = 'AMENDMENT_SYNC';
CREATE INDEX IF NOT EXISTS ix_sync_queue_status_retry
    ON sync_queue(sync_status, next_retry_at);

-- -----------------------------------------------------------------------------
-- 5. Local amendment audit - role-neutral and assignment/delegation-aware
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS local_amendment_audits (
    audit_id TEXT PRIMARY KEY,
    client_amendment_id TEXT NOT NULL UNIQUE,
    client_session_uuid TEXT NOT NULL,
    student_user_id TEXT NOT NULL,
    previous_status TEXT NOT NULL
        CHECK (previous_status IN ('PRESENT', 'ABSENT', 'EXCUSED')),
    new_status TEXT NOT NULL
        CHECK (new_status IN ('PRESENT', 'ABSENT', 'EXCUSED')),
    amending_user_id TEXT NOT NULL,
    actor_membership_id TEXT NOT NULL,
    authorizing_role_assignment_id TEXT,
    delegation_id TEXT,
    permission_code TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_resource_id TEXT NOT NULL,
    amendment_reason TEXT NOT NULL,
    amended_at TEXT NOT NULL,
    FOREIGN KEY (client_session_uuid)
        REFERENCES local_attendance_sessions(client_session_uuid)
        ON DELETE RESTRICT,
    CHECK (authorizing_role_assignment_id IS NOT NULL OR delegation_id IS NOT NULL),
    CHECK (new_status <> previous_status),
    CHECK (length(trim(amendment_reason)) >= 10)
);

-- No REGULAR_FACULTY / ADMIN CHECK remains. Authorization provenance is the
-- permission + assignment/delegation + scope actually used for the operation.

-- -----------------------------------------------------------------------------
-- 6. Student portal cache
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cached_student_attendance (
    student_user_id TEXT PRIMARY KEY,
    overall_attendance_percentage REAL NOT NULL
        CHECK (overall_attendance_percentage >= 0.0 AND overall_attendance_percentage <= 100.0),
    payload_json TEXT NOT NULL,
    cached_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cached_student_subject_history (
    student_user_id TEXT NOT NULL,
    teaching_assignment_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    cached_at TEXT NOT NULL,
    PRIMARY KEY (student_user_id, teaching_assignment_id)
);

CREATE TABLE IF NOT EXISTS cached_student_requests (
    id TEXT PRIMARY KEY,
    student_user_id TEXT NOT NULL,
    teaching_assignment_id TEXT NOT NULL,
    subject_name TEXT NOT NULL,
    session_date TEXT NOT NULL,
    student_note TEXT NOT NULL,
    status TEXT NOT NULL
        CHECK (status IN ('Sent', 'Being reviewed', 'Accepted', 'Not accepted')),
    resolution_note TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_cached_student_requests_owner_status
    ON cached_student_requests(student_user_id, status, created_at DESC);

-- -----------------------------------------------------------------------------
-- 7. Notification cache
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
    is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cached_notifications_recipient
    ON cached_notifications(recipient_user_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- 8. Operational notes for the mobile application
-- -----------------------------------------------------------------------------
-- 1. authorization_snapshot_json contains the current membership, ALL active
--    role assignments, effective permissions, scopes, approved delegations,
--    authorization version and expiry/validation metadata.
-- 2. Do not persist one selected/active role as the user's identity.
-- 3. UI can aggregate capabilities for a combined dashboard, but each resource
--    operation must still resolve the resource scope in the snapshot.
-- 4. Store embeddings only for the roster/teaching assignment authorised by the
--    backend. Do not turn this cache into a global institutional face gallery.
-- 5. Queue writes with idempotency IDs and authorization provenance. Server-side
--    sync must re-check current membership, role assignment, scope, session and
--    delegation validity; stale cached authority is never sufficient.
-- 6. Never store raw classroom frames or enrollment photographs as a side effect
--    of normal recognition/attendance processing.
