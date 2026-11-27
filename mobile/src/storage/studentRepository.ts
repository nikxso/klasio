import { getDatabase } from './database';

export interface StudentSubjectSummary {
  subject_id: string;
  teaching_assignment_id: string;
  subject_code: string;
  subject_name: string;
  faculty_name: string;
  total_eligible_sessions: number;
  attended_sessions: number;
  attendance_percentage: number | null;
  effective_start_date: string;
  classes_to_recover: number | null;
  classes_can_miss: number;
  is_shortage: boolean;
  is_recoverable: boolean;
  threshold: number;
}

export interface StudentWeeklyTrendPoint {
  period_label: string;
  attendance_percentage?: number | null;
  total_present: number;
  total_eligible: number;
  start_date?: string;
  end_date?: string;
}

export interface StudentPersonalAttendanceResponse {
  student_id: string;
  academic_term_id?: string | null;
  subjects: StudentSubjectSummary[];
  overall_attendance_percentage: number | null;
  total_eligible_sessions?: number;
  total_attended_sessions?: number;
  weekly_trend?: StudentWeeklyTrendPoint[];
}

export interface StudentSessionHistoryItem {
  session_id: string;
  session_date: string;
  period_slot_or_sequence: number;
  attendance_status: 'PRESENT' | 'ABSENT' | 'EXCUSED';
  applicability_status: 'COUNTED' | 'CANCELLED' | 'EXEMPT';
  mark_source?: 'AI_VERIFIED' | 'MANUAL_MARK' | 'MANUAL_OVERRIDE' | null;
  status_reason?: string | null;
  recorded_at?: string | null;
}

export interface StudentSubjectHistoryResponse {
  teaching_assignment_id: string;
  subject_id: string;
  subject_code: string;
  subject_name: string;
  faculty_name: string;
  total_eligible_sessions: number;
  attended_sessions: number;
  attendance_percentage: number | null;
  classes_to_recover: number | null;
  classes_can_miss: number;
  is_shortage: boolean;
  is_recoverable: boolean;
  threshold: number;
  records: StudentSessionHistoryItem[];
}

export class StudentRepository {
  /**
   * Save student's attendance summary to local SQLite cache.
   */
  static async saveCachedAttendance(
    studentUserId: string,
    payload: StudentPersonalAttendanceResponse
  ): Promise<void> {
    const db = await getDatabase();
    const nowIso = new Date().toISOString();
    const jsonStr = JSON.stringify(payload);

    await db.runAsync(
      `INSERT INTO cached_student_attendance (student_user_id, overall_attendance_percentage, payload_json, cached_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(student_user_id) DO UPDATE SET
         overall_attendance_percentage = excluded.overall_attendance_percentage,
         payload_json = excluded.payload_json,
         cached_at = excluded.cached_at;`,
      [studentUserId, payload.overall_attendance_percentage, jsonStr, nowIso]
    );
  }

  /**
   * Retrieve cached attendance summary for offline resilience.
   */
  static async getCachedAttendance(
    studentUserId: string
  ): Promise<{ data: StudentPersonalAttendanceResponse; cachedAt: string } | null> {
    const db = await getDatabase();
    const row = await db.getFirstAsync<{ payload_json: string; cached_at: string }>(
      'SELECT payload_json, cached_at FROM cached_student_attendance WHERE student_user_id = ?;',
      [studentUserId]
    );

    if (!row) return null;
    try {
      const data = JSON.parse(row.payload_json) as StudentPersonalAttendanceResponse;
      return { data, cachedAt: row.cached_at };
    } catch {
      return null;
    }
  }

  /**
   * Save subject-specific attendance history to local SQLite cache.
   */
  static async saveCachedSubjectHistory(
    teachingAssignmentId: string,
    studentUserId: string,
    payload: StudentSubjectHistoryResponse
  ): Promise<void> {
    const db = await getDatabase();
    const nowIso = new Date().toISOString();
    const jsonStr = JSON.stringify(payload);

    await db.runAsync(
      `INSERT INTO cached_student_subject_history (teaching_assignment_id, student_user_id, payload_json, cached_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(teaching_assignment_id) DO UPDATE SET
         student_user_id = excluded.student_user_id,
         payload_json = excluded.payload_json,
         cached_at = excluded.cached_at;`,
      [teachingAssignmentId, studentUserId, jsonStr, nowIso]
    );
  }

  /**
   * Retrieve cached subject history for offline resilience.
   */
  static async getCachedSubjectHistory(
    teachingAssignmentId: string,
    studentUserId: string
  ): Promise<{ data: StudentSubjectHistoryResponse; cachedAt: string } | null> {
    const db = await getDatabase();
    const row = await db.getFirstAsync<{ payload_json: string; cached_at: string }>(
      'SELECT payload_json, cached_at FROM cached_student_subject_history WHERE teaching_assignment_id = ? AND student_user_id = ?;',
      [teachingAssignmentId, studentUserId]
    );

    if (!row) return null;
    try {
      const data = JSON.parse(row.payload_json) as StudentSubjectHistoryResponse;
      return { data, cachedAt: row.cached_at };
    } catch {
      return null;
    }
  }
}
