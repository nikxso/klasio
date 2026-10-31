import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
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
  Eye,
} from 'lucide-react-native';
import Svg, { Circle } from 'react-native-svg';

import { Screen, Button, IconBubble, Card } from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';

const POSES = [
  { label: 'Look straight ahead', icon: Smile },
  { label: 'Turn slightly left', icon: ArrowLeft },
  { label: 'Turn slightly right', icon: ArrowRight },
  { label: 'Now blink once', icon: Eye },
];

export default function StudentEnrollmentScreen() {
  const router = useRouter();
  const [step, setStep] = useState<number>(-1);

  useEffect(() => {
    if (step < 0 || step >= POSES.length) return;
    const timer = setTimeout(() => {
      setStep((s) => s + 1);
    }, 1500);
    return () => clearTimeout(timer);
  }, [step]);

  const handleBack = () => {
    router.back();
  };

  if (step < 0) {
    return (
      <Screen
        onBack={handleBack}
        title="Set up Face ID"
        subtitle="So you're marked present automatically"
        scrollable
      >
        <View style={styles.heroCircleWrapper}>
          <View style={styles.heroCircle}>
            <ScanFace size={60} color={Colors.lilac} strokeWidth={1.5} />
          </View>
        </View>

        <View style={styles.guidanceItems}>
          <View style={styles.guidanceRow}>
            <IconBubble icon={Sparkles} tone="apricot" size={40} />
            <View style={styles.guidanceTextCol}>
              <Text style={styles.guidanceTitle}>Find good light</Text>
              <Text style={styles.guidanceDesc}>
                Face a window or a bright indoor lamp.
              </Text>
            </View>
          </View>

          <View style={styles.guidanceRow}>
            <IconBubble icon={Smile} tone="apricot" size={40} />
            <View style={styles.guidanceTextCol}>
              <Text style={styles.guidanceTitle}>Show your whole face</Text>
              <Text style={styles.guidanceDesc}>
                Take off heavy sunglasses or masks during setup.
              </Text>
            </View>
          </View>

          <View style={styles.guidanceRow}>
            <IconBubble icon={ShieldCheck} tone="forest" size={40} />
            <View style={styles.guidanceTextCol}>
              <Text style={styles.guidanceTitle}>Your privacy matters</Text>
              <Text style={styles.guidanceDesc}>
                We only derive an encrypted facial embedding pattern, never storing raw photos.
              </Text>
            </View>
          </View>
        </View>

        <Button onPress={() => setStep(0)} style={styles.readyButton}>
          <Text style={styles.buttonText}>I'm ready</Text>
        </Button>
      </Screen>
    );
  }

  const isDone = step >= POSES.length;
  const currentPose = POSES[Math.min(step, POSES.length - 1)];
  const PoseIcon = currentPose.icon;
  const progressPercent = Math.min((step / POSES.length) * 100, 100);

  return (
    <View style={styles.cameraContainer}>
      <Pressable onPress={handleBack} style={styles.closeButton}>
        <ChevronLeft size={24} color="#ffffff" />
      </Pressable>

      <View style={styles.viewfinderWrapper}>
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
            stroke={isDone ? '#7fd1ad' : Colors.apricot}
            strokeWidth="4"
            strokeDasharray="289"
            strokeDashoffset={289 - (289 * progressPercent) / 100}
            strokeLinecap="round"
            fill="none"
          />
        </Svg>

        <View style={styles.cameraOval}>
          <View style={styles.faceSilhouette}>
            {isDone ? (
              <Check size={56} color="#7fd1ad" strokeWidth={3} />
            ) : (
              <ScanFace size={64} color="rgba(255,255,255,0.7)" strokeWidth={1.5} />
            )}
          </View>
        </View>
      </View>

      <View style={styles.feedbackBlock}>
        {!isDone && (
          <View style={styles.poseIconBox}>
            <PoseIcon size={32} color={Colors.apricot} />
          </View>
        )}
        <Text style={styles.feedbackHeadline}>
          {isDone ? 'All set!' : currentPose.label}
        </Text>
        <Text style={styles.feedbackSub}>
          {isDone
            ? 'Your biometric template has been verified and registered.'
            : `Step ${step + 1} of ${POSES.length}`}
        </Text>
      </View>

      {isDone && (
        <Pressable onPress={handleBack} style={styles.finishButton}>
          <Text style={styles.finishButtonText}>Finish</Text>
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
    alignItems: 'center',
    justifyContent: 'center',
  },
  feedbackBlock: {
    alignItems: 'center',
    marginTop: 40,
  },
  poseIconBox: {
    marginBottom: 10,
  },
  feedbackHeadline: {
    fontSize: 26,
    fontWeight: '700',
    color: '#ffffff',
  },
  feedbackSub: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.65)',
    marginTop: 6,
    textAlign: 'center',
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
