/* Student profile photos. Port of erp/photos.py.
 *
 * The image bytes live in the photo_files table (there is no disk in the
 * browser). The students.photo column stores just the generated name, and
 * pages show photos through object URLs made from those bytes.
 */
import * as db from "./db.js";
import { tokenHex } from "../lib/py.js";

export const MAX_BYTES = 2 * 1024 * 1024;
// Leading bytes of each allowed format -> extension we save it under.
const SIGNATURES = [
  [[0xff, 0xd8, 0xff], ".jpg"],
  [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], ".png"],
  [[0x52, 0x49, 0x46, 0x46], ".webp"],  // checked further below: bytes 8-12 must be WEBP
];
const MIMETYPES = { ".jpg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

function _detect(head) {
  for (const [magic, ext] of SIGNATURES) {
    if (magic.every((b, i) => head[i] === b)) {
      if (ext === ".webp" && String.fromCharCode(...head.slice(8, 12)) !== "WEBP") return null;
      return ext;
    }
  }
  return null;
}

/** Validate an uploaded File and store it. Returns the new name.
 * Throws db.ValueError with a user-facing message. The extension comes from
 * the file's content, never from its name. */
export async function save(file) {
  if (!file || !file.size) throw new db.ValueError("Choose an image to upload.");
  if (file.size > MAX_BYTES) throw new db.ValueError("The photo must be 2 MB or smaller.");
  const data = new Uint8Array(await file.arrayBuffer());
  const ext = _detect(data.slice(0, 12));
  if (ext === null) throw new db.ValueError("Upload a JPG, PNG or WebP image.");
  const name = tokenHex(16) + ext;
  db.connect().execute("INSERT INTO photo_files (name, mime, data) VALUES (?, ?, ?)",
    [name, MIMETYPES[ext], data]);
  return name;
}

/** Remove a stored photo; missing ones are ignored. */
export function remove_file(name) {
  if (name) db.connect().execute("DELETE FROM photo_files WHERE name = ?", [name]);
  forget(name);
}

// Python's photos.delete(); `delete` is a reserved word in JS.
export { remove_file as delete_ };

export function mimetype(name) {
  const ext = (/\.[a-z]+$/.exec(name || "") || [""])[0];
  return MIMETYPES[ext] || "application/octet-stream";
}

/** Save a new photo for the student and delete the previous one. */
export async function replace(student_id, file) {
  const student = db.get_student(student_id);
  const name = await save(file);
  db.set_student_photo(student_id, name);
  remove_file(student ? student.photo : "");
  return name;
}

export function remove(student_id) {
  const student = db.get_student(student_id);
  if (student && student.photo) {
    db.set_student_photo(student_id, "");
    remove_file(student.photo);
  }
}

// ---- Object URLs (the browser's stand-in for the /photo routes) --------------

const urls = new Map();

/** A URL an <img> can show, or "" if the photo is missing. */
export function url(name) {
  if (!name) return "";
  if (urls.has(name)) return urls.get(name);
  const row = db.connect().execute("SELECT mime, data FROM photo_files WHERE name = ?", [name]).fetchone();
  if (!row) return "";
  const u = URL.createObjectURL(new Blob([row.data], { type: row.mime }));
  urls.set(name, u);
  return u;
}

function forget(name) {
  if (urls.has(name)) {
    URL.revokeObjectURL(urls.get(name));
    urls.delete(name);
  }
}
