/* Academic module: timetable, feedback, minor/specialisation choices.
 * Port of erp/academic.py.
 *
 * Tables live in SCHEMA; seed(conn) adds mock data and must be idempotent
 * (it runs on every start). See DOMAIN_MODULES in erp/db.js.
 *
 * The shared `subjects` and `attendance` tables (erp/db.js) are only read
 * here; per-subject extras (credits, faculty) live in acad_courses.
 */
import * as db from "./db.js";
import { PyDate, PyDateTime, nowISO, pyRound } from "../lib/py.js";

export const SCHEMA = `
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

-- Extra details for a row of the shared \`subjects\` table.
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
`;

export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// [period no, start, end]. Short breaks follow period 2 and period 4.
export const PERIODS = [
  [1, "09:00", "09:55"],
  [2, "09:55", "10:50"],
  [3, "11:10", "12:05"],
  [4, "12:05", "13:00"],
  [5, "13:45", "14:40"],
  [6, "14:40", "15:35"],
  [7, "15:35", "16:30"],
];

export const DEFAULT_SECTION = "A";
export const DEFAULT_ENROLLMENT = { program: "B.Tech", branch: "Computer Science & Engineering",
  semester: db.CURRENT_SEMESTER, section: DEFAULT_SECTION };

export const FEEDBACK_QUESTIONS = [
  [1, "Explains concepts clearly and with examples"],
  [2, "Comes prepared and covers the syllabus on schedule"],
  [3, "Encourages questions and class participation"],
  [4, "Is punctual and regular in taking classes"],
  [5, "Gives useful feedback on assignments and tests"],
];
export const RATING_LABELS = { 1: "Poor", 2: "Fair", 3: "Good", 4: "Very good", 5: "Excellent" };
export const FEEDBACK_COMMENT_MAX = 1000;

export const MINOR_KINDS = ["Specialisation", "Minor"];
export const MAX_PREFERENCES = 3;

// ---- Mock data (generic, not real people or places) ----------------------

const MOCK_FACULTY = [
  ["Dr. Anita Mehta", "Mathematics"],
  ["Dr. Ravi Iyer", "Physics"],
  ["Prof. Sunil Kulkarni", "Electronics"],
  ["Ms. Priya Verma", "Computer Science"],
  ["Dr. Neeraj Bhatt", "Computer Science"],
  ["Mr. Karan Malhotra", "Physics"],
  ["Ms. Ritu Menon", "Electronics"],
  ["Mr. Arjun Das", "Mechanical"],
];

const MOCK_COURSES = [
  // subject code, kind, credits, faculty name
  ["TMA101", "Theory", 4, "Dr. Anita Mehta"],
  ["TPH102", "Theory", 3, "Dr. Ravi Iyer"],
  ["TEC103", "Theory", 3, "Prof. Sunil Kulkarni"],
  ["TCS104", "Theory", 4, "Ms. Priya Verma"],
  ["TCS105", "Theory", 3, "Dr. Neeraj Bhatt"],
  ["PPH151", "Lab", 1, "Mr. Karan Malhotra"],
  ["PEC152", "Lab", 1, "Ms. Ritu Menon"],
  ["PWS153", "Lab", 1, "Mr. Arjun Das"],
];

const MOCK_TIMETABLE = [
  // day, period, span, subject code, room
  [0, 1, 1, "TMA101", "LT-201"], [0, 2, 1, "TPH102", "LT-201"], [0, 3, 1, "TCS104", "LT-201"],
  [0, 4, 1, "TEC103", "LT-201"], [0, 5, 2, "PPH151", "Physics Lab B-104"], [0, 7, 1, "TCS105", "LT-201"],
  [1, 1, 1, "TCS104", "LT-201"], [1, 2, 1, "TMA101", "LT-201"], [1, 3, 1, "TCS105", "LT-201"],
  [1, 4, 1, "TPH102", "LT-201"], [1, 5, 2, "PEC152", "Electronics Lab C-210"],
  [2, 1, 1, "TEC103", "LT-202"], [2, 2, 1, "TCS104", "LT-202"], [2, 3, 1, "TMA101", "LT-202"],
  [2, 4, 1, "TCS105", "LT-202"], [2, 5, 1, "TPH102", "LT-202"], [2, 6, 2, "PWS153", "Workshop W-01"],
  [3, 1, 1, "TPH102", "LT-201"], [3, 2, 1, "TEC103", "LT-201"], [3, 3, 1, "TMA101", "LT-201"],
  [3, 4, 1, "TCS104", "LT-201"], [3, 5, 1, "TCS105", "LT-201"],
  [4, 1, 1, "TCS105", "LT-203"], [4, 2, 1, "TMA101", "LT-203"], [4, 3, 1, "TEC103", "LT-203"],
  [4, 4, 1, "TCS104", "LT-203"], [4, 5, 1, "TPH102", "LT-203"],
  [5, 1, 1, "TCS104", "LT-201"], [5, 2, 1, "TCS105", "LT-201"], [5, 3, 1, "TEC103", "LT-201"],
];

const MOCK_MINORS = [
  // kind, title, department, seats, description
  ["Specialisation", "Artificial Intelligence & Machine Learning", "Computer Science", 60,
    "Deep learning, NLP and applied ML projects from semester 5."],
  ["Specialisation", "Cyber Security", "Computer Science", 60,
    "Network security, cryptography and secure software development."],
  ["Specialisation", "Data Science", "Computer Science", 60,
    "Statistics, data engineering and visual analytics."],
  ["Specialisation", "Cloud Computing", "Computer Science", 40,
    "Distributed systems, containers and cloud architecture."],
  ["Minor", "Robotics & Automation", "Mechanical", 30,
    "Kinematics, sensors and control for robotic systems."],
  ["Minor", "VLSI Design", "Electronics", 30,
    "Digital IC design, verification and FPGA prototyping."],
  ["Minor", "Finance & Economics", "Management", 30,
    "Financial accounting, markets and engineering economics."],
];

const count = (conn, table) => conn.execute(`SELECT COUNT(*) AS n FROM ${table}`).fetchone().n;

/** Insert mock rows into any empty acad_ table. Safe to run on every start. */
export function seed(conn) {
  if (count(conn, "acad_faculty") === 0) {
    conn.executemany("INSERT INTO acad_faculty (name, department) VALUES (?, ?)", MOCK_FACULTY);
  }
  const subject_ids = Object.fromEntries(
    conn.execute("SELECT id, code FROM subjects").fetchall().map((r) => [r.code, r.id]));
  const faculty_ids = Object.fromEntries(
    conn.execute("SELECT id, name FROM acad_faculty").fetchall().map((r) => [r.name, r.id]));
  if (count(conn, "acad_courses") === 0) {
    conn.executemany(
      "INSERT INTO acad_courses (subject_id, kind, credits, faculty_id) VALUES (?, ?, ?, ?)",
      MOCK_COURSES.filter(([code]) => code in subject_ids)
        .map(([code, kind, credits, fac]) => [subject_ids[code], kind, credits, faculty_ids[fac] ?? null]));
  }
  if (count(conn, "acad_timetable") === 0) {
    conn.executemany(
      "INSERT INTO acad_timetable (section, day, period, span, subject_id, room)" +
      " VALUES (?, ?, ?, ?, ?, ?)",
      MOCK_TIMETABLE.filter(([, , , code]) => code in subject_ids)
        .map(([day, period, span, code, room]) => [DEFAULT_SECTION, day, period, span, subject_ids[code], room]));
  }
  if (count(conn, "acad_minors") === 0) {
    conn.executemany(
      "INSERT INTO acad_minors (kind, title, department, seats, description) VALUES (?, ?, ?, ?, ?)",
      MOCK_MINORS);
  }
  // Every existing student gets the default enrollment (no-op for those who have one).
  const d = DEFAULT_ENROLLMENT;
  conn.execute(
    "INSERT OR IGNORE INTO acad_enrollments (student_id, program, branch, semester, section)" +
    " SELECT id, ?, ?, ?, ? FROM students",
    [d.program, d.branch, d.semester, d.section]);
}

function _now() {
  return nowISO();
}

// ---- Enrollment and registered subjects -----------------------------------

export function get_enrollment(student_id) {
  const row = db.connect().execute("SELECT * FROM acad_enrollments WHERE student_id = ?", [student_id]).fetchone();
  return row ? { ...row } : { ...DEFAULT_ENROLLMENT };
}

/** All registered subjects with credits/faculty. Subjects an admin added
 * without acad_courses details still appear (kind guessed from the code). */
export function list_courses() {
  const rows = db.connect().execute(
    "SELECT s.id, s.code, s.name, c.kind, c.credits, f.name AS faculty" +
    " FROM subjects s LEFT JOIN acad_courses c ON c.subject_id = s.id" +
    " LEFT JOIN acad_faculty f ON f.id = c.faculty_id ORDER BY s.code").fetchall();
  const courses = rows.map((r) => ({ ...r, kind: r.kind || (r.code.startsWith("P") ? "Lab" : "Theory") }));
  // Theory first, then labs, each in code order.
  return courses.sort((a, b) => ((a.kind !== "Theory") - (b.kind !== "Theory"))
    || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

export function get_course(code) {
  return list_courses().find((c) => c.code === code) ?? null;
}

// ---- Timetable --------------------------------------------------------------

/** Weekly grid: one object per day, each with `cells` covering every period.
 * A cell is {entry: ..., span: n} or {entry: null, span: 1} (free). */
export function timetable(section) {
  const rows = db.connect().execute(
    "SELECT t.day, t.period, t.span, t.room, s.code, s.name," +
    " COALESCE(c.kind, CASE WHEN s.code LIKE 'P%' THEN 'Lab' ELSE 'Theory' END) AS kind," +
    " f.name AS faculty" +
    " FROM acad_timetable t JOIN subjects s ON s.id = t.subject_id" +
    " LEFT JOIN acad_courses c ON c.subject_id = s.id" +
    " LEFT JOIN acad_faculty f ON f.id = c.faculty_id" +
    " WHERE t.section = ? ORDER BY t.day, t.period", [section]).fetchall();
  const times = Object.fromEntries(PERIODS.map(([p, start, end]) => [p, [start, end]]));
  const by_slot = new Map(rows.map((r) => [`${r.day},${r.period}`, { ...r }]));
  const last = PERIODS.length;
  const days = [];
  DAYS.forEach((day_name, day) => {
    const cells = [], classes = [];
    let period = 1;
    while (period <= last) {
      const entry = by_slot.get(`${day},${period}`);
      if (entry) {
        const span = Math.max(1, Math.min(entry.span, last - period + 1));
        entry.start = times[period][0];
        entry.end = times[period + span - 1][1];
        entry.periods = span === 1 ? `P${period}` : `P${period}-P${period + span - 1}`;
        cells.push({ entry, span });
        classes.push(entry);
        period += span;
      } else {
        cells.push({ entry: null, span: 1 });
        period += 1;
      }
    }
    days.push({ index: day, name: day_name, cells, classes });
  });
  return days;
}

/** [[start, end]] of the gaps between consecutive periods. */
export function break_times() {
  const out = [];
  for (let i = 0; i + 1 < PERIODS.length; i++) {
    const a = PERIODS[i], b = PERIODS[i + 1];
    if (a[2] !== b[1]) out.push([a[2], b[1]]);
  }
  return out;
}

/** Classes today plus the class in session and the next one, for the summary cards. */
export function today_status(days, now = null) {
  now = now || PyDateTime.now();
  const weekday = now.weekday();
  if (weekday >= DAYS.length) return { weekday: null, count: 0, current: null, next: null };
  const classes = days[weekday].classes;
  const hhmm = now.strftime("%H:%M");
  const current = classes.find((c) => c.start <= hhmm && hhmm < c.end) ?? null;
  const upcoming = classes.find((c) => c.start > hhmm) ?? null;
  return { weekday, count: classes.length, current, next: upcoming };
}

// ---- Date-wise attendance ---------------------------------------------------

/** Date-by-date attendance, newest first. status: 'present', 'absent' or null. */
export function attendance_log(student_id, subject_code = null, status = null) {
  let sql = "SELECT a.date, a.present, s.code, s.name, f.name AS faculty" +
    " FROM attendance a JOIN subjects s ON s.id = a.subject_id" +
    " LEFT JOIN acad_courses c ON c.subject_id = s.id" +
    " LEFT JOIN acad_faculty f ON f.id = c.faculty_id" +
    " WHERE a.student_id = ?";
  const params = [student_id];
  if (subject_code) {
    sql += " AND s.code = ?";
    params.push(subject_code);
  }
  if (status === "present" || status === "absent") {
    sql += " AND a.present = ?";
    params.push(status === "present" ? 1 : 0);
  }
  sql += " ORDER BY a.date DESC, s.code";
  return db.connect().execute(sql, params).fetchall().map((r) => ({
    ...r, weekday: PyDate.fromisoformat(r.date.slice(0, 10)).strftime("%a"),
  }));
}

/** {subject code: percent} for the overview table. */
export function attendance_by_subject(student_id) {
  const rows = db.connect().execute(
    "SELECT s.code, COUNT(a.id) AS total, COALESCE(SUM(a.present), 0) AS present" +
    " FROM attendance a JOIN subjects s ON s.id = a.subject_id" +
    " WHERE a.student_id = ? GROUP BY s.id", [student_id]).fetchall();
  return Object.fromEntries(rows.filter((r) => r.total)
    .map((r) => [r.code, pyRound(r.present * 100 / r.total, 1)]));
}

// ---- Feedback ---------------------------------------------------------------

/** {subject code: submitted_at} for the feedback the student has already given. */
export function feedback_status(student_id, session) {
  const rows = db.connect().execute(
    "SELECT s.code, f.submitted_at FROM acad_feedback f JOIN subjects s ON s.id = f.subject_id" +
    " WHERE f.student_id = ? AND f.session = ?", [student_id, session]).fetchall();
  return Object.fromEntries(rows.map((r) => [r.code, r.submitted_at]));
}

/** The student's own submission (ratings by question number), or null. */
export function get_feedback(student_id, subject_code, session) {
  const conn = db.connect();
  const fb = conn.execute(
    "SELECT f.* FROM acad_feedback f JOIN subjects s ON s.id = f.subject_id" +
    " WHERE f.student_id = ? AND s.code = ? AND f.session = ?",
    [student_id, subject_code, session]).fetchone();
  if (fb === null) return null;
  const ratings = Object.fromEntries(conn.execute(
    "SELECT question_no, rating FROM acad_feedback_ratings WHERE feedback_id = ?", [fb.id])
    .fetchall().map((r) => [r.question_no, r.rating]));
  return { comment: fb.comment, submitted_at: fb.submitted_at, ratings };
}

/** Read q1..qN from a submitted form. Returns {question_no: rating} or throws ValueError. */
export function parse_ratings(form) {
  const ratings = {};
  for (const [qno] of FEEDBACK_QUESTIONS) {
    const value = (form.get(`q${qno}`) || "").trim();
    if (!["1", "2", "3", "4", "5"].includes(value)) {
      throw new db.ValueError("Please rate every question from 1 to 5.");
    }
    ratings[qno] = parseInt(value, 10);
  }
  return ratings;
}

/** Save one feedback. Throws ValueError for an unknown subject or a repeat submission. */
export function submit_feedback(student_id, subject_code, session, ratings, comment = "") {
  comment = (comment || "").trim().slice(0, FEEDBACK_COMMENT_MAX);
  const conn = db.connect();
  const subject = conn.execute("SELECT id FROM subjects WHERE code = ?", [subject_code]).fetchone();
  if (subject === null) throw new db.ValueError("Unknown subject.");
  db.transaction(() => {
    let cur;
    try {
      cur = conn.execute(
        "INSERT INTO acad_feedback (student_id, subject_id, session, comment, submitted_at)" +
        " VALUES (?, ?, ?, ?, ?)", [student_id, subject.id, session, comment, _now()]);
    } catch (e) {
      if (e instanceof db.IntegrityError) {
        throw new db.ValueError("You have already submitted feedback for this subject this session.");
      }
      throw e;
    }
    conn.executemany(
      "INSERT INTO acad_feedback_ratings (feedback_id, question_no, rating) VALUES (?, ?, ?)",
      Object.entries(ratings).map(([qno, rating]) => [Number(qno), rating])
        .sort((a, b) => a[0] - b[0]).map(([qno, rating]) => [cur.lastrowid, qno, rating]));
  });
}

// ---- Minor / specialisation -------------------------------------------------

/** Offered programs of one kind, with how many students put each first. */
export function list_minors(kind, session) {
  return db.connect().execute(
    "SELECT m.*, (SELECT COUNT(*) FROM acad_minor_choices ch" +
    "   JOIN acad_minor_applications a ON a.id = ch.application_id" +
    "   WHERE ch.minor_id = m.id AND ch.rank = 1 AND a.session = ?) AS first_choices" +
    " FROM acad_minors m WHERE m.kind = ? ORDER BY m.title", [session, kind]).fetchall();
}

/** The student's application with its ordered choices, or null. */
export function get_application(student_id, kind, session) {
  const conn = db.connect();
  const app = conn.execute(
    "SELECT a.*, m.title AS allotted_title FROM acad_minor_applications a" +
    " LEFT JOIN acad_minors m ON m.id = a.allotted_id" +
    " WHERE a.student_id = ? AND a.kind = ? AND a.session = ?", [student_id, kind, session]).fetchone();
  if (app === null) return null;
  const choices = conn.execute(
    "SELECT ch.rank, m.id, m.title, m.department FROM acad_minor_choices ch" +
    " JOIN acad_minors m ON m.id = ch.minor_id WHERE ch.application_id = ? ORDER BY ch.rank",
    [app.id]).fetchall();
  return { ...app, choices: choices.map((c) => ({ ...c })) };
}

/** Save (or replace, while still 'Submitted') the ordered choices.
 * minor_ids: list of ids in preference order; blanks already removed. */
export function submit_preferences(student_id, kind, session, minor_ids) {
  if (!MINOR_KINDS.includes(kind)) throw new db.ValueError("Unknown programme type.");
  if (!minor_ids.length) throw new db.ValueError("Choose at least your first preference.");
  if (minor_ids.length > MAX_PREFERENCES) {
    throw new db.ValueError(`You can choose at most ${MAX_PREFERENCES} preferences.`);
  }
  if (new Set(minor_ids).size !== minor_ids.length) {
    throw new db.ValueError("Each preference must be a different programme.");
  }
  const conn = db.connect();
  const valid = new Set(conn.execute("SELECT id FROM acad_minors WHERE kind = ?", [kind]).fetchall().map((r) => r.id));
  if (!minor_ids.every((id) => valid.has(id))) {
    throw new db.ValueError("One of the selected programmes is not offered.");
  }
  const app = conn.execute(
    "SELECT id, status FROM acad_minor_applications WHERE student_id = ? AND kind = ? AND session = ?",
    [student_id, kind, session]).fetchone();
  if (app && app.status !== "Submitted") throw new db.ValueError("Your preferences can no longer be changed.");
  db.transaction(() => {
    let app_id;
    if (app) {
      app_id = app.id;
      conn.execute("UPDATE acad_minor_applications SET submitted_at = ? WHERE id = ?", [_now(), app_id]);
      conn.execute("DELETE FROM acad_minor_choices WHERE application_id = ?", [app_id]);
    } else {
      app_id = conn.execute(
        "INSERT INTO acad_minor_applications (student_id, kind, session, submitted_at)" +
        " VALUES (?, ?, ?, ?)", [student_id, kind, session, _now()]).lastrowid;
    }
    conn.executemany(
      "INSERT INTO acad_minor_choices (application_id, minor_id, rank) VALUES (?, ?, ?)",
      minor_ids.map((mid, i) => [app_id, mid, i + 1]));
  });
}

/** Delete a still-editable application. Returns true if one was removed. */
export function withdraw_preferences(student_id, kind, session) {
  const cur = db.connect().execute(
    "DELETE FROM acad_minor_applications WHERE student_id = ? AND kind = ? AND session = ?" +
    " AND status = 'Submitted'", [student_id, kind, session]);
  return cur.rowcount > 0;
}
