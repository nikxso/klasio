import base64
import os
from pathlib import Path
from typing import Optional
import uuid
from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select, and_
from sqlalchemy.ext.asyncio import AsyncSession

from src.core.exceptions import EntityNotFoundError, OutOfScopeError
from src.core.permissions import require_roles
from src.database import get_db_session
from src.models.academic import ClassSection
from src.models.assignment import TeachingAssignment
from src.models.enrollment import EnrollmentStatus, StudentEnrollment
from src.models.user import User, UserRole

router = APIRouter(prefix="/api/v1/users", tags=["User Profiles & Photos"])

UPLOAD_DIR = Path("/home/dope/Documents/atten/backend/uploads/profile_photos")
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


class ProfilePhotoBase64Request(BaseModel):
    photo_base64: str


async def verify_user_photo_scope(current_user: User, target_user_id: uuid.UUID, db: AsyncSession):
    if current_user.id == target_user_id or current_user.role == UserRole.ADMIN:
        return

    if current_user.role == UserRole.FACULTY:
        # Check if faculty teaches at least one section where student is actively enrolled
        enr_stmt = select(StudentEnrollment.class_section_id).where(
            and_(
                StudentEnrollment.student_user_id == target_user_id,
                StudentEnrollment.enrollment_status == EnrollmentStatus.ACTIVE,
            )
        )
        enr_res = await db.execute(enr_stmt)
        section_ids = set(enr_res.scalars().all())
        if section_ids:
            ta_stmt = select(TeachingAssignment.id).where(
                and_(
                    TeachingAssignment.faculty_user_id == current_user.id,
                    TeachingAssignment.is_active == True,
                    TeachingAssignment.class_section_id.in_(section_ids),
                )
            )
            ta_res = await db.execute(ta_stmt)
            if ta_res.scalars().first():
                return

    raise OutOfScopeError(f"User {current_user.id} is not authorized to access/modify photo for user {target_user_id}")


@router.get("/{user_id}/profile-photo", summary="Retrieve a user display profile photo")
async def get_profile_photo(
    user_id: uuid.UUID,
    db: AsyncSession = Depends(get_db_session),
):
    """
    Publicly/internally viewable display photograph.
    Separated strictly from biometric reference templates.
    """
    photo_path = UPLOAD_DIR / f"{user_id}.jpg"
    if not photo_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Profile photo not found")
    return FileResponse(photo_path, media_type="image/jpeg")


@router.post("/{user_id}/profile-photo", status_code=status.HTTP_200_OK, summary="Upload or replace user profile photo")
async def upload_profile_photo(
    user_id: uuid.UUID,
    request: Request,
    current_user: User = Depends(require_roles(UserRole.STUDENT, UserRole.FACULTY, UserRole.ADMIN)),
    db: AsyncSession = Depends(get_db_session),
):
    """
    Deliberate profile photo capture or upload.
    User themselves, authorized faculty teaching student, or Admin.
    Accepts multipart/form-data with 'file', or JSON with 'photo_base64'.
    """
    await verify_user_photo_scope(current_user, user_id, db)

    photo_path = UPLOAD_DIR / f"{user_id}.jpg"

    content_type = request.headers.get("content-type", "")
    if "multipart/form-data" in content_type:
        form = await request.form()
        uploaded_file = form.get("file")
        if not uploaded_file:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Missing 'file' field in multipart form")
        contents = await uploaded_file.read()
    else:
        try:
            body = await request.json()
            b64_str = body.get("photo_base64", "")
            if not b64_str:
                raise ValueError("Empty photo_base64")
            # Strip data url prefix if present
            if "," in b64_str:
                b64_str = b64_str.split(",", 1)[1]
            contents = base64.b64decode(b64_str)
        except Exception as e:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=f"Invalid photo payload: {str(e)}")

    if len(contents) == 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Uploaded photo is empty")

    with open(photo_path, "wb") as f:
        f.write(contents)

    return {
        "success": True,
        "user_id": str(user_id),
        "profile_photo_url": f"/api/v1/users/{user_id}/profile-photo",
        "file_size_bytes": len(contents),
    }


@router.delete("/{user_id}/profile-photo", status_code=status.HTTP_200_OK, summary="Remove user profile photo")
async def delete_profile_photo(
    user_id: uuid.UUID,
    current_user: User = Depends(require_roles(UserRole.STUDENT, UserRole.FACULTY, UserRole.ADMIN)),
    db: AsyncSession = Depends(get_db_session),
):
    """Remove user display photo (reverts to fallback avatar)."""
    await verify_user_photo_scope(current_user, user_id, db)
    photo_path = UPLOAD_DIR / f"{user_id}.jpg"
    if photo_path.exists():
        photo_path.unlink()
    return {"success": True, "user_id": str(user_id), "message": "Profile photo removed"}
