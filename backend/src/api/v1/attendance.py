from typing import List, Optional, Union
import uuid
from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.permissions import require_faculty_or_admin
from src.database import get_db_session
from src.models.user import User
from src.schemas.attendance import (
    BatchSyncRequest,
    BatchSyncResponse,
    BatchSyncResultItem,
    SubmitAttendanceSessionRequest,
    SyncResultStatus,
)
from src.schemas.audit import AmendmentAuditResponse, SubmitAmendmentRequest
from src.schemas.request import (
    ResolveAttendanceRequest,
    StudentAttendanceRequestResponse,
)
from src.services.amendment_service import AmendmentService
from src.services.attendance_service import AttendanceService
from src.services.request_service import RequestService

router = APIRouter(prefix="/api/v1/attendance", tags=["Attendance Synchronization"])


@router.post(
    "/sessions/sync",
    response_model=BatchSyncResponse,
    status_code=status.HTTP_200_OK,
    summary="Idempotently synchronize finalized attendance sessions",
)
async def sync_attendance_sessions(
    payload: Union[BatchSyncRequest, SubmitAttendanceSessionRequest],
    response: Response,
    current_user: User = Depends(require_faculty_or_admin),
    db: AsyncSession = Depends(get_db_session),
):
    """
    Synchronize finalized attendance sessions from mobile offline SQLite storage.
    Supports single session payloads or batch session payloads.
    Guarantees exactly-once logical persistence under retried synchronization via
    client_session_uuid and canonical payload hash verification.
    Enforces privacy boundary: zero raw classroom images, face crops, or biometric embedding
    vectors are accepted; candidate confidence is preserved strictly as derived recognition metadata.
    """
    service = AttendanceService(db)

    # 1. Handle Single Session Payload
    if isinstance(payload, SubmitAttendanceSessionRequest):
        result = await service.sync_session(current_user, payload)

        if result.status == SyncResultStatus.SYNCED:
            response.status_code = status.HTTP_201_CREATED
            return BatchSyncResponse(results=[result])

        elif result.status == SyncResultStatus.ALREADY_SYNCED:
            response.status_code = status.HTTP_200_OK
            return BatchSyncResponse(results=[result])

        elif result.status == SyncResultStatus.CONFLICT:
            return JSONResponse(
                status_code=status.HTTP_409_CONFLICT,
                content={
                    "error": "CONFLICT",
                    "status": "CONFLICT",
                    "client_session_uuid": str(result.client_session_uuid),
                    "message": result.error_message,
                    "results": [result.model_dump(mode="json")],
                },
            )

        elif result.status == SyncResultStatus.REJECTED:
            err_msg = result.error_message or "Validation rejected"
            status_code = (
                status.HTTP_403_FORBIDDEN
                if "Authorization" in err_msg or "not authorized" in err_msg
                else status.HTTP_400_BAD_REQUEST
            )
            return JSONResponse(
                status_code=status_code,
                content={
                    "error": "VALIDATION_FAILED",
                    "status": "REJECTED",
                    "client_session_uuid": str(result.client_session_uuid),
                    "message": err_msg,
                    "results": [result.model_dump(mode="json")],
                },
            )

    # 2. Handle Batch Sync Payload
    batch_response = await service.sync_batch(current_user, payload)

    # If all new sessions were created, return 201 Created
    if all(r.status == SyncResultStatus.SYNCED for r in batch_response.results):
        response.status_code = status.HTTP_201_CREATED

    return batch_response


@router.post(
    "/sessions",
    response_model=BatchSyncResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Submit and finalize an attendance session",
)
async def submit_attendance_session(
    payload: SubmitAttendanceSessionRequest,
    response: Response,
    current_user: User = Depends(require_faculty_or_admin),
    db: AsyncSession = Depends(get_db_session),
):
    """
    Submit and finalize a single attendance session.
    Direct REST endpoint matching quickstart.md and tasks.md T059 specification.
    """
    return await sync_attendance_sessions(payload, response, current_user, db)



@router.post(
    "/sessions/{session_id}/amendments",
    response_model=AmendmentAuditResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Amend attendance record for an enrolled student (audited)",
)
async def amend_attendance_session_record(
    session_id: uuid.UUID,
    payload: SubmitAmendmentRequest,
    response: Response,
    current_user: User = Depends(require_faculty_or_admin),
    db: AsyncSession = Depends(get_db_session),
):
    """
    Amend an attendance record post-finalization.
    Assigned regular faculty may amend within the institution-configurable correction window (default 7 days).
    Substitute faculty are strictly excluded from post-finalization amendments.
    Institutional Administrators can perform override amendments inside or outside the correction window.
    Generates an immutable audit trail entry with previous and new status and mandatory reason.
    Supports client_amendment_id for idempotent retry (HTTP 200) and expected_previous_status for concurrency.
    """
    service = AmendmentService(db)
    audit = await service.amend_attendance_record(
        session_id=session_id,
        student_user_id=payload.student_user_id,
        new_status=payload.new_status,
        amendment_reason=payload.amendment_reason,
        current_user=current_user,
        client_amendment_id=payload.client_amendment_id,
        expected_previous_status=payload.expected_previous_status,
    )
    if getattr(audit, "is_already_synced", False):
        response.status_code = status.HTTP_200_OK
    else:
        response.status_code = status.HTTP_201_CREATED

    return AmendmentAuditResponse.from_audit(audit)


@router.get(
    "/sessions/{session_id}/amendments",
    response_model=List[AmendmentAuditResponse],
    status_code=status.HTTP_200_OK,
    summary="Retrieve immutable amendment audit history for an attendance session",
)
async def get_session_amendment_history(
    session_id: uuid.UUID,
    current_user: User = Depends(require_faculty_or_admin),
    db: AsyncSession = Depends(get_db_session),
):
    """
    Retrieve the chronological list of immutable amendment audit rows for a given attendance session.
    """
    service = AmendmentService(db)
    audits = await service.get_session_amendments(session_id)
    return [AmendmentAuditResponse.from_audit(a) for a in audits]


@router.get(
    "/requests",
    response_model=List[StudentAttendanceRequestResponse],
    status_code=status.HTTP_200_OK,
    summary="List student attendance grievance requests for review",
)
async def list_reviewable_attendance_requests(
    teaching_assignment_id: Optional[uuid.UUID] = None,
    current_user: User = Depends(require_faculty_or_admin),
    db: AsyncSession = Depends(get_db_session),
):
    service = RequestService(db)
    return await service.list_reviewer_requests(current_user, teaching_assignment_id)


@router.patch(
    "/requests/{request_id}",
    response_model=StudentAttendanceRequestResponse,
    status_code=status.HTTP_200_OK,
    summary="Resolve student attendance grievance request (APPROVED or REJECTED)",
)
async def resolve_attendance_request(
    request_id: uuid.UUID,
    payload: ResolveAttendanceRequest,
    current_user: User = Depends(require_faculty_or_admin),
    db: AsyncSession = Depends(get_db_session),
):
    service = RequestService(db)
    return await service.resolve_request(current_user, request_id, payload)

