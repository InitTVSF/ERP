// Same dump as parity_dump.py, from the in-browser database.
const VOLATILE = new Set(["password_hash", "created_at", "photo", "txn_id"]);  // txn_id is random
const SKIP_TABLES = new Set(["sqlite_sequence", "photo_files"]);

export async function dump(db) {
  const conn = db.connect();
  const out = {};
  const tables = conn.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").fetchall();
  for (const { name } of tables) {
    if (SKIP_TABLES.has(name)) continue;
    const keep = db.tableColumns(name).filter((c) => !VOLATILE.has(c) && !c.endsWith("_at"));
    const rows = conn.execute(`SELECT ${keep.join(", ")} FROM "${name}" ORDER BY rowid`).fetchall();
    out[name] = rows.map((r) => keep.map((c) => r[c]));
  }
  return out;
}
