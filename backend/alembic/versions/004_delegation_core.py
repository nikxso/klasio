"""delegation_core

Revision ID: 004_delegation_core
Revises: 003_face_profile_core
Create Date: 2026-10-04 20:45:00.000000+00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "004_delegation_core"
down_revision: Union[str, None] = "003_face_profile_core"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Add new columns to substitute_delegations
    op.add_column(
        "substitute_delegations",
        sa.Column("regular_faculty_user_id", sa.Uuid(), nullable=True),
    )
    op.add_column(
        "substitute_delegations",
        sa.Column("delegation_reason", sa.Text(), nullable=True),
    )
    op.add_column(
        "substitute_delegations",
        sa.Column(
            "status",
            sa.Enum("ACTIVE", "EXPIRED", "REVOKED", name="delegation_status", native_enum=False),
            nullable=False,
            server_default="ACTIVE",
        ),
    )
    op.add_column(
        "substitute_delegations",
        sa.Column("created_by_user_id", sa.Uuid(), nullable=True),
    )
    op.add_column(
        "substitute_delegations",
        sa.Column("revoked_by_user_id", sa.Uuid(), nullable=True),
    )
    op.add_column(
        "substitute_delegations",
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "substitute_delegations",
        sa.Column("revocation_reason", sa.Text(), nullable=True),
    )

    # 2. Backfill from existing columns
    op.execute(
        """
        UPDATE substitute_delegations
        SET regular_faculty_user_id = delegated_by_user_id,
            created_by_user_id = delegated_by_user_id,
            delegation_reason = COALESCE(reason, 'Academic delegation')
        """
    )

    # 3. Enforce NOT NULL on populated columns
    op.alter_column("substitute_delegations", "regular_faculty_user_id", nullable=False)
    op.alter_column("substitute_delegations", "delegation_reason", nullable=False)
    op.alter_column("substitute_delegations", "created_by_user_id", nullable=False)

    # 4. Foreign key constraints
    op.create_foreign_key(
        "fk_substitute_delegations_regular_faculty_user_id",
        "substitute_delegations",
        "users",
        ["regular_faculty_user_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_substitute_delegations_created_by_user_id",
        "substitute_delegations",
        "users",
        ["created_by_user_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        "fk_substitute_delegations_revoked_by_user_id",
        "substitute_delegations",
        "users",
        ["revoked_by_user_id"],
        ["id"],
        ondelete="SET NULL",
    )

    # 5. Check constraint preventing self-delegation
    op.create_check_constraint(
        "chk_delegation_no_self",
        "substitute_delegations",
        "substitute_faculty_user_id != regular_faculty_user_id",
    )

    # 6. Indexes
    op.create_index(
        "ix_substitute_delegations_regular_faculty_user_id",
        "substitute_delegations",
        ["regular_faculty_user_id"],
        unique=False,
    )
    op.create_index(
        "ix_substitute_delegations_status",
        "substitute_delegations",
        ["status"],
        unique=False,
    )

    # 7. Drop legacy columns
    op.drop_column("substitute_delegations", "delegated_by_user_id")
    op.drop_column("substitute_delegations", "reason")
    op.drop_column("substitute_delegations", "is_active")


def downgrade() -> None:
    op.add_column(
        "substitute_delegations",
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default="true"),
    )
    op.add_column(
        "substitute_delegations",
        sa.Column("reason", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "substitute_delegations",
        sa.Column("delegated_by_user_id", sa.Uuid(), nullable=True),
    )
    op.execute(
        """
        UPDATE substitute_delegations
        SET delegated_by_user_id = created_by_user_id,
            reason = delegation_reason,
            is_active = (status = 'ACTIVE')
        """
    )
    op.alter_column("substitute_delegations", "delegated_by_user_id", nullable=False)
    op.create_foreign_key(
        "substitute_delegations_delegated_by_user_id_fkey",
        "substitute_delegations",
        "users",
        ["delegated_by_user_id"],
        ["id"],
        ondelete="CASCADE",
    )

    op.drop_index("ix_substitute_delegations_status", table_name="substitute_delegations")
    op.drop_index("ix_substitute_delegations_regular_faculty_user_id", table_name="substitute_delegations")
    op.drop_constraint("chk_delegation_no_self", "substitute_delegations", type_="check")
    op.drop_constraint("fk_substitute_delegations_revoked_by_user_id", "substitute_delegations", type_="foreignkey")
    op.drop_constraint("fk_substitute_delegations_created_by_user_id", "substitute_delegations", type_="foreignkey")
    op.drop_constraint("fk_substitute_delegations_regular_faculty_user_id", "substitute_delegations", type_="foreignkey")

    op.drop_column("substitute_delegations", "revocation_reason")
    op.drop_column("substitute_delegations", "revoked_at")
    op.drop_column("substitute_delegations", "revoked_by_user_id")
    op.drop_column("substitute_delegations", "created_by_user_id")
    op.drop_column("substitute_delegations", "status")
    op.drop_column("substitute_delegations", "delegation_reason")
    op.drop_column("substitute_delegations", "regular_faculty_user_id")
