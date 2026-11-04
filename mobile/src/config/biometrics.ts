/**
 * Authoritative Biometric Perception & Recognition Configuration
 * Production Model: EdgeFace-XS 512-D ONNX
 */

export const BIOMETRIC_CONFIG = {
  // Model Specification
  MODEL_NAME: 'EdgeFace-XS',
  MODEL_VERSION: 'gamma_0.6',
  ACTIVE_MODEL_VERSION_KEY: 'EdgeFace-XS-v1',
  EMBEDDING_DIMENSION: 512,
  EMBEDDING_DTYPE: 'float32' as const,
  EMBEDDING_NORMALIZATION: 'L2' as const,
  INPUT_NORMALIZATION: 'MINUS_127_5_DIV_127_5' as const,
  INPUT_WIDTH: 112,
  INPUT_HEIGHT: 112,
  INPUT_CHANNELS: 3,
  INPUT_COLOR_ORDER: 'RGB' as const,
  ALIGNMENT_MODE: 'SIMILARITY_TRANSFORM_5PT' as const,

  // Matching Thresholds (Evidence-backed from EdgeFace ArcFace angular margin benchmarks)
  COSINE_SIMILARITY_THRESHOLD: 0.65,
  TOP2_MARGIN_THRESHOLD: 0.10,

  // Enrollment Quality and Multi-Sample Gates
  TARGET_SAMPLES: 3,
  MIN_PAIRWISE_CONSISTENCY: 0.60,
  STABILIZATION_REQUIRED_MS: 400,
  MIN_QUALITY_SCORE: 0.70,

  // Detector Thresholds (YuNet on-device in-memory)
  DETECTOR_CONFIDENCE_THRESHOLD: 0.35,
} as const;
