import base64
from datetime import date, datetime, timedelta, timezone
import logging
import math
import struct
import uuid
import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import create_access_token, get_password_hash
from src.models.academic import AcademicTerm, ClassSection, Department, Subject, TermStatus
from src.models.assignment import DelegationStatus, SubstituteDelegation, TeachingAssignment
from src.models.enrollment import EnrollmentStatus, FaceRegistrationStatus, StudentEnrollment, StudentFaceProfile
from src.models.user import AccountStatus, User, UserRole


def create_base64_vector(dim: int = 512, scale: float = 1.0) -> str:
    """Helper to generate base64 string of a float32 vector with controlled L2 norm."""
    val = scale / math.sqrt(dim)
    floats = [val] * dim
    raw = struct.pack(f"{dim}f", *floats)
    return base64.b64encode(raw).decode("ascii")


@pytest.fixture
async def biometrics_test_env(db_session: AsyncSession) -> dict:
    dept = Department(code="CSE-BIO", name="Biometrics Test Dept")
    term = AcademicTerm(
        code="2026-FALL-BIO",
        name="Fall 2026",
        academic_year="2026-2027",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([dept, term])
    await db_session.flush()

    subj_a = Subject(code="BIO101", name="Pattern Recognition", department_id=dept.id, credits=3)
    subj_b = Subject(code="BIO102", name="Computer Vision", department_id=dept.id, credits=3)
    sec_a = ClassSection(section_code="SEC-BIO-A", department_id=dept.id, academic_term_id=term.id, cohort_year=2024)
    sec_b = ClassSection(section_code="SEC-BIO-B", department_id=dept.id, academic_term_id=term.id, cohort_year=2024)
    db_session.add_all([subj_a, subj_b, sec_a, sec_b])
    await db_session.flush()

    # Users
    admin = User(
        institutional_id="ADM-BIO-01",
        email="admin_bio@inst.edu",
        password_hash=get_password_hash("pass"),
        full_name="Admin Director",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    fac_assigned = User(
        institutional_id="FAC-BIO-01",
        email="fac_assigned@inst.edu",
        password_hash=get_password_hash("pass"),
        full_name="Prof Assigned",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    fac_other = User(
        institutional_id="FAC-BIO-02",
        email="fac_other@inst.edu",
        password_hash=get_password_hash("pass"),
        full_name="Prof Other",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    student_a = User(
        institutional_id="STU-BIO-01",
        email="student_a@inst.edu",
        password_hash=get_password_hash("pass"),
        full_name="Alice Student",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    student_b = User(
        institutional_id="STU-BIO-02",
        email="student_b@inst.edu",
        password_hash=get_password_hash("pass"),
        full_name="Bob Student",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    student_suspended = User(
        institutional_id="STU-BIO-03",
        email="student_susp@inst.edu",
        password_hash=get_password_hash("pass"),
        full_name="Charlie Suspended",
        role=UserRole.STUDENT,
        account_status=AccountStatus.SUSPENDED,
    )

    db_session.add_all([admin, fac_assigned, fac_other, student_a, student_b, student_suspended])
    await db_session.flush()

    # Teaching Assignments
    assign_a = TeachingAssignment(
        class_section_id=sec_a.id,
        subject_id=subj_a.id,
        academic_term_id=term.id,
        faculty_user_id=fac_assigned.id,
        created_by_user_id=admin.id,
        is_active=True,
    )
    assign_b = TeachingAssignment(
        class_section_id=sec_b.id,
        subject_id=subj_b.id,
        academic_term_id=term.id,
        faculty_user_id=fac_other.id,
        created_by_user_id=admin.id,
        is_active=True,
    )
    db_session.add_all([assign_a, assign_b])
    await db_session.flush()

    # Enrollments
    enr_a = StudentEnrollment(
        student_user_id=student_a.id,
        class_section_id=sec_a.id,
        academic_term_id=term.id,
        effective_start_date=date(2026, 8, 1),
        enrollment_status=EnrollmentStatus.ACTIVE,
    )
    enr_b = StudentEnrollment(
        student_user_id=student_b.id,
        class_section_id=sec_b.id,
        academic_term_id=term.id,
        effective_start_date=date(2026, 8, 1),
        enrollment_status=EnrollmentStatus.ACTIVE,
    )
    enr_susp = StudentEnrollment(
        student_user_id=student_suspended.id,
        class_section_id=sec_a.id,
        academic_term_id=term.id,
        effective_start_date=date(2026, 8, 1),
        enrollment_status=EnrollmentStatus.ACTIVE,
    )
    db_session.add_all([enr_a, enr_b, enr_susp])
    await db_session.flush()

    # Auth headers
    def get_headers(user: User):
        token = create_access_token(
            subject=str(user.id),
            role=user.role.value,
            institutional_id=user.institutional_id,
        )
        return {"Authorization": f"Bearer {token}"}

    return {
        "admin": admin,
        "fac_assigned": fac_assigned,
        "fac_other": fac_other,
        "student_a": student_a,
        "student_b": student_b,
        "student_suspended": student_suspended,
        "assign_a": assign_a,
        "assign_b": assign_b,
        "headers": {
            "admin": get_headers(admin),
            "fac_assigned": get_headers(fac_assigned),
            "fac_other": get_headers(fac_other),
            "student_a": get_headers(student_a),
        },
    }


@pytest.mark.asyncio
async def test_admin_can_enroll_student(async_client: AsyncClient, biometrics_test_env: dict, db_session: AsyncSession):
    env = biometrics_test_env
    student_a = env["student_a"]

    payload = {
        "student_user_id": str(student_a.id),
        "active_model_version": "EdgeFace-XS-v1",
        "embedding_dimension": 512,
        "sample_count": 3,
        "embedding_base64": create_base64_vector(512),
        "quality_score": 0.88,
    }

    res = await async_client.post("/api/v1/biometrics/enrollment", json=payload, headers=env["headers"]["admin"])
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["student_user_id"] == str(student_a.id)
    assert data["registration_state"] == "REGISTERED"
    assert data["is_re_enrollment"] is False
    assert data["embedding_dimension"] == 512

    # Verify DB
    stmt = select(StudentFaceProfile).where(StudentFaceProfile.student_user_id == student_a.id)
    profile = (await db_session.execute(stmt)).scalar_one_or_none()
    assert profile is not None
    assert profile.registration_state == FaceRegistrationStatus.REGISTERED
    assert profile.embedding_blob is not None
    assert len(profile.embedding_blob) == 512 * 4


@pytest.mark.asyncio
async def test_idempotent_re_enrollment(async_client: AsyncClient, biometrics_test_env: dict):
    env = biometrics_test_env
    student_a = env["student_a"]

    payload = {
        "student_user_id": str(student_a.id),
        "active_model_version": "EdgeFace-XS-v1",
        "embedding_dimension": 512,
        "sample_count": 3,
        "embedding_base64": create_base64_vector(512),
        "quality_score": 0.88,
    }

    # Initial enrollment
    res1 = await async_client.post("/api/v1/biometrics/enrollment", json=payload, headers=env["headers"]["admin"])
    assert res1.status_code == 200
    assert res1.json()["is_re_enrollment"] is False

    # Second enrollment (re-enrollment replacement)
    payload["quality_score"] = 0.95
    res2 = await async_client.post("/api/v1/biometrics/enrollment", json=payload, headers=env["headers"]["admin"])
    assert res2.status_code == 200
    assert res2.json()["is_re_enrollment"] is True
    assert res2.json()["quality_score"] == 0.95


@pytest.mark.asyncio
async def test_assigned_faculty_can_enroll_student(async_client: AsyncClient, biometrics_test_env: dict):
    env = biometrics_test_env
    student_a = env["student_a"]

    payload = {
        "student_user_id": str(student_a.id),
        "active_model_version": "MobileFaceNet-v1",
        "embedding_dimension": 192,
        "sample_count": 4,
        "embedding_base64": create_base64_vector(192),
        "quality_score": 0.79,
    }

    res = await async_client.post("/api/v1/biometrics/enrollment", json=payload, headers=env["headers"]["fac_assigned"])
    assert res.status_code == 200, res.text
    assert res.json()["active_model_version"] == "MobileFaceNet-v1"


@pytest.mark.asyncio
async def test_unassigned_faculty_cannot_enroll_student(async_client: AsyncClient, biometrics_test_env: dict):
    env = biometrics_test_env
    student_a = env["student_a"]

    payload = {
        "student_user_id": str(student_a.id),
        "active_model_version": "EdgeFace-XS-v1",
        "embedding_dimension": 512,
        "sample_count": 3,
        "embedding_base64": create_base64_vector(512),
        "quality_score": 0.85,
    }

    # fac_other is assigned to Section B, but student_a is in Section A
    res = await async_client.post("/api/v1/biometrics/enrollment", json=payload, headers=env["headers"]["fac_other"])
    assert res.status_code == 403
    assert res.json()["error"] == "OUT_OF_SCOPE"


@pytest.mark.asyncio
async def test_student_can_enroll_own_biometric_profile(async_client: AsyncClient, biometrics_test_env: dict):
    env = biometrics_test_env
    student_a = env["student_a"]

    payload = {
        "student_user_id": str(student_a.id),
        "active_model_version": "EdgeFace-XS-v1",
        "embedding_dimension": 512,
        "sample_count": 3,
        "embedding_base64": create_base64_vector(512),
        "quality_score": 0.85,
    }

    res = await async_client.post("/api/v1/biometrics/enrollment", json=payload, headers=env["headers"]["student_a"])
    assert res.status_code == 200
    data = res.json()
    assert data["student_user_id"] == str(student_a.id)
    assert data["registration_state"] == "REGISTERED"


@pytest.mark.asyncio
async def test_student_cannot_enroll_another_student(async_client: AsyncClient, biometrics_test_env: dict):
    env = biometrics_test_env
    student_b = env["student_b"]

    payload = {
        "student_user_id": str(student_b.id),
        "active_model_version": "EdgeFace-XS-v1",
        "embedding_dimension": 512,
        "sample_count": 3,
        "embedding_base64": create_base64_vector(512),
        "quality_score": 0.85,
    }

    # student_a attempts to enroll student_b
    res = await async_client.post("/api/v1/biometrics/enrollment", json=payload, headers=env["headers"]["student_a"])
    assert res.status_code == 403
    assert res.json()["error"] == "OUT_OF_SCOPE"


@pytest.mark.asyncio
async def test_suspended_student_enrollment_rejected(async_client: AsyncClient, biometrics_test_env: dict):
    env = biometrics_test_env
    student_suspended = env["student_suspended"]

    payload = {
        "student_user_id": str(student_suspended.id),
        "active_model_version": "EdgeFace-XS-v1",
        "embedding_dimension": 512,
        "sample_count": 3,
        "embedding_base64": create_base64_vector(512),
        "quality_score": 0.85,
    }

    res = await async_client.post("/api/v1/biometrics/enrollment", json=payload, headers=env["headers"]["admin"])
    assert res.status_code == 400
    assert res.json()["error"] == "CONFLICT_ERROR"
    assert "SUSPENDED" in res.json()["message"]


@pytest.mark.asyncio
async def test_biometric_validation_failures(async_client: AsyncClient, biometrics_test_env: dict):
    env = biometrics_test_env
    student_a = env["student_a"]

    # 1. Quality too low (< 0.70)
    p_low_q = {
        "student_user_id": str(student_a.id),
        "active_model_version": "EdgeFace-XS-v1",
        "embedding_dimension": 512,
        "sample_count": 3,
        "embedding_base64": create_base64_vector(512),
        "quality_score": 0.65,
    }
    res = await async_client.post("/api/v1/biometrics/enrollment", json=p_low_q, headers=env["headers"]["admin"])
    assert res.status_code == 400
    assert res.json()["error"] == "BIOMETRIC_VALIDATION_FAILED"

    # 2. Insufficient samples (< 3)
    p_few_samples = {
        "student_user_id": str(student_a.id),
        "active_model_version": "EdgeFace-XS-v1",
        "embedding_dimension": 512,
        "sample_count": 2,
        "embedding_base64": create_base64_vector(512),
        "quality_score": 0.85,
    }
    res = await async_client.post("/api/v1/biometrics/enrollment", json=p_few_samples, headers=env["headers"]["admin"])
    assert res.status_code == 400
    assert res.json()["error"] == "BIOMETRIC_VALIDATION_FAILED"

    # 3. Non-unit L2 norm (scale = 1.8)
    p_bad_norm = {
        "student_user_id": str(student_a.id),
        "active_model_version": "EdgeFace-XS-v1",
        "embedding_dimension": 512,
        "sample_count": 3,
        "embedding_base64": create_base64_vector(512, scale=1.8),
        "quality_score": 0.85,
    }
    res = await async_client.post("/api/v1/biometrics/enrollment", json=p_bad_norm, headers=env["headers"]["admin"])
    assert res.status_code == 400
    assert res.json()["error"] == "BIOMETRIC_VALIDATION_FAILED"


@pytest.mark.asyncio
async def test_revocation_workflow(async_client: AsyncClient, biometrics_test_env: dict, db_session: AsyncSession):
    env = biometrics_test_env
    student_a = env["student_a"]

    # First enroll
    enroll_payload = {
        "student_user_id": str(student_a.id),
        "active_model_version": "EdgeFace-XS-v1",
        "embedding_dimension": 512,
        "sample_count": 3,
        "embedding_base64": create_base64_vector(512),
        "quality_score": 0.90,
    }
    res = await async_client.post("/api/v1/biometrics/enrollment", json=enroll_payload, headers=env["headers"]["admin"])
    assert res.status_code == 200

    # Unauthorized faculty cannot revoke
    revoke_payload = {
        "student_user_id": str(student_a.id),
        "revocation_reason": "Student transferred section",
    }
    res_unauth = await async_client.post("/api/v1/biometrics/revoke", json=revoke_payload, headers=env["headers"]["fac_other"])
    assert res_unauth.status_code == 403
    assert res_unauth.json()["error"] == "OUT_OF_SCOPE"

    # Authorized faculty revokes
    res_revoke = await async_client.post("/api/v1/biometrics/revoke", json=revoke_payload, headers=env["headers"]["fac_assigned"])
    assert res_revoke.status_code == 200
    data = res_revoke.json()
    assert data["registration_state"] == "UNREGISTERED"
    assert data["revocation_reason"] == "Student transferred section"

    # Verify database profile wiped
    stmt = select(StudentFaceProfile).where(StudentFaceProfile.student_user_id == student_a.id)
    profile = (await db_session.execute(stmt)).scalar_one_or_none()
    assert profile.registration_state == FaceRegistrationStatus.UNREGISTERED
    assert profile.embedding_blob is None
    assert profile.sample_count == 0


@pytest.mark.asyncio
async def test_scoped_gallery_retrieval(async_client: AsyncClient, biometrics_test_env: dict):
    env = biometrics_test_env
    student_a = env["student_a"]
    assign_a = env["assign_a"]

    # 1. Enroll student A
    enroll_payload = {
        "student_user_id": str(student_a.id),
        "active_model_version": "EdgeFace-XS-v1",
        "embedding_dimension": 512,
        "sample_count": 3,
        "embedding_base64": create_base64_vector(512),
        "quality_score": 0.92,
    }
    await async_client.post("/api/v1/biometrics/enrollment", json=enroll_payload, headers=env["headers"]["admin"])

    # 2. Fetch gallery for assign_a as assigned faculty
    res = await async_client.get(
        f"/api/v1/faculty/assignments/{assign_a.id}/gallery",
        headers=env["headers"]["fac_assigned"],
    )
    assert res.status_code == 200, res.text
    gallery = res.json()
    assert gallery["teaching_assignment_id"] == str(assign_a.id)
    assert gallery["template_count"] == 1
    assert len(gallery["templates"]) == 1
    template = gallery["templates"][0]
    assert template["student_user_id"] == str(student_a.id)
    assert template["institutional_id"] == student_a.institutional_id
    assert template["model_version"] == "EdgeFace-XS-v1"
    # Verification of raw biometric embedding payload: Base64-encoded 512-float32 vector (2048 bytes)
    assert "embedding_base64" in template
    raw_emb = base64.b64decode(template["embedding_base64"])
    assert len(raw_emb) == 512 * 4, f"Expected 2048 bytes for 512 float32 values, got {len(raw_emb)}"
    v1 = gallery["gallery_version"]
    assert len(v1) == 16

    # 3. Unassigned faculty locked out
    res_unauth = await async_client.get(
        f"/api/v1/faculty/assignments/{assign_a.id}/gallery",
        headers=env["headers"]["fac_other"],
    )
    assert res_unauth.status_code == 403
    assert res_unauth.json()["error"] == "OUT_OF_SCOPE"

    # 4. Student locked out
    res_student = await async_client.get(
        f"/api/v1/faculty/assignments/{assign_a.id}/gallery",
        headers=env["headers"]["student_a"],
    )
    assert res_student.status_code == 403

    # 5. Unassigned Admin is locked out (universal Admin bypass eliminated)
    res_admin = await async_client.get(
        f"/api/v1/faculty/assignments/{assign_a.id}/gallery",
        headers=env["headers"]["admin"],
    )
    assert res_admin.status_code == 403
    assert res_admin.json()["error"] == "OUT_OF_SCOPE"

    # 6. Revoke student A and verify gallery updates
    await async_client.post(
        "/api/v1/biometrics/revoke",
        json={"student_user_id": str(student_a.id), "revocation_reason": "Testing gallery refresh"},
        headers=env["headers"]["admin"],
    )
    res_after = await async_client.get(
        f"/api/v1/faculty/assignments/{assign_a.id}/gallery",
        headers=env["headers"]["fac_assigned"],
    )
    assert res_after.status_code == 200
    assert res_after.json()["template_count"] == 0
    assert res_after.json()["gallery_version"] != v1


@pytest.mark.asyncio
async def test_biometric_privacy_audit_logging(async_client: AsyncClient, biometrics_test_env: dict, caplog):
    env = biometrics_test_env
    student_a = env["student_a"]
    b64_vec = create_base64_vector(512)

    with caplog.at_level(logging.INFO):
        enroll_payload = {
            "student_user_id": str(student_a.id),
            "active_model_version": "EdgeFace-XS-v1",
            "embedding_dimension": 512,
            "sample_count": 3,
            "embedding_base64": b64_vec,
            "quality_score": 0.88,
        }
        res = await async_client.post("/api/v1/biometrics/enrollment", json=enroll_payload, headers=env["headers"]["admin"])
        assert res.status_code == 200

        # Check logs
        assert "BIOMETRIC_AUDIT: action=ENROLLMENT" in caplog.text
        assert f"student_id={student_a.id}" in caplog.text
        # HARD INVARIANT: Raw base64 vector must NEVER appear in logs
        assert b64_vec not in caplog.text


@pytest.mark.asyncio
async def test_delegation_expired_and_revoked_gallery_access(
    async_client: AsyncClient, biometrics_test_env: dict, db_session: AsyncSession
):
    """Verify that substitute faculty can only access assignment gallery during an active, non-revoked delegation."""
    env = biometrics_test_env
    assign_a = env["assign_a"]
    fac_sub = env["fac_other"]
    admin = env["admin"]
    today = date.today()

    # Create active substitute delegation for assign_a
    delegation = SubstituteDelegation(
        teaching_assignment_id=assign_a.id,
        regular_faculty_user_id=env["fac_assigned"].id,
        substitute_faculty_user_id=fac_sub.id,
        start_date=today - timedelta(days=1),
        end_date=today + timedelta(days=2),
        delegation_reason="Conference coverage",
        status=DelegationStatus.ACTIVE,
        created_by_user_id=admin.id,
    )
    db_session.add(delegation)
    await db_session.flush()

    # 1. Active delegation -> can access gallery
    res_active = await async_client.get(
        f"/api/v1/faculty/assignments/{assign_a.id}/gallery",
        headers=env["headers"]["fac_other"],
    )
    assert res_active.status_code == 200

    # 2. Querying on a date outside delegation window -> 403 OUT_OF_SCOPE
    future_date = (today + timedelta(days=10)).isoformat()
    res_future = await async_client.get(
        f"/api/v1/faculty/assignments/{assign_a.id}/gallery?session_date={future_date}",
        headers=env["headers"]["fac_other"],
    )
    assert res_future.status_code == 403
    assert res_future.json()["error"] == "OUT_OF_SCOPE"

    # 3. Revoked delegation -> 403 OUT_OF_SCOPE
    delegation.status = DelegationStatus.REVOKED
    await db_session.flush()

    res_revoked = await async_client.get(
        f"/api/v1/faculty/assignments/{assign_a.id}/gallery",
        headers=env["headers"]["fac_other"],
    )
    assert res_revoked.status_code == 403
    assert res_revoked.json()["error"] == "OUT_OF_SCOPE"


@pytest.mark.asyncio
async def test_suspended_student_omitted_from_gallery(
    async_client: AsyncClient, biometrics_test_env: dict, db_session: AsyncSession
):
    """Verify that suspended students are omitted from the gallery and gallery_version updates."""
    env = biometrics_test_env
    student_a = env["student_a"]
    assign_a = env["assign_a"]

    # 1. Enroll student A
    enroll_payload = {
        "student_user_id": str(student_a.id),
        "active_model_version": "EdgeFace-XS-v1",
        "embedding_dimension": 512,
        "sample_count": 3,
        "embedding_base64": create_base64_vector(512),
        "quality_score": 0.90,
    }
    await async_client.post("/api/v1/biometrics/enrollment", json=enroll_payload, headers=env["headers"]["admin"])

    # 2. Check initial gallery
    res1 = await async_client.get(
        f"/api/v1/faculty/assignments/{assign_a.id}/gallery",
        headers=env["headers"]["fac_assigned"],
    )
    assert res1.status_code == 200
    assert res1.json()["template_count"] == 1
    v1 = res1.json()["gallery_version"]

    # 3. Suspend student A
    student_a.account_status = AccountStatus.SUSPENDED
    await db_session.flush()

    # 4. Check gallery again -> student A omitted, template_count == 0, gallery_version changed
    res2 = await async_client.get(
        f"/api/v1/faculty/assignments/{assign_a.id}/gallery",
        headers=env["headers"]["fac_assigned"],
    )
    assert res2.status_code == 200
    assert res2.json()["template_count"] == 0
    assert res2.json()["gallery_version"] != v1


@pytest.mark.asyncio
async def test_cross_assignment_isolation(async_client: AsyncClient, biometrics_test_env: dict):
    """Verify strict isolation: faculty cannot query other assignments and students are never cross-pollinated."""
    env = biometrics_test_env
    assign_a = env["assign_a"]
    assign_b = env["assign_b"]
    student_b = env["student_b"]

    # Enroll student B into Section B
    enroll_payload = {
        "student_user_id": str(student_b.id),
        "active_model_version": "EdgeFace-XS-v1",
        "embedding_dimension": 512,
        "sample_count": 3,
        "embedding_base64": create_base64_vector(512),
        "quality_score": 0.88,
    }
    await async_client.post("/api/v1/biometrics/enrollment", json=enroll_payload, headers=env["headers"]["admin"])

    # Faculty A (assigned to A) cannot access B's gallery
    res_a_on_b = await async_client.get(
        f"/api/v1/faculty/assignments/{assign_b.id}/gallery",
        headers=env["headers"]["fac_assigned"],
    )
    assert res_a_on_b.status_code == 403
    assert res_a_on_b.json()["error"] == "OUT_OF_SCOPE"

    # Faculty B can access B's gallery and sees student B
    res_b = await async_client.get(
        f"/api/v1/faculty/assignments/{assign_b.id}/gallery",
        headers=env["headers"]["fac_other"],
    )
    assert res_b.status_code == 200
    assert res_b.json()["template_count"] == 1
    assert res_b.json()["templates"][0]["student_user_id"] == str(student_b.id)

    # Faculty A accesses A's gallery -> student B is NOT present
    res_a = await async_client.get(
        f"/api/v1/faculty/assignments/{assign_a.id}/gallery",
        headers=env["headers"]["fac_assigned"],
    )
    assert res_a.status_code == 200
    stu_ids_in_a = [t["student_user_id"] for t in res_a.json()["templates"]]
    assert str(student_b.id) not in stu_ids_in_a

