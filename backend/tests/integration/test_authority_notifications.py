import json
import uuid
from datetime import datetime, timezone, timedelta
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.academic import (
    AcademicTerm,
    ClassSection,
    DEFAULT_INSTITUTION_ID,
    Department,
    Program,
    Subject,
    TermStatus,
)
from src.models.access_control import (
    AssignmentStatus,
    Institution,
    InstitutionMembership,
    MembershipStatus,
    Permission,
    RoleAssignment,
    RoleAssignmentScope,
    RoleScopeType,
    RoleTemplate,
)
from src.models.assignment import TeachingAssignment
from src.models.attendance import AttendanceRecord, AttendanceSession, AttendanceStatus
from src.models.notification import Notification, NotificationCategory, NotificationPriority
from src.models.user import AccountStatus, User, UserRole
from src.services.notification_service import NotificationRoutingService
from scripts.seed_access_control import seed_access_control_catalog


@pytest.fixture(autouse=True)
async def seed_catalog_fixture(db_session: AsyncSession):
    await seed_access_control_catalog(db_session)


async def _get_or_create_inst_membership(db: AsyncSession, user_id: uuid.UUID) -> InstitutionMembership:
    res = await db.execute(
        select(InstitutionMembership).where(
            InstitutionMembership.institution_id == DEFAULT_INSTITUTION_ID,
            InstitutionMembership.user_id == user_id,
        )
    )
    mem = res.scalar_one_or_none()
    if not mem:
        mem = InstitutionMembership(
            institution_id=DEFAULT_INSTITUTION_ID,
            user_id=user_id,
            status=MembershipStatus.ACTIVE,
        )
        db.add(mem)
        await db.flush()
    return mem


async def _assign_role_with_scope(
    db: AsyncSession,
    user_id: uuid.UUID,
    role_code: str,
    scope_type: RoleScopeType,
    department_id=None,
    program_id=None,
    class_section_id=None,
):
    mem = await _get_or_create_inst_membership(db, user_id)
    tpl_res = await db.execute(select(RoleTemplate).where(RoleTemplate.code == role_code))
    tpl = tpl_res.scalar_one()

    assignment = RoleAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        membership_id=mem.id,
        role_template_id=tpl.id,
        status=AssignmentStatus.ACTIVE,
        valid_from=datetime.now(timezone.utc) - timedelta(days=1),
    )
    db.add(assignment)
    await db.flush()

    scope = RoleAssignmentScope(
        role_assignment_id=assignment.id,
        institution_id=DEFAULT_INSTITUTION_ID,
        scope_type=scope_type,
        department_id=department_id,
        program_id=program_id,
        class_section_id=class_section_id,
    )
    db.add(scope)
    await db.flush()
    return assignment


@pytest.mark.asyncio
async def test_attendance_amendment_routes_to_all_authorities_and_student(db_session: AsyncSession):
    """
    Authority Matrix Rule 1:
    Finalized attendance amendment notifies:
    - Affected student
    - Regular teaching faculty
    - Conducting faculty if different
    - Scoped HOD / Department Coordinator
    Priority: HIGH, Deduplication guaranteed.
    """
    uid = uuid.uuid4().hex[:6]
    dept_a = Department(institution_id=DEFAULT_INSTITUTION_ID, code=f"CS_{uid}", name="Computer Science")
    dept_b = Department(institution_id=DEFAULT_INSTITUTION_ID, code=f"EE_{uid}", name="Electrical Eng")
    term = AcademicTerm(
        institution_id=DEFAULT_INSTITUTION_ID,
        code=f"T_{uid}",
        name="Term",
        academic_year="2026",
        start_date=datetime.now(timezone.utc).date(),
        end_date=datetime.now(timezone.utc).date() + timedelta(days=90),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([dept_a, dept_b, term])
    await db_session.flush()

    sec = ClassSection(
        institution_id=DEFAULT_INSTITUTION_ID,
        section_code=f"SEC_{uid}",
        department_id=dept_a.id,
        academic_term_id=term.id,
        cohort_year=2024,
    )
    subj = Subject(institution_id=DEFAULT_INSTITUTION_ID, code=f"SUB_{uid}", name="Algorithms", department_id=dept_a.id)
    db_session.add_all([sec, subj])
    await db_session.flush()

    # Users
    student = User(institutional_id=f"S_{uid}", email=f"s_{uid}@inst.edu", password_hash="h", full_name="Student", role=UserRole.STUDENT)
    reg_faculty = User(institutional_id=f"F_REG_{uid}", email=f"freg_{uid}@inst.edu", password_hash="h", full_name="Regular Fac", role=UserRole.FACULTY)
    cond_faculty = User(institutional_id=f"F_COND_{uid}", email=f"fcond_{uid}@inst.edu", password_hash="h", full_name="Conducting Fac", role=UserRole.FACULTY)
    hod_a = User(institutional_id=f"HOD_A_{uid}", email=f"hoda_{uid}@inst.edu", password_hash="h", full_name="HOD CS", role=UserRole.FACULTY)
    hod_b = User(institutional_id=f"HOD_B_{uid}", email=f"hodb_{uid}@inst.edu", password_hash="h", full_name="HOD EE", role=UserRole.FACULTY)
    db_session.add_all([student, reg_faculty, cond_faculty, hod_a, hod_b])
    await db_session.flush()

    # Teaching assignment
    ta = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=reg_faculty.id,
        class_section_id=sec.id,
        subject_id=subj.id,
        academic_term_id=term.id,
        created_by_user_id=reg_faculty.id,
    )
    db_session.add(ta)
    await db_session.flush()

    # Assign Department Coordinator / HOD roles (one in Dept A, one in Dept B)
    await _assign_role_with_scope(
        db_session, hod_a.id, "DEPARTMENT_HEAD_COORDINATOR", RoleScopeType.DEPARTMENT, department_id=dept_a.id
    )
    await _assign_role_with_scope(
        db_session, hod_b.id, "DEPARTMENT_HEAD_COORDINATOR", RoleScopeType.DEPARTMENT, department_id=dept_b.id
    )

    session_id = uuid.uuid4()
    record_id = uuid.uuid4()

    # Dispatch amendment notification
    notifs = await NotificationRoutingService.notify_attendance_amendment(
        db=db_session,
        session_id=session_id,
        record_id=record_id,
        student_user_id=student.id,
        amending_user_id=reg_faculty.id,
        old_status="ABSENT",
        new_status="PRESENT",
        reason="Medical certificate provided and verified by clinic",
        conducting_faculty_user_id=cond_faculty.id,
        teaching_assignment_id=ta.id,
        department_id=dept_a.id,
    )

    notified_uids = {n.user_id for n in notifs}

    # Verify: Student, regular faculty, conducting faculty, HOD of Dept A are all notified
    assert student.id in notified_uids
    assert reg_faculty.id in notified_uids
    assert cond_faculty.id in notified_uids
    assert hod_a.id in notified_uids
    # Verify: HOD of Dept B is strictly NOT notified (department isolation)
    assert hod_b.id not in notified_uids

    # Verify notification attributes
    for n in notifs:
        assert n.priority == NotificationPriority.HIGH.value
        assert n.category == NotificationCategory.ATTENDANCE.value
        assert n.action_route == f"/attendance/session/{session_id}"
        payload = json.loads(n.payload_json)
        assert payload["record_id"] == str(record_id)
        assert payload["new_status"] == "PRESENT"


@pytest.mark.asyncio
async def test_deduplication_when_user_holds_multiple_roles(db_session: AsyncSession):
    """
    Matrix Requirement:
    A person holding multiple relevant responsibilities (e.g. Regular faculty who is ALSO the HOD)
    must receive exactly ONE notification.
    """
    uid = uuid.uuid4().hex[:6]
    dept = Department(institution_id=DEFAULT_INSTITUTION_ID, code=f"MATH_{uid}", name="Mathematics")
    term = AcademicTerm(
        institution_id=DEFAULT_INSTITUTION_ID,
        code=f"TM_{uid}",
        name="Term Math",
        academic_year="2026",
        start_date=datetime.now(timezone.utc).date(),
        end_date=datetime.now(timezone.utc).date() + timedelta(days=90),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([dept, term])
    await db_session.flush()

    sec = ClassSection(institution_id=DEFAULT_INSTITUTION_ID, section_code=f"M_{uid}", department_id=dept.id, academic_term_id=term.id, cohort_year=2024)
    subj = Subject(institution_id=DEFAULT_INSTITUTION_ID, code=f"CALC_{uid}", name="Calculus", department_id=dept.id)
    db_session.add_all([sec, subj])
    await db_session.flush()

    # User who is BOTH regular faculty and HOD of the department
    dual_faculty = User(institutional_id=f"DUAL_{uid}", email=f"dual_{uid}@inst.edu", password_hash="h", full_name="Prof & HOD", role=UserRole.FACULTY)
    student = User(institutional_id=f"STU_D_{uid}", email=f"stud_{uid}@inst.edu", password_hash="h", full_name="Student D", role=UserRole.STUDENT)
    db_session.add_all([dual_faculty, student])
    await db_session.flush()

    ta = TeachingAssignment(
        institution_id=DEFAULT_INSTITUTION_ID,
        faculty_user_id=dual_faculty.id,
        class_section_id=sec.id,
        subject_id=subj.id,
        academic_term_id=term.id,
        created_by_user_id=dual_faculty.id,
    )
    db_session.add(ta)
    await db_session.flush()

    await _assign_role_with_scope(
        db_session, dual_faculty.id, "DEPARTMENT_HEAD_COORDINATOR", RoleScopeType.DEPARTMENT, department_id=dept.id
    )

    notifs = await NotificationRoutingService.notify_attendance_amendment(
        db=db_session,
        session_id=uuid.uuid4(),
        record_id=uuid.uuid4(),
        student_user_id=student.id,
        amending_user_id=dual_faculty.id,
        old_status="ABSENT",
        new_status="PRESENT",
        reason="Deduplication verification test",
        teaching_assignment_id=ta.id,
        department_id=dept.id,
    )

    dual_faculty_notifs = [n for n in notifs if n.user_id == dual_faculty.id]
    # Invariant: exactly ONE notification delivered to dual_faculty
    assert len(dual_faculty_notifs) == 1


@pytest.mark.asyncio
async def test_substitute_delegation_lifecycle_notifications(db_session: AsyncSession):
    """
    Matrix Rules 2 & 3:
    1. Delegation requested -> Notifies authorized HOD.
    2. Delegation granted/revoked -> Notifies regular faculty, substitute, and HOD.
    """
    uid = uuid.uuid4().hex[:6]
    dept = Department(institution_id=DEFAULT_INSTITUTION_ID, code=f"PHY_{uid}", name="Physics")
    db_session.add(dept)
    await db_session.flush()

    reg_faculty = User(institutional_id=f"F_REG_{uid}", email=f"reg_{uid}@inst.edu", password_hash="h", full_name="Reg", role=UserRole.FACULTY)
    sub_faculty = User(institutional_id=f"F_SUB_{uid}", email=f"sub_{uid}@inst.edu", password_hash="h", full_name="Sub", role=UserRole.FACULTY)
    hod = User(institutional_id=f"HOD_PHY_{uid}", email=f"hodp_{uid}@inst.edu", password_hash="h", full_name="HOD Physics", role=UserRole.FACULTY)
    db_session.add_all([reg_faculty, sub_faculty, hod])
    await db_session.flush()

    await _assign_role_with_scope(
        db_session, hod.id, "DEPARTMENT_HEAD_COORDINATOR", RoleScopeType.DEPARTMENT, department_id=dept.id
    )

    delg_id = uuid.uuid4()
    ta_id = uuid.uuid4()

    # 1. Requested
    req_notifs = await NotificationRoutingService.notify_delegation_requested(
        db=db_session,
        delegation_id=delg_id,
        teaching_assignment_id=ta_id,
        grantor_user_id=reg_faculty.id,
        grantee_user_id=sub_faculty.id,
        department_id=dept.id,
        reason="Attending international research conference",
    )
    assert len(req_notifs) == 1
    assert req_notifs[0].user_id == hod.id
    assert req_notifs[0].priority == NotificationPriority.HIGH.value
    assert req_notifs[0].action_route == "/delegations/approvals"

    # 2. Granted
    grant_notifs = await NotificationRoutingService.notify_delegation_granted_or_revoked(
        db=db_session,
        delegation_id=delg_id,
        regular_faculty_user_id=reg_faculty.id,
        substitute_faculty_user_id=sub_faculty.id,
        is_granted=True,
        department_id=dept.id,
    )
    grant_uids = {n.user_id for n in grant_notifs}
    assert reg_faculty.id in grant_uids
    assert sub_faculty.id in grant_uids
    assert hod.id in grant_uids


@pytest.mark.asyncio
async def test_student_grievance_lifecycle_notifications(db_session: AsyncSession):
    """
    Matrix Rules 4 & 5:
    1. Student grievance submitted -> Notifies conducting faculty.
    2. Grievance resolved -> Notifies student, regular faculty, and conducting faculty if different.
    """
    uid = uuid.uuid4().hex[:6]
    student = User(institutional_id=f"STU_G_{uid}", email=f"stug_{uid}@inst.edu", password_hash="h", full_name="Student G", role=UserRole.STUDENT)
    reg_fac = User(institutional_id=f"REG_G_{uid}", email=f"regg_{uid}@inst.edu", password_hash="h", full_name="Reg G", role=UserRole.FACULTY)
    cond_fac = User(institutional_id=f"COND_G_{uid}", email=f"condg_{uid}@inst.edu", password_hash="h", full_name="Cond G", role=UserRole.FACULTY)
    db_session.add_all([student, reg_fac, cond_fac])
    await db_session.flush()

    req_id = uuid.uuid4()
    sess_id = uuid.uuid4()

    # Submission
    sub_notifs = await NotificationRoutingService.notify_grievance_submitted(
        db=db_session,
        request_id=req_id,
        student_user_id=student.id,
        conducting_faculty_user_id=cond_fac.id,
        session_id=sess_id,
        reason="Late arrival due to campus bus delay",
    )
    assert len(sub_notifs) == 1
    assert sub_notifs[0].user_id == cond_fac.id
    assert sub_notifs[0].category == NotificationCategory.REQUEST.value

    # Resolution (Approved)
    res_notifs = await NotificationRoutingService.notify_grievance_resolved(
        db=db_session,
        request_id=req_id,
        student_user_id=student.id,
        regular_faculty_user_id=reg_fac.id,
        conducting_faculty_user_id=cond_fac.id,
        status="ACCEPTED",
        resolution_notes="Bus delay verified with transport office",
    )
    res_uids = {n.user_id for n in res_notifs}
    assert student.id in res_uids
    assert reg_fac.id in res_uids
    assert cond_fac.id in res_uids


@pytest.mark.asyncio
async def test_attendance_shortage_routing_with_program_and_section_scopes(db_session: AsyncSession):
    """
    Matrix Rule 6:
    Attendance shortage alert routes to:
    - Student
    - Class Advisor (scoped to CLASS_SECTION)
    - Program Coordinator (scoped to PROGRAM)
    Uses configurable institutional threshold.
    """
    uid = uuid.uuid4().hex[:6]
    dept = Department(institution_id=DEFAULT_INSTITUTION_ID, code=f"BIO_{uid}", name="Biotech")
    term = AcademicTerm(
        institution_id=DEFAULT_INSTITUTION_ID,
        code=f"TBIO_{uid}",
        name="Term Bio",
        academic_year="2026",
        start_date=datetime.now(timezone.utc).date(),
        end_date=datetime.now(timezone.utc).date() + timedelta(days=90),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([dept, term])
    await db_session.flush()

    prog = Program(institution_id=DEFAULT_INSTITUTION_ID, department_id=dept.id, code=f"BS_BIO_{uid}", name="BS Biotech")
    db_session.add(prog)
    await db_session.flush()

    sec = ClassSection(
        institution_id=DEFAULT_INSTITUTION_ID,
        section_code=f"SEC_BIO_{uid}",
        department_id=dept.id,
        program_id=prog.id,
        academic_term_id=term.id,
        cohort_year=2024,
    )
    db_session.add(sec)
    await db_session.flush()

    student = User(institutional_id=f"STU_SH_{uid}", email=f"stush_{uid}@inst.edu", password_hash="h", full_name="Student Short", role=UserRole.STUDENT)
    class_advisor = User(institutional_id=f"ADV_{uid}", email=f"adv_{uid}@inst.edu", password_hash="h", full_name="Class Advisor", role=UserRole.FACULTY)
    prog_coordinator = User(institutional_id=f"COORD_{uid}", email=f"coord_{uid}@inst.edu", password_hash="h", full_name="Prog Coord", role=UserRole.FACULTY)
    db_session.add_all([student, class_advisor, prog_coordinator])
    await db_session.flush()

    # Assign Class Advisor role scoped to sec.id
    await _assign_role_with_scope(
        db_session, class_advisor.id, "CLASS_ADVISOR", RoleScopeType.CLASS_SECTION, class_section_id=sec.id
    )
    # Assign Program Coordinator role scoped to prog.id
    await _assign_role_with_scope(
        db_session, prog_coordinator.id, "PROGRAM_COORDINATOR", RoleScopeType.PROGRAM, program_id=prog.id
    )

    notifs = await NotificationRoutingService.notify_attendance_shortage(
        db=db_session,
        student_user_id=student.id,
        class_section_id=sec.id,
        percentage=68.5,
        threshold=75.0,
    )

    notified_uids = {n.user_id for n in notifs}
    assert student.id in notified_uids
    assert class_advisor.id in notified_uids
    assert prog_coordinator.id in notified_uids


@pytest.mark.asyncio
async def test_biometric_officer_notification_routing(db_session: AsyncSession):
    """
    Matrix Rules 7 & 8:
    1. Biometric re-enrollment -> Notifies student & Biometric Enrollment Officer.
    2. Privacy / Retention incident -> Notifies Privacy & Biometric Governance Officer.
    """
    uid = uuid.uuid4().hex[:6]
    student = User(institutional_id=f"STU_B_{uid}", email=f"stub_{uid}@inst.edu", password_hash="h", full_name="Student B", role=UserRole.STUDENT)
    enroll_officer = User(institutional_id=f"OFF_ENR_{uid}", email=f"offenr_{uid}@inst.edu", password_hash="h", full_name="Enrollment Officer", role=UserRole.ADMIN)
    gov_officer = User(institutional_id=f"OFF_GOV_{uid}", email=f"offgov_{uid}@inst.edu", password_hash="h", full_name="Governance Officer", role=UserRole.ADMIN)
    db_session.add_all([student, enroll_officer, gov_officer])
    await db_session.flush()

    # Assign Biometric Enrollment Officer
    await _assign_role_with_scope(
        db_session, enroll_officer.id, "BIOMETRIC_ENROLLMENT_OFFICER", RoleScopeType.INSTITUTION
    )
    # Assign Privacy & Biometric Governance Officer
    await _assign_role_with_scope(
        db_session, gov_officer.id, "PRIVACY_BIOMETRIC_GOVERNANCE", RoleScopeType.INSTITUTION
    )

    # 1. Re-enrollment
    reenroll_notifs = await NotificationRoutingService.notify_biometric_reenrollment(
        db=db_session,
        student_user_id=student.id,
        reason="Camera sensor upgrade to edgeface_xs_v1",
    )
    reenroll_uids = {n.user_id for n in reenroll_notifs}
    assert student.id in reenroll_uids
    assert enroll_officer.id in reenroll_uids
    assert gov_officer.id not in reenroll_uids

    # 2. Privacy incident
    gov_notifs = await NotificationRoutingService.notify_biometric_privacy_incident(
        db=db_session,
        incident_type="CONSENT_REVOCATION_EXPIRY",
        details="Student S10 consent revoked; vector purge triggered.",
        severity="HIGH",
    )
    gov_uids = {n.user_id for n in gov_notifs}
    assert gov_officer.id in gov_uids
    assert enroll_officer.id not in gov_uids
    assert gov_notifs[0].priority == NotificationPriority.HIGH.value
