"""enrollment_core

Revision ID: d7cfbd343a64
Revises: d2527761a9b7
Create Date: 2026-10-04 20:14:38.997828+00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'd7cfbd343a64'
down_revision: Union[str, None] = 'd2527761a9b7'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'student_enrollments',
        sa.Column('id', sa.Uuid(), nullable=False),
        sa.Column('student_user_id', sa.Uuid(), nullable=False),
        sa.Column('class_section_id', sa.Uuid(), nullable=False),
        sa.Column('academic_term_id', sa.Uuid(), nullable=False),
        sa.Column('effective_start_date', sa.Date(), nullable=False),
        sa.Column('effective_end_date', sa.Date(), nullable=True),
        sa.Column('enrollment_status', sa.Enum('ACTIVE', 'TRANSFERRED', 'WITHDRAWN', 'COMPLETED', name='enrollment_status', native_enum=False), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint('effective_end_date IS NULL OR effective_end_date >= effective_start_date', name='chk_enrollment_date_range'),
        sa.ForeignKeyConstraint(['academic_term_id'], ['academic_terms.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['class_section_id'], ['class_sections.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['student_user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_student_enrollments_academic_term_id', 'student_enrollments', ['academic_term_id'], unique=False)
    op.create_index('ix_student_enrollments_class_section_id', 'student_enrollments', ['class_section_id'], unique=False)
    op.create_index('ix_student_enrollments_section_start', 'student_enrollments', ['class_section_id', 'effective_start_date'], unique=False)
    op.create_index('ix_student_enrollments_student_section', 'student_enrollments', ['student_user_id', 'class_section_id'], unique=False)
    op.create_index('ix_student_enrollments_student_user_id', 'student_enrollments', ['student_user_id'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_student_enrollments_student_user_id', table_name='student_enrollments')
    op.drop_index('ix_student_enrollments_student_section', table_name='student_enrollments')
    op.drop_index('ix_student_enrollments_section_start', table_name='student_enrollments')
    op.drop_index('ix_student_enrollments_class_section_id', table_name='student_enrollments')
    op.drop_index('ix_student_enrollments_academic_term_id', table_name='student_enrollments')
    op.drop_table('student_enrollments')
