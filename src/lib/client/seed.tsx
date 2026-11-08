"use client";
import * as React from "react";

/**
 * How old the data a page was rendered with is, so hooks can skip refetching what the server has only just read.
 * Ages compare the server's clock with this device's, so every estimate here errs towards older.
 */

/** Server clock minus this device's clock, at most. null until something has told us. */
let offset: number | null = null;

/** `serverMs` is no earlier than the server's clock when it answered; `sentAt` is when this device asked. */
export function noteServerTime(serverMs: number, sentAt: number) {
  if (Number.isFinite(serverMs) && Number.isFinite(sentAt)) offset = serverMs - sentAt;
}

/** When this document was requested, on this device's clock. The server read its data after that. */
function documentRequestedAt(): number {
  const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  return performance.timeOrigin + (nav?.requestStart || 0);
}

/** Tells the client what time the server thought it was when it rendered this document. */
export function ServerClock({ now }: { now: number }) {
  React.useEffect(() => {
    if (offset === null) noteServerTime(now, documentRequestedAt());
  }, [now]);
  return null;
}

const SeedTime = React.createContext<number | null>(null);

/** Wraps a page whose views get server-read data as props; `at` is the server's clock before it read any of it. */
export function Seeded({ at, children }: { at: number; children: React.ReactNode }) {
  return <SeedTime value={at}>{children}</SeedTime>;
}

/** The most the seeded data can have aged, in ms, or null when that can't be known. Call during render. */
export function useSeedAge(hydrating: boolean): () => number | null {
  const at = React.use(SeedTime);
  return () => {
    if (typeof window === "undefined") return null;
    // Hydrating: the data came with this document.
    if (hydrating) return Date.now() - documentRequestedAt();
    // A client navigation: the page's payload may have been prefetched a while ago.
    if (at === null || offset === null) return null;
    return Date.now() + offset - at;
  };
}
