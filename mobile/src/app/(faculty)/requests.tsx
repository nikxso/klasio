import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  MessageSquare,
  Check,
  X,
  Clock,
  Calendar,
  AlertCircle,
  CheckCircle2,
  XCircle,
  User as UserIcon,
} from 'lucide-react-native';

import {
  Screen,
  Card,
  Button,
  SectionTitle,
  Chip,
  IconBubble,
  Sheet,
  AccessRestrictedView,
} from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';
import { API_BASE_URL } from '@/config/api';
import { SessionStore } from '@/storage/sessionStore';
import { extractErrorMessage } from '@/utils/apiError';

export interface AttendanceRequestItem {
  id: string;
  student_user_id: string;
  teaching_assignment_id: string;
  session_date: string;
  student_note: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'UNDER_REVIEW';
  reviewer_user_id?: string | null;
  resolution_note?: string | null;
  created_at: string;
  resolved_at?: string | null;
  subject_name?: string | null;
  student_name?: string | null;
  student_institutional_id?: string | null;
  student_email?: string | null;
  attendance_session_id?: string | null;
  attendance_adjusted?: boolean | null;
}

export default function FacultyRequestsScreen() {
  const router = useRouter();
  const user = SessionStore.getUser();

  if (user?.role?.toUpperCase() === 'STUDENT') {
    return (
      <AccessRestrictedView
        title="Faculty Workspace Restricted"
        message="Student accounts cannot review attendance requests or excuses."
        requiredCapability="attendance.candidate.review or faculty role"
        onBack={() => router.replace('/(student)' as any)}
      />
    );
  }

  const [requests, setRequests] = useState<AttendanceRequestItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [filter, setFilter] = useState<'PENDING' | 'RESOLVED' | 'ALL'>('PENDING');

  // Sheet state for approval/rejection
  const [selectedRequest, setSelectedRequest] = useState<AttendanceRequestItem | null>(null);
  const [resolveAction, setResolveAction] = useState<'APPROVED' | 'REJECTED'>('APPROVED');
  const [resolutionNote, setResolutionNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const fetchRequests = useCallback(async () => {
    let token = SessionStore.getToken();
    if (!token) {
      const stored = await SessionStore.initFromStorage();
      token = stored?.token || undefined;
    }
    if (!token) {
      setLoading(false);
      setRefreshing(false);
      return;
    }

    try {
      setErrorMsg(null);
      const res = await fetch(`${API_BASE_URL}/api/v1/attendance/requests`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });

      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setRequests(data);
        }
      } else {
        const err = await extractErrorMessage(res, 'Failed to load requests');
        setErrorMsg(err);
      }
    } catch (err: any) {
      console.warn('Failed to load reviewable attendance requests:', err);
      setErrorMsg(err?.message || 'Could not connect to server');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchRequests();
  }, [fetchRequests]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchRequests();
  };

  const openResolveSheet = (req: AttendanceRequestItem, action: 'APPROVED' | 'REJECTED') => {
    setSelectedRequest(req);
    setResolveAction(action);
    setResolutionNote(
      action === 'APPROVED'
        ? 'Approved by conducting faculty after attendance verification'
        : 'Absence record confirmed accurate against classroom roll.'
    );
  };

  const handleConfirmResolve = async () => {
    if (!selectedRequest) return;
    if (!resolutionNote.trim()) {
      Alert.alert('Resolution Statement Required', 'Please enter a note explaining the resolution decision.');
      return;
    }

    let token = SessionStore.getToken();
    if (!token) {
      const stored = await SessionStore.initFromStorage();
      token = stored?.token || undefined;
    }
    if (!token) return;

    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/attendance/requests/${selectedRequest.id}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          status: resolveAction,
          resolution_note: resolutionNote.trim(),
        }),
      });

      if (!res.ok) {
        const errMsg = await extractErrorMessage(res, 'Failed to resolve request');
        throw new Error(errMsg);
      }

      const updated = await res.json();

      // Update locally
      setRequests((prev) =>
        prev.map((r) =>
          r.id === selectedRequest.id
            ? {
                ...r,
                status: resolveAction,
                resolution_note: resolutionNote.trim(),
                resolved_at: new Date().toISOString(),
                attendance_adjusted: updated?.attendance_adjusted ?? (resolveAction === 'APPROVED'),
              }
            : r
        )
      );

      setSelectedRequest(null);
      Alert.alert(
        resolveAction === 'APPROVED' ? 'Request Approved' : 'Request Rejected',
        resolveAction === 'APPROVED'
          ? `Attendance for ${selectedRequest.student_name || 'student'} on ${selectedRequest.session_date} marked as PRESENT.`
          : `Attendance excuse for ${selectedRequest.student_name || 'student'} was rejected. Absence record maintained.`
      );
    } catch (err: any) {
      Alert.alert('Resolution Error', err?.message || 'Could not update request status.');
    } finally {
      setSubmitting(false);
    }
  };

  const filteredRequests = requests.filter((r) => {
    if (filter === 'PENDING') return r.status === 'PENDING' || r.status === 'UNDER_REVIEW';
    if (filter === 'RESOLVED') return r.status === 'APPROVED' || r.status === 'REJECTED';
    return true;
  });

  const pendingCount = requests.filter(
    (r) => r.status === 'PENDING' || r.status === 'UNDER_REVIEW'
  ).length;

  return (
    <Screen
      title="Attendance Requests"
      subtitle="Student Excuses & Grievances"
      onBack={() => router.back()}
      scrollable
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={handleRefresh}
          tintColor={Colors.forest}
          colors={[Colors.primary, Colors.forest]}
        />
      }
    >
      {/* Category Filter Pills */}
      <View style={styles.filterRow}>
        {(['PENDING', 'RESOLVED', 'ALL'] as const).map((tab) => {
          const isActive = filter === tab;
          const label =
            tab === 'PENDING'
              ? `Pending (${pendingCount})`
              : tab === 'RESOLVED'
              ? 'Resolved'
              : `All (${requests.length})`;
          return (
            <Pressable
              key={tab}
              onPress={() => setFilter(tab)}
              style={[styles.filterPill, isActive && styles.filterPillActive]}
            >
              <Text style={[styles.filterPillText, isActive && styles.filterPillTextActive]}>
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {loading ? (
        <View style={styles.loadingBox}>
          <ActivityIndicator size="large" color={Colors.forest} />
          <Text style={styles.loadingText}>Loading student requests...</Text>
        </View>
      ) : errorMsg && requests.length === 0 ? (
        <Card style={styles.emptyCard}>
          <IconBubble icon={AlertCircle} tone="rose" size={48} />
          <Text style={styles.emptyTitle}>Could Not Load Requests</Text>
          <Text style={styles.emptySub}>{errorMsg}</Text>
          <Button tone="forest" variant="soft" onPress={handleRefresh} style={{ marginTop: 12 }}>
            <Text style={{ color: Colors.forest, fontWeight: '600' }}>Retry</Text>
          </Button>
        </Card>
      ) : filteredRequests.length === 0 ? (
        <Card style={styles.emptyCard}>
          <IconBubble icon={MessageSquare} tone="forest" size={48} />
          <Text style={styles.emptyTitle}>
            {filter === 'PENDING' ? 'No Pending Requests' : 'No Requests Found'}
          </Text>
          <Text style={styles.emptySub}>
            {filter === 'PENDING'
              ? 'All student attendance excuses and correction reports have been resolved.'
              : 'No requests match the selected filter.'}
          </Text>
        </Card>
      ) : (
        <View style={styles.requestList}>
          {filteredRequests.map((req) => {
            const isPending = req.status === 'PENDING' || req.status === 'UNDER_REVIEW';
            const isApproved = req.status === 'APPROVED';
            const isRejected = req.status === 'REJECTED';

            return (
              <Card key={req.id} style={styles.requestCard}>
                <View style={styles.cardHeader}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.subjectName}>{req.subject_name || 'Class Session'}</Text>

                    {/* Student Info */}
                    <View style={styles.studentInfoRow}>
                      <UserIcon size={13} color={Colors.forest} />
                      <Text style={styles.studentNameText}>
                        {req.student_name || 'Student'}
                      </Text>
                      {req.student_institutional_id ? (
                        <Text style={styles.studentIdBadge}>
                          ({req.student_institutional_id})
                        </Text>
                      ) : null}
                    </View>

                    <View style={styles.dateRow}>
                      <Calendar size={13} color={Colors.soft} />
                      <Text style={styles.dateText}>Session Date: {req.session_date}</Text>
                    </View>
                  </View>

                  <Chip
                    tone={isApproved ? 'forest' : isRejected ? 'rose' : 'amber'}
                  >
                    {isPending ? 'Pending' : isApproved ? 'Approved' : 'Rejected'}
                  </Chip>
                </View>

                {/* Student Explanation Note */}
                <View style={styles.noteBox}>
                  <Text style={styles.noteLabel}>Student Explanation:</Text>
                  <Text style={styles.noteText}>"{req.student_note}"</Text>
                </View>

                {/* Resolved History Card Section */}
                {isApproved && (
                  <View style={styles.approvedBox}>
                    <View style={styles.resolutionHeaderRow}>
                      <CheckCircle2 size={15} color={Colors.forest} />
                      <Text style={styles.approvedLabel}>Decision: Approved (Marked Present)</Text>
                    </View>
                    <Text style={styles.resolutionText}>"{req.resolution_note || 'Approved by faculty.'}"</Text>
                    <View style={styles.resolvedMetaRow}>
                      <Text style={styles.adjustedBadge}>✓ Attendance record adjusted to PRESENT</Text>
                      {req.resolved_at && (
                        <Text style={styles.resolvedDateText}>
                          {new Date(req.resolved_at).toLocaleDateString()}
                        </Text>
                      )}
                    </View>
                  </View>
                )}

                {isRejected && (
                  <View style={styles.rejectedBox}>
                    <View style={styles.resolutionHeaderRow}>
                      <XCircle size={15} color={Colors.rose} />
                      <Text style={styles.rejectedLabel}>Decision: Rejected (Absence Maintained)</Text>
                    </View>
                    <Text style={styles.resolutionText}>"{req.resolution_note || 'Absence confirmed.'}"</Text>
                    <View style={styles.resolvedMetaRow}>
                      <Text style={styles.rejectedBadge}>✕ Record remains ABSENT</Text>
                      {req.resolved_at && (
                        <Text style={styles.resolvedDateText}>
                          {new Date(req.resolved_at).toLocaleDateString()}
                        </Text>
                      )}
                    </View>
                  </View>
                )}

                {/* Action buttons for pending requests */}
                {isPending && (
                  <View style={styles.actionRow}>
                    <Button
                      tone="forest"
                      style={styles.actionBtn}
                      onPress={() => openResolveSheet(req, 'APPROVED')}
                    >
                      <View style={styles.btnContent}>
                        <Check size={14} color="#ffffff" />
                        <Text style={styles.btnTextWhite}>Approve Excuse</Text>
                      </View>
                    </Button>

                    <Button
                      tone="rose"
                      variant="soft"
                      style={styles.actionBtn}
                      onPress={() => openResolveSheet(req, 'REJECTED')}
                    >
                      <View style={styles.btnContent}>
                        <X size={14} color={Colors.rose} />
                        <Text style={styles.btnTextRose}>Reject</Text>
                      </View>
                    </Button>
                  </View>
                )}
              </Card>
            );
          })}
        </View>
      )}

      {/* Resolution Confirmation Sheet */}
      <Sheet
        visible={!!selectedRequest}
        onClose={() => !submitting && setSelectedRequest(null)}
      >
        {selectedRequest && (
          <View style={styles.sheetBody}>
            <Text style={styles.sheetTitle}>
              {resolveAction === 'APPROVED' ? 'Approve Attendance Excuse' : 'Reject Request'}
            </Text>
            <Text style={styles.sheetDesc}>
              {resolveAction === 'APPROVED'
                ? `Approving this request will credit attendance for ${selectedRequest.student_name || 'the student'} on ${selectedRequest.session_date} in ${selectedRequest.subject_name || 'the course'} and adjust their record to PRESENT.`
                : `Rejecting this request will keep ${selectedRequest.student_name || 'the student'}'s absence record intact for ${selectedRequest.session_date}.`}
            </Text>

            <Text style={styles.inputLabel}>
              {resolveAction === 'APPROVED' ? 'Approval Resolution Note' : 'Rejection Reason / Statement'}
            </Text>
            <TextInput
              style={styles.noteInput}
              value={resolutionNote}
              onChangeText={setResolutionNote}
              placeholder={
                resolveAction === 'APPROVED'
                  ? 'e.g. Approved after verifying attendance photo roll'
                  : 'e.g. Student confirmed absent; absence record verified accurate'
              }
              placeholderTextColor={Colors.soft}
              multiline
              numberOfLines={3}
              editable={!submitting}
            />

            <View style={styles.sheetBtnRow}>
              <Button
                variant="ghost"
                style={{ flex: 1 }}
                onPress={() => setSelectedRequest(null)}
                disabled={submitting}
              >
                Cancel
              </Button>

              <Button
                tone={resolveAction === 'APPROVED' ? 'forest' : 'rose'}
                style={{ flex: 1 }}
                onPress={handleConfirmResolve}
                disabled={submitting}
              >
                {submitting ? (
                  <ActivityIndicator size="small" color="#ffffff" />
                ) : resolveAction === 'APPROVED' ? (
                  'Confirm Approval'
                ) : (
                  'Confirm Rejection'
                )}
              </Button>
            </View>
          </View>
        )}
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  filterRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  filterPill: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: Radii.pill,
    backgroundColor: '#ffffff',
    borderWidth: 1,
    borderColor: '#e5e7eb',
  },
  filterPillActive: {
    backgroundColor: Colors.forest,
    borderColor: Colors.forest,
  },
  filterPillText: {
    fontSize: 13,
    fontWeight: '500',
    color: Colors.inkSecondary,
  },
  filterPillTextActive: {
    color: '#ffffff',
    fontWeight: '600',
  },
  loadingBox: {
    paddingVertical: 48,
    alignItems: 'center',
    gap: 12,
  },
  loadingText: {
    fontSize: 14,
    color: Colors.soft,
  },
  emptyCard: {
    padding: 32,
    alignItems: 'center',
    textAlign: 'center',
    gap: 12,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: Colors.ink,
  },
  emptySub: {
    fontSize: 13,
    color: Colors.soft,
    textAlign: 'center',
    lineHeight: 18,
  },
  requestList: {
    gap: 12,
    paddingBottom: 40,
  },
  requestCard: {
    padding: 16,
    gap: 12,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  subjectName: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.ink,
  },
  studentInfoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 4,
  },
  studentNameText: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.forest,
  },
  studentIdBadge: {
    fontSize: 12,
    color: Colors.soft,
    fontWeight: '500',
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 4,
  },
  dateText: {
    fontSize: 12,
    color: Colors.soft,
  },
  noteBox: {
    backgroundColor: 'rgba(0, 0, 0, 0.02)',
    padding: 12,
    borderRadius: Radii.md,
    borderLeftWidth: 3,
    borderLeftColor: Colors.primary,
  },
  noteLabel: {
    fontSize: 11,
    fontWeight: '600',
    color: Colors.inkSecondary,
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  noteText: {
    fontSize: 13,
    color: Colors.ink,
    lineHeight: 18,
    fontStyle: 'italic',
  },
  approvedBox: {
    backgroundColor: 'rgba(16, 185, 129, 0.06)',
    padding: 12,
    borderRadius: Radii.md,
    borderLeftWidth: 3,
    borderLeftColor: Colors.forest,
    gap: 6,
  },
  rejectedBox: {
    backgroundColor: 'rgba(239, 68, 68, 0.06)',
    padding: 12,
    borderRadius: Radii.md,
    borderLeftWidth: 3,
    borderLeftColor: Colors.rose,
    gap: 6,
  },
  resolutionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  approvedLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.forest,
  },
  rejectedLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.rose,
  },
  resolutionText: {
    fontSize: 13,
    color: Colors.ink,
    lineHeight: 18,
  },
  resolvedMetaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 2,
  },
  adjustedBadge: {
    fontSize: 11,
    fontWeight: '600',
    color: Colors.forest,
  },
  rejectedBadge: {
    fontSize: 11,
    fontWeight: '600',
    color: Colors.rose,
  },
  resolvedDateText: {
    fontSize: 11,
    color: Colors.soft,
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  actionBtn: {
    flex: 1,
  },
  btnContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  btnTextWhite: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
  },
  btnTextRose: {
    color: Colors.rose,
    fontSize: 13,
    fontWeight: '600',
  },
  sheetBody: {
    gap: 16,
    paddingVertical: 8,
  },
  sheetTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.ink,
  },
  sheetDesc: {
    fontSize: 13,
    color: Colors.inkSecondary,
    lineHeight: 18,
  },
  inputLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.ink,
  },
  noteInput: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: Radii.md,
    padding: 12,
    fontSize: 14,
    color: Colors.ink,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  sheetBtnRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
});
