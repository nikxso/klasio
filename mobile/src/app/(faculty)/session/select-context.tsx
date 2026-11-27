import React, { useEffect, useState, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  TextInput,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import {
  ScanFace,
  Calendar,
  Clock,
  MapPin,
  Check,
  AlertTriangle,
  BookOpen,
  ArrowRight,
  UserCheck,
  ListChecks,
  Info,
} from 'lucide-react-native';

import { Screen, Card, Chip, Button, SectionTitle, AccessRestrictedView } from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';
import { API_BASE_URL } from '@/config/api';
import { SessionStore } from '@/storage/sessionStore';
import { AttendanceRepository, LocalSessionRow } from '@/storage/attendanceRepository';

interface AssignmentItem {
  id: string;
  subjectCode: string;
  subjectName: string;
  sectionCode: string;
  room: string;
  scheduleTime: string;
  isDelegated: boolean;
  regularFacultyName?: string;
}

interface PeriodSlotItem {
  slot: number;
  label: string;
  time: string;
  isBreak?: boolean;
}

const DEFAULT_PERIOD_SLOTS: PeriodSlotItem[] = [
  { slot: 1, label: 'P1', time: '09:00 - 10:00' },
  { slot: 2, label: 'P2', time: '10:00 - 11:00' },
  { slot: 3, label: 'P3', time: '11:00 - 12:00' },
  { slot: 4, label: 'Lunch', time: '12:00 - 13:00', isBreak: true },
  { slot: 5, label: 'P4', time: '13:00 - 14:00' },
  { slot: 6, label: 'P5', time: '14:00 - 15:00' },
  { slot: 7, label: 'P6', time: '15:00 - 16:00' },
  { slot: 8, label: 'P7', time: '16:00 - 17:00' },
];

export default function SelectAttendanceContextScreen() {
  const router = useRouter();

  if (!SessionStore.canScanAttendance()) {
    return (
      <AccessRestrictedView
        title="Attendance Scanner Restricted"
        message="Your active user roles do not permit live classroom attendance scanning."
        requiredCapability="attendance.session.start"
        onBack={() => router.replace('/(faculty)' as any)}
      />
    );
  }

  const params = useLocalSearchParams<{
    preselectId?: string;
    slot?: string;
    timetableEntryId?: string;
    room?: string;
  }>();

  const [assignments, setAssignments] = useState<AssignmentItem[]>([]);
  const [periodSlots, setPeriodSlots] = useState<PeriodSlotItem[]>(DEFAULT_PERIOD_SLOTS);
  const [loadingAssignments, setLoadingAssignments] = useState(false);
  const [selectedAssignmentId, setSelectedAssignmentId] = useState<string>(
    params.preselectId || ''
  );

  const todayStr = useMemo(() => new Date().toISOString().split('T')[0], []);
  const [sessionDate, setSessionDate] = useState<string>(todayStr);
  const [selectedSlot, setSelectedSlot] = useState<number>(
    params.slot ? parseInt(params.slot, 10) || 1 : 1
  );
  const [applicability, setApplicability] = useState<'COUNTED' | 'CANCELLED' | 'EXEMPT'>('COUNTED');
  const [statusReason, setStatusReason] = useState<string>('');

  const [existingSession, setExistingSession] = useState<LocalSessionRow | null>(null);
  const [checkingExisting, setCheckingExisting] = useState(false);

  // Fetch configured periods & authorized assignments from API
  useEffect(() => {
    let isCancelled = false;
    async function loadData() {
      try {
        setLoadingAssignments(true);
        const token = SessionStore.getToken();
        const headers: Record<string, string> = {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        };

        const [periodsRes, assignRes] = await Promise.all([
          fetch(`${API_BASE_URL}/api/v1/admin/periods`, { headers }),
          fetch(`${API_BASE_URL}/api/v1/faculty/assignments`, { headers }),
        ]);

        if (periodsRes.ok && !isCancelled) {
          const pList = await periodsRes.json();
          if (Array.isArray(pList) && pList.length > 0) {
            const mappedSlots: PeriodSlotItem[] = pList.map((p: any) => ({
              slot: p.period_number,
              label: p.name || `P${p.period_number}`,
              time: `${p.start_time?.slice(0, 5) || ''} - ${p.end_time?.slice(0, 5) || ''}`,
              isBreak: Boolean(p.is_break),
            }));
            setPeriodSlots(mappedSlots);
          }
        }

        if (assignRes.ok && !isCancelled) {
          const data = await assignRes.json();
          if (Array.isArray(data) && data.length > 0) {
            const mapped: AssignmentItem[] = data.map((item: any) => ({
              id: item.teaching_assignment_id || item.id,
              subjectCode: item.subject_code || item.subjectCode || 'CS101',
              subjectName: item.subject_name || item.subjectName || 'Course',
              sectionCode: item.section_code || item.sectionCode || 'A',
              room: params.room || item.room || 'LH-204',
              scheduleTime: item.scheduleTime || '09:00 - 10:00',
              isDelegated: Boolean(item.is_delegated),
              regularFacultyName: item.delegation_details?.regular_faculty_name,
            }));
            setAssignments(mapped);
            if (!params.preselectId) {
              setSelectedAssignmentId(mapped[0].id);
            }
          }
        }
      } catch (err) {
        // Fall back gracefully
      } finally {
        if (!isCancelled) setLoadingAssignments(false);
      }
    }
    loadData();
    return () => {
      isCancelled = true;
    };
  }, [params.preselectId, params.room]);

  // Check for existing session in SQLite
  useEffect(() => {
    let isCancelled = false;
    async function checkSession() {
      if (!selectedAssignmentId) return;
      setCheckingExisting(true);
      try {
        const found = await AttendanceRepository.findExistingSession(
          selectedAssignmentId,
          sessionDate,
          selectedSlot
        );
        if (!isCancelled) {
          setExistingSession(found);
        }
      } catch (err) {
        if (!isCancelled) setExistingSession(null);
      } finally {
        if (!isCancelled) setCheckingExisting(false);
      }
    }
    checkSession();
    return () => {
      isCancelled = true;
    };
  }, [selectedAssignmentId, sessionDate, selectedSlot]);

  const selectedAssignment = useMemo(() => {
    return assignments.find((a) => a.id === selectedAssignmentId) || assignments[0];
  }, [assignments, selectedAssignmentId]);

  const isFinalizedAlready =
    existingSession &&
    (existingSession.sessionStatus === 'FINALIZED' || existingSession.sessionStatus === 'SYNCED');

  const handleStartScanning = () => {
    if (!selectedAssignment) return;
    if (isFinalizedAlready) {
      Alert.alert(
        'Session Already Finalized',
        `A finalized attendance session already exists for ${selectedAssignment.subjectName} on ${sessionDate} Period ${selectedSlot}. You can view or amend this session from the class details page.`,
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'View Class',
            onPress: () => {
              router.replace({
                pathname: '/(faculty)/section/[id]',
                params: {
                  id: selectedAssignment.id,
                  subject: selectedAssignment.subjectName,
                  code: selectedAssignment.subjectCode,
                  section: selectedAssignment.sectionCode,
                  room: selectedAssignment.room,
                },
              });
            },
          },
        ]
      );
      return;
    }

    if (applicability !== 'COUNTED' && !statusReason.trim()) {
      Alert.alert(
        'Reason Required',
        `Please provide a status reason when setting applicability to ${applicability}.`
      );
      return;
    }

    router.push({
      pathname: '/(faculty)/session/scan',
      params: {
        sectionId: selectedAssignment.id,
        assignmentId: selectedAssignment.id,
        subject: selectedAssignment.subjectName,
        code: selectedAssignment.subjectCode,
        section: selectedAssignment.sectionCode,
        room: selectedAssignment.room,
        slot: String(selectedSlot),
        sessionDate: sessionDate,
        applicability: applicability,
        statusReason: statusReason.trim() || undefined,
        timetableEntryId: params.timetableEntryId,
      },
    });
  };

  const handleManualMarking = () => {
    if (!selectedAssignment) return;
    router.replace({
      pathname: '/(faculty)/section/[id]',
      params: {
        id: selectedAssignment.id,
        subject: selectedAssignment.subjectName,
        code: selectedAssignment.subjectCode,
        section: selectedAssignment.sectionCode,
        room: selectedAssignment.room,
        slot: String(selectedSlot),
        sessionDate: sessionDate,
        applicability: applicability,
        statusReason: statusReason.trim() || undefined,
      },
    });
  };

  return (
    <Screen
      title="Attendance Context"
      subtitle="Select class and configure session details"
      onBack={() => router.back()}
    >
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {/* Step 1: Assignment Selection */}
        <SectionTitle
          title="1. Select Class Assignment"
          badge={assignments.length > 0 ? `${assignments.length} Available` : undefined}
        />

        {loadingAssignments ? (
          <ActivityIndicator color={Colors.forest} style={{ marginVertical: 12 }} />
        ) : (
          <View style={styles.assignmentList}>
            {assignments.map((item) => {
              const isSelected = item.id === selectedAssignmentId;
              return (
                <Pressable
                  key={item.id}
                  style={[
                    styles.assignmentCard,
                    isSelected && styles.assignmentCardSelected,
                  ]}
                  onPress={() => setSelectedAssignmentId(item.id)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: isSelected }}
                >
                  <View style={styles.assignmentTopRow}>
                    <View style={styles.assignmentMainInfo}>
                      <View style={styles.subjectCodeBadge}>
                        <Text style={styles.subjectCodeText}>{item.subjectCode}</Text>
                      </View>
                      <Text style={styles.subjectNameText} numberOfLines={1}>
                        {item.subjectName}
                      </Text>
                    </View>
                    <View
                      style={[
                        styles.radioIndicator,
                        isSelected && styles.radioIndicatorSelected,
                      ]}
                    >
                      {isSelected && <Check size={14} color="#ffffff" strokeWidth={3} />}
                    </View>
                  </View>

                  <View style={styles.assignmentMetaRow}>
                    <View style={styles.metaItem}>
                      <BookOpen size={13} color={Colors.inkSecondary} />
                      <Text style={styles.metaText}>{item.sectionCode}</Text>
                    </View>
                    <View style={styles.metaItem}>
                      <MapPin size={13} color={Colors.inkSecondary} />
                      <Text style={styles.metaText}>{item.room}</Text>
                    </View>
                    <View style={styles.metaItem}>
                      <Clock size={13} color={Colors.inkSecondary} />
                      <Text style={styles.metaText}>{item.scheduleTime}</Text>
                    </View>
                  </View>

                  {item.isDelegated && (
                    <View style={styles.delegationBanner}>
                      <UserCheck size={12} color="#b86a2a" />
                      <Text style={styles.delegationText}>
                        Substitute Delegation · {item.regularFacultyName || 'Assigned Faculty'}
                      </Text>
                    </View>
                  )}
                </Pressable>
              );
            })}
          </View>
        )}

        {/* Step 2: Session Slot & Academic Date */}
        <SectionTitle title="2. Session Period & Date" />
        <Card style={styles.configCard}>
          <View style={styles.fieldRow}>
            <View style={styles.fieldHeader}>
              <Calendar size={15} color={Colors.ink} />
              <Text style={styles.fieldLabel}>Academic Date</Text>
            </View>
            <View style={styles.dateSelectorRow}>
              <Pressable
                style={[
                  styles.datePill,
                  sessionDate === todayStr && styles.datePillActive,
                ]}
                onPress={() => setSessionDate(todayStr)}
              >
                <Text
                  style={[
                    styles.datePillText,
                    sessionDate === todayStr && styles.datePillTextActive,
                  ]}
                >
                  Today ({todayStr})
                </Text>
              </Pressable>
            </View>
          </View>

          <View style={[styles.fieldRow, { marginTop: 16 }]}>
            <View style={styles.fieldHeader}>
              <Clock size={15} color={Colors.ink} />
              <Text style={styles.fieldLabel}>Period Slot (1 - 8)</Text>
            </View>
            <View style={styles.slotsGrid}>
              {periodSlots.map((p) => {
                const isActive = selectedSlot === p.slot;
                return (
                  <Pressable
                    key={p.slot}
                    style={[styles.slotButton, isActive && styles.slotButtonActive, p.isBreak && { opacity: 0.6 }]}
                    onPress={() => {
                      if (!p.isBreak) setSelectedSlot(p.slot);
                    }}
                  >
                    <Text
                      style={[styles.slotButtonText, isActive && styles.slotButtonTextActive]}
                    >
                      {p.label}
                    </Text>
                    <Text
                      style={[styles.slotSubText, isActive && styles.slotSubTextActive]}
                    >
                      {p.time.split(' - ')[0]}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </Card>

        {/* Step 3: Applicability Status */}
        <SectionTitle title="3. Applicability Status" />
        <Card style={styles.configCard}>
          <View style={styles.applicabilityRow}>
            {(['COUNTED', 'CANCELLED', 'EXEMPT'] as const).map((status) => {
              const isSelected = applicability === status;
              return (
                <Pressable
                  key={status}
                  style={[
                    styles.applicabilityOption,
                    isSelected && styles.applicabilityOptionActive,
                  ]}
                  onPress={() => setApplicability(status)}
                >
                  <Text
                    style={[
                      styles.applicabilityText,
                      isSelected && styles.applicabilityTextActive,
                    ]}
                  >
                    {status}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {applicability !== 'COUNTED' && (
            <View style={styles.reasonContainer}>
              <Text style={styles.reasonLabel}>
                Reason for {applicability} Status (Required)
              </Text>
              <TextInput
                style={styles.reasonInput}
                placeholder={
                  applicability === 'CANCELLED'
                    ? 'e.g. Faculty medical leave, Institute holiday'
                    : 'e.g. Annual sports meet, Cultural festival'
                }
                placeholderTextColor={Colors.inkTertiary}
                value={statusReason}
                onChangeText={setStatusReason}
              />
            </View>
          )}
        </Card>

        {/* Existing Session Alert */}
        {existingSession && (
          <View
            style={[
              styles.statusBanner,
              isFinalizedAlready ? styles.statusBannerDanger : styles.statusBannerWarning,
            ]}
          >
            <AlertTriangle
              size={18}
              color={isFinalizedAlready ? '#dc2626' : '#d97706'}
            />
            <View style={styles.statusBannerTextContainer}>
              <Text
                style={[
                  styles.statusBannerTitle,
                  { color: isFinalizedAlready ? '#dc2626' : '#d97706' },
                ]}
              >
                {isFinalizedAlready
                  ? 'Session Already Finalized'
                  : 'Draft Session In Progress'}
              </Text>
              <Text style={styles.statusBannerSubtitle}>
                {isFinalizedAlready
                  ? `Recorded at ${existingSession.finalizedAt || 'earlier today'}. You cannot overwrite finalized sessions directly.`
                  : 'A draft session was created earlier. Scanning will resume attendance accumulation.'}
              </Text>
            </View>
          </View>
        )}

        {/* Confirmation Context Banner */}
        <View style={styles.confirmationCard}>
          <View style={styles.confirmHeader}>
            <Info size={16} color={Colors.forest} />
            <Text style={styles.confirmTitle}>Starting attendance for:</Text>
          </View>
          <Text style={styles.confirmSubject}>
            {selectedAssignment?.subjectName} ({selectedAssignment?.subjectCode})
          </Text>
          <Text style={styles.confirmMeta}>
            Section: {selectedAssignment?.sectionCode} · Room: {selectedAssignment?.room}
          </Text>
          <Text style={styles.confirmMeta}>
            Date: {sessionDate} · Period {selectedSlot} ({periodSlots.find((p) => p.slot === selectedSlot)?.time || ''})
          </Text>
          <View style={styles.confirmChipRow}>
            <Chip
              tone={
                applicability === 'COUNTED'
                  ? 'forest'
                  : applicability === 'EXEMPT'
                  ? 'apricot'
                  : 'soft'
              }
            >
              Status: {applicability}
            </Chip>
            {selectedAssignment?.isDelegated && (
              <Chip tone="apricot">Substitute Delegation</Chip>
            )}
          </View>
        </View>

        {/* Action Buttons */}
        <View style={styles.actionsContainer}>
          <Button
            variant="primary"
            icon={<ScanFace size={20} color="#ffffff" />}
            onPress={handleStartScanning}
            disabled={checkingExisting}
            style={styles.primaryActionButton}
          >
            Launch Camera Scanner
          </Button>

          <Button
            variant="soft"
            icon={<ListChecks size={18} color={Colors.ink} />}
            onPress={handleManualMarking}
            style={styles.secondaryActionButton}
          >
            Manual Roster Entry Mode
          </Button>
        </View>
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  scrollContent: {
    paddingBottom: 40,
  },
  assignmentList: {
    gap: 10,
    marginBottom: 16,
  },
  assignmentCard: {
    backgroundColor: '#ffffff',
    borderRadius: Radii.lg,
    padding: 14,
    borderWidth: 1.5,
    borderColor: '#e5e7eb',
  },
  assignmentCardSelected: {
    borderColor: Colors.forest,
    backgroundColor: 'rgba(16, 185, 129, 0.04)',
  },
  assignmentTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  assignmentMainInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
    marginRight: 10,
  },
  subjectCodeBadge: {
    backgroundColor: '#f3f4f6',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: Radii.sm,
    marginRight: 8,
  },
  subjectCodeText: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.inkSecondary,
  },
  subjectNameText: {
    fontSize: 15,
    fontWeight: '600',
    color: Colors.ink,
    flex: 1,
  },
  radioIndicator: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: '#d1d5db',
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioIndicatorSelected: {
    borderColor: Colors.forest,
    backgroundColor: Colors.forest,
  },
  assignmentMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    flexWrap: 'wrap',
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  metaText: {
    fontSize: 12,
    color: Colors.inkSecondary,
  },
  delegationBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: '#fef3c7',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: Radii.sm,
    marginTop: 8,
  },
  delegationText: {
    fontSize: 11,
    fontWeight: '600',
    color: '#92400e',
  },
  configCard: {
    marginBottom: 16,
    padding: 14,
  },
  fieldRow: {},
  fieldHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 8,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.ink,
  },
  dateSelectorRow: {
    flexDirection: 'row',
  },
  datePill: {
    backgroundColor: '#f3f4f6',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: Radii.md,
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  datePillActive: {
    backgroundColor: 'rgba(16, 185, 129, 0.1)',
    borderColor: Colors.forest,
  },
  datePillText: {
    fontSize: 13,
    fontWeight: '500',
    color: Colors.inkSecondary,
  },
  datePillTextActive: {
    color: Colors.forest,
    fontWeight: '600',
  },
  slotsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  slotButton: {
    width: '22.5%',
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: Radii.md,
    paddingVertical: 8,
    alignItems: 'center',
  },
  slotButtonActive: {
    backgroundColor: Colors.forest,
    borderColor: Colors.forest,
  },
  slotButtonText: {
    fontSize: 13,
    fontWeight: '700',
    color: Colors.ink,
  },
  slotButtonTextActive: {
    color: '#ffffff',
  },
  slotSubText: {
    fontSize: 10,
    color: Colors.inkTertiary,
    marginTop: 2,
  },
  slotSubTextActive: {
    color: 'rgba(255, 255, 255, 0.85)',
  },
  applicabilityRow: {
    flexDirection: 'row',
    gap: 8,
  },
  applicabilityOption: {
    flex: 1,
    paddingVertical: 10,
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: Radii.md,
    alignItems: 'center',
  },
  applicabilityOptionActive: {
    backgroundColor: 'rgba(16, 185, 129, 0.12)',
    borderColor: Colors.forest,
  },
  applicabilityText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.inkSecondary,
  },
  applicabilityTextActive: {
    color: Colors.forest,
  },
  reasonContainer: {
    marginTop: 12,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#f3f4f6',
  },
  reasonLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.ink,
    marginBottom: 6,
  },
  reasonInput: {
    backgroundColor: '#f9fafb',
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: Radii.md,
    paddingHorizontal: 12,
    paddingVertical: 8,
    fontSize: 13,
    color: Colors.ink,
  },
  statusBanner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 12,
    borderRadius: Radii.md,
    marginBottom: 16,
    gap: 10,
  },
  statusBannerWarning: {
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
  },
  statusBannerDanger: {
    backgroundColor: '#fef2f2',
    borderWidth: 1,
    borderColor: '#fecaca',
  },
  statusBannerTextContainer: {
    flex: 1,
  },
  statusBannerTitle: {
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 2,
  },
  statusBannerSubtitle: {
    fontSize: 12,
    color: Colors.inkSecondary,
    lineHeight: 16,
  },
  confirmationCard: {
    backgroundColor: '#f0fdf4',
    borderWidth: 1,
    borderColor: '#bbf7d0',
    borderRadius: Radii.lg,
    padding: 14,
    marginBottom: 20,
  },
  confirmHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  confirmTitle: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.forest,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  confirmSubject: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.ink,
    marginBottom: 4,
  },
  confirmMeta: {
    fontSize: 13,
    color: Colors.inkSecondary,
    marginBottom: 2,
  },
  confirmChipRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 8,
    flexWrap: 'wrap',
  },
  actionsContainer: {
    gap: 10,
  },
  primaryActionButton: {},
  secondaryActionButton: {
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
});
