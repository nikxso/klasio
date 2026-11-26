process.env.NODE_ENV = 'test';
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SessionStore } from '../sessionStore.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read database.ts SCHEMA_SQL for SQLite in-memory testing
const dbTsContent = readFileSync(join(__dirname, '../database.ts'), 'utf-8');
const schemaMatch = dbTsContent.match(/export const SCHEMA_SQL = `([\s\S]*?)`;/);
assert(schemaMatch, 'SCHEMA_SQL must be present in database.ts');
const schemaSql = schemaMatch[1];

function createInMemoryDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);
  return db;
}

describe('SessionStore IAC v1', () => {
  beforeEach(() => {
    SessionStore.clear();
  });

  it('evaluates granular permissions correctly', async () => {
    await SessionStore.setSession({
      token: 'mock_token',
      user: {
        id: 'user_123',
        institutionalId: 'prof_alan',
        email: 'alan@klasio.edu',
        fullName: 'Dr. Alan Turing',
        role: 'FACULTY',
        permissions: ['attendance.session.start', 'attendance.candidate.review', 'attendance.session.finalize'],
        roleAssignments: [
          {
            roleTemplateCode: 'FACULTY',
            roleTemplateName: 'Faculty',
            scopeType: 'DEPARTMENT',
            departmentCode: 'CSE',
          },
        ],
      },
    });

    assert.equal(SessionStore.hasPermission('attendance.session.start'), true);
    assert.equal(SessionStore.hasPermission('institution.manage'), false);
    assert.equal(SessionStore.canScanAttendance(), true);
    assert.equal(SessionStore.hasAnyRole(['FACULTY', 'DEPARTMENT_HEAD']), true);
  });

  it('supports legacy permission mappings and aliases bidirectionally', async () => {
    // Session with legacy dot-notation permissions
    await SessionStore.setSession({
      token: 'mock_token_1',
      user: {
        id: 'user_1',
        institutionalId: 'prof_1',
        email: 'prof1@klasio.edu',
        fullName: 'Prof One',
        role: 'FACULTY',
        permissions: ['attendance.session.start', 'delegation.approve'],
      },
    });

    // Alias mapping checks: asking for colon format when dot format is stored
    assert.equal(SessionStore.hasPermission('attendance:scan'), true);
    assert.equal(SessionStore.hasPermission('delegation:approve'), true);

    // Now test session with colon format stored
    await SessionStore.setSession({
      token: 'mock_token_2',
      user: {
        id: 'user_2',
        institutionalId: 'prof_2',
        email: 'prof2@klasio.edu',
        fullName: 'Prof Two',
        role: 'FACULTY',
        permissions: ['attendance:scan', 'delegation:approve'],
      },
    });

    // Asking for dot format when colon format is stored
    assert.equal(SessionStore.hasPermission('attendance.session.start'), true);
    assert.equal(SessionStore.hasPermission('delegation.approve'), true);
  });

  it('evaluates hasAnyRole with case-insensitivity and role assignments', async () => {
    await SessionStore.setSession({
      token: 'mock_token_roles',
      user: {
        id: 'user_dept_head',
        institutionalId: 'dh_ada',
        email: 'ada@klasio.edu',
        fullName: 'Dr. Ada Lovelace',
        role: 'FACULTY',
        roleAssignments: [
          {
            roleTemplateCode: 'DEPARTMENT_HEAD',
            roleTemplateName: 'Department Head',
            scopeType: 'DEPARTMENT',
            departmentCode: 'CSE',
          },
        ],
      },
    });

    assert.equal(SessionStore.hasAnyRole(['department_head']), true);
    assert.equal(SessionStore.hasAnyRole(['DEPARTMENT_HEAD']), true);
    assert.equal(SessionStore.hasAnyRole(['FACULTY', 'STUDENT']), true); // matches user.role 'FACULTY'
    assert.equal(SessionStore.hasAnyRole(['CAMPUS_ADMIN', 'CENTRAL_INSTITUTION_ADMIN']), false);
  });

  it('evaluates canScanAttendance and canApproveDelegation helper methods', async () => {
    // 1. Department Head with delegation approval permission
    await SessionStore.setSession({
      token: 'token_dh',
      user: {
        id: 'u_dh',
        institutionalId: 'id_dh',
        email: 'dh@klasio.edu',
        fullName: 'Dept Head User',
        role: 'FACULTY',
        permissions: ['delegation.approve'],
        roleAssignments: [
          {
            roleTemplateCode: 'DEPARTMENT_HEAD',
            roleTemplateName: 'Department Head',
            scopeType: 'DEPARTMENT',
            departmentCode: 'ECE',
          },
        ],
      },
    });

    assert.equal(SessionStore.canScanAttendance(), true); // user.role is FACULTY
    assert.equal(SessionStore.canApproveDelegation(), true); // has delegation.approve and DEPARTMENT_HEAD role

    // 2. Central Admin without attendance scan permission
    await SessionStore.setSession({
      token: 'token_admin',
      user: {
        id: 'u_admin',
        institutionalId: 'id_admin',
        email: 'admin@klasio.edu',
        fullName: 'Central Administrator',
        role: 'ADMIN',
        permissions: ['institution.manage'],
        roleAssignments: [
          {
            roleTemplateCode: 'CENTRAL_INSTITUTION_ADMIN',
            roleTemplateName: 'Central Institution Admin',
            scopeType: 'INSTITUTION',
          },
        ],
      },
    });

    assert.equal(SessionStore.canScanAttendance(), false);
    assert.equal(SessionStore.canApproveDelegation(), true); // matches CENTRAL_INSTITUTION_ADMIN

    // 3. Student
    await SessionStore.setSession({
      token: 'token_student',
      user: {
        id: 'u_student',
        institutionalId: '21CS042',
        email: 'student@klasio.edu',
        fullName: 'Student User',
        role: 'STUDENT',
        permissions: ['attendance.self.view'],
      },
    });

    assert.equal(SessionStore.canScanAttendance(), false);
    assert.equal(SessionStore.canApproveDelegation(), false);
  });

  it('handles null, undefined, and empty session states gracefully', () => {
    SessionStore.clear();

    assert.equal(SessionStore.getSession(), null);
    assert.equal(SessionStore.getUser(), null);
    assert.equal(SessionStore.getToken(), undefined);
    assert.equal(SessionStore.hasPermission('attendance.session.start'), false);
    assert.equal(SessionStore.hasAnyRole(['FACULTY']), false);
    assert.equal(SessionStore.canScanAttendance(), false);
    assert.equal(SessionStore.canApproveDelegation(), false);
  });

  it('persists and restores full IAC v1 session in SQLite across restarts', async () => {
    const db = createInMemoryDb();
    SessionStore.setDatabase(db);

    const fullSession = {
      token: 'persistent_jwt_xyz',
      user: {
        id: 'usr_persisted_999',
        institutionalId: 'EMP_777',
        email: 'hopper@klasio.edu',
        fullName: 'Admiral Grace Hopper',
        role: 'FACULTY',
        faceRegistrationState: 'REGISTERED',
        institutionId: 'inst_mit_01',
        permissions: [
          'attendance.session.start',
          'attendance.candidate.review',
          'attendance.session.finalize',
          'delegation.approve',
        ],
        roleAssignments: [
          {
            roleTemplateCode: 'DEPARTMENT_HEAD',
            roleTemplateName: 'Department Head',
            scopeType: 'DEPARTMENT',
            departmentCode: 'NAV_COMP',
            validFrom: '2026-01-01T00:00:00Z',
            validUntil: '2026-12-31T23:59:59Z',
          },
        ],
      },
    };

    // 1. Save session to SQLite
    await SessionStore.setSession(fullSession);

    // 2. Clear in-memory session to simulate application restart
    SessionStore.resetMemoryForTesting();
    assert.equal(SessionStore.getSession(), null);

    // 3. Restore from SQLite storage
    const restored = await SessionStore.initFromStorage();
    assert.ok(restored, 'Restored session must not be null');
    assert.equal(restored.token, fullSession.token);
    assert.equal(restored.user.id, fullSession.user.id);
    assert.equal(restored.user.institutionalId, fullSession.user.institutionalId);
    assert.equal(restored.user.email, fullSession.user.email);
    assert.equal(restored.user.fullName, fullSession.user.fullName);
    assert.equal(restored.user.role, fullSession.user.role);
    assert.equal(restored.user.faceRegistrationState, 'REGISTERED');
    assert.equal(restored.user.institutionId, 'inst_mit_01');
    assert.deepEqual(restored.user.permissions, fullSession.user.permissions);
    assert.deepEqual(restored.user.roleAssignments, fullSession.user.roleAssignments);

    // Helper methods work on restored session
    assert.equal(SessionStore.hasPermission('attendance.session.start'), true);
    assert.equal(SessionStore.canScanAttendance(), true);
    assert.equal(SessionStore.canApproveDelegation(), true);
    assert.equal(SessionStore.hasAnyRole(['DEPARTMENT_HEAD']), true);

    // 4. Clear session and ensure DB row is removed and listeners notified
    let notifiedSession = 'not_called';
    const unsub = SessionStore.subscribe((s) => {
      notifiedSession = s;
    });

    await SessionStore.clearSession(true);
    assert.equal(notifiedSession, null, 'clearSession must notify listeners with null');
    assert.equal(SessionStore.isInitialized(), true, 'isInitialized must be true after clearSession');
    unsub();

    SessionStore.resetMemoryForTesting();
    const afterClear = await SessionStore.initFromStorage();
    assert.equal(afterClear, null);

    // Reset database override after test
    SessionStore.setDatabase(null);
  });
});
