import "server-only";
import { ensureSetupCode } from "./auth/setup";
import { pruneSessions } from "./auth/session";
import { pruneAttempts } from "./auth/ratelimit";
import { pruneActivity } from "./audit";

type G = typeof globalThis & { __gluonJobs?: boolean; __gluonTimers?: ReturnType<typeof setInterval>[] };
const g = globalThis as G;

/** Registry so feature modules can add background work without touching this file much. */
const starters: { name: string; start: () => void | Promise<void> }[] = [];
export function onStart(name: string, start: () => void | Promise<void>) {
  starters.push({ name, start });
}

export function every(ms: number, fn: () => unknown, opts: { immediate?: boolean } = {}) {
  // A slow run (a hung host command, a big scan) mustn't stack up behind itself: skip a tick
  // while the previous one is still going.
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (e) {
      console.error("[gluon] job failed", e);
    } finally {
      busy = false;
    }
  };
  if (opts.immediate) void run();
  const t = setInterval(run, ms);
  t.unref?.();
  (g.__gluonTimers ??= []).push(t);
  return t;
}

export async function startJobs() {
  if (g.__gluonJobs) return;
  g.__gluonJobs = true;
  ensureSetupCode();
  every(60 * 60_000, () => {
    pruneSessions();
    pruneAttempts();
    pruneActivity();
  }, { immediate: true });

  // Feature modules (imported for their side effects) register their own jobs.
  await import("./modules");
  for (const s of starters) {
    try {
      await s.start();
    } catch (e) {
      console.error(`[gluon] failed to start ${s.name}`, e);
    }
  }
}
