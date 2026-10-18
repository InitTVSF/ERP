/* Exam module: date sheet, exam registration, admit card and results.
 * Port of erp/exams.py.
 *
 * Tables live in SCHEMA; seed(conn) adds mock data and must be idempotent
 * (it runs on every start). See DOMAIN_MODULES in erp/db.js.
 *
 * Model
 * -----
 * exam_schedule       - date sheet for the current term, one row per subject
 *                       and exam type, built from the shared `subjects` table.
 * exam_registrations  - a student's registration for the current term's
 *                       end-term/practical examinations (one per term).
 * exam_back_papers    - back-paper (re-appear) registrations for a failed
 *                       past course, for the current term.
 * exam_courses        - mock past-semester courses (results reference these,
 *                       not `subjects`, which only holds the current term).
 * exam_results        - per student, per past course: internal/external marks.
 *                       Grades, grade points, SGPA and CGPA are computed in
 *                       JS from the marks (see GRADE_SCALE / gpa()).
 *
 * The portal has no "current semester" field per student yet, so every student
 * is treated as being in CURRENT_SEMESTER, with results for the semesters
 * before it.
 */
import * as db from "./db.js";
import { PyDate, PyRandom, nowISO, pyRound, todayISO } from "../lib/py.js";

export const CURRENT_TERM = "2026-ODD";
export const CURRENT_TERM_LABEL = "End-Term Examination, Odd Semester 2026-27";
export const CURRENT_SEMESTER = db.CURRENT_SEMESTER;
export const REGISTRATION_DEADLINE = "2026-11-10";  // inclusive

// First exam day for each exam type of the current term's date sheet.
const TYPE_START = {
  "Mid-Term": new PyDate(2026, 9, 21),
  "Practical": new PyDate(2026, 11, 16),
  "End-Term": new PyDate(2026, 11, 23),
};
export const TYPE_ORDER = ["Mid-Term", "Practical", "End-Term"];
const SESSIONS = {
  Morning: ["10:00", "13:00"],
  Evening: ["14:00", "17:00"],
};
// Exams that need registration (and appear on the admit card).
export const REGISTERED_TYPES = ["Practical", "End-Term"];

// 10-point scale: [minimum percentage, grade, grade points], highest first.
export const GRADE_SCALE = [
  [90, "O", 10],
  [80, "A+", 9],
  [70, "A", 8],
  [60, "B+", 7],
  [50, "B", 6],
  [45, "C", 5],
  [40, "P", 4],
  [0, "F", 0],
];
export const PASS_PERCENT = 40;

// Mock past-semester courses: semester, code, name, credits, kind.
const MOCK_COURSES = [
  [1, "XMA111", "Calculus and Linear Algebra", 4, "Theory"],
  [1, "XCH112", "Engineering Chemistry", 3, "Theory"],
  [1, "XEE113", "Basic Electrical Engineering", 3, "Theory"],
  [1, "XCS114", "Problem Solving with Python", 4, "Theory"],
  [1, "XHS115", "Professional Communication", 2, "Theory"],
  [1, "XCH161", "Chemistry Lab", 1, "Practical"],
  [1, "XCS162", "Python Programming Lab", 2, "Practical"],
  [2, "XMA121", "Differential Equations and Transforms", 4, "Theory"],
  [2, "XCS122", "Data Structures", 4, "Theory"],
  [2, "XEC123", "Digital Logic Design", 3, "Theory"],
  [2, "XME124", "Engineering Graphics", 3, "Theory"],
  [2, "XEV125", "Environmental Studies", 2, "Theory"],
  [2, "XCS171", "Data Structures Lab", 2, "Practical"],
  [2, "XEC172", "Digital Logic Lab", 1, "Practical"],
];
// Maximum marks by course kind: [internal, external].
const MAX_MARKS = { Theory: [40, 60], Practical: [50, 50] };
const RESULT_DECLARED = { 1: "2026-02-20", 2: "2026-07-25" };

export const INSTRUCTIONS = [
  "Carry this admit card and your college ID card to every examination.",
  "Report to the examination hall at least 20 minutes before the start time.",
  "Mobile phones, smart watches and other electronic devices are not allowed.",
  "No candidate will be allowed to enter after 30 minutes of the start time.",
  "Use only blue or black pens; programmable calculators are not permitted.",
  "Any form of unfair means will lead to cancellation of the examination.",
];

export const SCHEMA = `
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
`;

// ---- Seeding --------------------------------------------------------------

export function seed(conn) {
  conn.executemany(
    "INSERT OR IGNORE INTO exam_courses (semester, code, name, credits, kind)" +
    " VALUES (?, ?, ?, ?, ?)", MOCK_COURSES);
  _seed_schedule(conn);
  for (const { id: sid } of conn.execute(
    "SELECT id FROM students WHERE id NOT IN (SELECT student_id FROM exam_results)").fetchall()) {
    _seed_results(conn, sid);
  }
}

function _is_practical(code, name) {
  const text = `${code} ${name}`.toLowerCase();
  return code.toUpperCase().startsWith("P") || ["lab", "workshop", "practical"].some((w) => text.includes(w));
}

function _next_exam_day(day) {
  day = day.addDays(1);
  while (day.weekday() === 6) day = day.addDays(1);  // no exams on Sundays
  return day;
}

/** Give every subject that has no date-sheet row yet its exams for the
 * current term. Subjects added later are appended after the last date. */
function _seed_schedule(conn) {
  const missing = conn.execute(
    "SELECT id, code, name FROM subjects WHERE id NOT IN" +
    " (SELECT subject_id FROM exam_schedule WHERE term = ?) ORDER BY code",
    [CURRENT_TERM]).fetchall();
  for (const subj of missing) {
    const types = _is_practical(subj.code, subj.name) ? ["Practical"] : ["Mid-Term", "End-Term"];
    for (const exam_type of types) {
      const last = conn.execute(
        "SELECT MAX(exam_date) AS last FROM exam_schedule WHERE term = ? AND exam_type = ?",
        [CURRENT_TERM, exam_type]).fetchone().last;
      let day;
      if (last) {
        day = _next_exam_day(PyDate.fromisoformat(last));
      } else {
        day = TYPE_START[exam_type];
        while (day.weekday() === 6) day = day.addDays(1);
      }
      // Mid-terms are 90-minute papers; the rest run the full session.
      const session = exam_type === "Practical" ? "Evening" : "Morning";
      let [start, end] = SESSIONS[session];
      if (exam_type === "Mid-Term") end = "11:30";
      conn.execute(
        "INSERT INTO exam_schedule (term, subject_id, exam_type, exam_date, session," +
        " start_time, end_time) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [CURRENT_TERM, subj.id, exam_type, day.isoformat(), session, start, end]);
    }
  }
}

/** Mock marks for all past-semester courses, deterministic per student. */
function _seed_results(conn, student_id) {
  const rng = new PyRandom(1000 + student_id);
  const ability = rng.uniform(0.52, 0.9);
  const rows = [];
  for (const course of conn.execute("SELECT id, kind FROM exam_courses WHERE semester < ?",
    [CURRENT_SEMESTER]).fetchall()) {
    const [imax, emax] = MAX_MARKS[course.kind] || MAX_MARKS.Theory;
    const level = Math.min(Math.max(ability + rng.gauss(0, 0.09), 0.2), 0.99);
    const internal = pyRound(imax * Math.min(level + rng.uniform(0, 0.08), 1.0));
    const external = pyRound(emax * level);
    rows.push([student_id, course.id, internal, imax, external, emax]);
  }
  conn.executemany(
    "INSERT OR IGNORE INTO exam_results (student_id, course_id, internal, internal_max," +
    " external, external_max) VALUES (?, ?, ?, ?, ?, ?)", rows);
}

/** Seed results for a student created after the last startup. */
export function ensure_student_data(student_id) {
  const conn = db.connect();
  if (!conn.execute("SELECT 1 FROM exam_results WHERE student_id = ? LIMIT 1", [student_id]).fetchone()) {
    _seed_results(conn, student_id);
  }
}

// ---- Grades ---------------------------------------------------------------

/** Percentage -> [grade, grade points] using GRADE_SCALE. */
export function grade_for(percent) {
  for (const [minimum, grade, points] of GRADE_SCALE) {
    if (percent >= minimum) return [grade, points];
  }
  return ["F", 0];
}

/** Credit-weighted grade point average:
 * sum(credits x grade points) / sum(credits). null when there are no credits.
 * Failed courses count with 0 grade points (their credits stay in the divisor). */
export function gpa(courses) {
  const total_credits = courses.reduce((a, c) => a + c.credits, 0);
  if (!total_credits) return null;
  return courses.reduce((a, c) => a + c.credits * c.grade_points, 0) / total_credits;
}

// ---- Date sheet and registration -----------------------------------------

export function date_sheet(term = CURRENT_TERM) {
  const rows = db.connect().execute(
    "SELECT e.*, s.code, s.name FROM exam_schedule e JOIN subjects s ON s.id = e.subject_id" +
    " WHERE e.term = ? ORDER BY e.exam_date, e.start_time, s.code", [term]).fetchall();
  const today = todayISO();
  const exams = rows.map((r) => ({
    ...r,
    weekday: PyDate.fromisoformat(r.exam_date).strftime("%a"),
    done: r.exam_date < today,
  }));
  const order = (e) => (TYPE_ORDER.includes(e.exam_type) ? TYPE_ORDER.indexOf(e.exam_type) : 99);
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  exams.sort((a, b) => order(a) - order(b) || cmp(a.exam_date, b.exam_date) || cmp(a.start_time, b.start_time));
  return exams;
}

export function registration(student_id, term = CURRENT_TERM) {
  return db.connect().execute("SELECT * FROM exam_registrations WHERE student_id = ? AND term = ?",
    [student_id, term]).fetchone();
}

export function registration_open() {
  return todayISO() <= REGISTRATION_DEADLINE;
}

/** Returns true if newly registered, false if already registered. */
export function register(student_id, term = CURRENT_TERM) {
  const cur = db.connect().execute(
    "INSERT OR IGNORE INTO exam_registrations (student_id, term, registered_at) VALUES (?, ?, ?)",
    [student_id, term, _now()]);
  return cur.rowcount === 1;
}

/** Failed past courses, with whether a back paper is already registered. */
export function back_paper_options(student_id, term = CURRENT_TERM) {
  const failed = semester_results(student_id).flatMap((sem) => sem.courses).filter((c) => c.grade === "F");
  const taken = new Set(db.connect().execute(
    "SELECT result_id FROM exam_back_papers WHERE student_id = ? AND term = ?",
    [student_id, term]).fetchall().map((r) => r.result_id));
  for (const c of failed) c.back_registered = taken.has(c.result_id);
  return failed;
}

/** Register back papers for the given failed results. Ignores ids that are
 * not this student's failed courses. Returns the number newly registered. */
export function register_back_papers(student_id, result_ids, term = CURRENT_TERM) {
  const allowed = new Set(back_paper_options(student_id, term).map((c) => c.result_id));
  let count = 0;
  const conn = db.connect();
  for (const rid of result_ids) {
    if (allowed.has(rid)) {
      const cur = conn.execute(
        "INSERT OR IGNORE INTO exam_back_papers (student_id, result_id, term, registered_at)" +
        " VALUES (?, ?, ?, ?)", [student_id, rid, term, _now()]);
      count += cur.rowcount;
    }
  }
  return count;
}

// ---- Results --------------------------------------------------------------

/** List of semesters (ascending), each an object with courses, SGPA and totals. */
export function semester_results(student_id) {
  const rows = db.connect().execute(
    "SELECT r.id AS result_id, r.internal, r.internal_max, r.external, r.external_max," +
    " c.semester, c.code, c.name, c.credits, c.kind" +
    " FROM exam_results r JOIN exam_courses c ON c.id = r.course_id" +
    " WHERE r.student_id = ? ORDER BY c.semester, c.kind DESC, c.code",
    [student_id]).fetchall();
  const semesters = new Map();
  for (const r of rows) {
    const c = { ...r };
    c.total = r.internal + r.external;
    c.max_total = r.internal_max + r.external_max;
    c.percent = c.max_total ? c.total * 100 / c.max_total : 0;
    [c.grade, c.grade_points] = grade_for(c.percent);
    c.credit_points = c.credits * c.grade_points;
    if (!semesters.has(r.semester)) semesters.set(r.semester, []);
    semesters.get(r.semester).push(c);
  }

  const sum = (list, f) => list.reduce((a, c) => a + f(c), 0);
  const result = [];
  for (const number of [...semesters.keys()].sort((a, b) => a - b)) {
    const courses = semesters.get(number);
    const backs = courses.filter((c) => c.grade === "F").length;
    result.push({
      semester: number,
      year: Math.floor((number + 1) / 2),
      courses,
      credits: sum(courses, (c) => c.credits),
      earned_credits: sum(courses.filter((c) => c.grade !== "F"), (c) => c.credits),
      credit_points: sum(courses, (c) => c.credit_points),
      marks: sum(courses, (c) => c.total),
      max_marks: sum(courses, (c) => c.max_total),
      sgpa: gpa(courses),
      backs,
      status: !backs ? "Pass" : `Fail (${backs} back${backs > 1 ? "s" : ""})`,
      declared: RESULT_DECLARED[number] ?? "",
    });
  }
  // CGPA after each semester: credit-weighted over all courses so far.
  const so_far = [];
  for (const sem of result) {
    so_far.push(...sem.courses);
    sem.cgpa = gpa(so_far);
  }
  return result;
}

/** Credit-weighted over every course of every semester (not a mean of SGPAs). */
export function cgpa(semesters) {
  return gpa(semesters.flatMap((s) => s.courses));
}

function _now() {
  return nowISO();
}
