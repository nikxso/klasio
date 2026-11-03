/**
 * In-memory and persistent session store for Klasio Mobile.
 * Preserves authenticated operator context and tokens across screens.
 */

export interface AuthUser {
  id: string;
  institutionalId: string;
  email: string;
  fullName: string;
  role: 'STUDENT' | 'FACULTY' | 'ADMIN';
  faceRegistrationState?: 'UNREGISTERED' | 'PENDING' | 'REGISTERED';
}

export interface AuthSession {
  token: string;
  user: AuthUser;
}

let activeSession: AuthSession | null = null;

export const SessionStore = {
  async setSession(session: AuthSession | null): Promise<void> {
    activeSession = session;
    try {
      const { getDatabase } = await import('./database');
      const db = await getDatabase();
      if (session) {
        await db.runAsync(
          `INSERT OR REPLACE INTO local_auth_session (id, token, user_json, updated_at) VALUES (1, ?, ?, ?);`,
          [session.token, JSON.stringify(session.user), new Date().toISOString()]
        );
      } else {
        await db.runAsync('DELETE FROM local_auth_session WHERE id = 1;');
      }
    } catch (e: any) {
      console.warn('[SessionStore] setSession storage warning:', e?.message || e);
    }
  },

  async initFromStorage(): Promise<AuthSession | null> {
    try {
      const { getDatabase } = await import('./database');
      const db = await getDatabase();
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
      console.error('[SessionStore] initFromStorage error:', e?.message || e);
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

  async hasPendingSync(userId?: string): Promise<number> {
    try {
      const { getDatabase } = await import('./database');
      const db = await getDatabase();
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
      const { getDatabase } = await import('./database');
      const db = await getDatabase();
      await db.runAsync('DELETE FROM local_auth_session WHERE id = 1;');
      if (!preservePendingSync) {
        await db.runAsync("DELETE FROM sync_queue WHERE sync_status = 'PENDING';");
      }
    } catch (e: any) {
      console.warn('[SessionStore] clearSession storage warning:', e?.message || e);
    }
  },

  clear(): void {
    activeSession = null;
    this.clearSession(true).catch(() => {});
  },
};
