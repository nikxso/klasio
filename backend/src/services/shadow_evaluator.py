"""Observational Shadow Authorization Evaluator.

Runs the new Institutional Access Control v1 evaluator alongside legacy authorization
checks for observational comparison and telemetry, without altering endpoint decisions.

Guarantees:
- Observational only: Never changes the actual legacy authorization decision.
- Zero payload leakage: Does not record biometric embeddings, face templates, or passwords.
- Structured mismatch categorization: Distinguishes expected mismatches (e.g. unassigned legacy users)
  from unexpected configuration anomalies.
"""
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
import hashlib
import hmac
import logging
from typing import Any, Dict, List, Optional
import uuid

from sqlalchemy.ext.asyncio import AsyncSession
from src.services.authorization_evaluator import AuthorizationEvaluator, AuthorizationDecision

logger = logging.getLogger("klasio.auth.shadow")
_PSEUDONYM_KEY_WARNED = False


def derive_actor_pseudonym(actor_user_id: uuid.UUID) -> str:
    """Generate a privacy-hardened HMAC-SHA256 pseudonym.
    
    Uses dedicated SHADOW_PSEUDONYM_KEY if configured, or falls back to an ephemeral
    derived key from SECRET_KEY. Returns 32 hex characters (128-bit minimum entropy).
    Guarantees zero raw matriculation or employee ID leakage into telemetry.
    """
    global _PSEUDONYM_KEY_WARNED
    from src.config import get_settings
    settings = get_settings()

    if settings.SHADOW_PSEUDONYM_KEY:
        secret = settings.SHADOW_PSEUDONYM_KEY.encode("utf-8")
    else:
        if not _PSEUDONYM_KEY_WARNED:
            logger.warning(
                "[ShadowAuth] SHADOW_PSEUDONYM_KEY not set; using derived ephemeral key for telemetry"
            )
            _PSEUDONYM_KEY_WARNED = True
        secret = hashlib.sha256(f"shadow-ephemeral-{settings.SECRET_KEY}".encode("utf-8")).digest()

    return hmac.new(secret, str(actor_user_id).encode("utf-8"), hashlib.sha256).hexdigest()[:32]


@dataclass(frozen=True)
class ShadowObservation:
    actor_user_id: str
    actor_pseudonym: str  # Privacy-hardened HMAC-SHA256 pseudonym; no raw matriculation/employee ID
    institution_id: str
    permission_code: str
    resource_type: Optional[str]
    resource_id: Optional[str]
    target_resource_institution_id: Optional[str]
    legacy_allowed: bool
    new_allowed: bool
    matched: bool
    is_expected_mismatch: bool
    mismatch_category: Optional[str]  # e.g., "UNASSIGNED_LEGACY_USER", "NO_TENANT_CONTEXT", "NO_RESOURCE_CONTEXT", "RESOURCE_TENANT_MISMATCH"
    new_reason_code: str
    new_reason: str
    correlation_id: str
    timestamp: str

    @property
    def actor_institutional_id(self) -> str:
        """Backward-compatibility alias pointing to privacy-hardened pseudonym."""
        return self.actor_pseudonym


class ShadowAuthorizationEvaluator:
    """Non-intrusive shadow evaluator for zero-impact authorization telemetry."""

    def __init__(self, db: AsyncSession):
        self.db = db
        self.evaluator = AuthorizationEvaluator(db)
        # In-memory buffer for test inspection and metrics collection
        self._recent_observations: List[ShadowObservation] = []

    async def shadow_evaluate(
        self,
        legacy_allowed: bool,
        actor_user_id: uuid.UUID,
        permission_code: str,
        institution_id: uuid.UUID,
        actor_institutional_id: Optional[str] = None,
        resource_type: Optional[str] = None,
        resource_id: Optional[uuid.UUID] = None,
        target_resource_institution_id: Optional[uuid.UUID] = None,
        correlation_id: Optional[str] = None,
        clock_now: Optional[datetime] = None,
    ) -> ShadowObservation:
        """Execute shadow comparison without altering the legacy decision."""
        cid = correlation_id or f"shadow-{uuid.uuid4().hex[:12]}"
        now = clock_now or datetime.now(timezone.utc)

        # Immediate tenant check if authoritative resource institution was provided
        if target_resource_institution_id and target_resource_institution_id != institution_id:
            new_allowed = False
            new_code = "RESOURCE_TENANT_MISMATCH"
            new_reason = (
                f"Resource authoritative institution '{target_resource_institution_id}' "
                f"mismatches active actor context '{institution_id}'"
            )
        else:
            try:
                decision: AuthorizationDecision = await self.evaluator.evaluate(
                    actor_user_id=actor_user_id,
                    permission_code=permission_code,
                    institution_id=institution_id,
                    resource_type=resource_type,
                    resource_id=resource_id,
                    clock_now=now,
                )
                new_allowed = decision.allowed
                new_code = decision.reason_code
                new_reason = decision.reason
            except Exception:
                # Shadow evaluation MUST NEVER disrupt the application or log raw exception stack traces
                logger.error("[ShadowAuth] Error during shadow evaluation (correlation_id=%s)", cid)
                new_allowed = False
                new_code = "EVALUATOR_INTERNAL_ERROR"
                new_reason = "Internal evaluation error"

        matched = (legacy_allowed == new_allowed)

        # Categorize mismatches
        is_expected = False
        mismatch_cat = None

        if not matched:
            if legacy_allowed and not new_allowed:
                if new_code == "RESOURCE_TENANT_MISMATCH":
                    is_expected = True
                    mismatch_cat = "RESOURCE_TENANT_MISMATCH"
                elif new_code in ("PERMISSION_NOT_ASSIGNED", "MEMBERSHIP_NOT_FOUND"):
                    is_expected = True
                    mismatch_cat = "UNASSIGNED_LEGACY_USER"
                elif new_code == "SCOPE_MISMATCH":
                    is_expected = True
                    mismatch_cat = "LEGACY_OVERBROAD_PERMITTED"
                elif new_code in ("CROSS_INSTITUTION_RESOURCE", "MEMBERSHIP_INACTIVE", "USER_INACTIVE"):
                    is_expected = True
                    mismatch_cat = "LEGACY_CROSS_TENANT_LEAK_BLOCKED"
                else:
                    mismatch_cat = "UNEXPECTED_DENIAL"
            elif not legacy_allowed and new_allowed:
                mismatch_cat = "UNEXPECTED_GRANT"

        obs = ShadowObservation(
            actor_user_id=str(actor_user_id),
            actor_pseudonym=derive_actor_pseudonym(actor_user_id),
            institution_id=str(institution_id),
            permission_code=permission_code,
            resource_type=resource_type,
            resource_id=str(resource_id) if resource_id else None,
            target_resource_institution_id=str(target_resource_institution_id) if target_resource_institution_id else None,
            legacy_allowed=legacy_allowed,
            new_allowed=new_allowed,
            matched=matched,
            is_expected_mismatch=is_expected,
            mismatch_category=mismatch_cat,
            new_reason_code=new_code,
            new_reason=new_reason,
            correlation_id=cid,
            timestamp=now.isoformat(),
        )

        self._recent_observations.append(obs)
        if len(self._recent_observations) > 1000:
            self._recent_observations.pop(0)

        # Structured log (safe: zero biometric vectors, zero raw identifiers)
        logger.info(
            "[ShadowAuth] matched=%s legacy=%s new=%s cat=%s perm=%s cid=%s",
            matched,
            legacy_allowed,
            new_allowed,
            mismatch_cat or "MATCH",
            permission_code,
            cid,
        )

        return obs

    def record_skipped_evaluation(
        self,
        actor_user_id: uuid.UUID,
        skip_reason: str,
        legacy_allowed: bool,
        correlation_id: Optional[str] = None,
        institution_id: Optional[uuid.UUID] = None,
        permission_code: Optional[str] = None,
        resource_type: Optional[str] = None,
        resource_id: Optional[uuid.UUID] = None,
        target_resource_institution_id: Optional[uuid.UUID] = None,
    ) -> ShadowObservation:
        """Record a structured skipped shadow observation when tenant or resource context cannot be determined reliably."""
        cid = correlation_id or f"shadow-skip-{uuid.uuid4().hex[:12]}"
        now = datetime.now(timezone.utc)
        obs = ShadowObservation(
            actor_user_id=str(actor_user_id),
            actor_pseudonym=derive_actor_pseudonym(actor_user_id),
            institution_id=str(institution_id) if institution_id else "UNRESOLVED",
            permission_code=permission_code or "SKIPPED",
            resource_type=resource_type,
            resource_id=str(resource_id) if resource_id else None,
            target_resource_institution_id=str(target_resource_institution_id) if target_resource_institution_id else None,
            legacy_allowed=legacy_allowed,
            new_allowed=False,
            matched=False,
            is_expected_mismatch=True,
            mismatch_category=skip_reason,
            new_reason_code=skip_reason,
            new_reason=f"Shadow evaluation skipped: {skip_reason}",
            correlation_id=cid,
            timestamp=now.isoformat(),
        )
        self._recent_observations.append(obs)
        if len(self._recent_observations) > 1000:
            self._recent_observations.pop(0)

        logger.info(
            "[ShadowAuth] Skipped shadow evaluation: reason=%s cid=%s",
            skip_reason,
            cid,
        )
        return obs

    def get_recent_observations(self) -> List[ShadowObservation]:
        """Return shallow copy of recorded shadow observations."""
        return list(self._recent_observations)

    def clear_observations(self) -> None:
        """Clear recorded observations buffer."""
        self._recent_observations.clear()
