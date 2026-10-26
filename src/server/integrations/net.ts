import "server-only";
import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import os from "node:os";
import zlib from "node:zlib";
import { Readable, Transform } from "node:stream";
import type { LookupFunction } from "node:net";
import { AppError } from "../errors";
import { isHomeIp } from "../net-zone";

/**
 * Outbound HTTP for integrations and personal widget sources, with guards that suit a home server:
 *
 * - only http: and https:
 * - every address a hostname resolves to is checked *at connect time* (custom `lookup`), so DNS rebinding can't
 *   swap in a forbidden address after validation; literal IPs are checked before connecting
 * - link-local (169.254/16, fe80::/10: includes cloud metadata 169.254.169.254), "this network" (0/8),
 *   multicast, broadcast/reserved and known metadata addresses are always refused
 * - loopback (the server itself, where the apps listen with host networking) is allowed for admin-configured
 *   integrations and admins' own widgets, refused for members' personal URLs
 * - LAN (RFC 1918, CGNAT/Tailscale, ULA) and the public internet are allowed
 * - redirects are followed manually (max 3) and each hop is re-validated; credentials are dropped when a
 *   redirect leaves the original origin
 * - 5 s timeout to response headers, a total deadline for the body, and a byte limit applied after decompression
 */

export type NetPolicy = "trusted" | "member";

const ALWAYS_BLOCKED: Array<[string, number, "ipv4" | "ipv6"]> = [
  ["0.0.0.0", 8, "ipv4"], // "this network"
  ["169.254.0.0", 16, "ipv4"], // link-local, cloud metadata
  ["100.100.100.200", 32, "ipv4"], // Alibaba metadata
  ["192.0.0.0", 24, "ipv4"], // IETF protocol assignments
  ["224.0.0.0", 4, "ipv4"], // multicast
  ["240.0.0.0", 4, "ipv4"], // reserved + broadcast
  ["::", 128, "ipv6"], // unspecified
  ["fe80::", 10, "ipv6"], // link-local
  ["ff00::", 8, "ipv6"], // multicast
  ["fd00:ec2::254", 128, "ipv6"], // AWS metadata over IPv6
  ["64:ff9b::a9fe:0", 112, "ipv6"], // NAT64 mapping of 169.254/16
];

const LOOPBACK: Array<[string, number, "ipv4" | "ipv6"]> = [
  ["127.0.0.0", 8, "ipv4"],
  ["::1", 128, "ipv6"],
];

function makeList(entries: Array<[string, number, "ipv4" | "ipv6"]>) {
  const l = new net.BlockList();
  for (const [a, p, t] of entries) l.addSubnet(a, p, t);
  return l;
}
const blocked = makeList(ALWAYS_BLOCKED);
const loopback = makeList(LOOPBACK);
/**
 * Inside the home network. Members' personal URLs may not reach these: with host networking every
 * app on the server answers on these addresses too, so allowing them would let a member (or anyone
 * who guesses a member's password from the internet) probe and read LAN services through Gluon.
 */
const privateNets = makeList([
  ["10.0.0.0", 8, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["fc00::", 7, "ipv6"],
  ["64:ff9b::", 96, "ipv6"],
]);
let own: { at: number; set: Set<string> } | null = null;
/** This machine's own addresses (including its public IPv6), refreshed every minute. */
function ownAddresses(): Set<string> {
  if (own && Date.now() - own.at < 60_000) return own.set;
  const set = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) for (const i of list ?? []) set.add(i.address.toLowerCase());
  own = { at: Date.now(), set };
  return set;
}

/** "::ffff:10.0.0.1" → "10.0.0.1" */
function unmap(addr: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  return m ? m[1]! : addr;
}

/** Why an address may not be contacted, or null if it's fine. */
export function addressProblem(address: string, policy: NetPolicy): string | null {
  const a = unmap(address.replace(/^\[|\]$/g, ""));
  const type = net.isIPv4(a) ? "ipv4" : net.isIPv6(a) ? "ipv6" : null;
  if (!type) return "that isn't an IP address";
  if (blocked.check(a, type)) {
    return a.startsWith("169.254.") || a.toLowerCase().startsWith("fe80:") || a === "100.100.100.200" || a.toLowerCase() === "fd00:ec2::254"
      ? `${a} is a link-local/metadata address`
      : `${a} is a reserved address`;
  }
  if (policy === "member" && (loopback.check(a, type) || ownAddresses().has(a.toLowerCase()))) return `${a} is the server itself`;
  // Also the home's own IPv6 /64 and any ranges the admin declared as home: global addresses, but still the LAN.
  if (policy === "member" && (privateNets.check(a, type) || isHomeIp(a))) return `${a} is inside the home network`;
  return null;
}

export class BlockedAddressError extends Error {
  code = "EBLOCKED";
}

function guardedLookup(policy: NetPolicy): LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, cb: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
      if (err) return cb(err, "", 0);
      const list = (addrs as dns.LookupAddress[]) ?? [];
      const ok = list.filter((a) => !addressProblem(a.address, policy));
      if (!ok.length) {
        const why = list.length ? addressProblem(list[0]!.address, policy) : "it has no addresses";
        return cb(new BlockedAddressError(`${hostname} resolves to an address Gluon won't contact (${why}).`), "", 0);
      }
      if (options.all) cb(null, ok);
      else cb(null, ok[0]!.address, ok[0]!.family);
    });
  }) as unknown as LookupFunction;
}

/** Parse and check a URL before any connection. Throws AppError with a human message. */
export function checkUrl(raw: string, policy: NetPolicy): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError("bad_url", "That doesn't look like a web address.", 400);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new AppError("bad_url", "Only http:// and https:// addresses are supported.", 400);
  }
  if (u.username || u.password) {
    throw new AppError("bad_url", "Put credentials in the settings fields, not in the address.", 400);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(unmap(host))) {
    const why = addressProblem(host, policy);
    if (why) throw new AppError("blocked_address", `Gluon won't connect to that address: ${why}.`, 400);
  } else if (policy === "member" && /^(localhost|.*\.localhost)$/i.test(host)) {
    throw new AppError("blocked_address", "Gluon won't connect to that address: it's the server itself.", 400);
  }
  return u;
}

export interface FetchOptions {
  method?: "GET" | "HEAD" | "POST";
  headers?: Record<string, string>;
  body?: string;
  policy: NetPolicy;
  /** Time allowed until response headers arrive. Default 5 s. */
  timeoutMs?: number;
  /** Time allowed for the whole exchange including body. Default timeoutMs + 5 s. */
  totalMs?: number;
  /** Byte limit after decompression. Default 2 MB. */
  maxBytes?: number;
  maxRedirects?: number;
  /** Accept self-signed certificates (admin option for LAN apps). */
  insecureTls?: boolean;
  /** Headers to drop if a redirect leaves the original origin (auth). Default: all custom headers. */
  signal?: AbortSignal;
}

export interface FetchResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  url: string;
  body: Buffer;
  ms: number;
}

export interface StreamResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  url: string;
  /** Decompressed, byte-limited body. Destroy it if you don't consume it. */
  stream: Readable;
  ms: number;
}

/** Network-level failure with a machine code for message mapping. */
export class NetError extends Error {
  constructor(
    public readonly code: "timeout" | "refused" | "notfound" | "unreachable" | "reset" | "tls" | "blocked" | "too_large" | "redirects" | "other",
    message: string,
  ) {
    super(message);
  }
}

function classify(e: unknown): NetError {
  if (e instanceof NetError) return e;
  if (e instanceof BlockedAddressError) return new NetError("blocked", e.message);
  const err = e as NodeJS.ErrnoException & { cause?: unknown };
  const code = err?.code ?? "";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || code === "ABORT_ERR") return new NetError("timeout", "timed out");
  if (code === "ECONNREFUSED") return new NetError("refused", "connection refused");
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "EAI_NODATA") return new NetError("notfound", "name not found");
  if (code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "EADDRNOTAVAIL") return new NetError("unreachable", "host unreachable");
  if (code === "ECONNRESET" || code === "EPIPE" || code === "HPE_INVALID_CONSTANT") return new NetError("reset", "connection reset");
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/i.test(code) || /certificate|ssl|tls/i.test(err?.message ?? "")) {
    return new NetError("tls", err?.message || "certificate problem");
  }
  return new NetError("other", err?.message || "request failed");
}

function limiter(maxBytes: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > maxBytes) cb(new NetError("too_large", `response larger than ${maxBytes} bytes`));
      else cb(null, chunk);
    },
  });
}

function decoder(encoding: string | undefined): Transform | null {
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "gzip":
    case "x-gzip":
      return zlib.createGunzip();
    case "deflate":
      return zlib.createInflate();
    case "br":
      return zlib.createBrotliDecompress();
    default:
      return null;
  }
}

const UA = "Gluon/1.0 (home server dashboard)";

interface OneHop {
  res: http.IncomingMessage;
  req: http.ClientRequest;
}

function requestOnce(u: URL, opts: FetchOptions, headers: Record<string, string>, deadline: AbortSignal): Promise<OneHop> {
  return new Promise((resolve, reject) => {
    const isHttps = u.protocol === "https:";
    const lib = isHttps ? https : http;
    const reqOpts: https.RequestOptions = {
      method: opts.method ?? "GET",
      protocol: u.protocol,
      hostname: u.hostname.replace(/^\[|\]$/g, ""),
      port: u.port || (isHttps ? 443 : 80),
      path: `${u.pathname}${u.search}`,
      headers,
      lookup: guardedLookup(opts.policy),
      timeout: opts.timeoutMs ?? 5000,
      signal: deadline,
      agent: false,
    };
    if (isHttps) {
      reqOpts.rejectUnauthorized = !opts.insecureTls;
      reqOpts.servername = net.isIP(reqOpts.hostname as string) ? undefined : (reqOpts.hostname as string);
    }
    const req = lib.request(reqOpts, (res) => {
      req.setTimeout(0);
      resolve({ res, req });
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/** Open a request and return the (decompressed, limited) body as a stream. Follows redirects safely. */
export async function openStream(rawUrl: string, opts: FetchOptions): Promise<StreamResult> {
  const started = Date.now();
  const totalMs = opts.totalMs ?? (opts.timeoutMs ?? 5000) + 5000;
  const deadline = AbortSignal.any([AbortSignal.timeout(totalMs), ...(opts.signal ? [opts.signal] : [])]);
  let u = checkUrl(rawUrl, opts.policy);
  const origin = u.origin;
  let headers: Record<string, string> = {
    "User-Agent": UA,
    "Accept-Encoding": "gzip, deflate, br",
    ...(opts.headers ?? {}),
  };
  const maxRedirects = opts.maxRedirects ?? 3;
  let method = opts.method ?? "GET";
  let body = opts.body;
  for (let hop = 0; ; hop++) {
    let one: OneHop;
    try {
      one = await requestOnce(u, { ...opts, method, body }, headers, deadline);
    } catch (e) {
      throw classify(deadline.aborted ? Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) : e);
    }
    const { res } = one;
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      if (hop >= maxRedirects) throw new NetError("redirects", "too many redirects");
      let next: URL;
      try {
        next = new URL(res.headers.location, u);
      } catch {
        throw new NetError("other", "bad redirect");
      }
      try {
        next = checkUrl(next.toString(), opts.policy);
      } catch (e) {
        throw new NetError("blocked", e instanceof Error ? e.message : "redirect blocked");
      }
      if (next.origin !== origin) {
        // Never carry credentials to another origin.
        headers = { "User-Agent": UA, "Accept-Encoding": "gzip, deflate, br", ...(headers.Accept ? { Accept: headers.Accept } : {}) };
      }
      if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
      u = next;
      continue;
    }
    const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
    const declared = Number(res.headers["content-length"] ?? NaN);
    const enc = res.headers["content-encoding"];
    if (!enc && Number.isFinite(declared) && declared > maxBytes) {
      res.destroy();
      throw new NetError("too_large", `response larger than ${maxBytes} bytes`);
    }
    const dec = method === "HEAD" ? null : decoder(typeof enc === "string" ? enc : undefined);
    const lim = limiter(maxBytes);
    const onAbort = () => res.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }));
    deadline.addEventListener("abort", onAbort, { once: true });
    let stream: Readable = res;
    res.on("error", (e) => lim.destroy(classify(e)));
    if (dec) {
      dec.on("error", (e) => lim.destroy(classify(e)));
      stream = res.pipe(dec);
    }
    stream.pipe(lim);
    lim.on("close", () => {
      deadline.removeEventListener("abort", onAbort);
      if (!res.complete) res.destroy();
    });
    return { status, headers: res.headers, url: u.toString(), stream: lim, ms: Date.now() - started };
  }
}

/** Fetch into memory. */
export async function safeFetch(rawUrl: string, opts: FetchOptions): Promise<FetchResult> {
  const r = await openStream(rawUrl, opts);
  const chunks: Buffer[] = [];
  try {
    for await (const c of r.stream) chunks.push(c as Buffer);
  } catch (e) {
    throw classify(e);
  }
  return { status: r.status, headers: r.headers, url: r.url, body: Buffer.concat(chunks), ms: r.ms };
}

/** Decode a text body using the declared charset (or an XML declaration), falling back to UTF-8. */
export function decodeText(body: Buffer, contentType: string | undefined): string {
  let charset = /charset=["']?([\w.:-]+)/i.exec(contentType ?? "")?.[1];
  if (!charset) {
    const head = body.subarray(0, 200).toString("latin1");
    charset = /<\?xml[^>]*encoding=["']([\w.:-]+)["']/i.exec(head)?.[1];
  }
  let text: string;
  try {
    text = new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    text = new TextDecoder("utf-8").decode(body);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Human sentence for a network failure while talking to `what` at `host`. */
export function describeNetError(e: NetError, what: string, host: string): string {
  switch (e.code) {
    case "timeout":
      return `${what} didn't answer within 5 seconds.`;
    case "refused":
      return `${what} isn't answering at ${host} (connection refused). Is it running, and is the port right?`;
    case "notfound":
      return `Couldn't find ${host}. Check the address.`;
    case "unreachable":
      return `${host} can't be reached from the server.`;
    case "reset":
      return `${what} closed the connection. If the address starts with http://, try https:// (or the other way round).`;
    case "tls":
      return `The certificate at ${host} isn't trusted. If this is your own server with a self-signed certificate, turn on “Allow self-signed certificate”.`;
    case "blocked":
      return `Gluon won't connect there: ${e.message.replace(/\.$/, "")}.`;
    case "too_large":
      return `${what} sent more data than Gluon accepts for this.`;
    case "redirects":
      return `${what} redirected too many times.`;
    default:
      return `Couldn't reach ${what}: ${e.message}.`;
  }
}

/** Convert a Node stream to a web ReadableStream for Response bodies. */
export function toWebStream(s: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(s) as unknown as ReadableStream<Uint8Array>;
}
