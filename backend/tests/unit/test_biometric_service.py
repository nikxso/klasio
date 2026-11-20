import base64
import math
import struct
import uuid
import pytest
from unittest.mock import AsyncMock, MagicMock

from src.core.exceptions import BiometricValidationError, OutOfScopeError
from src.models.user import User, UserRole, AccountStatus
from src.schemas.biometrics import FaceEnrollmentRequest, FaceRevocationRequest
from src.services.biometric_service import (
    BiometricService,
    DEFAULT_MINIMUM_QUALITY_SCORE,
    DEFAULT_MINIMUM_SAMPLES,
)


def create_normalized_vector(dim: int) -> bytes:
    """Helper to generate a deterministic L2 unit vector of given dimension."""
    val = 1.0 / math.sqrt(dim)
    floats = [val] * dim
    return struct.pack(f"{dim}f", *floats)


def create_base64_vector(dim: int) -> str:
    """Helper to generate base64 string of a normalized float32 vector."""
    raw = create_normalized_vector(dim)
    return base64.b64encode(raw).decode("ascii")


def test_validate_payload_success_edgeface():
    db = MagicMock()
    service = BiometricService(db)

    b64_vec = create_base64_vector(512)
    payload = FaceEnrollmentRequest(
        student_user_id=uuid.uuid4(),
        active_model_version="EdgeFace-XS-v1",
        embedding_dimension=512,
        sample_count=3,
        embedding_base64=b64_vec,
        quality_score=0.85,
    )

    raw_bytes = service.validate_biometric_payload(payload)
    assert len(raw_bytes) == 512 * 4


def test_validate_payload_multi_sample_embeddings_base64():
    db = MagicMock()
    service = BiometricService(db)

    # 3 identical unit vectors have cosine similarity == 1.0 (satisfies >= 0.60 pairwise gate)
    b64_vec = create_base64_vector(512)
    payload = FaceEnrollmentRequest(
        student_user_id=uuid.uuid4(),
        active_model_version="EdgeFace-XS-v1",
        embedding_dimension=512,
        sample_count=3,
        embeddings_base64=[b64_vec, b64_vec, b64_vec],
        quality_score=0.91,
    )

    raw_bytes = service.validate_biometric_payload(payload)
    assert len(raw_bytes) == 3 * 512 * 4


def test_validate_payload_success_mobilefacenet():
    db = MagicMock()
    service = BiometricService(db)

    b64_vec = create_base64_vector(192)
    payload = FaceEnrollmentRequest(
        student_user_id=uuid.uuid4(),
        active_model_version="MobileFaceNet-v1",
        embedding_dimension=192,
        sample_count=4,
        embedding_base64=b64_vec,
        quality_score=0.72,
    )

    raw_bytes = service.validate_biometric_payload(payload)
    assert len(raw_bytes) == 192 * 4


def test_validate_payload_unsupported_model():
    db = MagicMock()
    service = BiometricService(db)

    b64_vec = create_base64_vector(512)
    payload = FaceEnrollmentRequest(
        student_user_id=uuid.uuid4(),
        active_model_version="ResNet50-v1",
        embedding_dimension=512,
        sample_count=3,
        embedding_base64=b64_vec,
        quality_score=0.85,
    )

    with pytest.raises(BiometricValidationError) as exc_info:
        service.validate_biometric_payload(payload)
    assert "Unsupported model version" in str(exc_info.value)


def test_validate_payload_mismatched_dimension():
    db = MagicMock()
    service = BiometricService(db)

    b64_vec = create_base64_vector(192)
    payload = FaceEnrollmentRequest(
        student_user_id=uuid.uuid4(),
        active_model_version="EdgeFace-XS-v1",
        embedding_dimension=192,  # Should be 512
        sample_count=3,
        embedding_base64=b64_vec,
        quality_score=0.85,
    )

    with pytest.raises(BiometricValidationError) as exc_info:
        service.validate_biometric_payload(payload)
    assert "requires dimension 512" in str(exc_info.value)


def test_validate_payload_insufficient_samples():
    db = MagicMock()
    service = BiometricService(db)

    b64_vec = create_base64_vector(512)
    payload = FaceEnrollmentRequest(
        student_user_id=uuid.uuid4(),
        active_model_version="EdgeFace-XS-v1",
        embedding_dimension=512,
        sample_count=2,  # Below minimum 3
        embedding_base64=b64_vec,
        quality_score=0.85,
    )

    with pytest.raises(BiometricValidationError) as exc_info:
        service.validate_biometric_payload(payload)
    assert "Sample count must be at least 3" in str(exc_info.value)


def test_validate_payload_low_quality_score():
    db = MagicMock()
    service = BiometricService(db)

    b64_vec = create_base64_vector(512)
    payload = FaceEnrollmentRequest(
        student_user_id=uuid.uuid4(),
        active_model_version="EdgeFace-XS-v1",
        embedding_dimension=512,
        sample_count=3,
        embedding_base64=b64_vec,
        quality_score=0.69,  # Below minimum 0.70
    )

    with pytest.raises(BiometricValidationError) as exc_info:
        service.validate_biometric_payload(payload)
    assert "below minimum threshold 0.70" in str(exc_info.value)


def test_validate_payload_corrupted_base64():
    db = MagicMock()
    service = BiometricService(db)

    payload = FaceEnrollmentRequest(
        student_user_id=uuid.uuid4(),
        active_model_version="EdgeFace-XS-v1",
        embedding_dimension=512,
        sample_count=3,
        embedding_base64="not-valid-base64!!!",
        quality_score=0.85,
    )

    with pytest.raises(BiometricValidationError) as exc_info:
        service.validate_biometric_payload(payload)
    assert "Invalid base64 embedding payload" in str(exc_info.value) or "Decoded embedding byte length" in str(exc_info.value)


def test_validate_payload_wrong_byte_length():
    db = MagicMock()
    service = BiometricService(db)

    # 100 floats instead of 512
    raw = struct.pack("100f", *([0.1] * 100))
    b64_vec = base64.b64encode(raw).decode("ascii")

    payload = FaceEnrollmentRequest(
        student_user_id=uuid.uuid4(),
        active_model_version="EdgeFace-XS-v1",
        embedding_dimension=512,
        sample_count=3,
        embedding_base64=b64_vec,
        quality_score=0.85,
    )

    with pytest.raises(BiometricValidationError) as exc_info:
        service.validate_biometric_payload(payload)
    assert "does not match expected 2048 bytes" in str(exc_info.value)


def test_validate_payload_nan_values():
    db = MagicMock()
    service = BiometricService(db)

    floats = [1.0 / math.sqrt(512)] * 512
    floats[10] = float("nan")
    raw = struct.pack("512f", *floats)
    b64_vec = base64.b64encode(raw).decode("ascii")

    payload = FaceEnrollmentRequest(
        student_user_id=uuid.uuid4(),
        active_model_version="EdgeFace-XS-v1",
        embedding_dimension=512,
        sample_count=3,
        embedding_base64=b64_vec,
        quality_score=0.85,
    )

    with pytest.raises(BiometricValidationError) as exc_info:
        service.validate_biometric_payload(payload)
    assert "non-finite (NaN or Inf)" in str(exc_info.value)


def test_validate_payload_inf_values():
    db = MagicMock()
    service = BiometricService(db)

    floats = [1.0 / math.sqrt(512)] * 512
    floats[50] = float("inf")
    raw = struct.pack("512f", *floats)
    b64_vec = base64.b64encode(raw).decode("ascii")

    payload = FaceEnrollmentRequest(
        student_user_id=uuid.uuid4(),
        active_model_version="EdgeFace-XS-v1",
        embedding_dimension=512,
        sample_count=3,
        embedding_base64=b64_vec,
        quality_score=0.85,
    )

    with pytest.raises(BiometricValidationError) as exc_info:
        service.validate_biometric_payload(payload)
    assert "non-finite (NaN or Inf)" in str(exc_info.value)


def test_validate_payload_non_unit_l2_norm():
    db = MagicMock()
    service = BiometricService(db)

    # Norm = 2.0 instead of 1.0
    val = 2.0 / math.sqrt(512)
    floats = [val] * 512
    raw = struct.pack("512f", *floats)
    b64_vec = base64.b64encode(raw).decode("ascii")

    payload = FaceEnrollmentRequest(
        student_user_id=uuid.uuid4(),
        active_model_version="EdgeFace-XS-v1",
        embedding_dimension=512,
        sample_count=3,
        embedding_base64=b64_vec,
        quality_score=0.85,
    )

    with pytest.raises(BiometricValidationError) as exc_info:
        service.validate_biometric_payload(payload)
    assert "deviates from 1.0 beyond tolerance" in str(exc_info.value)


@pytest.mark.asyncio
async def test_verify_operator_scope_admin_permitted():
    db = AsyncMock()
    service = BiometricService(db)

    admin_user = User(id=uuid.uuid4(), role=UserRole.ADMIN, account_status=AccountStatus.ACTIVE)
    student_id = uuid.uuid4()

    # Admin should succeed without error
    await service._verify_operator_enrollment_scope(admin_user, student_id)


@pytest.mark.asyncio
async def test_verify_operator_scope_student_self_permitted():
    db = AsyncMock()
    service = BiometricService(db)

    student_id = uuid.uuid4()
    student_user = User(id=student_id, role=UserRole.STUDENT, account_status=AccountStatus.ACTIVE)

    # Student enrolling their own profile should succeed
    await service._verify_operator_enrollment_scope(student_user, student_id)


@pytest.mark.asyncio
async def test_verify_operator_scope_student_cross_enrollment_rejected():
    db = AsyncMock()
    service = BiometricService(db)

    student_a_id = uuid.uuid4()
    student_b_id = uuid.uuid4()
    student_a_user = User(id=student_a_id, role=UserRole.STUDENT, account_status=AccountStatus.ACTIVE)

    # Student A attempting to enroll Student B must fail with OutOfScopeError
    with pytest.raises(OutOfScopeError) as exc_info:
        await service._verify_operator_enrollment_scope(student_a_user, student_b_id)
    assert "not authorized to enroll face profile" in str(exc_info.value) or "only register" in str(exc_info.value)


@pytest.mark.asyncio
async def test_revoke_student_face_student_rejected():
    db = AsyncMock()
    service = BiometricService(db)

    student_id = uuid.uuid4()
    student_user = User(id=student_id, role=UserRole.STUDENT, account_status=AccountStatus.ACTIVE)
    payload = FaceRevocationRequest(
        student_user_id=student_id,
        revocation_reason="Student attempting self revocation",
    )

    # Even for their own profile, students are NOT permitted to revoke
    with pytest.raises(OutOfScopeError) as exc_info:
        await service.revoke_student_face(student_user, payload)
    assert "not authorized to revoke" in str(exc_info.value)


def test_configurable_provisional_thresholds():
    db = MagicMock()
    # Configure custom provisional thresholds
    service = BiometricService(db, min_samples=2, min_quality_score=0.60)

    b64_vec = create_base64_vector(512)
    payload = FaceEnrollmentRequest(
        student_user_id=uuid.uuid4(),
        active_model_version="EdgeFace-XS-v1",
        embedding_dimension=512,
        sample_count=2,  # Allowed under custom threshold
        embedding_base64=b64_vec,
        quality_score=0.65,  # Allowed under custom threshold
    )

    raw_bytes = service.validate_biometric_payload(payload)
    assert len(raw_bytes) == 512 * 4



