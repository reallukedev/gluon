import "server-only";
import { all, now, one, run } from "../db";
import { id as newId } from "../crypto";
import { AppError, forbidden, notFound } from "../errors";
import { audit } from "../audit";
import { publish } from "../events";
import type { User } from "../auth/users";
import type { FileJob, JobKind, JobProgress, JobStatus } from "@/lib/files-types";

/**
 * Background work for Files (copy, move across drives, extract, ownership, delete forever). Jobs
 * persist to `file_jobs` so the UI can show them after a reload; live progress fans out on the
 * "files.jobs" topic. At most two run at once; the rest queue.
 */

export interface JobContext {
  id: string;
  signal: AbortSignal;
  progress(p: Partial<JobProgress>): void;
  /** Throw if cancelled. */
  check(): void;
}

export interface JobOutcome {
  message: string;
  result?: Record<string, unknown>;
  /** Mark the job failed but still record the message (partial success). */
  failed?: boolean;
}

interface Live {
  job: FileJob;
  abort: AbortController;
  run: (ctx: JobContext) => Promise<JobOutcome>;
  where: { ip?: string; zone?: string };
  user: Pick<User, "id" | "username">;
  lastPublish: number;
  pending: ReturnType<typeof setTimeout> | null;
  audit: { action: string; target: string | null };
}

type G = typeof globalThis & { __gluonFileJobs?: Map<string, Live>; __gluonFileQueue?: string[] };
const g = globalThis as G;
const live = () => (g.__gluonFileJobs ??= new Map());
const queue = () => (g.__gluonFileQueue ??= []);
const MAX_RUNNING = 2;
const MAX_KEEP = 200;

interface Row {
  id: string;
  user_id: string | null;
  username: string | null;
  kind: JobKind;
  status: JobStatus;
  title: string;
  params: string;
  progress: string | null;
  result: string | null;
  message: string | null;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

const EMPTY: JobProgress = { done: 0, total: null, bytesDone: 0, bytesTotal: null, current: null, phase: "Waiting" };

function toJob(r: Row): FileJob {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    title: r.title,
    userId: r.user_id,
    username: r.username,
    progress: r.progress ? { ...EMPTY, ...JSON.parse(r.progress) } : EMPTY,
    message: r.message,
    error: r.error,
    result: r.result ? JSON.parse(r.result) : null,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

function persist(j: FileJob, params?: unknown) {
  try {
    run(
      `INSERT INTO file_jobs (id, user_id, username, kind, status, title, params, progress, result, message, error, created_at, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, progress = excluded.progress, result = excluded.result,
         message = excluded.message, error = excluded.error, started_at = excluded.started_at, finished_at = excluded.finished_at`,
      j.id,
      j.userId,
      j.username,
      j.kind,
      j.status,
      j.title,
      JSON.stringify(params ?? {}),
      JSON.stringify(j.progress),
      j.result ? JSON.stringify(j.result) : null,
      j.message,
      j.error,
      j.createdAt,
      j.startedAt,
      j.finishedAt,
    );
  } catch (e) {
    console.error("[gluon] file_jobs write failed", (e as Error).message);
  }
}

function emit(l: Live, force = false) {
  const t = Date.now();
  if (!force && t - l.lastPublish < 250) {
    l.pending ??= setTimeout(() => {
      l.pending = null;
      emit(l, true);
    }, 250);
    return;
  }
  if (l.pending) {
    clearTimeout(l.pending);
    l.pending = null;
  }
  l.lastPublish = t;
  publish("files.jobs", l.job);
}

export function startJob(
  user: Pick<User, "id" | "username">,
  kind: JobKind,
  title: string,
  params: Record<string, unknown>,
  where: { ip?: string; zone?: string },
  runFn: (ctx: JobContext) => Promise<JobOutcome>,
  auditInfo?: { action?: string; target?: string | null },
): FileJob {
  const job: FileJob = {
    id: newId(),
    kind,
    status: "queued",
    title,
    userId: user.id,
    username: user.username,
    progress: { ...EMPTY },
    message: null,
    error: null,
    result: null,
    createdAt: now(),
    startedAt: null,
    finishedAt: null,
  };
  const l: Live = { job, abort: new AbortController(), run: runFn, where, user, lastPublish: 0, pending: null, audit: { action: auditInfo?.action ?? `files.${kind}`, target: auditInfo?.target ?? null } };
  live().set(job.id, l);
  persist(job, params);
  queue().push(job.id);
  emit(l, true);
  pump();
  return job;
}

function runningCount() {
  let n = 0;
  for (const l of live().values()) if (l.job.status === "running") n++;
  return n;
}

function pump() {
  while (runningCount() < MAX_RUNNING && queue().length) {
    const id = queue().shift()!;
    const l = live().get(id);
    if (!l || l.job.status !== "queued") continue;
    void execute(l);
  }
}

async function execute(l: Live) {
  const j = l.job;
  j.status = "running";
  j.startedAt = now();
  j.progress.phase = "Starting";
  persist(j);
  emit(l, true);
  let lastPersist = Date.now();
  const ctx: JobContext = {
    id: j.id,
    signal: l.abort.signal,
    progress(p) {
      Object.assign(j.progress, p);
      emit(l);
      if (Date.now() - lastPersist > 5000) {
        lastPersist = Date.now();
        persist(j);
      }
    },
    check() {
      if (l.abort.signal.aborted) throw new Cancelled();
    },
  };
  try {
    const out = await l.run(ctx);
    j.status = out.failed ? "failed" : "done";
    j.message = out.message;
    j.result = out.result ?? null;
    if (out.failed) j.error = out.message;
    j.progress.phase = out.failed ? "Stopped" : "Done";
    j.progress.current = null;
  } catch (e) {
    const cancelled = e instanceof Cancelled || l.abort.signal.aborted;
    j.status = cancelled ? "cancelled" : "failed";
    const msg = cancelled ? ((e as Cancelled).note ?? "Stopped.") : e instanceof AppError ? e.message : humanError(e);
    j.error = cancelled ? null : msg;
    j.message = msg;
    j.progress.phase = cancelled ? "Stopped" : "Failed";
    j.progress.current = null;
    if (!(e instanceof AppError) && !cancelled) console.error(`[gluon] file job ${j.kind} failed`, e);
  }
  j.finishedAt = now();
  persist(j);
  emit(l, true);
  audit(
    l.user,
    { action: l.audit.action, target: l.audit.target, summary: j.message ?? j.title, detail: { job: j.id, title: j.title, result: j.result }, outcome: j.status === "done" ? "ok" : "failed" },
    l.where,
  );
  // Keep finished jobs in memory briefly so the SSE snapshot shows them; the DB has the history.
  setTimeout(() => live().delete(j.id), 10 * 60_000).unref?.();
  pump();
}

export class Cancelled extends Error {
  constructor(public note?: string) {
    super("cancelled");
  }
}

export function humanError(e: unknown): string {
  const err = e as NodeJS.ErrnoException;
  switch (err?.code) {
    case "ENOSPC":
      return "The drive ran out of space.";
    case "EACCES":
    case "EPERM":
      return `The server wasn't allowed to change ${err.path ? stripHost(err.path) : "a file"}.`;
    case "ENOENT":
      return `${err.path ? stripHost(err.path) : "A file"} disappeared while working on it.`;
    case "EROFS":
      return "That drive is mounted read-only.";
    case "EIO":
      return "The drive reported a read/write error. Check its health in Storage.";
    case "EXDEV":
      return "That needs to move between drives, which failed. Try copying instead.";
    case "ENAMETOOLONG":
      return "A file name is too long for the destination drive.";
    case "EDQUOT":
      return "A disk quota was exceeded.";
    default:
      return (err?.message && !err.message.includes("/proc/1/root") ? err.message : null) ?? "Something went wrong. It's been logged.";
  }
}

function stripHost(p: string) {
  return p.replace(/^\/proc\/1\/root/, "") || "/";
}

export function listJobs(user: Pick<User, "id" | "role">, limit = 50): FileJob[] {
  const liveJobs = [...live().values()].map((l) => l.job).filter((j) => user.role === "admin" || j.userId === user.id);
  let rows: FileJob[] = [];
  try {
    rows = (user.role === "admin"
      ? all<Row>("SELECT * FROM file_jobs ORDER BY created_at DESC LIMIT ?", limit)
      : all<Row>("SELECT * FROM file_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?", user.id, limit)
    ).map(toJob);
  } catch {
    /* not migrated */
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const j of liveJobs) byId.set(j.id, j);
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

export function getJob(user: Pick<User, "id" | "role">, id: string): FileJob {
  const l = live().get(id);
  let j: FileJob | null = l?.job ?? null;
  if (!j) {
    try {
      const r = one<Row>("SELECT * FROM file_jobs WHERE id = ?", id);
      j = r ? toJob(r) : null;
    } catch {
      j = null;
    }
  }
  if (!j) throw notFound("That task");
  if (user.role !== "admin" && j.userId !== user.id) throw notFound("That task");
  return j;
}

export function cancelJob(user: Pick<User, "id" | "role">, id: string): FileJob {
  const j = getJob(user, id);
  const l = live().get(id);
  if (!l || (j.status !== "running" && j.status !== "queued")) throw new AppError("not_running", "That task has already finished.", 409);
  if (user.role !== "admin" && j.userId !== user.id) throw forbidden();
  if (j.status === "queued") {
    j.status = "cancelled";
    j.message = "Cancelled before it started.";
    j.finishedAt = now();
    persist(j);
    emit(l, true);
  } else {
    j.progress.phase = "Stopping";
    emit(l, true);
  }
  l.abort.abort();
  return j;
}

/** Jobs that were running when Gluon stopped can't be resumed; say so instead of leaving them "running". */
export function markInterrupted() {
  try {
    run(
      "UPDATE file_jobs SET status = 'failed', error = ?, message = ?, finished_at = ? WHERE status IN ('queued', 'running')",
      "Gluon restarted while this was running. Anything already finished stays in place; start it again to do the rest.",
      "Interrupted by a restart.",
      now(),
    );
    run(`DELETE FROM file_jobs WHERE id NOT IN (SELECT id FROM file_jobs ORDER BY created_at DESC LIMIT ${MAX_KEEP})`);
  } catch {
    /* not migrated */
  }
}
