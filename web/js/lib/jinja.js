// Nunjucks configured to behave like the Jinja2 the Flask templates were
// written for. Differences patched here:
//  - Python truthiness: [] and {} are false in `if`, `not`, `and`, `or`.
//  - `'%.1f' % x` string formatting.
//  - Jinja filters/tests Nunjucks lacks or implements differently.
import { pyFormat, pyRound, truthy, PyDate } from "./py.js";

const nunjucks = globalThis.nunjucks;
const N = nunjucks.nodes;

// ---- AST rewrite: route conditions and `%` through Python semantics ----------

function call(node, name, args) {
  const list = new N.NodeList(node.lineno, node.colno, args);
  return new N.FunCall(node.lineno, node.colno, new N.Symbol(node.lineno, node.colno, name), list);
}

function rewrite(node) {
  if (!(node instanceof N.Node)) return node;
  if (node instanceof N.Group && node.children.length > 1) {
    // Python tuple ('a', 'b'): Nunjucks would compile it to a JS comma expression.
    return new N.Array(node.lineno, node.colno, node.children.map(rewrite));
  }
  if (node instanceof N.NodeList) {
    node.children = node.children.map(rewrite);
    return node;
  }
  for (const field of node.fields) {
    const value = node[field];
    if (value instanceof N.Node) node[field] = rewrite(value);
    else if (Array.isArray(value)) node[field] = value.map(rewrite);
  }
  if (node instanceof N.If || node instanceof N.IfAsync || node instanceof N.InlineIf) {
    node.cond = call(node, "__truthy", [node.cond]);
  } else if (node instanceof N.Not) {
    return call(node, "__not", [node.target]);
  } else if (node instanceof N.Or) {
    return call(node, "__or", [node.left, node.right]);
  } else if (node instanceof N.And) {
    return call(node, "__and", [node.left, node.right]);
  } else if (node instanceof N.Mod) {
    return call(node, "__mod", [node.left, node.right]);
  }
  return node;
}

const originalParse = nunjucks.parser.parse;
nunjucks.parser.parse = function (src, extensions, opts) {
  return rewrite(originalParse.call(this, src, extensions, opts));
};

// ---- Template source fix-ups (Jinja-only syntax) -----------------------------

function preprocess(src) {
  return src
    // {% with x = y %}...{% endwith %} -> {% set %}; scoping isn't relied on.
    .replace(/\{%(-?)\s*with\s+([\s\S]*?)(-?)%\}/g, "{%$1 set $2 $3%}")
    .replace(/\{%-?\s*endwith\s*-?%\}/g, "")
    // Python allows a trailing comma in list/tuple literals; Nunjucks doesn't.
    .replace(/\{[{%][\s\S]*?[}%]\}/g, (tag) => tag.replace(/,(\s*[\])])/g, "$1"));
}

// ---- Loader: templates are fetched once at startup into a map ---------------

const MapLoader = nunjucks.Loader.extend({
  init(sources) { this.sources = sources; },
  getSource(name) {
    if (!(name in this.sources)) return null;
    return { src: preprocess(this.sources[name]), path: name, noCache: false };
  },
});

// ---- Jinja-compatible filters and tests ---------------------------------------

function kwargs(args) {
  const last = args[args.length - 1];
  if (last && last.__keywords) {
    const { __keywords, ...rest } = last;
    return [args.slice(0, -1), rest];
  }
  return [args, {}];
}

function attr(obj, path) {
  return String(path).split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function testFn(env, name, args) {
  if (name === undefined) return truthy;
  const test = env.getTest(name);
  return (v) => test.call(env, v, ...args);
}

function itemsOf(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [...value];
  if (value[Symbol.iterator]) return [...value];
  return Object.keys(value);
}

function installFilters(env) {
  env.addFilter("tojson", (v) => new nunjucks.runtime.SafeString(
    JSON.stringify(v ?? null).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026")));
  env.addFilter("format", (fmt, ...args) => pyFormat(fmt, args));
  env.addFilter("round", (v, precision = 0, method = "common") => {
    const f = 10 ** precision;
    if (method === "floor") return Math.floor(v * f) / f;
    if (method === "ceil") return Math.ceil(v * f) / f;
    return pyRound(Number(v), precision);
  });
  env.addFilter("int", (v, d = 0) => { const n = parseInt(v, 10); return Number.isNaN(n) ? d : n; });
  env.addFilter("list", (v) => itemsOf(v));
  env.addFilter("first", (v) => itemsOf(v)[0]);
  env.addFilter("last", (v) => itemsOf(v).slice(-1)[0]);
  env.addFilter("sum", (v, ...rest) => {
    const [args, kw] = kwargs(rest);
    const attribute = kw.attribute ?? args[0];
    const start = kw.start ?? args[1] ?? 0;
    return itemsOf(v).reduce((acc, x) => acc + Number(attribute ? attr(x, attribute) : x), start);
  });
  env.addFilter("map", function (v, ...rest) {
    const [args, kw] = kwargs(rest);
    if (kw.attribute !== undefined) return itemsOf(v).map((x) => attr(x, kw.attribute) ?? kw.default);
    const [name, ...fargs] = args;
    const filter = env.getFilter(name);
    return itemsOf(v).map((x) => filter.call(this, x, ...fargs));
  });
  env.addFilter("select", (v, name, ...args) => itemsOf(v).filter(testFn(env, name, args)));
  env.addFilter("reject", (v, name, ...args) => itemsOf(v).filter((x) => !testFn(env, name, args)(x)));
  env.addFilter("selectattr", (v, a, name, ...args) =>
    itemsOf(v).filter((x) => testFn(env, name, args)(attr(x, a))));
  env.addFilter("rejectattr", (v, a, name, ...args) =>
    itemsOf(v).filter((x) => !testFn(env, name, args)(attr(x, a))));
  env.addFilter("join", (v, sep = "", attribute) =>
    itemsOf(v).map((x) => (attribute ? attr(x, attribute) : x)).map((x) => (x == null ? "" : x)).join(sep));
  env.addFilter("length", (v) => (v == null ? 0 : itemsOf(v).length));
  env.addFilter("count", (v) => (v == null ? 0 : itemsOf(v).length));
  env.addFilter("string", (v) => (v == null ? "None" : String(v)));

  // `x is none` compiles to Nunjucks's strict "null" test; a missing key (undefined) is None too.
  env.addTest("none", (v) => v === null || v === undefined);
  env.addTest("null", (v) => v === null || v === undefined);
  env.addTest("in", (v, seq) => nunjucks.runtime.inOperator(v, seq));
  env.addTest("true", (v) => v === true);
  env.addTest("false", (v) => v === false);
}

// ---- Python string methods and slicing ----------------------------------------

const PY_STR = {
  split: (s, sep, max = -1) => {
    if (sep == null) {
      const parts = s.trim().split(/\s+/).filter(Boolean);
      return max >= 0 && parts.length > max ? [...parts.slice(0, max), parts.slice(max).join(" ")] : parts;
    }
    const parts = s.split(sep);
    return max >= 0 && parts.length > max + 1 ? [...parts.slice(0, max), parts.slice(max).join(sep)] : parts;
  },
  strip: (s) => s.trim(),
  startswith: (s, p) => s.startsWith(p),
  endswith: (s, p) => s.endsWith(p),
  upper: (s) => s.toUpperCase(),
  lower: (s) => s.toLowerCase(),
  title: (s) => s.toLowerCase().replace(/(^|[^a-z])([a-z])/g, (m, a, b) => a + b.toUpperCase()),
  capitalize: (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(),
  replace: (s, a, b) => s.split(a).join(b),
  isdigit: (s) => /^\d+$/.test(s),
};

function patchMemberLookup() {
  const lookup = nunjucks.runtime.memberLookup;
  if (lookup.__py) return;
  const patched = function (obj, val, ...rest) {
    if (typeof obj === "string" || obj instanceof String) {
      const s = String(obj);
      if (rest.length) return lookup.call(this, [...s], val, ...rest).join("");  // s[a:b]
      if (typeof val === "string" && Object.hasOwn(PY_STR, val)) return (...a) => PY_STR[val](s, ...a);
    }
    // Python negative indexes: xs[-1]
    if (!rest.length && typeof val === "number" && val < 0 && obj != null &&
        (Array.isArray(obj) || typeof obj === "string")) {
      return obj[obj.length + val];
    }
    return lookup.call(this, obj, val, ...rest);
  };
  patched.__py = true;
  nunjucks.runtime.memberLookup = patched;
}

// ---- Environment ------------------------------------------------------------

/** Build an environment over {name: source} templates. */
export function createEnv(sources) {
  const env = new nunjucks.Environment(new MapLoader(sources), { autoescape: true });
  nunjucks.installJinjaCompat();
  patchMemberLookup();
  installFilters(env);
  env.addGlobal("__truthy", truthy);
  env.addGlobal("__not", (v) => !truthy(v));
  env.addGlobal("__or", (a, b) => (truthy(a) ? a : b));
  env.addGlobal("__and", (a, b) => (truthy(a) ? b : a));
  env.addGlobal("__mod", (a, b) => (typeof a === "string" || a instanceof String
    ? pyFormat(String(a), b) : ((a % b) + b) % b));
  env.addGlobal("dict", (obj) => ({ ...(obj || {}) }));
  env.addGlobal("PyDate", PyDate);
  return env;
}

export const SafeString = nunjucks.runtime.SafeString;
