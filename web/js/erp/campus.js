/* Campus module: circulars and placement drives. Port of erp/campus.py.
 *
 * Tables live in SCHEMA; seed(conn) adds mock data and must be idempotent
 * (it runs on every start). See DOMAIN_MODULES in erp/db.js.
 *
 * Conventions for callers (student portal and admin console):
 * - Commands take plain objects and throw ValueError with a user-facing message
 *   when the input is invalid; the caller flashes the message.
 * - Queries return row objects (or arrays of them); null when not found.
 * - Dates are ISO strings ('YYYY-MM-DD'). A drive accepts applications up to and
 *   including its `apply_by` date.
 *
 * The dashboard's "Circular Notices" box still reads the shared `notices` table
 * (db.list_notices); circulars here are a separate, richer list.
 */
import * as db from "./db.js";
import { IntegrityError, ValueError } from "./db.js";
import { PyDate, PyDateTime, nowISO, pyFormat, todayISO } from "../lib/py.js";

export const CATEGORIES = ["Academic", "Exam", "Fee", "General", "Hostel"];
export const APPLICATION_STATUSES = ["Applied", "Shortlisted", "Selected", "Rejected"];

export const SCHEMA = `
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
`;

// The first three match erp/db.js MOCK_NOTICES so the dashboard and the
// Circular page agree.
const MOCK_CIRCULARS = [
  // date, category, title, body
  ["2026-10-13", "Fee", "Fee submission for the even semesters 2026-27",
    "All students are informed that the fee for the even semester of session 2026-27 " +
    "must be submitted on or before 15/11/2026.\n" +
    "Fee can be paid online through the Fee section of the student portal. Students paying " +
    "after the due date will be charged a late fee as per the institute's rules.\n" +
    "Students with a pending scholarship or education-loan disbursement should contact the " +
    "Accounts office with supporting documents before the due date."],
  ["2026-09-18", "Exam", "Term evaluation theory regular/back examination, September 2026",
    "The term evaluation theory examinations (regular and back papers) will be held as per the " +
    "date sheet displayed on the notice board and in the Exam section of the portal.\n" +
    "Students must carry their admit card and institute ID card to every examination. Entry " +
    "will not be permitted 30 minutes after the start of the paper.\n" +
    "Mobile phones, smart watches and other electronic devices are strictly prohibited in the " +
    "examination hall."],
  ["2026-02-18", "General", "Compliance with traffic rules and road safety guidelines",
    "Students riding two-wheelers to campus must wear helmets and carry a valid driving " +
    "licence. Vehicles must be parked only in the designated parking areas.\n" +
    "Rash driving inside or near the campus will invite disciplinary action."],
  ["2026-10-08", "Academic", "Submission of mini-project synopsis",
    "Students of all branches must submit their mini-project synopsis to their respective " +
    "project coordinators by 25/10/2026.\n" +
    "The synopsis should be 2-3 pages and include the problem statement, objectives, proposed " +
    "method and expected outcomes. Groups may have at most four members."],
  ["2026-10-05", "Hostel", "Hostel room inspection schedule",
    "Wardens will carry out routine room inspections in all hostel blocks during the week of " +
    "19/10/2026. Residents are requested to keep their rooms clean and electrical appliances " +
    "other than those permitted must be removed.\n" +
    "Maintenance complaints may be logged with the hostel office before the inspection."],
  ["2026-09-28", "Academic", "Guest lecture on responsible use of AI tools",
    "The Department of Computer Science is organising a guest lecture on responsible and " +
    "ethical use of AI tools in academic work on 30/10/2026 in the Main Auditorium.\n" +
    "Attendance is compulsory for first-year students and open to all others."],
  ["2026-09-02", "Exam", "Registration for back paper examinations",
    "Students who wish to appear in back paper examinations must register through the Exam " +
    "section of the portal by 12/09/2026. Late registrations will not be accepted."],
  ["2026-08-20", "Hostel", "Revised mess timings",
    "With effect from 01/09/2026, the hostel mess will follow these timings: breakfast " +
    "7:30-9:00, lunch 12:30-2:00, snacks 5:00-6:00 and dinner 7:30-9:30."],
  ["2026-08-01", "General", "Commencement of the odd semester",
    "Classes for the odd semester of session 2026-27 will commence on 03/08/2026. Students " +
    "should check their time table on the portal and report to their classes on time."],
];

/** Mock drives, dated relative to the first start so some are open, some closed.
 * Company names are fictional. */
function _drives_seed(today) {
  const d = (days) => today.addDays(days).isoformat();
  return [
    // company, role, ctc, location, description, min_cgpa, branches, apply_by, drive_date
    ["Nimbus Byteworks", "Graduate Software Engineer", 8.5, "Bengaluru",
      "Online coding test followed by two technical interviews and an HR round.",
      7.0, "CSE, IT, ECE", d(10), d(18)],
    ["Riverstone Analytics", "Data Analyst Trainee", 6.0, "Pune",
      "Aptitude test, SQL/Excel case study and a panel interview.",
      6.5, "All branches", d(5), d(12)],
    ["Bluepeak Systems", "Associate Cloud Engineer", 7.2, "Hyderabad",
      "Written test on networking and Linux fundamentals, then technical and HR interviews.",
      6.0, "CSE, IT", d(21), d(30)],
    ["Copperleaf Motors", "Graduate Engineer Trainee", 5.4, "Gurugram",
      "Technical interview covering core engineering subjects, followed by HR discussion.",
      6.0, "ME, EE, ECE", d(3), d(9)],
    ["Lumen Grid Energy", "Junior Electrical Engineer", 5.0, "Dehradun",
      "Group discussion and technical interview.",
      6.5, "EE, ECE", d(-6), d(-1)],
    ["Quillstack Software", "Software Developer Intern + PPO", 10.0, "Remote",
      "Six-month internship with a pre-placement offer based on performance.",
      7.5, "CSE, IT", d(-20), d(-12)],
  ];
}

// Mock applications, by enrollment no. and company: [status, days since applying].
const _APPLICATIONS_SEED = [
  ["PV-25190001", "Quillstack Software", "Selected", 25],
  ["PV-25190001", "Lumen Grid Energy", "Rejected", 9],
  ["PV-25190001", "Riverstone Analytics", "Shortlisted", 2],
  ["PV-25190002", "Quillstack Software", "Rejected", 24],
  ["PV-25190002", "Nimbus Byteworks", "Applied", 1],
  ["PV-25190003", "Lumen Grid Energy", "Selected", 8],
];

/** Insert mock circulars and drives the first time only (each table seeded when empty). */
export function seed(conn) {
  const now = _now();
  if (conn.execute("SELECT COUNT(*) AS n FROM campus_circulars").fetchone().n === 0) {
    conn.executemany(
      "INSERT INTO campus_circulars (date, category, title, body, created_at)" +
      " VALUES (?, ?, ?, ?, ?)",
      MOCK_CIRCULARS.map((c) => [...c, now]));
  }
  if (conn.execute("SELECT COUNT(*) AS n FROM campus_drives").fetchone().n === 0) {
    const today = PyDate.today();
    conn.executemany(
      "INSERT INTO campus_drives (company, role, ctc_lpa, location, description, min_cgpa," +
      " branches, apply_by, drive_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      _drives_seed(today).map((dr) => [...dr, now]));
    for (const [enrollment_no, company, status, ago] of _APPLICATIONS_SEED) {
      const student = conn.execute("SELECT id FROM students WHERE enrollment_no = ?",
        [enrollment_no]).fetchone();
      const drive = conn.execute("SELECT id FROM campus_drives WHERE company = ?",
        [company]).fetchone();
      if (student && drive) {
        const ts = PyDateTime.now().addDays(-ago).isoformat();
        conn.execute(
          "INSERT OR IGNORE INTO campus_applications" +
          " (drive_id, student_id, status, applied_at, updated_at) VALUES (?, ?, ?, ?, ?)",
          [drive.id, student.id, status, ts, ts]);
      }
    }
  }
}

function _now() {
  return nowISO();
}

function _today() {
  return todayISO();
}

function _clean(data, key, label, required = true) {
  const value = String(data[key] ?? "").trim();
  if (required && !value) throw new ValueError(`${label} is required.`);
  return value;
}

function _clean_date(data, key, label) {
  const value = _clean(data, key, label);
  try {
    return PyDate.fromisoformat(value).isoformat();
  } catch {
    throw new ValueError(`${label} must be a valid date (YYYY-MM-DD).`);
  }
}

function _clean_number(data, key, label, lo, hi) {
  const raw = _clean(data, key, label);
  // Python float(): decimal or exponent notation only.
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(raw)) throw new ValueError(`${label} must be a number.`);
  const value = Number(raw);
  if (!(lo <= value && value <= hi)) {
    throw new ValueError(`${label} must be between ${pyFormat("%g", lo)} and ${pyFormat("%g", hi)}.`);
  }
  return value;
}

// ---- Circulars ------------------------------------------------------------

/** Circulars, newest first. `search` matches title or body (case-insensitive);
 * `category` must be one of CATEGORIES to filter (anything else is ignored). */
export function list_circulars(search = "", category = "") {
  let sql = "SELECT * FROM campus_circulars WHERE 1 = 1";
  const params = [];
  search = (search || "").trim();
  if (search) {
    const like = `%${search}%`;
    sql += " AND (title LIKE ? OR body LIKE ?)";
    params.push(like, like);
  }
  if (CATEGORIES.includes(category)) {
    sql += " AND category = ?";
    params.push(category);
  }
  sql += " ORDER BY date DESC, id DESC";
  return db.connect().execute(sql, params).fetchall();
}

/** One circular row, or null. */
export function get_circular(circular_id) {
  return db.connect().execute("SELECT * FROM campus_circulars WHERE id = ?", [circular_id]).fetchone();
}

function _circular_values(data) {
  const category = _clean(data, "category", "Category");
  if (!CATEGORIES.includes(category)) {
    throw new ValueError("Category must be one of: " + CATEGORIES.join(", ") + ".");
  }
  return [_clean_date(data, "date", "Date"), category, _clean(data, "title", "Title"),
    _clean(data, "body", "Body", false)];
}

/** data: {date: 'YYYY-MM-DD', category: one of CATEGORIES, title, body (optional)}.
 * Returns the new id. Throws ValueError on invalid input. */
export function create_circular(data) {
  const values = _circular_values(data);
  return db.connect().execute(
    "INSERT INTO campus_circulars (date, category, title, body, created_at)" +
    " VALUES (?, ?, ?, ?, ?)", [...values, _now()]).lastrowid;
}

/** Same data keys as create_circular. Throws ValueError on invalid input. */
export function update_circular(circular_id, data) {
  const values = _circular_values(data);
  db.connect().execute("UPDATE campus_circulars SET date = ?, category = ?, title = ?, body = ?" +
    " WHERE id = ?", [...values, circular_id]);
}

export function delete_circular(circular_id) {
  db.connect().execute("DELETE FROM campus_circulars WHERE id = ?", [circular_id]);
}

// ---- Placement drives -----------------------------------------------------

const _DRIVE_COLUMNS = `d.*,
    (SELECT COUNT(*) FROM campus_applications a WHERE a.drive_id = d.id) AS applicant_count,
    (d.apply_by >= :today) AS is_open`;

/** All drives ordered by drive date (soonest open ones first).
 *
 * Each row has the drive columns plus `applicant_count`, `is_open` (1 while
 * today <= apply_by) and, when student_id is given, `my_status` (the student's
 * application status or null). upcoming_only: only drives still open. */
export function list_drives(student_id = null, upcoming_only = false) {
  let sql = `SELECT ${_DRIVE_COLUMNS}`;
  const params = { today: _today() };
  if (student_id !== null) {
    sql += ", (SELECT status FROM campus_applications a" +
      " WHERE a.drive_id = d.id AND a.student_id = :sid) AS my_status";
    params.sid = student_id;
  }
  sql += " FROM campus_drives d";
  if (upcoming_only) sql += " WHERE d.apply_by >= :today";
  // Open drives first (soonest deadline first), then closed ones (most recent first).
  sql += " ORDER BY (d.apply_by >= :today) DESC," +
    " CASE WHEN d.apply_by >= :today THEN d.apply_by END ASC, d.drive_date DESC";
  return db.connect().execute(sql, params).fetchall();
}

/** One drive row (with applicant_count and is_open), or null. */
export function get_drive(drive_id) {
  return db.connect().execute(`SELECT ${_DRIVE_COLUMNS} FROM campus_drives d WHERE d.id = :id`,
    { today: _today(), id: drive_id }).fetchone();
}

function _drive_values(data) {
  const apply_by = _clean_date(data, "apply_by", "Last date to apply");
  const drive_date = _clean_date(data, "drive_date", "Drive date");
  if (drive_date < apply_by) throw new ValueError("Drive date cannot be before the last date to apply.");
  return [_clean(data, "company", "Company"), _clean(data, "role", "Role"),
    _clean_number(data, "ctc_lpa", "CTC (LPA)", 0, 1000),
    _clean(data, "location", "Location", false),
    _clean(data, "description", "Description", false),
    _clean(data, "min_cgpa", "", false) ? _clean_number(data, "min_cgpa", "Minimum CGPA", 0, 10) : 0.0,
    _clean(data, "branches", "Branches", false) || "All branches",
    apply_by, drive_date];
}

/** data: {company, role, ctc_lpa (number, lakh per annum), location?, description?,
 * min_cgpa? (0-10, default 0), branches? (text, default 'All branches'),
 * apply_by: 'YYYY-MM-DD', drive_date: 'YYYY-MM-DD' (>= apply_by)}.
 * Returns the new id. Throws ValueError on invalid input. */
export function create_drive(data) {
  const values = _drive_values(data);
  return db.connect().execute(
    "INSERT INTO campus_drives (company, role, ctc_lpa, location, description, min_cgpa," +
    " branches, apply_by, drive_date, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [...values, _now()]).lastrowid;
}

/** Same data keys as create_drive. Throws ValueError on invalid input. */
export function update_drive(drive_id, data) {
  const values = _drive_values(data);
  db.connect().execute(
    "UPDATE campus_drives SET company = ?, role = ?, ctc_lpa = ?, location = ?," +
    " description = ?, min_cgpa = ?, branches = ?, apply_by = ?, drive_date = ?" +
    " WHERE id = ?", [...values, drive_id]);
}

/** Deletes the drive and (via cascade) its applications. */
export function delete_drive(drive_id) {
  db.connect().execute("DELETE FROM campus_drives WHERE id = ?", [drive_id]);
}

// ---- Applications ---------------------------------------------------------

/** Applicants for one drive: application columns plus student `name`,
 * `roll_no`, `enrollment_no`; ordered by application time. */
export function list_applications(drive_id) {
  return db.connect().execute(
    "SELECT a.*, s.name, s.roll_no, s.enrollment_no FROM campus_applications a" +
    " JOIN students s ON s.id = a.student_id WHERE a.drive_id = ?" +
    " ORDER BY a.applied_at, a.id", [drive_id]).fetchall();
}

/** status: one of APPLICATION_STATUSES. Throws ValueError otherwise or if
 * the application does not exist. */
export function set_application_status(application_id, status) {
  if (!APPLICATION_STATUSES.includes(status)) {
    throw new ValueError("Status must be one of: " + APPLICATION_STATUSES.join(", ") + ".");
  }
  const cur = db.connect().execute("UPDATE campus_applications SET status = ?, updated_at = ? WHERE id = ?",
    [status, _now(), application_id]);
  if (cur.rowcount === 0) throw new ValueError("Application not found.");
}

/** The student's applications, newest first, with drive details
 * (`company`, `role`, `ctc_lpa`, `apply_by`, `drive_date`, `location`, `is_open`). */
export function student_applications(student_id) {
  return db.connect().execute(
    "SELECT a.*, d.company, d.role, d.ctc_lpa, d.location, d.apply_by, d.drive_date," +
    " (d.apply_by >= ?) AS is_open FROM campus_applications a" +
    " JOIN campus_drives d ON d.id = a.drive_id WHERE a.student_id = ?" +
    " ORDER BY a.applied_at DESC, a.id DESC", [_today(), student_id]).fetchall();
}

/** Apply to a drive. Throws ValueError if the drive is missing, closed,
 * or the student has already applied. */
export function apply(student_id, drive_id) {
  const drive = get_drive(drive_id);
  if (drive === null) throw new ValueError("This drive no longer exists.");
  if (!drive.is_open) {
    const closed = PyDate.fromisoformat(drive.apply_by).strftime("%d/%m/%Y");
    throw new ValueError(`Applications for ${drive.company} closed on ${closed}.`);
  }
  const now = _now();
  try {
    db.connect().execute("INSERT INTO campus_applications (drive_id, student_id, status, applied_at," +
      " updated_at) VALUES (?, ?, 'Applied', ?, ?)", [drive_id, student_id, now, now]);
  } catch (e) {
    if (e instanceof IntegrityError) throw new ValueError(`You have already applied to ${drive.company}.`);
    throw e;
  }
  return drive;
}

/** Withdraw an application. Allowed only before the deadline and while the
 * status is still 'Applied'. Throws ValueError otherwise. */
export function withdraw(student_id, drive_id) {
  const drive = get_drive(drive_id);
  if (drive === null) throw new ValueError("This drive no longer exists.");
  if (!drive.is_open) throw new ValueError("The deadline has passed; applications can no longer be withdrawn.");
  const conn = db.connect();
  const row = conn.execute("SELECT id, status FROM campus_applications" +
    " WHERE drive_id = ? AND student_id = ?", [drive_id, student_id]).fetchone();
  if (row === null) throw new ValueError(`You have not applied to ${drive.company}.`);
  if (row.status !== "Applied") {
    throw new ValueError(`Your application is already ${row.status.toLowerCase()} ` +
      "and can't be withdrawn.");
  }
  conn.execute("DELETE FROM campus_applications WHERE id = ?", [row.id]);
  return drive;
}

/** Campus-wide figures: drives, open_drives, companies, offers (Selected
 * applications), placed (distinct students selected), highest_ctc (from a
 * Selected offer, else null). */
export function placement_stats() {
  return db.connect().execute(
    "SELECT" +
    " (SELECT COUNT(*) FROM campus_drives) AS drives," +
    " (SELECT COUNT(*) FROM campus_drives WHERE apply_by >= :today) AS open_drives," +
    " (SELECT COUNT(DISTINCT company) FROM campus_drives) AS companies," +
    " (SELECT COUNT(*) FROM campus_applications WHERE status = 'Selected') AS offers," +
    " (SELECT COUNT(DISTINCT student_id) FROM campus_applications" +
    "   WHERE status = 'Selected') AS placed," +
    " (SELECT MAX(d.ctc_lpa) FROM campus_applications a JOIN campus_drives d" +
    "   ON d.id = a.drive_id WHERE a.status = 'Selected') AS highest_ctc",
    { today: _today() }).fetchone();
}
