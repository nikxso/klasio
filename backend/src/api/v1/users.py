import base64
import os
from pathlib import Path
from typing import Optional
import uuid
import cv2
import numpy as np
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

    from src.services.biometric_service import BiometricService
    service = BiometricService(db)
    await service._verify_operator_enrollment_scope(current_user, target_user_id)


@router.get("/{user_id}/profile-photo", summary="Retrieve a user display profile photo")
@router.head("/{user_id}/profile-photo", summary="Check a user display profile photo")
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
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Profile photo not found",
            headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
        )
    return FileResponse(
        photo_path,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=60, must-revalidate"},
    )


def align_and_crop_portrait(img_bytes: bytes, target_size=(512, 512)) -> bytes:
    """
    Detects face and crops a square, centered, level portrait photo with natural headroom.
    Guarantees consistent 512x512 headshot alignment for student avatars.
    """
    nparr = np.frombuffer(img_bytes, np.uint8)
    img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if img is None:
        return img_bytes

    h, w, _ = img.shape
    yunet_path = Path("/home/dope/Documents/atten/mobile/src/lab/models/yunet_2023mar.onnx")

    faces = None
    if yunet_path.exists():
        try:
            detector = cv2.FaceDetectorYN_create(str(yunet_path), "", (w, h), score_threshold=0.4)
            detector.setInputSize((w, h))
            _, faces = detector.detect(img)
        except Exception:
            faces = None

    if faces is not None and len(faces) > 0:
        box = faces[0][:4]
        fx, fy, fw, fh = box
        face_size = max(fw, fh)
        crop_size = int(face_size * 1.85)
        cx = fx + fw / 2.0
        cy = fy + fh / 2.0 - (0.08 * face_size)
    else:
        # Fallback to centered square with upper headroom bias
        crop_size = min(w, h)
        cx = w / 2.0
        cy = min(h / 2.0, crop_size / 2.0 + (h - crop_size) * 0.25)

    x1 = int(round(cx - crop_size / 2.0))
    y1 = int(round(cy - crop_size / 2.0))
    x2 = x1 + crop_size
    y2 = y1 + crop_size

    pad_left = max(0, -x1)
    pad_top = max(0, -y1)
    pad_right = max(0, x2 - w)
    pad_bottom = max(0, y2 - h)

    if pad_left > 0 or pad_top > 0 or pad_right > 0 or pad_bottom > 0:
        img_padded = cv2.copyMakeBorder(img, pad_top, pad_bottom, pad_left, pad_right, cv2.BORDER_REFLECT_101)
        x1 += pad_left
        y1 += pad_top
        x2 += pad_left
        y2 += pad_top
        crop = img_padded[y1:y2, x1:x2]
    else:
        crop = img[y1:y2, x1:x2]

    resized = cv2.resize(crop, target_size, interpolation=cv2.INTER_AREA)
    _, encoded = cv2.imencode(".jpg", resized, [int(cv2.IMWRITE_JPEG_QUALITY), 92])
    return encoded.tobytes()


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

    contents = align_and_crop_portrait(contents)

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
