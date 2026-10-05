import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Calendar, Check, Clock, AlertTriangle, ShieldCheck } from 'lucide-react-native';

import { Screen, Card, Bar, Chip, SectionTitle } from '@/components/ui/kit';
import { Colors } from '@/theme/tokens';

export interface SubjectAttendanceUI {
  code: string;
  name: string;
  pct: number;
  held: number;
  attended: number;
  effectiveStartDate: string;
}

const DEMO_SUBJECTS: SubjectAttendanceUI[] = [
  {
    code: 'CS301',
    name: 'Data Structures',
    pct: 86,
    held: 42,
    attended: 36,
    effectiveStartDate: '2026-09-01',
  },
  {
    code: 'CS303',
    name: 'Operating Systems',
    pct: 71,
    held: 38,
    attended: 27,
    effectiveStartDate: '2026-09-01',
  },
  {
    code: 'CS305',
    name: 'Computer Networks',
    pct: 79,
    held: 35,
    attended: 28,
    effectiveStartDate: '2026-09-20', // Late admission subject enrollment
  },
  {
    code: 'MA301',
    name: 'Discrete Mathematics',
    pct: 92,
    held: 40,
    attended: 37,
    effectiveStartDate: '2026-09-01',
  },
];

export default function StudentAttendanceScreen() {
  const [subjects, setSubjects] = useState<SubjectAttendanceUI[]>(DEMO_SUBJECTS);
  const [selectedMonth] = useState('October 2026');

  // Recovery formula from design/src/data.ts:
  // Classes needed to reach threshold (75%) if attending every future class
  const toRecover = (pct: number, held: number, t = 75) =>
    pct >= t ? 0 : Math.ceil((t * held - pct * held) / (100 - t));

  // Classes that can be missed while staying above threshold
  const canMiss = (pct: number, held: number, t = 75) =>
    Math.max(0, Math.floor((pct * held) / t - held));

  // Calendar days setup
  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  const mark = (d: number) =>
    d > 4 ? null : d === 2 ? 'absent' : d === 3 ? 'late' : 'present';

  return (
    <Screen title="Attendance" subtitle="By subject and by day">
      {/* Subject Summaries */}
      <View style={styles.subjectsContainer}>
        {subjects.map((s) => {
          const miss = canMiss(s.pct, s.held);
          const recover = toRecover(s.pct, s.held);
          const isBelow = s.pct < 75;
          const isLateAdmission = s.effectiveStartDate > '2026-09-05';

          return (
            <Card key={s.code} style={styles.subjectCard}>
              <View style={styles.subjectHeaderRow}>
                <View style={styles.subjectTitleContainer}>
                  <Text style={styles.subjectName}>{s.name}</Text>
                  <Text style={styles.subjectCode}>{s.code}</Text>
                </View>
                <Text style={[styles.pctNumber, isBelow && styles.pctBelow]}>
                  {s.pct}%
                </Text>
              </View>

              <View style={styles.barWrapper}>
                <Bar pct={s.pct} threshold={75} />
              </View>

              <View style={styles.metaRow}>
                <Text style={styles.adviceText}>
                  {isBelow
                    ? `Attend ${recover} more in a row to reach 75%`
                    : miss > 0
                    ? `You can miss ${miss} and stay above 75%`
                    : 'Right at the line — keep going'}
                </Text>
                {isLateAdmission && (
                  <Chip tone="lilac">Enrolled Sept 20 · 0 unearned absences</Chip>
                )}
              </View>
            </Card>
          );
        })}
      </View>

      {/* Monthly Attendance Calendar */}
      <SectionTitle>{selectedMonth}</SectionTitle>

      <Card style={styles.calendarCard}>
        <View style={styles.calendarDayHeaderRow}>
          {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, idx) => (
            <Text key={idx} style={styles.calendarDayHeader}>
              {day}
            </Text>
          ))}
        </View>

        <View style={styles.calendarGrid}>
          {/* Leading blank offset for Oct 1 (Thu) */}
          {[0, 1, 2].map((_, idx) => (
            <View key={`blank-${idx}`} style={styles.calendarCell} />
          ))}

          {days.map((d) => {
            const m = mark(d);
            const isToday = d === 4;
            const cellStyle =
              m === 'present'
                ? styles.cellPresent
                : m === 'absent'
                ? styles.cellAbsent
                : m === 'late'
                ? styles.cellLate
                : null;
            const textStyle =
              m === 'present'
                ? styles.cellTextPresent
                : m === 'absent'
                ? styles.cellTextAbsent
                : m === 'late'
                ? styles.cellTextLate
                : styles.cellTextDefault;

            return (
              <View
                key={d}
                style={[
                  styles.calendarCell,
                  cellStyle,
                  isToday && styles.cellToday,
                ]}
              >
                <Text style={[styles.calendarCellText, textStyle]}>{d}</Text>
              </View>
            );
          })}
        </View>

        {/* Legend */}
        <View style={styles.legendRow}>
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
            <Text style={styles.legendLabel}>Late</Text>
          </View>
        </View>
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  subjectsContainer: {
    gap: 12,
    marginTop: 4,
  },
  subjectCard: {
    marginBottom: 2,
  },
  subjectHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8,
  },
  subjectTitleContainer: {
    flex: 1,
  },
  subjectName: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.ink,
  },
  subjectCode: {
    fontSize: 12,
    color: Colors.soft,
    marginTop: 1,
  },
  pctNumber: {
    fontSize: 20,
    fontWeight: '700',
    color: Colors.ink,
  },
  pctBelow: {
    color: Colors.rose,
  },
  barWrapper: {
    marginVertical: 4,
  },
  metaRow: {
    marginTop: 8,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  adviceText: {
    fontSize: 12,
    color: Colors.soft,
    flex: 1,
  },
  calendarCard: {
    marginTop: 4,
  },
  calendarDayHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  calendarDayHeader: {
    width: 36,
    textAlign: 'center',
    fontSize: 12,
    color: Colors.soft,
    fontWeight: '600',
  },
  calendarGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  calendarCell: {
    width: 36,
    height: 36,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginVertical: 3,
  },
  calendarCellText: {
    fontSize: 13,
  },
  cellTextDefault: {
    color: Colors.soft,
  },
  cellPresent: {
    backgroundColor: Colors.forest50,
  },
  cellTextPresent: {
    color: Colors.forest,
    fontWeight: '700',
  },
  cellAbsent: {
    backgroundColor: Colors.rose50,
  },
  cellTextAbsent: {
    color: Colors.rose,
    fontWeight: '700',
  },
  cellLate: {
    backgroundColor: Colors.amber50,
  },
  cellTextLate: {
    color: Colors.amber,
    fontWeight: '700',
  },
  cellToday: {
    borderWidth: 2,
    borderColor: Colors.forest,
  },
  legendRow: {
    flexDirection: 'row',
    gap: 16,
    marginTop: 16,
    paddingHorizontal: 4,
  },
  legendItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  legendDot: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
  },
  legendLabel: {
    fontSize: 12,
    color: Colors.soft,
  },
});
