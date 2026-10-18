# Campus ERP: static (browser-only) version

The same ERP as the Flask app in the repository root, rebuilt so it runs entirely in the
visitor's browser. It needs no server, so it can be hosted for free on Vercel or any static host.

> **Unofficial student project demo.** Not affiliated with or endorsed by Graphic Era Hill
> University. All data is sample data, stored only in the visitor's browser.

## How it works

| Flask version | Static version |
| --- | --- |
| `app.py`, `admin_app.py` (Flask routes) | `js/portal.js`, `js/admin.js` (same routes, run by `js/lib/flask.js`, a tiny Flask look-alike) |
| `erp/*.py` (SQLite via `sqlite3`) | `js/erp/*.js`: **the same SQL**, run by [sql.js](https://sql.js.org) (SQLite compiled to WebAssembly) |
| `instance/erp.db` on the server | One database per browser, saved in **IndexedDB** |
| Jinja2 templates | The same templates, rendered by [Nunjucks](https://mozilla.github.io/nunjucks/) with a Jinja-compatibility layer (`js/lib/jinja.js`) |
| URLs: `/login`, `/dashboard`, `/admin/...` | The same URLs (History API; the host serves `index.html` for every non-file path) |
| Photos in `instance/uploads/` | Photos stored in the database (`photo_files` table) |
| werkzeug password hashes | PBKDF2-SHA256 via the browser's Web Crypto API |

The site opens on the **student login** (`/`). The admin console is at **`/admin`**
(`admin` / `admin123`): add a student with a password, then sign in as that student on the
student login. `/about` explains the demo and shows the visit counter.

Each visitor gets their own copy of the data, seeded with the same sample data as the Flask
version. `js/lib/py.js` ports Python's `random.Random`, `round()` and `%` formatting, so the
seeded numbers (attendance, results, fees) match the Flask app exactly.

### Things to be honest about (good viva material)

- **There is no security boundary.** Everything, including password hashes, lives in the
  visitor's own browser, where DevTools can read and edit it. Logins here are for the demo
  flow only. A real ERP needs a server that enforces access.
- **Data is per browser.** A different browser or device, or clearing site data, starts over.
  *Admin → Backup & restore* exports everything (including photos) to a JSON file and imports it.
- **Multiple tabs:** each page load picks up changes saved by other tabs. Two tabs saving at
  the same moment could overwrite each other (last write wins).

## Run locally

The site needs a server that answers unknown paths (like `/admin`) with `index.html`, the way
Vercel does. `serve.mjs` does that (Node 18+, no dependencies):

```bash
node web/serve.mjs
# open http://localhost:8000  (student login)  or  http://localhost:8000/admin
```

## Deploy on Vercel

1. Push the repository to GitHub.
2. On vercel.com: **Add New → Project →** import the repository.
3. Set **Root Directory** to `web`, **Framework Preset** to **Other**, and leave the build
   command and output directory empty.
4. Deploy. Every push to the branch redeploys automatically.

`vercel.json` sends every non-file path to `index.html` (so `/admin` and `/dashboard` work on a
fresh load) and adds a few security/caching headers. `.vercelignore` keeps `tests/`, `serve.mjs`
and this README out of the deployment.

## Visit counter

The login page footer and `/about` show the visitor count using the free [Abacus](https://abacus.jasoncameron.dev)
counter API (`js/counter.js`). Each browser is counted once; `localhost` only reads the number.
If the service is down, the counter stays hidden. Change `NAMESPACE` to start your own count.

## Tests

```bash
node web/tests/check.mjs            # renders every page and runs the admin/portal flows (Node only)
node web/tests/check.mjs --parity   # also compares every seeded table with the Flask version
node web/tests/browser.mjs          # end-to-end in headless Chrome (needs `node web/serve.mjs 8765`)
```

## Layout

```
web/
  index.html            loads the libraries and js/main.js
  serve.mjs             local dev server (not deployed)
  js/main.js            browser glue: hash routing, page swapping, form handling
  js/router.js          maps /admin, /about and the student portal (everything else) to their apps
  js/lib/               flask.js (routing, sessions, flash), jinja.js, py.js, store.js (IndexedDB)
  js/erp/               data layer: db.js, photos.js, backup.js, fees/academic/exams/campus.js
  js/portal/            portal blueprints (port of portal/*.py)
  js/admin.js, js/portal.js
  templates/            the Flask templates, with small Nunjucks-compatibility edits
  static/               CSS and the logo
  vendor/               sql.js 1.10.3 and Nunjucks 3.2.4 (vendored, no CDN needed)
```
