/**
 * Gallery Synchronization & Offline Storage Bridge
 * Milestone: Production Biometric Enrollment & Device Synchronization
 *
 * Synchronizes authorized facial biometric templates from the backend
 * into mobile local SQLite storage (cached_embeddings) and constructs
 * session-scoped in-memory galleries for real-time edge face matching.
 */

import type { AttendanceSessionScope, StudentReferenceProfile } from './contracts.ts';
import { SessionScopedFaceGallery } from '../lab/adapters/gallery/SessionScopedGallery.ts';
import type { CachedEmbedding } from '../storage/rosterRepository.ts';
import { RosterRepository } from '../storage/rosterRepository.ts';
import { API_BASE_URL } from '../config/api.ts';

export interface BackendGalleryTemplate {
  student_user_id: string;
  institutional_id: string;
  student_name: string;
  embedding_base64: string;
  model_version: string;
  quality_score: number;
  updated_at: string;
}

export interface BackendGalleryResponse {
  teaching_assignment_id: string;
  class_section_id: string;
  academic_term_id: string;
  gallery_version: string;
  template_count: number;
  templates: BackendGalleryTemplate[];
}

export interface GallerySyncResult {
  success: boolean;
  galleryVersion: string;
  templateCount: number;
  isFresh: boolean;
  error?: string;
}

/**
 * Decode a base64-encoded float32 vector to a typed Float32Array.
 */
export function base64ToFloat32Array(base64Str: string): Float32Array {
  const gBuffer = (globalThis as any).Buffer;
  if (gBuffer) {
    const buf = gBuffer.from(base64Str, 'base64');
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  } else if (typeof atob === 'function') {
    const binaryStr = atob(base64Str);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  } else {
    throw new Error('No base64 decoding mechanism available');
  }
}

/**
 * Encode a Float32Array to base64 string.
 */
export function float32ArrayToBase64(floatArray: Float32Array): string {
  const gBuffer = (globalThis as any).Buffer;
  if (gBuffer) {
    const buf = gBuffer.from(floatArray.buffer, floatArray.byteOffset, floatArray.byteLength);
    return buf.toString('base64');
  } else if (typeof btoa === 'function') {
    const bytes = new Uint8Array(floatArray.buffer, floatArray.byteOffset, floatArray.byteLength);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  } else {
    throw new Error('No base64 encoding mechanism available');
  }
}

export class GallerySyncService {
  /**
   * Fetch authorized gallery from backend for teaching assignment and persist into SQLite.
   */
  static async syncAssignmentGallery(
    teachingAssignmentId: string,
    authToken: string,
    options?: {
      sessionDate?: string;
      baseUrl?: string;
      customFetch?: typeof fetch;
      customPersist?: (templates: BackendGalleryTemplate[], versionInt: number) => Promise<void>;
    }
  ): Promise<GallerySyncResult> {
    const baseUrl = options?.baseUrl || API_BASE_URL;
    const fetchFn = options?.customFetch || fetch;

    let url = `${baseUrl}/api/v1/faculty/assignments/${teachingAssignmentId}/gallery`;
    if (options?.sessionDate) {
      url += `?session_date=${encodeURIComponent(options.sessionDate)}`;
    }

    try {
      const response = await fetchFn(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${authToken}`,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          galleryVersion: '',
          templateCount: 0,
          isFresh: false,
          error: `HTTP ${response.status}: ${errorText}`,
        };
      }

      const data: BackendGalleryResponse = await response.json();
      const versionInt = parseInt(data.gallery_version.slice(0, 8), 16) || 1;

      if (options?.customPersist) {
        await options.customPersist(data.templates, versionInt);
      } else {
        // Map backend templates to local SQLite CachedEmbedding records
        const cachedEmbeddings: CachedEmbedding[] = data.templates.map((tpl) => {
          // Derive dimension from base64 length: length / 4 * 3 / 4 bytes
          const rawFloats = base64ToFloat32Array(tpl.embedding_base64);
          return {
            studentUserId: tpl.student_user_id,
            modelVersion: tpl.model_version,
            embeddingDimension: rawFloats.length,
            embeddingBlob: tpl.embedding_base64, // Stored as base64 string in SQLite
            sampleIndex: tpl.sample_index ?? 0,
            galleryVersion: versionInt,
          };
        });

        // Retrieve cached roster for this assignment to identify the full cohort of affected students
        const cachedRoster = await RosterRepository.getCachedRoster(teachingAssignmentId);
        const affectedStudentIds = cachedRoster.map((s) => s.studentUserId);

        // Ensure any newly added student in backend gallery is also in the affected set
        for (const tpl of data.templates) {
          if (!affectedStudentIds.includes(tpl.student_user_id)) {
            affectedStudentIds.push(tpl.student_user_id);
          }
        }

        // Execute transactional replacement: purges revoked/stale students and upserts fresh templates
        await RosterRepository.replaceAssignmentGallery(cachedEmbeddings, affectedStudentIds);
      }

      return {
        success: true,
        galleryVersion: data.gallery_version,
        templateCount: data.template_count,
        isFresh: true,
      };
    } catch (err: any) {
      return {
        success: false,
        galleryVersion: '',
        templateCount: 0,
        isFresh: false,
        error: err.message || 'Unknown network error during gallery sync',
      };
    }
  }

  /**
   * Load stored embeddings from SQLite and construct an in-memory SessionScopedFaceGallery.
   */
  static async loadSessionScopedGallery(
    sessionScope: AttendanceSessionScope,
    studentUserIds: string[],
    modelVersion: string = 'EdgeFace-XS-v1'
  ): Promise<SessionScopedFaceGallery> {
    const gallery = new SessionScopedFaceGallery();

    if (!studentUserIds || studentUserIds.length === 0) {
      gallery.initialize(sessionScope, []);
      return gallery;
    }

    const cached = await RosterRepository.getCachedEmbeddingsForStudents(
      studentUserIds,
      modelVersion
    );

    // Group by studentUserId
    const profileMap = new Map<string, Float32Array[]>();
    let detectedDim = 512;
    let galleryVer = 1;

    for (const item of cached) {
      if (!profileMap.has(item.studentUserId)) {
        profileMap.set(item.studentUserId, []);
      }
      const floats =
        typeof item.embeddingBlob === 'string'
          ? base64ToFloat32Array(item.embeddingBlob)
          : new Float32Array(
              item.embeddingBlob.buffer,
              item.embeddingBlob.byteOffset,
              item.embeddingBlob.byteLength / 4
            );
      profileMap.get(item.studentUserId)!.push(floats);
      detectedDim = item.embeddingDimension;
      galleryVer = item.galleryVersion;
    }

    // Look up cached roster metadata for student names & institutional IDs
    const rosterMap = new Map<string, { institutionalId: string; studentName: string }>();
    if (sessionScope.courseOfferingId) {
      try {
        const cachedRoster = await RosterRepository.getCachedRoster(sessionScope.courseOfferingId);
        for (const s of cachedRoster) {
          rosterMap.set(s.studentUserId, {
            institutionalId: s.institutionalId,
            studentName: s.studentName,
          });
        }
      } catch {
        // Fallback silently if roster retrieval fails
      }
    }

    const profiles: StudentReferenceProfile[] = [];
    for (const [studentId, embeddings] of profileMap.entries()) {
      const studentInfo = rosterMap.get(studentId);
      profiles.push({
        studentUserId: studentId,
        institutionalId: studentInfo?.institutionalId || '',
        studentName: studentInfo?.studentName || '',
        modelName: modelVersion.startsWith('EdgeFace') ? 'EdgeFace-XS' : 'MobileFaceNet',
        activeModelVersion: modelVersion,
        embeddingDimension: detectedDim,
        normalization: 'L2',
        alignmentMode: 'SIMILARITY_TRANSFORM_5PT',
        embeddings: embeddings,
      });
    }

    gallery.initialize(sessionScope, profiles, galleryVer);
    return gallery;
  }
}
