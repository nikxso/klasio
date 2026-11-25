// mobile/src/navigation/__tests__/iacNavigation.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

function resolveTargetRoute(user) {
  const role = user?.role ? user.role.toUpperCase() : '';

  // 1. Explicit Student role or student self-enrollment always routes to student workspace
  if (role === 'STUDENT' || (user?.permissions?.some(p => p === 'biometrics.enroll.self') && !user?.permissions?.some(p => p === 'attendance.session.start'))) {
    return '/(student)';
  }

  // 2. Direct attendance conduct capabilities (Faculty, TAs)
  if (user?.permissions?.some(p => p === 'attendance.session.start' || p === 'attendance.session.create') || role === 'FACULTY') {
    return '/(faculty)';
  }

  // 3. Central & Campus Administration
  if (user?.permissions?.some(p => p.startsWith('institution.') || p.startsWith('campus.') || p.startsWith('academic_structure.')) || role === 'ADMIN') {
    return '/(admin)';
  }

  // 4. Fallback based on legacy role
  if (role === 'ADMIN') return '/(admin)';
  if (role === 'STUDENT') return '/(student)';
  return '/(faculty)';
}

describe('IAC v1 Dynamic Route Resolution', () => {
  it('routes to admin for governance permissions', () => {
    assert.equal(resolveTargetRoute({ permissions: ['institution.view'] }), '/(admin)');
  });
  it('routes to faculty for attendance conduct permissions', () => {
    assert.equal(resolveTargetRoute({ permissions: ['attendance.session.start'] }), '/(faculty)');
  });
  it('routes dual-role faculty with department authority to faculty home first', () => {
    assert.equal(
      resolveTargetRoute({
        permissions: ['academic_structure.view', 'attendance.session.start'],
      }),
      '/(faculty)'
    );
  });
  it('routes pure academic coordinators without session conduct to admin', () => {
    assert.equal(
      resolveTargetRoute({
        permissions: ['academic_structure.view'],
      }),
      '/(admin)'
    );
  });
  it('routes to student for self-enrollment permission', () => {
    assert.equal(resolveTargetRoute({ permissions: ['biometrics.enroll.self'] }), '/(student)');
  });
  it('routes student s2 with attendance view and amendment permissions to student workspace', () => {
    assert.equal(
      resolveTargetRoute({
        role: 'STUDENT',
        permissions: [
          'attendance.session.view',
          'attendance.amendment.request',
          'biometrics.enroll.self',
          'student_records.view',
        ],
      }),
      '/(student)'
    );
  });
  it('falls back to legacy role if permissions empty', () => {
    assert.equal(resolveTargetRoute({ role: 'ADMIN', permissions: [] }), '/(admin)');
    assert.equal(resolveTargetRoute({ role: 'STUDENT', permissions: [] }), '/(student)');
    assert.equal(resolveTargetRoute({ role: 'FACULTY', permissions: [] }), '/(faculty)');
  });
});
