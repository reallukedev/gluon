import "server-only";
import { ndjson } from "../api";
import { conflict } from "../errors";
import { publish as publishEvent } from "../events";
import type { JobEvent, JobKind, JobSnapshot } from "@/lib/builder-types";

/**
 * Long builder operations (publish, build, remove) run as jobs that outlive the request that
 * started them: closing the tab doesn't stop an install halfway. Each job keeps its events so a
 * page opened later shows the whole run, and a second click attaches instead of starting again.
 */

interface Job extends JobSnapshot {
  appId: string;
  listeners: Set<(e: JobEvent) => void>;
  done: Promise<void>;
}

type G = typeof globalThis & { __gluonBuilderJobs?: Map<string, Job> };
const g = globalThis as G;
const jobs = (g.__gluonBuilderJobs ??= new Map<string, Job>());

export type Emit = (e: JobEvent) => void;

export function currentJob(appId: string): JobSnapshot | null {
  const j = jobs.get(appId);
  if (!j) return null;
  // Finished jobs are shown for a while, then forgotten.
  if (j.finishedAt && Date.now() - j.finishedAt > 30 * 60_000) {
    jobs.delete(appId);
    return null;
  }
  return { kind: j.kind, startedAt: j.startedAt, finishedAt: j.finishedAt, ok: j.ok, events: j.events.slice(-400), stages: j.stages };
}

export function isRunning(appId: string) {
  const j = jobs.get(appId);
  return !!j && !j.finishedAt;
}

export function runningJobs(): { appId: string; kind: JobKind; startedAt: number }[] {
  return [...jobs.values()].filter((j) => !j.finishedAt).map((j) => ({ appId: j.appId, kind: j.kind, startedAt: j.startedAt }));
}

export function clearJob(appId: string) {
  const j = jobs.get(appId);
  if (j?.finishedAt) jobs.delete(appId);
}

/**
 * Start a job, or refuse when one is running. `run` returns the final message; throwing an
 * AppError ends it as a failure with that message.
 */
export function startJob(appId: string, kind: JobKind, stages: { key: string; label: string }[], run: (emit: Emit) => Promise<{ ok: boolean; message: string; detail?: string[] }>): Job {
  const existing = jobs.get(appId);
  if (existing && !existing.finishedAt) throw conflict(existing.kind === kind ? "That's already running." : `Wait for the ${existing.kind === "build" ? "build" : existing.kind === "remove" ? "removal" : "publish"} to finish first.`);
  const job: Job = { appId, kind, stages, startedAt: Date.now(), finishedAt: null, ok: null, events: [], listeners: new Set(), done: Promise.resolve() };
  const emit: Emit = (e) => {
    if (e.type === "line" && job.events.length > 6000) job.events.splice(0, 1000);
    job.events.push(e);
    for (const l of job.listeners) l(e);
  };
  job.done = (async () => {
    try {
      const r = await run(emit);
      job.ok = r.ok;
      emit({ type: "done", ok: r.ok, message: r.message, detail: r.detail });
    } catch (e) {
      job.ok = false;
      const message = e instanceof Error && "code" in e ? e.message : "Something went wrong on the server. It's been logged.";
      if (!(e instanceof Error && "code" in e)) console.error("[gluon] builder job failed", e);
      emit({ type: "done", ok: false, message, detail: (e as { details?: { lines?: string[] } })?.details?.lines });
    } finally {
      job.finishedAt = Date.now();
      publishEvent("apps.changed", { customApp: appId });
    }
  })();
  jobs.set(appId, job);
  return job;
}

/** Stream a job's events (from the start) as NDJSON until it ends or the client leaves. */
export function streamJob(appId: string, signal: AbortSignal): Response {
  const job = jobs.get(appId);
  return ndjson(async (emit) => {
    if (!job) return;
    emit({ type: "plan", stages: job.stages, kind: job.kind });
    const seen = job.events.length;
    for (const e of job.events.slice(0, seen)) emit(e);
    if (job.finishedAt) return;
    await new Promise<void>((resolve) => {
      const l = (e: JobEvent) => {
        emit(e);
        if (e.type === "done") finish();
      };
      const finish = () => {
        job.listeners.delete(l);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      job.listeners.add(l);
      signal.addEventListener("abort", finish);
      void job.done.then(finish);
    });
  }, signal);
}
