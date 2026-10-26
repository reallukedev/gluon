import type { RatePointT } from "@/lib/router-types";

/**
 * Throughput from the router's byte counters, and what changed between two readings. Pure, so
 * the maths is tested without a router.
 */

export interface Sample {
  t: number;
  rx: number;
  tx: number;
  /** When the router last started, as worked out from its uptime at `t`. */
  boot: number | null;
}

/** Two boot times this close are the same boot (uptime is read in whole seconds, over a slow page). */
const SAME_BOOT_MS = 120_000;
/** Longer than this between readings and the average says nothing about "then". */
export const MAX_GAP_MS = 10 * 60_000;

export const sameBoot = (a: number | null, b: number | null) => a === null || b === null || Math.abs(a - b) < SAME_BOOT_MS;

/**
 * Bytes per second between consecutive samples. A restart or a cleared counter (the counters go
 * backwards) or a long gap gives a null point rather than a nonsense spike.
 */
export function rates(samples: Sample[]): RatePointT[] {
  const out: RatePointT[] = [];
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    const dt = (b.t - a.t) / 1000;
    if (dt <= 0) continue;
    const broken = !sameBoot(a.boot, b.boot) || b.rx < a.rx || b.tx < a.tx || b.t - a.t > MAX_GAP_MS;
    out.push(broken ? { t: b.t, rx: null, tx: null } : { t: b.t, rx: (b.rx - a.rx) / dt, tx: (b.tx - a.tx) / dt });
  }
  return out;
}

/** The latest rate, if it was measured recently over a short enough interval to mean "now". */
export function current(samples: Sample[], at: number, freshMs = 3 * 60_000): { rx: number; tx: number; at: number } | null {
  const last = rates(samples.slice(-2)).at(-1);
  if (!last || last.rx === null || last.tx === null || at - last.t > freshMs) return null;
  const prev = samples.at(-2)!;
  if (last.t - prev.t > freshMs) return null;
  return { rx: last.rx, tx: last.tx, at: last.t };
}

/**
 * Average throughput per fixed time bucket (bytes moved over time measured), so a day read every
 * 15 seconds at some times and every 2 minutes at others draws as one even line. A bucket with no
 * usable interval (a restart, a gap, nothing read) is null.
 */
export function buckets(samples: Sample[], from: number, to: number, step: number): RatePointT[] {
  const n = Math.max(0, Math.ceil((to - from) / step));
  const acc = Array.from({ length: n }, () => ({ rx: 0, tx: 0, s: 0 }));
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]!;
    const b = samples[i]!;
    if (b.t <= a.t || !sameBoot(a.boot, b.boot) || b.rx < a.rx || b.tx < a.tx || b.t - a.t > MAX_GAP_MS) continue;
    const k = Math.floor((b.t - from) / step);
    if (k < 0 || k >= n) continue;
    acc[k]!.rx += b.rx - a.rx;
    acc[k]!.tx += b.tx - a.tx;
    acc[k]!.s += (b.t - a.t) / 1000;
  }
  return acc.map((x, k) => ({ t: from + (k + 1) * step, rx: x.s ? x.rx / x.s : null, tx: x.s ? x.tx / x.s : null }));
}

// ---------------------------------------------------------------- what changed

export interface Reading {
  at: number;
  boot: number | null;
  broadband: boolean | null;
}

export interface Seen {
  /** The router's boot time Gluon last saw. */
  boot: number | null;
  /** Broadband as of the last reading that settled it, and since when. */
  broadband: boolean | null;
  since: number | null;
  /** Readings in a row that found broadband down, and when the first of them was (one could be a blip). */
  downReads: number;
  firstDownAt: number | null;
  /** A later boot time seen once: it counts as a restart when the next reading agrees. */
  newBoot?: number | null;
}

export type Change = { kind: "restarted"; at: number; upFor: number | null } | { kind: "broadband-down"; at: number } | { kind: "broadband-up"; at: number; downFor: number | null };

/** Compare a new reading with what Gluon saw before; return the new state and what happened. */
export function compare(seen: Seen | null, r: Reading): { seen: Seen; changes: Change[] } {
  const prev: Seen = seen ?? { boot: null, broadband: null, since: null, downReads: 0, firstDownAt: null };
  const next: Seen = { ...prev, boot: prev.boot ?? r.boot, newBoot: null };
  const changes: Change[] = [];
  if (prev.boot !== null && r.boot !== null && r.boot - prev.boot >= SAME_BOOT_MS) {
    // One reading could be a stale page; two that agree are a restart.
    if (prev.newBoot != null && sameBoot(prev.newBoot, r.boot)) {
      changes.push({ kind: "restarted", at: prev.newBoot, upFor: prev.newBoot - prev.boot });
      next.boot = prev.newBoot;
    } else next.newBoot = r.boot;
  }
  if (r.broadband === false) {
    next.downReads = prev.downReads + 1;
    next.firstDownAt = prev.firstDownAt ?? r.at;
    // Down on two readings in a row before it counts.
    if (prev.broadband !== false && next.downReads >= 2) {
      changes.push({ kind: "broadband-down", at: next.firstDownAt });
      next.broadband = false;
      next.since = next.firstDownAt;
    }
  } else if (r.broadband === true) {
    if (prev.broadband === false) changes.push({ kind: "broadband-up", at: r.at, downFor: prev.since !== null ? r.at - prev.since : null });
    next.since = prev.broadband === true ? prev.since : r.at;
    next.broadband = true;
    next.downReads = 0;
    next.firstDownAt = null;
  }
  return { seen: next, changes };
}
