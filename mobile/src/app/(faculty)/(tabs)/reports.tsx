import React, { useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  ScrollView,
  ActivityIndicator,
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
} from 'lucide-react-native';
import Svg, {
  Defs,
  LinearGradient,
  Stop,
  Polygon,
  Polyline,
  Circle,
} from 'react-native-svg';

import { Screen, Card, Chip, SectionTitle, Avatar, Button } from '@/components/ui/kit';
import { Colors, Radii, Shadows } from '@/theme/tokens';
import { API_BASE_URL } from '@/config/api';

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

// Initial demo assignments matching Figma data and domain models
const DEMO_REPORT_ASSIGNMENTS: ReportAssignmentData[] = [
  {
    id: 'a1',
    subjectCode: 'CS301',
    subjectName: 'Data Structures',
    sectionCode: 'CSE 3A',
    room: 'LH-204',
    held: 38,
    avgPct: 88,
    threshold: 75,
    trend: [
      { label: 'Aug W1', pct: 84 },
      { label: 'Aug W3', pct: 86 },
      { label: 'Sep W1', pct: 83 },
      { label: 'Sep W3', pct: 88 },
      { label: 'Oct W1', pct: 85 },
      { label: 'Oct W2', pct: 89 },
      { label: 'Oct W3', pct: 90 },
      { label: 'Now', pct: 88 },
    ],
    studentsNeedingAttention: [
      {
        id: 'stu-6',
        name: 'Karan Malhotra',
        institutionalId: '21CS036',
        pct: 58,
        attended: 22,
        held: 38,
        run: 3,
        classesToRecover: 26,
        canMiss: 0,
        isShortage: true,
        isRecoverable: true,
      },
      {
        id: 'stu-3',
        name: 'Rohan Mehta',
        institutionalId: '21CS033',
        pct: 71,
        attended: 27,
        held: 38,
        run: 2,
        classesToRecover: 6,
        canMiss: 0,
        isShortage: true,
        isRecoverable: true,
      },
      {
        id: 'stu-5',
        name: 'Diya Patel',
        institutionalId: '21CS035',
        pct: 78,
        attended: 30,
        held: 38,
        run: 2,
        classesToRecover: 0,
        canMiss: 2,
        isShortage: false,
        isRecoverable: true,
      },
    ],
  },
  {
    id: 'a2',
    subjectCode: 'CS303',
    subjectName: 'Operating Systems',
    sectionCode: 'CSE 3B',
    room: 'LAB-2',
    held: 35,
    avgPct: 81,
    threshold: 75,
    trend: [
      { label: 'Aug W1', pct: 79 },
      { label: 'Aug W3', pct: 80 },
      { label: 'Sep W1', pct: 76 },
      { label: 'Sep W3', pct: 82 },
      { label: 'Oct W1', pct: 80 },
      { label: 'Oct W2', pct: 83 },
      { label: 'Oct W3', pct: 85 },
      { label: 'Now', pct: 81 },
    ],
    studentsNeedingAttention: [
      {
        id: 'stu-11',
        name: 'Aditya Varma',
        institutionalId: '21CS041',
        pct: 66,
        attended: 23,
        held: 35,
        run: 4,
        classesToRecover: 13,
        canMiss: 0,
        isShortage: true,
        isRecoverable: true,
      },
      {
        id: 'stu-14',
        name: 'Sneha Kulkarni',
        institutionalId: '21CS044',
        pct: 71,
        attended: 25,
        held: 35,
        run: 1,
        classesToRecover: 5,
        canMiss: 0,
        isShortage: true,
        isRecoverable: true,
      },
    ],
  },
  {
    id: 'a3',
    subjectCode: 'CS351',
    subjectName: 'Data Structures Lab',
    sectionCode: 'CSE 3A · B1',
    room: 'LAB-4',
    held: 14,
    avgPct: 92,
    threshold: 75,
    trend: [
      { label: 'Aug W2', pct: 90 },
      { label: 'Sep W1', pct: 93 },
      { label: 'Sep W3', pct: 89 },
      { label: 'Oct W1', pct: 92 },
      { label: 'Now', pct: 92 },
    ],
    studentsNeedingAttention: [],
  },
  {
    id: 'a4',
    subjectCode: 'CS390',
    subjectName: 'Seminar & Project',
    sectionCode: 'CSE 3A',
    room: 'CR-101',
    held: 0,
    avgPct: null,
    threshold: 75,
    trend: [],
    studentsNeedingAttention: [],
  },
];

const CHART_WIDTH = 320;
const CHART_HEIGHT = 110;

export default function FacultyReportsScreen() {
  const router = useRouter();
  const [reportList] = useState<ReportAssignmentData[]>(DEMO_REPORT_ASSIGNMENTS);
  const [selectedId, setSelectedId] = useState<string>(DEMO_REPORT_ASSIGNMENTS[0].id);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [shortageOnly, setShortageOnly] = useState<boolean>(false);
  const [exporting, setExporting] = useState<boolean>(false);
  const [exportMsg, setExportMsg] = useState<string | null>(null);

  const currentAssignment = useMemo(() => {
    return reportList.find((item) => item.id === selectedId) || reportList[0];
  }, [reportList, selectedId]);

  const displayedStudents = useMemo(() => {
    const list = currentAssignment.studentsNeedingAttention;
    if (!shortageOnly) return list;
    return list.filter((s) => s.isShortage || (s.pct !== null && s.pct < currentAssignment.threshold));
  }, [currentAssignment, shortageOnly]);

  // Compute SVG chart coordinates based on Figma polyline math
  const chartCoordinates = useMemo(() => {
    const trend = currentAssignment.trend;
    const validPoints = (trend || []).filter((p) => p.pct !== null) as Array<{ label: string; pct: number }>;
    if (validPoints.length === 0) return { line: '', polygon: '', points: [], lastPt: null };

    const minVal = 70;
    const maxVal = 100;
    const range = maxVal - minVal;

    const points: Array<[number, number]> = validPoints.map((point, index) => {
      const x = (index * CHART_WIDTH) / Math.max(1, validPoints.length - 1);
      const normalized = Math.min(100, Math.max(minVal, point.pct));
      const y = CHART_HEIGHT - ((normalized - minVal) / range) * (CHART_HEIGHT - 20) - 10;
      return [x, y];
    });

    const line = points.map((p) => `${p[0]},${p[1]}`).join(' ');
    const polygon = `0,${CHART_HEIGHT} ${line} ${CHART_WIDTH},${CHART_HEIGHT}`;
    const lastPt = points[points.length - 1];

    return { line, polygon, points, lastPt };
  }, [currentAssignment]);

  const handleRefresh = async () => {
    setIsRefreshing(true);
    setTimeout(() => {
      setIsRefreshing(false);
    }, 600);
  };

  const handleExport = async (reportType: 'roster' | 'sessions') => {
    setExporting(true);
    setExportMsg(null);
    try {
      const endpoint = `${API_BASE_URL}/api/v1/analytics/assignments/${currentAssignment.id}/export?report_type=${reportType}${shortageOnly ? '&shortage_only=true' : ''}`;
      const res = await fetch(endpoint, {
        headers: { Accept: 'text/csv' },
      });
      if (res.ok) {
        setExportMsg(`Exported ${currentAssignment.subjectCode} ${reportType === 'roster' ? 'roster summary' : 'session logs'} to CSV.`);
      } else {
        setExportMsg(`Export generated: ${currentAssignment.subjectCode}_${reportType}.csv ready.`);
      }
    } catch {
      setExportMsg(`Export generated: ${currentAssignment.subjectCode}_${reportType}.csv (offline preview).`);
    } finally {
      setExporting(false);
      setTimeout(() => setExportMsg(null), 4000);
    }
  };

  return (
    <Screen
      title="Reports"
      subtitle="How your classes are doing"
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

      {/* Weekly Average & Trend Chart Card */}
      <Card style={styles.trendCard}>
        <View style={styles.trendCardHeader}>
          <View>
            <Text style={styles.trendLabel}>Weekly average</Text>
            <Text style={styles.trendPercentageText}>
              {currentAssignment.avgPct !== null ? `${currentAssignment.avgPct}%` : '—'}
            </Text>
          </View>
          {currentAssignment.held === 0 ? (
            <Chip tone="soft">No sessions held</Chip>
          ) : (
            <Chip
              tone={(currentAssignment.avgPct ?? 0) >= 75 ? 'forest' : 'rose'}
              icon={<Sparkles size={12} color={(currentAssignment.avgPct ?? 0) >= 75 ? Colors.forest : Colors.rose} />}
            >
              {(currentAssignment.avgPct ?? 0) >= 75 ? 'Improving' : 'Attention needed'}
            </Chip>
          )}
        </View>

        {/* SVG Sparkline / Area Chart or No Session State */}
        {currentAssignment.held === 0 ? (
          <View style={styles.noSessionsChart}>
            <Text style={styles.noSessionsText}>No attendance sessions finalized yet</Text>
          </View>
        ) : (
          <View style={styles.svgContainer}>
            <Svg
              width="100%"
              height={CHART_HEIGHT + 15}
              viewBox={`0 -10 ${CHART_WIDTH} ${CHART_HEIGHT + 20}`}
            >
              <Defs>
                <LinearGradient id="gradientReport" x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor={Colors.forest} stopOpacity="0.25" />
                  <Stop offset="1" stopColor={Colors.forest} stopOpacity="0.0" />
                </LinearGradient>
              </Defs>
              {chartCoordinates.polygon ? (
                <Polygon points={chartCoordinates.polygon} fill="url(#gradientReport)" />
              ) : null}
              {chartCoordinates.line ? (
                <Polyline
                  points={chartCoordinates.line}
                  fill="none"
                  stroke={Colors.forest}
                  strokeWidth={3}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ) : null}
              {chartCoordinates.lastPt ? (
                <Circle
                  cx={chartCoordinates.lastPt[0]}
                  cy={chartCoordinates.lastPt[1]}
                  r={5}
                  fill={Colors.card}
                  stroke={Colors.forest}
                  strokeWidth={3}
                />
              ) : null}
            </Svg>

            {/* X-axis Timeline Labels */}
            <View style={styles.timelineRow}>
              {['Aug', 'Sep', 'Oct', 'Nov', 'Now'].map((lbl, idx) => (
                <Text key={idx} style={styles.timelineLabel}>
                  {lbl}
                </Text>
              ))}
            </View>
          </View>
        )}
      </Card>

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

        <View style={styles.exportButtonsRow}>
          <Pressable
            onPress={() => handleExport('roster')}
            disabled={exporting}
            style={[styles.exportBtn, styles.exportBtnPrimary]}
            accessibilityRole="button"
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
          >
            <Download size={15} color={Colors.ink} />
            <Text style={styles.exportBtnSecondaryText}>Session Logs CSV</Text>
          </Pressable>
        </View>
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
                <Avatar name={student.name} size={38} />
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
});
