import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ScrollView,
  Platform,
  ActivityIndicator,
} from 'react-native';
import {
  Search,
  Plus,
  ChevronRight,
  Check,
  Users,
  GraduationCap,
  ShieldCheck,
  UserCheck,
  Briefcase,
} from 'lucide-react-native';

import { Screen, Card, Chip, Avatar, Sheet, Button } from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';
import { API_BASE_URL } from '@/config/api';
import { SessionStore } from '@/storage/sessionStore';

interface Person {
  id: string;
  name: string;
  email: string;
  role: string;
  identifier: string;
  sub: string;
  tag?: string | null;
}

interface FacultyAssignment {
  id: string;
  section_code: string;
  subject_code: string;
  subject_name: string;
}

interface ClassSectionItem {
  id: string;
  section_code: string;
  academic_term_id: string;
}

interface SubjectItem {
  id: string;
  code: string;
  name: string;
}

export default function AdminPeopleScreen() {
  const [who, setWho] = useState<'student' | 'faculty' | 'admin'>('student');
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<Person[]>([]);
  const [loading, setLoading] = useState(false);

  // Sheets
  const [selectedUser, setSelectedUser] = useState<Person | null>(null);
  const [showAddUserSheet, setShowAddUserSheet] = useState(false);
  const [showAssignClassSheet, setShowAssignClassSheet] = useState(false);

  // Add User Form State
  const [newFullName, setNewFullName] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newInstId, setNewInstId] = useState('');
  const [newPassword, setNewPassword] = useState('password');
  const [newRole, setNewRole] = useState<'STUDENT' | 'FACULTY' | 'ADMIN'>('STUDENT');
  const [userError, setUserError] = useState<string | null>(null);
  const [userSubmitting, setUserSubmitting] = useState(false);

  // Role Assignment State
  const [roleUpdating, setRoleUpdating] = useState(false);

  // Faculty Assignments State
  const [facultyAssignments, setFacultyAssignments] = useState<FacultyAssignment[]>([]);
  const [allSections, setAllSections] = useState<ClassSectionItem[]>([]);
  const [allSubjects, setAllSubjects] = useState<SubjectItem[]>([]);
  const [pickedSectionId, setPickedSectionId] = useState('');
  const [pickedSubjectId, setPickedSubjectId] = useState('');
  const [assignError, setAssignError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);

  const loadDirectory = useCallback(async () => {
    setLoading(true);
    const token = SessionStore.getToken();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/users?role=${who}`, { headers });
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setUsers(
            data.map((u: any) => ({
              id: u.id,
              name: u.name,
              email: u.email,
              role: u.role,
              identifier: u.identifier,
              sub: u.subtitle || `${u.role} · ${u.identifier || ''}`,
              tag: u.tag,
            }))
          );
        }
      }
    } catch (e) {
      console.warn('Load directory error:', e);
    } finally {
      setLoading(false);
    }
  }, [who]);

  useEffect(() => {
    loadDirectory();
  }, [loadDirectory]);

  // Load faculty assignments when a user is selected
  const loadFacultyAssignments = async (facultyId: string) => {
    const token = SessionStore.getToken();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/faculty/${facultyId}/assignments`, { headers });
      if (res.ok) {
        const data = await res.json();
        setFacultyAssignments(data);
      } else {
        setFacultyAssignments([]);
      }

      // Also pre-fetch sections and subjects for assignment sheet
      const [secRes, subRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/v1/admin/sections`, { headers }),
        fetch(`${API_BASE_URL}/api/v1/admin/subjects`, { headers }),
      ]);
      if (secRes.ok) {
        const secs = await secRes.json();
        setAllSections(secs);
        if (secs.length > 0 && !pickedSectionId) setPickedSectionId(secs[0].id);
      }
      if (subRes.ok) {
        const subs = await subRes.json();
        setAllSubjects(subs);
        if (subs.length > 0 && !pickedSubjectId) setPickedSubjectId(subs[0].id);
      }
    } catch (e) {
      console.warn('Load faculty assignments error:', e);
    }
  };

  const handleSelectUser = (person: Person) => {
    setSelectedUser(person);
    if (person.role.toUpperCase() === 'FACULTY') {
      loadFacultyAssignments(person.id);
    }
  };

  // Create User
  const handleCreateUser = async () => {
    if (!newFullName.trim() || !newEmail.trim() || !newInstId.trim() || !newPassword.trim()) {
      setUserError('Please fill in all user fields.');
      return;
    }
    setUserSubmitting(true);
    setUserError(null);

    const token = SessionStore.getToken();
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/users`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          full_name: newFullName.trim(),
          email: newEmail.trim().toLowerCase(),
          institutional_id: newInstId.trim(),
          password: newPassword.trim(),
          role: newRole,
        }),
      });

      if (res.ok) {
        setNewFullName('');
        setNewEmail('');
        setNewInstId('');
        setNewPassword('password');
        setShowAddUserSheet(false);
        await loadDirectory();
      } else {
        const err = await res.json();
        setUserError(err.detail || 'Failed to create user');
      }
    } catch (e: any) {
      setUserError(e?.message || 'Network error');
    } finally {
      setUserSubmitting(false);
    }
  };

  // Update Role
  const handleUpdateRole = async (targetRole: 'STUDENT' | 'FACULTY' | 'ADMIN') => {
    if (!selectedUser) return;
    setRoleUpdating(true);
    const token = SessionStore.getToken();

    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/users/${selectedUser.id}/role`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ role: targetRole }),
      });

      if (res.ok) {
        const updated = await res.json();
        setSelectedUser({
          ...selectedUser,
          role: updated.role,
          sub: `${updated.role} · ${selectedUser.identifier}`,
        });
        await loadDirectory();
        if (targetRole === 'FACULTY') {
          loadFacultyAssignments(selectedUser.id);
        }
      }
    } catch (e) {
      console.warn('Update role error:', e);
    } finally {
      setRoleUpdating(false);
    }
  };

  // Assign Class to Faculty
  const handleAssignClassToFaculty = async () => {
    if (!selectedUser || !pickedSectionId || !pickedSubjectId) {
      setAssignError('Please select both a class section and subject.');
      return;
    }
    setAssigning(true);
    setAssignError(null);

    const targetSection = allSections.find((s) => s.id === pickedSectionId);
    const termId = targetSection?.academic_term_id || '0b0487b0-5be5-484f-80c1-8d5e2a0a7c94';
    const token = SessionStore.getToken();

    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/assignments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          faculty_user_id: selectedUser.id,
          class_section_id: pickedSectionId,
          subject_id: pickedSubjectId,
          academic_term_id: termId,
          is_active: true,
        }),
      });

      if (res.ok) {
        setShowAssignClassSheet(false);
        await loadFacultyAssignments(selectedUser.id);
      } else {
        const err = await res.json();
        setAssignError(err.detail || 'Failed to assign class');
      }
    } catch (e: any) {
      setAssignError(e?.message || 'Network error');
    } finally {
      setAssigning(false);
    }
  };

  const filteredList = users.filter(
    (p) =>
      p.name.toLowerCase().includes(query.toLowerCase()) ||
      (p.identifier && p.identifier.toLowerCase().includes(query.toLowerCase()))
  );

  return (
    <Screen
      title="People"
      subtitle="Directory, Roles & Teaching Assignments"
      scrollable
    >
      {/* Segmented Control */}
      <View style={styles.segmentContainer}>
        <Pressable
          onPress={() => setWho('student')}
          style={[styles.segmentButton, who === 'student' && styles.segmentButtonActive]}
        >
          <Text style={[styles.segmentText, who === 'student' && styles.segmentTextActive]}>
            Students
          </Text>
        </Pressable>

        <Pressable
          onPress={() => setWho('faculty')}
          style={[styles.segmentButton, who === 'faculty' && styles.segmentButtonActive]}
        >
          <Text style={[styles.segmentText, who === 'faculty' && styles.segmentTextActive]}>
            Faculty
          </Text>
        </Pressable>

        <Pressable
          onPress={() => setWho('admin')}
          style={[styles.segmentButton, who === 'admin' && styles.segmentButtonActive]}
        >
          <Text style={[styles.segmentText, who === 'admin' && styles.segmentTextActive]}>
            Admins
          </Text>
        </Pressable>
      </View>

      {/* Search & Add User Row */}
      <View style={styles.searchRow}>
        <View style={styles.searchBox}>
          <Search size={18} color={Colors.soft} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={`Search ${who}s…`}
            placeholderTextColor={Colors.soft}
            style={styles.searchInput}
          />
        </View>
        <Pressable
          onPress={() => {
            setUserError(null);
            setShowAddUserSheet(true);
          }}
          style={styles.addUserButton}
          accessibilityLabel="Add user"
        >
          <Plus size={20} color="#ffffff" />
        </Pressable>
      </View>

      {/* Directory List */}
      <Card style={styles.listCard}>
        {loading ? (
          <ActivityIndicator color={Colors.forest} style={{ paddingVertical: 20 }} />
        ) : filteredList.length > 0 ? (
          filteredList.map((person, index) => (
            <View key={person.id}>
              {index > 0 && <View style={styles.divider} />}
              <Pressable
                onPress={() => handleSelectUser(person)}
                style={({ pressed }) => [
                  styles.personRow,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Avatar name={person.name} userId={person.id} size={40} />
                <View style={styles.personTextCol}>
                  <Text style={styles.personName}>{person.name}</Text>
                  <Text style={styles.personSub}>{person.sub}</Text>
                </View>
                <Chip tone={person.role.toUpperCase() === 'ADMIN' ? 'forest' : person.role.toUpperCase() === 'FACULTY' ? 'lilac' : 'soft'}>
                  {person.role}
                </Chip>
                <ChevronRight size={16} color={Colors.soft} />
              </Pressable>
            </View>
          ))
        ) : (
          <Text style={styles.emptyText}>No users found in this category.</Text>
        )}
      </Card>

      {/* --- SHEET: ADD USER --- */}
      <Sheet visible={showAddUserSheet} onClose={() => setShowAddUserSheet(false)}>
        <Text style={styles.sheetTitle}>Create New User</Text>
        <Text style={styles.sheetSub}>Add a student, faculty member, or institutional administrator</Text>

        {userError && <Text style={styles.errorBanner}>{userError}</Text>}

        <Text style={styles.inputLabel}>Full Name</Text>
        <TextInput
          value={newFullName}
          onChangeText={setNewFullName}
          placeholder="e.g. Diya Patel"
          placeholderTextColor={Colors.soft}
          style={styles.textInput}
        />

        <Text style={styles.inputLabel}>Email Address</Text>
        <TextInput
          value={newEmail}
          onChangeText={setNewEmail}
          placeholder="e.g. diya.patel@attendly.edu"
          placeholderTextColor={Colors.soft}
          keyboardType="email-address"
          autoCapitalize="none"
          style={styles.textInput}
        />

        <Text style={styles.inputLabel}>Institutional Identifier / Roll Number</Text>
        <TextInput
          value={newInstId}
          onChangeText={setNewInstId}
          placeholder="e.g. 21CS042 or FAC-088"
          placeholderTextColor={Colors.soft}
          autoCapitalize="characters"
          style={styles.textInput}
        />

        <Text style={styles.inputLabel}>Initial Password</Text>
        <TextInput
          value={newPassword}
          onChangeText={setNewPassword}
          placeholder="password"
          placeholderTextColor={Colors.soft}
          secureTextEntry
          style={styles.textInput}
        />

        <Text style={styles.inputLabel}>Role</Text>
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
          {(['STUDENT', 'FACULTY', 'ADMIN'] as const).map((r) => (
            <Pressable
              key={r}
              onPress={() => setNewRole(r)}
              style={[
                styles.roleSelectChip,
                newRole === r && styles.roleSelectChipActive,
              ]}
            >
              <Text
                style={[
                  styles.roleSelectChipText,
                  newRole === r && styles.roleSelectChipTextActive,
                ]}
              >
                {r}
              </Text>
            </Pressable>
          ))}
        </View>

        <Button
          tone="forest"
          disabled={userSubmitting}
          onPress={handleCreateUser}
        >
          {userSubmitting ? 'Creating User…' : 'Create User'}
        </Button>
      </Sheet>

      {/* --- SHEET: USER DETAILS & ROLE ASSIGNMENT --- */}
      {selectedUser && (
        <Sheet visible={!!selectedUser} onClose={() => setSelectedUser(null)}>
          <View style={styles.sheetHeader}>
            <Avatar name={selectedUser.name} userId={selectedUser.id} size={50} />
            <View style={styles.sheetHeaderCol}>
              <Text style={styles.sheetFacultyName}>{selectedUser.name}</Text>
              <Text style={styles.sheetFacultyDept}>
                {selectedUser.email} · {selectedUser.identifier}
              </Text>
            </View>
          </View>

          {/* Role Switcher */}
          <Text style={styles.sheetSectionTitle}>Assign Role</Text>
          <View style={styles.roleAssignmentRow}>
            {(['STUDENT', 'FACULTY', 'ADMIN'] as const).map((roleOption) => {
              const isCurrent = selectedUser.role.toUpperCase() === roleOption;
              return (
                <Pressable
                  key={roleOption}
                  disabled={roleUpdating || isCurrent}
                  onPress={() => handleUpdateRole(roleOption)}
                  style={[
                    styles.roleAssignBtn,
                    isCurrent && styles.roleAssignBtnActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.roleAssignBtnText,
                      isCurrent && styles.roleAssignBtnTextActive,
                    ]}
                  >
                    {isCurrent ? `✓ ${roleOption}` : roleOption}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* If Faculty: Teaching Assignments */}
          {selectedUser.role.toUpperCase() === 'FACULTY' && (
            <>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
                <Text style={styles.sheetSectionTitle}>Classes they can take attendance for</Text>
                <Pressable
                  onPress={() => {
                    setAssignError(null);
                    setShowAssignClassSheet(true);
                  }}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
                >
                  <Plus size={14} color={Colors.forest} />
                  <Text style={{ fontSize: 12, fontWeight: '700', color: Colors.forest }}>Assign Class</Text>
                </Pressable>
              </View>

              <View style={styles.assignedClassesList}>
                {facultyAssignments.length > 0 ? (
                  facultyAssignments.map((a) => (
                    <View key={a.id} style={styles.assignedClassRow}>
                      <View>
                        <Text style={styles.assignedClassText}>
                          {a.subject_code} · {a.subject_name}
                        </Text>
                        <Text style={{ fontSize: 11, color: Colors.soft }}>
                          Section: {a.section_code}
                        </Text>
                      </View>
                      <Check size={18} color={Colors.forest} strokeWidth={2.5} />
                    </View>
                  ))
                ) : (
                  <Text style={{ fontSize: 12, color: Colors.soft, marginVertical: 8 }}>
                    No classes assigned yet. Tap "+ Assign Class" to assign teaching responsibilities.
                  </Text>
                )}
              </View>
            </>
          )}

          <View style={{ marginTop: 24 }}>
            <Button tone="soft" onPress={() => setSelectedUser(null)}>
              Close
            </Button>
          </View>
        </Sheet>
      )}

      {/* --- SUB-SHEET: ASSIGN CLASS TO FACULTY --- */}
      <Sheet visible={showAssignClassSheet} onClose={() => setShowAssignClassSheet(false)}>
        <Text style={styles.sheetTitle}>Assign Class Section</Text>
        <Text style={styles.sheetSub}>
          Assign {selectedUser?.name} to take attendance for a class
        </Text>

        {assignError && <Text style={styles.errorBanner}>{assignError}</Text>}

        <Text style={styles.inputLabel}>Select Class Section</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {allSections.map((s) => (
              <Pressable
                key={s.id}
                onPress={() => setPickedSectionId(s.id)}
                style={[
                  styles.pickerChip,
                  pickedSectionId === s.id && styles.pickerChipActive,
                ]}
              >
                <Text style={[styles.pickerChipText, pickedSectionId === s.id && styles.pickerChipTextActive]}>
                  {s.section_code}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        <Text style={styles.inputLabel}>Select Subject</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {allSubjects.map((sub) => (
              <Pressable
                key={sub.id}
                onPress={() => setPickedSubjectId(sub.id)}
                style={[
                  styles.pickerChip,
                  pickedSubjectId === sub.id && styles.pickerChipActive,
                ]}
              >
                <Text style={[styles.pickerChipText, pickedSubjectId === sub.id && styles.pickerChipTextActive]}>
                  {sub.code} · {sub.name}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        <View style={{ marginTop: 20 }}>
          <Button
            tone="forest"
            disabled={assigning}
            onPress={handleAssignClassToFaculty}
          >
            {assigning ? 'Assigning…' : 'Confirm Assignment'}
          </Button>
        </View>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  segmentContainer: {
    flexDirection: 'row',
    backgroundColor: Colors.line,
    borderRadius: Radii.button,
    padding: 4,
    marginBottom: 12,
  },
  segmentButton: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: Radii.button - 4,
  },
  segmentButtonActive: {
    backgroundColor: Colors.card,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 1 },
        shadowOpacity: 0.1,
        shadowRadius: 2,
      },
      android: {
        elevation: 2,
      },
    }),
  },
  segmentText: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.soft,
  },
  segmentTextActive: {
    color: Colors.ink,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
  },
  searchBox: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.card,
    borderRadius: Radii.button,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: Colors.line,
  },
  searchInput: {
    flex: 1,
    paddingVertical: 12,
    fontSize: 14,
    color: Colors.ink,
  },
  addUserButton: {
    width: 44,
    height: 44,
    borderRadius: Radii.button,
    backgroundColor: Colors.forest,
    alignItems: 'center',
    justifyContent: 'center',
  },
  listCard: {
    padding: 12,
    marginBottom: 20,
  },
  personRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 4,
  },
  personTextCol: {
    flex: 1,
  },
  personName: {
    fontSize: 14,
    fontWeight: '600',
    color: Colors.ink,
  },
  personSub: {
    fontSize: 11,
    color: Colors.soft,
    marginTop: 2,
  },
  divider: {
    height: 1,
    backgroundColor: Colors.line,
    marginVertical: 10,
  },
  emptyText: {
    textAlign: 'center',
    fontSize: 13,
    color: Colors.soft,
    paddingVertical: 16,
  },
  sheetTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.ink,
    marginBottom: 4,
  },
  sheetSub: {
    fontSize: 12,
    color: Colors.soft,
    marginBottom: 16,
  },
  errorBanner: {
    backgroundColor: '#fff5f5',
    color: Colors.rose,
    fontSize: 12,
    padding: 8,
    borderRadius: 6,
    marginBottom: 12,
  },
  inputLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.ink,
    marginBottom: 6,
    marginTop: 6,
  },
  textInput: {
    backgroundColor: Colors.card,
    borderRadius: Radii.button,
    borderWidth: 1,
    borderColor: Colors.line,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    color: Colors.ink,
    marginBottom: 10,
  },
  roleSelectChip: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: 8,
    backgroundColor: Colors.line,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  roleSelectChipActive: {
    backgroundColor: Colors.forest50,
    borderColor: Colors.forest,
  },
  roleSelectChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.soft,
  },
  roleSelectChipTextActive: {
    color: Colors.forest,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16,
  },
  sheetHeaderCol: {
    flex: 1,
  },
  sheetFacultyName: {
    fontSize: 18,
    fontWeight: '700',
    color: Colors.ink,
  },
  sheetFacultyDept: {
    fontSize: 13,
    color: Colors.soft,
    marginTop: 2,
  },
  sheetSectionTitle: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.soft,
    marginBottom: 8,
  },
  roleAssignmentRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  roleAssignBtn: {
    flex: 1,
    paddingVertical: 10,
    alignItems: 'center',
    borderRadius: 8,
    backgroundColor: Colors.line,
  },
  roleAssignBtnActive: {
    backgroundColor: Colors.forest50,
    borderWidth: 1.5,
    borderColor: Colors.forest,
  },
  roleAssignBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.soft,
  },
  roleAssignBtnTextActive: {
    color: Colors.forest,
    fontWeight: '700',
  },
  assignedClassesList: {
    gap: 8,
    marginTop: 6,
  },
  assignedClassRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: Colors.line,
  },
  assignedClassText: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.ink,
  },
  pickerChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: Colors.line,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  pickerChipActive: {
    backgroundColor: Colors.forest50,
    borderColor: Colors.forest,
  },
  pickerChipText: {
    fontSize: 12,
    color: Colors.ink,
  },
  pickerChipTextActive: {
    color: Colors.forest,
    fontWeight: '700',
  },
});
