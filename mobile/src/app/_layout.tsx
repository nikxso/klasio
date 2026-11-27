import React, { useEffect, useState } from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  ActivityIndicator,
  LogBox,
  NativeModules,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFonts } from 'expo-font';
import { Sparkles, X } from 'lucide-react-native';
import { Colors } from '@/theme/tokens';
import { SessionStore } from '@/storage/sessionStore';
import { useAutoSync } from '@/services/autoSyncService';
import {
  checkForAppUpdates,
  verifyAndRecordUpdateLifecycle,
  subscribeUpdateEvents,
  applyUpdateAndReload,
  isPendingUpdateAvailable,
  UpdateEventState,
} from '@/services/updateService';

LogBox.ignoreAllLogs(true);

function UnsupportedDeviceScreen() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <View style={styles.errorContainer}>
        <View style={styles.errorCard}>
          <View style={styles.badgeContainer}>
            <Text style={styles.errorBadge}>HARDWARE / RUNTIME GUARD</Text>
          </View>
          <Text style={styles.errorTitle}>Unsupported Device / Native Module Missing</Text>
          <Text style={styles.errorMessage}>
            Klasio requires the DirectPerception native module (ONNX Runtime, YuNet face detection, and EdgeFace-XS 512-D neural embedding) to run on-device attendance verification.
          </Text>
          <View style={styles.codeBox}>
            <Text style={styles.codeText}>NativeModules.DirectPerception is missing.</Text>
          </View>
          <Text style={styles.errorDetail}>
            Please install the standalone release APK or run via a custom development build (npx expo run:android) rather than standard Expo Go.
          </Text>
        </View>
      </View>
    </SafeAreaProvider>
  );
}

function GlobalUpdateBanner() {
  const insets = useSafeAreaInsets();
  const [updateState, setUpdateState] = useState<UpdateEventState>({
    status: isPendingUpdateAvailable() ? 'READY' : 'IDLE',
    isPending: isPendingUpdateAvailable(),
  });
  const [dismissed, setDismissed] = useState(false);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    const unsub = subscribeUpdateEvents((state) => {
      setUpdateState(state);
      if (state.status === 'READY' || state.status === 'DOWNLOADING') {
        setDismissed(false);
      }
    });
    return unsub;
  }, []);

  if (dismissed) return null;
  if (updateState.status !== 'DOWNLOADING' && updateState.status !== 'READY') return null;

  const handleRestart = async () => {
    if (reloading) return;
    setReloading(true);
    try {
      await applyUpdateAndReload();
    } catch (_) {
      setReloading(false);
    }
  };

  const isDownloading = updateState.status === 'DOWNLOADING';

  return (
    <View
      pointerEvents="box-none"
      style={[
        styles.globalBannerWrapper,
        { top: Math.max(insets.top + 8, 16) },
      ]}
    >
      <View
        style={[
          styles.globalBannerCard,
          isDownloading ? styles.bannerDownloading : styles.bannerReady,
        ]}
      >
        <View style={styles.bannerIconCol}>
          {isDownloading ? (
            <ActivityIndicator size="small" color="#1B4D3E" />
          ) : (
            <View style={styles.sparkleCircle}>
              <Sparkles size={16} color="#FFFFFF" />
            </View>
          )}
        </View>

        <View style={styles.bannerTextCol}>
          <Text style={[styles.bannerTitle, !isDownloading && styles.bannerTitleLight]}>
            {isDownloading ? 'Downloading Klasio Update...' : 'Klasio Update Ready!'}
          </Text>
          <Text
            style={[styles.bannerSubtitle, !isDownloading && styles.bannerSubtitleLight]}
            numberOfLines={1}
          >
            {isDownloading
              ? 'New version downloading in background'
              : 'Restart app now to apply new features'}
          </Text>
        </View>

        {!isDownloading && (
          <Pressable
            onPress={handleRestart}
            disabled={reloading}
            style={({ pressed }) => [
              styles.bannerRestartBtn,
              pressed && { opacity: 0.8 },
            ]}
          >
            {reloading ? (
              <ActivityIndicator size="small" color="#1B4D3E" />
            ) : (
              <Text style={styles.bannerRestartText}>Restart</Text>
            )}
          </Pressable>
        )}

        <Pressable
          onPress={() => setDismissed(true)}
          hitSlop={8}
          style={({ pressed }) => [
            styles.bannerCloseBtn,
            pressed && { opacity: 0.6 },
          ]}
        >
          <X size={15} color={isDownloading ? '#4A6559' : '#FFFFFF'} />
        </Pressable>
      </View>
    </View>
  );
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    'ChangaOne-Regular': require('../../assets/fonts/ChangaOne-Regular.ttf'),
  });

  useAutoSync();

  useEffect(() => {
    SessionStore.initFromStorage().catch(() => {});
    checkForAppUpdates(true).catch(() => {});
    verifyAndRecordUpdateLifecycle().catch(() => {});
  }, []);

  // Startup check: require DirectPerception native perception module on Android
  const isDirectPerceptionMissing = Platform.OS === 'android' && !NativeModules.DirectPerception;

  if (isDirectPerceptionMissing) {
    return <UnsupportedDeviceScreen />;
  }

  if (!fontsLoaded) {
    return null;
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: Colors.cream },
          animation: 'none',
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="(faculty)" options={{ headerShown: false }} />
        <Stack.Screen name="(student)" options={{ headerShown: false }} />
        <Stack.Screen name="(admin)" options={{ headerShown: false }} />
        <Stack.Screen name="notifications/index" options={{ headerShown: false }} />
      </Stack>
      <GlobalUpdateBanner />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  errorContainer: {
    flex: 1,
    backgroundColor: '#FDFCF7',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  errorCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 28,
    width: '100%',
    maxWidth: 420,
    borderWidth: 1,
    borderColor: '#F0ECE1',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 4,
  },
  badgeContainer: {
    alignSelf: 'flex-start',
    backgroundColor: '#FDE8E8',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 6,
    marginBottom: 16,
  },
  errorBadge: {
    fontSize: 11,
    fontWeight: '700',
    color: '#E02424',
    letterSpacing: 0.6,
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1C1917',
    marginBottom: 12,
    lineHeight: 26,
  },
  errorMessage: {
    fontSize: 14,
    color: '#44403C',
    lineHeight: 20,
    marginBottom: 16,
  },
  codeBox: {
    backgroundColor: '#F5F5F4',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E7E5E4',
    marginBottom: 16,
  },
  codeText: {
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    fontSize: 12,
    color: '#DC2626',
    fontWeight: '600',
  },
  errorDetail: {
    fontSize: 13,
    color: '#78716C',
    lineHeight: 18,
  },
  globalBannerWrapper: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 99999,
    alignItems: 'center',
  },
  globalBannerCard: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 14,
    width: '100%',
    maxWidth: 500,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.16,
    shadowRadius: 10,
    elevation: 8,
  },
  bannerDownloading: {
    backgroundColor: '#E8F5E9',
    borderWidth: 1,
    borderColor: '#C8E6C9',
  },
  bannerReady: {
    backgroundColor: '#1B4D3E',
    borderWidth: 1,
    borderColor: '#2D6A53',
  },
  bannerIconCol: {
    marginRight: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sparkleCircle: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bannerTextCol: {
    flex: 1,
    marginRight: 8,
  },
  bannerTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#0D281E',
  },
  bannerTitleLight: {
    color: '#FFFFFF',
  },
  bannerSubtitle: {
    fontSize: 11,
    color: '#37474F',
    marginTop: 1,
  },
  bannerSubtitleLight: {
    color: '#D1E7DD',
  },
  bannerRestartBtn: {
    backgroundColor: '#FFFFFF',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
    marginRight: 8,
  },
  bannerRestartText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#1B4D3E',
  },
  bannerCloseBtn: {
    padding: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
