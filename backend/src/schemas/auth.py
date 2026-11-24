from datetime import datetime
from typing import List, Optional
import uuid
from pydantic import BaseModel, ConfigDict, Field

from src.models.user import UserRole
from src.schemas.assignment import FaceRegistrationState


class RoleAssignmentSummary(BaseModel):
    role_template_code: str
    role_template_name: str
    scope_type: str
    department_code: Optional[str] = None
    valid_from: Optional[datetime] = None
    valid_until: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)


class LoginRequest(BaseModel):
    username: str = Field(..., description="Institutional ID or institutional email", min_length=1)
    password: str = Field(..., description="Plaintext account password", min_length=1)


class UserContextResponse(BaseModel):
    id: uuid.UUID
    institutional_id: str
    email: str
    full_name: str
    role: UserRole
    face_registration_state: FaceRegistrationState = FaceRegistrationState.UNREGISTERED
    institution_id: Optional[uuid.UUID] = None
    role_assignments: List[RoleAssignmentSummary] = Field(default_factory=list)
    permissions: List[str] = Field(default_factory=list)

    model_config = ConfigDict(from_attributes=True)


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int
    user: UserContextResponse
