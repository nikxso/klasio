import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Check, X } from 'lucide-react-native';

import { Avatar, Chip } from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';

export interface RosterStudentItemProps {
  studentUserId: string;
  institutionalId: string;
  studentName: string;
  faceRegistrationState: 'REGISTERED' | 'PENDING' | 'UNREGISTERED';
  attendanceStatus?: 'PRESENT' | 'ABSENT' | 'EXCUSED' | null;
  attendancePercentage?: number;
}

interface AttendanceRosterListProps {
  students: RosterStudentItemProps[];
  marks: Record<string, 'PRESENT' | 'ABSENT' | 'EXCUSED' | boolean>;
  onToggleStatus: (studentUserId: string, newStatus: 'PRESENT' | 'ABSENT' | 'EXCUSED') => void;
  onSelectStudent?: (student: RosterStudentItemProps) => void;
  readOnly?: boolean;
  version?: number | string | null;
}

export function AttendanceRosterList({
  students,
  marks,
  onToggleStatus,
  onSelectStudent,
  readOnly = false,
  version,
}: AttendanceRosterListProps) {
  if (!students || students.length === 0) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>No eligible students found for this session.</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {students.map((student, index) => {
        const isLast = index === students.length - 1;
        const markVal = marks[student.studentUserId];
        const isPresent = markVal === 'PRESENT' || markVal === true;
        const isAbsent = markVal === 'ABSENT' || markVal === false;

        // Badge styling based on biometric registration state
        const badgeConfig = getBiometricBadge(student.faceRegistrationState);

        return (
          <View
            key={student.studentUserId}
            style={[styles.row, !isLast && styles.rowDivider]}
          >
            <Pressable
              style={styles.studentInfoWrapper}
              onPress={() => onSelectStudent?.(student)}
              accessibilityRole="button"
              accessibilityLabel={`View ${student.studentName}'s profile`}
            >
              <Avatar name={student.studentName} userId={student.studentUserId} version={version} size={40} />

              <View style={styles.studentInfo}>
                <View style={styles.nameRow}>
                  <Text style={styles.nameText} numberOfLines={1}>
                    {student.studentName}
                  </Text>
                  <Chip tone={badgeConfig.tone}>{badgeConfig.label}</Chip>
                </View>

                <View style={styles.subRow}>
                  <Text style={styles.idText}>{student.institutionalId}</Text>
                  {student.attendancePercentage !== undefined && (
                    <Text
                      style={[
                        styles.pctText,
                        student.attendancePercentage < 75 && styles.pctBelowText,
                      ]}
                    >
                      · {student.attendancePercentage}% avg
                    </Text>
                  )}
                </View>
              </View>
            </Pressable>

            {!readOnly && (
              <View style={styles.actionsRow}>
                {/* Absent Button */}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Mark ${student.studentName} absent`}
                  onPress={() => onToggleStatus(student.studentUserId, 'ABSENT')}
                  style={({ pressed }) => [
                    styles.actionButton,
                    isAbsent ? styles.btnAbsentActive : styles.btnAbsentInactive,
                    pressed && styles.btnPressed,
                  ]}
                >
                  <X
                    size={18}
                    color={isAbsent ? '#ffffff' : Colors.rose}
                    strokeWidth={2.5}
                  />
                </Pressable>

                {/* Present Button */}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Mark ${student.studentName} present`}
                  onPress={() => onToggleStatus(student.studentUserId, 'PRESENT')}
                  style={({ pressed }) => [
                    styles.actionButton,
                    isPresent ? styles.btnPresentActive : styles.btnPresentInactive,
                    pressed && styles.btnPressed,
                  ]}
                >
                  <Check
                    size={18}
                    color={isPresent ? '#ffffff' : Colors.forest}
                    strokeWidth={2.5}
                  />
                </Pressable>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

function getBiometricBadge(state: 'REGISTERED' | 'PENDING' | 'UNREGISTERED') {
  switch (state) {
    case 'REGISTERED':
      return { tone: 'forest' as const, label: 'Face ID' };
    case 'PENDING':
      return { tone: 'amber' as const, label: 'Pending' };
    case 'UNREGISTERED':
    default:
      return { tone: 'soft' as const, label: 'No Face ID' };
  }
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: Colors.card,
    borderRadius: Radii.card,
    borderWidth: 1,
    borderColor: '#efe7da88',
    overflow: 'hidden',
  },
  emptyContainer: {
    padding: 24,
    backgroundColor: Colors.card,
    borderRadius: Radii.card,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
    color: Colors.soft,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 12,
  },
  studentInfoWrapper: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  rowDivider: {
    borderBottomWidth: 1,
    borderBottomColor: Colors.line,
  },
  studentInfo: {
    flex: 1,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 3,
    gap: 8,
  },
  nameText: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.ink,
    flex: 1,
  },
  subRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  idText: {
    fontSize: 12,
    color: Colors.soft,
  },
  pctText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.ink,
  },
  pctBelowText: {
    color: Colors.rose,
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  actionButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  btnPressed: {
    transform: [{ scale: 0.95 }],
  },
  btnAbsentInactive: {
    backgroundColor: Colors.rose50,
  },
  btnAbsentActive: {
    backgroundColor: Colors.rose,
  },
  btnPresentInactive: {
    backgroundColor: Colors.forest50,
  },
  btnPresentActive: {
    backgroundColor: Colors.forest,
  },
});
