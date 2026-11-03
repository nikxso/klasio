"""Security and Authorization Integration Audit (Task T083).

Validates end-to-end security invariants across all project domains:
1. Role-Boundary Enforcement:
   - Unauthenticated requests rejected (HTTP 401).
   - Student role locked out of faculty and administrative portals (HTTP 403).
   - Faculty role locked out of administrative and student personal portals (HTTP 403).
   - Administrator capabilities and boundaries verified.
   - Suspended user token invalidation and lockout (HTTP 401).
2. Student Roster and Academic-Scope Lockout:
   - Faculty restricted to assigned or actively delegated offerings (HTTP 403 OUT_OF_SCOPE).
   - Students strictly excluded from class biometric galleries and roster queries (SC-008, HTTP 403).
   - Student personal attendance strictly scoped to authenticated user context.
   - Expired and revoked substitute delegations provide zero permissions.
3. Substitute Delegation and Non-Subdelegation:
   - Authorized regular faculty creates active delegation.
   - Substitute faculty strictly barred from cascading sub-delegation (HTTP 403 OUT_OF_SCOPE).
   - Substitute faculty barred from post-finalization amendments (HTTP 403 OUT_OF_SCOPE).
   - Substitute faculty barred from revoking delegations (HTTP 403 OUT_OF_SCOPE).
   - Self-delegation rejected (HTTP 400).
4. SQL Injection and Malformed Identifiers:
   - SQL injection attack payloads in login, query parameters, and IDs rejected cleanly.
   - Malformed UUID path parameters return HTTP 422 (never HTTP 500).
   - Unexpected identifier formats and malformed payloads rejected with standard validation errors.
   - Database integrity verified intact after adversarial injection attempts.
"""

from datetime import date, datetime, timedelta, timezone
from typing import Dict, Tuple
import uuid
import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from scripts.seed_catalog import seed_development_catalog
from src.core.security import create_access_token
from src.models.academic import AcademicTerm, ClassSection, Department, Subject
from src.models.assignment import DelegationStatus, SubstituteDelegation, TeachingAssignment
from src.models.attendance import AttendanceRecord, AttendanceSession, AttendanceStatus, MarkSource
from src.models.enrollment import FaceRegistrationStatus, StudentEnrollment, StudentFaceProfile
from src.models.user import AccountStatus, User, UserRole


async def login_user(client: AsyncClient, username: str, password: str = "password") -> Tuple[str, dict]:
    """Helper to authenticate through POST /api/v1/auth/login and retrieve token & user info."""
    resp = await client.post(
        "/api/v1/auth/login",
        json={"username": username, "password": password},
    )
    assert resp.status_code == 200, f"Authentication failed for {username}: {resp.text}"
    data = resp.json()
    return data["access_token"], data["user"]


@pytest.fixture
async def security_context(db_session: AsyncSession):
    """Seed baseline catalog and resolve domain entities for security audit."""
    summary = await seed_development_catalog(db_session, default_password="password")
    assert summary is not None

    # Resolve users
    users_res = await db_session.execute(select(User))
    users_by_id = {u.institutional_id: u for u in users_res.scalars().all()}

    # Resolve teaching assignments
    ta_res = await db_session.execute(select(TeachingAssignment))
    assignments = ta_res.scalars().all()

    alan_user = users_by_id["prof_alan"]
    ada_user = users_by_id["prof_ada"]

    ta_3a = next(a for a in assignments if a.faculty_user_id == alan_user.id)
    ta_3b = next(a for a in assignments if a.faculty_user_id == ada_user.id)

    # Resolve sections
    sections_res = await db_session.execute(select(ClassSection))
    sections_by_code = {s.section_code: s for s in sections_res.scalars().all()}

    return {
        "admin": users_by_id["admin_meera"],
        "prof_alan": alan_user,
        "prof_ada": ada_user,
        "prof_grace": users_by_id["prof_grace"],
        "s1": users_by_id["S1"],
        "s2": users_by_id["S2"],
        "s3": users_by_id["S3"],
        "ta_3a": ta_3a,
        "ta_3b": ta_3b,
        "section_3a": sections_by_code["CSE-3A"],
        "section_3b": sections_by_code["CSE-3B"],
    }


# ==============================================================================
# 1. Role-Boundary Enforcement
# ==============================================================================

@pytest.mark.asyncio
async def test_unauthenticated_requests_across_all_domains_rejected(
    async_client: AsyncClient,
    security_context: dict,
):
    """Verify that unauthenticated requests to protected endpoints return HTTP 401 Unauthorized."""
    ctx = security_context
    sample_uuid = str(ctx["ta_3a"].id)

    protected_endpoints = [
        ("GET", "/api/v1/auth/me", None),
        ("GET", "/api/v1/faculty/assignments", None),
        ("GET", f"/api/v1/faculty/assignments/{sample_uuid}/roster?session_date=2026-09-10", None),
        ("POST", f"/api/v1/faculty/assignments/{sample_uuid}/delegations", {}),
        ("POST", f"/api/v1/faculty/delegations/{sample_uuid}/revoke", {}),
        ("GET", "/api/v1/student/attendance", None),
        ("POST", "/api/v1/attendance/sessions", {}),
        ("POST", "/api/v1/attendance/sessions/sync", {"sessions": []}),
        ("POST", f"/api/v1/attendance/sessions/{sample_uuid}/amendments", {}),
        ("GET", f"/api/v1/attendance/sessions/{sample_uuid}/amendments", None),
        ("POST", "/api/v1/admin/departments", {"code": "NEW", "name": "New Dept"}),
        ("POST", "/api/v1/admin/terms", {}),
        ("POST", "/api/v1/admin/subjects", {}),
        ("POST", "/api/v1/admin/sections", {}),
        ("POST", "/api/v1/admin/assignments", {}),
        ("POST", "/api/v1/admin/enrollments", {}),
        ("POST", "/api/v1/admin/enrollments/transfer", {}),
    ]

    for method, path, payload in protected_endpoints:
        if method == "GET":
            resp = await async_client.get(path)
        else:
            resp = await async_client.post(path, json=payload)

        assert resp.status_code == 401, f"Expected 401 for unauthenticated {method} {path}, got {resp.status_code}: {resp.text}"
        data = resp.json()
        assert data.get("error") == "AUTHENTICATION_FAILED"
        assert "Bearer" in resp.headers.get("www-authenticate", "")


@pytest.mark.asyncio
async def test_student_role_lockout_from_faculty_and_admin_endpoints(
    async_client: AsyncClient,
    security_context: dict,
):
    """Verify that an authenticated Student cannot access faculty, attendance-conduct, or admin endpoints."""
    ctx = security_context
    token_s1, _ = await login_user(async_client, "S1")
    headers_student = {"Authorization": f"Bearer {token_s1}"}
    sample_uuid = str(ctx["ta_3a"].id)

    forbidden_faculty_endpoints = [
        ("GET", "/api/v1/faculty/assignments", None),
        ("GET", f"/api/v1/faculty/assignments/{sample_uuid}/roster?session_date=2026-09-10", None),
        ("POST", f"/api/v1/faculty/assignments/{sample_uuid}/delegations", {
            "substitute_faculty_user_id": str(ctx["prof_grace"].id),
            "start_date": "2026-10-05",
            "end_date": "2026-10-05",
            "delegation_reason": "Unauthorized attempt",
        }),
        ("POST", f"/api/v1/faculty/delegations/{sample_uuid}/revoke", {"revocation_reason": "Unauthorized attempt"}),
        ("POST", "/api/v1/attendance/sessions", {
            "client_session_uuid": str(uuid.uuid4()),
            "teaching_assignment_id": sample_uuid,
            "session_date": "2026-09-10",
            "period_slot_or_sequence": 1,
            "applicability_status": "COUNTED",
            "records": [],
        }),
        ("POST", "/api/v1/attendance/sessions/sync", {"sessions": []}),
        ("POST", f"/api/v1/attendance/sessions/{sample_uuid}/amendments", {
            "student_user_id": str(ctx["s1"].id),
            "new_status": "PRESENT",
            "amendment_reason": "Tampering attempt",
        }),
        ("GET", f"/api/v1/attendance/sessions/{sample_uuid}/amendments", None),
    ]

    for method, path, payload in forbidden_faculty_endpoints:
        if method == "GET":
            resp = await async_client.get(path, headers=headers_student)
        else:
            resp = await async_client.post(path, headers=headers_student, json=payload)

        assert resp.status_code == 403, f"Expected 403 for student accessing {method} {path}, got {resp.status_code}"
        assert resp.json()["error"] == "INSUFFICIENT_ROLE"

    # Forbidden Admin endpoints for student
    admin_resp = await async_client.post(
        "/api/v1/admin/departments",
        headers=headers_student,
        json={"code": "HACK", "name": "Unauthorized Dept"},
    )
    assert admin_resp.status_code == 403
    assert admin_resp.json()["error"] == "INSUFFICIENT_ROLE"


@pytest.mark.asyncio
async def test_faculty_role_lockout_from_admin_and_student_endpoints(
    async_client: AsyncClient,
    security_context: dict,
):
    """Verify that an authenticated Faculty member cannot access administrative or student personal endpoints."""
    ctx = security_context
    token_alan, _ = await login_user(async_client, "prof_alan")
    headers_faculty = {"Authorization": f"Bearer {token_alan}"}

    # 1. Faculty cannot access student personal portal
    stu_portal_resp = await async_client.get("/api/v1/student/attendance", headers=headers_faculty)
    assert stu_portal_resp.status_code == 403
    assert stu_portal_resp.json()["error"] == "INSUFFICIENT_ROLE"

    # 2. Faculty cannot access Admin academic catalog creation endpoints
    forbidden_admin_endpoints = [
        ("/api/v1/admin/departments", {"code": "FAC-DEPT", "name": "Faculty Created Dept"}),
        ("/api/v1/admin/terms", {
            "code": "2027-SPRING",
            "name": "Spring 2027",
            "academic_year": "2026-2027",
            "start_date": "2027-01-10",
            "end_date": "2027-05-15",
            "status": "UPCOMING",
        }),
        ("/api/v1/admin/subjects", {
            "code": "CS999",
            "name": "Rogue Subject",
            "department_id": str(uuid.uuid4()),
            "credits": 3,
            "is_active": True,
        }),
        ("/api/v1/admin/sections", {
            "section_code": "CSE-ROGUE",
            "department_id": str(uuid.uuid4()),
            "academic_term_id": str(ctx["ta_3a"].academic_term_id),
            "cohort_year": 2025,
        }),
        ("/api/v1/admin/assignments", {
            "faculty_user_id": str(ctx["prof_alan"].id),
            "class_section_id": str(ctx["section_3a"].id),
            "subject_id": str(ctx["ta_3a"].subject_id),
            "academic_term_id": str(ctx["ta_3a"].academic_term_id),
            "is_active": True,
        }),
        ("/api/v1/admin/enrollments", {
            "student_user_id": str(ctx["s1"].id),
            "class_section_id": str(ctx["section_3a"].id),
            "academic_term_id": str(ctx["ta_3a"].academic_term_id),
            "effective_start_date": "2026-09-01",
            "enrollment_status": "ACTIVE",
        }),
        ("/api/v1/admin/enrollments/transfer", {
            "student_user_id": str(ctx["s1"].id),
            "new_class_section_id": str(ctx["section_3b"].id),
            "transfer_date": "2026-10-01",
        }),
    ]

    for path, payload in forbidden_admin_endpoints:
        resp = await async_client.post(path, headers=headers_faculty, json=payload)
        assert resp.status_code == 403, f"Expected 403 for faculty accessing {path}, got {resp.status_code}"
        assert resp.json()["error"] == "INSUFFICIENT_ROLE"


@pytest.mark.asyncio
async def test_admin_role_capabilities_and_boundaries(
    async_client: AsyncClient,
    security_context: dict,
):
    """Verify that Administrator can perform catalog and override tasks, but cannot impersonate student portal."""
    token_admin, _ = await login_user(async_client, "admin_meera")
    headers_admin = {"Authorization": f"Bearer {token_admin}"}

    # Admin CAN create a department
    dept_resp = await async_client.post(
        "/api/v1/admin/departments",
        headers=headers_admin,
        json={"code": "SEC-AUDIT", "name": "Security Audit Department"},
    )
    assert dept_resp.status_code == 201

    # Admin CANNOT access student personal attendance portal (strict STUDENT role enforcement)
    stu_resp = await async_client.get("/api/v1/student/attendance", headers=headers_admin)
    assert stu_resp.status_code == 403
    assert stu_resp.json()["error"] == "INSUFFICIENT_ROLE"


@pytest.mark.asyncio
async def test_suspended_account_token_lockout(
    async_client: AsyncClient,
    security_context: dict,
    db_session: AsyncSession,
):
    """Verify that a suspended user's token is immediately rejected on subsequent requests."""
    ctx = security_context

    # Obtain token while account is active
    token_ada, _ = await login_user(async_client, "prof_ada")
    headers_ada = {"Authorization": f"Bearer {token_ada}"}

    # Verify active access works
    me_resp = await async_client.get("/api/v1/auth/me", headers=headers_ada)
    assert me_resp.status_code == 200

    # Suspend Ada's account in database
    ada_user = ctx["prof_ada"]
    ada_user.account_status = AccountStatus.SUSPENDED
    await db_session.flush()

    # Subsequent request using existing valid JWT must be rejected with 401
    locked_resp = await async_client.get("/api/v1/auth/me", headers=headers_ada)
    assert locked_resp.status_code == 401
    assert "suspended" in locked_resp.json()["message"].lower()

    # Attempting to log in as suspended user must also fail with 401
    relogin_resp = await async_client.post(
        "/api/v1/auth/login",
        json={"username": "prof_ada", "password": "password"},
    )
    assert relogin_resp.status_code == 401
    assert "suspended" in relogin_resp.json()["message"].lower()


# ==============================================================================
# 2. Student Roster & Academic-Scope Lockout
# ==============================================================================

@pytest.mark.asyncio
async def test_faculty_unassigned_cross_assignment_lockout(
    async_client: AsyncClient,
    security_context: dict,
):
    """Verify faculty cannot access another faculty's roster or conduct their sessions."""
    ctx = security_context
    token_ada, _ = await login_user(async_client, "prof_ada")
    headers_ada = {"Authorization": f"Bearer {token_ada}"}

    # Ada tries to query Alan's CSE-3A roster -> 403 OUT_OF_SCOPE
    roster_resp = await async_client.get(
        f"/api/v1/faculty/assignments/{ctx['ta_3a'].id}/roster?session_date=2026-09-10",
        headers=headers_ada,
    )
    assert roster_resp.status_code == 403
    assert roster_resp.json()["error"] == "OUT_OF_SCOPE"

    # Unassigned Grace tries to query Alan's CSE-3A roster -> 403 OUT_OF_SCOPE
    token_grace, _ = await login_user(async_client, "prof_grace")
    grace_resp = await async_client.get(
        f"/api/v1/faculty/assignments/{ctx['ta_3a'].id}/roster?session_date=2026-09-10",
        headers={"Authorization": f"Bearer {token_grace}"},
    )
    assert grace_resp.status_code == 403
    assert grace_resp.json()["error"] == "OUT_OF_SCOPE"


@pytest.mark.asyncio
async def test_student_biometric_gallery_and_roster_lockout(
    async_client: AsyncClient,
    security_context: dict,
):
    """Verify student is strictly barred from class biometric gallery/roster endpoints (SC-008)."""
    ctx = security_context
    token_s1, _ = await login_user(async_client, "S1")
    headers_s1 = {"Authorization": f"Bearer {token_s1}"}

    # Student attempting to query faculty roster (which carries face registration states & identities)
    roster_attempt = await async_client.get(
        f"/api/v1/faculty/assignments/{ctx['ta_3a'].id}/roster?session_date=2026-09-10",
        headers=headers_s1,
    )
    assert roster_attempt.status_code == 403
    assert roster_attempt.json()["error"] == "INSUFFICIENT_ROLE"

    # Student attempting to inject another student's ID into personal attendance endpoint
    # Parameter is ignored; endpoint is strictly bounded by token subject
    tamper_resp = await async_client.get(
        f"/api/v1/student/attendance?student_user_id={ctx['s2'].id}",
        headers=headers_s1,
    )
    assert tamper_resp.status_code == 200
    assert tamper_resp.json()["student_id"] == str(ctx["s1"].id)
    assert tamper_resp.json()["student_id"] != str(ctx["s2"].id)


@pytest.mark.asyncio
async def test_expired_and_revoked_delegation_scope_lockout(
    async_client: AsyncClient,
    security_context: dict,
):
    """Verify that expired or revoked delegations provide zero access to class rosters or session conduct."""
    ctx = scenarios = security_context
    token_alan, _ = await login_user(async_client, "prof_alan")
    token_grace, _ = await login_user(async_client, "prof_grace")
    headers_alan = {"Authorization": f"Bearer {token_alan}"}
    headers_grace = {"Authorization": f"Bearer {token_grace}"}

    # 1. Alan creates delegation to Grace valid ONLY for 2026-10-05
    delg_resp = await async_client.post(
        f"/api/v1/faculty/assignments/{ctx['ta_3a'].id}/delegations",
        headers=headers_alan,
        json={
            "substitute_faculty_user_id": str(ctx["prof_grace"].id),
            "start_date": "2026-10-05",
            "end_date": "2026-10-05",
            "delegation_reason": "Single day research seminar",
        },
    )
    assert delg_resp.status_code == 201

    # Grace before start date (2026-10-04) -> 403 OUT_OF_SCOPE
    early_roster = await async_client.get(
        f"/api/v1/faculty/assignments/{ctx['ta_3a'].id}/roster?session_date=2026-10-04",
        headers=headers_grace,
    )
    assert early_roster.status_code == 403
    assert early_roster.json()["error"] == "OUT_OF_SCOPE"

    # Grace after end date (2026-10-06) -> 403 OUT_OF_SCOPE
    expired_roster = await async_client.get(
        f"/api/v1/faculty/assignments/{ctx['ta_3a'].id}/roster?session_date=2026-10-06",
        headers=headers_grace,
    )
    assert expired_roster.status_code == 403
    assert expired_roster.json()["error"] == "OUT_OF_SCOPE"

    # 2. Alan creates a multi-day delegation for 2026-10-15 to 2026-10-20, then revokes it early
    delg2_resp = await async_client.post(
        f"/api/v1/faculty/assignments/{ctx['ta_3a'].id}/delegations",
        headers=headers_alan,
        json={
            "substitute_faculty_user_id": str(ctx["prof_grace"].id),
            "start_date": "2026-10-15",
            "end_date": "2026-10-20",
            "delegation_reason": "Medical leave delegation",
        },
    )
    assert delg2_resp.status_code == 201
    delg2_id = delg2_resp.json()["id"]

    # Grace can access before revocation (2026-10-16)
    valid_roster = await async_client.get(
        f"/api/v1/faculty/assignments/{ctx['ta_3a'].id}/roster?session_date=2026-10-16",
        headers=headers_grace,
    )
    assert valid_roster.status_code == 200

    # Alan revokes delegation
    revoke_resp = await async_client.post(
        f"/api/v1/faculty/delegations/{delg2_id}/revoke",
        headers=headers_alan,
        json={"revocation_reason": "Early recovery from medical leave"},
    )
    assert revoke_resp.status_code == 200

    # Grace attempts access on 2026-10-16 after revocation -> 403 OUT_OF_SCOPE
    revoked_roster = await async_client.get(
        f"/api/v1/faculty/assignments/{ctx['ta_3a'].id}/roster?session_date=2026-10-16",
        headers=headers_grace,
    )
    assert revoked_roster.status_code == 403
    assert revoked_roster.json()["error"] == "OUT_OF_SCOPE"


# ==============================================================================
# 3. Substitute Delegation & Non-Subdelegation
# ==============================================================================

@pytest.mark.asyncio
async def test_substitute_subdelegation_strictly_forbidden(
    async_client: AsyncClient,
    security_context: dict,
):
    """Verify that substitute faculty cannot cascade or sub-delegate authority to another colleague."""
    ctx = security_context
    token_alan, _ = await login_user(async_client, "prof_alan")
    token_grace, _ = await login_user(async_client, "prof_grace")
    headers_alan = {"Authorization": f"Bearer {token_alan}"}
    headers_grace = {"Authorization": f"Bearer {token_grace}"}

    # Alan delegates 3A to Grace for 2026-10-05
    await async_client.post(
        f"/api/v1/faculty/assignments/{ctx['ta_3a'].id}/delegations",
        headers=headers_alan,
        json={
            "substitute_faculty_user_id": str(ctx["prof_grace"].id),
            "start_date": "2026-10-05",
            "end_date": "2026-10-05",
            "delegation_reason": "Conference attendance",
        },
    )

    # Substitute Grace attempts cascading delegation of 3A to Ada -> 403 OUT_OF_SCOPE
    sub_deleg_resp = await async_client.post(
        f"/api/v1/faculty/assignments/{ctx['ta_3a'].id}/delegations",
        headers=headers_grace,
        json={
            "substitute_faculty_user_id": str(ctx["prof_ada"].id),
            "start_date": "2026-10-05",
            "end_date": "2026-10-05",
            "delegation_reason": "Cascading delegation attempt",
        },
    )
    assert sub_deleg_resp.status_code == 403
    assert sub_deleg_resp.json()["error"] == "OUT_OF_SCOPE"
    assert "sub-delegation forbidden" in sub_deleg_resp.json()["message"].lower()


@pytest.mark.asyncio
async def test_substitute_amendment_lockout(
    async_client: AsyncClient,
    security_context: dict,
):
    """Verify that substitute faculty are strictly excluded from post-finalization amendments."""
    ctx = security_context
    token_alan, _ = await login_user(async_client, "prof_alan")
    token_grace, _ = await login_user(async_client, "prof_grace")
    headers_alan = {"Authorization": f"Bearer {token_alan}"}
    headers_grace = {"Authorization": f"Bearer {token_grace}"}

    recent_date = (date.today() - timedelta(days=2)).isoformat()

    # 1. Alan delegates to Grace for recent_date
    await async_client.post(
        f"/api/v1/faculty/assignments/{ctx['ta_3a'].id}/delegations",
        headers=headers_alan,
        json={
            "substitute_faculty_user_id": str(ctx["prof_grace"].id),
            "start_date": recent_date,
            "end_date": recent_date,
            "delegation_reason": "Department research symposium",
        },
    )

    # 2. Grace conducts session on recent_date
    sub_sess_resp = await async_client.post(
        "/api/v1/attendance/sessions",
        headers=headers_grace,
        json={
            "client_session_uuid": str(uuid.uuid4()),
            "teaching_assignment_id": str(ctx["ta_3a"].id),
            "session_date": recent_date,
            "period_slot_or_sequence": 1,
            "applicability_status": "COUNTED",
            "records": [
                {
                    "student_user_id": str(ctx["s1"].id),
                    "attendance_status": "ABSENT",
                    "mark_source": "MANUAL_MARK",
                },
                {
                    "student_user_id": str(ctx["s2"].id),
                    "attendance_status": "PRESENT",
                    "mark_source": "MANUAL_MARK",
                },
                {
                    "student_user_id": str(ctx["s3"].id),
                    "attendance_status": "PRESENT",
                    "mark_source": "MANUAL_MARK",
                },
            ],
        },
    )
    assert sub_sess_resp.status_code == 201
    session_id = sub_sess_resp.json()["results"][0]["server_session_id"]

    # 3. Grace attempts post-finalization amendment -> 403 OUT_OF_SCOPE
    amend_attempt = await async_client.post(
        f"/api/v1/attendance/sessions/{session_id}/amendments",
        headers=headers_grace,
        json={
            "student_user_id": str(ctx["s1"].id),
            "new_status": "PRESENT",
            "amendment_reason": "Substitute trying to amend finalized record",
        },
    )
    assert amend_attempt.status_code == 403
    assert amend_attempt.json()["error"] == "OUT_OF_SCOPE"
    assert "substitute faculty are excluded" in amend_attempt.json()["message"].lower()

    # 4. Regular faculty Alan can successfully amend
    alan_amend = await async_client.post(
        f"/api/v1/attendance/sessions/{session_id}/amendments",
        headers=headers_alan,
        json={
            "student_user_id": str(ctx["s1"].id),
            "new_status": "PRESENT",
            "amendment_reason": "Regular faculty approved medical note",
        },
    )
    assert alan_amend.status_code == 201
    assert alan_amend.json()["amendment_role"] == "REGULAR_FACULTY"


@pytest.mark.asyncio
async def test_substitute_revocation_lockout(
    async_client: AsyncClient,
    security_context: dict,
):
    """Verify that substitute faculty cannot revoke their own or others' delegations."""
    ctx = security_context
    token_alan, _ = await login_user(async_client, "prof_alan")
    token_grace, _ = await login_user(async_client, "prof_grace")
    headers_alan = {"Authorization": f"Bearer {token_alan}"}
    headers_grace = {"Authorization": f"Bearer {token_grace}"}

    delg_resp = await async_client.post(
        f"/api/v1/faculty/assignments/{ctx['ta_3a'].id}/delegations",
        headers=headers_alan,
        json={
            "substitute_faculty_user_id": str(ctx["prof_grace"].id),
            "start_date": "2026-10-05",
            "end_date": "2026-10-05",
            "delegation_reason": "Medical leave delegation",
        },
    )
    delg_id = delg_resp.json()["id"]

    # Grace attempts revocation -> 403 OUT_OF_SCOPE
    grace_revoke = await async_client.post(
        f"/api/v1/faculty/delegations/{delg_id}/revoke",
        headers=headers_grace,
        json={"revocation_reason": "Substitute trying to revoke"},
    )
    assert grace_revoke.status_code == 403
    assert grace_revoke.json()["error"] == "OUT_OF_SCOPE"


@pytest.mark.asyncio
async def test_self_delegation_blocked(
    async_client: AsyncClient,
    security_context: dict,
):
    """Verify that regular assigned faculty cannot delegate authority to themselves."""
    ctx = security_context
    token_alan, _ = await login_user(async_client, "prof_alan")
    headers_alan = {"Authorization": f"Bearer {token_alan}"}

    self_delg = await async_client.post(
        f"/api/v1/faculty/assignments/{ctx['ta_3a'].id}/delegations",
        headers=headers_alan,
        json={
            "substitute_faculty_user_id": str(ctx["prof_alan"].id),
            "start_date": "2026-10-05",
            "end_date": "2026-10-05",
            "delegation_reason": "Self delegation attempt",
        },
    )
    assert self_delg.status_code in (400, 409)
    assert "cannot equal regular assigned faculty" in self_delg.text


# ==============================================================================
# 4. SQL Injection and Malformed Identifiers
# ==============================================================================

@pytest.mark.asyncio
async def test_sql_injection_defense_in_login(
    async_client: AsyncClient,
    security_context: dict,
    db_session: AsyncSession,
):
    """Verify that SQL injection strings in login parameters are safely rejected without execution or 500 error."""
    sqli_payloads = [
        "' OR '1'='1",
        "' OR '1'='1' --",
        "admin'--",
        "' UNION SELECT id, email, password_hash, full_name, role, account_status, created_at, updated_at FROM users --",
        "'; DROP TABLE users CASCADE; --",
        "') OR ('a'='a",
        "admin' /*",
    ]

    for payload in sqli_payloads:
        resp = await async_client.post(
            "/api/v1/auth/login",
            json={"username": payload, "password": "arbitrary_password"},
        )
        assert resp.status_code == 401, f"SQL injection payload '{payload}' produced status {resp.status_code}: {resp.text}"
        assert resp.json()["error"] == "AUTHENTICATION_FAILED"

    # Verify that users table is still fully intact and populated
    user_count_res = await db_session.execute(select(User))
    users = user_count_res.scalars().all()
    assert len(users) >= 7


@pytest.mark.asyncio
async def test_sql_injection_defense_in_query_parameters(
    async_client: AsyncClient,
    security_context: dict,
):
    """Verify that SQL injection strings in query parameters return safe validation errors (HTTP 422), never HTTP 500."""
    ctx = security_context
    token_alan, _ = await login_user(async_client, "prof_alan")
    token_s1, _ = await login_user(async_client, "S1")
    headers_alan = {"Authorization": f"Bearer {token_alan}"}
    headers_s1 = {"Authorization": f"Bearer {token_s1}"}

    # 1. SQL injection in academic_term_id UUID query param
    sqli_term_resp = await async_client.get(
        "/api/v1/faculty/assignments?academic_term_id=' OR '1'='1",
        headers=headers_alan,
    )
    assert sqli_term_resp.status_code == 422
    assert "academic_term_id" in sqli_term_resp.text

    # 2. SQL injection in session_date Query param
    sqli_date_resp = await async_client.get(
        f"/api/v1/faculty/assignments/{ctx['ta_3a'].id}/roster?session_date=2026-09-10' OR '1'='1",
        headers=headers_alan,
    )
    assert sqli_date_resp.status_code == 422
    assert "session_date" in sqli_date_resp.text

    # 3. SQL injection in student attendance query param
    sqli_stu_resp = await async_client.get(
        "/api/v1/student/attendance?academic_term_id=1;DROP TABLE users;--",
        headers=headers_s1,
    )
    assert sqli_stu_resp.status_code == 422


@pytest.mark.asyncio
async def test_malformed_uuid_in_path_parameters(
    async_client: AsyncClient,
    security_context: dict,
):
    """Verify that malformed UUIDs and path traversal strings return safe HTTP 422/404 errors, never HTTP 500."""
    ctx = security_context
    token_alan, _ = await login_user(async_client, "prof_alan")
    headers_alan = {"Authorization": f"Bearer {token_alan}"}

    malformed_paths = [
        ("GET", "/api/v1/faculty/assignments/not-a-valid-uuid/roster?session_date=2026-09-10"),
        ("GET", "/api/v1/faculty/assignments/12345/roster?session_date=2026-09-10"),
        ("POST", "/api/v1/faculty/assignments/malformed-uuid/delegations"),
        ("POST", "/api/v1/faculty/delegations/random-text/revoke"),
        ("POST", "/api/v1/attendance/sessions/not-a-uuid-at-all/amendments"),
        ("GET", "/api/v1/attendance/sessions/not-a-uuid-at-all/amendments"),
    ]

    for method, path in malformed_paths:
        if method == "GET":
            resp = await async_client.get(path, headers=headers_alan)
        else:
            resp = await async_client.post(path, headers=headers_alan, json={})

        assert resp.status_code == 422, f"Expected 422 for malformed UUID in {method} {path}, got {resp.status_code}: {resp.text}"
        assert resp.status_code != 500

    # Directory traversal in path parameter -> 404 Not Found (standard routing isolation)
    traversal_resp = await async_client.post(
        "/api/v1/faculty/delegations/../../etc/passwd/revoke",
        headers=headers_alan,
        json={"revocation_reason": "Path traversal attempt"},
    )
    assert traversal_resp.status_code in (404, 422)
    assert traversal_resp.status_code != 500


@pytest.mark.asyncio
async def test_nonexistent_identifiers_handling(
    async_client: AsyncClient,
    security_context: dict,
):
    """Verify that syntactically valid but nonexistent UUIDs return safe 403 or 404 responses, never HTTP 500."""
    token_alan, _ = await login_user(async_client, "prof_alan")
    headers_alan = {"Authorization": f"Bearer {token_alan}"}
    nonexistent_uuid = uuid.uuid4()

    # Query roster for nonexistent assignment -> 404 NOT_FOUND
    roster_resp = await async_client.get(
        f"/api/v1/faculty/assignments/{nonexistent_uuid}/roster?session_date=2026-09-10",
        headers=headers_alan,
    )
    assert roster_resp.status_code == 404
    assert roster_resp.json()["error"] == "NOT_FOUND"

    # Revoke nonexistent delegation -> 404 NOT_FOUND
    revoke_resp = await async_client.post(
        f"/api/v1/faculty/delegations/{nonexistent_uuid}/revoke",
        headers=headers_alan,
        json={"revocation_reason": "Nonexistent delegation test"},
    )
    assert revoke_resp.status_code == 404
    assert revoke_resp.json()["error"] == "NOT_FOUND"

    # Amend nonexistent session -> 404 NOT_FOUND
    amend_resp = await async_client.post(
        f"/api/v1/attendance/sessions/{nonexistent_uuid}/amendments",
        headers=headers_alan,
        json={
            "student_user_id": str(uuid.uuid4()),
            "new_status": "PRESENT",
            "amendment_reason": "Nonexistent session test reason",
        },
    )
    assert amend_resp.status_code == 404
    assert amend_resp.json()["error"] == "NOT_FOUND"


@pytest.mark.asyncio
async def test_malformed_request_bodies_and_validation(
    async_client: AsyncClient,
    security_context: dict,
):
    """Verify that malformed request bodies are rejected cleanly with validation errors, never 500."""
    ctx = security_context
    token_alan, _ = await login_user(async_client, "prof_alan")
    headers_alan = {"Authorization": f"Bearer {token_alan}"}

    # 1. Delegation with end_date earlier than start_date
    inverted_dates_resp = await async_client.post(
        f"/api/v1/faculty/assignments/{ctx['ta_3a'].id}/delegations",
        headers=headers_alan,
        json={
            "substitute_faculty_user_id": str(ctx["prof_grace"].id),
            "start_date": "2026-10-10",
            "end_date": "2026-10-05",  # Inverted!
            "delegation_reason": "Inverted dates validation test",
        },
    )
    assert inverted_dates_resp.status_code == 422
    assert "end_date must be on or after start_date" in inverted_dates_resp.text

    # 2. Delegation with reason too short (< 5 chars)
    short_reason_resp = await async_client.post(
        f"/api/v1/faculty/assignments/{ctx['ta_3a'].id}/delegations",
        headers=headers_alan,
        json={
            "substitute_faculty_user_id": str(ctx["prof_grace"].id),
            "start_date": "2026-10-05",
            "end_date": "2026-10-05",
            "delegation_reason": "tiny",
        },
    )
    assert short_reason_resp.status_code == 422

    # 3. Attendance session submission with invalid applicability status enum
    invalid_enum_resp = await async_client.post(
        "/api/v1/attendance/sessions",
        headers=headers_alan,
        json={
            "client_session_uuid": str(uuid.uuid4()),
            "teaching_assignment_id": str(ctx["ta_3a"].id),
            "session_date": "2026-09-10",
            "period_slot_or_sequence": 1,
            "applicability_status": "SUPER_COUNTED",  # Invalid enum
            "records": [],
        },
    )
    assert invalid_enum_resp.status_code == 422


@pytest.mark.asyncio
async def test_analytics_role_boundary_enforcement(
    async_client: AsyncClient,
    security_context: dict,
):
    """
    Verify strict role boundaries on analytics endpoints:
    - Students are locked out of institutional overview (403 INSUFFICIENT_ROLE).
    - Students are locked out of section analytics (403 INSUFFICIENT_ROLE).
    - Faculty are locked out of out-of-scope sections (403 OUT_OF_SCOPE).
    - Faculty are locked out of institutional threshold overrides (403 INSUFFICIENT_ROLE).
    """
    ctx = security_context
    token_stu, _ = await login_user(async_client, "S1")
    token_alan, _ = await login_user(async_client, "prof_alan")
    token_grace, _ = await login_user(async_client, "prof_grace")
    token_admin, _ = await login_user(async_client, "admin_meera")

    headers_stu = {"Authorization": f"Bearer {token_stu}"}
    headers_alan = {"Authorization": f"Bearer {token_alan}"}
    headers_grace = {"Authorization": f"Bearer {token_grace}"}
    headers_admin = {"Authorization": f"Bearer {token_admin}"}

    # 1. Student locked out of GET /api/v1/analytics/overview
    res_stu_ov = await async_client.get("/api/v1/analytics/overview", headers=headers_stu)
    assert res_stu_ov.status_code == 403
    assert res_stu_ov.json()["error"] == "INSUFFICIENT_ROLE"

    # 2. Student locked out of GET /api/v1/analytics/assignments/{id}
    res_stu_sec = await async_client.get(
        f"/api/v1/analytics/assignments/{ctx['ta_3a'].id}",
        headers=headers_stu,
    )
    assert res_stu_sec.status_code == 403
    assert res_stu_sec.json()["error"] == "INSUFFICIENT_ROLE"

    # 3. Prof Grace (not assigned to ta_3a and not substitute) -> 403 OUT_OF_SCOPE
    res_grace_sec = await async_client.get(
        f"/api/v1/analytics/assignments/{ctx['ta_3a'].id}",
        headers=headers_grace,
    )
    assert res_grace_sec.status_code == 403
    assert res_grace_sec.json()["error"] == "OUT_OF_SCOPE"

    # 4. Prof Alan (assigned to ta_3a) -> 200 OK
    res_alan_sec = await async_client.get(
        f"/api/v1/analytics/assignments/{ctx['ta_3a'].id}",
        headers=headers_alan,
    )
    assert res_alan_sec.status_code == 200

    # 5. Prof Alan cannot change institutional threshold -> 403 INSUFFICIENT_ROLE
    res_alan_tamper = await async_client.get(
        f"/api/v1/analytics/assignments/{ctx['ta_3a'].id}?threshold=50.0",
        headers=headers_alan,
    )
    assert res_alan_tamper.status_code == 403
    assert res_alan_tamper.json()["error"] == "INSUFFICIENT_ROLE"

    # 6. Admin can change threshold -> 200 OK
    res_admin_sec = await async_client.get(
        f"/api/v1/analytics/assignments/{ctx['ta_3a'].id}?threshold=50.0",
        headers=headers_admin,
    )
    assert res_admin_sec.status_code == 200
    assert res_admin_sec.json()["threshold"] == 50.0

    # 7. Student locked out of CSV export endpoints -> 403 INSUFFICIENT_ROLE
    res_stu_exp = await async_client.get(
        f"/api/v1/analytics/assignments/{ctx['ta_3a'].id}/export",
        headers=headers_stu,
    )
    assert res_stu_exp.status_code == 403
    assert res_stu_exp.json()["error"] == "INSUFFICIENT_ROLE"

    res_stu_ov_exp = await async_client.get(
        "/api/v1/analytics/overview/export",
        headers=headers_stu,
    )
    assert res_stu_ov_exp.status_code == 403
    assert res_stu_ov_exp.json()["error"] == "INSUFFICIENT_ROLE"

    # 8. Unassigned faculty locked out of section export -> 403 OUT_OF_SCOPE
    res_grace_exp = await async_client.get(
        f"/api/v1/analytics/assignments/{ctx['ta_3a'].id}/export",
        headers=headers_grace,
    )
    assert res_grace_exp.status_code == 403
    assert res_grace_exp.json()["error"] == "OUT_OF_SCOPE"

    # 9. Assigned faculty and Admin allowed to export -> 200 OK
    res_alan_exp = await async_client.get(
        f"/api/v1/analytics/assignments/{ctx['ta_3a'].id}/export",
        headers=headers_alan,
    )
    assert res_alan_exp.status_code == 200
    assert "text/csv" in res_alan_exp.headers["content-type"]
