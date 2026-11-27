import * as Updates from 'expo-updates';
import { Alert } from 'react-native';

export interface UpdateInfo {
  isAvailable: boolean;
  isChecking: boolean;
  error?: string;
}

// Track update IDs prompted during current app lifecycle to avoid spamming the user
const promptedUpdateIds = new Set<string>();
let isChecking = false;

/**
 * Checks for OTA updates in production and prompts the user or automatically reloads.
 * 
 * @param silent When true (e.g. app startup), downloads update in background without 
 * blocking or popping up modal alert if already running or if user previously deferred.
 */
export async function checkForAppUpdates(silent = true): Promise<boolean> {
  if (__DEV__) {
    if (!silent) {
      Alert.alert('Development Mode', 'OTA updates are disabled while running in local Metro development mode.');
    }
    return false;
  }

  if (!Updates.isEnabled) {
    if (!silent) {
      Alert.alert('Updates Not Enabled', 'expo-updates runtime is not enabled in this build.');
    }
    return false;
  }

  if (isChecking) {
    return false;
  }

  try {
    isChecking = true;
    const update = await Updates.checkForUpdateAsync();
    
    if (!update.isAvailable) {
      if (!silent) {
        Alert.alert('Up to Date', 'You are running the latest version of Klasio.');
      }
      return false;
    }

    const newManifestId = (update.manifest as any)?.id || (update.manifest as any)?.updateId;
    
    // Invariant: If client is already running this update ID, do nothing!
    if (newManifestId && Updates.updateId && newManifestId.toLowerCase() === Updates.updateId.toLowerCase()) {
      return false;
    }

    // Invariant: Do not spam user with the same update prompt multiple times in a single session
    if (newManifestId && promptedUpdateIds.has(newManifestId.toLowerCase())) {
      return false;
    }

    // Download the update bundle & assets
    await Updates.fetchUpdateAsync();

    if (newManifestId) {
      promptedUpdateIds.add(newManifestId.toLowerCase());
    }

    // If silent startup check: Do NOT show blocking alert modal!
    // The downloaded update is now stored in expo-updates SQLite cache and will 
    // seamlessly boot on the next launch or app restart.
    if (silent) {
      console.log('[UPDATES] Background update downloaded successfully. It will apply on next restart.');
      return true;
    }

    // If explicit manual check (from settings or button): Prompt user to restart
    Alert.alert(
      'Update Downloaded',
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
    return true;
  } catch (error: any) {
    if (!silent) {
      Alert.alert('Update Check Failed', error?.message || 'Could not reach update server.');
    }
    return false;
  } finally {
    isChecking = false;
  }
}
