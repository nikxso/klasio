"""
T084: OpenAPI Specification Synchronization Contract Tests.

Validates that the checked-in API contract in:
  specs/001-academic-roles-enrollment/contracts/attendance-session-api.yaml
accurately matches the live FastAPI runtime OpenAPI schema (app.openapi()).

Verifies:
1. OpenAPI document integrity, versioning, and internal $ref resolution.
2. Exact bidirectional path and HTTP method consistency for in-scope endpoints.
3. Security requirements and bearer-token authentication boundaries.
4. Path and query parameter definitions, locations, and requirement flags.
5. Request body schemas, content types, and references.
6. Response status codes, content types, and response schemas.
7. Component schema properties, required fields, and domain enum values.
"""

from pathlib import Path
from typing import Any, Dict, List, Set, Tuple
import pytest
import yaml

from src.main import create_app

# Path resolution: find attendance-session-api.yaml relative to this test file
CONTRACT_PATH = (
    Path(__file__).resolve().parents[3]
    / "specs"
    / "001-academic-roles-enrollment"
    / "contracts"
    / "attendance-session-api.yaml"
)

# Framework-provided documentation and infrastructure routes excluded from domain contract
EXCLUDED_RUNTIME_PATHS = {
    "/docs",
    "/redoc",
    "/openapi.json",
    "/health",
    "/health/live",
    "/health/ready",
    "/api/v1/notifications",
    "/api/v1/notifications/unread-count",
    "/api/v1/notifications/{notification_id}/read",
    "/api/v1/notifications/mark-all-read",
    "/api/v1/admin/departments/overview",
    "/api/v1/admin/faculty/{faculty_id}/assignments",
    "/api/v1/admin/users",
    "/api/v1/admin/users/{user_id}/role",
    "/api/v1/attendance/requests",
    "/api/v1/attendance/requests/{request_id}",
    "/api/v1/student/requests",
    "/api/v1/student/attendance/calendar",
    "/api/v1/faculty/academic-terms",
    "/api/v1/faculty/delegations",
    "/api/v1/faculty/students/{student_user_id}",
    "/api/v1/users/{user_id}/profile-photo",
    "/api/v1/admin/access-control/audits",
    "/api/v1/admin/access-control/delegations",
    "/api/v1/admin/access-control/delegations/{delegation_id}/approve",
    "/api/v1/admin/access-control/delegations/{delegation_id}/revoke",
    "/api/v1/admin/access-control/memberships",
    "/api/v1/admin/access-control/role-assignments",
    "/api/v1/admin/access-control/role-assignments/{assignment_id}/status",
    "/api/v1/admin/access-control/role-templates",
    "/api/v1/admin/access-control/unmapped-accounts",
    "/api/v1/admin/campuses",
    "/api/v1/admin/campuses/{campus_id}",
    "/api/v1/admin/users/{user_id}/roles",
    "/api/v1/admin/users/{user_id}/roles/{role_code}",
    "/api/v1/admin/assignments/{assignment_id}",
    "/api/v1/admin/departments/{department_id}",
    "/api/v1/admin/sections/{section_id}",
    "/api/v1/admin/subjects/{subject_id}",
    "/api/v1/admin/users/{user_id}",
    "/api/v1/faculty/assignments/{teaching_assignment_id}/sessions",
    "/api/v1/updates/manifest",
    "/api/v1/updates/assets/{asset_path}",
    "/api/v1/updates/status",
    "/api/v1/updates/publish",
}

EXCLUDED_RUNTIME_OPERATIONS = {
    ("/api/v1/admin/departments", "get"),
    ("/api/v1/admin/terms", "get"),
    ("/api/v1/admin/subjects", "get"),
    ("/api/v1/admin/sections", "get"),
}

EXCLUDED_RUNTIME_SCHEMAS = {
    "Body_publish_ota_update_api_v1_updates_publish_post",
    "AdminUserListItem",
    "AdminUserCreate",
    "AttendanceRequestStatus",
    "CreateAttendanceRequest",
    "DepartmentOverviewItem",
    "NotificationResponse",
    "NotificationUnreadCountResponse",
    "ResolveAttendanceRequest",
    "StudentAttendanceRequestResponse",
    "AcademicTermsListResponse",
    "FacultyAssignmentItem",
    "FacultyDelegationItem",
    "StudentDailySessionItem",
    "StudentProfileDetailResponse",
    "StudentProfileUpdateRequest",
    "UserRoleUpdate",
    "AssignmentStatus",
    "AuditOutcome",
    "AuthorizationAuditResponse",
    "CampusCreate",
    "CampusResponse",
    "CampusStatus",
    "CampusUpdate",
    "DelegationAction",
    "DelegationLifecycleStatus",
    "DelegationResponse",
    "DelegationType",
    "InstitutionMembershipResponse",
    "MembershipStatus",
    "PermissionResponse",
    "RoleAssignmentCreate",
    "RoleAssignmentResponse",
    "RoleAssignmentScopeResponse",
    "RoleAssignmentStatusUpdate",
    "RoleAssignmentSummary",
    "RoleScopeType",
    "RoleTemplateResponse",
    "UnmappedAccountItem",
    "UserAddRoleRequest",
    "AccountStatus",
    "AdminUserUpdate",
    "ClassSectionUpdate",
    "DepartmentUpdate",
    "FacultyHeldSessionItem",
    "StudentWeeklyTrendPoint",
    "SubjectUpdate",
    "TeachingAssignmentUpdate",
}

DOMAIN_ENUMS = [
    "UserRole",
    "FaceRegistrationState",
    "SessionApplicability",
    "AttendanceStatus",
    "MarkSource",
    "DelegationStatus",
    "EnrollmentStatus",
    "TermStatus",
    "SyncResultStatus",
    "AmendmentRole",
    "FaceRegistrationStatus",
]


@pytest.fixture(scope="module")
def runtime_openapi() -> Dict[str, Any]:
    """Retrieve runtime OpenAPI schema generated by FastAPI."""
    clean_app = create_app()
    return clean_app.openapi()


@pytest.fixture(scope="module")
def contract_spec() -> Dict[str, Any]:
    """Load and parse the checked-in OpenAPI contract YAML."""
    assert (
        CONTRACT_PATH.exists()
    ), f"API contract file not found at: {CONTRACT_PATH}"
    with open(CONTRACT_PATH, "r", encoding="utf-8") as f:
        spec = yaml.safe_load(f)
    assert isinstance(spec, dict), "Parsed contract YAML root must be a dictionary"
    return spec


def _find_all_refs(node: Any) -> List[str]:
    """Recursively discover all $ref strings in an OpenAPI dictionary or list."""
    refs: List[str] = []
    if isinstance(node, dict):
        for k, v in node.items():
            if k == "$ref" and isinstance(v, str):
                refs.append(v)
            else:
                refs.extend(_find_all_refs(v))
    elif isinstance(node, list):
        for item in node:
            refs.extend(_find_all_refs(item))
    return refs


def _get_in_scope_runtime_operations(
    runtime_openapi: Dict[str, Any],
) -> Set[Tuple[str, str]]:
    """Return set of (path, method) tuples for all in-scope runtime operations."""
    ops: Set[Tuple[str, str]] = set()
    for path, methods in runtime_openapi.get("paths", {}).items():
        if path in EXCLUDED_RUNTIME_PATHS or not path.startswith("/api/v1/"):
            continue
        for method in methods:
            m = method.lower()
            if (path, m) in EXCLUDED_RUNTIME_OPERATIONS:
                continue
            ops.add((path, m))
    return ops


def _get_contract_operations(
    contract_spec: Dict[str, Any],
) -> Set[Tuple[str, str]]:
    """Return set of (path, method) tuples defined in the contract YAML."""
    ops: Set[Tuple[str, str]] = set()
    for path, methods in contract_spec.get("paths", {}).items():
        for method in methods:
            ops.add((path, method.lower()))
    return ops


# ---------------------------------------------------------------------------
# 1. Document Integrity and Versioning
# ---------------------------------------------------------------------------


def test_openapi_document_integrity_and_version(contract_spec: Dict[str, Any]):
    """
    Validate that the YAML contract has valid OpenAPI 3.0.x metadata
    and that all internal references ($ref) resolve within the document.
    """
    version = contract_spec.get("openapi", "")
    assert version.startswith(
        "3.0"
    ), f"Expected OpenAPI version 3.0.x, found '{version}'"

    info = contract_spec.get("info", {})
    assert info.get("title"), "OpenAPI contract 'info.title' must be non-empty"
    assert info.get("version"), "OpenAPI contract 'info.version' must be non-empty"

    schemas = contract_spec.get("components", {}).get("schemas", {})
    sec_schemes = contract_spec.get("components", {}).get("securitySchemes", {})

    all_refs = _find_all_refs(contract_spec)
    assert len(all_refs) > 0, "Expected contract to contain component references"

    dangling_refs = []
    for ref in set(all_refs):
        if ref.startswith("#/components/schemas/"):
            schema_name = ref.split("/")[-1]
            if schema_name not in schemas:
                dangling_refs.append(ref)
        elif ref.startswith("#/components/securitySchemes/"):
            scheme_name = ref.split("/")[-1]
            if scheme_name not in sec_schemes:
                dangling_refs.append(ref)
        else:
            dangling_refs.append(ref)

    assert (
        not dangling_refs
    ), f"Found {len(dangling_refs)} dangling references in contract: {dangling_refs}"


# ---------------------------------------------------------------------------
# 2. Path and HTTP Method Consistency
# ---------------------------------------------------------------------------


def test_openapi_paths_and_operations_bidirectional_match(
    runtime_openapi: Dict[str, Any], contract_spec: Dict[str, Any]
):
    """
    Verify exact bidirectional consistency between runtime FastAPI routes and contract YAML.
    Catches undocumented runtime routes and unimplemented contract routes.
    """
    runtime_ops = _get_in_scope_runtime_operations(runtime_openapi)
    contract_ops = _get_contract_operations(contract_spec)

    missing_in_contract = runtime_ops - contract_ops
    missing_in_runtime = contract_ops - runtime_ops

    error_msgs = []
    if missing_in_contract:
        lines = [f"  {m.upper()} {p}" for p, m in sorted(missing_in_contract)]
        error_msgs.append(
            "Runtime operations missing from API contract YAML:\n" + "\n".join(lines)
        )
    if missing_in_runtime:
        lines = [f"  {m.upper()} {p}" for p, m in sorted(missing_in_runtime)]
        error_msgs.append(
            "Contract operations missing from live FastAPI runtime:\n"
            + "\n".join(lines)
        )

    assert not error_msgs, "\n\n".join(error_msgs)
    assert len(contract_ops) >= 18, (
        f"Expected at least 18 in-scope operations, found {len(contract_ops)}"
    )


# ---------------------------------------------------------------------------
# 3. Security and Authentication Consistency
# ---------------------------------------------------------------------------


def test_openapi_security_requirements_consistency(
    runtime_openapi: Dict[str, Any], contract_spec: Dict[str, Any]
):
    """
    Verify that security schemes and per-operation security requirements match.
    - BearerAuth is defined in securitySchemes.
    - POST /api/v1/auth/login is public (empty security).
    - All other in-scope endpoints enforce BearerAuth in both runtime and contract.
    """
    sec_schemes = contract_spec.get("components", {}).get("securitySchemes", {})
    assert "BearerAuth" in sec_schemes, "Contract missing BearerAuth security scheme"
    assert (
        sec_schemes["BearerAuth"].get("type") == "http"
    ), "BearerAuth type must be 'http'"
    assert (
        sec_schemes["BearerAuth"].get("scheme") == "bearer"
    ), "BearerAuth scheme must be 'bearer'"

    runtime_ops = _get_in_scope_runtime_operations(runtime_openapi)
    for path, method in sorted(runtime_ops):
        r_op = runtime_openapi["paths"][path][method]
        c_op = contract_spec["paths"][path][method]

        r_sec = r_op.get("security", [])
        c_sec = c_op.get("security", [])

        if path == "/api/v1/auth/login":
            assert (
                r_sec == []
            ), f"Expected runtime {method.upper()} {path} to be public (empty security), got {r_sec}"
            assert (
                c_sec == []
            ), f"Expected contract {method.upper()} {path} to be public (empty security), got {c_sec}"
        else:
            expected_sec = [{"BearerAuth": []}]
            assert (
                r_sec == expected_sec
            ), f"Runtime {method.upper()} {path} security mismatch: {r_sec} != {expected_sec}"
            assert (
                c_sec == expected_sec
            ), f"Contract {method.upper()} {path} security mismatch: {c_sec} != {expected_sec}"


# ---------------------------------------------------------------------------
# 4. Operation Parameters Consistency
# ---------------------------------------------------------------------------


def test_openapi_parameters_consistency(
    runtime_openapi: Dict[str, Any], contract_spec: Dict[str, Any]
):
    """
    Validate that path and query parameter definitions (name, location, required)
    match identically between runtime OpenAPI and contract YAML.
    """
    runtime_ops = _get_in_scope_runtime_operations(runtime_openapi)

    for path, method in sorted(runtime_ops):
        r_params = {
            p["name"]: (p["in"], p.get("required", False))
            for p in runtime_openapi["paths"][path][method].get("parameters", [])
        }
        c_params = {
            p["name"]: (p["in"], p.get("required", False))
            for p in contract_spec["paths"][path][method].get("parameters", [])
        }

        assert r_params == c_params, (
            f"Parameter mismatch on {method.upper()} {path}:\n"
            f"  Runtime:  {r_params}\n"
            f"  Contract: {c_params}"
        )


# ---------------------------------------------------------------------------
# 5. Request Body Schemas Consistency
# ---------------------------------------------------------------------------


def test_openapi_request_body_schemas_consistency(
    runtime_openapi: Dict[str, Any], contract_spec: Dict[str, Any]
):
    """
    Validate that operations accepting a request body match requirement flag,
    content type, and schema reference (or anyOf schema references).
    """
    runtime_ops = _get_in_scope_runtime_operations(runtime_openapi)

    for path, method in sorted(runtime_ops):
        r_rb = runtime_openapi["paths"][path][method].get("requestBody")
        c_rb = contract_spec["paths"][path][method].get("requestBody")

        if r_rb is None and c_rb is None:
            continue

        assert bool(r_rb) == bool(c_rb), (
            f"RequestBody presence mismatch on {method.upper()} {path}: "
            f"runtime={bool(r_rb)}, contract={bool(c_rb)}"
        )

        assert (
            r_rb.get("required", False) == c_rb.get("required", False)
        ), f"RequestBody 'required' mismatch on {method.upper()} {path}"

        r_content = r_rb.get("content", {})
        c_content = c_rb.get("content", {})
        assert "application/json" in r_content, (
            f"Runtime missing application/json on {method.upper()} {path}"
        )
        assert "application/json" in c_content, (
            f"Contract missing application/json on {method.upper()} {path}"
        )

        r_schema = r_content["application/json"].get("schema", {})
        c_schema = c_content["application/json"].get("schema", {})

        r_ref = r_schema.get("$ref")
        c_ref = c_schema.get("$ref")

        if r_ref and c_ref:
            assert r_ref == c_ref, (
                f"RequestBody $ref mismatch on {method.upper()} {path}: "
                f"runtime={r_ref}, contract={c_ref}"
            )
        elif "anyOf" in r_schema and "anyOf" in c_schema:
            r_subrefs = {s.get("$ref") for s in r_schema["anyOf"]}
            c_subrefs = {s.get("$ref") for s in c_schema["anyOf"]}
            assert r_subrefs == c_subrefs, (
                f"RequestBody anyOf refs mismatch on {method.upper()} {path}: "
                f"runtime={r_subrefs}, contract={c_subrefs}"
            )
        else:
            pytest.fail(
                f"Unmatched request schema structure on {method.upper()} {path}:\n"
                f"  Runtime:  {r_schema}\n"
                f"  Contract: {c_schema}"
            )


# ---------------------------------------------------------------------------
# 6. Response Status Codes and Schemas Consistency
# ---------------------------------------------------------------------------


def test_openapi_response_status_codes_and_schemas_consistency(
    runtime_openapi: Dict[str, Any], contract_spec: Dict[str, Any]
):
    """
    Validate that each operation's primary success status code (200/201)
    and response body schema match between runtime OpenAPI and contract YAML.
    """
    runtime_ops = _get_in_scope_runtime_operations(runtime_openapi)

    for path, method in sorted(runtime_ops):
        r_responses = runtime_openapi["paths"][path][method].get("responses", {})
        c_responses = contract_spec["paths"][path][method].get("responses", {})

        # Primary success status code
        r_success = "201" if "201" in r_responses else "200"
        c_success = "201" if "201" in c_responses else "200"
        assert r_success == c_success, (
            f"Success status code mismatch on {method.upper()} {path}: "
            f"runtime={r_success}, contract={c_success}"
        )

        r_content = r_responses[r_success].get("content", {})
        c_content = c_responses[c_success].get("content", {})

        # Handle CSV export streaming endpoints
        if "text/csv" in r_content or "text/csv" in c_content:
            assert "text/csv" in r_content, f"Missing text/csv in runtime content on {method.upper()} {path}"
            assert "text/csv" in c_content, f"Missing text/csv in contract content on {method.upper()} {path}"
            continue

        r_resp_schema = (
            r_content
            .get("application/json", {})
            .get("schema", {})
        )
        c_resp_schema = (
            c_content
            .get("application/json", {})
            .get("schema", {})
        )

        r_ref = r_resp_schema.get("$ref")
        c_ref = c_resp_schema.get("$ref")

        if r_ref and c_ref:
            assert r_ref == c_ref, (
                f"Response schema $ref mismatch on {method.upper()} {path} ({r_success}): "
                f"runtime={r_ref}, contract={c_ref}"
            )
        elif (
            r_resp_schema.get("type") == "array"
            and c_resp_schema.get("type") == "array"
        ):
            r_item_ref = r_resp_schema.get("items", {}).get("$ref")
            c_item_ref = c_resp_schema.get("items", {}).get("$ref")
            assert r_item_ref == c_item_ref, (
                f"Array response item $ref mismatch on {method.upper()} {path} ({r_success}): "
                f"runtime={r_item_ref}, contract={c_item_ref}"
            )
        else:
            pytest.fail(
                f"Response schema structure mismatch on {method.upper()} {path} ({r_success}):\n"
                f"  Runtime:  {r_resp_schema}\n"
                f"  Contract: {c_resp_schema}"
            )


# ---------------------------------------------------------------------------
# 7. Component Schemas Properties and Required Fields
# ---------------------------------------------------------------------------


RUNTIME_EXTENDED_SCHEMA_PROPERTIES = {
    "UserContextResponse": {
        "institution_id",
        "role_assignments",
        "permissions",
        "authorization_snapshot",
        "authorization_version",
        "membership_id",
    },
    "SubmitAttendanceSessionRequest": {
        "actor_membership_id",
        "authorization_version",
        "delegation_id",
        "authorizing_role_assignment_id",
    },
    "FacultyTeachingAssignment": {
        "held_count",
        "average_attendance_pct",
        "students_below_threshold_count",
    },
    "StudentPersonalAttendanceResponse": {
        "total_eligible_sessions",
        "total_attended_sessions",
        "weekly_trend",
    },
}


def test_openapi_component_schemas_properties_and_required(
    runtime_openapi: Dict[str, Any], contract_spec: Dict[str, Any]
):
    """
    Validate that all component schemas defined in the runtime OpenAPI
    are present in the contract with matching properties and required fields.
    """
    r_schemas = {
        k: v
        for k, v in runtime_openapi.get("components", {}).get("schemas", {}).items()
        if k not in EXCLUDED_RUNTIME_SCHEMAS
    }
    c_schemas = contract_spec.get("components", {}).get("schemas", {})

    missing_schemas = set(r_schemas.keys()) - set(c_schemas.keys())
    assert not missing_schemas, (
        f"Runtime schemas missing from contract YAML: {sorted(missing_schemas)}"
    )

    for name, r_schema in sorted(r_schemas.items()):
        c_schema = c_schemas[name]

        # Skip enum schemas (validated in separate test)
        if "enum" in r_schema:
            continue

        r_props = set(r_schema.get("properties", {}).keys())
        c_props = set(c_schema.get("properties", {}).keys())
        r_props_contract_view = r_props - RUNTIME_EXTENDED_SCHEMA_PROPERTIES.get(name, set())
        assert r_props_contract_view == c_props, (
            f"Schema '{name}' properties mismatch:\n"
            f"  Runtime only:  {r_props_contract_view - c_props}\n"
            f"  Contract only: {c_props - r_props_contract_view}"
        )

        r_req = set(r_schema.get("required", []))
        c_req = set(c_schema.get("required", []))
        assert r_req == c_req, (
            f"Schema '{name}' required fields mismatch:\n"
            f"  Runtime only:  {r_req - c_req}\n"
            f"  Contract only: {c_req - r_req}"
        )


# ---------------------------------------------------------------------------
# 8. Domain Enum Definitions Consistency
# ---------------------------------------------------------------------------


def test_openapi_enum_definitions_consistency(
    runtime_openapi: Dict[str, Any], contract_spec: Dict[str, Any]
):
    """
    Validate that domain enums defined in runtime OpenAPI match the contract YAML values exactly.
    """
    r_schemas = runtime_openapi.get("components", {}).get("schemas", {})
    c_schemas = contract_spec.get("components", {}).get("schemas", {})

    for enum_name in DOMAIN_ENUMS:
        assert (
            enum_name in r_schemas
        ), f"Enum '{enum_name}' missing from runtime OpenAPI schemas"
        assert (
            enum_name in c_schemas
        ), f"Enum '{enum_name}' missing from contract YAML schemas"

        r_vals = set(r_schemas[enum_name].get("enum", []))
        c_vals = set(c_schemas[enum_name].get("enum", []))

        assert r_vals == c_vals, (
            f"Enum '{enum_name}' value mismatch:\n"
            f"  Runtime only:  {r_vals - c_vals}\n"
            f"  Contract only: {c_vals - r_vals}"
        )
