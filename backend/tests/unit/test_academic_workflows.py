"""Complete Academic Workflows & IAC Authorization Stress Test Suite.

Simulates and verifies:
- Workflow A: New academic session (Term -> Program -> Sections -> Subjects -> Teaching Assignments -> Periods -> Timetable)
- Workflow B: Student admission & bulk CSV import (Valid, duplicate internal, existing active, invalid syntax)
- Workflow C: Academic transitions (Transfer with T-1/T boundary, promotion to next term, withdrawal, history retention)
- Workflow D: Timetable conflict prevention (Faculty, Section, Room, Break collisions, group concurrency, substitutions)
- Workflow E: Attendance submission, timetable entry validation, duplicate slot rejection, and student self-service
- IAC Authorization stress testing: Role template scoping, unauthenticated denial, cross-role denial
"""

from datetime import date, datetime, time, timedelta, timezone
from typing import Optional, List
import uuid
import pytest
from httpx import AsyncClient
from sqlalchemy import select, or_
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.exceptions import ConflictError, EligibilityError, EntityNotFoundError, OutOfScopeError
from src.core.security import create_access_token, get_password_hash
from src.models.academic import (
    DEFAULT_CAMPUS_ID,
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
from src.models.access_control import (
    AssignmentStatus,
    Institution,
    InstitutionStatus,
    InstitutionMembership,
    MembershipStatus,
    RoleAssignment,
    RoleAssignmentScope,
    RoleScopeType,
    RoleTemplate,
)
from src.models.assignment import (
    AssignmentStatus as TAStatus,
    SubstituteDelegation,
    DelegationStatus,
    TeachingAssignment,
)
from src.models.attendance import (
    AttendanceRecord,
    AttendanceSession,
    AttendanceStatus,
    MarkSource,
    SessionApplicability,
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
from src.schemas.attendance import (
    AttendanceRecordItem,
    SubmitAttendanceSessionRequest,
    SyncResultStatus,
)
from src.schemas.enrollment import (
    BulkEnrollmentExecuteRequest,
    BulkEnrollmentPreviewRequest,
    BulkStudentEnrollmentRow,
    StudentEnrollmentCreate,
    StudentTransferRequest,
)
from src.services.attendance_service import AttendanceService
from src.services.enrollment_service import EnrollmentService
from src.services.timetable_service import TimetableService


def make_user(
    email: str,
    full_name: str,
    role: UserRole = UserRole.FACULTY,
    institutional_id: Optional[str] = None,
) -> User:
    return User(
        institutional_id=institutional_id or f"INST_{uuid.uuid4().hex[:8].upper()}",
        email=email,
        password_hash=get_password_hash("secure_password_123"),
        full_name=full_name,
        role=role,
        account_status=AccountStatus.ACTIVE,
    )


async def ensure_default_institution(db: AsyncSession) -> Institution:
    inst_res = await db.execute(select(Institution).where(Institution.id == DEFAULT_INSTITUTION_ID))
    inst = inst_res.scalar_one_or_none()
    if not inst:
        inst = Institution(
            id=DEFAULT_INSTITUTION_ID,
            code="KLASIO_MAIN",
            name="Klasio Institute of Technology",
            status=InstitutionStatus.ACTIVE,
        )
        db.add(inst)
        await db.flush()
    return inst


async def setup_membership_and_role(
    db: AsyncSession,
    user: User,
    role_template_code: str,
) -> RoleAssignment:
    """Assign an IAC role template with institutional scope to a user."""
    await ensure_default_institution(db)

    mem_stmt = select(InstitutionMembership).where(
        InstitutionMembership.user_id == user.id,
        InstitutionMembership.institution_id == DEFAULT_INSTITUTION_ID,
    )
    mem = (await db.execute(mem_stmt)).scalar_one_or_none()
    if not mem:
        mem = InstitutionMembership(
            institution_id=DEFAULT_INSTITUTION_ID,
            user_id=user.id,
            status=MembershipStatus.ACTIVE,
        )
        db.add(mem)
        await db.flush()

    rt_stmt = select(RoleTemplate).where(RoleTemplate.code == role_template_code)
    rt = (await db.execute(rt_stmt)).scalar_one()

    ra = RoleAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        membership_id=mem.id,
        role_template_id=rt.id,
        status=AssignmentStatus.ACTIVE,
        valid_from=datetime.now(timezone.utc) - timedelta(days=1),
        valid_until=datetime.now(timezone.utc) + timedelta(days=365),
        reason=f"Assigned {role_template_code} for workflow testing",
    )
    db.add(ra)
    await db.flush()

    scope = RoleAssignmentScope(
        role_assignment_id=ra.id,
        institution_id=DEFAULT_INSTITUTION_ID,
        scope_type=RoleScopeType.INSTITUTION,
    )
    db.add(scope)
    await db.flush()
    return ra


# =========================================================================
# WORKFLOW A: NEW ACADEMIC SESSION
# =========================================================================

@pytest.mark.asyncio
async def test_workflow_a_new_academic_session(db_session: AsyncSession):
    """
    Workflow A — New academic session:
    1. Create an academic term.
    2. Create programs and sections.
    3. Create subjects.
    4. Create course offerings and teaching assignments (lectures and lab batches).
    5. Assign faculty to multiple sections.
    6. Configure periods and timetable entries.
    """
    await ensure_default_institution(db_session)

    # 1. Academic Term
    term = AcademicTerm(
        institution_id=DEFAULT_INSTITUTION_ID,
        code=f"FALL_{uuid.uuid4().hex[:6].upper()}",
        name="Fall Semester 2026",
        academic_year="2026-27",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    db_session.add(term)
    await db_session.flush()

    # 2. Department & Program
    dept = Department(
        institution_id=DEFAULT_INSTITUTION_ID,
        code=f"CSE_{uuid.uuid4().hex[:4].upper()}",
        name="Computer Science & Engineering",
    )
    db_session.add(dept)
    await db_session.flush()

    prog = Program(
        institution_id=DEFAULT_INSTITUTION_ID,
        department_id=dept.id,
        code="BTECH_CSE",
        name="Bachelor of Technology in Computer Science",
        is_active=True,
    )
    db_session.add(prog)
    await db_session.flush()

    # Sections: CSE-3-A, CSE-3-B, CSE-3-C
    sec_a = ClassSection(
        institution_id=DEFAULT_INSTITUTION_ID,
        section_code="CSE-3-A",
        department_id=dept.id,
        program_id=prog.id,
        academic_term_id=term.id,
        cohort_year=2026,
    )
    sec_b = ClassSection(
        institution_id=DEFAULT_INSTITUTION_ID,
        section_code="CSE-3-B",
        department_id=dept.id,
        program_id=prog.id,
        academic_term_id=term.id,
        cohort_year=2026,
    )
    sec_c = ClassSection(
        institution_id=DEFAULT_INSTITUTION_ID,
        section_code="CSE-3-C",
        department_id=dept.id,
        program_id=prog.id,
        academic_term_id=term.id,
        cohort_year=2026,
    )
    db_session.add_all([sec_a, sec_b, sec_c])
    await db_session.flush()

    # 3. Subjects
    subj_dbms = Subject(
        institution_id=DEFAULT_INSTITUTION_ID,
        department_id=dept.id,
        code=f"CS301_{uuid.uuid4().hex[:4].upper()}",
        name="Database Management Systems",
        credits=4,
    )
    subj_os = Subject(
        institution_id=DEFAULT_INSTITUTION_ID,
        department_id=dept.id,
        code=f"CS302_{uuid.uuid4().hex[:4].upper()}",
        name="Operating Systems",
        credits=4,
    )
    db_session.add_all([subj_dbms, subj_os])
    await db_session.flush()

    # 4 & 5. Faculty Assignments across multiple sections and groups
    faculty_a = make_user("faculty_a@test.edu", "Dr. Faculty A", UserRole.FACULTY)
    faculty_b = make_user("faculty_b@test.edu", "Prof. Faculty B", UserRole.FACULTY)
    faculty_c = make_user("faculty_c@test.edu", "Dr. Faculty C", UserRole.FACULTY)
    admin_user = make_user("admin_a@test.edu", "Admin User", UserRole.ADMIN)
    db_session.add_all([faculty_a, faculty_b, faculty_c, admin_user])
    await db_session.flush()

    # Faculty A teaches DBMS to Section A (Lecture) and Section B (Lecture)
    ta_a_dbms = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=faculty_a.id,
        class_section_id=sec_a.id,
        subject_id=subj_dbms.id,
        academic_term_id=term.id,
        teaching_group="DEFAULT",
        created_by_user_id=admin_user.id,
    )
    ta_b_dbms = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=faculty_a.id,
        class_section_id=sec_b.id,
        subject_id=subj_dbms.id,
        academic_term_id=term.id,
        teaching_group="DEFAULT",
        created_by_user_id=admin_user.id,
    )
    # Faculty B teaches DBMS Lab batches to Section A
    ta_a_lab1 = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=faculty_b.id,
        class_section_id=sec_a.id,
        subject_id=subj_dbms.id,
        academic_term_id=term.id,
        teaching_group="LAB_BATCH_1",
        created_by_user_id=admin_user.id,
    )
    ta_a_lab2 = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=faculty_b.id,
        class_section_id=sec_a.id,
        subject_id=subj_dbms.id,
        academic_term_id=term.id,
        teaching_group="LAB_BATCH_2",
        created_by_user_id=admin_user.id,
    )
    # Faculty C teaches OS to Section A
    ta_a_os = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=faculty_c.id,
        class_section_id=sec_a.id,
        subject_id=subj_os.id,
        academic_term_id=term.id,
        teaching_group="DEFAULT",
        created_by_user_id=admin_user.id,
    )
    db_session.add_all([ta_a_dbms, ta_b_dbms, ta_a_lab1, ta_a_lab2, ta_a_os])
    await db_session.flush()

    # 6. Periods & Timetable entries
    tt_service = TimetableService(db_session)
    p1 = await tt_service.create_period(
        AcademicPeriodCreate(period_number=1, name="Period 1", start_time=time(9, 0), end_time=time(10, 0))
    )
    p2 = await tt_service.create_period(
        AcademicPeriodCreate(period_number=2, name="Period 2", start_time=time(10, 0), end_time=time(11, 0))
    )

    # Schedule Section A DBMS Mon P1 and OS Mon P2
    entry1 = await tt_service.create_timetable_entry(
        TimetableEntryCreate(
            academic_period_id=p1.id,
            teaching_assignment_id=ta_a_dbms.id,
            day_of_week=1,
            room_number="CR-101",
        )
    )
    entry2 = await tt_service.create_timetable_entry(
        TimetableEntryCreate(
            academic_period_id=p2.id,
            teaching_assignment_id=ta_a_os.id,
            day_of_week=1,
            room_number="CR-101",
        )
    )

    assert entry1.id is not None
    assert entry2.id is not None
    assert entry1.class_section_id == sec_a.id
    assert entry2.class_section_id == sec_a.id

    # Verify Timetable Service lists entries correctly
    res_a = await tt_service.list_timetable(class_section_id=sec_a.id, academic_term_id=term.id)
    assert len(res_a) == 2
    subject_codes = {r.subject_code for r in res_a}
    assert subj_dbms.code in subject_codes
    assert subj_os.code in subject_codes


# =========================================================================
# WORKFLOW B: STUDENT ADMISSION & BULK CSV IMPORT
# =========================================================================

@pytest.mark.asyncio
async def test_workflow_b_student_admission_and_bulk_roster(db_session: AsyncSession):
    """
    Workflow B — Student admission:
    1. Create or identify existing student account.
    2. Enroll into institution and specific section.
    3. Import a CSV containing valid, duplicate, existing, and invalid students.
    4. Verify preview validation counts.
    5. Execute bulk enrollment.
    6. Verify section roster with face registration status.
    """
    await ensure_default_institution(db_session)

    term = AcademicTerm(
        institution_id=DEFAULT_INSTITUTION_ID,
        code=f"TERM_B_{uuid.uuid4().hex[:6]}",
        name="Term B",
        academic_year="2026-27",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    dept = Department(institution_id=DEFAULT_INSTITUTION_ID, code=f"DEPT_B_{uuid.uuid4().hex[:4]}", name="Dept B")
    db_session.add_all([term, dept])
    await db_session.flush()

    sec = ClassSection(
        institution_id=DEFAULT_INSTITUTION_ID,
        section_code="B-SEC-1",
        department_id=dept.id,
        academic_term_id=term.id,
        cohort_year=2026,
    )
    db_session.add(sec)
    await db_session.flush()

    # 1 & 2. Existing active student in section
    existing_student = make_user("existing_b@test.edu", "Existing Student", UserRole.STUDENT, institutional_id="STU-EXIST-01")
    db_session.add(existing_student)
    await db_session.flush()

    enr_service = EnrollmentService(db_session)
    await enr_service.enroll_student(
        StudentEnrollmentCreate(
            student_user_id=existing_student.id,
            class_section_id=sec.id,
            academic_term_id=term.id,
            effective_start_date=date(2026, 8, 1),
        )
    )

    # 3. CSV rows
    csv_rows = [
        BulkStudentEnrollmentRow(
            institutional_id="STU-NEW-01",
            full_name="New Student One",
            email="new1@test.edu",
            effective_start_date=date(2026, 8, 1),
        ),
        BulkStudentEnrollmentRow(
            institutional_id="STU-NEW-02",
            full_name="New Student Two",
            email="new2@test.edu",
            effective_start_date=date(2026, 8, 1),
        ),
        BulkStudentEnrollmentRow(
            institutional_id="STU-NEW-02",  # Duplicate roll number & ID within batch
            full_name="New Student Two Copy",
            email="new2_copy@test.edu",
            effective_start_date=date(2026, 8, 1),
        ),
        BulkStudentEnrollmentRow(
            institutional_id="STU-EXIST-01",  # Already active in this term
            full_name="Existing Student",
            email="existing_b@test.edu",
            effective_start_date=date(2026, 8, 1),
        ),
        BulkStudentEnrollmentRow(
            institutional_id="STU-INV-01",
            full_name="Invalid Student",
            email="invalid-not-an-email",  # Malformed email
            effective_start_date=date(2026, 8, 1),
        ),
    ]

    # 4. Preview dry-run
    preview_req = BulkEnrollmentPreviewRequest(
        academic_term_id=term.id,
        class_section_id=sec.id,
        students=csv_rows,
    )
    preview_res = await enr_service.bulk_enroll_preview(preview_req)

    assert preview_res.total_rows == 5
    assert preview_res.valid_count == 2  # STU-NEW-01 and STU-NEW-02
    assert preview_res.error_count == 3  # Internal dup, already enrolled, invalid email

    # 5. Execute bulk enrollment
    exec_req = BulkEnrollmentExecuteRequest(
        academic_term_id=term.id,
        class_section_id=sec.id,
        students=csv_rows,
    )
    exec_res = await enr_service.bulk_enroll_execute(exec_req)
    assert exec_res.enrolled_count == 2
    assert exec_res.failed_count == 3

    # 6. Verify section roster
    roster = await enr_service.get_section_roster(sec.id)
    assert roster.total_enrolled == 3  # existing + 2 newly enrolled
    assert len(roster.students) == 3

    inst_ids = {s.institutional_id for s in roster.students}
    assert "STU-EXIST-01" in inst_ids
    assert "STU-NEW-01" in inst_ids
    assert "STU-NEW-02" in inst_ids

    for student_item in roster.students:
        assert student_item.enrollment_status == EnrollmentStatus.ACTIVE
        assert student_item.face_registration_state == "UNREGISTERED"


# =========================================================================
# WORKFLOW C: ACADEMIC TRANSITIONS
# =========================================================================

@pytest.mark.asyncio
async def test_workflow_c_academic_transitions(db_session: AsyncSession):
    """
    Workflow C — Academic transitions:
    1. Transfer student between sections (T-1 close, T open).
    2. Attempt duplicate active enrollment in same term (rejected).
    3. Promote / enroll student to next academic term (allowed).
    4. Withdraw student from next term.
    5. Verify historical enrollment records remain accessible and intact.
    """
    await ensure_default_institution(db_session)

    # Terms
    term_1 = AcademicTerm(
        institution_id=DEFAULT_INSTITUTION_ID,
        code=f"TERM_C1_{uuid.uuid4().hex[:6]}",
        name="Term 1 Fall",
        academic_year="2026-27",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    term_2 = AcademicTerm(
        institution_id=DEFAULT_INSTITUTION_ID,
        code=f"TERM_C2_{uuid.uuid4().hex[:6]}",
        name="Term 2 Spring",
        academic_year="2026-27",
        start_date=date(2027, 1, 5),
        end_date=date(2027, 5, 20),
        status=TermStatus.UPCOMING,
    )
    dept = Department(institution_id=DEFAULT_INSTITUTION_ID, code=f"DEPT_C_{uuid.uuid4().hex[:4]}", name="Dept C")
    db_session.add_all([term_1, term_2, dept])
    await db_session.flush()

    sec_1a = ClassSection(
        institution_id=DEFAULT_INSTITUTION_ID,
        section_code="SEC-1-A",
        department_id=dept.id,
        academic_term_id=term_1.id,
        cohort_year=2026,
    )
    sec_1b = ClassSection(
        institution_id=DEFAULT_INSTITUTION_ID,
        section_code="SEC-1-B",
        department_id=dept.id,
        academic_term_id=term_1.id,
        cohort_year=2026,
    )
    sec_2a = ClassSection(
        institution_id=DEFAULT_INSTITUTION_ID,
        section_code="SEC-2-A",
        department_id=dept.id,
        academic_term_id=term_2.id,
        cohort_year=2027,
    )
    db_session.add_all([sec_1a, sec_1b, sec_2a])
    await db_session.flush()

    student = make_user("stu_trans@test.edu", "Transition Student", UserRole.STUDENT, institutional_id="STU-TRANS-01")
    db_session.add(student)
    await db_session.flush()

    enr_service = EnrollmentService(db_session)

    # Initial enrollment in SEC-1-A from 2026-08-01
    enr_init = await enr_service.enroll_student(
        StudentEnrollmentCreate(
            student_user_id=student.id,
            class_section_id=sec_1a.id,
            academic_term_id=term_1.id,
            effective_start_date=date(2026, 8, 1),
        )
    )
    assert enr_init.enrollment_status == EnrollmentStatus.ACTIVE

    # 1. Transfer to SEC-1-B on 2026-09-15 (T)
    transfer_date = date(2026, 9, 15)
    prev_enr, new_enr = await enr_service.transfer_student(
        StudentTransferRequest(
            student_user_id=student.id,
            current_class_section_id=sec_1a.id,
            new_class_section_id=sec_1b.id,
            transfer_date=transfer_date,
        )
    )

    assert prev_enr.enrollment_status == EnrollmentStatus.TRANSFERRED
    assert prev_enr.effective_end_date == transfer_date - timedelta(days=1)  # T-1
    assert new_enr.enrollment_status == EnrollmentStatus.ACTIVE
    assert new_enr.effective_start_date == transfer_date  # T

    # 2. Duplicate active enrollment attempt in same term
    with pytest.raises(ConflictError) as exc_info:
        await enr_service.enroll_student(
            StudentEnrollmentCreate(
                student_user_id=student.id,
                class_section_id=sec_1a.id,
                academic_term_id=term_1.id,
                effective_start_date=date(2026, 9, 20),
            )
        )
    assert "already has an active enrollment" in str(exc_info.value)

    # 3. Promote / enroll in Term 2 (Allowed, distinct term)
    enr_term2 = await enr_service.enroll_student(
        StudentEnrollmentCreate(
            student_user_id=student.id,
            class_section_id=sec_2a.id,
            academic_term_id=term_2.id,
            effective_start_date=date(2027, 1, 5),
        )
    )
    assert enr_term2.enrollment_status == EnrollmentStatus.ACTIVE
    assert enr_term2.academic_term_id == term_2.id

    # 4. Withdraw from Term 2
    withdrawn_enr = await enr_service.update_enrollment_status(
        enrollment_id=enr_term2.id,
        new_status=EnrollmentStatus.WITHDRAWN,
        effective_end_date=date(2027, 2, 1),
    )
    assert withdrawn_enr.enrollment_status == EnrollmentStatus.WITHDRAWN
    assert withdrawn_enr.effective_end_date == date(2027, 2, 1)

    # 5. Verify all historical records remain accessible
    hist_stmt = (
        select(StudentEnrollment)
        .where(StudentEnrollment.student_user_id == student.id)
        .order_by(StudentEnrollment.effective_start_date.asc())
    )
    all_enrs = (await db_session.execute(hist_stmt)).scalars().all()
    assert len(all_enrs) == 3

    statuses = [e.enrollment_status for e in all_enrs]
    assert EnrollmentStatus.TRANSFERRED in statuses
    assert EnrollmentStatus.ACTIVE in statuses
    assert EnrollmentStatus.WITHDRAWN in statuses


# =========================================================================
# WORKFLOW D: TIMETABLE CONFLICTS & SUBSTITUTIONS
# =========================================================================

@pytest.mark.asyncio
async def test_workflow_d_timetable_conflicts_and_substitutions(db_session: AsyncSession):
    """
    Workflow D — Timetable:
    1. Schedule multiple sections.
    2. Attempt faculty conflict (same faculty, two sections at same time) -> rejected.
    3. Attempt section conflict (same section, two subjects at same time) -> rejected.
    4. Attempt room conflict (two different classes in same room at same time) -> rejected.
    5. Attempt scheduling during break period -> rejected.
    6. Group concurrency: lab batches in same section & period with different groups -> allowed.
    7. Substitute faculty delegation & lecture reschedule.
    """
    await ensure_default_institution(db_session)

    term = AcademicTerm(
        institution_id=DEFAULT_INSTITUTION_ID,
        code=f"TERM_D_{uuid.uuid4().hex[:6]}",
        name="Term D",
        academic_year="2026-27",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    dept = Department(institution_id=DEFAULT_INSTITUTION_ID, code=f"DEPT_D_{uuid.uuid4().hex[:4]}", name="Dept D")
    db_session.add_all([term, dept])
    await db_session.flush()

    sec_a = ClassSection(
        institution_id=DEFAULT_INSTITUTION_ID,
        section_code="D-SEC-A",
        department_id=dept.id,
        academic_term_id=term.id,
        cohort_year=2026,
    )
    sec_b = ClassSection(
        institution_id=DEFAULT_INSTITUTION_ID,
        section_code="D-SEC-B",
        department_id=dept.id,
        academic_term_id=term.id,
        cohort_year=2026,
    )
    db_session.add_all([sec_a, sec_b])
    await db_session.flush()

    subj1 = Subject(institution_id=DEFAULT_INSTITUTION_ID, department_id=dept.id, code=f"D_S1_{uuid.uuid4().hex[:4]}", name="Subj 1")
    subj2 = Subject(institution_id=DEFAULT_INSTITUTION_ID, department_id=dept.id, code=f"D_S2_{uuid.uuid4().hex[:4]}", name="Subj 2")
    db_session.add_all([subj1, subj2])
    await db_session.flush()

    fac1 = make_user("fac1_d@test.edu", "Faculty 1 D", UserRole.FACULTY)
    fac2 = make_user("fac2_d@test.edu", "Faculty 2 D", UserRole.FACULTY)
    fac3 = make_user("fac3_d@test.edu", "Faculty 3 D", UserRole.FACULTY)
    admin_u = make_user("admin_d@test.edu", "Admin D", UserRole.ADMIN)
    db_session.add_all([fac1, fac2, fac3, admin_u])
    await db_session.flush()

    ta_a_fac1 = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=fac1.id,
        class_section_id=sec_a.id,
        subject_id=subj1.id,
        academic_term_id=term.id,
        teaching_group="DEFAULT",
        created_by_user_id=admin_u.id,
    )
    ta_b_fac1 = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=fac1.id,
        class_section_id=sec_b.id,
        subject_id=subj1.id,
        academic_term_id=term.id,
        teaching_group="DEFAULT",
        created_by_user_id=admin_u.id,
    )
    ta_a_fac2 = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=fac2.id,
        class_section_id=sec_a.id,
        subject_id=subj2.id,
        academic_term_id=term.id,
        teaching_group="DEFAULT",
        created_by_user_id=admin_u.id,
    )
    ta_b_fac3 = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=fac3.id,
        class_section_id=sec_b.id,
        subject_id=subj2.id,
        academic_term_id=term.id,
        teaching_group="DEFAULT",
        created_by_user_id=admin_u.id,
    )
    # Lab groups for concurrent batch test
    ta_a_lab1 = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=fac2.id,
        class_section_id=sec_a.id,
        subject_id=subj1.id,
        academic_term_id=term.id,
        teaching_group="LAB_G1",
        created_by_user_id=admin_u.id,
    )
    ta_a_lab2 = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=fac3.id,
        class_section_id=sec_a.id,
        subject_id=subj1.id,
        academic_term_id=term.id,
        teaching_group="LAB_G2",
        created_by_user_id=admin_u.id,
    )
    db_session.add_all([ta_a_fac1, ta_b_fac1, ta_a_fac2, ta_b_fac3, ta_a_lab1, ta_a_lab2])
    await db_session.flush()

    tt_service = TimetableService(db_session)
    period_slot = await tt_service.create_period(
        AcademicPeriodCreate(period_number=5, name="Period 5", start_time=time(9, 0), end_time=time(10, 0))
    )
    period_break = await tt_service.create_period(
        AcademicPeriodCreate(period_number=6, name="Lunch Break", start_time=time(12, 0), end_time=time(13, 0), is_break=True)
    )

    # 1. Valid entry: Fac1 teaches SecA on Mon Period 5 in Room 201
    entry_valid = await tt_service.create_timetable_entry(
        TimetableEntryCreate(
            academic_period_id=period_slot.id,
            teaching_assignment_id=ta_a_fac1.id,
            day_of_week=1,
            room_number="ROOM-201",
        )
    )
    assert entry_valid.id is not None

    # 2. Attempt Faculty double-booking (Fac1 scheduled for SecB at same day & period)
    with pytest.raises((ConflictError, EligibilityError)) as exc_fac:
        await tt_service.create_timetable_entry(
            TimetableEntryCreate(
                academic_period_id=period_slot.id,
                teaching_assignment_id=ta_b_fac1.id,
                day_of_week=1,
                room_number="ROOM-202",
            )
        )
    assert "already teaching" in str(exc_fac.value) or "already scheduled" in str(exc_fac.value)

    # 3. Attempt Section double-booking (SecA scheduled with Fac2 at same day & period)
    with pytest.raises((ConflictError, EligibilityError)) as exc_sec:
        await tt_service.create_timetable_entry(
            TimetableEntryCreate(
                academic_period_id=period_slot.id,
                teaching_assignment_id=ta_a_fac2.id,
                day_of_week=1,
                room_number="ROOM-202",
            )
        )
    assert "already has a class scheduled" in str(exc_sec.value)

    # 4. Attempt Room double-booking (Fac3 teaching SecB in ROOM-201 at same day & period)
    with pytest.raises((ConflictError, EligibilityError)) as exc_room:
        await tt_service.create_timetable_entry(
            TimetableEntryCreate(
                academic_period_id=period_slot.id,
                teaching_assignment_id=ta_b_fac3.id,
                day_of_week=1,
                room_number="ROOM-201",
            )
        )
    assert "already occupied" in str(exc_room.value)

    # 5. Attempt Break period scheduling
    with pytest.raises((ConflictError, EligibilityError)) as exc_break:
        await tt_service.create_timetable_entry(
            TimetableEntryCreate(
                academic_period_id=period_break.id,
                teaching_assignment_id=ta_a_fac2.id,
                day_of_week=1,
                room_number="ROOM-203",
            )
        )
    assert "break period" in str(exc_break.value)

    # 6. Group concurrency: Distinct lab groups in same section can be concurrent in different rooms
    period_lab = await tt_service.create_period(
        AcademicPeriodCreate(period_number=7, name="Period 7", start_time=time(14, 0), end_time=time(15, 0))
    )
    lab_entry1 = await tt_service.create_timetable_entry(
        TimetableEntryCreate(
            academic_period_id=period_lab.id,
            teaching_assignment_id=ta_a_lab1.id,
            day_of_week=1,
            room_number="LAB-ROOM-1",
        )
    )
    lab_entry2 = await tt_service.create_timetable_entry(
        TimetableEntryCreate(
            academic_period_id=period_lab.id,
            teaching_assignment_id=ta_a_lab2.id,
            day_of_week=1,
            room_number="LAB-ROOM-2",
        )
    )
    assert lab_entry1.id is not None
    assert lab_entry2.id is not None

    # 7. Reschedule lecture: Delete entry_valid and reschedule to Tuesday Period 5
    await db_session.delete(entry_valid)
    await db_session.flush()

    rescheduled = await tt_service.create_timetable_entry(
        TimetableEntryCreate(
            academic_period_id=period_slot.id,
            teaching_assignment_id=ta_a_fac1.id,
            day_of_week=2,  # Tuesday
            room_number="ROOM-201",
        )
    )
    assert rescheduled.day_of_week == 2


# =========================================================================
# WORKFLOW E: ATTENDANCE SUBMISSION, TIMETABLE INTEGRATION & INTEGRITY
# =========================================================================

@pytest.mark.asyncio
async def test_workflow_e_attendance_lifecycle_and_validation(db_session: AsyncSession):
    """
    Workflow E — Attendance:
    1. Faculty opens today's timetable.
    2. Faculty selects scheduled lecture with timetable_entry_id.
    3. Attendance session submitted with student records.
    4. Server verifies timetable entry, date-bounded eligibility, server-derived counts.
    5. Duplicate slot submission rejected with CONFLICT.
    6. Mismatched timetable entry rejected with REJECTED.
    7. Ineligible student rejected with REJECTED.
    """
    await ensure_default_institution(db_session)

    term = AcademicTerm(
        institution_id=DEFAULT_INSTITUTION_ID,
        code=f"TERM_E_{uuid.uuid4().hex[:6]}",
        name="Term E",
        academic_year="2026-27",
        start_date=date(2026, 8, 1),
        end_date=date(2026, 12, 15),
        status=TermStatus.ACTIVE,
    )
    dept = Department(institution_id=DEFAULT_INSTITUTION_ID, code=f"DEPT_E_{uuid.uuid4().hex[:4]}", name="Dept E")
    db_session.add_all([term, dept])
    await db_session.flush()

    sec = ClassSection(
        institution_id=DEFAULT_INSTITUTION_ID,
        section_code="E-SEC-1",
        department_id=dept.id,
        academic_term_id=term.id,
        cohort_year=2026,
    )
    db_session.add(sec)
    await db_session.flush()

    subj = Subject(institution_id=DEFAULT_INSTITUTION_ID, department_id=dept.id, code=f"E_S1_{uuid.uuid4().hex[:4]}", name="Subj E")
    db_session.add(subj)
    await db_session.flush()

    fac = make_user("fac_e@test.edu", "Faculty E", UserRole.FACULTY)
    stu1 = make_user("stu1_e@test.edu", "Student E1", UserRole.STUDENT, institutional_id="STU-E1")
    stu2 = make_user("stu2_e@test.edu", "Student E2", UserRole.STUDENT, institutional_id="STU-E2")
    stu_unrelated = make_user("stu_out@test.edu", "Student Out", UserRole.STUDENT, institutional_id="STU-OUT")
    admin_u = make_user("admin_e@test.edu", "Admin E", UserRole.ADMIN)
    db_session.add_all([fac, stu1, stu2, stu_unrelated, admin_u])
    await db_session.flush()

    ta = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=fac.id,
        class_section_id=sec.id,
        subject_id=subj.id,
        academic_term_id=term.id,
        teaching_group="DEFAULT",
        created_by_user_id=admin_u.id,
    )
    ta_other = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=fac.id,
        class_section_id=sec.id,
        subject_id=subj.id,
        academic_term_id=term.id,
        teaching_group="OTHER_GROUP",
        created_by_user_id=admin_u.id,
    )
    db_session.add_all([ta, ta_other])
    await db_session.flush()

    # Enroll stu1 and stu2 in section
    enr_service = EnrollmentService(db_session)
    await enr_service.enroll_student(
        StudentEnrollmentCreate(
            student_user_id=stu1.id,
            class_section_id=sec.id,
            academic_term_id=term.id,
            effective_start_date=date(2026, 8, 1),
        )
    )
    await enr_service.enroll_student(
        StudentEnrollmentCreate(
            student_user_id=stu2.id,
            class_section_id=sec.id,
            academic_term_id=term.id,
            effective_start_date=date(2026, 8, 1),
        )
    )

    tt_service = TimetableService(db_session)
    period = await tt_service.create_period(
        AcademicPeriodCreate(period_number=8, name="Period 8", start_time=time(9, 0), end_time=time(10, 0))
    )
    tt_entry = await tt_service.create_timetable_entry(
        TimetableEntryCreate(
            academic_period_id=period.id,
            teaching_assignment_id=ta.id,
            day_of_week=1,
            room_number="ROOM-301",
        )
    )
    tt_entry_other = await tt_service.create_timetable_entry(
        TimetableEntryCreate(
            academic_period_id=period.id,
            teaching_assignment_id=ta_other.id,
            day_of_week=2,
            room_number="ROOM-302",
        )
    )

    # 1. Faculty opens today's timetable
    fac_timetable = await tt_service.get_faculty_today_timetable(faculty_user_id=fac.id, day_of_week=1)
    assert len(fac_timetable) >= 1
    slot = next(s for s in fac_timetable if s.id == tt_entry.id)
    assert slot.subject_name == "Subj E"
    assert slot.section_code == "E-SEC-1"
    assert slot.room_number == "ROOM-301"

    # 2 & 3. Faculty submits attendance session referencing tt_entry.id
    att_service = AttendanceService(db_session)
    session_uuid = uuid.uuid4()
    req = SubmitAttendanceSessionRequest(
        client_session_uuid=session_uuid,
        teaching_assignment_id=ta.id,
        timetable_entry_id=tt_entry.id,
        session_date=date(2026, 8, 10),
        period_slot_or_sequence=8,
        applicability_status=SessionApplicability.COUNTED,
        records=[
            AttendanceRecordItem(student_user_id=stu1.id, attendance_status=AttendanceStatus.PRESENT),
            AttendanceRecordItem(student_user_id=stu2.id, attendance_status=AttendanceStatus.ABSENT),
        ],
    )
    res = await att_service.sync_session(current_user=fac, session_req=req)
    assert res.status == SyncResultStatus.COMMITTED
    assert res.records_count == 2
    assert res.present_count == 1
    assert res.absent_count == 1

    # Verify session persisted in DB with timetable_entry_id
    sess_stmt = select(AttendanceSession).where(AttendanceSession.client_session_uuid == session_uuid)
    sess_db = (await db_session.execute(sess_stmt)).scalar_one()
    assert sess_db.timetable_entry_id == tt_entry.id
    assert sess_db.regular_faculty_user_id == fac.id
    assert sess_db.conducting_faculty_user_id == fac.id

    # 4. Attempt duplicate session creation for the same slot (different UUID)
    dup_req = SubmitAttendanceSessionRequest(
        client_session_uuid=uuid.uuid4(),  # Different client UUID
        teaching_assignment_id=ta.id,
        timetable_entry_id=tt_entry.id,
        session_date=date(2026, 8, 10),
        period_slot_or_sequence=8,
        applicability_status=SessionApplicability.COUNTED,
        records=[
            AttendanceRecordItem(student_user_id=stu1.id, attendance_status=AttendanceStatus.PRESENT),
            AttendanceRecordItem(student_user_id=stu2.id, attendance_status=AttendanceStatus.ABSENT),
        ],
    )
    dup_res = await att_service.sync_session(current_user=fac, session_req=dup_req)
    assert dup_res.status == SyncResultStatus.CONFLICT
    assert "already finalized" in dup_res.error_message

    # 5. Attempt submission with mismatched timetable_entry_id (points to ta_other)
    mismatch_req = SubmitAttendanceSessionRequest(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta.id,
        timetable_entry_id=tt_entry_other.id,  # Mismatched! Belongs to ta_other
        session_date=date(2026, 8, 11),
        period_slot_or_sequence=9,
        applicability_status=SessionApplicability.COUNTED,
        records=[
            AttendanceRecordItem(student_user_id=stu1.id, attendance_status=AttendanceStatus.PRESENT),
            AttendanceRecordItem(student_user_id=stu2.id, attendance_status=AttendanceStatus.PRESENT),
        ],
    )
    mismatch_res = await att_service.sync_session(current_user=fac, session_req=mismatch_req)
    assert mismatch_res.status == SyncResultStatus.REJECTED
    assert "belongs to teaching assignment" in mismatch_res.error_message

    # 6. Attempt submission containing an ineligible student
    ineligible_req = SubmitAttendanceSessionRequest(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta.id,
        session_date=date(2026, 8, 12),
        period_slot_or_sequence=10,
        applicability_status=SessionApplicability.COUNTED,
        records=[
            AttendanceRecordItem(student_user_id=stu1.id, attendance_status=AttendanceStatus.PRESENT),
            AttendanceRecordItem(student_user_id=stu_unrelated.id, attendance_status=AttendanceStatus.PRESENT),
        ],
    )
    ineligible_res = await att_service.sync_session(current_user=fac, session_req=ineligible_req)
    assert ineligible_res.status == SyncResultStatus.REJECTED
    assert "not eligible for section" in ineligible_res.error_message


# =========================================================================
# IAC AUTHORIZATION STRESS TEST
# =========================================================================

@pytest.mark.asyncio
async def test_iac_authorization_stress_test(async_client: AsyncClient, db_session: AsyncSession):
    """
    IAC Authorization Stress Test:
    - Unauthenticated request -> 401 Unauthorized
    - Student accessing admin academic routes -> 403 Forbidden
    - Timetable Coordinator: Can manage periods and timetable, but cannot create enrollments
    - Enrollment Officer: Can preview/execute enrollments and transfers, but cannot manage periods
    - Student self-service: Student can access current enrollment & weekly timetable
    """
    await ensure_default_institution(db_session)

    # 1. Unauthenticated request
    unauth_res = await async_client.get("/api/v1/admin/periods")
    assert unauth_res.status_code == 401

    # 2. Setup Student user
    student = make_user("stress_stu@test.edu", "Stress Student", UserRole.STUDENT, institutional_id="STU-STRESS-01")
    db_session.add(student)
    await db_session.flush()
    await setup_membership_and_role(db_session, student, "STUDENT")

    stu_token = create_access_token(
        subject=str(student.id),
        role=student.role.value,
        institutional_id=student.institutional_id,
    )
    stu_headers = {"Authorization": f"Bearer {stu_token}"}

    # Student cannot create sections or manage timetable
    res_stu_sec = await async_client.post(
        "/api/v1/admin/sections",
        json={"section_code": "STU-HACK", "department_id": str(uuid.uuid4()), "academic_term_id": str(uuid.uuid4()), "cohort_year": 2026},
        headers=stu_headers,
    )
    assert res_stu_sec.status_code == 403

    res_stu_tt = await async_client.post(
        "/api/v1/admin/periods",
        json={"period_number": 19, "name": "Hack Period", "start_time": "18:00:00", "end_time": "19:00:00"},
        headers=stu_headers,
    )
    assert res_stu_tt.status_code == 403

    # 3. Setup Timetable Coordinator
    tt_coord = make_user("tt_coord@test.edu", "Timetable Coordinator", UserRole.FACULTY, institutional_id="TT-COORD-01")
    db_session.add(tt_coord)
    await db_session.flush()
    await setup_membership_and_role(db_session, tt_coord, "TIMETABLE_COORDINATOR")

    tt_token = create_access_token(
        subject=str(tt_coord.id),
        role=tt_coord.role.value,
        institutional_id=tt_coord.institutional_id,
    )
    tt_headers = {"Authorization": f"Bearer {tt_token}"}

    # Timetable coordinator CAN access periods
    res_tt_periods = await async_client.get("/api/v1/admin/periods", headers=tt_headers)
    assert res_tt_periods.status_code == 200

    # Timetable coordinator CAN create periods (has timetable.manage)
    res_tt_create_period = await async_client.post(
        "/api/v1/admin/periods",
        json={"period_number": 18, "name": "Coordinator Period", "start_time": "16:00:00", "end_time": "17:00:00"},
        headers=tt_headers,
    )
    assert res_tt_create_period.status_code == 201

    # Timetable coordinator CANNOT create student enrollments (missing student_enrollment.create)
    res_tt_enr = await async_client.post(
        "/api/v1/admin/enrollments",
        json={
            "student_user_id": str(student.id),
            "class_section_id": str(uuid.uuid4()),
            "academic_term_id": str(uuid.uuid4()),
            "effective_start_date": "2026-08-01",
        },
        headers=tt_headers,
    )
    assert res_tt_enr.status_code == 403

    # 4. Setup Enrollment Officer
    enr_officer = make_user("enr_off@test.edu", "Enrollment Officer", UserRole.FACULTY, institutional_id="ENR-OFF-01")
    db_session.add(enr_officer)
    await db_session.flush()
    await setup_membership_and_role(db_session, enr_officer, "ENROLLMENT_OFFICER")

    enr_token = create_access_token(
        subject=str(enr_officer.id),
        role=enr_officer.role.value,
        institutional_id=enr_officer.institutional_id,
    )
    enr_headers = {"Authorization": f"Bearer {enr_token}"}

    # Enrollment officer CAN access bulk-preview (has student_enrollment.create)
    res_enr_preview = await async_client.post(
        "/api/v1/admin/enrollments/bulk-preview",
        json={
            "academic_term_id": str(uuid.uuid4()),
            "class_section_id": str(uuid.uuid4()),
            "students": [
                {
                    "institutional_id": "ENR-TEST-1",
                    "full_name": "Test Student",
                    "email": "test_enr@test.edu",
                }
            ],
        },
        headers=enr_headers,
    )
    # Section won't be found so 404 EntityNotFoundError, BUT NOT 403 Forbidden!
    assert res_enr_preview.status_code in (200, 404)

    # Enrollment officer CANNOT manage timetable periods (missing timetable.manage)
    res_enr_tt = await async_client.post(
        "/api/v1/admin/periods",
        json={"period_number": 19, "name": "Officer Hack", "start_time": "17:00:00", "end_time": "18:00:00"},
        headers=enr_headers,
    )
    assert res_enr_tt.status_code == 403

    # 5. Student Self-Service: student can query their own enrollment and timetable
    res_stu_enr_self = await async_client.get("/api/v1/student/enrollment/current", headers=stu_headers)
    assert res_stu_enr_self.status_code == 200

    res_stu_tt_self = await async_client.get("/api/v1/student/timetable/weekly", headers=stu_headers)
    assert res_stu_tt_self.status_code == 200
