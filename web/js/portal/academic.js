// Academic pages of the student portal. Port of portal/academic.py.
import { Blueprint, abort, flash, g, redirect, request, url_for } from "../lib/flask.js";
import { pyRound } from "../lib/py.js";
import * as data from "../erp/academic.js";
import * as db from "../erp/db.js";
import { MIN_ATTENDANCE, login_required, render_page } from "./common.js";

export const bp = new Blueprint("academic", { url_prefix: "/academic" });

bp.route("/", login_required(function index() {
  const student = g.student;
  const courses = data.list_courses();
  const attendance = data.attendance_by_subject(student.id);
  const given = data.feedback_status(student.id, db.SESSION_LABEL);
  const applications = data.MINOR_KINDS.map((kind) => data.get_application(student.id, kind, db.SESSION_LABEL));
  return render_page("portal/academic/index.html", "academic", {
    tab: "overview",
    enrollment: data.get_enrollment(student.id), courses, attendance,
    total_credits: courses.reduce((sum, c) => sum + (c.credits || 0), 0),
    feedback_pending: courses.filter((c) => !(c.code in given)).length,
    applications: applications.filter(Boolean), min_attendance: MIN_ATTENDANCE,
  });
}));

bp.route("/timetable", login_required(function timetable() {
  const enrollment = data.get_enrollment(g.student.id);
  const days = data.timetable(enrollment.section);
  return render_page("portal/academic/timetable.html", "timetable", {
    tab: "timetable",
    enrollment, days, periods: data.PERIODS, breaks: data.break_times(), now: data.today_status(days),
  });
}));

bp.route("/attendance", login_required(function attendance_detail() {
  const student = g.student;
  const courses = data.list_courses();
  const codes = new Set(courses.map((c) => c.code));
  let subject = request.args.get("subject", "");
  subject = codes.has(subject) ? subject : "";  // unknown codes fall back to "all"
  let status = request.args.get("status", "");
  status = status === "present" || status === "absent" ? status : "";
  // Totals cover the chosen subject regardless of the present/absent filter.
  const all_rows = data.attendance_log(student.id, subject || null);
  const total = all_rows.length;
  const present = all_rows.reduce((sum, r) => sum + r.present, 0);
  const log = all_rows.filter((r) => !status || !!r.present === (status === "present"));
  return render_page("portal/academic/attendance.html", "academic", {
    tab: "attendance",
    courses, subject, status, log, total, present,
    percent: total ? pyRound(present * 100 / total, 1) : null, min_attendance: MIN_ATTENDANCE,
  });
}));

bp.route("/feedback", login_required(function feedback() {
  const student = g.student;
  const courses = data.list_courses();
  const given = data.feedback_status(student.id, db.SESSION_LABEL);
  const code = request.args.get("subject", "");
  const selected = courses.find((c) => c.code === code) ?? null;
  const mine = selected ? data.get_feedback(student.id, code, db.SESSION_LABEL) : null;
  return render_page("portal/academic/feedback.html", "academic", {
    tab: "feedback",
    courses, given, selected, mine,
    questions: data.FEEDBACK_QUESTIONS, labels: data.RATING_LABELS,
    comment_max: data.FEEDBACK_COMMENT_MAX,
  });
}));

bp.route("/feedback/<code>", { methods: ["POST"] }, login_required(function submit_feedback({ code }) {
  if (data.get_course(code) === null) abort(404);
  try {
    const ratings = data.parse_ratings(request.form);
    data.submit_feedback(g.student.id, code, db.SESSION_LABEL, ratings, request.form.get("comment", ""));
    flash("Thank you, your feedback has been submitted.", "info");
  } catch (e) {
    if (!(e instanceof db.ValueError)) throw e;
    flash(e.message, "error");
  }
  return redirect(url_for("academic.feedback", { subject: code }));
}));

/** 'minor' / 'specialisation' from the URL -> the stored kind. */
function _kind_arg(value) {
  return data.MINOR_KINDS.find((k) => k.toLowerCase() === (value || "").toLowerCase()) ?? data.MINOR_KINDS[0];
}

bp.route("/minor", login_required(function minor() {
  const kind = _kind_arg(request.args.get("type"));
  const application = data.get_application(g.student.id, kind, db.SESSION_LABEL);
  const chosen = application ? Object.fromEntries(application.choices.map((c) => [c.rank, c.id])) : {};
  return render_page("portal/academic/minor.html", "academic", {
    tab: "minor",
    kind, kinds: data.MINOR_KINDS, minors: data.list_minors(kind, db.SESSION_LABEL),
    application, chosen, max_preferences: data.MAX_PREFERENCES,
  });
}));

bp.route("/minor", { methods: ["POST"] }, login_required(function submit_minor() {
  const kind = _kind_arg(request.form.get("type"));
  if (request.form.get("action") === "withdraw") {
    if (data.withdraw_preferences(g.student.id, kind, db.SESSION_LABEL)) {
      flash(`Your ${kind.toLowerCase()} preferences have been withdrawn.`, "info");
    } else {
      flash("There was nothing to withdraw.", "error");
    }
    return redirect(url_for("academic.minor", { type: kind.toLowerCase() }));
  }
  const picks = [];
  for (let i = 1; i <= data.MAX_PREFERENCES; i++) picks.push(request.form.get(`pref${i}`, "").trim());
  try {
    // Drop trailing blanks; a blank in the middle would break the order.
    while (picks.length && !picks[picks.length - 1]) picks.pop();
    if (picks.some((p) => !/^\d+$/.test(p))) {
      throw new db.ValueError("Fill your preferences in order, starting with the first.");
    }
    data.submit_preferences(g.student.id, kind, db.SESSION_LABEL, picks.map((p) => parseInt(p, 10)));
    flash(`Your ${kind.toLowerCase()} preferences have been saved.`, "info");
  } catch (e) {
    if (!(e instanceof db.ValueError)) throw e;
    flash(e.message, "error");
  }
  return redirect(url_for("academic.minor", { type: kind.toLowerCase() }));
}));
