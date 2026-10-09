/**
 * Replaceable Perception Interfaces Contract
 * Feature: 001-academic-roles-enrollment
 *
 * Implements Constitution Principle IV ("Domain Architecture Stability & Replaceable Interfaces")
 * and Notion Section 24.6 ("Architecture should remain replaceable").
 *
 * Isolates Camera, Detection, Tracking, Recognition, and Matching behind stable contracts
 * so Level 3 candidates (YuNet vs. SCRFD, MobileFaceNet vs. EdgeFace-XS, ONNX Runtime vs. LiteRT)
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
}

export interface TrackedFace {
  trackId: number;
  boundingBox: FaceBoundingBox;
  landmarks?: FacialLandmarks;
  confidence: number;
  ageInFrames: number;
  timeSinceLastSeenMs: number;
  isConfirmed: boolean;
}

export interface QualityGateResult {
  isAcceptable: boolean;
  score: number; // [0.0, 1.0]
  rejectionReason?: 'TOO_SMALL' | 'BLURRY' | 'EXTREME_POSE' | 'POOR_LIGHTING' | 'OCCLUDED';
  faceSizePx: number;
  yawDegrees: number;
  pitchDegrees: number;
}

export interface StudentReferenceProfile {
  studentUserId: string;
  institutionalId: string;
  studentName: string;
  activeModelVersion: string;
  embeddingDimension: number;
  embeddings: Float32Array[]; // Array of reference sample vectors
}

export interface PermittedStudentGallery {
  teachingAssignmentId: string;
  academicTermId: string;
  modelVersion: string;
  galleryVersion: number;
  profiles: Map<string, StudentReferenceProfile>; // Key: studentUserId
}

export interface IdentityMatch {
  studentUserId: string;
  institutionalId: string;
  studentName: string;
  similarityScore: number; // Cosine similarity in [-1, 1]
  top2Margin: number; // Margin between top-1 and top-2 candidate
  isConfident: boolean;
}

export interface RecognitionCandidate {
  trackId: number;
  match: IdentityMatch;
  qualityScore: number;
  detectedAtMs: number;
  consecutiveConfirmations: number;
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
 * Candidate implementations: YuNet, SCRFD-500M, ML Kit Face Detector.
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
 * Face Recognizer Interface: Extracts identity embeddings from aligned crops.
 * Candidate implementations: MobileFaceNet, EdgeFace-XS, FaceLiVT.
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
   * Matches candidate embedding against the permitted class section gallery.
   * Uses cosine similarity and top-1 vs top-2 margin verification.
   */
  findMatch(
    candidateEmbedding: Float32Array,
    gallery: PermittedStudentGallery,
    similarityThreshold: number,
    marginThreshold: number
  ): IdentityMatch | null;
}

/**
 * Recognition Pipeline Orchestrator: High-level boundary coordinating perception
 * and delivering stream of verified RecognitionCandidate objects to the attendance UI.
 */
export interface IRecognitionPipeline {
  initialize(detector: IFaceDetector, recognizer: IFaceRecognizer, tracker: IFaceTracker, matcher: IFaceMatcher): Promise<void>;
  setPermittedGallery(gallery: PermittedStudentGallery): void;
  processFrame(frame: RawFrame): Promise<RecognitionCandidate[]>;
  resetSession(): void;
  dispose(): Promise<void>;
}
