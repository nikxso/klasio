"""Database Seeding Script for Rich Institutional Combinations.
Populates departments, terms, subjects, class sections, users, assignments, enrollments,
attendance sessions, attendance records, requests, and notifications directly into PostgreSQL.
Strictly idempotent.
"""
import asyncio
from datetime import date, datetime, timezone, timedelta
import os
import sys
import uuid

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_ROOT = os.path.dirname(CURRENT_DIR)
if BACKEND_ROOT not in sys.path:
    sys.path.insert(0, BACKEND_ROOT)

from sqlalchemy import select, and_
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from src.config import get_settings
from src.core.security import get_password_hash
from src.models.academic import AcademicTerm, ClassSection, Department, Subject, TermStatus, DEFAULT_INSTITUTION_ID
from src.models.assignment import TeachingAssignment, SubstituteDelegation, DelegationStatus
from src.models.enrollment import EnrollmentStatus, FaceRegistrationStatus, StudentEnrollment, StudentFaceProfile
from src.models.attendance import (
    AttendanceSession,
    AttendanceRecord,
    AttendanceStatus,
    AttendanceSessionStatus,
    SessionApplicability,
    MarkSource,
    StudentAttendanceRequest,
    AttendanceRequestStatus,
)
from src.models.notification import Notification, NotificationCategory, NotificationPriority
from src.models.user import AccountStatus, User, UserRole


async def seed_rich_combinations(session: AsyncSession):
    print(">>> Seeding rich institutional combinations into PostgreSQL...")
    default_pw_hash = get_password_hash("password")

    # 1. Departments
    dept_specs = [
        {"code": "CSE", "name": "Computer Science & Engineering"},
        {"code": "ECE", "name": "Electronics & Communication Engineering"},
        {"code": "MECH", "name": "Mechanical Engineering"},
        {"code": "MATH", "name": "Mathematics & Basic Sciences"},
    ]
    departments = {}
    for spec in dept_specs:
        res = await session.execute(select(Department).where(Department.code == spec["code"]))
        dept = res.scalar_one_or_none()
        if not dept:
            dept = Department(code=spec["code"], name=spec["name"])
            session.add(dept)
            await session.flush()
            print(f"  [+] Created Department: {spec['code']}")
        departments[spec["code"]] = dept

    # 2. Academic Terms
    term_res = await session.execute(select(AcademicTerm).where(AcademicTerm.code == "2026-FALL-SEM5"))
    term = term_res.scalar_one_or_none()
    if not term:
        term = AcademicTerm(
            code="2026-FALL-SEM5",
            name="Fall Semester 2026 (Sem 5)",
            academic_year="2026-2027",
            start_date=date(2026, 8, 1),
            end_date=date(2026, 12, 20),
            status=TermStatus.ACTIVE,
        )
        session.add(term)
        await session.flush()
        print(f"  [+] Created Academic Term: {term.code}")

    # 3. Class Sections (use existing CSE-3A, CSE-3B)
    section_specs = [
        {"code": "CSE-3A", "dept": "CSE", "cohort": 2024},
        {"code": "CSE-3B", "dept": "CSE", "cohort": 2024},
        {"code": "ECE-2A", "dept": "ECE", "cohort": 2025},
    ]
    sections = {}
    for spec in section_specs:
        res = await session.execute(
            select(ClassSection).where(
                and_(
                    ClassSection.academic_term_id == term.id,
                    ClassSection.section_code == spec["code"],
                )
            )
        )
        sec = res.scalar_one_or_none()
        if not sec:
            sec = ClassSection(
                section_code=spec["code"],
                department_id=departments[spec["dept"]].id,
                academic_term_id=term.id,
                cohort_year=spec["cohort"],
            )
            session.add(sec)
            await session.flush()
            print(f"  [+] Created Class Section: {spec['code']}")
        sections[spec["code"]] = sec

    # 4. Subjects
    subject_specs = [
        {"code": "CS301", "name": "Data Structures", "dept": "CSE", "credits": 4},
        {"code": "CS303", "name": "Operating Systems", "dept": "CSE", "credits": 4},
        {"code": "CS305", "name": "Computer Networks", "dept": "CSE", "credits": 3},
        {"code": "CS351", "name": "Data Structures Lab", "dept": "CSE", "credits": 2},
        {"code": "EC201", "name": "Signals & Systems", "dept": "ECE", "credits": 4},
        {"code": "ME401", "name": "Thermodynamics", "dept": "MECH", "credits": 3},
        {"code": "MA301", "name": "Discrete Mathematics", "dept": "MATH", "credits": 4},
    ]
    subjects = {}
    for spec in subject_specs:
        res = await session.execute(select(Subject).where(Subject.code == spec["code"]))
        sub = res.scalar_one_or_none()
        if not sub:
            sub = Subject(
                code=spec["code"],
                name=spec["name"],
                department_id=departments[spec["dept"]].id,
                credits=spec["credits"],
                is_active=True,
            )
            session.add(sub)
            await session.flush()
            print(f"  [+] Created Subject: {spec['code']}")
        subjects[spec["code"]] = sub

    # 5. Users (Admin, Faculty, Students)
    user_specs = [
        # Admin
        {"email": "admin@attendly.edu", "inst_id": "admin_meera", "name": "Dr. Meera Joshi", "role": UserRole.ADMIN},
        # Faculty
        {"email": "prof_alan@attendly.edu", "inst_id": "prof_alan", "name": "Prof. Alan Turing", "role": UserRole.FACULTY},
        {"email": "prof_ada@attendly.edu", "inst_id": "prof_ada", "name": "Prof. Ada Lovelace", "role": UserRole.FACULTY},
        {"email": "prof_grace@attendly.edu", "inst_id": "prof_grace", "name": "Prof. Grace Hopper", "role": UserRole.FACULTY},
        {"email": "dr_lakshmi@attendly.edu", "inst_id": "fac_lakshmi", "name": "Dr. Lakshmi Iyer", "role": UserRole.FACULTY},
        {"email": "prof_rahul@attendly.edu", "inst_id": "fac_rahul", "name": "Prof. Rahul Menon", "role": UserRole.FACULTY},
        # Students
        {"email": "student_s1@attendly.edu", "inst_id": "S1", "name": "Student S1", "role": UserRole.STUDENT},
        {"email": "student_s2@attendly.edu", "inst_id": "S2", "name": "Student S2", "role": UserRole.STUDENT},
        {"email": "student_s3@attendly.edu", "inst_id": "S3", "name": "Student S3", "role": UserRole.STUDENT},
        {"email": "student_s4@attendly.edu", "inst_id": "S4", "name": "Student S4 (Sec B)", "role": UserRole.STUDENT},
        {"email": "aarav@attendly.edu", "inst_id": "21CS031", "name": "Aarav Sharma", "role": UserRole.STUDENT},
        {"email": "priya@attendly.edu", "inst_id": "21CS032", "name": "Priya Nair", "role": UserRole.STUDENT},
        {"email": "rohan@attendly.edu", "inst_id": "21CS033", "name": "Rohan Mehta", "role": UserRole.STUDENT},
        {"email": "ananya@attendly.edu", "inst_id": "21CS034", "name": "Ananya Iyer", "role": UserRole.STUDENT},
        {"email": "diya@attendly.edu", "inst_id": "21CS035", "name": "Diya Patel", "role": UserRole.STUDENT},
        {"email": "karan@attendly.edu", "inst_id": "21CS036", "name": "Karan Malhotra", "role": UserRole.STUDENT},
    ]
    users = {}
    for spec in user_specs:
        res = await session.execute(
            select(User).where((User.institutional_id == spec["inst_id"]) | (User.email == spec["email"]))
        )
        u = res.scalar_one_or_none()
        if not u:
            u = User(
                institutional_id=spec["inst_id"],
                email=spec["email"],
                password_hash=default_pw_hash,
                full_name=spec["name"],
                role=spec["role"],
                account_status=AccountStatus.ACTIVE,
            )
            session.add(u)
            await session.flush()
            print(f"  [+] Created User: {spec['name']} ({spec['role'].value})")
        else:
            u.full_name = spec["name"]
            u.role = spec["role"]
            await session.flush()
        users[spec["inst_id"]] = u

    # 6. Face profiles for students
    registered_student_ids = ["S1", "S2", "S3", "21CS031", "21CS032", "21CS033", "21CS034", "21CS035", "21CS036"]
    for sid in registered_student_ids:
        stu_u = users[sid]
        fp_res = await session.execute(
            select(StudentFaceProfile).where(StudentFaceProfile.student_user_id == stu_u.id)
        )
        fp = fp_res.scalar_one_or_none()
        if not fp:
            fp = StudentFaceProfile(
                student_user_id=stu_u.id,
                registration_state=FaceRegistrationStatus.REGISTERED,
                active_model_version="edgeface_xs_v1",
                embedding_dimension=512,
                sample_count=3,
                quality_score=0.92,
            )
            session.add(fp)
            await session.flush()
            print(f"  [+] Created Face Profile: {sid}")

    # 7. Student Enrollments into CSE-3A
    sec_3a = sections["CSE-3A"]
    students_for_3a = ["S1", "S2", "S3", "21CS031", "21CS032", "21CS033", "21CS034", "21CS035", "21CS036"]
    for sid in students_for_3a:
        stu_u = users[sid]
        enr_res = await session.execute(
            select(StudentEnrollment).where(
                and_(
                    StudentEnrollment.student_user_id == stu_u.id,
                    StudentEnrollment.academic_term_id == term.id,
                )
            )
        )
        enr = enr_res.scalar_one_or_none()
        if not enr:
            enr = StudentEnrollment(
                student_user_id=stu_u.id,
                class_section_id=sec_3a.id,
                academic_term_id=term.id,
                effective_start_date=date(2026, 8, 1),
                enrollment_status=EnrollmentStatus.ACTIVE,
            )
            session.add(enr)
            await session.flush()
            print(f"  [+] Enrolled {sid} into CSE-3A")
        elif enr.class_section_id != sec_3a.id:
            enr.class_section_id = sec_3a.id
            await session.flush()

    # Enroll S4 into CSE-3B
    sec_3b = sections["CSE-3B"]
    enr_b_res = await session.execute(
        select(StudentEnrollment).where(
            and_(
                StudentEnrollment.student_user_id == users["S4"].id,
                StudentEnrollment.academic_term_id == term.id,
            )
        )
    )
    if not enr_b_res.scalar_one_or_none():
        session.add(
            StudentEnrollment(
                student_user_id=users["S4"].id,
                class_section_id=sec_3b.id,
                academic_term_id=term.id,
                effective_start_date=date(2026, 8, 1),
                enrollment_status=EnrollmentStatus.ACTIVE,
            )
        )
        await session.flush()

    # 8. Teaching Assignments
    admin_u = users["admin_meera"]
    ta_specs = [
        {"fac": "prof_alan", "sub": "CS301", "sec": "CSE-3A"},
        {"fac": "prof_alan", "sub": "CS303", "sec": "CSE-3A"},
        {"fac": "fac_lakshmi", "sub": "CS351", "sec": "CSE-3A"},
        {"fac": "prof_grace", "sub": "CS305", "sec": "CSE-3A"},
        {"fac": "prof_ada", "sub": "CS301", "sec": "CSE-3B"},
        {"fac": "fac_rahul", "sub": "CS303", "sec": "CSE-3B"},
    ]
    assignments = {}
    for spec in ta_specs:
        fac_u = users[spec["fac"]]
        sub = subjects[spec["sub"]]
        sec = sections[spec["sec"]]
        key = f"{spec['fac']}_{spec['sub']}_{spec['sec']}"
        res = await session.execute(
            select(TeachingAssignment).where(
                and_(
                    TeachingAssignment.class_section_id == sec.id,
                    TeachingAssignment.subject_id == sub.id,
                    TeachingAssignment.academic_term_id == term.id,
                )
            )
        )
        ta = res.scalar_one_or_none()
        if not ta:
            ta = TeachingAssignment(
                faculty_user_id=fac_u.id,
                class_section_id=sec.id,
                subject_id=sub.id,
                academic_term_id=term.id,
                is_active=True,
                created_by_user_id=admin_u.id,
            )
            session.add(ta)
            await session.flush()
            print(f"  [+] Created Teaching Assignment: {spec['fac']} -> {spec['sub']} ({spec['sec']})")
        else:
            ta.faculty_user_id = fac_u.id
            ta.is_active = True
            await session.flush()
        assignments[key] = ta

    # 9. Substitute Delegation: Alan Turing delegates CS303 in CSE-3A to Rahul Menon
    ta_alan_os = assignments.get("prof_alan_CS303_CSE-3A")
    if ta_alan_os:
        del_res = await session.execute(
            select(SubstituteDelegation).where(
                and_(
                    SubstituteDelegation.teaching_assignment_id == ta_alan_os.id,
                    SubstituteDelegation.substitute_faculty_user_id == users["fac_rahul"].id,
                )
            )
        )
        delg = del_res.scalar_one_or_none()
        if not delg:
            delg = SubstituteDelegation(
                teaching_assignment_id=ta_alan_os.id,
                regular_faculty_user_id=users["prof_alan"].id,
                substitute_faculty_user_id=users["fac_rahul"].id,
                start_date=date(2026, 10, 1),
                end_date=date(2026, 11, 30),
                delegation_reason="Attending international research conference & doctoral symposium",
                status=DelegationStatus.ACTIVE,
                created_by_user_id=users["prof_alan"].id,
            )
            session.add(delg)
            await session.flush()
            print(f"  [+] Created Substitute Delegation: Alan -> Rahul for CS303")

    # 10. Attendance Sessions & Records
    ta_alan_ds = assignments.get("prof_alan_CS301_CSE-3A")
    ta_lakshmi_lab = assignments.get("fac_lakshmi_CS351_CSE-3A")
    ta_grace_cn = assignments.get("prof_grace_CS305_CSE-3A")

    session_specs = [
        {"ta": ta_alan_ds, "date": date(2026, 10, 12), "slot": 1},
        {"ta": ta_alan_os, "date": date(2026, 10, 15), "slot": 2},
        {"ta": ta_alan_ds, "date": date(2026, 10, 19), "slot": 1},
        {"ta": ta_alan_os, "date": date(2026, 10, 22), "slot": 2},
        {"ta": ta_alan_ds, "date": date(2026, 10, 26), "slot": 1},
        {"ta": ta_grace_cn, "date": date(2026, 10, 28), "slot": 3},
        {"ta": ta_alan_os, "date": date(2026, 10, 29), "slot": 2},
        {"ta": ta_alan_ds, "date": date(2026, 10, 31), "slot": 2},
        {"ta": ta_lakshmi_lab, "date": date(2026, 10, 31), "slot": 3},
        {"ta": ta_alan_os, "date": date(2026, 11, 2), "slot": 1},
        {"ta": ta_alan_ds, "date": date(2026, 11, 3), "slot": 1},
    ]

    for s_spec in session_specs:
        ta_target = s_spec["ta"]
        if not ta_target:
            continue
        s_date = s_spec["date"]
        s_slot = s_spec["slot"]

        res = await session.execute(
            select(AttendanceSession).where(
                and_(
                    AttendanceSession.teaching_assignment_id == ta_target.id,
                    AttendanceSession.session_date == s_date,
                    AttendanceSession.period_slot_or_sequence == s_slot,
                )
            )
        )
        att_sess = res.scalar_one_or_none()
        if not att_sess:
            att_sess = AttendanceSession(
                client_session_uuid=uuid.uuid4(),
                teaching_assignment_id=ta_target.id,
                session_date=s_date,
                period_slot_or_sequence=s_slot,
                applicability_status=SessionApplicability.COUNTED,
                session_status=AttendanceSessionStatus.FINALIZED,
                finalized_at=datetime.now(timezone.utc),
                regular_faculty_user_id=ta_target.faculty_user_id,
                conducting_faculty_user_id=ta_target.faculty_user_id,
                records_count=len(students_for_3a),
                present_count=len(students_for_3a) - 1,
                absent_count=1,
                excused_count=0,
            )
            session.add(att_sess)
            await session.flush()
            print(f"  [+] Created Attendance Session: {s_date} Slot {s_slot} for assignment {ta_target.id}")

            # Populate records for all enrolled students
            for idx, sid in enumerate(students_for_3a):
                stu_u = users[sid]
                if sid == "S3":
                    if s_date == date(2026, 11, 2):
                        status = AttendanceStatus.ABSENT
                    elif s_date == date(2026, 10, 29):
                        status = AttendanceStatus.EXCUSED
                    else:
                        status = AttendanceStatus.PRESENT
                elif sid == "21CS036":
                    status = AttendanceStatus.ABSENT if idx % 2 == 0 else AttendanceStatus.PRESENT
                else:
                    status = AttendanceStatus.PRESENT if (idx + s_slot) % 5 != 0 else AttendanceStatus.ABSENT

                rec = AttendanceRecord(
                    attendance_session_id=att_sess.id,
                    student_user_id=stu_u.id,
                    attendance_status=status,
                    mark_source=MarkSource.AI_VERIFIED if status == AttendanceStatus.PRESENT else MarkSource.MANUAL_MARK,
                    candidate_confidence=0.96 if status == AttendanceStatus.PRESENT else None,
                    recorded_at=datetime.now(timezone.utc),
                )
                session.add(rec)
            await session.flush()

    # 11. Student Attendance Grievance Requests
    s3_u = users["S3"]
    req_res = await session.execute(
        select(StudentAttendanceRequest).where(StudentAttendanceRequest.student_user_id == s3_u.id)
    )
    if not req_res.scalar_one_or_none():
        req_pending = StudentAttendanceRequest(
            student_user_id=s3_u.id,
            teaching_assignment_id=ta_alan_os.id,
            session_date=date(2026, 11, 2),
            student_note="I was present in Period 1 but sat in the back row during camera scan. Please verify my attendance.",
            status=AttendanceRequestStatus.PENDING,
        )
        session.add(req_pending)

        s1_u = users["S1"]
        req_approved = StudentAttendanceRequest(
            student_user_id=s1_u.id,
            teaching_assignment_id=ta_alan_ds.id,
            session_date=date(2026, 10, 29),
            student_note="Medical certificate submitted for dengue recovery.",
            status=AttendanceRequestStatus.APPROVED,
            reviewer_user_id=users["prof_alan"].id,
            resolution_note="Medical certificate verified with college clinic. Attendance marked Excused.",
            resolved_at=datetime.now(timezone.utc) - timedelta(days=2),
        )
        session.add(req_approved)
        await session.flush()
        print("  [+] Created Student Attendance Requests (1 PENDING, 1 APPROVED)")

    # 12. Notifications
    notif_res = await session.execute(
        select(Notification).where(Notification.user_id == s3_u.id)
    )
    if not notif_res.scalar_one_or_none():
        session.add(
            Notification(
                user_id=s3_u.id,
                title="Attendance Marked",
                message="Your attendance for CS301 (Data Structures) on Oct 31 was recorded as PRESENT.",
                category=NotificationCategory.ATTENDANCE,
                priority=NotificationPriority.NORMAL,
                is_read=False,
            )
        )
        session.add(
            Notification(
                user_id=users["prof_alan"].id,
                title="New Grievance Request",
                message="Student S3 has submitted an attendance grievance for Nov 2, Period 1.",
                category=NotificationCategory.REQUEST,
                priority=NotificationPriority.HIGH,
                is_read=False,
            )
        )
        session.add(
            Notification(
                user_id=users["admin_meera"].id,
                title="Daily Attendance Report Ready",
                message="Institutional attendance report for Oct 31 is ready for review.",
                category=NotificationCategory.SYSTEM,
                priority=NotificationPriority.NORMAL,
                is_read=False,
            )
        )
        await session.flush()
        print("  [+] Created realistic notifications for student, faculty, and admin")

    await session.commit()
    print(">>> Finished seeding rich combinations successfully!")


async def main():
    settings = get_settings()
    engine = create_async_engine(settings.DATABASE_URL, echo=False)
    async with AsyncSession(engine) as session:
        await seed_rich_combinations(session)
    await engine.dispose()


if __name__ == "__main__":
    asyncio.run(main())
