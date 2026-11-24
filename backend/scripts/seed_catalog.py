"""Institutional baseline seed script for local development and demonstration.

Populates academic terms, departments, subjects, class sections, faculty accounts,
teaching assignments, student accounts, and academic enrollments.
Strictly idempotent: safe to rerun multiple times without duplicating or corrupting data.
"""

import argparse
import asyncio
from datetime import date
import os
import sys
from typing import Any, Dict

# Ensure backend root is on sys.path for direct script execution
CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_ROOT = os.path.dirname(CURRENT_DIR)
if BACKEND_ROOT not in sys.path:
    sys.path.insert(0, BACKEND_ROOT)

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from src.config import get_settings
from src.core.security import get_password_hash
from src.models.academic import AcademicTerm, ClassSection, Department, Subject, TermStatus, DEFAULT_INSTITUTION_ID
from src.models.access_control import InstitutionMembership, MembershipStatus
from src.models.assignment import TeachingAssignment
from src.models.enrollment import EnrollmentStatus, FaceRegistrationStatus, StudentEnrollment, StudentFaceProfile
from src.models.user import AccountStatus, User, UserRole


async def seed_development_catalog(
    session: AsyncSession,
    default_password: str = "password",
    verbose: bool = False,
    auto_commit: bool = False,
) -> Dict[str, Any]:
    """
    Seed minimal institutional baseline for development and testing.
    Idempotent: Reuses existing records matching unique constraints without mutating passwords.
    """
    summary: Dict[str, Dict[str, int]] = {
        "created": {
            "departments": 0,
            "terms": 0,
            "subjects": 0,
            "sections": 0,
            "users": 0,
            "assignments": 0,
            "enrollments": 0,
            "face_profiles": 0,
        },
        "reused": {
            "departments": 0,
            "terms": 0,
            "subjects": 0,
            "sections": 0,
            "users": 0,
            "assignments": 0,
            "enrollments": 0,
            "face_profiles": 0,
        },
    }

    # 1. Department
    dept_stmt = select(Department).where(Department.code == "CSE")
    dept = (await session.execute(dept_stmt)).scalar_one_or_none()
    if not dept:
        dept = Department(
            code="CSE",
            name="Computer Science & Engineering",
        )
        session.add(dept)
        await session.flush()
        summary["created"]["departments"] += 1
        if verbose:
            print("  [+] Created Department: CSE")
    else:
        summary["reused"]["departments"] += 1
        if verbose:
            print("  [*] Reused Department: CSE")

    # 2. Academic Term
    term_stmt = select(AcademicTerm).where(AcademicTerm.code == "2026-FALL-SEM5")
    term = (await session.execute(term_stmt)).scalar_one_or_none()
    if not term:
        term = AcademicTerm(
            code="2026-FALL-SEM5",
            name="Fall Semester 2026 (Sem 5)",
            academic_year="2026-2027",
            start_date=date(2026, 9, 1),
            end_date=date(2026, 12, 20),
            status=TermStatus.ACTIVE,
        )
        session.add(term)
        await session.flush()
        summary["created"]["terms"] += 1
        if verbose:
            print("  [+] Created Academic Term: 2026-FALL-SEM5")
    else:
        summary["reused"]["terms"] += 1
        if verbose:
            print("  [*] Reused Academic Term: 2026-FALL-SEM5")

    # 3. Subjects
    subjects_spec = [
        {"code": "CS301", "name": "Data Structures", "credits": 4},
        {"code": "CS303", "name": "Operating Systems", "credits": 4},
        {"code": "CS305", "name": "Computer Networks", "credits": 3},
        {"code": "MA301", "name": "Discrete Mathematics", "credits": 4},
    ]
    subjects: Dict[str, Subject] = {}
    for s_spec in subjects_spec:
        sub_stmt = select(Subject).where(Subject.code == s_spec["code"])
        sub = (await session.execute(sub_stmt)).scalar_one_or_none()
        if not sub:
            sub = Subject(
                code=s_spec["code"],
                name=s_spec["name"],
                department_id=dept.id,
                credits=s_spec["credits"],
                is_active=True,
            )
            session.add(sub)
            await session.flush()
            summary["created"]["subjects"] += 1
            if verbose:
                print(f"  [+] Created Subject: {sub.code}")
        else:
            summary["reused"]["subjects"] += 1
            if verbose:
                print(f"  [*] Reused Subject: {sub.code}")
        subjects[s_spec["code"]] = sub

    # 4. Class Sections
    sections_spec = [
        {"section_code": "CSE-3A", "cohort_year": 2024},
        {"section_code": "CSE-3B", "cohort_year": 2024},
    ]
    sections: Dict[str, ClassSection] = {}
    for sec_spec in sections_spec:
        sec_stmt = select(ClassSection).where(
            ClassSection.academic_term_id == term.id,
            ClassSection.section_code == sec_spec["section_code"],
        )
        sec = (await session.execute(sec_stmt)).scalar_one_or_none()
        if not sec:
            sec = ClassSection(
                section_code=sec_spec["section_code"],
                department_id=dept.id,
                academic_term_id=term.id,
                cohort_year=sec_spec["cohort_year"],
            )
            session.add(sec)
            await session.flush()
            summary["created"]["sections"] += 1
            if verbose:
                print(f"  [+] Created Class Section: {sec.section_code}")
        else:
            summary["reused"]["sections"] += 1
            if verbose:
                print(f"  [*] Reused Class Section: {sec.section_code}")
        sections[sec_spec["section_code"]] = sec

    # 5. Users (Admin, Faculty, Students)
    hashed_dev_password = get_password_hash(default_password)
    users_spec = [
        # Admin
        {
            "institutional_id": "admin_meera",
            "email": "admin@attendly.edu",
            "full_name": "Dr. Meera Joshi",
            "role": UserRole.ADMIN,
        },
        # Faculty Alan Turing
        {
            "institutional_id": "prof_alan",
            "email": "prof_alan@attendly.edu",
            "full_name": "Prof. Alan Turing",
            "role": UserRole.FACULTY,
        },
        # Faculty Ada Lovelace
        {
            "institutional_id": "prof_ada",
            "email": "prof_ada@attendly.edu",
            "full_name": "Prof. Ada Lovelace",
            "role": UserRole.FACULTY,
        },
        # Faculty Grace Hopper
        {
            "institutional_id": "prof_grace",
            "email": "prof_grace@attendly.edu",
            "full_name": "Prof. Grace Hopper",
            "role": UserRole.FACULTY,
        },
        # Student S1 (Active from Day 1, Face Registered)
        {
            "institutional_id": "S1",
            "email": "student_s1@attendly.edu",
            "full_name": "Student S1",
            "role": UserRole.STUDENT,
        },
        # Student S2 (Late Admission from 2026-09-20, Face Registered)
        {
            "institutional_id": "S2",
            "email": "student_s2@attendly.edu",
            "full_name": "Student S2",
            "role": UserRole.STUDENT,
        },
        # Student S3 (Active from Day 1, Face UNREGISTERED)
        {
            "institutional_id": "S3",
            "email": "student_s3@attendly.edu",
            "full_name": "Student S3",
            "role": UserRole.STUDENT,
        },
    ]

    users: Dict[str, User] = {}
    for u_spec in users_spec:
        u_stmt = select(User).where(
            (User.institutional_id == u_spec["institutional_id"]) | (User.email == u_spec["email"])
        )
        u = (await session.execute(u_stmt)).scalar_one_or_none()
        if not u:
            u = User(
                institutional_id=u_spec["institutional_id"],
                email=u_spec["email"],
                password_hash=hashed_dev_password,
                full_name=u_spec["full_name"],
                role=u_spec["role"],
                account_status=AccountStatus.ACTIVE,
            )
            session.add(u)
            await session.flush()
            summary["created"]["users"] += 1
            if verbose:
                print(f"  [+] Created User: {u.institutional_id} ({u.role.value})")
        else:
            summary["reused"]["users"] += 1
            if verbose:
                print(f"  [*] Reused User: {u.institutional_id} ({u.role.value})")
        users[u_spec["institutional_id"]] = u

        # Ensure active institution membership exists for user
        mem_stmt = select(InstitutionMembership).where(
            InstitutionMembership.institution_id == DEFAULT_INSTITUTION_ID,
            InstitutionMembership.user_id == u.id,
        )
        mem = (await session.execute(mem_stmt)).scalar_one_or_none()
        if not mem:
            mem = InstitutionMembership(
                institution_id=DEFAULT_INSTITUTION_ID,
                user_id=u.id,
                status=MembershipStatus.ACTIVE,
            )
            session.add(mem)
            await session.flush()

    # 6. Student Face Profiles
    face_profiles_spec = [
        {
            "student_id": "S1",
            "state": FaceRegistrationStatus.REGISTERED,
            "model_version": "edgeface_xs_v1",
            "samples": 3,
            "quality": 0.94,
        },
        {
            "student_id": "S2",
            "state": FaceRegistrationStatus.REGISTERED,
            "model_version": "edgeface_xs_v1",
            "samples": 3,
            "quality": 0.91,
        },
        {
            "student_id": "S3",
            "state": FaceRegistrationStatus.UNREGISTERED,
            "model_version": None,
            "samples": 0,
            "quality": None,
        },
    ]
    for fp_spec in face_profiles_spec:
        stu_user = users[fp_spec["student_id"]]
        fp_stmt = select(StudentFaceProfile).where(StudentFaceProfile.student_user_id == stu_user.id)
        fp = (await session.execute(fp_stmt)).scalar_one_or_none()
        if not fp:
            fp = StudentFaceProfile(
                student_user_id=stu_user.id,
                registration_state=fp_spec["state"],
                active_model_version=fp_spec["model_version"],
                embedding_dimension=512 if fp_spec["model_version"] else None,
                sample_count=fp_spec["samples"],
                quality_score=fp_spec["quality"],
            )
            session.add(fp)
            await session.flush()
            summary["created"]["face_profiles"] += 1
            if verbose:
                print(f"  [+] Created Face Profile for {stu_user.institutional_id}: {fp.registration_state.value}")
        else:
            summary["reused"]["face_profiles"] += 1
            if verbose:
                print(f"  [*] Reused Face Profile for {stu_user.institutional_id}: {fp.registration_state.value}")

    # 7. Teaching Assignments
    admin_user = users["admin_meera"]
    assignments_spec = [
        # Alan -> CS301 in CSE-3A
        {"faculty_id": "prof_alan", "subject_code": "CS301", "section_code": "CSE-3A"},
        # Ada -> CS301 in CSE-3B
        {"faculty_id": "prof_ada", "subject_code": "CS301", "section_code": "CSE-3B"},
        # Alan -> CS303 in CSE-3A
        {"faculty_id": "prof_alan", "subject_code": "CS303", "section_code": "CSE-3A"},
    ]
    for ta_spec in assignments_spec:
        fac = users[ta_spec["faculty_id"]]
        sub = subjects[ta_spec["subject_code"]]
        sec = sections[ta_spec["section_code"]]

        ta_stmt = select(TeachingAssignment).where(
            TeachingAssignment.class_section_id == sec.id,
            TeachingAssignment.subject_id == sub.id,
            TeachingAssignment.academic_term_id == term.id,
        )
        ta = (await session.execute(ta_stmt)).scalar_one_or_none()
        if not ta:
            ta = TeachingAssignment(
                faculty_user_id=fac.id,
                class_section_id=sec.id,
                subject_id=sub.id,
                academic_term_id=term.id,
                is_active=True,
                created_by_user_id=admin_user.id,
            )
            session.add(ta)
            await session.flush()
            summary["created"]["assignments"] += 1
            if verbose:
                print(f"  [+] Created Assignment: {fac.institutional_id} -> {sub.code} ({sec.section_code})")
        else:
            summary["reused"]["assignments"] += 1
            if verbose:
                print(f"  [*] Reused Assignment: {fac.institutional_id} -> {sub.code} ({sec.section_code})")

    # 8. Student Enrollments
    sec_3a = sections["CSE-3A"]
    enrollments_spec = [
        # S1: Enrolled Sept 1, 2026
        {"student_id": "S1", "start_date": date(2026, 9, 1), "end_date": None},
        # S2: Enrolled Sept 20, 2026 (Late admission)
        {"student_id": "S2", "start_date": date(2026, 9, 20), "end_date": None},
        # S3: Enrolled Sept 1, 2026
        {"student_id": "S3", "start_date": date(2026, 9, 1), "end_date": None},
    ]
    for enr_spec in enrollments_spec:
        stu = users[enr_spec["student_id"]]
        enr_stmt = select(StudentEnrollment).where(
            StudentEnrollment.student_user_id == stu.id,
            StudentEnrollment.class_section_id == sec_3a.id,
            StudentEnrollment.academic_term_id == term.id,
        )
        enr = (await session.execute(enr_stmt)).scalar_one_or_none()
        if not enr:
            enr = StudentEnrollment(
                student_user_id=stu.id,
                class_section_id=sec_3a.id,
                academic_term_id=term.id,
                effective_start_date=enr_spec["start_date"],
                effective_end_date=enr_spec["end_date"],
                enrollment_status=EnrollmentStatus.ACTIVE,
            )
            session.add(enr)
            await session.flush()
            summary["created"]["enrollments"] += 1
            if verbose:
                print(f"  [+] Enrolled {stu.institutional_id} in {sec_3a.section_code} from {enr.effective_start_date}")
        else:
            summary["reused"]["enrollments"] += 1
            if verbose:
                print(f"  [*] Reused Enrollment for {stu.institutional_id} in {sec_3a.section_code}")

    await session.flush()
    if auto_commit:
        await session.commit()
    return summary


async def main() -> None:
    parser = argparse.ArgumentParser(description="Seed Attendly academic catalog & development accounts.")
    parser.add_argument("--env", default="development", choices=["development", "test", "production"], help="Environment")
    parser.add_argument("--password", default=os.getenv("ATTENDLY_DEV_PASSWORD", "password"), help="Default account password")
    parser.add_argument("--force-production", action="store_true", help="Force execution even if env=production")
    parser.add_argument("--verbose", "-v", action="store_true", help="Verbose output")

    args = parser.parse_args()

    if args.env == "production" and not args.force_production:
        print("[ERROR] Refusing to seed production database without explicit --force-production flag.")
        sys.exit(1)

    settings = get_settings()
    engine = create_async_engine(settings.DATABASE_URL, echo=False)

    print(f"=== Attendly Academic Catalog Seed ===")
    print(f"Environment: {args.env}")
    print(f"Database:    {settings.DATABASE_URL.split('@')[-1]}")
    print("---------------------------------------")

    async with engine.begin() as conn:
        from src.models.base import Base
        await conn.run_sync(Base.metadata.create_all)

    async with AsyncSession(engine) as session:
        summary = await seed_development_catalog(
            session,
            default_password=args.password,
            verbose=args.verbose,
            auto_commit=True,
        )

    print("\nSeed Summary:")
    print(f"  Created: {summary['created']}")
    print(f"  Reused:  {summary['reused']}")
    print("=======================================")
    print("Ready for Quickstart validation scenarios!")

    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
