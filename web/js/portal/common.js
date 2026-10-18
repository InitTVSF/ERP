// Helpers shared by portal.js and the portal blueprints. Port of portal/common.py.
import { g, redirect, render_template, session, url_for } from "../lib/flask.js";
import * as db from "../erp/db.js";

export const MIN_ATTENDANCE = 75;  // percent; below this a subject is flagged

/** Re-load the student on every request so a deleted or deactivated
 * account is signed out immediately. */
export function login_required(view) {
  const wrapped = (params) => {
    const student_id = session.get("student_id");
    const student = student_id ? db.get_student(student_id) : null;
    if (student === null || student.status !== "Active") {
      session.clear();
      return redirect(url_for("login"));
    }
    g.student = student;
    return view(params);
  };
  Object.defineProperty(wrapped, "name", { value: view.name });
  return wrapped;
}

export function initials(name) {
  const parts = (name || "").split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Render a logged-in portal page; `active` highlights the sidebar entry. */
export function render_page(template, active, context = {}) {
  return render_template(template, { active, student: g.student, initials: initials(g.student.name), ...context });
}
