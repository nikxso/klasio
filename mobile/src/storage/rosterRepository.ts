import { getDatabase } from '@/storage/database';

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
   * Save or update roster students in local SQLite storage.
   */
  static async saveCachedRoster(
    teachingAssignmentId: string,
    students: Omit<CachedStudent, 'teachingAssignmentId' | 'cachedAt'>[]
  ): Promise<void> {
    const db = await getDatabase();
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
    const db = await getDatabase();
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
    const db = await getDatabase();
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
    const db = await getDatabase();
    await db.runAsync('DELETE FROM cached_rosters WHERE teaching_assignment_id = ?;', [
      teachingAssignmentId,
    ]);
  }

  /**
   * T039: Save or update reference facial embeddings locally for permitted students.
   * Devices only store embeddings for students in their assigned teaching sections.
   */
  static async saveCachedEmbeddings(embeddings: CachedEmbedding[]): Promise<void> {
    if (!embeddings || embeddings.length === 0) return;
    const db = await getDatabase();

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
    const db = await getDatabase();

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
    const db = await getDatabase();
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
    const db = await getDatabase();
    const result = await db.getFirstAsync<{ count: number }>(
      'SELECT COUNT(*) as count FROM cached_embeddings;'
    );
    return result?.count ?? 0;
  }
}

