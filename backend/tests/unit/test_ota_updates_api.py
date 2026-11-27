import pytest
from httpx import AsyncClient, ASGITransport
from src.main import app


@pytest.mark.asyncio
async def test_ota_status_endpoint():
    """Verify that the OTA status endpoint returns ready and describes the bundle."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        res = await client.get("/api/v1/updates/status")
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "ready"
        assert data["platform"] == "android"
        assert "update_id" in data
        assert data["bundle_size_bytes"] > 0
        assert data["assets_count"] > 0


@pytest.mark.asyncio
async def test_ota_manifest_endpoint():
    """Verify Expo Updates Protocol v0 manifest generation."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        headers = {
            "expo-platform": "android",
            "expo-runtime-version": "1.0.0",
            "expo-protocol-version": "0",
        }
        res = await client.get("/api/v1/updates/manifest", headers=headers)
        assert res.status_code == 200
        assert res.headers.get("expo-protocol-version") == "0"
        assert "application/json" in res.headers.get("content-type", "")

        manifest = res.json()
        assert "id" in manifest
        assert manifest["runtimeVersion"] == "1.0.0"
        assert "launchAsset" in manifest
        assert manifest["launchAsset"]["contentType"] == "application/javascript"
        assert "/api/v1/updates/assets/" in manifest["launchAsset"]["url"]
        assert len(manifest["assets"]) > 0


@pytest.mark.asyncio
async def test_ota_asset_serving_and_traversal_guard():
    """Verify asset downloading and directory traversal attack prevention."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # 1. Fetch manifest to get valid bundle URL
        res_manifest = await client.get("/api/v1/updates/manifest", headers={"expo-platform": "android"})
        assert res_manifest.status_code == 200
        manifest = res_manifest.json()
        bundle_url = manifest["launchAsset"]["url"]
        path_part = bundle_url.split("/api/v1/updates/assets/")[-1]

        # 2. Fetch the bundle asset
        res_asset = await client.get(f"/api/v1/updates/assets/{path_part}")
        assert res_asset.status_code == 200
        assert res_asset.headers.get("content-type") == "application/javascript"
        assert "immutable" in res_asset.headers.get("cache-control", "")
        assert len(res_asset.content) > 0

        # 3. Path traversal attack rejection (either blocked with 403 or URL normalization rejects with 404)
        res_traversal = await client.get("/api/v1/updates/assets/..%2F..%2Fetc%2Fpasswd")
        assert res_traversal.status_code in (403, 404)
