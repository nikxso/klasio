import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ActivityIndicator,
  RefreshControl,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  Clock,
  AlertTriangle,
  ChevronRight,
  ChevronLeft,
  RefreshCw,
  Sparkles,
  WifiOff,
  BookOpen,
} from 'lucide-react-native';

import {
  Screen,
  Card,
  Bar,
  Ring,
  Chip,
  IconBubble,
  SectionTitle,
  Button,
} from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';
import { API_BASE_URL } from '@/config/api';
import {
  StudentRepository,
  StudentPersonalAttendanceResponse,
  StudentSubjectSummary,
  StudentSessionHistoryItem,
} from '@/storage/studentRepository';
import { AttendanceTrendLineChart } from '@/components/charts';

const DEFAULT_FALLBACK_ATTENDANCE: StudentPersonalAttendanceResponse = {
  student_id: 'stu-aarav-21cs037',
  overall_attendance_percentage: 82.0,
  subjects: [
    {
      subject_id: 'sub-01',
      teaching_assignment_id: 'ta-01',
      subject_code: 'CS301',
      subject_name: 'Data Structures',
      faculty_name: 'Dr. Lakshmi Iyer',
      total_eligible_sessions: 42,
      attended_sessions: 36,
      attendance_percentage: 85.7,
      effective_start_date: '2026-08-01',
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
      faculty_name: 'Prof. Rahul Menon',
      total_eligible_sessions: 38,
      attended_sessions: 27,
      attendance_percentage: 71.0,
      effective_start_date: '2026-08-01',
      classes_to_recover: 3,
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
      faculty_name: 'Dr. Fatima Khan',
      total_eligible_sessions: 35,
      attended_sessions: 28,
      attendance_percentage: 80.0,
      effective_start_date: '2026-08-01',
      classes_to_recover: 0,
      classes_can_miss: 2,
      is_shortage: false,
      is_recoverable: true,
      threshold: 75.0,
    },
  ],
};

export default function StudentAttendanceScreen() {
  const router = useRouter();
  const [data, setData] = useState<StudentPersonalAttendanceResponse>(DEFAULT_FALLBACK_ATTENDANCE);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isOffline, setIsOffline] = useState(false);
  const [selectedSubjectId, setSelectedSubjectId] = useState<string | null>(null);

  // Month state: defaults to October 2026 per Figma prototype
  const [monthName] = useState('October 2026');
  const [year] = useState(2026);
  const [monthIndex] = useState(9); // 0-indexed: 9 = October

  const loadAttendance = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const cached = await StudentRepository.getCachedAttendance(DEFAULT_FALLBACK_ATTENDANCE.student_id);
      if (cached && cached.data) {
        setData(cached.data);
      }

      const res = await fetch(`${API_BASE_URL}/api/v1/student/attendance`, {
        headers: { Accept: 'application/json' },
      });

      if (res.ok) {
        const live: StudentPersonalAttendanceResponse = await res.json();
        setData(live);
        setIsOffline(false);
        await StudentRepository.saveCachedAttendance(DEFAULT_FALLBACK_ATTENDANCE.student_id, live);
      } else {
        setIsOffline(true);
      }
    } catch {
      setIsOffline(true);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadAttendance();
  }, [loadAttendance]);

  // Generate calendar days for October (31 days)
  // 1 Oct 2026 was a Thursday (index 3 if Monday is 0)
  const firstDayOffset = 3;
  const daysInMonth = 31;
  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  // Determine actual attendance status for past days:
  // Day 1: Present, Day 2: Absent, Day 3: Excused, Day 4 (Today): Present
  const getAttendanceStatusForDay = (d: number): 'present' | 'absent' | 'excused' | null => {
    if (d > 4) return null; // Future dates
    if (d === 2) return 'absent';
    if (d === 3) return 'excused';
    return 'present';
  };

  return (
    <Screen
      title="Attendance"
      subtitle="By subject and by day"
      scrollable
    >
      {isOffline && (
        <View style={styles.offlineBanner}>
          <WifiOff size={16} color={Colors.amber} />
          <Text style={styles.offlineBannerText}>
            You're viewing saved data
          </Text>
        </View>
      )}

      {/* Overall Attendance Progression Trend */}
      <AttendanceTrendLineChart
        data={[
          { label: 'Aug', value: 88 },
          { label: 'Sep W1', value: 85 },
          { label: 'Sep W3', value: 79 },
          { label: 'Oct W1', value: 82 },
          { label: 'Oct W3', value: 84 },
          { label: 'Now', value: Math.round(data.overall_attendance_percentage) },
        ]}
        threshold={75}
        title="Attendance Progression Trend"
      />

      {/* Subjects Breakdown */}
      <SectionTitle>Subjects Breakdown</SectionTitle>
      <View style={styles.subjectsContainer}>
        {data.subjects.map((s) => (
          <Pressable
            key={s.teaching_assignment_id}
            onPress={() =>
              router.push({
                pathname: '/(student)/subject/[id]',
                params: {
                  id: s.teaching_assignment_id,
                  subject: s.subject_name,
                  code: s.subject_code,
                  faculty: s.faculty_name,
                  held: String(s.total_eligible_sessions),
                  attended: String(s.attended_sessions),
                  pct: String(s.attendance_percentage),
                  threshold: String(s.threshold),
                  toRecover: String(s.classes_to_recover ?? 0),
                  canMiss: String(s.classes_can_miss),
                },
              })
            }
          >
            <Card style={styles.subjectCard}>
              <View style={styles.subjectHeader}>
                <View style={styles.subjectInfo}>
                  <Text style={styles.subjectName}>{s.subject_name}</Text>
                  <Text style={styles.subjectFaculty}>{s.faculty_name}</Text>
                </View>
                <Text
                  style={[
                    styles.subjectPct,
                    s.attendance_percentage < 75 && styles.subjectPctShortage,
                  ]}
                >
                  {Math.round(s.attendance_percentage)}%
                </Text>
              </View>

              <View style={styles.progressBarWrapper}>
                <Bar pct={s.attendance_percentage} threshold={75} />
              </View>

              <View style={styles.subjectFooter}>
                <Text style={styles.guidanceText}>
                  {s.attendance_percentage < 75
                    ? `Attend ${s.classes_to_recover ?? 2} more in a row to reach 75%`
                    : s.classes_can_miss > 0
                    ? `You can miss ${s.classes_can_miss} and stay above 75%`
                    : 'At the minimum threshold'}
                </Text>
                <ChevronRight size={16} color={Colors.soft} />
              </View>
            </Card>
          </Pressable>
        ))}
      </View>

      {/* Monthly Attendance Calendar */}
      <SectionTitle>{monthName}</SectionTitle>
      <Card style={styles.calendarCard}>
        {/* Day-of-Week Headers */}
        <View style={styles.calendarWeekRow}>
          {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
            <Text key={i} style={styles.calendarWeekHeader}>
              {d}
            </Text>
          ))}
        </View>

        {/* Days Grid */}
        <View style={styles.calendarGrid}>
          {Array.from({ length: firstDayOffset }, (_, i) => (
            <View key={`empty-${i}`} style={styles.calendarDayCell} />
          ))}

          {days.map((d) => {
            const status = getAttendanceStatusForDay(d);
            const isToday = d === 4;

            return (
              <View
                key={d}
                style={[
                  styles.calendarDayCell,
                  status === 'present' && styles.dayCellPresent,
                  status === 'absent' && styles.dayCellAbsent,
                  status === 'excused' && styles.dayCellExcused,
                  isToday && styles.dayCellToday,
                ]}
              >
                <Text
                  style={[
                    styles.dayText,
                    status === 'present' && styles.dayTextPresent,
                    status === 'absent' && styles.dayTextAbsent,
                    status === 'excused' && styles.dayTextExcused,
                  ]}
                >
                  {d}
                </Text>
              </View>
            );
          })}
        </View>

        {/* Legend */}
        <View style={styles.calendarLegendRow}>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: Colors.forest }]} />
            <Text style={styles.legendLabel}>Present</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: Colors.rose }]} />
            <Text style={styles.legendLabel}>Absent</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.legendDot, { backgroundColor: Colors.amber }]} />
            <Text style={styles.legendLabel}>Excused</Text>
          </View>
        </View>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  offlineBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#fff9eb',
    padding: 10,
    borderRadius: Radii.button,
    marginBottom: 12,
  },
  offlineBannerText: {
    fontSize: 12,
    color: '#8f6500',
    fontWeight: '500',
  },
  subjectsContainer: {
    gap: 10,
  },
  subjectCard: {
    padding: 14,
  },
  subjectHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  subjectInfo: {
    flex: 1,
  },
  subjectName: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.ink,
  },
  subjectFaculty: {
    fontSize: 12,
    color: Colors.soft,
    marginTop: 2,
  },
  subjectPct: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.forest,
  },
  subjectPctShortage: {
    color: Colors.rose,
  },
  progressBarWrapper: {
    marginTop: 10,
    marginBottom: 8,
  },
  subjectFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  guidanceText: {
    fontSize: 11,
    color: Colors.soft,
    flex: 1,
  },
  calendarCard: {
    padding: 16,
    marginBottom: 20,
  },
  calendarWeekRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: 10,
  },
  calendarWeekHeader: {
    width: 36,
    textAlign: 'center',
    fontSize: 11,
    fontWeight: '600',
    color: Colors.soft,
  },
  calendarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-around',
    rowGap: 8,
  },
  calendarDayCell: {
    width: 36,
    height: 36,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayCellPresent: {
    backgroundColor: Colors.forest50,
  },
  dayCellAbsent: {
    backgroundColor: Colors.rose50,
  },
  dayCellExcused: {
    backgroundColor: Colors.amber50,
  },
  dayCellToday: {
    borderWidth: 2,
    borderColor: Colors.forest,
  },
  dayText: {
    fontSize: 13,
    color: Colors.soft,
  },
  dayTextPresent: {
    color: Colors.forest,
    fontWeight: '700',
  },
  dayTextAbsent: {
    color: Colors.rose,
    fontWeight: '700',
  },
  dayTextExcused: {
    color: Colors.amber,
    fontWeight: '700',
  },
  calendarLegendRow: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 16,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: Colors.line,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  legendLabel: {
    fontSize: 11,
    color: Colors.soft,
  },
});
