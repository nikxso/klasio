import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { AttendanceRepository } from '../attendanceRepository.ts';
import { SessionStore } from '../sessionStore.ts';
import { AttendanceSyncWorker } from '../syncWorker.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dbTsContent = readFileSync(join(__dirname, '../database.ts'), 'utf-8');
const schemaMatch = dbTsContent.match(/export const SCHEMA_SQL = `([\s\S]*?)`;/);
assert(schemaMatch, 'SCHEMA_SQL must be present in database.ts');
const schemaSql = schemaMatch[1];

function createInMemoryDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql);
  return db;
}

describe('Klasio SQLite Target Schema v2 & Authorization Provenance Contracts', () => {
  test('1. local_auth_session stores and retrieves signed authorization snapshot and version', async () => {
    const db = createInMemoryDb();
    SessionStore.setDatabase(db);

    const mockSnapshot = {
      membership_id: 'mem-001-uuid',
      user_id: 'user-001-uuid',
      institution_id: '00000000-0000-0000-0000-000000000001',
      authorization_version: 'v1.0',
      role_assignments: [
        {
          id: 'ra-faculty-01',
          roleTemplateCode: 'FACULTY',
          roleTemplateName: 'Regular Faculty',
          scopeType: 'DEPARTMENT',
          departmentCode: 'CS',
        },
        {
          id: 'ra-hod-01',
          roleTemplateCode: 'DEPARTMENT_HEAD_COORDINATOR',
          roleTemplateName: 'Department Head & Coordinator',
          scopeType: 'DEPARTMENT',
          departmentCode: 'CS',
        },
      ],
      effective_permissions: ['attendance.session.start', 'reports.view', 'delegation.approve'],
    };

    const sessionObj = {
      token: 'jwt-token-sample',
      user: {
        id: 'user-001-uuid',
        institutionalId: 'FAC-001',
        email: 'fac001@institution.edu',
        fullName: 'Prof. Alan Turing',
        role: 'FACULTY',
        membershipId: 'mem-001-uuid',
        authorizationVersion: 'v1.0',
        authorizationSnapshot: mockSnapshot,
        permissions: ['attendance.session.start', 'reports.view', 'delegation.approve'],
        roleAssignments: mockSnapshot.role_assignments,
      },
    };

    await SessionStore.setSession(sessionObj);

    // Verify row directly in SQLite
    const row = db.prepare('SELECT * FROM local_auth_session WHERE id = 1;').get();
    assert.ok(row, 'local_auth_session row must exist');
    assert.equal(row.membership_id, 'mem-001-uuid');
    assert.equal(row.authorization_version, 'v1.0');
    assert.ok(row.authorization_snapshot_json.includes('ra-hod-01'));

    // Verify retrieval via initFromStorage
    SessionStore.resetMemoryForTesting();
    const loaded = await SessionStore.initFromStorage();
    assert.ok(loaded, 'Loaded session must exist');
    assert.equal(SessionStore.getMembershipId(), 'mem-001-uuid');
    assert.equal(SessionStore.hasPermission('attendance.session.start'), true);
    assert.equal(SessionStore.hasPermission('delegation.approve'), true);
    assert.equal(SessionStore.canScanAttendance(), true);
    assert.equal(SessionStore.canApproveDelegation(), true);
  });

  test('2. Finalizing attendance session stores authorization provenance in local_attendance_sessions and sync_queue', async () => {
    const db = createInMemoryDb();
    SessionStore.setDatabase(db);

    const payload = {
      clientSessionUuid: 'sess-target-v2-001',
      teachingAssignmentId: 'ta-cs301-secA',
      sessionDate: '2026-11-25',
      periodSlotOrSequence: 1,
      applicabilityStatus: 'COUNTED',
      statusReason: null,
      regularFacultyUserId: 'fac-regular-uuid',
      conductingFacultyUserId: 'fac-substitute-uuid',
      substituteDelegationId: 'delg-uuid-999',
      finalizedAt: new Date().toISOString(),
      records: [
        {
          studentUserId: 'stu-001-uuid',
          attendanceStatus: 'PRESENT',
          markSource: 'AI_VERIFIED',
          candidateConfidence: 0.94,
          recordedAt: new Date().toISOString(),
        },
      ],
      actorMembershipId: 'mem-substitute-uuid',
      authorizingRoleAssignmentId: 'ra-substitute-01',
      delegationId: 'delg-uuid-999',
      authorizationVersion: 'v1.0',
    };

    const finResult = await AttendanceRepository.finalizeSession(payload, db);
    assert.equal(finResult.success, true);

    // 1. Check local_attendance_sessions row
    const sessRow = db.prepare('SELECT * FROM local_attendance_sessions WHERE client_session_uuid = ?;').get('sess-target-v2-001');
    assert.ok(sessRow, 'Session row must exist');
    assert.equal(sessRow.authorizing_role_assignment_id, 'ra-substitute-01');
    assert.equal(sessRow.delegation_id, 'delg-uuid-999');
    assert.equal(sessRow.authorization_version, 'v1.0');

    // 2. Check sync_queue row
    const queueRows = await AttendanceSyncWorker.getPendingQueueItems(5, db, true);
    assert.equal(queueRows.length, 1);
    assert.equal(queueRows[0].operationType, 'SESSION_SYNC');
    assert.equal(queueRows[0].actorMembershipId, 'mem-substitute-uuid');
    assert.equal(queueRows[0].authorizingRoleAssignmentId, 'ra-substitute-01');
    assert.equal(queueRows[0].delegationId, 'delg-uuid-999');
    assert.equal(queueRows[0].authorizationVersion, 'v1.0');
  });

  test('3. Post-finalization amendment stores role-neutral provenance in local_amendment_audits and sync_queue', async () => {
    const db = createInMemoryDb();
    SessionStore.setDatabase(db);

    const sessionPayload = {
      clientSessionUuid: 'sess-target-v2-002',
      teachingAssignmentId: 'ta-cs302-secB',
      sessionDate: '2026-11-25',
      periodSlotOrSequence: 2,
      applicabilityStatus: 'COUNTED',
      statusReason: null,
      regularFacultyUserId: 'fac-prof-uuid',
      conductingFacultyUserId: 'fac-prof-uuid',
      finalizedAt: new Date().toISOString(),
      records: [
        {
          studentUserId: 'stu-aarav-uuid',
          attendanceStatus: 'ABSENT',
          markSource: 'MANUAL_MARK',
          candidateConfidence: null,
          recordedAt: new Date().toISOString(),
        },
      ],
      authorizingRoleAssignmentId: 'ra-prof-01',
      actorMembershipId: 'mem-prof-uuid',
    };

    await AttendanceRepository.finalizeSession(sessionPayload, db);

    const amendResult = await AttendanceRepository.applyAmendment(
      'sess-target-v2-002',
      'stu-aarav-uuid',
      'PRESENT',
      'Verified doctor medical excuse certificate presented by student',
      'fac-prof-uuid',
      'REGULAR_FACULTY',
      db,
      'amd-uuid-target-001',
      'ABSENT',
      'mem-prof-uuid',
      'ra-prof-01',
      null,
      'attendance.amend',
      'TEACHING_ASSIGNMENT',
      'ta-cs302-secB'
    );

    assert.equal(amendResult.clientAmendmentId, 'amd-uuid-target-001');
    assert.equal(amendResult.previousStatus, 'ABSENT');
    assert.equal(amendResult.newStatus, 'PRESENT');

    // Verify local_amendment_audits table
    const auditRow = db.prepare('SELECT * FROM local_amendment_audits WHERE client_amendment_id = ?;').get('amd-uuid-target-001');
    assert.ok(auditRow, 'Amendment audit row must exist');
    assert.equal(auditRow.actor_membership_id, 'mem-prof-uuid');
    assert.equal(auditRow.authorizing_role_assignment_id, 'ra-prof-01');
    assert.equal(auditRow.permission_code, 'attendance.amend');
    assert.equal(auditRow.scope_type, 'TEACHING_ASSIGNMENT');
    assert.equal(auditRow.scope_resource_id, 'ta-cs302-secB');

    // Verify sync_queue amendment row
    const qRow = db.prepare('SELECT * FROM sync_queue WHERE client_amendment_id = ?;').get('amd-uuid-target-001');
    assert.ok(qRow, 'Amendment sync_queue row must exist');
    assert.equal(qRow.operation_type, 'AMENDMENT_SYNC');
    assert.equal(qRow.actor_membership_id, 'mem-prof-uuid');
    assert.equal(qRow.authorizing_role_assignment_id, 'ra-prof-01');
    assert.equal(qRow.authorization_version, 'v1.0');
  });
});
