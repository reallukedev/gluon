import "server-only";
import fs from "node:fs";
import path from "node:path";
import { host } from "../host/exec";
import { hostPath, isWithin, normalizeHostPath } from "../host/paths";
import { AppError } from "../errors";

/**
 * Readers for the host's mount table and helpers for validating mount points.
 * With `pid: host`, /proc/1 is the host's init, so /proc/1/mountinfo is the host's mount table.
 */

export interface MountEntry {
  id: number;
  parent: number;
  majMin: string;
  /** Root of the mount within its filesystem ("/" unless it's a bind of a sub-folder). */
  fsroot: string;
  target: string;
  options: string[];
  fstype: string;
  source: string;
  superOptions: string[];
}

/** mountinfo/fstab escape: \040 → space etc. */
export function unescapeOctal(s: string): string {
  return s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
}

export function readMountinfo(): MountEntry[] {
  let text = "";
  try {
    text = fs.readFileSync("/proc/1/mountinfo", "utf8");
  } catch {
    try {
      text = fs.readFileSync("/proc/self/mountinfo", "utf8");
    } catch {
      return [];
    }
  }
  const out: MountEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    const dash = line.indexOf(" - ");
    if (dash < 0) continue;
    const a = line.slice(0, dash).split(" ");
    const b = line.slice(dash + 3).split(" ");
    if (a.length < 6 || b.length < 2) continue;
    out.push({
      id: Number(a[0]),
      parent: Number(a[1]),
      majMin: a[2]!,
      fsroot: unescapeOctal(a[3]!),
      target: unescapeOctal(a[4]!),
      options: a[5]!.split(","),
      fstype: b[0]!,
      source: unescapeOctal(b[1]!),
      superOptions: (b[2] ?? "").split(",").filter(Boolean),
    });
  }
  return out;
}

/** Active swap devices/files (host-wide). */
export function readSwaps(): string[] {
  try {
    return fs
      .readFileSync("/proc/swaps", "utf8")
      .split("\n")
      .slice(1)
      .map((l) => l.split(/\s+/)[0] ?? "")
      .filter(Boolean)
      .map(unescapeOctal);
  } catch {
    return [];
  }
}

/** glibc makedev(): the st_dev value for a "major:minor" pair. */
export function devNumber(majMin: string): number {
  const [maj, min] = majMin.split(":").map(Number) as [number, number];
  return (min & 0xff) + (maj & 0xfff) * 256 + Math.floor(min / 256) * 1_048_576 + Math.floor(maj / 4096) * 2 ** 32;
}

export function mountAt(target: string, mounts = readMountinfo()): MountEntry | null {
  const t = normalizeHostPath(target);
  // The last entry wins when something is mounted over something else.
  let found: MountEntry | null = null;
  for (const m of mounts) if (m.target === t) found = m;
  return found;
}

/** Mounts strictly inside `target`. */
export function mountsUnder(target: string, mounts = readMountinfo()): MountEntry[] {
  const t = normalizeHostPath(target);
  return mounts.filter((m) => m.target !== t && isWithin(m.target, t));
}

/** The mount that contains a path (longest prefix). */
export function mountContaining(p: string, mounts = readMountinfo()): MountEntry | null {
  const n = normalizeHostPath(p);
  let best: MountEntry | null = null;
  for (const m of mounts) {
    if (isWithin(n, m.target) && (!best || m.target.length >= best.target.length)) best = m;
  }
  return best;
}

export const isBlockMount = (m: MountEntry) => m.source.startsWith("/dev/") && !m.majMin.startsWith("0:");

// ---------------------------------------------------------------- path safety

/** Places a drive must never be mounted at or inside. */
const FORBIDDEN_WITHIN = ["/proc", "/sys", "/dev", "/run", "/boot", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/tmp", "/root", "/snap", "/var/lib/docker", "/var/lib/containerd", "/var/lib/casaos", "/var/log", "/var/cache", "/var/tmp"];
/** Top-level folders that are fine to mount *inside* but not *at*. */
const FORBIDDEN_EXACT = ["/", "/home", "/var", "/var/lib", "/srv", "/opt", "/mnt", "/media", "/DATA", "/data", "/lost+found"];

/** Filesystem mount points that belong to the operating system. */
export const SYSTEM_TARGETS = ["/", "/boot", "/boot/efi", "/usr", "/var", "/home", "/var/lib/docker", "/var/lib/containerd"];

export function isSystemTarget(t: string): boolean {
  return SYSTEM_TARGETS.includes(t);
}

/** Canonical path on the host (resolves symlinks in the parts that exist). */
export async function hostRealpath(p: string): Promise<string> {
  const { stdout } = await host("realpath", ["-m", "--", normalizeHostPath(p)], { timeoutMs: 10_000 });
  return stdout.trim();
}

/** Resolve symlinks for several paths in one host call. Missing paths resolve as-is. */
export async function hostRealpaths(ps: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const uniq = [...new Set(ps.filter((p) => p.startsWith("/")))];
  for (let i = 0; i < uniq.length; i += 200) {
    const chunk = uniq.slice(i, i + 200);
    try {
      const { stdout } = await host("realpath", ["-m", "--", ...chunk], { timeoutMs: 15_000 });
      const lines = stdout.split("\n");
      chunk.forEach((p, j) => out.set(p, lines[j]?.trim() || p));
    } catch {
      for (const p of chunk) out.set(p, p);
    }
  }
  return out;
}

export interface TargetCheck {
  path: string;
  exists: boolean;
}

/**
 * Validate a folder a filesystem is about to be mounted at. Throws a human AppError.
 * `ignoreMount` lets a rename treat the filesystem being moved as not in the way.
 */
export async function validateMountTarget(raw: string, opts: { ignoreMount?: string; systemMounts?: Set<string> } = {}): Promise<TargetCheck> {
  if (typeof raw !== "string" || !raw.trim()) throw new AppError("invalid_path", "Choose a folder to mount it at, like /mnt/photos.");
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) throw new AppError("invalid_path", "Use a full path starting with /, like /mnt/photos.");
  let p: string;
  try {
    p = normalizeHostPath(trimmed);
  } catch {
    throw new AppError("invalid_path", "That isn't a valid folder path.");
  }
  if (p.split("/").some((part) => part === "." || part === "..")) throw new AppError("invalid_path", "Use a plain path without . or .. in it.");
  if (!/^[A-Za-z0-9._@+\-/]+$/.test(p)) {
    throw new AppError("invalid_path", "Use only letters, numbers, dots, dashes and underscores in folder names (no spaces).");
  }
  if (p.length > 200) throw new AppError("invalid_path", "That path is too long.");
  if (FORBIDDEN_EXACT.includes(p)) throw new AppError("unsafe_path", `${p} is a system folder. Pick a folder inside it instead, like ${p === "/" ? "/mnt" : p}/photos.`);
  const bad = FORBIDDEN_WITHIN.find((f) => isWithin(p, f));
  if (bad) throw new AppError("unsafe_path", `Drives can't be mounted inside ${bad}: the operating system uses it. /mnt is the usual place.`);

  // No symlinks anywhere in the path: a mount would follow them somewhere unexpected.
  const real = await hostRealpath(p);
  if (real !== p) throw new AppError("symlink_path", `Part of ${p} is a link to somewhere else (it resolves to ${real}). Use the real location instead.`);

  const mounts = readMountinfo();
  const existing = mountAt(p, mounts);
  if (existing && existing.target !== opts.ignoreMount) throw new AppError("in_use", `Something is already mounted at ${p}.`);

  // Don't nest a drive inside another data drive: boot order and unmounting get fragile.
  const parent = mountContaining(path.posix.dirname(p), mounts);
  if (parent && parent.target !== "/" && !isSystemTarget(parent.target) && !opts.systemMounts?.has(parent.target) && parent.target !== opts.ignoreMount && isBlockMount(parent)) {
    const dir = path.posix.dirname(p);
    const where = dir === parent.target ? `${dir} is another drive` : `${dir} is on another drive (${parent.target})`;
    throw new AppError("nested_mount", `${where}. Mounting inside it makes both fragile. Pick a place outside it, like /mnt/${path.posix.basename(p)}.`);
  }
  if (opts.ignoreMount && isWithin(p, opts.ignoreMount)) {
    throw new AppError("nested_mount", `The new place can't be inside ${opts.ignoreMount} itself.`);
  }

  let exists = false;
  try {
    const st = fs.lstatSync(hostPath(p));
    exists = true;
    if (!st.isDirectory()) throw new AppError("not_empty", `${p} already exists and isn't a folder.`);
    const entries = fs.readdirSync(hostPath(p));
    if (entries.length > 0) {
      throw new AppError("not_empty", `${p} already has ${entries.length === 1 ? "something" : `${entries.length} things`} in it. Mounting over it would hide them. Pick an empty or new folder.`);
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new AppError("unreadable", `Gluon couldn't check ${p}: ${(e as Error).message}`);
  }
  return { path: p, exists };
}

/** mkdir -p on the host. Returns the first directory it created (for undo), or null. */
export async function hostMkdirs(p: string): Promise<string | null> {
  const n = normalizeHostPath(p);
  // Find the highest missing ancestor so undo can remove exactly what we made.
  let first: string | null = null;
  let cur = n;
  while (cur !== "/") {
    try {
      fs.lstatSync(hostPath(cur));
      break;
    } catch {
      first = cur;
      cur = path.posix.dirname(cur);
    }
  }
  if (first) await host("mkdir", ["-p", "--", n], { timeoutMs: 10_000 });
  return first;
}

/** Remove directories bottom-up from `leaf` to `top` if they are empty (never recursive). */
export async function hostRemoveEmptyDirs(leaf: string, top: string): Promise<void> {
  let cur = normalizeHostPath(leaf);
  const stop = normalizeHostPath(top);
  while (isWithin(cur, stop)) {
    try {
      await host("rmdir", ["--", cur], { timeoutMs: 10_000 });
    } catch {
      return;
    }
    if (cur === stop) return;
    cur = path.posix.dirname(cur);
  }
}

export function dirIsEmpty(p: string): boolean {
  try {
    return fs.readdirSync(hostPath(p)).length === 0;
  } catch {
    return false;
  }
}
