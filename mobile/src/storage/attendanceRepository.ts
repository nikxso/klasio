import { getDatabase } from './database';
import {
  AttendanceFinalizationPayload,
  AttendanceFinalizationResult,
} from '../perception/contracts';

export interface LocalSessionRow {
  clientSessionUuid: string;
  teachingAssignmentId: string;
  sessionDate: string;
  periodSlotOrSequence: number;
  applicabilityStatus: 'COUNTED' | 'CANCELLED' | 'EXEMPT';
  statusReason: string | null;
  regularFacultyUserId: string;
  conductingFacultyUserId: string;
  substituteDelegationId: string | null;
  sessionStatus: 'DRAFT' | 'FINALIZED' | 'SYNCED';
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LocalRecordRow {
  id: number;
  clientSessionUuid: string;
  studentUserId: string;
  attendanceStatus: 'PRESENT' | 'ABSENT' | 'EXCUSED';
  markSource: 'AI_VERIFIED' | 'MANUAL_MARK' | 'MANUAL_OVERRIDE';
  candidateConfidence: number | null;
  recordedAt: string;
}

export class AttendanceRepository {
  /**
   * Atomically commits an attendance session, all student attendance records,
   * and an outbound sync queue item in a single SQLite ACID transaction.
   * Fully idempotent against repeated requests with the same clientSessionUuid.
   */
  static async finalizeSession(
    payload: AttendanceFinalizationPayload
  ): Promise<AttendanceFinalizationResult> {
    const db = await getDatabase();
    const nowIso = new Date().toISOString();

    let recordsInserted = 0;

    await db.withTransactionAsync(async () => {
      // 1. Idempotency Check:
      // If the session is already finalized with this client_session_uuid, do not re-create records.
      const existing = await db.getFirstAsync<{ session_status: string }>(
        'SELECT session_status FROM local_attendance_sessions WHERE client_session_uuid = ?;',
        [payload.clientSessionUuid]
      );

      if (existing && (existing.session_status === 'FINALIZED' || existing.session_status === 'SYNCED')) {
        // Count existing records and return idempotently
        const countRes = await db.getFirstAsync<{ count: number }>(
          'SELECT COUNT(*) as count FROM local_attendance_records WHERE client_session_uuid = ?;',
          [payload.clientSessionUuid]
        );
        recordsInserted = countRes?.count ?? payload.records.length;
        return;
      }

      // 2. Duplicate Session Slot Invariant Check:
      // Prevent creating two different sessions for the same assignment, date, and period slot.
      const slotConflict = await db.getFirstAsync<{ client_session_uuid: string }>(
        `SELECT client_session_uuid FROM local_attendance_sessions
         WHERE teaching_assignment_id = ? AND session_date = ? AND period_slot_or_sequence = ?
         AND client_session_uuid != ?;`,
        [
          payload.teachingAssignmentId,
          payload.sessionDate,
          payload.periodSlotOrSequence,
          payload.clientSessionUuid,
        ]
      );

      if (slotConflict) {
        throw new Error(
          `A session already exists for assignment ${payload.teachingAssignmentId} on date ${payload.sessionDate} slot ${payload.periodSlotOrSequence} (UUID: ${slotConflict.client_session_uuid})`
        );
      }

      // 3. Upsert Local Attendance Session
      await db.runAsync(
        `INSERT INTO local_attendance_sessions (
          client_session_uuid, teaching_assignment_id, session_date,
          period_slot_or_sequence, applicability_status, status_reason,
          regular_faculty_user_id, conducting_faculty_user_id, substitute_delegation_id,
          session_status, finalized_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'FINALIZED', ?, ?, ?)
        ON CONFLICT(client_session_uuid) DO UPDATE SET
          session_status = 'FINALIZED',
          finalized_at = excluded.finalized_at,
          updated_at = excluded.updated_at;`,
        [
          payload.clientSessionUuid,
          payload.teachingAssignmentId,
          payload.sessionDate,
          payload.periodSlotOrSequence,
          payload.applicabilityStatus,
          payload.statusReason ?? null,
          payload.regularFacultyUserId,
          payload.conductingFacultyUserId,
          payload.substituteDelegationId ?? null,
          payload.finalizedAt,
          nowIso,
          nowIso,
        ]
      );

      // 4. Clean any prior draft records for this session
      await db.runAsync(
        'DELETE FROM local_attendance_records WHERE client_session_uuid = ?;',
        [payload.clientSessionUuid]
      );

      // 5. Insert Individual Student Attendance Records
      for (const rec of payload.records) {
        await db.runAsync(
          `INSERT INTO local_attendance_records (
            client_session_uuid, student_user_id, attendance_status,
            mark_source, candidate_confidence, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?);`,
          [
            payload.clientSessionUuid,
            rec.studentUserId,
            rec.attendanceStatus,
            rec.markSource,
            rec.candidateConfidence,
            rec.recordedAt,
          ]
        );
      }
      recordsInserted = payload.records.length;

      // 6. Enqueue into Outbound Sync Queue for Offline Synchronization
      const syncPayloadJson = JSON.stringify(payload);
      await db.runAsync(
        `INSERT INTO sync_queue (
          client_session_uuid, endpoint_path, payload_json, sync_status,
          retry_count, created_at, updated_at
        ) VALUES (?, '/api/v1/attendance/sessions/sync', ?, 'PENDING', 0, ?, ?)
        ON CONFLICT(client_session_uuid) DO UPDATE SET
          payload_json = excluded.payload_json,
          sync_status = 'PENDING',
          updated_at = excluded.updated_at;`,
        [payload.clientSessionUuid, syncPayloadJson, nowIso, nowIso]
      );
    });

    return {
      success: true,
      clientSessionUuid: payload.clientSessionUuid,
      recordsCount: recordsInserted,
      finalizedAt: payload.finalizedAt,
    };
  }

  /**
   * Retrieves a finalized local session with all attendance records.
   */
  static async getSession(
    clientSessionUuid: string
  ): Promise<{ session: LocalSessionRow; records: LocalRecordRow[] } | null> {
    const db = await getDatabase();
    const sessionRow = await db.getFirstAsync<any>(
      'SELECT * FROM local_attendance_sessions WHERE client_session_uuid = ?;',
      [clientSessionUuid]
    );

    if (!sessionRow) return null;

    const recordRows = await db.getAllAsync<any>(
      'SELECT * FROM local_attendance_records WHERE client_session_uuid = ? ORDER BY id ASC;',
      [clientSessionUuid]
    );

    return {
      session: {
        clientSessionUuid: sessionRow.client_session_uuid,
        teachingAssignmentId: sessionRow.teaching_assignment_id,
        sessionDate: sessionRow.session_date,
        periodSlotOrSequence: sessionRow.period_slot_or_sequence,
        applicabilityStatus: sessionRow.applicability_status,
        statusReason: sessionRow.status_reason,
        regularFacultyUserId: sessionRow.regular_faculty_user_id,
        conductingFacultyUserId: sessionRow.conducting_faculty_user_id,
        substituteDelegationId: sessionRow.substitute_delegation_id,
        sessionStatus: sessionRow.session_status,
        finalizedAt: sessionRow.finalized_at,
        createdAt: sessionRow.created_at,
        updatedAt: sessionRow.updated_at,
      },
      records: recordRows.map((r) => ({
        id: r.id,
        clientSessionUuid: r.client_session_uuid,
        studentUserId: r.student_user_id,
        attendanceStatus: r.attendance_status,
        markSource: r.mark_source,
        candidateConfidence: r.candidate_confidence,
        recordedAt: r.recorded_at,
      })),
    };
  }

  /**
   * Acknowledges server synchronization confirmation.
   */
  static async acknowledgeSync(clientSessionUuid: string): Promise<void> {
    const db = await getDatabase();
    const nowIso = new Date().toISOString();

    await db.withTransactionAsync(async () => {
      await db.runAsync(
        "UPDATE local_attendance_sessions SET session_status = 'SYNCED', updated_at = ? WHERE client_session_uuid = ?;",
        [nowIso, clientSessionUuid]
      );
      await db.runAsync(
        "UPDATE sync_queue SET sync_status = 'ACKNOWLEDGED', updated_at = ? WHERE client_session_uuid = ?;",
        [nowIso, clientSessionUuid]
      );
    });
  }
}
