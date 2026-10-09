/**
 * YuNet Face Detector Adapter
 * Feature: Isolated ML Laboratory / Perception Spike
 *
 * Implements IFaceDetector for OpenCV YuNet (2023mar ONNX model).
 * Designed for millisecond edge detection with 5-point landmark localization.
 */

import { FaceDetectionResult, IFaceDetector, RawFrame } from '../../../perception/contracts';
import { PerceptionClient, DetailedPerceptionTimings } from '../../../perception/perceptionClient';

export class YuNetDetector implements IFaceDetector {
  readonly modelName = 'YuNet';
  readonly modelVersion = '2023mar';

  private isInitialized = false;
  private modelPath: string = '';
  private confidenceThreshold: number = 0.4;
  private nmsThreshold: number = 0.3;
  private targetWidth: number = 640;
  private targetHeight: number = 640;
  private lastTimings: DetailedPerceptionTimings | null = null;

  constructor(
    confidenceThreshold: number = 0.4,
    nmsThreshold: number = 0.3,
    targetWidth: number = 640,
    targetHeight: number = 640
  ) {
    this.confidenceThreshold = confidenceThreshold;
    this.nmsThreshold = nmsThreshold;
    this.targetWidth = targetWidth;
    this.targetHeight = targetHeight;
  }

  public async initialize(modelPath?: string): Promise<void> {
    this.modelPath = modelPath || 'mobile/src/lab/models/yunet_2023mar.onnx';
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
      'YuNet',
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
      'YuNet',
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
