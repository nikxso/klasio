// mobile/src/navigation/__tests__/iacNavigation.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

function resolveTargetRoute(user) {
  if (user?.permissions?.some(p => p.startsWith('institution.') || p.startsWith('campus.') || p.startsWith('academic_structure.'))) {
    return '/(admin)';
  }
  if (user?.permissions?.some(p => p.startsWith('attendance.'))) {
    return '/(faculty)';
  }
  if (user?.permissions?.some(p => p.startsWith('biometrics.enroll.self'))) {
    return '/(student)';
  }
  // Fallback to legacy role
  if (user?.role === 'ADMIN') return '/(admin)';
  if (user?.role === 'STUDENT') return '/(student)';
  return '/(faculty)';
}

describe('IAC v1 Dynamic Route Resolution', () => {
  it('routes to admin for governance permissions', () => {
    assert.equal(resolveTargetRoute({ permissions: ['institution.view'] }), '/(admin)');
  });
  it('routes to faculty for attendance conduct permissions', () => {
    assert.equal(resolveTargetRoute({ permissions: ['attendance.session.start'] }), '/(faculty)');
  });
  it('routes to student for self-enrollment permission', () => {
    assert.equal(resolveTargetRoute({ permissions: ['biometrics.enroll.self'] }), '/(student)');
  });
  it('falls back to legacy role if permissions empty', () => {
    assert.equal(resolveTargetRoute({ role: 'ADMIN', permissions: [] }), '/(admin)');
    assert.equal(resolveTargetRoute({ role: 'STUDENT', permissions: [] }), '/(student)');
    assert.equal(resolveTargetRoute({ role: 'FACULTY', permissions: [] }), '/(faculty)');
  });
});
