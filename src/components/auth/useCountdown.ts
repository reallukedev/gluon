"use client";
import * as React from "react";

/**
 * Seconds left until `until` (a Date.now() timestamp), ticking once a second, 0 when done or unset.
 * Used to show "try again in 0:42" after too many sign-in attempts.
 */
export function useCountdown(until: number | null): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!until) return;
    setNow(Date.now());
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      if (n >= until) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
}

export function clock(seconds: number): string {
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Seconds to wait from an ApiError's details, if it was a throttle. */
export function retryAfterOf(e: unknown): number | null {
  const d = (e as { code?: string; details?: Record<string, unknown> } | null) ?? null;
  if (d?.code !== "rate_limited") return null;
  const n = Number(d.details?.retryAfter);
  return Number.isFinite(n) && n > 0 ? n : null;
}
