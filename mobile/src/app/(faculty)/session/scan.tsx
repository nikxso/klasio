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
  Alert,
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
import type {
  FaceDetectionResult,
  RawFrame,
  QualityAssessment,
  AccumulatedRecognitionCandidate,
  ScannerStabilityState,
  AttendanceSessionScope,
  RecognitionCandidate,
} from '@/perception/contracts';
import { DetailedPerceptionTimings } from '@/perception/perceptionClient';
import { Brand } from '@/constants/brand';
import {
  YuNetDetector,
  DirectOnDeviceDetector,
  TemporalCentroidTracker,
  FaceQualityGate,
  ProgressiveRecognitionAccumulator,
  SessionScopedFaceGallery,
  CosineGalleryMatcher,
  EdgeFaceEmbedder,
  EDGEFACE_XS_MANIFEST,
} from '@/lab';
import { GallerySyncService } from '@/perception/gallerySync';
import { RosterRepository } from '@/storage/rosterRepository';
import { SessionStore } from '@/storage/sessionStore';

interface DetectedFaceBox {
  id: string;
  trackId?: number;
  trackingState?: 'tentative' | 'confirmed' | 'coasting';
  isConfirmed?: boolean;
  quality?: QualityAssessment;
  displayBox?: { x: number; y: number; width: number; height: number };
  rawBox?: { x: number; y: number; width: number; height: number };
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
    slot?: string;
    applicability?: string;
    statusReason?: string;
  }>();

  const insets = useSafeAreaInsets();
  const { hasPermission, requestPermission } = useCameraPermission();

  // Progressive Recognition Accumulator (Step G / Phase 8)
  const accumulatorRef = useRef<ProgressiveRecognitionAccumulator>(
    new ProgressiveRecognitionAccumulator({
      scannerMotionConfig: {
        displacementPanningThreshold: 0.08,
        churnPanningThreshold: 0.40,
        stabilizationRequiredMs: 300,
      },
    })
  );
  const [accumulatedCandidates, setAccumulatedCandidates] = useState<AccumulatedRecognitionCandidate[]>([]);
  const [scannerMotionState, setScannerMotionState] = useState<ScannerStabilityState>('STABLE');

  // Scoped Gallery, Matcher & Recognizer (Milestone Biometric Integration)
  const sessionGalleryRef = useRef<SessionScopedFaceGallery>(new SessionScopedFaceGallery());
  const matcherRef = useRef<CosineGalleryMatcher>(new CosineGalleryMatcher());
  const embedderRef = useRef<EdgeFaceEmbedder>(new EdgeFaceEmbedder());
  const [isGalleryLoaded, setIsGalleryLoaded] = useState<boolean>(false);
  const lastMatchAttemptRef = useRef<Map<number, number>>(new Map()); // trackId -> timestampMs

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
  const [activeDetector, setActiveDetector] = useState<'YuNet' | 'YuNet-InMemory'>('YuNet-InMemory');

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
    qualityCounts?: {
      good: number;
      fair: number;
      poor: number;
      unknown: number;
    };
    primaryTrackGeometry?: {
      trackId: number;
      raw?: { x: number; y: number; width: number; height: number };
      tracked: { x: number; y: number; width: number; height: number };
      display: { x: number; y: number; width: number; height: number };
      qualityState?: string;
      primaryReason?: string;
    };
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

  // Detection loop refs
  const isDetectingRef = useRef(false);
  const lastFrameTimeRef = useRef(Date.now());

  // Initialize active model embedder and load class-scoped gallery
  useEffect(() => {
    let isCancelled = false;

    async function initClassGallery() {
      try {
        await embedderRef.current.initialize();
        const assignmentId = params.sectionId || 'ac8bf5c4-851a-4206-acf5-c8b174b1ae04';

        const token = SessionStore.getToken();
        if (token && assignmentId) {
          try {
            await RosterRepository.syncAssignmentRoster(assignmentId, token);
            await GallerySyncService.syncAssignmentGallery(assignmentId, token);
          } catch (syncErr) {
            console.warn('[GALLERY_SYNC] Sync warning, falling back to local SQLite:', syncErr);
          }
        }

        const sessionScope: AttendanceSessionScope = {
          attendanceSessionId: `sess_${assignmentId}_${Date.now()}`,
          academicTermId: '2026-FALL-SEM5',
          courseOfferingId: assignmentId,
          subject: params.subject || 'Data Structures',
          classId: params.section || 'CSE 3A',
          section: params.section || '3A',
          sessionDate: new Date().toISOString().split('T')[0],
        };

        // Query authorized cached roster for this section
        const cachedRoster = await RosterRepository.getCachedRoster(assignmentId);
        const studentIds = cachedRoster.map((s) => s.studentUserId);

        const gallery = await GallerySyncService.loadSessionScopedGallery(
          sessionScope,
          studentIds,
          'EdgeFace-XS-v1'
        );

        if (!isCancelled) {
          sessionGalleryRef.current = gallery;
          setIsGalleryLoaded(true);
        }
      } catch (err) {
        console.warn('[GALLERY_INIT] Error initializing class gallery:', err);
      }
    }

    initClassGallery();
    return () => {
      isCancelled = true;
    };
  }, [params.sectionId, params.subject]);

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

  const directDetector = useMemo(
    () => new DirectOnDeviceDetector(null, 0.35),
    []
  );

  // Face Quality & Visibility Gate (Step D)
  const qualityGate = useMemo(() => new FaceQualityGate(), []);

  // Temporal Face Tracker (Step C & Step D)
  const tracker = useMemo(
    () =>
      new TemporalCentroidTracker(
        {
          iouThreshold: 0.30,
          centroidDistanceThreshold: 0.18,
          sizeRatioThreshold: 0.40,
          minHitsToConfirm: 2,
          maxCoastDurationMs: 850,
          smoothingAlpha: 0.40,
          smoothingAlphaDimension: 0.18,
          velocityDamping: 0.92,
          targetDisplayAspectRatio: 0.75,
        },
        qualityGate
      ),
    [qualityGate]
  );


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
        const db = t.displayBox || t.boundingBox;
        const isCoasting = t.timeSinceLastSeenMs > 250;
        return {
          id: `track_${t.trackId}`,
          trackId: t.trackId,
          trackingState: isCoasting ? 'coasting' : t.isConfirmed ? 'confirmed' : 'tentative',
          isConfirmed: t.isConfirmed,
          confidence: t.confidence,
          quality: t.quality,
          x: Math.max(0, Math.min(100, b.x * 100)),
          y: Math.max(0, Math.min(100, b.y * 100)),
          width: Math.max(0, Math.min(100, b.width * 100)),
          height: Math.max(0, Math.min(100, b.height * 100)),
          displayBox: {
            x: Math.max(0, Math.min(100, db.x * 100)),
            y: Math.max(0, Math.min(100, db.y * 100)),
            width: Math.max(0, Math.min(100, db.width * 100)),
            height: Math.max(0, Math.min(100, db.height * 100)),
          },
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

              const detector = yunetDetector;
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

                // STEP G: Match quality-acceptable tracks against class gallery and feed candidates to accumulator
                const confirmedTracks = tracker.getConfirmedTracks();
                const frameCandidates: RecognitionCandidate[] = [];

                if (sessionGalleryRef.current.size > 0) {
                  const targetRes = ANALYSIS_RESOLUTIONS[analysisPreference];
                  const analysisW = targetRes.targetWidth;
                  const analysisH = targetRes.targetHeight;

                  for (const track of confirmedTracks) {
                    const lastAttempt = lastMatchAttemptRef.current.get(track.trackId) || 0;
                    if (captureStartWall - lastAttempt < 1000) {
                      continue; // Rate-limit face recognition to 1.0 Hz per track
                    }
                    lastMatchAttemptRef.current.set(track.trackId, captureStartWall);

                    // Quality gate evaluation
                    const quality = qualityGate.evaluate(
                      track.boundingBox,
                      track.landmarks,
                      track.confidence,
                      undefined,
                      undefined,
                      analysisW,
                      analysisH
                    );

                    if (quality.state === 'POOR') continue;

                    try {
                      const cropInput = {
                        frame: {
                          width: analysisW,
                          height: analysisH,
                          format: 'rgba' as const,
                          timestampMs: captureStartWall,
                          data: new Uint8Array(64),
                          rotationDegrees: 0 as const,
                        },
                        box: track.boundingBox,
                        landmarks: track.landmarks,
                        embedding: track.embedding,
                        embeddingBase64: track.embeddingBase64,
                        cameraTag: findNodeHandle(cameraRef.current),
                      };

                      const embResult = await embedderRef.current.embed(cropInput, true);

                      const match = matcherRef.current.findMatch(
                        embResult.embedding,
                        sessionGalleryRef.current,
                        0.65, // provisional similarity threshold
                        0.10, // provisional margin threshold
                        EDGEFACE_XS_MANIFEST
                      );

                      if (match && match.isConfident && match.matchState === 'MATCHED' && match.studentUserId) {
                        frameCandidates.push({
                          trackId: track.trackId,
                          match,
                          qualityScore: quality.score,
                          detectedAtMs: captureStartWall,
                          consecutiveConfirmations: track.ageInFrames || 1,
                          isConfirmed: true,
                        });
                      }
                    } catch (embErr) {
                      console.warn(`[MATCHER] Error processing track ${track.trackId}:`, embErr);
                    }
                  }
                }

                accumulatorRef.current.processFrameCandidates(frameCandidates, confirmedTracks, captureStartWall);
                const metrics = accumulatorRef.current.getScannerMetrics();
                setScannerMotionState(metrics.state);
                setAccumulatedCandidates(accumulatorRef.current.getAccumulatedCandidates());

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
  }, [isCameraActive, activeDetector, cameraPosition, yunetDetector, directDetector, viewfinderLayout]);

  const handleDone = () => {
    const candidates = accumulatorRef.current.getAccumulatedCandidates();
    router.replace({
      pathname: '/(faculty)/section/[id]',
      params: {
        id: params.sectionId || '1',
        subject: params.subject || 'Data Structures',
        section: params.section || 'CSE 3A',
        room: params.room || 'LH-204',
        slot: params.slot || '1',
        applicability: params.applicability || 'COUNTED',
        statusReason: params.statusReason || '',
        initialMode: 'review',
        accumulatedCandidatesJson: JSON.stringify(candidates),
      },
    });
  };

  const handleSafeExit = () => {
    const candidates = accumulatorRef.current.getAccumulatedCandidates();
    if (candidates.length === 0) {
      router.back();
      return;
    }
    Alert.alert(
      'Leave Attendance Scanner?',
      `${candidates.length} student(s) recognized in this session. Would you like to review and keep your attendance progress or discard?`,
      [
        {
          text: 'Pause & Keep Progress',
          onPress: () => {
            handleDone();
          },
        },
        {
          text: 'Discard & Exit',
          style: 'destructive',
          onPress: () => {
            router.back();
          },
        },
        { text: 'Cancel', style: 'cancel' },
      ]
    );
  };

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

            {/* Viewfinder Framing Guides (Corner Brackets) */}
            <View pointerEvents="none" style={styles.viewfinderFrame}>
              <View style={[styles.cornerBracket, styles.cornerTL]} />
              <View style={[styles.cornerBracket, styles.cornerTR]} />
              <View style={[styles.cornerBracket, styles.cornerBL]} />
              <View style={[styles.cornerBracket, styles.cornerBR]} />
            </View>

            {/* Detected Face Bounding Box & Facial Landmark Overlays (Step C: Temporal Tracks) */}
            {detectedFaces.map((face) => (
              <React.Fragment key={face.id}>
                {/* Bounding Box (Step D: Display Geometry + Quality-State Styling) */}
                <View
                  pointerEvents="none"
                  style={[
                    styles.boundingBox,
                    face.trackingState === 'coasting'
                      ? styles.boxCoasting
                      : face.quality?.state === 'GOOD'
                      ? styles.boxQualityGood
                      : face.quality?.state === 'FAIR'
                      ? styles.boxQualityFair
                      : face.quality?.state === 'POOR'
                      ? styles.boxQualityPoor
                      : face.isConfirmed
                      ? styles.boxConfirmed
                      : face.trackingState === 'tentative'
                      ? styles.boxTentative
                      : face.isStale
                      ? styles.boxStale
                      : styles.boxDetecting,
                    {
                      left: `${face.displayBox ? face.displayBox.x : face.x}%`,
                      top: `${face.displayBox ? face.displayBox.y : face.y}%`,
                      width: `${face.displayBox ? face.displayBox.width : face.width}%`,
                      height: `${face.displayBox ? face.displayBox.height : face.height}%`,
                    },
                  ]}
                >
                  <View
                    style={[
                      styles.confidenceTag,
                      face.trackingState === 'coasting'
                        ? styles.confidenceTagCoasting
                        : face.quality?.state === 'GOOD'
                        ? styles.confidenceTagGood
                        : face.quality?.state === 'FAIR'
                        ? styles.confidenceTagFair
                        : face.quality?.state === 'POOR'
                        ? styles.confidenceTagPoor
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
                        ? `Track #${face.trackId} [${face.quality?.state || (face.isConfirmed ? 'CONF' : 'TENT')}${face.quality?.primaryReason ? `: ${face.quality.primaryReason}` : ''}]`
                        : 'YuNet'}
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
                  {Brand.name} needs camera access to perform on-device face perception during class attendance.
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
          {/* Close / Pause & Keep Session Button */}
          <TouchableOpacity
            style={styles.circleIconButton}
            onPress={handleSafeExit}
            accessibilityLabel="Pause and exit scanning"
          >
            <X size={20} color="#ffffff" />
          </TouchableOpacity>

          {/* Subject & Section Badge */}
          <View style={styles.headerTitleContainer}>
            <Text style={styles.headerSubject} numberOfLines={1}>
              {params.subject || 'Data Structures'}
              {params.slot ? ` · Period ${params.slot}` : ''}
            </Text>
            <Text style={styles.headerSection}>
              {params.section || 'CSE 3A'} · {params.room || 'LH-204'}
              {params.applicability && params.applicability !== 'COUNTED' ? ` · ${params.applicability}` : ''}
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
          <Text style={styles.counterBig}>{accumulatedCandidates.length}</Text>
          <Text style={styles.counterTotal}> recognized ({detectedFaces.length} in view)</Text>
        </View>

        {/* User Guidance Prompt */}
        <Text style={[styles.guidanceText, scannerMotionState === 'PANNING' && { color: '#f0a868', fontWeight: '600' }]}>
          {isPaused
            ? 'Camera paused — tap play to resume'
            : scannerMotionState === 'PANNING'
            ? '⚠️ Camera moving too fast — slow down to capture faces'
            : detectedFaces.length > 0
            ? 'Suggested matches are ready for your review.'
            : 'Move across the room to find students.'}
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
                  {(['YuNet-InMemory', 'YuNet'] as const).map((det) => (
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
                        {det === 'YuNet-InMemory' ? 'YuNet (In-Mem)' : 'YuNet (HTTP)'}
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

              <View style={styles.diagDivider} />
              <Text style={styles.diagSectionTitle}>Face Quality & Visibility Gate (Step D)</Text>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Gate Evaluation Engine:</Text>
                <Text style={[styles.diagVal, { color: '#7fd1ad', fontWeight: '700' }]}>
                  {qualityGate.gateName} (5-Dimension)
                </Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Track Quality Distribution:</Text>
                <Text style={styles.diagVal}>
                  {`${trackerStats.qualityCounts?.good ?? 0} GOOD · ${trackerStats.qualityCounts?.fair ?? 0} FAIR · ${trackerStats.qualityCounts?.poor ?? 0} POOR`}
                </Text>
              </View>

              {detectedFaces.length > 0 && detectedFaces[0].quality ? (
                <>
                  <View style={styles.diagRow}>
                    <Text style={styles.diagSubLabel}>↳ Primary Track ID:</Text>
                    <Text style={[styles.diagSubVal, { fontWeight: '700', color: '#ffffff' }]}>
                      Track #{detectedFaces[0].trackId ?? 1}
                    </Text>
                  </View>

                  <View style={styles.diagRow}>
                    <Text style={styles.diagSubLabel}>↳ Quality State & Score:</Text>
                    <Text
                      style={[
                        styles.diagSubVal,
                        {
                          fontWeight: '700',
                          color:
                            detectedFaces[0].quality.state === 'GOOD'
                              ? '#7fd1ad'
                              : detectedFaces[0].quality.state === 'FAIR'
                              ? '#f0a868'
                              : '#d65f57',
                        },
                      ]}
                    >
                      {detectedFaces[0].quality.state} ({Math.round(detectedFaces[0].quality.score * 100)}%)
                    </Text>
                  </View>

                  <View style={styles.diagRow}>
                    <Text style={styles.diagSubLabel}>↳ Primary Quality Reason:</Text>
                    <Text style={[styles.diagSubVal, { color: detectedFaces[0].quality.primaryReason ? '#f0a868' : '#7fd1ad' }]}>
                      {detectedFaces[0].quality.primaryReason || 'NONE (All checks pass)'}
                    </Text>
                  </View>

                  <View style={styles.diagRow}>
                    <Text style={styles.diagSubLabel}>↳ Face Size (Norm / Est Px):</Text>
                    <Text style={styles.diagSubVal}>
                      {`${(detectedFaces[0].quality.metrics.normalizedWidth * 100).toFixed(1)}% × ${(detectedFaces[0].quality.metrics.normalizedHeight * 100).toFixed(1)}% (~${detectedFaces[0].quality.metrics.estimatedPixelSizePx ?? 0}px) [${detectedFaces[0].quality.metrics.sizeState}]`}
                    </Text>
                  </View>

                  <View style={styles.diagRow}>
                    <Text style={styles.diagSubLabel}>↳ Aspect Ratio & Stability:</Text>
                    <Text style={styles.diagSubVal}>
                      {`${detectedFaces[0].quality.metrics.aspectRatio.toFixed(2)} (${detectedFaces[0].quality.metrics.isGeometryStable ? 'Stable' : 'Unstable'}) [${detectedFaces[0].quality.metrics.geometryState}]`}
                    </Text>
                  </View>

                  <View style={styles.diagRow}>
                    <Text style={styles.diagSubLabel}>↳ In-Frame Visibility / Clip:</Text>
                    <Text style={styles.diagSubVal}>
                      {`${Math.round(detectedFaces[0].quality.metrics.inFrameProportion * 100)}% (${detectedFaces[0].quality.metrics.isClipped ? 'Clipped' : 'Clean'}) [${detectedFaces[0].quality.metrics.visibilityState}]`}
                    </Text>
                  </View>

                  <View style={styles.diagRow}>
                    <Text style={styles.diagSubLabel}>↳ Sharpness / Blur Proxy:</Text>
                    <Text style={styles.diagSubVal}>
                      {`${Math.round(detectedFaces[0].quality.metrics.sharpnessScore * 100)}% [${detectedFaces[0].quality.metrics.sharpnessState}]`}
                    </Text>
                  </View>

                  <View style={styles.diagRow}>
                    <Text style={styles.diagSubLabel}>↳ Head Pose (Yaw / Pitch / Roll):</Text>
                    <Text style={styles.diagSubVal}>
                      {`Y:${detectedFaces[0].quality.metrics.yawDegrees > 0 ? '+' : ''}${detectedFaces[0].quality.metrics.yawDegrees.toFixed(1)}° P:${detectedFaces[0].quality.metrics.pitchDegrees > 0 ? '+' : ''}${detectedFaces[0].quality.metrics.pitchDegrees.toFixed(1)}° R:${detectedFaces[0].quality.metrics.rollDegrees > 0 ? '+' : ''}${detectedFaces[0].quality.metrics.rollDegrees.toFixed(1)}° [${detectedFaces[0].quality.metrics.poseState}]`}
                    </Text>
                  </View>

                  {/* Section 12: 4-Way Geometry Separation Audit */}
                  <View style={styles.diagRow}>
                    <Text style={styles.diagSubLabel}>↳ [Audit] Raw vs Track vs Disp:</Text>
                    <Text style={[styles.diagSubVal, { fontSize: 10.5, color: '#b0a9bd' }]}>
                      {`Raw: ${(trackerStats.primaryTrackGeometry?.raw?.width ? (trackerStats.primaryTrackGeometry.raw.width * 100).toFixed(1) : detectedFaces[0].width.toFixed(1))}% | Track: ${detectedFaces[0].width.toFixed(1)}% | Disp: ${(detectedFaces[0].displayBox?.width ?? detectedFaces[0].width).toFixed(1)}%`}
                    </Text>
                  </View>
                </>
              ) : (
                <View style={styles.diagRow}>
                  <Text style={styles.diagSubLabel}>↳ Active Face Observation:</Text>
                  <Text style={styles.diagSubVal}>Awaiting tracked face...</Text>
                </View>
              )}

              {/* Step E: Embedding Layer Diagnostics (Transient Biometric Boundary) */}
              <View style={styles.diagDivider} />
              <Text style={styles.diagSectionTitle}>Step E: Embedding & Model Selection</Text>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Selected V1 Model:</Text>
                <Text style={[styles.diagVal, { color: '#7fd1ad' }]}>EdgeFace-XS (512-dim, 6.94MB)</Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Embedding Pipeline:</Text>
                <Text style={styles.diagVal}>5-Pt Aligned → L2 Unit Vector</Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Biometric Boundary:</Text>
                <Text style={[styles.diagVal, { color: '#f0a868' }]}>Transient In-Memory Only</Text>
              </View>

              {/* Step F: Session-Scoped Face Gallery Matching Diagnostics */}
              <View style={styles.diagDivider} />
              <Text style={styles.diagSectionTitle}>Step F: Session-Scoped Gallery Matching</Text>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Session Gallery Scope:</Text>
                <Text style={[styles.diagVal, { color: '#7fd1ad' }]}>
                  {params.section ? `${params.subject || 'CS301'} · Sec ${params.section}` : 'Development Active Scope'}
                </Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Authorized Gallery:</Text>
                <Text style={styles.diagVal}>30 reference profiles (EdgeFace-XS V1)</Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Candidate Matcher:</Text>
                <Text style={styles.diagVal}>Cosine Dot Product + Top-2 Student Margin</Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Configured Thresholds:</Text>
                <Text style={styles.diagVal}>τ ≥ 0.65 · Δ ≥ 0.10</Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Temporal Gating:</Text>
                <Text style={styles.diagVal}>Observation-Rate Buffer (3 cons. obs)</Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Domain Invariant:</Text>
                <Text style={[styles.diagVal, { color: '#f0a868' }]}>RecognitionCandidate Only (No Attendance)</Text>
              </View>

              {/* Step G: Progressive Classroom Recognition Diagnostics */}
              <View style={styles.diagDivider} />
              <Text style={styles.diagSectionTitle}>Step G: Progressive Recognition Accumulation</Text>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Session Identity Storage:</Text>
                <Text style={[styles.diagVal, { color: '#7fd1ad' }]}>
                  Deduplicated by studentUserId (Multi-Region Sweep)
                </Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Scanner Motion Heuristic:</Text>
                <Text style={[styles.diagVal, { color: isPaused ? '#f0a868' : '#7fd1ad' }]}>
                  {isPaused ? 'PAUSED' : 'STABLE (Δd ≤ 0.08, Churn ≤ 0.40)'}
                </Text>
              </View>

              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Accumulator Boundary:</Text>
                <Text style={[styles.diagVal, { color: '#f0a868' }]}>
                  AccumulatedRecognitionCandidate Only (STOP)
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
  viewfinderFrame: {
    ...(StyleSheet.absoluteFill as any),
    margin: 20,
    pointerEvents: 'none',
  },
  cornerBracket: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderColor: 'rgba(255, 255, 255, 0.45)',
  },
  cornerTL: {
    top: 0,
    left: 0,
    borderTopWidth: 2.5,
    borderLeftWidth: 2.5,
    borderTopLeftRadius: 6,
  },
  cornerTR: {
    top: 0,
    right: 0,
    borderTopWidth: 2.5,
    borderRightWidth: 2.5,
    borderTopRightRadius: 6,
  },
  cornerBL: {
    bottom: 0,
    left: 0,
    borderBottomWidth: 2.5,
    borderLeftWidth: 2.5,
    borderBottomLeftRadius: 6,
  },
  cornerBR: {
    bottom: 0,
    right: 0,
    borderBottomWidth: 2.5,
    borderRightWidth: 2.5,
    borderBottomRightRadius: 6,
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
  boxQualityGood: {
    borderColor: '#34d399',
    borderWidth: 2.5,
    backgroundColor: 'rgba(52, 211, 153, 0.16)',
  },
  boxQualityFair: {
    borderColor: '#fbbf24',
    borderWidth: 2,
    backgroundColor: 'rgba(251, 191, 36, 0.14)',
  },
  boxQualityPoor: {
    borderColor: '#f87171',
    borderWidth: 1.5,
    borderStyle: 'dashed',
    backgroundColor: 'rgba(248, 113, 113, 0.08)',
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
  confidenceTagGood: {
    backgroundColor: 'rgba(5, 150, 105, 0.94)',
  },
  confidenceTagFair: {
    backgroundColor: 'rgba(217, 119, 6, 0.94)',
  },
  confidenceTagPoor: {
    backgroundColor: 'rgba(185, 28, 28, 0.90)',
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
