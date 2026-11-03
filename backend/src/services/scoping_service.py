from datetime import date, datetime, timezone
from typing import List, Optional, Tuple
import uuid
from sqlalchemy import select, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.core.exceptions import OutOfScopeError, EntityNotFoundError, ConflictError
from src.models.academic import AcademicTerm, ClassSection, Subject
from src.models.assignment import TeachingAssignment, SubstituteDelegation, DelegationStatus
from src.models.user import User, UserRole
from src.schemas.assignment import (
    CreateDelegationRequest,
    DelegationDetails,
    FacultyTeachingAssignment,
    RevokeDelegationRequest,
)


class ScopingService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_faculty_assignments(
        self,
        faculty_user_id: uuid.UUID,
        academic_term_id: Optional[uuid.UUID] = None,
        on_date: Optional[date] = None,
    ) -> List[FacultyTeachingAssignment]:
        """Retrieve all active direct teaching assignments and valid substitute delegations for faculty."""
        eval_date = on_date or date.today()

        # 1. Fetch direct regular assignments
        direct_stmt = (
            select(TeachingAssignment)
            .options(
                selectinload(TeachingAssignment.class_section),
                selectinload(TeachingAssignment.subject),
                selectinload(TeachingAssignment.academic_term),
            )
            .where(
                and_(
                    TeachingAssignment.faculty_user_id == faculty_user_id,
                    TeachingAssignment.is_active == True,
                )
            )
        )
        if academic_term_id:
            direct_stmt = direct_stmt.where(TeachingAssignment.academic_term_id == academic_term_id)

        direct_res = await self.db.execute(direct_stmt)
        direct_assignments = direct_res.scalars().all()

        results: List[FacultyTeachingAssignment] = []
        for ta in direct_assignments:
            results.append(
                FacultyTeachingAssignment(
                    teaching_assignment_id=ta.id,
                    class_section_id=ta.class_section_id,
                    section_code=ta.class_section.section_code,
                    subject_id=ta.subject_id,
                    subject_code=ta.subject.code,
                    subject_name=ta.subject.name,
                    academic_term_id=ta.academic_term_id,
                    term_name=ta.academic_term.name,
                    is_delegated=False,
                    delegation_details=None,
                )
            )

        # 2. Fetch active substitute delegations
        deleg_stmt = (
            select(SubstituteDelegation)
            .options(
                selectinload(SubstituteDelegation.teaching_assignment).selectinload(TeachingAssignment.class_section),
                selectinload(SubstituteDelegation.teaching_assignment).selectinload(TeachingAssignment.subject),
                selectinload(SubstituteDelegation.teaching_assignment).selectinload(TeachingAssignment.academic_term),
                selectinload(SubstituteDelegation.teaching_assignment).selectinload(TeachingAssignment.faculty_user),
            )
            .where(
                and_(
                    SubstituteDelegation.substitute_faculty_user_id == faculty_user_id,
                    SubstituteDelegation.status == DelegationStatus.ACTIVE,
                    SubstituteDelegation.start_date <= eval_date,
                    SubstituteDelegation.end_date >= eval_date,
                )
            )
        )
        deleg_res = await self.db.execute(deleg_stmt)
        delegations = deleg_res.scalars().all()

        for delg in delegations:
            ta = delg.teaching_assignment
            if academic_term_id and ta.academic_term_id != academic_term_id:
                continue

            results.append(
                FacultyTeachingAssignment(
                    teaching_assignment_id=ta.id,
                    class_section_id=ta.class_section_id,
                    section_code=ta.class_section.section_code,
                    subject_id=ta.subject_id,
                    subject_code=ta.subject.code,
                    subject_name=ta.subject.name,
                    academic_term_id=ta.academic_term_id,
                    term_name=ta.academic_term.name,
                    is_delegated=True,
                    delegation_details=DelegationDetails(
                        delegation_id=delg.id,
                        regular_faculty_name=ta.faculty_user.full_name,
                        valid_from=delg.start_date,
                        valid_to=delg.end_date,
                    ),
                )
            )

        return results

    async def verify_faculty_scope(
        self,
        faculty_user_id: uuid.UUID,
        teaching_assignment_id: uuid.UUID,
        session_date: date,
    ) -> Tuple[bool, Optional[uuid.UUID]]:
        """
        Verify that faculty has active authority for the given teaching assignment on session_date.
        Returns: (is_authorized, substitute_delegation_id_if_applicable)
        Raises:
            EntityNotFoundError if assignment does not exist
            OutOfScopeError if faculty is not authorized on that date
        """
        stmt = (
            select(TeachingAssignment)
            .options(selectinload(TeachingAssignment.delegations))
            .where(TeachingAssignment.id == teaching_assignment_id)
        )
        res = await self.db.execute(stmt)
        assignment = res.scalar_one_or_none()

        if not assignment:
            raise EntityNotFoundError(f"Teaching assignment {teaching_assignment_id} not found")

        # 1. Direct assignment match
        if assignment.faculty_user_id == faculty_user_id and assignment.is_active:
            return True, None

        # 2. Check for active substitute delegation on session_date via direct database query
        delg_stmt = select(SubstituteDelegation).where(
            and_(
                SubstituteDelegation.teaching_assignment_id == teaching_assignment_id,
                SubstituteDelegation.substitute_faculty_user_id == faculty_user_id,
                SubstituteDelegation.status == DelegationStatus.ACTIVE,
                SubstituteDelegation.start_date <= session_date,
                SubstituteDelegation.end_date >= session_date,
            )
        )
        delg_res = await self.db.execute(delg_stmt)
        active_delg = delg_res.scalar_one_or_none()
        if active_delg:
            return True, active_delg.id

        # Neither direct owner nor active substitute on date
        raise OutOfScopeError(
            f"Faculty {faculty_user_id} is not authorized for assignment {teaching_assignment_id} on {session_date}"
        )

    async def create_delegation(
        self,
        teaching_assignment_id: uuid.UUID,
        delegating_user: User,
        payload: CreateDelegationRequest,
    ) -> SubstituteDelegation:
        """
        Create a direct substitute faculty delegation with immediate activation (FR-011, FR-012).
        Enforces non-subdelegation (FR-014) and blocks self-delegation.
        """
        stmt = select(TeachingAssignment).where(TeachingAssignment.id == teaching_assignment_id)
        res = await self.db.execute(stmt)
        assignment = res.scalar_one_or_none()

        if not assignment:
            raise EntityNotFoundError(f"Teaching assignment {teaching_assignment_id} not found")

        # 1. Invariant: Only permanent assigned faculty or Admin can delegate
        if delegating_user.role != UserRole.ADMIN and assignment.faculty_user_id != delegating_user.id:
            # Check if user is a substitute attempting sub-delegation
            sub_check = await self.db.execute(
                select(SubstituteDelegation).where(
                    and_(
                        SubstituteDelegation.teaching_assignment_id == teaching_assignment_id,
                        SubstituteDelegation.substitute_faculty_user_id == delegating_user.id,
                    )
                )
            )
            if sub_check.scalar_one_or_none():
                raise OutOfScopeError("Substitute faculty cannot delegate to another faculty colleague (sub-delegation forbidden)")
            raise OutOfScopeError("Only the assigned regular faculty can delegate their offering")

        # 2. Invariant: Block self-delegation
        if payload.substitute_faculty_user_id == assignment.faculty_user_id:
            raise ConflictError("Substitute faculty cannot equal regular assigned faculty")

        # 3. Create active delegation
        delegation = SubstituteDelegation(
            teaching_assignment_id=teaching_assignment_id,
            regular_faculty_user_id=assignment.faculty_user_id,
            substitute_faculty_user_id=payload.substitute_faculty_user_id,
            start_date=payload.start_date,
            end_date=payload.end_date,
            delegation_reason=payload.delegation_reason,
            status=DelegationStatus.ACTIVE,
            created_by_user_id=delegating_user.id,
        )
        self.db.add(delegation)
        await self.db.flush()
        await self.db.refresh(delegation)
        return delegation

    async def revoke_delegation(
        self,
        delegation_id: uuid.UUID,
        revoking_user: User,
        payload: RevokeDelegationRequest,
    ) -> SubstituteDelegation:
        """
        Early revocation of an active substitute delegation (FR-013).
        Only assigned regular faculty or Admin can revoke.
        """
        stmt = select(SubstituteDelegation).where(SubstituteDelegation.id == delegation_id)
        res = await self.db.execute(stmt)
        delegation = res.scalar_one_or_none()

        if not delegation:
            raise EntityNotFoundError(f"Substitute delegation {delegation_id} not found")

        if revoking_user.role != UserRole.ADMIN and delegation.regular_faculty_user_id != revoking_user.id:
            raise OutOfScopeError("Only the assigned regular faculty or admin can revoke a delegation")

        delegation.status = DelegationStatus.REVOKED
        delegation.revoked_by_user_id = revoking_user.id
        delegation.revoked_at = datetime.now(timezone.utc)
        delegation.revocation_reason = payload.revocation_reason

        await self.db.flush()
        await self.db.refresh(delegation)
        return delegation
