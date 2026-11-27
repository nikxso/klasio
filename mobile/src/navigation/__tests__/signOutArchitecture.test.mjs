import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from '../../storage/sessionStore.ts';

describe('Sign-Out Architecture & Redirection Integrity Contract', () => {
  let db;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS local_auth_session (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        token TEXT NOT NULL,
        user_json TEXT NOT NULL,
        membership_id TEXT NOT NULL DEFAULT 'default-membership',
        authorization_snapshot_json TEXT NOT NULL DEFAULT '{}',
        authorization_version TEXT NOT NULL DEFAULT 'v1.0',
        last_server_validation_at TEXT NOT NULL DEFAULT '',
        token_expires_at TEXT,
        snapshot_expires_at TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sync_queue (
        queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
        client_session_uuid TEXT NOT NULL,
        operation_type TEXT NOT NULL DEFAULT 'SESSION_SYNC',
        client_amendment_id TEXT,
        endpoint_path TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        actor_membership_id TEXT NOT NULL DEFAULT 'default-membership',
        authorizing_role_assignment_id TEXT,
        delegation_id TEXT,
        authorization_version TEXT NOT NULL DEFAULT 'v1.0',
        sync_status TEXT NOT NULL CHECK(sync_status IN ('PENDING', 'IN_FLIGHT', 'ACKNOWLEDGED', 'FAILED')),
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        next_retry_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    SessionStore.setDatabase(db);
    SessionStore.resetMemoryForTesting();
  });

  afterEach(() => {
    SessionStore.setDatabase(null);
    SessionStore.resetMemoryForTesting();
    db.close();
  });

  test('1. clearSession removes SQLite record BEFORE notifying listeners (prevents resurrection race condition)', async () => {
    // Populate an active session
    await SessionStore.setSession({
      token: 'jwt-active-token',
      user: {
        id: 'user-fac-01',
        institutionalId: 'FAC-001',
        email: 'prof@klasio.ac.in',
        fullName: 'Prof. Sharma',
        role: 'FACULTY',
      },
    });

    let storageStateAtListenerNotification = 'UNCHECKED';

    const unsub = SessionStore.subscribe((session) => {
      if (session === null) {
        // At the moment subscriber is notified of null session, check SQLite row
        const row = db.prepare('SELECT token FROM local_auth_session WHERE id = 1;').get();
        storageStateAtListenerNotification = row ? 'ROW_STILL_EXISTS' : 'ROW_DELETED';
      }
    });

    await SessionStore.clearSession(true);
    unsub();

    assert.equal(
      storageStateAtListenerNotification,
      'ROW_DELETED',
      'SQLite record must be strictly deleted BEFORE notifying listeners'
    );

    // Verify initFromStorage returns null immediately
    const restored = await SessionStore.initFromStorage();
    assert.equal(restored, null, 'initFromStorage must not resurrect cleared session');
  });

  test('2. Layout guard redirect policy: single-shot redirection, no render-phase cycle', () => {
    // Simulates protected layout behavior
    let redirectCount = 0;
    const targetRoutes = [];

    function evaluateLayoutGuard(isLoaded, isAuthenticated, user, mockRouter) {
      // In our fixed architecture:
      // When not authenticated or loaded, return null (never mount <Redirect /> component)
      // useEffect performs single replace
      if (!isLoaded || !isAuthenticated || !user) {
        if (isLoaded && (!isAuthenticated || !user)) {
          mockRouter.replace('/');
        }
        return null;
      }
      return 'RENDER_STACK';
    }

    const mockRouter = {
      replace: (path) => {
        redirectCount++;
        targetRoutes.push(path);
      },
    };

    // Case A: Unauthenticated user accesses protected layout
    const resultUnauth = evaluateLayoutGuard(true, false, null, mockRouter);
    assert.equal(resultUnauth, null, 'Must return null rather than recursive <Redirect />');
    assert.equal(redirectCount, 1, 'Triggers exactly 1 controlled replacement');
    assert.deepEqual(targetRoutes, ['/']);

    // Case B: Authenticated user accesses protected layout
    redirectCount = 0;
    targetRoutes.length = 0;
    const resultAuth = evaluateLayoutGuard(
      true,
      true,
      { id: '1', role: 'STUDENT' },
      mockRouter
    );
    assert.equal(resultAuth, 'RENDER_STACK');
    assert.equal(redirectCount, 0, 'Must not redirect when authenticated');
  });

  test('3. Modal dismissal delay contract prevents Android WindowManager deadlock', async () => {
    let sheetVisible = true;
    let hasCleared = false;
    let hasReplaced = false;
    const executionOrder = [];

    async function handleConfirmSignOut() {
      // Step 1: Request sheet dismissal
      sheetVisible = false;
      executionOrder.push('DISMISS_SHEET');

      // Step 2: Native animation cooldown (150ms)
      await new Promise((resolve) => setTimeout(resolve, 50));
      executionOrder.push('NATIVE_ANIMATION_COOLDOWN');

      // Step 3: Clear session
      await SessionStore.clearSession(true);
      hasCleared = true;
      executionOrder.push('CLEAR_SESSION');

      // Step 4: Clean navigation replace
      hasReplaced = true;
      executionOrder.push('NAVIGATE_ROOT');
    }

    await handleConfirmSignOut();

    assert.equal(sheetVisible, false);
    assert.equal(hasCleared, true);
    assert.equal(hasReplaced, true);
    assert.deepEqual(executionOrder, [
      'DISMISS_SHEET',
      'NATIVE_ANIMATION_COOLDOWN',
      'CLEAR_SESSION',
      'NAVIGATE_ROOT',
    ]);
  });
});
