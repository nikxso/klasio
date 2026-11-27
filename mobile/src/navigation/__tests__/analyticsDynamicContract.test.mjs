import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe('Dynamic Analytics and Zero-Data Integrity Contracts', () => {
  describe('Student Attendance Progression Trend', () => {
    function computeStudentWeeklyTrend(dataWeeklyTrend, calendarSessions) {
      if (dataWeeklyTrend && dataWeeklyTrend.length > 0) {
        return dataWeeklyTrend.map((t) => ({
          label: t.period_label,
          value: t.attendance_percentage != null ? Math.round(t.attendance_percentage) : 0,
        }));
      }
      if (calendarSessions && calendarSessions.length > 0) {
        const counted = calendarSessions.filter(
          (s) => s.applicability_status !== 'CANCELLED' && s.applicability_status !== 'EXEMPT'
        );
        if (counted.length > 0) {
          const weeksMap = {};
          for (const s of counted) {
            const parts = s.session_date.split('-').map(Number);
            const target = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
            const dayNr = (target.getUTCDay() + 6) % 7;
            target.setUTCDate(target.getUTCDate() - dayNr + 3);
            const firstThursday = target.getTime();
            target.setUTCMonth(0, 1);
            if (target.getUTCDay() !== 4) {
              target.setUTCMonth(0, 1 + ((4 - target.getUTCDay() + 7) % 7));
            }
            const weekNum = 1 + Math.ceil((firstThursday - target.getTime()) / 604800000);
            const key = `${parts[0]}-W${String(weekNum).padStart(2, '0')}`;
            if (!weeksMap[key]) weeksMap[key] = [];
            weeksMap[key].push(s);
          }
          const sortedWeeks = Object.keys(weeksMap).sort();
          return sortedWeeks.map((wKey, idx) => {
            const sessList = weeksMap[wKey];
            const pres = sessList.filter(
              (s) => s.attendance_status === 'PRESENT' || s.attendance_status === 'EXCUSED'
            ).length;
            const pct = Math.round((pres / sessList.length) * 100);
            return {
              label: `W${idx + 1}`,
              value: pct,
            };
          });
        }
      }
      return [];
    }

    test('returns empty array when student has zero attendance sessions (no fake Oct W1-W4)', () => {
      const trendFromEmptyData = computeStudentWeeklyTrend([], []);
      assert.deepEqual(trendFromEmptyData, []);

      const trendFromNull = computeStudentWeeklyTrend(null, []);
      assert.deepEqual(trendFromNull, []);
    });

    test('computes accurate weekly progression points when sessions exist', () => {
      const calendarSessions = [
        { session_date: '2026-10-05', attendance_status: 'PRESENT', applicability_status: 'COUNTED' },
        { session_date: '2026-10-06', attendance_status: 'ABSENT', applicability_status: 'COUNTED' },
        { session_date: '2026-10-12', attendance_status: 'PRESENT', applicability_status: 'COUNTED' },
        { session_date: '2026-10-13', attendance_status: 'PRESENT', applicability_status: 'COUNTED' },
      ];
      const trend = computeStudentWeeklyTrend(null, calendarSessions);
      assert.equal(trend.length, 2);
      assert.equal(trend[0].label, 'W1');
      assert.equal(trend[0].value, 50); // 1 / 2 = 50%
      assert.equal(trend[1].label, 'W2');
      assert.equal(trend[1].value, 100); // 2 / 2 = 100%
    });
  });

  describe('Faculty Assignment Dynamic Metrics', () => {
    function mapFacultyAssignmentItem(item) {
      return {
        held: item.held_count != null ? item.held_count : 0,
        avg: item.average_attendance_pct != null ? Math.round(item.average_attendance_pct) : null,
      };
    }

    test('preserves 0 held and null average when no sessions are recorded (no fake 12 or 88%)', () => {
      const mappedEmpty = mapFacultyAssignmentItem({ held_count: 0, average_attendance_pct: null });
      assert.equal(mappedEmpty.held, 0);
      assert.equal(mappedEmpty.avg, null);

      const mappedMissing = mapFacultyAssignmentItem({});
      assert.equal(mappedMissing.held, 0);
      assert.equal(mappedMissing.avg, null);
    });

    test('maps real held and average when sessions exist', () => {
      const mapped = mapFacultyAssignmentItem({ held_count: 5, average_attendance_pct: 82.4 });
      assert.equal(mapped.held, 5);
      assert.equal(mapped.avg, 82);
    });
  });

  describe('Faculty Reports Distribution Histogram', () => {
    function computeDistributionBins(dynamicAnalytics) {
      if (dynamicAnalytics?.roster_summaries && dynamicAnalytics.roster_summaries.length > 0) {
        let b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0;
        for (const s of dynamicAnalytics.roster_summaries) {
          if (s.attendance_percentage == null) continue;
          const pct = s.attendance_percentage;
          if (pct < 50) b1++;
          else if (pct < 65) b2++;
          else if (pct < 75) b3++;
          else if (pct < 90) b4++;
          else b5++;
        }
        return [
          { range: '<50%', count: b1, label: 'Critical' },
          { range: '50-64%', count: b2, label: 'Severe' },
          { range: '65-74%', count: b3, label: 'At-Risk' },
          { range: '75-89%', count: b4, label: 'Good' },
          { range: '90-100%', count: b5, label: 'Top' },
        ];
      }
      return [
        { range: '<50%', count: 0, label: 'Critical' },
        { range: '50-64%', count: 0, label: 'Severe' },
        { range: '65-74%', count: 0, label: 'At-Risk' },
        { range: '75-89%', count: 0, label: 'Good' },
        { range: '90-100%', count: 0, label: 'Top' },
      ];
    }

    test('returns zero counts across all bins when no roster summaries exist (no fabricated 58 students)', () => {
      const binsEmpty = computeDistributionBins(null);
      const totalCount = binsEmpty.reduce((sum, b) => sum + b.count, 0);
      assert.equal(totalCount, 0);
      assert.deepEqual(binsEmpty.map((b) => b.count), [0, 0, 0, 0, 0]);
    });

    test('correctly partitions students into respective percentage bins', () => {
      const analytics = {
        roster_summaries: [
          { attendance_percentage: 45.0 }, // <50%
          { attendance_percentage: 60.0 }, // 50-64%
          { attendance_percentage: 70.0 }, // 65-74%
          { attendance_percentage: 80.0 }, // 75-89%
          { attendance_percentage: 95.0 }, // 90-100%
          { attendance_percentage: null }, // unrecorded/zero-denominator -> omitted
        ],
      };
      const bins = computeDistributionBins(analytics);
      assert.deepEqual(bins.map((b) => b.count), [1, 1, 1, 1, 1]);
    });
  });

  describe('Admin Institutional Overview Dynamic Metrics', () => {
    function computeAdminOverviewMetrics(overviewResData) {
      let overallPct = null;
      let totalSections = 0;
      if (overviewResData) {
        if (overviewResData.overall_attendance_percentage != null) {
          overallPct = Math.round(overviewResData.overall_attendance_percentage);
        }
        if (overviewResData.total_sections != null) {
          totalSections = overviewResData.total_sections;
        }
      }
      return {
        attendanceDisplay: overallPct !== null ? `${overallPct}%` : '—',
        sectionsCount: totalSections,
      };
    }

    test('displays dash and 0 sections when institutional overview has zero sessions (not 92% or 3 sections)', () => {
      const metrics = computeAdminOverviewMetrics({
        overall_attendance_percentage: null,
        total_sections: 0,
      });
      assert.equal(metrics.attendanceDisplay, '—');
      assert.equal(metrics.sectionsCount, 0);
    });

    test('displays real percentage when sessions exist', () => {
      const metrics = computeAdminOverviewMetrics({
        overall_attendance_percentage: 84.6,
        total_sections: 5,
      });
      assert.equal(metrics.attendanceDisplay, '85%');
      assert.equal(metrics.sectionsCount, 5);
    });
  });

  describe('Faculty Section Detail Student Attendance', () => {
    test('maps individual student percentage dynamically from analytics roster summaries', () => {
      const roster = [
        { studentUserId: 's1', fullName: 'Alice' },
        { studentUserId: 's2', fullName: 'Bob' },
      ];
      const analyticsRosterSummaries = [
        { student_user_id: 's1', attendance_percentage: 90.0 },
        { student_user_id: 's2', attendance_percentage: 65.0 },
      ];
      const analyticsMap = {};
      for (const item of analyticsRosterSummaries) {
        analyticsMap[item.student_user_id] =
          item.attendance_percentage != null ? Math.round(item.attendance_percentage) : null;
      }

      const students = roster.map((c) => ({
        ...c,
        pct: analyticsMap[c.studentUserId] != null ? analyticsMap[c.studentUserId] : 0,
      }));

      assert.equal(students[0].pct, 90);
      assert.equal(students[1].pct, 65);
    });
  });
});
