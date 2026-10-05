import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  Plus,
  Calendar,
  Clock,
  AlertCircle,
  Check,
  ShieldCheck,
  UserCheck,
  X,
} from 'lucide-react-native';

import {
  Screen,
  Card,
  Button,
  SectionTitle,
  Chip,
  Avatar,
  IconBubble,
  Sheet,
} from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';

interface DelegationItem {
  id: string;
  assignmentId: string;
  subjectName: string;
  sectionCode: string;
  substituteFacultyName: string;
  substituteFacultyId: string;
  startDate: string;
  endDate: string;
  reason: string;
  status: 'ACTIVE' | 'EXPIRED' | 'REVOKED';
}

const DEMO_COLLEAGUES = [
  { id: 'fac-b', name: 'Prof. Rahul Menon', dept: 'Computer Science', staffId: 'FAC-0143' },
  { id: 'fac-c', name: 'Dr. Fatima Khan', dept: 'Mathematics', staffId: 'FAC-0089' },
  { id: 'fac-d', name: 'Prof. Daniel Joseph', dept: 'Electronics', staffId: 'FAC-0199' },
];

const DEMO_ASSIGNMENTS = [
  { id: 'a1', subject: 'Data Structures', section: 'CSE 3A' },
  { id: 'a2', subject: 'Operating Systems', section: 'CSE 3B' },
];

const INITIAL_DELEGATIONS: DelegationItem[] = [
  {
    id: 'del-1',
    assignmentId: 'a1',
    subjectName: 'Data Structures',
    sectionCode: 'CSE 3A',
    substituteFacultyName: 'Prof. Rahul Menon',
    substituteFacultyId: 'FAC-0143',
    startDate: '2026-10-05',
    endDate: '2026-10-07',
    reason: 'Attending IEEE international research symposium',
    status: 'ACTIVE',
  },
];

export default function DelegationsScreen() {
  const router = useRouter();
  const [delegations, setDelegations] = useState<DelegationItem[]>(INITIAL_DELEGATIONS);
  const [newSheetVisible, setNewSheetVisible] = useState(false);
  const [revokeSheetTarget, setRevokeSheetTarget] = useState<DelegationItem | null>(null);

  // Form State
  const [selectedAssignment, setSelectedAssignment] = useState(DEMO_ASSIGNMENTS[0]);
  const [selectedColleague, setSelectedColleague] = useState(DEMO_COLLEAGUES[0]);
  const [startDate, setStartDate] = useState('2026-10-08');
  const [endDate, setEndDate] = useState('2026-10-10');
  const [reason, setReason] = useState('');
  const [revocationReason, setRevocationReason] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const activeDelegations = delegations.filter((d) => d.status === 'ACTIVE');

  const handleCreateDelegation = () => {
    if (reason.trim().length < 5) {
      setErrorMessage('Please provide a justification of at least 5 characters.');
      return;
    }
    if (endDate < startDate) {
      setErrorMessage('End date must be on or after start date.');
      return;
    }

    const newDel: DelegationItem = {
      id: `del-${Date.now()}`,
      assignmentId: selectedAssignment.id,
      subjectName: selectedAssignment.subject,
      sectionCode: selectedAssignment.section,
      substituteFacultyName: selectedColleague.name,
      substituteFacultyId: selectedColleague.staffId,
      startDate,
      endDate,
      reason: reason.trim(),
      status: 'ACTIVE',
    };

    setDelegations([newDel, ...delegations]);
    setNewSheetVisible(false);
    setReason('');
    setErrorMessage(null);
  };

  const handleRevokeDelegation = () => {
    if (!revokeSheetTarget) return;

    setDelegations((prev) =>
      prev.map((d) =>
        d.id === revokeSheetTarget.id
          ? { ...d, status: 'REVOKED' as const }
          : d
      )
    );
    setRevokeSheetTarget(null);
    setRevocationReason('');
  };

  return (
    <Screen
      onBack={() => router.back()}
      subtitle="Temporary course delegation"
      title="Substitute Faculty"
    >
      {/* Notice Banner */}
      <Card style={styles.infoCard}>
        <View style={styles.infoRow}>
          <IconBubble icon={ShieldCheck} tone="forest" size={38} />
          <View style={styles.infoContent}>
            <Text style={styles.infoTitle}>Direct Faculty Delegation</Text>
            <Text style={styles.infoDesc}>
              Granted delegations activate immediately without pre-approval. Both you and the substitute will be recorded in attendance provenance.
            </Text>
          </View>
        </View>
      </Card>

      <Button
        variant="primary"
        style={styles.addButton}
        icon={<Plus size={19} color="#ffffff" />}
        onPress={() => {
          setErrorMessage(null);
          setNewSheetVisible(true);
        }}
      >
        Delegate a course
      </Button>

      <SectionTitle>Active delegations</SectionTitle>

      {activeDelegations.length === 0 ? (
        <View style={styles.emptyCard}>
          <IconBubble icon={UserCheck} tone="soft" size={44} />
          <Text style={styles.emptyTitle}>No active delegations</Text>
          <Text style={styles.emptySubtitle}>
            When you delegate class authority to a colleague, it will appear here.
          </Text>
        </View>
      ) : (
        <View style={styles.delegationsList}>
          {activeDelegations.map((d) => (
            <Card key={d.id} style={styles.delegationCard}>
              <View style={styles.cardHeader}>
                <View>
                  <Text style={styles.courseTitle}>{d.subjectName}</Text>
                  <Text style={styles.sectionSubtitle}>{d.sectionCode}</Text>
                </View>
                <Chip tone="forest">Active</Chip>
              </View>

              <View style={styles.colleagueRow}>
                <Avatar name={d.substituteFacultyName} size={36} />
                <View style={styles.colleagueInfo}>
                  <Text style={styles.colleagueName}>{d.substituteFacultyName}</Text>
                  <Text style={styles.colleagueId}>{d.substituteFacultyId}</Text>
                </View>
              </View>

              <View style={styles.dateRow}>
                <Calendar size={14} color={Colors.soft} />
                <Text style={styles.dateText}>
                  Valid: {d.startDate} to {d.endDate}
                </Text>
              </View>

              <Text style={styles.reasonText}>"{d.reason}"</Text>

              <Pressable
                style={styles.revokeButton}
                onPress={() => setRevokeSheetTarget(d)}
              >
                <Text style={styles.revokeButtonText}>Revoke delegation</Text>
              </Pressable>
            </Card>
          ))}
        </View>
      )}

      {/* Sheet: Create Delegation */}
      <Sheet
        visible={newSheetVisible}
        onClose={() => setNewSheetVisible(false)}
      >
        <Text style={styles.sheetTitle}>Delegate a course</Text>
        <Text style={styles.sheetSubtitle}>
          Grant temporary attendance conduct authority to a colleague.
        </Text>

        {errorMessage && (
          <View style={styles.errorBanner}>
            <AlertCircle size={16} color={Colors.rose} />
            <Text style={styles.errorText}>{errorMessage}</Text>
          </View>
        )}

        <Text style={styles.fieldLabel}>Select offering</Text>
        <View style={styles.pillsRow}>
          {DEMO_ASSIGNMENTS.map((a) => {
            const isSelected = selectedAssignment.id === a.id;
            return (
              <Pressable
                key={a.id}
                onPress={() => setSelectedAssignment(a)}
                style={[
                  styles.pill,
                  isSelected ? styles.pillSelected : styles.pillUnselected,
                ]}
              >
                <Text
                  style={[
                    styles.pillText,
                    isSelected ? styles.pillTextSelected : styles.pillTextUnselected,
                  ]}
                >
                  {a.subject} ({a.section})
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.fieldLabel}>Select faculty colleague</Text>
        <View style={styles.colleagueSelectCard}>
          {DEMO_COLLEAGUES.map((c) => {
            const isSelected = selectedColleague.id === c.id;
            return (
              <Pressable
                key={c.id}
                onPress={() => setSelectedColleague(c)}
                style={[
                  styles.colleagueOption,
                  isSelected && styles.colleagueOptionSelected,
                ]}
              >
                <Avatar name={c.name} size={32} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.colleagueOptionName}>{c.name}</Text>
                  <Text style={styles.colleagueOptionDept}>{c.dept}</Text>
                </View>
                {isSelected && <Check size={18} color={Colors.forest} />}
              </Pressable>
            );
          })}
        </View>

        <Text style={styles.fieldLabel}>Delegation Date Range (YYYY-MM-DD)</Text>
        <View style={styles.datesInputRow}>
          <TextInput
            style={styles.dateInput}
            value={startDate}
            onChangeText={setStartDate}
            placeholder="Start date"
          />
          <Text style={{ color: Colors.soft }}>to</Text>
          <TextInput
            style={styles.dateInput}
            value={endDate}
            onChangeText={setEndDate}
            placeholder="End date"
          />
        </View>

        <Text style={styles.fieldLabel}>Justification / Reason (Required)</Text>
        <TextInput
          style={styles.reasonInput}
          multiline
          numberOfLines={3}
          value={reason}
          onChangeText={setReason}
          placeholder="e.g. Attending international conference on data engineering"
          placeholderTextColor={Colors.soft}
        />

        <Button
          variant="primary"
          style={{ marginTop: 16 }}
          onPress={handleCreateDelegation}
        >
          Grant temporary delegation
        </Button>
      </Sheet>

      {/* Sheet: Early Revocation Confirmation */}
      <Sheet
        visible={revokeSheetTarget !== null}
        onClose={() => setRevokeSheetTarget(null)}
      >
        <Text style={styles.sheetTitle}>Revoke delegation?</Text>
        <Text style={styles.sheetSubtitle}>
          Immediate revocation will restore sole attendance conduct authority to you.
        </Text>

        <TextInput
          style={[styles.reasonInput, { marginTop: 12 }]}
          multiline
          numberOfLines={2}
          value={revocationReason}
          onChangeText={setRevocationReason}
          placeholder="Reason for early revocation (e.g. Returned early)"
          placeholderTextColor={Colors.soft}
        />

        <Button
          variant="primary"
          style={{ marginTop: 16, backgroundColor: Colors.rose }}
          onPress={handleRevokeDelegation}
        >
          Yes, revoke delegation
        </Button>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  infoCard: {
    backgroundColor: Colors.forest50,
    marginBottom: 12,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  infoContent: {
    flex: 1,
  },
  infoTitle: {
    fontSize: 14,
    fontWeight: '700',
    color: Colors.forest,
    marginBottom: 3,
  },
  infoDesc: {
    fontSize: 12,
    color: Colors.ink,
    lineHeight: 16,
  },
  addButton: {
    marginBottom: 8,
  },
  emptyCard: {
    backgroundColor: Colors.card,
    borderRadius: Radii.card,
    padding: 32,
    alignItems: 'center',
    gap: 8,
  },
  emptyTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: Colors.ink,
  },
  emptySubtitle: {
    fontSize: 13,
    color: Colors.soft,
    textAlign: 'center',
    lineHeight: 18,
  },
  delegationsList: {
    gap: 12,
  },
  delegationCard: {
    padding: 16,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 10,
  },
  courseTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.ink,
  },
  sectionSubtitle: {
    fontSize: 13,
    color: Colors.soft,
    marginTop: 1,
  },
  colleagueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: Colors.cream,
    padding: 10,
    borderRadius: 16,
    marginBottom: 10,
  },
  colleagueInfo: {
    flex: 1,
  },
  colleagueName: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.ink,
  },
  colleagueId: {
    fontSize: 12,
    color: Colors.soft,
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  dateText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.ink,
  },
  reasonText: {
    fontSize: 13,
    color: Colors.soft,
    fontStyle: 'italic',
    marginBottom: 10,
  },
  revokeButton: {
    alignSelf: 'flex-end',
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  revokeButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.rose,
  },
  sheetTitle: {
    fontSize: 22,
    fontWeight: '700',
    color: Colors.ink,
  },
  sheetSubtitle: {
    fontSize: 13,
    color: Colors.soft,
    marginTop: 2,
    marginBottom: 12,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.rose50,
    padding: 10,
    borderRadius: 12,
    marginBottom: 12,
  },
  errorText: {
    fontSize: 12,
    color: Colors.rose,
    fontWeight: '600',
    flex: 1,
  },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.soft,
    marginTop: 10,
    marginBottom: 6,
    textTransform: 'uppercase',
  },
  pillsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 6,
  },
  pill: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
  },
  pillSelected: {
    backgroundColor: Colors.forest,
  },
  pillUnselected: {
    backgroundColor: Colors.cream,
  },
  pillText: {
    fontSize: 13,
    fontWeight: '600',
  },
  pillTextSelected: {
    color: '#ffffff',
  },
  pillTextUnselected: {
    color: Colors.ink,
  },
  colleagueSelectCard: {
    backgroundColor: Colors.cream,
    borderRadius: 16,
    overflow: 'hidden',
  },
  colleagueOption: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    padding: 10,
    borderBottomWidth: 1,
    borderBottomColor: Colors.line,
  },
  colleagueOptionSelected: {
    backgroundColor: '#ffffff',
  },
  colleagueOptionName: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.ink,
  },
  colleagueOptionDept: {
    fontSize: 11,
    color: Colors.soft,
  },
  datesInputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 6,
  },
  dateInput: {
    flex: 1,
    backgroundColor: Colors.cream,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 13,
    color: Colors.ink,
  },
  reasonInput: {
    backgroundColor: Colors.cream,
    borderRadius: 14,
    padding: 12,
    fontSize: 13,
    color: Colors.ink,
    textAlignVertical: 'top',
  },
});
