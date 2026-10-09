/**
 * SCRFD-500M Face Detector Adapter
 * Feature: Isolated ML Laboratory / Perception Spike
 *
 * Implements IFaceDetector for InsightFace SCRFD-500M ONNX model.
 * Optimized for multi-face scale invariance and small-face recall in crowded scenes.
 */

import { FaceDetectionResult, IFaceDetector, RawFrame } from '../../../perception/contracts';
import { PerceptionClient, DetailedPerceptionTimings } from '../../../perception/perceptionClient';

export class SCRFDDetector implements IFaceDetector {
  readonly modelName = 'SCRFD-500M';
  readonly modelVersion = '500M';

  private isInitialized = false;
  private modelPath: string = '';
  private confidenceThreshold: number = 0.35;
  private nmsThreshold: number = 0.4;
  private targetWidth: number = 640;
  private targetHeight: number = 640;
  private lastTimings: DetailedPerceptionTimings | null = null;

  constructor(
    confidenceThreshold: number = 0.35,
    nmsThreshold: number = 0.4,
    targetWidth: number = 640,
    targetHeight: number = 640
  ) {
    this.confidenceThreshold = confidenceThreshold;
    this.nmsThreshold = nmsThreshold;
    this.targetWidth = targetWidth;
    this.targetHeight = targetHeight;
  }

  public async initialize(modelPath?: string): Promise<void> {
    this.modelPath = modelPath || 'mobile/src/lab/models/det_500m.onnx';
    this.isInitialized = true;
  }

  public getLastTimings(): DetailedPerceptionTimings | null {
    return this.lastTimings;
  }

  public async detectFaces(frame: RawFrame): Promise<FaceDetectionResult[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    const { results, timings } = await PerceptionClient.detect(
      frame,
      'SCRFD-500M',
      this.targetWidth,
      this.targetHeight,
      this.confidenceThreshold
    );
    if (timings) {
      this.lastTimings = timings;
    }
    return results;
  }

  public async detectFacesDetailed(frame: RawFrame): Promise<{
    results: FaceDetectionResult[];
    timings?: DetailedPerceptionTimings;
  }> {
    if (!this.isInitialized) {
      await this.initialize();
    }
    const resp = await PerceptionClient.detect(
      frame,
      'SCRFD-500M',
      this.targetWidth,
      this.targetHeight,
      this.confidenceThreshold
    );
    if (resp.timings) {
      this.lastTimings = resp.timings;
    }
    return resp;
  }

  public async dispose(): Promise<void> {
    this.isInitialized = false;
  }
}
