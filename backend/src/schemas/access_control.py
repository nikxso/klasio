import uuid
from datetime import datetime
from typing import List, Optional
from pydantic import BaseModel, Field

from src.models.access_control import (
    CampusStatus,
    MembershipStatus,
    AssignmentStatus,
    RoleScopeType,
    DelegationLifecycleStatus,
    AuditOutcome,
)


# --- Campus Schemas ---
class CampusCreate(BaseModel):
    code: str = Field(..., max_length=64)
    name: str = Field(..., max_length=255)
    institution_id: Optional[uuid.UUID] = None


class CampusUpdate(BaseModel):
    name: Optional[str] = Field(None, max_length=255)
    status: Optional[CampusStatus] = None


class CampusResponse(BaseModel):
    id: uuid.UUID
    institution_id: uuid.UUID
    code: str
    name: str
    status: CampusStatus
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


# --- Permission Schemas ---
class PermissionResponse(BaseModel):
    id: uuid.UUID
    code: str
    resource: str
    action: str
    description: Optional[str] = None
    is_sensitive: bool

    class Config:
        from_attributes = True


# --- Role Template Schemas ---
class RoleTemplateResponse(BaseModel):
    id: uuid.UUID
    code: str
    name: str
    category: str
    description: Optional[str] = None
    is_system_defined: bool
    is_active: bool
    permissions: List[PermissionResponse] = []

    class Config:
        from_attributes = True


# --- Role Assignment Scopes ---
class RoleAssignmentScopeCreate(BaseModel):
    scope_type: RoleScopeType
    campus_id: Optional[uuid.UUID] = None
    department_id: Optional[uuid.UUID] = None
    academic_term_id: Optional[uuid.UUID] = None
    class_section_id: Optional[uuid.UUID] = None
    teaching_assignment_id: Optional[uuid.UUID] = None
    student_user_id: Optional[uuid.UUID] = None


class RoleAssignmentScopeResponse(BaseModel):
    id: uuid.UUID
    role_assignment_id: uuid.UUID
    institution_id: uuid.UUID
    scope_type: RoleScopeType
    campus_id: Optional[uuid.UUID] = None
    department_id: Optional[uuid.UUID] = None
    academic_term_id: Optional[uuid.UUID] = None
    class_section_id: Optional[uuid.UUID] = None
    teaching_assignment_id: Optional[uuid.UUID] = None
    student_user_id: Optional[uuid.UUID] = None

    class Config:
        from_attributes = True


# --- Role Assignment Schemas ---
class RoleAssignmentCreate(BaseModel):
    membership_id: uuid.UUID
    role_template_id: uuid.UUID
    scope_type: RoleScopeType = RoleScopeType.INSTITUTION
    campus_id: Optional[uuid.UUID] = None
    department_id: Optional[uuid.UUID] = None
    academic_term_id: Optional[uuid.UUID] = None
    class_section_id: Optional[uuid.UUID] = None
    teaching_assignment_id: Optional[uuid.UUID] = None
    student_user_id: Optional[uuid.UUID] = None
    valid_from: Optional[datetime] = None
    valid_until: Optional[datetime] = None
    reason: Optional[str] = None


class RoleAssignmentStatusUpdate(BaseModel):
    status: AssignmentStatus
    reason: Optional[str] = None


class RoleAssignmentResponse(BaseModel):
    id: uuid.UUID
    institution_id: uuid.UUID
    membership_id: uuid.UUID
    role_template_id: uuid.UUID
    role_template_code: str
    role_template_name: str
    status: AssignmentStatus
    valid_from: datetime
    valid_until: Optional[datetime] = None
    reason: Optional[str] = None
    scopes: List[RoleAssignmentScopeResponse] = []
    created_at: datetime

    class Config:
        from_attributes = True


# --- Membership Schemas ---
class InstitutionMembershipResponse(BaseModel):
    id: uuid.UUID
    institution_id: uuid.UUID
    user_id: uuid.UUID
    user_name: str
    user_email: str
    institutional_id: str
    legacy_role: str
    status: MembershipStatus
    joined_at: datetime
    role_assignments: List[RoleAssignmentResponse] = []

    class Config:
        from_attributes = True


# --- Delegation Schemas ---
class DelegationCreate(BaseModel):
    grantor_role_assignment_id: uuid.UUID
    grantee_membership_id: uuid.UUID
    valid_from: datetime
    valid_until: datetime
    reason: str
    permission_ids: Optional[List[uuid.UUID]] = None
    scope_type: RoleScopeType = RoleScopeType.INSTITUTION
    campus_id: Optional[uuid.UUID] = None
    department_id: Optional[uuid.UUID] = None
    class_section_id: Optional[uuid.UUID] = None
    teaching_assignment_id: Optional[uuid.UUID] = None


class DelegationAction(BaseModel):
    reason: Optional[str] = None


class DelegationResponse(BaseModel):
    id: uuid.UUID
    institution_id: uuid.UUID
    grantor_role_assignment_id: uuid.UUID
    grantor_user_name: str
    grantee_membership_id: uuid.UUID
    grantee_user_name: str
    status: DelegationLifecycleStatus
    valid_from: datetime
    valid_until: datetime
    reason: str
    approved_at: Optional[datetime] = None
    revoked_at: Optional[datetime] = None
    revocation_reason: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True


# --- Unmapped Legacy Accounts ---
class UnmappedAccountItem(BaseModel):
    user_id: uuid.UUID
    full_name: str
    institutional_id: str
    email: str
    legacy_role: str
    membership_id: Optional[uuid.UUID] = None
    account_status: str


# --- Authorization Audit Schemas ---
class AuthorizationAuditResponse(BaseModel):
    id: uuid.UUID
    actor_user_id: Optional[uuid.UUID] = None
    actor_name: Optional[str] = None
    action: str
    resource_type: Optional[str] = None
    resource_id: Optional[uuid.UUID] = None
    outcome: AuditOutcome
    reason_code: Optional[str] = None
    reason: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True
