import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  RefreshControl,
  ActivityIndicator,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  Bell,
  Clock,
  MapPin,
  ScanFace,
  CloudUpload,
  CloudOff,
  ChevronRight,
  BookOpen,
  UserCheck,
  BarChart3,
  Users,
  GraduationCap,
  ShieldCheck,
  RefreshCw,
} from 'lucide-react-native';

import { Screen, Card, Chip, SectionTitle } from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';
import { KlasioLogo } from '@/components/ui/KlasioLogo';
import { SessionStore, AuthUser } from '@/storage/sessionStore';
import { NotificationRepository } from '@/storage/notificationRepository';
import { API_BASE_URL } from '@/config/api';

export default function FacultyHomeScreen() {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(SessionStore.getUser());
  const [classes, setClasses] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [online] = useState(true);
  const [waitingRecords] = useState(0);
  const [unreadCount, setUnreadCount] = useState<number>(0);

  const loadFacultyData = useCallback(async () => {
    const stored = SessionStore.getUser() || (await SessionStore.initFromStorage())?.user;
    if (stored) setUser(stored);

    const token = SessionStore.getToken();
    if (stored) {
      const count = await NotificationRepository.getUnreadCount(stored.id, token);
      setUnreadCount(count);
    }

    if (token) {
      try {
        setLoading(true);
        const res = await fetch(`${API_BASE_URL}/api/v1/faculty/assignments`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data)) {
            const mapped = data.map((item: any, idx: number) => ({
              id: item.teaching_assignment_id || item.id,
              subject: item.subject_name,
              section: item.section_code,
              room: 'LH-204',
              time: idx === 0 ? '09:00' : idx === 1 ? '11:15' : '14:00',
              slotLabel: idx === 0 ? 'Next' : idx === 1 ? 'Later' : 'Afternoon',
              startsIn: idx === 0 ? 'In progress' : 'Upcoming',
              held: item.held_count != null ? item.held_count : 0,
              avg: item.average_attendance_pct != null ? Math.round(item.average_attendance_pct) : null,
              isDelegated: Boolean(item.is_delegated),
              regularFaculty: item.delegation_details?.regular_faculty_name || '',
            }));
            setClasses(mapped);
          }
        }
      } catch (e) {
        console.warn('Failed to load faculty assignments:', e);
      } finally {
        setLoading(false);
      }
    }
  }, []);

  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadFacultyData();
    setRefreshing(false);
  }, [loadFacultyData]);

  useEffect(() => {
    loadFacultyData();
  }, [loadFacultyData]);

  const nextClass = classes[0];

  const handleOpenClass = (item: any) => {
    router.push({
      pathname: '/(faculty)/section/[id]',
      params: {
        id: item.id,
        subject: item.subject,
        code: item.id,
        section: item.section,
        room: item.room,
        held: String(item.held),
        avg: String(item.avg),
        isDelegated: item.isDelegated ? 'true' : 'false',
        regularFaculty: item.regularFaculty || '',
      },
    });
  };

  const handleStartAttendance = (item: any) => {
    router.push({
      pathname: '/(faculty)/session/select-context' as any,
      params: {
        preselectId: item.id,
      },
    });
  };

  return (
    <Screen
      left={<KlasioLogo variant="lockup" size={24} />}
      subtitle="Good morning"
      title={user?.fullName || 'Faculty'}
      right={
        <View style={styles.headerRightActions}>
          <Pressable
            onPress={handleRefresh}
            style={styles.iconButton}
            accessibilityLabel="Refresh assignments"
            hitSlop={8}
          >
            {refreshing ? (
              <ActivityIndicator size="small" color={Colors.forest} />
            ) : (
              <RefreshCw size={18} color={Colors.ink} />
            )}
          </Pressable>
          <Pressable
            onPress={() => router.push('/(faculty)/reports' as any)}
            style={styles.iconButton}
            accessibilityLabel="Attendance Reports"
          >
            <BarChart3 size={19} color={Colors.ink} />
          </Pressable>
          <Pressable
            onPress={() => router.push('/(faculty)/delegations' as any)}
            style={styles.iconButton}
            accessibilityLabel="Substitute Delegations"
          >
            <UserCheck size={19} color={Colors.ink} />
          </Pressable>
          <Pressable
            onPress={() => router.push('/(faculty)/assignments' as any)}
            style={styles.iconButton}
            accessibilityLabel="All Classes"
          >
            <BookOpen size={19} color={Colors.ink} />
          </Pressable>
          <View style={styles.bellButtonWrapper}>
            <Pressable
              style={styles.iconButton}
              onPress={() => router.push('/notifications' as any)}
              accessibilityLabel="Notifications"
            >
              <Bell size={19} color={Colors.ink} />
              {unreadCount > 0 && <View style={styles.unreadDot} />}
            </Pressable>
          </View>
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
      {/* Next Class Hero Card */}
      {nextClass ? (
        <View style={styles.heroCard}>
          <View style={styles.heroFloatCircle} />

          <Chip tone="apricot" icon={<Clock size={12} color="#b86a2a" />}>
            Starts in {nextClass.startsIn}
          </Chip>

          <Text style={styles.heroClassTitle}>{nextClass.subject}</Text>

          <View style={styles.heroMetaRow}>
            <Text style={styles.heroMetaText}>{nextClass.section}</Text>
            <View style={styles.heroLocationRow}>
              <MapPin size={13} color="rgba(255,255,255,0.8)" />
              <Text style={styles.heroMetaText}>{nextClass.room}</Text>
            </View>
            <Text style={styles.heroMetaText}>{nextClass.time}</Text>
          </View>

          <Pressable
            style={({ pressed }) => [
              styles.takeAttendanceButton,
              pressed && styles.takeAttendanceButtonPressed,
            ]}
            onPress={() => handleStartAttendance(nextClass)}
          >
            <ScanFace size={19} color={Colors.forest} />
            <Text style={styles.takeAttendanceText}>Start attendance</Text>
          </Pressable>
        </View>
      ) : (
        <Card style={styles.classCard}>
          <View style={{ paddingVertical: 12, alignItems: 'center', width: '100%' }}>
            <Text style={styles.subjectText}>No classes scheduled for today</Text>
            <Text style={styles.sectionText}>All authorized assignments are up to date.</Text>
          </View>
        </Card>
      )}

      {/* Offline / Sync Banner */}
      {(!online || waitingRecords > 0) && (
        <View style={styles.syncBanner}>
          {online ? (
            <CloudUpload size={20} color={Colors.amber} />
          ) : (
            <CloudOff size={20} color={Colors.amber} />
          )}
          <Text style={styles.syncBannerText}>
            {online
              ? `${waitingRecords} attendance ${waitingRecords > 1 ? 'records' : 'record'} waiting to upload`
              : "You're viewing saved data"}
          </Text>
          <ChevronRight size={18} color={Colors.soft} />
        </View>
      )}

      {/* Today's Classes List */}
      <SectionTitle
        action={
          <Pressable onPress={() => router.push('/(faculty)/assignments' as any)}>
            <Text style={styles.seeAllText}>All classes</Text>
          </Pressable>
        }
      >
        Your classes, at a glance
      </SectionTitle>
      <Text style={styles.sectionSubtitle}>
        Keep up with your classes and today's attendance.
      </Text>

      <View style={styles.classesList}>
        {classes.map((item) => (
          <Card
            key={item.id}
            onPress={() => handleOpenClass(item)}
            style={styles.classCard}
          >
            <View style={styles.timeColumn}>
              <Text style={styles.timeText}>{item.time}</Text>
              <Text style={styles.slotText}>{item.slotLabel}</Text>
            </View>

            <View style={styles.divider} />

            <View style={styles.classDetails}>
              <Text style={styles.subjectText}>{item.subject}</Text>
              <Text style={styles.sectionText}>
                {item.section} · {item.room}
              </Text>
            </View>

            <ChevronRight size={18} color={Colors.soft} />
          </Card>
        ))}
      </View>

      {(SessionStore.canManagePeople() ||
        SessionStore.canManageAcademics() ||
        SessionStore.canManageDelegations() ||
        SessionStore.canViewReports()) && (
        <View style={{ marginTop: 24, marginBottom: 16 }}>
          <SectionTitle title="Department & Administration" />
          <View style={styles.adminGrid}>
            {SessionStore.canManagePeople() && (
              <Pressable
                onPress={() => router.push('/(faculty)/people' as any)}
                style={({ pressed }) => [styles.adminCard, pressed && { opacity: 0.8 }]}
                accessibilityRole="button"
                accessibilityLabel="People: Faculty & Students"
                accessibilityHint="Navigates to departmental and student roster management"
              >
                <Users size={22} color={Colors.forest} />
                <Text style={styles.adminCardTitle}>People</Text>
                <Text style={styles.adminCardSub}>Faculty & Students</Text>
              </Pressable>
            )}

            {SessionStore.canManageAcademics() && (
              <Pressable
                onPress={() => router.push('/(faculty)/academics' as any)}
                style={({ pressed }) => [styles.adminCard, pressed && { opacity: 0.8 }]}
                accessibilityRole="button"
                accessibilityLabel="Academics: Sections & Courses"
                accessibilityHint="Navigates to curriculum and section catalog"
              >
                <GraduationCap size={22} color={Colors.forest} />
                <Text style={styles.adminCardTitle}>Academics</Text>
                <Text style={styles.adminCardSub}>Sections & Courses</Text>
              </Pressable>
            )}

            {SessionStore.canManageDelegations() && (
              <Pressable
                onPress={() => router.push('/(faculty)/delegations' as any)}
                style={({ pressed }) => [styles.adminCard, pressed && { opacity: 0.8 }]}
                accessibilityRole="button"
                accessibilityLabel="Delegations: Substitutes"
                accessibilityHint="Navigates to substitute faculty delegation requests"
              >
                <UserCheck size={22} color={Colors.forest} />
                <Text style={styles.adminCardTitle}>Delegations</Text>
                <Text style={styles.adminCardSub}>Substitutes</Text>
              </Pressable>
            )}

            {SessionStore.canViewReports() && (
              <Pressable
                onPress={() => router.push('/(faculty)/reports' as any)}
                style={({ pressed }) => [styles.adminCard, pressed && { opacity: 0.8 }]}
                accessibilityRole="button"
                accessibilityLabel="Reports: Attendance Trends"
                accessibilityHint="Navigates to attendance trend analytics"
              >
                <BarChart3 size={22} color={Colors.forest} />
                <Text style={styles.adminCardTitle}>Reports</Text>
                <Text style={styles.adminCardSub}>Attendance Trends</Text>
              </Pressable>
            )}
          </View>
        </View>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  headerRightActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  iconButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: Colors.card,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.line,
  },
  bellButtonWrapper: {
    position: 'relative',
  },
  unreadDot: {
    position: 'absolute',
    top: 7,
    right: 9,
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Colors.apricot,
  },
  heroCard: {
    backgroundColor: Colors.forest,
    borderRadius: 28,
    padding: 20,
    overflow: 'hidden',
    position: 'relative',
    marginBottom: 14,
  },
  heroFloatCircle: {
    position: 'absolute',
    top: -24,
    right: -24,
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: 'rgba(240, 168, 104, 0.35)',
  },
  heroClassTitle: {
    fontSize: 26,
    lineHeight: 32,
    fontWeight: '700',
    color: '#ffffff',
    marginTop: 12,
  },
  heroMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 4,
  },
  heroLocationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  heroMetaText: {
    fontSize: 14,
    color: 'rgba(255,255,255,0.75)',
  },
  takeAttendanceButton: {
    marginTop: 20,
    backgroundColor: '#ffffff',
    borderRadius: 16,
    paddingVertical: 14,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8,
  },
  takeAttendanceButtonPressed: {
    opacity: 0.92,
    transform: [{ scale: 0.985 }],
  },
  takeAttendanceText: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.forest,
  },
  syncBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: Colors.amber50,
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 12,
  },
  syncBannerText: {
    flex: 1,
    fontSize: 13,
    color: Colors.ink,
    fontWeight: '500',
  },
  classesList: {
    gap: 10,
    marginTop: 4,
  },
  classCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
  },
  timeColumn: {
    width: 52,
    alignItems: 'center',
  },
  timeText: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.ink,
  },
  slotText: {
    fontSize: 11,
    color: Colors.soft,
    marginTop: 1,
  },
  divider: {
    width: 1,
    alignSelf: 'stretch',
    backgroundColor: Colors.line,
  },
  classDetails: {
    flex: 1,
  },
  subjectText: {
    fontSize: 15,
    fontWeight: '600',
    color: Colors.ink,
  },
  sectionText: {
    fontSize: 12,
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
  adminGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginTop: 8,
  },
  adminCard: {
    flex: 1,
    minWidth: '45%',
    backgroundColor: Colors.card,
    borderRadius: Radii.card,
    padding: 14,
    borderWidth: 1,
    borderColor: Colors.line,
    alignItems: 'flex-start',
  },
  adminCardTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.ink,
    marginTop: 8,
  },
  adminCardSub: {
    fontSize: 11,
    color: Colors.soft,
    marginTop: 2,
  },
});
