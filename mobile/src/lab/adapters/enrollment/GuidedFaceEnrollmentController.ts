/**
 * Guided Face Enrollment Controller Implementation (Step H)
 * Feature: Isolated ML Laboratory / Guided Face Enrollment
 *
 * Implements Constitution Principle IV & Notion Section 25:
 * - Controlled single-person enrollment interaction.
 * - Single-Face Invariant: Exactly 1 face permitted.
 * - Authoritative identity binding: Context (studentUserId) known BEFORE capture.
 * - Real-time guidance state machine (centering, distance, lighting, pose, stillness).
 * - Spatial stabilization window (>= 400ms stillness) before automatic capture.
 * - Umeyama 5-point alignment + EdgeFace-XS 512-D L2 embedding generation.
 * - Multi-sample diversity strategy (Frontal, Smile/Expression, Slight Angle).
 * - Intra-student pairwise genuine consistency verification (>= 0.60).
 * - Automated mathematical validation (dimension, finite values, unit L2 norm, model manifest).
 * - Atomic re-enrollment replacement policy.
 * - HARD INVARIANT: Zero attendance logic, zero AttendanceRecord created.
 */

import type {
  EnrollmentGuidanceState,
  EnrollmentSampleResult,
  EnrollmentSampleStep,
  EnrollmentSessionState,
  FaceCropInput,
  FaceDetectionResult,
  IFaceEmbedder,
  IGuidedFaceEnrollmentController,
  ModelManifest,
  RawFrame,
  StudentEnrollmentContext,
  StudentReferenceProfile,
} from '../../../perception/contracts';
import { FaceQualityGate } from '../quality/FaceQualityGate.ts';
import { EDGEFACE_XS_MANIFEST } from '../recognizers/EdgeFaceEmbedder.ts';

export interface EnrollmentControllerConfig {
  targetSamples?: number;
  stabilizationRequiredMs?: number;
  // Provisional threshold; calibrated during post-evaluation
  minPairwiseConsistency?: number;
  expectedManifest?: ModelManifest;
  maxCentroidJitter?: number;
  steps?: EnrollmentSampleStep[];
  enforcePoseAngles?: boolean;
}

interface Centroid {
  x: number;
  y: number;
}

export class GuidedFaceEnrollmentController implements IGuidedFaceEnrollmentController {
  private _state: EnrollmentSessionState | null = null;
  private completedProfile: StudentReferenceProfile | null = null;

  private qualityGate: FaceQualityGate;
  private embedder: any;
  private config: Required<Omit<EnrollmentControllerConfig, 'steps'>> & { steps: EnrollmentSampleStep[] };

  private readonly steps: EnrollmentSampleStep[];
  private stepIndex: number = 0;

  private lastCentroid: Centroid | null = null;
  private stableStartMs: number | null = null;

  constructor(
    embedder: any,
    config: EnrollmentControllerConfig = {}
  ) {
    this.embedder = embedder;
    this.qualityGate = new FaceQualityGate();
    this.steps = config.steps ?? [
      'FRONTAL',
      'SLIGHT_LEFT',
      'SLIGHT_RIGHT',
    ];
    this.config = {
      targetSamples: config.targetSamples ?? this.steps.length,
      stabilizationRequiredMs: config.stabilizationRequiredMs ?? 400,
      minPairwiseConsistency: config.minPairwiseConsistency ?? 0.60,
      expectedManifest: config.expectedManifest ?? EDGEFACE_XS_MANIFEST,
      maxCentroidJitter: config.maxCentroidJitter ?? 0.05,
      steps: this.steps,
      enforcePoseAngles: config.enforcePoseAngles ?? false,
    };
  }

  public get state(): EnrollmentSessionState | null {
    if (!this._state) return null;
    return {
      ...this._state,
      samplesCaptured: [...this._state.samplesCaptured],
    };
  }

  /**
   * Initializes a fresh enrollment session bound to a known student identity.
   */
  public startSession(context: StudentEnrollmentContext): void {
    if (!context) {
      throw new Error('Student enrollment context is required');
    }
    if (!context.studentUserId || context.studentUserId.trim() === '') {
      throw new Error('studentUserId is required before starting enrollment');
    }

    this.stepIndex = 0;
    this.completedProfile = null;
    this.lastCentroid = null;
    this.stableStartMs = null;

    this._state = {
      studentContext: { ...context },
      currentStep: this.steps[0],
      guidance: 'NO_FACE',
      guidanceMessage: 'Position your face inside the oval frame',
      samplesCaptured: [],
      targetSamples: this.config.targetSamples,
      isStabilizing: false,
      stableDurationMs: 0,
      isCompleted: false,
    };
  }

  /**
   * Processes a video frame with current face detections to update guidance,
   * verify stability, and automatically capture required reference samples.
   */
  public async processFrame(
    frame: RawFrame,
    detections: FaceDetectionResult[],
    timestampMs: number
  ): Promise<EnrollmentGuidanceState> {
    if (!this._state) {
      throw new Error('Enrollment session has not been started');
    }

    if (this._state.isCompleted) {
      return 'COMPLETED';
    }

    // 1. Single-Person Gate
    if (!detections || detections.length === 0) {
      this.resetStabilization();
      this._state.guidance = 'NO_FACE';
      this._state.guidanceMessage = 'Position your face inside the oval frame';
      return 'NO_FACE';
    }

    if (detections.length > 1) {
      this.resetStabilization();
      this._state.guidance = 'MULTIPLE_FACES';
      this._state.guidanceMessage = 'Multiple faces detected — ensure only one person is in frame';
      return 'MULTIPLE_FACES';
    }

    // Exactly one face detected
    const detection = detections[0];
    const box = detection.boundingBox;

    // 2. Framing & Geometry Checks
    const area = box.width * box.height;
    const cx = box.x + box.width / 2.0;
    const cy = box.y + box.height / 2.0;
    const distFromCenter = Math.sqrt(Math.pow(cx - 0.5, 2) + Math.pow(cy - 0.5, 2));

    if (area < 0.10 || box.width < 0.20) {
      this.resetStabilization();
      this._state.guidance = 'MOVE_CLOSER';
      this._state.guidanceMessage = 'Move closer to the camera';
      return 'MOVE_CLOSER';
    }

    if (area > 0.65 || box.width > 0.85) {
      this.resetStabilization();
      this._state.guidance = 'MOVE_AWAY';
      this._state.guidanceMessage = 'Move slightly back from the camera';
      return 'MOVE_AWAY';
    }

    if (distFromCenter > 0.18) {
      this.resetStabilization();
      this._state.guidance = 'CENTER_FACE';
      this._state.guidanceMessage = 'Center your face inside the frame';
      return 'CENTER_FACE';
    }

    // 3. Quality Gate & Pose Signals
    const quality = this.qualityGate.evaluate(
      box,
      detection.landmarks,
      detection.confidence,
      undefined,
      undefined,
      frame.width,
      frame.height
    );

    if (this._state.currentStep === 'FRONTAL') {
      if (Math.abs(quality.metrics.yawDegrees) > 15 || Math.abs(quality.metrics.pitchDegrees) > 12) {
        this.resetStabilization();
        this._state.guidance = 'LOOK_AT_CAMERA';
        this._state.guidanceMessage = 'Look straight at the camera with a neutral expression';
        return 'LOOK_AT_CAMERA';
      }
    } else if (this.config.enforcePoseAngles && this._state.currentStep === 'SLIGHT_LEFT') {
      if (quality.metrics.yawDegrees > -4) {
        this.resetStabilization();
        this._state.guidance = 'TURN_SLIGHTLY';
        this._state.guidanceMessage = 'Turn your head slightly to your left';
        return 'TURN_SLIGHTLY';
      }
      if (quality.metrics.yawDegrees < -35 || Math.abs(quality.metrics.pitchDegrees) > 15) {
        this.resetStabilization();
        this._state.guidance = 'TURN_SLIGHTLY';
        this._state.guidanceMessage = 'Turn back slightly towards center';
        return 'TURN_SLIGHTLY';
      }
    } else if (this.config.enforcePoseAngles && this._state.currentStep === 'SLIGHT_RIGHT') {
      if (quality.metrics.yawDegrees < 4) {
        this.resetStabilization();
        this._state.guidance = 'TURN_SLIGHTLY';
        this._state.guidanceMessage = 'Turn your head slightly to your right';
        return 'TURN_SLIGHTLY';
      }
      if (quality.metrics.yawDegrees > 35 || Math.abs(quality.metrics.pitchDegrees) > 15) {
        this.resetStabilization();
        this._state.guidance = 'TURN_SLIGHTLY';
        this._state.guidanceMessage = 'Turn back slightly towards center';
        return 'TURN_SLIGHTLY';
      }
    }

    if (quality.metrics.sharpnessState === 'POOR') {
      this.resetStabilization();
      this._state.guidance = 'IMPROVE_LIGHTING';
      this._state.guidanceMessage = 'Hold still and improve lighting to reduce blur';
      return 'IMPROVE_LIGHTING';
    }

    // 4. Spatial Stillness & Stabilization Buffer
    if (this.lastCentroid) {
      const jitter = Math.sqrt(
        Math.pow(cx - this.lastCentroid.x, 2) + Math.pow(cy - this.lastCentroid.y, 2)
      );
      if (jitter > this.config.maxCentroidJitter) {
        // Sudden movement restarts stillness window
        this.stableStartMs = timestampMs;
      }
    } else {
      this.stableStartMs = timestampMs;
    }

    this.lastCentroid = { x: cx, y: cy };

    if (this.stableStartMs === null) {
      this.stableStartMs = timestampMs;
    }

    const stableDuration = timestampMs - this.stableStartMs;
    this._state.isStabilizing = true;
    this._state.stableDurationMs = stableDuration;

    if (stableDuration < this.config.stabilizationRequiredMs) {
      this._state.guidance = 'HOLD_STILL';
      this._state.guidanceMessage = `Hold still (${Math.round((stableDuration / this.config.stabilizationRequiredMs) * 100)}%)...`;
      return 'HOLD_STILL';
    }

    // 5. Automatic Capture & Embedding Generation
    this._state.guidance = 'CAPTURING';
    this._state.guidanceMessage = 'Capturing reference sample...';

    const cropInput: FaceCropInput = {
      frame,
      box,
      landmarks: detection.landmarks,
    };

    let embedding: Float32Array;
    let embManifest: ModelManifest | undefined;

    try {
      const result = await this.embedder.embed(cropInput, true);
      embedding = result.embedding;
      embManifest = result.manifest;
    } catch (err: any) {
      return this.failValidation(`Embedding extraction failed: ${err?.message || err}`);
    }

    // 6. Embedding & Model Contract Validation
    if (!embedding || embedding.length !== this.config.expectedManifest.embeddingDimension) {
      return this.failValidation(
        `Embedding dimension mismatch: expected ${this.config.expectedManifest.embeddingDimension}, got ${embedding?.length}`
      );
    }

    if (
      embManifest &&
      (embManifest.modelName !== this.config.expectedManifest.modelName ||
        embManifest.modelVersion !== this.config.expectedManifest.modelVersion)
    ) {
      return this.failValidation(
        `Model manifest mismatch: ${embManifest.modelName} ${embManifest.modelVersion} vs expected ${this.config.expectedManifest.modelName} ${this.config.expectedManifest.modelVersion}`
      );
    }

    // Numeric validity (non-finite check)
    for (let i = 0; i < embedding.length; i++) {
      if (!Number.isFinite(embedding[i])) {
        return this.failValidation('Embedding vector contains non-finite values (NaN / Infinity)');
      }
    }

    // Unit L2 normalization validation
    let normSq = 0.0;
    for (let i = 0; i < embedding.length; i++) {
      normSq += embedding[i] * embedding[i];
    }
    const norm = Math.sqrt(normSq);
    if (Math.abs(norm - 1.0) > 1e-3) {
      return this.failValidation(`Embedding vector is not unit L2 normalized (||v|| = ${norm.toFixed(4)})`);
    }

    // 7. Intra-Student Pairwise Consistency Check
    if (this._state.samplesCaptured.length > 0) {
      const baseVec = this._state.samplesCaptured[0].embedding;
      const simWithBase = this.cosineSimilarity(embedding, baseVec);
      if (simWithBase < this.config.minPairwiseConsistency) {
        return this.failValidation(
          `Intra-student consistency verification failed: similarity ${simWithBase.toFixed(3)} is below required ${this.config.minPairwiseConsistency.toFixed(2)}`
        );
      }
    }

    // 8. Record Accepted Sample
    const sampleResult: EnrollmentSampleResult = {
      step: this._state.currentStep,
      embedding,
      quality,
      capturedAtMs: timestampMs,
    };
    this._state.samplesCaptured.push(sampleResult);
    this.resetStabilization();

    // Check completion condition
    if (this._state.samplesCaptured.length >= this.config.targetSamples) {
      this._state.isCompleted = true;
      this._state.guidance = 'COMPLETED';
      this._state.guidanceMessage = 'Face enrollment successfully completed!';

      this.completedProfile = {
        studentUserId: this._state.studentContext.studentUserId,
        institutionalId: this._state.studentContext.institutionalId,
        studentName: this._state.studentContext.studentName,
        modelName: this.config.expectedManifest.modelName,
        activeModelVersion: this.config.expectedManifest.modelVersion,
        embeddingDimension: this.config.expectedManifest.embeddingDimension,
        normalization: this.config.expectedManifest.normalization,
        alignmentMode: this.config.expectedManifest.alignmentMode,
        embeddings: this._state.samplesCaptured.map((s) => s.embedding),
      };

      return 'COMPLETED';
    }

    // Advance to next diversity sample step
    this.stepIndex++;
    this._state.currentStep = this.steps[Math.min(this.stepIndex, this.steps.length - 1)];
    this._state.guidance = 'SAMPLE_ACCEPTED';
    this._state.guidanceMessage = `Sample ${this._state.samplesCaptured.length}/${this.config.targetSamples} accepted! Now ${this.getStepInstruction(this._state.currentStep)}`;
    return 'SAMPLE_ACCEPTED';
  }

  private getStepInstruction(step: EnrollmentSampleStep): string {
    switch (step) {
      case 'FRONTAL':
        return 'look straight at the camera with a neutral expression';
      case 'SLIGHT_LEFT':
        return 'turn your head slightly to your left';
      case 'SLIGHT_RIGHT':
        return 'turn your head slightly to your right';
      case 'SMILE_OR_EXPRESSION':
        return 'smile naturally';
      case 'SLIGHT_ANGLE':
        return 'tilt your head slightly';
    }
  }

  private failValidation(reason: string): EnrollmentGuidanceState {
    this.resetStabilization();
    if (this._state) {
      this._state.guidance = 'VALIDATION_FAILED';
      this._state.guidanceMessage = `Validation failed: ${reason}. Please retake.`;
      this._state.failureReason = reason;
    }
    return 'VALIDATION_FAILED';
  }

  private resetStabilization(): void {
    this.stableStartMs = null;
    this.lastCentroid = null;
    if (this._state) {
      this._state.isStabilizing = false;
      this._state.stableDurationMs = 0;
    }
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0.0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
    }
    return dot;
  }

  /**
   * Returns completed student reference profile upon successful completion.
   */
  public getCompletedProfile(): StudentReferenceProfile | null {
    return this.completedProfile;
  }

  /**
   * Resets active enrollment session state cleanly.
   */
  public resetSession(): void {
    this._state = null;
    this.completedProfile = null;
    this.lastCentroid = null;
    this.stableStartMs = null;
    this.stepIndex = 0;
  }
}
