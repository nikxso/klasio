import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  ScrollView,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  CheckCircle2,
  AlertTriangle,
  Clock,
  Sparkles,
  RefreshCw,
  WifiOff,
  Calendar,
  Info,
  ShieldCheck,
  Check,
} from 'lucide-react-native';

import { Screen, Card, Ring, Bar, Chip, IconBubble, SectionTitle, Button } from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';
import { API_BASE_URL } from '@/config/api';
import {
  StudentRepository,
  StudentSubjectHistoryResponse,
  StudentSessionHistoryItem,
} from '@/storage/studentRepository';

// Demo fallback history for offline or preview
const DEFAULT_FALLBACK_HISTORY: StudentSubjectHistoryResponse = {
  teaching_assignment_id: 'ta-02',
  subject_id: 'sub-02',
  subject_code: 'CS303',
  subject_name: 'Operating Systems',
  faculty_name: 'Prof Katherine Johnson',
  total_eligible_sessions: 38,
  attended_sessions: 27,
  attendance_percentage: 71.1,
  classes_to_recover: 6,
  classes_can_miss: 0,
  is_shortage: true,
  is_recoverable: true,
  threshold: 75.0,
  records: [
    {
      session_id: 'sess-05',
      session_date: '2026-10-08',
      period_slot_or_sequence: 1,
      attendance_status: 'ABSENT',
      applicability_status: 'COUNTED',
      mark_source: 'MANUAL_MARK',
      recorded_at: '2026-10-08T09:30:00Z',
    },
    {
      session_id: 'sess-04',
      session_date: '2026-10-01',
      period_slot_or_sequence: 1,
      attendance_status: 'ABSENT',
      applicability_status: 'COUNTED',
      mark_source: 'MANUAL_MARK',
      recorded_at: '2026-10-01T09:30:00Z',
    },
    {
      session_id: 'sess-03',
      session_date: '2026-09-24',
      period_slot_or_sequence: 1,
      attendance_status: 'EXCUSED',
      applicability_status: 'CANCELLED',
      mark_source: 'MANUAL_MARK',
      status_reason: 'Severe storm and campus flood',
      recorded_at: '2026-09-24T09:30:00Z',
    },
    {
      session_id: 'sess-02',
      session_date: '2026-09-17',
      period_slot_or_sequence: 1,
      attendance_status: 'PRESENT',
      applicability_status: 'COUNTED',
      mark_source: 'AI_VERIFIED',
      recorded_at: '2026-09-17T09:30:00Z',
    },
    {
      session_id: 'sess-01',
      session_date: '2026-09-10',
      period_slot_or_sequence: 1,
      attendance_status: 'PRESENT',
      applicability_status: 'COUNTED',
      mark_source: 'AI_VERIFIED',
      recorded_at: '2026-09-10T09:30:00Z',
    },
  ],
};

function formatDate(dateStr: string): string {
  try {
    const [year, month, day] = dateStr.split('-').map(Number);
    const d = new Date(year, month - 1, day);
    return d.toLocaleDateString('en-US', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

export default function SubjectAttendanceHistoryScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    id: string;
    subjectName?: string;
    subjectCode?: string;
    facultyName?: string;
    studentId?: string;
  }>();

  const teachingAssignmentId = params.id || 'ta-02';
  const studentId = params.studentId || 'demo-student-01';

  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [isCached, setIsCached] = useState<boolean>(false);
  const [cachedTime, setCachedTime] = useState<string | null>(null);
  const [history, setHistory] = useState<StudentSubjectHistoryResponse | null>(null);

  const fetchHistory = useCallback(async (isPullRefresh = false) => {
    if (isPullRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      const endpoint = `${API_BASE_URL}/api/v1/student/subjects/${teachingAssignmentId}/history`;
      const response = await fetch(endpoint, {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      });

      if (response.ok) {
        const liveData: StudentSubjectHistoryResponse = await response.json();
        setHistory(liveData);
        setIsCached(false);
        setCachedTime(null);
        await StudentRepository.saveCachedSubjectHistory(teachingAssignmentId, studentId, liveData);
      } else if (response.status === 401 || response.status === 403) {
        throw new Error('Authentication expired or unauthorized.');
      } else {
        throw new Error(`Server returned status ${response.status}`);
      }
    } catch (err: any) {
      // Offline fallback
      try {
        const cached = await StudentRepository.getCachedSubjectHistory(teachingAssignmentId, studentId);
        if (cached) {
          setHistory(cached.data);
          setIsCached(true);
          setCachedTime(new Date(cached.cachedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
        } else {
          // Provide default fallback with URL params
          setHistory({
            ...DEFAULT_FALLBACK_HISTORY,
            teaching_assignment_id: teachingAssignmentId,
            subject_name: params.subjectName || DEFAULT_FALLBACK_HISTORY.subject_name,
            subject_code: params.subjectCode || DEFAULT_FALLBACK_HISTORY.subject_code,
            faculty_name: params.facultyName || DEFAULT_FALLBACK_HISTORY.faculty_name,
          });
          setIsCached(true);
          setCachedTime('Default catalog');
        }
      } catch {
        setHistory(DEFAULT_FALLBACK_HISTORY);
        setIsCached(true);
        setCachedTime('Offline demo');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [teachingAssignmentId, studentId, params.subjectName, params.subjectCode, params.facultyName]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const title = history?.subject_name || params.subjectName || 'Subject History';
  const subtitle = `${history?.subject_code || params.subjectCode || ''} · ${
    history?.faculty_name || params.facultyName || ''
  }`;

  if (loading) {
    return (
      <Screen title={title} subtitle={subtitle} onBack={() => router.back()}>
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color={Colors.forest} />
          <Text style={styles.loadingText}>Loading attendance sessions...</Text>
        </View>
      </Screen>
    );
  }

  if (error && !history) {
    return (
      <Screen title={title} subtitle={subtitle} onBack={() => router.back()}>
        <View style={styles.centerContainer}>
          <IconBubble icon={AlertTriangle} tone="rose" size={56} />
          <Text style={styles.errorTitle}>Could not load history</Text>
          <Text style={styles.errorMessage}>{error}</Text>
          <Button onPress={() => fetchHistory()} style={styles.retryButton}>
            Try again
          </Button>
        </View>
      </Screen>
    );
  }

  const pct = history ? Math.round(history.attendance_percentage) : 0;
  const isBelow = history ? history.attendance_percentage < history.threshold : false;
  const isZero = history ? history.total_eligible_sessions === 0 : true;
  const records = history?.records || [];

  return (
    <Screen
      title={title}
      subtitle={subtitle}
      onBack={() => router.back()}
      right={
        <Pressable
          onPress={() => fetchHistory(true)}
          style={styles.headerRefreshBtn}
          accessibilityLabel="Refresh session history"
        >
          <RefreshCw size={18} color={Colors.soft} />
        </Pressable>
      }
    >
      {/* Offline Cached Indicator */}
      {isCached && (
        <View style={styles.cachedBanner}>
          <WifiOff size={14} color={Colors.amber} />
          <Text style={styles.cachedBannerText}>
            Viewing cached records {cachedTime ? `· Updated ${cachedTime}` : ''}
          </Text>
        </View>
      )}

      {/* Summary KPI Card */}
      <Card style={styles.summaryCard}>
        <View style={styles.summaryRow}>
          <Ring pct={isZero ? 0 : pct} size={92} threshold={history?.threshold || 75} />
          <View style={styles.summaryDetails}>
            <Text style={styles.summaryHeading}>
              {isZero
                ? 'No classes held yet'
                : isBelow
                ? 'Attendance Shortage'
                : 'Requirement Satisfied'}
            </Text>
            <Text style={styles.sessionCountText}>
              {history?.attended_sessions || 0} of {history?.total_eligible_sessions || 0} counted classes attended
            </Text>

            <View style={styles.guidanceBox}>
              <Text style={styles.guidanceText}>
                {isZero
                  ? 'Attendance metrics will begin accumulating after the first class.'
                  : isBelow
                  ? history?.classes_to_recover !== null && history?.classes_to_recover !== undefined && history.classes_to_recover > 0
                    ? `Attend ${history.classes_to_recover} consecutive classes to reach ${history.threshold}%.`
                    : 'Target unreachable this term. Speak with faculty advisor.'
                  : (history?.classes_can_miss || 0) > 0
                  ? `You can safely miss ${history?.classes_can_miss} classes while staying $\\ge$ ${history?.threshold}%.`
                  : `Currently right at the ${history?.threshold}% threshold.`}
              </Text>
            </View>
          </View>
        </View>
      </Card>

      {/* Chronological Sessions Timeline */}
      <SectionTitle
        action={
          <Text style={styles.recordsCountLabel}>
            {records.length} {records.length === 1 ? 'session' : 'sessions'}
          </Text>
        }
      >
        Session records
      </SectionTitle>

      {records.length === 0 ? (
        <Card style={styles.emptyCard}>
          <Calendar size={36} color={Colors.soft} />
          <Text style={styles.emptyTitle}>No sessions recorded</Text>
          <Text style={styles.emptyMessage}>
            No attendance sessions have been conducted or finalized for this course section yet.
          </Text>
        </Card>
      ) : (
        <View style={styles.recordsList}>
          {records.map((r) => {
            const isCounted = r.applicability_status === 'COUNTED';
            const isCancelled = r.applicability_status === 'CANCELLED';
            const isExempt = r.applicability_status === 'EXEMPT';

            let statusTone: 'forest' | 'rose' | 'amber' | 'soft' | 'lilac' = 'forest';
            let statusLabel = 'Present';
            let StatusIcon = CheckCircle2;

            if (isCancelled) {
              statusTone = 'soft';
              statusLabel = 'Cancelled';
              StatusIcon = Clock;
            } else if (isExempt) {
              statusTone = 'lilac';
              statusLabel = 'Exempt';
              StatusIcon = Info;
            } else if (r.attendance_status === 'PRESENT') {
              statusTone = 'forest';
              statusLabel = 'Present';
              StatusIcon = CheckCircle2;
            } else if (r.attendance_status === 'ABSENT') {
              statusTone = 'rose';
              statusLabel = 'Absent';
              StatusIcon = AlertTriangle;
            } else if (r.attendance_status === 'EXCUSED') {
              statusTone = 'amber';
              statusLabel = 'Excused';
              StatusIcon = Clock;
            }

            const formatted = formatDate(r.session_date);

            return (
              <Card key={r.session_id} style={styles.sessionCard}>
                <View style={styles.sessionTopRow}>
                  <View style={styles.sessionInfo}>
                    <Text style={styles.sessionDate}>{formatted}</Text>
                    <Text style={styles.sessionSlot}>
                      Slot {r.period_slot_or_sequence}
                      {isCancelled ? ' · Excluded from denominator' : ''}
                    </Text>
                  </View>
                  <Chip tone={statusTone}>
                    <StatusIcon size={12} /> {statusLabel}
                  </Chip>
                </View>

                {/* Status reason if cancelled or excused */}
                {r.status_reason && (
                  <View style={styles.reasonCard}>
                    <Info size={14} color={Colors.soft} style={{ marginTop: 2 }} />
                    <Text style={styles.reasonText}>{r.status_reason}</Text>
                  </View>
                )}

                {/* Mark source footer */}
                <View style={styles.sessionFooterRow}>
                  <View style={styles.verificationBadge}>
                    {r.mark_source === 'AI_VERIFIED' ? (
                      <>
                        <Sparkles size={12} color={Colors.forest} />
                        <Text style={styles.verificationText}>AI Verified</Text>
                      </>
                    ) : (
                      <>
                        <ShieldCheck size={12} color={Colors.soft} />
                        <Text style={styles.verificationText}>Faculty Marked</Text>
                      </>
                    )}
                  </View>
                  {r.recorded_at && (
                    <Text style={styles.recordedTimeText}>
                      {new Date(r.recorded_at).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </Text>
                  )}
                </View>
              </Card>
            );
          })}
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  centerContainer: {
    paddingVertical: 60,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  loadingText: {
    fontSize: 14,
    color: Colors.soft,
    marginTop: 8,
  },
  errorTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.ink,
    marginTop: 8,
  },
  errorMessage: {
    fontSize: 14,
    color: Colors.soft,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  retryButton: {
    marginTop: 16,
  },
  headerRefreshBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cachedBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: Colors.amber50,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: Radii.card,
    marginBottom: 12,
  },
  cachedBannerText: {
    fontSize: 12,
    color: Colors.amber,
    fontWeight: '600',
  },
  summaryCard: {
    marginBottom: 14,
  },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  summaryDetails: {
    flex: 1,
  },
  summaryHeading: {
    fontSize: 17,
    fontWeight: '700',
    color: Colors.ink,
  },
  sessionCountText: {
    fontSize: 13,
    color: Colors.soft,
    marginTop: 2,
  },
  guidanceBox: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#e8e2d8',
  },
  guidanceText: {
    fontSize: 12,
    color: Colors.ink,
    lineHeight: 16,
    fontWeight: '500',
  },
  recordsCountLabel: {
    fontSize: 12,
    color: Colors.soft,
    fontWeight: '500',
  },
  emptyCard: {
    paddingVertical: 36,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.ink,
  },
  emptyMessage: {
    fontSize: 13,
    color: Colors.soft,
    textAlign: 'center',
    paddingHorizontal: 16,
  },
  recordsList: {
    gap: 10,
    marginTop: 4,
    marginBottom: 24,
  },
  sessionCard: {
    padding: 14,
  },
  sessionTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  sessionInfo: {
    flex: 1,
    paddingRight: 8,
  },
  sessionDate: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.ink,
  },
  sessionSlot: {
    fontSize: 12,
    color: Colors.soft,
    marginTop: 2,
  },
  reasonCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    backgroundColor: '#f7f4ef',
    padding: 8,
    borderRadius: 8,
    marginTop: 10,
  },
  reasonText: {
    fontSize: 12,
    color: Colors.ink,
    flex: 1,
    lineHeight: 16,
  },
  sessionFooterRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#f1ebe0',
  },
  verificationBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  verificationText: {
    fontSize: 11,
    color: Colors.soft,
    fontWeight: '500',
  },
  recordedTimeText: {
    fontSize: 11,
    color: Colors.soft,
  },
});
