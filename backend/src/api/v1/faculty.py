from datetime import date, datetime
from typing import Any, Dict, List, Optional
import uuid
from fastapi import APIRouter, Depends, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select, and_, or_
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.exceptions import OutOfScopeError, EntityNotFoundError
from src.core.permissions import require_faculty, require_faculty_or_admin
from src.database import get_db_session
from src.models.assignment import SubstituteDelegation, TeachingAssignment
from src.models.attendance import AttendanceSession, AttendanceSessionStatus
from src.models.user import User, UserRole
from src.schemas.assignment import (
    ClassRosterResponse,
    CreateDelegationRequest,
    FacultyTeachingAssignment,
    RevokeDelegationRequest,
    RosterStudentItem,
    SubstituteDelegationResponse,
)
from src.schemas.biometrics import AssignmentGalleryResponse
from src.services.biometric_service import BiometricService
from src.services.scoping_service import ScopingService

router = APIRouter(prefix="/api/v1/faculty", tags=["Faculty Scoped Attendance"])


@router.get("/assignments", response_model=List[FacultyTeachingAssignment])
async def get_faculty_assignments(
    academic_term_id: Optional[uuid.UUID] = Query(None),
    current_faculty: User = Depends(require_faculty),
    db: AsyncSession = Depends(get_db_session),
):
    """Retrieve all active direct teaching assignments and delegations for authenticated faculty."""
    scoping_service = ScopingService(db)
    return await scoping_service.get_faculty_assignments(
        faculty_user_id=current_faculty.id,
        academic_term_id=academic_term_id,
        on_date=date.today(),
    )


@router.get("/assignments/{teaching_assignment_id}/roster", response_model=ClassRosterResponse)
async def get_assignment_roster(
    teaching_assignment_id: uuid.UUID,
    session_date: date = Query(..., description="Academic date of attendance session"),
    current_faculty: User = Depends(require_faculty),
    db: AsyncSession = Depends(get_db_session),
):
    """
    Retrieve student attendance roster for an assignment on a specific academic date.
    Strictly verifies faculty teaching assignment or substitute delegation authority on session_date.
    """
    eval_date = session_date or date.today()
    scoping_service = ScopingService(db)
    # 1. Scoping guard: verify authority
    await scoping_service.verify_faculty_scope(
        faculty_user_id=current_faculty.id,
        teaching_assignment_id=teaching_assignment_id,
        session_date=eval_date,
    )

    # 2. Retrieve assignment details for class_section_id
    assign_stmt = select(TeachingAssignment).where(TeachingAssignment.id == teaching_assignment_id)
    assign_res = await db.execute(assign_stmt)
    assignment = assign_res.scalar_one()

    # 3. Retrieve eligible students bounded by session_date
    from src.services.enrollment_service import EnrollmentService
    enrollment_service = EnrollmentService(db)
    eligible_students = await enrollment_service.get_eligible_students_for_section(
        class_section_id=assignment.class_section_id,
        session_date=eval_date,
    )

    return ClassRosterResponse(
        teaching_assignment_id=teaching_assignment_id,
        session_date=eval_date,
        eligible_students=eligible_students,
        total_eligible_count=len(eligible_students),
    )


@router.get(
    "/assignments/{teaching_assignment_id}/gallery",
    response_model=AssignmentGalleryResponse,
    summary="Retrieve authorized student biometric templates for a teaching assignment",
)
async def get_assignment_gallery(
    request: Request,
    teaching_assignment_id: uuid.UUID,
    session_date: Optional[date] = Query(None),
    current_user: User = Depends(require_faculty_or_admin),
    db: AsyncSession = Depends(get_db_session),
):
    """
    Retrieve authorized biometric face gallery templates for an assignment.
    Scoped strictly to actively enrolled, registered students in the section.
    """
    cid = request.headers.get("X-Correlation-ID") or request.headers.get("X-Request-ID")
    service = BiometricService(db)
    return await service.get_assignment_gallery(
        operator=current_user,
        teaching_assignment_id=teaching_assignment_id,
        session_date=session_date,
        correlation_id=cid,
    )


@router.post(
    "/assignments/{teaching_assignment_id}/delegations",
    response_model=SubstituteDelegationResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_substitute_delegation(
    teaching_assignment_id: uuid.UUID,
    payload: CreateDelegationRequest,
    current_faculty: User = Depends(require_faculty),
    db: AsyncSession = Depends(get_db_session),
):
    """Create a direct substitute faculty delegation with immediate activation."""
    scoping_service = ScopingService(db)
    return await scoping_service.create_delegation(
        teaching_assignment_id=teaching_assignment_id,
        delegating_user=current_faculty,
        payload=payload,
    )


@router.post(
    "/delegations/{delegation_id}/revoke",
    response_model=SubstituteDelegationResponse,
    status_code=status.HTTP_200_OK,
)
async def revoke_substitute_delegation(
    delegation_id: uuid.UUID,
    payload: RevokeDelegationRequest,
    current_faculty: User = Depends(require_faculty),
    db: AsyncSession = Depends(get_db_session),
):
    """Early revocation of an active substitute delegation."""
    scoping_service = ScopingService(db)
    return await scoping_service.revoke_delegation(
        delegation_id=delegation_id,
        revoking_user=current_faculty,
        payload=payload,
    )


class FacultyDelegationItem(BaseModel):
    id: uuid.UUID
    assignment_id: uuid.UUID
    subject_name: str
    section_code: str
    substitute_faculty_name: str
    substitute_faculty_id: str
    start_date: date
    end_date: date
    reason: str
    status: str


@router.get("/delegations", response_model=List[FacultyDelegationItem], summary="List delegations for faculty")
async def list_faculty_delegations(
    current_faculty: User = Depends(require_faculty),
    db: AsyncSession = Depends(get_db_session),
):
    stmt = (
        select(SubstituteDelegation)
        .options(
            selectinload(SubstituteDelegation.teaching_assignment).selectinload(TeachingAssignment.class_section),
            selectinload(SubstituteDelegation.teaching_assignment).selectinload(TeachingAssignment.subject),
            selectinload(SubstituteDelegation.substitute_faculty),
            selectinload(SubstituteDelegation.regular_faculty),
        )
        .where(
            or_(
                SubstituteDelegation.regular_faculty_user_id == current_faculty.id,
                SubstituteDelegation.substitute_faculty_user_id == current_faculty.id,
            )
        )
        .order_by(SubstituteDelegation.created_at.desc())
    )
    res = await db.execute(stmt)
    delegations = res.scalars().all()
    return [
        FacultyDelegationItem(
            id=d.id,
            assignment_id=d.teaching_assignment_id,
            subject_name=d.teaching_assignment.subject.name if d.teaching_assignment and d.teaching_assignment.subject else "Subject",
            section_code=d.teaching_assignment.class_section.section_code if d.teaching_assignment and d.teaching_assignment.class_section else "Section",
            substitute_faculty_name=d.substitute_faculty.full_name if d.substitute_faculty else "Faculty",
            substitute_faculty_id=d.substitute_faculty.institutional_id if d.substitute_faculty else "",
            start_date=d.start_date,
            end_date=d.end_date,
            reason=d.delegation_reason,
            status=d.status.value if hasattr(d.status, "value") else str(d.status),
        )
        for d in delegations
    ]



class AcademicTermsListResponse(BaseModel):
    academic_years: List[str]
    terms: List[Dict[str, Any]]


class StudentProfileDetailResponse(BaseModel):
    student_user_id: uuid.UUID
    institutional_id: str
    full_name: str
    email: str
    account_status: str
    face_registration_state: str
    active_model_version: Optional[str] = None
    profile_photo_url: Optional[str] = None
    last_validated_at: Optional[str] = None
    sections: List[Dict[str, Any]]
    total_eligible_sessions: int
    attended_sessions: int
    attendance_percentage: Optional[float]
    shortage_status: bool
    consecutive_absences: int
    classes_can_miss: int
    classes_to_recover: Optional[int]


class StudentProfileUpdateRequest(BaseModel):
    full_name: Optional[str] = Field(None, min_length=1, max_length=255)
    email: Optional[str] = Field(None, min_length=3, max_length=255)


@router.get("/academic-terms", response_model=AcademicTermsListResponse, summary="Retrieve available academic terms and years")
async def get_academic_terms(
    current_user: User = Depends(require_faculty_or_admin),
    db: AsyncSession = Depends(get_db_session),
):
    from src.models.academic import AcademicTerm
    stmt = select(AcademicTerm).order_by(AcademicTerm.academic_year.desc(), AcademicTerm.start_date.desc())
    res = await db.execute(stmt)
    terms = res.scalars().all()

    academic_years = sorted(list({t.academic_year for t in terms if t.academic_year}), reverse=True)
    terms_data = [
        {
            "id": str(t.id),
            "code": t.code,
            "name": t.name,
            "academic_year": t.academic_year,
            "start_date": t.start_date.isoformat(),
            "end_date": t.end_date.isoformat(),
            "status": t.status.value if hasattr(t.status, "value") else str(t.status),
        }
        for t in terms
    ]
    return AcademicTermsListResponse(academic_years=academic_years, terms=terms_data)


@router.get("/students/{student_user_id}", response_model=StudentProfileDetailResponse, summary="Get student details within faculty scope")
async def get_student_detail(
    student_user_id: uuid.UUID,
    current_user: User = Depends(require_faculty_or_admin),
    db: AsyncSession = Depends(get_db_session),
):
    from src.models.user import UserRole
    from src.models.enrollment import StudentEnrollment, EnrollmentStatus, StudentFaceProfile
    from src.services.enrollment_service import EnrollmentService

    # 1. Fetch student
    stu_stmt = select(User).where(User.id == student_user_id)
    stu_res = await db.execute(stu_stmt)
    student = stu_res.scalar_one_or_none()
    if not student or student.role != UserRole.STUDENT:
        raise EntityNotFoundError(f"Student {student_user_id} not found")

    # 2. Scope check: Faculty must teach at least one section where student is enrolled
    if current_user.role == UserRole.FACULTY:
        biometric_svc = BiometricService(db)
        await biometric_svc._verify_operator_enrollment_scope(current_user, student_user_id)

    # 3. Face Profile
    fp_stmt = select(StudentFaceProfile).where(StudentFaceProfile.student_user_id == student_user_id)
    fp_res = await db.execute(fp_stmt)
    fp = fp_res.scalar_one_or_none()

    face_state = fp.registration_state.value if (fp and fp.registration_state) else "UNREGISTERED"
    model_ver = fp.active_model_version if fp else None
    last_val = fp.last_validated_at.isoformat() if (fp and fp.last_validated_at) else None

    # Check if profile photo exists
    from src.api.v1.users import UPLOAD_DIR
    photo_file = UPLOAD_DIR / f"{student_user_id}.jpg"
    photo_url = f"/api/v1/users/{student_user_id}/profile-photo" if photo_file.exists() else None

    # 4. Enrolled sections
    enr_stmt = (
        select(StudentEnrollment)
        .options(
            selectinload(StudentEnrollment.class_section),
            selectinload(StudentEnrollment.academic_term),
        )
        .where(
            and_(
                StudentEnrollment.student_user_id == student_user_id,
                StudentEnrollment.enrollment_status.in_([EnrollmentStatus.ACTIVE, EnrollmentStatus.TRANSFERRED]),
            )
        )
    )
    enr_res = await db.execute(enr_stmt)
    enrollments = enr_res.scalars().all()

    sections_data = []
    for enr in enrollments:
        sec = enr.class_section
        term = enr.academic_term
        sections_data.append({
            "class_section_id": str(sec.id) if sec else "",
            "section_code": sec.section_code if sec else "",
            "academic_term_id": str(term.id) if term else "",
            "term_name": term.name if term else "",
            "academic_year": term.academic_year if term else "",
            "enrollment_status": enr.enrollment_status.value if hasattr(enr.enrollment_status, "value") else str(enr.enrollment_status),
            "effective_start_date": enr.effective_start_date.isoformat(),
            "effective_end_date": enr.effective_end_date.isoformat() if enr.effective_end_date else None,
        })

    # 5. Overall attendance calculation
    enr_svc = EnrollmentService(db)
    attendance = await enr_svc.calculate_student_personal_attendance(student_user_id)

    return StudentProfileDetailResponse(
        student_user_id=student.id,
        institutional_id=student.institutional_id,
        full_name=student.full_name,
        email=student.email,
        account_status=student.account_status.value if hasattr(student.account_status, "value") else str(student.account_status),
        face_registration_state=face_state,
        active_model_version=model_ver,
        profile_photo_url=photo_url,
        last_validated_at=last_val,
        sections=sections_data,
        total_eligible_sessions=attendance.aggregate_held_sessions,
        attended_sessions=attendance.aggregate_attended_sessions,
        attendance_percentage=attendance.aggregate_attendance_percentage,
        shortage_status=attendance.has_shortage_alert,
        consecutive_absences=0,
        classes_can_miss=attendance.classes_can_miss,
        classes_to_recover=attendance.classes_to_recover,
    )


@router.patch("/students/{student_user_id}", summary="Update student profile information within faculty scope")
async def update_student_detail(
    student_user_id: uuid.UUID,
    payload: StudentProfileUpdateRequest,
    current_user: User = Depends(require_faculty_or_admin),
    db: AsyncSession = Depends(get_db_session),
):
    from src.models.user import UserRole
    # 1. Scope check
    if current_user.role == UserRole.FACULTY:
        biometric_svc = BiometricService(db)
        await biometric_svc._verify_operator_enrollment_scope(current_user, student_user_id)

    # 2. Fetch student
    stu_stmt = select(User).where(User.id == student_user_id)
    stu_res = await db.execute(stu_stmt)
    student = stu_res.scalar_one_or_none()
    if not student or student.role != UserRole.STUDENT:
        raise EntityNotFoundError(f"Student {student_user_id} not found")

    # 3. Apply updates to permitted fields
    if payload.full_name is not None and payload.full_name.strip():
        student.full_name = payload.full_name.strip()
    if payload.email is not None and payload.email.strip():
        student.email = payload.email.strip()

    await db.flush()
    await db.refresh(student)

    return {
        "success": True,
        "student_user_id": str(student.id),
        "full_name": student.full_name,
        "email": student.email,
    }


class FacultyHeldSessionItem(BaseModel):
    id: uuid.UUID
    client_session_uuid: uuid.UUID
    teaching_assignment_id: uuid.UUID
    session_date: date
    period_slot_or_sequence: int
    applicability_status: str
    status_reason: Optional[str] = None
    session_status: str
    records_count: int
    present_count: int
    absent_count: int
    excused_count: int
    finalized_at: datetime
    conducting_faculty_user_id: Optional[uuid.UUID] = None
    conducting_faculty_name: Optional[str] = None

    model_config = ConfigDict(from_attributes=True)


@router.get(
    "/assignments/{teaching_assignment_id}/sessions",
    response_model=List[FacultyHeldSessionItem],
    summary="Retrieve chronological history of held classes and sessions for teaching assignment",
)
async def get_assignment_held_sessions(
    teaching_assignment_id: uuid.UUID,
    start_date: Optional[date] = Query(None),
    end_date: Optional[date] = Query(None),
    current_faculty: User = Depends(require_faculty_or_admin),
    db: AsyncSession = Depends(get_db_session),
):
    scoping_service = ScopingService(db)
    if current_faculty.role != UserRole.ADMIN:
        await scoping_service.verify_faculty_scope(
            faculty_user_id=current_faculty.id,
            teaching_assignment_id=teaching_assignment_id,
            session_date=date.today(),
        )

    stmt = (
        select(AttendanceSession)
        .options(selectinload(AttendanceSession.conducting_faculty_user))
        .where(
            and_(
                AttendanceSession.teaching_assignment_id == teaching_assignment_id,
                AttendanceSession.session_status == AttendanceSessionStatus.FINALIZED,
            )
        )
    )
    if start_date:
        stmt = stmt.where(AttendanceSession.session_date >= start_date)
    if end_date:
        stmt = stmt.where(AttendanceSession.session_date <= end_date)

    stmt = stmt.order_by(
        AttendanceSession.session_date.desc(),
        AttendanceSession.period_slot_or_sequence.desc(),
    )
    res = await db.execute(stmt)
    sessions = res.scalars().all()

    return [
        FacultyHeldSessionItem(
            id=s.id,
            client_session_uuid=s.client_session_uuid,
            teaching_assignment_id=s.teaching_assignment_id,
            session_date=s.session_date,
            period_slot_or_sequence=s.period_slot_or_sequence,
            applicability_status=s.applicability_status.value if hasattr(s.applicability_status, "value") else str(s.applicability_status),
            status_reason=s.status_reason,
            session_status=s.session_status.value if hasattr(s.session_status, "value") else str(s.session_status),
            records_count=s.records_count,
            present_count=s.present_count,
            absent_count=s.absent_count,
            excused_count=s.excused_count,
            finalized_at=s.finalized_at,
            conducting_faculty_user_id=s.conducting_faculty_user_id,
            conducting_faculty_name=s.conducting_faculty_user.full_name if s.conducting_faculty_user else None,
        )
        for s in sessions
    ]


