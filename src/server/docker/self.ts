import "server-only";
import fs from "node:fs";

type G = typeof globalThis & { __gluonSelfCtr?: string | null };
const g = globalThis as G;

/**
 * With a host cgroup namespace (how Gluon is deployed) the cgroup path carries the id; otherwise the
 * mount table names Docker's per-container files by id. Falls back to HOSTNAME when that is a
 * container id.
 */
export function selfContainerId(): string | null {
  if (g.__gluonSelfCtr !== undefined) return g.__gluonSelfCtr;
  let id: string | null = null;
  try {
    const cg = fs.readFileSync("/proc/self/cgroup", "utf8");
    id = cg.match(/docker[-/]([0-9a-f]{64})/)?.[1] ?? null;
  } catch {
    /* not Linux */
  }
  if (!id) {
    try {
      const mi = fs.readFileSync("/proc/self/mountinfo", "utf8");
      id = mi.match(/\/(?:docker\/)?containers\/([0-9a-f]{64})\//)?.[1] ?? null;
    } catch {
      /* not Linux */
    }
  }
  if (!id && /^[0-9a-f]{12,64}$/.test(process.env.HOSTNAME ?? "")) id = process.env.HOSTNAME!;
  g.__gluonSelfCtr = id;
  return id;
}

export function isSelfContainer(id: string): boolean {
  const self = selfContainerId();
  return !!self && !!id && (self.startsWith(id) || id.startsWith(self));
}

/** Any Gluon install on this server (production, dev copies): never touched from here. */
export const GLUON_NAME = /^(gluon|tend)(-dev(-[a-z0-9-]+)?)?$/;
