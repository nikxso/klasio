/**
 * Isolated ML Laboratory & Perception Spike Index
 * Feature: 001-academic-roles-enrollment / ML Laboratory Spike
 *
 * Exports all swappable perception adapters, pipeline components,
 * quality gates, registration spike, and realistic synthetic test datasets.
 */

export * from './adapters/quality/HeuristicQualityGate';
export * from './adapters/quality/FaceQualityGate';
export * from './adapters/gallery/SessionScopedGallery';
export * from './adapters/matchers/CosineGalleryMatcher';
export * from './adapters/matchers/TemporalConfirmationBuffer';
export * from './adapters/trackers/CentroidIoUTracker';
export * from './adapters/trackers/TemporalCentroidTracker';
export * from './adapters/detectors/YuNetDetector';
export * from './adapters/detectors/SCRFDDetector';
export * from './adapters/detectors/DirectOnDeviceDetector';
export * from './adapters/recognizers/MobileFaceNetRecognizer';
export * from './adapters/recognizers/EdgeFaceXSRecognizer';
export * from './adapters/recognizers/MobileFaceNetEmbedder';
export * from './adapters/recognizers/EdgeFaceEmbedder';
export * from './adapters/aligners/FaceAligner';
export * from './adapters/accumulator/ProgressiveRecognitionAccumulator';
export * from './pipeline/ClassroomRecognitionPipeline';
export * from './datasets/ClassroomSyntheticDataset';
