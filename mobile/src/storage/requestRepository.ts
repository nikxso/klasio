export type RequestState = 'Sent' | 'Being reviewed' | 'Accepted' | 'Not accepted';

import { API_BASE_URL } from '../config/api';

export interface CachedStudentRequest {
  id: string;
  studentUserId: string;
  teachingAssignmentId: string;
  subjectName: string;
  sessionDate: string;
  studentNote: string;
  status: RequestState;
  resolutionNote?: string | null;
  createdAt: string;
}

async function resolveDb() {
  const { getDatabase } = await import('./database.ts');
  return await getDatabase();
}

export class RequestRepository {
  /**
   * Save or update cached requests for a student.
   */
  static async saveRequests(requests: CachedStudentRequest[]): Promise<void> {
    if (!requests || requests.length === 0) return;
    const db = await resolveDb();

    await db.withTransactionAsync(async () => {
      for (const r of requests) {
        await db.runAsync(
          `INSERT OR REPLACE INTO cached_student_requests (
            id, student_user_id, teaching_assignment_id, subject_name,
            session_date, student_note, status, resolution_note, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            r.id,
            r.studentUserId,
            r.teachingAssignmentId,
            r.subjectName,
            r.sessionDate,
            r.studentNote,
            r.status,
            r.resolutionNote || null,
            r.createdAt,
          ]
        );
      }
    });
  }

  /**
   * Create and persist a new grievance request locally (e.g. offline or pending sync).
   */
  static async createRequest(
    req: Omit<CachedStudentRequest, 'id' | 'status' | 'createdAt'>
  ): Promise<CachedStudentRequest> {
    const db = await resolveDb();
    const id = `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const createdAt = new Date().toISOString();
    const newReq: CachedStudentRequest = {
      ...req,
      id,
      status: 'Sent',
      createdAt,
    };

    await db.runAsync(
      `INSERT INTO cached_student_requests (
        id, student_user_id, teaching_assignment_id, subject_name,
        session_date, student_note, status, resolution_note, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [
        newReq.id,
        newReq.studentUserId,
        newReq.teachingAssignmentId,
        newReq.subjectName,
        newReq.sessionDate,
        newReq.studentNote,
        newReq.status,
        newReq.resolutionNote || null,
        newReq.createdAt,
      ]
    );

    return newReq;
  }

  /**
   * Retrieve all requests for a student ordered by created_at DESC.
   */
  static async getRequests(studentUserId: string): Promise<CachedStudentRequest[]> {
    const db = await resolveDb();
    const rows = await db.getAllAsync<{
      id: string;
      student_user_id: string;
      teaching_assignment_id: string;
      subject_name: string;
      session_date: string;
      student_note: string;
      status: RequestState;
      resolution_note: string | null;
      created_at: string;
    }>(
      `SELECT * FROM cached_student_requests WHERE student_user_id = ? ORDER BY created_at DESC;`,
      [studentUserId]
    );

    return rows.map((r) => ({
      id: r.id,
      studentUserId: r.student_user_id,
      teachingAssignmentId: r.teaching_assignment_id,
      subjectName: r.subject_name,
      sessionDate: r.session_date,
      studentNote: r.student_note,
      status: r.status,
      resolutionNote: r.resolution_note,
      createdAt: r.created_at,
    }));
  }

  /**
   * Dispatches any locally created offline requests (id LIKE 'req-%') to the backend.
   */
  static async syncPendingRequests(token?: string): Promise<{ synced: number }> {
    if (!token) return { synced: 0 };
    const db = await resolveDb();
    let rows: any[] = [];
    try {
      rows = await db.getAllAsync<{
        id: string;
        student_user_id: string;
        teaching_assignment_id: string;
        subject_name: string;
        session_date: string;
        student_note: string;
      }>(
        `SELECT * FROM cached_student_requests WHERE id LIKE 'req-%';`
      );
    } catch {
      return { synced: 0 };
    }

    let synced = 0;
    for (const row of rows) {
      try {
        const res = await fetch(`${API_BASE_URL}/api/v1/student/requests`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
          },
          body: JSON.stringify({
            teaching_assignment_id: row.teaching_assignment_id,
            session_date: row.session_date,
            student_note: row.student_note,
          }),
        });

        if (res.ok) {
          const created = await res.json();
          await db.runAsync('DELETE FROM cached_student_requests WHERE id = ?;', [row.id]);
          await db.runAsync(
            `INSERT OR REPLACE INTO cached_student_requests (
              id, student_user_id, teaching_assignment_id, subject_name,
              session_date, student_note, status, resolution_note, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
            [
              created.id,
              created.student_user_id,
              created.teaching_assignment_id,
              created.subject_name || row.subject_name,
              created.session_date,
              created.student_note,
              'Sent',
              created.resolution_note || null,
              created.created_at,
            ]
          );
          synced++;
        }
      } catch (_) {}
    }
    return { synced };
  }
}
