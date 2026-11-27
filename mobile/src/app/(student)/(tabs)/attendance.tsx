import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
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
  ChevronRight,
  ChevronLeft,
  RefreshCw,
  Sparkles,
  WifiOff,
  BookOpen,
  Calendar as CalendarIcon,
  CheckCircle2,
  XCircle,
  HelpCircle,
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
import { SessionStore } from '@/storage/sessionStore';
import {
  StudentRepository,
  StudentPersonalAttendanceResponse,
  StudentSubjectSummary,
} from '@/storage/studentRepository';
import { AttendanceTrendLineChart } from '@/components/charts';

export interface CalendarSessionItem {
  session_id: string;
  session_date: string;
  period_slot: number;
  time_slot: string;
  subject_code: string;
  subject_name: string;
  faculty_name: string;
  attendance_status: 'PRESENT' | 'ABSENT' | 'EXCUSED';
  status_reason?: string | null;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

export default function StudentAttendanceScreen() {
  const router = useRouter();
  const [data, setData] = useState<StudentPersonalAttendanceResponse | null>(null);
  const [calendarSessions, setCalendarSessions] = useState<CalendarSessionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [isOffline, setIsOffline] = useState(false);

  // Month navigation: default to today's date
  const [currentDate, setCurrentDate] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });

  const touchStartXRef = useRef<number>(0);

  const loadAttendance = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    const token = SessionStore.getToken();
    const user = SessionStore.getUser();
    const studentId = user?.id;

    try {
      if (studentId) {
        const cached = await StudentRepository.getCachedAttendance(studentId);
        if (cached && cached.data) {
          setData(cached.data);
        }
      }

      // 1. Fetch Subject Summary
      const res = await fetch(`${API_BASE_URL}/api/v1/student/attendance`, {
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });

      if (res.ok) {
        const live: StudentPersonalAttendanceResponse = await res.json();
        setData(live);
        setIsOffline(false);
        if (studentId) {
          await StudentRepository.saveCachedAttendance(studentId, live);
        }
      } else {
        setIsOffline(true);
      }

      // 2. Fetch Calendar Sessions
      const calRes = await fetch(`${API_BASE_URL}/api/v1/student/attendance/calendar`, {
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });

      if (calRes.ok) {
        const liveCal: CalendarSessionItem[] = await calRes.json();
        if (Array.isArray(liveCal)) {
          setCalendarSessions(liveCal);
        }
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

  // Month Switchers
  const year = currentDate.getFullYear();
  const month = currentDate.getMonth(); // 0-indexed
  const monthTitle = `${MONTH_NAMES[month]} ${year}`;

  const handlePrevMonth = () => {
    setCurrentDate(new Date(year, month - 1, 1));
  };

  const handleNextMonth = () => {
    setCurrentDate(new Date(year, month + 1, 1));
  };

  // Touch Swipe Handlers for Month Switch
  const onTouchStart = (e: any) => {
    touchStartXRef.current = e.nativeEvent.pageX;
  };

  const onTouchEnd = (e: any) => {
    const endX = e.nativeEvent.pageX;
    const diff = endX - touchStartXRef.current;
    if (diff > 50) {
      handlePrevMonth(); // Swiped right -> go to previous month
    } else if (diff < -50) {
      handleNextMonth(); // Swiped left -> go to next month
    }
  };

  // Calendar Day Grid Calculation
  const firstDayIndex = (new Date(year, month, 1).getDay() + 6) % 7; // Monday = 0 ... Sunday = 6
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const days = Array.from({ length: daysInMonth }, (_, i) => i + 1);

  // Group sessions by date
  const sessionsByDate: Record<string, CalendarSessionItem[]> = {};
  for (const s of calendarSessions) {
    if (!sessionsByDate[s.session_date]) {
      sessionsByDate[s.session_date] = [];
    }
    sessionsByDate[s.session_date].push(s);
  }

  // Attendance dot status for day
  const getDayStatus = (d: number): 'present' | 'absent' | 'excused' | null => {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const sess = sessionsByDate[dateStr];
    if (!sess || sess.length === 0) return null;
    if (sess.some((x) => x.attendance_status === 'ABSENT')) return 'absent';
    if (sess.every((x) => x.attendance_status === 'PRESENT')) return 'present';
    if (sess.some((x) => x.attendance_status === 'EXCUSED')) return 'excused';
    return 'present';
  };

  // Sessions for currently selected date
  const selectedDateSessions = sessionsByDate[selectedDate] || [];

  const formattedSelectedDate = (() => {
    try {
      const parts = selectedDate.split('-');
      if (parts.length === 3) {
        const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
        return d.toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        });
      }
    } catch (_) {}
    return selectedDate;
  })();

  // Dynamic Weekly Trend Calculation from backend or calendar sessions
  const dynamicTrend = useMemo(() => {
    if (data?.weekly_trend && data.weekly_trend.length > 0) {
      return data.weekly_trend.map((t) => ({
        label: t.period_label,
        value: t.attendance_percentage != null ? Math.round(t.attendance_percentage) : 0,
      }));
    }
    if (calendarSessions.length > 0) {
      const counted = calendarSessions.filter(
        (s) => (s as any).applicability_status !== 'CANCELLED' && (s as any).applicability_status !== 'EXEMPT'
      );
      if (counted.length > 0) {
        const weeksMap: Record<string, typeof counted> = {};
        for (const s of counted) {
          const d = new Date(s.session_date);
          const yr = d.getFullYear();
          const oneJan = new Date(yr, 0, 1);
          const numberOfDays = Math.floor((d.getTime() - oneJan.getTime()) / (24 * 60 * 60 * 1000));
          const wk = Math.ceil((d.getDay() + 1 + numberOfDays) / 7);
          const key = `${yr}-W${String(wk).padStart(2, '0')}`;
          if (!weeksMap[key]) weeksMap[key] = [];
          weeksMap[key].push(s);
        }
        const sortedWeeks = Object.keys(weeksMap).sort();
        return sortedWeeks.map((wKey, idx) => {
          const sessList = weeksMap[wKey];
          const pres = sessList.filter(
            (s) => s.attendance_status === 'PRESENT' || s.attendance_status === 'EXCUSED'
          ).length;
          const pct = Math.round((pres / sessList.length) * 100);
          return {
            label: `W${idx + 1}`,
            value: pct,
          };
        });
      }
    }
    return [];
  }, [data?.weekly_trend, calendarSessions]);

  return (
    <Screen
      title="Attendance"
      subtitle="Monthly calendar and session breakdown"
      right={
        <Pressable
          onPress={() => loadAttendance(true)}
          style={styles.headerRefreshBtn}
          accessibilityLabel="Refresh attendance"
          hitSlop={8}
        >
          {refreshing ? (
            <ActivityIndicator size="small" color={Colors.forest} />
          ) : (
            <RefreshCw size={18} color={Colors.ink} />
          )}
        </Pressable>
      }
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => loadAttendance(true)}
          tintColor={Colors.forest}
          colors={[Colors.primary, Colors.forest]}
        />
      }
      scrollable
    >
      {isOffline && (
        <View style={styles.offlineBanner}>
          <WifiOff size={16} color={Colors.amber} />
          <Text style={styles.offlineBannerText}>
            You're viewing saved attendance data
          </Text>
        </View>
      )}

      {/* 1. CALENDAR FIRST WITH SWIPE & MONTH NAVIGATION */}
      <View
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <Card style={styles.calendarCard}>
          {/* Month Switcher Header */}
          <View style={styles.monthHeaderRow}>
            <Pressable
              onPress={handlePrevMonth}
              hitSlop={12}
              style={styles.monthArrowButton}
              accessibilityLabel="Previous month"
            >
              <ChevronLeft size={20} color={Colors.ink} />
            </Pressable>

            <View style={styles.monthTitleWrapper}>
              <CalendarIcon size={16} color={Colors.forest} style={{ marginRight: 6 }} />
              <Text style={styles.monthTitleText}>{monthTitle}</Text>
            </View>

            <Pressable
              onPress={handleNextMonth}
              hitSlop={12}
              style={styles.monthArrowButton}
              accessibilityLabel="Next month"
            >
              <ChevronRight size={20} color={Colors.ink} />
            </Pressable>
          </View>

          {/* Weekday Labels (Mon - Sun) */}
          <View style={styles.calendarWeekRow}>
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((w, idx) => (
              <Text key={`${w}-${idx}`} style={styles.calendarWeekHeader}>
                {w}
              </Text>
            ))}
          </View>

          {/* Days Grid */}
          <View style={styles.calendarGrid}>
            {Array.from({ length: firstDayIndex }, (_, i) => (
              <View key={`empty-${i}`} style={styles.calendarDayCell} />
            ))}

            {days.map((d) => {
              const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
              const isSelected = selectedDate === dateStr;
              const status = getDayStatus(d);

              return (
                <Pressable
                  key={`day-${d}`}
                  onPress={() => setSelectedDate(dateStr)}
                  style={({ pressed }) => [
                    styles.calendarDayCell,
                    isSelected && styles.dayCellSelected,
                    pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text
                    style={[
                      styles.dayText,
                      isSelected && styles.dayTextSelected,
                    ]}
                  >
                    {d}
                  </Text>
                  {status && (
                    <View
                      style={[
                        styles.indicatorDot,
                        status === 'present' && styles.dotPresent,
                        status === 'absent' && styles.dotAbsent,
                        status === 'excused' && styles.dotExcused,
                      ]}
                    />
                  )}
                </Pressable>
              );
            })}
          </View>

          {/* Calendar Legend */}
          <View style={styles.calendarLegendRow}>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, styles.dotPresent]} />
              <Text style={styles.legendLabel}>Attended</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, styles.dotAbsent]} />
              <Text style={styles.legendLabel}>Missed</Text>
            </View>
            <View style={styles.legendItem}>
              <View style={[styles.legendDot, styles.dotExcused]} />
              <Text style={styles.legendLabel}>Excused</Text>
            </View>
            <Text style={styles.swipeHintText}>Swipe ↔ to change month</Text>
          </View>
        </Card>
      </View>

      {/* 2. SESSIONS BREAKDOWN FOR SELECTED DATE */}
      <SectionTitle>Classes on {formattedSelectedDate}</SectionTitle>
      {selectedDateSessions.length > 0 ? (
        <View style={styles.dailySessionsList}>
          {selectedDateSessions.map((session) => (
            <Card key={session.session_id} style={styles.sessionCard}>
              <View style={styles.sessionHeaderRow}>
                <View style={styles.slotBadge}>
                  <Clock size={12} color={Colors.forest} />
                  <Text style={styles.slotBadgeText}>{session.time_slot}</Text>
                </View>
                <Chip
                  tone={
                    session.attendance_status === 'PRESENT'
                      ? 'forest'
                      : (session.attendance_status as any) === 'CANCELLED'
                      ? 'soft'
                      : session.attendance_status === 'ABSENT'
                      ? 'rose'
                      : 'amber'
                  }
                >
                  {session.attendance_status === 'PRESENT'
                    ? 'Attended'
                    : (session.attendance_status as any) === 'CANCELLED'
                    ? 'Cancelled'
                    : session.attendance_status === 'ABSENT'
                    ? 'Missed'
                    : 'Excused'}
                </Chip>
              </View>

              <Text style={styles.sessionSubjectName}>
                {session.subject_code} · {session.subject_name}
              </Text>
              <Text style={styles.sessionFacultyName}>
                Faculty: {session.faculty_name}
              </Text>

              {session.status_reason && (
                <View style={styles.reasonBlock}>
                  <Text style={styles.reasonText}>Note: {session.status_reason}</Text>
                </View>
              )}
            </Card>
          ))}
        </View>
      ) : (
        <Card style={styles.emptySessionCard}>
          <Clock size={24} color={Colors.soft} style={{ marginBottom: 6 }} />
          <Text style={styles.emptySessionTitle}>No classes recorded</Text>
          <Text style={styles.emptySessionSub}>
            No scheduled or recorded attendance sessions found for {formattedSelectedDate}.
          </Text>
        </Card>
      )}

      {/* 3. SUBJECTS BREAKDOWN */}
      <SectionTitle>Subjects Breakdown</SectionTitle>
      <View style={styles.subjectsContainer}>
        {data?.subjects && data.subjects.length > 0 ? (
          data.subjects.map((s) => (
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
          ))
        ) : (
          <Card style={styles.subjectCard}>
            <Text style={{ textAlign: 'center', width: '100%', color: Colors.soft, fontSize: 13 }}>
              No subjects enrolled yet.
            </Text>
          </Card>
        )}
      </View>

      {/* 4. OVERALL ATTENDANCE PROGRESSION TREND */}
      <View style={{ marginTop: 14 }}>
        <AttendanceTrendLineChart
          data={dynamicTrend}
          threshold={75}
          title="Attendance Progression Trend"
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerRefreshBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#f1f5f3',
  },
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
  calendarCard: {
    padding: 16,
    marginBottom: 14,
  },
  monthHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  monthArrowButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.cream,
    alignItems: 'center',
    justifyContent: 'center',
  },
  monthTitleWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  monthTitleText: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.ink,
  },
  calendarWeekRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: 8,
  },
  calendarWeekHeader: {
    width: 38,
    textAlign: 'center',
    fontSize: 12,
    fontWeight: '600',
    color: Colors.soft,
  },
  calendarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-around',
    rowGap: 6,
  },
  calendarDayCell: {
    width: 38,
    height: 42,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 2,
  },
  dayCellSelected: {
    backgroundColor: Colors.forest,
  },
  dayText: {
    fontSize: 14,
    color: Colors.ink,
    fontWeight: '500',
  },
  dayTextSelected: {
    color: '#ffffff',
    fontWeight: '700',
  },
  indicatorDot: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    marginTop: 3,
  },
  dotPresent: {
    backgroundColor: Colors.forest,
  },
  dotAbsent: {
    backgroundColor: Colors.rose,
  },
  dotExcused: {
    backgroundColor: Colors.amber,
  },
  calendarLegendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 14,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: Colors.line,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  legendDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
  },
  legendLabel: {
    fontSize: 11,
    color: Colors.soft,
  },
  swipeHintText: {
    marginLeft: 'auto',
    fontSize: 10,
    color: Colors.soft,
    fontStyle: 'italic',
  },
  dailySessionsList: {
    gap: 10,
    marginBottom: 16,
  },
  sessionCard: {
    padding: 14,
    gap: 6,
  },
  sessionHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  slotBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.forest50,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
  },
  slotBadgeText: {
    fontSize: 12,
    color: Colors.forest,
    fontWeight: '600',
  },
  sessionSubjectName: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.ink,
    marginTop: 2,
  },
  sessionFacultyName: {
    fontSize: 12,
    color: Colors.soft,
  },
  reasonBlock: {
    backgroundColor: '#fff9eb',
    padding: 6,
    borderRadius: 6,
    marginTop: 4,
  },
  reasonText: {
    fontSize: 11,
    color: '#8f6500',
  },
  emptySessionCard: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 24,
    paddingHorizontal: 16,
    marginBottom: 16,
  },
  emptySessionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.ink,
    marginBottom: 2,
  },
  emptySessionSub: {
    fontSize: 12,
    color: Colors.soft,
    textAlign: 'center',
  },
  subjectsContainer: {
    gap: 10,
    marginBottom: 10,
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
});
