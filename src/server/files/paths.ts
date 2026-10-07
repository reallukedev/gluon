import "server-only";
import fs from "node:fs";
import path from "node:path";
import { all } from "../db";
import { DATA_DIR } from "../db";
import { AppError, badRequest, forbidden, notFound } from "../errors";
import { hostPath, isWithin, normalizeHostPath } from "../host/paths";
import { docker } from "../docker/client";
import { getSetting } from "../settings";
import type { User } from "../auth/users";
import type { Access } from "@/lib/files-types";
import { containerToHost, hostAliases, isMountPoint, mountsBelow } from "./mounts";

/**
 * Every Files request goes through here:
 *   1. normalise the path (absolute, no NUL),
 *   2. resolve every symlink ourselves in *host* path space (the kernel would resolve absolute links
 *      against this container's root when walking /proc/1/root, which is wrong),
 *   3. check the resolved path is inside a root the person may use (members: their grants),
 *   4. for changes, refuse system folders, mount points and Gluon's own data.
 */

export const TRASH_DIR = ".gluon-trash";
/** Trash folders made before the rename (Gluon was called Tend); their items still restore. */
export const LEGACY_TRASH_DIR = ".tend-trash";
export const isTrashDirName = (n: string) => n === TRASH_DIR || n === LEGACY_TRASH_DIR;
const MAX_LINKS = 40;

export function cleanPath(p: unknown): string {
  if (typeof p !== "string" || !p) throw badRequest("Choose a folder or file.");
  if (p.length > 4096) throw badRequest("That path is too long.");
  try {
    return normalizeHostPath(p);
  } catch {
    throw badRequest("Paths must start with / (for example /mnt/media).");
  }
}

/** A single file or folder name typed by a person. */
export function cleanName(name: unknown, what = "name"): string {
  if (typeof name !== "string") throw badRequest(`Type a ${what}.`, { field: "name" });
  const n = name.normalize("NFC");
  if (!n.trim()) throw badRequest(`Type a ${what}.`, { field: "name" });
  if (n === "." || n === "..") throw badRequest(`"${n}" can't be used as a ${what}.`, { field: "name" });
  if (n.includes("/")) throw badRequest(`A ${what} can't contain "/".`, { field: "name" });
  if (n.includes("\0") || /[\u0000-\u001f]/.test(n)) throw badRequest(`A ${what} can't contain control characters.`, { field: "name" });
  if (Buffer.byteLength(n) > 255) throw badRequest(`That ${what} is too long (255 bytes at most).`, { field: "name" });
  if (isTrashDirName(n)) throw badRequest(`"${TRASH_DIR}" is reserved for the trash.`, { field: "name" });
  return n;
}

function errno(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException)?.code;
}

export interface Resolved {
  /** Fully resolved host path. */
  real: string;
  exists: boolean;
  /** lstat of `real` (never a symlink when exists, since links are followed). */
  stat: fs.Stats | null;
}

/**
 * realpath() in host path space. Missing trailing components are allowed (the result then has
 * exists=false and the unresolved remainder appended) so callers can validate new names.
 */
export async function resolveHost(p: string, opts: { followLast?: boolean } = {}): Promise<Resolved> {
  const followLast = opts.followLast ?? true;
  const queue = normalizeHostPath(p).split("/").filter(Boolean);
  let cur = "/";
  let hops = 0;
  let stat: fs.Stats | null = null;
  while (queue.length) {
    const part = queue.shift()!;
    if (part === "." || part === "") continue;
    if (part === "..") {
      cur = path.posix.dirname(cur);
      stat = null;
      continue;
    }
    const next = cur === "/" ? `/${part}` : `${cur}/${part}`;
    let st: fs.Stats;
    try {
      st = await fs.promises.lstat(hostPath(next));
    } catch (e) {
      const code = errno(e);
      if (code === "ENOENT" || code === "ENOTDIR") {
        return { real: path.posix.join(next, ...queue), exists: false, stat: null };
      }
      if (code === "EACCES" || code === "EPERM") throw forbidden("The server itself isn't allowed to open that folder.");
      if (code === "ELOOP") throw badRequest("That path loops back on itself through links.");
      throw e;
    }
    if (st.isSymbolicLink() && (followLast || queue.length > 0)) {
      if (++hops > MAX_LINKS) throw badRequest("That path goes through too many links.");
      const target = await fs.promises.readlink(hostPath(next));
      const parts = target.split("/").filter(Boolean);
      if (target.startsWith("/")) cur = "/";
      queue.unshift(...parts);
      stat = null;
      continue;
    }
    if (queue.length && !st.isDirectory()) {
      return { real: path.posix.join(next, ...queue), exists: false, stat: null };
    }
    cur = next;
    stat = st;
  }
  if (cur === "/" && !stat) {
    stat = await fs.promises.lstat(hostPath("/"));
  }
  return { real: cur, exists: true, stat };
}

// ---------------------------------------------------------------- scope

export interface Root {
  id: string;
  label: string;
  path: string;
  real: string;
  access: Access;
  missing: boolean;
}

export interface Scope {
  admin: boolean;
  roots: Root[];
}

interface GrantRow {
  id: string;
  path: string;
  label: string | null;
  access: Access;
}

export async function scopeFor(user: Pick<User, "id" | "role">): Promise<Scope> {
  if (user.role === "admin") return { admin: true, roots: [{ id: "root", label: "Computer", path: "/", real: "/", access: "write", missing: false }] };
  const rows = all<GrantRow>("SELECT id, path, label, access FROM file_grants WHERE user_id = ? ORDER BY path", user.id);
  const defaults = getSetting("memberDefaultRoots") ?? [];
  const list: GrantRow[] = [...rows];
  for (const d of defaults) {
    if (!rows.some((r) => r.path === d)) list.push({ id: `default:${d}`, path: d, label: null, access: "read" });
  }
  const roots: Root[] = [];
  for (const g of list) {
    let p: string;
    try {
      p = normalizeHostPath(g.path);
    } catch {
      continue;
    }
    let real = p;
    let missing = false;
    try {
      const r = await resolveHost(p);
      real = r.real;
      missing = !r.exists || !r.stat?.isDirectory();
    } catch {
      missing = true;
    }
    roots.push({ id: g.id, label: g.label || path.posix.basename(p) || p, path: p, real, access: g.access, missing });
  }
  return { admin: false, roots };
}

/** Best access a member has to a resolved path, and through which root. */
export function accessFor(scope: Scope, real: string): { access: Access; root: Root } | null {
  let best: { access: Access; root: Root } | null = null;
  for (const r of scope.roots) {
    if (r.missing && !scope.admin) continue;
    if (!isWithin(real, r.real)) continue;
    if (!best || (r.access === "write" && best.access === "read") || (r.access === best.access && r.real.length > best.root.real.length)) {
      best = { access: r.access, root: r };
    }
  }
  return best;
}

export interface Target {
  /** Normalised path as requested. */
  path: string;
  real: string;
  /** Path this container opens. */
  fsPath: string;
  exists: boolean;
  stat: fs.Stats | null;
  access: Access;
  root: Root;
  scope: Scope;
}

function inTrash(p: string) {
  return p.split("/").some(isTrashDirName);
}

/**
 * Resolve and authorise a path for a person. Throws human errors for missing paths, paths outside
 * their folders, and write attempts on read-only shares.
 */
export async function authorize(
  user: Pick<User, "id" | "role">,
  raw: unknown,
  need: Access,
  opts: { mustExist?: boolean; allowTrash?: boolean; scope?: Scope; followLast?: boolean } = {},
): Promise<Target> {
  const p = cleanPath(raw);
  const scope = opts.scope ?? (await scopeFor(user));
  if (!scope.admin && !scope.roots.some((r) => !r.missing)) {
    throw forbidden("No folders have been shared with you yet. Ask an admin to share one.");
  }
  const r = await resolveHost(p, { followLast: opts.followLast });
  if (!opts.allowTrash && (inTrash(p) || inTrash(r.real))) {
    throw new AppError("in_trash", "That's inside the trash. Open Trash to restore or remove it.", 400);
  }
  const acc = scope.admin ? { access: "write" as Access, root: scope.roots[0]! } : accessFor(scope, r.real);
  if (!acc) {
    // Don't reveal whether it exists.
    throw forbidden(isWithinAnyLogical(scope, p) ? "That link points outside the folders shared with you." : "That folder isn't shared with you.");
  }
  if (need === "write" && acc.access !== "write") {
    throw forbidden(`You can open ${acc.root.label} but not change it. Ask an admin for write access.`);
  }
  if ((opts.mustExist ?? true) && !r.exists) throw notFound(path.posix.basename(p) || p);
  return { path: p, real: r.real, fsPath: hostPath(r.real), exists: r.exists, stat: r.stat, access: acc.access, root: acc.root, scope };
}

function isWithinAnyLogical(scope: Scope, p: string) {
  return scope.roots.some((r) => isWithin(p, r.path));
}

/** Can this person open `real` (already resolved)? Used for link targets and search results. */
export function canSee(scope: Scope, real: string): boolean {
  return scope.admin || !!accessFor(scope, real);
}

// ---------------------------------------------------------------- protection

const SYSTEM_TREES = ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/boot", "/proc", "/sys", "/dev", "/run", "/var/lib/dpkg", "/var/lib/apt", "/var/lib/systemd"];

interface Protected {
  path: string;
  why: "system" | "docker" | "gluon";
}

let protCache: { at: number; list: Protected[] } | null = null;

async function protectedTrees(): Promise<Protected[]> {
  if (protCache && Date.now() - protCache.at < 60_000) return protCache.list;
  const list: Protected[] = SYSTEM_TREES.map((p) => ({ path: p, why: "system" as const }));
  const dockerRoots = new Set(["/var/lib/docker", "/var/lib/containerd"]);
  try {
    const info = (await docker().info()) as { DockerRootDir?: string };
    if (info.DockerRootDir) dockerRoots.add(normalizeHostPath(info.DockerRootDir));
  } catch {
    /* docker unavailable: keep defaults */
  }
  for (const d of dockerRoots) {
    for (const a of safeAliases(d)) list.push({ path: a, why: "docker" });
  }
  const gluonData = containerToHost(path.resolve(DATA_DIR));
  if (gluonData) for (const a of safeAliases(gluonData)) list.push({ path: a, why: "gluon" });
  protCache = { at: Date.now(), list };
  return list;
}

function safeAliases(p: string) {
  try {
    return hostAliases(p);
  } catch {
    return [p];
  }
}

function describe(p: Protected, verb: string): string {
  switch (p.why) {
    case "docker":
      return `${p.path} is Docker's internal storage, so Gluon won't ${verb} anything in it. Manage containers and volumes from Apps instead.`;
    case "gluon":
      return `${p.path} holds Gluon's own data, so Gluon won't ${verb} anything in it.`;
    default:
      return `${p.path} belongs to the operating system, so Gluon won't ${verb} anything in it.`;
  }
}

/** Why changes inside `real` are refused, or null when they're allowed. */
export async function protectionReason(real: string, verb = "change"): Promise<string | null> {
  if (inTrash(real)) return "This is inside the trash. Open Trash to restore or remove things.";
  for (const p of await protectedTrees()) {
    if (isWithin(real, p.path)) return describe(p, verb);
  }
  return null;
}

/** A protected folder somewhere inside `real` (for recursive operations), or null. */
export async function protectedInside(real: string): Promise<string | null> {
  for (const p of await protectedTrees()) {
    if (p.path !== real && isWithin(p.path, real)) return p.path;
  }
  return null;
}

/** Refuse creating/changing things inside system folders, Docker's storage and Gluon's data. */
export async function assertMutable(real: string, verb = "change") {
  const why = await protectionReason(real, verb);
  if (why) throw new AppError("protected", why, 403);
}

/**
 * Refuse removing, renaming, moving or replacing `real` itself: everything assertMutable refuses,
 * plus top-level folders, home folders, mount points, folders with drives mounted inside, and the
 * top of a member's share.
 */
export async function assertRemovable(t: Pick<Target, "real" | "root" | "scope">, verb: string) {
  const real = t.real;
  await assertMutable(real, verb);
  if (real === "/") throw new AppError("protected", `Gluon won't ${verb} the whole computer.`, 403);
  const parent = path.posix.dirname(real);
  if (parent === "/") throw new AppError("protected", `${real} is a top-level system folder, so Gluon won't ${verb} it.`, 403);
  if (parent === "/home") throw new AppError("protected", `${real} is someone's home folder, so Gluon won't ${verb} it.`, 403);
  if (isMountPoint(real)) {
    throw new AppError("protected", `${real} is where a drive is mounted, so Gluon won't ${verb} it. Open it and choose what's inside instead.`, 403);
  }
  const below = mountsBelow(real);
  if (below.length) {
    throw new AppError("protected", `${real} contains ${below[0]!.mount}, where a drive is mounted. Gluon won't ${verb} a folder with a drive inside it.`, 403);
  }
  if (!t.scope.admin && (real === t.root.real || t.scope.roots.some((r) => r.real === real))) {
    throw forbidden(`This is the top of a folder shared with you, so you can't ${verb} it.`);
  }
  // Grant roots of other members: renaming them would silently break someone's share.
  const grants = all<{ path: string }>("SELECT DISTINCT path FROM file_grants");
  for (const g of grants) {
    let gp: string;
    try {
      gp = normalizeHostPath(g.path);
    } catch {
      continue;
    }
    if (isWithin(gp, real)) {
      throw new AppError("protected", `${gp} is shared with someone in the household. Change the share in People first, then try again.`, 409);
    }
  }
}

// ---------------------------------------------------------------- helpers

/** "file (2).mkv", "file (3).mkv"…: a free name in `dirReal` (host path). */
export async function freeName(dirReal: string, name: string, style: "copy" | "restored" = "copy"): Promise<string> {
  const exists = async (n: string) => {
    try {
      await fs.promises.lstat(hostPath(path.posix.join(dirReal, n)));
      return true;
    } catch {
      return false;
    }
  };
  if (!(await exists(name))) return name;
  const { stem, ext } = splitName(name);
  for (let i = 2; i < 10_000; i++) {
    const n = style === "restored" ? `${stem} (restored${i === 2 ? "" : ` ${i - 1}`})${ext}` : `${stem} (${i})${ext}`;
    if (Buffer.byteLength(n) > 255) break;
    if (!(await exists(n))) return n;
  }
  throw new AppError("conflict", `Couldn't find a free name for ${name}.`, 409);
}

/** Split "a.tar.gz" → { stem: "a", ext: ".tar.gz" }; dotfiles keep their name as stem. */
export function splitName(name: string): { stem: string; ext: string } {
  const m = name.match(/^(.+?)((?:\.tar)?\.[A-Za-z0-9]{1,8})$/);
  if (!m || name.startsWith(".") && name.indexOf(".", 1) < 0) return { stem: name, ext: "" };
  return { stem: m[1]!, ext: m[2]! };
}

/** Map a resolved host path back under the path the person used (keeps their breadcrumbs). */
export function logicalChild(t: Pick<Target, "path">, name: string) {
  return t.path === "/" ? `/${name}` : `${t.path}/${name}`;
}
