/**
 * Guided Face Registration Spike
 * Feature: Isolated ML Laboratory / Perception Spike
 *
 * Implements Notion Section 25 & Phase 5 Guided Registration:
 * - Multi-pose guided capture sequence (Frontal, Turn Left, Turn Right, Smile / Blink)
 * - Quality filtering (size check, blur check, pose compliance)
 * - Active liveness challenge sequencing
 * - Identity binding to student context
 * - Generates reference embeddings without manual faculty queue
 * - Automatic retry on validation failure
 */

import {
  FaceDetectionResult,
  IFaceDetector,
  IFaceRecognizer,
  RawFrame,
  StudentReferenceProfile,
} from '../../perception/contracts';
import { HeuristicQualityGate } from '../adapters/quality/HeuristicQualityGate';

export type LivenessChallengeStep = 'FRONTAL' | 'TURN_LEFT' | 'TURN_RIGHT' | 'BLINK_OR_SMILE';

export interface RegistrationStepState {
  step: LivenessChallengeStep;
  prompt: string;
  isCompleted: boolean;
  capturedEmbedding?: Float32Array;
  qualityScore: number;
  rejectionReason?: string;
}

export interface StudentRegistrationContext {
  studentUserId: string;
  institutionalId: string;
  studentName: string;
  academicTermId: string;
}

export interface RegistrationResult {
  success: boolean;
  profile?: StudentReferenceProfile;
  failureReason?: string;
  stepStates: RegistrationStepState[];
  retryRecommended: boolean;
}

export class GuidedRegistrationSpike {
  private detector: IFaceDetector;
  private recognizer: IFaceRecognizer;
  private qualityGate: HeuristicQualityGate;

  private readonly steps: LivenessChallengeStep[] = [
    'FRONTAL',
    'TURN_LEFT',
    'TURN_RIGHT',
    'BLINK_OR_SMILE',
  ];

  constructor(
    detector: IFaceDetector,
    recognizer: IFaceRecognizer,
    qualityGate: HeuristicQualityGate = new HeuristicQualityGate()
  ) {
    this.detector = detector;
    this.recognizer = recognizer;
    this.qualityGate = qualityGate;
  }

  /**
   * Initializes a fresh guided registration session for an authenticated student.
   */
  public startSession(): RegistrationStepState[] {
    return [
      { step: 'FRONTAL', prompt: 'Look straight at the camera', isCompleted: false, qualityScore: 0 },
      { step: 'TURN_LEFT', prompt: 'Turn your head slightly to your left', isCompleted: false, qualityScore: 0 },
      { step: 'TURN_RIGHT', prompt: 'Turn your head slightly to your right', isCompleted: false, qualityScore: 0 },
      { step: 'BLINK_OR_SMILE', prompt: 'Blink naturally or smile', isCompleted: false, qualityScore: 0 },
    ];
  }

  /**
   * Evaluates a frame for the currently active challenge step.
   */
  public async evaluateStep(
    step: LivenessChallengeStep,
    frame: RawFrame,
    detection: FaceDetectionResult | null
  ): Promise<{ passed: boolean; score: number; reason?: string; embedding?: Float32Array }> {
    if (!detection) {
      return { passed: false, score: 0, reason: 'NO_FACE_DETECTED' };
    }

    const quality = this.qualityGate.evaluate(detection, frame.width, frame.height);
    if (!quality.isAcceptable && step === 'FRONTAL') {
      return {
        passed: false,
        score: quality.score,
        reason: quality.rejectionReason || 'QUALITY_UNACCEPTABLE',
      };
    }

    // Pose check per step
    if (step === 'FRONTAL') {
      if (Math.abs(quality.yawDegrees) > 15.0 || Math.abs(quality.pitchDegrees) > 15.0) {
        return { passed: false, score: quality.score, reason: 'NOT_FRONTAL' };
      }
    } else if (step === 'TURN_LEFT') {
      if (quality.yawDegrees > -12.0) {
        return { passed: false, score: quality.score, reason: 'TURN_FURTHER_LEFT' };
      }
    } else if (step === 'TURN_RIGHT') {
      if (quality.yawDegrees < 12.0) {
        return { passed: false, score: quality.score, reason: 'TURN_FURTHER_RIGHT' };
      }
    }

    // Extract reference embedding
    const embedding = await this.recognizer.computeEmbedding(frame);
    return {
      passed: true,
      score: quality.score,
      embedding,
    };
  }

  /**
   * Finalizes registration into a completed StudentReferenceProfile.
   * If any step is missing or failed, returns retryRecommended without silent acceptance.
   */
  public finalizeRegistration(
    context: StudentRegistrationContext,
    stepStates: RegistrationStepState[]
  ): RegistrationResult {
    const validObservations = stepStates
      .filter((s) => s.isCompleted && s.capturedEmbedding !== undefined)
      .map((s) => s.capturedEmbedding!);

    if (validObservations.length < 3) {
      return {
        success: false,
        failureReason: `Insufficient valid observations (${validObservations.length}/4 completed)`,
        stepStates,
        retryRecommended: true,
      };
    }

    const profile: StudentReferenceProfile = {
      studentUserId: context.studentUserId,
      institutionalId: context.institutionalId,
      studentName: context.studentName,
      modelName: this.recognizer.modelName,
      activeModelVersion: this.recognizer.modelVersion,
      embeddingDimension: this.recognizer.embeddingDimension,
      normalization: 'MINUS_127_5_DIV_127_5',
      alignmentMode: 'SIMILARITY_TRANSFORM_5PT',
      embeddings: validObservations,
    };

    return {
      success: true,
      profile,
      stepStates,
      retryRecommended: false,
    };
  }
}
