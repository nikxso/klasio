import { useState, useRef, useCallback, useEffect } from 'react';
import { findNodeHandle } from 'react-native';
import { Camera } from 'react-native-vision-camera';

import { API_BASE_URL } from '@/config/api';
import { SessionStore } from '@/storage/sessionStore';
import { RosterRepository } from '@/storage/rosterRepository';
import {
  GuidedFaceEnrollmentController,
  EdgeFaceEmbedder,
  DirectOnDeviceDetector,
  EDGEFACE_XS_MANIFEST,
  FaceQualityGate,
} from '@/lab';
import type {
  RawFrame,
  FaceDetectionResult,
  StudentEnrollmentContext,
  EnrollmentGuidanceState,
} from '@/perception/contracts';
import { float32ArrayToBase64, GallerySyncService } from '@/perception/gallerySync';
import { capturePhotoFromCamera, uploadProfilePhoto } from '@/services/nativePerception';

export type EnrollmentStatus = 'READY' | 'GUIDING' | 'UPLOADING' | 'SUCCESS' | 'FAILURE';

export interface UseFaceEnrollmentOptions {
  studentUserId: string;
  studentName: string;
  institutionalId: string;
  academicTermId?: string;
  teachingAssignmentId?: string;
  isFacultyAssisted?: boolean;
  onCompleted?: () => void;
}

export function useFaceEnrollment(options: UseFaceEnrollmentOptions) {
  const {
    studentUserId,
    studentName,
    institutionalId,
    academicTermId = '2026-FALL-SEM5',
    teachingAssignmentId,
    isFacultyAssisted = false,
    onCompleted,
  } = options;

  const [status, setStatus] = useState<EnrollmentStatus>('READY');
  const [sampleIndex, setSampleIndex] = useState<number>(0);
  const [guidanceState, setGuidanceState] = useState<EnrollmentGuidanceState>('NO_FACE');
  const [guidanceMessage, setGuidanceMessage] = useState<string>('Center face inside the oval');
  const [qualityScore, setQualityScore] = useState<number>(0);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [enrollmentComplete, setEnrollmentComplete] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const cameraRef = useRef<Camera>(null);
  const embedderRef = useRef<EdgeFaceEmbedder>(new EdgeFaceEmbedder());
  const detectorRef = useRef<DirectOnDeviceDetector>(new DirectOnDeviceDetector(null, 0.40));
  const controllerRef = useRef<GuidedFaceEnrollmentController | null>(null);
  const qualityGateRef = useRef<FaceQualityGate>(new FaceQualityGate());
  const frontalPhotoRef = useRef<string | null>(null);

  // Dedicated directed photo alignment & capture phase refs
  const photoPhaseRef = useRef<'EMBEDDINGS' | 'PHOTO_ALIGNMENT' | 'PHOTO_DONE'>('EMBEDDINGS');
  const photoStableStartMsRef = useRef<number | null>(null);
  const photoPhaseStartMsRef = useRef<number | null>(null);

  // Self-rescheduling loop & in-flight guard refs
  const inFlightRef = useRef<boolean>(false);
  const loopActiveRef = useRef<boolean>(false);
  const loopTimerRef = useRef<any>(null);

  const cancelLoop = useCallback(() => {
    loopActiveRef.current = false;
    inFlightRef.current = false;
    photoStableStartMsRef.current = null;
    if (loopTimerRef.current) {
      clearTimeout(loopTimerRef.current);
      loopTimerRef.current = null;
    }
  }, []);

  const submitBiometricProfile = useCallback(async () => {
    if (!controllerRef.current) return;
    const profile = controllerRef.current.getCompletedProfile();
    if (!profile || profile.embeddings.length === 0) {
      setErrorMessage('No valid facial embeddings generated');
      setStatus('FAILURE');
      return;
    }

    setIsSubmitting(true);
    setStatus('UPLOADING');
    setErrorMessage(null);

    try {
      // Calculate real measured quality score from captured samples (not hardcoded 0.88 or 0.91)
      const samples = controllerRef.current.state?.samplesCaptured || [];
      const measuredQuality = samples.length > 0
        ? Number(
            (
              samples.reduce((sum, s) => sum + (s.quality?.score ?? 0.85), 0) /
              samples.length
            ).toFixed(3)
          )
        : 0.85;

      setQualityScore(measuredQuality);

      // Encode all captured multi-sample pose embeddings
      const b64Primary = float32ArrayToBase64(profile.embeddings[0]);
      const multiB64 = profile.embeddings.map((emb) => float32ArrayToBase64(emb));

      const payload = {
        student_user_id: profile.studentUserId,
        active_model_version: 'EdgeFace-XS-v1',
        embedding_dimension: profile.embeddingDimension,
        sample_count: profile.embeddings.length,
        embedding_base64: b64Primary,
        embeddings_base64: multiB64,
        quality_score: measuredQuality,
      };

      const token = SessionStore.getToken();
      const res = await fetch(`${API_BASE_URL}/api/v1/biometrics/enrollment`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errorBody = await res.text();
        throw new Error(`Enrollment rejected by server (${res.status}): ${errorBody}`);
      }

      const resData = await res.json();
      console.log('[FaceEnrollment] Server confirmed enrollment:', resData);

      // Update local student session if student self-registered
      const curSession = SessionStore.getSession();
      if (!isFacultyAssisted && curSession?.user && curSession.user.id === profile.studentUserId) {
        await SessionStore.setSession({
          ...curSession,
          user: {
            ...curSession.user,
            faceRegistrationState: 'REGISTERED',
          },
        });
      }

      // If faculty assisted, purge cached embeddings and refresh assignment gallery
      if (isFacultyAssisted) {
        try {
          await RosterRepository.clearCachedEmbeddingsForStudents([profile.studentUserId]);
          if (teachingAssignmentId && token) {
            await Promise.all([
              GallerySyncService.syncAssignmentGallery(teachingAssignmentId, token),
              RosterRepository.syncAssignmentRoster(teachingAssignmentId, token),
            ]);
          }
        } catch (cacheErr) {
          console.warn('[FaceEnrollment] Local gallery refresh warning:', cacheErr);
        }
      }

      // Upload captured frontal display photo so faculty can see the student's face on profile and rosters
      if (frontalPhotoRef.current) {
        try {
          await uploadProfilePhoto(profile.studentUserId, frontalPhotoRef.current, token);
          console.log('[FaceEnrollment] Frontal profile photo uploaded successfully for student:', profile.studentUserId);
        } catch (photoErr) {
          console.warn('[FaceEnrollment] Frontal photo upload warning:', photoErr);
        }
      }

      setEnrollmentComplete(true);
      setStatus('SUCCESS');
      if (onCompleted) {
        onCompleted();
      }
    } catch (err: any) {
      console.error('[FaceEnrollment] Submission failed:', err);
      // Strictly do NOT set enrollmentComplete on non-2xx response; show server error and allow retry
      setEnrollmentComplete(false);
      setStatus('FAILURE');
      setErrorMessage(err.message || 'Face registration failed. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  }, [studentUserId, isFacultyAssisted, teachingAssignmentId, onCompleted]);

  // Self-rescheduling frame processing loop with in-flight guard
  const runLoopTick = useCallback(async () => {
    if (!loopActiveRef.current || inFlightRef.current || !controllerRef.current) {
      return;
    }

    inFlightRef.current = true;
    try {
      const now = Date.now();
      const nodeHandle = cameraRef.current ? findNodeHandle(cameraRef.current) : null;
      if (nodeHandle) {
        detectorRef.current.setCameraTag(nodeHandle);
      }

      const rawFrame: RawFrame = {
        width: 640,
        height: 640,
        format: 'rgba',
        timestampMs: now,
        captureTimestampMs: now,
        data: '',
        rotationDegrees: 0,
      };

      let liveDetections: FaceDetectionResult[] = [];
      try {
        const detResult = await detectorRef.current.detectFacesDetailed(rawFrame);
        liveDetections = detResult.results || [];
      } catch {
        // Camera preview not bound or frame dropped
      }

      if (photoPhaseRef.current === 'EMBEDDINGS') {
        const nextState = await controllerRef.current.processFrame(rawFrame, liveDetections, now);
        setGuidanceState(nextState);
        setGuidanceMessage(controllerRef.current.state?.guidanceMessage || '');

        const captured = controllerRef.current.state?.samplesCaptured.length || 0;
        setSampleIndex(captured);

        // When all 3 diverse embeddings are captured, direct the face to center for profile snapshot
        if (nextState === 'COMPLETED' || captured >= 3) {
          photoPhaseRef.current = 'PHOTO_ALIGNMENT';
          photoPhaseStartMsRef.current = now;
          photoStableStartMsRef.current = null;
          setSampleIndex(3); // Advance to 4th step (Profile photo alignment)
          setGuidanceState('LOOK_AT_CAMERA');
          setGuidanceMessage('Look directly at camera · Center your face for profile photo');
        }
      } else if (photoPhaseRef.current === 'PHOTO_ALIGNMENT') {
        // Step 4: Directed frontal profile photo capture with eye-on-camera & centered face angle
        if (liveDetections.length === 0) {
          photoStableStartMsRef.current = null;
          setGuidanceState('NO_FACE');
          setGuidanceMessage('Position your face inside the oval frame');
        } else if (liveDetections.length > 1) {
          photoStableStartMsRef.current = null;
          setGuidanceState('MULTIPLE_FACES');
          setGuidanceMessage('Multiple faces detected — ensure only one person is in frame');
        } else {
          const det = liveDetections[0];
          const b = det.boundingBox;
          const cx = b.x + b.width / 2.0;
          const cy = b.y + b.height / 2.0;

          const q = qualityGateRef.current.evaluate(
            b,
            det.landmarks,
            det.confidence,
            undefined,
            undefined,
            rawFrame.width,
            rawFrame.height
          );
          const yaw = q.metrics.yawDegrees;
          const pitch = q.metrics.pitchDegrees;
          const roll = q.metrics.rollDegrees;

          const elapsedPhaseMs = now - (photoPhaseStartMsRef.current || now);
          const forceCapture = elapsedPhaseMs > 7000;

          if (!forceCapture && cx < 0.38) {
            photoStableStartMsRef.current = null;
            setGuidanceState('CENTER_FACE');
            setGuidanceMessage('Move slightly right');
          } else if (!forceCapture && cx > 0.62) {
            photoStableStartMsRef.current = null;
            setGuidanceState('CENTER_FACE');
            setGuidanceMessage('Move slightly left');
          } else if (!forceCapture && cy < 0.28) {
            photoStableStartMsRef.current = null;
            setGuidanceState('CENTER_FACE');
            setGuidanceMessage('Move slightly down');
          } else if (!forceCapture && cy > 0.72) {
            photoStableStartMsRef.current = null;
            setGuidanceState('CENTER_FACE');
            setGuidanceMessage('Move slightly up');
          } else if (!forceCapture && (b.width < 0.18 || b.width * b.height < 0.08)) {
            photoStableStartMsRef.current = null;
            setGuidanceState('MOVE_CLOSER');
            setGuidanceMessage('Move closer to the camera');
          } else if (!forceCapture && (b.width > 0.85 || b.width * b.height > 0.70)) {
            photoStableStartMsRef.current = null;
            setGuidanceState('MOVE_AWAY');
            setGuidanceMessage('Move back slightly');
          } else if (!forceCapture && yaw > 8) {
            photoStableStartMsRef.current = null;
            setGuidanceState('LOOK_AT_CAMERA');
            setGuidanceMessage('Turn head slightly left towards center');
          } else if (!forceCapture && yaw < -8) {
            photoStableStartMsRef.current = null;
            setGuidanceState('LOOK_AT_CAMERA');
            setGuidanceMessage('Turn head slightly right towards center');
          } else if (!forceCapture && pitch > 10) {
            photoStableStartMsRef.current = null;
            setGuidanceState('LOOK_AT_CAMERA');
            setGuidanceMessage('Lower your chin slightly');
          } else if (!forceCapture && pitch < -10) {
            photoStableStartMsRef.current = null;
            setGuidanceState('LOOK_AT_CAMERA');
            setGuidanceMessage('Raise your chin slightly');
          } else if (!forceCapture && Math.abs(roll) > 10) {
            photoStableStartMsRef.current = null;
            setGuidanceState('LOOK_AT_CAMERA');
            setGuidanceMessage('Keep your head level');
          } else {
            // Face is centered, eyes looking at camera, angles level!
            if (photoStableStartMsRef.current === null) {
              photoStableStartMsRef.current = now;
            }
            const stableMs = now - photoStableStartMsRef.current;
            if (stableMs < 350 && !forceCapture) {
              setGuidanceState('HOLD_STILL');
              setGuidanceMessage('Hold still · Centered! (Capturing...)');
            } else {
              photoPhaseRef.current = 'PHOTO_DONE';
              setGuidanceState('CAPTURING');
              setGuidanceMessage('Capturing profile photo...');
              cancelLoop();

              if (nodeHandle) {
                try {
                  const snap = await capturePhotoFromCamera(nodeHandle);
                  if (snap?.base64) {
                    frontalPhotoRef.current = snap.base64;
                  }
                } catch (snapErr) {
                  console.warn('[FaceEnrollment] Profile snap capture warning:', snapErr);
                }
              }

              await submitBiometricProfile();
              return;
            }
          }
        }
      }
    } catch (err: any) {
      console.warn('[FaceEnrollment] Loop tick error:', err);
    } finally {
      inFlightRef.current = false;
      if (loopActiveRef.current) {
        loopTimerRef.current = setTimeout(runLoopTick, 200);
      }
    }
  }, [cancelLoop, submitBiometricProfile]);

  const startEnrollment = useCallback(async () => {
    if (!studentUserId) {
      setErrorMessage('Missing required student identity context.');
      setStatus('FAILURE');
      return;
    }

    cancelLoop();
    frontalPhotoRef.current = null;
    photoPhaseRef.current = 'EMBEDDINGS';
    photoStableStartMsRef.current = null;
    photoPhaseStartMsRef.current = null;

    try {
      await embedderRef.current.initialize();
      const controller = new GuidedFaceEnrollmentController(embedderRef.current, {
        targetSamples: 3,
        stabilizationRequiredMs: 400,
        minPairwiseConsistency: 0.60,
        expectedManifest: EDGEFACE_XS_MANIFEST,
        steps: ['FRONTAL', 'SLIGHT_LEFT', 'SLIGHT_RIGHT'],
        enforcePoseAngles: true,
      });

      const studentContext: StudentEnrollmentContext = {
        studentUserId,
        institutionalId,
        studentName,
        academicTermId,
      };

      controller.startSession(studentContext);
      controllerRef.current = controller;

      setSampleIndex(0);
      setQualityScore(0);
      setGuidanceState('NO_FACE');
      setGuidanceMessage('Look directly at the camera (Frontal pose)');
      setErrorMessage(null);
      setEnrollmentComplete(false);
      setStatus('GUIDING');

      loopActiveRef.current = true;
      inFlightRef.current = false;
      loopTimerRef.current = setTimeout(runLoopTick, 100);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to start enrollment session');
      setStatus('FAILURE');
    }
  }, [studentUserId, institutionalId, studentName, academicTermId, cancelLoop, runLoopTick]);

  useEffect(() => {
    return () => {
      cancelLoop();
    frontalPhotoRef.current = null;
    };
  }, [cancelLoop]);

  return {
    cameraRef,
    status,
    sampleIndex,
    guidanceState,
    guidanceMessage,
    qualityScore,
    isSubmitting,
    enrollmentComplete,
    errorMessage,
    startEnrollment,
    cancelLoop,
  };
}
