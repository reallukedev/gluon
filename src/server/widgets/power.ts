import "server-only";
import fs from "node:fs";
import { db, now } from "../db";
import { history } from "../metrics/sampler";
import { hostPath } from "../host/paths";
import type { PowerData } from "@/lib/home-widgets-types";

/**
 * The processor's power draw from Intel RAPL (also exposed by recent kernels on AMD Zen): each package's
 * `energy_uj` counter under /sys/class/powercap, read every 10 seconds. The counter wraps at `max_energy_range_uj`.
 * Only package domains are summed (package-0, package-1…): DRAM, the disks and the rest of the machine aren't
 * measured, and the widget says so.
 *
 * Minute averages go into the shared `metrics` table as `power.package` (watts), so they get the same hourly
 * rollup and 400-day retention as every other metric.
 */

const ROOT = "/sys/class/powercap";
const KEY = "power.package";
const EVERY_MS = 10_000;
const LIVE_KEEP = 90; // 15 minutes at 10 s

interface Domain {
  name: string;
  dir: string;
  max: number;
  prev: number | null;
}

type G = typeof globalThis & {
  __gluonPower?: {
    domains: Domain[] | null;
    reason: string | null;
    prevAt: number | null;
    live: [number, number][];
    minute: { ts: number; joules: number; seconds: number } | null;
    timer?: ReturnType<typeof setInterval>;
  };
};
const g = globalThis as G;
const st = () => (g.__gluonPower ??= { domains: null, reason: null, prevAt: null, live: [], minute: null });

function readNum(file: string): number | null {
  try {
    const n = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Find the package domains once. Sets `reason` when there's nothing to read. */
export function discoverPower(): { domains: Domain[]; reason: string | null } {
  const s = st();
  if (s.domains) return { domains: s.domains, reason: s.reason };
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(hostPath(ROOT));
  } catch {
    s.domains = [];
    s.reason = "This machine doesn't report its processor's power draw to Linux (there's no power meter under /sys/class/powercap).";
    return { domains: [], reason: s.reason };
  }
  const found: Domain[] = [];
  let unreadable = false;
  for (const e of entries.sort()) {
    // Top-level zones only: intel-rapl:0, intel-rapl:1 (sub-zones like intel-rapl:0:0 are parts of a package).
    if (!/^intel-rapl:\d+$/.test(e)) continue;
    const dir = hostPath(`${ROOT}/${e}`);
    let name = "";
    try {
      name = fs.readFileSync(`${dir}/name`, "utf8").trim();
    } catch {
      continue;
    }
    if (!/^package-\d+$/.test(name)) continue;
    const energy = readNum(`${dir}/energy_uj`);
    const max = readNum(`${dir}/max_energy_range_uj`);
    if (energy === null || max === null || max <= 0) {
      unreadable = true;
      continue;
    }
    found.push({ name, dir, max, prev: null });
  }
  s.domains = found;
  s.reason = found.length
    ? null
    : unreadable
      ? "The processor has a power meter, but Gluon isn't allowed to read it. It needs to run as root in a privileged container."
      : "This processor doesn't report its power draw to Linux.";
  return { domains: found, reason: s.reason };
}

function flushMinute() {
  const s = st();
  const m = s.minute;
  if (!m || m.seconds < 5) return;
  db()
    .prepare("INSERT OR REPLACE INTO metrics (key, ts, value) VALUES (?, ?, ?)")
    .run(KEY, m.ts, m.joules / m.seconds);
}

function sample() {
  const s = st();
  const { domains } = discoverPower();
  if (!domains.length) return;
  const t = now();
  let joules = 0;
  let complete = true;
  for (const d of domains) {
    const e = readNum(`${d.dir}/energy_uj`);
    if (e === null) {
      complete = false;
      continue;
    }
    if (d.prev !== null) {
      const delta = e >= d.prev ? e - d.prev : d.max - d.prev + e; // the counter wrapped
      joules += delta / 1e6;
    } else complete = false;
    d.prev = e;
  }
  const dt = s.prevAt !== null ? (t - s.prevAt) / 1000 : 0;
  s.prevAt = t;
  // Skip the first reading, and any interval stretched by a paused process (a sleep, a debugger).
  if (!complete || dt <= 0 || dt > (EVERY_MS / 1000) * 6) return;
  const watts = joules / dt;
  if (!Number.isFinite(watts) || watts < 0 || watts > 2000) return;
  s.live.push([t, watts]);
  if (s.live.length > LIVE_KEEP) s.live.shift();

  const bucket = Math.floor(t / 60_000) * 60_000;
  if (s.minute && s.minute.ts !== bucket) {
    flushMinute();
    s.minute = null;
  }
  const m = (s.minute ??= { ts: bucket, joules: 0, seconds: 0 });
  m.joules += joules;
  m.seconds += dt;
}

export function startPowerSampler() {
  const s = st();
  if (s.timer) return;
  if (!discoverPower().domains.length) return;
  sample();
  s.timer = setInterval(() => {
    try {
      sample();
    } catch (e) {
      console.error("[gluon] power sample failed", e);
    }
  }, EVERY_MS);
  s.timer.unref?.();
}

export function powerAvailable(): { available: boolean; reason: string | null } {
  const { domains, reason } = discoverPower();
  return { available: domains.length > 0, reason };
}

/** Average of [ts, v] points into buckets of `ms`. */
function buckets(points: [number, number][], ms: number): [number, number][] {
  const m = new Map<number, { sum: number; n: number }>();
  for (const [t, v] of points) {
    const b = Math.floor(t / ms) * ms;
    const x = m.get(b) ?? { sum: 0, n: 0 };
    x.sum += v;
    x.n++;
    m.set(b, x);
  }
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([t, x]) => [t, x.sum / x.n]);
}

export function powerData(dayStart: number): PowerData {
  const s = st();
  const { domains, reason } = discoverPower();
  if (!domains.length) return { available: false, reason: reason ?? "This processor doesn't report its power draw to Linux." };
  const t = now();
  const lastLive = s.live.at(-1) ?? null;
  const fresh = lastLive && t - lastLive[0] < EVERY_MS * 3 ? lastLive : null;
  // Smooth "now" over the last 30 seconds so the figure doesn't flicker between readings.
  const recent = s.live.filter(([ts]) => ts > t - 30_000);
  const watts = fresh && recent.length ? recent.reduce((a, [, w]) => a + w, 0) / recent.length : null;

  const minutes = history([KEY], 86_400_000)[KEY] ?? [];
  // Include the minute in progress so the last point isn't a minute behind.
  const current = s.minute && s.minute.seconds >= 5 ? ([[s.minute.ts, s.minute.joules / s.minute.seconds]] as [number, number][]) : [];
  const withNow = [...minutes.filter(([ts]) => ts !== s.minute?.ts), ...current];

  const hour = withNow.filter(([ts]) => ts >= t - 3_600_000);
  const day = buckets(withNow, 10 * 60_000);

  const start = Math.max(dayStart, t - 2 * 86_400_000);
  const today = withNow.filter(([ts]) => ts >= Math.floor(start / 60_000) * 60_000);
  const todayWh = today.reduce((a, [, w]) => a + w / 60, 0);
  const elapsedMin = Math.max(1, (t - start) / 60_000);
  const todayCoverage = Math.min(1, today.length / elapsedMin);

  // A week of hourly averages (or whatever there is) for the monthly estimate.
  // (Hourly points; with only a few hours of history, the minute points are the better basis.)
  const week = history([KEY], 7 * 86_400_000)[KEY] ?? [];
  const basis = week.length >= 3 ? week : withNow;
  const avgWatts = basis.length ? basis.reduce((a, [, w]) => a + w, 0) / basis.length : watts;
  const avgHours = basis.length > 1 ? Math.round((basis.at(-1)![0] - basis[0]![0]) / 3_600_000) : 0;

  return {
    available: true,
    domains: domains.map((d) => d.name),
    watts: watts !== null ? Math.round(watts * 10) / 10 : null,
    at: fresh?.[0] ?? null,
    hour: hour.map(([ts, w]) => [ts, Math.round(w * 10) / 10]),
    day: day.map(([ts, w]) => [ts, Math.round(w * 10) / 10]),
    todayWh: Math.round(todayWh * 10) / 10,
    todayCoverage: Math.round(todayCoverage * 100) / 100,
    avgWatts: avgWatts !== null ? Math.round(avgWatts * 10) / 10 : null,
    avgHours,
  };
}
