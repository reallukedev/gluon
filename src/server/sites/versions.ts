import "server-only";
import fs from "node:fs";
import path from "node:path";
import { CADDY_DIR, SITE_ID_RE, SITE_VERSION_RE } from "../caddy/routes";
import { AppError } from "../errors";
import { walk } from "./store";

/**
 * Published versions: complete, never-changing copies of a draft in Gluon's Caddy folder
 * (CADDY_DIR/sites/<id>/<version>/), which Caddy's container already mounts read-only. A version
 * is copied to a hidden folder first and renamed into place whole, so Caddy never sees half of one.
 * Files are 0644 and folders 0755, owned like the Caddy folder itself, so Caddy can read them
 * whichever user it runs as.
 */

export const PUBLISHED_DIR = path.join(CADDY_DIR, "sites");
export const siteVersionsDir = (id: string) => path.join(PUBLISHED_DIR, id);
export function versionDir(id: string, version: string) {
  if (!SITE_ID_RE.test(id) || !SITE_VERSION_RE.test(version)) throw new AppError("bad_version", "That version doesn't exist.", 404);
  return path.join(PUBLISHED_DIR, id, version);
}

function owner(): { uid: number; gid: number } | null {
  try {
    const st = fs.statSync(/*turbopackIgnore: true*/ CADDY_DIR);
    return { uid: st.uid, gid: st.gid };
  } catch {
    return null;
  }
}

function own(p: string, o: { uid: number; gid: number } | null) {
  if (!o) return;
  try {
    fs.chownSync(p, o.uid, o.gid);
  } catch {
    /* Not root (development): the files stay ours, and the modes below still let Caddy read them. */
  }
}

/** A new version name from the time: 20261025T120000Z, with -2, -3… if two land in the same second. */
export function newVersionName(id: string, at = new Date()): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  let v = stamp;
  for (let n = 2; fs.existsSync(path.join(siteVersionsDir(id), v)); n++) v = `${stamp}-${n}`;
  return v;
}

export interface CopiedVersion {
  version: string;
  files: number;
  bytes: number;
  own404: boolean;
}

/** Copy a folder of site files into a new version. Keeps each file's modified time, so unchanged files keep their ETag. */
export function copyToVersion(id: string, from: string, version: string): CopiedVersion {
  const o = owner();
  for (const d of [PUBLISHED_DIR, siteVersionsDir(id)]) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { mode: 0o755 });
      fs.chmodSync(d, 0o755);
      own(d, o);
    }
  }
  const dest = versionDir(id, version);
  const staging = path.join(siteVersionsDir(id), `.incoming-${version}`);
  fs.rmSync(staging, { recursive: true, force: true });
  const { files, dirs } = walk(from);
  try {
    fs.mkdirSync(staging, { mode: 0o755 });
    for (const d of dirs) fs.mkdirSync(path.join(staging, ...d.split("/")), { mode: 0o755 });
    let bytes = 0;
    for (const f of files) {
      const to = path.join(staging, ...f.path.split("/"));
      fs.copyFileSync(f.abs, to, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(to, 0o644);
      const mtime = new Date(f.mtime);
      fs.utimesSync(to, mtime, mtime);
      own(to, o);
      bytes += f.size;
    }
    for (const d of [staging, ...dirs.map((d) => path.join(staging, ...d.split("/")))]) {
      fs.chmodSync(d, 0o755);
      own(d, o);
    }
    fs.renameSync(staging, dest);
    return { version, files: files.length, bytes, own404: files.some((f) => f.path === "404.html") };
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  }
}

/** Version folders on disk, newest first. */
export function versionsOnDisk(id: string): string[] {
  try {
    return fs
      .readdirSync(siteVersionsDir(id))
      .filter((v) => SITE_VERSION_RE.test(v))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Keep the newest `keep` versions plus any still in use (the live one, even after a rollback to an
 * old one); delete the rest. Returns what was deleted.
 */
export function pruneVersions(id: string, keep: number, inUse: string[]): string[] {
  const all = versionsOnDisk(id);
  const stay = new Set([...inUse, ...all.filter((v) => !inUse.includes(v)).slice(0, Math.max(0, keep - inUse.filter((v) => all.includes(v)).length))]);
  const gone = all.filter((v) => !stay.has(v));
  for (const v of gone) fs.rmSync(versionDir(id, v), { recursive: true, force: true });
  // Copies interrupted by a crash or restart.
  try {
    for (const n of fs.readdirSync(siteVersionsDir(id))) if (n.startsWith(".incoming-")) fs.rmSync(path.join(siteVersionsDir(id), n), { recursive: true, force: true });
  } catch {
    /* no folder yet */
  }
  return gone;
}

export function removeVersions(id: string) {
  if (!SITE_ID_RE.test(id)) return;
  fs.rmSync(siteVersionsDir(id), { recursive: true, force: true });
}
