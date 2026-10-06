/**
 * Perception Client Bridge
 * Feature: 001-academic-roles-enrollment / Core Face Perception (Step B)
 *
 * Connects the mobile camera perception stream to the on-device/USB bridge
 * neural detector service (running YuNet and SCRFD-500M with ONNX Runtime).
 */

import { FaceDetectionResult, RawFrame } from './contracts';

export interface DetectionResponse {
  success: boolean;
  detector: string;
  modelVersion: string;
  inferenceLatencyMs: number;
  totalLatencyMs: number;
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
    detector: 'YuNet' | 'SCRFD-500M',
    analysisWidth: number = 640,
    analysisHeight: number = 640,
    confidenceThreshold: number = 0.4
  ): Promise<{ results: FaceDetectionResult[]; latencyMs: number }> {
    const t0 = performance.now();

    try {
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

      const response = await fetch(`${this.endpoint}/detect`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw new Error(`Perception worker error: HTTP ${response.status}`);
      }

      const data: DetectionResponse = await response.json();
      const roundtripMs = Math.round(performance.now() - t0);

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
      }));

      return {
        results,
        latencyMs: data.inferenceLatencyMs || roundtripMs,
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
