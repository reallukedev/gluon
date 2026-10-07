import "server-only";
import { openSignUp } from "../chat/prosody";
import crypto from "node:crypto";
import fs from "node:fs";
import { tryReadConfig, caddyRunning, isRedirect, httpsMode, XMPP_C2S_PORT, XMPP_S2S_PORT, type RoutesConfig, type SubdomainRoute } from "../caddy/routes";
import { listApps, type AppSummary } from "../docker/apps";
import { AppError } from "../errors";
import { getSetting } from "../settings";
import { publish } from "../events";
import { ddnsStatus } from "./ddns";
import { resolveName, probeTls, probeHttpViaCaddy, probeBackend, lookupPublicIpv4, isLocalBackend } from "./probes";
import { checkSrv, probeXmppCached } from "./xmpp-probe";
import { mumblePorts } from "./voice-servers";
import { certSyncState } from "./xmpp-certs";
import { xmppVerdict } from "./xmpp-verdict";
import { routeApps, routeUrls, FALLBACK_ID } from "./routes-meta";
import { caddyCertError } from "../diagnostics/caddy-log";
import { compressIpv6 } from "./sockets";
import { probeDirectTls, mumblePing } from "./voice-probe";
import { REACH_PROBING, lanSide, outsideOutcomes, targetKey, webControl, type ReachTarget } from "./reach";
import { reachVerdict, type ReachProbe } from "./reach-verdict";
import { OWN_CERT_WARN_DAYS } from "./own-cert-check";
import type { DnsResult, HttpsModeT, NetworkStatus, ProbeState, PublicReach, ReachOutcome, RouteAppRef, RouteStatus, TlsResult, VoiceStatus, XmppStatus } from "@/lib/network-types";

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
  // Chat and voice apps connect straight through the router; when it doesn't let them in, nothing else matters.
  const reach = s.xmpp?.reach ?? s.voice?.reach ?? null;
  if (reach?.state === "blocked") {
    const primary = reach.ports.some((p) => p.primary && (p.verdict === "not-forwarded" || p.verdict === "elsewhere"));
    return { state: primary ? "fault" : "attention", summary: reach.summary };
  }
  // A chat or voice server's web page is a side door: when it breaks, the apps still work.
  const webBroken = !!(s.http?.error && tls?.status !== "pending") || !!(s.http?.status && s.http.status >= 500);
  if ((s.xmpp || s.voice) && webBroken) {
    if (chat) return chat;
    return { state: "attention", summary: `The web page at ${s.host} isn't loading (${s.http?.error?.replace(/\.$/, "") ?? `HTTP ${s.http?.status}`}). ${s.voice ? "Voice" : "Chat"} apps aren't affected.` };
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
  if (s.voice?.tls?.status === "expired") return { state: "attention", summary: `${s.voice.tls.message} Voice apps warn people before they connect.` };
  if (s.xmpp) return { state: "ok", summary: `Working. Chat apps sign in as name@${s.xmpp.domain}.` };
  if (s.voice) return { state: "ok", summary: `Working. Voice apps connect to ${s.host}${s.voice.port === 64738 ? "" : ` on port ${s.voice.port}`}.` };
  const ms = s.http?.ms;
  const plain = s.https === "http" ? " over plain HTTP" : "";
  return { state: "ok", summary: redirect ? `Redirects to ${s.http?.location ?? "its target"}.` : `Working${plain}${ms !== null && ms !== undefined ? ` (answered in ${ms} ms)` : ""}.` };
}

/**
 * Caddy's view of a certificate the person supplied: Gluon can't renew it, so it speaks up three
 * weeks ahead, and "no certificate yet" means Caddy isn't using the file, not that one is coming.
 */
function ownCertTls(t: TlsResult, host: string): TlsResult {
  const base = { ...t, issueError: null };
  if (t.status === "expired") return { ...base, message: `Your certificate for ${host} expired ${-(t.daysLeft ?? 0)} day${t.daysLeft === -1 ? "" : "s"} ago. Replace it in the address's HTTPS settings.` };
  if (t.status === "pending") return { ...base, status: "invalid", message: `Caddy isn't serving your certificate for ${host}. Save the address again to put it back in place.` };
  if ((t.status === "ok" || t.status === "expiring") && t.daysLeft !== null && t.daysLeft < OWN_CERT_WARN_DAYS) {
    return { ...base, status: "expiring", message: `Your certificate for ${host} ends in ${t.daysLeft} day${t.daysLeft === 1 ? "" : "s"}. Gluon can't renew a certificate you supply, so replace it before then.` };
  }
  if (t.status === "ok") return { ...base, message: `Your own certificate, valid for ${t.daysLeft} more days${t.issuer ? `, issued by ${t.issuer}` : ""}.` };
  return base;
}

type ChatRoute = SubdomainRoute & { xmpp: NonNullable<SubdomainRoute["xmpp"]> };
type VoiceRoute = SubdomainRoute & { voice: NonNullable<SubdomainRoute["voice"]> };

/** The host port a route's app publishes for `containerPort`, e.g. XMPP's direct-TLS 5223. */
function publishedFor(apps: AppSummary[], appId: string | undefined, containerPort: number): number | null {
  const app = appId ? apps.find((a) => a.id === appId) : undefined;
  for (const c of app?.containers ?? []) for (const p of c.ports) if (p.proto === "tcp" && p.container === containerPort && p.host) return p.host;
  return null;
}

async function chatStatus(r: ChatRoute, certDays: number, directTlsPort: number | null, force: boolean): Promise<{ status: XmppStatus; probes: ReachInputs }> {
  // Each probe is a real session on the chat server: a few minutes apart, or one minute when asked.
  const age = force ? MIN : 3 * MIN;
  const x = r.xmpp;
  const host = r.backend.host;
  const [client, server, c2s, s2s, web, direct] = await Promise.all([
    checkSrv("xmpp-client", r.host, r.backend.port, XMPP_C2S_PORT),
    checkSrv("xmpp-server", r.host, x.s2s_port, XMPP_S2S_PORT),
    probeXmppCached({ host, port: r.backend.port, domain: r.host, kind: "client", certDays }, age),
    x.s2s_port ? probeXmppCached({ host, port: x.s2s_port, domain: r.host, kind: "server", certDays }, age) : Promise.resolve(null),
    x.http_port && httpsMode(r) !== "none" ? probeBackend(host, x.http_port) : Promise.resolve(null),
    directTlsPort ? throttled(`xmpp-tls:${host}:${directTlsPort}:${r.host}`, age, () => probeDirectTls(host, directTlsPort, r.host, certDays, "The chat server")) : Promise.resolve(null),
  ]);
  const { openRegistration, ...c2sPort } = c2s;
  const probes: ReachInputs = [
    { probe: { port: c2s.port, proto: "tcp", label: "Chat apps sign in", primary: true, lan: c2s.reachable, outside: null }, target: { kind: "xmpp-client", port: c2s.port, domain: r.host, lanFingerprint: c2s.tls?.fingerprint ?? null } },
  ];
  if (s2s) probes.push({ probe: { port: s2s.port, proto: "tcp", label: "Other chat servers", primary: false, lan: s2s.reachable, outside: null }, target: { kind: "xmpp-server", port: s2s.port, domain: r.host, lanFingerprint: s2s.tls?.fingerprint ?? null } });
  // Direct TLS (5223) only counts when the chat server publishes it; plenty don't, and that's fine.
  if (direct && directTlsPort && direct.reachable) {
    probes.push({ probe: { port: directTlsPort, proto: "tcp", label: "Chat apps sign in (direct TLS)", primary: false, lan: true, outside: null }, target: { kind: "tls", port: directTlsPort, domain: r.host, lanFingerprint: direct.tls?.fingerprint ?? null } });
  }
  return {
    status: {
      domain: r.host,
      srv: { client, server },
      c2s: c2sPort,
      s2s: s2s ? { port: s2s.port, reachable: s2s.reachable, ms: s2s.ms, error: s2s.error, tls: s2s.tls } : null,
      web,
      // Gluon's own Prosody knows its sign-up rule; the probe only sees that registration exists.
      openRegistration: openRegistration ? ((await openSignUp(r.app, r.host)) ?? openRegistration) : openRegistration,
      certSync: x.cert_sync && (httpsMode(r) === "auto" || httpsMode(r) === "own") ? (certSyncState(r.id) ?? { container: x.cert_sync.container, checkedAt: null, copiedAt: null, ok: true, message: "Gluon checks the certificate shortly after start-up." }) : null,
      reach: null,
    },
    probes,
  };
}

/**
 * Mumble: a UDP ping (which Mumble doesn't count towards its connection ban) and a rare bare TCP
 * connect. Never HTTP or TLS, which would count every 30 seconds and get Gluon's address banned.
 */
async function voiceStatus(r: VoiceRoute, udpPort: number, force: boolean): Promise<{ status: VoiceStatus; probes: ReachInputs }> {
  const port = r.voice.port;
  const host = r.backend.host;
  const [tcp, udp] = await Promise.all([mumbleTcp(host, port, force), throttled(`mumble-udp:${host}:${udpPort}`, force ? 10_000 : MIN, () => mumblePing(host, udpPort))]);
  const probes: ReachInputs = [
    { probe: { port, proto: "tcp", label: "Voice apps connect", primary: true, lan: tcp.reachable || udp.reachable, outside: null }, target: { kind: "tcp", port } },
    { probe: { port: udpPort, proto: "udp", label: "Voice (UDP)", primary: false, lan: udp.reachable, outside: null }, target: { kind: "mumble-udp", port: udpPort, lan: udp } },
  ];
  return { status: { host: r.host, port, tcp, udp, tls: null, reach: null }, probes };
}

type ReachInputs = { probe: ReachProbe; target: ReachTarget }[];

type Gp = typeof globalThis & { __gluonProbeCache?: Map<string, { at: number; value: Promise<unknown> }> };
/** One probe per key within `maxAgeMs`, shared by concurrent callers: the page polls far more often than servers should be bothered. */
function throttled<T>(key: string, maxAgeMs: number, fn: () => Promise<T>): Promise<T> {
  const cache = ((globalThis as Gp).__gluonProbeCache ??= new Map());
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.value as Promise<T>;
  const value = fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}
const MIN = 60_000;
/** A bare TCP connect to Mumble at most every 10 minutes (5 when someone asks): it bans after 10 in 2 minutes. */
const mumbleTcp = (host: string, port: number, force: boolean) => throttled(`mumble-tcp:${host}:${port}`, (force ? 5 : 10) * MIN, () => probeBackend(host, port));

async function build(force = false): Promise<NetworkStatus> {
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

  const appList = await listApps().catch(() => [] as AppSummary[]);
  const mumble = mumblePorts(appList);
  const apps = await routeApps(cfg, appList).catch(() => ({}) as Record<string, RouteAppRef>);
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
  const reachInputs = new Map<string, ReachInputs>();
  const seenPending = new Set<string>();
  const mumbleWeb = new Set<string>();
  const partials = await Promise.all(
    entries.map(({ r, id }) =>
      limit(async (): Promise<Omit<RouteStatus, "state" | "summary">> => {
        const enabled = r ? r.enabled !== false : true;
        const hostName = r?.type === "subdomain" ? r.host : base;
        const type = r ? r.type : "fallback";
        const https: HttpsModeT = httpsMode(r);
        const backendCfg = r ? (isRedirect(r) ? null : r.backend) : cfg.fallback.backend;
        const common = { id, name: r?.name ?? cfg.fallback.name, type, url: urls[id]!, host: hostName, enabled, app: apps[id] ?? null, https } as const;
        if (!enabled) return { ...common, dns: null, tls: null, http: null, backend: null, xmpp: null, voice: null };
        const sub = r?.type === "subdomain" && !r.redirect_to ? r : null;
        const chat = sub?.xmpp ? chatStatus(sub as ChatRoute, certDays, publishedFor(appList, apps[id]?.appId ?? sub.app, 5223), force) : null;
        const voice = sub?.voice && !sub.xmpp ? voiceStatus(sub as VoiceRoute, mumble.get(sub.voice.port) ?? sub.voice.port, force) : null;
        // A web address pointed at Mumble: visiting it through Caddy would be an HTTP request to Mumble.
        const toMumble = !voice && !sub?.xmpp && !isRedirect(r) && !!backendCfg && isLocalBackend(backendCfg.host) && mumble.has(backendCfg.port);
        // Plain HTTP and no-web-side names have no certificate in Caddy to look at.
        const web = https !== "none";
        const [dns, tlsRaw, http, backend, xmpp, vc] = await Promise.all([
          dnsFor(hostName),
          web && https !== "http" ? tlsFor(hostName) : Promise.resolve(null),
          web && !toMumble ? probeHttpViaCaddy(hostName, probePath(r), 6000, https === "http") : Promise.resolve(null),
          // Chat: the (cached) sign-in probe already says whether the port answers; no extra connection.
          !backendCfg || voice || chat ? Promise.resolve(null) : toMumble ? mumbleTcp(backendCfg.host, backendCfg.port, force) : probeBackend(backendCfg.host, backendCfg.port),
          chat ?? Promise.resolve(null),
          voice ?? Promise.resolve(null),
        ]);
        const tls = tlsRaw && https === "own" ? ownCertTls(tlsRaw, hostName) : tlsRaw;
        if (tls?.status === "pending") {
          seenPending.add(hostName);
          if (!s.pendingSince.has(hostName)) s.pendingSince.set(hostName, Date.now());
        }
        if (xmpp) reachInputs.set(id, xmpp.probes);
        if (vc) reachInputs.set(id, vc.probes);
        // A voice route's backend is Mumble's own port; its TCP check stands in for the backend.
        if (toMumble) mumbleWeb.add(id);
        const c2s = xmpp?.status.c2s;
        const chatBackend = c2s && backendCfg ? { host: backendCfg.host, port: c2s.port, reachable: c2s.reachable, ms: c2s.ms, error: c2s.reachable ? null : c2s.error } : null;
        return { ...common, dns, tls, http, backend: vc ? vc.status.tcp : (chatBackend ?? backend), xmpp: xmpp?.status ?? null, voice: vc?.status ?? null };
      }),
    ),
  );

  // Through the router: every chat and voice port, plus the web port as a control, probed once.
  if (reachInputs.size) {
    const all = [...reachInputs.values()].flat();
    const side = await lanSide();
    let outcomes = new Map<string, ReachOutcome>();
    let control: ReachOutcome[] = [];
    if (REACH_PROBING && v4) {
      const uniq = [...new Map(all.map((x) => [targetKey(x.target), x.target])).values()];
      const [o, c] = await Promise.all([outsideOutcomes(v4, uniq, force), webControl(v4, base, force)]);
      outcomes = o;
      control = [c];
    }
    for (const p of partials) {
      const inputs = reachInputs.get(p.id);
      if (!inputs) continue;
      const mine = new Set(inputs.map((x) => targetKey(x.target)));
      const others = [...outcomes.entries()].filter(([k]) => !mine.has(k)).map(([, v]) => v);
      const reach: PublicReach = reachVerdict({
        publicIp: v4,
        ...side,
        checkedAt: Date.now(),
        probed: REACH_PROBING,
        ports: inputs.map((x) => ({ ...x.probe, outside: outcomes.get(targetKey(x.target)) ?? null })),
        controls: [...control, ...others],
      });
      if (p.xmpp) p.xmpp = { ...p.xmpp, reach };
      if (p.voice) p.voice = { ...p.voice, reach };
    }
  }

  const routes = partials.map((p, i): RouteStatus => {
    const r = entries[i]!.r;
    if (mumbleWeb.has(p.id) && p.enabled && p.backend?.reachable) {
      return { ...p, state: "attention", summary: `Browsers get an error at ${p.host}: it sends them to Mumble's port, which only voice apps understand. Set it up as a voice server instead.` };
    }
    return { ...p, ...evaluate(p, isRedirect(r), p.tls?.status === "pending" ? (s.pendingSince.get(p.host) ?? null) : null) };
  });
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
  s.running = build(!!opts.force)
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
