// A very small Flask look-alike that runs in the browser, so the route code
// in admin.js / portal.js reads like admin_app.py / app.py.
//
// Requests are handled one at a time, so `request`, `session` and `g` are
// module-level "context locals" exactly as in Flask.
import { SafeString } from "./jinja.js";

export let request = null;
export let session = null;
export let g = {};
let currentApp = null;
let env = null;

export function setTemplateEnv(e) {
  env = e;
  // Globals (not context) so macros pulled in with {% from ... import %} see them, as in Flask.
  env.addGlobal("url_for", (endpoint, kw = {}) => {
    const { __keywords, ...args } = kw || {};
    return url_for(endpoint, args);
  });
  env.addGlobal("get_flashed_messages", (kw = {}) => getFlashedMessages(kw));
  env.addGlobal("csrf_token", () => "");
  // Stand-in for Jinja's url_for(endpoint, **{name: value}).
  env.addGlobal("kw", (name, value) => ({ [name]: value }));
}

// ---- Errors and responses ---------------------------------------------------

const DESCRIPTIONS = {
  400: "The browser (or proxy) sent a request that this server could not understand.",
  404: "The requested URL was not found on the server.",
  413: "The data value transmitted exceeds the capacity limit.",
};
const NAMES = { 400: "Bad Request", 404: "Not Found", 413: "Request Entity Too Large", 500: "Internal Server Error" };

export class HttpError extends Error {
  constructor(code, description) {
    super(description || DESCRIPTIONS[code] || "");
    this.code = code;
    this.name = NAMES[code] || "Error";
    this.description = description || DESCRIPTIONS[code] || "";
  }
}

export function abort(code, description) { throw new HttpError(code, description); }

export function redirect(url) { return { redirect: url }; }

/** Hand the browser a file to save (used by the backup export). */
export function sendDownload(filename, blob) { return { download: { filename, blob } }; }

// ---- Request data -------------------------------------------------------------

/** werkzeug MultiDict: get(key, default) and getlist(key). */
export class MultiDict {
  constructor(pairs = []) { this.pairs = pairs; }
  get(key, dflt = null) {
    const hit = this.pairs.find(([k]) => k === key);
    return hit === undefined ? dflt : hit[1];
  }
  getlist(key) { return this.pairs.filter(([k]) => k === key).map(([, v]) => v); }
  has(key) { return this.pairs.some(([k]) => k === key); }
}

// ---- Session (persisted per app in localStorage, like a cookie) ---------------

class Session {
  constructor(key) {
    this.key = key;
    try { this.data = JSON.parse(localStorage.getItem(key) || "{}"); } catch { this.data = {}; }
  }
  _save() { try { localStorage.setItem(this.key, JSON.stringify(this.data)); } catch { /* storage off */ } }
  get(k, dflt = null) { return k in this.data ? this.data[k] : dflt; }
  set(k, v) { this.data[k] = v; this._save(); }
  pop(k, dflt = null) { const v = this.get(k, dflt); delete this.data[k]; this._save(); return v; }
  has(k) { return k in this.data; }
  clear() { this.data = {}; this._save(); }
}

// ---- Flash messages (sessionStorage, consumed on the next render) -------------

export function flash(message, category = "message") {
  const key = currentApp.flashKey;
  const list = JSON.parse(sessionStorage.getItem(key) || "[]");
  list.push([category, message]);
  sessionStorage.setItem(key, JSON.stringify(list));
}

function getFlashedMessages(opts = {}) {
  const key = currentApp.flashKey;
  const list = JSON.parse(sessionStorage.getItem(key) || "[]");
  sessionStorage.removeItem(key);
  const withCategories = opts.with_categories ?? false;
  return withCategories ? list : list.map(([, m]) => m);
}

// ---- Routing --------------------------------------------------------------------

function compile(pattern) {
  const names = [], conv = [];
  const re = pattern.replace(/<(?:(int|string|path):)?([a-z_]+)>/g, (_, type = "string", name) => {
    names.push(name); conv.push(type);
    return type === "int" ? "(\\d+)" : type === "path" ? "(.+)" : "([^/]+)";
  });
  return { regex: new RegExp(`^${re}$`), names, conv };
}

export class Blueprint {
  constructor(name, { url_prefix = "" } = {}) {
    this.name = name;
    this.url_prefix = url_prefix;
    this.routes = [];
    this.filters = {};
  }
  route(pattern, opts, handler) {
    if (typeof opts === "function") { handler = opts; opts = {}; }
    this.routes.push({ pattern, opts, handler });
    return handler;
  }
  /** Jinja filter available to every template (Flask's app_template_filter). */
  app_template_filter(name, fn) { this.filters[name] = fn; return fn; }
}

export class App {
  /** prefix: where the app is mounted, e.g. "/admin" ("" for the site root) */
  constructor(name, { prefix, sessionKey }) {
    this.name = name;
    this.prefix = prefix;
    this.sessionKey = sessionKey;
    this.flashKey = `${sessionKey}.flashes`;
    this.routes = [];
    this.endpoints = {};
    this.before = [];
    this.contextProcessors = [];
    this.errorHandlers = {};
    this.assets = {};
    this.filters = {};
  }

  template_filter(name, fn) { this.filters[name] = fn; return fn; }

  route(pattern, opts, handler) {
    if (typeof opts === "function") { handler = opts; opts = {}; }
    this._add(pattern, opts.endpoint || handler.name, opts.methods || ["GET"], handler);
    return handler;
  }

  _add(pattern, endpoint, methods, handler) {
    const r = { pattern, endpoint, methods, handler, ...compile(pattern) };
    this.routes.push(r);
    this.endpoints[endpoint] ??= [];
    this.endpoints[endpoint].push(r);
  }

  register_blueprint(bp) {
    Object.assign(this.filters, bp.filters);
    for (const { pattern, opts, handler } of bp.routes) {
      this._add(bp.url_prefix + pattern, `${bp.name}.${opts.endpoint || handler.name}`,
        opts.methods || ["GET"], handler);
    }
  }

  before_request(fn) { this.before.push(fn); return fn; }
  context_processor(fn) { this.contextProcessors.push(fn); return fn; }
  errorhandler(code, fn) { this.errorHandlers[code] = fn; return fn; }

  /** URLs that point at in-browser data (photos), resolved without a route. */
  asset(endpoint, fn) { this.assets[endpoint] = fn; }

  view_functions_has(endpoint) { return endpoint in this.endpoints || endpoint in this.assets; }

  url_for(endpoint, args = {}) {
    if (endpoint === "static") return `/static/${args.filename}`;
    if (endpoint.startsWith(".") && request?.blueprint) endpoint = request.blueprint + endpoint;
    if (endpoint in this.assets) return this.assets[endpoint](args);
    const candidates = this.endpoints[endpoint];
    if (!candidates) throw new Error(`Could not build url for endpoint '${endpoint}'`);
    const { _anchor, ...rest } = args;
    for (const r of candidates) {
      if (!r.names.every((n) => rest[n] !== undefined && rest[n] !== null)) continue;
      let path = r.pattern.replace(/<(?:[a-z]+:)?([a-z_]+)>/g, (_, n) => encodeURIComponent(rest[n]));
      const query = Object.entries(rest).filter(([k, v]) => !r.names.includes(k) && v !== null && v !== undefined);
      if (query.length) path += "?" + new URLSearchParams(query.map(([k, v]) => [k, String(v)])).toString();
      return `${this.prefix}${path}${_anchor ? "#" + _anchor : ""}`;
    }
    throw new Error(`Could not build url for endpoint '${endpoint}' with values ${Object.keys(rest)}`);
  }

  match(path, method) {
    let methodMismatch = false;
    for (const r of this.routes) {
      const m = r.regex.exec(path);
      if (!m) continue;
      if (!r.methods.includes(method)) { methodMismatch = true; continue; }
      const params = {};
      r.names.forEach((n, i) => { params[n] = r.conv[i] === "int" ? parseInt(m[i + 1], 10) : decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    if (methodMismatch) throw new HttpError(405, "The method is not allowed for the requested URL.");
    throw new HttpError(404);
  }

  /** Run one request. Returns { html, status } | { redirect } | { download }. */
  async dispatch({ method, path, query, form, files }) {
    currentApp = this;
    session = new Session(this.sessionKey);
    g = {};
    request = { method, path, full_path: path + (query.toString() ? "?" + query : ""),
      args: new MultiDict([...query.entries()]), form: new MultiDict(form), files: new MultiDict(files),
      blueprint: null, endpoint: null };
    try {
      const { route, params } = this.match(path, method);
      request.endpoint = route.endpoint;
      request.blueprint = route.endpoint.includes(".") ? route.endpoint.split(".")[0] : null;
      for (const fn of this.before) {
        const early = await fn();
        if (early) return normalize(early);
      }
      return normalize(await route.handler(params));
    } catch (err) {
      if (!(err instanceof HttpError)) {
        console.error(err);
        err = new HttpError(500, String(err && err.message || err));
      }
      const handler = this.errorHandlers[err.code] || this.errorHandlers.default;
      if (handler) {
        try {
          return normalize(await handler(err));
        } catch (inner) {
          console.error(inner);  // the error page itself failed; fall through to plain HTML
        }
      }
      const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
      return { html: `<!doctype html><title>${err.code} ${esc(err.name)}</title><h1>${err.code} ${esc(err.name)}</h1><p>${esc(err.description)}</p>`, status: err.code };
    }
  }
}

function normalize(result) {
  if (typeof result === "string" || result instanceof SafeString) return { html: String(result), status: 200 };
  if (Array.isArray(result)) return { html: String(result[0]), status: result[1] };
  return result;
}

// ---- Templates ------------------------------------------------------------------

export function url_for(endpoint, args = {}) {
  return currentApp.url_for(endpoint, args);
}

export function render_template(name, context = {}) {
  const ctx = {};
  for (const fn of currentApp.contextProcessors) Object.assign(ctx, fn());
  Object.assign(ctx, context, {
    request,
    session: session.data,
    g,
  });
  return env.render(name, ctx);
}
