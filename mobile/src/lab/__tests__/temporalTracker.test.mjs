/**
 * Automated Test Suite for TemporalCentroidTracker
 * Feature: Step C — Live Face Tracking Verification
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Import compiled or direct tracker implementation
// Note: We can import or mirror the mathematical logic for testing in Node
import { TemporalCentroidTracker } from '../adapters/trackers/TemporalCentroidTracker.ts';

describe('TemporalCentroidTracker — Unit & Invariant Test Suite', () => {

  it('[1] Track Creation: Creates anonymous tracks with monotonic IDs', () => {
    const tracker = new TemporalCentroidTracker({ minHitsToConfirm: 2 });
    const now = 1000;

    const detections = [
      {
        boundingBox: { x: 0.2, y: 0.3, width: 0.15, height: 0.2 },
        confidence: 0.92,
      },
      {
        boundingBox: { x: 0.6, y: 0.4, width: 0.14, height: 0.18 },
        confidence: 0.88,
      },
    ];

    const tracks = tracker.update(detections, now);
    assert.equal(tracks.length, 2, 'Should create exactly 2 tracks');
    assert.equal(tracks[0].trackId, 1, 'First track ID must be 1');
    assert.equal(tracks[1].trackId, 2, 'Second track ID must be 2');
    assert.equal(tracks[0].isConfirmed, false, 'Initial state should be tentative (minHits=2)');
    assert.equal(tracks[0].confidence, 0.92);
  });

  it('[2] Stationary Association: Associates via IoU and confirms track', () => {
    const tracker = new TemporalCentroidTracker({ minHitsToConfirm: 2 });
    let t = 1000;

    // Frame 1
    tracker.update([
      { boundingBox: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 }, confidence: 0.9 }
    ], t);

    // Frame 2 (280ms later, slightly shifted)
    t += 280;
    const tracks2 = tracker.update([
      { boundingBox: { x: 0.31, y: 0.31, width: 0.2, height: 0.2 }, confidence: 0.92 }
    ], t);

    assert.equal(tracks2.length, 1, 'Should remain 1 track');
    assert.equal(tracks2[0].trackId, 1, 'Track ID should be preserved');
    assert.equal(tracks2[0].isConfirmed, true, 'Track should be confirmed after 2 hits');
    assert.equal(tracks2[0].ageInFrames, 2, 'Age in hits should be 2');
  });

  it('[3] Moving Face Association: Associates via Centroid Gating when IoU drops below threshold', () => {
    const tracker = new TemporalCentroidTracker({
      iouThreshold: 0.40, // High IoU required for tier 1
      centroidDistanceThreshold: 0.20, // Centroid distance gating allows moving face
      minHitsToConfirm: 1,
    });

    let t = 1000;
    // Face at x=0.20
    tracker.update([
      { boundingBox: { x: 0.20, y: 0.30, width: 0.10, height: 0.10 }, confidence: 0.9 }
    ], t);

    // Face moves quickly to x=0.27 (distance = 0.07, IoU = 0.25 which is < 0.40)
    t += 280;
    const tracks2 = tracker.update([
      { boundingBox: { x: 0.27, y: 0.30, width: 0.10, height: 0.10 }, confidence: 0.95 }
    ], t);

    assert.equal(tracks2.length, 1, 'Centroid gating must maintain track association despite low IoU');
    assert.equal(tracks2[0].trackId, 1, 'Track ID must not switch');
  });

  it('[4] Missed Detection Coasting: Tolerates temporary detector gap without losing track', () => {
    const tracker = new TemporalCentroidTracker({ maxCoastDurationMs: 800 });
    let t = 1000;

    // Frame 1: Detected
    tracker.update([
      { boundingBox: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, confidence: 0.9 }
    ], t);

    // Frame 2: (280ms later, detector misses the face e.g. momentary occlusion)
    t += 280;
    const tracksMiss = tracker.update([], t);
    assert.equal(tracksMiss.length, 1, 'Track must survive in coasting state');
    assert.equal(tracksMiss[0].trackId, 1);
    assert.equal(tracksMiss[0].timeSinceLastSeenMs, 280);

    // Frame 3: (Another 280ms later, detector recovers the face)
    t += 280;
    const tracksRecover = tracker.update([
      { boundingBox: { x: 0.41, y: 0.4, width: 0.2, height: 0.2 }, confidence: 0.91 }
    ], t);

    assert.equal(tracksRecover.length, 1, 'Track must lock back on recovery');
    assert.equal(tracksRecover[0].trackId, 1, 'Track ID preserved through temporary miss');
    assert.equal(tracksRecover[0].timeSinceLastSeenMs, 0, 'Reset time since seen');
  });

  it('[5] Track Retirement: Retires track after exceeding maxCoastDurationMs', () => {
    const tracker = new TemporalCentroidTracker({ maxCoastDurationMs: 600 });
    let t = 1000;

    tracker.update([
      { boundingBox: { x: 0.4, y: 0.4, width: 0.2, height: 0.2 }, confidence: 0.9 }
    ], t);

    // After 700ms without observation (> 600ms threshold)
    t += 700;
    const tracksDead = tracker.update([], t);
    assert.equal(tracksDead.length, 0, 'Track must be retired after timeout');

    const diag = tracker.getDiagnostics();
    assert.equal(diag.totalRetired, 1, 'Telemetry records 1 retired track');
  });

  it('[6] Multi-Face Disambiguation: Tracks 3 distinct faces without ID switching', () => {
    const tracker = new TemporalCentroidTracker();
    let t = 1000;

    const f1 = { boundingBox: { x: 0.1, y: 0.2, width: 0.15, height: 0.2 }, confidence: 0.9 };
    const f2 = { boundingBox: { x: 0.4, y: 0.2, width: 0.15, height: 0.2 }, confidence: 0.9 };
    const f3 = { boundingBox: { x: 0.7, y: 0.2, width: 0.15, height: 0.2 }, confidence: 0.9 };

    tracker.update([f1, f2, f3], t);

    // Move all 3 slightly across 5 consecutive frames
    for (let frame = 1; frame <= 5; frame++) {
      t += 260;
      const moved = [
        { boundingBox: { x: 0.1 + frame * 0.01, y: 0.2, width: 0.15, height: 0.2 }, confidence: 0.9 },
        { boundingBox: { x: 0.4 - frame * 0.01, y: 0.2, width: 0.15, height: 0.2 }, confidence: 0.9 },
        { boundingBox: { x: 0.7 + frame * 0.005, y: 0.2, width: 0.15, height: 0.2 }, confidence: 0.9 },
      ];
      const results = tracker.update(moved, t);
      assert.equal(results.length, 3, `Frame ${frame}: Must keep exactly 3 tracks`);
      assert.deepEqual(
        results.map(r => r.trackId).sort(),
        [1, 2, 3],
        `Frame ${frame}: IDs [1, 2, 3] must remain stable without swaps`
      );
    }
  });

  it('[7] High-Frequency Temporal Smoothing: Advances position smoothly between detector updates', () => {
    const tracker = new TemporalCentroidTracker({ smoothingAlpha: 0.5 });
    let t = 1000;

    // Detector updates target to x=0.18 (from previous x=0.10)
    tracker.update([
      { boundingBox: { x: 0.10, y: 0.10, width: 0.20, height: 0.20 }, confidence: 0.9 }
    ], t);

    t += 280;
    tracker.update([
      { boundingBox: { x: 0.18, y: 0.10, width: 0.20, height: 0.20 }, confidence: 0.9 }
    ], t);

    // Now tick high-frequency step at 33ms intervals
    t += 33;
    const step1 = tracker.step(t);
    // Box should have moved from 0.10 towards 0.18 by alpha=0.5 -> ~0.14
    assert(step1[0].boundingBox.x > 0.10, 'Step 1 should move toward target');
    assert(step1[0].boundingBox.x < 0.18, 'Step 1 should be interpolated, not jump immediately');

    t += 33;
    const step2 = tracker.step(t);
    assert(step2[0].boundingBox.x > step1[0].boundingBox.x, 'Step 2 continues smooth progression');
  });

  it('[8] Reset: Clears all tracks and counters', () => {
    const tracker = new TemporalCentroidTracker();
    tracker.update([
      { boundingBox: { x: 0.2, y: 0.2, width: 0.1, height: 0.1 }, confidence: 0.9 }
    ], 1000);

    tracker.reset();
    const diag = tracker.getDiagnostics();
    assert.equal(diag.activeTracks, 0);
    assert.equal(diag.totalCreated, 0);
  });
});
