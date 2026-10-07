import "server-only";
import path from "node:path";

/** Normalised absolute path, or null for anything else. */
export function norm(p: string): string | null {
  if (typeof p !== "string" || !p.startsWith("/") || p.includes("\0")) return null;
  const n = path.posix.normalize(p);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

/** Is `child` the same as or inside `parent`? */
export function within(child: string, parent: string): boolean {
  const c = norm(child);
  const p = norm(parent);
  if (!c || !p) return false;
  if (p === "/") return true;
  return c === p || c.startsWith(`${p}/`);
}

/** Strictly inside (not the folder itself). */
export const inside = (child: string, parent: string) => within(child, parent) && norm(child) !== norm(parent);

const BROAD = new Set([
  "/", "/home", "/root", "/srv", "/mnt", "/media", "/opt", "/var", "/var/lib", "/usr", "/etc", "/tmp", "/data", "/boot", "/bin", "/sbin", "/lib", "/run", "/dev", "/proc", "/sys",
  "/DATA", "/DATA/AppData", "/var/lib/docker", "/var/lib/docker/volumes", "/var/lib/casaos", "/var/lib/casaos/apps",
  "/srv/umbrel", "/srv/umbrel/app-data", "/srv/umbrel/home", "/home/umbrel", "/home/umbrel/umbrel", "/home/umbrel/umbrel/app-data", "/umbrel", "/umbrel/app-data",
]);

/**
 * Folders too general to be one app's own: deleting or copying them wholesale would take other
 * things with them. A person's home folder and each disk's mount point count too.
 */
export function isBroadPath(p: string): boolean {
  const n = norm(p);
  if (!n) return true;
  if (BROAD.has(n)) return true;
  const segs = n.split("/").filter(Boolean);
  if (segs.length <= 1) return true;
  if (segs.length === 2 && ["home", "mnt", "media", "run"].includes(segs[0]!)) return true;
  if (/(^|\/)gluon-apps$/.test(n) || n === "/opt/gluon/apps" || n === "/opt/gluon") return true;
  return false;
}

/** Resolve a compose path (absolute, ./relative or bare relative) against the project folder. */
export function resolveFrom(p: string, base: string | null): string | null {
  if (p.startsWith("~")) return null;
  if (p.startsWith("/")) return norm(p);
  if (!base) return null;
  return norm(path.posix.resolve(base, p));
}

/** "./data/config" for a path inside `dir`. */
export function relativeTo(dir: string, p: string): string {
  const r = path.posix.relative(dir, p);
  return r ? `./${r}` : ".";
}

/** A name safe for a Compose project, a folder and a file: lower-case letters, digits, - and _. */
export function slugify(s: string, fallback = "app"): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 40)
    .replace(/[-_]+$/g, "");
  return /^[a-z0-9]/.test(out) ? out : fallback;
}

/** A folder or file some container bind-mounts from the server. */
export interface BindUse {
  source: string;
  container: string;
}

/**
 * Containers outside `mine` that mount `p`, a folder inside it, or a folder above it (so they see
 * it). A mount of the whole disk ("/") doesn't count as using any one app's data.
 */
export function usersOf(p: string, binds: BindUse[], mine: Set<string>): string[] {
  const n = norm(p);
  if (!n) return [];
  const out = new Set<string>();
  for (const b of binds) {
    if (mine.has(b.container)) continue;
    const s = norm(b.source);
    if (!s || s === "/") continue;
    if (within(s, n) || within(n, s)) out.add(b.container);
  }
  return [...out].sort();
}
