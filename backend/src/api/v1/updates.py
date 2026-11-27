import os
import json
import uuid
import mimetypes
import zipfile
import shutil
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional

from fastapi import (
    APIRouter,
    Request,
    Response,
    Header,
    HTTPException,
    UploadFile,
    File,
    Depends,
    status,
)
from fastapi.responses import JSONResponse, FileResponse
from src.core.permissions import get_current_user
from src.models.user import User, UserRole

router = APIRouter(
    prefix="/api/v1/updates",
    tags=["Over-The-Air (OTA) Updates"],
    include_in_schema=False,
)

# Determine updates root directory
UPDATES_DIR = Path(
    os.getenv(
        "UPDATES_DIR",
        str(Path(__file__).resolve().parent.parent.parent / "static" / "updates"),
    )
)
try:
    UPDATES_DIR.mkdir(parents=True, exist_ok=True)
except (PermissionError, OSError):
    UPDATES_DIR = Path("/tmp/updates")
    UPDATES_DIR.mkdir(parents=True, exist_ok=True)


def get_updates_base_url(request: Request) -> str:
    """Derive external public URL from incoming request, honoring reverse proxy headers."""
    base_url = str(request.base_url).rstrip("/")
    proto = request.headers.get("x-forwarded-proto", "")
    if proto.lower() == "https" and base_url.startswith("http://"):
        base_url = base_url.replace("http://", "https://", 1)
    return base_url


def resolve_platform_and_metadata(platform_header: Optional[str]) -> tuple[dict, str]:
    """Load metadata.json and return platform-specific metadata dictionary."""
    metadata_file = UPDATES_DIR / "metadata.json"
    if not metadata_file.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No updates have been published to this server yet. metadata.json is missing.",
        )
    try:
        with open(metadata_file, "r", encoding="utf-8") as f:
            meta = json.load(f)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Corrupted metadata.json: {str(e)}",
        )

    platform = (platform_header or "android").lower()
    file_metadata = meta.get("fileMetadata", {})
    if platform not in file_metadata:
        # Fallback to android if requested platform is not specifically found
        if "android" in file_metadata:
            platform = "android"
        else:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail=f"No bundle available for platform '{platform}'.",
            )
    return file_metadata[platform], platform


@router.get("/manifest")
async def get_update_manifest(
    request: Request,
    expo_platform: Optional[str] = Header(None, alias="expo-platform"),
    expo_runtime_version: Optional[str] = Header(None, alias="expo-runtime-version"),
    expo_protocol_version: Optional[str] = Header("0", alias="expo-protocol-version"),
    expo_current_update_id: Optional[str] = Header(None, alias="expo-current-update-id"),
    expo_embedded_update_id: Optional[str] = Header(None, alias="expo-embedded-update-id"),
):
    """
    Expo Updates Protocol v0 compliant manifest endpoint.
    Mobile app queries this endpoint on launch to detect and download Over-The-Air updates.
    Returns HTTP 204 No Content when the client is already running or contains the latest update.
    """
    platform_data, platform = resolve_platform_and_metadata(expo_platform)
    bundle_rel_path = platform_data.get("bundle")
    if not bundle_rel_path:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No bundle configured in metadata.json",
        )

    bundle_file = UPDATES_DIR / bundle_rel_path
    if not bundle_file.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Bundle file not found at {bundle_rel_path}",
        )

    # Derive deterministic update ID from bundle relative path
    update_id = str(uuid.uuid5(uuid.NAMESPACE_URL, f"klasio-ota-{bundle_rel_path}"))
    runtime_version = expo_runtime_version or "1.0.0"

    # Invariant: If client already runs or embeds this update, send 204 No Content
    def _normalize_id(val: Optional[str]) -> Optional[str]:
        return val.strip().strip('"').strip("'").lower() if val else None

    norm_target = _normalize_id(update_id)
    if (_normalize_id(expo_current_update_id) == norm_target or 
        _normalize_id(expo_embedded_update_id) == norm_target):
        return Response(
            status_code=status.HTTP_204_NO_CONTENT,
            headers={
                "expo-protocol-version": "0",
                "cache-control": "no-cache",
            },
        )

    if_none_match = request.headers.get("if-none-match")
    if if_none_match and _normalize_id(if_none_match) == norm_target:
        return Response(
            status_code=status.HTTP_304_NOT_MODIFIED,
            headers={
                "expo-protocol-version": "0",
                "cache-control": "no-cache",
            },
        )

    base_url = get_updates_base_url(request)
    bundle_filename = bundle_file.name

    launch_asset = {
        "key": bundle_filename,
        "contentType": "application/javascript",
        "url": f"{base_url}/api/v1/updates/assets/{bundle_rel_path}",
    }

    assets_list = []
    for item in platform_data.get("assets", []):
        asset_rel = item.get("path")
        if not asset_rel:
            continue
        ext = item.get("ext", "")
        clean_ext = f".{ext}" if ext and not ext.startswith(".") else ext
        content_type = mimetypes.guess_type(f"file{clean_ext}")[0] or "application/octet-stream"
        asset_name = Path(asset_rel).name

        assets_list.append({
            "key": asset_name,
            "contentType": content_type,
            "fileExtension": clean_ext,
            "url": f"{base_url}/api/v1/updates/assets/{asset_rel}",
        })

    try:
        created_at_dt = datetime.fromtimestamp(bundle_file.stat().st_mtime, tz=timezone.utc)
        created_at_iso = created_at_dt.isoformat()
    except Exception:
        created_at_iso = datetime.now(timezone.utc).isoformat()

    manifest = {
        "id": update_id,
        "createdAt": created_at_iso,
        "runtimeVersion": runtime_version,
        "launchAsset": launch_asset,
        "assets": assets_list,
        "metadata": {
            "app": "Klasio",
            "platform": platform,
            "isUpdateAvailable": expo_current_update_id != update_id,
        },
    }

    headers = {
        "expo-protocol-version": "0",
        "content-type": "application/json",
        "cache-control": "no-cache",
        "etag": f'"{update_id}"',
    }
    return JSONResponse(content=manifest, headers=headers)


@router.get("/assets/{asset_path:path}")
async def get_update_asset(asset_path: str):
    """
    Serves static update assets (Hermes bytecode bundle, images, icons, fonts).
    Safe path traversal protection is strictly enforced.
    """
    safe_path = (UPDATES_DIR / asset_path).resolve()
    if not str(safe_path).startswith(str(UPDATES_DIR.resolve())):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied to requested asset path",
        )

    if not safe_path.exists() or not safe_path.is_file():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Asset not found: {asset_path}",
        )

    suffix = safe_path.suffix.lower()
    if suffix in (".hbc", ".js"):
        media_type = "application/javascript"
    elif suffix == ".ttf":
        media_type = "font/ttf"
    elif suffix == ".png":
        media_type = "image/png"
    elif suffix == ".xml":
        media_type = "application/xml"
    else:
        media_type = mimetypes.guess_type(safe_path.name)[0] or "application/octet-stream"

    # Assets are immutable because asset paths contain content hashes
    headers = {
        "Cache-Control": "public, max-age=31536000, immutable",
    }
    return FileResponse(safe_path, media_type=media_type, headers=headers)


@router.get("/status")
async def get_ota_status(request: Request):
    """Public diagnostic endpoint returning active OTA update bundle metadata."""
    metadata_file = UPDATES_DIR / "metadata.json"
    if not metadata_file.exists():
        return {
            "status": "uninitialized",
            "message": "No update bundle currently published.",
            "updates_dir": str(UPDATES_DIR),
        }

    try:
        with open(metadata_file, "r", encoding="utf-8") as f:
            meta = json.load(f)
    except Exception as e:
        return {"status": "error", "error": str(e)}

    android_data = meta.get("fileMetadata", {}).get("android", {})
    bundle_path = android_data.get("bundle")
    bundle_file = UPDATES_DIR / bundle_path if bundle_path else None
    bundle_size = bundle_file.stat().st_size if bundle_file and bundle_file.exists() else 0
    update_id = (
        str(uuid.uuid5(uuid.NAMESPACE_URL, f"klasio-ota-{bundle_path}"))
        if bundle_path
        else None
    )

    return {
        "status": "ready",
        "update_id": update_id,
        "platform": "android",
        "bundle": bundle_path,
        "bundle_size_bytes": bundle_size,
        "assets_count": len(android_data.get("assets", [])),
        "manifest_url": f"{get_updates_base_url(request)}/api/v1/updates/manifest",
    }


@router.post("/publish")
async def publish_ota_update(
    bundle_zip: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """
    Administrative endpoint to upload a newly exported update zip and immediately
    activate it for all mobile devices.
    """
    if current_user.role != UserRole.ADMIN:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only administrators can publish Over-The-Air updates.",
        )

    temp_zip = UPDATES_DIR / f"temp_{uuid.uuid4().hex}.zip"
    try:
        with open(temp_zip, "wb") as f:
            shutil.copyfileobj(bundle_zip.file, f)

        # Unpack zip directly into UPDATES_DIR
        with zipfile.ZipFile(temp_zip, "r") as z:
            z.extractall(UPDATES_DIR)

        # If zip contained a nested dist/ folder, hoist it
        dist_nested = UPDATES_DIR / "dist"
        if dist_nested.exists() and dist_nested.is_dir():
            for item in dist_nested.iterdir():
                dest = UPDATES_DIR / item.name
                if dest.exists():
                    if dest.is_dir():
                        shutil.rmtree(dest)
                    else:
                        dest.unlink()
                shutil.move(str(item), str(dest))
            shutil.rmtree(dist_nested)

        return {"status": "success", "message": "OTA update bundle published successfully."}
    finally:
        if temp_zip.exists():
            temp_zip.unlink()
