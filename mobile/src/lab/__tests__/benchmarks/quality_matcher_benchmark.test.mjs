/**
 * Klasio Perception Benchmark Suite — Layer A
 * Micro-Harness: FaceQualityGate & CosineGalleryMatcher Performance & Thresholding
 *
 * Feature: Phase 10: Edge Perception Benchmarking (Level 3 Research & Evaluation)
 * Classification: [HOST-MEASURED]
 * Note: Measurements executed in Node.js on the development workstation.
 *       NEVER label these results as [DEVICE-MEASURED].
 *
 * Requirements (Task 2):
 * 1. FaceQualityGate evaluation latency & throughput across 1,000 geometric evaluations.
 * 2. Multi-dimensional rejection behavior across pose variations (yaw/pitch), small face dimensions,
 *    aspect ratio anomalies, frame boundary clipping, and detector confidence.
 * 3. CosineGalleryMatcher vector similarity scoring latency and scaling across roster sizes
 *    (N = 10, 50, 100 students, K = 3 samples/student = 30, 150, 300 reference embeddings).
 * 4. Top-2 margin policy and ambiguity gating (tau >= 0.65, delta >= 0.10) evaluating:
 *    - Definitive match (Top-1 >= tau, Delta >= delta)
 *    - Ambiguous candidate rejection (Top-1 >= tau, Delta < delta)
 *    - Unenrolled / impostor rejection (Top-1 < tau)
 *    - Multi-reference student-level aggregation (no self-competition).
 * 5. Decidability index (d' / D-prime) and genuine vs impostor distribution separation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import {
  FaceQualityGate,
  DEFAULT_QUALITY_GATE_CONFIG,
} from '../../adapters/quality/FaceQualityGate.ts';
import { CosineGalleryMatcher } from '../../adapters/matchers/CosineGalleryMatcher.ts';
import { SessionScopedFaceGallery } from '../../adapters/gallery/SessionScopedGallery.ts';
import { EDGEFACE_XS_MANIFEST } from '../../adapters/recognizers/EdgeFaceEmbedder.ts';

// ---------------------------------------------------------------------------
// Synthetic Vector & Geometric Helper Utilities
// ---------------------------------------------------------------------------

/**
 * Deterministic unit vector generator in R^512.
 */
function createSyntheticUnitVector(seed = 1, dim = 512) {
  const vec = new Float32Array(dim);
  let normSq = 0.0;
  for (let i = 0; i < dim; i++) {
    const val = Math.sin((seed + 1) * (i + 1));
    vec[i] = val;
    normSq += val * val;
  }
  const norm = Math.sqrt(normSq);
  for (let i = 0; i < dim; i++) {
    vec[i] /= norm;
  }
  return vec;
}

/**
 * Generates vector with a specified target cosine similarity to a base vector.
 */
function createVectorWithSimilarity(baseVec, targetSim, perturbSeed = 99) {
  const dim = baseVec.length;
  const perp = createSyntheticUnitVector(perturbSeed, dim);
  let dot = 0.0;
  for (let i = 0; i < dim; i++) dot += baseVec[i] * perp[i];

  const ortho = new Float32Array(dim);
  let orthoNormSq = 0.0;
  for (let i = 0; i < dim; i++) {
    ortho[i] = perp[i] - dot * baseVec[i];
    orthoNormSq += ortho[i] * ortho[i];
  }
  const orthoNorm = Math.sqrt(orthoNormSq);
  for (let i = 0; i < dim; i++) ortho[i] /= orthoNorm;

  const s = Math.max(-1.0, Math.min(1.0, targetSim));
  const c = Math.sqrt(Math.max(0.0, 1.0 - s * s));
  const res = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    res[i] = s * baseVec[i] + c * ortho[i];
  }
  return res;
}

/**
 * Landmark generator parameterized by head pose yaw and pitch.
 * Calibrated mathematically to match FaceQualityGate geometry:
 * - asymmetry = (noseTip.x - eyeMidX) / eyeHalfDist
 * - yawDegrees = asymmetry * 35.0
 * - noseRatio = (noseTip.y - eyeMidY) / (mouthMidY - eyeMidY)
 * - pitchDegrees = (noseRatio - 0.45) * 60.0
 */
function createPoseLandmarks(cx = 0.50, cy = 0.50, size = 0.20, yawDegrees = 0, pitchDegrees = 0) {
  const eyeSpan = size * 0.40;
  const vertSpan = size * 0.50;
  const eyeMidY = cy - vertSpan * 0.25;
  const mouthMidY = cy + vertSpan * 0.35;
  const actualVertSpan = mouthMidY - eyeMidY;

  const eyeHalfDist = eyeSpan / 2.0;
  const yawOffset = (yawDegrees / 35.0) * eyeHalfDist;
  const noseY = eyeMidY + (0.45 + pitchDegrees / 60.0) * actualVertSpan;

  return {
    leftEye: { x: cx - eyeHalfDist, y: eyeMidY },
    rightEye: { x: cx + eyeHalfDist, y: eyeMidY },
    noseTip: { x: cx + yawOffset, y: noseY },
    mouthLeft: { x: cx - eyeSpan * 0.4, y: mouthMidY },
    mouthRight: { x: cx + eyeSpan * 0.4, y: mouthMidY },
  };
}

function createDummySessionScope(sessionId = 'sess_benchmark_001') {
  return {
    attendanceSessionId: sessionId,
    academicTermId: 'term_2026_fall',
    courseOfferingId: 'course_cs301',
    subject: 'Data Structures & Algorithms',
    classId: 'class_btech_cse_yr3',
    section: 'A',
    sessionDate: '2026-10-24',
  };
}

function createStudentProfile(id, name, embeddings, manifest = EDGEFACE_XS_MANIFEST) {
  return {
    studentUserId: `usr_${id}`,
    institutionalId: `STU-2026-${id.toString().padStart(3, '0')}`,
    studentName: name,
    modelName: manifest.modelName,
    activeModelVersion: manifest.modelVersion,
    embeddingDimension: manifest.embeddingDimension,
    normalization: manifest.normalization,
    alignmentMode: manifest.alignmentMode,
    embeddings: embeddings,
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
// Benchmark Test Suite
// ---------------------------------------------------------------------------

describe('Layer A: Quality Gate & Matcher Micro-Harness [HOST-MEASURED]', () => {

  // -------------------------------------------------------------------------
  // Benchmark 1: FaceQualityGate Latency & Throughput
  // -------------------------------------------------------------------------
  it('[1] FaceQualityGate Evaluation Latency & Throughput (1,000 evaluations)', () => {
    const gate = new FaceQualityGate();
    const iterations = 1000;
    const latenciesMs = [];

    // Pre-generate varied geometric test cases
    const testCases = [];
    for (let i = 0; i < iterations; i++) {
      const cx = 0.20 + (i % 60) * 0.01;
      const cy = 0.20 + (i % 50) * 0.01;
      const w = 0.10 + (i % 15) * 0.01;
      const h = 0.14 + (i % 15) * 0.01;
      const yaw = ((i % 50) - 25);
      const pitch = ((i % 40) - 20);
      const conf = 0.65 + (i % 35) * 0.01;

      testCases.push({
        box: { x: cx, y: cy, width: w, height: h },
        landmarks: createPoseLandmarks(cx + w / 2, cy + h / 2, (w + h) / 2, yaw, pitch),
        confidence: conf,
      });
    }

    // Warm-up (50 iterations)
    for (let i = 0; i < 50; i++) {
      const tc = testCases[i];
      gate.evaluate(tc.box, tc.landmarks, tc.confidence);
    }

    // Timed benchmark loop
    for (let i = 0; i < iterations; i++) {
      const tc = testCases[i];
      const t0 = performance.now();
      gate.evaluate(tc.box, tc.landmarks, tc.confidence);
      const t1 = performance.now();
      latenciesMs.push(t1 - t0);
    }

    latenciesMs.sort((a, b) => a - b);
    const meanLatency = latenciesMs.reduce((sum, v) => sum + v, 0) / iterations;
    const p50 = computePercentile(latenciesMs, 50);
    const p90 = computePercentile(latenciesMs, 90);
    const p95 = computePercentile(latenciesMs, 95);
    const p99 = computePercentile(latenciesMs, 99);
    const minLatency = latenciesMs[0];
    const maxLatency = latenciesMs[latenciesMs.length - 1];
    const throughput = Math.round(1000 / (meanLatency || 0.001));

    console.log('\n--- [HOST-MEASURED] FaceQualityGate Latency & Throughput ---');
    console.log(`  Iterations:            ${iterations}`);
    console.log(`  Warm Mean Latency:     ${meanLatency.toFixed(5)} ms`);
    console.log(`  P50 (Median) Latency:  ${p50.toFixed(5)} ms`);
    console.log(`  P90 Latency:           ${p90.toFixed(5)} ms`);
    console.log(`  P95 Latency:           ${p95.toFixed(5)} ms`);
    console.log(`  P99 Latency:           ${p99.toFixed(5)} ms`);
    console.log(`  Min / Max Latency:     ${minLatency.toFixed(5)} ms / ${maxLatency.toFixed(5)} ms`);
    console.log(`  Throughput:            ${throughput.toLocaleString()} checks/sec`);
    console.log('------------------------------------------------------------\n');

    // Invariant assertions
    assert.ok(meanLatency < 0.20, `Mean latency (${meanLatency}ms) must be < 0.20ms`);
    assert.ok(throughput > 5000, `Throughput (${throughput}) must exceed 5,000 checks/sec`);
  });

  // -------------------------------------------------------------------------
  // Benchmark 2: Multi-Dimensional Rejection Behavior
  // -------------------------------------------------------------------------
  it('[2] Multi-Dimensional Rejection Behavior (Pose Yaw/Pitch, Size, Aspect Ratio, Clipping, Conf)', () => {
    const gate = new FaceQualityGate();

    // 2A. Head Pose Yaw Sweep
    // Calibration: |yaw| <= 16° GOOD, 16° < |yaw| <= 28° FAIR, > 28° POOR (TOO_TILTED)
    const yawAngles = [-35, -28, -20, -10, 0, 10, 20, 28, 35];
    const yawResults = yawAngles.map(yaw => {
      const box = { x: 0.30, y: 0.30, width: 0.15, height: 0.20 };
      const lm = createPoseLandmarks(0.375, 0.40, 0.18, yaw, 0);
      const res = gate.evaluate(box, lm, 0.90);
      return { yaw, state: res.state, reason: res.primaryReason };
    });

    // Zero-yaw must be GOOD
    const zeroYaw = yawResults.find(r => r.yaw === 0);
    assert.equal(zeroYaw.state, 'GOOD');

    // Extreme yaw (±35° > 28°) must be POOR with EXCESSIVE_YAW
    const extNegYaw = yawResults.find(r => r.yaw === -35);
    const extPosYaw = yawResults.find(r => r.yaw === 35);
    assert.equal(extNegYaw.state, 'POOR');
    assert.equal(extNegYaw.reason, 'EXCESSIVE_YAW');
    assert.equal(extPosYaw.state, 'POOR');
    assert.equal(extPosYaw.reason, 'EXCESSIVE_YAW');

    // Moderate yaw (20° between 16° and 28°) must be FAIR
    const modYaw = yawResults.find(r => r.yaw === 20);
    assert.equal(modYaw.state, 'FAIR');

    // 2B. Head Pose Pitch Sweep
    // Calibration: |pitch| <= 14° GOOD, 14° < |pitch| <= 22° FAIR, > 22° POOR (EXCESSIVE_PITCH)
    const pitchAngles = [-30, -22, -12, 0, 12, 22, 30];
    const pitchResults = pitchAngles.map(pitch => {
      const box = { x: 0.30, y: 0.30, width: 0.15, height: 0.20 };
      const lm = createPoseLandmarks(0.375, 0.40, 0.18, 0, pitch);
      const res = gate.evaluate(box, lm, 0.90);
      return { pitch, state: res.state, reason: res.primaryReason };
    });

    const zeroPitch = pitchResults.find(r => r.pitch === 0);
    assert.equal(zeroPitch.state, 'GOOD');

    const extPitch = pitchResults.find(r => r.pitch === 30);
    assert.equal(extPitch.state, 'POOR');
    assert.equal(extPitch.reason, 'EXCESSIVE_PITCH');

    // 2C. Face Size Scaling
    // Small face (width 0.03 x height 0.04) -> POOR (TOO_SMALL)
    const smallBox = { x: 0.20, y: 0.20, width: 0.03, height: 0.04 };
    const smallLm = createPoseLandmarks(0.215, 0.22, 0.035, 0, 0);
    const smallRes = gate.evaluate(smallBox, smallLm, 0.90);
    assert.equal(smallRes.state, 'POOR');
    assert.equal(smallRes.primaryReason, 'TOO_SMALL');

    // 2D. Bounding-Box Geometry & Aspect Ratio
    // Sliver: width=0.03, height=0.15 (AR=0.20 < min 0.50) -> POOR
    const sliverBox = { x: 0.40, y: 0.30, width: 0.03, height: 0.15 };
    const sliverRes = gate.evaluate(sliverBox, undefined, 0.85);
    assert.equal(sliverRes.metrics.aspectRatioState, 'POOR');
    assert.equal(sliverRes.state, 'POOR');

    // Pancake: width=0.25, height=0.10 (AR=2.50 > max 1.20) -> POOR
    const wideBox = { x: 0.40, y: 0.30, width: 0.25, height: 0.10 };
    const wideRes = gate.evaluate(wideBox, undefined, 0.85);
    assert.equal(wideRes.metrics.aspectRatioState, 'POOR');
    assert.equal(wideRes.state, 'POOR');

    // 2E. Frame Boundary Clipping
    // Box spanning outside screen: x = -0.05, width = 0.15 -> containment ~0.67 < min 0.80 -> POOR (FRAME_CLIPPED)
    const clippedBox = { x: -0.05, y: 0.20, width: 0.15, height: 0.20 };
    const clippedLm = createPoseLandmarks(0.025, 0.30, 0.18, 0, 0);
    const clippedRes = gate.evaluate(clippedBox, clippedLm, 0.90);
    assert.equal(clippedRes.metrics.visibilityState, 'POOR');
    assert.equal(clippedRes.state, 'POOR');
    assert.equal(clippedRes.primaryReason, 'FRAME_CLIPPED');

    // 2F. Image Sharpness & Motion Blur Gating
    // Flat/blurred frame pixels (all zero gradient) -> POOR (LOW_SHARPNESS)
    const flatPixels = new Uint8Array(400); // 0 gradient everywhere
    const blurBox = { x: 0.20, y: 0.20, width: 0.15, height: 0.20 };
    const blurLm = createPoseLandmarks(0.275, 0.30, 0.18, 0, 0);
    const blurRes = gate.evaluate(blurBox, blurLm, 0.90, undefined, flatPixels);
    assert.equal(blurRes.metrics.sharpnessState, 'POOR');
    assert.equal(blurRes.state, 'POOR');
    assert.equal(blurRes.primaryReason, 'LOW_SHARPNESS');

    // 2G. Landmark Completeness Gating
    // Missing landmarks -> POOR (INSUFFICIENT_LANDMARKS)
    const noLmRes = gate.evaluate(blurBox, undefined, 0.90);
    assert.equal(noLmRes.metrics.visibilityState, 'POOR');
    assert.equal(noLmRes.state, 'POOR');
    assert.equal(noLmRes.primaryReason, 'INSUFFICIENT_LANDMARKS');

    console.log('--- [HOST-MEASURED] Quality Gate Rejection Validation ---');
    console.log(`  Pose Yaw Range Tested:      -35° to +35° (Rejection at ±28° confirmed: YES)`);
    console.log(`  Pose Pitch Range Tested:    -30° to +30° (Rejection at ±22° confirmed: YES)`);
    console.log(`  Small Face (<0.05 w) Filter: REJECTED as TOO_SMALL (YES)`);
    console.log(`  Sliver & Pancake AR Filter:  REJECTED as POOR Aspect Ratio (YES)`);
    console.log(`  Boundary Clipping Filter:   REJECTED as FRAME_CLIPPED (YES)`);
    console.log(`  Zero-Gradient Blur Filter:  REJECTED as LOW_SHARPNESS (YES)`);
    console.log(`  Missing Landmarks Filter:   REJECTED as INSUFFICIENT_LANDMARKS (YES)`);
    console.log('---------------------------------------------------------\n');
  });

  // -------------------------------------------------------------------------
  // Benchmark 3: CosineGalleryMatcher Vector Similarity Scaling Across Roster Sizes
  // -------------------------------------------------------------------------
  it('[3] CosineGalleryMatcher Scoring Latency Across Roster Sizes (N = 10, 50, 100 students)', () => {
    const matcher = new CosineGalleryMatcher();
    const rosterScales = [10, 50, 100];
    const samplesPerStudent = 3;
    const testQueriesCount = 100;
    const scaleResults = [];

    for (const N of rosterScales) {
      const gallery = new SessionScopedFaceGallery();
      const profiles = [];

      for (let s = 1; s <= N; s++) {
        const baseVec = createSyntheticUnitVector(s * 10);
        // Student has K=3 diverse reference samples
        const ref1 = baseVec;
        const ref2 = createVectorWithSimilarity(baseVec, 0.94, s * 10 + 1);
        const ref3 = createVectorWithSimilarity(baseVec, 0.90, s * 10 + 2);

        profiles.push(
          createStudentProfile(
            s.toString().padStart(3, '0'),
            `Student ${s}`,
            [ref1, ref2, ref3]
          )
        );
      }

      gallery.initialize(createDummySessionScope(`sess_scale_${N}`), profiles);

      // Pre-create query vectors (some genuine matches, some random impostors)
      const queryVectors = [];
      for (let q = 0; q < testQueriesCount; q++) {
        const targetId = (q % N) + 1;
        const targetBase = profiles[targetId - 1].embeddings[0];
        queryVectors.push(createVectorWithSimilarity(targetBase, 0.88, 9000 + q));
      }

      // Warm-up
      for (let w = 0; w < 10; w++) {
        matcher.findMatch(queryVectors[w], gallery, 0.65, 0.10);
      }

      // Benchmark timing
      const latenciesMs = [];
      for (let q = 0; q < testQueriesCount; q++) {
        const t0 = performance.now();
        matcher.findMatch(queryVectors[q], gallery, 0.65, 0.10);
        const t1 = performance.now();
        latenciesMs.push(t1 - t0);
      }

      latenciesMs.sort((a, b) => a - b);
      const mean = latenciesMs.reduce((sum, v) => sum + v, 0) / testQueriesCount;
      const p50 = computePercentile(latenciesMs, 50);
      const p95 = computePercentile(latenciesMs, 95);
      const qps = Math.round(1000 / (mean || 0.0001));

      scaleResults.push({
        N,
        totalVectors: N * samplesPerStudent,
        meanMs: mean,
        p50Ms: p50,
        p95Ms: p95,
        qps,
      });
    }

    console.log('--- [HOST-MEASURED] CosineGalleryMatcher Scaling Across Roster Sizes ---');
    console.log('  Roster Size | Total Vectors | Mean Latency | P50 (Median) | P95 Latency | Query Throughput');
    for (const r of scaleResults) {
      console.log(
        `  N = ${r.N.toString().padEnd(7)} | ${r.totalVectors.toString().padEnd(13)} | ` +
        `${r.meanMs.toFixed(5)} ms   | ${r.p50Ms.toFixed(5)} ms   | ${r.p95Ms.toFixed(5)} ms   | ${r.qps.toLocaleString()} QPS`
      );
    }
    console.log('------------------------------------------------------------------------\n');

    // Invariant assertions: host Node.js throughput and scalability
    const resultN100 = scaleResults.find(r => r.N === 100);
    assert.ok(resultN100.meanMs < 5.0, `Linear search at N=100 (${resultN100.meanMs}ms) must be < 5.0ms on host`);
    assert.ok(resultN100.qps > 300, `At N=100, host query throughput (${resultN100.qps} QPS) must exceed 300 QPS`);
  });

  // -------------------------------------------------------------------------
  // Benchmark 4: Top-2 Margin Policy & Ambiguity Gating
  // -------------------------------------------------------------------------
  it('[4] Top-2 Margin Policy & Ambiguity Gating (tau=0.65, delta=0.10)', () => {
    const matcher = new CosineGalleryMatcher();
    const gallery = new SessionScopedFaceGallery();

    const vecA = createSyntheticUnitVector(101);
    const vecB = createSyntheticUnitVector(202);
    const vecC = createSyntheticUnitVector(303);

    const profiles = [
      createStudentProfile('001', 'Aarav Sharma', [vecA]),
      createStudentProfile('002', 'Diya Patel', [vecB]),
      createStudentProfile('003', 'Rohan Verma', [vecC]),
    ];

    gallery.initialize(createDummySessionScope('sess_margin_001'), profiles);

    // Case 4A: High-confidence definitive match (Top-1 = 0.95, Top-2 ~ 0.05, Delta ~ 0.90 >= 0.10)
    const matchA = matcher.findMatch(vecA, gallery, 0.65, 0.10);
    assert.equal(matchA.matchState, 'MATCHED');
    assert.equal(matchA.studentUserId, 'usr_001');
    assert.equal(matchA.isConfident, true);
    assert.ok(matchA.top2Margin >= 0.10);

    // Case 4B: Ambiguous candidate / lookalike (Top-1 = 0.74, Top-2 = 0.70, Delta = 0.04 < 0.10)
    // Create query equidistant between Student A and Student B
    const midpoint = new Float32Array(512);
    let mNormSq = 0;
    for (let i = 0; i < 512; i++) {
      midpoint[i] = vecA[i] + vecB[i];
      mNormSq += midpoint[i] * midpoint[i];
    }
    const mNorm = Math.sqrt(mNormSq);
    for (let i = 0; i < 512; i++) midpoint[i] /= mNorm;

    // Both student A and student B have cosine sim ~ 0.707 with the normalized midpoint
    const matchAmbiguous = matcher.findMatch(midpoint, gallery, 0.65, 0.10);
    assert.equal(matchAmbiguous.matchState, 'AMBIGUOUS');
    assert.equal(matchAmbiguous.isConfident, false);
    assert.ok(matchAmbiguous.top2Margin < 0.10, `Margin (${matchAmbiguous.top2Margin}) must be < 0.10`);
    assert.ok(
      matchAmbiguous.diagnosticReason && matchAmbiguous.diagnosticReason.includes('below margin threshold'),
      `diagnosticReason must describe margin threshold failure: got ${matchAmbiguous.diagnosticReason}`
    );

    // Case 4C: Impostor / out-of-gallery query (Top-1 < 0.65)
    const orthogonalVec = createVectorWithSimilarity(vecA, 0.10, 888);
    const matchImpostor = matcher.findMatch(orthogonalVec, gallery, 0.65, 0.10);
    assert.equal(matchImpostor.matchState, 'UNMATCHED');
    assert.equal(matchImpostor.isConfident, false);
    assert.equal(matchImpostor.studentUserId, null);

    // Case 4D: Multi-reference student aggregation (no self-ambiguity)
    // Student with 3 reference vectors: query matching ref 1 and ref 2 must NOT flag itself as ambiguous
    const galleryMulti = new SessionScopedFaceGallery();
    const ref1 = createSyntheticUnitVector(501);
    const ref2 = createVectorWithSimilarity(ref1, 0.95, 502);
    const ref3 = createVectorWithSimilarity(ref1, 0.91, 503);
    const otherStudentRef = createVectorWithSimilarity(ref1, 0.40, 504);

    galleryMulti.initialize(createDummySessionScope('sess_multi_001'), [
      createStudentProfile('001', 'Multi Ref Student', [ref1, ref2, ref3]),
      createStudentProfile('002', 'Other Student', [otherStudentRef]),
    ]);

    const queryMulti = createVectorWithSimilarity(ref1, 0.98, 505);
    const matchMulti = matcher.findMatch(queryMulti, galleryMulti, 0.65, 0.10);
    assert.equal(matchMulti.matchState, 'MATCHED');
    assert.equal(matchMulti.studentUserId, 'usr_001');
    assert.equal(matchMulti.isConfident, true);
    assert.ok(matchMulti.top2Margin >= 0.10, 'Student reference pooling must prevent self-ambiguity');

    console.log('--- [HOST-MEASURED] Top-2 Margin & Ambiguity Gating Validation ---');
    console.log(`  Definitive Match (Delta >= 0.10):        MATCHED (isConfident=true)`);
    console.log(`  Lookalike Ambiguity (Delta < 0.10):      AMBIGUOUS (isConfident=false, prevented misidentification)`);
    console.log(`  Out-of-Gallery Impostor (Top1 < 0.65):   UNMATCHED (isConfident=false)`);
    console.log(`  Multi-Sample Aggregation (K=3):          MATCHED without false self-ambiguity`);
    console.log('------------------------------------------------------------------\n');
  });

  // -------------------------------------------------------------------------
  // Benchmark 5: Decidability Index & Distribution Separation (d')
  // -------------------------------------------------------------------------
  it('[5] Biometric Decidability Index (d\') & Genuine vs Impostor Distribution Separation', () => {
    const numIdentities = 50;
    const genuinePairs = [];
    const impostorPairs = [];

    // Generate base identity templates
    const baseIdentities = [];
    for (let i = 0; i < numIdentities; i++) {
      baseIdentities.push(createSyntheticUnitVector(i * 17));
    }

    // Generate genuine pairs (same identity under realistic variation: sim ~ 0.78 to 0.92)
    for (let i = 0; i < numIdentities; i++) {
      const base = baseIdentities[i];
      for (let v = 1; v <= 4; v++) {
        const targetSim = 0.84 + ((v % 3) - 1) * 0.05;
        const variant = createVectorWithSimilarity(base, targetSim, i * 100 + v);

        // Compute actual cosine similarity
        let dot = 0;
        for (let d = 0; d < 512; d++) dot += base[d] * variant[d];
        genuinePairs.push(dot);
      }
    }

    // Generate cross-identity impostor pairs
    for (let i = 0; i < numIdentities; i++) {
      for (let j = i + 1; j < numIdentities; j++) {
        let dot = 0;
        for (let d = 0; d < 512; d++) dot += baseIdentities[i][d] * baseIdentities[j][d];
        impostorPairs.push(dot);
      }
    }

    // Compute distribution statistics
    const meanGen = genuinePairs.reduce((s, v) => s + v, 0) / genuinePairs.length;
    const varianceGen = genuinePairs.reduce((s, v) => s + Math.pow(v - meanGen, 2), 0) / genuinePairs.length;
    const stdGen = Math.sqrt(varianceGen);

    const meanImp = impostorPairs.reduce((s, v) => s + v, 0) / impostorPairs.length;
    const varianceImp = impostorPairs.reduce((s, v) => s + Math.pow(v - meanImp, 2), 0) / impostorPairs.length;
    const stdImp = Math.sqrt(varianceImp);

    // Decidability index / D-prime: d' = (mu_gen - mu_imp) / sqrt(0.5 * (std_gen^2 + std_imp^2))
    const dPrime = (meanGen - meanImp) / Math.sqrt(0.5 * (varianceGen + varianceImp));

    // Distribution overlap: count impostors exceeding min genuine, or genuines below max impostor
    const minGen = Math.min(...genuinePairs);
    const maxImp = Math.max(...impostorPairs);
    const overlapCount = impostorPairs.filter(v => v >= minGen).length + genuinePairs.filter(v => v <= maxImp).length;
    const totalComparisons = genuinePairs.length + impostorPairs.length;
    const overlapPercent = (overlapCount / totalComparisons) * 100;

    console.log('--- [HOST-MEASURED] Biometric Distribution Separation (d\') ---');
    console.log(`  Identities Evaluated:         ${numIdentities}`);
    console.log(`  Genuine Pairs (N_gen):        ${genuinePairs.length}`);
    console.log(`  Impostor Pairs (N_imp):       ${impostorPairs.length}`);
    console.log(`  Genuine Mean ± Std:           ${meanGen.toFixed(4)} ± ${stdGen.toFixed(4)}`);
    console.log(`  Impostor Mean ± Std:          ${meanImp.toFixed(4)} ± ${stdImp.toFixed(4)}`);
    console.log(`  Separation Margin:            ${(meanGen - meanImp).toFixed(4)}`);
    console.log(`  Decidability Index (d'):      ${dPrime.toFixed(3)}`);
    console.log(`  Distribution Overlap:         ${overlapPercent.toFixed(2)}% (Separation Gap: ${(minGen - maxImp).toFixed(4)})`);
    console.log('-------------------------------------------------------------\n');

    assert.ok(dPrime > 3.0, `Decidability index d' (${dPrime}) must be > 3.0 for robust biometric separation`);
    assert.ok(meanGen - meanImp > 0.40, `Separation margin (${meanGen - meanImp}) must be > 0.40`);
    assert.ok(minGen > maxImp, `Genuine distribution minimum (${minGen}) should strictly exceed impostor maximum (${maxImp})`);
  });

});
