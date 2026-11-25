import React, { useState } from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  Pressable,
  ScrollView,
  Alert,
  Linking,
  ActivityIndicator,
} from 'react-native';
import { Camera } from 'react-native-vision-camera';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import {
  Cpu,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  FileSpreadsheet,
  Trash2,
} from 'lucide-react-native';
import { useCameraDetection } from '@/hooks/useCameraDetection';
import { ScannerHud } from '@/components/scanner/ScannerHud';
import { CandidateList } from '@/components/scanner/CandidateList';
import { AttendanceReviewSheet } from '@/components/scanner/AttendanceReviewSheet';
import { AccessRestrictedView } from '@/components/ui/kit';
import { SessionStore } from '@/storage/sessionStore';
import { BIOMETRIC_CONFIG } from '@/config/biometrics';

export default function FacultyScanningScreen() {
  const router = useRouter();

  if (!SessionStore.canScanAttendance()) {
    return (
      <AccessRestrictedView
        title="Attendance Scanner Restricted"
        message="Live camera attendance scanning requires authorized teaching or attendance permissions."
        requiredCapability="attendance.session.start"
        onBack={() => router.replace('/(faculty)')}
      />
    );
  }

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
  const [showDiagnostics, setShowDiagnostics] = useState<boolean>(false);
  const [isReviewSheetVisible, setIsReviewSheetVisible] = useState<boolean>(false);

  const {
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

    // Calibration Mode
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
  } = useCameraDetection({
    sectionId: params.sectionId,
    subject: params.subject,
    section: params.section,
    room: params.room,
    slot: params.slot,
    applicability: params.applicability,
  });

  const handleDone = () => {
    const candidates = getAccumulatedCandidates();
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
    const candidates = getAccumulatedCandidates();
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

  // Permission fallback
  if (!hasPermission) {
    return (
      <View style={styles.permissionContainer}>
        <StatusBar style="light" />
        <AlertCircle size={48} color="#f0c674" style={{ marginBottom: 16 }} />
        <Text style={styles.permissionTitle}>Camera Access Required</Text>
        <Text style={styles.permissionSubtitle}>
          Klasio needs camera permission to perform on-device face detection for attendance.
        </Text>
        <TouchableOpacity
          style={styles.permissionButton}
          onPress={handleRequestPermission}
          disabled={isRequestingPermission}
        >
          {isRequestingPermission ? (
            <ActivityIndicator color="#12241b" />
          ) : (
            <Text style={styles.permissionButtonText}>Grant Camera Permission</Text>
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.permissionButton, { marginTop: 12, backgroundColor: '#352e44' }]}
          onPress={() => Linking.openSettings()}
        >
          <Text style={[styles.permissionButtonText, { color: '#ffffff' }]}>Open App Settings</Text>
        </TouchableOpacity>
      </View>
    );
  }

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
        {device ? (
          <Camera
            ref={cameraRef}
            style={StyleSheet.absoluteFill}
            device={device}
            format={format}
            isActive={isCameraActive}
            zoom={zoom}
            enableFpsGraph={false}
            onError={handleCameraError}
          />
        ) : (
          <View style={styles.noCameraPlaceholder}>
            <Text style={{ color: '#ffffff' }}>Loading camera device...</Text>
          </View>
        )}

        {/* Tap-to-focus gesture receiver over viewfinder */}
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={handleTapToFocus}
          accessible={false}
        />

        {/* Scanner HUD Overlay */}
        <ScannerHud
          viewfinderLayout={viewfinderLayout}
          detectedFaces={detectedFaces}
          focusPoint={focusPoint}
          focusReticleAnim={focusReticleAnim}
          zoom={zoom}
          zoomPresets={zoomPresets}
          onSetZoom={handleSetZoom}
          isManualFocus={isManualFocus}
          onResetAutoFocus={handleResetAutoFocus}
          subjectTitle={params.subject || 'Data Structures'}
          sectionCode={params.section || 'CSE 3A'}
          cameraPosition={cameraPosition}
          onSwitchCamera={handleSwitchCamera}
          isPaused={isPaused}
          onTogglePause={handleTogglePause}
          onClose={handleSafeExit}
          activeHints={activeHints}
          primaryHint={primaryHint}
          rosterStats={rosterStats}
          isCalibrationMode={isCalibrationMode}
        />
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
        {/* Modular Candidate List Component */}
        <CandidateList
          candidates={accumulatedCandidates}
          detectedFacesCount={detectedFaces.length}
          scannerMotionState={scannerMotionState}
          isPaused={isPaused}
          onDonePress={() => setIsReviewSheetVisible(true)}
          onCandidatePress={() => setIsReviewSheetVisible(true)}
        />

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
              {/* Calibration Mode Control Card */}
              <View style={styles.calibrationCard}>
                <View style={styles.calibrationHeaderRow}>
                  <Text style={styles.calibrationTitle}>Developer Calibration Mode</Text>
                  <TouchableOpacity
                    style={[
                      styles.calibrationTogglePill,
                      isCalibrationMode && styles.calibrationTogglePillActive,
                    ]}
                    onPress={() => setIsCalibrationMode(!isCalibrationMode)}
                  >
                    <Text
                      style={[
                        styles.calibrationToggleText,
                        isCalibrationMode && styles.calibrationToggleTextActive,
                      ]}
                    >
                      {isCalibrationMode ? 'ACTIVE' : 'INACTIVE'}
                    </Text>
                  </TouchableOpacity>
                </View>
                <Text style={styles.calibrationSubtitle}>
                  Logs top-1, top-2 score, quality and track id per detected face for threshold calibration.
                </Text>

                <View style={styles.calibrationStatsRow}>
                  <Text style={styles.calibrationStatText}>
                    Logged Samples: <Text style={{ color: '#ffffff', fontWeight: '700' }}>{calibrationLogsCount}</Text>
                  </Text>
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    <TouchableOpacity
                      style={styles.exportButton}
                      onPress={exportCalibrationCsv}
                    >
                      <FileSpreadsheet size={13} color="#12241b" style={{ marginRight: 4 }} />
                      <Text style={styles.exportButtonText}>Export CSV</Text>
                    </TouchableOpacity>
                    {calibrationLogsCount > 0 && (
                      <TouchableOpacity
                        style={styles.clearLogsButton}
                        onPress={clearCalibrationLogs}
                      >
                        <Trash2 size={13} color="#e07a7a" />
                      </TouchableOpacity>
                    )}
                  </View>
                </View>
              </View>

              {/* Thresholds Display */}
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Cosine Sim Threshold:</Text>
                <Text style={[styles.diagVal, { color: '#7fd1ad' }]}>
                  {BIOMETRIC_CONFIG.COSINE_SIMILARITY_THRESHOLD.toFixed(2)} (Configurable)
                </Text>
              </View>
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Top-2 Margin Threshold:</Text>
                <Text style={[styles.diagVal, { color: '#7fd1ad' }]}>
                  {BIOMETRIC_CONFIG.TOP2_MARGIN_THRESHOLD.toFixed(2)} (Configurable)
                </Text>
              </View>

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

              {/* Tracking Mode Switcher */}
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

              {/* Analysis Resolution Switcher */}
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
                        {pref === 'STANDARD_640' ? '640×640 (Std)' : '320×320 (Fast)'}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>

              {/* Frame Sequencing & Telemetry */}
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Active Frame ID:</Text>
                <Text style={styles.diagVal}>{displayedFrameId}</Text>
              </View>
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Rendered Result Age:</Text>
                <Text style={styles.diagVal}>{resultAgeMs} ms</Text>
              </View>
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Inference Latency:</Text>
                <Text style={styles.diagVal}>{detectionLatencyMs} ms</Text>
              </View>
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Detector Cadence:</Text>
                <Text style={styles.diagVal}>{detectionCadenceFps} FPS</Text>
              </View>
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Presentation Cadence:</Text>
                <Text style={styles.diagVal}>{trackingCadenceFps} FPS</Text>
              </View>
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Active Tracks:</Text>
                <Text style={styles.diagVal}>
                  {trackerStats.activeTracks} (Conf: {trackerStats.confirmedTracks}, Coast: {trackerStats.coastingTracks})
                </Text>
              </View>
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Dropped / Stale Frames:</Text>
                <Text style={styles.diagVal}>{droppedFramesCount} / {staleFramesCount}</Text>
              </View>
              <View style={styles.diagRow}>
                <Text style={styles.diagLabel}>Total Frames Analyzed:</Text>
                <Text style={styles.diagVal}>{totalFramesAnalyzed}</Text>
              </View>
              {cameraError && (
                <View style={styles.diagRow}>
                  <Text style={styles.diagLabel}>Camera Error:</Text>
                  <Text style={[styles.diagVal, { color: '#e07a7a' }]}>{cameraError}</Text>
                </View>
              )}
            </ScrollView>
          )}
        </View>
      </View>

      {/* Review Sheet Modal */}
      <AttendanceReviewSheet
        visible={isReviewSheetVisible}
        onClose={() => setIsReviewSheetVisible(false)}
        onConfirm={() => {
          setIsReviewSheetVisible(false);
          handleDone();
        }}
        candidates={accumulatedCandidates}
        totalRosterCount={rosterStats.totalRosterCount}
        subjectTitle={params.subject || 'Data Structures'}
        sectionCode={params.section || 'CSE 3A'}
      />
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
  noCameraPlaceholder: {
    ...StyleSheet.absoluteFill,
    backgroundColor: '#120f18',
    justifyContent: 'center',
    alignItems: 'center',
  },
  bottomPanel: {
    backgroundColor: '#1f1a29',
    paddingTop: 16,
  },
  diagnosticsAccordion: {
    marginTop: 12,
    backgroundColor: '#2a2436',
    borderRadius: 16,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  diagHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  diagHeaderTitle: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '700',
  },
  diagScroll: {
    maxHeight: 220,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255, 255, 255, 0.08)',
  },
  diagContent: {
    padding: 12,
    gap: 8,
  },
  calibrationCard: {
    backgroundColor: 'rgba(35, 30, 48, 0.95)',
    borderRadius: 12,
    padding: 10,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: 'rgba(255, 209, 102, 0.25)',
  },
  calibrationHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  calibrationTitle: {
    color: '#ffd166',
    fontSize: 12,
    fontWeight: '700',
  },
  calibrationTogglePill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
  },
  calibrationTogglePillActive: {
    backgroundColor: '#ffd166',
  },
  calibrationToggleText: {
    color: '#b0a9bd',
    fontSize: 10,
    fontWeight: '800',
  },
  calibrationToggleTextActive: {
    color: '#12241b',
  },
  calibrationSubtitle: {
    color: '#b0a9bd',
    fontSize: 11,
    lineHeight: 14,
    marginBottom: 8,
  },
  calibrationStatsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  calibrationStatText: {
    color: '#d4cfde',
    fontSize: 11,
  },
  exportButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#7fd1ad',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
  },
  exportButtonText: {
    color: '#12241b',
    fontSize: 11,
    fontWeight: '700',
  },
  clearLogsButton: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
    backgroundColor: 'rgba(224, 122, 122, 0.15)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  diagRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 2,
  },
  diagLabel: {
    color: '#b0a9bd',
    fontSize: 11.5,
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
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
  },
  diagPillActive: {
    backgroundColor: '#9a70cc',
  },
  diagPillText: {
    color: '#b0a9bd',
    fontSize: 10.5,
    fontWeight: '600',
  },
  diagPillTextActive: {
    color: '#ffffff',
    fontWeight: '700',
  },
  permissionContainer: {
    flex: 1,
    backgroundColor: '#1f1a29',
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  permissionTitle: {
    color: '#ffffff',
    fontSize: 20,
    fontWeight: '800',
    marginBottom: 8,
    textAlign: 'center',
  },
  permissionSubtitle: {
    color: '#b0a9bd',
    fontSize: 14,
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 20,
  },
  permissionButton: {
    backgroundColor: '#7fd1ad',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 14,
    width: '100%',
    alignItems: 'center',
  },
  permissionButtonText: {
    color: '#12241b',
    fontSize: 15,
    fontWeight: '700',
  },
});
