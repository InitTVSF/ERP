"""Campus pages of the student portal: circulars and placement."""
from datetime import date

from flask import Blueprint, abort, flash, g, redirect, request, url_for

from erp import campus as data
from portal.common import login_required, render_page

bp = Blueprint("campus", __name__, url_prefix="/campus")

PLACEMENT_TABS = ("drives", "applications")


@bp.route("/circulars")
@login_required
def circulars():
    q = request.args.get("q", "").strip()[:100]
    category = request.args.get("category", "")
    if category not in data.CATEGORIES:
        category = ""
    return render_page("portal/campus/circulars.html", active="circular",
                       circulars=data.list_circulars(q, category),
                       categories=data.CATEGORIES, q=q, category=category)


@bp.route("/circulars/<int:circular_id>")
@login_required
def circular(circular_id):
    item = data.get_circular(circular_id)
    if item is None:
        abort(404)
    paragraphs = [p.strip() for p in item["body"].splitlines() if p.strip()]
    return render_page("portal/campus/circular.html", active="circular",
                       circular=item, paragraphs=paragraphs)


@bp.route("/placement")
@login_required
def placement():
    tab = request.args.get("tab", "drives")
    if tab not in PLACEMENT_TABS:
        tab = "drives"
    drives = [dict(d, days_left=_days_until(d["apply_by"])) for d in data.list_drives(g.student["id"])]
    applications = data.student_applications(g.student["id"])
    return render_page("portal/campus/placement.html", active="placement", tab=tab,
                       drives=drives, applications=applications, stats=data.placement_stats(),
                       statuses=data.APPLICATION_STATUSES)


@bp.route("/placement/<int:drive_id>/apply", methods=["POST"])
@login_required
def apply(drive_id):
    try:
        drive = data.apply(g.student["id"], drive_id)
        flash(f"Applied to {drive['company']} ({drive['role']}).", "success")
    except ValueError as e:
        flash(str(e), "error")
    return redirect(_back("drives"))


@bp.route("/placement/<int:drive_id>/withdraw", methods=["POST"])
@login_required
def withdraw(drive_id):
    try:
        drive = data.withdraw(g.student["id"], drive_id)
        flash(f"Your application to {drive['company']} was withdrawn.", "info")
    except ValueError as e:
        flash(str(e), "error")
    return redirect(_back("drives"))


def _days_until(iso):
    try:
        return (date.fromisoformat(iso) - date.today()).days
    except ValueError:
        return None


def _back(default_tab):
    """Return to the tab the form was submitted from."""
    tab = request.form.get("tab", default_tab)
    return url_for("campus.placement", tab=tab if tab in PLACEMENT_TABS else default_tab)
