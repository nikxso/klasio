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

test('Student Attendance Grievance Requests Local Persistence', async (t) => {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);

  const studentId = 'stu-aarav-21cs037';

  await t.test('1. Create and retrieve attendance correction request', () => {
    const req = {
      id: 'req-001',
      student_user_id: studentId,
      teaching_assignment_id: 'ta-cs303',
      subject_name: 'Operating Systems',
      session_date: '2026-10-02',
      student_note: 'I was present in the back row during the lecture.',
      status: 'Sent',
      resolution_note: null,
      created_at: new Date().toISOString(),
    };

    db.prepare(`
      INSERT INTO cached_student_requests (
        id, student_user_id, teaching_assignment_id, subject_name,
        session_date, student_note, status, resolution_note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
    `).run(
      req.id,
      req.student_user_id,
      req.teaching_assignment_id,
      req.subject_name,
      req.session_date,
      req.student_note,
      req.status,
      req.resolution_note,
      req.created_at
    );

    const rows = db.prepare(`SELECT * FROM cached_student_requests WHERE student_user_id = ?;`).all(studentId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, 'req-001');
    assert.equal(rows[0].subject_name, 'Operating Systems');
    assert.equal(rows[0].status, 'Sent');
  });

  await t.test('2. Status updates survive (e.g. Being reviewed -> Accepted)', () => {
    db.prepare(`
      UPDATE cached_student_requests
      SET status = ?, resolution_note = ?
      WHERE id = ?;
    `).run('Accepted', 'Faculty verified back row video', 'req-001');

    const updated = db.prepare(`SELECT * FROM cached_student_requests WHERE id = ?;`).get('req-001');
    assert.equal(updated.status, 'Accepted');
    assert.equal(updated.resolution_note, 'Faculty verified back row video');
  });

  await t.test('3. Enforces valid status check constraint', () => {
    assert.throws(() => {
      db.prepare(`
        INSERT INTO cached_student_requests (
          id, student_user_id, teaching_assignment_id, subject_name,
          session_date, student_note, status, resolution_note, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);
      `).run('req-bad', studentId, 'ta-1', 'Sub', '2026-10-01', 'Note', 'INVALID_STATUS', null, new Date().toISOString());
    }, /CHECK constraint failed/);
  });
});
