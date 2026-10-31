import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ScrollView,
} from 'react-native';
import {
  Plus,
  Lock,
  ChevronRight,
  Clock,
  CheckCircle2,
  AlertCircle,
  FileText,
} from 'lucide-react-native';

import {
  Screen,
  Card,
  Chip,
  Button,
  SectionTitle,
  Sheet,
} from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';
import {
  RequestRepository,
  CachedStudentRequest,
  RequestState,
} from '@/storage/requestRepository';
import { API_BASE_URL } from '@/config/api';

const DEFAULT_SUBJECTS = [
  { id: 'ta-01', name: 'Data Structures' },
  { id: 'ta-02', name: 'Operating Systems' },
  { id: 'ta-03', name: 'Computer Networks' },
];

const INITIAL_REQUESTS: CachedStudentRequest[] = [
  {
    id: 'r1',
    studentUserId: 'stu-aarav-21cs037',
    teachingAssignmentId: 'ta-02',
    subjectName: 'Operating Systems',
    sessionDate: 'Mon, 29 Sep',
    studentNote: 'I was present — sat in the back row.',
    status: 'Being reviewed',
    createdAt: new Date(Date.now() - 86400000).toISOString(),
  },
];

export default function StudentRequestsScreen() {
  const [requests, setRequests] = useState<CachedStudentRequest[]>(INITIAL_REQUESTS);
  const [sheetVisible, setSheetVisible] = useState(false);
  const [selectedSubject, setSelectedSubject] = useState(DEFAULT_SUBJECTS[1]);
  const [selectedDate, setSelectedDate] = useState('Thu, 2 Oct');
  const [noteText, setNoteText] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    async function loadRequests() {
      try {
        const cached = await RequestRepository.getRequests('stu-aarav-21cs037');
        if (cached.length > 0) {
          setRequests(cached);
        } else {
          await RequestRepository.saveRequests(INITIAL_REQUESTS);
        }

        // Try syncing from backend
        const res = await fetch(`${API_BASE_URL}/api/v1/student/requests`, {
          headers: { Accept: 'application/json' },
        });
        if (res.ok) {
          const live = await res.json();
          if (Array.isArray(live) && live.length > 0) {
            const mapped: CachedStudentRequest[] = live.map((r: any) => ({
              id: r.id,
              studentUserId: r.student_user_id,
              teachingAssignmentId: r.teaching_assignment_id,
              subjectName: r.subject_name || 'Subject',
              sessionDate: r.session_date,
              studentNote: r.student_note,
              status:
                r.status === 'APPROVED'
                  ? 'Accepted'
                  : r.status === 'REJECTED'
                  ? 'Not accepted'
                  : r.status === 'UNDER_REVIEW'
                  ? 'Being reviewed'
                  : 'Sent',
              resolutionNote: r.resolution_note,
              createdAt: r.created_at,
            }));
            setRequests(mapped);
            await RequestRepository.saveRequests(mapped);
          }
        }
      } catch {
        // Fallback to local SQLite cache
      }
    }
    loadRequests();
  }, []);

  const handleSendRequest = async () => {
    if (!noteText.trim()) return;
    setSubmitting(true);

    try {
      const created = await RequestRepository.createRequest({
        studentUserId: 'stu-aarav-21cs037',
        teachingAssignmentId: selectedSubject.id,
        subjectName: selectedSubject.name,
        sessionDate: selectedDate,
        studentNote: noteText.trim(),
      });

      setRequests((prev) => [created, ...prev]);
      setNoteText('');
      setSheetVisible(false);

      // Attempt background dispatch to backend if available
      try {
        await fetch(`${API_BASE_URL}/api/v1/student/requests`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            teaching_assignment_id: selectedSubject.id,
            session_date: '2026-10-02',
            student_note: noteText.trim(),
          }),
        });
      } catch {
        // Retains local SQLite copy
      }
    } finally {
      setSubmitting(false);
    }
  };

  const getTimelineStepIndex = (status: RequestState): number => {
    switch (status) {
      case 'Sent':
        return 0;
      case 'Being reviewed':
        return 1;
      case 'Accepted':
      case 'Not accepted':
        return 2;
    }
  };

  const getStatusTone = (status: RequestState) => {
    switch (status) {
      case 'Accepted':
        return 'forest';
      case 'Not accepted':
        return 'rose';
      case 'Being reviewed':
        return 'amber';
      default:
        return 'soft';
    }
  };

  return (
    <Screen
      title="Requests"
      subtitle="Think your attendance is wrong? Tell us."
      scrollable
    >
      <Button onPress={() => setSheetVisible(true)} style={styles.reportButton}>
        <Plus size={18} color="#ffffff" />
        <Text style={styles.buttonLabel}>Report a mistake</Text>
      </Button>

      <SectionTitle>Your requests</SectionTitle>

      <View style={styles.requestsList}>
        {requests.map((r) => {
          const stepIndex = getTimelineStepIndex(r.status);
          const tone = getStatusTone(r.status);

          return (
            <Card key={r.id} style={styles.requestCard}>
              <View style={styles.requestHeader}>
                <View>
                  <Text style={styles.requestSubject}>{r.subjectName}</Text>
                  <Text style={styles.requestDate}>{r.sessionDate}</Text>
                </View>
                <Chip tone={tone}>{r.status}</Chip>
              </View>

              <Text style={styles.requestNote}>"{r.studentNote}"</Text>

              {r.resolutionNote && (
                <View style={styles.resolutionBox}>
                  <Text style={styles.resolutionTitle}>Faculty Review:</Text>
                  <Text style={styles.resolutionNote}>{r.resolutionNote}</Text>
                </View>
              )}

              {/* 3-Step Timeline Tracker */}
              <View style={styles.timelineRow}>
                {['Sent', 'Being reviewed', 'Decision'].map((label, i) => {
                  const isActive = i <= stepIndex;
                  return (
                    <View key={label} style={styles.timelineCol}>
                      <View
                        style={[
                          styles.timelineBar,
                          isActive && styles.timelineBarActive,
                        ]}
                      />
                      <Text
                        style={[
                          styles.timelineLabel,
                          isActive && styles.timelineLabelActive,
                        ]}
                      >
                        {label}
                      </Text>
                    </View>
                  );
                })}
              </View>
            </Card>
          );
        })}
      </View>

      <View style={styles.footerNote}>
        <Lock size={12} color={Colors.soft} />
        <Text style={styles.footerNoteText}>
          Only your teacher can change attendance.
        </Text>
      </View>

      {/* Report Mistake Sheet */}
      <Sheet visible={sheetVisible} onClose={() => setSheetVisible(false)}>
        <Text style={styles.sheetTitle}>Report a mistake</Text>
        <Text style={styles.sheetSubtitle}>Your teacher will look into it.</Text>

        <Text style={styles.inputLabel}>Subject</Text>
        <View style={styles.chipsRow}>
          {DEFAULT_SUBJECTS.map((s) => (
            <Pressable
              key={s.id}
              onPress={() => setSelectedSubject(s)}
              style={[
                styles.subjectChip,
                selectedSubject.id === s.id && styles.subjectChipActive,
              ]}
            >
              <Text
                style={[
                  styles.subjectChipText,
                  selectedSubject.id === s.id && styles.subjectChipTextActive,
                ]}
              >
                {s.name}
              </Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.inputLabel}>Which day?</Text>
        <View style={styles.chipsRow}>
          {['Wed, 1 Oct', 'Thu, 2 Oct', 'Fri, 3 Oct'].map((d) => (
            <Pressable
              key={d}
              onPress={() => setSelectedDate(d)}
              style={[
                styles.subjectChip,
                selectedDate === d && styles.subjectChipActive,
              ]}
            >
              <Text
                style={[
                  styles.subjectChipText,
                  selectedDate === d && styles.subjectChipTextActive,
                ]}
              >
                {d}
              </Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.inputLabel}>What happened?</Text>
        <TextInput
          value={noteText}
          onChangeText={setNoteText}
          placeholder="e.g. I was there in the back row but wasn't marked."
          placeholderTextColor={Colors.soft}
          multiline
          numberOfLines={3}
          style={styles.textInput}
        />

        <Button
          onPress={handleSendRequest}
          disabled={!noteText.trim() || submitting}
          style={styles.submitButton}
        >
          <Text style={styles.buttonLabel}>Send request</Text>
        </Button>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  reportButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 8,
  },
  buttonLabel: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '600',
  },
  requestsList: {
    gap: 12,
  },
  requestCard: {
    padding: 16,
  },
  requestHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  requestSubject: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.ink,
  },
  requestDate: {
    fontSize: 12,
    color: Colors.soft,
    marginTop: 2,
  },
  requestNote: {
    fontSize: 13,
    color: Colors.ink,
    fontStyle: 'italic',
    marginTop: 8,
  },
  resolutionBox: {
    backgroundColor: Colors.forest50,
    borderRadius: Radii.button,
    padding: 10,
    marginTop: 10,
  },
  resolutionTitle: {
    fontSize: 11,
    fontWeight: '700',
    color: Colors.forest,
  },
  resolutionNote: {
    fontSize: 12,
    color: Colors.ink,
    marginTop: 2,
  },
  timelineRow: {
    flexDirection: 'row',
    gap: 6,
    marginTop: 16,
  },
  timelineCol: {
    flex: 1,
  },
  timelineBar: {
    height: 6,
    borderRadius: 3,
    backgroundColor: Colors.line,
  },
  timelineBarActive: {
    backgroundColor: Colors.forest,
  },
  timelineLabel: {
    fontSize: 10,
    color: Colors.soft,
    marginTop: 4,
  },
  timelineLabelActive: {
    color: Colors.ink,
    fontWeight: '600',
  },
  footerNote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 24,
    marginBottom: 20,
  },
  footerNoteText: {
    fontSize: 12,
    color: Colors.soft,
  },
  sheetTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: Colors.ink,
  },
  sheetSubtitle: {
    fontSize: 13,
    color: Colors.soft,
    marginTop: 4,
    marginBottom: 16,
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.soft,
    marginTop: 10,
    marginBottom: 6,
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  subjectChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: Colors.cream,
    borderWidth: 1,
    borderColor: Colors.line,
  },
  subjectChipActive: {
    backgroundColor: Colors.forest,
    borderColor: Colors.forest,
  },
  subjectChipText: {
    fontSize: 13,
    color: Colors.ink,
  },
  subjectChipTextActive: {
    color: '#ffffff',
    fontWeight: '600',
  },
  textInput: {
    backgroundColor: Colors.cream,
    borderRadius: Radii.button,
    padding: 12,
    fontSize: 13,
    color: Colors.ink,
    borderWidth: 1,
    borderColor: Colors.line,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  submitButton: {
    marginTop: 20,
  },
});
