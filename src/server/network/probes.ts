import "server-only";
import dns from "node:dns";
import net from "node:net";
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

/** Where this machine's own ports are reached from Gluon (host networking → loopback). */
export const LOCAL_HOST = (process.env.GLUON_LOCAL_HOST ?? process.env.TEND_LOCAL_HOST) ?? "127.0.0.1";

/** A backend on this machine (Caddy reaches it via host.docker.internal:<published port>). */
export function isLocalBackend(host: string): boolean {
  return host === "host.docker.internal" || host === "localhost" || host === "::1" || /^127\./.test(host);
}

/** The address Gluon uses to reach a backend. */
export function localBackendHost(host: string): string {
  return isLocalBackend(host) ? LOCAL_HOST : host;
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

/** This network's public IPv4 from Cloudflare's trace endpoint (used when the DDNS log has none). */
export async function lookupPublicIpv4(): Promise<string | null> {
  if (traceCache && Date.now() - traceCache.at < 10 * 60_000) return traceCache.ip;
  const ip = await new Promise<string | null>((resolve) => {
    const req = https.get({ host: "1.1.1.1", path: "/cdn-cgi/trace", timeout: 4000, headers: { "User-Agent": PROBE_UA } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        body += c;
        if (body.length > 4096) res.destroy();
      });
      res.on("end", () => resolve(body.match(/^ip=([0-9.]+)$/m)?.[1] ?? null));
      res.on("error", () => resolve(null));
    });
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
  });
  traceCache = { at: Date.now(), ip };
  return ip;
}
