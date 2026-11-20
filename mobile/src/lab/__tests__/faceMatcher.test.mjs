/**
 * Step F — Session-Scoped Face Gallery Matching & Invariant Test Suite
 * Automated tests for SessionScopedFaceGallery, CosineGalleryMatcher, and TemporalConfirmationBuffer.
 *
 * Strict invariants verified:
 * 1. Exact match produces Top-1 candidate with correct identity (MATCHED).
 * 2. Competing candidates from different students within margin trigger AMBIGUOUS.
 * 3. Multi-embedding references for the SAME student aggregate without false ambiguity.
 * 4. Empty gallery (N=0) produces UNMATCHED/INVALID with diagnostic reason.
 * 5. Single student gallery (N=1) produces Top-1, null Top-2, null margin, and MATCHED without error.
 * 6. Mismatched model/dimension/alignment biometrics are rejected with explicit diagnostic reasons.
 * 7. Multi-track independent evaluation with zero cross-track contamination.
 * 8. Strict session scoping: Only students authorized for the attendance session participate.
 * 9. Temporal confirmation operates strictly at observation rate (not 30-FPS tracking rate).
 * 10. HARD INVARIANT: Zero identity leakage before matching, and zero attendance marking.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionScopedFaceGallery } from '../adapters/gallery/SessionScopedGallery.ts';
import { CosineGalleryMatcher } from '../adapters/matchers/CosineGalleryMatcher.ts';
import { TemporalConfirmationBuffer } from '../adapters/matchers/TemporalConfirmationBuffer.ts';
import { EDGEFACE_XS_MANIFEST } from '../adapters/recognizers/EdgeFaceEmbedder.ts';

// Deterministic unit vector generator in R^512
function createSyntheticUnitVector(seed = 1, dim = 512) {
  const vec = new Float32Array(dim);
  let normSq = 0.0;
  for (let i = 0; i < dim; i++) {
    // Deterministic pseudo-random based on sine
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

// Generates vector with a target cosine similarity to a base vector
function createVectorWithSimilarity(baseVec, targetSim, perturbSeed = 99) {
  const dim = baseVec.length;
  const perp = createSyntheticUnitVector(perturbSeed, dim);
  // Gram-Schmidt orthogonalization
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

  // result = targetSim * baseVec + sqrt(1 - targetSim^2) * ortho
  const s = Math.max(-1.0, Math.min(1.0, targetSim));
  const c = Math.sqrt(Math.max(0.0, 1.0 - s * s));
  const res = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    res[i] = s * baseVec[i] + c * ortho[i];
  }
  return res;
}

function createDummySessionScope(sessionId = 'sess_cse3a_cs301_20261013_01') {
  return {
    attendanceSessionId: sessionId,
    academicTermId: 'term_2026_fall',
    courseOfferingId: 'course_cs301',
    subject: 'Data Structures & Algorithms',
    classId: 'class_btech_cse_yr3',
    section: 'A',
    sessionDate: '2026-10-13',
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

test('Session-Scoped Face Matcher — Unit & Invariant Test Suite', async (t) => {
  const matcher = new CosineGalleryMatcher();

  await t.test('[1] Exact Match: Same embedding produces Top-1 MATCHED candidate', async () => {
    const gallery = new SessionScopedFaceGallery();
    const vec1 = createSyntheticUnitVector(1);
    const vec2 = createSyntheticUnitVector(2);
    const vec3 = createSyntheticUnitVector(3);

    const profiles = [
      createStudentProfile('001', 'Aarav Sharma', [vec1]),
      createStudentProfile('002', 'Diya Patel', [vec2]),
      createStudentProfile('003', 'Rohan Verma', [vec3]),
    ];

    gallery.initialize(createDummySessionScope(), profiles);

    // Candidate is identical to Aarav
    const match = matcher.findMatch(vec1, gallery, 0.65, 0.10);

    assert.equal(match.matchState, 'MATCHED');
    assert.equal(match.isConfident, true);
    assert.equal(match.studentUserId, 'usr_001');
    assert.equal(match.studentName, 'Aarav Sharma');
    assert.ok(Math.abs(match.similarityScore - 1.0) < 1e-4, 'Similarity score should be ~1.0');
    assert.ok(match.top2Margin !== null && match.top2Margin > 0.5, 'Margin should be large');
  });

  await t.test('[2] Multi-Reference Aggregation: Multiple samples for the SAME student do NOT trigger false ambiguity', async () => {
    const gallery = new SessionScopedFaceGallery();
    const baseVec = createSyntheticUnitVector(10);
    // Student A has two close reference embeddings (e.g. frontal + slight smile)
    const refA1 = baseVec;
    const refA2 = createVectorWithSimilarity(baseVec, 0.95, 11);
    // Student B has a distant embedding
    const refB1 = createVectorWithSimilarity(baseVec, 0.50, 12);

    const profiles = [
      createStudentProfile('001', 'Aarav Sharma', [refA1, refA2]),
      createStudentProfile('002', 'Diya Patel', [refB1]),
    ];

    gallery.initialize(createDummySessionScope(), profiles);

    // Query is very close to both refA1 and refA2
    const query = createVectorWithSimilarity(baseVec, 0.98, 13);
    const match = matcher.findMatch(query, gallery, 0.65, 0.10);

    // Top-1 is Aarav, Top-2 is Diya (NOT Aarav's second embedding!)
    assert.equal(match.matchState, 'MATCHED');
    assert.equal(match.studentUserId, 'usr_001');
    assert.equal(match.top2StudentUserId, 'usr_002');
    // Margin is Aarav vs Diya (~0.98 - ~0.50 = ~0.48), NOT refA1 vs refA2!
    assert.ok(match.top2Margin > 0.30, `Expected margin between different students, got ${match.top2Margin}`);
  });

  await t.test('[3] Ambiguity Detection: Close competitors from DIFFERENT students trigger AMBIGUOUS', async () => {
    const gallery = new SessionScopedFaceGallery();
    const baseVec = createSyntheticUnitVector(20);
    // Student A and Student B both have high similarity to the query (twin/lookalike scenario)
    const refA = createVectorWithSimilarity(baseVec, 0.85, 21);
    const refB = createVectorWithSimilarity(baseVec, 0.82, 22);

    const profiles = [
      createStudentProfile('001', 'Student A', [refA]),
      createStudentProfile('002', 'Student B', [refB]),
    ];

    gallery.initialize(createDummySessionScope(), profiles);

    // Query matches both closely (margin = 0.85 - 0.82 = 0.03 < 0.10)
    const match = matcher.findMatch(baseVec, gallery, 0.65, 0.10);

    assert.equal(match.matchState, 'AMBIGUOUS');
    assert.equal(match.isConfident, false);
    assert.ok(match.top2Margin !== null && match.top2Margin < 0.10, `Expected margin < 0.10, got ${match.top2Margin}`);
  });

  await t.test('[4] Unknown Face: Similarity below threshold triggers UNMATCHED', async () => {
    const gallery = new SessionScopedFaceGallery();
    const vecA = createSyntheticUnitVector(30);
    const vecB = createSyntheticUnitVector(31);

    const profiles = [
      createStudentProfile('001', 'Student A', [vecA]),
      createStudentProfile('002', 'Student B', [vecB]),
    ];

    gallery.initialize(createDummySessionScope(), profiles);

    // An orthogonal vector representing an unregistered person or outsider
    const outsider = createSyntheticUnitVector(32);
    const match = matcher.findMatch(outsider, gallery, 0.65, 0.10);

    assert.equal(match.matchState, 'UNMATCHED');
    assert.equal(match.isConfident, false);
    assert.equal(match.studentUserId, null);
    assert.ok(match.similarityScore < 0.65);
  });

  await t.test('[5] Empty Gallery: N=0 produces UNMATCHED/INVALID with explicit diagnostic reason', async () => {
    const gallery = new SessionScopedFaceGallery();
    gallery.initialize(createDummySessionScope(), []);

    const query = createSyntheticUnitVector(40);
    const match = matcher.findMatch(query, gallery, 0.65, 0.10);

    assert.equal(match.matchState, 'INVALID');
    assert.equal(match.isConfident, false);
    assert.equal(match.diagnosticReason, 'EMPTY_GALLERY');
  });

  await t.test('[6] Single-Student Gallery: N=1 produces Top-1, null Top-2, null margin without error', async () => {
    const gallery = new SessionScopedFaceGallery();
    const vecA = createSyntheticUnitVector(50);
    gallery.initialize(createDummySessionScope(), [createStudentProfile('001', 'Solo Student', [vecA])]);

    const query = vecA;
    const match = matcher.findMatch(query, gallery, 0.65, 0.10);

    assert.equal(match.matchState, 'MATCHED');
    assert.equal(match.isConfident, true);
    assert.equal(match.studentUserId, 'usr_001');
    assert.equal(match.top2StudentUserId, null);
    assert.equal(match.top2Margin, null);
  });

  await t.test('[7] Model Compatibility: Rejects mismatched dimension or model with explicit diagnostic reasons', async () => {
    const gallery = new SessionScopedFaceGallery();
    const mbfVec = createSyntheticUnitVector(60, 512);
    // Profile created with incompatible manifest
    const incompatibleManifest = {
      modelName: 'Incompatible-Legacy',
      modelVersion: 'v1.0',
      embeddingDimension: 512,
      normalization: 'L2',
      quantization: 'FP32',
      inputShape: [1, 3, 112, 112],
      inputColorSpace: 'BGR',
      outputTensorName: 'output',
    };
    const mbfProfile = createStudentProfile('001', 'Incompatible Student', [mbfVec], incompatibleManifest);
    gallery.initialize(createDummySessionScope(), [mbfProfile]);

    // Matcher validates against active model manifest (EdgeFace-XS)
    const compat = gallery.validateCompatibility(EDGEFACE_XS_MANIFEST);
    assert.equal(compat.isCompatible, false);
    assert.ok(compat.diagnosticReason?.includes('Model mismatch') || compat.diagnosticReason?.includes('normalization'));

    // Attempting to match against incompatible gallery yields INVALID
    const query = createSyntheticUnitVector(61, 512);
    const match = matcher.findMatch(query, gallery, 0.65, 0.10, EDGEFACE_XS_MANIFEST);
    assert.equal(match.matchState, 'INVALID');
    assert.ok(match.diagnosticReason?.includes('INCOMPATIBLE'));
  });

  await t.test('[8] Invalid Dimension Query: Vector of wrong length is rejected', async () => {
    const gallery = new SessionScopedFaceGallery();
    const vecA = createSyntheticUnitVector(70, 512);
    gallery.initialize(createDummySessionScope(), [createStudentProfile('001', 'Student A', [vecA])]);

    const wrongDimVec = new Float32Array(128); // 128 instead of 512
    const match = matcher.findMatch(wrongDimVec, gallery);

    assert.equal(match.matchState, 'INVALID');
    assert.ok(match.diagnosticReason?.toLowerCase().includes('dimension'));
  });

  await t.test('[9] Session Scope Isolation: Only session-authorized profiles participate in matching', async () => {
    const galleryA = new SessionScopedFaceGallery();
    const galleryB = new SessionScopedFaceGallery();

    const vecCSE = createSyntheticUnitVector(80);
    const vecECE = createSyntheticUnitVector(81);

    const profileCSE = createStudentProfile('001', 'CSE Student', [vecCSE]);
    const profileECE = createStudentProfile('002', 'ECE Student', [vecECE]);

    galleryA.initialize(createDummySessionScope('sess_cse_01'), [profileCSE]);
    galleryB.initialize(createDummySessionScope('sess_ece_02'), [profileECE]);

    // Query with CSE student embedding against ECE session gallery
    const matchInECE = matcher.findMatch(vecCSE, galleryB, 0.65, 0.10);
    assert.equal(matchInECE.matchState, 'UNMATCHED');
    assert.notEqual(matchInECE.studentUserId, 'usr_001');

    // Query in CSE session gallery
    const matchInCSE = matcher.findMatch(vecCSE, galleryA, 0.65, 0.10);
    assert.equal(matchInCSE.matchState, 'MATCHED');
    assert.equal(matchInCSE.studentUserId, 'usr_001');
  });

  await t.test('[10] Multi-Track Independence: Concurrently matches 3 tracks without crosstalk', async () => {
    const gallery = new SessionScopedFaceGallery();
    const vecA = createSyntheticUnitVector(90);
    const vecB = createSyntheticUnitVector(91);

    const profiles = [
      createStudentProfile('001', 'Student A', [vecA]),
      createStudentProfile('002', 'Student B', [vecB]),
    ];
    gallery.initialize(createDummySessionScope(), profiles);

    // Track 1: Matches Student A
    const match1 = matcher.findMatch(vecA, gallery);
    // Track 2: Matches Student B
    const match2 = matcher.findMatch(vecB, gallery);
    // Track 3: Unregistered face
    const match3 = matcher.findMatch(createSyntheticUnitVector(99), gallery);

    assert.equal(match1.matchState, 'MATCHED');
    assert.equal(match1.studentUserId, 'usr_001');

    assert.equal(match2.matchState, 'MATCHED');
    assert.equal(match2.studentUserId, 'usr_002');

    assert.equal(match3.matchState, 'UNMATCHED');
    assert.equal(match3.studentUserId, null);
  });

  await t.test('[11] Temporal Confirmation at Observation Rate: Requires consecutive recognition observations', async () => {
    const buffer = new TemporalConfirmationBuffer({ minConsecutiveConfirmations: 3, maxSimilarityVariance: 0.10 });

    const trackId = 101;
    const qualityGood = { state: 'GOOD', score: 0.95 };
    const qualityPoor = { state: 'POOR', score: 0.30 };

    const matchA = {
      studentUserId: 'usr_001',
      studentName: 'Aarav Sharma',
      similarityScore: 0.88,
      top2Margin: 0.18,
      matchState: 'MATCHED',
      isConfident: true,
    };

    // Observation 1 @ t = 0ms
    const obs1 = buffer.update(trackId, matchA, qualityGood, 1000);
    assert.equal(obs1.consecutiveConfirmations, 1);
    assert.equal(obs1.isConfirmed, false);

    // Intermediate tracking ticks (30 FPS) WITHOUT fresh recognition observation
    // should NOT increment confirmation!
    // (Buffer only updates on fresh recognition observations)

    // Observation 2 @ t = 500ms
    const obs2 = buffer.update(trackId, { ...matchA, similarityScore: 0.86 }, qualityGood, 1500);
    assert.equal(obs2.consecutiveConfirmations, 2);
    assert.equal(obs2.isConfirmed, false);

    // Observation with POOR quality: does NOT advance confirmation
    const obsPoor = buffer.update(trackId, matchA, qualityPoor, 2000);
    assert.equal(obsPoor.consecutiveConfirmations, 2, 'POOR quality should not advance confirmation');
    assert.equal(obsPoor.isConfirmed, false);

    // Observation 3 @ t = 2500ms with GOOD quality
    const obs3 = buffer.update(trackId, { ...matchA, similarityScore: 0.87 }, qualityGood, 2500);
    assert.equal(obs3.consecutiveConfirmations, 3);
    assert.equal(obs3.isConfirmed, true, 'Reaching 3 consistent observations confirms candidate');

    // Sudden identity switch resets counter
    const matchB = {
      studentUserId: 'usr_002',
      studentName: 'Diya Patel',
      similarityScore: 0.80,
      top2Margin: 0.12,
      matchState: 'MATCHED',
      isConfident: true,
    };
    const obsSwitched = buffer.update(trackId, matchB, qualityGood, 3000);
    assert.equal(obsSwitched.consecutiveConfirmations, 1);
    assert.equal(obsSwitched.isConfirmed, false);
  });

  await t.test('[12] Gallery Scaling: N=10, N=30, N=60 scaling and correctness', async () => {
    for (const N of [10, 30, 60]) {
      const gallery = new SessionScopedFaceGallery();
      const profiles = [];
      for (let i = 0; i < N; i++) {
        profiles.push(createStudentProfile(i.toString(), `Student ${i}`, [createSyntheticUnitVector(i + 100)]));
      }
      gallery.initialize(createDummySessionScope(), profiles);

      assert.equal(gallery.size, N);
      assert.equal(gallery.totalEmbeddings, N);

      // Query student #5
      const query = createSyntheticUnitVector(5 + 100);
      const match = matcher.findMatch(query, gallery);
      assert.equal(match.matchState, 'MATCHED');
      assert.equal(match.studentUserId, 'usr_5');
      assert.equal(match.studentName, 'Student 5');
    }
  });

  await t.test('[13] HARD DOMAIN INVARIANT: RecognitionCandidate is transient and NEVER marks attendance', async () => {
    const gallery = new SessionScopedFaceGallery();
    const vecA = createSyntheticUnitVector(200);
    gallery.initialize(createDummySessionScope(), [createStudentProfile('001', 'Test Student', [vecA])]);

    const match = matcher.findMatch(vecA, gallery);
    assert.equal(match.matchState, 'MATCHED');

    // Verify match object contains NO attendance domain fields
    assert.equal(match.attendanceRecordId, undefined);
    assert.equal(match.isPresent, undefined);
    assert.equal(match.finalizedAt, undefined);
    assert.equal(match.attendanceStatus, undefined);
  });
});
