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
async def test_late_admission_lifecycle_and_roster_eligibility(
    async_client: AsyncClient, db_session: AsyncSession
):
    # 1. Setup Admin, Faculty, and two Students
    admin = User(
        institutional_id="ADM-LATE-01",
        email="admin_late@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Admin User",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    faculty = User(
        institutional_id="FAC-LATE-01",
        email="faculty_late@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Prof Algorithms",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    student_regular = User(
        institutional_id="STU-REG-01",
        email="student_reg@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Student Regular (Enrolled Sept 1)",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    student_late = User(
        institutional_id="STU-LATE-01",
        email="student_late@institution.edu",
        password_hash=get_password_hash("pass"),
        full_name="Student Late (Enrolled Sept 20)",
        role=UserRole.STUDENT,
        account_status=AccountStatus.ACTIVE,
    )
    dept = Department(code="CSE-LATE", name="Computer Science Dept")
    term = AcademicTerm(
        code="2026-FALL-LATE",
        name="Fall 2026 Term",
        academic_year="2026-2027",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([admin, faculty, student_regular, student_late, dept, term])
    await db_session.flush()

    subject = Subject(code="CS301-L", name="Data Structures", department_id=dept.id, credits=4)
    section = ClassSection(
        section_code="CSE-3A-LATE",
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

    admin_token = create_access_token(
        subject=str(admin.id), role="ADMIN", institutional_id=admin.institutional_id
    )
    faculty_token = create_access_token(
        subject=str(faculty.id), role="FACULTY", institutional_id=faculty.institutional_id
    )
    late_student_token = create_access_token(
        subject=str(student_late.id), role="STUDENT", institutional_id=student_late.institutional_id
    )

    admin_headers = {"Authorization": f"Bearer {admin_token}"}
    faculty_headers = {"Authorization": f"Bearer {faculty_token}"}
    student_headers = {"Authorization": f"Bearer {late_student_token}"}

    # 2. Admin enrolls student_regular starting Sept 1
    res1 = await async_client.post(
        "/api/v1/admin/enrollments",
        headers=admin_headers,
        json={
            "student_user_id": str(student_regular.id),
            "class_section_id": str(section.id),
            "academic_term_id": str(term.id),
            "effective_start_date": "2026-09-01",
            "effective_end_date": None,
            "enrollment_status": "ACTIVE",
        },
    )
    assert res1.status_code == 201

    # 3. Admin enrolls student_late starting Sept 20 (Late Admission)
    res2 = await async_client.post(
        "/api/v1/admin/enrollments",
        headers=admin_headers,
        json={
            "student_user_id": str(student_late.id),
            "class_section_id": str(section.id),
            "academic_term_id": str(term.id),
            "effective_start_date": "2026-09-20",
            "effective_end_date": None,
            "enrollment_status": "ACTIVE",
        },
    )
    assert res2.status_code == 201

    # 4. Invariant: Admin cannot enroll same student in overlapping active date range
    overlap_res = await async_client.post(
        "/api/v1/admin/enrollments",
        headers=admin_headers,
        json={
            "student_user_id": str(student_late.id),
            "class_section_id": str(section.id),
            "academic_term_id": str(term.id),
            "effective_start_date": "2026-09-25",
            "effective_end_date": None,
            "enrollment_status": "ACTIVE",
        },
    )
    assert overlap_res.status_code == 400
    assert overlap_res.json()["error"] == "STUDENT_INELIGIBLE"

    # 5. Faculty checks roster for historical date Sept 5 (before S2 joined):
    # Only S1 is eligible; S2 must be completely excluded from roster & denominator (SC-002)
    roster_sept5 = await async_client.get(
        f"/api/v1/faculty/assignments/{assignment.id}/roster?session_date=2026-09-05",
        headers=faculty_headers,
    )
    assert roster_sept5.status_code == 200
    data_sept5 = roster_sept5.json()
    assert data_sept5["total_eligible_count"] == 1
    assert data_sept5["eligible_students"][0]["student_user_id"] == str(student_regular.id)

    # 6. Faculty checks roster for date Sept 22 (after S2 joined):
    # Both S1 and S2 are now eligible
    roster_sept22 = await async_client.get(
        f"/api/v1/faculty/assignments/{assignment.id}/roster?session_date=2026-09-22",
        headers=faculty_headers,
    )
    assert roster_sept22.status_code == 200
    data_sept22 = roster_sept22.json()
    assert data_sept22["total_eligible_count"] == 2
    student_ids = [s["student_user_id"] for s in data_sept22["eligible_students"]]
    assert str(student_regular.id) in student_ids
    assert str(student_late.id) in student_ids

    # 7. Student checks personal attendance portal:
    # S2's personal endpoint returns scoped records with 0 unearned absences
    student_res = await async_client.get(
        "/api/v1/student/attendance",
        headers=student_headers,
    )
    assert student_res.status_code == 200
    student_data = student_res.json()
    assert student_data["student_id"] == str(student_late.id)
    assert len(student_data["subjects"]) == 1
    subj = student_data["subjects"][0]
    assert subj["subject_code"] == "CS301-L"
    assert subj["effective_start_date"] == "2026-09-20"
