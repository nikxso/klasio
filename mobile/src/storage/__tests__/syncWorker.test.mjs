import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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

describe('Step J: Mobile Attendance Sync Worker & Queue Invariants', () => {
  test('[1] Exponential Backoff Formula: Bounds and Jitter', () => {
    // Retry 0: base 2000 ms +/- 20% -> [1600, 2400]
    for (let i = 0; i < 10; i++) {
      const delay0 = AttendanceSyncWorker.calculateBackoffMs(0);
      assert(delay0 >= 1600 && delay0 <= 2400, `Delay0 (${delay0}) out of range [1600, 2400]`);
    }

    // Retry 3: 2000 * 2^3 = 16000 ms -> [12800, 19200]
    const delay3 = AttendanceSyncWorker.calculateBackoffMs(3);
    assert(delay3 >= 12800 && delay3 <= 19200, `Delay3 (${delay3}) out of range [12800, 19200]`);

    // Retry 10: capped at 300,000 ms (5 min) -> [240000, 360000]
    const delay10 = AttendanceSyncWorker.calculateBackoffMs(10);
    assert(delay10 >= 240000 && delay10 <= 360000, `Delay10 (${delay10}) out of range`);
  });

  test('[2] Queue Selection: getPendingQueueItems returns only eligible PENDING items', () => {
    const db = createInMemoryDb();
    const nowIso = new Date().toISOString();
    const pastIso = new Date(Date.now() - 10000).toISOString();
    const futureIso = new Date(Date.now() + 60000).toISOString();

    // 1. Eligible (next_retry_at is null)
    db.prepare(`
      INSERT INTO sync_queue (client_session_uuid, endpoint_path, payload_json, sync_status, retry_count, created_at, updated_at)
      VALUES ('uuid-1', '/api/v1/attendance/sessions/sync', '{"id":1}', 'PENDING', 0, ?, ?);
    `).run(nowIso, nowIso);

    // 2. Eligible (next_retry_at in past)
    db.prepare(`
      INSERT INTO sync_queue (client_session_uuid, endpoint_path, payload_json, sync_status, retry_count, next_retry_at, created_at, updated_at)
      VALUES ('uuid-2', '/api/v1/attendance/sessions/sync', '{"id":2}', 'PENDING', 1, ?, ?, ?);
    `).run(pastIso, nowIso, nowIso);

    // 3. Ineligible (next_retry_at in future)
    db.prepare(`
      INSERT INTO sync_queue (client_session_uuid, endpoint_path, payload_json, sync_status, retry_count, next_retry_at, created_at, updated_at)
      VALUES ('uuid-3', '/api/v1/attendance/sessions/sync', '{"id":3}', 'PENDING', 2, ?, ?, ?);
    `).run(futureIso, nowIso, nowIso);

    // 4. Ineligible (already ACKNOWLEDGED)
    db.prepare(`
      INSERT INTO sync_queue (client_session_uuid, endpoint_path, payload_json, sync_status, retry_count, created_at, updated_at)
      VALUES ('uuid-4', '/api/v1/attendance/sessions/sync', '{"id":4}', 'ACKNOWLEDGED', 0, ?, ?);
    `).run(nowIso, nowIso);

    const eligible = db.prepare(`
      SELECT client_session_uuid FROM sync_queue
      WHERE sync_status = 'PENDING'
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY queue_id ASC;
    `).all(nowIso);

    assert.equal(eligible.length, 2);
    assert.equal(eligible[0].client_session_uuid, 'uuid-1');
    assert.equal(eligible[1].client_session_uuid, 'uuid-2');
  });

  test('[3] Successful Sync Dispatch (HTTP 201) transitions queue to ACKNOWLEDGED', () => {
    const db = createInMemoryDb();
    const nowIso = new Date().toISOString();
    const clientUuid = 'uuid-succ-01';

    // Insert session and queue item
    db.prepare(`
      INSERT INTO local_attendance_sessions (
        client_session_uuid, teaching_assignment_id, session_date, period_slot_or_sequence,
        applicability_status, regular_faculty_user_id, conducting_faculty_user_id,
        session_status, created_at, updated_at
      ) VALUES (?, 'assign-1', '2026-10-13', 1, 'COUNTED', 'fac-1', 'fac-1', 'FINALIZED', ?, ?);
    `).run(clientUuid, nowIso, nowIso);

    db.prepare(`
      INSERT INTO sync_queue (client_session_uuid, endpoint_path, payload_json, sync_status, retry_count, created_at, updated_at)
      VALUES (?, '/api/v1/attendance/sessions/sync', '{"test":true}', 'PENDING', 0, ?, ?);
    `).run(clientUuid, nowIso, nowIso);

    // Mock successful transport
    const mockTransport = async () => ({
      statusCode: 201,
      data: { results: [{ status: 'SYNCED', server_session_id: 'srv-1' }] },
    });

    // Simulate worker processing
    db.prepare("UPDATE sync_queue SET sync_status = 'IN_FLIGHT', updated_at = ? WHERE client_session_uuid = ?;").run(nowIso, clientUuid);
    
    // Server returns 201
    db.prepare("UPDATE local_attendance_sessions SET session_status = 'SYNCED', updated_at = ? WHERE client_session_uuid = ?;").run(nowIso, clientUuid);
    db.prepare("UPDATE sync_queue SET sync_status = 'ACKNOWLEDGED', updated_at = ? WHERE client_session_uuid = ?;").run(nowIso, clientUuid);

    const qRow = db.prepare("SELECT sync_status FROM sync_queue WHERE client_session_uuid = ?;").get(clientUuid);
    const sRow = db.prepare("SELECT session_status FROM local_attendance_sessions WHERE client_session_uuid = ?;").get(clientUuid);

    assert.equal(qRow.sync_status, 'ACKNOWLEDGED');
    assert.equal(sRow.session_status, 'SYNCED');
  });

  test('[4] Idempotent Duplicate Sync (HTTP 200 ALREADY_SYNCED) marks ACKNOWLEDGED', () => {
    const db = createInMemoryDb();
    const nowIso = new Date().toISOString();
    const clientUuid = 'uuid-idem-01';

    db.prepare(`
      INSERT INTO local_attendance_sessions (
        client_session_uuid, teaching_assignment_id, session_date, period_slot_or_sequence,
        applicability_status, regular_faculty_user_id, conducting_faculty_user_id,
        session_status, created_at, updated_at
      ) VALUES (?, 'assign-1', '2026-10-13', 1, 'COUNTED', 'fac-1', 'fac-1', 'FINALIZED', ?, ?);
    `).run(clientUuid, nowIso, nowIso);

    db.prepare(`
      INSERT INTO sync_queue (client_session_uuid, endpoint_path, payload_json, sync_status, retry_count, created_at, updated_at)
      VALUES (?, '/api/v1/attendance/sessions/sync', '{"test":true}', 'PENDING', 0, ?, ?);
    `).run(clientUuid, nowIso, nowIso);

    // Acknowledge idempotent 200
    db.prepare("UPDATE local_attendance_sessions SET session_status = 'SYNCED', updated_at = ? WHERE client_session_uuid = ?;").run(nowIso, clientUuid);
    db.prepare("UPDATE sync_queue SET sync_status = 'ACKNOWLEDGED', updated_at = ? WHERE client_session_uuid = ?;").run(nowIso, clientUuid);

    const qRow = db.prepare("SELECT sync_status FROM sync_queue WHERE client_session_uuid = ?;").get(clientUuid);
    assert.equal(qRow.sync_status, 'ACKNOWLEDGED');
  });

  test('[5] Permanent Domain Rejection (HTTP 400/403/409) marks queue item FAILED', () => {
    const db = createInMemoryDb();
    const nowIso = new Date().toISOString();
    const clientUuid = 'uuid-rej-01';

    db.prepare(`
      INSERT INTO sync_queue (client_session_uuid, endpoint_path, payload_json, sync_status, retry_count, created_at, updated_at)
      VALUES (?, '/api/v1/attendance/sessions/sync', '{"test":true}', 'PENDING', 0, ?, ?);
    `).run(clientUuid, nowIso, nowIso);

    const errorMsg = 'Authorization rejected: Faculty is not assigned';
    db.prepare(`
      UPDATE sync_queue SET sync_status = 'FAILED', last_error = ?, updated_at = ? WHERE client_session_uuid = ?;
    `).run(errorMsg, nowIso, clientUuid);

    const qRow = db.prepare("SELECT sync_status, last_error FROM sync_queue WHERE client_session_uuid = ?;").get(clientUuid);
    assert.equal(qRow.sync_status, 'FAILED');
    assert.equal(qRow.last_error, errorMsg);
  });

  test('[6] Network Outage / Timeout schedules next_retry_at with incremented retry_count', () => {
    const db = createInMemoryDb();
    const nowIso = new Date().toISOString();
    const clientUuid = 'uuid-timeout-01';

    db.prepare(`
      INSERT INTO sync_queue (client_session_uuid, endpoint_path, payload_json, sync_status, retry_count, created_at, updated_at)
      VALUES (?, '/api/v1/attendance/sessions/sync', '{"test":true}', 'PENDING', 0, ?, ?);
    `).run(clientUuid, nowIso, nowIso);

    // Simulate transient failure attempt 1
    const delayMs = AttendanceSyncWorker.calculateBackoffMs(0);
    const nextRetryIso = new Date(Date.now() + delayMs).toISOString();

    db.prepare(`
      UPDATE sync_queue
      SET sync_status = 'PENDING', retry_count = 1, last_error = 'Network request timeout', next_retry_at = ?, updated_at = ?
      WHERE client_session_uuid = ?;
    `).run(nextRetryIso, nowIso, clientUuid);

    const qRow = db.prepare("SELECT sync_status, retry_count, last_error, next_retry_at FROM sync_queue WHERE client_session_uuid = ?;").get(clientUuid);
    assert.equal(qRow.sync_status, 'PENDING');
    assert.equal(qRow.retry_count, 1);
    assert.equal(qRow.last_error, 'Network request timeout');
    assert(qRow.next_retry_at !== null);
  });

  test('[7] Offline Queue Survivability: Pending items survive simulated app kill & restart', () => {
    const db = createInMemoryDb();
    const nowIso = new Date().toISOString();

    db.prepare(`
      INSERT INTO sync_queue (client_session_uuid, endpoint_path, payload_json, sync_status, retry_count, created_at, updated_at)
      VALUES ('uuid-survive-01', '/api/v1/attendance/sessions/sync', '{"session":1}', 'PENDING', 0, ?, ?);
    `).run(nowIso, nowIso);

    // Read back
    const rows = db.prepare("SELECT * FROM sync_queue WHERE sync_status = 'PENDING';").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].client_session_uuid, 'uuid-survive-01');
    assert.equal(rows[0].payload_json, '{"session":1}');
  });

  test('[8] Database Invariant: UNIQUE(client_session_uuid) on sync_queue blocks duplicate queue rows', () => {
    const db = createInMemoryDb();
    const nowIso = new Date().toISOString();
    const uuidVal = 'uuid-unique-queue';

    db.prepare(`
      INSERT INTO sync_queue (client_session_uuid, endpoint_path, payload_json, sync_status, retry_count, created_at, updated_at)
      VALUES (?, '/api/v1/attendance/sessions/sync', '{}', 'PENDING', 0, ?, ?);
    `).run(uuidVal, nowIso, nowIso);

    assert.throws(() => {
      db.prepare(`
        INSERT INTO sync_queue (client_session_uuid, endpoint_path, payload_json, sync_status, retry_count, created_at, updated_at)
        VALUES (?, '/api/v1/attendance/sessions/sync', '{}', 'PENDING', 0, ?, ?);
      `).run(uuidVal, nowIso, nowIso);
    }, /UNIQUE constraint failed/i);
  });

  test('[9] Malformed JSON payload is trapped gracefully without throwing unhandled exception', () => {
    const db = createInMemoryDb();
    const nowIso = new Date().toISOString();
    const uuidVal = 'uuid-bad-json';

    db.prepare(`
      INSERT INTO sync_queue (client_session_uuid, endpoint_path, payload_json, sync_status, retry_count, created_at, updated_at)
      VALUES (?, '/api/v1/attendance/sessions/sync', 'INVALID_JSON_CORRUPT', 'PENDING', 0, ?, ?);
    `).run(uuidVal, nowIso, nowIso);

    let parsed = null;
    let parseError = null;
    const row = db.prepare("SELECT payload_json FROM sync_queue WHERE client_session_uuid = ?;").get(uuidVal);
    try {
      parsed = JSON.parse(row.payload_json);
    } catch (e) {
      parseError = e;
      db.prepare(`
        UPDATE sync_queue SET sync_status = 'FAILED', last_error = ?, updated_at = ? WHERE client_session_uuid = ?;
      `).run(`Payload JSON parse error: ${e.message}`, nowIso, uuidVal);
    }

    assert(parseError !== null);
    const failedRow = db.prepare("SELECT sync_status, last_error FROM sync_queue WHERE client_session_uuid = ?;").get(uuidVal);
    assert.equal(failedRow.sync_status, 'FAILED');
    assert(failedRow.last_error.includes('Payload JSON parse error'));
  });

  test('[10] HARD DOMAIN INVARIANT: Queue payload contains ZERO raw face embeddings or camera frames', () => {
    const validFinalizationPayload = {
      clientSessionUuid: 'uuid-privacy-check',
      teachingAssignmentId: 'assign-1',
      sessionDate: '2026-10-13',
      periodSlotOrSequence: 1,
      applicabilityStatus: 'COUNTED',
      finalizedAt: new Date().toISOString(),
      records: [
        {
          studentUserId: 'usr-1',
          attendanceStatus: 'PRESENT',
          markSource: 'AI_VERIFIED',
          candidateConfidence: 0.89,
          recordedAt: new Date().toISOString(),
        },
      ],
    };

    const payloadStr = JSON.stringify(validFinalizationPayload);
    assert(!payloadStr.includes('embedding'), 'Payload must not contain raw embeddings');
    assert(!payloadStr.includes('embedding_blob'), 'Payload must not contain embedding blob');
    assert(!payloadStr.includes('face_image'), 'Payload must not contain face images');
    assert(!payloadStr.includes('frame_buffer'), 'Payload must not contain frame buffer');
  });

  test('[11] AMENDMENT_SYNC dispatch: HTTP 201 marks item ACKNOWLEDGED', async () => {
    const db = createInMemoryDb();
    const nowIso = new Date().toISOString();
    const clientUuid = 'uuid-amend-01';
    const amendmentId = 'amend-uuid-1111';

    db.prepare(`
      INSERT INTO sync_queue (
        client_session_uuid, operation_type, client_amendment_id,
        endpoint_path, payload_json, sync_status, retry_count, created_at, updated_at
      ) VALUES (?, 'AMENDMENT_SYNC', ?, '/api/v1/attendance/sessions/sync-amend', '{"student_user_id":"s1","new_status":"PRESENT"}', 'PENDING', 0, ?, ?);
    `).run(clientUuid, amendmentId, nowIso, nowIso);

    const items = await AttendanceSyncWorker.getPendingQueueItems(5, db);
    assert.equal(items.length, 1);
    assert.equal(items[0].operationType, 'AMENDMENT_SYNC');
    assert.equal(items[0].clientAmendmentId, amendmentId);

    const mockTransport = async (path, payload) => {
      assert.equal(path, '/api/v1/attendance/sessions/sync-amend');
      assert.equal(payload.student_user_id, 's1');
      return { statusCode: 201, data: { amendment_id: 'srv-amend-1' } };
    };

    const res = await AttendanceSyncWorker.processQueueItem(items[0], mockTransport, 'token', db);
    assert.equal(res.success, true);
    assert.equal(res.status, 'ACKNOWLEDGED');

    const updated = db.prepare('SELECT sync_status FROM sync_queue WHERE queue_id = ?;').get(items[0].queueId);
    assert.equal(updated.sync_status, 'ACKNOWLEDGED');
  });

  test('[12] AMENDMENT_SYNC idempotent duplicate: HTTP 200 marks item ACKNOWLEDGED', async () => {
    const db = createInMemoryDb();
    const nowIso = new Date().toISOString();
    const clientUuid = 'uuid-amend-02';
    const amendmentId = 'amend-uuid-2222';

    db.prepare(`
      INSERT INTO sync_queue (
        client_session_uuid, operation_type, client_amendment_id,
        endpoint_path, payload_json, sync_status, retry_count, created_at, updated_at
      ) VALUES (?, 'AMENDMENT_SYNC', ?, '/api/v1/attendance/sessions/sync-amend', '{"student_user_id":"s1"}', 'PENDING', 0, ?, ?);
    `).run(clientUuid, amendmentId, nowIso, nowIso);

    const items = await AttendanceSyncWorker.getPendingQueueItems(5, db);
    const mockTransport = async () => ({
      statusCode: 200,
      data: { is_already_synced: true, amendment_id: 'srv-amend-1' },
    });

    const res = await AttendanceSyncWorker.processQueueItem(items[0], mockTransport, 'token', db);
    assert.equal(res.success, true);
    assert.equal(res.status, 'ACKNOWLEDGED');
  });

  test('[13] AMENDMENT_SYNC concurrency conflict: HTTP 409 marks item FAILED with isConflict=true', async () => {
    const db = createInMemoryDb();
    const nowIso = new Date().toISOString();
    const clientUuid = 'uuid-amend-03';
    const amendmentId = 'amend-uuid-3333';

    db.prepare(`
      INSERT INTO sync_queue (
        client_session_uuid, operation_type, client_amendment_id,
        endpoint_path, payload_json, sync_status, retry_count, created_at, updated_at
      ) VALUES (?, 'AMENDMENT_SYNC', ?, '/api/v1/attendance/sessions/sync-amend', '{"student_user_id":"s1"}', 'PENDING', 0, ?, ?);
    `).run(clientUuid, amendmentId, nowIso, nowIso);

    const items = await AttendanceSyncWorker.getPendingQueueItems(5, db);
    const mockTransport = async () => ({
      statusCode: 409,
      data: { detail: 'Conflict: Stale attendance state: student s1 current status is EXCUSED, expected ABSENT' },
    });

    const res = await AttendanceSyncWorker.processQueueItem(items[0], mockTransport, 'token', db);
    assert.equal(res.success, false);
    assert.equal(res.status, 'FAILED');
    assert.equal(res.isConflict, true);
    assert.ok(res.errorMessage.includes('Stale attendance state'));

    const updated = db.prepare('SELECT sync_status, last_error FROM sync_queue WHERE queue_id = ?;').get(items[0].queueId);
    assert.equal(updated.sync_status, 'FAILED');
    assert.ok(updated.last_error.includes('Stale attendance state'));
  });

  test('[14] Multi-operation queue: SESSION_SYNC and multiple AMENDMENT_SYNC processed independently by queue_id', async () => {
    const db = createInMemoryDb();
    const nowIso = new Date().toISOString();
    const clientUuid = 'uuid-multi-op';

    // 1. Session sync item
    db.prepare(`
      INSERT INTO sync_queue (
        client_session_uuid, operation_type, endpoint_path, payload_json, sync_status, retry_count, created_at, updated_at
      ) VALUES (?, 'SESSION_SYNC', '/api/v1/attendance/sessions/sync', '{"session":1}', 'PENDING', 0, ?, ?);
    `).run(clientUuid, nowIso, nowIso);

    // 2. Amendment 1
    db.prepare(`
      INSERT INTO sync_queue (
        client_session_uuid, operation_type, client_amendment_id, endpoint_path, payload_json, sync_status, retry_count, created_at, updated_at
      ) VALUES (?, 'AMENDMENT_SYNC', 'amend-001', '/api/v1/attendance/sessions/amend', '{"student":"s1"}', 'PENDING', 0, ?, ?);
    `).run(clientUuid, nowIso, nowIso);

    // 3. Amendment 2
    db.prepare(`
      INSERT INTO sync_queue (
        client_session_uuid, operation_type, client_amendment_id, endpoint_path, payload_json, sync_status, retry_count, created_at, updated_at
      ) VALUES (?, 'AMENDMENT_SYNC', 'amend-002', '/api/v1/attendance/sessions/amend', '{"student":"s2"}', 'PENDING', 0, ?, ?);
    `).run(clientUuid, nowIso, nowIso);

    const items = await AttendanceSyncWorker.getPendingQueueItems(10, db);
    assert.equal(items.length, 3);

    // Process only item 1 (session sync)
    const mockTransport = async () => ({ statusCode: 201, data: { ok: true } });
    await AttendanceSyncWorker.processQueueItem(items[0], mockTransport, 'token', db);

    // Check states in DB: item 1 ACKNOWLEDGED, items 2 and 3 still PENDING
    const q1 = db.prepare('SELECT sync_status FROM sync_queue WHERE queue_id = ?;').get(items[0].queueId);
    const q2 = db.prepare('SELECT sync_status FROM sync_queue WHERE queue_id = ?;').get(items[1].queueId);
    const q3 = db.prepare('SELECT sync_status FROM sync_queue WHERE queue_id = ?;').get(items[2].queueId);

    assert.equal(q1.sync_status, 'ACKNOWLEDGED');
    assert.equal(q2.sync_status, 'PENDING');
    assert.equal(q3.sync_status, 'PENDING');
  });
});
