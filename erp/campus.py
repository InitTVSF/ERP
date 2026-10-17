"""Campus module: circulars and placement drives.

Tables live in SCHEMA; seed(conn) adds mock data and must be idempotent
(it runs on every start). See DOMAIN_MODULES in erp/db.py.

Conventions for callers (student portal and admin console):
- Commands take plain dicts and raise ValueError with a user-facing message
  when the input is invalid; the caller flashes the message.
- Queries return sqlite3.Row objects (or lists of them); None when not found.
- Dates are ISO strings ('YYYY-MM-DD'). A drive accepts applications up to and
  including its `apply_by` date.

The dashboard's "Circular Notices" box still reads the shared `notices` table
(db.list_notices); circulars here are a separate, richer list.
"""
import sqlite3
from datetime import date, datetime, timedelta

from erp import db

CATEGORIES = ["Academic", "Exam", "Fee", "General", "Hostel"]
APPLICATION_STATUSES = ["Applied", "Shortlisted", "Selected", "Rejected"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS campus_circulars (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT NOT NULL,
    category    TEXT NOT NULL CHECK (category IN ('Academic', 'Exam', 'Fee', 'General', 'Hostel')),
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS campus_circulars_date ON campus_circulars (date);

CREATE TABLE IF NOT EXISTS campus_drives (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    company      TEXT NOT NULL,
    role         TEXT NOT NULL,
    ctc_lpa      REAL NOT NULL CHECK (ctc_lpa >= 0),   -- CTC in lakh per annum
    location     TEXT NOT NULL DEFAULT '',
    description  TEXT NOT NULL DEFAULT '',
    min_cgpa     REAL NOT NULL DEFAULT 0 CHECK (min_cgpa BETWEEN 0 AND 10),
    branches     TEXT NOT NULL DEFAULT 'All branches',  -- comma-separated, display only
    apply_by     TEXT NOT NULL,                          -- last date to apply (inclusive)
    drive_date   TEXT NOT NULL,
    created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campus_applications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    drive_id    INTEGER NOT NULL REFERENCES campus_drives(id) ON DELETE CASCADE,
    student_id  INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    status      TEXT NOT NULL DEFAULT 'Applied'
                CHECK (status IN ('Applied', 'Shortlisted', 'Selected', 'Rejected')),
    applied_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE (drive_id, student_id)
);
CREATE INDEX IF NOT EXISTS campus_applications_student ON campus_applications (student_id);
"""

# The first three match erp/db.py MOCK_NOTICES so the dashboard and the
# Circular page agree.
MOCK_CIRCULARS = [
    # date, category, title, body
    ("2026-10-13", "Fee", "Fee submission for the even semesters 2026-27",
     "All students are informed that the fee for the even semester of session 2026-27 "
     "must be submitted on or before 15/11/2026.\n"
     "Fee can be paid online through the Fee section of the student portal. Students paying "
     "after the due date will be charged a late fee as per the institute's rules.\n"
     "Students with a pending scholarship or education-loan disbursement should contact the "
     "Accounts office with supporting documents before the due date."),
    ("2026-09-18", "Exam", "Term evaluation theory regular/back examination, September 2026",
     "The term evaluation theory examinations (regular and back papers) will be held as per the "
     "date sheet displayed on the notice board and in the Exam section of the portal.\n"
     "Students must carry their admit card and institute ID card to every examination. Entry "
     "will not be permitted 30 minutes after the start of the paper.\n"
     "Mobile phones, smart watches and other electronic devices are strictly prohibited in the "
     "examination hall."),
    ("2026-02-18", "General", "Compliance with traffic rules and road safety guidelines",
     "Students riding two-wheelers to campus must wear helmets and carry a valid driving "
     "licence. Vehicles must be parked only in the designated parking areas.\n"
     "Rash driving inside or near the campus will invite disciplinary action."),
    ("2026-10-08", "Academic", "Submission of mini-project synopsis",
     "Students of all branches must submit their mini-project synopsis to their respective "
     "project coordinators by 25/10/2026.\n"
     "The synopsis should be 2-3 pages and include the problem statement, objectives, proposed "
     "method and expected outcomes. Groups may have at most four members."),
    ("2026-10-05", "Hostel", "Hostel room inspection schedule",
     "Wardens will carry out routine room inspections in all hostel blocks during the week of "
     "19/10/2026. Residents are requested to keep their rooms clean and electrical appliances "
     "other than those permitted must be removed.\n"
     "Maintenance complaints may be logged with the hostel office before the inspection."),
    ("2026-09-28", "Academic", "Guest lecture on responsible use of AI tools",
     "The Department of Computer Science is organising a guest lecture on responsible and "
     "ethical use of AI tools in academic work on 30/10/2026 in the Main Auditorium.\n"
     "Attendance is compulsory for first-year students and open to all others."),
    ("2026-09-02", "Exam", "Registration for back paper examinations",
     "Students who wish to appear in back paper examinations must register through the Exam "
     "section of the portal by 12/09/2026. Late registrations will not be accepted."),
    ("2026-08-20", "Hostel", "Revised mess timings",
     "With effect from 01/09/2026, the hostel mess will follow these timings: breakfast "
     "7:30-9:00, lunch 12:30-2:00, snacks 5:00-6:00 and dinner 7:30-9:30."),
    ("2026-08-01", "General", "Commencement of the odd semester",
     "Classes for the odd semester of session 2026-27 will commence on 03/08/2026. Students "
     "should check their time table on the portal and report to their classes on time."),
]


def _drives_seed(today):
    """Mock drives, dated relative to the first start so some are open, some closed.
    Company names are fictional."""
    d = lambda days: (today + timedelta(days=days)).isoformat()  # noqa: E731
    return [
        # company, role, ctc, location, description, min_cgpa, branches, apply_by, drive_date
        ("Nimbus Byteworks", "Graduate Software Engineer", 8.5, "Bengaluru",
         "Online coding test followed by two technical interviews and an HR round.",
         7.0, "CSE, IT, ECE", d(10), d(18)),
        ("Riverstone Analytics", "Data Analyst Trainee", 6.0, "Pune",
         "Aptitude test, SQL/Excel case study and a panel interview.",
         6.5, "All branches", d(5), d(12)),
        ("Bluepeak Systems", "Associate Cloud Engineer", 7.2, "Hyderabad",
         "Written test on networking and Linux fundamentals, then technical and HR interviews.",
         6.0, "CSE, IT", d(21), d(30)),
        ("Copperleaf Motors", "Graduate Engineer Trainee", 5.4, "Gurugram",
         "Technical interview covering core engineering subjects, followed by HR discussion.",
         6.0, "ME, EE, ECE", d(3), d(9)),
        ("Lumen Grid Energy", "Junior Electrical Engineer", 5.0, "Dehradun",
         "Group discussion and technical interview.",
         6.5, "EE, ECE", d(-6), d(-1)),
        ("Quillstack Software", "Software Developer Intern + PPO", 10.0, "Remote",
         "Six-month internship with a pre-placement offer based on performance.",
         7.5, "CSE, IT", d(-20), d(-12)),
    ]


# Mock applications, by enrollment no. and company: (status, days since applying).
_APPLICATIONS_SEED = [
    ("PV-25190001", "Quillstack Software", "Selected", 25),
    ("PV-25190001", "Lumen Grid Energy", "Rejected", 9),
    ("PV-25190001", "Riverstone Analytics", "Shortlisted", 2),
    ("PV-25190002", "Quillstack Software", "Rejected", 24),
    ("PV-25190002", "Nimbus Byteworks", "Applied", 1),
    ("PV-25190003", "Lumen Grid Energy", "Selected", 8),
]


def seed(conn):
    """Insert mock circulars and drives the first time only (each table seeded when empty)."""
    now = _now()
    if conn.execute("SELECT COUNT(*) FROM campus_circulars").fetchone()[0] == 0:
        conn.executemany(
            "INSERT INTO campus_circulars (date, category, title, body, created_at)"
            " VALUES (?, ?, ?, ?, ?)",
            [(*c, now) for c in MOCK_CIRCULARS],
        )
    if conn.execute("SELECT COUNT(*) FROM campus_drives").fetchone()[0] == 0:
        today = date.today()
        conn.executemany(
            "INSERT INTO campus_drives (company, role, ctc_lpa, location, description, min_cgpa,"
            " branches, apply_by, drive_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(*dr, now) for dr in _drives_seed(today)],
        )
        for enrollment_no, company, status, ago in _APPLICATIONS_SEED:
            student = conn.execute("SELECT id FROM students WHERE enrollment_no = ?",
                                   (enrollment_no,)).fetchone()
            drive = conn.execute("SELECT id FROM campus_drives WHERE company = ?",
                                 (company,)).fetchone()
            if student and drive:
                ts = (datetime.now() - timedelta(days=ago)).isoformat(timespec="seconds")
                conn.execute(
                    "INSERT OR IGNORE INTO campus_applications"
                    " (drive_id, student_id, status, applied_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                    (drive[0], student[0], status, ts, ts),
                )


def _now():
    return datetime.now().isoformat(timespec="seconds")


def _today():
    return date.today().isoformat()


def _clean(data, key, label, required=True):
    value = str(data.get(key) or "").strip()
    if required and not value:
        raise ValueError(f"{label} is required.")
    return value


def _clean_date(data, key, label):
    value = _clean(data, key, label)
    try:
        return datetime.strptime(value, "%Y-%m-%d").date().isoformat()
    except ValueError:
        raise ValueError(f"{label} must be a valid date (YYYY-MM-DD).") from None


def _clean_number(data, key, label, lo, hi):
    raw = _clean(data, key, label)
    try:
        value = float(raw)
    except ValueError:
        raise ValueError(f"{label} must be a number.") from None
    if not lo <= value <= hi:
        raise ValueError(f"{label} must be between {lo:g} and {hi:g}.")
    return value


# ---- Circulars ------------------------------------------------------------

def list_circulars(search="", category=""):
    """Circulars, newest first. `search` matches title or body (case-insensitive);
    `category` must be one of CATEGORIES to filter (anything else is ignored)."""
    sql, params = "SELECT * FROM campus_circulars WHERE 1 = 1", []
    search = (search or "").strip()
    if search:
        like = f"%{search}%"
        sql += " AND (title LIKE ? OR body LIKE ?)"
        params += [like, like]
    if category in CATEGORIES:
        sql += " AND category = ?"
        params.append(category)
    sql += " ORDER BY date DESC, id DESC"
    with db.connect() as conn:
        return conn.execute(sql, params).fetchall()


def get_circular(circular_id):
    """One circular Row, or None."""
    with db.connect() as conn:
        return conn.execute("SELECT * FROM campus_circulars WHERE id = ?", (circular_id,)).fetchone()


def _circular_values(data):
    category = _clean(data, "category", "Category")
    if category not in CATEGORIES:
        raise ValueError("Category must be one of: " + ", ".join(CATEGORIES) + ".")
    return (_clean_date(data, "date", "Date"), category, _clean(data, "title", "Title"),
            _clean(data, "body", "Body", required=False))


def create_circular(data):
    """data: {date: 'YYYY-MM-DD', category: one of CATEGORIES, title, body (optional)}.
    Returns the new id. Raises ValueError on invalid input."""
    values = _circular_values(data)
    with db.connect() as conn:
        cur = conn.execute(
            "INSERT INTO campus_circulars (date, category, title, body, created_at)"
            " VALUES (?, ?, ?, ?, ?)", (*values, _now()))
        return cur.lastrowid


def update_circular(circular_id, data):
    """Same data keys as create_circular. Raises ValueError on invalid input."""
    values = _circular_values(data)
    with db.connect() as conn:
        conn.execute("UPDATE campus_circulars SET date = ?, category = ?, title = ?, body = ?"
                     " WHERE id = ?", (*values, circular_id))


def delete_circular(circular_id):
    with db.connect() as conn:
        conn.execute("DELETE FROM campus_circulars WHERE id = ?", (circular_id,))


# ---- Placement drives -----------------------------------------------------

_DRIVE_COLUMNS = """d.*,
    (SELECT COUNT(*) FROM campus_applications a WHERE a.drive_id = d.id) AS applicant_count,
    (d.apply_by >= :today) AS is_open"""


def list_drives(student_id=None, upcoming_only=False):
    """All drives ordered by drive date (soonest open ones first).

    Each Row has the drive columns plus `applicant_count`, `is_open` (1 while
    today <= apply_by) and, when student_id is given, `my_status` (the student's
    application status or None). upcoming_only: only drives still open."""
    sql = f"SELECT {_DRIVE_COLUMNS}"
    params = {"today": _today(), "sid": student_id}
    if student_id is not None:
        sql += (", (SELECT status FROM campus_applications a"
                " WHERE a.drive_id = d.id AND a.student_id = :sid) AS my_status")
    sql += " FROM campus_drives d"
    if upcoming_only:
        sql += " WHERE d.apply_by >= :today"
    # Open drives first (soonest deadline first), then closed ones (most recent first).
    sql += (" ORDER BY (d.apply_by >= :today) DESC,"
            " CASE WHEN d.apply_by >= :today THEN d.apply_by END ASC, d.drive_date DESC")
    with db.connect() as conn:
        return conn.execute(sql, params).fetchall()


def get_drive(drive_id):
    """One drive Row (with applicant_count and is_open), or None."""
    with db.connect() as conn:
        return conn.execute(f"SELECT {_DRIVE_COLUMNS} FROM campus_drives d WHERE d.id = :id",
                            {"today": _today(), "id": drive_id}).fetchone()


def _drive_values(data):
    apply_by = _clean_date(data, "apply_by", "Last date to apply")
    drive_date = _clean_date(data, "drive_date", "Drive date")
    if drive_date < apply_by:
        raise ValueError("Drive date cannot be before the last date to apply.")
    return (_clean(data, "company", "Company"), _clean(data, "role", "Role"),
            _clean_number(data, "ctc_lpa", "CTC (LPA)", 0, 1000),
            _clean(data, "location", "Location", required=False),
            _clean(data, "description", "Description", required=False),
            _clean_number(data, "min_cgpa", "Minimum CGPA", 0, 10) if _clean(data, "min_cgpa", "", False) else 0.0,
            _clean(data, "branches", "Branches", required=False) or "All branches",
            apply_by, drive_date)


def create_drive(data):
    """data: {company, role, ctc_lpa (number, lakh per annum), location?, description?,
    min_cgpa? (0-10, default 0), branches? (text, default 'All branches'),
    apply_by: 'YYYY-MM-DD', drive_date: 'YYYY-MM-DD' (>= apply_by)}.
    Returns the new id. Raises ValueError on invalid input."""
    values = _drive_values(data)
    with db.connect() as conn:
        cur = conn.execute(
            "INSERT INTO campus_drives (company, role, ctc_lpa, location, description, min_cgpa,"
            " branches, apply_by, drive_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (*values, _now()))
        return cur.lastrowid


def update_drive(drive_id, data):
    """Same data keys as create_drive. Raises ValueError on invalid input."""
    values = _drive_values(data)
    with db.connect() as conn:
        conn.execute(
            "UPDATE campus_drives SET company = ?, role = ?, ctc_lpa = ?, location = ?,"
            " description = ?, min_cgpa = ?, branches = ?, apply_by = ?, drive_date = ?"
            " WHERE id = ?", (*values, drive_id))


def delete_drive(drive_id):
    """Deletes the drive and (via cascade) its applications."""
    with db.connect() as conn:
        conn.execute("DELETE FROM campus_drives WHERE id = ?", (drive_id,))


# ---- Applications ---------------------------------------------------------

def list_applications(drive_id):
    """Applicants for one drive: application columns plus student `name`,
    `roll_no`, `enrollment_no`; ordered by application time."""
    with db.connect() as conn:
        return conn.execute(
            "SELECT a.*, s.name, s.roll_no, s.enrollment_no FROM campus_applications a"
            " JOIN students s ON s.id = a.student_id WHERE a.drive_id = ?"
            " ORDER BY a.applied_at, a.id", (drive_id,)).fetchall()


def set_application_status(application_id, status):
    """status: one of APPLICATION_STATUSES. Raises ValueError otherwise or if
    the application does not exist."""
    if status not in APPLICATION_STATUSES:
        raise ValueError("Status must be one of: " + ", ".join(APPLICATION_STATUSES) + ".")
    with db.connect() as conn:
        cur = conn.execute("UPDATE campus_applications SET status = ?, updated_at = ? WHERE id = ?",
                           (status, _now(), application_id))
        if cur.rowcount == 0:
            raise ValueError("Application not found.")


def student_applications(student_id):
    """The student's applications, newest first, with drive details
    (`company`, `role`, `ctc_lpa`, `apply_by`, `drive_date`, `location`, `is_open`)."""
    with db.connect() as conn:
        return conn.execute(
            "SELECT a.*, d.company, d.role, d.ctc_lpa, d.location, d.apply_by, d.drive_date,"
            " (d.apply_by >= ?) AS is_open FROM campus_applications a"
            " JOIN campus_drives d ON d.id = a.drive_id WHERE a.student_id = ?"
            " ORDER BY a.applied_at DESC, a.id DESC", (_today(), student_id)).fetchall()


def apply(student_id, drive_id):
    """Apply to a drive. Raises ValueError if the drive is missing, closed,
    or the student has already applied."""
    drive = get_drive(drive_id)
    if drive is None:
        raise ValueError("This drive no longer exists.")
    if not drive["is_open"]:
        closed = datetime.strptime(drive["apply_by"], "%Y-%m-%d").strftime("%d/%m/%Y")
        raise ValueError(f"Applications for {drive['company']} closed on {closed}.")
    now = _now()
    try:
        with db.connect() as conn:
            conn.execute("INSERT INTO campus_applications (drive_id, student_id, status, applied_at,"
                         " updated_at) VALUES (?, ?, 'Applied', ?, ?)",
                         (drive_id, student_id, now, now))
    except sqlite3.IntegrityError:
        raise ValueError(f"You have already applied to {drive['company']}.") from None
    return drive


def withdraw(student_id, drive_id):
    """Withdraw an application. Allowed only before the deadline and while the
    status is still 'Applied'. Raises ValueError otherwise."""
    drive = get_drive(drive_id)
    if drive is None:
        raise ValueError("This drive no longer exists.")
    if not drive["is_open"]:
        raise ValueError("The deadline has passed; applications can no longer be withdrawn.")
    with db.connect() as conn:
        row = conn.execute("SELECT id, status FROM campus_applications"
                           " WHERE drive_id = ? AND student_id = ?",
                           (drive_id, student_id)).fetchone()
        if row is None:
            raise ValueError(f"You have not applied to {drive['company']}.")
        if row["status"] != "Applied":
            raise ValueError(f"Your application is already {row['status'].lower()} "
                             "and can't be withdrawn.")
        conn.execute("DELETE FROM campus_applications WHERE id = ?", (row["id"],))
    return drive


def placement_stats():
    """Campus-wide figures: drives, open_drives, companies, offers (Selected
    applications), placed (distinct students selected), highest_ctc (from a
    Selected offer, else None)."""
    with db.connect() as conn:
        return conn.execute(
            "SELECT"
            " (SELECT COUNT(*) FROM campus_drives) AS drives,"
            " (SELECT COUNT(*) FROM campus_drives WHERE apply_by >= :today) AS open_drives,"
            " (SELECT COUNT(DISTINCT company) FROM campus_drives) AS companies,"
            " (SELECT COUNT(*) FROM campus_applications WHERE status = 'Selected') AS offers,"
            " (SELECT COUNT(DISTINCT student_id) FROM campus_applications"
            "   WHERE status = 'Selected') AS placed,"
            " (SELECT MAX(d.ctc_lpa) FROM campus_applications a JOIN campus_drives d"
            "   ON d.id = a.drive_id WHERE a.status = 'Selected') AS highest_ctc",
            {"today": _today()}).fetchone()
