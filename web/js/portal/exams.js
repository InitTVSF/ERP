// Exam pages of the student portal: date sheet + registration, admit card,
// results and a printable marksheet. Port of portal/exams.py.
import { Blueprint, abort, flash, g, redirect, request, url_for } from "../lib/flask.js";
import { toInt } from "../lib/py.js";
import * as data from "../erp/exams.js";
import { login_required, render_page } from "./common.js";

export const bp = new Blueprint("exams", { url_prefix: "/exam" });

function _common() {
  return { term_label: data.CURRENT_TERM_LABEL, current_semester: data.CURRENT_SEMESTER };
}

bp.route("/", login_required(function index() {
  const sid = g.student.id;
  data.ensure_student_data(sid);
  const exams = data.date_sheet();
  const groups = data.TYPE_ORDER.map((t) => [t, exams.filter((e) => e.exam_type === t)]);
  return render_page("portal/exams/index.html", "exam", {
    tab: "overview",
    groups: groups.filter(([, rows]) => rows.length),
    exam_count: exams.length,
    upcoming: exams.filter((e) => !e.done),
    registration: data.registration(sid),
    reg_open: data.registration_open(),
    deadline: data.REGISTRATION_DEADLINE,
    registered_types: data.REGISTERED_TYPES,
    back_options: data.back_paper_options(sid),
    ..._common(),
  });
}));

bp.route("/register", { methods: ["POST"] }, login_required(function register() {
  const sid = g.student.id;
  if (data.registration(sid)) {
    flash("You are already registered for this examination.", "info");
  } else if (!data.registration_open()) {
    flash("Examination registration is closed.", "error");
  } else if (!data.date_sheet().length) {
    flash("The date sheet has not been published yet.", "error");
  } else if (request.form.get("confirm") !== "yes") {
    flash("Please confirm the declaration to register.", "error");
  } else {
    data.register(sid);
    flash("Registration successful. Your admit card is now available.", "info");
  }
  return redirect(url_for("exams.index"));
}));

bp.route("/back-papers", { methods: ["POST"], endpoint: "register_back" }, login_required(function register_back() {
  if (!data.registration_open()) {
    flash("Back-paper registration is closed.", "error");
    return redirect(url_for("exams.index"));
  }
  const ids = request.form.getlist("result_id").map(toInt).filter((v) => v !== null);
  if (!ids.length) {
    flash("Select at least one course for back-paper registration.", "error");
  } else {
    const added = data.register_back_papers(g.student.id, ids);
    flash(added ? `Registered for ${added} back paper${added !== 1 ? "s" : ""}.`
      : "No new back papers were registered.", added ? "info" : "error");
  }
  return redirect(url_for("exams.index"));
}));

bp.route("/admit-card", login_required(function admit_card() {
  const sid = g.student.id;
  const reg = data.registration(sid);
  const exams = reg ? data.date_sheet().filter((e) => data.REGISTERED_TYPES.includes(e.exam_type)) : [];
  const backs = reg ? data.back_paper_options(sid).filter((c) => c.back_registered) : [];
  return render_page("portal/exams/admit_card.html", "exam", {
    tab: "admit",
    registration: reg, exams, backs,
    reg_open: data.registration_open(),
    card_no: `AC-${data.CURRENT_TERM}-${g.student.roll_no}`,
    instructions: data.INSTRUCTIONS,
    ..._common(),
  });
}));

function _selected(semesters, sem) {
  return semesters.find((s) => s.semester === sem) ?? null;
}

bp.route("/results", login_required(function results() {
  const sid = g.student.id;
  data.ensure_student_data(sid);
  const semesters = data.semester_results(sid);
  const sem = toInt(request.args.get("sem"));
  const selected = sem ? _selected(semesters, sem) : (semesters.length ? semesters[semesters.length - 1] : null);
  if (sem && selected === null) {
    flash(`No result found for semester ${sem}.`, "error");
    return redirect(url_for("exams.results"));
  }
  return render_page("portal/exams/results.html", "exam", {
    tab: "results",
    semesters, selected, cgpa: data.cgpa(semesters),
    scale: data.GRADE_SCALE, ..._common(),
  });
}));

bp.route("/results/<int:sem>/marksheet", login_required(function marksheet({ sem }) {
  const semesters = data.semester_results(g.student.id);
  const selected = _selected(semesters, sem);
  if (selected === null) abort(404);
  return render_page("portal/exams/marksheet.html", "exam", {
    tab: "results",
    sem: selected, scale: data.GRADE_SCALE, ..._common(),
  });
}));
