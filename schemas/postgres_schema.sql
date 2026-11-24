--
-- PostgreSQL database dump
--

\restrict iyrZBCFfyRV6ml7jhxLB1XOC49eCmevIWaQHibTegQHrUQ9hgbljZmBWLZG5Xe4

-- Dumped from database version 16.16
-- Dumped by pg_dump version 16.16

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: academic_terms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.academic_terms (
    id uuid NOT NULL,
    code character varying(64) NOT NULL,
    name character varying(255) NOT NULL,
    academic_year character varying(16) NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    status character varying(9) NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    institution_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid NOT NULL,
    CONSTRAINT chk_term_date_range CHECK ((end_date >= start_date))
);


--
-- Name: alembic_version; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.alembic_version (
    version_num character varying(32) NOT NULL
);


--
-- Name: attendance_amendment_audits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attendance_amendment_audits (
    id uuid NOT NULL,
    attendance_session_id uuid NOT NULL,
    student_user_id uuid NOT NULL,
    previous_status character varying(7) NOT NULL,
    new_status character varying(7) NOT NULL,
    amending_user_id uuid NOT NULL,
    amendment_reason text NOT NULL,
    amended_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    amendment_role character varying(15) NOT NULL,
    client_amendment_id uuid,
    CONSTRAINT ck_amendment_reason_length CHECK ((length(amendment_reason) >= 10)),
    CONSTRAINT ck_amendment_status_changed CHECK (((new_status)::text <> (previous_status)::text))
);


--
-- Name: attendance_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attendance_records (
    id uuid NOT NULL,
    attendance_session_id uuid NOT NULL,
    student_user_id uuid NOT NULL,
    attendance_status character varying(7) NOT NULL,
    mark_source character varying(15) DEFAULT 'MANUAL_MARK'::character varying NOT NULL,
    candidate_confidence double precision,
    recorded_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: attendance_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attendance_sessions (
    id uuid NOT NULL,
    client_session_uuid uuid NOT NULL,
    teaching_assignment_id uuid NOT NULL,
    session_date date NOT NULL,
    period_slot_or_sequence smallint DEFAULT '1'::smallint NOT NULL,
    applicability_status character varying(9) DEFAULT 'COUNTED'::character varying NOT NULL,
    status_reason text,
    regular_faculty_user_id uuid NOT NULL,
    conducting_faculty_user_id uuid NOT NULL,
    substitute_delegation_id uuid,
    session_status character varying(9) DEFAULT 'FINALIZED'::character varying NOT NULL,
    finalized_at timestamp with time zone NOT NULL,
    payload_hash character varying(64),
    records_count smallint DEFAULT '0'::smallint NOT NULL,
    present_count smallint DEFAULT '0'::smallint NOT NULL,
    absent_count smallint DEFAULT '0'::smallint NOT NULL,
    excused_count smallint DEFAULT '0'::smallint NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: authorization_audits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.authorization_audits (
    id uuid NOT NULL,
    actor_user_id uuid,
    actor_membership_id uuid,
    institution_id uuid,
    action character varying(128) NOT NULL,
    permission_code character varying(128),
    target_resource_type character varying(64),
    target_resource_id character varying(64),
    outcome character varying(32) NOT NULL,
    reason text,
    correlation_id character varying(64),
    ip_address character varying(64),
    user_agent character varying(255),
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: campuses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.campuses (
    id uuid NOT NULL,
    institution_id uuid NOT NULL,
    code character varying(64) NOT NULL,
    name character varying(255) NOT NULL,
    status character varying(32) DEFAULT 'ACTIVE'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: class_sections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.class_sections (
    id uuid NOT NULL,
    section_code character varying(64) NOT NULL,
    department_id uuid NOT NULL,
    academic_term_id uuid NOT NULL,
    cohort_year smallint NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    institution_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid NOT NULL,
    campus_id uuid DEFAULT '00000000-0000-0000-0000-000000000002'::uuid NOT NULL
);


--
-- Name: delegation_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delegation_permissions (
    delegation_id uuid NOT NULL,
    permission_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: delegation_scopes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delegation_scopes (
    id uuid NOT NULL,
    delegation_id uuid NOT NULL,
    institution_id uuid NOT NULL,
    scope_type character varying(32) NOT NULL,
    campus_id uuid,
    department_id uuid,
    academic_term_id uuid,
    class_section_id uuid,
    teaching_assignment_id uuid,
    student_user_id uuid,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT chk_delegation_scope_resource_consistency CHECK (((((scope_type)::text = 'INSTITUTION'::text) AND (campus_id IS NULL) AND (department_id IS NULL) AND (academic_term_id IS NULL) AND (class_section_id IS NULL) AND (teaching_assignment_id IS NULL) AND (student_user_id IS NULL)) OR (((scope_type)::text = 'CAMPUS'::text) AND (campus_id IS NOT NULL) AND (department_id IS NULL) AND (academic_term_id IS NULL) AND (class_section_id IS NULL) AND (teaching_assignment_id IS NULL) AND (student_user_id IS NULL)) OR (((scope_type)::text = 'DEPARTMENT'::text) AND (department_id IS NOT NULL) AND (campus_id IS NULL) AND (academic_term_id IS NULL) AND (class_section_id IS NULL) AND (teaching_assignment_id IS NULL) AND (student_user_id IS NULL)) OR (((scope_type)::text = 'ACADEMIC_TERM'::text) AND (academic_term_id IS NOT NULL) AND (campus_id IS NULL) AND (department_id IS NULL) AND (class_section_id IS NULL) AND (teaching_assignment_id IS NULL) AND (student_user_id IS NULL)) OR (((scope_type)::text = 'CLASS_SECTION'::text) AND (class_section_id IS NOT NULL) AND (campus_id IS NULL) AND (department_id IS NULL) AND (academic_term_id IS NULL) AND (teaching_assignment_id IS NULL) AND (student_user_id IS NULL)) OR (((scope_type)::text = 'TEACHING_ASSIGNMENT'::text) AND (teaching_assignment_id IS NOT NULL) AND (campus_id IS NULL) AND (department_id IS NULL) AND (academic_term_id IS NULL) AND (class_section_id IS NULL) AND (student_user_id IS NULL)) OR (((scope_type)::text = 'STUDENT'::text) AND (student_user_id IS NOT NULL) AND (campus_id IS NULL) AND (department_id IS NULL) AND (academic_term_id IS NULL) AND (class_section_id IS NULL) AND (teaching_assignment_id IS NULL))))
);


--
-- Name: delegations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.delegations (
    id uuid NOT NULL,
    grantor_role_assignment_id uuid NOT NULL,
    grantee_membership_id uuid NOT NULL,
    status character varying(32) DEFAULT 'ACTIVE'::character varying NOT NULL,
    valid_from timestamp with time zone NOT NULL,
    valid_until timestamp with time zone NOT NULL,
    reason text NOT NULL,
    approved_by_membership_id uuid,
    approved_at timestamp with time zone,
    revoked_by_membership_id uuid,
    revoked_at timestamp with time zone,
    revocation_reason text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    institution_id uuid NOT NULL,
    CONSTRAINT chk_delegation_validity CHECK ((valid_until > valid_from))
);


--
-- Name: department_campuses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.department_campuses (
    department_id uuid NOT NULL,
    campus_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    institution_id uuid NOT NULL
);


--
-- Name: departments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.departments (
    id uuid NOT NULL,
    code character varying(32) NOT NULL,
    name character varying(255) NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    institution_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid NOT NULL
);


--
-- Name: institution_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.institution_memberships (
    id uuid NOT NULL,
    institution_id uuid NOT NULL,
    user_id uuid NOT NULL,
    status character varying(32) DEFAULT 'ACTIVE'::character varying NOT NULL,
    joined_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: institutions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.institutions (
    id uuid NOT NULL,
    code character varying(64) NOT NULL,
    name character varying(255) NOT NULL,
    status character varying(32) DEFAULT 'ACTIVE'::character varying NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid NOT NULL,
    institution_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid NOT NULL,
    user_id uuid NOT NULL,
    title character varying(255) NOT NULL,
    message text NOT NULL,
    category character varying(50) DEFAULT 'ATTENDANCE'::character varying NOT NULL,
    priority character varying(20) DEFAULT 'NORMAL'::character varying NOT NULL,
    link_type character varying(50),
    link_id character varying(255),
    is_read boolean DEFAULT false NOT NULL,
    read_at timestamp with time zone,
    deduplication_key character varying(128),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.permissions (
    id uuid NOT NULL,
    code character varying(128) NOT NULL,
    resource character varying(64) NOT NULL,
    action character varying(64) NOT NULL,
    description text,
    is_sensitive boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: report_export_audits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_export_audits (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    user_role character varying(32) NOT NULL,
    export_format character varying(16) DEFAULT 'CSV'::character varying NOT NULL,
    report_type character varying(64) NOT NULL,
    teaching_assignment_id uuid,
    academic_term_id uuid,
    start_date date,
    end_date date,
    row_count smallint DEFAULT '0'::smallint NOT NULL,
    exported_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: role_assignment_scopes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_assignment_scopes (
    id uuid NOT NULL,
    role_assignment_id uuid NOT NULL,
    institution_id uuid NOT NULL,
    scope_type character varying(32) NOT NULL,
    campus_id uuid,
    department_id uuid,
    academic_term_id uuid,
    class_section_id uuid,
    teaching_assignment_id uuid,
    student_user_id uuid,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    CONSTRAINT chk_role_scope_resource_consistency CHECK (((((scope_type)::text = 'INSTITUTION'::text) AND (campus_id IS NULL) AND (department_id IS NULL) AND (academic_term_id IS NULL) AND (class_section_id IS NULL) AND (teaching_assignment_id IS NULL) AND (student_user_id IS NULL)) OR (((scope_type)::text = 'CAMPUS'::text) AND (campus_id IS NOT NULL) AND (department_id IS NULL) AND (academic_term_id IS NULL) AND (class_section_id IS NULL) AND (teaching_assignment_id IS NULL) AND (student_user_id IS NULL)) OR (((scope_type)::text = 'DEPARTMENT'::text) AND (department_id IS NOT NULL) AND (campus_id IS NULL) AND (academic_term_id IS NULL) AND (class_section_id IS NULL) AND (teaching_assignment_id IS NULL) AND (student_user_id IS NULL)) OR (((scope_type)::text = 'ACADEMIC_TERM'::text) AND (academic_term_id IS NOT NULL) AND (campus_id IS NULL) AND (department_id IS NULL) AND (class_section_id IS NULL) AND (teaching_assignment_id IS NULL) AND (student_user_id IS NULL)) OR (((scope_type)::text = 'CLASS_SECTION'::text) AND (class_section_id IS NOT NULL) AND (campus_id IS NULL) AND (department_id IS NULL) AND (academic_term_id IS NULL) AND (teaching_assignment_id IS NULL) AND (student_user_id IS NULL)) OR (((scope_type)::text = 'TEACHING_ASSIGNMENT'::text) AND (teaching_assignment_id IS NOT NULL) AND (campus_id IS NULL) AND (department_id IS NULL) AND (academic_term_id IS NULL) AND (class_section_id IS NULL) AND (student_user_id IS NULL)) OR (((scope_type)::text = 'STUDENT'::text) AND (student_user_id IS NOT NULL) AND (campus_id IS NULL) AND (department_id IS NULL) AND (academic_term_id IS NULL) AND (class_section_id IS NULL) AND (teaching_assignment_id IS NULL))))
);


--
-- Name: role_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_assignments (
    id uuid NOT NULL,
    membership_id uuid NOT NULL,
    role_template_id uuid NOT NULL,
    status character varying(32) DEFAULT 'ACTIVE'::character varying NOT NULL,
    valid_from timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    valid_until timestamp with time zone,
    granted_by_membership_id uuid,
    approved_by_membership_id uuid,
    reason text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    institution_id uuid NOT NULL,
    CONSTRAINT chk_role_assignment_validity CHECK (((valid_until IS NULL) OR (valid_until > valid_from)))
);


--
-- Name: role_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_permissions (
    role_template_id uuid NOT NULL,
    permission_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: role_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_templates (
    id uuid NOT NULL,
    code character varying(64) NOT NULL,
    name character varying(255) NOT NULL,
    category character varying(64) NOT NULL,
    description text,
    is_system_defined boolean DEFAULT true NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: student_attendance_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.student_attendance_requests (
    id uuid NOT NULL,
    student_user_id uuid NOT NULL,
    teaching_assignment_id uuid NOT NULL,
    session_date date NOT NULL,
    student_note text NOT NULL,
    status character varying(32) DEFAULT 'PENDING'::character varying NOT NULL,
    reviewer_user_id uuid,
    resolution_note text,
    resolved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: student_enrollments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.student_enrollments (
    id uuid NOT NULL,
    student_user_id uuid NOT NULL,
    class_section_id uuid NOT NULL,
    academic_term_id uuid NOT NULL,
    effective_start_date date NOT NULL,
    effective_end_date date,
    enrollment_status character varying(11) NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT chk_enrollment_date_range CHECK (((effective_end_date IS NULL) OR (effective_end_date >= effective_start_date)))
);


--
-- Name: student_face_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.student_face_profiles (
    id uuid NOT NULL,
    student_user_id uuid NOT NULL,
    registration_state character varying(17) DEFAULT 'UNREGISTERED'::character varying NOT NULL,
    active_model_version character varying(64),
    embedding_dimension smallint,
    sample_count smallint DEFAULT '0'::smallint NOT NULL,
    embedding_blob bytea,
    quality_score double precision,
    last_validated_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: subjects; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subjects (
    id uuid NOT NULL,
    code character varying(32) NOT NULL,
    name character varying(255) NOT NULL,
    department_id uuid NOT NULL,
    credits smallint NOT NULL,
    is_active boolean NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    institution_id uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid NOT NULL
);


--
-- Name: substitute_delegations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.substitute_delegations (
    id uuid NOT NULL,
    teaching_assignment_id uuid NOT NULL,
    substitute_faculty_user_id uuid NOT NULL,
    start_date date NOT NULL,
    end_date date NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    regular_faculty_user_id uuid NOT NULL,
    delegation_reason text NOT NULL,
    status character varying(7) DEFAULT 'ACTIVE'::character varying NOT NULL,
    created_by_user_id uuid NOT NULL,
    revoked_by_user_id uuid,
    revoked_at timestamp with time zone,
    revocation_reason text,
    CONSTRAINT chk_delegation_date_range CHECK ((end_date >= start_date)),
    CONSTRAINT chk_delegation_no_self CHECK ((substitute_faculty_user_id <> regular_faculty_user_id))
);


--
-- Name: teaching_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.teaching_assignments (
    id uuid NOT NULL,
    faculty_user_id uuid NOT NULL,
    class_section_id uuid NOT NULL,
    subject_id uuid NOT NULL,
    academic_term_id uuid NOT NULL,
    is_active boolean NOT NULL,
    created_by_user_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid NOT NULL,
    institutional_id character varying(64) NOT NULL,
    email character varying(255) NOT NULL,
    password_hash character varying(255) NOT NULL,
    full_name character varying(255) NOT NULL,
    role character varying(7) NOT NULL,
    account_status character varying(9) NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL
);


--
-- Name: academic_terms academic_terms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.academic_terms
    ADD CONSTRAINT academic_terms_pkey PRIMARY KEY (id);


--
-- Name: alembic_version alembic_version_pkc; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.alembic_version
    ADD CONSTRAINT alembic_version_pkc PRIMARY KEY (version_num);


--
-- Name: attendance_amendment_audits attendance_amendment_audits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_amendment_audits
    ADD CONSTRAINT attendance_amendment_audits_pkey PRIMARY KEY (id);


--
-- Name: attendance_records attendance_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_records
    ADD CONSTRAINT attendance_records_pkey PRIMARY KEY (id);


--
-- Name: attendance_sessions attendance_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_sessions
    ADD CONSTRAINT attendance_sessions_pkey PRIMARY KEY (id);


--
-- Name: authorization_audits authorization_audits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authorization_audits
    ADD CONSTRAINT authorization_audits_pkey PRIMARY KEY (id);


--
-- Name: campuses campuses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campuses
    ADD CONSTRAINT campuses_pkey PRIMARY KEY (id);


--
-- Name: class_sections class_sections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_sections
    ADD CONSTRAINT class_sections_pkey PRIMARY KEY (id);


--
-- Name: delegation_permissions delegation_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation_permissions
    ADD CONSTRAINT delegation_permissions_pkey PRIMARY KEY (delegation_id, permission_id);


--
-- Name: delegation_scopes delegation_scopes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation_scopes
    ADD CONSTRAINT delegation_scopes_pkey PRIMARY KEY (id);


--
-- Name: delegations delegations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegations
    ADD CONSTRAINT delegations_pkey PRIMARY KEY (id);


--
-- Name: department_campuses department_campuses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.department_campuses
    ADD CONSTRAINT department_campuses_pkey PRIMARY KEY (department_id, campus_id);


--
-- Name: departments departments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT departments_pkey PRIMARY KEY (id);


--
-- Name: institution_memberships institution_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.institution_memberships
    ADD CONSTRAINT institution_memberships_pkey PRIMARY KEY (id);


--
-- Name: institutions institutions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.institutions
    ADD CONSTRAINT institutions_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: permissions permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (id);


--
-- Name: report_export_audits report_export_audits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_export_audits
    ADD CONSTRAINT report_export_audits_pkey PRIMARY KEY (id);


--
-- Name: role_assignment_scopes role_assignment_scopes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_assignment_scopes
    ADD CONSTRAINT role_assignment_scopes_pkey PRIMARY KEY (id);


--
-- Name: role_assignments role_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_assignments
    ADD CONSTRAINT role_assignments_pkey PRIMARY KEY (id);


--
-- Name: role_permissions role_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (role_template_id, permission_id);


--
-- Name: role_templates role_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_templates
    ADD CONSTRAINT role_templates_pkey PRIMARY KEY (id);


--
-- Name: student_attendance_requests student_attendance_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_attendance_requests
    ADD CONSTRAINT student_attendance_requests_pkey PRIMARY KEY (id);


--
-- Name: student_enrollments student_enrollments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_enrollments
    ADD CONSTRAINT student_enrollments_pkey PRIMARY KEY (id);


--
-- Name: student_face_profiles student_face_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_face_profiles
    ADD CONSTRAINT student_face_profiles_pkey PRIMARY KEY (id);


--
-- Name: subjects subjects_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subjects
    ADD CONSTRAINT subjects_pkey PRIMARY KEY (id);


--
-- Name: substitute_delegations substitute_delegations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.substitute_delegations
    ADD CONSTRAINT substitute_delegations_pkey PRIMARY KEY (id);


--
-- Name: teaching_assignments teaching_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teaching_assignments
    ADD CONSTRAINT teaching_assignments_pkey PRIMARY KEY (id);


--
-- Name: academic_terms uq_academic_terms_inst_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.academic_terms
    ADD CONSTRAINT uq_academic_terms_inst_id UNIQUE (institution_id, id);


--
-- Name: attendance_sessions uq_assignment_session_slot; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_sessions
    ADD CONSTRAINT uq_assignment_session_slot UNIQUE (teaching_assignment_id, session_date, period_slot_or_sequence);


--
-- Name: attendance_sessions uq_attendance_session_client_uuid; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_sessions
    ADD CONSTRAINT uq_attendance_session_client_uuid UNIQUE (client_session_uuid);


--
-- Name: campuses uq_campus_institution_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campuses
    ADD CONSTRAINT uq_campus_institution_code UNIQUE (institution_id, code);


--
-- Name: campuses uq_campuses_inst_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campuses
    ADD CONSTRAINT uq_campuses_inst_id UNIQUE (institution_id, id);


--
-- Name: class_sections uq_class_sections_inst_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_sections
    ADD CONSTRAINT uq_class_sections_inst_id UNIQUE (institution_id, id);


--
-- Name: delegations uq_delegations_inst_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegations
    ADD CONSTRAINT uq_delegations_inst_id UNIQUE (institution_id, id);


--
-- Name: departments uq_department_institution_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT uq_department_institution_code UNIQUE (institution_id, code);


--
-- Name: departments uq_departments_inst_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT uq_departments_inst_id UNIQUE (institution_id, id);


--
-- Name: institution_memberships uq_membership_institution_user; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.institution_memberships
    ADD CONSTRAINT uq_membership_institution_user UNIQUE (institution_id, user_id);


--
-- Name: institution_memberships uq_memberships_inst_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.institution_memberships
    ADD CONSTRAINT uq_memberships_inst_id UNIQUE (institution_id, id);


--
-- Name: notifications uq_notifications_user_dedup; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT uq_notifications_user_dedup UNIQUE (user_id, deduplication_key);


--
-- Name: role_assignments uq_role_assignments_inst_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_assignments
    ADD CONSTRAINT uq_role_assignments_inst_id UNIQUE (institution_id, id);


--
-- Name: teaching_assignments uq_section_subject_term; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teaching_assignments
    ADD CONSTRAINT uq_section_subject_term UNIQUE (class_section_id, subject_id, academic_term_id);


--
-- Name: attendance_records uq_session_student_record; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_records
    ADD CONSTRAINT uq_session_student_record UNIQUE (attendance_session_id, student_user_id);


--
-- Name: student_face_profiles uq_student_face_profiles_student_user_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_face_profiles
    ADD CONSTRAINT uq_student_face_profiles_student_user_id UNIQUE (student_user_id);


--
-- Name: subjects uq_subject_institution_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subjects
    ADD CONSTRAINT uq_subject_institution_code UNIQUE (institution_id, code);


--
-- Name: subjects uq_subjects_inst_id; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subjects
    ADD CONSTRAINT uq_subjects_inst_id UNIQUE (institution_id, id);


--
-- Name: academic_terms uq_term_institution_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.academic_terms
    ADD CONSTRAINT uq_term_institution_code UNIQUE (institution_id, code);


--
-- Name: class_sections uq_term_section_code; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_sections
    ADD CONSTRAINT uq_term_section_code UNIQUE (academic_term_id, section_code);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: ix_academic_terms_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_academic_terms_code ON public.academic_terms USING btree (code);


--
-- Name: ix_academic_terms_institution_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_academic_terms_institution_id ON public.academic_terms USING btree (institution_id);


--
-- Name: ix_attendance_amendment_audits_client_amendment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_attendance_amendment_audits_client_amendment_id ON public.attendance_amendment_audits USING btree (client_amendment_id);


--
-- Name: ix_attendance_amendment_audits_session_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_attendance_amendment_audits_session_id ON public.attendance_amendment_audits USING btree (attendance_session_id);


--
-- Name: ix_attendance_amendment_audits_student_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_attendance_amendment_audits_student_id ON public.attendance_amendment_audits USING btree (student_user_id);


--
-- Name: ix_attendance_records_session_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_attendance_records_session_id ON public.attendance_records USING btree (attendance_session_id);


--
-- Name: ix_attendance_records_student_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_attendance_records_student_id ON public.attendance_records USING btree (student_user_id);


--
-- Name: ix_attendance_records_student_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_attendance_records_student_session ON public.attendance_records USING btree (student_user_id, attendance_session_id);


--
-- Name: ix_attendance_sessions_assignment_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_attendance_sessions_assignment_date ON public.attendance_sessions USING btree (teaching_assignment_id, session_date);


--
-- Name: ix_attendance_sessions_assignment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_attendance_sessions_assignment_id ON public.attendance_sessions USING btree (teaching_assignment_id);


--
-- Name: ix_attendance_sessions_client_uuid; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_attendance_sessions_client_uuid ON public.attendance_sessions USING btree (client_session_uuid);


--
-- Name: ix_attendance_sessions_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_attendance_sessions_date ON public.attendance_sessions USING btree (session_date);


--
-- Name: ix_attendance_sessions_payload_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_attendance_sessions_payload_hash ON public.attendance_sessions USING btree (payload_hash);


--
-- Name: ix_auth_audits_actor; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_auth_audits_actor ON public.authorization_audits USING btree (actor_user_id, created_at);


--
-- Name: ix_auth_audits_institution_action; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_auth_audits_institution_action ON public.authorization_audits USING btree (institution_id, action);


--
-- Name: ix_campuses_institution_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_campuses_institution_id ON public.campuses USING btree (institution_id);


--
-- Name: ix_class_sections_academic_term_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_class_sections_academic_term_id ON public.class_sections USING btree (academic_term_id);


--
-- Name: ix_class_sections_department_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_class_sections_department_id ON public.class_sections USING btree (department_id);


--
-- Name: ix_class_sections_institution_campus; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_class_sections_institution_campus ON public.class_sections USING btree (institution_id, campus_id);


--
-- Name: ix_delegations_grantee_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_delegations_grantee_status ON public.delegations USING btree (grantee_membership_id, status);


--
-- Name: ix_delegations_grantor_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_delegations_grantor_status ON public.delegations USING btree (grantor_role_assignment_id, status);


--
-- Name: ix_departments_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_departments_code ON public.departments USING btree (code);


--
-- Name: ix_departments_institution_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_departments_institution_id ON public.departments USING btree (institution_id);


--
-- Name: ix_institution_memberships_institution_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_institution_memberships_institution_id ON public.institution_memberships USING btree (institution_id);


--
-- Name: ix_institutions_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_institutions_code ON public.institutions USING btree (code);


--
-- Name: ix_membership_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_membership_user_status ON public.institution_memberships USING btree (user_id, status);


--
-- Name: ix_notifications_institution_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_notifications_institution_id ON public.notifications USING btree (institution_id);


--
-- Name: ix_notifications_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_notifications_user_id ON public.notifications USING btree (user_id);


--
-- Name: ix_notifications_user_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_notifications_user_unread ON public.notifications USING btree (user_id, is_read, created_at DESC);


--
-- Name: ix_permissions_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_permissions_code ON public.permissions USING btree (code);


--
-- Name: ix_permissions_resource; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_permissions_resource ON public.permissions USING btree (resource);


--
-- Name: ix_report_export_audits_teaching_assignment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_report_export_audits_teaching_assignment_id ON public.report_export_audits USING btree (teaching_assignment_id);


--
-- Name: ix_report_export_audits_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_report_export_audits_user_id ON public.report_export_audits USING btree (user_id);


--
-- Name: ix_role_assignment_scope_assignment_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_role_assignment_scope_assignment_type ON public.role_assignment_scopes USING btree (role_assignment_id, scope_type);


--
-- Name: ix_role_assignments_membership_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_role_assignments_membership_status ON public.role_assignments USING btree (membership_id, status);


--
-- Name: ix_role_templates_code; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_role_templates_code ON public.role_templates USING btree (code);


--
-- Name: ix_student_attendance_requests_assignment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_student_attendance_requests_assignment_id ON public.student_attendance_requests USING btree (teaching_assignment_id);


--
-- Name: ix_student_attendance_requests_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_student_attendance_requests_status ON public.student_attendance_requests USING btree (status);


--
-- Name: ix_student_attendance_requests_student_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_student_attendance_requests_student_id ON public.student_attendance_requests USING btree (student_user_id);


--
-- Name: ix_student_enrollments_academic_term_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_student_enrollments_academic_term_id ON public.student_enrollments USING btree (academic_term_id);


--
-- Name: ix_student_enrollments_class_section_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_student_enrollments_class_section_id ON public.student_enrollments USING btree (class_section_id);


--
-- Name: ix_student_enrollments_section_start; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_student_enrollments_section_start ON public.student_enrollments USING btree (class_section_id, effective_start_date);


--
-- Name: ix_student_enrollments_student_section; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_student_enrollments_student_section ON public.student_enrollments USING btree (student_user_id, class_section_id);


--
-- Name: ix_student_enrollments_student_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_student_enrollments_student_status ON public.student_enrollments USING btree (student_user_id, enrollment_status);


--
-- Name: ix_student_enrollments_student_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_student_enrollments_student_user_id ON public.student_enrollments USING btree (student_user_id);


--
-- Name: ix_student_face_profiles_registration_state; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_student_face_profiles_registration_state ON public.student_face_profiles USING btree (registration_state);


--
-- Name: ix_student_face_profiles_student_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_student_face_profiles_student_user_id ON public.student_face_profiles USING btree (student_user_id);


--
-- Name: ix_subjects_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_subjects_code ON public.subjects USING btree (code);


--
-- Name: ix_subjects_department_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_subjects_department_id ON public.subjects USING btree (department_id);


--
-- Name: ix_subjects_institution_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_subjects_institution_id ON public.subjects USING btree (institution_id);


--
-- Name: ix_substitute_delegations_regular_faculty_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_substitute_delegations_regular_faculty_user_id ON public.substitute_delegations USING btree (regular_faculty_user_id);


--
-- Name: ix_substitute_delegations_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_substitute_delegations_status ON public.substitute_delegations USING btree (status);


--
-- Name: ix_substitute_delegations_substitute_faculty_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_substitute_delegations_substitute_faculty_user_id ON public.substitute_delegations USING btree (substitute_faculty_user_id);


--
-- Name: ix_substitute_delegations_teaching_assignment_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_substitute_delegations_teaching_assignment_id ON public.substitute_delegations USING btree (teaching_assignment_id);


--
-- Name: ix_teaching_assignments_academic_term_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_teaching_assignments_academic_term_id ON public.teaching_assignments USING btree (academic_term_id);


--
-- Name: ix_teaching_assignments_class_section_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_teaching_assignments_class_section_id ON public.teaching_assignments USING btree (class_section_id);


--
-- Name: ix_teaching_assignments_faculty_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_teaching_assignments_faculty_user_id ON public.teaching_assignments USING btree (faculty_user_id);


--
-- Name: ix_teaching_assignments_subject_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ix_teaching_assignments_subject_id ON public.teaching_assignments USING btree (subject_id);


--
-- Name: ix_users_email; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_users_email ON public.users USING btree (email);


--
-- Name: ix_users_institutional_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ix_users_institutional_id ON public.users USING btree (institutional_id);


--
-- Name: uq_student_term_active_open; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_student_term_active_open ON public.student_enrollments USING btree (student_user_id, academic_term_id) WHERE (effective_end_date IS NULL);


--
-- Name: attendance_amendment_audits attendance_amendment_audits_amending_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_amendment_audits
    ADD CONSTRAINT attendance_amendment_audits_amending_user_id_fkey FOREIGN KEY (amending_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: attendance_amendment_audits attendance_amendment_audits_attendance_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_amendment_audits
    ADD CONSTRAINT attendance_amendment_audits_attendance_session_id_fkey FOREIGN KEY (attendance_session_id) REFERENCES public.attendance_sessions(id) ON DELETE RESTRICT;


--
-- Name: attendance_amendment_audits attendance_amendment_audits_student_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_amendment_audits
    ADD CONSTRAINT attendance_amendment_audits_student_user_id_fkey FOREIGN KEY (student_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: attendance_records attendance_records_attendance_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_records
    ADD CONSTRAINT attendance_records_attendance_session_id_fkey FOREIGN KEY (attendance_session_id) REFERENCES public.attendance_sessions(id) ON DELETE RESTRICT;


--
-- Name: attendance_records attendance_records_student_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_records
    ADD CONSTRAINT attendance_records_student_user_id_fkey FOREIGN KEY (student_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: attendance_sessions attendance_sessions_conducting_faculty_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_sessions
    ADD CONSTRAINT attendance_sessions_conducting_faculty_user_id_fkey FOREIGN KEY (conducting_faculty_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: attendance_sessions attendance_sessions_regular_faculty_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_sessions
    ADD CONSTRAINT attendance_sessions_regular_faculty_user_id_fkey FOREIGN KEY (regular_faculty_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: attendance_sessions attendance_sessions_substitute_delegation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_sessions
    ADD CONSTRAINT attendance_sessions_substitute_delegation_id_fkey FOREIGN KEY (substitute_delegation_id) REFERENCES public.substitute_delegations(id) ON DELETE SET NULL;


--
-- Name: attendance_sessions attendance_sessions_teaching_assignment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attendance_sessions
    ADD CONSTRAINT attendance_sessions_teaching_assignment_id_fkey FOREIGN KEY (teaching_assignment_id) REFERENCES public.teaching_assignments(id) ON DELETE RESTRICT;


--
-- Name: authorization_audits authorization_audits_actor_membership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authorization_audits
    ADD CONSTRAINT authorization_audits_actor_membership_id_fkey FOREIGN KEY (actor_membership_id) REFERENCES public.institution_memberships(id) ON DELETE SET NULL;


--
-- Name: authorization_audits authorization_audits_actor_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authorization_audits
    ADD CONSTRAINT authorization_audits_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: authorization_audits authorization_audits_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.authorization_audits
    ADD CONSTRAINT authorization_audits_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE SET NULL;


--
-- Name: campuses campuses_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.campuses
    ADD CONSTRAINT campuses_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: delegation_permissions delegation_permissions_delegation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation_permissions
    ADD CONSTRAINT delegation_permissions_delegation_id_fkey FOREIGN KEY (delegation_id) REFERENCES public.delegations(id) ON DELETE CASCADE;


--
-- Name: delegation_permissions delegation_permissions_permission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation_permissions
    ADD CONSTRAINT delegation_permissions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON DELETE CASCADE;


--
-- Name: delegation_scopes delegation_scopes_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation_scopes
    ADD CONSTRAINT delegation_scopes_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: delegation_scopes delegation_scopes_student_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation_scopes
    ADD CONSTRAINT delegation_scopes_student_user_id_fkey FOREIGN KEY (student_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: delegation_scopes delegation_scopes_teaching_assignment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation_scopes
    ADD CONSTRAINT delegation_scopes_teaching_assignment_id_fkey FOREIGN KEY (teaching_assignment_id) REFERENCES public.teaching_assignments(id) ON DELETE CASCADE;


--
-- Name: delegations delegations_approved_by_membership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegations
    ADD CONSTRAINT delegations_approved_by_membership_id_fkey FOREIGN KEY (approved_by_membership_id) REFERENCES public.institution_memberships(id) ON DELETE SET NULL;


--
-- Name: delegations delegations_revoked_by_membership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegations
    ADD CONSTRAINT delegations_revoked_by_membership_id_fkey FOREIGN KEY (revoked_by_membership_id) REFERENCES public.institution_memberships(id) ON DELETE SET NULL;


--
-- Name: academic_terms fk_academic_terms_institution_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.academic_terms
    ADD CONSTRAINT fk_academic_terms_institution_id FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE RESTRICT;


--
-- Name: class_sections fk_class_sections_inst_campus; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_sections
    ADD CONSTRAINT fk_class_sections_inst_campus FOREIGN KEY (institution_id, campus_id) REFERENCES public.campuses(institution_id, id) ON DELETE RESTRICT;


--
-- Name: class_sections fk_class_sections_inst_department; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_sections
    ADD CONSTRAINT fk_class_sections_inst_department FOREIGN KEY (institution_id, department_id) REFERENCES public.departments(institution_id, id) ON DELETE RESTRICT;


--
-- Name: class_sections fk_class_sections_inst_term; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_sections
    ADD CONSTRAINT fk_class_sections_inst_term FOREIGN KEY (institution_id, academic_term_id) REFERENCES public.academic_terms(institution_id, id) ON DELETE RESTRICT;


--
-- Name: class_sections fk_class_sections_institution_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.class_sections
    ADD CONSTRAINT fk_class_sections_institution_id FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE RESTRICT;


--
-- Name: delegation_scopes fk_delegation_scopes_inst_campus; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation_scopes
    ADD CONSTRAINT fk_delegation_scopes_inst_campus FOREIGN KEY (institution_id, campus_id) REFERENCES public.campuses(institution_id, id) ON DELETE CASCADE;


--
-- Name: delegation_scopes fk_delegation_scopes_inst_delegation; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation_scopes
    ADD CONSTRAINT fk_delegation_scopes_inst_delegation FOREIGN KEY (institution_id, delegation_id) REFERENCES public.delegations(institution_id, id) ON DELETE CASCADE;


--
-- Name: delegation_scopes fk_delegation_scopes_inst_department; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation_scopes
    ADD CONSTRAINT fk_delegation_scopes_inst_department FOREIGN KEY (institution_id, department_id) REFERENCES public.departments(institution_id, id) ON DELETE CASCADE;


--
-- Name: delegation_scopes fk_delegation_scopes_inst_section; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation_scopes
    ADD CONSTRAINT fk_delegation_scopes_inst_section FOREIGN KEY (institution_id, class_section_id) REFERENCES public.class_sections(institution_id, id) ON DELETE CASCADE;


--
-- Name: delegation_scopes fk_delegation_scopes_inst_term; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation_scopes
    ADD CONSTRAINT fk_delegation_scopes_inst_term FOREIGN KEY (institution_id, academic_term_id) REFERENCES public.academic_terms(institution_id, id) ON DELETE CASCADE;


--
-- Name: delegations fk_delegations_inst_grantee; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegations
    ADD CONSTRAINT fk_delegations_inst_grantee FOREIGN KEY (institution_id, grantee_membership_id) REFERENCES public.institution_memberships(institution_id, id) ON DELETE CASCADE;


--
-- Name: delegations fk_delegations_inst_grantor; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegations
    ADD CONSTRAINT fk_delegations_inst_grantor FOREIGN KEY (institution_id, grantor_role_assignment_id) REFERENCES public.role_assignments(institution_id, id) ON DELETE CASCADE;


--
-- Name: delegation_scopes fk_delg_scopes_inst_student_membership; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.delegation_scopes
    ADD CONSTRAINT fk_delg_scopes_inst_student_membership FOREIGN KEY (institution_id, student_user_id) REFERENCES public.institution_memberships(institution_id, user_id) ON DELETE CASCADE;


--
-- Name: departments fk_departments_institution_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.departments
    ADD CONSTRAINT fk_departments_institution_id FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: department_campuses fk_dept_campuses_inst_campus; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.department_campuses
    ADD CONSTRAINT fk_dept_campuses_inst_campus FOREIGN KEY (institution_id, campus_id) REFERENCES public.campuses(institution_id, id) ON DELETE CASCADE;


--
-- Name: department_campuses fk_dept_campuses_inst_department; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.department_campuses
    ADD CONSTRAINT fk_dept_campuses_inst_department FOREIGN KEY (institution_id, department_id) REFERENCES public.departments(institution_id, id) ON DELETE CASCADE;


--
-- Name: role_assignments fk_role_assignments_inst_membership; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_assignments
    ADD CONSTRAINT fk_role_assignments_inst_membership FOREIGN KEY (institution_id, membership_id) REFERENCES public.institution_memberships(institution_id, id) ON DELETE CASCADE;


--
-- Name: role_assignment_scopes fk_role_scopes_inst_assignment; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_assignment_scopes
    ADD CONSTRAINT fk_role_scopes_inst_assignment FOREIGN KEY (institution_id, role_assignment_id) REFERENCES public.role_assignments(institution_id, id) ON DELETE CASCADE;


--
-- Name: role_assignment_scopes fk_role_scopes_inst_campus; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_assignment_scopes
    ADD CONSTRAINT fk_role_scopes_inst_campus FOREIGN KEY (institution_id, campus_id) REFERENCES public.campuses(institution_id, id) ON DELETE CASCADE;


--
-- Name: role_assignment_scopes fk_role_scopes_inst_department; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_assignment_scopes
    ADD CONSTRAINT fk_role_scopes_inst_department FOREIGN KEY (institution_id, department_id) REFERENCES public.departments(institution_id, id) ON DELETE CASCADE;


--
-- Name: role_assignment_scopes fk_role_scopes_inst_section; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_assignment_scopes
    ADD CONSTRAINT fk_role_scopes_inst_section FOREIGN KEY (institution_id, class_section_id) REFERENCES public.class_sections(institution_id, id) ON DELETE CASCADE;


--
-- Name: role_assignment_scopes fk_role_scopes_inst_student_membership; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_assignment_scopes
    ADD CONSTRAINT fk_role_scopes_inst_student_membership FOREIGN KEY (institution_id, student_user_id) REFERENCES public.institution_memberships(institution_id, user_id) ON DELETE CASCADE;


--
-- Name: role_assignment_scopes fk_role_scopes_inst_term; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_assignment_scopes
    ADD CONSTRAINT fk_role_scopes_inst_term FOREIGN KEY (institution_id, academic_term_id) REFERENCES public.academic_terms(institution_id, id) ON DELETE CASCADE;


--
-- Name: subjects fk_subjects_inst_department; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subjects
    ADD CONSTRAINT fk_subjects_inst_department FOREIGN KEY (institution_id, department_id) REFERENCES public.departments(institution_id, id) ON DELETE RESTRICT;


--
-- Name: subjects fk_subjects_institution_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subjects
    ADD CONSTRAINT fk_subjects_institution_id FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: substitute_delegations fk_substitute_delegations_created_by_user_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.substitute_delegations
    ADD CONSTRAINT fk_substitute_delegations_created_by_user_id FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: substitute_delegations fk_substitute_delegations_regular_faculty_user_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.substitute_delegations
    ADD CONSTRAINT fk_substitute_delegations_regular_faculty_user_id FOREIGN KEY (regular_faculty_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: substitute_delegations fk_substitute_delegations_revoked_by_user_id; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.substitute_delegations
    ADD CONSTRAINT fk_substitute_delegations_revoked_by_user_id FOREIGN KEY (revoked_by_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: institution_memberships institution_memberships_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.institution_memberships
    ADD CONSTRAINT institution_memberships_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: institution_memberships institution_memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.institution_memberships
    ADD CONSTRAINT institution_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE RESTRICT;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: report_export_audits report_export_audits_teaching_assignment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_export_audits
    ADD CONSTRAINT report_export_audits_teaching_assignment_id_fkey FOREIGN KEY (teaching_assignment_id) REFERENCES public.teaching_assignments(id) ON DELETE SET NULL;


--
-- Name: report_export_audits report_export_audits_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_export_audits
    ADD CONSTRAINT report_export_audits_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: role_assignment_scopes role_assignment_scopes_institution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_assignment_scopes
    ADD CONSTRAINT role_assignment_scopes_institution_id_fkey FOREIGN KEY (institution_id) REFERENCES public.institutions(id) ON DELETE CASCADE;


--
-- Name: role_assignment_scopes role_assignment_scopes_student_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_assignment_scopes
    ADD CONSTRAINT role_assignment_scopes_student_user_id_fkey FOREIGN KEY (student_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: role_assignment_scopes role_assignment_scopes_teaching_assignment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_assignment_scopes
    ADD CONSTRAINT role_assignment_scopes_teaching_assignment_id_fkey FOREIGN KEY (teaching_assignment_id) REFERENCES public.teaching_assignments(id) ON DELETE CASCADE;


--
-- Name: role_assignments role_assignments_approved_by_membership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_assignments
    ADD CONSTRAINT role_assignments_approved_by_membership_id_fkey FOREIGN KEY (approved_by_membership_id) REFERENCES public.institution_memberships(id) ON DELETE SET NULL;


--
-- Name: role_assignments role_assignments_granted_by_membership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_assignments
    ADD CONSTRAINT role_assignments_granted_by_membership_id_fkey FOREIGN KEY (granted_by_membership_id) REFERENCES public.institution_memberships(id) ON DELETE SET NULL;


--
-- Name: role_assignments role_assignments_role_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_assignments
    ADD CONSTRAINT role_assignments_role_template_id_fkey FOREIGN KEY (role_template_id) REFERENCES public.role_templates(id) ON DELETE RESTRICT;


--
-- Name: role_permissions role_permissions_permission_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_permission_id_fkey FOREIGN KEY (permission_id) REFERENCES public.permissions(id) ON DELETE CASCADE;


--
-- Name: role_permissions role_permissions_role_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_template_id_fkey FOREIGN KEY (role_template_id) REFERENCES public.role_templates(id) ON DELETE CASCADE;


--
-- Name: student_attendance_requests student_attendance_requests_reviewer_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_attendance_requests
    ADD CONSTRAINT student_attendance_requests_reviewer_user_id_fkey FOREIGN KEY (reviewer_user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: student_attendance_requests student_attendance_requests_student_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_attendance_requests
    ADD CONSTRAINT student_attendance_requests_student_user_id_fkey FOREIGN KEY (student_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: student_attendance_requests student_attendance_requests_teaching_assignment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_attendance_requests
    ADD CONSTRAINT student_attendance_requests_teaching_assignment_id_fkey FOREIGN KEY (teaching_assignment_id) REFERENCES public.teaching_assignments(id) ON DELETE RESTRICT;


--
-- Name: student_enrollments student_enrollments_academic_term_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_enrollments
    ADD CONSTRAINT student_enrollments_academic_term_id_fkey FOREIGN KEY (academic_term_id) REFERENCES public.academic_terms(id) ON DELETE RESTRICT;


--
-- Name: student_enrollments student_enrollments_class_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_enrollments
    ADD CONSTRAINT student_enrollments_class_section_id_fkey FOREIGN KEY (class_section_id) REFERENCES public.class_sections(id) ON DELETE RESTRICT;


--
-- Name: student_enrollments student_enrollments_student_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_enrollments
    ADD CONSTRAINT student_enrollments_student_user_id_fkey FOREIGN KEY (student_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: student_face_profiles student_face_profiles_student_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.student_face_profiles
    ADD CONSTRAINT student_face_profiles_student_user_id_fkey FOREIGN KEY (student_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: substitute_delegations substitute_delegations_substitute_faculty_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.substitute_delegations
    ADD CONSTRAINT substitute_delegations_substitute_faculty_user_id_fkey FOREIGN KEY (substitute_faculty_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: substitute_delegations substitute_delegations_teaching_assignment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.substitute_delegations
    ADD CONSTRAINT substitute_delegations_teaching_assignment_id_fkey FOREIGN KEY (teaching_assignment_id) REFERENCES public.teaching_assignments(id) ON DELETE CASCADE;


--
-- Name: teaching_assignments teaching_assignments_academic_term_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teaching_assignments
    ADD CONSTRAINT teaching_assignments_academic_term_id_fkey FOREIGN KEY (academic_term_id) REFERENCES public.academic_terms(id) ON DELETE RESTRICT;


--
-- Name: teaching_assignments teaching_assignments_class_section_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teaching_assignments
    ADD CONSTRAINT teaching_assignments_class_section_id_fkey FOREIGN KEY (class_section_id) REFERENCES public.class_sections(id) ON DELETE RESTRICT;


--
-- Name: teaching_assignments teaching_assignments_created_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teaching_assignments
    ADD CONSTRAINT teaching_assignments_created_by_user_id_fkey FOREIGN KEY (created_by_user_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: teaching_assignments teaching_assignments_faculty_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teaching_assignments
    ADD CONSTRAINT teaching_assignments_faculty_user_id_fkey FOREIGN KEY (faculty_user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: teaching_assignments teaching_assignments_subject_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.teaching_assignments
    ADD CONSTRAINT teaching_assignments_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES public.subjects(id) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--

\unrestrict iyrZBCFfyRV6ml7jhxLB1XOC49eCmevIWaQHibTegQHrUQ9hgbljZmBWLZG5Xe4

