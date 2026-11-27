/**
 * Centralized API & Networking Configuration for Klasio Mobile.
 *
 * In staging/production on physical devices (e.g. Motorola Moto G54),
 * 127.0.0.1 refers to localhost on the phone itself.
 * The production Cloudflare tunnel URL routes to our Azure staging backend.
 */
export const CLOUD_BACKEND_URL = 'https://payment-adaptor-pottery-answered.trycloudflare.com';

const getApiBaseUrl = (): string => {
  const isDev = typeof __DEV__ !== 'undefined' ? Boolean(__DEV__) : process.env.NODE_ENV !== 'production';
  const envUrl = process.env.EXPO_PUBLIC_API_URL?.trim();

  // If in production build or running on physical device, guard against loopback 127.0.0.1 / localhost
  if (!isDev && (!envUrl || envUrl.includes('127.0.0.1') || envUrl.includes('localhost'))) {
    return CLOUD_BACKEND_URL;
  }

  if (envUrl) {
    return envUrl.replace(/\/+$/, '');
  }

  return isDev ? 'http://127.0.0.1:8000' : CLOUD_BACKEND_URL;
};

export const API_BASE_URL = getApiBaseUrl();

export const getApiUrl = (path: string): string => {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE_URL}${cleanPath}`;
};
