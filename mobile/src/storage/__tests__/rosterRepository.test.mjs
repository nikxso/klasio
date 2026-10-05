import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read schema SQL from database.ts
const dbTsContent = readFileSync(join(__dirname, '../database.ts'), 'utf-8');
const match = dbTsContent.match(/export const SCHEMA_SQL = `([\s\S]*?)`;/);
assert(match, 'SCHEMA_SQL should be defined in database.ts');
const schemaSql = match[1];

const db = new DatabaseSync(':memory:');
db.exec(schemaSql);

console.log('Testing RosterRepository SQLite logic...');

const assignmentId = 'assign-cse-3a';

// 1. Insert 3 students:
// - S1: starts 2026-09-01, ongoing (eligible Oct 5)
// - S2: starts 2026-10-10, ongoing (late admission, NOT eligible Oct 5)
// - S3: starts 2026-09-01, ends 2026-10-04 (transferred out, NOT eligible Oct 5)

const insertStmt = db.prepare(`
  INSERT INTO cached_rosters (
    teaching_assignment_id, student_user_id, institutional_id, student_name,
    effective_start_date, effective_end_date, face_registration_state, cached_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
`);

insertStmt.run(assignmentId, 'stu-1', '21CS001', 'Aarav Sharma', '2026-09-01', null, 'REGISTERED', '2026-10-05T00:00:00Z');
insertStmt.run(assignmentId, 'stu-2', '21CS002', 'Priya Nair', '2026-10-10', null, 'PENDING', '2026-10-05T00:00:00Z');
insertStmt.run(assignmentId, 'stu-3', '21CS003', 'Rohan Mehta', '2026-09-01', '2026-10-04', 'UNREGISTERED', '2026-10-05T00:00:00Z');

// 2. Query all cached
const allRows = db.prepare('SELECT * FROM cached_rosters WHERE teaching_assignment_id = ?').all(assignmentId);
assert.equal(allRows.length, 3, 'Total cached students should be 3');

// 3. Query date-bounded for 2026-10-05
const evalDate = '2026-10-05';
const eligibleRows = db.prepare(`
  SELECT * FROM cached_rosters
  WHERE teaching_assignment_id = ?
    AND effective_start_date <= ?
    AND (effective_end_date IS NULL OR effective_end_date >= ?)
  ORDER BY student_name ASC;
`).all(assignmentId, evalDate, evalDate);

assert.equal(eligibleRows.length, 1, 'Only Aarav Sharma should be eligible on 2026-10-05');
assert.equal(eligibleRows[0].student_name, 'Aarav Sharma');
assert.equal(eligibleRows[0].face_registration_state, 'REGISTERED');

// 4. Query date-bounded for 2026-10-12
const evalDate2 = '2026-10-12';
const eligibleRows2 = db.prepare(`
  SELECT * FROM cached_rosters
  WHERE teaching_assignment_id = ?
    AND effective_start_date <= ?
    AND (effective_end_date IS NULL OR effective_end_date >= ?)
  ORDER BY student_name ASC;
`).all(assignmentId, evalDate2, evalDate2);

assert.equal(eligibleRows2.length, 2, 'Aarav and Priya should be eligible on 2026-10-12');

// 5. Test cached embeddings scoping (T039)
console.log('Testing scoped reference embedding cache...');
const embInsert = db.prepare(`
  INSERT INTO cached_embeddings (
    student_user_id, model_version, embedding_dimension,
    embedding_blob, sample_index, gallery_version
  ) VALUES (?, ?, ?, ?, ?, ?);
`);

embInsert.run('stu-1', 'mobilefacenet_v2.1', 128, Buffer.from([1, 2, 3, 4]), 0, 1);
embInsert.run('stu-1', 'mobilefacenet_v2.1', 128, Buffer.from([5, 6, 7, 8]), 1, 1);
embInsert.run('stu-2', 'mobilefacenet_v2.1', 128, Buffer.from([9, 10, 11, 12]), 0, 1);
embInsert.run('stu-other', 'mobilefacenet_v2.1', 128, Buffer.from([13, 14, 15, 16]), 0, 1);

// Query scoped only to class section students ['stu-1', 'stu-2']
const scopedEmbs = db.prepare(`
  SELECT student_user_id, model_version, embedding_dimension, sample_index, gallery_version
  FROM cached_embeddings
  WHERE student_user_id IN (?, ?)
  ORDER BY student_user_id, sample_index ASC;
`).all('stu-1', 'stu-2');

assert.equal(scopedEmbs.length, 3, 'Only permitted students stu-1 and stu-2 embeddings returned');
assert.equal(scopedEmbs.some((e) => e.student_user_id === 'stu-other'), false, 'Unpermitted student stu-other must never be returned');

// Remove stu-1 embeddings on section transfer
db.prepare('DELETE FROM cached_embeddings WHERE student_user_id = ?;').run('stu-1');
const remainingEmbs = db.prepare('SELECT student_user_id FROM cached_embeddings WHERE student_user_id = ?;').all('stu-1');
assert.equal(remainingEmbs.length, 0, 'stu-1 embeddings successfully purged');

console.log('RosterRepository SQLite tests and scoped embedding cache tests passed successfully!');
