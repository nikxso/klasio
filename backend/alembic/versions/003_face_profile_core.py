"""face_profile_core

Revision ID: 003_face_profile_core
Revises: d7cfbd343a64
Create Date: 2026-10-04 20:30:00.000000+00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "003_face_profile_core"
down_revision: Union[str, None] = "d7cfbd343a64"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "student_face_profiles",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("student_user_id", sa.Uuid(), nullable=False),
        sa.Column(
            "registration_state",
            sa.Enum(
                "UNREGISTERED",
                "PENDING",
                "REGISTERED",
                "VALIDATION_FAILED",
                name="face_registration_state",
                native_enum=False,
            ),
            nullable=False,
            server_default="UNREGISTERED",
        ),
        sa.Column("active_model_version", sa.String(length=64), nullable=True),
        sa.Column("embedding_dimension", sa.SmallInteger(), nullable=True),
        sa.Column("sample_count", sa.SmallInteger(), nullable=False, server_default="0"),
        sa.Column("embedding_blob", sa.LargeBinary(), nullable=True),
        sa.Column("quality_score", sa.Float(), nullable=True),
        sa.Column("last_validated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["student_user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("student_user_id", name="uq_student_face_profiles_student_user_id"),
    )
    op.create_index(
        "ix_student_face_profiles_student_user_id",
        "student_face_profiles",
        ["student_user_id"],
        unique=True,
    )
    op.create_index(
        "ix_student_face_profiles_registration_state",
        "student_face_profiles",
        ["registration_state"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_student_face_profiles_registration_state", table_name="student_face_profiles")
    op.drop_index("ix_student_face_profiles_student_user_id", table_name="student_face_profiles")
    op.drop_table("student_face_profiles")
