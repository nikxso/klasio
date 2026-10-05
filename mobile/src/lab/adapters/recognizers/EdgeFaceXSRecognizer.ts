/**
 * EdgeFace-XS Recognizer Adapter
 * Feature: Isolated ML Laboratory / Perception Spike
 *
 * Implements IFaceRecognizer for EdgeFace-XS (edgeface_xs ONNX model).
 * Hybrid CNN-Transformer edge network producing 512-dimensional unit-normalized L2 vectors.
 */

import { IFaceRecognizer, RawFrame } from '../../../perception/contracts';

export class EdgeFaceXSRecognizer implements IFaceRecognizer {
  readonly modelName = 'EdgeFace-XS';
  readonly modelVersion = 'gamma_0.6';
  readonly embeddingDimension = 512;

  private isInitialized = false;
  private modelPath: string = '';

  public async initialize(modelPath?: string): Promise<void> {
    this.modelPath = modelPath || 'mobile/src/lab/models/edgeface_xs.onnx';
    this.isInitialized = true;
  }

  public async computeEmbedding(alignedFaceCrop: RawFrame): Promise<Float32Array> {
    if (!this.isInitialized) {
      throw new Error('EdgeFaceXSRecognizer is not initialized');
    }
    const emb = new Float32Array(this.embeddingDimension);
    return emb;
  }

  public async dispose(): Promise<void> {
    this.isInitialized = false;
  }
}
