import "server-only";
import dns from "node:dns";
import net from "node:net";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { local, host, CommandError } from "../host/exec";
import { hostExists } from "../host/paths";
import { AppError } from "../errors";
import { explainConnectError } from "../network/probes";
import { resolverAddress } from "./validate";
import type { DnsToolResult, HttpHop, HttpToolResult, PingToolResult, PortToolResult, TracerouteToolResult } from "@/lib/diagnostics-types";

/** Network tools run from the server. Inputs arrive validated (./validate); every call has a timeout. */

// ---------------------------------------------------------------- DNS lookup (dig)

export const DNS_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SOA", "PTR", "SRV", "CAA"] as const;

export async function dnsLookup(name: string, type: (typeof DNS_TYPES)[number], resolverChoice: string): Promise<DnsToolResult> {
  const server = resolverAddress(resolverChoice);
  const args = ["+time=3", "+tries=1", "+noall", "+answer", "+comments", "+stats"];
  if (server) args.push(`@${server}`);
  if (type === "PTR" && net.isIP(name)) args.push("-x", name);
  else args.push(name, type);
  let stdout = "";
  try {
    ({ stdout } = await local("dig", args, { timeoutMs: 10_000, okCodes: [9] }));
  } catch (e) {
    if (e instanceof CommandError && e.code === 127) throw new AppError("no_dig", "dig isn't installed in Gluon's container.", 501);
    const msg = e instanceof CommandError ? e.stdout || e.message : (e as Error).message;
    return { name, type, resolver: server ?? "system", status: "ERROR", answers: [], queryMs: null, server: null, message: `The lookup failed: ${msg.trim().split("\n").at(-1)}` };
  }
  const status = stdout.match(/status:\s*([A-Z]+)/)?.[1] ?? (/timed out|no servers could be reached/i.test(stdout) ? "TIMEOUT" : "UNKNOWN");
  const answers: DnsToolResult["answers"] = [];
  let inAnswer = false;
  for (const line of stdout.split("\n")) {
    if (/^;; ANSWER SECTION/.test(line)) {
      inAnswer = true;
      continue;
    }
    if (line.startsWith(";") || !line.trim()) {
      if (inAnswer && !line.trim()) inAnswer = false;
      continue;
    }
    if (!inAnswer) continue;
    const m = line.match(/^(\S+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    if (m) answers.push({ name: m[1]!.replace(/\.$/, ""), ttl: Number(m[2]), type: m[4]!, data: m[5]!.trim() });
  }
  const queryMs = Number(stdout.match(/Query time:\s*(\d+)\s*msec/)?.[1] ?? NaN);
  const srv = stdout.match(/SERVER:\s*([^\s#(]+)/)?.[1] ?? null;
  let message: string;
  if (status === "NOERROR") message = answers.length ? `${answers.length} record${answers.length === 1 ? "" : "s"}.` : `${name} exists but has no ${type} records.`;
  else if (status === "NXDOMAIN") message = `${name} doesn't exist.`;
  else if (status === "SERVFAIL") message = "The resolver couldn't answer (SERVFAIL). The domain's DNS may be misconfigured.";
  else if (status === "REFUSED") message = "That resolver refused to answer.";
  else if (status === "TIMEOUT") message = "The resolver didn't answer in time.";
  else message = `The resolver answered ${status}.`;
  return { name, type, resolver: server ?? "system", status, answers, queryMs: Number.isFinite(queryMs) ? queryMs : null, server: srv, message };
}

// ---------------------------------------------------------------- ping

export async function ping(target: string, count: number, family?: 4 | 6): Promise<PingToolResult> {
  const args = ["-n", "-c", String(count), "-W", "2", "-i", "0.5", "-w", String(count + 3)];
  if (family) args.unshift(`-${family}`);
  args.push(target);
  let stdout = "";
  try {
    ({ stdout } = await local("ping", args, { timeoutMs: (count + 6) * 1000, okCodes: [1] }));
  } catch (e) {
    if (e instanceof CommandError) {
      if (e.code === 127) throw new AppError("no_ping", "ping isn't installed in Gluon's container.", 501);
      const err = (e.stderr || e.message).trim();
      const message = /Name or service not known|Temporary failure in name resolution|unknown host/i.test(err)
        ? `${target} doesn't resolve to an address.`
        : /Network is unreachable/i.test(err)
          ? "That network can't be reached from the server."
          : `ping failed: ${err.split("\n").at(-1)}`;
      return { host: target, address: null, transmitted: 0, received: 0, lossPct: 100, rtt: null, replies: [], message };
    }
    throw e;
  }
  const address = stdout.match(/^PING \S+ \(([^)]+)\)/m)?.[1] ?? null;
  const replies: PingToolResult["replies"] = [];
  for (const m of stdout.matchAll(/icmp_seq=(\d+)(?: ttl=(\d+))? time=([\d.]+) ms/g)) replies.push({ seq: Number(m[1]), ttl: m[2] ? Number(m[2]) : null, ms: Number(m[3]) });
  const tx = Number(stdout.match(/(\d+) packets transmitted/)?.[1] ?? 0);
  const rx = Number(stdout.match(/(\d+) (?:packets )?received/)?.[1] ?? 0);
  const loss = Number(stdout.match(/([\d.]+)% packet loss/)?.[1] ?? (tx ? ((tx - rx) / tx) * 100 : 100));
  const r = stdout.match(/= ([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+) ms/);
  const rtt = r ? { min: Number(r[1]), avg: Number(r[2]), max: Number(r[3]), mdev: Number(r[4]) } : null;
  const message = rx === 0 ? `No replies from ${target}. It may be down, or it ignores ping.` : loss > 0 ? `${rx} of ${tx} replies, ${loss}% lost, average ${rtt?.avg ?? "?"} ms.` : `All ${rx} replies came back, average ${rtt?.avg ?? "?"} ms.`;
  return { host: target, address, transmitted: tx, received: rx, lossPct: loss, rtt, replies, message };
}

// ---------------------------------------------------------------- TCP port check

export async function portCheck(target: string, port: number, timeoutMs = 4000): Promise<PortToolResult> {
  let address: string | null = null;
  try {
    address = net.isIP(target) ? target : (await dns.promises.lookup(target)).address;
  } catch {
    return { host: target, port, address: null, open: false, ms: null, error: "ENOTFOUND", message: `${target} doesn't resolve to an address.` };
  }
  const t0 = Date.now();
  const r = await new Promise<{ ok: boolean; code: string | null }>((resolve) => {
    const s = net.connect({ host: address!, port });
    const timer = setTimeout(() => {
      s.destroy();
      resolve({ ok: false, code: "ETIMEDOUT" });
    }, timeoutMs);
    s.once("connect", () => {
      clearTimeout(timer);
      s.destroy();
      resolve({ ok: true, code: null });
    });
    s.once("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      resolve({ ok: false, code: e.code ?? "ERROR" });
    });
  });
  const ms = r.ok ? Date.now() - t0 : null;
  return {
    host: target,
    port,
    address,
    open: r.ok,
    ms,
    error: r.code,
    message: r.ok ? `Port ${port} on ${target} accepts connections (${ms} ms).` : `Port ${port} on ${target} is closed: ${explainConnectError(r.code)}.`,
  };
}

// ---------------------------------------------------------------- HTTP request

const BODY_LIMIT = 4096;

interface HopResult {
  hop: HttpHop;
  body: HttpToolResult["body"];
  tls: HttpToolResult["tls"];
}

function oneRequest(url: URL, method: "GET" | "HEAD", insecure: boolean, timeoutMs: number): Promise<HopResult> {
  const t0 = performance.now();
  const timing = { dns: null as number | null, connect: null as number | null, tls: null as number | null, ttfb: null as number | null, total: null as number | null };
  const ms = () => Math.round((performance.now() - t0) * 10) / 10;
  const isHttps = url.protocol === "https:";
  return new Promise((resolve) => {
    let settled = false;
    let tlsInfo: HttpToolResult["tls"] = null;
    const hop: HttpHop = { url: url.toString(), status: null, statusText: null, httpVersion: null, remoteAddress: null, headers: {}, timing, location: null, error: null };
    const done = (body: HttpToolResult["body"], error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      timing.total = ms();
      if (error) hop.error = error;
      resolve({ hop, body, tls: tlsInfo });
    };
    const mod = isHttps ? https : http;
    const req = mod.request(url, {
      method,
      agent: false,
      headers: { "User-Agent": "Gluon-diagnostics/1", Accept: "*/*", Connection: "close" },
      rejectUnauthorized: !insecure,
      servername: net.isIP(url.hostname) ? undefined : url.hostname,
      lookup: (hostname: string, opts: dns.LookupOptions, cb: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void) => {
        dns.lookup(hostname, opts, (err, address, family) => {
          timing.dns = ms();
          cb(err, address as string, family);
        });
      },
    } as https.RequestOptions);
    const timer = setTimeout(() => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })), timeoutMs);
    req.on("socket", (socket: net.Socket) => {
      socket.once("connect", () => {
        timing.connect = ms();
        hop.remoteAddress = socket.remoteAddress ?? null;
      });
      socket.once("secureConnect", () => {
        timing.tls = ms();
        const s = socket as tls.TLSSocket;
        const cert = s.getPeerCertificate();
        const validTo = cert?.valid_to ? new Date(cert.valid_to) : null;
        tlsInfo = {
          protocol: s.getProtocol() ?? null,
          cipher: s.getCipher()?.name ?? null,
          subject: (cert?.subject?.CN as string | undefined) ?? null,
          issuer: ((cert?.issuer?.O ?? cert?.issuer?.CN) as string | undefined) ?? null,
          validTo: validTo && Number.isFinite(validTo.getTime()) ? validTo.toISOString() : null,
          daysLeft: validTo && Number.isFinite(validTo.getTime()) ? Math.floor((validTo.getTime() - Date.now()) / 86_400_000) : null,
          trusted: s.authorized,
          error: s.authorizationError ? String(s.authorizationError) : null,
        };
      });
    });
    req.on("response", (res) => {
      timing.ttfb = ms();
      hop.status = res.statusCode ?? null;
      hop.statusText = res.statusMessage ?? null;
      hop.httpVersion = res.httpVersion;
      hop.headers = res.headers as Record<string, string | string[]>;
      hop.location = typeof res.headers.location === "string" ? res.headers.location : null;
      const chunks: Buffer[] = [];
      let size = 0;
      let truncated = false;
      res.on("data", (c: Buffer) => {
        if (size >= BODY_LIMIT) {
          truncated = true;
          res.destroy();
          return;
        }
        chunks.push(c);
        size += c.length;
        if (size >= BODY_LIMIT) {
          truncated = true;
          res.destroy();
        }
      });
      const finish = () => {
        const buf = Buffer.concat(chunks).subarray(0, BODY_LIMIT);
        const type = typeof res.headers["content-type"] === "string" ? res.headers["content-type"] : null;
        const binary = buf.includes(0) || (!!type && !/(text|json|xml|javascript|html|x-www-form|yaml|csv)/i.test(type) && buf.length > 0);
        done(method === "HEAD" ? null : { text: binary ? "" : buf.toString("utf8"), truncated, contentType: type, binary });
      };
      res.on("end", finish);
      res.on("close", finish);
      res.on("error", finish);
    });
    req.on("error", (e: NodeJS.ErrnoException) => {
      const code = e.code ?? "";
      const msg =
        code === "ETIMEDOUT"
          ? "No answer in time."
          : code === "ENOTFOUND" || code === "EAI_AGAIN"
            ? `${url.hostname} doesn't resolve.`
            : code === "ECONNREFUSED"
              ? "Connection refused: nothing is listening there."
              : /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(code)
                ? `The certificate isn't trusted (${code}). Turn on "ignore certificate errors" to see the response anyway.`
                : e.message || code;
      done(null, msg);
    });
    req.end();
  });
}

export async function httpRequest(rawUrl: string, method: "GET" | "HEAD", followRedirects: boolean, insecure: boolean): Promise<HttpToolResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AppError("invalid", "Enter a full address starting with http:// or https://.", 400, { field: "url" });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new AppError("invalid", "Only http:// and https:// addresses are supported.", 400, { field: "url" });
  if (url.username || url.password) throw new AppError("invalid", "Leave credentials out of the address.", 400, { field: "url" });
  const deadline = Date.now() + 20_000;
  const hops: HttpHop[] = [];
  let last: HopResult | null = null;
  let firstTls: HttpToolResult["tls"] = null;
  for (let i = 0; i < (followRedirects ? 6 : 1); i++) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    last = await oneRequest(url, method, insecure, Math.min(10_000, left));
    hops.push(last.hop);
    firstTls ??= last.tls;
    const st = last.hop.status ?? 0;
    if (!followRedirects || st < 300 || st >= 400 || !last.hop.location) break;
    let next: URL;
    try {
      next = new URL(last.hop.location, url);
    } catch {
      break;
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") break;
    url = next;
  }
  const final = hops.at(-1) ?? null;
  let message: string;
  if (!final) message = "The request didn't run.";
  else if (final.error) message = final.error;
  else {
    const redirects = hops.length - 1;
    message = `HTTP ${final.status}${final.statusText ? ` ${final.statusText}` : ""} in ${final.timing.total} ms${redirects ? ` after ${redirects} redirect${redirects === 1 ? "" : "s"}` : ""}.`;
    if (!followRedirects && final.status && final.status >= 300 && final.status < 400) message += ` It redirects to ${final.location}.`;
  }
  return { hops, final, body: last?.body ?? null, tls: last?.tls ?? firstTls, message };
}

// ---------------------------------------------------------------- traceroute

async function traceTool(): Promise<{ tool: "traceroute" | "tracepath"; path: string } | null> {
  for (const p of ["/usr/bin/traceroute", "/usr/sbin/traceroute", "/bin/traceroute"]) if (hostExists(p)) return { tool: "traceroute", path: p };
  for (const p of ["/usr/bin/tracepath", "/usr/sbin/tracepath", "/bin/tracepath"]) if (hostExists(p)) return { tool: "tracepath", path: p };
  return null;
}

export async function traceroute(target: string, maxHops = 20): Promise<TracerouteToolResult> {
  const t = await traceTool();
  if (!t) {
    return { available: false, tool: null, host: target, hops: [], reached: false, message: "Neither traceroute nor tracepath is installed on the server (apt install traceroute)." };
  }
  const args = t.tool === "traceroute" ? ["-n", "-w", "1", "-q", "2", "-m", String(maxHops), target] : ["-n", "-m", String(maxHops), target];
  let stdout = "";
  try {
    ({ stdout } = await host(t.path, args, { timeoutMs: 60_000, okCodes: [1] }));
  } catch (e) {
    if (e instanceof CommandError) {
      const err = (e.stderr || e.message).trim();
      if (/Name or service not known|unknown host|Cannot handle "host"/i.test(err)) return { available: true, tool: t.tool, host: target, hops: [], reached: false, message: `${target} doesn't resolve to an address.` };
      if (/Timed out/i.test(e.message) && e.stdout) stdout = e.stdout;
      else return { available: true, tool: t.tool, host: target, hops: [], reached: false, message: `The trace failed: ${err.split("\n").at(-1)}` };
    } else throw e;
  }
  const hops: TracerouteToolResult["hops"] = [];
  const dest = stdout.match(/^trace(?:route|path) to \S+ \(([^)]+)\)/m)?.[1] ?? (net.isIP(target) ? target : null);
  for (const line of stdout.split("\n")) {
    if (t.tool === "traceroute") {
      const m = line.match(/^\s*(\d+)\s+(.*)$/);
      if (!m) continue;
      const rest = m[2]!;
      const addr = rest.match(/(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]*:[0-9a-f:]+)/i)?.[1] ?? null;
      const ms = [...rest.matchAll(/([\d.]+) ms/g)].map((x) => Number(x[1]));
      hops.push({ hop: Number(m[1]), address: addr, host: null, ms });
    } else {
      const m = line.match(/^\s*(\d+)\??:\s+(\S+)\s+(?:([\d.]+)ms)?/);
      if (!m || m[2] === "[LOCALHOST]") continue;
      const n = Number(m[1]);
      const addr = m[2] === "no" ? null : m[2]!;
      const existing = hops.find((h) => h.hop === n);
      if (existing) {
        if (m[3]) existing.ms.push(Number(m[3]));
        continue;
      }
      hops.push({ hop: n, address: addr, host: null, ms: m[3] ? [Number(m[3])] : [] });
    }
  }
  const reached = !!dest && hops.some((h) => h.address === dest);
  // Names for the hops, best effort and quick.
  await Promise.all(
    hops.map(async (h) => {
      if (!h.address) return;
      h.host = await Promise.race([dns.promises.reverse(h.address).then((n) => n[0] ?? null, () => null), new Promise<null>((r) => setTimeout(() => r(null), 1500))]);
    }),
  );
  const message = reached ? `Reached ${target} in ${hops.at(-1)?.hop ?? "?"} hops.` : hops.length ? `Didn't reach ${target} within ${maxHops} hops; the last hops didn't answer.` : "No hops answered.";
  return { available: true, tool: t.tool, host: target, hops, reached, message };
}
