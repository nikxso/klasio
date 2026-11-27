/**
 * Centralized API & Networking Configuration for Klasio Mobile.
 *
 * In staging/production on physical devices (e.g. Motorola Moto G54),
 * 127.0.0.1 refers to localhost on the phone itself.
 * Set EXPO_PUBLIC_API_URL in your environment or .env to point to the staging server
 * (e.g., http://192.168.1.100:8080 or https://klasio.staging.institution.edu).
 */

import Constants from 'expo-constants';

/**
 * Centralized API & Networking Configuration for Klasio Mobile.
 *
 * In staging/production on physical devices (e.g. Motorola Moto G54),
 * 127.0.0.1 refers to localhost on the phone itself.
 * The production Cloudflare tunnel URL routes to our Azure staging backend.
 */
export const CLOUD_BACKEND_URL = 'https://payment-adaptor-pottery-answered.trycloudflare.com';

const getApiBaseUrl = (): string => {
  const envUrl = process.env.EXPO_PUBLIC_API_URL?.trim();

  // If in production build or running on physical device, guard against loopback 127.0.0.1 / localhost
  if (!__DEV__ && (!envUrl || envUrl.includes('127.0.0.1') || envUrl.includes('localhost'))) {
    return CLOUD_BACKEND_URL;
  }

  if (envUrl) {
    return envUrl.replace(/\/+$/, '');
  }

  // Fallback to update manifest origin if configured in app.json
  const updatesUrl = Constants.expoConfig?.updates?.url;
  if (updatesUrl && !__DEV__) {
    try {
      const parsed = new URL(updatesUrl);
      return parsed.origin;
    } catch (_) {}
  }

  return __DEV__ ? 'http://127.0.0.1:8000' : CLOUD_BACKEND_URL;
};

export const API_BASE_URL = getApiBaseUrl();

export const getApiUrl = (path: string): string => {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE_URL}${cleanPath}`;
};
