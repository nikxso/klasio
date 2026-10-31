import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read SCHEMA_SQL from database.ts
const dbTsContent = readFileSync(join(__dirname, '../database.ts'), 'utf-8');
const match = dbTsContent.match(/export const SCHEMA_SQL = `([\s\S]*?)`;/);
assert(match, 'SCHEMA_SQL should be defined in database.ts');
const schemaSql = match[1];

test('Student Attendance Local Caching and Offline Resilience', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);

  await t.test('1. Save and retrieve cached student personal attendance summary', () => {
    const studentId = 'stu-alice-01';
    const mockSummary = {
      student_id: studentId,
      overall_attendance_percentage: 75.0,
      subjects: [
        {
          subject_id: 'sub-01',
          teaching_assignment_id: 'ta-cs401',
          subject_code: 'CS401',
          subject_name: 'Distributed Systems',
          faculty_name: 'Prof Katherine Johnson',
          total_eligible_sessions: 4,
          attended_sessions: 3,
          attendance_percentage: 75.0,
          effective_start_date: '2026-09-01',
          classes_to_recover: 0,
          classes_can_miss: 0,
          is_shortage: false,
          is_recoverable: true,
          threshold: 75.0,
        },
      ],
    };

    const nowIso = new Date().toISOString();
    const payloadJson = JSON.stringify(mockSummary);

    // Insert
    db.prepare(`
      INSERT INTO cached_student_attendance (student_user_id, overall_attendance_percentage, payload_json, cached_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(student_user_id) DO UPDATE SET
        overall_attendance_percentage = excluded.overall_attendance_percentage,
        payload_json = excluded.payload_json,
        cached_at = excluded.cached_at;
    `).run(studentId, mockSummary.overall_attendance_percentage, payloadJson, nowIso);

    // Query back
    const row = db.prepare(
      'SELECT payload_json, cached_at FROM cached_student_attendance WHERE student_user_id = ?;'
    ).get(studentId);

    assert(row, 'Cached student attendance row must exist');
    const parsed = JSON.parse(row.payload_json);
    assert.equal(parsed.student_id, studentId);
    assert.equal(parsed.overall_attendance_percentage, 75.0);
    assert.equal(parsed.subjects.length, 1);
    assert.equal(parsed.subjects[0].subject_code, 'CS401');
    assert.equal(parsed.subjects[0].classes_to_recover, 0);
  });

  await t.test('2. Overwrite / upsert on conflict updates cached summary', () => {
    const studentId = 'stu-alice-01';
    const updatedSummary = {
      student_id: studentId,
      overall_attendance_percentage: 50.0,
      subjects: [
        {
          subject_id: 'sub-01',
          teaching_assignment_id: 'ta-cs401',
          subject_code: 'CS401',
          subject_name: 'Distributed Systems',
          faculty_name: 'Prof Katherine Johnson',
          total_eligible_sessions: 4,
          attended_sessions: 2,
          attendance_percentage: 50.0,
          effective_start_date: '2026-09-01',
          classes_to_recover: 4,
          classes_can_miss: 0,
          is_shortage: true,
          is_recoverable: true,
          threshold: 75.0,
        },
      ],
    };

    const updateIso = new Date().toISOString();
    const updateJson = JSON.stringify(updatedSummary);

    db.prepare(`
      INSERT INTO cached_student_attendance (student_user_id, overall_attendance_percentage, payload_json, cached_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(student_user_id) DO UPDATE SET
        overall_attendance_percentage = excluded.overall_attendance_percentage,
        payload_json = excluded.payload_json,
        cached_at = excluded.cached_at;
    `).run(studentId, updatedSummary.overall_attendance_percentage, updateJson, updateIso);

    const row = db.prepare(
      'SELECT payload_json, overall_attendance_percentage FROM cached_student_attendance WHERE student_user_id = ?;'
    ).get(studentId);

    assert(row);
    assert.equal(row.overall_attendance_percentage, 50.0);
    const parsed = JSON.parse(row.payload_json);
    assert.equal(parsed.subjects[0].is_shortage, true);
    assert.equal(parsed.subjects[0].classes_to_recover, 4);
  });

  await t.test('3. Save and retrieve subject-specific attendance history', () => {
    const taId = 'ta-cs401';
    const studentId = 'stu-alice-01';
    const mockHistory = {
      teaching_assignment_id: taId,
      subject_id: 'sub-01',
      subject_code: 'CS401',
      subject_name: 'Distributed Systems',
      faculty_name: 'Prof Katherine Johnson',
      total_eligible_sessions: 3,
      attended_sessions: 2,
      attendance_percentage: 66.7,
      classes_to_recover: 1,
      classes_can_miss: 0,
      is_shortage: true,
      is_recoverable: true,
      threshold: 75.0,
      records: [
        {
          session_id: 'sess-03',
          session_date: '2026-10-08',
          period_slot_or_sequence: 1,
          attendance_status: 'ABSENT',
          applicability_status: 'COUNTED',
          mark_source: 'MANUAL_MARK',
        },
        {
          session_id: 'sess-02',
          session_date: '2026-09-24',
          period_slot_or_sequence: 1,
          attendance_status: 'EXCUSED',
          applicability_status: 'CANCELLED',
          status_reason: 'Storm warning',
        },
        {
          session_id: 'sess-01',
          session_date: '2026-09-17',
          period_slot_or_sequence: 1,
          attendance_status: 'PRESENT',
          applicability_status: 'COUNTED',
          mark_source: 'AI_VERIFIED',
        },
      ],
    };

    const nowIso = new Date().toISOString();
    const payloadJson = JSON.stringify(mockHistory);

    db.prepare(`
      INSERT INTO cached_student_subject_history (teaching_assignment_id, student_user_id, payload_json, cached_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(teaching_assignment_id) DO UPDATE SET
        student_user_id = excluded.student_user_id,
        payload_json = excluded.payload_json,
        cached_at = excluded.cached_at;
    `).run(taId, studentId, payloadJson, nowIso);

    const row = db.prepare(
      'SELECT payload_json FROM cached_student_subject_history WHERE teaching_assignment_id = ? AND student_user_id = ?;'
    ).get(taId, studentId);

    assert(row, 'Cached subject history row must exist');
    const parsed = JSON.parse(row.payload_json);
    assert.equal(parsed.teaching_assignment_id, taId);
    assert.equal(parsed.records.length, 3);
    assert.equal(parsed.records[0].session_date, '2026-10-08');
    assert.equal(parsed.records[1].applicability_status, 'CANCELLED');
    assert.equal(parsed.records[1].status_reason, 'Storm warning');
    assert.equal(parsed.records[2].mark_source, 'AI_VERIFIED');
  });

  await t.test('4. Non-existent student returns undefined/null', () => {
    const row = db.prepare(
      'SELECT payload_json FROM cached_student_attendance WHERE student_user_id = ?;'
    ).get('non-existent-student');
    assert.equal(row, undefined);
  });
});
