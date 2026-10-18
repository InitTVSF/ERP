/* Maps URLs to the three apps and runs one request through them:
 *   /admin/...  admin console      /about  project page      everything else  student portal
 * Shared by the browser (main.js) and the Node tests (tests/check.mjs). */
import { createEnv } from "./lib/jinja.js";
import { App, render_template, setTemplateEnv } from "./lib/flask.js";
import * as db from "./erp/db.js";
import { app as admin } from "./admin.js";
import { app as portal } from "./portal.js";

// ---- About page (how the demo works, visit counter) ---------------------------

export const home = new App("home", { prefix: "/about", sessionKey: "erp.home" });
home.context_processor(() => ({
  PORTAL_NAME: db.PORTAL_NAME,
  INSTITUTION_NAME: db.INSTITUTION_NAME,
  demo_admin: [db.ADMIN_USER, db.ADMIN_PASSWORD],
}));
home.route("/", function index() {
  return render_template("landing.html");
});

const MOUNTS = [["/admin", admin], ["/about", home]];

export function pickApp(path) {
  for (const [prefix, app] of MOUNTS) {
    if (path === prefix || path.startsWith(prefix + "/")) return [app, path.slice(prefix.length) || "/"];
  }
  return [portal, path];
}

/** "/admin/notices?x=1#holidays" -> { path, query, anchor } */
export function parseTarget(target) {
  let t = String(target || "").replace(/^#/, "");
  let anchor = "";
  const h = t.indexOf("#");
  if (h !== -1) { anchor = t.slice(h + 1); t = t.slice(0, h); }
  const q = t.indexOf("?");
  const path = (q === -1 ? t : t.slice(0, q)) || "/";
  const query = new URLSearchParams(q === -1 ? "" : t.slice(q + 1));
  return { path: path.startsWith("/") ? path : "/" + path, query, anchor };
}

/** Build the template environment over {name: source}. */
export function setupTemplates(sources) {
  const env = createEnv(sources);
  for (const app of [home, admin, portal]) {
    for (const [name, fn] of Object.entries(app.filters)) env.addFilter(name, fn);
  }
  setTemplateEnv(env);
}

/** Handle one request: { result, anchor }. Reloads/saves the database around it. */
export async function dispatch(method, target, form = [], files = []) {
  const { path, query, anchor } = parseTarget(target);
  await db.syncIfStale();
  const [app, subpath] = pickApp(path);
  const result = await app.dispatch({ method, path: subpath, query, form, files });
  await db.persist();
  return { result, anchor };
}
