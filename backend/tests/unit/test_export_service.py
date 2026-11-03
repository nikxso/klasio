"""
Unit tests for CSV Export Service:
- Formula injection protection (DDE attacks)
- Safe filename generation
- Roster and session CSV structure & formatting
"""

import csv
import io
import pytest
from src.services.export_service import sanitize_csv_cell, generate_safe_filename


def test_sanitize_csv_cell_plain_values():
    """Verify safe strings, numbers, and nulls remain unaltered."""
    assert sanitize_csv_cell(None) == ""
    assert sanitize_csv_cell("") == ""
    assert sanitize_csv_cell("21CS037") == "21CS037"
    assert sanitize_csv_cell("Ada Lovelace") == "Ada Lovelace"
    assert sanitize_csv_cell(75.0) == "75.0"
    assert sanitize_csv_cell(42) == "42"
    assert sanitize_csv_cell(True) == "True"


def test_sanitize_csv_cell_formula_injection_prevention():
    """
    Verify leading formula triggers (=, +, -, @, \\t, \\r) are prepended with a single quote
    to neutralize execution in Excel, LibreOffice, and Google Sheets.
    """
    # 1. Equals sign formula
    assert sanitize_csv_cell("=1+1") == "'=1+1"
    assert sanitize_csv_cell("=cmd|' /C calc'!A0") == "'=cmd|' /C calc'!A0"

    # 2. Plus sign formula
    assert sanitize_csv_cell("+cmd|' /C calc'!A0") == "'+cmd|' /C calc'!A0"

    # 3. Minus sign formula
    assert sanitize_csv_cell("-cmd|' /C calc'!A0") == "'-cmd|' /C calc'!A0"

    # 4. At sign formula
    assert sanitize_csv_cell("@SUM(A1:A10)") == "'@SUM(A1:A10)"

    # 5. Tab and carriage return prefixes
    assert sanitize_csv_cell("\t=1+1") == "'\t=1+1"
    assert sanitize_csv_cell("\r=1+1") == "'\r=1+1"


def test_generate_safe_filename():
    """Verify safe filename sanitization eliminates path traversal and special characters."""
    # Standard clean name
    name = generate_safe_filename("attendance", "CS301_4A", "20261029")
    assert name == "attendance_CS301_4A_20261029.csv"

    # Path traversal attempt
    traversal_name = generate_safe_filename("../../etc/passwd", "../roster", "2026")
    assert ".." not in traversal_name
    assert "/" not in traversal_name
    assert traversal_name == "etcpasswd_roster_2026.csv"

    # Special characters & shell injections
    malicious = generate_safe_filename("report;rm -rf /", "sec & test", "2026")
    assert ";" not in malicious
    assert "&" not in malicious
    assert " " not in malicious
    assert malicious == "reportrm-rf_sectest_2026.csv"
