import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import { tryReadConfig, caddyRunning, XMPP_C2S_PORT, XMPP_S2S_PORT, type RoutesConfig, type SubdomainRoute } from "../caddy/routes";
import { AppError } from "../errors";
import { getSetting } from "../settings";
import { publish } from "../events";
import { ddnsStatus } from "./ddns";
import { resolveName, probeTls, probeHttpViaCaddy, probeBackend, lookupPublicIpv4 } from "./probes";
import { checkSrv, probeXmpp } from "./xmpp-probe";
import { certSyncState } from "./xmpp-certs";
import { xmppVerdict } from "./xmpp-verdict";
import { routeApps, routeUrls, FALLBACK_ID } from "./routes-meta";
import { caddyCertError } from "../diagnostics/caddy-log";
import { compressIpv6 } from "./sockets";
import type { DnsResult, NetworkStatus, ProbeState, RouteAppRef, RouteStatus, TlsResult, XmppStatus } from "@/lib/network-types";

export { xmppVerdict };

/**
 * Health of every public address: DNS (public resolvers), certificate (TLS handshake with Caddy
 * using the route's SNI), HTTP status through Caddy, and whether the backend port answers.
 * Cached ~30 s; concurrent callers share one run.
 */

type G = typeof globalThis & {
  __gluonNetStatus?: { at: number; value: NetworkStatus | null; running: Promise<NetworkStatus> | null; pendingSince: Map<string, number> };
};
const g = globalThis as G;
const st = () => (g.__gluonNetStatus ??= { at: 0, value: null, running: null, pendingSince: new Map() });

export const NOT_CONFIGURED = () =>
  new AppError("no_routes", "Gluon can't read the public addresses file (routes.json in ~/proxy/caddy). Check that the proxy folder is mounted at /proxy-caddy.", 503);

/** Global IPv6 addresses of the host (not docker/veth), from /proc/1/net/if_inet6. */
export function hostGlobalIpv6(): string[] {
  let text = "";
  try {
    text = fs.readFileSync("/proc/1/net/if_inet6", "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of text.trim().split("\n")) {
    const [hex, , , scope, , ifname] = line.trim().split(/\s+/);
    if (!hex || scope !== "00" || !ifname || /^(docker|br-|veth|lo)/.test(ifname)) continue;
    const groups = hex.match(/.{4}/g);
    if (groups?.length === 8) out.push(compressIpv6(groups));
  }
  return out;
}

function limiter(n: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

function probePath(r: RoutesConfig["routes"][number] | null): string {
  if (!r) return "/";
  if (r.type === "subdomain") {
    const first = r.only_paths?.[0];
    if (!first) return "/";
    return first.replace(/\*$/, "") || "/";
  }
  return `${r.path}/`;
}

function evaluate(s: Omit<RouteStatus, "state" | "summary">, redirect: boolean, pendingSince: number | null): { state: ProbeState; summary: string } {
  const who = s.app?.name ?? s.name;
  if (!s.enabled) return { state: "disabled", summary: "Turned off. It isn't reachable from the internet." };
  if (s.backend && !s.backend.reachable) return { state: "fault", summary: `${who} isn't answering on port ${s.backend.port}: ${s.backend.error}.` };
  const chat = s.xmpp ? xmppVerdict(s.xmpp) : null;
  if (chat?.state === "fault") return chat;
  if (s.dns?.status === "missing") return { state: "fault", summary: s.dns.message };
  const tls = s.tls;
  if (tls?.status === "expired") return { state: "fault", summary: tls.message };
  // A chat server's web page is a side door: when it breaks, chat apps still work.
  const webBroken = !!(s.http?.error && tls?.status !== "pending") || !!(s.http?.status && s.http.status >= 500);
  if (s.xmpp && webBroken) {
    if (chat) return chat;
    return { state: "attention", summary: `The web page at ${s.host} isn't loading (${s.http?.error ?? `HTTP ${s.http?.status}`}). Chat apps aren't affected.` };
  }
  if (s.http?.error && tls?.status !== "pending") return { state: "fault", summary: `Caddy isn't serving it: ${s.http.error}` };
  if (s.http?.status && s.http.status >= 500) {
    const code = s.http.status;
    const why = code === 502 ? "Caddy can't reach the app behind it" : code === 504 ? "the app behind it is too slow to answer" : "the app answered with an error";
    return { state: "fault", summary: `Visitors get an error page (HTTP ${code}): ${why}.` };
  }
  if (tls?.status === "pending") {
    if (tls.issueError) return { state: "attention", summary: `Caddy couldn't get a certificate: ${tls.issueError}` };
    const mins = pendingSince ? Math.round((Date.now() - pendingSince) / 60_000) : 0;
    return { state: "pending", summary: mins >= 10 ? `Still waiting for a certificate after ${mins} minutes.` : "Waiting for a certificate. This usually takes under a minute." };
  }
  if (s.dns?.status === "mismatch") return { state: "attention", summary: s.dns.message };
  if (tls?.status === "invalid" || tls?.status === "expiring" || tls?.status === "error") return { state: "attention", summary: tls.message };
  if (s.dns?.status === "error") return { state: "attention", summary: s.dns.message };
  if (redirect && s.http?.status && (s.http.status < 300 || s.http.status >= 400)) {
    return { state: "attention", summary: `Expected a redirect but got HTTP ${s.http.status}.` };
  }
  if (chat) return chat;
  if (s.xmpp) return { state: "ok", summary: `Working. Chat apps sign in as name@${s.xmpp.domain}.` };
  const ms = s.http?.ms;
  return { state: "ok", summary: redirect ? `Redirects to ${s.http?.location ?? "its target"}.` : `Working${ms !== null && ms !== undefined ? ` (answered in ${ms} ms)` : ""}.` };
}

async function chatStatus(r: SubdomainRoute & { xmpp: NonNullable<SubdomainRoute["xmpp"]> }, certDays: number): Promise<XmppStatus> {
  const x = r.xmpp;
  const host = r.backend.host;
  const [client, server, c2s, s2s, web] = await Promise.all([
    checkSrv("xmpp-client", r.host, r.backend.port, XMPP_C2S_PORT),
    checkSrv("xmpp-server", r.host, x.s2s_port, XMPP_S2S_PORT),
    probeXmpp({ host, port: r.backend.port, domain: r.host, kind: "client", certDays }),
    x.s2s_port ? probeXmpp({ host, port: x.s2s_port, domain: r.host, kind: "server", certDays }) : Promise.resolve(null),
    x.http_port ? probeBackend(host, x.http_port) : Promise.resolve(null),
  ]);
  const { openRegistration, ...c2sPort } = c2s;
  return {
    domain: r.host,
    srv: { client, server },
    c2s: c2sPort,
    s2s: s2s ? { port: s2s.port, reachable: s2s.reachable, ms: s2s.ms, error: s2s.error, tls: s2s.tls } : null,
    web,
    openRegistration,
    certSync: x.cert_sync ? (certSyncState(r.id) ?? { container: x.cert_sync.container, checkedAt: null, copiedAt: null, ok: true, message: "Gluon checks the certificate shortly after start-up." }) : null,
  };
}

async function build(): Promise<NetworkStatus> {
  const cfg = tryReadConfig();
  if (!cfg) throw NOT_CONFIGURED();
  const certDays = getSetting("thresholds").certDays;
  const s = st();

  const ddns = await ddnsStatus().catch(() => null);
  let v4 = ddns?.ipv4?.address ?? null;
  let source: NetworkStatus["publicIp"]["source"] = v4 ? "ddns" : "none";
  if (!v4) {
    v4 = await lookupPublicIpv4();
    if (v4) source = "lookup";
  }
  const v6 = [...new Set([...(ddns?.ipv6?.addresses ?? []), ...hostGlobalIpv6()])];
  const publicIp = { v4, v6, source };

  const apps = await routeApps(cfg).catch(() => ({}) as Record<string, RouteAppRef>);
  const urls = routeUrls(cfg);
  const dnsMemo = new Map<string, Promise<DnsResult>>();
  const tlsMemo = new Map<string, Promise<TlsResult>>();
  const dnsFor = (h: string) => {
    if (!dnsMemo.has(h)) dnsMemo.set(h, resolveName(h, publicIp));
    return dnsMemo.get(h)!;
  };
  const tlsFor = (h: string) => {
    if (!tlsMemo.has(h)) {
      tlsMemo.set(
        h,
        probeTls(h, certDays).then((t) => ({ ...t, issueError: t.status === "ok" ? null : caddyCertError(h) })),
      );
    }
    return tlsMemo.get(h)!;
  };
  const limit = limiter(4);
  const base = cfg.base_domain;
  const wildName = `gluon-check-${crypto.randomBytes(3).toString("hex")}.${base}`;
  const [wildcardRaw, baseDns, running] = await Promise.all([resolveName(wildName, publicIp), dnsFor(base), caddyRunning()]);
  const wildcard: DnsResult = {
    ...wildcardRaw,
    name: `*.${base}`,
    message:
      wildcardRaw.status === "missing"
        ? `There's no wildcard record (*.${base}), so every new subdomain needs its own DNS record.`
        : wildcardRaw.message.replaceAll(wildName, `*.${base}`),
  };

  const entries: { r: RoutesConfig["routes"][number] | null; id: string }[] = [{ r: null, id: FALLBACK_ID }, ...cfg.routes.map((r) => ({ r, id: r.id }))];
  const seenPending = new Set<string>();
  const routes = await Promise.all(
    entries.map(({ r, id }) =>
      limit(async (): Promise<RouteStatus> => {
        const enabled = r ? r.enabled !== false : true;
        const hostName = r?.type === "subdomain" ? r.host : base;
        const type = r ? r.type : "fallback";
        const backendCfg = r ? (r.type === "redirect" ? null : r.backend) : cfg.fallback.backend;
        const common = { id, name: r?.name ?? cfg.fallback.name, type, url: urls[id]!, host: hostName, enabled, app: apps[id] ?? null } as const;
        if (!enabled) {
          const partial = { ...common, dns: null, tls: null, http: null, backend: null, xmpp: null };
          return { ...partial, ...evaluate(partial, false, null) };
        }
        const [dns, tls, http, backend, xmpp] = await Promise.all([
          dnsFor(hostName),
          tlsFor(hostName),
          probeHttpViaCaddy(hostName, probePath(r)),
          backendCfg ? probeBackend(backendCfg.host, backendCfg.port) : Promise.resolve(null),
          r?.type === "subdomain" && r.xmpp ? chatStatus(r as SubdomainRoute & { xmpp: NonNullable<SubdomainRoute["xmpp"]> }, certDays) : Promise.resolve(null),
        ]);
        if (tls.status === "pending") {
          seenPending.add(hostName);
          if (!s.pendingSince.has(hostName)) s.pendingSince.set(hostName, Date.now());
        }
        const partial = { ...common, dns, tls, http, backend, xmpp };
        return { ...partial, ...evaluate(partial, r?.type === "redirect", s.pendingSince.get(hostName) ?? null) };
      }),
    ),
  );
  for (const h of [...s.pendingSince.keys()]) if (!seenPending.has(h)) s.pendingSince.delete(h);

  const counts = { ok: 0, attention: 0, fault: 0, pending: 0, disabled: 0 };
  for (const r of routes) if (r.state in counts) counts[r.state as keyof typeof counts]++;
  return { checkedAt: Date.now(), baseDomain: base, publicIp, wildcard, base: baseDns, routes, caddyRunning: running, counts };
}

/** Status of every public address; reuses a result younger than `maxAgeMs` unless forced. */
export async function networkStatus(opts: { force?: boolean; maxAgeMs?: number } = {}): Promise<NetworkStatus> {
  const s = st();
  const maxAge = opts.maxAgeMs ?? 30_000;
  if (!opts.force && s.value && Date.now() - s.at < maxAge) return s.value;
  if (s.running) return s.running;
  s.running = build()
    .then((v) => {
      s.value = v;
      s.at = Date.now();
      publish("network.status", { checkedAt: v.checkedAt, counts: v.counts });
      return v;
    })
    .finally(() => {
      s.running = null;
    });
  return s.running;
}

/** How long a host has been waiting for a certificate (ms), or null. */
export function pendingFor(host: string): number | null {
  const t = st().pendingSince.get(host);
  return t ? Date.now() - t : null;
}

export function invalidateStatus() {
  const s = st();
  s.at = 0;
}
