#!/usr/bin/env python3
"""
Attendly Staging Smoke Test Suite
Executes end-to-end operational and security validation against the running staging proxy.
"""

import sys
import json
import urllib.request
import urllib.error
import ssl

BASE_URL = "http://localhost:8080"
HTTPS_BASE_URL = "https://localhost:8443"

# SSL context ignoring self-signed certificate for staging
ssl_ctx = ssl.create_default_context()
ssl_ctx.check_hostname = False
ssl_ctx.verify_mode = ssl.CERT_NONE


def request(method, path, data=None, token=None, use_https=False, return_headers=False):
    base = HTTPS_BASE_URL if use_https else BASE_URL
    url = f"{base}{path}"
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    
    body = json.dumps(data).encode("utf-8") if data is not None else None
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    
    try:
        with urllib.request.urlopen(req, context=ssl_ctx if use_https else None) as resp:
            status = resp.status
            content = resp.read().decode("utf-8")
            ct = resp.headers.get_content_type()
            if "json" in ct:
                parsed = json.loads(content) if content else {}
            else:
                parsed = content
            if return_headers:
                return status, parsed, resp.headers
            return status, parsed
    except urllib.error.HTTPError as e:
        content = e.read().decode("utf-8")
        try:
            parsed = json.loads(content)
        except Exception:
            parsed = {"raw": content}
        if return_headers:
            return e.code, parsed, e.headers
        return e.code, parsed


def run_smoke_tests():
    print("==================================================================")
    print("           ATTENDLY STAGING DEPLOYMENT SMOKE TESTS               ")
    print("==================================================================")

    # 1. Probes
    print("\n[1/7] Testing Health Probes via Reverse Proxy...")
    status, res = request("GET", "/health/live")
    assert status == 200 and res.get("status") == "alive", f"Liveness failed: {status} {res}"
    print("  ✓ GET /health/live -> 200 OK (status=alive)")

    status, res = request("GET", "/health/ready")
    assert status == 200 and res.get("database") == "connected", f"Readiness failed: {status} {res}"
    print("  ✓ GET /health/ready -> 200 OK (database=connected)")

    status, res = request("GET", "/health", use_https=True)
    assert status == 200, f"HTTPS /health failed: {status} {res}"
    print("  ✓ GET https://localhost:8443/health -> 200 OK (TLS termination verified)")

    # 2. Authentication & Invalid Token Rejection
    print("\n[2/7] Testing Authentication & Token Boundaries...")
    status, res = request("POST", "/api/v1/auth/login", {"username": "prof_alan", "password": "wrong_password"})
    assert status == 401, f"Expected 401 for bad password, got {status}"
    print("  ✓ POST /auth/login with wrong password -> 401 Unauthorized")

    status, res = request("POST", "/api/v1/auth/login", {"username": "prof_alan", "password": "password"})
    assert status == 200 and "access_token" in res, f"Login failed: {status} {res}"
    faculty_token = res["access_token"]
    print(f"  ✓ POST /auth/login as prof_alan -> 200 OK (Token issued)")

    status, res = request("POST", "/api/v1/auth/login", {"username": "admin_meera", "password": "password"})
    assert status == 200 and "access_token" in res, f"Admin login failed: {status} {res}"
    admin_token = res["access_token"]
    print(f"  ✓ POST /auth/login as admin_meera -> 200 OK")

    status, res = request("POST", "/api/v1/auth/login", {"username": "S1", "password": "password"})
    assert status == 200 and "access_token" in res, f"Student login failed: {status} {res}"
    student_token = res["access_token"]
    print(f"  ✓ POST /auth/login as student S1 -> 200 OK")

    # Invalid token rejection
    status, res = request("GET", "/api/v1/auth/me", token="invalid-forged-token-abc123")
    assert status == 401, f"Expected 401 for forged token, got {status}"
    print("  ✓ GET /auth/me with forged token -> 401 Unauthorized")

    # 3. Role-Based Access Control
    print("\n[3/7] Testing Role Boundaries & Access Scoping...")
    status, res = request("POST", "/api/v1/admin/departments", {"code": "TEST", "name": "Test Dept"}, token=student_token)
    assert status == 403, f"Student should be forbidden from admin endpoint, got {status}"
    print("  ✓ Student calling Admin endpoint -> 403 Forbidden")

    # Faculty also cannot create admin departments
    status, res = request("POST", "/api/v1/admin/departments", {"code": "TEST", "name": "Test Dept"}, token=faculty_token)
    assert status == 403, f"Faculty should be forbidden from admin endpoint, got {status}"
    print("  ✓ Faculty calling Admin endpoint -> 403 Forbidden")

    # 4. Teaching Assignments & Scoped Gallery Access
    print("\n[4/7] Testing Teaching Assignments & Biometric Gallery Scoping...")
    status, assignments = request("GET", "/api/v1/faculty/assignments", token=faculty_token)
    assert status == 200 and len(assignments) > 0, f"Failed to get assignments: {status} {assignments}"
    assignment_id = assignments[0]["teaching_assignment_id"]
    print(f"  ✓ GET /faculty/assignments -> 200 OK (Found {len(assignments)} assignments, test id={assignment_id})")

    # Faculty queries their assignment gallery
    status, gallery = request("GET", f"/api/v1/faculty/assignments/{assignment_id}/gallery", token=faculty_token)
    assert status == 200 and "gallery_version" in gallery, f"Failed to get gallery: {status} {gallery}"
    print(f"  ✓ GET /assignments/{assignment_id}/gallery -> 200 OK (templates={gallery.get('template_count')}, version={gallery.get('gallery_version')[:8]}...)")

    # Student attempts to query gallery -> 403 Forbidden
    status, res = request("GET", f"/api/v1/faculty/assignments/{assignment_id}/gallery", token=student_token)
    assert status == 403, f"Student accessing faculty gallery should return 403, got {status}"
    print("  ✓ Student querying faculty gallery -> 403 Forbidden")

    # 5. Attendance Session Lifecycle & Finalization
    print("\n[5/7] Testing Attendance Session Lifecycle & Finalization...")
    import uuid
    from datetime import date
    today_str = date.today().isoformat()

    # Get roster to identify enrolled students (session_date required for eligibility scoping)
    status, roster = request("GET", f"/api/v1/faculty/assignments/{assignment_id}/roster?session_date={today_str}", token=faculty_token)
    assert status == 200 and "eligible_students" in roster, f"Failed to get roster: {status} {roster}"
    students = roster["eligible_students"]
    print(f"  ✓ Retrieved roster: {len(students)} students enrolled")

    # Try slots until an unfinalized slot is created
    for test_slot in range(1, 20):
        client_uuid = str(uuid.uuid4())
        session_payload = {
            "client_session_uuid": client_uuid,
            "teaching_assignment_id": assignment_id,
            "session_date": today_str,
            "period_slot_or_sequence": test_slot,
            "applicability_status": "COUNTED",
            "finalized_at": "2026-10-29T10:00:00Z",
            "records": [
                {
                    "student_user_id": s["student_user_id"],
                    "attendance_status": "PRESENT" if idx == 0 else "ABSENT",
                    "mark_source": "AI_VERIFIED" if idx == 0 else "MANUAL_MARK",
                }
                for idx, s in enumerate(students)
            ],
        }
        status, session_res = request("POST", "/api/v1/attendance/sessions/sync", data=session_payload, token=faculty_token)
        if status in (200, 201):
            print(f"  ✓ POST /attendance/sessions/sync -> {status} (slot {test_slot})")
            break
    else:
        raise AssertionError(f"Could not find an open slot to sync session: {status} {session_res}")

    # 6. Idempotent Duplicate Sync
    print("\n[6/7] Testing Offline Synchronization Idempotency...")
    status, duplicate_res = request("POST", "/api/v1/attendance/sessions/sync", data=session_payload, token=faculty_token)
    results = duplicate_res.get("results", [{}])
    assert status == 200 and results[0].get("status") == "ALREADY_SYNCED", f"Expected idempotent 200, got {status} {duplicate_res}"
    print(f"  ✓ Idempotent replay of same client_session_uuid -> 200 OK (status=ALREADY_SYNCED)")

    # 7. Analytics Verification
    print("\n[7/8] Testing Institutional & Faculty Analytics...")
    status, analytics = request("GET", "/api/v1/analytics/overview", token=faculty_token)
    assert status == 200 and "sections" in analytics, f"Analytics failed: {status} {analytics}"
    print(f"  ✓ GET /analytics/overview as Faculty -> 200 OK (sections={len(analytics.get('sections', []))}, held_sessions={analytics.get('total_held_sessions')})")

    # 8. Administrative Attendance Reporting and Controlled CSV Export
    print("\n[8/8] Testing Attendance Reporting & Controlled CSV Export...")
    # Faculty exports assignment roster CSV
    status, csv_data, headers = request(
        "GET",
        f"/api/v1/analytics/assignments/{assignment_id}/export?report_type=roster",
        token=faculty_token,
        return_headers=True,
    )
    assert status == 200, f"Roster export failed: {status} {csv_data}"
    assert "text/csv" in headers.get_content_type(), f"Expected text/csv, got {headers.get_content_type()}"
    assert csv_data.startswith("\ufeff"), "Expected UTF-8 BOM prefix (\\ufeff) in CSV"
    assert "Institutional ID" in csv_data and "Attendance Percentage" in csv_data, f"Missing roster headers: {csv_data[:200]}"
    print("  ✓ GET /analytics/assignments/{id}/export?report_type=roster -> 200 OK (UTF-8 BOM, text/csv)")

    # Faculty exports assignment sessions CSV
    status, csv_data, headers = request(
        "GET",
        f"/api/v1/analytics/assignments/{assignment_id}/export?report_type=sessions",
        token=faculty_token,
        return_headers=True,
    )
    assert status == 200, f"Sessions export failed: {status} {csv_data}"
    assert "Session Date" in csv_data and "Institutional ID" in csv_data, f"Missing session headers: {csv_data[:200]}"
    print("  ✓ GET /analytics/assignments/{id}/export?report_type=sessions -> 200 OK (text/csv)")

    # Admin exports overview CSV
    status, csv_data, headers = request(
        "GET",
        "/api/v1/analytics/overview/export",
        token=admin_token,
        return_headers=True,
    )
    assert status == 200, f"Overview export failed: {status} {csv_data}"
    assert "Section Code" in csv_data and "Subject Code" in csv_data, f"Missing overview headers: {csv_data[:200]}"
    print("  ✓ GET /analytics/overview/export as Admin -> 200 OK (text/csv)")

    # Student cannot export -> 403 Forbidden
    status, res = request(
        "GET",
        f"/api/v1/analytics/assignments/{assignment_id}/export?report_type=roster",
        token=student_token,
    )
    assert status == 403, f"Expected 403 for student export, got {status} {res}"
    print("  ✓ Student export attempt -> 403 Forbidden")

    status, res = request(
        "GET",
        "/api/v1/analytics/overview/export",
        token=student_token,
    )
    assert status == 403, f"Expected 403 for student overview export, got {status} {res}"
    print("  ✓ Student overview export attempt -> 403 Forbidden")

    print("\n==================================================================")
    print("         ALL STAGING SMOKE TEST SCENARIOS PASSED (8/8)           ")
    print("==================================================================")


if __name__ == "__main__":
    run_smoke_tests()
