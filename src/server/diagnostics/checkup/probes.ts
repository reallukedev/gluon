import "server-only";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { host, local, CommandError } from "../../host/exec";
import { readHostFileOr } from "../../host/paths";
import { LOCAL_HOST } from "../../network/probes";

/** Small read-only probes the checkup needs beyond the ones other modules already have. */

// ---------------------------------------------------------------- routing and resolvers

export interface Gateway {
  gateway: string;
  dev: string | null;
  family: 4 | 6;
}

/** Default routes from `ip -j route` on the host. */
export async function defaultGateways(): Promise<Gateway[]> {
  const out: Gateway[] = [];
  for (const fam of [4, 6] as const) {
    try {
      const { stdout } = await host("ip", [`-${fam}`, "-j", "route", "show", "default"], { timeoutMs: 4000 });
      const rows = JSON.parse(stdout || "[]") as { gateway?: string; dev?: string }[];
      for (const r of rows) if (r.gateway) out.push({ gateway: r.gateway, dev: r.dev ?? null, family: fam });
    } catch {
      /* no route for this family, or ip missing */
    }
  }
  return out;
}

/** Nameservers the host itself uses (its /etc/resolv.conf). */
export function hostNameservers(): string[] {
  return readHostFileOr("/etc/resolv.conf", "")
    .split("\n")
    .map((l) => l.match(/^\s*nameserver\s+(\S+)/)?.[1])
    .filter((x): x is string => !!x)
    .slice(0, 3);
}

// ---------------------------------------------------------------- ping with a chosen interval

export interface PingSeries {
  target: string;
  sent: number;
  received: number;
  lossPct: number;
  rtts: number[];
  min: number | null;
  avg: number | null;
  max: number | null;
  /** Mean absolute difference between consecutive replies. */
  jitter: number | null;
  raw: string;
  error: string | null;
}

export function summarizeRtts(rtts: number[]) {
  if (!rtts.length) return { min: null, avg: null, max: null, jitter: null, median: null };
  const sorted = [...rtts].sort((a, b) => a - b);
  const avg = rtts.reduce((a, b) => a + b, 0) / rtts.length;
  let j = 0;
  for (let i = 1; i < rtts.length; i++) j += Math.abs(rtts[i]! - rtts[i - 1]!);
  return { min: sorted[0]!, avg, max: sorted.at(-1)!, jitter: rtts.length > 1 ? j / (rtts.length - 1) : 0, median: sorted[Math.floor(sorted.length / 2)]! };
}

/** ping from Gluon's container (host networking), `count` packets `intervalS` apart. */
export async function pingSeries(target: string, count: number, intervalS = 0.2, signal?: AbortSignal): Promise<PingSeries> {
  const args = ["-n", "-c", String(count), "-i", String(intervalS), "-W", "2", "-w", String(Math.ceil(count * intervalS) + 3), target];
  let stdout = "";
  let error: string | null = null;
  try {
    if (signal?.aborted) throw new Error("stopped");
    ({ stdout } = await local("ping", args, { timeoutMs: (Math.ceil(count * intervalS) + 6) * 1000, okCodes: [1] }));
  } catch (e) {
    if (e instanceof CommandError) {
      stdout = e.stdout;
      error = (e.stderr || e.message).trim().split("\n").at(-1) ?? "ping failed";
    } else error = (e as Error).message;
  }
  const rtts = [...stdout.matchAll(/time=([\d.]+) ms/g)].map((m) => Number(m[1]));
  const sent = Number(stdout.match(/(\d+) packets transmitted/)?.[1] ?? count);
  const received = rtts.length;
  const s = summarizeRtts(rtts);
  return { target, sent, received, lossPct: sent ? Math.round(((sent - received) / sent) * 1000) / 10 : 100, rtts, min: s.min, avg: s.avg, max: s.max, jitter: s.jitter, raw: stdout.trim().split("\n").slice(-3).join("\n"), error };
}

// ---------------------------------------------------------------- HTTP

export interface HttpAnswer {
  status: number | null;
  ms: number | null;
  location: string | null;
  server: string | null;
  error: string | null;
  code: string | null;
}

/** GET http://127.0.0.1:<port>/ (or https) without following redirects; any HTTP answer counts. */
export function httpAnswer(port: number, opts: { tls?: boolean; path?: string; host?: string; timeoutMs?: number } = {}): Promise<HttpAnswer> {
  const t0 = performance.now();
  const mod = opts.tls ? https : http;
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: HttpAnswer) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    const req = mod.request(
      {
        host: opts.host ?? LOCAL_HOST,
        port,
        path: opts.path ?? "/",
        method: "GET",
        headers: { "User-Agent": "Gluon-checkup/1", Accept: "text/html,*/*", Connection: "close" },
        timeout: opts.timeoutMs ?? 5000,
        agent: false,
        rejectUnauthorized: false,
      } as https.RequestOptions,
      (res) => {
        const loc = typeof res.headers.location === "string" ? res.headers.location : null;
        const server = typeof res.headers.server === "string" ? res.headers.server : null;
        res.resume();
        res.destroy();
        finish({ status: res.statusCode ?? null, ms: Math.round(performance.now() - t0), location: loc, server, error: null, code: null });
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", (e: NodeJS.ErrnoException) => finish({ status: null, ms: null, location: null, server: null, error: e.message, code: e.code ?? null }));
    req.end();
  });
}

export interface Download {
  bytes: number;
  /** Time from first byte to last. */
  ms: number | null;
  ttfbMs: number | null;
  status: number | null;
  error: string | null;
}

/** Download up to `maxBytes` of `url`, stopping at `capMs`. */
export function download(url: string, maxBytes: number, capMs: number, signal?: AbortSignal): Promise<Download> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    let done = false;
    let first: number | null = null;
    let bytes = 0;
    let status: number | null = null;
    const finish = (error: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const end = performance.now();
      resolve({ bytes, ms: first !== null ? Math.max(1, Math.round(end - first)) : null, ttfbMs: first !== null ? Math.round(first - t0) : null, status, error });
      req.destroy();
    };
    const onAbort = () => finish("stopped");
    signal?.addEventListener("abort", onAbort, { once: true });
    const req = https.get(url, { headers: { "User-Agent": "Gluon-checkup/1", Connection: "close" }, agent: false }, (res) => {
      status = res.statusCode ?? null;
      if (status !== 200) {
        res.resume();
        return finish(`HTTP ${status}`);
      }
      res.on("data", (c: Buffer) => {
        first ??= performance.now();
        bytes += c.length;
        if (bytes >= maxBytes) finish(null);
      });
      res.on("end", () => finish(null));
      res.on("error", (e) => finish(e.message));
    });
    req.on("error", (e) => finish(e.message));
    const timer = setTimeout(() => finish(bytes ? null : "timed out"), capMs);
  });
}

// ---------------------------------------------------------------- pressure, CPU, swap

export interface Pressure {
  some10: number;
  some60: number;
  full60: number | null;
}

/** Pressure stall information: % of time tasks waited on cpu / memory / io. */
export function pressure(kind: "cpu" | "memory" | "io"): Pressure | null {
  let text: string;
  try {
    text = fs.readFileSync(`/proc/pressure/${kind}`, "utf8");
  } catch {
    return null;
  }
  const line = (k: string) => text.split("\n").find((l) => l.startsWith(k));
  const num = (l: string | undefined, key: string) => {
    const m = l?.match(new RegExp(`${key}=([\\d.]+)`));
    return m ? Number(m[1]) : null;
  };
  const some = line("some");
  const full = line("full");
  const some10 = num(some, "avg10");
  const some60 = num(some, "avg60");
  if (some10 === null || some60 === null) return null;
  return { some10, some60, full60: num(full, "avg60") };
}

function statLine() {
  const l = fs.readFileSync("/proc/stat", "utf8").split("\n")[0]!;
  const v = l.trim().split(/\s+/).slice(1).map(Number);
  const total = v.slice(0, 8).reduce((a, b) => a + b, 0);
  return { total, idle: v[3] ?? 0, iowait: v[4] ?? 0, steal: v[7] ?? 0 };
}

function vmstat() {
  const kv: Record<string, number> = {};
  for (const l of fs.readFileSync("/proc/vmstat", "utf8").split("\n")) {
    const [k, v] = l.split(" ");
    if (k && v) kv[k] = Number(v);
  }
  return kv;
}

export interface CpuWindow {
  busyPct: number;
  iowaitPct: number;
  stealPct: number;
  swapInPerSec: number;
  swapOutPerSec: number;
  majorFaultsPerSec: number;
  seconds: number;
}

/** Sample /proc/stat and /proc/vmstat over `ms` for CPU busy, I/O wait and swap activity. */
export async function cpuWindow(msWindow = 2000, signal?: AbortSignal): Promise<CpuWindow> {
  const a = statLine();
  const va = vmstat();
  await new Promise<void>((r) => {
    const t = setTimeout(r, msWindow);
    signal?.addEventListener("abort", () => (clearTimeout(t), r()), { once: true });
  });
  const b = statLine();
  const vb = vmstat();
  const dt = Math.max(1, b.total - a.total);
  const secs = msWindow / 1000;
  const rate = (k: string) => Math.max(0, ((vb[k] ?? 0) - (va[k] ?? 0)) / secs);
  return {
    busyPct: Math.max(0, Math.min(100, (1 - (b.idle + b.iowait - a.idle - a.iowait) / dt) * 100)),
    iowaitPct: Math.max(0, ((b.iowait - a.iowait) / dt) * 100),
    stealPct: Math.max(0, ((b.steal - a.steal) / dt) * 100),
    swapInPerSec: rate("pswpin"),
    swapOutPerSec: rate("pswpout"),
    majorFaultsPerSec: rate("pgmajfault"),
    seconds: secs,
  };
}
