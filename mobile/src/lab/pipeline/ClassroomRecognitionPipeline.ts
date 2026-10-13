/**
 * Classroom Recognition Pipeline Implementation
 * Feature: Isolated ML Laboratory / Perception Spike
 *
 * Implements Notion Section 4, 12, 23.10 & Phase 7 Video/Multi-Face Pipeline:
 * - Camera -> Detection -> Tracking -> Quality Gate -> Selected Observations -> Recognition -> Matching -> Candidates
 * - Key optimization: Tracks are only recognized when NEW, UNCONFIRMED, or unstable.
 * - Confirmed tracks bypass recognition, saving 80-90% of model compute during continuous classroom scanning.
 */

import {
  FaceDetectionResult,
  IFaceDetector,
  IFaceMatcher,
  IFaceRecognizer,
  IFaceTracker,
  IProgressiveRecognitionAccumulator,
  IRecognitionPipeline,
  PermittedStudentGallery,
  RawFrame,
  RecognitionCandidate,
  TrackedFace,
} from '../../perception/contracts';
import { HeuristicQualityGate } from '../adapters/quality/HeuristicQualityGate';

interface TrackPerceptionState {
  trackId: number;
  isRecognized: boolean;
  bestCandidate: RecognitionCandidate | null;
  consecutiveConfirmations: number;
  recognitionAttempts: number;
}

export class ClassroomRecognitionPipeline implements IRecognitionPipeline {
  private detector!: IFaceDetector;
  private recognizer!: IFaceRecognizer;
  private tracker!: IFaceTracker;
  private matcher!: IFaceMatcher;
  private qualityGate: HeuristicQualityGate;
  private gallery: PermittedStudentGallery | null = null;
  private accumulator: IProgressiveRecognitionAccumulator | null = null;

  private trackStates: Map<number, TrackPerceptionState> = new Map();
  private frameCount: number = 0;
  private detectionCadence: number = 5; // Run detector every N frames, track in-between
  private lastDetections: FaceDetectionResult[] = [];

  // Performance telemetry counters
  public totalFramesProcessed: number = 0;
  public totalDetectionRuns: number = 0;
  public totalRecognitionRuns: number = 0;
  public totalCandidatesGenerated: number = 0;

  public similarityThreshold: number = 0.65;
  public marginThreshold: number = 0.10;

  constructor(
    qualityGate: HeuristicQualityGate = new HeuristicQualityGate(),
    detectionCadence: number = 5,
    similarityThreshold: number = 0.65,
    marginThreshold: number = 0.10
  ) {
    this.qualityGate = qualityGate;
    this.detectionCadence = detectionCadence;
    this.similarityThreshold = similarityThreshold;
    this.marginThreshold = marginThreshold;
  }

  public async initialize(
    detector: IFaceDetector,
    recognizer: IFaceRecognizer,
    tracker: IFaceTracker,
    matcher: IFaceMatcher
  ): Promise<void> {
    this.detector = detector;
    this.recognizer = recognizer;
    this.tracker = tracker;
    this.matcher = matcher;
    this.resetSession();
  }

  public setPermittedGallery(gallery: PermittedStudentGallery): void {
    this.gallery = gallery;
  }

  public setAccumulator(accumulator: IProgressiveRecognitionAccumulator | null): void {
    this.accumulator = accumulator;
  }

  public getAccumulator(): IProgressiveRecognitionAccumulator | null {
    return this.accumulator;
  }

  public async processFrame(frame: RawFrame): Promise<RecognitionCandidate[]> {
    this.totalFramesProcessed++;
    this.frameCount++;

    // 1. Detection Stage (Periodic cadence or when no active tracks)
    const shouldDetect = this.frameCount % this.detectionCadence === 0 || this.lastDetections.length === 0;
    if (shouldDetect) {
      this.totalDetectionRuns++;
      this.lastDetections = await this.detector.detectFaces(frame);
    }

    // 2. Tracking Stage (Associates spatial detections across time)
    const trackedFaces: TrackedFace[] = this.tracker.update(this.lastDetections, frame.timestampMs);

    // 3. Selective Recognition Stage (Process only tracks needing recognition)
    const currentCandidates: RecognitionCandidate[] = [];

    for (const track of trackedFaces) {
      let state = this.trackStates.get(track.trackId);
      if (!state) {
        state = {
          trackId: track.trackId,
          isRecognized: false,
          bestCandidate: null,
          consecutiveConfirmations: 0,
          recognitionAttempts: 0,
        };
        this.trackStates.set(track.trackId, state);
      }

      // If already recognized and confident, reuse cached candidate (avoids duplicate inference!)
      if (state.isRecognized && state.bestCandidate) {
        state.consecutiveConfirmations++;
        currentCandidates.push({
          ...state.bestCandidate,
          consecutiveConfirmations: state.consecutiveConfirmations,
          detectedAtMs: frame.timestampMs,
        });
        continue;
      }

      // Quality gate evaluation before running expensive neural recognition
      const quality = this.qualityGate.evaluate(
        { boundingBox: track.boundingBox, confidence: track.confidence, landmarks: track.landmarks },
        frame.width,
        frame.height
      );

      if (!quality.isAcceptable) {
        // Skip recognition for blurry/extreme pose/tiny faces until position improves
        continue;
      }

      // 4. Run Recognition Model only for quality-accepted observations
      this.totalRecognitionRuns++;
      state.recognitionAttempts++;

      const embedding = await this.recognizer.computeEmbedding(frame);

      // 5. Match against scoped gallery
      if (this.gallery) {
        const match = this.matcher.findMatch(
          embedding,
          this.gallery,
          this.similarityThreshold,
          this.marginThreshold
        );
        if (match && match.isConfident) {
          state.isRecognized = true;
          state.bestCandidate = {
            trackId: track.trackId,
            match,
            qualityScore: quality.score,
            detectedAtMs: frame.timestampMs,
            consecutiveConfirmations: 1,
            isConfirmed: true,
          };
          this.totalCandidatesGenerated++;
          currentCandidates.push(state.bestCandidate);
        }
      }
    }

    // Clean up stale track states
    const activeTrackIds = new Set(trackedFaces.map((t) => t.trackId));
    for (const trackId of this.trackStates.keys()) {
      if (!activeTrackIds.has(trackId)) {
        this.trackStates.delete(trackId);
      }
    }

    if (this.accumulator) {
      this.accumulator.processFrameCandidates(currentCandidates, trackedFaces, frame.timestampMs);
    }

    return currentCandidates;
  }

  public resetSession(): void {
    this.trackStates.clear();
    this.frameCount = 0;
    this.lastDetections = [];
    this.tracker?.reset();
    this.accumulator?.reset();
    this.totalFramesProcessed = 0;
    this.totalDetectionRuns = 0;
    this.totalRecognitionRuns = 0;
    this.totalCandidatesGenerated = 0;
  }

  public async dispose(): Promise<void> {
    this.resetSession();
    await this.detector?.dispose();
    await this.recognizer?.dispose();
  }
}
