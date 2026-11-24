"""Rigorous Integration Tests for Biometric Gallery Endpoint Security.

Verifies:
1. Legacy ADMIN cannot retrieve gallery for an unrelated assignment (universal bypass eliminated).
2. Legacy ADMIN cannot retrieve gallery for another institution.
3. Assigned faculty can retrieve only their authorized gallery.
4. Valid substitute can retrieve only the delegated assignment's gallery during the active window.
5. Expired or revoked substitute delegations are rejected (403 OUT_OF_SCOPE).
6. Suspended student accounts and ineligible / unregistered profiles are excluded from gallery templates.
7. Biometric templates return 512-float32 vectors (2048 bytes Base64-decoded).
"""
import base64
from datetime import date, datetime, timedelta, timezone
import uuid
import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import create_access_token, get_password_hash
from src.models.academic import AcademicTerm, ClassSection, Department, Subject, TermStatus, DEFAULT_INSTITUTION_ID
from src.models.access_control import (
    Campus,
    Institution,
    InstitutionMembership,
    MembershipStatus,
)
from src.models.assignment import DelegationStatus, SubstituteDelegation, TeachingAssignment
from src.models.enrollment import (
    EnrollmentStatus,
    FaceRegistrationStatus,
    StudentEnrollment,
    StudentFaceProfile,
)
from src.models.user import AccountStatus, User, UserRole


def _synthetic_embedding(seed: float = 0.5) -> bytes:
    import struct
    floats = [float(i) * 0.001 + seed for i in range(512)]
    return struct.pack(f"{len(floats)}f", *floats)


@pytest.fixture
async def gallery_sec_env(db_session: AsyncSession):
    # Setup Institution A (Configured Deployment Institution) and Institution B (Foreign)
    res = await db_session.execute(select(Institution).where(Institution.id == DEFAULT_INSTITUTION_ID))
    inst_a = res.scalar_one_or_none()
    if not inst_a:
        inst_a = Institution(id=DEFAULT_INSTITUTION_ID, code="KLASIO_MAIN", name="Institution A")
        db_session.add(inst_a)
    inst_b = Institution(code=f"INST_B_{uuid.uuid4().hex[:6]}", name="Institution B")
    db_session.add(inst_b)
    await db_session.flush()

    campus_a = Campus(institution_id=inst_a.id, code="CA", name="Campus A")
    dept_a = Department(institution_id=inst_a.id, code="DA", name="Dept A")
    term_a = AcademicTerm(
        institution_id=inst_a.id,
        code=f"TA_{uuid.uuid4().hex[:6]}",
        name="Term A",
        academic_year="2026",
        start_date=date(2026, 1, 1),
        end_date=date(2026, 6, 1),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([campus_a, dept_a, term_a])
    await db_session.flush()

    sec_a = ClassSection(
        institution_id=inst_a.id,
        campus_id=campus_a.id,
        department_id=dept_a.id,
        academic_term_id=term_a.id,
        section_code="SEC_A",
        cohort_year=2024,
    )
    subj_a = Subject(institution_id=inst_a.id, department_id=dept_a.id, code="CS101", name="Intro CS")
    db_session.add_all([sec_a, subj_a])
    await db_session.flush()

    # Users
    admin_a = User(
        institutional_id=f"ADM_A_{uuid.uuid4().hex[:6]}",
        email=f"adma_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash=get_password_hash("pw"),
        full_name="Admin A",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    fac_assigned = User(
        institutional_id=f"FAC_DIR_{uuid.uuid4().hex[:6]}",
        email=f"facdir_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash=get_password_hash("pw"),
        full_name="Faculty Assigned",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    fac_sub = User(
        institutional_id=f"FAC_SUB_{uuid.uuid4().hex[:6]}",
        email=f"facsub_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash=get_password_hash("pw"),
        full_name="Faculty Substitute",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    fac_other = User(
        institutional_id=f"FAC_OTH_{uuid.uuid4().hex[:6]}",
        email=f"facoth_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash=get_password_hash("pw"),
        full_name="Faculty Unrelated",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    stu_active = User(
        institutional_id=f"STU_ACT_{uuid.uuid4().hex[:6]}",
        email=f"stuact_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash=get_password_hash("pw"),
        full_name="Student Active",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    stu_suspended = User(
        institutional_id=f"STU_SUS_{uuid.uuid4().hex[:6]}",
        email=f"stusus_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash=get_password_hash("pw"),
        full_name="Student Suspended",
        role=UserRole.STUDENT,
        account_status=AccountStatus.SUSPENDED,
    )
    db_session.add_all([admin_a, fac_assigned, fac_sub, fac_other, stu_active, stu_suspended])
    await db_session.flush()

    # Memberships in Inst A
    m_admin = InstitutionMembership(institution_id=inst_a.id, user_id=admin_a.id, status=MembershipStatus.ACTIVE)
    m_fac_dir = InstitutionMembership(institution_id=inst_a.id, user_id=fac_assigned.id, status=MembershipStatus.ACTIVE)
    m_fac_sub = InstitutionMembership(institution_id=inst_a.id, user_id=fac_sub.id, status=MembershipStatus.ACTIVE)
    m_fac_oth = InstitutionMembership(institution_id=inst_a.id, user_id=fac_other.id, status=MembershipStatus.ACTIVE)
    m_stu_act = InstitutionMembership(institution_id=inst_a.id, user_id=stu_active.id, status=MembershipStatus.ACTIVE)
    m_stu_sus = InstitutionMembership(institution_id=inst_a.id, user_id=stu_suspended.id, status=MembershipStatus.ACTIVE)
    db_session.add_all([m_admin, m_fac_dir, m_fac_sub, m_fac_oth, m_stu_act, m_stu_sus])
    await db_session.flush()

    # Teaching Assignment in Section A
    ta = TeachingAssignment(
        faculty_user_id=fac_assigned.id,
        class_section_id=sec_a.id,
        subject_id=subj_a.id,
        academic_term_id=term_a.id,
        is_active=True,
        created_by_user_id=admin_a.id,
    )
    db_session.add(ta)
    await db_session.flush()

    # Enrollments
    enr_act = StudentEnrollment(
        student_user_id=stu_active.id,
        class_section_id=sec_a.id,
        academic_term_id=term_a.id,
        effective_start_date=date(2026, 1, 1),
        enrollment_status=EnrollmentStatus.ACTIVE,
    )
    enr_sus = StudentEnrollment(
        student_user_id=stu_suspended.id,
        class_section_id=sec_a.id,
        academic_term_id=term_a.id,
        effective_start_date=date(2026, 1, 1),
        enrollment_status=EnrollmentStatus.ACTIVE,
    )
    db_session.add_all([enr_act, enr_sus])
    await db_session.flush()

    # Face profiles
    fp_act = StudentFaceProfile(
        student_user_id=stu_active.id,
        registration_state=FaceRegistrationStatus.REGISTERED,
        embedding_blob=_synthetic_embedding(0.1),
        embedding_dimension=512,
        active_model_version="EdgeFace-XS-v1",
        quality_score=0.95,
    )
    fp_sus = StudentFaceProfile(
        student_user_id=stu_suspended.id,
        registration_state=FaceRegistrationStatus.REGISTERED,
        embedding_blob=_synthetic_embedding(0.2),
        embedding_dimension=512,
        active_model_version="EdgeFace-XS-v1",
        quality_score=0.90,
    )
    db_session.add_all([fp_act, fp_sus])
    await db_session.commit()

    return {
        "inst_a": inst_a,
        "inst_b": inst_b,
        "ta": ta,
        "admin_a": admin_a,
        "fac_assigned": fac_assigned,
        "fac_sub": fac_sub,
        "fac_other": fac_other,
        "stu_active": stu_active,
        "stu_suspended": stu_suspended,
    }


def _auth_header(user: User) -> dict:
    token = create_access_token(
        subject=str(user.id),
        role=user.role.value,
        institutional_id=user.institutional_id,
    )
    return {"Authorization": f"Bearer {token}"}


@pytest.mark.asyncio
async def test_legacy_admin_cannot_access_unrelated_gallery(async_client: AsyncClient, gallery_sec_env: dict):
    """Priority 2: Legacy ADMIN cannot retrieve biometric gallery without being assigned or delegated."""
    env = gallery_sec_env
    ta = env["ta"]
    admin_a = env["admin_a"]

    res = await async_client.get(
        f"/api/v1/faculty/assignments/{ta.id}/gallery",
        headers=_auth_header(admin_a),
    )
    assert res.status_code == 403
    assert res.json()["error"] == "OUT_OF_SCOPE"
    assert "not authorized to access gallery" in res.json()["message"]


@pytest.mark.asyncio
async def test_assigned_faculty_retrieves_authorized_gallery_and_verifies_vectors(
    async_client: AsyncClient, gallery_sec_env: dict
):
    """Assigned faculty can retrieve only authorized gallery, returning 512-float32 Base64 vectors."""
    env = gallery_sec_env
    ta = env["ta"]
    fac_assigned = env["fac_assigned"]
    stu_active = env["stu_active"]

    res = await async_client.get(
        f"/api/v1/faculty/assignments/{ta.id}/gallery",
        headers=_auth_header(fac_assigned),
    )
    assert res.status_code == 200
    data = res.json()
    assert data["teaching_assignment_id"] == str(ta.id)
    # Suspended student stu_suspended MUST be excluded! Only stu_active included.
    assert data["template_count"] == 1
    assert len(data["templates"]) == 1

    template = data["templates"][0]
    assert template["student_user_id"] == str(stu_active.id)
    assert "embedding_base64" in template
    # Verify exact 512-float32 vector length (2048 bytes)
    raw_emb = base64.b64decode(template["embedding_base64"])
    assert len(raw_emb) == 512 * 4


@pytest.mark.asyncio
async def test_unassigned_faculty_rejected(async_client: AsyncClient, gallery_sec_env: dict):
    """Faculty not assigned and not delegated to the teaching assignment receives 403 OUT_OF_SCOPE."""
    env = gallery_sec_env
    ta = env["ta"]
    fac_other = env["fac_other"]

    res = await async_client.get(
        f"/api/v1/faculty/assignments/{ta.id}/gallery",
        headers=_auth_header(fac_other),
    )
    assert res.status_code == 403
    assert res.json()["error"] == "OUT_OF_SCOPE"


@pytest.mark.asyncio
async def test_substitute_delegation_lifecycle_gallery_access(
    async_client: AsyncClient, gallery_sec_env: dict, db_session: AsyncSession
):
    """Valid substitute can retrieve gallery; expired or revoked delegation is rejected."""
    env = gallery_sec_env
    ta = env["ta"]
    fac_sub = env["fac_sub"]

    # 1. Create active delegation covering today
    today = date.today()
    deleg = SubstituteDelegation(
        teaching_assignment_id=ta.id,
        regular_faculty_user_id=ta.faculty_user_id,
        substitute_faculty_user_id=fac_sub.id,
        start_date=today - timedelta(days=1),
        end_date=today + timedelta(days=2),
        status=DelegationStatus.ACTIVE,
        delegation_reason="Conference coverage",
        created_by_user_id=env["admin_a"].id,
    )
    db_session.add(deleg)
    await db_session.commit()

    # Active delegation -> 200 OK
    res_valid = await async_client.get(
        f"/api/v1/faculty/assignments/{ta.id}/gallery",
        headers=_auth_header(fac_sub),
    )
    assert res_valid.status_code == 200
    assert res_valid.json()["template_count"] == 1

    # 2. Revoke delegation -> 403 OUT_OF_SCOPE
    deleg.status = DelegationStatus.REVOKED
    await db_session.commit()

    res_revoked = await async_client.get(
        f"/api/v1/faculty/assignments/{ta.id}/gallery",
        headers=_auth_header(fac_sub),
    )
    assert res_revoked.status_code == 403
    assert res_revoked.json()["error"] == "OUT_OF_SCOPE"

    # 3. Expired delegation -> 403 OUT_OF_SCOPE
    deleg.status = DelegationStatus.ACTIVE
    deleg.start_date = today - timedelta(days=10)
    deleg.end_date = today - timedelta(days=1)
    await db_session.commit()

    res_expired = await async_client.get(
        f"/api/v1/faculty/assignments/{ta.id}/gallery",
        headers=_auth_header(fac_sub),
    )
    assert res_expired.status_code == 403
    assert res_expired.json()["error"] == "OUT_OF_SCOPE"


@pytest.mark.asyncio
async def test_admin_cannot_access_cross_institution_gallery(
    async_client: AsyncClient, gallery_sec_env: dict, db_session: AsyncSession
):
    """An admin from Institution B cannot retrieve a gallery belonging to Institution A."""
    env = gallery_sec_env
    ta_a = env["ta"]
    inst_b = env["inst_b"]

    admin_b = User(
        institutional_id=f"ADM_B_{uuid.uuid4().hex[:6]}",
        email=f"admb_{uuid.uuid4().hex[:6]}@instb.edu",
        password_hash=get_password_hash("pw"),
        full_name="Admin B",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add(admin_b)
    await db_session.flush()

    m_admin_b = InstitutionMembership(institution_id=inst_b.id, user_id=admin_b.id, status=MembershipStatus.ACTIVE)
    db_session.add(m_admin_b)
    await db_session.commit()

    res = await async_client.get(
        f"/api/v1/faculty/assignments/{ta_a.id}/gallery",
        headers=_auth_header(admin_b),
    )
    assert res.status_code == 403
    assert res.json()["error"] == "OUT_OF_SCOPE"


@pytest.mark.asyncio
async def test_gallery_synchronization_audit_and_rate_limiting(
    async_client: AsyncClient,
    gallery_sec_env: dict,
    caplog,
):
    """Verify that gallery synchronization is strictly audited with zero biometric leakage,
    and rapid repeated retrievals trigger the rate-limiting warning threshold.
    """
    import logging
    env = gallery_sec_env
    ta = env["ta"]
    fac_assigned = env["fac_assigned"]

    caplog.set_level(logging.INFO)

    custom_cid = f"test-corr-{uuid.uuid4().hex[:8]}"
    headers = _auth_header(fac_assigned)
    headers["X-Correlation-ID"] = custom_cid

    # Perform retrieval
    res = await async_client.get(
        f"/api/v1/faculty/assignments/{ta.id}/gallery",
        headers=headers,
    )
    assert res.status_code == 200

    # 1. Audit Verification
    audit_records = [
        r for r in caplog.records
        if "[BIOMETRIC_GALLERY_AUDIT]" in r.message
    ]
    assert len(audit_records) >= 1
    audit_msg = audit_records[-1].message

    # Ensure required fields are present
    assert f"operator_id={fac_assigned.id}" in audit_msg
    assert "operator_pseudonym=" in audit_msg
    assert f"teaching_assignment_id={ta.id}" in audit_msg
    assert f"correlation_id={custom_cid}" in audit_msg
    assert "template_count=" in audit_msg

    # Crucial security assertion: NEVER log raw embedding base64, vectors, or image payloads
    raw_b64 = res.json()["templates"][0]["embedding_base64"]
    assert raw_b64 not in audit_msg

    # 2. Rate Limiting / Rapid Repetition Anomaly Detection
    # Perform 11 rapid requests to trigger rate limit threshold (>10 in 60s)
    for _ in range(11):
        await async_client.get(
            f"/api/v1/faculty/assignments/{ta.id}/gallery",
            headers=headers,
        )

    warning_records = [
        r for r in caplog.records
        if "[GALLERY_RATE_LIMIT]" in r.message and r.levelname == "WARNING"
    ]
    assert len(warning_records) >= 1
    assert f"operator_id={fac_assigned.id}" in warning_records[0].message

