/**
 * Attendly Perception Benchmark Suite — Layer A
 * Micro-Harness: End-to-End Classroom Perception Pipeline Simulation
 *
 * Feature: Phase 10: Edge Perception Benchmarking (Level 3 Research & Evaluation)
 * Classification: [HOST-MEASURED]
 * Note: Measurements executed in Node.js on the development workstation.
 *       NEVER label these results as [DEVICE-MEASURED].
 *
 * Requirements (Task 3):
 * 1. Simulates a 30 FPS camera preview stream over a 10-second classroom scan (300 frames, 33.3ms intervals).
 * 2. Evaluates tracking-assisted selective recognition vs naive frame-by-frame scanning,
 *    measuring empirical compute reduction ratio (target: >= 90% compute reduction).
 * 3. Evaluates all 7 realistic classroom scenarios in CLASSROOM_TEST_SCENARIOS:
 *    - SCENARIO_01_FRONTAL_BASELINE (5 faces)
 *    - SCENARIO_02_YAW_ROTATION (6 faces)
 *    - SCENARIO_03_DISTANT_REAR_ROW (8 faces, small faces)
 *    - SCENARIO_04_WINDOW_GLARE (5 faces)
 *    - SCENARIO_05_CROWDED_DENSE (25 faces amphitheater)
 *    - SCENARIO_06_PARTIAL_OCCLUSIONS (4 faces)
 *    - SCENARIO_07_CAMERA_PAN_SWEEP (15 faces)
 * 4. Measures:
 *    - Total detector vs recognizer invocation counts
 *    - Empirical compute reduction percentage
 *    - Frame-to-frame tracking continuity
 *    - Result freshness / tracking latency (Mean, P50, P95)
 *    - Progressive accumulation and scanner motion stability gating
 * 5. All outputs explicitly tagged [HOST-MEASURED].
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { ClassroomRecognitionPipeline } from '../../pipeline/ClassroomRecognitionPipeline.ts';
import { CLASSROOM_TEST_SCENARIOS } from '../../datasets/ClassroomSyntheticDataset.ts';
import { HeuristicQualityGate } from '../../adapters/quality/HeuristicQualityGate.ts';
import { TemporalCentroidTracker } from '../../adapters/trackers/TemporalCentroidTracker.ts';
import { CosineGalleryMatcher } from '../../adapters/matchers/CosineGalleryMatcher.ts';
import { ProgressiveRecognitionAccumulator } from '../../adapters/accumulator/ProgressiveRecognitionAccumulator.ts';

// ---------------------------------------------------------------------------
// Synthetic Embedding & Gallery Helpers
// ---------------------------------------------------------------------------

function createSyntheticUnitVector(seed = 1, dim = 512) {
  const vec = new Float32Array(dim);
  let normSq = 0.0;
  for (let i = 0; i < dim; i++) {
    const val = Math.sin((seed + 1) * (i + 1));
    vec[i] = val;
    normSq += val * val;
  }
  const norm = Math.sqrt(normSq);
  for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

function createStudentProfiles(count = 35) {
  const profilesMap = new Map();
  for (let s = 1; s <= count; s++) {
    const id = `usr_${s.toString().padStart(3, '0')}`;
    const baseVec = createSyntheticUnitVector(s * 13);
    profilesMap.set(id, {
      studentUserId: id,
      institutionalId: `STU-2026-${s.toString().padStart(3, '0')}`,
      studentName: `Student ${s}`,
      modelName: 'EdgeFace-XS',
      activeModelVersion: '1.0.0',
      embeddingDimension: 512,
      normalization: 'UNIT_L2',
      alignmentMode: 'UMEYAMA_5POINT',
      embeddings: [baseVec],
    });
  }
  return {
    teachingAssignmentId: 'assign_bench_001',
    academicTermId: 'term_2026_fall',
    modelVersion: '1.0.0',
    galleryVersion: 1,
    profiles: profilesMap,
  };
}

function computePercentile(sortedArray, percentile) {
  if (sortedArray.length === 0) return 0;
  const index = (percentile / 100) * (sortedArray.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedArray[lower];
  return sortedArray[lower] + (index - lower) * (sortedArray[upper] - sortedArray[lower]);
}

// ---------------------------------------------------------------------------
// Mock Detector and Recognizer for Scenario Simulation
// ---------------------------------------------------------------------------

class ScenarioMockDetector {
  detectorName = 'ScenarioMockDetector';
  currentDetections = [];

  setDetections(detections) {
    this.currentDetections = detections;
  }

  async initialize() {}
  async detectFaces(_frame) {
    return this.currentDetections;
  }
  async dispose() {}
}

class ScenarioMockRecognizer {
  modelName = 'EdgeFace-XS';
  modelVersion = '1.0.0';
  embeddingDimension = 512;

  currentDetections = [];
  invocationIndex = 0;
  totalInvocations = 0;

  setFrameDetections(detections) {
    this.currentDetections = detections;
    this.invocationIndex = 0;
  }

  async initialize() {}
  async computeEmbedding(_alignedFaceCrop) {
    this.totalInvocations++;
    const det = this.currentDetections[this.invocationIndex % Math.max(1, this.currentDetections.length)];
    this.invocationIndex++;
    const seed = det && det.studentUserId
      ? parseInt(det.studentUserId.replace('usr_', ''), 10) * 13
      : 999;
    return createSyntheticUnitVector(seed);
  }
  async dispose() {}
}

// ---------------------------------------------------------------------------
// Scenario Frame Generator
// ---------------------------------------------------------------------------

function generateScenarioDetections(scenario, frameIdx, totalFrames = 300) {
  const count = scenario.simulatedFacesCount;
  const detections = [];

  // Panning scenario: simulate camera sweeping horizontally across a 15-student classroom
  if (scenario.id === 'SCENARIO_07_CAMERA_PAN_SWEEP') {
    const progress = frameIdx / totalFrames; // 0 to 1
    const panOffset = (progress - 0.5) * 0.9; // Horizontal pan offset

    for (let s = 1; s <= count; s++) {
      // 15 students spread across room coordinates
      const worldX = -0.2 + (s / count) * 1.4;
      const screenX = worldX - panOffset;

      // Only visible if inside view [0.08, 0.88]
      if (screenX >= 0.08 && screenX <= 0.88) {
        const y = 0.25 + ((s % 3) * 0.18);
        detections.push({
          boundingBox: { x: screenX, y, width: 0.12, height: 0.16 },
          confidence: 0.92,
          studentUserId: `usr_${s.toString().padStart(3, '0')}`,
        });
      }
    }
    return detections;
  }

  // Crowded dense amphitheater (25 students in 3 tiers)
  if (scenario.id === 'SCENARIO_05_CROWDED_DENSE') {
    for (let s = 1; s <= count; s++) {
      const row = s % 3; // 0: front, 1: mid, 2: back
      const col = Math.floor(s / 3);
      // Normalized sizes: row 0: 76px, row 1: 64px, row 2: 45px at 640x640 (all >= 35px threshold)
      const w = row === 0 ? 0.12 : row === 1 ? 0.10 : 0.07;
      const h = row === 0 ? 0.15 : row === 1 ? 0.13 : 0.09;
      const x = 0.08 + (col / 9.0) * 0.78;
      const y = 0.18 + row * 0.24;

      detections.push({
        boundingBox: { x, y, width: w, height: h },
        confidence: row === 2 ? 0.82 : 0.94,
        studentUserId: `usr_${s.toString().padStart(3, '0')}`,
      });
    }
    return detections;
  }

  // Distant rear row (8 faces: 5 medium ~50px, 3 tiny ~25px to test filter)
  if (scenario.id === 'SCENARIO_03_DISTANT_REAR_ROW') {
    for (let s = 1; s <= count; s++) {
      const x = 0.10 + (s / count) * 0.75;
      const y = 0.25 + ((s % 2) * 0.15);
      // s <= 6: width ~0.08 (51px >= 35px), s > 6: width ~0.04 (25px < 35px)
      const isFilterCandidate = s > 6;
      const w = isFilterCandidate ? 0.04 : 0.08;
      const h = isFilterCandidate ? 0.05 : 0.10;

      detections.push({
        boundingBox: { x, y, width: w, height: h },
        confidence: isFilterCandidate ? 0.65 : 0.88,
        studentUserId: `usr_${s.toString().padStart(3, '0')}`,
      });
    }
    return detections;
  }

  // Standard static scenarios (SCENARIOS 01, 02, 04, 06)
  for (let s = 1; s <= count; s++) {
    const x = 0.12 + (s / (count + 1)) * 0.72;
    const y = 0.28 + ((s % 2) * 0.15);
    const w = 0.12;
    const h = 0.16;

    // Small jitter to simulate subtle head breathing/movement
    const jitterX = Math.sin(frameIdx * 0.1 + s) * 0.002;
    const jitterY = Math.cos(frameIdx * 0.1 + s) * 0.002;

    detections.push({
      boundingBox: { x: x + jitterX, y: y + jitterY, width: w, height: h },
      confidence: 0.93,
      studentUserId: `usr_${s.toString().padStart(3, '0')}`,
    });
  }

  return detections;
}

// ---------------------------------------------------------------------------
// Benchmark Test Suite
// ---------------------------------------------------------------------------

describe('Layer A: Classroom Pipeline Simulation Suite [HOST-MEASURED]', () => {

  it('[1] End-to-End Classroom Scan Simulation (30 FPS x 10s = 300 frames) & Compute Reduction', async () => {
    const detector = new ScenarioMockDetector();
    const recognizer = new ScenarioMockRecognizer();
    const tracker = new TemporalCentroidTracker();
    const matcher = new CosineGalleryMatcher();
    const qualityGate = new HeuristicQualityGate({ minFaceSizePx: 35 });
    const accumulator = new ProgressiveRecognitionAccumulator();

    const pipeline = new ClassroomRecognitionPipeline(
      qualityGate,
      5, // detectionCadence: run detector every 5th frame (~6 FPS detection rate)
      0.65,
      0.10
    );

    await pipeline.initialize(detector, recognizer, tracker, matcher);
    pipeline.setPermittedGallery(createStudentProfiles(30));
    pipeline.setAccumulator(accumulator);

    const totalFrames = 300;
    const frameIntervalMs = 33.3; // 30 FPS
    const frameLatenciesMs = [];

    // Run baseline scenario: 5 students seated front row
    const scenario = CLASSROOM_TEST_SCENARIOS[0]; // SCENARIO_01_FRONTAL_BASELINE

    for (let f = 0; f < totalFrames; f++) {
      const nowMs = 1000000 + f * frameIntervalMs;
      const detections = generateScenarioDetections(scenario, f, totalFrames);
      detector.setDetections(detections);
      recognizer.setFrameDetections(detections);

      const frame = {
        data: new Uint8Array(640 * 640),
        width: 640,
        height: 640,
        timestampMs: nowMs,
      };

      const t0 = performance.now();
      await pipeline.processFrame(frame);
      const t1 = performance.now();
      frameLatenciesMs.push(t1 - t0);
    }

    frameLatenciesMs.sort((a, b) => a - b);
    const meanLatency = frameLatenciesMs.reduce((s, v) => s + v, 0) / totalFrames;
    const p50 = computePercentile(frameLatenciesMs, 50);
    const p95 = computePercentile(frameLatenciesMs, 95);

    // Naive recognition calls: 5 faces in view on EVERY frame * 300 frames = 1,500 forward passes
    const naiveRecognitionCalls = scenario.simulatedFacesCount * totalFrames;
    const actualRecognitionCalls = pipeline.totalRecognitionRuns;
    const computeReduction = ((1 - actualRecognitionCalls / naiveRecognitionCalls) * 100);

    const accumulated = accumulator.getAccumulatedCandidates();

    console.log('\n--- [HOST-MEASURED] 10-Second Classroom Scan Simulation (Scenario 01: Baseline) ---');
    console.log(`  Simulated Duration:         10.0 seconds (300 frames @ 30 FPS)`);
    console.log(`  Faces in Classroom:         ${scenario.simulatedFacesCount} students`);
    console.log(`  Total Detection Invocations: ${pipeline.totalDetectionRuns} (cadence: 1 detection per 5 frames)`);
    console.log(`  Actual Recognizer Runs:     ${actualRecognitionCalls} inferences`);
    console.log(`  Naive Frame-by-Frame Runs:  ${naiveRecognitionCalls} inferences`);
    console.log(`  Empirical Compute Reduction: ${computeReduction.toFixed(2)}% (Target: >= 90%)`);
    console.log(`  Accumulated Candidates:     ${accumulated.length} / ${scenario.simulatedFacesCount}`);
    console.log(`  Pipeline Step Latency:      Mean: ${meanLatency.toFixed(3)} ms | P50: ${p50.toFixed(3)} ms | P95: ${p95.toFixed(3)} ms`);
    console.log('----------------------------------------------------------------------------------\n');

    assert.equal(pipeline.totalFramesProcessed, 300);
    assert.ok(pipeline.totalDetectionRuns >= 60 && pipeline.totalDetectionRuns <= 61, 'Detection runs must be ~60');
    assert.ok(actualRecognitionCalls <= 20, `Actual recognitions (${actualRecognitionCalls}) must be <= 20 due to track reuse`);
    assert.ok(computeReduction >= 95.0, `Compute reduction (${computeReduction.toFixed(1)}%) must be >= 95%`);
    assert.ok(accumulated.length >= scenario.expectedDetections, 'All expected students must be accumulated');
    assert.ok(meanLatency < 2.0, `Mean frame processing latency (${meanLatency}ms) must be < 2.0ms on host`);
  });

  it('[2] Multi-Scenario Evaluation Across All 7 Realistic Classroom Conditions', async () => {
    const results = [];

    for (const scenario of CLASSROOM_TEST_SCENARIOS) {
      const detector = new ScenarioMockDetector();
      const recognizer = new ScenarioMockRecognizer();
      const tracker = new TemporalCentroidTracker();
      const matcher = new CosineGalleryMatcher();
      const qualityGate = new HeuristicQualityGate({ minFaceSizePx: 35 });
      const accumulator = new ProgressiveRecognitionAccumulator();

      const pipeline = new ClassroomRecognitionPipeline(qualityGate, 5, 0.65, 0.10);
      await pipeline.initialize(detector, recognizer, tracker, matcher);
      pipeline.setPermittedGallery(createStudentProfiles(30));
      pipeline.setAccumulator(accumulator);

      const totalFrames = 150; // 5-second scan per scenario
      const frameIntervalMs = 33.3;

      for (let f = 0; f < totalFrames; f++) {
        const nowMs = 2000000 + f * frameIntervalMs;
        const detections = generateScenarioDetections(scenario, f, totalFrames);
        detector.setDetections(detections);
        recognizer.setFrameDetections(detections);

        const frame = {
          data: new Uint8Array(640 * 640),
          width: 640,
          height: 640,
          timestampMs: nowMs,
        };

        await pipeline.processFrame(frame);
      }

      const accumulated = accumulator.getAccumulatedCandidates();
      const naiveCalls = scenario.simulatedFacesCount * totalFrames;
      const actualCalls = pipeline.totalRecognitionRuns;
      const reduction = ((1 - actualCalls / Math.max(1, naiveCalls)) * 100);

      results.push({
        id: scenario.id,
        name: scenario.name,
        faceCount: scenario.simulatedFacesCount,
        accumulatedCount: accumulated.length,
        detectionsRun: pipeline.totalDetectionRuns,
        recognitionsRun: actualCalls,
        computeReduction: reduction,
      });
    }

    console.log('--- [HOST-MEASURED] Multi-Scenario Perception Simulation Matrix ---');
    console.log('  Scenario ID                     | Faces | Accumulated | Det Runs | Rec Runs | Compute Reduction');
    for (const r of results) {
      console.log(
        `  ${r.id.padEnd(31)} | ` +
        `${r.faceCount.toString().padEnd(5)} | ` +
        `${r.accumulatedCount.toString().padEnd(11)} | ` +
        `${r.detectionsRun.toString().padEnd(8)} | ` +
        `${r.recognitionsRun.toString().padEnd(8)} | ` +
        `${r.computeReduction.toFixed(1)}%`
      );
    }
    console.log('-------------------------------------------------------------------\n');

    // Invariant assertions across all 7 scenarios
    for (const r of results) {
      assert.ok(r.computeReduction >= 85.0, `${r.id} compute reduction (${r.computeReduction.toFixed(1)}%) must be >= 85%`);
    }
  });

  it('[3] High-Density Classroom Scaling (Crowded 25-Face Amphitheater)', async () => {
    const scenario = CLASSROOM_TEST_SCENARIOS.find(s => s.id === 'SCENARIO_05_CROWDED_DENSE');
    assert.ok(scenario, 'SCENARIO_05_CROWDED_DENSE must exist');

    const detector = new ScenarioMockDetector();
    const recognizer = new ScenarioMockRecognizer();
    const tracker = new TemporalCentroidTracker();
    const matcher = new CosineGalleryMatcher();
    const qualityGate = new HeuristicQualityGate({ minFaceSizePx: 35 });
    const accumulator = new ProgressiveRecognitionAccumulator();

    const pipeline = new ClassroomRecognitionPipeline(qualityGate, 5, 0.65, 0.10);
    await pipeline.initialize(detector, recognizer, tracker, matcher);
    pipeline.setPermittedGallery(createStudentProfiles(35));
    pipeline.setAccumulator(accumulator);

    const totalFrames = 150;
    const latenciesMs = [];

    for (let f = 0; f < totalFrames; f++) {
      const nowMs = 3000000 + f * 33.3;
      const detections = generateScenarioDetections(scenario, f, totalFrames);
      detector.setDetections(detections);
      recognizer.setFrameDetections(detections);

      const frame = {
        data: new Uint8Array(640 * 640),
        width: 640,
        height: 640,
        timestampMs: nowMs,
      };

      const t0 = performance.now();
      await pipeline.processFrame(frame);
      const t1 = performance.now();
      latenciesMs.push(t1 - t0);
    }

    latenciesMs.sort((a, b) => a - b);
    const mean = latenciesMs.reduce((s, v) => s + v, 0) / totalFrames;
    const p95 = computePercentile(latenciesMs, 95);

    const stats = tracker.getDiagnostics();
    console.log('--- [HOST-MEASURED] High-Density Lecture Hall Scaling (25 Students) ---');
    console.log(`  Active Confirmed Tracks:    ${stats.confirmedTracks}`);
    console.log(`  Total Recognitions:         ${pipeline.totalRecognitionRuns} (vs ${25 * totalFrames} naive)`);
    console.log(`  Mean Frame Processing Time: ${mean.toFixed(3)} ms`);
    console.log(`  P95 Frame Processing Time:  ${p95.toFixed(3)} ms`);
    console.log('----------------------------------------------------------------------\n');

    assert.ok(stats.confirmedTracks >= 20, `Confirmed tracks (${stats.confirmedTracks}) should be >= 20 in dense hall`);
    assert.ok(mean < 5.0, `Dense 25-face mean step latency (${mean}ms) must be < 5.0ms on host`);
  });

});
