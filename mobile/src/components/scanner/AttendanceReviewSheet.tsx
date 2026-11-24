import React from 'react';
import {
  StyleSheet,
  View,
  Text,
  Modal,
  TouchableOpacity,
  ScrollView,
  SafeAreaView,
} from 'react-native';
import {
  X,
  CheckCircle2,
  User,
  ShieldCheck,
  ChevronRight,
  Info,
} from 'lucide-react-native';
import type { AccumulatedRecognitionCandidate } from '../../perception/contracts';

export interface AttendanceReviewSheetProps {
  visible: boolean;
  onClose: () => void;
  onConfirm: () => void;
  candidates: AccumulatedRecognitionCandidate[];
  totalRosterCount: number;
  subjectTitle?: string;
  sectionCode?: string;
}

export const AttendanceReviewSheet: React.FC<AttendanceReviewSheetProps> = ({
  visible,
  onClose,
  onConfirm,
  candidates,
  totalRosterCount,
  subjectTitle = 'Data Structures',
  sectionCode = 'CSE 3A',
}) => {
  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.sheetContainer}>
          {/* Header Bar */}
          <View style={styles.sheetHeader}>
            <View>
              <Text style={styles.sheetTitle}>Attendance Review</Text>
              <Text style={styles.sheetSubtitle}>
                {subjectTitle} • {sectionCode}
              </Text>
            </View>
            <TouchableOpacity
              style={styles.closeButton}
              onPress={onClose}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            >
              <X size={20} color="#b0a9bd" />
            </TouchableOpacity>
          </View>

          {/* Roster Progress Summary Banner */}
          <View style={styles.summaryCard}>
            <View style={styles.summaryItem}>
              <Text style={styles.summaryValue}>{candidates.length}</Text>
              <Text style={styles.summaryLabel}>Recognized</Text>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryItem}>
              <Text style={styles.summaryValue}>{totalRosterCount}</Text>
              <Text style={styles.summaryLabel}>Enrolled</Text>
            </View>
            <View style={styles.summaryDivider} />
            <View style={styles.summaryItem}>
              <Text style={styles.summaryValue}>
                {totalRosterCount > 0
                  ? `${Math.round((candidates.length / totalRosterCount) * 100)}%`
                  : '—'}
              </Text>
              <Text style={styles.summaryLabel}>Turnout</Text>
            </View>
          </View>

          {/* Hard Domain Invariant Banner */}
          <View style={styles.invariantBanner}>
            <ShieldCheck size={16} color="#7fd1ad" style={{ marginRight: 8, marginTop: 1 }} />
            <Text style={styles.invariantText}>
              Zero Absent Default: Unmatched faces are never marked absent or unauthorized.
              All unrecognized students remain undecided for manual verification.
            </Text>
          </View>

          {/* Candidate List Scroll */}
          <ScrollView
            style={styles.candidateListScroll}
            contentContainerStyle={styles.candidateListContent}
            showsVerticalScrollIndicator={false}
          >
            {candidates.length === 0 ? (
              <View style={styles.emptyContainer}>
                <Info size={32} color="#b0a9bd" style={{ marginBottom: 8 }} />
                <Text style={styles.emptyTitle}>No students recognized yet</Text>
                <Text style={styles.emptySubtitle}>
                  Point the camera at students to match their biometric profiles.
                </Text>
              </View>
            ) : (
              candidates.map((c, index) => {
                const name = c.studentName || 'Student';
                const id = c.institutionalId || c.studentUserId;
                const scorePct = Math.round(c.bestSimilarityScore * 100);

                return (
                  <View key={c.studentUserId || index} style={styles.candidateCard}>
                    <View style={styles.candidateAvatar}>
                      <User size={18} color="#ffffff" />
                    </View>
                    <View style={styles.candidateInfo}>
                      <Text style={styles.candidateName}>{name}</Text>
                      <Text style={styles.candidateId}>{id}</Text>
                    </View>
                    <View style={styles.candidateBadge}>
                      <CheckCircle2 size={13} color="#7fd1ad" style={{ marginRight: 4 }} />
                      <Text style={styles.candidateScoreText}>{scorePct}% Match</Text>
                    </View>
                  </View>
                );
              })
            )}
          </ScrollView>

          {/* Footer Action Buttons */}
          <SafeAreaView style={styles.footerSafeArea}>
            <View style={styles.footerActions}>
              <TouchableOpacity
                style={styles.keepScanningButton}
                onPress={onClose}
                activeOpacity={0.8}
              >
                <Text style={styles.keepScanningText}>Keep Scanning</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.confirmButton}
                onPress={onConfirm}
                activeOpacity={0.88}
              >
                <Text style={styles.confirmButtonText}>Check Final List</Text>
                <ChevronRight size={16} color="#12241b" style={{ marginLeft: 4 }} />
              </TouchableOpacity>
            </View>
          </SafeAreaView>
        </View>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(10, 8, 16, 0.75)',
    justifyContent: 'flex-end',
  },
  sheetContainer: {
    backgroundColor: '#1f1a29',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    maxHeight: '82%',
    paddingTop: 20,
    paddingHorizontal: 20,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  sheetHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  sheetTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#ffffff',
  },
  sheetSubtitle: {
    fontSize: 13,
    color: '#b0a9bd',
    marginTop: 2,
  },
  closeButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  summaryCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    backgroundColor: 'rgba(35, 30, 48, 0.8)',
    borderRadius: 16,
    paddingVertical: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.08)',
  },
  summaryItem: {
    alignItems: 'center',
  },
  summaryValue: {
    fontSize: 18,
    fontWeight: '800',
    color: '#ffffff',
  },
  summaryLabel: {
    fontSize: 11,
    color: '#b0a9bd',
    marginTop: 2,
  },
  summaryDivider: {
    width: 1,
    height: 24,
    backgroundColor: 'rgba(255, 255, 255, 0.12)',
  },
  invariantBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: 'rgba(127, 209, 173, 0.10)',
    borderRadius: 12,
    padding: 10,
    marginBottom: 14,
    borderWidth: 1,
    borderColor: 'rgba(127, 209, 173, 0.25)',
  },
  invariantText: {
    flex: 1,
    fontSize: 11.5,
    color: '#c2f0dc',
    lineHeight: 16,
  },
  candidateListScroll: {
    maxHeight: 320,
  },
  candidateListContent: {
    paddingBottom: 16,
    gap: 8,
  },
  candidateCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(35, 30, 48, 0.65)',
    padding: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.06)',
  },
  candidateAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: '#4d3968',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  candidateInfo: {
    flex: 1,
  },
  candidateName: {
    fontSize: 14,
    fontWeight: '700',
    color: '#ffffff',
  },
  candidateId: {
    fontSize: 12,
    color: '#b0a9bd',
    marginTop: 2,
  },
  candidateBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(127, 209, 173, 0.15)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
  },
  candidateScoreText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#7fd1ad',
  },
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 40,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#ffffff',
    marginBottom: 4,
  },
  emptySubtitle: {
    fontSize: 12,
    color: '#b0a9bd',
    textAlign: 'center',
    paddingHorizontal: 20,
  },
  footerSafeArea: {
    paddingTop: 12,
    paddingBottom: 16,
  },
  footerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  keepScanningButton: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  keepScanningText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#ffffff',
  },
  confirmButton: {
    flex: 1.5,
    flexDirection: 'row',
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: '#7fd1ad',
    alignItems: 'center',
    justifyContent: 'center',
  },
  confirmButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#12241b',
  },
});
