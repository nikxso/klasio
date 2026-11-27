import uuid
from typing import List, Optional, Dict
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, Query, Request, status
from pydantic import BaseModel, EmailStr
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.exceptions import EntityNotFoundError, OutOfScopeError, ConflictError
from src.core.permissions import require_admin, resolve_tenant_and_membership
from src.core.security import get_password_hash
from src.database import get_db_session
from src.models.access_control import (
    Institution,
    InstitutionMembership,
    MembershipStatus,
    Campus,
    CampusStatus,
    RoleTemplate,
    Permission,
    RoleAssignment,
    RoleAssignmentScope,
    AssignmentStatus,
    RoleScopeType,
    Delegation,
    DelegationScope,
    DelegationLifecycleStatus,
    AuthorizationAudit,
    AuditOutcome,
)
from src.models.academic import AcademicTerm, ClassSection, Department, Subject
from src.models.assignment import TeachingAssignment
from src.models.user import User, UserRole, AccountStatus
from src.schemas.access_control import (
    CampusCreate,
    CampusUpdate,
    CampusResponse,
    PermissionResponse,
    RoleTemplateResponse,
    RoleAssignmentCreate,
    RoleAssignmentStatusUpdate,
    RoleAssignmentResponse,
    RoleAssignmentScopeResponse,
    InstitutionMembershipResponse,
    DelegationCreate,
    DelegationAction,
    DelegationResponse,
    UnmappedAccountItem,
    AuthorizationAuditResponse,
)
from src.schemas.academic import (
    AcademicTermCreate,
    AcademicTermResponse,
    ClassSectionCreate,
    ClassSectionUpdate,
    ClassSectionResponse,
    DepartmentCreate,
    DepartmentUpdate,
    DepartmentResponse,
    SubjectCreate,
    SubjectUpdate,
    SubjectResponse,
)
from src.schemas.assignment import (
    TeachingAssignmentCreate,
    TeachingAssignmentUpdate,
    TeachingAssignmentResponse,
)
from src.schemas.enrollment import (
    StudentEnrollmentCreate,
    StudentEnrollmentResponse,
    StudentTransferRequest,
    StudentTransferResponse,
)

router = APIRouter(prefix="/api/v1/admin", tags=["Admin Academic Catalog"])


@router.get("/departments", response_model=List[DepartmentResponse], summary="List all departments")
async def list_departments(
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    stmt = select(Department).order_by(Department.name.asc())
    res = await db.execute(stmt)
    return res.scalars().all()


@router.post("/departments", response_model=DepartmentResponse, status_code=status.HTTP_201_CREATED)
async def create_department(
    payload: DepartmentCreate,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    dept = Department(
        code=payload.code.strip().upper(),
        name=payload.name.strip(),
    )
    db.add(dept)
    await db.flush()
    await db.refresh(dept)
    return dept


@router.patch("/departments/{department_id}", response_model=DepartmentResponse, summary="Update department details")
async def update_department(
    department_id: uuid.UUID,
    payload: DepartmentUpdate,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    stmt = select(Department).where(Department.id == department_id)
    res = await db.execute(stmt)
    dept = res.scalar_one_or_none()
    if not dept:
        raise EntityNotFoundError(f"Department {department_id} not found")

    if payload.code is not None:
        new_code = payload.code.strip().upper()
        exist_stmt = select(Department).where(
            Department.institution_id == dept.institution_id,
            Department.code == new_code,
            Department.id != department_id,
        )
        if (await db.execute(exist_stmt)).scalar_one_or_none():
            raise ConflictError(f"Department code '{new_code}' already exists")
        dept.code = new_code

    if payload.name is not None:
        dept.name = payload.name.strip()

    await db.flush()
    await db.refresh(dept)
    return dept


@router.delete("/departments/{department_id}", status_code=status.HTTP_200_OK, summary="Delete a department")
async def delete_department(
    department_id: uuid.UUID,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    stmt = select(Department).where(Department.id == department_id)
    res = await db.execute(stmt)
    dept = res.scalar_one_or_none()
    if not dept:
        raise EntityNotFoundError(f"Department {department_id} not found")

    subj_count_stmt = select(func.count(Subject.id)).where(Subject.department_id == department_id)
    sec_count_stmt = select(func.count(ClassSection.id)).where(ClassSection.department_id == department_id)
    subj_count = (await db.execute(subj_count_stmt)).scalar() or 0
    sec_count = (await db.execute(sec_count_stmt)).scalar() or 0

    if subj_count > 0 or sec_count > 0:
        raise ConflictError(
            f"Cannot delete department '{dept.code}': {subj_count} subjects and {sec_count} class sections are linked to it. Please reassign or delete them first."
        )

    await db.delete(dept)
    await db.flush()
    return {"message": f"Department '{dept.code}' deleted successfully", "id": str(department_id)}


@router.get("/terms", response_model=List[AcademicTermResponse], summary="List all academic terms")
async def list_terms(
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    stmt = select(AcademicTerm).order_by(AcademicTerm.start_date.desc())
    res = await db.execute(stmt)
    return res.scalars().all()


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


@router.get("/subjects", response_model=List[SubjectResponse], summary="List subjects")
async def list_subjects(
    department_id: Optional[uuid.UUID] = Query(None),
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    stmt = select(Subject)
    if department_id:
        stmt = stmt.where(Subject.department_id == department_id)
    stmt = stmt.order_by(Subject.code.asc())
    res = await db.execute(stmt)
    return res.scalars().all()


@router.post("/subjects", response_model=SubjectResponse, status_code=status.HTTP_201_CREATED)
async def create_subject(
    payload: SubjectCreate,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    subject = Subject(
        code=payload.code.strip().upper(),
        name=payload.name.strip(),
        department_id=payload.department_id,
        credits=payload.credits,
        is_active=payload.is_active,
    )
    db.add(subject)
    await db.flush()
    await db.refresh(subject)
    return subject


@router.patch("/subjects/{subject_id}", response_model=SubjectResponse, summary="Update subject details")
async def update_subject(
    subject_id: uuid.UUID,
    payload: SubjectUpdate,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    stmt = select(Subject).where(Subject.id == subject_id)
    res = await db.execute(stmt)
    subj = res.scalar_one_or_none()
    if not subj:
        raise EntityNotFoundError(f"Subject {subject_id} not found")

    if payload.code is not None:
        new_code = payload.code.strip().upper()
        exist_stmt = select(Subject).where(
            Subject.department_id == subj.department_id,
            Subject.code == new_code,
            Subject.id != subject_id,
        )
        if (await db.execute(exist_stmt)).scalar_one_or_none():
            raise ConflictError(f"Subject code '{new_code}' already exists in this department")
        subj.code = new_code

    if payload.name is not None:
        subj.name = payload.name.strip()
    if payload.credits is not None:
        subj.credits = payload.credits
    if payload.is_active is not None:
        subj.is_active = payload.is_active

    await db.flush()
    await db.refresh(subj)
    return subj


@router.delete("/subjects/{subject_id}", status_code=status.HTTP_200_OK, summary="Delete a subject")
async def delete_subject(
    subject_id: uuid.UUID,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    stmt = select(Subject).where(Subject.id == subject_id)
    res = await db.execute(stmt)
    subj = res.scalar_one_or_none()
    if not subj:
        raise EntityNotFoundError(f"Subject {subject_id} not found")

    from src.models.assignment import TeachingAssignment
    assign_count_stmt = select(func.count(TeachingAssignment.id)).where(TeachingAssignment.subject_id == subject_id)
    assign_count = (await db.execute(assign_count_stmt)).scalar() or 0
    if assign_count > 0:
        raise ConflictError(
            f"Cannot delete subject '{subj.code}': {assign_count} teaching assignments reference it. Deactivate the subject instead."
        )

    await db.delete(subj)
    await db.flush()
    return {"message": f"Subject '{subj.code}' deleted successfully", "id": str(subject_id)}


@router.get("/sections", response_model=List[ClassSectionResponse], summary="List class sections")
async def list_sections(
    department_id: Optional[uuid.UUID] = Query(None),
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    stmt = select(ClassSection)
    if department_id:
        stmt = stmt.where(ClassSection.department_id == department_id)
    stmt = stmt.order_by(ClassSection.section_code.asc())
    res = await db.execute(stmt)
    return res.scalars().all()


@router.post("/sections", response_model=ClassSectionResponse, status_code=status.HTTP_201_CREATED)
async def create_section(
    payload: ClassSectionCreate,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    section = ClassSection(
        section_code=payload.section_code.strip().upper(),
        department_id=payload.department_id,
        academic_term_id=payload.academic_term_id,
        cohort_year=payload.cohort_year,
    )
    db.add(section)
    await db.flush()
    await db.refresh(section)
    return section


@router.patch("/sections/{section_id}", response_model=ClassSectionResponse, summary="Update class section")
async def update_section(
    section_id: uuid.UUID,
    payload: ClassSectionUpdate,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    stmt = select(ClassSection).where(ClassSection.id == section_id)
    res = await db.execute(stmt)
    sec = res.scalar_one_or_none()
    if not sec:
        raise EntityNotFoundError(f"Class section {section_id} not found")

    if payload.section_code is not None:
        new_code = payload.section_code.strip().upper()
        sec.section_code = new_code
    if payload.cohort_year is not None:
        sec.cohort_year = payload.cohort_year

    await db.flush()
    await db.refresh(sec)
    return sec


@router.delete("/sections/{section_id}", status_code=status.HTTP_200_OK, summary="Delete a class section")
async def delete_section(
    section_id: uuid.UUID,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    stmt = select(ClassSection).where(ClassSection.id == section_id)
    res = await db.execute(stmt)
    sec = res.scalar_one_or_none()
    if not sec:
        raise EntityNotFoundError(f"Class section {section_id} not found")

    from src.models.assignment import TeachingAssignment
    from src.models.enrollment import StudentEnrollment
    assign_count_stmt = select(func.count(TeachingAssignment.id)).where(TeachingAssignment.class_section_id == section_id)
    enr_count_stmt = select(func.count(StudentEnrollment.id)).where(StudentEnrollment.class_section_id == section_id)
    assign_count = (await db.execute(assign_count_stmt)).scalar() or 0
    enr_count = (await db.execute(enr_count_stmt)).scalar() or 0

    if assign_count > 0 or enr_count > 0:
        raise ConflictError(
            f"Cannot delete class section '{sec.section_code}': {assign_count} assignments and {enr_count} student enrollments exist for this section."
        )

    await db.delete(sec)
    await db.flush()
    return {"message": f"Class section '{sec.section_code}' deleted successfully", "id": str(section_id)}


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


@router.patch("/assignments/{assignment_id}", response_model=TeachingAssignmentResponse, summary="Update teaching assignment")
async def update_teaching_assignment(
    assignment_id: uuid.UUID,
    payload: TeachingAssignmentUpdate,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    stmt = select(TeachingAssignment).where(TeachingAssignment.id == assignment_id)
    res = await db.execute(stmt)
    assignment = res.scalar_one_or_none()
    if not assignment:
        raise EntityNotFoundError(f"Teaching assignment {assignment_id} not found")

    if payload.faculty_user_id is not None:
        fac_stmt = select(User).where(User.id == payload.faculty_user_id)
        faculty = (await db.execute(fac_stmt)).scalar_one_or_none()
        if not faculty:
            raise EntityNotFoundError(f"Faculty user {payload.faculty_user_id} not found")
        assignment.faculty_user_id = payload.faculty_user_id

    if payload.is_active is not None:
        assignment.is_active = payload.is_active

    await db.flush()
    await db.refresh(assignment)
    return assignment


@router.delete("/assignments/{assignment_id}", status_code=status.HTTP_200_OK, summary="Delete or deactivate teaching assignment")
async def delete_teaching_assignment(
    assignment_id: uuid.UUID,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    stmt = select(TeachingAssignment).where(TeachingAssignment.id == assignment_id)
    res = await db.execute(stmt)
    assignment = res.scalar_one_or_none()
    if not assignment:
        raise EntityNotFoundError(f"Teaching assignment {assignment_id} not found")

    from src.models.attendance import AttendanceSession
    sess_count_stmt = select(func.count(AttendanceSession.id)).where(AttendanceSession.teaching_assignment_id == assignment_id)
    sess_count = (await db.execute(sess_count_stmt)).scalar() or 0

    if sess_count > 0:
        assignment.is_active = False
        await db.flush()
        return {
            "message": f"Teaching assignment deactivated because {sess_count} historical attendance sessions exist.",
            "id": str(assignment_id),
            "deactivated": True,
        }

    await db.delete(assignment)
    await db.flush()
    return {"message": "Teaching assignment deleted successfully", "id": str(assignment_id), "deactivated": False}


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
    roles: List[str] = []
    membership_id: Optional[uuid.UUID] = None


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
    inst_id, _ = await resolve_tenant_and_membership(None, admin_user, db)

    # 1. Fetch active role assignments directly for this institution
    now = datetime.now(timezone.utc)
    ra_stmt = (
        select(RoleAssignment)
        .options(selectinload(RoleAssignment.role_template))
        .where(
            RoleAssignment.institution_id == inst_id,
            RoleAssignment.status == AssignmentStatus.ACTIVE,
        )
    )
    all_ras = (await db.execute(ra_stmt)).scalars().all()
    membership_roles: Dict[uuid.UUID, List[str]] = {}
    for ra in all_ras:
        if ra.valid_until is None or ra.valid_until > now:
            code = ra.role_template.code if ra.role_template else None
            if code:
                roles_list = membership_roles.setdefault(ra.membership_id, [])
                if code not in roles_list:
                    roles_list.append(code)

    # Fetch memberships for this institution
    mem_stmt = (
        select(InstitutionMembership)
        .where(InstitutionMembership.institution_id == inst_id)
    )
    mem_res = await db.execute(mem_stmt)
    memberships = mem_res.scalars().all()
    user_to_membership: Dict[uuid.UUID, InstitutionMembership] = {m.user_id: m for m in memberships}

    # 2. Query users
    query = select(User)
    if q:
        query = query.where(User.full_name.ilike(f"%{q}%"))
    query = query.order_by(User.full_name.asc())
    res = await db.execute(query)
    users = res.scalars().all()

    items: List[AdminUserListItem] = []
    for u in users:
        membership = user_to_membership.get(u.id)
        active_roles: List[str] = list(membership_roles.get(membership.id, [])) if membership else []
        if u.role and u.role.value not in active_roles:
            active_roles.append(u.role.value)

        # Apply multi-role filter if specified
        if role:
            role_upper = role.upper()
            if role_upper == "FACULTY":
                matches = any(r in {"FACULTY", "TEACHING_ASSISTANT", "CLASS_ADVISOR", "DEPARTMENT_HEAD"} for r in active_roles) or u.role == UserRole.FACULTY
            elif role_upper == "ADMIN":
                matches = any(r in {
                    "ADMIN", "INSTITUTION_OWNER", "CENTRAL_INSTITUTION_ADMIN",
                    "CAMPUS_ADMIN", "ACCESS_ADMIN", "IT_ADMIN", "PRIVACY_BIOMETRIC_OFFICER", "DEPARTMENT_HEAD"
                } for r in active_roles) or u.role == UserRole.ADMIN
            elif role_upper == "STUDENT":
                matches = "STUDENT" in active_roles or u.role == UserRole.STUDENT
            else:
                matches = role_upper in active_roles or u.role.value == role_upper
            if not matches:
                continue

        subtitle_roles = ", ".join(r.replace("_", " ").title() for r in active_roles)
        items.append(
            AdminUserListItem(
                id=u.id,
                name=u.full_name,
                email=u.email,
                role=u.role.value,
                identifier=u.institutional_id,
                subtitle=f"{subtitle_roles} · {u.institutional_id}",
                tag=None,
                roles=active_roles,
                membership_id=membership.id if membership else None,
            )
        )
    return items


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


class AdminUserCreate(BaseModel):
    full_name: str
    email: str
    institutional_id: str
    password: str
    role: UserRole


class AdminUserUpdate(BaseModel):
    full_name: Optional[str] = None
    email: Optional[str] = None
    institutional_id: Optional[str] = None
    account_status: Optional[AccountStatus] = None


class UserRoleUpdate(BaseModel):
    role: UserRole


class FacultyAssignmentItem(BaseModel):
    id: uuid.UUID
    class_section_id: uuid.UUID
    section_code: str
    subject_id: uuid.UUID
    subject_code: str
    subject_name: str
    academic_term_id: uuid.UUID
    is_active: bool


@router.post("/users", response_model=AdminUserListItem, status_code=status.HTTP_201_CREATED, summary="Create a new user")
async def create_admin_user(
    payload: AdminUserCreate,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    exist_stmt = select(User).where(
        (User.institutional_id == payload.institutional_id.strip())
        | (User.email == payload.email.strip().lower())
    )
    res = await db.execute(exist_stmt)
    if res.scalar_one_or_none():
        raise ConflictError("A user with this Institutional ID or Email already exists")

    hashed_pw = get_password_hash(payload.password)
    new_user = User(
        institutional_id=payload.institutional_id.strip(),
        email=payload.email.strip().lower(),
        password_hash=hashed_pw,
        full_name=payload.full_name.strip(),
        role=payload.role,
        account_status=AccountStatus.ACTIVE,
    )
    db.add(new_user)
    await db.flush()
    await db.refresh(new_user)

    inst_res = await db.execute(select(Institution).limit(1))
    inst = inst_res.scalar_one_or_none()
    membership = None
    if inst:
        mem_stmt = select(InstitutionMembership).where(
            InstitutionMembership.institution_id == inst.id,
            InstitutionMembership.user_id == new_user.id,
        )
        membership = (await db.execute(mem_stmt)).scalar_one_or_none()
        if not membership:
            membership = InstitutionMembership(
                institution_id=inst.id,
                user_id=new_user.id,
                status=MembershipStatus.ACTIVE,
            )
            db.add(membership)
            await db.flush()
        # Seed matching canonical role template if available
        role_tpl_res = await db.execute(select(RoleTemplate).where(RoleTemplate.code == new_user.role.value))
        role_tpl = role_tpl_res.scalar_one_or_none()
        if role_tpl:
            ra_stmt = select(RoleAssignment).where(
                RoleAssignment.membership_id == membership.id,
                RoleAssignment.role_template_id == role_tpl.id,
            )
            existing_ra = (await db.execute(ra_stmt)).scalar_one_or_none()
            if not existing_ra:
                ra = RoleAssignment(
                    institution_id=inst.id,
                    membership_id=membership.id,
                    role_template_id=role_tpl.id,
                    status=AssignmentStatus.ACTIVE,
                    reason="Initial role assignment on account creation",
                )
                db.add(ra)
                await db.flush()

    active_roles = [new_user.role.value]
    return AdminUserListItem(
        id=new_user.id,
        name=new_user.full_name,
        email=new_user.email,
        role=new_user.role.value,
        identifier=new_user.institutional_id,
        subtitle=f"{new_user.role.value.capitalize()} · {new_user.institutional_id}",
        tag=None,
        roles=active_roles,
        membership_id=membership.id if membership else None,
    )


class UserAddRoleRequest(BaseModel):
    role_code: str
    scope_type: RoleScopeType = RoleScopeType.INSTITUTION
    reason: Optional[str] = "Granted via Admin Management Console"


@router.post("/users/{user_id}/roles", response_model=AdminUserListItem, summary="Add a role template to a user")
async def add_user_role(
    user_id: uuid.UUID,
    payload: UserAddRoleRequest,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    inst_id, _ = await resolve_tenant_and_membership(None, admin_user, db)
    user_stmt = select(User).where(User.id == user_id)
    user = (await db.execute(user_stmt)).scalar_one_or_none()
    if not user:
        raise EntityNotFoundError(f"User {user_id} not found")

    # Ensure membership
    mem_stmt = (
        select(InstitutionMembership)
        .options(selectinload(InstitutionMembership.role_assignments).selectinload(RoleAssignment.role_template))
        .where(
            InstitutionMembership.user_id == user.id,
            InstitutionMembership.institution_id == inst_id,
        )
    )
    membership = (await db.execute(mem_stmt)).scalar_one_or_none()
    if not membership:
        membership = InstitutionMembership(
            institution_id=inst_id,
            user_id=user.id,
            status=MembershipStatus.ACTIVE,
        )
        db.add(membership)
        await db.flush()
        await db.refresh(membership)

    target_code = payload.role_code.strip().upper()
    tpl_stmt = select(RoleTemplate).where(RoleTemplate.code == target_code)
    tpl = (await db.execute(tpl_stmt)).scalar_one_or_none()
    if not tpl:
        ROLE_ALIASES = {
            "PRIVACY_BIOMETRIC_OFFICER": "PRIVACY_BIOMETRIC_GOVERNANCE",
            "PRIVACY_BIOMETRIC_GOVERNANCE": "PRIVACY_BIOMETRIC_OFFICER",
            "DEPARTMENT_HEAD": "DEPARTMENT_HEAD_COORDINATOR",
            "DEPARTMENT_HEAD_COORDINATOR": "DEPARTMENT_HEAD",
        }
        alias = ROLE_ALIASES.get(target_code)
        if alias:
            tpl = (await db.execute(select(RoleTemplate).where(RoleTemplate.code == alias))).scalar_one_or_none()
    if not tpl:
        raise EntityNotFoundError(f"Role template '{payload.role_code}' not found")

    # Check if already active
    existing_ra = next((ra for ra in (membership.role_assignments or []) if ra.role_template_id == tpl.id and ra.status == AssignmentStatus.ACTIVE), None)
    if not existing_ra:
        new_ra = RoleAssignment(
            institution_id=inst_id,
            membership_id=membership.id,
            role_template_id=tpl.id,
            role_template=tpl,
            status=AssignmentStatus.ACTIVE,
            reason=payload.reason or "Granted via Admin Management Console",
        )
        db.add(new_ra)
        await db.flush()

    # Query all active role assignments
    ra_stmt = (
        select(RoleAssignment)
        .options(selectinload(RoleAssignment.role_template))
        .where(
            RoleAssignment.membership_id == membership.id,
            RoleAssignment.status == AssignmentStatus.ACTIVE,
        )
    )
    all_ras = (await db.execute(ra_stmt)).scalars().all()
    now = datetime.now(timezone.utc)
    active_roles: List[str] = []
    for ra in all_ras:
        if ra.valid_until is None or ra.valid_until > now:
            code = (ra.role_template.code if ra.role_template else None) or (tpl.code if ra.role_template_id == tpl.id else None)
            if code and code not in active_roles:
                active_roles.append(code)
    if user.role and user.role.value not in active_roles:
        active_roles.append(user.role.value)

    subtitle_roles = ", ".join(r.replace("_", " ").title() for r in active_roles)
    return AdminUserListItem(
        id=user.id,
        name=user.full_name,
        email=user.email,
        role=user.role.value,
        identifier=user.institutional_id,
        subtitle=f"{subtitle_roles} · {user.institutional_id}",
        tag=None,
        roles=active_roles,
        membership_id=membership.id,
    )


@router.delete("/users/{user_id}/roles/{role_code}", response_model=AdminUserListItem, summary="Revoke a role from a user")
async def revoke_user_role(
    user_id: uuid.UUID,
    role_code: str,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    inst_id, _ = await resolve_tenant_and_membership(None, admin_user, db)
    user_stmt = select(User).where(User.id == user_id)
    user = (await db.execute(user_stmt)).scalar_one_or_none()
    if not user:
        raise EntityNotFoundError(f"User {user_id} not found")

    mem_stmt = (
        select(InstitutionMembership)
        .options(selectinload(InstitutionMembership.role_assignments).selectinload(RoleAssignment.role_template))
        .where(
            InstitutionMembership.user_id == user.id,
            InstitutionMembership.institution_id == inst_id,
        )
    )
    membership = (await db.execute(mem_stmt)).scalar_one_or_none()
    if membership:
        target_code = role_code.strip().upper()
        ROLE_ALIASES = {
            "PRIVACY_BIOMETRIC_OFFICER": "PRIVACY_BIOMETRIC_GOVERNANCE",
            "PRIVACY_BIOMETRIC_GOVERNANCE": "PRIVACY_BIOMETRIC_OFFICER",
            "DEPARTMENT_HEAD": "DEPARTMENT_HEAD_COORDINATOR",
            "DEPARTMENT_HEAD_COORDINATOR": "DEPARTMENT_HEAD",
        }
        alias = ROLE_ALIASES.get(target_code)
        target_codes = {target_code, alias} if alias else {target_code}

        # Revoke matching role assignments
        for ra in (membership.role_assignments or []):
            if ((ra.role_template and ra.role_template.code in target_codes) or ra.role_template_id in (
                select(RoleTemplate.id).where(RoleTemplate.code.in_(target_codes)).scalar_subquery()
            )) and ra.status == AssignmentStatus.ACTIVE:
                ra.status = AssignmentStatus.REVOKED
                ra.reason = f"Revoked {target_code} role via Admin Console"
        # Also direct query update to be completely certain
        tpl_targets = (await db.execute(select(RoleTemplate).where(RoleTemplate.code.in_(target_codes)))).scalars().all()
        for tpl_target in tpl_targets:
            direct_ras = (await db.execute(
                select(RoleAssignment).where(
                    RoleAssignment.membership_id == membership.id,
                    RoleAssignment.role_template_id == tpl_target.id,
                    RoleAssignment.status == AssignmentStatus.ACTIVE,
                )
            )).scalars().all()
            for r in direct_ras:
                r.status = AssignmentStatus.REVOKED
                r.reason = f"Revoked {target_code} role via Admin Console"
        await db.flush()

    # Query remaining active roles
    active_roles: List[str] = []
    if membership:
        ra_stmt = (
            select(RoleAssignment)
            .options(selectinload(RoleAssignment.role_template))
            .where(
                RoleAssignment.membership_id == membership.id,
                RoleAssignment.status == AssignmentStatus.ACTIVE,
            )
        )
        all_ras = (await db.execute(ra_stmt)).scalars().all()
        now = datetime.now(timezone.utc)
        for ra in all_ras:
            if ra.valid_until is None or ra.valid_until > now:
                code = ra.role_template.code if ra.role_template else None
                if code and code not in active_roles:
                    active_roles.append(code)

    if not active_roles and user.role and user.role.value != role_code.strip().upper():
        active_roles.append(user.role.value)
    elif user.role and user.role.value not in active_roles and user.role.value != role_code.strip().upper():
        active_roles.append(user.role.value)

    subtitle_roles = ", ".join(r.replace("_", " ").title() for r in active_roles) if active_roles else user.role.value.capitalize()
    return AdminUserListItem(
        id=user.id,
        name=user.full_name,
        email=user.email,
        role=user.role.value,
        identifier=user.institutional_id,
        subtitle=f"{subtitle_roles} · {user.institutional_id}",
        tag=None,
        roles=active_roles,
        membership_id=membership.id if membership else None,
    )


@router.patch("/users/{user_id}/role", response_model=AdminUserListItem, summary="Update user role")
async def update_user_role(
    user_id: uuid.UUID,
    payload: UserRoleUpdate,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    stmt = select(User).where(User.id == user_id)
    res = await db.execute(stmt)
    user = res.scalar_one_or_none()
    if not user:
        raise EntityNotFoundError(f"User {user_id} not found")

    user.role = payload.role
    await db.flush()

    inst_id, _ = await resolve_tenant_and_membership(None, admin_user, db)
    mem_stmt = (
        select(InstitutionMembership)
        .options(selectinload(InstitutionMembership.role_assignments).selectinload(RoleAssignment.role_template))
        .where(
            InstitutionMembership.user_id == user.id,
            InstitutionMembership.institution_id == inst_id,
        )
    )
    membership = (await db.execute(mem_stmt)).scalar_one_or_none()
    if membership:
        tpl_stmt = select(RoleTemplate).where(RoleTemplate.code == payload.role.value)
        tpl = (await db.execute(tpl_stmt)).scalar_one_or_none()
        if tpl:
            existing = any(ra.role_template_id == tpl.id and ra.status == AssignmentStatus.ACTIVE for ra in membership.role_assignments)
            if not existing:
                new_ra = RoleAssignment(
                    institution_id=inst_id,
                    membership_id=membership.id,
                    role_template_id=tpl.id,
                    status=AssignmentStatus.ACTIVE,
                    reason=f"Assigned {payload.role.value} role via Admin Console",
                )
                db.add(new_ra)
                await db.flush()
                await db.refresh(membership)

    refreshed_mem = (await db.execute(mem_stmt)).scalar_one_or_none()
    now = datetime.now(timezone.utc)
    active_roles: List[str] = []
    if refreshed_mem:
        for ra in refreshed_mem.role_assignments:
            if ra.status == AssignmentStatus.ACTIVE and (ra.valid_until is None or ra.valid_until > now):
                if ra.role_template and ra.role_template.code not in active_roles:
                    active_roles.append(ra.role_template.code)
    if user.role and user.role.value not in active_roles:
        active_roles.append(user.role.value)

    subtitle_roles = ", ".join(r.replace("_", " ").title() for r in active_roles)
    return AdminUserListItem(
        id=user.id,
        name=user.full_name,
        email=user.email,
        role=user.role.value,
        identifier=user.institutional_id,
        subtitle=f"{subtitle_roles} · {user.institutional_id}",
        tag=None,
        roles=active_roles,
        membership_id=membership.id if membership else None,
    )


@router.patch("/users/{user_id}", response_model=AdminUserListItem, summary="Update user details")
async def update_admin_user(
    user_id: uuid.UUID,
    payload: AdminUserUpdate,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    stmt = select(User).where(User.id == user_id)
    res = await db.execute(stmt)
    user = res.scalar_one_or_none()
    if not user:
        raise EntityNotFoundError(f"User {user_id} not found")

    if payload.email is not None:
        new_email = payload.email.strip().lower()
        exist_stmt = select(User).where(User.email == new_email, User.id != user_id)
        if (await db.execute(exist_stmt)).scalar_one_or_none():
            raise ConflictError(f"Email '{new_email}' is already in use by another user")
        user.email = new_email

    if payload.institutional_id is not None:
        new_id = payload.institutional_id.strip()
        exist_stmt = select(User).where(User.institutional_id == new_id, User.id != user_id)
        if (await db.execute(exist_stmt)).scalar_one_or_none():
            raise ConflictError(f"Institutional ID '{new_id}' is already in use by another user")
        user.institutional_id = new_id

    if payload.full_name is not None:
        user.full_name = payload.full_name.strip()

    if payload.account_status is not None:
        user.account_status = payload.account_status

    await db.flush()
    await db.refresh(user)

    inst_id, _ = await resolve_tenant_and_membership(None, admin_user, db)
    mem_stmt = (
        select(InstitutionMembership)
        .options(selectinload(InstitutionMembership.role_assignments).selectinload(RoleAssignment.role_template))
        .where(
            InstitutionMembership.user_id == user.id,
            InstitutionMembership.institution_id == inst_id,
        )
    )
    membership = (await db.execute(mem_stmt)).scalar_one_or_none()
    now = datetime.now(timezone.utc)
    active_roles: List[str] = []
    if membership:
        for ra in membership.role_assignments:
            if ra.status == AssignmentStatus.ACTIVE and (ra.valid_until is None or ra.valid_until > now):
                if ra.role_template and ra.role_template.code not in active_roles:
                    active_roles.append(ra.role_template.code)
    if user.role and user.role.value not in active_roles:
        active_roles.append(user.role.value)

    subtitle_roles = ", ".join(r.replace("_", " ").title() for r in active_roles)
    return AdminUserListItem(
        id=user.id,
        name=user.full_name,
        email=user.email,
        role=user.role.value,
        identifier=user.institutional_id,
        subtitle=f"{subtitle_roles} · {user.institutional_id}",
        tag=None,
        roles=active_roles,
        membership_id=membership.id if membership else None,
    )


@router.delete("/users/{user_id}", status_code=status.HTTP_200_OK, summary="Deactivate or delete user")
async def delete_admin_user(
    user_id: uuid.UUID,
    hard_delete: bool = Query(False),
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    if user_id == admin_user.id:
        raise ConflictError("You cannot delete or deactivate your own account")

    stmt = select(User).where(User.id == user_id)
    res = await db.execute(stmt)
    user = res.scalar_one_or_none()
    if not user:
        raise EntityNotFoundError(f"User {user_id} not found")

    from src.models.attendance import AttendanceRecord, AttendanceSession
    from src.models.enrollment import StudentEnrollment
    from src.models.assignment import TeachingAssignment

    # Check for linked operational / audit data
    sess_count = (await db.execute(
        select(func.count(AttendanceSession.id)).where(
            (AttendanceSession.conducting_faculty_user_id == user.id)
            | (AttendanceSession.regular_faculty_user_id == user.id)
        )
    )).scalar() or 0

    att_count = (await db.execute(
        select(func.count(AttendanceRecord.id)).where(AttendanceRecord.student_user_id == user.id)
    )).scalar() or 0

    enr_count = (await db.execute(
        select(func.count(StudentEnrollment.id)).where(StudentEnrollment.student_user_id == user.id)
    )).scalar() or 0

    assign_count = (await db.execute(
        select(func.count(TeachingAssignment.id)).where(TeachingAssignment.faculty_user_id == user.id)
    )).scalar() or 0

    has_history = sess_count > 0 or att_count > 0 or enr_count > 0 or assign_count > 0

    if not hard_delete or has_history:
        # Soft-deactivate to guarantee immutable attendance history
        user.account_status = AccountStatus.ARCHIVED
        mem_stmt = select(InstitutionMembership).where(InstitutionMembership.user_id == user.id)
        memberships = (await db.execute(mem_stmt)).scalars().all()
        for m in memberships:
            m.status = MembershipStatus.SUSPENDED
            ra_stmt = select(RoleAssignment).where(RoleAssignment.membership_id == m.id)
            ras = (await db.execute(ra_stmt)).scalars().all()
            for ra in ras:
                ra.status = AssignmentStatus.REVOKED
        await db.flush()
        detail = (
            f"User '{user.full_name}' deactivated and suspended. Attendance and academic audit records preserved."
            if has_history
            else f"User '{user.full_name}' deactivated."
        )
        return {"message": detail, "id": str(user.id), "deactivated": True}

    # If hard delete requested and user has zero historical attendance or academic dependencies:
    mem_stmt = select(InstitutionMembership).where(InstitutionMembership.user_id == user.id)
    memberships = (await db.execute(mem_stmt)).scalars().all()
    for m in memberships:
        ra_stmt = select(RoleAssignment).where(RoleAssignment.membership_id == m.id)
        ras = (await db.execute(ra_stmt)).scalars().all()
        for ra in ras:
            await db.delete(ra)
        await db.delete(m)

    try:
        from src.models.enrollment import StudentFaceProfile
        fp_stmt = select(StudentFaceProfile).where(StudentFaceProfile.student_user_id == user.id)
        fps = (await db.execute(fp_stmt)).scalars().all()
        for fp in fps:
            await db.delete(fp)
    except Exception:
        pass

    await db.delete(user)
    await db.flush()
    return {"message": f"User '{user.full_name}' permanently deleted.", "id": str(user.id), "deactivated": False}


@router.get("/faculty/{faculty_id}/assignments", response_model=List[FacultyAssignmentItem], summary="Get teaching assignments for faculty")
async def get_faculty_assignments(
    faculty_id: uuid.UUID,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    stmt = (
        select(TeachingAssignment)
        .options(
            selectinload(TeachingAssignment.class_section),
            selectinload(TeachingAssignment.subject),
        )
        .where(TeachingAssignment.faculty_user_id == faculty_id)
        .order_by(TeachingAssignment.created_at.desc())
    )
    res = await db.execute(stmt)
    assignments = res.scalars().all()
    return [
        FacultyAssignmentItem(
            id=a.id,
            class_section_id=a.class_section_id,
            section_code=a.class_section.section_code if a.class_section else "N/A",
            subject_id=a.subject_id,
            subject_code=a.subject.code if a.subject else "N/A",
            subject_name=a.subject.name if a.subject else "N/A",
            academic_term_id=a.academic_term_id,
            is_active=a.is_active,
        )
        for a in assignments
    ]


# ==========================================
# CAMPUS OPERATIONS (IAC v1 Section 43/44)
# ==========================================

@router.get("/campuses", response_model=List[CampusResponse], summary="List all campuses in institution")
async def list_campuses(
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    inst_id, _ = await resolve_tenant_and_membership(None, admin_user, db)
    stmt = select(Campus).where(Campus.institution_id == inst_id).order_by(Campus.name.asc())
    res = await db.execute(stmt)
    return res.scalars().all()


@router.post("/campuses", response_model=CampusResponse, status_code=status.HTTP_201_CREATED, summary="Create a new campus")
async def create_campus(
    payload: CampusCreate,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    inst_id, membership = await resolve_tenant_and_membership(None, admin_user, db)
    target_inst_id = payload.institution_id or inst_id

    # Check unique code within institution
    exist_stmt = select(Campus).where(
        Campus.institution_id == target_inst_id,
        Campus.code == payload.code.strip().upper(),
    )
    if (await db.execute(exist_stmt)).scalar_one_or_none():
        raise ConflictError(f"Campus with code '{payload.code}' already exists in this institution")

    campus = Campus(
        institution_id=target_inst_id,
        code=payload.code.strip().upper(),
        name=payload.name.strip(),
        status=CampusStatus.ACTIVE,
    )
    db.add(campus)
    await db.flush()
    await db.refresh(campus)

    audit = AuthorizationAudit(
        actor_user_id=admin_user.id,
        actor_membership_id=membership.id,
        institution_id=target_inst_id,
        action="campus.create",
        permission_code="campus.create",
        target_resource_type="CAMPUS",
        target_resource_id=str(campus.id),
        outcome=AuditOutcome.ALLOWED,
        reason=f"Created campus {campus.code} - {campus.name}",
    )
    db.add(audit)
    await db.flush()
    return campus


@router.patch("/campuses/{campus_id}", response_model=CampusResponse, summary="Update campus details or status")
async def update_campus(
    campus_id: uuid.UUID,
    payload: CampusUpdate,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    inst_id, membership = await resolve_tenant_and_membership(None, admin_user, db)
    stmt = select(Campus).where(Campus.id == campus_id, Campus.institution_id == inst_id)
    campus = (await db.execute(stmt)).scalar_one_or_none()
    if not campus:
        raise EntityNotFoundError(f"Campus {campus_id} not found in this institution")

    if payload.name is not None:
        campus.name = payload.name.strip()
    if payload.status is not None:
        campus.status = payload.status

    await db.flush()
    await db.refresh(campus)

    audit = AuthorizationAudit(
        actor_user_id=admin_user.id,
        actor_membership_id=membership.id,
        institution_id=inst_id,
        action="campus.update",
        permission_code="campus.update",
        target_resource_type="CAMPUS",
        target_resource_id=str(campus.id),
        outcome=AuditOutcome.ALLOWED,
        reason=f"Updated campus {campus.code}",
    )
    db.add(audit)
    await db.flush()
    return campus


@router.delete("/campuses/{campus_id}", status_code=status.HTTP_200_OK, summary="Delete a campus")
async def delete_campus(
    campus_id: uuid.UUID,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    inst_id, membership = await resolve_tenant_and_membership(None, admin_user, db)
    stmt = select(Campus).where(Campus.id == campus_id, Campus.institution_id == inst_id)
    campus = (await db.execute(stmt)).scalar_one_or_none()
    if not campus:
        raise EntityNotFoundError(f"Campus {campus_id} not found in this institution")

    sec_count = (await db.execute(select(func.count(ClassSection.id)).where(ClassSection.campus_id == campus_id))).scalar() or 0
    if sec_count > 0:
        raise ConflictError(
            f"Cannot delete campus '{campus.code}': {sec_count} class sections are assigned to it. Reassign or delete sections first."
        )

    await db.delete(campus)
    await db.flush()

    audit = AuthorizationAudit(
        actor_user_id=admin_user.id,
        actor_membership_id=membership.id,
        institution_id=inst_id,
        action="campus.delete",
        permission_code="campus.delete",
        target_resource_type="CAMPUS",
        target_resource_id=str(campus.id),
        outcome=AuditOutcome.ALLOWED,
        reason=f"Deleted campus {campus.code}",
    )
    db.add(audit)
    await db.flush()
    return {"message": f"Campus '{campus.code}' deleted successfully", "id": str(campus_id)}


# ==========================================
# INSTITUTIONAL RBAC v1 MANAGEMENT (Sec 2.6)
# ==========================================

@router.get(
    "/access-control/role-templates",
    response_model=List[RoleTemplateResponse],
    summary="List all fixed role templates with permissions",
)
async def list_role_templates(
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    stmt = (
        select(RoleTemplate)
        .options(selectinload(RoleTemplate.permissions))
        .where(RoleTemplate.is_active == True)
        .order_by(RoleTemplate.category.asc(), RoleTemplate.name.asc())
    )
    res = await db.execute(stmt)
    templates = res.scalars().all()
    return [
        RoleTemplateResponse(
            id=t.id,
            code=t.code,
            name=t.name,
            category=t.category,
            description=t.description,
            is_system_defined=t.is_system_defined,
            is_active=t.is_active,
            permissions=[
                PermissionResponse(
                    id=p.id,
                    code=p.code,
                    resource=p.resource,
                    action=p.action,
                    description=p.description,
                    is_sensitive=p.is_sensitive,
                )
                for p in t.permissions
            ],
        )
        for t in templates
    ]


@router.get(
    "/access-control/memberships",
    response_model=List[InstitutionMembershipResponse],
    summary="List institution memberships and role assignments",
)
async def list_institution_memberships(
    request: Request,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    inst_id, _ = await resolve_tenant_and_membership(request, admin_user, db)
    stmt = (
        select(InstitutionMembership)
        .options(
            selectinload(InstitutionMembership.user),
            selectinload(InstitutionMembership.role_assignments).selectinload(RoleAssignment.role_template),
            selectinload(InstitutionMembership.role_assignments).selectinload(RoleAssignment.scopes),
        )
        .where(InstitutionMembership.institution_id == inst_id)
        .order_by(InstitutionMembership.joined_at.desc())
    )
    res = await db.execute(stmt)
    memberships = res.scalars().all()

    items = []
    for m in memberships:
        assignments = []
        for a in m.role_assignments:
            scopes = [
                RoleAssignmentScopeResponse(
                    id=s.id,
                    role_assignment_id=s.role_assignment_id,
                    institution_id=s.institution_id,
                    scope_type=s.scope_type,
                    campus_id=s.campus_id,
                    department_id=s.department_id,
                    academic_term_id=s.academic_term_id,
                    class_section_id=s.class_section_id,
                    teaching_assignment_id=s.teaching_assignment_id,
                    student_user_id=s.student_user_id,
                )
                for s in a.scopes
            ]
            assignments.append(
                RoleAssignmentResponse(
                    id=a.id,
                    institution_id=a.institution_id,
                    membership_id=a.membership_id,
                    role_template_id=a.role_template_id,
                    role_template_code=a.role_template.code if a.role_template else "UNKNOWN",
                    role_template_name=a.role_template.name if a.role_template else "Unknown",
                    status=a.status,
                    valid_from=a.valid_from,
                    valid_until=a.valid_until,
                    reason=a.reason,
                    scopes=scopes,
                    created_at=a.created_at,
                )
            )

        items.append(
            InstitutionMembershipResponse(
                id=m.id,
                institution_id=m.institution_id,
                user_id=m.user_id,
                user_name=m.user.full_name if m.user else "Unknown",
                user_email=m.user.email if m.user else "Unknown",
                institutional_id=m.user.institutional_id if m.user else "Unknown",
                legacy_role=m.user.role.value if m.user else "Unknown",
                status=m.status,
                joined_at=m.joined_at,
                role_assignments=assignments,
            )
        )
    return items


@router.post(
    "/access-control/role-assignments",
    response_model=RoleAssignmentResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Assign role template with explicit scope to user membership",
)
async def create_role_assignment(
    payload: RoleAssignmentCreate,
    request: Request,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    inst_id, admin_membership = await resolve_tenant_and_membership(request, admin_user, db)

    # 1. Verify target membership
    mem_stmt = select(InstitutionMembership).where(
        InstitutionMembership.id == payload.membership_id,
        InstitutionMembership.institution_id == inst_id,
    )
    membership = (await db.execute(mem_stmt)).scalar_one_or_none()
    if not membership:
        raise EntityNotFoundError(f"Membership {payload.membership_id} not found in this institution")
    if membership.status != MembershipStatus.ACTIVE:
        raise ConflictError(f"Cannot assign roles to membership with status {membership.status}")

    # 2. Verify role template
    tpl_stmt = select(RoleTemplate).where(RoleTemplate.id == payload.role_template_id)
    tpl = (await db.execute(tpl_stmt)).scalar_one_or_none()
    if not tpl:
        raise EntityNotFoundError(f"RoleTemplate {payload.role_template_id} not found")

    # Protection: Cannot assign INSTITUTION_OWNER via standard assignment
    if tpl.code == "INSTITUTION_OWNER":
        raise ConflictError("INSTITUTION_OWNER cannot be assigned via standard role assignment. Use ownership bootstrap/transfer.")

    # 3. Create role assignment
    assignment = RoleAssignment(
        institution_id=inst_id,
        membership_id=membership.id,
        role_template_id=tpl.id,
        status=AssignmentStatus.ACTIVE,
        valid_from=payload.valid_from or datetime.utcnow(),
        valid_until=payload.valid_until,
        granted_by_membership_id=admin_membership.id,
        reason=payload.reason or f"Assigned by {admin_user.full_name}",
    )
    db.add(assignment)
    await db.flush()

    # 4. Create explicit scope
    scope = RoleAssignmentScope(
        role_assignment_id=assignment.id,
        institution_id=inst_id,
        scope_type=payload.scope_type,
        campus_id=payload.campus_id if payload.scope_type == RoleScopeType.CAMPUS else None,
        department_id=payload.department_id if payload.scope_type == RoleScopeType.DEPARTMENT else None,
        academic_term_id=payload.academic_term_id if payload.scope_type == RoleScopeType.ACADEMIC_TERM else None,
        class_section_id=payload.class_section_id if payload.scope_type == RoleScopeType.CLASS_SECTION else None,
        teaching_assignment_id=payload.teaching_assignment_id if payload.scope_type == RoleScopeType.TEACHING_ASSIGNMENT else None,
        student_user_id=payload.student_user_id if payload.scope_type == RoleScopeType.STUDENT else None,
    )
    db.add(scope)
    await db.flush()
    await db.refresh(assignment)

    # 5. Audit
    audit = AuthorizationAudit(
        actor_user_id=admin_user.id,
        actor_membership_id=admin_membership.id,
        institution_id=inst_id,
        action="role_assignment.create",
        permission_code="role_assignment.create",
        target_resource_type="ROLE_ASSIGNMENT",
        target_resource_id=str(assignment.id),
        outcome=AuditOutcome.ALLOWED,
        reason=f"Assigned {tpl.code} ({payload.scope_type}) to membership {membership.id}",
    )
    db.add(audit)
    await db.flush()

    return RoleAssignmentResponse(
        id=assignment.id,
        institution_id=assignment.institution_id,
        membership_id=assignment.membership_id,
        role_template_id=assignment.role_template_id,
        role_template_code=tpl.code,
        role_template_name=tpl.name,
        status=assignment.status,
        valid_from=assignment.valid_from,
        valid_until=assignment.valid_until,
        reason=assignment.reason,
        scopes=[
            RoleAssignmentScopeResponse(
                id=scope.id,
                role_assignment_id=scope.role_assignment_id,
                institution_id=scope.institution_id,
                scope_type=scope.scope_type,
                campus_id=scope.campus_id,
                department_id=scope.department_id,
                academic_term_id=scope.academic_term_id,
                class_section_id=scope.class_section_id,
                teaching_assignment_id=scope.teaching_assignment_id,
                student_user_id=scope.student_user_id,
            )
        ],
        created_at=assignment.created_at,
    )


@router.patch(
    "/access-control/role-assignments/{assignment_id}/status",
    response_model=RoleAssignmentResponse,
    summary="Suspend or revoke a role assignment",
)
async def update_role_assignment_status(
    assignment_id: uuid.UUID,
    payload: RoleAssignmentStatusUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    inst_id, admin_membership = await resolve_tenant_and_membership(request, admin_user, db)

    stmt = (
        select(RoleAssignment)
        .options(selectinload(RoleAssignment.role_template), selectinload(RoleAssignment.scopes))
        .where(RoleAssignment.id == assignment_id, RoleAssignment.institution_id == inst_id)
    )
    assignment = (await db.execute(stmt)).scalar_one_or_none()
    if not assignment:
        raise EntityNotFoundError(f"RoleAssignment {assignment_id} not found in this institution")

    assignment.status = payload.status
    if payload.reason:
        assignment.reason = payload.reason
    await db.flush()

    # Audit
    audit = AuthorizationAudit(
        actor_user_id=admin_user.id,
        actor_membership_id=admin_membership.id,
        institution_id=inst_id,
        action="role_assignment.revoke",
        permission_code="role_assignment.revoke",
        target_resource_type="ROLE_ASSIGNMENT",
        target_resource_id=str(assignment.id),
        outcome=AuditOutcome.ALLOWED,
        reason=f"Updated assignment status to {payload.status}: {payload.reason or 'No reason provided'}",
    )
    db.add(audit)
    await db.flush()

    return RoleAssignmentResponse(
        id=assignment.id,
        institution_id=assignment.institution_id,
        membership_id=assignment.membership_id,
        role_template_id=assignment.role_template_id,
        role_template_code=assignment.role_template.code if assignment.role_template else "UNKNOWN",
        role_template_name=assignment.role_template.name if assignment.role_template else "Unknown",
        status=assignment.status,
        valid_from=assignment.valid_from,
        valid_until=assignment.valid_until,
        reason=assignment.reason,
        scopes=[
            RoleAssignmentScopeResponse(
                id=s.id,
                role_assignment_id=s.role_assignment_id,
                institution_id=s.institution_id,
                scope_type=s.scope_type,
                campus_id=s.campus_id,
                department_id=s.department_id,
                academic_term_id=s.academic_term_id,
                class_section_id=s.class_section_id,
                teaching_assignment_id=s.teaching_assignment_id,
                student_user_id=s.student_user_id,
            )
            for s in assignment.scopes
        ],
        created_at=assignment.created_at,
    )


@router.get(
    "/access-control/delegations",
    response_model=List[DelegationResponse],
    summary="List all authority delegations with status",
)
async def list_delegations(
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    inst_id, _ = await resolve_tenant_and_membership(None, admin_user, db)
    stmt = (
        select(Delegation)
        .options(
            selectinload(Delegation.grantor_assignment).selectinload(RoleAssignment.membership).selectinload(InstitutionMembership.user),
            selectinload(Delegation.grantee_membership).selectinload(InstitutionMembership.user),
        )
        .where(Delegation.institution_id == inst_id)
        .order_by(Delegation.created_at.desc())
    )
    res = await db.execute(stmt)
    delegations = res.scalars().all()

    items = []
    for d in delegations:
        grantor_name = "Unknown"
        if d.grantor_assignment and d.grantor_assignment.membership and d.grantor_assignment.membership.user:
            grantor_name = d.grantor_assignment.membership.user.full_name

        grantee_name = "Unknown"
        if d.grantee_membership and d.grantee_membership.user:
            grantee_name = d.grantee_membership.user.full_name

        items.append(
            DelegationResponse(
                id=d.id,
                institution_id=d.institution_id,
                grantor_role_assignment_id=d.grantor_role_assignment_id,
                grantor_user_name=grantor_name,
                grantee_membership_id=d.grantee_membership_id,
                grantee_user_name=grantee_name,
                status=d.status,
                valid_from=d.valid_from,
                valid_until=d.valid_until,
                reason=d.reason,
                approved_at=d.approved_at,
                revoked_at=d.revoked_at,
                revocation_reason=d.revocation_reason,
                created_at=d.created_at,
            )
        )
    return items


@router.patch(
    "/access-control/delegations/{delegation_id}/approve",
    response_model=DelegationResponse,
    summary="Approve delegation request",
)
async def approve_delegation(
    delegation_id: uuid.UUID,
    request: Request,
    payload: DelegationAction = DelegationAction(),
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    inst_id, admin_membership = await resolve_tenant_and_membership(request, admin_user, db)
    stmt = (
        select(Delegation)
        .options(
            selectinload(Delegation.grantor_assignment).selectinload(RoleAssignment.membership).selectinload(InstitutionMembership.user),
            selectinload(Delegation.grantee_membership).selectinload(InstitutionMembership.user),
        )
        .where(Delegation.id == delegation_id, Delegation.institution_id == inst_id)
    )
    d = (await db.execute(stmt)).scalar_one_or_none()
    if not d:
        raise EntityNotFoundError(f"Delegation {delegation_id} not found in this institution")

    d.status = DelegationLifecycleStatus.ACTIVE
    d.approved_at = datetime.utcnow()
    d.approved_by_membership_id = admin_membership.id
    await db.flush()

    audit = AuthorizationAudit(
        actor_user_id=admin_user.id,
        actor_membership_id=admin_membership.id,
        institution_id=inst_id,
        action="delegation.approve",
        permission_code="delegation.approve",
        target_resource_type="DELEGATION",
        target_resource_id=str(d.id),
        outcome=AuditOutcome.ALLOWED,
        reason=f"Approved delegation {d.id}: {payload.reason or 'Policy approval'}",
    )
    db.add(audit)
    await db.flush()

    grantor_name = d.grantor_assignment.membership.user.full_name if d.grantor_assignment and d.grantor_assignment.membership and d.grantor_assignment.membership.user else "Unknown"
    grantee_name = d.grantee_membership.user.full_name if d.grantee_membership and d.grantee_membership.user else "Unknown"

    return DelegationResponse(
        id=d.id,
        institution_id=d.institution_id,
        grantor_role_assignment_id=d.grantor_role_assignment_id,
        grantor_user_name=grantor_name,
        grantee_membership_id=d.grantee_membership_id,
        grantee_user_name=grantee_name,
        status=d.status,
        valid_from=d.valid_from,
        valid_until=d.valid_until,
        reason=d.reason,
        approved_at=d.approved_at,
        revoked_at=d.revoked_at,
        revocation_reason=d.revocation_reason,
        created_at=d.created_at,
    )


@router.patch(
    "/access-control/delegations/{delegation_id}/revoke",
    response_model=DelegationResponse,
    summary="Revoke active delegation",
)
async def revoke_delegation(
    delegation_id: uuid.UUID,
    request: Request,
    payload: DelegationAction = DelegationAction(),
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    inst_id, admin_membership = await resolve_tenant_and_membership(request, admin_user, db)
    stmt = (
        select(Delegation)
        .options(
            selectinload(Delegation.grantor_assignment).selectinload(RoleAssignment.membership).selectinload(InstitutionMembership.user),
            selectinload(Delegation.grantee_membership).selectinload(InstitutionMembership.user),
        )
        .where(Delegation.id == delegation_id, Delegation.institution_id == inst_id)
    )
    d = (await db.execute(stmt)).scalar_one_or_none()
    if not d:
        raise EntityNotFoundError(f"Delegation {delegation_id} not found in this institution")

    d.status = DelegationLifecycleStatus.REVOKED
    d.revoked_at = datetime.utcnow()
    d.revoked_by_membership_id = admin_membership.id
    d.revocation_reason = payload.reason or "Revoked by administrator"
    await db.flush()

    audit = AuthorizationAudit(
        actor_user_id=admin_user.id,
        actor_membership_id=admin_membership.id,
        institution_id=inst_id,
        action="delegation.revoke",
        permission_code="delegation.revoke",
        target_resource_type="DELEGATION",
        target_resource_id=str(d.id),
        outcome=AuditOutcome.ALLOWED,
        reason=f"Revoked delegation {d.id}: {d.revocation_reason}",
    )
    db.add(audit)
    await db.flush()

    grantor_name = d.grantor_assignment.membership.user.full_name if d.grantor_assignment and d.grantor_assignment.membership and d.grantor_assignment.membership.user else "Unknown"
    grantee_name = d.grantee_membership.user.full_name if d.grantee_membership and d.grantee_membership.user else "Unknown"

    return DelegationResponse(
        id=d.id,
        institution_id=d.institution_id,
        grantor_role_assignment_id=d.grantor_role_assignment_id,
        grantor_user_name=grantor_name,
        grantee_membership_id=d.grantee_membership_id,
        grantee_user_name=grantee_name,
        status=d.status,
        valid_from=d.valid_from,
        valid_until=d.valid_until,
        reason=d.reason,
        approved_at=d.approved_at,
        revoked_at=d.revoked_at,
        revocation_reason=d.revocation_reason,
        created_at=d.created_at,
    )


@router.get(
    "/access-control/unmapped-accounts",
    response_model=List[UnmappedAccountItem],
    summary="Identify unmapped legacy accounts requiring administrator review",
)
async def list_unmapped_accounts(
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    inst_id, _ = await resolve_tenant_and_membership(None, admin_user, db)

    # Users who either have no membership in this institution OR have no active role assignment
    assigned_user_ids_subq = (
        select(InstitutionMembership.user_id)
        .join(RoleAssignment, RoleAssignment.membership_id == InstitutionMembership.id)
        .where(
            InstitutionMembership.institution_id == inst_id,
            RoleAssignment.status == AssignmentStatus.ACTIVE,
        )
    )

    unmapped_stmt = (
        select(User, InstitutionMembership.id)
        .outerjoin(
            InstitutionMembership,
            (User.id == InstitutionMembership.user_id) & (InstitutionMembership.institution_id == inst_id),
        )
        .where(User.id.not_in(assigned_user_ids_subq))
        .order_by(User.full_name.asc())
    )
    res = await db.execute(unmapped_stmt)
    rows = res.all()

    return [
        UnmappedAccountItem(
            user_id=u.id,
            full_name=u.full_name,
            institutional_id=u.institutional_id,
            email=u.email,
            legacy_role=u.role.value,
            membership_id=mem_id,
            account_status=u.account_status.value,
        )
        for u, mem_id in rows
    ]


@router.get(
    "/access-control/audits",
    response_model=List[AuthorizationAuditResponse],
    summary="View authorization audit history",
)
async def list_authorization_audits(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db_session),
    admin_user: User = Depends(require_admin),
):
    inst_id, _ = await resolve_tenant_and_membership(None, admin_user, db)
    stmt = (
        select(AuthorizationAudit)
        .options(selectinload(AuthorizationAudit.actor_user))
        .where(AuthorizationAudit.institution_id == inst_id)
        .order_by(AuthorizationAudit.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    res = await db.execute(stmt)
    audits = res.scalars().all()

    return [
        AuthorizationAuditResponse(
            id=a.id,
            actor_user_id=a.actor_user_id,
            actor_name=a.actor_user.full_name if a.actor_user else None,
            action=a.action,
            resource_type=a.target_resource_type,
            resource_id=uuid.UUID(a.target_resource_id) if a.target_resource_id and len(a.target_resource_id) == 36 else None,
            outcome=a.outcome,
            reason_code=a.action,
            reason=a.reason,
            created_at=a.created_at,
        )
        for a in audits
    ]



