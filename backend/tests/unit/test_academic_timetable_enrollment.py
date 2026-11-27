from datetime import date, time, timedelta
from typing import Optional
import uuid
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.exceptions import ConflictError, EligibilityError, EntityNotFoundError
from src.models.academic import (
    DEFAULT_INSTITUTION_ID,
    AcademicPeriod,
    AcademicTerm,
    ClassSection,
    Department,
    Program,
    Subject,
    TermStatus,
    TimetableEntry,
)
from src.models.assignment import (
    AssignmentStatus,
    SubstituteDelegation,
    DelegationStatus,
    TeachingAssignment,
)
from src.models.enrollment import (
    EnrollmentStatus,
    FaceRegistrationStatus,
    StudentEnrollment,
    StudentFaceProfile,
)
from src.models.user import AccountStatus, User, UserRole
from src.schemas.academic import (
    AcademicPeriodCreate,
    AcademicPeriodUpdate,
    ProgramCreate,
    TimetableEntryCreate,
)
from src.schemas.assignment import TeachingAssignmentCreate
from src.schemas.enrollment import (
    BulkEnrollmentExecuteRequest,
    BulkEnrollmentPreviewRequest,
    BulkStudentEnrollmentRow,
)
from src.services.enrollment_service import EnrollmentService
from src.services.timetable_service import TimetableService


def make_test_user(
    email: str,
    full_name: str,
    role: UserRole = UserRole.FACULTY,
    institutional_id: Optional[str] = None,
    account_status: AccountStatus = AccountStatus.ACTIVE,
) -> User:
    return User(
        institutional_id=institutional_id or f"INST_{uuid.uuid4().hex[:8].upper()}",
        email=email,
        password_hash="test_hashed_password",
        full_name=full_name,
        role=role,
        account_status=account_status,
    )


@pytest.mark.asyncio
async def test_program_creation_and_section_binding(db_session: AsyncSession):
    """Verify Program model creation, department scoping, and section program assignment."""
    # 1. Create department
    dept = Department(
        institution_id=DEFAULT_INSTITUTION_ID,
        code=f"DEPT_{uuid.uuid4().hex[:6].upper()}",
        name="Computer Science & Engineering",
    )
    db_session.add(dept)
    await db_session.flush()

    # 2. Create program
    prog = Program(
        institution_id=DEFAULT_INSTITUTION_ID,
        department_id=dept.id,
        code="BTECH_CSE",
        name="Bachelor of Technology in Computer Science",
        is_active=True,
    )
    db_session.add(prog)
    await db_session.flush()

    assert prog.id is not None
    assert prog.code == "BTECH_CSE"

    # 3. Create term & section bound to program
    term = AcademicTerm(
        institution_id=DEFAULT_INSTITUTION_ID,
        code=f"TERM_{uuid.uuid4().hex[:6].upper()}",
        name="Fall 2026",
        academic_year="2026-27",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    db_session.add(term)
    await db_session.flush()

    sec = ClassSection(
        institution_id=DEFAULT_INSTITUTION_ID,
        section_code="CSE-3-A",
        department_id=dept.id,
        academic_term_id=term.id,
        cohort_year=2026,
        program_id=prog.id,
    )
    db_session.add(sec)
    await db_session.flush()

    assert sec.program_id == prog.id


@pytest.mark.asyncio
async def test_teaching_assignment_distinct_groups(db_session: AsyncSession):
    """Verify multiple teaching assignments for the same section and subject with distinct groups (Lecture, Lab A)."""
    dept = Department(institution_id=DEFAULT_INSTITUTION_ID, code=f"DEPT_{uuid.uuid4().hex[:6]}", name="Dept")
    db_session.add(dept)
    await db_session.flush()

    term = AcademicTerm(
        institution_id=DEFAULT_INSTITUTION_ID,
        code=f"TERM_{uuid.uuid4().hex[:6]}",
        name="Term",
        academic_year="2026-27",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
    )
    db_session.add(term)
    await db_session.flush()

    sec = ClassSection(
        institution_id=DEFAULT_INSTITUTION_ID,
        section_code="SEC-A",
        department_id=dept.id,
        academic_term_id=term.id,
        cohort_year=2026,
    )
    db_session.add(sec)

    subj = Subject(
        institution_id=DEFAULT_INSTITUTION_ID,
        code=f"CS_{uuid.uuid4().hex[:6]}",
        name="Database Systems",
        department_id=dept.id,
        credits=4,
    )
    db_session.add(subj)

    fac1 = make_test_user(f"fac1_{uuid.uuid4().hex[:6]}@example.com", "Prof Alpha", UserRole.FACULTY)
    fac2 = make_test_user(f"fac2_{uuid.uuid4().hex[:6]}@example.com", "Prof Beta", UserRole.FACULTY)
    admin = make_test_user(f"admin_{uuid.uuid4().hex[:6]}@example.com", "Admin User", UserRole.ADMIN)
    db_session.add_all([fac1, fac2, admin])
    await db_session.flush()

    # Assignment 1: Lecture (DEFAULT group)
    ta1 = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=fac1.id,
        class_section_id=sec.id,
        subject_id=subj.id,
        academic_term_id=term.id,
        teaching_group="LECTURE",
        assignment_status=AssignmentStatus.ACTIVE,
        created_by_user_id=admin.id,
    )
    db_session.add(ta1)
    await db_session.flush()

    # Assignment 2: Lab Group A
    ta2 = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=fac2.id,
        class_section_id=sec.id,
        subject_id=subj.id,
        academic_term_id=term.id,
        teaching_group="LAB_BATCH_A",
        assignment_status=AssignmentStatus.ACTIVE,
        created_by_user_id=admin.id,
    )
    db_session.add(ta2)
    await db_session.flush()

    assert ta1.id != ta2.id
    assert ta1.teaching_group == "LECTURE"
    assert ta2.teaching_group == "LAB_BATCH_A"


@pytest.mark.asyncio
async def test_bulk_enrollment_preview_and_execute(db_session: AsyncSession):
    """Verify bulk student enrollment preview, validation, user auto-creation, and execution."""
    dept = Department(institution_id=DEFAULT_INSTITUTION_ID, code=f"DEPT_{uuid.uuid4().hex[:6]}", name="Dept")
    db_session.add(dept)
    await db_session.flush()

    term = AcademicTerm(
        institution_id=DEFAULT_INSTITUTION_ID,
        code=f"TERM_{uuid.uuid4().hex[:6]}",
        name="Term",
        academic_year="2026-27",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
    )
    db_session.add(term)
    await db_session.flush()

    sec = ClassSection(
        institution_id=DEFAULT_INSTITUTION_ID,
        section_code="SEC-1",
        department_id=dept.id,
        academic_term_id=term.id,
        cohort_year=2026,
    )
    db_session.add(sec)

    # Pre-create 1 existing student
    existing_stu = make_test_user("stu001@example.com", "Alice Student", UserRole.STUDENT, institutional_id="STU-001")
    db_session.add(existing_stu)
    await db_session.flush()

    enrollment_service = EnrollmentService(db_session)

    # Preview with: 1 existing student, 1 new student, 1 invalid email, 1 duplicate
    preview_req = BulkEnrollmentPreviewRequest(
        academic_term_id=term.id,
        class_section_id=sec.id,
        students=[
            BulkStudentEnrollmentRow(
                institutional_id="STU-001",
                full_name="Alice Student",
                email="stu001@example.com",
            ),
            BulkStudentEnrollmentRow(
                institutional_id="STU-002",
                full_name="Bob Student",
                email="stu002@example.com",
            ),
            BulkStudentEnrollmentRow(
                institutional_id="STU-003",
                full_name="Charlie Invalid",
                email="invalid-email-address",
            ),
            BulkStudentEnrollmentRow(
                institutional_id="STU-001",
                full_name="Alice Duplicate",
                email="stu001_dup@example.com",
            ),
        ],
    )

    preview = await enrollment_service.bulk_enroll_preview(preview_req)
    assert preview.total_rows == 4
    assert preview.total_submitted == 4
    assert preview.valid_count == 2
    assert preview.error_count == 2
    assert preview.existing_user_count == 1
    assert preview.duplicate_count == 1
    assert preview.new_user_count == 1
    assert preview.new_accounts_count == 1
    assert preview.preview_rows[0].student_name == "Alice Student"

    # Execute bulk enrollment using `rows` parameter for backwards compatibility
    exec_req = BulkEnrollmentExecuteRequest(
        academic_term_id=term.id,
        class_section_id=sec.id,
        rows=[
            BulkStudentEnrollmentRow(institutional_id="STU-001", full_name="Alice Student", email="stu001@example.com"),
            BulkStudentEnrollmentRow(institutional_id="STU-002", full_name="Bob Student", email="stu002@example.com"),
        ],
    )
    exec_res = await enrollment_service.bulk_enroll_execute(exec_req)
    assert exec_res.success is True
    assert exec_res.enrolled_count == 2
    assert exec_res.created_enrollments_count == 2
    assert exec_res.failed_count == 0

    # Also test single student enrollment via admin API handler logic
    single_req = BulkEnrollmentExecuteRequest(
        academic_term_id=term.id,
        class_section_id=sec.id,
        students=[
            BulkStudentEnrollmentRow(
                institutional_id="STU-005",
                full_name="Single Enrolled Student",
                email="stu005@example.com",
            )
        ],
    )
    single_res = await enrollment_service.bulk_enroll_execute(single_req)
    assert single_res.success is True
    assert single_res.enrolled_count == 1

    # Verify section roster
    roster = await enrollment_service.get_section_roster(sec.id)
    assert roster.total_enrolled == 3
    assert roster.active_count == 3
    inst_ids = {s.institutional_id for s in roster.students}
    assert "STU-001" in inst_ids
    assert "STU-002" in inst_ids
    assert "STU-005" in inst_ids


@pytest.mark.asyncio
async def test_timetable_conflict_prevention(db_session: AsyncSession):
    """Verify conflict detection: section conflict, room conflict, and faculty conflict."""
    dept = Department(institution_id=DEFAULT_INSTITUTION_ID, code=f"DEPT_{uuid.uuid4().hex[:6]}", name="Dept")
    db_session.add(dept)
    await db_session.flush()

    term = AcademicTerm(
        institution_id=DEFAULT_INSTITUTION_ID,
        code=f"TERM_{uuid.uuid4().hex[:6]}",
        name="Term",
        academic_year="2026-27",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
    )
    db_session.add(term)
    await db_session.flush()

    sec1 = ClassSection(institution_id=DEFAULT_INSTITUTION_ID, section_code="CSE-A", department_id=dept.id, academic_term_id=term.id, cohort_year=2026)
    sec2 = ClassSection(institution_id=DEFAULT_INSTITUTION_ID, section_code="CSE-B", department_id=dept.id, academic_term_id=term.id, cohort_year=2026)
    db_session.add_all([sec1, sec2])

    subj1 = Subject(institution_id=DEFAULT_INSTITUTION_ID, code=f"CS_{uuid.uuid4().hex[:6]}", name="Subj 1", department_id=dept.id, credits=3)
    subj2 = Subject(institution_id=DEFAULT_INSTITUTION_ID, code=f"CS_{uuid.uuid4().hex[:6]}", name="Subj 2", department_id=dept.id, credits=3)
    db_session.add_all([subj1, subj2])

    fac = make_test_user(f"fac_{uuid.uuid4().hex[:6]}@example.com", "Dr. Smith", UserRole.FACULTY)
    admin = make_test_user(f"adm_{uuid.uuid4().hex[:6]}@example.com", "Admin", UserRole.ADMIN)
    db_session.add_all([fac, admin])
    await db_session.flush()

    # Teaching assignments
    ta1 = TeachingAssignment(institution_id=DEFAULT_INSTITUTION_ID, faculty_user_id=fac.id, class_section_id=sec1.id, subject_id=subj1.id, academic_term_id=term.id, created_by_user_id=admin.id)
    ta2 = TeachingAssignment(institution_id=DEFAULT_INSTITUTION_ID, faculty_user_id=fac.id, class_section_id=sec2.id, subject_id=subj2.id, academic_term_id=term.id, created_by_user_id=admin.id)
    db_session.add_all([ta1, ta2])
    await db_session.flush()

    # Academic periods
    period_p1 = (await db_session.execute(select(AcademicPeriod).where(AcademicPeriod.period_number == 1))).scalar_one_or_none()
    if not period_p1:
        period_p1 = AcademicPeriod(
            institution_id=DEFAULT_INSTITUTION_ID,
            period_number=1,
            name="Period 1",
            start_time=time(9, 0),
            end_time=time(10, 0),
            is_break=False,
        )
        db_session.add(period_p1)

    period_break = (await db_session.execute(select(AcademicPeriod).where(AcademicPeriod.period_number == 4))).scalar_one_or_none()
    if not period_break:
        period_break = AcademicPeriod(
            institution_id=DEFAULT_INSTITUTION_ID,
            period_number=4,
            name="Lunch Break",
            start_time=time(12, 0),
            end_time=time(13, 0),
            is_break=True,
        )
        db_session.add(period_break)
    await db_session.flush()

    tt_service = TimetableService(db_session)

    # 1. Successful scheduling: sec1 on Monday (day=1) Period 1 Room 101
    entry1 = await tt_service.create_timetable_entry(
        TimetableEntryCreate(
            academic_term_id=term.id,
            class_section_id=sec1.id,
            teaching_assignment_id=ta1.id,
            academic_period_id=period_p1.id,
            day_of_week=1,
            room_number="Room-101",
        )
    )
    assert entry1.id is not None

    # 2. Scheduling during break period must be rejected
    with pytest.raises(EligibilityError, match="break period"):
        await tt_service.create_timetable_entry(
            TimetableEntryCreate(
                academic_term_id=term.id,
                class_section_id=sec1.id,
                teaching_assignment_id=ta1.id,
                academic_period_id=period_break.id,
                day_of_week=1,
                room_number="Room-101",
            )
        )

    # 3. Section conflict: sec1 cannot have another class on Monday Period 1
    with pytest.raises(EligibilityError, match="already has a class scheduled"):
        await tt_service.create_timetable_entry(
            TimetableEntryCreate(
                academic_term_id=term.id,
                class_section_id=sec1.id,
                teaching_assignment_id=ta1.id,
                academic_period_id=period_p1.id,
                day_of_week=1,
                room_number="Room-102",
            )
        )

    # 4. Faculty conflict: Dr. Smith cannot teach sec2 on Monday Period 1
    with pytest.raises(EligibilityError, match="already teaching another class"):
        await tt_service.create_timetable_entry(
            TimetableEntryCreate(
                academic_term_id=term.id,
                class_section_id=sec2.id,
                teaching_assignment_id=ta2.id,
                academic_period_id=period_p1.id,
                day_of_week=1,
                room_number="Room-202",
            )
        )

    # 5. Room conflict: Room-101 is booked on Monday Period 1
    fac3 = make_test_user(f"fac3_{uuid.uuid4().hex[:6]}@example.com", "Dr. Gamma", UserRole.FACULTY)
    db_session.add(fac3)
    await db_session.flush()
    ta3 = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=fac3.id,
        class_section_id=sec2.id,
        subject_id=subj2.id,
        academic_term_id=term.id,
        teaching_group="LAB_B",
        created_by_user_id=admin.id,
    )
    db_session.add(ta3)
    await db_session.flush()

    with pytest.raises(EligibilityError, match="already occupied"):
        await tt_service.create_timetable_entry(
            TimetableEntryCreate(
                academic_term_id=term.id,
                class_section_id=sec2.id,
                teaching_assignment_id=ta3.id,
                academic_period_id=period_p1.id,
                day_of_week=1,
                room_number="Room-101",
            )
        )


@pytest.mark.asyncio
async def test_faculty_today_schedule_and_substitute_delegation(db_session: AsyncSession):
    """Verify faculty today's schedule includes both direct classes and active delegations."""
    dept = Department(institution_id=DEFAULT_INSTITUTION_ID, code=f"DEPT_{uuid.uuid4().hex[:6]}", name="Dept")
    db_session.add(dept)
    await db_session.flush()

    term = AcademicTerm(
        institution_id=DEFAULT_INSTITUTION_ID,
        code=f"TERM_{uuid.uuid4().hex[:6]}",
        name="Term",
        academic_year="2026-27",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
    )
    db_session.add(term)
    await db_session.flush()

    sec = ClassSection(institution_id=DEFAULT_INSTITUTION_ID, section_code="CSE-X", department_id=dept.id, academic_term_id=term.id, cohort_year=2026)
    subj = Subject(institution_id=DEFAULT_INSTITUTION_ID, code=f"CS_{uuid.uuid4().hex[:6]}", name="Algorithms", department_id=dept.id, credits=3)
    db_session.add_all([sec, subj])

    regular_fac = make_test_user(f"reg_{uuid.uuid4().hex[:6]}@example.com", "Regular Prof", UserRole.FACULTY)
    sub_fac = make_test_user(f"sub_{uuid.uuid4().hex[:6]}@example.com", "Substitute Prof", UserRole.FACULTY)
    admin = make_test_user(f"adm_{uuid.uuid4().hex[:6]}@example.com", "Admin", UserRole.ADMIN)
    db_session.add_all([regular_fac, sub_fac, admin])
    await db_session.flush()

    ta = TeachingAssignment(institution_id=DEFAULT_INSTITUTION_ID, faculty_user_id=regular_fac.id, class_section_id=sec.id, subject_id=subj.id, academic_term_id=term.id, created_by_user_id=admin.id)
    db_session.add(ta)
    await db_session.flush()

    # Active delegation to substitute professor
    today = date.today()
    delegation = SubstituteDelegation(
        institution_id=DEFAULT_INSTITUTION_ID,
        teaching_assignment_id=ta.id,
        regular_faculty_user_id=regular_fac.id,
        substitute_faculty_user_id=sub_fac.id,
        start_date=today - timedelta(days=1),
        end_date=today + timedelta(days=2),
        delegation_reason="Conference travel",
        status=DelegationStatus.ACTIVE,
        created_by_user_id=admin.id,
    )
    db_session.add(delegation)

    p1 = (await db_session.execute(select(AcademicPeriod).where(AcademicPeriod.period_number == 1))).scalar_one_or_none()
    if not p1:
        p1 = AcademicPeriod(
            institution_id=DEFAULT_INSTITUTION_ID,
            period_number=1,
            name="P1",
            start_time=time(9, 0),
            end_time=time(10, 0),
            is_break=False,
        )
        db_session.add(p1)
        await db_session.flush()

    tt = TimetableEntry(
        institution_id=DEFAULT_INSTITUTION_ID,
        academic_term_id=term.id,
        class_section_id=sec.id,
        teaching_assignment_id=ta.id,
        academic_period_id=p1.id,
        day_of_week=today.isoweekday(),
        room_number="LH-101",
        is_active=True,
    )
    db_session.add(tt)
    await db_session.flush()

    tt_service = TimetableService(db_session)

    # Query schedule for substitute faculty
    sub_schedule = await tt_service.get_faculty_today_schedule(sub_fac.id, target_date=today)
    assert len(sub_schedule) == 1
    assert sub_schedule[0]["is_delegated"] is True
    assert sub_schedule[0]["regular_faculty_name"] == "Regular Prof"
    assert sub_schedule[0]["room_number"] == "LH-101"
    assert sub_schedule[0]["subject_name"] == "Algorithms"
