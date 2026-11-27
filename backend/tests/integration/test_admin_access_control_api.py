import uuid
from datetime import datetime, timezone, timedelta
import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.security import create_access_token, get_password_hash
from src.models.user import User, UserRole, AccountStatus
from src.models.access_control import (
    DEFAULT_INSTITUTION_ID,
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
    res_inst = await db_session.execute(select(Institution).where(Institution.id == DEFAULT_INSTITUTION_ID))
    inst = res_inst.scalar_one_or_none()
    if not inst:
        inst = Institution(id=uuid.UUID(DEFAULT_INSTITUTION_ID), code="KLASIO_MAIN", name="RBAC Test Inst")
        db_session.add(inst)
        await db_session.flush()

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
    db_session.add_all([admin, faculty_user])
    await db_session.flush()

    # Ensure memberships in inst.id (trg_user_auto_membership creates active memberships in DEFAULT_INSTITUTION_ID)
    for u in [admin, faculty_user]:
        m_exists = (
            await db_session.execute(
                select(InstitutionMembership).where(
                    InstitutionMembership.institution_id == inst.id,
                    InstitutionMembership.user_id == u.id,
                )
            )
        ).scalar_one_or_none()
        if not m_exists:
            db_session.add(InstitutionMembership(institution_id=inst.id, user_id=u.id, status=MembershipStatus.ACTIVE))
    await db_session.flush()

    admin_mem = (
        await db_session.execute(
            select(InstitutionMembership).where(
                InstitutionMembership.institution_id == inst.id,
                InstitutionMembership.user_id == admin.id,
            )
        )
    ).scalar_one()

    fac_mem = (
        await db_session.execute(
            select(InstitutionMembership).where(
                InstitutionMembership.institution_id == inst.id,
                InstitutionMembership.user_id == faculty_user.id,
            )
        )
    ).scalar_one()

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


@pytest.mark.asyncio
async def test_admin_multi_role_user_management(
    async_client: AsyncClient,
    db_session: AsyncSession,
):
    inst = Institution(code=f"INST_MULTI_{uuid.uuid4().hex[:6]}", name="Multi Role Inst")
    admin = User(
        institutional_id=f"ADM_M_{uuid.uuid4().hex[:6]}",
        email=f"adm_m_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash=get_password_hash("password123"),
        full_name="Multi Admin",
        role=UserRole.ADMIN,
        account_status=AccountStatus.ACTIVE,
    )
    dual_user = User(
        institutional_id=f"DUAL_{uuid.uuid4().hex[:6]}",
        email=f"dual_{uuid.uuid4().hex[:6]}@inst.edu",
        password_hash=get_password_hash("password123"),
        full_name="Prof & Admin Dual",
        role=UserRole.FACULTY,
        account_status=AccountStatus.ACTIVE,
    )
    db_session.add_all([inst, admin, dual_user])
    await db_session.flush()

    admin_mem = InstitutionMembership(institution_id=inst.id, user_id=admin.id, status=MembershipStatus.ACTIVE)
    dual_mem = InstitutionMembership(institution_id=inst.id, user_id=dual_user.id, status=MembershipStatus.ACTIVE)
    db_session.add_all([admin_mem, dual_mem])
    await db_session.commit()

    token = create_access_token(subject=str(admin.id), role=admin.role.value, institutional_id=admin.institutional_id)
    headers = {"Authorization": f"Bearer {token}", "X-Institution-ID": str(inst.id)}

    # 1. Add CAMPUS_ADMIN role to dual_user (who is originally FACULTY)
    add_role_res = await async_client.post(
        f"/api/v1/admin/users/{dual_user.id}/roles",
        headers=headers,
        json={"role_code": "CAMPUS_ADMIN", "reason": "Appointed Campus Administrator"},
    )
    assert add_role_res.status_code == 200
    user_data = add_role_res.json()
    assert "CAMPUS_ADMIN" in user_data["roles"]
    assert "FACULTY" in user_data["roles"]

    # 2. Verify dual_user appears when querying ?role=faculty
    fac_res = await async_client.get("/api/v1/admin/users?role=faculty", headers=headers)
    assert fac_res.status_code == 200
    fac_list = fac_res.json()
    assert any(u["id"] == str(dual_user.id) for u in fac_list)

    # 3. Verify dual_user ALSO appears when querying ?role=admin
    adm_res = await async_client.get("/api/v1/admin/users?role=admin", headers=headers)
    assert adm_res.status_code == 200
    adm_list = adm_res.json()
    assert any(u["id"] == str(dual_user.id) for u in adm_list)

    # 4. Revoke CAMPUS_ADMIN role from dual_user
    del_role_res = await async_client.delete(
        f"/api/v1/admin/users/{dual_user.id}/roles/CAMPUS_ADMIN",
        headers=headers,
    )
    assert del_role_res.status_code == 200
    updated_user_data = del_role_res.json()
    assert "CAMPUS_ADMIN" not in updated_user_data["roles"]
    assert "FACULTY" in updated_user_data["roles"]

