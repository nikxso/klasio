/**
 * Replaceable Perception Interfaces Contract
 * Feature: 001-academic-roles-enrollment
 *
 * Implements Constitution Principle IV ("Domain Architecture Stability & Replaceable Interfaces")
 * and Notion Section 24.6 ("Architecture should remain replaceable").
 *
 * Isolates Camera, Detection, Tracking, Recognition, and Matching behind stable contracts
 * so perception engines (YuNet, EdgeFace-XS, ONNX Runtime)
 * can be swapped or benchmarked without altering attendance domain logic.
 */

export interface Point2D {
  x: number;
  y: number;
}

export interface FaceBoundingBox {
  x: number; // Normalized [0, 1] or pixel coordinate
  y: number;
  width: number;
  height: number;
}

export interface FacialLandmarks {
  leftEye: Point2D;
  rightEye: Point2D;
  noseTip: Point2D;
  mouthLeft: Point2D;
  mouthRight: Point2D;
}

export interface RawFrame {
  width: number;
  height: number;
  format: 'yuv420' | 'rgba' | 'nv21' | 'jpeg';
  timestampMs: number;
  data: Uint8Array | ArrayBuffer | string;
  rotationDegrees: 0 | 90 | 180 | 270;
  uri?: string;
  frameId?: string;
  captureTimestampMs?: number;
}

export interface FaceDetectionResult {
  boundingBox: FaceBoundingBox;
  confidence: number;
  landmarks?: FacialLandmarks;
  latencyMs?: number;
  frameId?: string;
  captureTimestampMs?: number;
  resultTimestampMs?: number;
  embedding?: Float32Array;
  embeddingBase64?: string;
}

export type QualityState = 'UNKNOWN' | 'GOOD' | 'FAIR' | 'POOR';

export type QualityReason =
  | 'TOO_SMALL'
  | 'LOW_SHARPNESS'
  | 'EXCESSIVE_YAW'
  | 'EXCESSIVE_PITCH'
  | 'EXCESSIVE_ROLL'
  | 'FRAME_CLIPPED'
  | 'LOW_VISIBILITY'
  | 'GEOMETRY_UNSTABLE'
  | 'INSUFFICIENT_LANDMARKS';

export interface QualitySignalMetrics {
  // A. Face Size
  normalizedWidth: number;
  normalizedHeight: number;
  normalizedArea: number;
  estimatedPixelSizePx?: number;
  sizeState: QualityState;

  // B. Bounding-Box Geometry
  aspectRatio: number; // width / height
  aspectRatioState: QualityState;
  isGeometryStable: boolean;
  geometryState: QualityState;

  // C. Visibility & Clipping
  inFrameProportion: number; // [0, 1] proportion inside frame bounds
  isClipped: boolean;
  landmarksAvailable: boolean;
  landmarkSpread?: number;
  visibilityState: QualityState;

  // D. Sharpness / Blur
  sharpnessScore: number; // [0, 1] proxy metric
  sharpnessState: QualityState;

  // E. Head Pose / Orientation
  yawDegrees: number;
  pitchDegrees: number;
  rollDegrees: number;
  poseState: QualityState;
}

export interface QualityAssessment {
  state: QualityState;
  score: number; // [0.0, 1.0] composite quality score
  primaryReason?: QualityReason;
  metrics: QualitySignalMetrics;
  assessedAtMs: number;
}

export interface TrackedFace {
  trackId: number;
  boundingBox: FaceBoundingBox; // Measured / tracked bounding box [0, 1]
  displayBox?: FaceBoundingBox; // Display-stabilized bounding box [0, 1]
  landmarks?: FacialLandmarks;
  confidence: number;
  ageInFrames: number;
  timeSinceLastSeenMs: number;
  isConfirmed: boolean;
  quality?: QualityAssessment;
  embedding?: Float32Array;
  embeddingBase64?: string;
}

export interface QualityGateResult {
  isAcceptable: boolean;
  score: number; // [0.0, 1.0]
  rejectionReason?: 'TOO_SMALL' | 'BLURRY' | 'EXTREME_POSE' | 'POOR_LIGHTING' | 'OCCLUDED';
  faceSizePx: number;
  yawDegrees: number;
  pitchDegrees: number;
}

export interface AttendanceSessionScope {
  attendanceSessionId: string;
  academicTermId: string;
  courseOfferingId: string;
  subject: string;
  classId: string;
  section: string;
  sessionDate?: string;
}

export type MatchOutcomeState = 'MATCHED' | 'AMBIGUOUS' | 'UNMATCHED' | 'INVALID';

export interface ModelCompatibilityResult {
  isCompatible: boolean;
  diagnosticReason?: string;
  mismatchedField?: string;
}

export interface StudentReferenceProfile {
  studentUserId: string;
  institutionalId: string;
  studentName: string;
  modelName: string;
  activeModelVersion: string;
  embeddingDimension: number;
  normalization: string;
  alignmentMode: FaceAlignmentMode;
  embeddings: Float32Array[]; // Array of reference sample vectors (1..K per student)
}

/**
 * Replaceable Face Gallery Abstraction (Step F)
 * Isolates session-scoped authorized reference embeddings and validates model compatibility.
 */
export interface IFaceGallery {
  readonly sessionScope: AttendanceSessionScope | null;
  readonly galleryVersion: number;
  readonly size: number; // Total eligible students
  readonly totalEmbeddings: number; // Total reference sample vectors across all students

  initialize(sessionScope: AttendanceSessionScope, profiles: StudentReferenceProfile[], galleryVersion?: number): void;
  validateCompatibility(manifest: ModelManifest): ModelCompatibilityResult;
  getEligibleProfiles(): StudentReferenceProfile[];
  getProfile(studentUserId: string): StudentReferenceProfile | undefined;
  clear(): void;
}

export interface PermittedStudentGallery {
  teachingAssignmentId: string;
  academicTermId: string;
  modelVersion: string;
  galleryVersion: number;
  profiles: Map<string, StudentReferenceProfile>; // Key: studentUserId
}

/**
 * Aggregated Student Similarity Candidate (Step F)
 * Max similarity score across all reference embeddings for a single student identity.
 */
export interface StudentSimilarityScore {
  studentUserId: string;
  institutionalId: string;
  studentName: string;
  maxSimilarity: number;
  bestEmbeddingIndex: number;
}

export interface IdentityMatch {
  studentUserId: string | null;
  institutionalId: string | null;
  studentName: string | null;
  similarityScore: number; // Top-1 student max cosine similarity in [-1, 1]
  top2StudentUserId?: string | null; // Top-2 DIFFERENT student
  top2SimilarityScore?: number | null; // Top-2 different student score
  top2Margin: number | null; // Margin (Top-1 - Top-2); null if only 1 student in gallery
  matchState: MatchOutcomeState;
  isConfident: boolean;
  diagnosticReason?: string; // Reason when UNMATCHED or INVALID
}

/**
 * Recognition Candidate (Step F)
 * Identity-linked transient candidate generated after authorized session gallery matching.
 * STRICT INVARIANT: RecognitionCandidate is NOT an AttendanceRecord.
 */
export interface RecognitionCandidate {
  trackId: number;
  match: IdentityMatch;
  qualityScore: number;
  detectedAtMs: number;
  consecutiveConfirmations: number;
  isConfirmed: boolean;
}

/**
 * Fresh Recognition Observation Event (Step F)
 * Captured at the embedding/matching rate (not 30-FPS tracking rate).
 */
export interface RecognitionObservation {
  trackId: number;
  match: IdentityMatch;
  quality: QualityAssessment;
  observationTimestampMs: number;
}

/**
 * Accumulated Recognition Candidate (Step G)
 * Long-lived session accumulation entry deduplicated by studentUserId across progressive panning sweeps.
 * STRICT INVARIANT: AccumulatedRecognitionCandidate is NOT an AttendanceRecord.
 */
export interface AccumulatedRecognitionCandidate {
  studentUserId: string;
  institutionalId: string;
  studentName: string;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
  bestSimilarityScore: number;
  bestQualityScore: number;
  bestMargin: number | null;
  totalObservations: number;
  lastTrackId: number;
  isConfirmed: boolean;
}

export type ScannerStabilityState = 'STABLE' | 'PANNING' | 'PAUSED';

export interface ScannerMotionMetrics {
  state: ScannerStabilityState;
  meanDisplacement: number;
  trackChurnRate: number;
  stableDurationMs: number;
  isAdmissionPermitted: boolean;
}

export interface ScannerMotionConfig {
  displacementPanningThreshold?: number; // default ~0.08 normalized displacement
  churnPanningThreshold?: number; // default ~0.40 track churn
  stabilizationRequiredMs?: number; // default ~300 ms required stable duration before admission
}

export interface AccumulatorConfig {
  scannerMotionConfig?: ScannerMotionConfig;
  minConfirmationsForSessionAdmission?: number; // default 2
}

export interface AccumulatorStats {
  totalAccumulated: number;
  totalMatchesProcessed: number;
  totalDuplicatesMerged: number;
  totalRejections: number;
  activeTrackCount: number;
  scannerState: ScannerStabilityState;
}

/**
 * Replaceable Progressive Recognition Accumulator (Step G)
 * Accumulates recognized student candidates across panning sweeps, deduplicates by studentUserId,
 * manages scanner motion stability gating, and preserves multi-track independence.
 */
export interface IProgressiveRecognitionAccumulator {
  /**
   * Processes a batch of recognition candidates and tracked faces from the current frame.
   */
  processFrameCandidates(
    candidates: RecognitionCandidate[],
    trackedFaces: TrackedFace[],
    timestampMs: number
  ): void;

  /**
   * Returns all accumulated candidates in the session, deduplicated by studentUserId.
   */
  getAccumulatedCandidates(): AccumulatedRecognitionCandidate[];

  /**
   * Retrieves a single accumulated candidate by studentUserId.
   */
  getCandidate(studentUserId: string): AccumulatedRecognitionCandidate | undefined;

  /**
   * Returns current scanner motion metrics.
   */
  getScannerMetrics(): ScannerMotionMetrics;

  /**
   * Returns current operational statistics.
   */
  getStats(): AccumulatorStats;

  /**
   * Resets all accumulated session state.
   */
  reset(): void;
}

// -------------------------------------------------------------------------
// Step H — Guided Face Enrollment Contracts
// -------------------------------------------------------------------------

export type EnrollmentGuidanceState =
  | 'NO_FACE'
  | 'MULTIPLE_FACES'
  | 'MOVE_CLOSER'
  | 'MOVE_AWAY'
  | 'CENTER_FACE'
  | 'LOOK_AT_CAMERA'
  | 'TURN_SLIGHTLY'
  | 'IMPROVE_LIGHTING'
  | 'HOLD_STILL'
  | 'CAPTURING'
  | 'SAMPLE_ACCEPTED'
  | 'COMPLETED'
  | 'VALIDATION_FAILED';

export type EnrollmentSampleStep =
  | 'FRONTAL'
  | 'SLIGHT_LEFT'
  | 'SLIGHT_RIGHT'
  | 'SMILE_OR_EXPRESSION'
  | 'SLIGHT_ANGLE';

export interface EnrollmentSampleResult {
  step: EnrollmentSampleStep;
  embedding: Float32Array;
  quality: QualityAssessment;
  capturedAtMs: number;
}

export interface StudentEnrollmentContext {
  studentUserId: string;
  institutionalId: string;
  studentName: string;
  academicTermId?: string;
}

export interface EnrollmentSessionState {
  studentContext: StudentEnrollmentContext;
  currentStep: EnrollmentSampleStep;
  guidance: EnrollmentGuidanceState;
  guidanceMessage: string;
  samplesCaptured: EnrollmentSampleResult[];
  targetSamples: number;
  isStabilizing: boolean;
  stableDurationMs: number;
  isCompleted: boolean;
  failureReason?: string;
}

export interface EnrollmentValidationResult {
  isValid: boolean;
  diagnosticReason?: string;
  profile?: StudentReferenceProfile;
}

export interface IGuidedFaceEnrollmentController {
  readonly state: EnrollmentSessionState | null;
  startSession(context: StudentEnrollmentContext): void;
  processFrame(
    frame: RawFrame,
    detections: FaceDetectionResult[],
    timestampMs: number
  ): Promise<EnrollmentGuidanceState>;
  getCompletedProfile(): StudentReferenceProfile | null;
  resetSession(): void;
}

// -------------------------------------------------------------------------
// Component Contracts
// -------------------------------------------------------------------------

/**
 * Camera Frame Source Interface: Abstraction over camera acquisition.
 * Can be implemented by React Native VisionCamera, native CameraX, or test synthetic stream.
 */
export interface ICameraFrameSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  onFrame(callback: (frame: RawFrame) => void): void;
  pause(): void;
  resume(): void;
}

/**
 * Face Detector Interface: Replaceable face detection engine.
 * Implementations: YuNet, DirectOnDeviceDetector.
 */
export interface IFaceDetector {
  readonly modelName: string;
  readonly modelVersion: string;

  initialize(modelPath?: string): Promise<void>;
  detectFaces(frame: RawFrame): Promise<FaceDetectionResult[]>;
  dispose(): Promise<void>;
}

/**
 * Face Tracker Interface: Associates face detections across frames.
 * Candidate implementations: Centroid/IoU Tracker, ByteTrack, OC-SORT.
 */
export interface IFaceTracker {
  readonly trackerName: string;

  /**
   * Updates tracking states with new detections from the current frame.
   */
  update(detections: FaceDetectionResult[], timestampMs: number): TrackedFace[];
  reset(): void;
}

/**
 * Face Quality & Visibility Gate Configuration (Step D)
 * All thresholds are empirical candidates calibrated through physical evaluation.
 */
export interface QualityGateConfig {
  // A. Face Size (normalized [0, 1] relative to analysis frame)
  minNormalizedWidth: number; // Threshold below which size is POOR (default ~0.05)
  minNormalizedHeight: number; // Threshold below which size is POOR (default ~0.06)
  fairNormalizedWidth: number; // Threshold below which size is FAIR (default ~0.08)
  fairNormalizedHeight: number; // Threshold below which size is FAIR (default ~0.10)

  // B. Bounding-Box Geometry & Aspect Ratio (width / height)
  minAspectRatio: number; // Lower bound (narrow/sliver box rejection, default ~0.50)
  maxAspectRatio: number; // Upper bound (wide/pancake box rejection, default ~1.20)
  fairMinAspectRatio: number; // FAIR lower bound (default ~0.60)
  fairMaxAspectRatio: number; // FAIR upper bound (default ~1.05)
  maxScaleJumpRatio: number; // Max allowable scale change across adjacent updates (default ~0.50)

  // C. Visibility & Frame Boundary Containment
  minInFrameProportion: number; // Proportion of box strictly inside [0, 1] frame (default ~0.80)
  fairInFrameProportion: number; // FAIR in-frame proportion (default ~0.95)

  // D. Image Sharpness / Blur Proxy
  minSharpness: number; // Threshold below which observation is POOR (default ~0.20)
  fairSharpness: number; // Threshold below which observation is FAIR (default ~0.35)

  // E. Head Pose / Orientation (degrees from landmark geometry)
  maxYawDegrees: number; // POOR yaw limit (default ~28.0°)
  fairYawDegrees: number; // FAIR yaw limit (default ~16.0°)
  maxPitchDegrees: number; // POOR pitch limit (default ~22.0°)
  fairPitchDegrees: number; // FAIR pitch limit (default ~14.0°)
  maxRollDegrees: number; // POOR roll/tilt limit (default ~20.0°)
  fairRollDegrees: number; // FAIR roll/tilt limit (default ~12.0°)
}

/**
 * Face Quality & Visibility Gate Interface (Step D)
 * Evaluates tracked face observations to determine downstream recognition suitability.
 */
export interface IFaceQualityGate {
  readonly gateName: string;

  /**
   * Evaluates face geometry, visibility, blur, and pose signals.
   * Returns a complete QualityAssessment.
   */
  evaluate(
    box: FaceBoundingBox,
    landmarks?: FacialLandmarks,
    confidence?: number,
    previousBox?: FaceBoundingBox,
    framePixels?: Uint8Array,
    frameWidth?: number,
    frameHeight?: number
  ): QualityAssessment;
}

/**
 * Face Crop Input for Embedding Generation (Step E)
 * STRICT REQUIREMENT: box MUST be measured/tracked geometry, NEVER display box!
 */
export interface FaceCropInput {
  frame: RawFrame;
  box: FaceBoundingBox; // Measured / tracked bounding box [0, 1]
  landmarks?: FacialLandmarks;
  embedding?: Float32Array;
  embeddingBase64?: string;
  cameraTag?: number | null;
}

export type FaceAlignmentMode = 'NONE' | 'SIMILARITY_TRANSFORM_5PT';

/**
 * Model Manifest & Compatibility Configuration (Step E)
 * Formalizes: Model V1 + Preprocessing V1 + Alignment V1 = Embedding Format V1
 */
export interface ModelManifest {
  modelName: string;
  modelVersion: string;
  format: 'ONNX' | 'TFLite';
  fileChecksumSha256?: string;
  fileSizeBytes: number;
  inputWidth: number;
  inputHeight: number;
  inputChannels: number;
  inputColorOrder: 'RGB' | 'BGR';
  normalization: 'MINUS_127_5_DIV_127_5' | 'MINUS_127_5_DIV_128_0' | 'IMAGENET';
  embeddingDimension: number;
  alignmentMode: FaceAlignmentMode;
  manifestVersion: string; // e.g. "v1"
}

export interface FaceEmbeddingTimings {
  cropAndAlignmentMs: number;
  preprocessingMs: number;
  inferenceMs: number;
  normalizationMs: number;
  totalMs: number;
}

/**
 * Transient Face Embedding Result (Step E)
 * strictly ephemeral; contains biometric vector and performance metadata.
 */
export interface FaceEmbeddingResult {
  embedding: Float32Array; // 512-dimensional unit-normalized L2 vector
  rawDimension: number;
  isNormalized: boolean;
  manifest: ModelManifest;
  timings: FaceEmbeddingTimings;
}

/**
 * Face Embedder Interface: Extracts identity embeddings from quality-approved face observations (Step E).
 * Modular abstraction isolating model implementations (EdgeFace-XS).
 */
export interface IFaceEmbedder {
  readonly modelName: string;
  readonly manifest: ModelManifest;
  readonly embeddingDimension: number;

  initialize(modelPath?: string): Promise<void>;
  /**
   * Extracts crop, performs optional 5-point alignment, preprocesses,
   * runs inference, and returns unit-normalized L2 embedding.
   */
  embed(input: FaceCropInput, align?: boolean): Promise<FaceEmbeddingResult>;
  dispose(): Promise<void>;
}

/**
 * Face Recognizer Interface: Extracts identity embeddings from aligned crops.
 * Implementations: EdgeFace-XS.
 */
export interface IFaceRecognizer {
  readonly modelName: string;
  readonly modelVersion: string;
  readonly embeddingDimension: number; // e.g. 128 or 512

  initialize(modelPath?: string): Promise<void>;
  /**
   * Generates a unit-normalized Float32Array embedding vector from an aligned face image.
   */
  computeEmbedding(alignedFaceCrop: RawFrame): Promise<Float32Array>;
  dispose(): Promise<void>;
}

/**
 * Face Matcher Interface: Performs vector similarity search against active class gallery.
 */
export interface IFaceMatcher {
  /**
   * Matches candidate embedding against the permitted session gallery.
   * Uses cosine similarity, per-student aggregation, and Top-1 vs Top-2 different-student margin verification.
   */
  findMatch(
    candidateEmbedding: Float32Array,
    gallery: IFaceGallery | PermittedStudentGallery,
    similarityThreshold?: number,
    marginThreshold?: number
  ): IdentityMatch;
}

/**
 * Recognition Pipeline Orchestrator: High-level boundary coordinating perception
 * and delivering stream of verified RecognitionCandidate objects to the attendance UI.
 */
export interface IRecognitionPipeline {
  initialize(detector: IFaceDetector, recognizer: IFaceRecognizer, tracker: IFaceTracker, matcher: IFaceMatcher): Promise<void>;
  setPermittedGallery(gallery: IFaceGallery | PermittedStudentGallery): void;
  processFrame(frame: RawFrame): Promise<RecognitionCandidate[]>;
  resetSession(): void;
  dispose(): Promise<void>;
}

// -------------------------------------------------------------------------
// STEP I: Faculty Attendance Review & Finalization Contracts
// -------------------------------------------------------------------------

export type AttendanceReviewSource = 'AI_VERIFIED' | 'MANUAL_MARK' | 'MANUAL_OVERRIDE';
export type AttendanceReviewStatus = 'PRESENT' | 'ABSENT' | 'EXCUSED' | 'UNDECIDED';
export type SessionApplicabilityStatus = 'COUNTED' | 'CANCELLED' | 'EXEMPT';
export type ClassroomSessionLifecycleState =
  | 'SCHEDULED'
  | 'READY'
  | 'SCANNING'
  | 'REVIEW'
  | 'FINALIZED'
  | 'SYNCING'
  | 'SYNCHRONIZED'
  | 'CANCELLED'
  | 'EXEMPT';

export type ScannerInteractionState = 'ACTIVE' | 'PAUSED';

export type SessionLifecycleStatus =
  | 'DRAFT'
  | 'SCHEDULED'
  | 'READY'
  | 'SCANNING'
  | 'REVIEW'
  | 'FINALIZING'
  | 'FINALIZED'
  | 'SYNCING'
  | 'SYNCED'
  | 'SYNCHRONIZED'
  | 'CANCELLED'
  | 'EXEMPT';

export interface AttendanceSessionContext {
  clientSessionUuid: string;
  teachingAssignmentId: string;
  sessionDate: string; // YYYY-MM-DD
  periodSlotOrSequence: number;
  applicabilityStatus: SessionApplicabilityStatus;
  statusReason?: string | null;
  regularFacultyUserId: string;
  conductingFacultyUserId: string;
  substituteDelegationId?: string | null;
  subjectName?: string;
  sectionName?: string;
  roomName?: string;
}

export interface AttendanceReviewItem {
  studentUserId: string;
  institutionalId: string;
  studentName: string;
  faceRegistrationState: 'UNREGISTERED' | 'PENDING' | 'REGISTERED';
  attendanceStatus: AttendanceReviewStatus;
  markSource: AttendanceReviewSource | null;
  candidateConfidence: number | null;
  recognizedAtMs: number | null;
  isRecognized: boolean;
  isAmbiguous: boolean;
  isManuallyAdded: boolean;
  isCorrected: boolean;
  originalStudentUserId?: string;
  correctionReason?: string;
  recordedAtMs: number;
}

export interface AttendanceIdentityCorrection {
  fromStudentUserId: string;
  toStudentUserId: string;
  reason: string;
  correctedAtMs: number;
  correctedByUserId: string;
}

export interface AttendanceFinalizationRecord {
  studentUserId: string;
  attendanceStatus: 'PRESENT' | 'ABSENT' | 'EXCUSED';
  markSource: 'AI_VERIFIED' | 'MANUAL_MARK' | 'MANUAL_OVERRIDE';
  candidateConfidence: number | null;
  recordedAt: string; // ISO-8601
}

export interface AttendanceFinalizationPayload {
  clientSessionUuid: string;
  teachingAssignmentId: string;
  sessionDate: string;
  periodSlotOrSequence: number;
  applicabilityStatus: SessionApplicabilityStatus;
  statusReason?: string | null;
  regularFacultyUserId: string;
  conductingFacultyUserId: string;
  substituteDelegationId?: string | null;
  finalizedAt: string;
  records: AttendanceFinalizationRecord[];
}

export interface AttendanceFinalizationResult {
  success: boolean;
  clientSessionUuid: string;
  recordsCount: number;
  finalizedAt: string;
  diagnosticReason?: string;
}

export interface IFacultyAttendanceReviewController {
  readonly context: AttendanceSessionContext | null;
  readonly lifecycleStatus: SessionLifecycleStatus;
  readonly reviewItems: AttendanceReviewItem[];
  
  initialize(
    context: AttendanceSessionContext,
    roster: Array<{
      studentUserId: string;
      institutionalId: string;
      studentName: string;
      effectiveStartDate: string;
      effectiveEndDate?: string | null;
      faceRegistrationState: 'UNREGISTERED' | 'PENDING' | 'REGISTERED';
    }>,
    accumulatedCandidates?: AccumulatedRecognitionCandidate[]
  ): void;

  markStatus(studentUserId: string, status: 'PRESENT' | 'ABSENT' | 'EXCUSED'): void;
  correctIdentity(fromStudentUserId: string, toStudentUserId: string, reason: string): void;
  removeCandidate(studentUserId: string): void;
  manualAddStudent(studentUserId: string, initialStatus?: 'PRESENT' | 'ABSENT' | 'EXCUSED'): void;
  markRemainingUnreviewedAsAbsent(): void;
  
  validateFinalization(): { canFinalize: boolean; errors: string[] };
  prepareFinalizationPayload(): AttendanceFinalizationPayload;
}

export type AmendmentRole = 'REGULAR_FACULTY' | 'ADMIN';

export interface AttendanceAmendmentRecord {
  auditId: string;
  sessionId: string;
  studentUserId: string;
  previousStatus: 'PRESENT' | 'ABSENT' | 'EXCUSED';
  newStatus: 'PRESENT' | 'ABSENT' | 'EXCUSED';
  amendingUserId: string;
  amendmentRole: AmendmentRole;
  amendmentReason: string;
  amendedAt: string; // ISO-8601
}

export interface SubmitAmendmentPayload {
  studentUserId: string;
  newStatus: 'PRESENT' | 'ABSENT' | 'EXCUSED';
  amendmentReason: string;
}

