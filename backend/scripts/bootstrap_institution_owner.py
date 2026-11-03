"""Controlled One-Time Institution Owner Provisioning Procedure.

Requirements:
- Does NOT automatically promote any user.
- Explicitly targets a specified user and institution.
- Ensures the user and institution are ACTIVE.
- Creates or retrieves InstitutionMembership.
- Assigns INSTITUTION_OWNER role template with INSTITUTION scope.
- Produces an immutable, auditable record in AuthorizationAudit.
"""

import argparse
import asyncio
from datetime import datetime, timezone
from typing import Optional
import uuid
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from src.database import async_session_factory
from src.models.user import User, AccountStatus
from src.models.access_control import (
    Institution,
    InstitutionStatus,
    InstitutionMembership,
    MembershipStatus,
    RoleTemplate,
    RoleAssignment,
    AssignmentStatus,
    RoleAssignmentScope,
    RoleScopeType,
    AuthorizationAudit,
    AuditOutcome,
)


async def bootstrap_institution_owner(
    db: AsyncSession,
    institution_code: str,
    user_email_or_inst_id: str,
    reason: str,
    operator_note: Optional[str] = None,
) -> dict:
    """Explicitly provision the first Institution Owner with audit trail."""
    # 1. Verify Institution (acquire row-level lock to prevent concurrent bootstrap race conditions)
    inst_stmt = select(Institution).where(Institution.code == institution_code).with_for_update()
    inst_res = await db.execute(inst_stmt)
    institution = inst_res.scalar_one_or_none()
    if not institution:
        raise ValueError(f"Institution with code '{institution_code}' does not exist.")
    if institution.status != InstitutionStatus.ACTIVE:
        raise ValueError(f"Institution '{institution.code}' is not ACTIVE (status={institution.status}).")

    # 2. Verify User
    user_stmt = select(User).where(
        (User.email == user_email_or_inst_id) | (User.institutional_id == user_email_or_inst_id)
    )
    user_res = await db.execute(user_stmt)
    user = user_res.scalar_one_or_none()
    if not user:
        raise ValueError(f"User '{user_email_or_inst_id}' does not exist.")
    if user.account_status != AccountStatus.ACTIVE:
        raise ValueError(f"User account '{user.institutional_id}' is not ACTIVE (status={user.account_status}).")

    # 3. Verify RoleTemplate
    role_stmt = select(RoleTemplate).where(RoleTemplate.code == "INSTITUTION_OWNER")
    role_res = await db.execute(role_stmt)
    role_template = role_res.scalar_one_or_none()
    if not role_template:
        raise ValueError("RoleTemplate 'INSTITUTION_OWNER' does not exist. Run seed script first.")

    # 4. Check for existing Institution Owner
    existing_owner_stmt = (
        select(RoleAssignment)
        .join(InstitutionMembership, RoleAssignment.membership_id == InstitutionMembership.id)
        .where(
            InstitutionMembership.institution_id == institution.id,
            RoleAssignment.role_template_id == role_template.id,
            RoleAssignment.status == AssignmentStatus.ACTIVE,
        )
    )
    existing_owner_res = await db.execute(existing_owner_stmt)
    existing_owner = existing_owner_res.scalar_one_or_none()
    if existing_owner:
        raise ValueError(
            f"An active Institution Owner already exists for institution '{institution.code}'. "
            "Use standard delegation or ownership transfer workflow."
        )

    # 5. Retrieve or create InstitutionMembership
    member_stmt = select(InstitutionMembership).where(
        InstitutionMembership.institution_id == institution.id,
        InstitutionMembership.user_id == user.id,
    )
    member_res = await db.execute(member_stmt)
    membership = member_res.scalar_one_or_none()
    if not membership:
        membership = InstitutionMembership(
            institution_id=institution.id,
            user_id=user.id,
            status=MembershipStatus.ACTIVE,
            joined_at=datetime.now(timezone.utc),
        )
        db.add(membership)
        await db.flush()
    elif membership.status != MembershipStatus.ACTIVE:
        raise ValueError(f"User membership in '{institution.code}' is not ACTIVE (status={membership.status}).")

    now = datetime.now(timezone.utc)

    # 6. Create RoleAssignment
    assignment = RoleAssignment(
        membership_id=membership.id,
        role_template_id=role_template.id,
        institution_id=institution.id,
        status=AssignmentStatus.ACTIVE,
        valid_from=now,
        valid_until=None,
        reason=reason,
    )
    db.add(assignment)
    await db.flush()

    # 7. Create RoleAssignmentScope (INSTITUTION level)
    scope = RoleAssignmentScope(
        role_assignment_id=assignment.id,
        institution_id=institution.id,
        scope_type=RoleScopeType.INSTITUTION,
    )
    db.add(scope)
    await db.flush()

    # 8. Record in AuthorizationAudit
    audit_entry = AuthorizationAudit(
        actor_user_id=user.id,
        actor_membership_id=membership.id,
        institution_id=institution.id,
        action="institution_owner.bootstrap",
        permission_code="institution.manage",
        target_resource_type="InstitutionMembership",
        target_resource_id=str(membership.id),
        outcome=AuditOutcome.ALLOWED,
        reason=f"Owner bootstrap: {reason}. Note: {operator_note or 'None'}",
        correlation_id=f"bootstrap-{uuid.uuid4().hex[:12]}",
        created_at=now,
    )
    db.add(audit_entry)

    await db.commit()

    return {
        "status": "SUCCESS",
        "institution": {"id": str(institution.id), "code": institution.code, "name": institution.name},
        "owner_user": {"id": str(user.id), "email": user.email, "institutional_id": user.institutional_id},
        "membership_id": str(membership.id),
        "assignment_id": str(assignment.id),
        "scope_id": str(scope.id),
        "audit_id": str(audit_entry.id),
    }


def main():
    parser = argparse.ArgumentParser(description="Bootstrap first Institution Owner")
    parser.add_argument("--institution-code", required=True, help="Code of the target institution")
    parser.add_argument("--user", required=True, help="Email or institutional_id of the user to assign")
    parser.add_argument("--reason", required=True, help="Documented reason/authorization for bootstrap")
    parser.add_argument("--note", default=None, help="Optional operator notes")

    args = parser.parse_args()

    async def run():
        async with async_session_factory() as session:
            try:
                res = await bootstrap_institution_owner(
                    db=session,
                    institution_code=args.institution_code,
                    user_email_or_inst_id=args.user,
                    reason=args.reason,
                    operator_note=args.note,
                )
                print("Bootstrap successful:")
                for k, v in res.items():
                    print(f"  {k}: {v}")
            except Exception as e:
                print(f"Error during bootstrap: {e}")
                exit(1)

    asyncio.run(run())


if __name__ == "__main__":
    main()
