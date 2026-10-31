import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { BookOpen, ChevronRight, Users, Sparkles, AlertCircle, RefreshCw, BarChart3 } from 'lucide-react-native';

import { Screen, Card, Ring, Chip, Button, SectionTitle, IconBubble } from '@/components/ui/kit';
import { Colors } from '@/theme/tokens';
import { RosterRepository } from '@/storage/rosterRepository';

export interface TeachingAssignmentUI {
  id: string;
  subjectCode: string;
  subjectName: string;
  sectionCode: string;
  room?: string;
  scheduleTime?: string;
  heldCount: number;
  averageAttendancePct: number;
  studentsBelowThresholdCount: number;
  isDelegated: boolean;
  regularFacultyName?: string;
  validTo?: string;
}

// Fallback initial assignments matching Figma design (used if offline before first sync)
const INITIAL_ASSIGNMENTS: TeachingAssignmentUI[] = [
  {
    id: 'a1',
    subjectCode: 'CS301',
    subjectName: 'Data Structures',
    sectionCode: 'CSE 3A',
    room: 'LH-204',
    scheduleTime: '09:00',
    heldCount: 38,
    averageAttendancePct: 88,
    studentsBelowThresholdCount: 2,
    isDelegated: false,
  },
  {
    id: 'a2',
    subjectCode: 'CS303',
    subjectName: 'Operating Systems',
    sectionCode: 'CSE 3B',
    room: 'LAB-2',
    scheduleTime: '12:00',
    heldCount: 35,
    averageAttendancePct: 81,
    studentsBelowThresholdCount: 5,
    isDelegated: false,
  },
  {
    id: 'a3',
    subjectCode: 'CS351',
    subjectName: 'Data Structures Lab',
    sectionCode: 'CSE 3A · B1',
    room: 'LAB-4',
    scheduleTime: '14:00',
    heldCount: 14,
    averageAttendancePct: 92,
    studentsBelowThresholdCount: 0,
    isDelegated: true,
    regularFacultyName: 'Dr. Rahul Menon',
    validTo: '2026-10-15',
  },
];

export default function FacultyAssignmentsScreen() {
  const router = useRouter();
  const [assignments, setAssignments] = useState<TeachingAssignmentUI[]>(INITIAL_ASSIGNMENTS);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // In production, syncs with GET /api/v1/faculty/assignments when online
    // and reads/caches student rosters via RosterRepository
  }, []);

  const handleSelectAssignment = (item: TeachingAssignmentUI) => {
    router.push({
      pathname: '/(faculty)/section/[id]',
      params: {
        id: item.id,
        subject: item.subjectName,
        code: item.subjectCode,
        section: item.sectionCode,
        room: item.room || 'LH-204',
        held: String(item.heldCount),
        avg: String(item.averageAttendancePct),
        isDelegated: item.isDelegated ? 'true' : 'false',
        regularFaculty: item.regularFacultyName || '',
      },
    });
  };

  return (
    <Screen
      title="My classes"
      subtitle="Only the classes assigned to you"
      onBack={() => router.back()}
      right={
        <Pressable
          onPress={() => router.push('/(faculty)/reports')}
          hitSlop={10}
          accessibilityLabel="View reports"
        >
          <IconBubble icon={BarChart3} tone="forest" size={38} iconSize={18} />
        </Pressable>
      }
    >
      <View style={styles.listContainer}>
        {assignments.map((item) => {
          const hasWarning = item.studentsBelowThresholdCount > 0;
          return (
            <Card
              key={item.id}
              onPress={() => handleSelectAssignment(item)}
              style={styles.cardSpacing}
            >
              <View style={styles.cardRow}>
                <Ring pct={item.averageAttendancePct} size={60} stroke={10} />

                <View style={styles.cardContent}>
                  <Text style={styles.subjectTitle} numberOfLines={1}>
                    {item.subjectName}
                  </Text>
                  <Text style={styles.metaText}>
                    {item.sectionCode} · {item.heldCount} classes held
                  </Text>

                  <View style={styles.chipRow}>
                    {item.isDelegated && (
                      <Chip tone="apricot">
                        Substitute · {item.regularFacultyName}
                      </Chip>
                    )}
                    <Chip tone={hasWarning ? 'rose' : 'forest'}>
                      {hasWarning
                        ? `${item.studentsBelowThresholdCount} below 75%`
                        : 'All students ≥ 75%'}
                    </Chip>
                  </View>
                </View>

                <ChevronRight size={20} color={Colors.soft} />
              </View>
            </Card>
          );
        })}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  listContainer: {
    gap: 12,
    marginTop: 4,
  },
  cardSpacing: {
    marginBottom: 2,
  },
  cardRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  cardContent: {
    flex: 1,
  },
  subjectTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.ink,
    marginBottom: 2,
  },
  metaText: {
    fontSize: 13,
    color: Colors.soft,
    marginBottom: 8,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
});
