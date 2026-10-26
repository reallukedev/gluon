import "server-only";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR, db, now, one, all, run } from "../db";
import { AppError, notFound } from "../errors";
import type { User } from "../auth/users";
import { formatBytes, plural } from "@/lib/format";
import { checkSitePath, kindOf, SITE_LIMITS, type SiteFile, type SiteFileContent, type SiteTree } from "@/lib/sites-types";

/**
 * Sites' drafts: plain files under the data folder, one folder per site, that only Gluon writes.
 * Every change goes through here, one at a time per site, and bumps the draft's revision so the
 * editor (and a second tab) can tell what changed. Publishing copies a draft elsewhere (publish.ts).
 */

export const SITES_DIR = path.join(DATA_DIR, "sites");
export const draftDir = (id: string) => path.join(SITES_DIR, id, "draft");
const workDir = (id: string) => path.join(SITES_DIR, id, "work");

export interface SiteRow {
  id: string;
  name: string;
  created_at: number;
  created_by: string | null;
  changed_at: number;
  changed_by: string | null;
  draft_rev: number;
  files: number;
  bytes: number;
  published_at: number | null;
  published_by: string | null;
}

export interface VersionRow {
  site_id: string;
  version: string;
  created_at: number;
  created_by: string | null;
  draft_rev: number;
  files: number;
  bytes: number;
  own_404: number;
}

type G = typeof globalThis & { __gluonSitesTable?: boolean; __gluonSiteLocks?: Map<string, Promise<unknown>> };
const g = globalThis as G;

export function ensureSitesTables() {
  if (g.__gluonSitesTable) return;
  db().exec(`
    CREATE TABLE IF NOT EXISTS sites (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT,
      changed_at INTEGER NOT NULL, changed_by TEXT, draft_rev INTEGER NOT NULL DEFAULT 1,
      files INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
      published_at INTEGER, published_by TEXT
    );
    CREATE TABLE IF NOT EXISTS site_versions (
      site_id TEXT NOT NULL, version TEXT NOT NULL, created_at INTEGER NOT NULL, created_by TEXT,
      draft_rev INTEGER NOT NULL, files INTEGER NOT NULL, bytes INTEGER NOT NULL, own_404 INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (site_id, version)
    );
  `);
  g.__gluonSitesTable = true;
}

export function siteRows(): SiteRow[] {
  ensureSitesTables();
  return all<SiteRow>("SELECT * FROM sites ORDER BY name COLLATE NOCASE");
}

export function siteRow(id: string): SiteRow {
  ensureSitesTables();
  const r = /^[a-z0-9]{6,32}$/.test(id) ? one<SiteRow>("SELECT * FROM sites WHERE id = ?", id) : undefined;
  if (!r) throw notFound("That site");
  return r;
}

export function versionRows(id: string): VersionRow[] {
  ensureSitesTables();
  return all<VersionRow>("SELECT * FROM site_versions WHERE site_id = ? ORDER BY version DESC", id);
}

/** One change at a time per site, so two tabs can't interleave half-finished writes. */
export function withSite<T>(id: string, fn: () => Promise<T> | T): Promise<T> {
  const locks = (g.__gluonSiteLocks ??= new Map());
  const prev = locks.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    id,
    next.catch(() => undefined),
  );
  return next;
}

export function cleanSiteName(raw: string): string {
  const name = String(raw ?? "").replace(/\s+/g, " ").trim();
  if (!name) throw new AppError("invalid", "Give the site a name.", 400, { field: "name" });
  if (name.length > 60) throw new AppError("invalid", "Keep the name under 60 characters.", 400, { field: "name" });
  return name;
}

export function createSiteRow(user: Pick<User, "username">, name: string): SiteRow {
  ensureSitesTables();
  const id = crypto.randomBytes(5).toString("hex");
  const t = now();
  run("INSERT INTO sites (id, name, created_at, created_by, changed_at, changed_by, draft_rev) VALUES (?, ?, ?, ?, ?, ?, 1)", id, name, t, user.username, t, user.username);
  fs.mkdirSync(draftDir(id), { recursive: true, mode: 0o700 });
  return siteRow(id);
}

export function renameSiteRow(id: string, name: string) {
  run("UPDATE sites SET name = ? WHERE id = ?", name, id);
}

export function deleteSiteRows(id: string) {
  run("DELETE FROM site_versions WHERE site_id = ?", id);
  run("DELETE FROM sites WHERE id = ?", id);
}

// ---------------------------------------------------------------- paths

/** A checked path inside the site, as an AppError the person can read when it isn't one. */
export function sitePath(raw: string, field = "path"): string {
  const c = checkSitePath(raw);
  if (!c.ok) throw new AppError("bad_path", c.message, 400, { field });
  return c.path;
}

/**
 * The real file for a site path, refusing anything that isn't a plain file or folder on the way
 * (nothing but Gluon writes here, so a link would mean something is wrong).
 */
function resolveIn(root: string, rel: string): { abs: string; st: fs.Stats | null } {
  const parts = rel.split("/");
  let cur = root;
  for (const [i, part] of parts.entries()) {
    cur = path.join(cur, part);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return { abs: path.join(root, ...parts), st: null };
      throw e;
    }
    if (st.isSymbolicLink()) throw new AppError("bad_path", "That path goes through a link, which sites can't have.", 400);
    if (i < parts.length - 1 && !st.isDirectory()) throw new AppError("bad_path", `“${parts.slice(0, i + 1).join("/")}” is a file, not a folder.`, 400);
    if (i === parts.length - 1) return { abs: cur, st };
  }
  return { abs: root, st: fs.lstatSync(root) };
}

export const resolveDraft = (id: string, rel: string) => resolveIn(draftDir(id), rel);
export { resolveIn };

// ---------------------------------------------------------------- reading

/** Everything in a folder of site files: plain files and folders only, hidden junk ignored. */
export function walk(root: string): { files: (SiteFile & { abs: string })[]; dirs: string[] } {
  const files: (SiteFile & { abs: string })[] = [];
  const dirs: string[] = [];
  const stack: string[] = [""];
  while (stack.length) {
    const rel = stack.pop()!;
    let names: fs.Dirent[];
    try {
      names = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT" && rel === "") return { files, dirs };
      throw e;
    }
    for (const d of names) {
      const p = rel ? `${rel}/${d.name}` : d.name;
      if (!checkSitePath(p).ok) continue;
      if (d.isDirectory()) {
        dirs.push(p);
        stack.push(p);
      } else if (d.isFile()) {
        const abs = path.join(root, p);
        const st = fs.statSync(abs);
        files.push({ path: p, size: st.size, mtime: Math.floor(st.mtimeMs), kind: kindOf(p), abs });
      }
    }
  }
  const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  files.sort((a, b) => byPath(a.path, b.path));
  dirs.sort(byPath);
  return { files, dirs };
}

export function tree(id: string): SiteTree {
  const { files, dirs } = walk(draftDir(id));
  const row = siteRow(id);
  return { files: files.map(({ abs: _abs, ...f }) => f), dirs, bytes: files.reduce((n, f) => n + f.size, 0), rev: row.draft_rev };
}

export const etagOf = (buf: Buffer) => crypto.createHash("sha256").update(buf).digest("base64url").slice(0, 22);

/** UTF-8 text with no NUL bytes, which is what the editor can safely round-trip. */
function asText(buf: Buffer): string | null {
  if (buf.includes(0)) return null;
  const text = buf.toString("utf8");
  return Buffer.byteLength(text, "utf8") === buf.length && !text.includes("�") ? text : null;
}

export function readFile(id: string, rel: string): SiteFileContent {
  const p = sitePath(rel);
  const { abs, st } = resolveDraft(id, p);
  if (!st || !st.isFile()) throw notFound(`“${p}”`);
  if (st.size > SITE_LIMITS.textBytes) return { path: p, kind: "binary", size: st.size, etag: `${st.size}-${Math.floor(st.mtimeMs)}`, reason: "too-large" };
  const buf = fs.readFileSync(abs);
  const etag = etagOf(buf);
  const text = kindOf(p) === "image" && !p.toLowerCase().endsWith(".svg") ? null : asText(buf);
  if (text === null) return { path: p, kind: "binary", size: buf.length, etag, reason: "binary" };
  return { path: p, kind: "text", text, etag, size: buf.length };
}

// ---------------------------------------------------------------- writing

export interface Change {
  summary: string;
  tree: SiteTree;
}

/** Record that the draft changed: new revision, fresh totals. */
export function touched(id: string, user: Pick<User, "username">): SiteTree {
  const { files } = walk(draftDir(id));
  const bytes = files.reduce((n, f) => n + f.size, 0);
  run("UPDATE sites SET draft_rev = draft_rev + 1, changed_at = ?, changed_by = ?, files = ?, bytes = ? WHERE id = ?", now(), user.username, files.length, bytes, id);
  return tree(id);
}

function tooMuch(files: number, bytes: number): AppError | null {
  if (files > SITE_LIMITS.files) return new AppError("too_many_files", `A site can have up to ${SITE_LIMITS.files} files, and this would make ${files}. Remove some first.`, 413);
  if (bytes > SITE_LIMITS.siteBytes) return new AppError("site_too_large", `A site can hold up to ${formatBytes(SITE_LIMITS.siteBytes)}, and this would make it ${formatBytes(bytes)}. Remove something first, or make images smaller.`, 413);
  return null;
}

/** Throw when adding `addFiles` files and `addBytes` bytes (net) would go over the site's limits. */
export function checkRoom(id: string, addFiles: number, addBytes: number) {
  const r = siteRow(id);
  const err = tooMuch(r.files + addFiles, r.bytes + addBytes);
  if (err) throw err;
}

function mkTemp(id: string): string {
  fs.mkdirSync(workDir(id), { recursive: true, mode: 0o700 });
  return path.join(workDir(id), `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`);
}

/** Make the folders above `rel`, refusing if a file is in the way. Returns the folders it made, deepest last. */
function ensureParents(id: string, rel: string): string[] {
  const parts = rel.split("/").slice(0, -1);
  const made: string[] = [];
  let cur = draftDir(id);
  for (const [i, part] of parts.entries()) {
    cur = path.join(cur, part);
    try {
      const st = fs.lstatSync(cur);
      if (!st.isDirectory()) throw new AppError("bad_path", `“${parts.slice(0, i + 1).join("/")}” is a file, so it can't hold other files.`, 409);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      fs.mkdirSync(cur, { mode: 0o755 });
      made.push(cur);
    }
  }
  return made;
}

/** Put a finished temp file in place in one step, so the preview never sees half a file. */
function place(id: string, tmp: string, rel: string, mtime?: number) {
  ensureParents(id, rel);
  const { abs, st } = resolveDraft(id, rel);
  if (st?.isDirectory()) throw new AppError("exists", `“${rel}” is a folder. Pick another name for the file.`, 409);
  fs.chmodSync(tmp, 0o644);
  if (mtime) fs.utimesSync(tmp, new Date(), new Date(mtime));
  fs.renameSync(tmp, abs);
}

/** Save text from the editor. `etag` is what the editor loaded (null: a new file). */
export function writeText(id: string, user: Pick<User, "username">, rel: string, text: string, etag: string | null): Promise<{ etag: string; tree: SiteTree; created: boolean }> {
  return withSite(id, () => {
    const p = sitePath(rel);
    const buf = Buffer.from(text, "utf8");
    if (buf.length > SITE_LIMITS.textBytes) throw new AppError("too_large", `The editor saves files up to ${formatBytes(SITE_LIMITS.textBytes)}. Upload bigger files instead.`, 413);
    const { abs, st } = resolveDraft(id, p);
    if (st?.isDirectory()) throw new AppError("exists", `“${p}” is a folder.`, 409);
    if (etag === null && st) throw new AppError("exists", `There's already a file called “${p}”.`, 409, { field: "path" });
    if (etag !== null) {
      if (!st) throw new AppError("gone", `“${p}” was deleted or renamed somewhere else (another tab?). Save it under a new name, or reload the files.`, 409, { conflict: "gone" });
      const cur = etagOf(fs.readFileSync(abs));
      if (cur !== etag) throw new AppError("conflict", `“${p}” changed somewhere else (another tab?) since you opened it. Reload it to see that version, or save yours over it.`, 409, { conflict: "changed", etag: cur });
    }
    checkRoom(id, st ? 0 : 1, buf.length - (st?.size ?? 0));
    const tmp = mkTemp(id);
    fs.writeFileSync(tmp, buf, { mode: 0o644 });
    place(id, tmp, p);
    return { etag: etagOf(buf), tree: touched(id, user), created: !st };
  });
}

/** Stream an uploaded file into place, stopping the moment it goes over the limits. */
export async function writeUpload(id: string, user: Pick<User, "username">, rel: string, body: ReadableStream<Uint8Array> | null, declared: number | null, replace: boolean): Promise<{ path: string; replaced: boolean; tree: SiteTree }> {
  const p = sitePath(rel);
  if (declared !== null && declared > SITE_LIMITS.fileBytes) throw new AppError("too_large", `“${p}” is ${formatBytes(declared)}. Files can be up to ${formatBytes(SITE_LIMITS.fileBytes)}.`, 413);
  const tmp = mkTemp(id);
  let size = 0;
  try {
    const out = fs.openSync(tmp, "wx", 0o644);
    try {
      if (body) {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > SITE_LIMITS.fileBytes) {
            await reader.cancel().catch(() => undefined);
            throw new AppError("too_large", `“${p}” is over ${formatBytes(SITE_LIMITS.fileBytes)}, the most a file can be.`, 413);
          }
          fs.writeSync(out, value);
        }
      }
    } finally {
      fs.closeSync(out);
    }
    return await withSite(id, () => {
      const { st } = resolveDraft(id, p);
      if (st && !replace) throw new AppError("exists", `There's already a file called “${p}”.`, 409, { field: "path" });
      if (st?.isDirectory()) throw new AppError("exists", `“${p}” is a folder.`, 409);
      checkRoom(id, st ? 0 : 1, size - (st?.size ?? 0));
      place(id, tmp, p);
      return { path: p, replaced: !!st, tree: touched(id, user) };
    });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function makeFolder(id: string, user: Pick<User, "username">, rel: string): Promise<Change> {
  return withSite(id, () => {
    const p = sitePath(rel);
    const { st } = resolveDraft(id, p);
    if (st) throw new AppError("exists", `“${p}” already exists.`, 409, { field: "path" });
    ensureParents(id, `${p}/x`);
    return { summary: `Made the folder ${p}`, tree: touched(id, user) };
  });
}

/** Rename or move a file or folder. Never replaces something that's already there. */
export function movePath(id: string, user: Pick<User, "username">, fromRaw: string, toRaw: string): Promise<Change> {
  return withSite(id, () => {
    const from = sitePath(fromRaw, "from");
    const to = sitePath(toRaw, "to");
    if (from === to) return { summary: "Nothing to move", tree: tree(id) };
    const a = resolveDraft(id, from);
    if (!a.st) throw notFound(`“${from}”`);
    if (a.st.isDirectory() && (to + "/").startsWith(from + "/")) throw new AppError("bad_path", "A folder can't go inside itself.", 400, { field: "to" });
    const b = resolveDraft(id, to);
    // On a disk that ignores case, "about.html" finds "About.html" itself: the same entry, so only its name changes.
    const sameEntry = !!b.st && b.st.ino === a.st.ino && b.st.dev === a.st.dev;
    if (b.st && !sameEntry) throw new AppError("exists", `There's already something called “${to}”.`, 409, { field: "to" });
    ensureParents(id, to);
    const dest = path.join(draftDir(id), ...to.split("/"));
    if (sameEntry) {
      // Through a temporary name, so the disk records the new spelling.
      const tmp = mkTemp(id);
      fs.renameSync(a.abs, tmp);
      fs.renameSync(tmp, dest);
    } else fs.renameSync(a.abs, dest);
    const same = from.split("/").slice(0, -1).join("/") === to.split("/").slice(0, -1).join("/");
    return { summary: same ? `Renamed ${from} to ${to.split("/").pop()}` : `Moved ${from} to ${to}`, tree: touched(id, user) };
  });
}

export function deletePaths(id: string, user: Pick<User, "username">, raws: string[]): Promise<Change> {
  return withSite(id, () => {
    const paths = [...new Set(raws.map((r) => sitePath(r)))];
    const found = paths.map((p) => ({ p, ...resolveDraft(id, p) })).filter((x) => x.st);
    if (!found.length) throw notFound(paths.length === 1 ? `“${paths[0]}”` : "Those files");
    for (const f of found) fs.rmSync(f.abs, { recursive: true, force: true });
    const what = found.length === 1 ? found[0]!.p : plural(found.length, "item");
    return { summary: `Deleted ${what}`, tree: touched(id, user) };
  });
}

/**
 * Where a batch of new files can't go, as a message, or null when they all fit: a file where the
 * site (or the batch itself) has a folder of that name, or a folder where there's a file.
 */
export function clashIn(id: string, rels: string[]): string | null {
  const files = new Set(rels);
  for (const rel of rels) {
    const parts = rel.split("/");
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (files.has(dir)) return `“${dir}” is both a file and a folder in what you're adding. Rename one of them and try again.`;
      const { st } = resolveDraft(id, dir);
      if (st && !st.isDirectory()) return `“${dir}” is a file in the site, so it can't hold “${rel}”. Rename or delete it first.`;
    }
    const { st } = resolveDraft(id, rel);
    if (st?.isDirectory()) return `“${rel}” is a folder in the site, so a file can't take its place. Rename or delete the folder first.`;
  }
  return null;
}

/**
 * Write a set of finished files (from a starter or an import) into the draft, all or nothing. Each
 * file it replaces is set aside until the whole batch is in; if any step fails, the new files and
 * folders come out and the old files go back, so the draft is exactly as it was.
 */
export function placeAll(id: string, items: { rel: string; tmp: string; mtime?: number }[]): { added: number; replaced: number } {
  const clash = clashIn(id, items.map((it) => it.rel));
  if (clash) throw new AppError("exists", clash, 409);
  const placed: { abs: string; backup: string | null }[] = [];
  const made: string[] = [];
  try {
    for (const it of items) {
      made.push(...ensureParents(id, it.rel));
      const { abs, st } = resolveDraft(id, it.rel);
      if (st?.isDirectory()) throw new AppError("exists", `“${it.rel}” is a folder in the site, so a file can't take its place.`, 409);
      let backup: string | null = null;
      if (st) {
        backup = mkTemp(id);
        fs.renameSync(abs, backup);
      }
      placed.push({ abs, backup });
      fs.chmodSync(it.tmp, 0o644);
      if (it.mtime) fs.utimesSync(it.tmp, new Date(), new Date(it.mtime));
      fs.renameSync(it.tmp, abs);
    }
  } catch (e) {
    for (const p of placed.reverse()) {
      fs.rmSync(p.abs, { force: true });
      if (p.backup) fs.renameSync(p.backup, p.abs);
    }
    for (const d of made.reverse()) fs.rmSync(d, { recursive: true, force: true });
    throw e;
  }
  for (const p of placed) if (p.backup) fs.rmSync(p.backup, { force: true });
  return { added: placed.filter((p) => !p.backup).length, replaced: placed.filter((p) => p.backup).length };
}

export { mkTemp };

/** Remove every trace of a site's draft. */
export function removeDraft(id: string) {
  fs.rmSync(path.join(SITES_DIR, id), { recursive: true, force: true });
}
