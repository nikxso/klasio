import React from 'react';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { LogBox, NativeModules, Platform, StyleSheet, Text, View } from 'react-native';
import { useFonts } from 'expo-font';
import { Colors } from '@/theme/tokens';

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

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    'ChangaOne-Regular': require('../../assets/fonts/ChangaOne-Regular.ttf'),
  });

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
});
