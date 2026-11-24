import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.access_control import (
    Delegation,
    DelegationType,
    Permission,
    RoleScopeType,
    RoleTemplate,
)
from src.services.iac_seed_service import (
    CANONICAL_ROLE_TEMPLATES,
    seed_canonical_role_templates,
)


def test_delegation_type_enum():
    assert DelegationType.FACULTY_SUBSTITUTE == "FACULTY_SUBSTITUTE"
    assert DelegationType.MANAGEMENT_DELEGATION == "MANAGEMENT_DELEGATION"


def test_role_scope_type_has_program():
    assert RoleScopeType.PROGRAM == "PROGRAM"


def test_canonical_role_templates_count():
    assert len(CANONICAL_ROLE_TEMPLATES) == 20
    codes = {tpl["code"] for tpl in CANONICAL_ROLE_TEMPLATES}
    assert "INSTITUTION_OWNER" in codes
    assert "CENTRAL_INSTITUTION_ADMIN" in codes
    assert "CAMPUS_ADMIN" in codes
    assert "ACCESS_ADMIN" in codes
    assert "IT_ADMIN" in codes
    assert "PRIVACY_BIOMETRIC_OFFICER" in codes
    assert "ACADEMIC_REGISTRAR" in codes
    assert "ADMISSIONS_OFFICER" in codes
    assert "ENROLLMENT_OFFICER" in codes
    assert "STUDENT_RECORDS_OFFICER" in codes
    assert "DEPARTMENT_HEAD" in codes
    assert "PROGRAM_COORDINATOR" in codes
    assert "TIMETABLE_COORDINATOR" in codes
    assert "FACULTY" in codes
    assert "TEACHING_ASSISTANT" in codes
    assert "CLASS_ADVISOR" in codes
    assert "BIOMETRIC_ENROLLMENT_OFFICER" in codes
    assert "ATTENDANCE_AUDITOR" in codes
    assert "INSTITUTIONAL_AUDITOR" in codes
    assert "STUDENT" in codes


def test_delegation_model_has_delegation_type_column():
    assert hasattr(Delegation, "delegation_type")
    d = Delegation()
    assert d.delegation_type == DelegationType.FACULTY_SUBSTITUTE


def test_canonical_templates_no_biometric_template_read():
    for tpl in CANONICAL_ROLE_TEMPLATES:
        assert "biometrics.template.read" not in tpl.get("permissions", [])


@pytest.mark.asyncio
async def test_seed_canonical_role_templates(db_session: AsyncSession):
    await seed_canonical_role_templates(db_session)
    result = await db_session.execute(select(RoleTemplate))
    roles = result.scalars().all()
    codes = {r.code for r in roles}
    for tpl in CANONICAL_ROLE_TEMPLATES:
        assert tpl["code"] in codes
