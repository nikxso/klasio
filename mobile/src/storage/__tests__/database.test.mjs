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

console.log('All SQLite schema, PRAGMA, foreign key, and constraint assertions passed successfully!');
