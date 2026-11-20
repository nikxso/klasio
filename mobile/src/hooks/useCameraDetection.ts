import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  AppState,
  AppStateStatus,
  Dimensions,
  Animated,
  findNodeHandle,
  Alert,
} from 'react-native';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  CameraDevice,
} from 'react-native-vision-camera';
import {
  selectBestPreviewFormat,
  ANALYSIS_RESOLUTIONS,
  FormattedCapability,
} from '../perception/cameraFormatPolicy';
import type {
  FaceDetectionResult,
  RawFrame,
  QualityAssessment,
  AccumulatedRecognitionCandidate,
  ScannerStabilityState,
  AttendanceSessionScope,
  RecognitionCandidate,
  TrackedFace,
} from '../perception/contracts';
import { DetailedPerceptionTimings } from '../perception/perceptionClient';
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
} from '../lab';
import { BIOMETRIC_CONFIG } from '../config/biometrics';
import { GallerySyncService } from '../perception/gallerySync';
import { RosterRepository } from '../storage/rosterRepository';
import { SessionStore } from '../storage/sessionStore';
import { saveReportFile } from '../services/nativePerception';

export interface DetectedFaceBox {
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

export interface CalibrationLogEntry {
  timestampIso: string;
  timestampMs: number;
  trackId: number;
  qualityState: string;
  qualityScore: number;
  top1Score: number | null;
  top1StudentId: string | null;
  top1StudentName: string | null;
  top2Score: number | null;
  top2StudentId: string | null;
  margin: number | null;
  matchState: string;
}

export interface UseCameraDetectionOptions {
  sectionId?: string;
  subject?: string;
  section?: string;
  room?: string;
  slot?: string;
  applicability?: string;
}

export function useCameraDetection(options: UseCameraDetectionOptions) {
  const { sectionId, subject, section } = options;

  // Camera permissions
  const { hasPermission, requestPermission } = useCameraPermission();
  const [permissionDeniedCount, setPermissionDeniedCount] = useState<number>(0);
  const [isRequestingPermission, setIsRequestingPermission] = useState<boolean>(false);

  // App lifecycle
  const [appState, setAppState] = useState<AppStateStatus>(AppState.currentState);
  const [isPaused, setIsPaused] = useState<boolean>(false);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const cameraRef = useRef<Camera>(null);
  const [cameraPosition, setCameraPosition] = useState<'back' | 'front'>('back');
  const backDevice = useCameraDevice('back');
  const frontDevice = useCameraDevice('front');
  const device = cameraPosition === 'back' ? backDevice : frontDevice;

  const isForeground = appState === 'active' || appState === 'unknown';
  const isCameraActive = isForeground && hasPermission && !isPaused && cameraError === null;

  // Viewfinder layout metrics for coordinate mapping
  const [viewfinderLayout, setViewfinderLayout] = useState<{ width: number; height: number }>({
    width: Dimensions.get('window').width,
    height: Math.round(Dimensions.get('window').height * 0.65),
  });

  // Zoom controls
  const [zoom, setZoom] = useState<number>(1.0);
  const minZoom = device?.minZoom ?? 1.0;
  const maxZoom = device?.maxZoom ?? 8.0;
  const neutralZoom = device?.neutralZoom ?? 1.0;

  useEffect(() => {
    if (device) {
      setZoom(device.neutralZoom ?? 1.0);
    }
  }, [device?.id]);

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

  // Tap-to-focus
  const [focusPoint, setFocusPoint] = useState<{ x: number; y: number; id: number } | null>(null);
  const [isManualFocus, setIsManualFocus] = useState<boolean>(false);
  const focusReticleAnim = useRef(new Animated.Value(0)).current;
  const autoFocusTimerRef = useRef<any>(null);

  const handleTapToFocus = useCallback(
    async (event: any) => {
      if (!cameraRef.current || !isCameraActive) return;
      const { locationX, locationY } = event.nativeEvent;
      if (typeof locationX !== 'number' || typeof locationY !== 'number') return;

      const pointId = Date.now();
      setFocusPoint({ x: Math.round(locationX), y: Math.round(locationY), id: pointId });
      setIsManualFocus(true);

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

  // Perception modules & state
  const [activeDetector, setActiveDetector] = useState<'YuNet' | 'YuNet-InMemory'>('YuNet-InMemory');
  const [analysisPreference, setAnalysisPreference] = useState<'STANDARD_640' | 'LIGHTWEIGHT_320'>('STANDARD_640');
  const [detectedFaces, setDetectedFaces] = useState<DetectedFaceBox[]>([]);
  const [detectionLatencyMs, setDetectionLatencyMs] = useState<number>(0);
  const [detectionCadenceFps, setDetectionCadenceFps] = useState<number>(0);
  const [totalFramesAnalyzed, setTotalFramesAnalyzed] = useState<number>(0);
  const [detailedTimings, setDetailedTimings] = useState<DetailedPerceptionTimings | null>(null);

  // Progressive recognition accumulator
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

  // Scoped gallery, matcher & embedder
  const sessionGalleryRef = useRef<SessionScopedFaceGallery>(new SessionScopedFaceGallery());
  const matcherRef = useRef<CosineGalleryMatcher>(new CosineGalleryMatcher());
  const embedderRef = useRef<EdgeFaceEmbedder>(new EdgeFaceEmbedder());
  const [isGalleryLoaded, setIsGalleryLoaded] = useState<boolean>(false);
  const [totalRosterCount, setTotalRosterCount] = useState<number>(0);
  const lastMatchAttemptRef = useRef<Map<number, number>>(new Map()); // trackId -> timestampMs

  // Calibration logging mode
  const [isCalibrationMode, setIsCalibrationMode] = useState<boolean>(false);
  const calibrationLogsRef = useRef<CalibrationLogEntry[]>([]);
  const [calibrationLogsCount, setCalibrationLogsCount] = useState<number>(0);

  // Tracking state
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

  // Telemetry queue refs
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

  const isDetectingRef = useRef(false);
  const lastFrameTimeRef = useRef(Date.now());

  // Quality gate & tracker instances
  const qualityGate = useMemo(() => new FaceQualityGate(), []);
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

  // Gallery initialization
  useEffect(() => {
    let isCancelled = false;

    async function initClassGallery() {
      try {
        await embedderRef.current.initialize();
        const assignmentId = sectionId || 'ac8bf5c4-851a-4206-acf5-c8b174b1ae04';
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
          subject: subject || 'Data Structures',
          classId: section || 'CSE 3A',
          section: section || '3A',
          sessionDate: new Date().toISOString().split('T')[0],
        };

        const cachedRoster = await RosterRepository.getCachedRoster(assignmentId);
        const studentIds = cachedRoster.map((s) => s.studentUserId);
        if (!isCancelled) {
          setTotalRosterCount(studentIds.length);
        }

        const gallery = await GallerySyncService.loadSessionScopedGallery(
          sessionScope,
          studentIds,
          'EdgeFace-XS-v1'
        );

        if (!isCancelled) {
          sessionGalleryRef.current = gallery;
          setIsGalleryLoaded(true);
          if (gallery.size > 0 && gallery.size > studentIds.length) {
            setTotalRosterCount(gallery.size);
          }
        }
      } catch (err) {
        console.warn('[GALLERY_INIT] Error initializing class gallery:', err);
      }
    }

    initClassGallery();
    return () => {
      isCancelled = true;
    };
  }, [sectionId, subject, section]);

  // AppState listener
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      setAppState(next);
    });
    return () => subscription.remove();
  }, []);

  // Camera permissions
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

  // 30 FPS Presentation Ticker for tracking
  useEffect(() => {
    if (!isCameraActive || !isTrackingEnabled) return;

    let isMounted = true;
    let lastTickTime = Date.now();

    const tickTracking = () => {
      if (!isMounted) return;
      const now = Date.now();
      const deltaMs = now - lastTickTime;
      lastTickTime = now;
      if (deltaMs > 0) {
        const fps = Math.min(60, Math.round(1000 / deltaMs));
        setTrackingCadenceFps((prev) => (prev === 0 ? fps : Math.round(prev * 0.8 + fps * 0.2)));
      }

      const activeTracks = tracker.getActiveTracks();
      const mapped: DetectedFaceBox[] = activeTracks.map((t) => {
        const d = t.displayBox;
        const screenW = viewfinderLayout.width;
        const screenH = viewfinderLayout.height;

        const leftPx = d.x * screenW;
        const topPx = d.y * screenH;
        const widthPx = d.width * screenW;
        const heightPx = d.height * screenH;

        const xPct = Math.max(0, Math.min(100, (leftPx / screenW) * 100));
        const yPct = Math.max(0, Math.min(100, (topPx / screenH) * 100));
        const wPct = Math.max(0, Math.min(100, (widthPx / screenW) * 100));
        const hPct = Math.max(0, Math.min(100, (heightPx / screenH) * 100));

        const lm = t.landmarks;
        return {
          id: `track_${t.trackId}`,
          trackId: t.trackId,
          trackingState: t.state,
          isConfirmed: t.state === 'confirmed',
          quality: t.quality,
          displayBox: t.displayBox,
          rawBox: t.boundingBox,
          frameId: `track_${t.trackId}_${now}`,
          captureTimestampMs: t.lastUpdatedMs,
          resultAgeMs: Math.max(0, now - t.lastUpdatedMs),
          isStale: t.isCoasting,
          x: xPct,
          y: yPct,
          width: wPct,
          height: hPct,
          confidence: t.confidence,
          landmarks: lm
            ? {
                leftEye: {
                  x: Math.max(0, Math.min(100, ((lm.leftEye?.x || 0) * screenW) / screenW * 100)),
                  y: Math.max(0, Math.min(100, ((lm.leftEye?.y || 0) * screenH) / screenH * 100)),
                },
                rightEye: {
                  x: Math.max(0, Math.min(100, ((lm.rightEye?.x || 0) * screenW) / screenW * 100)),
                  y: Math.max(0, Math.min(100, ((lm.rightEye?.y || 0) * screenH) / screenH * 100)),
                },
                noseTip: {
                  x: Math.max(0, Math.min(100, ((lm.noseTip?.x || 0) * screenW) / screenW * 100)),
                  y: Math.max(0, Math.min(100, ((lm.noseTip?.y || 0) * screenH) / screenH * 100)),
                },
                mouthLeft: {
                  x: Math.max(0, Math.min(100, ((lm.mouthLeft?.x || 0) * screenW) / screenW * 100)),
                  y: Math.max(0, Math.min(100, ((lm.mouthLeft?.y || 0) * screenH) / screenH * 100)),
                },
                mouthRight: {
                  x: Math.max(0, Math.min(100, ((lm.mouthRight?.x || 0) * screenW) / screenW * 100)),
                  y: Math.max(0, Math.min(100, ((lm.mouthRight?.y || 0) * screenH) / screenH * 100)),
                },
              }
            : undefined,
        };
      });

      setDetectedFaces(mapped);
    };

    const intervalId = setInterval(tickTracking, 33);
    return () => {
      isMounted = false;
      clearInterval(intervalId);
    };
  }, [isCameraActive, isTrackingEnabled, tracker, viewfinderLayout]);

  // Continuous non-blocking face detection cycle
  useEffect(() => {
    if (!isCameraActive) {
      setDetectedFaces([]);
      return;
    }

    let isMounted = true;

    const runDetection = async () => {
      if (!isMounted || !isCameraActive) return;

      if (isDetectingRef.current) {
        droppedFramesCountRef.current += 1;
        setDroppedFramesCount(droppedFramesCountRef.current);
        const delayMs = activeDetector === 'YuNet-InMemory' ? 20 : 50;
        activeTimerRef.current = setTimeout(runDetection, delayMs);
        return;
      }

      isDetectingRef.current = true;
      inFlightCountRef.current += 1;
      setQueueDepth(inFlightCountRef.current);

      frameSeqRef.current += 1;
      const thisFrameSeq = frameSeqRef.current;
      const frameId = `f_${thisFrameSeq}_${Date.now()}`;
      const captureStartWall = Date.now();

      try {
        const dummyFrame: RawFrame = {
          width: 640,
          height: 640,
          format: 'rgba',
          timestampMs: captureStartWall,
          data: new Uint8Array(64),
          rotationDegrees: 0,
        };

        const viewTag = findNodeHandle(cameraRef.current);
        const isInMemory = activeDetector === 'YuNet-InMemory';

        const detector = isInMemory ? directDetector : yunetDetector;
        if (isInMemory) {
          (detector as DirectOnDeviceDetector).cameraTag = viewTag;
        }

        const tBeforeDetect = Date.now();
        const result = await detector.detect(dummyFrame);
        const tAfterDetect = Date.now();

        if (thisFrameSeq < lastRenderedFrameSeqRef.current) {
          staleFramesCountRef.current += 1;
          setStaleFramesCount(staleFramesCountRef.current);
          return;
        }
        lastRenderedFrameSeqRef.current = thisFrameSeq;

        if (isMounted) {
          const detections: FaceDetectionResult[] = result.faces || [];
          const timings = result.timings;

          const nowRendered = Date.now();
          const renderAge = nowRendered - captureStartWall;
          const captureToResult = nowRendered - tBeforeDetect;

          setDisplayedFrameId(frameId);
          setResultAgeMs(renderAge);
          setCaptureToResultMs(captureToResult);
          setTotalFramesAnalyzed((prev) => prev + 1);

          const clientMappingStart = Date.now();

          const mappedBoxes: DetectedFaceBox[] = detections.map((f, i) => {
            const raw = f.box;
            const targetRes = ANALYSIS_RESOLUTIONS[analysisPreference];
            const targetWidth = targetRes.targetWidth;
            const targetHeight = targetRes.targetHeight;

            let bx = raw.x;
            let by = raw.y;
            let bw = raw.width;
            let bh = raw.height;

            if (bx > 1.0 || by > 1.0 || bw > 1.0 || bh > 1.0) {
              bx = bx / targetWidth;
              by = by / targetHeight;
              bw = bw / targetWidth;
              bh = bh / targetHeight;
            }

            const screenW = viewfinderLayout.width;
            const screenH = viewfinderLayout.height;

            const scaleX = screenW;
            const scaleY = screenH;

            const leftPx = bx * scaleX;
            const topPx = by * scaleY;
            const widthPx = bw * scaleX;
            const heightPx = bh * scaleY;

            const xPct = Math.max(0, Math.min(100, (leftPx / screenW) * 100));
            const yPct = Math.max(0, Math.min(100, (topPx / screenH) * 100));
            const wPct = Math.max(0, Math.min(100, (widthPx / screenW) * 100));
            const hPct = Math.max(0, Math.min(100, (heightPx / screenH) * 100));

            const lm = f.landmarks as any;
            let mappedLandmarks: DetectedFaceBox['landmarks'] = undefined;
            if (lm) {
              const mouthLeft = lm.mouthLeft || lm.leftMouth || {};
              const mouthRight = lm.mouthRight || lm.rightMouth || {};
              const leftEye = lm.leftEye || {};
              const rightEye = lm.rightEye || {};
              const noseTip = lm.noseTip || lm.nose || {};

              const normLm = (pt: { x?: number; y?: number }) => {
                let px = pt.x ?? 0;
                let py = pt.y ?? 0;
                if (px > 1.0 || py > 1.0) {
                  px = px / targetWidth;
                  py = py / targetHeight;
                }
                return {
                  x: Math.max(0, Math.min(100, (px * scaleX * 100) / screenW)),
                  y: Math.max(0, Math.min(100, (py * scaleY * 100) / screenH)),
                };
              };

              mappedLandmarks = {
                leftEye: normLm(leftEye),
                rightEye: normLm(rightEye),
                noseTip: normLm(noseTip),
                mouthLeft: normLm(mouthLeft),
                mouthRight: normLm(mouthRight),
              };
            }

            return {
              id: `${frameId}_${i}`,
              displayBox: { x: bx, y: by, width: bw, height: bh },
              rawBox: { x: raw.x, y: raw.y, width: raw.width, height: raw.height },
              frameId,
              captureTimestampMs: captureStartWall,
              resultAgeMs: renderAge,
              x: xPct,
              y: yPct,
              width: wPct,
              height: hPct,
              confidence: f.confidence,
              landmarks: mappedLandmarks,
            };
          });

          const clientMappingMs = Date.now() - clientMappingStart;
          const totalE2EMs = Date.now() - captureStartWall;
          const inferMs = timings?.inferenceMs ?? timings?.serverInferenceMs ?? tAfterDetect - tBeforeDetect;
          const overheadMs = Math.max(0, totalE2EMs - inferMs);

          setDetectionLatencyMs(inferMs);

          const fullTimings: DetailedPerceptionTimings = {
            frameAcquisitionMs: timings?.frameAcquisitionMs ?? 0,
            shmTransferMs: timings?.shmTransferMs ?? 0,
            directBufferCopyMs: timings?.directBufferCopyMs ?? 0,
            networkRttMs: timings?.networkRttMs ?? 0,
            inferenceDurationMs: inferMs,
            totalPerceptionLatencyMs: totalE2EMs,
            resultAgeWhenRenderedMs: renderAge,
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

          const now = Date.now();
          const deltaMs = now - lastFrameTimeRef.current;
          lastFrameTimeRef.current = now;
          if (deltaMs > 0) {
            const instantaneousFps = Math.min(30, Math.round(1000 / deltaMs));
            setDetectionCadenceFps((prev) =>
              prev === 0 ? instantaneousFps : Math.round(prev * 0.7 + instantaneousFps * 0.3)
            );
          }

          // Temporal tracker update
          if (isTrackingEnabled) {
            tracker.update(detections, captureStartWall);
            const currentStats = tracker.getDiagnostics();
            setTrackerStats(currentStats);

            const confirmedTracks = tracker.getConfirmedTracks();
            const frameCandidates: RecognitionCandidate[] = [];

            if (sessionGalleryRef.current.size > 0) {
              const targetRes = ANALYSIS_RESOLUTIONS[analysisPreference];
              const analysisW = targetRes.targetWidth;
              const analysisH = targetRes.targetHeight;

              for (const track of confirmedTracks) {
                const lastAttempt = lastMatchAttemptRef.current.get(track.trackId) || 0;
                if (captureStartWall - lastAttempt < 1000) {
                  continue;
                }
                lastMatchAttemptRef.current.set(track.trackId, captureStartWall);

                const quality = qualityGate.evaluate(
                  track.boundingBox,
                  track.landmarks,
                  track.confidence,
                  undefined,
                  undefined,
                  analysisW,
                  analysisH
                );

                if (quality.state === 'POOR') {
                  if (isCalibrationMode) {
                    const entry: CalibrationLogEntry = {
                      timestampIso: new Date(captureStartWall).toISOString(),
                      timestampMs: captureStartWall,
                      trackId: track.trackId,
                      qualityState: quality.state,
                      qualityScore: quality.score,
                      top1Score: null,
                      top1StudentId: null,
                      top1StudentName: null,
                      top2Score: null,
                      top2StudentId: null,
                      margin: null,
                      matchState: 'POOR_QUALITY',
                    };
                    calibrationLogsRef.current.push(entry);
                    setCalibrationLogsCount(calibrationLogsRef.current.length);
                  }
                  continue;
                }

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
                    BIOMETRIC_CONFIG.COSINE_SIMILARITY_THRESHOLD,
                    BIOMETRIC_CONFIG.TOP2_MARGIN_THRESHOLD,
                    EDGEFACE_XS_MANIFEST
                  );

                  // Calibration mode logging
                  if (isCalibrationMode) {
                    const entry: CalibrationLogEntry = {
                      timestampIso: new Date(captureStartWall).toISOString(),
                      timestampMs: captureStartWall,
                      trackId: track.trackId,
                      qualityState: quality.state,
                      qualityScore: quality.score,
                      top1Score: match.similarityScore ?? null,
                      top1StudentId: match.studentUserId ?? null,
                      top1StudentName: match.studentName ?? null,
                      top2Score: match.top2SimilarityScore ?? null,
                      top2StudentId: match.top2StudentUserId ?? null,
                      margin: match.top2Margin ?? null,
                      matchState: match.matchState ?? 'UNKNOWN',
                    };
                    calibrationLogsRef.current.push(entry);
                    setCalibrationLogsCount(calibrationLogsRef.current.length);
                  }

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
          } else {
            setDetectedFaces(mappedBoxes);
            if (staleClearTimerRef.current) clearTimeout(staleClearTimerRef.current);
            staleClearTimerRef.current = setTimeout(() => {
              if (isMounted) {
                setDetectedFaces([]);
              }
            }, 900);
          }
        }
      } catch (err: any) {
        console.warn('[DETECTION_LOOP] Error during frame detection:', err?.message || err);
      } finally {
        isDetectingRef.current = false;
        inFlightCountRef.current = Math.max(0, inFlightCountRef.current - 1);
        setQueueDepth(inFlightCountRef.current);

        if (isMounted && isCameraActive) {
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
  }, [
    isCameraActive,
    activeDetector,
    cameraPosition,
    yunetDetector,
    directDetector,
    viewfinderLayout,
    isCalibrationMode,
    isTrackingEnabled,
  ]);

  // Export calibration log as CSV via saveReportFile
  const exportCalibrationCsv = useCallback(async (): Promise<string> => {
    const logs = calibrationLogsRef.current;
    if (logs.length === 0) {
      Alert.alert('Calibration Log Empty', 'No calibration samples have been recorded yet.');
      return '';
    }

    const headers = [
      'timestamp_iso',
      'timestamp_ms',
      'track_id',
      'quality_state',
      'quality_score',
      'top1_score',
      'top1_student_id',
      'top1_student_name',
      'top2_score',
      'top2_student_id',
      'margin',
      'match_state',
    ].join(',');

    const rows = logs.map((e) =>
      [
        e.timestampIso,
        e.timestampMs,
        e.trackId,
        e.qualityState,
        e.qualityScore.toFixed(4),
        e.top1Score !== null ? e.top1Score.toFixed(4) : '',
        e.top1StudentId || '',
        `"${(e.top1StudentName || '').replace(/"/g, '""')}"`,
        e.top2Score !== null ? e.top2Score.toFixed(4) : '',
        e.top2StudentId || '',
        e.margin !== null ? e.margin.toFixed(4) : '',
        e.matchState,
      ].join(',')
    );

    const csvContent = [headers, ...rows].join('\n');
    const fileName = `klasio_calibration_${Date.now()}.csv`;
    try {
      const savedPath = await saveReportFile(fileName, csvContent, 'text/csv');
      Alert.alert(
        'Calibration Exported',
        `Exported ${logs.length} calibration samples successfully.\nFile: ${fileName}`
      );
      return savedPath;
    } catch (err: any) {
      Alert.alert('Export Failed', err?.message || 'Could not save CSV report file.');
      return '';
    }
  }, []);

  const clearCalibrationLogs = useCallback(() => {
    calibrationLogsRef.current = [];
    setCalibrationLogsCount(0);
  }, []);

  // Compute on-screen hints:
  // Hints: too dark, too far, face too small, hold steady, and "N of M roster students seen so far"
  const { activeHints, primaryHint } = useMemo(() => {
    const hints: string[] = [];

    // 1. Hold steady check
    if (scannerMotionState === 'PANNING') {
      hints.push('hold steady');
    }

    // Check detected face metrics
    if (detectedFaces.length > 0) {
      const smallFaces = detectedFaces.filter(
        (f) =>
          (f.rawBox && (f.rawBox.width < 0.08 || f.rawBox.height < 0.09)) ||
          f.width < 8 ||
          f.quality?.primaryReason === 'TOO_SMALL'
      );
      if (smallFaces.length > 0) {
        hints.push('face too small');
        hints.push('too far');
      }

      const darkFaces = detectedFaces.filter(
        (f) =>
          f.quality?.primaryReason === 'LOW_LIGHT' ||
          (f.quality?.score !== undefined && f.quality.score < 0.40 && f.quality.state === 'POOR')
      );
      if (darkFaces.length > 0) {
        hints.push('too dark');
      }
    }

    let primary: string | null = null;
    if (hints.includes('hold steady')) {
      primary = '⚠️ Camera moving too fast — hold steady';
    } else if (hints.includes('too dark')) {
      primary = '🌙 Lighting too dark — point towards light';
    } else if (hints.includes('too far') || hints.includes('face too small')) {
      primary = '🔍 Face too small — move closer to students';
    }

    return { activeHints: hints, primaryHint: primary };
  }, [scannerMotionState, detectedFaces]);

  const rosterStats = useMemo(() => {
    const recognizedCount = accumulatedCandidates.length;
    const total = Math.max(recognizedCount, totalRosterCount);
    return {
      recognizedCount,
      totalRosterCount: total,
      message: `${recognizedCount} of ${total} roster students seen so far`,
    };
  }, [accumulatedCandidates.length, totalRosterCount]);

  const getAccumulatedCandidates = useCallback(() => {
    return accumulatorRef.current.getAccumulatedCandidates();
  }, []);

  return {
    cameraRef,
    device,
    format,
    cameraPosition,
    handleSwitchCamera,
    isCameraActive,
    isPaused,
    handleTogglePause,
    hasPermission,
    isRequestingPermission,
    handleRequestPermission,
    cameraError,
    handleCameraError,

    // Layout & Focus
    viewfinderLayout,
    setViewfinderLayout,
    focusPoint,
    focusReticleAnim,
    isManualFocus,
    handleTapToFocus,
    handleResetAutoFocus,

    // Zoom
    zoom,
    zoomPresets,
    handleSetZoom,
    handleResetZoom,

    // Perception & Detections
    detectedFaces,
    accumulatedCandidates,
    scannerMotionState,
    activeDetector,
    setActiveDetector,
    analysisPreference,
    setAnalysisPreference,
    isTrackingEnabled,
    setIsTrackingEnabled,

    // Telemetry
    detectionLatencyMs,
    detectionCadenceFps,
    trackingCadenceFps,
    totalFramesAnalyzed,
    detailedTimings,
    trackerStats,
    displayedFrameId,
    resultAgeMs,
    captureToResultMs,
    queueDepth,
    droppedFramesCount,
    staleFramesCount,

    // Calibration
    isCalibrationMode,
    setIsCalibrationMode,
    calibrationLogsCount,
    exportCalibrationCsv,
    clearCalibrationLogs,

    // Hints & Roster
    activeHints,
    primaryHint,
    rosterStats,
    getAccumulatedCandidates,
    isGalleryLoaded,
  };
}
