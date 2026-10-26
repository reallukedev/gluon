import "server-only";
import { all, one, run } from "../db";
import { id as newId } from "../crypto";
import { publish, subscribe } from "../events";
import { conflict } from "../errors";
import type { User } from "../auth/users";
import type { JobKind, JobStatus, JobStep, StepStatus, StorageJob } from "@/lib/storage-types";

/**
 * Storage operations are recorded in `storage_jobs` step by step, so a page reload (or a Gluon restart
 * in the middle of a rename) still shows exactly what happened. Live updates go out on the
 * "storage.job" topic.
 */

interface Row {
  id: string;
  kind: JobKind;
  target: string | null;
  status: JobStatus;
  title: string;
  params: string;
  steps: string;
  progress: string | null;
  result: string | null;
  error: string | null;
  username: string | null;
  started_at: number;
  finished_at: number | null;
}

const parse = <T>(s: string | null, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

const toJob = (r: Row): StorageJob => ({
  id: r.id,
  kind: r.kind,
  target: r.target,
  title: r.title,
  status: r.status,
  steps: parse<JobStep[]>(r.steps, []),
  progress: parse<StorageJob["progress"]>(r.progress, null),
  result: parse<unknown>(r.result, null),
  error: r.error,
  username: r.username,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
});

export function getJob(id: string): StorageJob | null {
  const r = one<Row>("SELECT * FROM storage_jobs WHERE id = ?", id);
  return r ? toJob(r) : null;
}

export function getJobParams(id: string): Record<string, unknown> {
  const r = one<{ params: string }>("SELECT params FROM storage_jobs WHERE id = ?", id);
  return parse<Record<string, unknown>>(r?.params ?? null, {});
}

export function listJobs(opts: { kind?: JobKind; target?: string; limit?: number; status?: JobStatus } = {}): StorageJob[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.kind) (where.push("kind = ?"), params.push(opts.kind));
  if (opts.target) (where.push("target = ?"), params.push(opts.target));
  if (opts.status) (where.push("status = ?"), params.push(opts.status));
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
  return all<Row>(`SELECT * FROM storage_jobs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC LIMIT ${limit}`, ...params).map(toJob);
}

export class Job {
  readonly data: StorageJob;
  private lastSave = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(kind: JobKind, target: string | null, title: string, params: Record<string, unknown>, user: Pick<User, "id" | "username"> | null) {
    const now = Date.now();
    this.data = { id: newId(12), kind, target, title, status: "running", steps: [], progress: null, result: null, error: null, username: user?.username ?? null, startedAt: now, finishedAt: null };
    run(
      `INSERT INTO storage_jobs (id, kind, target, status, title, params, steps, progress, result, error, user_id, username, started_at, finished_at)
       VALUES (?, ?, ?, 'running', ?, ?, '[]', NULL, NULL, NULL, ?, ?, ?, NULL)`,
      this.data.id,
      kind,
      target,
      title,
      JSON.stringify(params),
      user?.id ?? null,
      user?.username ?? null,
      now,
    );
    this.emit();
  }

  get id() {
    return this.data.id;
  }

  private save() {
    this.lastSave = Date.now();
    run(
      "UPDATE storage_jobs SET status = ?, steps = ?, progress = ?, result = ?, error = ?, finished_at = ? WHERE id = ?",
      this.data.status,
      JSON.stringify(this.data.steps),
      this.data.progress ? JSON.stringify(this.data.progress) : null,
      this.data.result === null ? null : JSON.stringify(this.data.result),
      this.data.error,
      this.data.finishedAt,
      this.data.id,
    );
  }

  private emit(throttle = false) {
    if (throttle && Date.now() - this.lastSave < 1000) {
      this.saveTimer ??= setTimeout(() => {
        this.saveTimer = null;
        this.save();
      }, 1000);
    } else {
      if (this.saveTimer) clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.save();
    }
    publish("storage.job", { id: this.data.id, job: this.data });
  }

  /** Declare the steps up front so the UI can show the whole plan as a checklist. */
  plan(labels: string[]) {
    for (const label of labels) this.data.steps.push(this.newStep(label, false));
    this.emit();
  }

  private newStep(label: string, undo: boolean): JobStep {
    return { id: `s${this.data.steps.length + 1}`, label, status: "pending", undo, detail: null, error: null, startedAt: null, finishedAt: null };
  }

  private findOrAdd(label: string, undo: boolean): JobStep {
    const existing = this.data.steps.find((s) => s.label === label && s.status === "pending" && s.undo === undo);
    if (existing) return existing;
    const s = this.newStep(label, undo);
    this.data.steps.push(s);
    return s;
  }

  /** Run one step; its outcome is recorded whether it succeeds or throws. */
  async step<T>(label: string, fn: (s: { detail: (d: string) => void }) => Promise<T>, opts: { undo?: boolean } = {}): Promise<T> {
    const s = this.findOrAdd(label, !!opts.undo);
    s.status = "running";
    s.startedAt = Date.now();
    this.emit();
    try {
      const r = await fn({
        detail: (d) => {
          s.detail = d;
          this.emit(true);
        },
      });
      s.status = opts.undo ? "undone" : "done";
      s.finishedAt = Date.now();
      this.emit();
      return r;
    } catch (e) {
      s.status = opts.undo ? "undo-failed" : "failed";
      s.error = (e as Error).message || "It didn't work.";
      s.finishedAt = Date.now();
      this.emit();
      throw e;
    }
  }

  /** Mark a declared step as not needed. */
  skip(label: string, why?: string) {
    const s = this.data.steps.find((x) => x.label === label && x.status === "pending");
    if (!s) return;
    s.status = "skipped";
    s.detail = why ?? null;
    this.emit();
  }

  setStatus(label: string, status: StepStatus, detail?: string) {
    const s = this.findOrAdd(label, false);
    s.status = status;
    if (detail) s.detail = detail;
    this.emit();
  }

  progress(done: number, total: number) {
    this.data.progress = { done, total };
    this.emit(true);
  }

  setResult(result: unknown) {
    this.data.result = result;
    this.emit(true);
  }

  finish(status: Exclude<JobStatus, "running">, opts: { result?: unknown; error?: string | null } = {}) {
    this.data.status = status;
    if (opts.result !== undefined) this.data.result = opts.result;
    this.data.error = opts.error ?? null;
    this.data.finishedAt = Date.now();
    // Steps still pending were never reached.
    for (const s of this.data.steps) if (s.status === "pending") s.status = "skipped";
    this.emit();
  }
}

/** Jobs that were running when Gluon stopped. Returns them so the caller can raise findings. */
export function markInterrupted(): StorageJob[] {
  try {
    const rows = all<Row>("SELECT * FROM storage_jobs WHERE status = 'running'");
    for (const r of rows) {
      const steps = parse<JobStep[]>(r.steps, []).map((s) => (s.status === "running" ? { ...s, status: "failed" as StepStatus, error: "Gluon stopped while this was happening." } : s.status === "pending" ? { ...s, status: "skipped" as StepStatus } : s));
      run("UPDATE storage_jobs SET status = 'interrupted', steps = ?, error = ?, finished_at = ? WHERE id = ?", JSON.stringify(steps), "Gluon stopped before this finished.", Date.now(), r.id);
    }
    return rows.map((r) => ({ ...toJob(r), status: "interrupted" as JobStatus }));
  } catch {
    return [];
  }
}

export function pruneJobs() {
  try {
    run("DELETE FROM storage_jobs WHERE kind = 'usage' AND started_at < ? AND id NOT IN (SELECT id FROM storage_jobs s WHERE kind = 'usage' AND status = 'done' AND started_at = (SELECT MAX(started_at) FROM storage_jobs t WHERE t.kind = 'usage' AND t.target = s.target AND t.status = 'done'))", Date.now() - 30 * 86_400_000);
    run("DELETE FROM storage_jobs WHERE kind != 'usage' AND started_at < ?", Date.now() - 365 * 86_400_000);
  } catch {
    /* table not there yet */
  }
}

/** Follow one job's updates until it finishes. Returns an unsubscribe function. */
export function followJob(id: string, onUpdate: (job: StorageJob) => void): () => void {
  return subscribe("storage.job", (d) => {
    const m = d as { id: string; job: StorageJob };
    if (m.id === id) onUpdate(m.job);
  });
}

/**
 * Stream a job as events until it finishes or the client leaves (the job itself keeps running):
 *   { type: "job", job }                                   snapshot first
 *   { type: "step", id, text, state, undo, detail, error } each time a step changes
 *   { type: "progress", done, total }                      usage scans
 *   { type: "done", ok, status, message, job }             at the end
 */
export function pipeJob(id: string, emit: (e: Record<string, unknown>) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const seen = new Map<string, string>();
    let lastProgress = "";
    let finished = false;
    let off: () => void = () => undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      off();
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const push = (j: StorageJob) => {
      if (finished) return;
      for (const s of j.steps) {
        if (s.status === "pending") continue;
        const sig = `${s.status}|${s.detail ?? ""}|${s.error ?? ""}`;
        if (seen.get(s.id) === sig) continue;
        seen.set(s.id, sig);
        emit({ type: "step", id: s.id, text: s.label, state: s.status, undo: s.undo, detail: s.detail, error: s.error });
      }
      if (j.progress) {
        const p = `${j.progress.done}/${j.progress.total}`;
        if (p !== lastProgress) {
          lastProgress = p;
          emit({ type: "progress", done: j.progress.done, total: j.progress.total });
        }
      }
      if (j.status !== "running") {
        const result = j.result as { message?: string } | null;
        emit({ type: "done", ok: j.status === "done", status: j.status, message: j.error ?? result?.message ?? "Done.", job: j });
        finish();
      }
    };
    off = followJob(id, push);
    signal.addEventListener("abort", finish);
    const job = getJob(id);
    if (!job) {
      emit({ type: "error", message: "That operation doesn't exist (any more)." });
      finish();
      return;
    }
    emit({ type: "job", job });
    push(job);
  });
}

// ---------------------------------------------------------------- lock

type G = typeof globalThis & { __gluonStorageLock?: { label: string; since: number } | null };
const g = globalThis as G;

/** Only one change to disks/mounts/fstab at a time. */
export function acquireLock(label: string): () => void {
  const cur = g.__gluonStorageLock;
  if (cur) throw conflict(`Another storage change is in progress (${cur.label}). Wait for it to finish, then try again.`);
  g.__gluonStorageLock = { label, since: Date.now() };
  let released = false;
  return () => {
    if (released) return;
    released = true;
    g.__gluonStorageLock = null;
  };
}

export async function withLock<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const release = acquireLock(label);
  try {
    return await fn();
  } finally {
    release();
  }
}

export function currentLock() {
  return g.__gluonStorageLock ?? null;
}
