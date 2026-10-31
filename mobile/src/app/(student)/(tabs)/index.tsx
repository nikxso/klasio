import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  Bell,
  Clock,
  ScanFace,
  Sparkles,
  ChevronRight,
  GraduationCap,
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
import { KlasioLogo } from '@/components/ui/KlasioLogo';
import {
  StudentRepository,
  StudentPersonalAttendanceResponse,
  StudentSubjectSummary,
} from '@/storage/studentRepository';

const DEFAULT_SUMMARY: StudentPersonalAttendanceResponse = {
  student_id: 'stu-aarav-21cs037',
  overall_attendance_percentage: 82.0,
  subjects: [
    {
      subject_id: 'sub-01',
      teaching_assignment_id: 'a1',
      subject_code: 'CS301',
      subject_name: 'Data Structures',
      faculty_name: 'Dr. Lakshmi Iyer',
      total_eligible_sessions: 42,
      attended_sessions: 36,
      attendance_percentage: 86.0,
      effective_start_date: '2026-08-01',
      classes_to_recover: 0,
      classes_can_miss: 6,
      is_shortage: false,
      is_recoverable: true,
      threshold: 75.0,
    },
    {
      subject_id: 'sub-02',
      teaching_assignment_id: 'a2',
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
      teaching_assignment_id: 'a3',
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

export default function StudentHomeScreen() {
  const router = useRouter();
  const [data, setData] = useState<StudentPersonalAttendanceResponse>(DEFAULT_SUMMARY);
  const [faceStatus, setFaceStatus] = useState<'none' | 'pending' | 'approved'>('approved');

  useEffect(() => {
    async function loadData() {
      try {
        const cached = await StudentRepository.getCachedAttendance(DEFAULT_SUMMARY.student_id);
        if (cached && cached.data && cached.data.subjects.length > 0) {
          setData(cached.data);
        }
      } catch {
        // Fallback to initial local cache
      }
    }
    loadData();
  }, []);

  const overall = Math.round(data.overall_attendance_percentage);
  const lowSubject = data.subjects.find((s) => s.is_shortage || s.attendance_percentage < 75);

  return (
    <Screen
      left={<KlasioLogo variant="lockup" size={24} />}
      subtitle="Hi there 👋"
      title="Aarav Sharma"
      right={
        <View style={styles.notificationWrapper}>
          <Bell size={20} color={Colors.ink} />
          <View style={styles.unreadDot} />
        </View>
      }
      scrollable
    >
      <Card style={styles.heroCard}>
        <Ring pct={overall} size={110} />
        <View style={styles.heroTextCol}>
          <Text style={styles.overallLabel}>Overall attendance</Text>
          <Text style={styles.overallHeadline}>
            {overall >= 75 ? "You're doing great" : 'Needs a little care'}
          </Text>
          <Chip tone="forest" style={styles.sparkleChip}>
            <Sparkles size={12} color={Colors.forest} /> Up 2% this month
          </Chip>
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
        {data.subjects.slice(0, 3).map((s) => (
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
        ))}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
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
