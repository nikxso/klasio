-- =============================================================================
-- KLASIO - PostgreSQL target-schema design patch (single-institution deployment)
-- =============================================================================
-- Based on the uploaded PostgreSQL 16 schema dump (postgres_schema.sql).
--
-- IMPORTANT:
--   * This is a DESIGN / MIGRATION BLUEPRINT, not a blindly executable production
--     migration. Integrate it into Alembic after checking the live migration head.
--   * It is additive where possible and retains legacy columns/tables so that the
--     application can be migrated endpoint-by-endpoint without data loss.
--   * Backfill sections are explicit. Resolve any rows that cannot be mapped before
--     making new institution_id columns NOT NULL or validating foreign keys.
--   * The installation represents ONE institution. Multiple campuses/departments
--     inside that institution remain supported.
--   * Role templates and permissions are Klasio-owned seeded catalogues. This
--     schema does not add institution-customizable role templates.
--
-- TARGET PRINCIPLES:
--   User -> Institution Membership -> many Role Assignments
--   Role Assignment -> Role Template -> Role Permissions
--   Role Assignment -> one or more typed Scopes
--   Delegation -> explicit permission subset + typed scopes + validity
--   UI = union of effective capabilities; API evaluates each requested resource
--   using the exact permission, assignment/delegation and scope.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. One institution per self-hosted installation
-- -----------------------------------------------------------------------------
-- The deployment row is a singleton. Seed it once after creating the institution:
-- INSERT INTO public.deployment_config (singleton_id, institution_id)
-- VALUES (1, '<the-installation-institution-uuid>');
-- The application must resolve institution context from this server-side setting;
-- do not trust an arbitrary institution_id supplied by a mobile client.

CREATE TABLE IF NOT EXISTS public.deployment_config (
    singleton_id smallint PRIMARY KEY DEFAULT 1 CHECK (singleton_id = 1),
    institution_id uuid NOT NULL UNIQUE,
    deployment_mode varchar(40) NOT NULL DEFAULT 'SINGLE_INSTITUTION_SELF_HOSTED'
        CHECK (deployment_mode = 'SINGLE_INSTITUTION_SELF_HOSTED'),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_deployment_config_institution
        FOREIGN KEY (institution_id) REFERENCES public.institutions(id)
        ON DELETE RESTRICT
);

COMMENT ON TABLE public.deployment_config IS
    'One-row installation configuration. One Klasio deployment serves one institution; campuses remain children of that institution.';

COMMENT ON TABLE public.role_templates IS
    'Klasio-owned canonical role catalogue. v1 does not support institution-authored role templates.';
COMMENT ON TABLE public.permissions IS
    'Klasio-owned stable permission catalogue. Permission codes are API/security contracts.';

-- Remove schema-dump placeholder UUID defaults. The installer/application must
-- explicitly supply the institution/campus selected by deployment_config.
ALTER TABLE public.academic_terms ALTER COLUMN institution_id DROP DEFAULT;
ALTER TABLE public.departments ALTER COLUMN institution_id DROP DEFAULT;
ALTER TABLE public.class_sections ALTER COLUMN institution_id DROP DEFAULT;
ALTER TABLE public.class_sections ALTER COLUMN campus_id DROP DEFAULT;
ALTER TABLE public.notifications ALTER COLUMN institution_id DROP DEFAULT;
ALTER TABLE public.subjects ALTER COLUMN institution_id DROP DEFAULT;

-- users.institutional_id remains unique within this database. Because each
-- deployment belongs to one institution, there is no need to move it into a
-- cross-institution membership identifier for v1.
COMMENT ON COLUMN public.users.role IS
    'Legacy compatibility category only (ADMIN/FACULTY/STUDENT). Never use as an authorization source.';

-- -----------------------------------------------------------------------------
-- 2. Academic Program entity (needed by the canonical Program Coordinator role)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.programs (
    id uuid PRIMARY KEY,
    institution_id uuid NOT NULL,
    department_id uuid NOT NULL,
    code varchar(64) NOT NULL,
    name varchar(255) NOT NULL,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_programs_institution_id UNIQUE (institution_id, id),
    CONSTRAINT uq_programs_department_code UNIQUE (institution_id, department_id, code),
    CONSTRAINT uq_programs_institution_department_id UNIQUE (institution_id, department_id, id),
    CONSTRAINT fk_programs_institution
        FOREIGN KEY (institution_id) REFERENCES public.institutions(id)
        ON DELETE RESTRICT,
    CONSTRAINT fk_programs_department
        FOREIGN KEY (institution_id, department_id)
        REFERENCES public.departments(institution_id, id)
        ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS ix_programs_department
    ON public.programs(institution_id, department_id);

ALTER TABLE public.class_sections
    ADD COLUMN IF NOT EXISTS program_id uuid;

-- Optional while legacy sections are mapped; require it for new sections when
-- the institution's academic model requires Program-level grouping.
ALTER TABLE public.class_sections
    ADD CONSTRAINT fk_class_sections_program_department
    FOREIGN KEY (institution_id, department_id, program_id)
    REFERENCES public.programs(institution_id, department_id, id)
    ON DELETE RESTRICT NOT VALID;

ALTER TABLE public.class_sections
    ADD CONSTRAINT uq_class_sections_inst_id_term
    UNIQUE (institution_id, id, academic_term_id);

-- -----------------------------------------------------------------------------
-- 3. Make academic/attendance records explicitly institution-bound
-- -----------------------------------------------------------------------------
-- The source dump already tenant-binds departments, campuses, terms, sections,
-- subjects and IAC assignments. The following operational tables were missing
-- institution_id. Add it and backfill from their authoritative parent resource.

ALTER TABLE public.teaching_assignments
    ADD COLUMN IF NOT EXISTS institution_id uuid;

UPDATE public.teaching_assignments ta
SET institution_id = cs.institution_id
FROM public.class_sections cs
WHERE cs.id = ta.class_section_id
  AND ta.institution_id IS NULL;

ALTER TABLE public.student_enrollments
    ADD COLUMN IF NOT EXISTS institution_id uuid;

UPDATE public.student_enrollments se
SET institution_id = cs.institution_id
FROM public.class_sections cs
WHERE cs.id = se.class_section_id
  AND se.institution_id IS NULL;

ALTER TABLE public.student_face_profiles
    ADD COLUMN IF NOT EXISTS institution_id uuid;

-- Single-institution deployment assumption: each student profile must resolve
-- to exactly one institution_membership in this database. Review unmatched or
-- multiply-mapped users before enforcing NOT NULL.
UPDATE public.student_face_profiles sfp
SET institution_id = im.institution_id
FROM public.institution_memberships im
WHERE im.user_id = sfp.student_user_id
  AND sfp.institution_id IS NULL;

ALTER TABLE public.attendance_sessions
    ADD COLUMN IF NOT EXISTS institution_id uuid;

UPDATE public.attendance_sessions s
SET institution_id = ta.institution_id
FROM public.teaching_assignments ta
WHERE ta.id = s.teaching_assignment_id
  AND s.institution_id IS NULL;

ALTER TABLE public.attendance_records
    ADD COLUMN IF NOT EXISTS institution_id uuid;

UPDATE public.attendance_records ar
SET institution_id = s.institution_id
FROM public.attendance_sessions s
WHERE s.id = ar.attendance_session_id
  AND ar.institution_id IS NULL;

ALTER TABLE public.attendance_amendment_audits
    ADD COLUMN IF NOT EXISTS institution_id uuid;

UPDATE public.attendance_amendment_audits aa
SET institution_id = s.institution_id
FROM public.attendance_sessions s
WHERE s.id = aa.attendance_session_id
  AND aa.institution_id IS NULL;

ALTER TABLE public.student_attendance_requests
    ADD COLUMN IF NOT EXISTS institution_id uuid;

UPDATE public.student_attendance_requests sar
SET institution_id = ta.institution_id
FROM public.teaching_assignments ta
WHERE ta.id = sar.teaching_assignment_id
  AND sar.institution_id IS NULL;

ALTER TABLE public.substitute_delegations
    ADD COLUMN IF NOT EXISTS institution_id uuid;

UPDATE public.substitute_delegations sd
SET institution_id = ta.institution_id
FROM public.teaching_assignments ta
WHERE ta.id = sd.teaching_assignment_id
  AND sd.institution_id IS NULL;

ALTER TABLE public.report_export_audits
    ADD COLUMN IF NOT EXISTS institution_id uuid;

UPDATE public.report_export_audits rea
SET institution_id = ta.institution_id
FROM public.teaching_assignments ta
WHERE ta.id = rea.teaching_assignment_id
  AND rea.institution_id IS NULL;

UPDATE public.report_export_audits rea
SET institution_id = im.institution_id
FROM public.institution_memberships im
WHERE im.user_id = rea.user_id
  AND rea.institution_id IS NULL;

-- Preflight before uncommenting the NOT NULL statements below. These checks are
-- intentionally separate so an operator can inspect unresolved rows first.
-- SELECT 'teaching_assignments' AS table_name, count(*) FROM public.teaching_assignments WHERE institution_id IS NULL;
-- SELECT 'student_enrollments' AS table_name, count(*) FROM public.student_enrollments WHERE institution_id IS NULL;
-- SELECT 'student_face_profiles' AS table_name, count(*) FROM public.student_face_profiles WHERE institution_id IS NULL;
-- SELECT 'attendance_sessions' AS table_name, count(*) FROM public.attendance_sessions WHERE institution_id IS NULL;
-- SELECT 'attendance_records' AS table_name, count(*) FROM public.attendance_records WHERE institution_id IS NULL;
-- SELECT 'attendance_amendment_audits' AS table_name, count(*) FROM public.attendance_amendment_audits WHERE institution_id IS NULL;
-- SELECT 'student_attendance_requests' AS table_name, count(*) FROM public.student_attendance_requests WHERE institution_id IS NULL;
-- SELECT 'substitute_delegations' AS table_name, count(*) FROM public.substitute_delegations WHERE institution_id IS NULL;
-- SELECT 'report_export_audits' AS table_name, count(*) FROM public.report_export_audits WHERE institution_id IS NULL;

-- After backfill/preflight returns zero for every table, set these NOT NULL in
-- Alembic as a separate migration step:
-- ALTER TABLE public.teaching_assignments ALTER COLUMN institution_id SET NOT NULL;
-- ALTER TABLE public.student_enrollments ALTER COLUMN institution_id SET NOT NULL;
-- ALTER TABLE public.student_face_profiles ALTER COLUMN institution_id SET NOT NULL;
-- ALTER TABLE public.attendance_sessions ALTER COLUMN institution_id SET NOT NULL;
-- ALTER TABLE public.attendance_records ALTER COLUMN institution_id SET NOT NULL;
-- ALTER TABLE public.attendance_amendment_audits ALTER COLUMN institution_id SET NOT NULL;
-- ALTER TABLE public.student_attendance_requests ALTER COLUMN institution_id SET NOT NULL;
-- ALTER TABLE public.substitute_delegations ALTER COLUMN institution_id SET NOT NULL;
-- ALTER TABLE public.report_export_audits ALTER COLUMN institution_id SET NOT NULL;

-- Composite unique keys used by tenant-consistent foreign keys.
ALTER TABLE public.teaching_assignments
    ADD CONSTRAINT uq_teaching_assignments_inst_id
    UNIQUE (institution_id, id);

ALTER TABLE public.attendance_sessions
    ADD CONSTRAINT uq_attendance_sessions_inst_id
    UNIQUE (institution_id, id);

-- A section's term must match the term referenced by its teaching assignment
-- and student enrollment, not merely point to two independently existing rows.
ALTER TABLE public.teaching_assignments
    ADD CONSTRAINT fk_teaching_assignment_section_term
    FOREIGN KEY (institution_id, class_section_id, academic_term_id)
    REFERENCES public.class_sections(institution_id, id, academic_term_id)
    ON DELETE RESTRICT NOT VALID;

ALTER TABLE public.student_enrollments
    ADD CONSTRAINT fk_enrollment_section_term
    FOREIGN KEY (institution_id, class_section_id, academic_term_id)
    REFERENCES public.class_sections(institution_id, id, academic_term_id)
    ON DELETE RESTRICT NOT VALID;

-- Institution consistency for teaching assignment participants/resources.
ALTER TABLE public.teaching_assignments
    ADD CONSTRAINT fk_teaching_assignment_institution
    FOREIGN KEY (institution_id) REFERENCES public.institutions(id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.teaching_assignments
    ADD CONSTRAINT fk_teaching_assignment_section_institution
    FOREIGN KEY (institution_id, class_section_id)
    REFERENCES public.class_sections(institution_id, id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.teaching_assignments
    ADD CONSTRAINT fk_teaching_assignment_subject_institution
    FOREIGN KEY (institution_id, subject_id)
    REFERENCES public.subjects(institution_id, id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.teaching_assignments
    ADD CONSTRAINT fk_teaching_assignment_term_institution
    FOREIGN KEY (institution_id, academic_term_id)
    REFERENCES public.academic_terms(institution_id, id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.teaching_assignments
    ADD CONSTRAINT fk_teaching_assignment_faculty_membership
    FOREIGN KEY (institution_id, faculty_user_id)
    REFERENCES public.institution_memberships(institution_id, user_id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.teaching_assignments
    ADD CONSTRAINT fk_teaching_assignment_creator_membership
    FOREIGN KEY (institution_id, created_by_user_id)
    REFERENCES public.institution_memberships(institution_id, user_id)
    ON DELETE RESTRICT NOT VALID;

-- Institution consistency for student enrolments and face profiles.
ALTER TABLE public.student_enrollments
    ADD CONSTRAINT fk_enrollment_student_membership
    FOREIGN KEY (institution_id, student_user_id)
    REFERENCES public.institution_memberships(institution_id, user_id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.student_enrollments
    ADD CONSTRAINT fk_enrollment_section_institution
    FOREIGN KEY (institution_id, class_section_id)
    REFERENCES public.class_sections(institution_id, id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.student_enrollments
    ADD CONSTRAINT fk_enrollment_term_institution
    FOREIGN KEY (institution_id, academic_term_id)
    REFERENCES public.academic_terms(institution_id, id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.student_face_profiles
    ADD CONSTRAINT fk_face_profile_student_membership
    FOREIGN KEY (institution_id, student_user_id)
    REFERENCES public.institution_memberships(institution_id, user_id)
    ON DELETE RESTRICT NOT VALID;

-- Attendance sessions must remain within the teaching assignment's institution.
ALTER TABLE public.attendance_sessions
    ADD CONSTRAINT fk_attendance_session_assignment_institution
    FOREIGN KEY (institution_id, teaching_assignment_id)
    REFERENCES public.teaching_assignments(institution_id, id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.attendance_sessions
    ADD CONSTRAINT fk_attendance_regular_faculty_membership
    FOREIGN KEY (institution_id, regular_faculty_user_id)
    REFERENCES public.institution_memberships(institution_id, user_id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.attendance_sessions
    ADD CONSTRAINT fk_attendance_conducting_faculty_membership
    FOREIGN KEY (institution_id, conducting_faculty_user_id)
    REFERENCES public.institution_memberships(institution_id, user_id)
    ON DELETE RESTRICT NOT VALID;

ALTER TABLE public.attendance_records
    ADD CONSTRAINT fk_attendance_record_session_institution
    FOREIGN KEY (institution_id, attendance_session_id)
    REFERENCES public.attendance_sessions(institution_id, id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.attendance_records
    ADD CONSTRAINT fk_attendance_record_student_membership
    FOREIGN KEY (institution_id, student_user_id)
    REFERENCES public.institution_memberships(institution_id, user_id)
    ON DELETE RESTRICT NOT VALID;

-- Student requests must reference a student membership and a teaching assignment
-- belonging to the same installation institution.
ALTER TABLE public.student_attendance_requests
    ADD CONSTRAINT fk_student_request_assignment_institution
    FOREIGN KEY (institution_id, teaching_assignment_id)
    REFERENCES public.teaching_assignments(institution_id, id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.student_attendance_requests
    ADD CONSTRAINT fk_student_request_student_membership
    FOREIGN KEY (institution_id, student_user_id)
    REFERENCES public.institution_memberships(institution_id, user_id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.student_attendance_requests
    ADD CONSTRAINT fk_student_request_reviewer_membership
    FOREIGN KEY (institution_id, reviewer_user_id)
    REFERENCES public.institution_memberships(institution_id, user_id)
    ON DELETE RESTRICT NOT VALID;

-- Existing substitute_delegations is retained as a compatibility/history table.
-- New authorization decisions use public.delegations. Do not dual-write indefinitely.
ALTER TABLE public.substitute_delegations
    ADD CONSTRAINT fk_legacy_substitute_assignment_institution
    FOREIGN KEY (institution_id, teaching_assignment_id)
    REFERENCES public.teaching_assignments(institution_id, id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.substitute_delegations
    ADD CONSTRAINT fk_legacy_substitute_regular_membership
    FOREIGN KEY (institution_id, regular_faculty_user_id)
    REFERENCES public.institution_memberships(institution_id, user_id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.substitute_delegations
    ADD CONSTRAINT fk_legacy_substitute_grantee_membership
    FOREIGN KEY (institution_id, substitute_faculty_user_id)
    REFERENCES public.institution_memberships(institution_id, user_id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.substitute_delegations
    ADD CONSTRAINT fk_legacy_substitute_creator_membership
    FOREIGN KEY (institution_id, created_by_user_id)
    REFERENCES public.institution_memberships(institution_id, user_id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.substitute_delegations
    ADD CONSTRAINT fk_legacy_substitute_revoker_membership
    FOREIGN KEY (institution_id, revoked_by_user_id)
    REFERENCES public.institution_memberships(institution_id, user_id)
    ON DELETE RESTRICT NOT VALID;

-- -----------------------------------------------------------------------------
-- 4. Typed scopes: support Program and enforce valid same-institution targets
-- -----------------------------------------------------------------------------
ALTER TABLE public.role_assignment_scopes
    ADD COLUMN IF NOT EXISTS program_id uuid;
ALTER TABLE public.delegation_scopes
    ADD COLUMN IF NOT EXISTS program_id uuid;

ALTER TABLE public.role_assignment_scopes
    DROP CONSTRAINT IF EXISTS chk_role_scope_resource_consistency;
ALTER TABLE public.role_assignment_scopes
    ADD CONSTRAINT chk_role_scope_resource_consistency CHECK (
        (scope_type = 'INSTITUTION' AND campus_id IS NULL AND department_id IS NULL
         AND program_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL
         AND teaching_assignment_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'CAMPUS' AND campus_id IS NOT NULL AND department_id IS NULL
         AND program_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL
         AND teaching_assignment_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'DEPARTMENT' AND department_id IS NOT NULL AND campus_id IS NULL
         AND program_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL
         AND teaching_assignment_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'PROGRAM' AND program_id IS NOT NULL AND campus_id IS NULL
         AND department_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL
         AND teaching_assignment_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'ACADEMIC_TERM' AND academic_term_id IS NOT NULL AND campus_id IS NULL
         AND department_id IS NULL AND program_id IS NULL AND class_section_id IS NULL
         AND teaching_assignment_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'CLASS_SECTION' AND class_section_id IS NOT NULL AND campus_id IS NULL
         AND department_id IS NULL AND program_id IS NULL AND academic_term_id IS NULL
         AND teaching_assignment_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'TEACHING_ASSIGNMENT' AND teaching_assignment_id IS NOT NULL
         AND campus_id IS NULL AND department_id IS NULL AND program_id IS NULL
         AND academic_term_id IS NULL AND class_section_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'STUDENT' AND student_user_id IS NOT NULL AND campus_id IS NULL
         AND department_id IS NULL AND program_id IS NULL AND academic_term_id IS NULL
         AND class_section_id IS NULL AND teaching_assignment_id IS NULL)
    );

ALTER TABLE public.delegation_scopes
    DROP CONSTRAINT IF EXISTS chk_delegation_scope_resource_consistency;
ALTER TABLE public.delegation_scopes
    ADD CONSTRAINT chk_delegation_scope_resource_consistency CHECK (
        (scope_type = 'INSTITUTION' AND campus_id IS NULL AND department_id IS NULL
         AND program_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL
         AND teaching_assignment_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'CAMPUS' AND campus_id IS NOT NULL AND department_id IS NULL
         AND program_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL
         AND teaching_assignment_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'DEPARTMENT' AND department_id IS NOT NULL AND campus_id IS NULL
         AND program_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL
         AND teaching_assignment_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'PROGRAM' AND program_id IS NOT NULL AND campus_id IS NULL
         AND department_id IS NULL AND academic_term_id IS NULL AND class_section_id IS NULL
         AND teaching_assignment_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'ACADEMIC_TERM' AND academic_term_id IS NOT NULL AND campus_id IS NULL
         AND department_id IS NULL AND program_id IS NULL AND class_section_id IS NULL
         AND teaching_assignment_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'CLASS_SECTION' AND class_section_id IS NOT NULL AND campus_id IS NULL
         AND department_id IS NULL AND program_id IS NULL AND academic_term_id IS NULL
         AND teaching_assignment_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'TEACHING_ASSIGNMENT' AND teaching_assignment_id IS NOT NULL
         AND campus_id IS NULL AND department_id IS NULL AND program_id IS NULL
         AND academic_term_id IS NULL AND class_section_id IS NULL AND student_user_id IS NULL)
        OR (scope_type = 'STUDENT' AND student_user_id IS NOT NULL AND campus_id IS NULL
         AND department_id IS NULL AND program_id IS NULL AND academic_term_id IS NULL
         AND class_section_id IS NULL AND teaching_assignment_id IS NULL)
    );

ALTER TABLE public.role_assignment_scopes
    ADD CONSTRAINT fk_role_scope_program
    FOREIGN KEY (institution_id, program_id)
    REFERENCES public.programs(institution_id, id)
    ON DELETE CASCADE NOT VALID;
ALTER TABLE public.role_assignment_scopes
    ADD CONSTRAINT fk_role_scope_teaching_assignment_institution
    FOREIGN KEY (institution_id, teaching_assignment_id)
    REFERENCES public.teaching_assignments(institution_id, id)
    ON DELETE CASCADE NOT VALID;
ALTER TABLE public.delegation_scopes
    ADD CONSTRAINT fk_delegation_scope_program
    FOREIGN KEY (institution_id, program_id)
    REFERENCES public.programs(institution_id, id)
    ON DELETE CASCADE NOT VALID;
ALTER TABLE public.delegation_scopes
    ADD CONSTRAINT fk_delegation_scope_teaching_assignment_institution
    FOREIGN KEY (institution_id, teaching_assignment_id)
    REFERENCES public.teaching_assignments(institution_id, id)
    ON DELETE CASCADE NOT VALID;

-- Scope de-duplication. PostgreSQL 15+ supports NULLS NOT DISTINCT; Klasio's
-- source database is PostgreSQL 16.
CREATE UNIQUE INDEX IF NOT EXISTS uq_role_assignment_scope_exact
ON public.role_assignment_scopes
    (role_assignment_id, scope_type, campus_id, department_id, program_id,
     academic_term_id, class_section_id, teaching_assignment_id, student_user_id)
NULLS NOT DISTINCT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_delegation_scope_exact
ON public.delegation_scopes
    (delegation_id, scope_type, campus_id, department_id, program_id,
     academic_term_id, class_section_id, teaching_assignment_id, student_user_id)
NULLS NOT DISTINCT;

-- -----------------------------------------------------------------------------
-- 5. Delegation model: one canonical table, two explicit delegation families
-- -----------------------------------------------------------------------------
ALTER TABLE public.delegations
    ADD COLUMN IF NOT EXISTS delegation_type varchar(32);

ALTER TABLE public.delegations
    ADD CONSTRAINT chk_delegation_type CHECK (
        delegation_type IS NULL OR delegation_type IN
            ('FACULTY_SUBSTITUTE', 'MANAGEMENT_DELEGATION')
    );

-- Backfill delegation_type only after reviewing existing rows and matching any
-- legacy substitute_delegations rows to canonical delegations. Do not guess the
-- type of an existing row. After every row is mapped, enforce:
-- ALTER TABLE public.delegations ALTER COLUMN delegation_type SET NOT NULL;

-- Attendance sessions now carry a canonical delegation reference as well as
-- their old substitute_delegation_id during a compatibility period.
ALTER TABLE public.attendance_sessions
    ADD COLUMN IF NOT EXISTS delegation_id uuid;
ALTER TABLE public.attendance_sessions
    ADD COLUMN IF NOT EXISTS authorizing_role_assignment_id uuid;

ALTER TABLE public.attendance_sessions
    ADD CONSTRAINT fk_attendance_session_delegation
    FOREIGN KEY (institution_id, delegation_id)
    REFERENCES public.delegations(institution_id, id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.attendance_sessions
    ADD CONSTRAINT fk_attendance_session_authorizing_assignment
    FOREIGN KEY (institution_id, authorizing_role_assignment_id)
    REFERENCES public.role_assignments(institution_id, id)
    ON DELETE RESTRICT NOT VALID;

COMMENT ON COLUMN public.attendance_sessions.substitute_delegation_id IS
    'Legacy compatibility reference. New authorization must use delegation_id -> delegations.';
COMMENT ON COLUMN public.attendance_sessions.authorizing_role_assignment_id IS
    'Role assignment that supplied the attendance-session authority; also capture delegation_id when authority was delegated.';

-- -----------------------------------------------------------------------------
-- 6. Authorization provenance in attendance amendments and report exports
-- -----------------------------------------------------------------------------
ALTER TABLE public.attendance_amendment_audits
    ADD COLUMN IF NOT EXISTS actor_membership_id uuid,
    ADD COLUMN IF NOT EXISTS authorizing_role_assignment_id uuid,
    ADD COLUMN IF NOT EXISTS delegation_id uuid,
    ADD COLUMN IF NOT EXISTS permission_code varchar(128),
    ADD COLUMN IF NOT EXISTS scope_type varchar(32),
    ADD COLUMN IF NOT EXISTS scope_resource_id uuid;

UPDATE public.attendance_amendment_audits aa
SET actor_membership_id = im.id
FROM public.institution_memberships im
WHERE im.institution_id = aa.institution_id
  AND im.user_id = aa.amending_user_id
  AND aa.actor_membership_id IS NULL;

ALTER TABLE public.attendance_amendment_audits
    ALTER COLUMN amendment_role DROP NOT NULL;

ALTER TABLE public.attendance_amendment_audits
    ADD CONSTRAINT fk_amendment_session_institution
    FOREIGN KEY (institution_id, attendance_session_id)
    REFERENCES public.attendance_sessions(institution_id, id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.attendance_amendment_audits
    ADD CONSTRAINT fk_amendment_student_membership
    FOREIGN KEY (institution_id, student_user_id)
    REFERENCES public.institution_memberships(institution_id, user_id)
    ON DELETE RESTRICT NOT VALID;

ALTER TABLE public.attendance_amendment_audits
    ADD CONSTRAINT fk_amendment_actor_membership
    FOREIGN KEY (institution_id, actor_membership_id)
    REFERENCES public.institution_memberships(institution_id, id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.attendance_amendment_audits
    ADD CONSTRAINT fk_amendment_authorizing_assignment
    FOREIGN KEY (institution_id, authorizing_role_assignment_id)
    REFERENCES public.role_assignments(institution_id, id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.attendance_amendment_audits
    ADD CONSTRAINT fk_amendment_delegation
    FOREIGN KEY (institution_id, delegation_id)
    REFERENCES public.delegations(institution_id, id)
    ON DELETE RESTRICT NOT VALID;

ALTER TABLE public.report_export_audits
    ADD COLUMN IF NOT EXISTS actor_membership_id uuid,
    ADD COLUMN IF NOT EXISTS authorizing_role_assignment_id uuid,
    ADD COLUMN IF NOT EXISTS delegation_id uuid,
    ADD COLUMN IF NOT EXISTS permission_code varchar(128),
    ADD COLUMN IF NOT EXISTS scope_type varchar(32),
    ADD COLUMN IF NOT EXISTS scope_resource_id uuid;

UPDATE public.report_export_audits rea
SET actor_membership_id = im.id
FROM public.institution_memberships im
WHERE im.institution_id = rea.institution_id
  AND im.user_id = rea.user_id
  AND rea.actor_membership_id IS NULL;

ALTER TABLE public.report_export_audits
    ALTER COLUMN user_role DROP NOT NULL;

ALTER TABLE public.report_export_audits
    ADD CONSTRAINT fk_report_export_assignment_institution
    FOREIGN KEY (institution_id, teaching_assignment_id)
    REFERENCES public.teaching_assignments(institution_id, id)
    ON DELETE RESTRICT NOT VALID;

ALTER TABLE public.report_export_audits
    ADD CONSTRAINT fk_report_export_actor_membership
    FOREIGN KEY (institution_id, actor_membership_id)
    REFERENCES public.institution_memberships(institution_id, id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.report_export_audits
    ADD CONSTRAINT fk_report_export_authorizing_assignment
    FOREIGN KEY (institution_id, authorizing_role_assignment_id)
    REFERENCES public.role_assignments(institution_id, id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.report_export_audits
    ADD CONSTRAINT fk_report_export_delegation
    FOREIGN KEY (institution_id, delegation_id)
    REFERENCES public.delegations(institution_id, id)
    ON DELETE RESTRICT NOT VALID;

COMMENT ON COLUMN public.attendance_amendment_audits.amendment_role IS
    'Deprecated legacy label retained for historical compatibility; new writes use actor membership, role assignment/delegation, permission and scope provenance.';
COMMENT ON COLUMN public.report_export_audits.user_role IS
    'Deprecated legacy label retained for historical compatibility; new writes use actor membership, role assignment/delegation, permission and scope provenance.';

-- Authorization audit membership must belong to the same institution recorded
-- by the audit row. Existing nullable system events remain valid.
ALTER TABLE public.authorization_audits
    ADD CONSTRAINT fk_auth_audit_actor_membership_institution
    FOREIGN KEY (institution_id, actor_membership_id)
    REFERENCES public.institution_memberships(institution_id, id)
    ON DELETE RESTRICT NOT VALID;

-- -----------------------------------------------------------------------------
-- 7. Supporting institution-consistent foreign keys
-- -----------------------------------------------------------------------------
ALTER TABLE public.notifications
    ADD CONSTRAINT fk_notifications_user_membership
    FOREIGN KEY (institution_id, user_id)
    REFERENCES public.institution_memberships(institution_id, user_id)
    ON DELETE CASCADE NOT VALID;

ALTER TABLE public.delegations
    ADD CONSTRAINT fk_delegation_approver_membership_institution
    FOREIGN KEY (institution_id, approved_by_membership_id)
    REFERENCES public.institution_memberships(institution_id, id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.delegations
    ADD CONSTRAINT fk_delegation_revoker_membership_institution
    FOREIGN KEY (institution_id, revoked_by_membership_id)
    REFERENCES public.institution_memberships(institution_id, id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.role_assignments
    ADD CONSTRAINT fk_role_assignment_grantor_membership_institution
    FOREIGN KEY (institution_id, granted_by_membership_id)
    REFERENCES public.institution_memberships(institution_id, id)
    ON DELETE RESTRICT NOT VALID;
ALTER TABLE public.role_assignments
    ADD CONSTRAINT fk_role_assignment_approver_membership_institution
    FOREIGN KEY (institution_id, approved_by_membership_id)
    REFERENCES public.institution_memberships(institution_id, id)
    ON DELETE RESTRICT NOT VALID;

-- -----------------------------------------------------------------------------
-- 8. Indexes for the new access and audit paths
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_teaching_assignments_institution_faculty
    ON public.teaching_assignments(institution_id, faculty_user_id, is_active);
CREATE INDEX IF NOT EXISTS ix_enrollments_institution_student
    ON public.student_enrollments(institution_id, student_user_id, enrollment_status);
CREATE INDEX IF NOT EXISTS ix_attendance_sessions_institution_date
    ON public.attendance_sessions(institution_id, session_date);
CREATE INDEX IF NOT EXISTS ix_attendance_records_institution_student
    ON public.attendance_records(institution_id, student_user_id);
CREATE INDEX IF NOT EXISTS ix_role_assignments_effective
    ON public.role_assignments(institution_id, membership_id, status, valid_from, valid_until);
CREATE INDEX IF NOT EXISTS ix_delegations_effective
    ON public.delegations(institution_id, grantee_membership_id, delegation_type, status, valid_from, valid_until);
CREATE INDEX IF NOT EXISTS ix_amendment_audits_authorization_source
    ON public.attendance_amendment_audits(institution_id, authorizing_role_assignment_id, delegation_id);
CREATE INDEX IF NOT EXISTS ix_report_export_authorization_source
    ON public.report_export_audits(institution_id, authorizing_role_assignment_id, delegation_id);

-- -----------------------------------------------------------------------------
-- 9. Validation checklist (run after backfills; keep these in Alembic rollout)
-- -----------------------------------------------------------------------------
-- Validate every newly-created NOT VALID foreign key after resolving all rows:
-- ALTER TABLE public.teaching_assignments VALIDATE CONSTRAINT fk_teaching_assignment_section_term;
-- ALTER TABLE public.teaching_assignments VALIDATE CONSTRAINT fk_teaching_assignment_institution;
-- ALTER TABLE public.teaching_assignments VALIDATE CONSTRAINT fk_teaching_assignment_section_institution;
-- ALTER TABLE public.teaching_assignments VALIDATE CONSTRAINT fk_teaching_assignment_subject_institution;
-- ALTER TABLE public.teaching_assignments VALIDATE CONSTRAINT fk_teaching_assignment_term_institution;
-- ALTER TABLE public.teaching_assignments VALIDATE CONSTRAINT fk_teaching_assignment_faculty_membership;
-- ALTER TABLE public.teaching_assignments VALIDATE CONSTRAINT fk_teaching_assignment_creator_membership;
-- ALTER TABLE public.student_enrollments VALIDATE CONSTRAINT fk_enrollment_section_term;
-- ALTER TABLE public.student_enrollments VALIDATE CONSTRAINT fk_enrollment_student_membership;
-- ALTER TABLE public.student_enrollments VALIDATE CONSTRAINT fk_enrollment_section_institution;
-- ALTER TABLE public.student_enrollments VALIDATE CONSTRAINT fk_enrollment_term_institution;
-- ALTER TABLE public.student_face_profiles VALIDATE CONSTRAINT fk_face_profile_student_membership;
-- ALTER TABLE public.attendance_sessions VALIDATE CONSTRAINT fk_attendance_session_assignment_institution;
-- ALTER TABLE public.attendance_sessions VALIDATE CONSTRAINT fk_attendance_regular_faculty_membership;
-- ALTER TABLE public.attendance_sessions VALIDATE CONSTRAINT fk_attendance_conducting_faculty_membership;
-- ALTER TABLE public.attendance_records VALIDATE CONSTRAINT fk_attendance_record_session_institution;
-- ALTER TABLE public.attendance_records VALIDATE CONSTRAINT fk_attendance_record_student_membership;
-- ALTER TABLE public.student_attendance_requests VALIDATE CONSTRAINT fk_student_request_assignment_institution;
-- ALTER TABLE public.student_attendance_requests VALIDATE CONSTRAINT fk_student_request_student_membership;
-- ALTER TABLE public.student_attendance_requests VALIDATE CONSTRAINT fk_student_request_reviewer_membership;
-- ALTER TABLE public.role_assignment_scopes VALIDATE CONSTRAINT fk_role_scope_program;
-- ALTER TABLE public.role_assignment_scopes VALIDATE CONSTRAINT fk_role_scope_teaching_assignment_institution;
-- ALTER TABLE public.delegation_scopes VALIDATE CONSTRAINT fk_delegation_scope_program;
-- ALTER TABLE public.delegation_scopes VALIDATE CONSTRAINT fk_delegation_scope_teaching_assignment_institution;
-- ALTER TABLE public.attendance_sessions VALIDATE CONSTRAINT fk_attendance_session_delegation;
-- ALTER TABLE public.attendance_sessions VALIDATE CONSTRAINT fk_attendance_session_authorizing_assignment;
-- ALTER TABLE public.attendance_amendment_audits VALIDATE CONSTRAINT fk_amendment_session_institution;
-- ALTER TABLE public.attendance_amendment_audits VALIDATE CONSTRAINT fk_amendment_student_membership;
-- ALTER TABLE public.attendance_amendment_audits VALIDATE CONSTRAINT fk_amendment_actor_membership;
-- ALTER TABLE public.attendance_amendment_audits VALIDATE CONSTRAINT fk_amendment_authorizing_assignment;
-- ALTER TABLE public.attendance_amendment_audits VALIDATE CONSTRAINT fk_amendment_delegation;
-- ALTER TABLE public.report_export_audits VALIDATE CONSTRAINT fk_report_export_assignment_institution;
-- ALTER TABLE public.report_export_audits VALIDATE CONSTRAINT fk_report_export_actor_membership;
-- ALTER TABLE public.report_export_audits VALIDATE CONSTRAINT fk_report_export_authorizing_assignment;
-- ALTER TABLE public.report_export_audits VALIDATE CONSTRAINT fk_report_export_delegation;
-- ALTER TABLE public.authorization_audits VALIDATE CONSTRAINT fk_auth_audit_actor_membership_institution;
-- ALTER TABLE public.notifications VALIDATE CONSTRAINT fk_notifications_user_membership;
-- ALTER TABLE public.delegations VALIDATE CONSTRAINT fk_delegation_approver_membership_institution;
-- ALTER TABLE public.delegations VALIDATE CONSTRAINT fk_delegation_revoker_membership_institution;
-- ALTER TABLE public.role_assignments VALIDATE CONSTRAINT fk_role_assignment_grantor_membership_institution;
-- ALTER TABLE public.role_assignments VALIDATE CONSTRAINT fk_role_assignment_approver_membership_institution;

-- Do NOT drop legacy user.role, substitute_delegations, amendment_role or user_role
-- until all endpoint checks, mobile payloads and historical records are migrated.

COMMIT;
