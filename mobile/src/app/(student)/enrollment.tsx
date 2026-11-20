import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  ScanFace,
  Sparkles,
  Smile,
  ShieldCheck,
  ChevronLeft,
  Check,
  ArrowLeft,
  ArrowRight,
  AlertCircle,
} from 'lucide-react-native';
import Svg, { Circle } from 'react-native-svg';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
} from 'react-native-vision-camera';

import { Screen, Button, IconBubble, Card } from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';
import { Brand } from '@/constants/brand';
import { SessionStore } from '@/storage/sessionStore';
import { useFaceEnrollment } from '@/hooks/useFaceEnrollment';

const POSES = [
  { label: 'Look straight ahead', sublabel: 'Neutral expression', icon: Smile, step: 'FRONTAL' as const },
  { label: 'Turn slightly left', sublabel: 'Keep eyes level', icon: ArrowLeft, step: 'SLIGHT_LEFT' as const },
  { label: 'Turn slightly right', sublabel: 'Keep eyes level', icon: ArrowRight, step: 'SLIGHT_RIGHT' as const },
];

export default function StudentEnrollmentScreen() {
  const router = useRouter();
  const { hasPermission, requestPermission } = useCameraPermission();
  const frontDevice = useCameraDevice('front');

  // Authenticated student context
  const currentUser = SessionStore.getUser();
  const studentUserId = currentUser?.id || '0b0487b0-5be5-484f-80c1-8d5e2a0a7c94';
  const institutionalId = currentUser?.institutionalId || 'S3';
  const studentName = currentUser?.fullName || 'Student S3';

  // -1: Introduction / Consent screen; 0: Active guided camera registration
  const [sessionActive, setSessionActive] = useState<boolean>(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);

  const {
    cameraRef,
    status,
    sampleIndex,
    guidanceMessage,
    isSubmitting,
    enrollmentComplete,
    errorMessage,
    startEnrollment,
    cancelLoop,
  } = useFaceEnrollment({
    studentUserId,
    studentName,
    institutionalId,
    academicTermId: '2026-FALL-SEM5',
    isFacultyAssisted: false,
  });

  const handleBack = () => {
    cancelLoop();
    router.back();
  };

  const handleStartRegistration = async () => {
    setPermissionError(null);
    if (!hasPermission) {
      const granted = await requestPermission();
      if (!granted) {
        setPermissionError('Camera permission is required to enroll your biometric profile.');
        return;
      }
    }

    setSessionActive(true);
    await startEnrollment();
  };

  // Screen 1: Explanation, Privacy Boundary & Consent
  if (!sessionActive) {
    return (
      <Screen
        title="Biometric Face Registration"
        subtitle="Set up facial recognition so attendance can be verified quickly in class."
        left={
          <Pressable onPress={handleBack} style={{ padding: 4 }}>
            <ChevronLeft size={24} color={Colors.ink} />
          </Pressable>
        }
        scrollable
      >
        {/* Animated Face Scanner Hero */}
        <View style={styles.heroCircleWrapper}>
          <View style={styles.heroCircle}>
            <ScanFace size={56} color={Colors.lilac} strokeWidth={1.5} />
          </View>
        </View>

        {permissionError && (
          <View style={styles.errorAlert}>
            <AlertCircle size={18} color={Colors.rose} />
            <Text style={styles.errorText}>{permissionError}</Text>
          </View>
        )}

        {/* Informative Step-by-Step Card */}
        <Card style={styles.guidanceItems}>
          <View style={styles.guidanceRow}>
            <IconBubble icon={ScanFace} tone="lilac" size={40} />
            <View style={styles.guidanceTextCol}>
              <Text style={styles.guidanceTitle}>Guided Multi-Angle Verification</Text>
              <Text style={styles.guidanceDesc}>
                You will be prompted to look forward, slightly left, and slightly right to capture consistent reference angles.
              </Text>
            </View>
          </View>

          <View style={styles.guidanceRow}>
            <IconBubble icon={Sparkles} tone="apricot" size={40} />
            <View style={styles.guidanceTextCol}>
              <Text style={styles.guidanceTitle}>Immediate On-Device Processing</Text>
              <Text style={styles.guidanceDesc}>
                Our lightweight edge neural network processes frames locally on your device without transmitting raw camera video.
              </Text>
            </View>
          </View>

          <View style={styles.guidanceRow}>
            <IconBubble icon={ShieldCheck} tone="forest" size={40} />
            <View style={styles.guidanceTextCol}>
              <Text style={styles.guidanceTitle}>Your biometric privacy</Text>
              <Text style={styles.guidanceDesc}>
                {Brand.name} never stores photos or video. Raw camera frames stay in ephemeral memory; only an encrypted 512-D mathematical template is retained.
              </Text>
            </View>
          </View>
        </Card>

        <Button onPress={handleStartRegistration} style={styles.readyButton}>
          <Text style={styles.buttonText}>I'm ready</Text>
        </Button>
      </Screen>
    );
  }

  // Screen 2: Live Vision Camera Viewfinder with Circular SVG Ring
  const currentPose = POSES[Math.min(sampleIndex, POSES.length - 1)];
  const PoseIcon = currentPose.icon;
  const progressPercent = Math.min((sampleIndex / POSES.length) * 100, 100);

  return (
    <View style={styles.cameraContainer}>
      {/* Top Controls */}
      <Pressable onPress={handleBack} style={styles.closeButton} accessibilityLabel="Cancel enrollment">
        <ChevronLeft size={24} color="#ffffff" />
      </Pressable>

      <View style={styles.viewfinderWrapper}>
        {/* Animated Circular Progress Ring */}
        <Svg width={220} height={220} viewBox="0 0 100 100" style={styles.svgRing}>
          <Circle
            cx="50"
            cy="50"
            r="46"
            stroke="rgba(255, 255, 255, 0.2)"
            strokeWidth="4"
            fill="none"
          />
          <Circle
            cx="50"
            cy="50"
            r="46"
            stroke={enrollmentComplete ? '#7fd1ad' : Colors.apricot}
            strokeWidth="4"
            strokeDasharray="289"
            strokeDashoffset={289 - (289 * progressPercent) / 100}
            strokeLinecap="round"
            fill="none"
          />
        </Svg>

        {/* Viewfinder Oval with Live Camera Preview */}
        <View style={styles.cameraOval}>
          {frontDevice && hasPermission && !enrollmentComplete ? (
            <Camera
              ref={cameraRef}
              style={StyleSheet.absoluteFill}
              device={frontDevice}
              isActive={sessionActive && !enrollmentComplete}
            />
          ) : null}

          {/* Overlay Silhouette & Status Icon */}
          <View style={styles.faceSilhouette}>
            {enrollmentComplete ? (
              <Check size={56} color="#7fd1ad" strokeWidth={3} />
            ) : isSubmitting ? (
              <ActivityIndicator size="large" color={Colors.apricot} />
            ) : (
              <ScanFace size={64} color="rgba(255,255,255,0.7)" strokeWidth={1.5} />
            )}
          </View>
        </View>
      </View>

      {/* Real-Time Dynamic Guidance Feedback */}
      <View style={styles.feedbackBlock}>
        {!enrollmentComplete && (
          <View style={styles.poseIconBox}>
            <PoseIcon size={32} color={Colors.apricot} />
          </View>
        )}
        <Text style={styles.feedbackHeadline}>
          {enrollmentComplete
            ? 'All set!'
            : errorMessage
            ? 'Registration Failed'
            : isSubmitting
            ? 'Validating template...'
            : currentPose.label}
        </Text>
        <Text style={styles.feedbackSub}>
          {enrollmentComplete
            ? 'Your biometric profile is mathematically verified and registered.'
            : errorMessage
            ? errorMessage
            : isSubmitting
            ? 'Verifying unit L2 normalization and intra-student consistency...'
            : guidanceMessage}
        </Text>
        {!enrollmentComplete && !isSubmitting && !errorMessage && (
          <Text style={styles.stepBadge}>
            Step {Math.min(sampleIndex + 1, POSES.length)} of {POSES.length} · {currentPose.sublabel}
          </Text>
        )}
      </View>

      {/* Completion or Error Action */}
      {enrollmentComplete && (
        <Pressable onPress={handleBack} style={styles.finishButton}>
          <Text style={styles.finishButtonText}>Finish & return to profile</Text>
        </Pressable>
      )}

      {errorMessage && (
        <Pressable
          onPress={handleStartRegistration}
          style={[styles.finishButton, { backgroundColor: Colors.rose }]}
        >
          <Text style={[styles.finishButtonText, { color: '#ffffff' }]}>Recapture</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  heroCircleWrapper: {
    alignItems: 'center',
    marginVertical: 24,
  },
  heroCircle: {
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: Colors.lilac50,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorAlert: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(239, 68, 68, 0.1)',
    borderRadius: Radii.card,
    padding: 12,
    marginHorizontal: 8,
    marginBottom: 16,
    gap: 8,
  },
  errorText: {
    flex: 1,
    color: Colors.rose,
    fontSize: 13,
    fontWeight: '500',
  },
  guidanceItems: {
    gap: 16,
    paddingHorizontal: 8,
  },
  guidanceRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 14,
  },
  guidanceTextCol: {
    flex: 1,
  },
  guidanceTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: Colors.ink,
  },
  guidanceDesc: {
    fontSize: 13,
    color: Colors.soft,
    marginTop: 2,
    lineHeight: 18,
  },
  readyButton: {
    marginTop: 36,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  cameraContainer: {
    flex: 1,
    backgroundColor: '#1f1a29',
    alignItems: 'center',
    paddingTop: 60,
    paddingHorizontal: 24,
  },
  closeButton: {
    position: 'absolute',
    top: 50,
    left: 20,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },
  viewfinderWrapper: {
    width: 220,
    height: 220,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 40,
  },
  svgRing: {
    position: 'absolute',
    transform: [{ rotate: '-90deg' }],
  },
  cameraOval: {
    width: 190,
    height: 190,
    borderRadius: 95,
    backgroundColor: '#2d2639',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  faceSilhouette: {
    position: 'absolute',
    alignItems: 'center',
    justifyContent: 'center',
  },
  feedbackBlock: {
    alignItems: 'center',
    marginTop: 40,
    paddingHorizontal: 16,
  },
  poseIconBox: {
    marginBottom: 10,
  },
  feedbackHeadline: {
    fontSize: 24,
    fontWeight: '700',
    color: '#ffffff',
    textAlign: 'center',
  },
  feedbackSub: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.7)',
    marginTop: 6,
    textAlign: 'center',
    lineHeight: 20,
  },
  stepBadge: {
    marginTop: 10,
    fontSize: 12,
    fontWeight: '600',
    color: Colors.apricot,
    backgroundColor: 'rgba(240, 168, 104, 0.15)',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
  },
  finishButton: {
    marginTop: 'auto',
    marginBottom: 40,
    width: '100%',
    paddingVertical: 14,
    borderRadius: Radii.button,
    backgroundColor: Colors.apricot,
    alignItems: 'center',
  },
  finishButtonText: {
    color: '#1f1a29',
    fontSize: 16,
    fontWeight: '700',
  },
});
