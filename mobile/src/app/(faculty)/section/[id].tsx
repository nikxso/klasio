import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TouchableOpacity } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ScanFace, Users, ChevronLeft, AlertCircle } from 'lucide-react-native';

import { Screen, Card, Button, Ring, Bar, Avatar, SectionTitle, Chip, Sheet } from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';
import { AttendanceRosterList } from '@/components/AttendanceRosterList';
import { CachedStudent, RosterRepository } from '@/storage/rosterRepository';
import { AttendanceRepository } from '@/storage/attendanceRepository';

// Initial roster matching Figma mockup if offline
const DEMO_STUDENTS: Array<CachedStudent & { pct: number }> = [
  {
    teachingAssignmentId: 'a1',
    studentUserId: 'stu-1',
    institutionalId: '21CS031',
    studentName: 'Aarav Sharma',
    effectiveStartDate: '2026-09-01',
    faceRegistrationState: 'REGISTERED',
    pct: 96,
  },
  {
    teachingAssignmentId: 'a1',
    studentUserId: 'stu-2',
    institutionalId: '21CS032',
    studentName: 'Priya Nair',
    effectiveStartDate: '2026-09-01',
    faceRegistrationState: 'REGISTERED',
    pct: 91,
  },
  {
    teachingAssignmentId: 'a1',
    studentUserId: 'stu-3',
    institutionalId: '21CS033',
    studentName: 'Rohan Mehta',
    effectiveStartDate: '2026-09-01',
    faceRegistrationState: 'REGISTERED',
    pct: 72,
  },
  {
    teachingAssignmentId: 'a1',
    studentUserId: 'stu-4',
    institutionalId: '21CS034',
    studentName: 'Ananya Iyer',
    effectiveStartDate: '2026-09-01',
    faceRegistrationState: 'REGISTERED',
    pct: 98,
  },
  {
    teachingAssignmentId: 'a1',
    studentUserId: 'stu-5',
    institutionalId: '21CS035',
    studentName: 'Diya Patel',
    effectiveStartDate: '2026-09-01',
    faceRegistrationState: 'PENDING',
    pct: 94,
  },
  {
    teachingAssignmentId: 'a1',
    studentUserId: 'stu-6',
    institutionalId: '21CS036',
    studentName: 'Karan Malhotra',
    effectiveStartDate: '2026-09-01',
    faceRegistrationState: 'UNREGISTERED',
    pct: 58,
  },
];

export default function ClassDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{
    id: string;
    subject: string;
    code: string;
    section: string;
    room: string;
    held: string;
    avg: string;
    isDelegated: string;
    regularFaculty: string;
    initialMode?: string;
  }>();

  const [students, setStudents] = useState(DEMO_STUDENTS);
  const [markingMode, setMarkingMode] = useState(params.initialMode === 'review');
  const [reviewTab, setReviewTab] = useState<'check' | 'found'>('check');
  const [marks, setMarks] = useState<Record<string, 'PRESENT' | 'ABSENT'>>({});
  const [confirmSheetVisible, setConfirmSheetVisible] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);

  useEffect(() => {
    // Attempt reading from local SQLite cached_rosters
    if (params.id) {
      RosterRepository.getCachedRoster(params.id).then((cached) => {
        if (cached && cached.length > 0) {
          setStudents(
            cached.map((c, i) => ({
              ...c,
              pct: DEMO_STUDENTS[i % DEMO_STUDENTS.length]?.pct ?? 85,
            }))
          );
        }
      });
    }
  }, [params.id]);

  const avgPct = Number(params.avg || '88');
  const heldCount = Number(params.held || '38');
  const isDelegated = params.isDelegated === 'true';

  // In Figma: students recognised by perception camera vs students requiring manual check
  const recognisedStudents = students.filter(
    (s) => s.faceRegistrationState === 'REGISTERED' && s.pct > 75
  );
  const recognisedIds = new Set(recognisedStudents.map((s) => s.studentUserId));
  const toCheckStudents = students.filter((s) => !recognisedIds.has(s.studentUserId));

  // Initialize recognised students as PRESENT on entering marking mode
  useEffect(() => {
    if (markingMode && Object.keys(marks).length === 0) {
      const initialMarks: Record<string, 'PRESENT' | 'ABSENT'> = {};
      recognisedStudents.forEach((s) => {
        initialMarks[s.studentUserId] = 'PRESENT';
      });
      setMarks(initialMarks);
    }
  }, [markingMode]);

  const presentCount = Object.values(marks).filter((m) => m === 'PRESENT').length;
  const absentCount = Object.values(marks).filter((m) => m === 'ABSENT').length;
  const undecidedCount = students.length - (presentCount + absentCount);
  const undecidedInCheck = toCheckStudents.filter((s) => !marks[s.studentUserId]).length;

  const currentDisplayList = reviewTab === 'check' ? toCheckStudents : recognisedStudents;

  if (markingMode) {
    return (
      <Screen
        onBack={() => setMarkingMode(false)}
        subtitle={params.subject || 'Data Structures'}
        title="Check attendance"
      >
        {/* Figma Segmented Tab: Please check vs Recognised */}
        <View style={styles.segmentContainer}>
          <Pressable
            onPress={() => setReviewTab('check')}
            style={[
              styles.segmentButton,
              reviewTab === 'check' && styles.segmentButtonActive,
            ]}
          >
            <Text
              style={[
                styles.segmentText,
                reviewTab === 'check' && styles.segmentTextActive,
              ]}
            >
              Please check · {toCheckStudents.length}
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setReviewTab('found')}
            style={[
              styles.segmentButton,
              reviewTab === 'found' && styles.segmentButtonActive,
            ]}
          >
            <Text
              style={[
                styles.segmentText,
                reviewTab === 'found' && styles.segmentTextActive,
              ]}
            >
              Recognised · {recognisedStudents.length}
            </Text>
          </Pressable>
        </View>

        {/* Figma Lilac Alert Banner */}
        {reviewTab === 'check' && (
          <View style={styles.alertBanner}>
            <AlertCircle size={18} color={Colors.lilac} style={{ marginTop: 2, marginRight: 8 }} />
            <Text style={styles.alertBannerText}>
              The camera didn't spot these students. That doesn't mean they're absent — please mark each one.
            </Text>
          </View>
        )}

        <AttendanceRosterList
          students={currentDisplayList.map((s) => ({
            studentUserId: s.studentUserId,
            institutionalId: s.institutionalId,
            studentName: s.studentName,
            faceRegistrationState: s.faceRegistrationState,
            attendancePercentage: s.pct,
          }))}
          marks={marks}
          onToggleStatus={(studentUserId, newStatus) => {
            setMarks((prev) => ({
              ...prev,
              [studentUserId]: newStatus,
            }));
          }}
        />

        {reviewTab === 'check' && undecidedInCheck > 0 && (
          <Pressable
            style={styles.markRestButton}
            onPress={() => {
              const updated = { ...marks };
              for (const s of toCheckStudents) {
                if (!updated[s.studentUserId]) {
                  updated[s.studentUserId] = 'ABSENT';
                }
              }
              setMarks(updated);
            }}
          >
            <Text style={styles.markRestText}>Mark the rest as absent</Text>
          </Pressable>
        )}

        <Button
          variant="primary"
          style={styles.saveAttendanceButton}
          disabled={undecidedCount > 0}
          onPress={() => setConfirmSheetVisible(true)}
        >
          {undecidedCount > 0 ? `${undecidedCount} left to mark` : 'Save attendance'}
        </Button>

        <Sheet
          visible={confirmSheetVisible}
          onClose={() => setConfirmSheetVisible(false)}
        >
          <Text style={styles.sheetTitle}>Save attendance?</Text>
          <View style={styles.sheetSummaryGrid}>
            <View style={styles.sheetPresentBox}>
              <Text style={styles.sheetCountPresent}>{presentCount}</Text>
              <Text style={styles.sheetLabel}>Present</Text>
            </View>
            <View style={styles.sheetAbsentBox}>
              <Text style={styles.sheetCountAbsent}>{absentCount}</Text>
              <Text style={styles.sheetLabel}>Absent</Text>
            </View>
          </View>
          <Text style={styles.sheetNotice}>
            You can still correct mistakes later within the institution's correction window. Changes are recorded under your name.
          </Text>
          <Button
            variant="primary"
            style={{ marginTop: 18 }}
            onPress={async () => {
              try {
                const nowIso = new Date().toISOString();
                const today = nowIso.slice(0, 10);
                const clientUuid = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                const records = students.map((s) => ({
                  studentUserId: s.studentUserId,
                  attendanceStatus: (marks[s.studentUserId] || 'ABSENT') as 'PRESENT' | 'ABSENT',
                  markSource: (recognisedIds.has(s.studentUserId) && marks[s.studentUserId] === 'PRESENT'
                    ? 'AI_VERIFIED'
                    : 'MANUAL_MARK') as 'AI_VERIFIED' | 'MANUAL_MARK',
                  candidateConfidence: recognisedIds.has(s.studentUserId) ? 0.90 : null,
                  recordedAt: nowIso,
                }));

                await AttendanceRepository.finalizeSession({
                  clientSessionUuid: clientUuid,
                  teachingAssignmentId: params.id || 'assign-1',
                  sessionDate: today,
                  periodSlotOrSequence: 1,
                  applicabilityStatus: 'COUNTED',
                  regularFacultyUserId: 'fac-1',
                  conductingFacultyUserId: 'fac-1',
                  substituteDelegationId: isDelegated ? 'del-1' : null,
                  finalizedAt: nowIso,
                  records,
                });
              } catch (e) {
                console.warn('Local finalization note:', e);
              }
              setConfirmSheetVisible(false);
              setMarkingMode(false);
              setSavedSuccess(true);
            }}
          >
            Yes, save it
          </Button>
        </Sheet>
      </Screen>
    );
  }

  return (
    <Screen
      onBack={() => router.back()}
      subtitle={`${params.section || 'CSE 3A'} · ${params.room || 'LH-204'}`}
      title={params.subject || 'Data Structures'}
    >
      {isDelegated && (
        <View style={styles.delegatedNotice}>
          <Chip tone="apricot">
            Conducted under temporary delegation from {params.regularFaculty || 'assigned faculty'}
          </Chip>
        </View>
      )}

      {/* Class Metric Hero Card */}
      <Card style={styles.metricCard}>
        <View style={styles.metricRow}>
          <Ring pct={avgPct} size={88} stroke={9} />
          <View style={styles.metricDetails}>
            <Text style={styles.metricLabel}>Class average</Text>
            <Text style={styles.metricHeld}>{heldCount} classes held</Text>
            <View style={styles.studentCountRow}>
              <Users size={14} color={Colors.soft} />
              <Text style={styles.studentCountText}>
                {students.length} students enrolled
              </Text>
            </View>
          </View>
        </View>
      </Card>

      <Button
        variant="primary"
        style={styles.takeAttendanceButton}
        icon={<ScanFace size={20} color="#ffffff" />}
        onPress={() => {
          router.push({
            pathname: '/(faculty)/session/scan',
            params: {
              sectionId: params.id || '1',
              subject: params.subject || 'Data Structures',
              section: params.section || 'CSE 3A',
              room: params.room || 'LH-204',
            },
          });
        }}
      >
        Start scanning
      </Button>

      <TouchableOpacity
        onPress={() => setMarkingMode(true)}
        style={{ marginTop: 10, marginBottom: 8, alignItems: 'center' }}
      >
        <Text style={{ fontSize: 13, color: Colors.soft, textDecorationLine: 'underline' }}>
          Mark attendance manually
        </Text>
      </TouchableOpacity>

      <SectionTitle>Students</SectionTitle>

      <View style={styles.rosterCard}>
        {students.map((student, index) => {
          const isBelow = student.pct < 75;
          const isLast = index === students.length - 1;
          const faceTone =
            student.faceRegistrationState === 'REGISTERED'
              ? 'forest'
              : student.faceRegistrationState === 'PENDING'
              ? 'amber'
              : 'soft';
          const faceLabel =
            student.faceRegistrationState === 'REGISTERED'
              ? 'Face ID'
              : student.faceRegistrationState === 'PENDING'
              ? 'Pending'
              : 'No Face ID';

          return (
            <View
              key={student.studentUserId}
              style={[styles.studentRow, !isLast && styles.rowDivider]}
            >
              <Avatar name={student.studentName} size={40} />

              <View style={styles.studentInfo}>
                <View style={styles.nameHeaderRow}>
                  <Text style={styles.studentName} numberOfLines={1}>
                    {student.studentName}
                  </Text>
                  <Chip tone={faceTone}>{faceLabel}</Chip>
                </View>

                <View style={styles.barContainer}>
                  <Bar pct={student.pct} threshold={75} />
                </View>
              </View>

              <Text style={[styles.pctText, isBelow && styles.pctBelowText]}>
                {student.pct}%
              </Text>
            </View>
          );
        })}
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  delegatedNotice: {
    marginBottom: 12,
  },
  metricCard: {
    marginBottom: 14,
  },
  metricRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 18,
  },
  metricDetails: {
    flex: 1,
  },
  metricLabel: {
    fontSize: 13,
    color: Colors.soft,
    marginBottom: 2,
  },
  metricHeld: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.ink,
    marginBottom: 4,
  },
  studentCountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  studentCountText: {
    fontSize: 12,
    color: Colors.soft,
  },
  takeAttendanceButton: {
    marginBottom: 8,
  },
  rosterCard: {
    backgroundColor: Colors.card,
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#efe7da88',
  },
  studentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 13,
    gap: 12,
  },
  rowDivider: {
    borderBottomWidth: 1,
    borderBottomColor: Colors.line,
  },
  studentInfo: {
    flex: 1,
  },
  nameHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  studentName: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.ink,
    flex: 1,
    marginRight: 8,
  },
  barContainer: {
    paddingRight: 8,
  },
  pctText: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.ink,
    width: 44,
    textAlign: 'right',
  },
  pctBelowText: {
    color: Colors.rose,
  },
  segmentContainer: {
    flexDirection: 'row',
    backgroundColor: Colors.line,
    borderRadius: 16,
    padding: 4,
    marginBottom: 14,
    gap: 4,
  },
  segmentButton: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentButtonActive: {
    backgroundColor: Colors.card,
    shadowColor: '#2a2338',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 2,
    elevation: 1,
  },
  segmentText: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.soft,
  },
  segmentTextActive: {
    color: Colors.ink,
  },
  alertBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: Colors.lilac50,
    borderRadius: Radii.card,
    padding: 14,
    marginBottom: 14,
  },
  alertBannerText: {
    fontSize: 13,
    color: Colors.lilac,
    lineHeight: 18,
    fontWeight: '500',
    flex: 1,
  },
  markRestButton: {
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 8,
  },
  markRestText: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.soft,
  },
  saveAttendanceButton: {
    marginTop: 10,
    marginBottom: 20,
  },
  sheetTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: Colors.ink,
    marginBottom: 16,
  },
  sheetSummaryGrid: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 14,
  },
  sheetPresentBox: {
    flex: 1,
    backgroundColor: Colors.forest50,
    borderRadius: Radii.card,
    padding: 16,
  },
  sheetAbsentBox: {
    flex: 1,
    backgroundColor: Colors.rose50,
    borderRadius: Radii.card,
    padding: 16,
  },
  sheetCountPresent: {
    fontSize: 28,
    fontWeight: '700',
    color: Colors.forest,
  },
  sheetCountAbsent: {
    fontSize: 28,
    fontWeight: '700',
    color: Colors.rose,
  },
  sheetLabel: {
    fontSize: 13,
    color: Colors.soft,
    marginTop: 2,
  },
  sheetNotice: {
    fontSize: 13,
    color: Colors.soft,
    lineHeight: 18,
  },
});
