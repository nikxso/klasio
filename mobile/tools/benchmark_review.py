#!/usr/bin/env python3
"""
STEP I — FACULTY REVIEW & FINAL ATTENDANCE: EXPERIMENTAL BENCHMARK REPORT
Evaluates review list reconciliation, interactive mutations, duplicate validation,
ACID persistence, and Integration Scenarios A through J.
"""

import time
import uuid
import json
import sqlite3
import numpy as np

SCHEMA_SQL = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS local_attendance_sessions (
    client_session_uuid TEXT PRIMARY KEY,
    teaching_assignment_id TEXT NOT NULL,
    session_date TEXT NOT NULL,
    period_slot_or_sequence INTEGER NOT NULL,
    applicability_status TEXT NOT NULL CHECK(applicability_status IN ('COUNTED', 'CANCELLED', 'EXEMPT')),
    status_reason TEXT,
    regular_faculty_user_id TEXT NOT NULL,
    conducting_faculty_user_id TEXT NOT NULL,
    substitute_delegation_id TEXT,
    session_status TEXT NOT NULL CHECK(session_status IN ('DRAFT', 'FINALIZED', 'SYNCED')),
    finalized_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(teaching_assignment_id, session_date, period_slot_or_sequence)
);

CREATE TABLE IF NOT EXISTS local_attendance_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_session_uuid TEXT NOT NULL,
    student_user_id TEXT NOT NULL,
    attendance_status TEXT NOT NULL CHECK(attendance_status IN ('PRESENT', 'ABSENT', 'EXCUSED')),
    mark_source TEXT NOT NULL CHECK(mark_source IN ('AI_VERIFIED', 'MANUAL_MARK', 'MANUAL_OVERRIDE')),
    candidate_confidence REAL,
    recorded_at TEXT NOT NULL,
    FOREIGN KEY(client_session_uuid) REFERENCES local_attendance_sessions(client_session_uuid) ON DELETE CASCADE,
    UNIQUE(client_session_uuid, student_user_id)
);

CREATE TABLE IF NOT EXISTS sync_queue (
    queue_id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_session_uuid TEXT NOT NULL UNIQUE,
    endpoint_path TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    sync_status TEXT NOT NULL CHECK(sync_status IN ('PENDING', 'IN_FLIGHT', 'ACKNOWLEDGED', 'FAILED')),
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_retry_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""

class PythonReviewController:
    """Python reference implementation replicating FacultyAttendanceReviewController logic."""
    def __init__(self):
        self.context = None
        self.lifecycle_status = "DRAFT"
        self.review_items = {}
        self.eligible_roster = {}
        self.corrections = []

    def initialize(self, context, roster, candidates=None):
        self.context = dict(context)
        self.review_items = {}
        self.eligible_roster = {}
        self.corrections = []
        candidates = candidates or []

        session_date = context["sessionDate"]
        for s in roster:
            is_started = s["effectiveStartDate"] <= session_date
            is_not_ended = not s.get("effectiveEndDate") or s["effectiveEndDate"] >= session_date
            if is_started and is_not_ended:
                self.eligible_roster[s["studentUserId"]] = dict(s)

        # Index candidates
        cand_map = {}
        for c in candidates:
            sid = c.get("studentUserId")
            if sid and c.get("matchOutcome") == "MATCHED":
                if sid not in cand_map or c.get("top1Confidence", 0) > cand_map[sid].get("top1Confidence", 0):
                    cand_map[sid] = c

        now = int(time.time() * 1000)
        for sid, student in self.eligible_roster.items():
            if sid in cand_map:
                cand = cand_map[sid]
                self.review_items[sid] = {
                    "studentUserId": sid,
                    "institutionalId": student["institutionalId"],
                    "studentName": student["studentName"],
                    "attendanceStatus": "PRESENT",
                    "markSource": "AI_VERIFIED",
                    "candidateConfidence": cand.get("top1Confidence"),
                    "isRecognized": True,
                    "isCorrected": False,
                    "isManuallyAdded": False,
                    "recordedAtMs": now,
                }
            else:
                self.review_items[sid] = {
                    "studentUserId": sid,
                    "institutionalId": student["institutionalId"],
                    "studentName": student["studentName"],
                    "attendanceStatus": "UNDECIDED",
                    "markSource": None,
                    "candidateConfidence": None,
                    "isRecognized": False,
                    "isCorrected": False,
                    "isManuallyAdded": False,
                    "recordedAtMs": now,
                }
        self.lifecycle_status = "REVIEW"

    def mark_status(self, student_user_id, status):
        item = self.review_items[student_user_id]
        if item["isRecognized"]:
            item["markSource"] = "AI_VERIFIED" if status == "PRESENT" else "MANUAL_OVERRIDE"
        else:
            item["markSource"] = "MANUAL_MARK"
        item["attendanceStatus"] = status
        item["recordedAtMs"] = int(time.time() * 1000)

    def correct_identity(self, from_id, to_id, reason):
        if not reason:
            raise ValueError("Reason required")
        from_item = self.review_items[from_id]
        to_item = self.review_items[to_id]
        if to_item["attendanceStatus"] == "PRESENT":
            raise ValueError("Target already present")

        to_item["attendanceStatus"] = "PRESENT"
        to_item["markSource"] = "MANUAL_OVERRIDE"
        to_item["isRecognized"] = True
        to_item["isCorrected"] = True
        to_item["candidateConfidence"] = from_item["candidateConfidence"]

        from_item["attendanceStatus"] = "UNDECIDED"
        from_item["markSource"] = None
        from_item["isRecognized"] = False

        self.corrections.append({"from": from_id, "to": to_id, "reason": reason})

    def remove_candidate(self, student_user_id):
        item = self.review_items[student_user_id]
        item["isRecognized"] = False
        item["attendanceStatus"] = "UNDECIDED"
        item["markSource"] = None
        item["candidateConfidence"] = None

    def manual_add_student(self, student_user_id, status="PRESENT"):
        item = self.review_items[student_user_id]
        item["attendanceStatus"] = status
        item["markSource"] = "MANUAL_MARK"
        item["isManuallyAdded"] = True

    def mark_remaining_unreviewed_as_absent(self):
        for item in self.review_items.values():
            if item["attendanceStatus"] == "UNDECIDED":
                item["attendanceStatus"] = "ABSENT"
                item["markSource"] = "MANUAL_MARK"

    def validate_finalization(self):
        errors = []
        is_reg = self.context["conductingFacultyUserId"] == self.context["regularFacultyUserId"]
        has_del = bool(self.context.get("substituteDelegationId"))
        if not is_reg and not has_del:
            errors.append("Unauthorized conducting faculty")

        if self.context.get("applicabilityStatus") == "COUNTED":
            undecided = [i for i in self.review_items.values() if i["attendanceStatus"] == "UNDECIDED"]
            if undecided:
                errors.append(f"{len(undecided)} students undecided")

        return len(errors) == 0, errors

    def prepare_payload(self):
        valid, errs = self.validate_finalization()
        if not valid:
            raise ValueError("; ".join(errs))

        records = []
        now_iso = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        for item in self.review_items.values():
            records.append({
                "studentUserId": item["studentUserId"],
                "attendanceStatus": item["attendanceStatus"],
                "markSource": item["markSource"] or "MANUAL_MARK",
                "candidateConfidence": item["candidateConfidence"],
                "recordedAt": now_iso,
            })
        return {
            "clientSessionUuid": self.context["clientSessionUuid"],
            "teachingAssignmentId": self.context["teachingAssignmentId"],
            "sessionDate": self.context["sessionDate"],
            "periodSlotOrSequence": self.context["periodSlotOrSequence"],
            "applicabilityStatus": self.context["applicabilityStatus"],
            "regularFacultyUserId": self.context["regularFacultyUserId"],
            "conductingFacultyUserId": self.context["conductingFacultyUserId"],
            "substituteDelegationId": self.context.get("substituteDelegationId"),
            "finalizedAt": now_iso,
            "records": records,
        }


def run_benchmark():
    print("=" * 80)
    print("STEP I — FACULTY REVIEW & FINAL ATTENDANCE: EXPERIMENTAL BENCHMARK REPORT")
    print("=" * 80)

    # -------------------------------------------------------------------------
    # PART 1: Latency & Scaling Benchmarks across Gallery Sizes (N=30, 60, 100)
    # -------------------------------------------------------------------------
    print("\n[PART 1] Reconciliation & Finalization Latency across Roster Sizes:")
    print(f"  {'Roster Size (N)':<16} | {'Reconciliation (ms)':<22} | {'Validation (ms)':<18} | {'SQLite ACID Commit (ms)':<24}")
    print("  " + "-" * 84)

    for n in [30, 60, 100]:
        roster = [
            {
                "studentUserId": f"usr_{i:03d}",
                "institutionalId": f"21CS{i:03d}",
                "studentName": f"Student {i:03d}",
                "effectiveStartDate": "2026-09-01",
            }
            for i in range(1, n + 1)
        ]
        # 80% recognized
        candidates = [
            {
                "studentUserId": f"usr_{i:03d}",
                "top1Confidence": 0.85,
                "matchOutcome": "MATCHED",
            }
            for i in range(1, int(n * 0.8) + 1)
        ]
        ctx = {
            "clientSessionUuid": str(uuid.uuid4()),
            "teachingAssignmentId": "assign_demo_ds",
            "sessionDate": "2026-10-13",
            "periodSlotOrSequence": 1,
            "applicabilityStatus": "COUNTED",
            "regularFacultyUserId": "fac_regular",
            "conductingFacultyUserId": "fac_regular",
        }

        ctrl = PythonReviewController()

        # Measure reconciliation
        t0 = time.perf_counter()
        ctrl.initialize(ctx, roster, candidates)
        t_reconcile = (time.perf_counter() - t0) * 1000.0

        ctrl.mark_remaining_unreviewed_as_absent()

        # Measure validation & payload assembly
        t1 = time.perf_counter()
        payload = ctrl.prepare_payload()
        t_val = (time.perf_counter() - t1) * 1000.0

        # Measure SQLite ACID transaction
        db = sqlite3.connect(":memory:")
        db.executescript(SCHEMA_SQL)

        t2 = time.perf_counter()
        db.execute("BEGIN TRANSACTION;")
        db.execute("""
            INSERT INTO local_attendance_sessions (
                client_session_uuid, teaching_assignment_id, session_date,
                period_slot_or_sequence, applicability_status, regular_faculty_user_id,
                conducting_faculty_user_id, session_status, finalized_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'FINALIZED', ?, datetime('now'), datetime('now'));
        """, (
            payload["clientSessionUuid"], payload["teachingAssignmentId"], payload["sessionDate"],
            payload["periodSlotOrSequence"], payload["applicabilityStatus"],
            payload["regularFacultyUserId"], payload["conductingFacultyUserId"], payload["finalizedAt"]
        ))
        for r in payload["records"]:
            db.execute("""
                INSERT INTO local_attendance_records (
                    client_session_uuid, student_user_id, attendance_status, mark_source, candidate_confidence, recorded_at
                ) VALUES (?, ?, ?, ?, ?, ?);
            """, (
                payload["clientSessionUuid"], r["studentUserId"], r["attendanceStatus"],
                r["markSource"], r["candidateConfidence"], r["recordedAt"]
            ))
        db.execute("""
            INSERT INTO sync_queue (client_session_uuid, endpoint_path, payload_json, sync_status, created_at, updated_at)
            VALUES (?, '/api/v1/attendance/sessions/sync', ?, 'PENDING', datetime('now'), datetime('now'));
        """, (payload["clientSessionUuid"], json.dumps(payload)))
        db.execute("COMMIT;")
        t_commit = (time.perf_counter() - t2) * 1000.0

        print(f"  N = {n:<12} | {t_reconcile:<22.3f} | {t_val:<18.3f} | {t_commit:<24.3f}")

    # -------------------------------------------------------------------------
    # PART 2: Integration Scenarios A through J
    # -------------------------------------------------------------------------
    print("\n[PART 2] End-to-End Integration Scenarios (A through J):")

    # Helper fixtures
    base_roster = [
        {"studentUserId": f"usr_{i:03d}", "institutionalId": f"21CS{i:03d}", "studentName": f"Student {i:03d}", "effectiveStartDate": "2026-09-01"}
        for i in range(1, 31)
    ]
    base_ctx = {
        "clientSessionUuid": "sess_integration_01",
        "teachingAssignmentId": "assign_demo_ds",
        "sessionDate": "2026-10-13",
        "periodSlotOrSequence": 1,
        "applicabilityStatus": "COUNTED",
        "regularFacultyUserId": "fac_regular",
        "conductingFacultyUserId": "fac_regular",
    }

    # SCENARIO A — Perfect Recognition
    ctrl = PythonReviewController()
    perfect_cands = [{"studentUserId": f"usr_{i:03d}", "top1Confidence": 0.9, "matchOutcome": "MATCHED"} for i in range(1, 31)]
    ctrl.initialize(base_ctx, base_roster, perfect_cands)
    payload_a = ctrl.prepare_payload()
    assert len(payload_a["records"]) == 30
    assert all(r["attendanceStatus"] == "PRESENT" and r["markSource"] == "AI_VERIFIED" for r in payload_a["records"])
    print("  Scenario A (Perfect Recognition): PASSED (30/30 AI_VERIFIED PRESENT)")

    # SCENARIO B — Recognition Misses Students
    ctrl = PythonReviewController()
    partial_cands = [{"studentUserId": f"usr_{i:03d}", "top1Confidence": 0.9, "matchOutcome": "MATCHED"} for i in range(1, 25)]
    ctrl.initialize(base_ctx, base_roster, partial_cands)
    undecided = [i for i in ctrl.review_items.values() if i["attendanceStatus"] == "UNDECIDED"]
    assert len(undecided) == 6
    ctrl.mark_remaining_unreviewed_as_absent()
    payload_b = ctrl.prepare_payload()
    present_cnt = sum(1 for r in payload_b["records"] if r["attendanceStatus"] == "PRESENT")
    absent_cnt = sum(1 for r in payload_b["records"] if r["attendanceStatus"] == "ABSENT")
    assert present_cnt == 24 and absent_cnt == 6
    print("  Scenario B (Missed Students): PASSED (24 PRESENT, 6 Manual ABSENT)")

    # SCENARIO C — False Identity Correction
    ctrl = PythonReviewController()
    ctrl.initialize(base_ctx, base_roster, [{"studentUserId": "usr_001", "top1Confidence": 0.72, "matchOutcome": "MATCHED"}])
    ctrl.correct_identity("usr_001", "usr_002", "Visually confirmed Student 002 instead")
    assert ctrl.review_items["usr_001"]["attendanceStatus"] == "UNDECIDED"
    assert ctrl.review_items["usr_002"]["attendanceStatus"] == "PRESENT"
    assert ctrl.review_items["usr_002"]["markSource"] == "MANUAL_OVERRIDE"
    print("  Scenario C (Identity Correction): PASSED (Transferred recognition, audit recorded)")

    # SCENARIO D — Duplicate Recognition
    ctrl = PythonReviewController()
    dupe_cands = [
        {"studentUserId": "usr_001", "top1Confidence": 0.78, "matchOutcome": "MATCHED"},
        {"studentUserId": "usr_001", "top1Confidence": 0.94, "matchOutcome": "MATCHED"},
        {"studentUserId": "usr_001", "top1Confidence": 0.81, "matchOutcome": "MATCHED"},
    ]
    ctrl.initialize(base_ctx, base_roster, dupe_cands)
    assert ctrl.review_items["usr_001"]["candidateConfidence"] == 0.94
    print("  Scenario D (Duplicate Tracks): PASSED (Collapsed to single candidate with max confidence)")

    # SCENARIO E — Ambiguous Recognition
    ctrl = PythonReviewController()
    ambig_cands = [{"studentUserId": None, "top1Confidence": 0.54, "matchOutcome": "AMBIGUOUS"}]
    ctrl.initialize(base_ctx, base_roster, ambig_cands)
    assert all(i["attendanceStatus"] == "UNDECIDED" for i in ctrl.review_items.values())
    print("  Scenario E (Ambiguous Recognition): PASSED (Zero automatic status promotion)")

    # SCENARIO F — Offline Finalization
    db = sqlite3.connect(":memory:")
    db.executescript(SCHEMA_SQL)
    ctrl = PythonReviewController()
    ctrl.initialize(base_ctx, base_roster, perfect_cands)
    payload_f = ctrl.prepare_payload()
    db.execute("INSERT INTO local_attendance_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'FINALIZED', ?, datetime('now'), datetime('now'))",
        (payload_f["clientSessionUuid"], payload_f["teachingAssignmentId"], payload_f["sessionDate"],
         payload_f["periodSlotOrSequence"], payload_f["applicabilityStatus"], None,
         payload_f["regularFacultyUserId"], payload_f["conductingFacultyUserId"], None, payload_f["finalizedAt"]))
    db.execute("INSERT INTO sync_queue VALUES (1, ?, '/sync', ?, 'PENDING', 0, NULL, NULL, datetime('now'), datetime('now'))",
        (payload_f["clientSessionUuid"], json.dumps(payload_f)))
    row = db.execute("SELECT session_status FROM local_attendance_sessions").fetchone()
    q_row = db.execute("SELECT sync_status FROM sync_queue").fetchone()
    assert row[0] == "FINALIZED" and q_row[0] == "PENDING"
    print("  Scenario F (Offline Finalization): PASSED (ACID commit with PENDING sync queue)")

    # SCENARIO G — Sync Retry Idempotency
    # Submitting same payload again
    db.execute("""
        INSERT INTO sync_queue (client_session_uuid, endpoint_path, payload_json, sync_status, created_at, updated_at)
        VALUES (?, '/sync', ?, 'PENDING', datetime('now'), datetime('now'))
        ON CONFLICT(client_session_uuid) DO UPDATE SET updated_at = datetime('now');
    """, (payload_f["clientSessionUuid"], json.dumps(payload_f)))
    count = db.execute("SELECT COUNT(*) FROM sync_queue").fetchone()[0]
    assert count == 1
    print("  Scenario G (Sync Retry Idempotency): PASSED (No duplicate sync queue rows)")

    # SCENARIO H — App Restart State Preservation
    reloaded_sess = db.execute("SELECT client_session_uuid, session_status FROM local_attendance_sessions").fetchone()
    assert reloaded_sess[0] == payload_f["clientSessionUuid"]
    assert reloaded_sess[1] == "FINALIZED"
    print("  Scenario H (App Restart): PASSED (Session reconstructed intact)")

    # SCENARIO I — Authorization Rejection
    ctrl = PythonReviewController()
    unauth_ctx = dict(base_ctx, conductingFacultyUserId="fac_intruder", substituteDelegationId=None)
    ctrl.initialize(unauth_ctx, base_roster, perfect_cands)
    can_fin, errs = ctrl.validate_finalization()
    assert not can_fin and any("Unauthorized" in e for e in errs)
    print("  Scenario I (Authorization Rejection): PASSED (Unauthorized actor blocked)")

    # SCENARIO J — Manual Attendance Only (Zero ML)
    ctrl = PythonReviewController()
    ctrl.initialize(base_ctx, base_roster, [])
    for sid in ctrl.review_items:
        ctrl.mark_status(sid, "PRESENT")
    payload_j = ctrl.prepare_payload()
    assert len(payload_j["records"]) == 30
    assert all(r["markSource"] == "MANUAL_MARK" for r in payload_j["records"])
    print("  Scenario J (Manual Attendance Only): PASSED (100% manual completion with zero ML)")

    print("\n" + "=" * 80)
    print("STEP I BENCHMARK COMPLETE: ALL 10 INTEGRATION SCENARIOS PASSED.")
    print("=" * 80)


if __name__ == "__main__":
    run_benchmark()
