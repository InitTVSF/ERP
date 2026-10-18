/* Admin console. Port of admin_app.py, mounted at /admin.
 *
 * Manages the students who sign in to the portal, plus subjects,
 * attendance, notices and holidays. Writes go to the same in-browser
 * database the portal reads.
 */
import { App, abort, flash, redirect, render_template, request, session, url_for, sendDownload } from "./lib/flask.js";
import { PyDate, collapseSpaces, pyRound, toInt, todayISO } from "./lib/py.js";
import * as db from "./erp/db.js";
import * as photos from "./erp/photos.js";
import * as backup from "./erp/backup.js";

export const app = new App("admin", { prefix: "/admin", sessionKey: "erp.admin_session" });

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_SECONDS = 60;
const PASSWORD_MIN_LENGTH = 6;
const STATUSES = ["Active", "Inactive"];
const REQUIRED_FIELDS = ["name", "roll_no", "enrollment_no"];

app.context_processor(() => ({
  portal_name: db.PORTAL_NAME,
  institution_name: db.INSTITUTION_NAME,
  admin_user: session.get("admin_user"),
  demo_admin: [db.ADMIN_USER, db.ADMIN_PASSWORD],
}));

// ---- Auth -----------------------------------------------------------------

function login_required(view) {
  const wrapper = (params) => {
    if (!session.get("admin_id")) return redirect(url_for("login", { next: request.full_path }));
    return view(params);
  };
  Object.defineProperty(wrapper, "name", { value: view.name });
  return wrapper;
}

function _seconds_locked() {
  const until = session.get("login_locked_until", 0);
  const remaining = Math.trunc(until - Date.now() / 1000);
  return remaining > 0 ? remaining : 0;
}

app.route("/login", { methods: ["GET", "POST"] }, async function login() {
  if (session.get("admin_id")) return redirect(url_for("dashboard"));

  let error = null;
  let username = "";
  if (request.method === "POST") {
    username = request.form.get("username", "").trim();
    const password = request.form.get("password", "");
    const locked = _seconds_locked();
    if (locked) {
      error = `Too many failed attempts. Try again in ${locked} seconds.`;
    } else {
      const admin = await db.authenticate_admin(username, password);
      if (admin) {
        session.clear();  // drop any pre-login state
        session.set("admin_id", admin.id);
        session.set("admin_user", admin.username);
        flash(`Welcome back, ${admin.username}.`, "success");
        let nxt = request.args.get("next", "");
        // Only allow local paths as redirect targets.
        if (!nxt.startsWith("/") || nxt.startsWith("//")) return redirect(url_for("dashboard"));
        return redirect("/admin" + nxt);
      }
      let failures = session.get("login_failures", 0) + 1;
      if (failures >= MAX_FAILED_LOGINS) {
        session.set("login_locked_until", Date.now() / 1000 + LOCKOUT_SECONDS);
        failures = 0;
        error = `Too many failed attempts. Try again in ${LOCKOUT_SECONDS} seconds.`;
      } else {
        error = "Invalid username or password.";
      }
      session.set("login_failures", failures);
    }
  }
  return render_template("admin/login.html", { error, username });
});

app.route("/logout", { methods: ["POST"] }, function logout() {
  session.clear();
  flash("You have been signed out.", "info");
  return redirect(url_for("login"));
});

// ---- Students -------------------------------------------------------------

app.route("/", login_required(function dashboard() {
  const q = request.args.get("q", "").trim();
  const students = db.list_students(q);
  const all_students = q ? db.list_students() : students;
  const active = all_students.filter((s) => s.status === "Active").length;
  const stats = { total: all_students.length, active, inactive: all_students.length - active,
    subjects: db.list_subjects().length };
  return render_template("admin/dashboard.html", { students, q, stats, active_nav: "students" });
}));

function _read_form(require_password) {
  const data = Object.fromEntries(db.STUDENT_FIELDS.map(([key]) => [key, request.form.get(key, "").trim()]));
  const status = request.form.get("status", "Active");
  data.status = STATUSES.includes(status) ? status : "Active";
  const password = request.form.get("password", "");

  const errors = {};
  const labels = Object.fromEntries(db.STUDENT_FIELDS);
  for (const key of REQUIRED_FIELDS) {
    if (!data[key]) errors[key] = `${labels[key]} is required.`;
  }
  if (require_password && !password) {
    errors.password = "Password is required.";
  } else if (password && password.length < PASSWORD_MIN_LENGTH) {
    errors.password = `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  return [data, password, errors];
}

/** Save an uploaded photo (if one was chosen) before the student row is
 * written, so a bad image is reported with the other field errors.
 * Returns the new name or null. */
async function _read_photo(errors) {
  const upload = request.files.get("photo");
  if (!upload || !upload.name) return null;
  try {
    return await photos.save(upload);
  } catch (e) {
    if (!(e instanceof db.ValueError)) throw e;
    errors.photo = e.message;
    return null;
  }
}

const studentFormContext = () => ({
  fields: db.STUDENT_FIELDS, statuses: STATUSES, required: REQUIRED_FIELDS,
  min_pw: PASSWORD_MIN_LENGTH, active_nav: "students",
});

app.route("/students/new", { methods: ["GET", "POST"] }, login_required(async function student_new() {
  let data = Object.fromEntries(db.STUDENT_FIELDS.map(([key]) => [key, ""]));
  data.status = "Active";
  let errors = {}, form_error = null;
  if (request.method === "POST") {
    let password;
    [data, password, errors] = _read_form(true);
    const photo = await _read_photo(errors);
    if (Object.keys(errors).length) {
      photos.remove_file(photo);
    } else {
      try {
        const student_id = await db.create_student(data, password);
        if (photo) db.set_student_photo(student_id, photo);
        flash(`Student “${data.name}” was added.`, "success");
        return redirect(url_for("dashboard"));
      } catch (e) {
        if (!(e instanceof db.ValueError)) throw e;
        photos.remove_file(photo);
        form_error = e.message;
      }
    }
  }
  return render_template("admin/student_form.html", { mode: "create", data, errors, form_error, ...studentFormContext() });
}));

app.route("/students/<int:student_id>/edit", { methods: ["GET", "POST"] }, login_required(async function student_edit({ student_id }) {
  const student = db.get_student(student_id);
  if (student === null) abort(404);
  let data = { ...student };
  let errors = {}, form_error = null;
  if (request.method === "POST") {
    let password;
    [data, password, errors] = _read_form(false);
    data.photo = student.photo;  // keep showing the current photo on re-render
    const photo = await _read_photo(errors);
    if (Object.keys(errors).length) {
      photos.remove_file(photo);
    } else {
      try {
        await db.update_student(student_id, data, password || null);
        if (photo) {
          db.set_student_photo(student_id, photo);
          photos.remove_file(student.photo);
        } else if (request.form.get("remove_photo")) {
          photos.remove(student_id);
        }
        flash(`Student “${data.name}” was updated.`, "success");
        return redirect(url_for("dashboard"));
      } catch (e) {
        if (!(e instanceof db.ValueError)) throw e;
        photos.remove_file(photo);
        form_error = e.message;
      }
    }
  }
  return render_template("admin/student_form.html", { mode: "edit", student, data, errors, form_error, ...studentFormContext() });
}));

// Photos are shown from in-browser data instead of a /students/<id>/photo route.
app.asset("student_photo", ({ student_id }) => {
  const student = db.get_student(student_id);
  return student ? photos.url(student.photo) : "";
});

app.route("/students/<int:student_id>/delete", { methods: ["POST"] }, login_required(function student_delete({ student_id }) {
  const student = db.get_student(student_id);
  if (student === null) abort(404);
  db.delete_student(student_id);
  photos.remove_file(student.photo);
  flash(`Student “${student.name}” was deleted.`, "success");
  return redirect(url_for("dashboard"));
}));

// ---- Subjects -------------------------------------------------------------

const SUBJECT_CODE_RE = /^[A-Z0-9]{2,12}$/;
const SUBJECT_NAME_MAX = 120;

function _read_subject_form() {
  // Codes are stored upper-case so "tcs104" and "TCS104" can't both exist.
  const data = { code: request.form.get("code", "").trim().toUpperCase(),
    name: collapseSpaces(request.form.get("name", "")) };
  const errors = {};
  if (!data.code) errors.code = "Subject code is required.";
  else if (!SUBJECT_CODE_RE.test(data.code)) errors.code = "Use 2–12 letters and digits only, e.g. TCS104.";
  if (!data.name) errors.name = "Subject name is required.";
  else if (data.name.length > SUBJECT_NAME_MAX) errors.name = `Keep the name under ${SUBJECT_NAME_MAX} characters.`;
  return [data, errors];
}

app.route("/subjects", login_required(function subjects() {
  const q = request.args.get("q", "").trim();
  return render_template("admin/subjects.html", { subjects: db.list_subjects(q), q, active_nav: "subjects" });
}));

app.route("/subjects/new", { methods: ["GET", "POST"] }, login_required(function subject_new() {
  let data = { code: "", name: "" }, errors = {};
  if (request.method === "POST") {
    [data, errors] = _read_subject_form();
    if (!Object.keys(errors).length) {
      try {
        db.create_subject(data.code, data.name);
        flash(`Subject ${data.code} “${data.name}” was added.`, "success");
        return redirect(url_for("subjects"));
      } catch (e) {
        if (!(e instanceof db.ValueError)) throw e;
        errors.code = e.message;
      }
    }
  }
  return render_template("admin/subject_form.html", { mode: "create", data, errors, active_nav: "subjects" });
}));

app.route("/subjects/<int:subject_id>/edit", { methods: ["GET", "POST"] }, login_required(function subject_edit({ subject_id }) {
  const subject = db.get_subject(subject_id);
  if (subject === null) abort(404);
  let data = { ...subject }, errors = {};
  if (request.method === "POST") {
    [data, errors] = _read_subject_form();
    if (!Object.keys(errors).length) {
      try {
        db.update_subject(subject_id, data.code, data.name);
        flash(`Subject ${data.code} was updated.`, "success");
        return redirect(url_for("subjects"));
      } catch (e) {
        if (!(e instanceof db.ValueError)) throw e;
        errors.code = e.message;
      }
    }
  }
  return render_template("admin/subject_form.html", { mode: "edit", subject, data, errors, active_nav: "subjects" });
}));

app.route("/subjects/<int:subject_id>/delete", { methods: ["POST"] }, login_required(function subject_delete({ subject_id }) {
  const subject = db.get_subject(subject_id);
  if (subject === null) abort(404);
  db.delete_subject(subject_id);
  flash(`Subject ${subject.code} and its attendance records were deleted.`, "success");
  return redirect(url_for("subjects"));
}));

// ---- Attendance -----------------------------------------------------------

const MIN_ATTENDANCE = 75;  // same threshold the student portal uses

/** 'YYYY-MM-DD' -> [iso string or null, error message or null]. */
function _parse_day(value, allow_future = true) {
  let day;
  try {
    day = PyDate.fromisoformat((value || "").trim());
  } catch {
    return [null, "Enter a valid date (YYYY-MM-DD)."];
  }
  if (!allow_future && day.isoformat() > todayISO()) {
    return [null, "Attendance can't be marked for a future date."];
  }
  return [day.isoformat(), null];
}

app.route("/attendance", { methods: ["GET", "POST"] }, login_required(function attendance() {
  // GET picks the subject/date and shows the roster; POST saves it.
  const source = request.method === "POST" ? request.form : request.args;
  const errors = {};

  const subject_id = toInt(source.get("subject_id"));
  const subject = subject_id ? db.get_subject(subject_id) : null;
  if (subject_id && subject === null) errors.subject_id = "That subject no longer exists.";
  else if (request.method === "POST" && subject === null) errors.subject_id = "Choose a subject.";

  const raw_day = source.get("date") || todayISO();
  const [day, day_error] = _parse_day(raw_day, false);
  if (day_error) errors.date = day_error;

  const roster = db.list_students().filter((s) => s.status === "Active");

  if (request.method === "POST" && !Object.keys(errors).length) {
    // Only write students that were on the submitted roster, so a student
    // activated in the meantime isn't silently marked absent.
    const active_ids = new Set(roster.map((s) => s.id));
    const shown = new Set(request.form.getlist("roster").map(toInt).filter((i) => active_ids.has(i)));
    const present = new Set(request.form.getlist("present").map(toInt));
    if (!shown.size) {
      errors.roster = "There are no active students to mark.";
    } else {
      const marks = new Map([...shown].map((sid) => [sid, present.has(sid)]));
      const was_marked = Object.keys(db.attendance_for(subject.id, day)).length > 0;
      db.save_attendance(subject.id, day, marks);
      const n_present = [...marks.values()].filter(Boolean).length;
      flash(`Attendance ${was_marked ? "updated" : "saved"} for ${subject.code} ` +
        `on ${day}: ${n_present} present, ${marks.size - n_present} absent.`, "success");
      return redirect(url_for("attendance", { subject_id: subject.id, date: day }));
    }
  }

  const existing = subject && day ? db.attendance_for(subject.id, day) : {};
  const recent = subject ? db.recent_attendance_dates(subject.id) : [];
  const status = request.method === "POST" ? 400 : 200;
  return [render_template("admin/attendance.html", { subjects: db.list_subjects(), subject,
    day: day || raw_day, today: todayISO(), roster, existing, recent, errors,
    active_nav: "attendance" }), status];
}));

app.route("/attendance/report", login_required(function attendance_report() {
  // by=student: one row per student (optionally for one subject);
  // by=subject: one row per subject (optionally for one student).
  const group_by = request.args.get("by") === "subject" ? "subject" : "student";
  let subject = null, student = null;
  if (group_by === "student" && toInt(request.args.get("subject_id"))) {
    subject = db.get_subject(toInt(request.args.get("subject_id")));
  }
  if (group_by === "subject" && toInt(request.args.get("student_id"))) {
    student = db.get_student(toInt(request.args.get("student_id")));
  }

  const rows = db.attendance_report(group_by, subject ? subject.id : null, student ? student.id : null)
    .map((r) => {
      const row = { ...r };
      row.percent = r.total ? pyRound(r.present * 100 / r.total, 1) : null;
      row.low = row.percent !== null && row.percent < MIN_ATTENDANCE;
      return row;
    });
  const summary = { rows: rows.length, low: rows.filter((r) => r.low).length,
    unmarked: rows.filter((r) => r.percent === null).length };
  return render_template("admin/attendance_report.html", { group_by, rows, summary, subject, student,
    subjects: db.list_subjects(), students: db.list_students(),
    min_attendance: MIN_ATTENDANCE, active_nav: "report" });
}));

// ---- Notices & holidays ---------------------------------------------------

const TITLE_MAX = 200;

/** Shared validation for the notice and holiday add forms.
 * Error keys are prefixed so both forms can live on one page. */
function _read_dated_form(prefix) {
  const data = { date: request.form.get("date", "").trim(), title: collapseSpaces(request.form.get("title", "")) };
  const errors = {};
  if (!data.date) {
    errors[`${prefix}_date`] = "Date is required.";
  } else {
    const [day, err] = _parse_day(data.date);
    if (err) errors[`${prefix}_date`] = err;
    else data.date = day;
  }
  if (!data.title) errors[`${prefix}_title`] = "Title is required.";
  else if (data.title.length > TITLE_MAX) errors[`${prefix}_title`] = `Keep the title under ${TITLE_MAX} characters.`;
  return [data, errors];
}

function _render_notices({ errors = null, notice = null, holiday = null, status = 200 } = {}) {
  return [render_template("admin/notices.html", { notices: db.list_notices(-1),
    holidays: db.list_holidays(), errors: errors || {},
    notice: notice || { date: todayISO(), title: "" },
    holiday: holiday || { date: "", title: "" },
    active_nav: "notices" }), status];
}

app.route("/notices", login_required(function notices() {
  return _render_notices();
}));

app.route("/notices/add", { methods: ["POST"] }, login_required(function notice_add() {
  const [data, errors] = _read_dated_form("notice");
  if (Object.keys(errors).length) return _render_notices({ errors, notice: data, status: 400 });
  db.create_notice(data.date, data.title);
  flash(`Notice “${data.title}” was published.`, "success");
  return redirect(url_for("notices"));
}));

app.route("/notices/<int:notice_id>/delete", { methods: ["POST"] }, login_required(function notice_delete({ notice_id }) {
  if (!db.delete_notice(notice_id)) abort(404);
  flash("Notice was deleted.", "success");
  return redirect(url_for("notices"));
}));

app.route("/holidays/add", { methods: ["POST"] }, login_required(function holiday_add() {
  const [data, errors] = _read_dated_form("holiday");
  if (Object.keys(errors).length) return _render_notices({ errors, holiday: data, status: 400 });
  db.create_holiday(data.date, data.title);
  flash(`Holiday “${data.title}” was added.`, "success");
  return redirect(url_for("notices", { _anchor: "holidays" }));
}));

app.route("/holidays/<int:holiday_id>/delete", { methods: ["POST"] }, login_required(function holiday_delete({ holiday_id }) {
  if (!db.delete_holiday(holiday_id)) abort(404);
  flash("Holiday was deleted.", "success");
  return redirect(url_for("notices", { _anchor: "holidays" }));
}));

// ---- Backup (static version only: data lives in this browser) ---------------

app.route("/backup", login_required(function backup_page() {
  return render_template("admin/backup.html", { counts: backup.summary(), active_nav: "backup",
    persistent: backup.persistent });
}));

app.route("/backup/export", login_required(function backup_export() {
  const { filename, blob } = backup.exportBlob();
  return sendDownload(filename, blob);
}));

app.route("/backup/import", { methods: ["POST"] }, login_required(async function backup_import() {
  const upload = request.files.get("backup");
  if (!upload || !upload.name) {
    flash("Choose a backup file to import.", "error");
    return redirect(url_for("backup_page"));
  }
  try {
    const n = await backup.importFile(upload);
    // The imported data has its own admin account, so sign in again.
    session.clear();
    flash(`Backup imported (${n} records). Sign in again to continue.`, "success");
    return redirect(url_for("login"));
  } catch (e) {
    if (!(e instanceof db.ValueError)) throw e;
    flash(e.message, "error");
    return redirect(url_for("backup_page"));
  }
}));

// ---- Errors -----------------------------------------------------------------

function http_error(err) {
  return [render_template("admin/coming_soon.html", { error: err, title: `Error ${err.code}`,
    icon: "exclamation-octagon", blurb: err.description, active_nav: null }), err.code];
}
for (const code of [400, 404, 405, 413, 500]) app.errorhandler(code, http_error);
