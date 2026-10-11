/**
 * 5-Point Facial Landmark Aligner & Crop Normalizer (Step E)
 * Feature: Isolated ML Laboratory / Perception Pipeline
 *
 * Implements standard Umeyama/similarity 2D affine alignment to canonical
 * 112x112 ArcFace/InsightFace reference coordinates:
 * - Left eye:     (38.2946, 51.6963)
 * - Right eye:    (73.5318, 51.5014)
 * - Nose tip:     (56.0252, 71.7366)
 * - Mouth left:   (41.5493, 92.3655)
 * - Mouth right:  (70.7299, 92.2041)
 *
 * Provides fallback to padded bounding box crop when landmarks are absent.
 * CRITICAL INVARIANT: NEVER uses display geometry; measured face geometry only.
 */

import type {
  FaceAlignmentMode,
  FaceBoundingBox,
  FacialLandmarks,
} from '../../../perception/contracts';

export interface AlignedCropResult {
  width: number;
  height: number;
  channels: number; // 3 (RGB)
  pixels: Float32Array; // Flattened [112 * 112 * 3] in [0, 255] or normalized
  mode: FaceAlignmentMode;
  affineMatrix?: [number, number, number, number, number, number]; // [a, -b, tx, b, a, ty]
  landmarkRmse?: number; // Residual alignment error in canonical pixels
  durationMs: number;
}

export class FaceAligner {
  /**
   * Canonical 5-point landmarks on 112x112 reference frame (InsightFace / ArcFace standard).
   */
  public static readonly CANONICAL_5PT: readonly [number, number][] = [
    [38.2946, 51.6963], // Left eye
    [73.5318, 51.5014], // Right eye
    [56.0252, 71.7366], // Nose tip
    [41.5493, 92.3655], // Mouth left
    [70.7299, 92.2041], // Mouth right
  ];

  public static readonly TARGET_WIDTH = 112;
  public static readonly TARGET_HEIGHT = 112;

  /**
   * Computes the 2D similarity transform matrix M mapping source points to target canonical points:
   * [x', y']^T = [a, -b; b, a] * [x, y]^T + [tx, ty]^T
   */
  public static computeSimilarityTransform(
    srcPoints: [number, number][],
    dstPoints: readonly [number, number][] = FaceAligner.CANONICAL_5PT
  ): [number, number, number, number, number, number] {
    const n = srcPoints.length;
    if (n < 3) {
      throw new Error(`At least 3 point correspondences required for similarity transform, got ${n}`);
    }

    let muSrcX = 0, muSrcY = 0;
    let muDstX = 0, muDstY = 0;

    for (let i = 0; i < n; i++) {
      muSrcX += srcPoints[i][0];
      muSrcY += srcPoints[i][1];
      muDstX += dstPoints[i][0];
      muDstY += dstPoints[i][1];
    }
    muSrcX /= n;
    muSrcY /= n;
    muDstX /= n;
    muDstY /= n;

    let varSrc = 0;
    let sxx = 0;
    let sxy = 0;

    for (let i = 0; i < n; i++) {
      const sx = srcPoints[i][0] - muSrcX;
      const sy = srcPoints[i][1] - muSrcY;
      const dx = dstPoints[i][0] - muDstX;
      const dy = dstPoints[i][1] - muDstY;

      varSrc += sx * sx + sy * sy;
      sxx += sx * dx + sy * dy;
      sxy += sx * dy - sy * dx;
    }

    varSrc /= n;
    sxx /= n;
    sxy /= n;

    if (varSrc < 1e-6) {
      return [1, 0, 0, 0, 1, 0];
    }

    const a = sxx / varSrc;
    const b = sxy / varSrc;

    const tx = muDstX - (a * muSrcX - b * muSrcY);
    const ty = muDstY - (b * muSrcX + a * muSrcY);

    return [a, -b, tx, b, a, ty];
  }

  /**
   * Aligns face observation into a 112x112 pixel tensor.
   * If landmarks are supplied and align=true, uses 5-point similarity transform.
   * Otherwise falls back to box crop with margin.
   */
  public static alignCrop(
    sourcePixels: Uint8Array | Float32Array | null,
    sourceWidth: number,
    sourceHeight: number,
    measuredBox: FaceBoundingBox,
    landmarks?: FacialLandmarks,
    align: boolean = true
  ): AlignedCropResult {
    const t0 = performance.now();
    const targetW = FaceAligner.TARGET_WIDTH;
    const targetH = FaceAligner.TARGET_HEIGHT;
    const outPixels = new Float32Array(targetW * targetH * 3);

    const hasLandmarks =
      landmarks &&
      landmarks.leftEye &&
      landmarks.rightEye &&
      landmarks.noseTip &&
      landmarks.mouthLeft &&
      landmarks.mouthRight;

    if (align && hasLandmarks) {
      // 1. Transform landmarks from normalized [0, 1] to pixel coordinates on source
      const srcPts: [number, number][] = [
        [landmarks.leftEye.x * sourceWidth, landmarks.leftEye.y * sourceHeight],
        [landmarks.rightEye.x * sourceWidth, landmarks.rightEye.y * sourceHeight],
        [landmarks.noseTip.x * sourceWidth, landmarks.noseTip.y * sourceHeight],
        [landmarks.mouthLeft.x * sourceWidth, landmarks.mouthLeft.y * sourceHeight],
        [landmarks.mouthRight.x * sourceWidth, landmarks.mouthRight.y * sourceHeight],
      ];

      const M = FaceAligner.computeSimilarityTransform(srcPts, FaceAligner.CANONICAL_5PT);
      const a = M[0];
      const b = M[3];
      const tx = M[2];
      const ty = M[5];
      const det = a * a + b * b;

      // Residual alignment error calculation
      let sumSqErr = 0;
      for (let i = 0; i < 5; i++) {
        const transX = a * srcPts[i][0] - b * srcPts[i][1] + tx;
        const transY = b * srcPts[i][0] + a * srcPts[i][1] + ty;
        const errX = transX - FaceAligner.CANONICAL_5PT[i][0];
        const errY = transY - FaceAligner.CANONICAL_5PT[i][1];
        sumSqErr += errX * errX + errY * errY;
      }
      const landmarkRmse = Math.sqrt(sumSqErr / 5);

      // Sample pixels via inverse similarity transform
      if (sourcePixels && det > 1e-8) {
        for (let y = 0; y < targetH; y++) {
          for (let x = 0; x < targetW; x++) {
            const dx = x - tx;
            const dy = y - ty;
            const srcX = (a * dx + b * dy) / det;
            const srcY = (-b * dx + a * dy) / det;

            const ix = Math.max(0, Math.min(sourceWidth - 1, Math.round(srcX)));
            const iy = Math.max(0, Math.min(sourceHeight - 1, Math.round(srcY)));
            const srcIdx = (iy * sourceWidth + ix) * 3;
            const dstIdx = (y * targetW + x) * 3;

            outPixels[dstIdx] = sourcePixels[srcIdx];
            outPixels[dstIdx + 1] = sourcePixels[srcIdx + 1];
            outPixels[dstIdx + 2] = sourcePixels[srcIdx + 2];
          }
        }
      } else {
        // Mock / synthetic pixel population for offline testing
        FaceAligner.fillSyntheticGradient(outPixels, targetW, targetH, 1.0);
      }

      return {
        width: targetW,
        height: targetH,
        channels: 3,
        pixels: outPixels,
        mode: 'SIMILARITY_TRANSFORM_5PT',
        affineMatrix: M,
        landmarkRmse,
        durationMs: performance.now() - t0,
      };
    }

    // Fallback: Box crop with 12% padding
    const padFactor = 0.12;
    const padW = measuredBox.width * padFactor;
    const padH = measuredBox.height * padFactor;

    const cropX = Math.max(0, measuredBox.x - padW) * sourceWidth;
    const cropY = Math.max(0, measuredBox.y - padH) * sourceHeight;
    const cropW = Math.min(1.0, measuredBox.width + 2 * padFactor) * sourceWidth;
    const cropH = Math.min(1.0, measuredBox.height + 2 * padFactor) * sourceHeight;

    if (sourcePixels && cropW > 0 && cropH > 0) {
      for (let y = 0; y < targetH; y++) {
        const sy = Math.min(sourceHeight - 1, Math.floor(cropY + (y / targetH) * cropH));
        for (let x = 0; x < targetW; x++) {
          const sx = Math.min(sourceWidth - 1, Math.floor(cropX + (x / targetW) * cropW));
          const srcIdx = (sy * sourceWidth + sx) * 3;
          const dstIdx = (y * targetW + x) * 3;

          outPixels[dstIdx] = sourcePixels[srcIdx];
          outPixels[dstIdx + 1] = sourcePixels[srcIdx + 1];
          outPixels[dstIdx + 2] = sourcePixels[srcIdx + 2];
        }
      }
    } else {
      FaceAligner.fillSyntheticGradient(outPixels, targetW, targetH, 0.7);
    }

    return {
      width: targetW,
      height: targetH,
      channels: 3,
      pixels: outPixels,
      mode: 'NONE',
      durationMs: performance.now() - t0,
    };
  }

  private static fillSyntheticGradient(
    pixels: Float32Array,
    w: number,
    h: number,
    scale: number
  ): void {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = (y * w + x) * 3;
        pixels[idx] = Math.min(255, (120 + 40 * Math.sin(x / 10)) * scale);
        pixels[idx + 1] = Math.min(255, (130 + 35 * Math.cos(y / 10)) * scale);
        pixels[idx + 2] = Math.min(255, (140 + 20 * Math.sin((x + y) / 15)) * scale);
      }
    }
  }
}
