"""Student portal (Flask).

Students sign in with their enrollment number or roll number. All data
comes from the shared SQLite layer in erp/db.py, which the admin app
(admin_app.py) writes to.
"""
import os
from datetime import date, datetime

from flask import (Flask, abort, flash, g, redirect, render_template, request, send_file,
                   session, url_for)

from erp import academic as academic_data
from erp import db, photos
from erp import fees as fee_data
from portal import academic, campus, exams, fees
from portal.common import MIN_ATTENDANCE, initials, login_required

app = Flask(__name__)
app.config.update(
    SECRET_KEY=os.environ.get("ERP_SECRET_KEY", "dev-portal-secret-change-me"),
    # The admin app runs on another port; browsers share localhost cookies
    # across ports, so each app needs its own cookie name.
    SESSION_COOKIE_NAME="portal_session",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
)

db.init_db()

for module in (fees, academic, exams, campus):
    app.register_blueprint(module.bp)

# Sidebar entries after Dashboard/Profile/Attendance:
# (label, Bootstrap icon, endpoint, `active` key the page passes).
# An entry whose endpoint isn't registered yet is shown as "Soon".
MODULES = [
    ("Fee", "bi-credit-card-2-front-fill", "fees.index", "fee"),
    ("Time Table", "bi-calendar3-week", "academic.timetable", "timetable"),
    ("Academic", "bi-mortarboard-fill", "academic.index", "academic"),
    ("Exam", "bi-clipboard2-check-fill", "exams.index", "exam"),
    ("Circular", "bi-megaphone-fill", "campus.circulars", "circular"),
    ("Placement", "bi-briefcase-fill", "campus.placement", "placement"),
]

# Optional campus photo for the login page; drop a file here to use it.
LOGIN_BG_EXISTS = os.path.exists(os.path.join(app.static_folder, "portal", "img", "login-bg.jpg"))


@app.context_processor
def inject_branding():
    return {
        "PORTAL_NAME": db.PORTAL_NAME,
        "INSTITUTION_NAME": db.INSTITUTION_NAME,
        "SESSION_LABEL": db.SESSION_LABEL,
        "MODULES": [(label, icon, endpoint, key, endpoint in app.view_functions)
                    for label, icon, endpoint, key in MODULES],
        "today": date.today(),
    }


@app.template_filter("dmy")
def format_dmy(value):
    """'2026-10-13' -> '13/10/2026'. Leaves unparseable values unchanged."""
    try:
        return datetime.strptime(str(value)[:10], "%Y-%m-%d").strftime("%d/%m/%Y")
    except ValueError:
        return value


def summarize_attendance(rows):
    """Add a percentage to each subject row and compute the overall figure."""
    subjects = []
    total = present = 0
    for r in rows:
        pct = round(r["present"] * 100 / r["total"], 1) if r["total"] else 0.0
        subjects.append({"code": r["code"], "name": r["name"], "total": r["total"],
                         "present": r["present"], "percent": pct})
        total += r["total"]
        present += r["present"]
    overall = round(present * 100 / total, 1) if total else None
    return subjects, overall, total, present


@app.route("/")
def index():
    if session.get("student_id"):
        return redirect(url_for("dashboard"))
    return redirect(url_for("login"))


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        user_id = request.form.get("user_id", "")
        student = db.authenticate_student(user_id, request.form.get("password", ""))
        if student:
            session.clear()
            session["student_id"] = student["id"]
            return redirect(url_for("dashboard"))
        flash("Invalid credentials. Please check your User ID and password.", "error")
        return render_template("portal/login.html", user_id=user_id.strip(),
                               login_bg=LOGIN_BG_EXISTS), 401
    if session.get("student_id") and db.get_student(session["student_id"]):
        return redirect(url_for("dashboard"))
    return render_template("portal/login.html", user_id="", login_bg=LOGIN_BG_EXISTS)


@app.route("/logout", methods=["GET", "POST"])
def logout():
    session.clear()
    flash("You have been signed out.", "info")
    return redirect(url_for("login"))


@app.route("/dashboard")
@login_required
def dashboard():
    student = g.student
    subjects, overall, _, _ = summarize_attendance(db.attendance_summary(student["id"]))
    today_iso = date.today().isoformat()
    holidays = db.list_holidays()
    upcoming = [h for h in holidays if h["date"] >= today_iso]
    past = [h for h in holidays if h["date"] < today_iso]
    return render_template(
        "portal/dashboard.html",
        active="dashboard",
        student=student,
        initials=initials(student["name"]),
        first_name=(student["name"].split() or [""])[0],
        enrollment=academic_data.get_enrollment(student["id"]),
        fees=fee_data.dues_summary(student["id"]),
        overall=overall,
        subject_count=len(subjects),
        min_attendance=MIN_ATTENDANCE,
        notices=db.list_notices(),
        upcoming_holidays=upcoming,
        past_holidays=past,
    )


@app.route("/profile")
@login_required
def profile():
    student = g.student
    fields = [(label, student[col]) for col, label in db.STUDENT_FIELDS]
    fields.append(("Account Status", student["status"]))
    return render_template("portal/profile.html", active="profile", student=student,
                           initials=initials(student["name"]), fields=fields)


@app.route("/photo")
@login_required
def photo():
    """The signed-in student's own photo (set by an admin). There is
    deliberately no way to fetch another student's photo from the portal."""
    name = g.student["photo"]
    if not name or not os.path.exists(photos.path(name)):
        abort(404)
    # The URL carries ?v=<file name prefix>, so a new upload gets a new URL.
    return send_file(photos.path(name), mimetype=photos.mimetype(name), max_age=86400)


@app.route("/attendance")
@login_required
def attendance():
    student = g.student
    subjects, overall, total, present = summarize_attendance(db.attendance_summary(student["id"]))
    return render_template("portal/attendance.html", active="attendance", student=student,
                           initials=initials(student["name"]), subjects=subjects,
                           overall=overall, total=total, present=present,
                           min_attendance=MIN_ATTENDANCE)


if __name__ == "__main__":
    # Render provides $PORT; in production gunicorn serves `app:app`.
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
