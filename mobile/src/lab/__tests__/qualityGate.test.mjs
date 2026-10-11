/**
 * Automated Test Suite for FaceQualityGate & Step D Invariants
 * Feature: Step D — Face Quality & Visibility Gate
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FaceQualityGate, DEFAULT_QUALITY_GATE_CONFIG } from '../adapters/quality/FaceQualityGate.ts';
import { TemporalCentroidTracker } from '../adapters/trackers/TemporalCentroidTracker.ts';

// Standard frontal landmarks helper
function createFrontalLandmarks(cx = 0.30, cy = 0.30, size = 0.15) {
  const eyeSpan = size * 0.40;
  const vertSpan = size * 0.50;
  return {
    leftEye: { x: cx - eyeSpan / 2, y: cy - vertSpan * 0.25 },
    rightEye: { x: cx + eyeSpan / 2, y: cy - vertSpan * 0.25 },
    noseTip: { x: cx, y: cy },
    mouthLeft: { x: cx - eyeSpan * 0.4, y: cy + vertSpan * 0.35 },
    mouthRight: { x: cx + eyeSpan * 0.4, y: cy + vertSpan * 0.35 },
  };
}

describe('FaceQualityGate — Unit & Invariant Test Suite', () => {

  it('[1] Face Size: Distinguishes GOOD, FAIR, and POOR (TOO_SMALL) relative to frame', () => {
    const gate = new FaceQualityGate();

    // 1A. High-quality face (15% width x 20% height)
    const goodBox = { x: 0.20, y: 0.20, width: 0.15, height: 0.20 };
    const goodLm = createFrontalLandmarks(0.275, 0.30, 0.18);
    const resGood = gate.evaluate(goodBox, goodLm, 0.95);
    assert.equal(resGood.metrics.sizeState, 'GOOD');
    assert.equal(resGood.state, 'GOOD');
    assert.equal(resGood.primaryReason, undefined);

    // 1B. Borderline/FAIR face (6% width x 8% height)
    const fairBox = { x: 0.20, y: 0.20, width: 0.065, height: 0.085 };
    const fairLm = createFrontalLandmarks(0.23, 0.24, 0.07);
    const resFair = gate.evaluate(fairBox, fairLm, 0.85);
    assert.equal(resFair.metrics.sizeState, 'FAIR');
    assert.equal(resFair.state, 'FAIR');
    assert.equal(resFair.primaryReason, 'TOO_SMALL');

    // 1C. Too small / distant face (3% width x 4% height)
    const poorBox = { x: 0.20, y: 0.20, width: 0.03, height: 0.04 };
    const poorLm = createFrontalLandmarks(0.215, 0.22, 0.035);
    const resPoor = gate.evaluate(poorBox, poorLm, 0.70);
    assert.equal(resPoor.metrics.sizeState, 'POOR');
    assert.equal(resPoor.state, 'POOR');
    assert.equal(resPoor.primaryReason, 'TOO_SMALL');
  });

  it('[2] Bounding-Box Geometry: Flags extreme aspect ratios (slivers and pancakes)', () => {
    const gate = new FaceQualityGate();

    // 2A. Extreme narrow sliver (width=0.03, height=0.15, ratio=0.20 < min 0.50)
    const sliverBox = { x: 0.40, y: 0.30, width: 0.03, height: 0.15 };
    const resSliver = gate.evaluate(sliverBox, undefined, 0.80);
    assert.equal(resSliver.metrics.aspectRatioState, 'POOR');
    assert.equal(resSliver.state, 'POOR');

    // 2B. Extreme pancake wide box (width=0.25, height=0.12, ratio=2.08 > max 1.20)
    const wideBox = { x: 0.40, y: 0.30, width: 0.25, height: 0.12 };
    const resWide = gate.evaluate(wideBox, undefined, 0.80);
    assert.equal(resWide.metrics.aspectRatioState, 'POOR');
    assert.equal(resWide.state, 'POOR');

    // 2C. Natural aspect ratio (width=0.15, height=0.20, ratio=0.75)
    const normalBox = { x: 0.40, y: 0.30, width: 0.15, height: 0.20 };
    const resNormal = gate.evaluate(normalBox, createFrontalLandmarks(0.475, 0.40, 0.18), 0.90);
    assert.equal(resNormal.metrics.aspectRatioState, 'GOOD');
    assert.equal(resNormal.metrics.aspectRatio, 0.75);
  });

  it('[3] Sudden Geometry Change: Rejects abrupt scale jump between consecutive updates', () => {
    const gate = new FaceQualityGate();
    const prevBox = { x: 0.30, y: 0.30, width: 0.10, height: 0.14 };

    // Sudden 70% width jump (> 50% maxScaleJumpRatio)
    const jumpBox = { x: 0.30, y: 0.30, width: 0.17, height: 0.22 };
    const resJump = gate.evaluate(jumpBox, createFrontalLandmarks(0.38, 0.41, 0.19), 0.90, prevBox);
    assert.equal(resJump.metrics.isGeometryStable, false, 'Should flag sudden jump as unstable');
    assert.equal(resJump.metrics.geometryState, 'POOR');
    assert.equal(resJump.state, 'POOR');
    assert.equal(resJump.primaryReason, 'GEOMETRY_UNSTABLE');

    // Smooth minor scale variation (10% change)
    const smoothBox = { x: 0.30, y: 0.30, width: 0.11, height: 0.15 };
    const resSmooth = gate.evaluate(smoothBox, createFrontalLandmarks(0.35, 0.37, 0.13), 0.90, prevBox);
    assert.equal(resSmooth.metrics.isGeometryStable, true);
    assert.equal(resSmooth.metrics.geometryState, 'GOOD');
  });

  it('[4] Frame Boundary Clipping & Visibility: Evaluates containment proportion', () => {
    const gate = new FaceQualityGate();

    // 4A. Face 50% clipped outside left edge of frame
    const clippedBox = { x: -0.075, y: 0.30, width: 0.15, height: 0.20 };
    const resClipped = gate.evaluate(clippedBox, undefined, 0.85);
    assert(resClipped.metrics.inFrameProportion < 0.60, 'Containment should be ~50%');
    assert.equal(resClipped.metrics.isClipped, true);
    assert.equal(resClipped.state, 'POOR');
    assert.equal(resClipped.primaryReason, 'FRAME_CLIPPED');

    // 4B. Face near edge but 96% inside frame (FAIR)
    const edgeBox = { x: 0.002, y: 0.30, width: 0.15, height: 0.20 };
    const edgeLm = createFrontalLandmarks(0.077, 0.40, 0.16);
    const resEdge = gate.evaluate(edgeBox, edgeLm, 0.90);
    assert.equal(resEdge.metrics.isClipped, true);
    assert.equal(resEdge.metrics.visibilityState, 'FAIR');
  });

  it('[5] Landmark Completeness: Rejects observation when landmarks are missing', () => {
    const gate = new FaceQualityGate();
    const box = { x: 0.20, y: 0.20, width: 0.15, height: 0.20 };

    // Detection with no landmarks
    const resNoLm = gate.evaluate(box, undefined, 0.90);
    assert.equal(resNoLm.metrics.landmarksAvailable, false);
    assert.equal(resNoLm.metrics.poseState, 'UNKNOWN');
    assert.equal(resNoLm.state, 'POOR');
    assert.equal(resNoLm.primaryReason, 'INSUFFICIENT_LANDMARKS');
  });

  it('[6] Sharpness / Blur: Detects motion-blurred or uniform flat frames', () => {
    const gate = new FaceQualityGate();
    const box = { x: 0.20, y: 0.20, width: 0.15, height: 0.20 };
    const lm = createFrontalLandmarks(0.275, 0.30, 0.18);

    // 6A. Completely uniform / zero-contrast pixel buffer (severe blur)
    const blurryPixels = new Uint8Array(1000).fill(128);
    const resBlur = gate.evaluate(box, lm, 0.90, undefined, blurryPixels);
    assert.equal(resBlur.metrics.sharpnessScore, 0.0);
    assert.equal(resBlur.metrics.sharpnessState, 'POOR');
    assert.equal(resBlur.state, 'POOR');
    assert.equal(resBlur.primaryReason, 'LOW_SHARPNESS');

    // 6B. High-contrast sharp texture pixels
    const sharpPixels = new Uint8Array(1000);
    for (let i = 0; i < 1000; i++) sharpPixels[i] = (i % 2 === 0) ? 250 : 10;
    const resSharp = gate.evaluate(box, lm, 0.90, undefined, sharpPixels);
    assert(resSharp.metrics.sharpnessScore > 0.50, 'Sharp texture should have high score');
    assert.equal(resSharp.metrics.sharpnessState, 'GOOD');
  });

  it('[7] Head Pose / Orientation: Flags excessive yaw, pitch, and roll', () => {
    const gate = new FaceQualityGate();
    const box = { x: 0.20, y: 0.20, width: 0.15, height: 0.20 };

    // 7A. Extreme Yaw Turn (Nose shifted far to the right eye)
    const yawLm = createFrontalLandmarks(0.275, 0.30, 0.18);
    yawLm.noseTip.x = yawLm.rightEye.x + 0.01; // Extreme horizontal asymmetry
    const resYaw = gate.evaluate(box, yawLm, 0.90);
    assert(Math.abs(resYaw.metrics.yawDegrees) > 28.0, 'Yaw should exceed 28 deg');
    assert.equal(resYaw.metrics.poseState, 'POOR');
    assert.equal(resYaw.primaryReason, 'EXCESSIVE_YAW');

    // 7B. Extreme Pitch Down (Nose placed far down near mouth)
    const pitchLm = createFrontalLandmarks(0.275, 0.30, 0.18);
    pitchLm.noseTip.y = pitchLm.mouthLeft.y - 0.005; // Extreme vertical ratio
    const resPitch = gate.evaluate(box, pitchLm, 0.90);
    assert(Math.abs(resPitch.metrics.pitchDegrees) > 22.0, 'Pitch should exceed 22 deg');
    assert.equal(resPitch.metrics.poseState, 'POOR');
    assert.equal(resPitch.primaryReason, 'EXCESSIVE_PITCH');

    // 7C. Extreme Roll / Head Tilt (Eyes rotated by 25 deg around center)
    const rollAngle = (25.0 * Math.PI) / 180.0;
    const rollLm = createFrontalLandmarks(0.275, 0.30, 0.18);
    const halfEye = (rollLm.rightEye.x - rollLm.leftEye.x) / 2;
    rollLm.leftEye.x = 0.275 - halfEye * Math.cos(rollAngle);
    rollLm.leftEye.y = 0.255 - halfEye * Math.sin(rollAngle);
    rollLm.rightEye.x = 0.275 + halfEye * Math.cos(rollAngle);
    rollLm.rightEye.y = 0.255 + halfEye * Math.sin(rollAngle);
    const resRoll = gate.evaluate(box, rollLm, 0.90);
    assert(Math.abs(resRoll.metrics.rollDegrees) > 20.0, 'Roll should exceed 20 deg');
    assert.equal(resRoll.metrics.poseState, 'POOR');
    assert.equal(resRoll.primaryReason, 'EXCESSIVE_ROLL');
  });

  it('[8] State Transitions: Smooth transitions between GOOD, FAIR, POOR, and recovery', () => {
    const gate = new FaceQualityGate();

    // Step 1: Frontal, large face -> GOOD
    const b1 = { x: 0.20, y: 0.20, width: 0.14, height: 0.19 };
    const res1 = gate.evaluate(b1, createFrontalLandmarks(0.27, 0.29, 0.17), 0.92);
    assert.equal(res1.state, 'GOOD');

    // Step 2: Subject turns head mildly (yaw ~19°) -> FAIR
    const lm2 = createFrontalLandmarks(0.27, 0.29, 0.17);
    lm2.noseTip.x += 0.020;
    const res2 = gate.evaluate(b1, lm2, 0.90);
    assert.equal(res2.state, 'FAIR');
    assert.equal(res2.primaryReason, 'EXCESSIVE_YAW');

    // Step 3: Subject steps far away (width shrinks to 3.5%) -> POOR
    const b3 = { x: 0.20, y: 0.20, width: 0.035, height: 0.045 };
    const res3 = gate.evaluate(b3, createFrontalLandmarks(0.217, 0.22, 0.04), 0.75);
    assert.equal(res3.state, 'POOR');
    assert.equal(res3.primaryReason, 'TOO_SMALL');

    // Step 4: Subject steps back closer to camera -> Recovers to GOOD
    const res4 = gate.evaluate(b1, createFrontalLandmarks(0.27, 0.29, 0.17), 0.94);
    assert.equal(res4.state, 'GOOD');
    assert.equal(res4.primaryReason, undefined);
  });

  it('[9] HARD INVARIANT: POOR Quality does NOT destroy or retire an active track', () => {
    const gate = new FaceQualityGate();
    const tracker = new TemporalCentroidTracker({ minHitsToConfirm: 2 }, gate);
    let t = 1000;

    // Frame 1: Detection of large frontal face
    const detGood1 = {
      boundingBox: { x: 0.20, y: 0.20, width: 0.15, height: 0.20 },
      landmarks: createFrontalLandmarks(0.275, 0.30, 0.18),
      confidence: 0.95,
    };
    tracker.update([detGood1], t);

    // Frame 2: Confirmed track
    t += 280;
    const tracks2 = tracker.update([detGood1], t);
    assert.equal(tracks2.length, 1);
    assert.equal(tracks2[0].trackId, 1);
    assert.equal(tracks2[0].isConfirmed, true);
    assert.equal(tracks2[0].quality?.state, 'GOOD');

    // Frame 3: Subject moves far away, face becomes tiny (POOR quality)
    t += 280;
    const detTiny = {
      boundingBox: { x: 0.25, y: 0.25, width: 0.03, height: 0.04 },
      landmarks: createFrontalLandmarks(0.265, 0.27, 0.035),
      confidence: 0.70,
    };
    const tracks3 = tracker.update([detTiny], t);

    // CRITICAL ASSERTION: Track MUST NOT be retired or lost!
    assert.equal(tracks3.length, 1, 'Track must survive poor quality update');
    assert.equal(tracks3[0].trackId, 1, 'Track ID must be preserved');
    assert.equal(tracks3[0].isConfirmed, true, 'Confirmed status must remain intact');
    assert.equal(tracks3[0].quality?.state, 'POOR', 'Quality assessment reflects POOR');
    assert.equal(tracks3[0].quality?.primaryReason, 'TOO_SMALL');

    // Frame 4: Subject moves back to normal distance -> Quality recovers
    t += 280;
    const tracks4 = tracker.update([detGood1], t);
    assert.equal(tracks4.length, 1);
    assert.equal(tracks4[0].trackId, 1, 'Same track ID persists through recovery');
    assert.equal(tracks4[0].quality?.state, 'GOOD', 'Quality recovers to GOOD');
  });

  it('[10] GEOMETRY SEPARATION: Display box stabilizes aspect ratio without altering measured/quality geometry', () => {
    // Distorted detector output: narrow sliver (w=0.04, h=0.10, ratio=0.40)
    const rawBox = { x: 0.30, y: 0.20, width: 0.04, height: 0.10 };
    const dispBox = TemporalCentroidTracker.computeDisplayBox(rawBox, 0.75);

    // 1. Centroid is preserved
    const rawCx = rawBox.x + rawBox.width / 2; // 0.32
    const dispCx = dispBox.x + dispBox.width / 2; // ~0.32
    assert(Math.abs(rawCx - dispCx) < 0.001, 'Centroid X must be preserved');

    // 2. Aspect ratio is normalized towards 0.75
    const dispAspect = dispBox.width / dispBox.height;
    assert(Math.abs(dispAspect - 0.75) < 0.05, 'Display box aspect ratio should be ~0.75');

    // 3. Area is conserved (no artificial expansion!)
    const rawArea = rawBox.width * rawBox.height;
    const dispArea = dispBox.width * dispBox.height;
    assert(Math.abs(rawArea - dispArea) < 0.001, 'Display box must NOT artificially inflate face area');

    // 4. Quality evaluation uses measured geometry, not display geometry
    const gate = new FaceQualityGate();
    const qRaw = gate.evaluate(rawBox, undefined, 0.85);
    const qDisp = gate.evaluate(dispBox, undefined, 0.85);

    // qRaw accurately flags narrow aspect ratio
    assert.equal(qRaw.metrics.aspectRatioState, 'POOR', 'Quality measurement evaluates true raw geometry');
    assert.notEqual(qRaw.metrics.aspectRatio, qDisp.metrics.aspectRatio);
  });
});
