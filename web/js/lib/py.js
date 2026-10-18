// Small Python-compatible helpers, so the ported code behaves like the Flask
// version: round(), "%" formatting, date/strftime, random.Random(seed).

// ---- Numbers ---------------------------------------------------------------

/** Python round(x, n): exact decimal rounding, ties to even. */
export function pyRound(x, n = 0) {
  if (x === null || x === undefined || !Number.isFinite(x)) return x;
  const ax = Math.abs(x);
  // toFixed rounds the exact binary value, like Python, except on exact ties,
  // where it goes up and Python goes to the even digit.
  const exact = ax.toFixed(Math.min(n + 30, 100));
  const dot = exact.indexOf(".");
  const head = n > 0 ? exact.slice(0, dot + 1 + n) : exact.slice(0, dot);
  const tail = exact.slice(dot + 1 + n);
  let s = ax.toFixed(n);
  if (/^50*$/.test(tail) && Number(head.slice(-1)) % 2 === 0) s = head;
  const v = Number(s) * Math.sign(x);
  return Object.is(v, -0) ? 0 : v;
}

/** Python "fmt % args" for the conversions the templates use (s d i f g x %). */
export function pyFormat(fmt, args) {
  if (!Array.isArray(args)) args = [args];
  let i = 0;
  return String(fmt).replace(/%([-+ 0#]*)(\d+)?(?:\.(\d+))?([sdifgx%])/g, (m, flags, width, prec, conv) => {
    if (conv === "%") return "%";
    const v = args[i++];
    let s;
    switch (conv) {
      case "s": s = pyStr(v); break;
      case "d": case "i": s = String(Math.trunc(Number(v))); break;
      case "f": {
        const p = prec === undefined ? 6 : Number(prec);
        s = pyRound(Number(v), p).toFixed(p);
        break;
      }
      case "x": s = Math.trunc(Number(v)).toString(16); break;
      case "g": {
        const p = prec === undefined ? 6 : Math.max(Number(prec), 1);
        s = String(Number(Number(v).toPrecision(p)));
        break;
      }
    }
    if (flags.includes("+") && conv !== "s" && Number(v) >= 0) s = "+" + s;
    if (width && s.length < Number(width)) {
      const pad = Number(width) - s.length;
      if (flags.includes("-")) s = s + " ".repeat(pad);
      else if (flags.includes("0") && conv !== "s") {
        const neg = s[0] === "-" || s[0] === "+";
        s = neg ? s[0] + "0".repeat(pad) + s.slice(1) : "0".repeat(pad) + s;
      } else s = " ".repeat(pad) + s;
    }
    return s;
  });
}

export function pyStr(v) {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

/** Python truthiness: empty strings, lists and dicts are false. */
export function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map || v instanceof Set) return v.size > 0;
  if (v && typeof v === "object" && v.constructor === Object) return Object.keys(v).length > 0;
  return !!v;
}

// ---- Dates (local time, like Python's date.today()) -------------------------

const pad2 = (n) => String(n).padStart(2, "0");
const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August",
  "September", "October", "November", "December"];

/** A calendar date with the bits of Python's `date` the code relies on. */
export class PyDate {
  constructor(y, m, d) {
    const t = new Date(y, m - 1, d);
    this.year = t.getFullYear();
    this.month = t.getMonth() + 1;
    this.day = t.getDate();
  }
  static today() {
    const t = new Date();
    return new PyDate(t.getFullYear(), t.getMonth() + 1, t.getDate());
  }
  /** Raises Error on bad input, like date.fromisoformat. */
  static fromisoformat(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? "").trim());
    if (!m) throw new Error(`Invalid isoformat string: '${s}'`);
    const d = new PyDate(+m[1], +m[2], +m[3]);
    if (d.month !== +m[2] || d.day !== +m[3]) throw new Error(`Invalid date: '${s}'`);
    return d;
  }
  addDays(n) { return new PyDate(this.year, this.month, this.day + n); }
  /** Monday = 0 ... Sunday = 6 */
  weekday() { return (new Date(this.year, this.month - 1, this.day).getDay() + 6) % 7; }
  isoformat() { return `${this.year}-${pad2(this.month)}-${pad2(this.day)}`; }
  toString() { return this.isoformat(); }
  valueOf() { return this.isoformat(); }
  strftime(fmt) { return strftime(fmt, this.year, this.month, this.day, 0, 0, 0, this.weekday()); }
  compare(other) { return this.isoformat() < other.isoformat() ? -1 : this.isoformat() > other.isoformat() ? 1 : 0; }
  /** Days from `other` to this date. */
  minus(other) {
    return Math.round((Date.UTC(this.year, this.month - 1, this.day) -
      Date.UTC(other.year, other.month - 1, other.day)) / 86400000);
  }
}

/** A local date-time with Python datetime's isoformat/strftime. */
export class PyDateTime {
  constructor(d = new Date()) { this.d = d; }
  static now() { return new PyDateTime(new Date()); }
  static fromisoformat(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s ?? ""));
    if (!m) throw new Error(`Invalid isoformat string: '${s}'`);
    return new PyDateTime(new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)));
  }
  get year() { return this.d.getFullYear(); }
  get month() { return this.d.getMonth() + 1; }
  get day() { return this.d.getDate(); }
  get hour() { return this.d.getHours(); }
  get minute() { return this.d.getMinutes(); }
  date() { return new PyDate(this.year, this.month, this.day); }
  weekday() { return (this.d.getDay() + 6) % 7; }
  addDays(n) { const t = new Date(this.d); t.setDate(t.getDate() + n); return new PyDateTime(t); }
  addMinutes(n) { return new PyDateTime(new Date(this.d.getTime() + n * 60000)); }
  isoformat() {
    return `${this.date().isoformat()}T${pad2(this.hour)}:${pad2(this.minute)}:${pad2(this.d.getSeconds())}`;
  }
  toString() { return this.isoformat().replace("T", " "); }
  strftime(fmt) {
    return strftime(fmt, this.year, this.month, this.day, this.hour, this.minute, this.d.getSeconds(), this.weekday());
  }
}

function strftime(fmt, y, mo, d, h, mi, s, wd) {
  return fmt.replace(/%([aAbBdmYyHIMSpj%])/g, (_, c) => {
    switch (c) {
      case "a": return DAYS[wd].slice(0, 3);
      case "A": return DAYS[wd];
      case "b": return MONTHS[mo - 1].slice(0, 3);
      case "B": return MONTHS[mo - 1];
      case "d": return pad2(d);
      case "m": return pad2(mo);
      case "Y": return String(y);
      case "y": return pad2(y % 100);
      case "H": return pad2(h);
      case "I": return pad2(h % 12 || 12);
      case "M": return pad2(mi);
      case "S": return pad2(s);
      case "p": return h < 12 ? "AM" : "PM";
      case "j": {
        const n = Math.round((Date.UTC(y, mo - 1, d) - Date.UTC(y, 0, 1)) / 86400000) + 1;
        return String(n).padStart(3, "0");
      }
      default: return "%";
    }
  });
}

/** datetime.strptime(value, "%Y-%m-%d").date(): throws on bad input. */
export const parseISODate = (s) => PyDate.fromisoformat(s);
export const todayISO = () => PyDate.today().isoformat();
/** datetime.now().isoformat(timespec="seconds") */
export const nowISO = () => PyDateTime.now().isoformat();

// ---- Misc ---------------------------------------------------------------------

/** secrets.token_hex(n) */
export function tokenHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** " ".join(s.split()) */
export const collapseSpaces = (s) => String(s ?? "").split(/\s+/).filter(Boolean).join(" ");

/** int(value) that returns null instead of raising. */
export function toInt(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return /^[-+]?\d+$/.test(s) ? parseInt(s, 10) : null;
}

// ---- random.Random(seed): MT19937, identical sequence to CPython ------------

export class PyRandom {
  constructor(seed) {
    this.mt = new Uint32Array(624);
    this.idx = 625;
    this.gaussNext = null;
    this.seed(seed);
  }

  seed(n) {
    // CPython seeds ints via init_by_array with the 32-bit words of abs(n).
    let a = BigInt(Math.abs(Math.trunc(n)));
    const key = [];
    do { key.push(Number(a & 0xffffffffn)); a >>= 32n; } while (a > 0n);
    this._initGenrand(19650218);
    const mt = this.mt;
    let i = 1, j = 0;
    for (let k = Math.max(624, key.length); k; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(prev, 1664525)) + key[j] + j) >>> 0;
      i++; j++;
      if (i >= 624) { mt[0] = mt[623]; i = 1; }
      if (j >= key.length) j = 0;
    }
    for (let k = 623; k; k--) {
      const prev = mt[i - 1] ^ (mt[i - 1] >>> 30);
      mt[i] = ((mt[i] ^ Math.imul(prev, 1566083941)) - i) >>> 0;
      i++;
      if (i >= 624) { mt[0] = mt[623]; i = 1; }
    }
    mt[0] = 0x80000000;
    this.idx = 624;
    this.gaussNext = null;
  }

  _initGenrand(s) {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < 624; i++) {
      mt[i] = (Math.imul(1812433253, mt[i - 1] ^ (mt[i - 1] >>> 30)) + i) >>> 0;
    }
    this.idx = 624;
  }

  _uint32() {
    const mt = this.mt;
    if (this.idx >= 624) {
      for (let k = 0; k < 624; k++) {
        const y = (mt[k] & 0x80000000) | (mt[(k + 1) % 624] & 0x7fffffff);
        mt[k] = mt[(k + 397) % 624] ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      this.idx = 0;
    }
    let y = mt[this.idx++];
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  random() {
    const a = this._uint32() >>> 5, b = this._uint32() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }

  uniform(a, b) { return a + (b - a) * this.random(); }

  gauss(mu = 0, sigma = 1) {
    let z = this.gaussNext;
    this.gaussNext = null;
    if (z === null) {
      const x2pi = this.random() * 2 * Math.PI;
      const g2rad = Math.sqrt(-2.0 * Math.log(1.0 - this.random()));
      z = Math.cos(x2pi) * g2rad;
      this.gaussNext = Math.sin(x2pi) * g2rad;
    }
    return mu + z * sigma;
  }
}
