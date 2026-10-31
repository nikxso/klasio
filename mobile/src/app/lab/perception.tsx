import React, { useState, useEffect, useMemo } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  AppState,
  AppStateStatus,
  Linking,
  ActivityIndicator,
} from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
} from 'react-native-vision-camera';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Device from 'expo-device';
import { Brand } from '@/constants/brand';
import {
  Camera as SwitchCamera,
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  ShieldAlert,
  Activity,
  Cpu,
  Settings,
  Layers,
} from 'lucide-react-native';
import {
  selectBestPreviewFormat,
  enumerateDeviceFormats,
  ANALYSIS_RESOLUTIONS,
} from '../../perception/cameraFormatPolicy';

export default function PerceptionLabScreen() {
  const { hasPermission, requestPermission } = useCameraPermission();
  const [cameraPosition, setCameraPosition] = useState<'back' | 'front'>('back');
  const [formatPreference, setFormatPreference] = useState<'auto' | '1080p' | '720p'>('auto');
  const [analysisPreference, setAnalysisPreference] = useState<'STANDARD_640' | 'LIGHTWEIGHT_320'>('STANDARD_640');
  const [showDiagnostics, setShowDiagnostics] = useState<boolean>(true);
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const [switchLatency, setSwitchLatency] = useState<number | null>(null);
  const [permissionDeniedCount, setPermissionDeniedCount] = useState<number>(0);

  const insets = useSafeAreaInsets();
  const router = useRouter();

  // Enumerate both camera devices
  const backDevice = useCameraDevice('back');
  const frontDevice = useCameraDevice('front');
  const device = cameraPosition === 'back' ? backDevice : frontDevice;

  // Log complete capability tables for both hardware sensors
  useEffect(() => {
    if (backDevice) {
      const backCaps = enumerateDeviceFormats(backDevice);
      console.log(
        '[CAMERA_FORMATS_BACK_ENUM]',
        JSON.stringify(
          {
            deviceId: backDevice.id,
            name: backDevice.name,
            totalFormats: backCaps.length,
            formats: backCaps.map((c) => ({
              resolution: `${c.videoWidth}x${c.videoHeight}`,
              aspectRatio: `${c.aspectRatioLabel} (${c.aspectRatioNumeric})`,
              fps: `${c.minFps}-${c.maxFps}`,
              frameDurationMs: c.frameDurationMs,
              photoResolution: `${c.photoWidth}x${c.photoHeight}`,
              autoFocus: c.autoFocusSystem,
              videoHdr: c.supportsVideoHdr,
            })),
          },
          null,
          2
        )
      );
    }
  }, [backDevice]);

  useEffect(() => {
    if (frontDevice) {
      const frontCaps = enumerateDeviceFormats(frontDevice);
      console.log(
        '[CAMERA_FORMATS_FRONT_ENUM]',
        JSON.stringify(
          {
            deviceId: frontDevice.id,
            name: frontDevice.name,
            totalFormats: frontCaps.length,
            formats: frontCaps.map((c) => ({
              resolution: `${c.videoWidth}x${c.videoHeight}`,
              aspectRatio: `${c.aspectRatioLabel} (${c.aspectRatioNumeric})`,
              fps: `${c.minFps}-${c.maxFps}`,
              frameDurationMs: c.frameDurationMs,
              photoResolution: `${c.photoWidth}x${c.photoHeight}`,
              autoFocus: c.autoFocusSystem,
              videoHdr: c.supportsVideoHdr,
            })),
          },
          null,
          2
        )
      );
    }
  }, [frontDevice]);

  // Dynamic preview format selected according to documented capability policy
  const policyDecision = useMemo(() => {
    if (!device) return null;
    return selectBestPreviewFormat(
      device,
      formatPreference,
      ANALYSIS_RESOLUTIONS[analysisPreference]
    );
  }, [device, formatPreference, analysisPreference]);

  const format = policyDecision?.selectedFormat;

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
        {hasPermission && device != null && format != null ? (
          <Camera
            key={`${device.id}-${format.videoWidth}x${format.videoHeight}`}
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
                  {Brand.name} ML Lab requires camera access to validate the on-device perception pipeline.
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
                {/* Format Preference Pill Bar */}
                <View style={styles.preferenceRow}>
                  <Text style={styles.preferenceLabel}>Format Policy:</Text>
                  <View style={styles.pillGroup}>
                    {(['auto', '1080p', '720p'] as const).map((pref) => (
                      <TouchableOpacity
                        key={pref}
                        style={[
                          styles.pillButton,
                          formatPreference === pref && styles.pillButtonActive,
                        ]}
                        onPress={() => setFormatPreference(pref)}
                      >
                        <Text
                          style={[
                            styles.pillButtonText,
                            formatPreference === pref && styles.pillButtonTextActive,
                          ]}
                        >
                          {pref.toUpperCase()}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>

                {/* ML Analysis Target Resolution Pill Bar */}
                <View style={styles.preferenceRow}>
                  <Text style={styles.preferenceLabel}>ML Target:</Text>
                  <View style={styles.pillGroup}>
                    {(['STANDARD_640', 'LIGHTWEIGHT_320'] as const).map((key) => (
                      <TouchableOpacity
                        key={key}
                        style={[
                          styles.pillButton,
                          analysisPreference === key && styles.pillButtonActive,
                        ]}
                        onPress={() => setAnalysisPreference(key)}
                      >
                        <Text
                          style={[
                            styles.pillButtonText,
                            analysisPreference === key && styles.pillButtonTextActive,
                          ]}
                        >
                          {key === 'STANDARD_640' ? '640×640' : '320×320'}
                        </Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                </View>

                {/* Camera Name / ID */}
                <View style={styles.diagRow}>
                  <Text style={styles.diagLabel}>Camera:</Text>
                  <Text style={styles.diagValue}>
                    {cameraPosition.toUpperCase()} ({device ? device.name || device.id : 'N/A'})
                  </Text>
                </View>

                {/* Resolution */}
                <View style={styles.diagRow}>
                  <Text style={styles.diagLabel}>Resolution:</Text>
                  <Text style={[styles.diagValue, { color: '#2e6b57', fontWeight: '700' }]}>
                    {policyDecision
                      ? `${policyDecision.selectedCapability.videoWidth} × ${policyDecision.selectedCapability.videoHeight}`
                      : 'N/A'}
                  </Text>
                </View>

                {/* FPS */}
                <View style={styles.diagRow}>
                  <Text style={styles.diagLabel}>FPS:</Text>
                  <Text style={styles.diagValue}>
                    {policyDecision
                      ? `${policyDecision.selectedCapability.maxFps} FPS (${policyDecision.selectedCapability.minFps}-${policyDecision.selectedCapability.maxFps})`
                      : 'N/A'}
                  </Text>
                </View>

                {/* Aspect Ratio */}
                <View style={styles.diagRow}>
                  <Text style={styles.diagLabel}>Aspect Ratio:</Text>
                  <Text style={styles.diagValue}>
                    {policyDecision
                      ? `${policyDecision.selectedCapability.aspectRatioLabel} (${policyDecision.selectedCapability.aspectRatioNumeric})`
                      : 'N/A'}
                  </Text>
                </View>

                {/* ML Analysis Resolution */}
                <View style={styles.diagRow}>
                  <Text style={styles.diagLabel}>Analysis Resolution:</Text>
                  <Text style={[styles.diagValue, { color: '#c47d3b', fontWeight: '600' }]}>
                    {policyDecision
                      ? `${policyDecision.analysisConfig.targetWidth} × ${policyDecision.analysisConfig.targetHeight} (Decoupled)`
                      : 'N/A'}
                  </Text>
                </View>

                {/* Policy Detail */}
                <View style={styles.diagRow}>
                  <Text style={styles.diagLabel}>Policy Detail:</Text>
                  <Text style={[styles.diagValue, { fontSize: 11, maxWidth: '60%' }]} numberOfLines={1}>
                    {policyDecision?.policyReason || 'Default'}
                  </Text>
                </View>

                {/* Lifecycle State */}
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

                {/* Switch Latency */}
                <View style={styles.diagRow}>
                  <Text style={styles.diagLabel}>Switch Latency:</Text>
                  <Text style={styles.diagValue}>
                    {switchLatency !== null ? `${switchLatency} ms` : 'Initial Mount'}
                  </Text>
                </View>

                {/* Safe Area Insets */}
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
    marginBottom: 10,
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
    paddingVertical: 10,
    backgroundColor: '#fbf6ee',
    borderBottomWidth: 1,
    borderBottomColor: '#efe7da',
  },
  diagnosticsTitle: {
    color: '#2a2338',
    fontSize: 13,
    fontWeight: '700',
  },
  diagnosticsContent: {
    padding: 12,
    gap: 5,
  },
  preferenceRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
    paddingBottom: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#f0ece1',
  },
  preferenceLabel: {
    color: '#756d82',
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  pillGroup: {
    flexDirection: 'row',
    gap: 4,
  },
  pillButton: {
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 8,
    backgroundColor: '#ede7f6',
  },
  pillButtonActive: {
    backgroundColor: '#2e6b57',
  },
  pillButtonText: {
    fontSize: 11,
    color: '#5e4e75',
    fontWeight: '600',
  },
  pillButtonTextActive: {
    color: '#ffffff',
  },
  diagRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  diagLabel: {
    color: '#756d82',
    fontSize: 11.5,
    fontWeight: '500',
  },
  diagValue: {
    color: '#2a2338',
    fontSize: 11.5,
    fontWeight: '600',
  },
});
