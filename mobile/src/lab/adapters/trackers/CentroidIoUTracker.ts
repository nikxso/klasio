/**
 * Centroid / IoU Face Tracker Implementation
 * Feature: Isolated ML Laboratory / Perception Spike
 *
 * Implements Notion Section 12 & Phase 7 Tracker requirements:
 * - Associates face detections across sequential video frames
 * - Assigns persistent track IDs
 * - Maintains track age, hit count, and lost frame counters
 * - Avoids re-recognizing already confirmed stable face tracks
 */

import {
  FaceBoundingBox,
  FaceDetectionResult,
  IFaceTracker,
  TrackedFace,
} from '../../../perception/contracts';

interface InternalTrack {
  trackId: number;
  box: FaceBoundingBox;
  confidence: number;
  ageInFrames: number;
  hits: number;
  timeSinceLastSeenMs: number;
  lastUpdatedMs: number;
  isConfirmed: boolean;
  landmarks?: any;
}

export class CentroidIoUTracker implements IFaceTracker {
  readonly trackerName = 'CentroidIoUTracker';

  private nextTrackId: number = 1;
  private tracks: InternalTrack[] = [];
  private readonly iouThreshold: number;
  private readonly maxLostFrames: number;
  private readonly minHitsToConfirm: number;

  constructor(
    iouThreshold: number = 0.35,
    maxLostFrames: number = 5,
    minHitsToConfirm: number = 3
  ) {
    this.iouThreshold = iouThreshold;
    this.maxLostFrames = maxLostFrames;
    this.minHitsToConfirm = minHitsToConfirm;
  }

  public static computeIoU(b1: FaceBoundingBox, b2: FaceBoundingBox): number {
    const x1 = Math.max(b1.x, b2.x);
    const y1 = Math.max(b1.y, b2.y);
    const x2 = Math.min(b1.x + b1.width, b2.x + b2.width);
    const y2 = Math.min(b1.y + b1.height, b2.y + b2.height);

    const intersectionArea = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const area1 = b1.width * b1.height;
    const area2 = b2.width * b2.height;
    const unionArea = area1 + area2 - intersectionArea;

    if (unionArea <= 0) return 0;
    return intersectionArea / unionArea;
  }

  public update(detections: FaceDetectionResult[], timestampMs: number): TrackedFace[] {
    const matchedDetections = new Set<number>();
    const matchedTracks = new Set<number>();

    // 1. Associate existing tracks with detections via IoU greedily
    for (let tIdx = 0; tIdx < this.tracks.length; tIdx++) {
      const track = this.tracks[tIdx];
      let bestIoU = 0;
      let bestDetIdx = -1;

      for (let dIdx = 0; dIdx < detections.length; dIdx++) {
        if (matchedDetections.has(dIdx)) continue;
        const iou = CentroidIoUTracker.computeIoU(track.box, detections[dIdx].boundingBox);
        if (iou > bestIoU) {
          bestIoU = iou;
          bestDetIdx = dIdx;
        }
      }

      if (bestIoU >= this.iouThreshold && bestDetIdx !== -1) {
        matchedDetections.add(bestDetIdx);
        matchedTracks.add(tIdx);
        const det = detections[bestDetIdx];
        track.box = det.boundingBox;
        track.confidence = det.confidence;
        track.landmarks = det.landmarks;
        track.hits += 1;
        track.ageInFrames += 1;
        track.timeSinceLastSeenMs = 0;
        track.lastUpdatedMs = timestampMs;
        if (track.hits >= this.minHitsToConfirm) {
          track.isConfirmed = true;
        }
      } else {
        // Track missed in current frame
        track.ageInFrames += 1;
        track.timeSinceLastSeenMs += 33; // Approx 1 frame
      }
    }

    // 2. Remove dead tracks
    this.tracks = this.tracks.filter(
      (t) => t.timeSinceLastSeenMs < this.maxLostFrames * 33.3
    );

    // 3. Create new tracks for unmatched detections
    for (let dIdx = 0; dIdx < detections.length; dIdx++) {
      if (!matchedDetections.has(dIdx)) {
        const det = detections[dIdx];
        const newTrack: InternalTrack = {
          trackId: this.nextTrackId++,
          box: det.boundingBox,
          confidence: det.confidence,
          ageInFrames: 1,
          hits: 1,
          timeSinceLastSeenMs: 0,
          lastUpdatedMs: timestampMs,
          isConfirmed: this.minHitsToConfirm <= 1,
          landmarks: det.landmarks,
        };
        this.tracks.push(newTrack);
      }
    }

    // 4. Return current active tracked faces
    return this.tracks.map((t) => ({
      trackId: t.trackId,
      boundingBox: t.box,
      landmarks: t.landmarks,
      confidence: t.confidence,
      ageInFrames: t.ageInFrames,
      timeSinceLastSeenMs: t.timeSinceLastSeenMs,
      isConfirmed: t.isConfirmed,
    }));
  }

  public reset(): void {
    this.tracks = [];
    this.nextTrackId = 1;
  }
}
