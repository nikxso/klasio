/**
 * Perception Client Bridge
 * Feature: 001-academic-roles-enrollment / Core Face Perception (Step B)
 *
 * Connects the mobile camera perception stream to the on-device/USB bridge
 * neural detector service (running YuNet with ONNX Runtime).
 */

import { FaceDetectionResult, RawFrame } from './contracts';

export interface ServerTimings {
  payloadReadMs: number;
  decodeImageMs: number;
  preprocessMs: number;
  onnxInferenceMs: number;
  postprocessMs: number;
  totalServerMs: number;
}

export interface DetailedPerceptionTimings {
  frameId?: string;
  captureTimestampMs?: number;
  clientSendTimestampMs?: number;
  clientReceiveTimestampMs?: number;
  captureToResultLatencyMs?: number;
  resultAgeWhenRenderedMs?: number;
  queueDepth?: number;
  isStale?: boolean;
  frameAcquisitionMs?: number;      // Camera takeSnapshot (bitmap grab + jpeg encode + write to disk)
  frameConversionMs: number;        // Reading snapshot file to Blob + building FormData
  networkRoundtripMs: number;       // HTTP request send to response JSON received
  networkTransportMs: number;       // networkRoundtripMs - serverTotalMs (transit over bridge)
  serverPayloadReadMs: number;      // Server reading multipart bytes
  serverDecodeImageMs: number;      // Server PIL JPEG decoding
  serverPreprocessMs: number;       // Server resizing and numpy array preparation
  serverInferenceMs: number;        // Server ONNX Runtime inference
  serverPostprocessMs: number;      // Server NMS and bounding box normalization
  serverTotalMs: number;            // Total execution on perception server
  clientTotalMs: number;            // Total client roundtrip inside PerceptionClient
  clientResultHandlingMs?: number;  // Parsing & mapping detections to UI state
  totalEndToEndMs?: number;         // Total frame-to-UI update latency
  overheadOutsideInferenceMs?: number; // totalEndToEndMs - serverInferenceMs
}

export interface DetectionResponse {
  success: boolean;
  detector: string;
  modelVersion: string;
  frameId?: string;
  captureTimestamp?: number;
  serverReceivedTimestampMs?: number;
  serverCompletedTimestampMs?: number;
  preprocessLatencyMs?: number;
  inferenceLatencyMs: number;
  postprocessLatencyMs?: number;
  totalLatencyMs: number;
  timings?: ServerTimings;
  analysisResolution: { width: number; height: number };
  facesCount: number;
  faces: Array<{
    id: string;
    box: { x: number; y: number; width: number; height: number };
    confidence: number;
    landmarks?: {
      rightEye: { x: number; y: number };
      leftEye: { x: number; y: number };
      noseTip: { x: number; y: number };
      rightMouth: { x: number; y: number };
      leftMouth: { x: number; y: number };
    };
  }>;
}

export class PerceptionClient {
  private static endpoint: string = 'http://127.0.0.1:8998';

  public static setEndpoint(url: string) {
    this.endpoint = url;
  }

  public static getEndpoint(): string {
    return this.endpoint;
  }

  public static async detect(
    frame: RawFrame,
    detector: 'YuNet',
    analysisWidth: number = 640,
    analysisHeight: number = 640,
    confidenceThreshold: number = 0.4
  ): Promise<{
    results: FaceDetectionResult[];
    latencyMs: number;
    timings?: DetailedPerceptionTimings;
  }> {
    const t0 = performance.now();

    try {
      const tConvStart = performance.now();
      let blob: Blob;

      if (frame.uri) {
        const fileRes = await fetch(frame.uri);
        blob = await fileRes.blob();
      } else if (typeof frame.data === 'string' && frame.data.startsWith('file://')) {
        const fileRes = await fetch(frame.data);
        blob = await fileRes.blob();
      } else if (frame.data instanceof ArrayBuffer || frame.data instanceof Uint8Array) {
        blob = new Blob([frame.data as any], { type: 'image/jpeg' });
      } else {
        throw new Error('Unsupported frame data format for perception inference');
      }

      const formData = new FormData();
      formData.append('file', blob, 'frame.jpg');
      formData.append('detector', detector);
      formData.append('analysisWidth', String(analysisWidth));
      formData.append('analysisHeight', String(analysisHeight));
      formData.append('confidenceThreshold', String(confidenceThreshold));
      if (frame.frameId) {
        formData.append('frameId', frame.frameId);
      }
      const captureTime = frame.captureTimestampMs ?? frame.timestampMs;
      if (captureTime) {
        formData.append('captureTimestamp', String(captureTime));
      }

      const tConvEnd = performance.now();
      const frameConversionMs = Math.round(tConvEnd - tConvStart);

      const tNetStart = performance.now();
      const response = await fetch(`${this.endpoint}/detect`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Perception worker error: HTTP ${response.status}`);
      }

      const data: DetectionResponse = await response.json();
      const tNetEnd = performance.now();
      const networkRoundtripMs = Math.round(tNetEnd - tNetStart);
      const clientTotalMs = Math.round(tNetEnd - t0);
      const captureToResultLatencyMs = Math.round(tNetEnd - captureTime);

      const srv = data.timings;
      const serverTotalMs = srv?.totalServerMs ?? data.totalLatencyMs ?? 0;
      const networkTransportMs = Math.max(0, Math.round(networkRoundtripMs - serverTotalMs));

      const detailedTimings: DetailedPerceptionTimings = {
        frameId: data.frameId ?? frame.frameId,
        captureTimestampMs: captureTime,
        clientSendTimestampMs: Math.round(tNetStart),
        clientReceiveTimestampMs: Math.round(tNetEnd),
        captureToResultLatencyMs,
        frameConversionMs,
        networkRoundtripMs,
        networkTransportMs,
        serverPayloadReadMs: srv?.payloadReadMs ?? 0,
        serverDecodeImageMs: srv?.decodeImageMs ?? 0,
        serverPreprocessMs: srv?.preprocessMs ?? data.preprocessLatencyMs ?? 0,
        serverInferenceMs: srv?.onnxInferenceMs ?? data.inferenceLatencyMs ?? 0,
        serverPostprocessMs: srv?.postprocessMs ?? data.postprocessLatencyMs ?? 0,
        serverTotalMs,
        clientTotalMs,
      };

      const resultTimestampMs = Date.now();
      const results: FaceDetectionResult[] = (data.faces || []).map((f) => ({
        boundingBox: {
          x: f.box.x,
          y: f.box.y,
          width: f.box.width,
          height: f.box.height,
        },
        confidence: f.confidence,
        landmarks: f.landmarks
          ? {
              leftEye: f.landmarks.leftEye,
              rightEye: f.landmarks.rightEye,
              noseTip: f.landmarks.noseTip,
              mouthLeft: f.landmarks.leftMouth,
              mouthRight: f.landmarks.rightMouth,
            }
          : undefined,
        latencyMs: data.inferenceLatencyMs,
        frameId: data.frameId ?? frame.frameId,
        captureTimestampMs: captureTime,
        resultTimestampMs,
      }));

      return {
        results,
        latencyMs: data.inferenceLatencyMs || clientTotalMs,
        timings: detailedTimings,
      };
    } catch (err: any) {
      console.warn(`[PerceptionClient] Detection failed (${detector}):`, err?.message);
      return {
        results: [],
        latencyMs: Math.round(performance.now() - t0),
      };
    }
  }
}
