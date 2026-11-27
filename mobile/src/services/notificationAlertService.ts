import { Platform, ToastAndroid, Vibration } from 'react-native';

export interface AlertNotificationPayload {
  id?: string;
  title: string;
  message: string;
  category?: string;
  priority?: string;
  actionRoute?: string;
}

type NotificationAlertListener = (payload: AlertNotificationPayload) => void;
const listeners = new Set<NotificationAlertListener>();

export function subscribeNotificationAlerts(listener: NotificationAlertListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Triggers native Android system notification feedback:
 * 1. Native ToastAndroid popup (bottom of the screen).
 * 2. Vibration haptic pattern (varying by priority).
 * 3. Broadcasts to In-App HUD listeners for real-time status bar banner.
 */
export function triggerNotificationAlert(payload: AlertNotificationPayload): void {
  // 1. Android Native Toast
  if (Platform.OS === 'android') {
    try {
      const toastText = `${payload.title}: ${payload.message}`;
      ToastAndroid.showWithGravity(
        toastText.slice(0, 140),
        ToastAndroid.LONG,
        ToastAndroid.BOTTOM
      );
    } catch (_) {}
  }

  // 2. Native Vibration feedback based on priority
  try {
    const p = payload.priority?.toUpperCase();
    if (p === 'HIGH' || p === 'URGENT') {
      Vibration.vibrate([0, 180, 80, 180]);
    } else {
      Vibration.vibrate(120);
    }
  } catch (_) {}

  // 3. Broadcast to In-App HUD listeners
  listeners.forEach((fn) => {
    try {
      fn(payload);
    } catch (_) {}
  });
}
