/**
 * Temporal Confirmation Buffer Implementation (Step F)
 * Feature: Isolated ML Laboratory / Perception Spike
 *
 * Implements Notion Section 4, 12, 15 & Step F Temporal Gating:
 * - Operates STRICTLY on fresh recognition observations (not 30 FPS tracking ticks).
 * - Filters accidental single-frame false matches by requiring consecutive, consistent candidate identities.
 * - Enforces candidate identity consistency, similarity stability, and acceptable quality (GOOD / FAIR).
 * - Temporary POOR quality freezes confirmation progress without destroying track state.
 */

import type {
  IdentityMatch,
  QualityAssessment,
  RecognitionCandidate,
} from '../../../perception/contracts';

export interface TemporalConfirmationConfig {
  minConsecutiveConfirmations?: number; // e.g. 3 consecutive observations
  maxSimilarityVariance?: number; // max allowable similarity deviation across observations (e.g. 0.10)
  maxObservationIntervalMs?: number; // max time gap before candidate continuity expires (e.g. 3000 ms)
}

interface TrackConfirmationState {
  trackId: number;
  candidateUserId: string | null;
  consecutiveConfirmations: number;
  lastObservationTimeMs: number;
  similarityScores: number[];
  lastMatch: IdentityMatch;
}

export class TemporalConfirmationBuffer {
  private config: Required<TemporalConfirmationConfig>;
  private states: Map<number, TrackConfirmationState> = new Map();

  constructor(config: TemporalConfirmationConfig = {}) {
    this.config = {
      minConsecutiveConfirmations: config.minConsecutiveConfirmations ?? 3,
      maxSimilarityVariance: config.maxSimilarityVariance ?? 0.10,
      maxObservationIntervalMs: config.maxObservationIntervalMs ?? 3000,
    };
  }

  /**
   * Evaluates a fresh recognition observation for an active track.
   * STRICT REQUIREMENT: Only called when a new neural embedding matching result is produced!
   */
  public update(
    trackId: number,
    match: IdentityMatch,
    quality: QualityAssessment | { state: string; score: number },
    timestampMs: number
  ): RecognitionCandidate {
    let state = this.states.get(trackId);

    // If observation quality is POOR, freeze confirmation progress without destroying track
    if (quality.state === 'POOR') {
      return {
        trackId,
        match,
        qualityScore: quality.score,
        detectedAtMs: timestampMs,
        consecutiveConfirmations: state ? state.consecutiveConfirmations : 0,
        isConfirmed: false,
      };
    }

    // If match is not a confident MATCHED state (e.g. AMBIGUOUS, UNMATCHED, INVALID), reset confirmations
    if (match.matchState !== 'MATCHED' || !match.studentUserId) {
      if (state) {
        state.candidateUserId = null;
        state.consecutiveConfirmations = 0;
        state.similarityScores = [];
      }
      return {
        trackId,
        match,
        qualityScore: quality.score,
        detectedAtMs: timestampMs,
        consecutiveConfirmations: 0,
        isConfirmed: false,
      };
    }

    // If track is new or candidate identity changed, reset to 1
    if (!state || state.candidateUserId !== match.studentUserId) {
      state = {
        trackId,
        candidateUserId: match.studentUserId,
        consecutiveConfirmations: 1,
        lastObservationTimeMs: timestampMs,
        similarityScores: [match.similarityScore],
        lastMatch: match,
      };
      this.states.set(trackId, state);

      return {
        trackId,
        match,
        qualityScore: quality.score,
        detectedAtMs: timestampMs,
        consecutiveConfirmations: 1,
        isConfirmed: 1 >= this.config.minConsecutiveConfirmations,
      };
    }

    // If time gap between observations exceeds timeout, reset sequence
    const timeDelta = timestampMs - state.lastObservationTimeMs;
    if (timeDelta > this.config.maxObservationIntervalMs) {
      state.consecutiveConfirmations = 1;
      state.similarityScores = [match.similarityScore];
      state.lastObservationTimeMs = timestampMs;
      state.lastMatch = match;

      return {
        trackId,
        match,
        qualityScore: quality.score,
        detectedAtMs: timestampMs,
        consecutiveConfirmations: 1,
        isConfirmed: 1 >= this.config.minConsecutiveConfirmations,
      };
    }

    // Check similarity stability against running mean
    const meanScore =
      state.similarityScores.reduce((sum, s) => sum + s, 0) / state.similarityScores.length;
    const scoreDiff = Math.abs(match.similarityScore - meanScore);

    if (scoreDiff <= this.config.maxSimilarityVariance) {
      state.consecutiveConfirmations += 1;
      state.similarityScores.push(match.similarityScore);
    } else {
      // Large sudden jump in similarity: restart confirmation sequence
      state.consecutiveConfirmations = 1;
      state.similarityScores = [match.similarityScore];
    }

    state.lastObservationTimeMs = timestampMs;
    state.lastMatch = match;

    const isConfirmed = state.consecutiveConfirmations >= this.config.minConsecutiveConfirmations;

    return {
      trackId,
      match,
      qualityScore: quality.score,
      detectedAtMs: timestampMs,
      consecutiveConfirmations: state.consecutiveConfirmations,
      isConfirmed,
    };
  }

  public resetTrack(trackId: number): void {
    this.states.delete(trackId);
  }

  public resetAll(): void {
    this.states.clear();
  }
}
