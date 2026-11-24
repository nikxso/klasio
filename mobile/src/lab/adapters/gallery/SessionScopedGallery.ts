/**
 * Session-Scoped Face Gallery Implementation (Step F)
 * Feature: Isolated ML Laboratory / Perception Pipeline
 *
 * Implements Constitution Principle IV & Notion Section 4, 7, 23.5, 23.7:
 * - Scoped strictly to the active attendance session context (session/class/section/subject).
 * - Stores authorized student reference profiles in-memory.
 * - Supports multiple reference embeddings per student profile (for Step H guided enrollment).
 * - Enforces model compatibility verification (Model V1 + Preprocessing V1 + Alignment V1).
 * - Strictly rejects incompatible or out-of-scope biometric profiles.
 */

import type {
  AttendanceSessionScope,
  IFaceGallery,
  ModelCompatibilityResult,
  ModelManifest,
  StudentReferenceProfile,
} from '../../../perception/contracts';

export class SessionScopedFaceGallery implements IFaceGallery {
  private _sessionScope: AttendanceSessionScope | null = null;
  private _galleryVersion: number = 1;
  private _profiles: Map<string, StudentReferenceProfile> = new Map();

  public get sessionScope(): AttendanceSessionScope | null {
    return this._sessionScope;
  }

  public get galleryVersion(): number {
    return this._galleryVersion;
  }

  public get size(): number {
    return this._profiles.size;
  }

  public get totalEmbeddings(): number {
    let count = 0;
    for (const profile of this._profiles.values()) {
      count += profile.embeddings.length;
    }
    return count;
  }

  /**
   * Initializes the in-memory gallery bound strictly to the given attendance session scope.
   */
  public initialize(
    sessionScope: AttendanceSessionScope,
    profiles: StudentReferenceProfile[],
    galleryVersion: number = 1
  ): void {
    if (!sessionScope || !sessionScope.attendanceSessionId) {
      throw new Error('Cannot initialize gallery without a valid attendanceSessionId');
    }

    this._sessionScope = sessionScope;
    this._galleryVersion = galleryVersion;
    this._profiles.clear();

    for (const profile of profiles) {
      if (!profile.studentUserId) {
        continue;
      }
      this._profiles.set(profile.studentUserId, profile);
    }
  }

  /**
   * Validates that all reference embeddings in the gallery are strictly compatible
   * with the active face embedder model manifest.
   *
   * Invariant: Model V1 + Preprocessing V1 + Alignment V1 = Compatible Embedding Format V1.
   */
  public validateCompatibility(manifest: ModelManifest): ModelCompatibilityResult {
    if (this._profiles.size === 0) {
      return {
        isCompatible: true, // Empty gallery is trivial
      };
    }

    for (const [studentId, profile] of this._profiles.entries()) {
      if (profile.modelName !== manifest.modelName) {
        return {
          isCompatible: false,
          mismatchedField: 'modelName',
          diagnosticReason: `Model mismatch for student ${studentId}: Gallery uses '${profile.modelName}' while active embedder is '${manifest.modelName}'.`,
        };
      }

      // Check activeModelVersion compatibility: EdgeFace-XS-v1 and gamma_0.6 are canonical EdgeFace-XS representations
      const isVersionMatch =
        profile.activeModelVersion === manifest.modelVersion ||
        ((profile.activeModelVersion === 'EdgeFace-XS-v1' || profile.activeModelVersion === 'gamma_0.6') &&
         (manifest.modelVersion === 'EdgeFace-XS-v1' || manifest.modelVersion === 'gamma_0.6'));

      if (!isVersionMatch) {
        return {
          isCompatible: false,
          mismatchedField: 'activeModelVersion',
          diagnosticReason: `Model version mismatch for student ${studentId}: Gallery uses '${profile.activeModelVersion}' vs active '${manifest.modelVersion}'.`,
        };
      }

      if (profile.embeddingDimension !== manifest.embeddingDimension) {
        return {
          isCompatible: false,
          mismatchedField: 'embeddingDimension',
          diagnosticReason: `Dimension mismatch for student ${studentId}: Gallery is ${profile.embeddingDimension}-D vs active ${manifest.embeddingDimension}-D.`,
        };
      }

      // Check normalization compatibility:
      // Accepts manifest.normalization directly, or accepts 'L2' / 'UNIT_L2' as valid unit embedding representation for EdgeFace
      const isNormMatch =
        profile.normalization === manifest.normalization ||
        ((profile.normalization === 'L2' || profile.normalization === 'UNIT_L2') &&
         manifest.normalization === 'MINUS_127_5_DIV_127_5');

      if (!isNormMatch) {
        return {
          isCompatible: false,
          mismatchedField: 'normalization',
          diagnosticReason: `Normalization mismatch for student ${studentId}: Gallery uses '${profile.normalization}' vs active '${manifest.normalization}'.`,
        };
      }

      if (profile.alignmentMode !== manifest.alignmentMode) {
        return {
          isCompatible: false,
          mismatchedField: 'alignmentMode',
          diagnosticReason: `Alignment mode mismatch for student ${studentId}: Gallery uses '${profile.alignmentMode}' vs active '${manifest.alignmentMode}'.`,
        };
      }

      // Check all embeddings vectors in this profile
      for (let i = 0; i < profile.embeddings.length; i++) {
        const vec = profile.embeddings[i];
        if (!vec || vec.length !== manifest.embeddingDimension) {
          return {
            isCompatible: false,
            mismatchedField: 'embeddingVectorDimension',
            diagnosticReason: `Corrupted vector at index ${i} for student ${studentId}: Length ${vec?.length} vs expected ${manifest.embeddingDimension}.`,
          };
        }
      }
    }

    return {
      isCompatible: true,
    };
  }

  /**
   * Returns all eligible student reference profiles in the current session gallery.
   */
  public getEligibleProfiles(): StudentReferenceProfile[] {
    return Array.from(this._profiles.values());
  }

  /**
   * Returns a specific student reference profile by studentUserId.
   */
  public getProfile(studentUserId: string): StudentReferenceProfile | undefined {
    return this._profiles.get(studentUserId);
  }

  /**
   * Disposes in-memory biometric data when session ends.
   */
  public clear(): void {
    this._profiles.clear();
    this._sessionScope = null;
    this._galleryVersion = 1;
  }
}
