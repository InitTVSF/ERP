"""Academic module: timetable, feedback, minor/specialisation choices.

Tables live in SCHEMA; seed(conn) adds mock data and must be idempotent
(it runs on every start). See DOMAIN_MODULES in erp/db.py.

The shared `subjects` and `attendance` tables (erp/db.py) are only read
here; per-subject extras (credits, faculty) live in acad_courses.
"""
import sqlite3
from datetime import date, datetime

from erp import db

SCHEMA = """
-- Program/semester/section of each student. Missing rows fall back to
-- DEFAULT_ENROLLMENT, so students added by an admin still see a page.
CREATE TABLE IF NOT EXISTS acad_enrollments (
    student_id  INTEGER PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
    program     TEXT NOT NULL,
    branch      TEXT NOT NULL,
    semester    INTEGER NOT NULL,
    section     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS acad_faculty (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    department  TEXT NOT NULL DEFAULT ''
);

-- Extra details for a row of the shared `subjects` table.
CREATE TABLE IF NOT EXISTS acad_courses (
    subject_id  INTEGER PRIMARY KEY REFERENCES subjects(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('Theory', 'Lab')),
    credits     INTEGER NOT NULL,
    faculty_id  INTEGER REFERENCES acad_faculty(id) ON DELETE SET NULL
);

-- One row per class; a lab with span = 2 fills two consecutive periods.
CREATE TABLE IF NOT EXISTS acad_timetable (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    section     TEXT NOT NULL,
    day         INTEGER NOT NULL CHECK (day BETWEEN 0 AND 5),  -- 0 = Monday
    period      INTEGER NOT NULL,
    span        INTEGER NOT NULL DEFAULT 1,
    subject_id  INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    room        TEXT NOT NULL DEFAULT '',
    UNIQUE (section, day, period)
);

CREATE TABLE IF NOT EXISTS acad_feedback (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id   INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    subject_id   INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    session      TEXT NOT NULL,
    comment      TEXT NOT NULL DEFAULT '',
    submitted_at TEXT NOT NULL,
    UNIQUE (student_id, subject_id, session)
);

CREATE TABLE IF NOT EXISTS acad_feedback_ratings (
    feedback_id  INTEGER NOT NULL REFERENCES acad_feedback(id) ON DELETE CASCADE,
    question_no  INTEGER NOT NULL,
    rating       INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
    PRIMARY KEY (feedback_id, question_no)
);

CREATE TABLE IF NOT EXISTS acad_minors (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL CHECK (kind IN ('Minor', 'Specialisation')),
    title       TEXT NOT NULL,
    department  TEXT NOT NULL,
    seats       INTEGER NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    UNIQUE (kind, title)
);

-- A student's ordered choices for one kind (Minor or Specialisation) in a session.
-- status: Submitted (still editable) -> Allotted / Not Allotted (set by the admin).
CREATE TABLE IF NOT EXISTS acad_minor_applications (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id   INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,
    session      TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'Submitted',
    allotted_id  INTEGER REFERENCES acad_minors(id) ON DELETE SET NULL,
    submitted_at TEXT NOT NULL,
    UNIQUE (student_id, kind, session)
);

CREATE TABLE IF NOT EXISTS acad_minor_choices (
    application_id INTEGER NOT NULL REFERENCES acad_minor_applications(id) ON DELETE CASCADE,
    minor_id       INTEGER NOT NULL REFERENCES acad_minors(id) ON DELETE CASCADE,
    rank           INTEGER NOT NULL,
    PRIMARY KEY (application_id, rank),
    UNIQUE (application_id, minor_id)
);
"""

DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

# (period no, start, end). Short breaks follow period 2 and period 4.
PERIODS = [
    (1, "09:00", "09:55"),
    (2, "09:55", "10:50"),
    (3, "11:10", "12:05"),
    (4, "12:05", "13:00"),
    (5, "13:45", "14:40"),
    (6, "14:40", "15:35"),
    (7, "15:35", "16:30"),
]

DEFAULT_SECTION = "A"
DEFAULT_ENROLLMENT = {"program": "B.Tech", "branch": "Computer Science & Engineering",
                      "semester": db.CURRENT_SEMESTER, "section": DEFAULT_SECTION}

FEEDBACK_QUESTIONS = [
    (1, "Explains concepts clearly and with examples"),
    (2, "Comes prepared and covers the syllabus on schedule"),
    (3, "Encourages questions and class participation"),
    (4, "Is punctual and regular in taking classes"),
    (5, "Gives useful feedback on assignments and tests"),
]
RATING_LABELS = {1: "Poor", 2: "Fair", 3: "Good", 4: "Very good", 5: "Excellent"}
FEEDBACK_COMMENT_MAX = 1000

MINOR_KINDS = ["Specialisation", "Minor"]
MAX_PREFERENCES = 3

# ---- Mock data (generic, not real people or places) ----------------------

MOCK_FACULTY = [
    ("Dr. Anita Mehta", "Mathematics"),
    ("Dr. Ravi Iyer", "Physics"),
    ("Prof. Sunil Kulkarni", "Electronics"),
    ("Ms. Priya Verma", "Computer Science"),
    ("Dr. Neeraj Bhatt", "Computer Science"),
    ("Mr. Karan Malhotra", "Physics"),
    ("Ms. Ritu Menon", "Electronics"),
    ("Mr. Arjun Das", "Mechanical"),
]

MOCK_COURSES = [
    # subject code, kind, credits, faculty name
    ("TMA101", "Theory", 4, "Dr. Anita Mehta"),
    ("TPH102", "Theory", 3, "Dr. Ravi Iyer"),
    ("TEC103", "Theory", 3, "Prof. Sunil Kulkarni"),
    ("TCS104", "Theory", 4, "Ms. Priya Verma"),
    ("TCS105", "Theory", 3, "Dr. Neeraj Bhatt"),
    ("PPH151", "Lab", 1, "Mr. Karan Malhotra"),
    ("PEC152", "Lab", 1, "Ms. Ritu Menon"),
    ("PWS153", "Lab", 1, "Mr. Arjun Das"),
]

MOCK_TIMETABLE = [
    # day, period, span, subject code, room
    (0, 1, 1, "TMA101", "LT-201"), (0, 2, 1, "TPH102", "LT-201"), (0, 3, 1, "TCS104", "LT-201"),
    (0, 4, 1, "TEC103", "LT-201"), (0, 5, 2, "PPH151", "Physics Lab B-104"), (0, 7, 1, "TCS105", "LT-201"),
    (1, 1, 1, "TCS104", "LT-201"), (1, 2, 1, "TMA101", "LT-201"), (1, 3, 1, "TCS105", "LT-201"),
    (1, 4, 1, "TPH102", "LT-201"), (1, 5, 2, "PEC152", "Electronics Lab C-210"),
    (2, 1, 1, "TEC103", "LT-202"), (2, 2, 1, "TCS104", "LT-202"), (2, 3, 1, "TMA101", "LT-202"),
    (2, 4, 1, "TCS105", "LT-202"), (2, 5, 1, "TPH102", "LT-202"), (2, 6, 2, "PWS153", "Workshop W-01"),
    (3, 1, 1, "TPH102", "LT-201"), (3, 2, 1, "TEC103", "LT-201"), (3, 3, 1, "TMA101", "LT-201"),
    (3, 4, 1, "TCS104", "LT-201"), (3, 5, 1, "TCS105", "LT-201"),
    (4, 1, 1, "TCS105", "LT-203"), (4, 2, 1, "TMA101", "LT-203"), (4, 3, 1, "TEC103", "LT-203"),
    (4, 4, 1, "TCS104", "LT-203"), (4, 5, 1, "TPH102", "LT-203"),
    (5, 1, 1, "TCS104", "LT-201"), (5, 2, 1, "TCS105", "LT-201"), (5, 3, 1, "TEC103", "LT-201"),
]

MOCK_MINORS = [
    # kind, title, department, seats, description
    ("Specialisation", "Artificial Intelligence & Machine Learning", "Computer Science", 60,
     "Deep learning, NLP and applied ML projects from semester 5."),
    ("Specialisation", "Cyber Security", "Computer Science", 60,
     "Network security, cryptography and secure software development."),
    ("Specialisation", "Data Science", "Computer Science", 60,
     "Statistics, data engineering and visual analytics."),
    ("Specialisation", "Cloud Computing", "Computer Science", 40,
     "Distributed systems, containers and cloud architecture."),
    ("Minor", "Robotics & Automation", "Mechanical", 30,
     "Kinematics, sensors and control for robotic systems."),
    ("Minor", "VLSI Design", "Electronics", 30,
     "Digital IC design, verification and FPGA prototyping."),
    ("Minor", "Finance & Economics", "Management", 30,
     "Financial accounting, markets and engineering economics."),
]


def seed(conn):
    """Insert mock rows into any empty acad_ table. Safe to run on every start."""
    if conn.execute("SELECT COUNT(*) FROM acad_faculty").fetchone()[0] == 0:
        conn.executemany("INSERT INTO acad_faculty (name, department) VALUES (?, ?)", MOCK_FACULTY)
    subject_ids = {r["code"]: r["id"] for r in conn.execute("SELECT id, code FROM subjects")}
    faculty_ids = {r["name"]: r["id"] for r in conn.execute("SELECT id, name FROM acad_faculty")}
    if conn.execute("SELECT COUNT(*) FROM acad_courses").fetchone()[0] == 0:
        conn.executemany(
            "INSERT INTO acad_courses (subject_id, kind, credits, faculty_id) VALUES (?, ?, ?, ?)",
            [(subject_ids[code], kind, credits, faculty_ids.get(fac))
             for code, kind, credits, fac in MOCK_COURSES if code in subject_ids],
        )
    if conn.execute("SELECT COUNT(*) FROM acad_timetable").fetchone()[0] == 0:
        conn.executemany(
            "INSERT INTO acad_timetable (section, day, period, span, subject_id, room)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            [(DEFAULT_SECTION, day, period, span, subject_ids[code], room)
             for day, period, span, code, room in MOCK_TIMETABLE if code in subject_ids],
        )
    if conn.execute("SELECT COUNT(*) FROM acad_minors").fetchone()[0] == 0:
        conn.executemany(
            "INSERT INTO acad_minors (kind, title, department, seats, description) VALUES (?, ?, ?, ?, ?)",
            MOCK_MINORS,
        )
    # Every existing student gets the default enrollment (no-op for those who have one).
    d = DEFAULT_ENROLLMENT
    conn.execute(
        "INSERT OR IGNORE INTO acad_enrollments (student_id, program, branch, semester, section)"
        " SELECT id, ?, ?, ?, ? FROM students",
        (d["program"], d["branch"], d["semester"], d["section"]),
    )


def _now():
    return datetime.now().isoformat(timespec="seconds")


# ---- Enrollment and registered subjects -----------------------------------

def get_enrollment(student_id):
    with db.connect() as conn:
        row = conn.execute("SELECT * FROM acad_enrollments WHERE student_id = ?", (student_id,)).fetchone()
    return dict(row) if row else dict(DEFAULT_ENROLLMENT)


def list_courses():
    """All registered subjects with credits/faculty. Subjects an admin added
    without acad_courses details still appear (kind guessed from the code)."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT s.id, s.code, s.name, c.kind, c.credits, f.name AS faculty"
            " FROM subjects s LEFT JOIN acad_courses c ON c.subject_id = s.id"
            " LEFT JOIN acad_faculty f ON f.id = c.faculty_id ORDER BY s.code",
        ).fetchall()
    courses = []
    for r in rows:
        c = dict(r)
        c["kind"] = c["kind"] or ("Lab" if c["code"].startswith("P") else "Theory")
        courses.append(c)
    # Theory first, then labs, each in code order.
    return sorted(courses, key=lambda c: (c["kind"] != "Theory", c["code"]))


def get_course(code):
    return next((c for c in list_courses() if c["code"] == code), None)


# ---- Timetable --------------------------------------------------------------

def timetable(section):
    """Weekly grid: one dict per day, each with `cells` covering every period.
    A cell is {"entry": ..., "span": n} or {"entry": None, "span": 1} (free)."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT t.day, t.period, t.span, t.room, s.code, s.name,"
            " COALESCE(c.kind, CASE WHEN s.code LIKE 'P%' THEN 'Lab' ELSE 'Theory' END) AS kind,"
            " f.name AS faculty"
            " FROM acad_timetable t JOIN subjects s ON s.id = t.subject_id"
            " LEFT JOIN acad_courses c ON c.subject_id = s.id"
            " LEFT JOIN acad_faculty f ON f.id = c.faculty_id"
            " WHERE t.section = ? ORDER BY t.day, t.period",
            (section,),
        ).fetchall()
    times = {p: (start, end) for p, start, end in PERIODS}
    by_slot = {(r["day"], r["period"]): dict(r) for r in rows}
    last = len(PERIODS)
    days = []
    for day, day_name in enumerate(DAYS):
        cells, classes = [], []
        period = 1
        while period <= last:
            entry = by_slot.get((day, period))
            if entry:
                span = max(1, min(entry["span"], last - period + 1))
                entry["start"] = times[period][0]
                entry["end"] = times[period + span - 1][1]
                entry["periods"] = f"P{period}" if span == 1 else f"P{period}-P{period + span - 1}"
                cells.append({"entry": entry, "span": span})
                classes.append(entry)
                period += span
            else:
                cells.append({"entry": None, "span": 1})
                period += 1
        days.append({"index": day, "name": day_name, "cells": cells, "classes": classes})
    return days


def break_times():
    """[(start, end)] of the gaps between consecutive periods."""
    return [(a[2], b[1]) for a, b in zip(PERIODS, PERIODS[1:]) if a[2] != b[1]]


def today_status(days, now=None):
    """Classes today plus the class in session and the next one, for the summary cards."""
    now = now or datetime.now()
    weekday = now.weekday()
    if weekday >= len(DAYS):
        return {"weekday": None, "count": 0, "current": None, "next": None}
    classes = days[weekday]["classes"]
    hhmm = now.strftime("%H:%M")
    current = next((c for c in classes if c["start"] <= hhmm < c["end"]), None)
    upcoming = next((c for c in classes if c["start"] > hhmm), None)
    return {"weekday": weekday, "count": len(classes), "current": current, "next": upcoming}


# ---- Date-wise attendance ---------------------------------------------------

def attendance_log(student_id, subject_code=None, status=None):
    """Date-by-date attendance, newest first. status: 'present', 'absent' or None."""
    sql = ("SELECT a.date, a.present, s.code, s.name, f.name AS faculty"
           " FROM attendance a JOIN subjects s ON s.id = a.subject_id"
           " LEFT JOIN acad_courses c ON c.subject_id = s.id"
           " LEFT JOIN acad_faculty f ON f.id = c.faculty_id"
           " WHERE a.student_id = ?")
    params = [student_id]
    if subject_code:
        sql += " AND s.code = ?"
        params.append(subject_code)
    if status in ("present", "absent"):
        sql += " AND a.present = ?"
        params.append(1 if status == "present" else 0)
    sql += " ORDER BY a.date DESC, s.code"
    with db.connect() as conn:
        rows = conn.execute(sql, params).fetchall()
    log = []
    for r in rows:
        item = dict(r)
        item["weekday"] = date.fromisoformat(r["date"][:10]).strftime("%a")
        log.append(item)
    return log


def attendance_by_subject(student_id):
    """{subject code: percent} for the overview table."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT s.code, COUNT(a.id) AS total, COALESCE(SUM(a.present), 0) AS present"
            " FROM attendance a JOIN subjects s ON s.id = a.subject_id"
            " WHERE a.student_id = ? GROUP BY s.id",
            (student_id,),
        ).fetchall()
    return {r["code"]: round(r["present"] * 100 / r["total"], 1) for r in rows if r["total"]}


# ---- Feedback ---------------------------------------------------------------

def feedback_status(student_id, session):
    """{subject code: submitted_at} for the feedback the student has already given."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT s.code, f.submitted_at FROM acad_feedback f JOIN subjects s ON s.id = f.subject_id"
            " WHERE f.student_id = ? AND f.session = ?",
            (student_id, session),
        ).fetchall()
    return {r["code"]: r["submitted_at"] for r in rows}


def get_feedback(student_id, subject_code, session):
    """The student's own submission (ratings by question number), or None."""
    with db.connect() as conn:
        fb = conn.execute(
            "SELECT f.* FROM acad_feedback f JOIN subjects s ON s.id = f.subject_id"
            " WHERE f.student_id = ? AND s.code = ? AND f.session = ?",
            (student_id, subject_code, session),
        ).fetchone()
        if fb is None:
            return None
        ratings = {r["question_no"]: r["rating"] for r in conn.execute(
            "SELECT question_no, rating FROM acad_feedback_ratings WHERE feedback_id = ?", (fb["id"],))}
    return {"comment": fb["comment"], "submitted_at": fb["submitted_at"], "ratings": ratings}


def parse_ratings(form):
    """Read q1..qN from a submitted form. Returns {question_no: rating} or raises ValueError."""
    ratings = {}
    for qno, _ in FEEDBACK_QUESTIONS:
        value = (form.get(f"q{qno}") or "").strip()
        if value not in ("1", "2", "3", "4", "5"):
            raise ValueError("Please rate every question from 1 to 5.")
        ratings[qno] = int(value)
    return ratings


def submit_feedback(student_id, subject_code, session, ratings, comment=""):
    """Save one feedback. Raises ValueError for an unknown subject or a repeat submission."""
    comment = (comment or "").strip()[:FEEDBACK_COMMENT_MAX]
    with db.connect() as conn:
        subject = conn.execute("SELECT id FROM subjects WHERE code = ?", (subject_code,)).fetchone()
        if subject is None:
            raise ValueError("Unknown subject.")
        try:
            cur = conn.execute(
                "INSERT INTO acad_feedback (student_id, subject_id, session, comment, submitted_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (student_id, subject["id"], session, comment, _now()),
            )
        except sqlite3.IntegrityError as e:
            raise ValueError("You have already submitted feedback for this subject this session.") from e
        conn.executemany(
            "INSERT INTO acad_feedback_ratings (feedback_id, question_no, rating) VALUES (?, ?, ?)",
            [(cur.lastrowid, qno, rating) for qno, rating in sorted(ratings.items())],
        )


# ---- Minor / specialisation -------------------------------------------------

def list_minors(kind, session):
    """Offered programs of one kind, with how many students put each first."""
    with db.connect() as conn:
        return conn.execute(
            "SELECT m.*, (SELECT COUNT(*) FROM acad_minor_choices ch"
            "   JOIN acad_minor_applications a ON a.id = ch.application_id"
            "   WHERE ch.minor_id = m.id AND ch.rank = 1 AND a.session = ?) AS first_choices"
            " FROM acad_minors m WHERE m.kind = ? ORDER BY m.title",
            (session, kind),
        ).fetchall()


def get_application(student_id, kind, session):
    """The student's application with its ordered choices, or None."""
    with db.connect() as conn:
        app = conn.execute(
            "SELECT a.*, m.title AS allotted_title FROM acad_minor_applications a"
            " LEFT JOIN acad_minors m ON m.id = a.allotted_id"
            " WHERE a.student_id = ? AND a.kind = ? AND a.session = ?",
            (student_id, kind, session),
        ).fetchone()
        if app is None:
            return None
        choices = conn.execute(
            "SELECT ch.rank, m.id, m.title, m.department FROM acad_minor_choices ch"
            " JOIN acad_minors m ON m.id = ch.minor_id WHERE ch.application_id = ? ORDER BY ch.rank",
            (app["id"],),
        ).fetchall()
    result = dict(app)
    result["choices"] = [dict(c) for c in choices]
    return result


def submit_preferences(student_id, kind, session, minor_ids):
    """Save (or replace, while still 'Submitted') the ordered choices.
    minor_ids: list of ids in preference order; blanks already removed."""
    if kind not in MINOR_KINDS:
        raise ValueError("Unknown programme type.")
    if not minor_ids:
        raise ValueError("Choose at least your first preference.")
    if len(minor_ids) > MAX_PREFERENCES:
        raise ValueError(f"You can choose at most {MAX_PREFERENCES} preferences.")
    if len(set(minor_ids)) != len(minor_ids):
        raise ValueError("Each preference must be a different programme.")
    with db.connect() as conn:
        valid = {r["id"] for r in conn.execute("SELECT id FROM acad_minors WHERE kind = ?", (kind,))}
        if not set(minor_ids) <= valid:
            raise ValueError("One of the selected programmes is not offered.")
        app = conn.execute(
            "SELECT id, status FROM acad_minor_applications WHERE student_id = ? AND kind = ? AND session = ?",
            (student_id, kind, session),
        ).fetchone()
        if app and app["status"] != "Submitted":
            raise ValueError("Your preferences can no longer be changed.")
        if app:
            app_id = app["id"]
            conn.execute("UPDATE acad_minor_applications SET submitted_at = ? WHERE id = ?", (_now(), app_id))
            conn.execute("DELETE FROM acad_minor_choices WHERE application_id = ?", (app_id,))
        else:
            app_id = conn.execute(
                "INSERT INTO acad_minor_applications (student_id, kind, session, submitted_at)"
                " VALUES (?, ?, ?, ?)",
                (student_id, kind, session, _now()),
            ).lastrowid
        conn.executemany(
            "INSERT INTO acad_minor_choices (application_id, minor_id, rank) VALUES (?, ?, ?)",
            [(app_id, mid, rank) for rank, mid in enumerate(minor_ids, start=1)],
        )


def withdraw_preferences(student_id, kind, session):
    """Delete a still-editable application. Returns True if one was removed."""
    with db.connect() as conn:
        cur = conn.execute(
            "DELETE FROM acad_minor_applications WHERE student_id = ? AND kind = ? AND session = ?"
            " AND status = 'Submitted'",
            (student_id, kind, session),
        )
        return cur.rowcount > 0
