/**
/**
 * Direct On-Device In-Memory Face Detector Adapter
 * Feature: 001-academic-roles-enrollment / Core Face Perception (Step C0.2)
 *
 * Implements IFaceDetector using the native DirectPerceptionModule on Android.
 * Eliminates takeSnapshot, JPEG disk encoding, and HTTP bridge transit.
 * Grabs frames directly from camera PreviewView memory and executes local ONNX Runtime inference.
 */

import { NativeModules } from 'react-native';
import { FaceDetectionResult, IFaceDetector, RawFrame } from '../../../perception/contracts';
import { DetailedPerceptionTimings } from '../../../perception/perceptionClient';

const { DirectPerception } = NativeModules;

export class DirectOnDeviceDetector implements IFaceDetector {
  readonly modelName = 'YuNet (In-Memory On-Device)';
  readonly modelVersion = '2023mar-ort-inmem';

  private isInitialized = false;
  private cameraTag: number | null = null;
  private confidenceThreshold: number = 0.35;
  private lastTimings: DetailedPerceptionTimings | null = null;

  constructor(cameraTag?: number | null, confidenceThreshold: number = 0.35) {
    this.cameraTag = cameraTag ?? null;
    this.confidenceThreshold = confidenceThreshold;
  }

  public setCameraTag(tag: number | null) {
    this.cameraTag = tag;
  }

  public async initialize(modelPath?: string): Promise<void> {
    if (!DirectPerception) {
      console.warn('[DirectOnDeviceDetector] DirectPerception native module is not registered.');
      return;
    }
    await DirectPerception.initDetector('YuNet');
    this.isInitialized = true;
  }


  public getLastTimings(): DetailedPerceptionTimings | null {
    return this.lastTimings;
  }

  public async detectFaces(frame: RawFrame): Promise<FaceDetectionResult[]> {
    const { results } = await this.detectFacesDetailed(frame);
    return results;
  }

  public async detectFacesDetailed(frame: RawFrame): Promise<{
    results: FaceDetectionResult[];
    timings?: DetailedPerceptionTimings;
  }> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    if (!DirectPerception || this.cameraTag == null) {
      return { results: [] };
    }

    const clientStart = performance.now();
    const captureTimestamp = frame.captureTimestampMs || Date.now();

    const nativeRes = await DirectPerception.detectFacesInMemory(this.cameraTag, {
      confidenceThreshold: this.confidenceThreshold,
    });

    const clientEnd = performance.now();
    const clientTotalMs = Math.round(clientEnd - clientStart);

    const faces: FaceDetectionResult[] = (nativeRes.faces || []).map((f: any) => {
      let mappedLandmarks = undefined;
      if (f.landmarks) {
        mappedLandmarks = {
          leftEye: f.landmarks.leftEye,
          rightEye: f.landmarks.rightEye,
          noseTip: f.landmarks.noseTip,
          mouthLeft: f.landmarks.mouthLeft || f.landmarks.leftMouth,
          mouthRight: f.landmarks.mouthRight || f.landmarks.rightMouth,
        };
      }

      return {
        boundingBox: {
          x: f.box.x,
          y: f.box.y,
          width: f.box.width,
          height: f.box.height,
        },
        confidence: f.confidence,
        landmarks: mappedLandmarks,
        latencyMs: Math.round(nativeRes.inferenceLatencyMs || 0),
        frameId: frame.frameId,
        captureTimestampMs: captureTimestamp,
        resultTimestampMs: Date.now(),
      };
    });

    const nativeTimings = nativeRes.timings || {};
    const totalE2EMs = Math.round(nativeRes.totalLatencyMs || clientTotalMs);
    const inferMs = Math.round(nativeTimings.onnxInferenceMs || nativeRes.inferenceLatencyMs || 0);

    const timings: DetailedPerceptionTimings = {
      frameId: frame.frameId,
      captureTimestampMs: captureTimestamp,
      captureToResultLatencyMs: totalE2EMs,
      resultAgeWhenRenderedMs: Math.round(Date.now() - captureTimestamp),
      queueDepth: 0,
      isStale: false,
      frameAcquisitionMs: Math.round(nativeTimings.frameAcquisitionMs || 0),
      frameConversionMs: 0,       // ZERO: No file-to-Blob conversion
      networkRoundtripMs: 0,      // ZERO: No HTTP network transit
      networkTransportMs: 0,      // ZERO: In-process direct memory
      serverPayloadReadMs: 0,     // ZERO: No server multipart read
      serverDecodeImageMs: 0,     // ZERO: No JPEG decompression
      serverPreprocessMs: Math.round(nativeTimings.preprocessMs || 0),
      serverInferenceMs: inferMs,
      serverPostprocessMs: Math.round(nativeTimings.postprocessMs || 0),
      serverTotalMs: totalE2EMs,
      clientTotalMs: clientTotalMs,
      clientResultHandlingMs: 0,
      totalEndToEndMs: totalE2EMs,
      overheadOutsideInferenceMs: Math.max(0, totalE2EMs - inferMs),
    };

    this.lastTimings = timings;
    return { results: faces, timings };
  }

  public async dispose(): Promise<void> {
    this.isInitialized = false;
  }
}
