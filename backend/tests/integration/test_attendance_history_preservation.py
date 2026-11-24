"""Rigorous PostgreSQL Integration Tests for Historical Attendance and Audit Preservation.

Verifies:
1. Direct deletion of an AttendanceSession with attendance records is RESTRICTED by PostgreSQL.
2. Direct deletion of an AttendanceSession with amendment audit records is RESTRICTED by PostgreSQL.
3. Direct deletion of a ClassSection that has attendance history is RESTRICTED by PostgreSQL.
4. Direct deletion of an AcademicTerm that has historical attendance is RESTRICTED by PostgreSQL.
5. Direct deletion of an Institution that has historical attendance is RESTRICTED by PostgreSQL.
"""
from datetime import date, datetime, timezone
import uuid
import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.academic import AcademicTerm, ClassSection, Department, Subject, TermStatus, DEFAULT_INSTITUTION_ID
from src.models.access_control import Campus, Institution
from src.models.assignment import TeachingAssignment
from src.models.attendance import (
    AttendanceAmendmentAudit,
    AttendanceRecord,
    AttendanceSession,
    AttendanceSessionStatus,
    AttendanceStatus,
    MarkSource,
    SessionApplicability,
)
from src.models.user import AccountStatus, User, UserRole


async def _create_attendance_test_hierarchy(db_session: AsyncSession):
    res_inst = await db_session.execute(select(Institution).where(Institution.id == DEFAULT_INSTITUTION_ID))
    inst = res_inst.scalar_one_or_none()
    if not inst:
        inst = Institution(id=DEFAULT_INSTITUTION_ID, code="KLASIO_MAIN", name="Hist Inst")
        db_session.add(inst)
    faculty = User(
        institutional_id=f"FAC_H_{uuid.uuid4().hex[:6]}",
        email=f"fach_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash="h",
        full_name="Hist Faculty",
        role=UserRole.FACULTY,
    )
    student = User(
        institutional_id=f"STU_H_{uuid.uuid4().hex[:6]}",
        email=f"stuh_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash="h",
        full_name="Hist Student",
        role=UserRole.STUDENT,
    )
    admin = User(
        institutional_id=f"ADM_H_{uuid.uuid4().hex[:6]}",
        email=f"admh_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash="h",
        full_name="Hist Admin",
        role=UserRole.ADMIN,
    )
    db_session.add_all([inst, faculty, student, admin])
    await db_session.flush()

    campus = Campus(institution_id=inst.id, code="C1", name="C1")
    dept = Department(institution_id=inst.id, code="D1", name="D1")
    term = AcademicTerm(
        institution_id=inst.id,
        code=f"TH_{uuid.uuid4().hex[:6]}",
        name="Term Hist",
        academic_year="2026",
        start_date=date(2026, 1, 1),
        end_date=date(2026, 6, 1),
        status=TermStatus.ACTIVE,
    )
    db_session.add_all([campus, dept, term])
    await db_session.flush()

    sec = ClassSection(
        institution_id=inst.id,
        campus_id=campus.id,
        department_id=dept.id,
        academic_term_id=term.id,
        section_code="SEC_HIST",
        cohort_year=2024,
    )
    subj = Subject(institution_id=inst.id, department_id=dept.id, code="CS_HIST", name="Hist Subj")
    db_session.add_all([sec, subj])
    await db_session.flush()

    ta = TeachingAssignment(
        faculty_user_id=faculty.id,
        class_section_id=sec.id,
        subject_id=subj.id,
        academic_term_id=term.id,
        created_by_user_id=admin.id,
    )
    db_session.add(ta)
    await db_session.flush()

    now = datetime.now(timezone.utc)
    sess = AttendanceSession(
        client_session_uuid=uuid.uuid4(),
        teaching_assignment_id=ta.id,
        session_date=date(2026, 3, 1),
        period_slot_or_sequence=1,
        applicability_status=SessionApplicability.COUNTED,
        regular_faculty_user_id=faculty.id,
        conducting_faculty_user_id=faculty.id,
        session_status=AttendanceSessionStatus.FINALIZED,
        finalized_at=now,
    )
    db_session.add(sess)
    await db_session.flush()

    rec = AttendanceRecord(
        attendance_session_id=sess.id,
        student_user_id=student.id,
        attendance_status=AttendanceStatus.PRESENT,
        mark_source=MarkSource.MANUAL_MARK,
        recorded_at=now,
    )
    db_session.add(rec)
    await db_session.flush()

    return {
        "inst": inst,
        "campus": campus,
        "dept": dept,
        "term": term,
        "sec": sec,
        "subj": subj,
        "ta": ta,
        "sess": sess,
        "rec": rec,
        "faculty": faculty,
        "student": student,
        "admin": admin,
    }


@pytest.mark.asyncio
async def test_pg_restricts_deletion_of_attendance_session_with_records(db_session: AsyncSession):
    """PostgreSQL ON DELETE RESTRICT prevents deleting AttendanceSession containing AttendanceRecords."""
    h = await _create_attendance_test_hierarchy(db_session)
    sess = h["sess"]

    await db_session.delete(sess)
    with pytest.raises(IntegrityError) as exc_info:
        await db_session.flush()
    assert "attendance_records_attendance_session_id_fkey" in str(exc_info.value).lower() or "violates foreign key constraint" in str(exc_info.value).lower()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_pg_restricts_deletion_of_attendance_session_with_amendment_audits(db_session: AsyncSession):
    """PostgreSQL ON DELETE RESTRICT prevents deleting AttendanceSession that has legal amendment audits."""
    h = await _create_attendance_test_hierarchy(db_session)
    sess = h["sess"]
    rec = h["rec"]
    student = h["student"]
    admin = h["admin"]

    # Delete the record directly first to isolate amendment audit constraint
    await db_session.delete(rec)
    await db_session.flush()

    # Add an amendment audit log
    audit = AttendanceAmendmentAudit(
        client_amendment_id=uuid.uuid4(),
        attendance_session_id=sess.id,
        student_user_id=student.id,
        previous_status=AttendanceStatus.ABSENT,
        new_status=AttendanceStatus.PRESENT,
        amendment_reason="Legitimate medical leave note submitted",
        amendment_role="ADMIN",
        amending_user_id=admin.id,
    )
    db_session.add(audit)
    await db_session.flush()

    # Attempting to delete the session must be RESTRICTED by PostgreSQL
    await db_session.delete(sess)
    with pytest.raises(IntegrityError) as exc_info:
        await db_session.flush()
    assert "attendance_amendment_audits_attendance_session_id_fkey" in str(exc_info.value).lower() or "violates foreign key constraint" in str(exc_info.value).lower()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_pg_restricts_deletion_of_class_section_with_attendance_history(db_session: AsyncSession):
    """PostgreSQL ON DELETE RESTRICT prevents deleting ClassSection that has teaching assignments and attendance."""
    h = await _create_attendance_test_hierarchy(db_session)
    sec = h["sec"]

    await db_session.delete(sec)
    with pytest.raises(IntegrityError) as exc_info:
        await db_session.flush()
    assert "teaching_assignments_class_section_id_fkey" in str(exc_info.value).lower() or "violates foreign key constraint" in str(exc_info.value).lower()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_pg_restricts_deletion_of_academic_term_with_attendance_history(db_session: AsyncSession):
    """PostgreSQL ON DELETE RESTRICT prevents deleting AcademicTerm that has class sections and attendance."""
    h = await _create_attendance_test_hierarchy(db_session)
    term = h["term"]

    await db_session.delete(term)
    with pytest.raises(IntegrityError) as exc_info:
        await db_session.flush()
    assert "violates foreign key constraint" in str(exc_info.value).lower()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_pg_restricts_deletion_of_institution_with_attendance_history(db_session: AsyncSession):
    """PostgreSQL ON DELETE RESTRICT prevents deleting Institution that has class sections and attendance."""
    h = await _create_attendance_test_hierarchy(db_session)
    inst = h["inst"]

    await db_session.delete(inst)
    with pytest.raises(IntegrityError) as exc_info:
        await db_session.flush()
    assert "violates foreign key constraint" in str(exc_info.value).lower()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_pg_restricts_deletion_of_student_user_with_attendance_records(db_session: AsyncSession):
    """PostgreSQL ON DELETE RESTRICT prevents deleting User (Student) who has historical attendance records.
    Historical student attendance cannot be erased by deleting the user entity.
    """
    h = await _create_attendance_test_hierarchy(db_session)
    student = h["student"]

    await db_session.delete(student)
    with pytest.raises(IntegrityError) as exc_info:
        await db_session.flush()
    assert "violates foreign key constraint" in str(exc_info.value).lower()
    assert "attendance_records" in str(exc_info.value).lower()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_pg_restricts_deletion_of_faculty_user_with_attendance_sessions(db_session: AsyncSession):
    """PostgreSQL ON DELETE RESTRICT prevents deleting User (Faculty) who conducted or owned attendance sessions.
    Faculty attendance sessions cannot be erased by deleting the user entity.
    """
    h = await _create_attendance_test_hierarchy(db_session)
    faculty = h["faculty"]

    await db_session.delete(faculty)
    with pytest.raises(IntegrityError) as exc_info:
        await db_session.flush()
    assert "violates foreign key constraint" in str(exc_info.value).lower()
    assert "attendance_sessions" in str(exc_info.value).lower() or "teaching_assignments" in str(exc_info.value).lower()
    await db_session.rollback()
