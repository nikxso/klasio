"""Institutional Access Control v1 (IAC v1) Seed Service.

Defines the 20 canonical role templates across 5 functional domains:
1. Governance: INSTITUTION_OWNER, CENTRAL_INSTITUTION_ADMIN, CAMPUS_ADMIN,
   ACCESS_ADMIN, IT_ADMIN, PRIVACY_BIOMETRIC_OFFICER
2. Academic Admin: ACADEMIC_REGISTRAR, ADMISSIONS_OFFICER, ENROLLMENT_OFFICER,
   STUDENT_RECORDS_OFFICER, DEPARTMENT_HEAD, PROGRAM_COORDINATOR, TIMETABLE_COORDINATOR
3. Teaching: FACULTY, TEACHING_ASSISTANT, CLASS_ADVISOR
4. Biometrics & Audit: BIOMETRIC_ENROLLMENT_OFFICER, ATTENDANCE_AUDITOR, INSTITUTIONAL_AUDITOR
5. Student: STUDENT

Provides idempotent seeding helper `seed_canonical_role_templates`.
"""

from typing import Any, Dict, List, Set
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.models.access_control import (
    Permission,
    RoleTemplate,
    role_permissions,
)

# Standard IAC v1 permission catalogue
PERMISSIONS_CATALOGUE: List[Dict[str, Any]] = [
    # Institution governance
    {"code": "institution.view", "resource": "institution", "action": "view", "description": "View institutional metadata and hierarchy", "is_sensitive": False},
    {"code": "institution.manage", "resource": "institution", "action": "manage", "description": "Manage institutional settings and governance", "is_sensitive": True},
    # Campus operations
    {"code": "campus.view", "resource": "campus", "action": "view", "description": "View campus details and associations", "is_sensitive": False},
    {"code": "campus.create", "resource": "campus", "action": "create", "description": "Create new campus entity", "is_sensitive": True},
    {"code": "campus.update", "resource": "campus", "action": "update", "description": "Update campus configuration", "is_sensitive": True},
    {"code": "campus.archive", "resource": "campus", "action": "archive", "description": "Archive campus entity", "is_sensitive": True},
    # Membership management
    {"code": "membership.view", "resource": "membership", "action": "view", "description": "View institution memberships", "is_sensitive": False},
    {"code": "membership.invite", "resource": "membership", "action": "invite", "description": "Invite or provision user membership", "is_sensitive": True},
    {"code": "membership.update", "resource": "membership", "action": "update", "description": "Update membership details", "is_sensitive": True},
    {"code": "membership.suspend", "resource": "membership", "action": "suspend", "description": "Suspend user membership", "is_sensitive": True},
    # Role assignment
    {"code": "role_assignment.view", "resource": "role_assignment", "action": "view", "description": "View role assignments and scopes", "is_sensitive": False},
    {"code": "role_assignment.create", "resource": "role_assignment", "action": "create", "description": "Assign role template with scope", "is_sensitive": True},
    {"code": "role_assignment.revoke", "resource": "role_assignment", "action": "revoke", "description": "Revoke role assignment", "is_sensitive": True},
    # Delegation
    {"code": "role.delegate", "resource": "delegation", "action": "delegate", "description": "Initiate authority delegation within permitted scope", "is_sensitive": True},
    {"code": "delegation.create", "resource": "delegation", "action": "create", "description": "Create delegation request", "is_sensitive": True},
    {"code": "delegation.approve", "resource": "delegation", "action": "approve", "description": "Approve delegation request", "is_sensitive": True},
    {"code": "delegation.revoke", "resource": "delegation", "action": "revoke", "description": "Revoke active delegation", "is_sensitive": True},
    # Academic structure
    {"code": "academic_structure.view", "resource": "academic_structure", "action": "view", "description": "View departments, terms, and sections", "is_sensitive": False},
    {"code": "academic_structure.create", "resource": "academic_structure", "action": "create", "description": "Create academic departments, terms, and sections", "is_sensitive": True},
    {"code": "academic_structure.update", "resource": "academic_structure", "action": "update", "description": "Update academic units and term status", "is_sensitive": True},
    {"code": "academic_structure.archive", "resource": "academic_structure", "action": "archive", "description": "Archive academic structure units", "is_sensitive": True},
    # Admissions
    {"code": "admissions.view", "resource": "admissions", "action": "view", "description": "View applicant admissions pipeline", "is_sensitive": False},
    {"code": "admissions.create", "resource": "admissions", "action": "create", "description": "Create applicant admission record", "is_sensitive": False},
    {"code": "admissions.update", "resource": "admissions", "action": "update", "description": "Update applicant admission details", "is_sensitive": False},
    {"code": "admissions.decide", "resource": "admissions", "action": "decide", "description": "Approve or reject admission application", "is_sensitive": True},
    # Student enrollment
    {"code": "student_enrollment.view", "resource": "student_enrollment", "action": "view", "description": "View student section enrollments", "is_sensitive": False},
    {"code": "student_enrollment.create", "resource": "student_enrollment", "action": "create", "description": "Enroll student into section", "is_sensitive": True},
    {"code": "student_enrollment.transfer", "resource": "student_enrollment", "action": "transfer", "description": "Transfer student between sections", "is_sensitive": True},
    {"code": "student_enrollment.withdraw", "resource": "student_enrollment", "action": "withdraw", "description": "Withdraw student enrollment", "is_sensitive": True},
    # Student records
    {"code": "student_records.view", "resource": "student_records", "action": "view", "description": "View student profile and records", "is_sensitive": False},
    {"code": "student_records.update", "resource": "student_records", "action": "update", "description": "Update student records", "is_sensitive": True},
    # Teaching assignments
    {"code": "teaching_assignment.view", "resource": "teaching_assignment", "action": "view", "description": "View faculty teaching assignments", "is_sensitive": False},
    {"code": "teaching_assignment.create", "resource": "teaching_assignment", "action": "create", "description": "Create faculty teaching assignment", "is_sensitive": True},
    {"code": "teaching_assignment.update", "resource": "teaching_assignment", "action": "update", "description": "Modify teaching assignment", "is_sensitive": True},
    # Timetable
    {"code": "timetable.view", "resource": "timetable", "action": "view", "description": "View class timetable and schedules", "is_sensitive": False},
    {"code": "timetable.manage", "resource": "timetable", "action": "manage", "description": "Manage timetable slots and rooms", "is_sensitive": True},
    # Attendance sessions
    {"code": "attendance.session.view", "resource": "attendance_session", "action": "view", "description": "View attendance sessions and rosters", "is_sensitive": False},
    {"code": "attendance.session.create", "resource": "attendance_session", "action": "create", "description": "Schedule attendance session", "is_sensitive": False},
    {"code": "attendance.session.start", "resource": "attendance_session", "action": "start", "description": "Start live classroom scanning", "is_sensitive": False},
    {"code": "attendance.session.cancel", "resource": "attendance_session", "action": "cancel", "description": "Cancel attendance session", "is_sensitive": True},
    # Recognition review
    {"code": "attendance.candidate.view", "resource": "attendance_candidate", "action": "view", "description": "View suggested recognition candidates", "is_sensitive": False},
    {"code": "attendance.candidate.review", "resource": "attendance_candidate", "action": "review", "description": "Review candidate face matches", "is_sensitive": False},
    {"code": "attendance.candidate.correct", "resource": "attendance_candidate", "action": "correct", "description": "Correct recognition candidates manually", "is_sensitive": False},
    # Attendance marks
    {"code": "attendance.mark.manual", "resource": "attendance_mark", "action": "manual", "description": "Set manual attendance status", "is_sensitive": False},
    {"code": "attendance.session.finalize", "resource": "attendance_session", "action": "finalize", "description": "Finalize and commit attendance session", "is_sensitive": True},
    # Attendance amendments
    {"code": "attendance.amendment.request", "resource": "attendance_amendment", "action": "request", "description": "Submit attendance correction request", "is_sensitive": False},
    {"code": "attendance.amendment.approve", "resource": "attendance_amendment", "action": "approve", "description": "Approve attendance amendment audit record", "is_sensitive": True},
    # Biometric registration
    {"code": "biometrics.enroll.self", "resource": "biometrics", "action": "enroll_self", "description": "Submit personal biometric enrollment frames", "is_sensitive": False},
    {"code": "biometrics.enroll.assisted", "resource": "biometrics", "action": "enroll_assisted", "description": "Conduct faculty/officer assisted biometric enrollment", "is_sensitive": True},
    {"code": "biometrics.status.view", "resource": "biometrics", "action": "view_status", "description": "View biometric registration status", "is_sensitive": False},
    # Biometric governance (NOTE: biometrics.template.read is NEVER permitted)
    {"code": "biometrics.profile.revoke", "resource": "biometrics", "action": "revoke_profile", "description": "Revoke student biometric profile", "is_sensitive": True},
    {"code": "biometrics.policy.manage", "resource": "biometrics", "action": "manage_policy", "description": "Manage biometric retention and capture policy", "is_sensitive": True},
    {"code": "biometrics.retention.manage", "resource": "biometrics", "action": "manage_retention", "description": "Execute biometric retention and deletion", "is_sensitive": True},
    # Reports
    {"code": "reports.view", "resource": "reports", "action": "view", "description": "View attendance and academic analytics reports", "is_sensitive": False},
    {"code": "reports.export", "resource": "reports", "action": "export", "description": "Export CSV/PDF reports", "is_sensitive": True},
    # Audit
    {"code": "audit_logs.view", "resource": "audit_logs", "action": "view", "description": "View system and authorization audit trails", "is_sensitive": True},
    # Technical operations
    {"code": "integrations.manage", "resource": "technical", "action": "manage_integrations", "description": "Manage external API integrations", "is_sensitive": True},
    {"code": "devices.manage", "resource": "technical", "action": "manage_devices", "description": "Manage registered classroom devices", "is_sensitive": True},
    {"code": "technical_settings.manage", "resource": "technical", "action": "manage_settings", "description": "Manage system configurations", "is_sensitive": True},
    # Security policy
    {"code": "security.policy.view", "resource": "security", "action": "view_policy", "description": "View security and access policies", "is_sensitive": True},
    {"code": "security.policy.manage", "resource": "security", "action": "manage_policy", "description": "Modify access-control policies", "is_sensitive": True},
]

# The 20 approved canonical role templates across 5 domains
CANONICAL_ROLE_TEMPLATES: List[Dict[str, Any]] = [
    # Domain 1: Governance
    {
        "code": "INSTITUTION_OWNER",
        "name": "Institution Owner",
        "category": "GOVERNANCE",
        "description": "Central governance, ownership-level decisions and appointment of authorized central administrators",
        "permissions": [
            "institution.view", "institution.manage",
            "campus.view", "campus.create", "campus.update", "campus.archive",
            "membership.view", "membership.invite", "membership.update", "membership.suspend",
            "role_assignment.view", "role_assignment.create", "role_assignment.revoke",
            "role.delegate", "delegation.create", "delegation.approve", "delegation.revoke",
            "academic_structure.view", "academic_structure.create", "academic_structure.update", "academic_structure.archive",
            "admissions.view", "admissions.decide",
            "student_enrollment.view",
            "teaching_assignment.view", "teaching_assignment.create", "teaching_assignment.update",
            "timetable.view", "timetable.manage",
            "attendance.session.view", "attendance.candidate.view",
            "biometrics.status.view", "biometrics.policy.manage", "biometrics.retention.manage",
            "reports.view", "reports.export", "audit_logs.view",
            "security.policy.view", "security.policy.manage",
        ],
    },
    {
        "code": "CENTRAL_INSTITUTION_ADMIN",
        "name": "Central Institution Administrator",
        "category": "GOVERNANCE",
        "description": "Day-to-day central institutional operations and coordination of campuses",
        "permissions": [
            "institution.view", "institution.manage",
            "campus.view", "campus.create", "campus.update",
            "membership.view", "membership.invite", "membership.update", "membership.suspend",
            "role_assignment.view", "role_assignment.create", "role_assignment.revoke",
            "role.delegate", "delegation.create", "delegation.approve", "delegation.revoke",
            "academic_structure.view", "academic_structure.create", "academic_structure.update",
            "admissions.view", "admissions.create", "admissions.update", "admissions.decide",
            "student_enrollment.view", "student_enrollment.create", "student_enrollment.transfer", "student_enrollment.withdraw",
            "student_records.view", "student_records.update",
            "teaching_assignment.view", "teaching_assignment.create", "teaching_assignment.update",
            "timetable.view", "timetable.manage",
            "attendance.session.view", "attendance.candidate.view",
            "biometrics.status.view",
            "reports.view", "reports.export", "audit_logs.view",
        ],
    },
    {
        "code": "CAMPUS_ADMIN",
        "name": "Campus Administrator",
        "category": "GOVERNANCE",
        "description": "Local campus operations and campus-scoped administration",
        "permissions": [
            "campus.view", "campus.update",
            "membership.view", "membership.invite", "membership.update",
            "role_assignment.view",
            "role.delegate", "delegation.create", "delegation.approve",
            "academic_structure.view", "academic_structure.create", "academic_structure.update",
            "student_records.view",
            "teaching_assignment.view",
            "timetable.view",
            "attendance.session.view", "attendance.candidate.view",
            "biometrics.status.view",
            "reports.view", "reports.export", "audit_logs.view",
        ],
    },
    {
        "code": "ACCESS_ADMIN",
        "name": "Access Administrator",
        "category": "GOVERNANCE",
        "description": "Membership provisioning and assignment/revocation of permitted role templates",
        "permissions": [
            "membership.view", "membership.invite", "membership.update", "membership.suspend",
            "role_assignment.view", "role_assignment.create", "role_assignment.revoke",
            "delegation.create", "delegation.approve", "delegation.revoke",
            "audit_logs.view",
        ],
    },
    {
        "code": "IT_ADMIN",
        "name": "IT Administrator",
        "category": "GOVERNANCE",
        "description": "Technical configuration, integrations, device/application operations and technical diagnostics",
        "permissions": [
            "integrations.manage", "devices.manage", "technical_settings.manage",
            "security.policy.view",
            "audit_logs.view",
        ],
    },
    {
        "code": "PRIVACY_BIOMETRIC_OFFICER",
        "name": "Privacy & Biometric Governance Officer",
        "category": "GOVERNANCE",
        "description": "Consent governance, biometric retention/deletion policy, privacy oversight and compliance review",
        "permissions": [
            "student_records.view",
            "attendance.session.view",
            "biometrics.status.view", "biometrics.profile.revoke", "biometrics.policy.manage", "biometrics.retention.manage",
            "audit_logs.view", "security.policy.view", "security.policy.manage",
        ],
    },
    # Domain 2: Academic Administration
    {
        "code": "ACADEMIC_REGISTRAR",
        "name": "Academic Registrar",
        "category": "ACADEMIC_ADMIN",
        "description": "Academic governance, academic terms, institutional academic policies and authorized academic approvals",
        "permissions": [
            "academic_structure.view", "academic_structure.create", "academic_structure.update",
            "admissions.view", "admissions.decide",
            "student_enrollment.view", "student_enrollment.transfer", "student_enrollment.withdraw",
            "student_records.view", "student_records.update",
            "teaching_assignment.view", "teaching_assignment.create", "teaching_assignment.update",
            "timetable.view", "timetable.manage",
            "attendance.session.view", "attendance.amendment.approve",
            "biometrics.status.view",
            "reports.view", "reports.export",
        ],
    },
    {
        "code": "ADMISSIONS_OFFICER",
        "name": "Admissions Officer",
        "category": "ACADEMIC_ADMIN",
        "description": "Applicant processing, admission decisions and transition into student membership",
        "permissions": [
            "admissions.view", "admissions.create", "admissions.update", "admissions.decide",
            "student_records.view",
            "reports.view",
        ],
    },
    {
        "code": "ENROLLMENT_OFFICER",
        "name": "Enrollment Officer",
        "category": "ACADEMIC_ADMIN",
        "description": "Academic enrollment, section assignment, transfer and withdrawal",
        "permissions": [
            "academic_structure.view",
            "student_enrollment.view", "student_enrollment.create", "student_enrollment.transfer", "student_enrollment.withdraw",
            "student_records.view",
            "reports.view",
        ],
    },
    {
        "code": "STUDENT_RECORDS_OFFICER",
        "name": "Student Records Officer",
        "category": "ACADEMIC_ADMIN",
        "description": "Maintenance of approved student profile and academic-record fields",
        "permissions": [
            "academic_structure.view",
            "student_records.view", "student_records.update",
            "biometrics.status.view",
            "reports.view",
        ],
    },
    {
        "code": "DEPARTMENT_HEAD",
        "name": "Department Head",
        "category": "ACADEMIC_ADMIN",
        "description": "Department operations, faculty coordination, curriculum oversight, and substitute delegation approval",
        "permissions": [
            "academic_structure.view", "academic_structure.update",
            "student_records.view",
            "teaching_assignment.view", "teaching_assignment.create", "teaching_assignment.update",
            "timetable.view",
            "attendance.session.view", "attendance.candidate.view", "attendance.amendment.approve",
            "role.delegate", "delegation.create", "delegation.approve",
            "biometrics.status.view", "biometrics.enroll.assisted",
            "reports.view", "reports.export",
        ],
    },
    {
        "code": "PROGRAM_COORDINATOR",
        "name": "Program Coordinator",
        "category": "ACADEMIC_ADMIN",
        "description": "Program-level academic operations, cohorts and program reporting",
        "permissions": [
            "academic_structure.view",
            "student_records.view",
            "teaching_assignment.view",
            "timetable.view",
            "attendance.session.view", "attendance.candidate.view",
            "reports.view",
        ],
    },
    {
        "code": "TIMETABLE_COORDINATOR",
        "name": "Timetable Coordinator",
        "category": "ACADEMIC_ADMIN",
        "description": "Timetable, class schedule and teaching-slot management",
        "permissions": [
            "academic_structure.view",
            "teaching_assignment.view",
            "timetable.view", "timetable.manage",
            "attendance.session.view",
            "reports.view",
        ],
    },
    # Domain 3: Teaching
    {
        "code": "FACULTY",
        "name": "Faculty",
        "category": "TEACHING",
        "description": "Conducting classes, scanning, attendance candidate review and authorized attendance finalization",
        "permissions": [
            "student_records.view",
            "teaching_assignment.view",
            "timetable.view",
            "attendance.session.view", "attendance.session.create", "attendance.session.start", "attendance.session.cancel",
            "attendance.candidate.view", "attendance.candidate.review", "attendance.candidate.correct",
            "attendance.mark.manual", "attendance.session.finalize",
            "attendance.amendment.request",
            "role.delegate", "delegation.create",
            "biometrics.status.view", "biometrics.enroll.assisted",
            "reports.view", "reports.export",
        ],
    },
    {
        "code": "TEACHING_ASSISTANT",
        "name": "Teaching Assistant",
        "category": "TEACHING",
        "description": "Roster and classroom assistance; no finalization by default",
        "permissions": [
            "student_records.view",
            "teaching_assignment.view",
            "attendance.session.view", "attendance.candidate.view", "attendance.candidate.review", "attendance.candidate.correct",
        ],
    },
    {
        "code": "CLASS_ADVISOR",
        "name": "Class Advisor",
        "category": "TEACHING",
        "description": "Student cohort oversight and read-only attendance monitoring by default",
        "permissions": [
            "student_records.view",
            "timetable.view",
            "attendance.session.view", "attendance.candidate.view",
            "biometrics.status.view",
            "reports.view",
        ],
    },
    # Domain 4: Biometrics & Audit
    {
        "code": "BIOMETRIC_ENROLLMENT_OFFICER",
        "name": "Biometric Enrollment Officer",
        "category": "BIOMETRICS_AUDIT",
        "description": "Faculty-assisted biometric registration, recapture coordination and registration-status operations",
        "permissions": [
            "student_records.view",
            "biometrics.status.view", "biometrics.enroll.assisted",
            "audit_logs.view",
        ],
    },
    {
        "code": "ATTENDANCE_AUDITOR",
        "name": "Attendance Auditor",
        "category": "BIOMETRICS_AUDIT",
        "description": "Read-only attendance review, amendments and attendance audit evidence",
        "permissions": [
            "student_records.view",
            "attendance.session.view", "attendance.candidate.view",
            "biometrics.status.view",
            "reports.view", "audit_logs.view",
        ],
    },
    {
        "code": "INSTITUTIONAL_AUDITOR",
        "name": "Institutional Auditor",
        "category": "BIOMETRICS_AUDIT",
        "description": "Read-only institutional audit and reporting",
        "permissions": [
            "institution.view", "campus.view", "membership.view",
            "academic_structure.view", "student_records.view",
            "attendance.session.view", "attendance.candidate.view",
            "biometrics.status.view",
            "reports.view", "reports.export", "audit_logs.view",
        ],
    },
    # Domain 5: Student
    {
        "code": "STUDENT",
        "name": "Student",
        "category": "STUDENT",
        "description": "Personal attendance, profile, biometric self-registration and discrepancy requests",
        "permissions": [
            "student_records.view",
            "attendance.session.view", "attendance.amendment.request",
            "biometrics.enroll.self", "biometrics.status.view",
        ],
    },
]


async def seed_canonical_role_templates(db: AsyncSession) -> Dict[str, Dict[str, int]]:
    """Idempotently seed the 20 IAC v1 canonical role templates and their permission bindings.

    Guarantees:
    - Zero duplicate rows on consecutive invocations.
    - Never grants biometrics.template.read to human roles.
    - Idempotently associates permissions to each canonical role template.
    """
    stats = {
        "permissions": {"created": 0, "reused": 0},
        "role_templates": {"created": 0, "reused": 0},
        "role_permissions": {"created": 0, "reused": 0},
    }

    # 1. Seed Permissions
    permissions_by_code: Dict[str, Permission] = {}
    existing_perms_res = await db.execute(select(Permission))
    for p in existing_perms_res.scalars().all():
        permissions_by_code[p.code] = p

    for p_data in PERMISSIONS_CATALOGUE:
        code = p_data["code"]
        if code in permissions_by_code:
            stats["permissions"]["reused"] += 1
        else:
            new_perm = Permission(
                code=code,
                resource=p_data["resource"],
                action=p_data["action"],
                description=p_data["description"],
                is_sensitive=p_data.get("is_sensitive", False),
            )
            db.add(new_perm)
            permissions_by_code[code] = new_perm
            stats["permissions"]["created"] += 1

    await db.flush()

    # 2. Seed Canonical Role Templates & Associations
    existing_roles_res = await db.execute(select(RoleTemplate))
    roles_by_code: Dict[str, RoleTemplate] = {}
    for r in existing_roles_res.scalars().all():
        roles_by_code[r.code] = r

    for r_data in CANONICAL_ROLE_TEMPLATES:
        code = r_data["code"]
        if code in roles_by_code:
            role = roles_by_code[code]
            stats["role_templates"]["reused"] += 1
        else:
            role = RoleTemplate(
                code=code,
                name=r_data["name"],
                category=r_data["category"],
                description=r_data.get("description"),
                is_system_defined=True,
                is_active=True,
            )
            db.add(role)
            await db.flush()
            roles_by_code[code] = role
            stats["role_templates"]["created"] += 1

        # Check existing associations
        existing_rp_stmt = select(role_permissions.c.permission_id).where(
            role_permissions.c.role_template_id == role.id
        )
        existing_rp_res = await db.execute(existing_rp_stmt)
        existing_perm_ids: Set = set(existing_rp_res.scalars().all())

        for perm_code in r_data.get("permissions", []):
            if perm_code not in permissions_by_code:
                continue
            perm = permissions_by_code[perm_code]
            if perm.id in existing_perm_ids:
                stats["role_permissions"]["reused"] += 1
            else:
                insert_stmt = role_permissions.insert().values(
                    role_template_id=role.id,
                    permission_id=perm.id,
                )
                await db.execute(insert_stmt)
                existing_perm_ids.add(perm.id)
                stats["role_permissions"]["created"] += 1

    await db.flush()
    return stats
