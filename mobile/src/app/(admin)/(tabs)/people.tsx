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
  Alert,
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
  Trash2,
  Edit3,
} from 'lucide-react-native';

import { Screen, Card, Chip, Avatar, Sheet, Button, AccessRestrictedView } from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';
import { API_BASE_URL } from '@/config/api';
import { SessionStore } from '@/storage/sessionStore';
import { useRouter } from 'expo-router';
import { extractErrorMessage } from '@/utils/apiError';

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

interface BulkPreviewStudent {
  row_index: number;
  institutional_id: string;
  student_name: string;
  email: string;
  user_exists: boolean;
  membership_exists: boolean;
  is_valid: boolean;
  validation_error?: string | null;
  status: string;
}

interface BulkPreviewResult {
  total_submitted: number;
  valid_count: number;
  duplicate_count: number;
  new_accounts_count: number;
  existing_memberships_count: number;
  rejected_count: number;
  preview_rows: BulkPreviewStudent[];
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
  const router = useRouter();

  if (!SessionStore.canManagePeople()) {
    return (
      <AccessRestrictedView
        title="People Directory Restricted"
        message="Viewing or managing institutional memberships and rosters requires administrative or departmental staff authority."
        requiredCapability="membership.view"
        onBack={() => router.replace('/(admin)' as any)}
      />
    );
  }

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

  // Edit User State
  const [isEditingUser, setIsEditingUser] = useState(false);
  const [editUserName, setEditUserName] = useState('');
  const [editUserEmail, setEditUserEmail] = useState('');
  const [editUserId, setEditUserId] = useState('');
  const [editUserError, setEditUserError] = useState<string | null>(null);
  const [editUserSubmitting, setEditUserSubmitting] = useState(false);

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

  // Enrollment State (Dual Mode: Single & Bulk)
  const [showBulkEnrollSheet, setShowBulkEnrollSheet] = useState(false);
  const [enrollTab, setEnrollTab] = useState<'single' | 'bulk'>('single');
  const [bulkSectionId, setBulkSectionId] = useState('');
  const [singleStudentRoll, setSingleStudentRoll] = useState('');
  const [singleStudentName, setSingleStudentName] = useState('');
  const [singleStudentEmail, setSingleStudentEmail] = useState('');
  const [singleEnrolling, setSingleEnrolling] = useState(false);
  const [bulkCsvText, setBulkCsvText] = useState('');
  const [bulkPreviewResult, setBulkPreviewResult] = useState<BulkPreviewResult | null>(null);
  const [bulkPreviewing, setBulkPreviewing] = useState(false);
  const [bulkExecuting, setBulkExecuting] = useState(false);
  const [bulkEnrollError, setBulkEnrollError] = useState<string | null>(null);

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

  const parseBulkCsvRows = (text: string) => {
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const rows = [];
    for (const line of lines) {
      const parts = line.split(/[,;\t]+/).map((p) => p.trim());
      if (parts.length >= 2) {
        rows.push({
          institutional_id: parts[0],
          full_name: parts[1],
          email: parts[2] || `${parts[0].toLowerCase().replace(/[^a-z0-9]/g, '')}@student.edu`,
        });
      }
    }
    return rows;
  };

  const handleBulkPreview = async () => {
    if (!bulkSectionId) {
      setBulkEnrollError('Please select a target class section.');
      return;
    }
    const rows = parseBulkCsvRows(bulkCsvText);
    if (rows.length === 0) {
      setBulkEnrollError('Please enter at least one student row: RollNumber, Full Name, Email');
      return;
    }
    const sec = allSections.find((s) => s.id === bulkSectionId);
    if (!sec?.academic_term_id) {
      setBulkEnrollError('Selected section does not have an associated academic term.');
      return;
    }

    setBulkPreviewing(true);
    setBulkEnrollError(null);
    try {
      const token = SessionStore.getToken();
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/enrollments/bulk-preview`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          academic_term_id: sec.academic_term_id,
          class_section_id: bulkSectionId,
          rows,
        }),
      });
      if (res.ok) {
        const previewData = await res.json();
        setBulkPreviewResult(previewData);
      } else {
        const msg = await extractErrorMessage(res, 'Failed to preview bulk enrollment');
        setBulkEnrollError(msg);
      }
    } catch (e: any) {
      setBulkEnrollError(e?.message || 'Network error');
    } finally {
      setBulkPreviewing(false);
    }
  };

  const handleBulkExecute = async () => {
    if (!bulkSectionId) return;
    const rows = parseBulkCsvRows(bulkCsvText);
    if (rows.length === 0) return;
    const sec = allSections.find((s) => s.id === bulkSectionId);
    if (!sec?.academic_term_id) return;

    setBulkExecuting(true);
    setBulkEnrollError(null);
    try {
      const token = SessionStore.getToken();
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/enrollments/bulk-execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          academic_term_id: sec.academic_term_id,
          class_section_id: bulkSectionId,
          rows,
          create_missing_accounts: true,
        }),
      });
      if (res.ok) {
        const result = await res.json();
        Alert.alert(
          'Bulk Enrollment Completed',
          `Successfully enrolled ${result.created_enrollments_count} students.\n(${result.created_users_count} new accounts created).`
        );
        setShowBulkEnrollSheet(false);
        setBulkCsvText('');
        setBulkPreviewResult(null);
        await loadDirectory();
      } else {
        const msg = await extractErrorMessage(res, 'Failed to execute bulk enrollment');
        setBulkEnrollError(msg);
      }
    } catch (e: any) {
      setBulkEnrollError(e?.message || 'Network error');
    } finally {
      setBulkExecuting(false);
    }
  };

  const handleSingleStudentEnroll = async () => {
    if (!bulkSectionId) {
      setBulkEnrollError('Please select a target class section.');
      return;
    }
    if (!singleStudentRoll.trim() || !singleStudentName.trim()) {
      setBulkEnrollError('Roll number and full name are required.');
      return;
    }
    setSingleEnrolling(true);
    setBulkEnrollError(null);
    try {
      const token = SessionStore.getToken();
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/sections/${bulkSectionId}/enroll`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          institutional_id: singleStudentRoll.trim(),
          full_name: singleStudentName.trim(),
          email: singleStudentEmail.trim() || undefined,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        Alert.alert('Student Enrolled', data.message || 'Student enrolled successfully.');
        setSingleStudentRoll('');
        setSingleStudentName('');
        setSingleStudentEmail('');
        setShowBulkEnrollSheet(false);
        await loadDirectory();
      } else {
        const msg = await extractErrorMessage(res, 'Failed to enroll student');
        setBulkEnrollError(msg);
      }
    } catch (e: any) {
      setBulkEnrollError(e?.message || 'Network error');
    } finally {
      setSingleEnrolling(false);
    }
  };

  const handleOpenEnrollmentModal = async () => {
    setBulkEnrollError(null);
    setBulkPreviewResult(null);
    if (allSections.length === 0) {
      const token = SessionStore.getToken();
      try {
        const res = await fetch(`${API_BASE_URL}/api/v1/admin/sections`, {
          headers: {
            Accept: 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        });
        if (res.ok) {
          const secs = await res.json();
          if (Array.isArray(secs) && secs.length > 0) {
            setAllSections(secs);
            setBulkSectionId(secs[0].id);
          }
        }
      } catch (e) {
        console.warn('Error fetching sections for enrollment modal:', e);
      }
    } else if (!bulkSectionId && allSections.length > 0) {
      setBulkSectionId(allSections[0].id);
    }
    setShowBulkEnrollSheet(true);
  };

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
        const errorMsg = await extractErrorMessage(res, 'Failed to assign role template');
        setAssignRoleError(errorMsg);
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
      // Always pre-load available sections so single/bulk enrollment targets are populated
      fetch(`${API_BASE_URL}/api/v1/admin/sections`, { headers })
        .then((r) => (r.ok ? r.json() : []))
        .then((secs) => {
          if (Array.isArray(secs) && secs.length > 0) {
            setAllSections(secs);
            setBulkSectionId((prev) => (prev ? prev : secs[0].id));
          }
        })
        .catch(() => {});

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
    setEditUserName(person.name);
    setEditUserEmail(person.email);
    setEditUserId(person.identifier);
    setIsEditingUser(false);
    setEditUserError(null);
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
    } else {
      setFacultyAssignments([]);
    }
  };

  // Update User Details
  const handleUpdateUserDetails = async () => {
    if (!selectedUser || !editUserName.trim() || !editUserEmail.trim() || !editUserId.trim()) {
      setEditUserError('Full name, email, and institutional ID are required.');
      return;
    }
    setEditUserSubmitting(true);
    setEditUserError(null);
    const token = SessionStore.getToken();

    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/users/${selectedUser.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          full_name: editUserName.trim(),
          email: editUserEmail.trim().toLowerCase(),
          institutional_id: editUserId.trim(),
        }),
      });

      if (res.ok) {
        const updated = await res.json();
        setSelectedUser({
          ...selectedUser,
          name: updated.name,
          email: updated.email,
          identifier: updated.identifier,
          sub: updated.subtitle || `${updated.role} · ${updated.identifier}`,
        });
        setIsEditingUser(false);
        await loadDirectory();
      } else {
        const msg = await extractErrorMessage(res, 'Failed to update user details');
        setEditUserError(msg);
      }
    } catch (e: any) {
      setEditUserError(e?.message || 'Network error');
    } finally {
      setEditUserSubmitting(false);
    }
  };

  // Delete / Deactivate User
  const handleDeleteUser = (hardDelete: boolean) => {
    if (!selectedUser) return;
    const title = hardDelete ? 'Permanently Delete User' : 'Deactivate User';
    const msg = hardDelete
      ? `Permanently delete ${selectedUser.name}? If any historical attendance or academic records exist, the account will be deactivated instead to protect compliance.`
      : `Deactivate ${selectedUser.name}? This will suspend account access and active roles while keeping historical attendance intact.`;

    Alert.alert(title, msg, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: hardDelete ? 'Delete Permanently' : 'Deactivate',
        style: 'destructive',
        onPress: async () => {
          const token = SessionStore.getToken();
          try {
            const url = `${API_BASE_URL}/api/v1/admin/users/${selectedUser.id}${hardDelete ? '?hard_delete=true' : ''}`;
            const res = await fetch(url, {
              method: 'DELETE',
              headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
              },
            });
            if (res.ok) {
              const resData = await res.json();
              Alert.alert('Success', resData.message || 'User status updated');
              setSelectedUser(null);
              await loadDirectory();
            } else {
              const errMsg = await extractErrorMessage(res, 'Failed to delete user');
              Alert.alert('Action Failed', errMsg);
            }
          } catch (e: any) {
            Alert.alert('Error', e?.message || 'Network error');
          }
        },
      },
    ]);
  };

  // Remove Teaching Assignment
  const handleRemoveTeachingAssignment = (assignmentId: string) => {
    Alert.alert(
      'Remove Teaching Assignment',
      'Are you sure you want to remove this teaching assignment? If sessions were already conducted, the assignment will be deactivated to preserve audit records.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            const token = SessionStore.getToken();
            try {
              const res = await fetch(`${API_BASE_URL}/api/v1/admin/assignments/${assignmentId}`, {
                method: 'DELETE',
                headers: {
                  ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
              });
              if (res.ok) {
                if (selectedUser) {
                  await loadFacultyAssignments(selectedUser.id);
                }
              } else {
                const msg = await extractErrorMessage(res, 'Failed to remove assignment');
                Alert.alert('Cannot Remove', msg);
              }
            } catch (e: any) {
              Alert.alert('Error', e?.message || 'Network error');
            }
          },
        },
      ]
    );
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
        const errorMsg = await extractErrorMessage(res, 'Failed to create user');
        setUserError(errorMsg);
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
        const errorMsg = await extractErrorMessage(res, 'Failed to grant role');
        setGrantRoleError(errorMsg);
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
    const termId = targetSection?.academic_term_id;
    if (!termId) {
      setAssignError('Selected class section does not have an associated academic term.');
      setAssigning(false);
      return;
    }
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
        const errorMsg = await extractErrorMessage(res, 'Failed to assign class');
        setAssignError(errorMsg);
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
      onBack={() => {
        if (router.canGoBack()) {
          router.back();
        } else {
          router.replace('/(faculty)' as any);
        }
      }}
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

        {SessionStore.canManageAccessControl() && (
          <Pressable
            onPress={() => setWho('access')}
            style={[styles.segmentButton, who === 'access' && styles.segmentButtonActive]}
            accessibilityRole="button"
            accessibilityLabel="Access and Roles Management"
          >
            <Text style={[styles.segmentText, who === 'access' && styles.segmentTextActive]}>
              Access & Roles
            </Text>
          </Pressable>
        )}
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
          {who === 'student' && SessionStore.canEnrollStudents() && (
            <Pressable
              onPress={handleOpenEnrollmentModal}
              style={[styles.addUserButton, { backgroundColor: Colors.forest, paddingHorizontal: 12, width: 'auto', flexDirection: 'row', gap: 6 }]}
              accessibilityRole="button"
              accessibilityLabel="Enroll students"
            >
              <Users size={16} color="#ffffff" />
              <Text style={{ color: '#ffffff', fontSize: 13, fontWeight: '700' }}>Enroll Student</Text>
            </Pressable>
          )}
          {SessionStore.canEnrollStudents() && (
            <Pressable
              onPress={() => {
                setUserError(null);
                setShowAddUserSheet(true);
              }}
              style={styles.addUserButton}
              accessibilityRole="button"
              accessibilityLabel="Add user"
            >
              <Plus size={20} color="#ffffff" />
            </Pressable>
          )}
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
            <Pressable
              onPress={() => setIsEditingUser(!isEditingUser)}
              style={styles.editUserHeaderBtn}
              accessibilityRole="button"
              accessibilityLabel="Edit user profile"
            >
              <Edit3 size={18} color={isEditingUser ? Colors.forest : Colors.soft} />
            </Pressable>
          </View>

          {isEditingUser && (
            <View style={styles.editUserBox}>
              <Text style={{ fontSize: 13, fontWeight: '700', color: Colors.ink, marginBottom: 8 }}>
                Edit Account Details
              </Text>
              {editUserError && <Text style={styles.errorBanner}>{editUserError}</Text>}
              <Text style={styles.inputLabel}>Full Name</Text>
              <TextInput
                value={editUserName}
                onChangeText={setEditUserName}
                style={styles.textInput}
              />
              <Text style={styles.inputLabel}>Email</Text>
              <TextInput
                value={editUserEmail}
                onChangeText={setEditUserEmail}
                keyboardType="email-address"
                autoCapitalize="none"
                style={styles.textInput}
              />
              <Text style={styles.inputLabel}>Institutional ID</Text>
              <TextInput
                value={editUserId}
                onChangeText={setEditUserId}
                autoCapitalize="characters"
                style={styles.textInput}
              />
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                <Button
                  tone="forest"
                  disabled={editUserSubmitting}
                  onPress={handleUpdateUserDetails}
                >
                  {editUserSubmitting ? 'Saving…' : 'Save Details'}
                </Button>
                <Button
                  tone="soft"
                  onPress={() => setIsEditingUser(false)}
                >
                  Cancel
                </Button>
              </View>
            </View>
          )}

          {/* Active Assigned Roles */}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}>
            <Text style={styles.sheetSectionTitle}>Assigned Roles</Text>
            {SessionStore.canManageAccessControl() && (
              <Pressable
                onPress={() => {
                  setGrantRoleError(null);
                  setGrantRoleModalVisible(!grantRoleModalVisible);
                }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
                accessibilityRole="button"
                accessibilityLabel="Grant Role"
              >
                <Plus size={14} color={Colors.forest} />
                <Text style={{ fontSize: 12, fontWeight: '700', color: Colors.forest }}>
                  {grantRoleModalVisible ? 'Cancel' : 'Grant Role'}
                </Text>
              </Pressable>
            )}
          </View>

          {/* List of active roles as chips with remove option */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8, marginBottom: 12 }}>
            {(selectedUser.roles && selectedUser.roles.length > 0 ? selectedUser.roles : [selectedUser.role]).map((r) => {
              const rUpper = r.toUpperCase();
              const isGovernance = rUpper.includes('ADMIN') || rUpper.includes('OWNER') || rUpper.includes('OFFICER');
              const isTeaching = ['FACULTY', 'TEACHING_ASSISTANT', 'CLASS_ADVISOR'].includes(rUpper);
              const chipTone = isGovernance ? 'forest' : isTeaching ? 'lilac' : 'soft';
              const canRevoke = SessionStore.canManageAccessControl() && (selectedUser.roles?.length || 1) > 1;

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
              const canChange = SessionStore.canManageAccessControl() && !roleUpdating && !isCurrent;
              return (
                <Pressable
                  key={roleOption}
                  disabled={!canChange}
                  onPress={() => handleUpdateRole(roleOption)}
                  style={[
                    styles.roleAssignBtn,
                    isCurrent && styles.roleAssignBtnActive,
                    !canChange && !isCurrent && { opacity: 0.5 },
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`Set primary role to ${roleOption}`}
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
                {SessionStore.canEditAcademics() && (
                  <Pressable
                    onPress={() => {
                      setAssignError(null);
                      setShowAssignClassSheet(true);
                    }}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
                    accessibilityRole="button"
                    accessibilityLabel="Assign Class to Faculty"
                  >
                    <Plus size={14} color={Colors.forest} />
                    <Text style={{ fontSize: 12, fontWeight: '700', color: Colors.forest }}>Assign Class</Text>
                  </Pressable>
                )}
              </View>

              <View style={styles.assignedClassesList}>
                {facultyAssignments.length > 0 ? (
                  facultyAssignments.map((a) => (
                    <View key={a.id} style={styles.assignedClassRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.assignedClassText}>
                          {a.subject_code} · {a.subject_name}
                        </Text>
                        <Text style={{ fontSize: 11, color: Colors.soft }}>
                          Section: {a.section_code}
                        </Text>
                      </View>
                      <Pressable
                        onPress={() => handleRemoveTeachingAssignment(a.id)}
                        hitSlop={8}
                        style={{ padding: 6 }}
                        accessibilityRole="button"
                        accessibilityLabel={`Remove assignment for ${a.subject_code}`}
                      >
                        <Trash2 size={16} color={Colors.rose} />
                      </Pressable>
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

          {/* Account Actions: Deactivate / Delete */}
          <Text style={[styles.sheetSectionTitle, { marginTop: 18 }]}>Account Actions</Text>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 6, marginBottom: 12 }}>
            <View style={{ flex: 1 }}>
              <Button
                tone="apricot"
                onPress={() => handleDeleteUser(false)}
              >
                Deactivate
              </Button>
            </View>
            <View style={{ flex: 1 }}>
              <Button
                tone="rose"
                onPress={() => handleDeleteUser(true)}
              >
                Delete Account
              </Button>
            </View>
          </View>

          <View style={{ marginTop: 16 }}>
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

      {/* --- SHEET: STUDENT ENROLLMENT (DUAL: SINGLE & BULK) --- */}
      <Sheet visible={showBulkEnrollSheet} onClose={() => setShowBulkEnrollSheet(false)}>
        <Text style={styles.sheetTitle}>Enroll Student to Class</Text>
        <Text style={styles.sheetSub}>Admit students into an academic section roster</Text>

        {bulkEnrollError && <Text style={styles.errorBanner}>{bulkEnrollError}</Text>}

        {/* Mode Selector Tabs */}
        <View style={{ flexDirection: 'row', backgroundColor: Colors.line, borderRadius: 10, padding: 3, marginBottom: 16 }}>
          <Pressable
            onPress={() => setEnrollTab('single')}
            style={[{ flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 8 }, enrollTab === 'single' && { backgroundColor: Colors.card, elevation: 1 }]}
          >
            <Text style={{ fontSize: 13, fontWeight: enrollTab === 'single' ? '700' : '600', color: enrollTab === 'single' ? Colors.ink : Colors.soft }}>
              Single Student
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setEnrollTab('bulk')}
            style={[{ flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 8 }, enrollTab === 'bulk' && { backgroundColor: Colors.card, elevation: 1 }]}
          >
            <Text style={{ fontSize: 13, fontWeight: enrollTab === 'bulk' ? '700' : '600', color: enrollTab === 'bulk' ? Colors.ink : Colors.soft }}>
              Bulk CSV Cohort
            </Text>
          </Pressable>
        </View>

        <Text style={styles.inputLabel}>Target Class Section</Text>
        {allSections.length === 0 ? (
          <Text style={{ fontSize: 12, color: Colors.soft, marginBottom: 12, fontStyle: 'italic' }}>
            No class sections available. Only assigned sections can be managed.
          </Text>
        ) : (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
            <View style={{ flexDirection: 'row', gap: 8 }}>
              {allSections.map((s) => (
                <Pressable
                  key={s.id}
                  onPress={() => setBulkSectionId(s.id)}
                  style={[
                    styles.pickerChip,
                    bulkSectionId === s.id && styles.pickerChipActive,
                  ]}
                >
                  <Text style={[styles.pickerChipText, bulkSectionId === s.id && styles.pickerChipTextActive]}>
                    Section {s.section_code}
                  </Text>
                </Pressable>
              ))}
            </View>
          </ScrollView>
        )}

        {enrollTab === 'single' ? (
          <View style={{ gap: 12, marginBottom: 16 }}>
            <View>
              <Text style={styles.inputLabel}>Roll Number / Student ID</Text>
              <TextInput
                value={singleStudentRoll}
                onChangeText={setSingleStudentRoll}
                placeholder="e.g. 21CS042 or 2024-CSE-001"
                placeholderTextColor={Colors.soft}
                autoCapitalize="characters"
                style={styles.textInput}
              />
            </View>
            <View>
              <Text style={styles.inputLabel}>Student Full Name</Text>
              <TextInput
                value={singleStudentName}
                onChangeText={setSingleStudentName}
                placeholder="e.g. Rahul Sharma"
                placeholderTextColor={Colors.soft}
                style={styles.textInput}
              />
            </View>
            <View>
              <Text style={styles.inputLabel}>Email Address (Optional)</Text>
              <TextInput
                value={singleStudentEmail}
                onChangeText={setSingleStudentEmail}
                placeholder="e.g. rahul.sharma@attendly.edu"
                placeholderTextColor={Colors.soft}
                keyboardType="email-address"
                autoCapitalize="none"
                style={styles.textInput}
              />
            </View>
            <Button
              tone="forest"
              disabled={singleEnrolling || allSections.length === 0}
              onPress={handleSingleStudentEnroll}
            >
              {singleEnrolling ? 'Enrolling Student…' : 'Enroll Student'}
            </Button>
          </View>
        ) : (
          <View>
            <Text style={styles.inputLabel}>Student Roster Records</Text>
            <Text style={{ fontSize: 11, color: Colors.soft, marginBottom: 6 }}>
              Format: RollNumber, Full Name, Email (one student per line)
            </Text>
            <TextInput
              value={bulkCsvText}
              onChangeText={setBulkCsvText}
              multiline
              numberOfLines={6}
              placeholder={"CSE201, Priya Sharma, priya@attendly.edu\nCSE202, Rahul Verma, rahul@attendly.edu"}
              placeholderTextColor={Colors.soft}
              style={[styles.textInput, { height: 110, textAlignVertical: 'top' }]}
            />

            <View style={{ flexDirection: 'row', gap: 10, marginBottom: 16, marginTop: 8 }}>
              <Button
                variant="soft"
                style={{ flex: 1 }}
                disabled={bulkPreviewing || allSections.length === 0}
                onPress={handleBulkPreview}
              >
                {bulkPreviewing ? 'Validating…' : 'Preview Roster'}
              </Button>
              <Button
                variant="ghost"
                onPress={() => {
                  setBulkCsvText('');
                  setBulkPreviewResult(null);
                }}
              >
                Clear
              </Button>
            </View>

            {bulkPreviewResult && (
              <View style={{ marginBottom: 16 }}>
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
                  <Chip tone="forest">{bulkPreviewResult.valid_count} Valid</Chip>
                  <Chip tone="secondary">{bulkPreviewResult.new_accounts_count} New Users</Chip>
                  <Chip tone="apricot">{bulkPreviewResult.duplicate_count} Existing</Chip>
                  {bulkPreviewResult.rejected_count > 0 && (
                    <Chip tone="rose">{bulkPreviewResult.rejected_count} Rejected</Chip>
                  )}
                </View>

                <ScrollView style={{ maxHeight: 180, marginBottom: 12 }}>
                  <View style={{ gap: 6 }}>
                    {bulkPreviewResult.preview_rows.map((row) => (
                      <View
                        key={row.row_index}
                        style={{
                          flexDirection: 'row',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          backgroundColor: Colors.card,
                          borderRadius: 8,
                          borderWidth: 1,
                          borderColor: Colors.line,
                          padding: 8,
                        }}
                      >
                        <View style={{ flex: 1 }}>
                          <Text style={{ fontSize: 13, fontWeight: '700', color: Colors.ink }}>
                            {row.student_name}
                          </Text>
                          <Text style={{ fontSize: 11, color: Colors.soft }}>
                            {row.institutional_id} · {row.email}
                          </Text>
                          {row.validation_error && (
                            <Text style={{ fontSize: 10, color: Colors.rose, marginTop: 2 }}>
                              {row.validation_error}
                            </Text>
                          )}
                        </View>
                        <Chip tone={row.is_valid ? 'forest' : 'rose'}>{row.status}</Chip>
                      </View>
                    ))}
                  </View>
                </ScrollView>

                <Button
                  tone="forest"
                  disabled={bulkExecuting || bulkPreviewResult.valid_count === 0}
                  onPress={handleBulkExecute}
                >
                  {bulkExecuting ? 'Enrolling Students…' : `Confirm & Enroll ${bulkPreviewResult.valid_count} Students`}
                </Button>
              </View>
            )}
          </View>
        )}
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
  editUserHeaderBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: Colors.line,
    alignItems: 'center',
    justifyContent: 'center',
  },
  editUserBox: {
    backgroundColor: Colors.card,
    borderRadius: Radii.card,
    borderWidth: 1,
    borderColor: Colors.line,
    padding: 12,
    marginTop: 12,
    marginBottom: 8,
  },
});
