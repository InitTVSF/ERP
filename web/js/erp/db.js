/* Shared SQLite data layer used by both the student portal (portal.js)
 * and the admin console (admin.js). Port of erp/db.py.
 *
 * SQLite runs in the browser (sql.js). The database file is kept in
 * IndexedDB, so each visitor has their own private copy: a student created
 * in the admin console can log in to the portal in the same browser.
 */
import { PyRandom, PyDate, nowISO } from "../lib/py.js";
import * as store from "../lib/store.js";

// Display settings, kept in one place so branding is easy to change.
export const PORTAL_NAME = "Campus ERP";
export const INSTITUTION_NAME = "Graphic Era Hill University";
export const SESSION_LABEL = "2026-27";
// Students have no semester column yet; every module treats them as being in this one.
export const CURRENT_SEMESTER = 3;

// Seeded admin account. Every visitor gets their own copy, so it is shown on the login page.
export const ADMIN_USER = "admin";
export const ADMIN_PASSWORD = "admin123";

// Editable student fields, in display order: [column, label].
export const STUDENT_FIELDS = [
  ["name", "Full Name"],
  ["roll_no", "Roll Number"],
  ["enrollment_no", "Enrollment Number"],
  ["parent_name", "Parent's Name"],
  ["profile_no", "Profile Number"],
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS students (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    roll_no       TEXT NOT NULL UNIQUE,
    enrollment_no TEXT NOT NULL UNIQUE COLLATE NOCASE,
    parent_name   TEXT NOT NULL DEFAULT '',
    profile_no    TEXT NOT NULL DEFAULT '',
    photo         TEXT NOT NULL DEFAULT '',  -- name of a row in photo_files
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

-- Uploaded student photos (the Flask version keeps these as files on disk).
CREATE TABLE IF NOT EXISTS photo_files (
    name  TEXT PRIMARY KEY,
    mime  TEXT NOT NULL,
    data  BLOB NOT NULL
);
`;

const MOCK_STUDENTS = [
  // name, roll_no, enrollment_no, parent_name, profile_no
  ["Aarav Sharma", "2519001", "PV-25190001", "Rajesh Sharma", "PRF-1001"],
  ["Diya Negi", "2519002", "PV-25190002", "Sunita Negi", "PRF-1002"],
  ["Kabir Rawat", "2519003", "PV-25190003", "Mohan Rawat", "PRF-1003"],
];
export const MOCK_STUDENT_PASSWORD = "student123";

const MOCK_NOTICES = [
  ["2026-10-13", "Fee submission for the even semesters 2026-27"],
  ["2026-09-18", "Term evaluation theory regular/back examination, September 2026"],
  ["2026-02-18", "Compliance with traffic rules and road safety guidelines"],
];

const MOCK_SUBJECTS = [
  // code, name
  ["TMA101", "Engineering Mathematics"],
  ["TPH102", "Engineering Physics"],
  ["TEC103", "Basic Electronics"],
  ["TCS104", "Programming in C"],
  ["TCS105", "Introduction to AI & ML"],
  ["PPH151", "Physics Lab"],
  ["PEC152", "Electronics Lab"],
  ["PWS153", "Workshop Practice"],
];

// Each domain module (fees, academic, ...) owns its own tables. It exports
// SCHEMA (SQL, may be empty) and seed(conn) (called on every start; must be
// idempotent). Add new modules here.
const DOMAIN_MODULES = ["./fees.js", "./academic.js", "./exams.js", "./campus.js"];

const MOCK_HOLIDAYS = [
  ["2026-01-26", "Republic Day"],
  ["2026-03-04", "Holi"],
  ["2026-08-15", "Independence Day"],
  ["2026-10-02", "Gandhi Jayanti"],
  ["2026-10-20", "Diwali Break"],
  ["2026-12-25", "Christmas Day"],
];

// ---- Connection (sql.js) ------------------------------------------------------

const STORE_KEY = "erp.db";
const VERSION_KEY = "erp.db.version";  // bumped on every save, so other tabs reload
let SQL = null;
let database = null;
let loadedVersion = null;
let dirty = false;

/** Python sqlite3.IntegrityError equivalent. */
export class IntegrityError extends Error {}

function bindValue(v) {
  if (v === undefined) return null;
  if (v === true) return 1;
  if (v === false) return 0;
  return v;
}

function bindParams(params) {
  if (params == null) return undefined;
  if (Array.isArray(params)) return params.map(bindValue);
  const named = {};
  for (const [k, v] of Object.entries(params)) named[/^[:$@]/.test(k) ? k : ":" + k] = bindValue(v);
  return named;
}

class Cursor {
  constructor(rows, lastrowid, rowcount) {
    this.rows = rows;
    this.lastrowid = lastrowid;
    this.rowcount = rowcount;
  }
  fetchone() { return this.rows[0] ?? null; }
  fetchall() { return this.rows; }
  [Symbol.iterator]() { return this.rows[Symbol.iterator](); }
}

const READ_ONLY = /^\s*(SELECT|WITH|PRAGMA\s+table_info)/i;

/** Same surface as a Python sqlite3 connection: execute / executemany / executescript. */
const conn = {
  execute(sql, params) {
    let stmt;
    try {
      stmt = database.prepare(sql);
      const bound = bindParams(params);
      if (bound !== undefined) stmt.bind(bound);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      const write = !READ_ONLY.test(sql);
      if (write) dirty = true;
      const rowcount = write ? database.getRowsModified() : -1;
      const lastrowid = write ? database.exec("SELECT last_insert_rowid()")[0].values[0][0] : null;
      return new Cursor(rows, lastrowid, rowcount);
    } catch (e) {
      if (/constraint failed/i.test(e.message)) throw new IntegrityError(e.message);
      throw e;
    } finally {
      if (stmt) stmt.free();
    }
  },
  executemany(sql, rows) {
    return transaction(() => {
      let count = 0;
      for (const r of rows) count += this.execute(sql, r).rowcount;
      return new Cursor([], null, count);
    });
  },
  executescript(sql) {
    database.exec(sql);
    dirty = true;
  },
};

/** Run fn atomically (nestable). */
export function transaction(fn) {
  const name = "sp" + Math.random().toString(36).slice(2, 8);
  database.exec(`SAVEPOINT ${name}`);
  try {
    const result = fn();
    database.exec(`RELEASE ${name}`);
    return result;
  } catch (e) {
    database.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);
    throw e;
  }
}

export function connect() {
  return conn;
}

function currentVersion() {
  try { return localStorage.getItem(VERSION_KEY); } catch { return null; }
}

/** Load the engine and this browser's database (creating and seeding it if new). */
export async function open(sqlJsOptions = {}) {
  SQL ??= await globalThis.initSqlJs(sqlJsOptions);
  const bytes = await store.load(STORE_KEY);
  database = bytes ? new SQL.Database(bytes) : new SQL.Database();
  database.exec("PRAGMA foreign_keys = ON");
  loadedVersion = currentVersion();
  await init_db();
  await persist();
}

/** Reload if another tab saved a newer copy since we loaded ours. */
export async function syncIfStale() {
  if (currentVersion() !== loadedVersion) {
    const bytes = await store.load(STORE_KEY);
    if (bytes) {
      database.close();
      database = new SQL.Database(bytes);
      database.exec("PRAGMA foreign_keys = ON");
    }
    loadedVersion = currentVersion();
  }
}

/** Save to IndexedDB if anything changed. */
export async function persist() {
  if (!dirty) return;
  dirty = false;
  await store.save(STORE_KEY, database.export());
  // export() resets connection pragmas in sql.js
  database.exec("PRAGMA foreign_keys = ON");
  const v = String(Date.now()) + Math.random().toString(36).slice(2, 6);
  try { localStorage.setItem(VERSION_KEY, v); } catch { /* ignore */ }
  loadedVersion = v;
}

/** Wipe this browser's database and start again from the sample data. */
export async function reset() {
  database.close();
  database = new SQL.Database();
  database.exec("PRAGMA foreign_keys = ON");
  await init_db();
  dirty = true;
  await persist();
}

/** Replace the whole database (used by backup import). fn runs on the fresh, seeded-schema db. */
export async function replaceWith(fn) {
  const old = database;
  database = new SQL.Database();
  database.exec("PRAGMA foreign_keys = ON");
  try {
    await init_db({ seed: false });
    database.exec("PRAGMA foreign_keys = OFF");
    transaction(fn);
    database.exec("PRAGMA foreign_keys = ON");
  } catch (e) {
    database.close();
    database = old;
    throw e;
  }
  old.close();
  await ensure_admin();  // a backup without admins would lock everyone out
  dirty = true;
  await persist();
}

/** Every user table with its rows, for backups. */
export function dumpTables() {
  const tables = conn.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall();
  const out = {};
  for (const { name } of tables) {
    const res = database.exec(`SELECT * FROM "${name}"`);
    const columns = conn.execute(`PRAGMA table_info("${name}")`).fetchall().map((c) => c.name);
    out[name] = { columns, rows: res.length ? res[0].values : [] };
  }
  return out;
}

export function tableColumns(name) {
  return conn.execute(`PRAGMA table_info("${name}")`).fetchall().map((c) => c.name);
}

// ---- Passwords (werkzeug-style "method$salt$hash", via Web Crypto) ------------

const PBKDF2_ITERATIONS = 100000;

async function pbkdf2(password, salt, iterations) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function generate_password_hash(password) {
  const salt = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `pbkdf2:sha256:${PBKDF2_ITERATIONS}$${salt}$${await pbkdf2(password, salt, PBKDF2_ITERATIONS)}`;
}

export async function check_password_hash(stored, password) {
  const m = /^pbkdf2:sha256:(\d+)\$([^$]+)\$([0-9a-f]+)$/.exec(stored || "");
  if (!m) return false;
  const hash = await pbkdf2(password, m[2], Number(m[1]));
  // Constant-time compare (habit from the server version; no attacker here).
  let diff = hash.length ^ m[3].length;
  for (let i = 0; i < Math.min(hash.length, m[3].length); i++) diff |= hash.charCodeAt(i) ^ m[3].charCodeAt(i);
  return diff === 0;
}

// ---- Setup ------------------------------------------------------------------------

/** Create tables and seed mock data on first run. Safe to call repeatedly. */
export async function init_db({ seed = true } = {}) {
  conn.executescript(SCHEMA);
  _migrate(conn);
  if (seed) {
    if (conn.execute("SELECT COUNT(*) AS n FROM students").fetchone().n === 0) {
      const pw = await generate_password_hash(MOCK_STUDENT_PASSWORD);
      const now = _now();
      conn.executemany(
        "INSERT INTO students (name, roll_no, enrollment_no, parent_name, profile_no," +
        " password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        MOCK_STUDENTS.map((s) => [...s, pw, now]));
    }
    if (conn.execute("SELECT COUNT(*) AS n FROM notices").fetchone().n === 0) {
      conn.executemany("INSERT INTO notices (date, title) VALUES (?, ?)", MOCK_NOTICES);
    }
    if (conn.execute("SELECT COUNT(*) AS n FROM holidays").fetchone().n === 0) {
      conn.executemany("INSERT INTO holidays (date, title) VALUES (?, ?)", MOCK_HOLIDAYS);
    }
    if (conn.execute("SELECT COUNT(*) AS n FROM subjects").fetchone().n === 0) {
      conn.executemany("INSERT INTO subjects (code, name) VALUES (?, ?)", MOCK_SUBJECTS);
      _seed_attendance(conn);
    }
    await ensure_admin();
  }

  for (const path of DOMAIN_MODULES) {
    const module = await import(path);
    if (module.SCHEMA) conn.executescript(module.SCHEMA);
    if (seed) await module.seed(conn);
  }
}

/** Make sure someone can sign in to the admin console. */
export async function ensure_admin() {
  if (conn.execute("SELECT COUNT(*) AS n FROM admins").fetchone().n === 0) {
    conn.execute("INSERT INTO admins (username, password_hash) VALUES (?, ?)",
      [ADMIN_USER, await generate_password_hash(ADMIN_PASSWORD)]);
  }
}

function _migrate(conn) {
  // Bring databases created by older versions up to the current SCHEMA.
  const columns = new Set(conn.execute("PRAGMA table_info(students)").fetchall().map((r) => r.name));
  if (!columns.has("photo")) conn.execute("ALTER TABLE students ADD COLUMN photo TEXT NOT NULL DEFAULT ''");
}

function _seed_attendance(conn) {
  // Mock attendance: every student, every subject, weekdays of the last six weeks.
  const rng = new PyRandom(42);  // deterministic, so every fresh database looks the same
  const students = conn.execute("SELECT id FROM students").fetchall().map((r) => r.id);
  const subjects = conn.execute("SELECT id FROM subjects").fetchall().map((r) => r.id);
  const start = PyDate.today().addDays(-42);
  const days = Array.from({ length: 42 }, (_, i) => start.addDays(i));
  const rows = [];
  for (const sid of students) {
    const rate = rng.uniform(0.62, 0.95);  // some students fall below the 75% line
    for (const subj of subjects) {
      for (const d of days) {
        if (d.weekday() < 5 && rng.random() < 0.6) {  // not every subject every day
          rows.push([sid, subj, d.isoformat(), rng.random() < rate ? 1 : 0]);
        }
      }
    }
  }
  conn.executemany(
    "INSERT INTO attendance (student_id, subject_id, date, present) VALUES (?, ?, ?, ?)", rows);
}

function _now() {
  return nowISO();
}

// ---- Students -------------------------------------------------------------

export function list_students(search = "") {
  if (search) {
    const like = `%${search}%`;
    return conn.execute(
      "SELECT * FROM students WHERE name LIKE ? OR roll_no LIKE ? OR enrollment_no LIKE ?" +
      " ORDER BY name", [like, like, like]).fetchall();
  }
  return conn.execute("SELECT * FROM students ORDER BY name").fetchall();
}

export function get_student(student_id) {
  return conn.execute("SELECT * FROM students WHERE id = ?", [student_id]).fetchone();
}

/** data: object with the STUDENT_FIELDS keys. Throws ValueError-like Error on duplicates. */
export async function create_student(data, password) {
  const hash = await generate_password_hash(password);
  try {
    return conn.execute(
      "INSERT INTO students (name, roll_no, enrollment_no, parent_name, profile_no," +
      " password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [data.name, data.roll_no, data.enrollment_no, data.parent_name, data.profile_no, hash, _now()],
    ).lastrowid;
  } catch (e) {
    if (e instanceof IntegrityError) throw new ValueError(_duplicate_message(e));
    throw e;
  }
}

/** Update details; the password is changed only when one is given. */
export async function update_student(student_id, data, password = null) {
  const hash = password ? await generate_password_hash(password) : null;
  try {
    transaction(() => {
      conn.execute(
        "UPDATE students SET name = ?, roll_no = ?, enrollment_no = ?, parent_name = ?," +
        " profile_no = ?, status = ? WHERE id = ?",
        [data.name, data.roll_no, data.enrollment_no, data.parent_name, data.profile_no,
          data.status ?? "Active", student_id]);
      if (hash) conn.execute("UPDATE students SET password_hash = ? WHERE id = ?", [hash, student_id]);
    });
  } catch (e) {
    if (e instanceof IntegrityError) throw new ValueError(_duplicate_message(e));
    throw e;
  }
}

/** Store the photo name ('' clears it). Bytes are handled by erp/photos.js. */
export function set_student_photo(student_id, name) {
  conn.execute("UPDATE students SET photo = ? WHERE id = ?", [name, student_id]);
}

export function delete_student(student_id) {
  conn.execute("DELETE FROM students WHERE id = ?", [student_id]);
}

/** Log in with enrollment number or roll number. Returns the row or null. */
export async function authenticate_student(user_id, password) {
  user_id = (user_id || "").trim();
  const row = conn.execute(
    "SELECT * FROM students WHERE enrollment_no = ? OR roll_no = ?", [user_id, user_id]).fetchone();
  if (row && row.status === "Active" && await check_password_hash(row.password_hash, password || "")) {
    return row;
  }
  return null;
}

function _duplicate_message(err) {
  const msg = String(err.message);
  if (msg.includes("roll_no")) return "A student with this roll number already exists.";
  if (msg.includes("enrollment_no")) return "A student with this enrollment number already exists.";
  return "This student conflicts with an existing record.";
}

/** Python's ValueError: a user-facing validation message. */
export class ValueError extends Error {}

// ---- Admins ---------------------------------------------------------------

export async function authenticate_admin(username, password) {
  const row = conn.execute("SELECT * FROM admins WHERE username = ?", [(username || "").trim()]).fetchone();
  if (row && await check_password_hash(row.password_hash, password || "")) return row;
  return null;
}

// ---- Portal content -------------------------------------------------------

export function list_notices(limit = 10) {
  return conn.execute("SELECT * FROM notices ORDER BY date DESC LIMIT ?", [limit]).fetchall();
}

export function list_holidays() {
  return conn.execute("SELECT * FROM holidays ORDER BY date").fetchall();
}

/** Per-subject attendance. */
export function attendance_summary(student_id) {
  return conn.execute(
    "SELECT s.code, s.name, COUNT(a.id) AS total, COALESCE(SUM(a.present), 0) AS present" +
    " FROM attendance a JOIN subjects s ON s.id = a.subject_id" +
    " WHERE a.student_id = ? GROUP BY s.id ORDER BY s.name", [student_id]).fetchall();
}

// ---- Subjects (admin) -----------------------------------------------------

/** Subjects with the number of attendance records each one holds. */
export function list_subjects(search = "") {
  const sql = "SELECT s.*, (SELECT COUNT(*) FROM attendance a WHERE a.subject_id = s.id) AS records" +
    " FROM subjects s";
  if (search) {
    const like = `%${search}%`;
    return conn.execute(sql + " WHERE s.code LIKE ? OR s.name LIKE ? ORDER BY s.code", [like, like]).fetchall();
  }
  return conn.execute(sql + " ORDER BY s.code").fetchall();
}

export function get_subject(subject_id) {
  return conn.execute("SELECT * FROM subjects WHERE id = ?", [subject_id]).fetchone();
}

/** Throws ValueError if the code is already taken. */
export function create_subject(code, name) {
  try {
    return conn.execute("INSERT INTO subjects (code, name) VALUES (?, ?)", [code, name]).lastrowid;
  } catch (e) {
    if (e instanceof IntegrityError) throw new ValueError("A subject with this code already exists.");
    throw e;
  }
}

export function update_subject(subject_id, code, name) {
  try {
    conn.execute("UPDATE subjects SET code = ?, name = ? WHERE id = ?", [code, name, subject_id]);
  } catch (e) {
    if (e instanceof IntegrityError) throw new ValueError("A subject with this code already exists.");
    throw e;
  }
}

/** Also removes the subject's attendance records (ON DELETE CASCADE). */
export function delete_subject(subject_id) {
  conn.execute("DELETE FROM subjects WHERE id = ?", [subject_id]);
}

// ---- Attendance (admin) ---------------------------------------------------

/** {student_id: present (bool)} already saved for one subject on one date. */
export function attendance_for(subject_id, day) {
  const rows = conn.execute("SELECT student_id, present FROM attendance" +
    " WHERE subject_id = ? AND date = ?", [subject_id, day]).fetchall();
  return Object.fromEntries(rows.map((r) => [r.student_id, !!r.present]));
}

/** marks: Map or object {student_id: present}. Re-saving a subject+date overwrites it. */
export function save_attendance(subject_id, day, marks) {
  const entries = marks instanceof Map ? [...marks] : Object.entries(marks);
  conn.executemany(
    "INSERT INTO attendance (student_id, subject_id, date, present) VALUES (?, ?, ?, ?)" +
    " ON CONFLICT (student_id, subject_id, date) DO UPDATE SET present = excluded.present",
    entries.map(([sid, p]) => [Number(sid), subject_id, day, p ? 1 : 0]));
  return entries.length;
}

/** Most recently marked dates for a subject, with head counts. */
export function recent_attendance_dates(subject_id, limit = 8) {
  return conn.execute(
    "SELECT date, COUNT(*) AS total, SUM(present) AS present FROM attendance" +
    " WHERE subject_id = ? GROUP BY date ORDER BY date DESC LIMIT ?", [subject_id, limit]).fetchall();
}

/** Attendance totals grouped by student (optionally for one subject) or by
 * subject (optionally for one student). Rows with no records are included
 * with total 0 so nobody silently drops off the report. */
export function attendance_report(group_by = "student", subject_id = null, student_id = null) {
  let sql, params;
  if (group_by === "subject") {
    sql = "SELECT s.id, s.code, s.name, COUNT(a.id) AS total," +
      " COALESCE(SUM(a.present), 0) AS present" +
      " FROM subjects s LEFT JOIN attendance a ON a.subject_id = s.id" +
      (student_id ? " AND a.student_id = ?" : "") +
      " GROUP BY s.id ORDER BY s.code";
    params = student_id ? [student_id] : [];
  } else {
    sql = "SELECT st.id, st.name, st.roll_no, st.status, COUNT(a.id) AS total," +
      " COALESCE(SUM(a.present), 0) AS present" +
      " FROM students st LEFT JOIN attendance a ON a.student_id = st.id" +
      (subject_id ? " AND a.subject_id = ?" : "") +
      " GROUP BY st.id ORDER BY st.name";
    params = subject_id ? [subject_id] : [];
  }
  return conn.execute(sql, params).fetchall();
}

// ---- Notices & holidays (admin) -------------------------------------------

export function create_notice(day, title) {
  return conn.execute("INSERT INTO notices (date, title) VALUES (?, ?)", [day, title]).lastrowid;
}

/** Returns true if a row was removed. */
export function delete_notice(notice_id) {
  return conn.execute("DELETE FROM notices WHERE id = ?", [notice_id]).rowcount > 0;
}

export function create_holiday(day, title) {
  return conn.execute("INSERT INTO holidays (date, title) VALUES (?, ?)", [day, title]).lastrowid;
}

export function delete_holiday(holiday_id) {
  return conn.execute("DELETE FROM holidays WHERE id = ?", [holiday_id]).rowcount > 0;
}
