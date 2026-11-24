import json
import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set
import uuid
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.academic import (
    AcademicTerm,
    ClassSection,
    DEFAULT_INSTITUTION_ID,
    Department,
    DeploymentConfig,
    Program,
)
from src.models.access_control import (
    AssignmentStatus,
    InstitutionMembership,
    MembershipStatus,
    Permission,
    RoleAssignment,
    RoleAssignmentScope,
    RoleScopeType,
    role_permissions,
)
from src.models.assignment import SubstituteDelegation, TeachingAssignment
from src.models.attendance import AttendanceRecord, AttendanceSession
from src.models.notification import Notification, NotificationCategory, NotificationPriority
from src.models.user import AccountStatus, User
from src.schemas.notification import NotificationResponse, NotificationUnreadCountResponse

logger = logging.getLogger("klasio.notifications")


class NotificationService:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def list_user_notifications(
        self,
        user_id: uuid.UUID,
        unread_only: bool = False,
        category: Optional[str] = None,
        limit: int = 50,
        offset: int = 0,
    ) -> List[Notification]:
        query = select(Notification).where(Notification.user_id == user_id)
        if unread_only:
            query = query.where(Notification.is_read.is_(False))
        if category:
            query = query.where(Notification.category == category)
        query = query.order_by(Notification.created_at.desc()).limit(limit).offset(offset)
        result = await self.db.execute(query)
        return list(result.scalars().all())

    async def get_unread_count(self, user_id: uuid.UUID) -> int:
        query = select(func.count(Notification.id)).where(
            Notification.user_id == user_id,
            Notification.is_read.is_(False),
        )
        result = await self.db.execute(query)
        return int(result.scalar_one() or 0)

    async def mark_as_read(self, user_id: uuid.UUID, notification_id: uuid.UUID) -> Optional[Notification]:
        stmt = (
            update(Notification)
            .where(
                Notification.id == notification_id,
                Notification.user_id == user_id,
            )
            .values(
                is_read=True,
                read_at=datetime.now(timezone.utc),
                updated_at=datetime.now(timezone.utc),
            )
            .returning(Notification)
        )
        res = await self.db.execute(stmt)
        await self.db.commit()
        return res.scalar_one_or_none()

    async def mark_all_as_read(self, user_id: uuid.UUID) -> int:
        stmt = (
            update(Notification)
            .where(
                Notification.user_id == user_id,
                Notification.is_read.is_(False),
            )
            .values(
                is_read=True,
                read_at=datetime.now(timezone.utc),
                updated_at=datetime.now(timezone.utc),
            )
        )
        res = await self.db.execute(stmt)
        await self.db.commit()
        return res.rowcount

    async def create_notification(
        self,
        user_id: uuid.UUID,
        title: str,
        message: str,
        category: str = NotificationCategory.ATTENDANCE.value,
        priority: str = NotificationPriority.NORMAL.value,
        link_type: Optional[str] = None,
        link_id: Optional[str] = None,
        payload_json: Optional[str] = None,
        action_route: Optional[str] = None,
        deduplication_key: Optional[str] = None,
        institution_id: uuid.UUID = DEFAULT_INSTITUTION_ID,
    ) -> Optional[Notification]:
        if deduplication_key:
            existing = await self.db.execute(
                select(Notification).where(
                    Notification.user_id == user_id,
                    Notification.deduplication_key == deduplication_key,
                )
            )
            if existing.scalar_one_or_none():
                return None

        notif = Notification(
            institution_id=institution_id,
            user_id=user_id,
            title=title,
            message=message,
            category=category,
            priority=priority,
            link_type=link_type,
            link_id=link_id,
            payload_json=payload_json,
            action_route=action_route,
            deduplication_key=deduplication_key,
        )
        self.db.add(notif)
        await self.db.flush()
        return notif


class NotificationRoutingService:
    """
    Authorization-driven Notification Routing Engine (Klasio ReBAC Authority Matrix).

    Routes alerts strictly through:
    1. Active institution memberships
    2. Active canonical role assignments
    3. Seeded canonical dot-separated permissions
    4. Hierarchical scope matching (Institution -> Campus -> Department -> Program -> ClassSection)
    5. Deduplication across multiple simultaneous responsibilities
    """

    @classmethod
    async def resolve_authorities_with_permission(
        cls,
        db: AsyncSession,
        permission_code: str,
        scope_type: Optional[str] = None,
        scope_id: Optional[uuid.UUID] = None,
        institution_id: uuid.UUID = DEFAULT_INSTITUTION_ID,
    ) -> Set[uuid.UUID]:
        """
        Resolve user IDs holding active canonical role assignments with the given permission code,
        matching hierarchical scope containment for the target resource.
        """
        now = datetime.now(timezone.utc)

        # Base query joining Membership -> RoleAssignment -> role_permissions -> Permission -> RoleAssignmentScope
        stmt = (
            select(InstitutionMembership.user_id)
            .join(
                RoleAssignment,
                and_(
                    RoleAssignment.membership_id == InstitutionMembership.id,
                    RoleAssignment.institution_id == institution_id,
                    RoleAssignment.status == AssignmentStatus.ACTIVE,
                    RoleAssignment.valid_from <= now,
                    or_(RoleAssignment.valid_until.is_(None), RoleAssignment.valid_until > now),
                ),
            )
            .join(role_permissions, role_permissions.c.role_template_id == RoleAssignment.role_template_id)
            .join(
                Permission,
                and_(
                    Permission.id == role_permissions.c.permission_id,
                    Permission.code == permission_code,
                ),
            )
            .join(
                User,
                and_(
                    User.id == InstitutionMembership.user_id,
                    User.account_status == AccountStatus.ACTIVE,
                ),
            )
            .join(RoleAssignmentScope, RoleAssignmentScope.role_assignment_id == RoleAssignment.id)
            .where(
                InstitutionMembership.institution_id == institution_id,
                InstitutionMembership.status == MembershipStatus.ACTIVE,
            )
        )

        if not scope_type or not scope_id:
            stmt = stmt.where(RoleAssignmentScope.scope_type == RoleScopeType.INSTITUTION)
        else:
            # Hierarchical scope resolution
            scope_conditions = [RoleAssignmentScope.scope_type == RoleScopeType.INSTITUTION]

            if scope_type == "DEPARTMENT":
                scope_conditions.append(
                    and_(
                        RoleAssignmentScope.scope_type == RoleScopeType.DEPARTMENT,
                        RoleAssignmentScope.department_id == scope_id,
                    )
                )
            elif scope_type == "PROGRAM":
                scope_conditions.append(
                    and_(
                        RoleAssignmentScope.scope_type == RoleScopeType.PROGRAM,
                        RoleAssignmentScope.program_id == scope_id,
                    )
                )
            elif scope_type == "CAMPUS":
                scope_conditions.append(
                    and_(
                        RoleAssignmentScope.scope_type == RoleScopeType.CAMPUS,
                        RoleAssignmentScope.campus_id == scope_id,
                    )
                )
            elif scope_type == "CLASS_SECTION":
                scope_conditions.append(
                    and_(
                        RoleAssignmentScope.scope_type == RoleScopeType.CLASS_SECTION,
                        RoleAssignmentScope.class_section_id == scope_id,
                    )
                )
                # Also include parent department and program of the section
                sec_res = await db.execute(select(ClassSection).where(ClassSection.id == scope_id))
                sec = sec_res.scalar_one_or_none()
                if sec:
                    if sec.department_id:
                        scope_conditions.append(
                            and_(
                                RoleAssignmentScope.scope_type == RoleScopeType.DEPARTMENT,
                                RoleAssignmentScope.department_id == sec.department_id,
                            )
                        )
                    if sec.program_id:
                        scope_conditions.append(
                            and_(
                                RoleAssignmentScope.scope_type == RoleScopeType.PROGRAM,
                                RoleAssignmentScope.program_id == sec.program_id,
                            )
                        )
                    if sec.campus_id:
                        scope_conditions.append(
                            and_(
                                RoleAssignmentScope.scope_type == RoleScopeType.CAMPUS,
                                RoleAssignmentScope.campus_id == sec.campus_id,
                            )
                        )
            elif scope_type == "TEACHING_ASSIGNMENT":
                scope_conditions.append(
                    and_(
                        RoleAssignmentScope.scope_type == RoleScopeType.TEACHING_ASSIGNMENT,
                        RoleAssignmentScope.teaching_assignment_id == scope_id,
                    )
                )
                ta_res = await db.execute(
                    select(TeachingAssignment)
                    .join(ClassSection, TeachingAssignment.class_section_id == ClassSection.id)
                    .where(TeachingAssignment.id == scope_id)
                )
                ta = ta_res.scalar_one_or_none()
                if ta and ta.class_section:
                    sec = ta.class_section
                    scope_conditions.append(
                        and_(
                            RoleAssignmentScope.scope_type == RoleScopeType.CLASS_SECTION,
                            RoleAssignmentScope.class_section_id == sec.id,
                        )
                    )
                    if sec.department_id:
                        scope_conditions.append(
                            and_(
                                RoleAssignmentScope.scope_type == RoleScopeType.DEPARTMENT,
                                RoleAssignmentScope.department_id == sec.department_id,
                            )
                        )
                    if sec.program_id:
                        scope_conditions.append(
                            and_(
                                RoleAssignmentScope.scope_type == RoleScopeType.PROGRAM,
                                RoleAssignmentScope.program_id == sec.program_id,
                            )
                        )

            stmt = stmt.where(or_(*scope_conditions))

        res = await db.execute(stmt)
        return set(res.scalars().all())

    @classmethod
    async def dispatch_notifications(
        cls,
        db: AsyncSession,
        recipient_user_ids: Set[uuid.UUID],
        event_key: str,
        title: str,
        message: str,
        category: str,
        priority: str,
        action_route: str,
        payload: Dict[str, Any],
        link_type: Optional[str] = None,
        link_id: Optional[str] = None,
    ) -> List[Notification]:
        """
        Deduplicate and insert persistent notifications for all resolved recipients.
        """
        created = []
        payload_str = json.dumps(payload, default=str)

        for uid in recipient_user_ids:
            if not uid:
                continue
            dedup_key = f"{event_key}:{uid}"
            existing = await db.execute(
                select(Notification).where(
                    Notification.user_id == uid,
                    Notification.deduplication_key == dedup_key,
                )
            )
            if existing.scalar_one_or_none():
                continue

            notif = Notification(
                institution_id=DEFAULT_INSTITUTION_ID,
                user_id=uid,
                title=title,
                message=message,
                category=category,
                priority=priority,
                link_type=link_type,
                link_id=link_id,
                payload_json=payload_str,
                action_route=action_route,
                deduplication_key=dedup_key,
            )
            db.add(notif)
            created.append(notif)

        if created:
            await db.flush()
            logger.info(
                f"[AuthorityNotification] Dispatched {len(created)} notifications for event {event_key} "
                f"(Priority: {priority}, Route: {action_route})"
            )
        return created

    # -------------------------------------------------------------------------
    # 1. Finalized Attendance Amendment
    # -------------------------------------------------------------------------
    @classmethod
    async def notify_attendance_amendment(
        cls,
        db: AsyncSession,
        session_id: uuid.UUID,
        record_id: uuid.UUID,
        student_user_id: uuid.UUID,
        amending_user_id: uuid.UUID,
        old_status: str,
        new_status: str,
        reason: str,
        conducting_faculty_user_id: Optional[uuid.UUID] = None,
        teaching_assignment_id: Optional[uuid.UUID] = None,
        department_id: Optional[uuid.UUID] = None,
    ) -> List[Notification]:
        """
        Matrix Rule 1: Finalized attendance amendment.
        Recipients: Affected student, regular teaching faculty, conducting faculty if different, relevant HOD.
        Priority: HIGH
        """
        recipients: Set[uuid.UUID] = {student_user_id}

        regular_faculty_id = None
        if teaching_assignment_id:
            ta_res = await db.execute(select(TeachingAssignment).where(TeachingAssignment.id == teaching_assignment_id))
            ta = ta_res.scalar_one_or_none()
            if ta:
                regular_faculty_id = ta.faculty_user_id
                recipients.add(ta.faculty_user_id)
                if not department_id and ta.class_section_id:
                    sec_res = await db.execute(select(ClassSection).where(ClassSection.id == ta.class_section_id))
                    sec = sec_res.scalar_one_or_none()
                    if sec:
                        department_id = sec.department_id

        if conducting_faculty_user_id and conducting_faculty_user_id != regular_faculty_id:
            recipients.add(conducting_faculty_user_id)

        # Resolve HOD / Department Coordinator with delegation.approve or attendance.amendment.approve
        hod_approvers = await cls.resolve_authorities_with_permission(
            db,
            permission_code="delegation.approve",
            scope_type="DEPARTMENT" if department_id else None,
            scope_id=department_id,
        )
        recipients.update(hod_approvers)

        payload = {
            "session_id": str(session_id),
            "record_id": str(record_id),
            "student_user_id": str(student_user_id),
            "amending_user_id": str(amending_user_id),
            "previous_status": old_status,
            "new_status": new_status,
            "amendment_reason": reason,
        }

        return await cls.dispatch_notifications(
            db=db,
            recipient_user_ids=recipients,
            event_key=f"AMENDMENT:{record_id}:{new_status}",
            title=f"Attendance Amended: {new_status}",
            message=f"Attendance record updated from {old_status} to {new_status}. Reason: {reason}",
            category=NotificationCategory.ATTENDANCE.value,
            priority=NotificationPriority.HIGH.value,
            action_route=f"/attendance/session/{session_id}",
            payload=payload,
            link_type="SESSION",
            link_id=str(session_id),
        )

    # -------------------------------------------------------------------------
    # 2. Substitute Delegation Requested
    # -------------------------------------------------------------------------
    @classmethod
    async def notify_delegation_requested(
        cls,
        db: AsyncSession,
        delegation_id: uuid.UUID,
        teaching_assignment_id: uuid.UUID,
        grantor_user_id: uuid.UUID,
        grantee_user_id: uuid.UUID,
        department_id: Optional[uuid.UUID] = None,
        reason: str = "",
    ) -> List[Notification]:
        """
        Matrix Rule 2: Substitute delegation requested.
        Recipients: Authorized HOD / academic approver.
        Priority: HIGH
        """
        if not department_id:
            ta_res = await db.execute(
                select(ClassSection.department_id)
                .join(TeachingAssignment, TeachingAssignment.class_section_id == ClassSection.id)
                .where(TeachingAssignment.id == teaching_assignment_id)
            )
            department_id = ta_res.scalar_one_or_none()

        hod_approvers = await cls.resolve_authorities_with_permission(
            db,
            permission_code="delegation.approve",
            scope_type="DEPARTMENT" if department_id else None,
            scope_id=department_id,
        )

        payload = {
            "delegation_id": str(delegation_id),
            "teaching_assignment_id": str(teaching_assignment_id),
            "grantor_user_id": str(grantor_user_id),
            "grantee_user_id": str(grantee_user_id),
            "reason": reason,
        }

        return await cls.dispatch_notifications(
            db=db,
            recipient_user_ids=hod_approvers,
            event_key=f"DELEGATION_REQ:{delegation_id}",
            title="Substitute Delegation Approval Required",
            message=f"Faculty substitute delegation requested. Reason: {reason or 'Pending review'}",
            category=NotificationCategory.DELEGATION.value,
            priority=NotificationPriority.HIGH.value,
            action_route="/delegations/approvals",
            payload=payload,
            link_type="DELEGATION",
            link_id=str(delegation_id),
        )

    # -------------------------------------------------------------------------
    # 3. Substitute Delegation Granted or Revoked
    # -------------------------------------------------------------------------
    @classmethod
    async def notify_delegation_granted_or_revoked(
        cls,
        db: AsyncSession,
        delegation_id: uuid.UUID,
        regular_faculty_user_id: uuid.UUID,
        substitute_faculty_user_id: uuid.UUID,
        is_granted: bool,
        department_id: Optional[uuid.UUID] = None,
        reason: str = "",
    ) -> List[Notification]:
        """
        Matrix Rule 3: Substitute delegation granted or revoked.
        Recipients: Regular faculty, substitute faculty, relevant HOD.
        Priority: HIGH
        """
        recipients: Set[uuid.UUID] = {regular_faculty_user_id, substitute_faculty_user_id}

        hod_approvers = await cls.resolve_authorities_with_permission(
            db,
            permission_code="delegation.approve",
            scope_type="DEPARTMENT" if department_id else None,
            scope_id=department_id,
        )
        recipients.update(hod_approvers)

        status_str = "Granted" if is_granted else "Revoked"
        payload = {
            "delegation_id": str(delegation_id),
            "status": status_str,
            "regular_faculty_user_id": str(regular_faculty_user_id),
            "substitute_faculty_user_id": str(substitute_faculty_user_id),
            "reason": reason,
        }

        return await cls.dispatch_notifications(
            db=db,
            recipient_user_ids=recipients,
            event_key=f"DELEGATION_STATUS:{delegation_id}:{status_str}",
            title=f"Substitute Delegation {status_str}",
            message=f"Delegation has been {status_str.lower()}. {reason or ''}",
            category=NotificationCategory.DELEGATION.value,
            priority=NotificationPriority.HIGH.value,
            action_route="/delegations",
            payload=payload,
            link_type="DELEGATION",
            link_id=str(delegation_id),
        )

    # -------------------------------------------------------------------------
    # 4. Student Grievance / Excuse Submitted
    # -------------------------------------------------------------------------
    @classmethod
    async def notify_grievance_submitted(
        cls,
        db: AsyncSession,
        request_id: uuid.UUID,
        student_user_id: uuid.UUID,
        conducting_faculty_user_id: uuid.UUID,
        session_id: Optional[uuid.UUID] = None,
        reason: str = "",
    ) -> List[Notification]:
        """
        Matrix Rule 4: Student grievance/excuse submitted.
        Recipients: Conducting faculty of the relevant session.
        Priority: NORMAL
        """
        payload = {
            "request_id": str(request_id),
            "student_user_id": str(student_user_id),
            "session_id": str(session_id) if session_id else None,
            "reason": reason,
        }

        return await cls.dispatch_notifications(
            db=db,
            recipient_user_ids={conducting_faculty_user_id},
            event_key=f"GRIEVANCE_SUBMITTED:{request_id}",
            title="Student Absence Excuse Submitted",
            message=f"Student submitted an attendance excuse: {reason[:100]}",
            category=NotificationCategory.REQUEST.value,
            priority=NotificationPriority.NORMAL.value,
            action_route=f"/requests/{request_id}",
            payload=payload,
            link_type="REQUEST",
            link_id=str(request_id),
        )

    # -------------------------------------------------------------------------
    # 5. Grievance Accepted / Rejected
    # -------------------------------------------------------------------------
    @classmethod
    async def notify_grievance_resolved(
        cls,
        db: AsyncSession,
        request_id: uuid.UUID,
        student_user_id: uuid.UUID,
        regular_faculty_user_id: uuid.UUID,
        conducting_faculty_user_id: Optional[uuid.UUID],
        status: str,
        resolution_notes: str = "",
    ) -> List[Notification]:
        """
        Matrix Rule 5: Grievance accepted/rejected.
        Recipients: Student, regular teaching faculty, conducting faculty if different.
        Priority: NORMAL
        """
        recipients: Set[uuid.UUID] = {student_user_id, regular_faculty_user_id}
        if conducting_faculty_user_id and conducting_faculty_user_id != regular_faculty_user_id:
            recipients.add(conducting_faculty_user_id)

        payload = {
            "request_id": str(request_id),
            "status": status,
            "resolution_notes": resolution_notes,
        }

        return await cls.dispatch_notifications(
            db=db,
            recipient_user_ids=recipients,
            event_key=f"GRIEVANCE_RESOLVED:{request_id}:{status}",
            title=f"Attendance Request {status.title()}",
            message=f"Your attendance grievance was {status.lower()}. Notes: {resolution_notes or 'None'}",
            category=NotificationCategory.REQUEST.value,
            priority=NotificationPriority.NORMAL.value,
            action_route=f"/requests/{request_id}",
            payload=payload,
            link_type="REQUEST",
            link_id=str(request_id),
        )

    # -------------------------------------------------------------------------
    # 6. Attendance Shortage
    # -------------------------------------------------------------------------
    @classmethod
    async def notify_attendance_shortage(
        cls,
        db: AsyncSession,
        student_user_id: uuid.UUID,
        class_section_id: uuid.UUID,
        percentage: float,
        threshold: Optional[float] = None,
        subject_id: Optional[uuid.UUID] = None,
    ) -> List[Notification]:
        """
        Matrix Rule 6: Attendance shortage alert.
        Recipients: Student, relevant Class Advisor, Academic Program Coordinator.
        Priority: NORMAL
        """
        # Read institutional threshold from deployment config if not provided
        if threshold is None:
            cfg_res = await db.execute(
                select(DeploymentConfig.attendance_shortage_threshold).where(DeploymentConfig.singleton_id == 1)
            )
            threshold = float(cfg_res.scalar_one_or_none() or 75.0)

        recipients: Set[uuid.UUID] = {student_user_id}

        # Resolve Class Advisor scoped to CLASS_SECTION
        class_advisors = await cls.resolve_authorities_with_permission(
            db,
            permission_code="attendance.session.view",
            scope_type="CLASS_SECTION",
            scope_id=class_section_id,
        )
        recipients.update(class_advisors)

        # Resolve Program Coordinator scoped to the section's PROGRAM
        sec_res = await db.execute(select(ClassSection).where(ClassSection.id == class_section_id))
        sec = sec_res.scalar_one_or_none()
        if sec and sec.program_id:
            program_coordinators = await cls.resolve_authorities_with_permission(
                db,
                permission_code="reports.view",
                scope_type="PROGRAM",
                scope_id=sec.program_id,
            )
            recipients.update(program_coordinators)

        payload = {
            "student_user_id": str(student_user_id),
            "class_section_id": str(class_section_id),
            "subject_id": str(subject_id) if subject_id else None,
            "percentage": percentage,
            "threshold": threshold,
        }

        return await cls.dispatch_notifications(
            db=db,
            recipient_user_ids=recipients,
            event_key=f"SHORTAGE:{student_user_id}:{class_section_id}:{datetime.now(timezone.utc).strftime('%Y-%m')}",
            title="Attendance Shortage Warning",
            message=f"Attendance ({percentage:.1f}%) is below the configured institutional threshold ({threshold:.1f}%).",
            category=NotificationCategory.SHORTAGE.value,
            priority=NotificationPriority.NORMAL.value,
            action_route="/analytics/shortage",
            payload=payload,
            link_type="SECTION",
            link_id=str(class_section_id),
        )

    # -------------------------------------------------------------------------
    # 7. Biometric Re-enrollment
    # -------------------------------------------------------------------------
    @classmethod
    async def notify_biometric_reenrollment(
        cls,
        db: AsyncSession,
        student_user_id: uuid.UUID,
        reason: str,
    ) -> List[Notification]:
        """
        Matrix Rule 7: Biometric re-enrollment required.
        Recipients: Student and assigned Biometric Enrollment Officer.
        Priority: NORMAL
        """
        recipients: Set[uuid.UUID] = {student_user_id}

        enrollment_officers = await cls.resolve_authorities_with_permission(
            db,
            permission_code="biometrics.enroll.assisted",
        )
        recipients.update(enrollment_officers)

        payload = {
            "student_user_id": str(student_user_id),
            "reason": reason,
        }

        return await cls.dispatch_notifications(
            db=db,
            recipient_user_ids=recipients,
            event_key=f"BIOMETRIC_REENROLL:{student_user_id}",
            title="Biometric Re-enrollment Required",
            message=f"Biometric re-enrollment scheduled: {reason}",
            category=NotificationCategory.SYSTEM.value,
            priority=NotificationPriority.NORMAL.value,
            action_route="/biometrics/enroll",
            payload=payload,
            link_type="STUDENT",
            link_id=str(student_user_id),
        )

    # -------------------------------------------------------------------------
    # 8. Biometric Privacy, Consent or Retention Incident
    # -------------------------------------------------------------------------
    @classmethod
    async def notify_biometric_privacy_incident(
        cls,
        db: AsyncSession,
        incident_type: str,
        details: str,
        severity: str = "HIGH",
    ) -> List[Notification]:
        """
        Matrix Rule 8: Biometric privacy, consent or retention incident.
        Recipients: Privacy & Biometric Governance Officer.
        Priority: HIGH
        """
        privacy_officers = await cls.resolve_authorities_with_permission(
            db,
            permission_code="biometrics.policy.manage",
        )
        retention_officers = await cls.resolve_authorities_with_permission(
            db,
            permission_code="biometrics.retention.manage",
        )
        recipients = privacy_officers.union(retention_officers)

        payload = {
            "incident_type": incident_type,
            "details": details,
            "severity": severity,
        }

        return await cls.dispatch_notifications(
            db=db,
            recipient_user_ids=recipients,
            event_key=f"PRIVACY_INCIDENT:{uuid.uuid4().hex[:8]}",
            title=f"Biometric Privacy Alert: {incident_type}",
            message=f"Governance Alert: {details}",
            category=NotificationCategory.SYSTEM.value,
            priority=NotificationPriority.HIGH.value,
            action_route="/audit/governance",
            payload=payload,
            link_type="INCIDENT",
            link_id=incident_type,
        )
