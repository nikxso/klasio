import type {
  AttendanceSessionContext,
  AttendanceFinalizationPayload,
  AttendanceFinalizationResult,
  ClassroomSessionLifecycleState,
  ScannerInteractionState,
  AccumulatedRecognitionCandidate,
  RecognitionCandidate,
  TrackedFace,
  ScannerMotionMetrics,
  SessionApplicabilityStatus,
} from '../../../perception/contracts.ts';

import { ProgressiveRecognitionAccumulator } from '../accumulator/ProgressiveRecognitionAccumulator.ts';
import { FacultyAttendanceReviewController } from '../review/FacultyAttendanceReviewController.ts';
import type { EligibleRosterStudent } from '../review/FacultyAttendanceReviewController.ts';
import { AttendanceRepository } from '../../../storage/attendanceRepository.ts';
import { AttendanceSyncWorker } from '../../../storage/syncWorker.ts';

export interface ClassroomSessionInitOptions {
  context: AttendanceSessionContext;
  roster: EligibleRosterStudent[];
}

export class ClassroomSessionController {
  private _context: AttendanceSessionContext;
  private _lifecycleState: ClassroomSessionLifecycleState = 'SCHEDULED';
  private _roster: EligibleRosterStudent[] = [];
  private _accumulator: ProgressiveRecognitionAccumulator;
  private _reviewController: FacultyAttendanceReviewController;
  private _isPaused: boolean = false;

  constructor(options: ClassroomSessionInitOptions) {
    if (!options.context.teachingAssignmentId) {
      throw new Error('Teaching assignment ID is required to initialize session');
    }
    if (!options.context.sessionDate) {
      throw new Error('Session date is required');
    }
    if (!options.context.periodSlotOrSequence || options.context.periodSlotOrSequence < 1) {
      throw new Error('Period slot or sequence must be an integer >= 1');
    }

    this._context = { ...options.context };
    this._roster = [...options.roster];
    this._accumulator = new ProgressiveRecognitionAccumulator();
    this._reviewController = new FacultyAttendanceReviewController();
    this._lifecycleState = 'READY';
  }

  public get context(): AttendanceSessionContext {
    return { ...this._context };
  }

  public get lifecycleState(): ClassroomSessionLifecycleState {
    return this._lifecycleState;
  }

  public get isPaused(): boolean {
    return this._isPaused;
  }

  /**
   * Transient interactive state of the camera scanner when in SCANNING lifecycle state.
   */
  public get scannerInteractionState(): ScannerInteractionState {
    return this._isPaused ? 'PAUSED' : 'ACTIVE';
  }

  public get roster(): EligibleRosterStudent[] {
    return [...this._roster];
  }

  public get reviewController(): FacultyAttendanceReviewController {
    return this._reviewController;
  }

  public get accumulator(): ProgressiveRecognitionAccumulator {
    return this._accumulator;
  }

  /**
   * Updates session applicability and status reason.
   */
  public setApplicability(
    status: SessionApplicabilityStatus,
    reason?: string | null
  ): void {
    if (this._lifecycleState === 'FINALIZED' || this._lifecycleState === 'SYNCHRONIZED') {
      throw new Error('Cannot change applicability on finalized session');
    }

    if (status !== 'COUNTED') {
      if (!reason || reason.trim().length === 0) {
        throw new Error(`A non-empty statusReason is mandatory when applicability is ${status}`);
      }
    }

    this._context.applicabilityStatus = status;
    this._context.statusReason = reason ?? null;

    if (status === 'CANCELLED') {
      this._lifecycleState = 'CANCELLED';
    } else if (status === 'EXEMPT') {
      this._lifecycleState = 'EXEMPT';
    } else if (this._lifecycleState === 'CANCELLED' || this._lifecycleState === 'EXEMPT') {
      this._lifecycleState = 'READY';
    }
  }

  /**
   * Sets period slot or sequence identifier (e.g. 1, 2, 3...)
   */
  public setPeriodSlot(slot: number): void {
    if (this._lifecycleState === 'FINALIZED' || this._lifecycleState === 'SYNCHRONIZED') {
      throw new Error('Cannot change period slot on finalized session');
    }
    if (slot < 1) {
      throw new Error('Period slot must be >= 1');
    }
    this._context.periodSlotOrSequence = slot;
  }

  /**
   * Enters active classroom scanning state.
   */
  public startScanning(): void {
    if (this._lifecycleState === 'FINALIZED' || this._lifecycleState === 'SYNCHRONIZED') {
      throw new Error('Session is already finalized');
    }
    this._lifecycleState = 'SCANNING';
    this._isPaused = false;
  }

  /**
   * Pauses scanning (e.g. faculty moves across rows or talks to class).
   */
  public pauseScanning(): void {
    if (this._lifecycleState === 'SCANNING') {
      this._isPaused = true;
    }
  }

  /**
   * Resumes scanning.
   */
  public resumeScanning(): void {
    if (this._lifecycleState === 'SCANNING') {
      this._isPaused = false;
    }
  }

  /**
   * Ingests a perception frame into the progressive accumulator.
   */
  public processPerceptionFrame(
    candidates: RecognitionCandidate[],
    trackedFaces: TrackedFace[],
    timestampMs: number
  ): void {
    if (this._lifecycleState !== 'SCANNING' || this._isPaused) {
      return;
    }
    this._accumulator.processFrameCandidates(candidates, trackedFaces, timestampMs);
  }

  /**
   * Retrieves real-time scanner metrics & motion guidance prompt.
   */
  public getScannerMetrics(): ScannerMotionMetrics & { guidanceText: string } {
    const metrics = this._accumulator.getScannerMetrics();
    let guidanceText = 'Slowly pan across the room to spot students…';

    if (this._isPaused) {
      guidanceText = 'Scanning paused — tap resume to continue';
    } else if (metrics.state === 'PANNING') {
      guidanceText = 'Camera moving too fast — slow down to capture faces';
    } else if (this._accumulator.getStats().activeTrackCount > 0) {
      const active = this._accumulator.getStats().activeTrackCount;
      guidanceText = `${active} student face${active > 1 ? 's' : ''} tracked in viewfinder`;
    }

    return {
      ...metrics,
      guidanceText,
    };
  }

  /**
   * Returns deduplicated accumulated candidates from progressive sweeps.
   */
  public getAccumulatedCandidates(): AccumulatedRecognitionCandidate[] {
    return this._accumulator.getAccumulatedCandidates();
  }

  /**
   * Transitions from scanning to candidate review.
   * Reconciles accumulated candidates against the authorized date-bounded roster.
   */
  public proceedToReview(): void {
    if (this._lifecycleState === 'FINALIZED' || this._lifecycleState === 'SYNCHRONIZED') {
      throw new Error('Session is already finalized');
    }

    const candidates = this._accumulator.getAccumulatedCandidates();
    this._reviewController.initialize(this._context, this._roster, candidates);
    this._lifecycleState = 'REVIEW';
  }

  /**
   * Validates finalization readiness.
   */
  public validateFinalization(): { canFinalize: boolean; errors: string[] } {
    return this._reviewController.validateFinalization();
  }

  /**
   * Atomically finalizes the session:
   * 1. Validates completeness (all roster students marked in COUNTED session).
   * 2. Assembles finalization payload.
   * 3. Commits to SQLite local_attendance_sessions, local_attendance_records, and sync_queue.
   * 4. Transitions lifecycle state to FINALIZED.
   */
  public async finalize(customDb?: any): Promise<AttendanceFinalizationResult> {
    if (this._lifecycleState === 'FINALIZED' || this._lifecycleState === 'SYNCHRONIZED') {
      throw new Error('Session is already finalized');
    }

    const payload = this._reviewController.prepareFinalizationPayload();
    const result = await AttendanceRepository.finalizeSession(payload, customDb);

    this._reviewController.markFinalized();
    this._lifecycleState = 'FINALIZED';

    return result;
  }

  /**
   * Attempts background synchronization using the existing Step J AttendanceSyncWorker.
   * Updates state to SYNCING, then SYNCHRONIZED on success, or remains FINALIZED if offline.
   */
  public async attemptSync(
    customWorker?: typeof AttendanceSyncWorker,
    customDb?: any
  ): Promise<'SYNCHRONIZED' | 'PENDING_OFFLINE'> {
    if (this._lifecycleState !== 'FINALIZED' && this._lifecycleState !== 'SYNCHRONIZED') {
      throw new Error('Cannot sync session before finalization');
    }

    const worker = customWorker ?? AttendanceSyncWorker;
    this._lifecycleState = 'SYNCING';

    try {
      const pending = await worker.getPendingQueueItems(5, customDb);
      const matching = pending.find((p) => p.clientSessionUuid === this._context.clientSessionUuid);

      if (matching) {
        // Pending in sync queue (offline or awaiting retry)
        this._lifecycleState = 'FINALIZED';
        return 'PENDING_OFFLINE';
      }

      // Check if already acknowledged in local sync queue
      const status = await AttendanceRepository.getSyncStatus(this._context.clientSessionUuid, customDb);
      if (status && status.syncStatus === 'ACKNOWLEDGED') {
        this._lifecycleState = 'SYNCHRONIZED';
        return 'SYNCHRONIZED';
      }

      this._lifecycleState = 'FINALIZED';
      return 'PENDING_OFFLINE';
    } catch {
      this._lifecycleState = 'FINALIZED';
      return 'PENDING_OFFLINE';
    }
  }
}
