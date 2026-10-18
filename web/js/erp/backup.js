/* Export / import of this browser's whole database as a JSON file.
 *
 * Everything lives in the visitor's browser, so clearing site data deletes
 * it. A backup file lets them keep a copy or move it to another device.
 *
 * Format: { format, version, exported_at, tables: { name: { columns, rows } } }
 * BLOB values (photos) are stored as { "$base64": "..." }.
 */
import * as db from "./db.js";
import { nowISO } from "../lib/py.js";
import { persistent } from "../lib/store.js";

export { persistent };

const FORMAT = "campus-erp-backup";
const VERSION = 1;
const MAX_IMPORT_BYTES = 50 * 1024 * 1024;

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text) {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Row counts per table, for the backup page. */
export function summary() {
  const tables = db.dumpTables();
  return Object.entries(tables)
    .filter(([name]) => name !== "admins")
    .map(([name, t]) => ({ name, rows: t.rows.length }));
}

export function exportBlob() {
  const tables = db.dumpTables();
  for (const t of Object.values(tables)) {
    t.rows = t.rows.map((row) => row.map((v) => (v instanceof Uint8Array ? { $base64: toBase64(v) } : v)));
  }
  const payload = { format: FORMAT, version: VERSION, exported_at: nowISO(), tables };
  const stamp = nowISO().slice(0, 16).replace(/[-:T]/g, "");
  return {
    filename: `campus-erp-backup-${stamp}.json`,
    blob: new Blob([JSON.stringify(payload)], { type: "application/json" }),
  };
}

/** Replace all data with the backup in `file`. Returns the number of rows loaded.
 * Throws db.ValueError with a user-facing message if the file is not a valid backup. */
export async function importFile(file) {
  if (file.size > MAX_IMPORT_BYTES) throw new db.ValueError("That file is too large to be a backup.");
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch {
    throw new db.ValueError("That file is not a valid backup (it isn't JSON).");
  }
  if (!payload || payload.format !== FORMAT || typeof payload.tables !== "object") {
    throw new db.ValueError("That file is not a Campus ERP backup.");
  }
  if (payload.version > VERSION) {
    throw new db.ValueError("That backup was made by a newer version of this site.");
  }

  let count = 0;
  try {
    await db.replaceWith(() => {
      const conn = db.connect();
      for (const [name, table] of Object.entries(payload.tables)) {
        // Only tables this version knows about, and only their known columns.
        const known = db.tableColumns(name);
        if (!known.length || !Array.isArray(table.columns) || !Array.isArray(table.rows)) continue;
        const keep = table.columns.map((c, i) => [c, i]).filter(([c]) => known.includes(c));
        if (!keep.length) continue;
        conn.execute(`DELETE FROM "${name}"`);
        const sql = `INSERT INTO "${name}" (${keep.map(([c]) => `"${c}"`).join(", ")})` +
          ` VALUES (${keep.map(() => "?").join(", ")})`;
        for (const row of table.rows) {
          conn.execute(sql, keep.map(([, i]) => {
            const v = row[i];
            return v && typeof v === "object" && "$base64" in v ? fromBase64(v.$base64) : v;
          }));
          count++;
        }
      }
      const fk = conn.execute("PRAGMA foreign_key_check").fetchall();
      if (fk.length) throw new db.ValueError("That backup is inconsistent (records point at missing data).");
    });
  } catch (e) {
    if (e instanceof db.ValueError) throw e;
    throw new db.ValueError(`That backup could not be loaded: ${e.message}`);
  }
  return count;
}
