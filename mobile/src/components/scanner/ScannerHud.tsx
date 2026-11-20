import React from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Animated,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  X,
  Pause,
  Play,
  Camera as SwitchCamera,
  RotateCcw,
  Sparkles,
  AlertTriangle,
  Moon,
  Users,
} from 'lucide-react-native';
import type { DetectedFaceBox } from '../../hooks/useCameraDetection';

export interface ScannerHudProps {
  viewfinderLayout: { width: number; height: number };
  detectedFaces: DetectedFaceBox[];
  focusPoint: { x: number; y: number; id: number } | null;
  focusReticleAnim: Animated.Value;
  zoom: number;
  zoomPresets: number[];
  onSetZoom: (targetZoom: number) => void;
  isManualFocus: boolean;
  onResetAutoFocus: () => void;
  subjectTitle?: string;
  sectionCode?: string;
  cameraPosition: 'back' | 'front';
  onSwitchCamera: () => void;
  isPaused: boolean;
  onTogglePause: () => void;
  onClose: () => void;
  activeHints: string[];
  primaryHint: string | null;
  rosterStats: {
    recognizedCount: number;
    totalRosterCount: number;
    message: string;
  };
  isCalibrationMode?: boolean;
}

export const ScannerHud: React.FC<ScannerHudProps> = ({
  viewfinderLayout,
  detectedFaces,
  focusPoint,
  focusReticleAnim,
  zoom,
  zoomPresets,
  onSetZoom,
  isManualFocus,
  onResetAutoFocus,
  subjectTitle = 'Data Structures',
  sectionCode = 'CSE 3A',
  cameraPosition,
  onSwitchCamera,
  isPaused,
  onTogglePause,
  onClose,
  activeHints,
  primaryHint,
  rosterStats,
  isCalibrationMode,
}) => {
  const insets = useSafeAreaInsets();

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      {/* Darkening gradient overlays */}
      <View style={styles.gradientTop} pointerEvents="none" />
      <View style={styles.gradientBottom} pointerEvents="none" />

      {/* Top Floating Header */}
      <View
        style={[
          styles.topFloatingControls,
          {
            paddingTop: Math.max(insets.top, 16) + 4,
            paddingLeft: Math.max(insets.left, 16),
            paddingRight: Math.max(insets.right, 16),
          },
        ]}
      >
        <TouchableOpacity
          style={styles.headerIconButton}
          onPress={onClose}
          activeOpacity={0.7}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <X size={20} color="#ffffff" />
        </TouchableOpacity>

        <View style={styles.headerCenterColumn}>
          <View style={styles.badgeContainer}>
            <Text style={styles.badgeTextBold} numberOfLines={1}>
              {subjectTitle}
            </Text>
            <Text style={styles.badgeTextSub}> • {sectionCode}</Text>
          </View>

          {/* Roster students seen so far badge */}
          <View style={styles.rosterSeenPill}>
            <Users size={11} color="#7fd1ad" style={{ marginRight: 4 }} />
            <Text style={styles.rosterSeenText}>{rosterStats.message}</Text>
          </View>
        </View>

        <View style={styles.headerActionsRight}>
          <TouchableOpacity
            style={styles.headerIconButton}
            onPress={onSwitchCamera}
            activeOpacity={0.7}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            <SwitchCamera size={19} color="#ffffff" />
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.headerIconButton, isPaused && styles.headerIconButtonActive]}
            onPress={onTogglePause}
            activeOpacity={0.7}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          >
            {isPaused ? <Play size={18} color="#ffffff" /> : <Pause size={18} color="#ffffff" />}
          </TouchableOpacity>
        </View>
      </View>

      {/* On-screen Hints Banner (too dark, too far, face too small, hold steady) */}
      {primaryHint && (
        <View style={styles.hintBannerContainer} pointerEvents="none">
          <View
            style={[
              styles.hintBannerPill,
              activeHints.includes('hold steady') && styles.hintBannerPillWarning,
              activeHints.includes('too dark') && styles.hintBannerPillDark,
            ]}
          >
            {activeHints.includes('hold steady') && (
              <AlertTriangle size={14} color="#f0a868" style={{ marginRight: 6 }} />
            )}
            {activeHints.includes('too dark') && (
              <Moon size={14} color="#90b8f8" style={{ marginRight: 6 }} />
            )}
            {activeHints.includes('face too small') && !activeHints.includes('hold steady') && (
              <Sparkles size={14} color="#ffd166" style={{ marginRight: 6 }} />
            )}
            <Text style={styles.hintBannerText}>{primaryHint}</Text>
          </View>
        </View>
      )}

      {/* Calibration Mode active watermark */}
      {isCalibrationMode && (
        <View style={styles.calibrationWatermark} pointerEvents="none">
          <Text style={styles.calibrationWatermarkText}>⚙️ CALIBRATION MODE ACTIVE</Text>
        </View>
      )}

      {/* Viewfinder Framing Guides (Corner Brackets) */}
      <View style={styles.viewfinderFrame} pointerEvents="none">
        <View style={[styles.cornerBracket, styles.cornerTL]} />
        <View style={[styles.cornerBracket, styles.cornerTR]} />
        <View style={[styles.cornerBracket, styles.cornerBL]} />
        <View style={[styles.cornerBracket, styles.cornerBR]} />
      </View>

      {/* Detected Face Bounding Box & Facial Landmark Overlays */}
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        {detectedFaces.map((face) => {
          const isCoasting = face.trackingState === 'coasting' || face.isStale;
          const isConfirmed = face.trackingState === 'confirmed' || face.isConfirmed;
          const qualityState = face.quality?.state;

          const boxBorderColor = isCoasting
            ? 'rgba(255, 255, 255, 0.35)'
            : qualityState === 'POOR'
            ? '#e07a7a'
            : qualityState === 'FAIR'
            ? '#f0c674'
            : isConfirmed
            ? '#5ce6a1'
            : '#7fd1ad';

          return (
            <View
              key={face.id}
              style={[
                styles.faceBox,
                {
                  left: `${face.x}%`,
                  top: `${face.y}%`,
                  width: `${face.width}%`,
                  height: `${face.height}%`,
                  borderColor: boxBorderColor,
                },
                isCoasting && styles.faceBoxCoasting,
              ]}
            >
              {/* Quality & Tracking state tag */}
              <View
                style={[
                  styles.faceBadge,
                  {
                    backgroundColor: isCoasting
                      ? 'rgba(70, 70, 70, 0.85)'
                      : qualityState === 'POOR'
                      ? 'rgba(224, 122, 122, 0.90)'
                      : qualityState === 'FAIR'
                      ? 'rgba(240, 198, 116, 0.90)'
                      : 'rgba(35, 134, 54, 0.90)',
                  },
                ]}
              >
                <Text style={styles.faceBadgeText}>
                  {face.trackId !== undefined ? `ID #${face.trackId}` : 'DETECTED'}
                  {qualityState ? ` • ${qualityState}` : ''}
                </Text>
              </View>

              {/* 5-Point Facial Landmarks */}
              {face.landmarks && (
                <>
                  <View
                    style={[
                      styles.landmarkDot,
                      { left: `${face.landmarks.leftEye.x}%`, top: `${face.landmarks.leftEye.y}%` },
                    ]}
                  />
                  <View
                    style={[
                      styles.landmarkDot,
                      { left: `${face.landmarks.rightEye.x}%`, top: `${face.landmarks.rightEye.y}%` },
                    ]}
                  />
                  <View
                    style={[
                      styles.landmarkDot,
                      { left: `${face.landmarks.noseTip.x}%`, top: `${face.landmarks.noseTip.y}%` },
                    ]}
                  />
                  <View
                    style={[
                      styles.landmarkDot,
                      { left: `${face.landmarks.mouthLeft.x}%`, top: `${face.landmarks.mouthLeft.y}%` },
                    ]}
                  />
                  <View
                    style={[
                      styles.landmarkDot,
                      { left: `${face.landmarks.mouthRight.x}%`, top: `${face.landmarks.mouthRight.y}%` },
                    ]}
                  />
                </>
              )}
            </View>
          );
        })}
      </View>

      {/* Animated Tap-to-Focus Reticle */}
      {focusPoint && (
        <Animated.View
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
                    outputRange: [1.35, 1],
                  }),
                },
              ],
            },
          ]}
          pointerEvents="none"
        >
          <View style={styles.focusReticleInner} />
        </Animated.View>
      )}

      {/* Floating Camera Operator Controls Bar (Zoom & Focus) */}
      <View style={styles.floatingControlsBar} pointerEvents="box-none">
        {/* Zoom Presets */}
        <View style={styles.zoomPillGroup}>
          {zoomPresets.map((z) => {
            const isActive = Math.abs(zoom - z) < 0.1;
            return (
              <TouchableOpacity
                key={z}
                style={[styles.zoomPill, isActive && styles.zoomPillActive]}
                onPress={() => onSetZoom(z)}
                activeOpacity={0.8}
              >
                <Text style={[styles.zoomPillText, isActive && styles.zoomPillTextActive]}>
                  {z}×
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Quick Action: Reset AutoFocus if manual */}
        {isManualFocus && (
          <TouchableOpacity
            style={styles.quickActionChip}
            onPress={onResetAutoFocus}
            activeOpacity={0.8}
          >
            <RotateCcw size={13} color="#ffffff" style={{ marginRight: 4 }} />
            <Text style={styles.quickActionText}>Auto-Focus</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
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
  topFloatingControls: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    zIndex: 10,
  },
  headerCenterColumn: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerIconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(25, 20, 35, 0.65)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
  },
  headerIconButtonActive: {
    backgroundColor: '#9a70cc',
    borderColor: '#b48be0',
  },
  headerActionsRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  badgeContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(25, 20, 35, 0.75)',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
  },
  badgeTextBold: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  badgeTextSub: {
    color: '#b0a9bd',
    fontSize: 13,
    fontWeight: '500',
  },
  rosterSeenPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(15, 23, 42, 0.85)',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 12,
    marginTop: 4,
    borderWidth: 1,
    borderColor: 'rgba(127, 209, 173, 0.35)',
  },
  rosterSeenText: {
    color: '#7fd1ad',
    fontSize: 11,
    fontWeight: '600',
  },
  hintBannerContainer: {
    position: 'absolute',
    top: 112,
    left: 20,
    right: 20,
    alignItems: 'center',
    zIndex: 9,
  },
  hintBannerPill: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(30, 25, 45, 0.92)',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255, 209, 102, 0.4)',
    shadowColor: '#000000',
    shadowOpacity: 0.3,
    shadowRadius: 6,
    elevation: 4,
  },
  hintBannerPillWarning: {
    backgroundColor: 'rgba(40, 24, 15, 0.92)',
    borderColor: 'rgba(240, 168, 104, 0.6)',
  },
  hintBannerPillDark: {
    backgroundColor: 'rgba(15, 25, 45, 0.92)',
    borderColor: 'rgba(144, 184, 248, 0.5)',
  },
  hintBannerText: {
    color: '#ffffff',
    fontSize: 12.5,
    fontWeight: '600',
  },
  calibrationWatermark: {
    position: 'absolute',
    top: 86,
    alignSelf: 'center',
    backgroundColor: 'rgba(230, 80, 50, 0.85)',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 8,
    zIndex: 8,
  },
  calibrationWatermarkText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.8,
  },
  viewfinderFrame: {
    ...(StyleSheet.absoluteFill as any),
    margin: 20,
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
  faceBox: {
    position: 'absolute',
    borderWidth: 2,
    borderRadius: 8,
  },
  faceBoxCoasting: {
    borderStyle: 'dashed',
    opacity: 0.55,
  },
  faceBadge: {
    position: 'absolute',
    top: -22,
    left: -2,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  faceBadgeText: {
    color: '#ffffff',
    fontSize: 10,
    fontWeight: '700',
  },
  landmarkDot: {
    position: 'absolute',
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#7fd1ad',
    transform: [{ translateX: -2 }, { translateY: -2 }],
  },
  focusReticle: {
    position: 'absolute',
    width: 60,
    height: 60,
    borderWidth: 1.5,
    borderColor: '#7fd1ad',
    borderRadius: 30,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 100,
  },
  focusReticleInner: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#7fd1ad',
  },
  floatingControlsBar: {
    position: 'absolute',
    bottom: 16,
    left: 20,
    right: 20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  zoomPillGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(25, 20, 35, 0.75)',
    borderRadius: 24,
    padding: 3,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.15)',
  },
  zoomPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 18,
  },
  zoomPillActive: {
    backgroundColor: '#9a70cc',
  },
  zoomPillText: {
    color: '#b0a9bd',
    fontSize: 12,
    fontWeight: '700',
  },
  zoomPillTextActive: {
    color: '#ffffff',
  },
  quickActionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(25, 20, 35, 0.75)',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.20)',
  },
  quickActionText: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '600',
  },
});
