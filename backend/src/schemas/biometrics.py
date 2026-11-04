from datetime import datetime
from typing import List, Optional
import uuid
from pydantic import BaseModel, ConfigDict, Field

from src.models.enrollment import FaceRegistrationStatus


class FaceEnrollmentRequest(BaseModel):
    student_user_id: uuid.UUID
    active_model_version: str = Field(..., min_length=1, max_length=64, description="Face recognition model name and version")
    embedding_dimension: int = Field(..., description="Vector embedding dimension (192 or 512)")
    sample_count: int = Field(..., ge=1, description="Number of multi-sample observations captured")
    embedding_base64: Optional[str] = Field(None, description="Base64 encoded float32 binary template embedding")
    embeddings_base64: Optional[List[str]] = Field(None, description="List of base64 encoded float32 binary template embeddings")
    quality_score: float = Field(..., ge=0.0, le=1.0, description="Overall face quality score")


class FaceEnrollmentResponse(BaseModel):
    profile_id: uuid.UUID
    student_user_id: uuid.UUID
    registration_state: FaceRegistrationStatus
    active_model_version: str
    embedding_dimension: int
    sample_count: int
    quality_score: float
    enrolled_at: datetime
    is_re_enrollment: bool = False

    model_config = ConfigDict(from_attributes=True)


class FaceRevocationRequest(BaseModel):
    student_user_id: uuid.UUID
    revocation_reason: str = Field(..., min_length=3, max_length=500, description="Audit justification reason for revocation")


class FaceRevocationResponse(BaseModel):
    student_user_id: uuid.UUID
    registration_state: FaceRegistrationStatus
    revoked_at: datetime
    revocation_reason: str

    model_config = ConfigDict(from_attributes=True)


class GalleryStudentTemplate(BaseModel):
    student_user_id: uuid.UUID
    institutional_id: str
    student_name: str
    embedding_base64: str
    sample_index: int = 0
    model_version: str
    quality_score: float
    updated_at: datetime

    model_config = ConfigDict(from_attributes=True)


class AssignmentGalleryResponse(BaseModel):
    teaching_assignment_id: uuid.UUID
    class_section_id: uuid.UUID
    academic_term_id: uuid.UUID
    gallery_version: str
    template_count: int
    templates: List[GalleryStudentTemplate]

    model_config = ConfigDict(from_attributes=True)
