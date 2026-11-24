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
  ShieldAlert,
  Key,
  Clock,
  FileText,
  CheckCircle2,
  AlertTriangle,
  RotateCcw,
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
  roles?: string[];
  membershipId?: string | null;
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

interface RoleAssignmentScopeItem {
  id: string;
  scope_type: string;
  campus_id?: string;
  department_id?: string;
  class_section_id?: string;
  student_user_id?: string;
}

interface RoleAssignmentItem {
  id: string;
  membership_id: string;
  role_template_id: string;
  role_template_code: string;
  role_template_name: string;
  status: string;
  valid_from: string;
  valid_until?: string | null;
  reason?: string | null;
  scopes: RoleAssignmentScopeItem[];
}

interface MembershipItem {
  id: string;
  institution_id: string;
  user_id: string;
  user_name: string;
  user_email: string;
  institutional_id: string;
  legacy_role: string;
  status: string;
  joined_at: string;
  role_assignments: RoleAssignmentItem[];
}

interface RoleTemplateItem {
  id: string;
  code: string;
  name: string;
  category: string;
}

interface UnmappedAccount {
  user_id: string;
  full_name: string;
  institutional_id: string;
  email: string;
  legacy_role: string;
  membership_id?: string | null;
  account_status: string;
}

interface DelegationItem {
  id: string;
  grantor_user_name: string;
  grantee_user_name: string;
  status: string;
  valid_from: string;
  valid_until: string;
  reason: string;
}

interface AuditItem {
  id: string;
  actor_name?: string;
  action: string;
  target_resource_type?: string;
  outcome: string;
  reason?: string;
  created_at: string;
}

export default function AdminPeopleScreen() {
  const [who, setWho] = useState<'student' | 'faculty' | 'admin' | 'access'>('student');
  const [accessSubTab, setAccessSubTab] = useState<'memberships' | 'unmapped' | 'delegations' | 'audits'>('memberships');
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState<Person[]>([]);
  const [loading, setLoading] = useState(false);

  // Access Control Data States
  const [memberships, setMemberships] = useState<MembershipItem[]>([]);
  const [roleTemplates, setRoleTemplates] = useState<RoleTemplateItem[]>([]);
  const [unmappedAccounts, setUnmappedAccounts] = useState<UnmappedAccount[]>([]);
  const [delegations, setDelegations] = useState<DelegationItem[]>([]);
  const [audits, setAudits] = useState<AuditItem[]>([]);
  const [selectedMembership, setSelectedMembership] = useState<MembershipItem | null>(null);
  const [showAssignRoleSheet, setShowAssignRoleSheet] = useState(false);
  const [assignRoleTargetMembershipId, setAssignRoleTargetMembershipId] = useState('');
  const [selectedRoleTemplateId, setSelectedRoleTemplateId] = useState('');
  const [selectedScopeType, setSelectedScopeType] = useState<string>('INSTITUTION');
  const [assignmentReason, setAssignmentReason] = useState('');
  const [assignRoleSubmitting, setAssignRoleSubmitting] = useState(false);
  const [assignRoleError, setAssignRoleError] = useState<string | null>(null);

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
  const [grantRoleModalVisible, setGrantRoleModalVisible] = useState(false);
  const [roleToGrant, setRoleToGrant] = useState('CAMPUS_ADMIN');
  const [grantReason, setGrantReason] = useState('');
  const [grantingRole, setGrantingRole] = useState(false);
  const [grantRoleError, setGrantRoleError] = useState<string | null>(null);

  // Faculty Assignments State
  const [facultyAssignments, setFacultyAssignments] = useState<FacultyAssignment[]>([]);
  const [allSections, setAllSections] = useState<ClassSectionItem[]>([]);
  const [allSubjects, setAllSubjects] = useState<SubjectItem[]>([]);
  const [pickedSectionId, setPickedSectionId] = useState('');
  const [pickedSubjectId, setPickedSubjectId] = useState('');
  const [assignError, setAssignError] = useState<string | null>(null);
  const [assigning, setAssigning] = useState(false);

  const loadAccessControlData = useCallback(async () => {
    setLoading(true);
    const token = SessionStore.getToken();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    try {
      const [memsRes, tplsRes, unmapRes, delegRes, auditRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/v1/admin/access-control/memberships`, { headers }),
        fetch(`${API_BASE_URL}/api/v1/admin/access-control/role-templates`, { headers }),
        fetch(`${API_BASE_URL}/api/v1/admin/access-control/unmapped-accounts`, { headers }),
        fetch(`${API_BASE_URL}/api/v1/admin/access-control/delegations`, { headers }),
        fetch(`${API_BASE_URL}/api/v1/admin/access-control/audits`, { headers }),
      ]);

      if (memsRes.ok) setMemberships(await memsRes.json());
      if (tplsRes.ok) {
        const tpls = await tplsRes.json();
        setRoleTemplates(tpls);
        if (tpls.length > 0 && !selectedRoleTemplateId) setSelectedRoleTemplateId(tpls[0].id);
      }
      if (unmapRes.ok) setUnmappedAccounts(await unmapRes.json());
      if (delegRes.ok) setDelegations(await delegRes.json());
      if (auditRes.ok) setAudits(await auditRes.json());
    } catch (e) {
      console.warn('Error loading access control data:', e);
    } finally {
      setLoading(false);
    }
  }, [selectedRoleTemplateId]);

  const handleCreateRoleAssignment = async () => {
    if (!assignRoleTargetMembershipId || !selectedRoleTemplateId) {
      setAssignRoleError('Target membership and role template are required.');
      return;
    }
    setAssignRoleSubmitting(true);
    setAssignRoleError(null);
    const token = SessionStore.getToken();

    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/access-control/role-assignments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          membership_id: assignRoleTargetMembershipId,
          role_template_id: selectedRoleTemplateId,
          scope_type: selectedScopeType,
          reason: assignmentReason.trim() || 'Assigned via Admin Management Console',
        }),
      });

      if (res.ok) {
        setShowAssignRoleSheet(false);
        setAssignmentReason('');
        await loadAccessControlData();
        // If viewing selected membership, refresh it
        if (selectedMembership && selectedMembership.id === assignRoleTargetMembershipId) {
          const freshMems = await (await fetch(`${API_BASE_URL}/api/v1/admin/access-control/memberships`, {
            headers: { Authorization: `Bearer ${token}` },
          })).json();
          const updated = freshMems.find((m: any) => m.id === assignRoleTargetMembershipId);
          if (updated) setSelectedMembership(updated);
        }
      } else {
        const err = await res.json();
        setAssignRoleError(err.detail || 'Failed to assign role template');
      }
    } catch (e: any) {
      setAssignRoleError(e?.message || 'Network error');
    } finally {
      setAssignRoleSubmitting(false);
    }
  };

  const handleUpdateAssignmentStatus = async (assignmentId: string, newStatus: string) => {
    const token = SessionStore.getToken();
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/access-control/role-assignments/${assignmentId}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          status: newStatus,
          reason: `Status changed to ${newStatus} by administrator`,
        }),
      });
      if (res.ok) {
        await loadAccessControlData();
        if (selectedMembership) {
          const freshMems = await (await fetch(`${API_BASE_URL}/api/v1/admin/access-control/memberships`, {
            headers: { Authorization: `Bearer ${token}` },
          })).json();
          const updated = freshMems.find((m: any) => m.id === selectedMembership.id);
          if (updated) setSelectedMembership(updated);
        }
      }
    } catch (e) {
      console.warn('Update assignment status error:', e);
    }
  };

  const handleApproveDelegation = async (delegationId: string) => {
    const token = SessionStore.getToken();
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/access-control/delegations/${delegationId}/approve`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ reason: 'Approved by administrator' }),
      });
      if (res.ok) {
        await loadAccessControlData();
      }
    } catch (e) {
      console.warn('Approve delegation error:', e);
    }
  };

  const handleRevokeDelegation = async (delegationId: string) => {
    const token = SessionStore.getToken();
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/access-control/delegations/${delegationId}/revoke`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ reason: 'Revoked by administrator' }),
      });
      if (res.ok) {
        await loadAccessControlData();
      }
    } catch (e) {
      console.warn('Revoke delegation error:', e);
    }
  };

  const loadDirectory = useCallback(async () => {
    setLoading(true);
    const token = SessionStore.getToken();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    try {
      if (who === 'access') {
        await loadAccessControlData();
        return;
      }
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
              roles: u.roles || [u.role],
              membershipId: u.membership_id,
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
    setGrantRoleModalVisible(false);
    setGrantRoleError(null);
    const hasTeachingCapability =
      person.role.toUpperCase() === 'FACULTY' ||
      (person.roles &&
        person.roles.some((r) =>
          ['FACULTY', 'TEACHING_ASSISTANT', 'CLASS_ADVISOR', 'DEPARTMENT_HEAD', 'DEPARTMENT_HEAD_COORDINATOR'].includes(r.toUpperCase())
        ));
    if (hasTeachingCapability) {
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
          roles: updated.roles || [updated.role],
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

  // Grant an additional role template to a user
  const handleGrantRole = async () => {
    if (!selectedUser || !roleToGrant) return;
    setGrantingRole(true);
    setGrantRoleError(null);
    const token = SessionStore.getToken();

    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/users/${selectedUser.id}/roles`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          role_code: roleToGrant,
          reason: grantReason.trim() || 'Role granted via Admin Management Console',
        }),
      });

      if (res.ok) {
        const updatedUser = await res.json();
        setSelectedUser({
          ...selectedUser,
          role: updatedUser.role,
          sub: updatedUser.subtitle,
          roles: updatedUser.roles,
        });
        setGrantRoleModalVisible(false);
        setGrantReason('');
        await loadDirectory();
        const hasTeaching =
          updatedUser.role === 'FACULTY' ||
          (updatedUser.roles &&
            updatedUser.roles.some((r: string) =>
              ['FACULTY', 'TEACHING_ASSISTANT', 'CLASS_ADVISOR', 'DEPARTMENT_HEAD', 'DEPARTMENT_HEAD_COORDINATOR'].includes(r.toUpperCase())
            ));
        if (hasTeaching) {
          loadFacultyAssignments(selectedUser.id);
        }
      } else {
        const err = await res.json();
        setGrantRoleError(err.message || err.detail || 'Failed to grant role');
      }
    } catch (e: any) {
      setGrantRoleError(e?.message || 'Network error');
    } finally {
      setGrantingRole(false);
    }
  };

  // Revoke a specific role from a user
  const handleRevokeUserRole = async (roleCode: string) => {
    if (!selectedUser) return;
    setRoleUpdating(true);
    const token = SessionStore.getToken();

    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/users/${selectedUser.id}/roles/${roleCode}`, {
        method: 'DELETE',
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });

      if (res.ok) {
        const updatedUser = await res.json();
        setSelectedUser({
          ...selectedUser,
          role: updatedUser.role,
          sub: updatedUser.subtitle,
          roles: updatedUser.roles,
        });
        await loadDirectory();
      }
    } catch (e) {
      console.warn('Revoke role error:', e);
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

        <Pressable
          onPress={() => setWho('access')}
          style={[styles.segmentButton, who === 'access' && styles.segmentButtonActive]}
        >
          <Text style={[styles.segmentText, who === 'access' && styles.segmentTextActive]}>
            Access & Roles
          </Text>
        </Pressable>
      </View>

      {/* Search & Add User Row */}
      {who !== 'access' && (
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
      )}

      {/* Directory List or Access Control Panel */}
      {who === 'access' ? (
        <View style={{ gap: 12 }}>
          {/* Access Control Sub-Navigation */}
          <View style={styles.accessSubNav}>
            {(['memberships', 'unmapped', 'delegations', 'audits'] as const).map((tab) => (
              <Pressable
                key={tab}
                onPress={() => setAccessSubTab(tab)}
                style={[
                  styles.accessSubNavBtn,
                  accessSubTab === tab && styles.accessSubNavBtnActive,
                ]}
              >
                <Text
                  style={[
                    styles.accessSubNavText,
                    accessSubTab === tab && styles.accessSubNavTextActive,
                  ]}
                >
                  {tab === 'memberships'
                    ? 'Memberships'
                    : tab === 'unmapped'
                    ? `Unmapped (${unmappedAccounts.length})`
                    : tab === 'delegations'
                    ? 'Delegations'
                    : 'Audits'}
                </Text>
              </Pressable>
            ))}
          </View>

          {/* SubTab 1: Memberships & Role Assignments */}
          {accessSubTab === 'memberships' && (
            <Card style={styles.listCard}>
              {loading ? (
                <ActivityIndicator color={Colors.forest} style={{ paddingVertical: 20 }} />
              ) : memberships.length > 0 ? (
                memberships.map((m, idx) => (
                  <View key={m.id}>
                    {idx > 0 && <View style={styles.divider} />}
                    <Pressable
                      onPress={() => setSelectedMembership(m)}
                      style={({ pressed }) => [styles.personRow, pressed && { opacity: 0.7 }]}
                    >
                      <Avatar name={m.user_name} userId={m.user_id} size={40} />
                      <View style={styles.personTextCol}>
                        <Text style={styles.personName}>{m.user_name}</Text>
                        <Text style={styles.personSub}>
                          {m.institutional_id} · {m.role_assignments.length} assigned roles
                        </Text>
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                          {m.role_assignments.map((ra) => (
                            <Chip
                              key={ra.id}
                              tone={ra.status === 'ACTIVE' ? 'forest' : ra.status === 'SUSPENDED' ? 'apricot' : 'rose'}
                            >
                              {ra.role_template_code}
                            </Chip>
                          ))}
                        </View>
                      </View>
                      <ChevronRight size={16} color={Colors.soft} />
                    </Pressable>
                  </View>
                ))
              ) : (
                <Text style={styles.emptyText}>No memberships found.</Text>
              )}
            </Card>
          )}

          {/* SubTab 2: Unmapped Legacy Accounts */}
          {accessSubTab === 'unmapped' && (
            <View style={{ gap: 10 }}>
              <View style={styles.infoBox}>
                <AlertTriangle size={18} color={Colors.apricot} />
                <Text style={styles.infoBoxText}>
                  These accounts have legacy categories but lack explicit Institutional Access Control v1 role assignments. Review and assign fixed templates.
                </Text>
              </View>
              <Card style={styles.listCard}>
                {unmappedAccounts.length > 0 ? (
                  unmappedAccounts.map((u, idx) => (
                    <View key={u.user_id}>
                      {idx > 0 && <View style={styles.divider} />}
                      <View style={styles.personRow}>
                        <Avatar name={u.full_name} userId={u.user_id} size={40} />
                        <View style={styles.personTextCol}>
                          <Text style={styles.personName}>{u.full_name}</Text>
                          <Text style={styles.personSub}>{u.email} · {u.institutional_id}</Text>
                        </View>
                        <Chip tone="apricot">Legacy {u.legacy_role}</Chip>
                        {u.membership_id && (
                          <Button
                            tone="forest"
                            onPress={() => {
                              setAssignRoleTargetMembershipId(u.membership_id!);
                              setShowAssignRoleSheet(true);
                            }}
                          >
                            Assign
                          </Button>
                        )}
                      </View>
                    </View>
                  ))
                ) : (
                  <Text style={styles.emptyText}>All accounts are mapped to active institutional roles.</Text>
                )}
              </Card>
            </View>
          )}

          {/* SubTab 3: Delegations */}
          {accessSubTab === 'delegations' && (
            <Card style={styles.listCard}>
              {delegations.length > 0 ? (
                delegations.map((d, idx) => (
                  <View key={d.id} style={{ paddingVertical: 12 }}>
                    {idx > 0 && <View style={[styles.divider, { marginBottom: 12 }]} />}
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={styles.personName}>{d.grantor_user_name} → {d.grantee_user_name}</Text>
                      <Chip tone={d.status === 'ACTIVE' ? 'forest' : d.status === 'REVOKED' ? 'rose' : 'lilac'}>
                        {d.status}
                      </Chip>
                    </View>
                    <Text style={[styles.personSub, { marginTop: 4 }]}>
                      Valid: {new Date(d.valid_from).toLocaleDateString()} to {new Date(d.valid_until).toLocaleDateString()}
                    </Text>
                    <Text style={[styles.personSub, { fontStyle: 'italic', marginTop: 2 }]}>
                      Reason: {d.reason}
                    </Text>
                    {d.status === 'ACTIVE' && (
                      <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                        <Button
                          tone="rose"
                          onPress={() => handleRevokeDelegation(d.id)}
                        >
                          Revoke
                        </Button>
                      </View>
                    )}
                  </View>
                ))
              ) : (
                <Text style={styles.emptyText}>No active or historical delegations recorded.</Text>
              )}
            </Card>
          )}

          {/* SubTab 4: Audits */}
          {accessSubTab === 'audits' && (
            <Card style={styles.listCard}>
              {audits.length > 0 ? (
                audits.map((a, idx) => (
                  <View key={a.id} style={{ paddingVertical: 10 }}>
                    {idx > 0 && <View style={[styles.divider, { marginBottom: 10 }]} />}
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Text style={[styles.personName, { fontSize: 14 }]}>{a.action}</Text>
                      <Chip tone={a.outcome === 'ALLOWED' ? 'forest' : 'rose'}>{a.outcome}</Chip>
                    </View>
                    <Text style={[styles.personSub, { marginTop: 2 }]}>
                      Actor: {a.actor_name || 'System / Anonymous'} · {new Date(a.created_at).toLocaleString()}
                    </Text>
                    {a.reason && (
                      <Text style={[styles.personSub, { fontStyle: 'italic', marginTop: 2 }]}>
                        {a.reason}
                      </Text>
                    )}
                  </View>
                ))
              ) : (
                <Text style={styles.emptyText}>No authorization audit logs found.</Text>
              )}
            </Card>
          )}
        </View>
      ) : (
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
      )}

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

          {/* Active Assigned Roles */}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
            <Text style={styles.sheetSectionTitle}>Assigned Roles</Text>
            <Pressable
              onPress={() => {
                setGrantRoleError(null);
                setGrantRoleModalVisible(!grantRoleModalVisible);
              }}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
            >
              <Plus size={14} color={Colors.forest} />
              <Text style={{ fontSize: 12, fontWeight: '700', color: Colors.forest }}>
                {grantRoleModalVisible ? 'Cancel' : 'Grant Role'}
              </Text>
            </Pressable>
          </View>

          {/* List of active roles as chips with remove option */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8, marginBottom: 12 }}>
            {(selectedUser.roles && selectedUser.roles.length > 0 ? selectedUser.roles : [selectedUser.role]).map((r) => {
              const rUpper = r.toUpperCase();
              const isGovernance = rUpper.includes('ADMIN') || rUpper.includes('OWNER') || rUpper.includes('OFFICER');
              const isTeaching = ['FACULTY', 'TEACHING_ASSISTANT', 'CLASS_ADVISOR'].includes(rUpper);
              const chipTone = isGovernance ? 'forest' : isTeaching ? 'lilac' : 'soft';
              const canRevoke = (selectedUser.roles?.length || 1) > 1;

              return (
                <View
                  key={r}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    backgroundColor: chipTone === 'forest' ? Colors.forest50 : chipTone === 'lilac' ? '#f5f3ff' : Colors.line,
                    borderRadius: Radii.pill,
                    paddingLeft: 10,
                    paddingRight: canRevoke ? 6 : 10,
                    paddingVertical: 5,
                    borderWidth: 1,
                    borderColor: chipTone === 'forest' ? Colors.forest : chipTone === 'lilac' ? Colors.lilac : 'transparent',
                  }}
                >
                  <Text
                    style={{
                      fontSize: 12,
                      fontWeight: '600',
                      color: chipTone === 'forest' ? Colors.forest : chipTone === 'lilac' ? Colors.lilac : Colors.ink,
                    }}
                  >
                    {r.replace(/_/g, ' ')}
                  </Text>
                  {canRevoke && (
                    <Pressable
                      disabled={roleUpdating}
                      onPress={() => handleRevokeUserRole(r)}
                      style={{
                        marginLeft: 6,
                        width: 18,
                        height: 18,
                        borderRadius: 9,
                        backgroundColor: 'rgba(0,0,0,0.08)',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <Text style={{ fontSize: 11, fontWeight: 'bold', color: Colors.soft, lineHeight: 12 }}>×</Text>
                    </Pressable>
                  )}
                </View>
              );
            })}
          </View>

          {/* Inline Grant Role Form if toggled */}
          {grantRoleModalVisible && (
            <View style={{ backgroundColor: Colors.card, padding: 12, borderRadius: Radii.card, borderWidth: 1, borderColor: Colors.line, marginBottom: 16 }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: Colors.ink, marginBottom: 8 }}>
                Select Role to Grant
              </Text>
              {grantRoleError && <Text style={styles.errorBanner}>{grantRoleError}</Text>}
              <ScrollView style={{ maxHeight: 160, marginBottom: 10 }} nestedScrollEnabled>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                  {[
                    { code: 'IT_ADMIN', label: 'IT Administrator' },
                    { code: 'PRIVACY_BIOMETRIC_OFFICER', label: 'Privacy & Biometric Officer' },
                    { code: 'CAMPUS_ADMIN', label: 'Campus Administrator' },
                    { code: 'ACCESS_ADMIN', label: 'Access Administrator' },
                    { code: 'CENTRAL_INSTITUTION_ADMIN', label: 'Central Institution Admin' },
                    { code: 'INSTITUTION_OWNER', label: 'Institution Owner' },
                    { code: 'DEPARTMENT_HEAD_COORDINATOR', label: 'Department Head' },
                    { code: 'FACULTY', label: 'Faculty' },
                    { code: 'TEACHING_ASSISTANT', label: 'Teaching Assistant' },
                    { code: 'CLASS_ADVISOR', label: 'Class Advisor' },
                    { code: 'ACADEMIC_REGISTRAR', label: 'Academic Registrar' },
                    { code: 'ADMISSIONS_OFFICER', label: 'Admissions Officer' },
                    { code: 'ENROLLMENT_OFFICER', label: 'Enrollment Officer' },
                    { code: 'STUDENT_RECORDS_OFFICER', label: 'Student Records Officer' },
                    { code: 'PROGRAM_COORDINATOR', label: 'Program Coordinator' },
                    { code: 'TIMETABLE_COORDINATOR', label: 'Timetable Coordinator' },
                    { code: 'BIOMETRIC_ENROLLMENT_OFFICER', label: 'Biometric Enrollment Officer' },
                    { code: 'ATTENDANCE_AUDITOR', label: 'Attendance Auditor' },
                    { code: 'INSTITUTIONAL_AUDITOR', label: 'Institutional Auditor' },
                    { code: 'STUDENT', label: 'Student' },
                  ].map(({ code, label }) => {
                    const isSelected = roleToGrant === code;
                    const alreadyHas =
                      selectedUser.roles?.includes(code) ||
                      (code === 'PRIVACY_BIOMETRIC_OFFICER' && selectedUser.roles?.includes('PRIVACY_BIOMETRIC_GOVERNANCE')) ||
                      (code === 'DEPARTMENT_HEAD_COORDINATOR' && selectedUser.roles?.includes('DEPARTMENT_HEAD'));
                    return (
                      <Pressable
                        key={code}
                        disabled={alreadyHas}
                        onPress={() => setRoleToGrant(code)}
                        style={[
                          styles.pickerChip,
                          isSelected && styles.pickerChipActive,
                          alreadyHas && { opacity: 0.35, backgroundColor: Colors.line },
                        ]}
                      >
                        <Text style={[styles.pickerChipText, isSelected && styles.pickerChipTextActive]}>
                          {label} {alreadyHas ? '✓' : ''}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </ScrollView>

              <Text style={styles.inputLabel}>Reason / Justification</Text>
              <TextInput
                value={grantReason}
                onChangeText={setGrantReason}
                placeholder="e.g. Appointed as Department Head and Faculty"
                placeholderTextColor={Colors.soft}
                style={[styles.textInput, { marginBottom: 10 }]}
              />

              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Button
                  tone="forest"
                  disabled={grantingRole}
                  onPress={handleGrantRole}
                >
                  {grantingRole ? 'Granting…' : 'Confirm Grant'}
                </Button>
                <Button
                  tone="soft"
                  onPress={() => setGrantRoleModalVisible(false)}
                >
                  Cancel
                </Button>
              </View>
            </View>
          )}

          {/* Primary Compatibility Switcher */}
          <Text style={[styles.sheetSectionTitle, { marginTop: 4 }]}>Primary Role</Text>
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

          {/* If User has teaching capability or faculty assignments */}
          {(selectedUser.role.toUpperCase() === 'FACULTY' ||
            (selectedUser.roles &&
              selectedUser.roles.some((r) =>
                ['FACULTY', 'TEACHING_ASSISTANT', 'CLASS_ADVISOR', 'DEPARTMENT_HEAD', 'DEPARTMENT_HEAD_COORDINATOR'].includes(r.toUpperCase())
              )) ||
            facultyAssignments.length > 0) && (
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

      {/* --- SHEET: MEMBERSHIP & ROLE ASSIGNMENTS (IAC v1) --- */}
      {selectedMembership && (
        <Sheet visible={!!selectedMembership} onClose={() => setSelectedMembership(null)}>
          <View style={styles.sheetHeader}>
            <Avatar name={selectedMembership.user_name} userId={selectedMembership.user_id} size={50} />
            <View style={styles.sheetHeaderCol}>
              <Text style={styles.sheetFacultyName}>{selectedMembership.user_name}</Text>
              <Text style={styles.sheetFacultyDept}>
                {selectedMembership.user_email} · {selectedMembership.institutional_id}
              </Text>
              <Text style={{ fontSize: 11, color: Colors.forest, marginTop: 2 }}>
                Status: {selectedMembership.status} · Joined {new Date(selectedMembership.joined_at).toLocaleDateString()}
              </Text>
            </View>
          </View>

          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
            <Text style={styles.sheetSectionTitle}>Active & Historical Roles</Text>
            <Pressable
              onPress={() => {
                setAssignRoleTargetMembershipId(selectedMembership.id);
                setAssignRoleError(null);
                setShowAssignRoleSheet(true);
              }}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
            >
              <Plus size={14} color={Colors.forest} />
              <Text style={{ fontSize: 12, fontWeight: '700', color: Colors.forest }}>Assign Template</Text>
            </Pressable>
          </View>

          <View style={{ gap: 8, marginVertical: 10 }}>
            {selectedMembership.role_assignments.length > 0 ? (
              selectedMembership.role_assignments.map((ra) => (
                <View
                  key={ra.id}
                  style={{
                    backgroundColor: Colors.card,
                    padding: 12,
                    borderRadius: Radii.card,
                    borderWidth: 1,
                    borderColor: Colors.line,
                  }}
                >
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                    <Text style={{ fontSize: 13, fontWeight: '700', color: Colors.ink }}>
                      {ra.role_template_code}
                    </Text>
                    <Chip tone={ra.status === 'ACTIVE' ? 'forest' : ra.status === 'SUSPENDED' ? 'apricot' : 'rose'}>
                      {ra.status}
                    </Chip>
                  </View>
                  <Text style={{ fontSize: 11, color: Colors.soft, marginTop: 4 }}>
                    Scope: {ra.scopes.map((s) => s.scope_type).join(', ') || 'INSTITUTION'}
                  </Text>
                  <Text style={{ fontSize: 11, color: Colors.soft, marginTop: 2 }}>
                    Valid: {new Date(ra.valid_from).toLocaleDateString()} {ra.valid_until ? `to ${new Date(ra.valid_until).toLocaleDateString()}` : '(Ongoing)'}
                  </Text>
                  {ra.reason && (
                    <Text style={{ fontSize: 11, color: Colors.ink, fontStyle: 'italic', marginTop: 2 }}>
                      Reason: {ra.reason}
                    </Text>
                  )}
                  {ra.status === 'ACTIVE' && (
                    <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                      <Button
                        tone="lilac"
                        onPress={() => handleUpdateAssignmentStatus(ra.id, 'SUSPENDED')}
                      >
                        Suspend
                      </Button>
                      <Button
                        tone="rose"
                        onPress={() => handleUpdateAssignmentStatus(ra.id, 'REVOKED')}
                      >
                        Revoke
                      </Button>
                    </View>
                  )}
                </View>
              ))
            ) : (
              <Text style={{ fontSize: 12, color: Colors.soft, marginVertical: 8 }}>
                No explicit role assignments found.
              </Text>
            )}
          </View>
        </Sheet>
      )}

      {/* --- SHEET: ASSIGN FIXED ROLE TEMPLATE --- */}
      <Sheet visible={showAssignRoleSheet} onClose={() => setShowAssignRoleSheet(false)}>
        <Text style={styles.sheetTitle}>Assign Role Template</Text>
        <Text style={styles.sheetSub}>Select one of the 20 approved fixed role templates and define scope</Text>

        {assignRoleError && <Text style={styles.errorBanner}>{assignRoleError}</Text>}

        <Text style={styles.inputLabel}>Select Role Template</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {roleTemplates.map((t) => (
              <Pressable
                key={t.id}
                onPress={() => setSelectedRoleTemplateId(t.id)}
                style={[
                  styles.pickerChip,
                  selectedRoleTemplateId === t.id && styles.pickerChipActive,
                ]}
              >
                <Text
                  style={[
                    styles.pickerChipText,
                    selectedRoleTemplateId === t.id && styles.pickerChipTextActive,
                  ]}
                >
                  {t.code}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        <Text style={styles.inputLabel}>Scope Hierarchy</Text>
        <View style={{ flexDirection: 'row', gap: 8, marginBottom: 16 }}>
          {(['INSTITUTION', 'CAMPUS', 'DEPARTMENT', 'CLASS_SECTION'] as const).map((st) => (
            <Pressable
              key={st}
              onPress={() => setSelectedScopeType(st)}
              style={[
                styles.roleAssignBtn,
                selectedScopeType === st && styles.roleAssignBtnActive,
              ]}
            >
              <Text
                style={[
                  styles.roleAssignBtnText,
                  selectedScopeType === st && styles.roleAssignBtnTextActive,
                ]}
              >
                {st}
              </Text>
            </Pressable>
          ))}
        </View>

        <Text style={styles.inputLabel}>Assignment Reason / Justification</Text>
        <TextInput
          value={assignmentReason}
          onChangeText={setAssignmentReason}
          placeholder="e.g. Appointed Department Head for AY 2026-27"
          placeholderTextColor={Colors.soft}
          style={styles.textInput}
        />

        <View style={{ marginTop: 20 }}>
          <Button
            tone="forest"
            disabled={assignRoleSubmitting}
            onPress={handleCreateRoleAssignment}
          >
            {assignRoleSubmitting ? 'Granting…' : 'Grant Role Assignment'}
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
  accessSubNav: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  accessSubNavBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: Radii.pill,
    backgroundColor: Colors.line,
  },
  accessSubNavBtnActive: {
    backgroundColor: Colors.forest,
  },
  accessSubNavText: {
    fontSize: 11,
    fontWeight: '600',
    color: Colors.soft,
  },
  accessSubNavTextActive: {
    color: '#ffffff',
  },
  infoBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: Colors.apricot50 || 'rgba(235, 140, 94, 0.1)',
    padding: 10,
    borderRadius: Radii.card,
    borderWidth: 1,
    borderColor: Colors.apricot,
  },
  infoBoxText: {
    flex: 1,
    fontSize: 11,
    color: Colors.ink,
    lineHeight: 16,
  },
});
