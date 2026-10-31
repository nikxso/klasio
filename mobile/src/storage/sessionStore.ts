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
  setSession(session: AuthSession | null): void {
    activeSession = session;
    import('./database').then(({ getDatabase }) => {
      getDatabase().then((db) => {
        if (session) {
          db.runAsync(
            `INSERT OR REPLACE INTO local_auth_session (id, token, user_json, updated_at) VALUES (1, ?, ?, ?);`,
            [session.token, JSON.stringify(session.user), new Date().toISOString()]
          ).catch(() => {});
        } else {
          db.runAsync('DELETE FROM local_auth_session WHERE id = 1;').catch(() => {});
        }
      }).catch(() => {});
    }).catch(() => {});
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

  clear(): void {
    activeSession = null;
    import('./database').then(({ getDatabase }) => {
      getDatabase().then((db) => {
        db.runAsync('DELETE FROM local_auth_session WHERE id = 1;').catch(() => {});
      }).catch(() => {});
    }).catch(() => {});
  },
};
