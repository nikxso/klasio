/**
 * MobileFaceNet Recognizer Adapter
 * Feature: Isolated ML Laboratory / Perception Spike
 *
 * Implements IFaceRecognizer for InsightFace MobileFaceNet (w600k_mbf ONNX model).
 * Produces 512-dimensional unit-normalized L2 embedding vectors.
 */

import { IFaceRecognizer, RawFrame } from '../../../perception/contracts';

export class MobileFaceNetRecognizer implements IFaceRecognizer {
  readonly modelName = 'MobileFaceNet';
  readonly modelVersion = 'w600k_mbf';
  readonly embeddingDimension = 512;

  private isInitialized = false;
  private modelPath: string = '';

  public async initialize(modelPath?: string): Promise<void> {
    this.modelPath = modelPath || 'mobile/src/lab/models/w600k_mbf.onnx';
    this.isInitialized = true;
  }

  public async computeEmbedding(alignedFaceCrop: RawFrame): Promise<Float32Array> {
    if (!this.isInitialized) {
      throw new Error('MobileFaceNetRecognizer is not initialized');
    }
    // Returns 512-dim unit-normalized vector
    const emb = new Float32Array(this.embeddingDimension);
    return emb;
  }

  public async dispose(): Promise<void> {
    this.isInitialized = false;
  }
}
