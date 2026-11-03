import uuid
from typing import List, Optional
from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.exceptions import EntityNotFoundError, OutOfScopeError
from src.core.permissions import require_admin
from src.database import get_db_session
from src.models.academic import AcademicTerm, ClassSection, Department, Subject
from src.models.assignment import TeachingAssignment
from src.models.user import User, UserRole
from src.schemas.academic import (
    AcademicTermCreate,
    AcademicTermResponse,
    ClassSectionCreate,
    ClassSectionResponse,
    DepartmentCreate,
    DepartmentResponse,
    SubjectCreate,
    SubjectResponse,
)
from src.schemas.assignment import (
    TeachingAssignmentCreate,
    TeachingAssignmentResponse,
)
from src.schemas.enrollment import (
    StudentEnrollmentCreate,
    StudentEnrollmentResponse,
    StudentTransferRequest,
    StudentTransferResponse,
)

router = APIRouter(prefix="/api/v1/admin", tags=["Admin Academic Catalog"])


@router.post("/departments", response_model=DepartmentResponse, status_code=status.HTTP_201_CREATED)
async def create_department(
    payload: DepartmentCreate,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    dept = Department(
        code=payload.code,
        name=payload.name,
    )
    db.add(dept)
    await db.flush()
    await db.refresh(dept)
    return dept


@router.post("/terms", response_model=AcademicTermResponse, status_code=status.HTTP_201_CREATED)
async def create_term(
    payload: AcademicTermCreate,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    term = AcademicTerm(
        code=payload.code,
        name=payload.name,
        academic_year=payload.academic_year,
        start_date=payload.start_date,
        end_date=payload.end_date,
        status=payload.status,
    )
    db.add(term)
    await db.flush()
    await db.refresh(term)
    return term


@router.post("/subjects", response_model=SubjectResponse, status_code=status.HTTP_201_CREATED)
async def create_subject(
    payload: SubjectCreate,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    subject = Subject(
        code=payload.code,
        name=payload.name,
        department_id=payload.department_id,
        credits=payload.credits,
        is_active=payload.is_active,
    )
    db.add(subject)
    await db.flush()
    await db.refresh(subject)
    return subject


@router.post("/sections", response_model=ClassSectionResponse, status_code=status.HTTP_201_CREATED)
async def create_section(
    payload: ClassSectionCreate,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    section = ClassSection(
        section_code=payload.section_code,
        department_id=payload.department_id,
        academic_term_id=payload.academic_term_id,
        cohort_year=payload.cohort_year,
    )
    db.add(section)
    await db.flush()
    await db.refresh(section)
    return section


@router.post("/assignments", response_model=TeachingAssignmentResponse, status_code=status.HTTP_201_CREATED)
async def create_teaching_assignment(
    payload: TeachingAssignmentCreate,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    # Validate section existence and tenant membership consistency
    sec_stmt = select(ClassSection).where(ClassSection.id == payload.class_section_id)
    sec_res = await db.execute(sec_stmt)
    section = sec_res.scalar_one_or_none()
    if not section:
        raise EntityNotFoundError(f"Class section {payload.class_section_id} not found")

    from src.models.access_control import InstitutionMembership, MembershipStatus
    mem_stmt = select(InstitutionMembership).where(InstitutionMembership.user_id == payload.faculty_user_id)
    mems = (await db.execute(mem_stmt)).scalars().all()
    if mems:
        has_active = any(m.institution_id == section.institution_id and m.status == MembershipStatus.ACTIVE for m in mems)
        if not has_active:
            raise OutOfScopeError(
                f"Faculty {payload.faculty_user_id} does not have an active membership in institution {section.institution_id}"
            )

    assignment = TeachingAssignment(
        faculty_user_id=payload.faculty_user_id,
        class_section_id=payload.class_section_id,
        subject_id=payload.subject_id,
        academic_term_id=payload.academic_term_id,
        is_active=payload.is_active,
        created_by_user_id=admin_user.id,
    )
    db.add(assignment)
    await db.flush()
    await db.refresh(assignment)
    return assignment


@router.post("/enrollments", response_model=StudentEnrollmentResponse, status_code=status.HTTP_201_CREATED)
async def enroll_student(
    payload: StudentEnrollmentCreate,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    from src.services.enrollment_service import EnrollmentService
    enrollment_service = EnrollmentService(db)
    return await enrollment_service.enroll_student(payload)


@router.post(
    "/enrollments/transfer",
    response_model=StudentTransferResponse,
    status_code=status.HTTP_200_OK,
    summary="Transfer student to a new section with date-bounded lifecycle",
)
async def transfer_student(
    payload: StudentTransferRequest,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    """
    Execute a student section transfer effective on transfer_date (T).
    Closes existing enrollment at T-1 with status TRANSFERRED.
    Opens new enrollment at T with status ACTIVE.
    Preserves historical attendance records and prior rosters.
    """
    from src.services.enrollment_service import EnrollmentService
    enrollment_service = EnrollmentService(db)
    prev_enr, new_enr = await enrollment_service.transfer_student(payload)
    return StudentTransferResponse(
        student_user_id=payload.student_user_id,
        transfer_date=payload.transfer_date,
        previous_enrollment=StudentEnrollmentResponse.model_validate(prev_enr),
        new_enrollment=StudentEnrollmentResponse.model_validate(new_enr),
    )


class AdminUserListItem(BaseModel):
    id: uuid.UUID
    name: str
    email: str
    role: str
    identifier: str
    subtitle: Optional[str] = None
    tag: Optional[str] = None


class DepartmentOverviewItem(BaseModel):
    id: uuid.UUID
    code: str
    name: str
    sections_count: int
    subjects_count: int


@router.get("/users", response_model=List[AdminUserListItem], summary="List users with role and search filters")
async def list_admin_users(
    role: Optional[str] = Query(None, description="Filter by role: student, faculty, admin"),
    q: Optional[str] = Query(None, description="Search text against user full name"),
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    query = select(User)
    if role:
        role_upper = role.upper()
        if role_upper in UserRole.__members__:
            query = query.where(User.role == UserRole[role_upper])
    if q:
        query = query.where(User.full_name.ilike(f"%{q}%"))
    query = query.order_by(User.full_name.asc())
    res = await db.execute(query)
    users = res.scalars().all()
    return [
        AdminUserListItem(
            id=u.id,
            name=u.full_name,
            email=u.email,
            role=u.role.value,
            identifier=u.institutional_id,
            subtitle=f"{u.role.value.capitalize()} · {u.institutional_id}",
            tag=None,
        )
        for u in users
    ]


@router.get(
    "/departments/overview",
    response_model=List[DepartmentOverviewItem],
    summary="List department overview with section and subject counts",
)
async def list_departments_overview(
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    stmt = (
        select(
            Department.id,
            Department.code,
            Department.name,
            func.count(func.distinct(ClassSection.id)).label("sections_count"),
            func.count(func.distinct(Subject.id)).label("subjects_count"),
        )
        .outerjoin(ClassSection, Department.id == ClassSection.department_id)
        .outerjoin(Subject, Department.id == Subject.department_id)
        .group_by(Department.id, Department.code, Department.name)
        .order_by(Department.name.asc())
    )
    res = await db.execute(stmt)
    rows = res.all()
    return [
        DepartmentOverviewItem(
            id=r[0],
            code=r[1],
            name=r[2],
            sections_count=r[3],
            subjects_count=r[4],
        )
        for r in rows
    ]


