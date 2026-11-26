/**
 * In-memory and persistent session store for Klasio Mobile.
 * Preserves authenticated operator context and tokens across screens and app restarts.
 * Fully supports IAC v1 granular permissions and canonical role assignments.
 */

export interface RoleScopeInfo {
  scopeType: string;
  campusId?: string | null;
  departmentId?: string | null;
  departmentCode?: string | null;
  programId?: string | null;
  classSectionId?: string | null;
}

export interface RoleAssignmentInfo {
  id?: string;
  roleTemplateCode: string;
  roleTemplateName: string;
  scopeType: string;
  departmentCode?: string;
  scopes?: RoleScopeInfo[];
  permissions?: string[];
  validFrom?: string;
  validUntil?: string | null;
}

export interface AuthorizationSnapshot {
  membership_id?: string | null;
  user_id?: string;
  institution_id?: string | null;
  authorization_version?: string;
  validated_at?: string;
  expires_at?: string;
  role_assignments?: RoleAssignmentInfo[];
  effective_permissions?: string[];
}

export interface AuthUser {
  id: string;
  institutionalId: string;
  email: string;
  fullName: string;
  role: 'STUDENT' | 'FACULTY' | 'ADMIN' | string;
  faceRegistrationState?: 'UNREGISTERED' | 'PENDING' | 'REGISTERED';
  institutionId?: string;
  membershipId?: string;
  authorizationVersion?: string;
  authorizationSnapshot?: AuthorizationSnapshot;
  permissions?: string[];
  roleAssignments?: RoleAssignmentInfo[];
}

export interface AuthSession {
  token: string;
  user: AuthUser;
}

const PERMISSION_ALIASES: Record<string, string[]> = {
  'attendance.session.start': ['attendance:scan'],
  'attendance:scan': ['attendance.session.start'],
  'attendance.candidate.review': ['attendance:review'],
  'attendance:review': ['attendance.candidate.review'],
  'delegation.approve': ['delegation:approve'],
  'delegation:approve': ['delegation.approve'],
};

let activeSession: AuthSession | null = null;
let isInitialized = false;
let customDbOverride: any = null;

function shouldLogWarning(e: any): boolean {
  const msg = String(e?.message || '');
  if (msg.includes('expo-sqlite') || msg.includes('Cannot find module')) {
    return false;
  }
  if (e?.code === 'ERR_MODULE_NOT_FOUND') {
    return false;
  }
  if (process.env?.NODE_ENV === 'test') {
    return false;
  }
  return true;
}

async function getSessionDb() {
  if (customDbOverride) {
    return {
      async runAsync(sql: string, params: any[] = []): Promise<void> {
        if (typeof customDbOverride.runAsync === 'function') {
          return customDbOverride.runAsync(sql, params);
        }
        if (typeof customDbOverride.prepare === 'function') {
          customDbOverride.prepare(sql).run(...params);
          return;
        }
      },
      async getFirstAsync<T = any>(sql: string, params: any[] = []): Promise<T | null> {
        if (typeof customDbOverride.getFirstAsync === 'function') {
          return customDbOverride.getFirstAsync(sql, params);
        }
        if (typeof customDbOverride.prepare === 'function') {
          const row = customDbOverride.prepare(sql).get(...params);
          return (row as T) || null;
        }
        return null;
      },
    };
  }
  try {
    const { getDatabase } = await import('./database');
    const db = await getDatabase();
    return {
      async runAsync(sql: string, params: any[] = []): Promise<void> {
        await db.runAsync(sql, params);
      },
      async getFirstAsync<T = any>(sql: string, params: any[] = []): Promise<T | null> {
        return db.getFirstAsync(sql, params);
      },
    };
  } catch (err) {
    const { getDatabase } = await import('./database.ts');
    const db = await getDatabase();
    return {
      async runAsync(sql: string, params: any[] = []): Promise<void> {
        await db.runAsync(sql, params);
      },
      async getFirstAsync<T = any>(sql: string, params: any[] = []): Promise<T | null> {
        return db.getFirstAsync(sql, params);
      },
    };
  }
}

const sessionListeners = new Set<(session: AuthSession | null) => void>();

export const SessionStore = {
  subscribe(listener: (session: AuthSession | null) => void): () => void {
    sessionListeners.add(listener);
    return () => {
      sessionListeners.delete(listener);
    };
  },

  setDatabase(db: any): void {
    customDbOverride = db;
  },

  isInitialized(): boolean {
    return isInitialized;
  },

  resetMemoryForTesting(): void {
    activeSession = null;
    isInitialized = false;
  },

  async setSession(session: AuthSession | null): Promise<void> {
    activeSession = session;
    isInitialized = true;
    sessionListeners.forEach((listener) => {
      try {
        listener(session);
      } catch (err) {
        console.warn('[SessionStore] Listener callback error:', err);
      }
    });
    try {
      const db = await getSessionDb();
      if (session) {
        const user = session.user;
        const membershipId = user?.membershipId || 'default-membership';
        const snapshotJson = user?.authorizationSnapshot
          ? JSON.stringify(user.authorizationSnapshot)
          : JSON.stringify({
              membership_id: membershipId,
              user_id: user?.id,
              institution_id: user?.institutionId,
              authorization_version: user?.authorizationVersion || 'v1.0',
              role_assignments: user?.roleAssignments,
              effective_permissions: user?.permissions,
            });
        const authVersion = user?.authorizationVersion || 'v1.0';
        const nowIso = new Date().toISOString();
        const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();

        await db.runAsync(
          `INSERT OR REPLACE INTO local_auth_session (
             id, token, user_json, membership_id, authorization_snapshot_json,
             authorization_version, last_server_validation_at, snapshot_expires_at, updated_at
           ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?);`,
          [
            session.token,
            JSON.stringify(session.user),
            membershipId,
            snapshotJson,
            authVersion,
            nowIso,
            expiresAt,
            nowIso,
          ]
        );
      } else {
        await db.runAsync('DELETE FROM local_auth_session WHERE id = 1;');
      }
    } catch (e: any) {
      if (shouldLogWarning(e)) {
        console.warn('[SessionStore] setSession storage warning:', e?.message || e);
      }
    }
  },

  async initFromStorage(): Promise<AuthSession | null> {
    try {
      const db = await getSessionDb();
      const row = await db.getFirstAsync<{
        token: string;
        user_json: string;
        membership_id?: string;
        authorization_snapshot_json?: string;
        authorization_version?: string;
      }>(
        'SELECT token, user_json, membership_id, authorization_snapshot_json, authorization_version FROM local_auth_session WHERE id = 1;'
      );
      isInitialized = true;
      if (row?.token && row?.user_json) {
        const parsedUser = JSON.parse(row.user_json);
        if (row.membership_id) parsedUser.membershipId = row.membership_id;
        if (row.authorization_version) parsedUser.authorizationVersion = row.authorization_version;
        if (row.authorization_snapshot_json) {
          try {
            parsedUser.authorizationSnapshot = JSON.parse(row.authorization_snapshot_json);
          } catch {}
        }
        activeSession = {
          token: row.token,
          user: parsedUser,
        };
        sessionListeners.forEach((listener) => {
          try {
            listener(activeSession);
          } catch (err) {
            console.warn('[SessionStore] Listener callback error:', err);
          }
        });
        return activeSession;
      }
      activeSession = null;
    } catch (e: any) {
      isInitialized = true;
      if (shouldLogWarning(e)) {
        console.error('[SessionStore] initFromStorage error:', e?.message || e);
      }
    }
    return null;
  },

  getMembershipId(): string | undefined {
    return activeSession?.user?.membershipId;
  },

  getAuthorizationSnapshot(): AuthorizationSnapshot | null {
    return activeSession?.user?.authorizationSnapshot ?? null;
  },

  getEffectivePermissions(): string[] {
    return activeSession?.user?.permissions ?? [];
  },

  getSession(): AuthSession | null {
    return activeSession;
  },

  getToken(): string | undefined {
    return activeSession?.token;
  },

  getUser(): AuthUser | null {
    return activeSession?.user ?? null;
  },

  hasPermission(permissionCode: string): boolean {
    const permissions = activeSession?.user?.permissions;
    if (!permissions || !Array.isArray(permissions) || !permissionCode) {
      return false;
    }
    const normalizedTarget = permissionCode.trim().toLowerCase();
    const hasDirectMatch = permissions.some(
      (p) => typeof p === 'string' && p.trim().toLowerCase() === normalizedTarget
    );
    if (hasDirectMatch) {
      return true;
    }
    const aliases = PERMISSION_ALIASES[permissionCode] || PERMISSION_ALIASES[normalizedTarget];
    if (aliases) {
      const normalizedAliases = aliases.map((a) => a.toLowerCase());
      return permissions.some(
        (p) => typeof p === 'string' && normalizedAliases.includes(p.trim().toLowerCase())
      );
    }
    return false;
  },

  hasAnyRole(roles: string[]): boolean {
    if (!roles || !Array.isArray(roles) || roles.length === 0 || !activeSession?.user) {
      return false;
    }
    const targetRoles = new Set(roles.map((r) => r.trim().toUpperCase()));

    // 1. Check user.roleAssignments
    const assignments = activeSession.user.roleAssignments;
    if (Array.isArray(assignments)) {
      for (const assignment of assignments) {
        if (assignment?.roleTemplateCode && targetRoles.has(assignment.roleTemplateCode.trim().toUpperCase())) {
          return true;
        }
      }
    }

    // 2. Fallback check user.role
    const legacyRole = activeSession.user.role;
    if (legacyRole && targetRoles.has(legacyRole.trim().toUpperCase())) {
      return true;
    }

    return false;
  },

  canScanAttendance(): boolean {
    return (
      this.hasPermission('attendance.session.start') ||
      this.hasPermission('attendance:scan') ||
      this.hasAnyRole(['FACULTY', 'TEACHING_ASSISTANT', 'CLASS_ADVISOR'])
    );
  },

  canAccessAdmin(): boolean {
    return (
      this.hasPermission('institution.view') ||
      this.hasPermission('institution.manage') ||
      this.hasPermission('campus.view') ||
      this.hasPermission('campus.manage') ||
      this.hasPermission('academic_structure.view') ||
      this.hasPermission('access_control.assign_role') ||
      this.hasAnyRole([
        'ADMIN',
        'INSTITUTION_OWNER',
        'CENTRAL_INSTITUTION_ADMIN',
        'CAMPUS_ADMIN',
        'ACCESS_ADMIN',
        'IT_ADMIN',
        'PRIVACY_BIOMETRIC_OFFICER',
        'PRIVACY_BIOMETRIC_GOVERNANCE',
        'DEPARTMENT_HEAD',
        'DEPARTMENT_HEAD_COORDINATOR',
        'ACADEMIC_REGISTRAR',
        'PROGRAM_COORDINATOR',
        'TIMETABLE_COORDINATOR',
        'ADMISSIONS_OFFICER',
        'ENROLLMENT_OFFICER',
        'STUDENT_RECORDS_OFFICER',
      ])
    );
  },

  canManagePeople(): boolean {
    return (
      this.hasPermission('membership.view') ||
      this.hasPermission('membership.invite') ||
      this.hasPermission('membership.manage') ||
      this.hasPermission('role_assignment.view') ||
      this.hasPermission('student_records.update') ||
      this.hasAnyRole([
        'ADMIN',
        'INSTITUTION_OWNER',
        'CENTRAL_INSTITUTION_ADMIN',
        'CAMPUS_ADMIN',
        'ACCESS_ADMIN',
        'DEPARTMENT_HEAD',
        'DEPARTMENT_HEAD_COORDINATOR',
        'ACADEMIC_REGISTRAR',
        'STUDENT_RECORDS_OFFICER',
      ])
    );
  },

  canManageAccessControl(): boolean {
    return (
      this.hasPermission('role_assignment.create') ||
      this.hasPermission('role_assignment.revoke') ||
      this.hasPermission('security.policy.manage') ||
      this.hasAnyRole([
        'ADMIN',
        'INSTITUTION_OWNER',
        'CENTRAL_INSTITUTION_ADMIN',
        'ACCESS_ADMIN',
      ])
    );
  },

  canManageAcademics(): boolean {
    return (
      this.hasPermission('academic_structure.view') ||
      this.hasPermission('academic_structure.create') ||
      this.hasPermission('academic_structure.update') ||
      this.hasAnyRole([
        'ADMIN',
        'INSTITUTION_OWNER',
        'CENTRAL_INSTITUTION_ADMIN',
        'CAMPUS_ADMIN',
        'ACADEMIC_REGISTRAR',
        'DEPARTMENT_HEAD',
        'DEPARTMENT_HEAD_COORDINATOR',
        'PROGRAM_COORDINATOR',
        'TIMETABLE_COORDINATOR',
      ])
    );
  },

  canEditAcademics(): boolean {
    return (
      this.hasPermission('academic_structure.create') ||
      this.hasPermission('academic_structure.update') ||
      this.hasAnyRole([
        'ADMIN',
        'INSTITUTION_OWNER',
        'CENTRAL_INSTITUTION_ADMIN',
        'CAMPUS_ADMIN',
        'ACADEMIC_REGISTRAR',
      ])
    );
  },

  canManageSettings(): boolean {
    return (
      this.hasPermission('institution.manage') ||
      this.hasPermission('technical_settings.manage') ||
      this.hasPermission('security.policy.manage') ||
      this.hasPermission('biometrics.policy.manage') ||
      this.hasAnyRole([
        'ADMIN',
        'INSTITUTION_OWNER',
        'CENTRAL_INSTITUTION_ADMIN',
        'IT_ADMIN',
        'PRIVACY_BIOMETRIC_OFFICER',
        'PRIVACY_BIOMETRIC_GOVERNANCE',
      ])
    );
  },

  canViewReports(): boolean {
    return (
      this.hasPermission('reports.view') ||
      this.hasPermission('reports.export') ||
      this.hasAnyRole([
        'ADMIN',
        'INSTITUTION_OWNER',
        'CENTRAL_INSTITUTION_ADMIN',
        'CAMPUS_ADMIN',
        'DEPARTMENT_HEAD',
        'DEPARTMENT_HEAD_COORDINATOR',
        'FACULTY',
        'ATTENDANCE_AUDITOR',
        'INSTITUTIONAL_AUDITOR',
        'CLASS_ADVISOR',
      ])
    );
  },

  canExportReports(): boolean {
    return (
      this.hasPermission('reports.export') ||
      this.hasAnyRole([
        'ADMIN',
        'INSTITUTION_OWNER',
        'CENTRAL_INSTITUTION_ADMIN',
        'DEPARTMENT_HEAD',
        'DEPARTMENT_HEAD_COORDINATOR',
        'FACULTY',
        'ATTENDANCE_AUDITOR',
        'INSTITUTIONAL_AUDITOR',
      ])
    );
  },

  canConductAssistedEnrollment(): boolean {
    return (
      this.hasPermission('biometrics.enroll.assisted') ||
      this.hasAnyRole([
        'BIOMETRIC_ENROLLMENT_OFFICER',
        'ADMIN',
        'INSTITUTION_OWNER',
        'CENTRAL_INSTITUTION_ADMIN',
        'FACULTY',
      ])
    );
  },

  canManageDelegations(): boolean {
    return (
      this.hasPermission('delegation.create') ||
      this.hasPermission('delegation.approve') ||
      this.hasPermission('role.delegate') ||
      this.canApproveDelegation() ||
      this.hasAnyRole([
        'FACULTY',
        'DEPARTMENT_HEAD',
        'DEPARTMENT_HEAD_COORDINATOR',
        'ADMIN',
        'CENTRAL_INSTITUTION_ADMIN',
        'CAMPUS_ADMIN',
      ])
    );
  },

  canViewClasses(): boolean {
    return (
      this.canScanAttendance() ||
      this.hasPermission('academic_structure.view') ||
      this.hasAnyRole(['FACULTY', 'TEACHING_ASSISTANT', 'CLASS_ADVISOR'])
    );
  },

  isDualRole(): boolean {
    return this.canAccessAdmin() && this.canScanAttendance();
  },

  canApproveDelegation(): boolean {
    return (
      this.hasPermission('delegation.approve') ||
      this.hasPermission('delegation:approve') ||
      this.hasAnyRole(['DEPARTMENT_HEAD', 'DEPARTMENT_HEAD_COORDINATOR', 'ADMIN', 'CENTRAL_INSTITUTION_ADMIN', 'CAMPUS_ADMIN'])
    );
  },

  async hasPendingSync(userId?: string): Promise<number> {
    try {
      const db = await getSessionDb();
      const row = await db.getFirstAsync<{ count: number }>(
        "SELECT COUNT(*) as count FROM sync_queue WHERE sync_status = 'PENDING';"
      );
      return row?.count ?? 0;
    } catch (e) {
      return 0;
    }
  },

  async clearSession(preservePendingSync: boolean = true): Promise<void> {
    activeSession = null;
    isInitialized = true;
    sessionListeners.forEach((listener) => {
      try {
        listener(null);
      } catch (err) {
        console.warn('[SessionStore] Listener callback error:', err);
      }
    });
    try {
      const db = await getSessionDb();
      await db.runAsync('DELETE FROM local_auth_session WHERE id = 1;');
      if (!preservePendingSync) {
        await db.runAsync("DELETE FROM sync_queue WHERE sync_status = 'PENDING';");
      }
    } catch (e: any) {
      if (shouldLogWarning(e)) {
        console.warn('[SessionStore] clearSession storage warning:', e?.message || e);
      }
    }
  },

  clear(): void {
    activeSession = null;
    isInitialized = true;
    sessionListeners.forEach((listener) => {
      try {
        listener(null);
      } catch (err) {
        console.warn('[SessionStore] Listener callback error:', err);
      }
    });
    this.clearSession(true).catch(() => {});
  },
};
