/* Student portal. Port of app.py, mounted at the site root (/ is the login page).
 *
 * Students sign in with their enrollment number or roll number. All data
 * comes from the in-browser database in erp/db.js, which the admin console
 * (admin.js) writes to.
 */
import { App, flash, g, redirect, render_template, request, session, url_for } from "./lib/flask.js";
import { PyDate, pyRound, todayISO } from "./lib/py.js";
import * as academic_data from "./erp/academic.js";
import * as db from "./erp/db.js";
import * as photos from "./erp/photos.js";
import * as fee_data from "./erp/fees.js";
import * as academic from "./portal/academic.js";
import * as campus from "./portal/campus.js";
import * as exams from "./portal/exams.js";
import * as fees from "./portal/fees.js";
import { MIN_ATTENDANCE, initials, login_required } from "./portal/common.js";

export const app = new App("portal", { prefix: "", sessionKey: "erp.portal_session" });

for (const module of [fees, academic, exams, campus]) app.register_blueprint(module.bp);

// Sidebar entries after Dashboard/Profile/Attendance:
// [label, Bootstrap icon, endpoint, `active` key the page passes].
// An entry whose endpoint isn't registered yet is shown as "Soon".
const MODULES = [
  ["Fee", "bi-credit-card-2-front-fill", "fees.index", "fee"],
  ["Time Table", "bi-calendar3-week", "academic.timetable", "timetable"],
  ["Academic", "bi-mortarboard-fill", "academic.index", "academic"],
  ["Exam", "bi-clipboard2-check-fill", "exams.index", "exam"],
  ["Circular", "bi-megaphone-fill", "campus.circulars", "circular"],
  ["Placement", "bi-briefcase-fill", "campus.placement", "placement"],
];

app.context_processor(() => ({
  PORTAL_NAME: db.PORTAL_NAME,
  INSTITUTION_NAME: db.INSTITUTION_NAME,
  SESSION_LABEL: db.SESSION_LABEL,
  MODULES: MODULES.map(([label, icon, endpoint, key]) =>
    [label, icon, endpoint, key, app.view_functions_has(endpoint)]),
  today: PyDate.today(),
}));

/** '2026-10-13' -> '13/10/2026'. Leaves unparseable values unchanged. */
app.template_filter("dmy", (value) => {
  try {
    return PyDate.fromisoformat(String(value ?? "").slice(0, 10)).strftime("%d/%m/%Y");
  } catch {
    return value;
  }
});

/** Add a percentage to each subject row and compute the overall figure. */
export function summarize_attendance(rows) {
  const subjects = [];
  let total = 0, present = 0;
  for (const r of rows) {
    const pct = r.total ? pyRound(r.present * 100 / r.total, 1) : 0.0;
    subjects.push({ code: r.code, name: r.name, total: r.total, present: r.present, percent: pct });
    total += r.total;
    present += r.present;
  }
  const overall = total ? pyRound(present * 100 / total, 1) : null;
  return [subjects, overall, total, present];
}

app.route("/", function index() {
  if (session.get("student_id")) return redirect(url_for("dashboard"));
  return redirect(url_for("login"));
});

app.route("/login", { methods: ["GET", "POST"] }, async function login() {
  if (request.method === "POST") {
    const user_id = request.form.get("user_id", "");
    const student = await db.authenticate_student(user_id, request.form.get("password", ""));
    if (student) {
      session.clear();
      session.set("student_id", student.id);
      return redirect(url_for("dashboard"));
    }
    flash("Invalid credentials. Please check your User ID and password.", "error");
    return [render_template("portal/login.html", { user_id: user_id.trim(), login_bg: false }), 401];
  }
  if (session.get("student_id") && db.get_student(session.get("student_id"))) {
    return redirect(url_for("dashboard"));
  }
  return render_template("portal/login.html", { user_id: "", login_bg: false });
});

app.route("/logout", { methods: ["GET", "POST"] }, function logout() {
  session.clear();
  flash("You have been signed out.", "info");
  return redirect(url_for("login"));
});

app.route("/dashboard", login_required(function dashboard() {
  const student = g.student;
  const [subjects, overall] = summarize_attendance(db.attendance_summary(student.id));
  const today_iso = todayISO();
  const holidays = db.list_holidays();
  const upcoming = holidays.filter((h) => h.date >= today_iso);
  const past = holidays.filter((h) => h.date < today_iso);
  return render_template("portal/dashboard.html", {
    active: "dashboard",
    student,
    initials: initials(student.name),
    first_name: (student.name.split(/\s+/).filter(Boolean)[0] || ""),
    enrollment: academic_data.get_enrollment(student.id),
    fees: fee_data.dues_summary(student.id),
    overall,
    subject_count: subjects.length,
    min_attendance: MIN_ATTENDANCE,
    notices: db.list_notices(),
    upcoming_holidays: upcoming,
    past_holidays: past,
  });
}));

app.route("/profile", login_required(function profile() {
  const student = g.student;
  const fields = db.STUDENT_FIELDS.map(([col, label]) => [label, student[col]]);
  fields.push(["Account Status", student.status]);
  return render_template("portal/profile.html", { active: "profile", student,
    initials: initials(student.name), fields });
}));

/** The signed-in student's own photo (set by an admin). There is
 * deliberately no way to fetch another student's photo from the portal. */
app.asset("photo", () => {
  const student = session.get("student_id") ? db.get_student(session.get("student_id")) : null;
  return student ? photos.url(student.photo) : "";
});

app.route("/attendance", login_required(function attendance() {
  const student = g.student;
  const [subjects, overall, total, present] = summarize_attendance(db.attendance_summary(student.id));
  return render_template("portal/attendance.html", { active: "attendance", student,
    initials: initials(student.name), subjects, overall, total, present,
    min_attendance: MIN_ATTENDANCE });
}));

app.errorhandler("default", (err) => [render_template("portal/error.html", { error: err }), err.code]);
