from datetime import date, timedelta
from typing import List, Optional, Tuple
import uuid
from sqlalchemy import select, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.core.exceptions import EligibilityError, EntityNotFoundError
from src.models.academic import AcademicTerm, ClassSection, Subject
from src.models.assignment import TeachingAssignment
from src.models.attendance import (
    AttendanceRecord,
    AttendanceSession,
    AttendanceSessionStatus,
    AttendanceStatus,
    SessionApplicability,
)
from src.models.enrollment import EnrollmentStatus, FaceRegistrationStatus, StudentEnrollment, StudentFaceProfile
from src.models.user import AccountStatus, User, UserRole
from src.schemas.assignment import FaceRegistrationState, RosterStudentItem
from src.schemas.enrollment import (
    BulkStudentEnrollmentRow,
    BulkEnrollmentPreviewItem,
    BulkEnrollmentPreviewRequest,
    BulkEnrollmentPreviewResponse,
    BulkEnrollmentExecuteRequest,
    BulkEnrollmentExecuteResponse,
    SectionRosterStudentItem,
    SectionRosterResponse,
    StudentCurrentEnrollmentResponse,
    StudentEnrollmentCreate,
    StudentPersonalAttendanceResponse,
    StudentSessionHistoryItem,
    StudentSubjectAttendanceSummary,
    StudentSubjectHistoryResponse,
    StudentTransferRequest,
    StudentWeeklyTrendPoint,
)
from src.core.security import get_password_hash
from src.models.access_control import InstitutionMembership, MembershipStatus, DEFAULT_INSTITUTION_ID
from src.services.analytics_service import (
    calculate_recovery_classes,
    calculate_can_miss_classes,
    get_institution_threshold,
)


class EnrollmentService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def enroll_student(self, payload: StudentEnrollmentCreate) -> StudentEnrollment:
        """Enroll a student into a class section with date-bounded lifecycle."""
        # 1. Verify student exists and has STUDENT role
        user_stmt = select(User).where(User.id == payload.student_user_id)
        user_res = await self.db.execute(user_stmt)
        student = user_res.scalar_one_or_none()

        if not student:
            raise EntityNotFoundError(f"Student user {payload.student_user_id} not found")
        if student.role != UserRole.STUDENT:
            raise EligibilityError(f"User {payload.student_user_id} does not have STUDENT role")

        # Validate section existence and tenant membership consistency
        sec_stmt = select(ClassSection).where(ClassSection.id == payload.class_section_id)
        sec_res = await self.db.execute(sec_stmt)
        section = sec_res.scalar_one_or_none()
        if not section:
            raise EntityNotFoundError(f"Class section {payload.class_section_id} not found")

        from src.models.access_control import InstitutionMembership, MembershipStatus
        mem_stmt = select(InstitutionMembership).where(InstitutionMembership.user_id == payload.student_user_id)
        mems = (await self.db.execute(mem_stmt)).scalars().all()
        if mems:
            has_active = any(m.institution_id == section.institution_id and m.status == MembershipStatus.ACTIVE for m in mems)
            if not has_active:
                raise EligibilityError(
                    f"Student {payload.student_user_id} does not have an active membership in institution {section.institution_id}"
                )

        # 2. Invariant: Check for conflicting overlapping active enrollments in the same term
        overlap_stmt = select(StudentEnrollment).where(
            and_(
                StudentEnrollment.student_user_id == payload.student_user_id,
                StudentEnrollment.academic_term_id == payload.academic_term_id,
                StudentEnrollment.enrollment_status == EnrollmentStatus.ACTIVE,
            )
        )
        overlap_res = await self.db.execute(overlap_stmt)
        existing_enrollments = overlap_res.scalars().all()

        for ex in existing_enrollments:
            # Overlap condition between [start1, end1] and [start2, end2]
            ex_end = ex.effective_end_date or date.max
            new_end = payload.effective_end_date or date.max
            if max(ex.effective_start_date, payload.effective_start_date) <= min(ex_end, new_end):
                raise EligibilityError(
                    f"Student {payload.student_user_id} already has an overlapping active enrollment "
                    f"in section {ex.class_section_id} ({ex.effective_start_date} to {ex.effective_end_date})"
                )

        enrollment = StudentEnrollment(
            student_user_id=payload.student_user_id,
            class_section_id=payload.class_section_id,
            academic_term_id=payload.academic_term_id,
            effective_start_date=payload.effective_start_date,
            effective_end_date=payload.effective_end_date,
            enrollment_status=payload.enrollment_status,
        )
        self.db.add(enrollment)
        await self.db.flush()
        await self.db.refresh(enrollment)
        return enrollment

    async def get_eligible_students_for_section(
        self,
        class_section_id: uuid.UUID,
        session_date: date,
    ) -> List[RosterStudentItem]:
        """
        Evaluate eligible student cohort for a class section on session_date.
        Strictly applies: effective_start_date <= session_date AND (session_date <= effective_end_date OR effective_end_date IS NULL).
        Includes ACTIVE and historical (TRANSFERRED, COMPLETED) enrollments whose effective interval contained session_date.
        Dynamically resolves face registration state (REGISTERED, PENDING, UNREGISTERED).
        """
        stmt = (
            select(StudentEnrollment)
            .options(
                selectinload(StudentEnrollment.student_user).selectinload(User.face_profile)
            )
            .where(
                and_(
                    StudentEnrollment.class_section_id == class_section_id,
                    StudentEnrollment.enrollment_status.in_(
                        [EnrollmentStatus.ACTIVE, EnrollmentStatus.TRANSFERRED, EnrollmentStatus.COMPLETED]
                    ),
                    StudentEnrollment.effective_start_date <= session_date,
                    or_(
                        StudentEnrollment.effective_end_date.is_(None),
                        StudentEnrollment.effective_end_date >= session_date,
                    ),
                )
            )
            .order_by(StudentEnrollment.student_user_id)
        )
        res = await self.db.execute(stmt)
        enrollments = res.scalars().all()

        eligible: List[RosterStudentItem] = []
        for enr in enrollments:
            face_state = FaceRegistrationState.UNREGISTERED
            fp = enr.student_user.face_profile if enr.student_user else None
            if fp:
                if fp.registration_state == FaceRegistrationStatus.REGISTERED:
                    face_state = FaceRegistrationState.REGISTERED
                elif fp.registration_state == FaceRegistrationStatus.PENDING:
                    face_state = FaceRegistrationState.PENDING
                else:
                    face_state = FaceRegistrationState.UNREGISTERED

            eligible.append(
                RosterStudentItem(
                    student_user_id=enr.student_user_id,
                    institutional_id=enr.student_user.institutional_id,
                    student_name=enr.student_user.full_name,
                    effective_start_date=enr.effective_start_date,
                    face_registration_state=face_state,
                )
            )
        return eligible

    async def calculate_student_personal_attendance(
        self,
        student_user_id: uuid.UUID,
        academic_term_id: Optional[uuid.UUID] = None,
    ) -> StudentPersonalAttendanceResponse:
        """
        Calculate personal attendance summary strictly bounded by enrollment dates.
        Sessions prior to effective_start_date or after effective_end_date are omitted from both numerator and denominator.
        Consolidates subjects across section transfers within the same academic term so that students retain complete
        historical attendance without fragmented duplicates.
        """
        threshold = await get_institution_threshold(self.db)

        enr_stmt = (
            select(StudentEnrollment)
            .options(
                selectinload(StudentEnrollment.class_section),
                selectinload(StudentEnrollment.academic_term),
            )
            .where(StudentEnrollment.student_user_id == student_user_id)
        )
        if academic_term_id:
            enr_stmt = enr_stmt.where(StudentEnrollment.academic_term_id == academic_term_id)

        enr_res = await self.db.execute(enr_stmt)
        enrollments = enr_res.scalars().all()

        # If academic_term_id was not specified, default to student's current active term (or latest term)
        if not academic_term_id and enrollments:
            today = date.today()
            active_enr = next(
                (
                    e
                    for e in enrollments
                    if e.enrollment_status == EnrollmentStatus.ACTIVE
                    and (e.effective_end_date is None or e.effective_end_date >= today)
                ),
                None,
            )
            if active_enr:
                academic_term_id = active_enr.academic_term_id
                enrollments = [e for e in enrollments if e.academic_term_id == academic_term_id]
            else:
                latest_enr = max(enrollments, key=lambda e: e.effective_start_date)
                academic_term_id = latest_enr.academic_term_id
                enrollments = [e for e in enrollments if e.academic_term_id == academic_term_id]

        summaries: List[StudentSubjectAttendanceSummary] = []
        total_eligible_all = 0
        total_attended_all = 0
        all_eligible_sessions: List[AttendanceSession] = []
        attended_session_ids = set()

        for enr in enrollments:
            # Query all teaching assignments for this section (including reassigned / historical)
            ta_stmt = (
                select(TeachingAssignment)
                .options(
                    selectinload(TeachingAssignment.subject),
                    selectinload(TeachingAssignment.faculty_user),
                )
                .where(TeachingAssignment.class_section_id == enr.class_section_id)
            )
            ta_res = await self.db.execute(ta_stmt)
            assignments = ta_res.scalars().all()

            for ta in assignments:
                # Query COUNTED, FINALIZED/SYNCED attendance sessions strictly bounded by student's enrollment interval
                conditions = [
                    AttendanceSession.teaching_assignment_id == ta.id,
                    AttendanceSession.applicability_status == SessionApplicability.COUNTED,
                    AttendanceSession.session_status.in_([AttendanceSessionStatus.FINALIZED, AttendanceSessionStatus.SYNCED]),
                    AttendanceSession.session_date >= enr.effective_start_date,
                ]
                if enr.effective_end_date is not None:
                    conditions.append(AttendanceSession.session_date <= enr.effective_end_date)

                sess_stmt = select(AttendanceSession).where(and_(*conditions))
                sess_res = await self.db.execute(sess_stmt)
                eligible_sessions = sess_res.scalars().all()
                total_eligible = len(eligible_sessions)

                attended = 0
                if total_eligible > 0:
                    all_eligible_sessions.extend(eligible_sessions)
                    sess_ids = [s.id for s in eligible_sessions]
                    rec_stmt = select(AttendanceRecord).where(
                        and_(
                            AttendanceRecord.attendance_session_id.in_(sess_ids),
                            AttendanceRecord.student_user_id == student_user_id,
                            AttendanceRecord.attendance_status.in_([AttendanceStatus.PRESENT, AttendanceStatus.EXCUSED]),
                        )
                    )
                    rec_res = await self.db.execute(rec_stmt)
                    present_records = rec_res.scalars().all()
                    attended = len(present_records)
                    for r in present_records:
                        attended_session_ids.add(r.attendance_session_id)

                pct = 100.0 if total_eligible == 0 else round((attended / total_eligible) * 100.0, 1)
                recover, is_rec = calculate_recovery_classes(attended, total_eligible, threshold=threshold)
                miss = calculate_can_miss_classes(attended, total_eligible, threshold=threshold)
                is_shortage = total_eligible > 0 and pct < threshold

                summaries.append(
                    StudentSubjectAttendanceSummary(
                        subject_id=ta.subject_id,
                        teaching_assignment_id=ta.id,
                        subject_code=ta.subject.code,
                        subject_name=ta.subject.name,
                        faculty_name=ta.faculty_user.full_name,
                        total_eligible_sessions=total_eligible,
                        attended_sessions=attended,
                        attendance_percentage=pct,
                        effective_start_date=enr.effective_start_date,
                        classes_to_recover=recover,
                        classes_can_miss=miss,
                        is_shortage=is_shortage,
                        is_recoverable=is_rec,
                        threshold=threshold,
                    )
                )

                total_eligible_all += total_eligible
                total_attended_all += attended

        # Sort summaries alphabetically by subject code
        summaries.sort(key=lambda s: s.subject_code)

        # Calculate weekly trend dynamically across all attended classes
        weekly_trend: List[StudentWeeklyTrendPoint] = []
        if all_eligible_sessions:
            weeks_dict = {}
            for s in all_eligible_sessions:
                iso_year, iso_week, _ = s.session_date.isocalendar()
                key = (iso_year, iso_week)
                weeks_dict.setdefault(key, []).append(s)

            for idx, ((yr, wk), w_sessions) in enumerate(sorted(weeks_dict.items()), 1):
                w_monday = date.fromisocalendar(yr, wk, 1)
                w_sunday = date.fromisocalendar(yr, wk, 7)
                w_eligible = len(w_sessions)
                w_present = sum(1 for s in w_sessions if s.id in attended_session_ids)
                w_pct = round((w_present / w_eligible) * 100.0, 1) if w_eligible > 0 else 0.0
                weekly_trend.append(
                    StudentWeeklyTrendPoint(
                        period_label=f"W{idx}",
                        attendance_percentage=w_pct,
                        total_present=w_present,
                        total_eligible=w_eligible,
                        start_date=w_monday,
                        end_date=w_sunday,
                    )
                )

        overall_pct = (
            100.0
            if total_eligible_all == 0
            else round((total_attended_all / total_eligible_all) * 100.0, 1)
        )

        return StudentPersonalAttendanceResponse(
            student_id=student_user_id,
            academic_term_id=academic_term_id,
            subjects=summaries,
            overall_attendance_percentage=overall_pct,
            total_eligible_sessions=total_eligible_all,
            total_attended_sessions=total_attended_all,
            weekly_trend=weekly_trend,
        )

    async def get_student_subject_history(
        self,
        student_user_id: uuid.UUID,
        teaching_assignment_id: uuid.UUID,
        threshold: Optional[float] = None,
    ) -> StudentSubjectHistoryResponse:
        """
        Retrieve chronological attendance history for a student in a specific teaching assignment.
        Validates that the student is enrolled in the class section associated with the teaching assignment
        or transferred between sections offering the same subject in the same term.
        Only sessions within [effective_start_date, effective_end_date] are returned.
        """
        if threshold is None:
            threshold = await get_institution_threshold(self.db)

        # 1. Fetch teaching assignment
        ta_stmt = (
            select(TeachingAssignment)
            .options(
                selectinload(TeachingAssignment.subject),
                selectinload(TeachingAssignment.faculty_user),
            )
            .where(TeachingAssignment.id == teaching_assignment_id)
        )
        ta_res = await self.db.execute(ta_stmt)
        ta = ta_res.scalar_one_or_none()
        if not ta:
            raise EntityNotFoundError(f"Teaching assignment {teaching_assignment_id} not found")

        # 2. Check student enrollment in this assignment's class section
        enr_stmt = (
            select(StudentEnrollment)
            .where(
                and_(
                    StudentEnrollment.student_user_id == student_user_id,
                    StudentEnrollment.class_section_id == ta.class_section_id,
                )
            )
            .order_by(StudentEnrollment.effective_start_date.desc())
        )
        enr_res = await self.db.execute(enr_stmt)
        enrollments = enr_res.scalars().all()
        if not enrollments:
            raise EntityNotFoundError("Student is not enrolled in this subject's class section")

        # 3. Query all applicable sessions strictly bounded by student's enrollment intervals
        applicable_sessions = []
        for enr in enrollments:
            sess_stmt = (
                select(AttendanceSession)
                .where(
                    and_(
                        AttendanceSession.teaching_assignment_id == teaching_assignment_id,
                        AttendanceSession.session_status.in_([AttendanceSessionStatus.FINALIZED, AttendanceSessionStatus.SYNCED]),
                        AttendanceSession.session_date >= enr.effective_start_date,
                    )
                )
                .order_by(AttendanceSession.session_date.desc(), AttendanceSession.period_slot_or_sequence.desc())
            )
            if enr.effective_end_date is not None:
                sess_stmt = sess_stmt.where(AttendanceSession.session_date <= enr.effective_end_date)

            sess_res = await self.db.execute(sess_stmt)
            applicable_sessions.extend(sess_res.scalars().all())

        # Deduplicate and sort chronologically descending
        sess_dict = {s.id: s for s in applicable_sessions}
        sorted_sessions = sorted(
            sess_dict.values(),
            key=lambda s: (s.session_date, s.period_slot_or_sequence),
            reverse=True,
        )

        session_ids = [s.id for s in sorted_sessions]
        record_map = {}
        if session_ids:
            rec_stmt = select(AttendanceRecord).where(
                and_(
                    AttendanceRecord.attendance_session_id.in_(session_ids),
                    AttendanceRecord.student_user_id == student_user_id,
                )
            )
            rec_res = await self.db.execute(rec_stmt)
            record_map = {r.attendance_session_id: r for r in rec_res.scalars().all()}

        total_eligible = 0
        attended = 0
        items: List[StudentSessionHistoryItem] = []

        for s in sorted_sessions:
            rec = record_map.get(s.id)
            status = rec.attendance_status if rec else AttendanceStatus.ABSENT
            mark_source = rec.mark_source if rec else None
            recorded_at = rec.recorded_at if rec else None
            reason = s.status_reason

            if s.applicability_status == SessionApplicability.COUNTED:
                total_eligible += 1
                if status in (AttendanceStatus.PRESENT, AttendanceStatus.EXCUSED):
                    attended += 1

            items.append(
                StudentSessionHistoryItem(
                    session_id=s.id,
                    session_date=s.session_date,
                    period_slot_or_sequence=s.period_slot_or_sequence,
                    attendance_status=status,
                    applicability_status=s.applicability_status,
                    mark_source=mark_source,
                    status_reason=reason,
                    recorded_at=recorded_at,
                )
            )

        pct = 100.0 if total_eligible == 0 else round((attended / total_eligible) * 100.0, 1)
        recover, is_rec = calculate_recovery_classes(attended, total_eligible, threshold=threshold)
        miss = calculate_can_miss_classes(attended, total_eligible, threshold=threshold)
        is_shortage = total_eligible > 0 and pct < threshold

        return StudentSubjectHistoryResponse(
            teaching_assignment_id=ta.id,
            subject_id=ta.subject_id,
            subject_code=ta.subject.code,
            subject_name=ta.subject.name,
            faculty_name=ta.faculty_user.full_name,
            total_eligible_sessions=total_eligible,
            attended_sessions=attended,
            attendance_percentage=pct,
            classes_to_recover=recover,
            classes_can_miss=miss,
            is_shortage=is_shortage,
            is_recoverable=is_rec,
            threshold=threshold,
            records=items,
        )

    async def transfer_student(
        self, payload: StudentTransferRequest
    ) -> Tuple[StudentEnrollment, StudentEnrollment]:
        """
        Execute an academic section transfer for a student effective on transfer_date (T).
        1. Validates student and target section existence.
        2. Validates transfer date is strictly after current enrollment's effective_start_date.
        3. Identifies the active enrollment covering transfer_date.
        4. Rejects transfer to the same section.
        5. Closes previous enrollment with effective_end_date = T - 1 and status = TRANSFERRED.
        6. Opens new enrollment starting at T with effective_end_date = NULL and status = ACTIVE.
        7. Enforces transactional ACID atomicity (rollback on failure).
        """
        # 1. Verify student exists and has STUDENT role
        user_stmt = select(User).where(User.id == payload.student_user_id)
        user_res = await self.db.execute(user_stmt)
        student = user_res.scalar_one_or_none()
        if not student:
            raise EntityNotFoundError(f"Student user {payload.student_user_id} not found")
        if student.role != UserRole.STUDENT:
            raise EligibilityError(f"User {payload.student_user_id} does not have STUDENT role")

        # 2. Verify target section exists
        sec_stmt = select(ClassSection).where(ClassSection.id == payload.new_class_section_id)
        sec_res = await self.db.execute(sec_stmt)
        target_section = sec_res.scalar_one_or_none()
        if not target_section:
            raise EntityNotFoundError(f"Target class section {payload.new_class_section_id} not found")

        # Validate student membership in target section's institution
        from src.models.access_control import InstitutionMembership, MembershipStatus
        mem_stmt = select(InstitutionMembership).where(InstitutionMembership.user_id == payload.student_user_id)
        mems = (await self.db.execute(mem_stmt)).scalars().all()
        if mems:
            has_active = any(m.institution_id == target_section.institution_id and m.status == MembershipStatus.ACTIVE for m in mems)
            if not has_active:
                raise EligibilityError(
                    f"Student {payload.student_user_id} does not have an active membership in target institution {target_section.institution_id}"
                )

        # 3. Locate active enrollment covering transfer_date in the same academic term
        enr_stmt = select(StudentEnrollment).where(
            and_(
                StudentEnrollment.student_user_id == payload.student_user_id,
                StudentEnrollment.academic_term_id == target_section.academic_term_id,
                StudentEnrollment.effective_start_date <= payload.transfer_date,
                or_(
                    StudentEnrollment.effective_end_date.is_(None),
                    StudentEnrollment.effective_end_date >= payload.transfer_date,
                ),
            )
        )
        enr_res = await self.db.execute(enr_stmt)
        current_enrollments = enr_res.scalars().all()

        if not current_enrollments:
            raise EligibilityError(
                f"Student {payload.student_user_id} has no active enrollment covering transfer date {payload.transfer_date}"
            )

        # Filter by current_class_section_id if explicitly specified
        if payload.current_class_section_id:
            active_enr = next(
                (e for e in current_enrollments if e.class_section_id == payload.current_class_section_id),
                None,
            )
            if not active_enr:
                raise EligibilityError(
                    f"Student {payload.student_user_id} has no active enrollment in current section {payload.current_class_section_id} on {payload.transfer_date}"
                )
        else:
            active_enr = current_enrollments[0]

        # 4. Same-section transfer rejection
        if active_enr.class_section_id == payload.new_class_section_id:
            raise EligibilityError(
                f"Student {payload.student_user_id} is already enrolled in section {payload.new_class_section_id}"
            )

        # 5. Transfer date boundary: transfer_date must be strictly after active_enr.effective_start_date
        if payload.transfer_date <= active_enr.effective_start_date:
            raise EligibilityError(
                f"Transfer date {payload.transfer_date} must be strictly after the start date "
                f"{active_enr.effective_start_date} of the current enrollment"
            )

        # 6. Check for conflicting active enrollments in target section or term overlapping with [transfer_date, None]
        conflict_stmt = select(StudentEnrollment).where(
            and_(
                StudentEnrollment.student_user_id == payload.student_user_id,
                StudentEnrollment.academic_term_id == target_section.academic_term_id,
                StudentEnrollment.id != active_enr.id,
                StudentEnrollment.enrollment_status == EnrollmentStatus.ACTIVE,
            )
        )
        conflict_res = await self.db.execute(conflict_stmt)
        other_active = conflict_res.scalars().all()
        for oth in other_active:
            oth_end = oth.effective_end_date or date.max
            if max(oth.effective_start_date, payload.transfer_date) <= oth_end:
                raise EligibilityError(
                    f"Transfer conflicts with existing active enrollment in section {oth.class_section_id} "
                    f"({oth.effective_start_date} to {oth.effective_end_date})"
                )

        # 7. Atomic transaction updates
        # Close previous enrollment at T - 1
        previous_end_date = payload.transfer_date - timedelta(days=1)
        active_enr.effective_end_date = previous_end_date
        active_enr.enrollment_status = EnrollmentStatus.TRANSFERRED

        # Open new enrollment starting at T
        new_enr = StudentEnrollment(
            student_user_id=payload.student_user_id,
            class_section_id=payload.new_class_section_id,
            academic_term_id=target_section.academic_term_id,
            effective_start_date=payload.transfer_date,
            effective_end_date=None,
            enrollment_status=EnrollmentStatus.ACTIVE,
        )
        self.db.add(new_enr)
        await self.db.flush()
        await self.db.refresh(active_enr)
        await self.db.refresh(new_enr)

        return active_enr, new_enr

    async def bulk_enroll_preview(
        self,
        payload: BulkEnrollmentPreviewRequest,
    ) -> BulkEnrollmentPreviewResponse:
        """Validate a batch of student enrollment records without writing changes."""
        # 1. Verify class section & term exist
        sec_stmt = (
            select(ClassSection)
            .options(selectinload(ClassSection.academic_term))
            .where(ClassSection.id == payload.class_section_id)
        )
        sec = (await self.db.execute(sec_stmt)).scalar_one_or_none()
        if not sec:
            raise EntityNotFoundError(f"Class section {payload.class_section_id} not found")

        term_start = sec.academic_term.start_date if sec.academic_term else date.today()
        preview_rows: List[BulkEnrollmentPreviewItem] = []
        seen_inst_ids = set()
        seen_emails = set()
        existing_count = 0
        new_count = 0
        error_count = 0
        valid_count = 0

        for idx, row in enumerate(payload.students):
            inst_id_clean = row.institutional_id.strip()
            email_clean = row.email.strip().lower()
            name_clean = row.full_name.strip()
            eff_start = row.effective_start_date or term_start

            # Syntax checks
            if not inst_id_clean or not name_clean:
                preview_rows.append(
                    BulkEnrollmentPreviewItem(
                        row_index=idx,
                        institutional_id=inst_id_clean,
                        full_name=name_clean,
                        email=email_clean,
                        effective_start_date=eff_start,
                        is_valid=False,
                        status="INVALID_DATA",
                        error_message="Missing required institutional ID or full name",
                    )
                )
                error_count += 1
                continue

            if "@" not in email_clean:
                preview_rows.append(
                    BulkEnrollmentPreviewItem(
                        row_index=idx,
                        institutional_id=inst_id_clean,
                        full_name=name_clean,
                        email=email_clean,
                        effective_start_date=eff_start,
                        is_valid=False,
                        status="INVALID_DATA",
                        error_message="Invalid email address format",
                    )
                )
                error_count += 1
                continue

            # Batch internal duplicate check
            if inst_id_clean in seen_inst_ids:
                preview_rows.append(
                    BulkEnrollmentPreviewItem(
                        row_index=idx,
                        institutional_id=inst_id_clean,
                        full_name=name_clean,
                        email=email_clean,
                        effective_start_date=eff_start,
                        is_valid=False,
                        status="DUPLICATE_IN_FILE",
                        error_message=f"Duplicate institutional ID '{inst_id_clean}' in import batch",
                    )
                )
                error_count += 1
                continue

            if email_clean in seen_emails:
                preview_rows.append(
                    BulkEnrollmentPreviewItem(
                        row_index=idx,
                        institutional_id=inst_id_clean,
                        full_name=name_clean,
                        email=email_clean,
                        effective_start_date=eff_start,
                        is_valid=False,
                        status="DUPLICATE_IN_FILE",
                        error_message=f"Duplicate email '{email_clean}' in import batch",
                    )
                )
                error_count += 1
                continue

            seen_inst_ids.add(inst_id_clean)
            seen_emails.add(email_clean)

            # Check if user account already exists in institution
            user_stmt = select(User).where(
                or_(
                    User.institutional_id == inst_id_clean,
                    User.email == email_clean,
                )
            )
            user_res = await self.db.execute(user_stmt)
            existing_user = user_res.scalar_one_or_none()

            if existing_user:
                if existing_user.role != UserRole.STUDENT:
                    preview_rows.append(
                        BulkEnrollmentPreviewItem(
                            row_index=idx,
                            institutional_id=inst_id_clean,
                            full_name=name_clean,
                            email=email_clean,
                            effective_start_date=eff_start,
                            is_valid=False,
                            status="ROLE_MISMATCH",
                            error_message=f"Existing user has role '{existing_user.role.value}', expected STUDENT",
                        )
                    )
                    error_count += 1
                    continue

                # Check if already active in this section
                active_enr_stmt = select(StudentEnrollment).where(
                    and_(
                        StudentEnrollment.student_user_id == existing_user.id,
                        StudentEnrollment.class_section_id == payload.class_section_id,
                        StudentEnrollment.enrollment_status == EnrollmentStatus.ACTIVE,
                    )
                )
                if (await self.db.execute(active_enr_stmt)).scalar_one_or_none():
                    preview_rows.append(
                        BulkEnrollmentPreviewItem(
                            row_index=idx,
                            institutional_id=inst_id_clean,
                            full_name=name_clean,
                            email=email_clean,
                            effective_start_date=eff_start,
                            is_valid=False,
                            status="ALREADY_ENROLLED",
                            error_message="Student is already actively enrolled in this section",
                        )
                    )
                    error_count += 1
                    continue

                # Check if overlapping enrollment in another section in same term
                overlap_stmt = select(StudentEnrollment).where(
                    and_(
                        StudentEnrollment.student_user_id == existing_user.id,
                        StudentEnrollment.academic_term_id == payload.academic_term_id,
                        StudentEnrollment.enrollment_status == EnrollmentStatus.ACTIVE,
                    )
                )
                other_enr = (await self.db.execute(overlap_stmt)).scalar_one_or_none()
                if other_enr:
                    preview_rows.append(
                        BulkEnrollmentPreviewItem(
                            row_index=idx,
                            institutional_id=inst_id_clean,
                            full_name=name_clean,
                            email=email_clean,
                            effective_start_date=eff_start,
                            is_valid=False,
                            status="OVERLAPPING_ENROLLMENT",
                            error_message=f"Student has conflicting active enrollment in another section in this term",
                        )
                    )
                    error_count += 1
                    continue

                preview_rows.append(
                    BulkEnrollmentPreviewItem(
                        row_index=idx,
                        institutional_id=inst_id_clean,
                        full_name=name_clean,
                        email=email_clean,
                        effective_start_date=eff_start,
                        is_valid=True,
                        status="EXISTING_USER",
                        error_message=None,
                    )
                )
                existing_count += 1
                valid_count += 1
            else:
                preview_rows.append(
                    BulkEnrollmentPreviewItem(
                        row_index=idx,
                        institutional_id=inst_id_clean,
                        full_name=name_clean,
                        email=email_clean,
                        effective_start_date=eff_start,
                        is_valid=True,
                        status="NEW_USER_TO_CREATE",
                        error_message=None,
                    )
                )
                new_count += 1
                valid_count += 1

        return BulkEnrollmentPreviewResponse(
            total_rows=len(payload.students),
            valid_count=valid_count,
            error_count=error_count,
            existing_user_count=existing_count,
            new_user_count=new_count,
            preview_rows=preview_rows,
        )

    async def bulk_enroll_execute(
        self,
        payload: BulkEnrollmentExecuteRequest,
    ) -> BulkEnrollmentExecuteResponse:
        """Execute transactional bulk enrollment for validated rows."""
        preview = await self.bulk_enroll_preview(
            BulkEnrollmentPreviewRequest(
                academic_term_id=payload.academic_term_id,
                class_section_id=payload.class_section_id,
                students=payload.students,
            )
        )

        valid_items = [p for p in preview.preview_rows if p.is_valid]
        failed_items = [p for p in preview.preview_rows if not p.is_valid]

        # In transactional context, enroll all valid items
        enrolled_count = 0
        for item in valid_items:
            # 1. Resolve or create student User
            user_stmt = select(User).where(
                or_(
                    User.institutional_id == item.institutional_id,
                    User.email == item.email.lower(),
                )
            )
            student_user = (await self.db.execute(user_stmt)).scalar_one_or_none()
            if not student_user:
                student_user = User(
                    institutional_id=item.institutional_id,
                    full_name=item.full_name,
                    email=item.email.lower(),
                    password_hash=get_password_hash("KlasioStudent@2026"),
                    role=UserRole.STUDENT,
                    account_status=AccountStatus.ACTIVE,
                )
                self.db.add(student_user)
                await self.db.flush()

                # Ensure active membership (if trigger did not already create it)
                mem_stmt = select(InstitutionMembership).where(
                    InstitutionMembership.user_id == student_user.id,
                    InstitutionMembership.institution_id == uuid.UUID(str(DEFAULT_INSTITUTION_ID)),
                )
                mem = (await self.db.execute(mem_stmt)).scalar_one_or_none()
                if not mem:
                    mem = InstitutionMembership(
                        institution_id=uuid.UUID(str(DEFAULT_INSTITUTION_ID)),
                        user_id=student_user.id,
                        status=MembershipStatus.ACTIVE,
                    )
                    self.db.add(mem)
                    await self.db.flush()

            # 2. Create StudentEnrollment
            enrollment = StudentEnrollment(
                student_user_id=student_user.id,
                class_section_id=payload.class_section_id,
                academic_term_id=payload.academic_term_id,
                effective_start_date=item.effective_start_date,
                effective_end_date=None,
                enrollment_status=EnrollmentStatus.ACTIVE,
            )
            self.db.add(enrollment)
            enrolled_count += 1

        await self.db.flush()
        return BulkEnrollmentExecuteResponse(
            success=True,
            enrolled_count=enrolled_count,
            failed_count=len(failed_items),
            errors=failed_items,
        )

    async def get_section_roster(
        self,
        class_section_id: uuid.UUID,
    ) -> SectionRosterResponse:
        """Retrieve full academic section roster with biometric state and lifecycle status."""
        sec_stmt = (
            select(ClassSection)
            .options(
                selectinload(ClassSection.academic_term),
                selectinload(ClassSection.department),
            )
            .where(ClassSection.id == class_section_id)
        )
        sec = (await self.db.execute(sec_stmt)).scalar_one_or_none()
        if not sec:
            raise EntityNotFoundError(f"Class section {class_section_id} not found")

        enr_stmt = (
            select(StudentEnrollment)
            .options(
                selectinload(StudentEnrollment.student_user).selectinload(User.face_profile)
            )
            .where(StudentEnrollment.class_section_id == class_section_id)
            .order_by(StudentEnrollment.created_at.desc())
        )
        enrollments = (await self.db.execute(enr_stmt)).scalars().all()

        students: List[SectionRosterStudentItem] = []
        active_count = 0
        for enr in enrollments:
            face_state = "UNREGISTERED"
            u = enr.student_user
            if u and u.face_profile:
                face_state = u.face_profile.registration_state.value if hasattr(u.face_profile.registration_state, "value") else str(u.face_profile.registration_state)

            if enr.enrollment_status == EnrollmentStatus.ACTIVE:
                active_count += 1

            students.append(
                SectionRosterStudentItem(
                    enrollment_id=enr.id,
                    student_user_id=enr.student_user_id,
                    institutional_id=u.institutional_id if u else "N/A",
                    student_name=u.full_name if u else "Unknown",
                    email=u.email if u else "",
                    effective_start_date=enr.effective_start_date,
                    effective_end_date=enr.effective_end_date,
                    enrollment_status=enr.enrollment_status,
                    face_registration_state=face_state,
                )
            )

        return SectionRosterResponse(
            section_id=sec.id,
            section_code=sec.section_code,
            academic_term_id=sec.academic_term_id,
            academic_term_name=sec.academic_term.name if sec.academic_term else "N/A",
            department_name=sec.department.name if sec.department else "N/A",
            total_enrolled=len(students),
            active_count=active_count,
            students=students,
        )

    async def update_enrollment_status(
        self,
        enrollment_id: uuid.UUID,
        new_status: EnrollmentStatus,
        effective_end_date: Optional[date] = None,
    ) -> StudentEnrollment:
        """Transition an enrollment lifecycle status (WITHDRAWN, COMPLETED, ACTIVE)."""
        stmt = select(StudentEnrollment).where(StudentEnrollment.id == enrollment_id)
        enr = (await self.db.execute(stmt)).scalar_one_or_none()
        if not enr:
            raise EntityNotFoundError(f"Student enrollment {enrollment_id} not found")

        enr.enrollment_status = new_status
        if new_status in [EnrollmentStatus.WITHDRAWN, EnrollmentStatus.COMPLETED, EnrollmentStatus.TRANSFERRED]:
            enr.effective_end_date = effective_end_date or date.today()
        elif new_status == EnrollmentStatus.ACTIVE:
            enr.effective_end_date = None

        await self.db.flush()
        await self.db.refresh(enr)
        return enr

    async def get_student_current_enrollment(
        self,
        student_user_id: uuid.UUID,
        target_date: Optional[date] = None,
    ) -> Optional[StudentCurrentEnrollmentResponse]:
        """Self-service resolution of student's active academic section enrollment."""
        today = target_date or date.today()
        stmt = (
            select(StudentEnrollment)
            .options(
                selectinload(StudentEnrollment.class_section).selectinload(ClassSection.department),
                selectinload(StudentEnrollment.class_section).selectinload(ClassSection.program),
                selectinload(StudentEnrollment.academic_term),
            )
            .where(
                and_(
                    StudentEnrollment.student_user_id == student_user_id,
                    StudentEnrollment.enrollment_status == EnrollmentStatus.ACTIVE,
                    StudentEnrollment.effective_start_date <= today,
                    or_(
                        StudentEnrollment.effective_end_date.is_(None),
                        StudentEnrollment.effective_end_date >= today,
                    ),
                )
            )
        )
        enr = (await self.db.execute(stmt)).scalar_one_or_none()
        if not enr or not enr.class_section:
            return None

        sec = enr.class_section
        term = enr.academic_term
        return StudentCurrentEnrollmentResponse(
            student_user_id=student_user_id,
            section_id=sec.id,
            section_code=sec.section_code,
            program_name=sec.program.name if sec.program else None,
            department_name=sec.department.name if sec.department else "N/A",
            academic_term_id=sec.academic_term_id,
            academic_term_name=term.name if term else "N/A",
            academic_year=term.academic_year if term else "N/A",
            enrollment_status=enr.enrollment_status,
            effective_start_date=enr.effective_start_date,
        )

