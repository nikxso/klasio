import { NativeModules, Platform } from 'react-native';
import { API_BASE_URL } from '../config/api';

const { DirectPerception } = NativeModules;

export interface CapturePhotoResult {
  success: boolean;
  base64: string;
  width: number;
  height: number;
  sizeBytes: number;
}

/**
 * Save report content (e.g. CSV or TXT) to device storage (Downloads/Klasio) and prompt share sheet.
 */
export async function saveReportFile(
  fileName: string,
  content: string,
  mimeType: string = 'text/csv'
): Promise<string> {
  if (Platform.OS === 'android' && DirectPerception?.saveReportFile) {
    return await DirectPerception.saveReportFile(fileName, content, mimeType);
  }
  console.log('[NativePerception] Fallback mock saving report:', fileName);
  return `mock://${fileName}`;
}

/**
 * Capture a cropped/centered profile photo directly from the active CameraView in memory.
 */
export async function capturePhotoFromCamera(viewTag: number): Promise<CapturePhotoResult> {
  if (Platform.OS === 'android' && DirectPerception?.capturePhotoFromCamera) {
    return await DirectPerception.capturePhotoFromCamera(viewTag);
  }
  throw new Error('Camera capture native module is only available on Android native build.');
}

/**
 * Upload a profile photograph to the backend for a specific user ID.
 */
export async function uploadProfilePhoto(
  userId: string,
  base64Jpg: string,
  token?: string | null
): Promise<{ photo_url: string }> {
  const url = `${API_BASE_URL}/api/v1/users/${userId}/profile-photo`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ photo_base64: base64Jpg }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Profile photo upload failed (${res.status}): ${errText}`);
  }

  return await res.json();
}

/**
 * Get the public/authenticated URL for a user's profile photograph.
 */
export function getProfilePhotoUrl(userId: string): string {
  return `${API_BASE_URL}/api/v1/users/${userId}/profile-photo`;
}
