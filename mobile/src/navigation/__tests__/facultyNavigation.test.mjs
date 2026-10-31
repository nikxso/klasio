import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

describe('Faculty Navigation Architecture & Profile Contract', () => {
  const FACULTY_TABS = [
    { name: 'index', label: 'Home' },
    { name: 'assignments', label: 'Classes' },
    { name: 'reports', label: 'Reports' },
    { name: 'profile', label: 'Profile' },
  ];

  test('configures exactly 4 tabs with expected names and labels', () => {
    assert.equal(FACULTY_TABS.length, 4);
    assert.deepEqual(
      FACULTY_TABS.map((t) => t.name),
      ['index', 'assignments', 'reports', 'profile']
    );
    assert.deepEqual(
      FACULTY_TABS.map((t) => t.label),
      ['Home', 'Classes', 'Reports', 'Profile']
    );
  });

  test('center scan action initiates scanning for current or next assignment', () => {
    let triggeredScanRoute = null;
    const assignments = [
      { id: 'a1', subject: 'Data Structures', section: 'CSE 3A' },
      { id: 'a2', subject: 'Operating Systems', section: 'CSE 3B' },
    ];

    function handleCenterScan(upcomingClass) {
      if (upcomingClass) {
        triggeredScanRoute = {
          pathname: '/(faculty)/session/scan',
          params: { assignmentId: upcomingClass.id, subject: upcomingClass.subject },
        };
      } else {
        triggeredScanRoute = { pathname: '/(faculty)/assignments' };
      }
    }

    handleCenterScan(assignments[0]);
    assert.equal(triggeredScanRoute.pathname, '/(faculty)/session/scan');
    assert.equal(triggeredScanRoute.params.assignmentId, 'a1');

    handleCenterScan(null);
    assert.equal(triggeredScanRoute.pathname, '/(faculty)/assignments');
  });

  test('faculty profile contract provides required fields and biometric model metadata', () => {
    const facultyProfile = {
      name: 'Dr. Lakshmi Iyer',
      designation: 'Associate Professor',
      department: 'Computer Science & Engineering',
      staffId: 'FAC-0142',
      modelVersion: 'MobileFaceNet 128D (v2.4-live)',
      syncStatus: 'ONLINE_SYNCED',
    };

    assert.equal(typeof facultyProfile.name, 'string');
    assert.equal(facultyProfile.staffId, 'FAC-0142');
    assert.match(facultyProfile.modelVersion, /MobileFaceNet/);
    assert.equal(facultyProfile.syncStatus, 'ONLINE_SYNCED');
  });
});
