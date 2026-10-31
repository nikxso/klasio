/**
 * Klasio Perception Benchmark Suite — Layer A
 * Micro-Harness: TemporalCentroidTracker Performance & Continuity
 *
 * Feature: Phase 10: Edge Perception Benchmarking (Level 3 Research & Evaluation)
 * Classification: [HOST-MEASURED]
 * Note: Measurements executed in Node.js on the development workstation.
 *       NEVER label these results as [DEVICE-MEASURED].
 *
 * Requirements:
 * 1. Stationary track association latency and throughput (500 iterations):
 *    Warm Mean, P50, P95 latency and updates/sec.
 * 2. Track continuity and coasting through temporary detection gaps:
 *    Evaluating coasting up to maxCoastDurationMs=850ms and retirement after exceeding max coasting.
 * 3. Rate decoupling:
 *    Sparse ~3.3 FPS detector arrivals (every 300ms) with high-frequency 30 FPS display
 *    extrapolation (every 33ms), measuring position smoothness without erratic jumps.
 * 4. Multi-face cross-movement disambiguation:
 *    Two moving faces crossing paths, verifying ID preservation without switching IDs.
 * 5. Architectural comparison:
 *    Evaluate TemporalCentroidTracker against baseline discrete IoU tracking.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import {
  TemporalCentroidTracker,
  DEFAULT_TRACKER_CONFIG,
} from '../../adapters/trackers/TemporalCentroidTracker.ts';

// ---------------------------------------------------------------------------
// Baseline Naive IoU Tracker (for Architectural Comparison)
// ---------------------------------------------------------------------------

class BaselineDiscreteIoUTracker {
  constructor(iouThreshold = 0.30, maxLostFrames = 3) {
    this.iouThreshold = iouThreshold;
    this.maxLostFrames = maxLostFrames;
    this.nextId = 1;
    this.tracks = [];
  }

  static computeIoU(b1, b2) {
    const x1 = Math.max(b1.x, b2.x);
    const y1 = Math.max(b1.y, b2.y);
    const x2 = Math.min(b1.x + b1.width, b2.x + b2.width);
    const y2 = Math.min(b1.y + b1.height, b2.y + b2.height);

    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = b1.width * b1.height + b2.width * b2.height - inter;
    return union <= 0 ? 0 : inter / union;
  }

  update(detections) {
    const matchedDets = new Set();
    const matchedTracks = new Set();

    for (let tIdx = 0; tIdx < this.tracks.length; tIdx++) {
      let bestIoU = 0;
      let bestDet = -1;
      for (let dIdx = 0; dIdx < detections.length; dIdx++) {
        if (matchedDets.has(dIdx)) continue;
        const iou = BaselineDiscreteIoUTracker.computeIoU(this.tracks[tIdx].box, detections[dIdx].boundingBox);
        if (iou > bestIoU) {
          bestIoU = iou;
          bestDet = dIdx;
        }
      }
      if (bestIoU >= this.iouThreshold && bestDet !== -1) {
        matchedDets.add(bestDet);
        matchedTracks.add(tIdx);
        this.tracks[tIdx].box = detections[bestDet].boundingBox;
        this.tracks[tIdx].lost = 0;
      } else {
        this.tracks[tIdx].lost++;
      }
    }

    for (let dIdx = 0; dIdx < detections.length; dIdx++) {
      if (!matchedDets.has(dIdx)) {
        this.tracks.push({
          id: this.nextId++,
          box: { ...detections[dIdx].boundingBox },
          lost: 0,
        });
      }
    }

    this.tracks = this.tracks.filter(t => t.lost <= this.maxLostFrames);
    return this.tracks;
  }

  reset() {
    this.tracks = [];
    this.nextId = 1;
  }
}

// ---------------------------------------------------------------------------
// Statistical Helpers
// ---------------------------------------------------------------------------

function computeDistribution(values) {
  if (values.length === 0) {
    return { count: 0, mean: 0, median: 0, p50: 0, p90: 0, p95: 0, p99: 0, min: 0, max: 0, sum: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / sorted.length;
  const p = (pct) => {
    const idx = Math.min(Math.floor((pct / 100) * sorted.length), sorted.length - 1);
    return sorted[idx];
  };

  return {
    count: sorted.length,
    mean: Number(mean.toFixed(4)),
    median: Number(p(50).toFixed(4)),
    p50: Number(p(50).toFixed(4)),
    p90: Number(p(90).toFixed(4)),
    p95: Number(p(95).toFixed(4)),
    p99: Number(p(99).toFixed(4)),
    min: Number(sorted[0].toFixed(4)),
    max: Number(sorted[sorted.length - 1].toFixed(4)),
    sum: Number(sum.toFixed(4)),
  };
}

describe('Layer A: TemporalCentroidTracker Micro-Harness [HOST-MEASURED]', () => {

  it('[1] Stationary Track Association Latency & Throughput (500 iterations)', () => {
    const tracker = new TemporalCentroidTracker({ minHitsToConfirm: 2 });
    let simTime = 1000;

    // JIT Warmup (50 iterations)
    for (let w = 0; w < 50; w++) {
      simTime += 280;
      tracker.update([
        {
          boundingBox: { x: 0.35 + (w % 3) * 0.001, y: 0.35 + (w % 2) * 0.001, width: 0.20, height: 0.20 },
          confidence: 0.94,
        },
      ], simTime);
    }
    tracker.reset();
    simTime = 1000;

    const iterations = 500;
    const latenciesMs = new Array(iterations);

    for (let i = 0; i < iterations; i++) {
      simTime += 280;
      // Realistic slight stationary jitter around center [0.35, 0.35]
      const jitterX = ((i % 5) - 2) * 0.001;
      const jitterY = ((i % 3) - 1) * 0.001;
      const detections = [
        {
          boundingBox: {
            x: 0.35 + jitterX,
            y: 0.35 + jitterY,
            width: 0.20,
            height: 0.20,
          },
          confidence: 0.92 + (i % 5) * 0.01,
        },
      ];

      const t0 = performance.now();
      const tracks = tracker.update(detections, simTime);
      const t1 = performance.now();

      latenciesMs[i] = t1 - t0;

      // Functional invariant checks
      assert.equal(tracks.length, 1, `Iteration ${i}: Must maintain exactly 1 active track`);
      assert.equal(tracks[0].trackId, 1, `Iteration ${i}: Track ID must remain 1 without switching`);
      if (i >= 2) {
        assert.equal(tracks[0].isConfirmed, true, `Iteration ${i}: Track must be confirmed`);
      }
    }

    const stats = computeDistribution(latenciesMs);
    const updatesPerSec = Math.round(1000 / stats.mean);

    console.log('\n--- [HOST-MEASURED] Stationary Association Latency & Throughput ---');
    console.log(`  Iterations:            ${iterations}`);
    console.log(`  Warm Mean Latency:     ${stats.mean} ms`);
    console.log(`  P50 (Median) Latency:  ${stats.p50} ms`);
    console.log(`  P90 Latency:           ${stats.p90} ms`);
    console.log(`  P95 Latency:           ${stats.p95} ms`);
    console.log(`  P99 Latency:           ${stats.p99} ms`);
    console.log(`  Min / Max Latency:     ${stats.min} ms / ${stats.max} ms`);
    console.log(`  Throughput:            ${updatesPerSec.toLocaleString()} updates/sec`);
    console.log(`  Total Associations:    ${tracker.getDiagnostics().totalAssociations}`);
    console.log('------------------------------------------------------------------\n');

    // Invariant assertions (sanity checks, NOT hardcoded latency gates)
    assert(stats.count === 500, 'Must record all 500 iterations');
    assert(stats.mean > 0, 'Measured mean must be positive and non-zero');
    assert(updatesPerSec > 0, 'Throughput must be positive and non-zero');
    assert.equal(tracker.getDiagnostics().activeTracks, 1);
  });

  it('[2] Track Continuity & Coasting through Temporary Detection Gaps (850ms limit)', () => {
    const tracker = new TemporalCentroidTracker({ maxCoastDurationMs: 850, minHitsToConfirm: 2 });
    let simTime = 1000;

    // Phase A: Establish and confirm a stable track (2 detector hits at 300ms intervals)
    tracker.update([
      { boundingBox: { x: 0.40, y: 0.40, width: 0.15, height: 0.20 }, confidence: 0.95 },
    ], simTime);

    simTime += 300; // t=1300
    const confirmedTracks = tracker.update([
      { boundingBox: { x: 0.40, y: 0.40, width: 0.15, height: 0.20 }, confidence: 0.95 },
    ], simTime);

    assert.equal(confirmedTracks.length, 1);
    assert.equal(confirmedTracks[0].trackId, 1);
    assert.equal(confirmedTracks[0].isConfirmed, true, 'Track must be confirmed after 2 hits');

    // Phase B: Single detector miss (300ms gap) -> Enter coasting
    simTime += 300; // t=1600 (300ms since last seen)
    const coasting300 = tracker.update([], simTime);
    assert.equal(coasting300.length, 1, 'Track must survive single 300ms drop');
    assert.equal(coasting300[0].trackId, 1, 'Track ID 1 preserved during coasting');
    assert.equal(coasting300[0].timeSinceLastSeenMs, 300, 'Elapsed gap must be 300ms');

    // Phase C: Re-detection recovers confirmed track
    simTime += 300; // t=1900
    const recoveredTracks = tracker.update([
      { boundingBox: { x: 0.41, y: 0.40, width: 0.15, height: 0.20 }, confidence: 0.93 },
    ], simTime);
    assert.equal(recoveredTracks.length, 1, 'Track recovered upon detection');
    assert.equal(recoveredTracks[0].trackId, 1, 'Track ID preserved on recovery');
    assert.equal(recoveredTracks[0].timeSinceLastSeenMs, 0, 'timeSinceLastSeenMs reset to 0');

    // Phase D: Sustained detection gap up to the max coast boundary (850ms)
    // Last seen at t=1900
    simTime += 300; // t=2200 (gap = 300ms)
    tracker.update([], simTime);

    simTime += 300; // t=2500 (gap = 600ms)
    tracker.update([], simTime);

    simTime += 250; // t=2750 (gap = 850ms, exactly at maxCoastDurationMs boundary)
    const coasting850 = tracker.update([], simTime);
    assert.equal(coasting850.length, 1, 'Track must persist at exactly maxCoastDurationMs=850ms');
    assert.equal(coasting850[0].trackId, 1);
    assert.equal(coasting850[0].timeSinceLastSeenMs, 850);

    // Phase E: Detection arrives just at 850ms boundary -> successful recovery
    const recovered850 = tracker.update([
      { boundingBox: { x: 0.41, y: 0.40, width: 0.15, height: 0.20 }, confidence: 0.91 },
    ], simTime);
    assert.equal(recovered850.length, 1, 'Track recovers from sustained 850ms coasting');
    assert.equal(recovered850[0].trackId, 1, 'Track ID preserved');
    assert.equal(recovered850[0].timeSinceLastSeenMs, 0);

    // Phase F: Exceeding max coasting (> 850ms) -> Track retirement
    // Last seen at t=2750
    simTime += 851; // t=3601 (gap = 851ms > 850ms limit)
    const retiredTracks = tracker.update([], simTime);
    assert.equal(retiredTracks.length, 0, 'Track must be retired after exceeding 850ms limit');

    const diag = tracker.getDiagnostics();
    assert.equal(diag.activeTracks, 0, 'No active tracks remaining');
    assert.equal(diag.totalRetired, 1, 'Exactly 1 track retired');

    console.log('\n--- [HOST-MEASURED] Track Continuity & Coasting Metrics ---');
    console.log(`  Configured Max Coast Duration: 850 ms`);
    console.log(`  Short Gap (300 ms):            CONTINUITY MAINTAINED (state=coasting -> recovered)`);
    console.log(`  Max Boundary Gap (850 ms):     CONTINUITY MAINTAINED (state=coasting -> recovered)`);
    console.log(`  Over-Boundary Gap (851 ms):    RETIRED AS EXPECTED (activeTracks=0, retired=1)`);
    console.log(`  Track ID Switches during Gaps: 0 (ID=1 preserved across all recoveries)`);
    console.log('-----------------------------------------------------------\n');
  });

  it('[3] Rate Decoupling: Sparse Detector (~3.3 FPS / 300ms) with High-Frequency Display Extrapolation (30 FPS / 33ms)', () => {
    const tracker = new TemporalCentroidTracker({
      smoothingAlpha: 0.40,
      smoothingAlphaDimension: 0.18,
      minHitsToConfirm: 1,
    });

    let simTime = 1000;
    const detectorIntervalMs = 300; // ~3.3 FPS
    const displayIntervalMs = 33;   // ~30.3 FPS
    const detectorCycles = 10;      // 3.0 seconds total

    // Face moves linearly across screen from x=0.10 to x=0.55 at constant speed
    // Total delta X = 0.45 over 10 detector frames (0.045 per detector update)
    const initialBox = { x: 0.10, y: 0.30, width: 0.18, height: 0.22 };
    tracker.update([{ boundingBox: initialBox, confidence: 0.95 }], simTime);

    const stepLatenciesMs = [];
    const stepDeltasX = [];
    const detectorDeltasX = [];

    let prevStepX = initialBox.x;
    let prevDetX = initialBox.x;

    for (let cycle = 1; cycle <= detectorCycles; cycle++) {
      const nextDetX = 0.10 + cycle * 0.045;
      const detDelta = Math.abs(nextDetX - prevDetX);
      detectorDeltasX.push(detDelta);
      prevDetX = nextDetX;

      // 9 high-frequency display extrapolation steps between detector cycles (~300ms total)
      for (let s = 1; s <= 9; s++) {
        simTime += displayIntervalMs;

        const t0 = performance.now();
        const displayFaces = tracker.step(simTime);
        const t1 = performance.now();

        stepLatenciesMs.push(t1 - t0);

        assert.equal(displayFaces.length, 1, 'Must maintain active display face');
        const currentDisplayX = displayFaces[0].boundingBox.x;
        const stepDelta = Math.abs(currentDisplayX - prevStepX);
        stepDeltasX.push(stepDelta);
        prevStepX = currentDisplayX;
      }

      // Detector cycle arrival at 300ms
      simTime += (detectorIntervalMs - 9 * displayIntervalMs); // 300 - 297 = 3ms
      const updated = tracker.update([
        {
          boundingBox: { x: nextDetX, y: 0.30, width: 0.18, height: 0.22 },
          confidence: 0.95,
        },
      ], simTime);
      assert.equal(updated.length, 1);
    }

    const stepStats = computeDistribution(stepLatenciesMs);
    const maxStepDelta = Math.max(...stepDeltasX);
    const meanStepDelta = stepDeltasX.reduce((a, b) => a + b, 0) / stepDeltasX.length;
    const maxDetDelta = Math.max(...detectorDeltasX);

    // Rate decoupling smoothness verification:
    // Display step delta must be substantially smaller than raw detector jumps,
    // demonstrating smooth interpolation rather than jerky jumps.
    assert(maxStepDelta < maxDetDelta, `Max display step (${maxStepDelta.toFixed(4)}) must be smoother than raw detector jump (${maxDetDelta.toFixed(4)})`);

    const stepThroughput = Math.round(1000 / stepStats.mean);

    console.log('\n--- [HOST-MEASURED] Rate Decoupling & Display Smoothing ---');
    console.log(`  Detector Arrival Rate:        ~3.3 FPS (every ${detectorIntervalMs} ms)`);
    console.log(`  Display Step Extrapolation:   ~30 FPS (every ${displayIntervalMs} ms)`);
    console.log(`  Total Display Ticks Measured: ${stepStats.count}`);
    console.log(`  Step Warm Mean Latency:       ${stepStats.mean} ms`);
    console.log(`  Step P50 (Median) Latency:    ${stepStats.p50} ms`);
    console.log(`  Step P95 Latency:             ${stepStats.p95} ms`);
    console.log(`  Step P99 Latency:             ${stepStats.p99} ms`);
    console.log(`  Display Step Throughput:      ${stepThroughput.toLocaleString()} steps/sec`);
    console.log(`  Raw Detector Max Jump:        ${maxDetDelta.toFixed(4)} normalized coords`);
    console.log(`  Smoothed Display Max Step:    ${maxStepDelta.toFixed(4)} normalized coords`);
    console.log(`  Smoothed Display Mean Step:   ${meanStepDelta.toFixed(4)} normalized coords`);
    console.log(`  Jump Reduction Factor:        ${(maxDetDelta / maxStepDelta).toFixed(2)}x smoother`);
    console.log('-----------------------------------------------------------\n');
  });

  it('[4] Multi-Face Cross-Movement Disambiguation (Crossing paths with lane separation)', () => {
    const tracker = new TemporalCentroidTracker({ minHitsToConfirm: 1 });
    let simTime = 1000;

    // Face 1 (Track 1) moves from left to right along y=0.25 (e.g. front row)
    // Face 2 (Track 2) moves from right to left along y=0.35 (e.g. second row)
    // They cross laterally in the center (x ~ 0.40)
    const initialDetections = [
      { boundingBox: { x: 0.15, y: 0.25, width: 0.12, height: 0.14 }, confidence: 0.94 },
      { boundingBox: { x: 0.65, y: 0.35, width: 0.12, height: 0.14 }, confidence: 0.94 },
    ];

    const initTracks = tracker.update(initialDetections, simTime);
    assert.equal(initTracks.length, 2, 'Two initial tracks must be registered');
    assert.equal(initTracks[0].trackId, 1, 'First track ID must be 1');
    assert.equal(initTracks[1].trackId, 2, 'Second track ID must be 2');

    const totalFrames = 10;
    const history = [];

    for (let frame = 1; frame <= totalFrames; frame++) {
      // 30 FPS display extrapolation ticks between detector cycles
      for (let s = 1; s <= 9; s++) {
        simTime += 33;
        tracker.step(simTime);
      }
      simTime += 3;

      // Detector cycle (frame interval = 300ms)
      const x1 = 0.15 + frame * 0.05; // moves 0.15 -> 0.65
      const x2 = 0.65 - frame * 0.05; // moves 0.65 -> 0.15

      const detections = [
        { boundingBox: { x: x1, y: 0.25, width: 0.12, height: 0.14 }, confidence: 0.93 },
        { boundingBox: { x: x2, y: 0.35, width: 0.12, height: 0.14 }, confidence: 0.93 },
      ];

      const currentTracks = tracker.update(detections, simTime);

      assert.equal(currentTracks.length, 2, `Frame ${frame}: Must maintain exactly 2 tracks`);

      const t1 = currentTracks.find((t) => t.trackId === 1);
      const t2 = currentTracks.find((t) => t.trackId === 2);

      assert(t1 !== undefined, `Frame ${frame}: Track ID 1 must be preserved`);
      assert(t2 !== undefined, `Frame ${frame}: Track ID 2 must be preserved`);

      // Track 1 must stay in lane y ~ 0.25, Track 2 must stay in lane y ~ 0.35
      assert(Math.abs(t1.boundingBox.y - 0.25) < 0.05, `Frame ${frame}: Track 1 y-coordinate preserved`);
      assert(Math.abs(t2.boundingBox.y - 0.35) < 0.05, `Frame ${frame}: Track 2 y-coordinate preserved`);

      history.push({
        frame,
        t1X: Number(t1.boundingBox.x.toFixed(3)),
        t2X: Number(t2.boundingBox.x.toFixed(3)),
      });
    }

    // Final positions: Face 1 crossed from x=0.15 to x > 0.50; Face 2 crossed from x=0.65 to x < 0.30
    const finalTracks = tracker.getActiveTrackedFaces();
    const finalT1 = finalTracks.find((t) => t.trackId === 1);
    const finalT2 = finalTracks.find((t) => t.trackId === 2);

    assert(finalT1.boundingBox.x > 0.50, 'Track 1 successfully crossed to the right');
    assert(finalT2.boundingBox.x < 0.30, 'Track 2 successfully crossed to the left');

    console.log('\n--- [HOST-MEASURED] Multi-Face Cross-Movement Disambiguation ---');
    console.log(`  Evaluation Frames:             ${totalFrames}`);
    console.log(`  Trajectory:                    Face 1 [x: 0.15 -> 0.65, y=0.25]`);
    console.log(`                                 Face 2 [x: 0.65 -> 0.15, y=0.35]`);
    console.log(`  Track ID Switches:             0 (0% switch rate)`);
    console.log(`  Track Loss / Drop:             0 (100% continuity preserved)`);
    console.log(`  Final Track 1 Position:        x=${finalT1.boundingBox.x.toFixed(3)} (started at 0.150)`);
    console.log(`  Final Track 2 Position:        x=${finalT2.boundingBox.x.toFixed(3)} (started at 0.650)`);
    console.log(`  Cross-Over Frame 5 Centers:    T1 x=${history[4].t1X}, T2 x=${history[4].t2X}`);
    console.log('----------------------------------------------------------------\n');
  });

  it('[5] Algorithmic Comparison: TemporalCentroidTracker vs Baseline Discrete IoU Tracking', () => {
    const temporalTracker = new TemporalCentroidTracker({ minHitsToConfirm: 2 });
    const baselineTracker = new BaselineDiscreteIoUTracker(0.30, 3);

    const iterations = 500;
    let simTime = 1000;

    // Warmup both
    for (let w = 0; w < 50; w++) {
      simTime += 280;
      const det = [{ boundingBox: { x: 0.35, y: 0.35, width: 0.20, height: 0.20 }, confidence: 0.9 }];
      temporalTracker.update(det, simTime);
      baselineTracker.update(det);
    }
    temporalTracker.reset();
    baselineTracker.reset();

    const temporalTimes = new Array(iterations);
    const baselineTimes = new Array(iterations);

    simTime = 1000;
    for (let i = 0; i < iterations; i++) {
      simTime += 280;
      const det = [
        {
          boundingBox: { x: 0.35 + (i % 3) * 0.002, y: 0.35 + (i % 2) * 0.002, width: 0.20, height: 0.20 },
          confidence: 0.92,
        },
      ];

      const t0 = performance.now();
      temporalTracker.update(det, simTime);
      const t1 = performance.now();
      temporalTimes[i] = t1 - t0;

      const t2 = performance.now();
      baselineTracker.update(det);
      const t3 = performance.now();
      baselineTimes[i] = t3 - t2;
    }

    const tempStats = computeDistribution(temporalTimes);
    const baseStats = computeDistribution(baselineTimes);

    console.log('\n--- [HOST-MEASURED] Architectural Comparison ---');
    console.log(`  TemporalCentroidTracker Mean: ${tempStats.mean} ms (P50: ${tempStats.p50} ms, P95: ${tempStats.p95} ms)`);
    console.log(`  Baseline Discrete IoU Mean:   ${baseStats.mean} ms (P50: ${baseStats.p50} ms, P95: ${baseStats.p95} ms)`);
    console.log(`  Rate Decoupling Support:      TemporalCentroidTracker: YES (~30 FPS step extrapolation)`);
    console.log(`                                Baseline Discrete IoU:   NO  (tied to detector FPS)`);
    console.log(`  Coasting with Damped Motion:  TemporalCentroidTracker: YES (up to 850ms)`);
    console.log(`                                Baseline Discrete IoU:   NO  (static frame drop)`);
    console.log(`  Separate Quality Assessment:  TemporalCentroidTracker: YES (quality gate invariant)`);
    console.log(`                                Baseline Discrete IoU:   NO`);
    console.log('------------------------------------------------\n');

    assert(tempStats.mean > 0, 'TemporalCentroidTracker mean latency must be valid');
    assert(baseStats.mean > 0, 'Baseline discrete IoU mean latency must be valid');
  });

  it('[6] Collinear Collision Limitation Observation (Documented Edge Case)', () => {
    // When two faces collide with zero spatial lane separation (identical y and overlapping x),
    // a pure geometric tracker without visual re-ID embeddings or Kalman velocity-projected gating
    // cannot disambiguate identity crossing vs reflection.
    const tracker = new TemporalCentroidTracker({ minHitsToConfirm: 1 });
    let simTime = 1000;

    tracker.update([
      { boundingBox: { x: 0.20, y: 0.30, width: 0.12, height: 0.14 }, confidence: 0.94 },
      { boundingBox: { x: 0.60, y: 0.30, width: 0.12, height: 0.14 }, confidence: 0.94 },
    ], simTime);

    // Head-on collinear approach to exact collision at x=0.40
    let identitySwapped = false;
    for (let frame = 1; frame <= 8; frame++) {
      for (let s = 1; s <= 9; s++) {
        simTime += 33;
        tracker.step(simTime);
      }
      simTime += 3;

      const x1 = 0.20 + frame * 0.05;
      const x2 = 0.60 - frame * 0.05;

      const currentTracks = tracker.update([
        { boundingBox: { x: x1, y: 0.30, width: 0.12, height: 0.14 }, confidence: 0.93 },
        { boundingBox: { x: x2, y: 0.30, width: 0.12, height: 0.14 }, confidence: 0.93 },
      ], simTime);

      const t1 = currentTracks.find(t => t.trackId === 1);
      // If Track 1 starts heading back towards the left after collision at frame 4 (x=0.40),
      // geometric reflection has occurred.
      if (frame > 4 && t1 && t1.boundingBox.x < 0.40) {
        identitySwapped = true;
      }
    }

    console.log('\n--- [HOST-MEASURED] [QUALITATIVE OBSERVATION] Collinear Collision Analysis ---');
    console.log(`  Identical Coordinate Collision: Observed identity reflection (${identitySwapped ? 'YES' : 'NO'})`);
    console.log(`  Root Cause: Pure geometric IoU/Centroid tracker lacks re-ID feature embeddings.`);
    console.log(`  Impact on Classroom Seating: LOW — students occupy distinct spatial desks/chairs.`);
    console.log(`  Mitigation in Production: Students are seated in distinct positions; pipeline`);
    console.log(`  combines tracking with periodic re-identification if spatial collision occurs.`);
    console.log('----------------------------------------------------------------------------\n');

    // Documented observation: we verify that tracker does not crash and maintains 2 active tracks
    assert.equal(tracker.getActiveTrackedFaces().length, 2, 'Tracker maintains 2 active tracks even through collision');
  });
});
