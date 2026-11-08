import "server-only";
import dns from "node:dns";
import net from "node:net";
import os from "node:os";
import tls from "node:tls";
import http from "node:http";
import https from "node:https";
import { isCloudflareIp } from "./cloudflare";
import type { BackendResult, DnsResult, HttpResult, TlsResult } from "@/lib/network-types";

/**
 * Low-level probes used by the route status page and the checks. Every probe has a hard timeout and
 * never throws: failures come back as data with a plain-language message.
 */

export const CADDY_HOST = (process.env.GLUON_CADDY_PROBE_HOST ?? process.env.TEND_CADDY_PROBE_HOST) ?? "127.0.0.1";
export const CADDY_PORT = Number((process.env.GLUON_CADDY_PROBE_PORT ?? process.env.TEND_CADDY_PROBE_PORT) ?? 443);
/** Caddy's plain-HTTP port, for addresses where something in front handles HTTPS. */
export const CADDY_HTTP_PORT = Number(process.env.GLUON_CADDY_PROBE_HTTP_PORT ?? 80);
export const PROBE_UA = "Gluon-status/1";

/** Overrides where Gluon reaches this machine's own ports (both Gluon's services and route backends). */
const LOCAL_OVERRIDE = process.env.GLUON_LOCAL_HOST ?? process.env.TEND_LOCAL_HOST;

/** Where this machine's own ports are reached from Gluon (host networking → loopback). */
export const LOCAL_HOST = LOCAL_OVERRIDE ?? "127.0.0.1";

/** The default Docker bridge's gateway from this machine's interfaces (docker0), if it has one. */
export function bridgeGateway(ifaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()): string | null {
  return ifaces.docker0?.find((i) => i.family === "IPv4")?.address ?? null;
}

type G = typeof globalThis & { __gluonBridgeGw?: { at: number; ip: string | null }; __gluonBridgeAsk?: boolean };
const g = globalThis as G;

/** Ask Docker for the bridge network's gateway, for daemons whose bridge isn't called docker0. Once. */
function askDocker(): void {
  if (g.__gluonBridgeAsk) return;
  g.__gluonBridgeAsk = true;
  void import("../docker/client")
    .then(({ docker }) => docker().getNetwork("bridge").inspect())
    .then((n: { IPAM?: { Config?: { Gateway?: string }[] } }) => {
      const ip = n.IPAM?.Config?.find((c) => c.Gateway && net.isIPv4(c.Gateway))?.Gateway ?? null;
      if (ip) g.__gluonBridgeGw = { at: Date.now(), ip };
    })
    .catch(() => {});
}

/**
 * Where host.docker.internal leads from a container: Docker's bridge gateway (172.17.0.1 by
 * default). Caddy reaches route backends there, so a port an app publishes only on the bridge
 * ("172.17.0.1:8470:8443") works through Caddy but isn't on loopback. Probing the same address
 * Caddy uses keeps those from looking down. Falls back to loopback when there's no bridge.
 */
export function dockerHostAddress(): string {
  if (LOCAL_OVERRIDE) return LOCAL_OVERRIDE;
  const c = g.__gluonBridgeGw;
  if (c && Date.now() - c.at < 60_000) return c.ip ?? LOCAL_HOST;
  const ip = bridgeGateway();
  if (ip) g.__gluonBridgeGw = { at: Date.now(), ip };
  else if (c?.ip) return c.ip;
  else askDocker();
  return ip ?? LOCAL_HOST;
}

/** A backend on this machine (Caddy reaches it via host.docker.internal:<published port>). */
export function isLocalBackend(host: string): boolean {
  return host === "host.docker.internal" || host === "localhost" || host === "::1" || /^127\./.test(host);
}

/** The address Gluon uses to reach a backend: where Caddy would, for ones on this machine. */
export function localBackendHost(host: string): string {
  return isLocalBackend(host) ? dockerHostAddress() : host;
}

/**
 * Where Gluon reaches a port this machine listens on, from the addresses it's bound to: loopback
 * when it listens everywhere or on loopback, otherwise the one address it's bound to (a port
 * published only on the Docker bridge, say).
 */
export function listenProbeHost(addresses: Iterable<string>): string {
  const list = [...addresses].map((a) => a.replace(/^\[(.*)\]$/, "$1"));
  if (!list.length || list.some((a) => a === "0.0.0.0" || a === "::" || a === "*" || a === "::1" || /^127\./.test(a))) return LOCAL_HOST;
  return list.find((a) => net.isIPv4(a)) ?? list[0]!;
}

// ---------------------------------------------------------------- DNS

const PUBLIC_RESOLVERS = ["1.1.1.1", "1.0.0.1", "8.8.8.8"];

export function resolver(): dns.promises.Resolver {
  const r = new dns.promises.Resolver({ timeout: 2500, tries: 2 });
  r.setServers(PUBLIC_RESOLVERS);
  return r;
}

async function lookupType(r: dns.promises.Resolver, name: string, type: "A" | "AAAA"): Promise<{ list: string[]; err: string | null }> {
  try {
    const list = type === "A" ? await r.resolve4(name) : await r.resolve6(name);
    return { list, err: null };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code ?? "";
    if (code === "ENODATA" || code === "ENOTFOUND" || code === "NXDOMAIN") return { list: [], err: null };
    return { list: [], err: code || (e as Error).message };
  }
}

/**
 * Resolve A + AAAA through public resolvers (what the internet sees, not the router's cache) and
 * compare with this network's public address.
 */
export async function resolveName(name: string, publicIp: { v4: string | null; v6: string[] }): Promise<DnsResult> {
  const r = resolver();
  const [a, aaaa] = await Promise.all([lookupType(r, name, "A"), lookupType(r, name, "AAAA")]);
  const all = [...a.list, ...aaaa.list];
  const base = { name, a: a.list, aaaa: aaaa.list, resolver: PUBLIC_RESOLVERS[0]! };
  if (!all.length) {
    if (a.err && aaaa.err) return { ...base, proxied: null, matchesPublicIp: null, status: "error", message: `Couldn't look up ${name} (${a.err}).` };
    return { ...base, proxied: null, matchesPublicIp: null, status: "missing", message: `${name} has no DNS record, so nobody can reach it by name.` };
  }
  const proxied = all.every(isCloudflareIp);
  if (proxied) return { ...base, proxied: true, matchesPublicIp: null, status: "ok", message: `${name} goes through Cloudflare's proxy.` };
  const direct = all.filter((ip) => !isCloudflareIp(ip));
  let matches: boolean | null = null;
  const problems: string[] = [];
  if (publicIp.v4 && a.list.length) {
    const ok = a.list.includes(publicIp.v4);
    matches = ok;
    if (!ok) problems.push(`points at ${a.list.join(", ")} but this network's address is ${publicIp.v4}`);
  }
  if (publicIp.v6.length && aaaa.list.length) {
    const norm = (ip: string) => ip.toLowerCase();
    const ok = aaaa.list.some((ip) => publicIp.v6.map(norm).includes(norm(ip)));
    matches = (matches ?? true) && ok;
    if (!ok) problems.push(`its IPv6 record (${aaaa.list.join(", ")}) isn't one of this server's addresses`);
  }
  if (problems.length) {
    return { ...base, proxied: direct.length === all.length ? false : null, matchesPublicIp: false, status: "mismatch", message: `${name} ${problems.join(", and ")}.` };
  }
  return { ...base, proxied: false, matchesPublicIp: matches, status: "ok", message: `${name} points straight at this network${matches === null ? "" : " (DNS only)"}.` };
}

// ---------------------------------------------------------------- TLS

function nameOf(x: unknown): string | null {
  if (!x || typeof x !== "object") return null;
  const o = x as Record<string, string | string[]>;
  const pick = (k: string) => (Array.isArray(o[k]) ? (o[k] as string[])[0] : (o[k] as string | undefined));
  return pick("O") ? `${pick("O")}${pick("CN") ? ` (${pick("CN")})` : ""}` : (pick("CN") ?? null);
}

/**
 * Judge the certificate a TLS socket was handed for `servername`. `who` names the server in the
 * messages ("Caddy", "The chat server"). Null when the server sent no certificate at all.
 */
export function certResult(socket: tls.TLSSocket, servername: string, certDays: number, who: string): TlsResult | null {
  const cert = socket.getPeerCertificate();
  if (!cert || !Object.keys(cert).length) return null;
  const base: TlsResult = { servername, status: "error", issuer: null, subject: null, names: [], validFrom: null, validTo: null, daysLeft: null, trusted: null, issueError: null, message: "" };
  const names = (cert.subjectaltname ?? "")
    .split(/,\s*/)
    .filter((s) => s.startsWith("DNS:"))
    .map((s) => s.slice(4));
  const validTo = new Date(cert.valid_to);
  const validFrom = new Date(cert.valid_from);
  const daysLeft = Math.floor((validTo.getTime() - Date.now()) / 86_400_000);
  const identityErr = tls.checkServerIdentity(servername, cert);
  const trusted = socket.authorized && !identityErr;
  const issuer = nameOf(cert.issuer);
  const r: TlsResult = {
    ...base,
    issuer,
    subject: nameOf(cert.subject),
    names,
    validFrom: Number.isFinite(validFrom.getTime()) ? validFrom.toISOString() : null,
    validTo: Number.isFinite(validTo.getTime()) ? validTo.toISOString() : null,
    daysLeft: Number.isFinite(daysLeft) ? daysLeft : null,
    trusted,
    fingerprint: cert.fingerprint256,
  };
  const caddy = who === "Caddy";
  if (!Number.isFinite(daysLeft)) return { ...r, status: "error", message: `Couldn't read when the certificate for ${servername} ends.` };
  if (daysLeft < 0) {
    const whose = caddy ? "The certificate" : `The certificate ${who.toLowerCase()} uses`;
    return { ...r, status: "expired", message: `${whose} for ${servername} expired ${-daysLeft} day${daysLeft === -1 ? "" : "s"} ago.` };
  }
  if (identityErr) return { ...r, status: "invalid", message: `${who} serves a certificate for ${names.slice(0, 3).join(", ") || "another name"}, not ${servername}.` };
  if (!socket.authorized) {
    const why = String(socket.authorizationError ?? "");
    const self = /SELF_SIGNED|UNABLE_TO_GET_ISSUER|UNABLE_TO_VERIFY/.test(why);
    if (caddy) {
      return { ...r, status: self && /Caddy Local Authority/i.test(issuer ?? "") ? "pending" : "invalid", message: self ? `Caddy is using a temporary self-signed certificate for ${servername}; browsers will warn until a real one is issued.` : `The certificate for ${servername} isn't trusted (${why}).` };
    }
    return { ...r, status: "invalid", message: self ? `${who} uses a self-signed certificate for ${servername}, so chat apps will refuse to connect.` : `The certificate ${who.toLowerCase()} uses for ${servername} isn't trusted (${why}).` };
  }
  if (daysLeft < certDays) {
    const renew = caddy ? "Caddy normally renews it well before then." : "Gluon copies in Caddy's renewed one when it has it.";
    return { ...r, status: "expiring", message: `The certificate for ${servername} expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"}. ${renew}` };
  }
  return { ...r, status: "ok", message: `Valid for ${daysLeft} more days, issued by ${issuer ?? "an unknown issuer"}.` };
}

/** Handshake with Caddy for `servername` and read the certificate it serves. */
export function probeTls(servername: string, certDays: number, timeoutMs = 5000): Promise<TlsResult> {
  const base: TlsResult = { servername, status: "error", issuer: null, subject: null, names: [], validFrom: null, validTo: null, daysLeft: null, trusted: null, issueError: null, message: "" };
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: TlsResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const socket = tls.connect({ host: CADDY_HOST, port: CADDY_PORT, servername, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] });
    const timer = setTimeout(() => finish({ ...base, status: "error", message: `Caddy didn't finish the TLS handshake for ${servername} in time.` }), timeoutMs);
    socket.once("secureConnect", () => {
      finish(certResult(socket, servername, certDays, "Caddy") ?? { ...base, status: "pending", message: `Caddy has no certificate for ${servername} yet.` });
    });
    socket.once("error", (e: NodeJS.ErrnoException) => {
      const msg = e.message ?? "";
      if (e.code === "ECONNREFUSED") return finish({ ...base, status: "error", message: "Nothing is answering on port 443. Is Caddy running?" });
      // Caddy aborts the handshake with an alert when it has no certificate for the name (yet).
      if (/alert|internal error|unrecognized name|handshake failure|wrong version|EPROTO|ECONNRESET/i.test(msg + (e.code ?? ""))) {
        return finish({ ...base, status: "pending", message: `Caddy has no certificate for ${servername} yet. It requests one from Let's Encrypt when the name first resolves here.` });
      }
      finish({ ...base, status: "error", message: `TLS check failed: ${msg || e.code}` });
    });
  });
}

// ---------------------------------------------------------------- HTTP through Caddy

/** Request `path` from Caddy with the right SNI/Host, without following redirects. `plain` uses port 80 without TLS. */
export function probeHttpViaCaddy(host: string, path: string, timeoutMs = 6000, plain = false): Promise<HttpResult> {
  const url = `${plain ? "http" : "https"}://${host}${path}`;
  const t0 = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: HttpResult) => {
      if (done) return;
      done = true;
      resolve(r);
    };
    const req = (plain ? http : https).request(
      {
        host: CADDY_HOST,
        port: plain ? CADDY_HTTP_PORT : CADDY_PORT,
        ...(plain ? {} : { servername: host }),
        path,
        method: "GET",
        headers: { Host: host, "User-Agent": PROBE_UA, Accept: "text/html,*/*", Connection: "close" },
        rejectUnauthorized: false,
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        const loc = res.headers.location ?? null;
        res.resume();
        res.destroy();
        finish({ url, status: res.statusCode ?? null, location: loc, ms: Date.now() - t0, error: null });
      },
    );
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", (e: NodeJS.ErrnoException) => {
      const error = e.code === "ETIMEDOUT" ? "Caddy didn't answer in time." : e.code === "ECONNREFUSED" ? `Nothing is answering on port ${plain ? CADDY_HTTP_PORT : 443}.` : /alert|EPROTO/i.test(e.message + (e.code ?? "")) ? "TLS handshake failed (no certificate for this name yet)." : e.message;
      finish({ url, status: null, location: null, ms: null, error });
    });
    req.end();
  });
}

// ---------------------------------------------------------------- TCP

export function tcpConnect(host: string, port: number, timeoutMs = 3000): Promise<{ ok: boolean; ms: number | null; code: string | null; address: string | null }> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    let done = false;
    const socket = net.connect({ host, port });
    const finish = (r: { ok: boolean; ms: number | null; code: string | null; address: string | null }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, ms: null, code: "ETIMEDOUT", address: null }), timeoutMs);
    socket.once("connect", () => finish({ ok: true, ms: Date.now() - t0, code: null, address: socket.remoteAddress ?? null }));
    socket.once("error", (e: NodeJS.ErrnoException) => finish({ ok: false, ms: null, code: e.code ?? "ERROR", address: null }));
  });
}

export function explainConnectError(code: string | null): string {
  switch (code) {
    case "ECONNREFUSED":
      return "nothing is listening there";
    case "ETIMEDOUT":
      return "no answer (a firewall may be dropping it, or the machine is off)";
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return "that network can't be reached from here";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "the name doesn't resolve";
    case "ECONNRESET":
      return "the connection was reset";
    default:
      return code ? `it failed (${code})` : "it failed";
  }
}

export async function probeBackend(host: string, port: number): Promise<BackendResult> {
  const target = localBackendHost(host);
  const r = await tcpConnect(target, port, 3000);
  return { host, port, reachable: r.ok, ms: r.ms, error: r.ok ? null : explainConnectError(r.code) };
}

// ---------------------------------------------------------------- public IP fallback

let traceCache: { at: number; ip: string | null } | null = null;

/** Addresses no network has on the internet: private, shared (CGNAT), loopback, link-local, multicast, reserved. */
const NOT_PUBLIC_V4 = (() => {
  const b = new net.BlockList();
  for (const [a, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) b.addSubnet(a, bits, "ipv4");
  return b;
})();

/** The IPv4 address in an answer from one of the lookup services (a trace's ip= line, or the bare address), when it's a public one. */
export function publicIpv4From(body: string): string | null {
  const raw = (body.match(/^ip=(\S+)$/m)?.[1] ?? body).trim();
  if (!net.isIPv4(raw) || NOT_PUBLIC_V4.check(raw, "ipv4")) return null;
  return raw;
}

/** A small text answer over HTTPS, or null. Hard deadline, so a stalled or endless answer can't hold it up. */
function smallGet(host: string, path: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.destroy();
      resolve(v);
    };
    const req = https.get({ host, path, headers: { "User-Agent": PROBE_UA }, agent: false }, (res) => {
      if ((res.statusCode ?? 0) !== 200) return finish(null);
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        body += c;
        if (body.length > 4096) finish(null);
      });
      res.on("end", () => finish(body));
      res.on("close", () => finish(null));
      res.on("error", () => finish(null));
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
    req.on("error", () => finish(null));
  });
}

/** Asked in turn until one gives a public address: Cloudflare's trace on two addresses, then ipify. */
const IP_SOURCES: [string, string][] = [
  ["1.1.1.1", "/cdn-cgi/trace"],
  ["1.0.0.1", "/cdn-cgi/trace"],
  ["api.ipify.org", "/"],
];

/** This network's public IPv4, as services on the internet see it. Null when none of them could say. */
export async function lookupPublicIpv4(maxAgeMs = 10 * 60_000): Promise<string | null> {
  // A failed lookup is retried soon: a blip shouldn't leave DNS checks without an address for minutes.
  if (traceCache && Date.now() - traceCache.at < (traceCache.ip ? maxAgeMs : Math.min(maxAgeMs, 30_000))) return traceCache.ip;
  let ip: string | null = null;
  for (const [host, path] of IP_SOURCES) {
    const body = await smallGet(host, path, 4000);
    ip = body === null ? null : publicIpv4From(body);
    if (ip) break;
  }
  traceCache = { at: Date.now(), ip };
  return ip;
}
