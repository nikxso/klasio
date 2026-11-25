import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
  TextInput,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  Sparkles,
  BarChart3,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  Users,
  FileSpreadsheet,
  Download,
  Check,
  Search,
  Calendar,
  Filter,
} from 'lucide-react-native';
import Svg, {
  Defs,
  LinearGradient,
  Stop,
  Polygon,
  Polyline,
  Circle,
} from 'react-native-svg';

import { Screen, Card, Chip, SectionTitle, Avatar, Button, AccessRestrictedView } from '@/components/ui/kit';
import { Colors, Radii, Shadows } from '@/theme/tokens';
import { API_BASE_URL } from '@/config/api';
import { SessionStore } from '@/storage/sessionStore';
import { saveReportFile } from '@/services/nativePerception';
import {
  AttendanceBarChart,
  AttendanceTrendLineChart,
  AttendanceDistributionHistogram,
  HistogramBin,
} from '@/components/charts';

export interface ReportStudentAttention {
  id: string;
  name: string;
  institutionalId: string;
  pct: number | null;
  attended: number;
  held: number;
  run: number;
  classesToRecover: number | null;
  canMiss: number;
  isShortage: boolean;
  isRecoverable?: boolean;
}

export interface ReportWeeklyPoint {
  label: string;
  pct: number | null;
}

export interface ReportAssignmentData {
  id: string;
  subjectCode: string;
  subjectName: string;
  sectionCode: string;
  room: string;
  held: number;
  avgPct: number | null;
  threshold: number;
  trend: ReportWeeklyPoint[];
  studentsNeedingAttention: ReportStudentAttention[];
}

const CHART_WIDTH = 320;
const CHART_HEIGHT = 110;

export default function FacultyReportsScreen() {
  const router = useRouter();

  if (!SessionStore.canViewReports()) {
    return (
      <AccessRestrictedView
        title="Reports Restricted"
        message="Attendance analytics and recovery reports are restricted to authorized academic personnel."
        requiredCapability="reports.view"
        onBack={() => router.replace('/(faculty)')}
      />
    );
  }

  const [reportList, setReportList] = useState<ReportAssignmentData[]>([]);
  const [selectedId, setSelectedId] = useState<string>('');
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [shortageOnly, setShortageOnly] = useState<boolean>(false);
  const [exporting, setExporting] = useState<boolean>(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  // Dynamic Academic Years and Terms filter
  const [academicYears, setAcademicYears] = useState<string[]>(['2026-2027']);
  const [selectedYear, setSelectedYear] = useState<string>('2026-2027');

  // Faculty scope filters
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [dateRange, setDateRange] = useState<'ALL' | '30D' | '7D'>('ALL');
  const [dynamicAnalytics, setDynamicAnalytics] = useState<any | null>(null);

  // Load dynamic academic terms and assignments
  const loadMetadata = useCallback(async () => {
    try {
      const token = SessionStore.getToken();
      if (!token) return;

      // 1. Fetch academic terms & years
      const termsRes = await fetch(`${API_BASE_URL}/api/v1/faculty/academic-terms`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (termsRes.ok) {
        const termsData = await termsRes.json();
        if (termsData.academic_years && termsData.academic_years.length > 0) {
          setAcademicYears(termsData.academic_years);
        }
      }

      // 2. Fetch assignments
      const assignRes = await fetch(`${API_BASE_URL}/api/v1/faculty/assignments`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      });
      if (assignRes.ok) {
        const assignData = await assignRes.json();
        if (Array.isArray(assignData) && assignData.length > 0) {
          const mapped: ReportAssignmentData[] = assignData.map((a: any) => ({
            id: a.teaching_assignment_id || a.id,
            subjectCode: a.subject_code,
            subjectName: a.subject_name,
            sectionCode: a.section_code,
            room: a.room || 'LH-204',
            held: a.held_count || 12,
            avgPct: a.average_attendance_pct != null ? Math.round(a.average_attendance_pct) : 88,
            threshold: 75,
            trend: [
              { label: 'Oct W1', pct: 85 },
              { label: 'Oct W2', pct: 89 },
              { label: 'Oct W3', pct: 90 },
              { label: 'Now', pct: 88 },
            ],
            studentsNeedingAttention: [],
          }));
          setReportList(mapped);
          setSelectedId(mapped[0].id);
        }
      }
    } catch (err) {
      console.warn('Failed to load reports metadata:', err);
    }
  }, []);

  // Load detailed analytics for selected assignment
  const loadSectionAnalytics = useCallback(async (assignmentId: string) => {
    try {
      const token = SessionStore.getToken();
      if (!token) return;

      let dateQuery = '';
      if (dateRange === '30D') {
        const d = new Date();
        d.setDate(d.getDate() - 30);
        dateQuery = `&start_date=${d.toISOString().split('T')[0]}`;
      } else if (dateRange === '7D') {
        const d = new Date();
        d.setDate(d.getDate() - 7);
        dateQuery = `&start_date=${d.toISOString().split('T')[0]}`;
      }

      const res = await fetch(
        `${API_BASE_URL}/api/v1/analytics/assignments/${assignmentId}?threshold=75${dateQuery}`,
        {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        }
      );
      if (res.ok) {
        const data = await res.json();
        setDynamicAnalytics(data);
      }
    } catch (err) {
      console.warn('Failed to load section analytics:', err);
    }
  }, [dateRange]);

  useEffect(() => {
    loadMetadata();
  }, [loadMetadata]);

  useEffect(() => {
    if (selectedId) {
      loadSectionAnalytics(selectedId);
    }
  }, [selectedId, loadSectionAnalytics]);

  const currentAssignment = useMemo(() => {
    return reportList.find((item) => item.id === selectedId) || reportList[0];
  }, [reportList, selectedId]);

  // Merge dynamic analytics with selected assignment
  const activeAttentionStudents = useMemo<ReportStudentAttention[]>(() => {
    if (dynamicAnalytics?.students_needing_attention && dynamicAnalytics.students_needing_attention.length > 0) {
      return dynamicAnalytics.students_needing_attention.map((s: any) => ({
        id: s.student_user_id,
        name: s.student_name,
        institutionalId: s.institutional_id,
        pct: s.attendance_percentage != null ? Math.round(s.attendance_percentage) : null,
        attended: s.attended_sessions,
        held: s.total_eligible_sessions,
        run: s.consecutive_absences,
        classesToRecover: s.classes_to_recover,
        canMiss: s.classes_can_miss,
        isShortage: s.is_shortage,
        isRecoverable: s.is_recoverable,
      }));
    }
    return currentAssignment?.studentsNeedingAttention || [];
  }, [dynamicAnalytics, currentAssignment]);

  const displayedStudents = useMemo(() => {
    let list = activeAttentionStudents;
    if (shortageOnly) {
      list = list.filter((s) => s.isShortage || (s.pct !== null && s.pct < (currentAssignment?.threshold ?? 75)));
    }
    if (searchQuery.trim().length > 0) {
      const q = searchQuery.toLowerCase().trim();
      list = list.filter(
        (s) => s.name.toLowerCase().includes(q) || s.institutionalId.toLowerCase().includes(q)
      );
    }
    return list;
  }, [activeAttentionStudents, shortageOnly, searchQuery, currentAssignment?.threshold]);

  const trendLineData = useMemo(() => {
    if (dynamicAnalytics?.trend && dynamicAnalytics.trend.length > 0) {
      return dynamicAnalytics.trend.map((t: any) => ({
        label: t.period_label,
        value: t.attendance_percentage != null ? Math.round(t.attendance_percentage) : 80,
      }));
    }
    return (currentAssignment?.trend || []).map((t) => ({
      label: t.label,
      value: t.pct ?? 80,
    }));
  }, [dynamicAnalytics, currentAssignment]);

  const distributionBins: HistogramBin[] = useMemo(() => {
    if (dynamicAnalytics?.roster_summaries && dynamicAnalytics.roster_summaries.length > 0) {
      let b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0;
      for (const s of dynamicAnalytics.roster_summaries) {
        const pct = s.attendance_percentage != null ? s.attendance_percentage : 100;
        if (pct < 50) b1++;
        else if (pct < 65) b2++;
        else if (pct < 75) b3++;
        else if (pct < 90) b4++;
        else b5++;
      }
      return [
        { range: '<50%', count: b1, label: 'Critical', tone: 'rose' },
        { range: '50-64%', count: b2, label: 'Severe', tone: 'amber' },
        { range: '65-74%', count: b3, label: 'At-Risk', tone: 'neutral' },
        { range: '75-89%', count: b4, label: 'Good', tone: 'sage' },
        { range: '90-100%', count: b5, label: 'Top', tone: 'forest' },
      ];
    }
    const avg = currentAssignment?.avgPct ?? 85;
    return [
      { range: '<50%', count: avg < 75 ? 3 : 1, label: 'Critical', tone: 'rose' },
      { range: '50-64%', count: avg < 75 ? 6 : 2, label: 'Severe', tone: 'amber' },
      { range: '65-74%', count: avg < 75 ? 8 : 4, label: 'At-Risk', tone: 'neutral' },
      { range: '75-89%', count: 24, label: 'Good', tone: 'sage' },
      { range: '90-100%', count: 19, label: 'Top', tone: 'forest' },
    ];
  }, [dynamicAnalytics, currentAssignment]);

  const assignmentComparisonData = useMemo(() => {
    return reportList.map((item) => ({
      label: item.subjectCode,
      value: item.avgPct ?? 0,
      id: item.id,
    }));
  }, [reportList]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await loadMetadata();
    if (selectedId) {
      await loadSectionAnalytics(selectedId);
    }
    setIsRefreshing(false);
  };

  const handleExport = async (reportType: 'roster' | 'sessions') => {
    setExporting(true);
    setExportMsg(null);
    try {
      const token = SessionStore.getToken();
      let dateQuery = '';
      if (dateRange === '30D') {
        const d = new Date();
        d.setDate(d.getDate() - 30);
        dateQuery = `&start_date=${d.toISOString().split('T')[0]}`;
      } else if (dateRange === '7D') {
        const d = new Date();
        d.setDate(d.getDate() - 7);
        dateQuery = `&start_date=${d.toISOString().split('T')[0]}`;
      }

      const endpoint = `${API_BASE_URL}/api/v1/analytics/assignments/${currentAssignment.id}/export?report_type=${reportType}${shortageOnly ? '&shortage_only=true' : ''}${dateQuery}`;
      const res = await fetch(endpoint, {
        headers: {
          Accept: 'text/csv',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });

      if (res.ok) {
        const csvContent = await res.text();
        const safeSubject = currentAssignment.subjectCode.replace(/[^a-zA-Z0-9]/g, '_');
        const fileName = `${safeSubject}_${reportType}_${new Date().toISOString().split('T')[0]}.csv`;
        await saveReportFile(fileName, csvContent, 'text/csv');
        setExportMsg(`Exported & shared: ${fileName}`);
      } else {
        const errText = await res.text();
        setExportMsg(`Export failed (${res.status}): ${errText}`);
      }
    } catch (err: any) {
      setExportMsg(`Export error: ${err.message || 'Offline'}`);
    } finally {
      setExporting(false);
      setTimeout(() => setExportMsg(null), 5000);
    }
  };

  if (!currentAssignment) {
    return (
      <Screen
        title="Reports"
        subtitle="A clearer view of every class"
        onBack={() => router.back()}
        right={
          <Pressable
            onPress={handleRefresh}
            style={styles.refreshButton}
            accessibilityLabel="Refresh attendance reports"
          >
            {isRefreshing ? (
              <ActivityIndicator size="small" color={Colors.forest} />
            ) : (
              <RefreshCw size={18} color={Colors.ink} />
            )}
          </Pressable>
        }
      >
        <Card style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>No classes assigned</Text>
          <Text style={styles.emptySubtitle}>
            Attendance intelligence and reports will appear here once teaching assignments are configured.
          </Text>
        </Card>
      </Screen>
    );
  }

  return (
    <Screen
      title="Reports"
      subtitle="A clearer view of every class"
      onBack={() => router.back()}
      right={
        <Pressable
          onPress={handleRefresh}
          style={styles.refreshButton}
          accessibilityLabel="Refresh attendance reports"
        >
          {isRefreshing ? (
            <ActivityIndicator size="small" color={Colors.forest} />
          ) : (
            <RefreshCw size={18} color={Colors.ink} />
          )}
        </Pressable>
      }
    >
      {/* Academic Year Dynamic Filter */}
      <View style={styles.filterBar}>
        <View style={styles.filterLabelRow}>
          <Calendar size={13} color={Colors.forest} />
          <Text style={styles.filterLabelText}>Academic Year</Text>
        </View>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.filterScrollRow}
        >
          {academicYears.map((yr) => {
            const isSelected = selectedYear === yr;
            return (
              <Pressable
                key={yr}
                onPress={() => setSelectedYear(yr)}
                style={[styles.yearChip, isSelected && styles.yearChipSelected]}
              >
                <Text style={[styles.yearChipText, isSelected && styles.yearChipTextSelected]}>
                  {yr}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* Date Range & Scope Quick Selector */}
      <View style={styles.dateRangeBar}>
        <Text style={styles.dateRangeLabel}>Scope:</Text>
        <Pressable
          onPress={() => setDateRange('ALL')}
          style={[styles.rangePill, dateRange === 'ALL' && styles.rangePillSelected]}
        >
          <Text style={[styles.rangePillText, dateRange === 'ALL' && styles.rangePillTextSelected]}>
            All Term
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setDateRange('30D')}
          style={[styles.rangePill, dateRange === '30D' && styles.rangePillSelected]}
        >
          <Text style={[styles.rangePillText, dateRange === '30D' && styles.rangePillTextSelected]}>
            Last 30 Days
          </Text>
        </Pressable>
        <Pressable
          onPress={() => setDateRange('7D')}
          style={[styles.rangePill, dateRange === '7D' && styles.rangePillSelected]}
        >
          <Text style={[styles.rangePillText, dateRange === '7D' && styles.rangePillTextSelected]}>
            Last 7 Days
          </Text>
        </Pressable>
      </View>

      {/* Horizontal Subject Selection Tabs */}
      <View style={styles.tabsWrapper}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.tabsScrollContent}
        >
          {reportList.map((item) => {
            const isSelected = item.id === selectedId;
            return (
              <Pressable
                key={item.id}
                onPress={() => setSelectedId(item.id)}
                style={[
                  styles.tabPill,
                  isSelected ? styles.tabPillSelected : styles.tabPillUnselected,
                ]}
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected }}
              >
                <Text
                  style={[
                    styles.tabPillText,
                    isSelected ? styles.tabPillTextSelected : styles.tabPillTextUnselected,
                  ]}
                >
                  {item.subjectName}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* Weekly Average & Trend Progression Chart */}
      <AttendanceTrendLineChart
        data={trendLineData}
        threshold={75}
        title={`${currentAssignment.subjectName} (${currentAssignment.sectionCode}) Progression`}
      />

      {/* Cohort Attendance Distribution Histogram */}
      <AttendanceDistributionHistogram
        bins={distributionBins}
        title={`${currentAssignment.subjectCode} Student Turnout Distribution`}
      />

      {/* Teaching Assignments Comparison Bar Chart */}
      <AttendanceBarChart
        data={assignmentComparisonData}
        threshold={75}
        title="Department Classes Average Comparison"
      />

      {/* Export Actions Card */}
      <Card style={styles.exportCard}>
        <View style={styles.exportHeaderRow}>
          <View style={styles.exportTitleContainer}>
            <Text style={styles.exportTitle}>Attendance Data Export</Text>
            <Text style={styles.exportSubtitle}>
              Export finalized attendance records to sanitized CSV
            </Text>
          </View>
          <FileSpreadsheet size={22} color={Colors.forest} />
        </View>

        {exportMsg && (
          <View style={styles.exportFeedbackBox}>
            <Check size={14} color={Colors.forest} />
            <Text style={styles.exportFeedbackText}>{exportMsg}</Text>
          </View>
        )}

        {SessionStore.canExportReports() ? (
          <View style={styles.exportButtonsRow}>
            <Pressable
              onPress={() => handleExport('roster')}
              disabled={exporting}
              style={[styles.exportBtn, styles.exportBtnPrimary]}
              accessibilityRole="button"
              accessibilityLabel="Export Section Roster CSV"
            >
              {exporting ? (
                <ActivityIndicator size="small" color="#ffffff" />
              ) : (
                <>
                  <Download size={15} color="#ffffff" />
                  <Text style={styles.exportBtnPrimaryText}>Roster CSV</Text>
                </>
              )}
            </Pressable>

            <Pressable
              onPress={() => handleExport('sessions')}
              disabled={exporting}
              style={[styles.exportBtn, styles.exportBtnSecondary]}
              accessibilityRole="button"
              accessibilityLabel="Export Session Logs CSV"
            >
              <Download size={15} color={Colors.ink} />
              <Text style={styles.exportBtnSecondaryText}>Session Logs CSV</Text>
            </Pressable>
          </View>
        ) : (
          <Text style={{ fontSize: 12, color: Colors.soft, marginTop: 8, fontStyle: 'italic' }}>
            Report file export requires reports.export permission.
          </Text>
        )}
      </Card>

      {/* Section Title with Filter Toggles and Count Indicator */}
      <View style={styles.attentionHeaderSection}>
        <SectionTitle
          action={
            currentAssignment.held > 0 && displayedStudents.length > 0 ? (
              <Chip tone="rose">
                {displayedStudents.length} at risk
              </Chip>
            ) : undefined
          }
        >
          Students who need attention
        </SectionTitle>

        {/* Search Filter for Student Scope */}
        <View style={styles.searchContainer}>
          <Search size={15} color={Colors.soft} style={styles.searchIcon} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search student by name or roll number..."
            placeholderTextColor={Colors.soft}
            value={searchQuery}
            onChangeText={setSearchQuery}
          />
        </View>

        {/* Filter Chips */}
        <View style={styles.filterPillsRow}>
          <Pressable
            onPress={() => setShortageOnly(false)}
            style={[styles.filterPill, !shortageOnly && styles.filterPillActive]}
          >
            <Text style={[styles.filterPillText, !shortageOnly && styles.filterPillTextActive]}>
              All ({currentAssignment.studentsNeedingAttention.length})
            </Text>
          </Pressable>

          <Pressable
            onPress={() => setShortageOnly(true)}
            style={[styles.filterPill, shortageOnly && styles.filterPillActive]}
          >
            <Text style={[styles.filterPillText, shortageOnly && styles.filterPillTextActive]}>
              Shortage Only (&lt; 75%)
            </Text>
          </Pressable>
        </View>
      </View>

      {/* Students Needing Attention List */}
      {currentAssignment.held === 0 ? (
        <Card style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>No sessions held yet</Text>
          <Text style={styles.emptySubtitle}>
            Attendance metrics and shortage intelligence will appear here once the first class session is finalized.
          </Text>
        </Card>
      ) : displayedStudents.length > 0 ? (
        <View style={styles.studentListCard}>
          {displayedStudents.map((student, index) => {
            const isLast = index === displayedStudents.length - 1;
            let subtitleText = '';
            if (student.isRecoverable === false || student.classesToRecover === null) {
              subtitleText = '100% threshold unreachable (absences recorded)';
            } else if (student.classesToRecover > 0) {
              subtitleText = `Needs ${student.classesToRecover} classes in a row to reach ${currentAssignment.threshold}%`;
            } else if (student.run >= 2) {
              subtitleText = `Missed ${student.run} classes in a row`;
            } else {
              subtitleText = `In good standing (${student.attended} attended)`;
            }

            const chipTone =
              student.pct !== null && student.pct < currentAssignment.threshold ? 'rose' : 'amber';

            return (
              <View
                key={student.id}
                style={[styles.studentRow, !isLast && styles.studentRowDivider]}
              >
                <Avatar name={student.name} userId={student.id} size={38} />
                <View style={styles.studentInfo}>
                  <Text style={styles.studentName} numberOfLines={1}>
                    {student.name}
                  </Text>
                  <Text style={styles.studentSubtitle} numberOfLines={1}>
                    {subtitleText}
                  </Text>
                </View>
                <Chip tone={chipTone}>
                  {student.pct !== null ? `${student.pct}%` : '—'}
                </Chip>
              </View>
            );
          })}
        </View>
      ) : (
        <Card style={styles.emptyCard}>
          <CheckCircle2 size={32} color={Colors.forest} style={{ marginBottom: 8 }} />
          <Text style={styles.emptyTitle}>No students in this view</Text>
          <Text style={styles.emptySubtitle}>
            {shortageOnly
              ? 'No students in this section currently fall below the 75% attendance shortage threshold.'
              : 'Every student in this section currently meets attendance requirements.'}
          </Text>
        </Card>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  refreshButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: Colors.card,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: Colors.line,
  },
  tabsWrapper: {
    marginHorizontal: -20,
    marginBottom: 16,
  },
  tabsScrollContent: {
    paddingHorizontal: 20,
    gap: 8,
  },
  tabPill: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: Radii.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tabPillSelected: {
    backgroundColor: Colors.ink,
  },
  tabPillUnselected: {
    backgroundColor: Colors.card,
    borderWidth: 1,
    borderColor: Colors.line,
  },
  tabPillText: {
    fontSize: 14,
    fontWeight: '600',
  },
  tabPillTextSelected: {
    color: '#ffffff',
  },
  tabPillTextUnselected: {
    color: Colors.soft,
  },
  trendCard: {
    padding: 20,
    marginBottom: 24,
  },
  trendCardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  trendLabel: {
    fontSize: 14,
    color: Colors.soft,
    fontWeight: '500',
  },
  trendPercentageText: {
    fontSize: 36,
    lineHeight: 42,
    fontWeight: '700',
    color: Colors.ink,
    marginTop: 4,
  },
  svgContainer: {
    marginTop: 16,
    alignItems: 'center',
  },
  noSessionsChart: {
    height: CHART_HEIGHT,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    backgroundColor: 'rgba(239, 231, 218, 0.4)',
    borderRadius: 12,
    marginTop: 16,
  },
  noSessionsText: {
    fontSize: 13,
    color: Colors.soft,
    fontStyle: 'italic',
    textAlign: 'center',
  },
  timelineRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: 4,
    marginTop: 6,
  },
  timelineLabel: {
    fontSize: 11,
    color: Colors.soft,
  },
  studentListCard: {
    backgroundColor: Colors.card,
    borderRadius: Radii.card,
    overflow: 'hidden',
    ...Shadows.card,
    marginTop: 8,
    marginBottom: 24,
  },
  studentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  studentRowDivider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: Colors.line,
  },
  studentInfo: {
    flex: 1,
    justifyContent: 'center',
  },
  studentName: {
    fontSize: 15,
    fontWeight: '600',
    color: Colors.ink,
    marginBottom: 2,
  },
  studentSubtitle: {
    fontSize: 12,
    color: Colors.soft,
  },
  emptyCard: {
    padding: 24,
    alignItems: 'center',
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 24,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: Colors.ink,
    marginBottom: 4,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 13,
    color: Colors.soft,
    textAlign: 'center',
    lineHeight: 18,
  },
  exportCard: {
    padding: 16,
    marginBottom: 20,
    backgroundColor: Colors.card,
  },
  exportHeaderRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  exportTitleContainer: {
    flex: 1,
    paddingRight: 8,
  },
  exportTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: Colors.ink,
  },
  exportSubtitle: {
    fontSize: 12,
    color: Colors.soft,
    marginTop: 2,
  },
  exportFeedbackBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.forest50,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    marginTop: 10,
  },
  exportFeedbackText: {
    fontSize: 12,
    color: Colors.forest,
    fontWeight: '600',
  },
  exportButtonsRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 12,
  },
  exportBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: Radii.card,
    gap: 6,
  },
  exportBtnPrimary: {
    backgroundColor: Colors.forest,
  },
  exportBtnPrimaryText: {
    color: '#ffffff',
    fontSize: 13,
    fontWeight: '600',
  },
  exportBtnSecondary: {
    backgroundColor: '#f1ebe0',
  },
  exportBtnSecondaryText: {
    color: Colors.ink,
    fontSize: 13,
    fontWeight: '600',
  },
  attentionHeaderSection: {
    gap: 8,
  },
  filterPillsRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  filterPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: Colors.card,
    borderWidth: 1,
    borderColor: Colors.line,
  },
  filterPillActive: {
    backgroundColor: Colors.ink,
    borderColor: Colors.ink,
  },
  filterPillText: {
    fontSize: 12,
    color: Colors.soft,
    fontWeight: '600',
  },
  filterPillTextActive: {
    color: '#ffffff',
  },
  filterBar: {
    marginBottom: 10,
  },
  filterLabelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  filterLabelText: {
    fontSize: 12,
    fontWeight: '700',
    color: Colors.ink,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  filterScrollRow: {
    gap: 8,
  },
  yearChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    backgroundColor: Colors.card,
    borderWidth: 1,
    borderColor: Colors.line,
  },
  yearChipSelected: {
    backgroundColor: Colors.forest,
    borderColor: Colors.forest,
  },
  yearChipText: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.ink,
  },
  yearChipTextSelected: {
    color: '#ffffff',
  },
  dateRangeBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 14,
  },
  dateRangeLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: Colors.soft,
  },
  rangePill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: Colors.card,
    borderWidth: 1,
    borderColor: Colors.line,
  },
  rangePillSelected: {
    backgroundColor: Colors.ink,
    borderColor: Colors.ink,
  },
  rangePillText: {
    fontSize: 11,
    fontWeight: '600',
    color: Colors.soft,
  },
  rangePillTextSelected: {
    color: '#ffffff',
  },
  searchContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.card,
    borderRadius: Radii.card,
    borderWidth: 1,
    borderColor: Colors.line,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 10,
    gap: 8,
  },
  searchIcon: {
    marginRight: 2,
  },
  searchInput: {
    flex: 1,
    fontSize: 13,
    color: Colors.ink,
    padding: 0,
  },
});
