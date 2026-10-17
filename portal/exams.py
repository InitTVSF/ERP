"""Exam pages of the student portal: date sheet + registration, admit card,
results and a printable marksheet."""
from flask import Blueprint, abort, flash, g, redirect, request, url_for

from erp import exams as data
from portal.common import login_required, render_page

bp = Blueprint("exams", __name__, url_prefix="/exam")


def _common():
    return {"term_label": data.CURRENT_TERM_LABEL, "current_semester": data.CURRENT_SEMESTER}


@bp.route("/")
@login_required
def index():
    sid = g.student["id"]
    data.ensure_student_data(sid)
    exams = data.date_sheet()
    groups = [(t, [e for e in exams if e["exam_type"] == t]) for t in data.TYPE_ORDER]
    return render_page(
        "portal/exams/index.html", active="exam", tab="overview",
        groups=[(t, rows) for t, rows in groups if rows],
        exam_count=len(exams),
        upcoming=[e for e in exams if not e["done"]],
        registration=data.registration(sid),
        reg_open=data.registration_open(),
        deadline=data.REGISTRATION_DEADLINE,
        registered_types=data.REGISTERED_TYPES,
        back_options=data.back_paper_options(sid),
        **_common(),
    )


@bp.route("/register", methods=["POST"])
@login_required
def register():
    sid = g.student["id"]
    if data.registration(sid):
        flash("You are already registered for this examination.", "info")
    elif not data.registration_open():
        flash("Examination registration is closed.", "error")
    elif not data.date_sheet():
        flash("The date sheet has not been published yet.", "error")
    elif request.form.get("confirm") != "yes":
        flash("Please confirm the declaration to register.", "error")
    else:
        data.register(sid)
        flash("Registration successful. Your admit card is now available.", "info")
    return redirect(url_for("exams.index"))


@bp.route("/back-papers", methods=["POST"])
@login_required
def register_back():
    if not data.registration_open():
        flash("Back-paper registration is closed.", "error")
        return redirect(url_for("exams.index"))
    ids = []
    for value in request.form.getlist("result_id"):
        try:
            ids.append(int(value))
        except ValueError:
            pass
    if not ids:
        flash("Select at least one course for back-paper registration.", "error")
    else:
        added = data.register_back_papers(g.student["id"], ids)
        flash(f"Registered for {added} back paper{'s' if added != 1 else ''}." if added
              else "No new back papers were registered.", "info" if added else "error")
    return redirect(url_for("exams.index"))


@bp.route("/admit-card")
@login_required
def admit_card():
    sid = g.student["id"]
    reg = data.registration(sid)
    exams = [e for e in data.date_sheet() if e["exam_type"] in data.REGISTERED_TYPES] if reg else []
    backs = [c for c in data.back_paper_options(sid) if c["back_registered"]] if reg else []
    return render_page(
        "portal/exams/admit_card.html", active="exam", tab="admit",
        registration=reg, exams=exams, backs=backs,
        reg_open=data.registration_open(),
        card_no=f"AC-{data.CURRENT_TERM}-{g.student['roll_no']}",
        instructions=data.INSTRUCTIONS,
        **_common(),
    )


def _selected(semesters, sem):
    for s in semesters:
        if s["semester"] == sem:
            return s
    return None


@bp.route("/results")
@login_required
def results():
    sid = g.student["id"]
    data.ensure_student_data(sid)
    semesters = data.semester_results(sid)
    sem = request.args.get("sem", type=int)
    selected = _selected(semesters, sem) if sem else (semesters[-1] if semesters else None)
    if sem and selected is None:
        flash(f"No result found for semester {sem}.", "error")
        return redirect(url_for("exams.results"))
    return render_page(
        "portal/exams/results.html", active="exam", tab="results",
        semesters=semesters, selected=selected, cgpa=data.cgpa(semesters),
        scale=data.GRADE_SCALE, **_common(),
    )


@bp.route("/results/<int:sem>/marksheet")
@login_required
def marksheet(sem):
    semesters = data.semester_results(g.student["id"])
    selected = _selected(semesters, sem)
    if selected is None:
        abort(404)
    return render_page(
        "portal/exams/marksheet.html", active="exam", tab="results",
        sem=selected, scale=data.GRADE_SCALE, **_common(),
    )
