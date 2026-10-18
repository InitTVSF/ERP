/* Browser entry point: plays the part Flask's server played.
 *
 * URLs look like the Flask app's: / (student login), /dashboard, /admin/students/new.
 * Links and forms are intercepted (History API) and handed to the matching
 * route as a "request". The route returns HTML, which replaces the current page.
 * The host serves index.html for every path that isn't a file (vercel.json).
 */
import { TEMPLATES } from "./templates.js";
import * as db from "./erp/db.js";
import { dispatch, setupTemplates } from "./router.js";
import { updateVisitCounter } from "./counter.js";

// ---- Request handling (one at a time, like a single-threaded server) ----------

let queue = Promise.resolve();
let shownUrl = null;
const here = () => location.pathname + location.search + location.hash;
const pathOf = (url) => url.split("#")[0];

function navigate(method, target, form = [], files = []) {
  queue = queue.then(() => handle(method, target, form, files)).catch((err) => {
    console.error(err);
    showFatal(err);
  });
  return queue;
}

async function handle(method, target, form, files) {
  const { result, anchor } = await dispatch(method, target, form, files);

  if (result.redirect) {
    go(result.redirect);
    return;
  }
  if (result.download) {
    saveFile(result.download.filename, result.download.blob);
    // Downloads don't change the page; put the address bar back.
    if (shownUrl !== null && here() !== shownUrl) history.replaceState(null, "", shownUrl);
    return;
  }
  await swapDocument(result.html);
  shownUrl = here();
  if (anchor && document.getElementById(anchor)) document.getElementById(anchor).scrollIntoView();
  else window.scrollTo(0, 0);
  updateVisitCounter(document);
}

/** Follow a redirect or link to an internal URL ("/admin/...", "/dashboard"). */
function go(url) {
  if (url !== here()) history.pushState(null, "", url);
  navigate("GET", url);
}

/** Paths served as files, never handled as app routes. */
const FILE_PREFIXES = ["/static/", "/vendor/", "/js/", "/templates/"];

function saveFile(filename, blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// ---- Swapping in a rendered page ------------------------------------------------

let pageListeners = [];

function headKey(el) {
  return el.outerHTML;
}

function loaded(link) {
  return new Promise((resolve) => {
    link.addEventListener("load", resolve, { once: true });
    link.addEventListener("error", resolve, { once: true });
    setTimeout(resolve, 2000);
  });
}

async function swapDocument(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  document.title = doc.title;

  // <head>: keep stylesheets already loaded, add new ones and wait for them
  // (no flash of unstyled content), drop ones this page doesn't use.
  const wanted = [...doc.head.querySelectorAll('link[rel="stylesheet"], link[rel="icon"], link[rel="preconnect"], style')];
  const wantedKeys = new Set(wanted.map(headKey));
  const current = [...document.head.querySelectorAll("[data-page]")];
  const currentKeys = new Set(current.map((el) => el.dataset.key));
  const pending = [];
  for (const el of wanted) {
    const key = headKey(el);
    if (currentKeys.has(key)) continue;
    const node = document.importNode(el, true);
    node.dataset.page = "";
    node.dataset.key = key;
    document.head.appendChild(node);
    if (node.rel === "stylesheet") pending.push(loaded(node));
  }
  await Promise.all(pending);
  for (const el of current) if (!wantedKeys.has(el.dataset.key)) el.remove();

  // Listeners added by the previous page's scripts would pile up otherwise.
  for (const [target, type, fn, opts] of pageListeners) target.removeEventListener(type, fn, opts);
  pageListeners = [];

  // <body>
  for (const { name } of [...document.body.attributes]) document.body.removeAttribute(name);
  for (const { name, value } of doc.body.attributes) document.body.setAttribute(name, value);
  document.body.innerHTML = doc.body.innerHTML;
  runScripts(document.body);
}

/** innerHTML doesn't run <script>s; re-create them so they do. */
function runScripts(root) {
  const targets = [document, window];
  for (const t of targets) {
    t.addEventListener = function (type, fn, opts) {
      pageListeners.push([t, type, fn, opts]);
      return EventTarget.prototype.addEventListener.call(t, type, fn, opts);
    };
  }
  try {
    for (const old of [...root.querySelectorAll("script")]) {
      const s = document.createElement("script");
      for (const { name, value } of old.attributes) s.setAttribute(name, value);
      s.textContent = old.textContent;
      old.replaceWith(s);
    }
  } finally {
    for (const t of targets) delete t.addEventListener;
  }
}

// ---- Links and forms --------------------------------------------------------------

function onClick(e) {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest("a[href]");
  if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
  const href = a.getAttribute("href");
  // Only same-site app paths; in-page anchors ("#main") and files keep their default behaviour.
  if (!href.startsWith("/") || href.startsWith("//") || FILE_PREFIXES.some((p) => href.startsWith(p))) return;
  e.preventDefault();
  go(href);
}

function onSubmit(e) {
  if (e.defaultPrevented) return;  // e.g. onsubmit="return confirm(...)" said no
  const form = e.target;
  e.preventDefault();
  const submitter = e.submitter || null;
  const method = (submitter?.getAttribute("formmethod") || form.getAttribute("method") || "get").toLowerCase();
  const action = submitter?.getAttribute("formaction") || form.getAttribute("action") || shownUrl || here();
  let fd;
  try { fd = new FormData(form, submitter); } catch { fd = new FormData(form); }
  if (submitter?.name && !fd.has(submitter.name)) fd.append(submitter.name, submitter.value);

  if (method === "get") {
    const qs = new URLSearchParams([...fd].filter(([, v]) => typeof v === "string"));
    go(action.split("?")[0].split("#")[0] + (qs.toString() ? "?" + qs : ""));
    return;
  }
  const fields = [], files = [];
  for (const [k, v] of fd) (typeof v === "string" ? fields : files).push([k, v]);
  navigate("POST", action, fields, files);
}

// form.submit() skips the submit event; route it through requestSubmit instead.
HTMLFormElement.prototype.submit = function () { this.requestSubmit(); };

// ---- Startup --------------------------------------------------------------------------

function showFatal(err) {
  document.body.innerHTML = `<main style="font:16px/1.5 system-ui;max-width:640px;margin:48px auto;padding:0 16px">
    <h1>Something went wrong</h1><p>The demo could not load. Try reloading the page.</p>
    <pre style="white-space:pre-wrap;background:#f3f3f3;padding:12px;border-radius:8px"></pre></main>`;
  document.querySelector("pre").textContent = String(err && (err.stack || err.message) || err);
}

async function loadTemplates() {
  const entries = await Promise.all(TEMPLATES.map(async (name) => {
    const res = await fetch(`/templates/${name}`);
    if (!res.ok) throw new Error(`Could not load template ${name} (${res.status})`);
    return [name, await res.text()];
  }));
  return Object.fromEntries(entries);
}

async function start() {
  const [sources] = await Promise.all([
    loadTemplates(),
    db.open({ locateFile: (file) => `/vendor/${file}` }),
  ]);
  setupTemplates(sources);

  document.addEventListener("click", onClick);
  document.addEventListener("submit", onSubmit);
  window.addEventListener("popstate", () => {
    // Only the #fragment changed (an in-page anchor): the browser already scrolled.
    if (shownUrl !== null && pathOf(here()) === pathOf(shownUrl)) { shownUrl = here(); return; }
    navigate("GET", here());
  });
  // Another tab changed the data: nothing to do now; the next navigation reloads it.

  // Links from the earlier hash-URL version (/#/admin/...) still work.
  if (location.hash.startsWith("#/")) history.replaceState(null, "", location.hash.slice(1));
  await navigate("GET", here());
}

start().catch((err) => {
  console.error(err);
  showFatal(err);
});
