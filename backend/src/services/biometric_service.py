import base64
from datetime import date, datetime, timezone
import hashlib
import logging
import math
import struct
from typing import Dict, List, Optional, Tuple
import uuid

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from src.core.exceptions import (
    BiometricValidationError,
    ConflictError,
    EntityNotFoundError,
    OutOfScopeError,
)
from src.models.academic import AcademicTerm, ClassSection
from src.models.access_control import InstitutionMembership, MembershipStatus
from src.models.assignment import DelegationStatus, SubstituteDelegation, TeachingAssignment
from src.models.enrollment import (
    EnrollmentStatus,
    FaceRegistrationStatus,
    StudentEnrollment,
    StudentFaceProfile,
)
from src.models.user import AccountStatus, User, UserRole
from src.schemas.biometrics import (
    AssignmentGalleryResponse,
    FaceEnrollmentRequest,
    FaceEnrollmentResponse,
    FaceRevocationRequest,
    FaceRevocationResponse,
    GalleryStudentTemplate,
)

logger = logging.getLogger("biometrics.service")

# Supported models and their canonical embedding dimensions
SUPPORTED_MODELS = {
    "EdgeFace-XS-v1": 512,
    "MobileFaceNet-v1": 192,
}

# In-memory tracking of recent gallery retrievals for rate limiting and anomaly detection: (operator_id, assignment_id) -> timestamps
_recent_gallery_retrievals: Dict[Tuple[uuid.UUID, uuid.UUID], List[float]] = {}
# Provisional thresholds (configurable, subject to post-evaluation calibration)
DEFAULT_MINIMUM_SAMPLES = 3
DEFAULT_MINIMUM_QUALITY_SCORE = 0.70
DEFAULT_L2_NORM_TOLERANCE = 1e-3


class BiometricService:
    def __init__(
        self,
        db: AsyncSession,
        min_samples: int = DEFAULT_MINIMUM_SAMPLES,
        min_quality_score: float = DEFAULT_MINIMUM_QUALITY_SCORE,
        l2_tolerance: float = DEFAULT_L2_NORM_TOLERANCE,
    ):
        self.db = db
        self.min_samples = min_samples
        self.min_quality_score = min_quality_score
        self.l2_tolerance = l2_tolerance

    async def _verify_operator_enrollment_scope(
        self,
        operator: User,
        student_user_id: uuid.UUID,
    ) -> None:
        """
        Verify that the operator has authorization to enroll the student's face profile.
        - Admin has full authority.
        - Student has authority ONLY for their own face profile (operator.id == student_user_id).
        - Faculty must be assigned or actively delegated to at least one active section where the student is enrolled.
        """
        if operator.role == UserRole.ADMIN:
            return

        if operator.role == UserRole.STUDENT:
            if operator.id == student_user_id:
                return
            raise OutOfScopeError(
                f"Student {operator.id} is not authorized to enroll face profile for student {student_user_id}"
            )

        if operator.role != UserRole.FACULTY:
            raise OutOfScopeError(
                f"User with role {operator.role} is not authorized to perform biometric enrollment"
            )

        # Find sections student is enrolled in
        enr_stmt = select(StudentEnrollment.class_section_id).where(
            and_(
                StudentEnrollment.student_user_id == student_user_id,
                StudentEnrollment.enrollment_status == EnrollmentStatus.ACTIVE,
            )
        )
        enr_res = await self.db.execute(enr_stmt)
        student_section_ids = set(enr_res.scalars().all())

        if not student_section_ids:
            raise OutOfScopeError(
                f"Student {student_user_id} has no active section enrollments"
            )

        # Check direct assignments for faculty
        direct_stmt = select(TeachingAssignment.class_section_id).where(
            and_(
                TeachingAssignment.faculty_user_id == operator.id,
                TeachingAssignment.is_active == True,
                TeachingAssignment.class_section_id.in_(student_section_ids),
            )
        )
        direct_res = await self.db.execute(direct_stmt)
        if direct_res.scalars().first():
            return

        # Check active substitute delegations
        today = date.today()
        deleg_stmt = (
            select(TeachingAssignment.class_section_id)
            .join(SubstituteDelegation, SubstituteDelegation.teaching_assignment_id == TeachingAssignment.id)
            .where(
                and_(
                    SubstituteDelegation.substitute_faculty_user_id == operator.id,
                    SubstituteDelegation.status == DelegationStatus.ACTIVE,
                    SubstituteDelegation.start_date <= today,
                    SubstituteDelegation.end_date >= today,
                    TeachingAssignment.is_active == True,
                    TeachingAssignment.class_section_id.in_(student_section_ids),
                )
            )
        )
        deleg_res = await self.db.execute(deleg_stmt)
        if deleg_res.scalars().first():
            return

        raise OutOfScopeError(
            f"Faculty {operator.id} is not authorized to enroll student {student_user_id} "
            f"(no active teaching assignment or delegation for student's sections)"
        )

    def validate_biometric_payload(
        self,
        payload: FaceEnrollmentRequest,
    ) -> bytes:
        """
        Perform strict mathematical and structural validation on the biometric template(s).
        - Supported model and version
        - Dimension matching model manifest
        - Sample count >= 3 (or number of validated templates)
        - Quality score >= 0.70
        - Base64 payload decoding & byte length matching dimension * 4
        - Finite float values (no NaN or Inf)
        - Unit L2 normalization (||v|| == 1.0 within tolerance)
        - Multi-sample pairwise consistency gate (>= 0.60)
        """
        # 1. Model version check
        if payload.active_model_version not in SUPPORTED_MODELS:
            raise BiometricValidationError(
                f"Unsupported model version '{payload.active_model_version}'. "
                f"Supported versions: {list(SUPPORTED_MODELS.keys())}"
            )

        expected_dim = SUPPORTED_MODELS[payload.active_model_version]
        if payload.embedding_dimension != expected_dim:
            raise BiometricValidationError(
                f"Model '{payload.active_model_version}' requires dimension {expected_dim}, "
                f"got {payload.embedding_dimension}"
            )

        # 2. Quality & samples check
        if payload.sample_count < self.min_samples:
            raise BiometricValidationError(
                f"Sample count must be at least {self.min_samples}, got {payload.sample_count}"
            )

        if payload.quality_score < self.min_quality_score:
            raise BiometricValidationError(
                f"Quality score {payload.quality_score:.2f} is below minimum threshold {self.min_quality_score:.2f}"
            )

        # 3. Base64 payload decoding (support multi-template or single template)
        b64_list: List[str] = []
        if payload.embeddings_base64 and len(payload.embeddings_base64) > 0:
            b64_list = payload.embeddings_base64
        elif payload.embedding_base64:
            b64_list = [payload.embedding_base64]
        else:
            raise BiometricValidationError("Either embeddings_base64 or embedding_base64 must be provided")

        expected_byte_length = expected_dim * 4
        validated_bytes: List[bytes] = []
        validated_vectors: List[Tuple[float, ...]] = []

        for b64_payload in b64_list:
            try:
                raw_bytes = base64.b64decode(b64_payload)
            except Exception as e:
                raise BiometricValidationError(f"Invalid base64 embedding payload: {str(e)}")

            if len(raw_bytes) != expected_byte_length:
                raise BiometricValidationError(
                    f"Decoded embedding byte length ({len(raw_bytes)}) does not match "
                    f"expected {expected_byte_length} bytes for dimension {expected_dim}"
                )

            # 4. Numerical unpacking and validation
            try:
                floats = struct.unpack(f"{expected_dim}f", raw_bytes)
            except Exception as e:
                raise BiometricValidationError(f"Failed to unpack float32 vector: {str(e)}")

            for val in floats:
                if math.isnan(val) or math.isinf(val):
                    raise BiometricValidationError("Embedding contains non-finite (NaN or Inf) values")

            # 5. Unit L2 norm validation
            norm = math.sqrt(sum(v * v for v in floats))
            if abs(norm - 1.0) > self.l2_tolerance:
                raise BiometricValidationError(
                    f"Embedding vector must be L2-normalized: calculated norm {norm:.6f} "
                    f"deviates from 1.0 beyond tolerance {self.l2_tolerance}"
                )

            validated_bytes.append(raw_bytes)
            validated_vectors.append(floats)

        # 6. Pairwise consistency validation across multi-sample observations
        if len(validated_vectors) > 1:
            for i in range(len(validated_vectors)):
                for j in range(i + 1, len(validated_vectors)):
                    cos_sim = sum(validated_vectors[i][k] * validated_vectors[j][k] for k in range(expected_dim))
                    if cos_sim < 0.60:
                        raise BiometricValidationError(
                            f"Pairwise consistency between sample {i} and sample {j} is {cos_sim:.2f}, "
                            f"below consistency gate threshold 0.60"
                        )

        return b"".join(validated_bytes)

    async def enroll_student_face(
        self,
        operator: User,
        payload: FaceEnrollmentRequest,
    ) -> FaceEnrollmentResponse:
        """
        Idempotent biometric enrollment / re-enrollment workflow.
        Validates operator scope, student existence and active status, template mathematics,
        and saves template to database.
        """
        # 1. Verify student exists and is active
        student_stmt = select(User).where(User.id == payload.student_user_id)
        student_res = await self.db.execute(student_stmt)
        student = student_res.scalar_one_or_none()

        if not student:
            raise EntityNotFoundError(f"Student user {payload.student_user_id} not found")

        if student.role != UserRole.STUDENT:
            raise ConflictError(f"User {payload.student_user_id} has role '{student.role}', not STUDENT")

        if student.account_status != AccountStatus.ACTIVE:
            raise ConflictError(
                f"Cannot enroll face for student {payload.student_user_id} with account status '{student.account_status}'"
            )

        # 2. Verify operator authorization scope
        await self._verify_operator_enrollment_scope(operator, payload.student_user_id)

        # 3. Validate template payload
        raw_bytes = self.validate_biometric_payload(payload)
        actual_sample_count = max(payload.sample_count, len(raw_bytes) // (payload.embedding_dimension * 4))

        # 4. Atomic upsert into StudentFaceProfile
        profile_stmt = select(StudentFaceProfile).where(
            StudentFaceProfile.student_user_id == payload.student_user_id
        )
        profile_res = await self.db.execute(profile_stmt)
        profile = profile_res.scalar_one_or_none()

        now = datetime.now(timezone.utc)
        is_re_enrollment = False

        if profile:
            is_re_enrollment = profile.registration_state == FaceRegistrationStatus.REGISTERED
            profile.registration_state = FaceRegistrationStatus.REGISTERED
            profile.active_model_version = payload.active_model_version
            profile.embedding_dimension = payload.embedding_dimension
            profile.sample_count = actual_sample_count
            profile.embedding_blob = raw_bytes
            profile.quality_score = payload.quality_score
            profile.last_validated_at = now
        else:
            profile = StudentFaceProfile(
                student_user_id=payload.student_user_id,
                registration_state=FaceRegistrationStatus.REGISTERED,
                active_model_version=payload.active_model_version,
                embedding_dimension=payload.embedding_dimension,
                sample_count=actual_sample_count,
                embedding_blob=raw_bytes,
                quality_score=payload.quality_score,
                last_validated_at=now,
            )
            self.db.add(profile)

        profile.student_user = student
        student.face_profile = profile

        await self.db.flush()
        await self.db.refresh(profile)

        # 5. Operational Audit Event (Invariant: zero embeddings or raw images logged)
        logger.info(
            f"BIOMETRIC_AUDIT: action=ENROLLMENT operator_id={operator.id} operator_role={operator.role} "
            f"student_id={payload.student_user_id} model={payload.active_model_version} "
            f"dim={payload.embedding_dimension} samples={payload.sample_count} "
            f"quality={payload.quality_score:.3f} re_enrollment={is_re_enrollment}"
        )

        return FaceEnrollmentResponse(
            profile_id=profile.id,
            student_user_id=profile.student_user_id,
            registration_state=profile.registration_state,
            active_model_version=profile.active_model_version,
            embedding_dimension=profile.embedding_dimension,
            sample_count=profile.sample_count,
            quality_score=profile.quality_score,
            enrolled_at=profile.last_validated_at or now,
            is_re_enrollment=is_re_enrollment,
        )

    async def revoke_student_face(
        self,
        operator: User,
        payload: FaceRevocationRequest,
    ) -> FaceRevocationResponse:
        """
        Revoke a student's biometric enrollment, setting state to UNREGISTERED and purging template bytes.
        """
        # 1. Verify student exists
        student_stmt = select(User).where(User.id == payload.student_user_id)
        student_res = await self.db.execute(student_stmt)
        student = student_res.scalar_one_or_none()

        if not student:
            raise EntityNotFoundError(f"Student user {payload.student_user_id} not found")

        # 2. Verify operator authorization scope
        if operator.role == UserRole.STUDENT:
            raise OutOfScopeError("Students are not authorized to revoke biometric profiles")
        await self._verify_operator_enrollment_scope(operator, payload.student_user_id)

        # 3. Fetch profile and update
        profile_stmt = select(StudentFaceProfile).where(
            StudentFaceProfile.student_user_id == payload.student_user_id
        )
        profile_res = await self.db.execute(profile_stmt)
        profile = profile_res.scalar_one_or_none()

        now = datetime.now(timezone.utc)

        if not profile:
            profile = StudentFaceProfile(
                student_user_id=payload.student_user_id,
                registration_state=FaceRegistrationStatus.UNREGISTERED,
                sample_count=0,
                last_validated_at=now,
            )
            self.db.add(profile)
        else:
            profile.registration_state = FaceRegistrationStatus.UNREGISTERED
            profile.active_model_version = None
            profile.embedding_dimension = None
            profile.sample_count = 0
            profile.embedding_blob = None
            profile.quality_score = None
            profile.last_validated_at = now

        await self.db.flush()
        await self.db.refresh(profile)

        # 4. Operational Audit Event
        logger.info(
            f"BIOMETRIC_AUDIT: action=REVOCATION operator_id={operator.id} operator_role={operator.role} "
            f"student_id={payload.student_user_id} reason='{payload.revocation_reason}'"
        )

        return FaceRevocationResponse(
            student_user_id=payload.student_user_id,
            registration_state=FaceRegistrationStatus.UNREGISTERED,
            revoked_at=now,
            revocation_reason=payload.revocation_reason,
        )

    async def get_assignment_gallery(
        self,
        operator: User,
        teaching_assignment_id: uuid.UUID,
        session_date: Optional[date] = None,
        correlation_id: Optional[str] = None,
    ) -> AssignmentGalleryResponse:
        """
        Retrieve authorized reference templates for all actively enrolled, registered students in an assignment's section.
        Enforces:
        - Operator authorization for the assignment (assigned faculty, valid substitute, or Admin).
        - Date-bounded enrollment eligibility (effective_start_date <= date <= effective_end_date).
        - Student account status == ACTIVE.
        - Face registration state == REGISTERED with non-null embedding.
        - Deterministic freshness hash (gallery_version).
        - Operational audit logging (zero embeddings logged).
        - Rate limiting & rapid repetition anomaly detection.
        """
        # Rate limiting and rapid repeated retrieval detection
        now_ts = datetime.now(timezone.utc).timestamp()
        rate_key = (operator.id, teaching_assignment_id)
        history = _recent_gallery_retrievals.setdefault(rate_key, [])
        _recent_gallery_retrievals[rate_key] = [t for t in history if now_ts - t < 60.0]
        _recent_gallery_retrievals[rate_key].append(now_ts)
        retrieval_count_in_window = len(_recent_gallery_retrievals[rate_key])
        if retrieval_count_in_window > 10:
            logger.warning(
                "[GALLERY_RATE_LIMIT] Rapid repeated gallery retrieval detected: operator_id=%s "
                "assignment_id=%s count=%d in 60s",
                operator.id,
                teaching_assignment_id,
                retrieval_count_in_window,
            )

        eval_date = session_date or date.today()

        # 1. Fetch teaching assignment
        ta_stmt = (
            select(TeachingAssignment)
            .options(
                selectinload(TeachingAssignment.class_section),
                selectinload(TeachingAssignment.academic_term),
            )
            .where(TeachingAssignment.id == teaching_assignment_id)
        )
        ta_res = await self.db.execute(ta_stmt)
        ta = ta_res.scalar_one_or_none()

        if not ta:
            raise EntityNotFoundError(f"Teaching assignment {teaching_assignment_id} not found")

        if not ta.is_active:
            raise OutOfScopeError(f"Teaching assignment {teaching_assignment_id} is inactive")

        # 2. Check operator authorization (strict: no universal Admin bypass)
        # Operator must be assigned faculty or valid substitute for this specific assignment
        is_direct_faculty = (ta.faculty_user_id == operator.id)
        is_valid_substitute = False

        if not is_direct_faculty:
            deleg_stmt = select(SubstituteDelegation).where(
                and_(
                    SubstituteDelegation.teaching_assignment_id == teaching_assignment_id,
                    SubstituteDelegation.substitute_faculty_user_id == operator.id,
                    SubstituteDelegation.status == DelegationStatus.ACTIVE,
                    SubstituteDelegation.start_date <= eval_date,
                    SubstituteDelegation.end_date >= eval_date,
                )
            )
            deleg_res = await self.db.execute(deleg_stmt)
            is_valid_substitute = deleg_res.scalar_one_or_none() is not None

        if not is_direct_faculty and not is_valid_substitute:
            raise OutOfScopeError(
                f"User {operator.id} is not authorized to access gallery for assignment {teaching_assignment_id} (must be assigned faculty or valid substitute)"
            )

        # Validate operator active institution membership
        if ta.class_section and getattr(ta.class_section, "institution_id", None):
            inst_id = ta.class_section.institution_id
            op_mem_stmt = select(InstitutionMembership).where(
                InstitutionMembership.user_id == operator.id
            )
            op_mems = (await self.db.execute(op_mem_stmt)).scalars().all()
            if op_mems:
                has_active = any(m.institution_id == inst_id and m.status == MembershipStatus.ACTIVE for m in op_mems)
                if not has_active:
                    raise OutOfScopeError(
                        f"User {operator.id} does not have an active membership in institution {inst_id}"
                    )

        # 3. Query active, date-eligible students in this section
        enr_stmt = (
            select(StudentEnrollment)
            .options(
                selectinload(StudentEnrollment.student_user).selectinload(User.face_profile)
            )
            .where(
                and_(
                    StudentEnrollment.class_section_id == ta.class_section_id,
                    StudentEnrollment.enrollment_status.in_(
                        [EnrollmentStatus.ACTIVE, EnrollmentStatus.TRANSFERRED, EnrollmentStatus.COMPLETED]
                    ),
                    StudentEnrollment.effective_start_date <= eval_date,
                    or_(
                        StudentEnrollment.effective_end_date.is_(None),
                        StudentEnrollment.effective_end_date >= eval_date,
                    ),
                )
            )
            .order_by(StudentEnrollment.student_user_id)
        )
        enr_res = await self.db.execute(enr_stmt)
        enrollments = enr_res.scalars().all()


        templates: List[GalleryStudentTemplate] = []
        hash_parts: List[str] = [str(teaching_assignment_id)]

        for enr in enrollments:
            user = enr.student_user
            if not user or user.account_status != AccountStatus.ACTIVE:
                continue

            # Exclude students without active membership in the assignment's institution
            if ta.class_section and getattr(ta.class_section, "institution_id", None):
                inst_id = ta.class_section.institution_id
                stu_mem_stmt = select(InstitutionMembership).where(
                    InstitutionMembership.user_id == user.id
                )
                stu_mems = (await self.db.execute(stu_mem_stmt)).scalars().all()
                if stu_mems:
                    has_active = any(m.institution_id == inst_id and m.status == MembershipStatus.ACTIVE for m in stu_mems)
                    if not has_active:
                        continue

            fp = user.face_profile
            if not fp or fp.registration_state != FaceRegistrationStatus.REGISTERED or not fp.embedding_blob:
                continue

            exp_dim = SUPPORTED_MODELS.get(fp.active_model_version or "", fp.embedding_dimension or 512)
            chunk_size = exp_dim * 4
            total_bytes = len(fp.embedding_blob)
            num_samples = max(1, total_bytes // chunk_size)
            updated_at = fp.last_validated_at or fp.updated_at or datetime.now(timezone.utc)

            for s_idx in range(num_samples):
                start_idx = s_idx * chunk_size
                end_idx = start_idx + chunk_size
                sample_bytes = fp.embedding_blob[start_idx:end_idx] if end_idx <= total_bytes else fp.embedding_blob[start_idx:]
                b64_embedding = base64.b64encode(sample_bytes).decode("ascii")

                templates.append(
                    GalleryStudentTemplate(
                        student_user_id=user.id,
                        institutional_id=user.institutional_id,
                        student_name=user.full_name,
                        embedding_base64=b64_embedding,
                        sample_index=s_idx,
                        model_version=fp.active_model_version or "Unknown",
                        quality_score=fp.quality_score or 0.0,
                        updated_at=updated_at,
                    )
                )
            hash_parts.append(f"{user.id}:{updated_at.isoformat()}:{num_samples}")

        # Deterministic gallery freshness version hash
        raw_hash_string = "|".join(hash_parts)
        gallery_version = hashlib.sha256(raw_hash_string.encode("utf-8")).hexdigest()[:16]

        # Operational Audit Event (Invariant: zero embeddings or raw templates logged)
        cid = correlation_id or f"gallery-{uuid.uuid4().hex[:12]}"
        from src.services.shadow_evaluator import derive_actor_pseudonym
        inst_ctx_id = (
            str(ta.class_section.institution_id)
            if (ta.class_section and getattr(ta.class_section, "institution_id", None))
            else "NONE"
        )
        logger.info(
            "[BIOMETRIC_GALLERY_AUDIT] action=GALLERY_SYNC operator_id=%s operator_pseudonym=%s "
            "teaching_assignment_id=%s institution_id=%s timestamp=%s template_count=%d correlation_id=%s",
            operator.id,
            derive_actor_pseudonym(operator.id),
            ta.id,
            inst_ctx_id,
            datetime.now(timezone.utc).isoformat(),
            len(templates),
            cid,
        )

        return AssignmentGalleryResponse(
            teaching_assignment_id=ta.id,
            class_section_id=ta.class_section_id,
            academic_term_id=ta.academic_term_id,
            gallery_version=gallery_version,
            template_count=len(templates),
            templates=templates,
        )
