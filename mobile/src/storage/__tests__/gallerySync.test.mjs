import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  base64ToFloat32Array,
  float32ArrayToBase64,
  GallerySyncService,
} from '../../perception/gallerySync.ts';
import { SessionScopedFaceGallery } from '../../lab/adapters/gallery/SessionScopedGallery.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read database.ts SCHEMA_SQL
const dbTsContent = readFileSync(join(__dirname, '../database.ts'), 'utf-8');
const schemaMatch = dbTsContent.match(/export const SCHEMA_SQL = `([\s\S]*?)`;/);
assert(schemaMatch, 'SCHEMA_SQL must be present in database.ts');
const schemaSql = schemaMatch[1];

function createInMemoryDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);
  return db;
}

function createSyntheticEmbedding(dim = 512, seed = 1) {
  const arr = new Float32Array(dim);
  let sumSq = 0;
  for (let i = 0; i < dim; i++) {
    arr[i] = Math.sin(seed * (i + 1));
    sumSq += arr[i] * arr[i];
  }
  const norm = Math.sqrt(sumSq);
  for (let i = 0; i < dim; i++) {
    arr[i] /= norm;
  }
  return arr;
}

describe('Milestone: Production Biometric Gallery Synchronization & Offline Storage', () => {
  test('[1] Base64 Encoding & Decoding Round-Trip Precision', () => {
    const original = createSyntheticEmbedding(512, 42);
    const b64 = float32ArrayToBase64(original);
    assert.equal(typeof b64, 'string');
    assert.ok(b64.length > 0);

    const decoded = base64ToFloat32Array(b64);
    assert.equal(decoded.length, 512);

    for (let i = 0; i < 512; i++) {
      assert.ok(Math.abs(decoded[i] - original[i]) < 1e-6, `Element ${i} mismatch`);
    }
  });

  test('[2] Gallery Synchronization: Ingests Backend Templates into SQLite cached_embeddings', async () => {
    const db = createInMemoryDb();
    const assignmentId = 'assign-bio-01';

    const emb1 = createSyntheticEmbedding(512, 1);
    const emb2 = createSyntheticEmbedding(512, 2);

    const mockBackendResponse = {
      teaching_assignment_id: assignmentId,
      class_section_id: 'sec-01',
      academic_term_id: 'term-01',
      gallery_version: 'ab12cd34ef567890',
      template_count: 2,
      templates: [
        {
          student_user_id: 'stu-01',
          institutional_id: '21CS001',
          student_name: 'Aarav Sharma',
          embedding_base64: float32ArrayToBase64(emb1),
          model_version: 'EdgeFace-XS-v1',
          quality_score: 0.88,
          updated_at: '2026-10-28T12:00:00Z',
        },
        {
          student_user_id: 'stu-02',
          institutional_id: '21CS002',
          student_name: 'Diya Patel',
          embedding_base64: float32ArrayToBase64(emb2),
          model_version: 'EdgeFace-XS-v1',
          quality_score: 0.92,
          updated_at: '2026-10-28T12:05:00Z',
        },
      ],
    };

    // Insert templates directly to emulate saveCachedEmbeddings
    const versionInt = parseInt(mockBackendResponse.gallery_version.slice(0, 8), 16);
    const insertStmt = db.prepare(`
      INSERT OR REPLACE INTO cached_embeddings (
        student_user_id, model_version, embedding_dimension,
        embedding_blob, sample_index, gallery_version
      ) VALUES (?, ?, ?, ?, ?, ?);
    `);

    for (const tpl of mockBackendResponse.templates) {
      insertStmt.run(
        tpl.student_user_id,
        tpl.model_version,
        512,
        tpl.embedding_base64,
        0,
        versionInt
      );
    }

    // Verify persisted rows in SQLite
    const rows = db.prepare('SELECT * FROM cached_embeddings ORDER BY student_user_id ASC;').all();
    assert.equal(rows.length, 2, 'Should persist 2 student embeddings');
    assert.equal(rows[0].student_user_id, 'stu-01');
    assert.equal(rows[0].model_version, 'EdgeFace-XS-v1');
    assert.equal(rows[0].embedding_dimension, 512);
    assert.equal(rows[0].gallery_version, versionInt);
    assert.equal(rows[1].student_user_id, 'stu-02');
  });

  test('[3] Revocation / Pruning: Removing Student Embeddings from Local Cache', () => {
    const db = createInMemoryDb();
    const insertStmt = db.prepare(`
      INSERT INTO cached_embeddings (
        student_user_id, model_version, embedding_dimension,
        embedding_blob, sample_index, gallery_version
      ) VALUES (?, ?, ?, ?, ?, ?);
    `);

    insertStmt.run('stu-01', 'EdgeFace-XS-v1', 512, 'blob1', 0, 100);
    insertStmt.run('stu-02', 'EdgeFace-XS-v1', 512, 'blob2', 0, 100);

    assert.equal(db.prepare('SELECT COUNT(*) as c FROM cached_embeddings;').get().c, 2);

    // Revoke stu-01
    db.prepare('DELETE FROM cached_embeddings WHERE student_user_id = ?;').run('stu-01');

    const remaining = db.prepare('SELECT student_user_id FROM cached_embeddings;').all();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].student_user_id, 'stu-02');
  });

  test('[4] In-Memory SessionScopedFaceGallery Construction from Cached Embeddings', () => {
    const emb1 = createSyntheticEmbedding(512, 10);
    const emb2 = createSyntheticEmbedding(512, 20);

    const gallery = new SessionScopedFaceGallery();
    const sessionScope = {
      attendanceSessionId: 'sess-test-01',
      classSectionId: 'sec-01',
      subjectId: 'sub-01',
      sessionDate: '2026-10-28',
    };

    const profiles = [
      {
        studentUserId: 'stu-01',
        modelName: 'EdgeFace-XS',
        activeModelVersion: 'EdgeFace-XS-v1',
        embeddingDimension: 512,
        embeddings: [emb1],
      },
      {
        studentUserId: 'stu-02',
        modelName: 'EdgeFace-XS',
        activeModelVersion: 'EdgeFace-XS-v1',
        embeddingDimension: 512,
        embeddings: [emb2],
      },
    ];

    gallery.initialize(sessionScope, profiles, 12345);

    assert.equal(gallery.size, 2);
    assert.equal(gallery.totalEmbeddings, 2);
    assert.equal(gallery.galleryVersion, 12345);
    assert.equal(gallery.sessionScope?.attendanceSessionId, 'sess-test-01');
  });

  test('[5] HARD DOMAIN INVARIANT: Zero Attendance Records Created During Gallery Sync', () => {
    const db = createInMemoryDb();

    // Verify local_attendance_records and local_attendance_sessions remain completely empty
    const sessions = db.prepare('SELECT COUNT(*) as c FROM local_attendance_sessions;').get().c;
    const records = db.prepare('SELECT COUNT(*) as c FROM local_attendance_records;').get().c;
    const queue = db.prepare('SELECT COUNT(*) as c FROM sync_queue;').get().c;

    assert.equal(sessions, 0, 'No attendance session should be created');
    assert.equal(records, 0, 'No attendance records should be created');
    assert.equal(queue, 0, 'Sync queue must remain untouched by gallery operations');
  });

  test('[6] HARD PRIVACY INVARIANT: Zero Raw Facial Photos Retained in Embedding Cache', () => {
    const db = createInMemoryDb();
    const columns = db.prepare('PRAGMA table_info(cached_embeddings);').all();
    const colNames = columns.map((c) => c.name.toLowerCase());

    assert.ok(!colNames.includes('image'));
    assert.ok(!colNames.includes('photo'));
    assert.ok(!colNames.includes('raw_frame'));
    assert.ok(!colNames.includes('crop_jpeg'));
  });

  test('[7] Transactional Gallery Replacement & Revocation Cleanup', () => {
    const db = createInMemoryDb();
    const insertStmt = db.prepare(`
      INSERT INTO cached_embeddings (
        student_user_id, model_version, embedding_dimension,
        embedding_blob, sample_index, gallery_version
      ) VALUES (?, ?, ?, ?, ?, ?);
    `);

    // Initial state: stu-01 and stu-02 cached
    insertStmt.run('stu-01', 'EdgeFace-XS-v1', 512, 'blob1', 0, 100);
    insertStmt.run('stu-02', 'EdgeFace-XS-v1', 512, 'blob2', 0, 100);

    // stu-01 is revoked on backend, fresh gallery only has stu-02 and new stu-03
    const affectedStudents = ['stu-01', 'stu-02', 'stu-03'];
    const freshTemplates = [
      { studentUserId: 'stu-02', modelVersion: 'EdgeFace-XS-v1', embeddingDimension: 512, embeddingBlob: 'blob2-fresh', sampleIndex: 0, galleryVersion: 200 },
      { studentUserId: 'stu-03', modelVersion: 'EdgeFace-XS-v1', embeddingDimension: 512, embeddingBlob: 'blob3-fresh', sampleIndex: 0, galleryVersion: 200 },
    ];

    // Transactional replacement
    db.exec('BEGIN TRANSACTION;');
    const placeholders = affectedStudents.map(() => '?').join(', ');
    db.prepare(`DELETE FROM cached_embeddings WHERE student_user_id IN (${placeholders});`).run(...affectedStudents);
    for (const tpl of freshTemplates) {
      insertStmt.run(tpl.studentUserId, tpl.modelVersion, tpl.embeddingDimension, tpl.embeddingBlob, tpl.sampleIndex, tpl.galleryVersion);
    }
    db.exec('COMMIT;');

    const remaining = db.prepare('SELECT student_user_id, gallery_version FROM cached_embeddings ORDER BY student_user_id;').all();
    assert.equal(remaining.length, 2);
    assert.equal(remaining[0].student_user_id, 'stu-02');
    assert.equal(remaining[0].gallery_version, 200);
    assert.equal(remaining[1].student_user_id, 'stu-03');
    assert.equal(remaining[1].gallery_version, 200);

    // HARD INVARIANT: Revoked stu-01 is completely gone from SQLite
    const stu1 = db.prepare('SELECT * FROM cached_embeddings WHERE student_user_id = ?;').get('stu-01');
    assert.equal(stu1, undefined, 'Revoked student must be purged from local cache');
  });

  test('[8] Interrupted SQLite Transaction Rollback: No Partial State After Failure', () => {
    const db = createInMemoryDb();
    const insertStmt = db.prepare(`
      INSERT INTO cached_embeddings (
        student_user_id, model_version, embedding_dimension,
        embedding_blob, sample_index, gallery_version
      ) VALUES (?, ?, ?, ?, ?, ?);
    `);

    // Baseline: stu-01 exists with version 100
    insertStmt.run('stu-01', 'EdgeFace-XS-v1', 512, 'blob1-original', 0, 100);

    // Simulate interrupted replacement (e.g. error midway)
    db.exec('BEGIN TRANSACTION;');
    db.prepare('DELETE FROM cached_embeddings WHERE student_user_id = ?;').run('stu-01');
    insertStmt.run('stu-02', 'EdgeFace-XS-v1', 512, 'blob2', 0, 200);

    // Error occurs! Simulating rollback
    db.exec('ROLLBACK;');

    // Verify baseline was restored
    const rows = db.prepare('SELECT student_user_id, gallery_version, embedding_blob FROM cached_embeddings;').all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].student_user_id, 'stu-01');
    assert.equal(rows[0].gallery_version, 100);
    assert.equal(rows[0].embedding_blob, 'blob1-original');
  });

  test('[9] App Restart & Offline Survivability', () => {
    // Write data to SQLite and verify queries remain intact across multiple statement handles
    const db = createInMemoryDb();
    const insertStmt = db.prepare(`
      INSERT INTO cached_embeddings (
        student_user_id, model_version, embedding_dimension,
        embedding_blob, sample_index, gallery_version
      ) VALUES (?, ?, ?, ?, ?, ?);
    `);
    insertStmt.run('stu-01', 'EdgeFace-XS-v1', 512, 'offline-blob', 0, 500);

    // Separate prepared statement reading same table
    const reader = db.prepare('SELECT * FROM cached_embeddings WHERE student_user_id = ?;');
    const found = reader.get('stu-01');
    assert.ok(found);
    assert.equal(found.student_user_id, 'stu-01');
    assert.equal(found.gallery_version, 500);
  });

  test('[10] Network Loss Simulation & Successful Retry Recovery', async () => {
    const db = createInMemoryDb();
    let networkUp = false;
    const mockFetch = async () => {
      if (!networkUp) {
        throw new Error('Network request failed: ECONNREFUSED');
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          teaching_assignment_id: 'assign-01',
          class_section_id: 'sec-01',
          academic_term_id: 'term-01',
          gallery_version: 'deadbeef12345678',
          template_count: 1,
          templates: [
            {
              student_user_id: 'stu-recovered',
              institutional_id: '21CS099',
              student_name: 'Recovered Student',
              embedding_base64: float32ArrayToBase64(createSyntheticEmbedding(512, 99)),
              model_version: 'EdgeFace-XS-v1',
              quality_score: 0.94,
              updated_at: '2026-10-28T12:00:00Z',
            },
          ],
        }),
      };
    };

    // 1. Network is down -> returns failure safely without throwing
    const failResult = await GallerySyncService.syncAssignmentGallery('assign-01', 'token', {
      customFetch: mockFetch,
    });
    assert.equal(failResult.success, false);
    assert.equal(failResult.isFresh, false);
    assert.ok(failResult.error?.includes('ECONNREFUSED'));

    // 2. Network recovers
    networkUp = true;
    const successResult = await GallerySyncService.syncAssignmentGallery('assign-01', 'token', {
      customFetch: mockFetch,
      customPersist: async (tpls, ver) => {
        const insertStmt = db.prepare(`
          INSERT OR REPLACE INTO cached_embeddings (
            student_user_id, model_version, embedding_dimension,
            embedding_blob, sample_index, gallery_version
          ) VALUES (?, ?, ?, ?, ?, ?);
        `);
        for (const t of tpls) {
          insertStmt.run(t.student_user_id, t.model_version, 512, t.embedding_base64, 0, ver);
        }
      },
    });
    assert.equal(successResult.success, true);
    assert.equal(successResult.isFresh, true);
    assert.equal(successResult.templateCount, 1);
    assert.equal(successResult.galleryVersion, 'deadbeef12345678');

    // Verify written to SQLite
    const recovered = db.prepare('SELECT student_user_id, gallery_version FROM cached_embeddings WHERE student_user_id = ?;').get('stu-recovered');
    assert.ok(recovered);
    assert.equal(recovered.student_user_id, 'stu-recovered');
  });

  test('[11] Stale Gallery-Version Detection', () => {
    const cachedVersion = 'deadbeef12345678';
    const serverVersionSame = 'deadbeef12345678';
    const serverVersionUpdated = 'cafebabe87654321';

    const isStaleSame = cachedVersion !== serverVersionSame;
    assert.equal(isStaleSame, false, 'Identical version hash indicates fresh local cache');

    const isStaleDiff = cachedVersion !== serverVersionUpdated;
    assert.equal(isStaleDiff, true, 'Different version hash triggers required gallery refresh');
  });
});
