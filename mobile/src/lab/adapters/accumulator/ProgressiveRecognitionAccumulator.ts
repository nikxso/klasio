/**
 * Progressive Classroom Recognition Accumulator Implementation (Step G)
 * Feature: Isolated ML Laboratory / Perception Spike
 *
 * Implements Constitution Principle IV & Notion Section 4, 12, 15, 23.10:
 * - Solves the progressive classroom scanning problem (camera panning across classroom regions).
 * - Accumulates recognized student candidates across the scanning session.
 * - Deduplicates entries strictly by studentUserId (unique institutional identity).
 * - Tolerates track replacement: student leaving frame and returning under new trackId merges cleanly.
 * - Filters false admissions via scanner motion stability heuristic (STABLE vs PANNING).
 * - Treats AMBIGUOUS, UNMATCHED, and INVALID matches as rejections.
 * - Freezes observation progression on temporary POOR quality without deleting established accumulated candidates.
 * - Preserves multi-face track independence across simultaneous tracks.
 * - HARD INVARIANT: Zero attendance logic. Terminates at AccumulatedRecognitionCandidate.
 */

import type {
  AccumulatedRecognitionCandidate,
  AccumulatorConfig,
  AccumulatorStats,
  IProgressiveRecognitionAccumulator,
  RecognitionCandidate,
  ScannerMotionConfig,
  ScannerMotionMetrics,
  ScannerStabilityState,
  TrackedFace,
} from '../../../perception/contracts';

interface Centroid {
  x: number;
  y: number;
}

export class ProgressiveRecognitionAccumulator implements IProgressiveRecognitionAccumulator {
  private accumulatedCandidates: Map<string, AccumulatedRecognitionCandidate> = new Map();

  private scannerMotionConfig: Required<ScannerMotionConfig>;
  private minConfirmationsForAdmission: number;

  private scannerMetrics: ScannerMotionMetrics;
  private stats: AccumulatorStats;

  private lastCentroids: Map<number, Centroid> = new Map();
  private lastTrackIds: Set<number> = new Set();
  private stableStartTimestampMs: number | null = null;
  private lastFrameTimestampMs: number = 0;

  constructor(config: AccumulatorConfig = {}) {
    const smc = config.scannerMotionConfig ?? {};
    this.scannerMotionConfig = {
      displacementPanningThreshold: smc.displacementPanningThreshold ?? 0.08,
      churnPanningThreshold: smc.churnPanningThreshold ?? 0.40,
      stabilizationRequiredMs: smc.stabilizationRequiredMs ?? 300,
    };
    this.minConfirmationsForAdmission = config.minConfirmationsForSessionAdmission ?? 2;

    this.scannerMetrics = {
      state: 'STABLE',
      meanDisplacement: 0.0,
      trackChurnRate: 0.0,
      stableDurationMs: 0,
      isAdmissionPermitted: true,
    };

    this.stats = {
      totalAccumulated: 0,
      totalMatchesProcessed: 0,
      totalDuplicatesMerged: 0,
      totalRejections: 0,
      activeTrackCount: 0,
      scannerState: 'STABLE',
    };
  }

  /**
   * Processes a batch of recognition candidates and tracked faces from the current frame.
   */
  public processFrameCandidates(
    candidates: RecognitionCandidate[],
    trackedFaces: TrackedFace[],
    timestampMs: number
  ): void {
    // 1. Update Scanner Motion & Stability
    this.updateScannerMotion(trackedFaces, timestampMs);

    // 2. Process Recognition Candidates
    for (const candidate of candidates) {
      const match = candidate.match;

      // Filter non-MATCHED outcomes (AMBIGUOUS, UNMATCHED, INVALID)
      if (!match || match.matchState !== 'MATCHED' || !match.studentUserId) {
        this.stats.totalRejections++;
        continue;
      }

      const studentUserId = match.studentUserId;
      const existing = this.accumulatedCandidates.get(studentUserId);

      // If observation is not confirmed (e.g. temporary POOR quality or unconfirmed sequence)
      if (!candidate.isConfirmed) {
        if (!existing) {
          // Reject initial unconfirmed admission
          this.stats.totalRejections++;
        }
        // If already established, freeze progression without deleting or updating
        continue;
      }

      // Candidate is confirmed MATCHED.
      // If student is new to accumulator, check if scanner admission is permitted
      if (!existing && !this.scannerMetrics.isAdmissionPermitted) {
        // Paused during rapid panning to prevent blur-induced false admissions
        this.stats.totalRejections++;
        continue;
      }

      this.stats.totalMatchesProcessed++;

      if (existing) {
        // Deduplicate and update existing accumulated candidate
        existing.totalObservations++;
        existing.lastSeenAtMs = Math.max(existing.lastSeenAtMs, candidate.detectedAtMs);
        existing.bestSimilarityScore = Math.max(existing.bestSimilarityScore, match.similarityScore);
        existing.bestQualityScore = Math.max(existing.bestQualityScore, candidate.qualityScore);
        if (match.top2Margin !== null && match.top2Margin !== undefined) {
          if (existing.bestMargin === null || match.top2Margin > existing.bestMargin) {
            existing.bestMargin = match.top2Margin;
          }
        }
        existing.lastTrackId = candidate.trackId;
        this.stats.totalDuplicatesMerged++;
      } else {
        // Admit new student into the accumulated set
        const newCandidate: AccumulatedRecognitionCandidate = {
          studentUserId,
          institutionalId: match.institutionalId ?? '',
          studentName: match.studentName ?? '',
          firstSeenAtMs: candidate.detectedAtMs,
          lastSeenAtMs: candidate.detectedAtMs,
          bestSimilarityScore: match.similarityScore,
          bestQualityScore: candidate.qualityScore,
          bestMargin: match.top2Margin ?? null,
          totalObservations: 1,
          lastTrackId: candidate.trackId,
          isConfirmed: true,
        };
        this.accumulatedCandidates.set(studentUserId, newCandidate);
      }
    }

    // Update stats counters
    this.stats.totalAccumulated = this.accumulatedCandidates.size;
    this.stats.activeTrackCount = trackedFaces.length;
    this.stats.scannerState = this.scannerMetrics.state;
  }

  /**
   * Updates collective centroid displacement and track churn metrics to evaluate camera motion.
   */
  private updateScannerMotion(trackedFaces: TrackedFace[], timestampMs: number): void {
    const currentCentroids = new Map<number, Centroid>();
    const currentTrackIds = new Set<number>();

    for (const track of trackedFaces) {
      const box = track.boundingBox;
      currentCentroids.set(track.trackId, {
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
      });
      currentTrackIds.add(track.trackId);
    }

    // If first frame or no active tracks, initialize as stable
    if (this.lastCentroids.size === 0 || trackedFaces.length === 0) {
      this.lastCentroids = currentCentroids;
      this.lastTrackIds = currentTrackIds;
      if (this.stableStartTimestampMs === null) {
        this.stableStartTimestampMs = timestampMs;
      }
      this.scannerMetrics = {
        state: 'STABLE',
        meanDisplacement: 0.0,
        trackChurnRate: 0.0,
        stableDurationMs: timestampMs - this.stableStartTimestampMs,
        isAdmissionPermitted: true,
      };
      return;
    }

    // 1. Calculate Mean Displacement across tracks present in both frames
    let totalDisplacement = 0.0;
    let commonTrackCount = 0;

    for (const [trackId, curr] of currentCentroids.entries()) {
      const prev = this.lastCentroids.get(trackId);
      if (prev) {
        const dx = curr.x - prev.x;
        const dy = curr.y - prev.y;
        totalDisplacement += Math.sqrt(dx * dx + dy * dy);
        commonTrackCount++;
      }
    }

    const meanDisplacement = commonTrackCount > 0 ? totalDisplacement / commonTrackCount : 0.0;

    // 2. Calculate Track Churn Rate
    let newTracks = 0;
    for (const trackId of currentTrackIds) {
      if (!this.lastTrackIds.has(trackId)) newTracks++;
    }
    let lostTracks = 0;
    for (const trackId of this.lastTrackIds) {
      if (!currentTrackIds.has(trackId)) lostTracks++;
    }
    const maxTrackCount = Math.max(1, currentTrackIds.size, this.lastTrackIds.size);
    const trackChurnRate = (newTracks + lostTracks) / maxTrackCount;

    // 3. Evaluate Motion Stability State
    const isMoving =
      meanDisplacement > this.scannerMotionConfig.displacementPanningThreshold ||
      trackChurnRate > this.scannerMotionConfig.churnPanningThreshold;

    let state: ScannerStabilityState;
    let isAdmissionPermitted: boolean;
    let stableDurationMs: number;

    if (isMoving) {
      state = 'PANNING';
      this.stableStartTimestampMs = null;
      stableDurationMs = 0;
      isAdmissionPermitted = false;
    } else {
      if (this.stableStartTimestampMs === null) {
        this.stableStartTimestampMs = this.lastFrameTimestampMs > 0 ? this.lastFrameTimestampMs : timestampMs;
      }
      stableDurationMs = timestampMs - this.stableStartTimestampMs;

      if (stableDurationMs >= this.scannerMotionConfig.stabilizationRequiredMs) {
        state = 'STABLE';
        isAdmissionPermitted = true;
      } else {
        // In stabilization grace period
        state = this.scannerMetrics.state === 'PANNING' ? 'PANNING' : 'STABLE';
        isAdmissionPermitted = false;
      }
    }

    this.scannerMetrics = {
      state,
      meanDisplacement,
      trackChurnRate,
      stableDurationMs,
      isAdmissionPermitted,
    };

    this.lastCentroids = currentCentroids;
    this.lastTrackIds = currentTrackIds;
    this.lastFrameTimestampMs = timestampMs;
  }

  /**
   * Returns all accumulated candidates in the session, deduplicated by studentUserId.
   */
  public getAccumulatedCandidates(): AccumulatedRecognitionCandidate[] {
    return Array.from(this.accumulatedCandidates.values());
  }

  /**
   * Retrieves a single accumulated candidate by studentUserId.
   */
  public getCandidate(studentUserId: string): AccumulatedRecognitionCandidate | undefined {
    return this.accumulatedCandidates.get(studentUserId);
  }

  /**
   * Returns current scanner motion metrics.
   */
  public getScannerMetrics(): ScannerMotionMetrics {
    return { ...this.scannerMetrics };
  }

  /**
   * Returns current operational statistics.
   */
  public getStats(): AccumulatorStats {
    return { ...this.stats };
  }

  /**
   * Resets all accumulated session state.
   */
  public reset(): void {
    this.accumulatedCandidates.clear();
    this.lastCentroids.clear();
    this.lastTrackIds.clear();
    this.stableStartTimestampMs = null;
    this.lastFrameTimestampMs = 0;
    this.scannerMetrics = {
      state: 'STABLE',
      meanDisplacement: 0.0,
      trackChurnRate: 0.0,
      stableDurationMs: 0,
      isAdmissionPermitted: true,
    };
    this.stats = {
      totalAccumulated: 0,
      totalMatchesProcessed: 0,
      totalDuplicatesMerged: 0,
      totalRejections: 0,
      activeTrackCount: 0,
      scannerState: 'STABLE',
    };
  }
}
