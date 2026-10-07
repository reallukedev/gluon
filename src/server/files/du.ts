import "server-only";
import path from "node:path";
import { all, now, one, run, tx } from "../db";
import { AppError } from "../errors";
import { HOST_ROOT, hostPath } from "../host/paths";
import { localSpawn } from "../host/exec";
import { publish } from "../events";
import type { User } from "../auth/users";
import type { FolderSize } from "@/lib/files-types";
import { authorize } from "./paths";
import { displayPath } from "./list";

/**
 * Folder sizes with `du` (disk usage, one filesystem, one level deep so every sub-folder's size
 * comes from the same pass). Results are cached in `dir_sizes`; calculations run in the background
 * and at most two at a time, because du on a big media drive keeps the disk busy for minutes.
 */

const STALE_MS = 60 * 60_000;
const TIMEOUT_MS = 20 * 60_000;
const MAX_CONCURRENT = 2;

interface Measure {
  bytes: number;
  children: { path: string; bytes: number }[];
  partial: boolean;
  tookMs: number;
}

type G = typeof globalThis & { __gluonDu?: Map<string, Promise<Measure>>; __gluonDuErr?: Map<string, string>; __gluonDuActive?: number; __gluonDuWait?: (() => void)[] };
const g = globalThis as G;
const inflight = () => (g.__gluonDu ??= new Map());
const errors = () => (g.__gluonDuErr ??= new Map());

async function slot(): Promise<() => void> {
  g.__gluonDuActive ??= 0;
  g.__gluonDuWait ??= [];
  if (g.__gluonDuActive >= MAX_CONCURRENT) await new Promise<void>((r) => g.__gluonDuWait!.push(r));
  g.__gluonDuActive++;
  return () => {
    g.__gluonDuActive!--;
    g.__gluonDuWait!.shift()?.();
  };
}

function fromHost(p: string): string {
  if (HOST_ROOT === "/") return p;
  return p.startsWith(HOST_ROOT) ? p.slice(HOST_ROOT.length) || "/" : p;
}

function runDu(real: string): Promise<Measure> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = localSpawn("du", ["-x", "-B1", "-d", "1", "-0", "--", hostPath(real)]);
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.stdout!.on("data", (b: Buffer) => {
      size += b.length;
      if (size < 32 * 1024 * 1024) chunks.push(b);
    });
    child.stderr!.on("data", (b: Buffer) => {
      if (stderr.length < 4096) stderr += b.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signal) return reject(new AppError("timeout", "Measuring this folder took too long and was stopped.", 504));
      const out = Buffer.concat(chunks).toString("utf8");
      let total: number | null = null;
      const children: Measure["children"] = [];
      for (const rec of out.split("\0")) {
        if (!rec) continue;
        const tab = rec.indexOf("\t");
        if (tab < 0) continue;
        const bytes = Number(rec.slice(0, tab));
        const p = fromHost(rec.slice(tab + 1));
        if (!Number.isFinite(bytes)) continue;
        if (p === real) total = bytes;
        else children.push({ path: p, bytes });
      }
      if (total === null) {
        return reject(new AppError("du_failed", stderr.includes("Permission denied") ? "The server isn't allowed to read this folder." : "Couldn't measure this folder.", 500));
      }
      resolve({ bytes: total, children, partial: code !== 0, tookMs: Date.now() - started });
    });
  });
}

function save(real: string, m: Measure) {
  const t = now();
  try {
    const up = "INSERT INTO dir_sizes (path, bytes, partial, computed_at, took_ms) VALUES (?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET bytes = excluded.bytes, partial = excluded.partial, computed_at = excluded.computed_at, took_ms = excluded.took_ms";
    // One transaction: a folder with thousands of sub-folders is thousands of rows.
    tx(() => {
      run(up, real, m.bytes, m.partial ? 1 : 0, t, m.tookMs);
      for (const c of m.children) run(up, c.path, c.bytes, m.partial ? 1 : 0, t, m.tookMs);
    });
  } catch (e) {
    console.error("[gluon] dir_sizes write failed", (e as Error).message);
  }
}

/** Measure (or join an in-flight measurement of) a resolved folder. */
export function measure(real: string): Promise<Measure> {
  const cur = inflight().get(real);
  if (cur) return cur;
  const p = (async () => {
    const release = await slot();
    try {
      const m = await runDu(real);
      save(real, m);
      errors().delete(real);
      publish("files.size", { path: real, bytes: m.bytes });
      return m;
    } catch (e) {
      errors().set(real, e instanceof AppError ? e.message : "Couldn't measure this folder.");
      publish("files.size", { path: real, error: true });
      throw e;
    } finally {
      release();
      inflight().delete(real);
    }
  })();
  inflight().set(real, p);
  p.catch(() => {});
  return p;
}

/** Bytes used by a folder, or null on failure. Used for trash items. */
export async function measureQuiet(real: string): Promise<number | null> {
  try {
    return (await measure(real)).bytes;
  } catch {
    return null;
  }
}

interface Row {
  path: string;
  bytes: number;
  partial: number;
  computed_at: number;
  took_ms: number;
}

function cached(real: string): Row | null {
  try {
    return one<Row>("SELECT * FROM dir_sizes WHERE path = ?", real) ?? null;
  } catch {
    return null;
  }
}

function cachedChildren(real: string): Row[] {
  const prefix = real === "/" ? "/" : `${real}/`;
  try {
    return all<Row>(
      "SELECT * FROM dir_sizes WHERE path > ? AND path < ? AND instr(substr(path, ?), '/') = 0 ORDER BY bytes DESC LIMIT 500",
      prefix,
      `${prefix.slice(0, -1)}0`,
      prefix.length + 1,
    );
  } catch {
    return [];
  }
}

/**
 * Current size of a folder for a person. Starts a background calculation when there's no recent
 * number (or `refresh`), and returns immediately; the client polls or listens on "files.size".
 */
export async function folderSize(user: User, p: string, refresh: boolean): Promise<FolderSize> {
  const t = await authorize(user, p, "read");
  if (!t.stat?.isDirectory()) throw new AppError("not_a_folder", "Sizes are calculated for folders.", 400);
  const shown = displayPath(t);
  const row = cached(t.real);
  const stale = !row || now() - row.computed_at > STALE_MS;
  if (refresh || stale) void measure(t.real).catch(() => {});
  const running = inflight().has(t.real);
  const kids = row ? cachedChildren(t.real).filter((c) => c.computed_at >= row.computed_at - 1000) : [];
  return {
    path: shown,
    bytes: row?.bytes ?? null,
    computedAt: row?.computed_at ?? null,
    tookMs: row?.took_ms ?? null,
    running,
    partial: !!row?.partial,
    children: kids.map((c) => {
      const name = path.posix.basename(c.path);
      return { name, path: shown === "/" ? `/${name}` : `${shown}/${name}`, bytes: c.bytes };
    }),
    error: running ? null : (errors().get(t.real) ?? null),
  };
}
