import "server-only";
import path from "node:path";
import fs from "node:fs";

/**
 * With `pid: host`, the host's root filesystem is visible at /proc/1/root. All host file access
 * goes through here so path handling (normalisation, escapes) lives in one place.
 */
export const HOST_ROOT = (process.env.GLUON_HOST_ROOT ?? process.env.TEND_HOST_ROOT) ?? "/proc/1/root";

/** Normalise an absolute host path; rejects relative paths and NUL bytes. */
export function normalizeHostPath(p: string): string {
  if (typeof p !== "string" || !p.startsWith("/") || p.includes("\0")) {
    throw new Error("Expected an absolute path");
  }
  const n = path.posix.normalize(p);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

/** Map an absolute host path to the path this container can open. */
export function hostPath(p: string): string {
  const n = normalizeHostPath(p);
  return HOST_ROOT === "/" ? n : path.posix.join(HOST_ROOT, n);
}

export function readHostFile(p: string): string {
  return fs.readFileSync(hostPath(p), "utf8");
}

export function readHostFileOr(p: string, fallback: string): string {
  try {
    return readHostFile(p);
  } catch {
    return fallback;
  }
}

export function hostExists(p: string): boolean {
  try {
    fs.accessSync(hostPath(p));
    return true;
  } catch {
    return false;
  }
}

/** Is `child` equal to or inside `parent`? Both absolute, normalised. */
export function isWithin(child: string, parent: string): boolean {
  const c = normalizeHostPath(child);
  const p = normalizeHostPath(parent);
  if (p === "/") return true;
  return c === p || c.startsWith(p + "/");
}
