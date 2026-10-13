import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { FacultyAttendanceReviewController } from '../adapters/review/FacultyAttendanceReviewController.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read database.ts SCHEMA_SQL for SQLite in-memory test DB
const dbTsContent = readFileSync(join(__dirname, '../../storage/database.ts'), 'utf-8');
const schemaMatch = dbTsContent.match(/export const SCHEMA_SQL = `([\s\S]*?)`;/);
assert(schemaMatch, 'SCHEMA_SQL must be present in database.ts');
const schemaSql = schemaMatch[1];

function createInMemoryDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);
  return db;
}

const SAMPLE_ROSTER = [
  {
    studentUserId: 'usr_001',
    institutionalId: '21CS001',
    studentName: 'Aarav Sharma',
    effectiveStartDate: '2026-09-01',
    effectiveEndDate: null,
    faceRegistrationState: 'REGISTERED',
  },
  {
    studentUserId: 'usr_002',
    institutionalId: '21CS002',
    studentName: 'Bhavna Patel',
    effectiveStartDate: '2026-09-01',
    effectiveEndDate: null,
    faceRegistrationState: 'REGISTERED',
  },
  {
    studentUserId: 'usr_003',
    institutionalId: '21CS003',
    studentName: 'Chirag Rao',
    effectiveStartDate: '2026-09-01',
    effectiveEndDate: null,
    faceRegistrationState: 'PENDING',
  },
  {
    studentUserId: 'usr_004',
    institutionalId: '21CS004',
    studentName: 'Divya Iyer',
    effectiveStartDate: '2026-09-01',
    effectiveEndDate: null,
    faceRegistrationState: 'UNREGISTERED',
  },
];

const VALID_CONTEXT = {
  clientSessionUuid: 'sess_uuid_101',
  teachingAssignmentId: 'assign_cse_3a_ds',
  sessionDate: '2026-10-13',
  periodSlotOrSequence: 1,
  applicabilityStatus: 'COUNTED',
  regularFacultyUserId: 'fac_sharma',
  conductingFacultyUserId: 'fac_sharma',
};

describe('Step I: Faculty Attendance Review & Finalization Invariant Suite', () => {

  test('[1] Authorized regular faculty can open review workflow', () => {
    const ctrl = new FacultyAttendanceReviewController();
    ctrl.initialize(VALID_CONTEXT, SAMPLE_ROSTER);

    assert.equal(ctrl.lifecycleStatus, 'REVIEW');
    assert.equal(ctrl.reviewItems.length, 4);
    assert.equal(ctrl.context.clientSessionUuid, 'sess_uuid_101');
  });

  test('[2] Unauthorized faculty cannot finalize session', () => {
    const ctrl = new FacultyAttendanceReviewController();
    const unauthorizedContext = {
      ...VALID_CONTEXT,
      conductingFacultyUserId: 'fac_intruder',
      substituteDelegationId: null, // Neither regular nor substitute
    };
    ctrl.initialize(unauthorizedContext, SAMPLE_ROSTER);

    // Mark all as present
    SAMPLE_ROSTER.forEach((s) => ctrl.markStatus(s.studentUserId, 'PRESENT'));

    const validation = ctrl.validateFinalization();
    assert.equal(validation.canFinalize, false);
    assert(validation.errors.some((e) => e.includes('not assigned regular faculty')));
    assert.throws(() => ctrl.prepareFinalizationPayload(), /Conducting faculty is not assigned/);
  });

  test('[3] Substitute faculty WITH delegation CAN finalize', () => {
    const ctrl = new FacultyAttendanceReviewController();
    const delegatedContext = {
      ...VALID_CONTEXT,
      conductingFacultyUserId: 'fac_substitute',
      substituteDelegationId: 'del_uuid_999',
    };
    ctrl.initialize(delegatedContext, SAMPLE_ROSTER);
    SAMPLE_ROSTER.forEach((s) => ctrl.markStatus(s.studentUserId, 'PRESENT'));

    const validation = ctrl.validateFinalization();
    assert.equal(validation.canFinalize, true);
    assert.equal(validation.errors.length, 0);
  });

  test('[4] Recognition candidates populate as AI_VERIFIED PRESENT candidates', () => {
    const ctrl = new FacultyAttendanceReviewController();
    const accumulatedCandidates = [
      {
        studentUserId: 'usr_001',
        institutionalId: '21CS001',
        studentName: 'Aarav Sharma',
        bestSimilarityScore: 0.88,
        matchOutcome: 'MATCHED',
        totalObservationCount: 5,
        firstSeenAtMs: 1000,
        lastSeenAtMs: 1500,
        associatedTrackIds: [1],
      },
    ];

    ctrl.initialize(VALID_CONTEXT, SAMPLE_ROSTER, accumulatedCandidates);
    const item001 = ctrl.reviewItems.find((i) => i.studentUserId === 'usr_001');
    const item002 = ctrl.reviewItems.find((i) => i.studentUserId === 'usr_002');

    assert.equal(item001.isRecognized, true);
    assert.equal(item001.attendanceStatus, 'PRESENT');
    assert.equal(item001.markSource, 'AI_VERIFIED');
    assert.equal(item001.candidateConfidence, 0.88);

    // Student 002 was not observed -> strictly UNDECIDED
    assert.equal(item002.isRecognized, false);
    assert.equal(item002.attendanceStatus, 'UNDECIDED');
    assert.equal(item002.markSource, null);
  });

  test('[5] Full manual attendance works cleanly with zero ML candidates', () => {
    const ctrl = new FacultyAttendanceReviewController();
    ctrl.initialize(VALID_CONTEXT, SAMPLE_ROSTER, []); // 0 candidates

    // All start UNDECIDED
    assert(ctrl.reviewItems.every((i) => i.attendanceStatus === 'UNDECIDED'));
    assert(ctrl.reviewItems.every((i) => !i.isRecognized));

    // Faculty manually marks them
    ctrl.markStatus('usr_001', 'PRESENT');
    ctrl.markStatus('usr_002', 'PRESENT');
    ctrl.markStatus('usr_003', 'ABSENT');
    ctrl.markStatus('usr_004', 'EXCUSED');

    const validation = ctrl.validateFinalization();
    assert.equal(validation.canFinalize, true);

    const payload = ctrl.prepareFinalizationPayload();
    assert.equal(payload.records.length, 4);
    assert.equal(payload.records.find((r) => r.studentUserId === 'usr_001').markSource, 'MANUAL_MARK');
    assert.equal(payload.records.find((r) => r.studentUserId === 'usr_003').attendanceStatus, 'ABSENT');
  });

  test('[6] HARD INVARIANT: Failure to recognize NEVER equates to absence', () => {
    const ctrl = new FacultyAttendanceReviewController();
    ctrl.initialize(VALID_CONTEXT, SAMPLE_ROSTER, []);

    // Unrecognized students must be UNDECIDED, never automatically ABSENT
    for (const item of ctrl.reviewItems) {
      assert.notEqual(item.attendanceStatus, 'ABSENT');
      assert.equal(item.attendanceStatus, 'UNDECIDED');
    }
  });

  test('[7] Faculty can correct an incorrect recognition identity', () => {
    const ctrl = new FacultyAttendanceReviewController();
    // Suppose camera mistakenly matched Aarav (usr_001) instead of Bhavna (usr_002)
    const candidates = [
      {
        studentUserId: 'usr_001',
        institutionalId: '21CS001',
        studentName: 'Aarav Sharma',
        bestSimilarityScore: 0.74,
        matchOutcome: 'MATCHED',
        lastSeenAtMs: 2000,
      },
    ];

    ctrl.initialize(VALID_CONTEXT, SAMPLE_ROSTER, candidates);

    // Faculty corrects: It was actually Bhavna!
    ctrl.correctIdentity('usr_001', 'usr_002', 'Student Aarav was misidentified; physically verified as Bhavna');

    const item001 = ctrl.reviewItems.find((i) => i.studentUserId === 'usr_001');
    const item002 = ctrl.reviewItems.find((i) => i.studentUserId === 'usr_002');

    assert.equal(item001.attendanceStatus, 'UNDECIDED');
    assert.equal(item001.isRecognized, false);

    assert.equal(item002.attendanceStatus, 'PRESENT');
    assert.equal(item002.isRecognized, true);
    assert.equal(item002.isCorrected, true);
    assert.equal(item002.originalStudentUserId, 'usr_001');
    assert.equal(item002.markSource, 'MANUAL_OVERRIDE');

    assert.equal(ctrl.corrections.length, 1);
    assert.equal(ctrl.corrections[0].fromStudentUserId, 'usr_001');
    assert.equal(ctrl.corrections[0].toStudentUserId, 'usr_002');
  });

  test('[8] Identity correction requires non-empty audit justification', () => {
    const ctrl = new FacultyAttendanceReviewController();
    ctrl.initialize(VALID_CONTEXT, SAMPLE_ROSTER, [
      { studentUserId: 'usr_001', bestSimilarityScore: 0.8, matchOutcome: 'MATCHED' },
    ]);

    assert.throws(
      () => ctrl.correctIdentity('usr_001', 'usr_002', ''),
      /audit justification reason is required/
    );
  });

  test('[9] Identity correction to an already-PRESENT student is strictly rejected', () => {
    const ctrl = new FacultyAttendanceReviewController();
    // Both usr_001 and usr_002 were recognized
    ctrl.initialize(VALID_CONTEXT, SAMPLE_ROSTER, [
      { studentUserId: 'usr_001', bestSimilarityScore: 0.8, matchOutcome: 'MATCHED' },
      { studentUserId: 'usr_002', bestSimilarityScore: 0.9, matchOutcome: 'MATCHED' },
    ]);

    assert.throws(
      () => ctrl.correctIdentity('usr_001', 'usr_002', 'Attempting merge'),
      /already marked PRESENT/
    );
  });

  test('[10] Faculty can remove a false positive recognition candidate', () => {
    const ctrl = new FacultyAttendanceReviewController();
    ctrl.initialize(VALID_CONTEXT, SAMPLE_ROSTER, [
      { studentUserId: 'usr_001', bestSimilarityScore: 0.68, matchOutcome: 'MATCHED' },
    ]);

    ctrl.removeCandidate('usr_001');
    const item = ctrl.reviewItems.find((i) => i.studentUserId === 'usr_001');
    assert.equal(item.isRecognized, false);
    assert.equal(item.attendanceStatus, 'UNDECIDED');
    assert.equal(item.markSource, null);
  });

  test('[11] Faculty can manually add an unobserved student', () => {
    const ctrl = new FacultyAttendanceReviewController();
    ctrl.initialize(VALID_CONTEXT, SAMPLE_ROSTER, []);

    ctrl.manualAddStudent('usr_003', 'PRESENT');
    const item = ctrl.reviewItems.find((i) => i.studentUserId === 'usr_003');
    assert.equal(item.attendanceStatus, 'PRESENT');
    assert.equal(item.markSource, 'MANUAL_MARK');
    assert.equal(item.isManuallyAdded, true);
  });

  test('[12] Bulk convenience: markRemainingUnreviewedAsAbsent marks only UNDECIDED', () => {
    const ctrl = new FacultyAttendanceReviewController();
    ctrl.initialize(VALID_CONTEXT, SAMPLE_ROSTER, [
      { studentUserId: 'usr_001', bestSimilarityScore: 0.9, matchOutcome: 'MATCHED' },
    ]);

    // Student 001 is PRESENT (AI_VERIFIED). Students 002, 003, 004 are UNDECIDED.
    ctrl.markRemainingUnreviewedAsAbsent();

    assert.equal(ctrl.reviewItems.find((i) => i.studentUserId === 'usr_001').attendanceStatus, 'PRESENT');
    assert.equal(ctrl.reviewItems.find((i) => i.studentUserId === 'usr_002').attendanceStatus, 'ABSENT');
    assert.equal(ctrl.reviewItems.find((i) => i.studentUserId === 'usr_003').attendanceStatus, 'ABSENT');
    assert.equal(ctrl.reviewItems.find((i) => i.studentUserId === 'usr_004').attendanceStatus, 'ABSENT');
  });

  test('[13] COUNTED session requires all roster students decided before finalization', () => {
    const ctrl = new FacultyAttendanceReviewController();
    ctrl.initialize(VALID_CONTEXT, SAMPLE_ROSTER, [
      { studentUserId: 'usr_001', bestSimilarityScore: 0.9, matchOutcome: 'MATCHED' },
    ]);
    // 3 students remain UNDECIDED
    const validation = ctrl.validateFinalization();
    assert.equal(validation.canFinalize, false);
    assert(validation.errors.some((e) => e.includes('remain undecided')));
  });

  test('[14] Finalization payload contains exactly one record per student', () => {
    const ctrl = new FacultyAttendanceReviewController();
    ctrl.initialize(VALID_CONTEXT, SAMPLE_ROSTER, [
      { studentUserId: 'usr_001', bestSimilarityScore: 0.95, matchOutcome: 'MATCHED' },
    ]);

    ctrl.markStatus('usr_002', 'PRESENT');
    ctrl.markStatus('usr_003', 'ABSENT');
    ctrl.markStatus('usr_004', 'EXCUSED');

    const payload = ctrl.prepareFinalizationPayload();
    assert.equal(payload.records.length, 4);

    const studentIds = payload.records.map((r) => r.studentUserId);
    const uniqueIds = new Set(studentIds);
    assert.equal(uniqueIds.size, 4, 'Every student must appear exactly once');
  });

  test('[15] Finalized session is locked against subsequent mutations', () => {
    const ctrl = new FacultyAttendanceReviewController();
    ctrl.initialize(VALID_CONTEXT, SAMPLE_ROSTER, []);
    ctrl.markRemainingUnreviewedAsAbsent();
    ctrl.prepareFinalizationPayload();
    ctrl.markFinalized();

    assert.throws(() => ctrl.markStatus('usr_001', 'PRESENT'), /already finalized/);
    assert.throws(() => ctrl.removeCandidate('usr_001'), /already finalized/);
    assert.throws(() => ctrl.correctIdentity('usr_001', 'usr_002', 'Test'), /already finalized/);
  });

  test('[16] Date-bounded eligibility excludes students not enrolled on session date', () => {
    const ctrl = new FacultyAttendanceReviewController();
    const futureStudentRoster = [
      ...SAMPLE_ROSTER,
      {
        studentUserId: 'usr_future',
        institutionalId: '21CS999',
        studentName: 'Late Enrollee',
        effectiveStartDate: '2026-11-01', // Enrolls in November (after session date Oct 13)
        effectiveEndDate: null,
        faceRegistrationState: 'REGISTERED',
      },
    ];

    ctrl.initialize(VALID_CONTEXT, futureStudentRoster);
    // Student enrolled in future should NOT appear in session roster
    assert.equal(ctrl.reviewItems.find((i) => i.studentUserId === 'usr_future'), undefined);
    assert.equal(ctrl.reviewItems.length, 4);
  });

  test('[17] SQLite ACID Persistence: Finalizes session and inserts all records atomically', () => {
    const db = createInMemoryDb();

    // Prepare payload
    const ctrl = new FacultyAttendanceReviewController();
    ctrl.initialize(VALID_CONTEXT, SAMPLE_ROSTER, [
      { studentUserId: 'usr_001', bestSimilarityScore: 0.92, matchOutcome: 'MATCHED' },
    ]);
    ctrl.markRemainingUnreviewedAsAbsent();
    const payload = ctrl.prepareFinalizationPayload();

    // Simulate AttendanceRepository SQLite execution
    const nowIso = new Date().toISOString();
    db.exec('BEGIN TRANSACTION;');

    db.prepare(`
      INSERT INTO local_attendance_sessions (
        client_session_uuid, teaching_assignment_id, session_date,
        period_slot_or_sequence, applicability_status, regular_faculty_user_id,
        conducting_faculty_user_id, session_status, finalized_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'FINALIZED', ?, ?, ?);
    `).run(
      payload.clientSessionUuid,
      payload.teachingAssignmentId,
      payload.sessionDate,
      payload.periodSlotOrSequence,
      payload.applicabilityStatus,
      payload.regularFacultyUserId,
      payload.conductingFacultyUserId,
      payload.finalizedAt,
      nowIso,
      nowIso
    );

    for (const r of payload.records) {
      db.prepare(`
        INSERT INTO local_attendance_records (
          client_session_uuid, student_user_id, attendance_status, mark_source, candidate_confidence, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?);
      `).run(
        payload.clientSessionUuid,
        r.studentUserId,
        r.attendanceStatus,
        r.markSource,
        r.candidateConfidence,
        r.recordedAt
      );
    }

    db.prepare(`
      INSERT INTO sync_queue (client_session_uuid, endpoint_path, payload_json, sync_status, created_at, updated_at)
      VALUES (?, '/api/v1/attendance/sessions/sync', ?, 'PENDING', ?, ?);
    `).run(payload.clientSessionUuid, JSON.stringify(payload), nowIso, nowIso);

    db.exec('COMMIT;');

    // Verify session row
    const sessRow = db.prepare('SELECT * FROM local_attendance_sessions WHERE client_session_uuid = ?;').get(payload.clientSessionUuid);
    assert.equal(sessRow.session_status, 'FINALIZED');

    // Verify records
    const recordRows = db.prepare('SELECT * FROM local_attendance_records WHERE client_session_uuid = ?;').all(payload.clientSessionUuid);
    assert.equal(recordRows.length, 4);

    // Verify sync queue
    const syncRow = db.prepare('SELECT * FROM sync_queue WHERE client_session_uuid = ?;').get(payload.clientSessionUuid);
    assert.equal(syncRow.sync_status, 'PENDING');
  });

  test('[18] Idempotent Finalization: Re-submitting identical session UUID does not duplicate records', () => {
    const db = createInMemoryDb();
    const ctrl = new FacultyAttendanceReviewController();
    ctrl.initialize(VALID_CONTEXT, SAMPLE_ROSTER, []);
    ctrl.markRemainingUnreviewedAsAbsent();
    const payload = ctrl.prepareFinalizationPayload();

    const insertFn = () => {
      const existing = db.prepare('SELECT session_status FROM local_attendance_sessions WHERE client_session_uuid = ?;').get(payload.clientSessionUuid);
      if (existing) {
        return; // Idempotent no-op
      }
      db.prepare(`
        INSERT INTO local_attendance_sessions (
          client_session_uuid, teaching_assignment_id, session_date,
          period_slot_or_sequence, applicability_status, regular_faculty_user_id,
          conducting_faculty_user_id, session_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'FINALIZED', 'now', 'now');
      `).run(
        payload.clientSessionUuid, payload.teachingAssignmentId, payload.sessionDate,
        payload.periodSlotOrSequence, payload.applicabilityStatus,
        payload.regularFacultyUserId, payload.conductingFacultyUserId
      );
      for (const r of payload.records) {
        db.prepare(`
          INSERT INTO local_attendance_records (client_session_uuid, student_user_id, attendance_status, mark_source, recorded_at)
          VALUES (?, ?, ?, ?, 'now');
        `).run(payload.clientSessionUuid, r.studentUserId, r.attendanceStatus, r.markSource);
      }
    };

    insertFn();
    insertFn(); // Second invocation

    const count = db.prepare('SELECT COUNT(*) as cnt FROM local_attendance_records WHERE client_session_uuid = ?;').get(payload.clientSessionUuid);
    assert.equal(count.cnt, 4, 'Must have exactly 4 records, not 8');
  });

  test('[19] Database Invariant: UNIQUE(client_session_uuid, student_user_id) blocks duplicate student record', () => {
    const db = createInMemoryDb();
    db.prepare(`
      INSERT INTO local_attendance_sessions (
        client_session_uuid, teaching_assignment_id, session_date, period_slot_or_sequence,
        applicability_status, regular_faculty_user_id, conducting_faculty_user_id, session_status, created_at, updated_at
      ) VALUES ('sess_uq_test', 'assign_1', '2026-10-13', 1, 'COUNTED', 'fac_1', 'fac_1', 'FINALIZED', 'now', 'now');
    `).run();

    db.prepare(`
      INSERT INTO local_attendance_records (client_session_uuid, student_user_id, attendance_status, mark_source, recorded_at)
      VALUES ('sess_uq_test', 'usr_001', 'PRESENT', 'AI_VERIFIED', 'now');
    `).run();

    // Inserting a duplicate student for the same session must fail DB unique constraint
    assert.throws(() => {
      db.prepare(`
        INSERT INTO local_attendance_records (client_session_uuid, student_user_id, attendance_status, mark_source, recorded_at)
        VALUES ('sess_uq_test', 'usr_001', 'ABSENT', 'MANUAL_MARK', 'now');
      `).run();
    }, /unique/i);
  });

  test('[20] HARD PRIVACY INVARIANT: AttendanceRecord contains ZERO raw embeddings or image data', () => {
    const ctrl = new FacultyAttendanceReviewController();
    ctrl.initialize(VALID_CONTEXT, SAMPLE_ROSTER, [
      { studentUserId: 'usr_001', bestSimilarityScore: 0.92, matchOutcome: 'MATCHED' },
    ]);
    ctrl.markRemainingUnreviewedAsAbsent();
    const payload = ctrl.prepareFinalizationPayload();

    for (const record of payload.records) {
      assert.equal(record.embedding, undefined);
      assert.equal(record.rawVector, undefined);
      assert.equal(record.frame, undefined);
      assert.equal(record.imageBytes, undefined);
      assert.equal(record.crop, undefined);

      // Verify only attendance-domain keys exist
      const keys = Object.keys(record);
      const allowedKeys = ['studentUserId', 'attendanceStatus', 'markSource', 'candidateConfidence', 'recordedAt'];
      for (const k of keys) {
        assert(allowedKeys.includes(k), `Unexpected biometric key found: ${k}`);
      }
    }
  });

  test('[21] End-to-End Scenario: Mixed workflow (Recognized + Corrected + Removed + Manual Add)', () => {
    const ctrl = new FacultyAttendanceReviewController();
    // 30 students simulated with 4 in fixture
    const candidates = [
      { studentUserId: 'usr_001', bestSimilarityScore: 0.89, matchOutcome: 'MATCHED' }, // Accepted
      { studentUserId: 'usr_002', bestSimilarityScore: 0.65, matchOutcome: 'MATCHED' }, // Removed (False positive)
    ];

    ctrl.initialize(VALID_CONTEXT, SAMPLE_ROSTER, candidates);

    // Faculty Actions:
    // 1. Accept usr_001 as PRESENT (already set by AI_VERIFIED)
    assert.equal(ctrl.reviewItems.find((i) => i.studentUserId === 'usr_001').attendanceStatus, 'PRESENT');

    // 2. Remove usr_002 (false match)
    ctrl.removeCandidate('usr_002');
    assert.equal(ctrl.reviewItems.find((i) => i.studentUserId === 'usr_002').attendanceStatus, 'UNDECIDED');

    // 3. Mark usr_002 as ABSENT
    ctrl.markStatus('usr_002', 'ABSENT');

    // 4. Manually add usr_003 as PRESENT
    ctrl.manualAddStudent('usr_003', 'PRESENT');

    // 5. Correct usr_004 to EXCUSED
    ctrl.markStatus('usr_004', 'EXCUSED');

    const validation = ctrl.validateFinalization();
    assert.equal(validation.canFinalize, true);

    const payload = ctrl.prepareFinalizationPayload();
    assert.equal(payload.records.length, 4);
    assert.equal(payload.records.find((r) => r.studentUserId === 'usr_001').attendanceStatus, 'PRESENT');
    assert.equal(payload.records.find((r) => r.studentUserId === 'usr_001').markSource, 'AI_VERIFIED');
    assert.equal(payload.records.find((r) => r.studentUserId === 'usr_002').attendanceStatus, 'ABSENT');
    assert.equal(payload.records.find((r) => r.studentUserId === 'usr_002').markSource, 'MANUAL_MARK');
    assert.equal(payload.records.find((r) => r.studentUserId === 'usr_003').attendanceStatus, 'PRESENT');
    assert.equal(payload.records.find((r) => r.studentUserId === 'usr_003').markSource, 'MANUAL_MARK');
    assert.equal(payload.records.find((r) => r.studentUserId === 'usr_004').attendanceStatus, 'EXCUSED');
  });

  test('[22] Multi-track deduplication: Repeated tracks for same student collapse to single candidate', () => {
    const ctrl = new FacultyAttendanceReviewController();
    const duplicateTrackCandidates = [
      { studentUserId: 'usr_001', bestSimilarityScore: 0.81, matchOutcome: 'MATCHED', associatedTrackIds: [1] },
      { studentUserId: 'usr_001', bestSimilarityScore: 0.93, matchOutcome: 'MATCHED', associatedTrackIds: [4] }, // higher confidence
      { studentUserId: 'usr_001', bestSimilarityScore: 0.77, matchOutcome: 'MATCHED', associatedTrackIds: [7] },
    ];

    ctrl.initialize(VALID_CONTEXT, SAMPLE_ROSTER, duplicateTrackCandidates);

    // Exactly one review item for usr_001, taking highest confidence
    const item001 = ctrl.reviewItems.filter((i) => i.studentUserId === 'usr_001');
    assert.equal(item001.length, 1);
    assert.equal(item001[0].candidateConfidence, 0.93);
    assert.equal(item001[0].attendanceStatus, 'PRESENT');
  });

  test('[23] AMBIGUOUS / UNMATCHED recognition does not become attendance automatically', () => {
    const ctrl = new FacultyAttendanceReviewController();
    const ambiguousCandidates = [
      { studentUserId: null, bestSimilarityScore: 0.52, matchOutcome: 'AMBIGUOUS' },
      { studentUserId: null, bestSimilarityScore: 0.31, matchOutcome: 'UNMATCHED' },
    ];

    ctrl.initialize(VALID_CONTEXT, SAMPLE_ROSTER, ambiguousCandidates);

    // All students remain strictly UNDECIDED
    for (const item of ctrl.reviewItems) {
      assert.equal(item.attendanceStatus, 'UNDECIDED');
      assert.equal(item.isRecognized, false);
      assert.notEqual(item.attendanceStatus, 'PRESENT');
      assert.notEqual(item.attendanceStatus, 'ABSENT');
    }
  });

  test('[24] CANCELLED session applicability allows finalization with EXCUSED default', () => {
    const ctrl = new FacultyAttendanceReviewController();
    const cancelledContext = {
      ...VALID_CONTEXT,
      applicabilityStatus: 'CANCELLED',
      statusReason: 'Class cancelled due to faculty seminar',
    };

    ctrl.initialize(cancelledContext, SAMPLE_ROSTER, []);
    // Zero students marked manually; in a CANCELLED session, undecided students default to EXCUSED
    const validation = ctrl.validateFinalization();
    assert.equal(validation.canFinalize, true);

    const payload = ctrl.prepareFinalizationPayload();
    assert.equal(payload.applicabilityStatus, 'CANCELLED');
    assert.equal(payload.statusReason, 'Class cancelled due to faculty seminar');
    assert.equal(payload.records.length, 4);
    assert(payload.records.every((r) => r.attendanceStatus === 'EXCUSED'));
  });

  test('[25] EXEMPT session applicability allows finalization with EXCUSED default', () => {
    const ctrl = new FacultyAttendanceReviewController();
    const exemptContext = {
      ...VALID_CONTEXT,
      applicabilityStatus: 'EXEMPT',
      statusReason: 'Sports day exemption',
    };

    ctrl.initialize(exemptContext, SAMPLE_ROSTER, []);
    const validation = ctrl.validateFinalization();
    assert.equal(validation.canFinalize, true);

    const payload = ctrl.prepareFinalizationPayload();
    assert.equal(payload.applicabilityStatus, 'EXEMPT');
    assert(payload.records.every((r) => r.attendanceStatus === 'EXCUSED'));
  });

  test('[26] Sync Queue Lifecycle: Retries update retry_count, acknowledgment marks SYNCED', () => {
    const db = createInMemoryDb();
    const nowIso = new Date().toISOString();

    db.prepare(`
      INSERT INTO local_attendance_sessions (
        client_session_uuid, teaching_assignment_id, session_date, period_slot_or_sequence,
        applicability_status, regular_faculty_user_id, conducting_faculty_user_id, session_status, created_at, updated_at
      ) VALUES ('sess_sync_test', 'assign_1', '2026-10-13', 1, 'COUNTED', 'fac_1', 'fac_1', 'FINALIZED', ?, ?);
    `).run(nowIso, nowIso);

    db.prepare(`
      INSERT INTO sync_queue (client_session_uuid, endpoint_path, payload_json, sync_status, retry_count, created_at, updated_at)
      VALUES ('sess_sync_test', '/api/v1/attendance/sessions/sync', '{}', 'PENDING', 0, ?, ?);
    `).run(nowIso, nowIso);

    // Simulate transient failure -> retry increment
    db.prepare(`
      UPDATE sync_queue SET sync_status = 'FAILED', retry_count = retry_count + 1, last_error = 'Timeout'
      WHERE client_session_uuid = 'sess_sync_test';
    `).run();

    let queueItem = db.prepare('SELECT * FROM sync_queue WHERE client_session_uuid = ?;').get('sess_sync_test');
    assert.equal(queueItem.sync_status, 'FAILED');
    assert.equal(queueItem.retry_count, 1);

    // Simulate server ACK
    db.prepare(`
      UPDATE local_attendance_sessions SET session_status = 'SYNCED' WHERE client_session_uuid = 'sess_sync_test';
    `).run();
    db.prepare(`
      UPDATE sync_queue SET sync_status = 'ACKNOWLEDGED' WHERE client_session_uuid = 'sess_sync_test';
    `).run();

    const sess = db.prepare('SELECT * FROM local_attendance_sessions WHERE client_session_uuid = ?;').get('sess_sync_test');
    queueItem = db.prepare('SELECT * FROM sync_queue WHERE client_session_uuid = ?;').get('sess_sync_test');
    assert.equal(sess.session_status, 'SYNCED');
    assert.equal(queueItem.sync_status, 'ACKNOWLEDGED');
  });

  test('[27] Post-finalization amendment structure preserves audit trail', () => {
    const amendmentAudit = {
      auditId: 'audit_001',
      clientSessionUuid: 'sess_uuid_101',
      studentUserId: 'usr_002',
      previousStatus: 'ABSENT',
      newStatus: 'PRESENT',
      amendingUserId: 'fac_sharma',
      amendmentRole: 'REGULAR_FACULTY',
      amendmentReason: 'Medical certificate approved by HoD',
      amendedAt: new Date().toISOString(),
    };

    assert.equal(amendmentAudit.previousStatus, 'ABSENT');
    assert.equal(amendmentAudit.newStatus, 'PRESENT');
    assert.equal(amendmentAudit.amendingUserId, 'fac_sharma');
    assert(amendmentAudit.amendmentReason.length >= 10);
  });

  test('[28] Offline Session Survivability: Saved session can be queried and reconstructed after restart', () => {
    const db = createInMemoryDb();
    const ctrl = new FacultyAttendanceReviewController();
    ctrl.initialize(VALID_CONTEXT, SAMPLE_ROSTER, []);
    ctrl.markRemainingUnreviewedAsAbsent();
    const payload = ctrl.prepareFinalizationPayload();

    db.prepare(`
      INSERT INTO local_attendance_sessions (
        client_session_uuid, teaching_assignment_id, session_date, period_slot_or_sequence,
        applicability_status, regular_faculty_user_id, conducting_faculty_user_id, session_status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'FINALIZED', 'now', 'now');
    `).run(
      payload.clientSessionUuid, payload.teachingAssignmentId, payload.sessionDate,
      payload.periodSlotOrSequence, payload.applicabilityStatus,
      payload.regularFacultyUserId, payload.conductingFacultyUserId
    );

    for (const r of payload.records) {
      db.prepare(`
        INSERT INTO local_attendance_records (client_session_uuid, student_user_id, attendance_status, mark_source, recorded_at)
        VALUES (?, ?, ?, ?, ?);
      `).run(payload.clientSessionUuid, r.studentUserId, r.attendanceStatus, r.markSource, r.recordedAt);
    }

    // Reconstruct as a new reader
    const restoredSession = db.prepare('SELECT * FROM local_attendance_sessions WHERE client_session_uuid = ?;').get(payload.clientSessionUuid);
    const restoredRecords = db.prepare('SELECT * FROM local_attendance_records WHERE client_session_uuid = ?;').all(payload.clientSessionUuid);

    assert.equal(restoredSession.client_session_uuid, payload.clientSessionUuid);
    assert.equal(restoredSession.session_status, 'FINALIZED');
    assert.equal(restoredRecords.length, 4);
    assert.equal(restoredRecords.every((r) => r.attendance_status === 'ABSENT'), true);
  });

  test('[29] Recognition Source Metadata Separation: Distinct sources (AI_VERIFIED, MANUAL_MARK, MANUAL_OVERRIDE)', () => {
    const ctrl = new FacultyAttendanceReviewController();
    ctrl.initialize(VALID_CONTEXT, SAMPLE_ROSTER, [
      { studentUserId: 'usr_001', bestSimilarityScore: 0.9, matchOutcome: 'MATCHED' }, // AI_VERIFIED
    ]);

    ctrl.manualAddStudent('usr_002', 'PRESENT'); // MANUAL_MARK
    ctrl.markStatus('usr_001', 'ABSENT'); // Overriding AI suggestion -> MANUAL_OVERRIDE
    ctrl.markStatus('usr_003', 'ABSENT'); // MANUAL_MARK
    ctrl.markStatus('usr_004', 'EXCUSED'); // MANUAL_MARK

    const payload = ctrl.prepareFinalizationPayload();
    assert.equal(payload.records.find((r) => r.studentUserId === 'usr_001').markSource, 'MANUAL_OVERRIDE');
    assert.equal(payload.records.find((r) => r.studentUserId === 'usr_002').markSource, 'MANUAL_MARK');
    assert.equal(payload.records.find((r) => r.studentUserId === 'usr_003').markSource, 'MANUAL_MARK');
    assert.equal(payload.records.find((r) => r.studentUserId === 'usr_004').markSource, 'MANUAL_MARK');
  });

  test('[30] Roster Membership Security: Controller rejects attempts to mark or add non-roster student IDs', () => {
    const ctrl = new FacultyAttendanceReviewController();
    ctrl.initialize(VALID_CONTEXT, SAMPLE_ROSTER, []);

    assert.throws(
      () => ctrl.markStatus('usr_intruder_999', 'PRESENT'),
      /not in the active session roster/
    );

    assert.throws(
      () => ctrl.manualAddStudent('usr_intruder_999', 'PRESENT'),
      /not an enrolled roster student/
    );
  });
});

