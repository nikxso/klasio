import * as Updates from 'expo-updates';
import { Alert } from 'react-native';

export interface UpdateInfo {
  isAvailable: boolean;
  isChecking: boolean;
  error?: string;
}

/**
 * Checks for OTA updates in production and prompts the user or automatically reloads.
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

  try {
    const update = await Updates.checkForUpdateAsync();
    if (update.isAvailable) {
      await Updates.fetchUpdateAsync();
      Alert.alert(
        'Update Available',
        'A new version of Klasio has been downloaded. Restart the app to apply the updates immediately.',
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
    } else {
      if (!silent) {
        Alert.alert('Up to Date', 'You are running the latest version of Klasio.');
      }
      return false;
    }
  } catch (error: any) {
    if (!silent) {
      Alert.alert('Update Check Failed', error?.message || 'Could not reach update server.');
    }
    return false;
  }
}
