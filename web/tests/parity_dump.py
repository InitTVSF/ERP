"""Dump every table of a freshly seeded Flask database as JSON, for
check.mjs --parity. Run from the repo root with ERP_DB_PATH pointing at a
temporary file."""
import json
import os
import sys

sys.path.insert(0, os.getcwd())
from erp import db  # noqa: E402

# Columns whose values depend on the clock or on randomness, not on the seed logic.
VOLATILE = {"password_hash", "created_at", "photo", "txn_id"}  # txn_id uses secrets
VOLATILE_SUFFIXES = ("_at",)
SKIP_TABLES = {"sqlite_sequence", "photo_files"}

db.init_db()
out = {}
with db.connect() as conn:
    tables = [r[0] for r in conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")]
    for t in tables:
        if t in SKIP_TABLES:
            continue
        cols = [r[1] for r in conn.execute(f'PRAGMA table_info("{t}")')]
        keep = [c for c in cols if c not in VOLATILE and not c.endswith(VOLATILE_SUFFIXES)]
        rows = conn.execute(f'SELECT {", ".join(keep)} FROM "{t}" ORDER BY rowid').fetchall()
        out[t] = [list(r) for r in rows]
print(json.dumps(out))
