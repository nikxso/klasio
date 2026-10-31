import React, { useEffect, useState, useMemo } from 'react';
import { View, Text, StyleSheet, Pressable, TouchableOpacity, TextInput } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ScanFace, Users, ChevronLeft, AlertCircle, Cloud, CloudOff, RefreshCw, Check } from 'lucide-react-native';

import { Screen, Card, Button, Ring, Bar, Avatar, SectionTitle, Chip, Sheet } from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';
import { AttendanceRosterList } from '@/components/AttendanceRosterList';
import { CachedStudent, RosterRepository } from '@/storage/rosterRepository';
import {
  AttendanceRepository,
  LocalSessionRow,
  LocalAmendmentAuditRow,
} from '@/storage/attendanceRepository';
import { AttendanceSyncWorker } from '@/storage/syncWorker';
import type {
  AccumulatedRecognitionCandidate,
  SessionApplicabilityStatus,
} from '@/perception/contracts';

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
    slot?: string;
    applicability?: string;
    statusReason?: string;
    accumulatedCandidatesJson?: string;
  }>();

  const [students, setStudents] = useState(DEMO_STUDENTS);
  const [markingMode, setMarkingMode] = useState(params.initialMode === 'review');
  const [reviewTab, setReviewTab] = useState<'check' | 'found'>('check');
  const [marks, setMarks] = useState<Record<string, 'PRESENT' | 'ABSENT' | 'EXCUSED'>>({});
  const [confirmSheetVisible, setConfirmSheetVisible] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);

  // Session context states (Phase 8: Multi-session slots and explicit applicability)
  const [selectedSlot, setSelectedSlot] = useState<number>(params.slot ? Number(params.slot) : 1);
  const [applicabilityStatus, setApplicabilityStatus] = useState<SessionApplicabilityStatus>(
    (params.applicability as SessionApplicabilityStatus) || 'COUNTED'
  );
  const [statusReason, setStatusReason] = useState<string>(params.statusReason || '');
  const [syncStatus, setSyncStatus] = useState<'IDLE' | 'SAVED_OFFLINE' | 'SYNCING' | 'SYNCED' | 'SYNC_FAILED'>('IDLE');
  const [recordedTodaySlots, setRecordedTodaySlots] = useState<Set<number>>(new Set());
  const [recordedSessionsMap, setRecordedSessionsMap] = useState<Map<number, LocalSessionRow>>(new Map());
  const [currentSessionRecords, setCurrentSessionRecords] = useState<Record<string, string>>({});
  const [amendmentHistory, setAmendmentHistory] = useState<LocalAmendmentAuditRow[]>([]);
  const [customSlots, setCustomSlots] = useState<number[]>([]);

  // Post-finalization amendment states (Phase 9 / FR-027)
  const [amendSheetVisible, setAmendSheetVisible] = useState(false);
  const [amendStudentId, setAmendStudentId] = useState<string>('');
  const [amendNewStatus, setAmendNewStatus] = useState<'PRESENT' | 'ABSENT' | 'EXCUSED'>('PRESENT');
  const [amendReason, setAmendReason] = useState<string>('');
  const [amendError, setAmendError] = useState<string>('');
  const [amendSuccessMsg, setAmendSuccessMsg] = useState<string>('');

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

      // Data-driven slot discovery: Query already finalized/recorded sessions for today
      AttendanceRepository.listSessionsForAssignment(params.id).then((sessions) => {
        const todayIso = new Date().toISOString().split('T')[0];
        const forToday = sessions.filter((s) => s.sessionDate === todayIso);
        const map = new Map<number, LocalSessionRow>();
        forToday.forEach((s) => map.set(s.periodSlotOrSequence, s));
        setRecordedSessionsMap(map);
        const taken = new Set(forToday.map((s) => s.periodSlotOrSequence));
        setRecordedTodaySlots(taken);

        if (!params.slot) {
          let nextAvailable = 1;
          while (taken.has(nextAvailable)) {
            nextAvailable++;
          }
          setSelectedSlot(nextAvailable);
        }
      }).catch(() => {
        // Fallback gracefully in testing / uninitialized SQLite
      });
    }
  }, [params.id, params.slot]);

  // Load records and amendment history whenever selected slot changes
  useEffect(() => {
    const current = recordedSessionsMap.get(selectedSlot);
    if (current?.clientSessionUuid) {
      AttendanceRepository.getSession(current.clientSessionUuid).then((res) => {
        if (res?.records) {
          const recMap: Record<string, string> = {};
          res.records.forEach((r) => {
            recMap[r.studentUserId] = r.attendanceStatus;
          });
          setCurrentSessionRecords(recMap);
        }
      }).catch(() => {});

      AttendanceRepository.listAmendmentsForSession(current.clientSessionUuid)
        .then(setAmendmentHistory)
        .catch(() => {});
    } else {
      setCurrentSessionRecords({});
      setAmendmentHistory([]);
    }
  }, [selectedSlot, recordedSessionsMap]);

  // Dynamic Correction Window Calculation (institutional policy: 7 days)
  const CORRECTION_WINDOW_DAYS = 7;
  const currentRecordedSession = recordedSessionsMap.get(selectedSlot);
  const { daysRemaining, isCorrectionWindowExpired } = useMemo(() => {
    if (!currentRecordedSession?.sessionDate) {
      return { daysRemaining: CORRECTION_WINDOW_DAYS, isCorrectionWindowExpired: false };
    }
    const sessionDateObj = new Date(currentRecordedSession.sessionDate);
    const now = new Date();
    const diffDays = Math.floor(Math.max(0, now.getTime() - sessionDateObj.getTime()) / (1000 * 60 * 60 * 24));
    const remaining = Math.max(0, CORRECTION_WINDOW_DAYS - diffDays);
    return {
      daysRemaining: remaining,
      isCorrectionWindowExpired: diffDays >= CORRECTION_WINDOW_DAYS,
    };
  }, [currentRecordedSession]);

  // Data-driven available slots: combines baseline academic slots (1..6), custom added slots, and existing recorded slots
  const availableSlots = useMemo(() => {
    const base = [1, 2, 3, 4, 5, 6];
    const combined = new Set<number>([
      ...base,
      ...customSlots,
      ...Array.from(recordedTodaySlots),
    ]);
    if (params.slot) combined.add(Number(params.slot));
    return Array.from(combined).sort((a, b) => a - b);
  }, [recordedTodaySlots, customSlots, params.slot]);

  const handleAddCustomSlot = () => {
    const highest = availableSlots.length > 0 ? Math.max(...availableSlots) : 0;
    const nextSlot = highest + 1;
    setCustomSlots((prev) => [...prev, nextSlot]);
    setSelectedSlot(nextSlot);
  };

  const avgPct = Number(params.avg || '88');
  const heldCount = Number(params.held || '38');
  const isDelegated = params.isDelegated === 'true';

  // Parse accumulated recognition candidates from scanning session if available
  const candidatesFromScan = useMemo<AccumulatedRecognitionCandidate[]>(() => {
    if (!params.accumulatedCandidatesJson) return [];
    try {
      return JSON.parse(params.accumulatedCandidatesJson);
    } catch {
      return [];
    }
  }, [params.accumulatedCandidatesJson]);

  const recognisedIds = useMemo(() => {
    if (candidatesFromScan.length > 0) {
      return new Set(candidatesFromScan.map((c) => c.studentUserId));
    }
    return new Set<string>();
  }, [candidatesFromScan]);

  const recognisedStudents = students.filter((s) => recognisedIds.has(s.studentUserId));
  const toCheckStudents = students.filter((s) => !recognisedIds.has(s.studentUserId));

  // Initialize recognised candidates as suggested PRESENT on entering review mode
  useEffect(() => {
    if (markingMode && Object.keys(marks).length === 0) {
      const initialMarks: Record<string, 'PRESENT' | 'ABSENT' | 'EXCUSED'> = {};
      recognisedStudents.forEach((s) => {
        initialMarks[s.studentUserId] = 'PRESENT';
      });
      // Unobserved students strictly remain UNDECIDED (never default to ABSENT)
      setMarks(initialMarks);
    }
  }, [markingMode, recognisedStudents]);

  const presentCount = Object.values(marks).filter((m) => m === 'PRESENT').length;
  const absentCount = Object.values(marks).filter((m) => m === 'ABSENT').length;
  const excusedCount = Object.values(marks).filter((m) => m === 'EXCUSED').length;
  const undecidedCount = students.length - (presentCount + absentCount + excusedCount);
  const undecidedInCheck = toCheckStudents.filter((s) => !marks[s.studentUserId]).length;

  const currentDisplayList = reviewTab === 'check' ? toCheckStudents : recognisedStudents;

  if (markingMode) {
    return (
      <Screen
        onBack={() => setMarkingMode(false)}
        subtitle={params.subject || 'Data Structures'}
        title="Review attendance"
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
          disabled={
            applicabilityStatus === 'COUNTED'
              ? undecidedCount > 0
              : statusReason.trim().length === 0
          }
          onPress={() => setConfirmSheetVisible(true)}
        >
          {applicabilityStatus === 'COUNTED'
            ? undecidedCount > 0
              ? `${undecidedCount} left to mark`
              : 'Finalize attendance'
            : statusReason.trim().length === 0
            ? 'Reason required to save'
            : `Finalize ${applicabilityStatus.toLowerCase()} session`}
        </Button>

        <Sheet
          visible={confirmSheetVisible}
          onClose={() => setConfirmSheetVisible(false)}
        >
          <Text style={styles.sheetTitle}>
            Save {applicabilityStatus === 'COUNTED' ? 'attendance' : applicabilityStatus.toLowerCase()}?
          </Text>
          <View style={styles.sheetSummaryGrid}>
            <View style={styles.sheetPresentBox}>
              <Text style={styles.sheetCountPresent}>{presentCount}</Text>
              <Text style={styles.sheetLabel}>Present</Text>
            </View>
            <View style={styles.sheetAbsentBox}>
              <Text style={styles.sheetCountAbsent}>{absentCount}</Text>
              <Text style={styles.sheetLabel}>Absent</Text>
            </View>
            {excusedCount > 0 && (
              <View style={[styles.sheetAbsentBox, { backgroundColor: Colors.lilac50 }]}>
                <Text style={[styles.sheetCountAbsent, { color: Colors.lilac }]}>{excusedCount}</Text>
                <Text style={styles.sheetLabel}>Excused</Text>
              </View>
            )}
          </View>
          <Text style={styles.sheetNotice}>
            {applicabilityStatus === 'COUNTED'
              ? `Finalizing Period ${selectedSlot}. You can still correct mistakes within the institution's correction window.`
              : `Marking Period ${selectedSlot} as ${applicabilityStatus}: "${statusReason}". This session will not penalize student percentages.`}
          </Text>
          <Button
            variant="primary"
            style={{ marginTop: 18 }}
            onPress={async () => {
              try {
                const nowIso = new Date().toISOString();
                const today = nowIso.slice(0, 10);
                const clientUuid = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                const records = students.map((s) => {
                  let status = marks[s.studentUserId];
                  if (!status) {
                    status = applicabilityStatus === 'COUNTED' ? 'ABSENT' : 'EXCUSED';
                  }
                  const isAi = recognisedIds.has(s.studentUserId) && status === 'PRESENT';
                  return {
                    studentUserId: s.studentUserId,
                    attendanceStatus: status,
                    markSource: (isAi ? 'AI_VERIFIED' : 'MANUAL_MARK') as 'AI_VERIFIED' | 'MANUAL_MARK',
                    candidateConfidence: isAi ? 0.90 : null,
                    recordedAt: nowIso,
                  };
                });

                await AttendanceRepository.finalizeSession({
                  clientSessionUuid: clientUuid,
                  teachingAssignmentId: params.id || 'assign-1',
                  sessionDate: today,
                  periodSlotOrSequence: selectedSlot,
                  applicabilityStatus: applicabilityStatus,
                  statusReason: applicabilityStatus !== 'COUNTED' ? statusReason : null,
                  regularFacultyUserId: 'fac-1',
                  conductingFacultyUserId: 'fac-1',
                  substituteDelegationId: isDelegated ? 'del-1' : null,
                  finalizedAt: nowIso,
                  records,
                });

                setSyncStatus('SYNCING');
                try {
                  await AttendanceSyncWorker.processPendingQueue();
                  const qStatus = await AttendanceRepository.getSyncStatus(clientUuid);
                  if (qStatus && qStatus.syncStatus === 'ACKNOWLEDGED') {
                    setSyncStatus('SYNCED');
                  } else {
                    setSyncStatus('SAVED_OFFLINE');
                  }
                } catch {
                  setSyncStatus('SAVED_OFFLINE');
                }
              } catch (e) {
                console.warn('Local finalization note:', e);
              }
              setConfirmSheetVisible(false);
              setMarkingMode(false);
              setSavedSuccess(true);
            }}
          >
            Finalize attendance
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

      {/* Sync Status Banner */}
      {syncStatus !== 'IDLE' && (
        <View style={[
          styles.syncBanner,
          syncStatus === 'SYNCED' ? styles.syncBannerSuccess : styles.syncBannerPending
        ]}>
          <Text style={styles.syncBannerText}>
            {syncStatus === 'SYNCED'
              ? '✓ Attendance session synchronized with server'
              : syncStatus === 'SYNCING'
              ? 'Synchronizing session with server…'
              : 'Saved offline in local database (sync pending)'}
          </Text>
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

      {/* Session Period & Applicability Setup Card */}
      <Card style={styles.sessionSetupCard}>
        <Text style={styles.setupLabel}>Session Period / Slot</Text>
        <View style={styles.slotRow}>
          {availableSlots.map((slot) => {
            const isRecorded = recordedTodaySlots.has(slot);
            return (
              <Pressable
                key={slot}
                onPress={() => setSelectedSlot(slot)}
                style={[
                  styles.slotPill,
                  selectedSlot === slot && styles.slotPillActive,
                ]}
              >
                <Text
                  style={[
                    styles.slotPillText,
                    selectedSlot === slot && styles.slotPillTextActive,
                  ]}
                >
                  Period {slot}{isRecorded ? ' ✓' : ''}
                </Text>
              </Pressable>
            );
          })}
          <Pressable
            onPress={handleAddCustomSlot}
            style={[styles.slotPill, styles.addSlotPill]}
          >
            <Text style={styles.addSlotPillText}>+ Add</Text>
          </Pressable>
        </View>

        <Text style={[styles.setupLabel, { marginTop: 12 }]}>Session Applicability</Text>
        <View style={styles.applicabilityRow}>
          {(['COUNTED', 'CANCELLED', 'EXEMPT'] as const).map((app) => (
            <Pressable
              key={app}
              onPress={() => setApplicabilityStatus(app)}
              style={[
                styles.appChip,
                applicabilityStatus === app && styles.appChipActive,
              ]}
            >
              <Text
                style={[
                  styles.appChipText,
                  applicabilityStatus === app && styles.appChipTextActive,
                ]}
              >
                {app === 'COUNTED' ? 'Counted' : app === 'CANCELLED' ? 'Cancelled' : 'Exempt'}
              </Text>
            </Pressable>
          ))}
        </View>

        {applicabilityStatus !== 'COUNTED' && (
          <View style={{ marginTop: 10 }}>
            <Text style={[styles.setupLabel, { fontSize: 12 }]}>Reason for {applicabilityStatus.toLowerCase()} (mandatory):</Text>
            <TextInput
              style={styles.reasonInput}
              placeholder="e.g. Inclement weather / College event"
              placeholderTextColor={Colors.soft}
              value={statusReason}
              onChangeText={setStatusReason}
            />
          </View>
        )}
      </Card>

      {recordedTodaySlots.has(selectedSlot) ? (
        <View style={styles.amendmentContainer}>
          <View
            style={[
              styles.amendmentBanner,
              isDelegated
                ? styles.amendmentBannerDelegated
                : isCorrectionWindowExpired
                ? styles.amendmentBannerExpired
                : styles.amendmentBannerActive,
            ]}
          >
            <Text
              style={[
                styles.amendmentBannerTitle,
                isDelegated
                  ? styles.amendmentTitleDelegated
                  : isCorrectionWindowExpired
                  ? styles.amendmentTitleExpired
                  : styles.amendmentTitleActive,
              ]}
            >
              {isDelegated
                ? 'Attendance locked for substitute faculty'
                : isCorrectionWindowExpired
                ? 'Correction window expired — Admin required'
                : `Correction window open · ${daysRemaining} ${daysRemaining === 1 ? 'day' : 'days'} remaining`}
            </Text>
            <Text style={styles.amendmentBannerDesc}>
              {isDelegated
                ? 'Substitute faculty cannot make post-finalization amendments (FR-027). Only assigned regular faculty or administrators may amend attendance.'
                : isCorrectionWindowExpired
                ? `The ${CORRECTION_WINDOW_DAYS}-day correction window has expired. Contact an administrator to make any further adjustments.`
                : `Assigned regular faculty may correct attendance within ${CORRECTION_WINDOW_DAYS} days. All corrections generate an immutable audit trail and synchronize with the server.`}
            </Text>
          </View>

          {!isDelegated && !isCorrectionWindowExpired && (
            <Button
              variant="soft"
              style={styles.takeAttendanceButton}
              icon={<RefreshCw size={18} color={Colors.ink} />}
              onPress={() => {
                setAmendError('');
                setAmendSuccessMsg('');
                setAmendReason('');
                const initialStudentId = students[0]?.studentUserId || '';
                setAmendStudentId(initialStudentId);
                const currentStatus = (currentSessionRecords[initialStudentId] as any) || 'ABSENT';
                setAmendNewStatus(currentStatus === 'PRESENT' ? 'ABSENT' : 'PRESENT');
                setAmendSheetVisible(true);
              }}
            >
              Amend attendance · Period {selectedSlot}
            </Button>
          )}
        </View>
      ) : (
        <>
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
                  slot: String(selectedSlot),
                  applicability: applicabilityStatus,
                  statusReason: statusReason,
                },
              });
            }}
          >
            Start scanning · Period {selectedSlot}
          </Button>

          <TouchableOpacity
            onPress={() => setMarkingMode(true)}
            style={{ marginTop: 10, marginBottom: 8, alignItems: 'center' }}
          >
            <Text style={{ fontSize: 13, color: Colors.soft, textDecorationLine: 'underline' }}>
              Mark attendance manually
            </Text>
          </TouchableOpacity>
        </>
      )}

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
                  <TouchableOpacity
                    onPress={() => {
                      router.push({
                        pathname: '/(faculty)/enrollment',
                        params: {
                          studentUserId: student.studentUserId,
                          studentName: student.studentName,
                          institutionalId: student.institutionalId,
                          teachingAssignmentId: params.id || '',
                          sectionCode: params.section || '',
                        },
                      });
                    }}
                    accessibilityLabel={`Biometric enrollment for ${student.studentName}`}
                  >
                    <Chip tone={faceTone}>{faceLabel}</Chip>
                  </TouchableOpacity>
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

      {/* Amendment Audit History */}
      {amendmentHistory.length > 0 && (
        <View style={styles.historyContainer}>
          <SectionTitle>Amendment Audit History ({amendmentHistory.length})</SectionTitle>
          <View style={styles.historyCard}>
            {amendmentHistory.map((item, idx) => {
              const student = students.find((s) => s.studentUserId === item.student_user_id);
              const studentLabel = student
                ? `${student.studentName} (${student.institutionalId})`
                : item.student_user_id;
              const isLast = idx === amendmentHistory.length - 1;
              const formattedDate = new Date(item.amended_at).toLocaleString();

              return (
                <View
                  key={item.id || idx}
                  style={[styles.historyRow, !isLast && styles.rowDivider]}
                >
                  <View style={styles.historyHeader}>
                    <Text style={styles.historyStudentName} numberOfLines={1}>
                      {studentLabel}
                    </Text>
                    <View style={styles.statusTransitionBadge}>
                      <Text style={styles.statusTransitionText}>
                        {item.previous_status} → {item.new_status}
                      </Text>
                    </View>
                  </View>
                  <Text style={styles.historyReason}>"{item.amendment_reason}"</Text>
                  <View style={styles.historyFooter}>
                    <Text style={styles.historyMeta}>
                      By {item.amendment_role === 'REGULAR_FACULTY' ? 'Regular Faculty' : item.amendment_role} · {formattedDate}
                    </Text>
                  </View>
                </View>
              );
            })}
          </View>
        </View>
      )}

      {/* Post-Finalization Amendment Sheet (Phase 9 / FR-027) */}
      <Sheet
        visible={amendSheetVisible}
        onClose={() => setAmendSheetVisible(false)}
      >
        <View style={{ paddingVertical: 10 }}>
          <Text style={[styles.setupLabel, { fontSize: 16, fontWeight: '700', marginBottom: 12 }]}>
            Amend Attendance · Period {selectedSlot}
          </Text>
          <Text style={styles.setupLabel}>Select Student</Text>
          <View style={styles.amendStudentSelector}>
            {students.map((s) => (
              <Pressable
                key={s.studentUserId}
                onPress={() => {
                  setAmendStudentId(s.studentUserId);
                  const currentStatus = (currentSessionRecords[s.studentUserId] as any) || 'ABSENT';
                  setAmendNewStatus(currentStatus === 'PRESENT' ? 'ABSENT' : 'PRESENT');
                }}
                style={[
                  styles.amendStudentPill,
                  amendStudentId === s.studentUserId && styles.amendStudentPillActive,
                ]}
              >
                <Text
                  style={[
                    styles.amendStudentPillText,
                    amendStudentId === s.studentUserId && styles.amendStudentPillTextActive,
                  ]}
                >
                  {s.studentName} ({s.institutionalId})
                </Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.currentStatusRow}>
            <Text style={[styles.setupLabel, { fontSize: 13 }]}>
              Current recorded status:{' '}
              <Text style={{ fontWeight: '700', color: Colors.ink }}>
                {currentSessionRecords[amendStudentId] || 'ABSENT'}
              </Text>
            </Text>
          </View>

          <Text style={[styles.setupLabel, { marginTop: 10 }]}>New Attendance Status</Text>
          <View style={styles.amendStatusRow}>
            {(['PRESENT', 'ABSENT', 'EXCUSED'] as const).map((st) => (
              <Pressable
                key={st}
                onPress={() => setAmendNewStatus(st)}
                style={[
                  styles.statusSelectPill,
                  amendNewStatus === st && styles.statusSelectPillActive,
                ]}
              >
                <Text
                  style={[
                    styles.statusSelectPillText,
                    amendNewStatus === st && styles.statusSelectPillTextActive,
                  ]}
                >
                  {st}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={[styles.setupLabel, { marginTop: 14 }]}>
            Justification Reason (min. 10 chars):
          </Text>
          <TextInput
            style={styles.reasonInput}
            placeholder="e.g. Medical certificate verified by department"
            placeholderTextColor={Colors.soft}
            value={amendReason}
            onChangeText={(txt) => {
              setAmendReason(txt);
              if (amendError) setAmendError('');
            }}
          />

          {amendError ? (
            <Text style={{ color: Colors.rose, fontSize: 12, marginTop: 6 }}>
              {amendError}
            </Text>
          ) : null}

          {amendSuccessMsg ? (
            <Text style={{ color: Colors.forest, fontSize: 12, marginTop: 6, fontWeight: '600' }}>
              ✓ {amendSuccessMsg}
            </Text>
          ) : null}

          <Button
            variant="primary"
            style={{ marginTop: 16 }}
            onPress={async () => {
              if (amendReason.trim().length < 10) {
                setAmendError('Justification reason must be at least 10 characters.');
                return;
              }
              const current = recordedSessionsMap.get(selectedSlot);
              if (!current?.clientSessionUuid) {
                setAmendError('No finalized session found for this slot.');
                return;
              }
              const currentStatus = currentSessionRecords[amendStudentId] || 'ABSENT';
              if (currentStatus === amendNewStatus) {
                setAmendError(`Student is already marked as ${amendNewStatus}.`);
                return;
              }

              try {
                await AttendanceRepository.applyAmendment(
                  current.clientSessionUuid,
                  amendStudentId,
                  amendNewStatus,
                  amendReason.trim(),
                  params.regularFaculty || 'fac-1',
                  'REGULAR_FACULTY'
                );

                // Update local session records map
                setCurrentSessionRecords((prev) => ({
                  ...prev,
                  [amendStudentId]: amendNewStatus,
                }));

                // Refresh amendment history
                const updatedAudits = await AttendanceRepository.listAmendmentsForSession(current.clientSessionUuid);
                setAmendmentHistory(updatedAudits);

                setAmendSuccessMsg('Correction saved — waiting to sync');

                // Trigger background queue drain
                AttendanceSyncWorker.processPendingQueue().then(async () => {
                  const updated = await AttendanceRepository.listAmendmentsForSession(current.clientSessionUuid);
                  setAmendmentHistory(updated);
                }).catch(() => {
                  // Stored locally in sync_queue, will retry on next reconnect
                });

                setTimeout(() => {
                  setAmendSheetVisible(false);
                  setAmendSuccessMsg('');
                }, 1200);
              } catch (e: any) {
                setAmendError(e.message || 'Failed to apply amendment.');
              }
            }}
          >
            Submit Amendment (Audited)
          </Button>
        </View>
      </Sheet>
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
  sessionSetupCard: {
    backgroundColor: Colors.card,
    borderRadius: Radii.card,
    padding: 14,
    marginBottom: 14,
  },
  setupLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.ink,
    marginBottom: 8,
  },
  slotRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  slotPill: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 10,
    backgroundColor: Colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  addSlotPill: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: Colors.line,
    borderStyle: 'dashed',
  },
  addSlotPillText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.soft,
  },
  slotPillActive: {
    backgroundColor: Colors.ink,
  },
  slotPillText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.soft,
  },
  slotPillTextActive: {
    color: '#ffffff',
  },
  applicabilityRow: {
    flexDirection: 'row',
    gap: 8,
  },
  appChip: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: Colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  appChipActive: {
    backgroundColor: Colors.card,
    borderWidth: 1.5,
    borderColor: Colors.ink,
  },
  appChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.soft,
  },
  appChipTextActive: {
    color: Colors.ink,
  },
  reasonInput: {
    backgroundColor: Colors.line,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 13,
    color: Colors.ink,
    marginTop: 6,
  },
  syncBanner: {
    padding: 12,
    borderRadius: Radii.card,
    marginBottom: 12,
  },
  syncBannerSuccess: {
    backgroundColor: Colors.forest50,
  },
  syncBannerPending: {
    backgroundColor: Colors.apricot50,
  },
  syncBannerText: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.ink,
  },
  amendmentContainer: {
    marginBottom: 12,
  },
  amendmentBanner: {
    padding: 12,
    borderRadius: Radii.card,
    marginBottom: 10,
    borderWidth: 1,
  },
  amendmentBannerActive: {
    backgroundColor: Colors.forest50,
    borderColor: '#cce6d2',
  },
  amendmentBannerDelegated: {
    backgroundColor: Colors.apricot50,
    borderColor: '#f5d9bb',
  },
  amendmentBannerTitle: {
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 4,
  },
  amendmentTitleActive: {
    color: Colors.forest,
  },
  amendmentTitleDelegated: {
    color: Colors.amber,
  },
  amendmentBannerDesc: {
    fontSize: 12,
    color: Colors.ink,
    lineHeight: 16,
  },
  amendStudentSelector: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 6,
  },
  amendStudentPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: Colors.line,
  },
  amendStudentPillActive: {
    backgroundColor: Colors.card,
    borderWidth: 1.5,
    borderColor: Colors.ink,
  },
  amendStudentPillText: {
    fontSize: 11,
    color: Colors.soft,
    fontWeight: '500',
  },
  amendStudentPillTextActive: {
    color: Colors.ink,
    fontWeight: '700',
  },
  amendStatusRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 6,
  },
  statusSelectPill: {
    flex: 1,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: Colors.line,
    alignItems: 'center',
  },
  statusSelectPillActive: {
    backgroundColor: Colors.card,
    borderWidth: 1.5,
    borderColor: Colors.ink,
  },
  statusSelectPillText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.soft,
  },
  statusSelectPillTextActive: {
    color: Colors.ink,
  },
  amendmentBannerExpired: {
    backgroundColor: Colors.rose50,
    borderColor: '#f0c8cb',
  },
  amendmentTitleExpired: {
    color: Colors.rose,
  },
  currentStatusRow: {
    marginTop: 10,
    marginBottom: 4,
  },
  historyContainer: {
    marginTop: 16,
    marginBottom: 16,
  },
  historyCard: {
    backgroundColor: Colors.card,
    borderRadius: 20,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: '#efe7da88',
  },
  historyRow: {
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  historyHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  historyStudentName: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.ink,
    flex: 1,
    marginRight: 8,
  },
  statusTransitionBadge: {
    backgroundColor: Colors.line,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
  },
  statusTransitionText: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.ink,
  },
  historyReason: {
    fontSize: 12,
    color: Colors.ink,
    fontStyle: 'italic',
    marginBottom: 6,
    lineHeight: 16,
  },
  historyFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  historyMeta: {
    fontSize: 11,
    color: Colors.soft,
  },
});

