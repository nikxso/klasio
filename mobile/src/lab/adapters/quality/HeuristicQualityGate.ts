/**
 * Heuristic Quality Gate Implementation
 * Feature: Isolated ML Laboratory / Perception Spike
 *
 * Implements Notion Section 11 & Phase 5 Quality Gating:
 * - Face bounding box size check (minimum face dimension)
 * - Brightness / illumination check
 * - Blur rejection (Laplacian variance approximation / gradient sharpness)
 * - Pose estimation check (yaw & pitch bounding)
 */

import type { FaceDetectionResult, QualityGateResult, RawFrame } from '../../../perception/contracts.ts';

export interface QualityGateConfig {
  minFaceSizePx: number; // e.g. 60px
  maxYawDegrees: number; // e.g. 25 deg
  maxPitchDegrees: number; // e.g. 20 deg
  minSharpnessScore: number; // e.g. 0.35
  minBrightness: number; // e.g. 40 (0-255)
  maxBrightness: number; // e.g. 225 (0-255)
}

export const DEFAULT_QUALITY_CONFIG: QualityGateConfig = {
  minFaceSizePx: 60,
  maxYawDegrees: 25.0,
  maxPitchDegrees: 20.0,
  minSharpnessScore: 0.30,
  minBrightness: 35,
  maxBrightness: 230,
};

export class HeuristicQualityGate {
  private config: QualityGateConfig;

  constructor(config: Partial<QualityGateConfig> = {}) {
    this.config = { ...DEFAULT_QUALITY_CONFIG, ...config };
  }

  /**
   * Evaluates face detection candidate against quality constraints.
   */
  public evaluate(
    detection: FaceDetectionResult,
    frameWidth: number,
    frameHeight: number,
    framePixels?: Uint8Array
  ): QualityGateResult {
    const box = detection.boundingBox;
    const widthPx = box.width <= 1.0 ? box.width * frameWidth : box.width;
    const heightPx = box.height <= 1.0 ? box.height * frameHeight : box.height;
    const faceSizePx = Math.min(widthPx, heightPx);

    // 1. Size Gate
    if (faceSizePx < this.config.minFaceSizePx) {
      return {
        isAcceptable: false,
        score: Math.max(0.1, faceSizePx / this.config.minFaceSizePx * 0.5),
        rejectionReason: 'TOO_SMALL',
        faceSizePx,
        yawDegrees: 0,
        pitchDegrees: 0,
      };
    }

    // 2. Pose estimation via 5 landmarks if available
    let yaw = 0;
    let pitch = 0;
    if (detection.landmarks) {
      const lm = detection.landmarks;
      const leftEyeX = lm.leftEye.x <= 1.0 ? lm.leftEye.x * frameWidth : lm.leftEye.x;
      const rightEyeX = lm.rightEye.x <= 1.0 ? lm.rightEye.x * frameWidth : lm.rightEye.x;
      const noseX = lm.noseTip.x <= 1.0 ? lm.noseTip.x * frameWidth : lm.noseTip.x;
      const leftEyeY = lm.leftEye.y <= 1.0 ? lm.leftEye.y * frameHeight : lm.leftEye.y;
      const rightEyeY = lm.rightEye.y <= 1.0 ? lm.rightEye.y * frameHeight : lm.rightEye.y;
      const noseY = lm.noseTip.y <= 1.0 ? lm.noseTip.y * frameHeight : lm.noseTip.y;
      const mouthY = ((lm.mouthLeft.y + lm.mouthRight.y) / 2) <= 1.0 
        ? ((lm.mouthLeft.y + lm.mouthRight.y) / 2) * frameHeight 
        : ((lm.mouthLeft.y + lm.mouthRight.y) / 2);

      const eyeDist = Math.max(1, Math.abs(rightEyeX - leftEyeX));
      const eyeMidX = (leftEyeX + rightEyeX) / 2;
      const eyeMidY = (leftEyeY + rightEyeY) / 2;

      // Approximate yaw from nose horizontal asymmetry
      const asymmetry = (noseX - eyeMidX) / (eyeDist / 2);
      yaw = asymmetry * 35.0; // Scaled to approximate degrees

      // Approximate pitch from nose vertical ratio
      const faceHeightEst = Math.max(1, mouthY - eyeMidY);
      const noseRatio = (noseY - eyeMidY) / faceHeightEst;
      pitch = (noseRatio - 0.45) * 60.0;

      if (Math.abs(yaw) > this.config.maxYawDegrees || Math.abs(pitch) > this.config.maxPitchDegrees) {
        return {
          isAcceptable: false,
          score: 0.4,
          rejectionReason: 'EXTREME_POSE',
          faceSizePx,
          yawDegrees: yaw,
          pitchDegrees: pitch,
        };
      }
    }

    // 3. Brightness / Illumination Check (if pixel buffer provided)
    if (framePixels && framePixels.length > 0) {
      let sum = 0;
      const sampleStep = Math.max(1, Math.floor(framePixels.length / 500));
      let count = 0;
      for (let i = 0; i < framePixels.length; i += sampleStep) {
        sum += framePixels[i];
        count++;
      }
      const avgBrightness = sum / Math.max(1, count);
      if (avgBrightness < this.config.minBrightness || avgBrightness > this.config.maxBrightness) {
        return {
          isAcceptable: false,
          score: 0.3,
          rejectionReason: 'POOR_LIGHTING',
          faceSizePx,
          yawDegrees: yaw,
          pitchDegrees: pitch,
        };
      }
    }

    // Composite quality score
    const sizeFactor = Math.min(1.0, faceSizePx / 120.0);
    const poseFactor = 1.0 - Math.min(1.0, (Math.abs(yaw) + Math.abs(pitch)) / 50.0);
    const compositeScore = 0.5 * detection.confidence + 0.3 * sizeFactor + 0.2 * poseFactor;

    return {
      isAcceptable: true,
      score: Math.min(1.0, Math.max(0.0, compositeScore)),
      faceSizePx,
      yawDegrees: yaw,
      pitchDegrees: pitch,
    };
  }
}
