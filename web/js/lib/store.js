// Persists the SQLite database file (a Uint8Array) in IndexedDB.
// Falls back to memory where IndexedDB is unavailable (private mode, tests),
// so the app still works for the current visit.

const DB_NAME = "campus-erp";
const STORE = "files";
const memory = new Map();

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore(mode, fn) {
  const idb = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = idb.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    idb.close();
  }
}

export const persistent = typeof indexedDB !== "undefined";

export async function load(key) {
  if (!persistent) return memory.get(key) ?? null;
  try {
    return (await withStore("readonly", (s) => s.get(key))) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

export async function save(key, bytes) {
  memory.set(key, bytes);
  if (!persistent) return;
  try {
    await withStore("readwrite", (s) => s.put(bytes, key));
  } catch (e) {
    console.warn("Could not save to IndexedDB; changes last only for this visit.", e);
  }
}

export async function remove(key) {
  memory.delete(key);
  if (!persistent) return;
  try { await withStore("readwrite", (s) => s.delete(key)); } catch { /* ignore */ }
}
