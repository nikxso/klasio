import uuid
from datetime import datetime, timezone, timedelta
import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import create_access_token, get_password_hash
from src.models.user import User, UserRole, AccountStatus
from src.models.access_control import (
    Institution,
    InstitutionMembership,
    MembershipStatus,
    Campus,
    CampusStatus,
    RoleTemplate,
    RoleAssignment,
    AssignmentStatus,
    RoleScopeType,
    RoleAssignmentScope,
    Delegation,
    DelegationLifecycleStatus,
)


@pytest.mark.asyncio
async def test_admin_campus_crud(async_client: AsyncClient, db_session: AsyncSession):
    # Setup admin user and institution
    inst = Institution(code=f"INST_CMP_{uuid.uuid4().hex[:6]}", name="Campus Test Inst")
    admin = User(
        institutional_id=f"ADM_CMP_{uuid.uuid4().hex[:6]}",
        email=f"adm_cmp_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash=get_password_hash("password123"),
        full_name="Campus Admin",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([inst, admin])
    await db_session.flush()

    mem = InstitutionMembership(institution_id=inst.id, user_id=admin.id, status=MembershipStatus.ACTIVE)
    db_session.add(mem)
    await db_session.commit()

    token = create_access_token(subject=str(admin.id), role=admin.role.value, institutional_id=admin.institutional_id)
    headers = {"Authorization": f"Bearer {token}", "X-Institution-ID": str(inst.id)}

    # 1. Create Campus
    create_res = await async_client.post(
        "/api/v1/admin/campuses",
        headers=headers,
        json={"code": "NORTH", "name": "North Campus"},
    )
    assert create_res.status_code == 201
    campus_data = create_res.json()
    assert campus_data["code"] == "NORTH"
    assert campus_data["name"] == "North Campus"
    campus_id = campus_data["id"]

    # 2. List Campuses
    list_res = await async_client.get("/api/v1/admin/campuses", headers=headers)
    assert list_res.status_code == 200
    campuses = list_res.json()
    assert any(c["id"] == campus_id for c in campuses)

    # 3. Patch Campus
    patch_res = await async_client.patch(
        f"/api/v1/admin/campuses/{campus_id}",
        headers=headers,
        json={"name": "North Innovation Campus"},
    )
    assert patch_res.status_code == 200
    assert patch_res.json()["name"] == "North Innovation Campus"


@pytest.mark.asyncio
async def test_admin_access_control_role_templates_and_assignments(
    async_client: AsyncClient,
    db_session: AsyncSession,
):
    inst = Institution(code=f"INST_RBAC_{uuid.uuid4().hex[:6]}", name="RBAC Test Inst")
    admin = User(
        institutional_id=f"ADM_RB_{uuid.uuid4().hex[:6]}",
        email=f"adm_rb_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash=get_password_hash("password123"),
        full_name="RBAC Admin",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    faculty_user = User(
        institutional_id=f"FAC_RB_{uuid.uuid4().hex[:6]}",
        email=f"fac_rb_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash=get_password_hash("password123"),
        full_name="RBAC Faculty",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([inst, admin, faculty_user])
    await db_session.flush()

    admin_mem = InstitutionMembership(institution_id=inst.id, user_id=admin.id, status=MembershipStatus.ACTIVE)
    fac_mem = InstitutionMembership(institution_id=inst.id, user_id=faculty_user.id, status=MembershipStatus.ACTIVE)
    db_session.add_all([admin_mem, fac_mem])
    await db_session.commit()

    token = create_access_token(subject=str(admin.id), role=admin.role.value, institutional_id=admin.institutional_id)
    headers = {"Authorization": f"Bearer {token}", "X-Institution-ID": str(inst.id)}

    # 1. List Role Templates
    tpl_res = await async_client.get("/api/v1/admin/access-control/role-templates", headers=headers)
    assert tpl_res.status_code == 200
    templates = tpl_res.json()
    assert len(templates) >= 20
    dept_head_tpl = next((t for t in templates if t["code"] == "DEPARTMENT_HEAD_COORDINATOR"), None)
    assert dept_head_tpl is not None

    # 2. List Memberships
    mems_res = await async_client.get("/api/v1/admin/access-control/memberships", headers=headers)
    assert mems_res.status_code == 200
    mems_data = mems_res.json()
    assert len(mems_data) >= 2

    # 3. Create Role Assignment for faculty
    assign_payload = {
        "membership_id": str(fac_mem.id),
        "role_template_id": dept_head_tpl["id"],
        "scope_type": "INSTITUTION",
        "reason": "Promoted to Department Head",
    }
    assign_res = await async_client.post(
        "/api/v1/admin/access-control/role-assignments",
        headers=headers,
        json=assign_payload,
    )
    assert assign_res.status_code == 201
    assignment_data = assign_res.json()
    assert assignment_data["role_template_code"] == "DEPARTMENT_HEAD_COORDINATOR"
    assignment_id = assignment_data["id"]

    # 4. Suspend Role Assignment
    suspend_res = await async_client.patch(
        f"/api/v1/admin/access-control/role-assignments/{assignment_id}/status",
        headers=headers,
        json={"status": "SUSPENDED", "reason": "Sabbatical leave"},
    )
    assert suspend_res.status_code == 200
    assert suspend_res.json()["status"] == "SUSPENDED"

    # 5. Check Unmapped Accounts
    unmapped_res = await async_client.get("/api/v1/admin/access-control/unmapped-accounts", headers=headers)
    assert unmapped_res.status_code == 200
    assert isinstance(unmapped_res.json(), list)

    # 6. Check Audits
    audits_res = await async_client.get("/api/v1/admin/access-control/audits", headers=headers)
    assert audits_res.status_code == 200
    audits = audits_res.json()
    assert len(audits) >= 2
    assert any(a["action"] == "role_assignment.create" for a in audits)
