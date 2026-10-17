"""Helpers shared by app.py and the portal blueprints."""
from functools import wraps

from flask import g, redirect, render_template, session, url_for

from erp import db

MIN_ATTENDANCE = 75  # percent; below this a subject is flagged


def login_required(view):
    """Re-load the student on every request so a deleted or deactivated
    account is signed out immediately."""
    @wraps(view)
    def wrapped(*args, **kwargs):
        student_id = session.get("student_id")
        student = db.get_student(student_id) if student_id else None
        if student is None or student["status"] != "Active":
            session.clear()
            return redirect(url_for("login"))
        g.student = student
        return view(*args, **kwargs)
    return wrapped


def initials(name):
    parts = (name or "").split()
    if not parts:
        return "?"
    if len(parts) == 1:
        return parts[0][:2].upper()
    return (parts[0][0] + parts[-1][0]).upper()


def render_page(template, active, **context):
    """Render a logged-in portal page; `active` highlights the sidebar entry."""
    return render_template(template, active=active, student=g.student,
                           initials=initials(g.student["name"]), **context)
