// End-to-end test in a real (headless) Chrome, driven over the DevTools protocol.
//
//   node web/serve.mjs 8765
//   node web/tests/browser.mjs [path-to-chrome]
//
// Clicks through the main flow: / (student login) -> /admin -> add student ->
// portal login -> dashboard, plus theme script, confirm dialogs and persistence
// across a reload.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.ERP_URL || "http://127.0.0.1:8765/";
const CHROME = (process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null) || [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium",
].find((p) => fs.existsSync(p));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "erp-chrome-"));
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn(CHROME, [`--remote-debugging-port=${port}`, "--headless=new", `--user-data-dir=${profile}`,
  "--no-first-run", "--no-default-browser-check", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });

let failures = 0;
const check = (cond, msg) => { if (!cond) { failures++; console.error("  FAIL:", msg); } else console.log("  ok:", msg); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error("Chrome did not start");
}

const ws = new WebSocket(await target());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const pending = new Map();
const consoleErrors = [];
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === "Runtime.exceptionThrown") consoleErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
  if (msg.method === "Page.javascriptDialogOpening") send("Page.handleJavaScriptDialog", { accept: true });
});
function send(method, params = {}) {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve) => pending.set(id, resolve));
}
async function js(expr) {
  const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || "eval failed");
  return r.result?.result?.value;
}
async function waitFor(expr, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await js(expr)) return true; } catch { /* page navigating */ }
    await sleep(100);
  }
  return false;
}
const text = () => js("document.body.innerText");
const url = () => js("location.pathname + location.search");
/** In-app navigation, as a link click would do. */
const visit = (p) => js(`history.pushState(null, "", ${JSON.stringify(p)}); dispatchEvent(new PopStateEvent("popstate")); true`);
const fill = (sel, value) => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(value)}; return true; })()`);
const submit = (sel) => js(`document.querySelector(${JSON.stringify(sel)}).requestSubmit()`);
const click = (sel) => js(`document.querySelector(${JSON.stringify(sel)}).click()`);

await send("Runtime.enable");
await send("Page.enable");

try {
  console.log("== entry points");
  await send("Page.navigate", { url: BASE });
  check(await waitFor("location.pathname === '/login' && !!document.querySelector('#user_id')"), "site root opens the student login");
  check(await js("[...document.images].some(i => i.src.endsWith('/static/portal/img/logo.png') && i.naturalWidth > 0)"), "real logo loads");
  await send("Page.navigate", { url: BASE + "admin" });
  check(await waitFor("location.pathname === '/admin/login' && !!document.querySelector('#username')"), "typing /admin opens the admin login");
  await visit("/about");
  check(await waitFor("document.body.classList.contains('landing')"), "/about page renders");
  await click('a[href="/admin"]');
  check(await waitFor("location.pathname === '/admin/login'"), "link from /about to /admin");

  console.log("== admin");
  await fill("#username", "admin");
  await fill("#password", "admin123");
  await submit("form.form");
  check(await waitFor("location.pathname === '/admin/' && document.body.innerText.includes('Total students')"), "admin signed in, dashboard shown");
  check((await text()).includes("Welcome back, admin."), "flash message shown");

  await visit("/admin/students/new");
  check(await waitFor("!!document.querySelector('#name')"), "add student form");
  await fill("#name", "Browser Test");
  await fill("#roll_no", "7777");
  await fill("#enrollment_no", "BT-7777");
  await fill("#password", "secret7");
  await submit("form.grid-form");
  check(await waitFor("document.body.innerText.includes('Student “Browser Test” was added.')"), "student added through the form");

  // Search uses a GET form -> query string in the hash
  await fill("#q", "BT-7777");
  await submit("form.search");
  check(await waitFor("location.search.includes('q=BT-7777')"), "search GET form updates the URL");

  // Delete with confirm(): dialog auto-accepted
  await visit("/admin/subjects");
  await waitFor("document.body.innerText.includes('TMA101')");
  const before = await js("document.querySelectorAll('tbody tr').length");
  await js("document.querySelector('form[action*=\"/delete\"] button').click()");
  check(await waitFor(`document.querySelectorAll('tbody tr').length === ${before - 1}`), "delete after confirm() dialog");

  console.log("== portal");
  await click('a[href="/login"]');
  check(await waitFor("!!document.querySelector('#user_id')"), "portal login page");
  await click("#pwToggle");
  check(await js("document.querySelector('#password').type === 'text'"), "inline page script runs (password toggle)");
  await fill("#user_id", "BT-7777");
  await fill("#password", "secret7");
  await submit("form");
  check(await waitFor("location.pathname === '/dashboard' && document.body.innerText.includes('Browser Test')"), "student created in admin signs in to portal");
  check(await js("/theme-(dark|light|blue)/.test(document.body.className)"), "theme script applied body class");
  await js("document.querySelector('.theme-chip[data-theme=\"light\"]').click()");
  check(await js("document.body.classList.contains('theme-light')"), "theme switcher works");

  console.log("== persistence");
  await send("Page.reload");
  check(await waitFor("document.body.innerText.includes('Browser Test')"), "still signed in with data after reload");

  console.log("== every portal page");
  const hrefs = await js(`[...new Set([...document.querySelectorAll("a[href^='/']")].map((a) => a.getAttribute("href"))
    .filter((h) => !["/admin", "/about", "/static"].some((p) => h.startsWith(p))))]`);
  for (const h of hrefs) {
    if (h.includes("logout")) continue;
    await visit(h);
    const ok = await waitFor(`location.pathname + location.search === ${JSON.stringify(h)} && !document.title.startsWith('Error') && document.querySelector('.main, main')`, 8000);
    check(ok, `renders ${h}`);
  }
  const shotsAt = process.argv.indexOf("--shots");
  if (shotsAt !== -1) {
    // Screenshots at phone width, for eyeballing the layout: --shots <dir>
    const dir = process.argv[shotsAt + 1];
    fs.mkdirSync(dir, { recursive: true });
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    for (const [name, h] of [["about", "/about"], ["portal-dashboard", "/dashboard"], ["portal-fee", "/fee/"],
      ["portal-exam", "/exam/"], ["admin-login", "/admin/login"]]) {
      await visit(h);
      await sleep(1200);
      const shot = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.from(shot.result.data, "base64"));
      const overflow = await js("document.documentElement.scrollWidth > window.innerWidth + 1");
      check(!overflow, `${name}: no horizontal scroll at 390px`);
    }
  }
} catch (e) {
  failures++;
  console.error(e);
} finally {
  check(consoleErrors.length === 0, `no console errors${consoleErrors.length ? ": " + consoleErrors.slice(0, 5).join(" | ") : ""}`);
  ws.close();
  chrome.kill();
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome still exiting */ } }, 1000);
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll browser checks passed");
process.exitCode = failures ? 1 : 0;
