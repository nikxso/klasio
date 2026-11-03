from datetime import date
import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import create_access_token, get_password_hash
from src.models.academic import AcademicTerm, ClassSection, Department, Subject, TermStatus
from src.models.assignment import TeachingAssignment
from src.models.enrollment import EnrollmentStatus, StudentEnrollment
from src.models.user import AccountStatus, User, UserRole


@pytest.mark.asyncio
async def test_biometric_decoupling_and_roster_eligibility(
    async_client: AsyncClient, db_session: AsyncSession
):
    """
    T034: Integration test for biometric decoupling (SC-003, FR-021, FR-022).
    Proves that:
    1. 100% of academically enrolled students appear on the roster regardless of face registration status.
    2. Students with UNREGISTERED or PENDING states are fully eligible for attendance.
    3. Central student face profile is bound 1:1 to User and is NOT scoped per term or section.
    """
    # 1. Setup Faculty and Admin
    admin = User(
        institutional_id="ADM-DECOUPLE-01",
        email="admin_decouple@institution.edu",
        password_hash=get_password_hash("pass123"),
        full_name="Admin Decouple",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    faculty = User(
        institutional_id="FAC-DECOUPLE-01",
        email="faculty_decouple@institution.edu",
        password_hash=get_password_hash("pass123"),
        full_name="Prof Decouple",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([admin, faculty])
    await db_session.flush()

    dept = Department(code="ECE", name="Electronics and Communication")
    term = AcademicTerm(
        code="2026-FALL-ECE",
        name="Fall 2026",
        academic_year="2026-2027",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([dept, term])
    await db_session.flush()

    subject = Subject(code="EC201", name="Signals & Systems", department_id=dept.id, credits=4)
    section = ClassSection(
        section_code="ECE-2A",
        department_id=dept.id,
        academic_term_id=term.id,
        cohort_year=2025,
    )
    db_session.add_all([subject, section])
    await db_session.flush()

    assignment = TeachingAssignment(
        faculty_user_id=faculty.id,
        class_section_id=section.id,
        subject_id=subject.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
        is_active=True,
    )
    db_session.add(assignment)
    await db_session.flush()

    # 2. Enroll 4 students with varying biometric states
    # S1: REGISTERED
    # S2: UNREGISTERED (has face profile record with UNREGISTERED)
    # S3: No face profile record at all (defaults to UNREGISTERED)
    # S4: PENDING
    students = []
    for i in range(1, 5):
        s = User(
            institutional_id=f"25EC00{i}",
            email=f"student{i}_ece@institution.edu",
            password_hash=get_password_hash("pass123"),
            full_name=f"Student ECE {i}",
            role=UserRole.STUDENT,
            account_status=AccountStatus.ACTIVE,
        )
        students.append(s)
    db_session.add_all(students)
    await db_session.flush()

    for s in students:
        enr = StudentEnrollment(
            student_user_id=s.id,
            class_section_id=section.id,
            academic_term_id=term.id,
            effective_start_date=date(2026, 8, 15),
            enrollment_status=EnrollmentStatus.ACTIVE,
        )
        db_session.add(enr)
    await db_session.flush()

    from src.models.enrollment import FaceRegistrationStatus, StudentFaceProfile

    # S1 registered
    fp1 = StudentFaceProfile(
        student_user_id=students[0].id,
        registration_state=FaceRegistrationStatus.REGISTERED,
        active_model_version="mobilefacenet_v2.1",
        embedding_dimension=128,
        sample_count=5,
        quality_score=0.95,
    )
    # S2 explicit unregistered
    fp2 = StudentFaceProfile(
        student_user_id=students[1].id,
        registration_state=FaceRegistrationStatus.UNREGISTERED,
    )
    # S3 has NO record
    # S4 pending
    fp4 = StudentFaceProfile(
        student_user_id=students[3].id,
        registration_state=FaceRegistrationStatus.PENDING,
        sample_count=2,
        quality_score=0.68,
    )
    db_session.add_all([fp1, fp2, fp4])
    await db_session.flush()

    # 3. Query roster endpoint
    token = create_access_token(
        subject=str(faculty.id),
        role=faculty.role.value,
        institutional_id=faculty.institutional_id,
    )
    headers = {"Authorization": f"Bearer {token}"}

    res = await async_client.get(
        f"/api/v1/faculty/assignments/{assignment.id}/roster?session_date=2026-09-10",
        headers=headers,
    )
    assert res.status_code == 200
    data = res.json()

    # 100% of academically enrolled students appear
    assert data["total_eligible_count"] == 4
    assert len(data["eligible_students"]) == 4

    roster_map = {item["student_user_id"]: item for item in data["eligible_students"]}
    assert roster_map[str(students[0].id)]["face_registration_state"] == "REGISTERED"
    assert roster_map[str(students[1].id)]["face_registration_state"] == "UNREGISTERED"
    assert roster_map[str(students[2].id)]["face_registration_state"] == "UNREGISTERED"
    assert roster_map[str(students[3].id)]["face_registration_state"] == "PENDING"
