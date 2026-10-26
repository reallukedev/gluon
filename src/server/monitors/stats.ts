import "server-only";
import { all, now, one, run } from "../db";
import type { MonitorCheck, StripBucket } from "@/lib/alerts-types";

/**
 * Check history and the numbers derived from it. Raw checks live in monitor_checks (90 days);
 * monitor_hours keeps an hourly roll-up (400 days) so uptime over long windows and the history
 * strips never scan raw rows.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;
export const RAW_RETENTION_MS = 90 * DAY;
const HOURLY_RETENTION_MS = 400 * DAY;

export const hourStart = (t: number) => t - (t % HOUR);

export function recordCheck(monitorId: string, at: number, r: { ok: boolean; latencyMs: number | null; status: number | null; error: string | null }) {
  run(
    "INSERT INTO monitor_checks (monitor_id, at, ok, latency_ms, status, error) VALUES (?, ?, ?, ?, ?, ?)",
    monitorId,
    at,
    r.ok ? 1 : 0,
    r.latencyMs,
    r.status,
    r.error,
  );
  const lat = r.ok && r.latencyMs !== null ? r.latencyMs : null;
  run(
    `INSERT INTO monitor_hours (monitor_id, hour, checks, ok, latency_sum, latency_n, latency_max) VALUES (?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(monitor_id, hour) DO UPDATE SET checks = checks + 1, ok = ok + excluded.ok,
       latency_sum = latency_sum + excluded.latency_sum, latency_n = latency_n + excluded.latency_n,
       latency_max = MAX(COALESCE(latency_max, 0), COALESCE(excluded.latency_max, 0))`,
    monitorId,
    hourStart(at),
    r.ok ? 1 : 0,
    lat ?? 0,
    lat === null ? 0 : 1,
    lat,
  );
}

interface CheckRow {
  at: number;
  ok: number;
  latency_ms: number | null;
  status: number | null;
  error: string | null;
}
const toCheck = (r: CheckRow): MonitorCheck => ({ at: r.at, ok: !!r.ok, latencyMs: r.latency_ms, status: r.status, error: r.error });

export function lastCheck(monitorId: string): MonitorCheck | null {
  const r = one<CheckRow>("SELECT at, ok, latency_ms, status, error FROM monitor_checks WHERE monitor_id = ? ORDER BY at DESC LIMIT 1", monitorId);
  return r ? toCheck(r) : null;
}

export function recentChecks(monitorId: string, limit = 200): MonitorCheck[] {
  return all<CheckRow>("SELECT at, ok, latency_ms, status, error FROM monitor_checks WHERE monitor_id = ? ORDER BY at DESC LIMIT ?", monitorId, limit).map(toCheck);
}

/** Failures in a row, counting back from the latest check. */
export function trailingFailures(monitorId: string): number {
  const rows = all<{ ok: number }>("SELECT ok FROM monitor_checks WHERE monitor_id = ? ORDER BY at DESC LIMIT 60", monitorId);
  let n = 0;
  for (const r of rows) {
    if (r.ok) break;
    n++;
  }
  return n;
}

/** Successes in a row, counting back from the latest check. */
export function trailingSuccesses(monitorId: string): number {
  const rows = all<{ ok: number }>("SELECT ok FROM monitor_checks WHERE monitor_id = ? ORDER BY at DESC LIMIT 20", monitorId);
  let n = 0;
  for (const r of rows) {
    if (!r.ok) break;
    n++;
  }
  return n;
}

/**
 * When did the current up/down run start? The hourly table finds the last hour that had the opposite
 * result, so this never scans more than an hour of raw checks.
 */
export function stateSince(monitorId: string, currentOk: boolean): number | null {
  const hour = one<{ hour: number | null }>(
    currentOk
      ? "SELECT MAX(hour) AS hour FROM monitor_hours WHERE monitor_id = ? AND ok < checks"
      : "SELECT MAX(hour) AS hour FROM monitor_hours WHERE monitor_id = ? AND ok > 0",
    monitorId,
  )?.hour ?? null;
  if (hour === null) {
    return one<{ at: number | null }>("SELECT MIN(at) AS at FROM monitor_checks WHERE monitor_id = ?", monitorId)?.at ?? null;
  }
  const lastOther = one<{ at: number | null }>(
    "SELECT MAX(at) AS at FROM monitor_checks WHERE monitor_id = ? AND at >= ? AND at < ? AND ok = ?",
    monitorId,
    hour,
    hour + HOUR,
    currentOk ? 0 : 1,
  )?.at ?? null;
  if (lastOther === null) return hour;
  return one<{ at: number | null }>("SELECT MIN(at) AS at FROM monitor_checks WHERE monitor_id = ? AND at > ?", monitorId, lastOther)?.at ?? null;
}

/** Times it went from passing to failing in the window (raw checks, not the "down" threshold). */
export function flips(monitorId: string, windowMs = HOUR): number {
  const rows = all<{ ok: number }>("SELECT ok FROM monitor_checks WHERE monitor_id = ? AND at > ? ORDER BY at", monitorId, now() - windowMs);
  let n = 0;
  for (let i = 1; i < rows.length; i++) if (rows[i - 1]!.ok && !rows[i]!.ok) n++;
  return n;
}

// ---------------------------------------------------------------- uptime & strips

interface HourRow {
  monitor_id: string;
  hour: number;
  checks: number;
  ok: number;
  latency_sum: number;
  latency_n: number;
}

export interface Uptime {
  h24: number | null;
  d7: number | null;
  d30: number | null;
  d90: number | null;
}

const pct = (ok: number, n: number) => (n > 0 ? Math.round((ok / n) * 100_000) / 1000 : null);

/** Uptime percentages for every monitor in one pass over the hourly table. */
export function uptimeAll(): Map<string, Uptime> {
  const t = now();
  const h24 = hourStart(t - DAY) + HOUR;
  const d7 = hourStart(t - 7 * DAY) + HOUR;
  const d30 = hourStart(t - 30 * DAY) + HOUR;
  const d90 = hourStart(t - 90 * DAY) + HOUR;
  const rows = all<{ monitor_id: string; c1: number | null; o1: number | null; c7: number | null; o7: number | null; c30: number | null; o30: number | null; c90: number | null; o90: number | null }>(
    `SELECT monitor_id,
       SUM(CASE WHEN hour >= ? THEN checks END) AS c1, SUM(CASE WHEN hour >= ? THEN ok END) AS o1,
       SUM(CASE WHEN hour >= ? THEN checks END) AS c7, SUM(CASE WHEN hour >= ? THEN ok END) AS o7,
       SUM(CASE WHEN hour >= ? THEN checks END) AS c30, SUM(CASE WHEN hour >= ? THEN ok END) AS o30,
       SUM(checks) AS c90, SUM(ok) AS o90
     FROM monitor_hours WHERE hour >= ? GROUP BY monitor_id`,
    h24,
    h24,
    d7,
    d7,
    d30,
    d30,
    d90,
  );
  const out = new Map<string, Uptime>();
  for (const r of rows) {
    out.set(r.monitor_id, { h24: pct(r.o1 ?? 0, r.c1 ?? 0), d7: pct(r.o7 ?? 0, r.c7 ?? 0), d30: pct(r.o30 ?? 0, r.c30 ?? 0), d90: pct(r.o90 ?? 0, r.c90 ?? 0) });
  }
  return out;
}

function bucketState(checks: number, ok: number): StripBucket["state"] {
  if (checks === 0) return "none";
  if (ok === checks) return "up";
  if (ok / checks < 0.5) return "down";
  return "partial";
}

/** Hourly buckets for the last `hours` hours (oldest first), for every monitor. */
export function stripsAll(hours = 48, only?: string): Map<string, StripBucket[]> {
  const end = hourStart(now());
  const start = end - (hours - 1) * HOUR;
  const rows = only
    ? all<HourRow>("SELECT * FROM monitor_hours WHERE monitor_id = ? AND hour >= ?", only, start)
    : all<HourRow>("SELECT * FROM monitor_hours WHERE hour >= ?", start);
  const by = new Map<string, Map<number, HourRow>>();
  for (const r of rows) {
    let m = by.get(r.monitor_id);
    if (!m) by.set(r.monitor_id, (m = new Map()));
    m.set(r.hour, r);
  }
  const out = new Map<string, StripBucket[]>();
  for (const [id, m] of by) {
    const buckets: StripBucket[] = [];
    for (let h = start; h <= end; h += HOUR) {
      const r = m.get(h);
      const checks = r?.checks ?? 0;
      const ok = r?.ok ?? 0;
      buckets.push({
        start: h,
        checks,
        ok,
        ratio: checks ? ok / checks : null,
        state: bucketState(checks, ok),
        avgMs: r && r.latency_n ? Math.round(r.latency_sum / r.latency_n) : null,
      });
    }
    out.set(id, buckets);
  }
  return out;
}

export function emptyStrip(hours = 48): StripBucket[] {
  const end = hourStart(now());
  return Array.from({ length: hours }, (_, i) => ({ start: end - (hours - 1 - i) * HOUR, checks: 0, ok: 0, ratio: null, state: "none" as const, avgMs: null }));
}

function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx]!;
}

const pctCache = new Map<string, { at: number; value: { p50: number | null; p95: number | null; p99: number | null } }>();

/** Response-time percentiles over successful checks in the last 24 h (cached 30 s). */
export function latencyPercentiles(monitorId: string, windowMs = DAY): { p50: number | null; p95: number | null; p99: number | null } {
  const hit = pctCache.get(monitorId);
  if (hit && now() - hit.at < 30_000) return hit.value;
  const vals = all<{ v: number }>(
    "SELECT latency_ms AS v FROM monitor_checks WHERE monitor_id = ? AND at > ? AND ok = 1 AND latency_ms IS NOT NULL ORDER BY latency_ms",
    monitorId,
    now() - windowMs,
  ).map((r) => r.v);
  const value = { p50: percentile(vals, 50), p95: percentile(vals, 95), p99: percentile(vals, 99) };
  pctCache.set(monitorId, { at: now(), value });
  return value;
}

/** Outages (runs of consecutive failures) in the last `windowMs`, newest first. */
export function incidents(monitorId: string, windowMs = 30 * DAY, limit = 50): { start: number; end: number | null; checks: number; error: string | null }[] {
  const rows = all<{ at: number; ok: number; error: string | null }>(
    "SELECT at, ok, error FROM monitor_checks WHERE monitor_id = ? AND at > ? ORDER BY at",
    monitorId,
    now() - windowMs,
  );
  const out: { start: number; end: number | null; checks: number; error: string | null }[] = [];
  let cur: { start: number; end: number | null; checks: number; error: string | null } | null = null;
  for (const r of rows) {
    if (!r.ok) {
      if (!cur) cur = { start: r.at, end: null, checks: 0, error: r.error };
      cur.checks++;
    } else if (cur) {
      cur.end = r.at;
      out.push(cur);
      cur = null;
    }
  }
  if (cur) out.push(cur);
  return out.reverse().slice(0, limit);
}

export function pruneChecks(monitorIds: string[]) {
  const t = now();
  for (const id of monitorIds) {
    run("DELETE FROM monitor_checks WHERE monitor_id = ? AND at < ?", id, t - RAW_RETENTION_MS);
  }
  run("DELETE FROM monitor_hours WHERE hour < ?", t - HOURLY_RETENTION_MS);
}
