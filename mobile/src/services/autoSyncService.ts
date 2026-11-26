import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import { AttendanceSyncWorker } from '@/storage/syncWorker';
import { SessionStore } from '@/storage/sessionStore';
import { NotificationRepository } from '@/storage/notificationRepository';
import { RequestRepository } from '@/storage/requestRepository';

let isSyncing = false;
let lastSyncTimestamp = 0;

export async function runAutoSync(triggerReason: string = 'manual'): Promise<{
  sessionsSynced: number;
  requestsSynced: number;
}> {
  if (isSyncing) {
    return { sessionsSynced: 0, requestsSynced: 0 };
  }

  // Throttle sync triggers to at most once every 3 seconds unless forced
  const now = Date.now();
  if (now - lastSyncTimestamp < 3000 && triggerReason !== 'manual') {
    return { sessionsSynced: 0, requestsSynced: 0 };
  }

  isSyncing = true;
  lastSyncTimestamp = now;

  let sessionsSynced = 0;
  let requestsSynced = 0;

  try {
    const net = await NetInfo.fetch();
    const isOnline = net.isConnected && net.isInternetReachable !== false;
    if (!isOnline) {
      return { sessionsSynced: 0, requestsSynced: 0 };
    }

    let token = SessionStore.getToken();
    let user = SessionStore.getUser();
    if (!token || !user) {
      const stored = await SessionStore.initFromStorage();
      token = stored?.token || undefined;
      user = stored?.user || null;
    }

    // 1. Process outbound attendance synchronization queue (sessions, cancellations, amendments)
    try {
      const syncRes = await AttendanceSyncWorker.processPendingQueue(
        undefined,
        token || undefined,
        undefined,
        true
      );
      sessionsSynced = syncRes.succeeded;
    } catch (e) {
      // Offline / transient network error during attendance sync
    }

    // 2. Synchronize pending student attendance mistake reports / grievances
    if (token) {
      try {
        const reqRes = await RequestRepository.syncPendingRequests(token);
        requestsSynced = reqRes.synced;
      } catch (e) {
        // Offline / transient network error during requests sync
      }
    }

    // 3. Fetch and sync latest incoming notifications when authenticated
    if (user?.id && token) {
      try {
        await NotificationRepository.fetchAndSyncNotifications(user.id, token);
      } catch (e) {
        // Silently skip notification refresh on network jitter
      }
    }
  } finally {
    isSyncing = false;
  }

  return { sessionsSynced, requestsSynced };
}

/**
 * Global React hook to mount automatic background and foreground synchronization.
 * Reacts within seconds when internet becomes available, when app becomes active,
 * or on periodic intervals.
 */
export function useAutoSync() {
  const debounceTimerRef = useRef<any>(null);

  useEffect(() => {
    // 1. Initial sync on hook mount
    runAutoSync('mount');

    // 2. NetInfo listener: trigger immediately when connection is restored
    const unsubNet = NetInfo.addEventListener((state: NetInfoState) => {
      if (state.isConnected && state.isInternetReachable !== false) {
        if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = setTimeout(() => {
          runAutoSync('network_reconnected');
        }, 1500);
      }
    });

    // 3. AppState listener: trigger when app returns to foreground
    const unsubApp = AppState.addEventListener('change', (status: AppStateStatus) => {
      if (status === 'active') {
        runAutoSync('app_active');
      }
    });

    // 4. Periodic background/active interval timer: every 20 seconds
    const intervalTimer = setInterval(() => {
      runAutoSync('periodic_interval');
    }, 20000);

    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      clearInterval(intervalTimer);
      unsubNet();
      unsubApp.remove();
    };
  }, []);
}
