/**
 * Cosine Gallery Matcher Implementation (Step F)
 * Feature: Isolated ML Laboratory / Perception Spike
 *
 * Implements Notion Section 3, 4, 23.5, 23.7 & Step F Matching Rules:
 * - Cosine similarity (dot product of L2 unit-normalized vectors).
 * - Aggregates multiple reference samples by student identity (student-level aggregation).
 * - Identifies Top-1 student and Top-2 *different* student to prevent false ambiguity from multi-sample enrollment.
 * - Computes separation margin Delta = Top-1 - Top-2 (null when N=1).
 * - Explicit match outcome states: MATCHED, AMBIGUOUS, UNMATCHED, INVALID.
 * - Enforces model compatibility verification (manifest).
 * - Strictly isolated from attendance domain logic (never creates attendance records).
 */

import type {
  IFaceGallery,
  IFaceMatcher,
  IdentityMatch,
  MatchOutcomeState,
  ModelManifest,
  PermittedStudentGallery,
  StudentReferenceProfile,
} from '../../../perception/contracts';
import { SessionScopedFaceGallery } from '../gallery/SessionScopedGallery.ts';

export interface MatcherMetrics {
  totalComparisons: number;
  uniqueStudentsEvaluated: number;
  top1Score: number;
  top2Score: number | null;
  margin: number | null;
  matchState: MatchOutcomeState;
  latencyMs: number;
}

interface StudentMaxScore {
  profile: StudentReferenceProfile;
  maxScore: number;
  bestVectorIndex: number;
}

export class CosineGalleryMatcher implements IFaceMatcher {
  public lastMetrics: MatcherMetrics | null = null;

  /**
   * Computes dot product of two unit-normalized Float32Array vectors.
   * If both are L2 unit-normalized, dot product equals cosine similarity in [-1, 1].
   */
  public static cosineSimilarity(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      throw new Error(`Embedding dimension mismatch: ${a.length} vs ${b.length}`);
    }
    let dot = 0.0;
    let normA = 0.0;
    let normB = 0.0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0.0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Matches candidate embedding against the permitted session gallery.
   * Aggregates reference embeddings per student, finds Top-1 and Top-2 different students,
   * calculates margin, and outputs explicit match state.
   */
  public findMatch(
    candidateEmbedding: Float32Array,
    gallery: IFaceGallery | PermittedStudentGallery,
    similarityThreshold: number = 0.65,
    marginThreshold: number = 0.10,
    activeModelManifest?: ModelManifest
  ): IdentityMatch {
    const startTime = performance.now();

    // 1. Validate candidate embedding
    if (!candidateEmbedding || !(candidateEmbedding instanceof Float32Array) || candidateEmbedding.length === 0) {
      return this.createInvalidResult('INVALID_CANDIDATE_EMBEDDING', startTime);
    }

    // 2. Extract profiles from gallery
    let profiles: StudentReferenceProfile[] = [];
    if (gallery instanceof SessionScopedFaceGallery || (gallery && typeof (gallery as IFaceGallery).getEligibleProfiles === 'function')) {
      const faceGallery = gallery as IFaceGallery;

      // Model compatibility check if manifest provided
      if (activeModelManifest) {
        const compat = faceGallery.validateCompatibility(activeModelManifest);
        if (!compat.isCompatible) {
          return this.createInvalidResult(
            `INCOMPATIBLE_GALLERY: ${compat.diagnosticReason || 'Model mismatch'}`,
            startTime
          );
        }
      }

      profiles = faceGallery.getEligibleProfiles();
    } else if (gallery && (gallery as PermittedStudentGallery).profiles) {
      profiles = Array.from((gallery as PermittedStudentGallery).profiles.values());
    }

    // 3. Handle empty gallery (N = 0)
    if (!profiles || profiles.length === 0) {
      return this.createInvalidResult('EMPTY_GALLERY', startTime);
    }

    // 4. Validate vector dimension consistency across gallery
    const queryDim = candidateEmbedding.length;
    for (const profile of profiles) {
      if (profile.embeddingDimension && profile.embeddingDimension !== queryDim) {
        return this.createInvalidResult(
          `Dimension mismatch: Candidate has ${queryDim}-D, gallery has ${profile.embeddingDimension}-D`,
          startTime
        );
      }
      for (const vec of profile.embeddings) {
        if (!vec || vec.length !== queryDim) {
          return this.createInvalidResult(
            `Embedding dimension mismatch: Candidate has ${queryDim}-D, reference has ${vec?.length}-D`,
            startTime
          );
        }
      }
    }

    // 5. Aggregate comparisons by Student Identity
    let totalComparisons = 0;
    const studentScores: StudentMaxScore[] = [];

    for (const profile of profiles) {
      let maxScore = -1.0;
      let bestIdx = 0;

      for (let i = 0; i < profile.embeddings.length; i++) {
        totalComparisons++;
        const score = CosineGalleryMatcher.cosineSimilarity(candidateEmbedding, profile.embeddings[i]);
        if (score > maxScore) {
          maxScore = score;
          bestIdx = i;
        }
      }

      studentScores.push({
        profile,
        maxScore,
        bestVectorIndex: bestIdx,
      });
    }

    // 6. Rank students descending by maximum similarity
    studentScores.sort((a, b) => b.maxScore - a.maxScore);

    const top1 = studentScores[0];
    const top2 = studentScores.length > 1 ? studentScores[1] : null;

    // 7. Calculate Top-1 / Top-2 Different-Student Margin
    let margin: number | null = null;
    if (top2 !== null) {
      margin = top1.maxScore - top2.maxScore;
    }

    // 8. Outcome State Logic
    const meetsThreshold = top1.maxScore >= similarityThreshold;
    let matchState: MatchOutcomeState;
    let isConfident = false;
    let diagnosticReason: string | undefined;

    if (!meetsThreshold) {
      matchState = 'UNMATCHED';
      diagnosticReason = `Similarity ${top1.maxScore.toFixed(3)} is below threshold ${similarityThreshold.toFixed(2)}`;
    } else if (top2 !== null && margin !== null && margin < marginThreshold) {
      matchState = 'AMBIGUOUS';
      diagnosticReason = `Top-1 (${top1.maxScore.toFixed(3)}) and Top-2 (${top2.maxScore.toFixed(3)}) separation ${margin.toFixed(3)} is below margin threshold ${marginThreshold.toFixed(2)}`;
    } else {
      matchState = 'MATCHED';
      isConfident = true;
    }

    const elapsedMs = performance.now() - startTime;
    this.lastMetrics = {
      totalComparisons,
      uniqueStudentsEvaluated: studentScores.length,
      top1Score: top1.maxScore,
      top2Score: top2 ? top2.maxScore : null,
      margin,
      matchState,
      latencyMs: elapsedMs,
    };

    return {
      studentUserId: matchState === 'UNMATCHED' ? null : top1.profile.studentUserId,
      institutionalId: matchState === 'UNMATCHED' ? null : top1.profile.institutionalId,
      studentName: matchState === 'UNMATCHED' ? null : top1.profile.studentName,
      similarityScore: top1.maxScore,
      top2StudentUserId: top2 ? top2.profile.studentUserId : null,
      top2SimilarityScore: top2 ? top2.maxScore : null,
      top2Margin: margin,
      matchState,
      isConfident,
      diagnosticReason,
    };
  }

  private createInvalidResult(reason: string, startTime: number): IdentityMatch {
    const elapsedMs = performance.now() - startTime;
    this.lastMetrics = {
      totalComparisons: 0,
      uniqueStudentsEvaluated: 0,
      top1Score: -1.0,
      top2Score: null,
      margin: null,
      matchState: 'INVALID',
      latencyMs: elapsedMs,
    };

    return {
      studentUserId: null,
      institutionalId: null,
      studentName: null,
      similarityScore: -1.0,
      top2StudentUserId: null,
      top2SimilarityScore: null,
      top2Margin: null,
      matchState: 'INVALID',
      isConfident: false,
      diagnosticReason: reason,
    };
  }
}
