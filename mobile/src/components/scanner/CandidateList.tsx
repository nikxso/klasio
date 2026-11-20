import React from 'react';
import {
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { CheckCircle2, User } from 'lucide-react-native';
import type {
  AccumulatedRecognitionCandidate,
  ScannerStabilityState,
} from '../../perception/contracts';

export interface CandidateListProps {
  candidates: AccumulatedRecognitionCandidate[];
  detectedFacesCount: number;
  scannerMotionState: ScannerStabilityState;
  isPaused: boolean;
  onDonePress: () => void;
  onCandidatePress?: (candidate: AccumulatedRecognitionCandidate) => void;
}

export const CandidateList: React.FC<CandidateListProps> = ({
  candidates,
  detectedFacesCount,
  scannerMotionState,
  isPaused,
  onDonePress,
  onCandidatePress,
}) => {
  return (
    <View style={styles.container}>
      {/* Face Detection Counter Display */}
      <View style={styles.counterRow}>
        <Text style={styles.counterBig}>{candidates.length}</Text>
        <Text style={styles.counterTotal}> recognized ({detectedFacesCount} in view)</Text>
      </View>

      {/* User Guidance Prompt */}
      <Text
        style={[
          styles.guidanceText,
          scannerMotionState === 'PANNING' && styles.guidanceTextWarning,
        ]}
      >
        {isPaused
          ? 'Camera paused — tap play to resume'
          : scannerMotionState === 'PANNING'
          ? '⚠️ Camera moving too fast — slow down to capture faces'
          : detectedFacesCount > 0
          ? 'Suggested matches are ready for your review.'
          : 'Move across the room to find students.'}
      </Text>

      {/* Horizontal Candidate Preview Tray */}
      {candidates.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.candidateTray}
        >
          {candidates.slice(-8).reverse().map((c) => {
            const studentName = c.bestMatch.studentName || c.studentUserId;
            const scorePct = Math.round(c.bestSimilarityScore * 100);

            return (
              <TouchableOpacity
                key={c.studentUserId}
                style={styles.candidateChip}
                onPress={() => onCandidatePress && onCandidatePress(c)}
                activeOpacity={0.8}
              >
                <View style={styles.candidateAvatar}>
                  <User size={13} color="#ffffff" />
                </View>
                <View style={styles.candidateDetails}>
                  <Text style={styles.candidateName} numberOfLines={1}>
                    {studentName}
                  </Text>
                  <View style={styles.candidateScoreRow}>
                    <CheckCircle2 size={10} color="#7fd1ad" style={{ marginRight: 3 }} />
                    <Text style={styles.candidateScoreText}>{scorePct}%</Text>
                  </View>
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      )}

      {/* Finish Scanning Button */}
      <TouchableOpacity
        style={styles.doneButton}
        onPress={onDonePress}
        activeOpacity={0.88}
      >
        <Text style={styles.doneButtonText}>Done — check the list</Text>
      </TouchableOpacity>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: '100%',
  },
  counterRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginBottom: 4,
  },
  counterBig: {
    fontSize: 26,
    fontWeight: '800',
    color: '#ffffff',
    letterSpacing: -0.5,
  },
  counterTotal: {
    fontSize: 14,
    color: '#b0a9bd',
    fontWeight: '500',
  },
  guidanceText: {
    fontSize: 13,
    color: '#d4cfde',
    marginBottom: 10,
    minHeight: 18,
  },
  guidanceTextWarning: {
    color: '#f0a868',
    fontWeight: '600',
  },
  candidateTray: {
    flexDirection: 'row',
    gap: 8,
    paddingBottom: 10,
  },
  candidateChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(45, 38, 60, 0.85)',
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(127, 209, 173, 0.3)',
    maxWidth: 150,
  },
  candidateAvatar: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: '#4d3968',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 6,
  },
  candidateDetails: {
    flexShrink: 1,
  },
  candidateName: {
    color: '#ffffff',
    fontSize: 11,
    fontWeight: '600',
  },
  candidateScoreRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  candidateScoreText: {
    color: '#7fd1ad',
    fontSize: 10,
    fontWeight: '700',
  },
  doneButton: {
    backgroundColor: '#7fd1ad',
    paddingVertical: 14,
    borderRadius: 16,
    alignItems: 'center',
    shadowColor: '#7fd1ad',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 3,
  },
  doneButtonText: {
    color: '#12241b',
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
});
