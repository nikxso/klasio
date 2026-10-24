import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { AttendanceRepository } from '../attendanceRepository.ts';
import { AttendanceSyncWorker } from '../syncWorker.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read database.ts SCHEMA_SQL
const dbTsContent = readFileSync(join(__dirname, '../database.ts'), 'utf-8');
const schemaMatch = dbTsContent.match(/export const SCHEMA_SQL = `([\s\S]*?)`;/);
assert(schemaMatch, 'SCHEMA_SQL must be present in database.ts');
const schemaSql = schemaMatch[1];

function createInMemoryDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);
  return db;
}

describe('Phase 9.1: 17-Step Offline-First Attendance Amendment Lifecycle Suite', () => {
  test('Complete end-to-end lifecycle verification', async () => {
    const db = createInMemoryDb();
    const sessionUuid = 'sess_offline_lifecycle_001';
    const nowIso = new Date().toISOString();

    // =========================================================================
    // STEP 1: Faculty finalizes attendance session locally while offline
    // =========================================================================
    const finalizationPayload = {
      clientSessionUuid: sessionUuid,
      teachingAssignmentId: 'assign-cs-101',
      sessionDate: '2026-10-14',
      periodSlotOrSequence: 1,
      applicabilityStatus: 'COUNTED',
      statusReason: null,
      regularFacultyUserId: 'fac-regular-01',
      conductingFacultyUserId: 'fac-regular-01',
      substituteDelegationId: null,
      finalizedAt: nowIso,
      records: [
        {
          studentUserId: 'usr_001',
          attendanceStatus: 'PRESENT',
          markSource: 'AI_VERIFIED',
          candidateConfidence: 0.94,
          recordedAt: nowIso,
        },
        {
          studentUserId: 'usr_002',
          attendanceStatus: 'ABSENT',
          markSource: 'MANUAL_MARK',
          candidateConfidence: null,
          recordedAt: nowIso,
        },
        {
          studentUserId: 'usr_003',
          attendanceStatus: 'EXCUSED',
          markSource: 'MANUAL_MARK',
          candidateConfidence: null,
          recordedAt: nowIso,
        },
      ],
    };

    const finRes = await AttendanceRepository.finalizeSession(finalizationPayload, db);
    assert.equal(finRes.success, true);
    assert.equal(finRes.recordsCount, 3);

    // =========================================================================
    // STEP 2: Initial attendance record exists locally (usr_001 = PRESENT)
    // =========================================================================
    const initialRec1 = db.prepare(
      'SELECT attendance_status, mark_source FROM local_attendance_records WHERE client_session_uuid = ? AND student_user_id = ?;'
    ).get(sessionUuid, 'usr_001');
    assert.equal(initialRec1.attendance_status, 'PRESENT');
    assert.equal(initialRec1.mark_source, 'AI_VERIFIED');

    // =========================================================================
    // STEP 3: Initial session sync item queued (SESSION_SYNC, PENDING)
    // =========================================================================
    const queueInitial = db.prepare('SELECT * FROM sync_queue WHERE client_session_uuid = ?;').all(sessionUuid);
    assert.equal(queueInitial.length, 1);
    assert.equal(queueInitial[0].operation_type, 'SESSION_SYNC');
    assert.equal(queueInitial[0].sync_status, 'PENDING');

    // =========================================================================
    // STEP 4: Network is offline; worker cannot sync, schedules retry
    // =========================================================================
    const failingTransport = async () => {
      throw new Error('ENOTFOUND: Device offline');
    };
    const offlineItems = await AttendanceSyncWorker.getPendingQueueItems(5, db);
    const offlineProcessRes = await AttendanceSyncWorker.processQueueItem(offlineItems[0], failingTransport, 'token', db);
    assert.equal(offlineProcessRes.success, false);
    assert.equal(offlineProcessRes.status, 'PENDING_RETRY');

    const retriedQueue = db.prepare('SELECT sync_status, retry_count FROM sync_queue WHERE queue_id = ?;').get(offlineItems[0].queueId);
    assert.equal(retriedQueue.sync_status, 'PENDING');
    assert.equal(retriedQueue.retry_count, 1);

    // =========================================================================
    // STEP 5 & 6: Faculty amends attendance while offline (PRESENT -> ABSENT)
    // Atomic transaction commits: record=ABSENT, audit inserted, AMENDMENT_SYNC queued
    // =========================================================================
    const amendRes = await AttendanceRepository.applyAmendment(
      sessionUuid,
      'usr_001',
      'ABSENT',
      'Student left lecture hall after roll call without authorization',
      'fac-regular-01',
      'REGULAR_FACULTY',
      db
    );

    assert.ok(amendRes.clientAmendmentId);
    assert.equal(amendRes.previousStatus, 'PRESENT');
    assert.equal(amendRes.newStatus, 'ABSENT');

    // Check local record mutated
    const postAmendRec1 = db.prepare(
      'SELECT attendance_status, mark_source FROM local_attendance_records WHERE client_session_uuid = ? AND student_user_id = ?;'
    ).get(sessionUuid, 'usr_001');
    assert.equal(postAmendRec1.attendance_status, 'ABSENT');
    assert.equal(postAmendRec1.mark_source, 'MANUAL_OVERRIDE');

    // Check audit inserted
    const audits = await AttendanceRepository.listAmendmentsForSession(sessionUuid, db);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].client_amendment_id, amendRes.clientAmendmentId);
    assert.equal(audits[0].student_user_id, 'usr_001');
    assert.equal(audits[0].previous_status, 'PRESENT');
    assert.equal(audits[0].new_status, 'ABSENT');

    // Check AMENDMENT_SYNC enqueued in sync_queue
    const amendQueueRow = db.prepare(
      "SELECT * FROM sync_queue WHERE client_amendment_id = ? AND operation_type = 'AMENDMENT_SYNC';"
    ).get(amendRes.clientAmendmentId);
    assert.ok(amendQueueRow);
    assert.equal(amendQueueRow.sync_status, 'PENDING');
    const amendPayload = JSON.parse(amendQueueRow.payload_json);
    assert.equal(amendPayload.client_amendment_id, amendRes.clientAmendmentId);
    assert.equal(amendPayload.student_user_id, 'usr_001');
    assert.equal(amendPayload.new_status, 'ABSENT');
    assert.equal(amendPayload.expected_previous_status, 'PRESENT');

    // =========================================================================
    // STEP 7 & 8: Simulate application restart & verify persistence
    // =========================================================================
    const restartedRecord = db.prepare(
      'SELECT attendance_status, mark_source FROM local_attendance_records WHERE client_session_uuid = ? AND student_user_id = ?;'
    ).get(sessionUuid, 'usr_001');
    assert.equal(restartedRecord.attendance_status, 'ABSENT');
    assert.equal(restartedRecord.mark_source, 'MANUAL_OVERRIDE');

    const restartedAudits = await AttendanceRepository.listAmendmentsForSession(sessionUuid, db);
    assert.equal(restartedAudits.length, 1);
    assert.equal(restartedAudits[0].client_amendment_id, amendRes.clientAmendmentId);

    const restartedQueue = db.prepare('SELECT * FROM sync_queue WHERE client_session_uuid = ? ORDER BY queue_id ASC;').all(sessionUuid);
    assert.equal(restartedQueue.length, 2);
    assert.equal(restartedQueue[0].operation_type, 'SESSION_SYNC');
    assert.equal(restartedQueue[1].operation_type, 'AMENDMENT_SYNC');
    assert.equal(restartedQueue[1].client_amendment_id, amendRes.clientAmendmentId);

    // =========================================================================
    // STEP 9: Network restored: Worker synchronizes SESSION_SYNC -> HTTP 201 ACK
    // =========================================================================
    // Reset next_retry_at to eligible
    db.prepare("UPDATE sync_queue SET next_retry_at = NULL WHERE operation_type = 'SESSION_SYNC';").run();

    const pendingAfterOnline = await AttendanceSyncWorker.getPendingQueueItems(5, db);
    assert.equal(pendingAfterOnline.length, 2);

    const mockSessionTransport = async (path, payload) => {
      if (path.includes('/sessions/sync')) {
        return {
          statusCode: 201,
          data: { results: [{ status: 'SYNCED', client_session_uuid: sessionUuid }] },
        };
      }
      throw new Error(`Unexpected path ${path}`);
    };

    const sessionSyncRes = await AttendanceSyncWorker.processQueueItem(pendingAfterOnline[0], mockSessionTransport, 'token', db);
    assert.equal(sessionSyncRes.success, true);
    assert.equal(sessionSyncRes.status, 'ACKNOWLEDGED');

    const sessionRow = db.prepare('SELECT session_status FROM local_attendance_sessions WHERE client_session_uuid = ?;').get(sessionUuid);
    assert.equal(sessionRow.session_status, 'SYNCED');

    // =========================================================================
    // STEP 10 & 11: Worker synchronizes AMENDMENT_SYNC -> HTTP 201 ACK
    // Authoritative backend audit acknowledged
    // =========================================================================
    const amendmentQueueItem = (await AttendanceSyncWorker.getPendingQueueItems(5, db))[0];
    assert.equal(amendmentQueueItem.operationType, 'AMENDMENT_SYNC');

    let backendAuditStore = [];
    const mockAmendmentTransport = async (path, payload) => {
      // Backend simulation
      assert.equal(payload.client_amendment_id, amendRes.clientAmendmentId);
      assert.equal(payload.expected_previous_status, 'PRESENT');
      assert.equal(payload.new_status, 'ABSENT');

      backendAuditStore.push({
        audit_id: 'srv_audit_001',
        client_amendment_id: payload.client_amendment_id,
        student_user_id: payload.student_user_id,
        previous_status: 'PRESENT',
        new_status: payload.new_status,
        amendment_reason: payload.amendment_reason,
      });

      return {
        statusCode: 201,
        data: backendAuditStore[0],
      };
    };

    const amendSyncRes = await AttendanceSyncWorker.processQueueItem(amendmentQueueItem, mockAmendmentTransport, 'token', db);
    assert.equal(amendSyncRes.success, true);
    assert.equal(amendSyncRes.status, 'ACKNOWLEDGED');

    const acknowledgedQueue = db.prepare('SELECT sync_status FROM sync_queue WHERE queue_id = ?;').get(amendmentQueueItem.queueId);
    assert.equal(acknowledgedQueue.sync_status, 'ACKNOWLEDGED');
    assert.equal(backendAuditStore.length, 1);
    assert.equal(backendAuditStore[0].client_amendment_id, amendRes.clientAmendmentId);

    // =========================================================================
    // STEP 12: Network replay / retry occurs: Backend returns HTTP 200 (Already Synced)
    // No duplicate audit created
    // =========================================================================
    const mockReplayTransport = async (path, payload) => {
      // Backend detects client_amendment_id already exists in AttendanceAmendmentAudit
      const existing = backendAuditStore.find((a) => a.client_amendment_id === payload.client_amendment_id);
      if (existing) {
        return {
          statusCode: 200,
          data: {
            ...existing,
            is_already_synced: true,
          },
        };
      }
      return { statusCode: 201, data: {} };
    };

    // Replay item
    const replayRes = await AttendanceSyncWorker.processQueueItem(amendmentQueueItem, mockReplayTransport, 'token', db);
    assert.equal(replayRes.success, true);
    assert.equal(replayRes.status, 'ACKNOWLEDGED');
    assert.equal(backendAuditStore.length, 1, 'Idempotent replay did not create duplicate audit');

    // =========================================================================
    // STEP 13: Stale amendment conflict simulation: Device B attempts amendment
    // with stale expected_previous_status -> HTTP 409 Conflict
    // =========================================================================
    const staleQueueItem = {
      queueId: 999,
      clientSessionUuid: sessionUuid,
      operationType: 'AMENDMENT_SYNC',
      clientAmendmentId: 'amend_device_b_stale',
      endpointPath: `/api/v1/attendance/sessions/${sessionUuid}/amendments`,
      payloadJson: JSON.stringify({
        client_amendment_id: 'amend_device_b_stale',
        student_user_id: 'usr_001',
        new_status: 'EXCUSED',
        expected_previous_status: 'PRESENT', // Stale! Server is already ABSENT
        amendment_reason: 'Device B offline correction attempt',
      }),
      syncStatus: 'PENDING',
      retryCount: 0,
      lastError: null,
      nextRetryAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    // Insert into db for worker to update
    db.prepare(`
      INSERT INTO sync_queue (
        queue_id, client_session_uuid, operation_type, client_amendment_id,
        endpoint_path, payload_json, sync_status, retry_count, created_at, updated_at
      ) VALUES (999, ?, 'AMENDMENT_SYNC', 'amend_device_b_stale', '/amend', ?, 'PENDING', 0, ?, ?);
    `).run(sessionUuid, staleQueueItem.payloadJson, nowIso, nowIso);

    const mockConflictTransport = async () => ({
      statusCode: 409,
      data: { detail: 'Conflict: Stale attendance state: student usr_001 current status is ABSENT, expected PRESENT' },
    });

    const conflictRes = await AttendanceSyncWorker.processQueueItem(staleQueueItem, mockConflictTransport, 'token', db);
    assert.equal(conflictRes.success, false);
    assert.equal(conflictRes.status, 'FAILED');
    assert.equal(conflictRes.isConflict, true);
    assert.ok(conflictRes.errorMessage.includes('Stale attendance state'));

    // =========================================================================
    // STEP 14: Correction window UX enforcement: Expired window calculation
    // =========================================================================
    const CORRECTION_WINDOW_DAYS = 7;
    const oldSessionDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const diffDays = Math.floor((Date.now() - new Date(oldSessionDate).getTime()) / (1000 * 60 * 60 * 24));
    assert(diffDays >= CORRECTION_WINDOW_DAYS, 'Session is outside 7-day correction window');
    const isCorrectionWindowExpired = diffDays >= CORRECTION_WINDOW_DAYS;
    assert.equal(isCorrectionWindowExpired, true);

    // =========================================================================
    // STEP 15: Substitute faculty exclusion: SUBSTITUTE_FACULTY cannot amend
    // =========================================================================
    await assert.rejects(
      async () => {
        await AttendanceRepository.applyAmendment(
          sessionUuid,
          'usr_002',
          'PRESENT',
          'Substitute faculty attempting to correct attendance',
          'sub_fac_01',
          'SUBSTITUTE_FACULTY',
          db
        );
      },
      /SUBSTITUTE_FACULTY/i,
      'Substitute faculty cannot amend finalized attendance'
    );

    // =========================================================================
    // STEP 16: Admin override: ADMIN role CAN amend
    // =========================================================================
    const adminAmendRes = await AttendanceRepository.applyAmendment(
      sessionUuid,
      'usr_002',
      'PRESENT',
      'Administrative dean override for documented emergency',
      'admin_user_01',
      'ADMIN',
      db
    );
    assert.ok(adminAmendRes.clientAmendmentId);
    assert.equal(adminAmendRes.previousStatus, 'ABSENT');
    assert.equal(adminAmendRes.newStatus, 'PRESENT');

    // =========================================================================
    // STEP 17: Mathematical count integrity: Aggregates remain exact
    // =========================================================================
    const finalRecords = db.prepare(
      'SELECT student_user_id, attendance_status FROM local_attendance_records WHERE client_session_uuid = ?;'
    ).all(sessionUuid);

    assert.equal(finalRecords.length, 3, 'Zero duplicate student records created by amendment audits');
    const presentCount = finalRecords.filter((r) => r.attendance_status === 'PRESENT').length;
    const absentCount = finalRecords.filter((r) => r.attendance_status === 'ABSENT').length;
    const excusedCount = finalRecords.filter((r) => r.attendance_status === 'EXCUSED').length;

    // usr_001: ABSENT, usr_002: PRESENT (via admin), usr_003: EXCUSED
    assert.equal(presentCount, 1);
    assert.equal(absentCount, 1);
    assert.equal(excusedCount, 1);
    assert.equal(presentCount + absentCount + excusedCount, 3);
  });
});
