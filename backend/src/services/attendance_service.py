from datetime import date, datetime, timezone
from typing import List, Optional, Tuple
import uuid
from sqlalchemy import and_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.core.exceptions import (
    ConflictError,
    DuplicateSessionError,
    EligibilityError,
    EntityNotFoundError,
    OutOfScopeError,
)
from src.models.access_control import InstitutionMembership
from src.models.assignment import TeachingAssignment, SubstituteDelegation, DelegationStatus
from src.models.attendance import (
    AttendanceRecord,
    AttendanceSession,
    AttendanceSessionStatus,
    AttendanceStatus,
    MarkSource,
    SessionApplicability,
)
from src.models.user import User, UserRole
from src.schemas.attendance import (
    BatchSyncRequest,
    BatchSyncResponse,
    BatchSyncResultItem,
    SubmitAttendanceSessionRequest,
    SyncResultStatus,
)
from src.services.enrollment_service import EnrollmentService
from src.services.scoping_service import ScopingService


class AttendanceService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def sync_session(
        self,
        current_user: User,
        session_req: SubmitAttendanceSessionRequest,
    ) -> BatchSyncResultItem:
        """
        Synchronize a single client-finalized attendance session.
        Applies idempotency, canonical payload hash verification, faculty authorization,
        date-bounded roster eligibility, server-derived count computation, and ACID commit.
        Guarantees exactly-once logical persistence under retried synchronization.
        Enforces privacy boundary: zero raw classroom images, face crops, or biometric embedding
        vectors enter the backend sync payload or tables; candidate confidence is preserved strictly
        as derived recognition metadata where required by the attendance schema.
        """
        computed_hash = session_req.compute_canonical_hash()

        # 1. Idempotency Check by client_session_uuid
        stmt = (
            select(AttendanceSession)
            .where(AttendanceSession.client_session_uuid == session_req.client_session_uuid)
        )
        res = await self.db.execute(stmt)
        existing_by_uuid = res.scalar_one_or_none()

        if existing_by_uuid:
            # Check for content tampering/divergence on retry
            if existing_by_uuid.payload_hash and existing_by_uuid.payload_hash != computed_hash:
                return BatchSyncResultItem(
                    client_session_uuid=session_req.client_session_uuid,
                    status=SyncResultStatus.CONFLICT,
                    server_session_id=existing_by_uuid.id,
                    error_message=(
                        f"Session {session_req.client_session_uuid} was already synchronized with different "
                        "attendance decisions. Silent overwrite is forbidden; post-finalization amendment required."
                    ),
                    records_count=existing_by_uuid.records_count,
                    present_count=existing_by_uuid.present_count,
                    absent_count=existing_by_uuid.absent_count,
                    excused_count=existing_by_uuid.excused_count,
                )

            # Identical payload retry - deterministic idempotent ACK
            return BatchSyncResultItem(
                client_session_uuid=session_req.client_session_uuid,
                status=SyncResultStatus.ALREADY_SYNCED,
                server_session_id=existing_by_uuid.id,
                error_message=None,
                records_count=existing_by_uuid.records_count,
                present_count=existing_by_uuid.present_count,
                absent_count=existing_by_uuid.absent_count,
                excused_count=existing_by_uuid.excused_count,
            )

        # 2. Slot Collision Check by (teaching_assignment_id, session_date, period_slot_or_sequence)
        slot_stmt = select(AttendanceSession).where(
            and_(
                AttendanceSession.teaching_assignment_id == session_req.teaching_assignment_id,
                AttendanceSession.session_date == session_req.session_date,
                AttendanceSession.period_slot_or_sequence == session_req.period_slot_or_sequence,
            )
        )
        slot_res = await self.db.execute(slot_stmt)
        existing_by_slot = slot_res.scalar_one_or_none()

        if existing_by_slot:
            return BatchSyncResultItem(
                client_session_uuid=session_req.client_session_uuid,
                status=SyncResultStatus.CONFLICT,
                server_session_id=existing_by_slot.id,
                error_message=(
                    f"Session slot already finalized for assignment {session_req.teaching_assignment_id} "
                    f"on {session_req.session_date} slot {session_req.period_slot_or_sequence} "
                    f"(existing session ID: {existing_by_slot.id})"
                ),
            )

        # 3. Faculty Authorization & Scope Verification
        scoping_service = ScopingService(self.db)
        delegation_id: Optional[uuid.UUID] = None

        if current_user.role != UserRole.ADMIN:
            try:
                is_auth, active_delg_id = await scoping_service.verify_faculty_scope(
                    faculty_user_id=current_user.id,
                    teaching_assignment_id=session_req.teaching_assignment_id,
                    session_date=session_req.session_date,
                )
                delegation_id = active_delg_id
            except (OutOfScopeError, EntityNotFoundError) as e:
                return BatchSyncResultItem(
                    client_session_uuid=session_req.client_session_uuid,
                    status=SyncResultStatus.REJECTED,
                    error_message=f"Authorization rejected: {str(e)}",
                )

        # Fetch teaching assignment for section details & regular faculty attribution
        ta_stmt = select(TeachingAssignment).where(TeachingAssignment.id == session_req.teaching_assignment_id)
        ta_res = await self.db.execute(ta_stmt)
        assignment = ta_res.scalar_one_or_none()

        if not assignment:
            return BatchSyncResultItem(
                client_session_uuid=session_req.client_session_uuid,
                status=SyncResultStatus.REJECTED,
                error_message=f"Teaching assignment {session_req.teaching_assignment_id} not found",
            )

        regular_faculty_id = assignment.faculty_user_id
        conducting_faculty_id = current_user.id

        # 4. Roster & Date-Bounded Student Eligibility Validation
        enrollment_service = EnrollmentService(self.db)
        eligible_students = await enrollment_service.get_eligible_students_for_section(
            class_section_id=assignment.class_section_id,
            session_date=session_req.session_date,
        )
        eligible_student_ids = {s.student_user_id for s in eligible_students}

        # Check for students submitted in records who are not in eligible cohort
        ineligible_ids = []
        for rec in session_req.records:
            if rec.student_user_id not in eligible_student_ids:
                ineligible_ids.append(str(rec.student_user_id))

        if ineligible_ids:
            return BatchSyncResultItem(
                client_session_uuid=session_req.client_session_uuid,
                status=SyncResultStatus.REJECTED,
                error_message=(
                    f"Submission contains {len(ineligible_ids)} student(s) not eligible for section "
                    f"{assignment.class_section_id} on {session_req.session_date}: {ineligible_ids[:5]}"
                ),
            )

        # In COUNTED sessions, verify all eligible students are accounted for
        if session_req.applicability_status == SessionApplicability.COUNTED:
            submitted_ids = {rec.student_user_id for rec in session_req.records}
            missing_ids = eligible_student_ids - submitted_ids
            if missing_ids:
                return BatchSyncResultItem(
                    client_session_uuid=session_req.client_session_uuid,
                    status=SyncResultStatus.REJECTED,
                    error_message=(
                        f"Incomplete submission for COUNTED session: {len(missing_ids)} eligible student(s) "
                        f"omitted from final attendance roster."
                    ),
                )

        # 5. Server-Derived Counts (Do not trust client totals blindly)
        present_count = sum(1 for r in session_req.records if r.attendance_status == AttendanceStatus.PRESENT)
        absent_count = sum(1 for r in session_req.records if r.attendance_status == AttendanceStatus.ABSENT)
        excused_count = sum(1 for r in session_req.records if r.attendance_status == AttendanceStatus.EXCUSED)
        records_count = len(session_req.records)

        # 6. Atomic Database Transaction Commit
        try:
            # Resolve memberships for provenance
            actor_mem_id = getattr(session_req, "actor_membership_id", None)
            if not actor_mem_id:
                m_res = await self.db.execute(
                    select(InstitutionMembership.id).where(InstitutionMembership.user_id == current_user.id)
                )
                actor_mem_id = m_res.scalar_one_or_none()

            cond_mem_id = None
            if conducting_faculty_id == current_user.id and actor_mem_id:
                cond_mem_id = actor_mem_id
            else:
                m_res = await self.db.execute(
                    select(InstitutionMembership.id).where(InstitutionMembership.user_id == conducting_faculty_id)
                )
                cond_mem_id = m_res.scalar_one_or_none()

            effective_delegation_id = getattr(session_req, "delegation_id", None)

            new_session = AttendanceSession(
                id=uuid.uuid4(),
                institution_id=assignment.institution_id if hasattr(assignment, "institution_id") and assignment.institution_id else None,
                client_session_uuid=session_req.client_session_uuid,
                teaching_assignment_id=session_req.teaching_assignment_id,
                timetable_entry_id=getattr(session_req, "timetable_entry_id", None),
                session_date=session_req.session_date,
                period_slot_or_sequence=session_req.period_slot_or_sequence,
                applicability_status=session_req.applicability_status,
                status_reason=session_req.status_reason,
                regular_faculty_user_id=regular_faculty_id,
                conducting_faculty_user_id=conducting_faculty_id,
                substitute_delegation_id=delegation_id,
                delegation_id=effective_delegation_id,
                authorizing_role_assignment_id=getattr(session_req, "authorizing_role_assignment_id", None),
                finalizing_actor_membership_id=actor_mem_id,
                permission_code="attendance.session.record",
                matched_scope_type="TEACHING_ASSIGNMENT",
                matched_scope_id=session_req.teaching_assignment_id,
                session_status=AttendanceSessionStatus.FINALIZED,
                finalized_at=session_req.finalized_at,
                payload_hash=computed_hash,
                records_count=records_count,
                present_count=present_count,
                absent_count=absent_count,
                excused_count=excused_count,
            )
            self.db.add(new_session)
            await self.db.flush()

            for rec in session_req.records:
                record_entity = AttendanceRecord(
                    id=uuid.uuid4(),
                    attendance_session_id=new_session.id,
                    student_user_id=rec.student_user_id,
                    attendance_status=rec.attendance_status,
                    mark_source=rec.mark_source,
                    candidate_confidence=rec.candidate_confidence,
                    recorded_at=rec.recorded_at,
                )
                self.db.add(record_entity)

            await self.db.flush()
            await self.db.commit()

            # Emit in-app notifications
            try:
                from src.services.notification_service import NotificationService
                notif_service = NotificationService(self.db)
                # 1. Notify conducting faculty
                await notif_service.create_notification(
                    user_id=conducting_faculty_id,
                    title="Attendance Session Synchronized",
                    message=f"Session for Period {session_req.period_slot_or_sequence} on {session_req.session_date} was synchronized ({present_count} present, {absent_count} absent).",
                    category="ATTENDANCE",
                    priority="NORMAL",
                    link_type="ATTENDANCE_SESSION",
                    link_id=str(new_session.id),
                    deduplication_key=f"sync_{new_session.id}",
                )
                # 2. Notify students of their recorded attendance
                for rec in session_req.records:
                    await notif_service.create_notification(
                        user_id=rec.student_user_id,
                        title="Class Attendance Recorded",
                        message=f"Your attendance for Period {session_req.period_slot_or_sequence} on {session_req.session_date} was marked {rec.attendance_status.value}.",
                        category="ATTENDANCE",
                        priority="HIGH" if rec.attendance_status.value == "ABSENT" else "NORMAL",
                        link_type="STUDENT_ATTENDANCE",
                        link_id=str(new_session.id),
                        deduplication_key=f"att_{new_session.id}_{rec.student_user_id}",
                    )
            except Exception as notif_err:
                # Notifications should never fail session synchronization
                pass

            return BatchSyncResultItem(
                client_session_uuid=session_req.client_session_uuid,
                status=SyncResultStatus.SYNCED,
                server_session_id=new_session.id,
                error_message=None,
                records_count=records_count,
                present_count=present_count,
                absent_count=absent_count,
                excused_count=excused_count,
            )
        except IntegrityError as e:
            # Catch concurrent race condition (e.g., simultaneous duplicate POST)
            await self.db.rollback()
            # If the integrity violation is on client_session_uuid, fetch the existing session and return ALREADY_SYNCED
            if "uq_attendance_session_client_uuid" in str(e.orig):
                res_check = await self.db.execute(
                    select(AttendanceSession).where(
                        AttendanceSession.client_session_uuid == session_req.client_session_uuid
                    )
                )
                existing = res_check.scalar_one_or_none()
                if existing:
                    return BatchSyncResultItem(
                        client_session_uuid=session_req.client_session_uuid,
                        status=SyncResultStatus.ALREADY_SYNCED,
                        server_session_id=existing.id,
                        error_message=None,
                        records_count=existing.records_count,
                        present_count=existing.present_count,
                        absent_count=existing.absent_count,
                        excused_count=existing.excused_count,
                    )
            return BatchSyncResultItem(
                client_session_uuid=session_req.client_session_uuid,
                status=SyncResultStatus.CONFLICT,
                error_message=f"Database integrity constraint violation during concurrent sync: {str(e.orig)}",
            )

    async def sync_batch(
        self,
        current_user: User,
        batch_req: BatchSyncRequest,
    ) -> BatchSyncResponse:
        """
        Synchronize multiple sessions sequentially within a single request.
        """
        results: List[BatchSyncResultItem] = []
        for s in batch_req.sessions:
            res = await self.sync_session(current_user, s)
            results.append(res)
        return BatchSyncResponse(results=results)
