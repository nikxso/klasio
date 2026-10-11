/**
 * Face Quality & Visibility Gate Implementation
 * Step D — Bounded Technical Experiment
 *
 * Implements IFaceQualityGate with strict architectural separation:
 * - Evaluates 5 independent quality dimensions:
 *   A. Face Size (normalized width, height, area)
 *   B. Bounding-Box Geometry & Aspect Ratio (width / height, scale stability)
 *   C. Visibility & Clipping (in-frame proportion, landmark completeness)
 *   D. Image Sharpness / Blur (lightweight pixel gradient proxy)
 *   E. Head Pose / Orientation (yaw, pitch, roll from 5-point landmarks)
 * - Explicit Quality State model: UNKNOWN, GOOD, FAIR, POOR
 * - Explicit Primary Reason derivation without obscure magic scoring
 * - Transient and strictly anonymous: zero biometric or identity coupling
 */

import type {
  FaceBoundingBox,
  FacialLandmarks,
  IFaceQualityGate,
  QualityAssessment,
  QualityGateConfig,
  QualityReason,
  QualitySignalMetrics,
  QualityState,
} from '../../../perception/contracts';

export const DEFAULT_QUALITY_GATE_CONFIG: QualityGateConfig = {
  // A. Face Size (relative to analysis frame [0, 1])
  minNormalizedWidth: 0.05, // e.g. ~32px at 640x640 analysis
  minNormalizedHeight: 0.06, // e.g. ~38px at 640x640 analysis
  fairNormalizedWidth: 0.08, // e.g. ~51px at 640x640 analysis
  fairNormalizedHeight: 0.095, // e.g. ~61px at 640x640 analysis

  // B. Bounding-Box Geometry & Aspect Ratio (width / height)
  minAspectRatio: 0.50, // Rejects thin slivers
  maxAspectRatio: 1.20, // Rejects excessively wide horizontal boxes
  fairMinAspectRatio: 0.60,
  fairMaxAspectRatio: 1.05,
  maxScaleJumpRatio: 0.50, // Rejects >50% sudden scale jump across adjacent updates

  // C. Visibility & Frame Boundary Containment
  minInFrameProportion: 0.80, // >= 80% of box must be inside frame
  fairInFrameProportion: 0.95, // >= 95% inside frame for GOOD visibility

  // D. Image Sharpness / Blur Proxy
  minSharpness: 0.20,
  fairSharpness: 0.35,

  // E. Head Pose / Orientation (degrees)
  maxYawDegrees: 28.0,
  fairYawDegrees: 16.0,
  maxPitchDegrees: 22.0,
  fairPitchDegrees: 14.0,
  maxRollDegrees: 20.0,
  fairRollDegrees: 12.0,
};

export class FaceQualityGate implements IFaceQualityGate {
  readonly gateName = 'FaceQualityGate';
  private config: QualityGateConfig;

  constructor(config: Partial<QualityGateConfig> = {}) {
    this.config = { ...DEFAULT_QUALITY_GATE_CONFIG, ...config };
  }

  public getConfig(): QualityGateConfig {
    return { ...this.config };
  }

  public updateConfig(newConfig: Partial<QualityGateConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Evaluates face geometry, visibility, sharpness, and pose.
   * Returns complete QualityAssessment without modifying underlying measurements.
   */
  public evaluate(
    box: FaceBoundingBox,
    landmarks?: FacialLandmarks,
    confidence?: number,
    previousBox?: FaceBoundingBox,
    framePixels?: Uint8Array,
    frameWidth?: number,
    frameHeight?: number
  ): QualityAssessment {
    const assessedAtMs = Date.now();

    // -------------------------------------------------------------------------
    // A. Face Size Evaluation
    // -------------------------------------------------------------------------
    const normalizedWidth = Math.max(0, box.width);
    const normalizedHeight = Math.max(0, box.height);
    const normalizedArea = normalizedWidth * normalizedHeight;

    const baseDim = frameWidth && frameHeight ? Math.min(frameWidth, frameHeight) : 640;
    const estimatedPixelSizePx = Math.round(Math.min(normalizedWidth, normalizedHeight) * baseDim);

    let sizeState: QualityState = 'GOOD';
    if (
      normalizedWidth < this.config.minNormalizedWidth ||
      normalizedHeight < this.config.minNormalizedHeight
    ) {
      sizeState = 'POOR';
    } else if (
      normalizedWidth < this.config.fairNormalizedWidth ||
      normalizedHeight < this.config.fairNormalizedHeight
    ) {
      sizeState = 'FAIR';
    }

    // -------------------------------------------------------------------------
    // B. Bounding-Box Geometry & Aspect Ratio Evaluation
    // -------------------------------------------------------------------------
    const aspectRatio = normalizedHeight > 0.0001 ? normalizedWidth / normalizedHeight : 1.0;

    let aspectRatioState: QualityState = 'GOOD';
    if (aspectRatio < this.config.minAspectRatio || aspectRatio > this.config.maxAspectRatio) {
      aspectRatioState = 'POOR';
    } else if (
      aspectRatio < this.config.fairMinAspectRatio ||
      aspectRatio > this.config.fairMaxAspectRatio
    ) {
      aspectRatioState = 'FAIR';
    }

    let isGeometryStable = true;
    if (previousBox && previousBox.width > 0.001) {
      const scaleJump = Math.abs(normalizedWidth - previousBox.width) / previousBox.width;
      if (scaleJump > this.config.maxScaleJumpRatio) {
        isGeometryStable = false;
      }
    }

    let geometryState: QualityState = 'GOOD';
    if (!isGeometryStable || aspectRatioState === 'POOR') {
      geometryState = 'POOR';
    } else if (aspectRatioState === 'FAIR') {
      geometryState = 'FAIR';
    }

    // -------------------------------------------------------------------------
    // C. Visibility & Frame Boundary Containment Evaluation
    // -------------------------------------------------------------------------
    const x1 = Math.max(0, box.x);
    const y1 = Math.max(0, box.y);
    const x2 = Math.min(1, box.x + box.width);
    const y2 = Math.min(1, box.y + box.height);
    const interWidth = Math.max(0, x2 - x1);
    const interHeight = Math.max(0, y2 - y1);
    const interArea = interWidth * interHeight;

    const inFrameProportion = normalizedArea > 0 ? Math.min(1.0, interArea / normalizedArea) : 0;

    const isClipped =
      box.x < 0.005 ||
      box.y < 0.005 ||
      box.x + box.width > 0.995 ||
      box.y + box.height > 0.995 ||
      inFrameProportion < 0.98;

    const landmarksAvailable =
      landmarks != null &&
      landmarks.leftEye != null &&
      landmarks.rightEye != null &&
      landmarks.noseTip != null &&
      landmarks.mouthLeft != null &&
      landmarks.mouthRight != null;

    let landmarkSpread: number | undefined = undefined;
    if (landmarksAvailable && landmarks) {
      const dx = landmarks.rightEye.x - landmarks.leftEye.x;
      const dy = landmarks.rightEye.y - landmarks.leftEye.y;
      const eyeDist = Math.sqrt(dx * dx + dy * dy);
      landmarkSpread = normalizedWidth > 0 ? eyeDist / normalizedWidth : undefined;
    }

    let visibilityState: QualityState = 'GOOD';
    if (inFrameProportion < this.config.minInFrameProportion || !landmarksAvailable) {
      visibilityState = 'POOR';
    } else if (
      inFrameProportion < this.config.fairInFrameProportion ||
      isClipped ||
      (landmarkSpread !== undefined && (landmarkSpread < 0.18 || landmarkSpread > 0.75))
    ) {
      visibilityState = 'FAIR';
    }

    // -------------------------------------------------------------------------
    // D. Image Sharpness / Blur Evaluation
    // -------------------------------------------------------------------------
    let sharpnessScore = 0.5;
    if (framePixels && framePixels.length > 0) {
      // Fast sub-sampled gradient proxy comparing adjacent pixels
      const pixelCount = framePixels.length;
      const step = Math.max(1, Math.floor(pixelCount / 400));
      let sumGrad = 0;
      let samples = 0;
      for (let i = step; i < pixelCount; i += step) {
        // Compare pixel with its immediate neighbor (i - 1) to avoid stride aliasing
        const diff = Math.abs(framePixels[i] - framePixels[i - 1]);
        sumGrad += diff;
        samples++;
      }
      const avgGrad = samples > 0 ? sumGrad / samples : 0;
      sharpnessScore = Math.min(1.0, Math.max(0.0, avgGrad / 40.0));
    } else {
      // Fallback: detector confidence + landmark presence proxy
      const conf = confidence != null ? confidence : 0.75;
      const baseScore = conf * 0.7 + (landmarksAvailable ? 0.3 : 0.0);
      sharpnessScore = Math.min(1.0, Math.max(0.0, baseScore));
    }

    let sharpnessState: QualityState = 'GOOD';
    if (sharpnessScore < this.config.minSharpness) {
      sharpnessState = 'POOR';
    } else if (sharpnessScore < this.config.fairSharpness) {
      sharpnessState = 'FAIR';
    }

    // -------------------------------------------------------------------------
    // E. Head Pose / Orientation Evaluation (from 5 landmarks)
    // -------------------------------------------------------------------------
    let yawDegrees = 0;
    let pitchDegrees = 0;
    let rollDegrees = 0;
    let poseState: QualityState = 'UNKNOWN';

    if (landmarksAvailable && landmarks) {
      const le = landmarks.leftEye;
      const re = landmarks.rightEye;
      const nose = landmarks.noseTip;
      const ml = landmarks.mouthLeft;
      const mr = landmarks.mouthRight;

      // Roll: eye line angle relative to horizontal
      const eyeDx = re.x - le.x;
      const eyeDy = re.y - le.y;
      rollDegrees = Math.atan2(eyeDy, Math.max(0.0001, Math.abs(eyeDx))) * (180.0 / Math.PI);

      // Yaw: horizontal nose offset relative to eye center
      const eyeMidX = (le.x + re.x) / 2.0;
      const eyeHalfDist = Math.max(0.001, Math.abs(eyeDx) / 2.0);
      const asymmetry = (nose.x - eyeMidX) / eyeHalfDist;
      yawDegrees = Math.max(-90, Math.min(90, asymmetry * 35.0));

      // Pitch: vertical nose position relative to eye-mouth distance
      const eyeMidY = (le.y + re.y) / 2.0;
      const mouthMidY = (ml.y + mr.y) / 2.0;
      const vertSpan = Math.max(0.001, mouthMidY - eyeMidY);
      const noseRatio = (nose.y - eyeMidY) / vertSpan;
      pitchDegrees = Math.max(-90, Math.min(90, (noseRatio - 0.45) * 60.0));

      const absYaw = Math.abs(yawDegrees);
      const absPitch = Math.abs(pitchDegrees);
      const absRoll = Math.abs(rollDegrees);

      if (
        absYaw > this.config.maxYawDegrees ||
        absPitch > this.config.maxPitchDegrees ||
        absRoll > this.config.maxRollDegrees
      ) {
        poseState = 'POOR';
      } else if (
        absYaw > this.config.fairYawDegrees ||
        absPitch > this.config.fairPitchDegrees ||
        absRoll > this.config.fairRollDegrees
      ) {
        poseState = 'FAIR';
      } else {
        poseState = 'GOOD';
      }
    }

    // -------------------------------------------------------------------------
    // Overall Quality State & Primary Reason Derivation
    // -------------------------------------------------------------------------
    const metrics: QualitySignalMetrics = {
      normalizedWidth: Math.round(normalizedWidth * 10000) / 10000,
      normalizedHeight: Math.round(normalizedHeight * 10000) / 10000,
      normalizedArea: Math.round(normalizedArea * 10000) / 10000,
      estimatedPixelSizePx,
      sizeState,

      aspectRatio: Math.round(aspectRatio * 1000) / 1000,
      aspectRatioState,
      isGeometryStable,
      geometryState,

      inFrameProportion: Math.round(inFrameProportion * 1000) / 1000,
      isClipped,
      landmarksAvailable,
      landmarkSpread: landmarkSpread !== undefined ? Math.round(landmarkSpread * 1000) / 1000 : undefined,
      visibilityState,

      sharpnessScore: Math.round(sharpnessScore * 1000) / 1000,
      sharpnessState,

      yawDegrees: Math.round(yawDegrees * 10) / 10,
      pitchDegrees: Math.round(pitchDegrees * 10) / 10,
      rollDegrees: Math.round(rollDegrees * 10) / 10,
      poseState,
    };

    // State Composition
    let state: QualityState = 'GOOD';
    let primaryReason: QualityReason | undefined = undefined;

    if (
      sizeState === 'POOR' ||
      geometryState === 'POOR' ||
      visibilityState === 'POOR' ||
      sharpnessState === 'POOR' ||
      poseState === 'POOR'
    ) {
      state = 'POOR';
      if (sizeState === 'POOR') {
        primaryReason = 'TOO_SMALL';
      } else if (inFrameProportion < this.config.minInFrameProportion) {
        primaryReason = 'FRAME_CLIPPED';
      } else if (!landmarksAvailable) {
        primaryReason = 'INSUFFICIENT_LANDMARKS';
      } else if (visibilityState === 'POOR') {
        primaryReason = 'LOW_VISIBILITY';
      } else if (geometryState === 'POOR') {
        primaryReason = 'GEOMETRY_UNSTABLE';
      } else if (sharpnessState === 'POOR') {
        primaryReason = 'LOW_SHARPNESS';
      } else {
        // Pick dominant pose violation
        const yawExcess = Math.abs(yawDegrees) - this.config.maxYawDegrees;
        const pitchExcess = Math.abs(pitchDegrees) - this.config.maxPitchDegrees;
        const rollExcess = Math.abs(rollDegrees) - this.config.maxRollDegrees;
        if (rollExcess >= yawExcess && rollExcess >= pitchExcess) {
          primaryReason = 'EXCESSIVE_ROLL';
        } else if (yawExcess >= pitchExcess) {
          primaryReason = 'EXCESSIVE_YAW';
        } else {
          primaryReason = 'EXCESSIVE_PITCH';
        }
      }
    } else if (
      sizeState === 'FAIR' ||
      geometryState === 'FAIR' ||
      visibilityState === 'FAIR' ||
      sharpnessState === 'FAIR' ||
      poseState === 'FAIR'
    ) {
      state = 'FAIR';
      if (sizeState === 'FAIR') {
        primaryReason = 'TOO_SMALL';
      } else if (isClipped) {
        primaryReason = 'FRAME_CLIPPED';
      } else if (visibilityState === 'FAIR') {
        primaryReason = 'LOW_VISIBILITY';
      } else if (geometryState === 'FAIR') {
        primaryReason = 'GEOMETRY_UNSTABLE';
      } else if (sharpnessState === 'FAIR') {
        primaryReason = 'LOW_SHARPNESS';
      } else {
        const yawExcess = Math.abs(yawDegrees) - this.config.fairYawDegrees;
        const pitchExcess = Math.abs(pitchDegrees) - this.config.fairPitchDegrees;
        const rollExcess = Math.abs(rollDegrees) - this.config.fairRollDegrees;
        if (rollExcess >= yawExcess && rollExcess >= pitchExcess) {
          primaryReason = 'EXCESSIVE_ROLL';
        } else if (yawExcess >= pitchExcess) {
          primaryReason = 'EXCESSIVE_YAW';
        } else {
          primaryReason = 'EXCESSIVE_PITCH';
        }
      }
    } else if (poseState === 'UNKNOWN') {
      state = 'UNKNOWN';
      primaryReason = 'INSUFFICIENT_LANDMARKS';
    }

    // Composite quality score [0.0, 1.0]
    const sizeFactor = Math.min(1.0, normalizedWidth / 0.12);
    const aspectFactor = Math.max(0.0, 1.0 - Math.abs(aspectRatio - 0.75) / 0.5);
    const visFactor = inFrameProportion;
    const poseFactor =
      landmarksAvailable
        ? Math.max(0.0, 1.0 - (Math.abs(yawDegrees) + Math.abs(pitchDegrees) + Math.abs(rollDegrees)) / 90.0)
        : 0.5;
    const sharpFactor = sharpnessScore;

    const rawScore =
      0.25 * sizeFactor +
      0.20 * aspectFactor +
      0.20 * visFactor +
      0.20 * poseFactor +
      0.15 * sharpFactor;

    const score = Math.round(Math.min(1.0, Math.max(0.0, rawScore)) * 100) / 100;

    return {
      state,
      score,
      primaryReason,
      metrics,
      assessedAtMs,
    };
  }
}
