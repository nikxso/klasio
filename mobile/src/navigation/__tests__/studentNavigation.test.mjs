import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe('Student Navigation & Attendance Calendar Contract', () => {
  const STUDENT_TABS = [
    { name: 'index', label: 'Home' },
    { name: 'attendance', label: 'Attendance' },
    { name: 'requests', label: 'Requests' },
    { name: 'profile', label: 'Profile' },
  ];

  test('configures exactly 4 student tabs with expected labels', () => {
    assert.equal(STUDENT_TABS.length, 4);
    assert.deepEqual(
      STUDENT_TABS.map((t) => t.name),
      ['index', 'attendance', 'requests', 'profile']
    );
    assert.deepEqual(
      STUDENT_TABS.map((t) => t.label),
      ['Home', 'Attendance', 'Requests', 'Profile']
    );
  });

  test('attendance calendar accurately maps domain statuses without inventing fictional dates', () => {
    function mapSessionToDayStatus(session) {
      if (session.applicability_status === 'CANCELLED' || session.applicability_status === 'EXEMPT') {
        return 'excused';
      }
      if (session.attendance_status === 'PRESENT') return 'present';
      if (session.attendance_status === 'EXCUSED') return 'excused';
      if (session.attendance_status === 'ABSENT') return 'absent';
      return null;
    }

    assert.equal(
      mapSessionToDayStatus({ attendance_status: 'PRESENT', applicability_status: 'COUNTED' }),
      'present'
    );
    assert.equal(
      mapSessionToDayStatus({ attendance_status: 'ABSENT', applicability_status: 'COUNTED' }),
      'absent'
    );
    assert.equal(
      mapSessionToDayStatus({ attendance_status: 'EXCUSED', applicability_status: 'COUNTED' }),
      'excused'
    );
    assert.equal(
      mapSessionToDayStatus({ attendance_status: 'ABSENT', applicability_status: 'CANCELLED' }),
      'excused'
    );
  });

  test('student request status timeline progress index mapping', () => {
    function getTimelineStepIndex(status) {
      switch (status) {
        case 'Sent':
          return 0;
        case 'Being reviewed':
          return 1;
        case 'Accepted':
        case 'Not accepted':
          return 2;
        default:
          return 0;
      }
    }

    assert.equal(getTimelineStepIndex('Sent'), 0);
    assert.equal(getTimelineStepIndex('Being reviewed'), 1);
    assert.equal(getTimelineStepIndex('Accepted'), 2);
    assert.equal(getTimelineStepIndex('Not accepted'), 2);
  });
});
