import React, { useState, useEffect } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Pressable,
  ActivityIndicator,
  ScrollView,
  SafeAreaView,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
} from 'react-native-vision-camera';
import Svg, { Circle } from 'react-native-svg';
import {
  ArrowLeft,
  Camera as CameraIcon,
  CheckCircle2,
  AlertCircle,
  RotateCcw,
  ScanFace,
  ShieldCheck,
  RefreshCw,
  Smile,
  ArrowRight,
  ChevronLeft,
} from 'lucide-react-native';

import { Colors, Radii } from '@/theme/tokens';
import { AccessRestrictedView } from '@/components/ui/kit';
import { SessionStore } from '@/storage/sessionStore';
import { useFaceEnrollment } from '@/hooks/useFaceEnrollment';

const POSES = [
  { label: 'Look straight ahead', sublabel: 'Neutral expression', icon: Smile, step: 'FRONTAL' as const },
  { label: 'Turn slightly left', sublabel: 'Keep eyes level', icon: ArrowLeft, step: 'SLIGHT_LEFT' as const },
  { label: 'Turn slightly right', sublabel: 'Keep eyes level', icon: ArrowRight, step: 'SLIGHT_RIGHT' as const },
  { label: 'Look directly into camera', sublabel: 'Center face for profile photo', icon: ScanFace, step: 'PROFILE_PHOTO' as const },
];

export default function FacultyEnrollmentScreen() {
  const router = useRouter();

  if (!SessionStore.canConductAssistedEnrollment()) {
    return (
      <AccessRestrictedView
        title="Biometric Enrollment Restricted"
        message="Assisted biometric enrollment requires Biometric Enrollment Officer or authorized faculty permissions."
        requiredCapability="biometrics.enroll.assisted"
        onBack={() => router.replace('/(faculty)' as any)}
      />
    );
  }

  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    studentUserId?: string;
    studentName?: string;
    institutionalId?: string;
    teachingAssignmentId?: string;
    sectionCode?: string;
  }>();

  const studentUserId = params.studentUserId || '';
  const studentName = params.studentName || 'Student';
  const institutionalId = params.institutionalId || '';
  const sectionCode = params.sectionCode || '';
  const teachingAssignmentId = params.teachingAssignmentId || '';

  const { hasPermission, requestPermission } = useCameraPermission();
  const [cameraPosition, setCameraPosition] = useState<'front' | 'back'>('back');
  const device = useCameraDevice(cameraPosition);

  const {
    cameraRef,
    status,
    sampleIndex,
    guidanceMessage,
    qualityScore,
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
    teachingAssignmentId,
    isFacultyAssisted: true,
  });

  useEffect(() => {
    if (!hasPermission) {
      requestPermission();
    }
  }, [hasPermission]);

  const handleBack = () => {
    cancelLoop();
    router.back();
  };

  const handleToggleCamera = () => {
    setCameraPosition((prev) => (prev === 'front' ? 'back' : 'front'));
  };

  const handleStartCapture = async () => {
    if (!studentUserId) return;
    if (!hasPermission) {
      const granted = await requestPermission();
      if (!granted) return;
    }
    await startEnrollment();
  };

  const currentPose = POSES[Math.min(sampleIndex, POSES.length - 1)];
  const PoseIcon = currentPose.icon;
  const progressPercent = Math.min((sampleIndex / POSES.length) * 100, 100);

  // Screen 1: Target Student Profile & Consent Details
  if (status === 'READY') {
    return (
      <SafeAreaView style={[styles.container, { paddingTop: insets.top }]}>
        <StatusBar style="dark" />

        {/* Header */}
        <View style={styles.header}>
          <TouchableOpacity
            style={styles.backButton}
            onPress={handleBack}
            accessibilityLabel="Back to roster"
          >
            <ArrowLeft size={22} color={Colors.ink} />
          </TouchableOpacity>
          <View style={styles.headerTitleContainer}>
            <Text style={styles.headerTitle}>Biometric Enrollment</Text>
            <Text style={styles.headerSubtitle}>
              {sectionCode ? `Section ${sectionCode}` : 'Faculty Assisted'}
            </Text>
          </View>
          <View style={{ width: 40 }} />
        </View>

        <ScrollView contentContainerStyle={styles.contentContainer}>
          {/* Target Student Identity Card */}
          <View style={styles.profileCard}>
            <View style={styles.avatarBubble}>
              <ScanFace size={40} color={Colors.lilac} strokeWidth={1.5} />
            </View>
            <Text style={styles.studentNameText}>{studentName}</Text>
            <Text style={styles.metaText}>
              ID: {institutionalId || 'N/A'} · Roll No: {institutionalId || studentUserId.slice(0, 8)}
            </Text>
            <View style={styles.modelBadge}>
              <ShieldCheck size={14} color={Colors.forest} />
              <Text style={styles.modelBadgeText}>Authorized Enrollment Scope</Text>
            </View>
          </View>

          {/* Enrollment Protocol Guidance */}
          <View style={styles.guidanceBox}>
            <Text style={styles.guidanceTitle}>Guided Multi-Sample Capture</Text>
            <Text style={styles.guidanceBody}>
              The student will be guided through 4 consecutive genuine face observations:
            </Text>
            <View style={styles.stepItem}>
              <Text style={styles.stepNum}>1.</Text>
              <Text style={styles.stepText}>Frontal direct view with neutral expression</Text>
            </View>
            <View style={styles.stepItem}>
              <Text style={styles.stepNum}>2.</Text>
              <Text style={styles.stepText}>Turn head slightly to the left</Text>
            </View>
            <View style={styles.stepItem}>
              <Text style={styles.stepNum}>3.</Text>
              <Text style={styles.stepText}>Turn head slightly to the right</Text>
            </View>
            <View style={styles.stepItem}>
              <Text style={styles.stepNum}>4.</Text>
              <Text style={styles.stepText}>Direct eye-on-camera snapshot for profile photo</Text>
            </View>
          </View>

          <TouchableOpacity style={styles.primaryButton} onPress={handleStartCapture}>
            <CameraIcon size={20} color="#fff" />
            <Text style={styles.primaryButtonText}>Begin Guided Registration</Text>
          </TouchableOpacity>

          <TouchableOpacity style={styles.secondaryButton} onPress={handleBack}>
            <Text style={styles.secondaryButtonText}>Cancel</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // Screen 2: Guided Vision Camera Viewfinder with SVG Circular Ring
  if (status === 'GUIDING' || status === 'UPLOADING') {
    return (
      <View style={styles.cameraWrapper}>
        <StatusBar style="light" />

        {device && hasPermission ? (
          <Camera
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            device={device}
            isActive={status === 'GUIDING'}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.cameraPlaceholder]}>
            <ScanFace size={64} color="#666" />
            <Text style={styles.placeholderText}>Camera not available</Text>
          </View>
        )}

        {/* Viewfinder Overlay with Circular SVG Ring */}
        <View style={styles.overlayContainer}>
          <View style={styles.viewfinderWrapper}>
            <Svg width={260} height={260} viewBox="0 0 100 100" style={styles.svgRing}>
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
                stroke={status === 'UPLOADING' ? '#7fd1ad' : Colors.apricot}
                strokeWidth="4"
                strokeDasharray="289"
                strokeDashoffset={289 - (289 * progressPercent) / 100}
                strokeLinecap="round"
                fill="none"
              />
            </Svg>
            <View style={styles.cameraOval} />
          </View>
        </View>

        {/* Top Header & Camera Toggle */}
        <SafeAreaView style={styles.topHeaderOverlay}>
          <TouchableOpacity style={styles.iconCircleBtn} onPress={handleBack}>
            <ChevronLeft size={24} color="#fff" />
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconCircleBtn} onPress={handleToggleCamera}>
            <RotateCcw size={20} color="#fff" />
          </TouchableOpacity>
        </SafeAreaView>

        {/* Dynamic Real-time Guidance Banner */}
        <View style={styles.guidanceBanner}>
          <Text style={styles.guidanceBannerText}>
            {status === 'UPLOADING' ? 'Uploading template vectors...' : guidanceMessage}
          </Text>
        </View>

        {/* Bottom Poses Step Indicator */}
        <View style={styles.progressFooter}>
          <View style={styles.stepsRow}>
            {POSES.map((p, idx) => {
              const isDone = idx < sampleIndex;
              const isCurrent = idx === sampleIndex && status === 'GUIDING';
              return (
                <View
                  key={p.step}
                  style={[
                    styles.stepChip,
                    isCurrent && styles.stepChipActive,
                    isDone && styles.stepChipDone,
                  ]}
                >
                  <Text style={[styles.stepChipText, isCurrent && styles.stepChipTextActive]}>
                    {idx + 1}
                  </Text>
                  <Text style={[styles.stepChipLabel, isDone && styles.stepChipLabelDone]}>
                    {p.step === 'FRONTAL' ? 'Front' : p.step === 'SLIGHT_LEFT' ? 'Left' : 'Right'}
                  </Text>
                </View>
              );
            })}
          </View>

          {status === 'UPLOADING' && (
            <View style={styles.uploadingBox}>
              <ActivityIndicator color={Colors.apricot} size="small" />
              <Text style={styles.uploadingText}>Verifying unit normalization...</Text>
            </View>
          )}
        </View>
      </View>
    );
  }

  // Screen 3: Success Result State
  if (status === 'SUCCESS') {
    return (
      <SafeAreaView style={[styles.container, { paddingTop: insets.top }]}>
        <StatusBar style="dark" />
        <View style={styles.resultContainer}>
          <View style={styles.successIconCircle}>
            <CheckCircle2 size={56} color={Colors.forest} strokeWidth={2.5} />
          </View>
          <Text style={styles.resultTitle}>Registration Complete</Text>
          <Text style={styles.resultSubtitle}>
            {studentName} is now registered for biometric attendance verification.
          </Text>

          <View style={styles.summaryCard}>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Student Name</Text>
              <Text style={styles.summaryValue}>{studentName}</Text>
            </View>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Institutional ID</Text>
              <Text style={styles.summaryValue}>{institutionalId || studentUserId.slice(0, 8)}</Text>
            </View>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Multi-Sample Poses</Text>
              <Text style={styles.summaryValue}>3 of 3 (Frontal, Left, Right)</Text>
            </View>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Measured Quality Score</Text>
              <Text style={styles.summaryValue}>{(qualityScore * 100).toFixed(1)}%</Text>
            </View>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Model Manifest</Text>
              <Text style={styles.summaryValue}>EdgeFace-XS (512-D)</Text>
            </View>
          </View>

          <TouchableOpacity style={styles.primaryButton} onPress={handleBack}>
            <Text style={styles.primaryButtonText}>Return to Class Roster</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // Screen 4: Failure State
  return (
    <SafeAreaView style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar style="dark" />
      <View style={styles.resultContainer}>
        <View style={styles.failureIconCircle}>
          <AlertCircle size={56} color={Colors.rose} strokeWidth={2.5} />
        </View>
        <Text style={styles.resultTitle}>Enrollment Failed</Text>
        <Text style={styles.resultSubtitle}>
          {errorMessage || 'The server rejected or could not complete biometric registration.'}
        </Text>

        <TouchableOpacity style={styles.primaryButton} onPress={handleStartCapture}>
          <RefreshCw size={20} color="#fff" />
          <Text style={styles.primaryButtonText}>Try Again</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.secondaryButton} onPress={handleBack}>
          <Text style={styles.secondaryButtonText}>Cancel & Go Back</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Colors.cream,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.line,
  },
  backButton: {
    padding: 8,
  },
  headerTitleContainer: {
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.ink,
  },
  headerSubtitle: {
    fontSize: 13,
    color: Colors.soft,
  },
  contentContainer: {
    padding: 20,
  },
  profileCard: {
    backgroundColor: Colors.card,
    borderRadius: Radii.card,
    padding: 20,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.line,
    marginBottom: 20,
  },
  avatarBubble: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: Colors.lilac50,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  studentNameText: {
    fontSize: 20,
    fontWeight: '800',
    color: Colors.ink,
    marginBottom: 4,
  },
  metaText: {
    fontSize: 14,
    color: Colors.soft,
    marginBottom: 12,
  },
  modelBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.forest50,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: Radii.pill,
  },
  modelBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.forest,
  },
  guidanceBox: {
    backgroundColor: Colors.card,
    borderRadius: Radii.card,
    padding: 20,
    borderWidth: 1,
    borderColor: Colors.line,
    marginBottom: 24,
  },
  guidanceTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.ink,
    marginBottom: 8,
  },
  guidanceBody: {
    fontSize: 14,
    color: Colors.soft,
    marginBottom: 12,
    lineHeight: 20,
  },
  stepItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 8,
    gap: 8,
  },
  stepNum: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.forest,
  },
  stepText: {
    fontSize: 14,
    color: Colors.ink,
    flex: 1,
  },
  primaryButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
    backgroundColor: Colors.forest,
    paddingVertical: 16,
    borderRadius: Radii.button,
    marginVertical: 8,
    width: '100%',
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.card,
  },
  secondaryButton: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 14,
    borderRadius: Radii.button,
    width: '100%',
  },
  secondaryButtonText: {
    fontSize: 15,
    fontWeight: '600',
    color: Colors.soft,
  },
  cameraWrapper: {
    flex: 1,
    backgroundColor: '#000',
    position: 'relative',
  },
  cameraPlaceholder: {
    backgroundColor: '#1a1820',
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholderText: {
    color: '#8b8496',
    marginTop: 12,
    fontSize: 14,
  },
  overlayContainer: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewfinderWrapper: {
    width: 260,
    height: 260,
    alignItems: 'center',
    justifyContent: 'center',
  },
  svgRing: {
    position: 'absolute',
    transform: [{ rotate: '-90deg' }],
  },
  cameraOval: {
    width: 230,
    height: 230,
    borderRadius: 115,
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.4)',
    backgroundColor: 'transparent',
  },
  topHeaderOverlay: {
    position: 'absolute',
    top: 20,
    left: 20,
    right: 20,
    flexDirection: 'row',
    justifyContent: 'space-between',
    zIndex: 10,
  },
  iconCircleBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  guidanceBanner: {
    position: 'absolute',
    top: 90,
    left: 24,
    right: 24,
    backgroundColor: 'rgba(42, 35, 56, 0.85)',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: Radii.pill,
    alignItems: 'center',
  },
  guidanceBannerText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
  progressFooter: {
    position: 'absolute',
    bottom: 40,
    left: 20,
    right: 20,
    alignItems: 'center',
  },
  stepsRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  stepChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(255, 255, 255, 0.25)',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: Radii.pill,
  },
  stepChipActive: {
    backgroundColor: Colors.apricot,
  },
  stepChipDone: {
    backgroundColor: Colors.forest50,
  },
  stepChipText: {
    fontSize: 13,
    fontWeight: '700',
    color: '#fff',
  },
  stepChipTextActive: {
    color: Colors.ink,
  },
  stepChipLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#fff',
  },
  stepChipLabelDone: {
    color: Colors.forest,
  },
  uploadingBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: Radii.pill,
  },
  uploadingText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
  },
  resultContainer: {
    flex: 1,
    padding: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  successIconCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: Colors.forest50,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  failureIconCircle: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: Colors.rose50,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  resultTitle: {
    fontSize: 22,
    fontWeight: '800',
    color: Colors.ink,
    marginBottom: 8,
  },
  resultSubtitle: {
    fontSize: 15,
    color: Colors.soft,
    textAlign: 'center',
    marginBottom: 24,
    paddingHorizontal: 16,
    lineHeight: 22,
  },
  summaryCard: {
    width: '100%',
    backgroundColor: Colors.card,
    borderRadius: Radii.card,
    padding: 18,
    borderWidth: 1,
    borderColor: Colors.line,
    marginBottom: 24,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.line,
  },
  summaryLabel: {
    fontSize: 14,
    color: Colors.soft,
  },
  summaryValue: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.ink,
  },
});
