/**
 * Centralized API & Networking Configuration for Klasio Mobile.
 *
 * In staging/production on physical devices (e.g. Motorola Moto G54),
 * 127.0.0.1 refers to localhost on the phone itself.
 * Set EXPO_PUBLIC_API_URL in your environment or .env to point to the staging server
 * (e.g., http://192.168.1.100:8080 or https://klasio.staging.institution.edu).
 */

const getApiBaseUrl = (): string => {
  if (process.env.EXPO_PUBLIC_API_URL) {
    return process.env.EXPO_PUBLIC_API_URL.replace(/\/+$/, '');
  }
  // Default fallback for development with adb reverse
  return 'http://127.0.0.1:8000';
};

export const API_BASE_URL = getApiBaseUrl();

export const getApiUrl = (path: string): string => {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE_URL}${cleanPath}`;
};
