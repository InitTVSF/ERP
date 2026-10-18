// Smoke tests for the static ERP, run in Node (no browser needed):
//
//   node web/tests/check.mjs            render every page, run the main flows
//   node web/tests/check.mjs --parity   also compare seeded numbers with the Flask version
//
// Exits non-zero on the first failure.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(WEB, "..");
const require = createRequire(import.meta.url);

// ---- Browser-ish globals ----------------------------------------------------------

class MemoryStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
globalThis.localStorage = new MemoryStorage();
globalThis.sessionStorage = new MemoryStorage();
globalThis.nunjucks = require(path.join(WEB, "vendor/nunjucks.min.js"));
globalThis.initSqlJs = require(path.join(WEB, "vendor/sql-wasm.js"));

const mod = (p) => import(pathToFileURL(path.join(WEB, p)).href);
const { TEMPLATES } = await mod("js/templates.js");
const db = await mod("js/erp/db.js");
const { setupTemplates, dispatch } = await mod("js/router.js");

// ---- Helpers -------------------------------------------------------------------------

let failures = 0;
function check(cond, msg) {
  if (cond) return;
  failures++;
  console.error("  FAIL:", msg);
}
function section(name) { console.log(`\n== ${name}`); }

async function request(method, url, form = {}, files = []) {
  const pairs = Object.entries(form).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, String(x)]) : [[k, String(v)]]));
  const { result } = await dispatch(method, url, pairs, files);
  return result;
}

/** GET (following redirects) and expect a 200 page. Returns the HTML. */
async function page(url, { status = 200, contains = [] } = {}) {
  let r = await request("GET", url);
  let hops = 0;
  while (r.redirect && hops++ < 5) r = await request("GET", r.redirect);
  check(!r.redirect, `${url}: too many redirects`);
  check(r.status === status, `${url}: status ${r.status}, expected ${status}` +
    (r.status >= 500 ? `\n${(r.html || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 400)}` : ""));
  for (const c of contains) check(r.html && r.html.includes(c), `${url}: missing "${c}"`);
  check(!/undefined|\[object Object\]|NaN/.test(textOf(r.html || "")), `${url}: page shows undefined/[object Object]/NaN: ` +
    (textOf(r.html || "").match(/.{0,60}(undefined|\[object Object\]|NaN).{0,60}/) || [""])[0]);
  return r.html || "";
}

function textOf(html) {
  return html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

async function post(url, form, files) {
  return request("POST", url, form, files);
}

/** All student-portal links on a page (not /admin, /about or files), without fragments. */
function links(html) {
  const out = new Set();
  for (const m of html.matchAll(/href="(\/[^"#]*)/g)) {
    const href = m[1].replace(/&amp;/g, "&");
    if (!/^\/(admin|about|static|vendor|js|templates)(\/|$)/.test(href) && !href.startsWith("//")) out.add(href);
  }
  return [...out];
}

// ---- Setup -----------------------------------------------------------------------------

section("templates");
const onDisk = fs.readdirSync(path.join(WEB, "templates"), { recursive: true })
  .map((f) => f.replace(/\\/g, "/")).filter((f) => f.endsWith(".html"));
for (const f of onDisk) check(TEMPLATES.includes(f), `templates/${f} is not listed in js/templates.js`);
for (const f of TEMPLATES) check(onDisk.includes(f), `js/templates.js lists missing file ${f}`);
const sources = Object.fromEntries(TEMPLATES.filter((f) => onDisk.includes(f))
  .map((f) => [f, fs.readFileSync(path.join(WEB, "templates", f), "utf8")]));
setupTemplates(sources);
await db.open({ locateFile: (f) => path.join(WEB, "vendor", f) });
console.log(`  ${TEMPLATES.length} templates, database seeded`);

// ---- Landing + admin -------------------------------------------------------------------

section("entry points");
let r = await request("GET", "/");
check(r.redirect === "/login", `the site root opens the student login (got ${JSON.stringify(r).slice(0, 120)})`);
await page("/", { contains: ["Welcome back", "logo.png"] });
r = await request("GET", "/admin");
check(r.redirect && r.redirect.startsWith("/admin/login"), "/admin opens the admin login");
await page("/about", { contains: ["Admin console", "Student portal"] });

section("admin: login");
r = await request("GET", "/admin/");
check(r.redirect && r.redirect.startsWith("/admin/login"), "admin dashboard should redirect to login");
await page("/admin/login", { contains: ["admin123"] });
r = await post("/admin/login", { username: "admin", password: "wrong" });
check(r.status === 200 && r.html.includes("Invalid username or password."), "wrong password rejected");
r = await post("/admin/login", { username: "admin", password: "admin123" });
check(r.redirect === "/admin/", `login redirects to dashboard (got ${JSON.stringify(r)})`);

section("admin: pages");
for (const url of ["/admin/", "/admin/?q=diya", "/admin/students/new", "/admin/subjects", "/admin/subjects/new",
  "/admin/attendance", "/admin/attendance?subject_id=1", "/admin/attendance/report",
  "/admin/attendance/report?by=subject", "/admin/notices", "/admin/backup", "/admin/students/1/edit",
  "/admin/subjects/1/edit"]) {
  await page(url);
}
await page("/admin/students/999/edit", { status: 404 });

section("admin: create student with photo");
const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
  "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");
r = await post("/admin/students/new", { name: "", roll_no: "", enrollment_no: "", password: "x" });
check(r.status === 200 && r.html.includes("Full Name is required."), "required-field errors shown");
r = await post("/admin/students/new", { name: "Test Student", roll_no: "9001", enrollment_no: "TS-9001",
  parent_name: "Parent", profile_no: "P-1", status: "Active", password: "secret1" },
[["photo", new File([png], "me.png", { type: "image/png" })]]);
check(r.redirect === "/admin/", `student created (got ${JSON.stringify(r).slice(0, 300)})`);
const created = db.list_students("TS-9001")[0];
check(created && created.photo.endsWith(".png"), "photo stored");
r = await post("/admin/students/new", { name: "Dup", roll_no: "9001", enrollment_no: "TS-9002", password: "secret1" });
check(r.html && r.html.includes("roll number already exists"), "duplicate roll number rejected");
r = await post("/admin/students/new", { name: "Bad photo", roll_no: "9003", enrollment_no: "TS-9003", password: "secret1" },
  [["photo", new File(["not an image"], "x.png")]]);
check(r.html && r.html.includes("Upload a JPG, PNG or WebP image."), "bad photo rejected");

section("admin: subjects, attendance, notices");
r = await post("/admin/subjects/new", { code: "tcs999", name: "  Test   Subject " });
check(r.redirect === "/admin/subjects", "subject created");
const subj = db.list_subjects("TCS999")[0];
check(subj && subj.name === "Test Subject", "subject code upper-cased, name collapsed");
const roster = db.list_students().filter((s) => s.status === "Active").map((s) => s.id);
r = await post("/admin/attendance", { subject_id: subj.id, date: "2026-01-05", roster, present: [created.id] });
check(r.redirect && r.redirect.includes("subject_id="), "attendance saved");
check(db.attendance_for(subj.id, "2026-01-05")[created.id] === true, "present mark stored");
r = await post("/admin/attendance", { subject_id: subj.id, date: "2999-01-01", roster });
check(r.status === 400, "future attendance rejected");
r = await post("/admin/notices/add", { date: "2026-10-01", title: "Test notice" });
check(r.redirect === "/admin/notices", "notice added");
r = await post("/admin/holidays/add", { date: "", title: "" });
check(r.status === 400, "empty holiday rejected");

section("admin: backup round trip");
r = await request("GET", "/admin/backup/export");
check(r.download && r.download.filename.endsWith(".json"), "export gives a .json download");
const backupText = await r.download.blob.text();
const before = db.list_students().length;
await post("/admin/students/" + created.id + "/delete", {});
check(db.list_students().length === before - 1, "student deleted");
r = await post("/admin/backup/import", {}, [["backup", new File([backupText], "b.json")]]);
check(r.redirect && r.redirect.includes("/admin/login"), "import signs out");
check(db.list_students().length === before, "import restored the student");
check(db.list_students("TS-9001")[0]?.photo === created.photo, "import restored the photo");
r = await post("/admin/backup/import", {}, [["backup", new File(["{}"], "b.json")]]);
await post("/admin/login", { username: "admin", password: "admin123" });
r = await post("/admin/backup/import", {}, [["backup", new File(['{"format":"nope"}'], "b.json")]]);
check(r.redirect && r.redirect.includes("/admin/backup"), "invalid backup refused");

// ---- Portal ------------------------------------------------------------------------------

section("portal: login");
r = await request("GET", "/dashboard");
check(r.redirect && r.redirect === "/login", "portal requires login");
await page("/login");
r = await post("/login", { user_id: "TS-9001", password: "nope" });
check(r.status === 401, "wrong student password rejected");
r = await post("/login", { user_id: "TS-9001", password: "secret1" });
check(r.redirect === "/dashboard", "student created in admin can log in");

section("portal: every linked page");
const dash = await page("/dashboard", { contains: ["Test Student"] });
const seen = new Set();
const queue = links(dash);
while (queue.length) {
  const url = queue.shift();
  if (seen.has(url) || url.includes("logout")) continue;
  seen.add(url);
  const html = await page(url);
  for (const l of links(html)) if (!seen.has(l)) queue.push(l);
}
console.log(`  ${seen.size} portal pages rendered`);

section("portal: sample student");
await post("/logout", {});
r = await post("/login", { user_id: "PV-25190001", password: "student123" });
check(r.redirect === "/dashboard", "sample student can log in");
const seen2 = new Set();
const queue2 = links(await page("/dashboard"));
while (queue2.length) {
  const url = queue2.shift();
  if (seen2.has(url) || url.includes("logout")) continue;
  seen2.add(url);
  const html = await page(url);
  for (const l of links(html)) if (!seen2.has(l)) queue2.push(l);
}
console.log(`  ${seen2.size} portal pages rendered`);

// ---- Parity with the Flask version (optional) ----------------------------------------------

if (process.argv.includes("--parity")) {
  section("parity with Flask (fresh databases)");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "erp-parity-"));
  const py = path.join(WEB, "tests", "parity_dump.py");
  const flask = JSON.parse(execFileSync("python", [py], { cwd: ROOT, env: { ...process.env, ERP_DB_PATH: path.join(tmp, "erp.db") } }).toString());
  await db.reset();
  const { dump } = await mod("tests/parity_dump.mjs");
  const ours = await dump(db);
  for (const key of Object.keys(flask)) {
    const a = JSON.stringify(flask[key]), b = JSON.stringify(ours[key]);
    check(a === b, `parity "${key}" differs\n    flask: ${a.slice(0, 300)}\n    ours:  ${String(b).slice(0, 300)}`);
    if (a === b) console.log(`  ${key}: same`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
