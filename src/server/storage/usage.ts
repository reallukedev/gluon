import "server-only";
import fs from "node:fs";
import type { ChildProcess } from "node:child_process";
import { localSpawn } from "../host/exec";
import { hostPath, HOST_ROOT, isWithin, normalizeHostPath } from "../host/paths";
import { AppError } from "../errors";
import { filesystems } from "../metrics/sampler";
import type { User } from "../auth/users";
import { hostRealpath, readMountinfo, mountContaining } from "./mounts";
import { Job, listJobs } from "./oplog";
import type { StorageJob, UsageEntry, UsageResult } from "@/lib/storage-types";

/**
 * "What's using space here?" — `du -x -B1 -a -d2` over one folder, run in the background at idle I/O
 * priority. du prints each child's total as soon as that child is done, which doubles as progress.
 * The second level lets the Space map draw folders inside folders and drill in without a new scan.
 * Results are kept in storage_jobs so the answer is still there after a reload (and a restart).
 */

const TOP_N = 60;
/** How many of the biggest folders keep their own children, and how many children each. */
const NEST_PARENTS = 24;
const NEST_N = 40;
const MAX_RUNNING = 2;
const TIMEOUT_MS = 60 * 60_000;
const FORBIDDEN = ["/proc", "/sys", "/dev", "/run"];

type G = typeof globalThis & { __gluonUsage?: Map<string, { job: Job; child: ChildProcess; path: string }> };
const g = globalThis as G;
const running = () => (g.__gluonUsage ??= new Map());

export function latestUsage(p: string): StorageJob | null {
  try {
    return listJobs({ kind: "usage", target: p, status: "done", limit: 1 })[0] ?? null;
  } catch {
    return null;
  }
}

export function runningUsage(p?: string): StorageJob[] {
  return [...running().values()].filter((r) => !p || r.path === p).map((r) => r.job.data);
}

export function cancelUsage(jobId: string): boolean {
  for (const [id, r] of running()) {
    if (id === jobId) {
      r.child.kill("SIGKILL");
      return true;
    }
  }
  return false;
}

/** Stop scans inside a mount that is about to be unmounted (du would keep it busy). */
export function cancelUsageUnder(root: string) {
  for (const r of running().values()) if (isWithin(r.path, root)) r.child.kill("SIGKILL");
}

export async function validateUsagePath(raw: string): Promise<string> {
  let p: string;
  try {
    p = normalizeHostPath(raw.trim());
  } catch {
    throw new AppError("invalid_path", "Use a full path starting with /.");
  }
  if (FORBIDDEN.some((f) => isWithin(p, f))) throw new AppError("invalid_path", `${p} isn't real files on a disk, so there's nothing to measure.`);
  const real = await hostRealpath(p);
  let st: fs.Stats;
  try {
    st = fs.statSync(hostPath(real));
  } catch {
    throw new AppError("not_found", `${p} doesn't exist.`, 404);
  }
  if (!st.isDirectory()) throw new AppError("not_dir", `${p} is a file, not a folder.`);
  return real;
}

/** Start (or join) a scan of `path`. */
export async function startUsage(user: User | null, raw: string): Promise<StorageJob> {
  const p = await validateUsagePath(raw);
  const existing = [...running().values()].find((r) => r.path === p);
  if (existing) return existing.job.data;
  if (running().size >= MAX_RUNNING) throw new AppError("busy", "Two folder scans are already running. Wait for one to finish.", 429);

  const job = new Job("usage", p, `See what's using space in ${p}`, { path: p }, user);
  const started = Date.now();
  const mounts = readMountinfo();
  const fsMount = mountContaining(p, mounts);
  const childMounts = new Set(mounts.filter((m) => m.target !== p && isWithin(m.target, p)).map((m) => m.target));

  let total = 0;
  let children: string[] = [];
  try {
    children = fs.readdirSync(hostPath(p));
  } catch {
    /* permission trouble shows up as unreadable below */
  }
  const expected = children.length;
  job.progress(0, expected);

  const prefix = HOST_ROOT === "/" ? "" : HOST_ROOT;
  const child = localSpawn("ionice", ["-c3", "nice", "-n", "10", "du", "-x", "-B1", "-a", "-d2", "-0", "--", hostPath(p)]);
  running().set(job.id, { job, child, path: p });

  const entries: UsageEntry[] = [];
  /** Second level, per top-level folder: raw (name, bytes) pairs, pruned as they grow. */
  const deeper = new Map<string, { list: { name: string; path: string; bytes: number }[]; pruned: number }>();
  let unreadable = 0;
  let buf = "";
  let done = 0;
  child.stdout?.on("data", (d: Buffer) => {
    buf += d.toString("utf8");
    let i: number;
    while ((i = buf.indexOf("\0")) >= 0) {
      const rec = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const tab = rec.indexOf("\t");
      if (tab < 0) continue;
      const bytes = Number(rec.slice(0, tab));
      let full = rec.slice(tab + 1);
      if (prefix && full.startsWith(prefix)) full = full.slice(prefix.length) || "/";
      if (full === p) {
        total = bytes;
        continue;
      }
      const name = full.slice(p === "/" ? 1 : p.length + 1);
      if (!name) continue;
      const slash = name.indexOf("/");
      if (slash >= 0) {
        const parent = full.slice(0, full.length - (name.length - slash));
        const d = deeper.get(parent) ?? { list: [], pruned: 0 };
        d.list.push({ name: name.slice(slash + 1), path: full, bytes });
        if (d.list.length > 400) {
          d.list.sort((a, b) => b.bytes - a.bytes);
          d.pruned += d.list.length - 200;
          d.list.length = 200;
        }
        deeper.set(parent, d);
        continue;
      }
      let dir = false;
      try {
        dir = fs.lstatSync(hostPath(full)).isDirectory();
      } catch {
        /* vanished */
      }
      entries.push({ name, path: full, bytes, dir, mountpoint: childMounts.has(full) });
      done++;
      if (done % 5 === 0 || done === expected) job.progress(Math.min(done, expected), expected);
    }
  });
  child.stderr?.on("data", (d: Buffer) => {
    unreadable += (d.toString("utf8").match(/cannot (read|access|open)/g) ?? []).length;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
  timer.unref?.();

  child.on("close", (code, signal) => {
    clearTimeout(timer);
    running().delete(job.id);
    if (signal === "SIGKILL" && !total) {
      job.finish("cancelled", { error: Date.now() - started >= TIMEOUT_MS ? "The scan took over an hour and was stopped." : "The scan was stopped." });
      return;
    }
    if (!total && code !== 0) {
      job.finish("failed", { error: unreadable ? "Gluon couldn't read that folder." : "The scan didn't finish." });
      return;
    }
    // Mount points of other drives inside it: show them with their own size, marked, not counted.
    for (const e of entries) {
      if (e.mountpoint) {
        const f = filesystems().find((x) => x.mount === e.path);
        if (f) e.bytes = f.used;
      }
    }
    entries.sort((a, b) => b.bytes - a.bytes);
    const top = entries.slice(0, TOP_N);
    const rest = entries.slice(TOP_N);
    const children: NonNullable<UsageResult["children"]> = {};
    for (const parent of top.filter((e) => e.dir && !e.mountpoint).slice(0, NEST_PARENTS)) {
      const d = deeper.get(parent.path);
      if (!d) continue;
      d.list.sort((a, b) => b.bytes - a.bytes);
      const kept = d.list.slice(0, NEST_N).map((c) => {
        let dir = false;
        try {
          dir = fs.lstatSync(hostPath(c.path)).isDirectory();
        } catch {
          /* vanished */
        }
        const mountpoint = childMounts.has(c.path);
        const f = mountpoint ? filesystems().find((x) => x.mount === c.path) : null;
        return { name: c.name, path: c.path, bytes: f ? f.used : c.bytes, dir, mountpoint };
      });
      const keptBytes = kept.reduce((a, c) => a + (c.mountpoint ? 0 : c.bytes), 0);
      children[parent.path] = { entries: kept, otherBytes: Math.max(0, parent.bytes - keptBytes), otherCount: d.list.length - kept.length + d.pruned };
    }
    const f = fsMount ? filesystems().find((x) => x.mount === fsMount.target) : null;
    const result: UsageResult = {
      path: p,
      total,
      entries: top,
      children,
      otherBytes: rest.reduce((a, e) => a + (e.mountpoint ? 0 : e.bytes), 0),
      otherCount: rest.length,
      unreadable,
      filesystem: f ? { mount: f.mount, size: f.size, used: f.used, avail: f.avail } : null,
      scannedAt: Date.now(),
      durationMs: Date.now() - started,
    };
    job.finish("done", { result });
  });
  child.on("error", (e) => {
    clearTimeout(timer);
    running().delete(job.id);
    job.finish("failed", { error: `The scan couldn't start: ${e.message}` });
  });
  return job.data;
}
