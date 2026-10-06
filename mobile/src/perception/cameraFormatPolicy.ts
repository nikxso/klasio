import type { CameraDevice, CameraDeviceFormat } from 'react-native-vision-camera';

/**
 * Replaceable Perception Camera Format Policy
 * Implements capability-driven preview selection and ML input decoupling.
 *
 * Requirements:
 * - Camera preview quality != ML analysis resolution.
 * - Inspect available device formats dynamically (no permanent hardcoding).
 * - Choose the best practical preview format balancing visual sharpness,
 *   aspect ratio, frame rate stability, and thermal/power efficiency.
 * - ML pipeline analysis frame is independently configurable.
 */

export interface FormattedCapability {
  id: string;
  videoWidth: number;
  videoHeight: number;
  photoWidth: number;
  photoHeight: number;
  aspectRatioLabel: string;
  aspectRatioNumeric: number;
  minFps: number;
  maxFps: number;
  frameDurationMs: number;
  supportsVideoHdr: boolean;
  supportsPhotoHdr: boolean;
  supportsDepthCapture: boolean;
  autoFocusSystem: string;
  is16by9: boolean;
  pixelCount: number;
  rawFormat: CameraDeviceFormat;
}

export interface MLAnalysisResolutionConfig {
  targetWidth: number;
  targetHeight: number;
  label: string;
  downsampleMethod: 'bilinear' | 'area';
}

export interface CameraPolicyDecision {
  selectedFormat: CameraDeviceFormat;
  selectedCapability: FormattedCapability;
  policyReason: string;
  allCapabilities: FormattedCapability[];
  analysisConfig: MLAnalysisResolutionConfig;
}

/**
 * Standard ML Analysis Resolution Configurations.
 * ML models (e.g. YuNet / SCRFD / EdgeFace) operate on normalized dimensions,
 * typically 320x320 or 640x640, completely decoupled from preview resolution.
 */
export const ANALYSIS_RESOLUTIONS: Record<string, MLAnalysisResolutionConfig> = {
  STANDARD_640: {
    targetWidth: 640,
    targetHeight: 640,
    label: '640×640 (Balanced Detection)',
    downsampleMethod: 'bilinear',
  },
  LIGHTWEIGHT_320: {
    targetWidth: 320,
    targetHeight: 320,
    label: '320×320 (High-Speed Detection)',
    downsampleMethod: 'area',
  },
  HD_CROPPED: {
    targetWidth: 640,
    targetHeight: 360,
    label: '640×360 (16:9 Aspect Match)',
    downsampleMethod: 'bilinear',
  },
};

/**
 * Compute aspect ratio label and numerical ratio for a given width and height.
 */
export function computeAspectRatio(width: number, height: number): { label: string; numeric: number; is16by9: boolean } {
  const numeric = Number((width / height).toFixed(3));
  const is16by9 = Math.abs(numeric - 16 / 9) <= 0.03 || Math.abs(numeric - 9 / 16) <= 0.03;
  const is4by3 = Math.abs(numeric - 4 / 3) <= 0.03 || Math.abs(numeric - 3 / 4) <= 0.03;
  const is3by2 = Math.abs(numeric - 3 / 2) <= 0.03 || Math.abs(numeric - 2 / 3) <= 0.03;

  let label = `${width}:${height}`;
  if (is16by9) label = '16:9';
  else if (is4by3) label = '4:3';
  else if (is3by2) label = '3:2';

  return { label, numeric, is16by9 };
}

/**
 * Parse and normalize all formats supported by a CameraDevice.
 */
export function enumerateDeviceFormats(device: CameraDevice): FormattedCapability[] {
  if (!device || !device.formats || device.formats.length === 0) {
    return [];
  }

  return device.formats.map((fmt, index) => {
    const { label: aspectRatioLabel, numeric: aspectRatioNumeric, is16by9 } = computeAspectRatio(
      fmt.videoWidth,
      fmt.videoHeight
    );
    const pixelCount = fmt.videoWidth * fmt.videoHeight;
    const maxFps = fmt.maxFps ?? 30;
    const minFps = fmt.minFps ?? 15;
    const frameDurationMs = maxFps > 0 ? Number((1000 / maxFps).toFixed(1)) : 33.3;

    return {
      id: `${fmt.videoWidth}x${fmt.videoHeight}@${maxFps}fps-${aspectRatioLabel}-${index}`,
      videoWidth: fmt.videoWidth,
      videoHeight: fmt.videoHeight,
      photoWidth: fmt.photoWidth,
      photoHeight: fmt.photoHeight,
      aspectRatioLabel,
      aspectRatioNumeric,
      minFps,
      maxFps,
      frameDurationMs,
      supportsVideoHdr: fmt.supportsVideoHdr ?? false,
      supportsPhotoHdr: fmt.supportsPhotoHdr ?? false,
      supportsDepthCapture: fmt.supportsDepthCapture ?? false,
      autoFocusSystem: fmt.autoFocusSystem ?? 'none',
      is16by9,
      pixelCount,
      rawFormat: fmt,
    };
  });
}

/**
 * Capability-driven Preview Format Selection Policy:
 *
 * 1. Filter out formats with maxFps < 24 (insufficient for live human interaction).
 * 2. Avoid formats exceeding 1080p (e.g. 4K/3840x2160) for preview:
 *    - Unnecessary thermal dissipation and power draw.
 *    - Significant memory bandwidth saturation.
 *    - No visible benefit on a 1080p phone display.
 * 3. Prefer 16:9 aspect ratio (matches modern mobile screens with minimal letterboxing/cropping).
 * 4. Priority Order:
 *    Tier 1: 1920x1080 @ >= 30 FPS (Full HD, crispest display matching 1080p physical display width).
 *    Tier 2: 1280x720 @ >= 30 FPS (HD 720p, high efficiency, stable frame rate).
 *    Tier 3: Any other 16:9 format with >= 30 FPS.
 *    Tier 4: Nearest resolution to 1080p/720p with >= 24 FPS.
 *    Tier 5: Fallback to first available device format.
 */
export function selectBestPreviewFormat(
  device: CameraDevice,
  preferredTier: '1080p' | '720p' | 'auto' = 'auto',
  customAnalysisConfig: MLAnalysisResolutionConfig = ANALYSIS_RESOLUTIONS.STANDARD_640
): CameraPolicyDecision {
  const allCapabilities = enumerateDeviceFormats(device);

  if (allCapabilities.length === 0) {
    throw new Error(`Device ${device.id} has no supported formats.`);
  }

  // Filter candidates with usable framerates (>= 24 FPS)
  const fluidCandidates = allCapabilities.filter((c) => c.maxFps >= 24);
  const pool = fluidCandidates.length > 0 ? fluidCandidates : allCapabilities;

  let selectedCapability: FormattedCapability | undefined;
  let policyReason = '';

  // Check 1080p (1920x1080) 16:9 @ >= 30fps
  const fhd1080p = pool.find(
    (c) =>
      c.is16by9 &&
      Math.max(c.videoWidth, c.videoHeight) === 1920 &&
      Math.min(c.videoWidth, c.videoHeight) === 1080 &&
      c.maxFps >= 30
  );

  // Check 720p (1280x720) 16:9 @ >= 30fps
  const hd720p = pool.find(
    (c) =>
      c.is16by9 &&
      Math.max(c.videoWidth, c.videoHeight) === 1280 &&
      Math.min(c.videoWidth, c.videoHeight) === 720 &&
      c.maxFps >= 30
  );

  if (preferredTier === '1080p' && fhd1080p) {
    selectedCapability = fhd1080p;
    policyReason = 'Policy Selected: Preferred 1080p Full HD (1920×1080 @ 30fps, 16:9). Maximum display sharpness.';
  } else if (preferredTier === '720p' && hd720p) {
    selectedCapability = hd720p;
    policyReason = 'Policy Selected: Preferred 720p Standard HD (1280×720 @ 30fps, 16:9). High thermal efficiency.';
  } else if (preferredTier === 'auto') {
    // Under 'auto', prefer 1080p if available for maximum preview quality, else 720p
    if (fhd1080p) {
      selectedCapability = fhd1080p;
      policyReason = 'Policy Selected: Tier 1 (1920×1080 @ 30fps, 16:9). Crisp Full HD matched to 1080p mobile screen.';
    } else if (hd720p) {
      selectedCapability = hd720p;
      policyReason = 'Policy Selected: Tier 2 (1280×720 @ 30fps, 16:9). Optimal HD balance of clarity and power.';
    }
  }

  // Tier 3: Any 16:9 format with >= 30fps not exceeding 1080p
  if (!selectedCapability) {
    const candidate16by9 = pool
      .filter((c) => c.is16by9 && c.pixelCount <= 1920 * 1080 && c.maxFps >= 30)
      .sort((a, b) => b.pixelCount - a.pixelCount)[0];

    if (candidate16by9) {
      selectedCapability = candidate16by9;
      policyReason = `Policy Selected: Tier 3 (${candidate16by9.videoWidth}×${candidate16by9.videoHeight} @ ${candidate16by9.maxFps}fps, 16:9).`;
    }
  }

  // Tier 4: Best available candidate closest to 1080p without 4K penalty
  if (!selectedCapability) {
    const sub4k = pool.filter((c) => c.pixelCount <= 1920 * 1080);
    const sorted = (sub4k.length > 0 ? sub4k : pool).sort((a, b) => {
      // Closeness to 1920x1080 pixel count
      const targetPixels = 1920 * 1080;
      return Math.abs(a.pixelCount - targetPixels) - Math.abs(b.pixelCount - targetPixels);
    });
    selectedCapability = sorted[0];
    policyReason = `Policy Selected: Tier 4 Fallback (${selectedCapability.videoWidth}×${selectedCapability.videoHeight} @ ${selectedCapability.maxFps}fps, ${selectedCapability.aspectRatioLabel}).`;
  }

  // Ultimate fallback
  if (!selectedCapability) {
    selectedCapability = allCapabilities[0];
    policyReason = `Policy Selected: Tier 5 Hardware Default (${selectedCapability.videoWidth}×${selectedCapability.videoHeight}).`;
  }

  return {
    selectedFormat: selectedCapability.rawFormat,
    selectedCapability,
    policyReason,
    allCapabilities,
    analysisConfig: customAnalysisConfig,
  };
}
