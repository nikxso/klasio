/**
 * In-memory and persistent session store for Klasio Mobile.
 * Preserves authenticated operator context and tokens across screens and app restarts.
 * Fully supports IAC v1 granular permissions and canonical role assignments.
 */

export interface RoleAssignmentInfo {
  roleTemplateCode: string;
  roleTemplateName: string;
  scopeType: string;
  departmentCode?: string;
  validFrom?: string;
  validUntil?: string | null;
}

export interface AuthUser {
  id: string;
  institutionalId: string;
  email: string;
  fullName: string;
  role: 'STUDENT' | 'FACULTY' | 'ADMIN' | string;
  faceRegistrationState?: 'UNREGISTERED' | 'PENDING' | 'REGISTERED';
  institutionId?: string;
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

export const SessionStore = {
  setDatabase(db: any): void {
    customDbOverride = db;
  },

  resetMemoryForTesting(): void {
    activeSession = null;
  },

  async setSession(session: AuthSession | null): Promise<void> {
    activeSession = session;
    try {
      const db = await getSessionDb();
      if (session) {
        await db.runAsync(
          `INSERT OR REPLACE INTO local_auth_session (id, token, user_json, updated_at) VALUES (1, ?, ?, ?);`,
          [session.token, JSON.stringify(session.user), new Date().toISOString()]
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
      const row = await db.getFirstAsync<{ token: string; user_json: string }>(
        'SELECT token, user_json FROM local_auth_session WHERE id = 1;'
      );
      if (row?.token && row?.user_json) {
        activeSession = {
          token: row.token,
          user: JSON.parse(row.user_json),
        };
        return activeSession;
      }
    } catch (e: any) {
      if (shouldLogWarning(e)) {
        console.error('[SessionStore] initFromStorage error:', e?.message || e);
      }
    }
    return null;
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
      this.hasAnyRole(['FACULTY'])
    );
  },

  canApproveDelegation(): boolean {
    return (
      this.hasPermission('delegation.approve') ||
      this.hasPermission('delegation:approve') ||
      this.hasAnyRole(['DEPARTMENT_HEAD', 'ADMIN', 'CENTRAL_INSTITUTION_ADMIN', 'CAMPUS_ADMIN'])
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
    this.clearSession(true).catch(() => {});
  },
};
