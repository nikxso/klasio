from datetime import date, datetime, timezone
from typing import List, Optional, Tuple
import uuid
from sqlalchemy import select, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.core.exceptions import OutOfScopeError, EntityNotFoundError, ConflictError
from src.models.academic import AcademicTerm, ClassSection, Subject
from src.models.assignment import TeachingAssignment, SubstituteDelegation, DelegationStatus
from src.models.attendance import (
    AttendanceSession,
    AttendanceRecord,
    SessionApplicability,
    AttendanceSessionStatus,
    AttendanceStatus,
)
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

    async def get_permitted_assignment_ids(self, user: User) -> List[uuid.UUID]:
        """
        Return all teaching assignment IDs that the user is authorized to review or manage.
        If user is ADMIN: returns all active teaching assignment IDs.
        If user is FACULTY: returns IDs of:
          - Direct teaching assignments owned by faculty (where faculty_user_id == user.id)
          - Active substitute delegations where substitute_faculty_user_id == user.id
          - Teaching assignments for sessions conducted by this faculty
        """
        if user.role == UserRole.ADMIN:
            stmt = select(TeachingAssignment.id).where(TeachingAssignment.is_active == True)
            res = await self.db.execute(stmt)
            return list(res.scalars().all())

        assignment_ids = set()

        # 1. Direct assignments
        direct_stmt = select(TeachingAssignment.id).where(
            and_(
                TeachingAssignment.faculty_user_id == user.id,
                TeachingAssignment.is_active == True,
            )
        )
        direct_res = await self.db.execute(direct_stmt)
        for aid in direct_res.scalars().all():
            assignment_ids.add(aid)

        # 2. Active delegations
        deleg_stmt = select(SubstituteDelegation.teaching_assignment_id).where(
            and_(
                SubstituteDelegation.substitute_faculty_user_id == user.id,
                SubstituteDelegation.status == DelegationStatus.ACTIVE,
            )
        )
        deleg_res = await self.db.execute(deleg_stmt)
        for aid in deleg_res.scalars().all():
            assignment_ids.add(aid)

        # 3. Sessions conducted by this faculty
        sess_stmt = select(AttendanceSession.teaching_assignment_id).where(
            AttendanceSession.conducting_faculty_user_id == user.id
        )
        sess_res = await self.db.execute(sess_stmt)
        for aid in sess_res.scalars().all():
            assignment_ids.add(aid)

        return list(assignment_ids)


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

        # Filter applicable delegations by term
        valid_delegations = []
        for delg in delegations:
            if academic_term_id and delg.teaching_assignment.academic_term_id != academic_term_id:
                continue
            valid_delegations.append(delg)

        # 3. Compute real dynamic attendance stats per teaching assignment
        all_ta_ids = [ta.id for ta in direct_assignments] + [d.teaching_assignment.id for d in valid_delegations]
        ta_stats = {}
        if all_ta_ids:
            sess_stmt = (
                select(AttendanceSession)
                .where(
                    and_(
                        AttendanceSession.teaching_assignment_id.in_(all_ta_ids),
                        AttendanceSession.applicability_status == SessionApplicability.COUNTED,
                        AttendanceSession.session_status == AttendanceSessionStatus.FINALIZED,
                    )
                )
            )
            sess_res = await self.db.execute(sess_stmt)
            sessions = sess_res.scalars().all()

            ta_session_map = {}
            for s in sessions:
                ta_session_map.setdefault(s.teaching_assignment_id, []).append(s)

            for ta_id in all_ta_ids:
                s_list = ta_session_map.get(ta_id, [])
                held = len(s_list)
                if held > 0:
                    s_ids = [s.id for s in s_list]
                    rec_stmt = select(AttendanceRecord).where(
                        AttendanceRecord.attendance_session_id.in_(s_ids)
                    )
                    rec_res = await self.db.execute(rec_stmt)
                    records = rec_res.scalars().all()
                    tot_rec = len(records)
                    att_rec = sum(
                        1 for r in records
                        if r.attendance_status in (AttendanceStatus.PRESENT, AttendanceStatus.EXCUSED)
                    )
                    avg = round((att_rec / tot_rec) * 100.0, 1) if tot_rec > 0 else None
                    ta_stats[ta_id] = (held, avg)
                else:
                    ta_stats[ta_id] = (0, None)

        results: List[FacultyTeachingAssignment] = []
        for ta in direct_assignments:
            held, avg = ta_stats.get(ta.id, (0, None))
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
                    held_count=held,
                    average_attendance_pct=avg,
                )
            )

        for delg in valid_delegations:
            ta = delg.teaching_assignment
            held, avg = ta_stats.get(ta.id, (0, None))
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
                    held_count=held,
                    average_attendance_pct=avg,
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

        # Authority Notification Matrix Rule 3: Delegation granted
        try:
            from src.services.notification_service import NotificationRoutingService
            await NotificationRoutingService.notify_delegation_granted_or_revoked(
                db=self.db,
                delegation_id=delegation.id,
                regular_faculty_user_id=assignment.faculty_user_id,
                substitute_faculty_user_id=payload.substitute_faculty_user_id,
                is_granted=True,
                reason=payload.delegation_reason or "",
            )
        except Exception as e:
            import logging
            logging.getLogger("klasio.notifications").warning(f"Failed to route delegation creation notification: {e}")

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

        # Authority Notification Matrix Rule 3: Delegation revoked
        try:
            from src.services.notification_service import NotificationRoutingService
            await NotificationRoutingService.notify_delegation_granted_or_revoked(
                db=self.db,
                delegation_id=delegation.id,
                regular_faculty_user_id=delegation.regular_faculty_user_id,
                substitute_faculty_user_id=delegation.substitute_faculty_user_id,
                is_granted=False,
                reason=payload.revocation_reason or "",
            )
        except Exception as e:
            import logging
            logging.getLogger("klasio.notifications").warning(f"Failed to route delegation revocation notification: {e}")

        return delegation
