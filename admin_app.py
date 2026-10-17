"""Admin backend for the Campus ERP.

Runs as a separate Flask app (default http://127.0.0.1:5001) and shares the
SQLite database with the student portal (app.py) through erp/db.py, so a
student created here can log in to the portal straight away.
"""
import hmac
import os
import re
import secrets
import time
from datetime import date
from functools import wraps

from flask import (Flask, abort, flash, redirect, render_template, request,
                   send_file, session, url_for)

from erp import db, photos

app = Flask(__name__)
app.config.update(
    SECRET_KEY=os.environ.get("ERP_ADMIN_SECRET_KEY", "dev-admin-secret-change-me"),
    # The student portal on :5000 uses 'portal_session'. Browsers share
    # localhost cookies across ports, so the names must differ.
    SESSION_COOKIE_NAME="admin_session",
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    # Photo uploads are capped at 2 MB in erp/photos.py; this bounds the whole request.
    MAX_CONTENT_LENGTH=3 * 1024 * 1024,
)

db.init_db()

MAX_FAILED_LOGINS = 5
LOCKOUT_SECONDS = 60
PASSWORD_MIN_LENGTH = 6
STATUSES = ("Active", "Inactive")
REQUIRED_FIELDS = ("name", "roll_no", "enrollment_no")


# ---- CSRF -----------------------------------------------------------------

def csrf_token():
    token = session.get("csrf_token")
    if not token:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token
    return token


app.jinja_env.globals["csrf_token"] = csrf_token


@app.before_request
def check_csrf():
    if request.method == "POST":
        expected = session.get("csrf_token", "")
        sent = request.form.get("csrf_token", "")
        if not expected or not sent or not hmac.compare_digest(expected, sent):
            abort(400, description="Invalid or missing CSRF token. Reload the page and try again.")


@app.context_processor
def inject_globals():
    return {"portal_name": db.PORTAL_NAME, "admin_user": session.get("admin_user")}


# ---- Auth -----------------------------------------------------------------

def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if not session.get("admin_id"):
            return redirect(url_for("login", next=request.path))
        return view(*args, **kwargs)
    return wrapper


def _seconds_locked():
    until = session.get("login_locked_until", 0)
    remaining = int(until - time.time())
    return remaining if remaining > 0 else 0


@app.route("/login", methods=["GET", "POST"])
def login():
    if session.get("admin_id"):
        return redirect(url_for("dashboard"))

    error = None
    username = ""
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        locked = _seconds_locked()
        if locked:
            error = f"Too many failed attempts. Try again in {locked} seconds."
        else:
            admin = db.authenticate_admin(username, password)
            if admin:
                session.clear()  # drop any pre-login state (and the old CSRF token)
                session["admin_id"] = admin["id"]
                session["admin_user"] = admin["username"]
                flash(f"Welcome back, {admin['username']}.", "success")
                nxt = request.args.get("next", "")
                # Only allow local paths as redirect targets.
                if not nxt.startswith("/") or nxt.startswith("//"):
                    nxt = url_for("dashboard")
                return redirect(nxt)
            failures = session.get("login_failures", 0) + 1
            if failures >= MAX_FAILED_LOGINS:
                session["login_locked_until"] = time.time() + LOCKOUT_SECONDS
                failures = 0
                error = f"Too many failed attempts. Try again in {LOCKOUT_SECONDS} seconds."
            else:
                error = "Invalid username or password."
            session["login_failures"] = failures

    return render_template("admin/login.html", error=error, username=username)


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    flash("You have been signed out.", "info")
    return redirect(url_for("login"))


# ---- Students -------------------------------------------------------------

@app.route("/")
@login_required
def dashboard():
    q = request.args.get("q", "").strip()
    students = db.list_students(q)
    all_students = db.list_students() if q else students
    active = sum(1 for s in all_students if s["status"] == "Active")
    stats = {"total": len(all_students), "active": active, "inactive": len(all_students) - active,
             "subjects": len(db.list_subjects())}
    return render_template("admin/dashboard.html", students=students, q=q, stats=stats,
                           active_nav="students")


def _read_form(require_password):
    data = {key: request.form.get(key, "").strip() for key, _ in db.STUDENT_FIELDS}
    status = request.form.get("status", "Active")
    data["status"] = status if status in STATUSES else "Active"
    password = request.form.get("password", "")

    errors = {}
    labels = dict(db.STUDENT_FIELDS)
    for key in REQUIRED_FIELDS:
        if not data[key]:
            errors[key] = f"{labels[key]} is required."
    if require_password and not password:
        errors["password"] = "Password is required."
    elif password and len(password) < PASSWORD_MIN_LENGTH:
        errors["password"] = f"Password must be at least {PASSWORD_MIN_LENGTH} characters."
    return data, password, errors


def _read_photo(errors):
    """Save an uploaded photo (if one was chosen) before the student row is
    written, so a bad image is reported with the other field errors.
    Returns the new file name or None."""
    upload = request.files.get("photo")
    if upload is None or not upload.filename:
        return None
    try:
        return photos.save(upload)
    except ValueError as e:
        errors["photo"] = str(e)
        return None


@app.route("/students/new", methods=["GET", "POST"])
@login_required
def student_new():
    data = {key: "" for key, _ in db.STUDENT_FIELDS}
    data["status"] = "Active"
    errors, form_error = {}, None
    if request.method == "POST":
        data, password, errors = _read_form(require_password=True)
        photo = _read_photo(errors)
        if errors:
            photos.delete(photo)
        else:
            try:
                student_id = db.create_student(data, password)
            except ValueError as e:
                photos.delete(photo)
                form_error = str(e)
            else:
                if photo:
                    db.set_student_photo(student_id, photo)
                flash(f"Student “{data['name']}” was added.", "success")
                return redirect(url_for("dashboard"))
    return render_template("admin/student_form.html", mode="create", data=data, errors=errors,
                           form_error=form_error, fields=db.STUDENT_FIELDS, statuses=STATUSES,
                           required=REQUIRED_FIELDS, min_pw=PASSWORD_MIN_LENGTH,
                           active_nav="students")


@app.route("/students/<int:student_id>/edit", methods=["GET", "POST"])
@login_required
def student_edit(student_id):
    student = db.get_student(student_id)
    if student is None:
        abort(404)
    data = dict(student)
    errors, form_error = {}, None
    if request.method == "POST":
        data, password, errors = _read_form(require_password=False)
        data["photo"] = student["photo"]  # keep showing the current photo on re-render
        photo = _read_photo(errors)
        if errors:
            photos.delete(photo)
        else:
            try:
                db.update_student(student_id, data, password or None)
            except ValueError as e:
                photos.delete(photo)
                form_error = str(e)
            else:
                if photo:
                    db.set_student_photo(student_id, photo)
                    photos.delete(student["photo"])
                elif request.form.get("remove_photo"):
                    photos.remove(student_id)
                flash(f"Student “{data['name']}” was updated.", "success")
                return redirect(url_for("dashboard"))
    return render_template("admin/student_form.html", mode="edit", student=student, data=data,
                           errors=errors, form_error=form_error, fields=db.STUDENT_FIELDS,
                           statuses=STATUSES, required=REQUIRED_FIELDS,
                           min_pw=PASSWORD_MIN_LENGTH, active_nav="students")


@app.route("/students/<int:student_id>/photo")
@login_required
def student_photo(student_id):
    student = db.get_student(student_id)
    if student is None or not student["photo"] or not os.path.exists(photos.path(student["photo"])):
        abort(404)
    return send_file(photos.path(student["photo"]), mimetype=photos.mimetype(student["photo"]),
                     max_age=86400)


@app.route("/students/<int:student_id>/delete", methods=["POST"])
@login_required
def student_delete(student_id):
    student = db.get_student(student_id)
    if student is None:
        abort(404)
    db.delete_student(student_id)
    photos.delete(student["photo"])
    flash(f"Student “{student['name']}” was deleted.", "success")
    return redirect(url_for("dashboard"))


# ---- Subjects -------------------------------------------------------------

SUBJECT_CODE_RE = re.compile(r"^[A-Z0-9]{2,12}$")
SUBJECT_NAME_MAX = 120


def _read_subject_form():
    # Codes are stored upper-case so "tcs104" and "TCS104" can't both exist.
    data = {"code": request.form.get("code", "").strip().upper(),
            "name": " ".join(request.form.get("name", "").split())}
    errors = {}
    if not data["code"]:
        errors["code"] = "Subject code is required."
    elif not SUBJECT_CODE_RE.match(data["code"]):
        errors["code"] = "Use 2–12 letters and digits only, e.g. TCS104."
    if not data["name"]:
        errors["name"] = "Subject name is required."
    elif len(data["name"]) > SUBJECT_NAME_MAX:
        errors["name"] = f"Keep the name under {SUBJECT_NAME_MAX} characters."
    return data, errors


@app.route("/subjects")
@login_required
def subjects():
    q = request.args.get("q", "").strip()
    return render_template("admin/subjects.html", subjects=db.list_subjects(q), q=q,
                           active_nav="subjects")


@app.route("/subjects/new", methods=["GET", "POST"])
@login_required
def subject_new():
    data, errors = {"code": "", "name": ""}, {}
    if request.method == "POST":
        data, errors = _read_subject_form()
        if not errors:
            try:
                db.create_subject(data["code"], data["name"])
            except ValueError as e:
                errors["code"] = str(e)
            else:
                flash(f"Subject {data['code']} “{data['name']}” was added.", "success")
                return redirect(url_for("subjects"))
    return render_template("admin/subject_form.html", mode="create", data=data, errors=errors,
                           active_nav="subjects")


@app.route("/subjects/<int:subject_id>/edit", methods=["GET", "POST"])
@login_required
def subject_edit(subject_id):
    subject = db.get_subject(subject_id)
    if subject is None:
        abort(404)
    data, errors = dict(subject), {}
    if request.method == "POST":
        data, errors = _read_subject_form()
        if not errors:
            try:
                db.update_subject(subject_id, data["code"], data["name"])
            except ValueError as e:
                errors["code"] = str(e)
            else:
                flash(f"Subject {data['code']} was updated.", "success")
                return redirect(url_for("subjects"))
    return render_template("admin/subject_form.html", mode="edit", subject=subject, data=data,
                           errors=errors, active_nav="subjects")


@app.route("/subjects/<int:subject_id>/delete", methods=["POST"])
@login_required
def subject_delete(subject_id):
    subject = db.get_subject(subject_id)
    if subject is None:
        abort(404)
    db.delete_subject(subject_id)
    flash(f"Subject {subject['code']} and its attendance records were deleted.", "success")
    return redirect(url_for("subjects"))


# ---- Attendance -----------------------------------------------------------

MIN_ATTENDANCE = 75  # same threshold the student portal uses


def _parse_day(value, allow_future=True):
    """'YYYY-MM-DD' -> (iso string or None, error message or None)."""
    try:
        day = date.fromisoformat((value or "").strip())
    except ValueError:
        return None, "Enter a valid date (YYYY-MM-DD)."
    if not allow_future and day > date.today():
        return None, "Attendance can't be marked for a future date."
    return day.isoformat(), None


def _to_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


@app.route("/attendance", methods=["GET", "POST"])
@login_required
def attendance():
    # GET picks the subject/date and shows the roster; POST saves it.
    source = request.form if request.method == "POST" else request.args
    errors = {}

    subject_id = _to_int(source.get("subject_id"))
    subject = db.get_subject(subject_id) if subject_id else None
    if subject_id and subject is None:
        errors["subject_id"] = "That subject no longer exists."
    elif request.method == "POST" and subject is None:
        errors["subject_id"] = "Choose a subject."

    raw_day = source.get("date") or date.today().isoformat()
    day, day_error = _parse_day(raw_day, allow_future=False)
    if day_error:
        errors["date"] = day_error

    roster = [s for s in db.list_students() if s["status"] == "Active"]

    if request.method == "POST" and not errors:
        # Only write students that were on the submitted roster, so a student
        # activated in the meantime isn't silently marked absent.
        active_ids = {s["id"] for s in roster}
        shown = {i for i in map(_to_int, request.form.getlist("roster")) if i in active_ids}
        present = set(map(_to_int, request.form.getlist("present")))
        if not shown:
            errors["roster"] = "There are no active students to mark."
        else:
            marks = {sid: sid in present for sid in shown}
            was_marked = bool(db.attendance_for(subject["id"], day))
            db.save_attendance(subject["id"], day, marks)
            n_present = sum(marks.values())
            flash(f"Attendance {'updated' if was_marked else 'saved'} for {subject['code']} "
                  f"on {day}: {n_present} present, {len(marks) - n_present} absent.", "success")
            return redirect(url_for("attendance", subject_id=subject["id"], date=day))

    existing = db.attendance_for(subject["id"], day) if subject and day else {}
    recent = db.recent_attendance_dates(subject["id"]) if subject else []
    status = 400 if request.method == "POST" else 200
    return render_template("admin/attendance.html", subjects=db.list_subjects(), subject=subject,
                           day=day or raw_day, today=date.today().isoformat(), roster=roster,
                           existing=existing, recent=recent, errors=errors,
                           active_nav="attendance"), status


@app.route("/attendance/report")
@login_required
def attendance_report():
    # by=student: one row per student (optionally for one subject);
    # by=subject: one row per subject (optionally for one student).
    group_by = "subject" if request.args.get("by") == "subject" else "student"
    subject = student = None
    if group_by == "student" and _to_int(request.args.get("subject_id")):
        subject = db.get_subject(_to_int(request.args.get("subject_id")))
    if group_by == "subject" and _to_int(request.args.get("student_id")):
        student = db.get_student(_to_int(request.args.get("student_id")))

    rows = []
    for r in db.attendance_report(group_by, subject["id"] if subject else None,
                                  student["id"] if student else None):
        row = dict(r)
        row["percent"] = round(r["present"] * 100 / r["total"], 1) if r["total"] else None
        row["low"] = row["percent"] is not None and row["percent"] < MIN_ATTENDANCE
        rows.append(row)
    summary = {"rows": len(rows), "low": sum(1 for r in rows if r["low"]),
               "unmarked": sum(1 for r in rows if r["percent"] is None)}
    return render_template("admin/attendance_report.html", group_by=group_by, rows=rows,
                           summary=summary, subject=subject, student=student,
                           subjects=db.list_subjects(), students=db.list_students(),
                           min_attendance=MIN_ATTENDANCE, active_nav="report")


# ---- Notices & holidays ---------------------------------------------------

TITLE_MAX = 200


def _read_dated_form(prefix):
    """Shared validation for the notice and holiday add forms.
    Error keys are prefixed so both forms can live on one page."""
    data = {"date": request.form.get("date", "").strip(),
            "title": " ".join(request.form.get("title", "").split())}
    errors = {}
    if not data["date"]:
        errors[f"{prefix}_date"] = "Date is required."
    else:
        day, err = _parse_day(data["date"])
        if err:
            errors[f"{prefix}_date"] = err
        else:
            data["date"] = day
    if not data["title"]:
        errors[f"{prefix}_title"] = "Title is required."
    elif len(data["title"]) > TITLE_MAX:
        errors[f"{prefix}_title"] = f"Keep the title under {TITLE_MAX} characters."
    return data, errors


def _render_notices(errors=None, notice=None, holiday=None, status=200):
    return render_template("admin/notices.html", notices=db.list_notices(limit=-1),
                           holidays=db.list_holidays(), errors=errors or {},
                           notice=notice or {"date": date.today().isoformat(), "title": ""},
                           holiday=holiday or {"date": "", "title": ""},
                           active_nav="notices"), status


@app.route("/notices")
@login_required
def notices():
    return _render_notices()


@app.route("/notices/add", methods=["POST"])
@login_required
def notice_add():
    data, errors = _read_dated_form("notice")
    if errors:
        return _render_notices(errors, notice=data, status=400)
    db.create_notice(data["date"], data["title"])
    flash(f"Notice “{data['title']}” was published.", "success")
    return redirect(url_for("notices"))


@app.route("/notices/<int:notice_id>/delete", methods=["POST"])
@login_required
def notice_delete(notice_id):
    if not db.delete_notice(notice_id):
        abort(404)
    flash("Notice was deleted.", "success")
    return redirect(url_for("notices"))


@app.route("/holidays/add", methods=["POST"])
@login_required
def holiday_add():
    data, errors = _read_dated_form("holiday")
    if errors:
        return _render_notices(errors, holiday=data, status=400)
    db.create_holiday(data["date"], data["title"])
    flash(f"Holiday “{data['title']}” was added.", "success")
    return redirect(url_for("notices", _anchor="holidays"))


@app.route("/holidays/<int:holiday_id>/delete", methods=["POST"])
@login_required
def holiday_delete(holiday_id):
    if not db.delete_holiday(holiday_id):
        abort(404)
    flash("Holiday was deleted.", "success")
    return redirect(url_for("notices", _anchor="holidays"))


@app.errorhandler(400)
@app.errorhandler(404)
@app.errorhandler(413)
def http_error(err):
    return render_template("admin/coming_soon.html", error=err, title=f"Error {err.code}",
                           icon="exclamation-octagon", blurb=err.description,
                           active_nav=None), err.code


if __name__ == "__main__":
    app.run(host=os.environ.get("ADMIN_HOST", "127.0.0.1"),
            port=int(os.environ.get("ADMIN_PORT", "5001")),
            debug=os.environ.get("FLASK_DEBUG") == "1")
