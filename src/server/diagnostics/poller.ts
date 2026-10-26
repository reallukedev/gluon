import "server-only";

/**
 * One sampler per kind of live data, shared by every open SSE stream: it runs while at least one
 * client is subscribed and stops when the last one leaves. Runs never overlap.
 */

interface Poll<T> {
  intervalMs: number;
  fn: () => Promise<T>;
  subs: Set<{ onData: (v: T) => void; onError?: (e: Error) => void }>;
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
  latest: T | null;
  latestAt: number;
}

type G = typeof globalThis & { __gluonPolls?: Map<string, Poll<unknown>> };
const g = globalThis as G;
const polls = () => (g.__gluonPolls ??= new Map());

export function sharedPoll<T>(key: string, intervalMs: number, fn: () => Promise<T>) {
  let p = polls().get(key) as Poll<T> | undefined;
  if (!p) {
    p = { intervalMs, fn, subs: new Set(), timer: null, running: false, latest: null, latestAt: 0 };
    polls().set(key, p as Poll<unknown>);
  }
  // Keep the newest implementation (dev reloads).
  p.fn = fn;
  const poll = p;

  const tick = async () => {
    if (poll.running) return;
    poll.running = true;
    try {
      const v = await poll.fn();
      poll.latest = v;
      poll.latestAt = Date.now();
      for (const s of poll.subs) s.onData(v);
    } catch (e) {
      for (const s of poll.subs) s.onError?.(e as Error);
    } finally {
      poll.running = false;
    }
  };

  return {
    subscribe(onData: (v: T) => void, onError?: (e: Error) => void): () => void {
      const sub = { onData, onError };
      poll.subs.add(sub);
      if (poll.latest !== null && Date.now() - poll.latestAt < poll.intervalMs * 2) onData(poll.latest);
      if (!poll.timer) {
        void tick();
        poll.timer = setInterval(() => void tick(), poll.intervalMs);
        poll.timer.unref?.();
      }
      return () => {
        poll.subs.delete(sub);
        if (!poll.subs.size && poll.timer) {
          clearInterval(poll.timer);
          poll.timer = null;
        }
      };
    },
    /** Run now (outside the schedule), e.g. for a one-off JSON request. */
    async once(): Promise<T> {
      if (poll.latest !== null && Date.now() - poll.latestAt < poll.intervalMs) return poll.latest;
      return poll.fn();
    },
  };
}
