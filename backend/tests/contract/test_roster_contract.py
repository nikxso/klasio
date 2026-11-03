from datetime import date
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import create_access_token, get_password_hash
from src.models.academic import AcademicTerm, ClassSection, Department, Subject, TermStatus
from src.models.assignment import TeachingAssignment
from src.models.enrollment import EnrollmentStatus, StudentEnrollment
from src.models.user import AccountStatus, User, UserRole


@pytest.mark.asyncio
async def test_class_roster_contract_face_registration_states(
    async_client: AsyncClient, db_session: AsyncSession
):
    """
    T033: Contract test for class roster response in /api/v1/faculty/assignments/{id}/roster
    Verifies that the roster payload matches schema and exposes the three face registration states:
    REGISTERED, PENDING, UNREGISTERED.
    """
    # 1. Setup Admin and Faculty
    admin = User(
        institutional_id="ADM-ROSTER-01",
        email="admin_roster@institution.edu",
        password_hash=get_password_hash("pass123"),
        full_name="Admin Roster",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    faculty = User(
        institutional_id="FAC-ROSTER-01",
        email="faculty_roster@institution.edu",
        password_hash=get_password_hash("pass123"),
        full_name="Dr. Roster Instructor",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([admin, faculty])
    await db_session.flush()

    # 2. Setup Academic Structure
    dept = Department(code="CSE-ROSTER", name="Computer Science Roster")
    term = AcademicTerm(
        code="2026-FALL-ROSTER",
        name="Fall 2026",
        academic_year="2026-2027",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([dept, term])
    await db_session.flush()

    subject = Subject(code="CS302", name="Database Systems", department_id=dept.id, credits=3)
    section = ClassSection(
        section_code="CSE-3B",
        department_id=dept.id,
        academic_term_id=term.id,
        cohort_year=2024,
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

    # 3. Create 3 Students
    s1 = User(
        institutional_id="STU-REG-01",
        email="s1_reg@institution.edu",
        password_hash=get_password_hash("pass123"),
        full_name="Student Registered",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    s2 = User(
        institutional_id="STU-PEND-02",
        email="s2_pend@institution.edu",
        password_hash=get_password_hash("pass123"),
        full_name="Student Pending",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    s3 = User(
        institutional_id="STU-UNREG-03",
        email="s3_unreg@institution.edu",
        password_hash=get_password_hash("pass123"),
        full_name="Student Unregistered",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([s1, s2, s3])
    await db_session.flush()

    # Enroll all 3 in section CSE-3B
    enr1 = StudentEnrollment(
        student_user_id=s1.id,
        class_section_id=section.id,
        academic_term_id=term.id,
        effective_start_date=date(2026, 9, 1),
        enrollment_status=EnrollmentStatus.ACTIVE,
    )
    enr2 = StudentEnrollment(
        student_user_id=s2.id,
        class_section_id=section.id,
        academic_term_id=term.id,
        effective_start_date=date(2026, 9, 1),
        enrollment_status=EnrollmentStatus.ACTIVE,
    )
    enr3 = StudentEnrollment(
        student_user_id=s3.id,
        class_section_id=section.id,
        academic_term_id=term.id,
        effective_start_date=date(2026, 9, 1),
        enrollment_status=EnrollmentStatus.ACTIVE,
    )
    db_session.add_all([enr1, enr2, enr3])
    await db_session.flush()

    # Import StudentFaceProfile (T035 model)
    from src.models.enrollment import FaceRegistrationStatus, StudentFaceProfile

    fp1 = StudentFaceProfile(
        student_user_id=s1.id,
        registration_state=FaceRegistrationStatus.REGISTERED,
        active_model_version="mobilefacenet_v2.1",
        embedding_dimension=128,
        sample_count=5,
        embedding_blob=b"sample_embedding_vector_bytes",
        quality_score=0.92,
    )
    fp2 = StudentFaceProfile(
        student_user_id=s2.id,
        registration_state=FaceRegistrationStatus.PENDING,
        sample_count=3,
        quality_score=0.75,
    )
    # s3 has no face profile record or registration_state = UNREGISTERED
    fp3 = StudentFaceProfile(
        student_user_id=s3.id,
        registration_state=FaceRegistrationStatus.UNREGISTERED,
    )
    db_session.add_all([fp1, fp2, fp3])
    await db_session.flush()

    # 4. Authenticate as Faculty
    token = create_access_token(
        subject=str(faculty.id),
        role=faculty.role.value,
        institutional_id=faculty.institutional_id,
    )
    headers = {"Authorization": f"Bearer {token}"}

    # 5. Fetch class roster for session date
    response = await async_client.get(
        f"/api/v1/faculty/assignments/{assignment.id}/roster?session_date=2026-10-05",
        headers=headers,
    )
    assert response.status_code == 200
    data = response.json()

    # Verify response schema contract
    assert data["teaching_assignment_id"] == str(assignment.id)
    assert data["session_date"] == "2026-10-05"
    assert data["total_eligible_count"] == 3
    assert len(data["eligible_students"]) == 3

    students_by_id = {s["student_user_id"]: s for s in data["eligible_students"]}
    assert str(s1.id) in students_by_id
    assert str(s2.id) in students_by_id
    assert str(s3.id) in students_by_id

    # Verify registration states
    assert students_by_id[str(s1.id)]["face_registration_state"] == "REGISTERED"
    assert students_by_id[str(s2.id)]["face_registration_state"] == "PENDING"
    assert students_by_id[str(s3.id)]["face_registration_state"] == "UNREGISTERED"
