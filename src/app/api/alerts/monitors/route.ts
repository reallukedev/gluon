import { z } from "zod";
import { route } from "@/server/api";
import { audit } from "@/server/audit";
import { all } from "@/server/db";
import { monitorInputSchema, type StripBucket } from "@/lib/alerts-types";
import { createUserMonitor, listMonitorViews, monitorView } from "@/server/monitors/service";
import { stripsAll } from "@/server/monitors/stats";

const QUARTER = 15 * 60_000;

/** 96 quarter-hour buckets for the last 24 hours, straight from the raw checks (one indexed query per monitor). */
function quarterStrip(monitorId: string, end: number): StripBucket[] {
  const start = end - 95 * QUARTER;
  const rows = all<{ b: number; checks: number; ok: number; lat: number | null }>(
    `SELECT CAST((at - ?) / ? AS INTEGER) AS b, COUNT(*) AS checks, SUM(ok) AS ok, AVG(CASE WHEN ok = 1 THEN latency_ms END) AS lat
     FROM monitor_checks WHERE monitor_id = ? AND at >= ? GROUP BY b`,
    start,
    QUARTER,
    monitorId,
    start,
  );
  const by = new Map(rows.map((r) => [Math.floor(r.b), r]));
  return Array.from({ length: 96 }, (_, i) => {
    const r = by.get(i);
    const checks = r?.checks ?? 0;
    const ok = r?.ok ?? 0;
    return {
      start: start + i * QUARTER,
      checks,
      ok,
      ratio: checks ? ok / checks : null,
      state: checks === 0 ? "none" : ok === checks ? "up" : ok / checks < 0.5 ? "down" : "partial",
      avgMs: r?.lat === null || r?.lat === undefined ? null : Math.round(r.lat),
    } satisfies StripBucket;
  });
}

const query = z.object({
  /**
   * The history each monitor carries in `strip`:
   * 24h = 96 quarter-hours, 7d = 168 hours; omitted = the last 48 hours by hour.
   */
  range: z.enum(["24h", "7d"]).optional(),
});

/** Every monitor with its current state, uptime, latency percentiles and a history strip. */
export const GET = route({ auth: "admin", query }, ({ query }) => {
  const views = listMonitorViews();
  if (query.range === "7d") {
    const strips = stripsAll(168);
    return views.map((v) => ({ ...v, strip: strips.get(v.id) ?? v.strip }));
  }
  if (query.range === "24h") {
    const t = Date.now();
    const end = t - (t % QUARTER);
    return views.map((v) => ({ ...v, strip: quarterStrip(v.id, end) }));
  }
  return views;
});

export const POST = route({ auth: "admin", body: monitorInputSchema }, ({ user, body, ip, zone }) => {
  const m = createUserMonitor(body);
  audit(user, { action: "monitor.created", target: m.id, summary: `Started watching ${m.name} (${m.target})` }, { ip, zone });
  return monitorView(m.id);
});
