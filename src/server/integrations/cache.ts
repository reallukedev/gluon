import "server-only";
import { AppError } from "../errors";

/**
 * In-memory TTL cache for upstream data.
 * - concurrent callers for the same key share one request
 * - failures are remembered briefly so a dead app isn't hammered by every open Home page
 * - when a refresh fails, the last good value is served (marked stale) for `staleMs`
 */

interface Entry {
  value?: unknown;
  at?: number;
  pending?: Promise<unknown>;
  error?: AppError;
  errorAt?: number;
  touched: number;
}

export interface Cached<T> {
  value: T;
  fetchedAt: number;
  stale: { message: string } | null;
}

type G = typeof globalThis & { __gluonWidgetCache?: Map<string, Entry> };
const g = globalThis as G;
const store = (g.__gluonWidgetCache ??= new Map());
const MAX_ENTRIES = 2000;

function evict() {
  if (store.size <= MAX_ENTRIES) return;
  const victims = [...store.entries()].filter(([, e]) => !e.pending).sort((a, b) => a[1].touched - b[1].touched);
  for (const [k] of victims.slice(0, store.size - MAX_ENTRIES + 100)) store.delete(k);
}

function asAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  console.error("[gluon] widget source failed", e);
  return new AppError("upstream", "Couldn't get that data just now.", 502);
}

export async function cached<T>(key: string, ttlMs: number, load: () => Promise<T>, opts: { staleMs?: number } = {}): Promise<Cached<T>> {
  const now = Date.now();
  let e = store.get(key);
  if (!e) {
    e = { touched: now };
    store.set(key, e);
    evict();
  }
  e.touched = now;
  if (e.at !== undefined && now - e.at < ttlMs) return { value: e.value as T, fetchedAt: e.at, stale: null };

  const negativeMs = Math.min(Math.max(ttlMs / 2, 3000), 30_000);
  const serveStaleOr = (err: AppError): Cached<T> => {
    if (e!.at !== undefined && opts.staleMs && Date.now() - e!.at < opts.staleMs) {
      return { value: e!.value as T, fetchedAt: e!.at, stale: { message: err.message } };
    }
    throw err;
  };
  if (e.error && e.errorAt !== undefined && now - e.errorAt < negativeMs) return serveStaleOr(e.error);

  if (!e.pending) {
    const entry = e;
    entry.pending = load()
      .then((v) => {
        entry.value = v;
        entry.at = Date.now();
        entry.error = undefined;
        entry.errorAt = undefined;
        return v;
      })
      .catch((err) => {
        entry.error = asAppError(err);
        entry.errorAt = Date.now();
        throw entry.error;
      })
      .finally(() => {
        entry.pending = undefined;
      });
    entry.pending.catch(() => {});
  }
  try {
    await e.pending;
    return { value: e.value as T, fetchedAt: e.at!, stale: null };
  } catch (err) {
    return serveStaleOr(asAppError(err));
  }
}

/** Drop every cached entry whose key starts with `prefix` (e.g. after an integration changes). */
export function invalidate(prefix: string) {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
}

export function pruneCache(maxIdleMs = 60 * 60_000) {
  const cutoff = Date.now() - maxIdleMs;
  for (const [k, e] of store) if (!e.pending && e.touched < cutoff) store.delete(k);
}
