import "server-only";
import net from "node:net";
import { publish } from "../events";
import { findContainer, followContainerLogs } from "./docker-logs";
import { dockerNetworks, isLoopback, stripMapped } from "./attribution";
import type { CaddyNotice, RequestEntry, RequestFeedState, RequestStats } from "@/lib/diagnostics-types";

/**
 * Live public request feed. Follows `docker logs -f caddy` and parses Caddy's access log:
 *
 *  JSON (Gluon's Caddyfile, `format json`):
 *    {"level":"info","ts":1790383637.41,"logger":"http.log.access.log0","msg":"handled request",
 *     "request":{"client_ip":"…","method":"GET","host":"…","uri":"/","headers":{"User-Agent":["…"]}},
 *     "duration":0.0024,"size":1251,"status":200}
 *  Console (older Caddyfile, `format console`):
 *    2026/09/26 00:47:17.381\t\x1b[34mINFO\x1b[0m\thttp.log.access.log0\thandled request\t{…same fields…}
 *
 * Other lines (admin API, TLS/ACME, errors) are kept as notices; certificate failures are remembered
 * per name so the Network page can say why a certificate is missing.
 */

const CONTAINER = (process.env.GLUON_CADDY_CONTAINER ?? process.env.TEND_CADDY_CONTAINER) ?? "caddy";
const RING = 5000;
const NOTICES = 200;

interface CertError {
  at: number;
  message: string;
}

interface State {
  started: boolean;
  startedAt: number;
  following: boolean;
  container: string | null;
  error: string | null;
  format: RequestFeedState["format"];
  stop: (() => void) | null;
  ring: RequestEntry[];
  notices: CaddyNotice[];
  nextId: number;
  lastTime: number;
  recentKeys: Set<string>;
  minutes: Map<number, { n: number; e5: number }>;
  certErrors: Map<string, CertError>;
  dockerBlock: net.BlockList;
}

type G = typeof globalThis & { __gluonCaddyLog?: State };
const g = globalThis as G;

function defaultBlock(): net.BlockList {
  const b = new net.BlockList();
  b.addSubnet("172.16.0.0", 12, "ipv4");
  b.addSubnet("fd00::", 8, "ipv6");
  return b;
}

const st = (): State =>
  (g.__gluonCaddyLog ??= {
    started: false,
    startedAt: 0,
    following: false,
    container: null,
    error: null,
    format: null,
    stop: null,
    ring: [],
    notices: [],
    nextId: 1,
    lastTime: 0,
    recentKeys: new Set(),
    minutes: new Map(),
    certErrors: new Map(),
    dockerBlock: defaultBlock(),
  });

// ---------------------------------------------------------------- parsing

const ANSI = /\x1b\[[0-9;]*m/g;

type Fields = Record<string, unknown>;

export type ParsedCaddyLine =
  | { kind: "access"; format: "json" | "console"; entry: Omit<RequestEntry, "id" | "internal">; level: string }
  | { kind: "other"; format: "json" | "console"; time: number; level: string; logger: string; msg: string; fields: Fields };

function consoleTime(s: string): number {
  // "2026/09/26 00:47:17.381" (Caddy's console encoder; UTC in the official image)
  const m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (!m) {
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : Date.now();
  }
  const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, "0")) : 0;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]), ms);
}

function header(h: unknown, name: string): string {
  if (!h || typeof h !== "object") return "";
  const o = h as Record<string, unknown>;
  const key = Object.keys(o).find((k) => k.toLowerCase() === name.toLowerCase());
  const v = key ? o[key] : undefined;
  return Array.isArray(v) ? String(v[0] ?? "") : typeof v === "string" ? v : "";
}

// Query parameters that carry credentials (Subsonic's u/p/t/s, Jellyfin's api_key, Plex tokens, OAuth codes…).
const SECRET_PARAMS = /^(p|t|s|pass|passwd|password|pwd|token|access_token|refresh_token|id_token|api_key|apikey|key|secret|auth|authorization|sig|signature|code|jwt|session|sessionid|sid|x-plex-token|x-emby-token|x-mediabrowser-token|x-amz-signature|x-amz-credential)$/i;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;

/** Hide credentials that clients put in URLs, so the live feed never shows a token or password. */
export function redactUri(uri: string): string {
  const q = uri.indexOf("?");
  let out = uri;
  if (q >= 0) {
    const query = uri
      .slice(q + 1)
      .split("&")
      .map((pair) => {
        const eq = pair.indexOf("=");
        if (eq < 0) return pair;
        let k = pair.slice(0, eq);
        try {
          k = decodeURIComponent(k);
        } catch {
          /* keep raw */
        }
        return SECRET_PARAMS.test(k) ? `${pair.slice(0, eq)}=•••` : pair;
      })
      .join("&");
    out = `${uri.slice(0, q)}?${query}`;
  }
  return out.replace(JWT, "•••");
}

function accessEntry(f: Fields, time: number): Omit<RequestEntry, "id" | "internal"> {
  const req = (f.request ?? {}) as Fields;
  const durRaw = f.duration;
  const duration = typeof durRaw === "number" ? durRaw * 1000 : typeof durRaw === "string" ? parseFloat(durRaw) * (/ms$/.test(durRaw) ? 1 : 1000) : 0;
  return {
    time,
    host: String(req.host ?? "").toLowerCase().replace(/:(443|80)$/, ""),
    method: String(req.method ?? ""),
    uri: redactUri(String(req.uri ?? "")).slice(0, 2000),
    status: Number(f.status ?? 0),
    duration: Math.round(duration * 100) / 100,
    size: Number(f.size ?? 0),
    remoteIp: stripMapped(String(req.client_ip ?? req.remote_ip ?? "")),
    userAgent: header(req.headers, "User-Agent").slice(0, 400),
    proto: req.proto ? String(req.proto) : null,
    country: null,
  };
}

export function parseCaddyLine(line: string): ParsedCaddyLine | null {
  const text = line.replace(ANSI, "").trim();
  if (!text) return null;
  if (text.startsWith("{")) {
    let f: Fields;
    try {
      f = JSON.parse(text) as Fields;
    } catch {
      return null;
    }
    const logger = String(f.logger ?? "");
    const time = typeof f.ts === "number" ? Math.round(f.ts * 1000) : typeof f.ts === "string" ? Date.parse(f.ts) || Date.now() : Date.now();
    const level = String(f.level ?? "info");
    if (logger.startsWith("http.log.access")) return { kind: "access", format: "json", entry: accessEntry(f, time), level };
    return { kind: "other", format: "json", time, level, logger, msg: String(f.msg ?? ""), fields: f };
  }
  const parts = text.split("\t");
  if (parts.length >= 4 && /^\d{4}\/\d{2}\/\d{2}/.test(parts[0]!)) {
    const time = consoleTime(parts[0]!);
    const level = parts[1]!.trim().toLowerCase();
    const logger = parts[2]!.trim();
    const msg = parts[3]!.trim();
    let f: Fields = {};
    const rest = parts.slice(4).join("\t").trim();
    if (rest.startsWith("{")) {
      try {
        f = JSON.parse(rest) as Fields;
      } catch {
        f = {};
      }
    }
    if (logger.startsWith("http.log.access")) return { kind: "access", format: "console", entry: accessEntry(f, time), level };
    return { kind: "other", format: "console", time, level, logger, msg, fields: f };
  }
  return null;
}

// ---------------------------------------------------------------- state updates

function isInternal(e: Omit<RequestEntry, "id" | "internal">, block: net.BlockList): boolean {
  if (/^(domains-ui-check|Gluon-)/.test(e.userAgent)) return true;
  const ip = e.remoteIp;
  if (!ip) return false;
  if (isLoopback(ip)) return true;
  const type = net.isIPv4(ip) ? "ipv4" : net.isIPv6(ip) ? "ipv6" : null;
  return type ? block.check(ip, type) : false;
}

function handleLine(line: string) {
  const s = st();
  const p = parseCaddyLine(line);
  if (!p) return;
  s.format = p.format === "json" || s.format === null ? p.format : s.format;
  if (p.kind === "access") {
    const key = `${p.entry.time}|${p.entry.remoteIp}|${p.entry.uri}|${p.entry.status}|${p.entry.duration}`;
    if (p.entry.time <= s.lastTime && s.recentKeys.has(key)) return; // replay after reconnect
    s.recentKeys.add(key);
    if (s.recentKeys.size > 4000) s.recentKeys = new Set([...s.recentKeys].slice(-2000));
    s.lastTime = Math.max(s.lastTime, p.entry.time);
    const entry: RequestEntry = { ...p.entry, id: s.nextId++, internal: isInternal(p.entry, s.dockerBlock) };
    s.ring.push(entry);
    if (s.ring.length > RING) s.ring.splice(0, s.ring.length - RING);
    if (!entry.internal) {
      const m = Math.floor(entry.time / 60_000) * 60_000;
      const b = s.minutes.get(m) ?? { n: 0, e5: 0 };
      b.n++;
      if (entry.status >= 500) b.e5++;
      s.minutes.set(m, b);
      const cutoff = Date.now() - 61 * 60_000;
      for (const k of s.minutes.keys()) if (k < cutoff) s.minutes.delete(k);
    }
    publish("caddy.request", entry);
    return;
  }
  // Certificate bookkeeping.
  const ident = typeof p.fields.identifier === "string" ? p.fields.identifier.toLowerCase() : null;
  if (ident) {
    if (/obtained successfully|certificate obtained|renewed successfully/i.test(p.msg)) s.certErrors.delete(ident);
    else if (p.level === "error" && /certificate|obtain|acme|challenge|issuer/i.test(`${p.logger} ${p.msg}`)) {
      const err = String(p.fields.error ?? p.msg).replace(/\s+/g, " ");
      s.certErrors.set(ident, { at: p.time, message: humanCertError(err) });
    }
  }
  if (p.logger === "admin.api" && p.level === "info") return; // Gluon's own socket calls
  if (p.level === "debug") return;
  const req = p.fields.request as Fields | undefined;
  const notice: CaddyNotice = {
    time: p.time,
    level: p.level,
    logger: p.logger,
    message: [p.msg, typeof p.fields.error === "string" ? p.fields.error : ""].filter(Boolean).join(": ").slice(0, 600),
    host: ident ?? (req?.host ? String(req.host) : null),
  };
  if (p.level === "info" && !/certificate|obtain|renew|serving|shutting|server running|started/i.test(p.msg)) return;
  s.notices.push(notice);
  if (s.notices.length > NOTICES) s.notices.splice(0, s.notices.length - NOTICES);
  publish("caddy.notice", notice);
}

function humanCertError(err: string): string {
  if (/rateLimited|too many certificates/i.test(err)) return "Let's Encrypt's rate limit was hit; Caddy will retry later.";
  if (/NXDOMAIN|no valid A records|DNS problem/i.test(err)) return "Let's Encrypt couldn't find this name in DNS.";
  if (/connection refused|Timeout during connect|Fetching http|firewall/i.test(err)) return "Let's Encrypt couldn't reach this server on port 80/443. Check the router's port forwarding.";
  if (/unauthorized|Invalid response/i.test(err)) return "Let's Encrypt reached a different server than this one for that name.";
  return err.slice(0, 200);
}

// ---------------------------------------------------------------- follower

async function refreshBlock() {
  try {
    const { list } = await dockerNetworks();
    const b = defaultBlock();
    for (const n of list) {
      for (const cidr of n.subnets) {
        const [addr, bits] = cidr.split("/");
        try {
          b.addSubnet(addr!, Number(bits), net.isIPv6(addr!) ? "ipv6" : "ipv4");
        } catch {
          /* ignore */
        }
      }
    }
    st().dockerBlock = b;
  } catch {
    /* keep the previous list */
  }
}

async function loop() {
  const s = st();
  let backoff = 2000;
  for (;;) {
    await refreshBlock();
    const c = await findContainer(CONTAINER, (x) => /(^|\/)caddy(:|@|$)/.test(x.Image));
    if (!c || !c.running) {
      s.following = false;
      s.container = c?.name ?? null;
      s.error = c ? "Caddy isn't running, so there are no requests to show." : "Gluon can't find the Caddy container.";
      await new Promise((r) => setTimeout(r, 30_000));
      continue;
    }
    s.container = c.name;
    const since = s.lastTime ? Math.floor(s.lastTime / 1000) : Math.floor(Date.now() / 1000) - 60;
    try {
      const ended = new Promise<void>((resolve) => {
        void followContainerLogs(c, { since }, handleLine, () => resolve()).then((stop) => {
          s.stop = stop;
          s.following = true;
          s.error = null;
          backoff = 2000;
        }, (e) => {
          s.error = `Can't read Caddy's log: ${(e as Error).message}`;
          resolve();
        });
      });
      await ended;
    } catch (e) {
      s.error = `Can't read Caddy's log: ${(e as Error).message}`;
    }
    s.following = false;
    s.stop = null;
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 30_000);
  }
}

/** Start following Caddy's log (once per process). */
export function ensureCaddyFollower() {
  const s = st();
  if (s.started) return;
  s.started = true;
  s.startedAt = Date.now();
  void loop();
  const t = setInterval(() => void refreshBlock(), 5 * 60_000);
  t.unref?.();
}

export function feedState(): RequestFeedState {
  const s = st();
  return { following: s.following, container: s.container, error: s.error, format: s.format };
}

export function recentRequests(limit = 300, includeInternal = false): RequestEntry[] {
  const list = st().ring;
  const out: RequestEntry[] = [];
  for (let i = list.length - 1; i >= 0 && out.length < limit; i--) if (includeInternal || !list[i]!.internal) out.push({ ...list[i]!, uri: redactUri(list[i]!.uri) });
  return out.reverse();
}

export function recentNotices(limit = 50): CaddyNotice[] {
  return st().notices.slice(-limit);
}

/** Caddy's latest certificate error for a hostname, if it hasn't since succeeded. */
export function caddyCertError(host: string): string | null {
  return st().certErrors.get(host.toLowerCase())?.message ?? null;
}

function top(map: Map<string, { count: number; errors: number }>, n = 10) {
  return [...map.entries()]
    .map(([key, v]) => ({ key, ...v }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, n);
}

export function requestStats(windowMinutes = 15): RequestStats {
  const s = st();
  const t = Date.now();
  const since = t - windowMinutes * 60_000;
  const paths = new Map<string, { count: number; errors: number }>();
  const clients = new Map<string, { count: number; errors: number }>();
  const hosts = new Map<string, { count: number; errors: number }>();
  const classes: RequestStats["statusClasses"] = { "2xx": 0, "3xx": 0, "4xx": 0, "5xx": 0, other: 0 };
  const durations: number[] = [];
  let total = 0;
  let e5 = 0;
  let e4 = 0;
  let bytes = 0;
  let internal = 0;
  const bump = (m: Map<string, { count: number; errors: number }>, k: string, err: boolean) => {
    const v = m.get(k) ?? { count: 0, errors: 0 };
    v.count++;
    if (err) v.errors++;
    m.set(k, v);
  };
  for (let i = s.ring.length - 1; i >= 0; i--) {
    const e = s.ring[i]!;
    if (e.time < since) break;
    if (e.internal) {
      internal++;
      continue;
    }
    total++;
    const err = e.status >= 500 || e.status === 0;
    if (e.status >= 500) e5++;
    else if (e.status >= 400) e4++;
    const cls = e.status >= 200 && e.status < 600 ? (`${Math.floor(e.status / 100)}xx` as keyof typeof classes) : "other";
    classes[cls in classes ? cls : "other"]++;
    bytes += e.size || 0;
    // WebSocket upgrades (101) stay open for minutes; they'd swamp the latency figures.
    if (e.status !== 101) durations.push(e.duration);
    bump(paths, `${e.host}${e.uri.split("?")[0]}`, err);
    bump(clients, e.remoteIp || "unknown", err);
    bump(hosts, e.host || "unknown", err);
  }
  durations.sort((a, b) => a - b);
  const series: [number, number, number][] = [];
  const nowMin = Math.floor(t / 60_000) * 60_000;
  for (let m = nowMin - 59 * 60_000; m <= nowMin; m += 60_000) {
    const b = s.minutes.get(m);
    series.push([m, b?.n ?? 0, b?.e5 ?? 0]);
  }
  // Since the follower started we have at most (now - start + the 1 minute of backlog) of data.
  const spanMin = Math.max(1, Math.min(windowMinutes, s.startedAt ? (t - s.startedAt) / 60_000 + 1 : windowMinutes));
  return {
    t,
    windowMinutes,
    total,
    perMinute: Math.round((total / spanMin) * 10) / 10,
    errorRate: total ? e5 / total : 0,
    clientErrorRate: total ? e4 / total : 0,
    avgMs: durations.length ? Math.round((durations.reduce((a, b) => a + b, 0) / durations.length) * 10) / 10 : null,
    p95Ms: durations.length ? durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))]! : null,
    bytes,
    internalExcluded: internal,
    statusClasses: classes,
    topPaths: top(paths),
    topClients: top(clients),
    topHosts: top(hosts),
    series,
  };
}
