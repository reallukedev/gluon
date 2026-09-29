import "server-only";
import net from "node:net";
import { all, db, now, one, run } from "../db";
import { readHostFileOr } from "../host/paths";
import type { InternetCell, InternetData, InternetOutage } from "@/lib/home-widgets-types";

/**
 * "Is it the internet or the server?" A light background probe: every 30 seconds Gluon opens (and immediately
 * closes) a TCP connection to two well-known public addresses on :443, and to the router. The handshake time is the
 * latency. No processes are spawned and nothing is downloaded. When a round fails, the next one comes sooner so an
 * outage's start and end are pinned to within ~10 seconds.
 *
 * Minutes are stored in `internet_minutes` for 7 days.
 */

export const TARGETS = ["1.1.1.1", "9.9.9.9"] as const;
const PORT = 443;
export const INTERVAL_MS = 30_000;
const RETRY_MS = 10_000;
const TIMEOUT_MS = 3_000;
const KEEP_MS = 7 * 86_400_000;
/** A minute is "slow" when it's this much slower than usual (and at least SLOW_FLOOR_MS). */
const SLOW_FACTOR = 3;
const SLOW_FLOOR_MS = 150;

type G = typeof globalThis & {
  __gluonInternet?: {
    timer?: ReturnType<typeof setTimeout>;
    running: boolean;
    last: { at: number; up: boolean; router: boolean | null; ms: number | null } | null;
    minute: { ts: number; rounds: number; up: number; routerDown: number; lost: number; probes: number; msSum: number; msN: number; msMax: number } | null;
    tableReady?: boolean;
  };
};
const g = globalThis as G;
const st = () => (g.__gluonInternet ??= { running: false, last: null, minute: null });

export function ensureInternetTable() {
  if (st().tableReady) return;
  db().exec(`
    CREATE TABLE IF NOT EXISTS internet_minutes (
      ts INTEGER PRIMARY KEY, rounds INTEGER NOT NULL, up INTEGER NOT NULL, router_down INTEGER NOT NULL,
      lost INTEGER NOT NULL, probes INTEGER NOT NULL, ms_sum REAL NOT NULL, ms_n INTEGER NOT NULL, ms_max REAL
    );
  `);
  st().tableReady = true;
}

// ---------------------------------------------------------------- probing

/** Handshake time in ms, or null. A refused connection still proves the host answered (for the router). */
function connect(host: string, port: number, refusedCounts: boolean): Promise<number | null> {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const sock = new net.Socket();
    let done = false;
    const finish = (v: number | null) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(v);
    };
    const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
    sock.setTimeout(TIMEOUT_MS, () => finish(null));
    sock.once("connect", () => finish(ms()));
    sock.once("error", (e: NodeJS.ErrnoException) => finish(refusedCounts && e.code === "ECONNREFUSED" ? ms() : null));
    sock.connect({ host, port });
  });
}

/** The default gateway from the host's routing table (lowest metric), or null. */
export function routerAddress(): string | null {
  const text = readHostFileOr("/proc/1/net/route", "");
  let best: { ip: string; metric: number } | null = null;
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8) continue;
    const [, dest, gw, flags, , , metric, mask] = f;
    if (dest !== "00000000" || mask !== "00000000" || !gw || gw === "00000000") continue;
    if (!(parseInt(flags ?? "0", 16) & 0x2)) continue;
    const n = parseInt(gw, 16);
    if (!Number.isFinite(n)) continue;
    const ip = [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255].join(".");
    const m = Number(metric ?? 0);
    if (!best || m < best.metric) best = { ip, metric: m };
  }
  return best?.ip ?? null;
}

async function probeRouter(ip: string | null): Promise<boolean | null> {
  if (!ip) return null;
  // Routers nearly always answer on DNS or their admin page; a refusal counts as an answer too.
  const r = await Promise.all([connect(ip, 53, true), connect(ip, 80, true)]);
  return r.some((x) => x !== null);
}

async function round() {
  const s = st();
  const at = now();
  const [results, router] = await Promise.all([Promise.all(TARGETS.map((h) => connect(h, PORT, false))), probeRouter(routerAddress())]);
  const answered = results.filter((x): x is number => x !== null);
  const up = answered.length > 0;
  const ms = up ? Math.min(...answered) : null;
  s.last = { at, up, router, ms };

  const bucket = Math.floor(at / 60_000) * 60_000;
  if (s.minute && s.minute.ts !== bucket) flush();
  const m = (s.minute ??= { ts: bucket, rounds: 0, up: 0, routerDown: 0, lost: 0, probes: 0, msSum: 0, msN: 0, msMax: 0 });
  m.rounds++;
  if (up) m.up++;
  if (!up && router === false) m.routerDown++;
  m.probes += results.length;
  m.lost += results.length - answered.length;
  if (ms !== null) {
    m.msSum += ms;
    m.msN++;
    m.msMax = Math.max(m.msMax, ms);
  }
  // Write the running minute straight away too, so the widget sees it without waiting for the minute to end.
  write(m);
  return up;
}

function write(m: NonNullable<ReturnType<typeof st>["minute"]>) {
  ensureInternetTable();
  run(
    `INSERT INTO internet_minutes (ts, rounds, up, router_down, lost, probes, ms_sum, ms_n, ms_max) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(ts) DO UPDATE SET rounds = excluded.rounds, up = excluded.up, router_down = excluded.router_down, lost = excluded.lost,
       probes = excluded.probes, ms_sum = excluded.ms_sum, ms_n = excluded.ms_n, ms_max = excluded.ms_max`,
    m.ts,
    m.rounds,
    m.up,
    m.routerDown,
    m.lost,
    m.probes,
    m.msSum,
    m.msN,
    m.msN ? m.msMax : null,
  );
}

function flush() {
  const s = st();
  if (s.minute) write(s.minute);
  s.minute = null;
}

export function startInternetProbe() {
  const s = st();
  if (s.running) return;
  s.running = true;
  ensureInternetTable();
  const loop = async () => {
    let up = true;
    try {
      up = await round();
    } catch (e) {
      console.error("[gluon] internet probe failed", e);
    }
    s.timer = setTimeout(loop, up ? INTERVAL_MS : RETRY_MS);
    s.timer.unref?.();
  };
  // Start a few seconds in, so it doesn't compete with everything else starting up.
  s.timer = setTimeout(loop, 5_000);
  s.timer.unref?.();
}

export function pruneInternet() {
  ensureInternetTable();
  run("DELETE FROM internet_minutes WHERE ts < ?", now() - KEEP_MS);
}

// ---------------------------------------------------------------- reading

interface Row {
  ts: number;
  rounds: number;
  up: number;
  router_down: number;
  lost: number;
  probes: number;
  ms_sum: number;
  ms_n: number;
  ms_max: number | null;
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.floor(a.length / 2)]!;
};

function cellOf(r: Row | undefined, slowMs: number | null): InternetCell {
  if (!r || !r.rounds) return "-";
  if (r.up === 0) return r.router_down > 0 ? "r" : "d";
  if (r.lost > 0 && r.up < r.rounds) return "l";
  const avg = r.ms_n ? r.ms_sum / r.ms_n : null;
  if (slowMs !== null && avg !== null && avg > slowMs) return "s";
  return "o";
}

/** Consecutive minutes with no answer at all, merged into outages. */
function outagesFrom(rows: Row[], lastAt: number | null, ongoing: { up: boolean; router: boolean | null } | null): InternetOutage[] {
  const out: InternetOutage[] = [];
  let cur: InternetOutage | null = null;
  let prevTs = -Infinity;
  for (const r of rows) {
    const down = r.rounds > 0 && r.up === 0;
    // A gap in measurement (Gluon restarting) ends an outage rather than stretching it.
    const contiguous = r.ts - prevTs <= 60_000;
    if (down) {
      if (cur && contiguous) {
        cur.end = r.ts + 60_000;
        if (r.router_down > 0) cur.cause = "router";
      } else {
        if (cur) out.push(cur);
        cur = { start: r.ts, end: r.ts + 60_000, cause: r.router_down > 0 ? "router" : "internet" };
      }
    } else if (cur) {
      out.push(cur);
      cur = null;
    }
    prevTs = r.ts;
  }
  if (cur) {
    // Still down as of the latest round: open-ended.
    if (ongoing && !ongoing.up && lastAt !== null && (cur.end ?? 0) >= lastAt - 60_000) cur.end = null;
    out.push(cur);
  }
  return out;
}

export function internetData(): InternetData {
  ensureInternetTable();
  const s = st();
  const t = now();
  const dayStart = Math.floor((t - 86_400_000) / 60_000) * 60_000 + 60_000;
  const rows = all<Row>("SELECT * FROM internet_minutes WHERE ts >= ? ORDER BY ts", t - 2 * 86_400_000);
  const day = rows.filter((r) => r.ts >= dayStart);
  const baseline = median(day.filter((r) => r.ms_n > 0).map((r) => r.ms_sum / r.ms_n));
  const slowMs = baseline !== null ? Math.max(SLOW_FLOOR_MS, baseline * SLOW_FACTOR) : null;

  const byTs = new Map(day.map((r) => [r.ts, r]));
  const cells: string[] = [];
  const ms: (number | null)[] = [];
  for (let ts = dayStart; ts <= t; ts += 60_000) {
    const r = byTs.get(ts);
    cells.push(cellOf(r, slowMs));
    ms.push(r && r.ms_n ? Math.round((r.ms_sum / r.ms_n) * 10) / 10 : null);
  }

  const probes = day.reduce((a, r) => a + r.probes, 0);
  const lost = day.reduce((a, r) => a + r.lost, 0);
  const first = one<{ ts: number | null }>("SELECT MIN(ts) AS ts FROM internet_minutes")?.ts ?? null;
  const last = s.last;
  const fresh = last && t - last.at < 3 * INTERVAL_MS ? last : null;
  let state: InternetData["state"] = "waiting";
  if (fresh) {
    if (!fresh.up) state = fresh.router === false ? "router" : "down";
    else state = slowMs !== null && fresh.ms !== null && fresh.ms > slowMs ? "slow" : "ok";
  }

  return {
    state,
    latencyMs: fresh?.ms !== null && fresh?.ms !== undefined ? Math.round(fresh.ms * 10) / 10 : null,
    checkedAt: last?.at ?? null,
    baselineMs: baseline !== null ? Math.round(baseline * 10) / 10 : null,
    strip: { start: dayStart, step: 60_000, cells: cells.join(""), ms },
    outages: outagesFrom(rows, last?.at ?? null, fresh ? { up: fresh.up, router: fresh.router } : null),
    loss24h: probes ? lost / probes : null,
    targets: [...TARGETS],
    router: routerAddress(),
    since: first,
    intervalMs: INTERVAL_MS,
  };
}
