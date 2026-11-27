from datetime import date, datetime, timedelta, timezone
import math
from typing import Dict, List, Optional, Set, Tuple
import uuid
from sqlalchemy import select, and_, or_, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.core.exceptions import EntityNotFoundError, OutOfScopeError, UnauthorizedRoleError
from src.models.academic import AcademicTerm, ClassSection, Subject, DeploymentConfig
from src.models.assignment import TeachingAssignment, SubstituteDelegation, DelegationStatus
from src.models.attendance import (
    AttendanceSession,
    AttendanceRecord,
    SessionApplicability,
    AttendanceStatus,
    AttendanceSessionStatus,
)
from src.models.enrollment import StudentEnrollment, EnrollmentStatus
from src.models.user import User, UserRole
from src.schemas.analytics import (
    AnalyticsOverviewResponse,
    SectionAnalyticsResponse,
    SectionOverviewSummary,
    StudentAttentionItem,
    WeeklyTrendPoint,
)
from src.services.scoping_service import ScopingService


async def get_institution_threshold(db: AsyncSession, institution_id: Optional[uuid.UUID] = None) -> float:
    """Retrieve institution-configured attendance shortage threshold from DeploymentConfig."""
    stmt = select(DeploymentConfig.attendance_shortage_threshold).limit(1)
    if institution_id:
        stmt = stmt.where(DeploymentConfig.institution_id == institution_id)
    val = (await db.execute(stmt)).scalar_one_or_none()
    return float(val) if val is not None else 75.0


def calculate_recovery_classes(attended: int, held: int, threshold: float = 75.0) -> Tuple[Optional[int], bool]:
    """
    Number of consecutive classes a student must attend to reach threshold T:
    R = ceil((T * H - 100 * A) / (100 - T)) when current attendance is below T.
    When current attendance is at or above T, R = 0, is_recoverable = True.
    When threshold is 100% and A < H, recovery to 100% is mathematically impossible:
      returns (None, False).
    When H == 0: returns (0, True).
    """
    if held == 0:
        return 0, True
    current_pct = (attended / held) * 100.0
    if current_pct >= threshold:
        return 0, True
    if threshold >= 100.0:
        return None, False

    numerator = threshold * held - 100.0 * attended
    denominator = 100.0 - threshold
    return max(0, math.ceil(numerator / denominator)), True


def calculate_can_miss_classes(attended: int, held: int, threshold: float = 75.0) -> int:
    """
    Number of future classes that can be missed while staying strictly at or above threshold T:
    M = floor(100 * A / T - H) when current attendance is strictly above T.
    Otherwise M = 0.
    """
    if held == 0 or threshold <= 0:
        return 0
    current_pct = (attended / held) * 100.0
    if current_pct <= threshold:
        return 0
    max_held = (100.0 * attended) / threshold
    return max(0, math.floor(max_held - held))


class AnalyticsService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_consecutive_absences_for_student(
        self,
        student_user_id: uuid.UUID,
        teaching_assignment_id: uuid.UUID,
        effective_start_date: date,
        effective_end_date: Optional[date] = None,
    ) -> int:
        """
        Calculate consecutive absences for a student in a teaching assignment.
        Inspects the student's most recent eligible, finalized COUNTED sessions
        in reverse chronological order.
        Stops when the latest applicable student record is not ABSENT.
        """
        conditions = [
            AttendanceSession.teaching_assignment_id == teaching_assignment_id,
            AttendanceSession.applicability_status == SessionApplicability.COUNTED,
            AttendanceSession.session_status == AttendanceSessionStatus.FINALIZED,
            AttendanceSession.session_date >= effective_start_date,
        ]
        if effective_end_date is not None:
            conditions.append(AttendanceSession.session_date <= effective_end_date)

        sess_stmt = (
            select(AttendanceSession)
            .where(and_(*conditions))
            .order_by(AttendanceSession.session_date.desc(), AttendanceSession.period_slot_or_sequence.desc())
        )
        sess_res = await self.db.execute(sess_stmt)
        sessions = sess_res.scalars().all()

        if not sessions:
            return 0

        session_ids = [s.id for s in sessions]
        rec_stmt = select(AttendanceRecord).where(
            and_(
                AttendanceRecord.attendance_session_id.in_(session_ids),
                AttendanceRecord.student_user_id == student_user_id,
            )
        )
        rec_res = await self.db.execute(rec_stmt)
        record_map = {r.attendance_session_id: r.attendance_status for r in rec_res.scalars().all()}

        consecutive_count = 0
        for sess in sessions:
            status = record_map.get(sess.id)
            if status == AttendanceStatus.ABSENT:
                consecutive_count += 1
            else:
                # Stop as soon as a session was PRESENT or EXCUSED (or unrecorded)
                break

        return consecutive_count

    async def get_assignment_analytics(
        self,
        current_user: User,
        teaching_assignment_id: uuid.UUID,
        threshold: float = 75.0,
        consecutive_threshold: int = 2,
        start_date: Optional[date] = None,
        end_date: Optional[date] = None,
    ) -> SectionAnalyticsResponse:
        """
        Compute assignment-level attendance analytics, trend points, and shortage intelligence.
        Enforces faculty academic scope (direct assignment or active delegation) and Admin privileges.
        Students are forbidden.
        """
        if current_user.role == UserRole.STUDENT:
            raise UnauthorizedRoleError("Students cannot access assignment analytics")

        # 1. Scoping guard
        if current_user.role == UserRole.FACULTY:
            # Check IAC v1 hierarchical scope first (covers HOD at Department level, Class Advisor at Section level, etc.)
            from src.services.authorization_evaluator import AuthorizationEvaluator
            from src.models.access_control import DEFAULT_INSTITUTION_ID
            evaluator = AuthorizationEvaluator(self.db)
            decision = await evaluator.evaluate(
                actor_user_id=current_user.id,
                permission_code="reports.view",
                institution_id=uuid.UUID(str(DEFAULT_INSTITUTION_ID)),
                resource_type="TEACHING_ASSIGNMENT",
                resource_id=teaching_assignment_id,
            )
            if not decision.allowed:
                # Fall back to direct faculty assignment or substitute delegation
                scoping = ScopingService(self.db)
                await scoping.verify_faculty_scope(
                    faculty_user_id=current_user.id,
                    teaching_assignment_id=teaching_assignment_id,
                    session_date=date.today(),
                )

        # 2. Fetch assignment metadata
        ta_stmt = (
            select(TeachingAssignment)
            .options(
                selectinload(TeachingAssignment.class_section),
                selectinload(TeachingAssignment.subject),
                selectinload(TeachingAssignment.academic_term),
                selectinload(TeachingAssignment.faculty_user),
            )
            .where(TeachingAssignment.id == teaching_assignment_id)
        )
        ta_res = await self.db.execute(ta_stmt)
        ta = ta_res.scalar_one_or_none()
        if not ta:
            raise EntityNotFoundError(f"Teaching assignment {teaching_assignment_id} not found")

        is_delegated = (
            current_user.role == UserRole.FACULTY and ta.faculty_user_id != current_user.id
        )

        # 3. Fetch all sessions for assignment
        sess_stmt = (
            select(AttendanceSession)
            .where(
                and_(
                    AttendanceSession.teaching_assignment_id == teaching_assignment_id,
                    AttendanceSession.session_status.in_([AttendanceSessionStatus.FINALIZED, AttendanceSessionStatus.SYNCED]),
                )
            )
            .order_by(AttendanceSession.session_date.asc(), AttendanceSession.period_slot_or_sequence.asc())
        )
        if start_date:
            sess_stmt = sess_stmt.where(AttendanceSession.session_date >= start_date)
        if end_date:
            sess_stmt = sess_stmt.where(AttendanceSession.session_date <= end_date)

        sess_res = await self.db.execute(sess_stmt)
        all_sessions = sess_res.scalars().all()

        total_held = sum(1 for s in all_sessions if s.applicability_status == SessionApplicability.COUNTED)
        total_cancelled = sum(1 for s in all_sessions if s.applicability_status == SessionApplicability.CANCELLED)
        total_exempt = sum(1 for s in all_sessions if s.applicability_status == SessionApplicability.EXEMPT)

        counted_sessions = [s for s in all_sessions if s.applicability_status == SessionApplicability.COUNTED]
        counted_session_ids = [s.id for s in counted_sessions]

        # 4. Fetch enrolled students for section (including active, transferred, completed, and withdrawn)
        enr_stmt = (
            select(StudentEnrollment)
            .options(
                selectinload(StudentEnrollment.student_user).selectinload(User.face_profile),
            )
            .where(
                and_(
                    StudentEnrollment.class_section_id == ta.class_section_id,
                    StudentEnrollment.enrollment_status.in_([
                        EnrollmentStatus.ACTIVE,
                        EnrollmentStatus.TRANSFERRED,
                        EnrollmentStatus.WITHDRAWN,
                        EnrollmentStatus.COMPLETED,
                    ]),
                )
            )
            .order_by(StudentEnrollment.created_at.asc())
        )
        enr_res = await self.db.execute(enr_stmt)
        enrollments = enr_res.scalars().all()

        # Fetch all attendance records for counted sessions
        rec_map: Dict[Tuple[uuid.UUID, uuid.UUID], AttendanceStatus] = {}
        if counted_session_ids:
            rec_stmt = select(AttendanceRecord).where(
                AttendanceRecord.attendance_session_id.in_(counted_session_ids)
            )
            rec_res = await self.db.execute(rec_stmt)
            for r in rec_res.scalars().all():
                rec_map[(r.attendance_session_id, r.student_user_id)] = r.attendance_status

        # 5. Compute student-level metrics
        roster_summaries: List[StudentAttentionItem] = []
        students_needing_attention: List[StudentAttentionItem] = []

        total_section_eligible = 0
        total_section_attended = 0

        for enr in enrollments:
            student = enr.student_user
            face_state = "UNREGISTERED"
            if student.face_profile and student.face_profile.registration_state:
                face_state = student.face_profile.registration_state.value

            # Filter counted sessions within student's enrollment dates
            student_eligible_sessions = [
                s for s in counted_sessions
                if s.session_date >= enr.effective_start_date and (enr.effective_end_date is None or s.session_date <= enr.effective_end_date)
            ]
            held_for_student = len(student_eligible_sessions)
            attended_for_student = sum(
                1 for s in student_eligible_sessions
                if rec_map.get((s.id, student.id)) in (AttendanceStatus.PRESENT, AttendanceStatus.EXCUSED)
            )

            pct = None if held_for_student == 0 else round((attended_for_student / held_for_student) * 100.0, 1)

            # Consecutive absences
            consecutive_absent = 0
            for s in reversed(student_eligible_sessions):
                status = rec_map.get((s.id, student.id))
                if status == AttendanceStatus.ABSENT:
                    consecutive_absent += 1
                else:
                    break

            recover, is_rec = calculate_recovery_classes(attended_for_student, held_for_student, threshold)
            miss = calculate_can_miss_classes(attended_for_student, held_for_student, threshold)
            is_shortage = (held_for_student > 0) and (pct is not None) and (pct < threshold)
            to_recover = recover if is_shortage else 0

            item = StudentAttentionItem(
                student_user_id=student.id,
                institutional_id=student.institutional_id,
                student_name=student.full_name,
                attendance_percentage=pct,
                attended_sessions=attended_for_student,
                total_eligible_sessions=held_for_student,
                consecutive_absences=consecutive_absent,
                classes_to_recover=to_recover,
                classes_can_miss=miss,
                is_shortage=is_shortage,
                is_recoverable=is_rec,
                face_registration_state=face_state,
            )
            roster_summaries.append(item)

            if is_shortage or consecutive_absent >= consecutive_threshold:
                students_needing_attention.append(item)

            total_section_eligible += held_for_student
            total_section_attended += attended_for_student

        # Sort attention list: lowest percentage first, then highest consecutive absences
        students_needing_attention.sort(
            key=lambda x: (x.attendance_percentage if x.attendance_percentage is not None else 0.0, -x.consecutive_absences)
        )

        section_avg_pct = (
            None if total_section_eligible == 0 else round((total_section_attended / total_section_eligible) * 100.0, 1)
        )

        # 6. Compute weekly trend points
        trend: List[WeeklyTrendPoint] = []
        if counted_sessions:
            weeks_dict: Dict[Tuple[int, int], List[AttendanceSession]] = {}
            for s in counted_sessions:
                iso_year, iso_week, _ = s.session_date.isocalendar()
                key = (iso_year, iso_week)
                weeks_dict.setdefault(key, []).append(s)

            for idx, ((yr, wk), w_sessions) in enumerate(sorted(weeks_dict.items()), 1):
                # Calculate start date (Monday) of ISO week
                w_monday = date.fromisocalendar(yr, wk, 1)
                w_sunday = date.fromisocalendar(yr, wk, 7)

                w_eligible = 0
                w_present = 0
                for s in w_sessions:
                    for enr in enrollments:
                        if s.session_date >= enr.effective_start_date and (enr.effective_end_date is None or s.session_date <= enr.effective_end_date):
                            w_eligible += 1
                            if rec_map.get((s.id, enr.student_user_id)) in (AttendanceStatus.PRESENT, AttendanceStatus.EXCUSED):
                                w_present += 1

                w_pct = None if w_eligible == 0 else round((w_present / w_eligible) * 100.0, 1)

                trend.append(
                    WeeklyTrendPoint(
                        period_label=f"W{idx}",
                        start_date=w_monday,
                        end_date=w_sunday,
                        held_sessions=len(w_sessions),
                        attendance_percentage=w_pct,
                        total_present=w_present,
                        total_eligible=w_eligible,
                    )
                )

        return SectionAnalyticsResponse(
            teaching_assignment_id=ta.id,
            class_section_id=ta.class_section_id,
            section_code=ta.class_section.section_code,
            subject_id=ta.subject_id,
            subject_code=ta.subject.code,
            subject_name=ta.subject.name,
            academic_term_id=ta.academic_term_id,
            term_name=ta.academic_term.name,
            faculty_name=ta.faculty_user.full_name,
            is_delegated=is_delegated,
            total_held_sessions=total_held,
            total_cancelled_sessions=total_cancelled,
            total_exempt_sessions=total_exempt,
            average_attendance_percentage=section_avg_pct,
            threshold=threshold,
            shortage_count=len([s for s in roster_summaries if s.is_shortage]),
            total_enrolled_students=len(enrollments),
            trend=trend,
            students_needing_attention=students_needing_attention,
            roster_summaries=roster_summaries,
        )

    async def get_overview(
        self,
        current_user: User,
        academic_term_id: Optional[uuid.UUID] = None,
        threshold: float = 75.0,
        consecutive_threshold: int = 2,
    ) -> AnalyticsOverviewResponse:
        """
        Generate aggregate attendance overview.
        - ADMIN: Institutional summary across all teaching assignments.
        - FACULTY: Scoped strictly to their assigned classes and active delegations.
        - STUDENT: Returns personal summary across their enrolled subjects.
        """
        if current_user.role == UserRole.STUDENT:
            raise UnauthorizedRoleError(
                "Students cannot access institutional attendance overview. Use /api/v1/student/attendance instead."
            )

        # Faculty or Admin overview
        target_assignments: List[TeachingAssignment] = []
        delegated_assignment_ids: Set[uuid.UUID] = set()

        if current_user.role == UserRole.FACULTY:
            scoping = ScopingService(self.db)
            faculty_assignments = await scoping.get_faculty_assignments(
                faculty_user_id=current_user.id,
                academic_term_id=academic_term_id,
                on_date=date.today(),
            )
            assignment_ids = set(fa.teaching_assignment_id for fa in faculty_assignments)
            for fa in faculty_assignments:
                if fa.is_delegated:
                    delegated_assignment_ids.add(fa.teaching_assignment_id)

            # Check active IAC scopes (e.g. HOD scoped to Department, Class Advisor scoped to Section, Academic Admin)
            from src.models.access_control import (
                InstitutionMembership,
                MembershipStatus,
                RoleAssignment,
                AssignmentStatus,
                RoleAssignmentScope,
                RoleScopeType,
            )
            now = datetime.now(timezone.utc)
            ra_stmt = (
                select(RoleAssignmentScope)
                .join(RoleAssignment, RoleAssignmentScope.role_assignment_id == RoleAssignment.id)
                .join(InstitutionMembership, RoleAssignment.membership_id == InstitutionMembership.id)
                .where(
                    and_(
                        InstitutionMembership.user_id == current_user.id,
                        InstitutionMembership.status == MembershipStatus.ACTIVE,
                        RoleAssignment.status == AssignmentStatus.ACTIVE,
                        RoleAssignment.valid_from <= now,
                        or_(RoleAssignment.valid_until.is_(None), RoleAssignment.valid_until > now),
                    )
                )
            )
            ra_scopes = (await self.db.execute(ra_stmt)).scalars().all()

            extra_conditions = []
            for scope in ra_scopes:
                if scope.scope_type == RoleScopeType.INSTITUTION:
                    extra_conditions.append(True)
                    break
                elif scope.scope_type == RoleScopeType.DEPARTMENT and scope.department_id:
                    extra_conditions.append(
                        TeachingAssignment.class_section.has(ClassSection.department_id == scope.department_id)
                    )
                elif scope.scope_type == RoleScopeType.CLASS_SECTION and scope.class_section_id:
                    extra_conditions.append(TeachingAssignment.class_section_id == scope.class_section_id)

            if extra_conditions:
                scoped_stmt = select(TeachingAssignment.id).where(
                    TeachingAssignment.is_active == True,
                    or_(*extra_conditions),
                )
                if academic_term_id:
                    scoped_stmt = scoped_stmt.where(TeachingAssignment.academic_term_id == academic_term_id)
                scoped_ids = (await self.db.execute(scoped_stmt)).scalars().all()
                assignment_ids.update(scoped_ids)

            if assignment_ids:
                stmt = (
                    select(TeachingAssignment)
                    .options(
                        selectinload(TeachingAssignment.class_section),
                        selectinload(TeachingAssignment.subject),
                        selectinload(TeachingAssignment.academic_term),
                        selectinload(TeachingAssignment.faculty_user),
                    )
                    .where(TeachingAssignment.id.in_(list(assignment_ids)))
                )
                if academic_term_id:
                    stmt = stmt.where(TeachingAssignment.academic_term_id == academic_term_id)
                res = await self.db.execute(stmt)
                target_assignments = res.scalars().all()
        else:
            # Admin sees all active teaching assignments
            stmt = (
                select(TeachingAssignment)
                .options(
                    selectinload(TeachingAssignment.class_section),
                    selectinload(TeachingAssignment.subject),
                    selectinload(TeachingAssignment.academic_term),
                    selectinload(TeachingAssignment.faculty_user),
                )
                .where(TeachingAssignment.is_active == True)
            )
            if academic_term_id:
                stmt = stmt.where(TeachingAssignment.academic_term_id == academic_term_id)
            res = await self.db.execute(stmt)
            target_assignments = res.scalars().all()

        section_summaries: List[SectionOverviewSummary] = []
        all_attention_students: List[StudentAttentionItem] = []
        total_held_all = 0
        total_eligible_all = 0
        total_attended_all = 0

        for ta in target_assignments:
            sec_analytics = await self.get_assignment_analytics(
                current_user=current_user,
                teaching_assignment_id=ta.id,
                threshold=threshold,
                consecutive_threshold=consecutive_threshold,
            )
            is_del = ta.id in delegated_assignment_ids

            section_summaries.append(
                SectionOverviewSummary(
                    teaching_assignment_id=ta.id,
                    class_section_id=ta.class_section_id,
                    section_code=sec_analytics.section_code,
                    subject_code=sec_analytics.subject_code,
                    subject_name=sec_analytics.subject_name,
                    faculty_name=sec_analytics.faculty_name,
                    held_sessions=sec_analytics.total_held_sessions,
                    average_attendance_percentage=sec_analytics.average_attendance_percentage,
                    shortage_count=sec_analytics.shortage_count,
                    total_enrolled=sec_analytics.total_enrolled_students,
                    is_delegated=is_del,
                )
            )

            all_attention_students.extend(sec_analytics.students_needing_attention)
            total_held_all += sec_analytics.total_held_sessions
            for r in sec_analytics.roster_summaries:
                total_eligible_all += r.total_eligible_sessions
                total_attended_all += r.attended_sessions

        # Deduplicate attention students if student is in multiple sections
        unique_attention_students: List[StudentAttentionItem] = []
        seen_student_ids: Set[uuid.UUID] = set()
        for item in sorted(all_attention_students, key=lambda x: (x.attendance_percentage if x.attendance_percentage is not None else 0.0, -x.consecutive_absences)):
            if item.student_user_id not in seen_student_ids:
                seen_student_ids.add(item.student_user_id)
                unique_attention_students.append(item)

        overall_pct = (
            None if total_eligible_all == 0 else round((total_attended_all / total_eligible_all) * 100.0, 1)
        )

        return AnalyticsOverviewResponse(
            role=current_user.role.value,
            academic_term_id=academic_term_id,
            threshold=threshold,
            consecutive_absent_threshold=consecutive_threshold,
            total_sections=len(section_summaries),
            total_held_sessions=total_held_all,
            overall_attendance_percentage=overall_pct,
            total_students_at_risk=len(unique_attention_students),
            sections=section_summaries,
            students_needing_attention=unique_attention_students,
            weekly_trend=[],
        )
