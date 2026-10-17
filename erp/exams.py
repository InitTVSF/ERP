"""Exam module: date sheet, exam registration, admit card and results.

Tables live in SCHEMA; seed(conn) adds mock data and must be idempotent
(it runs on every start). See DOMAIN_MODULES in erp/db.py.

Model
-----
* exam_schedule       - date sheet for the current term, one row per subject
                        and exam type, built from the shared `subjects` table.
* exam_registrations  - a student's registration for the current term's
                        end-term/practical examinations (one per term).
* exam_back_papers    - back-paper (re-appear) registrations for a failed
                        past course, for the current term.
* exam_courses        - mock past-semester courses (results reference these,
                        not `subjects`, which only holds the current term).
* exam_results        - per student, per past course: internal/external marks.
                        Grades, grade points, SGPA and CGPA are computed in
                        Python from the marks (see GRADE_SCALE / gpa()).

The portal has no "current semester" field per student yet, so every student
is treated as being in CURRENT_SEMESTER, with results for the semesters
before it.
"""
import random
from datetime import date, datetime, timedelta

from erp import db

CURRENT_TERM = "2026-ODD"
CURRENT_TERM_LABEL = "End-Term Examination, Odd Semester 2026-27"
CURRENT_SEMESTER = db.CURRENT_SEMESTER
REGISTRATION_DEADLINE = "2026-11-10"  # inclusive

# First exam day for each exam type of the current term's date sheet.
TYPE_START = {
    "Mid-Term": date(2026, 9, 21),
    "Practical": date(2026, 11, 16),
    "End-Term": date(2026, 11, 23),
}
TYPE_ORDER = ["Mid-Term", "Practical", "End-Term"]
SESSIONS = {
    "Morning": ("10:00", "13:00"),
    "Evening": ("14:00", "17:00"),
}
# Exams that need registration (and appear on the admit card).
REGISTERED_TYPES = ("Practical", "End-Term")

# 10-point scale: (minimum percentage, grade, grade points), highest first.
GRADE_SCALE = [
    (90, "O", 10),
    (80, "A+", 9),
    (70, "A", 8),
    (60, "B+", 7),
    (50, "B", 6),
    (45, "C", 5),
    (40, "P", 4),
    (0, "F", 0),
]
PASS_PERCENT = 40

# Mock past-semester courses: semester, code, name, credits, kind.
MOCK_COURSES = [
    (1, "XMA111", "Calculus and Linear Algebra", 4, "Theory"),
    (1, "XCH112", "Engineering Chemistry", 3, "Theory"),
    (1, "XEE113", "Basic Electrical Engineering", 3, "Theory"),
    (1, "XCS114", "Problem Solving with Python", 4, "Theory"),
    (1, "XHS115", "Professional Communication", 2, "Theory"),
    (1, "XCH161", "Chemistry Lab", 1, "Practical"),
    (1, "XCS162", "Python Programming Lab", 2, "Practical"),
    (2, "XMA121", "Differential Equations and Transforms", 4, "Theory"),
    (2, "XCS122", "Data Structures", 4, "Theory"),
    (2, "XEC123", "Digital Logic Design", 3, "Theory"),
    (2, "XME124", "Engineering Graphics", 3, "Theory"),
    (2, "XEV125", "Environmental Studies", 2, "Theory"),
    (2, "XCS171", "Data Structures Lab", 2, "Practical"),
    (2, "XEC172", "Digital Logic Lab", 1, "Practical"),
]
# Maximum marks by course kind: (internal, external).
MAX_MARKS = {"Theory": (40, 60), "Practical": (50, 50)}
RESULT_DECLARED = {1: "2026-02-20", 2: "2026-07-25"}

INSTRUCTIONS = [
    "Carry this admit card and your college ID card to every examination.",
    "Report to the examination hall at least 20 minutes before the start time.",
    "Mobile phones, smart watches and other electronic devices are not allowed.",
    "No candidate will be allowed to enter after 30 minutes of the start time.",
    "Use only blue or black pens; programmable calculators are not permitted.",
    "Any form of unfair means will lead to cancellation of the examination.",
]

SCHEMA = """
CREATE TABLE IF NOT EXISTS exam_schedule (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    term        TEXT NOT NULL,
    subject_id  INTEGER NOT NULL REFERENCES subjects(id) ON DELETE CASCADE,
    exam_type   TEXT NOT NULL,          -- Mid-Term / End-Term / Practical
    exam_date   TEXT NOT NULL,          -- YYYY-MM-DD
    session     TEXT NOT NULL,          -- Morning / Evening
    start_time  TEXT NOT NULL,
    end_time    TEXT NOT NULL,
    UNIQUE (term, subject_id, exam_type)
);

CREATE TABLE IF NOT EXISTS exam_registrations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id    INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    term          TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    UNIQUE (student_id, term)
);

CREATE TABLE IF NOT EXISTS exam_courses (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    semester  INTEGER NOT NULL,
    code      TEXT NOT NULL UNIQUE,
    name      TEXT NOT NULL,
    credits   INTEGER NOT NULL,
    kind      TEXT NOT NULL DEFAULT 'Theory'   -- Theory / Practical
);

CREATE TABLE IF NOT EXISTS exam_results (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id    INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    course_id     INTEGER NOT NULL REFERENCES exam_courses(id) ON DELETE CASCADE,
    internal      INTEGER NOT NULL,
    internal_max  INTEGER NOT NULL,
    external      INTEGER NOT NULL,
    external_max  INTEGER NOT NULL,
    UNIQUE (student_id, course_id)
);

CREATE TABLE IF NOT EXISTS exam_back_papers (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id    INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    result_id     INTEGER NOT NULL REFERENCES exam_results(id) ON DELETE CASCADE,
    term          TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    UNIQUE (result_id, term)
);
"""


# ---- Seeding --------------------------------------------------------------

def seed(conn):
    conn.executemany(
        "INSERT OR IGNORE INTO exam_courses (semester, code, name, credits, kind)"
        " VALUES (?, ?, ?, ?, ?)", MOCK_COURSES)
    _seed_schedule(conn)
    for (sid,) in conn.execute(
            "SELECT id FROM students WHERE id NOT IN (SELECT student_id FROM exam_results)").fetchall():
        _seed_results(conn, sid)


def _is_practical(code, name):
    text = f"{code} {name}".lower()
    return code.upper().startswith("P") or any(w in text for w in ("lab", "workshop", "practical"))


def _next_exam_day(day):
    day += timedelta(days=1)
    while day.weekday() == 6:  # no exams on Sundays
        day += timedelta(days=1)
    return day


def _seed_schedule(conn):
    """Give every subject that has no date-sheet row yet its exams for the
    current term. Subjects added later are appended after the last date."""
    missing = conn.execute(
        "SELECT id, code, name FROM subjects WHERE id NOT IN"
        " (SELECT subject_id FROM exam_schedule WHERE term = ?) ORDER BY code",
        (CURRENT_TERM,)).fetchall()
    for subj in missing:
        types = ["Practical"] if _is_practical(subj["code"], subj["name"]) else ["Mid-Term", "End-Term"]
        for exam_type in types:
            last = conn.execute(
                "SELECT MAX(exam_date) FROM exam_schedule WHERE term = ? AND exam_type = ?",
                (CURRENT_TERM, exam_type)).fetchone()[0]
            if last:
                day = _next_exam_day(date.fromisoformat(last))
            else:
                day = TYPE_START[exam_type]
                while day.weekday() == 6:
                    day += timedelta(days=1)
            # Mid-terms are 90-minute papers; the rest run the full session.
            session = "Evening" if exam_type == "Practical" else "Morning"
            start, end = SESSIONS[session]
            if exam_type == "Mid-Term":
                end = "11:30"
            conn.execute(
                "INSERT INTO exam_schedule (term, subject_id, exam_type, exam_date, session,"
                " start_time, end_time) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (CURRENT_TERM, subj["id"], exam_type, day.isoformat(), session, start, end))


def _seed_results(conn, student_id):
    """Mock marks for all past-semester courses, deterministic per student."""
    rng = random.Random(1000 + student_id)
    ability = rng.uniform(0.52, 0.9)
    rows = []
    for course in conn.execute("SELECT id, kind FROM exam_courses WHERE semester < ?",
                               (CURRENT_SEMESTER,)):
        imax, emax = MAX_MARKS.get(course["kind"], MAX_MARKS["Theory"])
        level = min(max(ability + rng.gauss(0, 0.09), 0.2), 0.99)
        internal = round(imax * min(level + rng.uniform(0, 0.08), 1.0))
        external = round(emax * level)
        rows.append((student_id, course["id"], internal, imax, external, emax))
    conn.executemany(
        "INSERT OR IGNORE INTO exam_results (student_id, course_id, internal, internal_max,"
        " external, external_max) VALUES (?, ?, ?, ?, ?, ?)", rows)


def ensure_student_data(student_id):
    """Seed results for a student created after the last startup."""
    with db.connect() as conn:
        if not conn.execute("SELECT 1 FROM exam_results WHERE student_id = ? LIMIT 1",
                            (student_id,)).fetchone():
            _seed_results(conn, student_id)


# ---- Grades ---------------------------------------------------------------

def grade_for(percent):
    """Percentage -> (grade, grade points) using GRADE_SCALE."""
    for minimum, grade, points in GRADE_SCALE:
        if percent >= minimum:
            return grade, points
    return "F", 0


def gpa(courses):
    """Credit-weighted grade point average:
    sum(credits x grade points) / sum(credits). None when there are no credits.
    Failed courses count with 0 grade points (their credits stay in the divisor)."""
    total_credits = sum(c["credits"] for c in courses)
    if not total_credits:
        return None
    return sum(c["credits"] * c["grade_points"] for c in courses) / total_credits


# ---- Date sheet and registration -----------------------------------------

def date_sheet(term=CURRENT_TERM):
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT e.*, s.code, s.name FROM exam_schedule e JOIN subjects s ON s.id = e.subject_id"
            " WHERE e.term = ? ORDER BY e.exam_date, e.start_time, s.code", (term,)).fetchall()
    today = date.today().isoformat()
    exams = []
    for r in rows:
        d = dict(r)
        d["weekday"] = date.fromisoformat(r["exam_date"]).strftime("%a")
        d["done"] = r["exam_date"] < today
        exams.append(d)
    exams.sort(key=lambda e: (TYPE_ORDER.index(e["exam_type"]) if e["exam_type"] in TYPE_ORDER else 99,
                              e["exam_date"], e["start_time"]))
    return exams


def registration(student_id, term=CURRENT_TERM):
    with db.connect() as conn:
        return conn.execute("SELECT * FROM exam_registrations WHERE student_id = ? AND term = ?",
                            (student_id, term)).fetchone()


def registration_open():
    return date.today().isoformat() <= REGISTRATION_DEADLINE


def register(student_id, term=CURRENT_TERM):
    """Returns True if newly registered, False if already registered."""
    with db.connect() as conn:
        cur = conn.execute(
            "INSERT OR IGNORE INTO exam_registrations (student_id, term, registered_at) VALUES (?, ?, ?)",
            (student_id, term, _now()))
        return cur.rowcount == 1


def back_paper_options(student_id, term=CURRENT_TERM):
    """Failed past courses, with whether a back paper is already registered."""
    failed = [c for sem in semester_results(student_id) for c in sem["courses"] if c["grade"] == "F"]
    with db.connect() as conn:
        taken = {r[0] for r in conn.execute(
            "SELECT result_id FROM exam_back_papers WHERE student_id = ? AND term = ?",
            (student_id, term))}
    for c in failed:
        c["back_registered"] = c["result_id"] in taken
    return failed


def register_back_papers(student_id, result_ids, term=CURRENT_TERM):
    """Register back papers for the given failed results. Ignores ids that are
    not this student's failed courses. Returns the number newly registered."""
    allowed = {c["result_id"] for c in back_paper_options(student_id, term)}
    count = 0
    with db.connect() as conn:
        for rid in result_ids:
            if rid in allowed:
                cur = conn.execute(
                    "INSERT OR IGNORE INTO exam_back_papers (student_id, result_id, term, registered_at)"
                    " VALUES (?, ?, ?, ?)", (student_id, rid, term, _now()))
                count += cur.rowcount
    return count


# ---- Results --------------------------------------------------------------

def semester_results(student_id):
    """List of semesters (ascending), each a dict with courses, SGPA and totals."""
    with db.connect() as conn:
        rows = conn.execute(
            "SELECT r.id AS result_id, r.internal, r.internal_max, r.external, r.external_max,"
            " c.semester, c.code, c.name, c.credits, c.kind"
            " FROM exam_results r JOIN exam_courses c ON c.id = r.course_id"
            " WHERE r.student_id = ? ORDER BY c.semester, c.kind DESC, c.code",
            (student_id,)).fetchall()
    semesters = {}
    for r in rows:
        c = dict(r)
        c["total"] = r["internal"] + r["external"]
        c["max_total"] = r["internal_max"] + r["external_max"]
        c["percent"] = c["total"] * 100 / c["max_total"] if c["max_total"] else 0
        c["grade"], c["grade_points"] = grade_for(c["percent"])
        c["credit_points"] = c["credits"] * c["grade_points"]
        semesters.setdefault(r["semester"], []).append(c)

    result = []
    for number in sorted(semesters):
        courses = semesters[number]
        backs = sum(1 for c in courses if c["grade"] == "F")
        result.append({
            "semester": number,
            "year": (number + 1) // 2,
            "courses": courses,
            "credits": sum(c["credits"] for c in courses),
            "earned_credits": sum(c["credits"] for c in courses if c["grade"] != "F"),
            "credit_points": sum(c["credit_points"] for c in courses),
            "marks": sum(c["total"] for c in courses),
            "max_marks": sum(c["max_total"] for c in courses),
            "sgpa": gpa(courses),
            "backs": backs,
            "status": "Pass" if not backs else f"Fail ({backs} back{'s' if backs > 1 else ''})",
            "declared": RESULT_DECLARED.get(number, ""),
        })
    # CGPA after each semester: credit-weighted over all courses so far.
    so_far = []
    for sem in result:
        so_far.extend(sem["courses"])
        sem["cgpa"] = gpa(so_far)
    return result


def cgpa(semesters):
    """Credit-weighted over every course of every semester (not a mean of SGPAs)."""
    return gpa([c for s in semesters for c in s["courses"]])


def _now():
    return datetime.now().isoformat(timespec="seconds")
