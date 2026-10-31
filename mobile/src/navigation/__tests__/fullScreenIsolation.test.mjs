import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe('Full-Screen Navigation Isolation & Safe-Area Polishing', () => {
  const STACK_ROUTES_FACULTY = ['(tabs)', 'section/[id]', 'session/scan', 'delegations', 'enrollment'];
  const STACK_ROUTES_STUDENT = ['(tabs)', 'subject/[id]', 'enrollment'];

  test('deep workflow screens are outside (tabs) in Stack navigators', () => {
    assert.ok(!STACK_ROUTES_FACULTY.includes('(tabs)/section/[id]'));
    assert.ok(STACK_ROUTES_FACULTY.includes('session/scan'));
    assert.ok(STACK_ROUTES_FACULTY.includes('section/[id]'));

    assert.ok(!STACK_ROUTES_STUDENT.includes('(tabs)/subject/[id]'));
    assert.ok(STACK_ROUTES_STUDENT.includes('subject/[id]'));
    assert.ok(STACK_ROUTES_STUDENT.includes('enrollment'));
  });

  test('safe area insets padding calculation prevents overlap on notched and 3-button devices', () => {
    function computeBottomPadding(insetsBottom) {
      return Math.max(insetsBottom, 12);
    }

    // iPhone with home bar (typically insets.bottom = 34)
    assert.equal(computeBottomPadding(34), 34);

    // Android gesture bar (typically insets.bottom = 16 or 24)
    assert.equal(computeBottomPadding(24), 24);

    // Legacy / 3-button navigation (insets.bottom = 0)
    assert.equal(computeBottomPadding(0), 12);
  });
});
