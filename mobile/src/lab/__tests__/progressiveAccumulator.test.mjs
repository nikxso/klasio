/**
 * Step G — Progressive Classroom Recognition Test Suite
 * Automated tests for ProgressiveRecognitionAccumulator and Scanner Motion Stability.
 *
 * Strict invariants verified:
 * 1. Single candidate admission on confirmed MATCHED candidate.
 * 2. Deduplication of repeated observations of the same student on the same track.
 * 3. Deduplication across track replacement (track retirement and reappearance under new trackId).
 * 4. Multi-student independent accumulation.
 * 5. Strict rejection of AMBIGUOUS candidates.
 * 6. Strict rejection of UNMATCHED candidates.
 * 7. Strict rejection of INVALID candidates.
 * 8. Resilience against temporary POOR quality frames (freezes observation, preserves accumulated state).
 * 9. Reappearance updates timestamps and best scores without duplicating identity.
 * 10. Multi-track concurrent frame updates without cross-contamination.
 * 11. Multi-region progressive panning sweep (Region 1 -> 2 -> 3 -> 1) with exact deduplication.
 * 12. Scanner motion stability state transitions (STABLE vs PANNING, admission gating).
 * 13. Complete session reset clears accumulated state.
 * 14. HARD INVARIANT: AccumulatedRecognitionCandidate is distinct from AttendanceRecord.
 * 15. HARD INVARIANT: Zero attendance marking or finalization occurs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ProgressiveRecognitionAccumulator } from '../adapters/accumulator/ProgressiveRecognitionAccumulator.ts';

function createMockTrackedFace(trackId, x = 0.5, y = 0.5, width = 0.15, height = 0.20) {
  return {
    trackId,
    boundingBox: { x, y, width, height },
    confidence: 0.95,
    ageInFrames: 5,
    timeSinceLastSeenMs: 0,
    isConfirmed: true,
  };
}

function createMockRecognitionCandidate(trackId, studentId, studentName, similarity = 0.88, quality = 0.90, detectedAtMs = 1000) {
  return {
    trackId,
    match: {
      studentUserId: `usr_${studentId}`,
      institutionalId: `STU-2026-${studentId.toString().padStart(3, '0')}`,
      studentName,
      similarityScore: similarity,
      top2StudentUserId: 'usr_other',
      top2SimilarityScore: similarity - 0.20,
      top2Margin: 0.20,
      matchState: 'MATCHED',
      isConfident: true,
    },
    qualityScore: quality,
    detectedAtMs,
    consecutiveConfirmations: 2,
    isConfirmed: true,
  };
}

function createAmbiguousCandidate(trackId, detectedAtMs = 1000) {
  return {
    trackId,
    match: {
      studentUserId: 'usr_ambiguous',
      institutionalId: 'STU-AMB-001',
      studentName: 'Ambiguous Candidate',
      similarityScore: 0.72,
      top2StudentUserId: 'usr_competitor',
      top2SimilarityScore: 0.70,
      top2Margin: 0.02,
      matchState: 'AMBIGUOUS',
      isConfident: false,
      diagnosticReason: 'Margin below threshold',
    },
    qualityScore: 0.85,
    detectedAtMs,
    consecutiveConfirmations: 2,
    isConfirmed: false,
  };
}

function createUnmatchedCandidate(trackId, detectedAtMs = 1000) {
  return {
    trackId,
    match: {
      studentUserId: null,
      institutionalId: null,
      studentName: null,
      similarityScore: 0.45,
      top2StudentUserId: null,
      top2SimilarityScore: null,
      top2Margin: null,
      matchState: 'UNMATCHED',
      isConfident: false,
      diagnosticReason: 'Similarity below threshold',
    },
    qualityScore: 0.85,
    detectedAtMs,
    consecutiveConfirmations: 2,
    isConfirmed: false,
  };
}

test('Step G: Progressive Recognition Accumulator & Scanner Motion Test Suite', async (t) => {
  await t.test('[1] First confirmed MATCHED candidate is admitted into the accumulator', () => {
    const accumulator = new ProgressiveRecognitionAccumulator();
    const track = createMockTrackedFace(1);
    const candidate = createMockRecognitionCandidate(1, '001', 'Aarav Sharma', 0.89, 0.92, 1000);

    accumulator.processFrameCandidates([candidate], [track], 1000);

    const accumulated = accumulator.getAccumulatedCandidates();
    assert.equal(accumulated.length, 1);
    const item = accumulated[0];
    assert.equal(item.studentUserId, 'usr_001');
    assert.equal(item.studentName, 'Aarav Sharma');
    assert.equal(item.institutionalId, 'STU-2026-001');
    assert.equal(item.firstSeenAtMs, 1000);
    assert.equal(item.lastSeenAtMs, 1000);
    assert.equal(item.totalObservations, 1);
    assert.equal(item.bestSimilarityScore, 0.89);
    assert.equal(item.bestQualityScore, 0.92);
    assert.equal(item.lastTrackId, 1);
    assert.equal(item.isConfirmed, true);
  });

  await t.test('[2] Repeated observations of the same student on the same track update timestamps and deduplicate', () => {
    const accumulator = new ProgressiveRecognitionAccumulator();
    const track = createMockTrackedFace(1);
    const cand1 = createMockRecognitionCandidate(1, '001', 'Aarav Sharma', 0.85, 0.88, 1000);
    const cand2 = createMockRecognitionCandidate(1, '001', 'Aarav Sharma', 0.91, 0.95, 1200);

    accumulator.processFrameCandidates([cand1], [track], 1000);
    accumulator.processFrameCandidates([cand2], [track], 1200);

    const accumulated = accumulator.getAccumulatedCandidates();
    assert.equal(accumulated.length, 1, 'Should NOT create duplicate candidate');
    const item = accumulated[0];
    assert.equal(item.totalObservations, 2);
    assert.equal(item.firstSeenAtMs, 1000);
    assert.equal(item.lastSeenAtMs, 1200);
    assert.equal(item.bestSimilarityScore, 0.91, 'Should retain maximum similarity score');
    assert.equal(item.bestQualityScore, 0.95, 'Should retain maximum quality score');
  });

  await t.test('[3] Same student reappearing on a DIFFERENT trackId is deduplicated by studentUserId', () => {
    const accumulator = new ProgressiveRecognitionAccumulator();

    // Frame 1: Aarav appears as track 10
    const track10 = createMockTrackedFace(10);
    const cand10 = createMockRecognitionCandidate(10, '001', 'Aarav Sharma', 0.86, 0.89, 1000);
    accumulator.processFrameCandidates([cand10], [track10], 1000);

    // Track 10 is retired (camera pans away or student turns around)
    // Frame 2: 5 seconds later, student reappears as track 25
    const track25 = createMockTrackedFace(25);
    const cand25 = createMockRecognitionCandidate(25, '001', 'Aarav Sharma', 0.93, 0.94, 6000);
    accumulator.processFrameCandidates([cand25], [track25], 6000);

    const accumulated = accumulator.getAccumulatedCandidates();
    assert.equal(accumulated.length, 1, 'Same student on different trackId must NOT duplicate');
    const item = accumulated[0];
    assert.equal(item.studentUserId, 'usr_001');
    assert.equal(item.totalObservations, 2);
    assert.equal(item.firstSeenAtMs, 1000);
    assert.equal(item.lastSeenAtMs, 6000);
    assert.equal(item.lastTrackId, 25, 'Should update last observed trackId');
    assert.equal(item.bestSimilarityScore, 0.93);
  });

  await t.test('[4] Multiple distinct students accumulate independently', () => {
    const accumulator = new ProgressiveRecognitionAccumulator();

    const track1 = createMockTrackedFace(1, 0.2, 0.3);
    const track2 = createMockTrackedFace(2, 0.7, 0.3);
    const cand1 = createMockRecognitionCandidate(1, '001', 'Aarav Sharma', 0.88, 0.90, 1000);
    const cand2 = createMockRecognitionCandidate(2, '002', 'Diya Patel', 0.92, 0.94, 1000);

    accumulator.processFrameCandidates([cand1, cand2], [track1, track2], 1000);

    const accumulated = accumulator.getAccumulatedCandidates();
    assert.equal(accumulated.length, 2);

    const studentIds = accumulated.map((c) => c.studentUserId).sort();
    assert.deepEqual(studentIds, ['usr_001', 'usr_002']);

    const aarav = accumulator.getCandidate('usr_001');
    const diya = accumulator.getCandidate('usr_002');
    assert.ok(aarav);
    assert.ok(diya);
    assert.equal(aarav.studentName, 'Aarav Sharma');
    assert.equal(diya.studentName, 'Diya Patel');
  });

  await t.test('[5] AMBIGUOUS candidates are strictly rejected from accumulation', () => {
    const accumulator = new ProgressiveRecognitionAccumulator();
    const track = createMockTrackedFace(5);
    const ambiguousCand = createAmbiguousCandidate(5, 1000);

    accumulator.processFrameCandidates([ambiguousCand], [track], 1000);

    const accumulated = accumulator.getAccumulatedCandidates();
    assert.equal(accumulated.length, 0, 'AMBIGUOUS candidate must NOT be accumulated');
    assert.equal(accumulator.getStats().totalRejections, 1);
  });

  await t.test('[6] UNMATCHED candidates are strictly rejected from accumulation', () => {
    const accumulator = new ProgressiveRecognitionAccumulator();
    const track = createMockTrackedFace(6);
    const unmatchedCand = createUnmatchedCandidate(6, 1000);

    accumulator.processFrameCandidates([unmatchedCand], [track], 1000);

    const accumulated = accumulator.getAccumulatedCandidates();
    assert.equal(accumulated.length, 0, 'UNMATCHED candidate must NOT be accumulated');
    assert.equal(accumulator.getStats().totalRejections, 1);
  });

  await t.test('[7] INVALID candidates are strictly rejected from accumulation', () => {
    const accumulator = new ProgressiveRecognitionAccumulator();
    const track = createMockTrackedFace(7);
    const invalidCand = {
      trackId: 7,
      match: {
        studentUserId: null,
        institutionalId: null,
        studentName: null,
        similarityScore: -1.0,
        matchState: 'INVALID',
        isConfident: false,
        diagnosticReason: 'Corrupted embedding',
      },
      qualityScore: 0.80,
      detectedAtMs: 1000,
      consecutiveConfirmations: 0,
      isConfirmed: false,
    };

    accumulator.processFrameCandidates([invalidCand], [track], 1000);

    const accumulated = accumulator.getAccumulatedCandidates();
    assert.equal(accumulated.length, 0, 'INVALID candidate must NOT be accumulated');
    assert.equal(accumulator.getStats().totalRejections, 1);
  });

  await t.test('[8] Temporary POOR quality observation freezes progression without deleting established candidate', () => {
    const accumulator = new ProgressiveRecognitionAccumulator();
    const track = createMockTrackedFace(1);
    const goodCand = createMockRecognitionCandidate(1, '001', 'Aarav Sharma', 0.88, 0.92, 1000);

    // Initial admission with good quality
    accumulator.processFrameCandidates([goodCand], [track], 1000);
    assert.equal(accumulator.getAccumulatedCandidates().length, 1);

    // Subsequent frame: face experiences motion blur / occlusion (quality POOR or unconfirmed)
    const poorCand = {
      ...goodCand,
      qualityScore: 0.25,
      isConfirmed: false, // unconfirmed due to quality gate freeze
      detectedAtMs: 1100,
    };
    accumulator.processFrameCandidates([poorCand], [track], 1100);

    const accumulated = accumulator.getAccumulatedCandidates();
    assert.equal(accumulated.length, 1, 'Established candidate must NOT be deleted');
    const item = accumulated[0];
    assert.equal(item.studentUserId, 'usr_001');
    assert.equal(item.totalObservations, 1, 'Unconfirmed poor-quality observation should NOT advance count');
    assert.equal(item.lastSeenAtMs, 1000, 'Timestamp should remain at last confirmed observation');
  });

  await t.test('[9] Student reappearance after track retirement preserves firstSeenAtMs and updates lastSeenAtMs', () => {
    const accumulator = new ProgressiveRecognitionAccumulator();

    // First seen at t = 2000ms
    const track1 = createMockTrackedFace(1);
    const cand1 = createMockRecognitionCandidate(1, '005', 'Kavita Rao', 0.85, 0.88, 2000);
    accumulator.processFrameCandidates([cand1], [track1], 2000);

    // Student leaves scene, returns 15 seconds later (t = 17000ms) as track 12
    const track12 = createMockTrackedFace(12);
    const cand2 = createMockRecognitionCandidate(12, '005', 'Kavita Rao', 0.94, 0.96, 17000);
    accumulator.processFrameCandidates([cand2], [track12], 17000);

    const candidate = accumulator.getCandidate('usr_005');
    assert.ok(candidate);
    assert.equal(candidate.firstSeenAtMs, 2000);
    assert.equal(candidate.lastSeenAtMs, 17000);
    assert.equal(candidate.bestSimilarityScore, 0.94);
    assert.equal(candidate.bestQualityScore, 0.96);
    assert.equal(candidate.totalObservations, 2);
  });

  await t.test('[10] Multi-track concurrent frame updates maintain complete track isolation', () => {
    const accumulator = new ProgressiveRecognitionAccumulator();

    const track1 = createMockTrackedFace(101, 0.1, 0.2);
    const track2 = createMockTrackedFace(102, 0.5, 0.2);
    const track3 = createMockTrackedFace(103, 0.9, 0.2);

    const cand1 = createMockRecognitionCandidate(101, '010', 'Student Ten', 0.87, 0.90, 1000);
    const cand2 = createMockRecognitionCandidate(102, '020', 'Student Twenty', 0.91, 0.92, 1000);
    const cand3 = createMockRecognitionCandidate(103, '030', 'Student Thirty', 0.84, 0.89, 1000);

    accumulator.processFrameCandidates([cand1, cand2, cand3], [track1, track2, track3], 1000);

    assert.equal(accumulator.getAccumulatedCandidates().length, 3);
    assert.equal(accumulator.getCandidate('usr_010')?.lastTrackId, 101);
    assert.equal(accumulator.getCandidate('usr_020')?.lastTrackId, 102);
    assert.equal(accumulator.getCandidate('usr_030')?.lastTrackId, 103);
  });

  await t.test('[11] Progressive panning sweep across regions (1 -> 2 -> 3 -> 1) deduplicates perfectly', () => {
    const accumulator = new ProgressiveRecognitionAccumulator();

    // Region 1: Students 1..5 present simultaneously in classroom section 1
    const reg1Tracks = [];
    const reg1Cands = [];
    for (let i = 1; i <= 5; i++) {
      reg1Tracks.push(createMockTrackedFace(i, 0.15 * i, 0.3));
      reg1Cands.push(createMockRecognitionCandidate(i, i.toString(), `Student ${i}`, 0.85, 0.90, 1000));
    }
    accumulator.processFrameCandidates(reg1Cands, reg1Tracks, 1000);
    assert.equal(accumulator.getAccumulatedCandidates().length, 5);

    // Pan to Region 2: First frame at t = 3000 shows high churn / movement
    const reg2Tracks = [];
    const reg2Cands = [];
    for (let i = 6; i <= 10; i++) {
      reg2Tracks.push(createMockTrackedFace(i, 0.15 * (i - 5), 0.3));
      reg2Cands.push(createMockRecognitionCandidate(i, i.toString(), `Student ${i}`, 0.87, 0.91, 3000));
    }
    accumulator.processFrameCandidates([], reg2Tracks, 3000); // Camera arrives, stabilizing
    // Settled in Region 2 at t = 3400 (dt = 400ms >= 300ms)
    accumulator.processFrameCandidates(reg2Cands, reg2Tracks, 3400);
    assert.equal(accumulator.getAccumulatedCandidates().length, 10);

    // Pan to Region 3: First frame at t = 5000
    const reg3Tracks = [];
    const reg3Cands = [];
    for (let i = 11; i <= 15; i++) {
      reg3Tracks.push(createMockTrackedFace(i, 0.15 * (i - 10), 0.3));
      reg3Cands.push(createMockRecognitionCandidate(i, i.toString(), `Student ${i}`, 0.89, 0.93, 5000));
    }
    accumulator.processFrameCandidates([], reg3Tracks, 5000); // Camera arrives, stabilizing
    // Settled in Region 3 at t = 5400
    accumulator.processFrameCandidates(reg3Cands, reg3Tracks, 5400);
    assert.equal(accumulator.getAccumulatedCandidates().length, 15);

    // Pan back to Region 1: Students 1..5 reappear under new tracks 21..25
    const reg1ReturnTracks = [];
    const reg1ReturnCands = [];
    for (let i = 1; i <= 5; i++) {
      const newTrackId = 20 + i;
      reg1ReturnTracks.push(createMockTrackedFace(newTrackId, 0.15 * i, 0.3));
      reg1ReturnCands.push(createMockRecognitionCandidate(newTrackId, i.toString(), `Student ${i}`, 0.92, 0.95, 7400));
    }
    accumulator.processFrameCandidates([], reg1ReturnTracks, 7000); // Camera arrives back in Region 1
    accumulator.processFrameCandidates(reg1ReturnCands, reg1ReturnTracks, 7400);

    // Still exactly 15 unique students!
    assert.equal(accumulator.getAccumulatedCandidates().length, 15, 'Sweep back to Region 1 must deduplicate');
    // For students 1..5, observation count must be 2
    for (let i = 1; i <= 5; i++) {
      const student = accumulator.getCandidate(`usr_${i}`);
      assert.ok(student);
      assert.equal(student.totalObservations, 2);
      assert.equal(student.lastSeenAtMs, 7400);
      assert.equal(student.bestSimilarityScore, 0.92);
    }
  });

  await t.test('[12] Scanner motion stability state transitions between STABLE and PANNING', () => {
    const accumulator = new ProgressiveRecognitionAccumulator({
      scannerMotionConfig: {
        displacementPanningThreshold: 0.08,
        churnPanningThreshold: 0.40,
        stabilizationRequiredMs: 300,
      },
    });

    // Frame 1: Initial position at t = 1000
    const track1_t1 = createMockTrackedFace(1, 0.30, 0.40);
    const track2_t1 = createMockTrackedFace(2, 0.60, 0.40);
    accumulator.processFrameCandidates([], [track1_t1, track2_t1], 1000);

    let metrics = accumulator.getScannerMetrics();
    assert.equal(metrics.state, 'STABLE');

    // Frame 2: Rapid pan displacement (mean shift > 0.08) at t = 1050
    const track1_t2 = createMockTrackedFace(1, 0.45, 0.40); // dx = 0.15
    const track2_t2 = createMockTrackedFace(2, 0.75, 0.40); // dx = 0.15
    accumulator.processFrameCandidates([], [track1_t2, track2_t2], 1050);

    metrics = accumulator.getScannerMetrics();
    assert.equal(metrics.state, 'PANNING');
    assert.equal(metrics.isAdmissionPermitted, false, 'Admission should be paused during rapid panning');

    // Frame 3: Motion stops at t = 1100 (dx = 0.0)
    const track1_t3 = createMockTrackedFace(1, 0.45, 0.40);
    const track2_t3 = createMockTrackedFace(2, 0.75, 0.40);
    accumulator.processFrameCandidates([], [track1_t3, track2_t3], 1100);

    metrics = accumulator.getScannerMetrics();
    // In grace stabilization period (dt = 50ms < 300ms required)
    assert.equal(metrics.isAdmissionPermitted, false, 'Should wait for stabilizationRequiredMs');

    // Frame 4: Stable position sustained at t = 1450 (dt = 350ms >= 300ms)
    accumulator.processFrameCandidates([], [track1_t3, track2_t3], 1450);
    metrics = accumulator.getScannerMetrics();
    assert.equal(metrics.state, 'STABLE');
    assert.equal(metrics.isAdmissionPermitted, true, 'Admission permitted after stable window');
  });

  await t.test('[13] Session reset clears accumulated candidates and stats cleanly', () => {
    const accumulator = new ProgressiveRecognitionAccumulator();
    const track = createMockTrackedFace(1);
    const candidate = createMockRecognitionCandidate(1, '001', 'Aarav Sharma', 0.90, 0.90, 1000);

    accumulator.processFrameCandidates([candidate], [track], 1000);
    assert.equal(accumulator.getAccumulatedCandidates().length, 1);

    accumulator.reset();
    assert.equal(accumulator.getAccumulatedCandidates().length, 0);
    assert.equal(accumulator.getCandidate('usr_001'), undefined);
    assert.equal(accumulator.getStats().totalAccumulated, 0);
    assert.equal(accumulator.getStats().totalMatchesProcessed, 0);
  });

  await t.test('[14] HARD DOMAIN INVARIANT: RecognitionCandidate and AccumulatedRecognitionCandidate are distinct from AttendanceRecord', () => {
    const accumulator = new ProgressiveRecognitionAccumulator();
    const track = createMockTrackedFace(1);
    const candidate = createMockRecognitionCandidate(1, '001', 'Aarav Sharma', 0.90, 0.90, 1000);

    accumulator.processFrameCandidates([candidate], [track], 1000);
    const accumulated = accumulator.getAccumulatedCandidates()[0];

    // Assert that no attendance domain properties exist on AccumulatedRecognitionCandidate
    assert.equal(accumulated.attendanceRecordId, undefined);
    assert.equal(accumulated.isPresent, undefined);
    assert.equal(accumulated.status, undefined);
    assert.equal(accumulated.attendanceStatus, undefined);
    assert.equal(accumulated.finalizedAt, undefined);
    assert.equal(accumulated.isApproved, undefined);
  });

  await t.test('[15] HARD DOMAIN INVARIANT: Zero attendance marking or finalization occurs', () => {
    const accumulator = new ProgressiveRecognitionAccumulator();
    // Verify accumulator has no attendance mutation methods
    assert.equal(accumulator.markPresent, undefined);
    assert.equal(accumulator.markAbsent, undefined);
    assert.equal(accumulator.finalizeAttendance, undefined);
    assert.equal(accumulator.saveAttendanceRecord, undefined);
  });
});
