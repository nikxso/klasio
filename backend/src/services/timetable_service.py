from datetime import date, time, datetime
from typing import List, Optional, Tuple, Dict, Any
import uuid
from sqlalchemy import select, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.core.exceptions import EligibilityError, EntityNotFoundError
from src.models.academic import (
    DEFAULT_INSTITUTION_ID,
    AcademicPeriod,
    AcademicTerm,
    ClassSection,
    TimetableEntry,
)
from src.models.assignment import (
    TeachingAssignment,
    SubstituteDelegation,
    DelegationStatus,
)
from src.schemas.academic import (
    AcademicPeriodCreate,
    AcademicPeriodUpdate,
    AcademicPeriodResponse,
    TimetableEntryCreate,
    TimetableEntryUpdate,
    TimetableEntryResponse,
)


class TimetableService:
    def __init__(self, db: AsyncSession):
        self.db = db

    # -------------------------------------------------------------------------
    # Academic Period Management
    # -------------------------------------------------------------------------
    async def list_periods(self, institution_id: uuid.UUID = DEFAULT_INSTITUTION_ID) -> List[AcademicPeriod]:
        stmt = (
            select(AcademicPeriod)
            .where(
                and_(
                    AcademicPeriod.institution_id == institution_id,
                    AcademicPeriod.is_active == True,
                )
            )
            .order_by(AcademicPeriod.period_number.asc())
        )
        res = await self.db.execute(stmt)
        return res.scalars().all()

    async def get_period(self, period_id: uuid.UUID) -> AcademicPeriod:
        stmt = select(AcademicPeriod).where(AcademicPeriod.id == period_id)
        res = await self.db.execute(stmt)
        period = res.scalar_one_or_none()
        if not period:
            raise EntityNotFoundError(f"Academic period {period_id} not found")
        return period

    async def create_period(
        self,
        payload: AcademicPeriodCreate,
        institution_id: uuid.UUID = DEFAULT_INSTITUTION_ID,
    ) -> AcademicPeriod:
        # Check duplicate period_number
        dup_stmt = select(AcademicPeriod).where(
            and_(
                AcademicPeriod.institution_id == institution_id,
                AcademicPeriod.period_number == payload.period_number,
                AcademicPeriod.is_active == True,
            )
        )
        existing = (await self.db.execute(dup_stmt)).scalar_one_or_none()
        if existing:
            raise EligibilityError(f"Academic period number {payload.period_number} already exists")

        period = AcademicPeriod(
            institution_id=institution_id,
            period_number=payload.period_number,
            name=payload.name,
            start_time=payload.start_time,
            end_time=payload.end_time,
            is_break=payload.is_break,
            is_active=payload.is_active,
        )
        self.db.add(period)
        await self.db.flush()
        await self.db.refresh(period)
        return period

    async def update_period(self, period_id: uuid.UUID, payload: AcademicPeriodUpdate) -> AcademicPeriod:
        period = await self.get_period(period_id)
        if payload.name is not None:
            period.name = payload.name
        if payload.start_time is not None:
            period.start_time = payload.start_time
        if payload.end_time is not None:
            period.end_time = payload.end_time
        if payload.is_break is not None:
            period.is_break = payload.is_break
        if payload.is_active is not None:
            period.is_active = payload.is_active

        if period.end_time <= period.start_time:
            raise EligibilityError("Period end_time must be strictly after start_time")

        await self.db.flush()
        await self.db.refresh(period)
        return period

    async def delete_period(self, period_id: uuid.UUID) -> None:
        period = await self.get_period(period_id)
        # Check if in use in timetable_entries
        use_stmt = select(TimetableEntry.id).where(
            and_(
                TimetableEntry.academic_period_id == period_id,
                TimetableEntry.is_active == True,
            )
        ).limit(1)
        in_use = (await self.db.execute(use_stmt)).scalar_one_or_none()
        if in_use:
            # Soft-delete by setting inactive
            period.is_active = False
            await self.db.flush()
        else:
            await self.db.delete(period)
            await self.db.flush()

    # -------------------------------------------------------------------------
    # Timetable Scheduling & Conflict Prevention
    # -------------------------------------------------------------------------
    async def create_timetable_entry(
        self,
        payload: TimetableEntryCreate,
        institution_id: uuid.UUID = DEFAULT_INSTITUTION_ID,
    ) -> TimetableEntry:
        # 1. Validate teaching assignment exists
        ta_stmt = (
            select(TeachingAssignment)
            .options(selectinload(TeachingAssignment.faculty_user))
            .where(TeachingAssignment.id == payload.teaching_assignment_id)
        )
        ta = (await self.db.execute(ta_stmt)).scalar_one_or_none()
        if not ta:
            raise EntityNotFoundError(f"Teaching assignment {payload.teaching_assignment_id} not found")

        resolved_sec_id = payload.class_section_id or ta.class_section_id
        resolved_term_id = payload.academic_term_id or ta.academic_term_id

        # 2. Validate section exists
        sec_stmt = select(ClassSection).where(ClassSection.id == resolved_sec_id)
        sec = (await self.db.execute(sec_stmt)).scalar_one_or_none()
        if not sec:
            raise EntityNotFoundError(f"Class section {resolved_sec_id} not found")

        # 3. Validate period exists and is not break
        period = await self.get_period(payload.academic_period_id)
        if period.is_break:
            raise EligibilityError(f"Cannot schedule class during break period '{period.name}'")

        # 4. Conflict Check A: Section cannot be double-booked
        # Allow concurrent sessions for the same section ONLY when both are distinct non-DEFAULT teaching groups (e.g. Lab Batch A & Lab Batch B)
        sec_conflict_stmt = (
            select(TimetableEntry)
            .join(TeachingAssignment, TimetableEntry.teaching_assignment_id == TeachingAssignment.id)
            .where(
                and_(
                    TimetableEntry.class_section_id == resolved_sec_id,
                    TimetableEntry.day_of_week == payload.day_of_week,
                    TimetableEntry.academic_period_id == payload.academic_period_id,
                    TimetableEntry.is_active == True,
                )
            )
        )
        existing_sec_entries = (await self.db.execute(sec_conflict_stmt)).scalars().all()
        for existing_entry in existing_sec_entries:
            existing_ta = (
                await self.db.execute(
                    select(TeachingAssignment).where(TeachingAssignment.id == existing_entry.teaching_assignment_id)
                )
            ).scalar_one_or_none()
            if not existing_ta:
                continue
            is_new_group = bool(ta.teaching_group and ta.teaching_group != "DEFAULT")
            is_exist_group = bool(existing_ta.teaching_group and existing_ta.teaching_group != "DEFAULT")
            if not (is_new_group and is_exist_group and ta.teaching_group != existing_ta.teaching_group):
                raise EligibilityError(
                    f"Class section {sec.section_code} already has a class scheduled on day {payload.day_of_week} period {period.name}"
                )

        # 5. Conflict Check B: Room cannot be double-booked (if room specified)
        if payload.room_number and payload.room_number.upper() != "TBD":
            room_conflict_stmt = select(TimetableEntry).where(
                and_(
                    TimetableEntry.institution_id == institution_id,
                    TimetableEntry.room_number == payload.room_number,
                    TimetableEntry.day_of_week == payload.day_of_week,
                    TimetableEntry.academic_period_id == payload.academic_period_id,
                    TimetableEntry.is_active == True,
                )
            )
            if (await self.db.execute(room_conflict_stmt)).scalar_one_or_none():
                raise EligibilityError(
                    f"Room '{payload.room_number}' is already occupied on day {payload.day_of_week} period {period.name}"
                )

        # 6. Conflict Check C: Faculty cannot be double-booked
        faculty_conflict_stmt = (
            select(TimetableEntry)
            .join(TeachingAssignment, TimetableEntry.teaching_assignment_id == TeachingAssignment.id)
            .where(
                and_(
                    TeachingAssignment.faculty_user_id == ta.faculty_user_id,
                    TimetableEntry.day_of_week == payload.day_of_week,
                    TimetableEntry.academic_period_id == payload.academic_period_id,
                    TimetableEntry.is_active == True,
                )
            )
        )
        if (await self.db.execute(faculty_conflict_stmt)).scalar_one_or_none():
            faculty_name = ta.faculty_user.full_name if ta.faculty_user else "Faculty"
            raise EligibilityError(
                f"Faculty '{faculty_name}' is already teaching another class on day {payload.day_of_week} period {period.name}"
            )

        entry = TimetableEntry(
            institution_id=institution_id,
            academic_term_id=resolved_term_id,
            class_section_id=resolved_sec_id,
            teaching_assignment_id=payload.teaching_assignment_id,
            academic_period_id=payload.academic_period_id,
            day_of_week=payload.day_of_week,
            room_number=payload.room_number,
            is_active=payload.is_active,
        )
        self.db.add(entry)
        await self.db.flush()
        await self.db.refresh(entry)
        return entry

    async def list_timetable(
        self,
        class_section_id: Optional[uuid.UUID] = None,
        academic_term_id: Optional[uuid.UUID] = None,
        day_of_week: Optional[int] = None,
        institution_id: uuid.UUID = DEFAULT_INSTITUTION_ID,
    ) -> List[TimetableEntryResponse]:
        conditions = [
            TimetableEntry.institution_id == institution_id,
            TimetableEntry.is_active == True,
        ]
        if class_section_id:
            conditions.append(TimetableEntry.class_section_id == class_section_id)
        if academic_term_id:
            conditions.append(TimetableEntry.academic_term_id == academic_term_id)
        if day_of_week:
            conditions.append(TimetableEntry.day_of_week == day_of_week)

        stmt = (
            select(TimetableEntry)
            .options(
                selectinload(TimetableEntry.class_section),
                selectinload(TimetableEntry.academic_period),
                selectinload(TimetableEntry.teaching_assignment).selectinload(TeachingAssignment.subject),
                selectinload(TimetableEntry.teaching_assignment).selectinload(TeachingAssignment.faculty_user),
            )
            .where(and_(*conditions))
            .order_by(TimetableEntry.day_of_week.asc())
        )
        res = await self.db.execute(stmt)
        entries = res.scalars().all()

        results: List[TimetableEntryResponse] = []
        for e in entries:
            ta = e.teaching_assignment
            period = e.academic_period
            results.append(
                TimetableEntryResponse(
                    id=e.id,
                    academic_term_id=e.academic_term_id,
                    class_section_id=e.class_section_id,
                    teaching_assignment_id=e.teaching_assignment_id,
                    academic_period_id=e.academic_period_id,
                    day_of_week=e.day_of_week,
                    room_number=e.room_number,
                    is_active=e.is_active,
                    section_code=e.class_section.section_code if e.class_section else "Unknown",
                    subject_code=ta.subject.code if ta and ta.subject else "N/A",
                    subject_name=ta.subject.name if ta and ta.subject else "N/A",
                    period_name=period.name if period else f"P{period.period_number}" if period else "Period",
                    period_number=period.period_number if period else None,
                    start_time=period.start_time if period else None,
                    end_time=period.end_time if period else None,
                    faculty_user_id=ta.faculty_user_id if ta else None,
                    faculty_name=ta.faculty_user.full_name if ta and ta.faculty_user else "Unknown",
                    created_at=e.created_at,
                    updated_at=e.updated_at,
                )
            )
        return results

    async def get_faculty_today_schedule(
        self,
        faculty_user_id: uuid.UUID,
        target_date: Optional[date] = None,
    ) -> List[Dict[str, Any]]:
        """
        Retrieve faculty's scheduled classes for target_date (default today),
        taking into account direct teaching assignments AND active substitute delegations.
        """
        today = target_date or date.today()
        # ISO day of week: Monday=1 ... Sunday=7
        day_of_week = today.isoweekday()

        # 1. Direct assignments
        direct_ta_stmt = select(TeachingAssignment.id).where(
            and_(
                TeachingAssignment.faculty_user_id == faculty_user_id,
                TeachingAssignment.is_active == True,
            )
        )
        direct_ta_ids = set((await self.db.execute(direct_ta_stmt)).scalars().all())

        # 2. Delegated assignments active for today
        delegated_stmt = select(SubstituteDelegation).where(
            and_(
                SubstituteDelegation.substitute_faculty_user_id == faculty_user_id,
                SubstituteDelegation.status == DelegationStatus.ACTIVE,
                SubstituteDelegation.start_date <= today,
                SubstituteDelegation.end_date >= today,
            )
        )
        delegations = (await self.db.execute(delegated_stmt)).scalars().all()
        delegated_ta_map = {d.teaching_assignment_id: d for d in delegations}
        all_ta_ids = direct_ta_ids.union(delegated_ta_map.keys())

        if not all_ta_ids:
            return []

        # 3. Query timetable entries for these assignments on day_of_week
        tt_stmt = (
            select(TimetableEntry)
            .options(
                selectinload(TimetableEntry.class_section),
                selectinload(TimetableEntry.academic_period),
                selectinload(TimetableEntry.teaching_assignment).selectinload(TeachingAssignment.subject),
                selectinload(TimetableEntry.teaching_assignment).selectinload(TeachingAssignment.faculty_user),
            )
            .where(
                and_(
                    TimetableEntry.teaching_assignment_id.in_(all_ta_ids),
                    TimetableEntry.day_of_week == day_of_week,
                    TimetableEntry.is_active == True,
                )
            )
        )
        entries = (await self.db.execute(tt_stmt)).scalars().all()
        # Sort by period start_time
        entries = sorted(entries, key=lambda x: x.academic_period.start_time if x.academic_period else time(0, 0))

        schedule_items = []
        for e in entries:
            ta = e.teaching_assignment
            period = e.academic_period
            is_delegated = e.teaching_assignment_id in delegated_ta_map
            delegation = delegated_ta_map.get(e.teaching_assignment_id)

            schedule_items.append({
                "timetable_entry_id": e.id,
                "teaching_assignment_id": e.teaching_assignment_id,
                "class_section_id": e.class_section_id,
                "section_code": e.class_section.section_code if e.class_section else "Unknown",
                "subject_code": ta.subject.code if ta and ta.subject else "N/A",
                "subject_name": ta.subject.name if ta and ta.subject else "Course",
                "period_id": period.id if period else None,
                "period_number": period.period_number if period else 1,
                "period_name": period.name if period else "Period",
                "start_time": period.start_time.strftime("%H:%M") if period else "09:00",
                "end_time": period.end_time.strftime("%H:%M") if period else "10:00",
                "time_display": f"{period.start_time.strftime('%H:%M')} - {period.end_time.strftime('%H:%M')}" if period else "09:00 - 10:00",
                "room_number": e.room_number,
                "is_delegated": is_delegated,
                "delegation_id": delegation.id if delegation else None,
                "regular_faculty_name": ta.faculty_user.full_name if ta and ta.faculty_user else "",
            })
        return schedule_items

    async def get_student_weekly_schedule(
        self,
        student_user_id: uuid.UUID,
        target_date: Optional[date] = None,
    ) -> List[Dict[str, Any]]:
        """Retrieve student's weekly timetable based on active section enrollment."""
        from src.models.enrollment import StudentEnrollment, EnrollmentStatus
        today = target_date or date.today()

        # Find student's active enrollment
        enr_stmt = select(StudentEnrollment).where(
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
        enr = (await self.db.execute(enr_stmt)).scalar_one_or_none()
        if not enr:
            return []

        # List timetable for this section
        return [
            item.model_dump()
            for item in await self.list_timetable(
                class_section_id=enr.class_section_id,
                academic_term_id=enr.academic_term_id,
            )
        ]
