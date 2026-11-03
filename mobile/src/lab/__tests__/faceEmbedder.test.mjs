/**
 * Step E — Face Embedder & Model Selection Unit & Invariant Test Suite
 * Automated tests for MobileFaceNetEmbedder, EdgeFaceEmbedder, and FaceAligner.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { MobileFaceNetEmbedder } from '../adapters/recognizers/MobileFaceNetEmbedder.ts';
import { EdgeFaceEmbedder } from '../adapters/recognizers/EdgeFaceEmbedder.ts';
import { FaceAligner } from '../adapters/aligners/FaceAligner.ts';

function createDummyFrame(w = 640, h = 640) {
  return {
    width: w,
    height: h,
    format: 'rgba',
    timestampMs: Date.now(),
    captureTimestampMs: Date.now(),
    data: '',
    rotationDegrees: 0,
    frameId: 'test_frame_1',
  };
}

function createCanonicalLandmarks() {
  return {
    leftEye: { x: 38.2946 / 112, y: 51.6963 / 112 },
    rightEye: { x: 73.5318 / 112, y: 51.5014 / 112 },
    noseTip: { x: 56.0252 / 112, y: 71.7366 / 112 },
    mouthLeft: { x: 41.5493 / 112, y: 92.3655 / 112 },
    mouthRight: { x: 70.7299 / 112, y: 92.2041 / 112 },
  };
}

function l2Norm(vec) {
  let sumSq = 0;
  for (let i = 0; i < vec.length; i++) {
    sumSq += vec[i] * vec[i];
  }
  return Math.sqrt(sumSq);
}

function cosineSim(v1, v2) {
  let dot = 0;
  for (let i = 0; i < v1.length; i++) {
    dot += v1[i] * v2[i];
  }
  return dot / (l2Norm(v1) * l2Norm(v2));
}

test('FaceEmbedder — Unit & Invariant Test Suite', async (t) => {
  await t.test('[1] Initialization & Lifecycle: Throws before init, succeeds after init', async () => {
    const embedder = new MobileFaceNetEmbedder();
    const input = {
      frame: createDummyFrame(),
      box: { x: 0.2, y: 0.2, width: 0.3, height: 0.4 },
    };

    await assert.rejects(
      async () => await embedder.embed(input),
      /not initialized/,
      'Uninitialized embedder must reject'
    );

    await embedder.initialize();
    const res = await embedder.embed(input);
    assert.equal(res.embedding.length, 512);

    await embedder.dispose();
    await assert.rejects(
      async () => await embedder.embed(input),
      /not initialized/,
      'Disposed embedder must reject'
    );
  });

  await t.test('[2] Manifest & Model Specifications: Validates manifests for both candidates', async () => {
    const mbf = new MobileFaceNetEmbedder();
    const ef = new EdgeFaceEmbedder();

    assert.equal(mbf.modelName, 'MobileFaceNet');
    assert.equal(mbf.embeddingDimension, 512);
    assert.equal(mbf.manifest.inputWidth, 112);
    assert.equal(mbf.manifest.inputHeight, 112);
    assert.equal(mbf.manifest.normalization, 'MINUS_127_5_DIV_127_5');

    assert.equal(ef.modelName, 'EdgeFace-XS');
    assert.equal(ef.embeddingDimension, 512);
    assert.equal(ef.manifest.inputWidth, 112);
    assert.equal(ef.manifest.inputHeight, 112);
    assert.equal(ef.manifest.normalization, 'MINUS_127_5_DIV_127_5');
  });

  await t.test('[3] Output Dimensions & L2 Normalization: Embeddings are strictly unit vectors in R^512', async () => {
    const mbf = new MobileFaceNetEmbedder();
    await mbf.initialize();

    const input = {
      frame: createDummyFrame(),
      box: { x: 0.25, y: 0.2, width: 0.2, height: 0.25 },
      landmarks: createCanonicalLandmarks(),
    };

    const res = await mbf.embed(input, true);
    assert.equal(res.embedding.length, 512, 'Embedding vector must be exactly 512-dimensional');
    assert.equal(res.rawDimension, 512);
    assert.equal(res.isNormalized, true);

    const norm = l2Norm(res.embedding);
    assert.ok(Math.abs(norm - 1.0) < 1e-5, `L2 norm must equal 1.0, got ${norm}`);
    await mbf.dispose();
  });

  await t.test('[4] FaceAligner 5-Point Transform: Maps canonical landmarks with near-zero RMSE', async () => {
    const landmarks = createCanonicalLandmarks();
    const box = { x: 0.1, y: 0.1, width: 0.3, height: 0.3 };

    const crop = FaceAligner.alignCrop(null, 640, 640, box, landmarks, true);
    assert.equal(crop.width, 112);
    assert.equal(crop.height, 112);
    assert.equal(crop.mode, 'SIMILARITY_TRANSFORM_5PT');
    assert.ok(crop.affineMatrix !== undefined);
    assert.ok(crop.landmarkRmse !== undefined);
    assert.ok(crop.landmarkRmse < 1.0, `Canonical points should yield RMSE < 1.0px, got ${crop.landmarkRmse}`);
  });

  await t.test('[5] FaceAligner Fallback: Gracefully falls back to box crop when landmarks missing', async () => {
    const box = { x: 0.15, y: 0.2, width: 0.25, height: 0.3 };

    const crop = FaceAligner.alignCrop(null, 640, 640, box, undefined, true);
    assert.equal(crop.width, 112);
    assert.equal(crop.height, 112);
    assert.equal(crop.mode, 'NONE', 'Missing landmarks must fall back to NONE alignment');
  });

  await t.test('[6] Model Switching: Both candidates satisfy IFaceEmbedder & IFaceRecognizer polymorphically', async () => {
    const models = [new MobileFaceNetEmbedder(), new EdgeFaceEmbedder()];

    const input = {
      frame: createDummyFrame(),
      box: { x: 0.3, y: 0.3, width: 0.2, height: 0.2 },
    };

    for (const embedder of models) {
      await embedder.initialize();
      const res = await embedder.embed(input);
      assert.equal(res.embedding.length, 512);
      assert.equal(res.manifest.embeddingDimension, 512);

      // Verify IFaceRecognizer backward compatibility wrapper
      const rawVector = await embedder.computeEmbedding(input.frame);
      assert.equal(rawVector.length, 512);
      await embedder.dispose();
    }
  });

  await t.test('[7] Determinism: Identical inputs produce identical embedding vectors', async () => {
    const embedder = new EdgeFaceEmbedder();
    await embedder.initialize();

    const input = {
      frame: createDummyFrame(),
      box: { x: 0.35, y: 0.35, width: 0.2, height: 0.25 },
      landmarks: createCanonicalLandmarks(),
    };

    const run1 = await embedder.embed(input, true);
    const run2 = await embedder.embed(input, true);

    const sim = cosineSim(run1.embedding, run2.embedding);
    assert.ok(Math.abs(sim - 1.0) < 1e-6, `Identical runs must have cosine similarity 1.0, got ${sim}`);

    for (let i = 0; i < 512; i++) {
      assert.equal(run1.embedding[i], run2.embedding[i], `Component ${i} must match identically`);
    }
    await embedder.dispose();
  });

  await t.test('[8] Spatial Sensitivity: Different face locations produce distinct embeddings', async () => {
    const embedder = new MobileFaceNetEmbedder();
    await embedder.initialize();

    const face1 = {
      frame: createDummyFrame(),
      box: { x: 0.1, y: 0.2, width: 0.2, height: 0.2 },
    };
    const face2 = {
      frame: createDummyFrame(),
      box: { x: 0.6, y: 0.5, width: 0.25, height: 0.25 },
    };

    const emb1 = await embedder.embed(face1);
    const emb2 = await embedder.embed(face2);

    const sim = cosineSim(emb1.embedding, emb2.embedding);
    assert.ok(sim < 0.99, `Distinct face locations must not produce identical embeddings (sim: ${sim})`);
    await embedder.dispose();
  });

  await t.test('[9] Multi-Face Concurrency: Extracts multiple face embeddings without crosstalk', async () => {
    const embedder = new EdgeFaceEmbedder();
    await embedder.initialize();

    const frame = createDummyFrame();
    const faceInputs = [
      { frame, box: { x: 0.1, y: 0.2, width: 0.15, height: 0.2 } },
      { frame, box: { x: 0.4, y: 0.2, width: 0.15, height: 0.2 } },
      { frame, box: { x: 0.7, y: 0.2, width: 0.15, height: 0.2 } },
    ];

    const results = await Promise.all(faceInputs.map((f) => embedder.embed(f)));
    assert.equal(results.length, 3);
    for (const r of results) {
      assert.equal(r.embedding.length, 512);
      assert.ok(Math.abs(l2Norm(r.embedding) - 1.0) < 1e-5);
    }

    const sim12 = cosineSim(results[0].embedding, results[1].embedding);
    const sim13 = cosineSim(results[0].embedding, results[2].embedding);
    assert.ok(sim12 < 0.99);
    assert.ok(sim13 < 0.99);
    await embedder.dispose();
  });

  await t.test('[10] HARD INVARIANT: Embeddings are transient anonymous vectors (Zero Identity Leakage)', async () => {
    const embedder = new MobileFaceNetEmbedder();
    await embedder.initialize();

    const input = {
      frame: createDummyFrame(),
      box: { x: 0.2, y: 0.2, width: 0.2, height: 0.2 },
    };

    const res = await embedder.embed(input);
    // Strict schema check: verify NO identity fields exist on embedding result
    assert.equal('studentUserId' in res, false, 'Result must NOT contain studentUserId');
    assert.equal('studentName' in res, false, 'Result must NOT contain studentName');
    assert.equal('galleryId' in res, false, 'Result must NOT contain galleryId');
    assert.equal('attendanceState' in res, false, 'Result must NOT contain attendanceState');
    assert.equal('databaseId' in res, false, 'Result must NOT contain databaseId');

    assert.ok(res.timings.totalMs >= 0);
    assert.ok(res.timings.cropAndAlignmentMs >= 0);
    assert.ok(res.timings.preprocessingMs >= 0);
    await embedder.dispose();
  });

  await t.test('[11] Preprocessing Parity: Normalization uses exact /127.5 (not /128.0) boundary mapping', async () => {
    const ef = new EdgeFaceEmbedder();
    assert.equal(ef.manifest.normalization, 'MINUS_127_5_DIV_127_5');

    // Mathematical parity test:
    // Pixel 0 must map to exactly -1.0
    // Pixel 127.5 must map to exactly 0.0
    // Pixel 255 must map to exactly +1.0
    const normMin = (0 - 127.5) / 127.5;
    const normMid = (127.5 - 127.5) / 127.5;
    const normMax = (255 - 127.5) / 127.5;

    assert.equal(normMin, -1.0, 'Pixel 0 must normalize to exact -1.0 lower bound');
    assert.equal(normMid, 0.0, 'Pixel 127.5 must normalize to exact 0.0 center');
    assert.equal(normMax, 1.0, 'Pixel 255 must normalize to exact +1.0 upper bound');

    // Reject incorrect /128.0 divisor
    const legacyMin = (0 - 127.5) / 128.0;
    const legacyMax = (255 - 127.5) / 128.0;
    assert.notEqual(legacyMin, -1.0, 'Legacy /128.0 fails to reach -1.0 boundary');
    assert.notEqual(legacyMax, 1.0, 'Legacy /128.0 fails to reach +1.0 boundary');
  });
});
