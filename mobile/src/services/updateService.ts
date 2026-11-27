// Safe dynamic imports to support runtime Metro bundling while remaining testable in Node
let Alert: any = {
  alert: (title: string, message?: string, _buttons?: any[]) => {
    console.log(`[Alert] ${title}: ${message}`);
  },
};
let Updates: any = {
  isEnabled: false,
  isEmbeddedLaunch: true,
  updateId: null,
  channel: null,
  runtimeVersion: '1.0.0',
  createdAt: null,
  checkForUpdateAsync: async () => ({ isAvailable: false }),
  fetchUpdateAsync: async () => {},
  reloadAsync: async () => {},
};

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const RN = require('react-native');
  if (RN && RN.Alert) Alert = RN.Alert;
} catch (_) {}

try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ExpoUpdates = require('expo-updates');
  if (ExpoUpdates) Updates = ExpoUpdates;
} catch (_) {}

export interface AppUpdateDiagnostics {
  isEnabled: boolean;
  isEmbeddedLaunch: boolean;
  updateId: string | null;
  channel: string | null;
  runtimeVersion: string | null;
  createdAt: string | null;
}

export interface UpdateCheckResponse {
  success: boolean;
  updateAvailable?: boolean;
  message?: string;
}

type UpdateEventListener = (state: { isPending: boolean; updateId?: string | null }) => void;
const updateListeners = new Set<UpdateEventListener>();
let pendingUpdateId: string | null = null;
let hasPendingUpdate = false;

export function subscribeUpdateEvents(listener: UpdateEventListener): () => void {
  updateListeners.add(listener);
  listener({ isPending: hasPendingUpdate, updateId: pendingUpdateId });
  return () => {
    updateListeners.delete(listener);
  };
}

function notifyUpdateListeners(state: { isPending: boolean; updateId?: string | null }) {
  hasPendingUpdate = state.isPending;
  pendingUpdateId = state.updateId || null;
  for (const listener of updateListeners) {
    try {
      listener(state);
    } catch (e) {
      console.warn('Error in update listener:', e);
    }
  }
}

export function getAppUpdateState(): AppUpdateDiagnostics {
  try {
    return {
      isEnabled: Boolean(Updates.isEnabled),
      isEmbeddedLaunch: Boolean(Updates.isEmbeddedLaunch),
      updateId: Updates.updateId || null,
      channel: Updates.channel || null,
      runtimeVersion: Updates.runtimeVersion || '1.0.0',
      createdAt: Updates.createdAt ? Updates.createdAt.toISOString() : null,
    };
  } catch {
    return {
      isEnabled: false,
      isEmbeddedLaunch: true,
      updateId: null,
      channel: null,
      runtimeVersion: '1.0.0',
      createdAt: null,
    };
  }
}

export function isPendingUpdateAvailable(): boolean {
  return hasPendingUpdate;
}

export async function applyUpdateAndReload(): Promise<void> {
  if (Updates.isEnabled) {
    await Updates.reloadAsync();
  }
}

// Track update IDs prompted during current app lifecycle to avoid spamming the user
const promptedUpdateIds = new Set<string>();
let isChecking = false;

/**
 * Checks for OTA updates in production and prompts the user or automatically notifies.
 * 
 * @param silent When true (e.g. app startup), downloads update in background and prompts once.
 */
export async function checkForAppUpdates(silent = true): Promise<UpdateCheckResponse> {
  const isDev = typeof __DEV__ !== 'undefined' ? Boolean(__DEV__) : process.env.NODE_ENV !== 'production';

  if (isDev) {
    if (!silent) {
      Alert.alert('Development Mode', 'OTA updates are disabled while running in local Metro development mode.');
    }
    return { success: false, message: 'Development mode' };
  }

  if (!Updates.isEnabled) {
    if (!silent) {
      Alert.alert(
        'Updates Not Active',
        'expo-updates is not enabled in this binary. To receive OTA updates, please install the release APK with OTA support enabled.'
      );
    }
    return { success: false, message: 'expo-updates disabled' };
  }

  if (isChecking) {
    return { success: false, message: 'Already checking' };
  }

  try {
    isChecking = true;
    const update = await Updates.checkForUpdateAsync();

    if (!update.isAvailable) {
      if (!silent) {
        const idDisplay = Updates.updateId ? ` (Update ID: ${Updates.updateId.slice(0, 8)})` : '';
        Alert.alert('Klasio is Up to Date', `You are running the latest version of Klasio${idDisplay}.`);
      }
      return { success: true, updateAvailable: false };
    }

    const newManifestId = (update.manifest as any)?.id || (update.manifest as any)?.updateId;

    // Invariant: If client is already running this update ID, do nothing!
    if (newManifestId && Updates.updateId && newManifestId.toLowerCase() === Updates.updateId.toLowerCase()) {
      if (!silent) {
        Alert.alert('Klasio is Up to Date', `You are already running update ${newManifestId.slice(0, 8)}.`);
      }
      return { success: true, updateAvailable: false };
    }

    // Download the update bundle & assets
    await Updates.fetchUpdateAsync();
    notifyUpdateListeners({ isPending: true, updateId: newManifestId });

    if (newManifestId && promptedUpdateIds.has(newManifestId.toLowerCase())) {
      return { success: true, updateAvailable: true };
    }

    if (newManifestId) {
      promptedUpdateIds.add(newManifestId.toLowerCase());
    }

    Alert.alert(
      'Update Ready to Install',
      'A new version of Klasio has been downloaded. Would you like to restart the app to apply it now?',
      [
        { text: 'Later', style: 'cancel' },
        {
          text: 'Restart Now',
          style: 'default',
          onPress: async () => {
            await Updates.reloadAsync();
          },
        },
      ]
    );
    return { success: true, updateAvailable: true };
  } catch (error: any) {
    if (!silent) {
      Alert.alert('Update Check Failed', error?.message || 'Could not connect to update server.');
    }
    return { success: false, message: error?.message || 'Failed' };
  } finally {
    isChecking = false;
  }
}
