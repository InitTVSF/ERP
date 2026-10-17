"""Shared SQLite data layer used by both the student portal (app.py)
and the admin backend (admin_app.py).

Both processes open the same database file, so a student created by an
admin can log in to the portal immediately.
"""
import importlib
import os
import random
import sqlite3
from datetime import date, datetime, timedelta

from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.environ.get("ERP_DB_PATH", os.path.join(BASE_DIR, "instance", "erp.db"))

# Display settings, kept in one place so branding is easy to change.
PORTAL_NAME = os.environ.get("ERP_PORTAL_NAME", "Campus ERP")
INSTITUTION_NAME = os.environ.get("ERP_INSTITUTION_NAME", "Graphic Era Hill University")
SESSION_LABEL = os.environ.get("ERP_SESSION_LABEL", "2026-27")
# Students have no semester column yet; every module treats them as being in this one.
CURRENT_SEMESTER = 3

# Editable student fields, in display order: (column, label).
STUDENT_FIELDS = [
    ("name", "Full Name"),
    ("roll_no", "Roll Number"),
    ("enrollment_no", "Enrollment Number"),
    ("parent_name", "Parent's Name"),
    ("profile_no", "Profile Number"),
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS students (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    roll_no       TEXT NOT NULL UNIQUE,
    enrollment_no TEXT NOT NULL UNIQUE COLLATE NOCASE,
    parent_name   TEXT NOT NULL DEFAULT '',
    profile_no    TEXT NOT NULL DEFAULT '',
    photo         TEXT NOT NULL DEFAULT '',  -- file name in instance/uploads/photos
    password_hash TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'Active',
    created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admins (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL
);

-- Portal content (mock data for now).
CREATE TABLE IF NOT EXISTS notices (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    date   TEXT NOT NULL,
    title  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS holidays (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    date   TEXT NOT NULL,
    title  TEXT NOT NULL
);

-- Reserved for the upcoming "Subjects" and "Attendance" admin features.
CREATE TABLE IF NOT EXISTS subjects (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    code  TEXT NOT NULL UNIQUE,
    name  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attendance (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    subject_id  INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    date        TEXT NOT NULL,
    present     INTEGER NOT NULL,
    UNIQUE (student_id, subject_id, date)
);
"""

MOCK_STUDENTS = [
    # name, roll_no, enrollment_no, parent_name, profile_no
    ("Aarav Sharma", "2519001", "PV-25190001", "Rajesh Sharma", "PRF-1001"),
    ("Diya Negi", "2519002", "PV-25190002", "Sunita Negi", "PRF-1002"),
    ("Kabir Rawat", "2519003", "PV-25190003", "Mohan Rawat", "PRF-1003"),
]
MOCK_STUDENT_PASSWORD = "student123"

MOCK_NOTICES = [
    ("2026-10-13", "Fee submission for the even semesters 2026-27"),
    ("2026-09-18", "Term evaluation theory regular/back examination, September 2026"),
    ("2026-02-18", "Compliance with traffic rules and road safety guidelines"),
]

MOCK_SUBJECTS = [
    # code, name
    ("TMA101", "Engineering Mathematics"),
    ("TPH102", "Engineering Physics"),
    ("TEC103", "Basic Electronics"),
    ("TCS104", "Programming in C"),
    ("TCS105", "Introduction to AI & ML"),
    ("PPH151", "Physics Lab"),
    ("PEC152", "Electronics Lab"),
    ("PWS153", "Workshop Practice"),
]

# Each domain module (fees, academic, ...) owns its own tables. It exposes
# SCHEMA (SQL, may be empty) and seed(conn) (called on every start; must be
# idempotent). Add new modules here.
DOMAIN_MODULES = ["erp.fees", "erp.academic", "erp.exams", "erp.campus"]

MOCK_HOLIDAYS = [
    ("2026-01-26", "Republic Day"),
    ("2026-03-04", "Holi"),
    ("2026-08-15", "Independence Day"),
    ("2026-10-02", "Gandhi Jayanti"),
    ("2026-10-20", "Diwali Break"),
    ("2026-12-25", "Christmas Day"),
]


def connect():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")  # two processes share this file
    return conn


def init_db():
    """Create tables and seed mock data on first run. Safe to call repeatedly."""
    with connect() as conn:
        conn.executescript(SCHEMA)
        _migrate(conn)
        if conn.execute("SELECT COUNT(*) FROM students").fetchone()[0] == 0:
            pw = generate_password_hash(MOCK_STUDENT_PASSWORD)
            now = _now()
            conn.executemany(
                "INSERT INTO students (name, roll_no, enrollment_no, parent_name, profile_no,"
                " password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                [(*s, pw, now) for s in MOCK_STUDENTS],
            )
        if conn.execute("SELECT COUNT(*) FROM notices").fetchone()[0] == 0:
            conn.executemany("INSERT INTO notices (date, title) VALUES (?, ?)", MOCK_NOTICES)
        if conn.execute("SELECT COUNT(*) FROM holidays").fetchone()[0] == 0:
            conn.executemany("INSERT INTO holidays (date, title) VALUES (?, ?)", MOCK_HOLIDAYS)
        if conn.execute("SELECT COUNT(*) FROM subjects").fetchone()[0] == 0:
            conn.executemany("INSERT INTO subjects (code, name) VALUES (?, ?)", MOCK_SUBJECTS)
            _seed_attendance(conn)
        if conn.execute("SELECT COUNT(*) FROM admins").fetchone()[0] == 0:
            username = os.environ.get("ERP_ADMIN_USER", "admin")
            password = os.environ.get("ERP_ADMIN_PASSWORD", "admin123")
            conn.execute(
                "INSERT INTO admins (username, password_hash) VALUES (?, ?)",
                (username, generate_password_hash(password)),
            )


    for name in DOMAIN_MODULES:
        module = importlib.import_module(name)
        with connect() as conn:
            if module.SCHEMA:
                conn.executescript(module.SCHEMA)
            module.seed(conn)


def _migrate(conn):
    """Bring databases created by older versions up to the current SCHEMA."""
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(students)")}
    if "photo" not in columns:
        conn.execute("ALTER TABLE students ADD COLUMN photo TEXT NOT NULL DEFAULT ''")


def _seed_attendance(conn):
    """Mock attendance: every student, every subject, weekdays of the last six weeks."""
    rng = random.Random(42)  # deterministic, so every fresh database looks the same
    students = [r[0] for r in conn.execute("SELECT id FROM students")]
    subjects = [r[0] for r in conn.execute("SELECT id FROM subjects")]
    start = date.today() - timedelta(weeks=6)
    days = [start + timedelta(days=i) for i in range(42)]
    rows = []
    for sid in students:
        rate = rng.uniform(0.62, 0.95)  # some students fall below the 75% line
        for subj in subjects:
            for d in days:
                if d.weekday() < 5 and rng.random() < 0.6:  # not every subject every day
                    rows.append((sid, subj, d.isoformat(), int(rng.random() < rate)))
    conn.executemany(
        "INSERT INTO attendance (student_id, subject_id, date, present) VALUES (?, ?, ?, ?)", rows)


def _now():
    return datetime.now().isoformat(timespec="seconds")


# ---- Students -------------------------------------------------------------

def list_students(search=""):
    with connect() as conn:
        if search:
            like = f"%{search}%"
            return conn.execute(
                "SELECT * FROM students WHERE name LIKE ? OR roll_no LIKE ? OR enrollment_no LIKE ?"
                " ORDER BY name",
                (like, like, like),
            ).fetchall()
        return conn.execute("SELECT * FROM students ORDER BY name").fetchall()


def get_student(student_id):
    with connect() as conn:
        return conn.execute("SELECT * FROM students WHERE id = ?", (student_id,)).fetchone()


def create_student(data, password):
    """data: dict with the STUDENT_FIELDS keys. Raises ValueError on duplicates."""
    try:
        with connect() as conn:
            cur = conn.execute(
                "INSERT INTO students (name, roll_no, enrollment_no, parent_name, profile_no,"
                " password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (data["name"], data["roll_no"], data["enrollment_no"], data["parent_name"],
                 data["profile_no"], generate_password_hash(password), _now()),
            )
            return cur.lastrowid
    except sqlite3.IntegrityError as e:
        raise ValueError(_duplicate_message(e)) from e


def update_student(student_id, data, password=None):
    """Update details; the password is changed only when one is given."""
    try:
        with connect() as conn:
            conn.execute(
                "UPDATE students SET name = ?, roll_no = ?, enrollment_no = ?, parent_name = ?,"
                " profile_no = ?, status = ? WHERE id = ?",
                (data["name"], data["roll_no"], data["enrollment_no"], data["parent_name"],
                 data["profile_no"], data.get("status", "Active"), student_id),
            )
            if password:
                conn.execute("UPDATE students SET password_hash = ? WHERE id = ?",
                             (generate_password_hash(password), student_id))
    except sqlite3.IntegrityError as e:
        raise ValueError(_duplicate_message(e)) from e


def set_student_photo(student_id, name):
    """Store the photo file name ('' clears it). Files are handled by erp/photos.py."""
    with connect() as conn:
        conn.execute("UPDATE students SET photo = ? WHERE id = ?", (name, student_id))


def delete_student(student_id):
    with connect() as conn:
        conn.execute("DELETE FROM students WHERE id = ?", (student_id,))


def authenticate_student(user_id, password):
    """Log in with enrollment number or roll number. Returns the row or None."""
    user_id = (user_id or "").strip()
    with connect() as conn:
        row = conn.execute(
            "SELECT * FROM students WHERE enrollment_no = ? OR roll_no = ?", (user_id, user_id)
        ).fetchone()
    if row and row["status"] == "Active" and check_password_hash(row["password_hash"], password or ""):
        return row
    return None


def _duplicate_message(err):
    msg = str(err)
    if "roll_no" in msg:
        return "A student with this roll number already exists."
    if "enrollment_no" in msg:
        return "A student with this enrollment number already exists."
    return "This student conflicts with an existing record."


# ---- Admins ---------------------------------------------------------------

def authenticate_admin(username, password):
    with connect() as conn:
        row = conn.execute("SELECT * FROM admins WHERE username = ?", ((username or "").strip(),)).fetchone()
    if row and check_password_hash(row["password_hash"], password or ""):
        return row
    return None


# ---- Portal content -------------------------------------------------------

def list_notices(limit=10):
    with connect() as conn:
        return conn.execute("SELECT * FROM notices ORDER BY date DESC LIMIT ?", (limit,)).fetchall()


def list_holidays():
    with connect() as conn:
        return conn.execute("SELECT * FROM holidays ORDER BY date").fetchall()


def attendance_summary(student_id):
    """Per-subject attendance. Empty until the admin attendance feature exists."""
    with connect() as conn:
        return conn.execute(
            "SELECT s.code, s.name, COUNT(a.id) AS total, COALESCE(SUM(a.present), 0) AS present"
            " FROM attendance a JOIN subjects s ON s.id = a.subject_id"
            " WHERE a.student_id = ? GROUP BY s.id ORDER BY s.name",
            (student_id,),
        ).fetchall()


# ---- Subjects (admin) -----------------------------------------------------

def list_subjects(search=""):
    """Subjects with the number of attendance records each one holds."""
    sql = ("SELECT s.*, (SELECT COUNT(*) FROM attendance a WHERE a.subject_id = s.id) AS records"
           " FROM subjects s")
    with connect() as conn:
        if search:
            like = f"%{search}%"
            return conn.execute(sql + " WHERE s.code LIKE ? OR s.name LIKE ? ORDER BY s.code",
                                (like, like)).fetchall()
        return conn.execute(sql + " ORDER BY s.code").fetchall()


def get_subject(subject_id):
    with connect() as conn:
        return conn.execute("SELECT * FROM subjects WHERE id = ?", (subject_id,)).fetchone()


def create_subject(code, name):
    """Raises ValueError if the code is already taken."""
    try:
        with connect() as conn:
            return conn.execute("INSERT INTO subjects (code, name) VALUES (?, ?)",
                                (code, name)).lastrowid
    except sqlite3.IntegrityError as e:
        raise ValueError("A subject with this code already exists.") from e


def update_subject(subject_id, code, name):
    try:
        with connect() as conn:
            conn.execute("UPDATE subjects SET code = ?, name = ? WHERE id = ?",
                         (code, name, subject_id))
    except sqlite3.IntegrityError as e:
        raise ValueError("A subject with this code already exists.") from e


def delete_subject(subject_id):
    """Also removes the subject's attendance records (ON DELETE CASCADE)."""
    with connect() as conn:
        conn.execute("DELETE FROM subjects WHERE id = ?", (subject_id,))


# ---- Attendance (admin) ---------------------------------------------------

def attendance_for(subject_id, day):
    """{student_id: present (bool)} already saved for one subject on one date."""
    with connect() as conn:
        rows = conn.execute("SELECT student_id, present FROM attendance"
                            " WHERE subject_id = ? AND date = ?", (subject_id, day)).fetchall()
    return {r["student_id"]: bool(r["present"]) for r in rows}


def save_attendance(subject_id, day, marks):
    """marks: {student_id: present}. Re-saving a subject+date overwrites it."""
    with connect() as conn:
        conn.executemany(
            "INSERT INTO attendance (student_id, subject_id, date, present) VALUES (?, ?, ?, ?)"
            " ON CONFLICT (student_id, subject_id, date) DO UPDATE SET present = excluded.present",
            [(sid, subject_id, day, int(bool(p))) for sid, p in marks.items()],
        )
    return len(marks)


def recent_attendance_dates(subject_id, limit=8):
    """Most recently marked dates for a subject, with head counts."""
    with connect() as conn:
        return conn.execute(
            "SELECT date, COUNT(*) AS total, SUM(present) AS present FROM attendance"
            " WHERE subject_id = ? GROUP BY date ORDER BY date DESC LIMIT ?",
            (subject_id, limit)).fetchall()


def attendance_report(group_by="student", subject_id=None, student_id=None):
    """Attendance totals grouped by student (optionally for one subject) or by
    subject (optionally for one student). Rows with no records are included
    with total 0 so nobody silently drops off the report."""
    if group_by == "subject":
        sql = ("SELECT s.id, s.code, s.name, COUNT(a.id) AS total,"
               " COALESCE(SUM(a.present), 0) AS present"
               " FROM subjects s LEFT JOIN attendance a ON a.subject_id = s.id"
               + (" AND a.student_id = ?" if student_id else "") +
               " GROUP BY s.id ORDER BY s.code")
        params = (student_id,) if student_id else ()
    else:
        sql = ("SELECT st.id, st.name, st.roll_no, st.status, COUNT(a.id) AS total,"
               " COALESCE(SUM(a.present), 0) AS present"
               " FROM students st LEFT JOIN attendance a ON a.student_id = st.id"
               + (" AND a.subject_id = ?" if subject_id else "") +
               " GROUP BY st.id ORDER BY st.name")
        params = (subject_id,) if subject_id else ()
    with connect() as conn:
        return conn.execute(sql, params).fetchall()


# ---- Notices & holidays (admin) -------------------------------------------

def create_notice(day, title):
    with connect() as conn:
        return conn.execute("INSERT INTO notices (date, title) VALUES (?, ?)", (day, title)).lastrowid


def delete_notice(notice_id):
    """Returns True if a row was removed."""
    with connect() as conn:
        return conn.execute("DELETE FROM notices WHERE id = ?", (notice_id,)).rowcount > 0


def create_holiday(day, title):
    with connect() as conn:
        return conn.execute("INSERT INTO holidays (date, title) VALUES (?, ?)", (day, title)).lastrowid


def delete_holiday(holiday_id):
    with connect() as conn:
        return conn.execute("DELETE FROM holidays WHERE id = ?", (holiday_id,)).rowcount > 0
