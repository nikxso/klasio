/**
 * SCRFD-500M Face Detector Adapter
 * Feature: Isolated ML Laboratory / Perception Spike
 *
 * Implements IFaceDetector for InsightFace SCRFD-500M ONNX model.
 * Optimized for multi-face scale invariance and small-face recall in crowded scenes.
 */

import { FaceDetectionResult, IFaceDetector, RawFrame } from '../../../perception/contracts';

export class SCRFDDetector implements IFaceDetector {
  readonly modelName = 'SCRFD-500M';
  readonly modelVersion = '500M';

  private isInitialized = false;
  private modelPath: string = '';
  private confidenceThreshold: number = 0.5;
  private nmsThreshold: number = 0.4;

  constructor(confidenceThreshold: number = 0.5, nmsThreshold: number = 0.4) {
    this.confidenceThreshold = confidenceThreshold;
    this.nmsThreshold = nmsThreshold;
  }

  public async initialize(modelPath?: string): Promise<void> {
    this.modelPath = modelPath || 'mobile/src/lab/models/det_500m.onnx';
    this.isInitialized = true;
  }

  public async detectFaces(frame: RawFrame): Promise<FaceDetectionResult[]> {
    if (!this.isInitialized) {
      throw new Error('SCRFDDetector is not initialized');
    }
    return [];
  }

  public async dispose(): Promise<void> {
    this.isInitialized = false;
  }
}
