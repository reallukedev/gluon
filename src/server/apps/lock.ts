import "server-only";
import { conflict } from "../errors";

/** A move holds its original and new ids for the whole move. In memory, since Gluon runs as one process. */

type G = typeof globalThis & { __gluonAppLocks?: Map<string, { token: symbol; what: string }> };
const g = globalThis as G;
const locks = (g.__gluonAppLocks ??= new Map());

export interface AppLock {
  /** Add more ids to the same lock (a move learns its new id after planning). */
  extend(id: string): void;
  release(): void;
}

export function lockedBy(id: string): string | null {
  return locks.get(id)?.what ?? null;
}

/**
 * Mid-move the original's containers are stopped and its volumes look unused, but they're the copy
 * Gluon promised to keep.
 */
export function assertNoAppWork(what: string) {
  const held = [...new Set([...locks.values()].map((l) => l.what))];
  if (held.length) throw conflict(`Gluon won't ${what} right now: ${held[0]}. Try again when it's done.`);
}

/** For re-checking right before a destructive step. */
export function assertFree(id: string, mine?: AppLock) {
  const l = locks.get(id);
  if (l && (!mine || !(mine as Lock).owns(l.token))) throw conflict(`Wait a moment: ${l.what}.`);
}

class Lock implements AppLock {
  private token = Symbol("app-lock");
  private ids = new Set<string>();
  constructor(private what: string) {}
  owns(t: symbol) {
    return t === this.token;
  }
  extend(id: string) {
    assertFree(id, this);
    locks.set(id, { token: this.token, what: this.what });
    this.ids.add(id);
  }
  release() {
    for (const id of this.ids) if (locks.get(id)?.token === this.token) locks.delete(id);
    this.ids.clear();
  }
}

/** All or none. */
export function lockApps(ids: string[], what: string): AppLock {
  for (const id of ids) assertFree(id);
  const l = new Lock(what);
  for (const id of ids) l.extend(id);
  return l;
}

export async function withAppLock<T>(ids: string[], what: string, fn: (lock: AppLock) => Promise<T>): Promise<T> {
  const l = lockApps(ids, what);
  try {
    return await fn(l);
  } finally {
    l.release();
  }
}
