/* "N visitors so far" on the landing page, via the free Abacus counter API
 * (https://abacus.jasoncameron.dev). Just for fun:
 *  - each browser is counted once (remembered in localStorage);
 *  - local testing (localhost) only reads the number, never adds to it;
 *  - if the service is down, the counter simply stays hidden.
 * Change NAMESPACE to start your own count.
 */
const API = "https://abacus.jasoncameron.dev";
const NAMESPACE = "campus-erp-static-demo";
const KEY = "visits";
const SEEN = "erp.counted";

let cached = null;

function isLocal() {
  return ["localhost", "127.0.0.1", "", "[::1]"].includes(location.hostname);
}

async function fetchCount() {
  if (cached !== null) return cached;
  let seen = false;
  try { seen = localStorage.getItem(SEEN) === "1"; } catch { /* storage off */ }
  const action = seen || isLocal() ? "get" : "hit";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${API}/${action}/${NAMESPACE}/${KEY}`, { signal: ctrl.signal });
    if (!res.ok) return null;
    const { value } = await res.json();
    if (action === "hit") { try { localStorage.setItem(SEEN, "1"); } catch { /* ignore */ } }
    cached = Number.isFinite(value) ? value : null;
    return cached;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Fill in any [data-visit-counter] element on the page. */
export async function updateVisitCounter(root) {
  const el = root.querySelector("[data-visit-counter]");
  if (!el) return;
  const n = await fetchCount();
  if (n === null || !el.isConnected) return;
  el.querySelector(".n").textContent = n.toLocaleString("en-IN");
  el.hidden = false;
}
