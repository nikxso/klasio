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
  findNodeHandle,
  LogBox,
  ScrollView,
} from 'react-native';

LogBox.ignoreAllLogs(true);

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
  Focus,
  RotateCcw,
} from 'lucide-react-native';
import { Colors, Radii } from '@/theme/tokens';
import {
  selectBestPreviewFormat,
  ANALYSIS_RESOLUTIONS,
  FormattedCapability,
} from '@/perception/cameraFormatPolicy';
import type { FaceDetectionResult, RawFrame } from '@/perception/contracts';
import { DetailedPerceptionTimings } from '@/perception/perceptionClient';
import {
  YuNetDetector,
  SCRFDDetector,
  DirectOnDeviceDetector,
  TemporalCentroidTracker,
} from '@/lab';

interface DetectedFaceBox {
  id: string;
  trackId?: number;
  trackingState?: 'tentative' | 'confirmed' | 'coasting';
  isConfirmed?: boolean;
  frameId?: string;
  captureTimestampMs?: number;
  resultAgeMs?: number;
  isStale?: boolean;
  x: number; // percentage [0, 100]
  y: number;
  width: number;
  height: number;
  confidence: number;
  landmarks?: {
    leftEye: { x: number; y: number };
    rightEye: { x: number; y: number };
    noseTip: { x: number; y: number };
    mouthLeft: { x: number; y: number };
    mouthRight: { x: number; y: number };
  };
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
  const cameraRef = useRef<Camera>(null);
  const [cameraPosition, setCameraPosition] = useState<'back' | 'front'>('back');
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [permissionDeniedCount, setPermissionDeniedCount] = useState<number>(0);
  const [isRequestingPermission, setIsRequestingPermission] = useState<boolean>(false);

  // Foreground & active camera status
  const isForeground = appState === 'active' || appState === 'unknown';
  const isCameraActive = isForeground && hasPermission && !isPaused && cameraError === null;

  // Perception / Detector state
  const [activeDetector, setActiveDetector] = useState<'YuNet' | 'SCRFD-500M' | 'YuNet-InMemory'>('YuNet-InMemory');

  const [analysisPreference, setAnalysisPreference] = useState<'STANDARD_640' | 'LIGHTWEIGHT_320'>('STANDARD_640');
  const [detectedFaces, setDetectedFaces] = useState<DetectedFaceBox[]>([]);
  const [detectionLatencyMs, setDetectionLatencyMs] = useState<number>(0);
  const [detectionCadenceFps, setDetectionCadenceFps] = useState<number>(0);
  const [totalFramesAnalyzed, setTotalFramesAnalyzed] = useState<number>(0);
  const [detailedTimings, setDetailedTimings] = useState<DetailedPerceptionTimings | null>(null);

  // Tracking state (Step C — Live Face Tracking)
  const [isTrackingEnabled, setIsTrackingEnabled] = useState<boolean>(true);
  const [trackingCadenceFps, setTrackingCadenceFps] = useState<number>(0);
  const [trackerStats, setTrackerStats] = useState<{
    activeTracks: number;
    confirmedTracks: number;
    coastingTracks: number;
    tentativeTracks: number;
    totalCreated: number;
    totalRetired: number;
    lastStepDurationMs: number;
  }>({
    activeTracks: 0,
    confirmedTracks: 0,
    coastingTracks: 0,
    tentativeTracks: 0,
    totalCreated: 0,
    totalRetired: 0,
    lastStepDurationMs: 0,
  });

  // Frame sequence, queue, and latency state (Part A & C)
  const frameSeqRef = useRef<number>(0);
  const lastRenderedFrameSeqRef = useRef<number>(0);
  const inFlightCountRef = useRef<number>(0);
  const droppedFramesCountRef = useRef<number>(0);
  const staleFramesCountRef = useRef<number>(0);
  const staleClearTimerRef = useRef<any>(null);
  const activeTimerRef = useRef<any>(null);

  const [displayedFrameId, setDisplayedFrameId] = useState<string>('N/A');
  const [resultAgeMs, setResultAgeMs] = useState<number>(0);
  const [captureToResultMs, setCaptureToResultMs] = useState<number>(0);
  const [queueDepth, setQueueDepth] = useState<number>(0);
  const [droppedFramesCount, setDroppedFramesCount] = useState<number>(0);
  const [staleFramesCount, setStaleFramesCount] = useState<number>(0);

  // Viewfinder layout metrics for coordinate mapping
  const [viewfinderLayout, setViewfinderLayout] = useState<{ width: number; height: number }>({
    width: Dimensions.get('window').width,
    height: Math.round(Dimensions.get('window').height * 0.65),
  });

  // Diagnostics panel visibility
  const [showDiagnostics, setShowDiagnostics] = useState<boolean>(false);

  // Scanline animation
  const scanlineAnim = useRef(new Animated.Value(0)).current;

  // Detection loop refs
  const isDetectingRef = useRef(false);
  const lastFrameTimeRef = useRef(Date.now());

  // Camera devices
  const backDevice = useCameraDevice('back');
  const frontDevice = useCameraDevice('front');
  const device = cameraPosition === 'back' ? backDevice : frontDevice;

  // Camera Operator Controls: Zoom
  const [zoom, setZoom] = useState<number>(1.0);
  const minZoom = device?.minZoom ?? 1.0;
  const maxZoom = device?.maxZoom ?? 8.0;
  const neutralZoom = device?.neutralZoom ?? 1.0;

  // Reset zoom when camera device flips
  useEffect(() => {
    if (device) {
      setZoom(device.neutralZoom ?? 1.0);
    }
  }, [device?.id]);

  // Zoom preset levels based on device limits
  const zoomPresets = useMemo(() => {
    const presets = [1.0];
    if (maxZoom >= 2.0) presets.push(2.0);
    if (maxZoom >= 3.0) presets.push(3.0);
    if (maxZoom >= 5.0) presets.push(5.0);
    return presets;
  }, [maxZoom]);

  const handleSetZoom = useCallback(
    (targetZoom: number) => {
      const clamped = Math.max(minZoom, Math.min(maxZoom, targetZoom));
      setZoom(clamped);
    },
    [minZoom, maxZoom]
  );

  const handleResetZoom = useCallback(() => {
    setZoom(neutralZoom);
  }, [neutralZoom]);

  // Camera Operator Controls: Focus
  const [focusPoint, setFocusPoint] = useState<{ x: number; y: number; id: number } | null>(null);
  const [isManualFocus, setIsManualFocus] = useState<boolean>(false);
  const focusReticleAnim = useRef(new Animated.Value(0)).current;
  const autoFocusTimerRef = useRef<any>(null);

  // Tap-to-focus handler
  const handleTapToFocus = useCallback(
    async (event: any) => {
      if (!cameraRef.current || !isCameraActive) return;
      const { locationX, locationY } = event.nativeEvent;
      if (typeof locationX !== 'number' || typeof locationY !== 'number') return;

      const pointId = Date.now();
      setFocusPoint({ x: Math.round(locationX), y: Math.round(locationY), id: pointId });
      setIsManualFocus(true);

      // Trigger reticle spring + delay + fade animation
      focusReticleAnim.setValue(0);
      Animated.sequence([
        Animated.spring(focusReticleAnim, {
          toValue: 1,
          friction: 6,
          tension: 90,
          useNativeDriver: true,
        }),
        Animated.delay(1800),
        Animated.timing(focusReticleAnim, {
          toValue: 0,
          duration: 350,
          useNativeDriver: true,
        }),
      ]).start(() => {
        setFocusPoint((curr) => (curr?.id === pointId ? null : curr));
      });

      // Clear existing AF restore timer and reset manual focus flag after 3.5s
      if (autoFocusTimerRef.current) clearTimeout(autoFocusTimerRef.current);
      autoFocusTimerRef.current = setTimeout(() => {
        setIsManualFocus(false);
      }, 3500);

      try {
        await cameraRef.current.focus({ x: locationX, y: locationY });
      } catch (err: any) {
        console.warn('[VisionCamera Focus Error]:', err?.message);
      }
    },
    [isCameraActive, focusReticleAnim]
  );

  const handleResetAutoFocus = useCallback(() => {
    setIsManualFocus(false);
    setFocusPoint(null);
    if (autoFocusTimerRef.current) clearTimeout(autoFocusTimerRef.current);
    if (cameraRef.current && viewfinderLayout) {
      cameraRef.current
        .focus({
          x: viewfinderLayout.width / 2,
          y: viewfinderLayout.height / 2,
        })
        .catch(() => {});
    }
  }, [viewfinderLayout]);

  // Dynamic preview format policy
  const policyDecision = useMemo(() => {
    if (!device) return null;
    return selectBestPreviewFormat(
      device,
      'auto',
      ANALYSIS_RESOLUTIONS[analysisPreference]
    );
  }, [device, analysisPreference]);

  const format = policyDecision?.selectedFormat;

  // Swappable detector instances implementing IFaceDetector
  const yunetDetector = useMemo(
    () =>
      new YuNetDetector(
        0.35,
        0.3,
        policyDecision?.analysisConfig.targetWidth || 640,
        policyDecision?.analysisConfig.targetHeight || 640
      ),
    [policyDecision]
  );

  const scrfdDetector = useMemo(
    () =>
      new SCRFDDetector(
        0.30,
        0.4,
        policyDecision?.analysisConfig.targetWidth || 640,
        policyDecision?.analysisConfig.targetHeight || 640
      ),
    [policyDecision]
  );

  const directDetector = useMemo(
    () => new DirectOnDeviceDetector(null, 0.35),
    []
  );

  // Temporal Face Tracker (Step C — Live Face Tracking)
  const tracker = useMemo(
    () =>
      new TemporalCentroidTracker({
        iouThreshold: 0.30,
        centroidDistanceThreshold: 0.18,
        sizeRatioThreshold: 0.40,
        minHitsToConfirm: 2,
        maxCoastDurationMs: 850,
        smoothingAlpha: 0.40,
        velocityDamping: 0.92,
      }),
    []
  );


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

  // Continuous Decoupled Temporal Tracking Presentation Loop (~30 FPS)
  const lastTrackingTickRef = useRef<number>(Date.now());
  useEffect(() => {
    if (!isCameraActive || !isTrackingEnabled) {
      if (!isTrackingEnabled) {
        tracker.reset();
      }
      return;
    }

    let isMounted = true;

    const tickTracking = () => {
      if (!isMounted || !isCameraActive || !isTrackingEnabled) return;

      const now = Date.now();
      const dt = now - lastTrackingTickRef.current;
      lastTrackingTickRef.current = now;

      if (dt > 0) {
        const instFps = Math.min(60, Math.round(1000 / dt));
        setTrackingCadenceFps((prev) => (prev === 0 ? instFps : Math.round(prev * 0.8 + instFps * 0.2)));
      }

      const activeTracks = tracker.step(now);
      const stats = tracker.getDiagnostics();
      setTrackerStats(stats);

      const mapped: DetectedFaceBox[] = activeTracks.map((t) => {
        const b = t.boundingBox;
        const isCoasting = t.timeSinceLastSeenMs > 250;
        return {
          id: `track_${t.trackId}`,
          trackId: t.trackId,
          trackingState: isCoasting ? 'coasting' : t.isConfirmed ? 'confirmed' : 'tentative',
          isConfirmed: t.isConfirmed,
          confidence: t.confidence,
          x: Math.max(0, Math.min(100, b.x * 100)),
          y: Math.max(0, Math.min(100, b.y * 100)),
          width: Math.max(0, Math.min(100, b.width * 100)),
          height: Math.max(0, Math.min(100, b.height * 100)),
          landmarks: t.landmarks
            ? {
                leftEye: { x: t.landmarks.leftEye.x * 100, y: t.landmarks.leftEye.y * 100 },
                rightEye: { x: t.landmarks.rightEye.x * 100, y: t.landmarks.rightEye.y * 100 },
                noseTip: { x: t.landmarks.noseTip.x * 100, y: t.landmarks.noseTip.y * 100 },
                mouthLeft: { x: t.landmarks.mouthLeft.x * 100, y: t.landmarks.mouthLeft.y * 100 },
                mouthRight: { x: t.landmarks.mouthRight.x * 100, y: t.landmarks.mouthRight.y * 100 },
              }
            : undefined,
        };
      });

      setDetectedFaces(mapped);
    };

    const intervalId = setInterval(tickTracking, 33); // 30 FPS Presentation Ticker

    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, [isCameraActive, isTrackingEnabled, tracker]);

  // Continuous non-blocking face detection cycle
  useEffect(() => {
    if (!isCameraActive) {
      setDetectedFaces([]);
      return;
    }

    let isMounted = true;

    const runDetection = async () => {
      if (!isMounted || !isCameraActive) return;

      // STRICT CONCURRENCY CONTROL: Prevent in-flight queue growth (max 1 in-flight)
      if (isDetectingRef.current || inFlightCountRef.current > 0) {
        droppedFramesCountRef.current += 1;
        setDroppedFramesCount(droppedFramesCountRef.current);
        return;
      }

      isDetectingRef.current = true;
      inFlightCountRef.current = 1;
      setQueueDepth(1);

      const seq = ++frameSeqRef.current;
      const currentFrameId = `frame_${seq}`;
      const captureStart = performance.now();
      const captureStartWall = Date.now();

      try {
        if (cameraRef.current) {
          let detections: FaceDetectionResult[] = [];
          let timings: DetailedPerceptionTimings | undefined;
          let acquisitionMs = 0;

          if (activeDetector === 'YuNet-InMemory') {
            const nodeHandle = findNodeHandle(cameraRef.current);
            if (nodeHandle) {
              directDetector.setCameraTag(nodeHandle);
            }

            const rawFrame: RawFrame = {
              width: viewfinderLayout.width,
              height: viewfinderLayout.height,
              format: 'rgba',
              timestampMs: captureStartWall,
              captureTimestampMs: captureStartWall,
              data: '',
              rotationDegrees: 0,
              frameId: currentFrameId,
            };

            const directResult = await directDetector.detectFacesDetailed(rawFrame);
            detections = directResult.results;
            timings = directResult.timings;
            acquisitionMs = timings?.frameAcquisitionMs ?? 0;
          } else {
            const snap = await cameraRef.current.takeSnapshot({ quality: 80 });
            const captureEnd = performance.now();
            acquisitionMs = Math.round(captureEnd - captureStart);

            if (snap?.path && isMounted && isCameraActive) {
              const rawFrame: RawFrame = {
                width: snap.width,
                height: snap.height,
                format: 'jpeg',
                timestampMs: captureStartWall,
                captureTimestampMs: captureStartWall,
                data: snap.path,
                uri: 'file://' + snap.path,
                rotationDegrees: 0,
                frameId: currentFrameId,
              };

              const detector = activeDetector === 'YuNet' ? yunetDetector : scrfdDetector;
              const res = await detector.detectFacesDetailed(rawFrame);
              detections = res.results;
              timings = res.timings;
            } else {
              return;
            }
          }

          if (isMounted && isCameraActive) {
            // LATEST RESULT WINS: If a newer frame finished while this was in transit, drop it!
            if (seq <= lastRenderedFrameSeqRef.current) {
              staleFramesCountRef.current += 1;
              setStaleFramesCount(staleFramesCountRef.current);
              return;
            }

            const renderWallTime = Date.now();
            const totalE2EMs = Math.round(performance.now() - captureStart);
            const ageMs = Math.round(renderWallTime - captureStartWall);
            const capToResult = timings?.captureToResultLatencyMs ?? totalE2EMs;
            const isStale = ageMs > 500;

            lastRenderedFrameSeqRef.current = seq;
            setDisplayedFrameId(currentFrameId);
            setResultAgeMs(ageMs);
            setCaptureToResultMs(capToResult);
            console.log(
              `[PERCEPTION_FRAME] Mode: ${activeDetector} | Frame: ${currentFrameId} | Age: ${ageMs}ms | Cap2Res: ${capToResult}ms | ` +
              `E2E: ${totalE2EMs}ms | Queue: ${inFlightCountRef.current} | Dropped: ${droppedFramesCountRef.current} | Stale: ${staleFramesCountRef.current} | ` +
              `Faces: ${detections.length}`
            );

            if (isMounted) {
              const mapStart = performance.now();

              // DIRECT 1:1 COORDINATE MAPPING (Opposite-direction fix)
              // On Android VisionCamera, takeSnapshot() captures previewView.bitmap.
              // Front camera preview is already mirrored by CameraView; rear is unmirrored.
              // Hence, b.x directly aligns with the preview surface on BOTH front and rear cameras!
              const mappedBoxes: DetectedFaceBox[] = detections.map((d, index) => {
                const b = d.boundingBox;
                const xPct = b.x * 100;
                const yPct = b.y * 100;
                const wPct = b.width * 100;
                const hPct = b.height * 100;

                let mappedLandmarks: DetectedFaceBox['landmarks'] = undefined;
                if (d.landmarks) {
                  const lm = d.landmarks as any;
                  const leftEye = lm.leftEye || {};
                  const rightEye = lm.rightEye || {};
                  const noseTip = lm.noseTip || {};
                  const mouthLeft = lm.mouthLeft || lm.leftMouth || {};
                  const mouthRight = lm.mouthRight || lm.rightMouth || {};

                  mappedLandmarks = {
                    leftEye: {
                      x: (leftEye.x ?? 0) * 100,
                      y: (leftEye.y ?? 0) * 100,
                    },
                    rightEye: {
                      x: (rightEye.x ?? 0) * 100,
                      y: (rightEye.y ?? 0) * 100,
                    },
                    noseTip: {
                      x: (noseTip.x ?? 0) * 100,
                      y: (noseTip.y ?? 0) * 100,
                    },
                    mouthLeft: {
                      x: (mouthLeft.x ?? 0) * 100,
                      y: (mouthLeft.y ?? 0) * 100,
                    },
                    mouthRight: {
                      x: (mouthRight.x ?? 0) * 100,
                      y: (mouthRight.y ?? 0) * 100,
                    },
                  };
                }

                return {
                  id: `face_${index}_${Math.round(b.x * 1000)}`,
                  frameId: currentFrameId,
                  captureTimestampMs: captureStartWall,
                  resultAgeMs: ageMs,
                  isStale,
                  x: Math.max(0, Math.min(100, xPct)),
                  y: Math.max(0, Math.min(100, yPct)),
                  width: Math.max(0, Math.min(100, wPct)),
                  height: Math.max(0, Math.min(100, hPct)),
                  confidence: d.confidence,
                  landmarks: mappedLandmarks,
                };
              });

              if (mappedBoxes.length > 0) {
                console.log(
                  `[FACE_BOX] X: ${mappedBoxes[0].x.toFixed(1)}% | Y: ${mappedBoxes[0].y.toFixed(1)}% | ` +
                  `W: ${mappedBoxes[0].width.toFixed(1)}% | H: ${mappedBoxes[0].height.toFixed(1)}% | ` +
                  `Conf: ${(mappedBoxes[0].confidence * 100).toFixed(1)}%`
                );
              }

              const mapEnd = performance.now();
              const clientMappingMs = Math.round(mapEnd - mapStart);
              const inferMs = timings?.serverInferenceMs || (detections[0]?.latencyMs ?? 0);
              const overheadMs = Math.max(0, totalE2EMs - inferMs);

              setDetectionLatencyMs(totalE2EMs);
              setTotalFramesAnalyzed((prev) => prev + 1);

              const fullTimings: DetailedPerceptionTimings = {
                frameId: currentFrameId,
                captureTimestampMs: captureStartWall,
                clientSendTimestampMs: timings?.clientSendTimestampMs,
                clientReceiveTimestampMs: timings?.clientReceiveTimestampMs,
                captureToResultLatencyMs: capToResult,
                resultAgeWhenRenderedMs: ageMs,
                queueDepth: 0,
                isStale,
                frameAcquisitionMs: acquisitionMs,
                frameConversionMs: timings?.frameConversionMs ?? 0,
                networkRoundtripMs: timings?.networkRoundtripMs ?? 0,
                networkTransportMs: timings?.networkTransportMs ?? 0,
                serverPayloadReadMs: timings?.serverPayloadReadMs ?? 0,
                serverDecodeImageMs: timings?.serverDecodeImageMs ?? 0,
                serverPreprocessMs: timings?.serverPreprocessMs ?? 0,
                serverInferenceMs: inferMs,
                serverPostprocessMs: timings?.serverPostprocessMs ?? 0,
                serverTotalMs: timings?.serverTotalMs ?? 0,
                clientTotalMs: timings?.clientTotalMs ?? 0,
                clientResultHandlingMs: clientMappingMs,
                totalEndToEndMs: totalE2EMs,
                overheadOutsideInferenceMs: overheadMs,
              };
              setDetailedTimings(fullTimings);
              console.log(
                `[IN_MEMORY_BREAKDOWN] Detector: ${activeDetector} | Acq: ${fullTimings.frameAcquisitionMs}ms | Pre: ${fullTimings.serverPreprocessMs}ms | ` +
                `Infer: ${fullTimings.serverInferenceMs}ms | Post: ${fullTimings.serverPostprocessMs}ms | Map: ${fullTimings.clientResultHandlingMs}ms | ` +
                `E2E: ${fullTimings.totalEndToEndMs}ms | Age: ${fullTimings.resultAgeWhenRenderedMs}ms`
              );

              const now = Date.now();
              const deltaMs = now - lastFrameTimeRef.current;
              lastFrameTimeRef.current = now;
              if (deltaMs > 0) {
                const instantaneousFps = Math.min(30, Math.round(1000 / deltaMs));
                setDetectionCadenceFps((prev) =>
                  prev === 0 ? instantaneousFps : Math.round(prev * 0.7 + instantaneousFps * 0.3)
                );
              }

              // STEP C: Pass sparse detections to temporal tracker for rate decoupling
              if (isTrackingEnabled) {
                tracker.update(detections, captureStartWall);
                const currentStats = tracker.getDiagnostics();
                setTrackerStats(currentStats);
                console.log(
                  `[TRACKER_UPDATE] Mode: ${activeDetector} | Detections: ${detections.length} | ` +
                  `ActiveTracks: ${currentStats.activeTracks} (Conf: ${currentStats.confirmedTracks}, Coast: ${currentStats.coastingTracks}) | ` +
                  `Created: ${currentStats.totalCreated} | Retired: ${currentStats.totalRetired} | Step: ${currentStats.lastStepDurationMs}ms`
                );
              } else {
                setDetectedFaces(mappedBoxes);

                // Auto-clear stale boxes after 900ms if no new detections arrive
                if (staleClearTimerRef.current) clearTimeout(staleClearTimerRef.current);
                staleClearTimerRef.current = setTimeout(() => {
                  if (isMounted) {
                    setDetectedFaces([]);
                  }
                }, 900);
              }
            }
          }
        }
      } catch (err: any) {
        console.warn('[Detection Loop Warning]:', err?.message);
      } finally {
        isDetectingRef.current = false;
        inFlightCountRef.current = 0;
        setQueueDepth(0);
        if (isMounted && isCameraActive) {
          // Paced single-timer trigger: 25ms for in-memory on-device, 60ms for HTTP bridge
          const delayMs = activeDetector === 'YuNet-InMemory' ? 25 : 60;
          activeTimerRef.current = setTimeout(runDetection, delayMs);
        }
      }
    };

    activeTimerRef.current = setTimeout(runDetection, 300);

    return () => {
      isMounted = false;
      if (activeTimerRef.current) clearTimeout(activeTimerRef.current);
      if (staleClearTimerRef.current) clearTimeout(staleClearTimerRef.current);
    };
  }, [isCameraActive, activeDetector, cameraPosition, yunetDetector, scrfdDetector, directDetector, viewfinderLayout]);

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
              ref={cameraRef}
              key={`${device.id}-${format.videoWidth}x${format.videoHeight}`}
              style={StyleSheet.absoluteFill}
              device={device}
              format={format}
              isActive={isCameraActive}
              photo={false}
              video={false}
              audio={false}
              onError={handleCameraError}
              zoom={zoom}
              enableZoomGesture={true}
            />

            {/* Tap-to-focus gesture receiver over viewfinder */}
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={handleTapToFocus}
              accessibilityLabel="Tap viewfinder to focus"
            />

            {/* Gradient Darkening Vignette */}
            <View style={styles.gradientTop} pointerEvents="none" />
            <View style={styles.gradientBottom} pointerEvents="none" />

            {/* Glowing Scanline Animation */}
            {!isPaused && (
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.scanline,
                  {
                    transform: [{ translateY: scanlineTranslateY }],
                  },
                ]}
              />
            )}

            {/* Detected Face Bounding Box & Facial Landmark Overlays (Step C: Temporal Tracks) */}
            {detectedFaces.map((face) => (
              <React.Fragment key={face.id}>
                {/* Bounding Box */}
                <View
                  pointerEvents="none"
                  style={[
                    styles.boundingBox,
                    face.trackingState === 'coasting'
                      ? styles.boxCoasting
                      : face.isConfirmed
                      ? styles.boxConfirmed
                      : face.trackingState === 'tentative'
                      ? styles.boxTentative
                      : face.isStale
                      ? styles.boxStale
                      : styles.boxDetecting,
                    {
                      left: `${face.x}%`,
                      top: `${face.y}%`,
                      width: `${face.width}%`,
                      height: `${face.height}%`,
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.confidenceTag,
                      face.trackingState === 'coasting'
                        ? styles.confidenceTagCoasting
                        : face.isConfirmed
                        ? styles.confidenceTagConfirmed
                        : face.trackingState === 'tentative'
                        ? styles.confidenceTagTentative
                        : face.isStale
                        ? styles.confidenceTagStale
                        : null,
                    ]}
                  >
                    <Text style={styles.confidenceText} numberOfLines={1}>
                      {face.trackId != null
                        ? `Track #${face.trackId}${face.trackingState === 'coasting' ? ' [Coast]' : face.isConfirmed ? ' [Conf]' : ' [Tent]'}`
                        : activeDetector === 'YuNet'
                        ? 'YuNet'
                        : 'SCRFD'}
                      {` · ${Math.round(face.confidence * 100)}%`}
                    </Text>
                  </View>
                </View>

                {/* 5-Point Facial Landmarks (Eyes, Nose, Mouth Corners) */}
                {face.landmarks && (
                  <>
                    <View
                      pointerEvents="none"
                      style={[
                        styles.landmarkDot,
                        {
                          left: `${face.landmarks.leftEye.x}%`,
                          top: `${face.landmarks.leftEye.y}%`,
                        },
                      ]}
                    />
                    <View
                      pointerEvents="none"
                      style={[
                        styles.landmarkDot,
                        {
                          left: `${face.landmarks.rightEye.x}%`,
                          top: `${face.landmarks.rightEye.y}%`,
                        },
                      ]}
                    />
                    <View
                      pointerEvents="none"
                      style={[
                        styles.landmarkDot,
                        {
                          left: `${face.landmarks.noseTip.x}%`,
                          top: `${face.landmarks.noseTip.y}%`,
                        },
                      ]}
                    />
                    <View
                      pointerEvents="none"
                      style={[
                        styles.landmarkDot,
                        {
                          left: `${face.landmarks.mouthLeft.x}%`,
                          top: `${face.landmarks.mouthLeft.y}%`,
                        },
                      ]}
                    />
                    <View
                      pointerEvents="none"
                      style={[
                        styles.landmarkDot,
                        {
                          left: `${face.landmarks.mouthRight.x}%`,
                          top: `${face.landmarks.mouthRight.y}%`,
                        },
                      ]}
                    />
                  </>
                )}
              </React.Fragment>
            ))}

            {/* Animated Focus Reticle */}
            {focusPoint && (
              <Animated.View
                pointerEvents="none"
                style={[
                  styles.focusReticle,
                  {
                    left: focusPoint.x - 30,
                    top: focusPoint.y - 30,
                    opacity: focusReticleAnim,
                    transform: [
                      {
                        scale: focusReticleAnim.interpolate({
                          inputRange: [0, 1],
                          outputRange: [1.35, 1.0],
                        }),
                      },
                    ],
                  },
                ]}
              >
                <View style={styles.focusReticleInner} />
                <View style={styles.focusCornerTL} />
                <View style={styles.focusCornerTR} />
                <View style={styles.focusCornerBL} />
                <View style={styles.focusCornerBR} />
              </Animated.View>
            )}

            {/* Floating Camera Operator Controls Bar (Zoom & Focus) */}
            <View style={styles.floatingControlsBar}>
              {/* Zoom Presets */}
              <View style={styles.zoomPillGroup}>
                {zoomPresets.map((z) => {
                  const isActive = Math.abs(zoom - z) < 0.1;
                  return (
                    <TouchableOpacity
                      key={z}
                      style={[styles.zoomPill, isActive && styles.zoomPillActive]}
                      onPress={() => handleSetZoom(z)}
                      activeOpacity={0.8}
                    >
                      <Text style={[styles.zoomPillText, isActive && styles.zoomPillTextActive]}>
                        {z}×
                      </Text>
                    </TouchableOpacity>
                  );
                })}

                {zoom > neutralZoom && !zoomPresets.some((p) => Math.abs(p - zoom) < 0.1) && (
                  <View style={[styles.zoomPill, styles.zoomPillActive]}>
                    <Text style={[styles.zoomPillText, styles.zoomPillTextActive]}>
                      {zoom.toFixed(1)}×
                    </Text>
                  </View>
                )}
              </View>

              {/* Quick Action Chips: Reset Zoom or AutoFocus */}
              <View style={styles.quickActionGroup}>
                {Math.abs(zoom - neutralZoom) > 0.05 && (
                  <TouchableOpacity
                    style={styles.quickActionChip}
                    onPress={handleResetZoom}
                    activeOpacity={0.8}
                  >
                    <RotateCcw size={11} color="#f0a868" style={{ marginRight: 4 }} />
                    <Text style={styles.quickActionText}>1× Reset</Text>
                  </TouchableOpacity>
                )}

                {isManualFocus && (
                  <TouchableOpacity
                    style={styles.quickActionChip}
                    onPress={handleResetAutoFocus}
                    activeOpacity={0.8}
                  >
                    <Focus size={11} color="#7fd1ad" style={{ marginRight: 4 }} />
                    <Text style={styles.quickActionText}>Auto Focus</Text>
                  </TouchableOpacity>
                )}
              </View>
            </View>
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
        {/* Face Detection Counter Display */}
        <View style={styles.counterRow}>
          <Text style={styles.counterBig}>{detectedFaces.length}</Text>
          <Text style={styles.counterTotal}> faces localized</Text>
        </View>

        {/* User Guidance Prompt */}
        <Text style={styles.guidanceText}>
          {isPaused
            ? 'Camera paused — tap play to resume'
            : detectedFaces.length > 0
            ? `${detectedFaces.length} student face${detectedFaces.length > 1 ? 's' : ''} tracked in viewfinder`
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
            <ScrollView
              style={styles.diagScroll}
              contentContainerStyle={styles.diagContent}
              nestedScrollEnabled={true}
              showsVerticalScrollIndicator={true}
            >
              {/* Detector Switcher */}
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Detector Candidate:</Text>
                <View style={styles.pillGroup}>
                  {(['YuNet-InMemory', 'YuNet', 'SCRFD-500M'] as const).map((det) => (
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
                        {det === 'YuNet-InMemory' ? 'YuNet (In-Mem)' : det === 'YuNet' ? 'YuNet (HTTP)' : 'SCRFD (HTTP)'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {/* Tracking Mode Switcher (Step C) */}
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Tracking Mode:</Text>
                <View style={styles.pillGroup}>
                  <TouchableOpacity
                    style={[
                      styles.diagPill,
                      isTrackingEnabled && styles.diagPillActive,
                    ]}
                    onPress={() => setIsTrackingEnabled(true)}
                  >
                    <Text
                      style={[
                        styles.diagPillText,
                        isTrackingEnabled && styles.diagPillTextActive,
                      ]}
                    >
                      Temporal (30 FPS)
                    </Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={[
                      styles.diagPill,
                      !isTrackingEnabled && styles.diagPillActive,
                    ]}
                    onPress={() => setIsTrackingEnabled(false)}
                  >
                    <Text
                      style={[
                        styles.diagPillText,
                        !isTrackingEnabled && styles.diagPillTextActive,
                      ]}
                    >
                      Raw Detector (~3.5 FPS)
                    </Text>
                  </TouchableOpacity>
                </View>
              </View>

              {/* Analysis Resolution Preference Switcher */}
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Analysis Resolution:</Text>
                <View style={styles.pillGroup}>
                  {(['STANDARD_640', 'LIGHTWEIGHT_320'] as const).map((pref) => (
                    <TouchableOpacity
                      key={pref}
                      style={[
                        styles.diagPill,
                        analysisPreference === pref && styles.diagPillActive,
                      ]}
                      onPress={() => setAnalysisPreference(pref)}
                    >
                      <Text
                        style={[
                          styles.diagPillText,
                          analysisPreference === pref && styles.diagPillTextActive,
                        ]}
                      >
                        {pref === 'STANDARD_640' ? '640²' : '320²'}
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

              {/* Aspect Ratio */}
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Aspect Ratio:</Text>
                <Text style={styles.diagVal}>
                  {policyDecision ? policyDecision.selectedCapability.aspectRatioLabel : 'N/A'}
                </Text>
              </View>

              {/* Decoupled ML Analysis Resolution */}
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Decoupled ML Input:</Text>
                <Text style={[styles.diagVal, { color: '#f0a868', fontWeight: '600' }]}>
                  {policyDecision
                    ? `${policyDecision.analysisConfig.targetWidth} × ${policyDecision.analysisConfig.targetHeight}`
                    : 'N/A'}
                </Text>
              </View>

              {/* Zoom State */}
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Zoom Factor:</Text>
                <Text style={[styles.diagVal, { color: '#f0a868', fontWeight: '700' }]}>
                  {zoom.toFixed(1)}× (Range: {minZoom.toFixed(1)}× – {maxZoom.toFixed(1)}×)
                </Text>
              </View>

              {/* Focus State */}
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Focus Mode:</Text>
                <Text
                  style={[
                    styles.diagVal,
                    { color: isManualFocus ? '#f0a868' : '#7fd1ad', fontWeight: '600' },
                  ]}
                >
                  {isManualFocus
                    ? `Manual (${focusPoint ? `${focusPoint.x}, ${focusPoint.y}` : 'Locked'})`
                    : 'Continuous Auto'}
                </Text>
              </View>

              {/* Frame Sequencing & Real-Time Age Telemetry */}
              <View style={styles.diagDivider} />
              <Text style={styles.diagSectionTitle}>Frame Sequencing & Real-Time Age</Text>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Current Frame ID:</Text>
                <Text style={[styles.diagVal, { color: '#7fd1ad', fontWeight: '700' }]}>
                  {displayedFrameId}
                </Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Result Age when Rendered:</Text>
                <Text
                  style={[
                    styles.diagVal,
                    {
                      color:
                        resultAgeMs > 500
                          ? '#d65f57'
                          : resultAgeMs > 350
                          ? '#f0a868'
                          : '#7fd1ad',
                      fontWeight: '700',
                    },
                  ]}
                >
                  {resultAgeMs > 0
                    ? `${resultAgeMs} ms ${resultAgeMs > 500 ? '(STALE)' : '(FRESH)'}`
                    : 'Awaiting...'}
                </Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Capture-to-Result Latency:</Text>
                <Text style={[styles.diagVal, { color: '#f0a868', fontWeight: '600' }]}>
                  {captureToResultMs > 0 ? `${captureToResultMs} ms` : 'Awaiting...'}
                </Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>In-Flight Queue Depth:</Text>
                <Text style={[styles.diagVal, { color: queueDepth > 0 ? '#f0a868' : '#7fd1ad' }]}>
                  {queueDepth} / 1 (Strictly Bounded)
                </Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Dropped / Stale Frames:</Text>
                <Text style={styles.diagVal}>
                  {droppedFramesCount} dropped · {staleFramesCount} stale
                </Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Coordinate Alignment:</Text>
                <Text style={[styles.diagVal, { color: '#7fd1ad', fontWeight: '600' }]}>
                  1:1 Surface Aligned (Direct)
                </Text>
              </View>

              {/* Timing & Transport Breakdown Divider */}
              <View style={styles.diagDivider} />
              <Text style={styles.diagSectionTitle}>Perception Transport Breakdown</Text>

              {/* Total End-to-End Latency */}
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Total End-to-End Latency:</Text>
                <Text style={[styles.diagVal, { color: '#f0a868', fontWeight: '700' }]}>
                  {detailedTimings?.totalEndToEndMs
                    ? `${detailedTimings.totalEndToEndMs} ms`
                    : `${detectionLatencyMs} ms`}
                </Text>
              </View>

              {/* ONNX Inference Latency */}
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>ONNX Model Inference:</Text>
                <Text style={[styles.diagVal, { color: '#7fd1ad', fontWeight: '700' }]}>
                  {detailedTimings?.serverInferenceMs
                    ? `${detailedTimings.serverInferenceMs} ms`
                    : 'Awaiting...'}
                </Text>
              </View>

              {/* Non-Inference Overhead */}
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Non-Inference Overhead:</Text>
                <Text style={[styles.diagVal, { color: '#d65f57', fontWeight: '600' }]}>
                  {detailedTimings?.overheadOutsideInferenceMs != null
                    ? `${detailedTimings.overheadOutsideInferenceMs} ms`
                    : 'Awaiting...'}
                </Text>
              </View>

              {/* Detailed Sub-Stages */}
              <View style={styles.diagRow}>
                <Text style={styles.diagSubLabel}>↳ Frame Snap (GPU/Disk):</Text>
                <Text style={styles.diagSubVal}>
                  {detailedTimings?.frameAcquisitionMs != null
                    ? `${detailedTimings.frameAcquisitionMs} ms`
                    : 'N/A'}
                </Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagSubLabel}>↳ Frame Conv (Blob/FormData):</Text>
                <Text style={styles.diagSubVal}>
                  {detailedTimings?.frameConversionMs != null
                    ? `${detailedTimings.frameConversionMs} ms`
                    : 'N/A'}
                </Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagSubLabel}>↳ Bridge Transit (HTTP/Reverse):</Text>
                <Text style={styles.diagSubVal}>
                  {detailedTimings?.networkTransportMs != null
                    ? `${detailedTimings.networkTransportMs} ms`
                    : 'N/A'}
                </Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagSubLabel}>↳ Server Read & Decode (PIL):</Text>
                <Text style={styles.diagSubVal}>
                  {detailedTimings?.serverDecodeImageMs != null
                    ? `${Math.round((detailedTimings.serverPayloadReadMs + detailedTimings.serverDecodeImageMs) * 10) / 10} ms`
                    : 'N/A'}
                </Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagSubLabel}>↳ Server Preprocess (Resize/NP):</Text>
                <Text style={styles.diagSubVal}>
                  {detailedTimings?.serverPreprocessMs != null
                    ? `${detailedTimings.serverPreprocessMs} ms`
                    : 'N/A'}
                </Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagSubLabel}>↳ Server Postprocess (NMS):</Text>
                <Text style={styles.diagSubVal}>
                  {detailedTimings?.serverPostprocessMs != null
                    ? `${detailedTimings.serverPostprocessMs} ms`
                    : 'N/A'}
                </Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagSubLabel}>↳ Client Result Mapping:</Text>
                <Text style={styles.diagSubVal}>
                  {detailedTimings?.clientResultHandlingMs != null
                    ? `${detailedTimings.clientResultHandlingMs} ms`
                    : 'N/A'}
                </Text>
              </View>

              <View style={styles.diagDivider} />
              <Text style={styles.diagSectionTitle}>Live Temporal Tracking (Step C)</Text>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Tracker Engine:</Text>
                <Text style={[styles.diagVal, { color: '#7fd1ad', fontWeight: '700' }]}>
                  {tracker.trackerName}
                </Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Tracking Render Cadence:</Text>
                <Text style={[styles.diagVal, { color: '#7fd1ad', fontWeight: '700' }]}>
                  {isTrackingEnabled && trackingCadenceFps > 0
                    ? `${trackingCadenceFps} FPS (Continuous)`
                    : isTrackingEnabled
                    ? 'Active'
                    : 'Disabled (Raw Mode)'}
                </Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Detector Cadence (Decoupled):</Text>
                <Text style={[styles.diagVal, { color: '#f0a868', fontWeight: '600' }]}>
                  {detectionCadenceFps > 0 ? `${detectionCadenceFps} FPS (Sparse)` : 'Awaiting...'}
                </Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Active Tracked Faces:</Text>
                <Text style={[styles.diagVal, { color: '#7fd1ad', fontWeight: '700' }]}>
                  {trackerStats.activeTracks} active ({trackerStats.confirmedTracks} conf, {trackerStats.coastingTracks} coast)
                </Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Tracking Step Duration:</Text>
                <Text style={[styles.diagVal, { color: '#7fd1ad' }]}>
                  {trackerStats.lastStepDurationMs.toFixed(2)} ms (&lt; 1ms target)
                </Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Track Lifecycle (Created / Retired):</Text>
                <Text style={styles.diagVal}>
                  {trackerStats.totalCreated} created · {trackerStats.totalRetired} retired
                </Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Total Frames Analyzed:</Text>
                <Text style={styles.diagVal}>{totalFramesAnalyzed} frames</Text>
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
            </ScrollView>
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
  boxDetecting: {
    borderColor: '#7fd1ad',
    borderWidth: 2,
    backgroundColor: 'rgba(127, 209, 173, 0.14)',
  },
  boxConfirmed: {
    borderColor: '#7fd1ad',
    borderWidth: 2.5,
    backgroundColor: 'rgba(127, 209, 173, 0.16)',
  },
  boxTentative: {
    borderColor: 'rgba(127, 209, 173, 0.75)',
    borderWidth: 1.5,
    borderStyle: 'dashed',
    backgroundColor: 'rgba(127, 209, 173, 0.08)',
  },
  boxCoasting: {
    borderColor: '#f0a868',
    borderWidth: 1.5,
    borderStyle: 'dashed',
    backgroundColor: 'rgba(240, 168, 104, 0.12)',
    opacity: 0.88,
  },
  boxStale: {
    borderColor: '#f0a868',
    borderWidth: 2,
    borderStyle: 'dashed',
    backgroundColor: 'rgba(240, 168, 104, 0.08)',
    opacity: 0.85,
  },
  landmarkDot: {
    position: 'absolute',
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#f0a868',
    borderColor: '#ffffff',
    borderWidth: 1.5,
    marginLeft: -4,
    marginTop: -4,
    zIndex: 6,
  },
  confidenceTag: {
    position: 'absolute',
    top: -20,
    left: 2,
    backgroundColor: 'rgba(31, 26, 41, 0.88)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 95,
    zIndex: 8,
  },
  confidenceTagConfirmed: {
    backgroundColor: 'rgba(38, 92, 73, 0.94)',
  },
  confidenceTagTentative: {
    backgroundColor: 'rgba(64, 56, 79, 0.90)',
  },
  confidenceTagCoasting: {
    backgroundColor: 'rgba(189, 98, 30, 0.94)',
  },
  confidenceTagStale: {
    backgroundColor: 'rgba(240, 168, 104, 0.9)',
  },
  confidenceText: {
    color: '#ffffff',
    fontSize: 9.5,
    fontWeight: '700',
    flexShrink: 0,
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
  diagScroll: {
    maxHeight: 220,
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
  floatingControlsBar: {
    position: 'absolute',
    bottom: 14,
    left: 14,
    right: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    zIndex: 25,
  },
  zoomPillGroup: {
    flexDirection: 'row',
    backgroundColor: 'rgba(26, 21, 35, 0.75)',
    borderRadius: 20,
    padding: 3,
    gap: 4,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  zoomPill: {
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomPillActive: {
    backgroundColor: '#f0a868',
  },
  zoomPillText: {
    fontSize: 11.5,
    fontWeight: '600',
    color: '#b0a9bd',
  },
  zoomPillTextActive: {
    color: '#1f1a29',
    fontWeight: '700',
  },
  quickActionGroup: {
    flexDirection: 'row',
    gap: 6,
  },
  quickActionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(26, 21, 35, 0.85)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
  },
  quickActionText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#ffffff',
  },
  focusReticle: {
    position: 'absolute',
    width: 60,
    height: 60,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 20,
  },
  focusReticleInner: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#f0a868',
  },
  focusCornerTL: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 12,
    height: 12,
    borderTopWidth: 2,
    borderLeftWidth: 2,
    borderColor: '#f0a868',
  },
  focusCornerTR: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: 12,
    height: 12,
    borderTopWidth: 2,
    borderRightWidth: 2,
    borderColor: '#f0a868',
  },
  focusCornerBL: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    width: 12,
    height: 12,
    borderBottomWidth: 2,
    borderLeftWidth: 2,
    borderColor: '#f0a868',
  },
  focusCornerBR: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 12,
    height: 12,
    borderBottomWidth: 2,
    borderRightWidth: 2,
    borderColor: '#f0a868',
  },
  diagDivider: {
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    marginVertical: 4,
  },
  diagSectionTitle: {
    fontSize: 11.5,
    fontWeight: '700',
    color: '#f0a868',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 2,
  },
  diagSubLabel: {
    color: '#8e869e',
    fontSize: 11,
    fontWeight: '500',
    paddingLeft: 4,
  },
  diagSubVal: {
    color: '#e2dded',
    fontSize: 11,
    fontWeight: '600',
  },
});
