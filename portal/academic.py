"""Academic pages of the student portal."""
from flask import Blueprint, abort, flash, g, redirect, request, url_for

from erp import academic as data
from erp import db
from portal.common import MIN_ATTENDANCE, login_required, render_page

bp = Blueprint("academic", __name__, url_prefix="/academic")


@bp.route("/")
@login_required
def index():
    student = g.student
    courses = data.list_courses()
    attendance = data.attendance_by_subject(student["id"])
    given = data.feedback_status(student["id"], db.SESSION_LABEL)
    applications = [data.get_application(student["id"], kind, db.SESSION_LABEL) for kind in data.MINOR_KINDS]
    return render_page(
        "portal/academic/index.html", active="academic", tab="overview",
        enrollment=data.get_enrollment(student["id"]), courses=courses, attendance=attendance,
        total_credits=sum(c["credits"] or 0 for c in courses),
        feedback_pending=sum(1 for c in courses if c["code"] not in given),
        applications=[a for a in applications if a], min_attendance=MIN_ATTENDANCE,
    )


@bp.route("/timetable")
@login_required
def timetable():
    enrollment = data.get_enrollment(g.student["id"])
    days = data.timetable(enrollment["section"])
    return render_page(
        "portal/academic/timetable.html", active="timetable", tab="timetable",
        enrollment=enrollment, days=days, periods=data.PERIODS, breaks=data.break_times(), now=data.today_status(days),
    )


@bp.route("/attendance")
@login_required
def attendance_detail():
    student = g.student
    courses = data.list_courses()
    codes = {c["code"] for c in courses}
    subject = request.args.get("subject", "")
    subject = subject if subject in codes else ""  # unknown codes fall back to "all"
    status = request.args.get("status", "")
    status = status if status in ("present", "absent") else ""
    # Totals cover the chosen subject regardless of the present/absent filter.
    all_rows = data.attendance_log(student["id"], subject or None)
    total = len(all_rows)
    present = sum(r["present"] for r in all_rows)
    log = [r for r in all_rows if not status or r["present"] == (status == "present")]
    return render_page(
        "portal/academic/attendance.html", active="academic", tab="attendance",
        courses=courses, subject=subject, status=status, log=log, total=total, present=present,
        percent=round(present * 100 / total, 1) if total else None, min_attendance=MIN_ATTENDANCE,
    )


@bp.route("/feedback")
@login_required
def feedback():
    student = g.student
    courses = data.list_courses()
    given = data.feedback_status(student["id"], db.SESSION_LABEL)
    code = request.args.get("subject", "")
    selected = next((c for c in courses if c["code"] == code), None)
    mine = data.get_feedback(student["id"], code, db.SESSION_LABEL) if selected else None
    return render_page(
        "portal/academic/feedback.html", active="academic", tab="feedback",
        courses=courses, given=given, selected=selected, mine=mine,
        questions=data.FEEDBACK_QUESTIONS, labels=data.RATING_LABELS,
        comment_max=data.FEEDBACK_COMMENT_MAX,
    )


@bp.route("/feedback/<code>", methods=["POST"])
@login_required
def submit_feedback(code):
    if data.get_course(code) is None:
        abort(404)
    try:
        ratings = data.parse_ratings(request.form)
        data.submit_feedback(g.student["id"], code, db.SESSION_LABEL, ratings, request.form.get("comment", ""))
    except ValueError as e:
        flash(str(e), "error")
    else:
        flash("Thank you, your feedback has been submitted.", "info")
    return redirect(url_for("academic.feedback", subject=code))


def _kind_arg(value):
    """'minor' / 'specialisation' from the URL -> the stored kind."""
    return next((k for k in data.MINOR_KINDS if k.lower() == (value or "").lower()), data.MINOR_KINDS[0])


@bp.route("/minor")
@login_required
def minor():
    kind = _kind_arg(request.args.get("type"))
    application = data.get_application(g.student["id"], kind, db.SESSION_LABEL)
    chosen = {c["rank"]: c["id"] for c in application["choices"]} if application else {}
    return render_page(
        "portal/academic/minor.html", active="academic", tab="minor",
        kind=kind, kinds=data.MINOR_KINDS, minors=data.list_minors(kind, db.SESSION_LABEL),
        application=application, chosen=chosen, max_preferences=data.MAX_PREFERENCES,
    )


@bp.route("/minor", methods=["POST"])
@login_required
def submit_minor():
    kind = _kind_arg(request.form.get("type"))
    if request.form.get("action") == "withdraw":
        if data.withdraw_preferences(g.student["id"], kind, db.SESSION_LABEL):
            flash(f"Your {kind.lower()} preferences have been withdrawn.", "info")
        else:
            flash("There was nothing to withdraw.", "error")
        return redirect(url_for("academic.minor", type=kind.lower()))
    picks = [request.form.get(f"pref{i}", "").strip() for i in range(1, data.MAX_PREFERENCES + 1)]
    try:
        # Drop trailing blanks; a blank in the middle would break the order.
        while picks and not picks[-1]:
            picks.pop()
        if any(not p.isdigit() for p in picks):
            raise ValueError("Fill your preferences in order, starting with the first.")
        data.submit_preferences(g.student["id"], kind, db.SESSION_LABEL, [int(p) for p in picks])
    except ValueError as e:
        flash(str(e), "error")
    else:
        flash(f"Your {kind.lower()} preferences have been saved.", "info")
    return redirect(url_for("academic.minor", type=kind.lower()))
