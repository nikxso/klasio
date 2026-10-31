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
import { useRouter } from 'expo-router';
import {
  Clock,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  RefreshCw,
  Sparkles,
  WifiOff,
  BookOpen,
} from 'lucide-react-native';

import { Screen, Card, Bar, Ring, Chip, IconBubble, SectionTitle, Button } from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';
import { API_BASE_URL } from '@/config/api';
import {
  StudentRepository,
  StudentPersonalAttendanceResponse,
  StudentSubjectSummary,
} from '@/storage/studentRepository';

// Demo fallback when network and local cache are not yet populated
const DEFAULT_FALLBACK_ATTENDANCE: StudentPersonalAttendanceResponse = {
  student_id: 'demo-student-01',
  overall_attendance_percentage: 82.0,
  subjects: [
    {
      subject_id: 'sub-01',
      teaching_assignment_id: 'ta-01',
      subject_code: 'CS301',
      subject_name: 'Data Structures',
      faculty_name: 'Prof Alan Turing',
      total_eligible_sessions: 42,
      attended_sessions: 36,
      attendance_percentage: 85.7,
      effective_start_date: '2026-09-01',
      classes_to_recover: 0,
      classes_can_miss: 6,
      is_shortage: false,
      is_recoverable: true,
      threshold: 75.0,
    },
    {
      subject_id: 'sub-02',
      teaching_assignment_id: 'ta-02',
      subject_code: 'CS303',
      subject_name: 'Operating Systems',
      faculty_name: 'Prof Katherine Johnson',
      total_eligible_sessions: 38,
      attended_sessions: 27,
      attendance_percentage: 71.1,
      effective_start_date: '2026-09-01',
      classes_to_recover: 6,
      classes_can_miss: 0,
      is_shortage: true,
      is_recoverable: true,
      threshold: 75.0,
    },
    {
      subject_id: 'sub-03',
      teaching_assignment_id: 'ta-03',
      subject_code: 'CS305',
      subject_name: 'Computer Networks',
      faculty_name: 'Prof Ada Lovelace',
      total_eligible_sessions: 35,
      attended_sessions: 28,
      attendance_percentage: 80.0,
      effective_start_date: '2026-09-20',
      classes_to_recover: 0,
      classes_can_miss: 2,
      is_shortage: false,
      is_recoverable: true,
      threshold: 75.0,
    },
    {
      subject_id: 'sub-04',
      teaching_assignment_id: 'ta-04',
      subject_code: 'MA301',
      subject_name: 'Discrete Mathematics',
      faculty_name: 'Prof Grace Hopper',
      total_eligible_sessions: 40,
      attended_sessions: 37,
      attendance_percentage: 92.5,
      effective_start_date: '2026-09-01',
      classes_to_recover: 0,
      classes_can_miss: 9,
      is_shortage: false,
      is_recoverable: true,
      threshold: 75.0,
    },
  ],
};

export default function StudentAttendanceScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [isCached, setIsCached] = useState<boolean>(false);
  const [cachedTime, setCachedTime] = useState<string | null>(null);
  const [attendance, setAttendance] = useState<StudentPersonalAttendanceResponse | null>(null);

  const fetchAttendance = useCallback(async (isPullRefresh = false) => {
    if (isPullRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    try {
      // 1. Attempt live API fetch
      const endpoint = `${API_BASE_URL}/api/v1/student/attendance`;
      const response = await fetch(endpoint, {
        headers: {
          'Content-Type': 'application/json',
          // Staging / Demo student token or auth header
          Accept: 'application/json',
        },
      });

      if (response.ok) {
        const liveData: StudentPersonalAttendanceResponse = await response.json();
        setAttendance(liveData);
        setIsCached(false);
        setCachedTime(null);
        // Persist to local SQLite for offline access
        await StudentRepository.saveCachedAttendance(liveData.student_id, liveData);
      } else if (response.status === 401 || response.status === 403) {
        // Auth expired or invalid role
        throw new Error('Authentication expired. Please sign in again.');
      } else {
        throw new Error(`Server returned status ${response.status}`);
      }
    } catch (err: any) {
      // 2. Fallback to local SQLite cache
      try {
        const cached = await StudentRepository.getCachedAttendance('demo-student-01');
        if (cached) {
          setAttendance(cached.data);
          setIsCached(true);
          setCachedTime(new Date(cached.cachedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
        } else {
          // If first run and offline, provide standard demo data
          setAttendance(DEFAULT_FALLBACK_ATTENDANCE);
          setIsCached(true);
          setCachedTime('Default catalog');
        }
      } catch (cacheErr) {
        setAttendance(DEFAULT_FALLBACK_ATTENDANCE);
        setIsCached(true);
        setCachedTime('Offline demo');
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchAttendance();
  }, [fetchAttendance]);

  const handleCardPress = (subject: StudentSubjectSummary) => {
    router.push({
      pathname: '/(student)/subject/[id]',
      params: {
        id: subject.teaching_assignment_id,
        subjectName: subject.subject_name,
        subjectCode: subject.subject_code,
        facultyName: subject.faculty_name,
        studentId: attendance?.student_id || 'demo-student-01',
      },
    });
  };

  if (loading) {
    return (
      <Screen title="Attendance" subtitle="Loading your status...">
        <View style={styles.centerContainer}>
          <ActivityIndicator size="large" color={Colors.forest} />
          <Text style={styles.loadingText}>Fetching attendance records...</Text>
        </View>
      </Screen>
    );
  }

  if (error && !attendance) {
    return (
      <Screen title="Attendance" subtitle="Connection error">
        <View style={styles.centerContainer}>
          <IconBubble icon={AlertTriangle} tone="rose" size={56} />
          <Text style={styles.errorTitle}>Could not load attendance</Text>
          <Text style={styles.errorMessage}>{error}</Text>
          <Button onPress={() => fetchAttendance()} style={styles.retryButton}>
            Try again
          </Button>
        </View>
      </Screen>
    );
  }

  const overall = attendance ? Math.round(attendance.overall_attendance_percentage) : 0;
  const subjects = attendance?.subjects || [];
  const shortageSubjects = subjects.filter((s) => s.is_shortage || s.attendance_percentage < (s.threshold || 75.0));
  const totalEligible = subjects.reduce((sum, s) => sum + s.total_eligible_sessions, 0);
  const totalAttended = subjects.reduce((sum, s) => sum + s.attended_sessions, 0);

  return (
    <Screen
      title="Attendance"
      subtitle="By subject and by day"
      right={
        <Pressable
          onPress={() => fetchAttendance(true)}
          style={styles.headerRefreshBtn}
          accessibilityLabel="Refresh attendance"
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
            Viewing cached data {cachedTime ? `· Updated ${cachedTime}` : ''}
          </Text>
        </View>
      )}

      {/* Overall Attendance Summary Card matching Figma Ring design */}
      <Card style={styles.overallCard}>
        <View style={styles.overallRow}>
          <Ring pct={overall} size={104} threshold={75} />
          <View style={styles.overallTextContainer}>
            <Text style={styles.overallLabel}>Overall attendance</Text>
            <Text style={styles.overallHeadline}>
              {overall >= 75 ? "You're doing great" : 'Needs a little care'}
            </Text>
            <View style={styles.countsRow}>
              <Text style={styles.countsText}>
                {totalAttended} / {totalEligible} sessions attended
              </Text>
            </View>
            <View style={{ marginTop: 6, alignSelf: 'flex-start' }}>
              <Chip tone={overall >= 75 ? 'forest' : 'amber'}>
                <Sparkles size={12} /> {overall >= 75 ? 'Above 75% threshold' : 'Below 75% requirement'}
              </Chip>
            </View>
          </View>
        </View>
      </Card>

      {/* Prominent Shortage Alert Banner if any subject is below 75% */}
      {shortageSubjects.length > 0 && (
        <View style={styles.shortageBannersContainer}>
          {shortageSubjects.map((s) => {
            const recoverText =
              s.classes_to_recover !== null && s.classes_to_recover > 0
                ? `Attend the next ${s.classes_to_recover} classes in a row to reach ${s.threshold}%.`
                : s.is_recoverable === false
                ? `Threshold unreachable this term. Consult department advisor.`
                : `Currently right at threshold.`;

            return (
              <Card key={s.teaching_assignment_id} tone="apricot" style={styles.alertCard}>
                <View style={styles.alertRow}>
                  <IconBubble icon={Clock} tone="apricot" size={40} />
                  <View style={styles.alertContent}>
                    <Text style={styles.alertTitle}>
                      {s.subject_name} is at {Math.round(s.attendance_percentage)}%
                    </Text>
                    <Text style={styles.alertAdvice}>{recoverText}</Text>
                  </View>
                </View>
              </Card>
            );
          })}
        </View>
      )}

      {/* Subject Wise Attendance List */}
      <SectionTitle
        action={
          <Text style={styles.sectionCountText}>
            {subjects.length} enrolled {subjects.length === 1 ? 'course' : 'courses'}
          </Text>
        }
      >
        Your subjects
      </SectionTitle>

      {subjects.length === 0 ? (
        <Card style={styles.emptyCard}>
          <BookOpen size={36} color={Colors.soft} />
          <Text style={styles.emptyTitle}>No courses enrolled</Text>
          <Text style={styles.emptyMessage}>
            You have no active course section enrollments for this academic term.
          </Text>
        </Card>
      ) : (
        <View style={styles.subjectsList}>
          {subjects.map((s) => {
            const isBelow = s.attendance_percentage < (s.threshold || 75.0);
            const isZeroSessions = s.total_eligible_sessions === 0;

            let adviceText = '';
            if (isZeroSessions) {
              adviceText = 'No eligible classes held yet this term';
            } else if (isBelow) {
              if (s.classes_to_recover !== null && s.classes_to_recover > 0) {
                adviceText = `Attend ${s.classes_to_recover} more in a row to reach ${s.threshold}%`;
              } else if (!s.is_recoverable) {
                adviceText = `Target unreachable this term`;
              } else {
                adviceText = `At threshold line — keep attending`;
              }
            } else if (s.classes_can_miss > 0) {
              adviceText = `You can miss ${s.classes_can_miss} and stay above ${s.threshold}%`;
            } else {
              adviceText = 'Right at the line — keep going';
            }

            return (
              <Card
                key={s.teaching_assignment_id}
                onPress={() => handleCardPress(s)}
                style={styles.subjectCard}
              >
                <View style={styles.subjectHeaderRow}>
                  <View style={styles.subjectTitleContainer}>
                    <Text style={styles.subjectName}>{s.subject_name}</Text>
                    <Text style={styles.subjectCode}>
                      {s.subject_code} · {s.faculty_name}
                    </Text>
                  </View>
                  <View style={styles.subjectPctContainer}>
                    <Text
                      style={[
                        styles.pctNumber,
                        isBelow && styles.pctBelow,
                        isZeroSessions && styles.pctNeutral,
                      ]}
                    >
                      {isZeroSessions ? '—' : `${Math.round(s.attendance_percentage)}%`}
                    </Text>
                    <ChevronRight size={18} color={Colors.soft} />
                  </View>
                </View>

                <View style={styles.barWrapper}>
                  <Bar
                    pct={isZeroSessions ? 0 : s.attendance_percentage}
                    threshold={s.threshold || 75.0}
                  />
                </View>

                <View style={styles.metaRow}>
                  <Text style={styles.adviceText}>{adviceText}</Text>
                  <View style={styles.chipWrapper}>
                    {isZeroSessions ? (
                      <Chip tone="soft">New Enrollment</Chip>
                    ) : (
                      <Chip tone={isBelow ? 'rose' : 'forest'}>
                        {s.attended_sessions} / {s.total_eligible_sessions} sessions
                      </Chip>
                    )}
                  </View>
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
  overallCard: {
    marginBottom: 14,
  },
  overallRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  overallTextContainer: {
    flex: 1,
  },
  overallLabel: {
    fontSize: 13,
    color: Colors.soft,
  },
  overallHeadline: {
    fontSize: 19,
    fontWeight: '700',
    color: Colors.ink,
    marginTop: 2,
  },
  countsRow: {
    marginTop: 4,
  },
  countsText: {
    fontSize: 12,
    color: Colors.soft,
  },
  shortageBannersContainer: {
    gap: 10,
    marginBottom: 14,
  },
  alertCard: {
    borderLeftWidth: 4,
    borderLeftColor: Colors.apricot,
  },
  alertRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  alertContent: {
    flex: 1,
  },
  alertTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.ink,
  },
  alertAdvice: {
    fontSize: 13,
    color: Colors.soft,
    marginTop: 2,
  },
  sectionCountText: {
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
  subjectsList: {
    gap: 12,
    marginTop: 4,
    marginBottom: 24,
  },
  subjectCard: {
    marginBottom: 2,
  },
  subjectHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  subjectTitleContainer: {
    flex: 1,
    paddingRight: 8,
  },
  subjectName: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.ink,
  },
  subjectCode: {
    fontSize: 12,
    color: Colors.soft,
    marginTop: 2,
  },
  subjectPctContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  pctNumber: {
    fontSize: 20,
    fontWeight: '700',
    color: Colors.ink,
  },
  pctBelow: {
    color: Colors.rose,
  },
  pctNeutral: {
    color: Colors.soft,
  },
  barWrapper: {
    marginVertical: 4,
  },
  metaRow: {
    marginTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  adviceText: {
    fontSize: 12,
    color: Colors.soft,
    flex: 1,
  },
  chipWrapper: {
    flexShrink: 0,
  },
});
