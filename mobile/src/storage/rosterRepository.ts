import { API_BASE_URL } from '../config/api.ts';

async function resolveDb() {
  const { getDatabase } = await import('./database.ts');
  const db = await getDatabase();
  return {
    ...db,
    runAsync: (sql: string, params: any[] = []) => db.runAsync(sql, params),
    getFirstAsync: <T = any>(sql: string, params: any[] = []) => db.getFirstAsync<T>(sql, params),
    getAllAsync: <T = any>(sql: string, params: any[] = []) => db.getAllAsync<T>(sql, params),
    async withTransactionAsync(fn: () => Promise<void>) {
      await fn();
    },
  };
}

export interface CachedStudent {
  teachingAssignmentId: string;
  studentUserId: string;
  institutionalId: string;
  studentName: string;
  effectiveStartDate: string; // YYYY-MM-DD
  effectiveEndDate?: string | null; // YYYY-MM-DD
  faceRegistrationState: 'UNREGISTERED' | 'PENDING' | 'REGISTERED';
  cachedAt?: string;
}

export interface CachedEmbedding {
  studentUserId: string;
  modelVersion: string;
  embeddingDimension: number;
  embeddingBlob: Uint8Array | string;
  sampleIndex?: number;
  galleryVersion: number;
}

export class RosterRepository {
  /**
   * Sync assignment roster from backend and store in local SQLite.
   */
  static async syncAssignmentRoster(
    teachingAssignmentId: string,
    authToken: string,
    sessionDate?: string
  ): Promise<CachedStudent[]> {
    const today = sessionDate || new Date().toISOString().split('T')[0];
    const url = `${API_BASE_URL}/api/v1/faculty/assignments/${teachingAssignmentId}/roster?session_date=${today}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${authToken}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch roster: ${res.status}`);
    }
    const data = await res.json();
    const students = data.eligible_students.map((s: any) => ({
      studentUserId: s.student_user_id,
      institutionalId: s.institutional_id,
      studentName: s.student_name,
      effectiveStartDate: s.effective_start_date,
      effectiveEndDate: s.effective_end_date ?? null,
      faceRegistrationState: s.face_registration_state,
    }));
    await RosterRepository.saveCachedRoster(teachingAssignmentId, students);
    return await RosterRepository.getCachedRoster(teachingAssignmentId);
  }

  /**
   * Save or update roster students in local SQLite storage.
   */
  static async saveCachedRoster(
    teachingAssignmentId: string,
    students: Omit<CachedStudent, 'teachingAssignmentId' | 'cachedAt'>[]
  ): Promise<void> {
    const db = await resolveDb();
    const nowIso = new Date().toISOString();

    await db.withTransactionAsync(async () => {
      // Clear existing records for this assignment
      await db.runAsync(
        'DELETE FROM cached_rosters WHERE teaching_assignment_id = ?;',
        [teachingAssignmentId]
      );

      for (const s of students) {
        await db.runAsync(
          `INSERT INTO cached_rosters (
            teaching_assignment_id, student_user_id, institutional_id, student_name,
            effective_start_date, effective_end_date, face_registration_state, cached_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            teachingAssignmentId,
            s.studentUserId,
            s.institutionalId,
            s.studentName,
            s.effectiveStartDate,
            s.effectiveEndDate ?? null,
            s.faceRegistrationState,
            nowIso,
          ]
        );
      }
    });
  }

  /**
   * Get eligible students from cached roster, optionally bounded by session date.
   */
  static async getCachedRoster(
    teachingAssignmentId: string,
    onDate?: string
  ): Promise<CachedStudent[]> {
    const db = await resolveDb();
    let query = `
      SELECT
        teaching_assignment_id,
        student_user_id,
        institutional_id,
        student_name,
        effective_start_date,
        effective_end_date,
        face_registration_state,
        cached_at
      FROM cached_rosters
      WHERE teaching_assignment_id = ?
    `;
    const params: (string | null)[] = [teachingAssignmentId];

    if (onDate) {
      query += ` AND effective_start_date <= ? AND (effective_end_date IS NULL OR effective_end_date >= ?)`;
      params.push(onDate, onDate);
    }

    query += ' ORDER BY student_name ASC;';

    const rows = await db.getAllAsync<any>(query, params);
    return rows.map((r) => ({
      teachingAssignmentId: r.teaching_assignment_id,
      studentUserId: r.student_user_id,
      institutionalId: r.institutional_id,
      studentName: r.student_name,
      effectiveStartDate: r.effective_start_date,
      effectiveEndDate: r.effective_end_date,
      faceRegistrationState: r.face_registration_state,
      cachedAt: r.cached_at,
    }));
  }

  /**
   * Return count of cached students for an assignment.
   */
  static async getCachedCount(teachingAssignmentId: string): Promise<number> {
    const db = await resolveDb();
    const result = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM cached_rosters WHERE teaching_assignment_id = ?;',
      [teachingAssignmentId]
    );
    return result?.count ?? 0;
  }

  /**
   * Delete cached roster for an assignment.
   */
  static async clearCachedRoster(teachingAssignmentId: string): Promise<void> {
    const db = await resolveDb();
    await db.runAsync('DELETE FROM cached_rosters WHERE teaching_assignment_id = ?;', [
      teachingAssignmentId,
    ]);
  }

  /**
   * Transactionally replace cached embeddings for an assignment's student population.
   * Ensures that revoked, transferred, or deleted student templates are purged atomically
   * and that partial failures rollback completely without leaving stale or partial state.
   */
  static async replaceAssignmentGallery(
    freshEmbeddings: CachedEmbedding[],
    affectedStudentIds: string[]
  ): Promise<void> {
    const db = await resolveDb();

    await db.withTransactionAsync(async () => {
      // 1. Purge previous embeddings for all students associated with this assignment
      if (affectedStudentIds.length > 0) {
        const placeholders = affectedStudentIds.map(() => '?').join(', ');
        await db.runAsync(
          `DELETE FROM cached_embeddings WHERE student_user_id IN (${placeholders});`,
          affectedStudentIds
        );
      }

      // 2. Insert fresh templates
      for (const emb of freshEmbeddings) {
        await db.runAsync(
          `INSERT OR REPLACE INTO cached_embeddings (
            student_user_id, model_version, embedding_dimension,
            embedding_blob, sample_index, gallery_version
          ) VALUES (?, ?, ?, ?, ?, ?);`,
          [
            emb.studentUserId,
            emb.modelVersion,
            emb.embeddingDimension,
            emb.embeddingBlob,
            emb.sampleIndex ?? 0,
            emb.galleryVersion,
          ]
        );
      }
    });
  }

  /**
   * T039: Save or update reference facial embeddings locally for permitted students.
   * Devices only store embeddings for students in their assigned teaching sections.
   */
  static async saveCachedEmbeddings(embeddings: CachedEmbedding[]): Promise<void> {
    if (!embeddings || embeddings.length === 0) return;
    const db = await resolveDb();

    await db.withTransactionAsync(async () => {
      for (const emb of embeddings) {
        await db.runAsync(
          `INSERT OR REPLACE INTO cached_embeddings (
            student_user_id, model_version, embedding_dimension,
            embedding_blob, sample_index, gallery_version
          ) VALUES (?, ?, ?, ?, ?, ?);`,
          [
            emb.studentUserId,
            emb.modelVersion,
            emb.embeddingDimension,
            emb.embeddingBlob,
            emb.sampleIndex ?? 0,
            emb.galleryVersion,
          ]
        );
      }
    });
  }

  /**
   * T039: Retrieve cached reference embeddings strictly scoped to permitted students.
   * Enforces Level 2 boundary: recognition pipeline queries only permitted cohort gallery.
   */
  static async getCachedEmbeddingsForStudents(
    studentUserIds: string[],
    modelVersion?: string
  ): Promise<CachedEmbedding[]> {
    if (!studentUserIds || studentUserIds.length === 0) return [];
    const db = await resolveDb();

    const placeholders = studentUserIds.map(() => '?').join(', ');
    let query = `
      SELECT
        student_user_id,
        model_version,
        embedding_dimension,
        embedding_blob,
        sample_index,
        gallery_version
      FROM cached_embeddings
      WHERE student_user_id IN (${placeholders})
    `;
    const params: (string | number)[] = [...studentUserIds];

    if (modelVersion) {
      query += ` AND model_version = ?`;
      params.push(modelVersion);
    }

    query += ' ORDER BY student_user_id, sample_index ASC;';

    const rows = await db.getAllAsync<any>(query, params);
    return rows.map((r) => ({
      studentUserId: r.student_user_id,
      modelVersion: r.model_version,
      embeddingDimension: r.embedding_dimension,
      embeddingBlob: r.embedding_blob,
      sampleIndex: r.sample_index,
      galleryVersion: r.gallery_version,
    }));
  }

  /**
   * Remove cached embeddings for specified student IDs (e.g., when student transfers out).
   */
  static async clearCachedEmbeddingsForStudents(studentUserIds: string[]): Promise<void> {
    if (!studentUserIds || studentUserIds.length === 0) return;
    const db = await resolveDb();
    const placeholders = studentUserIds.map(() => '?').join(', ');
    await db.runAsync(
      `DELETE FROM cached_embeddings WHERE student_user_id IN (${placeholders});`,
      studentUserIds
    );
  }

  /**
   * Return count of all cached embeddings on device.
   */
  static async getCachedEmbeddingCount(): Promise<number> {
    const db = await resolveDb();
    const result = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM cached_embeddings;'
    );
    return result?.count ?? 0;
  }
}

