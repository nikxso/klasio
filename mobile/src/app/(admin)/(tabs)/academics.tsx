import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  TextInput,
  ScrollView,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  Building2,
  ChevronRight,
  Plus,
  BookOpen,
  Link2,
  Layers,
  Landmark,
  Trash2,
  Edit3,
  Calendar,
  Clock,
  UserCheck,
  GraduationCap,
  Search,
  Users,
} from 'lucide-react-native';

import { Screen, Card, IconBubble, SectionTitle, Sheet, Button, Chip, AccessRestrictedView } from '@/components/ui/kit';
import { Colors, Radii } from '@/theme/tokens';
import { API_BASE_URL } from '@/config/api';
import { SessionStore } from '@/storage/sessionStore';
import { extractErrorMessage } from '@/utils/apiError';

interface CampusItem {
  id: string;
  code: string;
  name: string;
  status: string;
}

interface DepartmentItem {
  id: string;
  code: string;
  name: string;
  sections: number;
  subjects: number;
}

interface ProgramItem {
  id: string;
  department_id: string;
  department_name?: string;
  code: string;
  name: string;
  is_active: boolean;
}

interface PeriodItem {
  id: string;
  period_number: number;
  name: string;
  start_time: string;
  end_time: string;
  is_break: boolean;
  is_active: boolean;
}

interface TimetableItem {
  id: string;
  subject_code?: string;
  subject_name?: string;
  section_code?: string;
  period_name?: string;
  period_number?: number;
  start_time?: string;
  end_time?: string;
  day_of_week: number;
  room_number: string;
  faculty_name?: string;
}

interface SectionRosterStudent {
  enrollment_id: string;
  student_user_id: string;
  institutional_id: string;
  student_name: string;
  email: string;
  effective_start_date: string;
  enrollment_status: string;
  face_registration_state: string;
}

interface TermItem {
  id: string;
  code: string;
  name: string;
}

interface SubjectItem {
  id: string;
  code: string;
  name: string;
  department_id: string;
  credits?: number;
}

interface SectionItem {
  id: string;
  section_code: string;
  department_id: string;
  academic_term_id: string;
  cohort_year?: number;
  program_id?: string;
  program_name?: string;
}

interface FacultyUserItem {
  id: string;
  name: string;
  identifier: string;
}

export default function AdminAcademicsScreen() {
  const router = useRouter();
  const [catalogTab, setCatalogTab] = useState<'DEPTS' | 'PROGRAMS' | 'SUBJECTS' | 'SECTIONS' | 'TIMETABLE' | 'CAMPUSES'>('DEPTS');
  const [campuses, setCampuses] = useState<CampusItem[]>([]);
  const [departments, setDepartments] = useState<DepartmentItem[]>([]);
  const [rawDepartments, setRawDepartments] = useState<{ id: string; code: string; name: string }[]>([]);
  const [programs, setPrograms] = useState<ProgramItem[]>([]);
  const [periods, setPeriods] = useState<PeriodItem[]>([]);
  const [timetable, setTimetable] = useState<TimetableItem[]>([]);
  const [assignments, setAssignments] = useState<any[]>([]);
  const [terms, setTerms] = useState<TermItem[]>([]);
  const [subjects, setSubjects] = useState<SubjectItem[]>([]);
  const [sections, setSections] = useState<SectionItem[]>([]);
  const [facultyUsers, setFacultyUsers] = useState<FacultyUserItem[]>([]);
  const [loading, setLoading] = useState(false);

  // Section Roster Modal States
  const [selectedRosterSection, setSelectedRosterSection] = useState<SectionItem | null>(null);
  const [rosterStudents, setRosterStudents] = useState<SectionRosterStudent[]>([]);
  const [loadingRoster, setLoadingRoster] = useState(false);
  const [rosterSearch, setRosterSearch] = useState('');

  // Modal Sheet Visibility States (Create)
  const [activeSheet, setActiveSheet] = useState<'NONE' | 'CAMPUS' | 'DEPT' | 'PROGRAM' | 'SUBJECT' | 'SECTION' | 'ASSIGN' | 'TIMETABLE'>('NONE');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Program Sheet States
  const [progCode, setProgCode] = useState('');
  const [progName, setProgName] = useState('');
  const [progDeptId, setProgDeptId] = useState('');
  const [editingProgram, setEditingProgram] = useState<ProgramItem | null>(null);
  const [editProgCode, setEditProgCode] = useState('');
  const [editProgName, setEditProgName] = useState('');

  // Timetable Sheet States
  const [ttTermId, setTtTermId] = useState('');
  const [ttSectionId, setTtSectionId] = useState('');
  const [ttAssignmentId, setTtAssignmentId] = useState('');
  const [ttPeriodId, setTtPeriodId] = useState('');
  const [ttDayOfWeek, setTtDayOfWeek] = useState('1');
  const [ttRoom, setTtRoom] = useState('LH-101');

  // Edit Sheet States
  const [editingDept, setEditingDept] = useState<DepartmentItem | null>(null);
  const [editDeptCode, setEditDeptCode] = useState('');
  const [editDeptName, setEditDeptName] = useState('');

  const [editingSubject, setEditingSubject] = useState<SubjectItem | null>(null);
  const [editSubCode, setEditSubCode] = useState('');
  const [editSubName, setEditSubName] = useState('');
  const [editSubCredits, setEditSubCredits] = useState('3');

  const [editingSection, setEditingSection] = useState<SectionItem | null>(null);
  const [editSecCode, setEditSecCode] = useState('');
  const [editSecCohort, setEditSecCohort] = useState('2026');

  const [editingCampus, setEditingCampus] = useState<CampusItem | null>(null);
  const [editCampusName, setEditCampusName] = useState('');
  const [editCampusStatus, setEditCampusStatus] = useState('ACTIVE');

  // Form States: Add Campus
  const [campusCode, setCampusCode] = useState('');
  const [campusName, setCampusName] = useState('');

  // Form States: Add Department
  const [deptCode, setDeptCode] = useState('');
  const [deptName, setDeptName] = useState('');

  // Form States: Add Subject
  const [subCode, setSubCode] = useState('');
  const [subName, setSubName] = useState('');
  const [subDeptId, setSubDeptId] = useState('');
  const [subCredits, setSubCredits] = useState('3');

  // Form States: Add Section
  const [secCode, setSecCode] = useState('');
  const [secDeptId, setSecDeptId] = useState('');
  const [secTermId, setSecTermId] = useState('');
  const [secCohort, setSecCohort] = useState('2026');
  const [secProgramId, setSecProgramId] = useState('');

  // Form States: Assign Faculty
  const [assignFacultyId, setAssignFacultyId] = useState('');
  const [assignSecId, setAssignSecId] = useState('');
  const [assignSubId, setAssignSubId] = useState('');
  const [assignTermId, setAssignTermId] = useState('');

  const loadAcademicsData = useCallback(async () => {
    setLoading(true);
    const token = SessionStore.getToken();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };

    try {
      // 0. Campuses
      const resCampuses = await fetch(`${API_BASE_URL}/api/v1/admin/campuses`, { headers });
      if (resCampuses.ok) {
        const cList = await resCampuses.json();
        setCampuses(cList);
      }

      // 1. Overview
      const resOverview = await fetch(`${API_BASE_URL}/api/v1/admin/departments/overview`, { headers });
      if (resOverview.ok) {
        const depts = await resOverview.json();
        if (Array.isArray(depts) && depts.length > 0) {
          setDepartments(
            depts.map((d: any) => ({
              id: d.id,
              code: d.code,
              name: d.name,
              sections: d.sections_count || 0,
              subjects: d.subjects_count || 0,
            }))
          );
        }
      }

      // 2. Full Departments List
      const resDepts = await fetch(`${API_BASE_URL}/api/v1/admin/departments`, { headers });
      if (resDepts.ok) {
        const dList = await resDepts.json();
        setRawDepartments(dList);
        if (dList.length > 0 && !subDeptId) setSubDeptId(dList[0].id);
        if (dList.length > 0 && !secDeptId) setSecDeptId(dList[0].id);
      }

      // 3. Terms
      const resTerms = await fetch(`${API_BASE_URL}/api/v1/admin/terms`, { headers });
      if (resTerms.ok) {
        const tList = await resTerms.json();
        setTerms(tList);
        if (tList.length > 0 && !secTermId) setSecTermId(tList[0].id);
        if (tList.length > 0 && !assignTermId) setAssignTermId(tList[0].id);
      }

      // 4. Subjects
      const resSubs = await fetch(`${API_BASE_URL}/api/v1/admin/subjects`, { headers });
      if (resSubs.ok) {
        const sList = await resSubs.json();
        setSubjects(sList);
        if (sList.length > 0 && !assignSubId) setAssignSubId(sList[0].id);
      }

      // 5. Sections
      const resSecs = await fetch(`${API_BASE_URL}/api/v1/admin/sections`, { headers });
      if (resSecs.ok) {
        const cList = await resSecs.json();
        setSections(cList);
        if (cList.length > 0 && !assignSecId) setAssignSecId(cList[0].id);
      }

      // 6. Faculty
      const resFaculty = await fetch(`${API_BASE_URL}/api/v1/admin/users?role=faculty`, { headers });
      if (resFaculty.ok) {
        const fList = await resFaculty.json();
        setFacultyUsers(fList);
        if (fList.length > 0 && !assignFacultyId) setAssignFacultyId(fList[0].id);
      }

      // 7. Programs
      const resPrograms = await fetch(`${API_BASE_URL}/api/v1/admin/programs`, { headers });
      if (resPrograms.ok) {
        const pList = await resPrograms.json();
        setPrograms(pList);
        if (pList.length > 0 && !progDeptId) setProgDeptId(pList[0].department_id);
      }

      // 8. Periods
      const resPeriods = await fetch(`${API_BASE_URL}/api/v1/admin/periods`, { headers });
      if (resPeriods.ok) {
        const perList = await resPeriods.json();
        setPeriods(perList);
        const nonBreak = perList.filter((p: PeriodItem) => !p.is_break);
        if (nonBreak.length > 0 && !ttPeriodId) setTtPeriodId(nonBreak[0].id);
      }

      // 9. Timetable
      const resTimetable = await fetch(`${API_BASE_URL}/api/v1/admin/timetable`, { headers });
      if (resTimetable.ok) {
        const ttList = await resTimetable.json();
        setTimetable(ttList);
      }

      // 10. Assignments
      const resAssignments = await fetch(`${API_BASE_URL}/api/v1/admin/assignments`, { headers });
      if (resAssignments.ok) {
        const aList = await resAssignments.json();
        setAssignments(aList);
        if (aList.length > 0 && !ttAssignmentId) {
          setTtAssignmentId(aList[0].id);
          if (!ttSectionId) setTtSectionId(aList[0].class_section_id);
          if (!ttTermId) setTtTermId(aList[0].academic_term_id);
        }
      }
    } catch (e) {
      console.warn('Load academics error:', e);
    } finally {
      setLoading(false);
    }
  }, [subDeptId, secDeptId, secTermId, assignTermId, assignSubId, assignSecId, assignFacultyId, progDeptId, ttPeriodId, ttAssignmentId, ttSectionId, ttTermId]);

  useEffect(() => {
    loadAcademicsData();
  }, [loadAcademicsData]);

  // Handle Create Campus
  const handleCreateCampus = async () => {
    if (!campusCode.trim() || !campusName.trim()) {
      setErrorMessage('Please enter both Campus Code and Campus Name.');
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const token = SessionStore.getToken();
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/campuses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ code: campusCode.trim().toUpperCase(), name: campusName.trim() }),
      });
      if (res.ok) {
        setCampusCode('');
        setCampusName('');
        setActiveSheet('NONE');
        await loadAcademicsData();
      } else {
        const errorMsg = await extractErrorMessage(res, 'Failed to create campus');
        setErrorMessage(errorMsg);
      }
    } catch (e: any) {
      setErrorMessage(e?.message || 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  // Handle Create Department
  const handleCreateDepartment = async () => {
    if (!deptCode.trim() || !deptName.trim()) {
      setErrorMessage('Please enter both Department Code and Department Name.');
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const token = SessionStore.getToken();
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/departments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ code: deptCode.trim().toUpperCase(), name: deptName.trim() }),
      });
      if (res.ok) {
        setDeptCode('');
        setDeptName('');
        setActiveSheet('NONE');
        await loadAcademicsData();
      } else {
        const errorMsg = await extractErrorMessage(res, 'Failed to create department');
        setErrorMessage(errorMsg);
      }
    } catch (e: any) {
      setErrorMessage(e?.message || 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  // Handle Create Subject
  const handleCreateSubject = async () => {
    if (!subCode.trim() || !subName.trim() || !subDeptId) {
      setErrorMessage('Please enter Code, Name, and select a Department.');
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const token = SessionStore.getToken();
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/subjects`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          code: subCode.trim().toUpperCase(),
          name: subName.trim(),
          department_id: subDeptId,
          credits: parseInt(subCredits, 10) || 3,
          is_active: true,
        }),
      });
      if (res.ok) {
        setSubCode('');
        setSubName('');
        setActiveSheet('NONE');
        await loadAcademicsData();
      } else {
        const errorMsg = await extractErrorMessage(res, 'Failed to create subject');
        setErrorMessage(errorMsg);
      }
    } catch (e: any) {
      setErrorMessage(e?.message || 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  // Handle Create Section
  const handleCreateSection = async () => {
    if (!secCode.trim() || !secDeptId || !secTermId) {
      setErrorMessage('Please enter Section Code and select Department and Term.');
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const token = SessionStore.getToken();
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/sections`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          section_code: secCode.trim().toUpperCase(),
          department_id: secDeptId,
          academic_term_id: secTermId,
          cohort_year: parseInt(secCohort, 10) || 2026,
          program_id: secProgramId || undefined,
        }),
      });
      if (res.ok) {
        setSecCode('');
        setActiveSheet('NONE');
        await loadAcademicsData();
      } else {
        const errorMsg = await extractErrorMessage(res, 'Failed to create section');
        setErrorMessage(errorMsg);
      }
    } catch (e: any) {
      setErrorMessage(e?.message || 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  // Handle Assign Faculty
  const handleAssignFaculty = async () => {
    if (!assignFacultyId || !assignSecId || !assignSubId || !assignTermId) {
      setErrorMessage('Please select Faculty, Section, Subject, and Academic Term.');
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const token = SessionStore.getToken();
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/assignments`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          faculty_user_id: assignFacultyId,
          class_section_id: assignSecId,
          subject_id: assignSubId,
          academic_term_id: assignTermId,
          is_active: true,
        }),
      });
      if (res.ok) {
        setActiveSheet('NONE');
        await loadAcademicsData();
      } else {
        const errorMsg = await extractErrorMessage(res, 'Failed to assign faculty');
        setErrorMessage(errorMsg);
      }
    } catch (e: any) {
      setErrorMessage(e?.message || 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  // --- UPDATE & DELETE HANDLERS ---

  // Update Department
  const handleUpdateDepartment = async () => {
    if (!editingDept || !editDeptCode.trim() || !editDeptName.trim()) {
      setErrorMessage('Please enter both Code and Name.');
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const token = SessionStore.getToken();
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/departments/${editingDept.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ code: editDeptCode.trim().toUpperCase(), name: editDeptName.trim() }),
      });
      if (res.ok) {
        setEditingDept(null);
        await loadAcademicsData();
      } else {
        const errorMsg = await extractErrorMessage(res, 'Failed to update department');
        setErrorMessage(errorMsg);
      }
    } catch (e: any) {
      setErrorMessage(e?.message || 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  // Delete Department
  const handleDeleteDepartment = (dept: DepartmentItem) => {
    Alert.alert(
      'Delete Department',
      `Are you sure you want to delete ${dept.code} (${dept.name})? This will fail if subjects or sections are linked.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setSubmitting(true);
            try {
              const token = SessionStore.getToken();
              const res = await fetch(`${API_BASE_URL}/api/v1/admin/departments/${dept.id}`, {
                method: 'DELETE',
                headers: {
                  ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
              });
              if (res.ok) {
                setEditingDept(null);
                await loadAcademicsData();
              } else {
                const msg = await extractErrorMessage(res, 'Failed to delete department');
                Alert.alert('Cannot Delete', msg);
              }
            } catch (e: any) {
              Alert.alert('Error', e?.message || 'Network error');
            } finally {
              setSubmitting(false);
            }
          },
        },
      ]
    );
  };

  // Update Subject
  const handleUpdateSubject = async () => {
    if (!editingSubject || !editSubCode.trim() || !editSubName.trim()) {
      setErrorMessage('Please enter Code and Name.');
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const token = SessionStore.getToken();
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/subjects/${editingSubject.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          code: editSubCode.trim().toUpperCase(),
          name: editSubName.trim(),
          credits: parseInt(editSubCredits, 10) || 3,
        }),
      });
      if (res.ok) {
        setEditingSubject(null);
        await loadAcademicsData();
      } else {
        const errorMsg = await extractErrorMessage(res, 'Failed to update subject');
        setErrorMessage(errorMsg);
      }
    } catch (e: any) {
      setErrorMessage(e?.message || 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  // Delete Subject
  const handleDeleteSubject = (subj: SubjectItem) => {
    Alert.alert(
      'Delete Subject',
      `Are you sure you want to delete ${subj.code} (${subj.name})?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setSubmitting(true);
            try {
              const token = SessionStore.getToken();
              const res = await fetch(`${API_BASE_URL}/api/v1/admin/subjects/${subj.id}`, {
                method: 'DELETE',
                headers: {
                  ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
              });
              if (res.ok) {
                setEditingSubject(null);
                await loadAcademicsData();
              } else {
                const msg = await extractErrorMessage(res, 'Failed to delete subject');
                Alert.alert('Cannot Delete', msg);
              }
            } catch (e: any) {
              Alert.alert('Error', e?.message || 'Network error');
            } finally {
              setSubmitting(false);
            }
          },
        },
      ]
    );
  };

  // Update Section
  const handleUpdateSection = async () => {
    if (!editingSection || !editSecCode.trim()) {
      setErrorMessage('Please enter Section Code.');
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const token = SessionStore.getToken();
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/sections/${editingSection.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          section_code: editSecCode.trim().toUpperCase(),
          cohort_year: parseInt(editSecCohort, 10) || 2026,
        }),
      });
      if (res.ok) {
        setEditingSection(null);
        await loadAcademicsData();
      } else {
        const errorMsg = await extractErrorMessage(res, 'Failed to update section');
        setErrorMessage(errorMsg);
      }
    } catch (e: any) {
      setErrorMessage(e?.message || 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  // Delete Section
  const handleDeleteSection = (sec: SectionItem) => {
    Alert.alert(
      'Delete Section',
      `Are you sure you want to delete section ${sec.section_code}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setSubmitting(true);
            try {
              const token = SessionStore.getToken();
              const res = await fetch(`${API_BASE_URL}/api/v1/admin/sections/${sec.id}`, {
                method: 'DELETE',
                headers: {
                  ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
              });
              if (res.ok) {
                setEditingSection(null);
                await loadAcademicsData();
              } else {
                const msg = await extractErrorMessage(res, 'Failed to delete section');
                Alert.alert('Cannot Delete', msg);
              }
            } catch (e: any) {
              Alert.alert('Error', e?.message || 'Network error');
            } finally {
              setSubmitting(false);
            }
          },
        },
      ]
    );
  };

  // Update Campus
  const handleUpdateCampus = async () => {
    if (!editingCampus || !editCampusName.trim()) {
      setErrorMessage('Please enter Campus Name.');
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const token = SessionStore.getToken();
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/campuses/${editingCampus.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          name: editCampusName.trim(),
          status: editCampusStatus,
        }),
      });
      if (res.ok) {
        setEditingCampus(null);
        await loadAcademicsData();
      } else {
        const errorMsg = await extractErrorMessage(res, 'Failed to update campus');
        setErrorMessage(errorMsg);
      }
    } catch (e: any) {
      setErrorMessage(e?.message || 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  // Delete Campus
  const handleDeleteCampus = (c: CampusItem) => {
    Alert.alert(
      'Delete Campus',
      `Are you sure you want to delete ${c.code} (${c.name})?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setSubmitting(true);
            try {
              const token = SessionStore.getToken();
              const res = await fetch(`${API_BASE_URL}/api/v1/admin/campuses/${c.id}`, {
                method: 'DELETE',
                headers: {
                  ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
              });
              if (res.ok) {
                setEditingCampus(null);
                await loadAcademicsData();
              } else {
                const msg = await extractErrorMessage(res, 'Failed to delete campus');
                Alert.alert('Cannot Delete', msg);
              }
            } catch (e: any) {
              Alert.alert('Error', e?.message || 'Network error');
            } finally {
              setSubmitting(false);
            }
          },
        },
      ]
    );
  };

  // --- PROGRAM HANDLERS ---
  const handleCreateProgram = async () => {
    if (!progCode.trim() || !progName.trim() || !progDeptId) {
      setErrorMessage('Please enter Program Code, Program Name, and select a Department.');
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const token = SessionStore.getToken();
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/programs`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          code: progCode.trim().toUpperCase(),
          name: progName.trim(),
          department_id: progDeptId,
          is_active: true,
        }),
      });
      if (res.ok) {
        setProgCode('');
        setProgName('');
        setActiveSheet('NONE');
        await loadAcademicsData();
      } else {
        const errorMsg = await extractErrorMessage(res, 'Failed to create program');
        setErrorMessage(errorMsg);
      }
    } catch (e: any) {
      setErrorMessage(e?.message || 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleUpdateProgram = async () => {
    if (!editingProgram || !editProgCode.trim() || !editProgName.trim()) {
      setErrorMessage('Please enter both Code and Name.');
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const token = SessionStore.getToken();
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/programs/${editingProgram.id}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          code: editProgCode.trim().toUpperCase(),
          name: editProgName.trim(),
        }),
      });
      if (res.ok) {
        setEditingProgram(null);
        await loadAcademicsData();
      } else {
        const errorMsg = await extractErrorMessage(res, 'Failed to update program');
        setErrorMessage(errorMsg);
      }
    } catch (e: any) {
      setErrorMessage(e?.message || 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteProgram = (prog: ProgramItem) => {
    Alert.alert(
      'Delete Program',
      `Are you sure you want to delete ${prog.code} (${prog.name})? This will fail if sections are linked to it.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setSubmitting(true);
            try {
              const token = SessionStore.getToken();
              const res = await fetch(`${API_BASE_URL}/api/v1/admin/programs/${prog.id}`, {
                method: 'DELETE',
                headers: {
                  ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
              });
              if (res.ok) {
                setEditingProgram(null);
                await loadAcademicsData();
              } else {
                const msg = await extractErrorMessage(res, 'Failed to delete program');
                Alert.alert('Cannot Delete', msg);
              }
            } catch (e: any) {
              Alert.alert('Error', e?.message || 'Network error');
            } finally {
              setSubmitting(false);
            }
          },
        },
      ]
    );
  };

  // --- TIMETABLE HANDLERS ---
  const handleCreateTimetable = async () => {
    if (!ttTermId || !ttSectionId || !ttAssignmentId || !ttPeriodId) {
      setErrorMessage('Please select Term, Section, Assignment, and Period.');
      return;
    }
    setSubmitting(true);
    setErrorMessage(null);
    try {
      const token = SessionStore.getToken();
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/timetable`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          academic_term_id: ttTermId,
          class_section_id: ttSectionId,
          teaching_assignment_id: ttAssignmentId,
          academic_period_id: ttPeriodId,
          day_of_week: parseInt(ttDayOfWeek, 10) || 1,
          room_number: ttRoom.trim() || 'LH-101',
          is_active: true,
        }),
      });
      if (res.ok) {
        setActiveSheet('NONE');
        await loadAcademicsData();
      } else {
        const errorMsg = await extractErrorMessage(res, 'Failed to create timetable slot');
        setErrorMessage(errorMsg);
      }
    } catch (e: any) {
      setErrorMessage(e?.message || 'Network error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDeleteTimetable = (item: TimetableItem) => {
    Alert.alert(
      'Remove Timetable Entry',
      `Delete slot for ${item.subject_code || 'Subject'} on day ${item.day_of_week}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            setSubmitting(true);
            try {
              const token = SessionStore.getToken();
              const res = await fetch(`${API_BASE_URL}/api/v1/admin/timetable/${item.id}`, {
                method: 'DELETE',
                headers: {
                  ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
              });
              if (res.ok) {
                await loadAcademicsData();
              } else {
                const msg = await extractErrorMessage(res, 'Failed to delete timetable entry');
                Alert.alert('Cannot Delete', msg);
              }
            } catch (e: any) {
              Alert.alert('Error', e?.message || 'Network error');
            } finally {
              setSubmitting(false);
            }
          },
        },
      ]
    );
  };

  // --- SECTION ROSTER HANDLERS ---
  const handleOpenRoster = async (sec: SectionItem) => {
    setSelectedRosterSection(sec);
    setLoadingRoster(true);
    setRosterSearch('');
    try {
      const token = SessionStore.getToken();
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/sections/${sec.id}/roster`, {
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (res.ok) {
        const data = await res.json();
        setRosterStudents(data.students || []);
      } else {
        const msg = await extractErrorMessage(res, 'Failed to load roster');
        Alert.alert('Roster Error', msg);
      }
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Network error');
    } finally {
      setLoadingRoster(false);
    }
  };

  const handleUpdateStudentStatus = async (enrollmentId: string, newStatus: string) => {
    try {
      const token = SessionStore.getToken();
      const res = await fetch(`${API_BASE_URL}/api/v1/admin/enrollments/${enrollmentId}/status`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ status: newStatus }),
      });
      if (res.ok && selectedRosterSection) {
        await handleOpenRoster(selectedRosterSection);
      } else {
        const msg = await extractErrorMessage(res, 'Failed to update enrollment status');
        Alert.alert('Update Failed', msg);
      }
    } catch (e: any) {
      Alert.alert('Error', e?.message || 'Network error');
    }
  };

  if (!SessionStore.canManageAcademics()) {
    return (
      <AccessRestrictedView
        title="Academic Catalog Restricted"
        message="Your role does not grant permission to view or manage academic programs, departments, or course structures."
        requiredCapability="academic_structure.view or academic_structure.manage"
      />
    );
  }

  return (
    <Screen
      title="Academics"
      subtitle="Manage Departments, Subjects, Sections & Campuses"
      onBack={() => {
        if (router.canGoBack()) {
          router.back();
        } else {
          router.replace('/(faculty)' as any);
        }
      }}
      scrollable
    >
      {/* Segmented Catalog Navigator */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 16 }}>
        <View style={styles.segmentContainer}>
          <Pressable
            onPress={() => setCatalogTab('DEPTS')}
            style={[styles.segmentBtn, catalogTab === 'DEPTS' && styles.segmentBtnActive]}
          >
            <Text style={[styles.segmentBtnText, catalogTab === 'DEPTS' && styles.segmentBtnTextActive]}>
              Depts ({departments.length})
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setCatalogTab('PROGRAMS')}
            style={[styles.segmentBtn, catalogTab === 'PROGRAMS' && styles.segmentBtnActive]}
          >
            <Text style={[styles.segmentBtnText, catalogTab === 'PROGRAMS' && styles.segmentBtnTextActive]}>
              Programs ({programs.length})
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setCatalogTab('SUBJECTS')}
            style={[styles.segmentBtn, catalogTab === 'SUBJECTS' && styles.segmentBtnActive]}
          >
            <Text style={[styles.segmentBtnText, catalogTab === 'SUBJECTS' && styles.segmentBtnTextActive]}>
              Subjects ({subjects.length})
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setCatalogTab('SECTIONS')}
            style={[styles.segmentBtn, catalogTab === 'SECTIONS' && styles.segmentBtnActive]}
          >
            <Text style={[styles.segmentBtnText, catalogTab === 'SECTIONS' && styles.segmentBtnTextActive]}>
              Sections ({sections.length})
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setCatalogTab('TIMETABLE')}
            style={[styles.segmentBtn, catalogTab === 'TIMETABLE' && styles.segmentBtnActive]}
          >
            <Text style={[styles.segmentBtnText, catalogTab === 'TIMETABLE' && styles.segmentBtnTextActive]}>
              Timetable ({timetable.length})
            </Text>
          </Pressable>
          <Pressable
            onPress={() => setCatalogTab('CAMPUSES')}
            style={[styles.segmentBtn, catalogTab === 'CAMPUSES' && styles.segmentBtnActive]}
          >
            <Text style={[styles.segmentBtnText, catalogTab === 'CAMPUSES' && styles.segmentBtnTextActive]}>
              Campuses ({campuses.length})
            </Text>
          </Pressable>
        </View>
      </ScrollView>

      {/* --- TAB CONTENT: DEPARTMENTS --- */}
      {catalogTab === 'DEPTS' && (
        <View style={{ marginBottom: 16 }}>
          <SectionTitle>Departments</SectionTitle>
          <View style={styles.departmentsList}>
            {loading && departments.length === 0 ? (
              <ActivityIndicator color={Colors.forest} style={{ marginVertical: 20 }} />
            ) : departments.length === 0 ? (
              <Card style={styles.deptCard}>
                <Text style={[styles.deptSub, { textAlign: 'center', width: '100%' }]}>
                  No departments configured. Tap "Add department" below.
                </Text>
              </Card>
            ) : (
              departments.map((d) => (
                <Card
                  key={d.id}
                  style={styles.deptCard}
                  onPress={() => {
                    setEditingDept(d);
                    setEditDeptCode(d.code);
                    setEditDeptName(d.name);
                    setErrorMessage(null);
                  }}
                >
                  <IconBubble icon={Building2} tone="forest" size={42} />
                  <View style={styles.deptTextCol}>
                    <Text style={styles.deptName}>{d.name}</Text>
                    <Text style={styles.deptSub}>
                      {d.code} · {d.sections} sections · {d.subjects} subjects
                    </Text>
                  </View>
                  <ChevronRight size={18} color={Colors.soft} />
                </Card>
              ))
            )}
          </View>
        </View>
      )}

      {/* --- TAB CONTENT: PROGRAMS --- */}
      {catalogTab === 'PROGRAMS' && (
        <View style={{ marginBottom: 16 }}>
          <SectionTitle>Degree & Academic Programs</SectionTitle>
          <View style={styles.departmentsList}>
            {loading && programs.length === 0 ? (
              <ActivityIndicator color={Colors.forest} style={{ marginVertical: 20 }} />
            ) : programs.length === 0 ? (
              <Card style={styles.deptCard}>
                <Text style={[styles.deptSub, { textAlign: 'center', width: '100%' }]}>
                  No programs configured. Tap "Add program" below.
                </Text>
              </Card>
            ) : (
              programs.map((p) => (
                <Card
                  key={p.id}
                  style={styles.deptCard}
                  onPress={() => {
                    setEditingProgram(p);
                    setEditProgCode(p.code);
                    setEditProgName(p.name);
                    setErrorMessage(null);
                  }}
                >
                  <IconBubble icon={GraduationCap} tone="forest" size={42} />
                  <View style={styles.deptTextCol}>
                    <Text style={styles.deptName}>{p.name}</Text>
                    <Text style={styles.deptSub}>
                      Code: {p.code} · Dept: {p.department_name || p.department_id.slice(0, 8)}
                    </Text>
                  </View>
                  <ChevronRight size={18} color={Colors.soft} />
                </Card>
              ))
            )}
          </View>
        </View>
      )}

      {/* --- TAB CONTENT: SUBJECTS --- */}
      {catalogTab === 'SUBJECTS' && (
        <View style={{ marginBottom: 16 }}>
          <SectionTitle>Course Subjects</SectionTitle>
          <View style={styles.departmentsList}>
            {loading && subjects.length === 0 ? (
              <ActivityIndicator color={Colors.forest} style={{ marginVertical: 20 }} />
            ) : subjects.length === 0 ? (
              <Card style={styles.deptCard}>
                <Text style={[styles.deptSub, { textAlign: 'center', width: '100%' }]}>
                  No course subjects found. Tap "Add subject" below.
                </Text>
              </Card>
            ) : (
              subjects.map((s) => (
                <Card
                  key={s.id}
                  style={styles.deptCard}
                  onPress={() => {
                    setEditingSubject(s);
                    setEditSubCode(s.code);
                    setEditSubName(s.name);
                    setEditSubCredits(String(s.credits || 3));
                    setErrorMessage(null);
                  }}
                >
                  <IconBubble icon={BookOpen} tone="apricot" size={42} />
                  <View style={styles.deptTextCol}>
                    <Text style={styles.deptName}>{s.name}</Text>
                    <Text style={styles.deptSub}>
                      Code: {s.code} · {s.credits || 3} Credits
                    </Text>
                  </View>
                  <ChevronRight size={18} color={Colors.soft} />
                </Card>
              ))
            )}
          </View>
        </View>
      )}

      {/* --- TAB CONTENT: SECTIONS --- */}
      {catalogTab === 'SECTIONS' && (
        <View style={{ marginBottom: 16 }}>
          <SectionTitle>Class Sections</SectionTitle>
          <View style={styles.departmentsList}>
            {loading && sections.length === 0 ? (
              <ActivityIndicator color={Colors.forest} style={{ marginVertical: 20 }} />
            ) : sections.length === 0 ? (
              <Card style={styles.deptCard}>
                <Text style={[styles.deptSub, { textAlign: 'center', width: '100%' }]}>
                  No class sections configured. Tap "Add section" below.
                </Text>
              </Card>
            ) : (
              sections.map((sec) => (
                <Card
                  key={sec.id}
                  style={styles.deptCard}
                  onPress={() => {
                    setEditingSection(sec);
                    setEditSecCode(sec.section_code);
                    setEditSecCohort(String(sec.cohort_year || 2026));
                    setErrorMessage(null);
                  }}
                >
                  <IconBubble icon={Layers} tone="forest" size={42} />
                  <View style={styles.deptTextCol}>
                    <Text style={styles.deptName}>Section {sec.section_code}</Text>
                    <Text style={styles.deptSub}>
                      {sec.program_name ? `${sec.program_name} · ` : ''}Cohort: {sec.cohort_year || 2026}
                    </Text>
                  </View>
                  <Pressable
                    onPress={(e) => {
                      e.stopPropagation();
                      handleOpenRoster(sec);
                    }}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: 4,
                      backgroundColor: Colors.forest50,
                      paddingHorizontal: 10,
                      paddingVertical: 6,
                      borderRadius: 8,
                      marginRight: 6,
                    }}
                  >
                    <UserCheck size={14} color={Colors.forest} />
                    <Text style={{ fontSize: 12, fontWeight: '600', color: Colors.forest }}>Roster</Text>
                  </Pressable>
                  <ChevronRight size={18} color={Colors.soft} />
                </Card>
              ))
            )}
          </View>
        </View>
      )}

      {/* --- TAB CONTENT: TIMETABLE --- */}
      {catalogTab === 'TIMETABLE' && (
        <View style={{ marginBottom: 16 }}>
          <SectionTitle>Timetable & Period Schedule</SectionTitle>
          <View style={styles.departmentsList}>
            {loading && timetable.length === 0 ? (
              <ActivityIndicator color={Colors.forest} style={{ marginVertical: 20 }} />
            ) : timetable.length === 0 ? (
              <Card style={styles.deptCard}>
                <Text style={[styles.deptSub, { textAlign: 'center', width: '100%' }]}>
                  No timetable slots configured. Tap "Add timetable slot" below.
                </Text>
              </Card>
            ) : (
              timetable.map((tt) => {
                const dayNames = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
                const dayLabel = dayNames[tt.day_of_week] || `Day ${tt.day_of_week}`;
                return (
                  <Card key={tt.id} style={styles.deptCard}>
                    <IconBubble icon={Clock} tone="lilac" size={42} />
                    <View style={styles.deptTextCol}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <Text style={styles.deptName}>{tt.subject_code || 'Subject'}</Text>
                        <Chip tone="forest">{dayLabel}</Chip>
                        <Chip tone="secondary">{tt.period_name || `P${tt.period_number}`}</Chip>
                      </View>
                      <Text style={styles.deptSub}>
                        Sec: {tt.section_code || '—'} · Room: {tt.room_number || '—'}
                        {tt.faculty_name ? ` · ${tt.faculty_name}` : ''}
                      </Text>
                      {tt.start_time && tt.end_time && (
                        <Text style={[styles.deptSub, { fontSize: 11 }]}>
                          {tt.start_time.slice(0, 5)} - {tt.end_time.slice(0, 5)}
                        </Text>
                      )}
                    </View>
                    <Pressable
                      onPress={() => handleDeleteTimetable(tt)}
                      style={{ padding: 6 }}
                    >
                      <Trash2 size={16} color={Colors.rose} />
                    </Pressable>
                  </Card>
                );
              })
            )}
          </View>
        </View>
      )}

      {/* --- TAB CONTENT: CAMPUSES --- */}
      {catalogTab === 'CAMPUSES' && (
        <View style={{ marginBottom: 16 }}>
          <SectionTitle>Campuses</SectionTitle>
          <View style={styles.departmentsList}>
            {loading && campuses.length === 0 ? (
              <ActivityIndicator color={Colors.forest} style={{ marginVertical: 20 }} />
            ) : campuses.length === 0 ? (
              <Card style={styles.deptCard}>
                <Text style={[styles.deptSub, { textAlign: 'center', width: '100%' }]}>
                  No campuses configured. Tap "Add campus" below.
                </Text>
              </Card>
            ) : (
              campuses.map((c) => (
                <Card
                  key={c.id}
                  style={styles.deptCard}
                  onPress={() => {
                    setEditingCampus(c);
                    setEditCampusName(c.name);
                    setEditCampusStatus(c.status);
                    setErrorMessage(null);
                  }}
                >
                  <IconBubble icon={Landmark} tone="lilac" size={42} />
                  <View style={styles.deptTextCol}>
                    <Text style={styles.deptName}>{c.name}</Text>
                    <Text style={styles.deptSub}>
                      Code: {c.code} · Status: {c.status}
                    </Text>
                  </View>
                  <Chip tone={c.status === 'ACTIVE' ? 'forest' : 'rose'}>{c.status}</Chip>
                  <ChevronRight size={18} color={Colors.soft} style={{ marginLeft: 6 }} />
                </Card>
              ))
            )}
          </View>
        </View>
      )}

      {/* Quick Actions */}
      <SectionTitle>Quick Actions</SectionTitle>
      {SessionStore.canEditAcademics() ? (
        <View style={styles.actionsGrid}>
          {/* 0. Add Campus */}
          <Card
            onPress={() => {
              setErrorMessage(null);
              setActiveSheet('CAMPUS');
            }}
            style={styles.actionCard}
            accessibilityRole="button"
            accessibilityLabel="Add campus"
            accessibilityHint="Opens sheet to establish a new campus"
          >
            <Landmark size={24} color={Colors.forest} />
            <Text style={styles.actionLabel}>Add campus</Text>
          </Card>

          {/* 1. Add Department */}
          <Card
            onPress={() => {
              setErrorMessage(null);
              setActiveSheet('DEPT');
            }}
            style={styles.actionCard}
            accessibilityRole="button"
            accessibilityLabel="Add department"
            accessibilityHint="Opens sheet to create a department"
          >
            <Building2 size={24} color={Colors.forest} />
            <Text style={styles.actionLabel}>Add department</Text>
          </Card>

          {/* 2. Add Subject */}
          <Card
            onPress={() => {
              setErrorMessage(null);
              setActiveSheet('SUBJECT');
            }}
            style={styles.actionCard}
            accessibilityRole="button"
            accessibilityLabel="Add subject"
            accessibilityHint="Opens sheet to create a subject"
          >
            <BookOpen size={24} color={Colors.forest} />
            <Text style={styles.actionLabel}>Add subject</Text>
          </Card>

          {/* 3. Add Section */}
          <Card
            onPress={() => {
              setErrorMessage(null);
              setActiveSheet('SECTION');
            }}
            style={styles.actionCard}
            accessibilityRole="button"
            accessibilityLabel="Add section"
            accessibilityHint="Opens sheet to add a class section"
          >
            <Plus size={24} color={Colors.forest} />
            <Text style={styles.actionLabel}>Add section</Text>
          </Card>

          {/* 4. Assign Teacher */}
          <Card
            onPress={() => {
              setErrorMessage(null);
              setActiveSheet('ASSIGN');
            }}
            style={styles.actionCard}
            accessibilityRole="button"
            accessibilityLabel="Assign teacher"
            accessibilityHint="Opens sheet to assign faculty to section"
          >
            <Link2 size={24} color={Colors.forest} />
            <Text style={styles.actionLabel}>Assign teacher</Text>
          </Card>

          {/* 5. Add Program */}
          <Card
            onPress={() => {
              setErrorMessage(null);
              setActiveSheet('PROGRAM');
            }}
            style={styles.actionCard}
            accessibilityRole="button"
            accessibilityLabel="Add program"
            accessibilityHint="Opens sheet to establish an academic program"
          >
            <GraduationCap size={24} color={Colors.forest} />
            <Text style={styles.actionLabel}>Add program</Text>
          </Card>

          {/* 6. Add Timetable Slot */}
          <Card
            onPress={() => {
              setErrorMessage(null);
              setActiveSheet('TIMETABLE');
            }}
            style={styles.actionCard}
            accessibilityRole="button"
            accessibilityLabel="Add timetable slot"
            accessibilityHint="Opens sheet to schedule a period slot"
          >
            <Clock size={24} color={Colors.forest} />
            <Text style={styles.actionLabel}>Add timetable slot</Text>
          </Card>
        </View>
      ) : (
        <Card style={{ padding: 14, alignItems: 'center', marginVertical: 8 }}>
          <Text style={{ color: Colors.soft, fontSize: 13, textAlign: 'center' }}>
            Catalog Read-Only: Structure creation and teacher assignment require Registrar or Administrator privileges.
          </Text>
        </Card>
      )}

      {/* ========================================================================= */}
      {/* EDIT SHEETS                                                               */}
      {/* ========================================================================= */}

      {/* --- EDIT DEPARTMENT SHEET --- */}
      {editingDept && (
        <Sheet visible={!!editingDept} onClose={() => setEditingDept(null)}>
          <Text style={styles.sheetTitle}>Manage Department</Text>
          <Text style={styles.sheetSub}>Update code or name, or delete department</Text>

          {errorMessage && <Text style={styles.errorBanner}>{errorMessage}</Text>}

          <Text style={styles.inputLabel}>Department Code</Text>
          <TextInput
            value={editDeptCode}
            onChangeText={setEditDeptCode}
            autoCapitalize="characters"
            style={styles.textInput}
          />

          <Text style={styles.inputLabel}>Department Name</Text>
          <TextInput
            value={editDeptName}
            onChangeText={setEditDeptName}
            style={styles.textInput}
          />

          <View style={{ marginTop: 20, gap: 10 }}>
            <Button
              tone="forest"
              disabled={submitting}
              onPress={handleUpdateDepartment}
            >
              {submitting ? 'Saving…' : 'Save Changes'}
            </Button>
            <Button
              tone="rose"
              disabled={submitting}
              onPress={() => handleDeleteDepartment(editingDept)}
            >
              Delete Department
            </Button>
          </View>
        </Sheet>
      )}

      {/* --- EDIT SUBJECT SHEET --- */}
      {editingSubject && (
        <Sheet visible={!!editingSubject} onClose={() => setEditingSubject(null)}>
          <Text style={styles.sheetTitle}>Manage Course Subject</Text>
          <Text style={styles.sheetSub}>Update subject details or delete</Text>

          {errorMessage && <Text style={styles.errorBanner}>{errorMessage}</Text>}

          <Text style={styles.inputLabel}>Subject Code</Text>
          <TextInput
            value={editSubCode}
            onChangeText={setEditSubCode}
            autoCapitalize="characters"
            style={styles.textInput}
          />

          <Text style={styles.inputLabel}>Subject Name</Text>
          <TextInput
            value={editSubName}
            onChangeText={setEditSubName}
            style={styles.textInput}
          />

          <Text style={styles.inputLabel}>Credits</Text>
          <TextInput
            value={editSubCredits}
            onChangeText={setEditSubCredits}
            keyboardType="numeric"
            style={styles.textInput}
          />

          <View style={{ marginTop: 20, gap: 10 }}>
            <Button
              tone="forest"
              disabled={submitting}
              onPress={handleUpdateSubject}
            >
              {submitting ? 'Saving…' : 'Save Changes'}
            </Button>
            <Button
              tone="rose"
              disabled={submitting}
              onPress={() => handleDeleteSubject(editingSubject)}
            >
              Delete Subject
            </Button>
          </View>
        </Sheet>
      )}

      {/* --- EDIT SECTION SHEET --- */}
      {editingSection && (
        <Sheet visible={!!editingSection} onClose={() => setEditingSection(null)}>
          <Text style={styles.sheetTitle}>Manage Class Section</Text>
          <Text style={styles.sheetSub}>Update section code, cohort year, or delete</Text>

          {errorMessage && <Text style={styles.errorBanner}>{errorMessage}</Text>}

          <Text style={styles.inputLabel}>Section Code</Text>
          <TextInput
            value={editSecCode}
            onChangeText={setEditSecCode}
            autoCapitalize="characters"
            style={styles.textInput}
          />

          <Text style={styles.inputLabel}>Cohort Year</Text>
          <TextInput
            value={editSecCohort}
            onChangeText={setEditSecCohort}
            keyboardType="numeric"
            style={styles.textInput}
          />

          <View style={{ marginTop: 20, gap: 10 }}>
            <Button
              tone="forest"
              disabled={submitting}
              onPress={handleUpdateSection}
            >
              {submitting ? 'Saving…' : 'Save Changes'}
            </Button>
            <Button
              tone="rose"
              disabled={submitting}
              onPress={() => handleDeleteSection(editingSection)}
            >
              Delete Class Section
            </Button>
          </View>
        </Sheet>
      )}

      {/* --- EDIT CAMPUS SHEET --- */}
      {editingCampus && (
        <Sheet visible={!!editingCampus} onClose={() => setEditingCampus(null)}>
          <Text style={styles.sheetTitle}>Manage Campus ({editingCampus.code})</Text>
          <Text style={styles.sheetSub}>Update name, status, or delete campus</Text>

          {errorMessage && <Text style={styles.errorBanner}>{errorMessage}</Text>}

          <Text style={styles.inputLabel}>Campus Name</Text>
          <TextInput
            value={editCampusName}
            onChangeText={setEditCampusName}
            style={styles.textInput}
          />

          <Text style={styles.inputLabel}>Status</Text>
          <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
            {(['ACTIVE', 'INACTIVE'] as const).map((st) => (
              <Pressable
                key={st}
                onPress={() => setEditCampusStatus(st)}
                style={[
                  styles.pickerChip,
                  editCampusStatus === st && styles.pickerChipActive,
                ]}
              >
                <Text style={[styles.pickerChipText, editCampusStatus === st && styles.pickerChipTextActive]}>
                  {st}
                </Text>
              </Pressable>
            ))}
          </View>

          <View style={{ marginTop: 20, gap: 10 }}>
            <Button
              tone="forest"
              disabled={submitting}
              onPress={handleUpdateCampus}
            >
              {submitting ? 'Saving…' : 'Save Changes'}
            </Button>
            <Button
              tone="rose"
              disabled={submitting}
              onPress={() => handleDeleteCampus(editingCampus)}
            >
              Delete Campus
            </Button>
          </View>
        </Sheet>
      )}

      {/* --- EDIT PROGRAM SHEET --- */}
      {editingProgram && (
        <Sheet visible={!!editingProgram} onClose={() => setEditingProgram(null)}>
          <Text style={styles.sheetTitle}>Manage Academic Program</Text>
          <Text style={styles.sheetSub}>Update program code, name, or delete program</Text>

          {errorMessage && <Text style={styles.errorBanner}>{errorMessage}</Text>}

          <Text style={styles.inputLabel}>Program Code</Text>
          <TextInput
            value={editProgCode}
            onChangeText={setEditProgCode}
            autoCapitalize="characters"
            style={styles.textInput}
          />

          <Text style={styles.inputLabel}>Program Name</Text>
          <TextInput
            value={editProgName}
            onChangeText={setEditProgName}
            style={styles.textInput}
          />

          <View style={{ marginTop: 20, gap: 10 }}>
            <Button
              tone="forest"
              disabled={submitting}
              onPress={handleUpdateProgram}
            >
              {submitting ? 'Saving…' : 'Save Changes'}
            </Button>
            <Button
              tone="rose"
              disabled={submitting}
              onPress={() => handleDeleteProgram(editingProgram)}
            >
              Delete Program
            </Button>
          </View>
        </Sheet>
      )}

      {/* ========================================================================= */}
      {/* CREATION SHEETS                                                           */}
      {/* ========================================================================= */}

      {/* --- SHEET 0: ADD CAMPUS --- */}
      <Sheet visible={activeSheet === 'CAMPUS'} onClose={() => setActiveSheet('NONE')}>
        <Text style={styles.sheetTitle}>Add Campus</Text>
        <Text style={styles.sheetSub}>Establish a physical or branch campus within this institution</Text>

        {errorMessage && <Text style={styles.errorBanner}>{errorMessage}</Text>}

        <Text style={styles.inputLabel}>Campus Code</Text>
        <TextInput
          value={campusCode}
          onChangeText={setCampusCode}
          placeholder="e.g. NORTH, SOUTH, MAIN"
          placeholderTextColor={Colors.soft}
          autoCapitalize="characters"
          style={styles.textInput}
        />

        <Text style={styles.inputLabel}>Campus Name</Text>
        <TextInput
          value={campusName}
          onChangeText={setCampusName}
          placeholder="e.g. North Innovation Campus"
          placeholderTextColor={Colors.soft}
          style={styles.textInput}
        />

        <View style={{ marginTop: 24 }}>
          <Button
            tone="forest"
            onPress={handleCreateCampus}
            disabled={submitting}
          >
            {submitting ? 'Creating...' : 'Create Campus'}
          </Button>
        </View>
      </Sheet>

      {/* --- SHEET 1: ADD DEPARTMENT --- */}
      <Sheet visible={activeSheet === 'DEPT'} onClose={() => setActiveSheet('NONE')}>
        <Text style={styles.sheetTitle}>Add Department</Text>
        <Text style={styles.sheetSub}>Create an institutional department code and name</Text>

        {errorMessage && <Text style={styles.errorBanner}>{errorMessage}</Text>}

        <Text style={styles.inputLabel}>Department Code</Text>
        <TextInput
          value={deptCode}
          onChangeText={setDeptCode}
          placeholder="e.g. ECE, MECH, AIDS"
          placeholderTextColor={Colors.soft}
          autoCapitalize="characters"
          style={styles.textInput}
        />

        <Text style={styles.inputLabel}>Department Name</Text>
        <TextInput
          value={deptName}
          onChangeText={setDeptName}
          placeholder="e.g. Electronics & Communication Engineering"
          placeholderTextColor={Colors.soft}
          style={styles.textInput}
        />

        <View style={{ marginTop: 20 }}>
          <Button
            tone="forest"
            disabled={submitting}
            onPress={handleCreateDepartment}
          >
            {submitting ? 'Creating…' : 'Create Department'}
          </Button>
        </View>
      </Sheet>

      {/* --- SHEET 2: ADD SUBJECT --- */}
      <Sheet visible={activeSheet === 'SUBJECT'} onClose={() => setActiveSheet('NONE')}>
        <Text style={styles.sheetTitle}>Add Subject</Text>
        <Text style={styles.sheetSub}>Create a course subject associated with a department</Text>

        {errorMessage && <Text style={styles.errorBanner}>{errorMessage}</Text>}

        <Text style={styles.inputLabel}>Subject Code</Text>
        <TextInput
          value={subCode}
          onChangeText={setSubCode}
          placeholder="e.g. CS302, EC201"
          placeholderTextColor={Colors.soft}
          autoCapitalize="characters"
          style={styles.textInput}
        />

        <Text style={styles.inputLabel}>Subject Name</Text>
        <TextInput
          value={subName}
          onChangeText={setSubName}
          placeholder="e.g. Database Management Systems"
          placeholderTextColor={Colors.soft}
          style={styles.textInput}
        />

        <Text style={styles.inputLabel}>Select Department</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {(rawDepartments.length > 0 ? rawDepartments : departments).map((d) => (
              <Pressable
                key={d.id}
                onPress={() => setSubDeptId(d.id)}
                style={[
                  styles.pickerChip,
                  subDeptId === d.id && styles.pickerChipActive,
                ]}
              >
                <Text style={[styles.pickerChipText, subDeptId === d.id && styles.pickerChipTextActive]}>
                  {d.code || d.name}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        <Text style={styles.inputLabel}>Credits</Text>
        <TextInput
          value={subCredits}
          onChangeText={setSubCredits}
          placeholder="3"
          placeholderTextColor={Colors.soft}
          keyboardType="numeric"
          style={styles.textInput}
        />

        <View style={{ marginTop: 20 }}>
          <Button
            tone="forest"
            disabled={submitting}
            onPress={handleCreateSubject}
          >
            {submitting ? 'Creating…' : 'Create Subject'}
          </Button>
        </View>
      </Sheet>

      {/* --- SHEET 3: ADD CLASS SECTION --- */}
      <Sheet visible={activeSheet === 'SECTION'} onClose={() => setActiveSheet('NONE')}>
        <Text style={styles.sheetTitle}>Add Class Section</Text>
        <Text style={styles.sheetSub}>Create an academic section cohort (e.g. CSE 3B)</Text>

        {errorMessage && <Text style={styles.errorBanner}>{errorMessage}</Text>}

        <Text style={styles.inputLabel}>Section Code</Text>
        <TextInput
          value={secCode}
          onChangeText={setSecCode}
          placeholder="e.g. CSE 3B, ECE 2A"
          placeholderTextColor={Colors.soft}
          style={styles.textInput}
        />

        <Text style={styles.inputLabel}>Select Department</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {(rawDepartments.length > 0 ? rawDepartments : departments).map((d) => (
              <Pressable
                key={d.id}
                onPress={() => setSecDeptId(d.id)}
                style={[
                  styles.pickerChip,
                  secDeptId === d.id && styles.pickerChipActive,
                ]}
              >
                <Text style={[styles.pickerChipText, secDeptId === d.id && styles.pickerChipTextActive]}>
                  {d.code || d.name}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        <Text style={styles.inputLabel}>Select Academic Term</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {terms.map((t) => (
              <Pressable
                key={t.id}
                onPress={() => setSecTermId(t.id)}
                style={[
                  styles.pickerChip,
                  secTermId === t.id && styles.pickerChipActive,
                ]}
              >
                <Text style={[styles.pickerChipText, secTermId === t.id && styles.pickerChipTextActive]}>
                  {t.code || t.name}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        <Text style={styles.inputLabel}>Cohort Year</Text>
        <TextInput
          value={secCohort}
          onChangeText={setSecCohort}
          placeholder="2026"
          placeholderTextColor={Colors.soft}
          keyboardType="numeric"
          style={styles.textInput}
        />

        <View style={{ marginTop: 20 }}>
          <Button
            tone="forest"
            disabled={submitting}
            onPress={handleCreateSection}
          >
            {submitting ? 'Creating…' : 'Create Section'}
          </Button>
        </View>
      </Sheet>

      {/* --- SHEET 4: ASSIGN FACULTY --- */}
      <Sheet visible={activeSheet === 'ASSIGN'} onClose={() => setActiveSheet('NONE')}>
        <Text style={styles.sheetTitle}>Assign Faculty to Class</Text>
        <Text style={styles.sheetSub}>Grant teaching and attendance permissions for a class section</Text>

        {errorMessage && <Text style={styles.errorBanner}>{errorMessage}</Text>}

        <Text style={styles.inputLabel}>Select Faculty</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {facultyUsers.map((f) => (
              <Pressable
                key={f.id}
                onPress={() => setAssignFacultyId(f.id)}
                style={[
                  styles.pickerChip,
                  assignFacultyId === f.id && styles.pickerChipActive,
                ]}
              >
                <Text style={[styles.pickerChipText, assignFacultyId === f.id && styles.pickerChipTextActive]}>
                  {f.name}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        <Text style={styles.inputLabel}>Select Section</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {sections.map((sec) => (
              <Pressable
                key={sec.id}
                onPress={() => setAssignSecId(sec.id)}
                style={[
                  styles.pickerChip,
                  assignSecId === sec.id && styles.pickerChipActive,
                ]}
              >
                <Text style={[styles.pickerChipText, assignSecId === sec.id && styles.pickerChipTextActive]}>
                  {sec.section_code}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        <Text style={styles.inputLabel}>Select Subject</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {subjects.map((sub) => (
              <Pressable
                key={sub.id}
                onPress={() => setAssignSubId(sub.id)}
                style={[
                  styles.pickerChip,
                  assignSubId === sub.id && styles.pickerChipActive,
                ]}
              >
                <Text style={[styles.pickerChipText, assignSubId === sub.id && styles.pickerChipTextActive]}>
                  {sub.code} · {sub.name}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        <View style={{ marginTop: 20 }}>
          <Button
            tone="forest"
            disabled={submitting}
            onPress={handleAssignFaculty}
          >
            {submitting ? 'Assigning…' : 'Confirm Teaching Assignment'}
          </Button>
        </View>
      </Sheet>

      {/* --- SHEET: ADD PROGRAM --- */}
      <Sheet visible={activeSheet === 'PROGRAM'} onClose={() => setActiveSheet('NONE')}>
        <Text style={styles.sheetTitle}>Add Academic Program</Text>
        <Text style={styles.sheetSub}>Establish a degree program (e.g. B.Tech CSE, MBA, MCA)</Text>

        {errorMessage && <Text style={styles.errorBanner}>{errorMessage}</Text>}

        <Text style={styles.inputLabel}>Program Code</Text>
        <TextInput
          value={progCode}
          onChangeText={setProgCode}
          placeholder="e.g. BTECH-CSE, MBA-FIN"
          placeholderTextColor={Colors.soft}
          autoCapitalize="characters"
          style={styles.textInput}
        />

        <Text style={styles.inputLabel}>Program Name</Text>
        <TextInput
          value={progName}
          onChangeText={setProgName}
          placeholder="e.g. Bachelor of Technology in Computer Science"
          placeholderTextColor={Colors.soft}
          style={styles.textInput}
        />

        <Text style={styles.inputLabel}>Department</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {(rawDepartments.length > 0 ? rawDepartments : departments).map((d) => (
              <Pressable
                key={d.id}
                onPress={() => setProgDeptId(d.id)}
                style={[
                  styles.pickerChip,
                  progDeptId === d.id && styles.pickerChipActive,
                ]}
              >
                <Text style={[styles.pickerChipText, progDeptId === d.id && styles.pickerChipTextActive]}>
                  {d.code || d.name}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        <View style={{ marginTop: 20 }}>
          <Button
            tone="forest"
            disabled={submitting}
            onPress={handleCreateProgram}
          >
            {submitting ? 'Creating…' : 'Create Program'}
          </Button>
        </View>
      </Sheet>

      {/* --- SHEET: ADD TIMETABLE SLOT --- */}
      <Sheet visible={activeSheet === 'TIMETABLE'} onClose={() => setActiveSheet('NONE')}>
        <Text style={styles.sheetTitle}>Add Timetable Slot</Text>
        <Text style={styles.sheetSub}>Schedule a course offering period with double-booking validation</Text>

        {errorMessage && <Text style={styles.errorBanner}>{errorMessage}</Text>}

        <Text style={styles.inputLabel}>Select Teaching Assignment</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {assignments.map((a) => (
              <Pressable
                key={a.id}
                onPress={() => {
                  setTtAssignmentId(a.id);
                  setTtSectionId(a.class_section_id);
                  setTtTermId(a.academic_term_id);
                }}
                style={[
                  styles.pickerChip,
                  ttAssignmentId === a.id && styles.pickerChipActive,
                ]}
              >
                <Text style={[styles.pickerChipText, ttAssignmentId === a.id && styles.pickerChipTextActive]}>
                  {a.subject_code || 'Course'} · {a.section_code || 'Sec'} ({a.faculty_name || 'Faculty'})
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        <Text style={styles.inputLabel}>Select Period</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {periods
              .filter((p) => !p.is_break)
              .map((p) => (
                <Pressable
                  key={p.id}
                  onPress={() => setTtPeriodId(p.id)}
                  style={[
                    styles.pickerChip,
                    ttPeriodId === p.id && styles.pickerChipActive,
                  ]}
                >
                  <Text style={[styles.pickerChipText, ttPeriodId === p.id && styles.pickerChipTextActive]}>
                    P{p.period_number} ({p.start_time.slice(0, 5)})
                  </Text>
                </Pressable>
              ))}
          </View>
        </ScrollView>

        <Text style={styles.inputLabel}>Day of Week</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {[
              { day: '1', label: 'Mon' },
              { day: '2', label: 'Tue' },
              { day: '3', label: 'Wed' },
              { day: '4', label: 'Thu' },
              { day: '5', label: 'Fri' },
              { day: '6', label: 'Sat' },
            ].map((d) => (
              <Pressable
                key={d.day}
                onPress={() => setTtDayOfWeek(d.day)}
                style={[
                  styles.pickerChip,
                  ttDayOfWeek === d.day && styles.pickerChipActive,
                ]}
              >
                <Text style={[styles.pickerChipText, ttDayOfWeek === d.day && styles.pickerChipTextActive]}>
                  {d.label}
                </Text>
              </Pressable>
            ))}
          </View>
        </ScrollView>

        <Text style={styles.inputLabel}>Room / Hall</Text>
        <TextInput
          value={ttRoom}
          onChangeText={setTtRoom}
          placeholder="e.g. LH-101, LAB-B"
          placeholderTextColor={Colors.soft}
          style={styles.textInput}
        />

        <View style={{ marginTop: 20 }}>
          <Button
            tone="forest"
            disabled={submitting}
            onPress={handleCreateTimetable}
          >
            {submitting ? 'Scheduling…' : 'Schedule Slot'}
          </Button>
        </View>
      </Sheet>

      {/* --- SECTION ROSTER MODAL SHEET --- */}
      {selectedRosterSection && (
        <Sheet visible={!!selectedRosterSection} onClose={() => setSelectedRosterSection(null)}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <Text style={styles.sheetTitle}>Section {selectedRosterSection.section_code} Roster</Text>
            <Chip tone="forest">{rosterStudents.length} Students</Chip>
          </View>
          <Text style={styles.sheetSub}>
            Cohort: {selectedRosterSection.cohort_year || 2026} · Active academic section roster
          </Text>

          <View style={[styles.textInput, { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, gap: 8, marginBottom: 12 }]}>
            <Search size={16} color={Colors.soft} />
            <TextInput
              placeholder="Search by name, roll, or email..."
              placeholderTextColor={Colors.soft}
              value={rosterSearch}
              onChangeText={setRosterSearch}
              style={{ flex: 1, fontSize: 13, color: Colors.ink, padding: 0 }}
            />
          </View>

          {loadingRoster ? (
            <ActivityIndicator color={Colors.forest} style={{ marginVertical: 30 }} />
          ) : rosterStudents.length === 0 ? (
            <Text style={{ textAlign: 'center', color: Colors.soft, marginVertical: 20 }}>
              No students enrolled in this section.
            </Text>
          ) : (
            <ScrollView style={{ maxHeight: 350 }}>
              <View style={{ gap: 8, paddingBottom: 16 }}>
                {rosterStudents
                  .filter((st) => {
                    const q = rosterSearch.toLowerCase();
                    return (
                      st.student_name.toLowerCase().includes(q) ||
                      st.institutional_id.toLowerCase().includes(q) ||
                      st.email.toLowerCase().includes(q)
                    );
                  })
                  .map((st) => {
                    const faceTone =
                      st.face_registration_state === 'REGISTERED'
                        ? 'forest'
                        : st.face_registration_state === 'PENDING'
                        ? 'apricot'
                        : 'soft';

                    const statusTone =
                      st.enrollment_status === 'ACTIVE'
                        ? 'forest'
                        : st.enrollment_status === 'TRANSFERRED'
                        ? 'apricot'
                        : 'rose';

                    return (
                      <View
                        key={st.enrollment_id}
                        style={{
                          backgroundColor: Colors.card,
                          borderRadius: 10,
                          borderWidth: 1,
                          borderColor: Colors.line,
                          padding: 10,
                        }}
                      >
                        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                          <View style={{ flex: 1 }}>
                            <Text style={{ fontSize: 14, fontWeight: '700', color: Colors.ink }}>
                              {st.student_name}
                            </Text>
                            <Text style={{ fontSize: 11, color: Colors.soft }}>
                              ID: {st.institutional_id} · {st.email}
                            </Text>
                          </View>
                          <View style={{ alignItems: 'flex-end', gap: 4 }}>
                            <Chip tone={statusTone}>{st.enrollment_status}</Chip>
                            <Chip tone={faceTone}>{st.face_registration_state}</Chip>
                          </View>
                        </View>
                        {/* Status Quick Actions */}
                        <View style={{ flexDirection: 'row', gap: 6, marginTop: 8, justifyContent: 'flex-end' }}>
                          {st.enrollment_status !== 'ACTIVE' && (
                            <Pressable
                              onPress={() => handleUpdateStudentStatus(st.enrollment_id, 'ACTIVE')}
                              style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: Colors.forest50 }}
                            >
                              <Text style={{ fontSize: 10, fontWeight: '600', color: Colors.forest }}>Set Active</Text>
                            </Pressable>
                          )}
                          {st.enrollment_status !== 'TRANSFERRED' && (
                            <Pressable
                              onPress={() => handleUpdateStudentStatus(st.enrollment_id, 'TRANSFERRED')}
                              style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: Colors.apricot50 }}
                            >
                              <Text style={{ fontSize: 10, fontWeight: '600', color: Colors.apricot }}>Transfer</Text>
                            </Pressable>
                          )}
                          {st.enrollment_status !== 'WITHDRAWN' && (
                            <Pressable
                              onPress={() => handleUpdateStudentStatus(st.enrollment_id, 'WITHDRAWN')}
                              style={{ paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, backgroundColor: '#ffebe9' }}
                            >
                              <Text style={{ fontSize: 10, fontWeight: '600', color: Colors.rose }}>Withdraw</Text>
                            </Pressable>
                          )}
                        </View>
                      </View>
                    );
                  })}
              </View>
            </ScrollView>
          )}

          <Button
            variant="soft"
            onPress={() => setSelectedRosterSection(null)}
            style={{ marginTop: 12 }}
          >
            Close Roster
          </Button>
        </Sheet>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  segmentContainer: {
    flexDirection: 'row',
    backgroundColor: Colors.line,
    borderRadius: Radii.button,
    padding: 4,
    marginBottom: 16,
  },
  segmentBtn: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    borderRadius: Radii.button - 4,
  },
  segmentBtnActive: {
    backgroundColor: Colors.card,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
  },
  segmentBtnText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.soft,
  },
  segmentBtnTextActive: {
    color: Colors.ink,
    fontWeight: '700',
  },
  departmentsList: {
    gap: 10,
    marginBottom: 8,
  },
  deptCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
  },
  deptTextCol: {
    flex: 1,
  },
  deptName: {
    fontSize: 15,
    fontWeight: '600',
    color: Colors.ink,
  },
  deptSub: {
    fontSize: 12,
    color: Colors.soft,
    marginTop: 2,
  },
  actionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    marginBottom: 20,
  },
  actionCard: {
    width: '48%',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 20,
    gap: 8,
  },
  actionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: Colors.ink,
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
