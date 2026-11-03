"""composite_tenant_keys

Revision ID: 012_composite_tenant_keys
Revises: 011_access_control_foundation
Create Date: 2026-11-01 18:00:00.000000+00:00

"""
from typing import Sequence, Union
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "012_composite_tenant_keys"
down_revision: Union[str, None] = "011_access_control_foundation"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

DEFAULT_INSTITUTION_ID = "00000000-0000-0000-0000-000000000001"


def upgrade() -> None:
    # 1. Composite Unique Constraints on Tenant Entities
    op.create_unique_constraint("uq_campuses_inst_id", "campuses", ["institution_id", "id"])
    op.create_unique_constraint("uq_departments_inst_id", "departments", ["institution_id", "id"])
    op.create_unique_constraint("uq_academic_terms_inst_id", "academic_terms", ["institution_id", "id"])
    op.create_unique_constraint("uq_subjects_inst_id", "subjects", ["institution_id", "id"])
    op.create_unique_constraint("uq_class_sections_inst_id", "class_sections", ["institution_id", "id"])
    op.create_unique_constraint("uq_memberships_inst_id", "institution_memberships", ["institution_id", "id"])

    # 2. Composite FK on subjects -> departments
    op.drop_constraint("subjects_department_id_fkey", "subjects", type_="foreignkey")
    op.create_foreign_key(
        "fk_subjects_inst_department",
        "subjects",
        "departments",
        ["institution_id", "department_id"],
        ["institution_id", "id"],
        ondelete="CASCADE",
    )

    # 3. Composite FKs on class_sections -> campuses, departments, academic_terms
    op.drop_constraint("fk_class_sections_campus_id", "class_sections", type_="foreignkey")
    op.drop_constraint("class_sections_department_id_fkey", "class_sections", type_="foreignkey")
    op.drop_constraint("class_sections_academic_term_id_fkey", "class_sections", type_="foreignkey")

    op.create_foreign_key(
        "fk_class_sections_inst_campus",
        "class_sections",
        "campuses",
        ["institution_id", "campus_id"],
        ["institution_id", "id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_class_sections_inst_department",
        "class_sections",
        "departments",
        ["institution_id", "department_id"],
        ["institution_id", "id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_class_sections_inst_term",
        "class_sections",
        "academic_terms",
        ["institution_id", "academic_term_id"],
        ["institution_id", "id"],
        ondelete="CASCADE",
    )

    # 4. Department-Campuses Tenant Scoping
    op.add_column("department_campuses", sa.Column("institution_id", sa.Uuid(), nullable=True))
    op.execute(
        """
        UPDATE department_campuses dc
        SET institution_id = d.institution_id
        FROM departments d
        WHERE dc.department_id = d.id
        """
    )
    op.alter_column("department_campuses", "institution_id", nullable=False)
    op.drop_constraint("department_campuses_department_id_fkey", "department_campuses", type_="foreignkey")
    op.drop_constraint("department_campuses_campus_id_fkey", "department_campuses", type_="foreignkey")
    op.create_foreign_key(
        "fk_dept_campuses_inst_department",
        "department_campuses",
        "departments",
        ["institution_id", "department_id"],
        ["institution_id", "id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_dept_campuses_inst_campus",
        "department_campuses",
        "campuses",
        ["institution_id", "campus_id"],
        ["institution_id", "id"],
        ondelete="CASCADE",
    )

    # 5. RoleAssignments Tenant Scoping & Composite Keys
    op.add_column("role_assignments", sa.Column("institution_id", sa.Uuid(), nullable=True))
    op.execute(
        """
        UPDATE role_assignments ra
        SET institution_id = im.institution_id
        FROM institution_memberships im
        WHERE ra.membership_id = im.id
        """
    )
    op.alter_column("role_assignments", "institution_id", nullable=False)
    op.drop_constraint("role_assignments_membership_id_fkey", "role_assignments", type_="foreignkey")
    op.create_foreign_key(
        "fk_role_assignments_inst_membership",
        "role_assignments",
        "institution_memberships",
        ["institution_id", "membership_id"],
        ["institution_id", "id"],
        ondelete="CASCADE",
    )
    op.create_unique_constraint("uq_role_assignments_inst_id", "role_assignments", ["institution_id", "id"])

    # 6. RoleAssignmentScope Composite FKs
    op.drop_constraint("role_assignment_scopes_role_assignment_id_fkey", "role_assignment_scopes", type_="foreignkey")
    op.drop_constraint("role_assignment_scopes_campus_id_fkey", "role_assignment_scopes", type_="foreignkey")
    op.drop_constraint("role_assignment_scopes_department_id_fkey", "role_assignment_scopes", type_="foreignkey")
    op.drop_constraint("role_assignment_scopes_academic_term_id_fkey", "role_assignment_scopes", type_="foreignkey")
    op.drop_constraint("role_assignment_scopes_class_section_id_fkey", "role_assignment_scopes", type_="foreignkey")

    op.create_foreign_key(
        "fk_role_scopes_inst_assignment",
        "role_assignment_scopes",
        "role_assignments",
        ["institution_id", "role_assignment_id"],
        ["institution_id", "id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_role_scopes_inst_campus",
        "role_assignment_scopes",
        "campuses",
        ["institution_id", "campus_id"],
        ["institution_id", "id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_role_scopes_inst_department",
        "role_assignment_scopes",
        "departments",
        ["institution_id", "department_id"],
        ["institution_id", "id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_role_scopes_inst_term",
        "role_assignment_scopes",
        "academic_terms",
        ["institution_id", "academic_term_id"],
        ["institution_id", "id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_role_scopes_inst_section",
        "role_assignment_scopes",
        "class_sections",
        ["institution_id", "class_section_id"],
        ["institution_id", "id"],
        ondelete="CASCADE",
    )

    # 7. Delegations Tenant Scoping & Composite Keys
    op.add_column("delegations", sa.Column("institution_id", sa.Uuid(), nullable=True))
    op.execute(
        """
        UPDATE delegations d
        SET institution_id = ra.institution_id
        FROM role_assignments ra
        WHERE d.grantor_role_assignment_id = ra.id
        """
    )
    op.alter_column("delegations", "institution_id", nullable=False)
    op.drop_constraint("delegations_grantor_role_assignment_id_fkey", "delegations", type_="foreignkey")
    op.drop_constraint("delegations_grantee_membership_id_fkey", "delegations", type_="foreignkey")

    op.create_foreign_key(
        "fk_delegations_inst_grantor",
        "delegations",
        "role_assignments",
        ["institution_id", "grantor_role_assignment_id"],
        ["institution_id", "id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_delegations_inst_grantee",
        "delegations",
        "institution_memberships",
        ["institution_id", "grantee_membership_id"],
        ["institution_id", "id"],
        ondelete="CASCADE",
    )
    op.create_unique_constraint("uq_delegations_inst_id", "delegations", ["institution_id", "id"])

    # 8. DelegationScopes Composite FKs
    op.drop_constraint("delegation_scopes_delegation_id_fkey", "delegation_scopes", type_="foreignkey")
    op.drop_constraint("delegation_scopes_campus_id_fkey", "delegation_scopes", type_="foreignkey")
    op.drop_constraint("delegation_scopes_department_id_fkey", "delegation_scopes", type_="foreignkey")
    op.drop_constraint("delegation_scopes_academic_term_id_fkey", "delegation_scopes", type_="foreignkey")
    op.drop_constraint("delegation_scopes_class_section_id_fkey", "delegation_scopes", type_="foreignkey")

    op.create_foreign_key(
        "fk_delegation_scopes_inst_delegation",
        "delegation_scopes",
        "delegations",
        ["institution_id", "delegation_id"],
        ["institution_id", "id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_delegation_scopes_inst_campus",
        "delegation_scopes",
        "campuses",
        ["institution_id", "campus_id"],
        ["institution_id", "id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_delegation_scopes_inst_department",
        "delegation_scopes",
        "departments",
        ["institution_id", "department_id"],
        ["institution_id", "id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_delegation_scopes_inst_term",
        "delegation_scopes",
        "academic_terms",
        ["institution_id", "academic_term_id"],
        ["institution_id", "id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_delegation_scopes_inst_section",
        "delegation_scopes",
        "class_sections",
        ["institution_id", "class_section_id"],
        ["institution_id", "id"],
        ondelete="CASCADE",
    )


def downgrade() -> None:
    # 8. Revert DelegationScopes
    op.drop_constraint("fk_delegation_scopes_inst_section", "delegation_scopes", type_="foreignkey")
    op.drop_constraint("fk_delegation_scopes_inst_term", "delegation_scopes", type_="foreignkey")
    op.drop_constraint("fk_delegation_scopes_inst_department", "delegation_scopes", type_="foreignkey")
    op.drop_constraint("fk_delegation_scopes_inst_campus", "delegation_scopes", type_="foreignkey")
    op.drop_constraint("fk_delegation_scopes_inst_delegation", "delegation_scopes", type_="foreignkey")

    op.create_foreign_key("delegation_scopes_delegation_id_fkey", "delegation_scopes", "delegations", ["delegation_id"], ["id"], ondelete="CASCADE")
    op.create_foreign_key("delegation_scopes_campus_id_fkey", "delegation_scopes", "campuses", ["campus_id"], ["id"], ondelete="CASCADE")
    op.create_foreign_key("delegation_scopes_department_id_fkey", "delegation_scopes", "departments", ["department_id"], ["id"], ondelete="CASCADE")
    op.create_foreign_key("delegation_scopes_academic_term_id_fkey", "delegation_scopes", "academic_terms", ["academic_term_id"], ["id"], ondelete="CASCADE")
    op.create_foreign_key("delegation_scopes_class_section_id_fkey", "delegation_scopes", "class_sections", ["class_section_id"], ["id"], ondelete="CASCADE")

    # 7. Revert Delegations
    op.drop_constraint("uq_delegations_inst_id", "delegations", type_="unique")
    op.drop_constraint("fk_delegations_inst_grantee", "delegations", type_="foreignkey")
    op.drop_constraint("fk_delegations_inst_grantor", "delegations", type_="foreignkey")
    op.drop_column("delegations", "institution_id")

    op.create_foreign_key("delegations_grantor_role_assignment_id_fkey", "delegations", "role_assignments", ["grantor_role_assignment_id"], ["id"], ondelete="CASCADE")
    op.create_foreign_key("delegations_grantee_membership_id_fkey", "delegations", "institution_memberships", ["grantee_membership_id"], ["id"], ondelete="CASCADE")

    # 6. Revert RoleAssignmentScopes
    op.drop_constraint("fk_role_scopes_inst_section", "role_assignment_scopes", type_="foreignkey")
    op.drop_constraint("fk_role_scopes_inst_term", "role_assignment_scopes", type_="foreignkey")
    op.drop_constraint("fk_role_scopes_inst_department", "role_assignment_scopes", type_="foreignkey")
    op.drop_constraint("fk_role_scopes_inst_campus", "role_assignment_scopes", type_="foreignkey")
    op.drop_constraint("fk_role_scopes_inst_assignment", "role_assignment_scopes", type_="foreignkey")

    op.create_foreign_key("role_assignment_scopes_role_assignment_id_fkey", "role_assignment_scopes", "role_assignments", ["role_assignment_id"], ["id"], ondelete="CASCADE")
    op.create_foreign_key("role_assignment_scopes_campus_id_fkey", "role_assignment_scopes", "campuses", ["campus_id"], ["id"], ondelete="CASCADE")
    op.create_foreign_key("role_assignment_scopes_department_id_fkey", "role_assignment_scopes", "departments", ["department_id"], ["id"], ondelete="CASCADE")
    op.create_foreign_key("role_assignment_scopes_academic_term_id_fkey", "role_assignment_scopes", "academic_terms", ["academic_term_id"], ["id"], ondelete="CASCADE")
    op.create_foreign_key("role_assignment_scopes_class_section_id_fkey", "role_assignment_scopes", "class_sections", ["class_section_id"], ["id"], ondelete="CASCADE")

    # 5. Revert RoleAssignments
    op.drop_constraint("uq_role_assignments_inst_id", "role_assignments", type_="unique")
    op.drop_constraint("fk_role_assignments_inst_membership", "role_assignments", type_="foreignkey")
    op.drop_column("role_assignments", "institution_id")
    op.create_foreign_key("role_assignments_membership_id_fkey", "role_assignments", "institution_memberships", ["membership_id"], ["id"], ondelete="CASCADE")

    # 4. Revert Department-Campuses
    op.drop_constraint("fk_dept_campuses_inst_campus", "department_campuses", type_="foreignkey")
    op.drop_constraint("fk_dept_campuses_inst_department", "department_campuses", type_="foreignkey")
    op.drop_column("department_campuses", "institution_id")
    op.create_foreign_key("department_campuses_department_id_fkey", "department_campuses", "departments", ["department_id"], ["id"], ondelete="CASCADE")
    op.create_foreign_key("department_campuses_campus_id_fkey", "department_campuses", "campuses", ["campus_id"], ["id"], ondelete="CASCADE")

    # 3. Revert ClassSections
    op.drop_constraint("fk_class_sections_inst_term", "class_sections", type_="foreignkey")
    op.drop_constraint("fk_class_sections_inst_department", "class_sections", type_="foreignkey")
    op.drop_constraint("fk_class_sections_inst_campus", "class_sections", type_="foreignkey")

    op.create_foreign_key("fk_class_sections_campus_id", "class_sections", "campuses", ["campus_id"], ["id"], ondelete="CASCADE")
    op.create_foreign_key("class_sections_department_id_fkey", "class_sections", "departments", ["department_id"], ["id"], ondelete="CASCADE")
    op.create_foreign_key("class_sections_academic_term_id_fkey", "class_sections", "academic_terms", ["academic_term_id"], ["id"], ondelete="CASCADE")

    # 2. Revert Subjects
    op.drop_constraint("fk_subjects_inst_department", "subjects", type_="foreignkey")
    op.create_foreign_key("subjects_department_id_fkey", "subjects", "departments", ["department_id"], ["id"], ondelete="CASCADE")

    # 1. Revert Composite Unique Constraints
    op.drop_constraint("uq_memberships_inst_id", "institution_memberships", type_="unique")
    op.drop_constraint("uq_class_sections_inst_id", "class_sections", type_="unique")
    op.drop_constraint("uq_subjects_inst_id", "subjects", type_="unique")
    op.drop_constraint("uq_academic_terms_inst_id", "academic_terms", type_="unique")
    op.drop_constraint("uq_departments_inst_id", "departments", type_="unique")
    op.drop_constraint("uq_campuses_inst_id", "campuses", type_="unique")
