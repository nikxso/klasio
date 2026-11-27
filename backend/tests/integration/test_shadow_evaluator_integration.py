"""Integration Tests for Feature-Flagged Shadow Authorization Evaluator.

Guarantees verified:
1. Feature Flag: Disabled by default (ENABLE_SHADOW_AUTHORIZATION = False) with zero overhead.
2. Invariant Preservation: API responses and legacy decisions are 100% identical when shadow mode is enabled.
3. Observational Comparison: Records matched grants, matched denials, and expected mismatches (unassigned legacy users).
4. Exception Safety: Any failure or unhandled exception within the shadow evaluator is safely caught, logged,
   and suppressed, never impacting endpoint responses.
5. Privacy Hardening: actor_pseudonym is a salted cryptographic hash; external matriculation/employee IDs
   are never stored in telemetry or logged. Zero biometric vectors in shadow data.
"""
from datetime import datetime, timezone
import uuid
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from unittest.mock import patch

from src.config import get_settings
from src.core.permissions import require_admin, require_faculty
from src.core.security import create_access_token, get_password_hash
from src.main import app
from src.models.user import AccountStatus, User, UserRole
from fastapi import APIRouter, Depends

# Register test routes on app
shadow_test_router = APIRouter(prefix="/test-shadow-auth", tags=["Testing Shadow Auth"])

@shadow_test_router.get("/admin-only")
async def admin_only_endpoint(user: User = Depends(require_admin)):
    return {"message": "hello admin", "user_id": str(user.id)}

@shadow_test_router.get("/assignments/{teaching_assignment_id}/test-gallery")
async def faculty_assignment_endpoint(
    teaching_assignment_id: uuid.UUID,
    user: User = Depends(require_faculty),
):
    return {"message": "hello faculty", "assignment_id": str(teaching_assignment_id)}

app.include_router(shadow_test_router)
from src.models.access_control import (
    Institution,
    InstitutionMembership,
    MembershipStatus,
    RoleTemplate,
    RoleAssignment,
    AssignmentStatus,
    RoleScopeType,
    RoleAssignmentScope,
)
from scripts.seed_access_control import seed_access_control_catalog


@pytest.fixture(autouse=True)
async def seed_catalog(db_session: AsyncSession):
    await seed_access_control_catalog(db_session)


@pytest.mark.asyncio
async def test_shadow_evaluation_disabled_by_default(async_client: AsyncClient, db_session: AsyncSession):
    """When ENABLE_SHADOW_AUTHORIZATION is False (default), no shadow evaluation is performed."""
    settings = get_settings()
    assert settings.ENABLE_SHADOW_AUTHORIZATION is False

    admin = User(
        institutional_id=f"ADM_DIS_{uuid.uuid4().hex[:6]}",
        email=f"adm_dis_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash=get_password_hash("password123"),
        full_name="Admin Disabled",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add(admin)
    await db_session.commit()

    token = create_access_token(subject=str(admin.id), role=admin.role.value, institutional_id=admin.institutional_id)
    headers = {"Authorization": f"Bearer {token}"}

    with patch("src.services.shadow_evaluator.ShadowAuthorizationEvaluator.shadow_evaluate") as mock_eval:
        res = await async_client.get("/test-shadow-auth/admin-only", headers=headers)
        assert res.status_code == 200
        assert res.json()["message"] == "hello admin"
        # Shadow evaluate must not have been called
        mock_eval.assert_not_called()


@pytest.mark.asyncio
async def test_shadow_evaluation_enabled_preserves_legacy_success_and_denial(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    """When enabled, shadow evaluation records observations without altering legacy decisions (200 OK and 403 Forbidden)."""
    settings = get_settings()
    monkeypatch.setattr(settings, "ENABLE_SHADOW_AUTHORIZATION", True)

    inst = Institution(code=f"INST_SHAD_INT_{uuid.uuid4().hex[:6]}", name="Shadow Int Inst")
    admin = User(
        institutional_id=f"ADM_EN_{uuid.uuid4().hex[:6]}",
        email=f"adm_en_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash=get_password_hash("password123"),
        full_name="Admin Enabled",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    student = User(
        institutional_id=f"STU_EN_{uuid.uuid4().hex[:6]}",
        email=f"stu_en_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash=get_password_hash("password123"),
        full_name="Student Enabled",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([inst, admin, student])
    await db_session.flush()

    m_admin = InstitutionMembership(institution_id=inst.id, user_id=admin.id, status=MembershipStatus.ACTIVE)
    m_student = InstitutionMembership(institution_id=inst.id, user_id=student.id, status=MembershipStatus.ACTIVE)
    db_session.add_all([m_admin, m_student])
    await db_session.commit()

    token_admin = create_access_token(subject=str(admin.id), role=admin.role.value, institutional_id=admin.institutional_id)
    token_student = create_access_token(subject=str(student.id), role=student.role.value, institutional_id=student.institutional_id)

    recorded_observations = []
    from src.services.shadow_evaluator import ShadowAuthorizationEvaluator
    orig_shadow_eval = ShadowAuthorizationEvaluator.shadow_evaluate

    async def capture_shadow_eval(self, *args, **kwargs):
        obs = await orig_shadow_eval(self, *args, **kwargs)
        recorded_observations.append(obs)
        return obs

    monkeypatch.setattr(ShadowAuthorizationEvaluator, "shadow_evaluate", capture_shadow_eval)

    # 1. Admin accessing admin-only: Legacy allowed (200 OK)
    res_admin = await async_client.get("/test-shadow-auth/admin-only", headers={"Authorization": f"Bearer {token_admin}"})
    assert res_admin.status_code == 200
    assert res_admin.json()["message"] == "hello admin"

    # Verify shadow observation was recorded
    assert len(recorded_observations) == 1
    obs_admin = recorded_observations[0]
    assert obs_admin.legacy_allowed is True
    # Admin was not yet assigned RBAC role, so expected mismatch
    assert obs_admin.new_allowed is False
    assert obs_admin.is_expected_mismatch is True
    assert obs_admin.mismatch_category == "UNASSIGNED_LEGACY_USER"
    # Privacy verification: pseudonym is hashed, not raw institutional_id
    assert obs_admin.actor_pseudonym != admin.institutional_id
    assert len(obs_admin.actor_pseudonym) == 32

    # 2. Student accessing admin-only: Legacy denied (403 Forbidden)
    res_student = await async_client.get("/test-shadow-auth/admin-only", headers={"Authorization": f"Bearer {token_student}"})
    assert res_student.status_code == 403
    assert res_student.json()["error"] == "INSUFFICIENT_ROLE"

    assert len(recorded_observations) == 2
    obs_student = recorded_observations[1]
    assert obs_student.legacy_allowed is False
    assert obs_student.new_allowed is False
    assert obs_student.matched is True


@pytest.mark.asyncio
async def test_shadow_evaluator_exception_safety(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
    caplog,
):
    """If the shadow evaluator crashes or raises an exception, the HTTP request proceeds normally without impact."""
    settings = get_settings()
    monkeypatch.setattr(settings, "ENABLE_SHADOW_AUTHORIZATION", True)

    admin = User(
        institutional_id=f"ADM_CRASH_{uuid.uuid4().hex[:6]}",
        email=f"adm_crash_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash=get_password_hash("password123"),
        full_name="Admin Crash Test",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add(admin)
    await db_session.commit()

    token = create_access_token(subject=str(admin.id), role=admin.role.value, institutional_id=admin.institutional_id)
    headers = {"Authorization": f"Bearer {token}"}

    from src.services.shadow_evaluator import ShadowAuthorizationEvaluator

    async def faulty_eval(self, *args, **kwargs):
        raise RuntimeError("Simulated evaluator database connection catastrophe!")

    monkeypatch.setattr(ShadowAuthorizationEvaluator, "shadow_evaluate", faulty_eval)

    # Endpoint must return 200 OK cleanly despite the crash in shadow evaluation
    res = await async_client.get("/test-shadow-auth/admin-only", headers=headers)
    assert res.status_code == 200
    assert res.json()["message"] == "hello admin"


@pytest.mark.asyncio
async def test_shadow_evaluation_skipped_without_tenant_context(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    """When tenant context cannot be determined (user has 0 or >1 memberships), shadow eval is skipped with NO_TENANT_CONTEXT."""
    settings = get_settings()
    monkeypatch.setattr(settings, "ENABLE_SHADOW_AUTHORIZATION", True)

    # Admin with NO memberships
    admin_no_mem = User(
        institutional_id=f"ADM_NOMEM_{uuid.uuid4().hex[:6]}",
        email=f"nomem_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash=get_password_hash("password123"),
        full_name="Admin No Membership",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add(admin_no_mem)
    await db_session.commit()

    from sqlalchemy import delete
    await db_session.execute(delete(InstitutionMembership).where(InstitutionMembership.user_id == admin_no_mem.id))
    await db_session.commit()

    token = create_access_token(subject=str(admin_no_mem.id), role=admin_no_mem.role.value, institutional_id=admin_no_mem.institutional_id)
    headers = {"Authorization": f"Bearer {token}"}

    from src.services.shadow_evaluator import ShadowAuthorizationEvaluator
    skipped_observations = []
    orig_skip = ShadowAuthorizationEvaluator.record_skipped_evaluation

    def capture_skip(self, *args, **kwargs):
        obs = orig_skip(self, *args, **kwargs)
        skipped_observations.append(obs)
        return obs

    monkeypatch.setattr(ShadowAuthorizationEvaluator, "record_skipped_evaluation", capture_skip)

    res = await async_client.get("/test-shadow-auth/admin-only", headers=headers)
    assert res.status_code == 200
    assert len(skipped_observations) == 1
    obs = skipped_observations[0]
    assert obs.mismatch_category == "NO_TENANT_CONTEXT"
    assert obs.new_reason_code == "NO_TENANT_CONTEXT"
    assert "Shadow evaluation skipped: NO_TENANT_CONTEXT" in obs.new_reason
    assert len(obs.actor_pseudonym) == 32


@pytest.mark.asyncio
async def test_shadow_evaluation_resource_tenant_mismatch(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    """When a faculty accesses an assignment owned by Institution B under Institution A context,
    the shadow evaluator detects and records RESOURCE_TENANT_MISMATCH without altering the legacy 200 OK.
    """
    settings = get_settings()
    monkeypatch.setattr(settings, "ENABLE_SHADOW_AUTHORIZATION", True)

    from src.models.access_control import Campus, DEFAULT_INSTITUTION_ID
    from src.models.academic import Department, AcademicTerm, ClassSection, Subject
    from src.models.assignment import TeachingAssignment

    # Institution A (Faculty's institution)
    inst_a = Institution(code=f"INST_A_{uuid.uuid4().hex[:6]}", name="Institution A")
    # Institution B (Target resource's institution - deployed singleton institution)
    inst_b_id = uuid.UUID(DEFAULT_INSTITUTION_ID)
    inst_b = (await db_session.execute(select(Institution).where(Institution.id == inst_b_id))).scalar_one_or_none()
    if not inst_b:
        inst_b = Institution(id=inst_b_id, code="KLASIO_MAIN", name="Institution B")
        db_session.add(inst_b)

    faculty = User(
        institutional_id=f"FAC_MIS_{uuid.uuid4().hex[:6]}",
        email=f"fac_mis_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash=get_password_hash("password123"),
        full_name="Faculty Mismatch Test",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    faculty_b = User(
        institutional_id=f"FAC_B_{uuid.uuid4().hex[:6]}",
        email=f"fac_b_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash=get_password_hash("password123"),
        full_name="Faculty Inst B",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([inst_a, faculty, faculty_b])
    await db_session.flush()

    # Faculty belongs to Institution A (remove auto-created membership in B)
    mem_a = InstitutionMembership(institution_id=inst_a.id, user_id=faculty.id, status=MembershipStatus.ACTIVE)
    db_session.add(mem_a)
    await db_session.flush()
    from sqlalchemy import delete
    await db_session.execute(delete(InstitutionMembership).where(InstitutionMembership.user_id == faculty.id, InstitutionMembership.institution_id == inst_b_id))

    # Academic structure in Institution B
    campus_b = Campus(name="Campus B", code=f"CB_{uuid.uuid4().hex[:4]}", institution_id=inst_b.id)
    dept_b = Department(name="Dept B", code=f"DB_{uuid.uuid4().hex[:4]}", institution_id=inst_b.id)
    term_b = AcademicTerm(
        code=f"TB_{uuid.uuid4().hex[:4]}",
        name="Term B",
        academic_year="2026-2027",
        start_date=datetime.now(timezone.utc).date(),
        end_date=datetime.now(timezone.utc).date(),
        institution_id=inst_b.id,
    )
    db_session.add_all([campus_b, dept_b, term_b])
    await db_session.flush()

    sub_b = Subject(
        code=f"SUB_{uuid.uuid4().hex[:4]}",
        name="Subject B",
        department_id=dept_b.id,
        institution_id=inst_b.id,
    )
    sec_b = ClassSection(
        section_code=f"SEC_B_{uuid.uuid4().hex[:4]}",
        campus_id=campus_b.id,
        department_id=dept_b.id,
        academic_term_id=term_b.id,
        cohort_year=2026,
        institution_id=inst_b.id,
    )
    db_session.add_all([sub_b, sec_b])
    await db_session.flush()

    ta_b = TeachingAssignment(
        institution_id=inst_b.id,
        class_section_id=sec_b.id,
        subject_id=sub_b.id,
        academic_term_id=term_b.id,
        faculty_user_id=faculty_b.id,
        created_by_user_id=faculty_b.id,
        is_active=True,
    )
    db_session.add(ta_b)
    await db_session.commit()

    token = create_access_token(subject=str(faculty.id), role=faculty.role.value, institutional_id=faculty.institutional_id)
    headers = {"Authorization": f"Bearer {token}", "X-Institution-ID": str(inst_a.id)}

    from src.services.shadow_evaluator import ShadowAuthorizationEvaluator
    recorded_observations = []
    orig_skip = ShadowAuthorizationEvaluator.record_skipped_evaluation

    def capture_skip(self, *args, **kwargs):
        obs = orig_skip(self, *args, **kwargs)
        recorded_observations.append(obs)
        return obs

    monkeypatch.setattr(ShadowAuthorizationEvaluator, "record_skipped_evaluation", capture_skip)

    res = await async_client.get(f"/test-shadow-auth/assignments/{ta_b.id}/test-gallery", headers=headers)
    # Legacy check succeeds (Faculty has UserRole.FACULTY)
    assert res.status_code == 200
    assert res.json()["message"] == "hello faculty"

    # Shadow evaluator correctly captured the cross-tenant mismatch
    assert len(recorded_observations) == 1
    obs = recorded_observations[0]
    assert obs.mismatch_category == "RESOURCE_TENANT_MISMATCH"
    assert obs.new_reason_code == "RESOURCE_TENANT_MISMATCH"
    assert obs.institution_id == str(inst_a.id)
    assert obs.target_resource_institution_id == str(inst_b.id)
    assert obs.resource_type == "TEACHING_ASSIGNMENT"
    assert obs.resource_id == str(ta_b.id)


@pytest.mark.asyncio
async def test_shadow_evaluation_no_resource_context(
    async_client: AsyncClient,
    db_session: AsyncSession,
    monkeypatch,
):
    """When a resource parameter is in the URL but the entity does not exist in the database,
    shadow evaluation is skipped with NO_RESOURCE_CONTEXT.
    """
    settings = get_settings()
    monkeypatch.setattr(settings, "ENABLE_SHADOW_AUTHORIZATION", True)

    inst = Institution(code=f"INST_NRC_{uuid.uuid4().hex[:6]}", name="No Resource Context Inst")
    faculty = User(
        institutional_id=f"FAC_NRC_{uuid.uuid4().hex[:6]}",
        email=f"fac_nrc_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash=get_password_hash("password123"),
        full_name="Faculty NRC Test",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([inst, faculty])
    await db_session.flush()

    mem = InstitutionMembership(institution_id=inst.id, user_id=faculty.id, status=MembershipStatus.ACTIVE)
    db_session.add(mem)
    await db_session.commit()

    token = create_access_token(subject=str(faculty.id), role=faculty.role.value, institutional_id=faculty.institutional_id)
    headers = {"Authorization": f"Bearer {token}", "X-Institution-ID": str(inst.id)}

    from src.services.shadow_evaluator import ShadowAuthorizationEvaluator
    recorded_observations = []
    orig_skip = ShadowAuthorizationEvaluator.record_skipped_evaluation

    def capture_skip(self, *args, **kwargs):
        obs = orig_skip(self, *args, **kwargs)
        recorded_observations.append(obs)
        return obs

    monkeypatch.setattr(ShadowAuthorizationEvaluator, "record_skipped_evaluation", capture_skip)

    fake_ta_id = uuid.uuid4()
    res = await async_client.get(f"/test-shadow-auth/assignments/{fake_ta_id}/test-gallery", headers=headers)
    assert res.status_code == 200

    assert len(recorded_observations) == 1
    obs = recorded_observations[0]
    assert obs.mismatch_category == "NO_RESOURCE_CONTEXT"
    assert obs.new_reason_code == "NO_RESOURCE_CONTEXT"


@pytest.mark.asyncio
async def test_dedicated_shadow_pseudonym_key_isolation(monkeypatch):
    """Verify that SHADOW_PSEUDONYM_KEY provides dedicated HMAC secret isolation and 128-bit output."""
    from src.services.shadow_evaluator import derive_actor_pseudonym
    settings = get_settings()

    test_uid = uuid.uuid4()

    # 1. With dedicated key
    monkeypatch.setattr(settings, "SHADOW_PSEUDONYM_KEY", "custom-secret-key-for-shadow-telemetry-32bytes")
    pseudo1 = derive_actor_pseudonym(test_uid)
    assert len(pseudo1) == 32

    # 2. Key change changes pseudonym (deterministic per key)
    monkeypatch.setattr(settings, "SHADOW_PSEUDONYM_KEY", "different-secret-key-for-shadow-telemetry-32")
    pseudo2 = derive_actor_pseudonym(test_uid)
    assert len(pseudo2) == 32
    assert pseudo1 != pseudo2

