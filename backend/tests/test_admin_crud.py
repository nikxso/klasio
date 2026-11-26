import pytest
import uuid
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession
from datetime import date

from src.core.security import create_access_token, get_password_hash
from src.models.user import User, UserRole, AccountStatus
from src.models.access_control import (
    DEFAULT_INSTITUTION_ID,
    Institution,
    InstitutionMembership,
    MembershipStatus,
    RoleAssignment,
    AssignmentStatus,
    RoleTemplate,
)
from src.models.academic import Department, Subject, ClassSection, AcademicTerm
from src.models.assignment import TeachingAssignment
from sqlalchemy import select


async def setup_admin_headers(async_client: AsyncClient, db_session: AsyncSession):
    inst_uuid = uuid.UUID(DEFAULT_INSTITUTION_ID)
    
    admin = User(
        institutional_id=f"ADM-CRUD-{uuid.uuid4().hex[:6]}",
        email=f"admin_crud_{uuid.uuid4().hex[:6]}@crud.edu",
        password_hash=get_password_hash("AdminPass123!"),
        full_name="Admin Crud",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add(admin)
    await db_session.flush()

    # The trigger creates institution_memberships automatically. Fetch it.
    mem_res = await db_session.execute(
        select(InstitutionMembership).where(
            InstitutionMembership.user_id == admin.id,
            InstitutionMembership.institution_id == inst_uuid,
        )
    )
    membership = mem_res.scalar_one_or_none()
    if not membership:
        membership = InstitutionMembership(
            institution_id=inst_uuid,
            user_id=admin.id,
            status=MembershipStatus.ACTIVE,
        )
        db_session.add(membership)
        await db_session.flush()

    # Assign CENTRAL_INSTITUTION_ADMIN role template if exists
    res = await db_session.execute(select(RoleTemplate).where(RoleTemplate.code == "CENTRAL_INSTITUTION_ADMIN"))
    tpl = res.scalar_one_or_none()
    if tpl:
        ra = RoleAssignment(
            institution_id=inst_uuid,
            membership_id=membership.id,
            role_template_id=tpl.id,
            status=AssignmentStatus.ACTIVE,
            reason="Admin test setup",
        )
        db_session.add(ra)
        await db_session.flush()

    token = create_access_token(
        subject=str(admin.id),
        role=admin.role.value,
        institutional_id=admin.institutional_id,
        extra_claims={"institution_id": str(inst_uuid)},
    )
    async_client.headers["Authorization"] = f"Bearer {token}"
    return admin, inst_uuid


@pytest.mark.asyncio
async def test_department_crud(async_client: AsyncClient, db_session: AsyncSession):
    admin, inst_uuid = await setup_admin_headers(async_client, db_session)

    # 1. Create department
    create_res = await async_client.post(
        "/api/v1/admin/departments",
        json={"name": "Aerospace Engineering", "code": f"AE{uuid.uuid4().hex[:4].upper()}", "institution_id": str(inst_uuid)},
    )
    assert create_res.status_code == 201
    dept_id = create_res.json()["id"]

    # 2. Update department
    patch_res = await async_client.patch(
        f"/api/v1/admin/departments/{dept_id}",
        json={"name": "Aero & Astro Engineering", "code": f"AA{uuid.uuid4().hex[:4].upper()}"},
    )
    assert patch_res.status_code == 200
    assert patch_res.json()["name"] == "Aero & Astro Engineering"

    # 3. Delete department
    del_res = await async_client.delete(f"/api/v1/admin/departments/{dept_id}")
    assert del_res.status_code == 200

    # Verify 404 on re-fetch
    retry_del = await async_client.delete(f"/api/v1/admin/departments/{dept_id}")
    assert retry_del.status_code == 404


@pytest.mark.asyncio
async def test_subject_and_section_crud(async_client: AsyncClient, db_session: AsyncSession):
    admin, inst_uuid = await setup_admin_headers(async_client, db_session)

    # Create Dept and Term
    dept = Department(institution_id=inst_uuid, name="Physics Dept", code=f"PH{uuid.uuid4().hex[:4].upper()}")
    term = AcademicTerm(
        code=f"TRM-{uuid.uuid4().hex[:4].upper()}",
        name="Spring 2026",
        academic_year="2025-2026",
        start_date=date(2026, 1, 1),
        end_date=date(2026, 6, 30),
    )
    db_session.add_all([dept, term])
    await db_session.flush()

    # 1. Subject CRUD
    sub_code = f"QM{uuid.uuid4().hex[:4].upper()}"
    sub_res = await async_client.post(
        "/api/v1/admin/subjects",
        json={"name": "Quantum Mechanics", "code": sub_code, "department_id": str(dept.id), "credits": 4},
    )
    assert sub_res.status_code == 201
    subject_id = sub_res.json()["id"]

    patch_sub = await async_client.patch(
        f"/api/v1/admin/subjects/{subject_id}",
        json={"name": "Advanced Quantum Mechanics", "credits": 5},
    )
    assert patch_sub.status_code == 200
    assert patch_sub.json()["credits"] == 5

    del_sub = await async_client.delete(f"/api/v1/admin/subjects/{subject_id}")
    assert del_sub.status_code == 200

    # 2. Section CRUD
    sec_code = f"SEC-{uuid.uuid4().hex[:4].upper()}"
    sec_res = await async_client.post(
        "/api/v1/admin/sections",
        json={"section_code": sec_code, "department_id": str(dept.id), "academic_term_id": str(term.id), "cohort_year": 2026},
    )
    assert sec_res.status_code == 201
    sec_id = sec_res.json()["id"]

    patch_sec = await async_client.patch(
        f"/api/v1/admin/sections/{sec_id}",
        json={"section_code": f"{sec_code}-MOD"},
    )
    assert patch_sec.status_code == 200
    assert patch_sec.json()["section_code"] == f"{sec_code}-MOD"

    del_sec = await async_client.delete(f"/api/v1/admin/sections/{sec_id}")
    assert del_sec.status_code == 200


@pytest.mark.asyncio
async def test_user_management_crud(async_client: AsyncClient, db_session: AsyncSession):
    admin, inst_uuid = await setup_admin_headers(async_client, db_session)

    fac_id_tag = f"FAC-{uuid.uuid4().hex[:6]}"
    create_res = await async_client.post(
        "/api/v1/admin/users",
        json={
            "full_name": "Test Faculty",
            "email": f"fac_{uuid.uuid4().hex[:6]}@crud.edu",
            "institutional_id": fac_id_tag,
            "password": "Password123!",
            "role": "FACULTY",
        },
    )
    assert create_res.status_code == 201
    fac_id = create_res.json()["id"]

    # 2. Update user name and ID
    new_id_tag = f"{fac_id_tag}-REV"
    patch_res = await async_client.patch(
        f"/api/v1/admin/users/{fac_id}",
        json={"full_name": "Dr. Test Faculty", "institutional_id": new_id_tag},
    )
    assert patch_res.status_code == 200
    assert patch_res.json()["name"] == "Dr. Test Faculty"
    assert patch_res.json()["identifier"] == new_id_tag

    # 3. Soft delete (deactivate)
    del_soft = await async_client.delete(f"/api/v1/admin/users/{fac_id}")
    assert del_soft.status_code == 200
    assert del_soft.json()["deactivated"] is True

    # 4. Hard delete clean user
    del_hard = await async_client.delete(f"/api/v1/admin/users/{fac_id}?hard_delete=true")
    assert del_hard.status_code == 200
    assert del_hard.json()["deactivated"] is False

    # 5. Admin cannot delete self
    del_self = await async_client.delete(f"/api/v1/admin/users/{admin.id}")
    assert del_self.status_code == 400
    assert del_self.json()["error"] == "CONFLICT_ERROR"
