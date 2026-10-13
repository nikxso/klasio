import type {
  AttendanceSessionContext,
  AttendanceReviewItem,
  AttendanceReviewSource,
  AttendanceReviewStatus,
  AttendanceFinalizationPayload,
  AttendanceFinalizationRecord,
  AttendanceIdentityCorrection,
  IFacultyAttendanceReviewController,
  SessionLifecycleStatus,
  AccumulatedRecognitionCandidate,
} from '../../../perception/contracts.ts';

export interface EligibleRosterStudent {
  studentUserId: string;
  institutionalId: string;
  studentName: string;
  effectiveStartDate: string;
  effectiveEndDate?: string | null;
  faceRegistrationState: 'UNREGISTERED' | 'PENDING' | 'REGISTERED';
}

export class FacultyAttendanceReviewController implements IFacultyAttendanceReviewController {
  private _context: AttendanceSessionContext | null = null;
  private _lifecycleStatus: SessionLifecycleStatus = 'DRAFT';
  private _reviewItems: Map<string, AttendanceReviewItem> = new Map();
  private _eligibleRoster: Map<string, EligibleRosterStudent> = new Map();
  private _corrections: AttendanceIdentityCorrection[] = [];

  public get context(): AttendanceSessionContext | null {
    return this._context;
  }

  public get lifecycleStatus(): SessionLifecycleStatus {
    return this._lifecycleStatus;
  }

  public get reviewItems(): AttendanceReviewItem[] {
    return Array.from(this._reviewItems.values());
  }

  public get corrections(): AttendanceIdentityCorrection[] {
    return [...this._corrections];
  }

  /**
   * Initializes the review session by reconciling accumulated recognition candidates
   * against the authorized date-bounded roster for the session.
   */
  public initialize(
    context: AttendanceSessionContext,
    roster: EligibleRosterStudent[],
    accumulatedCandidates: AccumulatedRecognitionCandidate[] = []
  ): void {
    if (!context.clientSessionUuid || !context.teachingAssignmentId) {
      throw new Error('Invalid session context: clientSessionUuid and teachingAssignmentId are required');
    }
    if (!context.sessionDate) {
      throw new Error('Invalid session context: sessionDate is strictly required');
    }
    if (!context.conductingFacultyUserId) {
      throw new Error('Invalid session context: conductingFacultyUserId is strictly required');
    }

    this._context = { ...context };
    this._reviewItems.clear();
    this._eligibleRoster.clear();
    this._corrections = [];

    // 1. Date-bounded eligibility filtering:
    // Only students enrolled on sessionDate are permitted in the session roster.
    const sessionDate = context.sessionDate;
    for (const student of roster) {
      const isStarted = student.effectiveStartDate <= sessionDate;
      const isNotEnded = !student.effectiveEndDate || student.effectiveEndDate >= sessionDate;
      if (isStarted && isNotEnded) {
        this._eligibleRoster.set(student.studentUserId, { ...student });
      }
    }

    // Index confirmed recognition candidates by studentUserId
    const candidateMap = new Map<string, AccumulatedRecognitionCandidate>();
    for (const candidate of accumulatedCandidates) {
      // Step G guarantees deduplicated studentUserId, but defensively take highest confidence
      if (candidate.studentUserId) {
        const existing = candidateMap.get(candidate.studentUserId);
        if (!existing || candidate.bestSimilarityScore > existing.bestSimilarityScore) {
          candidateMap.set(candidate.studentUserId, candidate);
        }
      }
    }

    const now = Date.now();

    // 2. Reconcile eligible roster against candidates
    for (const [studentId, student] of this._eligibleRoster.entries()) {
      const candidate = candidateMap.get(studentId);

      if (candidate) {
        // Recognized candidate -> suggest PRESENT with AI_VERIFIED source
        this._reviewItems.set(studentId, {
          studentUserId: studentId,
          institutionalId: student.institutionalId,
          studentName: student.studentName,
          faceRegistrationState: student.faceRegistrationState,
          attendanceStatus: 'PRESENT',
          markSource: 'AI_VERIFIED',
          candidateConfidence: candidate.bestSimilarityScore,
          recognizedAtMs: candidate.lastSeenAtMs,
          isRecognized: true,
          isAmbiguous: false,
          isManuallyAdded: false,
          isCorrected: false,
          recordedAtMs: now,
        });
      } else {
        // Unobserved student -> needs manual check; NEVER silently mark ABSENT
        this._reviewItems.set(studentId, {
          studentUserId: studentId,
          institutionalId: student.institutionalId,
          studentName: student.studentName,
          faceRegistrationState: student.faceRegistrationState,
          attendanceStatus: 'UNDECIDED',
          markSource: null,
          candidateConfidence: null,
          recognizedAtMs: null,
          isRecognized: false,
          isAmbiguous: false,
          isManuallyAdded: false,
          isCorrected: false,
          recordedAtMs: now,
        });
      }
    }

    this._lifecycleStatus = 'REVIEW';
  }

  /**
   * Faculty marks attendance status explicitly for a roster student.
   */
  public markStatus(
    studentUserId: string,
    status: 'PRESENT' | 'ABSENT' | 'EXCUSED'
  ): void {
    this.assertEditable();
    const item = this._reviewItems.get(studentUserId);
    if (!item) {
      throw new Error(`Student ${studentUserId} is not in the active session roster`);
    }

    let markSource: AttendanceReviewSource = 'MANUAL_MARK';
    if (item.isRecognized) {
      markSource = status === 'PRESENT' ? 'AI_VERIFIED' : 'MANUAL_OVERRIDE';
    } else if (item.isCorrected) {
      markSource = 'MANUAL_OVERRIDE';
    }

    item.attendanceStatus = status;
    item.markSource = markSource;
    item.recordedAtMs = Date.now();
  }

  /**
   * Faculty corrects an incorrect recognized identity to another student in the roster.
   */
  public correctIdentity(
    fromStudentUserId: string,
    toStudentUserId: string,
    reason: string
  ): void {
    this.assertEditable();
    if (!reason || reason.trim().length === 0) {
      throw new Error('An explicit audit justification reason is required for identity correction');
    }
    if (fromStudentUserId === toStudentUserId) {
      throw new Error('Source and target student IDs cannot be identical for correction');
    }

    const fromItem = this._reviewItems.get(fromStudentUserId);
    if (!fromItem) {
      throw new Error(`Source student ${fromStudentUserId} does not exist in the active session`);
    }
    if (!fromItem.isRecognized) {
      throw new Error(`Source student ${fromStudentUserId} was not recognized and cannot be identity-corrected`);
    }

    const toItem = this._reviewItems.get(toStudentUserId);
    if (!toItem) {
      throw new Error(`Target student ${toStudentUserId} is not in the eligible session roster`);
    }

    // Invariant: Target student must not already be in the active decision set as PRESENT
    if (toItem.attendanceStatus === 'PRESENT') {
      throw new Error(
        `Target student ${toStudentUserId} (${toItem.studentName}) is already marked PRESENT. Correction would create a duplicate.`
      );
    }

    const now = Date.now();

    // Transfer recognized metadata to target student
    toItem.attendanceStatus = 'PRESENT';
    toItem.markSource = 'MANUAL_OVERRIDE';
    toItem.isRecognized = true;
    toItem.isCorrected = true;
    toItem.originalStudentUserId = fromStudentUserId;
    toItem.correctionReason = reason;
    toItem.candidateConfidence = fromItem.candidateConfidence;
    toItem.recognizedAtMs = fromItem.recognizedAtMs;
    toItem.recordedAtMs = now;

    // Reset source student to unobserved
    fromItem.attendanceStatus = 'UNDECIDED';
    fromItem.markSource = null;
    fromItem.isRecognized = false;
    fromItem.isCorrected = false;
    fromItem.candidateConfidence = null;
    fromItem.recognizedAtMs = null;
    fromItem.recordedAtMs = now;

    // Record audit entry
    this._corrections.push({
      fromStudentUserId,
      toStudentUserId,
      reason,
      correctedAtMs: now,
      correctedByUserId: this._context!.conductingFacultyUserId,
    });
  }

  /**
   * Faculty removes a recognition candidate from the decision set.
   */
  public removeCandidate(studentUserId: string): void {
    this.assertEditable();
    const item = this._reviewItems.get(studentUserId);
    if (!item) {
      throw new Error(`Student ${studentUserId} is not in the active session roster`);
    }

    item.isRecognized = false;
    item.attendanceStatus = 'UNDECIDED';
    item.markSource = null;
    item.candidateConfidence = null;
    item.recognizedAtMs = null;
    item.isCorrected = false;
    item.recordedAtMs = Date.now();
  }

  /**
   * Faculty manually adds a student who was not recognized by camera.
   */
  public manualAddStudent(
    studentUserId: string,
    initialStatus: 'PRESENT' | 'ABSENT' | 'EXCUSED' = 'PRESENT'
  ): void {
    this.assertEditable();
    const item = this._reviewItems.get(studentUserId);
    if (!item) {
      throw new Error(`Student ${studentUserId} is not an enrolled roster student for this session`);
    }

    item.attendanceStatus = initialStatus;
    item.markSource = 'MANUAL_MARK';
    item.isManuallyAdded = true;
    item.recordedAtMs = Date.now();
  }

  /**
   * Convenience action: Marks all remaining UNDECIDED roster students as ABSENT.
   * This is an explicit faculty action, never an automated default.
   */
  public markRemainingUnreviewedAsAbsent(): void {
    this.assertEditable();
    const now = Date.now();
    for (const item of this._reviewItems.values()) {
      if (item.attendanceStatus === 'UNDECIDED') {
        item.attendanceStatus = 'ABSENT';
        item.markSource = 'MANUAL_MARK';
        item.recordedAtMs = now;
      }
    }
  }

  /**
   * Validates whether the session is in a valid, complete state ready for finalization.
   */
  public validateFinalization(): { canFinalize: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!this._context) {
      errors.push('Session context has not been initialized');
      return { canFinalize: false, errors };
    }

    if (this._lifecycleStatus === 'FINALIZED' || this._lifecycleStatus === 'SYNCED') {
      errors.push('Session is already finalized and cannot be finalized again');
      return { canFinalize: false, errors };
    }

    // 1. Authorization check
    const isRegular = this._context.conductingFacultyUserId === this._context.regularFacultyUserId;
    const hasDelegation = !!this._context.substituteDelegationId;
    if (!isRegular && !hasDelegation) {
      errors.push('Conducting faculty is not assigned regular faculty and has no active substitute delegation');
    }

    // 2. Duplicate validation
    const seenStudentIds = new Set<string>();
    for (const item of this._reviewItems.values()) {
      if (seenStudentIds.has(item.studentUserId)) {
        errors.push(`Duplicate attendance record detected for student ${item.studentUserId}`);
      }
      seenStudentIds.add(item.studentUserId);
    }

    // 3. Completeness check
    if (this._context.applicabilityStatus === 'COUNTED') {
      const undecided = this.reviewItems.filter((i) => i.attendanceStatus === 'UNDECIDED');
      if (undecided.length > 0) {
        errors.push(
          `Cannot finalize session: ${undecided.length} student(s) remain undecided (must be marked PRESENT, ABSENT, or EXCUSED)`
        );
      }
    }

    // 4. Roster membership check
    for (const item of this._reviewItems.values()) {
      if (!this._eligibleRoster.has(item.studentUserId)) {
        errors.push(`Student ${item.studentUserId} is not in the eligible roster for session date ${this._context.sessionDate}`);
      }
    }

    return {
      canFinalize: errors.length === 0,
      errors,
    };
  }

  /**
   * Assembles the atomic finalization payload.
   * Throws if validation fails.
   */
  public prepareFinalizationPayload(): AttendanceFinalizationPayload {
    const validation = this.validateFinalization();
    if (!validation.canFinalize) {
      throw new Error(`Finalization validation failed:\n- ${validation.errors.join('\n- ')}`);
    }

    const nowIso = new Date().toISOString();
    const records: AttendanceFinalizationRecord[] = [];

    for (const item of this._reviewItems.values()) {
      if (item.attendanceStatus === 'UNDECIDED') {
        // If session was CANCELLED or EXEMPT, undecided students default to EXCUSED
        if (this._context!.applicabilityStatus !== 'COUNTED') {
          records.push({
            studentUserId: item.studentUserId,
            attendanceStatus: 'EXCUSED',
            markSource: item.markSource || 'MANUAL_MARK',
            candidateConfidence: item.candidateConfidence,
            recordedAt: nowIso,
          });
        }
      } else {
        records.push({
          studentUserId: item.studentUserId,
          attendanceStatus: item.attendanceStatus,
          markSource: item.markSource || 'MANUAL_MARK',
          candidateConfidence: item.candidateConfidence,
          recordedAt: nowIso,
        });
      }
    }

    return {
      clientSessionUuid: this._context!.clientSessionUuid,
      teachingAssignmentId: this._context!.teachingAssignmentId,
      sessionDate: this._context!.sessionDate,
      periodSlotOrSequence: this._context!.periodSlotOrSequence,
      applicabilityStatus: this._context!.applicabilityStatus,
      statusReason: this._context!.statusReason ?? null,
      regularFacultyUserId: this._context!.regularFacultyUserId,
      conductingFacultyUserId: this._context!.conductingFacultyUserId,
      substituteDelegationId: this._context!.substituteDelegationId ?? null,
      finalizedAt: nowIso,
      records,
    };
  }

  /**
   * Marks the session finalized in memory and locks edits.
   */
  public markFinalized(): void {
    this._lifecycleStatus = 'FINALIZED';
  }

  private assertEditable(): void {
    if (this._lifecycleStatus === 'FINALIZED' || this._lifecycleStatus === 'SYNCED') {
      throw new Error('Session is already finalized. Direct modifications are prohibited.');
    }
  }
}
