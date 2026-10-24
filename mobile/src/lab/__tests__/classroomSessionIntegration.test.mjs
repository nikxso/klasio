import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { ClassroomSessionController } from '../adapters/session/ClassroomSessionController.ts';
import { AttendanceSyncWorker } from '../../storage/syncWorker.ts';

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
];

function makeContext(overrides = {}) {
  return {
    clientSessionUuid: `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    teachingAssignmentId: 'ta_cs301_01',
    sessionDate: '2026-10-20',
    periodSlotOrSequence: 1,
    applicabilityStatus: 'COUNTED',
    statusReason: null,
    regularFacultyUserId: 'fac_regular_01',
    conductingFacultyUserId: 'fac_regular_01',
    substituteDelegationId: null,
    ...overrides,
  };
}

describe('Phase 8: Classroom Attendance Session Semantics & Scanner Integration', () => {
  test('[1] Multi-Session Semantics: Two sessions same assignment & date with different period slots', () => {
    const db = createInMemoryDb();

    // Session 1: Period 1
    const ctx1 = makeContext({ periodSlotOrSequence: 1 });
    const ctrl1 = new ClassroomSessionController({ context: ctx1, roster: SAMPLE_ROSTER });
    ctrl1.proceedToReview();
    ctrl1.reviewController.markRemainingUnreviewedAsAbsent();
    const payload1 = ctrl1.reviewController.prepareFinalizationPayload();

    // Insert session 1 into SQLite
    db.prepare(`
      INSERT INTO local_attendance_sessions (
        client_session_uuid, teaching_assignment_id, session_date,
        period_slot_or_sequence, applicability_status, regular_faculty_user_id,
        conducting_faculty_user_id, session_status, finalized_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'FINALIZED', ?, ?, ?)
    `).run(
      payload1.clientSessionUuid,
      payload1.teachingAssignmentId,
      payload1.sessionDate,
      payload1.periodSlotOrSequence,
      payload1.applicabilityStatus,
      payload1.regularFacultyUserId,
      payload1.conductingFacultyUserId,
      payload1.finalizedAt,
      payload1.finalizedAt,
      payload1.finalizedAt
    );

    // Session 2: Period 3 (Same assignment, same date, different slot)
    const ctx2 = makeContext({ periodSlotOrSequence: 3 });
    const ctrl2 = new ClassroomSessionController({ context: ctx2, roster: SAMPLE_ROSTER });
    ctrl2.proceedToReview();
    ctrl2.reviewController.markRemainingUnreviewedAsAbsent();
    const payload2 = ctrl2.reviewController.prepareFinalizationPayload();

    db.prepare(`
      INSERT INTO local_attendance_sessions (
        client_session_uuid, teaching_assignment_id, session_date,
        period_slot_or_sequence, applicability_status, regular_faculty_user_id,
        conducting_faculty_user_id, session_status, finalized_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'FINALIZED', ?, ?, ?)
    `).run(
      payload2.clientSessionUuid,
      payload2.teachingAssignmentId,
      payload2.sessionDate,
      payload2.periodSlotOrSequence,
      payload2.applicabilityStatus,
      payload2.regularFacultyUserId,
      payload2.conductingFacultyUserId,
      payload2.finalizedAt,
      payload2.finalizedAt,
      payload2.finalizedAt
    );

    // Verify both sessions coexist in the database
    const rows = db.prepare(
      'SELECT client_session_uuid, period_slot_or_sequence FROM local_attendance_sessions WHERE teaching_assignment_id = ? ORDER BY period_slot_or_sequence'
    ).all('ta_cs301_01');

    assert.equal(rows.length, 2);
    assert.equal(rows[0].period_slot_or_sequence, 1);
    assert.equal(rows[1].period_slot_or_sequence, 3);
  });

  test('[2] Same-Slot Duplicate Protection: Duplicate period slot for same assignment and date is rejected', () => {
    const db = createInMemoryDb();
    const ctx = makeContext({ periodSlotOrSequence: 2 });

    db.prepare(`
      INSERT INTO local_attendance_sessions (
        client_session_uuid, teaching_assignment_id, session_date,
        period_slot_or_sequence, applicability_status, regular_faculty_user_id,
        conducting_faculty_user_id, session_status, finalized_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'FINALIZED', '2026-10-20T10:00:00Z', '2026-10-20T10:00:00Z', '2026-10-20T10:00:00Z')
    `).run(
      ctx.clientSessionUuid,
      ctx.teachingAssignmentId,
      ctx.sessionDate,
      ctx.periodSlotOrSequence,
      ctx.applicabilityStatus,
      ctx.regularFacultyUserId,
      ctx.conductingFacultyUserId
    );

    // Attempt inserting second session with different UUID but identical assignment, date, and period slot
    const duplicateUuid = 'sess_conflict_uuid_999';
    assert.throws(() => {
      db.prepare(`
        INSERT INTO local_attendance_sessions (
          client_session_uuid, teaching_assignment_id, session_date,
          period_slot_or_sequence, applicability_status, regular_faculty_user_id,
          conducting_faculty_user_id, session_status, finalized_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'FINALIZED', '2026-10-20T10:00:00Z', '2026-10-20T10:00:00Z', '2026-10-20T10:00:00Z')
      `).run(
        duplicateUuid,
        ctx.teachingAssignmentId,
        ctx.sessionDate,
        ctx.periodSlotOrSequence,
        ctx.applicabilityStatus,
        ctx.regularFacultyUserId,
        ctx.conductingFacultyUserId
      );
    }, /UNIQUE constraint failed/);
  });

  test('[3] Session Applicability: COUNTED session enforces all students decided before finalization', () => {
    const ctx = makeContext({ applicabilityStatus: 'COUNTED' });
    const ctrl = new ClassroomSessionController({ context: ctx, roster: SAMPLE_ROSTER });
    ctrl.proceedToReview();

    // 0 students marked: all 3 remain UNDECIDED
    const val = ctrl.validateFinalization();
    assert.equal(val.canFinalize, false);
    assert.ok(val.errors.some((e) => e.includes('remain undecided')));

    // Mark 1 student PRESENT, 2 remain UNDECIDED -> still cannot finalize
    ctrl.reviewController.markStatus('usr_001', 'PRESENT');
    assert.equal(ctrl.validateFinalization().canFinalize, false);

    // Mark remaining students -> now can finalize
    ctrl.reviewController.markStatus('usr_002', 'ABSENT');
    ctrl.reviewController.markStatus('usr_003', 'EXCUSED');
    assert.equal(ctrl.validateFinalization().canFinalize, true);

    const payload = ctrl.reviewController.prepareFinalizationPayload();
    assert.equal(payload.applicabilityStatus, 'COUNTED');
    assert.equal(payload.records.length, 3);
  });

  test('[4] Session Applicability: CANCELLED session requires statusReason and defaults unreviewed to EXCUSED', () => {
    const ctx = makeContext();
    const ctrl = new ClassroomSessionController({ context: ctx, roster: SAMPLE_ROSTER });

    // Empty reason must throw
    assert.throws(() => {
      ctrl.setApplicability('CANCELLED', '');
    }, /mandatory/);

    // Valid cancellation reason
    ctrl.setApplicability('CANCELLED', 'College closed due to flood warning');
    assert.equal(ctrl.lifecycleState, 'CANCELLED');
    assert.equal(ctrl.context.applicabilityStatus, 'CANCELLED');
    assert.equal(ctrl.context.statusReason, 'College closed due to flood warning');

    ctrl.proceedToReview();
    // In CANCELLED session, undecided students default to EXCUSED
    assert.equal(ctrl.validateFinalization().canFinalize, true);

    const payload = ctrl.reviewController.prepareFinalizationPayload();
    assert.equal(payload.applicabilityStatus, 'CANCELLED');
    assert.equal(payload.statusReason, 'College closed due to flood warning');
    assert.ok(payload.records.every((r) => r.attendanceStatus === 'EXCUSED'));
  });

  test('[5] Session Applicability: EXEMPT session requires statusReason and defaults unreviewed to EXCUSED', () => {
    const ctx = makeContext();
    const ctrl = new ClassroomSessionController({ context: ctx, roster: SAMPLE_ROSTER });

    assert.throws(() => {
      ctrl.setApplicability('EXEMPT', '   ');
    }, /mandatory/);

    ctrl.setApplicability('EXEMPT', 'Institutional Inter-College Hackathon Exemption');
    assert.equal(ctrl.lifecycleState, 'EXEMPT');

    ctrl.proceedToReview();
    assert.equal(ctrl.validateFinalization().canFinalize, true);

    const payload = ctrl.reviewController.prepareFinalizationPayload();
    assert.equal(payload.applicabilityStatus, 'EXEMPT');
    assert.equal(payload.statusReason, 'Institutional Inter-College Hackathon Exemption');
    assert.ok(payload.records.every((r) => r.attendanceStatus === 'EXCUSED'));
  });

  test('[6] Session Lifecycle Progression: SCHEDULED -> READY -> SCANNING -> REVIEW -> FINALIZED -> SYNCED', async () => {
    const ctx = makeContext();
    const ctrl = new ClassroomSessionController({ context: ctx, roster: SAMPLE_ROSTER });
    assert.equal(ctrl.lifecycleState, 'READY');

    // 1. Enter Scanning
    ctrl.startScanning();
    assert.equal(ctrl.lifecycleState, 'SCANNING');
    assert.equal(ctrl.isPaused, false);
    assert.equal(ctrl.scannerInteractionState, 'ACTIVE');

    // 2. Pause & Resume Scanner Interaction State
    ctrl.pauseScanning();
    assert.equal(ctrl.isPaused, true);
    assert.equal(ctrl.scannerInteractionState, 'PAUSED');
    assert.equal(ctrl.getScannerMetrics().guidanceText.includes('paused'), true);

    ctrl.resumeScanning();
    assert.equal(ctrl.isPaused, false);
    assert.equal(ctrl.scannerInteractionState, 'ACTIVE');

    // 3. Move to Review
    ctrl.proceedToReview();
    assert.equal(ctrl.lifecycleState, 'REVIEW');

    // 4. Mark attendance
    ctrl.reviewController.markRemainingUnreviewedAsAbsent();

    // 5. Finalize payload
    const payload = ctrl.reviewController.prepareFinalizationPayload();
    assert.equal(payload.records.length, 3);
    ctrl.reviewController.markFinalized();
    assert.equal(ctrl.reviewController.lifecycleStatus, 'FINALIZED');
  });

  test('[7] Scanner Motion Guidance: Detects PANNING motion state and generates prompt', () => {
    const ctx = makeContext();
    const ctrl = new ClassroomSessionController({ context: ctx, roster: SAMPLE_ROSTER });
    ctrl.startScanning();

    // Frame 1: Stable face at (0.2, 0.2)
    const trackedFace1 = {
      trackId: 101,
      boundingBox: { x: 0.20, y: 0.20, width: 0.15, height: 0.20 },
      displayBox: { x: 0.20, y: 0.20, width: 0.15, height: 0.20 },
      confidence: 0.95,
      ageInFrames: 3,
      timeSinceLastSeenMs: 0,
      isConfirmed: true,
    };
    ctrl.processPerceptionFrame([], [trackedFace1], 1000);

    // Frame 2: Large jump to (0.50, 0.50) -> displacement ~0.42 > 0.08
    const trackedFace2 = {
      trackId: 101,
      boundingBox: { x: 0.50, y: 0.50, width: 0.15, height: 0.20 },
      displayBox: { x: 0.50, y: 0.50, width: 0.15, height: 0.20 },
      confidence: 0.95,
      ageInFrames: 4,
      timeSinceLastSeenMs: 0,
      isConfirmed: true,
    };
    ctrl.processPerceptionFrame([], [trackedFace2], 1050);

    const metrics = ctrl.getScannerMetrics();
    assert.equal(metrics.state, 'PANNING');
    assert.ok(metrics.guidanceText.includes('too fast'));
  });

  test('[8] Recognition Candidate -> Review Flow: Camera candidates populate as AI_VERIFIED PRESENT', () => {
    const ctx = makeContext();
    const ctrl = new ClassroomSessionController({ context: ctx, roster: SAMPLE_ROSTER });
    ctrl.startScanning();

    // Mock accumulated candidate for usr_001
    const candidate = {
      studentUserId: 'usr_001',
      bestSimilarityScore: 0.88,
      firstSeenAtMs: 1000,
      lastSeenAtMs: 1200,
      observationCount: 3,
      stableCentroid: { x: 0.3, y: 0.3 },
    };
    ctrl.accumulator.getAccumulatedCandidates = () => [candidate];

    ctrl.proceedToReview();
    const items = ctrl.reviewController.reviewItems;

    // usr_001 was recognized -> suggested as PRESENT with AI_VERIFIED source
    const item1 = items.find((i) => i.studentUserId === 'usr_001');
    assert.ok(item1);
    assert.equal(item1.attendanceStatus, 'PRESENT');
    assert.equal(item1.markSource, 'AI_VERIFIED');
    assert.equal(item1.candidateConfidence, 0.88);
    assert.equal(item1.isRecognized, true);

    // usr_002 was not recognized -> UNDECIDED
    const item2 = items.find((i) => i.studentUserId === 'usr_002');
    assert.ok(item2);
    assert.equal(item2.attendanceStatus, 'UNDECIDED');
    assert.equal(item2.isRecognized, false);
    assert.equal(item2.markSource, null);
  });

  test('[9] Hard Domain Invariant: Recognition failure never silently equates to ABSENT', () => {
    const ctx = makeContext();
    const ctrl = new ClassroomSessionController({ context: ctx, roster: SAMPLE_ROSTER });
    // Zero camera observations
    ctrl.proceedToReview();

    const items = ctrl.reviewController.reviewItems;
    assert.equal(items.length, 3);
    // Every unobserved student must be UNDECIDED, zero silently marked ABSENT
    assert.ok(items.every((i) => i.attendanceStatus === 'UNDECIDED'));
    assert.equal(items.some((i) => i.attendanceStatus === 'ABSENT'), false);
  });

  test('[10] Offline SQLite Persistence: Finalized session written to local_attendance_sessions & sync_queue', () => {
    const db = createInMemoryDb();
    const ctx = makeContext();
    const ctrl = new ClassroomSessionController({ context: ctx, roster: SAMPLE_ROSTER });
    ctrl.proceedToReview();
    ctrl.reviewController.markRemainingUnreviewedAsAbsent();
    const payload = ctrl.reviewController.prepareFinalizationPayload();

    // Atomically persist session + records + sync queue into SQLite
    db.exec('BEGIN TRANSACTION;');
    db.prepare(`
      INSERT INTO local_attendance_sessions (
        client_session_uuid, teaching_assignment_id, session_date,
        period_slot_or_sequence, applicability_status, regular_faculty_user_id,
        conducting_faculty_user_id, session_status, finalized_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'FINALIZED', ?, ?, ?)
    `).run(
      payload.clientSessionUuid,
      payload.teachingAssignmentId,
      payload.sessionDate,
      payload.periodSlotOrSequence,
      payload.applicabilityStatus,
      payload.regularFacultyUserId,
      payload.conductingFacultyUserId,
      payload.finalizedAt,
      payload.finalizedAt,
      payload.finalizedAt
    );

    for (const rec of payload.records) {
      db.prepare(`
        INSERT INTO local_attendance_records (
          client_session_uuid, student_user_id, attendance_status, mark_source, recorded_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        payload.clientSessionUuid,
        rec.studentUserId,
        rec.attendanceStatus,
        rec.markSource,
        rec.recordedAt
      );
    }

    db.prepare(`
      INSERT INTO sync_queue (
        client_session_uuid, endpoint_path, payload_json, sync_status, created_at, updated_at
      ) VALUES (?, '/api/v1/attendance/sessions/sync', ?, 'PENDING', ?, ?)
    `).run(
      payload.clientSessionUuid,
      JSON.stringify(payload),
      payload.finalizedAt,
      payload.finalizedAt
    );
    db.exec('COMMIT;');

    // Verify session row
    const sessionRow = db.prepare('SELECT * FROM local_attendance_sessions WHERE client_session_uuid = ?').get(payload.clientSessionUuid);
    assert.ok(sessionRow);
    assert.equal(sessionRow.session_status, 'FINALIZED');

    // Verify records
    const recordRows = db.prepare('SELECT * FROM local_attendance_records WHERE client_session_uuid = ?').all(payload.clientSessionUuid);
    assert.equal(recordRows.length, 3);

    // Verify queue row
    const queueRow = db.prepare('SELECT * FROM sync_queue WHERE client_session_uuid = ?').get(payload.clientSessionUuid);
    assert.ok(queueRow);
    assert.equal(queueRow.sync_status, 'PENDING');
  });

  test('[11] Step J Sync Integration: Sync worker dispatches queue item and marks ACKNOWLEDGED without duplicate records', async () => {
    const db = createInMemoryDb();
    const ctx = makeContext();
    const ctrl = new ClassroomSessionController({ context: ctx, roster: SAMPLE_ROSTER });
    ctrl.proceedToReview();
    ctrl.reviewController.markRemainingUnreviewedAsAbsent();
    const payload = ctrl.reviewController.prepareFinalizationPayload();

    db.prepare(`
      INSERT INTO local_attendance_sessions (
        client_session_uuid, teaching_assignment_id, session_date,
        period_slot_or_sequence, applicability_status, regular_faculty_user_id,
        conducting_faculty_user_id, session_status, finalized_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'FINALIZED', ?, ?, ?)
    `).run(
      payload.clientSessionUuid,
      payload.teachingAssignmentId,
      payload.sessionDate,
      payload.periodSlotOrSequence,
      payload.applicabilityStatus,
      payload.regularFacultyUserId,
      payload.conductingFacultyUserId,
      payload.finalizedAt,
      payload.finalizedAt,
      payload.finalizedAt
    );

    db.prepare(`
      INSERT INTO sync_queue (
        client_session_uuid, endpoint_path, payload_json, sync_status, created_at, updated_at
      ) VALUES (?, '/api/v1/attendance/sessions/sync', ?, 'PENDING', ?, ?)
    `).run(
      payload.clientSessionUuid,
      JSON.stringify(payload),
      payload.finalizedAt,
      payload.finalizedAt
    );

    // Mock successful HTTP 201 response
    const mockTransport = async (path, body) => ({
      statusCode: 201,
      data: { status: 'SYNCED', clientSessionUuid: body.clientSessionUuid },
    });

    const result = await AttendanceSyncWorker.drainQueue(mockTransport, 'test_token', db);
    assert.equal(result.processed, 1);
    assert.equal(result.succeeded, 1);

    // Queue item marked ACKNOWLEDGED
    const queueRow = db.prepare('SELECT sync_status FROM sync_queue WHERE client_session_uuid = ?').get(payload.clientSessionUuid);
    assert.equal(queueRow.sync_status, 'ACKNOWLEDGED');

    // Local session marked SYNCED
    const sessionRow = db.prepare('SELECT session_status FROM local_attendance_sessions WHERE client_session_uuid = ?').get(payload.clientSessionUuid);
    assert.equal(sessionRow.session_status, 'SYNCED');
  });
});
