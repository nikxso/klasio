import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeAspectRatio,
  enumerateDeviceFormats,
  selectBestPreviewFormat,
  ANALYSIS_RESOLUTIONS,
} from '../cameraFormatPolicy.ts';

test('Aspect Ratio computation correctly detects standard ratios', () => {
  const fhd = computeAspectRatio(1920, 1080);
  assert.equal(fhd.label, '16:9');
  assert.equal(fhd.is16by9, true);

  const hd = computeAspectRatio(1280, 720);
  assert.equal(hd.label, '16:9');
  assert.equal(hd.is16by9, true);

  const legacyNtsc = computeAspectRatio(720, 480);
  assert.equal(legacyNtsc.label, '3:2');
  assert.equal(legacyNtsc.is16by9, false);

  const vga = computeAspectRatio(640, 480);
  assert.equal(vga.label, '4:3');
  assert.equal(vga.is16by9, false);
});

test('Format selection policy picks 1080p Tier 1 on capable devices', () => {
  const mockDevice = {
    id: 'back-camera-1',
    formats: [
      { videoWidth: 3840, videoHeight: 2160, maxFps: 30, minFps: 15, photoWidth: 3840, photoHeight: 2160 }, // 4K UHD
      { videoWidth: 1920, videoHeight: 1080, maxFps: 30, minFps: 15, photoWidth: 1920, photoHeight: 1080 }, // 1080p FHD
      { videoWidth: 1280, videoHeight: 720, maxFps: 30, minFps: 15, photoWidth: 1280, photoHeight: 720 },  // 720p HD
      { videoWidth: 720, videoHeight: 480, maxFps: 30, minFps: 15, photoWidth: 720, photoHeight: 480 },   // 480p SD
    ],
  };

  const decision = selectBestPreviewFormat(mockDevice, 'auto');
  assert.equal(decision.selectedCapability.videoWidth, 1920);
  assert.equal(decision.selectedCapability.videoHeight, 1080);
  assert.equal(decision.selectedCapability.maxFps, 30);
  assert.match(decision.policyReason, /Tier 1/);
});

test('Format selection policy picks 720p Tier 2 when explicitly requested or on 720p-limited devices', () => {
  const mockDevice = {
    id: 'front-camera-1',
    formats: [
      { videoWidth: 1280, videoHeight: 720, maxFps: 30, minFps: 15, photoWidth: 1280, photoHeight: 720 },  // 720p HD
      { videoWidth: 720, videoHeight: 480, maxFps: 30, minFps: 15, photoWidth: 720, photoHeight: 480 },   // 480p SD
      { videoWidth: 640, videoHeight: 480, maxFps: 30, minFps: 15, photoWidth: 640, photoHeight: 480 },   // 480p VGA
    ],
  };

  const decision = selectBestPreviewFormat(mockDevice, 'auto');
  assert.equal(decision.selectedCapability.videoWidth, 1280);
  assert.equal(decision.selectedCapability.videoHeight, 720);
  assert.equal(decision.selectedCapability.maxFps, 30);
  assert.match(decision.policyReason, /Tier 2/);
});

test('ML Analysis resolution is completely decoupled from preview resolution', () => {
  const mockDevice = {
    id: 'back-camera-1',
    formats: [
      { videoWidth: 1920, videoHeight: 1080, maxFps: 30, minFps: 15, photoWidth: 1920, photoHeight: 1080 },
    ],
  };

  // Preview format is 1920x1080
  const decision = selectBestPreviewFormat(mockDevice, '1080p', ANALYSIS_RESOLUTIONS.STANDARD_640);
  assert.equal(decision.selectedCapability.videoWidth, 1920);
  assert.equal(decision.selectedCapability.videoHeight, 1080);

  // But ML analysis config is independently 640x640
  assert.equal(decision.analysisConfig.targetWidth, 640);
  assert.equal(decision.analysisConfig.targetHeight, 640);
  assert.equal(decision.analysisConfig.downsampleMethod, 'bilinear');
});

test('Mathematical validation of why 720x480 was previously selected', () => {
  // When VisionCamera getCameraFormat received overlapping filters:
  // videoResolution: { width: 960, height: 540 } (target pixels = 518,400)
  const targetPixels = 960 * 540; // 518,400
  const res720x480 = 720 * 480;   // 345,600
  const res1280x720 = 1280 * 720; // 921,600

  const diff720x480 = Math.abs(res720x480 - targetPixels);   // 172,800
  const diff1280x720 = Math.abs(res1280x720 - targetPixels); // 403,200

  // 720x480 has smaller absolute pixel distance than 1280x720 to 960x540
  assert.ok(diff720x480 < diff1280x720);
});
