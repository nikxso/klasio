/**
 * Temporal Centroid + IoU Face Tracker
 * Feature: 001-academic-roles-enrollment / Perception Step C (Live Face Tracking)
 *
 * Designed specifically for rate-decoupled operation on mobile hardware:
 * - Decouples sparse detector updates (~3.2–3.8 FPS) from smooth continuous rendering (~30–60 FPS)
 * - Two-tier association: IoU overlap (tier 1) + Centroid distance gating (tier 2)
 * - Motion extrapolation (coasting) during temporary detector gaps
 * - Exponential bounding-box smoothing to eliminate visual jitter
 * - Anonymous monotonic track IDs (Track #1, Track #2, etc.)
 * - Zero biometric or identity coupling
 */

import type {
  FaceBoundingBox,
  FaceDetectionResult,
  FacialLandmarks,
  IFaceTracker,
  Point2D,
  TrackedFace,
} from '../../../perception/contracts';

export type TrackingState = 'tentative' | 'confirmed' | 'coasting' | 'retired';

export interface InternalTemporalTrack {
  trackId: number;
  state: TrackingState;
  box: FaceBoundingBox; // Current smoothed bounding box [0, 1]
  targetBox: FaceBoundingBox; // Latest observed bounding box from detector
  velocity: { vx: number; vy: number }; // Units per second in normalized coords
  confidence: number;
  hits: number; // Total detector frames matched
  missCount: number; // Consecutive detector frames missed
  firstSeenMs: number;
  lastObservationMs: number;
  timeSinceLastSeenMs: number;
  isConfirmed: boolean;
  landmarks?: FacialLandmarks;
  targetLandmarks?: FacialLandmarks;
}

export interface TrackerConfig {
  iouThreshold: number; // Min IoU to match (default 0.30)
  centroidDistanceThreshold: number; // Max normalized centroid distance (default 0.18)
  sizeRatioThreshold: number; // Max relative box size disparity (default 0.40)
  minHitsToConfirm: number; // Detections needed to confirm track (default 2)
  maxCoastDurationMs: number; // Max time to coast without detector match (default 850ms)
  smoothingAlpha: number; // Lerp smoothing factor per step [0, 1] (default 0.40)
  velocityDamping: number; // Velocity decay per step on coasting (default 0.92)
}

export const DEFAULT_TRACKER_CONFIG: TrackerConfig = {
  iouThreshold: 0.30,
  centroidDistanceThreshold: 0.18,
  sizeRatioThreshold: 0.40,
  minHitsToConfirm: 2,
  maxCoastDurationMs: 850,
  smoothingAlpha: 0.40,
  velocityDamping: 0.92,
};

export class TemporalCentroidTracker implements IFaceTracker {
  readonly trackerName = 'TemporalCentroidTracker';

  private nextTrackId: number = 1;
  private tracks: InternalTemporalTrack[] = [];
  private readonly config: TrackerConfig;
  private lastStepTimestampMs: number = 0;

  // Telemetry & Diagnostic counters
  private totalTracksCreated: number = 0;
  private totalTracksRetired: number = 0;
  private totalAssociations: number = 0;
  private totalMisses: number = 0;
  private lastStepDurationMs: number = 0;

  constructor(config?: Partial<TrackerConfig>) {
    this.config = { ...DEFAULT_TRACKER_CONFIG, ...(config || {}) };
  }

  // ---------------------------------------------------------------------------
  // Geometric Utilities
  // ---------------------------------------------------------------------------

  public static computeIoU(b1: FaceBoundingBox, b2: FaceBoundingBox): number {
    const x1 = Math.max(b1.x, b2.x);
    const y1 = Math.max(b1.y, b2.y);
    const x2 = Math.min(b1.x + b1.width, b2.x + b2.width);
    const y2 = Math.min(b1.y + b1.height, b2.y + b2.height);

    const interArea = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const unionArea = b1.width * b1.height + b2.width * b2.height - interArea;

    if (unionArea <= 0) return 0;
    return interArea / unionArea;
  }

  public static computeCentroidDistance(b1: FaceBoundingBox, b2: FaceBoundingBox): number {
    const c1x = b1.x + b1.width / 2;
    const c1y = b1.y + b1.height / 2;
    const c2x = b2.x + b2.width / 2;
    const c2y = b2.y + b2.height / 2;

    const dx = c1x - c2x;
    const dy = c1y - c2y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  public static computeSizeRatio(b1: FaceBoundingBox, b2: FaceBoundingBox): number {
    const maxDim = Math.max(b1.width, b2.width, 0.001);
    return Math.abs(b1.width - b2.width) / maxDim;
  }

  private lerpPoint(p1: Point2D, p2: Point2D, alpha: number): Point2D {
    return {
      x: p1.x + alpha * (p2.x - p1.x),
      y: p1.y + alpha * (p2.y - p1.y),
    };
  }

  private lerpLandmarks(l1: FacialLandmarks, l2: FacialLandmarks, alpha: number): FacialLandmarks {
    return {
      leftEye: this.lerpPoint(l1.leftEye, l2.leftEye, alpha),
      rightEye: this.lerpPoint(l1.rightEye, l2.rightEye, alpha),
      noseTip: this.lerpPoint(l1.noseTip, l2.noseTip, alpha),
      mouthLeft: this.lerpPoint(l1.mouthLeft, l2.mouthLeft, alpha),
      mouthRight: this.lerpPoint(l1.mouthRight, l2.mouthRight, alpha),
    };
  }

  // ---------------------------------------------------------------------------
  // IFaceTracker Interface: Update with New Detections
  // ---------------------------------------------------------------------------

  /**
   * Associates new face detections from sparse detector cycle (~3–4 FPS).
   * Runs two-tier matching:
   * Tier 1: IoU overlap >= iouThreshold
   * Tier 2: Centroid distance <= centroidDistanceThreshold & size ratio <= sizeRatioThreshold
   */
  public update(detections: FaceDetectionResult[], timestampMs: number): TrackedFace[] {
    const now = timestampMs || Date.now();
    const matchedDetections = new Set<number>();
    const matchedTracks = new Set<number>();

    // TIER 1: Match tracks and detections by IoU greedily
    for (let tIdx = 0; tIdx < this.tracks.length; tIdx++) {
      const track = this.tracks[tIdx];
      let bestIoU = 0;
      let bestDetIdx = -1;

      for (let dIdx = 0; dIdx < detections.length; dIdx++) {
        if (matchedDetections.has(dIdx)) continue;
        const iou = TemporalCentroidTracker.computeIoU(track.box, detections[dIdx].boundingBox);
        if (iou > bestIoU) {
          bestIoU = iou;
          bestDetIdx = dIdx;
        }
      }

      if (bestIoU >= this.config.iouThreshold && bestDetIdx !== -1) {
        matchedTracks.add(tIdx);
        matchedDetections.add(bestDetIdx);
        this.applyDetectionToTrack(track, detections[bestDetIdx], now);
        this.totalAssociations++;
      }
    }

    // TIER 2: Match remaining tracks & detections by Centroid Distance Gating
    for (let tIdx = 0; tIdx < this.tracks.length; tIdx++) {
      if (matchedTracks.has(tIdx)) continue;
      const track = this.tracks[tIdx];
      let bestDist = Infinity;
      let bestDetIdx = -1;

      for (let dIdx = 0; dIdx < detections.length; dIdx++) {
        if (matchedDetections.has(dIdx)) continue;
        const detBox = detections[dIdx].boundingBox;
        const dist = TemporalCentroidTracker.computeCentroidDistance(track.box, detBox);
        const sizeRatio = TemporalCentroidTracker.computeSizeRatio(track.box, detBox);

        if (
          dist <= this.config.centroidDistanceThreshold &&
          sizeRatio <= this.config.sizeRatioThreshold &&
          dist < bestDist
        ) {
          bestDist = dist;
          bestDetIdx = dIdx;
        }
      }

      if (bestDetIdx !== -1) {
        matchedTracks.add(tIdx);
        matchedDetections.add(bestDetIdx);
        this.applyDetectionToTrack(track, detections[bestDetIdx], now);
        this.totalAssociations++;
      }
    }

    // Handle UNMATCHED TRACKS (Coasting / Aging)
    for (let tIdx = 0; tIdx < this.tracks.length; tIdx++) {
      if (!matchedTracks.has(tIdx)) {
        const track = this.tracks[tIdx];
        track.missCount += 1;
        track.timeSinceLastSeenMs = now - track.lastObservationMs;
        this.totalMisses++;

        if (track.timeSinceLastSeenMs > this.config.maxCoastDurationMs) {
          track.state = 'retired';
          this.totalTracksRetired++;
        } else {
          track.state = 'coasting';
        }
      }
    }

    // Handle UNMATCHED DETECTIONS (Create New Tracks)
    for (let dIdx = 0; dIdx < detections.length; dIdx++) {
      if (!matchedDetections.has(dIdx)) {
        const det = detections[dIdx];
        const isImmediate = this.config.minHitsToConfirm <= 1;
        const newTrack: InternalTemporalTrack = {
          trackId: this.nextTrackId++,
          state: isImmediate ? 'confirmed' : 'tentative',
          box: { ...det.boundingBox },
          targetBox: { ...det.boundingBox },
          velocity: { vx: 0, vy: 0 },
          confidence: det.confidence,
          hits: 1,
          missCount: 0,
          firstSeenMs: now,
          lastObservationMs: now,
          timeSinceLastSeenMs: 0,
          isConfirmed: isImmediate,
          landmarks: det.landmarks ? { ...det.landmarks } : undefined,
          targetLandmarks: det.landmarks ? { ...det.landmarks } : undefined,
        };

        this.tracks.push(newTrack);
        this.totalTracksCreated++;
      }
    }

    // Purge retired tracks
    this.tracks = this.tracks.filter((t) => t.state !== 'retired');

    return this.getActiveTrackedFaces();
  }

  private applyDetectionToTrack(
    track: InternalTemporalTrack,
    detection: FaceDetectionResult,
    now: number
  ): void {
    const dtSeconds = Math.max(0.01, (now - track.lastObservationMs) / 1000);
    const detBox = detection.boundingBox;

    // Estimate velocity (screen delta / sec)
    const rawVx = (detBox.x - track.box.x) / dtSeconds;
    const rawVy = (detBox.y - track.box.y) / dtSeconds;

    // Clamp velocity to prevent wild predictions from sudden movements
    const clampedVx = Math.max(-1.5, Math.min(1.5, rawVx));
    const clampedVy = Math.max(-1.5, Math.min(1.5, rawVy));

    track.velocity = {
      vx: 0.5 * track.velocity.vx + 0.5 * clampedVx,
      vy: 0.5 * track.velocity.vy + 0.5 * clampedVy,
    };

    track.targetBox = { ...detBox };
    if (detection.landmarks) {
      track.targetLandmarks = { ...detection.landmarks };
      if (!track.landmarks) {
        track.landmarks = { ...detection.landmarks };
      }
    }

    track.confidence = detection.confidence;
    track.hits += 1;
    track.missCount = 0;
    track.timeSinceLastSeenMs = 0;
    track.lastObservationMs = now;

    if (track.hits >= this.config.minHitsToConfirm) {
      track.isConfirmed = true;
      track.state = 'confirmed';
    } else {
      track.state = 'tentative';
    }
  }

  // ---------------------------------------------------------------------------
  // High-Frequency Temporal Step (~30–60 Hz Render Tick)
  // ---------------------------------------------------------------------------

  /**
   * Advances track positions smoothly between detector cycles.
   * Can be called on animation ticks (requestAnimationFrame / 16–33 ms).
   * - Confirmed/Tentative tracks: Exponentially smooth position towards targetBox
   * - Coasting tracks: Extrapolate position using damped velocity
   */
  public step(timestampMs?: number): TrackedFace[] {
    const start = performance.now();
    const now = timestampMs || Date.now();

    const dtSeconds = this.lastStepTimestampMs === 0
      ? 0.033
      : Math.max(0.001, Math.min(0.1, (now - this.lastStepTimestampMs) / 1000));
    this.lastStepTimestampMs = now;

    const alpha = this.config.smoothingAlpha;
    const damping = this.config.velocityDamping;

    for (let i = 0; i < this.tracks.length; i++) {
      const track = this.tracks[i];
      track.timeSinceLastSeenMs = now - track.lastObservationMs;

      if (track.state === 'coasting') {
        // Coasting: check if exceeded max allowable duration
        if (track.timeSinceLastSeenMs > this.config.maxCoastDurationMs) {
          track.state = 'retired';
          this.totalTracksRetired++;
          continue;
        }

        // Extrapolate box using damped velocity
        track.box.x = Math.max(0, Math.min(1 - track.box.width, track.box.x + track.velocity.vx * dtSeconds));
        track.box.y = Math.max(0, Math.min(1 - track.box.height, track.box.y + track.velocity.vy * dtSeconds));
        track.velocity.vx *= damping;
        track.velocity.vy *= damping;

        // Landmark extrapolation
        if (track.landmarks) {
          const ldx = track.velocity.vx * dtSeconds;
          const ldy = track.velocity.vy * dtSeconds;
          track.landmarks.leftEye.x += ldx;
          track.landmarks.leftEye.y += ldy;
          track.landmarks.rightEye.x += ldx;
          track.landmarks.rightEye.y += ldy;
          track.landmarks.noseTip.x += ldx;
          track.landmarks.noseTip.y += ldy;
          track.landmarks.mouthLeft.x += ldx;
          track.landmarks.mouthLeft.y += ldy;
          track.landmarks.mouthRight.x += ldx;
          track.landmarks.mouthRight.y += ldy;
        }
      } else {
        // Active observation: Exponentially smooth position towards target
        track.box.x += alpha * (track.targetBox.x - track.box.x);
        track.box.y += alpha * (track.targetBox.y - track.box.y);
        track.box.width += alpha * (track.targetBox.width - track.box.width);
        track.box.height += alpha * (track.targetBox.height - track.box.height);

        // Smooth landmarks towards target
        if (track.landmarks && track.targetLandmarks) {
          track.landmarks = this.lerpLandmarks(track.landmarks, track.targetLandmarks, alpha);
        }
      }
    }

    // Purge retired tracks
    this.tracks = this.tracks.filter((t) => t.state !== 'retired');

    this.lastStepDurationMs = Math.round((performance.now() - start) * 100) / 100;
    return this.getActiveTrackedFaces();
  }

  // ---------------------------------------------------------------------------
  // Output & Telemetry
  // ---------------------------------------------------------------------------

  public getActiveTrackedFaces(): TrackedFace[] {
    return this.tracks.map((t) => ({
      trackId: t.trackId,
      boundingBox: { ...t.box },
      landmarks: t.landmarks ? { ...t.landmarks } : undefined,
      confidence: t.confidence,
      ageInFrames: t.hits,
      timeSinceLastSeenMs: t.timeSinceLastSeenMs,
      isConfirmed: t.isConfirmed,
    }));
  }

  public getInternalTracks(): InternalTemporalTrack[] {
    return this.tracks.map((t) => ({ ...t }));
  }

  public getDiagnostics() {
    const confirmedCount = this.tracks.filter((t) => t.state === 'confirmed').length;
    const coastingCount = this.tracks.filter((t) => t.state === 'coasting').length;
    const tentativeCount = this.tracks.filter((t) => t.state === 'tentative').length;

    return {
      activeTracks: this.tracks.length,
      confirmedTracks: confirmedCount,
      coastingTracks: coastingCount,
      tentativeTracks: tentativeCount,
      totalCreated: this.totalTracksCreated,
      totalRetired: this.totalTracksRetired,
      totalAssociations: this.totalAssociations,
      totalMisses: this.totalMisses,
      lastStepDurationMs: this.lastStepDurationMs,
    };
  }

  public reset(): void {
    this.tracks = [];
    this.nextTrackId = 1;
    this.lastStepTimestampMs = 0;
    this.totalTracksCreated = 0;
    this.totalTracksRetired = 0;
    this.totalAssociations = 0;
    this.totalMisses = 0;
    this.lastStepDurationMs = 0;
  }
}
