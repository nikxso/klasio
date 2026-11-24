# Institutional Access Control v1 (IAC v1) Design Specification

**Date**: 2026-11-24  
**Author**: Antigravity  
**Status**: Approved  
**Governing Research**: *Klasio — Product & Technical Guide* (Notion Page `3eddc1fc-8ac7-817c-98b6-e203799c72d9`, Section 43: Approved Architecture Decision — 1 November 2026; Sections 25.5–25.7)

---

## 1. Overview & Architectural Goals

The goal of this design is to replace hardcoded tri-state user roles (`STUDENT`, `FACULTY`, `ADMIN`) with **Institutional Access Control v1 (IAC v1)** without breaking existing working functionality in the mobile app, edge perception, offline SQLite database, attendance review, and enrollment workflows.

### Core Architectural Decisions
1. **Decouple Identity from Authorization**:
   - `User`: Authenticated subject.
   - `InstitutionMembership`: Relationship binding user to an institution.
   - `RoleTemplate`: Predefined responsibility bundle (20 canonical templates across 5 domains).
   - `Permission`: Granular action identifier (e.g. `attendance.session.finalize`, `roster.read`).
   - `RoleAssignment`: Binds a role template to an institution membership for a time window (`valid_from` to `valid_until`) across a specific resource scope.
   - `Scope`: 8-level resource hierarchy: `Institution → Campus → Department → Program → Academic Term → Class Section → Teaching Assignment → Student`.
   - `Delegation`: Temporary, audited authority transfer (`FACULTY_SUBSTITUTE` or `MANAGEMENT_DELEGATION`).
2. **Fail-Closed Server Authority**:
   - Client-side navigation guards and tab bars are for UX only.
   - Backend evaluates `require_permission(code, scope)` against the database on every protected endpoint.
3. **Biometric Non-Disclosure Invariant**:
   - Zero human roles (including Institution Owner and Central Admin) receive permission to inspect, download, or read 512-D float vectors (`biometrics.template.read` is strictly prohibited).
   - Only backend internal recognition services access the session-scoped gallery ($N \le 60$) during active attendance conduct.
4. **Zero Regression Guarantee**:
   - The legacy `role` field (`STUDENT`, `FACULTY`, `ADMIN`) is maintained as a computed backward-compatible projection in authentication responses (`/api/v1/auth/login` and `/api/v1/auth/me`).
   - Existing mobile screens and offline SQLite synchronization continue functioning seamlessly.

---

## 2. The 20 Canonical Role Templates

The 20 predefined templates are grouped into 5 functional domains:

### 2.1 Governance
1. `INSTITUTION_OWNER`: Central governance, ownership-level decisions, and appointment of central administrators.
2. `CENTRAL_INSTITUTION_ADMIN`: Day-to-day central institutional operations and multi-campus coordination.
3. `CAMPUS_ADMIN`: Local campus operations and campus-scoped administration. Sibling campus access denied.
4. `ACCESS_ADMIN`: Membership provisioning and assignment/revocation of permitted role templates. Cannot self-elevate.
5. `IT_ADMIN`: Technical configuration, integrations, device/application operations, and diagnostics. Zero academic/biometric access.
6. `PRIVACY_BIOMETRIC_OFFICER`: Consent governance, biometric retention/deletion policy, privacy oversight. Minimum-necessary access; no embedding access.

### 2.2 Academic Administration
7. `ACADEMIC_REGISTRAR`: Academic terms, calendar governance, institutional academic policies, and high-level approvals.
8. `ADMISSIONS_OFFICER`: Applicant processing, admissions decisions, and transition into student membership.
9. `ENROLLMENT_OFFICER`: Academic enrollment lifecycle: section assignment, late admission, transfers, and withdrawals.
10. `STUDENT_RECORDS_OFFICER`: Maintenance of approved student demographic and academic-record fields. No attendance marking.
11. `DEPARTMENT_HEAD`: Departmental operations, faculty coordination, curriculum oversight, and substitute delegation approval.
12. `PROGRAM_COORDINATOR`: Program-level academic operations, cohort monitoring, and program-level reporting.
13. `TIMETABLE_COORDINATOR`: Timetable generation, class schedules, and teaching slot allocation.

### 2.3 Teaching
14. `FACULTY`: Conducting classes, scanning, candidate review, manual correction, and attendance finalization for assigned teaching contexts.
15. `TEACHING_ASSISTANT`: Classroom assistance and roster support. Finalization disabled by default.
16. `CLASS_ADVISOR`: Student cohort guidance, pastoral care, and read-only attendance monitoring.

### 2.4 Biometrics & Audit
17. `BIOMETRIC_ENROLLMENT_OFFICER`: Assisted biometric registration, recapture coordination, and registration-status monitoring.
18. `ATTENDANCE_AUDITOR`: Read-only attendance review, historical amendment inspection, and audit verification.
19. `INSTITUTIONAL_AUDITOR`: Read-only institutional compliance reporting and policy audit. Cannot modify records.

### 2.5 Student
20. `STUDENT`: Personal attendance records, self-profile, biometric self-registration, and discrepancy grievances.

---

## 3. Hierarchical Scope Tree & Containment Rules

```
Institution
 └── Campus
      └── Department / School
           └── Program
                └── Academic Term / Cohort
                     └── Class Section
                          └── Teaching Assignment
                               └── Individual Student
```

### Containment Rules
- **Direct Containment**: An actor assigned at level $L$ inherits authority over all child resources in the subtree rooted at $L$ within that specific branch.
- **Strict Boundary Isolation**:
  - `Campus A` $\not\to$ `Campus B` (cross-campus access rejected unless multi-scoped).
  - `Department CSE` $\not\to$ `Department MECH` (cross-department access rejected).
- **Multi-Role Support**: A user can hold multiple `RoleAssignment` entries, each bounded to its own specific scope and validity period.

---

## 4. Two Canonical Delegation Families

### 4.1 Faculty Substitute Delegation (`FACULTY_SUBSTITUTE`)
- **Target**: Scoped to a specific `TeachingAssignment` and date window $[t_{\text{start}}, t_{\text{end}}]$.
- **Approval Gate**: Initiated by regular faculty (or admin) $\to$ requires **Department Head (HoD)** approval (`PENDING_APPROVAL` $\to$ `ACTIVE`).
- **Provenance**: Finalized attendance records explicitly capture both `assigned_faculty_id` (regular instructor) and `conducting_faculty_id` (substitute) with cryptographic signature and delegation reference.
- **Re-delegation Prohibition**: A substitute cannot delegate their received authority.

### 4.2 Management Delegation (`MANAGEMENT_DELEGATION`)
- **Target**: Bounded to institutional or departmental administrative scope.
- **Grantor**: Must possess `role.delegate` for the specific permission and scope.
- **Containment**: Delegated scope cannot exceed grantor's own scope; delegated permissions cannot exceed grantor's effective permissions. Cannot delegate security root or Access Admin privileges.

---

## 5. Permission Catalogue (Dot-Namespaced)

| Domain | Action Family Identifiers |
| :--- | :--- |
| **Governance** | `institution.view`, `institution.manage`, `campus.view`, `campus.create`, `campus.update`, `campus.archive` |
| **Membership & Roles** | `membership.view`, `membership.invite`, `membership.update`, `membership.suspend`, `role_assignment.view`, `role_assignment.create`, `role_assignment.revoke` |
| **Delegations** | `role.delegate`, `delegation.create`, `delegation.approve`, `delegation.revoke` |
| **Academic Operations** | `academic_structure.view`, `academic_structure.create`, `academic_structure.update`, `admissions.view`, `admissions.decide`, `student_enrollment.view`, `student_enrollment.create`, `student_enrollment.transfer`, `student_records.view`, `student_records.update`, `teaching_assignment.view`, `teaching_assignment.create`, `timetable.view`, `timetable.manage` |
| **Attendance Operations**| `attendance.session.view`, `attendance.session.create`, `attendance.session.start`, `attendance.candidate.view`, `attendance.candidate.review`, `attendance.candidate.correct`, `attendance.mark.manual`, `attendance.session.finalize`, `attendance.amendment.request`, `attendance.amendment.approve` |
| **Biometrics** | `biometrics.enroll.self`, `biometrics.enroll.assisted`, `biometrics.status.view`, `biometrics.profile.revoke`, `biometrics.policy.manage` *(Note: No human `biometrics.template.read`)* |
| **Audit & Reports** | `reports.view`, `reports.export`, `audit_logs.view` |

---

## 6. Migration & Backward Compatibility Architecture

### Backend Auth Payload (`/api/v1/auth/login` & `/api/v1/auth/me`)
```json
{
  "access_token": "<jwt_token>",
  "token_type": "bearer",
  "expires_in": 86400,
  "user": {
    "id": "c1f7b020-0000-0000-0000-000000000001",
    "institutional_id": "prof_alan",
    "email": "alan.turing@klasio.edu",
    "full_name": "Dr. Alan Turing",
    "role": "FACULTY",
    "face_registration_state": "REGISTERED",
    "institution_id": "00000000-0000-0000-0000-000000000001",
    "role_assignments": [
      {
        "role_template_code": "FACULTY",
        "role_template_name": "Faculty",
        "scope_type": "DEPARTMENT",
        "scope_id": "d0000000-0000-0000-0000-000000000001",
        "department_code": "CSE",
        "valid_from": "2026-01-01T00:00:00Z",
        "valid_until": null
      }
    ],
    "permissions": [
      "attendance.session.view",
      "attendance.session.create",
      "attendance.session.start",
      "attendance.candidate.view",
      "attendance.candidate.review",
      "attendance.candidate.correct",
      "attendance.mark.manual",
      "attendance.session.finalize",
      "biometrics.status.view"
    ]
  }
}
```

### Mobile Client State (`mobile/src/storage/sessionStore.ts`)
- `AuthUser` interface extended with:
  - `institutionId?: string`
  - `roleAssignments?: RoleAssignmentInfo[]`
  - `permissions?: string[]`
- Helper utilities:
  - `SessionStore.hasPermission(permissionCode: string): boolean`
  - `SessionStore.hasAnyRole(roles: string[]): boolean`
  - `SessionStore.canScanAttendance(): boolean`
  - `SessionStore.canApproveDelegation(): boolean`
- Dynamic layout navigation in `mobile/src/app/index.tsx`:
  - Evaluates permissions and assignments to route user to `/(admin)`, `/(faculty)`, or `/(student)`.
  - Seamlessly falls back to `user.role` if offline cache has legacy record.

---

## 7. Out of Scope for v1
- Parent/Guardian accounts.
- Custom dynamic role builder.
- External auditor or finance billing roles.
