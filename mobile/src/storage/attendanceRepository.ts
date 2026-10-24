import type {
  AttendanceFinalizationPayload,
  AttendanceFinalizationResult,
} from '../perception/contracts.ts';

interface RepoDb {
  getFirstAsync<T = any>(sql: string, params?: any[]): Promise<T | null>;
  getAllAsync<T = any>(sql: string, params?: any[]): Promise<T[]>;
  runAsync(sql: string, params?: any[]): Promise<void>;
  withTransactionAsync(fn: () => Promise<void>): Promise<void>;
}

async function resolveRepoDb(customDb?: any): Promise<RepoDb> {
  if (customDb) {
    return {
      async getFirstAsync<T = any>(sql: string, params: any[] = []): Promise<T | null> {
        if (customDb.getFirstAsync) return customDb.getFirstAsync(sql, params);
        if (customDb.prepare) {
          const row = customDb.prepare(sql).get(...params);
          return (row as T) || null;
        }
        return null;
      },
      async getAllAsync<T = any>(sql: string, params: any[] = []): Promise<T[]> {
        if (customDb.getAllAsync) return customDb.getAllAsync(sql, params);
        if (customDb.prepare) {
          return customDb.prepare(sql).all(...params) as T[];
        }
        return [];
      },
      async runAsync(sql: string, params: any[] = []): Promise<void> {
        if (customDb.runAsync) return customDb.runAsync(sql, params);
        if (customDb.prepare) {
          customDb.prepare(sql).run(...params);
          return;
        }
      },
      async withTransactionAsync(fn: () => Promise<void>): Promise<void> {
        if (customDb.withTransactionAsync) return customDb.withTransactionAsync(fn);
        if (customDb.exec) {
          customDb.exec('BEGIN TRANSACTION;');
          try {
            await fn();
            customDb.exec('COMMIT;');
          } catch (err) {
            customDb.exec('ROLLBACK;');
            throw err;
          }
          return;
        }
        await fn();
      },
    };
  }

  const { getDatabase } = await import('./database.ts');
  const db = await getDatabase();
  return {
    async getFirstAsync<T = any>(sql: string, params: any[] = []): Promise<T | null> {
      return db.getFirstAsync(sql, params);
    },
    async getAllAsync<T = any>(sql: string, params: any[] = []): Promise<T[]> {
      return db.getAllAsync(sql, params);
    },
    async runAsync(sql: string, params: any[] = []): Promise<void> {
      await db.runAsync(sql, params);
    },
    async withTransactionAsync(fn: () => Promise<void>): Promise<void> {
      return db.withTransactionAsync(fn);
    },
  };
}

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

export interface LocalAmendmentAuditRow {
  id: number;
  client_amendment_id: string | null;
  client_session_uuid: string;
  student_user_id: string;
  previous_status: 'PRESENT' | 'ABSENT' | 'EXCUSED';
  new_status: 'PRESENT' | 'ABSENT' | 'EXCUSED';
  amending_user_id: string;
  amendment_role: 'REGULAR_FACULTY' | 'SUBSTITUTE_FACULTY' | 'ADMIN';
  amendment_reason: string;
  amended_at: string;
}

export class AttendanceRepository {
  /**
   * Atomically commits an attendance session, all student attendance records,
   * and an outbound sync queue item in a single SQLite ACID transaction.
   * Fully idempotent against repeated requests with the same clientSessionUuid.
   */
  static async finalizeSession(
    payload: AttendanceFinalizationPayload,
    customDb?: any
  ): Promise<AttendanceFinalizationResult> {
    const db = await resolveRepoDb(customDb);
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
          client_session_uuid, operation_type, endpoint_path, payload_json, sync_status,
          retry_count, created_at, updated_at
        ) VALUES (?, 'SESSION_SYNC', '/api/v1/attendance/sessions/sync', ?, 'PENDING', 0, ?, ?)
        ON CONFLICT(client_session_uuid) WHERE operation_type = 'SESSION_SYNC' DO UPDATE SET
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
    clientSessionUuid: string,
    customDb?: any
  ): Promise<{ session: LocalSessionRow; records: LocalRecordRow[] } | null> {
    const db = await resolveRepoDb(customDb);
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
  static async acknowledgeSync(clientSessionUuid: string, customDb?: any): Promise<void> {
    const db = await resolveRepoDb(customDb);
    const nowIso = new Date().toISOString();

    await db.withTransactionAsync(async () => {
      await db.runAsync(
        "UPDATE local_attendance_sessions SET session_status = 'SYNCED', updated_at = ? WHERE client_session_uuid = ?;",
        [nowIso, clientSessionUuid]
      );
      await db.runAsync(
        "UPDATE sync_queue SET sync_status = 'ACKNOWLEDGED', updated_at = ? WHERE client_session_uuid = ? AND operation_type = 'SESSION_SYNC';",
        [nowIso, clientSessionUuid]
      );
    });
  }

  /**
   * Retrieves sync queue status for a finalized session.
   */
  static async getSyncStatus(
    clientSessionUuid: string,
    customDb?: any
  ): Promise<{ syncStatus: 'PENDING' | 'IN_FLIGHT' | 'ACKNOWLEDGED' | 'FAILED'; retryCount: number; lastError: string | null } | null> {
    const db = await resolveRepoDb(customDb);
    const row = await db.getFirstAsync<{
      sync_status: 'PENDING' | 'IN_FLIGHT' | 'ACKNOWLEDGED' | 'FAILED';
      retry_count: number;
      last_error: string | null;
    }>(
      "SELECT sync_status, retry_count, last_error FROM sync_queue WHERE client_session_uuid = ? AND operation_type = 'SESSION_SYNC';",
      [clientSessionUuid]
    );
    if (!row) return null;
    return {
      syncStatus: row.sync_status,
      retryCount: row.retry_count,
      lastError: row.last_error,
    };
  }

  /**
   * Lists all local attendance sessions recorded for a given teaching assignment.
   */
  static async listSessionsForAssignment(
    teachingAssignmentId: string,
    customDb?: any
  ): Promise<LocalSessionRow[]> {
    const db = await resolveRepoDb(customDb);
    const rows = await db.getAllAsync<any>(
      `SELECT * FROM local_attendance_sessions
       WHERE teaching_assignment_id = ?
       ORDER BY session_date DESC, period_slot_or_sequence DESC;`,
      [teachingAssignmentId]
    );
    return rows.map((r) => ({
      clientSessionUuid: r.client_session_uuid,
      teachingAssignmentId: r.teaching_assignment_id,
      sessionDate: r.session_date,
      periodSlotOrSequence: r.period_slot_or_sequence,
      applicabilityStatus: r.applicability_status,
      statusReason: r.status_reason,
      regularFacultyUserId: r.regular_faculty_user_id,
      conductingFacultyUserId: r.conducting_faculty_user_id,
      substituteDelegationId: r.substitute_delegation_id,
      sessionStatus: r.session_status,
      finalizedAt: r.finalized_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Applies an authorized post-finalization amendment to a student's attendance record
   * and records an immutable audit row in local_amendment_audits as well as an AMENDMENT_SYNC
   * row in sync_queue inside ONE atomic SQLite transaction.
   */
  static async applyAmendment(
    clientSessionUuid: string,
    studentUserId: string,
    newStatus: 'PRESENT' | 'ABSENT' | 'EXCUSED',
    amendmentReason: string,
    amendingUserId: string,
    amendmentRole: 'REGULAR_FACULTY' | 'ADMIN',
    customDb?: any,
    clientAmendmentId?: string,
    expectedPreviousStatus?: 'PRESENT' | 'ABSENT' | 'EXCUSED'
  ): Promise<{ auditId: string; clientAmendmentId: string; previousStatus: string; newStatus: string }> {
    const cleanedReason = (amendmentReason || '').trim();
    if (cleanedReason.length < 10) {
      throw new Error('Amendment reason must contain at least 10 non-whitespace characters.');
    }
    if (!['PRESENT', 'ABSENT', 'EXCUSED'].includes(newStatus)) {
      throw new Error(`Invalid newStatus: ${newStatus}`);
    }
    if (!['REGULAR_FACULTY', 'ADMIN'].includes(amendmentRole)) {
      throw new Error(`Unauthorized: Role '${amendmentRole}' is not permitted to amend attendance. Only assigned regular faculty or administrators may make post-finalization amendments.`);
    }

    const db = await resolveRepoDb(customDb);
    const existing = await db.getFirstAsync<{ attendance_status: string }>(
      'SELECT attendance_status FROM local_attendance_records WHERE client_session_uuid = ? AND student_user_id = ?;',
      [clientSessionUuid, studentUserId]
    );
    if (!existing) {
      throw new Error(`Record for student ${studentUserId} in session ${clientSessionUuid} not found.`);
    }

    const previousStatus = existing.attendance_status;
    if (previousStatus === newStatus) {
      throw new Error(`Amendment must change attendance status. Current status is already ${newStatus}.`);
    }

    if (expectedPreviousStatus && previousStatus !== expectedPreviousStatus) {
      throw new Error(`Optimistic concurrency conflict: student attendance status was changed to ${previousStatus} (expected: ${expectedPreviousStatus}).`);
    }

    const stableAmendmentId =
      clientAmendmentId ||
      (typeof crypto !== 'undefined' && crypto.randomUUID
        ? crypto.randomUUID()
        : 'amd-' + Math.random().toString(36).substring(2, 10) + '-' + Date.now().toString(36));
    const auditId = 'audit-' + Math.random().toString(36).substring(2, 10);
    const nowIso = new Date().toISOString();

    const payloadObj = {
      client_amendment_id: stableAmendmentId,
      attendance_session_id: clientSessionUuid,
      student_user_id: studentUserId,
      expected_previous_status: previousStatus,
      new_status: newStatus,
      amendment_reason: cleanedReason,
    };
    const payloadJson = JSON.stringify(payloadObj);

    await db.withTransactionAsync(async () => {
      // 1. Update local attendance record
      await db.runAsync(
        "UPDATE local_attendance_records SET attendance_status = ?, mark_source = 'MANUAL_OVERRIDE', recorded_at = ? WHERE client_session_uuid = ? AND student_user_id = ?;",
        [newStatus, nowIso, clientSessionUuid, studentUserId]
      );

      // 2. Insert into local_amendment_audits
      await db.runAsync(
        `INSERT INTO local_amendment_audits (
          audit_id, client_amendment_id, client_session_uuid, student_user_id,
          previous_status, new_status, amending_user_id, amendment_role,
          amendment_reason, amended_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          auditId,
          stableAmendmentId,
          clientSessionUuid,
          studentUserId,
          previousStatus,
          newStatus,
          amendingUserId,
          amendmentRole,
          cleanedReason,
          nowIso,
        ]
      );

      // 3. Atomically enqueue into sync_queue with operation_type = 'AMENDMENT_SYNC'
      await db.runAsync(
        `INSERT INTO sync_queue (
          client_session_uuid, operation_type, client_amendment_id, endpoint_path,
          payload_json, sync_status, retry_count, created_at, updated_at
        ) VALUES (?, 'AMENDMENT_SYNC', ?, ?, ?, 'PENDING', 0, ?, ?);`,
        [
          clientSessionUuid,
          stableAmendmentId,
          `/api/v1/attendance/sessions/${clientSessionUuid}/amendments`,
          payloadJson,
          nowIso,
          nowIso,
        ]
      );
    });

    return { auditId, clientAmendmentId: stableAmendmentId, previousStatus, newStatus };
  }

  /**
   * Lists all local amendment audits for a session.
   */
  static async listAmendmentsForSession(clientSessionUuid: string, customDb?: any): Promise<LocalAmendmentAuditRow[]> {
    const db = await resolveRepoDb(customDb);
    return db.getAllAsync<LocalAmendmentAuditRow>(
      'SELECT * FROM local_amendment_audits WHERE client_session_uuid = ? ORDER BY amended_at ASC;',
      [clientSessionUuid]
    );
  }
}

