import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import {
  Bell,
  Clock,
  ScanFace,
  Sparkles,
  ChevronRight,
  GraduationCap,
  RefreshCw,
} from 'lucide-react-native';

import {
  Screen,
  Card,
  Ring,
  Chip,
  IconBubble,
  Bar,
  SectionTitle,
} from '@/components/ui/kit';
import { Colors } from '@/theme/tokens';
import { API_BASE_URL } from '@/config/api';
import { KlasioLogo } from '@/components/ui/KlasioLogo';
import {
  StudentRepository,
  StudentPersonalAttendanceResponse,
  StudentSubjectSummary,
} from '@/storage/studentRepository';
import { SessionStore } from '@/storage/sessionStore';
import { NotificationRepository } from '@/storage/notificationRepository';
import { AttendanceBarChart, AttendanceTrendLineChart } from '@/components/charts';

export default function StudentHomeScreen() {
  const router = useRouter();
  const [user, setUser] = useState(SessionStore.getUser());
  const [data, setData] = useState<StudentPersonalAttendanceResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [unreadCount, setUnreadCount] = useState<number>(0);

  const fetchAttendance = useCallback(async () => {
    const token = SessionStore.getToken();
    const stored = SessionStore.getUser();
    if (!token) return;
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/student/attendance`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (res.ok) {
        const liveData: StudentPersonalAttendanceResponse = await res.json();
        setData(liveData);
        if (stored?.id) {
          await StudentRepository.saveCachedAttendance(stored.id, liveData);
        }
      }
    } catch (e) {
      console.warn('Failed to sync student attendance:', e);
    }
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchAttendance();
    const stored = SessionStore.getUser();
    const token = SessionStore.getToken();
    if (stored) {
      const count = await NotificationRepository.getUnreadCount(stored.id, token);
      setUnreadCount(count);
    }
    setRefreshing(false);
  }, [fetchAttendance]);

  const faceStatus: 'none' | 'pending' | 'approved' = useMemo(() => {
    const state = user?.faceRegistrationState;
    if (state === 'REGISTERED') return 'approved';
    if (state === 'PENDING') return 'pending';
    return 'none';
  }, [user?.faceRegistrationState]);

  const refreshUserData = useCallback(() => {
    const stored = SessionStore.getUser();
    if (stored) {
      setUser(stored);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      refreshUserData();
    }, [refreshUserData])
  );

  useEffect(() => {
    const unsub = SessionStore.subscribe((session) => {
      if (session?.user) {
        setUser(session.user);
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    let isCancelled = false;
    async function loadData() {
      const stored = SessionStore.getUser() || (await SessionStore.initFromStorage())?.user;
      if (stored && !isCancelled) {
        setUser(stored);
      }

      if (stored?.id) {
        try {
          const cached = await StudentRepository.getCachedAttendance(stored.id);
          if (cached?.data && cached.data.subjects.length > 0 && !isCancelled) {
            setData(cached.data);
          }
        } catch {
          // ignore cache read error
        }
      }

      const token = SessionStore.getToken();
      if (token) {
        try {
          setLoading(true);
          const res = await fetch(`${API_BASE_URL}/api/v1/student/attendance`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          });
          if (res.ok) {
            const liveData: StudentPersonalAttendanceResponse = await res.json();
            if (!isCancelled) {
              setData(liveData);
              if (stored?.id) {
                await StudentRepository.saveCachedAttendance(stored.id, liveData);
              }
            }
          }
        } catch (e) {
          console.warn('Failed to sync student attendance:', e);
        } finally {
          if (!isCancelled) setLoading(false);
        }
      }

      if (stored) {
        const count = await NotificationRepository.getUnreadCount(stored.id, token);
        if (!isCancelled) setUnreadCount(count);
      }
    }
    loadData();
    return () => {
      isCancelled = true;
    };
  }, []);

  const totalEligibleSessions =
    data?.total_eligible_sessions ??
    (data?.subjects?.reduce((sum, s) => sum + s.total_eligible_sessions, 0) ?? 0);
  const hasClasses = totalEligibleSessions > 0;
  const overall = hasClasses && data ? Math.round(data.overall_attendance_percentage) : null;
  const lowSubject = hasClasses ? data?.subjects.find((s) => s.is_shortage || s.attendance_percentage < 75) : undefined;

  return (
    <Screen
      left={<KlasioLogo variant="lockup" size={24} />}
      subtitle="Hi there 👋"
      title={user?.fullName || 'Student'}
      right={
        <View style={styles.headerRightActions}>
          <Pressable
            style={styles.refreshIconBtn}
            onPress={handleRefresh}
            accessibilityLabel="Refresh attendance"
            hitSlop={8}
          >
            {refreshing ? (
              <ActivityIndicator size="small" color={Colors.forest} />
            ) : (
              <RefreshCw size={18} color={Colors.ink} />
            )}
          </Pressable>
          <Pressable
            style={styles.notificationWrapper}
            onPress={() => router.push('/notifications' as any)}
            accessibilityLabel="Notifications"
          >
            <Bell size={20} color={Colors.ink} />
            {unreadCount > 0 && <View style={styles.unreadDot} />}
          </Pressable>
        </View>
      }
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={handleRefresh}
          tintColor={Colors.forest}
          colors={[Colors.primary, Colors.forest]}
        />
      }
      scrollable
    >
      <Card style={styles.heroCard}>
        <Ring pct={overall ?? 0} size={110} />
        <View style={styles.heroTextCol}>
          <Text style={styles.overallLabel}>Overall attendance</Text>
          <Text style={styles.overallHeadline}>
            {!hasClasses
              ? 'No classes conducted'
              : overall !== null && overall >= 75
              ? "You're doing great"
              : 'Needs a little care'}
          </Text>
          {hasClasses ? (
            <Chip tone={overall !== null && overall >= 75 ? 'forest' : 'amber'} style={styles.sparkleChip}>
              {overall !== null && overall >= 75 ? 'Above 75% requirement' : 'Below 75% requirement'}
            </Chip>
          ) : (
            <Text style={{ fontSize: 12, color: Colors.soft, marginTop: 4 }}>
              Tracking activates after first class
            </Text>
          )}
        </View>
      </Card>

      {lowSubject && (
        <Card style={styles.shortageCard}>
          <View style={styles.shortageRow}>
            <IconBubble icon={Clock} tone="apricot" size={42} />
            <View style={styles.shortageCol}>
              <Text style={styles.shortageTitle}>
                {lowSubject.subject_name} is at {Math.round(lowSubject.attendance_percentage)}%
              </Text>
              <Text style={styles.shortageDesc}>
                Attend the next{' '}
                <Text style={styles.boldText}>
                  {lowSubject.classes_to_recover ?? 2} classes
                </Text>{' '}
                to get back to 75%.
              </Text>
            </View>
          </View>
        </Card>
      )}

      {faceStatus !== 'approved' && (
        <Card
          onPress={() => router.push('/(student)/enrollment' as any)}
          style={styles.faceCard}
        >
          <IconBubble icon={ScanFace} tone="lilac" size={42} />
          <View style={styles.faceCol}>
            <Text style={styles.faceTitle}>
              {faceStatus === 'none' ? 'Set up Face ID' : 'Face ID is being checked'}
            </Text>
            <Text style={styles.faceSubtitle}>
              {faceStatus === 'none'
                ? 'Takes 1 minute. Get marked automatically.'
                : 'Your teacher will mark you by hand until verified'}
            </Text>
          </View>
          {faceStatus === 'none' ? (
            <ChevronRight size={18} color={Colors.soft} />
          ) : (
            <Chip tone="amber">Pending</Chip>
          )}
        </Card>
      )}

      {/* Subject Attendance Comparison SVG Chart */}
      {data?.subjects && data.subjects.length > 0 && (
        <AttendanceBarChart
          data={data.subjects.map((s) => ({
            label: s.subject_code,
            value: s.attendance_percentage,
            id: s.teaching_assignment_id,
          }))}
          threshold={75}
          title="Course Attendance Overview"
        />
      )}

      <SectionTitle
        action={
          <Pressable onPress={() => router.push('/(student)/attendance' as any)}>
            <Text style={styles.seeAllText}>See all</Text>
          </Pressable>
        }
      >
        Your attendance, at a glance
      </SectionTitle>
      <Text style={styles.sectionSubtitle}>
        See where you stand in every class.
      </Text>

      <View style={styles.subjectsList}>
        {data?.subjects && data.subjects.length > 0 ? (
          data.subjects.slice(0, 3).map((s) => (
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
                <View style={styles.subjectTopRow}>
                  <Text style={styles.subjectName}>{s.subject_name}</Text>
                  <Text
                    style={[
                      styles.subjectPct,
                      s.attendance_percentage < 75 && styles.subjectPctLow,
                    ]}
                  >
                    {Math.round(s.attendance_percentage)}%
                  </Text>
                </View>

                <View style={styles.progressBarWrapper}>
                  <Bar pct={s.attendance_percentage} threshold={75} />
                </View>

                <Text style={styles.subjectGuidance}>
                  {s.attendance_percentage < 75
                    ? `Attend ${s.classes_to_recover ?? 2} more in a row to reach 75%`
                    : s.classes_can_miss > 0
                    ? `You can miss ${s.classes_can_miss} and stay above 75%`
                    : 'Right at the line — keep attending'}
                </Text>
              </Card>
            </Pressable>
          ))
        ) : (
          <Card style={styles.subjectCard}>
            <Text style={[styles.subjectGuidance, { textAlign: 'center', width: '100%' }]}>
              No subjects enrolled yet.
            </Text>
          </Card>
        )}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerRightActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  refreshIconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  notificationWrapper: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: Colors.card,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadDot: {
    position: 'absolute',
    top: 9,
    right: 10,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.apricot,
  },
  heroCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
    padding: 18,
  },
  heroTextCol: {
    flex: 1,
  },
  overallLabel: {
    fontSize: 13,
    color: Colors.soft,
  },
  overallHeadline: {
    fontSize: 20,
    fontWeight: '700',
    color: Colors.ink,
    marginTop: 2,
    marginBottom: 6,
  },
  sparkleChip: {
    alignSelf: 'flex-start',
  },
  shortageCard: {
    marginTop: 12,
    backgroundColor: Colors.apricot50,
    padding: 14,
  },
  shortageRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  shortageCol: {
    flex: 1,
  },
  shortageTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.ink,
  },
  shortageDesc: {
    fontSize: 12,
    color: Colors.soft,
    marginTop: 2,
  },
  boldText: {
    fontWeight: '700',
    color: Colors.ink,
  },
  faceCard: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
  },
  faceCol: {
    flex: 1,
  },
  faceTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.ink,
  },
  faceSubtitle: {
    fontSize: 11,
    color: Colors.soft,
    marginTop: 2,
  },
  seeAllText: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.forest,
  },
  sectionSubtitle: {
    fontSize: 13,
    color: Colors.soft,
    marginTop: -8,
    marginBottom: 12,
  },
  subjectsList: {
    gap: 10,
    marginBottom: 16,
  },
  subjectCard: {
    padding: 14,
  },
  subjectTopRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  subjectName: {
    fontSize: 15,
    fontWeight: '600',
    color: Colors.ink,
  },
  subjectPct: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.forest,
  },
  subjectPctLow: {
    color: Colors.rose,
  },
  progressBarWrapper: {
    marginTop: 8,
    marginBottom: 6,
  },
  subjectGuidance: {
    fontSize: 11,
    color: Colors.soft,
  },
});
