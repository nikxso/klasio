import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  AppState,
  AppStateStatus,
  Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useCameraFormat,
} from 'react-native-vision-camera';
import * as Device from 'expo-device';
import { router } from 'expo-router';
import {
  Camera as CameraIcon,
  SwitchCamera,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  ShieldAlert,
  Activity,
  Cpu,
  Settings,
} from 'lucide-react-native';

export default function PerceptionLabScreen() {
  const { hasPermission, requestPermission } = useCameraPermission();
  const [cameraPosition, setCameraPosition] = useState<'back' | 'front'>('back');
  const [showDiagnostics, setShowDiagnostics] = useState<boolean>(true);
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const [switchLatency, setSwitchLatency] = useState<number | null>(null);
  const [permissionDeniedCount, setPermissionDeniedCount] = useState<number>(0);

  const insets = useSafeAreaInsets();

  // VisionCamera device selection based on chosen position
  const device = useCameraDevice(cameraPosition);

  // Dynamic preview format: queries hardware capabilities with graceful fallback
  const format = useCameraFormat(device, [
    { videoResolution: { width: 1280, height: 720 } },
    { videoResolution: { width: 1920, height: 1080 } },
    { videoResolution: { width: 960, height: 540 } },
    { fps: 30 },
    { fps: 24 },
    { fps: 15 },
  ]);

  // Handle application foreground/background transitions
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      setAppState(nextAppState);
    });
    return () => {
      subscription.remove();
    };
  }, []);

  // Request permission upon initial entry if not yet granted
  useEffect(() => {
    if (!hasPermission) {
      handleRequestPermission();
    }
  }, [hasPermission]);

  const handleRequestPermission = async () => {
    const granted = await requestPermission();
    if (!granted) {
      setPermissionDeniedCount((prev) => prev + 1);
    }
  };

  const handleSwitchCamera = (position: 'back' | 'front') => {
    if (position === cameraPosition) return;
    const t0 = performance.now();
    setCameraPosition(position);
    requestAnimationFrame(() => {
      setSwitchLatency(Math.round(performance.now() - t0));
    });
  };

  const isForeground = appState === 'active' || appState === 'unknown';
  const effectiveCameraActive = isForeground && hasPermission;

  return (
    <View style={styles.container}>
      <StatusBar style="light" />

      {/* Camera Viewport Area */}
      <View style={styles.cameraContainer}>
        {hasPermission && device != null ? (
          <Camera
            style={StyleSheet.absoluteFill}
            device={device}
            format={format}
            isActive={effectiveCameraActive}
            photo={false}
            video={false}
            audio={false}
            onError={(error) => {
              console.log('VisionCamera diagnostic event:', error.code, error.message);
            }}
          />
        ) : (
          <View style={styles.fallbackContainer}>
            {!hasPermission ? (
              <View style={styles.permissionCard}>
                <ShieldAlert size={48} color="#d65f57" />
                <Text style={styles.fallbackTitle}>Camera Permission Required</Text>
                <Text style={styles.fallbackText}>
                  Attendly ML Lab requires camera access to validate the on-device perception pipeline.
                </Text>
                <TouchableOpacity style={styles.primaryButton} onPress={handleRequestPermission}>
                  <Text style={styles.primaryButtonText}>Grant Permission</Text>
                </TouchableOpacity>

                {permissionDeniedCount >= 1 && (
                  <TouchableOpacity
                    style={styles.settingsButton}
                    onPress={() => Linking.openSettings()}
                  >
                    <Settings size={16} color="#ffffff" style={{ marginRight: 6 }} />
                    <Text style={styles.settingsButtonText}>Open System Settings</Text>
                  </TouchableOpacity>
                )}
              </View>
            ) : (
              <View style={styles.permissionCard}>
                <ActivityIndicator size="large" color="#2e6b57" />
                <Text style={styles.fallbackTitle}>
                  Initializing {cameraPosition.toUpperCase()} Camera...
                </Text>
                <Text style={styles.fallbackText}>
                  {device == null
                    ? `No ${cameraPosition} camera hardware detected on this device.`
                    : 'Acquiring camera sensor stream...'}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Top Header Floating Overlay */}
        <View
          style={[
            styles.topOverlay,
            {
              top: insets.top + 8,
              left: Math.max(insets.left, 16),
              right: Math.max(insets.right, 16),
            },
          ]}
        >
          <TouchableOpacity
            style={styles.iconButton}
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
          >
            <ArrowLeft size={20} color="#ffffff" />
          </TouchableOpacity>

          <View style={styles.titleBadge}>
            <Activity size={14} color="#f0a868" style={{ marginRight: 6 }} />
            <Text style={styles.titleBadgeText}>Perception Lab · Live Camera</Text>
          </View>

          <TouchableOpacity
            style={styles.iconButton}
            onPress={() => handleSwitchCamera(cameraPosition === 'back' ? 'front' : 'back')}
          >
            <SwitchCamera size={20} color="#ffffff" />
          </TouchableOpacity>
        </View>

        {/* Bottom Floating Control Bar */}
        <View
          style={[
            styles.bottomOverlay,
            {
              bottom: Math.max(insets.bottom, 16) + 8,
              left: Math.max(insets.left, 16),
              right: Math.max(insets.right, 16),
            },
          ]}
        >
          {/* Camera Selector Tabs */}
          <View style={styles.selectorBar}>
            <TouchableOpacity
              style={[styles.selectorTab, cameraPosition === 'front' && styles.selectorTabActive]}
              onPress={() => handleSwitchCamera('front')}
            >
              <Text
                style={[
                  styles.selectorTabText,
                  cameraPosition === 'front' && styles.selectorTabTextActive,
                ]}
              >
                FRONT CAMERA
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.selectorTab, cameraPosition === 'back' && styles.selectorTabActive]}
              onPress={() => handleSwitchCamera('back')}
            >
              <Text
                style={[
                  styles.selectorTabText,
                  cameraPosition === 'back' && styles.selectorTabTextActive,
                ]}
              >
                REAR CAMERA
              </Text>
            </TouchableOpacity>
          </View>

          {/* Diagnostic Overlay Sheet */}
          <View style={styles.diagnosticsContainer}>
            <TouchableOpacity
              style={styles.diagnosticsHeader}
              onPress={() => setShowDiagnostics((prev) => !prev)}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <Cpu size={16} color="#2e6b57" style={{ marginRight: 6 }} />
                <Text style={styles.diagnosticsTitle}>Perception Telemetry</Text>
              </View>
              {showDiagnostics ? (
                <ChevronDown size={18} color="#756d82" />
              ) : (
                <ChevronUp size={18} color="#756d82" />
              )}
            </TouchableOpacity>

            {showDiagnostics && (
              <View style={styles.diagnosticsContent}>
                <View style={styles.diagRow}>
                  <Text style={styles.diagLabel}>Device Hardware:</Text>
                  <Text style={styles.diagValue}>
                    {Device.modelName
                      ? `${Device.manufacturer || ''} ${Device.modelName}`.trim()
                      : 'Android Device'}
                  </Text>
                </View>

                <View style={styles.diagRow}>
                  <Text style={styles.diagLabel}>Active Camera:</Text>
                  <Text style={styles.diagValue}>
                    {cameraPosition.toUpperCase()} {device ? `(${device.name})` : ''}
                  </Text>
                </View>

                <View style={styles.diagRow}>
                  <Text style={styles.diagLabel}>Stream Resolution:</Text>
                  <Text style={styles.diagValue}>
                    {format
                      ? `${format.videoWidth}×${format.videoHeight} @ ${format.maxFps} FPS`
                      : 'Auto / Default'}
                  </Text>
                </View>

                <View style={styles.diagRow}>
                  <Text style={styles.diagLabel}>Lifecycle State:</Text>
                  <Text
                    style={[
                      styles.diagValue,
                      { color: effectiveCameraActive ? '#2e6b57' : '#d65f57' },
                    ]}
                  >
                    {effectiveCameraActive
                      ? 'STREAMING (FOREGROUND)'
                      : isForeground
                      ? 'INACTIVE'
                      : 'PAUSED (BACKGROUND)'}
                  </Text>
                </View>

                <View style={styles.diagRow}>
                  <Text style={styles.diagLabel}>Switch Latency:</Text>
                  <Text style={styles.diagValue}>
                    {switchLatency !== null ? `${switchLatency} ms` : 'Initial Mount'}
                  </Text>
                </View>

                <View style={styles.diagRow}>
                  <Text style={styles.diagLabel}>Sensor Orientation:</Text>
                  <Text style={styles.diagValue}>
                    {device?.sensorOrientation !== undefined
                      ? `${device.sensorOrientation}°`
                      : 'N/A'}
                  </Text>
                </View>

                <View style={styles.diagRow}>
                  <Text style={styles.diagLabel}>Safe Area Insets:</Text>
                  <Text style={styles.diagValue}>
                    Top: {Math.round(insets.top)}dp · Bottom: {Math.round(insets.bottom)}dp
                  </Text>
                </View>
              </View>
            )}
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0e13',
  },
  cameraContainer: {
    flex: 1,
    position: 'relative',
    backgroundColor: '#000000',
  },
  fallbackContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: '#1b1722',
  },
  permissionCard: {
    backgroundColor: '#2a2338',
    borderRadius: 24,
    padding: 24,
    alignItems: 'center',
    maxWidth: 340,
    borderWidth: 1,
    borderColor: '#3e3450',
  },
  fallbackTitle: {
    color: '#ffffff',
    fontSize: 18,
    fontWeight: '700',
    marginTop: 16,
    marginBottom: 8,
    textAlign: 'center',
  },
  fallbackText: {
    color: '#b0a9bd',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 20,
  },
  primaryButton: {
    backgroundColor: '#2e6b57',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 14,
    width: '100%',
    alignItems: 'center',
  },
  primaryButtonText: {
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 15,
  },
  settingsButton: {
    backgroundColor: '#40384f',
    paddingHorizontal: 20,
    paddingVertical: 11,
    borderRadius: 14,
    marginTop: 10,
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#594e6e',
  },
  settingsButtonText: {
    color: '#ffffff',
    fontWeight: '500',
    fontSize: 14,
  },
  topOverlay: {
    position: 'absolute',
    top: 16,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    zIndex: 10,
  },
  iconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(26, 22, 34, 0.75)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
  },
  titleBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(26, 22, 34, 0.85)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 9999,
    borderWidth: 1,
    borderColor: 'rgba(240, 168, 104, 0.4)',
  },
  titleBadgeText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
  },
  bottomOverlay: {
    position: 'absolute',
    bottom: 24,
    left: 16,
    right: 16,
    zIndex: 10,
  },
  selectorBar: {
    flexDirection: 'row',
    backgroundColor: 'rgba(26, 22, 34, 0.88)',
    borderRadius: 16,
    padding: 4,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  selectorTab: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 12,
  },
  selectorTabActive: {
    backgroundColor: '#2e6b57',
  },
  selectorTabText: {
    color: '#8e869e',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  selectorTabTextActive: {
    color: '#ffffff',
  },
  diagnosticsContainer: {
    backgroundColor: '#ffffff',
    borderRadius: 20,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 8,
  },
  diagnosticsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
    backgroundColor: '#fbf6ee',
    borderBottomWidth: 1,
    borderBottomColor: '#efe7da',
  },
  diagnosticsTitle: {
    color: '#2a2338',
    fontSize: 14,
    fontWeight: '700',
  },
  diagnosticsContent: {
    padding: 14,
    gap: 6,
  },
  diagRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  diagLabel: {
    color: '#756d82',
    fontSize: 12,
    fontWeight: '500',
  },
  diagValue: {
    color: '#2a2338',
    fontSize: 12,
    fontWeight: '600',
  },
});
