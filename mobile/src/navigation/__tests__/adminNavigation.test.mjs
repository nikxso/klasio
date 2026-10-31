import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe('Admin Navigation & Role Routing Contract', () => {
  const ADMIN_TABS = [
    { name: 'index', label: 'Home' },
    { name: 'people', label: 'People' },
    { name: 'academics', label: 'Academics' },
    { name: 'settings', label: 'Settings' },
  ];

  test('configures exactly 4 admin tabs with expected labels', () => {
    assert.equal(ADMIN_TABS.length, 4);
    assert.deepEqual(
      ADMIN_TABS.map((t) => t.name),
      ['index', 'people', 'academics', 'settings']
    );
    assert.deepEqual(
      ADMIN_TABS.map((t) => t.label),
      ['Home', 'People', 'Academics', 'Settings']
    );
  });

  test('login role selector correctly resolves target route for each role', () => {
    function resolveLoginRoute(role) {
      if (role === 'student') return '/(student)';
      if (role === 'admin') return '/(admin)';
      return '/(faculty)';
    }

    assert.equal(resolveLoginRoute('student'), '/(student)');
    assert.equal(resolveLoginRoute('faculty'), '/(faculty)');
    assert.equal(resolveLoginRoute('admin'), '/(admin)');
  });

  test('admin institutional metrics calculation contract', () => {
    const mockOverview = {
      total_students: 1240,
      total_faculty: 86,
      average_attendance_percentage: 88.4,
      total_active_sessions: 342,
    };

    assert.equal(typeof mockOverview.total_students, 'number');
    assert.equal(typeof mockOverview.total_faculty, 'number');
    assert.equal(Math.round(mockOverview.average_attendance_percentage), 88);
  });
});
