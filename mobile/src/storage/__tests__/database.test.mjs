import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read database.ts and extract SCHEMA_SQL
const dbTsContent = readFileSync(join(__dirname, '../database.ts'), 'utf-8');
const match = dbTsContent.match(/export const SCHEMA_SQL = `([\s\S]*?)`;/);
assert(match, 'SCHEMA_SQL should be defined in database.ts');
const schemaSql = match[1];

// Initialize temporary SQLite database
const db = new DatabaseSync(':memory:');

console.log('Testing PRAGMA execution and table creation...');
db.exec(schemaSql);

// 1. Verify PRAGMAs
const fkStatus = db.prepare('PRAGMA foreign_keys;').get();
assert.equal(fkStatus.foreign_keys, 1, 'foreign_keys should be enabled');

// 2. Verify all 5 required tables exist
const tables = db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"
).all().map(row => row.name);

const expectedTables = [
  'cached_embeddings',
  'cached_rosters',
  'local_attendance_records',
  'local_attendance_sessions',
  'sync_queue',
  'local_amendment_audits',
  'cached_student_attendance',
  'cached_student_subject_history',
];

for (const expected of expectedTables) {
  assert(tables.includes(expected), `Table ${expected} must exist`);
}

// 3. Test foreign key constraint on local_attendance_records
assert.throws(() => {
  db.prepare(`
    INSERT INTO local_attendance_records (
      client_session_uuid, student_user_id, attendance_status, mark_source, candidate_confidence, recorded_at
    ) VALUES (
      'non-existent-session-uuid', 'student-123', 'PRESENT', 'AI_VERIFIED', 0.95, '2026-10-05T10:00:00Z'
    );
  `).run();
}, /foreign key/i, 'Inserting record with non-existent session UUID should fail foreign key check');

// 4. Test unique constraint on session (assignment, date, period)
db.prepare(`
  INSERT INTO local_attendance_sessions (
    client_session_uuid, teaching_assignment_id, session_date, period_slot_or_sequence,
    applicability_status, regular_faculty_user_id, conducting_faculty_user_id,
    session_status, created_at, updated_at
  ) VALUES (
    'session-uuid-1', 'assign-1', '2026-10-05', 1, 'COUNTED', 'fac-1', 'fac-1', 'FINALIZED', '2026-10-05T10:00:00Z', '2026-10-05T10:00:00Z'
  );
`).run();

assert.throws(() => {
  db.prepare(`
    INSERT INTO local_attendance_sessions (
      client_session_uuid, teaching_assignment_id, session_date, period_slot_or_sequence,
      applicability_status, regular_faculty_user_id, conducting_faculty_user_id,
      session_status, created_at, updated_at
    ) VALUES (
      'session-uuid-2', 'assign-1', '2026-10-05', 1, 'COUNTED', 'fac-1', 'fac-1', 'FINALIZED', '2026-10-05T10:00:00Z', '2026-10-05T10:00:00Z'
    );
  `).run();
}, /unique/i, 'Inserting duplicate session for same assignment, date, and period slot must fail unique constraint');

// 5. Test Phase 9.1 operation-aware sync_queue
// A. Can insert SESSION_SYNC
db.prepare(`
  INSERT INTO sync_queue (
    client_session_uuid, operation_type, endpoint_path, payload_json, sync_status, created_at, updated_at
  ) VALUES ('session-uuid-1', 'SESSION_SYNC', '/api/v1/attendance/sessions/sync', '{}', 'PENDING', '2026-10-05T10:00:00Z', '2026-10-05T10:00:00Z');
`).run();

// B. Duplicate SESSION_SYNC fails uniqueness
assert.throws(() => {
  db.prepare(`
    INSERT INTO sync_queue (
      client_session_uuid, operation_type, endpoint_path, payload_json, sync_status, created_at, updated_at
    ) VALUES ('session-uuid-1', 'SESSION_SYNC', '/api/v1/attendance/sessions/sync', '{}', 'PENDING', '2026-10-05T10:00:00Z', '2026-10-05T10:00:00Z');
  `).run();
}, /unique/i, 'Inserting duplicate SESSION_SYNC for same session should fail unique constraint');

// C. Multiple AMENDMENT_SYNC for the SAME session can coexist
db.prepare(`
  INSERT INTO sync_queue (
    client_session_uuid, operation_type, client_amendment_id, endpoint_path, payload_json, sync_status, created_at, updated_at
  ) VALUES ('session-uuid-1', 'AMENDMENT_SYNC', 'amd-uuid-001', '/api/v1/attendance/sessions/session-uuid-1/amendments', '{"amd":1}', 'PENDING', '2026-10-05T10:00:00Z', '2026-10-05T10:00:00Z');
`).run();

db.prepare(`
  INSERT INTO sync_queue (
    client_session_uuid, operation_type, client_amendment_id, endpoint_path, payload_json, sync_status, created_at, updated_at
  ) VALUES ('session-uuid-1', 'AMENDMENT_SYNC', 'amd-uuid-002', '/api/v1/attendance/sessions/session-uuid-1/amendments', '{"amd":2}', 'PENDING', '2026-10-05T10:00:00Z', '2026-10-05T10:00:00Z');
`).run();

const queueRows = db.prepare('SELECT * FROM sync_queue WHERE client_session_uuid = ?;').all('session-uuid-1');
assert.equal(queueRows.length, 3, 'Must have 1 SESSION_SYNC and 2 AMENDMENT_SYNC rows for session-uuid-1');

// D. Duplicate client_amendment_id fails uniqueness
assert.throws(() => {
  db.prepare(`
    INSERT INTO sync_queue (
      client_session_uuid, operation_type, client_amendment_id, endpoint_path, payload_json, sync_status, created_at, updated_at
    ) VALUES ('session-uuid-1', 'AMENDMENT_SYNC', 'amd-uuid-001', '/api/v1/attendance/sessions/session-uuid-1/amendments', '{"amd":1}', 'PENDING', '2026-10-05T10:00:00Z', '2026-10-05T10:00:00Z');
  `).run();
}, /unique/i, 'Inserting duplicate client_amendment_id must fail unique constraint');

console.log('All SQLite schema, PRAGMA, foreign key, and constraint assertions passed successfully!');

