// Campus pages of the student portal: circulars and placement. Port of portal/campus.py.
import { Blueprint, abort, flash, g, redirect, request, url_for } from "../lib/flask.js";
import { PyDate } from "../lib/py.js";
import * as data from "../erp/campus.js";
import { ValueError } from "../erp/db.js";
import { login_required, render_page } from "./common.js";

export const bp = new Blueprint("campus", { url_prefix: "/campus" });

const PLACEMENT_TABS = ["drives", "applications"];

bp.route("/circulars", login_required(function circulars() {
  const q = request.args.get("q", "").trim().slice(0, 100);
  let category = request.args.get("category", "");
  if (!data.CATEGORIES.includes(category)) category = "";
  return render_page("portal/campus/circulars.html", "circular", {
    circulars: data.list_circulars(q, category), categories: data.CATEGORIES, q, category });
}));

bp.route("/circulars/<int:circular_id>", login_required(function circular({ circular_id }) {
  const item = data.get_circular(circular_id);
  if (item === null) abort(404);
  const paragraphs = item.body.split(/\r\n|\r|\n/).map((p) => p.trim()).filter(Boolean);
  return render_page("portal/campus/circular.html", "circular", { circular: item, paragraphs });
}));

bp.route("/placement", login_required(function placement() {
  let tab = request.args.get("tab", "drives");
  if (!PLACEMENT_TABS.includes(tab)) tab = "drives";
  const drives = data.list_drives(g.student.id).map((d) => ({ ...d, days_left: _days_until(d.apply_by) }));
  const applications = data.student_applications(g.student.id);
  return render_page("portal/campus/placement.html", "placement", { tab, drives, applications,
    stats: data.placement_stats(), statuses: data.APPLICATION_STATUSES });
}));

bp.route("/placement/<int:drive_id>/apply", { methods: ["POST"] }, login_required(function apply({ drive_id }) {
  try {
    const drive = data.apply(g.student.id, drive_id);
    flash(`Applied to ${drive.company} (${drive.role}).`, "success");
  } catch (e) {
    if (!(e instanceof ValueError)) throw e;
    flash(e.message, "error");
  }
  return redirect(_back("drives"));
}));

bp.route("/placement/<int:drive_id>/withdraw", { methods: ["POST"] }, login_required(function withdraw({ drive_id }) {
  try {
    const drive = data.withdraw(g.student.id, drive_id);
    flash(`Your application to ${drive.company} was withdrawn.`, "info");
  } catch (e) {
    if (!(e instanceof ValueError)) throw e;
    flash(e.message, "error");
  }
  return redirect(_back("drives"));
}));

function _days_until(iso) {
  try {
    return PyDate.fromisoformat(iso).minus(PyDate.today());
  } catch {
    return null;
  }
}

/** Return to the tab the form was submitted from. */
function _back(default_tab) {
  const tab = request.form.get("tab", default_tab);
  return url_for("campus.placement", { tab: PLACEMENT_TABS.includes(tab) ? tab : default_tab });
}
