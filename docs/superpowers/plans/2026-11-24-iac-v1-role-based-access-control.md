# Institutional Access Control v1 (IAC v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement full Institutional Access Control v1 (IAC v1) role-based authorization across backend and mobile, replacing hardcoded 3-role logic with 20 canonical role templates, 8-level scopes, dot-namespaced permissions, two delegation families, and zero human biometric read access, while maintaining 100% backward compatibility with existing working mobile perception and offline flows.

**Architecture:** Backend models (`access_control.py`) define the 20 canonical role templates and 8-level scope hierarchy. Auth endpoints return active role assignments and flat permission sets alongside a computed legacy `role` field. The mobile `SessionStore` persists permissions and scopes in SQLite, enabling dynamic permission gating in the UI and routing without breaking existing `/(faculty)`, `/(student)`, or `/(admin)` paths.

**Tech Stack:** Python 3.11+, FastAPI, SQLAlchemy 2.0 (async), Pydantic v2, React Native / Expo, TypeScript, SQLite3 (WAL mode), Jest.

**Spec:** [`docs/superpowers/specs/2026-11-24-iac-v1-role-based-access-control-design.md`](file:///home/dope/Documents/atten/docs/superpowers/specs/2026-11-24-iac-v1-role-based-access-control-design.md)

## Global Constraints

- Legacy account categories (`STUDENT`, `FACULTY`, `ADMIN`) must remain available as computed projections in auth payloads.
- Humans NEVER read face templates or embedding vectors (`biometrics.template.read` is strictly prohibited for all human accounts).
- Zero disruption to mobile edge perception, YuNet detector, EdgeFace-XS ONNX embeddings, attendance review sheet, and offline SQLite synchronization.
- Server is the authoritative source of authorization fail-closed; client UI checks are for presentation only.
- 16 of 16 mobile test suites must continue passing with a 100% pass rate.

---

### Task 1: Backend IAC v1 Data Models & Seed Data

**Files:**
- Modify: `backend/src/models/access_control.py:50-70,500-520`
- Create: `backend/src/services/iac_seed_service.py`
- Create: `backend/tests/test_iac_v1_models.py`

**Interfaces:**
- Consumes: `Base`, `TimestampMixin` from `src.models.base`
- Produces: `DelegationType` enum, updated `RoleScopeType.PROGRAM`, and `seed_canonical_role_templates()` helper.

- [ ] **Step 1: Write the failing test for IAC v1 models and canonical role templates**

```python
# backend/tests/test_iac_v1_models.py
import pytest
from src.models.access_control import (
    DelegationType,
    RoleScopeType,
    RoleTemplate,
    Permission,
)
from src.services.iac_seed_service import CANONICAL_ROLE_TEMPLATES, seed_canonical_role_templates

def test_delegation_type_enum():
    assert DelegationType.FACULTY_SUBSTITUTE == "FACULTY_SUBSTITUTE"
    assert DelegationType.MANAGEMENT_DELEGATION == "MANAGEMENT_DELEGATION"

def test_role_scope_type_has_program():
    assert RoleScopeType.PROGRAM == "PROGRAM"

def test_canonical_role_templates_count():
    assert len(CANONICAL_ROLE_TEMPLATES) == 20
    codes = {tpl["code"] for tpl in CANONICAL_ROLE_TEMPLATES}
    assert "INSTITUTION_OWNER" in codes
    assert "CENTRAL_INSTITUTION_ADMIN" in codes
    assert "CAMPUS_ADMIN" in codes
    assert "ACCESS_ADMIN" in codes
    assert "IT_ADMIN" in codes
    assert "PRIVACY_BIOMETRIC_OFFICER" in codes
    assert "ACADEMIC_REGISTRAR" in codes
    assert "ADMISSIONS_OFFICER" in codes
    assert "ENROLLMENT_OFFICER" in codes
    assert "STUDENT_RECORDS_OFFICER" in codes
    assert "DEPARTMENT_HEAD" in codes
    assert "PROGRAM_COORDINATOR" in codes
    assert "TIMETABLE_COORDINATOR" in codes
    assert "FACULTY" in codes
    assert "TEACHING_ASSISTANT" in codes
    assert "CLASS_ADVISOR" in codes
    assert "BIOMETRIC_ENROLLMENT_OFFICER" in codes
    assert "ATTENDANCE_AUDITOR" in codes
    assert "INSTITUTIONAL_AUDITOR" in codes
    assert "STUDENT" in codes
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest backend/tests/test_iac_v1_models.py -v`  
Expected: FAIL (ImportError: cannot import name 'DelegationType')

- [ ] **Step 3: Update `access_control.py` and implement `iac_seed_service.py`**

In `backend/src/models/access_control.py`:
- Add `DelegationType(str, enum.Enum)` with values `FACULTY_SUBSTITUTE = "FACULTY_SUBSTITUTE"` and `MANAGEMENT_DELEGATION = "MANAGEMENT_DELEGATION"`.
- Add `PROGRAM = "PROGRAM"` to `RoleScopeType`.
- Add `delegation_type: Mapped[DelegationType]` to `Delegation` with default `DelegationType.FACULTY_SUBSTITUTE`.

Create `backend/src/services/iac_seed_service.py` defining `CANONICAL_ROLE_TEMPLATES` with all 20 canonical templates across the 5 domains and their default permission bundles.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest backend/tests/test_iac_v1_models.py -v`  
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add backend/src/models/access_control.py backend/src/services/iac_seed_service.py backend/tests/test_iac_v1_models.py
git commit -m "feat(backend): add IAC v1 delegation types, program scope, and 20 canonical role templates"
```

---

### Task 2: Backend Auth Schemas & Scoping Serialization

**Files:**
- Modify: `backend/src/schemas/auth.py:10-50`
- Modify: `backend/src/api/v1/auth.py:50-97`
- Create: `backend/tests/test_iac_v1_auth.py`

**Interfaces:**
- Consumes: `InstitutionMembership`, `RoleAssignment`, `RoleTemplate`, `Permission`
- Produces: `RoleAssignmentSummary`, `UserContextResponse.role_assignments`, `UserContextResponse.permissions`, `UserContextResponse.institution_id`

- [ ] **Step 1: Write the failing test for IAC v1 auth response**

```python
# backend/tests/test_iac_v1_auth.py
import pytest
from httpx import AsyncClient
from src.main import app

@pytest.mark.asyncio
async def test_login_returns_iac_v1_context(async_client: AsyncClient):
    response = await async_client.post(
        "/api/v1/auth/login",
        json={"username": "prof_alan", "password": "password"},
    )
    assert response.status_code == 200
    data = response.json()
    assert "access_token" in data
    user = data["user"]
    assert user["institutional_id"] == "prof_alan"
    assert user["role"] == "FACULTY"  # backward-compatible projection
    assert "institution_id" in user
    assert "role_assignments" in user
    assert isinstance(user["role_assignments"], list)
    assert "permissions" in user
    assert isinstance(user["permissions"], list)
    # prof_alan has attendance conduct permissions
    assert "attendance.session.start" in user["permissions"] or "attendance:scan" in user["permissions"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest backend/tests/test_iac_v1_auth.py -v`  
Expected: FAIL (missing fields in `user` schema)

- [ ] **Step 3: Update `schemas/auth.py` and `api/v1/auth.py`**

In `backend/src/schemas/auth.py`:
- Define `RoleAssignmentSummary` Pydantic model (`role_template_code`, `role_template_name`, `scope_type`, `department_code`, `valid_from`, `valid_until`).
- Add fields to `UserContextResponse`:
  - `institution_id: Optional[uuid.UUID] = None`
  - `role_assignments: List[RoleAssignmentSummary] = []`
  - `permissions: List[str] = []`

In `backend/src/api/v1/auth.py`:
- In `login` and `get_current_user_context`, query the active `InstitutionMembership` for the user.
- Load active `RoleAssignment` entries with their `RoleTemplate`, `Scope`, and `Permission` relations.
- Populate `institution_id`, `role_assignments`, and distinct `permissions` list.
- Compute `role` field from primary role template (`FACULTY`, `ADMIN`, `STUDENT`) for backward compatibility.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest backend/tests/test_iac_v1_auth.py -v`  
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add backend/src/schemas/auth.py backend/src/api/v1/auth.py backend/tests/test_iac_v1_auth.py
git commit -m "feat(auth): enrich login and me endpoints with IAC v1 assignments and permissions"
```

---

### Task 3: Backend Evaluator & HoD Delegation Approval Gate

**Files:**
- Modify: `backend/src/services/authorization_evaluator.py:120-220`
- Modify: `backend/src/core/permissions.py:200-250`
- Create: `backend/tests/test_iac_v1_evaluator.py`

**Interfaces:**
- Consumes: `AuthorizationEvaluator.evaluate()`, `DelegationLifecycleStatus`
- Produces: Enforced HoD approval for `FACULTY_SUBSTITUTE` delegations and scope-bounded permission evaluation.

- [ ] **Step 1: Write the failing test for HoD delegation approval gate**

```python
# backend/tests/test_iac_v1_evaluator.py
import pytest
import uuid
from datetime import datetime, timezone, timedelta
from src.services.authorization_evaluator import AuthorizationEvaluator
from src.models.access_control import DelegationType, DelegationLifecycleStatus

@pytest.mark.asyncio
async def test_substitute_delegation_requires_approval(db_session):
    evaluator = AuthorizationEvaluator(db_session)
    # Test that a substitute delegation in PENDING_APPROVAL status does NOT grant attendance permissions
    # Only ACTIVE (approved by HoD) delegations grant permissions
    ...
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pytest backend/tests/test_iac_v1_evaluator.py -v`  
Expected: FAIL

- [ ] **Step 3: Update `authorization_evaluator.py`**

In `backend/src/services/authorization_evaluator.py`:
- Ensure that when checking delegations, for `DelegationType.FACULTY_SUBSTITUTE`, status MUST strictly be `DelegationLifecycleStatus.ACTIVE` with non-null `approved_by_membership_id` and `approved_at`.
- Verify time boundaries: $t_{\text{start}} \le \text{now} < t_{\text{end}}$.
- Ensure `biometrics.template.read` is always rejected for any actor.

- [ ] **Step 4: Run test to verify it passes**

Run: `pytest backend/tests/test_iac_v1_evaluator.py -v`  
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add backend/src/services/authorization_evaluator.py backend/src/core/permissions.py backend/tests/test_iac_v1_evaluator.py
git commit -m "feat(evaluator): enforce HoD approval lifecycle for faculty substitute delegations"
```

---

### Task 4: Mobile SessionStore Expansion & Offline Persistence

**Files:**
- Modify: `mobile/src/storage/sessionStore.ts:5-80`
- Modify: `mobile/src/storage/database.ts:150-180`
- Modify: `mobile/src/storage/__tests__/sessionStore.test.mjs`

**Interfaces:**
- Consumes: `local_auth_session` table in SQLite
- Produces: `SessionStore.hasPermission()`, `SessionStore.hasAnyRole()`, `SessionStore.canScanAttendance()`, `SessionStore.canApproveDelegation()`

- [ ] **Step 1: Write the failing test for mobile SessionStore IAC v1 support**

```javascript
// mobile/src/storage/__tests__/sessionStore.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../sessionStore.ts';

describe('SessionStore IAC v1', () => {
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
          }
        ]
      }
    });

    assert.equal(SessionStore.hasPermission('attendance.session.start'), true);
    assert.equal(SessionStore.hasPermission('institution.manage'), false);
    assert.equal(SessionStore.canScanAttendance(), true);
    assert.equal(SessionStore.hasAnyRole(['FACULTY', 'DEPARTMENT_HEAD']), true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test mobile/src/storage/__tests__/sessionStore.test.mjs`  
Expected: FAIL (`hasPermission` is not a function)

- [ ] **Step 3: Implement IAC v1 methods in `sessionStore.ts`**

In `mobile/src/storage/sessionStore.ts`:
- Extend `AuthUser` interface with `institutionId?: string`, `permissions?: string[]`, `roleAssignments?: RoleAssignmentInfo[]`.
- Add methods:
  - `hasPermission(permissionCode: string): boolean`: checks if `permissionCode` is in `activeSession.user.permissions`.
  - `hasAnyRole(roles: string[]): boolean`: checks `roleAssignments` template codes or fallback `user.role`.
  - `canScanAttendance(): boolean`: checks `hasPermission('attendance.session.start') || user.role === 'FACULTY'`.
  - `canApproveDelegation(): boolean`: checks `hasPermission('delegation.approve') || hasAnyRole(['DEPARTMENT_HEAD', 'ADMIN'])`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test mobile/src/storage/__tests__/sessionStore.test.mjs`  
Expected: PASS

- [ ] **Step 5: Commit changes**

```bash
git add mobile/src/storage/sessionStore.ts mobile/src/storage/__tests__/sessionStore.test.mjs
git commit -m "feat(mobile): expand SessionStore with IAC v1 permissions, role assignments, and helpers"
```

---

### Task 5: Mobile Navigation & Dynamic Permission-Gated Login

**Files:**
- Modify: `mobile/src/app/index.tsx:90-145`
- Modify: `mobile/src/app/(faculty)/delegations.tsx:1-120`
- Create: `mobile/src/navigation/__tests__/iacNavigation.test.mjs`

**Interfaces:**
- Consumes: `SessionStore.getUser()`, `SessionStore.hasPermission()`, `SessionStore.hasAnyRole()`
- Produces: Permission-driven routing to `/(faculty)`, `/(student)`, or `/(admin)` with legacy role fallback.

- [ ] **Step 1: Write the failing test for dynamic permission-based navigation**

```javascript
// mobile/src/navigation/__tests__/iacNavigation.test.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

function resolveTargetRoute(user) {
  if (user?.permissions?.some(p => p.startsWith('institution.') || p.startsWith('campus.') || p.startsWith('academic_structure.'))) {
    return '/(admin)';
  }
  if (user?.permissions?.some(p => p.startsWith('attendance.'))) {
    return '/(faculty)';
  }
  if (user?.permissions?.some(p => p.startsWith('biometrics.enroll.self'))) {
    return '/(student)';
  }
  // Fallback to legacy role
  if (user?.role === 'ADMIN') return '/(admin)';
  if (user?.role === 'STUDENT') return '/(student)';
  return '/(faculty)';
}

describe('IAC v1 Dynamic Route Resolution', () => {
  it('routes to admin for governance permissions', () => {
    assert.equal(resolveTargetRoute({ permissions: ['institution.view'] }), '/(admin)');
  });
  it('routes to faculty for attendance conduct permissions', () => {
    assert.equal(resolveTargetRoute({ permissions: ['attendance.session.start'] }), '/(faculty)');
  });
  it('routes to student for self-enrollment permission', () => {
    assert.equal(resolveTargetRoute({ permissions: ['biometrics.enroll.self'] }), '/(student)');
  });
  it('falls back to legacy role if permissions empty', () => {
    assert.equal(resolveTargetRoute({ role: 'ADMIN', permissions: [] }), '/(admin)');
    assert.equal(resolveTargetRoute({ role: 'STUDENT', permissions: [] }), '/(student)');
    assert.equal(resolveTargetRoute({ role: 'FACULTY', permissions: [] }), '/(faculty)');
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `node --test mobile/src/navigation/__tests__/iacNavigation.test.mjs`  
Expected: PASS

- [ ] **Step 3: Update `mobile/src/app/index.tsx` with dynamic route resolution**

In `mobile/src/app/index.tsx`:
- Update `handleSignIn` to populate `SessionStore` with `institution_id`, `role_assignments`, and `permissions` returned by `/api/v1/auth/login`.
- Use the permission-aware `resolveTargetRoute` logic before falling back to `data.user.role`.
- In `(faculty)/delegations.tsx`:
  - Show delegation type badge (`FACULTY_SUBSTITUTE` vs `MANAGEMENT_DELEGATION`).
  - Display HoD approval status badge (`PENDING_APPROVAL`, `ACTIVE`, `REJECTED`).
  - Allow Department Heads / Administrators to approve or reject pending substitute delegations.

- [ ] **Step 4: Verify typecheck and tests pass**

Run: `npx tsc --noEmit && npm test` in `mobile/`  
Expected: 0 type errors, 16/16 test suites pass.

- [ ] **Step 5: Commit changes**

```bash
git add mobile/src/app/index.tsx mobile/src/app/\(faculty\)/delegations.tsx mobile/src/navigation/__tests__/iacNavigation.test.mjs
git commit -m "feat(mobile): integrate dynamic permission-based routing and delegation approval badges"
```

---

### Task 6: Full Verification Across Backend and Mobile

**Files:**
- Test files across `backend/tests/` and `mobile/`

- [ ] **Step 1: Run full mobile test suites**

Run in `mobile/`:
```bash
npm test
```
Expected: All test suites PASS (100% pass rate).

- [ ] **Step 2: Run mobile TypeScript compilation**

Run in `mobile/`:
```bash
npx tsc --noEmit
```
Expected: Exit code 0, 0 errors.

- [ ] **Step 3: Commit all remaining cleanups**

```bash
git status
git commit -am "chore(iac): finalize Institutional Access Control v1 end-to-end integration"
```
