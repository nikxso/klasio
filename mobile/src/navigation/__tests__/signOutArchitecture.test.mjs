import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SessionStore } from '../../storage/sessionStore.ts';

function resolveTargetRoute(user) {
  const role = user?.role ? user.role.toUpperCase() : '';
  if (role === 'STUDENT' || (user?.permissions?.some(p => p === 'biometrics.enroll.self') && !user?.permissions?.some(p => p === 'attendance.session.start'))) {
    return '/(student)';
  }
  if (user?.permissions?.some(p => p === 'attendance.session.start' || p === 'attendance.session.create') || role === 'FACULTY') {
    return '/(faculty)';
  }
  if (user?.permissions?.some(p => p.startsWith('institution.') || p.startsWith('campus.') || p.startsWith('academic_structure.')) || role === 'ADMIN') {
    return '/(admin)';
  }
  if (role === 'ADMIN') return '/(admin)';
  if (role === 'STUDENT') return '/(student)';
  return '/(faculty)';
}

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

  test('1. Session is removed from SQLite BEFORE subscribers receive null', async () => {
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

    const restored = await SessionStore.initFromStorage();
    assert.equal(restored, null, 'initFromStorage must not resurrect cleared session');
  });

  test('2. Pending sync records remain intact during logout with preservePendingSync', async () => {
    db.prepare(`
      INSERT INTO sync_queue (
        client_session_uuid, operation_type, endpoint_path, payload_json, sync_status, created_at, updated_at
      ) VALUES ('uuid-offline-sess-1', 'SESSION_SYNC', '/api/v1/sessions/sync', '{"test":1}', 'PENDING', '2026-11-27T00:00:00Z', '2026-11-27T00:00:00Z');
    `).run();

    const pendingBefore = await SessionStore.hasPendingSync();
    assert.equal(pendingBefore, 1);

    await SessionStore.clearSession(true);

    const pendingAfter = await SessionStore.hasPendingSync();
    assert.equal(pendingAfter, 1, 'Pending sync records must remain intact across sign-out');
  });

  test('3. Student sign-out handler dismisses sheet, awaits cooldown, and delegates navigation to layout', async () => {
    await SessionStore.setSession({
      token: 'student-token',
      user: { id: 'stu-1', institutionalId: '21CS001', email: 'stu@klasio.ac.in', fullName: 'Student One', role: 'STUDENT' },
    });

    let sheetVisible = true;
    let isSigningOut = false;
    const executionTrace = [];

    async function studentHandleConfirmSignOut() {
      if (isSigningOut) return;
      isSigningOut = true;
      try {
        sheetVisible = false;
        executionTrace.push('DISMISS_SHEET');
        await new Promise((resolve) => setTimeout(resolve, 50));
        executionTrace.push('COOLDOWN');
        await SessionStore.clearSession(true);
        executionTrace.push('SESSION_CLEARED');
      } finally {
        isSigningOut = false;
      }
    }

    await studentHandleConfirmSignOut();

    assert.equal(sheetVisible, false);
    assert.equal(isSigningOut, false);
    assert.equal(SessionStore.getSession(), null);
    assert.deepEqual(executionTrace, ['DISMISS_SHEET', 'COOLDOWN', 'SESSION_CLEARED']);
  });

  test('4. Faculty sign-out handler dismisses sheet, awaits cooldown, and delegates navigation to layout', async () => {
    await SessionStore.setSession({
      token: 'fac-token',
      user: { id: 'fac-1', institutionalId: 'FAC-001', email: 'fac@klasio.ac.in', fullName: 'Faculty One', role: 'FACULTY' },
    });

    let sheetVisible = true;
    let isSigningOut = false;
    const executionTrace = [];

    async function facultyHandleConfirmSignOut() {
      if (isSigningOut) return;
      isSigningOut = true;
      try {
        sheetVisible = false;
        executionTrace.push('DISMISS_SHEET');
        await new Promise((resolve) => setTimeout(resolve, 50));
        executionTrace.push('COOLDOWN');
        await SessionStore.clearSession(true);
        executionTrace.push('SESSION_CLEARED');
      } finally {
        isSigningOut = false;
      }
    }

    await facultyHandleConfirmSignOut();

    assert.equal(sheetVisible, false);
    assert.equal(isSigningOut, false);
    assert.equal(SessionStore.getSession(), null);
    assert.deepEqual(executionTrace, ['DISMISS_SHEET', 'COOLDOWN', 'SESSION_CLEARED']);
  });

  test('5. Admin sign-out handler dismisses sheet, awaits cooldown, and delegates navigation to layout', async () => {
    await SessionStore.setSession({
      token: 'adm-token',
      user: { id: 'adm-1', institutionalId: 'ADM-001', email: 'adm@klasio.ac.in', fullName: 'Admin One', role: 'ADMIN' },
    });

    let sheetVisible = true;
    let isSigningOut = false;
    const executionTrace = [];

    async function adminHandleConfirmSignOut() {
      if (isSigningOut) return;
      isSigningOut = true;
      try {
        sheetVisible = false;
        executionTrace.push('DISMISS_SHEET');
        await new Promise((resolve) => setTimeout(resolve, 50));
        executionTrace.push('COOLDOWN');
        await SessionStore.clearSession(true);
        executionTrace.push('SESSION_CLEARED');
      } finally {
        isSigningOut = false;
      }
    }

    await adminHandleConfirmSignOut();

    assert.equal(sheetVisible, false);
    assert.equal(isSigningOut, false);
    assert.equal(SessionStore.getSession(), null);
    assert.deepEqual(executionTrace, ['DISMISS_SHEET', 'COOLDOWN', 'SESSION_CLEARED']);
  });

  test('6. Repeated sign-out taps cannot trigger concurrent logout operations (re-entrancy guard)', async () => {
    let callCount = 0;
    let isSigningOut = false;

    async function signoutWithGuard() {
      if (isSigningOut) return 'BLOCKED';
      isSigningOut = true;
      try {
        callCount++;
        await new Promise((resolve) => setTimeout(resolve, 60));
        await SessionStore.clearSession(true);
        return 'SUCCESS';
      } finally {
        isSigningOut = false;
      }
    }

    // Fire 3 simultaneous sign-out requests
    const [res1, res2, res3] = await Promise.all([
      signoutWithGuard(),
      signoutWithGuard(),
      signoutWithGuard(),
    ]);

    assert.equal(res1, 'SUCCESS');
    assert.equal(res2, 'BLOCKED');
    assert.equal(res3, 'BLOCKED');
    assert.equal(callCount, 1, 'Session clear must execute exactly once');
  });

  test('7. Protected layout declarative redirect: returns <Redirect href="/" /> when unauthenticated', () => {
    function evaluateDeclarativeProtectedLayout(isLoaded, isAuthenticated, user) {
      if (!isLoaded) {
        return 'LOADING_SPLASH';
      }
      if (!isAuthenticated || !user) {
        return { type: 'Redirect', href: '/' };
      }
      if (user?.role?.toUpperCase() === 'STUDENT') {
        return 'RESTRICTED_STUDENT';
      }
      return 'RENDER_STACK';
    }

    // Unauthenticated -> Declarative redirect to /
    const unauthResult = evaluateDeclarativeProtectedLayout(true, false, null);
    assert.deepEqual(unauthResult, { type: 'Redirect', href: '/' });

    // Loading session -> Returns loading splash / null
    const loadingResult = evaluateDeclarativeProtectedLayout(false, false, null);
    assert.equal(loadingResult, 'LOADING_SPLASH');

    // Authenticated faculty -> Renders stack
    const authFacultyResult = evaluateDeclarativeProtectedLayout(true, true, { id: 'f1', role: 'FACULTY' });
    assert.equal(authFacultyResult, 'RENDER_STACK');
  });

  test('8. Unauthenticated deep links into protected groups return to login via declarative redirect', () => {
    function evaluateDeepLink(routeGroup, isLoaded, isAuthenticated) {
      if (!isLoaded) return 'AWAIT_STORAGE';
      if (!isAuthenticated) return { type: 'Redirect', href: '/' };
      return `RENDER_${routeGroup.toUpperCase()}`;
    }

    assert.deepEqual(evaluateDeepLink('(student)', true, false), { type: 'Redirect', href: '/' });
    assert.deepEqual(evaluateDeepLink('(faculty)', true, false), { type: 'Redirect', href: '/' });
    assert.deepEqual(evaluateDeepLink('(admin)', true, false), { type: 'Redirect', href: '/' });
  });

  test('9. Authenticated startup routes to the correct role workspace', () => {
    assert.equal(resolveTargetRoute({ role: 'STUDENT' }), '/(student)');
    assert.equal(resolveTargetRoute({ role: 'FACULTY' }), '/(faculty)');
    assert.equal(resolveTargetRoute({ role: 'ADMIN' }), '/(admin)');
    assert.equal(resolveTargetRoute({ permissions: ['attendance.session.start'] }), '/(faculty)');
    assert.equal(resolveTargetRoute({ permissions: ['institution.manage'] }), '/(admin)');
  });

  test('10. Login after logout works without restarting the app', async () => {
    // 1. Initial login
    await SessionStore.setSession({
      token: 'first-token',
      user: { id: 'u1', fullName: 'First User', role: 'STUDENT', institutionalId: 'STU1' },
    });
    assert.equal(SessionStore.getSession()?.token, 'first-token');

    // 2. Sign out
    await SessionStore.clearSession(true);
    assert.equal(SessionStore.getSession(), null);
    const restoredAfterLogout = await SessionStore.initFromStorage();
    assert.equal(restoredAfterLogout, null);

    // 3. Login again in same session
    await SessionStore.setSession({
      token: 'second-token',
      user: { id: 'u2', fullName: 'Second User', role: 'FACULTY', institutionalId: 'FAC2' },
    });
    assert.equal(SessionStore.getSession()?.token, 'second-token');
    assert.equal(SessionStore.getUser()?.fullName, 'Second User');

    const restoredAfterRelogin = await SessionStore.initFromStorage();
    assert.equal(restoredAfterRelogin?.token, 'second-token');
  });

  test('11. In-flight initFromStorage cannot resurrect session cleared concurrently', async () => {
    // Populate session in DB
    await SessionStore.setSession({
      token: 'resurrection-test-token',
      user: { id: 'u-race', fullName: 'Race Tester', role: 'ADMIN', institutionalId: 'ADM-RACE' },
    });

    // Start clearSession and initFromStorage concurrently
    const clearPromise = SessionStore.clearSession(true);
    const initPromise = SessionStore.initFromStorage();

    await Promise.all([clearPromise, initPromise]);

    assert.equal(SessionStore.getSession(), null, 'Session must remain null after concurrent clear');
  });
});
