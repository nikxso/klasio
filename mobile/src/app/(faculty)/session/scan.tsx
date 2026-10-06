import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Pressable,
  AppState,
  AppStateStatus,
  Linking,
  ActivityIndicator,
  Animated,
  Dimensions,
  Platform,
} from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
} from 'react-native-vision-camera';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import {
  X,
  Pause,
  Play,
  Camera as SwitchCamera,
  Check,
  AlertCircle,
  ShieldAlert,
  RotateCw,
  Settings,
  ChevronDown,
  ChevronUp,
  ScanFace,
  Cpu,
} from 'lucide-react-native';
import { Colors, Radii } from '@/theme/tokens';
import {
  selectBestPreviewFormat,
  ANALYSIS_RESOLUTIONS,
  FormattedCapability,
} from '@/perception/cameraFormatPolicy';
import type { FaceDetectionResult } from '@/perception/contracts';

interface DetectedFaceBox {
  id: string;
  x: number; // percentage [0, 100] or relative
  y: number;
  width: number;
  height: number;
  confidence: number;
  isRecognised?: boolean;
}

export default function FacultyScanningScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    sectionId?: string;
    subject?: string;
    section?: string;
    room?: string;
  }>();

  const insets = useSafeAreaInsets();
  const { hasPermission, requestPermission } = useCameraPermission();

  // Camera and sensor state
  const [cameraPosition, setCameraPosition] = useState<'back' | 'front'>('back');
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [permissionDeniedCount, setPermissionDeniedCount] = useState<number>(0);
  const [isRequestingPermission, setIsRequestingPermission] = useState<boolean>(false);

  // Perception / Detector state
  const [activeDetector, setActiveDetector] = useState<'YuNet' | 'SCRFD-500M'>('YuNet');
  const [detectedFaces, setDetectedFaces] = useState<DetectedFaceBox[]>([]);
  const [detectionLatencyMs, setDetectionLatencyMs] = useState<number>(0);
  const [detectionCadenceFps, setDetectionCadenceFps] = useState<number>(6);
  const [recognizedCount, setRecognizedCount] = useState<number>(0);
  const totalStudents = 24; // Standard class roster count

  // Viewfinder layout metrics for coordinate mapping
  const [viewfinderLayout, setViewfinderLayout] = useState<{ width: number; height: number }>({
    width: Dimensions.get('window').width,
    height: Math.round(Dimensions.get('window').height * 0.65),
  });

  // Diagnostics panel visibility
  const [showDiagnostics, setShowDiagnostics] = useState<boolean>(false);

  // Scanline animation
  const scanlineAnim = useRef(new Animated.Value(0)).current;

  // Camera devices
  const backDevice = useCameraDevice('back');
  const frontDevice = useCameraDevice('front');
  const device = cameraPosition === 'back' ? backDevice : frontDevice;

  // Dynamic preview format policy
  const policyDecision = useMemo(() => {
    if (!device) return null;
    return selectBestPreviewFormat(device, 'auto', ANALYSIS_RESOLUTIONS.STANDARD_640);
  }, [device]);

  const format = policyDecision?.selectedFormat;

  // Scanline animation loop
  useEffect(() => {
    if (isPaused) return;

    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(scanlineAnim, {
          toValue: 1,
          duration: 2400,
          useNativeDriver: true,
        }),
        Animated.timing(scanlineAnim, {
          toValue: 0,
          duration: 2400,
          useNativeDriver: true,
        }),
      ])
    );
    anim.start();

    return () => anim.stop();
  }, [isPaused, scanlineAnim]);

  // Handle AppState (background / foreground)
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      setAppState(next);
    });
    return () => subscription.remove();
  }, []);

  // Request camera permission on mount if not granted
  useEffect(() => {
    if (!hasPermission && permissionDeniedCount === 0) {
      handleRequestPermission();
    }
  }, [hasPermission]);

  const handleRequestPermission = async () => {
    setIsRequestingPermission(true);
    try {
      const granted = await requestPermission();
      if (!granted) {
        setPermissionDeniedCount((prev) => prev + 1);
      } else {
        setCameraError(null);
      }
    } catch (err: any) {
      setCameraError(err?.message || 'Permission request failed');
    } finally {
      setIsRequestingPermission(false);
    }
  };

  const handleTogglePause = () => {
    setIsPaused((prev) => !prev);
  };

  const handleSwitchCamera = () => {
    setCameraPosition((prev) => (prev === 'back' ? 'front' : 'back'));
  };

  const handleCameraError = useCallback((error: any) => {
    console.error('[VisionCamera Error]:', error);
    setCameraError(error?.message || 'Camera capture failed');
  }, []);

  const handleDone = () => {
    router.replace({
      pathname: '/(faculty)/section/[id]',
      params: {
        id: params.sectionId || '1',
        subject: params.subject || 'Data Structures',
        section: params.section || 'CSE 3A',
        room: params.room || 'LH-204',
        initialMode: 'review',
      },
    });
  };

  const isForeground = appState === 'active' || appState === 'unknown';
  const isCameraActive = isForeground && hasPermission && !isPaused && cameraError === null;

  const scanlineTranslateY = scanlineAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [20, viewfinderLayout.height - 40],
  });

  return (
    <View style={styles.container}>
      <StatusBar style="light" />

      {/* Main Viewfinder Section */}
      <View
        style={styles.viewfinderContainer}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          setViewfinderLayout({ width, height });
        }}
      >
        {hasPermission && device != null && format != null && !cameraError ? (
          <>
            <Camera
              key={`${device.id}-${format.videoWidth}x${format.videoHeight}`}
              style={StyleSheet.absoluteFill}
              device={device}
              format={format}
              isActive={isCameraActive}
              photo={false}
              video={false}
              audio={false}
              onError={handleCameraError}
            />

            {/* Gradient Darkening Vignette */}
            <View style={styles.gradientTop} />
            <View style={styles.gradientBottom} />

            {/* Glowing Scanline Animation */}
            {!isPaused && (
              <Animated.View
                style={[
                  styles.scanline,
                  {
                    transform: [{ translateY: scanlineTranslateY }],
                  },
                ]}
              />
            )}

            {/* Detected Face Bounding Box Overlays */}
            {detectedFaces.map((face) => (
              <View
                key={face.id}
                style={[
                  styles.boundingBox,
                  face.isRecognised ? styles.boxRecognised : styles.boxDetecting,
                  {
                    left: `${face.x}%`,
                    top: `${face.y}%`,
                    width: `${face.width}%`,
                    height: `${face.height}%`,
                  },
                ]}
              >
                {face.isRecognised && (
                  <View style={styles.checkBadge}>
                    <Check size={11} color="#1f1a29" strokeWidth={3} />
                  </View>
                )}
                <View style={styles.confidenceTag}>
                  <Text style={styles.confidenceText}>
                    {activeDetector === 'YuNet' ? 'YuNet' : 'SCRFD'}{' '}
                    {Math.round(face.confidence * 100)}%
                  </Text>
                </View>
              </View>
            ))}
          </>
        ) : (
          <View style={styles.fallbackContainer}>
            {!hasPermission ? (
              <View style={styles.fallbackCard}>
                <ShieldAlert size={44} color="#d65f57" style={{ marginBottom: 12 }} />
                <Text style={styles.fallbackTitle}>Camera Permission Required</Text>
                <Text style={styles.fallbackDescription}>
                  Attendly needs camera access to perform on-device face perception during class attendance.
                </Text>
                <TouchableOpacity
                  style={styles.actionButton}
                  onPress={handleRequestPermission}
                  disabled={isRequestingPermission}
                >
                  {isRequestingPermission ? (
                    <ActivityIndicator size="small" color="#ffffff" />
                  ) : (
                    <Text style={styles.actionButtonText}>Grant Permission</Text>
                  )}
                </TouchableOpacity>

                {permissionDeniedCount >= 1 && (
                  <TouchableOpacity
                    style={styles.secondaryButton}
                    onPress={() => Linking.openSettings()}
                  >
                    <Settings size={16} color="#ffffff" style={{ marginRight: 6 }} />
                    <Text style={styles.secondaryButtonText}>Open System Settings</Text>
                  </TouchableOpacity>
                )}
              </View>
            ) : cameraError != null ? (
              <View style={styles.fallbackCard}>
                <AlertCircle size={44} color="#d65f57" style={{ marginBottom: 12 }} />
                <Text style={styles.fallbackTitle}>Camera Unavailable</Text>
                <Text style={styles.fallbackDescription}>{cameraError}</Text>
                <TouchableOpacity
                  style={styles.actionButton}
                  onPress={() => {
                    setCameraError(null);
                    handleRequestPermission();
                  }}
                >
                  <RotateCw size={16} color="#ffffff" style={{ marginRight: 6 }} />
                  <Text style={styles.actionButtonText}>Retry Camera</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.fallbackCard}>
                <ActivityIndicator size="large" color="#7fd1ad" />
                <Text style={styles.fallbackTitle}>Opening Sensor Stream...</Text>
                <Text style={styles.fallbackDescription}>
                  {device == null
                    ? `No ${cameraPosition} camera hardware found.`
                    : 'Negotiating high-definition preview...'}
                </Text>
              </View>
            )}
          </View>
        )}

        {/* Top Header Floating Controls */}
        <View
          style={[
            styles.topHeader,
            {
              top: insets.top + 8,
              left: Math.max(insets.left, 16),
              right: Math.max(insets.right, 16),
            },
          ]}
        >
          {/* Close Button */}
          <TouchableOpacity
            style={styles.circleIconButton}
            onPress={() => router.back()}
            accessibilityLabel="Close scanning"
          >
            <X size={20} color="#ffffff" />
          </TouchableOpacity>

          {/* Subject & Section Badge */}
          <View style={styles.headerTitleContainer}>
            <Text style={styles.headerSubject} numberOfLines={1}>
              {params.subject || 'Data Structures'}
            </Text>
            <Text style={styles.headerSection}>
              {params.section || 'CSE 3A'} · {params.room || 'LH-204'}
            </Text>
          </View>

          {/* Right Action Icons: Flip Camera & Pause */}
          <View style={styles.headerRightGroup}>
            <TouchableOpacity
              style={styles.circleIconButton}
              onPress={handleSwitchCamera}
              accessibilityLabel="Switch camera"
            >
              <SwitchCamera size={18} color="#ffffff" />
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.circleIconButton, isPaused && styles.circleIconActive]}
              onPress={handleTogglePause}
              accessibilityLabel={isPaused ? 'Resume scanning' : 'Pause scanning'}
            >
              {isPaused ? <Play size={18} color="#ffffff" /> : <Pause size={18} color="#ffffff" />}
            </TouchableOpacity>
          </View>
        </View>
      </View>

      {/* Bottom Control & Status Panel */}
      <View
        style={[
          styles.bottomPanel,
          {
            paddingBottom: Math.max(insets.bottom, 16) + 12,
            paddingLeft: Math.max(insets.left, 20),
            paddingRight: Math.max(insets.right, 20),
          },
        ]}
      >
        {/* Attendance Counter Display */}
        <View style={styles.counterRow}>
          <Text style={styles.counterBig}>{recognizedCount}</Text>
          <Text style={styles.counterTotal}> / {totalStudents}</Text>
        </View>

        {/* User Guidance Prompt */}
        <Text style={styles.guidanceText}>
          {isPaused
            ? 'Camera paused — tap play to resume'
            : 'Slowly pan across the room to spot students…'}
        </Text>

        {/* Finish Scanning Button */}
        <TouchableOpacity
          style={styles.doneButton}
          onPress={handleDone}
          activeOpacity={0.88}
        >
          <Text style={styles.doneButtonText}>Done — check the list</Text>
        </TouchableOpacity>

        {/* Developer Diagnostics Sheet Accordion */}
        <View style={styles.diagnosticsAccordion}>
          <TouchableOpacity
            style={styles.diagHeader}
            onPress={() => setShowDiagnostics((prev) => !prev)}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
              <Cpu size={14} color="#7fd1ad" style={{ marginRight: 6 }} />
              <Text style={styles.diagHeaderTitle}>Perception Telemetry</Text>
            </View>
            {showDiagnostics ? (
              <ChevronDown size={16} color="#b0a9bd" />
            ) : (
              <ChevronUp size={16} color="#b0a9bd" />
            )}
          </TouchableOpacity>

          {showDiagnostics && (
            <View style={styles.diagContent}>
              {/* Detector Switcher */}
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Detector Candidate:</Text>
                <View style={styles.pillGroup}>
                  {(['YuNet', 'SCRFD-500M'] as const).map((det) => (
                    <TouchableOpacity
                      key={det}
                      style={[
                        styles.diagPill,
                        activeDetector === det && styles.diagPillActive,
                      ]}
                      onPress={() => setActiveDetector(det)}
                    >
                      <Text
                        style={[
                          styles.diagPillText,
                          activeDetector === det && styles.diagPillTextActive,
                        ]}
                      >
                        {det}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {/* Camera Name */}
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Camera:</Text>
                <Text style={styles.diagVal}>
                  {cameraPosition.toUpperCase()} ({device ? device.name || device.id : 'N/A'})
                </Text>
              </View>

              {/* Preview Resolution */}
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Preview Resolution:</Text>
                <Text style={[styles.diagVal, { color: '#7fd1ad', fontWeight: '700' }]}>
                  {policyDecision
                    ? `${policyDecision.selectedCapability.videoWidth} × ${policyDecision.selectedCapability.videoHeight}`
                    : 'N/A'}
                </Text>
              </View>

              {/* Preview FPS */}
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Preview FPS:</Text>
                <Text style={styles.diagVal}>
                  {policyDecision
                    ? `${policyDecision.selectedCapability.maxFps} FPS`
                    : 'N/A'}
                </Text>
              </View>

              {/* Analysis Resolution */}
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Analysis Resolution:</Text>
                <Text style={[styles.diagVal, { color: '#f0a868', fontWeight: '600' }]}>
                  {policyDecision
                    ? `${policyDecision.analysisConfig.targetWidth} × ${policyDecision.analysisConfig.targetHeight} (Decoupled)`
                    : 'N/A'}
                </Text>
              </View>

              {/* Detector Latency */}
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Inference Latency:</Text>
                <Text style={styles.diagVal}>
                  {activeDetector === 'YuNet' ? '74.98 ms (Bench)' : '105.02 ms (Bench)'}
                </Text>
              </View>

              {/* Detection Cadence */}
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Detection Cadence:</Text>
                <Text style={styles.diagVal}>{detectionCadenceFps} FPS (Every 5th frame)</Text>
              </View>

              {/* Detected Faces */}
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Faces in Frame:</Text>
                <Text style={[styles.diagVal, { color: '#7fd1ad', fontWeight: '700' }]}>
                  {detectedFaces.length} detected
                </Text>
              </View>

              {/* Permission & Lifecycle */}
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Camera State:</Text>
                <Text
                  style={[
                    styles.diagVal,
                    { color: isCameraActive ? '#7fd1ad' : '#d65f57' },
                  ]}
                >
                  {isCameraActive ? 'STREAMING (30 FPS)' : isPaused ? 'PAUSED' : 'INACTIVE'}
                </Text>
              </View>

              {/* Perception Error State */}
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Perception Error:</Text>
                <Text style={styles.diagVal}>{cameraError || 'None'}</Text>
              </View>
            </View>
          )}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#1f1a29',
  },
  viewfinderContainer: {
    flex: 1,
    position: 'relative',
    backgroundColor: '#000000',
    borderBottomLeftRadius: 32,
    borderBottomRightRadius: 32,
    overflow: 'hidden',
  },
  gradientTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 120,
    backgroundColor: 'rgba(31, 26, 41, 0.65)',
  },
  gradientBottom: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 90,
    backgroundColor: 'rgba(31, 26, 41, 0.75)',
  },
  scanline: {
    position: 'absolute',
    left: 24,
    right: 24,
    height: 3,
    borderRadius: 2,
    backgroundColor: '#f0a868',
    shadowColor: '#f0a868',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.85,
    shadowRadius: 16,
    elevation: 8,
  },
  boundingBox: {
    position: 'absolute',
    borderRadius: 16,
    borderWidth: 2,
    alignItems: 'flex-start',
    justifyContent: 'flex-start',
  },
  boxRecognised: {
    borderColor: '#7fd1ad',
    backgroundColor: 'rgba(127, 209, 173, 0.12)',
  },
  boxDetecting: {
    borderColor: 'rgba(255, 255, 255, 0.65)',
    borderStyle: 'dashed',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  checkBadge: {
    position: 'absolute',
    bottom: -6,
    right: -6,
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: '#7fd1ad',
    alignItems: 'center',
    justifyContent: 'center',
  },
  confidenceTag: {
    position: 'absolute',
    top: -18,
    left: 4,
    backgroundColor: 'rgba(31, 26, 41, 0.85)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  confidenceText: {
    color: '#ffffff',
    fontSize: 9.5,
    fontWeight: '700',
  },
  topHeader: {
    position: 'absolute',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    zIndex: 10,
  },
  circleIconButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255, 255, 255, 0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  circleIconActive: {
    backgroundColor: '#f0a868',
  },
  headerTitleContainer: {
    alignItems: 'center',
    flex: 1,
    marginHorizontal: 12,
  },
  headerSubject: {
    color: '#ffffff',
    fontSize: 14.5,
    fontWeight: '700',
  },
  headerSection: {
    color: 'rgba(255, 255, 255, 0.72)',
    fontSize: 11.5,
    marginTop: 1,
  },
  headerRightGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  fallbackContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#1b1722',
  },
  fallbackCard: {
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
    marginBottom: 8,
    textAlign: 'center',
  },
  fallbackDescription: {
    color: '#b0a9bd',
    fontSize: 13.5,
    textAlign: 'center',
    marginBottom: 20,
    lineHeight: 19,
  },
  actionButton: {
    backgroundColor: '#2e6b57',
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 14,
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionButtonText: {
    color: '#ffffff',
    fontWeight: '600',
    fontSize: 14.5,
  },
  secondaryButton: {
    backgroundColor: '#40384f',
    paddingHorizontal: 18,
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
  secondaryButtonText: {
    color: '#ffffff',
    fontWeight: '500',
    fontSize: 13.5,
  },
  bottomPanel: {
    paddingTop: 16,
    alignItems: 'center',
  },
  counterRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
  },
  counterBig: {
    color: '#ffffff',
    fontSize: 44,
    fontWeight: '800',
    letterSpacing: -1,
  },
  counterTotal: {
    color: 'rgba(255, 255, 255, 0.45)',
    fontSize: 22,
    fontWeight: '600',
  },
  guidanceText: {
    color: 'rgba(255, 255, 255, 0.72)',
    fontSize: 13,
    marginTop: 4,
    marginBottom: 16,
    textAlign: 'center',
  },
  doneButton: {
    backgroundColor: '#f0a868',
    borderRadius: 16,
    paddingVertical: 14,
    width: '100%',
    alignItems: 'center',
    shadowColor: '#f0a868',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 6,
  },
  doneButtonText: {
    color: '#1f1a29',
    fontSize: 15.5,
    fontWeight: '700',
  },
  diagnosticsAccordion: {
    marginTop: 12,
    width: '100%',
    backgroundColor: '#272033',
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  diagHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#2f273d',
  },
  diagHeaderTitle: {
    color: '#ffffff',
    fontSize: 12.5,
    fontWeight: '700',
  },
  diagContent: {
    padding: 12,
    gap: 6,
  },
  diagRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  diagLabel: {
    color: '#b0a9bd',
    fontSize: 11.5,
    fontWeight: '500',
  },
  diagVal: {
    color: '#ffffff',
    fontSize: 11.5,
    fontWeight: '600',
  },
  pillGroup: {
    flexDirection: 'row',
    gap: 4,
  },
  diagPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: '#3b324d',
  },
  diagPillActive: {
    backgroundColor: '#2e6b57',
  },
  diagPillText: {
    fontSize: 10.5,
    color: '#b0a9bd',
    fontWeight: '600',
  },
  diagPillTextActive: {
    color: '#ffffff',
  },
});
