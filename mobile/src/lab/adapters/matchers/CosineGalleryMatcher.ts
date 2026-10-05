/**
 * Cosine Gallery Matcher Implementation
 * Feature: Isolated ML Laboratory / Perception Spike
 *
 * Implements Notion Section 3 & 4 and Phase 6 matching rules:
 * - Computes inner product / cosine similarity between normalized embeddings
 * - Evaluates top-1 candidate match
 * - Evaluates top-2 candidate ambiguity margin (delta >= marginThreshold)
 * - Retains thresholds as configurable runtime parameters
 */

import {
  IFaceMatcher,
  IdentityMatch,
  PermittedStudentGallery,
  StudentReferenceProfile,
} from '../../../perception/contracts';

export interface MatcherMetrics {
  totalComparisons: number;
  top1Score: number;
  top2Score: number;
  margin: number;
  evaluatedStudentsCount: number;
}

export class CosineGalleryMatcher implements IFaceMatcher {
  public lastMetrics: MatcherMetrics | null = null;

  /**
   * Computes dot product of two unit-normalized Float32Array vectors.
   * If both are unit-normalized (l2 norm = 1), dot product equals cosine similarity.
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
   * Matches candidate embedding against the permitted student gallery.
   */
  public findMatch(
    candidateEmbedding: Float32Array,
    gallery: PermittedStudentGallery,
    similarityThreshold: number = 0.65,
    marginThreshold: number = 0.10
  ): IdentityMatch | null {
    if (!gallery.profiles || gallery.profiles.size === 0) {
      return null;
    }

    let top1Profile: StudentReferenceProfile | null = null;
    let top1Score = -1.0;

    let top2Profile: StudentReferenceProfile | null = null;
    let top2Score = -1.0;

    let totalComparisons = 0;

    for (const [studentId, profile] of gallery.profiles.entries()) {
      // Find max similarity across all reference observations for this student
      let studentMaxScore = -1.0;
      for (const refEmbedding of profile.embeddings) {
        totalComparisons++;
        const score = CosineGalleryMatcher.cosineSimilarity(candidateEmbedding, refEmbedding);
        if (score > studentMaxScore) {
          studentMaxScore = score;
        }
      }

      if (studentMaxScore > top1Score) {
        top2Score = top1Score;
        top2Profile = top1Profile;
        top1Score = studentMaxScore;
        top1Profile = profile;
      } else if (studentMaxScore > top2Score) {
        top2Score = studentMaxScore;
        top2Profile = profile;
      }
    }

    const margin = top2Score > -1.0 ? top1Score - top2Score : 1.0;

    this.lastMetrics = {
      totalComparisons,
      top1Score,
      top2Score: top2Score > -1.0 ? top2Score : 0.0,
      margin,
      evaluatedStudentsCount: gallery.profiles.size,
    };

    if (!top1Profile) {
      return null;
    }

    const meetsThreshold = top1Score >= similarityThreshold;
    const meetsMargin = margin >= marginThreshold;
    const isConfident = meetsThreshold && meetsMargin;

    if (!meetsThreshold) {
      return null;
    }

    return {
      studentUserId: top1Profile.studentUserId,
      institutionalId: top1Profile.institutionalId,
      studentName: top1Profile.studentName,
      similarityScore: top1Score,
      top2Margin: margin,
      isConfident,
    };
  }
}
